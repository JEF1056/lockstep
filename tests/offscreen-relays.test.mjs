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
  _setJoinRoomForTesting,
  peers,
  kickedPeerIds,
  selfMeta
} = await import('../extension/offscreen/offscreen.js');

const { selfId } = await import('../extension/vendor/trystero-nostr.min.js');

describe('Offscreen Nostr Relays & Room Lifecycle', () => {
  let joinRoomCalls = [];
  let mockRoom = null;
  let pingsSent = [];
  let syncPingsSent = [];
  let syncSent = [];
  let syncRecvCb = null;
  let pingRecvCb = null;
  let pongRecvCb = null;

  function setupMockRoom(initialPeers = {}) {
    pingsSent = [];
    syncPingsSent = [];
    syncSent = [];
    let peerConnections = { ...initialPeers };
    let left = false;
    let peerJoinCb = null;
    let peerLeaveCb = null;

    mockRoom = {
      makeAction: (name) => {
        if (name === 'ping') {
          return [
            (data, target) => { pingsSent.push({ data, target }); },
            (cb) => { pingRecvCb = cb; }
          ];
        }
        if (name === 'sync') {
          return [
            (data, targetPeerId) => {
              syncSent.push({ data, targetPeerId });
              if (data?.__lockstep_ping) syncPingsSent.push(data);
            },
            (cb) => { syncRecvCb = cb; }
          ];
        }
        if (name === 'pong') {
          return [
            (data, target) => {},
            (cb) => { pongRecvCb = cb; }
          ];
        }
        return [() => {}, () => {}];
      },
      onPeerJoin: (cb) => { peerJoinCb = cb; },
      onPeerLeave: (cb) => { peerLeaveCb = cb; },
      getPeers: () => peerConnections,
      setPeers: (newPeers) => { peerConnections = newPeers; },
      setPeerConnection: (peerId, conn) => { peerConnections[peerId] = conn; },
      triggerPeerJoin: (peerId) => peerJoinCb?.(peerId),
      triggerPeerLeave: (peerId) => peerLeaveCb?.(peerId),
      triggerSyncRecv: (payload, peerId) => syncRecvCb?.(payload, peerId),
      triggerPingRecv: (data, peerId) => pingRecvCb?.(data, peerId),
      triggerPongRecv: (data, peerId) => pongRecvCb?.(data, peerId),
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

  describe('6. Multi-peer mesh roster tracking', () => {
    test('tracks peer joins, notifies SW with PEER_JOINED and updated PEER_STATUS', () => {
      handleJoinRoom('mesh-room');
      sentMessages.length = 0;
      syncSent.length = 0;

      mockRoom.triggerPeerJoin('peer-alpha');

      // PEER_JOINED message to SW
      const joinedMsg = sentMessages.find(m => m.type === 'PEER_JOINED');
      assert.ok(joinedMsg, 'PEER_JOINED should be sent to SW');
      assert.equal(joinedMsg.peerId, 'peer-alpha');

      // PEER_STATUS message to SW
      const statusMsg = sentMessages.filter(m => m.type === 'PEER_STATUS').pop();
      assert.ok(statusMsg, 'PEER_STATUS should be sent to SW');
      assert.equal(statusMsg.peerOnline, true);
      assert.equal(statusMsg.peerCount, 1);
      assert.equal(statusMsg.peers.length, 1);
      assert.equal(statusMsg.peers[0].peerId, 'peer-alpha');

      // Initial unicast meta and ping sent to joining peer
      const metaSend = syncSent.find(s => s.targetPeerId === 'peer-alpha' && s.data?.__lockstep_meta);
      assert.ok(metaSend, 'Unicasts __lockstep_meta to joining peer');

      const pingSend = syncSent.find(s => s.targetPeerId === 'peer-alpha' && s.data?.__lockstep_ping);
      assert.ok(pingSend, 'Unicasts __lockstep_ping to joining peer');

      // Second peer joins
      mockRoom.triggerPeerJoin('peer-beta');
      assert.equal(peers.size, 2);
      const secondStatus = sentMessages.filter(m => m.type === 'PEER_STATUS').pop();
      assert.equal(secondStatus.peerCount, 2);
      assert.deepEqual(
        secondStatus.peers.map(p => p.peerId).sort(),
        ['peer-alpha', 'peer-beta'].sort()
      );
    });

    test('tracks peer leaves and updates roster', () => {
      handleJoinRoom('mesh-room');
      mockRoom.triggerPeerJoin('peer-alpha');
      mockRoom.triggerPeerJoin('peer-beta');
      assert.equal(peers.size, 2);

      sentMessages.length = 0;
      mockRoom.triggerPeerLeave('peer-alpha');

      assert.equal(peers.size, 1);
      assert.equal(peers.has('peer-alpha'), false);
      assert.equal(peers.has('peer-beta'), true);

      const statusMsg = sentMessages.filter(m => m.type === 'PEER_STATUS').pop();
      assert.ok(statusMsg);
      assert.equal(statusMsg.peerCount, 1);
      assert.equal(statusMsg.peers.length, 1);
      assert.equal(statusMsg.peers[0].peerId, 'peer-beta');
    });
  });

  describe('7. UPDATE_SELF_META & metadata exchange', () => {
    test('updates local selfMeta and broadcasts to peers', () => {
      handleJoinRoom('meta-room');
      syncSent.length = 0;

      let response = null;
      messageListener(
        {
          target: 'offscreen',
          type: 'UPDATE_SELF_META',
          name: '  Alice in Wonderland Over 24 chars limit here  ',
          isHost: true
        },
        {},
        (resp) => { response = resp; }
      );

      assert.ok(response);
      assert.equal(response.ok, true);
      assert.equal(selfMeta.name, 'Alice in Wonderland Over');
      assert.equal(selfMeta.isHost, true);

      const metaBroadcast = syncSent.find(s => s.data?.__lockstep_meta && !s.targetPeerId);
      assert.ok(metaBroadcast, '__lockstep_meta should be broadcast');
      assert.equal(metaBroadcast.data.name, 'Alice in Wonderland Over');
      assert.equal(metaBroadcast.data.isHost, true);
    });

    test('receives and stores peer metadata from __lockstep_meta', () => {
      handleJoinRoom('meta-room');
      mockRoom.triggerPeerJoin('peer-gamma');

      sentMessages.length = 0;
      mockRoom.triggerSyncRecv(
        { __lockstep_meta: true, name: '  Captain Kirk  ', isHost: true },
        'peer-gamma'
      );

      const peer = peers.get('peer-gamma');
      assert.ok(peer);
      assert.equal(peer.name, 'Captain Kirk');
      assert.equal(peer.isHost, true);

      const statusMsg = sentMessages.filter(m => m.type === 'PEER_STATUS').pop();
      assert.ok(statusMsg);
      const updatedPeer = statusMsg.peers.find(p => p.peerId === 'peer-gamma');
      assert.equal(updatedPeer.name, 'Captain Kirk');
      assert.equal(updatedPeer.isHost, true);
    });
  });

  describe('8. Cristian ping/pong & clock offset calculation', () => {
    test('replies to incoming __lockstep_ping with __lockstep_pong unicast back to sender', () => {
      handleJoinRoom('clock-room');
      syncSent.length = 0;

      const pingT1 = 1700000000000;
      mockRoom.triggerSyncRecv({ __lockstep_ping: true, t1: pingT1 }, 'peer-delta');

      const pongSend = syncSent.find(s => s.targetPeerId === 'peer-delta' && s.data?.__lockstep_pong);
      assert.ok(pongSend, 'Sends pong back to peer-delta');
      assert.equal(pongSend.data.t1, pingT1);
      assert.equal(typeof pongSend.data.t2, 'number');
    });

    test('processes incoming __lockstep_pong, computes RTT & EMA clockOffsetMs', () => {
      handleJoinRoom('clock-room');
      mockRoom.triggerPeerJoin('peer-delta');

      const now = Date.now();
      const t1 = now - 60; // 60ms roundtrip
      const t2 = now - 20; // remote timestamp

      sentMessages.length = 0;
      mockRoom.triggerSyncRecv(
        { __lockstep_pong: true, t1, t2 },
        'peer-delta'
      );

      const peer = peers.get('peer-delta');
      assert.ok(peer);
      assert.ok(peer.rttMs >= 50 && peer.rttMs <= 70);
      assert.ok(peer.clockOffsetMs >= 5 && peer.clockOffsetMs <= 15);

      // Second pong checks EMA smoothing: prev * 0.7 + offset * 0.3
      const prevOffset = peer.clockOffsetMs;
      const t1b = Date.now() - 100;
      const t2b = Date.now();
      mockRoom.triggerSyncRecv(
        { __lockstep_pong: true, t1: t1b, t2: t2b },
        'peer-delta'
      );
      assert.notEqual(peer.clockOffsetMs, prevOffset);
      assert.ok(peer.clockOffsetMs > prevOffset);
    });

    test('forwards data messages to SW as RTC_RECV with peerId, peerRttMs, and peerClockOffsetMs', () => {
      handleJoinRoom('data-room');
      mockRoom.triggerPeerJoin('peer-epsilon');
      const peer = peers.get('peer-epsilon');
      peer.rttMs = 35;
      peer.clockOffsetMs = -12;

      sentMessages.length = 0;
      const dataPayload = { type: 'INTENT', action: 'PLAY', timestamp: 12345 };
      mockRoom.triggerSyncRecv(dataPayload, 'peer-epsilon');

      const recvMsg = sentMessages.find(m => m.type === 'RTC_RECV');
      assert.ok(recvMsg, 'RTC_RECV should be sent to SW');
      assert.deepEqual(recvMsg.payload, dataPayload);
      assert.equal(recvMsg.peerId, 'peer-epsilon');
      assert.equal(recvMsg.peerRttMs, 35);
      assert.equal(recvMsg.peerClockOffsetMs, -12);
    });
  });

  describe('9. Unicast targetPeerId in RTC_SEND', () => {
    test('unicasts to targetPeerId when specified, broadcasts otherwise', () => {
      handleJoinRoom('send-room');
      syncSent.length = 0;

      // Unicast
      messageListener(
        {
          target: 'offscreen',
          type: 'RTC_SEND',
          payload: { type: 'SHARE_FEED', pageUrl: 'https://example.com' },
          targetPeerId: 'peer-zeta'
        },
        {},
        () => {}
      );

      assert.equal(syncSent.length, 1);
      assert.equal(syncSent[0].targetPeerId, 'peer-zeta');
      assert.equal(syncSent[0].data.type, 'SHARE_FEED');

      // Broadcast
      messageListener(
        {
          target: 'offscreen',
          type: 'RTC_SEND',
          payload: { type: 'SEEK_INTENT', time: 10 }
        },
        {},
        () => {}
      );

      assert.equal(syncSent.length, 2);
      assert.equal(syncSent[1].targetPeerId, undefined);
      assert.equal(syncSent[1].data.type, 'SEEK_INTENT');
    });
  });

  describe('10. Peer kick enforcement', () => {
    test('kicks peer: adds to kicked set, sends kick action, closes connection, and deletes from roster', () => {
      handleJoinRoom('kick-room');
      mockRoom.triggerPeerJoin('bad-actor');
      let closed = false;
      mockRoom.setPeerConnection('bad-actor', {
        close: () => { closed = true; }
      });

      assert.equal(peers.has('bad-actor'), true);
      syncSent.length = 0;
      sentMessages.length = 0;

      let kickResponse = null;
      messageListener(
        {
          target: 'offscreen',
          type: 'KICK_PEER',
          targetPeerId: 'bad-actor'
        },
        {},
        (resp) => { kickResponse = resp; }
      );

      assert.deepEqual(kickResponse, { ok: true });
      assert.equal(kickedPeerIds.has('bad-actor'), true);
      assert.equal(closed, true, 'Calls connection.close() on kicked peer');
      assert.equal(peers.has('bad-actor'), false);

      const kickSync = syncSent.find(s => s.data?.type === 'KICK_PEER');
      assert.ok(kickSync, 'Sends KICK_PEER via sync');
      assert.equal(kickSync.data.targetPeerId, 'bad-actor');

      // Rejoin attempt by kicked peer is rejected immediately
      let recloseCalled = false;
      mockRoom.setPeerConnection('bad-actor', {
        close: () => { recloseCalled = true; }
      });
      sentMessages.length = 0;
      mockRoom.triggerPeerJoin('bad-actor');
      assert.equal(recloseCalled, true);
      assert.equal(peers.has('bad-actor'), false);
      const rejoinedMsg = sentMessages.find(m => m.type === 'PEER_JOINED');
      assert.equal(rejoinedMsg, undefined, 'Does not emit PEER_JOINED for kicked peer');

      // Incoming sync message from kicked peer is dropped
      mockRoom.triggerSyncRecv({ type: 'INTENT' }, 'bad-actor');
      const recvMsg = sentMessages.find(m => m.type === 'RTC_RECV');
      assert.equal(recvMsg, undefined, 'Drops incoming messages from kicked peer');
    });
  });
});
