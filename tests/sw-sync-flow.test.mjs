import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory Chrome mock state
let storageLocal = {};
let storageSession = {};
let runtimeMessages = [];
let tabMessages = [];
let tabUpdatedListeners = [];
let onMessageListener = null;

globalThis.chrome = {
  runtime: {
    sendMessage: (msg, cb) => {
      runtimeMessages.push(msg);
      if (typeof cb === 'function') cb({ ok: true });
      return Promise.resolve({ ok: true });
    },
    onMessage: {
      addListener: (fn) => { onMessageListener = fn; }
    },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    lastError: null
  },
  tabs: {
    sendMessage: async (tabId, msg, options) => {
      tabMessages.push({ tabId, msg, options });
      if (msg?.type === 'REQUEST_STATE_SNAPSHOT') {
        return {
          ok: true,
          videoHint: 'snap-hint-99',
          state: { paused: false, time: 42.5, rate: 1, seq: 10, timestamp: Date.now() }
        };
      }
      return { ok: true };
    },
    onUpdated: {
      addListener: (fn) => { tabUpdatedListeners.push(fn); }
    },
    onRemoved: { addListener: () => {} },
    onActivated: { addListener: () => {} },
    update: async (tabId, updateProps) => ({ id: tabId, ...updateProps }),
    create: async (createProps) => ({ id: 999, ...createProps })
  },
  windows: {
    update: async () => ({})
  },
  storage: {
    local: {
      get: async (keys) => {
        if (!keys) return { ...storageLocal };
        if (typeof keys === 'string') keys = [keys];
        const res = {};
        for (const k of keys) {
          if (k in storageLocal) res[k] = storageLocal[k];
        }
        return res;
      },
      set: async (obj) => {
        Object.assign(storageLocal, obj);
      }
    },
    session: {
      get: async (keys) => {
        if (!keys) return { ...storageSession };
        if (typeof keys === 'string') keys = [keys];
        const res = {};
        for (const k of keys) {
          if (k in storageSession) res[k] = storageSession[k];
        }
        return res;
      },
      set: async (obj) => {
        Object.assign(storageSession, obj);
      }
    },
    onChanged: {
      addListener: () => {}
    }
  },
  offscreen: {
    hasDocument: async () => true,
    createDocument: async () => {}
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  },
  alarms: {
    onAlarm: { addListener: () => {} },
    create: () => {}
  },
  scripting: {
    executeScript: async () => []
  }
};

const {
  handleSwMessage,
  handlePeerPayload,
  getSessionState,
  setSessionState
} = await import('../extension/background/service-worker.js');

