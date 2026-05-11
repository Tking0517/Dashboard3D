const { app, BrowserWindow, BrowserView, ipcMain, screen, session, desktopCapturer, utilityProcess, shell, protocol, net } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile, spawn, exec } = require('child_process');
const si = require('systeminformation');

const HTTP_PORT = 7373;
const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Main HUD BrowserWindow. Captured in createWindow() so the embedded
// BROWSER pane can attach/detach BrowserViews against it.
let _mainWin = null;

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
function galleryFolderPath() { return path.join(userFoldersBase(), 'gallery'); }
function docsFolderPath()    { return path.join(userFoldersBase(), 'docs');    }
function ensureUserFolders() {
  for (const p of [galleryFolderPath(), docsFolderPath()]) {
    try { fs.mkdirSync(p, { recursive: true }); }
    catch (err) { console.warn(`could not create ${p}:`, err.message); }
  }
}
// Return the managed root (gallery/ or docs/) that contains `abs`, or
// null if `abs` lives outside both. Used by the explore IPC handlers
// to gate any path the renderer hands us.
function _managedRootFor(abs) {
  const g = galleryFolderPath();
  const d = docsFolderPath();
  if (abs === g || abs.startsWith(g + path.sep)) return g;
  if (abs === d || abs.startsWith(d + path.sep)) return d;
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
  let _statsDirty = false;
  let _statsTimer = null;
  function _broadcastBrowserStats() {
    if (_statsTimer) return;
    _statsTimer = setTimeout(() => {
      _statsTimer = null;
      if (!_statsDirty) return;
      _statsDirty = false;
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('browser-stats', { adsBlocked: _adsBlocked });
      }
    }, 250);
  }
  browserSession.webRequest.onBeforeRequest((details, callback) => {
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
  ipcMain.handle('browser-get-stats', () => ({ adsBlocked: _adsBlocked }));
  ipcMain.handle('browser-reset-stats', () => { _adsBlocked = 0; _statsDirty = true; _broadcastBrowserStats(); return { adsBlocked: 0 }; });

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

  function _wireBvEvents(id, view) {
    const wc = view.webContents;
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
    // the requested one.
    for (const [tid, t] of _bvTabs.entries()) {
      if (tid !== id) {
        try { _mainWin.removeBrowserView(t.view); } catch {}
      }
    }
    const t = _bvTabs.get(id);
    if (!t) return;
    try { _mainWin.setBrowserView(t.view); } catch {}
    _applyBvBounds(t.view);
    _bvActiveId = id;
  }
  function _hideAllBv() {
    if (!_mainWin || _mainWin.isDestroyed()) return;
    for (const t of _bvTabs.values()) {
      try { _mainWin.removeBrowserView(t.view); } catch {}
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
      root = which === 'gallery' ? galleryFolderPath()
           : which === 'docs'    ? docsFolderPath()
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
  ipcMain.handle('flush-ram', async () => {
    const ps =
      'Add-Type -MemberDefinition \'[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);\' ' +
      '-Name MM -Namespace W -ErrorAction SilentlyContinue; ' +
      '$f = 0; $x = 0; ' +
      'Get-Process | ForEach-Object { ' +
        'try { if ([W.MM]::EmptyWorkingSet($_.Handle)) { $f++ } else { $x++ } } catch { $x++ } ' +
      '}; ' +
      'ConvertTo-Json @{ flushed = $f; failed = $x }';
    const r = await runPowerShell(ps, { timeout: 30000 });
    return r || { ok: false, error: 'powershell failed' };
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

  // User-folder paths. Renderer calls these when it needs to write a screenshot
  // / saved doc / generated image into the on-disk folders that ensureUserFolders
  // creates next to the .exe at app start.
  ipcMain.handle('gallery-path', () => galleryFolderPath());
  ipcMain.handle('docs-path',    () => docsFolderPath());

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
  ipcMain.handle('gallery-list', listFolder(galleryFolderPath));
  ipcMain.handle('docs-list',    listFolder(docsFolderPath));

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
    const arr = (Array.isArray(paths) ? paths : [])
      .map((p) => path.resolve(String(p || '')))
      .filter((p) => _pathInsideManagedRoot(p));
    if (!arr.length) return Promise.resolve({ ok: false, error: 'no valid paths' });
    const escaped = arr.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    return new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -Path ${escaped}`],
        { timeout: 6000, windowsHide: true },
        (err) => resolve(err
          ? { ok: false, error: err.message }
          : { ok: true, count: arr.length }),
      );
    });
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
      const which = root === galleryFolderPath() ? 'gallery' : 'docs';
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
    const which = root === galleryFolderPath() ? 'gallery' : 'docs';
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
  // 'gallery' or 'docs', `rel` is the relative path of the new folder.
  ipcMain.handle('explore-mkdir', (_e, which, rel) => {
    const root = which === 'gallery' ? galleryFolderPath() : docsFolderPath();
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
  if (process.platform !== 'win32') return [];
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
    const arr = shouldRunBits ? await (async () => {
      const bitsPs = `Get-BitsTransfer -AllUsers -ErrorAction SilentlyContinue |
        Where-Object { $_.JobState -in 'Transferring','Connecting','Queued' } |
        Select-Object @{n='id';e={[string]$_.JobId}}, DisplayName, BytesTotal, BytesTransferred, TransferType |
        ConvertTo-Json -Compress -Depth 2`;
      const r = await runPowerShell(bitsPs, { timeout: 2500 });
      return r == null ? [] : (Array.isArray(r) ? r : [r]);
    })() : [];
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
