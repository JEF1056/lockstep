import { joinRoom, selfId } from '../vendor/trystero-nostr.min.js';

export const RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://nostr.oxtr.dev',
  'wss://nostr.data.haus'
];

let joinRoomFn = joinRoom;

export function _setJoinRoomForTesting(fn) {
  joinRoomFn = fn || joinRoom;
}

let room = null;
let currentPairKey = null;
let pingInterval = null;
let peerOnline = false;
let currentRtt = null;
let sendSyncAction = null;
let sendPingAction = null;
let sendPongAction = null;

function notifyPeerStatus(online, rtt) {
  peerOnline = Boolean(online);
  currentRtt = rtt ?? null;
  chrome.runtime.sendMessage({
    target: 'sw',
    from: 'offscreen',
    type: 'PEER_STATUS',
    peerOnline,
    rttMs: currentRtt,
    selfId
  }).catch(() => {});
}

function leaveCurrentRoom() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (room) {
    try {
      room.leave();
    } catch (_) {}
    room = null;
  }
  currentPairKey = null;
  sendSyncAction = null;
  sendPingAction = null;
  sendPongAction = null;
  notifyPeerStatus(false, null);
}

function handleJoinRoom(pairKey, roomId) {
  const normalizedKey = String(pairKey || '').trim().toLowerCase();
  if (!normalizedKey) {
    return { ok: false, error: 'Missing pairKey' };
  }
  const targetRoomId = String(roomId || normalizedKey).trim().toLowerCase();

  if (room && currentPairKey === normalizedKey) {
    const peers = typeof room.getPeers === 'function' ? Object.keys(room.getPeers() || {}) : [];
    peerOnline = peers.length > 0;
    if (peerOnline && currentRtt === null) {
      const now = Date.now();
      if (sendPingAction) sendPingAction({ pingTime: now });
      if (sendSyncAction) sendSyncAction({ __lockstep_ping: true, pingTime: now });
    }
    notifyPeerStatus(peerOnline, currentRtt);
    return { ok: true, selfId, peerOnline, rttMs: currentRtt };
  }

  leaveCurrentRoom();
  currentPairKey = normalizedKey;

  try {
    room = joinRoomFn(
      { appId: 'lockstep-v1', password: normalizedKey, relayUrls: RELAY_URLS },
      targetRoomId
    );

    const [sendSync, getSync] = room.makeAction('sync');
    const [sendPing, getPing] = room.makeAction('ping');
    const [sendPong, getPong] = room.makeAction('pong');

    sendSyncAction = sendSync;
    sendPingAction = sendPing;
    sendPongAction = sendPong;

    getSync((payload, peerId) => {
      // Inband ping/pong fallback
      if (payload && payload.__lockstep_ping) {
        if (sendSyncAction) {
          sendSyncAction({ __lockstep_pong: true, pingTime: payload.pingTime }, peerId);
        }
        return;
      }
      if (payload && payload.__lockstep_pong) {
        const rtt = Math.max(0, Date.now() - (payload.pingTime || Date.now()));
        notifyPeerStatus(true, rtt);
        return;
      }

      chrome.runtime.sendMessage({
        target: 'sw',
        from: 'offscreen',
        type: 'RTC_RECV',
        payload,
        peerId
      }).catch(() => {});
    });

    getPing((data, peerId) => {
      if (sendPongAction) {
        sendPongAction({ pingTime: data?.pingTime || Date.now() }, peerId);
      }
    });

    getPong((data) => {
      const now = Date.now();
      const rtt = Math.max(0, now - (data?.pingTime || now));
      notifyPeerStatus(true, rtt);
    });

    room.onPeerJoin(() => {
      peerOnline = true;
      notifyPeerStatus(true, currentRtt);
      const now = Date.now();
      if (sendPingAction) sendPingAction({ pingTime: now });
      if (sendSyncAction) sendSyncAction({ __lockstep_ping: true, pingTime: now });
    });

    room.onPeerLeave(() => {
      const peers = typeof room?.getPeers === 'function' ? Object.keys(room.getPeers() || {}) : [];
      peerOnline = peers.length > 0;
      if (!peerOnline) {
        currentRtt = null;
      }
      notifyPeerStatus(peerOnline, currentRtt);
    });

    // 2s ping/pong RTT measurement
    pingInterval = setInterval(() => {
      if (room && peerOnline) {
        const now = Date.now();
        if (sendPingAction) sendPingAction({ pingTime: now });
        if (sendSyncAction) sendSyncAction({ __lockstep_ping: true, pingTime: now });
      }
    }, 2000);
    pingInterval?.unref?.();

    notifyPeerStatus(false, null);
    return { ok: true, selfId, peerOnline: false, rttMs: null };
  } catch (err) {
    console.error('[Lockstep Offscreen] Failed to join room:', err);
    leaveCurrentRoom();
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') {
    return false;
  }

  const { type } = message;

  if (type === 'JOIN_ROOM') {
    const pairKey = message.pairKey || message.payload?.pairKey;
    const roomId = message.roomId || message.payload?.roomId;
    const res = handleJoinRoom(pairKey, roomId);
    sendResponse(res || { ok: true, selfId, peerOnline, rttMs: currentRtt });
    return false;
  }

  if (type === 'LEAVE_ROOM') {
    leaveCurrentRoom();
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'RTC_SEND') {
    const payload = message.payload;
    if (sendSyncAction) {
      try {
        sendSyncAction(payload);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    } else {
      sendResponse({ ok: false, error: 'No active RTC room' });
    }
    return false;
  }

  return false;
});

// Boot ping so SW immediately joins pairKey if createDocument resolved before module load finished
chrome.runtime.sendMessage({
  target: 'sw',
  from: 'offscreen',
  type: 'OFFSCREEN_READY',
  selfId
}).catch(() => {});

export {
  handleJoinRoom,
  leaveCurrentRoom,
  notifyPeerStatus
};
