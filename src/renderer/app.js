import './styles.css';

// Bumped on every theme change. Canvas renderers (audio bars, sparklines)
// cache CSS-variable lookups + LinearGradient objects keyed by this version
// so they don't call getComputedStyle on every frame. Declared at module
// top so factory functions defined further down (createAudioVisualizer)
// can read it during their init render() pass without hitting the TDZ.
let _themeVersion = 0;

// Alert-theme state. Declared at module top so refreshSystem / refreshTemps
// (which run synchronously during module init) can call setAlertReason
// without hitting the TDZ. The setter functions themselves are defined
// further down with the rest of the theme code.
const ALERT_REASON = Object.freeze({
  CPU_90:      'cpu-90',
  GPU_90:      'gpu-90',
  OFFLINE:     'offline',
  ERROR_SYS:   'error-sys',
  ERROR_TEMPS: 'error-temps',
  ERROR_NET:   'error-net',
});
let   _userTheme   = null;
let   _alertActive = false;
const _alertReasons = new Set();

// ── Browser-mode shim ───────────────────────────────────────────────────────
// When loaded outside Electron (iPad, phone, another laptop on the LAN), the
// preload bridge isn't injected, so we install a fetch-backed equivalent that
// hits the HTTP API the main process exposes. Window-only operations
// (fullscreen, always-on-bottom IPC) become no-ops in this mode.
const IS_ELECTRON = !!window.dash;
if (!IS_ELECTRON) {
  async function getJson(p) {
    const r = await fetch(p);
    if (!r.ok) throw new Error(`${p} ${r.status}`);
    return r.json();
  }
  async function postJson(p, body) {
    const r = await fetch(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${p} ${r.status}`);
    return r.json();
  }
  window.dash = {
    platform:         'browser',
    systemInfo:       () => getJson('/api/system-info'),
    storageInfo:      () => getJson('/api/storage-info'),
    tempsInfo:        () => getJson('/api/temps-info'),
    netInfo:          () => getJson('/api/net-info'),
    diskInfo:         () => getJson('/api/disk-info'),
    getConfig:        () => getJson('/api/config'),
    setConfig:        (partial) => postJson('/api/config', partial),
    configPath:       () => Promise.resolve('(server-side)'),
    azureAutoConfig:  () => getJson('/api/azure-auto-config'),
    getScreenSources: () => getJson('/api/screen-sources'),
    toggleFullscreen: async () => {
      // Use the browser's own fullscreen API as a best-effort.
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen?.();
      return !!document.fullscreenElement;
    },
  };
}

// Background is now a pure CSS flat grid with a slow pulse animation —
// no WebGL scene needed.

// ── Background random-darkening overlay ─────────────────────────────────────
// One <div> per major (200px) grid cell. Each cell schedules its own
// independent timer to fade between 0 and a random dark opacity, giving the
// background a roving "blinds-and-spotlights" feel.
const BG_CELL = 200;
const BG_OVERLAY = document.querySelector('#bg-grid-overlay');

function buildBgCells() {
  if (!BG_OVERLAY) return;
  BG_OVERLAY.innerHTML = '';
  const cols = Math.ceil(window.innerWidth  / BG_CELL) + 1;
  const rows = Math.ceil(window.innerHeight / BG_CELL) + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'bg-grid-cell';
      cell.style.left = `${c * BG_CELL}px`;
      cell.style.top  = `${r * BG_CELL}px`;
      BG_OVERLAY.appendChild(cell);
      scheduleBgCell(cell, true);
    }
  }
}

function scheduleBgCell(cell, immediate) {
  const apply = () => {
    if (!cell.isConnected) return;
    const dark = Math.random() < 0.32;
    cell.style.opacity = dark ? (0.2 + Math.random() * 0.5).toFixed(2) : '0';
    scheduleBgCell(cell, false);
  };
  if (immediate) apply();
  else setTimeout(apply, 1500 + Math.random() * 5000);
}

buildBgCells();

// Rebuild on resize — only when the cell count would actually change.
let _bgResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_bgResizeTimer);
  _bgResizeTimer = setTimeout(buildBgCells, 200);
});

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

const zenTimeEl       = document.querySelector('#zen-time');
const zenAmpmEl       = document.querySelector('#zen-ampm');
const zenAmpmMirEl    = document.querySelector('#zen-ampm-mirror');
const zenDateEl       = document.querySelector('#zen-date');
const webcamStampEl   = document.querySelector('#webcam-timestamp');

// Pad helper for the webcam date stamp.
function _pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Build the zen clock as per-character spans with fixed widths so the
// centered clock can't drift sideways as digits change.
const _zenTimeCells = [];
let _zenTimeInitialized = false;
function paintZenTime(text) {
  if (!zenTimeEl) return;
  // First call: blow away the placeholder text node ("--:--:--") that sits
  // next to the spans we're about to add. Without this you see the dashes
  // ghosted in front of the live clock on the first tick.
  if (!_zenTimeInitialized) {
    zenTimeEl.textContent = '';
    _zenTimeInitialized = true;
  }
  // Reuse spans where possible to keep DOM thrash to a minimum.
  while (_zenTimeCells.length < text.length) {
    const s = document.createElement('span');
    s.className = 'zen-time-char';
    zenTimeEl.appendChild(s);
    _zenTimeCells.push(s);
  }
  while (_zenTimeCells.length > text.length) {
    const s = _zenTimeCells.pop();
    zenTimeEl.removeChild(s);
  }
  let anyChanged = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const cell = _zenTimeCells[i];
    if (cell.textContent !== ch) {
      cell.textContent = ch;
      anyChanged = true;
      // Restart the pop animation: drop the class, force a reflow so the
      // browser commits the removed state, then re-add. Without the
      // reflow trick the animation wouldn't re-trigger when the same
      // class is removed and re-added in the same frame.
      cell.classList.remove('is-popping');
      void cell.offsetWidth;
      cell.classList.add('is-popping');
    }
    const sep = (ch === ':' || ch === '.') ? '1' : '0';
    if (cell.dataset.sep !== sep) cell.dataset.sep = sep;
  }
  // Whole-clock hop on any digit change — same reflow trick to retrigger.
  if (anyChanged) {
    const clockEl = zenTimeEl.parentElement;
    if (clockEl) {
      clockEl.classList.remove('is-jumping');
      void clockEl.offsetWidth;
      clockEl.classList.add('is-jumping');
    }
  }
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
  // Mirror to the zen overlay (visible only while idle). Mirror element
  // tracks the visible AM/PM text so the invisible spacer width matches
  // exactly, keeping the time pinned to viewport center. Each character of
  // the time goes into its own fixed-width span so the display-font (which
  // doesn't have true tabular numerals) can't make the row jiggle.
  if (zenTimeEl) paintZenTime(lhms);
  if (zenAmpmEl)    zenAmpmEl.textContent    = lap;
  if (zenAmpmMirEl) zenAmpmMirEl.textContent = lap;
  if (zenDateEl)    zenDateEl.textContent    = dateFmt.format(now).toUpperCase();
  // Security-cam style timestamp on the webcam panel: ISO date + 24h time.
  if (webcamStampEl) {
    const iso = `${now.getFullYear()}-${_pad2(now.getMonth() + 1)}-${_pad2(now.getDate())}`;
    const t24 = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    webcamStampEl.textContent = `${iso}  ${t24}`;
  }

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

// Generic metric-bar helper: paints a .core-bar-fill or .gpu-bar-fill, then
// manages a floating peak marker (snap up, hold, slow decay) as a sibling
// inside the same track. Replaces the old warn/high class swap — the
// underlying fill background is now a cool→warm→hot vertical gradient
// anchored to the track's pixel height via --bar-h, so the peak alone
// communicates urgency.
//
// Tuned for the slow update rates of these graphs (CPU/GPU/RAM tick every
// 2 s). HOLD=1 frame ≈ 2 s pause at the peak; DECAY=30 means the peak drops
// 30 percentage points per update, so a fresh 100 % peak clears in ~3
// frames (≈ 6 s). The CSS transition on .core-bar-peak / .gpu-bar-peak
// smooths the visual fall between the discrete updates.
const METRIC_PEAK_HOLD_FRAMES = 1;
const METRIC_PEAK_DECAY = 30;

function setMetricBar(fill, pct) {
  if (!fill) return;
  pct = Math.max(0, Math.min(100, +pct || 0));
  fill.style.height = `${pct.toFixed(0)}%`;
  const track = fill.parentElement;
  if (!track) return;
  const peakClass = fill.classList.contains('gpu-bar-fill') ? 'gpu-bar-peak' : 'core-bar-peak';
  let peak = track.querySelector(`:scope > .${peakClass}`);
  if (!peak) {
    peak = document.createElement('div');
    peak.className = peakClass;
    track.appendChild(peak);
    const updateBarH = () => {
      const h = track.clientHeight;
      if (h > 0) track.style.setProperty('--bar-h', `${h}px`);
    };
    updateBarH();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(updateBarH).observe(track);
    }
  }
  let pk   = parseFloat(track.dataset.peak)     || 0;
  let hold = parseInt(track.dataset.peakHold, 10) || 0;
  if (pct >= pk) { pk = pct; hold = METRIC_PEAK_HOLD_FRAMES; }
  else if (hold > 0) hold--;
  else pk = Math.max(pct, pk - METRIC_PEAK_DECAY);
  track.dataset.peak = pk.toFixed(2);
  track.dataset.peakHold = hold;
  peak.style.bottom = `${pk.toFixed(0)}%`;
}

// Mirror grid for the zen overlay (no labels, smaller).
const zenCoreGridEl  = document.querySelector('#zen-core-grid');
const zenCpuValueEl  = document.querySelector('#zen-cpu-value');
const zenCoreFillEls = [];

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
  // Build matching grid in the zen overlay (same number of bars, no labels).
  if (zenCoreGridEl) {
    zenCoreGridEl.innerHTML = '';
    zenCoreFillEls.length = 0;
    for (let i = 0; i < count; i++) {
      const bar = document.createElement('div');
      bar.className = 'core-bar';
      const track = document.createElement('div');
      track.className = 'core-bar-track';
      const fill = document.createElement('div');
      fill.className = 'core-bar-fill';
      track.appendChild(fill);
      bar.appendChild(track);
      zenCoreGridEl.appendChild(bar);
      zenCoreFillEls.push(fill);
    }
  }
}

function paintCore(fill, load) {
  setMetricBar(fill, load * 100);
}

// Memory history — time-series of system memory % usage.
const MEM_HIST_LEN = 30;                              // 30 samples × 2s = 60s window
const memHistBuf = new Array(MEM_HIST_LEN).fill(0);
const memHistFills = [];
const zenMemGridEl  = document.querySelector('#zen-mem-grid');
const zenMemValueEl = document.querySelector('#zen-mem-value');
const zenMemFills   = [];

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
  if (zenMemGridEl && zenMemFills.length !== MEM_HIST_LEN) {
    zenMemGridEl.innerHTML = '';
    zenMemFills.length = 0;
    for (let i = 0; i < MEM_HIST_LEN; i++) {
      const bar = document.createElement('div');
      bar.className = 'core-bar';
      const track = document.createElement('div');
      track.className = 'core-bar-track';
      const fill = document.createElement('div');
      fill.className = 'core-bar-fill';
      track.appendChild(fill);
      bar.appendChild(track);
      zenMemGridEl.appendChild(bar);
      zenMemFills.push(fill);
    }
  }
}

function pushMemHistory(pct) {
  ensureMemHistGrid();
  memHistBuf.push(pct);
  if (memHistBuf.length > MEM_HIST_LEN) memHistBuf.shift();
  for (let i = 0; i < MEM_HIST_LEN; i++) {
    setMetricBar(memHistFills[i], memHistBuf[i]);
    if (zenMemFills[i]) setMetricBar(zenMemFills[i], memHistBuf[i]);
  }
  const cur = memHistBuf[memHistBuf.length - 1] || 0;
  if (zenMemValueEl) zenMemValueEl.textContent = `${cur.toFixed(0)}%`;
  if (memHistValueEl) {
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
    setMetricBar(fill, pct);
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
        if (coreFillEls[i])    paintCore(coreFillEls[i], load);
        if (zenCoreFillEls[i]) paintCore(zenCoreFillEls[i], load);
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
    if (zenCpuValueEl) zenCpuValueEl.textContent = `${cpuPct.toFixed(0)}%`;
    setAlertReason(ALERT_REASON.CPU_90, cpuPct >= 90);
    setAlertReason(ALERT_REASON.ERROR_SYS, false);

    const memFrac = info.usedMem / info.totalMem;
    const memPct  = memFrac * 100;
    sysMemBarEl.style.width = `${memPct.toFixed(0)}%`;
    sysMemBarEl.classList.toggle('high', memPct >= 85);
    sysMemValEl.textContent = `${fmtBytes(info.usedMem)} / ${fmtBytes(info.totalMem)}`;

    pushMemHistory(memPct);
  } catch (err) {
    sysCoresValueEl.textContent = `ERR: ${err.message}`;
    setAlertReason(ALERT_REASON.ERROR_SYS, true);
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
const powerCpuEl      = document.querySelector('#power-cpu');
const powerGpu0El     = document.querySelector('#power-gpu0');
const powerGpu1El     = document.querySelector('#power-gpu1');
const zenCpuTempEl    = document.querySelector('#zen-cpu-temp');

function paintPower(el, watts) {
  if (!el) return;
  el.textContent = Number.isFinite(watts) && watts > 0 ? watts.toFixed(0) : '—';
}
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
  setMetricBar(fill, pct);
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

// Zen overlay GPU mirror — one vertical bar per GPU, parallel to CPU cores.
const zenGpuGridEl = document.querySelector('#zen-gpu-grid');
const zenGpuTempsEl = document.querySelector('#zen-gpu-temps');
const zenGpuFillEls = [];

function buildZenGpuGrid(count) {
  if (!zenGpuGridEl) return;
  if (zenGpuFillEls.length === count) return;
  zenGpuGridEl.innerHTML = '';
  zenGpuFillEls.length = 0;
  for (let i = 0; i < count; i++) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    bar.appendChild(track);
    zenGpuGridEl.appendChild(bar);
    zenGpuFillEls.push(fill);
  }
}

function paintGpuPanel(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  if (gpuFillEls.length !== list.length) buildGpuGrid(list);
  if (gpuMemRowEls.length !== list.length) buildGpuMemList(list);
  buildZenGpuGrid(list.length);

  let totalUsed = 0, totalCap = 0;
  const tempBits = [];
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    paintGpuUtil(gpuFillEls[i], gpuPctEls[i], g?.load);
    paintGpuMem(gpuMemRowEls[i], g?.memUsed, g?.memTotal);
    if (zenGpuFillEls[i]) {
      const util = Math.max(0, Math.min(100, Number.isFinite(g?.load) ? g.load : 0));
      setMetricBar(zenGpuFillEls[i], util);
    }
    if (Number.isFinite(g?.temp)) tempBits.push(`G${i} ${Math.round(g.temp)}°`);
    if (Number.isFinite(g?.memUsed))  totalUsed += g.memUsed;
    if (Number.isFinite(g?.memTotal)) totalCap  += g.memTotal;
  }
  if (zenGpuTempsEl) {
    zenGpuTempsEl.textContent = tempBits.length ? tempBits.join(' · ') : '—';
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
    paintPower(powerCpuEl, t.cpuPower);
    if (zenCpuTempEl) zenCpuTempEl.textContent = Number.isFinite(t.cpu) ? `${Math.round(t.cpu)}` : '—';
    tempCpuNameEl.textContent = (t.cpu == null) ? 'NEEDS LHM/OHM' : 'ACPI/SMBUS';
    if (tempCpuNameEl) {
      tempCpuNameEl.title = (t.cpu == null)
        ? 'CPU package temperature is not exposed by Windows. Install LibreHardwareMonitor or OpenHardwareMonitor and run it (admin) — this app reads its WMI namespace automatically.'
        : '';
    }

    const g0 = t.gpus?.[0];
    paintTemp(tempGpu0El, tempGpu0BarEl, g0?.temp);
    paintPower(powerGpu0El, g0?.power);
    tempGpu0NameEl.textContent = g0 ? shortGpuName(g0.name) : 'NONE';

    const g1 = t.gpus?.[1];
    paintTemp(tempGpu1El, tempGpu1BarEl, g1?.temp);
    paintPower(powerGpu1El, g1?.power);
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
    // Trigger alert if any GPU's load is at/above 90%.
    const gpuPeak = (t.gpus || []).reduce((m, g) =>
      Math.max(m, Number.isFinite(g?.load) ? g.load : 0), 0);
    setAlertReason(ALERT_REASON.GPU_90, gpuPeak >= 90);
    setAlertReason(ALERT_REASON.ERROR_TEMPS, false);
  } catch (err) {
    thermalStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    thermalStatusEl.className = 'footer-readout red';
    setAlertReason(ALERT_REASON.ERROR_TEMPS, true);
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
const zenNetRxSparkEl = document.querySelector('#zen-net-rx-spark');
const zenNetTxSparkEl = document.querySelector('#zen-net-tx-spark');
const zenNetRxRateEl  = document.querySelector('#zen-net-rx-rate');
const zenNetTxRateEl  = document.querySelector('#zen-net-tx-rate');

const SPARK_SAMPLES = 96;
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

// Bar-grid sparkline renderer: builds N skinny bars on first call, then on
// each call re-heights them from the samples buffer and updates a floating
// peak marker per bar (snap up, hold, then slow decay).
const _sparkState = new WeakMap(); // container → { peaks: Float32Array, hold: Int32Array, fills: HTMLElement[], peakEls: HTMLElement[], ro: ResizeObserver }
// Tuned for 1 Hz spark updates (network) / 0.5 Hz (disk). HOLD=2 frames = 1–2 s
// hover; DECAY=20 means the peak loses 20 percentage points per update, so
// it visibly falls toward the current bar over a few seconds. CSS transition
// on .spark-bar-peak smooths the fall between the discrete updates.
const SPARK_PEAK_HOLD_FRAMES = 2;
const SPARK_PEAK_DECAY = 20;

// Bar count derived from container width: ~4 px per bar (3 px bar + 1 px gap)
// keeps a dense, readable spectrum that grows with the panel. Clamped so a
// hidden / collapsed container doesn't render zero bars.
const SPARK_BAR_PX = 4;
function targetSparkBarCount(container, sampleCap) {
  const w = container.clientWidth || (sampleCap * SPARK_BAR_PX);
  return Math.max(8, Math.min(sampleCap, Math.floor(w / SPARK_BAR_PX)));
}
// Take the most recent N values from the rolling buffer — the spark visually
// scrolls right→left, so showing the tail is correct regardless of buffer size.
function tailSamples(buf, n) {
  return buf.length > n ? buf.slice(-n) : buf;
}

// Sparkline renderer is canvas-backed for the same reason audio bars are:
// per-bar DOM (one fill div + one peak div per bar, ×~96 bars × 5 panels)
// trashes flex layout on every refresh. A single <canvas> per spark draws
// the same picture in one GPU-composited pass.
function _sparkSizeCanvas(st, container) {
  if (!st.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(0, container.clientWidth);
  const h = Math.max(0, container.clientHeight);
  st.canvas.width  = Math.round(w * dpr);
  st.canvas.height = Math.round(h * dpr);
  st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  st.grad = null; // height changed → rebuild gradient on next draw
}
function renderSpark(container, samples) {
  if (!container) return;
  const targetN = targetSparkBarCount(container, samples.length);
  const view = tailSamples(samples, targetN);
  let st = _sparkState.get(container);
  if (!st) {
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.className = 'spark-bars-canvas';
    container.appendChild(canvas);
    st = {
      canvas,
      ctx: canvas.getContext('2d'),
      peaks: new Float32Array(view.length),
      hold:  new Int32Array(view.length),
      grad:  null,
      ro:    null,
    };
    _sparkState.set(container, st);
    _sparkSizeCanvas(st, container);
    if (typeof ResizeObserver !== 'undefined') {
      st.ro = new ResizeObserver(() => _sparkSizeCanvas(st, container));
      st.ro.observe(container);
    }
  }
  // Resize state arrays without losing peak history when bar count changes.
  if (st.peaks.length !== view.length) {
    const newPeaks = new Float32Array(view.length);
    const newHold  = new Int32Array(view.length);
    const copy = Math.min(st.peaks.length, view.length);
    for (let i = 0; i < copy; i++) { newPeaks[i] = st.peaks[i]; newHold[i] = st.hold[i]; }
    st.peaks = newPeaks;
    st.hold  = newHold;
  }
  const max = Math.max(1, ...view);
  // Update peak state.
  for (let i = 0; i < view.length; i++) {
    const pct = Math.min(100, (view[i] / max) * 100);
    if (pct >= st.peaks[i]) {
      st.peaks[i] = pct;
      st.hold[i] = SPARK_PEAK_HOLD_FRAMES;
    } else if (st.hold[i] > 0) {
      st.hold[i]--;
    } else {
      st.peaks[i] = Math.max(pct, st.peaks[i] - SPARK_PEAK_DECAY);
    }
  }
  // Draw.
  const ctx = st.ctx;
  const dpr = window.devicePixelRatio || 1;
  const W = st.canvas.width  / dpr;
  const H = st.canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  if (W <= 0 || H <= 0 || view.length === 0) return;
  if (!st.grad || st.gradTheme !== _themeVersion) {
    const cs = getComputedStyle(container);
    const sparkColor = cs.getPropertyValue('--spark-color').trim() || cs.getPropertyValue('--accent').trim() || '#5fa';
    const amber      = cs.getPropertyValue('--amber').trim() || '#f3a83b';
    const red        = cs.getPropertyValue('--red').trim()   || '#ff3b30';
    const g = ctx.createLinearGradient(0, H, 0, 0);
    g.addColorStop(0.00, sparkColor);
    g.addColorStop(0.50, sparkColor);
    g.addColorStop(0.62, amber);
    g.addColorStop(0.78, amber);
    g.addColorStop(0.90, red);
    g.addColorStop(1.00, red);
    st.grad = g;
    st.peakColor = sparkColor;
    st.gradTheme = _themeVersion;
  }
  const gap = 1;
  const barW = Math.max(1, (W - gap * (view.length - 1)) / view.length);
  ctx.fillStyle = st.grad;
  for (let i = 0; i < view.length; i++) {
    const pct = Math.min(100, (view[i] / max) * 100);
    const fillH = (pct / 100) * H;
    if (fillH <= 0) continue;
    ctx.fillRect(i * (barW + gap), H - fillH, barW, fillH);
  }
  ctx.fillStyle = st.peakColor || '#fff';
  ctx.globalAlpha = 0.9;
  for (let i = 0; i < view.length; i++) {
    const peakY = H - (st.peaks[i] / 100) * H;
    ctx.fillRect(i * (barW + gap), peakY - 1, barW, 2);
  }
  ctx.globalAlpha = 1;
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

    // Mirror to zen overlay sparks (visible only while idle).
    if (zenNetRxSparkEl) renderSpark(zenNetRxSparkEl, rxBuf);
    if (zenNetTxSparkEl) renderSpark(zenNetTxSparkEl, txBuf);
    if (zenNetRxRateEl) zenNetRxRateEl.textContent = `${r.num} ${r.unit}`;
    if (zenNetTxRateEl) zenNetTxRateEl.textContent = `${t.num} ${t.unit}`;

    const total = (n.rxSec || 0) + (n.txSec || 0);
    if (total <= 0) {
      netStatusEl.innerHTML = '<em>STATE</em> <strong class="amber">IDLE</strong>';
    } else {
      netStatusEl.innerHTML = `<em>STATE</em> <strong class="ok">ACTIVE</strong> <em>RATE</em> <strong>${fmtRate(total).num} ${fmtRate(total).unit}</strong>`;
    }
    netStatusEl.className = 'footer-readout';
    setAlertReason(ALERT_REASON.ERROR_NET, false);
  } catch (err) {
    netStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    netStatusEl.className = 'footer-readout red';
    setAlertReason(ALERT_REASON.ERROR_NET, true);
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
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    forecast_days: '5',
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

const zenTempEl    = document.querySelector('#zen-temp');
const zenTempLowEl = document.querySelector('#zen-temp-low');
const zenCondEl    = document.querySelector('#zen-cond');
const zenLocEl     = document.querySelector('#zen-loc');

// Cached 5-day forecast + cycling state for zen mode.
let _forecastDaily = []; // [{ date, max, min, code }, ...]
let _forecastLocLabel = '';
let _zenForecastIdx = 0;
let _zenForecastTimer = null;
const ZEN_FORECAST_CYCLE_MS = 5000;

function paintZenForecast(idx) {
  if (!_forecastDaily.length || !zenCondEl) return;
  const d = _forecastDaily[idx % _forecastDaily.length];
  if (!d) return;
  const [text, icon] = describeWeather(d.code);
  const dayLabel = idx === 0
    ? 'TODAY'
    : (d.date instanceof Date && !isNaN(d.date)
        ? d.date.toLocaleDateString([], { weekday: 'short' }).toUpperCase()
        : '—');
  zenCondEl.textContent = `${dayLabel} · ${icon} ${text.toUpperCase()}`;
  if (zenTempEl)    zenTempEl.textContent    = Number.isFinite(d.max) ? `${Math.round(d.max)}` : '—';
  if (zenTempLowEl) zenTempLowEl.textContent = Number.isFinite(d.min) ? `${Math.round(d.min)}` : '—';
  if (zenLocEl)     zenLocEl.textContent     = _forecastLocLabel;
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

    // Cache the 5-day forecast for the zen overlay's cycling display.
    _forecastDaily = [];
    if (data.daily?.time?.length) {
      _forecastDaily = data.daily.time.map((t, i) => ({
        date: new Date(`${t}T12:00:00`),
        max:  data.daily.temperature_2m_max?.[i],
        min:  data.daily.temperature_2m_min?.[i],
        code: data.daily.weather_code?.[i],
      }));
    }
    _forecastLocLabel = `${loc.name}${region ? ' · ' + region : ''}`.toUpperCase();
    paintZenForecast(_zenForecastIdx);
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

// ── Audio bar-grids (mic input + system output loopback) ────────────────────
// Two distinct counts:
//   AUDIO_BAND_COUNT  — number of FFT bands the worker (loopback) and the
//                       mic sampler emit. Fixed at 24 because that's what
//                       the worker hardcodes.
//   AUDIO_BAR_COUNT_* — number of visible bars per visualizer. Bars upsample
//                       from bands via linear interpolation when count > 24.
const AUDIO_BAND_COUNT = 24;
const AUDIO_BAR_COUNT_NORMAL = 24;
// 96 was visually nice but each FFT update touched 96 × 2 (fill + peak)
// DOM properties at ~47 Hz — a real cost for the renderer to absorb on
// top of video decode in zen. 64 still reads as a dense spectrum and
// halves the per-frame DOM-update load.
const AUDIO_BAR_COUNT_ZEN    = 64;
// Multiplier applied to incoming band/level values. 1.0 in normal mode;
// lower in zen so the dense bar spectrum reads as a calm visualization
// rather than a wall of solid color.
const AUDIO_ZEN_GAIN_SCALE = 0.65;
let _audioGainScale = 1.0;
const AUDIO_MIN_W = 100;
const AUDIO_MIN_H = 40;
// Mic byte-frequency to percent multiplier. Byte data is already dB-mapped
// (0 ≈ -100dB, 255 ≈ -30dB on a default AnalyserNode), so this is a linear
// gain on top of that log scale. ~0.55 saturates roughly at typical speech.
const AUDIO_MIC_GAIN = 0.55;
// Mic noise gate (in byte units) — bins below this get squashed so ambient
// hiss doesn't keep all the bars lit.
const AUDIO_MIC_FLOOR = 24;
// FFT band layout matches the audify worker (60 Hz – 16 kHz, log-spaced).
const AUDIO_BAND_FMIN = 60;
const AUDIO_BAND_FMAX = 16000;
// Per-bar fill decay. Snap up on rises; fall by this many percent per push
// on drops so the bar gracefully tails off instead of flickering.
const AUDIO_DECAY_PER_FRAME = 4;
// Peak-hold: independent floating marker that snaps to the highest recent
// fill, holds for HOLD frames, then falls slowly. Push rate is ~47 Hz from
// the FFT side of the worker, so HOLD=12 ≈ 250 ms hold; PEAK_DECAY=1.4 ≈
// 1.5 s to fall from 100 → 0.
const AUDIO_PEAK_HOLD_FRAMES = 12;
const AUDIO_PEAK_DECAY_PER_FRAME = 1.4;

function shortDeviceName(label, fallback) {
  if (!label) return fallback || 'DEFAULT';
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase().slice(0, 38);
}

// Factory: builds + manages a single audio visualizer (bars + drag/resize +
// mute + persistence). Returns { sample(), setMuted(b), setLabel(s) }.
function createAudioVisualizer({
  gridEl, barsRowEl, muteBtnEl, deviceNameEl, posKey, sizeKey, mutedKey, gainKey, fallbackLabel, kind,
}) {
  // User-adjustable bar-height multiplier. Independent of _audioGainScale
  // (the zen-mode global throttle) so each visualizer can be tuned without
  // affecting the other. Persisted under gainKey so it survives reloads.
  let userGain = 1.0;
  function clampGain(g) { return Math.max(0.2, Math.min(3.0, g)); }
  function setUserGain(g) {
    userGain = clampGain(g);
    if (gainKey && window.dash?.setConfig) window.dash.setConfig({ [gainKey]: userGain });
  }
  let levels    = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0);
  let displayed = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0); // visible bar height
  let peaks     = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0); // floating peak marker
  let peakHold  = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0); // frames before peak starts falling
  let barCount  = AUDIO_BAR_COUNT_NORMAL;
  let analyser = null;
  let track = null;
  let muted = false;

  // Canvas-backed renderer. The previous implementation rebuilt N×2 DOM
  // elements (fill + peak per bar) and updated `style.height`/`bottom` on
  // every frame — at 96 bars × 2 visualizers × 60 Hz that's ~23 k DOM style
  // writes / sec, each forcing flex-row reflow. A single <canvas> is GPU-
  // composited as one texture; per-frame work drops to ~0.1 ms in 2D.
  let canvas = null;
  let ctx    = null;
  let _gradCache = null;
  let _gradH = 0;
  let _gradTheme = -1;
  let _peakColor = '#fff';
  function setupCanvas() {
    if (!barsRowEl) return;
    barsRowEl.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.className = 'audio-bars-canvas';
    barsRowEl.appendChild(canvas);
    ctx = canvas.getContext('2d');
    sizeCanvas();
  }
  function sizeCanvas() {
    if (!canvas || !barsRowEl) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(0, barsRowEl.clientWidth);
    const h = Math.max(0, barsRowEl.clientHeight);
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _gradCache = null; // height changed → rebuild gradient on next render
  }
  function getGradient(h) {
    // Cache hit: same height + same theme version → reuse gradient object
    // and the previously-resolved peak color. Avoids getComputedStyle on
    // every frame, which is the dominant cost when bars are full-height.
    if (_gradCache && _gradH === h && _gradTheme === _themeVersion) return _gradCache;
    const cs = getComputedStyle(barsRowEl);
    const audioColor = cs.getPropertyValue('--audio-color').trim() || '#5fa';
    const amber      = cs.getPropertyValue('--amber').trim()       || '#f3a83b';
    const red        = cs.getPropertyValue('--red').trim()         || '#ff3b30';
    const g = ctx.createLinearGradient(0, h, 0, 0); // bottom → top
    g.addColorStop(0.00, audioColor);
    g.addColorStop(0.55, audioColor);
    g.addColorStop(0.62, amber);
    g.addColorStop(0.78, amber);
    g.addColorStop(0.90, red);
    g.addColorStop(1.00, red);
    _gradCache = g;
    _gradH = h;
    _gradTheme = _themeVersion;
    _peakColor = audioColor;
    return g;
  }
  function render() {
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width  / dpr;
    const H = canvas.height / dpr;
    ctx.clearRect(0, 0, W, H);
    if (barCount <= 0 || W <= 0 || H <= 0) return;
    const gap = 1;
    const barW = Math.max(1, (W - gap * (barCount - 1)) / barCount);
    const grad = getGradient(H);
    // Smile curve: edge bars are taller than middle by up to ~1.35× via
    // `scale`. Heff is the unscaled-bar full-volume target — at 100% data
    // a middle bar reaches 0.70 H, an edge bar reaches 0.70 × 1.35 ≈ 0.95 H.
    // The remaining ~5% headroom keeps loud peaks + smile-curve overshoot
    // from pinning to the canvas top.
    const Heff = H * 0.70;
    // Bar fills.
    ctx.fillStyle = grad;
    for (let i = 0; i < barCount; i++) {
      const dist = barCount > 1 ? Math.abs(i / (barCount - 1) - 0.5) * 2 : 0;
      const scale = 1 + dist * 0.35;
      const fillH = Math.min(H, (displayed[i] / 100) * Heff * scale);
      if (fillH <= 0) continue;
      const x = i * (barW + gap);
      ctx.fillRect(x, H - fillH, barW, fillH);
    }
    // Peak markers — peak color was cached in getGradient above.
    ctx.fillStyle = _peakColor;
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < barCount; i++) {
      const dist = barCount > 1 ? Math.abs(i / (barCount - 1) - 0.5) * 2 : 0;
      const scale = 1 + dist * 0.35;
      const peakY = Math.max(0, H - Math.min(H, (peaks[i] / 100) * Heff * scale));
      const x = i * (barW + gap);
      ctx.fillRect(x, peakY - 1, barW, 2);
    }
    ctx.globalAlpha = 1;
  }

  function rebuildBars(n) {
    levels    = new Array(n).fill(0);
    displayed = new Array(n).fill(0);
    peaks     = new Array(n).fill(0);
    peakHold  = new Array(n).fill(0);
    barCount  = n;
    render();
  }

  setupCanvas();
  rebuildBars(AUDIO_BAR_COUNT_NORMAL);

  // Whether width-driven bar-count rebuilding is active. Zen mode flips
  // this off and back on around its own forced AUDIO_BAR_COUNT_ZEN call so
  // the resize observer doesn't immediately overwrite it.
  let _adaptiveBarsActive = true;
  function setAdaptiveBars(active) { _adaptiveBarsActive = !!active; }

  if (barsRowEl) {
    // Track the row's pixel height so the 3-zone color gradient on each fill
    // can be anchored to the full bar height instead of the fill's own height.
    // Without this the warm/hot zones would scale with the fill and you'd
    // never see them at low levels.
    //
    // Also recompute bar count from the row's width — ~5 px per bar keeps the
    // spectrum dense at any size. Zen mode forces a different count via
    // setAdaptiveBars(false).
    const AUDIO_BAR_PX = 5;
    const targetBarCount = () => {
      const w = barsRowEl.clientWidth;
      if (w <= 0) return null;
      return Math.max(8, Math.min(160, Math.floor(w / AUDIO_BAR_PX)));
    };
    const updateBars = () => {
      sizeCanvas();
      if (!_adaptiveBarsActive) { render(); return; }
      const n = targetBarCount();
      if (n != null && n !== barCount) rebuildBars(n);
      render();
    };
    updateBars();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(updateBars).observe(barsRowEl);
    }
  }

  // UI-only mute reflection. Used both by the click handler (after also
  // pushing an IPC set) and by the system-state poller (which has just
  // observed an external mute change — keyboard volume key, mixer, etc.)
  // and needs to update the button without echoing back via IPC.
  function applyMuteUi(m) {
    muted = !!m;
    if (track) track.enabled = !muted;
    gridEl?.classList.toggle('is-muted', muted);
    if (muteBtnEl) muteBtnEl.textContent = muted ? 'X' : 'M';
  }
  function setMuted(m) {
    applyMuteUi(m);
    // Mute the OS-level endpoint so the user's microphone really stops
    // capturing / their speakers really go silent — not just our analyser.
    if (kind === 'input'  && window.dash?.setInputMute)  window.dash.setInputMute(muted).catch(() => {});
    if (kind === 'output' && window.dash?.setOutputMute) window.dash.setOutputMute(muted).catch(() => {});
  }
  function isMuted() { return muted; }

  // Per-band bin ranges, computed when the analyser is attached so we can
  // average byte-frequency data into the same 24 log-spaced bands the worker
  // produces for the loopback path.
  let bandLoBin = null, bandHiBin = null, freqBuf = null;

  function setAnalyserAndTrack(an, tr) {
    analyser = an;
    track = tr;
    if (deviceNameEl) deviceNameEl.textContent = shortDeviceName(track?.label, fallbackLabel);
    if (muted && track) track.enabled = false;
    if (an) {
      const sr = an.context?.sampleRate || 48000;
      const N  = an.fftSize;
      const fMax = Math.min(AUDIO_BAND_FMAX, sr / 2);
      bandLoBin = new Int32Array(AUDIO_BAND_COUNT);
      bandHiBin = new Int32Array(AUDIO_BAND_COUNT);
      for (let b = 0; b < AUDIO_BAND_COUNT; b++) {
        const fLo = AUDIO_BAND_FMIN * Math.pow(fMax / AUDIO_BAND_FMIN, b       / AUDIO_BAND_COUNT);
        const fHi = AUDIO_BAND_FMIN * Math.pow(fMax / AUDIO_BAND_FMIN, (b + 1) / AUDIO_BAND_COUNT);
        bandLoBin[b] = Math.max(1, Math.floor((fLo * N) / sr));
        bandHiBin[b] = Math.max(bandLoBin[b] + 1, Math.floor((fHi * N) / sr));
      }
      freqBuf = new Uint8Array(an.frequencyBinCount);
    }
  }

  function setLabelOnly(text) {
    if (deviceNameEl) deviceNameEl.textContent = text;
  }
  function getLabel() {
    return deviceNameEl?.textContent || '';
  }

  function sample() {
    if (!analyser || !barCount || !bandLoBin || !freqBuf) return;
    analyser.getByteFrequencyData(freqBuf);
    const out = new Array(AUDIO_BAND_COUNT);
    for (let b = 0; b < AUDIO_BAND_COUNT; b++) {
      const lo = bandLoBin[b], hi = bandHiBin[b];
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += freqBuf[k];
      const avg = sum / (hi - lo);
      const lifted = Math.max(0, avg - AUDIO_MIC_FLOOR);
      out[b] = Math.min(100, lifted * AUDIO_MIC_GAIN);
    }
    setBands(out);
  }

  // Time-scrolling RMS push — used by the mic visualizer (each bar = a moving
  // time slot). Snap-up on rises, decay on drops, with floating peak markers.
  function pushLevel(pct) {
    if (!barCount) return;
    levels.push(pct);
    levels.shift();
    const g = _audioGainScale * userGain;
    for (let i = 0; i < barCount; i++) {
      updateBar(i, levels[i] * g);
    }
    render();
  }

  // Frequency-band push — used by the loopback visualizer (each bar = a
  // log-spaced FFT band). When the visible bar count exceeds the input band
  // count (e.g. zen mode with 96 bars vs 24 bands), linearly interpolate so
  // the bars look like a smooth-ish spectrum instead of repeating in groups.
  function setBands(bands) {
    if (!barCount || !bands) return;
    const n = barCount;
    const m = bands.length;
    const g = _audioGainScale * userGain;
    for (let i = 0; i < n; i++) {
      let target;
      if (n === m) {
        target = Number.isFinite(bands[i]) ? bands[i] : 0;
      } else {
        const f  = (i / Math.max(1, n - 1)) * (m - 1);
        const lo = Math.floor(f);
        const hi = Math.min(m - 1, lo + 1);
        const t  = f - lo;
        const a  = Number.isFinite(bands[lo]) ? bands[lo] : 0;
        const b  = Number.isFinite(bands[hi]) ? bands[hi] : 0;
        target = a * (1 - t) + b * t;
      }
      updateBar(i, target * g);
    }
    render();
  }

  function updateBar(i, target) {
    // Fill: snap up on a rise, decay on a drop.
    if (target >= displayed[i]) {
      displayed[i] = target;
    } else {
      displayed[i] = Math.max(target, displayed[i] - AUDIO_DECAY_PER_FRAME);
    }
    // Peak: track highest fill; hold briefly; then fall slower than the fill.
    if (displayed[i] >= peaks[i]) {
      peaks[i] = displayed[i];
      peakHold[i] = AUDIO_PEAK_HOLD_FRAMES;
    } else if (peakHold[i] > 0) {
      peakHold[i]--;
    } else {
      peaks[i] = Math.max(displayed[i], peaks[i] - AUDIO_PEAK_DECAY_PER_FRAME);
    }
    // Canvas renderer reads displayed[i]/peaks[i] in render() — no DOM write
    // needed per bar. Caller invokes render() once after the loop.
  }

  // Drag-to-move
  gridEl?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.classList?.contains('audio-resize-handle')) return;
    e.preventDefault();
    const rect = gridEl.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = rect.left, startTop = rect.top;
    gridEl.classList.add('is-dragging');
    gridEl.style.left = `${startLeft}px`;
    gridEl.style.top  = `${startTop}px`;
    gridEl.style.right  = 'auto';
    gridEl.style.bottom = 'auto';
    const onMove = (ev) => {
      // Absolute-position snap: target final position rounds to the
      // nearest grid line so panels actually land ON the grid (not just
      // move in grid-sized increments from a non-grid start).
      let nx = startLeft + (ev.clientX - startX);
      let ny = startTop  + (ev.clientY - startY);
      if (!ev.altKey) {
        const g = getGridSize();
        nx = snap(nx, g.w);
        ny = snap(ny, g.h);
        // Resolve overlap with panels + the other audio visualizer.
        const resolved = resolveDragOverlap(nx, ny, rect.width, rect.height, getNeighborRects(gridEl));
        nx = resolved.left;
        ny = resolved.top;
      }
      gridEl.style.left = `${nx}px`;
      gridEl.style.top  = `${ny}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      gridEl.classList.remove('is-dragging');
      saveGeom();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 4-edge resize: each edge resizes one dimension. N/S = vertical,
  // E/W = horizontal. No diagonal corner handles — keeps the click
  // targets along the visible borders.
  for (const edge of ['n', 's', 'e', 'w']) {
    const h = document.createElement('div');
    h.className = `audio-resize-handle audio-resize-${edge}`;
    gridEl?.appendChild(h);
    const grows = {
      n: edge === 'n', s: edge === 's',
      w: edge === 'w', e: edge === 'e',
    };
    h.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = gridEl.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startW = rect.width, startH = rect.height;
      const startLeft = rect.left, startTop = rect.top;
      gridEl.classList.add('is-resizing');
      gridEl.style.left = `${startLeft}px`;
      gridEl.style.top  = `${startTop}px`;
      gridEl.style.right  = 'auto';
      gridEl.style.bottom = 'auto';
      const onMove = (ev) => {
        // Cursor-delta snap on resize so the panel size changes in clean
        // grid increments without snap-back on first click.
        let dx = ev.clientX - startX;
        let dy = ev.clientY - startY;
        if (!ev.altKey) {
          const g = getGridSize();
          dx = snap(dx, g.w);
          dy = snap(dy, g.h);
        }
        let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;
        if (grows.e) newW = startW + dx;
        if (grows.w) { newW = startW - dx; newLeft = startLeft + dx; }
        if (grows.s) newH = startH + dy;
        if (grows.n) { newH = startH - dy; newTop = startTop + dy; }
        if (newW < AUDIO_MIN_W) {
          if (grows.w) newLeft = startLeft + (startW - AUDIO_MIN_W);
          newW = AUDIO_MIN_W;
        }
        if (newH < AUDIO_MIN_H) {
          if (grows.n) newTop = startTop + (startH - AUDIO_MIN_H);
          newH = AUDIO_MIN_H;
        }
        // Clamp moved edges against neighbors to prevent overlap. Alt
        // bypasses for free placement.
        if (!ev.altKey) {
          const r = resolveResizeOverlap(newLeft, newTop, newW, newH, grows, getNeighborRects(gridEl));
          if (r.width >= AUDIO_MIN_W && r.height >= AUDIO_MIN_H) {
            newLeft = r.left; newTop = r.top; newW = r.width; newH = r.height;
          }
        }
        gridEl.style.width  = `${Math.round(newW)}px`;
        gridEl.style.height = `${Math.round(newH)}px`;
        gridEl.style.left   = `${Math.round(newLeft)}px`;
        gridEl.style.top    = `${Math.round(newTop)}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        gridEl.classList.remove('is-resizing');
        saveGeom();
        // Mirror the new size to the paired visualizer so the in/out grids
        // always read at identical dimensions. Position stays independent.
        const w = parseInt(gridEl.style.width,  10);
        const h = parseInt(gridEl.style.height, 10);
        if (_partner && Number.isFinite(w) && Number.isFinite(h)) _partner.setSize(w, h);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Mute click
  muteBtnEl?.addEventListener('mousedown', (e) => e.stopPropagation());
  muteBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    setMuted(!muted);
    if (window.dash?.setConfig) await window.dash.setConfig({ [mutedKey]: muted });
  });

  // Inject ▲/▼ gain triangles into the meta row. Each click bumps userGain
  // by ~15% (clamped 0.2×–3×) so the user can dial bar height per
  // visualizer. mousedown is stopped so the row's picker click doesn't
  // also fire and the panel doesn't start dragging from the button.
  const metaRow = deviceNameEl?.parentElement;
  if (metaRow) {
    const ctrls = document.createElement('div');
    ctrls.className = 'audio-gain-controls';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'audio-gain-btn audio-gain-up';
    up.title = 'Increase bar height';
    up.textContent = '▲';
    const dn = document.createElement('button');
    dn.type = 'button';
    dn.className = 'audio-gain-btn audio-gain-down';
    dn.title = 'Decrease bar height';
    dn.textContent = '▼';
    ctrls.appendChild(up);
    ctrls.appendChild(dn);
    metaRow.appendChild(ctrls);
    const stop = (e) => e.stopPropagation();
    up.addEventListener('mousedown', stop);
    dn.addEventListener('mousedown', stop);
    up.addEventListener('click', (e) => { stop(e); setUserGain(userGain * 1.15); });
    dn.addEventListener('click', (e) => { stop(e); setUserGain(userGain / 1.15); });
  }

  async function saveGeom() {
    if (!window.dash?.setConfig || !gridEl) return;
    const x = parseInt(gridEl.style.left, 10);
    const y = parseInt(gridEl.style.top,  10);
    const w = parseInt(gridEl.style.width,  10);
    const h = parseInt(gridEl.style.height, 10);
    const partial = {};
    if (Number.isFinite(x) && Number.isFinite(y)) partial[posKey]  = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial[sizeKey] = { width: w, height: h };
    if (Object.keys(partial).length) await window.dash.setConfig(partial);
  }

  // Set up partner-mirroring so resizing one visualizer also resizes the
  // other. Drag/position stays independent.
  let _partner = null;
  function setPartner(p) { _partner = p; }
  function setSize(w, h) {
    if (!gridEl || !Number.isFinite(w) || !Number.isFinite(h)) return;
    gridEl.style.width  = `${w}px`;
    gridEl.style.height = `${h}px`;
    saveGeom();
  }

  function applySavedGeom(savedPos, savedSize, savedMuted) {
    if (!gridEl) return;
    if (savedPos) {
      gridEl.style.left = `${savedPos.x}px`;
      gridEl.style.top  = `${savedPos.y}px`;
      gridEl.style.right  = 'auto';
      gridEl.style.bottom = 'auto';
    }
    if (savedSize) {
      gridEl.style.width  = `${savedSize.width}px`;
      gridEl.style.height = `${savedSize.height}px`;
    }
    if (savedMuted) setMuted(true);
  }

  // Apply a previously-persisted gain without writing back to config.
  function applySavedGain(g) { if (Number.isFinite(g)) userGain = clampGain(g); }
  return { sample, pushLevel, setBands, setMuted, applyMuteUi, isMuted, setAnalyserAndTrack, setLabelOnly, getLabel, applySavedGeom, applySavedGain, rebuildBars, setAdaptiveBars, setPartner, setSize };
}

const audioInViz = createAudioVisualizer({
  gridEl:        document.querySelector('#audio-in-grid'),
  barsRowEl:     document.querySelector('#audio-in-bars-row'),
  muteBtnEl:     document.querySelector('#audio-in-mute-btn'),
  deviceNameEl:  document.querySelector('#audio-in-device-name'),
  posKey:        'audioInPos',
  // Shared size key — both visualizers read/write the same persisted size
  // so they always match across reloads, no race or post-hoc sync needed.
  sizeKey:       'audioVizSize',
  mutedKey:      'audioInMuted',
  gainKey:       'audioInGain',
  fallbackLabel: 'DEFAULT MIC',
  kind:          'input',
});

const audioOutViz = createAudioVisualizer({
  gridEl:        document.querySelector('#audio-out-grid'),
  barsRowEl:     document.querySelector('#audio-out-bars-row'),
  muteBtnEl:     document.querySelector('#audio-out-mute-btn'),
  deviceNameEl:  document.querySelector('#audio-out-device-name'),
  posKey:        'audioOutPos',
  sizeKey:       'audioVizSize', // shared with audioInViz — see above
  mutedKey:      'audioOutMuted',
  gainKey:       'audioOutGain',
  fallbackLabel: 'SYSTEM AUDIO',
  kind:          'output',
});

// Pair the two visualizers so resizing either mirrors the other and saves
// once to the shared 'audioVizSize' key. Also handles initial alignment if
// the saved config has only one of the legacy 'audioInSize' / 'audioOutSize'
// keys still around — applySavedGeom (called from main config-load below)
// reads only audioVizSize now, so legacy keys are harmlessly orphaned.
audioInViz.setPartner(audioOutViz);
audioOutViz.setPartner(audioInViz);

// Native WASAPI loopback path: main process pushes RMS levels to us via IPC.
// When this is wired up, we don't need any browser-side capture at all — the
// main-process audify binding talks directly to WASAPI.
const NATIVE_LOOPBACK_BOUND = !!(IS_ELECTRON && window.dash?.onAudioOutLevel);
let _nativeReceivedFirst = false;
let _audioDeviceList = [];
if (NATIVE_LOOPBACK_BOUND) {
  audioOutViz.setLabelOnly('NATIVE LOOPBACK · STARTING…');
  window.dash.onAudioOutLevel((data) => {
    if (data?.error) {
      audioOutViz.setLabelOnly(`NATIVE FAIL · ${data.error}`.toUpperCase().slice(0, 60));
      return;
    }
    if (Array.isArray(data?.devices)) {
      _audioDeviceList = data.devices;
      return;
    }
    if (data?.status === 'started' && data.deviceName) {
      audioOutViz.setLabelOnly(shortDeviceName(data.deviceName, 'SYSTEM AUDIO'));
      _nativeReceivedFirst = true;
      return;
    }
    if (!_nativeReceivedFirst && data?.deviceName) {
      audioOutViz.setLabelOnly(shortDeviceName(data.deviceName, 'SYSTEM AUDIO'));
      _nativeReceivedFirst = true;
    }
    if (Array.isArray(data?.bands)) {
      audioOutViz.setBands(data.bands);
    }
    // RMS-only off-frames are ignored — FFT frames arrive every ~21 ms
    // which is plenty for the visual decay/peak-hold logic.
  });

  // Click anywhere on the meta-row (except the mute button) to pick which
  // output to use. Useful when the OS default is a virtual cable (VB-Audio)
  // but real audio is going to a headset / speakers — this both switches
  // the OS default endpoint and re-points the loopback visualizer.
  const labelEl = document.querySelector('#audio-out-device-name');
  const rowEl   = labelEl?.closest('.audio-meta-row');
  if (rowEl && labelEl) {
    rowEl.classList.add('is-clickable');
    rowEl.title = 'Click to choose audio output device';
    rowEl.addEventListener('mousedown', (e) => {
      // Let the mute button keep its own mousedown for stopPropagation; the
      // row's mousedown otherwise stops drag/resize on the parent grid.
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
    });
    rowEl.addEventListener('click', (e) => {
      console.log('[picker] audio-out row click', { target: e.target.tagName, devices: _audioDeviceList.length });
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
      if (!_audioDeviceList.length) {
        console.warn('[picker] audio-out: _audioDeviceList empty — audify worker probably did not enumerate');
        return;
      }
      openAudioDevicePicker(labelEl, _audioDeviceList, async (d) => {
        audioOutViz.setLabelOnly(`SWITCHING · ${shortDeviceName(d.name, '')}`);
        _nativeReceivedFirst = false;
        // 1) Restart the loopback monitor so the visualizer reads from the
        //    chosen device. 2) Flip the OS default render endpoint so any
        //    audio actually plays through the chosen device.
        try { await window.dash.setAudioDevice(d.id); } catch (err) {
          audioOutViz.setLabelOnly(`SWITCH FAIL · ${err.message}`.toUpperCase().slice(0, 60));
        }
        if (window.dash?.setDefaultEndpoint) {
          try { await window.dash.setDefaultEndpoint(0, d.name); }
          catch (err) { console.warn('SetDefault output:', err.message); }
        }
      });
    });
  }
}

function openAudioDevicePicker(anchor, devices, onSelect) {
  document.querySelector('.audio-device-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'audio-device-menu';
  for (const d of devices) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'audio-device-menu-item';
    item.textContent = d.name + (d.isDefault ? '  ·  OS default' : '');
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      menu.remove();
      onSelect(d);
    });
    menu.appendChild(item);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
  document.body.appendChild(menu);
  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

// Attempt to wire up the system-output analyser using the three-stage capture
// chain. Returns true on success, false if all paths failed. Pulled out of
// startAudioWaves so we can re-invoke it from a click after a permission /
// user-activation failure.
async function tryStartOutputCapture() {
  // Main process is feeding us native WASAPI loopback over IPC — skip the
  // browser-side capture entirely (which has been failing in this
  // environment anyway).
  if (NATIVE_LOOPBACK_BOUND) return true;

  if (!IS_ELECTRON) {
    audioOutViz.setLabelOnly('BROWSER · NO HOST LOOPBACK');
    return false;
  }
  let stream, track, sourceLabel;
  const captureErrors = [];

  if (!track && window.dash?.getScreenSources) {
    try {
      const sources = await window.dash.getScreenSources();
      if (!sources || !sources.length) throw new Error('no screen sources');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sources[0].id,
            maxWidth: 1, maxHeight: 1, maxFrameRate: 1,
          },
        },
      });
      stream.getVideoTracks().forEach(t => t.stop());
      track = stream.getAudioTracks()[0];
      if (!track) throw new Error('stream had no audio track');
      sourceLabel = `DESKTOP · ${sources[0].name || 'SCREEN'}`;
    } catch (err) { captureErrors.push(`[1 desktop] ${err.message}`); }
  }

  if (!track) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const patterns = [
        /stereo\s*mix/i, /what\s*u\s*hear/i, /^\s*wave\s*out/i, /loopback/i,
        /cable\s*output/i, /voicemeeter.*(out|output|vaio|b\d)/i, /vb-audio/i,
      ];
      let dev = null;
      for (const p of patterns) {
        dev = inputs.find(d => p.test(d.label || ''));
        if (dev) break;
      }
      if (!dev) {
        throw new Error(`no loopback device (have: ${inputs.map(d => d.label).filter(Boolean).slice(0, 3).join(', ') || 'unlabeled'})`);
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dev.deviceId } },
        video: false,
      });
      track = stream.getAudioTracks()[0];
      if (!track) throw new Error('stream had no audio track');
      sourceLabel = dev.label;
    } catch (err) { captureErrors.push(`[2 loopback-dev] ${err.message}`); }
  }

  if (!track) {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 320, height: 180, frameRate: 1 },
      });
      stream.getVideoTracks().forEach(t => t.stop());
      track = stream.getAudioTracks()[0];
      if (!track) throw new Error('stream had no audio track');
      sourceLabel = track.label || 'SYSTEM AUDIO';
    } catch (err) { captureErrors.push(`[3 getDisplayMedia] ${err.message}`); }
  }

  if (track) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an  = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.3;
    src.connect(an);
    audioOutViz.setAnalyserAndTrack(an, track);
    if (sourceLabel) audioOutViz.setLabelOnly(shortDeviceName(sourceLabel, 'SYSTEM AUDIO'));
    return true;
  }
  console.error('All audio output capture paths failed:\n  ' + captureErrors.join('\n  '));
  const last = captureErrors[captureErrors.length - 1] || 'unknown';
  audioOutViz.setLabelOnly(last.toUpperCase().slice(0, 60));
  return false;
}

// One-shot retry triggered by a user click, which gives Chromium the user
// gesture some capture paths require even with permissions granted.
function armOutputCaptureRetryOnClick() {
  const retry = async () => {
    document.removeEventListener('click', retry, true);
    audioOutViz.setLabelOnly('RETRYING…');
    const ok = await tryStartOutputCapture();
    if (!ok) {
      // Re-arm on next click so the user can try again after fixing whatever
      // (eg. plugging in a device, enabling Stereo Mix, etc.).
      audioOutViz.setLabelOnly('CLICK TO RETRY · ' + (audioOutViz.getLabel?.() || 'NO OUTPUT'));
      document.addEventListener('click', retry, true);
    }
  };
  document.addEventListener('click', retry, true);
}

// Mic capture state — kept module-scope so the device picker can stop
// the existing stream and restart with a different deviceId.
let _micStream = null;
let _micCtx = null;
let _micDeviceList = [];

async function startMicCapture(deviceId) {
  if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  if (_micCtx)    { try { await _micCtx.close(); } catch {} _micCtx = null; }
  try {
    const constraints = deviceId
      ? { audio: { deviceId: { exact: deviceId } }, video: false }
      : { audio: true, video: false };
    _micStream = await navigator.mediaDevices.getUserMedia(constraints);
    _micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = _micCtx.createMediaStreamSource(_micStream);
    const an  = _micCtx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.3;
    src.connect(an);
    audioInViz.setAnalyserAndTrack(an, _micStream.getAudioTracks()[0]);
    if (window.dash?.setConfig) window.dash.setConfig({ audioInDeviceId: deviceId || null });
    return true;
  } catch (err) {
    audioInViz.setLabelOnly('NO MIC ACCESS');
    return false;
  }
}

async function populateMicDeviceList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    _micDeviceList = devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId)
      .map((d) => ({
        id: d.deviceId,
        name: d.label || `Microphone ${d.deviceId.slice(0, 6)}`,
        isDefault: d.deviceId === 'default' || d.deviceId === 'communications',
      }));
  } catch {}
}

async function startAudioWaves() {
  // Mic — restore the previously chosen input from config, else system default.
  let savedMicId = null;
  try { savedMicId = (await window.dash?.getConfig?.())?.audioInDeviceId || null; } catch {}
  const micOk = await startMicCapture(savedMicId);
  if (!micOk && savedMicId) {
    // Saved device may be unplugged — fall back to default.
    await startMicCapture(null);
  }
  populateMicDeviceList(); // populate cache for the picker
  // Wire the audio-in meta-row as a clickable picker (mirror of audio-out).
  // Whole row is clickable except the mute button so the hit target is
  // easy to find — mute keeps its own click handler.
  const micLabelEl = document.querySelector('#audio-in-device-name');
  const micRowEl   = micLabelEl?.closest('.audio-meta-row');
  if (micRowEl && micLabelEl) {
    micRowEl.classList.add('is-clickable');
    micRowEl.title = 'Click to choose microphone';
    micRowEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
    });
    micRowEl.addEventListener('click', async (e) => {
      console.log('[picker] audio-in row click', { target: e.target.tagName, devices: _micDeviceList.length });
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
      await populateMicDeviceList();
      console.log('[picker] audio-in after populate', { devices: _micDeviceList.length, names: _micDeviceList.map((d) => d.name) });
      if (!_micDeviceList.length) {
        console.warn('[picker] audio-in: no devices — enumerateDevices may need permission');
        return;
      }
      openAudioDevicePicker(micLabelEl, _micDeviceList, async (d) => {
        audioInViz.setLabelOnly(`SWITCHING · ${shortDeviceName(d.name, '')}`);
        await startMicCapture(d.id === 'default' ? null : d.id);
        // Also flip the OS default capture endpoint so other apps follow.
        if (window.dash?.setDefaultEndpoint) {
          try { await window.dash.setDefaultEndpoint(1, d.name); }
          catch (err) { console.warn('SetDefault input:', err.message); }
        }
      });
    });
  }
  // Keep the device list fresh as devices are plugged/unplugged.
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateMicDeviceList);
  }

  // System OUTPUT capture — three-stage chain in tryStartOutputCapture(). If
  // the auto attempt fails (often because Chromium wants a user gesture for
  // getDisplayMedia even with permissions granted), arm a one-shot click
  // retry so the user can tap to enable.
  const ok = await tryStartOutputCapture();
  if (!ok) armOutputCaptureRetryOnClick();

  drawAudioFrame();
}

// Sample the mic visualizer at ~15 Hz — half realtime since these meters
// don't need frame-perfect responsiveness and reducing the sample rate
// halves the per-frame canvas redraw cost. Output sample() is a no-op when
// bands are driven by IPC; the worker-side cadence is halved separately.
let _audioFrameCounter = 0;
function drawAudioFrame() {
  if ((_audioFrameCounter++ & 3) === 0) {
    audioInViz.sample();
    audioOutViz.sample();
  }
  requestAnimationFrame(drawAudioFrame);
}
startAudioWaves();

// Keep the dashboard mute buttons in sync with the OS endpoint state.
// Volume keyboard keys auto-unmute on Windows, and the user can also
// toggle from the volume mixer or other apps — without polling, our
// button would lie about the device's actual state.
if (window.dash?.getMuteStates) {
  setInterval(async () => {
    let st;
    try { st = await window.dash.getMuteStates(); } catch { return; }
    if (!st?.ok) return;
    if (typeof st.out === 'boolean' && audioOutViz.isMuted() !== st.out) audioOutViz.applyMuteUi(st.out);
    if (typeof st.in  === 'boolean' && audioInViz .isMuted() !== st.in ) audioInViz .applyMuteUi(st.in );
  }, 1500);
}

// ── Notes (tabbed scratchpad) ───────────────────────────────────────────────
const noteTabsEl      = document.querySelector('#note-tabs');
const noteTextareaEl  = document.querySelector('#note-textarea');
const notesStatusEl   = document.querySelector('#notes-status');
const notesTabCountEl = document.querySelector('#notes-tab-count');

// Time helpers used by the per-line stamp + the top-right "updated" chip.
function fmtNoteTime(ms = Date.now()) {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
function fmtNoteStamp(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da} ${fmtNoteTime(ms)}`;
}
function refreshNoteUpdatedDisplay() {
  const el = document.querySelector('#note-updated');
  if (!el) return;
  const tab = activeNoteTab();
  el.textContent = `UPDATED ${fmtNoteStamp(tab?.updatedAt)}`;
}

const TAB_NAME_MAX = 14;
let notesState = { active: null, tabs: [] };
let noteSaveTimer = null;
let activeTabNameSpan = null;

function newTabId() { return 'tab-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4); }

function activeNoteTab() {
  return notesState.tabs.find(t => t.id === notesState.active) || null;
}

// Derive a tab's display name. Manual override (`tab.name`) wins; otherwise
// take the first non-empty line of the note body. Falls back to NOTE N if
// the note is still blank.
function tabDisplayName(tab, idx) {
  if (tab.name && tab.name.trim()) return tab.name;
  const firstLine = (tab.body || '').split(/\r?\n/).find(l => l.trim());
  if (firstLine) return firstLine.trim().toUpperCase().slice(0, TAB_NAME_MAX);
  return `NOTE ${idx + 1}`;
}

function makeTabEl(tab) {
  const btn = document.createElement('button');
  btn.className = 'note-tab' + (tab.id === notesState.active ? ' is-active' : '');
  btn.dataset.id = tab.id;
  btn.title = 'Click to switch · Double-click to rename';
  btn.type = 'button';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'note-tab-name';
  nameSpan.textContent = tabDisplayName(tab, notesState.tabs.indexOf(tab));
  if (tab.id === notesState.active) activeTabNameSpan = nameSpan;

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
    // Manual override. Leave blank to revert to first-line auto-naming.
    const newName = window.prompt('Tab name (leave blank to auto-name from first line)', tab.name || '');
    if (newName === null) return;
    tab.name = newName.trim().toUpperCase().slice(0, TAB_NAME_MAX);
    renderNoteTabs();
    saveNotesNow();
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

  // Top-right "UPDATED YYYY-MM-DD HH:MM" chip — shows when the active tab's
  // body was last edited. margin-left: auto in CSS pushes it to the right
  // edge of the tabs row.
  const updatedSpan = document.createElement('span');
  updatedSpan.className = 'note-updated';
  updatedSpan.id = 'note-updated';
  noteTabsEl.appendChild(updatedSpan);
  refreshNoteUpdatedDisplay();

  if (notesTabCountEl) {
    notesTabCountEl.textContent = String(notesState.tabs.length).padStart(2, '0');
  }
}

function renderActiveNote() {
  const tab = activeNoteTab();
  noteTextareaEl.value = tab?.body || '';
  refreshNoteUpdatedDisplay();
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
  // Empty name → display falls back to first line of body (or NOTE N if blank).
  notesState.tabs.push({ id, name: '', body: '' });
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
  if (tab) {
    tab.body = noteTextareaEl.value;
    tab.updatedAt = Date.now();
  }
  setNotesStatus('EDITING', 'amber');
  refreshNoteUpdatedDisplay();
  // Live-update the active tab's title from the first line of the body.
  if (tab && activeTabNameSpan) {
    activeTabNameSpan.textContent = tabDisplayName(tab, notesState.tabs.indexOf(tab));
  }
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

// Per-line timestamp: pressing Enter inserts "\n[HH:MM] " at the caret and
// places the caret after the prefix. Shift+Enter, Ctrl+Enter etc. fall
// through to the textarea's default newline behavior so the user has an
// escape hatch when they don't want a stamp.
noteTextareaEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  const ta = noteTextareaEl;
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const insert = `\n[${fmtNoteTime()}] `;
  ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
  const caret = start + insert.length;
  ta.selectionStart = ta.selectionEnd = caret;
  scheduleNoteSave();
});

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

// ── Chat — Ollama (local) + Azure OpenAI (cloud) ────────────────────────────
const OLLAMA_URL = 'http://localhost:11434';
const AZURE_DEFAULT_API_VERSION = '2024-10-21';

const chatProviderEl  = document.querySelector('#chat-provider');
const chatModelEl     = document.querySelector('#chat-model');
const chatMessagesEl  = document.querySelector('#chat-messages');
const chatInputEl     = document.querySelector('#chat-input');
const chatSendBtn     = document.querySelector('#chat-send');
const chatClearBtn    = document.querySelector('#chat-clear');
const chatAutoBtn     = document.querySelector('#chat-auto');
const chatTagEl       = document.querySelector('#chat-tag');
const chatFooterEl    = document.querySelector('#chat-footer');
const azureConfigEl   = document.querySelector('#chat-azure-config');
const azureEndpointEl   = document.querySelector('#azure-endpoint');
const azureDeploymentEl = document.querySelector('#azure-deployment');
const azureVersionEl    = document.querySelector('#azure-version');
const azureKeyEl        = document.querySelector('#azure-key');

let chatHistory = [];          // [{ role: 'user'|'assistant', content }]
let chatBusy = false;
let chatAbort = null;
let chatProvider = 'ollama';
let azureConfigVisible = false;

function setChatStatus(text, kind) {
  if (!chatFooterEl) return;
  const cls = kind || '';
  chatFooterEl.innerHTML = `<em>STATE</em> <strong class="${cls}">${text}</strong>`;
  chatFooterEl.className = 'footer-readout';
}

function renderMessages() {
  if (!chatMessagesEl) return;
  if (!chatHistory.length) {
    chatMessagesEl.innerHTML = '<div class="chat-empty">CHAT IS EMPTY · TYPE BELOW TO START</div>';
    return;
  }
  chatMessagesEl.innerHTML = '';
  for (const msg of chatHistory) {
    const div = document.createElement('div');
    div.className = `chat-msg ${msg.role}`;
    const role = document.createElement('span');
    role.className = 'chat-msg-role';
    role.textContent = msg.role === 'user' ? '▶ YOU' : '◆ ASSISTANT';
    const content = document.createElement('div');
    content.className = 'chat-msg-content';
    content.textContent = msg.content || '…';
    div.appendChild(role);
    div.appendChild(content);
    chatMessagesEl.appendChild(div);
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function loadOllamaModels() {
  if (!chatModelEl) return;
  setChatStatus('CONNECTING…', 'amber');
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) {
      chatModelEl.innerHTML = '<option value="">— NO MODELS —</option>';
      chatTagEl.textContent = '00';
      setChatStatus('NO MODELS · OLLAMA EMPTY', 'amber');
      return;
    }
    chatModelEl.innerHTML = models
      .map(m => `<option value="${escapeText(m.name)}">${escapeText(m.name).toUpperCase()}</option>`)
      .join('');
    chatTagEl.textContent = String(models.length).padStart(2, '0');
    // Restore saved model selection if any
    const cfg = (await window.dash?.getConfig?.()) || {};
    if (cfg.chatModel && models.some(m => m.name === cfg.chatModel)) {
      chatModelEl.value = cfg.chatModel;
    }
    setChatStatus('READY', 'ok');
  } catch (err) {
    chatModelEl.innerHTML = '<option value="">— OLLAMA OFFLINE —</option>';
    chatTagEl.textContent = '!!';
    setChatStatus(`OFFLINE · ${err.message}`.toUpperCase(), 'red');
  }
}

function buildChatSystemPrompt() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [
    'You are a helpful assistant embedded in a desktop dashboard.',
    `Today's local date and time is ${now.toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    })} (${tz}).`,
    `ISO timestamp: ${now.toISOString()}.`,
  ];
  if (typeof activeLocation === 'object' && activeLocation?.name) {
    const region = [activeLocation.admin1, activeLocation.country].filter(Boolean).join(', ');
    lines.push(`Primary weather location: ${activeLocation.name}${region ? ', ' + region : ''}.`);
  }
  if (typeof altLocation === 'object' && altLocation?.name) {
    lines.push(`Alt zone 1: ${altLocation.name} (${altLocation.timezone}).`);
  }
  if (typeof altLocation2 === 'object' && altLocation2?.name) {
    lines.push(`Alt zone 2: ${altLocation2.name} (${altLocation2.timezone}).`);
  }
  lines.push('When the user asks about the current time, date, or weather location, use the values above directly — they are accurate.');
  return lines.join('\n');
}

async function sendChat() {
  if (chatBusy) return;
  const prompt = chatInputEl.value.trim();
  if (!prompt) return;

  chatHistory.push({ role: 'user', content: prompt });
  chatHistory.push({ role: 'assistant', content: '' });
  chatInputEl.value = '';
  chatBusy = true;
  chatSendBtn.disabled = true;
  setChatStatus('THINKING…', 'amber');
  renderMessages();

  chatAbort = new AbortController();
  try {
    const messages = [
      { role: 'system', content: buildChatSystemPrompt() },
      ...chatHistory.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
    ];
    if (chatProvider === 'azure') {
      await streamAzure(messages, chatAbort.signal);
    } else {
      await streamOllama(messages, chatAbort.signal);
    }
    setChatStatus('READY', 'ok');
  } catch (err) {
    chatHistory[chatHistory.length - 1].content += `\n[error: ${err.message}]`;
    renderMessages();
    setChatStatus(`ERROR · ${err.message}`.toUpperCase(), 'red');
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    chatAbort = null;
  }
}

// Ollama: NDJSON stream — one JSON object per line in res.body.
async function streamOllama(messages, signal) {
  const model = chatModelEl.value;
  if (!model) throw new Error('SELECT A MODEL');
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error('no stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.message?.content) {
          chatHistory[chatHistory.length - 1].content += obj.message.content;
          renderMessages();
        }
      } catch {}
    }
  }
  if (window.dash?.setConfig) window.dash.setConfig({ chatModel: model });
}