describe('Service Worker Sync Flow & Picker Coordination', () => {
  beforeEach(() => {
    storageLocal = { peerId: 'peer_local_host_1', pairKey: 'testpair' };
    storageSession = {};
    runtimeMessages = [];
    tabMessages = [];
  });

  test('(a) no synthetic Date.now() seq on URL-change SHARE_FEED; uses seq: 1', async () => {
    // Setup active session on Host
    const initialSession = {
      tabId: 101,
      frameId: 0,
      isHost: true,
      url: 'https://youtube.com/watch?v=aaa',
      pageUrl: 'https://www.youtube.com/watch?v=aaa',
      videoHint: 'video-elem-test'
    };
    await setSessionState({ activeSession: initialSession });

    const newUrl = 'https://www.youtube.com/watch?v=bbb';
    // Trigger tabs.onUpdated
    const onUpdatedFn = tabUpdatedListeners[0];
    assert.ok(typeof onUpdatedFn === 'function', 'tabs.onUpdated listener must be registered');

    await onUpdatedFn(101, { url: newUrl }, { id: 101, url: newUrl });

    // Check SHARE_FEED dispatched to offscreen
    const shareFeedMsg = runtimeMessages.find(m =>
      m.target === 'offscreen' && m.type === 'RTC_SEND' && m.payload?.type === 'SHARE_FEED'
    );
    assert.ok(shareFeedMsg, 'SHARE_FEED message must be sent to offscreen');
    const feedPayload = shareFeedMsg.payload;

    // Lamport clock: seq must be exactly 1 on URL navigation session restart, never Date.now()
    assert.equal(feedPayload.state.seq, 1, 'URL navigation SHARE_FEED must send seq: 1');
    assert.equal(feedPayload.videoHint, 'video-elem-test');
    assert.equal(feedPayload.pageUrl, newUrl);

    // REBIND_TAB_VIDEO must include canonUrl and videoHint
    const rebindMsg = tabMessages.find(m =>
      m.tabId === 101 && m.msg?.type === 'REBIND_TAB_VIDEO'
    );
    assert.ok(rebindMsg, 'REBIND_TAB_VIDEO must be sent to tab');
    assert.equal(rebindMsg.msg.url, 'https://www.youtube.com/watch?v=bbb');
    assert.equal(rebindMsg.msg.videoHint, 'video-elem-test');
  });

  test('(b) duplicate VIDEO_READY from same frameId does not wipe ATTACH_SYNC', async () => {
    // Active session already attached to frame 2
    const activeSession = {
      tabId: 101,
      frameId: 2,
      isHost: false,
      url: 'https://youtube.com/watch?v=aaa',
      pageUrl: 'https://www.youtube.com/watch?v=aaa',
      videoHint: 'video-hint-2',
      initialState: { paused: true, time: 10 }
    };
    await setSessionState({ activeSession });

    tabMessages = [];
    let response = null;
    await handleSwMessage(
      { type: 'VIDEO_READY', area: 50000 },
      { tab: { id: 101 }, frameId: 2 },
      (res) => { response = res; }
    );

    // Should indicate alreadyAttached and avoid re-attaching
    assert.deepEqual(response, { ok: true, alreadyAttached: true });

    // No ATTACH_SYNC message sent
    const attachMsg = tabMessages.find(m => m.msg?.type === 'ATTACH_SYNC');
    assert.equal(attachMsg, undefined, 'ATTACH_SYNC must not be sent on duplicate VIDEO_READY for same frameId');

    // State in activeSession must not be wiped
    const cur = await getSessionState();
    assert.equal(cur.activeSession.frameId, 2);
    assert.deepEqual(cur.activeSession.initialState, { paused: true, time: 10 });
  });

  test('(c) REQUEST_LIVE_STATE -> LIVE_STATE_SNAPSHOT -> APPLY_INITIAL_STATE convergence', async () => {
    // 1. Host side: receives REQUEST_LIVE_STATE
    const hostSession = {
      tabId: 101,
      frameId: 3,
      isHost: true,
      url: 'https://youtube.com/watch?v=aaa',
      pageUrl: 'https://www.youtube.com/watch?v=aaa',
      videoHint: 'host-video-hint'
    };
    await setSessionState({ activeSession: hostSession });
    runtimeMessages = [];
    tabMessages = [];

    await handlePeerPayload({
      type: 'REQUEST_LIVE_STATE',
      canonUrl: 'https://youtube.com/watch?v=aaa',
      pageUrl: 'https://www.youtube.com/watch?v=aaa'
    });

    // Host should query active tab/frame for state snapshot
    const snapReq = tabMessages.find(m => m.tabId === 101 && m.msg?.type === 'REQUEST_STATE_SNAPSHOT');
    assert.ok(snapReq, 'Host must request state snapshot from active tab');
    assert.equal(snapReq.options?.frameId, 3, 'Query must be directed to active frameId');

    // Host should broadcast LIVE_STATE_SNAPSHOT via RTC_SEND
    const liveSnapMsg = runtimeMessages.find(m =>
      m.target === 'offscreen' && m.type === 'RTC_SEND' && m.payload?.type === 'LIVE_STATE_SNAPSHOT'
    );
    assert.ok(liveSnapMsg, 'Host must send LIVE_STATE_SNAPSHOT to offscreen');
    assert.equal(liveSnapMsg.payload.canonUrl, 'https://youtube.com/watch?v=aaa');
    assert.equal(liveSnapMsg.payload.videoHint, 'snap-hint-99');
    assert.equal(liveSnapMsg.payload.state.time, 42.5);
    assert.ok(liveSnapMsg.payload.sentAt > 0);

    // 2. Follower side: receives LIVE_STATE_SNAPSHOT
    const followerSession = {
      tabId: 202,
      frameId: 1,
      isHost: false,
      url: 'https://youtube.com/watch?v=aaa',
      pageUrl: 'https://www.youtube.com/watch?v=aaa',
      videoHint: null
    };
    await setSessionState({ activeSession: followerSession, rttMs: 80, clockOffsetMs: -15 });
    tabMessages = [];

    await handlePeerPayload({
      type: 'LIVE_STATE_SNAPSHOT',
      canonUrl: 'https://youtube.com/watch?v=aaa',
      pageUrl: 'https://www.youtube.com/watch?v=aaa',
      videoHint: 'follower-applied-hint',
      state: { paused: false, time: 42.5, rate: 1, seq: 10 },
      sentAt: 1700000000000
    });

    // Follower forwards APPLY_INITIAL_STATE to tab 202 frame 1
    const applyMsg = tabMessages.find(m => m.tabId === 202 && m.msg?.type === 'APPLY_INITIAL_STATE');
    assert.ok(applyMsg, 'Follower must deliver APPLY_INITIAL_STATE to content script');
    assert.equal(applyMsg.options?.frameId, 1);
    assert.equal(applyMsg.msg.state.time, 42.5);
    assert.equal(applyMsg.msg.state.sentAt, 1700000000000);
    assert.equal(applyMsg.msg.videoHint, 'follower-applied-hint');
    assert.equal(applyMsg.msg.rttMs, 80);
    assert.equal(applyMsg.msg.clockOffsetMs, -15);

    // Follower session state should update videoHint
    const updatedFollower = await getSessionState();
    assert.equal(updatedFollower.activeSession.videoHint, 'follower-applied-hint');
  });

  test('(d) LOCAL_SYNC_MSG tab/frame sender filter', async () => {
    const activeSession = {
      tabId: 101,
      frameId: 2,
      isHost: true,
      url: 'https://youtube.com/watch?v=aaa',
      pageUrl: 'https://www.youtube.com/watch?v=aaa'
    };
    await setSessionState({ activeSession });

    // 1. Mismatched tabId
    runtimeMessages = [];
    let respWrongTab = null;
    await handleSwMessage(
      { type: 'LOCAL_SYNC_MSG', payload: { action: 'PAUSE', time: 12 } },
      { tab: { id: 999 }, frameId: 2 },
      (res) => { respWrongTab = res; }
    );
    assert.deepEqual(respWrongTab, { ok: false, ignored: true });
    assert.equal(runtimeMessages.length, 0, 'No RTC_SEND message when tabId does not match');

    // 2. Mismatched frameId on correct tabId
    let respWrongFrame = null;
    await handleSwMessage(
      { type: 'LOCAL_SYNC_MSG', payload: { action: 'PAUSE', time: 12 } },
      { tab: { id: 101 }, frameId: 5 },
      (res) => { respWrongFrame = res; }
    );
    assert.deepEqual(respWrongFrame, { ok: false, ignored: true });
    assert.equal(runtimeMessages.length, 0, 'No RTC_SEND message when frameId does not match');

    // 3. Matching tabId and frameId
    let respMatch = null;
    await handleSwMessage(
      { type: 'LOCAL_SYNC_MSG', payload: { action: 'PAUSE', time: 12 } },
      { tab: { id: 101 }, frameId: 2 },
      (res) => { respMatch = res; }
    );
    assert.deepEqual(respMatch, { ok: true });
    const sendMsg = runtimeMessages.find(m =>
      m.target === 'offscreen' && m.type === 'RTC_SEND' && m.payload?.action === 'PAUSE'
    );
    assert.ok(sendMsg, 'Matching sender must forward LOCAL_SYNC_MSG payload to offscreen');
    assert.equal(sendMsg.payload.canonUrl, 'https://youtube.com/watch?v=aaa');
  });
});
