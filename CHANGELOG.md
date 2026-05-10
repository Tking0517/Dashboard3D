# Changelog

## [0.5.1] — 2026-05-10

### Coder-friendliness pass
- **Z-index ladder** documented at the top of `:root` in styles.css — every tier (bg → 0, zen backdrop → 40, combo-fold backdrop → 49, zen overlay + combo-fold content → 50, audio → 60–80, topbar → 100, alerts → 200) is named so a new contributor knows where new positioned elements should sit
- **IPC inventory comment** added above `registerIpc()` in main.js — all 20+ channels grouped by domain (telemetry / config / audio / web / process / push events) plus the `{ ok, error }` return convention
- Removed empty `.panel-chat {}` selector and 3 stale `console.log` debug calls from the audio device pickers (kept the meaningful `console.warn` lines that fire on enumerate failures)

## [0.5.0] — 2026-05-10

### Audio overhaul
- **Real OS-level mute** for both input and output — Core Audio `IAudioEndpointVolume` calls via PowerShell + inline C# COM glue; mute persists across volume-key auto-unmutes via 1.5 s polling
- **OS default endpoint switching** — `IPolicyConfigVista` (registry-friendly substring match) lets the in/out device pickers switch the system default device, not just route capture
- **Edge resize handles** on both audio visualizers (was: SE-corner only); **dynamic snap-to-grid** with hold-Alt bypass
- **Per-visualizer gain ▲/▼** triangles next to the device picker; the in+out visualizers stay sized identically (linked dimensions saved under `audioVizSize`)
- **Canvas rendering** replaces the per-bar DOM — was ~14 k DOM style writes/sec at 96 bars × 2 visualizers, now one `ctx.fillRect` loop per draw. Linear gradient + CSS-var lookups cached by a `_themeVersion` counter
- **Sample rate halved** — output FFT cadence ~47 Hz → ~23 Hz (`frameCount & 3` in audify-worker), input mic poll ~30 Hz → ~15 Hz (rAF skip every 4th frame). The meters don't need realtime; halving cuts IPC + canvas work in half
- **Mic floor + smile curve** tuned so the output stops clipping at the top with the canvas pre-divided by 0.70 (middle bars max at 70 % of canvas, edges scale up to ~95 %)

### Snap grid + collision
- **Dynamic grid** sized to viewport (~40 px target cell), used for both drag-snap and resize-snap on panels and audio visualizers; hold **Alt** to bypass
- **Collision detection** — panels can't overlap while dragging or resizing; auto-snap to neighbor edges so adjacent panels stay flush instead of stacking

### Container-query scaling
- Every `.panel` becomes its own `container-type: inline-size`; bigvalue / micro-label / meter-value / time-row / weather / thermal / storage / tab labels all use `clamp(min, Ncqi, max)` so text and graph scale smoothly with the panel's actual width
- Network and disk sparklines fixed to fill their grid cell (was stuck at 32 px because `.net-row` was a CSS grid with `align-items: center` — flipped to `align-items: stretch` + `flex: 1 1 0`)

### Notes / Paper / UI fonts
- **Per-line `[HH:MM]` timestamps** in notes — Enter prefixes a fresh timestamp on the new line. Top-right `UPDATED` chip per tab refreshed each save
- **PAPER tab** — basic contenteditable word processor with rich-text toolbar (B/I/U/lists/etc.) and a font picker that only affects the editor. Persists `paperContent` + `paperFont`
- **Bundled writing fonts** (woff2, hashed by Vite) — JetBrains Mono, Inter, Source Serif, Lora, IBM Plex Mono/Sans, Space Grotesk
- **UI font cycle button** in the topbar — toggles `body.font-tech / clean / classic / mono / mixed / writing` to swap `--font-display` + `--font-tech` across the entire dashboard. Persisted under `uiFont`

### Topbar reorder + new buttons
- Each direct child of `.topbar-controls` is HTML5-draggable side-to-side; drop position computed against sibling midpoints. Order saved under `topbarOrder`
- **Three thin dividers** (`#topbar-div-1/2/3`) participate in the same drag system so the user can group buttons visually
- **Restart button** — `app.relaunch(); app.exit(0)` for changes that only take effect at process start
- **Close button** — hard-quit via `app.exit(0)`
- **Airplane mode button** — disables every `Status -eq 'Up'` network adapter via elevated PowerShell (`Start-Process -Verb RunAs`, one UAC per toggle). Saves the names to `userData/airplane-state.txt` so re-enable still works after an app restart. State persists in `airplaneMode`

