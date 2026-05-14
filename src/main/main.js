const { app, BrowserWindow, BrowserView, ipcMain, Menu, clipboard, screen, session, desktopCapturer, utilityProcess, shell, protocol, net, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile, spawn, exec } = require('child_process');
const si = require('systeminformation');

// Platform-specific services. Each module re-exports either ./win or
// ./linux based on process.platform. Phase 1 starting with `power`;
// audio + sensors will follow under the same pattern.
const powerService   = require('./services/power');
const systemService  = require('./services/system');
const sensorsService = require('./services/sensors');
const audioService   = require('./services/audio');
const wmService      = require('./services/wm');

const HTTP_PORT = 7373;
const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Main HUD BrowserWindow. Captured in createWindow() so the embedded
// BROWSER pane can attach/detach BrowserViews against it.
let _mainWin = null;
// Global key hook (module scope so before-quit can reach it). The
// actual spawn + handlers live inside registerIpc(); these refs let
// the lifecycle hook clean up on app exit.
let _keyHookProc = null;
let _keyHookEnabled = false;
function _stopKeyHook() {
  if (_keyHookProc) {
    try { _keyHookProc.kill(); } catch {}
    _keyHookProc = null;
  }
}

// ─── SHARED UTILITIES ──────────────────────────────────────────────

// Shared PowerShell runner moved to services/_util/powershell.js so every
// Windows-side service backend (audio, sensors, system, …) uses the same
// spawn shape. Re-imported here because the rest of main.js still has
// inline PowerShell probes that haven't been migrated to services yet.
const { runPowerShell } = require('./services/_util/powershell');

// Primary display's work area = screen bounds minus taskbar reserve.
function getWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

// LHM launching + native fallback moved to services/sensors.

// ─── MAIN HUD WINDOW ───────────────────────────────────────────────

function createWindow() {
  const wa = getWorkArea();

  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: false, // keep in taskbar so the user can click to bring it forward
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Dashboard window allows autoplay so boot SFX and any procedural
      // audio at startup can play before the user clicks anything.
      // Third-party content (browser-pane) gets the strict policy
      // independently via its BrowserView webPreferences below.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  _mainWin = win;
  win.on('closed', () => { _mainWin = null; });

  win.removeMenu();

  // F12 → toggle DevTools (handy for diagnosing renderer errors when the
  // window is borderless and can't be right-clicked).
  // Escape during zen → force the renderer to leave zen. Goes through
  // before-input-event so we still catch Escape even when a focused
  // input in the renderer wants to swallow it via stopPropagation.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') { win.webContents.toggleDevTools(); return; }
    if (input.key === 'Escape' && _zenIsActiveInMain) {
      try { win.webContents.send('force-leave-zen'); } catch {}
    }
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  // Re-snap to work area whenever the OS reconfigures (e.g. taskbar autohide
  // toggle, display change). Cheap and idempotent.
  const reSnap = () => {
    if (win.isDestroyed() || win.isFullScreen()) return;
    const a = getWorkArea();
    win.setBounds(a);
  };
  screen.on('display-metrics-changed', reSnap);
  screen.on('display-added', reSnap);
  screen.on('display-removed', reSnap);

  // Always-on-bottom: demote on every focus AND blur AND on a periodic
  // interval. Some Windows interactions (drag-drop, restore-from-minimize,
  // app-switching) shuffle z-order without firing blur, so a 1s safety-net
  // interval catches anything the events miss.
  win.once('ready-to-show', () => sendToBottom(win));
  win.on('show',  () => sendToBottom(win));
  win.on('blur',  () => sendToBottom(win));
  win.on('focus', () => sendToBottom(win));

  // Re-assert bottom Z-order periodically in case another app changes
  // the window order. 1s was overkill — 5s is plenty for "stay on the
  // desktop" behavior and avoids waking the wm thread every second.
  const _bottomInterval = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(_bottomInterval); return; }
    sendToBottom(win);
  }, 5000);

  // Removed: setZoomFactor(1.2) in tandem with force-device-scale-factor=1.
  // That combination forced Chromium's compositor to pre-scale every layer
  // by 1.2× on every paint — at 3200×1800 × 117 Hz that's ~670 megapixels/s
  // of constant rasterizer work in the GPU process, lighting all cores via
  // Chromium's parallel tile raster threads. Letting Chromium use native
  // device pixel ratio is much cheaper.

  // Native WASAPI loopback for the default output device. Pushes per-frame
  // RMS levels to the renderer over IPC ('audio-out-level'). readConfig is
  // passed in so the service can honor the persisted audioDeviceId without
  // taking a direct dependency on our config module.
  win.webContents.once('did-finish-load', () => audioService.startLoopback(win, null, readConfig));
  win.on('closed', () => audioService.stopLoopback());
}

// ─── YOUTUBE POPOUT ────────────────────────────────────────────────
// Frameless always-on-top window. No webview, no youtube.com page load —
// the renderer is a small custom UI (search bars + results list + native
// <video> element). yt-client (shared with the standalone YouTubePop)
// resolves stream URLs via bundled yt-dlp and search via InnerTube +
// Bing + DDG + Google. Result: zero YouTube web-player JS in our
// process, so there's nothing to inject ads into.
const yt = require('yt-client');

let _ytWin = null;
function openYouTubeWindow() {
  if (_ytWin && !_ytWin.isDestroyed()) {
    _ytWin.show();
    _ytWin.focus();
    return;
  }
  _ytWin = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 480,
    minHeight: 270,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    title: 'YouTube',
    useContentSize: true,
    // Crucial for zen mode: at 5% opacity Chromium can flag this window
    // as "occluded" / backgrounded and drop its frame rate. The cmd-line
    // switches (CalculateNativeWinOcclusion, disable-renderer-back-
    // grounding) cover most of this; paintWhenInitiallyHidden +
    // backgroundThrottling cover the rest.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'youtube-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  _ytWin.removeMenu();
  // Esc handler: if the dashboard is in zen, leave zen (and let zen's
  // own teardown restore this window). Otherwise close. The renderer
  // intercepts Escape FIRST when the player view is active (returns to
  // results); main only fires this when the renderer didn't preventDefault.
  const handleEsc = () => {
    // Previously this referenced _audioWin (since deleted), which made
    // the check always fail and Escape in zen close the YT popout
    // instead of dropping zen. Route to the dashboard's main window
    // when zen is active so the user gets out of zen instead.
    if (_zenIsActiveInMain && _mainWin && !_mainWin.isDestroyed()) {
      _mainWin.webContents.send('force-leave-zen');
      return;
    }
    _ytWin?.close();
  };
  // Lock the *content* to exact 16:9. setAspectRatio is the native lock;
  // will-resize / resize fallbacks correct rounding drift on Windows.
  _ytWin.setAspectRatio(16 / 9);
  _ytWin.setContentSize(640, 360);
  _ytWin.on('will-resize', (event, newBounds) => {
    const target = Math.round(newBounds.width * 9 / 16);
    if (newBounds.height !== target) {
      event.preventDefault();
      _ytWin.setBounds({
        x: newBounds.x,
        y: newBounds.y,
        width: newBounds.width,
        height: target,
      });
    }
  });
  let _ytFixing = false;
  _ytWin.on('resize', () => {
    if (_ytFixing) return;
    const [w, h] = _ytWin.getContentSize();
    const target = Math.round(w * 9 / 16);
    if (h !== target) {
      _ytFixing = true;
      _ytWin.setContentSize(w, target);
      setTimeout(() => { _ytFixing = false; }, 50);
    }
  });
  _ytWin.loadFile(path.join(__dirname, 'youtube-host.html'));
  _ytWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') handleEsc();
  });
  _ytWin.on('closed', () => {
    _ytWin = null;
    _ytPreZenBounds = null;
    // Destroy the hidden Google-scrape window (owned by yt-client) so
    // we don't leak across popout open/close cycles.
    try { yt.shutdownGoogle(); } catch {}
  });
}

// Zen-mode treatment for the YouTube popout: cover the active display at
// 5% opacity (95% transparent) so video can keep playing in the background
// without obscuring the zen overlay. Restores prior bounds + opacity on
// exit. No-op when the window isn't open. _zenIsActiveInMain is the flag
// the YouTube Esc handler reads to decide whether Esc should leave zen
// or close the popout.
//
// Note: we deliberately use setBounds(displayBounds) instead of
// setFullScreen(true). Native fullscreen + setOpacity on Windows triggers
// a DWM compositing path that drops the window's effective frame rate
// to ~1 Hz, which manifests as video stutter / pauses. Just sizing to
// fill the display keeps it as a regular always-on-top window with no
// fullscreen optimizations getting in the way.
let _ytPreZenBounds = null;
let _zenIsActiveInMain = false;
function applyYoutubeZenMode(on) {
  _zenIsActiveInMain = !!on;
  if (!_ytWin || _ytWin.isDestroyed()) return false;
  if (on) {
    // Save current bounds so we can restore on exit, then expand to fill
    // the display the window is currently on. Smooth playback at 5%
    // opacity relies on the anti-throttle stack (no native fullscreen,
    // backgroundThrottling off, occlusion-detection disabled,
    // document.hidden stubbed in the page).
    if (!_ytPreZenBounds) _ytPreZenBounds = _ytWin.getBounds();
    const display = screen.getDisplayMatching(_ytWin.getBounds());
    _ytWin.setBounds(display.bounds);
    // Full opacity — the YouTube playback becomes the zen background.
    // The dashboard renderer's zen overlay (clock / weather) sits on
    // top via its own window.
    _ytWin.setOpacity(1);
    try { _ytWin.webContents.setBackgroundThrottling(false); } catch {}
  } else {
    _ytWin.setOpacity(1);
    if (_ytPreZenBounds) {
      _ytWin.setBounds(_ytPreZenBounds);
      _ytPreZenBounds = null;
    }
  }
  return true;
}

// Audio (WASAPI loopback worker + system mute + default endpoint
// switching) lives in services/audio. Windows backend wraps audify +
// inline C# COM via PowerShell; Linux backend stubs out for Phase 3
// (PipeWire). Below this comment used to be: _audioProc/_audioWin
// globals, startWasapiLoopback / stopWasapiLoopback /
// restartWasapiLoopback, _SYSTEM_AUDIO_CS, setSystemMute,
// setDefaultEndpoint, getSystemMuteStates. ~245 lines moved.


// Window z-order management moved to services/wm — Windows pins the
// HWND to the bottom via a persistent PowerShell pipe + SetWindowPos;
// Linux (cage kiosk) is a no-op.

function sendToBottom(win) {
  wmService.sendToBottom(win);
}

app.on('before-quit', () => {
  audioService.stopLoopback();
  wmService.shutdown();
  _stopKeyHook();
});

// ─── USER FOLDERS ──────────────────────────────────────────────────
// Long-lived user content lives next to the app .exe so it stays with
// the installation and is easy to browse in Explorer. In development
// `app.getPath('exe')` resolves to the bundled electron binary inside
// node_modules — drop those files at the project root instead so dev
// runs don't litter node_modules/electron/dist with stray folders.
function userFoldersBase() {
  return app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : path.resolve(__dirname, '..', '..');
}
function galleryFolderPath()   { return path.join(userFoldersBase(), 'gallery');   }
function docsFolderPath()      { return path.join(userFoldersBase(), 'docs');      }
function downloadsFolderPath() { return path.join(userFoldersBase(), 'downloads'); }
function ensureUserFolders() {
  for (const p of [galleryFolderPath(), docsFolderPath(), downloadsFolderPath()]) {
    try { fs.mkdirSync(p, { recursive: true }); }
    catch (err) { console.warn(`could not create ${p}:`, err.message); }
  }
}
// Return the managed root (gallery/ docs/ downloads/) that contains `abs`,
// or null if `abs` lives outside all of them. Used by the explore IPC
// handlers to gate any path the renderer hands us.
function _managedRootFor(abs) {
  const g = galleryFolderPath();
  const d = docsFolderPath();
  const dl = downloadsFolderPath();
  if (abs === g  || abs.startsWith(g  + path.sep)) return g;
  if (abs === d  || abs.startsWith(d  + path.sep)) return d;
  if (abs === dl || abs.startsWith(dl + path.sep)) return dl;
  return null;
}
function _pathInsideManagedRoot(abs) { return _managedRootFor(abs) !== null; }

// ─── APP LIFECYCLE ─────────────────────────────────────────────────
// Custom protocol — `dash3d-file://<absolute-path>` reads files only from
// inside the managed gallery/docs roots. Used by the EXPLORE pane's
// thumbnail grid so <img src> can preview gallery images without us
// disabling webSecurity on the BrowserWindow. Scheme must be registered
// here (before app.whenReady) so it's flagged secure + supports streams.
protocol.registerSchemesAsPrivileged([
  { scheme: 'dash3d-file', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } },
]);

// Stop Chromium from detecting "the YouTube window is occluded by the
// dashboard" and pausing the renderer / freezing media. These need to
// be set BEFORE app.whenReady fires.
// NOTE: we intentionally do NOT disable IntensiveWakeUpThrottling or
// the renderer-backgrounding flags here — disabling those keeps every
// setInterval in the app (clock, system stats, weather, BGM scheduler,
// terminal telemetry, FPS counter, etc.) firing at full speed even
// when the window is hidden, which pegs CPU and spins fans.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Force Chromium's desktopCapturer onto the Windows Graphics Capture
// (WGC) backend for both individual windows and full screens. The
// default GDI BitBlt path cannot read DirectX / OpenGL / Vulkan
// back-buffers, so any 3D-rendered viewport (Cinema 4D, Blender,
// games, etc.) shows black in the capture even though the window
// chrome captures fine. WGC reads directly from the desktop
// compositor and sees hardware-accelerated content correctly.
// Requires Windows 10 1903 (May 2019) or newer; older Windows just
// falls back to GDI silently. Windows will draw a thin yellow border
// around captured windows while WGC is active — this is OS-side and
// doesn't appear in the recording.
// GPU-friendly feature toggles, batched into a single switch so we
// don't trample the WGC flags above. Effects:
//   AllowWgcWindowCapturer / AllowWgcScreenCapturer — see comment above.
//   CanvasOopRasterization — out-of-process canvas raster (frees
//     renderer from rasterizing big canvases like the music
//     visualizer / audio waveform on every frame).
//   AcceleratedVideoDecodeLinuxGL / VaapiVideoDecodeLinuxGL — Linux
//     hardware-decode hints (harmless on Windows).
app.commandLine.appendSwitch('enable-features',
  'AllowWgcWindowCapturer,AllowWgcScreenCapturer,CanvasOopRasterization,' +
  'AcceleratedVideoDecodeLinuxGL,VaapiVideoDecodeLinuxGL,VaapiVideoEncoder');
// NOTE: previously force-enabled ignore-gpu-blocklist + enable-gpu-rasterization
// + enable-zero-copy + enable-accelerated-video-decode here. Those flags pushed
// Chromium into paths that, on systems with healthy drivers, did NOT speed
// things up — they introduced constant raster-to-GPU transfers and kept the
// renderer busy even at idle (multiple Dashboard3D.exe processes pegged at
// idle, fans spiking). Reverted to Chromium's auto-pick. The ffmpeg export
// still uses NVENC / QSV / AMF as a separate process — independent of these.
// Pin to D3D11 ANGLE backend on Windows — most stable for our mix of
// MediaRecorder + WebGL + filter()-heavy CSS. Default ANGLE picks
// D3D11 anyway on modern Windows, but being explicit avoids surprise
// fallbacks on systems where the auto-pick goes to OpenGL.
app.commandLine.appendSwitch('use-angle', 'd3d11');
// Per-window autoplay policy instead of a global switch — the dashboard
// itself needs to autoplay its boot SFX before the user clicks anything
// (otherwise the CRT power-on tone is silent on startup). The
// BrowserView's webPreferences sets the strict policy so third-party
// pages still can't autoplay hero/ad video and rev the fans.
// Smooth scrolling is GPU-accelerated and runs an animation curve on every
// scroll. We don't want any of it in this pane — instant scroll is fine.
app.commandLine.appendSwitch('disable-smooth-scrolling');

// Force the renderer to a 1× device scale factor regardless of the OS
// display scaling. On a HiDPI / 200%-scaled monitor this drops the GPU
// fill cost by ~4× (paints 2560×1440 instead of 5120×2880). UI looks
// slightly softer than native @2x but the entire compositor — animations,
// panel pulses, grid overlay, embedded browser, audio canvases — gets cheaper.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Embedded BROWSER pane dark mode: nativeTheme.themeSource = 'dark' is
// set in app.whenReady(). Sites that respect prefers-color-scheme go
// dark. Sites that don't (legacy light-only) stay light — Chromium's
// WebContentsForceDark feature flag mangles enough sites' stylesheet
// rendering that we don't enable it.

