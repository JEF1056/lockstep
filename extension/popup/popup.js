// popup.js - Lockstep Prismatic Studio UI Controller

const INVITE_BASE_URL = 'https://jef1056.github.io/lockstep/';
const STORAGE_DISPLAY_NAME_KEY = 'lockstep_display_name';

// Top-level Pre-fill: hydrate display name before first render
const inputDisplayName = document.getElementById('input-display-name');
const prefilledName = (localStorage.getItem(STORAGE_DISPLAY_NAME_KEY) || '').trim().slice(0, 24);
if (inputDisplayName && prefilledName) {
  inputDisplayName.value = prefilledName;
}

// Top-level DOM Elements
const updateBanner = document.getElementById('update-banner');
const updateVersionText = document.getElementById('update-version-text');
const updateDownloadLink = document.getElementById('update-download-link');
const btnUpdateReload = document.getElementById('btn-update-reload');

// Views
const viewUnpaired = document.getElementById('view-unpaired');
const viewPairedIdle = document.getElementById('view-paired-idle');
const viewSyncing = document.getElementById('view-syncing');

// 1A Elements
const kickedBanner = document.getElementById('kicked-banner');
const btnDismissKicked = document.getElementById('btn-dismiss-kicked');
const tabGateHint = document.getElementById('tab-gate-hint');
const btnUnpairedPick = document.getElementById('btn-unpaired-pick');
const btnUnpairedPickSpecific = document.getElementById('btn-unpaired-pick-specific');
const detailsPairKey = document.getElementById('details-pair-key');
const formConnect = document.getElementById('form-connect');
const inputPairKey = document.getElementById('input-pair-key');
const btnConnect = document.getElementById('btn-connect');

// 1B Elements
const idleStatusDot = document.getElementById('idle-status-dot');
const idleStatusText = document.getElementById('idle-status-text');
const btnCopyInvite = document.getElementById('btn-copy-invite');
const idleKeyValue = document.getElementById('idle-key-value');
const iconCopy = document.getElementById('icon-copy');
const tabGateHintIdle = document.getElementById('tab-gate-hint-idle');
const rosterIdle = document.getElementById('roster-idle');
const btnPairedPick = document.getElementById('btn-paired-pick');
const btnPickSpecific = document.getElementById('btn-pick-specific');
const btnCopyInviteLink = document.getElementById('btn-copy-invite-link');
const btnUnpairIdle = document.getElementById('btn-unpair-idle');

// 1C Elements
const syncStatusDot = document.getElementById('sync-status-dot');
const syncDomain = document.getElementById('sync-domain');
const syncPing = document.getElementById('sync-ping');
const btnResync = document.getElementById('btn-resync');
const syncContextBar = document.getElementById('sync-context-bar');
const btnFocusTab = document.getElementById('btn-focus-tab');
const btnSwitchTab = document.getElementById('btn-switch-tab');
const btnFocusVideo = document.getElementById('btn-focus-video');
const btnPickSpecificSync = document.getElementById('btn-pick-specific-sync');
const syncMutedWarning = document.getElementById('sync-muted-warning');
const rosterSync = document.getElementById('roster-sync');
const btnCopySyncInvite = document.getElementById('btn-copy-sync-invite');
const btnEndSession = document.getElementById('btn-end-session');
const btnUnpairSync = document.getElementById('btn-unpair-sync');

let currentStatus = null;
let copyTimeout = null;
let copyLinkTimeout = null;
let copySyncTimeout = null;
let displayNameDebounceTimer = null;
let kickedNoticeDismissed = false;
let lastOverriddenViewerName = null;
let standbyPickerArmed = false;

// Send message to background service worker
function sendSw(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: true });
        }
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// Copy text to clipboard with DOM fallback
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const success = document.execCommand('copy');
    document.body.removeChild(ta);
    return success;
  }
}

// Format short session URL: strip www. from hostname + short path
function formatShortSessionUrl(activeSession) {
  if (!activeSession) return 'Active video';
  if (activeSession.domain) {
    return activeSession.domain.replace(/^www\./i, '');
  }
  const rawUrl = activeSession.pageUrl || '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.replace(/^www\./i, '');
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      const full = host + path;
      return full.length > 28 ? full.slice(0, 26) + '...' : full;
    } catch {
      return rawUrl.length > 28 ? rawUrl.slice(0, 26) + '...' : rawUrl;
    }
  }
  return 'Active video';
}

