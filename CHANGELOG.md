# Changelog

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