app.whenReady().then(() => {
  // Auto-grant all media-related permissions so the renderer can call
  // getUserMedia, getDisplayMedia, and the desktop-capture path without
  // hitting permission prompts. Both the request handler (async) and the
  // check handler (sync) need to allow these.
  const ALLOWED_PERMS = new Set([
    'media', 'audioCapture', 'videoCapture',
    'display-capture', 'mediaKeySystem',
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ALLOWED_PERMS.has(permission);
  });

  // System audio loopback without a screen-picker dialog.
  // Renderer calls navigator.mediaDevices.getDisplayMedia({ audio: true,
  // video: false }) and we substitute 'loopback' for the audio track.
  if (typeof session.defaultSession.setDisplayMediaRequestHandler === 'function') {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      }).catch(() => callback({}));
    });
  }

  // Embedded browser tab — in-memory ("private") session with a hardcoded
  // ad/tracker domain blocklist. Each BrowserView is created with
  // partition="persist:dash-browser" so this session is backed by disk:
  // cookies, localStorage, IndexedDB and service workers SURVIVE app
  // restart. That keeps signed-in sites signed in. Cache + browsing
  // history are wipeable via the CLEAR DATA button (handled below by
  // the 'browser-clear-data' IPC), which selectively keeps the storage
  // types where auth tokens typically live. The blocklist is a
  // substring match against the request URL; it's not a full ABP
  // engine but it cuts the obvious surveillance + ad networks.
  const _BROWSER_PARTITION = 'persist:dash-browser';
  const _BROWSER_BLOCKLIST = [
    'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
    'googletagservices.com', 'google-analytics.com', 'googleadservices.com',
    'adservice.google.', 'pagead2.googlesyndication',
    'facebook.com/tr', 'connect.facebook.net', 'fbcdn.net/signals',
    'analytics.twitter.com', 'ads-twitter.com', 'static.ads-twitter.com',
    'scorecardresearch.com', 'quantserve.com', 'quantcast.com',
    'adsystem.', 'adsrvr.org', 'adnxs.com', 'rubiconproject.com',
    'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
    'hotjar.com', 'mouseflow.com', 'fullstory.com', 'mixpanel.com',
    'segment.io', 'segment.com', 'amplitude.com', 'heap.io', 'heapanalytics.com',
    'branch.io', 'appsflyer.com', 'adjust.com', 'kochava.com',
    'mathtag.com', 'bidswitch.net', 'casalemedia.com', 'pubmatic.com',
    'openx.net', 'yieldmo.com', 'moatads.com', 'serving-sys.com',
    'bing.com/bat', 'clarity.ms',
    'snowplowanalytics.com', 'newrelic.com/marketing',
    'sentry-cdn.com/marketing', 'cloudflareinsights.com',
    // Web fonts — pure decoration, fall back to system fonts (which
    // matches the dashboard's mono aesthetic anyway). Saves hundreds of
    // KB per page + the CPU cost of font shaping.
    'fonts.googleapis.com', 'fonts.gstatic.com',
    'use.typekit.net', 'use.fontawesome.com',
    'fonts.shopifycdn.com', 'fast.fonts.net',
    // Cookie consent banners — heavy scripts, modal overlays, focus traps.
    // We use a non-persistent session anyway so consent is moot.
    'cookielaw.org', 'onetrust.com', 'cookieyes.com', 'didomi.io',
    'quantcast.mgr.consensu.org', 'cookiebot.com',
    // Live chat widgets — open a real-time WebSocket and keep it alive.
    'intercom.io', 'intercomcdn.com', 'widget.intercom.io',
    'drift.com', 'js.driftt.com',
    'zopim.com', 'tawk.to', 'livechatinc.com',
    'crisp.chat', 'helpscout.net/beacon',
    // A/B testing + experiment flicker-control scripts run mutation
    // observers across the whole DOM on every page.
    'optimizely.com', 'optimizelyedge.com',
    'vwo.com', 'visualwebsiteoptimizer.com',
    // Push-notification SDKs — register service workers, drain battery.
    'onesignal.com', 'pushwoosh.com', 'pushcrew.com',
    // Marketing automation + customer-data SDKs (tracking-grade payload
    // bigger than the actual page on many sites).
    'hs-scripts.com', 'hs-analytics.net', 'hsforms.net',
    'mktoresp.com', 'mc.yandex.ru',
    'segmentapi.', 'mparticle.com',
    // Additional ad networks + tracker pixels that slipped through the
    // baseline. EasyList-equivalent core: these are the highest-traffic
    // domains in modern programmatic ad chains.
    'amazon-adsystem.com', 'aax.amazon-adsystem.com', 'adsystem.amazon.',
    'media.net', 'contextweb.com', 'smartadserver.com', 'sas-pr.com',
    'adform.net', 'turn.com', 'demdex.net', 'omtrdc.net',
    'everesttech.net', 'serving-sys.com', '2mdn.net', '3lift.com',
    'tribalfusion.com', 'exelator.com', 'agkn.com', 'tapad.com',
    'pippio.com', 'rfihub.com', 'liadm.com', 'pinterest-analytics.',
    'snapkit.com', 'sc-static.net', 'tiktok.com/i18n/pixel', 'analytics.tiktok',
    'redditstatic.com/ads', 'reddit.com/api/v2/business',
    'cloudflareinsights.com', 'static.cloudflareinsights.com',
    'segment.io', 'cdn.segment.com',
    'doubleverify.com', 'iasds01.com', 'ias-pub.com', 'moatpixel.com',
    // Newsletter / lead-capture popup vendors. Their scripts render the
    // full-page overlay popups that the popup-blocker can't catch (it
    // only sees window.open, not in-page modals).
    'sumo.com', 'optinmonster.com', 'app.getsitecontrol.com',
    'sleeknote.com', 'popupally.com', 'unbounce.com',
    // Push-notification / web-push prompt scripts.
    'subscribers.com', 'cdn.signalize.com', 'cleverpush.com',
    // Session-replay / heatmap (privacy-invasive, heavy DOM listeners).
    'logrocket.com', 'cdn.logrocket.com', 'inspectlet.com',
    'smartlook.com', 'rec.smartlook.com',
    'glassbox.com', 'contentsquare.com', 'cs.contentsquare.net',
  ];
  const browserSession = session.fromPartition(_BROWSER_PARTITION);

  // ── Browser history store ─────────────────────────────────────────
  // Recent visits, deduplicated against the head (consecutive same-URL
  // navigations just bump the head's title+timestamp). Capped at 500
  // entries, persisted to userData\browser-history.json on a 5-second
  // debounce so we don't write on every single navigation. Loaded once
  // on startup. IPC handlers below let the renderer fetch and clear.
  const _historyFile = path.join(app.getPath('userData'), 'browser-history.json');
  let _history = [];
  let _historyFlushTimer = null;
  try {
    const raw = fs.readFileSync(_historyFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) _history = parsed.filter(e => e && typeof e.url === 'string').slice(0, 500);
  } catch { /* file missing or unparseable — start fresh */ }
  function _scheduleHistoryFlush() {
    if (_historyFlushTimer) return;
    _historyFlushTimer = setTimeout(() => {
      _historyFlushTimer = null;
      try {
        fs.mkdirSync(path.dirname(_historyFile), { recursive: true });
        fs.writeFileSync(_historyFile, JSON.stringify(_history.slice(0, 500)), 'utf8');
      } catch {}
    }, 5000);
  }
  function _pushHistory(url, title) {
    if (!url) return;
    // Skip internal/error schemes — they're not real visits.
    if (/^(about:|chrome:|chrome-error:|data:|file:|devtools:)/i.test(url)) return;
    const now = Date.now();
    const head = _history[0];
    if (head && head.url === url) {
      // Same URL as last visit — refresh title/timestamp instead of
      // pushing a duplicate row. Common when a title-update event
      // fires shortly after did-navigate.
      if (title) head.title = title;
      head.ts = now;
    } else {
      _history.unshift({ url, title: title || url, ts: now });
      if (_history.length > 500) _history.length = 500;
    }
    _scheduleHistoryFlush();
  }
  // Light UA touch only: strip the Electron/Dashboard3D substrings from
  // the default UA so a few WAFs don't serve a stripped fallback. Keep
  // the Chromium version that Electron actually reports — overriding it
  // (with a higher Chrome version) plus forcing matching Sec-CH-UA hints
  // made Google's "Sign in with Google" widget render its CSS source as
  // visible text on partner sites (dribbble, etc).
  try {
    browserSession.setUserAgent(
      browserSession.getUserAgent()
        .replace(/Electron\/[\d.]+\s*/i, '')
        .replace(/Dashboard3D\/[\d.]+\s*/i, ''),
    );
  } catch {}
  // Live counters surfaced on the browser splash screen. adsBlocked is
  // bumped here every time a request matches the blocklist; popups is
  // counted in the app-level web-contents-created handler below since
  // BrowserView's window-open events live in the main process. Broadcast
  // is throttled to 250 ms so a heavy ad-laden page doesn't flood IPC
  // during its initial load.
  let _adsBlocked = 0;
  let _imagesBlocked = 0;
  let _popupsBlocked = 0;
  let _statsDirty = false;
  let _statsTimer = null;
  function _broadcastBrowserStats() {
    if (_statsTimer) return;
    _statsTimer = setTimeout(() => {
      _statsTimer = null;
      if (!_statsDirty) return;
      _statsDirty = false;
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('browser-stats', {
          adsBlocked:    _adsBlocked,
          imagesBlocked: _imagesBlocked,
          popupsBlocked: _popupsBlocked,
        });
      }
    }, 250);
  }
  // Reader mode: when on, the webRequest handler below cancels every
  // image request. Toggled from the renderer's reader button; persisted
  // by the renderer to config, set here on init.
  let _readerMode = false;
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    if (_readerMode && details.resourceType === 'image') {
      _imagesBlocked++;
      _statsDirty = true;
      _broadcastBrowserStats();
      callback({ cancel: true });
      return;
    }
    const u = (details.url || '').toLowerCase();
    for (const term of _BROWSER_BLOCKLIST) {
      if (u.includes(term)) {
        _adsBlocked++;
        _statsDirty = true;
        _broadcastBrowserStats();
        callback({ cancel: true });
        return;
      }
    }
    callback({});
  });
  ipcMain.handle('browser-get-stats', () => ({
    adsBlocked:    _adsBlocked,
    imagesBlocked: _imagesBlocked,
    popupsBlocked: _popupsBlocked,
  }));
  ipcMain.handle('browser-reset-stats', () => {
    _adsBlocked = 0;
    _imagesBlocked = 0;
    _popupsBlocked = 0;
    _statsDirty = true;
    _broadcastBrowserStats();
    return { adsBlocked: 0, imagesBlocked: 0, popupsBlocked: 0 };
  });
  ipcMain.handle('browser-set-reader-mode', (_e, on) => { _readerMode = !!on; return { ok: true, readerMode: _readerMode }; });

  // Pin the main window above every other application window. Used by
  // the productivity panel's focus modes so the dashboard doesn't get
  // covered while the user is concentrating on one pane.
  ipcMain.handle('set-always-on-top', (_e, on) => {
    if (!_mainWin || _mainWin.isDestroyed()) return { ok: false };
    try { _mainWin.setAlwaysOnTop(!!on); return { ok: true, alwaysOnTop: !!on }; }
    catch (err) { return { ok: false, error: err?.message }; }
  });

  // Dark-mode toggle for embedded pages. Applies/removes the aggressive
  // invert CSS on every open tab and persists the choice in config so
  // it sticks across launches. Returns the new state so the renderer
  // can paint the toggle button correctly without a follow-up roundtrip.
  ipcMain.handle('browser-set-dark-mode', async (_e, on) => {
    _bvDarkMode = !!on;
    try { writeConfig({ browserDarkMode: _bvDarkMode }); } catch {}
    for (const [id, t] of _bvTabs.entries()) {
      const wc = t.view.webContents;
      if (_bvDarkMode) {
        try {
          const key = await wc.insertCSS(_PAGE_DARK_INVERT_CSS);
          _bvDarkCssKeys.set(id, key);
        } catch {}
      } else {
        const key = _bvDarkCssKeys.get(id);
        if (key) {
          try { await wc.removeInsertedCSS(key); } catch {}
          _bvDarkCssKeys.delete(id);
        }
      }
    }
    return { ok: true, darkMode: _bvDarkMode };
  });
  ipcMain.handle('browser-get-dark-mode', () => ({ darkMode: _bvDarkMode }));

  // Browser zen-backdrop: when the dashboard enters zen and a tab has a
  // playing video, expand that BrowserView to fill the host window and
  // inject CSS that promotes every <video> on the page to a fullscreen
  // overlay. The dashboard renderer's zen overlay (clock / weather)
  // still sits on top because BrowserViews paint underneath the host
  // window's webContents in our setup.
  let _bvZenSavedBounds = null;
  let _bvZenCssKey = null;
  let _bvZenTabId  = null;
  const _BV_ZEN_CSS = `
    html, body { background: #000 !important; overflow: hidden !important; }
    video {
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      object-fit: contain !important;
      background: #000 !important;
      z-index: 2147483647 !important;
    }
  `;

  // ── Browser opacity (zen-mode see-through) ─────────────────────
  // BrowserView lives inside the dashboard window so it can't use
  // BrowserWindow.setOpacity() the way the YouTube popout does. Closest
  // equivalent: CSS-inject `opacity` onto the page + set the BV's own
  // background to transparent so the zen dashboard behind shows through
  // the dimmed page content. State is tracked per-BV so the choice
  // sticks when the user re-enters zen or switches tabs.
  let _bvOpacityCssKey = null;
  let _bvOpacityTabId  = null;
  let _bvLastOpacity   = 1.0;
  async function _applyBvOpacity(view, opacity) {
    if (!view) return;
    const wc = view.webContents;
    // Clear any prior injection first.
    if (_bvOpacityCssKey) {
      try { await wc.removeInsertedCSS(_bvOpacityCssKey); } catch {}
      _bvOpacityCssKey = null;
    }
    if (opacity >= 1) {
      // Fully opaque — restore the BV's default dark background.
      try { view.setBackgroundColor('#0a0a0a'); } catch {}
      return;
    }
    // Transparent — make the BV's surface alpha so the dashboard zen
    // overlay can render through, then dim the page content via CSS.
    try { view.setBackgroundColor('#00000000'); } catch {}
    try {
      _bvOpacityCssKey = await wc.insertCSS(
        `html, body { opacity: ${opacity} !important; background: transparent !important; }`,
      );
    } catch {}
  }
  ipcMain.handle('browser-set-opacity', async (_e, opacity) => {
    const o = Math.max(0.1, Math.min(1, Number(opacity)));
    if (!Number.isFinite(o)) return { ok: false };
    _bvLastOpacity = o;
    // Apply to whichever BV is currently shown: the zen-mode tab if zen
    // is active, otherwise the active tab.
    const targetId = _bvZenTabId != null ? _bvZenTabId : _bvActiveId;
    const t = targetId != null ? _bvTabs.get(targetId) : null;
    if (t) {
      _bvOpacityTabId = targetId;
      await _applyBvOpacity(t.view, o);
    }
    return { ok: true, opacity: o };
  });

  ipcMain.handle('browser-set-zen-mode', async (_e, on) => {
    if (!_mainWin || _mainWin.isDestroyed()) return { ok: false };
    if (on) {
      // Look for a tab whose webContents reports a playing video. We
      // prefer the active tab if it qualifies; otherwise scan others
      // (audio may be playing on a detached tab).
      let pick = null;
      const candidates = _bvActiveId != null
        ? [_bvActiveId, ...[..._bvTabs.keys()].filter(id => id !== _bvActiveId)]
        : [..._bvTabs.keys()];
      for (const id of candidates) {
        const t = _bvTabs.get(id);
        if (!t) continue;
        let hasPlaying = false;
        try {
          hasPlaying = await t.view.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('video')).some(v => !v.paused && v.currentTime > 0 && v.readyState >= 2)`,
            true,
          );
        } catch {}
        if (hasPlaying) { pick = id; break; }
      }
      if (pick == null) return { ok: true, applied: false };
      const t = _bvTabs.get(pick);
      const wc = t.view.webContents;
      // Save the current global bounds rect so leaveZen can restore.
      _bvZenSavedBounds = { ..._bvBounds };
      _bvZenTabId = pick;
      // Re-attach this BV (in case another tab was previously active)
      // and resize it to fill the whole host window — the renderer's
      // bounds-tracker reports fractions of the viewport, so {0,0,1,1}
      // covers everything.
      try { _mainWin.setBrowserView(t.view); } catch {}
      _bvBounds = { x: 0, y: 0, width: 1, height: 1 };
      _applyBvBounds(t.view);
      try { _bvZenCssKey = await wc.insertCSS(_BV_ZEN_CSS); } catch {}
      return { ok: true, applied: true, tabId: pick };
    }
    // Off — undo everything: pull the injected CSS back out, restore
    // the saved geometry, and re-activate whichever tab was active.
    if (_bvZenTabId != null) {
      const t = _bvTabs.get(_bvZenTabId);
      if (t && _bvZenCssKey) {
        try { await t.view.webContents.removeInsertedCSS(_bvZenCssKey); } catch {}
      }
    }
    _bvZenCssKey = null;
    _bvZenTabId  = null;
    if (_bvZenSavedBounds) {
      _bvBounds = _bvZenSavedBounds;
      _bvZenSavedBounds = null;
      // Re-apply to whichever BV is currently active (may have changed).
      if (_bvActiveId != null) {
        const cur = _bvTabs.get(_bvActiveId);
        if (cur) _applyBvBounds(cur.view);
      }
    }
    return { ok: true };
  });

  // Route every download initiated from a BrowserView into the dashboard's
  // own downloads/ folder so the Explore pane can list it like gallery/docs
  // files. If a file with the target name already exists, append (1), (2),
  // … until we find a free slot — same convention Chrome uses.
  browserSession.on('will-download', (_event, item) => {
    try { fs.mkdirSync(downloadsFolderPath(), { recursive: true }); } catch {}
    const original = item.getFilename() || 'download';
    const ext  = path.extname(original);
    const base = path.basename(original, ext);
    let candidate = path.join(downloadsFolderPath(), original);
    let n = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(downloadsFolderPath(), `${base} (${n})${ext}`);
      n++;
    }
    item.setSavePath(candidate);
  });

  // ── BrowserView tab manager ──────────────────────────────────
  // Each renderer "tab" maps to a BrowserView. The renderer sends a
  // target rectangle and which tab is active; main handles the rest.
  // Page-load events are forwarded back over 'browser-tab-event' so the
  // renderer can keep its chrome (URL bar, title, back/forward state)
  // in sync. Trackers are cut at the network layer — we don't touch the
  // page DOM (an earlier CLEAN_CSS rule was too broad: legitimate
  // structural classes like "cookie-policy-notice-cmp" got hidden too).
  const _bvTabs = new Map(); // id → { view, url, title, loading, canBack, canFwd }
  let _bvNextId = 1;
  let _bvActiveId = null;
  let _bvBounds = { x: 0, y: 0, width: 0, height: 0 };

  function _sendTabEvent(payload) {
    if (_mainWin && !_mainWin.isDestroyed()) {
      _mainWin.webContents.send('browser-tab-event', payload);
    }
  }
  // Popup policy: route to a fresh tab. App-level catch-all because
  // per-view setWindowOpenHandler only sees same-frame window.open —
  // iframes (Google "Sign in with Google", embed widgets, social
  // buttons) are separate webContents with their own popup paths. Filter
  // by session so the dashboard's own renderer is untouched.
  function _requestNewTab(url) {
    if (!url) return;
    if (!_mainWin || _mainWin.isDestroyed()) return;
    try { _mainWin.webContents.send('browser-newtab-request', url); } catch {}
  }
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session !== browserSession) return;
    // Distinguish user-initiated tabs (middle-click, Ctrl+click, target=
    // "_blank" on an explicit anchor) from scripted ad popups. Electron
    // tells us via `disposition`:
    //   foreground-tab / background-tab → user click  → route to new tab
    //   new-window / save-to-disk / other → scripted   → block + count
    // This stops the in-page modal scripts from spawning a fresh tab
    // every time the user mouses over an ad zone, while keeping middle-
    // click-to-open-in-new-tab working on every regular link.
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        _requestNewTab(url);
        return { action: 'deny' };
      }
      _popupsBlocked++;
      _statsDirty = true;
      _broadcastBrowserStats();
      return { action: 'deny' };
    });
    contents.on('did-create-window', (newWin, details) => {
      // Belt-and-suspenders: if a window slipped through (rare —
      // certain HTML target="_blank" links with rel="noopener" can
      // bypass setWindowOpenHandler on some Electron builds), close it
      // immediately and count it as blocked.
      try { newWin.close(); } catch {}
      _popupsBlocked++;
      _statsDirty = true;
      _broadcastBrowserStats();
    });
  });

  // Page styling pass — three jobs in one CSS injection:
  //
  // 1. Defensive UA stylesheet enforcement. Some sites (Dribbble,
  //    Framer-built pages) ship CSS that overrides the browser default
  //    of `display: none` on <style>/<script>/<template>/<noscript>/
  //    <head>, or include malformed markup that leaks <head> children
  //    into <body>. Either way the result is raw CSS/JS source
  //    rendering as visible text above the page.
  //
  // 2. Strip motion. Animations, transitions, and smooth scrolling are
  //    pure overhead on a lightweight pane that's only here to read
  //    text and render images. Setting all three to 0s !important
  //    cancels them at the cascade root.
  //
  // 3. Strip background imagery + force a dark surface. The dashboard
  //    is a dark, tech-themed HUD; bright photo hero backgrounds clash.
  //    We knock out background-image globally (gradients, patterns,
  //    hero photos), advertise color-scheme: dark so sites with a dark
  //    theme adopt it, and fall back to a flat dark body for sites
  //    that don't. Inline <img>/<video>/<canvas> content is untouched
  //    so the page is still usable.
  // We deliberately do NOT set background-image: none. YouTube + most
  // modern grids use background-image with a CDN URL to render video
  // thumbnails — stripping it killed the thumbnails. Users who want a
  // fully image-free page hit the reader-mode button, which blocks all
  // image requests at the webRequest layer (covers both <img> and
  // background-image url()). We also don't flatten background-color
  // globally any more — that broke modal layering on Discord
  // (verification modal was transparent, so the previous step's form
  // bled through underneath). color-scheme: dark gets sites with a
  // prefers-color-scheme branch to take their dark theme; the rest fall
  // back to our html/body override below.
  const _PAGE_STYLE_CSS = `
    head, head *,
    style, script, template, noscript, link, meta, title {
      display: none !important;
    }
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      scroll-behavior: auto !important;
    }
    :root, html { color-scheme: dark !important; }
    html, body {
      background-color: #0a0a0a !important;
      color: #c8b890 !important;
    }
    a, a:visited { color: #d4a849 !important; }
  `;
  // Aggressive dark-mode injection. Applied as a separate insertCSS()
  // call so we can pull it back out via removeInsertedCSS() when the
  // user toggles dark mode off — without dropping the base style (which
  // still kills motion + sets the fallback page color).
  //
  // The filter-invert approach reads dark on virtually every site (it
  // doesn't care about per-element backgrounds the way a color-only
  // override does), then re-inverts <img>, <video>, <iframe>, etc. so
  // media stays right-side-up. The 0.92 invert + 180° hue rotate keeps
  // blacks from snapping to pure white and roughly preserves the warm/
  // cool relationships in non-image content.
  const _PAGE_DARK_INVERT_CSS = `
    html {
      background: #fff !important;
      filter: invert(0.92) hue-rotate(180deg) !important;
    }
    img, picture, video, iframe, canvas, embed, object, svg,
    [style*="background-image"]:not(html):not(body) {
      filter: invert(1) hue-rotate(180deg) !important;
    }
    /* Re-invert media nested inside other re-inverted media so the
       double-invert collapses back to the page filter. */
    iframe img, iframe video, iframe picture {
      filter: none !important;
    }
  `;
  // Per-tab key tracking so we can remove the dark CSS on toggle.
  const _bvDarkCssKeys = new Map(); // id → cssKey
  // Initialize the dark-mode flag from config; default ON.
  let _bvDarkMode = (() => { try { return readConfig().browserDarkMode !== false; } catch { return true; } })();
  function _wireBvEvents(id, view) {
    const wc = view.webContents;
    // Halve the compositor's frame budget for embedded pages. With every
    // animation/transition stripped by CSS injection, 60 fps would just be
    // re-compositing the same pixels — 30 fps stays smooth for scroll and
    // saves real GPU time. The YouTube popout's webContents uses its own
    // setFrameRate(60), unaffected.
    try { wc.setFrameRate(30); } catch {}
    wc.on('dom-ready', async () => {
      try { wc.insertCSS(_PAGE_STYLE_CSS); } catch {}
      if (_bvDarkMode) {
        try {
          const key = await wc.insertCSS(_PAGE_DARK_INVERT_CSS);
          _bvDarkCssKeys.set(id, key);
        } catch {}
      }
    });
    wc.on('did-start-loading', () => {
      const t = _bvTabs.get(id); if (!t) return;
      t.loading = true;
      _sendTabEvent({ id, type: 'loading', loading: true });
    });
    wc.on('did-stop-loading', () => {
      const t = _bvTabs.get(id); if (!t) return;
      t.loading = false;
      t.canBack = wc.canGoBack();
      t.canFwd  = wc.canGoForward();
      _sendTabEvent({ id, type: 'loading', loading: false, canBack: t.canBack, canFwd: t.canFwd });
    });
    wc.on('did-navigate', (_e, url) => {
      const t = _bvTabs.get(id); if (!t) return;
      t.url = url;
      _pushHistory(url, t.title);
      _sendTabEvent({ id, type: 'navigate', url });
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (!isMain) return;
      const t = _bvTabs.get(id); if (!t) return;
      t.url = url;
      _pushHistory(url, t.title);
      _sendTabEvent({ id, type: 'navigate', url });
    });
    wc.on('page-title-updated', (_e, title) => {
      const t = _bvTabs.get(id); if (!t) return;
      t.title = title || t.url;
      // Update the matching history head with the real page title (which
      // arrives slightly after did-navigate on most pages).
      _pushHistory(t.url, title);
      _sendTabEvent({ id, type: 'title', title: t.title });
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      _sendTabEvent({ id, type: 'fail', url, code, desc });
    });
    // Escape during zen → forward to the main renderer's force-leave-zen
    // channel. Without this, an Escape press while a BrowserView has
    // focus (browser pane is the active combo mode) would never reach
    // the dashboard's renderer and the user couldn't leave zen.
    wc.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape' && _zenIsActiveInMain && _mainWin && !_mainWin.isDestroyed()) {
        try { _mainWin.webContents.send('force-leave-zen'); } catch {}
      }
    });

    // Right-click → native context menu. Builds a small template based on
    // what was actually right-clicked (link / image / selection / editable
    // input). The "Open link in new tab" entry rides the same renderer
    // signal popups use (_requestNewTab), so the new tab appears in the
    // dashboard's chrome instead of spawning a top-level Electron window.
    wc.on('context-menu', (_event, params) => {
      const items = [];
      const link = params.linkURL || '';
      if (link) {
        items.push({ label: 'Open link in new tab', click: () => _requestNewTab(link) });
        items.push({ label: 'Copy link address',    click: () => { try { clipboard.writeText(link); } catch {} } });
        items.push({ type: 'separator' });
      }
      if (params.mediaType === 'image' && params.srcURL) {
        items.push({ label: 'Open image in new tab', click: () => _requestNewTab(params.srcURL) });
        items.push({ label: 'Copy image address',    click: () => { try { clipboard.writeText(params.srcURL); } catch {} } });
        items.push({ type: 'separator' });
      }
      // Navigation block — only show what's actually usable.
      const navItems = [];
      if (wc.canGoBack())     navItems.push({ label: 'Back',    click: () => { try { wc.goBack(); } catch {} } });
      if (wc.canGoForward())  navItems.push({ label: 'Forward', click: () => { try { wc.goForward(); } catch {} } });
      navItems.push({ label: 'Reload', click: () => { try { wc.reload(); } catch {} } });
      if (navItems.length) {
        items.push(...navItems);
        items.push({ type: 'separator' });
      }
      // Selection / editable. Hand off to standard role-based items so
      // the OS shortcut + keybindings render right (cmd+c on macOS etc).
      if (params.selectionText) {
        items.push({ label: 'Copy', role: 'copy' });
      }
      if (params.isEditable) {
        items.push({ label: 'Cut',   role: 'cut' });
        items.push({ label: 'Paste', role: 'paste' });
        items.push({ label: 'Select all', role: 'selectAll' });
      }
      // Final fallback if nothing else is available — at minimum offer
      // the page URL copy so the user can pull it from a chromeless page.
      if (!items.length) {
        items.push({ label: 'Copy page URL', click: () => { try { clipboard.writeText(wc.getURL()); } catch {} } });
      }
      try {
        const menu = Menu.buildFromTemplate(items);
        // No explicit x/y — Electron pops at the current cursor. params.x/y
        // are BV-relative and would land off-target since the BV is
        // offset inside the host window.
        menu.popup({ window: _mainWin || undefined });
      } catch {}
    });
    // Popup blocking lives in the app-level web-contents-created
    // handler above (covers both this top-level webContents and any
    // iframes the page later loads). Per-view duplicates would just
    // double-fire the new-tab request.
  }
  function _applyBvBounds(view) {
    // _bvBounds is a fractional rect (x/y/width/height each 0..1 of the
    // dashboard viewport, computed in the renderer with rect/innerWidth).
    // Fractions are zoom-independent: zoomFactor scales CSS px and visual
    // px proportionally, so the ratio stays the same. We convert to DIPs
    // here by multiplying against the window's actual content area.
    if (!_mainWin || _mainWin.isDestroyed()) return;
    const cb = _mainWin.getContentBounds();
    try {
      view.setBounds({
        x: Math.round(cb.width  * (_bvBounds.x      || 0)),
        y: Math.round(cb.height * (_bvBounds.y      || 0)),
        width:  Math.max(0, Math.round(cb.width  * (_bvBounds.width  || 0))),
        height: Math.max(0, Math.round(cb.height * (_bvBounds.height || 0))),
      });
    } catch {}
  }
  function _showBv(id) {
    if (!_mainWin || _mainWin.isDestroyed()) return;
    // Remove every other BrowserView from the host window, attach only
    // the requested one. Mute the inactive ones so background audio
    // doesn't keep playing (and decoding) on detached tabs.
    for (const [tid, t] of _bvTabs.entries()) {
      if (tid !== id) {
        try { _mainWin.removeBrowserView(t.view); } catch {}
        try { t.view.webContents.setAudioMuted(true); } catch {}
      }
    }
    const t = _bvTabs.get(id);
    if (!t) return;
    try { _mainWin.setBrowserView(t.view); } catch {}
    try { t.view.webContents.setAudioMuted(false); } catch {}
    _applyBvBounds(t.view);
    _bvActiveId = id;
  }
  function _hideAllBv() {
    if (!_mainWin || _mainWin.isDestroyed()) return;
    for (const t of _bvTabs.values()) {
      try { _mainWin.removeBrowserView(t.view); } catch {}
      try { t.view.webContents.setAudioMuted(true); } catch {}
    }
    _bvActiveId = null;
  }

  ipcMain.handle('browser-tab-create', (_e, url) => {
    const id = _bvNextId++;
    const view = new BrowserView({
      webPreferences: {
        partition: _BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        // Keep third-party pages from autoplaying hero/ad video. The
        // global autoplay-policy switch is gone (so the dashboard can
        // play its boot SFX); this restores it just for the embedded
        // browser tabs.
        autoplayPolicy: 'document-user-activation-required',
        // Note: sandbox left as default (false). Setting sandbox:true
        // here caused some sites (Framer-built, Liferay-built) to render
        // their HTML source as visible text instead of executing — most
        // likely a feature-detect path on the page's bootstrap that
        // depends on something the sandbox restricts.
        javascript: true,
        webSecurity: true,
        // Lightweight pane — turn off the things we don't need.
        // spellcheck spawns a per-tab background worker; webSQL is dead
        // tech that maintains a SQLite handle; backgroundThrottling
        // (default true, explicit here) puts the tab to sleep when it's
        // detached from the window or our window is minimized.
        spellcheck: false,
        enableWebSQL: false,
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor('#0a0a0a');
    // Pre-size to the last known stage rect (or 0×0 if we have none yet)
    // so the page lays out at the correct viewport from the first paint.
    // Without this Electron defaults a fresh BrowserView to "fill the
    // BrowserWindow", which paints over our chrome until bounds arrive.
    _applyBvBounds(view);
    const tab = { view, url: '', title: 'NEW TAB', loading: false, canBack: false, canFwd: false };
    _bvTabs.set(id, tab);
    _wireBvEvents(id, view);
    if (url) {
      tab.url = url; tab.loading = true;
      view.webContents.loadURL(url).catch(() => {});
    }
    return { id };
  });
  ipcMain.handle('browser-tab-close', (_e, id) => {
    const t = _bvTabs.get(id);
    if (!t) return { ok: false };
    if (_bvActiveId === id && _mainWin && !_mainWin.isDestroyed()) {
      try { _mainWin.removeBrowserView(t.view); } catch {}
      _bvActiveId = null;
    }
    try { t.view.webContents.destroy?.(); } catch {}
    _bvTabs.delete(id);
    return { ok: true };
  });
  ipcMain.handle('browser-tab-navigate', (_e, id, url) => {
    const t = _bvTabs.get(id);
    if (!t || !url) return { ok: false };
    t.url = url;
    t.loading = true;
    // Re-apply bounds before loadURL so the new page lays out at the
    // current stage rect, even if the view was created off-screen.
    _applyBvBounds(t.view);
    t.view.webContents.loadURL(url).catch(() => {});
    return { ok: true };
  });
  ipcMain.handle('browser-tab-back',    (_e, id) => { try { _bvTabs.get(id)?.view.webContents.goBack(); }    catch {} return { ok: true }; });
  ipcMain.handle('browser-tab-forward', (_e, id) => { try { _bvTabs.get(id)?.view.webContents.goForward(); } catch {} return { ok: true }; });
  ipcMain.handle('browser-tab-reload',  (_e, id) => { try { _bvTabs.get(id)?.view.webContents.reload(); }    catch {} return { ok: true }; });
  ipcMain.handle('browser-tab-reload-fresh', (_e, id) => {
    // reloadIgnoringCache makes sure the webRequest filter sees every
    // resource fetch — used after toggling reader mode so the image
    // block actually takes effect instead of pulling the same images
    // back from the memory cache.
    try { _bvTabs.get(id)?.view.webContents.reloadIgnoringCache(); } catch {}
    return { ok: true };
  });
  ipcMain.handle('browser-tab-activate', (_e, id) => {
    if (id == null) { _hideAllBv(); return { ok: true }; }
    _showBv(id);
    return { ok: true };
  });
  ipcMain.handle('browser-tab-bounds', (_e, rect) => {
    _bvBounds = rect || _bvBounds;
    const t = _bvActiveId != null ? _bvTabs.get(_bvActiveId) : null;
    if (t) _applyBvBounds(t.view);
    return { ok: true };
  });

  // History — get returns the most-recent N entries (newest first);
  // clear wipes both the in-memory list and the on-disk file.
  ipcMain.handle('browser-history-get', (_e, limit = 100) => {
    const n = Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : 100));
    return _history.slice(0, n);
  });
  ipcMain.handle('browser-history-clear', () => {
    _history = [];
    _scheduleHistoryFlush();
    return { ok: true };
  });

  // Clear-data — wipes cache + browsing history + transient storage
  // (service workers, shader cache, etc.) BUT keeps cookies +
  // localStorage + IndexedDB, where modern sites stash auth tokens.
  // Result: cache is gone and history is empty, but the user stays
  // logged in everywhere they were already signed in. Also clears the
  // adsBlocked/popupsBlocked counters that drive the splash chips.
  ipcMain.handle('browser-clear-data', async () => {
    try { await browserSession.clearCache(); } catch {}
    try {
      await browserSession.clearStorageData({
        storages: [
          'appcache',
          'filesystem',
          'shadercache',
          'websql',
          'serviceworkers',
          'cachestorage',
        ],
      });
    } catch {}
    _history = [];
    _scheduleHistoryFlush();
    _adsBlocked = 0;
    _imagesBlocked = 0;
    _statsDirty = true;
    _broadcastBrowserStats();
    return { ok: true };
  });

  // HTTP fetch helper for DDG scraping. Routes through the dash-browser
  // session so adblock counters tick and cookies persist for the few
  // seconds it takes to do a vqd → i.js handshake. Returns a string body.
  function _browserFetch(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const req = net.request({ url, session: browserSession, useSessionCookies: true });
      req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
      req.setHeader('Accept', '*/*');
      req.setHeader('Accept-Language', 'en-US,en;q=0.9');
      for (const [k, v] of Object.entries(extraHeaders)) req.setHeader(k, v);
      let body = '';
      req.on('response', (res) => {
        res.on('data', (chunk) => { body += chunk.toString('utf8'); });
        res.on('end',  () => resolve(body));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  // DuckDuckGo image search uses a two-step handshake: first hit the
  // main HTML page to extract a "vqd" token, then call the hidden i.js
  // JSON endpoint with that token to get the actual result list.
  async function _browserSearchVideos(q, page) {
    try {
      // kp=-2 turns DDG SafeSearch off on the initial token-grab page;
      // f=,,,,,&p=-2 carries the same intent through to the v.js endpoint
      // (DDG's filter spec accepts the safe-level as the `p` slot here).
      const html = await _browserFetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=videos&ia=videos&kp=-2`);
      const m = html.match(/vqd=(?:["']([\d-]+)["']|([\d-]+))/);
      const vqd = m ? (m[1] || m[2]) : null;
      if (!vqd) return { ok: false, kind: 'videos', error: 'NO VQD TOKEN' };
      const start = (Math.max(1, page || 1) - 1) * 60;
      const apiUrl = `https://duckduckgo.com/v.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=-2&s=${start}`;
      const body = await _browserFetch(apiUrl, {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://duckduckgo.com/',
        'Accept': 'application/json',
      });
      let json;
      try { json = JSON.parse(body); } catch { return { ok: false, kind: 'videos', error: 'BAD JSON' }; }
      const items = (json.results || []).slice(0, 60).map((r) => ({
        thumb:     r.images?.medium || r.images?.large || r.images?.small || r.images?.motion,
        url:       r.content,                 // canonical video page (YouTube etc)
        title:     r.title || '',
        duration:  r.duration || '',
        publisher: r.publisher || r.uploader || '',
        published: r.published || '',
      })).filter(it => it.thumb && it.url);
      return { ok: true, kind: 'videos', page: page || 1, items };
    } catch (err) {
      return { ok: false, kind: 'videos', error: String(err && err.message || err) };
    }
  }

  async function _browserSearchImages(q, page) {
    try {
      // kp=-2 on the token request + p=-2 on i.js disable SafeSearch
      // across the full DDG image pipeline.
      const html = await _browserFetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images&kp=-2`);
      const m = html.match(/vqd=(?:["']([\d-]+)["']|([\d-]+))/);
      const vqd = m ? (m[1] || m[2]) : null;
      if (!vqd) return { ok: false, kind: 'images', error: 'NO VQD TOKEN' };
      const start = (Math.max(1, page || 1) - 1) * 100;
      const apiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=-2&v7exp=a&s=${start}`;
      const body = await _browserFetch(apiUrl, {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://duckduckgo.com/',
        'Accept': 'application/json',
      });
      let json;
      try { json = JSON.parse(body); } catch { return { ok: false, kind: 'images', error: 'BAD JSON' }; }
      const items = (json.results || []).slice(0, 80).map((r) => ({
        thumb: r.thumbnail || r.image,
        image: r.image,
        url:   r.url,           // source page (where the image lives)
        title: r.title || '',
        width:  r.width,
        height: r.height,
      })).filter(it => it.thumb && it.url);
      return { ok: true, kind: 'images', page: page || 1, items };
    } catch (err) {
      return { ok: false, kind: 'images', error: String(err && err.message || err) };
    }
  }

  // Hybrid web search — fan out to multiple engines in parallel, merge
  // their raw HTML payloads, and let the renderer parse + dedupe. Each
  // engine has its own bot-detection landmines; we always run them with
  // Promise.allSettled so one engine failing (CAPTCHA, blocked region,
  // rate limit) doesn't sink the whole search. Renderer reports the
  // engine breakdown to the user via a small chip on each result.
  // Per-engine paginated URL builders. Page 1 is the entry point; later
  // pages use each engine's native offset param (start= for Google, etc).
  // DDG's html endpoint officially uses POST for paging but accepts GET
  // with s=offset as an undocumented fallback.
  // Per-engine page URLs. Each engine's result-per-page param tuned to
  // its server-side cap. Google's `num` is honored up to 100 for
  // unauthenticated queries; Bing's `count` works up to ~50; Brave
  // accepts `count`. DDG always returns 30; Yahoo stays at its default
  // ~10. Higher counts here drop the number of pages we need to fetch
  // to reach a useful result set.
  // SafeSearch param per engine:
  //   ddg     → kp=-2  (-2 off, -1 moderate, 1 strict)
  //   bing    → adlt=off
  //   brave   → safesearch=off
  //   yahoo   → vm=r   (raw / relaxed / off)
  //   google  → safe=off & filter=0  (filter=0 also kills "Showing results for X — search instead for Y" rewriting)
  // These are passed on every request, including paginated load-more.
  const _WEB_ENGINES = {
    ddg:    (q, p) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kp=-2` + (p > 1 ? `&s=${(p-1)*30}&dc=${(p-1)*30+1}` : ''),
    bing:   (q, p) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=50&first=${(p-1)*50+1}&adlt=off&form=QBLH`,
    brave:  (q, p) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web&count=20&safesearch=off&offset=${p-1}`,
    yahoo:  (q, p) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}&b=${(p-1)*10+1}&vm=r&fr=yfp-t&fp=1`,
    google: (q, p) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=100&start=${(p-1)*100}&hl=en&safe=off&filter=0`,
  };
  async function _browserSearchWebHybrid(q, page) {
    const keys = Object.keys(_WEB_ENGINES);
    const headers = { 'Accept': 'text/html,application/xhtml+xml' };
    // On the first page, fan-fetch pages 1 + 2 in parallel per engine and
    // concatenate the HTML — gives the renderer ~2× the DOM to parse
    // without any contract change. For load-more requests (page > 1) we
    // fall back to a single page per engine to keep the wire small.
    const pagesToFetch = page === 1 ? [1, 2] : [page];
    const tasks = [];
    for (const k of keys) {
      for (const p of pagesToFetch) {
        tasks.push(
          _browserFetch(_WEB_ENGINES[k](q, p), headers)
            .then((html) => ({ k, p, html, ok: true }))
            .catch((err) => ({ k, p, err, ok: false }))
        );
      }
    }
    const settled = await Promise.all(tasks);
    // Bucket the HTML by engine in page order. We join the pages with a
    // newline so each engine's parser still sees one DOM blob; existing
    // parsers iterate every matching node in the document so they pick
    // up every result entry across the concatenated pages.
    const buckets = {};
    const errors = {};
    for (const k of keys) buckets[k] = [];
    for (const r of settled) {
      if (r.ok && r.html) buckets[r.k].push(r.html);
      else if (!r.ok)    errors[r.k] = String(r.err && r.err.message || r.err);
    }
    const html = {};
    for (const k of keys) html[k] = buckets[k].join('\n');
    return { ok: true, kind: 'web', page, html, errors };
  }

  ipcMain.handle('browser-search', async (_e, query, kind, page) => {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'empty query' };
    const p = Math.max(1, Math.min(Number(page) || 1, 10));
    if (kind === 'images') return await _browserSearchImages(q, p);
    if (kind === 'videos') return await _browserSearchVideos(q, p);
    try {
      return await _browserSearchWebHybrid(q, p);
    } catch (err) {
      return { ok: false, kind: 'web', error: String(err && err.message || err) };
    }
  });

  ensureUserFolders();

  // Serve `dash3d-file://<absolute-path>` from disk, but only if the path
  // resolves inside one of our managed roots. The renderer uses this
  // scheme to load thumbnails in the EXPLORE pane and the fullscreen
  // image viewer. We read with fs directly (rather than net.fetch
  // 'file://') because that path was returning empty bodies on Windows
  // — fs.readFileSync + an explicit Content-Type is reliable.
  const _DASH_MIME = {
    '.png':  'image/png',  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',  '.webp': 'image/webp', '.bmp':  'image/bmp',
    '.svg':  'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
    // Video — Chromium's <video> refuses to decode application/octet-
    // stream, so anything we want to play inline needs a real MIME.
    // .mkv files we produce are WebM bytes wrapped in a .mkv extension
    // (Chromium's MediaRecorder only emits WebM), so serving them as
    // video/webm lets them play. Generic non-WebM MKVs will still fail
    // — same as before — and the player just stays blank in that case.
    '.mp4':  'video/mp4',  '.m4v':  'video/mp4',
    '.webm': 'video/webm', '.mkv':  'video/webm',
    '.mov':  'video/quicktime',
    '.ogv':  'video/ogg',  '.ogg':  'video/ogg',
    '.txt':  'text/plain;charset=utf-8',
    '.html': 'text/html;charset=utf-8',
    '.json': 'application/json',
  };
  // URL shape: `dash3d-file://<root>/<rel-path>` where <root> is either
  // 'gallery' or 'docs'. We use the host segment for the root rather than
  // putting the absolute Windows path in the URL because URL parsers
  // treat drive-letter colons (E:) as host:port separators on standard
  // schemes — that was returning broken URLs and empty bodies.
  protocol.handle('dash3d-file', (request) => {
    let root, rel, abs;
    try {
      const u = new URL(request.url);
      const which = (u.hostname || '').toLowerCase();
      root = which === 'gallery'   ? galleryFolderPath()
           : which === 'docs'      ? docsFolderPath()
           : which === 'downloads' ? downloadsFolderPath()
           : null;
      if (!root) {
        console.warn('[dash3d-file] bad host:', u.hostname, 'in', request.url);
        return new Response('bad host', { status: 400 });
      }
      rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      abs = path.resolve(root, rel);
    } catch (err) {
      console.warn('[dash3d-file] bad url:', request.url, err.message);
      return new Response('bad url', { status: 400 });
    }
    if (!abs.startsWith(root)) {
      console.warn('[dash3d-file] traversal blocked:', abs);
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime = _DASH_MIME[ext] || 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': mime } });
    } catch (err) {
      console.warn('[dash3d-file] read failed:', abs, err.message);
      return new Response(`read failed: ${err.message}`, { status: 500 });
    }
  });

  registerIpc();
  startHttpServer();
  createWindow();
  // Defer LHM auto-launch by ~4 s past window-show. LHM enumerates every
  // hardware sensor on startup — including the GPU driver, which is the
  // single biggest contributor to the cold-start GPU spike that flips the
  // dashboard's emergency-UI red. The renderer doesn't need sensor data
  // for its first paint; sensors populate as soon as LHM is up, the same
  // way they did before.
  setTimeout(() => sensorsService.launchSensorBackend(), 4000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC HANDLERS ──────────────────────────────────────────────────
//
// Inventory of channels (preload.js exposes each as window.dash.<name>):
//
//   Telemetry pulls (renderer polls these on its own intervals)
//     system-info / storage-info / temps-info / net-info / disk-info
//
//   Config (single JSON file in userData/config.json)
//     config-get / config-set / config-path
//
//   Audio (Core Audio + IPolicyConfig via PowerShell + inline C# COM)
//     audio-set-device  audio-set-out-mute  audio-set-in-mute
//     audio-get-mute-states  audio-set-default-endpoint
//
//   Process / window
//     toggle-fullscreen  app-relaunch  app-quit  app-version
//     get-screen-sources  set-power-profile
//     open-youtube  set-youtube-zen-mode
//     azure-auto-config
//
//   User folders (gallery + docs sit next to the .exe; created on launch)
//     gallery-path  docs-path
//     gallery-list  docs-list      (subdir → entries with size + mtime)
//     docs-write    (rel, content) (notes + paper auto-export targets)
//     shell-open-path                (open file in OS default app)
//
//   Push events (main → renderer; renderer subscribes via on*)
//     audio-out-level  force-leave-zen
//
// Async handlers should resolve to either a value or a `{ ok, error }`
// shape on failure — see runPowerShell + setSystemMute as examples.

function registerIpc() {
  ipcMain.handle('system-info',     () => getSystemInfo());

  ipcMain.handle('storage-info', async () => {
    return await getStorageInfo();
  });

  ipcMain.handle('temps-info', async () => {
    return await getTempsInfo();
  });

  ipcMain.handle('net-info', async () => {
    return await getNetInfo();
  });

  ipcMain.handle('disk-info', async () => {
    return await getDiskIo();
  });

  ipcMain.handle('config-get', () => readConfig());
  ipcMain.handle('config-set', (_e, partial) => writeConfig(partial));
  ipcMain.handle('config-path', () => configFilePath());

  // Pollen.com's unofficial pollen-forecast endpoint (the same one their
  // own site uses). Requires a Referer header pointing back at their
  // page; renderers can't override Referer due to spec restrictions, so
  // we proxy through the main process where Node's fetch sets whatever
  // headers we ask. Returns { ok, data } on success, { error } on
  // failure. ZIP must be a 5-digit US postal code — anything else is
  // refused without making the call.
  ipcMain.handle('get-pollen', async (_e, zip) => {
    const z = String(zip || '').trim();
    if (!/^\d{5}$/.test(z)) return { error: 'invalid zip' };
    const url = `https://www.pollen.com/api/forecast/current/pollen/${z}`;
    try {
      const res = await fetch(url, {
        headers: {
          'Referer':    `https://www.pollen.com/forecast/current/pollen/${z}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept':     'application/json, text/plain, */*',
        },
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { error: err?.message || 'fetch failed' };
    }
  });

  ipcMain.handle('get-screen-sources', () => getScreenSources());

  ipcMain.handle('azure-auto-config', async () => {
    return await azureAutoConfig();
  });

  ipcMain.handle('audio-set-device', async (e, deviceId) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    try { writeConfig({ audioDeviceId: deviceId }); } catch {}
    audioService.restartLoopback(win, deviceId, readConfig);
    return true;
  });

  // System-level mute for the default render/capture endpoints. dataFlow
  // 0 = render (speakers), 1 = capture (mic). Result: { ok, muted } or
  // { ok:false, error } so the renderer can roll back its UI on failure.
  ipcMain.handle('audio-set-out-mute', (_e, mute) => audioService.setSystemMute(0, !!mute));
  ipcMain.handle('audio-set-in-mute',  (_e, mute) => audioService.setSystemMute(1, !!mute));
  ipcMain.handle('audio-get-mute-states', () => audioService.getSystemMuteStates());
  ipcMain.handle('audio-set-default-endpoint', (_e, { dataFlow, name }) => audioService.setDefaultEndpoint(dataFlow | 0, name));
  // Toggle raw-PCM forwarding from the WASAPI loopback worker. Renderer
  // calls this when a screen recording starts so loopback audio can be
  // mixed into the recorder's MediaStream — and again on stop to release
  // the per-callback IPC traffic. No-op on Linux until that backend grows
  // the same forwarding hook.
  ipcMain.handle('audio-loopback-pcm', (_e, on) => {
    try { audioService.setPcmForward?.(!!on); } catch {}
    return true;
  });

  // Full app restart — relaunches the Electron process (main + renderer).
  // Used by the topbar restart button when something in main needs to come
  // back fresh (new IPC handlers, settings that take effect at window
  // creation, etc.) and a renderer reload alone won't do it.
  ipcMain.handle('app-relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // Hard quit — used by the topbar close button.
  ipcMain.handle('app-quit', () => { app.exit(0); });

  // RAM flush — calls psapi!EmptyWorkingSet on every accessible process so
  // each one's resident pages get demoted to the standby list, where
  // Windows' memory manager can reclaim them on demand. Doesn't free
  // memory in the "available" column directly (Windows treats standby as
  // available already), but it frees up working sets and removes the
  // Active-vs-standby pressure RAMMap-style. No elevation required for
  // user-owned processes; system-protected ones quietly fail and get
  // counted as 'failed'.
  ipcMain.handle('flush-ram', () => systemService.flushRam());

  // Put the host machine to sleep (suspend to RAM). Confirmed via the
  // native message dialog so a stray click can't drop the user's session.
  //   Windows  → rundll32.exe powrprof.dll,SetSuspendState 0,1,0
  //   Linux    → systemctl suspend
  //   macOS    → pmset sleepnow
  // SetSuspendState's args:   1st: hibernate flag (0 = sleep)
  //                           2nd: forceCritical (1 = force; ignored on modern Win)
  //                           3rd: disableWakeEvent (0 = let wake events through)
  ipcMain.handle('system-sleep', async (_e) => {
    const win = _mainWin || BrowserWindow.fromWebContents(_e.sender);
    try {
      const { dialog } = require('electron');
      const r = await dialog.showMessageBox(win || undefined, {
        type: 'question',
        buttons: ['Sleep', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Sleep',
        message: 'Put this PC to sleep?',
        detail: 'The dashboard will stay running and resume when the system wakes.',
      });
      if (r.response !== 0) return { ok: false, cancelled: true };
    } catch {}
    return await new Promise((resolve) => {
      let cmd, args;
      if (process.platform === 'win32') {
        cmd = 'rundll32.exe';
        args = ['powrprof.dll,SetSuspendState', '0,1,0'];
      } else if (process.platform === 'linux') {
        cmd = 'systemctl';
        args = ['suspend'];
      } else if (process.platform === 'darwin') {
        cmd = 'pmset';
        args = ['sleepnow'];
      } else {
        return resolve({ ok: false, error: `unsupported platform: ${process.platform}` });
      }
      const proc = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
      // SetSuspendState returns immediately; the OS schedules the sleep.
      // No 'close' event needed — fire-and-forget. proc.unref() lets the
      // child outlive us if the OS sleep tears down the renderer first.
      try { proc.unref(); } catch {}
      setTimeout(() => resolve({ ok: true }), 100);
    });
  });

  // App version — pulled from package.json by Electron at app start, so the
  // topbar chip stays in sync with the manifest without a renderer rebuild.
  ipcMain.handle('app-version', () => app.getVersion());

  // Main-process telemetry for the diagnostics overlay. RSS = total
  // resident memory of the main proc; heap = V8 heap; uptime = seconds
  // since main spawned. The renderer polls this on the same interval
  // as the rest of the diag block.
  ipcMain.handle('process-stats', () => {
    const m = process.memoryUsage();
    return {
      rss:       m.rss,
      heapUsed:  m.heapUsed,
      heapTotal: m.heapTotal,
      external:  m.external,
      uptimeSec: process.uptime(),
      pid:       process.pid,
    };
  });

  // ── WiFi (first-run wizard) ─────────────────────────────────────
  // Shell out to `netsh wlan` because it's already on every Win10/11
  // box, doesn't need a native module, and works without admin for
  // scanning + connecting to user profiles. Connecting to a brand-new
  // SSID with a password generates a profile XML on the fly and runs
  // `netsh wlan add profile filename=` to import it. Best-effort —
  // some Group Policy environments lock down profile add, in which
  // case we surface the netsh stderr verbatim so the user can copy
  // the network name into Windows Settings instead.
  ipcMain.handle('wifi-status', async () => {
    if (process.platform !== 'win32') return { connected: false, ssid: null };
    try {
      const r = await runPowerShell('netsh wlan show interfaces');
      const out = r?.stdout || '';
      const stateMatch = out.match(/^\s*State\s*:\s*(.+)$/im);
      const ssidMatch  = out.match(/^\s*SSID\s*:\s*(.+)$/im);
      const signalMatch= out.match(/^\s*Signal\s*:\s*(.+)$/im);
      const state = stateMatch ? stateMatch[1].trim() : '';
      const ssid  = ssidMatch  ? ssidMatch[1].trim()  : '';
      const sig   = signalMatch? signalMatch[1].trim(): '';
      return {
        connected: /connected/i.test(state) && !/disconnect/i.test(state),
        ssid,
        signal: sig,
        state,
      };
    } catch (err) {
      return { connected: false, ssid: null, error: err?.message };
    }
  });

  ipcMain.handle('wifi-scan', async () => {
    if (process.platform !== 'win32') return { networks: [], error: 'unsupported platform' };
    try {
      // Trigger a fresh scan first so cached results aren't stale.
      try { await runPowerShell('netsh wlan show networks mode=bssid'); } catch {}
      const r = await runPowerShell('netsh wlan show networks mode=bssid');
      const out = r?.stdout || '';
      const lines = out.split(/\r?\n/);
      const networks = [];
      let current = null;
      for (const raw of lines) {
        const line = raw.trimRight();
        const ssidM = line.match(/^SSID\s+\d+\s*:\s*(.*)$/i);
        if (ssidM) {
          if (current) networks.push(current);
          current = { ssid: ssidM[1].trim(), signal: 0, auth: '', encryption: '' };
          continue;
        }
        if (!current) continue;
        const authM = line.match(/^\s*Authentication\s*:\s*(.+)$/i);
        if (authM) current.auth = authM[1].trim();
        const encM  = line.match(/^\s*Encryption\s*:\s*(.+)$/i);
        if (encM) current.encryption = encM[1].trim();
        const sigM  = line.match(/^\s*Signal\s*:\s*(\d+)\s*%/i);
        if (sigM) current.signal = Math.max(current.signal, parseInt(sigM[1], 10) || 0);
      }
      if (current) networks.push(current);
      // De-dupe by SSID (some routers broadcast multiple BSSIDs per SSID),
      // keep the strongest signal, and drop hidden (empty) SSIDs.
      const map = new Map();
      for (const n of networks) {
        if (!n.ssid) continue;
        const prev = map.get(n.ssid);
        if (!prev || n.signal > prev.signal) map.set(n.ssid, n);
      }
      const out2 = [...map.values()].sort((a, b) => b.signal - a.signal);
      return { networks: out2 };
    } catch (err) {
      return { networks: [], error: err?.message };
    }
  });

  ipcMain.handle('wifi-connect', async (_e, { ssid, password }) => {
    if (process.platform !== 'win32') return { ok: false, error: 'unsupported platform' };
    if (!ssid || typeof ssid !== 'string') return { ok: false, error: 'ssid required' };
    try {
      // Escape XML special chars in SSID + password before they land in
      // the profile XML body. SSID is also re-encoded in hex for the
      // <hex> field below to support SSIDs containing characters the
      // <name> string field doesn't handle cleanly.
      const xmlEsc = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      const ssidHex = Buffer.from(ssid, 'utf8').toString('hex').toUpperCase();
      const safeSsid = xmlEsc(ssid);
      const safePass = password ? xmlEsc(password) : '';
      const auth   = password ? 'WPA2PSK' : 'open';
      const encr   = password ? 'AES'     : 'none';
      const sharedKey = password
        ? `<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${safePass}</keyMaterial></sharedKey>`
        : '';
      const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${safeSsid}</name>
  <SSIDConfig><SSID><hex>${ssidHex}</hex><name>${safeSsid}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM><security>
    <authEncryption><authentication>${auth}</authentication><encryption>${encr}</encryption><useOneX>false</useOneX></authEncryption>
    ${sharedKey}
  </security></MSM>
</WLANProfile>`;
      const tmp = path.join(app.getPath('temp'), `dash3d-wifi-${Date.now()}.xml`);
      fs.writeFileSync(tmp, xml, 'utf8');
      const addCmd = `netsh wlan add profile filename="${tmp}" user=current`;
      const addRes = await runPowerShell(addCmd);
      try { fs.unlinkSync(tmp); } catch {}
      if (addRes?.stderr && /error/i.test(addRes.stderr)) {
        return { ok: false, error: addRes.stderr.trim() };
      }
      // Quote the SSID with backticks-escaped quotes because runPowerShell
      // wraps the command in single quotes — the SSID value itself needs
      // to be double-quoted inside the netsh argument.
      const connCmd = `netsh wlan connect name="${ssid.replace(/"/g, '`"')}"`;
      const connRes = await runPowerShell(connCmd);
      if (connRes?.stderr && /error/i.test(connRes.stderr)) {
        return { ok: false, error: connRes.stderr.trim() };
      }
      // Poll the interface for up to ~12s waiting for state=connected.
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const r = await runPowerShell('netsh wlan show interfaces');
        const out = r?.stdout || '';
        const stateM = out.match(/^\s*State\s*:\s*(.+)$/im);
        const ssidM  = out.match(/^\s*SSID\s*:\s*(.+)$/im);
        if (stateM && /connected/i.test(stateM[1]) && !/disconnect/i.test(stateM[1]) && ssidM && ssidM[1].trim() === ssid) {
          return { ok: true, ssid };
        }
      }
      return { ok: false, error: 'Timed out waiting for connection — wrong password?' };
    } catch (err) {
      return { ok: false, error: err?.message || 'wifi-connect failed' };
    }
  });

  // Per-process snapshot for the TASKS pane. Electron's app.getAppMetrics()
  // returns one entry per child process (Browser / Renderer / GPU /
  // Utility / Pepper / Zygote / Sandbox helper / …) with CPU + working-set
  // memory. memory.workingSetSize is reported in kilobytes — caller in the
  // renderer scales it to MB. uptimeSec lets the pane show "app age"
  // alongside per-process creationTime.
  ipcMain.handle('app-metrics', () => {
    let metrics = [];
    try { metrics = app.getAppMetrics() || []; } catch {}
    return {
      metrics,
      appName:    app.getName(),
      appVersion: app.getVersion(),
      pid:        process.pid,
      uptimeSec:  process.uptime(),
      platform:   process.platform,
      electron:   process.versions.electron,
      chrome:     process.versions.chrome,
      node:       process.versions.node,
    };
  });

  // User-folder paths. Renderer calls these when it needs to write a screenshot
  // / saved doc / generated image into the on-disk folders that ensureUserFolders
  // creates next to the .exe at app start.
  ipcMain.handle('gallery-path',   () => galleryFolderPath());
  ipcMain.handle('docs-path',      () => docsFolderPath());
  ipcMain.handle('downloads-path', () => downloadsFolderPath());

  // Folder browsing — recursive listing scoped to the gallery / docs roots
  // so the EXPLORE pane can render a flat-but-grouped file list with sizes
  // and mtimes. `subdir` is treated as a relative path under the root and
  // any traversal outside that root is rejected.
  function listFolder(rootFn) {
    return (_e, subdir = '') => {
      const root = rootFn();
      const target = path.resolve(root, String(subdir || ''));
      if (!target.startsWith(root)) return { error: 'path outside root' };
      try {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          // Hide our managed .trash dir from listings — undo is the
          // visible interface for it, not a folder the user navigates.
          .filter((d) => d.name !== '.trash');
        const out = entries.map((d) => {
          const full = path.join(target, d.name);
          let size = 0, mtime = 0;
          try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
          return {
            name: d.name,
            path: full,
            rel:  path.relative(root, full).replace(/\\/g, '/'),
            isDir: d.isDirectory(),
            size,
            mtime,
          };
        });
        // Folders first, then files; within each group sort by mtime desc.
        out.sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || (b.mtime - a.mtime));
        return { entries: out, root };
      } catch (err) {
        return { error: err.message };
      }
    };
  }
  ipcMain.handle('gallery-list',   listFolder(galleryFolderPath));
  ipcMain.handle('docs-list',      listFolder(docsFolderPath));
  ipcMain.handle('downloads-list', listFolder(downloadsFolderPath));

  // Write a doc file (notes / paper auto-export). `rel` is a relative path
  // under the docs root; any traversal outside is rejected. Parents are
  // created on demand so callers can drop a `notes/<tab>.txt`.
  ipcMain.handle('docs-write', (_e, rel, content) => {
    const root = docsFolderPath();
    const target = path.resolve(root, String(rel || ''));
    if (!target.startsWith(root)) return { ok: false, error: 'path outside docs/' };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(content ?? ''), 'utf8');
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Copy selected files to the OS clipboard as Windows file objects
  // (CF_HDROP). Paste them into Explorer / Photos / chat apps just like
  // a normal Ctrl+C from Explorer would. Uses PowerShell Set-Clipboard
  // -Path which writes the proper shell-clipboard format.
  ipcMain.handle('clipboard-copy-files', (_e, paths) => {
    // Filter to paths inside our managed roots before letting the
    // service touch them — sandbox the OS clipboard write to the
    // gallery/docs/downloads area only.
    const arr = (Array.isArray(paths) ? paths : [])
      .map((p) => path.resolve(String(p || '')))
      .filter((p) => _pathInsideManagedRoot(p));
    return systemService.copyFilesToClipboard(arr);
  });

  // Fullscreen contact-sheet — grid of selected images, useful when the
  // user wants to scan many gallery shots at once. Same frameless / FS /
  // always-on-top window pattern as the single-image viewer; ESC, Space,
  // or any non-image click closes it.
  let _contactSheetWin = null;
  ipcMain.handle('open-contact-sheet', (_e, paths) => {
    const tiles = [];
    for (const raw of (Array.isArray(paths) ? paths : [])) {
      const abs = path.resolve(String(raw || ''));
      const root = _managedRootFor(abs);
      if (!root) continue;
      const which = root === galleryFolderPath()   ? 'gallery'
                  : root === downloadsFolderPath() ? 'downloads'
                  :                                  'docs';
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      tiles.push({
        url:  `dash3d-file://${which}/${encodeURI(rel)}`,
        name: path.basename(abs),
      });
    }
    if (!tiles.length) return { ok: false, error: 'nothing valid to display' };
    if (_contactSheetWin && !_contactSheetWin.isDestroyed()) {
      try { _contactSheetWin.close(); } catch {}
    }
    const display = screen.getPrimaryDisplay();
    const w = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y,
      width:  display.bounds.width,
      height: display.bounds.height,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      backgroundColor: '#000000',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    _contactSheetWin = w;
    const tilesHtml = tiles.map((t) =>
      `<div class="t"><img src="${t.url}" alt=""><span>${t.name.replace(/[<>"&]/g, (c) => ({
        '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;',
      })[c])}</span></div>`).join('');
    // Auto-fit: pick the column count that maximizes the per-tile size
    // given the viewport's aspect ratio. When the last row is partial
    // (N not a multiple of bestCols) we render on a 2x-dense grid
    // (`repeat(bestCols * 2, 1fr)`, each tile spans 2 cells) and offset
    // the first item of the last row by `bestCols - lastRowCount` dense
    // columns so the leftover tiles read as centered instead of pinned
    // to the left. Recomputes on resize.
    const layoutJs =
      `const N = ${tiles.length};\n` +
      `function layout() {\n` +
      `  const W = innerWidth, H = innerHeight;\n` +
      `  let bestCols = 1, bestSize = 0;\n` +
      `  for (let c = 1; c <= N; c++) {\n` +
      `    const r = Math.ceil(N / c);\n` +
      `    const s = Math.min(W / c, H / r);\n` +
      `    if (s > bestSize) { bestSize = s; bestCols = c; }\n` +
      `  }\n` +
      `  const rows = Math.ceil(N / bestCols);\n` +
      `  const lastRow = N - (rows - 1) * bestCols;\n` +
      `  const partial = lastRow > 0 && lastRow < bestCols;\n` +
      `  const g = document.querySelector('.g');\n` +
      `  const ts = document.querySelectorAll('.t');\n` +
      `  ts.forEach(t => { t.style.gridColumn = ''; t.style.gridColumnStart = ''; });\n` +
      `  g.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';\n` +
      `  if (partial) {\n` +
      `    g.style.gridTemplateColumns = 'repeat(' + (bestCols * 2) + ', 1fr)';\n` +
      `    ts.forEach(t => { t.style.gridColumn = 'span 2'; });\n` +
      `    const firstLast = (rows - 1) * bestCols;\n` +
      `    const offset = bestCols - lastRow;\n` +
      `    if (ts[firstLast]) ts[firstLast].style.gridColumnStart = offset + 1;\n` +
      `  } else {\n` +
      `    g.style.gridTemplateColumns = 'repeat(' + bestCols + ', 1fr)';\n` +
      `  }\n` +
      `}\n` +
      `layout();\n` +
      `addEventListener('resize', layout);\n` +
      `addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === ' ') window.close(); });\n` +
      `addEventListener('click',   e => { if (e.target.tagName !== 'IMG') window.close(); });\n`;
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;height:100%;background:#000;color:#cfe6f7;` +
      `font:10px 'Share Tech Mono',monospace;overflow:hidden;cursor:zoom-out;}` +
      `.g{display:grid;gap:2px;padding:0;width:100vw;height:100vh;}` +
      `.t{display:flex;flex-direction:column;min-height:0;min-width:0;background:#0a0a0a;}` +
      `.t img{flex:1 1 auto;min-height:0;min-width:0;width:100%;object-fit:contain;` +
      `background:#000;cursor:zoom-in;}` +
      `.t span{padding:2px 6px;letter-spacing:0.05em;color:#cfe6f7;opacity:0.7;` +
      `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;}` +
      `</style></head><body><div class="g">${tilesHtml}</div>` +
      `<script>${layoutJs}</script></body></html>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.on('closed', () => { if (_contactSheetWin === w) _contactSheetWin = null; });
    return { ok: true, count: tiles.length };
  });

  // Fullscreen image viewer — frameless always-on-top BrowserWindow
  // showing one image from the gallery, fit-to-window. ESC or any click
  // closes it. The image is loaded via the dash3d-file:// scheme so it
  // benefits from the same managed-root path validation.
  let _imageViewerWin = null;
  ipcMain.handle('open-image-viewer', (_e, abs) => {
    const p = path.resolve(String(abs || ''));
    const root = _managedRootFor(p);
    if (!root) return { ok: false, error: 'path outside managed roots' };
    const which = root === galleryFolderPath()   ? 'gallery'
                : root === downloadsFolderPath() ? 'downloads'
                :                                  'docs';
    const rel   = path.relative(root, p).replace(/\\/g, '/');
    if (_imageViewerWin && !_imageViewerWin.isDestroyed()) {
      try { _imageViewerWin.close(); } catch {}
    }
    const display = screen.getPrimaryDisplay();
    const w = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y,
      width:  display.bounds.width,
      height: display.bounds.height,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      backgroundColor: '#000000',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    _imageViewerWin = w;
    // Use the host-as-root URL shape (matches the protocol handler);
    // drive-letter paths in URL paths were getting mangled by the parser.
    const url = `dash3d-file://${which}/${encodeURI(rel)}`;
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:zoom-out;}` +
      `img{position:fixed;inset:0;margin:auto;max-width:100vw;max-height:100vh;display:block;}` +
      `</style></head><body><img src="${url}" alt=""><script>` +
      `addEventListener('keydown',e=>{if(e.key==='Escape')window.close();});` +
      `addEventListener('click',()=>window.close());` +
      `</script></body></html>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.on('closed', () => { if (_imageViewerWin === w) _imageViewerWin = null; });
    return { ok: true };
  });

  // Open an absolute path in the OS default app — used for clicking
  // images in the gallery list. Path must resolve under one of our two
  // managed roots so the renderer can't ask main to launch arbitrary files.
  ipcMain.handle('shell-open-path', async (_e, abs) => {
    const p = path.resolve(String(abs || ''));
    if (!_pathInsideManagedRoot(p)) return { ok: false, error: 'path outside managed roots' };
    try {
      const err = await shell.openPath(p);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Create a new folder under one of the managed roots. `which` is
  // 'gallery', 'docs', or 'downloads', `rel` is the relative path of
  // the new folder.
  ipcMain.handle('explore-mkdir', (_e, which, rel) => {
    const root = which === 'gallery'   ? galleryFolderPath()
               : which === 'downloads' ? downloadsFolderPath()
               :                         docsFolderPath();
    const target = path.resolve(root, String(rel || ''));
    if (!target.startsWith(root) || target === root) return { ok: false, error: 'invalid path' };
    try {
      fs.mkdirSync(target, { recursive: false });
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Rename a file or folder. Both source and destination must resolve
  // inside the same managed root so the renderer can't move files
  // between gallery/docs or out into the rest of the filesystem.
  ipcMain.handle('explore-rename', (_e, oldAbs, newName) => {
    const oldP = path.resolve(String(oldAbs || ''));
    const root = _managedRootFor(oldP);
    if (!root) return { ok: false, error: 'path outside managed roots' };
    const cleanName = String(newName || '').trim().replace(/[\\/]/g, '');
    if (!cleanName || cleanName === '.' || cleanName === '..') return { ok: false, error: 'invalid name' };
    const newP = path.resolve(path.dirname(oldP), cleanName);
    if (!newP.startsWith(root)) return { ok: false, error: 'rename leaves managed root' };
    try {
      fs.renameSync(oldP, newP);
      return { ok: true, path: newP };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Move a file or folder to our own managed `.trash` directory under
  // its root (gallery/.trash, docs/.trash, downloads/.trash). The
  // renderer keeps a session undo stack of these moves so the user can
  // restore a misclicked delete with one click. After the session ends
  // an explicit `explore-empty-trash` IPC (or a manual cleanup) sends
  // the contents to the OS Recycle Bin for long-term recovery.
  function _trashDirFor(rootPath) {
    return path.join(rootPath, '.trash');
  }
  function _trashFileName(srcBase) {
    // Timestamp + random suffix keeps siblings distinguishable when
    // the same name is deleted twice in a row.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand  = Math.random().toString(36).slice(2, 7);
    return `${stamp}_${rand}_${srcBase}`;
  }
  ipcMain.handle('explore-delete', async (_e, abs) => {
    const p = path.resolve(String(abs || ''));
    if (!_pathInsideManagedRoot(p)) return { ok: false, error: 'path outside managed roots' };
    if (p === galleryFolderPath() || p === docsFolderPath()) {
      return { ok: false, error: 'cannot delete the managed root itself' };
    }
    // Don't recursively trash items already inside a .trash directory.
    if (p.split(path.sep).includes('.trash')) {
      return { ok: false, error: 'already in trash' };
    }
    const root = _managedRootFor(p);
    if (!root) return { ok: false, error: 'no managed root for path' };
    const trashDir = _trashDirFor(root);
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      const trashPath = path.join(trashDir, _trashFileName(path.basename(p)));
      // Try fs.rename first (same volume, instant). Fall back to copy
      // + unlink if rename fails (cross-device / EXDEV).
      try {
        fs.renameSync(p, trashPath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          fs.cpSync(p, trashPath, { recursive: true });
          fs.rmSync(p, { recursive: true, force: true });
        } else { throw err; }
      }
      return { ok: true, trashPath, origPath: p, name: path.basename(p) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Move a trashed file back to its original location. If the
  // original path now has another file (the user kept working after
  // the delete), append " (restored)" to the basename so the existing
  // file isn't overwritten.
  ipcMain.handle('explore-restore', async (_e, opts) => {
    const trashPath = path.resolve(String(opts?.trashPath || ''));
    const origPath  = path.resolve(String(opts?.origPath  || ''));
    if (!_pathInsideManagedRoot(trashPath) || !_pathInsideManagedRoot(origPath)) {
      return { ok: false, error: 'path outside managed roots' };
    }
    if (!trashPath.split(path.sep).includes('.trash')) {
      return { ok: false, error: 'source is not in trash' };
    }
    if (!fs.existsSync(trashPath)) return { ok: false, error: 'trash file missing' };
    let target = origPath;
    if (fs.existsSync(target)) {
      const dir = path.dirname(target);
      const ext = path.extname(target);
      const stem = path.basename(target, ext);
      let n = 1;
      do {
        target = path.join(dir, `${stem} (restored${n > 1 ? ' ' + n : ''})${ext}`);
        n++;
      } while (fs.existsSync(target) && n < 1000);
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.renameSync(trashPath, target);
      } catch (err) {
        if (err.code === 'EXDEV') {
          fs.cpSync(trashPath, target, { recursive: true });
          fs.rmSync(trashPath, { recursive: true, force: true });
        } else { throw err; }
      }
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Send everything in every managed-root .trash to the OS Recycle Bin
  // for final disposal. Called manually by the user; not automatic.
  ipcMain.handle('explore-empty-trash', async () => {
    let count = 0;
    const errors = [];
    for (const root of [galleryFolderPath(), docsFolderPath(), downloadsFolderPath()]) {
      const trashDir = _trashDirFor(root);
      if (!fs.existsSync(trashDir)) continue;
      for (const name of fs.readdirSync(trashDir)) {
        const full = path.join(trashDir, name);
        try { await shell.trashItem(full); count++; }
        catch (err) { errors.push(`${name}: ${err.message}`); }
      }
    }
    return { ok: errors.length === 0, count, errors };
  });

  ipcMain.handle('set-power-profile', async (_e, opts) => {
    return await powerService.setProfile(opts || {});
  });

  ipcMain.handle('open-youtube', () => openYouTubeWindow());
  ipcMain.handle('youtube-toggle-aot', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    const next = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(next);
    return next;
  });
  ipcMain.handle('set-youtube-zen-mode', (_e, on) => applyYoutubeZenMode(!!on));

  // YouTube popout opacity — lets the user dial between fully opaque
  // (1.0, normal viewing) and 60% transparent (0.4, so the zen dashboard
  // panels show through behind the video). Clamped to [0.1, 1] so the
  // window doesn't disappear entirely. The chrome buttons in the YT
  // popout call this via the preload `youtubeHost.setOpacity` bridge.
  // Visualizer "mirror active video" — returns a desktopCapturer source
  // (id + name) for whatever's most likely the active video right now.
  // Priority: the YouTube popout window if it's open (cleanest capture,
  // since its content IS the video), otherwise the main dashboard window
  // (catches BrowserView page videos at the cost of capturing chrome
  // around them), otherwise the primary screen. Renderer feeds the id
  // into navigator.mediaDevices.getUserMedia with chromeMediaSource:
  // 'desktop'. Returns null if no source is enumerable (permissions
  // denied, no display, etc).
  ipcMain.handle('visualizer-get-video-source', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      // 1. YT popout — its window title is "YouTube" (see _ytWin ctor).
      let pick = sources.find(s => s.name === 'YouTube');
      // 2. Dashboard window — captures BrowserView page videos too.
      if (!pick && _mainWin && !_mainWin.isDestroyed()) {
        const title = _mainWin.getTitle();
        pick = sources.find(s => s.name === title);
      }
      // 3. Any window with "YouTube" / common video site in the name.
      if (!pick) pick = sources.find(s => /\b(youtube|twitch|netflix|hulu|prime|disney)\b/i.test(s.name));
      // 4. Last resort: the first screen.
      if (!pick) pick = sources.find(s => s.id.startsWith('screen:')) || sources[0];
      if (!pick) return null;
      return { id: pick.id, name: pick.name };
    } catch {
      return null;
    }
  });

  // List every desktopCapturer source so the visualizer source picker
  // can show a dropdown of windows + screens. Thumbnail is a tiny PNG
  // data URL the renderer can render inline (160×90 → ~5-8 KB each).
  // Returns a Map<hwnd, { name, pid, title }> for every visible top-
  // level window on Windows. Used by visualizer-list-sources to tag
  // each desktopCapturer window with its owning application's process
  // name, so the rec-room source picker can group by app. PowerShell
  // EnumWindows is slow on first invocation (Add-Type JIT ~1 s) but
  // subsequent picker opens within the same session are quicker as
  // the .NET compile cache is reused.
  async function _getVisibleWindowProcessMap() {
    if (process.platform !== 'win32') return new Map();
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WL {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc fn, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
$out = New-Object System.Collections.ArrayList
$delegate = [WL+EnumProc] {
  param([IntPtr]$h, [IntPtr]$l)
  if ([WL]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    $len = [WL]::GetWindowText($h, $sb, 512)
    if ($len -gt 0) {
      $procId = 0
      [WL]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      try {
        $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName
        $null = $out.Add([pscustomobject]@{ hwnd = [int64]$h; pid = [int]$procId; name = $name })
      } catch {}
    }
  }
  return $true
}
[WL]::EnumWindows($delegate, [IntPtr]::Zero) | Out-Null
$out | ConvertTo-Json -Compress
`;
    // Use -EncodedCommand (UTF-16LE base64) so the multi-line here-
    // string for Add-Type survives the command-line argument escape
    // pass. Passing the same script via -Command lost newlines and
    // PowerShell parsed `Add-Type @"` as a one-line token, blowing up
    // before the C# class was even compiled.
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    return await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d.toString('utf8'); });
      child.on('error', () => resolve(new Map()));
      child.on('exit', () => {
        try {
          const arr = JSON.parse(buf || '[]');
          const list = Array.isArray(arr) ? arr : [arr];
          const map = new Map();
          for (const e of list) {
            if (e && Number.isFinite(e.hwnd)) map.set(Number(e.hwnd), { name: e.name, pid: e.pid });
          }
          resolve(map);
        } catch { resolve(new Map()); }
      });
      // Hard cap — never hold the picker more than 4 s on this lookup.
      // Bumped a tick because Add-Type's first invocation per process
      // can take a full second on a cold .NET cache.
      setTimeout(() => { try { child.kill(); } catch {} }, 4000);
    });
  }

  ipcMain.handle('visualizer-list-sources', async () => {
    try {
      const [sources, procMap] = await Promise.all([
        desktopCapturer.getSources({
          types: ['window', 'screen'],
          thumbnailSize: { width: 160, height: 90 },
        }),
        _getVisibleWindowProcessMap(),
      ]);
      // Debug dump — write the raw source ids + procMap entries to a
      // temp file so we can verify HWND matching is correct after the
      // EncodedCommand fix. Remove this block once diagnostics are no
      // longer needed.
      try {
        const debug = {
          procMapSize: procMap.size,
          procMap: [...procMap.entries()].map(([hwnd, info]) => ({ hwnd, ...info })),
          sources: sources.map(s => ({ id: s.id, name: s.name })),
        };
        const debugPath = path.join(app.getPath('temp'), 'dash3d-source-debug.json');
        fs.writeFileSync(debugPath, JSON.stringify(debug, null, 2), 'utf8');
      } catch (err) {
        console.warn('[visualizer-list-sources] debug write failed:', err.message);
      }
      return sources.map(s => {
        // Electron window source IDs on Windows are "window:<HWND>:0" —
        // pull the HWND out so we can look up the owning process. On
        // non-Windows platforms procMap stays empty and appName is ''.
        let appName = '';
        if (s.id.startsWith('window:')) {
          const parts = s.id.split(':');
          const hwnd = parseInt(parts[1], 10);
          const info = Number.isFinite(hwnd) ? procMap.get(hwnd) : null;
          if (info?.name) appName = info.name;
        }
        return {
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail?.toDataURL?.() || null,
          appName,
        };
      });
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── SCREENCAP: input-driven JPEG capture to <gallery>/screencap/ ──
  // Renderer encodes the frame (it owns the MediaStream); main owns
  // the file write + the powerMonitor poll that detects user input
  // anywhere on the system. When idle-time drops below the previous
  // poll's value (= new keypress/mouse activity), we ping the renderer
  // to grab a frame. Throttle in the renderer prevents flooding when
  // activity is continuous.
  let _screencapPollTimer = null;
  let _screencapLastIdle = Number.POSITIVE_INFINITY;
  function _stopScreencapWatcher() {
    if (_screencapPollTimer) {
      clearInterval(_screencapPollTimer);
      _screencapPollTimer = null;
    }
    _screencapLastIdle = Number.POSITIVE_INFINITY;
  }
  // Each SNAP session writes into its own timestamped subfolder under
  // gallery/screencap/. Created on watch-start, used by screencap-save
  // for every capture during the session, cleared on watch-stop so the
  // next SNAP toggle creates a fresh folder.
  let _screencapSessionDir = null;

  ipcMain.handle('screencap-watch-start', () => {
    _stopScreencapWatcher();
    try {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const sessionName = `session-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      _screencapSessionDir = path.join(galleryFolderPath(), 'screencap', sessionName);
      fs.mkdirSync(_screencapSessionDir, { recursive: true });
    } catch (err) {
      console.warn('[screencap] session folder failed:', err.message);
      _screencapSessionDir = null;
    }
    _screencapLastIdle = powerMonitor.getSystemIdleTime();
    _screencapPollTimer = setInterval(() => {
      if (!_mainWin || _mainWin.isDestroyed()) return;
      const idle = powerMonitor.getSystemIdleTime();
      // Idle time dropping (or staying at 0) means there was input
      // since the last poll. Fire one trigger; renderer throttles.
      if (idle < _screencapLastIdle || idle === 0) {
        try { _mainWin.webContents.send('screencap-trigger'); } catch {}
      }
      _screencapLastIdle = idle;
    }, 250);
    return { ok: true, sessionDir: _screencapSessionDir };
  });
  ipcMain.handle('screencap-watch-stop', () => {
    _stopScreencapWatcher();
    _screencapSessionDir = null;
    return { ok: true };
  });
  // Resolve a non-colliding path inside `dir`. If `baseName.ext` already
  // exists, append `-1`, `-2`, … until we find a free slot. Used by
  // screencap + screenrec so re-running a recording in the same second
  // never overwrites an earlier file.
  function _uniquePath(dir, baseName, ext) {
    let name = `${baseName}${ext}`;
    let full = path.join(dir, name);
    let n = 0;
    while (fs.existsSync(full)) {
      n++;
      name = `${baseName}-${n}${ext}`;
      full = path.join(dir, name);
    }
    return { full, name };
  }

  // Build the next `<USER> NNNN` filename for the recordings folder. The
  // prefix is the user's configured name when one is set, else literal
  // "USER". The counter is global to the recordings folder (PROCESS and
  // SCREENREC share it) so the user gets one continuous sequence.
  // Pads to 4 digits; rolls past 9999 just by widening the number, no
  // wrap. Scans existing files matching `<prefix> ####.*` so a fresh
  // install starts at 0000 and subsequent saves keep climbing.
  async function _nextUserSeqName(dir, ext) {
    let prefix = 'USER';
    try {
      const cfg = await readConfig();
      const n = (cfg?.userName || '').toString().trim();
      if (n) prefix = n;
    } catch {}
    // Sanitize: strip filesystem-illegal characters from the username so
    // a name like "A/B" can't break out of the folder.
    const safePrefix = prefix.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() || 'USER';
    let files = [];
    try { files = await fs.promises.readdir(dir); } catch {}
    const esc = safePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + esc + ' (\\d{4,})\\.', 'i');
    let maxN = -1;
    for (const f of files) {
      const m = re.exec(f);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
    const next = maxN + 1;
    const base = `${safePrefix} ${String(next).padStart(4, '0')}`;
    return _uniquePath(dir, base, ext);
  }

  // Save a JPEG (renderer sends a base64 data URL or raw base64).
  // Returns the absolute path written so the renderer can show toast.
  ipcMain.handle('screencap-save', (_e, dataUrl) => {
    try {
      const m = String(dataUrl || '').match(/^data:image\/jpe?g;base64,(.+)$/);
      const b64 = m ? m[1] : String(dataUrl || '');
      if (!b64) return { ok: false, error: 'empty' };
      // Active session folder when SNAP is on; fall back to the root
      // screencap/ dir if a save somehow fires outside a session (e.g.
      // race during shutdown).
      const dir = _screencapSessionDir || path.join(galleryFolderPath(), 'screencap');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const base = `screencap-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3,'0')}`;
      const { full, name } = _uniquePath(dir, base, '.jpg');
      fs.writeFileSync(full, Buffer.from(b64, 'base64'));
      return { ok: true, path: full, name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── FFMPEG: detect bundled ffmpeg + hardware encoders ──────────────
  // ffmpeg-static ships a Windows BtbN build that includes h264_nvenc /
  // hevc_nvenc / av1_nvenc. We probe once at startup and cache the
  // result so the renderer can route PROCESS SNAPS through the fast
  // path (real ffmpeg, GPU when available) instead of MediaRecorder.
  let _ffmpegInfo = null; // { path, available, hasNvenc, hasHevcNvenc, hasMp4 } | null while probing
  const _ffmpegBin = (() => {
    try {
      // ffmpeg-static returns the path or null. In packaged builds with
      // asar=false the path is real on disk; with asar it points inside
      // the asar and ffmpeg won't be executable, but our build sets
      // asar=false so this works in both dev and packaged runs.
      const p = require('ffmpeg-static');
      console.log('[ffmpeg-static] require returned:', p);
      return (typeof p === 'string' && p) ? p : null;
    } catch (err) {
      console.warn('[ffmpeg-static] require failed:', err?.message || err);
      return null;
    }
  })();
  async function _probeFfmpeg() {
    if (!_ffmpegBin) {
      console.warn('[ffmpeg] no binary path resolved');
      _ffmpegInfo = { path: null, available: false, hasNvenc: false, hasHevcNvenc: false, hasMp4: false, reason: 'ffmpeg-static require returned null' };
      return _ffmpegInfo;
    }
    if (!fs.existsSync(_ffmpegBin)) {
      console.warn('[ffmpeg] binary missing at', _ffmpegBin);
      _ffmpegInfo = { path: _ffmpegBin, available: false, hasNvenc: false, hasHevcNvenc: false, hasMp4: false, reason: 'binary not found on disk' };
      return _ffmpegInfo;
    }
    const result = await new Promise((resolve) => {
      execFile(_ffmpegBin, ['-hide_banner', '-encoders'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    if (result.err) {
      console.warn('[ffmpeg] -encoders probe failed:', result.err.message, 'stderr:', result.stderr.slice(0, 200));
      _ffmpegInfo = { path: _ffmpegBin, available: false, hasNvenc: false, hasHevcNvenc: false, hasMp4: false, reason: `execFile error: ${result.err.message}` };
      return _ffmpegInfo;
    }
    _ffmpegInfo = {
      path: _ffmpegBin,
      available: !!result.stdout,
      hasNvenc:     /\sh264_nvenc\s/.test(result.stdout),
      hasHevcNvenc: /\shevc_nvenc\s/.test(result.stdout),
      hasQsv:       /\sh264_qsv\s/.test(result.stdout),   // Intel QuickSync
      hasAmf:       /\sh264_amf\s/.test(result.stdout),   // AMD AMF
      hasMp4:       true, // ffmpeg can always mux mp4
    };
    console.log('[ffmpeg] probe ok:', { available: _ffmpegInfo.available, hasNvenc: _ffmpegInfo.hasNvenc, hasQsv: _ffmpegInfo.hasQsv, hasAmf: _ffmpegInfo.hasAmf, path: _ffmpegBin });
    return _ffmpegInfo;
  }
  // Kick off the probe immediately so it's ready by the time the user
  // opens the rec room.
  _probeFfmpeg().catch(() => {});
  ipcMain.handle('ffmpeg-info', async () => {
    return _ffmpegInfo || await _probeFfmpeg();
  });

  // GPU diagnostic — surfaces Chromium's GPU-feature-status block to
  // the renderer so we can confirm hardware acceleration is on. Maps
  // to the same data chrome://gpu shows. Triggered from the renderer
  // (e.g., from the diag overlay or a one-shot console call).
  ipcMain.handle('gpu-info', async () => {
    try {
      const status = app.getGPUFeatureStatus(); // { gpu_compositing, ... }
      const info   = await app.getGPUInfo('complete');
      // Trim to the parts that matter for our perf debugging — full
      // info is huge and noisy.
      return {
        ok: true,
        features: status,
        device: info?.gpuDevice?.[0] || info?.auxAttributes || null,
        glRenderer: info?.auxAttributes?.glRenderer
                 || info?.basicInfo?.glRenderer
                 || null,
        glVersion: info?.auxAttributes?.glVersion
                || info?.basicInfo?.glVersion
                || null,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── FFMPEG: stitch snaps → video (GPU/NVENC fast path) ─────────────
  // Receives { paths, format, outH, bitsPerSec, holdMs, useGpu, codec }.
  // Writes a concat-demuxer list file to %TEMP%, spawns ffmpeg, streams
  // progress back to the renderer via 'process-snaps-progress', and saves
  // the result into <gallery>/recordings/processed-…<ext>.
  ipcMain.handle('process-snaps-ffmpeg', async (e, opts) => {
    const info = _ffmpegInfo || await _probeFfmpeg();
    if (!info?.available) return { ok: false, error: 'ffmpeg not available' };
    const paths   = Array.isArray(opts?.paths) ? opts.paths.filter(Boolean) : [];
    const format  = (opts?.format === 'webm' || opts?.format === 'mkv' || opts?.format === 'mp4') ? opts.format : 'mp4';
    const outH    = Number(opts?.outH) > 0 ? Math.round(opts.outH) : 0; // 0 = keep source
    const bps     = Number(opts?.bitsPerSec) > 0 ? Math.round(opts.bitsPerSec) : 5_000_000;
    const holdMs  = Math.max(33, Number(opts?.holdMs) || 1000);
    const useGpu  = !!opts?.useGpu;
    const codecReq = String(opts?.codec || 'h264');
    if (paths.length < 2) return { ok: false, error: 'need at least 2 input frames' };

    // Build the concat-demuxer list. ffmpeg's concat demuxer requires the
    // last file to be repeated for the trailing `duration` to take effect,
    // otherwise the final image is cut to a single frame.
    // https://ffmpeg.org/ffmpeg-formats.html#concat
    const escape = (p) => String(p).replace(/\\/g, '/').replace(/'/g, "'\\''");
    const durSec = (holdMs / 1000).toFixed(4);
    const lines = [];
    for (const p of paths) {
      lines.push(`file '${escape(p)}'`);
      lines.push(`duration ${durSec}`);
    }
    lines.push(`file '${escape(paths[paths.length - 1])}'`);
    const tmpDir = app.getPath('temp');
    const listPath = path.join(tmpDir, `dash3d-snaps-${Date.now()}.txt`);
    try { fs.writeFileSync(listPath, lines.join('\n'), 'utf8'); }
    catch (err) { return { ok: false, error: 'failed to write concat list: ' + err.message }; }

    // Output path: gallery/recordings/<USER> NNNN.<ext>. Prefix uses the
    // configured userName (cfg.userName) when set, else literal "USER".
    // Counter auto-increments across runs by scanning existing files.
    const dir = path.join(galleryFolderPath(), 'recordings');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const ext = '.' + format;
    const { full: outPath, name: outName } = await _nextUserSeqName(dir, ext);

    // Pick the encoder. GPU path uses h264_nvenc / hevc_nvenc; CPU path
    // uses libx264 / libx265. For WebM we always use VP9 (CPU — no
    // widely-shipped NVENC VP9 encoder).
    let vcodec = 'libx264';
    let preset = ['-preset', 'medium'];
    if (format === 'webm') {
      vcodec = 'libvpx-vp9';
      preset = ['-deadline', 'good', '-cpu-used', '4'];
    } else if (useGpu && codecReq === 'hevc' && info.hasHevcNvenc) {
      vcodec = 'hevc_nvenc';
      preset = ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr'];
    } else if (useGpu && info.hasNvenc) {
      vcodec = 'h264_nvenc';
      preset = ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr'];
    } else if (codecReq === 'hevc') {
      vcodec = 'libx265';
    }

    // Scale filter: lock width to even (yuv420p requires it). -2 keeps
    // aspect ratio while forcing even dimensions.
    const vfBase = outH > 0
      ? `scale=-2:${outH}:flags=lanczos`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    // Optional color/blur/denoise pass from the rec-room EDIT panel's
    // shared filter state. Same math as edit-export-video so both
    // entry points produce a consistent look. All segments are no-ops
    // when the slider is at default.
    const filt = opts?.filters || {};
    const sld = filt.sliders || {};
    let fB = Number(sld.brightness ?? 100);
    let fC = Number(sld.contrast   ?? 100);
    let fS = Number(sld.saturation ?? 100);
    const fH = Number(sld.hue ?? 0);
    const fBl = Number(sld.blur ?? 0);
    if (filt.auto) { fC = Math.min(200, fC + 15); fS = Math.min(200, fS + 10); }
    const extra = [];
    const eqB = ((fB - 100) / 100).toFixed(3);
    const eqC = (fC / 100).toFixed(3);
    const eqS = (fS / 100).toFixed(3);
    if (eqB !== '0.000' || eqC !== '1.000' || eqS !== '1.000') {
      extra.push(`eq=brightness=${eqB}:contrast=${eqC}:saturation=${eqS}`);
    }
    if (fH !== 0)    extra.push(`hue=h=${fH}`);
    if (fBl > 0.01)  extra.push(`boxblur=${fBl.toFixed(2)}:1`);
    if (filt.denoise) extra.push('hqdn3d=1.5:1.5:6:6');
    const vf = [vfBase, ...extra, 'format=yuv420p'].join(',');

    const args = [
      '-hide_banner', '-y',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-vf', vf,
      '-c:v', vcodec,
      ...preset,
      '-b:v', String(bps),
      '-maxrate', String(Math.round(bps * 1.5)),
      '-bufsize', String(bps * 2),
      '-pix_fmt', 'yuv420p',
      '-r', String(Math.max(1, Math.min(60, Math.round(1000 / holdMs)))),
    ];
    if (format === 'mp4') args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:2'); // emit key=value progress on stderr
    args.push(outPath);

    const proc = spawn(info.path, args, { windowsHide: true });
    const sender = e.sender;
    const total = paths.length;
    let lastFrame = 0;
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderr += s;
      if (stderr.length > 16384) stderr = stderr.slice(-16384);
      // ffmpeg -progress emits one key=value per line; we sniff `frame=`
      // both from -progress output and from the human progress bar
      // (which writes \rframe= …).
      const m = s.match(/frame=\s*(\d+)/);
      if (m) {
        const frame = Number(m[1]);
        if (frame > lastFrame) {
          lastFrame = frame;
          try { sender?.send?.('process-snaps-progress', { frame, total, encoder: vcodec }); } catch {}
        }
      }
    });
    const code = await new Promise((resolve) => {
      proc.on('error', () => resolve(-1));
      proc.on('close', resolve);
    });
    try { fs.unlinkSync(listPath); } catch {}
    if (code !== 0) {
      try { fs.unlinkSync(outPath); } catch {}
      return { ok: false, error: `ffmpeg exit ${code}: ${stderr.split('\n').slice(-6).join(' | ')}` };
    }
    let size = 0;
    try { size = fs.statSync(outPath).size; } catch {}
    return { ok: true, path: outPath, name: outName, size, encoder: vcodec };
  });

  // ── PROCESS SNAPS: save a stitched snap-to-video blob ────────────
  // The renderer encodes everything (canvas + MediaRecorder) and ships
  // the final blob as a single Uint8Array here. We write to
  // <gallery>/recordings/ alongside live screen records so the rec
  // room's recordings folder is the one place to find both.
  ipcMain.handle('process-snaps-save', async (_e, bytes, ext) => {
    try {
      const dir = path.join(galleryFolderPath(), 'recordings');
      fs.mkdirSync(dir, { recursive: true });
      // Whitelist extensions so a bad renderer can't write arbitrary
      // file types via this handler.
      const safeExt = ['.mp4', '.mkv', '.webm'].includes(ext) ? ext : '.mkv';
      const { full, name } = await _nextUserSeqName(dir, safeExt);
      fs.writeFileSync(full, Buffer.from(bytes));
      const size = fs.statSync(full).size;
      return { ok: true, path: full, name, size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── §rec-edit ── FFMPEG: trim + filter a recorded clip ────────────
  // Used by the rec-room EDIT panel. Builds an ffmpeg invocation with
  // -ss / -to (trim) and a -vf chain assembled from the editor's
  // brightness / contrast / saturation / hue / blur / auto-contrast /
  // denoise state. Auto contrast = slight contrast+saturation boost
  // (matches the CSS preview). Denoise = hqdn3d=1.5:1.5:6:6.
  // Output is gallery/recordings/<USER NNNN>.mp4 (h264_nvenc when
  // available, libx264 otherwise — keeps it broadly playable).
  ipcMain.handle('edit-export-video', async (_e, opts) => {
    const info = _ffmpegInfo || await _probeFfmpeg();
    if (!info?.available) return { ok: false, error: 'ffmpeg not available' };
    const srcPath = String(opts?.srcPath || '');
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'source not found' };
    const trimIn  = Math.max(0, Number(opts?.trimIn)  || 0);
    const trimOut = Math.max(trimIn + 0.05, Number(opts?.trimOut) || (trimIn + 0.05));
    const s = opts?.sliders || {};
    // Build the -vf chain. ffmpeg's `eq=` takes 0..1 delta-style values
    // for brightness and float multipliers for contrast/saturation.
    let brightness = Number(s.brightness ?? 100);
    let contrast   = Number(s.contrast   ?? 100);
    let saturation = Number(s.saturation ?? 100);
    const hue      = Number(s.hue        ?? 0);
    const blur     = Number(s.blur       ?? 0);
    const sharpen  = Number(s.sharpen    ?? 0);   // 0..200 → unsharp amount
    const vignette = Number(s.vignette   ?? 0);   // 0..100 → vignette strength
    const speed    = Math.max(25, Math.min(400, Number(s.speed ?? 100))); // %
    const volume   = Math.max(0,  Math.min(400, Number(s.volume ?? 100))); // %
    if (opts?.auto) { contrast = Math.min(200, contrast + 15); saturation = Math.min(200, saturation + 10); }
    const filters = [];
    // 1) Crop FIRST so subsequent filters operate on the cropped region
    //    only (avoids wasted CPU on pixels we're throwing away).
    if (opts?.crop && Number.isFinite(opts.crop.w) && opts.crop.w > 0.001) {
      const c = opts.crop;
      const cx = Math.max(0, Math.min(1, c.x));
      const cy = Math.max(0, Math.min(1, c.y));
      const cw = Math.max(0.001, Math.min(1 - cx, c.w));
      const ch = Math.max(0.001, Math.min(1 - cy, c.h));
      filters.push(`crop=iw*${cw.toFixed(4)}:ih*${ch.toFixed(4)}:iw*${cx.toFixed(4)}:ih*${cy.toFixed(4)}`);
    }
    // 2) Rotate — ffmpeg uses transpose for 90° steps. transpose=1 is
    //    90 CW, transpose=2 is 90 CCW. 180 = two transposes.
    if (opts?.rotate === 90)  filters.push('transpose=1');
    else if (opts?.rotate === 180) filters.push('transpose=1,transpose=1');
    else if (opts?.rotate === 270) filters.push('transpose=2');
    if (opts?.flipH) filters.push('hflip');
    if (opts?.flipV) filters.push('vflip');
    // 3) Color pass.
    const eqB = ((brightness - 100) / 100).toFixed(3);
    const eqC = (contrast / 100).toFixed(3);
    const eqS = (saturation / 100).toFixed(3);
    if (eqB !== '0.000' || eqC !== '1.000' || eqS !== '1.000') {
      filters.push(`eq=brightness=${eqB}:contrast=${eqC}:saturation=${eqS}`);
    }
    if (hue !== 0)   filters.push(`hue=h=${hue}`);
    if (blur > 0.01) filters.push(`boxblur=${blur.toFixed(2)}:1`);
    if (sharpen > 0) {
      // unsharp=lx:ly:la — luma matrix 5x5, amount from 0..2 ~ sharpen/100
      const amt = (sharpen / 100).toFixed(2);
      filters.push(`unsharp=5:5:${amt}:5:5:0`);
    }
    if (vignette > 0) {
      // ffmpeg's vignette takes an angle in radians for the inner ring.
      // Strength is mapped via PI/5 .. PI/3 — gentle to heavy.
      const angle = (Math.PI / 5 + (vignette / 100) * (Math.PI / 3 - Math.PI / 5)).toFixed(3);
      filters.push(`vignette=angle=${angle}`);
    }
    if (opts?.bw)     filters.push('hue=s=0');
    if (opts?.sepia)  filters.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
    if (opts?.invert) filters.push('negate');
    if (opts?.denoise) filters.push('hqdn3d=1.5:1.5:6:6');
    // 4) Speed change — apply LAST so trim is consumed in real seconds.
    //    setpts adjusts video timing; atempo adjusts audio. atempo only
    //    accepts 0.5..2.0 per pass, so chain two passes for >2× / <0.5×.
    let speedFactor = speed / 100;
    if (Math.abs(speedFactor - 1) > 0.005) {
      filters.push(`setpts=PTS/${speedFactor.toFixed(3)}`);
    }
    if (opts?.reverse) filters.push('reverse');
    // Audio filter chain — separate from -vf.
    const aFilters = [];
    let aFactor = speedFactor;
    while (aFactor > 2.0) { aFilters.push('atempo=2.0'); aFactor /= 2.0; }
    while (aFactor < 0.5) { aFilters.push('atempo=0.5'); aFactor /= 0.5; }
    if (Math.abs(aFactor - 1) > 0.005) aFilters.push(`atempo=${aFactor.toFixed(3)}`);
    if (opts?.reverse) aFilters.push('areverse');
    if (volume !== 100) aFilters.push(`volume=${(volume / 100).toFixed(3)}`);
    // Output codec — prefer NVENC h264 for fast export, fall back to
    // libx264 which is universally available. Tuned for SPEED here
    // (NVENC p2/preset-fast) since the user wants exports fast; the
    // bitrate is generous enough that quality stays good. Profile
    // and level are pinned so the result plays in Chromium <video>.
    let vcodec, preset;
    if (info.hasNvenc) {
      vcodec = 'h264_nvenc';
      // p2 = fast NVENC preset (p1 is fastest, p7 is slowest/quality).
      // CQ 21 ≈ near-visually-lossless at this resolution.
      preset = ['-preset', 'p2', '-tune', 'hq', '-rc', 'vbr', '-cq', '21'];
    } else if (info.hasQsv) {
      vcodec = 'h264_qsv';
      preset = ['-preset', 'veryfast'];
    } else if (info.hasAmf) {
      vcodec = 'h264_amf';
      preset = ['-quality', 'speed'];
    } else {
      vcodec = 'libx264';
      preset = ['-preset', 'veryfast', '-crf', '20'];
    }
    // Profile / level pinned to a combo Chromium's <video> always
    // accepts. NVENC default sometimes emits a level Chromium chokes
    // on; explicit -profile/-level is harmless on every backend.
    const profileFlags = ['-profile:v', 'high', '-level', '4.1'];
    const dir = path.join(galleryFolderPath(), 'recordings');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const { full: outPath, name: outName } = await _nextUserSeqName(dir, '.mp4');
    // Build the input list. Each clip is either a video (trim/concat
    // straight from the file) or an image (loop the still for N
    // seconds via `-loop 1 -t N -i image.png`, with silent audio
    // synthesized in the filter graph so concat sees uniform streams).
    //
    // Normalize the extras into [{path, kind, duration}] regardless of
    // whether the caller sent strings (legacy) or objects (new).
    const rawExtras = Array.isArray(opts?.extraClips) ? opts.extraClips : [];
    const extras = rawExtras
      .map((c) => (typeof c === 'string')
        ? { path: c, kind: 'video', duration: 5 }
        : { path: String(c?.path || ''),
            kind: (c?.kind === 'image') ? 'image' : 'video',
            duration: Math.max(0.1, Number(c?.duration) || 5) })
      .filter((c) => c.path && fs.existsSync(c.path));
    const anchorKind = (opts?.anchorKind === 'image') ? 'image' : 'video';
    const anchorDur  = Math.max(0.1, Number(opts?.anchorDuration) || 3);
    // Normalize V2 image overlays — each entry positions a still on
    // top of the V1 output for [start, start+duration). Fractions are
    // converted to pixels using the project resolution.
    const projW = Math.max(2, Number(opts?.projectWidth)  || 1920);
    const projH = Math.max(2, Number(opts?.projectHeight) || 1080);
    const projFps = Math.max(15, Math.min(120, Number(opts?.projectFps) || 30));
    const v2Overlays = Array.isArray(opts?.v2Overlays) ? opts.v2Overlays : [];
    const overlays = v2Overlays
      .map((o) => ({
        path: String(o?.path || ''),
        start: Math.max(0, Number(o?.start) || 0),
        duration: Math.max(0.05, Number(o?.duration) || 3),
        x: Math.max(0, Math.min(1, Number(o?.x) ?? 0.25)),
        y: Math.max(0, Math.min(1, Number(o?.y) ?? 0.25)),
        w: Math.max(0.02, Math.min(1, Number(o?.w) ?? 0.5)),
        h: Math.max(0.02, Math.min(1, Number(o?.h) ?? 0.5)),
      }))
      .filter((o) => o.path && fs.existsSync(o.path));
    const hasOverlays = overlays.length > 0;
    const isMulti = extras.length > 0 || anchorKind === 'image' || hasOverlays;
    const args = ['-hide_banner', '-y'];
    // Helper — push the per-input flags for one clip onto args, and
    // return a label suffix indicating whether it carried an audio
    // stream (image inputs don't, so we synthesize silence later).
    function pushInput(clip) {
      if (clip.kind === 'image') {
        args.push('-loop', '1', '-framerate', '30', '-t', clip.dur.toFixed(3), '-i', clip.path);
        return false;
      }
      // Video: trim applied at the input level if this is the anchor.
      if (clip.isAnchor) {
        args.push('-ss', clip.trimIn.toFixed(3), '-to', clip.trimOut.toFixed(3), '-i', clip.path);
      } else {
        args.push('-i', clip.path);
      }
      return true;
    }
    if (!isMulti) {
      // Single video clip — fastest path, in-place trim via -ss/-to.
      args.push('-ss', trimIn.toFixed(3), '-to', trimOut.toFixed(3), '-i', srcPath);
      if (filters.length)  args.push('-vf', filters.join(','));
      if (aFilters.length) args.push('-af', aFilters.join(','));
    } else {
      // Anchor + extras (V1 track) first as concat inputs.
      const anchor = {
        path: srcPath,
        kind: anchorKind,
        dur: anchorKind === 'image' ? Math.max(0.1, trimOut - trimIn || anchorDur) : 0,
        trimIn, trimOut, isAnchor: true,
      };
      const allClips = [anchor, ...extras];
      const hasAudioFlags = allClips.map(pushInput);
      // V2 overlay inputs append AFTER all V1 inputs so their stream
      // indices are n, n+1, n+2, …
      const nV1 = allClips.length;
      for (const o of overlays) {
        args.push('-loop', '1', '-framerate', String(projFps),
                  '-t', o.duration.toFixed(3), '-i', o.path);
      }
      // Build filter_complex. Stage 1: per-clip PTS normalize +
      // silent-audio synth for image clips.
      let fc = '';
      const concatLabels = [];
      for (let i = 0; i < nV1; i++) {
        fc += `[${i}:v]setpts=PTS-STARTPTS,scale=${projW}:${projH}:force_original_aspect_ratio=decrease,pad=${projW}:${projH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}];`;
        if (hasAudioFlags[i]) {
          fc += `[${i}:a]asetpts=PTS-STARTPTS[a${i}];`;
        } else {
          const dur = allClips[i].dur;
          fc += `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${dur.toFixed(3)}[a${i}];`;
        }
        concatLabels.push(`[v${i}][a${i}]`);
      }
      // Stage 2: concat the V1 chain into [cv]/[ca].
      fc += `${concatLabels.join('')}concat=n=${nV1}:v=1:a=1[cv][ca]`;
      // Stage 3: overlay each V2 image onto the running [cv]. We pipe
      // each overlay through a scale to the desired pixel size first,
      // then composite with `enable='between(t,start,end)'` so it only
      // shows during its time range.
      let chainLabel = 'cv';
      for (let j = 0; j < overlays.length; j++) {
        const o = overlays[j];
        const idx = nV1 + j;        // ffmpeg input index for this overlay
        const ovW = Math.max(2, Math.round(projW * o.w));
        const ovH = Math.max(2, Math.round(projH * o.h));
        const ovX = Math.round(projW * o.x);
        const ovY = Math.round(projH * o.y);
        const endT = (o.start + o.duration).toFixed(3);
        fc += `;[${idx}:v]scale=${ovW}:${ovH}[ov${j}]`;
        const outLabel = `cv${j + 1}`;
        fc += `;[${chainLabel}][ov${j}]overlay=${ovX}:${ovY}:enable='between(t,${o.start.toFixed(3)},${endT})'[${outLabel}]`;
        chainLabel = outLabel;
      }
      // Stage 4: final color/transform chain → [outv]; audio chain → [outa].
      if (filters.length)  fc += `;[${chainLabel}]${filters.join(',')}[outv]`;
      else                 fc += `;[${chainLabel}]null[outv]`;
      if (aFilters.length) fc += `;[ca]${aFilters.join(',')}[outa]`;
      else                 fc += `;[ca]anull[outa]`;
      args.push('-filter_complex', fc, '-map', '[outv]', '-map', '[outa]');
    }
    args.push(
      '-c:v', vcodec,
      ...profileFlags,
      ...preset,
      '-pix_fmt', 'yuv420p',
      '-r', String(projFps),
    );
    if (opts?.mute) args.push('-an');
    else            args.push('-c:a', 'aac', '-b:a', '160k');
    // -progress pipe:2 streams machine-parsable progress on stderr;
    // we sniff it and forward to the renderer for the progress bar.
    args.push('-progress', 'pipe:2');
    args.push(
      '-movflags', '+faststart',
      outPath,
    );
    // Estimate total output duration so we can compute percent. With
    // overlays + concat there's no easy single source; use the max of
    // (V1 concat duration, last overlay end).
    const v1Dur = (anchorKind === 'image'
        ? Math.max(0.1, trimOut - trimIn || anchorDur)
        : Math.max(0.1, trimOut - trimIn))
      + extras.reduce((s, c) => s + c.duration, 0);
    const overlaysEnd = overlays.reduce((m, o) => Math.max(m, o.start + o.duration), 0);
    const totalDur = Math.max(v1Dur, overlaysEnd, 0.1);
    const sender = _e?.sender;
    return await new Promise((resolve) => {
      const proc = spawn(info.path, args, { windowsHide: true });
      let stderr = '';
      let lastPct = -1;
      proc.stderr?.on('data', (chunk) => {
        const s = chunk.toString('utf8');
        stderr += s;
        if (stderr.length > 16384) stderr = stderr.slice(-16384);
        // ffmpeg -progress emits lines like `out_time_ms=12345678` +
        // `fps=29.97` + `progress=continue`. Parse and forward as
        // percent / fps.
        const tmMatch = s.match(/out_time_ms=(\d+)/);
        const fpsMatch = s.match(/fps=([\d.]+)/);
        if (tmMatch) {
          const tSec = Number(tmMatch[1]) / 1_000_000;
          const pct = Math.max(0, Math.min(99, (tSec / totalDur) * 100));
          if (Math.abs(pct - lastPct) >= 0.5) {
            lastPct = pct;
            try {
              sender?.send?.('edit-export-progress', {
                percent: pct,
                fps: fpsMatch ? Number(fpsMatch[1]) : null,
                encoder: vcodec,
              });
            } catch {}
          }
        }
      });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
      proc.on('close', (code) => {
        if (code !== 0) {
          try { fs.unlinkSync(outPath); } catch {}
          resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.split('\n').slice(-6).join(' | ')}` });
          return;
        }
        try { sender?.send?.('edit-export-progress', { percent: 100, fps: null, encoder: vcodec }); } catch {}
        let size = 0;
        try { size = fs.statSync(outPath).size; } catch {}
        resolve({ ok: true, path: outPath, name: outName, size, encoder: vcodec });
      });
    });
  });

  // ── §generate ── COMFYUI workflow front-end ───────────────────────
  // Three responsibilities here:
  //   1. comfy-list-workflows: scan the configured directory for
  //      *.json ComfyUI workflow files, return entries with display
  //      name + kind (image/video/audio) derived from filename prefix.
  //   2. comfy-load-workflow: read one workflow JSON safely (must live
  //      inside the configured directory; symlink/path-traversal
  //      attempts are rejected).
  //   3. comfy-save-output: write a base64-encoded result back into the
  //      gallery under generated/<kind>/<USER NNNN>.<ext>.
  //
  // The renderer talks to ComfyUI's HTTP API via the comfy-http IPC
  // below — proxied through main because Electron's renderer origin
  // can't reach loopback directly under app:// CORS rules.
  function _comfyWorkflowDir() {
    // Use the real user profile dir (os.homedir) — `os.userInfo().username`
    // returns the NT account name, which can differ from the profile-
    // folder name (Windows truncates long Microsoft-account emails).
    // Configurable via cfg.comfyWorkflowDir.
    return path.join(os.homedir(), 'OneDrive', 'Desktop', 'comfyistuff');
  }
  async function _comfyResolveDir() {
    let dir = '';
    try {
      const cfg = await readConfig();
      if (cfg?.comfyWorkflowDir) dir = String(cfg.comfyWorkflowDir);
    } catch {}
    if (!dir) dir = _comfyWorkflowDir();
    return path.resolve(dir);
  }
  ipcMain.handle('comfy-list-workflows', async () => {
    const dir = await _comfyResolveDir();
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!/\.json$/i.test(e.name)) continue;
        // Filename convention: <kind>_<rest>.json (image_/video_/audio_).
        const m = e.name.match(/^(image|video|audio)[_-](.+)\.json$/i);
        const kind = m ? m[1].toLowerCase() : 'unknown';
        const slug = m ? m[2] : e.name.replace(/\.json$/i, '');
        const display = slug.replace(/[_-]+/g, ' ').toUpperCase().trim();
        out.push({ file: e.name, kind, display });
      }
      // Sort: image first, then video, then audio, then unknown; then alpha.
      const ORDER = { image: 0, video: 1, audio: 2, unknown: 3 };
      out.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || a.display.localeCompare(b.display));
      return { ok: true, dir, entries: out };
    } catch (err) {
      return { ok: false, dir, entries: [], error: err.message };
    }
  });
  ipcMain.handle('comfy-load-workflow', async (_e, file) => {
    const dir = await _comfyResolveDir();
    const target = path.resolve(dir, String(file || ''));
    // Sandbox to the configured dir — block ".." traversal.
    if (!target.startsWith(dir + path.sep) && target !== dir) {
      return { ok: false, error: 'path outside workflow directory' };
    }
    try {
      const raw = await fs.promises.readFile(target, 'utf8');
      return { ok: true, json: JSON.parse(raw) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Save a generated output to gallery/generated/<kind>/. bytes is a
  // Uint8Array (Buffer-like) handed back from the renderer; ext is the
  // file extension WITH leading dot ('.png', '.mp4', '.wav', etc.).
  ipcMain.handle('comfy-save-output', async (_e, kind, bytes, ext, nameHint) => {
    try {
      const safeKind = ['image', 'video', 'audio'].includes(kind) ? kind : 'image';
      const safeExt = /^\.[A-Za-z0-9]{2,5}$/.test(ext) ? ext : '.png';
      const dir = path.join(galleryFolderPath(), 'generated', safeKind);
      fs.mkdirSync(dir, { recursive: true });
      let full, name;
      // If the caller suggested a filename (e.g. a creative AI-style
      // tag for audio outputs), sanitize and use that — falling back
      // to the sequential USER NNNN naming if the hint is empty,
      // unsafe, or collides with an existing file we can't resolve.
      const sanitized = (typeof nameHint === 'string')
        ? nameHint.replace(/[^A-Za-z0-9 _\-]/g, '').trim().slice(0, 64)
        : '';
      if (sanitized) {
        let base = sanitized;
        let candidate = path.join(dir, `${base}${safeExt}`);
        let n = 2;
        // De-collide by appending " 2", " 3", … if the basename is
        // already taken.
        while (fs.existsSync(candidate)) {
          base = `${sanitized} ${n++}`;
          candidate = path.join(dir, `${base}${safeExt}`);
          if (n > 999) { base = ''; break; }
        }
        if (base) { full = candidate; name = `${base}${safeExt}`; }
      }
      if (!full) {
        const seq = await _nextUserSeqName(dir, safeExt);
        full = seq.full;
        name = seq.name;
      }
      fs.writeFileSync(full, Buffer.from(bytes));
      const size = fs.statSync(full).size;
      return { ok: true, path: full, name, size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Proxy ComfyUI HTTP calls through main. Uses Node's built-in
  // http/https modules rather than Electron's `net.request` — the
  // latter goes through Chromium's network stack which has known
  // CONNECTION_REFUSED quirks with loopback on some Windows
  // configurations (even when the port is verifiably listening). Node's
  // http hits the OS socket directly and doesn't have the same issue.
  // Body may be a string, a Uint8Array, or a plain object (auto-
  // serialized as JSON).
  ipcMain.handle('comfy-http', async (_e, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    const urlStr = String(opts?.url || '');
    const body   = opts?.body;
    if (!urlStr || !/^https?:\/\//i.test(urlStr)) return { ok: false, error: 'invalid url' };
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return { ok: false, error: 'bad url: ' + e.message }; }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const headers = {};
    let payload = null;
    if (body != null) {
      if (typeof body === 'string') {
        payload = Buffer.from(body, 'utf8');
      } else if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
        payload = Buffer.from(body);
      } else {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = String(payload.length);
    }
    // Caller-supplied headers win — needed for multipart uploads that set
    // their own Content-Type with a boundary.
    if (opts?.headers && typeof opts.headers === 'object') {
      for (const k of Object.keys(opts.headers)) {
        headers[k] = String(opts.headers[k]);
      }
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      const req = lib.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        // Long inactivity timeout (35 min) for video generations; for
        // the initial socket connect we rely on the OS default.
        timeout: 35 * 60 * 1000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          finish({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            bytes: buf,
          });
        });
        res.on('error', (err) => finish({ ok: false, error: err.message }));
      });
      req.on('error',   (err) => finish({ ok: false, error: err.code ? `${err.code} ${err.message}` : err.message }));
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
      if (payload) req.write(payload);
      req.end();
    });
  });

  // ── SCREEN RECORD: stream MediaRecorder chunks to a temp file,
  // transcode to MP4 on stop ────────────────────────────────────────
  // The renderer owns the MediaRecorder (it has the MediaStream).
  // Each ondataavailable Blob gets sent here as a Uint8Array and
  // appended to a write stream — long recordings don't blow renderer
  // memory. Chromium emits a WebM container; on stop we run ffmpeg
  // to remux + re-encode that into a proper H.264/AAC .mp4 (which is
  // what gallery / external tools / share targets all expect).
  const _screenrecs = new Map(); // id → { stream, tmpPath, name, finalPath, mime, isMp4 }
  ipcMain.handle('screenrec-start', async (_e, opts) => {
    try {
      const dir = path.join(galleryFolderPath(), 'recordings');
      fs.mkdirSync(dir, { recursive: true });
      // Detect what the renderer's MediaRecorder is producing. If it's
      // MP4 (hardware H.264) we write straight to the final .mp4 and
      // skip the transcode on stop — saves CPU AND wall-time. If it's
      // WebM (software VP8/VP9), we keep the existing temp-then-
      // transcode flow.
      const mime  = String(opts?.mime || '');
      const isMp4 = /^video\/mp4/.test(mime);
      const { full, name } = await _nextUserSeqName(dir, '.mp4');
      const tmpPath = isMp4
        ? full // write straight to the final file
        : full.replace(/\.mp4$/i, '') + '.tmp.webm';
      const stream = fs.createWriteStream(tmpPath);
      const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      _screenrecs.set(id, { stream, tmpPath, finalPath: full, name, mime, isMp4 });
      return { ok: true, id, path: tmpPath, name, encoder: isMp4 ? 'hw-h264' : 'sw-vp8/9' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('screenrec-chunk', (_e, id, bytes) => {
    const rec = _screenrecs.get(id);
    if (!rec) return { ok: false, error: 'unknown recording id' };
    try {
      // `bytes` arrives as a Buffer-like (Electron serializes Uint8Array
      // and ArrayBuffer over IPC). Buffer.from handles both.
      rec.stream.write(Buffer.from(bytes));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // ── KEYCAPTURE: global key hook via PowerShell + GetAsyncKeyState ──
  // Spawns a PowerShell child that P/Invokes user32!GetAsyncKeyState at
  // ~50 Hz, prints one line per fresh key-down edge. We map the VK code
  // to a readable name and forward to the renderer. Stays system-wide
  // because we read kernel state — no need to focus our window or to
  // install a hook (no SetWindowsHookEx, no native dep).
  //
  // Important: this is an OBSERVATION-ONLY hook. It does NOT intercept
  // or swallow keys (unlike globalShortcut.register). The user's keys
  // still reach the focused app exactly as they normally would.
  const _VK_NAMES = (() => {
    const m = Object.create(null);
    m[8] = 'BACKSPACE'; m[9] = 'TAB'; m[13] = 'ENTER'; m[16] = 'SHIFT';
    m[17] = 'CTRL'; m[18] = 'ALT'; m[19] = 'PAUSE'; m[20] = 'CAPS';
    m[27] = 'ESC'; m[32] = 'SPACE'; m[33] = 'PGUP'; m[34] = 'PGDN';
    m[35] = 'END'; m[36] = 'HOME'; m[37] = '←'; m[38] = '↑'; m[39] = '→'; m[40] = '↓';
    m[44] = 'PRTSC'; m[45] = 'INS'; m[46] = 'DEL';
    for (let i = 48; i <= 57; i++) m[i] = String.fromCharCode(i);          // 0-9
    for (let i = 65; i <= 90; i++) m[i] = String.fromCharCode(i);          // A-Z
    m[91] = 'WIN'; m[92] = 'WIN'; m[93] = 'MENU';
    for (let i = 96; i <= 105; i++) m[i] = 'NUM' + (i - 96);
    m[106] = 'NUM*'; m[107] = 'NUM+'; m[109] = 'NUM-'; m[110] = 'NUM.'; m[111] = 'NUM/';
    for (let i = 112; i <= 123; i++) m[i] = 'F' + (i - 111);               // F1-F12
    m[144] = 'NUMLOCK'; m[145] = 'SCROLL';
    m[160] = 'SHIFT'; m[161] = 'SHIFT'; m[162] = 'CTRL'; m[163] = 'CTRL';
    m[164] = 'ALT';   m[165] = 'ALT';
    m[186] = ';'; m[187] = '='; m[188] = ','; m[189] = '-'; m[190] = '.';
    m[191] = '/'; m[192] = '`';
    m[219] = '['; m[220] = '\\'; m[221] = ']'; m[222] = "'";
    return m;
  })();
  function _spawnKeyHook() {
    if (_keyHookProc) return { ok: true, alreadyRunning: true };
    if (process.platform !== 'win32') return { ok: false, error: 'windows only' };
    // Single-quoted here-string so the C# source stays literal.
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KH {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$prev = New-Object 'bool[]' 256
while ($true) {
  for ($i = 8; $i -lt 256; $i++) {
    $s = [KH]::GetAsyncKeyState($i)
    $down = ($s -band 0x8000) -ne 0
    if ($down -and -not $prev[$i]) {
      [Console]::Out.WriteLine($i)
      [Console]::Out.Flush()
    }
    $prev[$i] = $down
  }
  Start-Sleep -Milliseconds 60
}
`;
    try {
      _keyHookProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      let buf = '';
      _keyHookProc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          // Hook is always running once spawned (pre-warm). We only
          // forward keys to the renderer when the user has actually
          // enabled the overlay, which avoids logging keystrokes for
          // sessions that never used the feature.
          if (!_keyHookEnabled) continue;
          const vk = parseInt(line, 10);
          if (!Number.isFinite(vk)) continue;
          const name = _VK_NAMES[vk];
          if (!name) continue;
          if (_mainWin && !_mainWin.isDestroyed()) {
            try { _mainWin.webContents.send('keycapture-key', { vk, name, ts: Date.now() }); } catch {}
          }
        }
      });
      _keyHookProc.on('exit', () => { _keyHookProc = null; });
      _keyHookProc.on('error', (err) => { console.warn('[keycapture] proc error:', err.message); _keyHookProc = null; });
      return { ok: true };
    } catch (err) {
      _keyHookProc = null;
      return { ok: false, error: err.message };
    }
  }
  // NOTE: no pre-warm. The previous version spawned a PowerShell child
  // process 2s after launch that polled GetAsyncKeyState on 256 keys
  // every 20ms — ~5% constant CPU even when the user never opened the
  // KEYS overlay. Now we lazy-spawn on first keycapture-start and tear
  // down on keycapture-stop so idle CPU stays low.

  ipcMain.handle('keycapture-start', () => {
    _keyHookEnabled = true;
    if (!_keyHookProc) _spawnKeyHook();
    return { ok: true };
  });
  ipcMain.handle('keycapture-stop', () => {
    _keyHookEnabled = false;
    _stopKeyHook();
    return { ok: true };
  });

  ipcMain.handle('screenrec-stop', async (_e, id) => {
    const rec = _screenrecs.get(id);
    if (!rec) return { ok: false, error: 'unknown recording id' };
    _screenrecs.delete(id);
    // Step 1 — close the temp file so anything else can read it.
    await new Promise((r) => rec.stream.end(r));
    // Fast path: recorder was already producing MP4 bytes (hardware
    // H.264). The file IS the final .mp4 — no transcode needed.
    if (rec.isMp4) {
      let size = 0;
      try { size = fs.statSync(rec.finalPath).size; } catch {}
      return { ok: true, path: rec.finalPath, name: rec.name, size, encoder: 'hw-h264-mediarecorder' };
    }
    // Slow path: WebM → MP4 transcode (software-encoded VP8/9 input).
    const info = _ffmpegInfo || await _probeFfmpeg();
    const tmpPath   = rec.tmpPath;
    const finalPath = rec.finalPath;
    if (!info?.available) {
      try { fs.renameSync(tmpPath, finalPath); }
      catch (err) { return { ok: false, error: 'no ffmpeg and rename failed: ' + err.message }; }
      let size = 0;
      try { size = fs.statSync(finalPath).size; } catch {}
      return { ok: true, path: finalPath, name: rec.name, size, encoder: 'webm-passthrough' };
    }
    const vcodec = info.hasNvenc ? 'h264_nvenc' : 'libx264';
    // Pin to High profile + Level 4.1 — broadest Chromium <video>
    // compatibility. NVENC's default ("High" profile) sometimes
    // emits a Level Chromium chokes on; libx264 defaults to High@auto
    // which is fine but be explicit anyway.
    const profileFlags = ['-profile:v', 'high', '-level', '4.1'];
    const preset = info.hasNvenc
      ? ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23']
      : ['-preset', 'medium', '-crf', '20'];
    const args = [
      '-hide_banner', '-y',
      '-i', tmpPath,
      // Re-encode video to H.264 yuv420p so it's universally playable.
      '-c:v', vcodec,
      ...profileFlags,
      ...preset,
      '-pix_fmt', 'yuv420p',
      // Re-encode audio to AAC; if the WebM had no audio, ffmpeg
      // silently drops the missing stream rather than erroring.
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      finalPath,
    ];
    const result = await new Promise((resolve) => {
      const proc = spawn(info.path, args, { windowsHide: true });
      let stderr = '';
      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 16384) stderr = stderr.slice(-16384);
      });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
      proc.on('close', (code) => {
        if (code !== 0) {
          resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.split('\n').slice(-6).join(' | ')}` });
          return;
        }
        let size = 0;
        try { size = fs.statSync(finalPath).size; } catch {}
        resolve({ ok: true, path: finalPath, name: rec.name, size, encoder: vcodec });
      });
    });
    if (result.ok) {
      // Transcode succeeded — drop the temp WebM.
      try { fs.unlinkSync(tmpPath); } catch {}
    } else {
      // Failed — keep the temp as a fallback so the user doesn't lose
      // the recording entirely. Rename it to the final path so it
      // shows up in the captures list.
      try {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        fs.renameSync(tmpPath, finalPath);
        let size = 0; try { size = fs.statSync(finalPath).size; } catch {}
        return { ok: true, path: finalPath, name: rec.name, size, encoder: 'webm-fallback', warning: result.error };
      } catch (err) {
        return { ok: false, error: result.error };
      }
    }
    return result;
  });

  ipcMain.handle('youtube-set-opacity', (_e, opacity) => {
    if (!_ytWin || _ytWin.isDestroyed()) return { ok: false };
    const o = Math.max(0.1, Math.min(1, Number(opacity)));
    if (!Number.isFinite(o)) return { ok: false };
    _ytWin.setOpacity(o);
    return { ok: true, opacity: o };
  });

  // yt-client bridge — renderer asks; main process owns the yt-dlp
  // binary + InnerTube/Bing/DDG/Google HTTPS + hidden BrowserWindow.
  // Errors stringify back so one broken video doesn't crash the popout.
  const ytHandler = (resultKey, fn) => async (_e, ...args) => {
    try { return { ok: true, [resultKey]: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  };
  ipcMain.handle('yt:search',         ytHandler('results', (q, o) => yt.search(q, o || {})));
  ipcMain.handle('yt:search-general', ytHandler('results', (q, o) => yt.searchGeneral(q, o || {})));
  ipcMain.handle('yt:get-stream',     ytHandler('stream',  (u) => yt.getStreamUrl(u)));
  ipcMain.handle('yt:get-metadata',   ytHandler('meta',    (u) => yt.getMetadata(u)));

  // yt:scrape-page — point yt-dlp at any URL and have it enumerate every
  // video on / linked from that page (works for YouTube channels,
  // playlists, search results, Vimeo lists, Reddit threads, plain
  // <video>-tag pages — anything yt-dlp's ~1800 extractors recognize).
  // `--match-filter "duration>=N"` runs server-side so videos shorter
  // than minDurationSec are dropped before metadata is fully resolved,
  // keeping the wire payload small even for huge channels. Live streams
  // (is_live=true) are excluded — their "duration" is meaningless until
  // they end, and the user is filtering by "> 10 min", which implicitly
  // means finished/recorded content.
  ipcMain.handle('yt:scrape-page', async (_e, opts) => {
    const url    = opts && opts.url;
    const minDur = Math.max(0, (opts && opts.minDurationSec) | 0 || 600);
    if (!url) return { ok: false, error: 'no url' };
    let bin;
    try { bin = yt.resolveBin ? yt.resolveBin() : null; } catch (err) { return { ok: false, error: err.message }; }
    if (!bin) return { ok: false, error: 'yt-dlp binary not found' };
    return await new Promise((resolve) => {
      const args = [
        '--dump-json',
        '--no-warnings',
        '--ignore-errors',
        '--no-call-home',
        '--match-filter', `duration >= ${minDur} & !is_live`,
        url,
      ];
      const proc = spawn(bin, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
      proc.on('close', () => {
        const items = [];
        for (const line of stdout.split('\n')) {
          const s = line.trim();
          if (!s) continue;
          try {
            const o = JSON.parse(s);
            if (!Number.isFinite(o.duration) || o.duration < minDur) continue;
            if (o.is_live) continue;
            items.push({
              id:        o.id || '',
              title:     o.title || o.id || 'untitled',
              url:       o.webpage_url || o.original_url || url,
              duration:  o.duration,
              thumbnail: o.thumbnail || null,
              channel:   o.uploader || o.channel || '',
            });
          } catch {}
        }
        if (items.length === 0 && stderr) {
          // Surface yt-dlp's own diagnostic when zero videos came back —
          // makes "this site isn't supported" failures debuggable instead
          // of mysterious empty results.
          return resolve({ ok: true, items: [], note: stderr.trim().slice(-300) });
        }
        resolve({ ok: true, items });
      });
    });
  });

  // yt:download — download one video to gallery/downloads/. Progress
  // events are streamed back to the calling renderer via
  // 'yt:download-progress' (downloadId + percent + speed + eta) so
  // multiple parallel downloads can update their own rows independently.
  ipcMain.handle('yt:download', async (_e, opts) => {
    const url = opts && opts.url;
    const downloadId = (opts && opts.downloadId) || `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!url) return { ok: false, error: 'no url', downloadId };
    let bin;
    try { bin = yt.resolveBin ? yt.resolveBin() : null; } catch (err) { return { ok: false, error: err.message, downloadId }; }
    if (!bin) return { ok: false, error: 'yt-dlp binary not found', downloadId };
    ensureUserFolders();
    const outDir = downloadsFolderPath();
    return await new Promise((resolve) => {
      const args = [
        '--no-warnings',
        '--no-call-home',
        '--no-playlist',
        '-f', 'bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', path.join(outDir, '%(title).200B [%(id)s].%(ext)s'),
        // Custom progress format that's trivial to parse line-by-line.
        // %(progress.downloaded_bytes)s is in bytes; total may be 0 on
        // some streams when yt-dlp doesn't know the size up front.
        '--progress-template', 'PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s',
        '--newline',
        url,
      ];
      const proc = spawn(bin, args, { windowsHide: true });
      let stderr = '';
      let outPath = null;
      proc.stdout.on('data', (b) => {
        const text = b.toString('utf8');
        for (const line of text.split('\n')) {
          if (line.startsWith('PROG|')) {
            const parts = line.split('|');
            const downloaded = parseInt(parts[1], 10) || 0;
            const total      = parseInt(parts[2], 10) || 0;
            const speed      = parseFloat(parts[3]) || 0;
            const eta        = parseFloat(parts[4]) || 0;
            const percent    = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
            try { _e.sender.send('yt:download-progress', { downloadId, downloaded, total, speed, eta, percent }); } catch {}
            continue;
          }
          // Capture the final on-disk filename for the response.
          let m = line.match(/\[download\] Destination: (.+)$/);
          if (m) outPath = m[1].trim();
          m = line.match(/\[Merger\] Merging formats into "(.+)"/);
          if (m) outPath = m[1].trim();
        }
      });
      proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      proc.on('error', (err) => resolve({ ok: false, error: err.message, downloadId }));
      proc.on('close', (code) => {
        if (code === 0) {
          try { _e.sender.send('yt:download-progress', { downloadId, percent: 100, done: true }); } catch {}
          resolve({ ok: true, path: outPath, downloadId });
        } else {
          resolve({ ok: false, error: stderr.trim().slice(-300) || `yt-dlp exit ${code}`, downloadId });
        }
      });
    });
  });

  ipcMain.handle('toggle-fullscreen', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    // When leaving fullscreen, snap back to the work area so the taskbar
    // stays visible (the original "below everything but not over the taskbar"
    // intent).
    if (!next) win.setBounds(getWorkArea());
    return next;
  });

}

// ─── DISK I/O ──────────────────────────────────────────────────────

async function getDiskIo() {
  const empty = { readSec: 0, writeSec: 0, transferSec: 0, queue: 0, supported: false };
  if (process.platform !== 'win32') return empty;
  const ps = `Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Ignore | Select-Object DiskReadBytesPersec,DiskWriteBytesPersec,DiskTransfersPersec,CurrentDiskQueueLength | ConvertTo-Json -Compress`;
  const obj = await runPowerShell(ps, { timeout: 4000 });
  if (!obj) return empty;
  return {
    readSec:     Number(obj.DiskReadBytesPersec)    || 0,
    writeSec:    Number(obj.DiskWriteBytesPersec)   || 0,
    transferSec: Number(obj.DiskTransfersPersec)    || 0,
    queue:       Number(obj.CurrentDiskQueueLength) || 0,
    supported: true,
  };
}

// Power profile lives in services/power now (Windows + Linux backends).

// ─── AZURE OPENAI AUTO-CONFIG ──────────────────────────────────────
// Auto-discover Azure OpenAI config from the user's `az` CLI login.
// Falls back gracefully with a clear error if `az` isn't installed or the
// user isn't logged in.
async function azureAutoConfig() {
  function azCmd(args) {
    return new Promise((resolve, reject) => {
      exec(`az ${args}`, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message || '').toString();
            if (err.code === 'ENOENT' || /not recognized|not found/i.test(msg)) {
              return reject(new Error('Azure CLI not installed. Install from https://aka.ms/install-az-cli'));
            }
            if (/please run.*az login|run.*az login/i.test(msg)) {
              return reject(new Error('Run: az login'));
            }
            return reject(new Error(msg.split('\n')[0].slice(0, 200) || 'az failed'));
          }
          resolve(stdout);
        });
    });
  }

  try {
    const listJson = await azCmd(`cognitiveservices account list --query "[?kind=='OpenAI']" -o json`);
    const resources = JSON.parse(listJson);
    if (!Array.isArray(resources) || resources.length === 0) {
      return { error: 'No Azure OpenAI resources in this subscription.' };
    }
    const r = resources[0];
    const name = r.name;
    const rg   = r.resourceGroup;
    const endpoint = (r.properties?.endpoint || `https://${name}.openai.azure.com/`).replace(/\/+$/, '');

    const keysJson = await azCmd(`cognitiveservices account keys list --name "${name}" --resource-group "${rg}" -o json`);
    const keys = JSON.parse(keysJson);
    const key = keys.key1 || keys.key2 || '';
    if (!key) return { error: 'Could not retrieve API key.' };

    const depJson = await azCmd(`cognitiveservices account deployment list --name "${name}" --resource-group "${rg}" -o json`);
    const deployments = JSON.parse(depJson);
    if (!Array.isArray(deployments) || deployments.length === 0) {
      return {
        endpoint, key, deployment: '', apiVersion: '2024-10-21',
        resourceCount: resources.length, deploymentCount: 0,
        warning: `Resource '${name}' has no deployments. Create one in the Azure portal.`,
      };
    }
    // Prefer chat-capable deployments if any (heuristic: model name contains 'gpt')
    const chatDep = deployments.find(d => /gpt/i.test(d.properties?.model?.name || d.name)) || deployments[0];
    return {
      endpoint,
      deployment: chatDep.name,
      key,
      apiVersion: '2024-10-21',
      resourceCount: resources.length,
      deploymentCount: deployments.length,
      resourceName: name,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── LAN HTTP server ─────────────────────────────────────────────────────────
// Exposes the same operations as the IPC handlers as JSON HTTP endpoints, and
// serves the built dist/ as static files. Lets you load the dashboard on
// another device (iPad, phone, laptop) at http://<LAN-IP>:7373.
// ─── HTTP SERVER (LAN / iPad) ──────────────────────────────────────
// Serves dist/ statically + JSON API mirrors of the IPC handlers on
// port 7373 so a browser on the same network can render the dashboard.

function startHttpServer() {
  const distDir = path.join(__dirname, '..', '..', 'dist');
  const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.map':  'application/json',
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleApi(route, req) {
    if (route === '/api/system-info'      && req.method === 'GET') return getSystemInfo();
    if (route === '/api/storage-info'     && req.method === 'GET') return await getStorageInfo();
    if (route === '/api/temps-info'       && req.method === 'GET') return await getTempsInfo();
    if (route === '/api/net-info'         && req.method === 'GET') return await getNetInfo();
    if (route === '/api/disk-info'        && req.method === 'GET') return await getDiskIo();
    if (route === '/api/screen-sources'   && req.method === 'GET') return await getScreenSources();
    if (route === '/api/azure-auto-config'&& req.method === 'GET') return await azureAutoConfig();
    if (route === '/api/config') {
      if (req.method === 'GET')  return await readConfig();
      if (req.method === 'POST') return await writeConfig(JSON.parse(await readBody(req) || '{}'));
    }
    const err = new Error(`unknown route ${req.method} ${route}`);
    err.status = 404;
    throw err;
  }

  function safeJoin(root, p) {
    const out = path.join(root, p);
    return out.startsWith(root) ? out : null;
  }

  async function serveStatic(req, res, route) {
    let rel = decodeURIComponent(route);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = safeJoin(distDir, rel);
    if (!filePath) { res.writeHead(403).end(); return; }
    try {
      const data = await fs.promises.readFile(filePath);
      const type = STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;

    try {
      if (route.startsWith('/api/')) {
        const data = await handleApi(route, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }
      await serveStatic(req, res, route);
    } catch (err) {
      const status = err.status || 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`Dashboard HTTP server listening on 0.0.0.0:${HTTP_PORT}`);
  });
  server.on('error', (err) => {
    console.warn(`HTTP server failed to bind ${HTTP_PORT}:`, err.message);
  });
}

// ─── SYSTEM INFO + SCREEN ──────────────────────────────────────────

function getSystemInfo() {
  const cpus = os.cpus();
  const total = os.totalmem();
  const free = os.freemem();
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() || 'unknown',
    cpuCount: cpus.length,
    cpuTimes: cpus.map(c => c.times),
    totalMem: total,
    freeMem: free,
    usedMem: total - free,
    uptime: os.uptime(),
    loadavg: os.loadavg(),
  };
}

async function getScreenSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  return sources.map(s => ({ id: s.id, name: s.name, displayId: s.display_id }));
}

// ─── CONFIG PERSISTENCE ────────────────────────────────────────────
// Packaged builds keep config in a `userdata/` folder next to the .exe
// so the whole app (incl. user prefs, gallery, docs) is portable — copy
// the folder to a USB stick and it Just Works.
// Dev mode keeps using %APPDATA% so the project tree stays clean.
function portableDataDir() {
  if (app.isPackaged) {
    const dir = path.join(path.dirname(app.getPath('exe')), 'userdata');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }
  return app.getPath('userData');
}

function configFilePath() {
  return path.join(portableDataDir(), 'config.json');
}

// Bundled defaults (next to main.js). Loaded once and merged under each
// readConfig() result so a fresh install boots with the shipped layout
// while any subsequent user edit overrides per-key.
let _bundledDefaults = null;
function loadBundledDefaults() {
  if (_bundledDefaults) return _bundledDefaults;
  try {
    const file = path.join(__dirname, 'default-config.json');
    const buf = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(buf);
    _bundledDefaults = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    _bundledDefaults = {};
  }
  return _bundledDefaults;
}

async function readConfig() {
  const defaults = loadBundledDefaults();
  let user = {};
  try {
    const buf = await fs.promises.readFile(configFilePath(), 'utf8');
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === 'object') user = parsed;
  } catch { /* no user config yet — defaults only */ }
  // Shallow merge: user's per-key value wins over the bundled default.
  // Sub-objects (panelSizes, collapsed, etc.) are written atomically by
  // the renderer (read-modify-write the whole sub-object on each save),
  // so deep-merge isn't needed.
  return { ...defaults, ...user };
}

async function writeConfig(partial) {
  if (!partial || typeof partial !== 'object') return await readConfig();
  const cur = await readConfig();
  const next = { ...cur, ...partial };
  const file = configFilePath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ─── TEMPS + GPU SENSORS ───────────────────────────────────────────
// Multi-source fallback chain: systeminformation → nvidia-smi → LHM/OHM
// WMI namespace. Each later source fills in fields the earlier ones
// missed.

async function getTempsInfo() {
  const result = { cpu: null, cpuPower: null, gpus: [], sources: [] };

  // Primary: systeminformation
  try {
    const cpuTemp = await si.cpuTemperature();
    if (cpuTemp && Number.isFinite(cpuTemp.main) && cpuTemp.main > 0) {
      result.cpu = cpuTemp.main;
      result.sources.push('si:cpu');
    }
  } catch {}
  try {
    const graphics = await si.graphics();
    const ctrls = graphics?.controllers || [];
    result.gpus = ctrls.map((c, i) => ({
      index: i,
      // Vendor lets us route the right fallback data to the right GPU
      // — nvidia-smi only knows about NVIDIA cards, and on a mixed
      // Intel iGPU + NVIDIA dGPU system the nvidia-smi result must
      // not be merged into the Intel row.
      vendor: (c.vendor || '').toLowerCase(),
      name: c.model || c.vendor || `GPU ${i}`,
      temp: Number.isFinite(c.temperatureGpu) && c.temperatureGpu > 0 ? c.temperatureGpu : null,
      load: Number.isFinite(c.utilizationGpu) ? c.utilizationGpu : null,
      // si returns memory in MB; normalize to bytes for the renderer.
      memUsed:  Number.isFinite(c.memoryUsed)  && c.memoryUsed  > 0 ? c.memoryUsed  * 1024 * 1024 : null,
      memTotal: Number.isFinite(c.memoryTotal) && c.memoryTotal > 0 ? c.memoryTotal * 1024 * 1024 : null,
      power:    Number.isFinite(c.powerDraw) && c.powerDraw > 0 ? c.powerDraw : null,
    }));
    if (result.gpus.some(g => g.temp != null)) result.sources.push('si:gpu');
  } catch {}

  // Fallback 1: nvidia-smi (more reliable than si for NVIDIA cards).
  // Match nv results to the NVIDIA-vendor entries in result.gpus by
  // enumeration order — NOT by array index. On Intel+NVIDIA systems
  // result.gpus[0] is the Intel iGPU and merging nv[0] into it would
  // overwrite the iGPU's (mostly null) fields with the 4090's data,
  // making both rows identical.
  if (result.gpus.length === 0 || result.gpus.some(g => g.temp == null || g.memUsed == null)) {
    const nv = await tryNvidiaSmi();
    if (nv?.length) {
      const nvIndices = result.gpus
        .map((g, i) => /nvidia/i.test(g.vendor) || /nvidia|geforce|quadro|rtx|gtx/i.test(g.name || '') ? i : -1)
        .filter((i) => i >= 0);
      for (let j = 0; j < nv.length; j++) {
        const targetIdx = j < nvIndices.length ? nvIndices[j] : result.gpus.length;
        if (!result.gpus[targetIdx]) {
          result.gpus[targetIdx] = {
            index: targetIdx, vendor: 'nvidia', name: nv[j].name,
            temp: nv[j].temp, load: nv[j].util,
            memUsed: nv[j].memUsed, memTotal: nv[j].memTotal,
            power: nv[j].power,
          };
        } else {
          if (result.gpus[targetIdx].temp     == null) result.gpus[targetIdx].temp     = nv[j].temp;
          if (result.gpus[targetIdx].load     == null) result.gpus[targetIdx].load     = nv[j].util;
          if (result.gpus[targetIdx].memUsed  == null) result.gpus[targetIdx].memUsed  = nv[j].memUsed;
          if (result.gpus[targetIdx].memTotal == null) result.gpus[targetIdx].memTotal = nv[j].memTotal;
          if (result.gpus[targetIdx].power    == null) result.gpus[targetIdx].power    = nv[j].power;
          if (!result.gpus[targetIdx].name || /unknown/i.test(result.gpus[targetIdx].name)) result.gpus[targetIdx].name = nv[j].name;
        }
      }
      result.sources.push('nvidia-smi');
    }
  }

  // Fallback 2: native sensors service. On Windows this is a multi-
  // probe non-elevated reader: ACPI thermal zones for CPU temp,
  // `\Power Meter(*)\Power` for CPU watts (RAPL via the Windows Energy
  // Estimation engine when available). Only fires when si left those
  // fields null. GPU temp/power isn't covered here; NVIDIA users get
  // it from nvidia-smi above, others gracefully degrade to null.
  if (result.cpu == null || result.cpuPower == null) {
    const native = await sensorsService.getNativeFallback();
    if (native?.cpu != null && result.cpu == null) {
      result.cpu = native.cpu;
      result.sources.push('acpi:cpu');
    }
    if (native?.cpuPower != null && result.cpuPower == null) {
      result.cpuPower = native.cpuPower;
      result.sources.push('acpi:cpuPower');
    }
  }

  return result;
}

function tryNvidiaSmi() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const out = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
          const parts = l.split(',').map(p => p.trim());
          // memory.used / memory.total are in MiB; normalize to bytes.
          const memUsedMiB  = parseInt(parts[4], 10);
          const memTotalMiB = parseInt(parts[5], 10);
          const powerW = parseFloat(parts[6]);
          return {
            index: parseInt(parts[0], 10) || 0,
            name:  parts[1] || 'NVIDIA',
            temp:  parseInt(parts[2], 10),
            util:  parseInt(parts[3], 10),
            memUsed:  Number.isFinite(memUsedMiB)  ? memUsedMiB  * 1024 * 1024 : null,
            memTotal: Number.isFinite(memTotalMiB) ? memTotalMiB * 1024 * 1024 : null,
            power:    Number.isFinite(powerW)      ? powerW      : null,
          };
        }).filter(g => Number.isFinite(g.temp));
        resolve(out);
      }
    );
  });
}

// LHM HTTP + WMI fallback moved to services/sensors/win.js.

// ─── NETWORK STATS ─────────────────────────────────────────────────

let _defaultIface = null;
async function getNetInfo() {
  try {
    if (!_defaultIface) {
      _defaultIface = await si.networkInterfaceDefault();
    }
    // Pass empty string to query all interfaces; first call seeds the rate baseline.
    const stats = await si.networkStats('*');
    const arr = Array.isArray(stats) ? stats : [stats];
    const real = arr.filter(s =>
      s && s.iface &&
      !/^lo$|loopback|isatap|teredo|virtual|vethernet|hyper-v|vmware|vbox/i.test(s.iface)
    );
    let rxSec = 0, txSec = 0, rxTotal = 0, txTotal = 0;
    for (const s of real) {
      if (Number.isFinite(s.rx_sec) && s.rx_sec > 0) rxSec += s.rx_sec;
      if (Number.isFinite(s.tx_sec) && s.tx_sec > 0) txSec += s.tx_sec;
      if (Number.isFinite(s.rx_bytes)) rxTotal += s.rx_bytes;
      if (Number.isFinite(s.tx_bytes)) txTotal += s.tx_bytes;
    }
    return {
      iface: _defaultIface || (real[0]?.iface) || null,
      rxSec, txSec, rxTotal, txTotal,
      interfaces: real.length,
    };
  } catch (err) {
    return { iface: null, rxSec: 0, txSec: 0, rxTotal: 0, txTotal: 0, interfaces: 0, error: err.message };
  }
}

// ─── STORAGE ───────────────────────────────────────────────────────
// Win32_LogicalDisk + Win32_MappedLogicalDisk + PSDrive union on
// Windows; statvfs probes via the `df` command on POSIX as a fallback.

async function getStorageInfo() {
  if (process.platform === 'win32') {
    return await getStorageWindows();
  }
  return await getStoragePosix();
}

async function getStorageWindows() {
  const ps = `
$logical = Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue |
  Select-Object DeviceID,DriveType,FreeSpace,Size,VolumeName,ProviderName
$mapped = Get-CimInstance Win32_MappedLogicalDisk -ErrorAction SilentlyContinue |
  Select-Object DeviceID,FreeSpace,Size,VolumeName,ProviderName
$seen = @{}
$out = @()
foreach ($d in $logical) {
  if ($d.DeviceID -and -not $seen.ContainsKey($d.DeviceID)) {
    $seen[$d.DeviceID] = $true
    $out += $d
  }
}
foreach ($d in $mapped) {
  if ($d.DeviceID -and -not $seen.ContainsKey($d.DeviceID)) {
    $seen[$d.DeviceID] = $true
    $d | Add-Member -NotePropertyName DriveType -NotePropertyValue 4 -Force
    $out += $d
  }
}
$psd = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^[A-Za-z]$' }
foreach ($d in $psd) {
  $id = ($d.Name + ':')
  if (-not $seen.ContainsKey($id)) {
    $seen[$id] = $true
    $size = if ($d.Used -ne $null -and $d.Free -ne $null) { [int64]$d.Used + [int64]$d.Free } else { 0 }
    $out += [pscustomobject]@{
      DeviceID = $id
      DriveType = 0
      FreeSpace = $d.Free
      Size = $size
      VolumeName = $d.Description
      ProviderName = $d.DisplayRoot
    }
  }
}
ConvertTo-Json -Compress -Depth 3 $out
  `.trim();
  let arr = await runPowerShell(ps, { timeout: 6000 });
  if (arr == null) return getStorageFromStatfs();
  if (!Array.isArray(arr)) arr = [arr];
  return arr
    .filter(d => d && d.DeviceID)
    .map(d => {
      const total = Number(d.Size) || 0;
      const free  = Number(d.FreeSpace) || 0;
      const driveType = Number(d.DriveType) || 0;
      const provider = d.ProviderName || null;
      const label = d.VolumeName ||
        (provider ? provider.replace(/^\\\\/, '').split(/[\\\\\/]/)[0] : '');
      return {
        mount: d.DeviceID,
        label,
        type: driveTypeName(driveType),
        total,
        free,
        used: total > 0 ? total - free : 0,
        provider,
      };
    });
}

function driveTypeName(t) {
  switch (t) {
    case 2: return 'Removable';
    case 3: return 'Local';
    case 4: return 'Network';
    case 5: return 'CD/DVD';
    case 6: return 'RAM';
    default: return 'Unknown';
  }
}

async function getStoragePosix() {
  if (typeof fs.statfs !== 'function') return [];
  const mounts = ['/'];
  const results = [];
  for (const m of mounts) {
    try {
      const s = await fs.promises.statfs(m);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      results.push({ mount: m, label: '', type: 'Local', total, free, used: total - free });
    } catch {}
  }
  return results;
}

async function getStorageFromStatfs() {
  if (typeof fs.statfs !== 'function') return [];
  const drives = ['C:\\', 'D:\\', 'E:\\', 'F:\\'];
  const results = [];
  for (const d of drives) {
    try {
      const s = await fs.promises.statfs(d);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      if (total <= 0) continue;
      results.push({ mount: d.replace(/\\$/, ''), label: '', type: 'Local', total, free, used: total - free });
    } catch {}
  }
  return results;
}
