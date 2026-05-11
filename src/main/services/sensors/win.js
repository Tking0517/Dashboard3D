// Windows sensors backend.
// Two responsibilities:
//   1. launchSensorBackend() — kick off the bundled LibreHardwareMonitor.exe
//      once at dashboard start so its HTTP/WMI endpoints are alive. Needs
//      a UAC prompt the first time (LHM reads CPU MSRs).
//   2. getNativeFallback() — pull CPU + per-GPU temps and power from LHM
//      when the cross-platform si + nvidia-smi probes left fields null.
//      Tries LHM's HTTP server first (LHM v0.9.x dropped WMI), falls back
//      to WMI for older boxes still on the old build.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
const { runPowerShell } = require('../_util/powershell');

function findBundledLhm() {
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), 'tools', 'LibreHardwareMonitor', 'LibreHardwareMonitor.exe'),
    path.join(__dirname, '..', '..', '..', '..', 'Dashboard3D-win32-x64', 'tools', 'LibreHardwareMonitor', 'LibreHardwareMonitor.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function launchSensorBackend() {
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

// ── LHM HTTP path ─────────────────────────────────────────────────
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
  if (out.cpu == null && out.cpuPower == null && out.gpus.length === 0) return null;
  return out;
}

// ── LHM WMI fallback (older builds) ───────────────────────────────
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

// HTTP first because PowerShell startup is ~500 ms; skip it when the
// patched LHM is up on its built-in server.
async function getNativeFallback() {
  return (await tryLhmHttp()) || (await tryLhmWmi());
}

module.exports = { launchSensorBackend, getNativeFallback };
