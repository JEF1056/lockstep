// popup.js - Lockstep UI Controller

const INVITE_BASE_URL = 'https://jef1056.github.io/lockstep/';

// DOM Elements
const viewUnpaired = document.getElementById('view-unpaired');
const viewPairedIdle = document.getElementById('view-paired-idle');
const viewSyncing = document.getElementById('view-syncing');

const btnUnpairedPick = document.getElementById('btn-unpaired-pick');
const formConnect = document.getElementById('form-connect');
const inputPairKey = document.getElementById('pair-key');
const detailsPairKey = document.getElementById('details-pair-key');

const idleStatusDot = document.getElementById('idle-status-dot');
const idleStatusText = document.getElementById('idle-status-text');
const idleKeyValue = document.getElementById('idle-key-value');
const btnPairedPick = document.getElementById('btn-paired-pick');
const btnCopyInvite = document.getElementById('btn-copy-invite');
const copyBtnText = document.getElementById('copy-btn-text');
const iconCopy = document.getElementById('icon-copy');
const iconCopied = document.getElementById('icon-copied');
const btnUnpairIdle = document.getElementById('btn-unpair-idle');

const syncDomain = document.getElementById('sync-domain');
const syncStatusDot = document.getElementById('sync-status-dot');
const syncStatusText = document.getElementById('sync-status-text');
const btnEndSession = document.getElementById('btn-end-session');
const btnResync = document.getElementById('btn-resync');
const btnUnpairSync = document.getElementById('btn-unpair-sync');
const headerStatusIndicator = document.getElementById('header-status-indicator');

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

// Copy text with fallback
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
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

// Show visual copied feedback on copy invite button
function showCopiedFeedback() {
  if (copyTimeout) clearTimeout(copyTimeout);
  iconCopy.classList.add('hidden');
  iconCopied.classList.remove('hidden');
  copyBtnText.textContent = 'Copied!';
  copyTimeout = setTimeout(() => {
    iconCopy.classList.remove('hidden');
    iconCopied.classList.add('hidden');
    copyBtnText.textContent = 'Copy Invite Link';
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
  return 'Active tab';
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
      rttMs: session.rttMs || null,
      activeSession: session.activeSession || null,
      autoplayMuted: session.autoplayMuted || false
    };
  } catch {
    return { pairKey: null, peerOnline: false, rttMs: null, activeSession: null };
  }
}

// Render UI based on status
async function render() {
  currentStatus = await fetchStatus();
  const pairKey = currentStatus.pairKey;
  const activeSession = currentStatus.activeSession;
  const peerOnline = Boolean(currentStatus.peerOnline);
  const rttMs = currentStatus.rttMs;
  const isMuted = Boolean(currentStatus.autoplayMuted || activeSession?.autoplayMuted || activeSession?.isMuted);

  // Determine state
  const isSyncing = Boolean(pairKey && activeSession);
  const isPairedIdle = Boolean(pairKey && !activeSession);
  const isUnpaired = !pairKey;

  // Toggle views
  viewUnpaired.classList.toggle('hidden', !isUnpaired);
  viewPairedIdle.classList.toggle('hidden', !isPairedIdle);
  viewSyncing.classList.toggle('hidden', !isSyncing);

  // Header status indicator dot
  if (headerStatusIndicator) {
    const headerDot = headerStatusIndicator.querySelector('.status-dot');
    if (isSyncing || (isPairedIdle && peerOnline)) {
      headerStatusIndicator.classList.remove('hidden');
      headerDot.className = 'status-dot dot-emerald';
    } else if (isPairedIdle && !peerOnline) {
      headerStatusIndicator.classList.remove('hidden');
      headerDot.className = 'status-dot';
    } else {
      headerStatusIndicator.classList.add('hidden');
    }
  }

  if (isPairedIdle) {
    idleKeyValue.textContent = pairKey;
    if (peerOnline) {
      idleStatusDot.className = 'status-dot dot-emerald';
      idleStatusText.textContent = `Partner online · ${rttMs ?? 0}ms`;
      idleStatusText.classList.remove('text-amber');
    } else {
      idleStatusDot.className = 'status-dot';
      idleStatusText.textContent = 'Waiting for partner…';
      idleStatusText.classList.remove('text-amber');
    }
  }

  if (isSyncing) {
    syncDomain.textContent = extractDomain(activeSession);
    if (isMuted) {
      syncStatusDot.className = 'status-dot dot-amber';
      syncStatusText.textContent = 'Audio muted — click video tab to unmute';
      syncStatusText.classList.add('text-amber');
    } else {
      syncStatusDot.className = 'status-dot dot-emerald';
      syncStatusText.textContent = `LIVE · ${rttMs ?? 0}ms`;
      syncStatusText.classList.remove('text-amber');
    }
  }
}

// Primary pick video action
async function handlePickVideo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      window.close();
      return;
    }
    const res = await sendSw({ target: 'sw', type: 'START_PICK_FLOW', tabId: tab.id });
    if (res && res.inviteUrl) {
      await copyText(res.inviteUrl);
    }
  } finally {
    window.close();
  }
}

// Connect form submit
async function handleConnect(e) {
  e.preventDefault();
  const pairKey = inputPairKey.value.trim();
  if (!pairKey) return;
  inputPairKey.disabled = true;
  await sendSw({ target: 'sw', type: 'SET_PAIR_KEY', pairKey });
  inputPairKey.disabled = false;
  inputPairKey.value = '';
  if (detailsPairKey) detailsPairKey.removeAttribute('open');
  await render();
}

// Copy invite link
async function handleCopyInvite() {
  if (!currentStatus?.pairKey) return;
  const inviteUrl = `${INVITE_BASE_URL}#pair=${encodeURIComponent(currentStatus.pairKey)}`;
  const ok = await copyText(inviteUrl);
  if (ok) {
    showCopiedFeedback();
  }
}

// Unpair
async function handleUnpair() {
  await sendSw({ target: 'sw', type: 'UNPAIR' });
  await render();
}

// End Session
async function handleEndSession() {
  await sendSw({ target: 'sw', type: 'END_SESSION' });
  await render();
}

// Resync Now
async function handleResync() {
  btnResync.disabled = true;
  const origText = btnResync.querySelector('span').textContent;
  btnResync.querySelector('span').textContent = 'Resyncing…';
  await sendSw({ target: 'sw', type: 'RESYNC_NOW' });
  setTimeout(() => {
    btnResync.disabled = false;
    btnResync.querySelector('span').textContent = origText;
  }, 600);
  await render();
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

// Listen for storage updates
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(() => {
    render();
  });
}

// Initial render + 1s periodic poll
render();
const pollTimer = setInterval(render, 1000);
window.addEventListener('unload', () => clearInterval(pollTimer));
