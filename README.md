# Lockstep

> Zero-config, serverless peer-to-peer web video synchronization powered by WebRTC and Nostr.

Lockstep allows two people to watch videos synchronously across the web without central servers, third-party accounts, or browser extensions injecting unwanted DOM elements into host pages.

---

## Key Features

- **Universal Compatibility**: Works on any web video player—HTML5 `<video>`, YouTube, Vimeo, custom JWPlayer, Video.js, Plyr, and multi-source embedded iframe mirrors (e.g. streaming anime and movie platforms).
- **Serverless P2P**: Direct browser-to-browser WebRTC DataChannels using decentralized Nostr relays for ephemeral signaling via [Trystero](https://github.com/dmotz/trystero). No server accounts, no tracking, zero recurring hosting cost.
- **Micro-Nudge Sync Engine**:
  - Lamport logical clocks with peer-ID tie breaking for concurrent playback intents.
  - 300ms intent-scoped echo guard to distinguish human actions from network feedback loops.
  - Dynamic RTT dead-reckoning: `<40ms` drift is ignored, `40–400ms` drift is smoothly recovered via `±4%` playback rate adjustments, and `>400ms` drift snaps cleanly with seek.
- **Zero DOM Pollution**: Never inserts synthetic elements into host pages (`appendChild`, `innerHTML`, `attachShadow`). Highlight overlays use temporary inline CSS styles (`outline` & `cursor`), leaving site scripts and DRM untouched.
- **Instant Auto-Pairing**: Share a 1-click invite link (`https://jef1056.github.io/lockstep/#pair=<pairKey>`). When the invite tab opens or the extension loads, Lockstep automatically harvests the pair key and syncs.
- **Bilateral Session Management**: Ending a session or resyncing synchronizes immediately across both peers.

---

## Quick Start

### 1. Install Extension

1. Clone or download this repository:
   ```bash
   git clone https://github.com/JEF1056/lockstep.git
   cd lockstep
   ```
2. Build vendor assets and icons:
   ```bash
   npm install
   npm run vendor
   ```
3. Open Chrome and navigate to `chrome://extensions/`.
4. Toggle **Developer mode** on (top-right corner).
5. Click **Load unpacked** and select the `lockstep/extension` directory.

### 2. Connect & Watch

1. Open any web page with a video.
2. Click the **Lockstep** extension icon.
3. Click **Pick Video & Copy Link**. Hover over the video player and click to select it.
4. Send the copied invite link to your partner.
5. Once your partner opens the link with Lockstep installed, both players lock into sync automatically.

---

## Architecture

Lockstep is built on Chrome Manifest V3 with a strict separation of concerns:

```
┌────────────────────────────────────────────────────────┐
│                      Lockstep MV3                      │
├─────────────────┬───────────────────┬──────────────────┤
│ Background SW   │ Offscreen Doc     │ Content Scripts  │
│ (State Machine) │ (WebRTC + Nostr)  │ (Video Hooks)    │
│                 │                   │                  │
│ • Pair keys     │ • Trystero Nostr  │ • Isolated world │
│ • Tab tracking  │ • RTC DataChannel │ • Main world     │
│ • Message bus   │ • RTT ping/pong   │ • Cross-origin   │
│                 │                   │   iframe adapter │
└─────────────────┴───────────────────┴──────────────────┘
```

- **Popup (`extension/popup/`)**: Compact 280px Linear-inspired dark UI providing instant status, video picking, and session management.
- **Background Service Worker (`extension/background/`)**: Coordinates tab routing, status state machines, and message distribution.
- **Offscreen Document (`extension/offscreen/`)**: Hosts WebRTC peer connections and WebSocket Nostr signaling outside the ephemeral service worker lifecycle.
- **Content Scripts (`extension/content/`)**: Observes video play/pause/seek events and applies sync adjustments without DOM alterations.
- **Docs & Landing (`docs/index.html`)**: Client-side GitHub Pages landing page reading `#pair` and `#url` hash fragments to onboard new users.

---

## Development

Run test suites and extension validation:

```bash
# Run unit tests
npm test

# Validate MV3 compliance, icons, and zero-DOM-insertion policy
npm run validate
```

---

## License

[MIT](LICENSE) © 2026 Lockstep Contributors
