// Windows audio backend.
//
// Three concerns:
//   1. WASAPI loopback worker — utility process that captures the
//      default render endpoint's RMS levels and posts them back here,
//      we forward over IPC to the dashboard renderer.
//   2. System mute via Core Audio IAudioEndpointVolume — flips the OS
//      mute (not just our analyser), so the dashboard's mute buttons
//      match what every other app sees.
//   3. Default endpoint switching via IPolicyConfigVista — same COM
//      path Windows' own Sound control panel uses. Matches devices by
//      friendly-name substring against the registry's MMDevices store.

const path = require('path');
const fs = require('fs');
const { utilityProcess } = require('electron');
const { runPowerShell } = require('../_util/powershell');

// ── WASAPI loopback worker ─────────────────────────────────────────
let _audioProc = null;
let _audioWin  = null;

function startLoopback(win, deviceId = null, readConfig = null) {
  if (process.env.DASH3D_DISABLE_AUDIFY) return;
  if (_audioProc) return;
  _audioWin = win;

  // audify-worker.js still lives in src/main/ next to main.js because
  // it's a separate utilityProcess entry point that the packager picks
  // up by relative path. Worth keeping there until we add a Linux
  // sibling, at which point both go under services/audio/workers/.
  const workerPath = path.join(__dirname, '..', '..', 'audify-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.warn('audify worker missing at', workerPath);
    return;
  }

  // Persisted config takes precedence over the env-var override only if
  // the env var isn't set, so DASH3D_AUDIO_DEVICE_ID is still an escape
  // hatch. readConfig is injected by caller so this module stays
  // decoupled from the dashboard's config helper.
  let chosenId = deviceId;
  if (chosenId == null && !process.env.DASH3D_AUDIO_DEVICE_ID && typeof readConfig === 'function') {
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

function stopLoopback() {
  if (!_audioProc) return;
  try { _audioProc.postMessage('stop'); } catch {}
  const p = _audioProc;
  setTimeout(() => { try { p.kill(); } catch {} }, 200);
  _audioProc = null;
}

function restartLoopback(win, deviceId, readConfig) {
  stopLoopback();
  // Small gap so WASAPI fully releases the prior endpoint.
  setTimeout(() => startLoopback(win, deviceId, readConfig), 350);
}

// ── System mute (IAudioEndpointVolume) ────────────────────────────
// Inline C# COM wrapper compiled once per PowerShell session via
// `if (-not 'DashAudio.Endpoint' -as [type])` so subsequent calls
// skip the Add-Type cost (~150 ms saved per call).
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

// ── Default endpoint (IPolicyConfigVista) ────────────────────────
// dataFlow: 0 = render (speakers), 1 = capture (mic). Sets all three
// roles (eConsole / eMultimedia / eCommunications) so apps that pin to
// Communications also follow.
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

module.exports = {
  startLoopback,
  stopLoopback,
  restartLoopback,
  setSystemMute,
  getSystemMuteStates,
  setDefaultEndpoint,
};
