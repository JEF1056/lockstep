// service-worker.js - Lockstep Background Controller
import {
  parseInviteUrl,
  buildInviteUrl,
  generatePairKey,
  canonicalizeVideoUrl,
  findMatchingTab,
  isShareableVideoPageUrl
} from '../shared/url-match.js';
import { compareVersions } from '../shared/version.js';

let offscreenCreating = null;
let armedPickerTabId = null;
let lastIntentScanTime = 0;
const remoteNavGuard = new Map();

/**
 * Cancel standby video picker on target tab across frames.
 */
async function cancelArmedPicker(tabId) {
  const targetId = tabId || armedPickerTabId;
  armedPickerTabId = null;
  if (!targetId) return;
  try {
    chrome.tabs.sendMessage(targetId, {
      target: 'content',
      type: 'CANCEL_PICKER'
    }).catch(() => {});
    if (chrome.webNavigation?.getAllFrames) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: targetId }).catch(() => []);
      for (const frame of frames) {
        if (frame.frameId !== 0) {
          chrome.tabs.sendMessage(
            targetId,
            { target: 'content', type: 'CANCEL_PICKER' },
            { frameId: frame.frameId }
          ).catch(() => {});
        }
      }
    }
  } catch (_) {}
}

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
 * Auto-generate default 'Viewer <3-digit>' if unset or retrieve saved displayName.
 */
async function getOrCreateDisplayName() {
  const { displayName, customDisplayName } = await chrome.storage.local.get(['displayName', 'customDisplayName']);
  const preferred = customDisplayName || displayName;
  if (preferred && typeof preferred === 'string' && preferred.trim().length > 0) {
    return preferred.trim().slice(0, 24);
  }
  const randomNum = Math.floor(Math.random() * 900) + 100;
  const newName = `Viewer ${randomNum}`;
  await chrome.storage.local.set({ displayName: newName });
  return newName;
}

/**
 * Broadcast current displayName and isHost status to offscreen and room peers.
 */
async function syncSelfMetaToOffscreen() {
  try {
    const { displayName, customDisplayName, isRoomOwner } = await chrome.storage.local.get(['displayName', 'customDisplayName', 'isRoomOwner']);
    const session = await getSessionState();
    const isHost = Boolean(session.activeSession?.isHost || isRoomOwner);
    const preferred = customDisplayName || displayName;
    const name = (preferred && typeof preferred === 'string' && preferred.trim().length > 0)
      ? preferred.trim().slice(0, 24)
      : await getOrCreateDisplayName();
    await sendToOffscreen({
      type: 'UPDATE_SELF_META',
      selfMeta: { name, isHost }
    });
  } catch (err) {
    console.warn('[Lockstep SW] syncSelfMetaToOffscreen failed:', err);
  }
}

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes.displayName || changes.customDisplayName)) {
    syncSelfMetaToOffscreen().catch(() => {});
  }
});

/**
 * Joins an offscreen room and persists returned peerId.
 * Normalizes pairKey to trimmed lowercase.
 */
async function joinOffscreenRoom(pairKey) {
  if (!pairKey) return null;
  const normalizedKey = String(pairKey).trim().toLowerCase();
  const displayName = await getOrCreateDisplayName();
  const { isRoomOwner } = await chrome.storage.local.get(['isRoomOwner']);
  const session = await getSessionState();
  const isHost = Boolean(session.activeSession?.isHost || isRoomOwner);
  const selfMeta = { name: displayName, isHost };
  const resp = await sendToOffscreen({ type: 'JOIN_ROOM', pairKey: normalizedKey, selfMeta });
  if (resp?.selfId) {
    await chrome.storage.local.set({ peerId: resp.selfId });
  }
  return resp;
}

/**
 * Send a message to the offscreen document safely.
 * Recovers room subscription if offscreen document was freshly created.
 * Retries up to 4 times on "Receiving end does not exist" with backoff (60ms, 140ms, 300ms).
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
    const delays = [60, 140, 300];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: true });
          }
        });
      });
      if (res?.ok || !res?.error?.includes('Receiving end does not exist') || attempt === delays.length) {
        return res;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
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
    return await chrome.storage.session.get(['activeSession', 'peerOnline', 'rttMs', 'autoplayMuted', 'pendingReload', 'peers', 'peerCount']);
  }
  return {};
}

async function setSessionState(data) {
  if (chrome.storage?.session) {
    await chrome.storage.session.set(data);
  }
}

/**
 * Ensure content scripts are active in a tab.
 * Pings first, falls back to programmatic injection into MAIN and ISOLATED worlds.
 */
