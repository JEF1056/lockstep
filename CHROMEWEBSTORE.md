# Chrome Web Store Submission & Review Documentation

## Single Purpose Description

Lockstep synchronizes HTML5 video playback between two peers directly in real time using peer-to-peer WebRTC and decentralized Nostr signaling, without requiring accounts, central servers, or data collection.

---

## Detailed Description

Lockstep is an open-source, serverless browser extension that enables two people to watch web videos together in perfect synchrony.

### Why Lockstep?
- **Serverless & Private**: Connects two browsers directly via WebRTC DataChannels using decentralized Nostr relays for ephemeral room signaling. No accounts, no central servers, and zero activity tracking.
- **Universal Player Compatibility**: Synchronizes video playback across any streaming website, HTML5 `<video>` tag, embedded player iframe, or multi-source mirror.
- **Non-Invasive Video Control**: Zero DOM modification or HTML injection. Playback adjustments (play, pause, seek, micro-nudge rate adjustments) are applied directly to media elements without altering website source code or triggering ad scripts.
- **Instant Pair Links**: Share a single invite link to automatically pair both browsers and align video streams.

---

## Permission Justifications

### 1. `tabs`
- **Justification**: Needed to identify the tab playing the selected video, detect when an invite link (`https://jef1056.github.io/lockstep/#pair=...`) is opened, focus the relevant video tab when a partner joins or switches feeds, and clean up active sessions when a video tab is closed.

### 2. `storage`
- **Justification**: Needed to persist the user's pair key (`chrome.storage.local`) across browser sessions and store transient session state (`chrome.storage.session`) including active tab identifiers, connection RTT, and peer presence.

### 3. `offscreen`
- **Justification**: Manifest V3 background service workers terminate during idle periods and cannot maintain persistent WebRTC `RTCPeerConnection` sockets or WebSockets. The `offscreen` permission allows Lockstep to maintain an offscreen document with reason `WEB_RTC` for the duration of an active watch session.

### 4. `scripting`
- **Justification**: Needed to inject the pick-and-sync content listeners into user-selected video tabs and cross-origin video player iframes dynamically when the user initiates a sync session.

### 5. Host Permissions: `<all_urls>`
- **Justification**: Lockstep is designed to synchronize video players on any user-selected website. Web video players are frequently embedded across different streaming platforms, CDNs, and nested cross-origin iframes (e.g., custom embedded players on educational, anime, or video-sharing sites). Broad host access is necessary to communicate with HTML5 media elements inside those player frames when the user explicitly triggers video synchronization.

---

## Privacy Policy & Data Handling

### Data Collection & Transmission
- **Zero Personal Data Collection**: Lockstep collects **no** personal identifiable information (PII), names, email addresses, IP logs, search queries, or browsing histories.
- **Zero Analytics / Telemetry**: No third-party analytics, tracking scripts, or error reporting beacons are included.
- **Purely Ephemeral Signaling**: Connection establishment uses public, decentralized Nostr relays solely to exchange WebRTC SDP offers and ICE candidates. All signaling payloads are scoped to the user-generated room key and are not retained.
- **Direct P2P DataChannel**: All playback events (timestamps, play, pause, seek) pass exclusively over an encrypted peer-to-peer WebRTC connection between the two participating browsers.
- **No Remote Code**: Lockstep contains no remotely hosted code or dynamically evaluated strings (`eval`, `new Function`), adhering strictly to Chrome Web Store Manifest V3 guidelines.