// Azure OpenAI: SSE stream — `data: {json}\n\n` events; ends with `data: [DONE]`.
async function streamAzure(messages, signal) {
  const cfg = readAzureConfig();
  if (!cfg.endpoint || !cfg.deployment || !cfg.key) {
    throw new Error('AZURE NEEDS ENDPOINT, DEPLOYMENT, KEY');
  }
  const url = `${cfg.endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(cfg.deployment)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion || AZURE_DEFAULT_API_VERSION)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': cfg.key,
    },
    body: JSON.stringify({ messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${errText.slice(0, 80)}`);
  }
  if (!res.body) throw new Error('no stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const event of events) {
      // each event line set may have multiple `data: ...` lines or comments
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            chatHistory[chatHistory.length - 1].content += delta;
            renderMessages();
          }
        } catch {}
      }
    }
  }
}

function readAzureConfig() {
  return {
    endpoint:   (azureEndpointEl?.value   || '').trim(),
    deployment: (azureDeploymentEl?.value || '').trim(),
    key:        (azureKeyEl?.value        || '').trim(),
    apiVersion: (azureVersionEl?.value    || '').trim(),
  };
}

async function saveAzureConfig() {
  if (!window.dash?.setConfig) return;
  await window.dash.setConfig({ azure: readAzureConfig() });
}