async function ensureContentScripts(tabId) {
  if (!tabId) return false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'PING' });
    if (res?.ok) return true;
  } catch {}
  try {
    if (chrome.scripting?.executeScript) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/content-main.js'],
        world: 'MAIN'
      });
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/content.js']
      });
      return true;
    }
  } catch (err) {
    console.warn('[Lockstep SW] ensureContentScripts fallback failed:', err);
  }
  return false;
}

/**
 * Check if extension on disk is newer than runtime and reload or set pendingReload.
 */
async function checkDiskReload() {
  try {
    const runtimeVersion = chrome.runtime.getManifest?.()?.version;
    if (!runtimeVersion) return false;
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return false;
    const diskManifest = await res.json();
    if (diskManifest?.version && compareVersions(diskManifest.version, runtimeVersion) > 0) {
      const session = await getSessionState();
      if (!session.activeSession) {
        chrome.runtime.reload();
        return true;
      } else {
        await setSessionState({ pendingReload: true });
        return false;
      }
    }
  } catch (err) {
    console.warn('[Lockstep SW] checkDiskReload failed:', err);
  }
  return false;
}

/**
 * Periodically check for updates on live disk and GitHub Pages version manifest.
 */
async function checkForUpdates() {
  await checkDiskReload();
  try {
    const runtimeVersion = chrome.runtime.getManifest?.()?.version;
    const res = await fetch('https://jef1056.github.io/lockstep/version.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const remoteVersion = data?.version;
      const available = Boolean(remoteVersion && runtimeVersion && compareVersions(remoteVersion, runtimeVersion) > 0);
      const updateInfo = {
        available,
        version: remoteVersion || '',
        zipUrl: data?.zipUrl || 'https://jef1056.github.io/lockstep/lockstep.zip'
      };
      await chrome.storage.local.set({ updateInfo });
      return updateInfo;
    }
  } catch (err) {
    console.warn('[Lockstep SW] checkForUpdates remote fetch failed:', err);
  }
  return null;
}

/**
 * Retries video scanning with autoStart for lazy facade players or embedded iframes.
 */
function scheduleScanRetries(tabId) {
  const delays = [900, 2200];
  for (const delay of delays) {
    setTimeout(async () => {
      try {
        const session = await getSessionState();
        if (session.activeSession?.tabId === tabId && session.activeSession?.frameId === null) {
          await ensureContentScripts(tabId);
          chrome.tabs.sendMessage(
            tabId,
            { target: 'content', type: 'SCAN_VIDEOS', autoStart: true }
          ).catch(() => {});
        }
      } catch {}
    }, delay);
  }
}

/**
 * Auto-harvest #pair invite tabs.
 */
async function harvestInviteUrl(tabId, url) {
  if (!url || url.includes('#paired=1')) return false;
  const parsed = parseInviteUrl(url);
  if (!parsed || !parsed.pairKey) return false;

  const pairKey = String(parsed.pairKey).trim().toLowerCase();
  await chrome.storage.local.set({ pairKey, isRoomOwner: false });
  await chrome.storage.local.remove(['kickedNotice']);
  await joinOffscreenRoom(pairKey);
  await syncSelfMetaToOffscreen();

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
          { target: 'content', type: 'SCAN_VIDEOS', autoStart: true }
        ).catch(() => {});
        scheduleScanRetries(targetTabId);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    if (existingTab) {
      await ensureContentScripts(targetTabId);
      if (parsed.sourceHint) {
        chrome.tabs.sendMessage(
          targetTabId,
          { target: 'content', type: 'APPLY_SOURCE_HINT', sourceHint: parsed.sourceHint },
          { frameId: 0 }
        ).catch(() => {});
      }
      chrome.tabs.sendMessage(
        targetTabId,
        { target: 'content', type: 'SCAN_VIDEOS', autoStart: true }
      ).catch(() => {});
      scheduleScanRetries(targetTabId);
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

  await getOrCreateDisplayName();

  const { pairKey } = await chrome.storage.local.get(['pairKey']);
  if (pairKey) {
    await joinOffscreenRoom(pairKey);
  }

  const session = await getSessionState();
  await updateBadge(session.activeSession, Boolean(session.autoplayMuted));

  try {
    chrome.alarms?.create('lockstep-update-check', { periodInMinutes: 360 });
    checkForUpdates().catch(() => {});
  } catch (err) {
    console.warn('[Lockstep SW] initialize alarms/update-check failed:', err);
  }
}

