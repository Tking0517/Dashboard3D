// Windows service trim — stop non-essential services on demand and set
// them to Manual startup so they don't auto-start at the next boot.
// Fully reversible: trimServices() records each service's prior startup
// type to a backup file, and restoreServices() puts every touched
// service back exactly (then starts it again).
//
//   scanServices()    — unprivileged CIM query, returns + categorises
//   trimServices()    — needs admin; one UAC prompt via Start-Process
//                       -Verb RunAs, the elevated child writes its
//                       result JSON to a temp file we read back
//   restoreServices() — needs admin; reverts from the backup file
//
// The IPC wiring stays thin in main.js — this module is pure logic, in
// the same shape as the rest of services/.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { runPowerShell } = require('../_util/powershell');

// Critical services never offered to the user — stopping any of these
// can break login, networking, audio/video, the desktop shell, security,
// or our own sensor pipeline. Matched case-insensitively against the
// service's short Name.
const SERVICE_PROTECTED = new Set([
  // Core RPC / DCOM / object plumbing — stopping these kills everything
  'rpcss', 'rpceptmapper', 'dcomlaunch', 'lsm', 'brokerinfrastructure',
  'systemeventsbroker', 'coremessagingregistrar', 'eventsystem', 'dsmsvc',
  // Logon / identity / scheduling / security base
  'samss', 'keyiso', 'vaultsvc', 'profsvc', 'usermanager', 'gpsvc',
  'seclogon', 'appinfo', 'cryptsvc', 'eventlog', 'schedule', 'dps',
  'wdiservicehost', 'wdisystemhost',
  // Plug-and-play / device / power
  'plugplay', 'power', 'deviceinstall', 'devicesetupmanager',
  'shellhwdetection',
  // Networking — "coms"
  'dhcp', 'dnscache', 'nlasvc', 'netprofm', 'nsi', 'bfe', 'mpssvc',
  'wcmsvc', 'wlansvc', 'netman', 'ncbservice', 'lanmanworkstation',
  'lanmanserver', 'iphlpsvc', 'netsetupsvc', 'winhttpautoproxysvc', 'sens',
  // Audio / video / multimedia
  'audiosrv', 'audioendpointbuilder', 'frameserver', 'stisvc', 'mmcss',
  // Input / shell / desktop UI
  'textinputmanagementservice', 'tabletinputservice', 'themes', 'uxsms',
  'wpnservice', 'timebrokersvc',
  // WMI — our own sensor + service queries depend on it
  'winmgmt',
  // Security stack — never disable AV / firewall
  'windefend', 'wdnissvc', 'sense', 'wscsvc', 'securityhealthservice',
  // Remote desktop session plumbing
  'termservice', 'umrdpservice',
]);
// Protected service families with rotating instance suffixes (per-user
// services carry a random LUID, GPU vendors namespace their own).
const SERVICE_PROTECTED_RE =
  /(nvidia|nvdisplay|^nvagent|amdacpbus|^igccservice|librehardware|winring0|^audiosrv_|^audioendpointbuilder_|^wpnuserservice|^cdpusersvc|^onesyncsvc|^webaccountmanagersvc|^bcastdvruserservice|^devicepicker)/i;

