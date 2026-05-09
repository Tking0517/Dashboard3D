import * as THREE from 'three';
import './styles.css';

// ── Scene ────────────────────────────────────────────────────────────────────
const canvas = document.querySelector('#scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'low-power',
});
// Cap DPR — at 4K with DPR=2 the canvas is ~8M pixels per frame; 1.25 looks
// nearly identical for an ambient background and roughly halves fragment work.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const ACCENT_HEX = 0x5ccfff;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 0, 7);

// Starfield
const starGeo = new THREE.BufferGeometry();
const STAR_COUNT = 600;
const starPositions = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  const r = 40 + Math.random() * 60;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
  starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  starPositions[i * 3 + 2] = r * Math.cos(phi);
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
  color: 0x6e8aa3, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.7,
}));
scene.add(stars);

// Ground grid for depth
const grid = new THREE.GridHelper(40, 20, ACCENT_HEX, 0x0e2230);
grid.material.transparent = true;
grid.material.opacity = 0.18;
grid.position.y = -3.2;
scene.add(grid);

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

// Pause WebGL work when the window is hidden (tab switch / minimize).
let sceneHidden = false;
document.addEventListener('visibilitychange', () => {
  sceneHidden = document.visibilityState === 'hidden';
});

// Cap framerate at 3fps — ambient scene only, prioritize CPU/GPU for everything else.
const TARGET_FRAME_MS = 1000 / 3;
let lastFrameTs = 0;
const clock = new THREE.Clock();

function animate(now = 0) {
  requestAnimationFrame(animate);
  if (sceneHidden) { clock.getDelta(); return; }
  if (now - lastFrameTs < TARGET_FRAME_MS) return;
  lastFrameTs = now;

  const dt = clock.getDelta();
  stars.rotation.y += dt * 0.004;
  renderer.render(scene, camera);
}
animate();

// ── HUD: Clock ───────────────────────────────────────────────────────────────
const clockTimeEl   = document.querySelector('#clock-time');
const clockAmpmEl   = document.querySelector('#clock-ampm');
const clockDateEl   = document.querySelector('#clock-date');
const clockTzEl     = document.querySelector('#clock-tz');
const clockDoyEl    = document.querySelector('#clock-doy');
const clockDoyHdrEl = document.querySelector('#clock-doy-header');
const clockIdentEl  = document.querySelector('#clock-ident');

const altTimeEl     = document.querySelector('#alt-time');
const altAmpmEl     = document.querySelector('#alt-ampm');
const altNameEl     = document.querySelector('#alt-name');
const altTzEl       = document.querySelector('#alt-tz');
const altCityInput  = document.querySelector('#alt-city-input');

const alt2TimeEl    = document.querySelector('#alt2-time');
const alt2AmpmEl    = document.querySelector('#alt2-ampm');
const alt2NameEl    = document.querySelector('#alt2-name');
const alt2TzEl      = document.querySelector('#alt2-tz');
const alt2CityInput = document.querySelector('#alt2-city-input');

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' });
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function makeTimeFmt(tz) {
  return new Intl.DateTimeFormat([], {
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true,
    ...(tz ? { timeZone: tz } : {}),
  });
}

function splitTime(fmt, date) {
  // Returns { hms: "11:42:35", ampm: "AM" }
  const parts = fmt.formatToParts(date);
  let h = '', m = '', s = '', ampm = '';
  for (const p of parts) {
    if (p.type === 'hour')      h = p.value;
    else if (p.type === 'minute') m = p.value;
    else if (p.type === 'second') s = p.value;
    else if (p.type === 'dayPeriod') ampm = p.value;
  }
  return { hms: `${h.padStart(2, '0')}:${m}:${s}`, ampm: ampm.toUpperCase() };
}

const localTimeFmt = makeTimeFmt(localTz);
let altTimeFmt = null;
let altLocation = null;  // { name, timezone }
let altTimeFmt2 = null;
let altLocation2 = null; // { name, timezone }

function dayOfYear(d) {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

function tickClock() {
  const now = new Date();
  const { hms: lhms, ampm: lap } = splitTime(localTimeFmt, now);
  clockTimeEl.textContent = lhms;
  clockAmpmEl.textContent = lap;
  clockDateEl.textContent = dateFmt.format(now).toUpperCase();
  const doy = String(dayOfYear(now)).padStart(3, '0');
  clockDoyEl.textContent    = doy;
  clockDoyHdrEl.textContent = doy;
  clockIdentEl.textContent  = doy;

  if (altTimeFmt && altLocation) {
    const { hms, ampm } = splitTime(altTimeFmt, now);
    altTimeEl.textContent = hms;
    altAmpmEl.textContent = ampm;
  } else {
    altTimeEl.textContent = '--:--:--';
    altAmpmEl.textContent = '--';
  }

  if (altTimeFmt2 && altLocation2) {
    const { hms, ampm } = splitTime(altTimeFmt2, now);
    alt2TimeEl.textContent = hms;
    alt2AmpmEl.textContent = ampm;
  } else {
    alt2TimeEl.textContent = '--:--:--';
    alt2AmpmEl.textContent = '--';
  }
}
clockTzEl.textContent = (localTz || '—').toUpperCase();
tickClock();
setInterval(tickClock, 1000);

function applyAltLocation(loc) {
  altLocation = loc;
  altTimeFmt = loc?.timezone ? makeTimeFmt(loc.timezone) : null;
  altNameEl.textContent = loc ? (loc.name || '—').toUpperCase() : '—';
  altTzEl.textContent   = loc?.timezone ? loc.timezone.toUpperCase() : '—';
  if (loc) altCityInput.value = loc.name || '';
  tickClock();
}

function applyAltLocation2(loc) {
  altLocation2 = loc;
  altTimeFmt2 = loc?.timezone ? makeTimeFmt(loc.timezone) : null;
  alt2NameEl.textContent = loc ? (loc.name || '—').toUpperCase() : '—';
  alt2TzEl.textContent   = loc?.timezone ? loc.timezone.toUpperCase() : '—';
  if (loc) alt2CityInput.value = loc.name || '';
  tickClock();
}

async function geocodeForTimezone(name) {
  // Reuses Open-Meteo's geocoding API; the response includes .timezone.
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error(`Couldn't find "${name}"`);
  return { name: hit.name, timezone: hit.timezone, country: hit.country_code || hit.country };
}

altCityInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const v = altCityInput.value.trim();
  if (!v) return;
  altNameEl.textContent = 'LOOKING UP…';
  try {
    const hit = await geocodeForTimezone(v);
    await window.dash?.setConfig?.({ altCity: hit });
    applyAltLocation(hit);
  } catch (err) {
    altNameEl.textContent = 'NOT FOUND';
  }
});

