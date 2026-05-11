const { app, BrowserWindow, BrowserView, ipcMain, screen, session, desktopCapturer, utilityProcess, shell, protocol, net } = require('electron');
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
    },
  });

  _mainWin = win;
  win.on('closed', () => { _mainWin = null; });

  win.removeMenu();

  // F12 → toggle DevTools (handy for diagnosing renderer errors when the
  // window is borderless and can't be right-clicked).
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
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

  const _bottomInterval = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(_bottomInterval); return; }
    sendToBottom(win);
  }, 1000);

  // Bump the renderer zoom 20% to compensate for force-device-scale-factor=1
  // making everything render at native pixel sizes (which is too small on a
  // HiDPI display). Set on every load so it survives renderer reloads.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(1.2));

  // Native WASAPI loopback for the default output device. Pushes per-frame
  // RMS levels to the renderer over IPC ('audio-out-level'). readConfig is
  // passed in so the service can honor the persisted audioDeviceId without
  // taking a direct dependency on our config module.
  win.webContents.once('did-finish-load', () => audioService.startLoopback(win, null, readConfig));
  win.on('closed', () => audioService.stopLoopback());
}

// ─── YOUTUBE POPOUT ────────────────────────────────────────────────
// Borderless always-on-top webview pointing at youtube.com. Sign-in
// persists via the session partition; CSS is injected on /watch URLs to
// turn it into a video-only PIP.
let _ytWin = null;
function openYouTubeWindow() {
  if (_ytWin && !_ytWin.isDestroyed()) {
    _ytWin.show();
    _ytWin.focus();
    return;
  }
  _ytWin = new BrowserWindow({
    // Default to 720p so YouTube's initial quality-detection sees a player
    // big enough to serve 1080p when manually selected. Smaller windows
    // (e.g., 640x360) make YouTube cap auto-quality at 720p and sometimes
    // hide higher options entirely.
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
    // as "occluded" or backgrounded and drop its frame rate to ~1 Hz,
    // which is the stutter the user was seeing. paintWhenInitiallyHidden
    // covers the launch case; backgroundThrottling kills runtime throttle.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'youtube-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  _ytWin.removeMenu();
  // Esc handler: if the dashboard is in zen, leave zen (and let zen's
  // own teardown restore this window). Otherwise close the window.
  const handleEsc = () => {
    if (_zenIsActiveInMain && _audioWin && !_audioWin.isDestroyed()) {
      _audioWin.webContents.send('force-leave-zen');
      return;
    }
    _ytWin?.close();
  };
  _ytWin.webContents.on('did-attach-webview', (_e, wvc) => {
    // Webview is a separate webContents — host-level backgroundThrottling
    // doesn't propagate. Disable explicitly so video decode keeps full
    // frame rate when the host window goes transparent in zen.
    try { wvc.setBackgroundThrottling(false); } catch {}
    try { wvc.setFrameRate(60); } catch {}
    // Force a clean Chrome desktop UA — the <webview useragent="..."> attr
    // doesn't always apply on the very first navigation, and YouTube uses
    // both the UA string and Sec-CH-UA client hints to gate quality. The
    // Electron substring in the default UA gets us downgraded to 720p
    // even on Premium accounts.
    // Use a specific real Chrome build number (not "0.0.0"). Some
    // back-end checks compare the UA version to the Sec-CH-UA-Full-Version
    // value and reject obvious placeholders.
    const CHROME_FULL = '130.0.6723.92';
    const CHROME_MAJOR = '130';
    const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
    try { wvc.setUserAgent(CHROME_UA); } catch {}
    // Override the full Sec-CH-UA family on every request so YouTube's
    // fingerprint reads as a stock Windows desktop Chrome. Without these
    // fields YouTube can still detect "embedded client" and downgrade
    // quality even on Premium accounts.
    try {
      wvc.session.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = details.requestHeaders;
        h['User-Agent']                  = CHROME_UA;
        h['sec-ch-ua']                   = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="99"`;
        h['sec-ch-ua-mobile']            = '?0';
        h['sec-ch-ua-platform']          = '"Windows"';
        h['sec-ch-ua-platform-version']  = '"15.0.0"';
        h['sec-ch-ua-arch']              = '"x86"';
        h['sec-ch-ua-bitness']           = '"64"';
        h['sec-ch-ua-model']             = '""';
        h['sec-ch-ua-wow64']             = '?0';
        h['sec-ch-ua-full-version']      = `"${CHROME_FULL}"`;
        h['sec-ch-ua-full-version-list'] = `"Chromium";v="${CHROME_FULL}", "Google Chrome";v="${CHROME_FULL}", "Not?A_Brand";v="99.0.0.0"`;
        cb({ requestHeaders: h });
      });
    } catch {}
    wvc.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') handleEsc();
    });
  });
  // Lock the *content* to exact 16:9. setAspectRatio is the native lock;
  // will-resize / resize fallbacks correct any rounding drift on Windows
  // where the OS occasionally lets a non-conforming size through.
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
  _ytWin.on('closed', () => { _ytWin = null; _ytPreZenBounds = null; });
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
    // opacity now relies on the anti-throttle stack (no native fullscreen,
    // backgroundThrottling off on host + webview, occlusion-detection
    // disabled, document.hidden stubbed in the page).
    if (!_ytPreZenBounds) _ytPreZenBounds = _ytWin.getBounds();
    const display = screen.getDisplayMatching(_ytWin.getBounds());
    _ytWin.setBounds(display.bounds);
    _ytWin.setOpacity(0.05);
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
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Block all media autoplay across every renderer. Hero videos that loop
// behind a page's first viewport are a major contributor to "open the
// browser → fans rev" — autoplay-policy stops them until the user clicks.
// The user can still tap play on any video they want to watch.
app.commandLine.appendSwitch('autoplay-policy', 'document-user-activation-required');
// Smooth scrolling is GPU-accelerated and runs an animation curve on every
// scroll. We don't want any of it in this pane — instant scroll is fine.
app.commandLine.appendSwitch('disable-smooth-scrolling');

// Force the renderer to a 1× device scale factor regardless of the OS
// display scaling. On a HiDPI / 200%-scaled monitor this drops the GPU
// fill cost by ~4× (paints 2560×1440 instead of 5120×2880). UI looks
// slightly softer than native @2x but the entire compositor — animations,
// panel pulses, grid overlay, webview, audio canvases — gets cheaper.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Embedded BROWSER pane dark mode: nativeTheme.themeSource = 'dark' is
// set in app.whenReady(). Sites that respect prefers-color-scheme go
// dark. Sites that don't (legacy light-only) stay light — Chromium's
// WebContentsForceDark feature flag mangles enough sites' stylesheet
// rendering that we don't enable it. Per-webview CSS injection is the
// safer future path if force-dark is required.

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
  // partition="dash-browser" so this session is what services its
  // requests. No persist: prefix → cookies, cache, and history die when
  // the dashboard closes. The blocklist is a substring match against the
  // request URL; it's not a full ABP engine but it cuts the obvious
  // surveillance + ad networks.
  const _BROWSER_PARTITION = 'dash-browser';
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
  ];
  const browserSession = session.fromPartition(_BROWSER_PARTITION);
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
          adsBlocked: _adsBlocked,
          imagesBlocked: _imagesBlocked,
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
  ipcMain.handle('browser-get-stats', () => ({ adsBlocked: _adsBlocked, imagesBlocked: _imagesBlocked }));
  ipcMain.handle('browser-reset-stats', () => {
    _adsBlocked = 0;
    _imagesBlocked = 0;
    _statsDirty = true;
    _broadcastBrowserStats();
    return { adsBlocked: 0, imagesBlocked: 0 };
  });
  ipcMain.handle('browser-set-reader-mode', (_e, on) => { _readerMode = !!on; return { ok: true, readerMode: _readerMode }; });

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
  // We previously used the <webview> tag for embedded pages, but its
  // shadow-DOM upgrade was failing in our combo-pane layout and dumping
  // raw <style>/<script> source text into the page. BrowserView is the
  // stable, well-supported alternative: a real native view attached to
  // the BrowserWindow, positioned by setBounds, controlled entirely from
  // the main process. Each "tab" the renderer creates maps to a
  // BrowserView. The renderer sends a target rectangle and which tab is
  // active; main handles the rest. Page-load events are forwarded back
  // over the 'browser-tab-event' channel so the renderer can keep its
  // chrome (URL bar, title, back/forward enable state) in sync.
  const _bvTabs = new Map(); // id → { view, url, title, loading, canBack, canFwd }
  let _bvNextId = 1;
  let _bvActiveId = null;
  let _bvBounds = { x: 0, y: 0, width: 0, height: 0 };
  // (Earlier revisions injected a CLEAN_CSS rule that hid anything with
  // "cookie" / "consent" / "gdpr" / "newsletter-modal" in its class or id.
  // Those substrings turned out to be far too broad — frameworks like
  // Liferay use class names like "cookie-policy-notice-cmp" on real
  // structural elements, and hiding them broke the page. Trackers are
  // already cut at the network layer; we no longer touch the DOM.)

  function _sendTabEvent(payload) {
    if (_mainWin && !_mainWin.isDestroyed()) {
      _mainWin.webContents.send('browser-tab-event', payload);
    }
  }
  // App-level catch-all for popup blocking. setWindowOpenHandler on the
  // BrowserView's top webContents only covers same-frame window.open;
  // iframes embedded inside the page (Google "Sign in with Google",
  // YouTube embed widgets, social share buttons, etc) are SEPARATE
  // webContents with their own popup paths. Without this, a click on a
  // target=_blank link inside an iframe slips past per-view handlers and
  // Electron spawns a fresh BrowserWindow. Filtering by session keeps the
  // policy scoped to the embedded browser — the dashboard's own renderer
  // (different session) is untouched.
  // Popup policy: send the URL back to the renderer as a "new tab"
  // request. Renderer spawns a fresh BrowserView tab so the original
  // page stays put on its own tab — better UX than navigating in-place,
  // which loses the context the user came from. Also catches popups
  // from iframes (Google "Sign in with Google", embed widgets, social
  // buttons) since those are separate webContents with their own
  // window-open paths.
  function _requestNewTab(url) {
    if (!url) return;
    if (!_mainWin || _mainWin.isDestroyed()) return;
    try { _mainWin.webContents.send('browser-newtab-request', url); } catch {}
  }
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session !== browserSession) return;
    contents.setWindowOpenHandler(({ url }) => {
      _requestNewTab(url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (newWin, details) => {
      try { newWin.close(); } catch {}
      _requestNewTab(details && details.url);
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
  function _wireBvEvents(id, view) {
    const wc = view.webContents;
    // Halve the compositor's frame budget for embedded pages. With every
    // animation/transition stripped by CSS injection, 60 fps would just be
    // re-compositing the same pixels — 30 fps stays smooth for scroll and
    // saves real GPU time. The YouTube popout's webContents uses its own
    // setFrameRate(60), unaffected.
    try { wc.setFrameRate(30); } catch {}
    wc.on('dom-ready', () => {
      try { wc.insertCSS(_PAGE_STYLE_CSS); } catch {}
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
      _sendTabEvent({ id, type: 'navigate', url });
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (!isMain) return;
      const t = _bvTabs.get(id); if (!t) return;
      t.url = url;
      _sendTabEvent({ id, type: 'navigate', url });
    });
    wc.on('page-title-updated', (_e, title) => {
      const t = _bvTabs.get(id); if (!t) return;
      t.title = title || t.url;
      _sendTabEvent({ id, type: 'title', title: t.title });
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      _sendTabEvent({ id, type: 'fail', url, code, desc });
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
      const html = await _browserFetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=videos&ia=videos`);
      const m = html.match(/vqd=(?:["']([\d-]+)["']|([\d-]+))/);
      const vqd = m ? (m[1] || m[2]) : null;
      if (!vqd) return { ok: false, kind: 'videos', error: 'NO VQD TOKEN' };
      // v.js uses the same query-shape as i.js. Page size on DDG's video
      // endpoint is roughly 60; offset = (page-1) * 60.
      const start = (Math.max(1, page || 1) - 1) * 60;
      const apiUrl = `https://duckduckgo.com/v.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1&s=${start}`;
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
      const html = await _browserFetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`);
      // Token formats DDG has shipped: vqd='3-1234-5678', vqd="3-1234",
      // vqd=3-1234. Match the most common shape.
      const m = html.match(/vqd=(?:["']([\d-]+)["']|([\d-]+))/);
      const vqd = m ? (m[1] || m[2]) : null;
      if (!vqd) return { ok: false, kind: 'images', error: 'NO VQD TOKEN' };
      // DDG's i.js paginates with s=N (start index, 100 per page).
      const start = (Math.max(1, page || 1) - 1) * 100;
      const apiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1&v7exp=a&s=${start}`;
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
  const _WEB_ENGINES = {
    ddg:    (q, p) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` + (p > 1 ? `&s=${(p-1)*30}&dc=${(p-1)*30+1}` : ''),
    bing:   (q, p) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&first=${(p-1)*20+1}&form=QBLH`,
    brave:  (q, p) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web&offset=${p-1}`,
    yahoo:  (q, p) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}&b=${(p-1)*10+1}&fr=yfp-t&fp=1`,
    google: (q, p) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=20&start=${(p-1)*10}&hl=en`,
  };
  async function _browserSearchWebHybrid(q, page) {
    const keys = Object.keys(_WEB_ENGINES);
    const headers = { 'Accept': 'text/html,application/xhtml+xml' };
    const settled = await Promise.allSettled(
      keys.map(k => _browserFetch(_WEB_ENGINES[k](q, page), headers)),
    );
    const html = {};
    const errors = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (settled[i].status === 'fulfilled') html[k] = settled[i].value;
      else errors[k] = String(settled[i].reason?.message || settled[i].reason);
    }
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

  ipcMain.handle('transfers-info', async () => {
    return await getTransfersInfo();
  });

  ipcMain.handle('config-get', () => readConfig());
  ipcMain.handle('config-set', (_e, partial) => writeConfig(partial));
  ipcMain.handle('config-path', () => configFilePath());

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
        const entries = fs.readdirSync(target, { withFileTypes: true });
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

  // Move a file or folder to the OS trash. We use shell.trashItem rather
  // than fs.rmSync so the user can recover from a misclick from Explorer's
  // Recycle Bin without us having to maintain our own undo state.
  ipcMain.handle('explore-delete', async (_e, abs) => {
    const p = path.resolve(String(abs || ''));
    if (!_pathInsideManagedRoot(p)) return { ok: false, error: 'path outside managed roots' };
    if (p === galleryFolderPath() || p === docsFolderPath()) {
      return { ok: false, error: 'cannot delete the managed root itself' };
    }
    try {
      await shell.trashItem(p);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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

  // Fallback 1: nvidia-smi (more reliable than si for NVIDIA cards)
  if (result.gpus.length === 0 || result.gpus.some(g => g.temp == null || g.memUsed == null)) {
    const nv = await tryNvidiaSmi();
    if (nv?.length) {
      for (let i = 0; i < nv.length; i++) {
        if (!result.gpus[i]) {
          result.gpus[i] = {
            index: i, name: nv[i].name,
            temp: nv[i].temp, load: nv[i].util,
            memUsed: nv[i].memUsed, memTotal: nv[i].memTotal,
            power: nv[i].power,
          };
        } else {
          if (result.gpus[i].temp     == null) result.gpus[i].temp     = nv[i].temp;
          if (result.gpus[i].load     == null) result.gpus[i].load     = nv[i].util;
          if (result.gpus[i].memUsed  == null) result.gpus[i].memUsed  = nv[i].memUsed;
          if (result.gpus[i].memTotal == null) result.gpus[i].memTotal = nv[i].memTotal;
          if (result.gpus[i].power    == null) result.gpus[i].power    = nv[i].power;
          if (!result.gpus[i].name || /unknown/i.test(result.gpus[i].name)) result.gpus[i].name = nv[i].name;
        }
      }
      result.sources.push('nvidia-smi');
    }
  }

  // Fallback 2: LHM via HTTP on port 8085 (primary — LHM v0.9.x dropped
  // WMI), then OHM via WMI for older systems still on OHM. HTTP first
  // skips the slow PowerShell WMI query when the patched LHM is up.
  if (result.cpu == null || result.cpuPower == null || result.gpus.some(g => g.temp == null || g.power == null)) {
    const lhm = await sensorsService.getNativeFallback();
    if (lhm) {
      if (result.cpu == null && lhm.cpu != null) {
        result.cpu = lhm.cpu;
        result.sources.push('lhm:cpu');
      }
      if (result.cpuPower == null && lhm.cpuPower != null) {
        result.cpuPower = lhm.cpuPower;
      }
      if (lhm.gpus?.length) {
        let gotGpu = false;
        for (let i = 0; i < lhm.gpus.length; i++) {
          if (result.gpus[i]) {
            if (result.gpus[i].temp  == null && lhm.gpus[i]      != null) { result.gpus[i].temp  = lhm.gpus[i]; gotGpu = true; }
            if (result.gpus[i].power == null && lhm.gpusPower?.[i] != null) result.gpus[i].power = lhm.gpusPower[i];
          }
        }
        if (gotGpu) result.sources.push('lhm:gpu');
      }
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

// ─── TRANSFERS ─────────────────────────────────────────────────────
// Active downloads / file transfers in the user's Downloads folder.
// A file counts as "active" if it either has a partial-download
// extension (browsers / torrent clients write to one of these while
// the bytes are still streaming in) OR it grew between the previous
// poll and this one. Per-file state is kept in TRANSFER_STATE so we
// can compute bytes/sec across polls. Entries are pruned once they
// stop growing for long enough that they're clearly done.
const TRANSFER_STATE = new Map(); // path -> { size, mtimeMs, sampledAt, speed, firstSeen, peakSize }
const TRANSFER_PARTIAL_EXT = /\.(crdownload|part|partial|download|opdownload|tmp|!ut|!qb|bc!|aria2)$/i;
const TRANSFER_STALE_MS    = 8000;   // drop tracked file if untouched this long
const TRANSFER_ACTIVE_MS   = 6000;   // mtime within this window counts as active
const TRANSFER_BITS_EVERY  = 10;     // run Get-BitsTransfer once every N polls (PowerShell startup is slow)
let   TRANSFER_BITS_TICK   = 0;

async function getTransfersInfo() {
  // Filesystem-poll path works on Linux too — the BITS-specific bit was
  // already abstracted out via systemService.getActiveBitsTransfers(),
  // which returns [] on non-Windows. Dropping the early-return guard
  // lets the dashboard's downloads progress UI work on Linux too.
  const dir = path.join(os.homedir(), 'Downloads');
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return []; }

  const now = Date.now();
  const out = [];
  const seenPaths = new Set();

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(dir, ent.name);
    let st;
    try { st = await fs.promises.stat(full); } catch { continue; }
    if (st.size <= 0 && !TRANSFER_PARTIAL_EXT.test(ent.name)) continue;

    seenPaths.add(full);
    const prev = TRANSFER_STATE.get(full);
    const partial = TRANSFER_PARTIAL_EXT.test(ent.name);
    const recent  = (now - st.mtimeMs) < TRANSFER_ACTIVE_MS;
    const grew    = prev ? st.size > prev.size : false;

    // Update tracked state for every observed file so we have a
    // baseline next poll even if it's not active yet.
    let speed = 0;
    if (prev) {
      const dt = (now - prev.sampledAt) / 1000;
      if (dt > 0 && st.size >= prev.size) speed = (st.size - prev.size) / dt;
      // Smooth wildly bursty samples a bit (exp moving average).
      if (prev.speed > 0) speed = prev.speed * 0.5 + speed * 0.5;
    }
    const firstSeen = prev?.firstSeen ?? now;
    const peakSize  = Math.max(prev?.peakSize ?? 0, st.size);
    TRANSFER_STATE.set(full, {
      size: st.size, mtimeMs: st.mtimeMs, sampledAt: now,
      speed, firstSeen, peakSize,
    });

    const isActive = partial || recent || grew || (prev && (now - prev.sampledAt) < TRANSFER_STALE_MS && speed > 0);
    if (!isActive) continue;

    // We have no authoritative "total size" from the filesystem alone
    // (Chrome's .crdownload doesn't expose the Content-Length). We can
    // estimate by holding the largest size seen, which makes the bar
    // grow monotonically. For a true progress %, BITS jobs (below)
    // override this with real BytesTotal.
    const total    = peakSize > st.size ? peakSize : null;
    const progress = total && total > 0 ? Math.min(1, st.size / total) : null;

    out.push({
      id: full,
      name: ent.name,
      kind: partial ? 'download' : 'copy',
      size: st.size,
      total,
      progress,
      speed,
      source: 'Downloads',
      isPartial: partial,
    });
  }

  // Get-BitsTransfer: catches Windows Update + any app routing through
  // BITS. These DO expose a real total → real %. Throttled to one call
  // every TRANSFER_BITS_EVERY polls because PowerShell startup is
  // ~500 ms — running it every poll pegs a CPU core and starves other
  // main-process work.
  try {
    const shouldRunBits = (++TRANSFER_BITS_TICK % TRANSFER_BITS_EVERY) === 1;
    const arr = shouldRunBits ? await systemService.getActiveBitsTransfers() : [];
    for (const j of arr) {
      const tot = Number(j.BytesTotal) || 0;
      const cur = Number(j.BytesTransferred) || 0;
      const prev = TRANSFER_STATE.get('bits:' + j.id);
      let speed = 0;
      if (prev) {
        const dt = (now - prev.sampledAt) / 1000;
        if (dt > 0 && cur >= prev.size) speed = (cur - prev.size) / dt;
        if (prev.speed > 0) speed = prev.speed * 0.5 + speed * 0.5;
      }
      TRANSFER_STATE.set('bits:' + j.id, { size: cur, mtimeMs: now, sampledAt: now, speed, firstSeen: prev?.firstSeen ?? now, peakSize: tot });
      seenPaths.add('bits:' + j.id);
      out.push({
        id: 'bits:' + j.id,
        name: j.DisplayName || 'BITS Transfer',
        kind: 'bits',
        size: cur,
        total: tot > 0 ? tot : null,
        progress: tot > 0 ? Math.min(1, cur / tot) : null,
        speed,
        source: String(j.TransferType || 'BITS').toUpperCase(),
        isPartial: false,
      });
    }
  } catch {}

  // Garbage-collect tracked entries that vanished or went quiet so
  // the Map doesn't grow forever.
  for (const [k, v] of TRANSFER_STATE) {
    if (!seenPaths.has(k) && (now - v.sampledAt) > TRANSFER_STALE_MS) {
      TRANSFER_STATE.delete(k);
    }
  }

  // Active first, by speed.
  out.sort((a, b) => (b.speed || 0) - (a.speed || 0));
  return out;
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