// Synchronously persist display name to localStorage and storage.local, optionally flushing to SW
function persistDisplayName(val, flushSw = false) {
  const trimmed = typeof val === 'string' ? val.trim().slice(0, 24) : '';
  if (trimmed) {
    try {
      localStorage.setItem(STORAGE_DISPLAY_NAME_KEY, trimmed);
    } catch (_) {}
    try {
      chrome.storage?.local?.set?.({ displayName: trimmed, customDisplayName: trimmed });
    } catch (_) {}
  }
  if (currentStatus && trimmed) {
    currentStatus.displayName = trimmed;
  }
  if (flushSw) {
    if (displayNameDebounceTimer) {
      clearTimeout(displayNameDebounceTimer);
      displayNameDebounceTimer = null;
    }
    if (trimmed) {
      sendSw({ target: 'sw', type: 'SET_DISPLAY_NAME', displayName: trimmed });
    }
  }
}

// Query service worker status, fallback to storage
async function fetchStatus() {
  const res = await sendSw({ target: 'sw', type: 'GET_STATUS' });
  if (res && typeof res === 'object' && ('pairKey' in res || 'activeSession' in res)) {
    return {
      ...res,
      displayName: res.displayName || '',
      peers: Array.isArray(res.peers) ? res.peers : [],
      peerCount: typeof res.peerCount === 'number' ? res.peerCount : (Array.isArray(res.peers) ? res.peers.length : (res.peerOnline ? 1 : 0)),
      isRoomOwner: Boolean(res.isRoomOwner),
      canKick: Boolean(res.canKick),
      kickedNotice: Boolean(res.kickedNotice),
      currentTab: res.currentTab || null
    };
  }

  // Storage fallback
  try {
    const local = await chrome.storage.local.get(['pairKey', 'peerId', 'updateInfo', 'displayName', 'customDisplayName']);
    const session = chrome.storage.session
      ? await chrome.storage.session.get(['activeSession', 'peerOnline', 'rttMs', 'autoplayMuted', 'peers', 'peerCount', 'isRoomOwner', 'canKick', 'kickedNotice'])
      : {};
    let inviteUrl = null;
    if (local.pairKey) {
      const hashParts = [`pair=${encodeURIComponent(local.pairKey)}`];
      if (session.activeSession?.pageUrl) {
        hashParts.push(`url=${encodeURIComponent(session.activeSession.pageUrl)}`);
      }
      inviteUrl = `${INVITE_BASE_URL}#${hashParts.join('&')}`;
    }
    const peers = Array.isArray(session.peers) ? session.peers : [];
    const peerCount = typeof session.peerCount === 'number' ? session.peerCount : peers.length;
    return {
      pairKey: local.pairKey || null,
      peerOnline: session.peerOnline || false,
      rttMs: session.rttMs ?? null,
      activeSession: session.activeSession || null,
      autoplayMuted: session.autoplayMuted || false,
      updateInfo: local.updateInfo || null,
      inviteUrl,
      displayName: local.customDisplayName || local.displayName || '',
      peers,
      peerCount,
      isRoomOwner: Boolean(session.isRoomOwner),
      canKick: Boolean(session.canKick),
      kickedNotice: Boolean(session.kickedNotice),
      currentTab: null
    };
  } catch {
    return {
      pairKey: null,
      peerOnline: false,
      rttMs: null,
      activeSession: null,
      autoplayMuted: false,
      updateInfo: null,
      inviteUrl: null,
      displayName: '',
      peers: [],
      peerCount: 0,
      isRoomOwner: false,
      canKick: false,
      kickedNotice: false,
      currentTab: null
    };
  }
}