function classifyService(svc) {
  const name = String(svc.Name || '').toLowerCase();
  if (SERVICE_PROTECTED.has(name) || SERVICE_PROTECTED_RE.test(name)) return 'protected';
  const p = String(svc.PathName || '').toLowerCase();
  const m = p.match(/[a-z]:\\[^"]*/);
  const exe = m ? m[0] : p;
  if (exe && !exe.includes('\\windows\\')) return 'thirdparty';
  return 'windows';
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function backupFile(portableDir) {
  return path.join(portableDir, 'services-trim-backup.json');
}

// Run a PowerShell snippet elevated. The snippet must write its JSON
// result to the path held in $DASH_RESULT. Resolves to the parsed result
// object, { cancelled:true } if the UAC prompt was declined, or
// { ok:false, error }.
function runElevatedPwsh(innerScript) {
  return new Promise((resolve) => {
    const tag = `dash3d-svc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const dir = app.getPath('temp');
    const scriptFile = path.join(dir, `${tag}.ps1`);
    const resultFile = path.join(dir, `${tag}.json`);
    const fullInner = `$DASH_RESULT = ${psQuote(resultFile)}\n` + innerScript;
    try { fs.writeFileSync(scriptFile, fullInner, 'utf8'); }
    catch (e) { resolve({ ok: false, error: 'temp write failed: ' + e.message }); return; }
    const outer =
      `try { Start-Process powershell -Verb RunAs -WindowStyle Hidden ` +
      `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(scriptFile)}) ` +
      `-Wait -ErrorAction Stop } ` +
      `catch { Write-Output '{"cancelled":true}'; exit }\n` +
      `if (Test-Path ${psQuote(resultFile)}) { Get-Content ${psQuote(resultFile)} -Raw } ` +
      `else { Write-Output '{"ok":false,"error":"elevated task produced no result"}' }`;
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', outer],
      { timeout: 180000, windowsHide: true },
      (err, stdout) => {
        try { fs.unlinkSync(scriptFile); } catch {}
        try { fs.unlinkSync(resultFile); } catch {}
        if (err) { resolve({ ok: false, error: err.message }); return; }
        let parsed = null;
        try { parsed = JSON.parse(String(stdout || '').trim() || 'null'); } catch {}
        if (!parsed) { resolve({ ok: false, error: 'unparseable elevated result' }); return; }
        resolve(parsed);
      });
  });
}

async function scanServices(portableDir) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  const raw = await runPowerShell(
    'Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,ProcessId,PathName | ConvertTo-Json -Compress',
    { timeout: 20000 },
  );
  if (!raw) return { ok: false, error: 'service query failed' };
  const list = Array.isArray(raw) ? raw : [raw];
  const services = list.map((s) => ({
    name: s.Name,
    displayName: s.DisplayName || s.Name,
    state: s.State,
    startMode: s.StartMode,
    pid: s.ProcessId || 0,
    category: classifyService(s),
  }));
  let hasBackup = false;
  try { hasBackup = Object.keys(JSON.parse(fs.readFileSync(backupFile(portableDir), 'utf8')) || {}).length > 0; } catch {}
  return { ok: true, services, hasBackup };
}

async function trimServices(names, portableDir) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  if (!Array.isArray(names) || !names.length) return { ok: false, error: 'no services selected' };
  const safe = names
    .map((n) => String(n || '').trim())
    .filter((n) => n && /^[A-Za-z0-9_.\- ]+$/.test(n) && !SERVICE_PROTECTED.has(n.toLowerCase()));
  if (!safe.length) return { ok: false, error: 'no valid services selected' };
  const arr = '@(' + safe.map((n) => psQuote(n)).join(',') + ')';
  const inner =
    `$names = ${arr}\n` +
    `$out = @()\n` +
    `foreach ($n in $names) {\n` +
    `  $r = @{ name = $n }\n` +
    `  try {\n` +
    `    $svc = Get-CimInstance Win32_Service -Filter (\"Name='\" + $n + \"'\") -ErrorAction Stop\n` +
    `    $r.prevStartMode = [string]$svc.StartMode\n` +
    `    if ($svc.State -eq 'Running') { Stop-Service -Name $n -Force -ErrorAction Stop }\n` +
    `    Set-Service -Name $n -StartupType Manual -ErrorAction Stop\n` +
    `    $r.ok = $true\n` +
    `  } catch { $r.ok = $false; $r.error = $_.Exception.Message }\n` +
    `  $out += (New-Object psobject -Property $r)\n` +
    `}\n` +
    `ConvertTo-Json @{ ok = $true; results = @($out) } -Depth 5 | Out-File -FilePath $DASH_RESULT -Encoding utf8\n`;
  const res = await runElevatedPwsh(inner);
  if (res && res.cancelled) return { ok: false, cancelled: true };
  if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'trim failed' };
  try {
    const results = Array.isArray(res.results) ? res.results : [res.results].filter(Boolean);
    const file = backupFile(portableDir);
    let backup = {};
    try { backup = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    for (const r of results) {
      if (r && r.ok && r.name && r.prevStartMode) {
        backup[r.name] = { prevStartMode: r.prevStartMode, ts: Date.now() };
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
  } catch {}
  return res;
}

async function restoreServices(portableDir) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  let backup = {};
  try { backup = JSON.parse(fs.readFileSync(backupFile(portableDir), 'utf8')) || {}; } catch {}
  const names = Object.keys(backup).filter((n) => /^[A-Za-z0-9_.\- ]+$/.test(n));
  if (!names.length) return { ok: false, error: 'nothing to restore' };
  const items = names.map((n) => {
    const mode = String(backup[n].prevStartMode || 'Manual');
    const startup = /^auto/i.test(mode) ? 'Automatic'
      : /^disabled/i.test(mode) ? 'Disabled' : 'Manual';
    return `[pscustomobject]@{name=${psQuote(n)};startup=${psQuote(startup)}}`;
  });
  const inner =
    `$items = @(${items.join(',')})\n` +
    `$out = @()\n` +
    `foreach ($it in $items) {\n` +
    `  $r = @{ name = $it.name }\n` +
    `  try {\n` +
    `    Set-Service -Name $it.name -StartupType $it.startup -ErrorAction Stop\n` +
    `    Start-Service -Name $it.name -ErrorAction SilentlyContinue\n` +
    `    $r.ok = $true\n` +
    `  } catch { $r.ok = $false; $r.error = $_.Exception.Message }\n` +
    `  $out += (New-Object psobject -Property $r)\n` +
    `}\n` +
    `ConvertTo-Json @{ ok = $true; results = @($out) } -Depth 5 | Out-File -FilePath $DASH_RESULT -Encoding utf8\n`;
  const res = await runElevatedPwsh(inner);
  if (res && res.cancelled) return { ok: false, cancelled: true };
  if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'restore failed' };
  try { fs.unlinkSync(backupFile(portableDir)); } catch {}
  return res;
}

module.exports = { scanServices, trimServices, restoreServices };
