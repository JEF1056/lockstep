import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncEngine,
  ECHO_GUARD_MS,
  DRIFT_NOOP_MS,
  DRIFT_SNAP_MS,
  RATE_NUDGE_FACTOR
} from '../extension/shared/sync-engine.js';

describe('Sync Engine - Lamport Clock & Tie-Breaking', () => {
  test('increments seq on localIntent and returns valid message structure', () => {
    const engine = createSyncEngine('peerA');
    assert.equal(engine.getSeq(), 0);

    const msg = engine.localIntent('PLAY', { paused: false, time: 10, rate: 1 }, 1000);
    assert.equal(engine.getSeq(), 1);
    assert.equal(msg.type, 'INTENT');
    assert.equal(msg.action, 'PLAY');
    assert.equal(msg.seq, 1);
    assert.equal(msg.peerId, 'peerA');
    assert.equal(msg.paused, false);
    assert.equal(msg.time, 10);
    assert.equal(msg.rate, 1);
    assert.equal(msg.timestamp, 1000);
  });

  test('localHeartbeat does not increment seq', () => {
    const engine = createSyncEngine('peerA');
    engine.localIntent('PLAY', { paused: false, time: 5 }, 1000);
    assert.equal(engine.getSeq(), 1);

    const hb = engine.localHeartbeat({ paused: false, time: 6 }, 2000);
    assert.equal(engine.getSeq(), 1);
    assert.equal(hb.type, 'HEARTBEAT');
    assert.equal(hb.seq, 1);
  });

  test('rejects self-messages', () => {
    const engine = createSyncEngine('peerA');
    const res = engine.resolveRemote({
      type: 'INTENT',
      seq: 2,
      peerId: 'peerA',
      paused: false,
      time: 10
    }, { paused: false, time: 10 }, 0, 1000);

    assert.equal(res.action, 'IGNORE');
    assert.equal(res.reason, 'self-message');
  });

  test('rejects stale remote sequence numbers', () => {
    const engine = createSyncEngine('peerA');
    engine.localIntent('PLAY', { paused: false, time: 10 }, 1000); // seq: 1
    engine.localIntent('SEEK', { paused: false, time: 20 }, 1010); // seq: 2

    const res = engine.resolveRemote({
      type: 'INTENT',
      seq: 1,
      peerId: 'peerB',
      paused: false,
      time: 15
    }, { paused: false, time: 20 }, 0, 1500);

    assert.equal(res.action, 'IGNORE');
    assert.equal(res.reason, 'stale-seq');
  });

  test('tie-break: peerId breaks tie when seq is equal', () => {
    // Alphabetical order: 'peerA' < 'peerB'
    const engineA = createSyncEngine('peerA');
    engineA.localIntent('PAUSE', { paused: true, time: 10 }, 1000); // engineA at seq 1

    // Incoming msg from peerB with seq 1: 'peerB' > 'peerA' -> peerB wins!
    const resB = engineA.resolveRemote({
      type: 'INTENT',
      action: 'PLAY',
      seq: 1,
      peerId: 'peerB',
      paused: false,
      time: 10
    }, { paused: true, time: 10 }, 0, 1050);

    assert.notEqual(resB.action, 'IGNORE');

    // Conversely, engineB at seq 1 receives from peerA: 'peerA' < 'peerB' -> peerA loses!
    const engineB = createSyncEngine('peerB');
    engineB.localIntent('PLAY', { paused: false, time: 10 }, 1000); // engineB at seq 1

    const resA = engineB.resolveRemote({
      type: 'INTENT',
      action: 'PAUSE',
      seq: 1,
      peerId: 'peerA',
      paused: true,
      time: 10
    }, { paused: false, time: 10 }, 0, 1050);

    assert.equal(resA.action, 'IGNORE');
    assert.equal(resA.reason, 'tie-break-lost');
  });

  test('leader HEARTBEAT is accepted even if peerId is lower, non-leader HEARTBEAT rejected', () => {
    // peerA < peerB
    const engineB = createSyncEngine('peerB');

    // peerA sends INTENT seq=1. peerB accepts and sets seqOwner = 'peerA'
    const intentRes = engineB.resolveRemote({
      type: 'INTENT',
      action: 'PLAY',
      seq: 1,
      peerId: 'peerA',
      paused: false,
      time: 10,
      rate: 1
    }, { paused: true, time: 10 }, 0, 1000);
    assert.notEqual(intentRes.action, 'IGNORE');
    assert.equal(engineB.getSeq(), 1);

    // Subsequent HEARTBEAT from leader peerA at same seq (1) must NOT be rejected as tie-break-lost
    const leaderHbRes = engineB.resolveRemote({
      type: 'HEARTBEAT',
      action: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerA',
      paused: false,
      time: 10.02,
      rate: 1
    }, { paused: false, time: 10.0 }, 0, 2000);
    assert.notEqual(leaderHbRes.action, 'IGNORE');

    // Heartbeat from another peer (peerC) with seq=1 must be rejected
    const imposterHbRes = engineB.resolveRemote({
      type: 'HEARTBEAT',
      action: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerC',
      paused: false,
      time: 10.02,
      rate: 1
    }, { paused: false, time: 10.0 }, 0, 2000);
    assert.equal(imposterHbRes.action, 'IGNORE');
    assert.equal(imposterHbRes.reason, 'tie-break-lost');
  });

  test('advances local seq upon accepting higher remote seq', () => {
    const engine = createSyncEngine('peerA');
    assert.equal(engine.getSeq(), 0);

    const res = engine.resolveRemote({
      type: 'INTENT',
      seq: 10,
      peerId: 'peerB',
      paused: false,
      time: 10
    }, { paused: false, time: 10 }, 0, 1000);

    assert.notEqual(res.action, 'IGNORE');
    assert.equal(engine.getSeq(), 10);
  });

  test('reset restores initial state', () => {
    const engine = createSyncEngine('peerA');
    engine.localIntent('PLAY', { paused: false, time: 10 }, 1000);
    assert.equal(engine.getSeq(), 1);

    engine.reset();
    assert.equal(engine.getSeq(), 0);
  });
});