alt2CityInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const v = alt2CityInput.value.trim();
  if (!v) return;
  alt2NameEl.textContent = 'LOOKING UP…';
  try {
    const hit = await geocodeForTimezone(v);
    await window.dash?.setConfig?.({ altCity2: hit });
    applyAltLocation2(hit);
  } catch (err) {
    alt2NameEl.textContent = 'NOT FOUND';
  }
});

// ── HUD: System ──────────────────────────────────────────────────────────────
const sysCoresEl       = document.querySelector('#sys-cores');
const sysCoresValueEl  = document.querySelector('#sys-cores-value');
const sysCoresIdentEl  = document.querySelector('#sys-cores-ident');
const sysCpuBarEl      = document.querySelector('#sys-cpu-bar');
const sysCpuValEl      = document.querySelector('#sys-cpu-value');
const sysMemBarEl      = document.querySelector('#sys-mem-bar');
const sysMemValEl      = document.querySelector('#sys-mem-value');
const coreGridEl       = document.querySelector('#core-grid');
const memHistGridEl    = document.querySelector('#mem-hist-grid');
const memHistValueEl   = document.querySelector('#sys-mem-hist-value');
const scratchGridEl    = document.querySelector('#scratch-grid');
const scratchValueEl   = document.querySelector('#sys-scratch-value');

let lastCpuTimes = null;
const coreFillEls = []; // index = logical processor

