/**
 * Lockstep P2P Video Synchronization Engine
 * Implements Lamport logical clock tie-breaking, intent-scoped echo guard,
 * RTT dead-reckoning, drift deadband/nudge/snap thresholds.
 */

export const ECHO_GUARD_MS = 300;
export const DRIFT_NOOP_MS = 40;
export const DRIFT_SNAP_MS = 400;
export const RATE_NUDGE_FACTOR = 0.04;

export function createSyncEngine(selfId) {
  let seq = 0;
  let seqOwner = '';
  let lastLocalIntent = null;

  return {
    getSeq() {
      return seq;
    },

    reset() {
      seq = 0;
      seqOwner = '';
      lastLocalIntent = null;
    },

    /**
     * Generate an intent message when the local user performs an action
     * (PLAY, PAUSE, SEEK, RATE).
     */
    localIntent(type, { paused = false, time = 0, rate = 1 } = {}, now = Date.now()) {
      seq += 1;
      seqOwner = selfId;
      const normPaused = Boolean(paused);
      const normTime = Number(time) || 0;
      const normRate = Number(rate) || 1;
      const normType = String(type || 'SEEK').toUpperCase();

      lastLocalIntent = {
        type: normType,
        action: normType,
        paused: normPaused,
        time: normTime,
        rate: normRate,
        timestamp: now,
        seq
      };

      return {
        type: 'INTENT',
        action: normType,
        seq,
        peerId: selfId,
        paused: normPaused,
        time: normTime,
        rate: normRate,
        timestamp: now
      };
    },

    /**
     * Generate a periodic heartbeat sync message.
     */
    localHeartbeat({ paused = false, time = 0, rate = 1 } = {}, now = Date.now()) {
      return {
        type: 'HEARTBEAT',
        action: 'HEARTBEAT',
        seq,
        peerId: selfId,
        paused: Boolean(paused),
        time: Number(time) || 0,
        rate: Number(rate) || 1,
        timestamp: now
      };
    },

    /**
     * Resolve an incoming remote message against local video state.
     * Evaluates echo guard, Lamport logical clock tie-break, dead-reckoning,
     * and returns the required player adjustment (NOOP, NUDGE, SNAP, IGNORE).
     */
    resolveRemote(msg, current = {}, rttMs = 0, now = Date.now()) {
      if (!msg || typeof msg !== 'object') {
        return { action: 'IGNORE', reason: 'invalid-msg', diff: 0 };
      }

      // Ignore direct self-messages
      if (msg.peerId === selfId) {
        return { action: 'IGNORE', reason: 'self-message', diff: 0 };
      }

      const msgSeq = Number(msg.seq) || 0;
      const msgPeerId = String(msg.peerId || '');
      const msgAction = String(msg.action || msg.type || '').toUpperCase();
      const msgPaused = Boolean(msg.paused);
      const isHeartbeat = msg.type === 'HEARTBEAT' || msgAction === 'HEARTBEAT';

      // 1. Intent-scoped 300ms Echo Guard
      // Blocks echo of our own action within 300ms, but passes opposite human actions
      if (lastLocalIntent && (now - lastLocalIntent.timestamp < ECHO_GUARD_MS)) {
        const localPaused = lastLocalIntent.paused;
        const isOppositeAction = (localPaused && !msgPaused) || (!localPaused && msgPaused);

        if (!isOppositeAction) {
          // If remote is not opposite, check if it's an echo of the local intent
          if (msgPaused === localPaused || msgAction === lastLocalIntent.action) {
            return { action: 'IGNORE', reason: 'echo-guard', diff: 0 };
          }
        }
      }

      // 2. Lamport [seq, peerId] Tie-break
      if (msgSeq < seq) {
        return { action: 'IGNORE', reason: 'stale-seq', diff: 0 };
      }
      if (msgSeq === seq) {
        if (isHeartbeat && seqOwner !== '') {
          // Leader heartbeat: accept ONLY if msgPeerId === seqOwner
          if (msgPeerId !== seqOwner) {
            return { action: 'IGNORE', reason: 'tie-break-lost', diff: 0 };
          }
        } else if (msgPeerId.localeCompare(seqOwner || selfId) <= 0) {
          return { action: 'IGNORE', reason: 'tie-break-lost', diff: 0 };
        }
      }

      // On accept: update leader/owner and advance Lamport clock
      if (msgSeq > seq || !isHeartbeat || !seqOwner) {
        seqOwner = msgPeerId;
        seq = Math.max(seq, msgSeq);
      }

      // 3. RTT Dead-reckoning
      const rtt = Math.max(0, Number(rttMs) || 0);
      const oneWaySec = (rtt / 2) / 1000;
      const remoteRate = Number(msg.rate) || 1;
      const remoteTime = Number(msg.time) || 0;
      const estimatedRemoteTime = msgPaused ? remoteTime : remoteTime + (oneWaySec * remoteRate);

      const currentTime = Number(current?.time) || 0;
      const currentPaused = Boolean(current?.paused);
      const diffSec = estimatedRemoteTime - currentTime;
      const diffMs = diffSec * 1000;
      const absDiffMs = Math.abs(diffMs);

      // 4. Decision: SNAP, NUDGE, or NOOP
      const isSeekIntent = msgAction === 'SEEK' || (!isHeartbeat && absDiffMs > DRIFT_SNAP_MS);

      if (isSeekIntent || absDiffMs > DRIFT_SNAP_MS) {
        return {
          action: 'SNAP',
          targetTime: estimatedRemoteTime,
          targetPaused: msgPaused,
          targetRate: remoteRate,
          diff: diffMs,
          pausedChanged: msgPaused !== currentPaused
        };
      }

      if (absDiffMs >= DRIFT_NOOP_MS && absDiffMs <= DRIFT_SNAP_MS) {
        if (msgPaused) {
          // Paused video cannot adjust drift via playback rate nudge -> SNAP immediately
          return {
            action: 'SNAP',
            targetTime: estimatedRemoteTime,
            targetPaused: true,
            targetRate: remoteRate,
            diff: diffMs,
            pausedChanged: msgPaused !== currentPaused
          };
        }

        // 40-400ms while playing: rate nudge +-4%
        // If remote is ahead (diffMs > 0), speed up by +4%
        // If remote is behind (diffMs < 0), slow down by -4%
        const nudgeMultiplier = diffMs > 0 ? (1 + RATE_NUDGE_FACTOR) : (1 - RATE_NUDGE_FACTOR);
        const nudgedRate = Number((remoteRate * nudgeMultiplier).toFixed(4));

        return {
          action: 'NUDGE',
          targetTime: estimatedRemoteTime,
          targetPaused: false,
          targetRate: nudgedRate,
          diff: diffMs,
          pausedChanged: msgPaused !== currentPaused
        };
      }

      // < 40ms: no-op
      return {
        action: 'NOOP',
        targetTime: estimatedRemoteTime,
        targetPaused: msgPaused,
        targetRate: remoteRate,
        diff: diffMs,
        pausedChanged: msgPaused !== currentPaused
      };
    }
  };
}
