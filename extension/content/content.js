// content.js - Runs in ISOLATED world at document_idle (all_frames: true).
// Zero DOM injection: handles video discovery, element picker, sync attachment, and remote sync.

(() => {
  if (typeof window !== 'undefined') {
    if (window.__lockstepContentLoaded) return;
    window.__lockstepContentLoaded = true;
  }

  let syncEngine = null;
  let currentEngineSelfId = null;
  let currentSyncVideo = null;
  let heartbeatInterval = null;
  let isApplyingRemote = false;
  let isPickerActive = false;
  let hoveredElement = null;
  let originalInlineStyles = null;
  let priorBodyCursor = '';
  let baseRate = 1;
  let isNudging = false;
  let videoListeners = null;
  const reportedVideos = new WeakSet();

  function sendMainCommand(action, detail = {}) {
    try {
      window.dispatchEvent(
        new CustomEvent('__lockstep_main', {
          detail: { action, ...detail }
        })
      );
    } catch {}
  }

  /**
   * Dynamically import createSyncEngine from web_accessible_resources
   */
  async function getSyncEngine(selfId) {
    if (!syncEngine || (selfId && currentEngineSelfId !== selfId)) {
      const resolvedId = selfId || currentEngineSelfId || ('content-' + Math.random().toString(36).slice(2, 9));
      currentEngineSelfId = resolvedId;
      if (typeof globalThis !== 'undefined' && typeof globalThis.__createSyncEngine === 'function') {
        syncEngine = globalThis.__createSyncEngine(resolvedId);
        return syncEngine;
      }
      try {
        const url = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
          ? chrome.runtime.getURL('shared/sync-engine.js')
          : '../shared/sync-engine.js';
        const mod = await import(url);
        const factory = mod.createSyncEngine || mod.default?.createSyncEngine || mod.default;
        if (typeof factory === 'function') {
          syncEngine = factory(resolvedId);
        }
      } catch (err) {
        console.warn('[Lockstep Content] Could not load sync engine:', err);
      }
    }
    return syncEngine;
  }

  /**
   * Recursively collect all videos from DOM and ShadowRoots
   */
  function collectVideos(root = document) {
    const list = [];
    if (!root || typeof root.querySelectorAll !== 'function') return list;

    const vids = root.querySelectorAll('video');
    for (let i = 0; i < vids.length; i++) {
      list.push(vids[i]);
    }

    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      let shadow = null;
      try {
        shadow = el.shadowRoot || (typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null);
      } catch {}
      if (shadow) {
        list.push(...collectVideos(shadow));
      }
    }
    return list;
  }

  /**
   * Filter out tiny ad videos (< 140px in either dimension)
   */
  function isValidVideo(video) {
    if (!video) return false;
    const rect = video.getBoundingClientRect();
    const w = rect.width || video.videoWidth || 0;
    const h = rect.height || video.videoHeight || 0;
    return w >= 140 && h >= 140;
  }

  /**
   * Select the primary video element based on valid dimensions and largest surface area
   */
  function getBestVideo() {
    const all = collectVideos();
    const valid = all.filter(isValidVideo);
    if (valid.length === 0) {
      return all[0] || null;
    }
    valid.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const areaA = (ra.width || a.videoWidth || 0) * (ra.height || a.videoHeight || 0);
      const areaB = (rb.width || b.videoWidth || 0) * (rb.height || b.videoHeight || 0);
      return areaB - areaA;
    });
    return valid[0];
  }

  /**
   * Pierce overlays/ad-shields via elementsFromPoint, ShadowRoots, and rect hit-tests
   */
  function findTargetUnderPointer(x, y) {
    // 1. Direct video bounding rect hit-test
    const allVids = collectVideos();
    for (let i = 0; i < allVids.length; i++) {
      const v = allVids[i];
      const r = v.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return v;
      }
    }

    // 2. elementsFromPoint and pierce shadow roots
    let elements = [];
    if (typeof document.elementsFromPoint === 'function') {
      elements = document.elementsFromPoint(x, y) || [];
    }

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.tagName === 'VIDEO') return el;
      if (typeof el.querySelector === 'function') {
        const innerV = el.querySelector('video');
        if (innerV) return innerV;
      }

      let shadow = null;
      try {
        shadow = el.shadowRoot || (typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null);
      } catch {}

      if (shadow) {
        if (typeof shadow.elementsFromPoint === 'function') {
          const sEls = shadow.elementsFromPoint(x, y) || [];
          for (let j = 0; j < sEls.length; j++) {
            if (sEls[j].tagName === 'VIDEO') return sEls[j];
            if (typeof sEls[j].querySelector === 'function') {
              const sv = sEls[j].querySelector('video');
              if (sv) return sv;
            }
          }
        }
        if (typeof shadow.querySelector === 'function') {
          const sv = shadow.querySelector('video');
          if (sv) return sv;
        }
      }
    }

    // 3. Fallback to player iframe in top frame
    if (window === window.top) {
      for (let i = 0; i < elements.length; i++) {
        if (elements[i].tagName === 'IFRAME') {
          return elements[i];
        }
      }
      const iframes = document.querySelectorAll('iframe');
      for (let i = 0; i < iframes.length; i++) {
        const f = iframes[i];
        const r = f.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return f;
        }
      }
    }

    return elements[0] || null;
  }

  /**
   * Highlight hovered element ONLY via temporary inline style
   */
  function applyHighlight(el) {
    if (hoveredElement === el) return;
    restoreHighlight();
    if (!el || !el.style) return;

    hoveredElement = el;
    originalInlineStyles = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      cursor: el.style.cursor
    };

    el.style.outline = '3px solid #10b981';
    el.style.outlineOffset = '-3px';
    el.style.cursor = 'crosshair';
  }

  function restoreHighlight() {
    if (hoveredElement && originalInlineStyles) {
      hoveredElement.style.outline = originalInlineStyles.outline;
      hoveredElement.style.outlineOffset = originalInlineStyles.outlineOffset;
      hoveredElement.style.cursor = originalInlineStyles.cursor;
    }
    hoveredElement = null;
    originalInlineStyles = null;
  }

  function onPointerMove(e) {
    if (!isPickerActive) return;
    const target = findTargetUnderPointer(e.clientX, e.clientY);
    applyHighlight(target);
  }

  async function onPointerAction(e) {
    if (!isPickerActive) return;
    // Capture pointerdown + click to block pop-under ads
    e.preventDefault();
    e.stopImmediatePropagation();
    sendMainCommand('suppressPopups', { duration: 600 });

    const target = hoveredElement || findTargetUnderPointer(e.clientX, e.clientY);
    await pickTarget(target);
  }

  function onKeyDown(e) {
    if (!isPickerActive) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopImmediatePropagation();
      stopPicker();
    }
  }

  function startPicker() {
    if (isPickerActive) return;
    isPickerActive = true;
    if (document.body) {
      priorBodyCursor = document.body.style.cursor || '';
      document.body.style.cursor = 'crosshair';
    }
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', onPointerAction, true);
    window.addEventListener('click', onPointerAction, true);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function stopPicker() {
    if (!isPickerActive) return;
    isPickerActive = false;
    restoreHighlight();
    if (document.body) {
      document.body.style.cursor = priorBodyCursor;
      priorBodyCursor = '';
    }
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerAction, true);
    window.removeEventListener('click', onPointerAction, true);
    window.removeEventListener('keydown', onKeyDown, true);
  }

  async function pickTarget(target) {
    stopPicker();

    // 500ms capture-phase blocker on mouseup + click to swallow release after pointerdown
    const blockRelease = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('mouseup', blockRelease, true);
    window.addEventListener('click', blockRelease, true);
    setTimeout(() => {
      window.removeEventListener('mouseup', blockRelease, true);
      window.removeEventListener('click', blockRelease, true);
    }, 500);

    let video = null;
    if (target) {
      if (target.tagName === 'VIDEO') {
        video = target;
      } else if (typeof target.querySelector === 'function') {
        video = target.querySelector('video');
      }
    }
    if (!video) {
      video = getBestVideo();
    }

    let state = { paused: true, time: 0, rate: 1 };
    let duration = 0;
    let area = 0;
    let frameOrigin = window.location.origin;

    if (video) {
      state = {
        paused: Boolean(video.paused),
        time: Number(video.currentTime) || 0,
        rate: Number(video.playbackRate) || 1
      };
      duration = Number(video.duration) || 0;
      const rect = video.getBoundingClientRect();
      area = (rect.width || video.videoWidth || 0) * (rect.height || video.videoHeight || 0);
    } else if (target && target.tagName === 'IFRAME') {
      try {
        if (target.src) {
          frameOrigin = new URL(target.src, window.location.href).origin;
        }
      } catch {}
    }

    try {
      const response = await chrome.runtime.sendMessage({
        target: 'sw',
        type: 'VIDEO_PICKED',
        frameOrigin,
        state,
        duration,
        area,
        hasVideo: Boolean(video)
      });

      if (response && response.copyInvite && response.inviteUrl) {
        if (typeof navigator.clipboard?.writeText === 'function') {
          try {
            await navigator.clipboard.writeText(response.inviteUrl);
          } catch {}
        }
      }
    } catch {}
  }

  /**
   * Top-frame multi-source hint detection (e.g. aniwaves.ru mirrors)
   */
  function getSourceHint() {
    if (window !== window.top) return '';

    const activeSelectors = [
      '.servers .btn.active',
      '.server.active',
      '[data-server].active',
      '.server-item.active',
      '[data-server-id].active',
      '.server-item.selected',
      '.servers li.active',
      '[class*="server"][class*="active"]',
      '[aria-selected="true"][data-server]'
    ].join(', ');

    const activeBtn = document.querySelector(activeSelectors);
    if (activeBtn) {
      const hint = activeBtn.getAttribute('data-server') ||
                   activeBtn.getAttribute('data-server-id') ||
                   activeBtn.getAttribute('data-id') ||
                   activeBtn.textContent?.trim();
      if (hint) return hint;
    }

    const allBtns = document.querySelectorAll('[data-server], [data-server-id], .server-item, .servers .btn');
    for (let i = 0; i < allBtns.length; i++) {
      const btn = allBtns[i];
      if (btn.classList.contains('active') || btn.classList.contains('selected') || btn.getAttribute('aria-selected') === 'true') {
        const hint = btn.getAttribute('data-server') || btn.getAttribute('data-server-id') || btn.textContent?.trim();
        if (hint) return hint;
      }
    }

    const iframe = document.querySelector('iframe#iframe-embed, iframe[src*="embed"], iframe.player, #player iframe, iframe');
    if (iframe && iframe.src) {
      try {
        return new URL(iframe.src, window.location.href).origin;
      } catch {}
    }

    return '';
  }

  function applySourceHint(sourceHint) {
    if (!sourceHint || window !== window.top) return false;
    const targetLower = String(sourceHint).toLowerCase().trim();

    const candidates = Array.from(document.querySelectorAll('[data-server], [data-server-id], [data-id], .server, .server-item, .servers .btn, button, a'));
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const ds = (el.getAttribute('data-server') || '').toLowerCase().trim();
      const dsId = (el.getAttribute('data-server-id') || '').toLowerCase().trim();
      const dId = (el.getAttribute('data-id') || '').toLowerCase().trim();
      const txt = (el.textContent || '').toLowerCase().trim();

      if (ds === targetLower || dsId === targetLower || dId === targetLower || txt === targetLower) {
        el.click();
        return true;
      }
    }

    try {
      const host = new URL(sourceHint).hostname.toLowerCase();
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        const txt = (el.textContent || '').toLowerCase();
        const ds = (el.getAttribute('data-server') || '').toLowerCase();
        if (txt.includes(host) || ds.includes(host)) {
          el.click();
          return true;
        }
      }
    } catch {}

    return false;
  }

  /**
   * Observe video mount and loadedmetadata to notify SW
   */
  function reportVideoReady(video) {
    if (!isValidVideo(video) || reportedVideos.has(video)) return;
    reportedVideos.add(video);

    const rect = video.getBoundingClientRect();
    const w = rect.width || video.videoWidth || 0;
    const h = rect.height || video.videoHeight || 0;
    const area = w * h;

    chrome.runtime.sendMessage({
      target: 'sw',
      type: 'VIDEO_READY',
      frameOrigin: window.location.origin,
      duration: Number(video.duration) || 0,
      area,
      state: getVideoState(video)
    }).catch(() => {});
  }

  function initVideoObserver() {
    const existing = collectVideos();
    for (let i = 0; i < existing.length; i++) {
      const v = existing[i];
      reportVideoReady(v);
      v.addEventListener('loadedmetadata', () => reportVideoReady(v), { passive: true });
      v.addEventListener('resize', () => reportVideoReady(v), { passive: true });
    }

    if (typeof MutationObserver !== 'undefined' && (document.documentElement || document.body)) {
      const obs = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          for (let j = 0; j < m.addedNodes.length; j++) {
            const node = m.addedNodes[j];
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'VIDEO') {
              reportVideoReady(node);
              node.addEventListener('loadedmetadata', () => reportVideoReady(node), { passive: true });
            } else if (typeof node.querySelectorAll === 'function') {
              const innerVids = collectVideos(node);
              for (let k = 0; k < innerVids.length; k++) {
                const iv = innerVids[k];
                reportVideoReady(iv);
                iv.addEventListener('loadedmetadata', () => reportVideoReady(iv), { passive: true });
              }
            }
          }
        }
      });

      obs.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
    }
  }

  function getVideoState(video = currentSyncVideo) {
    if (!video) return { paused: true, time: 0, rate: 1 };
    const rate = (video === currentSyncVideo && isNudging)
      ? baseRate
      : (Number(video.playbackRate) || 1);
    return {
      paused: Boolean(video.paused),
      time: Number(video.currentTime) || 0,
      rate
    };
  }

  async function safePlay(video) {
    if (!video) return;
    try {
      await video.play();
    } catch (err) {
      const isNotAllowed = err?.name === 'NotAllowedError' || String(err).includes('NotAllowedError');
      if (isNotAllowed) {
        try {
          video.muted = true;
          await video.play();
          chrome.runtime.sendMessage({
            target: 'sw',
            type: 'AUTOPLAY_MUTED',
            muted: true
          }).catch(() => {});

          const unmuteOnInteraction = () => {
            video.muted = false;
            chrome.runtime.sendMessage({
              target: 'sw',
              type: 'AUTOPLAY_MUTED',
              muted: false
            }).catch(() => {});
          };

          window.addEventListener('pointerdown', unmuteOnInteraction, { once: true, capture: true });
          window.addEventListener('keydown', unmuteOnInteraction, { once: true, capture: true });
        } catch (muteErr) {
          console.warn('[Lockstep Content] Fallback muted play failed:', muteErr);
        }
      }
    }
  }

  function triggerFacadePlayIfUnstarted(video) {
    if (!video) return;
    const isUnstarted = video.paused && (video.currentTime === 0 || video.readyState < 2);
    if (!isUnstarted) return;

    const facadeSelectors = [
      '.jw-display-icon-display',
      '.plyr__control--overlaid',
      '.vjs-big-play-button',
      '[class*="play-btn"]',
      'button[class*="play"]',
      '[aria-label*="Play" i]'
    ].join(', ');

    const btn = document.querySelector(facadeSelectors);
    if (btn) {
      // 500ms popup suppression via MAIN world CustomEvent
      sendMainCommand('suppressPopups', { duration: 500 });
      btn.click();
    }
  }

  function sendLocalSyncMsg(msg) {
    if (!msg) return;
    chrome.runtime.sendMessage({
      target: 'sw',
      ...msg,
      type: 'LOCAL_SYNC_MSG',
      msg,
      payload: msg
    }).catch(() => {});
  }

  async function attachSync(selfId, initialState = null) {
    detachSync();

    currentSyncVideo = getBestVideo();
    if (!currentSyncVideo) {
      return { ok: false, error: 'no_video' };
    }

    triggerFacadePlayIfUnstarted(currentSyncVideo);

    const engine = await getSyncEngine(selfId);

    if (initialState && typeof initialState === 'object') {
      isApplyingRemote = true;
      try {
        if (typeof initialState.time === 'number') {
          currentSyncVideo.currentTime = initialState.time;
          sendMainCommand('seek', { time: initialState.time });
        }
        if (typeof initialState.rate === 'number' && initialState.rate > 0) {
          baseRate = initialState.rate;
          currentSyncVideo.playbackRate = initialState.rate;
        }
        if (initialState.paused === false) {
          await safePlay(currentSyncVideo);
          sendMainCommand('play');
        } else if (initialState.paused === true) {
          currentSyncVideo.pause();
          sendMainCommand('pause');
        }
      } catch {}
      setTimeout(() => {
        isApplyingRemote = false;
      }, 50);
    }

    const onPlay = () => {
      if (isApplyingRemote) return;
      const msg = engine?.localIntent('PLAY', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
    };

    const onPause = () => {
      if (isApplyingRemote) return;
      const msg = engine?.localIntent('PAUSE', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
    };

    const onSeeking = () => {
      if (isApplyingRemote) return;
      const msg = engine?.localIntent('SEEK', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
    };

    const onRateChange = () => {
      if (isApplyingRemote || isNudging) return;
      baseRate = Number(currentSyncVideo.playbackRate) || 1;
      const msg = engine?.localIntent('RATE', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
    };

    currentSyncVideo.addEventListener('play', onPlay);
    currentSyncVideo.addEventListener('pause', onPause);
    currentSyncVideo.addEventListener('seeking', onSeeking);
    currentSyncVideo.addEventListener('ratechange', onRateChange);

    videoListeners = { onPlay, onPause, onSeeking, onRateChange, video: currentSyncVideo };

    // 2s periodic heartbeat
    heartbeatInterval = setInterval(() => {
      if (currentSyncVideo && engine) {
        const msg = engine.localHeartbeat(getVideoState(), Date.now());
        sendLocalSyncMsg(msg);
      }
    }, 2000);

    return { ok: true, state: getVideoState(), duration: currentSyncVideo.duration || 0 };
  }

  function detachSync() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    if (videoListeners && videoListeners.video) {
      const v = videoListeners.video;
      v.removeEventListener('play', videoListeners.onPlay);
      v.removeEventListener('pause', videoListeners.onPause);
      v.removeEventListener('seeking', videoListeners.onSeeking);
      v.removeEventListener('ratechange', videoListeners.onRateChange);
      videoListeners = null;
    }

    if (syncEngine && typeof syncEngine.reset === 'function') {
      syncEngine.reset();
    }

    currentSyncVideo = null;
    isApplyingRemote = false;
    baseRate = 1;
    isNudging = false;
    return { ok: true };
  }

  async function handleRemoteSync(message) {
    if (!currentSyncVideo) {
      currentSyncVideo = getBestVideo();
    }
    if (!currentSyncVideo) {
      return { ok: false, error: 'no_video' };
    }

    const engine = await getSyncEngine();
    if (!engine) {
      return { ok: false, error: 'no_engine' };
    }

    const rawMsg = message.msg || message.payload || message;
    const rttMs = Number(message.rttMs) || 0;

    const resolution = engine.resolveRemote(rawMsg, getVideoState(), rttMs, Date.now());
    if (!resolution || resolution.action === 'IGNORE') {
      return { ok: true, action: 'IGNORE' };
    }

    if (typeof rawMsg.rate === 'number' && !isNaN(rawMsg.rate) && rawMsg.rate > 0) {
      baseRate = rawMsg.rate;
    }

    isApplyingRemote = true;
    try {
      if (resolution.pausedChanged) {
        if (resolution.targetPaused) {
          currentSyncVideo.pause();
        } else {
          await safePlay(currentSyncVideo);
        }
      }

      if (resolution.action === 'SNAP') {
        if (typeof resolution.targetTime === 'number') {
          currentSyncVideo.currentTime = resolution.targetTime;
        }
        isNudging = false;
        currentSyncVideo.playbackRate = typeof resolution.targetRate === 'number' ? resolution.targetRate : baseRate;
      } else if (resolution.action === 'NUDGE') {
        isNudging = true;
        if (typeof resolution.targetRate === 'number') {
          currentSyncVideo.playbackRate = resolution.targetRate;
        }
      } else if (resolution.action === 'NOOP') {
        currentSyncVideo.playbackRate = baseRate;
        isNudging = false;
      }

      if (resolution.action === 'SNAP' && typeof resolution.targetTime === 'number') {
        sendMainCommand('seek', { time: resolution.targetTime });
      }
      if (resolution.pausedChanged) {
        sendMainCommand(resolution.targetPaused ? 'pause' : 'play');
      }
    } finally {
      setTimeout(() => {
        isApplyingRemote = false;
      }, 50);
    }

    return { ok: true, resolution };
  }

  // Runtime message router
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false;

      const { type } = message;

      if (type === 'START_PICKER') {
        startPicker();
        sendResponse({ ok: true, active: true });
        return false;
      }

      if (type === 'CANCEL_PICKER') {
        stopPicker();
        sendResponse({ ok: true, active: false });
        return false;
      }

      if (type === 'GET_SOURCE_HINT') {
        const hint = getSourceHint();
        sendResponse({ ok: true, sourceHint: hint });
        return false;
      }

      if (type === 'APPLY_SOURCE_HINT') {
        const hint = message.sourceHint || message.hint;
        const applied = applySourceHint(hint);
        sendResponse({ ok: true, applied });
        return false;
      }

      if (type === 'ATTACH_SYNC') {
        attachSync(message.selfId || message.peerId, message.initialState).then(sendResponse);
        return true; // async
      }

      if (type === 'REMOTE_SYNC') {
        handleRemoteSync(message).then(sendResponse);
        return true; // async
      }

      if (type === 'REQUEST_STATE_SNAPSHOT') {
        const video = currentSyncVideo || getBestVideo();
        sendResponse({
          ok: true,
          hasVideo: Boolean(video),
          state: getVideoState(video),
          duration: video?.duration || 0
        });
        return false;
      }

      if (type === 'SCAN_VIDEOS') {
        const video = getBestVideo();
        if (video) {
          const rect = video.getBoundingClientRect();
          const w = rect.width || video.videoWidth || 0;
          const h = rect.height || video.videoHeight || 0;
          chrome.runtime.sendMessage({
            target: 'sw',
            type: 'VIDEO_READY',
            frameOrigin: window.location.origin,
            duration: Number(video.duration) || 0,
            area: w * h,
            state: getVideoState(video)
          }).catch(() => {});
        }
        sendResponse({ ok: true, found: Boolean(video) });
        return false;
      }

      if (type === 'EMIT_RESYNC_INTENT') {
        (async () => {
          const video = currentSyncVideo || getBestVideo();
          const engine = await getSyncEngine(message.selfId);
          const state = getVideoState(video);
          const intent = (video && engine) ? engine.localIntent('SEEK', state, Date.now()) : null;
          sendResponse({
            ok: Boolean(intent),
            hasVideo: Boolean(video),
            state,
            duration: video?.duration || 0,
            intent
          });
        })();
        return true; // async
      }

      if (type === 'DETACH_SYNC') {
        const res = detachSync();
        sendResponse(res);
        return false;
      }

      return false;
    });
  }

  // Initialize observer
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initVideoObserver, { once: true });
    } else {
      initVideoObserver();
    }
  }
})();