function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${u[i]}`;
}

function deltaLoad(prev, curr) {
  // Returns load fraction [0,1] from two cpus.times samples.
  const pTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
  const cTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;
  const totalDelta = cTotal - pTotal;
  const idleDelta  = curr.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - idleDelta / totalDelta));
}

function buildCoreGrid(count) {
  coreGridEl.innerHTML = '';
  coreFillEls.length = 0;
  for (let i = 0; i < count; i++) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill  = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'core-bar-label';
    label.textContent = String(i).padStart(2, '0');
    bar.appendChild(track);
    bar.appendChild(label);
    coreGridEl.appendChild(bar);
    coreFillEls.push(fill);
  }
}

function paintCore(fill, load) {
  const pct = load * 100;
  fill.style.height = `${pct.toFixed(0)}%`;
  fill.classList.toggle('warn', pct >= 60 && pct < 85);
  fill.classList.toggle('high', pct >= 85);
}

// Memory history — time-series of system memory % usage.
const MEM_HIST_LEN = 30;                              // 30 samples × 2s = 60s window
const memHistBuf = new Array(MEM_HIST_LEN).fill(0);
const memHistFills = [];

function ensureMemHistGrid() {
  if (memHistFills.length === MEM_HIST_LEN) return;
  memHistGridEl.innerHTML = '';
  memHistFills.length = 0;
  for (let i = 0; i < MEM_HIST_LEN; i++) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    bar.appendChild(track);
    memHistGridEl.appendChild(bar);
    memHistFills.push(fill);
  }
}

function pushMemHistory(pct) {
  ensureMemHistGrid();
  memHistBuf.push(pct);
  if (memHistBuf.length > MEM_HIST_LEN) memHistBuf.shift();
  for (let i = 0; i < MEM_HIST_LEN; i++) {
    const v = memHistBuf[i];
    const fill = memHistFills[i];
    fill.style.height = `${v.toFixed(0)}%`;
    fill.classList.toggle('warn', v >= 60 && v < 85);
    fill.classList.toggle('high', v >= 85);
  }
  if (memHistValueEl) {
    const cur = memHistBuf[memHistBuf.length - 1] || 0;
    memHistValueEl.textContent = `${cur.toFixed(0)}%`;
  }
}

// Scratch-disk grid — one vertical bar per drive (built from storageInfo).
const scratchFills = [];
const scratchLabels = [];
let scratchKeys = [];

function buildScratchGrid(drives) {
  scratchGridEl.innerHTML = '';
  scratchFills.length = 0;
  scratchLabels.length = 0;
  scratchKeys = drives.map(d => d.mount);
  for (const d of drives) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'core-bar-label';
    label.textContent = d.mount.replace(/:$/, '');
    bar.appendChild(track);
    bar.appendChild(label);
    scratchGridEl.appendChild(bar);
    scratchFills.push(fill);
    scratchLabels.push(label);
  }
}

function paintScratchGrid(drives) {
  // If the set of drive letters changed, rebuild
  const keys = drives.map(d => d.mount);
  const changed = keys.length !== scratchKeys.length || keys.some((k, i) => k !== scratchKeys[i]);
  if (changed) buildScratchGrid(drives);

  let totalUsed = 0, totalCap = 0;
  for (let i = 0; i < drives.length; i++) {
    const d = drives[i];
    const sized = d.total > 0;
    const pct = sized ? (d.used / d.total) * 100 : 0;
    const fill = scratchFills[i];
    if (!fill) continue;
    fill.style.height = `${pct.toFixed(0)}%`;
    fill.classList.toggle('warn', pct >= 60 && pct < 85);
    fill.classList.toggle('high', pct >= 85);
    fill.style.opacity = sized ? '' : '0.25';
    if (sized) { totalUsed += d.used; totalCap += d.total; }
  }
  if (scratchValueEl) {
    scratchValueEl.textContent = totalCap > 0
      ? `${((totalUsed / totalCap) * 100).toFixed(0)}% USED`
      : '—';
  }
}

async function refreshSystem() {
  if (!window.dash) return;
  try {
    const info = await window.dash.systemInfo();

    if (coreFillEls.length !== info.cpuCount) {
      buildCoreGrid(info.cpuCount);
      sysCoresEl.textContent      = String(info.cpuCount).padStart(2, '0');
      sysCoresValueEl.textContent = `${info.cpuCount} LOGICAL`;
      sysCoresIdentEl.textContent = String(info.cpuCount).padStart(3, '0');
    }

    let cpuLoad = 0;
    if (lastCpuTimes && info.cpuTimes.length === lastCpuTimes.length) {
      let sum = 0;
      for (let i = 0; i < info.cpuTimes.length; i++) {
        const load = deltaLoad(lastCpuTimes[i], info.cpuTimes[i]);
        if (coreFillEls[i]) paintCore(coreFillEls[i], load);
        sum += load;
      }
      cpuLoad = sum / info.cpuTimes.length;
    } else {
      cpuLoad = Math.min(1, (info.loadavg?.[0] || 0) / Math.max(1, info.cpuCount));
    }
    lastCpuTimes = info.cpuTimes;

    const cpuPct = cpuLoad * 100;
    sysCpuBarEl.style.width = `${cpuPct.toFixed(0)}%`;
    sysCpuBarEl.classList.toggle('high', cpuPct >= 85);
    sysCpuValEl.textContent = `${cpuPct.toFixed(0)}%`;

    const memFrac = info.usedMem / info.totalMem;
    const memPct  = memFrac * 100;
    sysMemBarEl.style.width = `${memPct.toFixed(0)}%`;
    sysMemBarEl.classList.toggle('high', memPct >= 85);
    sysMemValEl.textContent = `${fmtBytes(info.usedMem)} / ${fmtBytes(info.totalMem)}`;

    pushMemHistory(memPct);
  } catch (err) {
    sysCoresValueEl.textContent = `ERR: ${err.message}`;
  }
}

refreshSystem();
setInterval(refreshSystem, 2000);

// ── HUD: Storage ─────────────────────────────────────────────────────────────
const storageListEl   = document.querySelector('#storage-list');
const storageCountEl  = document.querySelector('#storage-count');
const storageStatusEl = document.querySelector('#storage-status');

async function refreshStorage() {
  if (!window.dash) return;
  try {
    const drives = await window.dash.storageInfo();
    if (!drives?.length) {
      storageListEl.innerHTML = '<div class="storage-empty">NO DRIVES DETECTED.</div>';
      storageCountEl.textContent = '0';
      storageStatusEl.textContent = 'OFFLINE';
      storageStatusEl.className = 'footer-readout red';
      return;
    }
    storageCountEl.textContent = String(drives.length).padStart(2, '0');
    storageListEl.innerHTML = '';
    let totalAll = 0, usedAll = 0;
    for (const d of drives) {
      const sized = d.total > 0;
      if (sized) { totalAll += d.total; usedAll += d.used; }
      const usedPct = sized ? (d.used / d.total) * 100 : 0;
      const high = usedPct >= 90;
      const labelHtml = d.label ? ` <em>${escapeText(d.label)}</em>` : '';
      const valsHtml = sized
        ? `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`
        : `<span class="amber">[${(d.type || 'NETWORK').toUpperCase()}]</span>`;
      const barHtml = sized
        ? `<div class="seg-bar"><div class="seg-bar-fill seg-disk${high ? ' high' : ''}" style="width:${usedPct.toFixed(1)}%"></div></div>`
        : `<div class="seg-bar"><div class="seg-bar-fill seg-disk" style="width:0%; opacity:0.3"></div></div>`;
      const row = document.createElement('div');
      row.className = 'storage-row';
      row.innerHTML = `
        <div class="storage-row-head">
          <span class="storage-mount">&#9656; ${escapeText(d.mount)}${labelHtml}</span>
          <span class="storage-vals">${valsHtml}</span>
        </div>
        ${barHtml}
      `;
      storageListEl.appendChild(row);
    }
    const overallPct = totalAll > 0 ? (usedAll / totalAll) * 100 : 0;
    storageStatusEl.innerHTML = `<em>OVERALL</em> <strong class="amber">${overallPct.toFixed(0)}%</strong> <em>FREE</em> <strong class="ok">${fmtBytes(totalAll - usedAll)}</strong>`;
    storageStatusEl.className = 'footer-readout';

    paintScratchGrid(drives);
  } catch (err) {
    storageListEl.innerHTML = `<div class="storage-empty">ERROR: ${err.message}</div>`;
    storageStatusEl.textContent = 'ERR';
    storageStatusEl.className = 'footer-readout red';
  }
}

refreshStorage();
setInterval(refreshStorage, 30_000);

// ── HUD: Thermal ─────────────────────────────────────────────────────────────
const tempCpuEl       = document.querySelector('#temp-cpu');
const tempCpuBarEl    = document.querySelector('#temp-cpu-bar');
const tempCpuNameEl   = document.querySelector('#temp-cpu-name');
const tempGpu0El      = document.querySelector('#temp-gpu0');
const tempGpu0BarEl   = document.querySelector('#temp-gpu0-bar');
const tempGpu0NameEl  = document.querySelector('#temp-gpu0-name');
const tempGpu1El      = document.querySelector('#temp-gpu1');
const tempGpu1BarEl   = document.querySelector('#temp-gpu1-bar');
const tempGpu1NameEl  = document.querySelector('#temp-gpu1-name');
const tempsTagEl      = document.querySelector('#temps-tag');
const thermalStatusEl = document.querySelector('#thermal-status');

const TEMP_MAX = 100; // °C — bar fill scales 0..TEMP_MAX

function paintTemp(valueEl, barEl, temp) {
  if (temp == null || !Number.isFinite(temp)) {
    valueEl.textContent = 'N/A';
    barEl.style.width = '0%';
    barEl.classList.remove('warn', 'high');
    return;
  }
  valueEl.textContent = String(Math.round(temp));
  const pct = Math.max(0, Math.min(100, (temp / TEMP_MAX) * 100));
  barEl.style.width = `${pct.toFixed(0)}%`;
  barEl.classList.toggle('warn', temp >= 70 && temp < 85);
  barEl.classList.toggle('high', temp >= 85);
}

function shortGpuName(name) {
  if (!name) return '—';
  return name
    .replace(/NVIDIA |GeForce |AMD |Radeon |Intel\(R\) /gi, '')
    .trim()
    .toUpperCase()
    .slice(0, 28);
}

// GPU UTIL grid + GPU MEMORY rows (live in System panel; fed by tempsInfo)
const gpuGridEl       = document.querySelector('#gpu-grid');
const gpuMemListEl    = document.querySelector('#gpu-mem-list');
const sysGpuCountEl   = document.querySelector('#sys-gpu-count-value');
const sysGpuMemEl     = document.querySelector('#sys-gpu-mem-value');
const gpuFillEls = [];   // per-index util bar fills
const gpuPctEls  = [];   // per-index util % readout
const gpuMemRowEls = []; // per-index { row, fill, vals }

function buildGpuGrid(gpus) {
  gpuGridEl.innerHTML = '';
  gpuFillEls.length = 0;
  gpuPctEls.length = 0;
  for (let i = 0; i < gpus.length; i++) {
    const bar = document.createElement('div');
    bar.className = 'gpu-bar';
    const track = document.createElement('div');
    track.className = 'gpu-bar-track';
    const fill = document.createElement('div');
    fill.className = 'gpu-bar-fill';
    track.appendChild(fill);

    const labelRow = document.createElement('div');
    labelRow.className = 'gpu-bar-label';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'gpu-name';
    nameSpan.textContent = `GPU ${i} · ${shortGpuName(gpus[i]?.name)}`;
    const pctSpan = document.createElement('span');
    pctSpan.className = 'gpu-pct';
    pctSpan.textContent = '—';
    labelRow.appendChild(nameSpan);
    labelRow.appendChild(pctSpan);

    bar.appendChild(track);
    bar.appendChild(labelRow);
    gpuGridEl.appendChild(bar);
    gpuFillEls.push(fill);
    gpuPctEls.push(pctSpan);
  }
}

function buildGpuMemList(gpus) {
  gpuMemListEl.innerHTML = '';
  gpuMemRowEls.length = 0;
  for (let i = 0; i < gpus.length; i++) {
    const row = document.createElement('div');
    row.className = 'gpu-mem-row';
    const head = document.createElement('div');
    head.className = 'gpu-mem-head';
    const lbl = document.createElement('span');
    lbl.className = 'gpu-mem-label';
    lbl.textContent = `GPU ${i}`;
    const vals = document.createElement('span');
    vals.className = 'gpu-mem-vals';
    vals.textContent = '—';
    head.appendChild(lbl);
    head.appendChild(vals);
    const bar = document.createElement('div');
    bar.className = 'seg-bar';
    const fill = document.createElement('div');
    fill.className = 'seg-bar-fill seg-mem';
    bar.appendChild(fill);
    row.appendChild(head);
    row.appendChild(bar);
    gpuMemListEl.appendChild(row);
    gpuMemRowEls.push({ row, fill, vals });
  }
}

function paintGpuUtil(fill, pctEl, util) {
  if (util == null || !Number.isFinite(util)) {
    fill.style.height = '0%';
    fill.classList.remove('warn', 'high');
    pctEl.textContent = 'N/A';
    return;
  }
  const pct = Math.max(0, Math.min(100, util));
  fill.style.height = `${pct.toFixed(0)}%`;
  fill.classList.toggle('warn', pct >= 60 && pct < 85);
  fill.classList.toggle('high', pct >= 85);
  pctEl.textContent = `${pct.toFixed(0)}%`;
}

function paintGpuMem(rowEls, used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    rowEls.fill.style.width = '0%';
    rowEls.fill.classList.remove('high');
    rowEls.vals.textContent = 'N/A';
    return;
  }
  const pct = (used / total) * 100;
  rowEls.fill.style.width = `${pct.toFixed(0)}%`;
  rowEls.fill.classList.toggle('high', pct >= 90);
  rowEls.vals.textContent = `${fmtBytes(used)} / ${fmtBytes(total)}`;
}

function paintGpuPanel(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  if (gpuFillEls.length !== list.length) buildGpuGrid(list);
  if (gpuMemRowEls.length !== list.length) buildGpuMemList(list);

  let totalUsed = 0, totalCap = 0;
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    paintGpuUtil(gpuFillEls[i], gpuPctEls[i], g?.load);
    paintGpuMem(gpuMemRowEls[i], g?.memUsed, g?.memTotal);
    if (Number.isFinite(g?.memUsed))  totalUsed += g.memUsed;
    if (Number.isFinite(g?.memTotal)) totalCap  += g.memTotal;
  }

  if (sysGpuCountEl) {
    sysGpuCountEl.textContent = list.length ? `${list.length} GPU${list.length === 1 ? '' : 'S'}` : 'NONE';
  }
  if (sysGpuMemEl) {
    sysGpuMemEl.textContent = totalCap > 0 ? `${fmtBytes(totalUsed)} / ${fmtBytes(totalCap)}` : 'N/A';
  }
}

async function refreshTemps() {
  if (!window.dash?.tempsInfo) return;
  try {
    const t = await window.dash.tempsInfo();
    paintGpuPanel(t.gpus);
    paintTemp(tempCpuEl, tempCpuBarEl, t.cpu);
    tempCpuNameEl.textContent = (t.cpu == null) ? 'NO SENSOR' : 'ACPI/SMBUS';

    const g0 = t.gpus?.[0];
    paintTemp(tempGpu0El, tempGpu0BarEl, g0?.temp);
    tempGpu0NameEl.textContent = g0 ? shortGpuName(g0.name) : 'NONE';

    const g1 = t.gpus?.[1];
    paintTemp(tempGpu1El, tempGpu1BarEl, g1?.temp);
    tempGpu1NameEl.textContent = g1 ? shortGpuName(g1.name) : 'NONE';

    const sources = [];
    if (t.cpu != null) sources.push('CPU');
    if (g0?.temp != null) sources.push('GPU0');
    if (g1?.temp != null) sources.push('GPU1');
    tempsTagEl.textContent = String(sources.length).padStart(2, '0');
    if (!sources.length) {
      thermalStatusEl.innerHTML = '<em>SENSOR</em> <strong class="amber">OFFLINE</strong> <em>HINT</em> <strong>RUN LHM</strong>';
      thermalStatusEl.className = 'footer-readout';
    } else {
      thermalStatusEl.innerHTML = `<em>SOURCES</em> <strong class="ok">${sources.join(' · ')}</strong>`;
      thermalStatusEl.className = 'footer-readout';
    }
  } catch (err) {
    thermalStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    thermalStatusEl.className = 'footer-readout red';
  }
}

refreshTemps();
setInterval(refreshTemps, 5000);

// ── HUD: Network ─────────────────────────────────────────────────────────────
const netRxEl       = document.querySelector('#net-rx');
const netRxUnitEl   = document.querySelector('#net-rx-unit');
const netTxEl       = document.querySelector('#net-tx');
const netTxUnitEl   = document.querySelector('#net-tx-unit');
const netRxTotalEl  = document.querySelector('#net-rx-total');
const netTxTotalEl  = document.querySelector('#net-tx-total');
const netIfaceEl    = document.querySelector('#net-iface');
const netIfaceTagEl = document.querySelector('#net-iface-tag');
const netStatusEl   = document.querySelector('#net-status');
const netRxSparkEl  = document.querySelector('#net-rx-spark');
const netTxSparkEl  = document.querySelector('#net-tx-spark');

const SPARK_SAMPLES = 60;
const rxBuf = new Array(SPARK_SAMPLES).fill(0);
const txBuf = new Array(SPARK_SAMPLES).fill(0);

function fmtRate(bytesPerSec) {
  const u = ['B/S', 'KB/S', 'MB/S', 'GB/S'];
  let i = 0; let v = bytesPerSec;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const num = v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
  return { num, unit: u[i] };
}

function pushSpark(buf, val) {
  buf.push(val);
  if (buf.length > SPARK_SAMPLES) buf.shift();
}

function renderSpark(svg, samples) {
  const w = 100, h = 30;
  const max = Math.max(1, ...samples);
  const last = samples.length - 1;
  if (last <= 0) {
    svg.innerHTML = '';
    return;
  }
  const pts = samples.map((v, i) => {
    const x = (i / last) * w;
    const y = h - (v / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  svg.innerHTML = `<polyline points="${pts}"/>`;
}

async function refreshNet() {
  if (!window.dash?.netInfo) return;
  try {
    const n = await window.dash.netInfo();
    pushSpark(rxBuf, n.rxSec || 0);
    pushSpark(txBuf, n.txSec || 0);

    const r = fmtRate(n.rxSec || 0);
    const t = fmtRate(n.txSec || 0);
    netRxEl.textContent = r.num;
    netRxUnitEl.textContent = r.unit;
    netTxEl.textContent = t.num;
    netTxUnitEl.textContent = t.unit;

    netRxTotalEl.textContent = fmtBytes(n.rxTotal || 0);
    netTxTotalEl.textContent = fmtBytes(n.txTotal || 0);
    netIfaceEl.textContent   = (n.iface || 'NONE').toUpperCase();
    netIfaceTagEl.textContent = String(n.interfaces || 0).padStart(2, '0');

    renderSpark(netRxSparkEl, rxBuf);
    renderSpark(netTxSparkEl, txBuf);

    const total = (n.rxSec || 0) + (n.txSec || 0);
    if (total <= 0) {
      netStatusEl.innerHTML = '<em>STATE</em> <strong class="amber">IDLE</strong>';
    } else {
      netStatusEl.innerHTML = `<em>STATE</em> <strong class="ok">ACTIVE</strong> <em>RATE</em> <strong>${fmtRate(total).num} ${fmtRate(total).unit}</strong>`;
    }
    netStatusEl.className = 'footer-readout';
  } catch (err) {
    netStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    netStatusEl.className = 'footer-readout red';
  }
}

// First call seeds the rate baseline; chained scheduling keeps calls serialized.
async function netLoop() {
  await refreshNet();
  setTimeout(netLoop, 1000);
}
netLoop();

// ── HUD: Drive I/O ───────────────────────────────────────────────────────────
const diskReadEl       = document.querySelector('#disk-read');
const diskReadUnitEl   = document.querySelector('#disk-read-unit');
const diskWriteEl      = document.querySelector('#disk-write');
const diskWriteUnitEl  = document.querySelector('#disk-write-unit');
const diskXferEl       = document.querySelector('#disk-xfer');
const diskQueueEl      = document.querySelector('#disk-queue');
const diskQueueTagEl   = document.querySelector('#disk-queue-tag');
const diskStatusEl     = document.querySelector('#disk-status');
const diskReadSparkEl  = document.querySelector('#disk-read-spark');
const diskWriteSparkEl = document.querySelector('#disk-write-spark');

const dRBuf = new Array(SPARK_SAMPLES).fill(0);
const dWBuf = new Array(SPARK_SAMPLES).fill(0);

async function refreshDisk() {
  if (!window.dash?.diskInfo) return;
  try {
    const d = await window.dash.diskInfo();
    pushSpark(dRBuf, d.readSec  || 0);
    pushSpark(dWBuf, d.writeSec || 0);

    const r = fmtRate(d.readSec  || 0);
    const w = fmtRate(d.writeSec || 0);
    diskReadEl.textContent      = r.num;
    diskReadUnitEl.textContent  = r.unit;
    diskWriteEl.textContent     = w.num;
    diskWriteUnitEl.textContent = w.unit;

    diskXferEl.textContent     = Number.isFinite(d.transferSec) ? d.transferSec.toFixed(0) : '—';
    diskQueueEl.textContent    = Number.isFinite(d.queue) ? d.queue.toFixed(0) : '—';
    diskQueueTagEl.textContent = Number.isFinite(d.queue) ? String(d.queue).padStart(2, '0') : '00';

    renderSpark(diskReadSparkEl,  dRBuf);
    renderSpark(diskWriteSparkEl, dWBuf);

    if (!d.supported) {
      diskStatusEl.innerHTML = '<em>STATE</em> <strong class="amber">UNSUPPORTED</strong>';
    } else {
      const total = (d.readSec || 0) + (d.writeSec || 0);
      if (total <= 0) {
        diskStatusEl.innerHTML = '<em>STATE</em> <strong class="amber">IDLE</strong>';
      } else {
        const t = fmtRate(total);
        diskStatusEl.innerHTML = `<em>STATE</em> <strong class="ok">ACTIVE</strong> <em>RATE</em> <strong>${t.num} ${t.unit}</strong>`;
      }
    }
    diskStatusEl.className = 'footer-readout';
  } catch (err) {
    diskStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    diskStatusEl.className = 'footer-readout red';
  }
}

// Disk I/O polling at 2s — PowerShell call has ~500ms cold start, 1s would overlap.
async function diskLoop() {
  await refreshDisk();
  setTimeout(diskLoop, 2000);
}
diskLoop();

// ── HUD: Weather (Open-Meteo) ────────────────────────────────────────────────
const weatherCityEl   = document.querySelector('#weather-city');
const weatherTempEl   = document.querySelector('#weather-temp');
const weatherCondEl   = document.querySelector('#weather-cond');
const weatherLocEl    = document.querySelector('#weather-loc');
const weatherDetailEl = document.querySelector('#weather-detail');
const weatherStatusEl = document.querySelector('#weather-status');
const weatherPidEl    = document.querySelector('#weather-pid');

// https://open-meteo.com/en/docs#weather_variable_documentation
const WEATHER_CODES = {
  0:  ['Clear', '☀'],
  1:  ['Mainly clear', '🌤'],
  2:  ['Partly cloudy', '⛅'],
  3:  ['Overcast', '☁'],
  45: ['Fog', '🌫'],
  48: ['Rime fog', '🌫'],
  51: ['Light drizzle', '🌦'],
  53: ['Drizzle', '🌦'],
  55: ['Heavy drizzle', '🌧'],
  56: ['Freezing drizzle', '🌧'],
  57: ['Heavy freezing drizzle', '🌧'],
  61: ['Light rain', '🌦'],
  63: ['Rain', '🌧'],
  65: ['Heavy rain', '🌧'],
  66: ['Freezing rain', '🌧'],
  67: ['Heavy freezing rain', '🌧'],
  71: ['Light snow', '🌨'],
  73: ['Snow', '🌨'],
  75: ['Heavy snow', '❄'],
  77: ['Snow grains', '🌨'],
  80: ['Rain showers', '🌦'],
  81: ['Heavy showers', '🌧'],
  82: ['Violent showers', '⛈'],
  85: ['Snow showers', '🌨'],
  86: ['Heavy snow showers', '❄'],
  95: ['Thunderstorm', '⛈'],
  96: ['Thunderstorm + hail', '⛈'],
  99: ['Severe thunderstorm', '⛈'],
};

function describeWeather(code) {
  return WEATHER_CODES[code] || ['Unknown', '·'];
}

async function geocodeCity(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error(`Couldn't find "${name}"`);
  return hit;
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    timezone: 'auto',
    wind_speed_unit: 'mph',
    temperature_unit: 'fahrenheit',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
  return await res.json();
}