function applyProvider(p) {
  chatProvider = p === 'azure' ? 'azure' : 'ollama';
  if (chatProviderEl) chatProviderEl.value = chatProvider;
  // Model dropdown only meaningful for Ollama; hide for Azure.
  if (chatModelEl) chatModelEl.style.display = chatProvider === 'azure' ? 'none' : '';
  // Azure config block is hidden by default; gear ⚙ toggles it.
  if (azureConfigEl) {
    azureConfigEl.hidden = !azureConfigVisible;
  }
}

chatSendBtn?.addEventListener('click', sendChat);
chatInputEl?.addEventListener('keydown', (e) => {
  // Enter to send, Shift+Enter for newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
chatClearBtn?.addEventListener('click', () => {
  if (chatAbort) chatAbort.abort();
  chatHistory = [];
  renderMessages();
  setChatStatus('CLEARED', 'ok');
});

chatProviderEl?.addEventListener('change', async () => {
  applyProvider(chatProviderEl.value);
  if (window.dash?.setConfig) await window.dash.setConfig({ chatProvider });
  if (chatProvider === 'ollama') {
    await loadOllamaModels();
  } else {
    setChatStatus(readyAzure() ? 'READY' : 'CONFIGURE AZURE', readyAzure() ? 'ok' : 'amber');
  }
});

chatAutoBtn?.addEventListener('click', async () => {
  if (!window.dash?.azureAutoConfig) {
    setChatStatus('AUTO REQUIRES APP RESTART · CLOSE EXE & RUN Dashboard.bat', 'red');
    return;
  }
  setChatStatus('AUTO-CONFIG · QUERYING az CLI…', 'amber');
  chatAutoBtn.disabled = true;
  try {
    const cfg = await window.dash.azureAutoConfig();
    if (!cfg || cfg.error) {
      setChatStatus(`AUTO FAILED · ${(cfg?.error || 'NO RESPONSE')}`.toUpperCase(), 'red');
      return;
    }
    if (azureEndpointEl)   azureEndpointEl.value   = cfg.endpoint   || '';
    if (azureDeploymentEl) azureDeploymentEl.value = cfg.deployment || '';
    if (azureVersionEl)    azureVersionEl.value    = cfg.apiVersion || '';
    if (azureKeyEl)        azureKeyEl.value        = cfg.key        || '';
    await saveAzureConfig();

    // Switch to Azure since we just configured it.
    chatProviderEl.value = 'azure';
    applyProvider('azure');
    if (window.dash?.setConfig) await window.dash.setConfig({ chatProvider: 'azure' });

    if (cfg.warning) {
      setChatStatus(`PARTIAL · ${cfg.warning}`.toUpperCase(), 'amber');
    } else {
      setChatStatus(
        `READY · ${cfg.resourceName || 'AZURE'} · ${cfg.deploymentCount} DEPLOY`.toUpperCase(),
        'ok'
      );
    }
  } catch (err) {
    setChatStatus(`AUTO FAILED · ${err.message}`.toUpperCase(), 'red');
  } finally {
    chatAutoBtn.disabled = false;
  }
});

// Save Azure fields on blur so they persist even if user doesn't switch providers.
[azureEndpointEl, azureDeploymentEl, azureVersionEl, azureKeyEl].forEach(el => {
  el?.addEventListener('change', () => saveAzureConfig());
  el?.addEventListener('blur',   () => saveAzureConfig());
});

function readyAzure() {
  const c = readAzureConfig();
  return !!(c.endpoint && c.deployment && c.key);
}

function initChat(cfg) {
  // Restore Azure config fields (so user doesn't have to retype every launch).
  if (cfg?.azure) {
    if (azureEndpointEl)   azureEndpointEl.value   = cfg.azure.endpoint   || '';
    if (azureDeploymentEl) azureDeploymentEl.value = cfg.azure.deployment || '';
    if (azureVersionEl)    azureVersionEl.value    = cfg.azure.apiVersion || '';
    if (azureKeyEl)        azureKeyEl.value        = cfg.azure.key        || '';
  }
  applyProvider(cfg?.chatProvider || 'ollama');
  if (chatProvider === 'ollama') {
    loadOllamaModels();
  } else {
    setChatStatus(readyAzure() ? 'READY' : 'CONFIGURE AZURE', readyAzure() ? 'ok' : 'amber');
    chatTagEl.textContent = readyAzure() ? 'AZ' : '!!';
  }
}

renderMessages();

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
      // Snap the cursor delta so resize works regardless of where the
      // panel started. Alt bypasses snap.
      let dx = ev.clientX - startX;
      let dy = ev.clientY - startY;
      if (!ev.altKey) {
        const g = getGridSize();
        dx = snap(dx, g.w);
        dy = snap(dy, g.h);
      }
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
      // Clamp the moved edges against neighbors so the panel can't grow
      // into another panel. Skipped under Alt (free placement).
      if (!ev.altKey) {
        const r = resolveResizeOverlap(newLeft, newTop, newW, newH, grows, getNeighborRects(panel));
        if (r.width >= PANEL_MIN_W && r.height >= PANEL_MIN_H) {
          newLeft = r.left; newTop = r.top; newW = r.width; newH = r.height;
        }
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

// Snap-to-grid. The grid is invisible — purely a layout aid for panel
// drag + resize. Cell size is derived from the viewport so a 16:9, 4:3,
// or ultrawide monitor all get a clean integer column/row count with
// cells around 80px on a side.
function getGridSize() {
  const target = 40;
  const cols = Math.max(1, Math.round(window.innerWidth  / target));
  const rows = Math.max(1, Math.round(window.innerHeight / target));
  return {
    w: window.innerWidth  / cols,
    h: window.innerHeight / rows,
  };
}
function snap(value, cell) {
  return Math.round(value / cell) * cell;
}

// Collision detection so panels (+ audio visualizers) can't overlap during
// drag or resize. They share viewport space; preventing overlap also
// produces "snap together edge-to-edge" behavior for free — when you push
// one against another, the dragged element stops with its edge flush
// against the neighbor's edge.
function getNeighborRects(self) {
  const els = document.querySelectorAll('.panel, .audio-grid');
  const out = [];
  for (const el of els) {
    if (el === self) continue;
    if (el.classList.contains('is-collapsed')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}

// Drag-collision: if proposed rect overlaps a neighbor, translate by the
// minimum axis-aligned distance that resolves the overlap. Iterates so
// resolving one collision can't put us inside a different neighbor.
function resolveDragOverlap(left, top, width, height, neighbors) {
  let l = left, t = top;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const n of neighbors) {
      const r = l + width, b = t + height;
      if (r <= n.left || l >= n.right || b <= n.top || t >= n.bottom) continue;
      // Distance to push out on each axis.
      const pushR = n.right - l;       // shift right so left edge meets n.right
      const pushL = r - n.left;        // shift left so right edge meets n.left
      const pushD = n.bottom - t;
      const pushU = b - n.top;
      const m = Math.min(pushR, pushL, pushD, pushU);
      if (m === pushR)      l = n.right;
      else if (m === pushL) l = n.left - width;
      else if (m === pushD) t = n.bottom;
      else                  t = n.top  - height;
      moved = true;
    }
    if (!moved) break;
  }
  return { left: l, top: t };
}

// Resize-collision: clamp moved edges to neighbor edges so we can't grow
// into another panel. grows = { n, s, e, w } indicates which edges are
// being dragged; only those are eligible to clamp. Returns clamped rect.
function resolveResizeOverlap(left, top, width, height, grows, neighbors) {
  let l = left, t = top, w = width, h = height;
  for (const n of neighbors) {
    const r = l + w, b = t + h;
    if (r <= n.left || l >= n.right || b <= n.top || t >= n.bottom) continue;
    if (grows.e && r > n.left && l < n.left) {
      w = n.left - l;
    }
    if (grows.w && l < n.right && r > n.right) {
      const right = l + w;
      l = n.right;
      w = right - l;
    }
    if (grows.s && b > n.top && t < n.top) {
      h = n.top - t;
    }
    if (grows.n && t < n.bottom && b > n.bottom) {
      const bottom = t + h;
      t = n.bottom;
      h = bottom - t;
    }
  }
  return { left: l, top: t, width: w, height: h };
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
      // Absolute-position snap: target final position lands on a grid line.
      let nx = startLeft + (ev.clientX - startX);
      let ny = startTop  + (ev.clientY - startY);
      if (!ev.altKey) {
        const g = getGridSize();
        nx = snap(nx, g.w);
        ny = snap(ny, g.h);
        // Resolve collision with other panels / audio grids — translate to
        // the closest non-overlapping position. Naturally aligns edges.
        const resolved = resolveDragOverlap(nx, ny, rect.width, rect.height, getNeighborRects(panel));
        nx = resolved.left;
        ny = resolved.top;
      }
      panel.style.left = `${nx}px`;
      panel.style.top  = `${ny}px`;
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

// Stagger the panel-pulse animation so panels don't all peak at the same time.
const _allPanels = document.querySelectorAll('.panel');
_allPanels.forEach((panel, i) => {
  attachResize(panel);
  attachDrag(panel);
  // Negative delay shifts each panel's phase forward in the 8s cycle.
  const phase = -(i * 8 / Math.max(1, _allPanels.length));
  panel.style.animationDelay = `${phase.toFixed(2)}s`;
});

// Collapse chevrons for notes + chat panels.
function attachCollapseButton(panel) {
  const key = panelKey(panel);
  const header = panel.querySelector('.panel-header');
  if (!key || !header) return;
  const btn = document.createElement('button');
  btn.className = 'panel-collapse-btn';
  btn.type = 'button';
  btn.title = 'Collapse / expand';
  btn.textContent = '▾';
  // Stop drag from kicking in when clicking the chevron in the (draggable) header.
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    panel.classList.toggle('is-collapsed');
    if (window.dash?.getConfig && window.dash?.setConfig) {
      const cfg = await window.dash.getConfig();
      const collapsed = { ...(cfg.collapsed || {}) };
      collapsed[key] = panel.classList.contains('is-collapsed');
      await window.dash.setConfig({ collapsed });
    }
  });
  header.appendChild(btn);
}

document.querySelectorAll('.panel-combo').forEach(attachCollapseButton);

// Combo panel fold buttons — half-down + full-down. Sit beside the existing
// collapse chevron in the header. Each button toggles its state; clicking
// the active button returns the panel to its default size. The panel is
// re-anchored to its grid-cell column via CSS custom properties so it
// extends straight down without shifting horizontally.
function attachComboFoldButtons(panel) {
  const header = panel.querySelector('.panel-header');
  if (!header) return;
  const collapseBtn = header.querySelector('.panel-collapse-btn');

  const halfBtn = document.createElement('button');
  halfBtn.className = 'panel-collapse-btn panel-fold-btn';
  halfBtn.type = 'button';
  halfBtn.title = 'Fold half-down';
  halfBtn.textContent = '◐';

  const fullBtn = document.createElement('button');
  fullBtn.className = 'panel-collapse-btn panel-fold-btn panel-fold-btn-full';
  fullBtn.type = 'button';
  fullBtn.title = 'Fold full-down';
  fullBtn.textContent = '●';

  function applyFold(mode) {
    panel.classList.remove('is-fold-half', 'is-fold-full', 'is-collapsed');
    halfBtn.classList.toggle('is-active', mode === 'half');
    fullBtn.classList.toggle('is-active', mode === 'full');
    // Body class drives the dim-rest-of-dashboard backdrop in CSS.
    document.body.classList.toggle('is-combo-fold-full', mode === 'full');
    if (!mode) {
      panel.style.removeProperty('--fold-top');
      panel.style.removeProperty('--fold-left');
      panel.style.removeProperty('--fold-width');
      return;
    }
    // Capture current column geometry so the fixed overlay lines up with
    // the grid cell underneath. Read BEFORE adding the class.
    const r = panel.getBoundingClientRect();
    panel.style.setProperty('--fold-top',   `${Math.round(r.top)}px`);
    panel.style.setProperty('--fold-left',  `${Math.round(r.left)}px`);
    panel.style.setProperty('--fold-width', `${Math.round(r.width)}px`);
    panel.classList.add(mode === 'half' ? 'is-fold-half' : 'is-fold-full');
  }

  halfBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  fullBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  halfBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-half') ? null : 'half');
  });
  fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-full') ? null : 'full');
  });

  // Group all three controls (collapse + half + full) in a single flex
  // wrapper so they hug the right edge of the header instead of being
  // separated by the grid's auto columns.
  const group = document.createElement('span');
  group.className = 'panel-fold-group';
  if (collapseBtn) group.appendChild(collapseBtn);
  group.appendChild(halfBtn);
  group.appendChild(fullBtn);
  header.appendChild(group);

  // Existing collapse chevron must clear any fold state so the three modes
  // are mutually exclusive.
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      if (panel.classList.contains('is-collapsed')) {
        applyFold(null);
        panel.classList.add('is-collapsed');
      }
    });
  }

  // Re-pin geometry on viewport resize while a fold is active (the column
  // width can change when the dashboard window is resized).
  window.addEventListener('resize', () => {
    if (!panel.classList.contains('is-fold-half') && !panel.classList.contains('is-fold-full')) return;
    const mode = panel.classList.contains('is-fold-full') ? 'full' : 'half';
    applyFold(mode);
  });
}

