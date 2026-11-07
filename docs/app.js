// docs/app.js - Lockstep Web Application Router & Interactivity
(function () {
  'use strict';

  let redirectTimer = null;

  function isMobileOrTablet() {
    const ua = navigator.userAgent || '';
    const isTouchMac = Boolean(navigator.maxTouchPoints && navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i.test(ua) || isTouchMac;
  }

  function isChromiumDesktop() {
    if (isMobileOrTablet()) return false;
    const ua = navigator.userAgent || '';
    const isChromeOrChromium = /Chrome|Chromium|Edg|OPR|Brave/i.test(ua) || Boolean(window.chrome);
    const isFirefox = /Firefox/i.test(ua);
    const isSafariOnly = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua);
    return isChromeOrChromium && !isFirefox && !isSafariOnly;
  }

  function parseHash() {
    const rawHash = window.location.hash.replace(/^#/, '');
    if (!rawHash) return { pair: '', url: '', src: '', paired: false };
    const params = new URLSearchParams(rawHash);
    return {
      pair: params.get('pair') || '',
      url: params.get('url') || '',
      src: params.get('src') || '',
      paired: params.get('paired') === '1' || rawHash.includes('paired=1')
    };
  }

  function copyText(text, labelEl) {
    if (!text) return;
    const originalText = labelEl ? labelEl.textContent : 'Copy';
    const setSuccess = () => {
      if (labelEl) {
        labelEl.textContent = 'Copied!';
        setTimeout(() => {
          labelEl.textContent = originalText;
        }, 2000);
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(setSuccess).catch(() => {
        fallbackCopy(text, setSuccess);
      });
    } else {
      fallbackCopy(text, setSuccess);
    }
  }

  function fallbackCopy(text, cb) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      cb();
    } catch (_) {}
  }

  function render() {
    if (redirectTimer) {
      clearTimeout(redirectTimer);
      redirectTimer = null;
    }

    const queryParams = new URLSearchParams(window.location.search);
    const previewScreen = queryParams.get('screen');
    const hashData = parseHash();

    // Determine target active screen
    let activeScreen = 'onboarding';
    if (previewScreen && ['unsupported', 'onboarding', 'paired'].includes(previewScreen)) {
      activeScreen = previewScreen;
    } else if (hashData.paired) {
      activeScreen = 'paired';
    } else if (!isChromiumDesktop()) {
      activeScreen = 'unsupported';
    } else {
      activeScreen = 'onboarding';
    }

    // Toggle screen views
    const screens = ['unsupported', 'onboarding', 'paired'];
    screens.forEach(id => {
      const el = document.getElementById(`screen-${id}`);
      if (el) {
        if (id === activeScreen) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    });

    // Header badge state
    const headerBadge = document.getElementById('header-badge');
    if (headerBadge) {
      if (activeScreen === 'unsupported') {
        headerBadge.className = 'header-badge badge-unsupported';
        headerBadge.innerHTML = '<span class="badge-dot dot-warning"></span><span>Desktop Required</span>';
      } else if (activeScreen === 'paired') {
        headerBadge.className = 'header-badge badge-paired';
        headerBadge.innerHTML = '<span class="badge-dot dot-accent pulse-anim"></span><span>Paired</span>';
      } else {
        headerBadge.className = 'header-badge badge-onboarding';
        headerBadge.innerHTML = '<span class="badge-dot dot-accent pulse-anim"></span><span class="text-primary font-semibold">Invite Active · ~14ms</span>';
      }
    }

    // Populate Unsupported View
    const unsupportedInput = document.getElementById('unsupported-url-input');
    if (unsupportedInput) {
      unsupportedInput.value = window.location.href;
    }

    // Populate Onboarding View
    const onboardingKey = document.getElementById('onboarding-key');
    const onboardingTargetSec = document.getElementById('onboarding-target-section');
    const onboardingHost = document.getElementById('onboarding-host');
    const onboardingUrl = document.getElementById('onboarding-url');

    const pairKey = hashData.pair || (previewScreen ? 'lk-7x9q-v2m1' : '');
    if (onboardingKey) {
      onboardingKey.textContent = pairKey || 'Ready for pairing';
    }

    const targetUrl = hashData.url || (previewScreen ? 'https://aniwaves.ru/watch/solo-leveling-ep-12' : '');
    if (targetUrl) {
      if (onboardingTargetSec) onboardingTargetSec.classList.remove('hidden');
      if (onboardingUrl) onboardingUrl.textContent = targetUrl;
      if (onboardingHost) {
        try {
          const parsedUrl = new URL(targetUrl);
          onboardingHost.textContent = parsedUrl.hostname;
        } catch (_) {
          onboardingHost.textContent = targetUrl;
        }
      }
    } else if (onboardingTargetSec && !previewScreen) {
      onboardingTargetSec.classList.add('hidden');
    }

    // Populate Paired View
    const pairedDestRow = document.getElementById('paired-dest-row');
    const pairedDestUrl = document.getElementById('paired-dest-url');
    const pairedCountdown = document.getElementById('paired-countdown');
    const btnOpenVideo = document.getElementById('btn-open-video');
    const pairedSubtext = document.getElementById('paired-subtext');

    const videoDest = hashData.url || (previewScreen ? 'https://aniwaves.ru/watch/solo-leveling-ep-12' : '');
    if (videoDest) {
      if (pairedDestRow) pairedDestRow.classList.remove('hidden');
      if (pairedDestUrl) pairedDestUrl.textContent = videoDest.replace(/^https?:\/\//i, '');
      if (pairedCountdown) pairedCountdown.textContent = '1s';
      if (btnOpenVideo) {
        btnOpenVideo.href = videoDest;
        btnOpenVideo.classList.remove('hidden');
      }
      if (pairedSubtext) pairedSubtext.textContent = 'Opening synced video tab…';

      // Auto-redirect after 1 second if this is a live paired event (not preview parameter)
      if (activeScreen === 'paired' && !previewScreen) {
        redirectTimer = setTimeout(() => {
          window.location.href = videoDest;
        }, 1000);
      }
    } else {
      if (pairedDestRow) pairedDestRow.classList.add('hidden');
      if (btnOpenVideo) btnOpenVideo.classList.add('hidden');
      if (pairedSubtext) pairedSubtext.textContent = 'Browsers connected and in sync.';
    }
  }

  // Bind click handlers
  function initListeners() {
    const btnCopyUnsupported = document.getElementById('btn-copy-unsupported');
    const unsupportedText = document.getElementById('btn-copy-unsupported-text');
    if (btnCopyUnsupported) {
      btnCopyUnsupported.addEventListener('click', () => {
        copyText(window.location.href, unsupportedText);
      });
    }

    const btnCopyKey = document.getElementById('btn-copy-key');
    const copyKeyText = document.getElementById('btn-copy-key-text');
    if (btnCopyKey) {
      btnCopyKey.addEventListener('click', () => {
        const onboardingKey = document.getElementById('onboarding-key');
        const key = onboardingKey ? onboardingKey.textContent : '';
        copyText(key, copyKeyText);
      });
    }

    window.addEventListener('hashchange', render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initListeners();
      render();
    });
  } else {
    initListeners();
    render();
  }
})();
