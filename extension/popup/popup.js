// popup.js - Lockstep Prismatic Studio UI Controller

const INVITE_BASE_URL = 'https://jef1056.github.io/lockstep/';

// DOM Elements
const updateBanner = document.getElementById('update-banner');
const updateVersionText = document.getElementById('update-version-text');
const updateDownloadLink = document.getElementById('update-download-link');
const btnUpdateReload = document.getElementById('btn-update-reload');

// Identity Strip & Banners
const inputDisplayName = document.getElementById('input-display-name');
const kickedBanner = document.getElementById('kicked-banner');
const btnDismissKicked = document.getElementById('btn-dismiss-kicked');

const chipIdle = document.getElementById('chip-idle');
const chipStandby = document.getElementById('chip-standby');
const chipSyncing = document.getElementById('chip-syncing');
const standbyHeaderDot = document.getElementById('standby-header-dot');
const standbyHeaderText = document.getElementById('standby-header-text');

const viewUnpaired = document.getElementById('view-unpaired');
const viewPairedIdle = document.getElementById('view-paired-idle');
const viewSyncing = document.getElementById('view-syncing');

// 1A Elements
const btnUnpairedPick = document.getElementById('btn-unpaired-pick');
const detailsPairKey = document.getElementById('details-pair-key');
const formConnect = document.getElementById('form-connect');
const inputPairKey = document.getElementById('input-pair-key');
const btnConnect = document.getElementById('btn-connect');

// 1B Elements
const idleStatusDot = document.getElementById('idle-status-dot');
const idleStatusText = document.getElementById('idle-status-text');
const idleKeyValue = document.getElementById('idle-key-value');
const rosterIdle = document.getElementById('roster-idle');
const btnPairedPick = document.getElementById('btn-paired-pick');
const btnCopyInvite = document.getElementById('btn-copy-invite');
const copyBtnText = document.getElementById('copy-btn-text');
const badgeCopied = document.getElementById('badge-copied');
const btnUnpairIdle = document.getElementById('btn-unpair-idle');

// 1C Elements
const syncDomain = document.getElementById('sync-domain');
const syncPing = document.getElementById('sync-ping');
const syncStatusDot = document.getElementById('sync-status-dot');
const syncStatusText = document.getElementById('sync-status-text');
const syncMutedWarning = document.getElementById('sync-muted-warning');
const rosterSync = document.getElementById('roster-sync');
const btnEndSession = document.getElementById('btn-end-session');
const endSessionBtnText = document.getElementById('end-session-btn-text');
const btnResync = document.getElementById('btn-resync');
const resyncBtnText = document.getElementById('resync-btn-text');
const btnUnpairSync = document.getElementById('btn-unpair-sync');
const syncChipDot = document.getElementById('sync-chip-dot');
const syncChipText = document.getElementById('sync-chip-text');
const syncFooterHint = document.getElementById('sync-footer-hint');
const btnCopySyncInvite = document.getElementById('btn-copy-sync-invite');
const copySyncBtnText = document.getElementById('copy-sync-btn-text');

let currentStatus = null;
let copyTimeout = null;
let copySyncTimeout = null;
let copySyncFeedbackActive = false;
let armedTabId = null;
let displayNameDebounceTimer = null;
let kickedNoticeDismissed = false;

function isSupportedUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

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

// Copy text to clipboard with fallback
async function copyText(text) {
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

// Show visual feedback on copy invite button
function showCopiedFeedback() {
  if (copyTimeout) clearTimeout(copyTimeout);
  if (badgeCopied) badgeCopied.classList.remove('hidden');
  if (copyBtnText) copyBtnText.textContent = 'Copied!';
  copyTimeout = setTimeout(() => {
    if (badgeCopied) badgeCopied.classList.add('hidden');
    if (copyBtnText) copyBtnText.textContent = 'Copy';
    copyTimeout = null;
  }, 1500);
}

// Extract clean hostname for syncing domain label
function extractDomain(activeSession) {
  if (!activeSession) return 'Unknown video';
  if (activeSession.domain) return activeSession.domain;
  if (activeSession.pageUrl) {
    try {
      return new URL(activeSession.pageUrl).hostname;
    } catch {
      return activeSession.pageUrl;
    }
  }
  return 'Active video';
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
      kickedNotice: Boolean(res.kickedNotice)
    };
  }

  // Storage fallback
  try {
    const local = await chrome.storage.local.get(['pairKey', 'peerId', 'updateInfo', 'displayName']);
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
      displayName: local.displayName || '',
      peers,
      peerCount,
      isRoomOwner: Boolean(session.isRoomOwner),
      canKick: Boolean(session.canKick),
      kickedNotice: Boolean(session.kickedNotice)
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
      kickedNotice: false
    };
  }
}