// Render multi-person session roster: peer-only (your name lives in header)
function renderRoster(container, status) {
  if (!container) return;
  const peers = Array.isArray(status.peers) ? status.peers : [];
  if (peers.length === 0) {
    container.classList.add('hidden');
    container.replaceChildren();
    return;
  }

  container.classList.remove('hidden');
  container.replaceChildren();

  const list = document.createElement('div');
  list.className = 'roster-list';

  for (const peer of peers) {
    const peerRow = document.createElement('div');
    peerRow.className = 'roster-row';

    const peerDot = document.createElement('span');
    peerDot.className = 'status-dot dot-emerald';
    peerRow.appendChild(peerDot);

    const peerName = document.createElement('span');
    peerName.className = 'roster-name';
    const rawPeerName = typeof peer.name === 'string' ? peer.name.trim() : '';
    peerName.textContent = rawPeerName || `Peer ${String(peer.peerId || '').slice(0, 4)}`;
    peerRow.appendChild(peerName);

    if (peer.isHost) {
      const peerHostBadge = document.createElement('span');
      peerHostBadge.className = 'badge-host';
      peerHostBadge.textContent = 'HOST';
      peerRow.appendChild(peerHostBadge);
    }

    const latency = document.createElement('span');
    latency.className = 'roster-latency';
    latency.textContent = `${peer.rttMs ?? '-'}ms`;
    peerRow.appendChild(latency);

    if (status.canKick && peer.peerId) {
      const btnKick = document.createElement('button');
      btnKick.type = 'button';
      btnKick.className = 'btn-remove-peer';
      btnKick.textContent = 'Remove';
      btnKick.title = 'Remove peer from session';
      btnKick.setAttribute('aria-label', `Remove ${rawPeerName || peer.peerId}`);
      btnKick.addEventListener('click', async (e) => {
        e.stopPropagation();
        btnKick.disabled = true;
        await sendSw({ target: 'sw', type: 'KICK_PEER', targetPeerId: peer.peerId });
        await render();
      });
      peerRow.appendChild(btnKick);
    }

    list.appendChild(peerRow);
  }

  container.appendChild(list);
}

