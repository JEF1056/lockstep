# Design System: Lockstep Prismatic Studio

Lockstep Prismatic Studio balances deep carbon neutrality with focused, purposeful chromatic branding. Designed for high-density browser extension popups and clean desktop handoff cards, the interface enforces strict separation between neutral interaction surfaces and brand identity moments.

---

## 1. Visual Theme & Atmosphere

- **Mood & Character**: Clinical yet refined audio-visual broadcast studio. Deep obsidian neutrals provide a quiet, distraction-free backdrop that floats unobtrusively over any video platform, while high-chroma prismatic elements signal real-time synchronization states.
- **Density**: **Cockpit Dense (8–9/10)**. Optimized for zero wasted space. Extension popups fit within a rigid 290px width and under 270px height with zero vertical scroll. Desktop handoff screens present centered 440px–480px utility cards with dense, legible telemetry.
- **Variance**: **Offset Asymmetric (5–6/10)**. Rejects centered AI-card cliches in favor of left-anchored identity, right-aligned telemetry badges, and stacked split controls.
- **Motion**: **Fluid & Crisp (6/10)**. Lightning-fast 90ms micro-transitions for tactile button feedback and collapsible states, paired with an infinite 1600ms gentle pulse on live peer telemetry indicators.

---

## 2. Color Palette & Roles

Monochrome obsidian surfaces dominate 90% of the visual field to prevent visual competition with active video playback. Gradients and high-chroma hues are strictly quarantined to the brand mark emblem and low-opacity status washes.

### Palette Tokens

| Token | Hex / Value | Role & Usage |
| :--- | :--- | :--- |
| **`surface-lowest`** | `#09090B` | Deep obsidian base, background for recessed code inputs and outer body |
| **`surface`** | `#101014` | Primary studio canvas, extension popup background, icon container background |
| **`surface-container`** | `#18181D` | Standard container fill, header backgrounds, card wrappers, secondary button surface |
| **`surface-container-high`** | `#222228` | Elevated container, hover states, contextual popover surfaces |
| **`surface-container-highest`**| `#2C2C34` | Highest elevation, active toggle highlights, selection pill backdrop |
| **`on-surface`** | `#FAFAFA` | Pure crisp white, primary headlines, active button labels, critical text |
| **`on-surface-variant`** | `#A1A1AA` | Muted zinc-400, secondary text, timestamps, subtitles, helper hints |
| **`outline`** | `#27272E` | Hairline structural borders (1px solid), card outlines, divider lines |
| **`outline-subtle`** | `#1C1C22` | Low-contrast inner boundaries and subtle component separators |
| **`primary`** | `#00E5FF` | Electric Cyan, left ring of interlocking mark, active input focus rings |
| **`on-primary`** | `#022B3A` | Deep cyan ink, used only when high contrast on cyan fill is required |
| **`brand-violet`** | `#8B5CF6` | Vivid Violet, gradient wash partner for the active sync pill |
| **`brand-magenta`** | `#EC4899` | Hot Magenta, right ring of interlocking mark, secondary chromatic accent |
| **`brand-amber`** | `#FBBF24` | Amber Gold, center optical lens of interlocking mark, highlight accents |
| **`accent`** | `#10B981` | Signal Emerald, active live sync state, connected peer indicator, healthy ping |
| **`on-accent`** | `#022C22` | Deep emerald ink |
| **`warning`** | `#F59E0B` | Amber Alert, autoplay-muted sub-state badge, desync warning, desktop-required pill |
| **`on-warning`** | `#451A03` | Deep amber ink |
| **`danger`** | `#EF4444` | Signal Red, disconnect action, unpair button, critical error messaging |
| **`on-danger`** | `#3C0909` | Deep red ink |

