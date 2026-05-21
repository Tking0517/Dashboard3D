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
const trimService    = require('./services/system/trim');
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
// BrowserView tab registry. Lifted to module scope so the embed-invert
// IPC handler (registered inside registerIpc(), see ~main.js:2441) can
// iterate the tabs to repaint invert. The rest of the BV tab manager
// state (_bvNextId, _bvActiveId, _bvBounds) is fine inside the
// app.whenReady closure where the tab-management code lives — only the
// Map needs to be reachable from registerIpc's scope.
const _bvTabs = new Map(); // id → { view, url, title, loading, canBack, canFwd }
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

  // True-fullscreen for in-page media. When any element calls
  // requestFullscreen() (REC ROOM video player, EXPLORE image/video
  // viewer), the element fills the window — but the window is
  // work-area-sized, resizable:false, and force-demoted to the bottom of
  // the z-order, so it never covers the taskbar or the whole monitor.
  // Driving the window's real fullscreen state off the HTML-fullscreen
  // events needs three things on Windows:
  //   1. resizable must be ON for setFullScreen() to take — flip it for
  //      the duration, restore after.
  //   2. the always-on-bottom demotion (sendToBottom) must be suspended,
  //      or it shoves the fullscreen window behind the desktop.
  //   3. moveTop() to bring it forward on entry.
  // Only restore window state if WE forced it (don't clobber a
  // fullscreen the user set via the topbar toggle).
  let _htmlFsForcedWindow = false;
  let _htmlFsPrevResizable = false;
  win.webContents.on('enter-html-full-screen', () => {
    _mediaFullscreenActive = true;
    if (!win.isFullScreen()) {
      _htmlFsForcedWindow = true;
      _htmlFsPrevResizable = win.isResizable();
      win.setResizable(true);
      win.setFullScreen(true);
    }
    try { win.moveTop(); } catch {}
  });
  win.webContents.on('leave-html-full-screen', () => {
    _mediaFullscreenActive = false;
    if (_htmlFsForcedWindow) {
      _htmlFsForcedWindow = false;
      win.setFullScreen(false);
      win.setResizable(_htmlFsPrevResizable);
      win.setBounds(getWorkArea());
    }
    sendToBottom(win); // re-assert desktop z-order
  });

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

// Set true while in-page media (video/image) is fullscreen — suspends
// the always-on-bottom demotion so the fullscreen window stays on top.
let _mediaFullscreenActive = false;
function sendToBottom(win) {
  if (_mediaFullscreenActive) return;
  wmService.sendToBottom(win);
}

app.on('before-quit', () => {
  audioService.stopLoopback();
  wmService.shutdown();
  _stopKeyHook();
  _stopLhmSupervisor();
});

// ─── LHM SUPERVISOR (bundled sensor backend) ────────────────────────
// LibreHardwareMonitor lives in vendor/lhm/. We spawn it as a hidden
// child process on app ready, write a minimal config XML so it boots
// with the HTTP server on port 8085 + minimized to tray, then chase
// down its main window with ShowWindow(SW_HIDE) so no taskbar entry
// remains. The renderer keeps polling localhost:8085/data.json — same
// path it used when the user managed LHM themselves.
//
// Stealth caveat: LHM always creates a tray icon. Hiding it fully
// requires a Shell_NotifyIcon(NIM_DELETE) injected into LHM's process
// — out of scope for this stage. The tray icon stays visible; the
// main window does not. Killing happens in before-quit above.
// Single canonical path for the LHM bundle: <userFoldersBase>/vendor/lhm/.
// In dev that's <project>/vendor/lhm/; in packaged builds it's
// <exeDir>/vendor/lhm/ — same folder the manual drop instructions
// point at. Auto-download writes here too, so there is one obvious
// place to look whether LHM was hand-installed or fetched by the
// dashboard.
function _lhmDir() {
  return path.join(userFoldersBase(), 'vendor', 'lhm');
}
function _lhmExePath() {
  return path.join(_lhmDir(), 'LibreHardwareMonitor.exe');
}
function _lhmConfigPath() {
  // LHM's PersistentSettings reads/writes LibreHardwareMonitor.config
  // (a SEPARATE file from LibreHardwareMonitor.exe.config). The .exe
  // .config is the standard .NET application config — touching it
  // requires a matching <configSections> declaration or .NET refuses
  // to load. The PersistentSettings file uses a simple <appSettings>
  // <add key="..." value="..."/></appSettings> format that LHM owns
  // entirely, so we can write it freely without breaking the .NET
  // runtime binding.
  return path.join(_lhmDir(), 'LibreHardwareMonitor.config');
}