// Alarm listener for scheduled update checks
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === 'lockstep-update-check') {
    checkForUpdates().catch(() => {});
  }
});

// Lifecycle listeners
chrome.runtime.onInstalled.addListener(async () => {
  await initialize();
  await harvestAllTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await initialize();
  await harvestAllTabs();
});

// Tab removal listener (auto-end session & clear armed picker)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === armedPickerTabId) {
    armedPickerTabId = null;
  }
  remoteNavGuard.delete(tabId);
  const session = await getSessionState();
  if (session.activeSession && session.activeSession.tabId === tabId) {
    const shouldBroadcast = Boolean(session.activeSession?.isHost || (session.peerCount || 0) <= 1);
    if (shouldBroadcast) {
      await sendToOffscreen({
        type: 'RTC_SEND',
        payload: { type: 'SESSION_END' }
      });
    }
    await setSessionState({
      activeSession: null,
      autoplayMuted: false
    });
    await updateBadge(null, false);
    await syncSelfMetaToOffscreen();
    if (session.pendingReload) {
      await setSessionState({ pendingReload: false });
      chrome.runtime.reload();
      return;
    }
  }
});

// Tab activated listener (cancel armed picker when switching tabs)
chrome.tabs.onActivated.addListener(async () => {
  if (armedPickerTabId) {
    await cancelArmedPicker(armedPickerTabId);
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
      if (!newCanon) {
        return;
      }

      const guard = remoteNavGuard.get(tabId);
      if (guard && guard.canonUrl === newCanon && Date.now() < guard.until) {
        if (!guard.rebound) {
          guard.rebound = true;
          session.activeSession.url = newCanon;
          session.activeSession.pageUrl = changeInfo.url;
          session.activeSession.frameId = null;
          await setSessionState({ activeSession: session.activeSession });

          const rebindDelays = [350, 1000];
          for (const delay of rebindDelays) {
            setTimeout(async () => {
              try {
                const cur = await getSessionState();
                if (cur.activeSession?.tabId === tabId) {
                  const { peerId } = await chrome.storage.local.get(['peerId']);
                  await ensureContentScripts(tabId);
                  chrome.tabs.sendMessage(tabId, { target: 'content', type: 'SCAN_VIDEOS', autoStart: true }).catch(() => {});
                  chrome.tabs.sendMessage(tabId, { target: 'content', type: 'REBIND_TAB_VIDEO', selfId: peerId, isHost: false }).catch(() => {});
                }
              } catch (_) {}
            }, delay);
          }
        }
        return;
      }

      if (newCanon === oldCanon) {
        return;
      }

      let sameOrigin = false;
      try {
        sameOrigin = Boolean(session.activeSession.pageUrl && new URL(changeInfo.url).origin === new URL(session.activeSession.pageUrl).origin);
      } catch (_) {}

      if (sameOrigin && isShareableVideoPageUrl(changeInfo.url)) {
        const { peerId } = await chrome.storage.local.get(['peerId']);
        session.activeSession.url = newCanon;
        session.activeSession.pageUrl = changeInfo.url;
        session.activeSession.frameId = null;
        session.activeSession.isHost = true;
        await setSessionState({ activeSession: session.activeSession });
        await syncSelfMetaToOffscreen();

        const sendRebind = () => {
          chrome.tabs.sendMessage(
            tabId,
            { target: 'content', type: 'REBIND_TAB_VIDEO', selfId: peerId, isHost: true }
          ).catch(() => {});
        };

        sendRebind();
        setTimeout(sendRebind, 350);
        setTimeout(sendRebind, 900);

        await sendToOffscreen({
          type: 'RTC_SEND',
          payload: {
            type: 'SHARE_FEED',
            pageUrl: changeInfo.url,
            sourceHint: null,
            state: {
              paused: false,
              time: 0,
              rate: 1,
              seq: Math.floor(Date.now() / 100) % 1000000,
              seqOwner: peerId,
              timestamp: Date.now()
            }
          }
        });
        return;
      }

      // Otherwise (left to homepage/search/other domain), detach & end session cleanly
      chrome.tabs.sendMessage(
        tabId,
        { target: 'content', type: 'DETACH_SYNC' },
        typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
      ).catch(() => {});

      const shouldBroadcast = Boolean(session.activeSession?.isHost || (session.peerCount || 0) <= 1);
      if (shouldBroadcast) {
        await sendToOffscreen({
          type: 'RTC_SEND',
          payload: { type: 'SESSION_END' }
        });
      }

      await setSessionState({
        activeSession: null,
        autoplayMuted: false
      });
      await updateBadge(null, false);
      await syncSelfMetaToOffscreen();
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

  if (type === 'OFFSCREEN_READY') {
    if (message.selfId) {
      await chrome.storage.local.set({ peerId: message.selfId });
    }
    const { pairKey } = await chrome.storage.local.get(['pairKey']);
    if (pairKey) {
      await joinOffscreenRoom(pairKey);
    }
    sendResponse({ ok: true });
    return;
  }

  if (type === 'PEER_STATUS') {
    const peerOnline = Boolean(message.peerOnline);
    const rttMs = message.rttMs ?? null;
    const peers = Array.isArray(message.peers) ? message.peers : [];
    const peerCount = typeof message.peerCount === 'number' ? message.peerCount : peers.length;
    await setSessionState({ peerOnline, rttMs, peers, peerCount });
    if (message.selfId) {
      const { peerId } = await chrome.storage.local.get(['peerId']);
      if (!peerId) {
        await chrome.storage.local.set({ peerId: message.selfId });
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (type === 'PEER_JOINED') {
    const peerId = message.peerId;
    const session = await getSessionState();
    if (session.activeSession?.tabId && session.activeSession?.isHost && peerId) {
      const hostSession = session.activeSession;
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
        targetPeerId: peerId,
        payload: {
          type: 'SHARE_FEED',
          pageUrl: hostSession.pageUrl,
          sourceHint: hostSession.sourceHint || null,
          state: snap?.state || null,
          timestamp: Date.now()
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
      if (!isShareableVideoPageUrl(pageUrl)) {
        sendResponse({ ok: false, error: 'unshareable_page' });
        return;
      }
      if (armedPickerTabId) {
        await cancelArmedPicker(armedPickerTabId);
      }
      const canonUrl = canonicalizeVideoUrl(pageUrl);
      const prevSession = await getSessionState();
      const tabs = await chrome.tabs.query({});
      let targetTab = findMatchingTab(tabs, pageUrl);
      let isNavigating = false;

      if (!targetTab && prevSession.activeSession?.tabId) {
        const prevTabId = prevSession.activeSession.tabId;
        const exists = tabs.some((t) => t.id === prevTabId);
        if (exists) {
          remoteNavGuard.set(prevTabId, { canonUrl, until: Date.now() + 4500 });
          targetTab = await chrome.tabs.update(prevTabId, { url: pageUrl, active: true }).catch(() => null);
          isNavigating = true;
        }
      }

      if (targetTab) {
        if (canonicalizeVideoUrl(targetTab.url) !== canonUrl) {
          remoteNavGuard.set(targetTab.id, { canonUrl, until: Date.now() + 4500 });
          await chrome.tabs.update(targetTab.id, { url: pageUrl, active: true }).catch(() => {});
          isNavigating = true;
        } else {
          await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
        }
        if (targetTab.windowId) {
          await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
        }
      } else {
        targetTab = await chrome.tabs.create({ url: pageUrl, active: true });
        isNavigating = true;
      }

      const activeSession = {
        tabId: targetTab.id,
        frameId: null,
        isHost: false,
        area: 0,
        url: canonUrl,
        pageUrl,
        sourceHint: payload.sourceHint || null,
        initialState: payload.state || null
      };

      await setSessionState({
        activeSession,
        autoplayMuted: false
      });
      await updateBadge(activeSession, false);
      await syncSelfMetaToOffscreen();

      const deliverFeed = async (tId) => {
        if (payload.sourceHint) {
          chrome.tabs.sendMessage(
            tId,
            { target: 'content', type: 'APPLY_SOURCE_HINT', sourceHint: payload.sourceHint },
            { frameId: 0 }
          ).catch(() => {});
        }
        chrome.tabs.sendMessage(
          tId,
          { target: 'content', type: 'SCAN_VIDEOS', autoStart: true }
        ).catch(() => {});
        scheduleScanRetries(tId);
        const sState = await getSessionState();
        chrome.tabs.sendMessage(
          tId,
          {
            target: 'content',
            type: 'APPLY_INITIAL_STATE',
            state: payload.state,
            rttMs: message.peerRttMs ?? sState.rttMs ?? 0,
            clockOffsetMs: message.peerClockOffsetMs ?? null
          }
        ).catch(() => {});
      };

      if (!isNavigating) {
        await ensureContentScripts(targetTab.id);
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
        const tabId = session.activeSession.tabId;
        if (payload.canonUrl && session.activeSession.url && payload.canonUrl !== session.activeSession.url) {
          const guard = remoteNavGuard.get(tabId);
          const isGuarded = Boolean(guard && Date.now() < guard.until);
          if (payload.pageUrl && isShareableVideoPageUrl(payload.pageUrl) && !isGuarded) {
            remoteNavGuard.set(tabId, { canonUrl: payload.canonUrl, until: Date.now() + 4500 });
            session.activeSession.url = payload.canonUrl;
            session.activeSession.pageUrl = payload.pageUrl;
            session.activeSession.frameId = null;
            session.activeSession.initialState = payload;
            await setSessionState({ activeSession: session.activeSession });
            await chrome.tabs.update(tabId, { url: payload.pageUrl, active: true }).catch(() => {});
          }
          sendResponse({ ok: true });
          return;
        }

        chrome.tabs.sendMessage(
          session.activeSession.tabId,
          {
            target: 'content',
            type: 'REMOTE_SYNC',
            msg: payload,
            rttMs: message.peerRttMs ?? session.rttMs ?? 0,
            clockOffsetMs: message.peerClockOffsetMs ?? null
          },
          typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
        ).catch(() => {});

        // If unanchored follower receives active playback, record initial state and nudge video scan/activation
        if (typeof session.activeSession.frameId !== 'number' && payload?.paused === false) {
          session.activeSession.initialState = payload;
          await setSessionState({ activeSession: session.activeSession });
          const now = Date.now();
          if (now - lastIntentScanTime >= 1200) {
            lastIntentScanTime = now;
            chrome.tabs.sendMessage(session.activeSession.tabId, { target: 'content', type: 'SCAN_VIDEOS', autoStart: true }).catch(() => {});
          }
        }
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
      await syncSelfMetaToOffscreen();
      sendResponse({ ok: true });
      if (session.pendingReload) {
        await setSessionState({ pendingReload: false });
        chrome.runtime.reload();
      }
      return;
    }

    // Handle incoming KICK_PEER
    if (payloadType === 'KICK_PEER') {
      const targetPeerId = payload.targetPeerId;
      const { peerId } = await chrome.storage.local.get(['peerId']);
      if (targetPeerId && peerId && targetPeerId === peerId) {
        if (armedPickerTabId) {
          await cancelArmedPicker(armedPickerTabId);
        }
        const session = await getSessionState();
        if (session.activeSession?.tabId) {
          chrome.tabs.sendMessage(
            session.activeSession.tabId,
            { target: 'content', type: 'DETACH_SYNC' },
            typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
          ).catch(() => {});
        }
        await chrome.storage.local.remove(['pairKey', 'isRoomOwner']);
        await chrome.storage.local.set({ kickedNotice: true });
        await setSessionState({
          activeSession: null,
          peerOnline: false,
          rttMs: null,
          peers: [],
          peerCount: 0,
          autoplayMuted: false
        });
        await updateBadge(null, false);
        await sendToOffscreen({ type: 'LEAVE_ROOM' });
        await chrome.offscreen?.closeDocument?.().catch(() => {});
      } else if (targetPeerId) {
        await sendToOffscreen({
          type: 'KICK_PEER',
          targetPeerId,
          broadcast: false
        });
      }
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
    let local = await chrome.storage.local.get(['pairKey', 'peerId', 'updateInfo', 'displayName', 'customDisplayName', 'isRoomOwner', 'kickedNotice']);
    let livePeerOnline = null;
    let liveRttMs = null;
    let livePeers = null;
    let livePeerCount = null;
    if (local.pairKey) {
      const roomRes = await joinOffscreenRoom(local.pairKey);
      if (roomRes && typeof roomRes === 'object') {
        livePeerOnline = roomRes.peerOnline;
        liveRttMs = roomRes.rttMs;
        if (roomRes.peers) livePeers = roomRes.peers;
        if (typeof roomRes.peerCount === 'number') livePeerCount = roomRes.peerCount;
      }
      local = await chrome.storage.local.get(['pairKey', 'peerId', 'updateInfo', 'displayName', 'customDisplayName', 'isRoomOwner', 'kickedNotice']);
    }
    const displayName = local.customDisplayName || local.displayName || (await getOrCreateDisplayName());
    const session = await getSessionState();
    const effectivePeerOnline = livePeerOnline !== null && livePeerOnline !== undefined ? Boolean(livePeerOnline) : Boolean(session.peerOnline);
    const effectiveRttMs = liveRttMs !== null && liveRttMs !== undefined ? liveRttMs : (session.rttMs ?? null);
    const effectivePeers = livePeers !== null && livePeers !== undefined ? livePeers : (session.peers || []);
    const effectivePeerCount = livePeerCount !== null && livePeerCount !== undefined ? livePeerCount : (session.peerCount ?? effectivePeers.length);

    if (livePeers !== null || livePeerCount !== null) {
      await setSessionState({ peers: effectivePeers, peerCount: effectivePeerCount });
    }

    const isRoomOwner = Boolean(local.isRoomOwner);
    const canKick = Boolean(session.activeSession?.isHost || isRoomOwner);
    const kickedNotice = Boolean(local.kickedNotice);

    // One-shot kickedNotice: clear in storage after reading in GET_STATUS
    if (local.kickedNotice) {
      await chrome.storage.local.remove(['kickedNotice']);
    }

    const version = chrome.runtime.getManifest?.()?.version || '';
    if (!session.activeSession) {
      checkDiskReload().catch(() => {});
    }
    const inviteUrl = local.pairKey
      ? buildInviteUrl({
          pairKey: local.pairKey,
          pageUrl: session.activeSession?.pageUrl,
          sourceHint: session.activeSession?.sourceHint
        })
      : null;

    let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    if (!activeTab) {
      [activeTab] = await chrome.tabs.query({ active: true }).catch(() => []);
    }
    const currentTab = activeTab
      ? {
          id: activeTab.id,
          url: activeTab.url || '',
          canSync: isShareableVideoPageUrl(activeTab.url || ''),
          isSyncedTab: Boolean(session.activeSession && activeTab.id === session.activeSession.tabId)
        }
      : null;

    sendResponse({
      ok: true,
      version,
      updateInfo: local.updateInfo || null,
      pairKey: local.pairKey || null,
      peerId: local.peerId || null,
      displayName,
      isRoomOwner,
      canKick,
      peers: effectivePeers,
      peerCount: effectivePeerCount,
      kickedNotice,
      peerOnline: effectivePeerOnline,
      rttMs: effectiveRttMs,
      activeSession: session.activeSession || null,
      autoplayMuted: Boolean(session.autoplayMuted),
      inviteUrl,
      currentTab
    });
    return;
  }

  if (type === 'SET_DISPLAY_NAME') {
    const rawName = message.displayName || '';
    const trimmed = String(rawName).trim().slice(0, 24);
    if (trimmed) {
      await chrome.storage.local.set({ displayName: trimmed, customDisplayName: trimmed });
      await syncSelfMetaToOffscreen();
      sendResponse({ ok: true, displayName: trimmed });
      return;
    }
    const displayName = await getOrCreateDisplayName();
    await chrome.storage.local.set({ displayName });
    await syncSelfMetaToOffscreen();
    sendResponse({ ok: true, displayName });
    return;
  }

  if (type === 'DISMISS_KICKED_NOTICE') {
    await chrome.storage.local.remove(['kickedNotice']);
    sendResponse({ ok: true });
    return;
  }

  if (type === 'RELOAD_EXTENSION') {
    await chrome.storage.local.remove(['updateInfo']).catch(() => {});
    sendResponse({ ok: true });
    chrome.runtime.reload?.();
    return;
  }

  if (type === 'SET_PAIR_KEY') {
    const rawKey = message.pairKey;
    const pairKey = rawKey ? String(rawKey).trim().toLowerCase() : null;
    if (pairKey) {
      await chrome.storage.local.set({ pairKey, isRoomOwner: false });
      await chrome.storage.local.remove(['kickedNotice']);
      await joinOffscreenRoom(pairKey);
      await syncSelfMetaToOffscreen();
    }
    sendResponse({ ok: true, pairKey });
    return;
  }

  if (type === 'UNPAIR') {
    if (armedPickerTabId) {
      await cancelArmedPicker(armedPickerTabId);
    }
    const session = await getSessionState();
    const activeTabId = session.activeSession?.tabId;
    const activeFrameId = session.activeSession?.frameId;

    // Remove pairKey, isRoomOwner, kickedNotice and reset session state FIRST before teardown
    await chrome.storage.local.remove(['pairKey', 'isRoomOwner', 'kickedNotice']);
    await setSessionState({
      activeSession: null,
      peerOnline: false,
      rttMs: null,
      peers: [],
      peerCount: 0,
      autoplayMuted: false
    });
    await updateBadge(null, false);

    if (activeTabId) {
      chrome.tabs.sendMessage(
        activeTabId,
        { target: 'content', type: 'DETACH_SYNC' },
        typeof activeFrameId === 'number' ? { frameId: activeFrameId } : undefined
      ).catch(() => {});
    }
    await sendToOffscreen({
      type: 'RTC_SEND',
      payload: { type: 'SESSION_END' }
    });
    await sendToOffscreen({ type: 'LEAVE_ROOM' });
    await chrome.offscreen?.closeDocument?.().catch(() => {});

    sendResponse({ ok: true });
    return;
  }

  if (type === 'SYNC_CURRENT_TAB') {
    let tabId = message.tabId;
    if (!tabId) {
      let [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      if (!activeTab) {
        [activeTab] = await chrome.tabs.query({ active: true }).catch(() => []);
      }
      tabId = activeTab?.id;
    }
    if (!tabId) {
      sendResponse({ ok: false, error: 'no_active_tab' });
      return;
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !isShareableVideoPageUrl(tab.url)) {
      sendResponse({ ok: false, error: 'unshareable_page' });
      return;
    }

    let { pairKey } = await chrome.storage.local.get(['pairKey']);
    if (!pairKey) {
      pairKey = generatePairKey();
      await chrome.storage.local.set({ pairKey, isRoomOwner: true });
      await chrome.storage.local.remove(['kickedNotice']);
      await joinOffscreenRoom(pairKey);
      await syncSelfMetaToOffscreen();
    }

    const session = await getSessionState();
    if (session.activeSession?.tabId && session.activeSession.tabId !== tabId) {
      chrome.tabs.sendMessage(
        session.activeSession.tabId,
        { target: 'content', type: 'DETACH_SYNC' },
        typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
      ).catch(() => {});
    }

    await ensureContentScripts(tabId);
    const { peerId } = await chrome.storage.local.get(['peerId']);
    let engageRes = null;
    try {
      engageRes = await chrome.tabs.sendMessage(tabId, {
        target: 'content',
        type: 'ENGAGE_TAB_SYNC',
        selfId: peerId
      });
    } catch (_) {}

    const inviteUrl = buildInviteUrl({ pairKey, pageUrl: tab.url });
    if (engageRes?.ok && engageRes?.found) {
      sendResponse({ ok: true, mode: 'locked', pairKey, inviteUrl });
      return;
    }

    armedPickerTabId = tabId;
    try {
      await chrome.tabs.sendMessage(tabId, {
        target: 'content',
        type: 'START_PICKER'
      });
    } catch (err) {
      console.warn('[Lockstep SW] syncCurrentTab fallback picker failed:', err);
    }
    sendResponse({ ok: true, mode: 'picker', pairKey, inviteUrl });
    return;
  }

  if (type === 'FOCUS_SYNCED_TAB') {
    const session = await getSessionState();
    const tabId = session.activeSession?.tabId;
    if (tabId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
      }
      chrome.tabs.sendMessage(
        tabId,
        { target: 'content', type: 'REFOCUS_VIDEO' },
        typeof session.activeSession.frameId === 'number' ? { frameId: session.activeSession.frameId } : undefined
      ).catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'no_synced_tab' });
    return;
  }

  if (type === 'ARM_STANDBY_PICKER') {
    const { pairKey } = await chrome.storage.local.get(['pairKey']);
    const session = await getSessionState();
    const tabId = message.tabId || sender?.tab?.id;
    if (pairKey && !session.activeSession && tabId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const url = tab?.url || sender?.tab?.url || '';
      if (!isShareableVideoPageUrl(url)) {
        sendResponse({ ok: false, armed: false, error: 'unshareable_page' });
        return;
      }
      await ensureContentScripts(tabId);
      try {
        await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          type: 'START_PICKER'
        });
      } catch (err) {
        console.warn('[Lockstep SW] armStandbyPicker failed:', err);
      }
      armedPickerTabId = tabId;
      sendResponse({ ok: true, armed: true, tabId });
      return;
    }
    sendResponse({ ok: false, armed: false });
    return;
  }

  if (type === 'PICKER_DISMISSED') {
    const targetTabId = sender?.tab?.id || message.tabId || armedPickerTabId;
    await cancelArmedPicker(targetTabId);
    sendResponse({ ok: true });
    return;
  }

  if (type === 'START_PICK_FLOW') {
    const tabId = message.tabId || sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tabId provided' });
      return;
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const pageUrl = tab?.url || sender?.tab?.url || '';
    if (!isShareableVideoPageUrl(pageUrl)) {
      sendResponse({ ok: false, error: 'unshareable_page' });
      return;
    }

    let { pairKey } = await chrome.storage.local.get(['pairKey']);
    if (!pairKey) {
      pairKey = generatePairKey();
      await chrome.storage.local.set({ pairKey, isRoomOwner: true });
      await chrome.storage.local.remove(['kickedNotice']);
      await joinOffscreenRoom(pairKey);
      await syncSelfMetaToOffscreen();
    }

    await ensureContentScripts(tabId);
    try {
      await chrome.tabs.sendMessage(tabId, {
        target: 'content',
        type: 'START_PICKER'
      });
    } catch (err) {
      console.warn('[Lockstep SW] startPicker failed:', err);
    }

    armedPickerTabId = tabId;
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
    const shouldBroadcast = Boolean(session.activeSession?.isHost || (session.peerCount || 0) <= 1);
    if (shouldBroadcast) {
      await sendToOffscreen({
        type: 'RTC_SEND',
        payload: { type: 'SESSION_END' }
      });
    }
    await setSessionState({
      activeSession: null,
      autoplayMuted: false
    });
    await updateBadge(null, false);
    await syncSelfMetaToOffscreen();
    sendResponse({ ok: true });
    if (session.pendingReload) {
      await setSessionState({ pendingReload: false });
      chrome.runtime.reload();
    }
    return;
  }

  if (type === 'KICK_PEER') {
    const targetPeerId = message.targetPeerId;
    if (targetPeerId) {
      await sendToOffscreen({
        type: 'KICK_PEER',
        targetPeerId,
        broadcast: true
      });
    }
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
        const latestSession = await getSessionState();
        res.intent.canonUrl = latestSession.activeSession?.url || null;
        res.intent.pageUrl = latestSession.activeSession?.pageUrl || null;
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
    armedPickerTabId = null;
    const tabId = sender?.tab?.id || message.tabId;
    const pageUrl = (sender?.frameId === 0 && message.pageUrl && isShareableVideoPageUrl(message.pageUrl))
      ? message.pageUrl
      : (sender?.tab?.url || message.pageUrl || '');

    if (!pageUrl || !isShareableVideoPageUrl(pageUrl)) {
      sendResponse({ ok: false, error: 'unshareable_page' });
      return;
    }

    const prevSession = await getSessionState();
    if (prevSession.activeSession?.tabId && prevSession.activeSession.tabId !== tabId) {
      chrome.tabs.sendMessage(
        prevSession.activeSession.tabId,
        { target: 'content', type: 'DETACH_SYNC' },
        typeof prevSession.activeSession.frameId === 'number' ? { frameId: prevSession.activeSession.frameId } : undefined
      ).catch(() => {});
    }

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
            isHost: true,
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
    await syncSelfMetaToOffscreen();
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
      await syncSelfMetaToOffscreen();

      chrome.tabs.sendMessage(
        tabId,
        {
          target: 'content',
          type: 'ATTACH_SYNC',
          selfId: peerId,
          isHost: Boolean(activeSession.isHost),
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
      const session = await getSessionState();
      payload.canonUrl = session.activeSession?.url || null;
      payload.pageUrl = session.activeSession?.pageUrl || null;
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