### Strict Gradient Rules
1. **Brand Mark Exclusivity**: Full-bleed gradients belong exclusively to the interlocking geometric emblem (`#00E5FF` Cyan + `#EC4899` Magenta + `#FBBF24` Amber lens). The mark represents two browser playback streams locking into phase.
2. **NO Gradients on Buttons**: Interactive buttons (Primary, Secondary, Destructive) must use **solid fills** (e.g. Solid `#FAFAFA` white fill or `#18181D` surface). Gradient buttons add cognitive noise and clash with video media.
3. **Subtle Gradient Status Washes**: Gradients are permitted solely as low-opacity ambient washes on status chips (e.g. `linear-gradient(135deg, rgba(0,229,255,0.15), rgba(139,92,246,0.15))` for the active `SYNCING` pill) to convey real-time peer resonance without sacrificing text contrast.

---

## 3. Typography Rules

A strictly curated 3-family typographic hierarchy replaces generic system fallbacks. All fonts must be loaded locally via `@font-face` with `font-display: swap` to adhere to strict Manifest V3 Content Security Policies.

### Font Stacks
- **Display & Headlines**: **Wix Madefor Display** (Weights: 600 SemiBold, 700 Bold). Tight letter-spacing, architectural geometric sans with assertive editorial posture.
- **Body & Interface**: **Instrument Sans** (Weights: 400 Regular, 500 Medium, 600 SemiBold). Precision mechanical sans with high legibility at micro sizes (10px–12px).
- **Code & Telemetry**: **Source Code Pro** (Weights: 500 Medium, 600 SemiBold). Monospace workhorse for pair keys (`lk-...`), millisecond latencies (`· 14ms`), timestamps, URLs, and numeric status readouts.
- **Banned Fonts**: `Inter` is strictly forbidden. Generic serifs (`Times New Roman`, `Georgia`, `Garamond`) and generic system font stacks (`system-ui`, `Arial`) are forbidden.

### Typographic Scale

| Token | Family | Size | Weight | Line Height | Tracking | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`display-md`** | Wix Madefor Display | 24px | 700 | 30px | -0.4px | Onboarding card titles |
| **`headline-lg`** | Wix Madefor Display | 16px | 700 | 22px | -0.2px | Standalone modal / redirect headlines |
| **`headline-md`** | Wix Madefor Display | 14px | 600 | 18px | -0.1px | Header brand text, section titles |
| **`body-md`** | Instrument Sans | 12px | 500 | 16px | normal | Standard instructions, guide step body |
| **`body-sm`** | Instrument Sans | 11px | 400 | 15px | normal | Helper captions, secondary labels |
| **`label-lg`** | Instrument Sans | 12px | 600 | 16px | 0.0px | Primary button labels, active tab triggers |
| **`label-md`** | Instrument Sans | 11px | 600 | 14px | +0.1px | Secondary buttons, uppercase micro-headers |
| **`code-md`** | Source Code Pro | 11px | 600 | 15px | normal | Pair key inputs (`lk-xyz-123`), URLs |
| **`code-sm`** | Source Code Pro | 10px | 600 | 14px | normal | Telemetry badges (`LIVE · 12ms`), latency pills |

---

## 4. Component Stylings

### Buttons
- **Primary Action**: Solid `#FAFAFA` white surface with `#101014` dark text, font-weight 600. Flat surface, zero gradient, 1px border (`rgba(255,255,255,0.1)`). Tactile micro-press: `transform: scale(0.98)` on `:active`.
- **Secondary Action**: Solid `#18181D` surface with `#FAFAFA` text, 1px `#27272E` hairline border. `:hover` lifts to `#222228`.
- **Destructive Action**: Muted transparent or `#18181D` fill with `#EF4444` red border and text. Hover dark red tint `rgba(239,68,68,0.12)`.
- **Iconography**: Inline 1.5px/2px crisp SVG icons sized 14px–16px. Never use font icon glyphs or emojis.

### Cards & Surface Containers
- **Corner Radii**: 6px default (`border-radius: 6px`) for cards and containers, 4px for inner badges/buttons, 9999px for pills.
- **Borders**: 1px solid `#27272E`.
- **Elevation**: Flat, relying entirely on luminance contrast (`#09090B` lowest, `#101014` base, `#18181D` container, `#222228` elevated). Zero blurry box-shadows.