// ── Auto-installer: fetch latest LHM release from GitHub ────────────
// Hits the public releases API (no token needed), picks the first .zip
// asset, follows the redirect to the CDN, downloads to a temp file,
// extracts with the built-in tar.exe (Windows 10 1803+) which handles
// zip natively. Returns true if LHM is present on disk after this
// runs (whether it was just installed or already there).
function _httpsGetFollow(url, headers, opts) {
  // Single-shot HTTPS GET that follows up to 5 redirects. Resolves
  // with the final response stream so the caller can pipe it. The
  // opts.binary flag toggles between buffering text and exposing the
  // raw response.
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (u) => {
      if (++hops > 6) return reject(new Error('too many redirects'));
      const https = require('https');
      const parsed = new URL(u);
      const req = https.get({
        host: parsed.host,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'Dashboard3D/0.9 (+lhm-installer)', ...(headers || {}) },
        timeout: 30_000,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return go(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        resolve(res);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    };
    go(url);
  });
}
async function _lhmEnsureInstalled() {
  if (process.platform !== 'win32') return false;
  // Already installed (manual or auto) — nothing to do.
  if (fs.existsSync(_lhmExePath())) return true;
  console.log('[lhm] installing — fetching latest release from GitHub…');
  const apiUrl = 'https://api.github.com/repos/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest';
  let zipUrl = null;
  try {
    const res = await _httpsGetFollow(apiUrl, { Accept: 'application/vnd.github+json' });
    let buf = '';
    res.setEncoding('utf8');
    for await (const chunk of res) buf += chunk;
    const data = JSON.parse(buf);
    // LHM ships two zips per release: the .NET Framework 4.7.2 build
    // (`LibreHardwareMonitor.zip`, smaller, works with Windows' built-
    // in .NET) and the .NET 10 build (`LibreHardwareMonitor.NET.10.zip`
    // — needs the .NET 10 runtime separately installed). Strongly
    // prefer the FW build so first-launch doesn't fail on machines
    // that don't have .NET 10. Fall back to any .zip if the names
    // change in a future release.
    const zips = (data.assets || []).filter((a) => /\.zip$/i.test(a.name));
    const asset =
      zips.find((a) => /^LibreHardwareMonitor\.zip$/i.test(a.name)) ||
      zips.find((a) => !/\.net\.?\d+\.zip$/i.test(a.name)) ||
      zips[0] ||
      (data.assets || [])[0];
    if (!asset?.browser_download_url) throw new Error('no zip asset in latest release');
    zipUrl = asset.browser_download_url;
    console.log('[lhm] release:', data.tag_name, 'asset:', asset.name, 'size:', asset.size);
  } catch (err) {
    console.warn('[lhm] release lookup failed:', err.message);
    return false;
  }
  // Download to a temp file. Stream-pipe so we don't buffer the entire
  // zip in memory (~10–15 MB is fine either way, but the stream form
  // is more honest).
  const tmpZip = path.join(app.getPath('temp'), `dash3d-lhm-${Date.now()}.zip`);
  try {
    const res = await _httpsGetFollow(zipUrl);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpZip);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.on('error', reject);
    });
    console.log('[lhm] downloaded to', tmpZip);
  } catch (err) {
    console.warn('[lhm] download failed:', err.message);
    try { fs.unlinkSync(tmpZip); } catch {}
    return false;
  }
  // Extract via tar.exe (Windows 10 1803+ ships it). Handles .zip
  // natively. Target dir is created fresh so old partial installs
  // don't linger.
  const destDir = _lhmDir();
  try {
    fs.mkdirSync(destDir, { recursive: true });
    await new Promise((resolve, reject) => {
      const proc = spawn('tar.exe', ['-xf', tmpZip, '-C', destDir], { windowsHide: true });
      let stderr = '';
      proc.stderr?.on('data', (c) => stderr += c.toString());
      proc.on('error', reject);
      proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exit ${code}: ${stderr.slice(-200)}`)));
    });
    console.log('[lhm] extracted to', destDir);
  } catch (err) {
    console.warn('[lhm] extract failed:', err.message);
    try { fs.unlinkSync(tmpZip); } catch {}
    return false;
  }
  try { fs.unlinkSync(tmpZip); } catch {}
  // Some LHM zips have a top-level folder (e.g. "LibreHardwareMonitor/")
  // while others have files at the root. If the exe didn't land at
  // <destDir>/LibreHardwareMonitor.exe, find it one level deep and
  // flatten the structure so our spawn path resolves.
  if (!fs.existsSync(path.join(destDir, 'LibreHardwareMonitor.exe'))) {
    try {
      for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(destDir, entry.name);
        if (!fs.existsSync(path.join(sub, 'LibreHardwareMonitor.exe'))) continue;
        for (const f of fs.readdirSync(sub)) {
          fs.renameSync(path.join(sub, f), path.join(destDir, f));
        }
        try { fs.rmdirSync(sub); } catch {}
        break;
      }
    } catch (err) {
      console.warn('[lhm] flatten failed:', err.message);
    }
  }
  return fs.existsSync(_lhmExePath());
}
function _lhmWriteStealthConfig() {
  // Write LHM's PersistentSettings file (LibreHardwareMonitor.config,
  // not LibreHardwareMonitor.exe.config!). LHM reads this on launch
  // with its own XML parser that expects <appSettings><add key=…
  // value=…/></appSettings>. We set the keys that make LHM run
  // hidden + serve the HTTP API:
  //   runWebServerMenuItem  → turns the listener on
  //   listenerPort          → port the listener binds (matches our
  //                            renderer's poll URL)
  //   minTrayMenuItem       → close button minimizes to tray
  //   startMinMenuItem      → start minimized (no taskbar entry)
  //   hideShowIconMenuItem  → no balloon notifications on minimize
  //
  // Idempotent — written before every spawn. If LHM saves its own
  // settings on quit, our values are restored next launch.
  const xml =
`<?xml version="1.0"?>
<configuration>
  <appSettings>
    <add key="runWebServerMenuItem" value="true" />
    <add key="listenerPort" value="8085" />
    <add key="minTrayMenuItem" value="true" />
    <add key="startMinMenuItem" value="true" />
    <add key="hideShowIconMenuItem" value="true" />
    <add key="logSensorsMenuItem" value="false" />
    <add key="mainForm.Location.X" value="-32000" />
    <add key="mainForm.Location.Y" value="-32000" />
  </appSettings>
</configuration>
`;
  try {
    fs.mkdirSync(path.dirname(_lhmConfigPath()), { recursive: true });
    fs.writeFileSync(_lhmConfigPath(), xml, 'utf8');
  } catch (err) {
    console.warn('[lhm] write config failed:', err.message);
  }
}
function _lhmProbePort(timeoutMs) {
  // Returns true if something is already listening on localhost:8085.
  // We use a TCP connect rather than an HTTP GET so we don't have to
  // wait for a full HTTP response — connect-or-fail is fast.
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ host: '127.0.0.1', port: 8085 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error',   () => resolve(false));
  });
}
function _lhmHideMainWindow(pid) {
  // PowerShell helper: find every top-level window owned by `pid` and
  // call ShowWindow(hWnd, SW_HIDE). Catches the LHM main form (the
  // tray icon is a separate beast — see stealth caveat above).
  const ps =
`$pid_target = ${pid};
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool EnumWindows(System.IntPtr cb, System.IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
'@;
Get-Process -Id $pid_target -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.MainWindowHandle -ne 0) { [W.U]::ShowWindow($_.MainWindowHandle, 0) | Out-Null }
};`;
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, detached: true, stdio: 'ignore',
    }).unref();
  } catch (err) {
    console.warn('[lhm] hide main window failed:', err.message);
  }
}
let _lhmProc = null;
let _lhmHealthTimer = null;
let _lhmInstalling = false;
let _lhmStarting = false;
async function _lhmSpawnOnce() {
  // Single-attempt spawn. Caller guarantees no _lhmProc is alive and
  // the binary exists; we only do the os work here.
  _lhmWriteStealthConfig();
  try {
    // detached:true is critical on Windows — Electron's main process
    // runs inside a Job Object that kills children when the parent
    // exits AND restricts certain syscalls. LHM's WinRing0 driver
    // access goes through one of those restricted syscalls, so an
    // in-Job spawn either fails silently or LHM exits without
    // surfacing the cause. detached:true puts LHM in its own process
    // group, free of those restrictions. We still own its lifecycle:
    // before-quit calls _lhmProc.kill().
    // Note: windowsHide hides the console window only — LHM is a
    // WinForms app and creates its main form regardless; the
    // ShowWindow chaser below pushes that off-screen.
    _lhmProc = spawn(_lhmExePath(), [], {
      cwd: _lhmDir(),
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    _lhmProc.unref();
    _lhmProc.on('exit', (code) => {
      console.log('[lhm] child exited code', code);
      _lhmProc = null;
    });
    _lhmProc.on('error', (err) => {
      console.warn('[lhm] spawn error:', err.message);
      _lhmProc = null;
    });
    // Repeated chase: LHM takes ~1–3 s to fully initialize its form
    // depending on how many sensors it discovers. Fire ShowWindow a
    // few times so we catch the form whenever it appears.
    const pid = _lhmProc.pid;
    if (pid) {
      [600, 1500, 3000, 5000].forEach((delay) => {
        setTimeout(() => { if (_lhmProc?.pid === pid) _lhmHideMainWindow(pid); }, delay);
      });
    }
    console.log('[lhm] spawned pid=', pid);
  } catch (err) {
    console.warn('[lhm] spawn failed:', err.message);
  }
}
async function _lhmEnsureRunning() {
  // Re-entrancy guard — multiple health ticks may overlap if the
  // first one is still downloading.
  if (_lhmStarting) return;
  if (process.platform !== 'win32') return;
  // Port already serving = LHM (ours or someone else's) is alive.
  if (await _lhmProbePort(300)) return;
  _lhmStarting = true;
  try {
    if (!fs.existsSync(_lhmExePath())) {
      if (_lhmInstalling) return;
      _lhmInstalling = true;
      try {
        const ok = await _lhmEnsureInstalled();
        if (!ok) {
          console.warn('[lhm] auto-install did not complete — fans panel will stay offline');
          return;
        }
      } finally { _lhmInstalling = false; }
    }
    // If we previously spawned and the process is still alive but the
    // port hasn't come up, give it more time before re-spawning. Only
    // re-spawn when there's no live child.
    if (_lhmProc) {
      console.log('[lhm] port not up yet but child still alive, waiting…');
      return;
    }
    await _lhmSpawnOnce();
  } finally {
    _lhmStarting = false;
  }
}
async function _startLhmSupervisor() {
  if (process.platform !== 'win32') return;
  // Immediate first attempt, then a periodic health check that handles
  // crashes, slow first-boot installs, and the "user closed LHM via
  // tray icon" recovery path. 15 s cadence keeps the dashboard idle
  // overhead negligible.
  await _lhmEnsureRunning();
  if (_lhmHealthTimer) clearInterval(_lhmHealthTimer);
  _lhmHealthTimer = setInterval(() => {
    _lhmEnsureRunning().catch((err) => console.warn('[lhm] health-check:', err.message));
  }, 15_000);
}
function _stopLhmSupervisor() {
  if (_lhmHealthTimer) { clearInterval(_lhmHealthTimer); _lhmHealthTimer = null; }
  if (_lhmProc) {
    try { _lhmProc.kill(); } catch {}
    _lhmProc = null;
  }
}

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
function musicFolderPath()     { return path.join(userFoldersBase(), 'music');     }
function ensureUserFolders() {
  for (const p of [galleryFolderPath(), docsFolderPath(), downloadsFolderPath(), musicFolderPath()]) {
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
  // Bring up the bundled LibreHardwareMonitor child process in the
  // background. Non-blocking — if it fails, the FANS panel just stays
  // empty and the rest of the dashboard keeps booting normally.
  _startLhmSupervisor().catch((err) => console.warn('[lhm] supervisor:', err?.message || err));

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

  // Focus mode — "spotlight on the video" effect. Can't use a single
  // backdrop overlay + z-index on the video (pages like YouTube have
  // nested positioned containers that trap the video inside their own
  // stacking contexts — z-index can't escape). Instead inject a script
  // that places FOUR dim panels around the video's rect (top, bottom,
  // left, right) and keeps them in sync as the page scrolls / resizes
  // / the video changes size. The video element is never touched.
  //
  // Click-to-exit: a separate executeJavaScript awaits the next
  // mousedown anywhere in the BV's page. When it fires, the renderer
  // is notified via webContents.send('browser-focus-clicked') and
  // tears focus mode down. Token-guarded so stale waiters from a
  // previous focus session can't trigger a fresh one.
  let _bvFocusToken = 0;
  let _bvFocusScrollCssKey = null;
  ipcMain.handle('browser-set-focus', async (_e, on) => {
    const targetId = _bvZenTabId != null ? _bvZenTabId : _bvActiveId;
    const t = targetId != null ? _bvTabs.get(targetId) : null;
    const wc = t?.view?.webContents;
    if (!wc) return { ok: false };
    if (!on) {
      // Tear-down — remove the spotlight container and detach listeners.
      // Bump the token so any in-flight click-waiter from this session
      // won't trigger a stale notification.
      _bvFocusToken++;
      // Remove the scrollbar-hiding CSS we injected on enable.
      if (_bvFocusScrollCssKey != null) {
        try { await wc.removeInsertedCSS(_bvFocusScrollCssKey); } catch {}
        _bvFocusScrollCssKey = null;
      }
      try {
        await wc.executeJavaScript(`(function(){
          var c = document.getElementById('__dash3d-focus-spotlight');
          if (c) c.remove();
          if (window.__dash3dFocusUpdate) {
            window.removeEventListener('scroll', window.__dash3dFocusUpdate, true);
            window.removeEventListener('resize', window.__dash3dFocusUpdate);
            window.__dash3dFocusUpdate = null;
          }
          if (window.__dash3dFocusPoll) {
            clearInterval(window.__dash3dFocusPoll);
            window.__dash3dFocusPoll = null;
          }
          return true;
        })();`, true);
      } catch {}
      return { ok: true, on: false };
    }
    // Inject CSS to hide the page's scrollbar while focus is on. The
    // page's own overflow stays — we just hide the visible track/thumb
    // so it doesn't poke through the dim panels. Restored on tear-down.
    try {
      _bvFocusScrollCssKey = await wc.insertCSS(`
        html::-webkit-scrollbar,
        body::-webkit-scrollbar,
        *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
        html, body, * { scrollbar-width: none !important; }
      `);
    } catch {}
    // Enable — pick the most-prominent video and wrap it in a spotlight.
    // Prefer a playing video; fall back to the largest. Render 4 dim
    // panels around it and poll every 250ms in case the video resizes
    // (e.g. theater-mode toggle, page reflow). Scroll + resize hooked
    // directly for snappier updates.
    try {
      const ok = await wc.executeJavaScript(`(function(){
        // Pick the best video to spotlight.
        var vids = Array.from(document.querySelectorAll('video'));
        if (!vids.length) return false;
        var playing = vids.find(function(v){ return !v.paused && v.currentTime > 0 && v.readyState >= 2; });
        var video = playing || vids.reduce(function(a,b){
          var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (ra.width * ra.height) >= (rb.width * rb.height) ? a : b;
        });
        if (!video) return false;

        // Container with 4 dim panels — top/bottom/left/right of the
        // video. Hard rectangle around the video; no glow.
        var c = document.getElementById('__dash3d-focus-spotlight');
        if (!c) {
          c = document.createElement('div');
          c.id = '__dash3d-focus-spotlight';
          c.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
          for (var i = 0; i < 4; i++) {
            var p = document.createElement('div');
            // 0.72 = original 0.92 lightened ~20%.
            p.style.cssText = 'position:fixed;background:rgba(0,0,0,0.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:none;';
            c.appendChild(p);
          }
          document.documentElement.appendChild(c);
        }

        function update() {
          var v = document.querySelector('video');
          if (!v) return;
          // If the current video was removed, fall back.
          if (!document.contains(video)) video = v;
          var r = video.getBoundingClientRect();
          var vw = window.innerWidth, vh = window.innerHeight;
          // Clamp panel sizes to non-negative so off-screen videos still
          // render a sensible dim layer (avoids panels with negative
          // dimensions when the rect is outside the viewport).
          var top = Math.max(0, r.top), bot = Math.max(0, vh - r.bottom);
          var lft = Math.max(0, r.left), rgt = Math.max(0, vw - r.right);
          var ch = c.children;
          // Top panel
          ch[0].style.cssText += ';top:0;left:0;width:'+vw+'px;height:'+top+'px;';
          // Bottom panel
          ch[1].style.cssText += ';top:'+Math.max(0, r.bottom)+'px;left:0;width:'+vw+'px;height:'+bot+'px;';
          // Left panel
          ch[2].style.cssText += ';top:'+top+'px;left:0;width:'+lft+'px;height:'+(vh - top - bot)+'px;';
          // Right panel
          ch[3].style.cssText += ';top:'+top+'px;left:'+Math.max(0, r.right)+'px;width:'+rgt+'px;height:'+(vh - top - bot)+'px;';
        }

        update();
        window.__dash3dFocusUpdate = update;
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        // Poll for layout shifts the events don't catch (CSS transitions,
        // theater-mode toggle, programmatic resize). 250ms is plenty.
        window.__dash3dFocusPoll = setInterval(update, 250);
        return true;
      })();`, true);
      if (!ok) return { ok: false };
      // Fire off the click-waiter. A separate promise that resolves on
      // the next mousedown anywhere in the BV. When it resolves, we
      // signal the renderer so it can tear focus mode down (both
      // sides — renderer overlay + BV spotlight).
      const myToken = ++_bvFocusToken;
      wc.executeJavaScript(`
        new Promise((resolve) => {
          const handler = () => {
            document.removeEventListener('mousedown', handler, true);
            resolve(true);
          };
          document.addEventListener('mousedown', handler, true);
        });
      `, true).then(() => {
        // Stale waiter? Don't notify — another focus session may have
        // already taken over.
        if (myToken !== _bvFocusToken) return;
        if (_mainWin && !_mainWin.isDestroyed()) {
          _mainWin.webContents.send('browser-focus-clicked');
        }
      }).catch(() => {});
      return { ok: true, on: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
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
  // _bvTabs itself is declared at module scope (see ~main.js:32) so the
  // embed-invert IPC handler in registerIpc() can reach it; everything
  // else here is local to this closure.
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
      _applyEmbedInvert(wc, true);   // mirror the dashboard theme-invert
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

  // ── STEAM pane ─────────────────────────────────────────────────────
  // A single dedicated BrowserView pointed at the Steam web store/library
  // so the user can log in and browse just like a normal browser tab —
  // but isolated to its own partition so Steam cookies don't mix with the
  // BROWSER pane and persist across launches. Game launches hand off to
  // the native Steam client via the steam://run/<appid> protocol; the
  // dashboard can minimise itself out of the way for full-screen play.
  const _STEAM_PARTITION = 'persist:dash-steam';
  const _STEAM_HOME = 'https://store.steampowered.com/';
  const _STEAM_LIBRARY = 'https://store.steampowered.com/account/licenses/';
  let _steamView = null;
  let _steamBounds = { x: 0, y: 0, width: 0, height: 0 };
  let _steamVisible = false;

  function _applySteamBounds() {
    if (!_steamView || !_mainWin || _mainWin.isDestroyed()) return;
    const cb = _mainWin.getContentBounds();
    try {
      _steamView.setBounds({
        x: Math.round(cb.width  * (_steamBounds.x      || 0)),
        y: Math.round(cb.height * (_steamBounds.y      || 0)),
        width:  Math.max(0, Math.round(cb.width  * (_steamBounds.width  || 0))),
        height: Math.max(0, Math.round(cb.height * (_steamBounds.height || 0))),
      });
    } catch {}
  }
  function _ensureSteamView() {
    if (_steamView) return _steamView;
    _steamView = new BrowserView({
      webPreferences: {
        partition: _STEAM_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        autoplayPolicy: 'document-user-activation-required',
        javascript: true,
        webSecurity: true,
        spellcheck: false,
        enableWebSQL: false,
        backgroundThrottling: true,
      },
    });
    _steamView.setBackgroundColor('#0a0a0a');
    _applySteamBounds();
    const wc = _steamView.webContents;
    // Forward nav state + title back to the renderer so the chrome can
    // reflect back/forward button enablement and the URL field.
    const sendState = (eventType) => {
      if (!_mainWin || _mainWin.isDestroyed()) return;
      try {
        _mainWin.webContents.send('steam-event', {
          type: eventType,
          url: wc.getURL(),
          title: wc.getTitle(),
          canBack: wc.canGoBack(),
          canFwd: wc.canGoForward(),
          loading: wc.isLoading(),
        });
      } catch {}
    };
    wc.on('did-start-loading',  () => sendState('loading'));
    wc.on('did-stop-loading',   () => sendState('loaded'));
    wc.on('did-navigate',       () => sendState('navigate'));
    wc.on('did-navigate-in-page', () => sendState('navigate-in-page'));
    wc.on('page-title-updated', () => sendState('title'));
    // Treat steam:// links in the embedded view as a launch request — the
    // BV can't load them itself so without this they'd just error.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^steam:\/\//i.test(url)) {
        try { shell.openExternal(url); } catch {}
        return { action: 'deny' };
      }
      // Pop-outs aren't supported in this pane — load in-place instead.
      if (/^https?:\/\//i.test(url)) {
        wc.loadURL(url).catch(() => {});
      }
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (/^steam:\/\//i.test(url)) {
        e.preventDefault();
        try { shell.openExternal(url); } catch {}
      }
    });
    wc.loadURL(_STEAM_HOME).catch(() => {});
    return _steamView;
  }
  function _showSteamView() {
    if (!_mainWin || _mainWin.isDestroyed()) return;
    _ensureSteamView();
    try { _mainWin.addBrowserView(_steamView); } catch {}
    try { _steamView.webContents.setAudioMuted(false); } catch {}
    _applySteamBounds();
    _steamVisible = true;
  }
  function _hideSteamView() {
    if (!_steamView || !_mainWin || _mainWin.isDestroyed()) return;
    try { _mainWin.removeBrowserView(_steamView); } catch {}
    try { _steamView.webContents.setAudioMuted(true); } catch {}
    _steamVisible = false;
  }

  ipcMain.handle('steam-bounds', (_e, rect) => {
    _steamBounds = rect || _steamBounds;
    if (_steamVisible) _applySteamBounds();
    return { ok: true };
  });
  ipcMain.handle('steam-show', () => { _showSteamView(); return { ok: true }; });
  ipcMain.handle('steam-hide', () => { _hideSteamView(); return { ok: true }; });
  ipcMain.handle('steam-back', () => { try { _steamView?.webContents.goBack(); } catch {} return { ok: true }; });
  ipcMain.handle('steam-forward', () => { try { _steamView?.webContents.goForward(); } catch {} return { ok: true }; });
  ipcMain.handle('steam-reload', () => { try { _steamView?.webContents.reload(); } catch {} return { ok: true }; });
  ipcMain.handle('steam-home', () => {
    try { _ensureSteamView().webContents.loadURL(_STEAM_HOME); } catch {}
    return { ok: true };
  });
  ipcMain.handle('steam-library', () => {
    try { _ensureSteamView().webContents.loadURL(_STEAM_LIBRARY); } catch {}
    return { ok: true };
  });
  ipcMain.handle('steam-navigate', (_e, url) => {
    if (!url || typeof url !== 'string') return { ok: false };
    let target = url.trim();
    if (!/^https?:\/\//i.test(target)) {
      // Bare query → Steam search; bare host → assume https.
      if (/\s/.test(target) || !/\./.test(target)) {
        target = `https://store.steampowered.com/search/?term=${encodeURIComponent(target)}`;
      } else {
        target = `https://${target}`;
      }
    }
    try { _ensureSteamView().webContents.loadURL(target); } catch {}
    return { ok: true };
  });
  ipcMain.handle('steam-get-state', () => {
    if (!_steamView) return { url: '', title: '', canBack: false, canFwd: false, loading: false };
    const wc = _steamView.webContents;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canBack: wc.canGoBack(),
      canFwd: wc.canGoForward(),
      loading: wc.isLoading(),
    };
  });
  // Launch a game: spawns the native Steam client via the steam://run/<id>
  // protocol. Returns ok:false if the AppID looks invalid (digits only,
  // 1–10 chars) so the renderer can keep the typo visible to the user.
  ipcMain.handle('steam-launch', (_e, appid) => {
    const id = String(appid || '').trim();
    if (!/^\d{1,10}$/.test(id)) return { ok: false, reason: 'bad-appid' };
    try { shell.openExternal(`steam://run/${id}`); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
    return { ok: true, appid: id };
  });
  // FULLSCREEN — minimise the dashboard so the game (a separate native
  // window owned by Steam) takes the whole screen. Cheap, reliable, and
  // doesn't need any platform-specific window-foreground hack.
  ipcMain.handle('steam-minimize-dashboard', () => {
    if (!_mainWin || _mainWin.isDestroyed()) return { ok: false };
    try {
      if (_mainWin.isFullScreen()) _mainWin.setFullScreen(false);
      _mainWin.minimize();
    } catch {}
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
    // Audio — the music library plays these via an <audio> element.
    '.mp3':  'audio/mpeg', '.m4a':  'audio/mp4',  '.aac':  'audio/aac',
    '.flac': 'audio/flac', '.wav':  'audio/wav',  '.oga':  'audio/ogg',
    '.opus': 'audio/ogg',  '.weba': 'audio/webm',
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
           : which === 'music'     ? musicFolderPath()
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
      const ext = path.extname(abs).toLowerCase();
      const mime = _DASH_MIME[ext] || 'application/octet-stream';
      const stat = fs.statSync(abs);
      const size = stat.size;
      // HTTP Range request support — required for HTML5 <video> to
      // seek. Without this, the browser can only play the file
      // linearly from start, and setting currentTime= silently fails
      // (which manifested as "video stays on first frame during
      // timeline scrub" in the EDIT pane).
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          let start = parseInt(m[1], 10);
          let end   = m[2] ? parseInt(m[2], 10) : size - 1;
          if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
            if (end >= size) end = size - 1;
            const chunkSize = end - start + 1;
            const buf = Buffer.alloc(chunkSize);
            const fd  = fs.openSync(abs, 'r');
            try { fs.readSync(fd, buf, 0, chunkSize, start); } finally { fs.closeSync(fd); }
            return new Response(buf, {
              status: 206,
              headers: {
                'Content-Type':   mime,
                'Content-Length': String(chunkSize),
                'Content-Range':  `bytes ${start}-${end}/${size}`,
                'Accept-Ranges':  'bytes',
                'Access-Control-Allow-Origin': '*',
              },
            });
          }
          // Range syntactically valid but unsatisfiable.
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
      }
      // No range header → full file. Still advertise Accept-Ranges so
      // the browser knows to use ranges for any follow-up requests
      // (this is the path the <video> element takes for its initial
      // metadata probe).
      const data = fs.readFileSync(abs);
      // ACAO so the music player can route audio through a
      // MediaElementAudioSourceNode without the graph going silent on a
      // cross-origin taint (dash3d-file:// is a different origin than the
      // app page).
      return new Response(data, {
        headers: {
          'Content-Type':   mime,
          'Content-Length': String(size),
          'Accept-Ranges':  'bytes',
          'Access-Control-Allow-Origin': '*',
        },
      });
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

  // ── FANS (read-only, Stage 1) ───────────────────────────────────────
  // Reads sensor data from LibreHardwareMonitor's optional HTTP server
  // (Options → Remote Web Server → Run, default port 8085, endpoint
  // /data.json). LHM walks a tree of motherboard / super-IO chip /
  // GPU sensors; we flatten leaves whose Value carries a unit suffix:
  //   "1234 RPM" → fan
  //   "45.0 °C"  → temperature
  //   "55.0 %"   → PWM/Control
  // No writes — Stage 1 is monitor + curve designer only. Curves persist
  // in <portableData>/fan-curves.json so they survive reinstalls in the
  // portable layout.
  const LHM_URL = 'http://localhost:8085/data.json';
  function _fansFetchLhm() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const req = http.get(LHM_URL, { timeout: 1500 }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return finish({ ok: false, reason: `HTTP ${res.statusCode}` });
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { buf += c; if (buf.length > 2_000_000) { req.destroy(); finish({ ok: false, reason: 'response too large' }); } });
          res.on('end', () => {
            try { finish({ ok: true, tree: JSON.parse(buf) }); }
            catch (err) { finish({ ok: false, reason: 'JSON parse: ' + err.message }); }
          });
        });
        req.on('timeout', () => { req.destroy(); finish({ ok: false, reason: 'timeout' }); });
        req.on('error', (err) => finish({ ok: false, reason: err.code || err.message }));
      } catch (err) {
        finish({ ok: false, reason: err.message });
      }
    });
  }
  function _fansParseLhm(tree) {
    // LHM emits values with locale-formatted numbers + unit suffix. Pull
    // the first number we find; reject NaN so the renderer never paints
    // a fake "0 RPM" reading from a malformed entry.
    const parseNum = (s) => {
      const m = String(s == null ? '' : s).match(/-?\d+(?:[.,]\d+)?/);
      if (!m) return null;
      const n = parseFloat(m[0].replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    };
    const fans = [];
    const temps = [];
    const pwm = [];
    // Walk the tree, carrying the nearest device label (the deepest
    // ancestor whose Text is NOT one of the LHM group names) so each
    // sensor has a meaningful parent for the UI to group by.
    const walk = (node, deviceLabel) => {
      if (!node || typeof node !== 'object') return;
      const text = String(node.Text || '');
      const groupNames = new Set(['Sensor', 'Temperatures', 'Fans', 'Controls', 'Voltages', 'Clocks', 'Load', 'Powers', 'Data', 'Throughput', 'Currents', 'Levels', 'Factors']);
      const isGroup = groupNames.has(text);
      const nextDevice = (!isGroup && text) ? text : deviceLabel;
      const val = node.Value;
      if (typeof val === 'string' && val.length) {
        const num = parseNum(val);
        if (num != null) {
          const id = String(node.id ?? `${nextDevice}|${text}`);
          const entry = { id, name: text, device: deviceLabel || nextDevice || '', raw: val, value: num };
          if (/rpm/i.test(val))      fans.push(entry);
          else if (/°\s*c/i.test(val) || /\bC\b/.test(val.replace(/°/, ''))) {
            if (/°/.test(val)) temps.push(entry); // require ° to avoid matching "AC" / "DC" voltage labels
          }
          else if (/%/.test(val))    pwm.push(entry);
        }
      }
      const kids = node.Children;
      if (Array.isArray(kids)) for (const k of kids) walk(k, nextDevice);
    };
    walk(tree, '');
    return { fans, temps, pwm };
  }
  // Linux sensor backend. The Windows build reads LibreHardwareMonitor's
  // HTTP API; the appliance has no LHM, so read /sys/class/hwmon directly
  // — k10temp/amdgpu/nvme expose temps, asus-wmi exposes fan RPM + pwm.
  function _fansReadHwmonLinux() {
    const fans = [], temps = [], pwm = [];
    const root = '/sys/class/hwmon';
    let dirs;
    try { dirs = fs.readdirSync(root); } catch { return { fans, temps, pwm }; }
    for (const d of dirs) {
      const base = `${root}/${d}`;
      const rd = (f) => { try { return fs.readFileSync(`${base}/${f}`, 'utf8').trim(); } catch { return null; } };
      const device = rd('name') || d;
      let files = [];
      try { files = fs.readdirSync(base); } catch {}
      for (const f of files) {
        let m = f.match(/^temp(\d+)_input$/);
        if (m) {
          const n = parseInt(rd(f), 10);
          if (Number.isFinite(n)) {
            const v = n / 1000;
            temps.push({ id: `${device}|${f}`, name: rd(`temp${m[1]}_label`) || `temp${m[1]}`, device, raw: `${v.toFixed(1)} °C`, value: v });
          }
          continue;
        }
        m = f.match(/^fan(\d+)_input$/);
        if (m) {
          const n = parseInt(rd(f), 10);
          if (Number.isFinite(n)) {
            fans.push({ id: `${device}|${f}`, name: rd(`fan${m[1]}_label`) || `fan${m[1]}`, device, raw: `${n} RPM`, value: n });
          }
          continue;
        }
        m = f.match(/^pwm(\d+)$/);
        if (m) {
          const n = parseInt(rd(f), 10);
          if (Number.isFinite(n)) {
            const pct = Math.round((n / 255) * 100);
            pwm.push({ id: `${device}|${f}`, name: `pwm${m[1]}`, device, raw: `${pct} %`, value: pct });
          }
        }
      }
    }
    return { fans, temps, pwm };
  }
  ipcMain.handle('fans:poll', async () => {
    if (process.platform === 'linux') {
      const parsed = _fansReadHwmonLinux();
      if (!parsed.fans.length && !parsed.temps.length && !parsed.pwm.length) {
        return { status: 'unavailable', reason: 'no /sys/class/hwmon sensors' };
      }
      return { status: 'connected', ...parsed, ts: Date.now() };
    }
    const res = await _fansFetchLhm();
    if (!res.ok) return { status: 'unavailable', reason: res.reason };
    const parsed = _fansParseLhm(res.tree);
    return { status: 'connected', ...parsed, ts: Date.now() };
  });

  function _fansCurvesFile() {
    return path.join(portableDataDir(), 'fan-curves.json');
  }
  ipcMain.handle('fans:load-curves', async () => {
    try {
      const buf = await fs.promises.readFile(_fansCurvesFile(), 'utf8');
      const parsed = JSON.parse(buf);
      return { ok: true, curves: (parsed && typeof parsed === 'object') ? parsed : {} };
    } catch {
      return { ok: true, curves: {} };
    }
  });

  // ── Apply a designed curve to the ASUS hardware ─────────────────────
  // The app's curve is an arbitrary list of {temp:0-100°C, pct:0-100}
  // points. The ASUS asus_custom_fan_curve hwmon wants 8 fixed
  // (temp°C, pwm 0-255) points per fan, so we resample onto a fixed
  // temp ladder, interpolating the user's pct and converting to pwm.
  const _ASUS_CURVE_TEMPS = [35, 45, 55, 65, 75, 82, 88, 94];
  function _interpPct(points, t) {
    if (!points || !points.length) return null;
    const s = points.slice().sort((a, b) => a.temp - b.temp);
    if (t <= s[0].temp) return s[0].pct;
    if (t >= s[s.length - 1].temp) return s[s.length - 1].pct;
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      if (t >= a.temp && t <= b.temp) {
        const r = (t - a.temp) / ((b.temp - a.temp) || 1);
        return a.pct + (b.pct - a.pct) * r;
      }
    }
    return s[s.length - 1].pct;
  }
  function _findAsusFanCurveHwmon() {
    try {
      for (const d of fs.readdirSync('/sys/class/hwmon')) {
        const base = `/sys/class/hwmon/${d}`;
        if (fs.existsSync(`${base}/pwm1_auto_point1_pwm`)) return base;
      }
    } catch {}
    return null;
  }
  function _applyCurvesToAsus(curves) {
    const hw = _findAsusFanCurveHwmon();
    if (!hw) return { ok: false, error: 'no asus fan-curve hwmon' };
    const map = { cpu: 1, gpu: 2 }; // cpu curve -> fan1, gpu curve -> fan2
    const applied = [];
    for (const group of Object.keys(map)) {
      const fan = map[group];
      const curve = curves[group];
      if (!curve || !Array.isArray(curve.points) || !curve.points.length) continue;
      if (!fs.existsSync(`${hw}/pwm${fan}_auto_point1_pwm`)) continue;
      let prevPwm = 0;
      for (let i = 0; i < 8; i++) {
        const t = _ASUS_CURVE_TEMPS[i];
        const pct = _interpPct(curve.points, t);
        let pwm = Math.round((pct == null ? 0 : pct) / 100 * 255);
        pwm = Math.max(prevPwm, Math.max(0, Math.min(255, pwm))); // monotonic
        prevPwm = pwm;
        try {
          fs.writeFileSync(`${hw}/pwm${fan}_auto_point${i + 1}_temp`, String(t));
          fs.writeFileSync(`${hw}/pwm${fan}_auto_point${i + 1}_pwm`, String(pwm));
        } catch {}
      }
      try { fs.writeFileSync(`${hw}/pwm${fan}_enable`, '1'); } catch {}
      applied.push(`${group}→fan${fan}`);
    }
    return { ok: applied.length > 0, applied, hwmon: hw.replace('/sys/class/hwmon/', '') };
  }

  ipcMain.handle('fans:save-curves', async (_e, curves) => {
    if (!curves || typeof curves !== 'object') return { ok: false, error: 'invalid curves' };
    try {
      const file = _fansCurvesFile();
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(curves, null, 2), 'utf8');
      // On the Linux appliance, push the curve to the real hardware.
      let applied = null;
      if (process.platform === 'linux') applied = _applyCurvesToAsus(curves);
      return { ok: true, path: file, applied };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Power/thermal profile (Linux appliance). The kernel exposes the ACPI
  // platform profile via sysfs. On ASUS ROG laptops the asus-wmi driver
  // also exposes throttle_thermal_policy — and on several models writing
  // platform_profile is a no-op while throttle_thermal_policy is the live
  // knob, so we drive both. Writing needs root; the session runs as root.
  const _PLAT_PROFILE         = '/sys/firmware/acpi/platform_profile';
  const _PLAT_PROFILE_CHOICES = '/sys/firmware/acpi/platform_profile_choices';
  // asus-wmi throttle policy: 0=balanced 1=performance/turbo 2=quiet/silent
  const _ASUS_TTP_PATHS = [
    '/sys/devices/platform/asus-nb-wmi/throttle_thermal_policy',
    '/sys/devices/platform/asus-wmi/throttle_thermal_policy',
  ];
  const _ASUS_TTP_FOR = { 'low-power': 2, 'quiet': 2, 'cool': 2, 'balanced': 0, 'performance': 1 };
  function _firstExisting(paths) {
    for (const p of paths) { try { fs.accessSync(p); return p; } catch {} }
    return null;
  }
  function _readTrim(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } }
  function _thermalDiag() {
    const ttp = _firstExisting(_ASUS_TTP_PATHS);
    let asusModules = null;
    try {
      asusModules = fs.readFileSync('/proc/modules', 'utf8')
        .split('\n').map((l) => l.split(' ')[0]).filter((m) => /asus/i.test(m));
    } catch {}
    return {
      platform_profile: _readTrim(_PLAT_PROFILE),
      platform_profile_choices: _readTrim(_PLAT_PROFILE_CHOICES),
      asus_ttp_path: ttp,
      asus_ttp: ttp ? _readTrim(ttp) : null,
      asus_modules: asusModules,
    };
  }
  // Map an asus throttle_thermal_policy value back to a platform_profile
  // choice name. On ASUS, throttle_thermal_policy is the live knob and
  // platform_profile does not always reflect a change — so the policy
  // value is the source of truth for which profile is actually active.
  function _profileFromTtp(ttpRaw, choices) {
    const v = parseInt(ttpRaw, 10);
    if (!Number.isFinite(v)) return null;
    let re;
    if (v === 1) re = /perf/i;
    else if (v === 0) re = /balanc/i;
    else if (v === 2) re = /low|quiet|cool|silent/i;
    else return null;
    return (choices || []).find((c) => re.test(c)) || null;
  }
  ipcMain.handle('fans:get-profile', () => {
    if (process.platform !== 'linux') return { ok: false, error: 'unsupported platform' };
    try {
      const choices = fs.readFileSync(_PLAT_PROFILE_CHOICES, 'utf8').trim().split(/\s+/).filter(Boolean);
      let current = fs.readFileSync(_PLAT_PROFILE, 'utf8').trim();
      const ttp = _firstExisting(_ASUS_TTP_PATHS);
      if (ttp) {
        const fromTtp = _profileFromTtp(_readTrim(ttp), choices);
        if (fromTtp) current = fromTtp;
      }
      return { ok: true, current, choices, diag: _thermalDiag() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('fans:set-profile', (_e, profile) => {
    if (process.platform !== 'linux') return { ok: false, error: 'unsupported platform' };
    if (!profile || typeof profile !== 'string') return { ok: false, error: 'profile required' };
    let choices = [];
    try {
      choices = fs.readFileSync(_PLAT_PROFILE_CHOICES, 'utf8').trim().split(/\s+/).filter(Boolean);
    } catch (err) {
      return { ok: false, error: `read choices: ${err.message}` };
    }
    if (!choices.includes(profile)) return { ok: false, error: `invalid profile: ${profile}` };
    const steps = [];
    // 1. asus-wmi throttle_thermal_policy — the real ASUS knob; write first.
    const ttp = _firstExisting(_ASUS_TTP_PATHS);
    const ttpVal = _ASUS_TTP_FOR[profile];
    if (ttp && ttpVal != null) {
      try {
        fs.writeFileSync(ttp, String(ttpVal));
        steps.push(`throttle<-${ttpVal}`);
      } catch (err) {
        steps.push(`throttle FAIL:${err.code || err.message}`);
      }
    } else if (!ttp) {
      steps.push('throttle:absent');
    }
    // 2. generic ACPI platform_profile — best effort (kernel keeps it in
    //    sync where it can; on some ASUS models the write is a no-op).
    try {
      fs.writeFileSync(_PLAT_PROFILE, profile);
      steps.push(`pp<-${profile}`);
    } catch (err) {
      steps.push(`pp FAIL:${err.code || err.message}`);
    }
    // Report the live state — derived from throttle_thermal_policy when present.
    let current = profile;
    if (ttp) {
      const fromTtp = _profileFromTtp(_readTrim(ttp), choices);
      if (fromTtp) current = fromTtp;
    } else {
      current = _readTrim(_PLAT_PROFILE) || profile;
    }
    return { ok: true, current, steps, diag: _thermalDiag() };
  });

  // Full hardware/thermal diagnostic — a human-readable text dump of the
  // sysfs surface the appliance's fan + profile control depends on.
  // Surfaced behind a "HW DIAG" button so an unknown laptop's actual
  // capabilities can be read off one screen instead of guessed at.
  ipcMain.handle('system:hw-diag', () => {
    if (process.platform !== 'linux') return { ok: true, report: 'hw-diag: linux appliance only' };
    const L = [];
    const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return `<${e.code || 'err'}>`; } };
    L.push('== platform_profile ==');
    L.push('  profile : ' + read(_PLAT_PROFILE));
    L.push('  choices : ' + read(_PLAT_PROFILE_CHOICES));
    L.push('== asus throttle_thermal_policy ==');
    for (const p of _ASUS_TTP_PATHS) {
      let exists = false;
      try { fs.accessSync(p); exists = true; } catch {}
      L.push('  ' + p + ' : ' + (exists ? read(p) : '<absent>'));
    }
    L.push('== /sys/devices/platform (asus*) ==');
    try {
      const a = fs.readdirSync('/sys/devices/platform').filter((d) => /asus/i.test(d));
      L.push('  ' + (a.join(', ') || '<none>'));
    } catch (e) { L.push('  <' + (e.code || 'err') + '>'); }
    L.push('== modules (asus/amdgpu/nvidia/nct/k10temp/coretemp) ==');
    try {
      const mods = fs.readFileSync('/proc/modules', 'utf8').split('\n')
        .map((l) => l.split(' ')[0])
        .filter((m) => /asus|amdgpu|nvidia|nct|k10temp|coretemp/i.test(m));
      L.push('  ' + (mods.join(', ') || '<none>'));
    } catch (e) { L.push('  <' + (e.code || 'err') + '>'); }
    L.push('== /sys/class/hwmon ==');
    try {
      for (const d of fs.readdirSync('/sys/class/hwmon')) {
        const base = '/sys/class/hwmon/' + d;
        L.push('  [' + d + '] name=' + read(base + '/name'));
        let files = [];
        try { files = fs.readdirSync(base); } catch {}
        const rel = files
          .filter((f) => /^(fan\d+_input|temp\d+_(input|label)|pwm\d+(_enable)?|pwm\d+_auto_point\d+_(temp|pwm))$/.test(f))
          .sort();
        for (const f of rel) L.push('      ' + f + ' = ' + read(base + '/' + f));
      }
    } catch (e) { L.push('  <' + (e.code || 'err') + '>'); }
    return { ok: true, report: L.join('\n') };
  });

  // ── SERVICES TRIM · stop non-essential Windows services ──────────
  // Topbar "TRIM" stops bloat services on demand and flips their
  // startup type to Manual so they don't auto-start at next boot.
  // Reversible — services:restore reverts from a backup file. The
  // whitelist, elevation, and PowerShell all live in
  // services/system/trim.js; these handlers are just IPC wiring.
  ipcMain.handle('services:scan',    ()          => trimService.scanServices(portableDataDir()));
  ipcMain.handle('services:trim',    (_e, names) => trimService.trimServices(names, portableDataDir()));
  ipcMain.handle('services:restore', ()          => trimService.restoreServices(portableDataDir()));

  // ── STREAM · embedded media services ─────────────────────────────
  // DISCORD sub-tab is a BrowserView pinned to discord.com, with the
  // dashboard's theme injected via webContents.insertCSS once the
  // page loads. Session uses a dedicated partition (`persist:stream`)
  // so credentials survive restarts but stay isolated from the main
  // BROWSER tab's cookie jar. We pretend to be regular Chrome via UA
  // override — Discord's web app blocks unrecognized clients (the
  // default Electron UA gets rejected with "Update your browser").
  //
  // Other sub-tabs (Twitch, YouTube, etc.) can re-use this scaffold —
  // each gets its own BrowserView via _streamGetOrCreate(kind).
  const _streamViews = new Map(); // kind → BrowserView
  const _streamCssKey = new Map(); // kind → inserted-css key (for replacement)
  let _streamActive = null;       // kind currently shown
  let _streamBounds = { x: 0, y: 0, width: 0, height: 0 };
  // Live dashboard palette — updated by stream:show whenever the
  // renderer hands one over. Used by the Discord theme builder so the
  // embed tracks dashboard theme changes between mounts.
  let _streamPalette = null;

  // ── Embed invert ───────────────────────────────────────────────
  // The dashboard's theme-invert toggle is a CSS filter on #app — it
  // can't reach the native BrowserViews. Mirror it into every embed
  // (Discord / Facebook stream services + browser tabs) by injecting
  // the same invert filter. Media is re-inverted so photos / avatars
  // stay right-side-up. Re-applied on each page load since a
  // navigation clears inserted CSS.
  let _embedInvert = (() => { try { return !!readConfig().invert; } catch { return false; } })();
  const _embedInvertKeys = new Map(); // webContents.id → inserted css key
  // The triple :not(#…) bumps specificity to (3,0,1) so a web app that
  // ships its own `html.theme-dark { filter: … }` rule can't out-rank
  // this one. brightness(0.7) matches the dashboard's own invert filter
  // (styles.css §11) so an inverted embed sits at the same tone as the
  // rest of the UI. (The `eink` arg is retained for call-site symmetry
  // but both theme families now use the same invert.)
  function _embedInvertCss(_eink) {
    return `
    html:not(#dash3d-noop):not(#dash3d-noop):not(#dash3d-noop) {
      filter: invert(1) hue-rotate(180deg) brightness(0.7) !important;
    }
    /* Re-invert ONLY true raster media so photos / video stay correct.
       Deliberately NOT matching [style*="background-image"] or avatar
       wrappers: Discord puts inline background-image on large layout
       containers, so re-inverting those double-inverts a big chunk of
       the page back to normal — that's why Discord looked like it
       ignored the invert while Facebook (no such containers) worked. */
    img, video { filter: invert(1) hue-rotate(180deg) !important; }
  `;
  }
  // Per-webContents serialisation. _applyEmbedInvertInner has await points
  // between reading and mutating _embedInvertKeys, so two concurrent calls
  // (Discord fires dom-ready + did-finish-load + did-frame-finish-load
  // almost together) can interleave and strand a SECOND invert sheet —
  // two invert filters cancel out, so the embed looks un-inverted. The
  // mutex chains every call per wc so they run strictly one at a time.
  const _embedInvertLocks = new Map(); // wc.id → tail promise
  function _applyEmbedInvert(wc, freshLoad, eink) {
    if (!wc || wc.isDestroyed()) return Promise.resolve();
    const id = wc.id;
    const prev = _embedInvertLocks.get(id) || Promise.resolve();
    const next = prev.then(() => _applyEmbedInvertInner(wc, freshLoad, !!eink)).catch(() => {});
    _embedInvertLocks.set(id, next);
    return next;
  }
  async function _applyEmbedInvertInner(wc, freshLoad, eink) {
    if (!wc || wc.isDestroyed()) return;
    const id = wc.id;
    // A single page load fires dom-ready + did-finish-load + did-frame-
    // finish-load, each with freshLoad=true. Only the first truly faces
    // cleared CSS; the rest still have our live invert sheet. So instead
    // of blindly forgetting the key, try to remove the old sheet first —
    // that turns a stale key into a harmless no-op and a live one into a
    // real removal, preventing a stacked double-invert.
    if (freshLoad && _embedInvertKeys.has(id)) {
      try { await wc.removeInsertedCSS(_embedInvertKeys.get(id).key); } catch {}
      _embedInvertKeys.delete(id);
    }
    const cur = _embedInvertKeys.get(id); // { key, eink } | undefined
    if (_embedInvert) {
      if (!cur) {
        try { _embedInvertKeys.set(id, { key: await wc.insertCSS(_embedInvertCss(eink)), eink }); } catch {}
      } else if (cur.eink !== eink) {
        // Theme family switched (e-ink ↔ cyber) — the dark-view filter
        // differs, so swap the invert sheet for the matching tone.
        try { await wc.removeInsertedCSS(cur.key); } catch {}
        try { _embedInvertKeys.set(id, { key: await wc.insertCSS(_embedInvertCss(eink)), eink }); } catch {}
      }
    } else if (cur) {
      try { await wc.removeInsertedCSS(cur.key); } catch {}
      _embedInvertKeys.delete(id);
    }
  }
  ipcMain.handle('embed-invert', async (_e, on) => {
    _embedInvert = !!on;
    // Stream embeds get the invert as a dedicated, explicitly-managed
    // stylesheet — same path as browser tabs. Keeping it OUT of the theme
    // stylesheet is deliberate: Discord's SPA fires load events
    // constantly, so the theme reapply churns; an invert layer riding
    // inside it would get stranded in the cascade and never toggle off.
    const einkNow = !!(_streamPalette && _streamPalette.eink);
    for (const view of _streamViews.values()) {
      const wc = view && view.webContents;
      if (wc && !wc.isDestroyed()) { try { await _applyEmbedInvert(wc, false, einkNow); } catch {} }
    }
    // Browser tabs aren't palette-themed — invert them with a standalone
    // injected stylesheet.
    for (const t of _bvTabs.values()) {
      const wc = t && t.view && t.view.webContents;
      if (wc && !wc.isDestroyed()) await _applyEmbedInvert(wc);
    }
    return { ok: true, invert: _embedInvert };
  });

  const _STREAM_CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  // Aggressive theme injected into the Discord web client. Goals:
  //   - Strip Discord's branded chrome (server rail, Nitro/Shop/Quests
  //     sidebar items, Active Now sidebar, branded buttons)
  //   - Restyle every interactive surface (buttons, pills, inputs,
  //     scrollbars) to match the dashboard's monospace/dim/accent look
  //   - Keep user data visible: avatars (<img>) and usernames stay
  //     untouched; only the surrounding chrome changes
  // Discord ships hashed class names per release, so we target via
  // attribute-prefix selectors (`[class*="guilds_"]`). When Discord
  // rotates class names this theme will need refreshing — that's the
  // unavoidable cost of restyling someone else's web app.
  //
  // The renderer reads its live theme tokens from getComputedStyle on
  // :root and passes them along — that way the embed tracks whatever
  // theme variant the user is currently on (cyan / pink / amber / etc).
  function _buildDiscordThemeCSS(palette) {
    const p = palette || {};
    const bg          = p.bg          || '#070a0e';
    const panelBg     = p.panelBg     || '#0c1014';
    const ruleDim     = p.ruleDim     || 'rgba(92,207,255,0.22)';
    const accent      = p.accent      || '#5ccfff';
    const amber       = p.amber       || '#ffd05b';
    const ok          = p.ok          || '#5fe39a';
    const red         = p.red         || '#ff5f6e';
    const text        = p.text        || '#cfe6f7';
    const muted       = p.muted       || '#6e8aa3';
    // Secondary text biased hard toward the primary ink tone. A plain
    // mid-grey "muted" is illegible on the dimmed e-ink paper (and turns
    // grey-on-grey under invert). 85% toward `text` keeps only a whisper
    // of hierarchy — everything stays readable, which is the priority.
    const mutedText   = `color-mix(in srgb, ${text} 85%, ${muted})`;
    // Dashboard fonts — substituted live from the renderer's
    // getComputedStyle. Falls back to Inter for safety if the
    // renderer doesn't supply them.
    const fontTech    = p.fontTech    || "'Inter', 'Segoe UI', sans-serif";
    const fontDisplay = p.fontDisplay || "'Inter', 'Segoe UI', sans-serif";
    // ── Icon visibility. Discord draws toolbar / channel / message-
    // action glyphs as currentColor <svg>; its own --interactive-normal
    // token doesn't reliably reach them, so they were near-invisible.
    // Pin currentColor to the text tone in EVERY theme so glyphs read.
    // Avatars excluded (themed as dots elsewhere).
    const iconBase = `
    svg:not([class*="avatar" i]) { color: ${text} !important; }
  `;
    // INK themes additionally crush hard-coded brand fills + grayscale
    // raster emoji so nothing reads as full colour on printed paper.
    // Cyber themes skip this so genuine brand colour survives.
    const inkIcons = !p.eink ? '' : `
    /* Recolour glyph fills/strokes to ink — but NEVER touch elements
       inside <mask>/<defs>/<clipPath>/<pattern>/<symbol>. Discord
       shapes its guild icons + avatars with an SVG squircle mask whose
       <rect> is fill="white" (white = visible). Repainting that rect to
       dark ink blacks out the mask, so the whole icon vanishes — that's
       what made the server rail invisible in ink mode. */
    svg:not([class*="avatar" i]) [fill]:not([fill="none"]):not(mask *):not(defs *):not(clipPath *):not(pattern *):not(symbol *),
    svg:not([class*="avatar" i]) [stop-color] {
      fill: ${text} !important;
    }
    /* Stroke-drawn glyphs (fill="none") — pin the stroke to ink too,
       same mask/defs exclusions. */
    svg:not([class*="avatar" i]) [stroke]:not([stroke="none"]):not(mask *):not(defs *):not(clipPath *):not(pattern *):not(symbol *) {
      stroke: ${text} !important;
    }
    img[class*="emoji" i], img[data-type="emoji"],
    [class*="emoji" i] img {
      filter: grayscale(1) contrast(1.05) !important;
    }
    /* Server-rail icons → greyscale on printed-paper (ink) themes so the
       rail reads monochrome like the rest of the embed. Identified by
       the "/icons/" CDN path. (A greyscale image stays greyscale when
       the page invert flips it, so this is correct in both invert
       states without needing to know which is active.) */
    img[src*="/icons/" i] { filter: grayscale(1) !important; }
    [style*="/icons/" i]  { filter: grayscale(1) !important; }
    /* The DM / home button keeps a brand-blurple fill — it's an SVG, not
       a /icons/ image, so the rule above misses it. Greyscale it (and
       the Add-Server / Explore buttons) so the whole rail is monochrome. */
    [data-list-item-id*="home" i],
    a[href="/channels/@me"],
    [class*="homeIcon" i],
    [class*="home" i][class*="wrapper" i],
    [aria-label="Direct Messages" i],
    [data-list-item-id*="create" i],
    [data-list-item-id*="discover" i] {
      filter: grayscale(1) !important;
    }
    /* ── INK accents. The embed is monochrome ink, but the small unread
       count badges keep colour — washed to the e-ink red. Scoped to the
       specific count-badge classes only: a broad [class*="badge_"] and
       inline-style colour matches caught large containers and flooded
       the rail with red blocks. */
    [class*="numberBadge" i],
    [class*="mentionsBadge" i],
    [class*="mentionBadge" i],
    [class*="pingCount" i] {
      background-color: ${red} !important;
      color: ${bg} !important;
    }
    [class*="numberBadge" i] *, [class*="mentionsBadge" i] *,
    [class*="mentionBadge" i] *, [class*="pingCount" i] * {
      color: ${bg} !important;
      fill: ${bg} !important;
    }
  `;
    return `${iconBase}${inkIcons}
    /* ── Color tokens — substitute the live dashboard palette into
       Discord's CSS custom properties. Discord's React reads these
       tokens at runtime, so overriding them retints every component
       that participates in the theme system. */
    :root, .theme-dark, .theme-darker, .theme-midnight, html, body {
      --background-primary:        ${bg} !important;
      --background-secondary:      ${panelBg} !important;
      --background-secondary-alt:  ${panelBg} !important;
      --background-tertiary:       ${bg} !important;
      --background-accent:         ${panelBg} !important;
      --background-floating:       ${panelBg} !important;
      --channeltextarea-background:${panelBg} !important;
      --background-modifier-selected: ${ruleDim} !important;
      --background-modifier-hover:    rgba(255,255,255,0.04) !important;
      --background-modifier-active:   rgba(255,255,255,0.06) !important;
      --background-modifier-accent:   ${ruleDim} !important;
      --interactive-normal: ${text} !important;
      --interactive-hover:  ${accent} !important;
      --interactive-active: ${accent} !important;
      --interactive-muted:  ${mutedText} !important;
      --header-primary:     ${text} !important;
      --header-secondary:   ${mutedText} !important;
      --text-normal:        ${text} !important;
      --text-muted:         ${mutedText} !important;
      --channels-default:   ${mutedText} !important;
      --text-secondary:     ${mutedText} !important;
      --text-link:          ${accent} !important;
      --brand-experiment:       ${accent} !important;
      --brand-experiment-100:   ${accent} !important;
      --brand-experiment-400:   ${accent} !important;
      --brand-experiment-500:   ${accent} !important;
      --brand-experiment-560:   ${accent} !important;
      --brand-experiment-600:   ${accent} !important;
      --button-secondary-background:        ${ruleDim} !important;
      --button-secondary-background-hover:  ${ruleDim} !important;
      --button-secondary-background-active: ${ruleDim} !important;
      --background-mentioned:       ${ruleDim} !important;
      --background-mentioned-hover: ${ruleDim} !important;
      --status-positive-background: ${ok} !important;
      --status-danger-background:   ${red} !important;
      --scrollbar-auto-thumb: ${ruleDim} !important;
      --scrollbar-auto-track: transparent !important;
      /* Presence colours — Discord ships vibrant status hues; retint
         them to the washed dashboard tones (online → theme green, etc).
         Discord has rotated the green token name across versions, so
         set every variant we know of. */
      --status-online:    ${ok} !important;
      --status-idle:      ${amber} !important;
      --status-dnd:       ${red} !important;
      --status-offline:   ${muted} !important;
      --status-streaming: ${accent} !important;
      --status-speaking:  ${ok} !important;
      --green-300: ${ok} !important;
      --green-330: ${ok} !important;
      --green-360: ${ok} !important;
      --green-400: ${ok} !important;
      /* Semantic positive / danger tokens — these carry the washed green
         + red into every component Discord designed for them: positive
         text (e.g. "Online", success notices), danger text + buttons
         (errors, "Delete", leave-server), mention highlights. Tokens are
         component-scoped, so this spreads colour safely with no risk of
         flooding a layout container. Unknown names go unused. */
      --text-positive:   ${ok} !important;
      --text-danger:     ${red} !important;
      --text-warning:    ${amber} !important;
      --text-brand:      ${accent} !important;
      --info-positive-foreground: ${ok} !important;
      --info-positive-text:       ${ok} !important;
      --info-danger-foreground:   ${red} !important;
      --info-danger-text:         ${red} !important;
      --info-warning-foreground:  ${amber} !important;
      --button-positive-background:       ${ok} !important;
      --button-positive-background-hover: ${ok} !important;
      --button-danger-background:         ${red} !important;
      --button-danger-background-hover:   ${red} !important;
      --status-positive-text:  ${ok} !important;
      --status-danger-text:    ${red} !important;
      --mention-foreground:    ${red} !important;
      --mention-background:    color-mix(in srgb, ${red} 22%, transparent) !important;
      --red-330: ${red} !important;
      --red-360: ${red} !important;
      --red-400: ${red} !important;
      --red-430: ${red} !important;
      --red-460: ${red} !important;
      /* Newer Discord "base / surface" redesign background tokens — the
         current React app paints much of its chrome from these instead
         of the legacy --background-* set above. Unknown names simply go
         unused, so listing extras is harmless. */
      --background-base-lowest:     ${bg} !important;
      --background-base-lower:      ${bg} !important;
      --background-base-low:        ${panelBg} !important;
      --bg-base-primary:            ${bg} !important;
      --bg-base-secondary:          ${panelBg} !important;
      --bg-base-tertiary:           ${bg} !important;
      --background-surface-high:    ${panelBg} !important;
      --background-surface-higher:  ${panelBg} !important;
      --background-surface-highest: ${panelBg} !important;
      --bg-surface-raised:          ${panelBg} !important;
      --bg-surface-overlay:         ${panelBg} !important;
      --bg-overlay-app-frame:       ${bg} !important;
      --bg-overlay-3:               ${panelBg} !important;
      --bg-mod-faint:               rgba(255,255,255,0.04) !important;
      --bg-mod-subtle:              rgba(255,255,255,0.06) !important;
      /* Input / search surfaces — Discord paints these on a pale
         "raised" tone; pull them down to the dashboard panel colour. */
      --input-background:           ${panelBg} !important;
      --input-background-hover:     ${panelBg} !important;
      --search-popout-option-non-text-color: ${panelBg} !important;
    }

    /* ── Kill all background gradients/images — Discord uses brand
       imagery as panel backgrounds in lots of places. Server icons are
       exempt: Discord paints them as background-image divs whose inline
       style carries the "/icons/" CDN path — nuking those blanks the
       whole server rail. */
    *:not(img):not(video):not(canvas):not([class*="avatar_"]):not([class*="wrapper_"][class*="status"]):not([style*="/icons/" i]) {
      background-image: none !important;
    }

    /* ── Inputs, search bars, the quick-switcher and the friends-list
       filter pills — Discord renders these on a light "raised" surface
       that the token overrides above don't always reach. Force every
       one to the dashboard panel tone so no light boxes remain. */
    input, textarea,
    [class*="searchBar" i], [class*="searchBox" i], [class*="search_" i],
    [class*="input_" i], [class*="lookFilled" i], [class*="quickswitcher" i],
    [class*="autocomplete" i] {
      background-color: ${panelBg} !important;
    }

    /* ── Server rail (left-most icons column) — themed to match
       the dashboard sidebar. Keep the server icons visible so the
       user can navigate, but ditch Discord's pill/blur effects. */
    nav[aria-label*="Servers"],
    [class*="guilds_"] {
      background: ${panelBg} !important;
      border-right: 1px dashed ${ruleDim} !important;
      padding: 6px 0 !important;
    }
    /* Server icon list items: square corners, subtle dim border on
       hover/selected so they read like dashboard tiles, not pills. */
    [class*="listItem_"][class*="guild"],
    [class*="wrapper_"][class*="guild"],
    [class*="pill_"] {
      border-radius: 0 !important;
    }
    /* The blurple "active server" pill on the left edge gets retinted
       to the dashboard accent. */
    [class*="pill_"] {
      background: ${accent} !important;
    }
    /* Server-rail icons stay full-size + fully opaque. Defensive: the
       avatar-dot / dimming rules elsewhere must not catch the guild
       list, or the rail goes blank (icons near-invisible). */
    [class*="guilds_"] img,
    [class*="guilds_"] svg,
    [class*="guilds_"] foreignObject,
    [class*="guilds_"] [class*="wrapper_"],
    [class*="guilds_"] [class*="listItem_"] {
      opacity: 1 !important;
      visibility: visible !important;
    }
    [class*="guilds_"] img,
    [class*="guilds_"] foreignObject { display: block !important; }
    /* Hide just the "Add Server" + "Discover Servers" buttons at the
       bottom of the rail — they're Discord upsell affordances. */
    [class*="listItem_"]:has([aria-label*="Add a Server" i]),
    [class*="listItem_"]:has([aria-label*="Discover" i]),
    [class*="listItem_"]:has([aria-label*="Explore Discoverable" i]),
    div[role="treeitem"][aria-label*="Add a Server" i],
    div[role="treeitem"][aria-label*="Discover" i] {
      display: none !important;
    }

    /* ── Hide branded sidebar items: Nitro, Shop, Quests. Discord
       rotates the channel-row class names, so we target by every
       stable hook we can find: href substrings, aria-labels, data-
       attributes Discord uses for routing, and the upsell wrappers.
       The text-content fallback runs in JS (see inject script) to
       catch anything CSS misses. */
    [href*="/store"],
    [href*="/shop"],
    [href*="/quests"],
    [href*="/nitro"],
    [href*="/discovery"],
    [aria-label="Nitro" i],
    [aria-label*="Shop" i],
    [aria-label*="Quest" i],
    [aria-label*="Nitro Upsell" i],
    [data-list-item-id*="nitro" i],
    [data-list-item-id*="shop" i],
    [data-list-item-id*="quest" i],
    [data-list-item-id*="store" i],
    [class*="nitroUpsell_"],
    [class*="premiumPromo_"],
    [class*="nitroSection_"],
    [class*="upsellInner_"],
    [class*="storeChannel"],
    [class*="questsChannel"],
    [class*="nitroChannel"] { display: none !important; }

    /* ── Profile pictures: replace each avatar with a tiny themed
       status dot. We hide the actual image content (img tag, SVG
       mask, foreignObject) but KEEP the wrapper element so a colored
       circle can ride in its place. The dot's color reflects presence
       (online / idle / dnd / offline) using :has() over the status
       indicator Discord renders inside the wrapper. */
    /* Hide ONLY the user-avatar imagery. Server icons are identified by
       the "/icons/" CDN path (user avatars are "/avatars/") and exempted
       wherever they render — Discord reuses the avatar component for the
       server rail, so a blanket hide silently kills the whole rail. */
    [class*="avatar_"] img:not([src*="/icons/" i]),
    [class*="avatar_"] foreignObject:not(:has(img[src*="/icons/" i])):not(:has(image[href*="/icons/" i])),
    [class*="avatar_"] svg image:not([href*="/icons/" i]),
    [class*="avatar_"] svg use,
    img[src*="cdn.discordapp.com/avatars"],
    img[src*="cdn.discordapp.com/embed/avatars"] { display: none !important; }
    /* Avatar wrapper → 10 px themed dot. Default muted (looks offline);
       presence-specific selectors below override the color. A wrapper
       that contains a server icon keeps its real size — only true user
       avatars collapse to a dot. */
    [class*="avatar_"]:not(:has(img[src*="/icons/" i])):not(:has(image[href*="/icons/" i])):not(:has([style*="/icons/" i])),
    [class*="userAvatar_"] {
      width: 10px !important;
      height: 10px !important;
      min-width: 10px !important;
      min-height: 10px !important;
      max-width: 10px !important;
      max-height: 10px !important;
      background: ${muted} !important;
      border-radius: 50% !important;
      /* Ink outline so the dot is visible whatever its fill tone lands
         at against the dimmed e-ink paper. */
      border: 1px solid ${text} !important;
      box-shadow: none !important;
      flex-shrink: 0 !important;
      margin-right: 10px !important;
      align-self: center !important;
      overflow: hidden !important;
    }
    /* Presence-aware tinting. Discord ships several variants for the
       status indicator class; cover the common ones. :has() is well-
       supported in Electron 30+. */
    [class*="avatar_"]:has([class*="online_"]),
    [class*="avatar_"]:has([class*="online-"]),
    [class*="avatar_"]:has([fill*="status-online"]) {
      background: ${ok} !important;
    }
    [class*="avatar_"]:has([class*="idle_"]),
    [class*="avatar_"]:has([class*="idle-"]),
    [class*="avatar_"]:has([fill*="status-idle"]) {
      background: ${amber} !important;
    }
    [class*="avatar_"]:has([class*="dnd_"]),
    [class*="avatar_"]:has([class*="dnd-"]),
    [class*="avatar_"]:has([fill*="status-dnd"]) {
      background: ${red} !important;
    }
    [class*="avatar_"]:has([class*="streaming_"]) {
      background: ${accent} !important;
      border: 2px solid ${amber} !important;
      width: 12px !important; height: 12px !important;
    }
    /* Avatars inside chat-message bubbles / floating tooltips are
       irrelevant — collapse them fully there so message rows don't
       carry a stray dot in the gutter. */
    [class*="messageContent_"] [class*="avatar_"],
    [class*="message_"] [class*="avatar_"],
    [class*="tooltip"] [class*="avatar_"] {
      display: none !important;
    }

    /* ── Native presence dots. Discord paints the status circle (on
       avatars + the bottom user panel) as an SVG <rect> with a hard-
       coded vibrant hex, which the --status-* tokens don't always
       reach. Retint each known hue to the washed dashboard tone:
       online → theme green, idle → amber, dnd → theme red. */
    rect[fill="#23a55a"], rect[fill="#3ba55c"], rect[fill="#43b581"],
    [fill="#23a55a"], [fill="#3ba55c"], [fill="#43b581"], [fill="#2dc770"],
    [class*="status" i][class*="online" i] {
      fill: ${ok} !important;
      background-color: ${ok} !important;
      color: ${ok} !important;
    }
    rect[fill="#f0b232"], rect[fill="#faa81a"],
    [fill="#f0b232"], [fill="#faa81a"], [fill="#faa61a"],
    [class*="status" i][class*="idle" i] {
      fill: ${amber} !important;
      background-color: ${amber} !important;
    }
    rect[fill="#f23f43"], rect[fill="#ed4245"], rect[fill="#f04747"],
    [fill="#f23f43"], [fill="#ed4245"], [fill="#f04747"], [fill="#da373c"],
    [class*="status" i][class*="dnd" i] {
      fill: ${red} !important;
      background-color: ${red} !important;
    }

    /* ── Server rail rescue. Discord reuses its avatar component for
       guild icons, so the avatar-imagery hide + 10px-dot shrink can
       silently blank the rail. Rather than depend on the (frequently
       rotated) rail class name, target server icons by identity — the
       "/icons/" CDN path — so they're restored wherever they render. */
    img[src*="/icons/" i],
    image[href*="/icons/" i],
    [style*="/icons/" i] {
      display: revert !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    /* Any wrapper holding a server icon keeps its real footprint. */
    [class*="avatar_"]:has(img[src*="/icons/" i]),
    [class*="avatar_"]:has(image[href*="/icons/" i]),
    [class*="avatar_"]:has([style*="/icons/" i]),
    *:has(> img[src*="/icons/" i]) {
      width: revert !important;
      height: revert !important;
      min-width: revert !important;
      min-height: revert !important;
      max-width: revert !important;
      max-height: revert !important;
      background: transparent !important;
      border-radius: revert !important;
      overflow: visible !important;
    }

    /* ── Hide "Active Now" right sidebar — Discord-branded content
       block that doesn't belong in a personal embed. */
    [class*="nowPlayingColumn_"],
    [class*="activityFeed_"],
    [class*="container_"][class*="member"]:has([class*="nowPlaying"]) { display: none !important; }

    /* ── Typography: monospace tech font everywhere except message
       bodies (those stay readable). */
    body, button, input, textarea, select,
    [class*="title_"], [class*="header_"], [class*="topPill_"],
    [class*="tab_"], [class*="link_"] {
      font-family: ${fontDisplay} !important;
    }
    [class*="title_"], [class*="header_"], [class*="tab_"] {
      letter-spacing: 0.08em !important;
      text-transform: uppercase !important;
      font-weight: 500 !important;
    }

    /* ── Buttons: dashboard treatment — transparent w/ dim border,
       accent on hover. Catches Discord's primary, secondary, and
       link button classes. */
    button[type="button"]:not([class*="emojiButton_"]):not([class*="addReaction_"]):not([class*="reaction_"]):not([class*="messageContent_"] *),
    [class*="button_"][role="button"],
    [class*="lookFilled_"], [class*="lookOutlined_"], [class*="lookLink_"] {
      background: transparent !important;
      border: 1px solid ${ruleDim} !important;
      color: ${text} !important;
      border-radius: 0 !important;
      font-family: ${fontTech} !important;
      letter-spacing: 0.08em !important;
      text-transform: uppercase !important;
      box-shadow: none !important;
    }
    button[type="button"]:hover:not([class*="emojiButton_"]):not([class*="addReaction_"]),
    [class*="button_"][role="button"]:hover,
    [class*="lookFilled_"]:hover, [class*="lookOutlined_"]:hover {
      border-color: ${accent} !important;
      color: ${accent} !important;
      background: ${ruleDim} !important;
    }
    /* Primary brand "Add Friend" / submit-style buttons get accent fill */
    [class*="lookFilled_"][class*="colorBrand_"],
    [class*="primary_"][role="button"],
    button[type="submit"] {
      background: ${ruleDim} !important;
      border-color: ${accent} !important;
      color: ${accent} !important;
    }

    /* ── Pills/tabs (Friends/Online/All toggle) — match dashboard
       combo-mode-tab look. Higher-specificity selectors stack so the
       brand-blue Discord puts on the active pill loses every time. */
    [class*="topPill_"] [class*="item_"],
    [class*="topPill_"] button,
    [class*="topPill_"] [role="tab"],
    [class*="navItem_"] {
      background: transparent !important;
      border: 1px solid ${ruleDim} !important;
      border-radius: 0 !important;
      color: ${muted} !important;
      padding: 4px 12px !important;
      letter-spacing: 0.1em !important;
      text-transform: uppercase !important;
    }
    [class*="topPill_"] [class*="selected_"],
    [class*="topPill_"] [aria-selected="true"],
    [class*="topPill_"] [class*="selected_"][class*="item_"],
    [class*="topPill_"] button[class*="selected_"],
    [class*="navItem_"][class*="selected_"] {
      background: ${ruleDim} !important;
      border-color: ${accent} !important;
      color: ${accent} !important;
      box-shadow: none !important;
    }
    /* Catch the "Add Friend" green button and any "primary" colored
       action — drag them to dashboard accent fill. */
    [class*="lookFilled_"][class*="colorGreen_"],
    [class*="lookFilled_"][class*="colorBrand_"],
    [class*="lookFilled_"][class*="colorPrimary_"] {
      background: ${ruleDim} !important;
      border-color: ${accent} !important;
      color: ${accent} !important;
    }
    /* Generic safety net: any leftover Discord blurple background
       (rgb 88,101,242 is Discord's brand color #5865f2) gets crushed
       to ruleDim. Catches button states / hover surfaces we missed. */
    [style*="rgb(88, 101, 242)"],
    [style*="rgb(88,101,242)"],
    [style*="#5865f2"],
    [style*="#5865F2"] {
      background-color: ${ruleDim} !important;
      color: ${accent} !important;
    }

    /* ── Inputs (search bar, message box, "Find or start a conversation") */
    [class*="searchBar_"],
    [class*="search_"][class*="bar_"],
    [class*="findContainer_"],
    [class*="channelTextArea_"],
    input[type="text"], input[type="search"] {
      background: ${panelBg} !important;
      border: 1px solid ${ruleDim} !important;
      border-radius: 0 !important;
      color: ${text} !important;
      font-family: ${fontTech} !important;
      letter-spacing: 0.04em !important;
    }
    [class*="searchBar_"]:focus-within,
    input:focus {
      border-color: ${accent} !important;
      outline: none !important;
    }

    /* ── Sidebar (DM list) restyle. Matches the dashboard's panel
       rhythm: panel-bg base, dashed dividers between rows, accent
       left-border on the active row, generous vertical padding so
       names breathe. */
    [class*="sidebar_"],
    nav[aria-label*="Direct Messages"],
    [class*="privateChannels_"] {
      background: ${panelBg} !important;
      border-right: 1px dashed ${ruleDim} !important;
    }
    [class*="link_"][class*="channel_"],
    [class*="interactiveNormal_"][class*="link_"],
    [class*="channel_"][role="link"],
    [class*="channel_"][role="button"] {
      border-radius: 0 !important;
      padding: 10px 12px !important;
      margin: 0 !important;
      border-bottom: 1px dashed ${ruleDim} !important;
      min-height: 40px !important;
      display: flex !important;
      align-items: center !important;
    }
    [class*="link_"][class*="channel_"]:hover,
    [class*="interactiveNormal_"][class*="link_"]:hover,
    [class*="channel_"][role="link"]:hover {
      background: ${ruleDim} !important;
    }
    [class*="selected_"][class*="link_"],
    [class*="selected_"][class*="channel_"],
    [class*="interactiveSelected_"] {
      background: ${ruleDim} !important;
      border-left: 2px solid ${accent} !important;
      padding-left: 10px !important;
    }
    /* DM-list legibility. Read (already-seen) DM rows render at a faint
       muted tone + reduced opacity that vanishes on the dimmed e-ink
       paper. Force every name / label in the sidebar to the full ink
       colour at full opacity so all rows read equally. */
    [class*="sidebar_"] [class*="name_"],
    [class*="sidebar_"] [class*="content_"],
    [class*="privateChannels_"] [class*="name_"],
    [class*="privateChannels_"] [class*="content_"],
    [class*="privateChannels_"] [class*="channelName_"],
    [class*="link_"][class*="channel_"] *,
    [class*="channel_"][role="link"] *,
    [class*="channel_"][role="button"] * {
      color: ${text} !important;
      opacity: 1 !important;
    }
    /* "FIND OR START A CONVERSATION" search box at the top of the
       DM sidebar — give it a dashboard input look (transparent w/
       dim dashed border). */
    [class*="searchBar_"],
    button[class*="searchBar_"] {
      background: transparent !important;
      border: 1px dashed ${ruleDim} !important;
      border-radius: 0 !important;
      padding: 8px 12px !important;
      margin: 8px !important;
      color: ${muted} !important;
    }
    /* "DIRECT MESSAGES" section header — match dashboard panel-title
       cadence (uppercase, letter-spacing, muted). */
    [class*="title_"][class*="section_"],
    h2[class*="title_"] {
      color: ${muted} !important;
      font-family: ${fontDisplay} !important;
      font-size: 10px !important;
      letter-spacing: 0.18em !important;
      text-transform: uppercase !important;
      padding: 8px 12px !important;
    }
    /* Bottom user strip (avatar + mute/deafen/settings cluster).
       Re-style as a dashboard panel footer. */
    [class*="panels_"][class*="panel_"],
    section[class*="panels_"] {
      background: ${panelBg} !important;
      border-top: 1px dashed ${ruleDim} !important;
      padding: 8px 10px !important;
    }
    /* Mute/deafen/settings buttons in the bottom strip — accent-tint
       on hover, dim default. */
    [class*="container_"][class*="account_"] button,
    [class*="panelButton_"] {
      color: ${muted} !important;
    }
    [class*="container_"][class*="account_"] button:hover,
    [class*="panelButton_"]:hover { color: ${accent} !important; }

    /* ── Member list & friend rows — keep avatars (img) untouched,
       restyle the row chrome. */
    [class*="memberInner_"],
    [class*="peopleListItem_"],
    [class*="peopleListItem-"] {
      border-radius: 0 !important;
      border-bottom: 1px dashed ${ruleDim} !important;
      padding: 8px 12px !important;
    }
    [class*="memberInner_"]:hover,
    [class*="peopleListItem_"]:hover {
      background: ${ruleDim} !important;
    }

    /* ── Panel borders — every Discord "panel-like" element gets
       a dim dashed border matching the dashboard's panel rhythm. */
    [class*="container_"][class*="chat_"],
    [class*="contentRegion_"],
    [class*="page_"],
    [class*="content_"][class*="channelHeader"],
    [class*="title_"][class*="containerNormal_"] {
      border-bottom: 1px solid ${ruleDim} !important;
    }
    /* The user's bottom-left profile panel (avatar + name + mute/
       deafen/settings cluster) — restyle as a dashboard footer-style
       strip. */
    [class*="panel_"][class*="container_"],
    section[aria-label*="User"][class*="panel_"] {
      background: ${panelBg} !important;
      border-top: 1px dashed ${ruleDim} !important;
    }

    /* ── Scrollbars — thin dashboard style */
    ::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
    ::-webkit-scrollbar-thumb { background: ${ruleDim} !important; border-radius: 0 !important; }
    ::-webkit-scrollbar-track { background: transparent !important; }
  `;
  }

  // Facebook web client / Messenger theme. Facebook uses heavily
  // obfuscated hashed class names so we lean on attribute-prefix
  // selectors, role attributes, and an aggressive brand-color crush
  // (Facebook blue is #1877f2 / rgb 24,119,242 — anything matching
  // gets retinted to ${accent}). Compared to Discord, Facebook
  // doesn't expose nice CSS custom properties to override, so we
  // target backgrounds + colors directly with !important.
  function _buildFacebookThemeCSS(palette) {
    const p = palette || {};
    const bg          = p.bg          || '#070a0e';
    const panelBg     = p.panelBg     || '#0c1014';
    const ruleDim     = p.ruleDim     || 'rgba(92,207,255,0.22)';
    const accent      = p.accent      || '#5ccfff';
    const amber       = p.amber       || '#ffd05b';
    const ok          = p.ok          || '#5fe39a';
    const red         = p.red         || '#ff5f6e';
    const text        = p.text        || '#cfe6f7';
    const muted       = p.muted       || '#6e8aa3';
    const fontTech    = p.fontTech    || "'Inter','Segoe UI',sans-serif";
    const fontDisplay = p.fontDisplay || "'Inter','Segoe UI',sans-serif";
    // Icon visibility (every theme): Facebook draws glyphs as currentColor
    // <svg> — pin currentColor to the text tone so they read.
    const iconBase = `
    svg:not([class*="avatar" i]) { color: ${text} !important; }
  `;
    // INK themes → monochrome icons (see _buildDiscordThemeCSS). Facebook
    // draws icons both as inline <svg> and as CSS-sprite <i> elements, so
    // we crush the SVG fills and grayscale the sprite tiles.
    const inkIcons = !p.eink ? '' : `
    /* Exclude <mask>/<defs>/<clipPath>/<pattern> children — repainting a
       mask's white rect to ink blacks out the masked element. */
    svg [fill]:not([fill="none"]):not(mask *):not(defs *):not(clipPath *):not(pattern *):not(symbol *),
    svg [stop-color] { fill: ${text} !important; }
    i[data-visualcompletion="css-img"],
    [role="img"]:not(img) {
      filter: grayscale(1) contrast(1.05) !important;
    }
    /* ── INK accents. Monochrome ink overall, but small semantic markers
       keep washed colour. Scoped to SVG [fill] attributes only — matching
       colour substrings in inline styles caught CSS-variable declarations
       and flooded large containers with colour. */
    svg [fill="#fa383e" i], svg [fill="#e41e3f" i], svg [fill="#f3425f" i] {
      fill: ${red} !important;
    }
    svg [fill="#31a24c" i], svg [fill="#42b72a" i] {
      fill: ${ok} !important;
    }
  `;
    return `${iconBase}${inkIcons}
    /* ── Base canvas: kill Facebook's white/light surfaces. */
    html, body, #facebook, [role="main"], [role="banner"], [role="navigation"], [role="complementary"] {
      background: ${bg} !important;
      color: ${text} !important;
    }
    /* News-feed cards, modals, popovers — treat as dashboard panels. */
    [role="article"], [role="dialog"], [role="menu"],
    div[data-pagelet*="FeedUnit"],
    div[data-pagelet*="ProfileTimeline"],
    div[data-pagelet*="MainFeed"] {
      background: ${panelBg} !important;
      border: 1px solid ${ruleDim} !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }
    /* Typography: monospace/display font everywhere, dim text, accent
       hover for links. */
    body, body * {
      font-family: ${fontTech} !important;
      color: ${text} !important;
    }
    h1, h2, h3, [role="heading"] {
      font-family: ${fontDisplay} !important;
      letter-spacing: 0.08em !important;
      text-transform: uppercase !important;
      color: ${text} !important;
    }
    a, a * { color: ${accent} !important; }
    a:hover, a:hover * { color: ${text} !important; }

    /* All buttons → dashboard treatment: transparent + dim border +
       accent on hover. The :not(...) avoids restyling Facebook's
       circular avatar/reaction buttons (those still need to be
       round-ish to be recognizable). */
    [role="button"]:not([aria-label*="Like"]):not([aria-label*="React"]):not([aria-label*="Reaction"]),
    button[type="button"], button[type="submit"] {
      background: transparent !important;
      border: 1px solid ${ruleDim} !important;
      color: ${text} !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      font-family: ${fontDisplay} !important;
      letter-spacing: 0.06em !important;
    }
    [role="button"]:hover, button:hover {
      border-color: ${accent} !important;
      color: ${accent} !important;
      background: ${ruleDim} !important;
    }

    /* Inputs (search box, composer "What's on your mind", message
       text-areas) — dark with dim dashed border. */
    input[type="text"], input[type="search"], input[type="password"],
    textarea, [contenteditable="true"] {
      background: ${panelBg} !important;
      border: 1px solid ${ruleDim} !important;
      border-radius: 0 !important;
      color: ${text} !important;
      font-family: ${fontTech} !important;
    }
    input:focus, textarea:focus, [contenteditable="true"]:focus {
      border-color: ${accent} !important;
      outline: none !important;
    }

    /* Brand color crush — Facebook leaks #1877f2 (their blue) into
       inline styles + SVG fills + button backgrounds. Catch the
       common forms and retint to dashboard accent. */
    [style*="rgb(24, 119, 242)"],
    [style*="rgb(24,119,242)"],
    [style*="#1877f2"], [style*="#1877F2"],
    [style*="#1b74e4"], [style*="#1B74E4"] {
      background-color: ${ruleDim} !important;
      color: ${accent} !important;
    }
    [fill="#1877f2"], [fill="#1877F2"],
    [fill="#1b74e4"], [fill="#1B74E4"] {
      fill: ${accent} !important;
    }
    [stroke="#1877f2"], [stroke="#1877F2"] { stroke: ${accent} !important; }

    /* Hide a few in-feed nags / upsells if their data hooks match. */
    [data-pagelet*="Stories"],
    [aria-label="Suggested for you"],
    [aria-label*="Sponsored" i] { display: none !important; }

    /* Scrollbars — thin dashboard style. */
    ::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
    ::-webkit-scrollbar-thumb { background: ${ruleDim} !important; border-radius: 0 !important; }
    ::-webkit-scrollbar-track { background: transparent !important; }
  `;
  }

  function _streamApplyBounds(view) {
    if (!view || !_mainWin || _mainWin.isDestroyed()) return;
    // _streamBounds is a fractional rect (x/y/width/height each 0..1
    // of the dashboard viewport). Multiply by the window's content
    // size to recover DIPs. Matches the BROWSER tab convention so
    // CSS zoom on renderer panels stays correctly accounted for.
    const cb = _mainWin.getContentBounds();
    try {
      view.setBounds({
        x: Math.round(cb.width  * (_streamBounds.x      || 0)),
        y: Math.round(cb.height * (_streamBounds.y      || 0)),
        width:  Math.max(0, Math.round(cb.width  * (_streamBounds.width  || 0))),
        height: Math.max(0, Math.round(cb.height * (_streamBounds.height || 0))),
      });
    } catch {}
    try { view.setAutoResize({ width: false, height: false }); } catch {}
  }
  // Page-world inject: (1) monkey-patches window.Notification to
  // forward DM/mention notifications via the contextBridge to main;
  // (2) walks the DOM for sidebar items whose text matches Nitro/
  // Shop/Quests and hides them — CSS selectors miss these when
  // Discord rotates class names, but the visible text doesn't change.
  // A MutationObserver re-runs the sweep when the SPA route changes
  // (e.g. user navigates to a server then back to friends).
  //
  // Diagnostic logs (prefix '[dash3d-stream]') get relayed to the
  // main-process terminal via wc.on('console-message'), so the user
  // can `npm run dev` and trace the pipeline without DevTools.
  const _STREAM_NOTIFICATION_INJECT_JS = `
    (() => {
      const LOG = (...a) => { try { console.log('[dash3d-stream]', ...a); } catch (e) {} };
      // Re-installation guard — but we still re-arm on every call so
      // hard reloads pick up the latest patch.
      const wasInstalled = !!window.__dash3dNotifPatched;
      window.__dash3dNotifPatched = true;
      LOG('inject running · bridge?', !!(window.__dash3dStreamBridge && window.__dash3dStreamBridge.notify), 'reinstall?', wasInstalled);
      // ── Notification forward ───────────────────────────────────
      if (window.Notification) {
        const orig = window.__dash3dOrigNotification || window.Notification;
        window.__dash3dOrigNotification = orig;
        function Patched(title, opts) {
          LOG('Notification called · title=', String(title || ''), 'body=', String((opts && opts.body) || ''));
          try {
            if (window.__dash3dStreamBridge && typeof window.__dash3dStreamBridge.notify === 'function') {
              window.__dash3dStreamBridge.notify({
                kind: 'discord',
                title: String(title == null ? '' : title),
                body:  String((opts && opts.body) || ''),
                icon:  String((opts && opts.icon) || ''),
                tag:   String((opts && opts.tag) || ''),
                timestamp: Date.now(),
              });
              LOG('bridge.notify SENT');
            } else {
              LOG('bridge MISSING — message dropped');
            }
          } catch (e) { LOG('bridge.notify error:', e && e.message); }
          return new orig(title, opts);
        }
        // Force-grant: Discord checks Notification.permission BEFORE
        // bothering to call new Notification(). If it's "default" or
        // "denied", Discord just doesn't fire. Override the getter to
        // always return 'granted' so Discord proceeds.
        try {
          Object.defineProperty(Patched, 'permission', { get: () => 'granted', configurable: true });
        } catch (e) {}
        Patched.requestPermission = (cb) => {
          const p = Promise.resolve('granted');
          if (typeof cb === 'function') p.then(cb);
          return p;
        };
        try { Object.setPrototypeOf(Patched, orig); } catch (e) {}
        try { window.Notification = Patched; } catch (e) { LOG('install failed:', e && e.message); }
        LOG('patch installed · Notification.permission=', Patched.permission);
      } else {
        LOG('window.Notification missing — cannot patch');
      }
      // ── Camera state detection ─────────────────────────────────
      // Wrap navigator.mediaDevices.getUserMedia so we can detect
      // when Discord activates the webcam (voice/video call cam
      // toggle). We don't intercept the stream — Discord still gets
      // the real one — we just inspect the resulting video track and
      // forward camera-on / camera-off events to the dashboard. The
      // dashboard's profile-pic slot opens its OWN webcam in
      // parallel via the existing startWebcam() helper.
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia
          && !navigator.mediaDevices.__dash3dGumPatched) {
        navigator.mediaDevices.__dash3dGumPatched = true;
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async function(constraints) {
          const stream = await origGUM(constraints);
          try {
            const reqVideo = constraints && (constraints.video === true ||
              (typeof constraints.video === 'object' && constraints.video !== null));
            const vTracks = stream.getVideoTracks();
            if (reqVideo && vTracks.length > 0) {
              if (window.__dash3dStreamBridge && window.__dash3dStreamBridge.notify) {
                window.__dash3dStreamBridge.notify({ kind: 'camera-state', state: 'on', timestamp: Date.now() });
              }
              LOG('camera ON · forwarding state to dashboard');
              const off = () => {
                try {
                  if (window.__dash3dStreamBridge && window.__dash3dStreamBridge.notify) {
                    window.__dash3dStreamBridge.notify({ kind: 'camera-state', state: 'off', timestamp: Date.now() });
                  }
                  LOG('camera OFF · track ended');
                } catch (e) {}
              };
              vTracks[0].addEventListener('ended', off);
            }
          } catch (e) { LOG('gum patch error', e && e.message); }
          return stream;
        };
        LOG('getUserMedia patched');
      }
      // Diagnostic helper exposed to the page so the user can verify
      // the pipeline end-to-end by typing in DevTools (or via the
      // dashboard test button we wire up below):
      //   window.__dash3dSelfTest('hello from discord');
      window.__dash3dSelfTest = (msg) => {
        if (!window.__dash3dStreamBridge) { LOG('selftest: no bridge'); return false; }
        window.__dash3dStreamBridge.notify({
          kind: 'discord',
          title: 'SELF-TEST',
          body: String(msg || 'test message ' + new Date().toLocaleTimeString()),
          timestamp: Date.now(),
        });
        LOG('selftest sent');
        return true;
      };
      // ── Live message mirror + history sync via DOM observation ──
      // Discord renders each message as <li id="chat-messages-…">.
      // The id pattern is stable across releases; class names rotate.
      //
      // Two phases:
      //   1) On first install, sweep every <li id="chat-messages-…">
      //      already in the DOM. Catches the channel/DM the user has
      //      open when the inject runs (and any history Discord has
      //      already rendered into the viewport).
      //   2) MutationObserver picks up everything added afterward:
      //      new live messages, messages loaded when the user scrolls
      //      up, and the burst of nodes Discord adds when the user
      //      navigates into a previously-unloaded channel.
      //
      // No freshness window — we want the history. The renderer
      // dedupes by messageId so a re-mirror is a no-op visually.
      if (!window.__dash3dMsgObserver) {
        const seen = new Set();
        const SEEN_CAP = 4000;
        function trimSeen() {
          if (seen.size <= SEEN_CAP) return;
          const drop = seen.size - Math.floor(SEEN_CAP / 2);
          let i = 0;
          for (const k of seen) { if (i++ >= drop) break; seen.delete(k); }
        }
        function scrapeRow(li) {
          if (!li || !li.id || !li.id.startsWith('chat-messages-') || seen.has(li.id)) return null;
          seen.add(li.id); trimSeen();
          const authorEl = li.querySelector('[id^="message-username-"]')
            || li.querySelector('h3 span')
            || li.querySelector('[class*="username_"]');
          const contentEl = li.querySelector('[id^="message-content-"]')
            || li.querySelector('[class*="messageContent_"]');
          const timeEl = li.querySelector('time[datetime]');
          const author = authorEl ? (authorEl.textContent || '').trim() : '';
          const content = contentEl ? (contentEl.textContent || '').trim() : '';
          const ts = (timeEl && timeEl.getAttribute('datetime'))
            ? new Date(timeEl.getAttribute('datetime')).getTime()
            : Date.now();
          return { id: li.id, author, content, timestamp: ts };
        }
        function emit(msg) {
          if (!msg || !msg.content) return;
          try {
            if (window.__dash3dStreamBridge && window.__dash3dStreamBridge.notify) {
              window.__dash3dStreamBridge.notify({
                kind: 'discord',
                type: 'message',
                messageId: msg.id,
                title: msg.author || 'Discord',
                body: msg.content,
                timestamp: msg.timestamp,
              });
            }
          } catch (e) { LOG('msg send err', e && e.message); }
        }
        // Live phase — observe DOM mutations
        const mo = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (!node || node.nodeType !== 1) continue;
              if (node.id && node.id.startsWith('chat-messages-')) {
                emit(scrapeRow(node));
              }
              if (node.querySelectorAll) {
                const subs = node.querySelectorAll('li[id^="chat-messages-"]');
                for (const sub of subs) emit(scrapeRow(sub));
              }
            }
          }
        });
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
        window.__dash3dMsgObserver = mo;
        // Initial sweep — capture anything Discord has already rendered.
        // Run a few times with backoff because Discord's React mount is
        // async and the chat list may not be in the DOM yet on first
        // tick. Each sweep dedupes via the seen-set so repeats are free.
        // Returns { rowsInDom, newlyEmitted } so the manual FETCH
        // button can surface diagnostic info to the user.
        function initialSweep() {
          const rows = document.querySelectorAll('li[id^="chat-messages-"]');
          let n = 0;
          for (const li of rows) {
            const msg = scrapeRow(li);
            if (msg && msg.content) { emit(msg); n++; }
          }
          if (n) LOG('sweep emitted ' + n + ' new messages (' + rows.length + ' rows in DOM)');
          return { rowsInDom: rows.length, newlyEmitted: n };
        }
        [200, 700, 1800, 4000].forEach((d) => setTimeout(initialSweep, d));
        // Also expose a manual rescan for the dashboard's FETCH
        // button. The returned object surfaces both how many message
        // rows are CURRENTLY in the DOM (i.e. is a conversation
        // even open?) and how many of those were NEW (i.e. not
        // already mirrored). Lets the user diagnose whether they
        // need to click into a DM first vs. nothing-to-sync.
        window.__dash3dRescan = initialSweep;
        LOG('message observer started · sweeping initial DOM');
      }
      // ── Text-content fallback hide: Nitro / Shop / Quests ──────
      // The sidebar item is usually <a> with a single text node
      // inside a nested div. Match exact text (case-insensitive,
      // trimmed) to avoid hiding e.g. "Nitro Boost #general".
      const HIDE = new Set(['nitro', 'shop', 'quests', 'discovery']);
      function sweepHide() {
        const selectors = ['a', 'li', 'div[role="link"]', 'div[role="button"]', '[class*="channel_"]'];
        const seen = document.querySelectorAll(selectors.join(','));
        for (const el of seen) {
          if (el.dataset && el.dataset.dash3dHidden) continue;
          // Examine direct text (not descendants') so we don't match
          // a Nitro upsell embedded inside a channel name.
          const t = (el.textContent || '').trim().toLowerCase();
          if (t.length > 0 && t.length < 25 && HIDE.has(t)) {
            el.style.setProperty('display', 'none', 'important');
            if (el.dataset) el.dataset.dash3dHidden = '1';
          }
        }
      }
      sweepHide();
      try {
        const mo = new MutationObserver(() => sweepHide());
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    })();
  `;

  // ── Per-kind STREAM configs ─────────────────────────────────────
  // Each entry describes one embedded service. The plumbing
  // (BrowserView creation, permission/display-media handlers,
  // notification monkey-patch, camera-state detection, console-
  // message relay, theme reinjection) is identical across kinds —
  // only URL, theme builder, and internal-domain regex differ.
  const _STREAM_KINDS = {
    discord: {
      url: 'https://discord.com/app',
      label: 'DISCORD',
      buildThemeCSS: _buildDiscordThemeCSS,
      // External-link policy: anything not on discord.com opens in
      // the OS default browser instead of inside the embed.
      internalDomain: /(^|\.)discord\.com$/,
    },
    facebook: {
      // Default to facebook.com (gives access to Messenger via the
      // built-in sidebar). User can navigate to messenger.com from
      // there if they want a dedicated chat surface.
      url: 'https://www.facebook.com',
      label: 'FACEBOOK',
      buildThemeCSS: _buildFacebookThemeCSS,
      internalDomain: /(^|\.)(facebook|messenger|fb)\.com$/,
    },
  };

  function _streamGetOrCreate(kind) {
    if (_streamViews.has(kind)) return _streamViews.get(kind);
    const config = _STREAM_KINDS[kind];
    if (!config) return null;
    const partition = 'persist:stream-' + kind;
    const view = new BrowserView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, 'stream-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // preload needs Node `require` for ipcRenderer
        webSecurity: true,
      },
    });
    const wc = view.webContents;
    try { wc.setUserAgent(_STREAM_CHROME_UA); } catch {}

    // ── Permissions (universal across kinds) ────────────────────
    // Auto-grant the four permissions modern web chat surfaces ask
    // for: desktop notifications, camera+mic, screen capture, DRM.
    const STREAM_PERMS = new Set(['notifications', 'media', 'display-capture', 'mediaKeySystem']);
    try {
      wc.session.setPermissionRequestHandler((_wc, permission, cb, details) => {
        const allow = STREAM_PERMS.has(permission);
        console.log('[stream:' + kind + '] perm request', permission, '→', allow, details ? Object.keys(details).join(',') : '');
        cb(allow);
      });
      wc.session.setPermissionCheckHandler((_wc, permission) => STREAM_PERMS.has(permission));
    } catch (err) { console.warn('[stream:' + kind + '] perm handler setup failed:', err.message); }

    // ── Display-media handler (universal) ────────────────────────
    // Auto-pick primary screen + loopback audio when the embed
    // calls getDisplayMedia() ("Share your screen"). Falls back to
    // video-only if loopback audio is rejected on this session.
    try {
      if (typeof wc.session.setDisplayMediaRequestHandler === 'function') {
        wc.session.setDisplayMediaRequestHandler((request, callback) => {
          console.log('[stream:' + kind + '] getDisplayMedia called · audio=', request?.audio, 'video=', request?.video);
          desktopCapturer.getSources({ types: ['screen', 'window'] })
            .then((sources) => {
              console.log('[stream:' + kind + '] desktopCapturer returned', sources?.length || 0, 'sources');
              if (!sources || !sources.length) {
                console.warn('[stream:' + kind + '] no sources — Share Screen will produce empty stream');
                return callback({});
              }
              const pick = sources.find((s) => s.id && s.id.startsWith('screen:')) || sources[0];
              console.log('[stream:' + kind + '] handing source:', pick.id, '·', pick.name);
              const stream = request?.audio
                ? { video: pick, audio: 'loopback' }
                : { video: pick };
              try { callback(stream); }
              catch (err) {
                console.warn('[stream:' + kind + '] callback with loopback audio failed, retrying video-only:', err.message);
                try { callback({ video: pick }); } catch (e2) { console.error('[stream:' + kind + '] callback fully failed:', e2.message); }
              }
            })
            .catch((err) => {
              console.error('[stream:' + kind + '] desktopCapturer failed:', err.message);
              callback({});
            });
        });
        console.log('[stream:' + kind + '] setDisplayMediaRequestHandler installed');
      }
    } catch (err) { console.warn('[stream:' + kind + '] display-media handler setup failed:', err.message); }

    // ── Console-message relay (universal) ────────────────────────
    // Surfaces [dash3d-stream]-prefixed logs from the embed's page
    // world in the main-process terminal so npm-run-dev can trace
    // the inject pipeline without DevTools on the BV.
    wc.on('console-message', (_e, _level, message) => {
      if (typeof message === 'string' && message.startsWith('[dash3d-stream]')) {
        console.log('[' + kind + '-page]', message);
      }
    });

    // ── Theme + monkey-patch reinjection (kind-specific theme,
    //    universal notification + camera-state patch) ─────────────
    const reapply = async (freshLoad) => {
      try {
        const prevKey = _streamCssKey.get(kind);
        if (prevKey) { try { await wc.removeInsertedCSS(prevKey); } catch {} }
        const themeCss = config.buildThemeCSS(_streamPalette);
        const key = await wc.insertCSS(themeCss);
        _streamCssKey.set(kind, key);
      } catch (err) { console.warn('[stream:' + kind + '] insertCSS failed:', err.message); }
      // Invert is a separate, explicitly-managed stylesheet (see
      // _applyEmbedInvert) so the theme reapply churn above can't strand
      // a stale invert layer. freshLoad=true means a real page load just
      // cleared inserted CSS, so the invert must be re-inserted.
      try { await _applyEmbedInvert(wc, !!freshLoad, _streamPalette && _streamPalette.eink); } catch {}
      try { await wc.executeJavaScript(_STREAM_NOTIFICATION_INJECT_JS, /* userGesture */ false); }
      catch (err) { console.warn('[stream:' + kind + '] notif inject failed:', err.message); }
    };
    // stream:show re-themes without a page reload — invert persists, so
    // pass freshLoad=false. Real load events clear inserted CSS → true.
    view._streamReapply = () => reapply(false);
    wc.on('dom-ready', () => reapply(true));
    wc.on('did-finish-load', () => reapply(true));
    wc.on('did-frame-finish-load', (_e, isMainFrame) => { if (isMainFrame) reapply(true); });
    wc.loadURL(config.url).catch((err) => {
      console.warn('[stream:' + kind + '] loadURL failed:', err.message);
    });

    // External links open in the OS default browser; internal
    // navigation stays inside the embed.
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (!config.internalDomain.test(u.hostname)) {
          shell.openExternal(url);
          return { action: 'deny' };
        }
      } catch {}
      return { action: 'deny' };
    });
    _streamViews.set(kind, view);
    return view;
  }

  // Bounds from the renderer arrive as FRACTIONS (0..1) of the
  // dashboard viewport — see _streamApplyBounds for the DIP conversion.
  // The palette is the live dashboard theme tokens, plumbed through so
  // the Discord embed retints when the user switches dashboard themes.
  ipcMain.handle('stream:show', (_e, opts) => {
    const kind = String(opts?.kind || 'discord');
    const bounds = opts?.bounds;
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
      _streamBounds = {
        x: Number(bounds.x) || 0,
        y: Number(bounds.y) || 0,
        width:  Math.max(0, Number(bounds.width)),
        height: Math.max(0, Number(bounds.height)),
      };
    }
    if (opts?.palette && typeof opts.palette === 'object') {
      _streamPalette = opts.palette;
    }
    if (!_mainWin || _mainWin.isDestroyed()) return { ok: false, error: 'window destroyed' };
    const view = _streamGetOrCreate(kind);
    // Detach whatever is currently shown if it's a different kind.
    if (_streamActive && _streamActive !== kind) {
      const cur = _streamViews.get(_streamActive);
      try { if (cur) _mainWin.removeBrowserView(cur); } catch {}
    }
    try { _mainWin.addBrowserView(view); } catch {}
    _streamApplyBounds(view);
    // Re-apply the themed CSS with the (possibly new) palette. If the
    // page hasn't finished loading yet the did-finish-load handler in
    // _streamGetOrCreate will run reapply on its own.
    if (typeof view._streamReapply === 'function') {
      try { view._streamReapply(); } catch {}
    }
    _streamActive = kind;
    return { ok: true, kind };
  });
  ipcMain.handle('stream:hide', () => {
    if (!_streamActive) return { ok: true };
    if (!_mainWin || _mainWin.isDestroyed()) return { ok: true };
    const view = _streamViews.get(_streamActive);
    try { if (view) _mainWin.removeBrowserView(view); } catch {}
    _streamActive = null;
    return { ok: true };
  });
  ipcMain.handle('stream:bounds', (_e, bounds) => {
    if (!bounds) return { ok: false };
    _streamBounds = {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width:  Math.max(0, Number(bounds.width)  || 0),
      height: Math.max(0, Number(bounds.height) || 0),
    };
    if (_streamActive) {
      const view = _streamViews.get(_streamActive);
      if (view) _streamApplyBounds(view);
    }
    return { ok: true };
  });
  ipcMain.handle('stream:reload', (_e, kind) => {
    const k = String(kind || _streamActive || 'discord');
    const view = _streamViews.get(k);
    if (view) try { view.webContents.reload(); } catch {}
    return { ok: true };
  });
  // Manual fetch: tells the inject script to re-sweep the embed's
  // current DOM for chat-messages rows and emit any not-yet-seen
  // ones. Returns { rowsInDom, newlyEmitted } so the renderer can
  // give the user diagnostic feedback (e.g. "no rows in DOM" means
  // they need to click into a DM/channel first).
  ipcMain.handle('stream:rescan', async (_e, kind) => {
    const k = String(kind || 'discord');
    const view = _streamViews.get(k);
    if (!view) return { ok: false, error: 'view not mounted · open STREAM tab first' };
    try {
      const result = await view.webContents.executeJavaScript(
        `(typeof window.__dash3dRescan === 'function') ? window.__dash3dRescan() : null`,
        false
      );
      if (!result) return { ok: false, error: 'inject script not running · reload STREAM tab' };
      return { ok: true, rowsInDom: Number(result.rowsInDom) || 0, newlyEmitted: Number(result.newlyEmitted) || 0 };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Pipeline self-test: triggers the inject-script's __dash3dSelfTest
  // helper inside the Discord BrowserView. This fires a fake notify()
  // through the bridge → main relay → renderer, so the user can
  // verify each hop is wired without needing someone to actually DM
  // them on Discord.
  ipcMain.handle('stream:self-test', async (_e, kind) => {
    const k = String(kind || 'discord');
    const view = _streamViews.get(k);
    if (!view) return { ok: false, error: 'view not mounted (open STREAM tab first)' };
    try {
      const installed = await view.webContents.executeJavaScript(
        `(typeof window.__dash3dSelfTest === 'function') ? window.__dash3dSelfTest('pipeline check ' + new Date().toLocaleTimeString()) : 'no-inject'`,
        false
      );
      return { ok: installed === true, result: installed };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Open DevTools on the Discord BV — useful for diagnosing
  // notification flow when the inject script can't be inspected
  // through the page's own console.
  ipcMain.handle('stream:open-devtools', (_e, kind) => {
    const k = String(kind || _streamActive || 'discord');
    const view = _streamViews.get(k);
    if (!view) return { ok: false, error: 'view not mounted' };
    try { view.webContents.openDevTools({ mode: 'detach' }); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  // Relay notifications from the BV's preload bridge to the dashboard
  // renderer. Use ipcMain.on (not .handle) since this is fire-and-
  // forget — the BV doesn't await a reply.
  ipcMain.on('stream:notification', (_e, payload) => {
    if (!payload || typeof payload !== 'object') {
      console.log('[stream:notification] main · dropped (invalid payload)');
      return;
    }
    if (!_mainWin || _mainWin.isDestroyed()) {
      console.log('[stream:notification] main · dropped (no window)');
      return;
    }
    // camera-state events have their own minimal shape; pass through
    // verbatim so the renderer can route to startWebcam/stopWebcam.
    if (payload.kind === 'camera-state') {
      console.log('[stream:notification] main · camera-state =', payload.state);
      try {
        _mainWin.webContents.send('stream:notification', {
          kind: 'camera-state',
          state: String(payload.state || 'off'),
          timestamp: Number(payload.timestamp) || Date.now(),
        });
      } catch (err) {
        console.warn('[stream:notification] main · send failed:', err.message);
      }
      return;
    }
    console.log('[stream:notification] main · relaying', JSON.stringify({ title: payload.title, body: payload.body }).slice(0, 200));
    try {
      _mainWin.webContents.send('stream:notification', {
        kind:      String(payload.kind || 'discord'),
        type:      String(payload.type || 'notification'),
        messageId: String(payload.messageId || ''),
        title:     String(payload.title || ''),
        body:      String(payload.body  || ''),
        icon:      String(payload.icon  || ''),
        tag:       String(payload.tag   || ''),
        timestamp: Number(payload.timestamp) || Date.now(),
      });
    } catch (err) {
      console.warn('[stream:notification] main · send failed:', err.message);
    }
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

  // Power off / restart the host — the appliance power menu. Like
  // system-sleep, gated by a native confirm dialog so a stray click can't
  // drop the session. On the Linux appliance these are systemctl calls;
  // elsewhere the platform's own shutdown tool.
  ipcMain.handle('system-power', async (_e, action) => {
    if (action !== 'poweroff' && action !== 'reboot') {
      return { ok: false, error: `unknown power action: ${action}` };
    }
    const win = _mainWin || BrowserWindow.fromWebContents(_e.sender);
    const isOff = action === 'poweroff';
    try {
      const { dialog } = require('electron');
      const r = await dialog.showMessageBox(win || undefined, {
        type: 'warning',
        buttons: [isOff ? 'Power Off' : 'Restart', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: isOff ? 'Power Off' : 'Restart',
        message: isOff ? 'Power off this PC?' : 'Restart this PC?',
        detail: 'All running apps will be closed.',
      });
      if (r.response !== 0) return { ok: false, cancelled: true };
    } catch {}
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'shutdown';
      args = isOff ? ['/s', '/t', '0'] : ['/r', '/t', '0'];
    } else if (process.platform === 'linux') {
      cmd = 'systemctl';
      args = [isOff ? 'poweroff' : 'reboot'];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', `tell application "System Events" to ${isOff ? 'shut down' : 'restart'}`];
    } else {
      return { ok: false, error: `unsupported platform: ${process.platform}` };
    }
    try {
      const proc = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
      proc.unref();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Game Mode (Linux appliance) — write a flag the session script
  // watches, then quit. When the dashboard's gamescope exits, the
  // session loop sees the flag and launches Steam Big Picture; when
  // Steam exits it loops back to the dashboard.
  ipcMain.handle('game-mode', () => {
    if (process.platform !== 'linux') {
      return { ok: false, error: 'Game Mode is available on the Linux appliance only' };
    }
    // Hand off WITHOUT relying on Electron exiting itself — app.quit(),
    // app.exit() and process.exit() all hung under gamescope, and an
    // external `pkill` BY NAME never reliably matched. So: drop the flag
    // the session loop watches for, then SIGKILL this process by its own
    // pid. SIGKILL is uncatchable and needs no name match; gamescope was
    // launched as `gamescope -- dashboard3d`, so when this child dies
    // gamescope exits and the session loop runs Steam Big Picture.
    try {
      require('fs').writeFileSync('/tmp/dashboard3d-gamemode', '1');
    } catch (err) {
      return { ok: false, error: 'could not arm Game Mode: ' + err.message };
    }
    // Delay briefly so this {ok:true} reply reaches the renderer first.
    setTimeout(() => {
      try {
        // Also sweep any child Electron processes (renderer/GPU) so none
        // linger on the GPU once gamescope is gone — best effort.
        require('child_process')
          .spawn('/bin/sh', ['-c', 'pkill -KILL -x dashboard3d'],
            { detached: true, stdio: 'ignore' }).unref();
      } catch (_) { /* best effort */ }
      try { process.kill(process.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
    }, 200);
    return { ok: true };
  });

  // App launcher (appliance) — pick an executable via the native file
  // dialog. Used so the dashboard-as-shell can pin and start other
  // programs when there is no Start menu / taskbar.
  ipcMain.handle('launcher-pick', async (_e) => {
    const win = _mainWin || BrowserWindow.fromWebContents(_e.sender);
    try {
      const { dialog } = require('electron');
      const filters = process.platform === 'win32'
        ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] },
           { name: 'All Files', extensions: ['*'] }]
        : [{ name: 'All Files', extensions: ['*'] }];
      const r = await dialog.showOpenDialog(win || undefined, {
        title: 'Pick a program',
        properties: ['openFile'],
        filters,
      });
      if (r.canceled || !r.filePaths?.length) return { ok: false, cancelled: true };
      const file = r.filePaths[0];
      const name = require('path').basename(file).replace(/\.(exe|bat|cmd|lnk)$/i, '');
      return { ok: true, path: file, name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Spawn a launcher entry. Detached + unref so the child outlives a
  // dashboard restart; Windows .lnk shortcuts go through the shell since
  // they are not directly executable.
  ipcMain.handle('launcher-run', async (_e, appDef) => {
    const exec = appDef && typeof appDef.exec === 'string' ? appDef.exec.trim() : '';
    if (!exec) return { ok: false, error: 'no executable' };
    const args = Array.isArray(appDef.args) ? appDef.args.map(String) : [];
    try {
      if (process.platform === 'win32' && /\.lnk$/i.test(exec)) {
        const err = await shell.openPath(exec);
        return err ? { ok: false, error: err } : { ok: true };
      }
      let failed = null;
      const proc = spawn(exec, args, { windowsHide: false, detached: true, stdio: 'ignore' });
      proc.on('error', (e) => { failed = e; });
      proc.unref();
      // Give spawn a tick to surface ENOENT before reporting success.
      await new Promise((res) => setTimeout(res, 120));
      return failed ? { ok: false, error: failed.message } : { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
  // ── WiFi on Linux (the appliance) ───────────────────────────────
  // The appliance ships NetworkManager; `nmcli` drives scan/connect/
  // status. Args are passed to execFile as an array (no shell) so the
  // SSID/password cannot be command-injected.
  function _runCmd(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 20000, ...opts }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
      });
    });
  }
  // nmcli -t (terse) separates fields with ':' and backslash-escapes any
  // literal ':' or '\' inside a field. Split on unescaped ':' then unescape.
  function _nmcliSplit(line) {
    return line.split(/(?<!\\):/).map((f) => f.replace(/\\(.)/g, '$1'));
  }
  async function _wifiStatusLinux() {
    const r = await _runCmd('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi']);
    if (!r.ok) return { connected: false, ssid: null, error: (r.stderr || '').trim() || 'nmcli failed' };
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const [active, ssid, signal] = _nmcliSplit(line);
      if (active === 'yes') {
        return { connected: true, ssid: ssid || '', signal: signal ? `${signal}%` : '', state: 'connected' };
      }
    }
    return { connected: false, ssid: null, state: 'disconnected' };
  }
  async function _wifiScanLinux() {
    try { await _runCmd('nmcli', ['device', 'wifi', 'rescan']); } catch {}
    const r = await _runCmd('nmcli', ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list']);
    if (!r.ok) return { networks: [], error: (r.stderr || '').trim() || 'nmcli failed' };
    const map = new Map();
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const [ssid, signal, security] = _nmcliSplit(line);
      if (!ssid) continue;
      const sig = parseInt(signal, 10) || 0;
      const prev = map.get(ssid);
      if (!prev || sig > prev.signal) {
        map.set(ssid, { ssid, signal: sig, auth: security || '', encryption: security || '' });
      }
    }
    return { networks: [...map.values()].sort((a, b) => b.signal - a.signal) };
  }
  async function _wifiConnectLinux(ssid, password) {
    if (!ssid) return { ok: false, error: 'ssid required' };
    const args = ['device', 'wifi', 'connect', ssid];
    if (password) args.push('password', password);
    const r = await _runCmd('nmcli', args, { timeout: 45000 });
    if (r.ok) return { ok: true };
    return { ok: false, error: (r.stderr || r.stdout || 'connection failed').trim() };
  }

  ipcMain.handle('wifi-status', async () => {
    if (process.platform === 'linux') return await _wifiStatusLinux();
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
    if (process.platform === 'linux') return await _wifiScanLinux();
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
    if (process.platform === 'linux') return await _wifiConnectLinux(ssid, password);
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
  ipcMain.handle('music-path',     () => musicFolderPath());

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
  ipcMain.handle('music-list',     listFolder(musicFolderPath));

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

    // Output path: gallery/videos/<USER> NNNN.<ext>. Prefix uses the
    // configured userName (cfg.userName) when set, else literal "USER".
    // Counter auto-increments across runs by scanning existing files.
    const dir = path.join(galleryFolderPath(), 'videos');
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
  // <gallery>/videos/ so processed output is separate from live screen
  // records (which still go to <gallery>/recordings/).
  ipcMain.handle('process-snaps-save', async (_e, bytes, ext) => {
    try {
      const dir = path.join(galleryFolderPath(), 'videos');
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

  // yt:get-audio-stream — audio-only stream URL for the browser's
  // AUDIO ONLY mode. yt-client's getStreamUrl picks combined a+v;
  // we need a direct `bestaudio` URL so we can play just the audio
  // and skip downloading/decoding the video stream entirely.
  // Returns { ok, url, title?, duration? }. Title comes from a
  // parallel --dump-json call so the renderer can show a status chip.
  ipcMain.handle('yt:get-audio-stream', async (_e, url) => {
    if (!url) return { ok: false, error: 'no url' };
    let bin;
    try { bin = yt.resolveBin ? yt.resolveBin() : null; } catch (err) { return { ok: false, error: err.message }; }
    if (!bin) return { ok: false, error: 'yt-dlp binary not found' };
    const run = (args) => new Promise((resolve) => {
      const proc = spawn(bin, args, { windowsHide: true });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      proc.on('error', (err) => resolve({ code: -1, err: err.message }));
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    // Run the URL fetch and metadata fetch in parallel.
    const [stream, meta] = await Promise.all([
      run(['-f', 'bestaudio/best', '-g', '--no-warnings', '--no-call-home', url]),
      run(['--dump-json', '--no-warnings', '--no-call-home', '--skip-download', url]),
    ]);
    if (stream.code !== 0 || !stream.stdout?.trim()) {
      return { ok: false, error: stream.stderr?.trim().slice(-300) || 'yt-dlp failed' };
    }
    let title, duration;
    try {
      const j = JSON.parse(meta.stdout.split('\n').find(l => l.trim().startsWith('{')) || '{}');
      title    = j.title    || undefined;
      duration = j.duration || undefined;
    } catch {}
    return { ok: true, url: stream.stdout.trim(), title, duration };
  });

  // Active-tab probe — for the renderer's AUDIO ONLY mode. Returns the
  // current URL + currentTime of the playing video, so the renderer
  // can extract the audio stream and start it at the same offset.
  ipcMain.handle('browser-get-active-state', async () => {
    const id = _bvActiveId;
    if (id == null) return { ok: false, error: 'no active tab' };
    const t = _bvTabs.get(id);
    const wc = t?.view?.webContents;
    if (!wc) return { ok: false, error: 'no webContents' };
    const url = (() => { try { return wc.getURL(); } catch { return ''; } })();
    let videoTime = 0, hasVideo = false;
    try {
      const r = await wc.executeJavaScript(`(function(){
        var v = document.querySelector('video');
        if (!v) return { hasVideo: false, t: 0 };
        return { hasVideo: true, t: v.currentTime || 0 };
      })();`, true);
      hasVideo  = !!r?.hasVideo;
      videoTime = Number(r?.t) || 0;
    } catch {}
    return { ok: true, url, hasVideo, videoTime };
  });

  // Pause + hide the BV's video so the GPU stops decoding frames.
  // `display:none` on the <video> element prevents Chromium from
  // painting and skips the decode pipeline; `pause()` halts the
  // media element's network/CPU work entirely. Returns the currentTime
  // so the caller can sync an external audio source.
  ipcMain.handle('browser-pause-video', async () => {
    const id = _bvActiveId;
    if (id == null) return { ok: false };
    const t = _bvTabs.get(id);
    const wc = t?.view?.webContents;
    if (!wc) return { ok: false };
    try {
      const r = await wc.executeJavaScript(`(function(){
        var v = document.querySelector('video');
        if (!v) return { t: 0 };
        var t = v.currentTime || 0;
        try { v.pause(); } catch (e) {}
        // Save original display so we can restore on resume.
        if (v.dataset.__dash3dOrigDisplay === undefined) {
          v.dataset.__dash3dOrigDisplay = v.style.display || '';
        }
        v.style.display = 'none';
        return { t: t };
      })();`, true);
      return { ok: true, t: Number(r?.t) || 0 };
    } catch {
      return { ok: false };
    }
  });

  // Inverse — restore the video's display, seek to the given time,
  // and resume playback. If `t` is provided we seek there first so
  // the video picks up where the audio left off.
  ipcMain.handle('browser-resume-video', async (_e, t) => {
    const id = _bvActiveId;
    if (id == null) return { ok: false };
    const tab = _bvTabs.get(id);
    const wc = tab?.view?.webContents;
    if (!wc) return { ok: false };
    const seekTo = Number.isFinite(Number(t)) ? Number(t) : null;
    try {
      await wc.executeJavaScript(`(function(){
        var v = document.querySelector('video');
        if (!v) return false;
        if (v.dataset.__dash3dOrigDisplay !== undefined) {
          v.style.display = v.dataset.__dash3dOrigDisplay;
          delete v.dataset.__dash3dOrigDisplay;
        } else {
          v.style.display = '';
        }
        ${seekTo != null ? `try { v.currentTime = ${seekTo}; } catch (e) {}` : ''}
        try { v.play(); } catch (e) {}
        return true;
      })();`, true);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

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
