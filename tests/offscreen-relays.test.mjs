import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Set up Chrome runtime mocks before importing offscreen.js
const sentMessages = [];
let messageListener = null;

globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      sentMessages.push(msg);
      return { ok: true };
    },
    onMessage: {
      addListener: (fn) => {
        messageListener = fn;
      }
    }
  }
};

const {
  RELAY_URLS,
  handleJoinRoom,
  leaveCurrentRoom,
  _setJoinRoomForTesting
} = await import('../extension/offscreen/offscreen.js');

const { selfId } = await import('../extension/vendor/trystero-nostr.min.js');

describe('Offscreen Nostr Relays & Room Lifecycle', () => {
  let joinRoomCalls = [];
  let mockRoom = null;
  let pingsSent = [];
  let syncPingsSent = [];

  function setupMockRoom(initialPeers = {}) {
    pingsSent = [];
    syncPingsSent = [];
    let peers = { ...initialPeers };
    let left = false;
    let peerJoinCb = null;
    let peerLeaveCb = null;

    mockRoom = {
      makeAction: (name) => {
        if (name === 'ping') {
          return [(data) => { pingsSent.push(data); }, () => {}];
        }
        if (name === 'sync') {
          return [(data) => {
            if (data?.__lockstep_ping) syncPingsSent.push(data);
          }, () => {}];
        }
        if (name === 'pong') {
          return [() => {}, () => {}];
        }
        return [() => {}, () => {}];
      },
      onPeerJoin: (cb) => { peerJoinCb = cb; },
      onPeerLeave: (cb) => { peerLeaveCb = cb; },
      getPeers: () => peers,
      setPeers: (newPeers) => { peers = newPeers; },
      triggerPeerJoin: () => peerJoinCb?.(),
      triggerPeerLeave: () => peerLeaveCb?.(),
      leave: () => { left = true; },
      isLeft: () => left
    };
    return mockRoom;
  }

  beforeEach(() => {
    leaveCurrentRoom();
    joinRoomCalls = [];
    setupMockRoom();
    _setJoinRoomForTesting((config, roomId) => {
      joinRoomCalls.push({ config, roomId });
      return mockRoom;
    });
  });

  afterEach(() => {
    leaveCurrentRoom();
  });

  describe('1. RELAY_URLS configuration', () => {
    test('contains exactly the 6 empirically verified live relays', () => {
      const expected = [
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://nostr.mom',
        'wss://relay.snort.social',
        'wss://nostr.oxtr.dev',
        'wss://nostr.data.haus'
      ];
      assert.equal(Array.isArray(RELAY_URLS), true);
      assert.equal(RELAY_URLS.length, 6);
      assert.deepEqual([...RELAY_URLS].sort(), [...expected].sort());
      for (const url of RELAY_URLS) {
        assert.ok(url.startsWith('wss://'), `Expected wss:// protocol: ${url}`);
      }
    });

    test('excludes dead and non-loopback trystero default relays', () => {
      const deadDefaults = [
        'relay.fountain.fm',
        'relay.nostrdice.com',
        'ftp.halifax.rwth-aachen.de',
        'relay.binaryrobot.com',
        'black.nostrcity.club'
      ];
      for (const dead of deadDefaults) {
        const found = RELAY_URLS.some(url => url.includes(dead));
        assert.equal(found, false, `Dead relay should not be in RELAY_URLS: ${dead}`);
      }
    });
  });

  describe('2. OFFSCREEN_READY boot ping', () => {
    test('sends OFFSCREEN_READY ping to service worker on module load', () => {
      const bootMessage = sentMessages.find(m => m.type === 'OFFSCREEN_READY');
      assert.ok(bootMessage, 'OFFSCREEN_READY message was not sent');
      assert.equal(bootMessage.target, 'sw');
      assert.equal(bootMessage.from, 'offscreen');
      assert.equal(bootMessage.selfId, selfId);
      assert.equal(typeof bootMessage.selfId, 'string');
      assert.ok(bootMessage.selfId.length > 0);
    });
  });

  describe('3. pairKey and roomId normalization', () => {
    test('normalizes pairKey by trimming whitespace and lowercasing', () => {
      const res = handleJoinRoom('  LK-AbCd  ');
      assert.equal(res.ok, true);
      assert.equal(joinRoomCalls.length, 1);
      assert.deepEqual(joinRoomCalls[0].config, {
        appId: 'lockstep-v1',
        password: 'lk-abcd',
        relayUrls: RELAY_URLS
      });
      assert.equal(joinRoomCalls[0].roomId, 'lk-abcd');
    });

    test('normalizes custom roomId and falls back to normalizedKey if omitted', () => {
      const res = handleJoinRoom('  UPPER-KEY  ', '  CUSTOM-ROOM-123  ');
      assert.equal(res.ok, true);
      assert.equal(joinRoomCalls[0].config.password, 'upper-key');
      assert.equal(joinRoomCalls[0].roomId, 'custom-room-123');
    });

    test('rejects empty or whitespace-only pairKey', () => {
      const res1 = handleJoinRoom('');
      assert.equal(res1.ok, false);
      const res2 = handleJoinRoom('   ');
      assert.equal(res2.ok, false);
      const res3 = handleJoinRoom(null);
      assert.equal(res3.ok, false);
      assert.equal(joinRoomCalls.length, 0);
    });
  });

  describe('4. Idempotent JOIN_ROOM & peer status', () => {
    test('reuses existing room on duplicate JOIN_ROOM without rejoining', () => {
      handleJoinRoom('  LK-AbCd  ');
      assert.equal(joinRoomCalls.length, 1);

      // Second join with equivalent normalized key
      const res = handleJoinRoom('lk-abcd');
      assert.equal(joinRoomCalls.length, 1, 'joinRoom should not be called again');
      assert.equal(res.ok, true);
      assert.equal(res.selfId, selfId);
      assert.equal(res.peerOnline, false);
      assert.equal(res.rttMs, null);
    });

    test('refreshes peerOnline and sends immediate ping on idempotent join if peers present', () => {
      handleJoinRoom('test-key');
      assert.equal(joinRoomCalls.length, 1);

      // Simulate peers discovered
      mockRoom.setPeers({ 'remote-peer-1': {} });

      const res = handleJoinRoom('test-key');
      assert.equal(res.ok, true);
      assert.equal(res.peerOnline, true);
      assert.equal(pingsSent.length, 1, 'Immediate ping should be triggered when peer is online and rtt is null');
      assert.equal(syncPingsSent.length, 1, 'Immediate sync ping should be triggered');
    });

    test('handles JOIN_ROOM via chrome.runtime.onMessage listener', async () => {
      assert.ok(messageListener, 'Message listener should be registered');
      let response = null;
      messageListener(
        { target: 'offscreen', type: 'JOIN_ROOM', pairKey: '  MSG-KEY-1  ' },
        {},
        (resp) => { response = resp; }
      );
      assert.ok(response);
      assert.equal(response.ok, true);
      assert.equal(response.selfId, selfId);
      assert.equal(joinRoomCalls[0].config.password, 'msg-key-1');
    });
  });

  describe('5. LEAVE_ROOM', () => {
    test('closes room, clears state, and notifies SW with peerOnline=false', () => {
      handleJoinRoom('key-to-leave');
      assert.equal(joinRoomCalls.length, 1);
      assert.equal(mockRoom.isLeft(), false);

      sentMessages.length = 0; // clear sent messages buffer
      let leaveResponse = null;
      messageListener(
        { target: 'offscreen', type: 'LEAVE_ROOM' },
        {},
        (resp) => { leaveResponse = resp; }
      );

      assert.deepEqual(leaveResponse, { ok: true });
      assert.equal(mockRoom.isLeft(), true);

      const statusMsg = sentMessages.find(m => m.type === 'PEER_STATUS');
      assert.ok(statusMsg, 'PEER_STATUS should be emitted on LEAVE_ROOM');
      assert.equal(statusMsg.peerOnline, false);
      assert.equal(statusMsg.rttMs, null);

      // Joining again now triggers a fresh joinRoom call
      handleJoinRoom('key-to-leave');
      assert.equal(joinRoomCalls.length, 2);
    });
  });
});
