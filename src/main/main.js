const { app, BrowserWindow, ipcMain, screen, session, desktopCapturer, utilityProcess } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile, spawn, exec } = require('child_process');
const si = require('systeminformation');

// audify (native WASAPI loopback) is loaded in a utilityProcess child so a
// native crash in the binding can't take down the main process. Set
// DASH3D_DISABLE_AUDIFY=1 to skip starting the worker entirely.

const HTTP_PORT = 7373;

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function getWorkArea() {
  // Primary display's work area = screen bounds minus taskbar reserve.
  return screen.getPrimaryDisplay().workArea;
}

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

// Persistent PowerShell process so every SetWindowPos call is ~10ms instead
// of ~300ms (no cold-start per call). Spawned lazily on first use.
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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