document.querySelectorAll('.panel-combo').forEach(attachComboFoldButtons);

// ── Combo panel (Notes / Chat mode toggle) ──────────────────────────────────
const comboPanel = document.querySelector('.panel-combo');
if (comboPanel) {
  const titleEl       = comboPanel.querySelector('#combo-title');
  const codeEl        = comboPanel.querySelector('#combo-code');
  const tagEl         = comboPanel.querySelector('#combo-tag');
  const footerLabelEl = comboPanel.querySelector('#combo-footer-label');
  const notesPane     = comboPanel.querySelector('.combo-pane-notes');
  const chatPane      = comboPanel.querySelector('.combo-pane-chat');
  const notesTabCount = document.getElementById('notes-tab-count');
  const chatTagSrc    = document.getElementById('chat-tag');

  const paperPane    = comboPanel.querySelector('.combo-pane-paper');
  const paperStatsEl = document.getElementById('paper-stats');
  const webPane      = comboPanel.querySelector('.combo-pane-web');
  const webBlockedEl = document.getElementById('web-blocked');

  function paintComboHeader() {
    const mode = comboPanel.dataset.mode || 'notes';
    if (mode === 'notes') {
      titleEl.innerHTML = 'NOTES <em>N1</em>';
      codeEl.textContent = 'SCRATCHPAD';
      tagEl.textContent = notesTabCount?.textContent || '—';
      footerLabelEl.textContent = 'NOTES STATUS';
    } else if (mode === 'paper') {
      titleEl.innerHTML = 'PAPER <em>P1</em>';
      codeEl.textContent = 'WORD PROCESSOR';
      tagEl.textContent = paperStatsEl?.textContent || '—';
      footerLabelEl.textContent = 'PAPER STATUS';
    } else if (mode === 'web') {
      titleEl.innerHTML = 'WEB <em>W1</em>';
      codeEl.textContent = 'BROWSER';
      tagEl.textContent = webBlockedEl?.textContent || '—';
      footerLabelEl.textContent = 'BROWSER STATUS';
    } else {
      titleEl.innerHTML = 'CHAT <em>X1</em>';
      const provider = document.getElementById('chat-provider')?.value;
      codeEl.textContent = provider === 'azure' ? 'AZURE' : 'OLLAMA';
      tagEl.textContent = chatTagSrc?.textContent || '—';
      footerLabelEl.textContent = 'CHAT STATUS';
    }
  }

  function setComboMode(mode, persist = true) {
    if (mode !== 'notes' && mode !== 'chat' && mode !== 'paper' && mode !== 'web') mode = 'notes';
    comboPanel.dataset.mode = mode;
    notesPane?.classList.toggle('is-visible', mode === 'notes');
    chatPane ?.classList.toggle('is-visible', mode === 'chat');
    paperPane?.classList.toggle('is-visible', mode === 'paper');
    webPane  ?.classList.toggle('is-visible', mode === 'web');
    comboPanel.querySelectorAll('.combo-mode-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
    paintComboHeader();
    if (persist && window.dash?.setConfig) window.dash.setConfig({ comboMode: mode });
  }

  comboPanel.querySelectorAll('.combo-mode-tab').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't drag-grab
    btn.addEventListener('click', () => setComboMode(btn.dataset.mode));
  });

  // Keep the visible tag/code chip in sync with whichever mode is active —
  // the underlying notes/chat code keeps writing to the original hidden IDs.
  if (notesTabCount) new MutationObserver(paintComboHeader).observe(notesTabCount, { childList: true, characterData: true, subtree: true });
  if (chatTagSrc)    new MutationObserver(paintComboHeader).observe(chatTagSrc,    { childList: true, characterData: true, subtree: true });
  if (paperStatsEl)  new MutationObserver(paintComboHeader).observe(paperStatsEl,  { childList: true, characterData: true, subtree: true });
  if (webBlockedEl)  new MutationObserver(paintComboHeader).observe(webBlockedEl,  { childList: true, characterData: true, subtree: true });
  document.getElementById('chat-provider')?.addEventListener('change', paintComboHeader);

  // Restore persisted mode.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    setComboMode(cfg.comboMode || 'notes', false);
  })();
}