### WEB tab (in-panel browser)
- Fourth combo-panel tab housing an Electron `<webview>` with multi-tab support, persistent + private partitions, adblock, CSP stripping, dark-mode override, and themed tint
- **Tabs** — `＋` opens a normal tab on `persist:dashboard-browser`; `⊘` opens a private tab on a fresh in-memory `web-private-{id}` partition. Normal tabs persist via `webTabs`; private tabs never touch config and clear on close
- **Adblock** — `session.webRequest.onBeforeRequest` cancels matched hosts (Google Ads, DoubleClick, Taboola, Outbrain, etc.); blocked count chip in the toolbar
- **Dark mode** — Chromium's CDP `Emulation.setAutoDarkModeOverride` engaged via `webContents.debugger.attach('1.3')` after each tab's dom-ready (handled in main, exposed as `forceWebDark(contentsId)`). CSP headers stripped per partition so the dark-mode + tint stylesheets actually apply on locked-down sites like Google
- **Theme tint** — `insertCSS` overlay on each webview: `body::after { mix-blend-mode: screen; opacity: 0.16 }` set to `--accent`. Re-applied on every theme change via a single `MutationObserver` on `data-theme`
- **Toolbar** — back/forward/reload/home + URL/search input. Bare hostnames upgrade to `https://`, anything else routes to a Google query

### Combo panel fold buttons
- Three controls grouped at the right of the combo header: **▾ collapse** (existing chevron), **◐ half-down**, **● full-down**
- ◐ pins the panel to its column and stretches it to 50 vh; ● stretches to 12 px from the bottom of the viewport. Re-pins on window resize. Mutually exclusive
- ● mode also draws an 80 %-opacity black backdrop over the rest of the dashboard (`body::before`, z-index 49 < panel z-index 50) so the expanded panel reads as the focal element

### Alert theme (auto-engage)
- Brand-new `[data-theme="alert"]` palette — pure red (`--accent: #ff1010`), near-black background (`--bg: #050000`), dim panel-bg `rgba(12,0,0,0.72)`. No blue tint anywhere
- **Auto-engages** on any of: `navigator.onLine === false`, sustained CPU load ≥ 90 %, peak GPU load ≥ 90 % across all GPUs, or exceptions in `refreshSystem` / `refreshTemps` / `refreshNet`. Reasons tracked in a `Set`; theme switches when set non-empty / empty
- The user's chosen theme is preserved as `_userTheme` and restored when all alert reasons clear; `'alert'` itself is never persisted to config
- **70 %-brighter strobe** via swapped keyframes (`panel-pulse-alert` / `element-pulse-alert`) — same 8 s/7 s cadence as every other theme, peak brightness lifted from 1.10/1.35 to 1.87/2.30

### Zen mode redesign
- Old stack-then-explode animation removed; replaced by a **fade-through-black** transition driven entirely by CSS
- A fixed full-viewport `body::after` peaks to `opacity: 1` halfway through the entering window (`@keyframes zen-black-peak`) and dissipates over the second half. Cards fade out before the peak, the zen overlay fades in (550 ms delay) as black dissipates → "fade *to* black, then fade *out* of black into the zen UI"
- Steady `is-zen` state has the backdrop at 0 opacity so the zen content sits on the dashboard's normal dark background

