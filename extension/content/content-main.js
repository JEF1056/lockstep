// content-main.js - Runs in MAIN world at document_start (all_frames: true).
// Handles window.open popup suppression and Netflix Cadmium player controls via CustomEvents.
// STRICT: ZERO DOM injection into websites.

(() => {
  if (typeof window !== 'undefined') {
    if (window.__lockstepMainLoaded) return;
    window.__lockstepMainLoaded = true;
  }

  let origOpen = null;
  let suppressTimer = null;

  function suppressPopups(duration = 500) {
    if (!origOpen) {
      origOpen = window.open;
    }
    // shortcut: temporary no-op stub to prevent pop-under ads during facade clicks, restore on timer
    window.open = function () {
      return null;
    };
    if (suppressTimer) {
      clearTimeout(suppressTimer);
    }
    suppressTimer = setTimeout(() => {
      if (origOpen) {
        window.open = origOpen;
        origOpen = null;
      }
      suppressTimer = null;
    }, duration);
  }

  function getCadmiumPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      if (!api) return null;
      const sessionIds = typeof api.getAllPlayerSessionIds === 'function' ? api.getAllPlayerSessionIds() : [];
      if (sessionIds && sessionIds.length > 0) {
        return api.getVideoPlayerBySessionId(sessionIds[sessionIds.length - 1]);
      }
      return api;
    } catch {
      return null;
    }
  }

  window.addEventListener('__lockstep_main', (evt) => {
    const detail = evt?.detail || {};
    const action = detail.action || detail.type || detail.cmd;
    const reqId = detail.requestId;

    let result = null;
    let ok = true;
    let error = null;

    try {
      if (action === 'suppressPopups' || detail.suppressPopups) {
        suppressPopups(detail.duration || 500);
        result = { suppressed: true };
      } else if (action === 'play' || action === 'netflix_play') {
        const p = getCadmiumPlayer();
        if (p && typeof p.play === 'function') {
          p.play();
          result = { played: true };
        } else {
          ok = false;
          error = 'Cadmium player not found or play not supported';
        }
      } else if (action === 'pause' || action === 'netflix_pause') {
        const p = getCadmiumPlayer();
        if (p && typeof p.pause === 'function') {
          p.pause();
          result = { paused: true };
        } else {
          ok = false;
          error = 'Cadmium player not found or pause not supported';
        }
      } else if (action === 'seek' || action === 'netflix_seek') {
        const p = getCadmiumPlayer();
        if (p && typeof p.seek === 'function') {
          let timeMs = detail.timeMs;
          if (timeMs === undefined && typeof detail.time === 'number') {
            timeMs = detail.time < 10000 ? Math.round(detail.time * 1000) : Math.round(detail.time);
          }
          p.seek(timeMs);
          result = { seeked: timeMs };
        } else {
          ok = false;
          error = 'Cadmium player not found or seek not supported';
        }
      } else if (action === 'getState' || action === 'netflix_state') {
        const p = getCadmiumPlayer();
        if (p) {
          const isPaused = typeof p.isPaused === 'function' ? p.isPaused() : Boolean(p.paused);
          const currTime = typeof p.getCurrentTime === 'function' ? p.getCurrentTime() / 1000 : 0;
          const dur = typeof p.getDuration === 'function' ? p.getDuration() / 1000 : 0;
          result = { paused: isPaused, time: currTime, duration: dur };
        } else {
          ok = false;
          error = 'Cadmium player not found';
        }
      } else {
        ok = false;
        error = `Unknown action: ${action}`;
      }
    } catch (err) {
      ok = false;
      error = err?.message || String(err);
    }

    if (reqId) {
      window.dispatchEvent(
        new CustomEvent('__lockstep_main_ack', {
          detail: { requestId: reqId, ok, result, error, action }
        })
      );
    }
  });
})();