describe('Sync Engine - 300ms Intent-Scoped Echo Guard', () => {
  test('blocks echo of same action within 300ms', () => {
    const engine = createSyncEngine('peerA');
    engine.localIntent('PLAY', { paused: false, time: 10 }, 1000);

    // Remote reflects PLAY at 1100 (delta = 100ms < 300ms)
    const res = engine.resolveRemote({
      type: 'INTENT',
      action: 'PLAY',
      seq: 2,
      peerId: 'peerB',
      paused: false,
      time: 10.1
    }, { paused: false, time: 10.1 }, 0, 1100);

    assert.equal(res.action, 'IGNORE');
    assert.equal(res.reason, 'echo-guard');
  });

  test('passes opposite human action within 300ms', () => {
    const engine = createSyncEngine('peerA');
    // Local user hit PLAY at 1000
    engine.localIntent('PLAY', { paused: false, time: 10 }, 1000);

    // Remote user hit PAUSE at 1100 (opposite action!)
    const res = engine.resolveRemote({
      type: 'INTENT',
      action: 'PAUSE',
      seq: 2,
      peerId: 'peerB',
      paused: true,
      time: 10
    }, { paused: false, time: 10 }, 0, 1100);

    // Must NOT be ignored as an echo
    assert.notEqual(res.action, 'IGNORE');
    assert.equal(res.targetPaused, true);
  });

  test('passes opposite action when local paused and remote played', () => {
    const engine = createSyncEngine('peerA');
    // Local user hit PAUSE at 1000
    engine.localIntent('PAUSE', { paused: true, time: 10 }, 1000);

    // Remote user hit PLAY at 1150
    const res = engine.resolveRemote({
      type: 'INTENT',
      action: 'PLAY',
      seq: 2,
      peerId: 'peerB',
      paused: false,
      time: 10
    }, { paused: true, time: 10 }, 0, 1150);

    assert.notEqual(res.action, 'IGNORE');
    assert.equal(res.targetPaused, false);
  });

  test('allows same action once 300ms window has passed', () => {
    const engine = createSyncEngine('peerA');
    engine.localIntent('PLAY', { paused: false, time: 10 }, 1000);

    // Remote at 1350 (delta = 350ms > 300ms)
    const res = engine.resolveRemote({
      type: 'INTENT',
      action: 'PLAY',
      seq: 2,
      peerId: 'peerB',
      paused: false,
      time: 10
    }, { paused: false, time: 10 }, 0, 1350);

    assert.notEqual(res.action, 'IGNORE');
  });
});