### LibreHardwareMonitor patch + bundle
- Bundled patched LHM (`tools/LibreHardwareMonitor/`) auto-launches at app start (UAC for MSR access). Patch: `MainForm.cs` now explicitly fires `Server.StartHttpListener()` when `runWebServerMenuItem` is true at startup (the upstream `UserOption` ctor reads the persisted setting but doesn't fire `Changed`, so the listener never started)
- Bonus: `PersistentSettings` `bool` compare was case-sensitive (`str == "true"`) — config now writes lowercase `value="true"` so the listener flag actually round-trips

## [0.4.0] — 2026-05-09

### Zen idle mode
- After **15 s** of no input the HUD slides off-screen (top row up, bottom row down, left+right of the mid row outward, combo panel up, top-bar fades up) and a centered overlay fades in
- **Centered overlay** holds clock + cycling 5-day forecast + per-row network sparks + CPU logical-cores grid; date and weather pin to the top-left
- **5-day forecast cycling** — `fetchWeather` now also requests Open-Meteo `daily` with `forecast_days=5`; in zen the forecast advances every 5 s, showing day label (`TODAY`/`MON`/`TUE`...) with high/low temps and condition
- **Theme rotation** every 25 s through a 13-theme calm set (`pastel`, `rose`, `meadow`, `mint`, `lavender`, `sage`, `dust`, `slate`, `harbor`, `moss`, `dusk`, `paper`, `storm`); user's persisted theme is restored on exit
- **Auto-dim** + low-contrast theme swap on entry; both restored on exit. Non-focal elements (network/CPU/audio) drop to opacity 0.4 so the clock+date+weather read as the focal trio
- **Audio bars reshape** — 24 bars (per visualizer) → 96 bars stretched across each half of the bottom of the screen, 96 px tall, 1 px gap, gain scaled 0.65× so the dense spectrum reads calm. Linear interpolation upsamples the 24-band FFT input to 96 display bars. Smile curve grows edge bars up to +35 % taller than the center
- **Insta-zen button** (crescent moon icon in topbar) — clicks force-enter zen instantly via a small `_zenForceArming` guard that suppresses the button-click bubble that would otherwise exit zen

### Zen clock — animated, tabular, pinned center
- Per-character `<span>` cells with **fixed 0.6 em** widths (and 0.28 em for separators) so digit changes never shift the centered clock — the layout is true tabular even on display fonts (Rajdhani) that don't ship with the OpenType `tnum` feature
- An **invisible AM/PM mirror** balances the visible AM/PM on the opposite side of the time slot so the time's center is locked exactly to the viewport center
- Each digit `pop`s on change (translateY/scale curve, 360 ms cubic-bezier) with the bottom of the cell as the transform-origin
- Each digit also `glow`s — `filter: brightness(1.85)` held briefly then eased back to 1.0 over 1.4 s
- The whole `.zen-clock` container also `jump`s when any digit changes (translateY -10 px → +2 px → 0)
- Clock baseline is lifted **+40 %** above the rest of the zen overlay's brightness so it reads as the focal element

### Zen power profile (eco)
- Entering zen calls `powercfg.exe` (via a new `set-power-profile` IPC) to set the active scheme's `PROCTHROTTLEMAX = 50` and `PROCTHROTTLEMIN = 3` (AC + DC), then `/setactive SCHEME_CURRENT` to apply
- Leaving zen restores `90` and `5`
- **`ECO` indicator chip** in the top-right of the zen overlay — pulsing dot in the theme `--ok` color + `PWR PROFILE  ECO` label, large enough to read from across the room
- All confirmations route through the diagnostics terminal (`power: max=50% min=3%` etc.)

### Webcam popout
- New camera button in the topbar opens a floating, draggable, resizable PIP panel showing the live webcam (`getUserMedia({video: true})`) mirrored horizontally
- **Multi-camera cycling** — ⇆ button on the panel iterates through every detected `videoinput` device; the selected `deviceId` persists in `config.webcamDeviceId`, label and `n/N` index appear in the panel chip
- **VHS transition** when switching cameras — CSS scanlines + a sweeping bright tracking bar with red/cyan ghost lines + RGB chromatic aberration on the video (drop-shadow filters) + a 320×240 painted-noise canvas of high-frequency monochrome static (~0.4 opacity, screen-blended). Total run ~700 ms
- **Pixelated in zen** — 32×24 canvas takes over from the live `<video>` while idle, scaled up via CSS `image-rendering: pixelated` for chunky 8-bit blocks; rAF paint loop only runs while zen+camera both active
- **50 % brightness dim** in zen via `filter: brightness(0.5)` on the panel
- **Pinned to top-right** in zen (slides smoothly via 800 ms cubic-bezier on top/right/left/bottom/transform), returns to user-saved drag position on exit
- **Security-cam timestamp** in the bottom-left of the panel: `YYYY-MM-DD  HH:MM:SS` (24-hour, ISO style), tabular numerals

### YouTube popout
- New play-icon topbar button opens a **frameless, always-on-top, 16:9-locked** window
- Implemented as a small Electron-hosted `youtube-host.html` containing a `<webview>` pointing at `youtube.com` with `partition="persist:youtube"` so cookies and sign-in survive between launches
- **Sign-in works** through YouTube's normal UI — host CSS only injects the chrome-hide rules on `/watch?v=…` URLs, leaving home/search/auth pages fully usable
- **Video-only on `/watch`** — `webview.insertCSS()` hides masthead, sidebar, comments, related, metadata, popups, etc., and stretches `#movie_player` + `video.html5-main-video` to fill the window with `object-fit: contain`. After CSS injects, dispatches `window.dispatchEvent(new Event('resize'))` three times (immediate, 250 ms, 800 ms) so YouTube's player JS recomputes layout
- **16:9 lock** via `setAspectRatio(16/9)`, plus a `will-resize` correction and a post-resize re-snap with re-entry guard so Windows can't drift the ratio during a drag
- **Auto-hide header** at the top — 26 px strip with status URL, ←/⌂/⫐ (always-on-top toggle)/× — fades after 2 s of mouse stillness so the window becomes 100 % video; reappears on movement
- **Esc** key closes the window; small `youtube-preload.js` provides the IPC for the AOT toggle button

### Terminal / diagnostics
- New terminal button in the topbar opens a draggable, resizable diagnostics panel with **CLR / × actions** and a controls strip
- **Captures**: `console.log/info/warn/error` (originals still go to DevTools), `window.onerror`, `unhandledrejection`. 500-line ring buffer
- **Telemetry channels** — interval selector (`OFF / 1s / 5s / 15s / 30s / 1m / 5m`), time format (`HH:MM:SS / ISO 8601 / +s SINCE START`), and per-channel toggles (`SYS / TEMP / NET / DISK / STORE`). Every interval the renderer calls all enabled channels in parallel and emits one log line per channel:
  - `[SYS] cores=24 mem=18.4/63.7GB (29%)`
  - `[TEMP] cpu=58°C(42W) gpu0=64°C/12% 110W src=si:cpu,nvidia-smi`
  - `[NET] iface=Wi-Fi rx=84KB tx=12KB total rx=8.35GB tx=15.8GB`
  - `[DISK] read=0B write=2.1MB q=0`
- **Theme-tied styling** — `var(--panel-bg)` background to match the rest of the HUD, no borders or hairlines (per request), `var(--accent)` title and hover states. Pinned to the **left edge, vertically centered** when zen activates with the panel open. All settings persist (`terminalPos / terminalSize / terminalOpen / terminalInterval / terminalTimeFmt / terminalChannels`)
- **Display fix**: the close button was a no-op for two days because `.terminal-panel { display: flex }` overrode the browser's default `[hidden] { display: none }`. Added `.terminal-panel[hidden] { display: none }` and event-delegated handlers on the panel level to avoid future drag/click conflicts
- **Scrollbar hidden** (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`) so the log auto-scrolls to bottom without a visible scrubber

### Combined Notes + Chat panel
- Top-row Notes panel removed; the existing Chat panel in the middle of row 2 became `panel-combo` housing both modes via a `[NOTES] [CHAT]` tab strip below the panel header
- The originally-separate IDs (`#note-textarea`, `#chat-input`, `#chat-messages`, `#notes-status`, `#chat-footer`, `#notes-tab-count`, `#chat-tag`) all remain so existing notes/chat handlers keep working without modification
- Title / code chip / tag / footer-label all swap per mode, driven by MutationObservers on the original status elements so updates are live
- Mode persists in `config.comboMode`. Top row collapses from 3 cols → **2 cols** (`CHRONO | METEO`)
- **Note tabs auto-title** from the first non-empty line of the body (uppercased, 14-char max). Manual rename via double-click still wins; leaving the prompt blank clears the override and resumes auto-naming

### Themes / chrome
- **Dim button** added beside Invert: toggles `body.theme-dim` which applies `filter: brightness(0.5)` to `#app`. Stacks with invert via `body.theme-invert.theme-dim` so both compose. Persists in `config.dim`
- **Crimson theme** added (3-shade red palette: `#C90000 / #980002 / #68030E`) plus 10 low-contrast complementary themes (`dust`, `slate`, `mint`, `lavender`, `harbor`, `moss`, `dusk`, `paper`, `storm`, `sage`) — total 22 themes
- **Theme-name chip** + **auto-cycle button** (25 s, spinning clock-hand icon as countdown) in the topbar
- Spark grids on net/disk bumped from 60 → **96 bars**

### Tooling / packaging
- Dashboard.bat now also copies `youtube-host.html` and `youtube-preload.js` into the packaged folder
- New IPCs in main process: `set-power-profile`, `open-youtube`, `youtube-toggle-aot`, `audio-set-device`, `audio-out-level` push (existing)
- New preload methods: `setPowerProfile`, `openYoutube`, `setAudioDevice`

## [0.3.0] — 2026-05-09

### Audio visualizer — frequency-spectrum + peak-hold cascade
- Loopback path rewritten as a **24-band FFT spectrum** (1024-pt Hann-windowed Cooley-Tukey FFT, log-spaced 60 Hz – 16 kHz) computed inside the audify utility-process worker, ~47 Hz update rate
- Mic visualizer rewritten to mirror the output: same band layout via `AnalyserNode.getByteFrequencyData()` instead of a time-scrolling RMS history, sample rate bumped to ~30 Hz so the two panels share the same decay/peak feel
- **Floating peak-hold markers** per bar: snap up on rises, hold for ~12 frames, then decay slowly so peaks trail off like a VU meter
- **3-zone vertical color cascade** (cool → warm → hot) anchored to the bar's full pixel height via a `--bar-h` CSS variable kept in sync by ResizeObserver — quiet content reads cool, loud transients reach amber/red regardless of fill height
- Independent gain knobs: worker `pow(avg, .5) * 76` for output, `AUDIO_MIC_GAIN`/`AUDIO_MIC_FLOOR` constants for mic; iterated through several rounds of sensitivity dial-in
- **Device picker** — clicking the device-name label opens a dropdown listing every output device (with OS-default flag); selection persists in `config.json` and survives reloads. Worker also runs a virtual-cable filter so the OS default doesn't auto-select VB-Audio / Voicemeeter when a real speaker is present.

### Processor & network — same cascade visual language
- CPU cores, GPU util bars, scratch / drive bars, memory-history (60 s), GPU VRAM all share a single `setMetricBar(fill, pct)` helper that paints fill height, manages a `.core-bar-peak` / `.gpu-bar-peak` sibling, and tracks per-bar peak-hold state via element dataset
- Old `.warn` / `.high` class swap retired (cascade gradient encodes urgency continuously instead of stepping through three colors)
- Network RX/TX and Disk Read/Write **SVG sparklines replaced with 96-bar grids** (up from 60 samples) so they share the same look as the audio bars; per-bar peak markers; gap tightened to 1 px

### Themes — 11 new + theme name + auto-cycle
- **`crimson`** — 3-shade red palette (#C90000 / #980002 / #68030E)
- **10 low-contrast complementary palettes**: `dust`, `slate`, `mint`, `lavender`, `harbor`, `moss`, `dusk`, `paper`, `storm`, `sage` — desaturated near-equal-luminance pairings so the HUD reads calm at a glance
- Total themes now **22**
- **Theme name chip** in the top-bar shows the current theme name; updates live on manual cycle, auto-cycle, or config restore
- **Auto-cycle button**: when armed, advances theme every 25 s; spinning clock-hand icon doubles as a visual countdown; state persists in `config.themeAuto`

### Thermal panel — power draw readouts + smaller temps
- Each row (CPU / GPU 0 / GPU 1) now shows a **watts chip** beside the temperature
- `nvidia-smi --query-gpu=power.draw` extended to feed GPU power
- LibreHardwareMonitor / OpenHardwareMonitor PowerShell query extended to harvest `Power` sensors for both CPU package and GPUs (fills in CPU power that nvidia-smi can't see)
- Temp font reduced 10 % (28 px → 25 px) so the new power chip fits without crowding

### Tooling
- `scripts/build-prompt-log.js` — walks the session JSONL transcript, extracts every user prompt (stripping system reminders / IDE wrappers), pairs each with the cumulative token usage of the assistant turns it triggered, writes `PROMPT-LOG.md` with a summary table + verbatim prompts. Run with `node scripts/build-prompt-log.js`.

## [0.2.0] — 2026-05-09

### System audio loopback (native WASAPI)
- Replaced failing browser-based loopback (`getDisplayMedia`, `chromeMediaSource: 'desktop'`, Stereo-Mix enumeration) with a native WASAPI capture path via `audify` / RtAudio
- audify runs in an isolated `utilityProcess.fork` child (`src/main/audify-worker.js`) so a native crash in the binding can't take down the main process
- Worker computes per-frame RMS and pushes `{rms, deviceName}` over IPC to the renderer; also sends the full output-device list on startup
- Heuristic skips known virtual cables (VB-Audio, Voicemeeter, NVIDIA Broadcast) when picking a default; OS default still wins if it's a real device
- **Clickable device picker** on the system-audio panel label — dropdown lists every output device; selection persists in `config.json` (`audioDeviceId`)
- Env-var escape hatches: `DASH3D_DISABLE_AUDIFY=1` skips the worker; `DASH3D_AUDIO_DEVICE_ID=<n>` overrides the picker

### Fix: silent launch crash after audify integration
- Root cause: `npm install audify` running under Node ≥21 selected the `napi-v10` prebuilt binary, which crashed inside Electron 30 (Node 20 / N-API 9 max), taking down the main process before any error could surface
- Fix: pinned audify to the `napi-v9` prebuild via a new `scripts/fix-audify-abi.js` `postinstall` hook (idempotent, leaves a `.napi-v9-installed` stamp)
- Defensive: audify is now loaded in a child process so any future ABI mismatch only kills the worker, not the app

### Audio visualizers (added before the loopback rework)
- Two dedicated panels: `audioInViz` (mic, amber, bottom-right) and `audioOutViz` (system, accent/cyan, bottom-left)
- Bar-grid visualization, drag-to-move, 4-corner resize, mute toggle
- Position / size / mute state persisted to `config.json` per panel
- Mute button raised above resize handle (z-index fix) so SW corner doesn't eat the click
- Native loopback path (`NATIVE_LOOPBACK_BOUND`) bypasses all browser capture when IPC is available

### Chat — Ollama + Azure OpenAI
- Local model chat via Ollama HTTP API (drop-down model selector)
- Azure OpenAI online chat with **AUTO** config button — discovers endpoint/deployment via the user's Azure CLI session
- Single visible model-selection control; endpoint / deployment / key fields hidden behind the AUTO flow
- Each send injects a fresh system prompt with current date / time / timezone / both chrono cities so models stop saying "I don't have access to real-time information"
- Ask + send controls slimmed 50% to free vertical room

### Themes (15 total) + invert
- 11 palettes: `default`, `azure`, `rose`, `ocean`, `pastel`, `meadow`, `citrus`, `neon`, `vaporwave`, `matrix`, `volt`
- 4 cyberpunk palettes added in a follow-up pass
- Top-bar theme-toggle button cycles through the list; invert button flips fg/bg luminance
- Global gamma/black-level retuned twice (originally too dark, then too lifted, settled in the middle)

### UI polish + animation
- Per-element strobing replaces per-panel strobe — labels, bars, badges, and chrome each animate on different beats so the HUD feels alive without being seizure-inducing
- Hover glow replaces the previous "wiggle on hover" interaction
- Background simplified: orbital rings dropped, animated speckles dropped, faint pulsing grid + tick marks remain (matching the user's reference image)
- Random per-section grid darkening so larger background grids breathe independently
- Corner-bracket panel chrome (the three-slash decorations) removed for cleaner look
- Brightness pulse softened by ~35% so dark phases stay legible

### Collapse + layout
- Notes panel and Chat panel are collapsible — when collapsed the body hides AND the empty grid cell goes away (no ghost outline)
- Refresh (F5) no longer leaves blank space on the right; panels re-fill the grid
- Resize from any side, not just SE corner
- Move + scale supported on all 4 corners

### System info breakdown
- SYSTEM panel split into separate **CPU**, **GPU**, **RAM** sections instead of one stacked block
- Memory & scratch-disk get their own logical-core-style bar grid
- THERMAL panel relocated under STORAGE
- CPU package temp fallback chain extended (still flaky on some boards — known issue)

### Always-on-bottom hardening
- Z-order demoted on `show` / `blur` / `focus` AND every 1s via a persistent PowerShell process so drag-drop / restore / app-switch can't shuffle the window above the taskbar
- Persistent PowerShell shell drops per-call cost from ~300 ms to ~10 ms

### Networking / iPad mode
- Built-in HTTP server on **port 7373** in the main process — exposes `/api/system-info`, `/storage-info`, `/temps-info`, `/net-info`, `/disk-info`, `/screen-sources`, config GET/POST, etc.; serves `dist/` statically
- Renderer detects browser-mode (`!window.dash`) and installs a fetch-based shim so the same `app.js` works in Safari on iPad
- Auto-grants `media` / `audioCapture` / `videoCapture` / `display-capture` / `mediaKeySystem` via both request + check handlers

### Build / launcher
- `Dashboard.bat` rebuilt: kills any running `Dashboard3D.exe`, runs `npm run build`, xcopies `dist/` + `src/main/main.js` + `preload.js` + `audify-worker.js`, launches the exe
- Pre-launch `taskkill /IM Dashboard3D.exe /F /T` so file handles release before xcopy (icudtl.dat lock fix)
- F12 → toggle DevTools (`win.webContents.toggleDevTools()`) for diagnosing renderer errors in the borderless window

## [0.1.0] — 2026-05-08 (initial commit)

### Project setup
- Electron 30 + Vite 5 + Three.js r164 desktop app scaffolded at `E:\VSCODE\Dashboard3D`
- `Dashboard.bat` launcher: rebuilds renderer, syncs `dist/` and `src/main/*.js` into the packaged folder, then launches `Dashboard3D.exe`
- `vite.config.js` with `base: './'` for correct asset paths in packaged build
- `electron-packager` for Windows packaging (`npm run package`)

### 3D scene
- Pure black background
- Starfield (initially 1500, then 1200, finally 600 points) with subtle drift rotation
- Initially: wireframe globe (`LineSegments` over icosahedron hull) + three orbital line rings
- Later: globe removed, orbital rings remained
- Final: orbital rings also removed; only starfield + faint ground grid remain
- Performance: pixel-ratio capped at 1.25, framerate capped at 3fps, paused when window hidden, `powerPreference: 'low-power'`

### UI restyle (sci-fi HUD)
- Palette: pure black bg, cyan `#5ccfff` primary, amber `#ffd05b`, red `#ff4b6e`, ok green `#5cf2a6`
- Typography: `Rajdhani` (condensed display) for big numerals, `Share Tech Mono` for micro-labels (Google Fonts)
- Panel chrome: hairline rules top/bottom, corner brackets via `::before` / `::after`
- Segmented progress bars (`repeating-linear-gradient`) instead of smooth gradient bars
- Big numerical readouts with red caret (`▶`) prefix
- Footer rows showing `NUMBER IDENT / CODE / ACT STATUS` mirroring the reference image

### CHRONO panel — dual + alt zone clocks
- 12-hour time format with AM/PM
- Local timezone time (large)
- Two configurable alt-zone times — type a city, hit Enter, Open-Meteo's geocoding API returns the IANA timezone, `Intl.DateTimeFormat` formats accordingly
- Day-of-year shown in panel header and bottom micro-grid
- Both alt cities persisted to `config.json`

### METEO panel — Open-Meteo weather
- Free, no API key
- Geocoding via `geocoding-api.open-meteo.com/v1/search`
- Forecast via `api.open-meteo.com/v1/forecast` with `temperature_2m`, `apparent_temperature`, `weather_code`, `wind_speed_10m`, `relative_humidity_2m`
- 28 weather codes mapped to label + emoji icon
- Refreshes every 10 minutes; saved city persists

### NOTES panel — tabbed scratchpad
- Multiple tabs, each independently named and edited
- `+ NEW` button to add a tab; `×` to delete (last tab can't be deleted, just cleared)
- Double-click tab name to rename via `prompt()` (max 14 chars, uppercased)
- Auto-save on textarea typing (500ms debounced); immediate save on tab create/delete/switch/rename
- Footer status: `EDITING` (amber) → `SAVED` (green)
- All tab state persisted to `config.json`

### SYSTEM panel — CPU + GPU + memory + scratch disk
- **PROCESSORS**: per-logical-processor vertical bar grid (one bar per core, auto-builds for any core count)
  - CPU load computed from `os.cpus().times` deltas in the main process
  - Bar colors: cyan → amber ≥60% → red ≥85%
- **GPU UTIL**: vertical bar per GPU with util %; fed by `systeminformation.graphics()` and falls back to `nvidia-smi` if available
- **GPU MEMORY**: horizontal bar per GPU, used / total VRAM; nvidia-smi extends `--query-gpu=memory.used,memory.total`
- **CPU LOAD**: aggregate horizontal bar
- **MEMORY**: aggregate system memory bar
- **MEM HISTORY · 60S**: 30-bar time-series (2s sample interval) of memory % usage
- **SCRATCH DISK**: one vertical bar per drive built from storage info; rebuilds on drive set change

### THERMAL panel — sensor array
- CPU package + GPU 0 + GPU 1 °C readouts
- Three-layer fallback chain: `systeminformation.cpuTemperature/graphics()` → `nvidia-smi` → LibreHardwareMonitor / OpenHardwareMonitor WMI namespace
- Bar fill scales 0–100°C; warn ≥70°C; high ≥85°C
- Footer shows which sources reported (`SI` / `NVSMI` / `LHM`)

### STORAGE panel — drive list
- PowerShell + `Get-CimInstance Win32_LogicalDisk` + `Win32_MappedLogicalDisk` + `Get-PSDrive` (multi-source merge, deduped by drive ID)
- Includes network / FTP / mapped drives that report no size — shown as `[NETWORK]` instead of `0 B / 0 B`
- Per-drive segmented bar; red ≥90% used
- Footer: overall % used + free TB

### NETWORK panel — live traffic
- Polled every 1s via `systeminformation.networkStats('*')` (chained `setTimeout` to keep calls serialized)
- DOWNLINK + UPLINK rate with auto-formatted units (B/S → KB/S → MB/S → GB/S)
- 60-sample SVG sparklines (cyan for RX, amber for TX)
- RX TOTAL / TX TOTAL cumulative bytes; active interface name
- Footer: `STATE: IDLE/ACTIVE` + total rate

### DRIVE I/O panel — physical disk
- Polled every 2s via PowerShell + `Win32_PerfFormattedData_PerfDisk_PhysicalDisk`
- READ + WRITE rate with sparklines (matching NETWORK panel style)
- Transfers/sec, current queue length, target instance (`_Total`)
- Footer: `STATE: IDLE/ACTIVE` + total rate
- Falls back gracefully to `UNSUPPORTED` on Windows builds where the WMI class is unavailable

### Persistent config
- JSON at `%APPDATA%\Dashboard3D\config.json` (`app.getPath('userData')`)
- Survives `npm run package` and exe relaunches
- Stores: `weatherCity`, `altCity`, `altCity2`, `notes`, `panelSizes` (width / height / x / y per panel)
- IPC: `config-get`, `config-set` (deep-merge partials), `config-path`

### Window behavior
- Starts in **fullscreen** (`BrowserWindow { fullscreen: true }`)
- **F11** toggles fullscreen (renderer captures keydown, calls `toggle-fullscreen` IPC)
- **F5** reloads the renderer (also wired to a top-center refresh button)
- **Ctrl+Shift+R** resets all panel positions, sizes, and `panelSizes` config entry
- **Always-on-bottom**: window pushed to back of z-order on launch and on every blur via Win32 `SetWindowPos(hwnd, HWND_BOTTOM)` shelled out via PowerShell

### Layout
- CSS Grid for HUD: `grid-template-rows: 1fr 1fr 1fr` enforces three equal-height rows
- Each row uses CSS Grid for explicit equal-width columns (3 cols for top, 2 cols for mid + bottom)
- Panel max-widths removed so panels fill their cells edge-to-edge
- `overflow-y: auto` on `.panel-body` with a slim cyan scrollbar — content scrolls inside if it overflows the cell
- Three rows of panels:
  - Row 1: `CHRONO | NOTES | METEO`
  - Row 2: `SYSTEM | (STORAGE on top of THERMAL stack)`
  - Row 3: `DRIVE I/O | NETWORK`

### Drag-to-move + 4-corner resize
- Click + drag any panel's **header bar** to reposition (panel detaches from grid → `position: fixed`)
- Each panel has 4 corner resize handles (NW / NE / SW / SE), hash-mark style
- Each corner resizes both width and height; the dragged corner follows the cursor while the opposite corner stays anchored
- Min size 280 × 120; both axes persisted to `config.panelSizes`
- Cursor is the appropriate `nwse-resize` / `nesw-resize` for diagonal feedback
- Active drag/resize raises panel z-index and adds a cyan outline

### Refresh button
- Small 30 × 30 chip top-center of viewport with circular-arrow icon (SVG)
- Click or press **F5** to `window.location.reload()`
- Hover rotates the icon 120°; click snaps to 360°

### Native data dependencies
- `systeminformation` (npm) — CPU temps, GPU info, network stats
- Windows-only PowerShell shells:
  - `Win32_LogicalDisk` / `Win32_MappedLogicalDisk` / `Get-PSDrive` — drive enumeration
  - `Win32_PerfFormattedData_PerfDisk_PhysicalDisk` — disk I/O rates
  - `nvidia-smi --query-gpu=...` — GPU temp + util + memory
  - LibreHardwareMonitor / OpenHardwareMonitor WMI namespace — CPU package temp fallback
  - `SetWindowPos(HWND_BOTTOM)` — always-on-bottom z-order

### Stack
- Electron 30 — desktop shell
- Vite 5 — dev server + production build
- Three.js r164 — 3D scene
- systeminformation 5.x — system metrics
- Vanilla JS (ESM) renderer
- CSS Grid for layout, custom CSS for sci-fi visuals
- Google Fonts: Rajdhani + Share Tech Mono