// ── Paper (basic word processor) ────────────────────────────────────────────
// contenteditable + execCommand. execCommand is technically deprecated but
// every Chromium build still supports it and reimplementing rich-text
// editing on top of the Selection/Range API is a massive undertaking. For a
// "basic but usable" doc editor this trade-off is fine; if Chromium ever
// drops it we can swap the toolbar handlers to a Selection-based path.
const paperEditorEl  = document.getElementById('paper-editor');
const paperToolbarEl = document.getElementById('paper-toolbar');
const paperStatsElGlobal = document.getElementById('paper-stats');
let paperSaveTimer = null;

function updatePaperStats() {
  if (!paperEditorEl || !paperStatsElGlobal) return;
  const text = paperEditorEl.innerText || '';
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  paperStatsElGlobal.textContent = `${words.toLocaleString()} W · ${chars.toLocaleString()} C`;
}

async function savePaperNow() {
  clearTimeout(paperSaveTimer);
  if (!paperEditorEl || !window.dash?.setConfig) return;
  try { await window.dash.setConfig({ paperContent: paperEditorEl.innerHTML }); } catch {}
}
function schedulePaperSave() {
  updatePaperStats();
  clearTimeout(paperSaveTimer);
  paperSaveTimer = setTimeout(savePaperNow, 500);
}

