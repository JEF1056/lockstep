// service-worker.js - Lockstep Background Controller
import {
  parseInviteUrl,
  buildInviteUrl,
  generatePairKey,
  canonicalizeVideoUrl,
  findMatchingTab
} from '../shared/url-match.js';

let offscreenCreating = null;

/**
 * Check if the offscreen document is currently active.
 */
async function hasOffscreenDocument() {
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    return await chrome.offscreen.hasDocument();
  }
  if (typeof chrome.runtime?.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return Boolean(contexts && contexts.length > 0);
  }
  return false;
}

/**
 * Promise-locked offscreen document manager (Reason: WEB_RTC).
 * Returns true if a fresh offscreen document was created.
 */
async function ensureOffscreen() {
  if (await hasOffscreenDocument()) {
    return false;
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return false;
  }

  let created = false;
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: [chrome.offscreen.Reason?.WEB_RTC || 'WEB_RTC'],
        justification: 'Maintain WebRTC Nostr signaling and peer-to-peer data channel for video sync'
      });
      created = true;
    } catch (err) {
      if (!err.message?.includes('Only a single offscreen document may be created')) {
        console.error('[Lockstep SW] createDocument error:', err);
      }
    } finally {
      offscreenCreating = null;
    }
  })();

  await offscreenCreating;
  return created;
}

/**
 * Joins an offscreen room and persists returned peerId.
 */
async function joinOffscreenRoom(pairKey) {
  if (!pairKey) return null;
  const resp = await sendToOffscreen({ type: 'JOIN_ROOM', pairKey });
  if (resp?.selfId) {
    await chrome.storage.local.set({ peerId: resp.selfId });
  }
  return resp;
}

/**
 * Send a message to the offscreen document safely.
 * Recovers room subscription if offscreen document was freshly created.
 */
async function sendToOffscreen(message) {
  try {
    const created = await ensureOffscreen();
    if (created && message?.type !== 'JOIN_ROOM') {
      const { pairKey } = await chrome.storage.local.get(['pairKey']);
      if (pairKey) {
        await joinOffscreenRoom(pairKey);
      }
    }
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: true });
        }
      });
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Updates extension action badge based on sync & muted state.
 */