let activeLocation = null;
let weatherTimer = null;

function setStatus(msg, kind = '') {
  weatherStatusEl.textContent = (msg || '').toUpperCase();
  weatherStatusEl.className = `footer-readout ${kind}`;
}

function locationCode(loc) {
  // Compact 4-char ID: signed lat truncated + signed lon truncated, last 2 digits each
  const lat = Math.abs(Math.round(loc.latitude || 0)).toString().padStart(2, '0').slice(-2);
  const lon = Math.abs(Math.round(loc.longitude || 0)).toString().padStart(2, '0').slice(-2);
  return `${lat}-${lon}`;
}

async function loadWeather(loc) {
  setStatus('UPDATING…');
  try {
    const data = await fetchWeather(loc.latitude, loc.longitude);
    const c = data.current || {};
    const [text, icon] = describeWeather(c.weather_code);
    weatherTempEl.textContent = c.temperature_2m != null ? `${Math.round(c.temperature_2m)}` : '—';
    weatherCondEl.textContent = `${icon} ${text.toUpperCase()}`;
    const region = [loc.admin1, loc.country_code || loc.country].filter(Boolean).join(' · ');
    weatherLocEl.textContent = `${loc.name}${region ? ' · ' + region : ''}`.toUpperCase();
    const feels = c.apparent_temperature != null ? `FEELS ${Math.round(c.apparent_temperature)}°` : '';
    const hum   = c.relative_humidity_2m != null ? `${c.relative_humidity_2m}% RH` : '';
    const wind  = c.wind_speed_10m != null ? `${Math.round(c.wind_speed_10m)} MPH` : '';
    weatherDetailEl.textContent = [feels, hum, wind].filter(Boolean).join(' · ') || '—';
    weatherPidEl.textContent = locationCode(loc);
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    weatherStatusEl.innerHTML = `<em>SYNC</em> <strong class="ok">OK</strong> <em>UPDATED</em> <strong>${stamp}</strong>`;
    weatherStatusEl.className = 'footer-readout';
  } catch (err) {
    setStatus(err.message, 'red');
  }
}