// Render multi-person session roster into container
function renderRoster(container, status, isSyncing) {
  if (!container) return;
  container.replaceChildren();

  const peers = Array.isArray(status.peers) ? status.peers : [];
  const totalInRoom = peers.length + 1;

  // Header micro-row: SESSION · <N> IN ROOM
  const header = document.createElement('div');
  header.className = 'roster-header';
  header.textContent = `SESSION · ${totalInRoom} IN ROOM`;
  container.appendChild(header);

  const list = document.createElement('div');
  list.className = 'roster-list';

  // Self row: emerald/cyan dot + <displayName> (You) + HOST badge if activeSession?.isHost || (!activeSession && status.isRoomOwner)
  const selfRow = document.createElement('div');
  selfRow.className = 'roster-row';

  const selfDot = document.createElement('span');
  selfDot.className = isSyncing ? 'status-dot dot-cyan' : 'status-dot dot-emerald';
  selfRow.appendChild(selfDot);

  const selfName = document.createElement('span');
  selfName.className = 'roster-name self';
  const rawDisplayName = typeof status.displayName === 'string' ? status.displayName.trim() : '';
  selfName.textContent = rawDisplayName ? `${rawDisplayName} (You)` : 'You';
  selfRow.appendChild(selfName);

  const isHost = Boolean(status.activeSession?.isHost || (!status.activeSession && status.isRoomOwner));
  if (isHost) {
    const hostBadge = document.createElement('span');
    hostBadge.className = 'badge-host';
    hostBadge.textContent = 'HOST';
    selfRow.appendChild(hostBadge);
  }
  list.appendChild(selfRow);

  // Peer rows: emerald dot + peer.name || ('Peer ' + String(peer.peerId).slice(0, 4)) + HOST badge if peer.isHost + monospace ${peer.rttMs ?? '…'}ms + (when status.canKick is true) compact red .btn-kick-peer button
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
    latency.textContent = `${peer.rttMs ?? '…'}ms`;
    peerRow.appendChild(latency);

    if (status.canKick && peer.peerId) {
      const btnKick = document.createElement('button');
      btnKick.type = 'button';
      btnKick.className = 'btn-kick-peer';
      btnKick.textContent = 'Kick';
      btnKick.title = 'Remove from session';
      btnKick.setAttribute('aria-label', `Kick ${rawPeerName || peer.peerId}`);
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

  // Populate self-identification strip when not focused
  if (inputDisplayName && document.activeElement !== inputDisplayName) {
    inputDisplayName.value = currentStatus.displayName || '';
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

  // Update Header Status Chip
  if (isUnpaired) {
    chipIdle.classList.remove('hidden');
    chipStandby.classList.add('hidden');
    chipSyncing.classList.add('hidden');
  } else if (isPairedIdle) {
    chipIdle.classList.add('hidden');
    chipStandby.classList.remove('hidden');
    chipSyncing.classList.add('hidden');

    if (peerOnline || peerCount > 0) {
      standbyHeaderDot.className = 'status-dot dot-emerald';
      standbyHeaderText.textContent = `${rttMs ?? 0}ms`;
    } else {
      standbyHeaderDot.className = 'status-dot dot-muted';
      standbyHeaderText.textContent = 'STANDBY';
    }
  } else if (isSyncing) {
    chipIdle.classList.add('hidden');
    chipStandby.classList.add('hidden');
    chipSyncing.classList.remove('hidden');
  }

  // Auto-enable video picking when popup is open in Standby
  if (!isPairedIdle) {
    armedTabId = null;
  } else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && tab.id !== armedTabId && isSupportedUrl(tab.url)) {
        armedTabId = tab.id;
        sendSw({ target: 'sw', type: 'ARM_STANDBY_PICKER', tabId: tab.id });
      }
    } catch {
      // Ignore tab query errors in popup
    }
  }

  // Populate 1B Paired Standby
  if (isPairedIdle) {
    idleKeyValue.textContent = pairKey;
    if (peerCount === 0) {
      idleStatusDot.className = 'status-dot dot-muted';
      idleStatusText.textContent = 'Waiting for peers…';
    } else if (peerCount === 1) {
      idleStatusDot.className = 'status-dot dot-emerald';
      idleStatusText.textContent = '1 peer online';
    } else {
      idleStatusDot.className = 'status-dot dot-emerald';
      idleStatusText.textContent = `${peerCount} peers online`;
    }
    renderRoster(rosterIdle, currentStatus, false);
  }

  // Populate 1C Active Sync
  if (isSyncing) {
    syncDomain.textContent = extractDomain(activeSession);

    if (peerOnline || peerCount > 0) {
      chipSyncing.classList.remove('waiting');
      if (syncChipDot) syncChipDot.className = 'status-dot dot-cyan animate-pulse';
      if (syncChipText) syncChipText.textContent = 'LOCKED';
      syncPing.textContent = `${rttMs ?? 0}ms`;
      syncStatusDot.className = 'status-dot dot-emerald';
      syncStatusText.textContent = 'p2p locked · buffer match';
      if (syncFooterHint) syncFooterHint.textContent = `${peerCount + 1} browsers synced`;

      btnEndSession.className = 'btn btn-destructive flex-1';
      btnEndSession.style.order = '1';
      const isLeave = Boolean(peerCount >= 2 && !activeSession?.isHost);
      if (endSessionBtnText) endSessionBtnText.textContent = isLeave ? 'Leave' : 'End Session';

      btnResync.classList.remove('hidden');
      btnResync.style.order = '2';

      btnCopySyncInvite.className = 'btn btn-secondary btn-icon-label';
      btnCopySyncInvite.style.order = '3';
      if (!copySyncFeedbackActive && copySyncBtnText) {
        copySyncBtnText.textContent = 'Copy';
      }
    } else {
      chipSyncing.classList.add('waiting');
      if (syncChipDot) syncChipDot.className = 'status-dot dot-amber animate-pulse';
      if (syncChipText) syncChipText.textContent = 'WAITING';
      syncPing.textContent = 'Invite ready';
      syncStatusDot.className = 'status-dot dot-amber';
      syncStatusText.textContent = 'Waiting for partner to join…';
      if (syncFooterHint) syncFooterHint.textContent = 'Share invite link to connect';

      btnCopySyncInvite.className = 'btn btn-primary flex-1';
      btnCopySyncInvite.style.order = '1';
      if (!copySyncFeedbackActive && copySyncBtnText) {
        copySyncBtnText.textContent = 'Copy Invite Link';
      }

      btnEndSession.className = 'btn btn-destructive btn-icon-label';
      btnEndSession.style.order = '2';
      if (endSessionBtnText) endSessionBtnText.textContent = 'End';

      btnResync.classList.add('hidden');
      btnResync.style.order = '3';
    }

    if (isMuted) {
      syncMutedWarning.classList.remove('hidden');
    } else {
      syncMutedWarning.classList.add('hidden');
    }

    renderRoster(rosterSync, currentStatus, true);
  }
}