async function updateBadge(activeSession, isMuted) {
  if (!activeSession) {
    await chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }
  if (isMuted) {
    await chrome.action.setBadgeText({ text: 'MUTE' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }).catch(() => {});
  } else {
    await chrome.action.setBadgeText({ text: 'LIVE' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#10b981' }).catch(() => {});
  }
}

/**
 * Session storage helpers with fallback.
 */
async function getSessionState() {
  if (chrome.storage?.session) {
    return await chrome.storage.session.get(['activeSession', 'peerOnline', 'rttMs', 'autoplayMuted']);
  }
  return {};
}

async function setSessionState(data) {
  if (chrome.storage?.session) {
    await chrome.storage.session.set(data);
  }
}

/**
 * Auto-harvest #pair invite tabs.
 */
async function harvestInviteUrl(tabId, url) {
  if (!url || url.includes('#paired=1')) return false;
  const parsed = parseInviteUrl(url);
  if (!parsed || !parsed.pairKey) return false;

  const pairKey = parsed.pairKey;
  await chrome.storage.local.set({ pairKey });
  await joinOffscreenRoom(pairKey);

  if (parsed.pageUrl) {
    // Signal paired state briefly on invite landing tab before setting activeSession / video navigation
    const baseUrl = url.split('#')[0];
    if (baseUrl) {
      const pairedUrl = `${baseUrl}#paired=1&pair=${encodeURIComponent(pairKey)}&url=${encodeURIComponent(parsed.pageUrl)}${parsed.sourceHint ? `&src=${encodeURIComponent(parsed.sourceHint)}` : ''}`;
      await chrome.tabs.update(tabId, { url: pairedUrl }).catch(() => {});
    }

    // Brief 900ms display of paired redirect screen
    await new Promise((resolve) => setTimeout(resolve, 900));

    // Check if an existing open tab already matches the video URL
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const candidateTabs = allTabs.filter((t) => t.id !== tabId);
    const existingTab = findMatchingTab(candidateTabs, parsed.pageUrl);

    let targetTabId;
    if (existingTab) {
      targetTabId = existingTab.id;
      if (existingTab.windowId) {
        await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(existingTab.id, { active: true }).catch(() => {});
      await chrome.tabs.remove(tabId).catch(() => {});
    } else {
      targetTabId = tabId;
      await chrome.tabs.update(tabId, { url: parsed.pageUrl, active: true }).catch(() => {});
      const tabObj = await chrome.tabs.get(tabId).catch(() => null);
      if (tabObj?.windowId) {
        await chrome.windows.update(tabObj.windowId, { focused: true }).catch(() => {});
      }
    }

    const activeSession = {
      tabId: targetTabId,
      frameId: null,
      isHost: false,
      area: 0,
      url: canonicalizeVideoUrl(parsed.pageUrl),
      pageUrl: parsed.pageUrl,
      sourceHint: parsed.sourceHint || null,
      initialState: null
    };

    await setSessionState({
      activeSession,
      autoplayMuted: false
    });
    await updateBadge(activeSession, false);

    const listener = (uTabId, uInfo) => {
      if (uTabId === targetTabId && uInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        if (parsed.sourceHint) {
          chrome.tabs.sendMessage(
            targetTabId,
            { target: 'content', type: 'APPLY_SOURCE_HINT', sourceHint: parsed.sourceHint },
            { frameId: 0 }
          ).catch(() => {});
        }
        chrome.tabs.sendMessage(
          targetTabId,
          { target: 'content', type: 'SCAN_VIDEOS' }
        ).catch(() => {});
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    if (existingTab) {
      if (parsed.sourceHint) {
        chrome.tabs.sendMessage(
          targetTabId,
          { target: 'content', type: 'APPLY_SOURCE_HINT', sourceHint: parsed.sourceHint },
          { frameId: 0 }
        ).catch(() => {});
      }
      chrome.tabs.sendMessage(
        targetTabId,
        { target: 'content', type: 'SCAN_VIDEOS' }
      ).catch(() => {});
    }
  } else {
    // If an invite tab has #pair without #url, update hash to #paired=1
    const baseUrl = url.split('#')[0];
    if (baseUrl) {
      await chrome.tabs.update(tabId, { url: `${baseUrl}#paired=1&pair=${encodeURIComponent(pairKey)}` }).catch(() => {});
    }
  }
  return true;
}

/**
 * Scans all open tabs on startup/installation for #pair invites.
 */
async function harvestAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && tab.url.includes('#pair') && !tab.url.includes('#paired=1')) {
        const harvested = await harvestInviteUrl(tab.id, tab.url);
        if (harvested) break;
      }
    }
  } catch (err) {
    console.error('[Lockstep SW] harvestAllTabs error:', err);
  }
}

/**
 * Initialize offscreen connection on SW wake.
 */
async function initialize() {
  if (chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    }).catch(() => {});
  }

  const { pairKey } = await chrome.storage.local.get(['pairKey']);
  if (pairKey) {
    await joinOffscreenRoom(pairKey);
  }

  const session = await getSessionState();
  await updateBadge(session.activeSession, Boolean(session.autoplayMuted));
}

// Lifecycle listeners
chrome.runtime.onInstalled.addListener(async () => {
  await initialize();
  await harvestAllTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await initialize();
  await harvestAllTabs();
});

// Tab removal listener (auto-end session)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSessionState();
  if (session.activeSession && session.activeSession.tabId === tabId) {
    await sendToOffscreen({
      type: 'RTC_SEND',
      payload: { type: 'SESSION_END' }
    });
    await setSessionState({
      activeSession: null,
      autoplayMuted: false
    });
    await updateBadge(null, false);
  }
});

// Tab URL update listener (canonical URL check & #pair harvest)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url?.includes('#pair') || (changeInfo.status === 'complete' && tab?.url?.includes('#pair'))) {
    const currentUrl = changeInfo.url || tab?.url;
    if (currentUrl && !currentUrl.includes('#paired=1')) {
      await harvestInviteUrl(tabId, currentUrl);
    }
  }

  if (changeInfo.url) {
    const session = await getSessionState();
    if (session.activeSession && session.activeSession.tabId === tabId) {
      const oldCanon = session.activeSession.url;
      const newCanon = canonicalizeVideoUrl(changeInfo.url);
      if (oldCanon && newCanon && oldCanon !== newCanon) {
        // Tab navigated to different canonical video URL: auto-end session
        chrome.tabs.sendMessage(
          tabId,
          { target: 'content', type: 'DETACH_SYNC' },
          typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
        ).catch(() => {});

        await sendToOffscreen({
          type: 'RTC_SEND',
          payload: { type: 'SESSION_END' }
        });

        await setSessionState({
          activeSession: null,
          autoplayMuted: false
        });
        await updateBadge(null, false);
      }
    }
  }
});