if (paperEditorEl && paperToolbarEl) {
  // Toolbar dispatch. data-cmd values match execCommand names except for
  // headings (h1/h2/h3/p) and the formatBlock:X shorthand (e.g. blockquote).
  paperToolbarEl.addEventListener('mousedown', (e) => {
    // Stop the panel from drag-grabbing on the toolbar.
    if (e.target.closest('.paper-tool')) e.stopPropagation();
  });
  paperToolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.paper-tool');
    if (!btn) return;
    e.stopPropagation();
    const cmd = btn.dataset.cmd;
    paperEditorEl.focus();
    if (cmd === 'h1' || cmd === 'h2' || cmd === 'h3' || cmd === 'p') {
      const tag = cmd === 'p' ? 'p' : cmd;
      document.execCommand('formatBlock', false, tag);
    } else if (cmd?.startsWith('formatBlock:')) {
      document.execCommand('formatBlock', false, cmd.slice('formatBlock:'.length));
    } else if (cmd) {
      document.execCommand(cmd, false, null);
    }
    schedulePaperSave();
  });

  // Plain-text paste so users pasting from Word/web don't drag in colors,
  // fonts, weird spacing, etc. that fight our theme.
  paperEditorEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
    document.execCommand('insertText', false, text);
  });

  paperEditorEl.addEventListener('input', schedulePaperSave);
  paperEditorEl.addEventListener('blur', savePaperNow);

  // Font selector — picks the editor's base font-family. Per-selection font
  // overrides via execCommand('fontName') still work over top of this.
  const paperFontEl = document.getElementById('paper-font');
  function applyPaperFont(key) {
    if (!paperEditorEl || !paperFontEl) return;
    const opt = paperFontEl.querySelector(`option[value="${CSS.escape(key)}"]`) || paperFontEl.options[0];
    if (!opt) return;
    paperEditorEl.style.fontFamily = opt.dataset.stack || '';
    if (paperFontEl.value !== opt.value) paperFontEl.value = opt.value;
  }
  if (paperFontEl) {
    paperFontEl.addEventListener('mousedown', (e) => e.stopPropagation());
    paperFontEl.addEventListener('change', () => {
      applyPaperFont(paperFontEl.value);
      if (window.dash?.setConfig) window.dash.setConfig({ paperFont: paperFontEl.value });
    });
  }

  // Restore persisted content + font + initial stats.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    if (typeof cfg.paperContent === 'string') paperEditorEl.innerHTML = cfg.paperContent;
    applyPaperFont(cfg.paperFont || 'tech');
    updatePaperStats();
  })();
}

// ── Web browser pane ────────────────────────────────────────────────────────
// Lightweight in-panel browser with multi-tab + private-mode support. Each
// tab owns its own <webview> with its own session partition: normal tabs
// share the persistent partition (cookies/history live across restarts),
// private tabs use an in-memory partition (no `persist:` prefix → cleared
// when the tab closes). Ad blocking + CSP stripping are installed per
// partition via main-process IPC. Dark-mode dimming is done by Chromium's
// own auto-dark-mode (CDP), then tinted toward the theme accent via an
// insertCSS overlay using mix-blend-mode.
const webViewWrapEl   = document.getElementById('web-view-wrap');
const webTabsEl       = document.getElementById('web-tabs');
const webTabNewEl     = document.getElementById('web-tab-new');
const webTabPrivEl    = document.getElementById('web-tab-new-private');
const webUrlEl        = document.getElementById('web-url');
const webBackEl       = document.getElementById('web-back');
const webForwardEl    = document.getElementById('web-forward');
const webReloadEl     = document.getElementById('web-reload');
const webHomeEl       = document.getElementById('web-home');
const webGoEl         = document.getElementById('web-go');
const webBlockedElGlobal = document.getElementById('web-blocked');
const WEB_HOME = 'https://www.google.com/';
const WEB_NORMAL_PARTITION = 'persist:dashboard-browser';

function normalizeWebInput(raw) {
  const s = (raw || '').trim();
  if (!s) return WEB_HOME;
  if (/^[a-z]+:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

if (webViewWrapEl && webTabsEl && webUrlEl) {
  const tabs = [];
  let activeTabId = null;
  let _webBlocks = 0;
  let _saveTimer = null;

  if (window.dash?.onWebRequestBlocked) {
    window.dash.onWebRequestBlocked(() => {
      _webBlocks++;
      if (webBlockedElGlobal) webBlockedElGlobal.textContent = `${_webBlocks.toLocaleString()} BLK`;
    });
  }

  function getActiveTab() { return tabs.find(t => t.id === activeTabId) || null; }

  function saveTabState() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      const urls = tabs.filter(t => !t.isPrivate).map(t => t.url || WEB_HOME);
      if (window.dash?.setConfig) window.dash.setConfig({ webTabs: urls });
    }, 250);
  }

  function applyWebTint(wv) {
    const cs = getComputedStyle(document.documentElement);
    const accent = (cs.getPropertyValue('--accent').trim() || '#5ccfff');
    // Chromium's auto-dark-mode (engaged via CDP) renders pages mostly
    // black. We layer a fixed full-viewport overlay tinted to the theme
    // accent with mix-blend-mode: screen — that lifts dark pixels toward
    // the accent without washing out images. opacity tuned low so text
    // contrast stays high.
    const css = `
      html { color-scheme: dark; }
      body::after {
        content: '' !important;
        position: fixed !important;
        inset: 0 !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        background: ${accent} !important;
        mix-blend-mode: screen !important;
        opacity: 0.16 !important;
      }
      ::-webkit-scrollbar { width: 10px; height: 10px; background: rgba(0,0,0,0.5); }
      ::-webkit-scrollbar-thumb { background: ${accent}; }
      ::selection { background-color: ${accent}; color: #000; }
    `;
    try {
      // Replace any previous tint stylesheet so theme switches take effect.
      if (wv._tintKey) wv.removeInsertedCSS?.(wv._tintKey).catch(() => {});
      wv.insertCSS?.(css).then((key) => { wv._tintKey = key; }).catch(() => {});
    } catch {}
  }

  async function forceWebDark(wv) {
    try {
      const id = wv.getWebContentsId?.();
      if (!Number.isFinite(id) || !window.dash?.forceWebDark) return;
      await window.dash.forceWebDark(id);
    } catch {}
  }

  function attachWebviewHandlers(tab) {
    const wv = tab.webviewEl;
    const updateUrl = (url) => {
      tab.url = url;
      if (activeTabId === tab.id) webUrlEl.value = url;
      saveTabState();
    };
    wv.addEventListener('did-navigate',          (e) => updateUrl(e.url));
    wv.addEventListener('did-navigate-in-page',  (e) => updateUrl(e.url));
    wv.addEventListener('page-title-updated',    (e) => {
      tab.title = (e.title || '').trim() || hostFromUrl(tab.url) || 'TAB';
      updateTabLabel(tab);
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return;
      console.warn('[web] load failed:', e.errorCode, e.errorDescription, '→', e.validatedURL);
    });
    wv.addEventListener('dom-ready', () => {
      try { window.dash?.installWebAdblock?.(tab.partition); } catch {}
      forceWebDark(wv);
      applyWebTint(wv);
    });
  }

  function hostFromUrl(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function updateTabLabel(tab) {
    const lbl = tab.tabEl.querySelector('.web-tab-title');
    if (lbl) lbl.textContent = (tab.title || hostFromUrl(tab.url) || 'TAB').slice(0, 40);
  }

  function createTab({ url = WEB_HOME, isPrivate = false } = {}) {
    const id = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const partition = isPrivate ? `web-private-${id}` : WEB_NORMAL_PARTITION;

    const tabEl = document.createElement('div');
    tabEl.className = 'web-tab' + (isPrivate ? ' is-private' : '');
    tabEl.dataset.tabId = id;
    tabEl.title = isPrivate ? 'Private tab — no history saved' : '';
    tabEl.innerHTML =
      `<span class="web-tab-icon">${isPrivate ? '⊘' : '◌'}</span>` +
      `<span class="web-tab-title">${isPrivate ? 'PRIVATE' : 'NEW TAB'}</span>` +
      `<button type="button" class="web-tab-close" title="Close">×</button>`;
    webTabsEl.insertBefore(tabEl, webTabNewEl);

    const wv = document.createElement('webview');
    wv.className = 'web-view';
    wv.setAttribute('partition', partition);
    wv.setAttribute('src', url);
    wv.setAttribute('allowpopups', '');
    wv.style.display = 'none';
    webViewWrapEl.appendChild(wv);

    const tab = { id, isPrivate, partition, title: isPrivate ? 'PRIVATE' : 'NEW TAB', url, webviewEl: wv, tabEl };
    tabs.push(tab);
    attachWebviewHandlers(tab);

    tabEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('web-tab-close')) {
        e.stopPropagation();
        closeTab(id);
      } else {
        activateTab(id);
      }
    });

    activateTab(id);
    return tab;
  }

  function activateTab(id) {
    activeTabId = id;
    for (const t of tabs) {
      const active = t.id === id;
      t.webviewEl.style.display = active ? '' : 'none';
      t.tabEl.classList.toggle('is-active', active);
      if (active) webUrlEl.value = t.url || '';
    }
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const [t] = tabs.splice(idx, 1);
    try { t.webviewEl.remove(); } catch {}
    try { t.tabEl.remove(); } catch {}
    if (tabs.length === 0) {
      createTab();
    } else if (activeTabId === id) {
      activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
    }
    saveTabState();
  }

  function navigate(target) {
    const t = getActiveTab(); if (!t) return;
    try { t.webviewEl.loadURL(normalizeWebInput(target)); } catch {}
  }

  webGoEl     ?.addEventListener('click', () => navigate(webUrlEl.value));
  webHomeEl   ?.addEventListener('click', () => navigate(WEB_HOME));
  webBackEl   ?.addEventListener('click', () => { const t = getActiveTab(); try { t?.webviewEl.canGoBack() && t.webviewEl.goBack(); } catch {} });
  webForwardEl?.addEventListener('click', () => { const t = getActiveTab(); try { t?.webviewEl.canGoForward() && t.webviewEl.goForward(); } catch {} });
  webReloadEl ?.addEventListener('click', () => { const t = getActiveTab(); try { t?.webviewEl.reload(); } catch {} });
  webUrlEl     .addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(webUrlEl.value); }
  });
  webTabNewEl ?.addEventListener('click', () => createTab());
  webTabPrivEl?.addEventListener('click', () => createTab({ isPrivate: true }));

  // Re-apply theme tint to every open webview when the dashboard theme
  // changes. Hooks into MutationObserver on data-theme since applyTheme
  // bumps that attribute. Also reapplies if theme-invert is toggled.
  new MutationObserver(() => {
    for (const t of tabs) applyWebTint(t.webviewEl);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Restore persisted normal-tab URLs; fall back to a single home tab.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    const saved = Array.isArray(cfg.webTabs)
      ? cfg.webTabs.filter(u => typeof u === 'string' && u)
      : [];
    if (saved.length) saved.forEach((u) => createTab({ url: u }));
    else createTab();
  })();
}

// Per-element strobe staggering — each meter/row/cell gets a random phase.
const STROBE_SELECTOR =
  '.meter, .time-row, .temp-row, .storage-row, .net-row, .gpu-mem-row, ' +
  '.note-tab, .chat-msg, .weather-left, .weather-right';

function randomStrobeDelay() {
  return `-${(Math.random() * 7).toFixed(2)}s`;
}

function staggerStrobeAll(root = document) {
  root.querySelectorAll(STROBE_SELECTOR).forEach(el => {
    if (!el.dataset.strobed) {
      el.style.animationDelay = randomStrobeDelay();
      el.dataset.strobed = '1';
    }
  });
}

// Watch for dynamically-added strobe targets (storage rows, gpu mem rows,
// chat messages, note tabs) and assign each a random phase.
const _strobeObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue; // element only
      if (node.matches?.(STROBE_SELECTOR)) {
        node.style.animationDelay = randomStrobeDelay();
        node.dataset.strobed = '1';
      }
      staggerStrobeAll(node);
    }
  }
});
_strobeObserver.observe(document.body, { childList: true, subtree: true });

// Initial pass for everything already in the DOM.
staggerStrobeAll();

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

  setUserTheme(cfg?.theme || null); // also paints the theme-name chip
  applyUiFont(cfg?.uiFont || 'DEFAULT');
  if (cfg?.invert) applyInvert(true);
  if (cfg?.dim)    applyDim(true);
  if (cfg?.themeAuto) setThemeAuto(true);
  if (webcamPanelEl && cfg?.webcamPos) {
    webcamPanelEl.style.left = `${cfg.webcamPos.x}px`;
    webcamPanelEl.style.top  = `${cfg.webcamPos.y}px`;
    webcamPanelEl.style.right = 'auto';
  }
  if (webcamPanelEl && cfg?.webcamSize) {
    webcamPanelEl.style.width  = `${cfg.webcamSize.width}px`;
    webcamPanelEl.style.height = `${cfg.webcamSize.height}px`;
  }
  if (cfg?.webcamOpen) setWebcamOpen(true, cfg.webcamDeviceId || undefined);
  if (terminalPanelEl && cfg?.terminalPos) {
    terminalPanelEl.style.left = `${cfg.terminalPos.x}px`;
    terminalPanelEl.style.top  = `${cfg.terminalPos.y}px`;
  }
  if (terminalPanelEl && cfg?.terminalSize) {
    terminalPanelEl.style.width  = `${cfg.terminalSize.width}px`;
    terminalPanelEl.style.height = `${cfg.terminalSize.height}px`;
  }
  if (cfg?.terminalOpen) {
    terminalPanelEl.hidden = false;
    terminalBtnEl?.classList.add('is-active');
  }
  if (cfg?.terminalChannels && typeof cfg.terminalChannels === 'object') {
    Object.assign(_termChannels, cfg.terminalChannels);
    terminalChannelEls.forEach(cb => { cb.checked = !!_termChannels[cb.dataset.ch]; });
  }
  if (cfg?.terminalTimeFmt) {
    _termTimeFmt = cfg.terminalTimeFmt;
    if (terminalTfmtEl) terminalTfmtEl.value = _termTimeFmt;
  }
  // Default to 5s if nothing saved (matches the <select> initial selected).
  const startInterval = Number.isFinite(cfg?.terminalInterval) ? cfg.terminalInterval : 5;
  if (terminalIntervalEl) terminalIntervalEl.value = String(startInterval);
  applyTermInterval(startInterval);
  // Shared size: both viz read 'audioVizSize'. Legacy keys 'audioInSize' /
  // 'audioOutSize' are honored as a fallback if the user has an old config
  // — pick whichever is largest so we never shrink something the user had
  // already grown.
  const legacyInSize  = cfg?.audioInSize;
  const legacyOutSize = cfg?.audioOutSize;
  const sharedSize = cfg?.audioVizSize || (() => {
    if (!legacyInSize && !legacyOutSize) return null;
    const a = legacyInSize  || legacyOutSize;
    const b = legacyOutSize || legacyInSize;
    return {
      width:  Math.max(a.width  || 0, b.width  || 0) || undefined,
      height: Math.max(a.height || 0, b.height || 0) || undefined,
    };
  })();
  audioInViz?.applySavedGeom(cfg?.audioInPos,  sharedSize, cfg?.audioInMuted);
  audioOutViz?.applySavedGeom(cfg?.audioOutPos, sharedSize, cfg?.audioOutMuted);
  audioInViz?.applySavedGain?.(cfg?.audioInGain);
  audioOutViz?.applySavedGain?.(cfg?.audioOutGain);
  if (cfg?.collapsed) {
    for (const [k, v] of Object.entries(cfg.collapsed)) {
      const panel = document.querySelector(`.panel-${k}`);
      if (panel && v) panel.classList.add('is-collapsed');
    }
  }

  initNotes(cfg);
  initChat(cfg);

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
// Full restart relaunches the Electron process so main-side changes (new
// IPC handlers, webPreferences, etc.) take effect, not just the renderer.
document.querySelector('#restart-btn')?.addEventListener('click', () => {
  if (window.dash?.appRelaunch) window.dash.appRelaunch().catch(() => {});
  else window.location.reload(); // fallback in browser/dev mode
});

// Close button — quits the Electron process. In browser mode (no preload),
// closing a tab is the user's job; we just blur the URL bar so nothing
// silently steals their input.
document.querySelector('#close-btn')?.addEventListener('click', () => {
  if (window.dash?.appQuit) window.dash.appQuit().catch(() => {});
});