// Handlers
function showSyncCopiedFeedback() {
  if (copySyncTimeout) clearTimeout(copySyncTimeout);
  copySyncFeedbackActive = true;
  if (copySyncBtnText) copySyncBtnText.textContent = 'Copied!';
  copySyncTimeout = setTimeout(() => {
    copySyncFeedbackActive = false;
    copySyncTimeout = null;
    if (copySyncBtnText) {
      copySyncBtnText.textContent = currentStatus?.peerOnline ? 'Copy' : 'Copy Invite Link';
    }
  }, 1500);
}

async function handleCopySyncInvite() {
  const inviteUrl = currentStatus?.inviteUrl || (currentStatus?.pairKey
    ? `${INVITE_BASE_URL}#pair=${encodeURIComponent(currentStatus.pairKey)}`
    : null);
  if (!inviteUrl) return;
  const ok = await copyText(inviteUrl);
  if (ok) {
    showSyncCopiedFeedback();
  }
}

async function handlePairedPick() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && isSupportedUrl(tab.url)) {
      await sendSw({ target: 'sw', type: 'ARM_STANDBY_PICKER', tabId: tab.id });
    }
  } finally {
    window.close();
  }
}

async function handlePickVideo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      window.close();
      return;
    }
    const res = await sendSw({ target: 'sw', type: 'START_PICK_FLOW', tabId: tab.id });
    if (res?.inviteUrl) {
      await copyText(res.inviteUrl);
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

async function handleCopyInvite() {
  if (!currentStatus?.pairKey) return;
  const inviteUrl = `${INVITE_BASE_URL}#pair=${encodeURIComponent(currentStatus.pairKey)}`;
  const ok = await copyText(inviteUrl);
  if (ok) {
    showCopiedFeedback();
  }
}

async function handleUnpair() {
  // Optimistic instant reset to 1A
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
    kickedNotice: false
  };
  viewUnpaired.classList.remove('hidden');
  viewPairedIdle.classList.add('hidden');
  viewSyncing.classList.add('hidden');
  chipIdle.classList.remove('hidden');
  chipStandby.classList.add('hidden');
  chipSyncing.classList.add('hidden');

  await sendSw({ target: 'sw', type: 'UNPAIR' });
  await render();
}