/**
 * Handle incoming messages for service-worker.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  // Handle messages from offscreen document
  if (message.target === 'sw' && message.from === 'offscreen') {
    handleOffscreenMessage(message, sendResponse);
    return true;
  }

  // Handle messages explicitly targeted to 'sw'
  if (message.target === 'sw') {
    handleSwMessage(message, sender, sendResponse);
    return true;
  }

  return false;
});

async function handleOffscreenMessage(message, sendResponse) {
  const { type } = message;

  if (type === 'PEER_STATUS') {
    const prevSession = await getSessionState();
    const peerOnline = Boolean(message.peerOnline);
    const rttMs = message.rttMs ?? null;
    await setSessionState({ peerOnline, rttMs });
    if (message.selfId) {
      const { peerId } = await chrome.storage.local.get(['peerId']);
      if (!peerId) {
        await chrome.storage.local.set({ peerId: message.selfId });
      }
    }

    // Late-joiner peer connected: broadcast current feed to peer so they sync up immediately
    if (!prevSession.peerOnline && peerOnline && prevSession.activeSession?.tabId && prevSession.activeSession?.isHost) {
      const hostSession = prevSession.activeSession;
      let snap = null;
      try {
        const frameOpts = typeof hostSession.frameId === 'number' ? { frameId: hostSession.frameId } : undefined;
        snap = await chrome.tabs.sendMessage(
          hostSession.tabId,
          { target: 'content', type: 'REQUEST_STATE_SNAPSHOT' },
          frameOpts
        );
      } catch (_) {}

      await sendToOffscreen({
        type: 'RTC_SEND',
        payload: {
          type: 'SHARE_FEED',
          pageUrl: hostSession.pageUrl,
          sourceHint: hostSession.sourceHint || null,
          state: snap?.state || null
        }
      });
    }

    sendResponse({ ok: true });
    return;
  }

  if (type === 'RTC_RECV') {
    const payload = message.payload;
    if (!payload) {
      sendResponse({ ok: false, error: 'Empty payload' });
      return;
    }

    const payloadType = payload.type || payload.action;

    // Handle incoming feed share
    if (payloadType === 'SHARE_FEED') {
      const pageUrl = payload.pageUrl;
      const tabs = await chrome.tabs.query({});
      let targetTab = findMatchingTab(tabs, pageUrl);
      let isNewTab = false;

      if (targetTab) {
        await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
        if (targetTab.windowId) {
          await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
        }
      } else {
        targetTab = await chrome.tabs.create({ url: pageUrl, active: true });
        isNewTab = true;
      }

      const activeSession = {
        tabId: targetTab.id,
        frameId: null,
        isHost: false,
        area: 0,
        url: canonicalizeVideoUrl(pageUrl),
        pageUrl,
        sourceHint: payload.sourceHint || null,
        initialState: payload.state || null
      };

      await setSessionState({
        activeSession,
        autoplayMuted: false
      });
      await updateBadge(activeSession, false);

      const deliverFeed = (tId) => {
        if (payload.sourceHint) {
          chrome.tabs.sendMessage(
            tId,
            { target: 'content', type: 'APPLY_SOURCE_HINT', sourceHint: payload.sourceHint },
            { frameId: 0 }
          ).catch(() => {});
        }
        chrome.tabs.sendMessage(
          tId,
          { target: 'content', type: 'SCAN_VIDEOS' }
        ).catch(() => {});
      };

      if (!isNewTab) {
        deliverFeed(targetTab.id);
      } else {
        const listener = (uTabId, uInfo) => {
          if (uTabId === targetTab.id && uInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            deliverFeed(targetTab.id);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => deliverFeed(targetTab.id), 1200);
      }

      sendResponse({ ok: true });
      return;
    }

    // Handle INTENT and HEARTBEAT sync messages
    if (payloadType === 'INTENT' || payloadType === 'HEARTBEAT') {
      const session = await getSessionState();
      if (session.activeSession?.tabId) {
        chrome.tabs.sendMessage(
          session.activeSession.tabId,
          {
            target: 'content',
            type: 'REMOTE_SYNC',
            msg: payload,
            rttMs: session.rttMs ?? 0
          },
          typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
        ).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }

    // Handle bilateral SESSION_END
    if (payloadType === 'SESSION_END') {
      const session = await getSessionState();
      if (session.activeSession?.tabId) {
        chrome.tabs.sendMessage(
          session.activeSession.tabId,
          { target: 'content', type: 'DETACH_SYNC' },
          typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
        ).catch(() => {});
      }
      await setSessionState({
        activeSession: null,
        autoplayMuted: false
      });
      await updateBadge(null, false);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false, error: 'Unknown offscreen message' });
}

async function handleSwMessage(message, sender, sendResponse) {
  const { type } = message;

  if (type === 'GET_STATUS') {
    let local = await chrome.storage.local.get(['pairKey', 'peerId']);
    const hasDoc = await hasOffscreenDocument();
    if (local.pairKey && !hasDoc) {
      await joinOffscreenRoom(local.pairKey);
      local = await chrome.storage.local.get(['pairKey', 'peerId']);
    }
    const session = await getSessionState();
    sendResponse({
      ok: true,
      pairKey: local.pairKey || null,
      peerId: local.peerId || null,
      peerOnline: Boolean(session.peerOnline),
      rttMs: session.rttMs ?? null,
      activeSession: session.activeSession || null,
      autoplayMuted: Boolean(session.autoplayMuted)
    });
    return;
  }

  if (type === 'SET_PAIR_KEY') {
    const { pairKey } = message;
    if (pairKey) {
      await chrome.storage.local.set({ pairKey });
      await joinOffscreenRoom(pairKey);
    }
    sendResponse({ ok: true, pairKey });
    return;
  }

  if (type === 'UNPAIR') {
    const session = await getSessionState();
    if (session.activeSession?.tabId) {
      chrome.tabs.sendMessage(
        session.activeSession.tabId,
        { target: 'content', type: 'DETACH_SYNC' },
        typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
      ).catch(() => {});
    }
    await sendToOffscreen({
      type: 'RTC_SEND',
      payload: { type: 'SESSION_END' }
    });
    await sendToOffscreen({ type: 'LEAVE_ROOM' });
    await chrome.storage.local.remove(['pairKey']);
    await setSessionState({
      activeSession: null,
      peerOnline: false,
      rttMs: null,
      autoplayMuted: false
    });
    await updateBadge(null, false);
    sendResponse({ ok: true });
    return;
  }

  if (type === 'START_PICK_FLOW') {
    let { pairKey } = await chrome.storage.local.get(['pairKey']);
    if (!pairKey) {
      pairKey = generatePairKey();
      await chrome.storage.local.set({ pairKey });
      await joinOffscreenRoom(pairKey);
    }

    const tabId = message.tabId || sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tabId provided' });
      return;
    }

    try {
      await chrome.tabs.sendMessage(tabId, {
        target: 'content',
        type: 'START_PICKER'
      });
    } catch (_) {
      // ExecuteScript fallback if content scripts not yet injected
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['content/content-main.js'],
          world: 'MAIN'
        });
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['content/content.js']
        });
        await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          type: 'START_PICKER'
        });
      } catch (err) {
        console.warn('[Lockstep SW] executeScript/startPicker fallback failed:', err);
      }
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const pageUrl = tab?.url || '';
    const inviteUrl = buildInviteUrl({ pairKey, pageUrl });

    sendResponse({
      ok: true,
      pairKey,
      inviteUrl
    });
    return;
  }

  if (type === 'END_SESSION') {
    const session = await getSessionState();
    if (session.activeSession?.tabId) {
      chrome.tabs.sendMessage(
        session.activeSession.tabId,
        { target: 'content', type: 'DETACH_SYNC' },
        typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
      ).catch(() => {});
    }
    await sendToOffscreen({
      type: 'RTC_SEND',
      payload: { type: 'SESSION_END' }
    });
    await setSessionState({
      activeSession: null,
      autoplayMuted: false
    });
    await updateBadge(null, false);
    sendResponse({ ok: true });
    return;
  }

  if (type === 'RESYNC_NOW') {
    const session = await getSessionState();
    if (session.activeSession?.tabId) {
      const { peerId } = await chrome.storage.local.get(['peerId']);
      const frameOpts = typeof session.activeSession.frameId === 'number'
        ? { frameId: session.activeSession.frameId }
        : undefined;

      let res = null;
      try {
        res = await chrome.tabs.sendMessage(
          session.activeSession.tabId,
          { target: 'content', type: 'EMIT_RESYNC_INTENT', selfId: peerId },
          frameOpts
        );
      } catch (_) {
        try {
          res = await chrome.tabs.sendMessage(
            session.activeSession.tabId,
            { target: 'content', type: 'EMIT_RESYNC_INTENT', selfId: peerId }
          );
        } catch (_) {}
      }

      if (res?.intent) {
        await sendToOffscreen({
          type: 'RTC_SEND',
          payload: res.intent
        });
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (type === 'VIDEO_PICKED') {
    const tabId = sender?.tab?.id || message.tabId;
    const pageUrl = sender?.tab?.url || message.pageUrl || '';
    const frameId = sender?.frameId ?? message.frameId ?? 0;
    const hasVideo = message.hasVideo !== false;
    const area = message.area || 0;

    // Send CANCEL_PICKER to tabId
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        target: 'content',
        type: 'CANCEL_PICKER'
      }).catch(() => {});
    }

    let sourceHint = null;
    const { peerId } = await chrome.storage.local.get(['peerId']);

    if (tabId) {
      try {
        const hintRes = await chrome.tabs.sendMessage(
          tabId,
          { target: 'content', type: 'GET_SOURCE_HINT' },
          { frameId: 0 }
        );
        sourceHint = hintRes?.sourceHint ?? hintRes?.hint ?? null;
      } catch (_) {}

      if (hasVideo) {
        chrome.tabs.sendMessage(
          tabId,
          {
            target: 'content',
            type: 'ATTACH_SYNC',
            selfId: peerId,
            initialState: null
          },
          { frameId }
        ).catch(() => {});
      } else {
        // Clicked iframe in Frame 0: scan videos across frames
        chrome.tabs.sendMessage(
          tabId,
          { target: 'content', type: 'SCAN_VIDEOS' }
        ).catch(() => {});
      }
    }

    const activeSession = {
      tabId,
      frameId: hasVideo ? frameId : null,
      isHost: true,
      area,
      url: canonicalizeVideoUrl(pageUrl),
      pageUrl,
      sourceHint,
      duration: message.duration || 0,
      frameOrigin: message.frameOrigin || null,
      initialState: null
    };

    await setSessionState({
      activeSession,
      autoplayMuted: false
    });
    await updateBadge(activeSession, false);

    // Broadcast feed share via RTC
    await sendToOffscreen({
      type: 'RTC_SEND',
      payload: {
        type: 'SHARE_FEED',
        pageUrl,
        sourceHint,
        state: message.state || null
      }
    });

    const { pairKey } = await chrome.storage.local.get(['pairKey']);
    const session = await getSessionState();
    const inviteUrl = buildInviteUrl({ pairKey, pageUrl, sourceHint });

    sendResponse({
      ok: true,
      inviteUrl,
      copyInvite: !session.peerOnline
    });
    return;
  }

  if (type === 'VIDEO_READY') {
    const session = await getSessionState();
    const activeSession = session.activeSession;
    const tabId = sender?.tab?.id || message.tabId;
    const frameId = sender?.frameId ?? message.frameId ?? 0;
    const newArea = message.area || 0;

    if (activeSession && tabId && activeSession.tabId === tabId) {
      if (typeof activeSession.frameId === 'number' && activeSession.frameId !== frameId) {
        let oldValid = false;
        try {
          const oldSnap = await chrome.tabs.sendMessage(
            tabId,
            { target: 'content', type: 'REQUEST_STATE_SNAPSHOT' },
            { frameId: activeSession.frameId }
          );
          if (oldSnap?.ok && oldSnap?.hasVideo) {
            oldValid = true;
          }
        } catch (_) {}

        if (oldValid && (activeSession.area || 0) >= newArea) {
          // Old frame has valid video and equal or larger area -> keep old frame
          sendResponse({ ok: true, keptOld: true });
          return;
        }

        // Otherwise detach old frame
        chrome.tabs.sendMessage(
          tabId,
          { target: 'content', type: 'DETACH_SYNC' },
          { frameId: activeSession.frameId }
        ).catch(() => {});
      }

      const { peerId } = await chrome.storage.local.get(['peerId']);
      const initState = activeSession.initialState || null;
      activeSession.initialState = null;

      activeSession.frameId = frameId;
      activeSession.area = newArea;
      if (message.duration !== undefined) activeSession.duration = message.duration;
      if (message.frameOrigin !== undefined) activeSession.frameOrigin = message.frameOrigin;

      await setSessionState({ activeSession });

      chrome.tabs.sendMessage(
        tabId,
        {
          target: 'content',
          type: 'ATTACH_SYNC',
          selfId: peerId,
          initialState: initState
        },
        { frameId }
      ).catch(() => {});
    }

    sendResponse({ ok: true });
    return;
  }

  if (type === 'LOCAL_SYNC_MSG') {
    const payload = message.payload || message.msg || message.data;
    if (payload) {
      await sendToOffscreen({
        type: 'RTC_SEND',
        payload
      });
    }
    sendResponse({ ok: true });
    return;
  }

  if (type === 'AUTOPLAY_MUTED') {
    const isMuted = Boolean(message.muted);
    await setSessionState({ autoplayMuted: isMuted });
    const session = await getSessionState();
    await updateBadge(session.activeSession, isMuted);
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false, error: 'Unknown SW action' });
}
