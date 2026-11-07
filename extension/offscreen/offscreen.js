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

// Multi-peer mesh state: peerId -> { peerId, name, isHost, rttMs, clockOffsetMs }
export const peers = new Map();
export const kickedPeerIds = new Set();
export const selfMeta = { name: '', isHost: false };

function notifyPeerStatus(online, rtt) {
  if (typeof online === 'boolean') {
    peerOnline = online;
  } else {
    peerOnline = peers.size > 0;
  }

  if (rtt !== undefined) {
    currentRtt = rtt ?? null;
  } else if (peers.size === 0) {
    currentRtt = null;
  } else if (currentRtt === null) {
    for (const p of peers.values()) {
      if (p.rttMs !== null && p.rttMs !== undefined) {
        currentRtt = p.rttMs;
        break;
      }
    }
  }

  chrome.runtime.sendMessage({
    target: 'sw',
    from: 'offscreen',
    type: 'PEER_STATUS',
    peerOnline,
    rttMs: currentRtt,
    peers: Array.from(peers.values()),
    peerCount: peers.size,
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
  peers.clear();
  kickedPeerIds.clear();
  notifyPeerStatus(false, null);
}

function handlePeerJoin(peerId) {
  if (!peerId) {
    const peerKeys = typeof room?.getPeers === 'function' ? Object.keys(room.getPeers() || {}) : [];
    if (peerKeys.length > 0) {
      for (const pid of peerKeys) {
        handlePeerJoin(pid);
      }
      return;
    }
    peerOnline = true;
    notifyPeerStatus(true, currentRtt);
    return;
  }

  if (kickedPeerIds.has(peerId)) {
    try {
      room?.getPeers?.()?.[peerId]?.close?.();
    } catch (_) {}
    return;
  }

  if (!peers.has(peerId)) {
    peers.set(peerId, {
      peerId,
      name: '',
      isHost: false,
      rttMs: null,
      clockOffsetMs: null
    });
  }

  const now = Date.now();
  if (sendSyncAction) {
    try {
      sendSyncAction(
        { __lockstep_meta: true, name: selfMeta.name, isHost: Boolean(selfMeta.isHost) },
        peerId
      );
      sendSyncAction(
        { __lockstep_ping: true, t1: now, pingTime: now },
        peerId
      );
    } catch (_) {}
  }
  if (sendPingAction) {
    try {
      sendPingAction({ pingTime: now }, peerId);
    } catch (_) {}
  }

  notifyPeerStatus();

  chrome.runtime.sendMessage({
    target: 'sw',
    from: 'offscreen',
    type: 'PEER_JOINED',
    peerId
  }).catch(() => {});
}

function handlePeerLeave(peerId) {
  if (peerId) {
    peers.delete(peerId);
  } else {
    const peerKeys = new Set(typeof room?.getPeers === 'function' ? Object.keys(room.getPeers() || {}) : []);
    for (const pid of peers.keys()) {
      if (!peerKeys.has(pid)) {
        peers.delete(pid);
      }
    }
  }
  notifyPeerStatus();
}

function handleJoinRoom(pairKey, roomId, incomingSelfMeta) {
  const normalizedKey = String(pairKey || '').trim().toLowerCase();
  if (!normalizedKey) {
    return { ok: false, error: 'Missing pairKey' };
  }
  const targetRoomId = String(roomId || normalizedKey).trim().toLowerCase();

  if (incomingSelfMeta) {
    if (incomingSelfMeta.name !== undefined) {
      selfMeta.name = String(incomingSelfMeta.name || '').trim().slice(0, 24);
    }
    if (incomingSelfMeta.isHost !== undefined) {
      selfMeta.isHost = Boolean(incomingSelfMeta.isHost);
    }
  }

  if (room && currentPairKey === normalizedKey) {
    if (incomingSelfMeta && sendSyncAction) {
      try {
        sendSyncAction({
          __lockstep_meta: true,
          name: selfMeta.name,
          isHost: Boolean(selfMeta.isHost)
        });
      } catch (_) {}
    }

    const currentPeers = typeof room.getPeers === 'function' ? Object.keys(room.getPeers() || {}) : [];
    peerOnline = currentPeers.length > 0 || peers.size > 0;
    if (peerOnline && currentRtt === null) {
      const now = Date.now();
      if (sendPingAction) sendPingAction({ pingTime: now });
      if (sendSyncAction) sendSyncAction({ __lockstep_ping: true, t1: now, pingTime: now });
    }
    notifyPeerStatus(peerOnline, currentRtt);
    return {
      ok: true,
      selfId,
      peerOnline,
      rttMs: currentRtt,
      peers: Array.from(peers.values()),
      peerCount: peers.size
    };
  }

  leaveCurrentRoom();
  currentPairKey = normalizedKey;

  if (incomingSelfMeta) {
    if (incomingSelfMeta.name !== undefined) {
      selfMeta.name = String(incomingSelfMeta.name || '').trim().slice(0, 24);
    }
    if (incomingSelfMeta.isHost !== undefined) {
      selfMeta.isHost = Boolean(incomingSelfMeta.isHost);
    }
  }

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
      if (!payload) return;
      if (peerId && kickedPeerIds.has(peerId)) return;

      // Inband Cristian ping
      if (payload.__lockstep_ping) {
        if (sendSyncAction) {
          const now = Date.now();
          const t1 = payload.t1 ?? payload.pingTime ?? now;
          try {
            sendSyncAction(
              { __lockstep_pong: true, t1, t2: now, pingTime: t1 },
              peerId
            );
          } catch (_) {}
        }
        return;
      }

      // Inband Cristian pong
      if (payload.__lockstep_pong) {
        const t4 = Date.now();
        const t1 = payload.t1 ?? payload.pingTime ?? t4;
        const t2 = payload.t2 ?? t1;
        const rtt = Math.max(0, t4 - t1);
        const offset = ((t2 - t1) + (t2 - t4)) / 2;

        let peer = peerId ? peers.get(peerId) : null;
        if (!peer && peerId) {
          peer = { peerId, name: '', isHost: false, rttMs: null, clockOffsetMs: null };
          peers.set(peerId, peer);
        }
        if (peer) {
          peer.rttMs = rtt;
          const prev = peer.clockOffsetMs;
          peer.clockOffsetMs = prev == null ? offset : prev * 0.7 + offset * 0.3;
        }
        currentRtt = rtt;
        notifyPeerStatus();
        return;
      }

      // Metadata exchange
      if (payload.__lockstep_meta) {
        let peer = peerId ? peers.get(peerId) : null;
        if (!peer && peerId) {
          peer = { peerId, name: '', isHost: false, rttMs: null, clockOffsetMs: null };
          peers.set(peerId, peer);
        }
        if (peer) {
          if (typeof payload.name === 'string') {
            peer.name = payload.name.trim().slice(0, 24);
          }
          if (payload.isHost !== undefined) {
            peer.isHost = Boolean(payload.isHost);
          }
          notifyPeerStatus();
        }
        return;
      }

      // Forward data messages to SW
      const peer = peerId ? peers.get(peerId) : null;
      chrome.runtime.sendMessage({
        target: 'sw',
        from: 'offscreen',
        type: 'RTC_RECV',
        payload,
        peerId: peerId || null,
        peerRttMs: peer?.rttMs ?? currentRtt,
        peerClockOffsetMs: peer?.clockOffsetMs ?? null
      }).catch(() => {});
    });

    getPing((data, peerId) => {
      if (sendPongAction) {
        sendPongAction({ pingTime: data?.pingTime || Date.now() }, peerId);
      }
    });

    getPong((data, peerId) => {
      const now = Date.now();
      const rtt = Math.max(0, now - (data?.pingTime || now));
      if (peerId) {
        const peer = peers.get(peerId);
        if (peer) {
          peer.rttMs = rtt;
        }
      }
      currentRtt = rtt;
      notifyPeerStatus(true, rtt);
    });

    room.onPeerJoin((peerId) => {
      handlePeerJoin(peerId);
    });

    room.onPeerLeave((peerId) => {
      handlePeerLeave(peerId);
    });

    // 2s ping/pong RTT measurement
    pingInterval = setInterval(() => {
      const hasPeers = peers.size > 0 || (typeof room?.getPeers === 'function' && Object.keys(room.getPeers() || {}).length > 0);
      if (room && (peerOnline || hasPeers)) {
        const now = Date.now();
        if (peers.size > 0) {
          for (const pid of peers.keys()) {
            if (sendSyncAction) {
              try {
                sendSyncAction({ __lockstep_ping: true, t1: now, pingTime: now }, pid);
              } catch (_) {}
            }
          }
        } else if (sendSyncAction) {
          try {
            sendSyncAction({ __lockstep_ping: true, t1: now, pingTime: now });
          } catch (_) {}
        }
        if (sendPingAction) {
          try {
            sendPingAction({ pingTime: now });
          } catch (_) {}
        }
      }
    }, 2000);
    pingInterval?.unref?.();

    notifyPeerStatus(false, null);
    return {
      ok: true,
      selfId,
      peerOnline: false,
      rttMs: null,
      peers: [],
      peerCount: 0
    };
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
    const incomingSelfMeta = message.selfMeta || message.payload?.selfMeta;
    const res = handleJoinRoom(pairKey, roomId, incomingSelfMeta);
    sendResponse(res || {
      ok: true,
      selfId,
      peerOnline,
      rttMs: currentRtt,
      peers: Array.from(peers.values()),
      peerCount: peers.size
    });
    return false;
  }

  if (type === 'UPDATE_SELF_META') {
    const meta = message.payload || message;
    if (meta.name !== undefined) {
      selfMeta.name = String(meta.name || '').trim().slice(0, 24);
    }
    if (meta.isHost !== undefined) {
      selfMeta.isHost = Boolean(meta.isHost);
    }
    if (sendSyncAction) {
      try {
        sendSyncAction({
          __lockstep_meta: true,
          name: selfMeta.name,
          isHost: Boolean(selfMeta.isHost)
        });
      } catch (_) {}
    }
    sendResponse({ ok: true, selfMeta });
    return false;
  }

  if (type === 'KICK_PEER') {
    const targetPeerId = message.targetPeerId || message.payload?.targetPeerId;
    if (targetPeerId) {
      kickedPeerIds.add(targetPeerId);
      if (message.broadcast !== false && sendSyncAction) {
        try {
          sendSyncAction({ type: 'KICK_PEER', targetPeerId });
        } catch (_) {}
      }
      try {
        room?.getPeers?.()?.[targetPeerId]?.close?.();
      } catch (_) {}
      peers.delete(targetPeerId);
      notifyPeerStatus();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'LEAVE_ROOM') {
    leaveCurrentRoom();
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'RTC_SEND') {
    const payload = message.payload;
    const targetPeerId = message.targetPeerId;
    if (sendSyncAction) {
      try {
        if (targetPeerId) {
          sendSyncAction(payload, targetPeerId);
        } else {
          sendSyncAction(payload);
        }
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