// Render UI based on current status
async function render() {
  currentStatus = await fetchStatus();
  const pairKey = currentStatus.pairKey;
  const activeSession = currentStatus.activeSession;
  const peerOnline = Boolean(currentStatus.peerOnline);
  const peerCount = typeof currentStatus.peerCount === 'number'
    ? currentStatus.peerCount
    : (Array.isArray(currentStatus.peers) ? currentStatus.peers.length : (peerOnline ? 1 : 0));
  const rttMs = currentStatus.rttMs;
  const isMuted = Boolean(currentStatus.autoplayMuted || activeSession?.autoplayMuted || activeSession?.isMuted);
  const updateInfo = currentStatus.updateInfo;

  // Override auto-generated Viewer name if localStorage holds a custom saved name
  const savedCustomName = (localStorage.getItem(STORAGE_DISPLAY_NAME_KEY) || '').trim().slice(0, 24);
  if (savedCustomName) {
    const swName = (currentStatus.displayName || '').trim();
    if (!swName || /^Viewer \d+$/.test(swName)) {
      if (lastOverriddenViewerName !== swName) {
        lastOverriddenViewerName = swName;
        currentStatus.displayName = savedCustomName;
        persistDisplayName(savedCustomName, true);
      }
    }
  }

  // Populate header name pill when not actively being edited
  if (inputDisplayName && document.activeElement !== inputDisplayName) {
    inputDisplayName.value = currentStatus.displayName || savedCustomName || '';
  }

  // Toggle update banner
  if (updateBanner) {
    if (updateInfo?.available) {
      updateBanner.classList.remove('hidden');
      if (updateVersionText) {
        updateVersionText.textContent = `v${updateInfo.version || ''} ready`;
      }
      if (updateDownloadLink && updateInfo.zipUrl) {
        updateDownloadLink.href = updateInfo.zipUrl;
      }
    } else {
      updateBanner.classList.add('hidden');
    }
  }

  const isSyncing = Boolean(pairKey && activeSession);
  const isPairedIdle = Boolean(pairKey && !activeSession);
  const isUnpaired = !pairKey;

  // Reset kicked notice dismissal if paired
  if (pairKey) {
    kickedNoticeDismissed = false;
  }

  // Toggle kicked banner in 1A
  if (kickedBanner) {
    if (isUnpaired && currentStatus.kickedNotice && !kickedNoticeDismissed) {
      kickedBanner.classList.remove('hidden');
    } else {
      kickedBanner.classList.add('hidden');
    }
  }

  // Toggle screens
  viewUnpaired.classList.toggle('hidden', !isUnpaired);
  viewPairedIdle.classList.toggle('hidden', !isPairedIdle);
  viewSyncing.classList.toggle('hidden', !isSyncing);

  // State 1A: Unpaired
  if (isUnpaired) {
    const currentTab = currentStatus.currentTab;
    const canSync = Boolean(!currentTab || currentTab.canSync);
    if (tabGateHint) {
      tabGateHint.classList.toggle('hidden', canSync);
    }
    if (btnUnpairedPick) {
      btnUnpairedPick.disabled = !canSync;
    }
    if (btnUnpairedPickSpecific) {
      btnUnpairedPickSpecific.disabled = !canSync;
    }
  }

  // State 1B: Paired Standby
  if (isPairedIdle) {
    if (idleKeyValue && (!copyTimeout || idleKeyValue.textContent !== 'Copied')) {
      idleKeyValue.textContent = pairKey;
    }

    if (peerCount === 0) {
      idleStatusDot.className = 'status-dot dot-muted';
      idleStatusText.textContent = 'Waiting for peers';
    } else if (peerCount === 1) {
      idleStatusDot.className = 'status-dot dot-emerald';
      idleStatusText.textContent = rttMs != null ? `1 peer · ${rttMs}ms` : '1 peer online';
    } else {
      idleStatusDot.className = 'status-dot dot-emerald';
      idleStatusText.textContent = `${peerCount} peers · ${rttMs ?? 0}ms`;
    }

    const currentTab = currentStatus.currentTab;
    const canSync = Boolean(!currentTab || currentTab.canSync);
    if (tabGateHintIdle) {
      tabGateHintIdle.classList.toggle('hidden', canSync);
    }
    if (btnPairedPick) {
      btnPairedPick.disabled = !canSync;
    }
    if (btnPickSpecific) {
      btnPickSpecific.disabled = !canSync;
    }
    if (canSync && currentTab?.id && !standbyPickerArmed) {
      standbyPickerArmed = true;
      sendSw({ target: 'sw', type: 'ARM_STANDBY_PICKER', tabId: currentTab.id });
    }

    renderRoster(rosterIdle, currentStatus);
  }

  // State 1C: Active Sync
  if (isSyncing) {
    if (syncDomain) {
      syncDomain.textContent = formatShortSessionUrl(activeSession);
    }

    if (peerOnline || peerCount > 0) {
      syncStatusDot.className = 'status-dot dot-emerald animate-pulse';
      syncPing.textContent = `${rttMs ?? 0}ms`;
    } else {
      syncStatusDot.className = 'status-dot dot-amber animate-pulse';
      syncPing.textContent = 'Waiting';
    }

    // Context bar for tab navigation
    const currentTab = currentStatus.currentTab;
    if (syncContextBar) {
      const showPickSpecificSync = Boolean(currentTab && (currentTab.isSyncedTab || currentTab.canSync));
      if (btnPickSpecificSync) {
        btnPickSpecificSync.classList.toggle('hidden', !showPickSpecificSync);
      }

      if (currentTab && !currentTab.isSyncedTab) {
        syncContextBar.classList.remove('hidden');
        if (btnFocusTab) btnFocusTab.classList.remove('hidden');
        if (btnFocusVideo) btnFocusVideo.classList.add('hidden');
        if (btnSwitchTab) {
          btnSwitchTab.classList.toggle('hidden', !currentTab.canSync);
        }
      } else if (currentTab && currentTab.isSyncedTab) {
        syncContextBar.classList.remove('hidden');
        if (btnFocusTab) btnFocusTab.classList.add('hidden');
        if (btnSwitchTab) btnSwitchTab.classList.add('hidden');
        if (btnFocusVideo) btnFocusVideo.classList.remove('hidden');
      } else if (showPickSpecificSync) {
        syncContextBar.classList.remove('hidden');
        if (btnFocusTab) btnFocusTab.classList.add('hidden');
        if (btnSwitchTab) btnSwitchTab.classList.add('hidden');
        if (btnFocusVideo) btnFocusVideo.classList.add('hidden');
      } else {
        syncContextBar.classList.add('hidden');
      }
    }

    if (syncMutedWarning) {
      syncMutedWarning.classList.toggle('hidden', !isMuted);
    }

    if (btnEndSession) {
      const isLeave = Boolean(peerCount >= 2 && !activeSession?.isHost);
      btnEndSession.textContent = isLeave ? 'Leave' : 'Stop Sync';
    }

    renderRoster(rosterSync, currentStatus);
  }
}