// Display Name Debounced Saving
function saveDisplayName(val) {
  if (displayNameDebounceTimer) {
    clearTimeout(displayNameDebounceTimer);
    displayNameDebounceTimer = null;
  }
  const displayName = typeof val === 'string' ? val.trim() : '';
  if (currentStatus) {
    currentStatus.displayName = displayName;
  }
  sendSw({ target: 'sw', type: 'SET_DISPLAY_NAME', displayName });
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
  const origText = resyncBtnText.textContent;
  resyncBtnText.textContent = 'Resyncing…';
  try {
    await sendSw({ target: 'sw', type: 'RESYNC_NOW' });
  } finally {
    setTimeout(() => {
      btnResync.disabled = false;
      resyncBtnText.textContent = origText;
    }, 600);
    await render();
  }
}

// Wire Event Listeners
if (inputDisplayName) {
  inputDisplayName.addEventListener('input', () => {
    if (displayNameDebounceTimer) clearTimeout(displayNameDebounceTimer);
    displayNameDebounceTimer = setTimeout(() => {
      saveDisplayName(inputDisplayName.value);
    }, 350);
  });

  inputDisplayName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveDisplayName(inputDisplayName.value);
      inputDisplayName.blur();
    }
  });

  inputDisplayName.addEventListener('blur', () => {
    saveDisplayName(inputDisplayName.value);
  });
}

if (btnDismissKicked) {
  btnDismissKicked.addEventListener('click', async () => {
    kickedNoticeDismissed = true;
    if (kickedBanner) kickedBanner.classList.add('hidden');
    await sendSw({ target: 'sw', type: 'DISMISS_KICKED_NOTICE' });
  });
}

btnUnpairedPick.addEventListener('click', handlePickVideo);
formConnect.addEventListener('submit', handleConnect);
btnPairedPick.addEventListener('click', handlePairedPick);
btnCopyInvite.addEventListener('click', handleCopyInvite);
btnUnpairIdle.addEventListener('click', handleUnpair);
btnEndSession.addEventListener('click', handleEndSession);
btnResync.addEventListener('click', handleResync);
btnUnpairSync.addEventListener('click', handleUnpair);
btnCopySyncInvite.addEventListener('click', handleCopySyncInvite);
if (btnUpdateReload) {
  btnUpdateReload.addEventListener('click', async () => {
    btnUpdateReload.disabled = true;
    await sendSw({ target: 'sw', type: 'RELOAD_EXTENSION' });
    window.close();
  });
}

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