// Airplane button — disables every Up network adapter via admin PowerShell
// (one UAC prompt per toggle). Persists state in config so the active state
// survives reloads; on app start we read the state and reflect it visually
// without re-running the disable command.
const airplaneBtn = document.querySelector('#airplane-btn');
if (airplaneBtn) {
  let _airplaneOn = false;
  function paintAirplane(on) {
    _airplaneOn = on;
    airplaneBtn.classList.toggle('is-active', on);
    airplaneBtn.title = on
      ? 'Airplane mode ON · click to re-enable network adapters'
      : 'Airplane mode (disables network adapters · requires admin)';
  }
  airplaneBtn.addEventListener('click', async () => {
    if (!window.dash?.setAirplaneMode) return;
    const next = !_airplaneOn;
    paintAirplane(next);
    try {
      const r = await window.dash.setAirplaneMode(next);
      if (!r?.ok) console.warn('[airplane]', r?.error || 'failed');
    } catch (err) {
      console.warn('[airplane] error:', err.message || err);
    }
    if (window.dash?.setConfig) {
      try { await window.dash.setConfig({ airplaneMode: next }); } catch {}
    }
  });
  // Restore previous state visually (does not re-run the disable command).
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    if (cfg.airplaneMode) paintAirplane(true);
  })();
}

document.querySelector('#refresh-btn')?.addEventListener('click', () => {
  window.location.reload();
});

// ── Themes / display toggles ────────────────────────────────────────────────
// Theme cycle (persists through config). null = default cyan/amber/red.
const THEMES = [
  null, 'azure', 'rose', 'ocean', 'pastel', 'meadow', 'citrus',
  'neon', 'vaporwave', 'matrix', 'volt', 'crimson',
  // Low-contrast complementary set
  'dust', 'slate', 'mint', 'lavender', 'harbor',
  'moss', 'dusk', 'paper', 'storm', 'sage',
];

const themeNameEl = document.querySelector('#theme-name');
function applyTheme(name) {
  if (!name) document.documentElement.removeAttribute('data-theme');
  else       document.documentElement.setAttribute('data-theme', name);
  if (themeNameEl) themeNameEl.textContent = (name || 'default').toUpperCase();
  _themeVersion++;
}

// ── Alert theme override ───────────────────────────────────────────────────
// When any alert reason is active (offline, sustained error, CPU/GPU 90%+),
// applyTheme is forced to 'alert' on top of whatever theme the user picked.
// _userTheme tracks the last user-chosen theme so we can restore it cleanly.
// (State vars _userTheme / _alertActive / _alertReasons are declared at the
// top of the module — see TDZ note there.)
function setUserTheme(name) {
  _userTheme = name ?? null;
  applyTheme(_alertActive ? 'alert' : _userTheme);
}
function setAlertReason(key, on) {
  if (on) _alertReasons.add(key);
  else    _alertReasons.delete(key);
  const want = _alertReasons.size > 0;
  if (want === _alertActive) return;
  _alertActive = want;
  applyTheme(_alertActive ? 'alert' : _userTheme);
}
window.addEventListener('online',  () => setAlertReason(ALERT_REASON.OFFLINE, false));
window.addEventListener('offline', () => setAlertReason(ALERT_REASON.OFFLINE, true));
// Seed the offline reason from current navigator state so a renderer that
// loads while disconnected goes straight into alert mode.
if (typeof navigator !== 'undefined' && navigator.onLine === false) {
  _alertReasons.add(ALERT_REASON.OFFLINE);
  _alertActive = true;
}

function applyInvert(on) {
  document.body.classList.toggle('theme-invert', !!on);
}

function applyDim(on) {
  document.body.classList.toggle('theme-dim', !!on);
  document.querySelector('#dim-btn')?.classList.toggle('is-active', !!on);
}

async function advanceTheme(step = 1) {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const cur = cfg.theme ?? null;
  const idx = THEMES.indexOf(cur);
  const next = THEMES[((idx + step) % THEMES.length + THEMES.length) % THEMES.length];
  setUserTheme(next);
  if (window.dash?.setConfig) await window.dash.setConfig({ theme: next });
}

document.querySelector('#theme-btn')?.addEventListener('click', () => advanceTheme(1));

// ── UI font cycle ───────────────────────────────────────────────
// Each entry maps to a body class (or null = default Rajdhani+Tech-Mono)
// that swaps --font-display + --font-tech across the entire dashboard.
const UI_FONTS = [
  { name: 'DEFAULT',  cls: null },
  { name: 'TECH',     cls: 'font-tech' },
  { name: 'CLEAN',    cls: 'font-clean' },
  { name: 'CLASSIC',  cls: 'font-classic' },
  { name: 'MONO',     cls: 'font-mono' },
  { name: 'MIXED',    cls: 'font-mixed' },
  { name: 'WRITING',  cls: 'font-writing' },
];
const fontNameEl = document.querySelector('#font-name');
function applyUiFont(name) {
  const entry = UI_FONTS.find((f) => f.name === name) || UI_FONTS[0];
  for (const f of UI_FONTS) if (f.cls) document.body.classList.remove(f.cls);
  if (entry.cls) document.body.classList.add(entry.cls);
  if (fontNameEl) fontNameEl.textContent = entry.name;
}
async function advanceUiFont(step = 1) {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const cur = cfg.uiFont || 'DEFAULT';
  const idx = Math.max(0, UI_FONTS.findIndex((f) => f.name === cur));
  const next = UI_FONTS[((idx + step) % UI_FONTS.length + UI_FONTS.length) % UI_FONTS.length];
  applyUiFont(next.name);
  if (window.dash?.setConfig) await window.dash.setConfig({ uiFont: next.name });
}
document.querySelector('#font-btn')?.addEventListener('click', () => advanceUiFont(1));

// ── Topbar drag-to-reorder ──────────────────────────────────────
// Each direct child of .topbar-controls (theme button, font button,
// dim, refresh, zen, etc.) becomes individually draggable. Drop
// position is computed against sibling midpoints so the dragged
// element slots in cleanly. Order is saved under config.topbarOrder
// (array of element IDs) and re-applied on load.
const topbarEl = document.querySelector('.topbar-controls');
if (topbarEl) {
  function topbarItems() {
    return Array.from(topbarEl.children).filter((c) => c.id);
  }
  for (const el of topbarItems()) {
    el.draggable = true;
    // The button click handlers stop their own clicks from propagating
    // already; here we just let the browser's native drag take over.
  }
  let _dragged = null;
  topbarEl.addEventListener('dragstart', (e) => {
    const t = e.target.closest && e.target.closest('.topbar-controls > *');
    if (!t || t.parentElement !== topbarEl) return;
    _dragged = t;
    t.classList.add('is-topbar-dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  topbarEl.addEventListener('dragend', async () => {
    if (_dragged) _dragged.classList.remove('is-topbar-dragging');
    _dragged = null;
    if (window.dash?.setConfig) {
      try { await window.dash.setConfig({ topbarOrder: topbarItems().map((el) => el.id) }); } catch {}
    }
  });
  topbarEl.addEventListener('dragover', (e) => {
    if (!_dragged) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // Find the first sibling whose midpoint is past the cursor; insert
    // before it. If none, append at end.
    const x = e.clientX;
    const sibs = Array.from(topbarEl.children).filter((c) => c !== _dragged && c.id);
    let after = null;
    for (const el of sibs) {
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) { after = el; break; }
    }
    if (after === null) topbarEl.appendChild(_dragged);
    else if (_dragged.nextElementSibling !== after) topbarEl.insertBefore(_dragged, after);
  });
  // Restore saved order on load.
  (async () => {
    const cfg = (await window.dash?.getConfig?.()) || {};
    const ids = cfg.topbarOrder;
    if (!Array.isArray(ids) || !ids.length) return;
    const byId = Object.fromEntries(topbarItems().map((el) => [el.id, el]));
    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const id of ids) {
      if (byId[id]) { frag.appendChild(byId[id]); seen.add(id); }
    }
    // Append any new buttons (added in a future build) at the end so they
    // don't disappear when the saved order pre-dates them.
    for (const el of topbarItems()) {
      if (!seen.has(el.id)) frag.appendChild(el);
    }
    topbarEl.appendChild(frag);
  })();
}

// Auto-cycle: every 25s, advance to next theme. Persisted across reloads.
const THEME_AUTO_MS = 25000;
let _themeAutoTimer = null;
const themeAutoBtn = document.querySelector('#theme-auto-btn');
function setThemeAuto(on) {
  themeAutoBtn?.classList.toggle('is-active', !!on);
  if (_themeAutoTimer) { clearInterval(_themeAutoTimer); _themeAutoTimer = null; }
  if (on) _themeAutoTimer = setInterval(() => advanceTheme(1), THEME_AUTO_MS);
}
themeAutoBtn?.addEventListener('click', async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const next = !cfg.themeAuto;
  setThemeAuto(next);
  if (window.dash?.setConfig) await window.dash.setConfig({ themeAuto: next });
});

document.querySelector('#invert-btn')?.addEventListener('click', async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const next = !cfg.invert;
  applyInvert(next);
  if (window.dash?.setConfig) await window.dash.setConfig({ invert: next });
});

document.querySelector('#dim-btn')?.addEventListener('click', async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const next = !cfg.dim;
  applyDim(next);
  if (window.dash?.setConfig) await window.dash.setConfig({ dim: next });
});

// ── YouTube popout button ───────────────────────────────────────────────────
document.querySelector('#youtube-btn')?.addEventListener('click', async () => {
  await window.dash?.openYoutube?.();
  // If we're already in zen, immediately apply the zen treatment to the
  // brand-new window (enterZen has already fired and won't fire again).
  if (document.body.classList.contains('is-zen')) {
    setTimeout(() => window.dash?.setYoutubeZenMode?.(true), 250);
  }
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

// ── Terminal / diagnostics overlay ──────────────────────────────────────────
const terminalBtnEl    = document.querySelector('#terminal-btn');
const terminalPanelEl  = document.querySelector('#terminal-panel');
const terminalHeaderEl = document.querySelector('#terminal-header');
const terminalLogEl    = document.querySelector('#terminal-log');
const terminalClearEl  = document.querySelector('#terminal-clear');
const terminalCloseEl  = document.querySelector('#terminal-close');
const terminalResizeEl = document.querySelector('#terminal-resize');

const TERMINAL_MAX_LINES = 500;
const TERMINAL_START = Date.now();
let _termTimeFmt = 'hms';

function _termTs() {
  const d = new Date();
  if (_termTimeFmt === 'iso') {
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (_termTimeFmt === 'rel') {
    const s = ((Date.now() - TERMINAL_START) / 1000).toFixed(1);
    return `+${s.padStart(7, ' ')}s`;
  }
  return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
}

function termLog(level, args) {
  if (!terminalLogEl) return;
  const line = document.createElement('div');
  line.className = `log-line lvl-${level}`;
  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = _termTs();
  const lvlEl = document.createElement('span');
  lvlEl.className = 'log-lvl';
  lvlEl.textContent = level;
  const text = document.createElement('span');
  text.textContent = (Array.isArray(args) ? args : [args]).map(a => {
    if (a == null) return String(a);
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  line.appendChild(timeEl);
  line.appendChild(lvlEl);
  line.appendChild(text);
  terminalLogEl.appendChild(line);
  while (terminalLogEl.children.length > TERMINAL_MAX_LINES) {
    terminalLogEl.removeChild(terminalLogEl.firstChild);
  }
  terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
}

// Mirror console.log / warn / error into the terminal panel without
// breaking DevTools logging — original methods are still called.
const _origConsole = {
  log:   console.log.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
  info:  console.info.bind(console),
};
console.log   = (...a) => { _origConsole.log(...a);   termLog('info',  a); };
console.info  = (...a) => { _origConsole.info(...a);  termLog('info',  a); };
console.warn  = (...a) => { _origConsole.warn(...a);  termLog('warn',  a); };
console.error = (...a) => { _origConsole.error(...a); termLog('error', a); };

window.addEventListener('error', (e) => {
  termLog('error', [`${e.message || 'Error'}  (${e.filename || '?'}:${e.lineno || '?'}:${e.colno || '?'})`]);
});
window.addEventListener('unhandledrejection', (e) => {
  termLog('error', ['Unhandled rejection:', e.reason]);
});

// Initial diagnostics line so the user sees the terminal is alive.
termLog('info', [`DASHBOARD3D · UA=${navigator.userAgent.split(' ').slice(-2).join(' ')}`]);

terminalBtnEl?.addEventListener('click', async () => {
  if (!terminalPanelEl) return;
  const next = terminalPanelEl.hidden;
  terminalPanelEl.hidden = !next;
  terminalBtnEl.classList.toggle('is-active', next);
  if (next) terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalOpen: next });
});

async function closeTerminal() {
  if (!terminalPanelEl) return;
  terminalPanelEl.hidden = true;
  terminalBtnEl?.classList.remove('is-active');
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalOpen: false });
}

// Event-delegated handlers on the panel itself — survive any inner DOM
// changes and won't be accidentally suppressed by sibling listeners.
terminalPanelEl?.addEventListener('mousedown', (e) => {
  // Don't let action-button mousedowns reach the header's drag listener.
  if (e.target.closest && e.target.closest('.terminal-action')) {
    e.stopPropagation();
  }
});
terminalPanelEl?.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#terminal-close')) {
    e.stopPropagation();
    closeTerminal();
    return;
  }
  if (e.target.closest && e.target.closest('#terminal-clear')) {
    e.stopPropagation();
    if (terminalLogEl) terminalLogEl.innerHTML = '';
    return;
  }
});

// Drag from the header (so clicks on log text don't grab a drag).
// Use closest() so a click on any descendant (icon, text node, span)
// of an action button is treated as a button click, not a drag start.
terminalHeaderEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('.terminal-action')) return;
  e.preventDefault();
  const rect = terminalPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startLeft = rect.left, startTop = rect.top;
  terminalPanelEl.style.left = `${startLeft}px`;
  terminalPanelEl.style.top  = `${startTop}px`;
  terminalPanelEl.style.right = 'auto';
  const onMove = (ev) => {
    terminalPanelEl.style.left = `${startLeft + (ev.clientX - startX)}px`;
    terminalPanelEl.style.top  = `${startTop  + (ev.clientY - startY)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveTerminalGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

terminalResizeEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = terminalPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startW = rect.width, startH = rect.height;
  const onMove = (ev) => {
    terminalPanelEl.style.width  = `${Math.max(280, startW + (ev.clientX - startX))}px`;
    terminalPanelEl.style.height = `${Math.max(140, startH + (ev.clientY - startY))}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveTerminalGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

async function saveTerminalGeom() {
  if (!terminalPanelEl || !window.dash?.setConfig) return;
  const x = parseInt(terminalPanelEl.style.left, 10);
  const y = parseInt(terminalPanelEl.style.top,  10);
  const w = parseInt(terminalPanelEl.style.width,  10);
  const h = parseInt(terminalPanelEl.style.height, 10);
  const partial = {};
  if (Number.isFinite(x) && Number.isFinite(y)) partial.terminalPos  = { x, y };
  if (Number.isFinite(w) && Number.isFinite(h)) partial.terminalSize = { width: w, height: h };
  if (Object.keys(partial).length) await window.dash.setConfig(partial);
}

// ── Terminal telemetry ──────────────────────────────────────────────────────
const terminalIntervalEl = document.querySelector('#terminal-interval');
const terminalTfmtEl     = document.querySelector('#terminal-tfmt');
const terminalChannelEls = document.querySelectorAll('.terminal-toggles input[type="checkbox"]');
let _termTelemetryTimer = null;
let _termChannels = { sys: true, temp: true, net: true, disk: true, store: false };

function fmt1(n)   { return Number.isFinite(n) ? n.toFixed(1) : '—'; }
function fmt0(n)   { return Number.isFinite(n) ? Math.round(n).toString() : '—'; }
function fmtRateShort(b) {
  const r = fmtRate(b || 0);
  return `${r.num}${r.unit.replace('B/S', 'B').replace('/S', '')}`;
}

async function gatherTelemetry() {
  if (!window.dash) return;
  const tasks = [];
  if (_termChannels.sys && window.dash.systemInfo)
    tasks.push(window.dash.systemInfo().then(d => ['SYS', formatSys(d)]).catch(e => ['SYS', `ERR ${e.message}`]));
  if (_termChannels.temp && window.dash.tempsInfo)
    tasks.push(window.dash.tempsInfo().then(d => ['TEMP', formatTemp(d)]).catch(e => ['TEMP', `ERR ${e.message}`]));
  if (_termChannels.net && window.dash.netInfo)
    tasks.push(window.dash.netInfo().then(d => ['NET', formatNet(d)]).catch(e => ['NET', `ERR ${e.message}`]));
  if (_termChannels.disk && window.dash.diskInfo)
    tasks.push(window.dash.diskInfo().then(d => ['DISK', formatDisk(d)]).catch(e => ['DISK', `ERR ${e.message}`]));
  if (_termChannels.store && window.dash.storageInfo)
    tasks.push(window.dash.storageInfo().then(d => ['STORE', formatStore(d)]).catch(e => ['STORE', `ERR ${e.message}`]));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const [tag, msg] = r.value;
    termLog('info', [`[${tag}] ${msg}`]);
  }
}

