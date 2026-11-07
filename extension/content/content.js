// content.js - Runs in ISOLATED world at document_idle (all_frames: true).
// Zero DOM injection: handles video discovery, element picker, sync attachment, and remote sync.

(() => {
  if (typeof window !== 'undefined') {
    if (window.__lockstepIsAlive?.()) return;
    window.__lockstepTeardown?.();
    window.__lockstepContentLoaded = true;
  }

  let syncEngine = null;
  let currentEngineSelfId = null;
  let currentSyncVideo = null;
  let heartbeatInterval = null;
  let isApplyingRemote = false;
  let remoteGuardUntil = 0;
  let followerBootLock = false;
  let followerBootTimer = null;
  let isBuffering = false;
  let burstInterval = null;
  let burstTicks = 0;
  let isPickerActive = false;
  let pickerHost = null;
  let pickerShadow = null;
  let candidateEntries = [];
  let hoveredTarget = null;
  let priorDocCursor = null;
  let pickerInterval = null;
  let baseRate = 1;
  let isNudging = false;
  let videoListeners = null;
  let videoObserver = null;
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
   * Check if a video element is visible and large enough to be selectable (>= 120x80)
   */
  function isSelectableVideo(v) {
    if (!v || v.tagName !== 'VIDEO') return false;
    try {
      const rect = v.getBoundingClientRect();
      const w = rect.width || (rect.right - rect.left) || 0;
      const h = rect.height || (rect.bottom - rect.top) || 0;
      if (w < 120 || h < 80) return false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(v);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if an iframe is visible and large enough to be a player fallback (>= 240x135)
   */
  function isSelectableIframe(f) {
    if (!f || f.tagName !== 'IFRAME') return false;
    try {
      const rect = f.getBoundingClientRect();
      const w = rect.width || (rect.right - rect.left) || 0;
      const h = rect.height || (rect.bottom - rect.top) || 0;
      if (w < 240 || h < 135) return false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(f);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discover selectable targets: videos across document and shadow roots;
   * in top frame ONLY when 0 videos exist in top frame, fallback to player iframes.
   */
  function discoverSelectableTargets() {
    const allVideos = collectVideos();
    const selectableVideos = allVideos.filter(isSelectableVideo);
    if (selectableVideos.length > 0) {
      return selectableVideos;
    }
    if (typeof window !== 'undefined' && window === window.top && typeof document !== 'undefined') {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      return iframes.filter(isSelectableIframe);
    }
    return [];
  }

  /**
   * Pierce overlays/ad-shields via elementsFromPoint, ShadowRoots, and rect hit-tests.
   * Returns a valid selectable target, or null if pointer is not over a selectable candidate.
   * NEVER returns elements[0].
   */
  function findTargetUnderPointer(x, y) {
    const targets = discoverSelectableTargets();
    if (!targets.length) return null;

    function isPointInRect(el) {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      const r = el.getBoundingClientRect();
      const w = r.width || (r.right - r.left) || 0;
      const h = r.height || (r.bottom - r.top) || 0;
      return w > 0 && h > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    let elements = [];
    if (typeof document !== 'undefined' && typeof document.elementsFromPoint === 'function') {
      try {
        elements = document.elementsFromPoint(x, y) || [];
      } catch {}
    }

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (targets.includes(el) && isPointInRect(el)) return el;

      if (typeof el.querySelector === 'function') {
        try {
          const innerV = el.querySelector('video');
          if (innerV && targets.includes(innerV) && isPointInRect(innerV)) return innerV;
        } catch {}
      }

      let shadow = null;
      try {
        shadow = el.shadowRoot || (typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null);
      } catch {}
      if (shadow) {
        if (typeof shadow.elementsFromPoint === 'function') {
          try {
            const sEls = shadow.elementsFromPoint(x, y) || [];
            for (let j = 0; j < sEls.length; j++) {
              if (targets.includes(sEls[j]) && isPointInRect(sEls[j])) return sEls[j];
              if (typeof sEls[j].querySelector === 'function') {
                const sv = sEls[j].querySelector('video');
                if (sv && targets.includes(sv) && isPointInRect(sv)) return sv;
              }
            }
          } catch {}
        }
        if (typeof shadow.querySelectorAll === 'function') {
          try {
            const sVids = shadow.querySelectorAll('video');
            for (let j = 0; j < sVids.length; j++) {
              if (targets.includes(sVids[j]) && isPointInRect(sVids[j])) return sVids[j];
            }
          } catch {}
        }
      }
    }

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (isPointInRect(t)) return t;
    }

    return null;
  }

  function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const remSec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(remSec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function getTargetMetaText(target) {
    if (!target) return '';
    const parts = [];
    if (target.tagName === 'VIDEO') {
      const w = target.videoWidth || 0;
      const h = target.videoHeight || 0;
      if (h > 0) {
        const res = (h >= 2160 && w >= 3800) ? '4K' : (h >= 1440 ? '1440p' : (h >= 1080 ? '1080p' : (h >= 720 ? '720p' : `${h}p`)));
        parts.push(res);
      } else if (w > 0) {
        parts.push(`${w}w`);
      }
      const dur = formatDuration(target.duration);
      if (dur) parts.push(dur);
    }
    return parts.join(' • ');
  }

  function createLockstepMark(size = 14) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.style.display = 'block';
    svg.style.flexShrink = '0';

    const c1 = document.createElementNS(svgNS, 'circle');
    c1.setAttribute('cx', '8');
    c1.setAttribute('cy', '12');
    c1.setAttribute('r', '5');
    c1.setAttribute('stroke', '#00E5FF');
    c1.setAttribute('stroke-width', '2');
    svg.appendChild(c1);

    const c2 = document.createElementNS(svgNS, 'circle');
    c2.setAttribute('cx', '16');
    c2.setAttribute('cy', '12');
    c2.setAttribute('r', '5');
    c2.setAttribute('stroke', '#EC4899');
    c2.setAttribute('stroke-width', '2');
    svg.appendChild(c2);

    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', 'M12 9C13 9.8 13.6 10.8 13.6 12C13.6 13.2 13 14.2 12 15C11 14.2 10.4 13.2 10.4 12Z');
    p.setAttribute('fill', '#FBBF24');
    svg.appendChild(p);

    return svg;
  }

  function createCandidateCard(target) {
    const cardEl = document.createElement('div');
    cardEl.style.position = 'fixed';
    cardEl.style.boxSizing = 'border-box';
    cardEl.style.pointerEvents = 'none';
    cardEl.style.zIndex = '2147483647';
    cardEl.style.borderRadius = '6px';
    cardEl.style.border = '1.5px dashed rgba(0,229,255,0.65)';
    cardEl.style.background = 'rgba(9,9,11,0.16)';
    cardEl.style.boxShadow = 'none';
    cardEl.style.transition = 'border 90ms cubic-bezier(0.2,0,0,1), background 90ms cubic-bezier(0.2,0,0,1), box-shadow 90ms cubic-bezier(0.2,0,0,1)';

    const pillEl = document.createElement('div');
    pillEl.style.position = 'absolute';
    pillEl.style.top = '8px';
    pillEl.style.left = '8px';
    pillEl.style.display = 'inline-flex';
    pillEl.style.alignItems = 'center';
    pillEl.style.gap = '6px';
    pillEl.style.padding = '3px 8px';
    pillEl.style.background = '#09090B';
    pillEl.style.border = '1px solid #27272E';
    pillEl.style.borderRadius = '9999px';
    pillEl.style.boxSizing = 'border-box';
    pillEl.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    pillEl.style.pointerEvents = 'none';
    pillEl.style.userSelect = 'none';
    pillEl.style.transition = 'border 90ms cubic-bezier(0.2,0,0,1), background 90ms cubic-bezier(0.2,0,0,1), box-shadow 90ms cubic-bezier(0.2,0,0,1)';

    const dotEl = document.createElement('span');
    dotEl.style.width = '6px';
    dotEl.style.height = '6px';
    dotEl.style.borderRadius = '50%';
    dotEl.style.background = '#00E5FF';
    dotEl.style.flexShrink = '0';
    pillEl.appendChild(dotEl);

    let markEl = null;

    const labelEl = document.createElement('span');
    labelEl.style.color = '#FAFAFA';
    labelEl.style.fontSize = '11px';
    labelEl.style.fontWeight = '500';
    labelEl.style.lineHeight = '1';
    labelEl.textContent = target.tagName === 'IFRAME' ? 'Selectable player' : 'Selectable video';
    pillEl.appendChild(labelEl);

    const metaEl = document.createElement('span');
    metaEl.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    metaEl.style.fontSize = '10px';
    metaEl.style.color = '#A1A1AA';
    metaEl.style.borderLeft = '1px solid #27272E';
    metaEl.style.paddingLeft = '5px';
    metaEl.style.marginLeft = '2px';
    const metaText = getTargetMetaText(target);
    metaEl.textContent = metaText;
    metaEl.style.display = metaText ? 'inline' : 'none';
    pillEl.appendChild(metaEl);

    cardEl.appendChild(pillEl);

    return {
      target,
      cardEl,
      pillEl,
      dotEl,
      getMarkEl: () => {
        if (!markEl) markEl = createLockstepMark(14);
        return markEl;
      },
      labelEl,
      metaEl,
      isHovered: false
    };
  }

  function setEntryHovered(entry, isHovered) {
    if (entry.isHovered === isHovered) return;
    entry.isHovered = isHovered;

    if (isHovered) {
      entry.cardEl.style.border = '2px solid #00E5FF';
      entry.cardEl.style.background = 'linear-gradient(135deg, rgba(0,229,255,0.14), rgba(139,92,246,0.14))';
      entry.cardEl.style.boxShadow = 'inset 0 0 0 1px rgba(9,9,11,0.85), 0 0 24px rgba(0,229,255,0.28)';

      entry.pillEl.style.background = '#101014';
      entry.pillEl.style.border = '1px solid rgba(0,229,255,0.55)';
      entry.pillEl.style.boxShadow = '0 0 12px rgba(0,229,255,0.25)';

      entry.dotEl.remove();
      const mark = entry.getMarkEl();
      entry.pillEl.insertBefore(mark, entry.labelEl);

      entry.labelEl.textContent = 'Click to sync';
      entry.labelEl.style.color = '#00E5FF';
    } else {
      entry.cardEl.style.border = '1.5px dashed rgba(0,229,255,0.65)';
      entry.cardEl.style.background = 'rgba(9,9,11,0.16)';
      entry.cardEl.style.boxShadow = 'none';

      entry.pillEl.style.background = '#09090B';
      entry.pillEl.style.border = '1px solid #27272E';
      entry.pillEl.style.boxShadow = 'none';

      const mark = entry.getMarkEl();
      if (mark && mark.parentNode) mark.remove();
      entry.pillEl.insertBefore(entry.dotEl, entry.labelEl);

      entry.labelEl.textContent = entry.target.tagName === 'IFRAME' ? 'Selectable player' : 'Selectable video';
      entry.labelEl.style.color = '#FAFAFA';

      const metaText = getTargetMetaText(entry.target);
      entry.metaEl.textContent = metaText;
      entry.metaEl.style.display = metaText ? 'inline' : 'none';
    }
  }

  function updateCandidateRects() {
    if (!isPickerActive || !pickerShadow) return;
    const currentTargets = discoverSelectableTargets();

    // Remove entries that are no longer targets
    candidateEntries = candidateEntries.filter(entry => {
      if (!currentTargets.includes(entry.target)) {
        try { entry.cardEl.remove(); } catch {}
        return false;
      }
      return true;
    });

    // Add new entries or update existing
    for (let i = 0; i < currentTargets.length; i++) {
      const target = currentTargets[i];
      let entry = candidateEntries.find(e => e.target === target);
      if (!entry) {
        entry = createCandidateCard(target);
        candidateEntries.push(entry);
        pickerShadow.appendChild(entry.cardEl);
      }

      const rect = target.getBoundingClientRect();
      const w = rect.width || (rect.right - rect.left) || 0;
      const h = rect.height || (rect.bottom - rect.top) || 0;

      entry.cardEl.style.left = `${rect.left}px`;
      entry.cardEl.style.top = `${rect.top}px`;
      entry.cardEl.style.width = `${w}px`;
      entry.cardEl.style.height = `${h}px`;
      entry.cardEl.style.display = (w > 0 && h > 0) ? 'block' : 'none';

      if (!entry.isHovered) {
        const metaText = getTargetMetaText(target);
        entry.metaEl.textContent = metaText;
        entry.metaEl.style.display = metaText ? 'inline' : 'none';
      }
    }
  }

  function applyHighlight(target) {
    if (hoveredTarget === target) return;

    if (hoveredTarget) {
      const prevEntry = candidateEntries.find(e => e.target === hoveredTarget);
      if (prevEntry) setEntryHovered(prevEntry, false);
    }

    if (!target) {
      if (priorDocCursor !== null && document.documentElement) {
        document.documentElement.style.cursor = priorDocCursor;
      }
      priorDocCursor = null;
      hoveredTarget = null;
      return;
    }

    if (priorDocCursor === null && document.documentElement) {
      priorDocCursor = document.documentElement.style.cursor || '';
    }
    if (document.documentElement) {
      document.documentElement.style.cursor = 'pointer';
    }

    hoveredTarget = target;
    const entry = candidateEntries.find(e => e.target === target);
    if (entry) {
      setEntryHovered(entry, true);
    }
  }

  function onPointerMove(e) {
    if (!isPickerActive) return;
    const target = findTargetUnderPointer(e.clientX, e.clientY);
    applyHighlight(target);
  }

  async function onPointerAction(e) {
    if (!isPickerActive) return;
    const target = findTargetUnderPointer(e.clientX, e.clientY);
    if (target) {
      e.preventDefault();
      e.stopImmediatePropagation();
      sendMainCommand('suppressPopups', { duration: 600 });
      await pickTarget(target);
    } else {
      // Outside click: non-blocking, dismiss picker
      stopPicker();
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ target: 'sw', type: 'PICKER_DISMISSED' }).catch(() => {});
      }
    }
  }

  function onKeyDown(e) {
    if (!isPickerActive) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopImmediatePropagation();
      stopPicker();
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ target: 'sw', type: 'PICKER_DISMISSED' }).catch(() => {});
      }
    }
  }

  function onScrollOrResize() {
    if (!isPickerActive) return;
    updateCandidateRects();
  }

  function startPicker() {
    if (isPickerActive) return;
    isPickerActive = true;

    // Ephemeral closed Shadow-DOM overlay
    pickerHost = document.createElement('div');
    pickerHost.id = '__lockstep-picker-host';
    pickerHost.style.position = 'fixed';
    pickerHost.style.inset = '0';
    pickerHost.style.zIndex = '2147483647';
    pickerHost.style.pointerEvents = 'none';

    try {
      pickerShadow = pickerHost.attachShadow({ mode: 'closed' });
    } catch {
      pickerShadow = pickerHost;
    }

    const mountPoint = document.fullscreenElement || document.body || document.documentElement;
    if (mountPoint && typeof mountPoint.appendChild === 'function') {
      mountPoint.appendChild(pickerHost);
    }

    updateCandidateRects();

    pickerInterval = setInterval(updateCandidateRects, 400);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', onPointerAction, true);
    window.addEventListener('click', onPointerAction, true);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function stopPicker() {
    if (!isPickerActive && !pickerHost) return;
    isPickerActive = false;

    if (pickerInterval) {
      clearInterval(pickerInterval);
      pickerInterval = null;
    }

    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerAction, true);
    window.removeEventListener('click', onPointerAction, true);
    window.removeEventListener('keydown', onKeyDown, true);

    applyHighlight(null);
    candidateEntries = [];

    if (pickerHost) {
      try {
        pickerHost.remove();
      } catch {
        try { pickerHost.parentNode?.removeChild(pickerHost); } catch {}
      }
      pickerHost = null;
      pickerShadow = null;
    }
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
      state = getVideoState(video);
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
      v.addEventListener('canplay', () => reportVideoReady(v), { passive: true });
      v.addEventListener('playing', () => reportVideoReady(v), { passive: true });
      v.addEventListener('resize', () => reportVideoReady(v), { passive: true });
    }

    if (typeof MutationObserver !== 'undefined' && (document.documentElement || document.body)) {
      videoObserver = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          for (let j = 0; j < m.addedNodes.length; j++) {
            const node = m.addedNodes[j];
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'VIDEO') {
              reportVideoReady(node);
              node.addEventListener('loadedmetadata', () => reportVideoReady(node), { passive: true });
              node.addEventListener('canplay', () => reportVideoReady(node), { passive: true });
              node.addEventListener('playing', () => reportVideoReady(node), { passive: true });
              node.addEventListener('resize', () => reportVideoReady(node), { passive: true });
            } else if (typeof node.querySelectorAll === 'function') {
              const innerVids = collectVideos(node);
              for (let k = 0; k < innerVids.length; k++) {
                const iv = innerVids[k];
                reportVideoReady(iv);
                iv.addEventListener('loadedmetadata', () => reportVideoReady(iv), { passive: true });
                iv.addEventListener('canplay', () => reportVideoReady(iv), { passive: true });
                iv.addEventListener('playing', () => reportVideoReady(iv), { passive: true });
                iv.addEventListener('resize', () => reportVideoReady(iv), { passive: true });
              }
            }
          }
        }
      });

      videoObserver.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
    }
  }

  function getVideoState(video = currentSyncVideo) {
    if (!video) {
      return {
        paused: true,
        time: 0,
        rate: 1,
        seq: syncEngine?.getSeq?.() || 1,
        seqOwner: syncEngine?.getSeqOwner?.() || currentEngineSelfId || ''
      };
    }
    const rate = (video === currentSyncVideo && isNudging)
      ? baseRate
      : (Number(video.playbackRate) || 1);
    return {
      paused: Boolean(video.paused),
      time: Number(video.currentTime) || 0,
      rate,
      seq: syncEngine?.getSeq?.() || 1,
      seqOwner: syncEngine?.getSeqOwner?.() || currentEngineSelfId || ''
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

  const FACADE_PLAY_SELECTORS = [
    '.jw-display-icon-display',
    '.jw-icon-display',
    '.plyr__control--overlaid',
    '.vjs-big-play-button',
    '.art-state',
    '.dplayer-play-icon',
    '.ytp-large-play-button',
    '.ytp-cued-thumbnail-overlay-image',
    '[class*="big-play" i]',
    '[class*="play-overlay" i]',
    '[class*="poster-play" i]',
    '[class*="play-btn" i]',
    '[class*="btn-play" i]',
    '[class*="play-button" i]',
    'button[class*="play" i]',
    '[role="button"][aria-label*="Play" i]',
    '[aria-label*="Play video" i]',
    '[aria-label="Play" i]'
  ].join(', ');

  const POSTER_CONTAINER_SELECTORS = [
    '#player',
    '#video-player',
    '.video-player',
    '.player-container',
    '.video-poster',
    '[class*="player-poster" i]',
    '[class*="video-cover" i]'
  ].join(', ');

  function isSafePlayCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME') return false;
    if (el.tagName === 'A') {
      const href = el.getAttribute?.('href') || el.href || '';
      if (href && (href.startsWith('http') || href.startsWith('//') || el.target === '_blank')) {
        return false;
      }
    }
    const cls = (typeof el.className === 'string' ? el.className : el.getAttribute?.('class')) || '';
    const aria = el.getAttribute?.('aria-label') || '';
    const title = el.getAttribute?.('title') || el.title || '';
    const combined = `${cls} ${aria} ${title}`;
    if (/pause|mute|unmute|volume|fullscreen|pip|settings|subtitles|captions|next|prev|previous|close|dismiss|download|share/i.test(combined)) {
      return false;
    }
    if (typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) {
          return false;
        }
      } catch {}
    }
    if (typeof el.getBoundingClientRect === 'function') {
      try {
        const rect = el.getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
          if (rect.width < 16 || rect.height < 16) {
            return false;
          }
        }
      } catch {}
    }
    return true;
  }

  function findFacadePlayElement(video) {
    let candidates = [];
    try {
      if (typeof document.querySelectorAll === 'function') {
        const list = document.querySelectorAll(FACADE_PLAY_SELECTORS);
        if (list && list.length > 0) candidates = Array.from(list);
      }
      if (candidates.length === 0 && typeof document.querySelector === 'function') {
        const single = document.querySelector(FACADE_PLAY_SELECTORS);
        if (single) candidates = [single];
      }
    } catch {}

    for (const el of candidates) {
      if (isSafePlayCandidate(el)) {
        return el;
      }
    }

    if (!video) {
      let containers = [];
      try {
        if (typeof document.querySelectorAll === 'function') {
          const list = document.querySelectorAll(POSTER_CONTAINER_SELECTORS);
          if (list && list.length > 0) containers = Array.from(list);
        }
        if (containers.length === 0 && typeof document.querySelector === 'function') {
          const c = document.querySelector(POSTER_CONTAINER_SELECTORS);
          if (c) containers = [c];
        }
      } catch {}

      for (const container of containers) {
        if (!container || container.nodeType !== 1) continue;
        if (container.tagName === 'A') continue;
        if (typeof container.querySelector === 'function' && container.querySelector('iframe')) continue;
        if (typeof window.getComputedStyle === 'function') {
          try {
            const style = window.getComputedStyle(container);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
          } catch {}
        }
        let rect = null;
        if (typeof container.getBoundingClientRect === 'function') {
          try {
            rect = container.getBoundingClientRect();
          } catch {}
        }
        if (rect && (rect.width > 0 || rect.height > 0)) {
          if (rect.width < 200 || rect.height < 120) continue;
        }
        let target = container;
        if (rect && rect.width > 0 && rect.height > 0 && typeof document.elementFromPoint === 'function') {
          const cx = Math.floor(rect.left + rect.width / 2);
          const cy = Math.floor(rect.top + rect.height / 2);
          try {
            const hit = document.elementFromPoint(cx, cy);
            if (hit && hit.tagName !== 'A' && !hit.closest?.('a')) {
              target = hit;
            }
          } catch {}
        }
        if (target.tagName !== 'A' && !target.closest?.('a')) {
          return target;
        }
      }
    }

    return null;
  }

  function dispatchSyntheticActivate(el) {
    if (!el) return;
    if (typeof window.MouseEvent === 'function') {
      const PointerCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
      const MouseCtor = window.MouseEvent;
      const opts = { bubbles: true, cancelable: true, view: window };
      try {
        el.dispatchEvent(new PointerCtor('pointerdown', opts));
        el.dispatchEvent(new MouseCtor('mousedown', opts));
        el.dispatchEvent(new PointerCtor('pointerup', opts));
        el.dispatchEvent(new MouseCtor('mouseup', opts));
      } catch {}
    }

    if (typeof el.click === 'function') {
      el.click();
    } else if (typeof window.MouseEvent === 'function') {
      try {
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
  }

  let autoActivateHref = '';
  let autoActivateAttempts = 0;
  let lastAutoActivateTime = 0;

  function isVideoUnstarted(v) {
    if (!v) return true;
    return Boolean(v.paused) && (
      (typeof v.readyState === 'number' ? v.readyState < 2 : false) ||
      (Number(v.currentTime) || 0) === 0 ||
      (!v.currentSrc && !v.src)
    );
  }

  function autoActivateStream(video = null, { force = false } = {}) {
    if (video && !isVideoUnstarted(video)) {
      return false;
    }

    const currentHref = window.location?.href || '';
    if (currentHref !== autoActivateHref) {
      autoActivateHref = currentHref;
      autoActivateAttempts = 0;
    }

    const now = Date.now();
    if (!force) {
      if (autoActivateAttempts >= 5) return false;
      if (now - lastAutoActivateTime < 700) return false;
    }

    lastAutoActivateTime = now;
    autoActivateAttempts += 1;

    sendMainCommand('suppressPopups', { duration: 1000 });
    sendMainCommand('activatePlayer', { duration: 1000 });

    const facadeEl = findFacadePlayElement(video);
    if (facadeEl) {
      dispatchSyntheticActivate(facadeEl);
    }

    if (
      video &&
      typeof video.readyState === 'number' &&
      video.readyState === 0 &&
      video.preload === 'none' &&
      (video.currentSrc || video.getAttribute?.('src')) &&
      typeof video.load === 'function'
    ) {
      try {
        video.load();
      } catch {}
    }

    return true;
  }

  function triggerFacadePlayIfUnstarted(video) {
    return autoActivateStream(video);
  }

  function onTrustedUserInteraction(e) {
    if (e && e.isTrusted === false) return;
    remoteGuardUntil = 0;
    isApplyingRemote = false;
    if (followerBootLock) {
      followerBootLock = false;
      if (followerBootTimer) {
        clearTimeout(followerBootTimer);
        followerBootTimer = null;
      }
    }
  }

  function triggerFastBurst(engine) {
    if (burstInterval) {
      clearInterval(burstInterval);
      burstInterval = null;
    }
    burstTicks = 0;
    burstInterval = setInterval(() => {
      burstTicks += 1;
      if (burstTicks > 6 || !currentSyncVideo || !engine) {
        clearInterval(burstInterval);
        burstInterval = null;
        return;
      }
      if (!isBuffering && !followerBootLock && Date.now() >= remoteGuardUntil) {
        const msg = engine.localHeartbeat(getVideoState(), Date.now());
        sendLocalSyncMsg(msg);
      }
    }, 300);
  }

  function sendLocalSyncMsg(msg) {
    if (!msg || followerBootLock) return;
    chrome.runtime.sendMessage({
      target: 'sw',
      ...msg,
      type: 'LOCAL_SYNC_MSG',
      msg,
      payload: msg
    }).catch(() => {});
  }

  async function applyInitialState(video, initState, rttMs = 0, clockOffsetMs = null) {
    if (!video || !initState || typeof initState !== 'object') return;
    const t0 = Date.now();

    const doApply = async (useElapsed = false) => {
      remoteGuardUntil = Date.now() + 380;
      isApplyingRemote = true;

      let transitSec;
      if (typeof clockOffsetMs === 'number' && Number.isFinite(clockOffsetMs) && initState.timestamp > 0) {
        transitSec = Math.max(0, Math.min(2.0, ((Date.now() + clockOffsetMs) - Number(initState.timestamp)) / 1000));
      } else {
        transitSec = (Math.max(0, Number(rttMs) || 0) / 2) / 1000;
      }
      const elapsed = useElapsed ? (Date.now() - t0) / 1000 : 0;
      const rate = (typeof initState.rate === 'number' && initState.rate > 0) ? initState.rate : 1;
      const targetTime = Number(initState.time || 0) + (initState.paused ? 0 : (elapsed + transitSec) * rate);

      try {
        baseRate = rate;
        video.playbackRate = rate;
        video.currentTime = targetTime;
        sendMainCommand('seek', { time: targetTime });

        if (initState.paused === false) {
          if (isVideoUnstarted(video)) {
            autoActivateStream(video);
          }
          await safePlay(video);
          sendMainCommand('play');
        } else if (initState.paused === true) {
          video.pause();
          sendMainCommand('pause');
        }
      } catch {}

      remoteGuardUntil = Date.now() + 380;
      setTimeout(() => {
        isApplyingRemote = false;
      }, 50);

      if (followerBootTimer) {
        clearTimeout(followerBootTimer);
      }
      followerBootTimer = setTimeout(() => {
        followerBootLock = false;
        followerBootTimer = null;
      }, 450);
    };

    if (typeof video.readyState === 'number' && video.readyState < 1) {
      video.addEventListener('loadedmetadata', () => {
        doApply(true);
      }, { once: true });

      if (video.readyState === 0) {
        remoteGuardUntil = Date.now() + 800;
        isApplyingRemote = true;
        autoActivateStream(video);
        if (initState.paused === false) {
          await safePlay(video);
        }
      }
    } else {
      await doApply(false);
    }
  }

  async function attachSync(selfId, initialState = null, options = {}) {
    detachSync();

    currentSyncVideo = getBestVideo();
    if (!currentSyncVideo) {
      return { ok: false, error: 'no_video' };
    }

    const engine = await getSyncEngine(selfId);

    const isHost = options.isHost !== undefined ? Boolean(options.isHost) : !initialState;

    if (isHost) {
      engine?.seed?.(Math.max(engine?.getSeq?.() || 0, 1), selfId);
      followerBootLock = false;
      triggerFacadePlayIfUnstarted(currentSyncVideo);
    } else {
      if (initialState?.seq) {
        engine?.seed?.(initialState.seq, initialState.seqOwner || '');
      }
      followerBootLock = true;
      if (initialState && typeof initialState === 'object') {
        await applyInitialState(currentSyncVideo, initialState, options.rttMs, options.clockOffsetMs);
      }
    }

    const onPlay = () => {
      isBuffering = false;
      if (Date.now() < remoteGuardUntil || isApplyingRemote || followerBootLock) return;
      const msg = engine?.localIntent('PLAY', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
      triggerFastBurst(engine);
    };

    const onPause = () => {
      isBuffering = false;
      if (Date.now() < remoteGuardUntil || isApplyingRemote || followerBootLock) return;
      const msg = engine?.localIntent('PAUSE', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
    };

    const onSeeking = () => {
      if (Date.now() < remoteGuardUntil || isApplyingRemote || followerBootLock) return;
      const msg = engine?.localIntent('SEEK', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
    };

    const onSeeked = () => {
      if (Date.now() < remoteGuardUntil || isApplyingRemote || followerBootLock) return;
      triggerFastBurst(engine);
    };

    const onRateChange = () => {
      if (Date.now() < remoteGuardUntil || isApplyingRemote || isNudging || followerBootLock) return;
      baseRate = Number(currentSyncVideo.playbackRate) || 1;
      const msg = engine?.localIntent('RATE', getVideoState(), Date.now());
      sendLocalSyncMsg(msg);
    };

    const onWaiting = () => {
      isBuffering = true;
    };

    const onPlaying = () => {
      isBuffering = false;
    };

    currentSyncVideo.addEventListener('play', onPlay);
    currentSyncVideo.addEventListener('pause', onPause);
    currentSyncVideo.addEventListener('seeking', onSeeking);
    currentSyncVideo.addEventListener('seeked', onSeeked);
    currentSyncVideo.addEventListener('ratechange', onRateChange);
    currentSyncVideo.addEventListener('waiting', onWaiting);
    currentSyncVideo.addEventListener('playing', onPlaying);

    window.addEventListener('pointerdown', onTrustedUserInteraction, true);
    window.addEventListener('keydown', onTrustedUserInteraction, true);

    videoListeners = {
      onPlay,
      onPause,
      onSeeking,
      onSeeked,
      onRateChange,
      onWaiting,
      onPlaying,
      video: currentSyncVideo
    };

    // 1000ms periodic heartbeat
    heartbeatInterval = setInterval(() => {
      if (currentSyncVideo && engine && !isBuffering && !followerBootLock) {
        const msg = engine.localHeartbeat(getVideoState(), Date.now());
        sendLocalSyncMsg(msg);
      }
    }, 1000);

    return { ok: true, state: getVideoState(), duration: currentSyncVideo.duration || 0 };
  }

  let pendingMetadataSnap = null;

  function detachSync() {
    if (pendingMetadataSnap && currentSyncVideo) {
      try {
        currentSyncVideo.removeEventListener('loadedmetadata', pendingMetadataSnap);
      } catch {}
      pendingMetadataSnap = null;
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (burstInterval) {
      clearInterval(burstInterval);
      burstInterval = null;
    }
    if (followerBootTimer) {
      clearTimeout(followerBootTimer);
      followerBootTimer = null;
    }

    if (videoListeners && videoListeners.video) {
      const v = videoListeners.video;
      v.removeEventListener('play', videoListeners.onPlay);
      v.removeEventListener('pause', videoListeners.onPause);
      v.removeEventListener('seeking', videoListeners.onSeeking);
      v.removeEventListener('seeked', videoListeners.onSeeked);
      v.removeEventListener('ratechange', videoListeners.onRateChange);
      v.removeEventListener('waiting', videoListeners.onWaiting);
      v.removeEventListener('playing', videoListeners.onPlaying);
      videoListeners = null;
    }

    try {
      window.removeEventListener('pointerdown', onTrustedUserInteraction, true);
      window.removeEventListener('keydown', onTrustedUserInteraction, true);
    } catch {}

    if (syncEngine && typeof syncEngine.reset === 'function') {
      syncEngine.reset();
    }

    currentSyncVideo = null;
    isApplyingRemote = false;
    remoteGuardUntil = 0;
    followerBootLock = false;
    isBuffering = false;
    baseRate = 1;
    isNudging = false;
    return { ok: true };
  }

  async function handleRemoteSync(message) {
    const rawMsg = message.msg || message.payload || message;
    if (!currentSyncVideo) {
      currentSyncVideo = getBestVideo();
    }
    if (!currentSyncVideo && rawMsg?.paused === false) {
      autoActivateStream(null);
      currentSyncVideo = getBestVideo();
    }
    if (!currentSyncVideo) {
      return { ok: false, error: 'no_video' };
    }

    const engine = await getSyncEngine();
    if (!engine) {
      return { ok: false, error: 'no_engine' };
    }

    const rttMs = Number(message.rttMs) || 0;
    const clockOffsetMs = (typeof message.clockOffsetMs === 'number') ? message.clockOffsetMs : null;

    const resolution = engine.resolveRemote(rawMsg, getVideoState(), rttMs, Date.now(), clockOffsetMs);
    if (!resolution || resolution.action === 'IGNORE') {
      return { ok: true, action: 'IGNORE' };
    }

    if (typeof rawMsg.rate === 'number' && !isNaN(rawMsg.rate) && rawMsg.rate > 0) {
      baseRate = rawMsg.rate;
    }

    isApplyingRemote = true;
    remoteGuardUntil = Date.now() + 380;
    try {
      if (resolution.pausedChanged) {
        if (resolution.targetPaused) {
          currentSyncVideo.pause();
        } else {
          if (currentSyncVideo.paused && isVideoUnstarted(currentSyncVideo)) {
            autoActivateStream(currentSyncVideo);
          }
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

      if (typeof currentSyncVideo.readyState === 'number' && currentSyncVideo.readyState < 1 && typeof resolution.targetTime === 'number') {
        const snapTime = resolution.targetTime;
        if (!pendingMetadataSnap) {
          pendingMetadataSnap = () => {
            try {
              if (currentSyncVideo) {
                currentSyncVideo.currentTime = snapTime;
                sendMainCommand('seek', { time: snapTime });
              }
            } catch {}
            pendingMetadataSnap = null;
          };
          currentSyncVideo.addEventListener('loadedmetadata', pendingMetadataSnap, { once: true });
        }
      }

      if (resolution.action === 'SNAP' && typeof resolution.targetTime === 'number') {
        sendMainCommand('seek', { time: resolution.targetTime });
      }
      if (resolution.pausedChanged) {
        sendMainCommand(resolution.targetPaused ? 'pause' : 'play');
      }
    } finally {
      remoteGuardUntil = Date.now() + 380;
      setTimeout(() => {
        isApplyingRemote = false;
      }, 50);
    }

    return { ok: true, resolution };
  }

  // Runtime message router
  const messageListener = (message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    const { type } = message;

    if (type === 'PING') {
      sendResponse({ ok: true, pong: true });
      return false;
    }

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
      attachSync(message.selfId || message.peerId, message.initialState, {
        isHost: message.isHost,
        rttMs: message.rttMs,
        clockOffsetMs: message.clockOffsetMs
      }).then(sendResponse);
      return true; // async
    }

    if (type === 'APPLY_INITIAL_STATE') {
      (async () => {
        let video = currentSyncVideo || getBestVideo();
        const engine = await getSyncEngine();
        const initState = message.state || message.initialState;
        if (initState && engine) {
          if (initState.seq) {
            engine.seed(initState.seq, initState.seqOwner || '');
          }
        }
        if (!video && initState) {
          autoActivateStream(null);
          video = currentSyncVideo || getBestVideo();
        }
        if (video && initState) {
          await applyInitialState(video, initState, message.rttMs, message.clockOffsetMs);
          if (followerBootTimer) clearTimeout(followerBootTimer);
          followerBootTimer = setTimeout(() => {
            followerBootLock = false;
            followerBootTimer = null;
          }, 450);
        } else {
          followerBootLock = true;
        }
        sendResponse({ ok: true, hasVideo: Boolean(video) });
      })();
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
      let video = getBestVideo();
      if (!video && message.autoStart) {
        autoActivateStream(null);
        video = getBestVideo();
      }
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
  };

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(messageListener);
  }

  const teardown = () => {
    try { stopPicker(); } catch {}
    try { detachSync(); } catch {}
    try { videoObserver?.disconnect(); } catch {}
    try {
      window.removeEventListener('pointerdown', onTrustedUserInteraction, true);
      window.removeEventListener('keydown', onTrustedUserInteraction, true);
    } catch {}
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.removeListener && messageListener) {
        chrome.runtime.onMessage.removeListener(messageListener);
      }
    } catch {}
  };

  if (typeof window !== 'undefined') {
    window.__lockstepIsAlive = () => {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime) return false;
        if ('id' in chrome.runtime) return Boolean(chrome.runtime.id);
        return true;
      } catch {
        return false;
      }
    };
    window.__lockstepTeardown = teardown;
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