async function selectCity(name) {
  setStatus('LOOKING UP…');
  try {
    const hit = await geocodeCity(name);
    activeLocation = hit;
    await window.dash?.setConfig?.({ weatherCity: hit });
    if (weatherTimer) clearInterval(weatherTimer);
    weatherTimer = setInterval(() => loadWeather(hit), 10 * 60 * 1000);
    await loadWeather(hit);
  } catch (err) {
    setStatus(err.message, 'red');
  }
}

weatherCityEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = weatherCityEl.value.trim();
  if (v) selectCity(v);
});

// ── Notes (tabbed scratchpad) ───────────────────────────────────────────────
const noteTabsEl      = document.querySelector('#note-tabs');
const noteTextareaEl  = document.querySelector('#note-textarea');
const notesStatusEl   = document.querySelector('#notes-status');
const notesTabCountEl = document.querySelector('#notes-tab-count');

const TAB_NAME_MAX = 14;
let notesState = { active: null, tabs: [] };
let noteSaveTimer = null;

function newTabId() { return 'tab-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4); }

function activeNoteTab() {
  return notesState.tabs.find(t => t.id === notesState.active) || null;
}

function makeTabEl(tab) {
  const btn = document.createElement('button');
  btn.className = 'note-tab' + (tab.id === notesState.active ? ' is-active' : '');
  btn.dataset.id = tab.id;
  btn.title = 'Click to switch · Double-click to rename';
  btn.type = 'button';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'note-tab-name';
  nameSpan.textContent = tab.name || 'NOTE';

  const closeSpan = document.createElement('span');
  closeSpan.className = 'note-tab-close';
  closeSpan.textContent = '×'; // ×
  closeSpan.title = 'Delete tab';

  btn.appendChild(nameSpan);
  btn.appendChild(closeSpan);

  btn.addEventListener('click', (e) => {
    if (e.target === closeSpan) {
      e.stopPropagation();
      deleteNote(tab.id);
      return;
    }
    switchNote(tab.id);
  });

  btn.addEventListener('dblclick', (e) => {
    if (e.target === closeSpan) return;
    const newName = window.prompt('Tab name', tab.name || 'NOTE');
    if (newName && newName.trim()) {
      tab.name = newName.trim().toUpperCase().slice(0, TAB_NAME_MAX);
      renderNoteTabs();
      saveNotesNow();
    }
  });

  return btn;
}

function renderNoteTabs() {
  noteTabsEl.innerHTML = '';
  for (const tab of notesState.tabs) noteTabsEl.appendChild(makeTabEl(tab));

  const addBtn = document.createElement('button');
  addBtn.className = 'note-tab note-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New tab';
  addBtn.type = 'button';
  addBtn.addEventListener('click', addNote);
  noteTabsEl.appendChild(addBtn);

  if (notesTabCountEl) {
    notesTabCountEl.textContent = String(notesState.tabs.length).padStart(2, '0');
  }
}

function renderActiveNote() {
  const tab = activeNoteTab();
  noteTextareaEl.value = tab?.body || '';
}

function switchNote(id) {
  // Sync current textarea back to the previously active tab before switching
  const prev = activeNoteTab();
  if (prev) prev.body = noteTextareaEl.value;
  if (notesState.active === id) return;
  notesState.active = id;
  renderNoteTabs();
  renderActiveNote();
  saveNotesNow();
}

function addNote() {
  const id = newTabId();
  notesState.tabs.push({ id, name: `NOTE ${notesState.tabs.length + 1}`, body: '' });
  notesState.active = id;
  renderNoteTabs();
  renderActiveNote();
  noteTextareaEl.focus();
  saveNotesNow();
}

function deleteNote(id) {
  const idx = notesState.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  if (notesState.tabs.length <= 1) {
    // Last tab — clear contents but don't delete
    notesState.tabs[0].body = '';
    noteTextareaEl.value = '';
    saveNotesNow();
    return;
  }
  notesState.tabs.splice(idx, 1);
  if (notesState.active === id) {
    notesState.active = notesState.tabs[Math.max(0, idx - 1)].id;
  }
  renderNoteTabs();
  renderActiveNote();
  saveNotesNow();
}

function setNotesStatus(state, color) {
  if (!notesStatusEl) return;
  notesStatusEl.innerHTML = `<em>STATE</em> <strong class="${color}">${state}</strong> <em>TABS</em> <strong>${notesState.tabs.length}</strong>`;
  notesStatusEl.className = 'footer-readout';
}

function scheduleNoteSave() {
  // Buffer the active body in memory immediately so tab switches don't lose data.
  const tab = activeNoteTab();
  if (tab) tab.body = noteTextareaEl.value;
  setNotesStatus('EDITING', 'amber');
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(saveNotesNow, 500);
}

async function saveNotesNow() {
  clearTimeout(noteSaveTimer);
  const tab = activeNoteTab();
  if (tab) tab.body = noteTextareaEl.value;
  if (window.dash?.setConfig) {
    try {
      await window.dash.setConfig({ notes: notesState });
      setNotesStatus('SAVED', 'ok');
    } catch (err) {
      setNotesStatus(`ERR: ${err.message}`.toUpperCase(), 'red');
    }
  } else {
    setNotesStatus('LOCAL', 'amber');
  }
}

noteTextareaEl.addEventListener('input', scheduleNoteSave);

function initNotes(cfg) {
  const saved = cfg?.notes;
  if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
    notesState = {
      active: saved.active,
      tabs: saved.tabs.map(t => ({
        id: t.id || newTabId(),
        name: (t.name || 'NOTE').slice(0, TAB_NAME_MAX),
        body: typeof t.body === 'string' ? t.body : '',
      })),
    };
    if (!notesState.tabs.find(t => t.id === notesState.active)) {
      notesState.active = notesState.tabs[0].id;
    }
  } else {
    const id = newTabId();
    notesState = { active: id, tabs: [{ id, name: 'NOTES', body: '' }] };
  }
  renderNoteTabs();
  renderActiveNote();
  setNotesStatus('SAVED', 'ok');
}