// Handlers
function showKeyPillCopiedFeedback() {
  if (copyTimeout) clearTimeout(copyTimeout);
  if (idleKeyValue) idleKeyValue.textContent = 'Copied';
  if (iconCopy) iconCopy.classList.add('hidden');
  copyTimeout = setTimeout(() => {
    if (idleKeyValue && currentStatus?.pairKey) {
      idleKeyValue.textContent = currentStatus.pairKey;
    }
    if (iconCopy) iconCopy.classList.remove('hidden');
    copyTimeout = null;
  }, 1200);
}

function showCopyLinkFeedback() {
  if (copyLinkTimeout) clearTimeout(copyLinkTimeout);
  if (btnCopyInviteLink) btnCopyInviteLink.textContent = 'Copied!';
  copyLinkTimeout = setTimeout(() => {
    if (btnCopyInviteLink) btnCopyInviteLink.textContent = 'Copy Invite';
    copyLinkTimeout = null;
  }, 1200);
}

function showSyncCopiedFeedback() {
  if (copySyncTimeout) clearTimeout(copySyncTimeout);
  if (btnCopySyncInvite) btnCopySyncInvite.textContent = 'Copied!';
  copySyncTimeout = setTimeout(() => {
    if (btnCopySyncInvite) btnCopySyncInvite.textContent = 'Copy Invite';
    copySyncTimeout = null;
  }, 1200);
}

function buildCurrentInviteUrl() {
  if (currentStatus?.inviteUrl) return currentStatus.inviteUrl;
  if (!currentStatus?.pairKey) return null;
  const hashParts = [`pair=${encodeURIComponent(currentStatus.pairKey)}`];
  if (currentStatus.activeSession?.pageUrl) {
    hashParts.push(`url=${encodeURIComponent(currentStatus.activeSession.pageUrl)}`);
  }
  return `${INVITE_BASE_URL}#${hashParts.join('&')}`;
}

async function handleCopyKeyPill() {
  const url = buildCurrentInviteUrl() || currentStatus?.pairKey;
  if (!url) return;
  const ok = await copyText(url);
  if (ok) {
    showKeyPillCopiedFeedback();
  }
}

async function handleCopyInviteLink() {
  const url = buildCurrentInviteUrl();
  if (!url) return;
  const ok = await copyText(url);
  if (ok) {
    showCopyLinkFeedback();
  }
}

async function handleCopySyncInvite() {
  const url = buildCurrentInviteUrl();
  if (!url) return;
  const ok = await copyText(url);
  if (ok) {
    showSyncCopiedFeedback();
  }
}

async function triggerTabSync(tabId) {
  let res = await sendSw({ target: 'sw', type: 'SYNC_CURRENT_TAB', tabId });
  if (!res || res.ok === false) {
    res = await sendSw({ target: 'sw', type: 'START_PICK_FLOW', tabId });
  }
  if (res?.inviteUrl) {
    await copyText(res.inviteUrl);
  }
}

async function handleUnpairedPick() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await triggerTabSync(tab.id);
    }
  } finally {
    window.close();
  }
}

async function handlePairedPick() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await triggerTabSync(tab.id);
    }
  } finally {
    window.close();
  }
}

async function handlePickSpecific() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const res = await sendSw({ target: 'sw', type: 'START_PICK_FLOW', tabId: tab.id });
      if (res?.inviteUrl) {
        await copyText(res.inviteUrl);
      }
    }
  } finally {
    window.close();
  }
}

async function handleFocusTab() {
  try {
    await sendSw({ target: 'sw', type: 'FOCUS_SYNCED_TAB' });
  } finally {
    window.close();
  }
}

async function handleSwitchTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await sendSw({ target: 'sw', type: 'SYNC_CURRENT_TAB', tabId: tab.id });
    }
  } finally {
    window.close();
  }
}

async function handleConnect(e) {
  e.preventDefault();
  const rawKey = inputPairKey.value.trim();
  if (!rawKey) return;
  const pairKey = rawKey.toLowerCase();
  inputPairKey.disabled = true;
  btnConnect.disabled = true;
  try {
    await sendSw({ target: 'sw', type: 'SET_PAIR_KEY', pairKey });
    inputPairKey.value = '';
    if (detailsPairKey) detailsPairKey.removeAttribute('open');
    await render();
  } finally {
    inputPairKey.disabled = false;
    btnConnect.disabled = false;
  }
}

