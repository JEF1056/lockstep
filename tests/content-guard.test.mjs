// tests/content-guard.test.mjs - Unit tests for content scripts and zero-DOM-injection guards
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createSyncEngine } from '../extension/shared/sync-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const CONTENT_MAIN_PATH = path.join(ROOT_DIR, 'extension/content/content-main.js');
const CONTENT_PATH = path.join(ROOT_DIR, 'extension/content/content.js');

describe('Content Guard - Zero DOM Injection Static AST / Token Check', () => {
  const forbiddenPatternsInMain = [
    { pattern: /\.appendChild\s*\(/, name: 'appendChild' },
    { pattern: /\.insertBefore\s*\(/, name: 'insertBefore' },
    { pattern: /\.attachShadow\s*\(/, name: 'attachShadow' },
    { pattern: /\.innerHTML\s*=/, name: 'innerHTML assignment' },
    { pattern: /\.insertAdjacentHTML\s*\(/, name: 'insertAdjacentHTML' },
    { pattern: /\.insertAdjacentElement\s*\(/, name: 'insertAdjacentElement' },
    { pattern: /document\.createElement\s*\(/, name: 'document.createElement' },
    { pattern: /document\.createElementNS\s*\(/, name: 'document.createElementNS' }
  ];

  test('content-main.js contains zero forbidden DOM mutation or creation calls', () => {
    const code = fs.readFileSync(CONTENT_MAIN_PATH, 'utf-8');
    for (const { pattern, name } of forbiddenPatternsInMain) {
      assert.equal(
        pattern.test(code),
        false,
        `content-main.js must not contain ${name}`
      );
    }
  });

  const bannedHtmlPatterns = [
    { pattern: /\.innerHTML\b/, name: 'innerHTML' },
    { pattern: /\.outerHTML\b/, name: 'outerHTML' },
    { pattern: /\.insertAdjacentHTML\b/, name: 'insertAdjacentHTML' }
  ];

  test('all extension/content/*.js files ban innerHTML, outerHTML, and insertAdjacentHTML', () => {
    const contentDir = path.join(ROOT_DIR, 'extension/content');
    const contentFiles = fs.readdirSync(contentDir).filter(f => f.endsWith('.js'));
    assert.ok(contentFiles.length > 0, 'content files should exist');
    for (const file of contentFiles) {
      const code = fs.readFileSync(path.join(contentDir, file), 'utf-8');
      for (const { pattern, name } of bannedHtmlPatterns) {
        assert.equal(
          pattern.test(code),
          false,
          `${file} must not contain ${name}`
        );
      }
    }
  });
});

describe('content-main.js - Popup Suppression & Cadmium Control', () => {
  let sandbox;
  let eventListeners;
  let dispatchedEvents;

  beforeEach(() => {
    eventListeners = {};
    dispatchedEvents = [];

    const mockWindow = {
      open: () => 'original_window_opened',
      addEventListener: (evt, handler) => {
        if (!eventListeners[evt]) eventListeners[evt] = [];
        eventListeners[evt].push(handler);
      },
      removeEventListener: (evt, handler) => {
        if (eventListeners[evt]) {
          eventListeners[evt] = eventListeners[evt].filter(h => h !== handler);
        }
      },
      dispatchEvent: (evt) => {
        dispatchedEvents.push(evt);
        if (eventListeners[evt.type]) {
          for (const h of eventListeners[evt.type]) {
            h(evt);
          }
        }
        return true;
      },
      netflix: null
    };
    mockWindow.window = mockWindow;

    sandbox = {
      window: mockWindow,
      setTimeout,
      clearTimeout,
      CustomEvent,
      console
    };

    const code = fs.readFileSync(CONTENT_MAIN_PATH, 'utf-8');
    vm.runInNewContext(code, sandbox);
  });

  test('suppresses window.open temporarily and restores original', async () => {
    const origOpen = sandbox.window.open;
    assert.equal(origOpen(), 'original_window_opened');

    // Trigger popup suppression via event
    sandbox.window.dispatchEvent(
      new CustomEvent('__lockstep_main', {
        detail: { action: 'suppressPopups', duration: 50, requestId: 'req-1' }
      })
    );

    // window.open should now be a no-op returning null
    assert.notEqual(sandbox.window.open, origOpen);
    assert.equal(sandbox.window.open('https://ad.example.com'), null);

    // Verify ACK event
    const ack = dispatchedEvents.find(e => e.type === '__lockstep_main_ack' && e.detail?.requestId === 'req-1');
    assert.ok(ack, 'ACK event should be dispatched');
    assert.equal(ack.detail.ok, true);
    assert.deepEqual({ ...ack.detail.result }, { suppressed: true });

    // Wait for timeout to restore original window.open
    await new Promise(r => setTimeout(r, 70));
    assert.equal(sandbox.window.open(), 'original_window_opened');
  });

  test('controls Netflix Cadmium video player API (play, pause, seek, getState)', () => {
    let played = false;
    let paused = false;
    let seekTime = 0;

    const mockPlayer = {
      play: () => { played = true; },
      pause: () => { paused = true; },
      seek: (t) => { seekTime = t; },
      isPaused: () => false,
      getCurrentTime: () => 12500, // 12.5s
      getDuration: () => 120000 // 120s
    };

    sandbox.window.netflix = {
      appContext: {
        state: {
          playerApp: {
            getAPI: () => ({
              videoPlayer: {
                getAllPlayerSessionIds: () => ['session-123'],
                getVideoPlayerBySessionId: (id) => (id === 'session-123' ? mockPlayer : null)
              }
            })
          }
        }
      }
    };

    // Test Play
    sandbox.window.dispatchEvent(
      new CustomEvent('__lockstep_main', {
        detail: { action: 'play', requestId: 'play-1' }
      })
    );
    assert.equal(played, true);
    const playAck = dispatchedEvents.find(e => e.type === '__lockstep_main_ack' && e.detail?.requestId === 'play-1');
    assert.ok(playAck, 'play ack should be dispatched');
    assert.equal(playAck.detail.ok, true);
    assert.deepEqual({ ...playAck.detail.result }, { played: true });

    // Test Pause
    sandbox.window.dispatchEvent(
      new CustomEvent('__lockstep_main', {
        detail: { action: 'pause', requestId: 'pause-1' }
      })
    );
    assert.equal(paused, true);
    const pauseAck = dispatchedEvents.find(e => e.type === '__lockstep_main_ack' && e.detail?.requestId === 'pause-1');
    assert.ok(pauseAck, 'pause ack should be dispatched');
    assert.equal(pauseAck.detail.ok, true);
    assert.deepEqual({ ...pauseAck.detail.result }, { paused: true });

    // Test Seek (seconds to ms)
    sandbox.window.dispatchEvent(
      new CustomEvent('__lockstep_main', {
        detail: { action: 'seek', time: 45.5, requestId: 'seek-1' }
      })
    );
    assert.equal(seekTime, 45500);
    const seekAck = dispatchedEvents.find(e => e.type === '__lockstep_main_ack' && e.detail?.requestId === 'seek-1');
    assert.ok(seekAck, 'seek ack should be dispatched');
    assert.equal(seekAck.detail.ok, true);

    // Test getState
    sandbox.window.dispatchEvent(
      new CustomEvent('__lockstep_main', {
        detail: { action: 'getState', requestId: 'state-1' }
      })
    );
    const stateAck = dispatchedEvents.find(e => e.type === '__lockstep_main_ack' && e.detail?.requestId === 'state-1');
    assert.ok(stateAck, 'state ack should be dispatched');
    assert.equal(stateAck.detail.ok, true);
    assert.deepEqual({ ...stateAck.detail.result }, {
      paused: false,
      time: 12.5,
      duration: 120
    });
  });

  test('reports error when Cadmium player is unavailable', () => {
    sandbox.window.netflix = null;
    sandbox.window.dispatchEvent(
      new CustomEvent('__lockstep_main', {
        detail: { action: 'play', requestId: 'err-1' }
      })
    );
    const errAck = dispatchedEvents.find(e => e.type === '__lockstep_main_ack' && e.detail?.requestId === 'err-1');
    assert.ok(errAck, 'err ack should be dispatched');
    assert.equal(errAck.detail.ok, false);
    assert.ok(errAck.detail.error.includes('Cadmium'));
  });

  test('idempotency guard prevents duplicate initialization in content-main.js', () => {
    assert.equal(sandbox.window.__lockstepMainLoaded, true);
    const code = fs.readFileSync(CONTENT_MAIN_PATH, 'utf-8');
    const initialListenerCount = eventListeners['__lockstep_main']?.length || 0;
    vm.runInNewContext(code, sandbox);
    assert.equal(eventListeners['__lockstep_main']?.length, initialListenerCount);
  });
});

describe('content.js - Overlay Piercing & Element Picker', () => {
  let sandbox;
  let mockWindow;
  let mockDoc;
  let mockChrome;
  let mockVideo;
  let sentMessages;
  let docElement;
  let docBody;

  class MockElement {
    constructor(tagName, ns) {
      this.tagName = tagName.toUpperCase();
      this.namespaceURI = ns || null;
      this.id = '';
      this.className = '';
      this.textContent = '';
      this.style = {};
      this.attributes = {};
      this.children = [];
      this.parentNode = null;
      this.shadowRoot = null;
      this._shadowRoot = null;
      this._listeners = {};
    }
    setAttribute(name, val) {
      this.attributes[name] = String(val);
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    appendChild(child) {
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    insertBefore(newChild, refChild) {
      if (newChild.parentNode && typeof newChild.parentNode.removeChild === 'function') {
        newChild.parentNode.removeChild(newChild);
      }
      const idx = this.children.indexOf(refChild);
      if (idx === -1) {
        this.children.push(newChild);
      } else {
        this.children.splice(idx, 0, newChild);
      }
      newChild.parentNode = this;
      return newChild;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    remove() {
      if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
        this.parentNode.removeChild(this);
      }
    }
    attachShadow({ mode }) {
      const shadow = new MockElement('SHADOW-ROOT');
      this._shadowRoot = shadow;
      if (mode !== 'closed') {
        this.shadowRoot = shadow;
      }
      return shadow;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    querySelector(sel) {
      return null;
    }
    querySelectorAll(sel) {
      return [];
    }
    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter(f => f !== fn);
      }
    }
  }

  beforeEach(() => {
    sentMessages = [];

    mockVideo = {
      tagName: 'VIDEO',
      nodeType: 1,
      paused: true,
      currentTime: 14.2,
      playbackRate: 1,
      duration: 300,
      videoWidth: 1280,
      videoHeight: 720,
      muted: false,
      style: { cursor: '' },
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 900, bottom: 600, width: 800, height: 500 }),
      addEventListener: () => {},
      removeEventListener: () => {},
      play: async () => {},
      pause: () => {}
    };

    const windowListeners = {};
    mockWindow = {
      addEventListener: (type, fn) => {
        if (!windowListeners[type]) windowListeners[type] = [];
        windowListeners[type].push(fn);
      },
      removeEventListener: (type, fn) => {
        if (windowListeners[type]) {
          windowListeners[type] = windowListeners[type].filter(f => f !== fn);
        }
      },
      dispatchEvent: (evt) => {
        if (windowListeners[evt.type]) {
          for (const fn of windowListeners[evt.type]) fn(evt);
        }
        return true;
      },
      location: { origin: 'https://video.example.com', href: 'https://video.example.com/watch' },
      navigator: {
        clipboard: {
          writeText: async (text) => { mockWindow._copiedText = text; }
        }
      },
      _listeners: windowListeners
    };
    mockWindow.top = mockWindow;
    mockWindow.window = mockWindow;

    docElement = new MockElement('HTML');
    docBody = new MockElement('BODY');
    docElement.appendChild(docBody);

    mockDoc = {
      readyState: 'complete',
      body: docBody,
      documentElement: docElement,
      createElement: (tag) => new MockElement(tag),
      createElementNS: (ns, tag) => new MockElement(tag, ns),
      getElementById: (id) => {
        function search(el) {
          if (!el) return null;
          if (el.id === id) return el;
          for (const c of (el.children || [])) {
            const found = search(c);
            if (found) return found;
          }
          return null;
        }
        return search(docElement);
      },
      querySelectorAll: (sel) => {
        if (sel === 'video') return [mockVideo];
        return [];
      },
      querySelector: (sel) => {
        if (sel === 'video') return mockVideo;
        return null;
      },
      elementsFromPoint: (x, y) => {
        const overlay = new MockElement('DIV');
        overlay.className = 'ad-overlay-shield';
        overlay.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 });
        if (x >= 100 && x <= 900 && y >= 100 && y <= 600) {
          return [overlay, mockVideo];
        }
        return [overlay];
      }
    };

    mockChrome = {
      runtime: {
        getURL: (p) => path.join(ROOT_DIR, 'extension', p),
        sendMessage: async (msg) => {
          sentMessages.push(msg);
          if (msg.type === 'VIDEO_PICKED') {
            return { ok: true, copyInvite: true, inviteUrl: 'https://jef1056.github.io/lockstep/#pair=testkey' };
          }
          return { ok: true };
        },
        onMessage: {
          _listeners: [],
          addListener: (fn) => { mockChrome.runtime.onMessage._listeners.push(fn); }
        }
      },
      dom: {
        openOrClosedShadowRoot: () => null
      }
    };

    sandbox = {
      window: mockWindow,
      navigator: mockWindow.navigator,
      document: mockDoc,
      chrome: mockChrome,
      __createSyncEngine: createSyncEngine,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      CustomEvent,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      WeakSet,
      URL,
      console
    };
    sandbox.globalThis = sandbox;

    const code = fs.readFileSync(CONTENT_PATH, 'utf-8');
    vm.runInNewContext(code, sandbox);
  });

  afterEach(() => {
    const onMessage = mockChrome?.runtime?.onMessage?._listeners?.[0];
    if (onMessage) {
      onMessage({ type: 'CANCEL_PICKER' }, {}, () => {});
      onMessage({ type: 'DETACH_SYNC' }, {}, () => {});
    }
  });

  test('0 Lockstep DOM nodes before START_PICKER, candidate overlay creation on START_PICKER, and 0 nodes after CANCEL_PICKER', () => {
    // 1. Verify 0 Lockstep DOM nodes before START_PICKER
    assert.equal(mockDoc.getElementById('__lockstep-picker-host'), null);
    assert.equal(docElement.children.length, 1); // only body

    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    assert.ok(onMessage, 'onMessage listener should be registered');

    // 2. Start picker
    let startRes;
    onMessage({ type: 'START_PICKER' }, {}, (r) => { startRes = r; });
    assert.equal(startRes.active, true);

    const host = mockDoc.getElementById('__lockstep-picker-host');
    assert.ok(host, '__lockstep-picker-host should be mounted in document');
    assert.equal(host.style.position, 'fixed');
    assert.equal(host.style.inset, '0');
    assert.equal(host.style.zIndex, '2147483647');
    assert.equal(host.style.pointerEvents, 'none');

    // Closed shadow DOM: external shadowRoot is null, internal shadow has candidate card
    assert.equal(host.shadowRoot, null);
    assert.ok(host._shadowRoot);
    assert.equal(host._shadowRoot.children.length, 1);

    const card = host._shadowRoot.children[0];
    assert.equal(card.style.border, '1.5px dashed rgba(0,229,255,0.65)');
    assert.equal(card.style.left, '100px');
    assert.equal(card.style.top, '100px');
    assert.equal(card.style.width, '800px');
    assert.equal(card.style.height, '500px');

    // Pill in card has resting state
    const pill = card.children[0];
    assert.ok(pill);
    const label = pill.children.find(c => c.textContent === 'Selectable video');
    assert.ok(label, 'Resting pill should say "Selectable video"');

    // 3. Cancel picker
    let cancelRes;
    onMessage({ type: 'CANCEL_PICKER' }, {}, (r) => { cancelRes = r; });
    assert.equal(cancelRes.active, false);

    // Verify 0 Lockstep DOM nodes after CANCEL_PICKER
    assert.equal(mockDoc.getElementById('__lockstep-picker-host'), null);
    assert.equal(docElement.children.includes(host), false);
    assert.equal(docElement.style.cursor || '', '');
  });

  test('null return on non-video hover keeps cursor default and card resting', () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    onMessage({ type: 'START_PICKER' }, {}, () => {});

    const host = mockDoc.getElementById('__lockstep-picker-host');
    assert.ok(host);
    const card = host._shadowRoot.children[0];

    // Simulate pointermove over non-video coordinate (x=50, y=50)
    const moveListeners = mockWindow._listeners['pointermove'] || [];
    assert.ok(moveListeners.length > 0);
    moveListeners[0]({ clientX: 50, clientY: 50 });

    // Cursor should NOT be pointer
    assert.notEqual(docElement.style.cursor, 'pointer');
    // Card should remain dashed resting style
    assert.equal(card.style.border, '1.5px dashed rgba(0,229,255,0.65)');

    onMessage({ type: 'CANCEL_PICKER' }, {}, () => {});
  });

  test('hovering over video updates card styles, displays interlocking mark, and sets pointer cursor', () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    onMessage({ type: 'START_PICKER' }, {}, () => {});

    const host = mockDoc.getElementById('__lockstep-picker-host');
    assert.ok(host);
    const card = host._shadowRoot.children[0];

    // Simulate pointermove over video (x=200, y=200)
    const moveListeners = mockWindow._listeners['pointermove'] || [];
    moveListeners[0]({ clientX: 200, clientY: 200 });

    // Cursor should be pointer
    assert.equal(docElement.style.cursor, 'pointer');

    // Card should have hovered styles
    assert.equal(card.style.border, '2px solid #00E5FF');
    assert.ok(card.style.background.includes('linear-gradient'));
    assert.ok(card.style.boxShadow.includes('24px'));

    // Pill should have "Click to sync"
    const pill = card.children[0];
    const clickLabel = pill.children.find(c => c.textContent === 'Click to sync');
    assert.ok(clickLabel, 'Pill should display "Click to sync" on hover');

    // Simulate pointermove away to non-video coordinate
    moveListeners[0]({ clientX: 50, clientY: 50 });
    assert.notEqual(docElement.style.cursor, 'pointer');
    assert.equal(card.style.border, '1.5px dashed rgba(0,229,255,0.65)');

    onMessage({ type: 'CANCEL_PICKER' }, {}, () => {});
  });

  test('non-blocking outside click dismisses picker and sends PICKER_DISMISSED without preventDefault', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    onMessage({ type: 'START_PICKER' }, {}, () => {});
    assert.ok(mockDoc.getElementById('__lockstep-picker-host'));

    let prevented = false;
    let stopped = false;
    const clickListeners = mockWindow._listeners['click'] || [];
    assert.ok(clickListeners.length > 0);

    // Simulate click outside any video (x=50, y=50)
    await clickListeners[0]({
      clientX: 50,
      clientY: 50,
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; }
    });

    // Outside click must NOT be prevented or stopped
    assert.equal(prevented, false);
    assert.equal(stopped, false);

    // Host removed (0 Lockstep DOM nodes)
    assert.equal(mockDoc.getElementById('__lockstep-picker-host'), null);

    // SW notified of dismissal
    const dismissedMsg = sentMessages.find(m => m.type === 'PICKER_DISMISSED');
    assert.ok(dismissedMsg, 'PICKER_DISMISSED message should be sent to SW');
    assert.equal(dismissedMsg.target, 'sw');
  });

  test('Escape key cancels picker, removes overlay host, and sends PICKER_DISMISSED', () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    onMessage({ type: 'START_PICKER' }, {}, () => {});
    assert.ok(mockDoc.getElementById('__lockstep-picker-host'));

    const moveListeners = mockWindow._listeners['pointermove'];
    moveListeners[0]({ clientX: 200, clientY: 200 });
    assert.equal(docElement.style.cursor, 'pointer');

    let prevented = false;
    let stopped = false;
    const keyListeners = mockWindow._listeners['keydown'] || [];
    keyListeners[0]({
      key: 'Escape',
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; }
    });

    assert.equal(prevented, true);
    assert.equal(stopped, true);

    // Host removed (0 Lockstep DOM nodes)
    assert.equal(mockDoc.getElementById('__lockstep-picker-host'), null);
    assert.equal(docElement.style.cursor, '');

    const dismissedMsg = sentMessages.find(m => m.type === 'PICKER_DISMISSED');
    assert.ok(dismissedMsg);
    assert.equal(dismissedMsg.target, 'sw');
  });

  test('pierces overlay shields, blocks pop-unders, copies invite on pick, and leaves 0 DOM nodes after VIDEO_PICKED', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    onMessage({ type: 'START_PICKER' }, {}, () => {});
    assert.ok(mockDoc.getElementById('__lockstep-picker-host'));

    let prevented = false;
    let stopped = false;
    const clickListeners = mockWindow._listeners['click'] || [];
    assert.ok(clickListeners.length > 0);

    // Simulate click on overlay at x=200, y=200
    await clickListeners[0]({
      clientX: 200,
      clientY: 200,
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; }
    });

    // Pop-under blocked
    assert.equal(prevented, true);
    assert.equal(stopped, true);

    // Message sent to SW
    const pickedMsg = sentMessages.find(m => m.type === 'VIDEO_PICKED');
    assert.ok(pickedMsg, 'VIDEO_PICKED message should be sent');
    assert.equal(pickedMsg.target, 'sw');
    assert.equal(pickedMsg.frameOrigin, 'https://video.example.com');
    assert.equal(pickedMsg.state.time, 14.2);
    assert.equal(pickedMsg.duration, 300);
    assert.equal(pickedMsg.hasVideo, true);
    assert.equal(pickedMsg.area, 800 * 500);

    // Auto-copied invite link
    assert.equal(mockWindow._copiedText, 'https://jef1056.github.io/lockstep/#pair=testkey');

    // 0 Lockstep DOM nodes after VIDEO_PICKED
    assert.equal(mockDoc.getElementById('__lockstep-picker-host'), null);
  });

  test('pointer action triggers 600ms popup suppression and pickTarget blocks mouseup/click for 500ms', async () => {
    let dispatchedMainEvent = null;
    mockWindow.dispatchEvent = (evt) => {
      if (evt.type === '__lockstep_main') dispatchedMainEvent = evt;
      return true;
    };
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    onMessage({ type: 'START_PICKER' }, {}, () => {});

    // Simulate pointerdown
    const pointerdown = (mockWindow._listeners['pointerdown'] || [])[0];
    assert.ok(pointerdown);
    let pdPrevented = false;
    let pdStopped = false;
    pointerdown({
      clientX: 200,
      clientY: 200,
      preventDefault: () => { pdPrevented = true; },
      stopImmediatePropagation: () => { pdStopped = true; }
    });
    assert.equal(pdPrevented, true);
    assert.equal(pdStopped, true);
    assert.equal(dispatchedMainEvent?.detail?.action, 'suppressPopups');
    assert.equal(dispatchedMainEvent?.detail?.duration, 600);

    // Verify 500ms capture blockers attached on window for mouseup/click
    const clickBlockers = mockWindow._listeners['click'] || [];
    assert.ok(clickBlockers.length > 0);
  });

  test('idempotency guard prevents duplicate initialization in content.js', () => {
    assert.equal(sandbox.window.__lockstepContentLoaded, true);
    const code = fs.readFileSync(CONTENT_PATH, 'utf-8');
    const listenerCount = mockChrome.runtime.onMessage._listeners.length;
    vm.runInNewContext(code, sandbox);
    assert.equal(mockChrome.runtime.onMessage._listeners.length, listenerCount);
  });
});