describe('Sync Engine - RTT Dead-Reckoning & Drift Correction', () => {
  test('RTT dead-reckoning accounts for flight time when playing', () => {
    const engine = createSyncEngine('peerA');
    // RTT = 200ms -> one-way delay = 100ms = 0.1s
    // Remote sends time 50.0s playing at rate 1.0
    // Dead reckoning should compute targetTime = 50.1s
    const res = engine.resolveRemote({
      type: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerB',
      paused: false,
      time: 50.0,
      rate: 1.0
    }, { paused: false, time: 50.1, rate: 1.0 }, 200, 2000);

    assert.equal(Math.abs(res.targetTime - 50.1) < 0.001, true);
    assert.equal(res.action, 'NOOP'); // diff ~0ms < 40ms
  });

  test('no RTT dead-reckoning advance when remote is paused', () => {
    const engine = createSyncEngine('peerA');
    // Remote is paused at 25.0s, RTT 400ms
    const res = engine.resolveRemote({
      type: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerB',
      paused: true,
      time: 25.0,
      rate: 1.0
    }, { paused: true, time: 25.0, rate: 1.0 }, 400, 2000);

    assert.equal(res.targetTime, 25.0);
    assert.equal(res.action, 'NOOP');
  });

  test('drift < 40ms returns NOOP', () => {
    const engine = createSyncEngine('peerA');
    // Difference is 20ms (0.02s)
    const res = engine.resolveRemote({
      type: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerB',
      paused: false,
      time: 10.02,
      rate: 1.0
    }, { paused: false, time: 10.0, rate: 1.0 }, 0, 2000);

    assert.equal(res.action, 'NOOP');
    assert.equal(res.targetRate, 1.0);
  });

  test('drift 40-400ms returns NUDGE with +-4% rate adjustment', () => {
    const engine = createSyncEngine('peerA');

    // Case 1: Remote is ahead by 100ms (+0.1s). Local must speed up to +4% (1.04)
    const resAhead = engine.resolveRemote({
      type: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerB',
      paused: false,
      time: 10.1,
      rate: 1.0
    }, { paused: false, time: 10.0, rate: 1.0 }, 0, 2000);

    assert.equal(resAhead.action, 'NUDGE');
    assert.equal(resAhead.targetRate, 1.04);

    // Case 2: Remote is behind by 200ms (-0.2s). Local must slow down to -4% (0.96)
    const resBehind = engine.resolveRemote({
      type: 'HEARTBEAT',
      seq: 2,
      peerId: 'peerB',
      paused: false,
      time: 9.8,
      rate: 1.0
    }, { paused: false, time: 10.0, rate: 1.0 }, 0, 2000);

    assert.equal(resBehind.action, 'NUDGE');
    assert.equal(resBehind.targetRate, 0.96);
  });

  test('drift >= 40ms when paused triggers SNAP instead of NUDGE', () => {
    const engine = createSyncEngine('peerA');

    // Remote is paused at 10.1s, local is paused at 10.0s (100ms drift, in 40-400ms range)
    const res = engine.resolveRemote({
      type: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerB',
      paused: true,
      time: 10.1,
      rate: 1.0
    }, { paused: true, time: 10.0, rate: 1.0 }, 0, 2000);

    assert.equal(res.action, 'SNAP');
    assert.equal(res.targetPaused, true);
    assert.equal(res.targetRate, 1.0);
    assert.equal(res.targetTime, 10.1);
  });

  test('drift > 400ms triggers SNAP', () => {
    const engine = createSyncEngine('peerA');
    // Difference is 500ms (0.5s)
    const res = engine.resolveRemote({
      type: 'HEARTBEAT',
      seq: 1,
      peerId: 'peerB',
      paused: false,
      time: 10.5,
      rate: 1.0
    }, { paused: false, time: 10.0, rate: 1.0 }, 0, 2000);

    assert.equal(res.action, 'SNAP');
    assert.equal(res.targetTime, 10.5);
  });

  test('SEEK intent always snaps even when diff < 40ms', () => {
    const engine = createSyncEngine('peerA');
    // SEEK message with only 10ms diff
    const res = engine.resolveRemote({
      type: 'INTENT',
      action: 'SEEK',
      seq: 1,
      peerId: 'peerB',
      paused: false,
      time: 10.01,
      rate: 1.0
    }, { paused: false, time: 10.0, rate: 1.0 }, 0, 2000);

    assert.equal(res.action, 'SNAP');
  });
});