async function handleUnpair() {
  currentStatus = {
    pairKey: null,
    peerOnline: false,
    rttMs: null,
    activeSession: null,
    autoplayMuted: false,
    updateInfo: currentStatus?.updateInfo || null,
    inviteUrl: null,
    displayName: currentStatus?.displayName || '',
    peers: [],
    peerCount: 0,
    isRoomOwner: false,
    canKick: false,
    kickedNotice: false,
    currentTab: currentStatus?.currentTab || null
  };
  viewUnpaired.classList.remove('hidden');
  viewPairedIdle.classList.add('hidden');
  viewSyncing.classList.add('hidden');

  await sendSw({ target: 'sw', type: 'UNPAIR' });
  await render();
}

async function handleEndSession() {
  btnEndSession.disabled = true;
  try {
    await sendSw({ target: 'sw', type: 'END_SESSION' });
    await render();
  } finally {
    btnEndSession.disabled = false;
  }
}

async function handleResync() {
  btnResync.disabled = true;
  try {
    await sendSw({ target: 'sw', type: 'RESYNC_NOW' });
  } finally {
    setTimeout(() => {
      btnResync.disabled = false;
    }, 600);
    await render();
  }
}

// Display Name Event Listeners
if (inputDisplayName) {
  inputDisplayName.addEventListener('input', () => {
    persistDisplayName(inputDisplayName.value, false);
    if (displayNameDebounceTimer) clearTimeout(displayNameDebounceTimer);
    displayNameDebounceTimer = setTimeout(() => {
      persistDisplayName(inputDisplayName.value, true);
    }, 250);
  });

  inputDisplayName.addEventListener('change', () => {
    persistDisplayName(inputDisplayName.value, true);
  });

  inputDisplayName.addEventListener('blur', () => {
    persistDisplayName(inputDisplayName.value, true);
  });

  inputDisplayName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      persistDisplayName(inputDisplayName.value, true);
      inputDisplayName.blur();
    }
  });

  inputDisplayName.addEventListener('pagehide', () => {
    persistDisplayName(inputDisplayName.value, true);
  });
}

window.addEventListener('pagehide', () => {
  if (inputDisplayName) {
    persistDisplayName(inputDisplayName.value, true);
  }
});

// Banner / Modal Event Listeners
if (btnDismissKicked) {
  btnDismissKicked.addEventListener('click', async () => {
    kickedNoticeDismissed = true;
    if (kickedBanner) kickedBanner.classList.add('hidden');
    await sendSw({ target: 'sw', type: 'DISMISS_KICKED_NOTICE' });
  });
}

if (btnUpdateReload) {
  btnUpdateReload.addEventListener('click', async () => {
    btnUpdateReload.disabled = true;
    await sendSw({ target: 'sw', type: 'RELOAD_EXTENSION' });
    window.close();
  });
}

// Action Button Event Listeners
if (btnUnpairedPick) btnUnpairedPick.addEventListener('click', handleUnpairedPick);
if (btnUnpairedPickSpecific) btnUnpairedPickSpecific.addEventListener('click', handlePickSpecific);
if (formConnect) formConnect.addEventListener('submit', handleConnect);
if (btnCopyInvite) btnCopyInvite.addEventListener('click', handleCopyKeyPill);
if (btnPairedPick) btnPairedPick.addEventListener('click', handlePairedPick);
if (btnPickSpecific) btnPickSpecific.addEventListener('click', handlePickSpecific);
if (btnCopyInviteLink) btnCopyInviteLink.addEventListener('click', handleCopyInviteLink);
if (btnUnpairIdle) btnUnpairIdle.addEventListener('click', handleUnpair);

if (btnResync) btnResync.addEventListener('click', handleResync);
if (btnFocusTab) btnFocusTab.addEventListener('click', handleFocusTab);
if (btnSwitchTab) btnSwitchTab.addEventListener('click', handleSwitchTab);
if (btnFocusVideo) btnFocusVideo.addEventListener('click', handleFocusTab);
if (btnPickSpecificSync) btnPickSpecificSync.addEventListener('click', handlePickSpecific);
if (btnCopySyncInvite) btnCopySyncInvite.addEventListener('click', handleCopySyncInvite);
if (btnEndSession) btnEndSession.addEventListener('click', handleEndSession);
if (btnUnpairSync) btnUnpairSync.addEventListener('click', handleUnpair);

// Listen for storage changes
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener(() => {
    render();
  });
}

// Initial render + 1s periodic telemetry poll
render();
const pollTimer = setInterval(render, 1000);
window.addEventListener('unload', () => clearInterval(pollTimer));
