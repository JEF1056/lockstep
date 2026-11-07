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
- **Instant Auto-Pairing & Stitch Magic Invite**: Share a 1-click invite link (`https://jef1056.github.io/lockstep/#pair=<pairKey>&url=<videoUrl>`). The zero-CDN GitHub Pages app dynamically routes across three Stitch view states:
  - **Magic Invite Onboarding**: 1-click extension download (.zip), 3-step setup guide, dynamic pair key, and live auto-pair listener.
  - **Invite Paired Redirect**: Emerald pulse badge and countdown redirect into the synchronized video.
  - **Unsupported Browser Gate**: Clear prompt on mobile/tablet or non-Chromium browsers to open on desktop Chrome.
- **Bilateral Session Management**: Ending a session or resyncing synchronizes immediately across both peers.

---

## Quick Start

### 1. Install Extension

**Option A: Pre-built ZIP**
1. Download `lockstep.zip` (from the GitHub Releases page or `docs/lockstep.zip`).
2. Unzip the downloaded file.
3. Open Chrome and navigate to `chrome://extensions/`.
4. Toggle **Developer mode** on (top-right corner).
5. Click **Load unpacked** and select the unzipped `lockstep` folder.

**Option B: From Source**
1. Clone this repository:
   ```bash
   git clone https://github.com/JEF1056/lockstep.git
   cd lockstep
   ```
2. Build vendor assets, icons, and package ZIP:
   ```bash
   npm install
   npm run vendor
   ```
3. Open Chrome and navigate to `chrome://extensions/`.
4. Toggle **Developer mode** on (top-right corner).
5. Click **Load unpacked** and select the `lockstep/extension` directory (or the unzipped folder from `npm run pack`).

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
- **Docs & Landing (`docs/`)**: Zero-CDN responsive Prismatic Studio web app uniting all 3 Stitch screens: Unsupported Browser Gate (mobile/tablet/Safari/Firefox), Magic Invite Onboarding (desktop Chromium awaiting install), and Invite Paired Redirect (synced countdown). Supports `?screen=onboarding|paired|unsupported` preview query parameter.

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
