const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, utilityProcess, webContents } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile, spawn, exec } = require('child_process');
const si = require('systeminformation');

const HTTP_PORT = 7373;
const isDev = !!process.env.VITE_DEV_SERVER_URL;

// ─── SHARED UTILITIES ──────────────────────────────────────────────

// Run a one-off PowerShell command, parse its stdout as JSON. Resolves
// to null on spawn error, non-zero exit, or invalid JSON. Used by disk,
// thermal, and storage probes that all share the same shape.
function runPowerShell(script, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try { resolve(JSON.parse(stdout || 'null')); }
        catch { resolve(null); }
      },
    );
  });
}

// Primary display's work area = screen bounds minus taskbar reserve.
function getWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

// Locate bundled LibreHardwareMonitor.exe. Production: tools\ next to
// Dashboard3D.exe. Dev: tools\ inside the win32-x64 bundle in the repo.
function findBundledLhm() {
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), 'tools', 'LibreHardwareMonitor', 'LibreHardwareMonitor.exe'),
    path.join(__dirname, '..', '..', 'Dashboard3D-win32-x64', 'tools', 'LibreHardwareMonitor', 'LibreHardwareMonitor.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Auto-start the patched LHM once on dashboard launch. Skips if already
// running (tasklist check) since LHM happily allows duplicate instances.
// Start-Process -Verb RunAs triggers the one UAC prompt LHM needs to
// read CPU MSRs.
function autoLaunchSensors() {
  const exe = findBundledLhm();
  if (!exe) return;
  execFile('tasklist', ['/FI', 'IMAGENAME eq LibreHardwareMonitor.exe', '/NH'],
    { windowsHide: true }, (err, stdout) => {
      if (!err && stdout && /LibreHardwareMonitor\.exe/i.test(stdout)) return;
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Minimized`],
        { windowsHide: true }, () => {});
    });
}

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
      webviewTag: true, // enables the <webview> used by the in-panel browser
    },
  });

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

  // Native WASAPI loopback for the default output device. Pushes per-frame
  // RMS levels to the renderer over IPC ('audio-out-level').
  win.webContents.once('did-finish-load', () => startWasapiLoopback(win));
  win.on('closed', stopWasapiLoopback);
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

// ─── AUDIO LOOPBACK WORKER (audify) ────────────────────────────────
// Loaded in a utilityProcess child so a native crash in the binding
// can't take down the main process. Set DASH3D_DISABLE_AUDIFY=1 to
// skip starting the worker entirely.
let _audioProc = null;
let _audioWin = null;
function startWasapiLoopback(win, deviceId = null) {
  if (process.platform !== 'win32') return;
  if (process.env.DASH3D_DISABLE_AUDIFY) return;
  if (_audioProc) return;
  _audioWin = win;

  const workerPath = path.join(__dirname, 'audify-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.warn('audify worker missing at', workerPath);
    return;
  }

  // Persisted config takes precedence over the env-var override only if the
  // env var isn't set, so DASH3D_AUDIO_DEVICE_ID is still an escape hatch.
  let chosenId = deviceId;
  if (chosenId == null && !process.env.DASH3D_AUDIO_DEVICE_ID) {
    try { chosenId = readConfig()?.audioDeviceId ?? null; } catch {}
  }

  const env = { ...process.env };
  if (chosenId != null) env.DASH3D_AUDIO_DEVICE_ID = String(chosenId);

  try {
    _audioProc = utilityProcess.fork(workerPath, [], {
      stdio: 'pipe',
      serviceName: 'dash3d-audify',
      env,
    });
  } catch (err) {
    console.error('utilityProcess.fork failed:', err.message);
    _audioProc = null;
    return;
  }

  _audioProc.stdout?.on('data', (b) => process.stdout.write(`[audify] ${b}`));
  _audioProc.stderr?.on('data', (b) => process.stderr.write(`[audify] ${b}`));

  _audioProc.on('message', (data) => {
    if (data?.status === 'started') {
      console.log(`WASAPI loopback started on "${data.deviceName}" (${data.sampleRate}Hz, ${data.channels}ch)`);
    }
    if (_audioWin && !_audioWin.isDestroyed()) {
      _audioWin.webContents.send('audio-out-level', data);
    }
  });

  _audioProc.on('exit', (code) => {
    console.log('audify worker exited code', code);
    if (_audioWin && !_audioWin.isDestroyed()) {
      _audioWin.webContents.send('audio-out-level', { error: `worker exit ${code}` });
    }
    _audioProc = null;
  });
}

function stopWasapiLoopback() {
  if (!_audioProc) return;
  try { _audioProc.postMessage('stop'); } catch {}
  const p = _audioProc;
  setTimeout(() => { try { p.kill(); } catch {} }, 200);
  _audioProc = null;
}

function restartWasapiLoopback(win, deviceId) {
  stopWasapiLoopback();
  // Small gap so WASAPI fully releases the prior endpoint.
  setTimeout(() => startWasapiLoopback(win, deviceId), 350);
}

// System-level mute via Windows Core Audio (IAudioEndpointVolume). Lets the
// dashboard mute buttons silence the OS device, not just our analyser.
// dataFlow: 0 = render (speakers), 1 = capture (mic). Compiles the C# COM
// wrapper once per PowerShell session via Add-Type — `if ('DashAudio.Endpoint'
// -as [type])` skips the recompile after the first call in a session.
// Inline C# COM wrapper for IAudioEndpointVolume. Compiled once per
// PowerShell session via `if (-not ... -as [type])`. Used by both
// setSystemMute and getSystemMuteStates so they share the same code.
const _SYSTEM_AUDIO_CS = `
$ErrorActionPreference = 'Stop'
if (-not ('DashAudio.Endpoint' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace DashAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorComObject {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAEV {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr p);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
    [PreserveSig] int GetChannelCount(out uint c);
    [PreserveSig] int SetMasterVolumeLevel(float l, ref Guid g);
    [PreserveSig] int SetMasterVolumeLevelScalar(float l, ref Guid g);
    [PreserveSig] int GetMasterVolumeLevel(out float l);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float l);
    [PreserveSig] int SetChannelVolumeLevel(uint c, float l, ref Guid g);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint c, float l, ref Guid g);
    [PreserveSig] int GetChannelVolumeLevel(uint c, out float l);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint c, out float l);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid g);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  public static class Endpoint {
    static IAEV Get(int dataFlow) {
      var enu = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject() as object);
      IMMDevice dev; enu.GetDefaultAudioEndpoint(dataFlow, 1, out dev);
      Guid iid = typeof(IAEV).GUID; object o;
      dev.Activate(ref iid, 0x17, IntPtr.Zero, out o);
      return (IAEV)o;
    }
    public static void SetMute(int dataFlow, bool mute) {
      Guid g = Guid.Empty; Get(dataFlow).SetMute(mute, ref g);
    }
    public static bool GetMute(int dataFlow) {
      bool m; Get(dataFlow).GetMute(out m); return m;
    }
  }
}
"@
}
`.trim();

function setSystemMute(dataFlow, mute) {
  const ps = `
${_SYSTEM_AUDIO_CS}
try {
  [DashAudio.Endpoint]::SetMute(${dataFlow}, $${mute ? 'true' : 'false'})
  $m = [DashAudio.Endpoint]::GetMute(${dataFlow})
  ConvertTo-Json -Compress @{ ok = $true; muted = $m }
} catch {
  ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message }
}
  `.trim();
  return runPowerShell(ps, { timeout: 8000 });
}

// Read both mute states in a single PowerShell spawn so the renderer can
// poll cheaply and notice if the user toggled mute via keyboard / volume
// mixer / etc — keeps our button state in sync with reality.
// Switch the OS default audio endpoint via IPolicyConfig (the same COM
// path Windows' own Sound control panel uses). Looks up the active endpoint
// by friendly-name match against the registry's MMDevices store — avoids
// the PROPVARIANT marshaling that direct IMMDevice property reads need.
// dataFlow: 0 = render (speakers), 1 = capture (mic). Sets all three roles
// (eConsole/eMultimedia/eCommunications) so apps that pin to Communications
// also follow.
function setDefaultEndpoint(dataFlow, namePattern) {
  const psPattern = `'${String(namePattern || '').replace(/'/g, "''")}'`;
  const subkey   = dataFlow === 1 ? "'Capture'" : "'Render'";
  const idPrefix = dataFlow === 1 ? "'{0.0.1.00000000}.'" : "'{0.0.0.00000000}.'";
  const ps = `
$ErrorActionPreference = 'Stop'
if (-not ('DashAudio.PolicyConfig' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace DashAudio {
  [Guid("568b9108-44bf-40b4-9006-86afe5b5a620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPolicyConfigVista {
    [PreserveSig] int _0(IntPtr a, IntPtr b);
    [PreserveSig] int _1(IntPtr a, int b, IntPtr c);
    [PreserveSig] int _2(IntPtr a);
    [PreserveSig] int _3(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int _4(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int _5(IntPtr a, IntPtr b);
    [PreserveSig] int _6(IntPtr a, IntPtr b);
    [PreserveSig] int _7(IntPtr a, IntPtr b);
    [PreserveSig] int _8(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int _9(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, uint role);
    [PreserveSig] int _11(IntPtr a, bool b);
  }
  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  internal class PolicyConfigClient {}
  public static class PolicyConfig {
    public static int SetDefault(string deviceId) {
      var pc = (IPolicyConfigVista)(new PolicyConfigClient() as object);
      int hr0 = pc.SetDefaultEndpoint(deviceId, 0);
      int hr1 = pc.SetDefaultEndpoint(deviceId, 1);
      int hr2 = pc.SetDefaultEndpoint(deviceId, 2);
      return hr0 | hr1 | hr2;
    }
  }
}
"@
}
$base = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\${subkey.replace(/'/g, '')}"
$prefix = ${idPrefix}
$pattern = ${psPattern}
$endpoints = @()
try {
  $endpoints = Get-ChildItem $base -ErrorAction Stop | ForEach-Object {
    $state = (Get-ItemProperty -Path $_.PSPath -Name DeviceState -ErrorAction SilentlyContinue).DeviceState
    if ($state -eq 1) {
      $props = Get-ItemProperty -Path "$($_.PSPath)\\Properties" -ErrorAction SilentlyContinue
      if ($props) {
        $name = $props.'{a45c254e-df1c-4efd-8020-67d146a850e0},14'
        [PSCustomObject]@{ Id = "$prefix{$($_.PSChildName)}"; Name = $name }
      }
    }
  } | Where-Object { $_ -ne $null }
} catch {
  ConvertTo-Json -Compress @{ ok = $false; error = "registry: $($_.Exception.Message)" }
  exit 0
}
$dev = $endpoints | Where-Object { $_.Name -and ($_.Name -like "*$pattern*" -or "*$pattern*" -like "*$($_.Name)*") } | Select-Object -First 1
if (-not $dev) {
  ConvertTo-Json -Compress @{ ok = $false; error = "no match"; pattern = $pattern; available = @($endpoints | ForEach-Object { $_.Name }) }
  exit 0
}
try {
  $hr = [DashAudio.PolicyConfig]::SetDefault($dev.Id)
  if ($hr -ne 0) { throw "SetDefaultEndpoint hr=0x$('{0:x}' -f $hr)" }
  ConvertTo-Json -Compress @{ ok = $true; name = $dev.Name; id = $dev.Id }
} catch {
  ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message }
}
  `.trim();
  return runPowerShell(ps, { timeout: 8000 });
}

function getSystemMuteStates() {
  const ps = `
${_SYSTEM_AUDIO_CS}
try {
  $o = [DashAudio.Endpoint]::GetMute(0)
  $i = [DashAudio.Endpoint]::GetMute(1)
  ConvertTo-Json -Compress @{ ok = $true; out = $o; in = $i }
} catch {
  ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message }
}
  `.trim();
  return runPowerShell(ps, { timeout: 8000 });
}

// ─── IN-PANEL WEB BROWSER (adblock) ─────────────────────────────────
// Curated hostname blocklist applied to the in-panel browser's session via
// session.webRequest.onBeforeRequest. Targets the dominant ad/analytics/
// fingerprinting networks; not as exhaustive as EasyList but covers the
// majority of trackers without needing to bundle a large filter list.
const WEB_BLOCK_HOSTS = new Set([
  // Google ads + analytics
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com',
  // Facebook
  'connect.facebook.net', 'graph.facebook.com',
  // Major ad networks
  'adnxs.com', 'criteo.com', 'criteo.net', 'rubiconproject.com',
  'pubmatic.com', 'openx.net', 'taboola.com', 'outbrain.com',
  'amazon-adsystem.com', 'adform.net', 'casalemedia.com', 'rlcdn.com',
  'bidswitch.net', 'mathtag.com', 'demdex.net', 'everesttech.net',
  'serving-sys.com', 'media.net', 'yieldmo.com', 'indexww.com',
  // Analytics / tracking
  'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mixpanel.com',
  'segment.io', 'segment.com', 'mouseflow.com', 'fullstory.com',
  'bugsnag.com', 'newrelic.com', 'optimizely.com', 'kissmetrics.com',
  'crazyegg.com', 'chartbeat.com', 'heap.io', 'mparticle.com',
  // Common popup / consent annoyances often paired with trackers
  'onetrust.com', 'cookielaw.org', 'truste.com', 'evidon.com',
]);
function _isBlockedHost(host) {
  if (!host) return false;
  if (WEB_BLOCK_HOSTS.has(host)) return true;
  // Match subdomains: foo.bar.doubleclick.net → doubleclick.net is blocked.
  for (let dot = host.indexOf('.'); dot >= 0; dot = host.indexOf('.', dot + 1)) {
    if (WEB_BLOCK_HOSTS.has(host.slice(dot + 1))) return true;
  }
  return false;
}
const _webAdblockInstalled = new Set();
function installWebAdblock(partition, win) {
  if (!partition || _webAdblockInstalled.has(partition)) return;
  let s;
  try { s = session.fromPartition(partition); } catch { return; }
  if (!s?.webRequest) return;
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    let host = '';
    try { host = new URL(details.url).hostname.toLowerCase(); } catch {}
    if (_isBlockedHost(host)) {
      if (win && !win.isDestroyed()) win.webContents.send('web-request-blocked', host);
      cb({ cancel: true });
      return;
    }
    cb({});
  });
  // Strip Content-Security-Policy headers so our injected dark-mode <style>
  // tags survive on sites with strict CSPs (Google et al.). The browser
  // partition is isolated from the main app so this only loosens security
  // for in-panel browsing — not the dashboard itself.
  s.webRequest.onHeadersReceived((details, cb) => {
    const h = { ...details.responseHeaders };
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
        delete h[k];
      }
    }
    cb({ responseHeaders: h });
  });
  _webAdblockInstalled.add(partition);
}

// ─── WINDOWS Z-ORDER (HWND_BOTTOM) ─────────────────────────────────
// Persistent PowerShell process so every SetWindowPos call is ~10 ms
// instead of ~300 ms (no cold-start per call). Spawned lazily.
let _psBg = null;
function getBgShell() {
  if (_psBg && !_psBg.killed && _psBg.exitCode == null) return _psBg;
  _psBg = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  _psBg.on('error', () => { _psBg = null; });
  _psBg.on('exit',  () => { _psBg = null; });
  // Define the SetWindowPos P/Invoke once for the life of this process.
  _psBg.stdin.write(
    `Add-Type -ErrorAction SilentlyContinue -MemberDefinition '` +
      `[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);` +
    `' -Name N -Namespace W;\r\n`
  );
  return _psBg;
}

function sendToBottom(win) {
  if (process.platform !== 'win32') return;
  if (!win || win.isDestroyed()) return;
  let hwnd;
  try {
    // HWND fits in 32 bits on Windows (even on x64).
    hwnd = win.getNativeWindowHandle().readUInt32LE(0);
  } catch {
    return;
  }
  // SetWindowPos(hwnd, HWND_BOTTOM=1, 0, 0, 0, 0,
  //              SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE = 0x0013)
  const sh = getBgShell();
  if (!sh || !sh.stdin || sh.stdin.destroyed) return;
  try {
    sh.stdin.write(
      `[W.N]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]1, 0, 0, 0, 0, 0x13) | Out-Null\r\n`
    );
  } catch {}
}

app.on('before-quit', () => {
  stopWasapiLoopback();
  if (_psBg && !_psBg.killed) {
    try { _psBg.stdin.end(); } catch {}
    try { _psBg.kill(); } catch {}
    _psBg = null;
  }
});

// ─── APP LIFECYCLE ─────────────────────────────────────────────────
// Stop Chromium from detecting "the YouTube window is occluded by the
// dashboard" and pausing the renderer / freezing media. These need to
// be set BEFORE app.whenReady fires.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

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

  registerIpc();
  startHttpServer();
  createWindow();
  autoLaunchSensors();
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
//   Web pane (in-panel <webview>)
//     web-install-adblock  web-force-dark   (CDP auto-dark via debugger)
//
//   Process / window
//     toggle-fullscreen  app-relaunch  app-quit
//     get-screen-sources  set-power-profile
//     open-youtube  set-youtube-zen-mode
//     azure-auto-config  airplane-mode
//
//   Push events (main → renderer; renderer subscribes via on*)
//     audio-out-level  web-request-blocked  force-leave-zen
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

  ipcMain.handle('get-screen-sources', () => getScreenSources());

  ipcMain.handle('azure-auto-config', async () => {
    return await azureAutoConfig();
  });

  ipcMain.handle('audio-set-device', async (e, deviceId) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    try { writeConfig({ audioDeviceId: deviceId }); } catch {}
    restartWasapiLoopback(win, deviceId);
    return true;
  });

  // System-level mute for the default render/capture endpoints. dataFlow
  // 0 = render (speakers), 1 = capture (mic). Result: { ok, muted } or
  // { ok:false, error } so the renderer can roll back its UI on failure.
  ipcMain.handle('audio-set-out-mute', (_e, mute) => setSystemMute(0, !!mute));
  ipcMain.handle('audio-set-in-mute',  (_e, mute) => setSystemMute(1, !!mute));
  ipcMain.handle('audio-get-mute-states', () => getSystemMuteStates());
  ipcMain.handle('audio-set-default-endpoint', (_e, { dataFlow, name }) => setDefaultEndpoint(dataFlow | 0, name));

  ipcMain.handle('web-install-adblock', (e, partition) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    installWebAdblock(String(partition || ''), win);
    return true;
  });

  // Force the embedded webview into dark mode using Chromium's official
  // "Auto Dark Mode for Web Contents" via the DevTools Protocol. This is
  // the same mechanism the chrome://flags toggle uses — Chromium swaps
  // light backgrounds for dark and adjusts text contrast itself, so we
  // don't need CSS injection that fights site CSPs.
  ipcMain.handle('web-force-dark', (_e, contentsId) => {
    try {
      const wc = webContents.fromId(contentsId | 0);
      if (!wc) return { ok: false, error: 'no webContents' };
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      // Tell the embedded page that prefers-color-scheme is dark first so
      // any site with native dark CSS uses it; then layer auto-dark on top
      // for the rest.
      return wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      }).then(() => wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride', {
        enabled: true,
      })).then(() => ({ ok: true })).catch((err) => ({ ok: false, error: String(err) }));
    } catch (err) {
      return { ok: false, error: String(err) };
    }
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

  // Airplane mode — disables / re-enables every network adapter that was
  // 'Up' at the moment the user toggled airplane on. Requires admin, so
  // the actual Disable-NetAdapter / Enable-NetAdapter calls are run from
  // an elevated child PowerShell launched via Start-Process -Verb RunAs
  // (one UAC prompt per toggle). Names of disabled adapters are written
  // to a state file in userData so a re-enable after an app restart still
  // brings the same adapters back up.
  ipcMain.handle('airplane-mode', async (_e, on) => {
    const stateFile = path.join(app.getPath('userData'), 'airplane-state.txt');
    const sf = stateFile.replace(/'/g, "''");
    const inner = on
      ? `$names = (Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty Name); ` +
        `if ($names) { ` +
          `$names | Set-Content -Path '${sf}' -Encoding UTF8; ` +
          `$names | ForEach-Object { Disable-NetAdapter -Name $_ -Confirm:$false } ` +
        `}`
      : `if (Test-Path '${sf}') { ` +
          `Get-Content '${sf}' | Where-Object { $_ } | ForEach-Object { Enable-NetAdapter -Name $_ -Confirm:$false }; ` +
          `Remove-Item '${sf}' -ErrorAction SilentlyContinue ` +
        `} else { ` +
          `Get-NetAdapter | Where-Object Status -eq 'Disabled' | Enable-NetAdapter -Confirm:$false ` +
        `}`;
    // PowerShell -EncodedCommand expects UTF-16-LE base64 — pre-encode to
    // avoid quoting nightmares with the elevated launcher.
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    const launcher =
      `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`;
    return new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', launcher],
        { timeout: 15000, windowsHide: true },
        (err) => resolve({ ok: !err, error: err ? String(err.message || err) : null }),
      );
    });
  });

  ipcMain.handle('set-power-profile', async (_e, opts) => {
    return await setPowerProfile(opts || {});
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

// ─── POWER PROFILE ─────────────────────────────────────────────────
// Adjust the active Windows power scheme's processor min/max via
// powercfg.exe. AC + DC are both updated so the change applies on
// battery and wall power.
async function setPowerProfile({ maxCpu, minCpu } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'powercfg only on win32' };
  }
  const max = Math.max(0, Math.min(100, Math.round(Number(maxCpu))));
  const min = Math.max(0, Math.min(100, Math.round(Number(minCpu))));
  if (!Number.isFinite(max) || !Number.isFinite(min)) {
    return { ok: false, error: 'invalid maxCpu/minCpu' };
  }
  const settings = [
    ['SUB_PROCESSOR', 'PROCTHROTTLEMAX', max],
    ['SUB_PROCESSOR', 'PROCTHROTTLEMIN', min],
  ];
  const run = (args) => new Promise((resolve, reject) => {
    execFile('powercfg.exe', args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr?.trim() || err.message)); return; }
      resolve(stdout);
    });
  });
  try {
    for (const [sub, setting, val] of settings) {
      await run(['/setacvalueindex', 'SCHEME_CURRENT', sub, setting, String(val)]);
      await run(['/setdcvalueindex', 'SCHEME_CURRENT', sub, setting, String(val)]);
    }
    // Re-apply the active scheme so the new values actually take effect.
    await run(['/setactive', 'SCHEME_CURRENT']);
    return { ok: true, max, min };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

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
// User config lives in %APPDATA%\Dashboard3D\config.json. Bundled
// defaults (next to main.js) are layered underneath so a fresh install
// boots into a curated layout while user edits persist per-key.

function configFilePath() {
  return path.join(app.getPath('userData'), 'config.json');
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
    const lhm = (await tryLhmHttp()) || (await tryLhmWmi());
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

async function tryLhmWmi() {
  const ps = `
$ns = 'root/LibreHardwareMonitor'
$sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Ignore
if (-not $sensors) {
  $ns = 'root/OpenHardwareMonitor'
  $sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Ignore
}
if (-not $sensors) { ConvertTo-Json -Compress @{ available = $false }; exit 0 }
$temps = $sensors | Where-Object { $_.SensorType -eq 'Temperature' }
$powers = $sensors | Where-Object { $_.SensorType -eq 'Power' }
$cpuPkg = $temps | Where-Object { $_.Identifier -match '/cpu/.*/temperature/0$' -or $_.Name -match 'CPU Package|CPU Total' } | Select-Object -First 1
$cpuPower = $powers | Where-Object { $_.Name -match 'CPU Package|Package Power' -and $_.Identifier -match '/cpu/' } | Select-Object -First 1
$gpuTempMap = @{}
foreach ($g in $temps) {
  if ($g.Identifier -match '/gpu-[a-z]+/(\\d+)/temperature/0') {
    $idx = [int]$Matches[1]
    if (-not $gpuTempMap.ContainsKey($idx)) { $gpuTempMap[$idx] = [double]$g.Value }
  }
}
$gpuPowerMap = @{}
foreach ($p in $powers) {
  if ($p.Identifier -match '/gpu-[a-z]+/(\\d+)/power/0') {
    $idx = [int]$Matches[1]
    if (-not $gpuPowerMap.ContainsKey($idx)) { $gpuPowerMap[$idx] = [double]$p.Value }
  }
}
$gpuArr = @()
$gpuPwr = @()
if ($gpuTempMap.Keys.Count -gt 0) {
  $maxIdx = ($gpuTempMap.Keys | Measure-Object -Maximum).Maximum
  for ($i = 0; $i -le $maxIdx; $i++) {
    $gpuArr += $gpuTempMap[$i]
    $gpuPwr += $gpuPowerMap[$i]
  }
}
ConvertTo-Json -Compress @{
  available = $true
  cpu = $cpuPkg.Value
  cpuPower = $cpuPower.Value
  gpus = $gpuArr
  gpusPower = $gpuPwr
}
  `.trim();
  const obj = await runPowerShell(ps, { timeout: 5000 });
  if (!obj?.available) return null;
  return {
    cpu:       Number.isFinite(obj.cpu)      ? obj.cpu      : null,
    cpuPower:  Number.isFinite(obj.cpuPower) ? obj.cpuPower : null,
    gpus:      Array.isArray(obj.gpus)      ? obj.gpus.map(v => Number.isFinite(v) ? v : null)      : [],
    gpusPower: Array.isArray(obj.gpusPower) ? obj.gpusPower.map(v => Number.isFinite(v) ? v : null) : [],
  };
}

// LHM v0.9.x dropped the WMI provider and exposes sensors via a built-in
// HTTP server on localhost:8085 instead. /data.json returns a recursive
// tree we walk for CPU package temperature/power and per-GPU values.
// Returns same shape as tryLhmWmi or null if the server isn't reachable.
function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) { done = true; res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { if (done) return; done = true; try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
    req.setTimeout(timeoutMs, () => { if (!done) { done = true; req.destroy(); resolve(null); } });
  });
}

