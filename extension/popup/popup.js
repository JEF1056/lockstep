// popup.js - Lockstep Prismatic Studio UI Controller

const INVITE_BASE_URL = 'https://jef1056.github.io/lockstep/';

// DOM Elements
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
const standbySubdot = document.getElementById('standby-subdot');
const standbySubtext = document.getElementById('standby-subtext');
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
const btnEndSession = document.getElementById('btn-end-session');
const btnResync = document.getElementById('btn-resync');
const resyncBtnText = document.getElementById('resync-btn-text');
const btnUnpairSync = document.getElementById('btn-unpair-sync');

let currentStatus = null;
let copyTimeout = null;

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
    return res;
  }

  // Storage fallback
  try {
    const local = await chrome.storage.local.get(['pairKey', 'peerId']);
    const session = chrome.storage.session
      ? await chrome.storage.session.get(['activeSession', 'peerOnline', 'rttMs', 'autoplayMuted'])
      : {};
    return {
      pairKey: local.pairKey || null,
      peerOnline: session.peerOnline || false,
      rttMs: session.rttMs ?? null,
      activeSession: session.activeSession || null,
      autoplayMuted: session.autoplayMuted || false
    };
  } catch {
    return { pairKey: null, peerOnline: false, rttMs: null, activeSession: null, autoplayMuted: false };
  }
}

// Render UI based on current status
async function render() {
  currentStatus = await fetchStatus();
  const pairKey = currentStatus.pairKey;
  const activeSession = currentStatus.activeSession;
  const peerOnline = Boolean(currentStatus.peerOnline);
  const rttMs = currentStatus.rttMs;
  const isMuted = Boolean(currentStatus.autoplayMuted || activeSession?.autoplayMuted || activeSession?.isMuted);

  const isSyncing = Boolean(pairKey && activeSession);
  const isPairedIdle = Boolean(pairKey && !activeSession);
  const isUnpaired = !pairKey;

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

    if (peerOnline) {
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

  // Populate 1B Paired Standby
  if (isPairedIdle) {
    idleKeyValue.textContent = pairKey;
    if (peerOnline) {
      idleStatusDot.className = 'status-dot dot-emerald';
      idleStatusText.textContent = 'Partner online';
      standbySubdot.className = 'status-dot dot-emerald';
      standbySubtext.textContent = 'Synced peer ready';
    } else {
      idleStatusDot.className = 'status-dot dot-muted';
      idleStatusText.textContent = 'Waiting for partner…';
      standbySubdot.className = 'status-dot dot-muted';
      standbySubtext.textContent = 'Waiting for partner…';
    }
  }

  // Populate 1C Active Sync
  if (isSyncing) {
    syncDomain.textContent = extractDomain(activeSession);
    syncPing.textContent = `${rttMs ?? 0}ms`;
    syncStatusDot.className = 'status-dot dot-emerald';
    syncStatusText.textContent = 'p2p locked · buffer match';

    if (isMuted) {
      syncMutedWarning.classList.remove('hidden');
    } else {
      syncMutedWarning.classList.add('hidden');
    }
  }
}

// Handlers
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
  const pairKey = inputPairKey.value.trim();
  if (!pairKey) return;
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
btnUnpairedPick.addEventListener('click', handlePickVideo);
formConnect.addEventListener('submit', handleConnect);
btnPairedPick.addEventListener('click', handlePickVideo);
btnCopyInvite.addEventListener('click', handleCopyInvite);
btnUnpairIdle.addEventListener('click', handleUnpair);
btnEndSession.addEventListener('click', handleEndSession);
btnResync.addEventListener('click', handleResync);
btnUnpairSync.addEventListener('click', handleUnpair);

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