### Status Pills & Telemetry Badges
- **IDLE / Standby**: Surface `#09090B`, border `#27272E`, text `#A1A1AA`.
- **Active SYNCING**: Ambient wash `linear-gradient(135deg, rgba(0,229,255,0.15), rgba(139,92,246,0.15))`, border `rgba(0,229,255,0.3)`, text `#FAFAFA`. Accompanied by a 6px `#10B981` Signal Emerald dot pulsing at 1600ms.
- **Warning / Sub-state**: Muted `#F59E0B` amber border with `rgba(245,158,11,0.12)` background, amber text (e.g. Autoplay-muted alert).

### Form Inputs & Key Readouts
- Recessed `#09090B` background, 1px `#27272E` border, 6px radius.
- Text in Source Code Pro `#FAFAFA`.
- Focus state: 1px border `#00E5FF` with subtle `box-shadow: 0 0 0 1px #00E5FF`. No generic blue browser outline.

---

## 5. Layout Principles

- **Extension Popup Constraints**: Fixed 290px width. Height constrained to `<270px`. Header, body, and action footer form a single non-scrolling viewport. High information density with zero vertical overflow.
- **Desktop Web Handoff Cards**: Centered utility container constrained between 440px and 480px. Full-page background uses `min-h-[100dvh]` (never `h-screen` to prevent mobile browser address-bar viewport jumping).
- **Spacing Grid**:
  - `gutter-xs`: 4px
  - `gutter-sm`: 8px
  - `gutter-md`: 8px
  - `gutter-lg`: 16px
  - `gutter-xl`: 16px
  - `section-gap`: 20px
  - `page-margin`: 12px
- **Layout Engine**: CSS Grid and flexbox with explicit gap tokens. No percentage `calc()` padding hacks. Single-column collapse guaranteed below 768px on web pages.

---

## 6. Motion & Interaction

- **State Transitions**: `duration: 90ms`, `timing-function: cubic-bezier(0.16, 1, 0.3, 1)`. Immediate, mechanical, decisive. Applied to hover states, button presses, and accordion expansion.
- **Telemetry Pulse Loop**: An infinite 1600ms `ease-in-out` keyframe animation on the active `#10B981` status dot:
  ```css
  @keyframes telemetry-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.85); }
  }
  ```
- **Performance Directives**: Animations are strictly restricted to `transform` and `opacity`. Never animate `width`, `height`, `top`, or `padding`. Hardware-accelerated with `will-change: transform`.

---

## 7. Anti-Patterns (Banned AI Tells)

The following patterns are strictly banned across all extension and web surfaces:

1. **NO Emojis**: Never use emojis in labels, buttons, toasts, alerts, or status text. Use crisp monochrome inline SVGs.
2. **NO Inter Font**: Never fall back to `Inter` or standard browser sans.
3. **NO Generic Serif Fonts**: Generic serifs (`Times New Roman`, `Georgia`, `Garamond`) are prohibited in software UIs.
4. **NO Pure Black (`#000000`)**: Canvas lowest must be obsidian `#09090B` or studio `#101014`.
5. **NO Neon Outer Glows or Drop Shadows**: Prohibit fuzzy neon drop shadows (`box-shadow: 0 0 20px #00E5FF`). Rely on crisp 1px borders and surface luminance stepping.
6. **NO Button Gradients**: Primary and secondary buttons must have solid fills. Gradients are reserved for the brand emblem and subtle badge washes.
7. **NO Symmetrical 3-Card Columns**: Avoid generic AI landing page 3-card bento grids. Use asymmetric vertical stacks or progressive step lists.
8. **NO AI Copywriting Clichés**: Prohibit terms such as "Seamless", "Elevate", "Next-Gen", "Unleash", "Magic" (outside literal P2P link context), "Futuristic", or "Blazing-fast". Use direct engineering terms ("Lockstep", "Synced", "Latency", "Pair", "Direct P2P").
9. **NO Filler UI Text**: Prohibit "Scroll down to explore", bouncing arrows, or fake metrics (`99.99%`).
10. **NO Remote Assets**: All fonts, icons, and bundles must be locally self-contained without CDN dependencies, complying with strict offline-first MV3 CSP.