// ── Panel resize (4 corner handles — both axes, anchor follows cursor) ─────
const PANEL_MIN_W = 280;
const PANEL_MIN_H = 120;

function panelKey(panel) {
  for (const cls of panel.classList) {
    if (cls.startsWith('panel-')) return cls.slice('panel-'.length);
  }
  return null;
}

function applyPanelSize(panel, size) {
  if (!size) return;
  if (Number.isFinite(size.width)) {
    panel.style.flex = '0 0 auto';
    panel.style.width = `${size.width}px`;
    panel.style.maxWidth = `${size.width}px`;
  }
  if (Number.isFinite(size.x) && Number.isFinite(size.y)) {
    panel.style.position = 'fixed';
    panel.style.left = `${size.x}px`;
    panel.style.top  = `${size.y}px`;
    if (Number.isFinite(size.height)) panel.style.height = `${size.height}px`;
  }
}

function clearPanelSize(panel) {
  panel.style.flex = '';
  panel.style.width = '';
  panel.style.height = '';
  panel.style.maxWidth = '';
  panel.style.position = '';
  panel.style.left = '';
  panel.style.top = '';
}

async function savePanelSize(id, partial) {
  // partial = { width? , x?, y?, height? } — merged into existing entry.
  if (!window.dash?.getConfig) return;
  const cfg = await window.dash.getConfig();
  const sizes = { ...(cfg.panelSizes || {}) };
  sizes[id] = { ...(sizes[id] || {}), ...partial };
  await window.dash.setConfig({ panelSizes: sizes });
}

