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
      videoObserver = new MutationObserver((mutations) => {
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

      videoObserver.observe(document.documentElement || document.body, {
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
  };

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(messageListener);
  }

  const teardown = () => {
    try { stopPicker(); } catch {}
    try { detachSync(); } catch {}
    try { videoObserver?.disconnect(); } catch {}
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