describe('content.js - Multi-Source & Embedded Mirrors', () => {
  let sandbox;
  let mockWindow;
  let mockDoc;
  let mockChrome;

  beforeEach(() => {
    mockWindow = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      location: { origin: 'https://aniwaves.example', href: 'https://aniwaves.example/watch/ep-1' }
    };
    mockWindow.top = mockWindow;
    mockWindow.window = mockWindow;

    const mockButtons = [
      {
        getAttribute: (k) => (k === 'data-server' ? 'vidstream' : null),
        classList: { contains: (c) => c === 'active' },
        textContent: 'Vidstream',
        click: () => { mockButtons[0]._clicked = true; },
        _clicked: false
      },
      {
        getAttribute: (k) => (k === 'data-server' ? 'megacloud' : null),
        classList: { contains: () => false },
        textContent: 'MegaCloud',
        click: () => { mockButtons[1]._clicked = true; },
        _clicked: false
      }
    ];

    mockDoc = {
      readyState: 'complete',
      querySelectorAll: (sel) => {
        if (sel === 'video') return [];
        return mockButtons;
      },
      querySelector: (sel) => {
        if (sel.includes('.active') || sel.includes('active')) return mockButtons[0];
        return null;
      },
      elementsFromPoint: () => []
    };

    mockChrome = {
      runtime: {
        getURL: (p) => path.join(ROOT_DIR, 'extension', p),
        sendMessage: async () => ({ ok: true }),
        onMessage: {
          _listeners: [],
          addListener: (fn) => { mockChrome.runtime.onMessage._listeners.push(fn); }
        }
      }
    };

    sandbox = {
      window: mockWindow,
      navigator: {},
      document: mockDoc,
      chrome: mockChrome,
      __createSyncEngine: createSyncEngine,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      CustomEvent,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      WeakSet,
      URL,
      console
    };
    sandbox.globalThis = sandbox;

    const code = fs.readFileSync(CONTENT_PATH, 'utf-8');
    vm.runInNewContext(code, sandbox);
  });

  afterEach(() => {
    const onMessage = mockChrome?.runtime?.onMessage?._listeners?.[0];
    if (onMessage) {
      onMessage({ type: 'DETACH_SYNC' }, {}, () => {});
    }
  });

  test('GET_SOURCE_HINT retrieves active server identifier in top frame', () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    let res;
    onMessage({ type: 'GET_SOURCE_HINT' }, {}, (r) => { res = r; });
    assert.equal(res.ok, true);
    assert.equal(res.sourceHint, 'vidstream');
  });

  test('APPLY_SOURCE_HINT clicks matching mirror server button', () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    let res;
    onMessage({ type: 'APPLY_SOURCE_HINT', sourceHint: 'megacloud' }, {}, (r) => { res = r; });
    assert.equal(res.ok, true);
    assert.equal(res.applied, true);

    const buttons = mockDoc.querySelectorAll();
    assert.equal(buttons[1]._clicked, true);
  });

  test('GET_SOURCE_HINT and APPLY_SOURCE_HINT do nothing in subframes', () => {
    // In subframe: window.top !== window
    mockWindow.top = { isTop: true };
    const onMessage = mockChrome.runtime.onMessage._listeners[0];

    let getRes;
    onMessage({ type: 'GET_SOURCE_HINT' }, {}, (r) => { getRes = r; });
    assert.equal(getRes.sourceHint, '');

    let applyRes;
    onMessage({ type: 'APPLY_SOURCE_HINT', sourceHint: 'megacloud' }, {}, (r) => { applyRes = r; });
    assert.equal(applyRes.applied, false);
  });
});

