const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const si = require('systeminformation');

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  // Always-on-bottom: demote to back of z-order when shown and whenever
  // the window loses focus. User interaction (focus) brings it forward
  // briefly so notes/inputs remain editable.
  win.once('ready-to-show', () => sendToBottom(win));
  win.on('show',  () => sendToBottom(win));
  win.on('blur',  () => sendToBottom(win));
}

let _sendToBottomTimer = null;
function sendToBottom(win) {
  if (process.platform !== 'win32') return;
  if (!win || win.isDestroyed()) return;
  // Debounce: rapid focus/blur churn could spawn multiple PowerShell processes.
  clearTimeout(_sendToBottomTimer);
  _sendToBottomTimer = setTimeout(() => {
    if (win.isDestroyed()) return;
    let hwnd;
    try {
      // HWND fits in 32 bits on Windows (even on x64).
      hwnd = win.getNativeWindowHandle().readUInt32LE(0);
    } catch {
      return;
    }
    // SetWindowPos(hWnd, HWND_BOTTOM=1, 0, 0, 0, 0,
    //              SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE = 0x0013)
    const ps =
      `Add-Type -ErrorAction SilentlyContinue -MemberDefinition '` +
        `[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);` +
      `' -Name N -Namespace W; ` +
      `[W.N]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]1, 0, 0, 0, 0, 0x13) | Out-Null`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 3000 },
      () => {}
    );
  }, 80);
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerIpc() {
  ipcMain.handle('system-info', () => {
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
  });

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

  ipcMain.handle('toggle-fullscreen', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });
}

function getDiskIo() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ readSec: 0, writeSec: 0, transferSec: 0, queue: 0, supported: false });
  }
  return new Promise((resolve) => {
    const ps = `Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction Ignore | Select-Object DiskReadBytesPersec,DiskWriteBytesPersec,DiskTransfersPersec,CurrentDiskQueueLength | ConvertTo-Json -Compress`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ readSec: 0, writeSec: 0, transferSec: 0, queue: 0, supported: false, error: err.message });
          return;
        }
        try {
          const obj = JSON.parse(stdout || '{}');
          resolve({
            readSec:     Number(obj.DiskReadBytesPersec)    || 0,
            writeSec:    Number(obj.DiskWriteBytesPersec)   || 0,
            transferSec: Number(obj.DiskTransfersPersec)    || 0,
            queue:       Number(obj.CurrentDiskQueueLength) || 0,
            supported: true,
          });
        } catch {
          resolve({ readSec: 0, writeSec: 0, transferSec: 0, queue: 0, supported: false });
        }
      }
    );
  });
}

function configFilePath() {
  return path.join(app.getPath('userData'), 'config.json');
}

async function readConfig() {
  try {
    const buf = await fs.promises.readFile(configFilePath(), 'utf8');
    const parsed = JSON.parse(buf);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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

async function getTempsInfo() {
  const result = { cpu: null, gpus: [], sources: [] };

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
          };
        } else {
          if (result.gpus[i].temp     == null) result.gpus[i].temp     = nv[i].temp;
          if (result.gpus[i].load     == null) result.gpus[i].load     = nv[i].util;
          if (result.gpus[i].memUsed  == null) result.gpus[i].memUsed  = nv[i].memUsed;
          if (result.gpus[i].memTotal == null) result.gpus[i].memTotal = nv[i].memTotal;
          if (!result.gpus[i].name || /unknown/i.test(result.gpus[i].name)) result.gpus[i].name = nv[i].name;
        }
      }
      result.sources.push('nvidia-smi');
    }
  }

  // Fallback 2: LibreHardwareMonitor / OpenHardwareMonitor WMI namespace
  if (result.cpu == null || result.gpus.some(g => g.temp == null)) {
    const lhm = await tryLhmWmi();
    if (lhm) {
      if (result.cpu == null && lhm.cpu != null) {
        result.cpu = lhm.cpu;
        result.sources.push('lhm:cpu');
      }
      if (lhm.gpus?.length) {
        let gotGpu = false;
        for (let i = 0; i < lhm.gpus.length; i++) {
          if (result.gpus[i] && result.gpus[i].temp == null && lhm.gpus[i] != null) {
            result.gpus[i].temp = lhm.gpus[i];
            gotGpu = true;
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
        '--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total',
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
          return {
            index: parseInt(parts[0], 10) || 0,
            name:  parts[1] || 'NVIDIA',
            temp:  parseInt(parts[2], 10),
            util:  parseInt(parts[3], 10),
            memUsed:  Number.isFinite(memUsedMiB)  ? memUsedMiB  * 1024 * 1024 : null,
            memTotal: Number.isFinite(memTotalMiB) ? memTotalMiB * 1024 * 1024 : null,
          };
        }).filter(g => Number.isFinite(g.temp));
        resolve(out);
      }
    );
  });
}

function tryLhmWmi() {
  return new Promise((resolve) => {
    const ps = `
$ns = 'root/LibreHardwareMonitor'
$sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Ignore
if (-not $sensors) {
  $ns = 'root/OpenHardwareMonitor'
  $sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Ignore
}
if (-not $sensors) { ConvertTo-Json -Compress @{ available = $false }; exit 0 }
$temps = $sensors | Where-Object { $_.SensorType -eq 'Temperature' }
$cpuPkg = $temps | Where-Object { $_.Identifier -match '/cpu/.*/temperature/0$' -or $_.Name -match 'CPU Package|CPU Total' } | Select-Object -First 1
$gpuMap = @{}
foreach ($g in $temps) {
  if ($g.Identifier -match '/gpu-[a-z]+/(\\d+)/temperature/0') {
    $idx = [int]$Matches[1]
    if (-not $gpuMap.ContainsKey($idx)) { $gpuMap[$idx] = [double]$g.Value }
  }
}
$gpuArr = @()
if ($gpuMap.Keys.Count -gt 0) {
  $maxIdx = ($gpuMap.Keys | Measure-Object -Maximum).Maximum
  for ($i = 0; $i -le $maxIdx; $i++) { $gpuArr += $gpuMap[$i] }
}
ConvertTo-Json -Compress @{ available = $true; cpu = $cpuPkg.Value; gpus = $gpuArr }
    `.trim();
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const obj = JSON.parse(stdout || '{}');
          if (!obj.available) { resolve(null); return; }
          resolve({
            cpu:  Number.isFinite(obj.cpu) ? obj.cpu : null,
            gpus: Array.isArray(obj.gpus) ? obj.gpus.map(v => Number.isFinite(v) ? v : null) : [],
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Track default interface so we can label it
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

async function getStorageInfo() {
  if (process.platform === 'win32') {
    return await getStorageWindows();
  }
  return await getStoragePosix();
}

function getStorageWindows() {
  return new Promise((resolve) => {
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
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 6000 },
      (err, stdout) => {
        if (err) { resolve(getStorageFromStatfs()); return; }
        try {
          let arr = JSON.parse(stdout || '[]');
          if (!Array.isArray(arr)) arr = [arr];
          const drives = arr
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
          resolve(drives);
        } catch {
          resolve(getStorageFromStatfs());
        }
      }
    );
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