// Pull a numeric value out of LHM's "53.0 °C" / "42.0 W" string format.
function lhmNum(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

async function tryLhmHttp() {
  const root = await httpGetJson('http://127.0.0.1:8085/data.json');
  if (!root) return null;
  const out = { cpu: null, cpuPower: null, gpus: [], gpusPower: [] };
  // Walk: root → MyComputer → [hardware nodes] → [Temperatures|Powers]
  //                                            → [sensor nodes]
  const machine = root.Children?.[0];
  if (!machine?.Children) return null;
  let gpuIdx = -1;
  for (const hw of machine.Children) {
    const text = (hw.Text || '').toLowerCase();
    const isCpu = /cpu|ryzen|intel|amd/.test(text) && !/chipset|gpu/.test(text);
    const isGpu = /gpu|geforce|radeon|nvidia|graphics/.test(text);
    if (!isCpu && !isGpu) continue;
    if (isGpu) gpuIdx++;
    for (const group of hw.Children || []) {
      const gtext = (group.Text || '').toLowerCase();
      const isTempGroup  = /temp/.test(gtext);
      const isPowerGroup = /power/.test(gtext);
      if (!isTempGroup && !isPowerGroup) continue;
      for (const sensor of group.Children || []) {
        const name = (sensor.Text || '').toLowerCase();
        const val = lhmNum(sensor.Value);
        if (val == null) continue;
        if (isCpu && isTempGroup && /package|tctl|tdie/.test(name) && out.cpu == null) {
          out.cpu = val;
        } else if (isCpu && isPowerGroup && /package/.test(name) && out.cpuPower == null) {
          out.cpuPower = val;
        } else if (isGpu && isTempGroup && /core|gpu/.test(name)) {
          if (out.gpus[gpuIdx] == null) out.gpus[gpuIdx] = val;
        } else if (isGpu && isPowerGroup) {
          if (out.gpusPower[gpuIdx] == null) out.gpusPower[gpuIdx] = val;
        }
      }
    }
  }
  // Only consider this source useful if it produced at least one number.
  if (out.cpu == null && out.cpuPower == null && out.gpus.length === 0) return null;
  return out;
}

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