function formatSys(d) {
  if (!d) return 'no data';
  const cpuCount = d.cpuCount || 0;
  const memUsedGB  = d.usedMem  ? (d.usedMem  / 1073741824) : null;
  const memTotalGB = d.totalMem ? (d.totalMem / 1073741824) : null;
  const memPct = memUsedGB && memTotalGB ? (memUsedGB / memTotalGB) * 100 : null;
  return `cores=${cpuCount} mem=${fmt1(memUsedGB)}/${fmt1(memTotalGB)}GB (${fmt0(memPct)}%)`;
}
function formatTemp(d) {
  if (!d) return 'no data';
  const cpu = Number.isFinite(d.cpu) ? `cpu=${fmt0(d.cpu)}°C` : 'cpu=—';
  const cpuP = Number.isFinite(d.cpuPower) ? `${fmt0(d.cpuPower)}W` : '';
  const gpus = (d.gpus || []).map((g, i) => {
    const t = Number.isFinite(g.temp)  ? `${fmt0(g.temp)}°C` : '—';
    const u = Number.isFinite(g.load)  ? `${fmt0(g.load)}%`  : '—';
    const p = Number.isFinite(g.power) ? ` ${fmt0(g.power)}W` : '';
    return `gpu${i}=${t}/${u}${p}`;
  }).join(' ');
  return [cpu + (cpuP ? `(${cpuP})` : ''), gpus, `src=${(d.sources || []).join(',') || 'none'}`].filter(Boolean).join(' ');
}
function formatNet(d) {
  if (!d) return 'no data';
  return `iface=${d.iface || 'none'} rx=${fmtRateShort(d.rxSec)} tx=${fmtRateShort(d.txSec)} total rx=${fmtBytes(d.rxTotal || 0)} tx=${fmtBytes(d.txTotal || 0)}`;
}
function formatDisk(d) {
  if (!d) return 'no data';
  return `read=${fmtRateShort(d.readSec)} write=${fmtRateShort(d.writeSec)} q=${fmt0(d.queueLen)} ${d.unsupported ? 'UNSUPPORTED' : ''}`.trim();
}
function formatStore(d) {
  if (!Array.isArray(d) || !d.length) return 'no drives';
  return d.slice(0, 6).map(x => {
    const used = x.used ? `${fmtBytes(x.used)}/${fmtBytes(x.total)}` : '[net]';
    return `${x.mount}=${used}`;
  }).join(' ');
}

function applyTermInterval(seconds) {
  clearInterval(_termTelemetryTimer);
  _termTelemetryTimer = null;
  if (!seconds || seconds <= 0) {
    termLog('info', ['telemetry: OFF']);
    return;
  }
  termLog('info', [`telemetry: every ${seconds}s, channels=${Object.entries(_termChannels).filter(([,v]) => v).map(([k]) => k).join(',')}`]);
  // Fire one immediately so the user sees data right away, then on interval.
  gatherTelemetry();
  _termTelemetryTimer = setInterval(gatherTelemetry, seconds * 1000);
}

terminalIntervalEl?.addEventListener('change', async () => {
  const sec = parseInt(terminalIntervalEl.value, 10);
  applyTermInterval(sec);
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalInterval: sec });
});
terminalTfmtEl?.addEventListener('change', async () => {
  _termTimeFmt = terminalTfmtEl.value;
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalTimeFmt: _termTimeFmt });
});
terminalChannelEls.forEach(cb => {
  cb.addEventListener('change', async () => {
    _termChannels[cb.dataset.ch] = cb.checked;
    if (window.dash?.setConfig) await window.dash.setConfig({ terminalChannels: { ..._termChannels } });
  });
});

// ── Webcam preview ──────────────────────────────────────────────────────────
const cameraBtnEl    = document.querySelector('#camera-btn');
const webcamPanelEl  = document.querySelector('#webcam-panel');
const webcamVideoEl  = document.querySelector('#webcam-video');
const webcamCloseEl  = document.querySelector('#webcam-close');
const webcamCycleEl  = document.querySelector('#webcam-cycle');
const webcamLabelEl  = document.querySelector('#webcam-label');
const webcamResizeEl = document.querySelector('#webcam-resize');
const webcamPixelEl  = document.querySelector('#webcam-pixel');

// rAF loop that downsamples the live video into the small canvas. Only runs
// while zen is active AND the webcam panel is open. Sync via syncWebcamPixel.
let _pixelRAF = null;
function startPixelLoop() {
  if (_pixelRAF || !webcamPixelEl || !webcamVideoEl) return;
  const ctx = webcamPixelEl.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const draw = () => {
    if (webcamVideoEl.videoWidth > 0 && webcamVideoEl.videoHeight > 0) {
      ctx.drawImage(webcamVideoEl, 0, 0, webcamPixelEl.width, webcamPixelEl.height);
    }
    _pixelRAF = requestAnimationFrame(draw);
  };
  _pixelRAF = requestAnimationFrame(draw);
}
function stopPixelLoop() {
  if (_pixelRAF) cancelAnimationFrame(_pixelRAF);
  _pixelRAF = null;
}
function syncWebcamPixel() {
  const zen = document.body.classList.contains('is-zen');
  const open = webcamPanelEl && !webcamPanelEl.hidden;
  if (zen && open) startPixelLoop();
  else stopPixelLoop();
}
// Painted random-noise canvas adds true TV-static dropout on top of the
// CSS scanlines + tracking bar. Stops automatically after the transition
// window. _noiseRAF guards against overlapping loops on rapid cycles.
const webcamNoiseEl = document.querySelector('#webcam-noise');
let _noiseRAF = null;
function runNoise(durationMs = 700) {
  if (!webcamNoiseEl || _noiseRAF) return;
  const ctx = webcamNoiseEl.getContext('2d', { willReadFrequently: false });
  if (!ctx) return;
  const w = webcamNoiseEl.width;
  const h = webcamNoiseEl.height;
  const stop = performance.now() + durationMs;
  const step = () => {
    if (performance.now() > stop) { _noiseRAF = null; return; }
    const img = ctx.createImageData(w, h);
    const d = img.data;
    // Pure fine-grain monochrome snow at canvas resolution. 320×240 against
    // ~280×200 panels means each canvas pixel is ~= one screen pixel, so
    // the grain is fine instead of chunky. The CSS layer (.webcam-static)
    // adds the scanlines on top of this.
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 230) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    _noiseRAF = requestAnimationFrame(step);
  };
  _noiseRAF = requestAnimationFrame(step);
}
let _webcamStream = null;
let _cameras = [];           // cached video input device list
let _activeCameraId = null;  // deviceId of the currently streaming camera

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    _cameras = devices.filter(d => d.kind === 'videoinput');
  } catch (err) {
    console.warn('enumerateDevices failed:', err.message);
  }
}

function updateWebcamLabel() {
  if (!webcamLabelEl) return;
  if (!_activeCameraId || !_cameras.length) {
    webcamLabelEl.textContent = 'CAMERA';
    return;
  }
  const idx = _cameras.findIndex(c => c.deviceId === _activeCameraId);
  const cam = idx >= 0 ? _cameras[idx] : null;
  // Labels are only populated after a getUserMedia grant, so fall back to
  // a numeric index until we have the friendly name.
  const name = cam?.label?.trim();
  const tag = `${idx + 1}/${_cameras.length}`;
  webcamLabelEl.textContent = (name ? name : `CAMERA`).toUpperCase().slice(0, 26) + (
    _cameras.length > 1 ? `  ·  ${tag}` : ''
  );
}

async function startWebcam(deviceId = null) {
  // Stop any prior stream cleanly so the camera light goes off in between.
  if (_webcamStream) {
    for (const t of _webcamStream.getTracks()) { try { t.stop(); } catch {} }
    _webcamStream = null;
  }
  try {
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };
    _webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (webcamVideoEl) webcamVideoEl.srcObject = _webcamStream;
    const settings = _webcamStream.getVideoTracks()[0]?.getSettings?.();
    _activeCameraId = deviceId || settings?.deviceId || _activeCameraId;
    await refreshCameraList(); // labels are now usable
    updateWebcamLabel();
    return true;
  } catch (err) {
    console.error('webcam start failed:', err);
    return false;
  }
}

function stopWebcam() {
  if (webcamVideoEl) webcamVideoEl.srcObject = null;
  if (_webcamStream) {
    for (const t of _webcamStream.getTracks()) { try { t.stop(); } catch {} }
    _webcamStream = null;
  }
}

async function cycleCamera() {
  await refreshCameraList();
  if (_cameras.length < 2) return;
  const curIdx = Math.max(0, _cameras.findIndex(c => c.deviceId === _activeCameraId));
  const nextIdx = (curIdx + 1) % _cameras.length;
  const nextId = _cameras[nextIdx].deviceId;
  // VHS transition: scanlines + tracking bar + painted RGB noise + roll
  // for ~700ms while the new stream comes up under it.
  webcamPanelEl?.classList.add('is-switching');
  runNoise(700);
  await startWebcam(nextId);
  setTimeout(() => webcamPanelEl?.classList.remove('is-switching'), 700);
  if (window.dash?.setConfig) await window.dash.setConfig({ webcamDeviceId: nextId });
}

async function setWebcamOpen(on, deviceId = undefined) {
  if (!webcamPanelEl) return;
  cameraBtnEl?.classList.toggle('is-active', !!on);
  if (on) {
    webcamPanelEl.hidden = false;
    const ok = await startWebcam(deviceId);
    if (!ok) {
      webcamPanelEl.hidden = true;
      cameraBtnEl?.classList.remove('is-active');
      return;
    }
  } else {
    webcamPanelEl.hidden = true;
    stopWebcam();
  }
  syncWebcamPixel();
  if (window.dash?.setConfig) await window.dash.setConfig({ webcamOpen: on });
}

cameraBtnEl?.addEventListener('click', async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  await setWebcamOpen(!cfg.webcamOpen, cfg.webcamDeviceId || undefined);
});
webcamCloseEl?.addEventListener('mousedown', (e) => e.stopPropagation());
webcamCloseEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  setWebcamOpen(false);
});
webcamCycleEl?.addEventListener('mousedown', (e) => e.stopPropagation());
webcamCycleEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  cycleCamera();
});

// Drag to move (anywhere on the panel except the resize handle/close button)
webcamPanelEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target === webcamCloseEl || e.target === webcamResizeEl) return;
  e.preventDefault();
  const rect = webcamPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startLeft = rect.left, startTop = rect.top;
  webcamPanelEl.style.left = `${startLeft}px`;
  webcamPanelEl.style.top  = `${startTop}px`;
  webcamPanelEl.style.right = 'auto';
  const onMove = (ev) => {
    webcamPanelEl.style.left = `${startLeft + (ev.clientX - startX)}px`;
    webcamPanelEl.style.top  = `${startTop  + (ev.clientY - startY)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveWebcamGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// Resize from the bottom-right handle
webcamResizeEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = webcamPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startW = rect.width, startH = rect.height;
  const onMove = (ev) => {
    const w = Math.max(160, startW + (ev.clientX - startX));
    const h = Math.max(120, startH + (ev.clientY - startY));
    webcamPanelEl.style.width  = `${w}px`;
    webcamPanelEl.style.height = `${h}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveWebcamGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

async function saveWebcamGeom() {
  if (!webcamPanelEl || !window.dash?.setConfig) return;
  const x = parseInt(webcamPanelEl.style.left, 10);
  const y = parseInt(webcamPanelEl.style.top,  10);
  const w = parseInt(webcamPanelEl.style.width,  10);
  const h = parseInt(webcamPanelEl.style.height, 10);
  const partial = {};
  if (Number.isFinite(x) && Number.isFinite(y)) partial.webcamPos  = { x, y };
  if (Number.isFinite(w) && Number.isFinite(h)) partial.webcamSize = { width: w, height: h };
  if (Object.keys(partial).length) await window.dash.setConfig(partial);
}

// ── Zen idle mode ───────────────────────────────────────────────────────────
// After ZEN_IDLE_MS of no input, slide every tool panel
// off-screen so only the audio meters and background grid remain. Any input
// brings them back. CSS handles the actual motion via `body.is-zen`.
//
// While zen is active, swap to a low-contrast palette + dim filter so the
// remaining audio bars + grid read as a calm screensaver. Snapshot the
// user's previous theme/dim before swapping so we can restore on exit
// without writing to config (so the user's saved theme is preserved).
const ZEN_IDLE_MS = 5 * 60 * 1000; // 5 minutes
const ZEN_CYCLE_MS = 25000;
// Pastel + low-contrast set used as a slow theme rotation while idle.
const ZEN_THEMES = [
  'pastel', 'rose', 'meadow',
  'mint', 'lavender', 'sage',
  'dust', 'slate', 'harbor', 'moss', 'dusk', 'paper', 'storm',
];
let _zenTimer = null;
let _zenCycleTimer = null;
let _zenActive = false;
let _zenPrevTheme = null;
let _zenPrevDim   = false;
let _zenIdx = 0;

// Zen-mode CPU throttle. 85% ceiling keeps real headroom for HEVC/AV1
// decode + GPU compositing of the dimmed overlay; tighter caps cause
// concurrent-video stutter.
const ZEN_POWER_ZEN    = { maxCpu: 85, minCpu: 5 };
const ZEN_POWER_NORMAL = { maxCpu: 90, minCpu: 5 };

function applyZenPower(opts) {
  if (!window.dash?.setPowerProfile) return;
  window.dash.setPowerProfile(opts).then((r) => {
    if (r?.ok) console.log(`power: max=${r.max}% min=${r.min}%`);
    else if (r?.error) console.warn(`power: ${r.error}`);
  }).catch((err) => console.warn('power:', err.message));
}

function enterZen() {
  if (_zenActive) return;
  _zenActive = true;
  _zenPrevTheme = document.documentElement.getAttribute('data-theme') || null;
  _zenPrevDim   = document.body.classList.contains('theme-dim');
  _zenIdx = Math.floor(Math.random() * ZEN_THEMES.length);
  applyTheme(ZEN_THEMES[_zenIdx]);
  applyDim(true);
  applyZenPower(ZEN_POWER_ZEN);
  // Kick off the entry transition; settle into the steady zen state once
  // the fade-through-black completes (CSS-only; see styles.css).
  document.body.classList.add('is-zen-entering');
  setTimeout(() => {
    document.body.classList.remove('is-zen-entering');
    document.body.classList.add('is-zen');
  }, 1100);
  // Audio bars get expanded and stretched wide → upsample from 24 to 96.
  // Drop the gain so the dense bar spectrum reads as a calm visualization.
  // Pause width-adaptive rebuilding so the zen count sticks.
  audioOutViz?.setAdaptiveBars?.(false);
  audioInViz ?.setAdaptiveBars?.(false);
  audioOutViz?.rebuildBars?.(AUDIO_BAR_COUNT_ZEN);
  audioInViz ?.rebuildBars?.(AUDIO_BAR_COUNT_ZEN);
  _audioGainScale = AUDIO_ZEN_GAIN_SCALE;
  syncWebcamPixel();
  // YouTube popout (if open): fullscreen + 95% transparent so it plays
  // behind the zen overlay without dominating it.
  window.dash?.setYoutubeZenMode?.(true);
  // Pause diagnostic-terminal telemetry while in zen — the per-interval
  // PowerShell child-process spawns (disk I/O, temps via LHM, storage)
  // briefly thrash CPU + disk, which is enough to hitch concurrent video
  // playback. Resumes on zen exit at the user's previously-saved interval.
  if (_termTelemetryTimer) {
    clearInterval(_termTelemetryTimer);
    _termTelemetryTimer = null;
  }
  clearInterval(_zenCycleTimer);
  _zenCycleTimer = setInterval(() => {
    _zenIdx = (_zenIdx + 1) % ZEN_THEMES.length;
    applyTheme(ZEN_THEMES[_zenIdx]);
  }, ZEN_CYCLE_MS);
  // Cycle through the 5-day forecast in the corner widget.
  _zenForecastIdx = 0;
  paintZenForecast(0);
  clearInterval(_zenForecastTimer);
  _zenForecastTimer = setInterval(() => {
    if (!_forecastDaily.length) return;
    _zenForecastIdx = (_zenForecastIdx + 1) % _forecastDaily.length;
    paintZenForecast(_zenForecastIdx);
  }, ZEN_FORECAST_CYCLE_MS);
}

function leaveZen() {
  if (!_zenActive) return;
  _zenActive = false;
  clearInterval(_zenCycleTimer);
  _zenCycleTimer = null;
  // Reverse the fade-through-black on exit (CSS-only).
  document.body.classList.remove('is-zen');
  document.body.classList.add('is-zen-leaving');
  setTimeout(() => {
    document.body.classList.remove('is-zen-leaving');
  }, 950);
  applyTheme(_zenPrevTheme);
  applyDim(_zenPrevDim);
  applyZenPower(ZEN_POWER_NORMAL);
  audioOutViz?.rebuildBars?.(AUDIO_BAR_COUNT_NORMAL);
  audioInViz ?.rebuildBars?.(AUDIO_BAR_COUNT_NORMAL);
  // Re-enable width-adaptive rebuilding now that we're back to normal mode.
  audioOutViz?.setAdaptiveBars?.(true);
  audioInViz ?.setAdaptiveBars?.(true);
  _audioGainScale = 1.0;
  clearInterval(_zenForecastTimer);
  _zenForecastTimer = null;
  _zenForecastIdx = 0;
  syncWebcamPixel();
  window.dash?.setYoutubeZenMode?.(false);
  // Resume telemetry polling at the user's saved cadence.
  const sec = parseInt(terminalIntervalEl?.value, 10);
  if (Number.isFinite(sec) && sec > 0) applyTermInterval(sec);
}

// When the user clicks the zen button, the same click bubbles up to the
// global input listeners that would normally exit zen — so we suppress the
// arm/leave path for a short window around the button click.
let _zenForceArming = false;

function armZenTimer() {
  if (_zenForceArming) return;
  if (_zenActive) leaveZen();
  clearTimeout(_zenTimer);
  _zenTimer = setTimeout(enterZen, ZEN_IDLE_MS);
}
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'touchmove']
  .forEach(ev => window.addEventListener(ev, armZenTimer, { passive: true }));
armZenTimer();

// The YouTube popout can request a zen exit (its Esc handler routes here
// when the dashboard is in zen). Re-arm so the idle timer doesn't
// immediately tip back into zen.
window.dash?.onForceLeaveZen?.(() => {
  if (_zenActive) {
    leaveZen();
    armZenTimer();
  }
});

const zenBtnEl = document.querySelector('#zen-btn');
zenBtnEl?.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  _zenForceArming = true; // suppress leaveZen on the bubbling mousedown
});
zenBtnEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  clearTimeout(_zenTimer);
  enterZen();
  // Re-enable the normal arm/exit behavior after this click cycle settles
  // so the user can leave zen by moving the mouse / typing.
  setTimeout(() => { _zenForceArming = false; }, 250);
});