describe('content.js - Sync Lifecycle & Autoplay Muted Fallback', () => {
  let sandbox;
  let mockWindow;
  let mockDoc;
  let mockChrome;
  let mockVideo;
  let sentMessages;
  let windowListeners;

  beforeEach(() => {
    sentMessages = [];
    windowListeners = {};

    let isPlaying = false;
    let playFailOnce = false;

    mockVideo = {
      tagName: 'VIDEO',
      nodeType: 1,
      paused: true,
      currentTime: 0,
      playbackRate: 1,
      duration: 180,
      videoWidth: 640,
      videoHeight: 360,
      muted: false,
      readyState: 1,
      style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 }),
      _listeners: {},
      addEventListener(type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (this._listeners[type]) {
          this._listeners[type] = this._listeners[type].filter(f => f !== fn);
        }
      },
      play: async function () {
        if (playFailOnce && !this.muted) {
          const err = new Error('play() failed because user did not interact with document');
          err.name = 'NotAllowedError';
          throw err;
        }
        isPlaying = true;
        this.paused = false;
        if (this._listeners['play']) {
          for (const f of this._listeners['play']) f();
        }
      },
      pause: function () {
        isPlaying = false;
        this.paused = true;
        if (this._listeners['pause']) {
          for (const f of this._listeners['pause']) f();
        }
      },
      setFailOnce: (val) => { playFailOnce = val; }
    };

    mockWindow = {
      addEventListener: (type, fn, opts) => {
        if (!windowListeners[type]) windowListeners[type] = [];
        windowListeners[type].push({ fn, opts });
      },
      removeEventListener: (type, fn) => {
        if (windowListeners[type]) {
          windowListeners[type] = windowListeners[type].filter(item => item.fn !== fn);
        }
      },
      dispatchEvent: () => true,
      location: { origin: 'https://embed.stream.com' },
      navigator: {}
    };
    mockWindow.top = mockWindow;
    mockWindow.window = mockWindow;

    mockDoc = {
      readyState: 'complete',
      querySelectorAll: (sel) => {
        if (sel === 'video') return [mockVideo];
        return [mockVideo];
      },
      querySelector: (sel) => {
        if (sel === 'video') return mockVideo;
        return null;
      },
      elementsFromPoint: () => [mockVideo]
    };

    mockChrome = {
      runtime: {
        getURL: (p) => path.join(ROOT_DIR, 'extension', p),
        sendMessage: async (msg) => {
          sentMessages.push(msg);
          return { ok: true };
        },
        onMessage: {
          _listeners: [],
          addListener: (fn) => { mockChrome.runtime.onMessage._listeners.push(fn); }
        }
      },
      dom: {
        openOrClosedShadowRoot: () => null
      }
    };

    sandbox = {
      window: mockWindow,
      navigator: mockWindow.navigator,
      document: mockDoc,
      chrome: mockChrome,
      __createSyncEngine: createSyncEngine,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      CustomEvent,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      WeakSet,
      URL,
      console
    };
    sandbox.globalThis = sandbox;

    const code = fs.readFileSync(CONTENT_PATH, 'utf-8');
    vm.runInNewContext(code, sandbox);
  });

  afterEach(() => {
    const onMessage = mockChrome?.runtime?.onMessage?._listeners?.[0];
    if (onMessage) {
      onMessage({ type: 'DETACH_SYNC' }, {}, () => {});
    }
  });

  test('ATTACH_SYNC and DETACH_SYNC manage event listeners and heartbeat', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];

    let attachRes;
    await new Promise(r => {
      onMessage({ type: 'ATTACH_SYNC', selfId: 'test-user' }, {}, (res) => {
        attachRes = res;
        r();
      });
    });

    assert.equal(attachRes.ok, true);
    assert.equal(attachRes.duration, 180);
    assert.ok(mockVideo._listeners['play']?.length > 0);
    assert.ok(mockVideo._listeners['pause']?.length > 0);

    // Trigger video play -> emits LOCAL_SYNC_MSG
    mockVideo.paused = false;
    for (const f of mockVideo._listeners['play']) f();

    const localMsg = sentMessages.find(m => m.type === 'LOCAL_SYNC_MSG');
    assert.ok(localMsg, 'LOCAL_SYNC_MSG should be dispatched');

    // DETACH_SYNC cleans up
    let detachRes;
    onMessage({ type: 'DETACH_SYNC' }, {}, (res) => { detachRes = res; });
    assert.equal(detachRes.ok, true);
    assert.equal(mockVideo._listeners['play']?.length, 0);
  });

  test('falls back to muted autoplay on NotAllowedError and unmutes on interaction', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    await new Promise(r => {
      onMessage({ type: 'ATTACH_SYNC', selfId: 'test-user' }, {}, r);
    });

    // Make next play() call fail with NotAllowedError unless muted
    mockVideo.setFailOnce(true);

    // Receive REMOTE_SYNC play command
    const remoteMsg = {
      type: 'REMOTE_SYNC',
      msg: {
        type: 'INTENT',
        action: 'PLAY',
        seq: 5,
        peerId: 'peerRemote',
        paused: false,
        time: 10,
        rate: 1,
        timestamp: Date.now()
      },
      rttMs: 50
    };

    await new Promise(r => {
      onMessage(remoteMsg, {}, r);
    });

    // Video should now be muted and playing
    assert.equal(mockVideo.muted, true);
    assert.equal(mockVideo.paused, false);

    // Sent AUTOPLAY_MUTED { muted: true } notification
    const muteNotif = sentMessages.find(m => m.type === 'AUTOPLAY_MUTED' && m.muted === true);
    assert.ok(muteNotif, 'AUTOPLAY_MUTED notification should be sent');

    // Verify interaction handlers attached to window
    const pointerHandlers = windowListeners['pointerdown'] || [];
    assert.ok(pointerHandlers.length > 0);

    // Simulate user interaction
    for (const h of [...pointerHandlers]) {
      h.fn();
    }

    // Video is unmuted and AUTOPLAY_MUTED { muted: false } sent
    assert.equal(mockVideo.muted, false);
    const unmuteNotif = sentMessages.find(m => m.type === 'AUTOPLAY_MUTED' && m.muted === false);
    assert.ok(unmuteNotif, 'Unmute notification should be sent');
  });

  test('REQUEST_STATE_SNAPSHOT returns current video state snapshot synchronously', () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    mockVideo.paused = false;
    mockVideo.currentTime = 42.5;
    mockVideo.playbackRate = 1.25;

    let res;
    const isAsync = onMessage({ type: 'REQUEST_STATE_SNAPSHOT' }, {}, (r) => { res = r; });
    assert.equal(isAsync, false);
    assert.equal(res.ok, true);
    assert.equal(res.hasVideo, true);
    assert.equal(res.state.paused, false);
    assert.equal(res.state.time, 42.5);
    assert.equal(res.state.rate, 1.25);
    assert.equal(res.duration, 180);
  });

  test('ATTACH_SYNC applies initialState and handles dynamic selfId', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    let dispatchedMain = [];
    mockWindow.dispatchEvent = (evt) => {
      dispatchedMain.push(evt);
      return true;
    };

    let attachRes;
    await new Promise(r => {
      onMessage({
        type: 'ATTACH_SYNC',
        selfId: 'user-alpha',
        initialState: { time: 55, paused: false, rate: 1.5 }
      }, {}, (res) => {
        attachRes = res;
        r();
      });
    });

    assert.equal(attachRes.ok, true);
    assert.equal(mockVideo.currentTime, 55);
    assert.equal(mockVideo.playbackRate, 1.5);
    assert.equal(mockVideo.paused, false);

    // Verify main commands sent for seek & play
    const seekEvent = dispatchedMain.find(e => e.detail?.action === 'seek' && e.detail?.time === 55);
    const playEvent = dispatchedMain.find(e => e.detail?.action === 'play');
    assert.ok(seekEvent, '__lockstep_main seek should be dispatched');
    assert.ok(playEvent, '__lockstep_main play should be dispatched');

    // Calling ATTACH_SYNC with new selfId recreates engine with new selfId
    await new Promise(r => {
      onMessage({
        type: 'ATTACH_SYNC',
        selfId: 'user-beta'
      }, {}, r);
    });

    // Trigger seeking event -> emits LOCAL_SYNC_MSG with peerId: 'user-beta'
    sentMessages = [];
    for (const f of (mockVideo._listeners['seeking'] || [])) f();
    const localMsg = sentMessages.find(m => m.type === 'LOCAL_SYNC_MSG');
    assert.ok(localMsg, 'LOCAL_SYNC_MSG should be dispatched');
    assert.equal(localMsg.msg?.peerId, 'user-beta');
  });

  test('NUDGE drift correction decoupling prevents compounding rate feedback and restores on NOOP', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    await new Promise(r => {
      onMessage({ type: 'ATTACH_SYNC', selfId: 'user-local' }, {}, r);
    });

    mockVideo.paused = false;
    mockVideo.currentTime = 10.0;
    mockVideo.playbackRate = 1.0;

    // Simulate remote heartbeat with 150ms drift (drift within 12-250ms triggers NUDGE)
    const remoteNudge = {
      type: 'REMOTE_SYNC',
      msg: {
        type: 'HEARTBEAT',
        action: 'HEARTBEAT',
        seq: 2,
        peerId: 'peerLeader',
        paused: false,
        time: 10.15,
        rate: 1.0,
        timestamp: Date.now()
      },
      rttMs: 0
    };

    let res;
    await new Promise(r => {
      onMessage(remoteNudge, {}, (rRes) => {
        res = rRes;
        r();
      });
    });

    assert.equal(res.ok, true);
    assert.equal(res.resolution.action, 'NUDGE');
    assert.equal(mockVideo.playbackRate, 1.075);

    // REQUEST_STATE_SNAPSHOT should report baseRate (1.0), NOT nudged 1.075
    let snap;
    onMessage({ type: 'REQUEST_STATE_SNAPSHOT' }, {}, (rSnap) => { snap = rSnap; });
    assert.equal(snap.state.rate, 1.0);

    // Simulate remote matching time -> NOOP
    const remoteNoop = {
      type: 'REMOTE_SYNC',
      msg: {
        type: 'HEARTBEAT',
        action: 'HEARTBEAT',
        seq: 2,
        peerId: 'peerLeader',
        paused: false,
        time: 10.0,
        rate: 1.0,
        timestamp: Date.now()
      },
      rttMs: 0
    };

    await new Promise(r => {
      onMessage(remoteNoop, {}, (rRes) => {
        res = rRes;
        r();
      });
    });

    assert.equal(res.resolution.action, 'NOOP');
    // Video rate restored to baseRate 1.0
    assert.equal(mockVideo.playbackRate, 1.0);
  });

  test('SCAN_VIDEOS finds video and dispatches VIDEO_READY to SW', () => {
    sentMessages = [];
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    let res;
    const isAsync = onMessage({ type: 'SCAN_VIDEOS' }, {}, (r) => { res = r; });
    assert.equal(isAsync, false);
    assert.equal(res.ok, true);
    assert.equal(res.found, true);

    const readyMsg = sentMessages.find(m => m.type === 'VIDEO_READY');
    assert.ok(readyMsg, 'VIDEO_READY should be dispatched to SW');
    assert.equal(readyMsg.target, 'sw');
    assert.equal(readyMsg.frameOrigin, 'https://embed.stream.com');
    assert.equal(readyMsg.duration, 180);
    assert.equal(readyMsg.area, 640 * 360);
    assert.ok(readyMsg.state);
  });

  test('EMIT_RESYNC_INTENT generates SEEK intent with peerId and returns state asynchronously', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];
    mockVideo.currentTime = 33.3;

    let res;
    const isAsync = onMessage({ type: 'EMIT_RESYNC_INTENT', selfId: 'resync-user' }, {}, (r) => {
      res = r;
    });

    assert.equal(isAsync, true, 'EMIT_RESYNC_INTENT should return true for async response');
    // Wait for async handler completion
    await new Promise(r => setTimeout(r, 20));

    assert.ok(res, 'Response should be received');
    assert.equal(res.ok, true);
    assert.equal(res.hasVideo, true);
    assert.equal(res.duration, 180);
    assert.equal(res.state.time, 33.3);
    assert.ok(res.intent, 'Intent should be generated');
    assert.equal(res.intent.type, 'INTENT');
    assert.equal(res.intent.action, 'SEEK');
    assert.equal(res.intent.peerId, 'resync-user');
    assert.equal(typeof res.intent.seq, 'number');
  });

  test('ATTACH_SYNC preserves engine instance and ignores stale/echo REMOTE_SYNC without clobbering baseRate or seq', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];

    // 1. ATTACH_SYNC with selfId: 'peerA'
    await new Promise(r => {
      onMessage({ type: 'ATTACH_SYNC', selfId: 'peerA' }, {}, r);
    });

    // 2. Local play -> emits LOCAL_SYNC_MSG with seq: 1
    sentMessages = [];
    mockVideo.paused = false;
    for (const f of (mockVideo._listeners['play'] || [])) f();

    const localMsg = sentMessages.find(m => m.type === 'LOCAL_SYNC_MSG');
    assert.ok(localMsg, 'Local play should emit LOCAL_SYNC_MSG');
    assert.equal(localMsg.msg.action, 'PLAY');
    assert.equal(localMsg.msg.peerId, 'peerA');
    assert.equal(localMsg.msg.seq, 2);

    // Initial baseRate should be 1
    let snap;
    onMessage({ type: 'REQUEST_STATE_SNAPSHOT' }, {}, (r) => { snap = r; });
    assert.equal(snap.state.rate, 1);

    // 3. Stale/echo REMOTE_SYNC (seq: 0, rate: 2.0)
    let remoteRes;
    await new Promise(r => {
      onMessage({
        type: 'REMOTE_SYNC',
        msg: {
          type: 'INTENT',
          action: 'PLAY',
          seq: 0,
          peerId: 'peerA',
          rate: 2.0,
          paused: false,
          time: 0,
          timestamp: Date.now()
        },
        rttMs: 0
      }, {}, (res) => {
        remoteRes = res;
        r();
      });
    });

    assert.equal(remoteRes.ok, true);
    assert.equal(remoteRes.action, 'IGNORE');

    // Verify baseRate was NOT clobbered to 2.0
    onMessage({ type: 'REQUEST_STATE_SNAPSHOT' }, {}, (r) => { snap = r; });
    assert.equal(snap.state.rate, 1);

    // 4. Trigger another local intent (pause) -> seq should advance to 3, proving engine was preserved
    sentMessages = [];
    mockVideo.paused = true;
    for (const f of (mockVideo._listeners['pause'] || [])) f();

    const pauseMsg = sentMessages.find(m => m.type === 'LOCAL_SYNC_MSG');
    assert.ok(pauseMsg, 'Local pause should emit LOCAL_SYNC_MSG');
    assert.equal(pauseMsg.msg.action, 'PAUSE');
    assert.equal(pauseMsg.msg.peerId, 'peerA');
    assert.equal(pauseMsg.msg.seq, 3, 'seq should be 3, engine was preserved');
  });

  test('follower isHost: false boots locked and never emits 0:00 on join until settled or interacted', async () => {
    const onMessage = mockChrome.runtime.onMessage._listeners[0];

    // Follower joins room with initialState from host at time 42.0s
    await new Promise(r => {
      onMessage({
        type: 'ATTACH_SYNC',
        selfId: 'follower-1',
        isHost: false,
        initialState: {
          time: 42.0,
          paused: false,
          rate: 1.0,
          seq: 5,
          seqOwner: 'host-leader'
        }
      }, {}, r);
    });

    // Follower local video initializes at 0:00
    mockVideo.currentTime = 0;
    mockVideo.paused = false;
    sentMessages = [];

    // Trigger video events that would normally emit local intents
    for (const f of (mockVideo._listeners['play'] || [])) f();
    for (const f of (mockVideo._listeners['timeupdate'] || [])) f();
    for (const f of (mockVideo._listeners['seeking'] || [])) f();
    for (const f of (mockVideo._listeners['seeked'] || [])) f();

    // Verify ZERO LOCAL_SYNC_MSG emitted because followerBootLock is active!
    const syncMsgs = sentMessages.filter(m => m.type === 'LOCAL_SYNC_MSG');
    assert.equal(syncMsgs.length, 0, 'Follower boot lock must suppress all local sync messages on join');

    // Now APPLY_INITIAL_STATE arrives
    let applyRes;
    await new Promise(r => {
      onMessage({
        type: 'APPLY_INITIAL_STATE',
        state: {
          time: 42.0,
          paused: false,
          rate: 1.0,
          seq: 5,
          seqOwner: 'host-leader'
        },
        rttMs: 50,
        clockOffsetMs: 0
      }, {}, (res) => {
        applyRes = res;
        r();
      });
    });
    assert.equal(applyRes.ok, true);

    // Fast-forward past settle time (450ms)
    await new Promise(r => setTimeout(r, 500));

    // Now a trusted user interaction (e.g. keydown or pointerdown) unlocks user actions
    const pointerHandlers = windowListeners['pointerdown'] || [];
    for (const h of [...pointerHandlers]) h.fn();

    // Now local user pauses video -> should emit LOCAL_SYNC_MSG
    sentMessages = [];
    mockVideo.paused = true;
    for (const f of (mockVideo._listeners['pause'] || [])) f();

    const userPause = sentMessages.find(m => m.type === 'LOCAL_SYNC_MSG');
    assert.ok(userPause, 'After unlock, user actions should emit LOCAL_SYNC_MSG');
    assert.equal(userPause.msg.action, 'PAUSE');
    assert.equal(userPause.msg.peerId, 'follower-1');
  });
});