async function resetAllPanelSizes() {
  for (const panel of document.querySelectorAll('.panel')) clearPanelSize(panel);
  if (!window.dash?.setConfig) return;
  await window.dash.setConfig({ panelSizes: {} });
}

function makeResizeHandle(panel, key, corner /* 'nw' | 'ne' | 'sw' | 'se' */) {
  const handle = document.createElement('div');
  handle.className = `resize-handle resize-handle-${corner}`;
  handle.title = 'Drag to resize · Ctrl+Shift+R to reset';
  panel.appendChild(handle);

  const grows = {
    n: corner[0] === 'n',
    s: corner[0] === 's',
    w: corner[1] === 'w',
    e: corner[1] === 'e',
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = rect.width, startH = rect.height;
    const startLeft = rect.left, startTop = rect.top;
    panel.classList.add('is-resizing');

    // Detach panel from the grid so left/top can be controlled. Lock current
    // position so the panel doesn't visually jump on the first move.
    panel.style.position = 'fixed';
    panel.style.left = `${startLeft}px`;
    panel.style.top  = `${startTop}px`;
    panel.style.flex = '0 0 auto';

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;

      if (grows.e) newW = startW + dx;
      if (grows.w) { newW = startW - dx; newLeft = startLeft + dx; }
      if (grows.s) newH = startH + dy;
      if (grows.n) { newH = startH - dy; newTop = startTop + dy; }

      if (newW < PANEL_MIN_W) {
        if (grows.w) newLeft = startLeft + (startW - PANEL_MIN_W);
        newW = PANEL_MIN_W;
      }
      if (newH < PANEL_MIN_H) {
        if (grows.n) newTop = startTop + (startH - PANEL_MIN_H);
        newH = PANEL_MIN_H;
      }

      panel.style.width    = `${Math.round(newW)}px`;
      panel.style.height   = `${Math.round(newH)}px`;
      panel.style.maxWidth = `${Math.round(newW)}px`;
      panel.style.left = `${Math.round(newLeft)}px`;
      panel.style.top  = `${Math.round(newTop)}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panel.classList.remove('is-resizing');
      const w = parseInt(panel.style.width, 10);
      const h = parseInt(panel.style.height, 10);
      const x = parseInt(panel.style.left, 10);
      const y = parseInt(panel.style.top, 10);
      const partial = {};
      if (Number.isFinite(w)) partial.width  = w;
      if (Number.isFinite(h)) partial.height = h;
      if (Number.isFinite(x)) partial.x = x;
      if (Number.isFinite(y)) partial.y = y;
      savePanelSize(key, partial);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Drag-to-move via the panel header.
function attachDrag(panel) {
  const key = panelKey(panel);
  const header = panel.querySelector('.panel-header');
  if (!key || !header) return;
  header.classList.add('is-draggable');

  header.addEventListener('mousedown', (e) => {
    // Don't hijack clicks on inputs/buttons inside the header.
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;

    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop  = rect.top;
    panel.classList.add('is-dragging');

    // Detach from the grid: lock current size + position so layout doesn't jump.
    panel.style.position = 'fixed';
    panel.style.left   = `${startLeft}px`;
    panel.style.top    = `${startTop}px`;
    panel.style.width  = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
    panel.style.maxWidth = `${rect.width}px`;

    const onMove = (ev) => {
      panel.style.left = `${startLeft + (ev.clientX - startX)}px`;
      panel.style.top  = `${startTop  + (ev.clientY - startY)}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panel.classList.remove('is-dragging');
      const x = parseInt(panel.style.left, 10);
      const y = parseInt(panel.style.top,  10);
      const h = parseInt(panel.style.height, 10);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        savePanelSize(key, { x, y, height: Number.isFinite(h) ? h : undefined });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function attachResize(panel) {
  const key = panelKey(panel);
  if (!key) return;
  makeResizeHandle(panel, key, 'nw');
  makeResizeHandle(panel, key, 'ne');
  makeResizeHandle(panel, key, 'sw');
  makeResizeHandle(panel, key, 'se');
}

document.querySelectorAll('.panel').forEach(panel => {
  attachResize(panel);
  attachDrag(panel);
});

// ── Init from persistent config ──────────────────────────────────────────────
(async function initFromConfig() {
  if (!window.dash?.getConfig) {
    setStatus('ENTER CITY · PRESS ENTER');
    initNotes(null);
    return;
  }
  const cfg = await window.dash.getConfig();

  if (cfg?.panelSizes) {
    for (const panel of document.querySelectorAll('.panel')) {
      const k = panelKey(panel);
      if (k && cfg.panelSizes[k]) applyPanelSize(panel, cfg.panelSizes[k]);
    }
  }

  initNotes(cfg);

  if (cfg?.altCity)  applyAltLocation(cfg.altCity);
  if (cfg?.altCity2) applyAltLocation2(cfg.altCity2);
  if (cfg?.weatherCity) {
    activeLocation = cfg.weatherCity;
    weatherCityEl.value = activeLocation.name || '';
    loadWeather(activeLocation);
    weatherTimer = setInterval(() => loadWeather(activeLocation), 10 * 60 * 1000);
  } else {
    setStatus('ENTER CITY · PRESS ENTER');
  }
})();

// Refresh button — reloads the renderer (re-runs app.js, re-reads config).
document.querySelector('#refresh-btn')?.addEventListener('click', () => {
  window.location.reload();
});

// Keyboard shortcuts:
//   F11           — toggle fullscreen
//   F5            — reload the dashboard
//   Ctrl+Shift+R  — reset all panel widths
window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    e.preventDefault();
    window.dash?.toggleFullscreen?.();
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    window.location.reload();
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
    e.preventDefault();
    resetAllPanelSizes();
  }
});
