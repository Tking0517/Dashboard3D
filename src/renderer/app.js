import './styles.css';

// Bumped on every theme change. Canvas renderers (audio bars, sparklines)
// cache CSS-variable lookups + LinearGradient objects keyed by this version
// so they don't call getComputedStyle on every frame. Declared at module
// top so factory functions defined further down (createAudioVisualizer)
// can read it during their init render() pass without hitting the TDZ.
let _themeVersion = 0;

// Single knob for how often the data-driven panels re-poll their
// sources. Applied to refreshSystem, netLoop, diskLoop, mute-state
// poll, and the diag overlay tick. Intentionally NOT applied to:
//   - tickClock (1s — would visibly stutter at 5s)
//   - refreshTemps / refreshStorage (already match or exceed this)
//   - weather (already 10 min)
//   - audio bars (real-time visualization; runs at ~15–23 Hz)
const UI_REFRESH_MS = 5000;

// Background diagnostics overlay counters. Hoisted so the audio
// visualizer's renderToTarget can bump the draw counter without
// reaching into the diag block's closure. Reset every second by the
// telemetry tick.
let _diagDrawCalls = 0;
let _diagFrames    = 0;
let _diagFps       = 0;
let _diagDrawPerS  = 0;
const _appStartTs  = Date.now();

// Tracks whether the combo panel is showing the visualizer pane. The audio
// factory's render() reads this to skip mirror-canvas painting when no one
// is looking — saves a full second draw pass at every audio sample tick.
// Updated by setComboMode().
let _comboInVisualizer = false;

// When the UI is locked, panel drag, panel resize, audio-grid drag/resize,
// and topbar reorder all bail at mousedown. Toggled by #lock-ui-btn,
// persisted under config.uiLocked, restored on load.
let _uiLocked = false;

// ── UI sound effects ────────────────────────────────────────────────────────
// Synthesized via Web Audio so we don't bundle any asset files. The context
// is created lazily on the first user gesture (Chromium suspends fresh
// AudioContexts otherwise) and reused across calls. `playSfx(kind)` dispatches
// to a small bank of short envelopes keyed by interaction type.
let _sfxCtx = null;
let _sfxEnabled = true;
function _sfxGetCtx() {
  if (!_sfxCtx) {
    try { _sfxCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { _sfxCtx = null; }
  }
  if (_sfxCtx?.state === 'suspended') _sfxCtx.resume?.();
  return _sfxCtx;
}
function playSfx(kind) {
  if (!_sfxEnabled) return;
  const ctx = _sfxGetCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain).connect(ctx.destination);
  switch (kind) {
    case 'click':   // generic button — quick high chirp
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(660, t + 0.04);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.stop(t + 0.07); break;
    case 'tab':     // tab / mode switch — single triangle tick
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1320, t);
      gain.gain.setValueAtTime(0.035, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.stop(t + 0.06); break;
    case 'delete':  // destructive — descending sawtooth bleep
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.18);
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.stop(t + 0.24); break;
    case 'confirm': // success — ascending two-step sine
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.exponentialRampToValueAtTime(990, t + 0.1);
      gain.gain.setValueAtTime(0.045, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.stop(t + 0.16); break;
    case 'error':   // failure — low square buzz
      osc.type = 'square';
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.linearRampToValueAtTime(180, t + 0.15);
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.stop(t + 0.22); break;
    default:
      osc.type = 'square';
      osc.frequency.setValueAtTime(660, t);
      gain.gain.setValueAtTime(0.04, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.stop(t + 0.06);
  }
  osc.start(t);
}
function setSfxEnabled(on) {
  _sfxEnabled = !!on;
  document.querySelector('#sfx-btn')?.classList.toggle('is-muted', !_sfxEnabled);
}

// Document-level delegate: any click on a recognized control plays a click
// or delete bleep. We map by class so adding a new button (with the right
// class) gets the SFX automatically. Delete-class controls win over click
// when both apply.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  // Anything that's a "destructive" surface gets the delete bleep.
  if (t.closest('.note-tab-close, [data-explore-delete], #close-btn, .chat-clear')) {
    playSfx('delete');
    return;
  }
  // Tabs / mode switches — softer tick.
  if (t.closest('.combo-mode-tab, .explore-tab, .note-tab')) {
    playSfx('tab');
    return;
  }
  // Generic buttons.
  if (t.closest('.topbar-btn, .explore-action, .panel-collapse-btn, .audio-mute-btn, .audio-gain-btn, .chat-send, .paper-tool-btn')) {
    playSfx('click');
  }
}, true);

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

// Alt-zone 2 was removed from the clock panel; refs kept null so any
// downstream code that may still reference them falls through cleanly.
const alt2TimeEl    = null;
const alt2AmpmEl    = null;
const alt2NameEl    = null;
const alt2TzEl      = null;
const alt2CityInput = null;

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

  // Alt-zone 2 removed; skip its tick.
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

// applyAltLocation2 / alt2 city handler — removed along with the
// alt-zone-2 row. Boot config code below also skips cfg.altCity2.

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
setInterval(() => { if (!document.hidden) refreshSystem(); }, UI_REFRESH_MS);

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
setInterval(() => { if (!document.hidden) refreshStorage(); }, 30_000);

// ── HUD: Transfers (active downloads + file transfers) ────────────────────────
const transfersListEl   = document.querySelector('#transfers-list');
const transfersCountEl  = document.querySelector('#transfers-count');
const transfersStatusEl = document.querySelector('#transfers-status');

function fmtBitsPerSec(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/S';
  return `${fmtBytes(bytesPerSec)}/S`.toUpperCase();
}

async function refreshTransfers() {
  if (!window.dash?.transfersInfo || !transfersListEl) return;
  try {
    const list = await window.dash.transfersInfo();
    if (!list || list.length === 0) {
      transfersListEl.innerHTML = '<div class="storage-empty transfers-empty">NO ACTIVE TRANSFERS</div>';
      transfersCountEl.textContent = '0';
      transfersStatusEl.textContent = 'IDLE';
      transfersStatusEl.className = 'footer-readout';
      return;
    }
    transfersCountEl.textContent = String(list.length).padStart(2, '0');
    transfersListEl.innerHTML = '';
    let totalSpeed = 0;
    for (const t of list) {
      totalSpeed += Number(t.speed) || 0;
      const knownTotal = t.progress != null && t.total > 0;
      const pct  = knownTotal ? Math.round(t.progress * 100) : null;
      const sizeStr = knownTotal
        ? `${fmtBytes(t.size)} / ${fmtBytes(t.total)}`
        : fmtBytes(t.size);
      const speedStr = fmtBitsPerSec(t.speed);
      const tagHtml = t.isPartial
        ? ` <em class="amber">${escapeText((t.source || '').toUpperCase())}</em>`
        : ` <em>${escapeText((t.source || '').toUpperCase())}</em>`;
      const fillCls = knownTotal ? 'seg-bar-fill seg-transfer' : 'seg-bar-fill seg-transfer indeterminate';
      const fillStyle = knownTotal ? `width:${pct}%` : '';
      const pctHtml = knownTotal ? `<strong>${pct}%</strong> ` : '';
      const row = document.createElement('div');
      row.className = 'transfer-row';
      row.innerHTML = `
        <div class="transfer-row-head">
          <span class="transfer-name" title="${escapeText(t.name)}">&#9656; ${escapeText(t.name)}${tagHtml}</span>
          <span class="transfer-vals">${pctHtml}${sizeStr} <span class="speed">${speedStr}</span></span>
        </div>
        <div class="seg-bar"><div class="${fillCls}" style="${fillStyle}"></div></div>
      `;
      transfersListEl.appendChild(row);
    }
    transfersStatusEl.innerHTML = `<em>RATE</em> <strong class="accent">${fmtBitsPerSec(totalSpeed)}</strong>`;
    transfersStatusEl.className = 'footer-readout';
  } catch (err) {
    transfersListEl.innerHTML = `<div class="storage-empty">ERROR: ${escapeText(err.message)}</div>`;
    transfersStatusEl.textContent = 'ERR';
    transfersStatusEl.className = 'footer-readout red';
  }
}

refreshTransfers();
setInterval(() => { if (!document.hidden) refreshTransfers(); }, 4000);

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
setInterval(() => { if (!document.hidden) refreshTemps(); }, 5000);

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
  if (!document.hidden) await refreshNet();
  setTimeout(netLoop, UI_REFRESH_MS);
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

// Disk I/O polling — chained scheduling so the PowerShell call (which
// has ~500 ms cold start) can't overlap itself.
async function diskLoop() {
  if (!document.hidden) await refreshDisk();
  setTimeout(diskLoop, UI_REFRESH_MS);
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
// Audio visualizers share the panel min-size constants so drag, resize,
// and snap-to-grid behave identically across .panel and .audio-grid.
// Previously the audio grids had their own (much smaller) 100×40 mins
// and started at a fixed 320×72, which meant they never lined up with
// the column widths under side-arrange. Kept as literals (not a reference
// to PANEL_MIN_W/H) because those are declared further down the file and
// the audio-init runs at module load — referencing them here would TDZ.
const AUDIO_MIN_W = 280; // == PANEL_MIN_W
const AUDIO_MIN_H = 120; // == PANEL_MIN_H
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
// Global visualizer redraw cadence (milliseconds between sampler ticks).
// Driven by the single topbar Hz control — the per-panel ▲/▼ arrows are
// gone. Persisted under cfg.audioFrameMs. Range 5 ms (200 Hz) – 100 ms
// (10 Hz) so the topbar arrows can step in 5 Hz increments across the
// full 10-200 Hz range.
let AUDIO_FRAME_MS = 100;
const AUDIO_FRAME_MS_MIN = 5;     // 200 Hz
const AUDIO_FRAME_MS_MAX = 100;   // 10 Hz
function setAudioFrameMs(ms) {
  const clamped = Math.max(AUDIO_FRAME_MS_MIN, Math.min(AUDIO_FRAME_MS_MAX, Math.round(ms)));
  AUDIO_FRAME_MS = clamped;
  // Update the topbar Hz readout. Step is 5 Hz so we display whole Hz
  // values without decimals.
  const hz = Math.round(1000 / clamped);
  const hzValueEl = document.getElementById('hz-value');
  if (hzValueEl) hzValueEl.textContent = `${hz} Hz`;
  if (window.dash?.setConfig) window.dash.setConfig({ audioFrameMs: clamped });
  return clamped;
}
// Step the rate by ±5 Hz. Clamped to [10, 200] Hz.
function stepHz(deltaHz) {
  const cur = Math.round(1000 / AUDIO_FRAME_MS);
  // Snap to the nearest multiple of 5 first so steps don't drift.
  const snapped = Math.round(cur / 5) * 5;
  const next = Math.max(10, Math.min(200, snapped + deltaHz));
  setAudioFrameMs(1000 / next);
}
// Initial display before any user interaction.
setAudioFrameMs(AUDIO_FRAME_MS);
// Per-bar fill decay. Snap up on rises; fall by this many percent per
// frame on drops so the bar gracefully tails off instead of flickering.
// Unchanged from the 23 Hz tuning — at 10 Hz this yields a slightly
// slower per-second decay (40/s vs 92/s) which actually reads as a
// more graceful fall.
const AUDIO_DECAY_PER_FRAME = 4;
// Peak-hold: independent floating marker that snaps to the highest recent
// fill, holds for HOLD frames, then falls slowly. Scaled so hold stays
// ~500 ms regardless of AUDIO_FRAME_MS — 5 frames * 100 ms.
const AUDIO_PEAK_HOLD_FRAMES = 5;
const AUDIO_PEAK_DECAY_PER_FRAME = 3.3;

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
  // Auto-normalizer: the largest band in any incoming frame becomes the
  // 100% reference. Decays slowly toward AGC_FLOOR during quiet passages
  // so silence still draws as silence (no noise amplification), but loud
  // content that *exceeds* the prior peak instantly raises the ceiling.
  // Net effect — bar tops graze 100 on the loudest band and everything
  // else compresses below it, instead of music constantly slamming to
  // 100 across every band.
  const AGC_FLOOR = 25;     // never scale below this — keeps silent → silent
  const AGC_DECAY = 0.995;  // ~98.5% retained per second at 60 fps
  let agcPeak = AGC_FLOOR;
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
  // Theme-color cache (audio/amber/red CSS vars). Invalidated by
  // _themeVersion bump. Resolved colors get reused across both the
  // source and mirror canvases without re-reading getComputedStyle.
  let _audioColor = '', _amberColor = '', _redColor = '', _mutedColor = '';
  let _brightRgb = [0, 200, 255], _dimRgb = [0, 60, 76];
  function _parseHex(hex) {
    if (!hex) return null;
    let h = hex.trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
    return [parseInt(h.substr(0,2),16), parseInt(h.substr(2,2),16), parseInt(h.substr(4,2),16)];
  }
  function refreshThemeColorsIfNeeded() {
    if (_gradTheme === _themeVersion && _audioColor) return;
    const cs = getComputedStyle(barsRowEl || document.documentElement);
    _audioColor = cs.getPropertyValue('--audio-color').trim() || '#5fa';
    _amberColor = cs.getPropertyValue('--amber').trim()       || '#f3a83b';
    _redColor   = cs.getPropertyValue('--red').trim()         || '#ff3b30';
    _mutedColor = cs.getPropertyValue('--muted').trim()       || '#6e8aa3';
    // Pre-compute bright + dim RGB triplets for the per-segment lerp so we
    // don't parse hex inside the render loop. Dim = 25% of bright channels
    // (mixed toward black) — preserves hue, just drops the value.
    const rgb = _parseHex(_audioColor) || [80, 200, 255];
    _brightRgb = rgb;
    _dimRgb = [Math.round(rgb[0] * 0.25), Math.round(rgb[1] * 0.25), Math.round(rgb[2] * 0.25)];
    _gradTheme = _themeVersion;
    _peakColor = _audioColor;
  }
  function makeGradient(targetCtx, h) {
    const g = targetCtx.createLinearGradient(0, h, 0, 0); // bottom → top
    g.addColorStop(0.00, _audioColor);
    g.addColorStop(0.55, _audioColor);
    g.addColorStop(0.62, _amberColor);
    g.addColorStop(0.78, _amberColor);
    g.addColorStop(0.90, _redColor);
    g.addColorStop(1.00, _redColor);
    return g;
  }
  // Mirror canvases — opt-in clones that draw the same bars whenever the
  // source renders. Used by the VISUALIZER pane to show the speakers
  // graph in a much larger area when no video is playing. The mirror's
  // bar count tracks the source so visuals stay consistent.
  const _mirrors = new Set();
  function _sizeMirror(m) {
    const dpr = window.devicePixelRatio || 1;
    const r = m.canvas.getBoundingClientRect();
    const tw = Math.round(r.width  * dpr);
    const th = Math.round(r.height * dpr);
    if (m.canvas.width !== tw || m.canvas.height !== th) {
      m.canvas.width = tw;
      m.canvas.height = th;
      m.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  function addMirror(canvasEl) {
    if (!canvasEl) return () => {};
    const m = { canvas: canvasEl, ctx: canvasEl.getContext('2d') };
    _mirrors.add(m);
    return () => _mirrors.delete(m);
  }
  function renderToTarget(targetCanvas, targetCtx) {
    if (!targetCanvas || !targetCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = targetCanvas.width  / dpr;
    const H = targetCanvas.height / dpr;
    targetCtx.clearRect(0, 0, W, H);
    if (barCount <= 0 || W <= 0 || H <= 0) return;
    _diagDrawCalls++;
    // Segmented EQ style: each bar is a vertical stack of small horizontal
    // cells rising from a baseline near the bottom of the canvas. Below the
    // baseline a faded copy of the lowest cells reads as a glass-floor
    // reflection. A floating bright cell marks the held peak above the
    // live stack — coloured with --red for a hot magenta-ish accent.
    // Reserve a small strip on the left for the 0–100 amplitude scale so
    // the eye gets a fixed reference for what the bars are tracking. The
    // strip width scales with canvas size; on tiny panels we still leave
    // room for at least the 0/100 endpoints.
    const fontSize = Math.max(8, Math.min(11, Math.floor(H / 28)));
    // Wide enough for a 3-digit tick label ("100") in the tech-mono
    // font even on the smallest panels — was 18, which clipped "100"
    // off the left edge on narrow viz canvases.
    const scaleW   = Math.max(26, Math.min(36, Math.round(W * 0.06)));
    const stripX   = scaleW;
    const usableW  = W - scaleW;
    const gap = 1;
    const barW = Math.max(1, (usableW - gap * (barCount - 1)) / barCount);
    const baselineY = H * 0.78;          // bars rise upward from here
    const usableH   = baselineY;
    const reflectH  = H - baselineY;
    const segments  = Math.max(6, Math.min(30, Math.floor(usableH / 4)));
    const segPitch  = usableH / segments;
    const cellH     = Math.max(1, segPitch * 0.55);
    const cellGapY  = segPitch - cellH;
    const reflectSegMax = Math.max(1, Math.floor(reflectH / segPitch));

    // Two-colour lerp: bottom cells are dim audio-colour, top cells are the
    // bright audio colour. Same hue throughout the stack, just darker at
    // the floor and hotter as the bar climbs.
    const colors = new Array(segments);
    for (let s = 0; s < segments; s++) {
      const t = s / Math.max(1, segments - 1);
      const r = Math.round(_dimRgb[0] * (1 - t) + _brightRgb[0] * t);
      const g = Math.round(_dimRgb[1] * (1 - t) + _brightRgb[1] * t);
      const b = Math.round(_dimRgb[2] * (1 - t) + _brightRgb[2] * t);
      colors[s] = `rgb(${r},${g},${b})`;
    }

    for (let i = 0; i < barCount; i++) {
      const dist = barCount > 1 ? Math.abs(i / (barCount - 1) - 0.5) * 2 : 0;
      const scale = 1 + dist * 0.20;  // gentle smile
      const value = (displayed[i] / 100) * scale;
      const cellsLit = Math.min(segments, Math.ceil(value * segments));
      const x = stripX + i * (barW + gap);

      // Live stack — cells rise from baselineY upward.
      for (let s = 0; s < cellsLit; s++) {
        targetCtx.fillStyle = colors[s];
        const y = baselineY - (s + 1) * segPitch + cellGapY;
        targetCtx.fillRect(x, y, barW, cellH);
      }

      // Reflection — same cells mirrored under the baseline, faded to
      // a thin glass-floor look. Capped so we only draw the cells that
      // fit in the reflection band.
      const reflectN = Math.min(cellsLit, reflectSegMax);
      if (reflectN > 0) {
        targetCtx.globalAlpha = 0.22;
        for (let s = 0; s < reflectN; s++) {
          targetCtx.fillStyle = colors[s];
          const y = baselineY + s * segPitch;
          targetCtx.fillRect(x, y, barW, cellH);
        }
        targetCtx.globalAlpha = 1;
      }
    }

    // Floating peak markers — bright cell at the peaks[i] position
    // (above the live stack since peaks decay slower than the fill).
    // Coloured --red so transients pop against the audio-colour stack.
    targetCtx.fillStyle = _redColor;
    for (let i = 0; i < barCount; i++) {
      const dist = barCount > 1 ? Math.abs(i / (barCount - 1) - 0.5) * 2 : 0;
      const scale = 1 + dist * 0.20;
      const peakValue = (peaks[i] / 100) * scale;
      const peakSeg = Math.min(segments, Math.ceil(peakValue * segments));
      if (peakSeg <= 0) continue;
      const x = stripX + i * (barW + gap);
      const y = baselineY - peakSeg * segPitch + cellGapY;
      targetCtx.fillRect(x, y, barW, cellH);
    }

    // Soft baseline glow line — sits at the join between live stack and
    // reflection so the "floor" of the EQ has a subtle horizon.
    targetCtx.fillStyle = _audioColor;
    targetCtx.globalAlpha = 0.18;
    targetCtx.fillRect(0, baselineY - 1.5, W, 3);
    targetCtx.globalAlpha = 1;

    // Side scale — 0/25/50/75/100 amplitude ticks on the left strip.
    // Tiny canvases (e.g. compact bottom panels) drop to just 0/100 so
    // the labels stay legible. Y positions are clamped so the topmost
    // label (100) doesn't get its top half clipped against the canvas
    // edge — `textBaseline: 'middle'` puts half the glyph above y, so
    // we need at least fontSize/2 of padding from y=0.
    const ticks = usableH < 90 ? [0, 100] : [0, 25, 50, 75, 100];
    targetCtx.font = `${fontSize}px var(--font-tech), 'Share Tech Mono', monospace`;
    targetCtx.fillStyle = _mutedColor;
    targetCtx.textAlign = 'right';
    targetCtx.textBaseline = 'middle';
    const padTop = Math.ceil(fontSize / 2) + 1;
    for (const v of ticks) {
      const rawY = baselineY - (v / 100) * usableH;
      const y    = Math.max(padTop, Math.min(H - padTop, rawY));
      targetCtx.fillText(String(v), scaleW - 4, y);
      targetCtx.fillRect(scaleW - 3, y - 0.5, 3, 1);
    }
  }
  function render() {
    refreshThemeColorsIfNeeded();
    renderToTarget(canvas, ctx);
    if (_comboInVisualizer && _mirrors.size > 0) {
      for (const m of _mirrors) {
        _sizeMirror(m);
        renderToTarget(m.canvas, m.ctx);
      }
    }
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
      // Pre-AGC clamp at 250 (not 100) so the renderer's AGC has real
      // dynamic range to scale from — clamping at 100 here would make
      // loud speech read as a flat ceiling.
      out[b] = Math.min(250, lifted * AUDIO_MIC_GAIN);
    }
    setBands(out);
  }

  // Squeeze incoming bands so the loudest band in the current frame
  // (after slow decay of past peaks) lands at exactly 100. Quiet
  // content scales relative to that ceiling instead of slamming into it.
  function agcNormalize(bands) {
    let frameMax = 0;
    for (let i = 0; i < bands.length; i++) {
      const v = Number.isFinite(bands[i]) ? bands[i] : 0;
      if (v > frameMax) frameMax = v;
    }
    agcPeak = Math.max(agcPeak * AGC_DECAY, frameMax, AGC_FLOOR);
    const k = 100 / agcPeak;
    const norm = new Array(bands.length);
    for (let i = 0; i < bands.length; i++) {
      const v = Number.isFinite(bands[i]) ? bands[i] : 0;
      norm[i] = Math.min(100, v * k);
    }
    return norm;
  }

  // Frequency-band push — used by the loopback visualizer (each bar = a
  // log-spaced FFT band). When the visible bar count exceeds the input band
  // count (e.g. zen mode with 96 bars vs 24 bands), linearly interpolate so
  // the bars look like a smooth-ish spectrum instead of repeating in groups.
  function setBands(bands) {
    if (!barCount || !bands) return;
    const src = agcNormalize(bands);
    const n = barCount;
    const m = src.length;
    const g = _audioGainScale * userGain;
    for (let i = 0; i < n; i++) {
      let target;
      if (n === m) {
        target = src[i];
      } else {
        const f  = (i / Math.max(1, n - 1)) * (m - 1);
        const lo = Math.floor(f);
        const hi = Math.min(m - 1, lo + 1);
        const t  = f - lo;
        target = src[lo] * (1 - t) + src[hi] * t;
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
    if (_uiLocked) return;
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
      if (_uiLocked) return;
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
        // Absolute-edge snap (matches the panel resize). Snapping the
        // delta keeps any off-grid grid off-grid forever; snapping the
        // moved edge pulls it onto the lattice so audio grids and
        // panels re-converge to the same snap lines after any drag.
        const rawDx = ev.clientX - startX;
        const rawDy = ev.clientY - startY;
        const startRight  = startLeft + startW;
        const startBottom = startTop  + startH;
        const g = ev.altKey ? null : getGridSize();
        let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;
        if (grows.e) {
          const edge = g ? snap(startRight + rawDx, g.w) : (startRight + rawDx);
          newW = edge - startLeft;
        }
        if (grows.w) {
          newLeft = g ? snap(startLeft + rawDx, g.w) : (startLeft + rawDx);
          newW = startRight - newLeft;
        }
        if (grows.s) {
          const edge = g ? snap(startBottom + rawDy, g.h) : (startBottom + rawDy);
          newH = edge - startTop;
        }
        if (grows.n) {
          newTop = g ? snap(startTop + rawDy, g.h) : (startTop + rawDy);
          newH = startBottom - newTop;
        }
        if (newW < AUDIO_MIN_W) {
          if (grows.w) newLeft = startRight - AUDIO_MIN_W;
          newW = AUDIO_MIN_W;
        }
        if (newH < AUDIO_MIN_H) {
          if (grows.n) newTop = startBottom - AUDIO_MIN_H;
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

  // Per-panel ▲/▼ Hz arrows removed; rate is now driven by the single
  // topbar #hz-control (see stepHz / setAudioFrameMs below).

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
  return { sample, setBands, setMuted, applyMuteUi, isMuted, setAnalyserAndTrack, setLabelOnly, getLabel, applySavedGeom, applySavedGain, rebuildBars, setAdaptiveBars, setPartner, setSize, addMirror, getBarCount: () => barCount };
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
// Last render timestamp for the loopback viz — used to throttle the
// worker's ~23 Hz IPC push down to AUDIO_FRAME_MS so the ▲/▼ arrows
// actually control the displayed rate.
let _lastOutRenderMs = 0;
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
    // Throttle the render path to AUDIO_FRAME_MS so the ▲/▼ arrows
    // actually control the output viz refresh rate. The worker keeps
    // emitting at its own ~23 Hz; we just drop the inter-frame ones.
    if (Array.isArray(data?.bands)) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - _lastOutRenderMs >= AUDIO_FRAME_MS) {
        _lastOutRenderMs = now;
        audioOutViz.setBands(data.bands);
      }
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
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
      await populateMicDeviceList();
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

// Audio sampler loop. AUDIO_FRAME_MS controls the visualizer redraw
// cadence — currently 100 ms (10 Hz). Worker still produces FFT bands
// at ~23 Hz; we just sample the latest at each tick. Lower the rate to
// trade visual smoothness for renderer CPU.
function drawAudioFrame() {
  audioInViz.sample();
  audioOutViz.sample();
  setTimeout(drawAudioFrame, AUDIO_FRAME_MS);
}
startAudioWaves();

// Keep the dashboard mute buttons in sync with the OS endpoint state.
// Volume keyboard keys auto-unmute on Windows, and the user can also
// toggle from the volume mixer or other apps — without polling, our
// button would lie about the device's actual state.
if (window.dash?.getMuteStates) {
  setInterval(async () => {
    if (document.hidden) return;
    let st;
    try { st = await window.dash.getMuteStates(); } catch { return; }
    if (!st?.ok) return;
    if (typeof st.out === 'boolean' && audioOutViz.isMuted() !== st.out) audioOutViz.applyMuteUi(st.out);
    if (typeof st.in  === 'boolean' && audioInViz .isMuted() !== st.in ) audioInViz .applyMuteUi(st.in );
  }, UI_REFRESH_MS);
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
  // Mirror the active tab to docs/notes/<safe-name>.txt so the EXPLORE
  // pane (and Explorer) sees a real file. Use the same auto-derived title
  // that's shown on the tab UI (manual name → first line of body → NOTE N)
  // so untitled notes don't all collide into one file. Also: when the
  // first line changes, the file gets a new name — track the previous
  // filename on the tab so we can delete the orphan instead of leaving
  // a stale copy behind on every rename.
  if (tab && window.dash?.docsWrite) {
    const idx = notesState.tabs.indexOf(tab);
    const display = tabDisplayName(tab, idx >= 0 ? idx : 0);
    const safe = display.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'note';
    const rel = `notes/${safe}.txt`;
    const prev = tab._lastNoteFile;
    if (prev && prev !== rel && window.dash?.docsPath && window.dash?.exploreDelete) {
      try {
        const root = await window.dash.docsPath();
        if (root) await window.dash.exploreDelete(`${root}/${prev}`);
      } catch {}
    }
    try { await window.dash.docsWrite(rel, tab.body || ''); tab._lastNoteFile = rel; } catch {}
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
  // Flush the debounced save immediately so the file on disk shows up
  // with its first-line title the moment the user finishes a line.
  scheduleNoteSave();
  saveNotesNow();
});

function initNotes(cfg) {
  const saved = cfg?.notes;
  if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
    notesState = {
      active: saved.active,
      tabs: saved.tabs.map(t => ({
        id: t.id || newTabId(),
        // Empty name means "auto-generate from first line" (see
        // tabDisplayName). Older configs stamped the literal placeholder
        // 'NOTE' / 'NOTES' as the default, which made every tab read as
        // manually-named and froze the title — treat those as empty so
        // the auto-naming kicks back in on load.
        name: (() => {
          const n = (t.name || '').trim();
          return (n && n !== 'NOTE' && n !== 'NOTES' ? n : '').slice(0, TAB_NAME_MAX);
        })(),
        body: typeof t.body === 'string' ? t.body : '',
      })),
    };
    if (!notesState.tabs.find(t => t.id === notesState.active)) {
      notesState.active = notesState.tabs[0].id;
    }
  } else {
    const id = newTabId();
    notesState = { active: id, tabs: [{ id, name: '', body: '' }] };
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

function makeResizeHandle(panel, key, dir /* 'nw'|'ne'|'sw'|'se' corners, or 'n'|'s'|'e'|'w' edges */) {
  const handle = document.createElement('div');
  handle.className = `resize-handle resize-handle-${dir}`;
  handle.title = 'Drag to resize · Ctrl+Shift+R to reset';
  panel.appendChild(handle);

  // .includes works for both 2-char corners ('nw') and 1-char edges ('w'),
  // so an edge handle grows along a single axis while corners grow along
  // two axes — same downstream math.
  const grows = {
    n: dir.includes('n'),
    s: dir.includes('s'),
    w: dir.includes('w'),
    e: dir.includes('e'),
  };

  handle.addEventListener('mousedown', (e) => {
    // PRODUCTIVITY (panel-combo) is exempt from the lock — see attachDrag.
    if (_uiLocked && !panel.classList.contains('panel-combo')) return;
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
      // Snap the *absolute* edge position to the grid, not the cursor
      // delta. Delta-snap (the old behaviour) keeps a panel off-grid if
      // it starts off-grid, so two panels can never re-align without a
      // full reset — exactly the "never get realigned" symptom users hit.
      // By snapping the moved edge to an absolute grid line we converge:
      // every resize pulls the edge onto the lattice, so panels and
      // audio grids all end up sharing the same snap points. Alt bypasses.
      const rawDx = ev.clientX - startX;
      const rawDy = ev.clientY - startY;
      const startRight  = startLeft + startW;
      const startBottom = startTop  + startH;
      const g = ev.altKey ? null : getGridSize();
      let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;

      if (grows.e) {
        const target = startRight + rawDx;
        const edge = g ? snap(target, g.w) : target;
        newW = edge - startLeft;
      }
      if (grows.w) {
        const target = startLeft + rawDx;
        newLeft = g ? snap(target, g.w) : target;
        newW = startRight - newLeft;
      }
      if (grows.s) {
        const target = startBottom + rawDy;
        const edge = g ? snap(target, g.h) : target;
        newH = edge - startTop;
      }
      if (grows.n) {
        const target = startTop + rawDy;
        newTop = g ? snap(target, g.h) : target;
        newH = startBottom - newTop;
      }

      if (newW < PANEL_MIN_W) {
        if (grows.w) newLeft = startRight - PANEL_MIN_W;
        newW = PANEL_MIN_W;
      }
      if (newH < PANEL_MIN_H) {
        if (grows.n) newTop = startBottom - PANEL_MIN_H;
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

// Snap-to-grid. Returns the cell size that matches the visible
// background grid (see .bg-grid in styles.css) so dragged + resized
// panels land on the same lines the user can see. The fine grid in the
// background renders at 40px, the major every 200px, and tick dots
// every 80px — snapping at 40 puts every snap point on a visible line.
// Previously this divided the viewport width/height by 40 and used the
// resulting fractional cell, which only matched the bg-grid by luck and
// produced off-by-one drift on most resolutions.
const SNAP_CELL = 40;
function getGridSize() {
  return { w: SNAP_CELL, h: SNAP_CELL };
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
    // The lock-UI button skips the combo (PRODUCTIVITY) panel — it's
    // always free to drag/resize so the user can still move it around
    // while everything else is pinned in place.
    if (_uiLocked && !panel.classList.contains('panel-combo')) return;

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
  // The productivity combo panel also gets left + right edge handles so
  // the user can grab either side and resize horizontally — the corner
  // hit boxes alone (14×14) are easy to miss next to the header chrome.
  if (panel.classList.contains('panel-combo')) {
    makeResizeHandle(panel, key, 'e');
    makeResizeHandle(panel, key, 'w');
  }
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

  // Screen-fill ("heavy" focus): fixed overlay covering nearly the
  // whole viewport with a dim backdrop behind it AND the dashboard
  // pinned always-on-top so the panel stays visible above every other
  // app. For deep focus on one pane.
  const screenBtn = document.createElement('button');
  screenBtn.className = 'panel-collapse-btn panel-fold-btn panel-fold-btn-screen';
  screenBtn.type = 'button';
  screenBtn.title = 'Focus mode (always-on-top, dim backdrop)';
  screenBtn.textContent = '⛶';

  // Light focus: same geometry as screen mode, but no dim backdrop and
  // no always-on-top — the rest of the dashboard stays visible and
  // interactive. A gentler "spread out this pane" mode.
  const lightBtn = document.createElement('button');
  lightBtn.className = 'panel-collapse-btn panel-fold-btn panel-fold-btn-light';
  lightBtn.type = 'button';
  lightBtn.title = 'Light focus (no dim, not always-on-top)';
  lightBtn.textContent = '▢';

  // Walk every visible non-combo panel and audio grid, classify each as
  // "left column" (center to the left of viewport center) or "right
  // column", and record the rightmost-right-edge / leftmost-left-edge.
  // The combo panel's fold geometry is pinned between those edges plus
  // a small gap so half/full/collapse never overlap any side panel.
  function _updateComboFoldBounds() {
    const vw = window.innerWidth;
    const cx = vw / 2;
    let leftMax  = 0;
    let rightMin = vw;
    // Include both .panel siblings and .audio-grid floats so audio
    // visualizers at the bottom corners are respected too.
    document.querySelectorAll('.panel:not(.panel-combo), .audio-grid').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const center = (r.left + r.right) / 2;
      if (center < cx) leftMax  = Math.max(leftMax,  r.right);
      else             rightMin = Math.min(rightMin, r.left);
    });
    const GAP = 12;
    // Topbar lives at top: 6px with its own height; query its rect so
    // the panel sits below the bar even if the bar's contents grow.
    const topbar = document.querySelector('.topbar-controls');
    const topbarBottom = topbar ? topbar.getBoundingClientRect().bottom : 60;
    panel.style.setProperty('--combo-fold-top',   `${Math.round(topbarBottom + GAP)}px`);
    panel.style.setProperty('--combo-fold-left',  `${Math.round(leftMax + GAP)}px`);
    panel.style.setProperty('--combo-fold-right', `${Math.round(vw - rightMin + GAP)}px`);
  }

  function applyFold(mode) {
    panel.classList.remove('is-fold-half', 'is-fold-full', 'is-fold-screen', 'is-fold-light', 'is-collapsed');
    halfBtn.classList.toggle('is-active',   mode === 'half');
    fullBtn.classList.toggle('is-active',   mode === 'full');
    screenBtn.classList.toggle('is-active', mode === 'screen');
    lightBtn.classList.toggle('is-active',  mode === 'light');
    document.body.classList.toggle('is-combo-fold-full',   mode === 'full' || mode === 'screen');
    document.body.classList.toggle('is-combo-fold-screen', mode === 'screen');
    document.body.classList.toggle('is-combo-fold-light',  mode === 'light');
    try { window.dash?.setAlwaysOnTop?.(mode === 'screen'); } catch {}
    panel.style.removeProperty('--fold-top');
    panel.style.removeProperty('--fold-left');
    panel.style.removeProperty('--fold-width');
    if (!mode) return;
    if (mode === 'screen') { panel.classList.add('is-fold-screen'); return; }
    if (mode === 'light')  { panel.classList.add('is-fold-light');  return; }
    // Half / full / collapse modes: re-measure side panels before
    // applying the class so the fold uses fresh geometry every time.
    _updateComboFoldBounds();
    if (mode === 'half')   { panel.classList.add('is-fold-half');   return; }
    if (mode === 'full')   { panel.classList.add('is-fold-full');   return; }
  }
  // Re-measure on window resize so a viewport change doesn't leave the
  // panel hanging at the old offsets (only applies while a fold is on).
  window.addEventListener('resize', () => {
    if (panel.classList.contains('is-fold-half') ||
        panel.classList.contains('is-fold-full') ||
        panel.classList.contains('is-collapsed')) {
      _updateComboFoldBounds();
    }
  });

  halfBtn.addEventListener('mousedown',   (e) => e.stopPropagation());
  fullBtn.addEventListener('mousedown',   (e) => e.stopPropagation());
  screenBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  lightBtn.addEventListener('mousedown',  (e) => e.stopPropagation());
  halfBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-half') ? null : 'half');
  });
  fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-full') ? null : 'full');
  });
  screenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-screen') ? null : 'screen');
  });
  lightBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-light') ? null : 'light');
  });

  // Group all five controls (collapse + half + full + screen + light)
  // in a single flex wrapper so they hug the right edge of the header
  // instead of being separated by the grid's auto columns.
  const group = document.createElement('span');
  group.className = 'panel-fold-group';
  if (collapseBtn) group.appendChild(collapseBtn);
  group.appendChild(halfBtn);
  group.appendChild(fullBtn);
  group.appendChild(screenBtn);
  group.appendChild(lightBtn);
  header.appendChild(group);

  // Existing collapse chevron must clear any fold state so the three modes
  // are mutually exclusive. Also re-measure side-panel bounds so the
  // collapsed header sits in the centered gap, not at its grid column.
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      if (panel.classList.contains('is-collapsed')) {
        applyFold(null);
        panel.classList.add('is-collapsed');
        _updateComboFoldBounds();
      } else {
        _updateComboFoldBounds();
      }
    });
  }

  // Re-pin geometry on viewport resize while a fold is active (the column
  // width can change when the dashboard window is resized). Screen mode
  // is pinned to viewport edges by CSS so it doesn't need re-pinning.
  window.addEventListener('resize', () => {
    if (panel.classList.contains('is-fold-half'))   { applyFold('half'); return; }
    if (panel.classList.contains('is-fold-full'))   { applyFold('full'); return; }
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
  const explorePane     = comboPanel.querySelector('.combo-pane-explore');
  const visualizerPane  = comboPanel.querySelector('.combo-pane-visualizer');
  const browserPane     = comboPanel.querySelector('.combo-pane-browser');
  const tasksPane       = comboPanel.querySelector('.combo-pane-tasks');

  function paintComboHeader() {
    const mode = comboPanel.dataset.mode || 'notes';
    // Parent name stays "PRODUCTIVITY" across every mode — the active
    // sub-mode is reflected in the em-chip (N1/X1/P1/W1/E1/V1) and in the
    // code slot below the title (NOTES · SCRATCHPAD, etc).
    if (mode === 'notes') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>N1</em>';
      codeEl.textContent = 'NOTES · SCRATCHPAD';
      tagEl.textContent = notesTabCount?.textContent || '—';
      footerLabelEl.textContent = 'NOTES STATUS';
    } else if (mode === 'paper') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>P1</em>';
      codeEl.textContent = 'PAPER · WORD PROCESSOR';
      tagEl.textContent = paperStatsEl?.textContent || '—';
      footerLabelEl.textContent = 'PAPER STATUS';
    } else if (mode === 'explore') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>E1</em>';
      codeEl.textContent = 'EXPLORE · GALLERY · DOCS';
      tagEl.textContent = '—';
      footerLabelEl.textContent = 'EXPLORE STATUS';
    } else if (mode === 'visualizer') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>V1</em>';
      codeEl.textContent = 'VISUALIZER · MEDIA PLAYER';
      tagEl.textContent = '—';
      footerLabelEl.textContent = 'PLAYBACK';
    } else if (mode === 'browser') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>B1</em>';
      codeEl.textContent = 'BROWSER · PRIVATE';
      tagEl.textContent = _browserState?.tabs?.length ? `${_browserState.tabs.length} TAB${_browserState.tabs.length === 1 ? '' : 'S'}` : '—';
      footerLabelEl.textContent = 'BROWSER URL';
    } else if (mode === 'tasks') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>T1</em>';
      codeEl.textContent = 'TASKS · PROCESS MONITOR';
      tagEl.textContent = window._tasksState?.procCount != null
        ? `${window._tasksState.procCount} PROC`
        : '—';
      footerLabelEl.textContent = 'TASK STATUS';
    } else {
      titleEl.innerHTML = 'PRODUCTIVITY <em>X1</em>';
      const provider = document.getElementById('chat-provider')?.value;
      codeEl.textContent = `CHAT · ${provider === 'azure' ? 'AZURE' : 'OLLAMA'}`;
      tagEl.textContent = chatTagSrc?.textContent || '—';
      footerLabelEl.textContent = 'CHAT STATUS';
    }
  }

  function setComboMode(mode, persist = true) {
    const VALID = new Set(['notes', 'chat', 'paper', 'explore', 'visualizer', 'browser', 'tasks']);
    if (!VALID.has(mode)) mode = 'notes';
    comboPanel.dataset.mode = mode;
    notesPane     ?.classList.toggle('is-visible', mode === 'notes');
    chatPane      ?.classList.toggle('is-visible', mode === 'chat');
    paperPane     ?.classList.toggle('is-visible', mode === 'paper');
    explorePane   ?.classList.toggle('is-visible', mode === 'explore');
    visualizerPane?.classList.toggle('is-visible', mode === 'visualizer');
    browserPane   ?.classList.toggle('is-visible', mode === 'browser');
    tasksPane     ?.classList.toggle('is-visible', mode === 'tasks');
    comboPanel.querySelectorAll('.combo-mode-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
    _comboInVisualizer = (mode === 'visualizer');
    paintComboHeader();
    if (mode === 'explore')    refreshExplore();
    if (mode === 'visualizer') refreshVisualizer();
    if (mode === 'browser')    initBrowserOnce();
    if (mode === 'tasks')      refreshTasksNow();
    // BROWSER pane tracks attach/detach state so BrowserView gets
    // detached from the host window when the user leaves the tab.
    if (window._browserState) {
      const wasBrowser = window._browserState.inBrowserMode;
      window._browserState.inBrowserMode = (mode === 'browser');
      if (mode === 'browser') {
        try { window._browserApplyStageMode?.(); } catch {}
      } else if (wasBrowser) {
        try { window.dash?.browserTabActivate?.(null); } catch {}
      }
    }
    if (persist && window.dash?.setConfig) window.dash.setConfig({ comboMode: mode });
  }

  comboPanel.querySelectorAll('.combo-mode-tab').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't drag-grab
    btn.addEventListener('click', () => setComboMode(btn.dataset.mode));
  });

  // ── Reorderable combo-mode tabs ────────────────────────────────
  // Native HTML5 drag inside .combo-mode-tabs. Same pattern as the
  // topbar reorder + CREATE preset reorder: setDragImage centred on
  // the cursor, a dim-while-dragging class added one frame after
  // dragstart (so the ghost keeps full opacity), drop position
  // computed by sibling midpoint. Order persists as cfg.comboModeOrder
  // (array of data-mode strings) and re-applies on load.
  const comboTabsEl = comboPanel.querySelector('.combo-mode-tabs');
  if (comboTabsEl) {
    const tabsList = () => Array.from(comboTabsEl.querySelectorAll('.combo-mode-tab'));
    for (const btn of tabsList()) btn.draggable = true;
    let _modeDragged = null;
    let _modeDragMoved = false;
    comboTabsEl.addEventListener('dragstart', (e) => {
      const t = e.target.closest?.('.combo-mode-tab');
      if (!t || t.parentElement !== comboTabsEl) return;
      _modeDragged = t;
      _modeDragMoved = false;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        const r = t.getBoundingClientRect();
        try { e.dataTransfer.setDragImage(t, r.width / 2, r.height / 2); } catch {}
      }
      requestAnimationFrame(() => t.classList.add('is-mode-dragging'));
    });
    comboTabsEl.addEventListener('dragover', (e) => {
      if (!_modeDragged) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const x = e.clientX;
      const sibs = tabsList().filter((c) => c !== _modeDragged);
      let before = null;
      for (const el of sibs) {
        const r = el.getBoundingClientRect();
        if (x < r.left + r.width / 2) { before = el; break; }
      }
      if (before && _modeDragged.nextElementSibling !== before) {
        comboTabsEl.insertBefore(_modeDragged, before);
        _modeDragMoved = true;
      } else if (!before && _modeDragged !== comboTabsEl.lastElementChild) {
        comboTabsEl.appendChild(_modeDragged);
        _modeDragMoved = true;
      }
    });
    comboTabsEl.addEventListener('dragend', async () => {
      if (_modeDragged) _modeDragged.classList.remove('is-mode-dragging');
      _modeDragged = null;
      if (_modeDragMoved && window.dash?.setConfig) {
        const order = tabsList().map((b) => b.dataset.mode);
        try { await window.dash.setConfig({ comboModeOrder: order }); } catch {}
      }
    });
    // Restore saved order on load. Any mode not present in the saved
    // list (added in a later build) stays in its HTML position at the
    // end so new features don't disappear after an update.
    (async () => {
      const cfg = (await window.dash?.getConfig?.()) || {};
      const order = cfg.comboModeOrder;
      if (!Array.isArray(order) || !order.length) return;
      const byMode = Object.fromEntries(tabsList().map((b) => [b.dataset.mode, b]));
      const seen = new Set();
      for (const mode of order) {
        const btn = byMode[mode];
        if (!btn) continue;
        comboTabsEl.appendChild(btn);
        seen.add(mode);
      }
      for (const btn of tabsList()) {
        if (!seen.has(btn.dataset.mode)) comboTabsEl.appendChild(btn);
      }
    })();
  }

  // Keep the visible tag/code chip in sync with whichever mode is active —
  // the underlying notes/chat code keeps writing to the original hidden IDs.
  if (notesTabCount) new MutationObserver(paintComboHeader).observe(notesTabCount, { childList: true, characterData: true, subtree: true });
  if (chatTagSrc)    new MutationObserver(paintComboHeader).observe(chatTagSrc,    { childList: true, characterData: true, subtree: true });
  if (paperStatsEl)  new MutationObserver(paintComboHeader).observe(paperStatsEl,  { childList: true, characterData: true, subtree: true });
  document.getElementById('chat-provider')?.addEventListener('change', paintComboHeader);

  // EXPLORE pane tab strip — flips the visible section between gallery
  // and docs. Persists under config.exploreTab so the same view is
  // restored next launch.
  function setExploreTab(which, persist = true) {
    if (which !== 'gallery' && which !== 'docs' && which !== 'downloads') which = 'gallery';
    if (!explorePane) return;
    explorePane.dataset.exploreTab = which;
    explorePane.querySelectorAll('.explore-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.exploreTabBtn === which);
    });
    if (persist && window.dash?.setConfig) window.dash.setConfig({ exploreTab: which });
  }
  explorePane?.querySelectorAll('.explore-tab').forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    btn.addEventListener('click', () => setExploreTab(btn.dataset.exploreTabBtn));
  });

  // EXPLORE pane — in-panel mini-Explorer for the gallery + docs roots.
  // Each section tracks its own current subdir + selected row. Click a
  // row to select; double-click a folder to navigate into it; double-click
  // a file to open in the OS default app. F2 renames, Del → trash. The
  // ＋ button creates a folder in the current view; ↑ goes up one level.
  const exploreGalleryListEl   = document.getElementById('explore-gallery-list');
  const exploreDocsListEl      = document.getElementById('explore-docs-list');
  const exploreDownloadsListEl = document.getElementById('explore-downloads-list');
  const exploreGalleryPathEl   = document.getElementById('explore-gallery-path');
  const exploreDocsPathEl      = document.getElementById('explore-docs-path');
  const exploreDownloadsPathEl = document.getElementById('explore-downloads-path');
  // Per-section lookups — adding a new managed root (downloads/) only
  // needs entries here plus an IPC bridge in preload + main, instead of
  // updating every which==='gallery'?a:b ternary in the file.
  const _exploreListEls = {
    gallery:   exploreGalleryListEl,
    docs:      exploreDocsListEl,
    downloads: exploreDownloadsListEl,
  };
  const _explorePathEls = {
    gallery:   exploreGalleryPathEl,
    docs:      exploreDocsPathEl,
    downloads: exploreDownloadsPathEl,
  };
  const _exploreSubdir   = { gallery: '', docs: '', downloads: '' };
  // Multi-select state: a Set of absolute paths per section, plus an
  // anchor row for shift-click range selection. Anchor is the row that
  // last received a non-shift click.
  const _exploreSelected = { gallery: new Set(), docs: new Set(), downloads: new Set() };
  const _exploreAnchor   = { gallery: null, docs: null, downloads: null };
  const _exploreEntries  = { gallery: [], docs: [], downloads: [] };
  const _exploreRoots    = { gallery: '',  docs: '',  downloads: '' };

  function fmtFileTime(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: '2-digit' });
  }

  // Image extensions Chromium can render via <img>. TIFF / PSD aren't in
  // the native set so they render as a styled "PSD"/"TIF" placeholder tile
  // until / unless we add a thumbnail extractor in main.
  const _IMG_RENDER_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
  const _IMG_KNOWN_RE  = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|psd|heic|heif|raw|cr2|nef|arw)$/i;
  // Video extensions. The first regex is what Chromium can play in a
  // <video> tag (H.264/AAC mp4, vp8/9/av1 webm, etc.). The second
  // catches anything we still want to keep OUT of the gallery thumb
  // view and route to the VISUALIZER tab — the player will show an
  // "unsupported codec" message when it can't decode them.
  const _VIDEO_RENDER_RE = /\.(mp4|webm|m4v|ogv|ogg|mov)$/i;
  const _VIDEO_KNOWN_RE  = /\.(mp4|webm|m4v|ogv|ogg|mov|avi|mkv|wmv|flv|3gp|3g2|asf)$/i;

  function renderExploreList(which, result) {
    const listEl = _exploreListEls[which];
    if (!listEl) return;
    listEl.classList.toggle('is-thumbnails', which === 'gallery');
    listEl.innerHTML = '';
    if (!result || result.error) {
      listEl.innerHTML = `<li class="explore-empty">${(result?.error || 'NOT FOUND').toUpperCase()}</li>`;
      return;
    }
    const entries = result.entries || [];
    if (!entries.length) {
      listEl.innerHTML = '<li class="explore-empty">EMPTY · DROP FILES INTO THE FOLDER</li>';
      return;
    }
    // Gallery hides video files — those route to the VISUALIZER tab so
    // the thumbnail grid stays image-only. Folders and non-video files
    // pass through unchanged.
    const filteredEntries = which === 'gallery'
      ? entries.filter((e) => e.isDir || !_VIDEO_KNOWN_RE.test(e.name))
      : entries;
    // Capture the ordered entry list for shift-click range selection.
    _exploreEntries[which] = filteredEntries;
    const selSet = _exploreSelected[which];
    const isGallery = which === 'gallery';
    for (const e of filteredEntries) {
      const row = document.createElement('li');
      const isSel = selSet.has(e.path);
      row.className = 'explore-row' + (e.isDir ? ' is-dir' : '') + (isSel ? ' is-selected' : '');
      row.dataset.path  = e.path;
      row.dataset.isDir = String(e.isDir);
      row.dataset.name  = e.name;
      row.dataset.which = which;
      row.title = e.path;
      if (isGallery) {
        const preview = document.createElement('div');
        preview.className = 'explore-thumb-preview';
        const ext = (e.name.match(/\.([^.]+)$/) || [])[1]?.toUpperCase() || '';
        if (e.isDir) {
          preview.innerHTML = '<span class="explore-thumb-icon">▣</span>';
        } else if (_IMG_RENDER_RE.test(e.name)) {
          // Real preview via the dash3d-file:// scheme (registered in
          // main). URL shape is `dash3d-file://<root>/<rel>` — `<root>`
          // is the host segment (gallery|docs) so URL parsers don't try
          // to interpret a Windows drive-letter colon as host:port.
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.alt = '';
          img.src = `dash3d-file://${which}/${encodeURI(e.rel)}`;
          img.addEventListener('error', () => {
            preview.innerHTML = `<span class="explore-thumb-ext">${ext || 'IMG'}</span>`;
          });
          preview.appendChild(img);
        } else if (_IMG_KNOWN_RE.test(e.name)) {
          // TIFF / PSD / RAW: known image but Chromium can't decode it.
          preview.innerHTML = `<span class="explore-thumb-ext">${ext}</span>`;
        } else {
          preview.innerHTML = '<span class="explore-thumb-icon">▤</span>';
        }
        const name = document.createElement('span');
        name.className = 'explore-row-name';
        name.textContent = e.name;
        row.appendChild(preview);
        row.appendChild(name);
      } else {
        row.innerHTML =
          `<span class="explore-row-name">${e.name.replace(/</g, '&lt;')}</span>` +
          `<span class="explore-row-size">${e.isDir ? '—' : fmtBytes(e.size)}</span>` +
          `<span class="explore-row-time">${fmtFileTime(e.mtime)}</span>`;
      }
      listEl.appendChild(row);
    }
  }

  function exploreDisplayPath(which) {
    const root = _exploreRoots[which] || '';
    const sub = _exploreSubdir[which] || '';
    const pathEl = _explorePathEls[which];
    if (!pathEl) return;
    pathEl.textContent = sub ? `${root}/${sub}`.replace(/\\/g, '/') : root;
  }

  // IPC list bridges keyed by section — add an entry per managed root.
  const _exploreListBridges = {
    gallery:   () => window.dash?.galleryList,
    docs:      () => window.dash?.docsList,
    downloads: () => window.dash?.downloadsList,
  };
  async function refreshExploreSection(which) {
    if (!window.dash) return;
    const list = _exploreListBridges[which]?.();
    const result = await list?.(_exploreSubdir[which]) ?? null;
    if (result?.root) _exploreRoots[which] = result.root;
    exploreDisplayPath(which);
    renderExploreList(which, result);
  }

  async function refreshExplore() {
    await Promise.all([
      refreshExploreSection('gallery'),
      refreshExploreSection('docs'),
      refreshExploreSection('downloads'),
    ]);
  }

  function applyExploreSelection(which) {
    const listEl = _exploreListEls[which];
    const set = _exploreSelected[which];
    listEl?.querySelectorAll('.explore-row').forEach((r) => {
      r.classList.toggle('is-selected', set.has(r.dataset.path));
    });
  }
  function _selectOnly(which, abs) {
    _exploreSelected[which] = new Set(abs ? [abs] : []);
    _exploreAnchor[which] = abs || null;
    applyExploreSelection(which);
  }
  function _toggleSelected(which, abs) {
    const s = _exploreSelected[which];
    if (s.has(abs)) s.delete(abs); else s.add(abs);
    _exploreAnchor[which] = abs;
    applyExploreSelection(which);
  }
  function _selectRange(which, fromAbs, toAbs) {
    const entries = _exploreEntries[which];
    const fi = entries.findIndex((e) => e.path === fromAbs);
    const ti = entries.findIndex((e) => e.path === toAbs);
    if (fi < 0 || ti < 0) return _selectOnly(which, toAbs);
    const [a, b] = fi <= ti ? [fi, ti] : [ti, fi];
    const next = new Set();
    for (let i = a; i <= b; i++) next.add(entries[i].path);
    _exploreSelected[which] = next;
    applyExploreSelection(which);
  }
  function _clearSelection(which) {
    _exploreSelected[which].clear();
    _exploreAnchor[which] = null;
    applyExploreSelection(which);
  }

  function navigateInto(which, relSegment) {
    const cur = _exploreSubdir[which] || '';
    _exploreSubdir[which] = cur ? `${cur}/${relSegment}` : relSegment;
    _clearSelection(which);
    refreshExploreSection(which);
  }

  function navigateUp(which) {
    const cur = _exploreSubdir[which] || '';
    if (!cur) return;
    const parts = cur.split('/').filter(Boolean);
    parts.pop();
    _exploreSubdir[which] = parts.join('/');
    _clearSelection(which);
    refreshExploreSection(which);
  }

  function handleExploreRowClick(e) {
    const row = e.target.closest('.explore-row');
    if (!row) return;
    const which = row.dataset.which;
    const abs   = row.dataset.path;
    if (e.shiftKey && _exploreAnchor[which]) {
      _selectRange(which, _exploreAnchor[which], abs);
    } else if (e.ctrlKey || e.metaKey) {
      _toggleSelected(which, abs);
    } else {
      _selectOnly(which, abs);
    }
  }

  function handleExploreRowDblClick(e) {
    const row = e.target.closest('.explore-row');
    if (!row) return;
    const which = row.dataset.which;
    const isDir = row.dataset.isDir === 'true';
    const name  = row.dataset.name;
    const abs   = row.dataset.path;
    if (isDir) {
      navigateInto(which, name);
      return;
    }
    // Gallery images: open the in-app fullscreen viewer (a frameless,
    // always-on-top BrowserWindow created by main). For non-image files
    // and anything in docs, fall back to the OS default app.
    if (which === 'gallery' && _IMG_RENDER_RE.test(name) && window.dash?.openImageViewer) {
      window.dash.openImageViewer(abs).catch(() => {
        window.dash?.shellOpenPath?.(abs).catch(() => {});
      });
    } else {
      window.dash?.shellOpenPath?.(abs).catch(() => {});
    }
  }

  // Inline new-folder row — prepends a placeholder row with an input to
  // the top of the list. Enter calls exploreMkdir; Esc / empty-blur drops
  // the row. We use this pattern instead of window.prompt() because
  // Electron's renderer returns null from prompt() by default (no host
  // dialog handler), which silently swallowed clicks before.
  function startNewFolder(which) {
    const listEl = _exploreListEls[which];
    if (!listEl) return;
    // Drop any existing placeholder so successive clicks don't stack rows.
    listEl.querySelector('.explore-row.is-creating')?.remove();
    // If the list is empty (showing "EMPTY · DROP FILES …"), clear that
    // hint while we add the input row.
    const empty = listEl.querySelector('.explore-empty');
    if (empty) empty.remove();
    const row = document.createElement('li');
    row.className = 'explore-row is-dir is-creating';
    row.innerHTML =
      `<input type="text" class="explore-row-rename" placeholder="new folder">` +
      `<span class="explore-row-size">—</span>` +
      `<span class="explore-row-time">—</span>`;
    listEl.prepend(row);
    const input = row.querySelector('.explore-row-rename');
    input.focus();
    let done = false;
    const finish = async (commit) => {
      if (done) return; done = true;
      const name = input.value.trim();
      row.remove();
      if (!commit || !name) { refreshExploreSection(which); return; }
      const sub = _exploreSubdir[which] || '';
      const rel = sub ? `${sub}/${name}` : name;
      const r = await window.dash?.exploreMkdir?.(which, rel);
      if (!r?.ok) console.warn('[explore] mkdir failed:', r?.error);
      refreshExploreSection(which);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }

  // Inline rename — replaces the row's name span with a text input. Enter
  // commits, Esc cancels, blur commits. Filenames with path separators
  // are rejected by main and surface as an error log.
  function startRename(row) {
    if (!row) return;
    const nameEl = row.querySelector('.explore-row-name');
    if (!nameEl || nameEl.dataset.editing === 'true') return;
    const oldName = row.dataset.name;
    const oldAbs  = row.dataset.path;
    const which   = row.dataset.which;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'explore-row-rename';
    input.value = oldName;
    nameEl.dataset.editing = 'true';
    nameEl.replaceWith(input);
    input.focus();
    // Select the basename minus extension so common rename = retype name.
    const dot = oldName.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : oldName.length);
    let done = false;
    const commit = async (cancel) => {
      if (done) return; done = true;
      const next = input.value.trim();
      const restoreSpan = () => {
        const span = document.createElement('span');
        span.className = 'explore-row-name';
        span.textContent = next || oldName;
        input.replaceWith(span);
      };
      if (cancel || !next || next === oldName) { restoreSpan(); refreshExploreSection(which); return; }
      const r = await window.dash?.exploreRename?.(oldAbs, next);
      if (!r?.ok) console.warn('[explore] rename failed:', r?.error);
      restoreSpan();
      refreshExploreSection(which);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(false); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(true); }
    });
    input.addEventListener('blur', () => commit(false));
    input.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }

  function handleExploreKeydown(ev) {
    // Only react when EXPLORE is the active combo mode (so typing in the
    // chat / notes editors keeps working). Pick whichever section has a
    // non-empty selection when the event isn't otherwise scoped.
    if (comboPanel?.dataset.mode !== 'explore') return;
    const w = _exploreSelected.gallery.size ? 'gallery'
            : _exploreSelected.docs.size    ? 'docs'
            : null;
    if (!w) return;
    const sel = [..._exploreSelected[w]];
    if (ev.key === 'F2') {
      if (sel.length !== 1) return;
      ev.preventDefault();
      const listEl = _exploreListEls[w];
      const row = listEl?.querySelector(`.explore-row[data-path="${CSS.escape(sel[0])}"]`);
      startRename(row);
    } else if (ev.key === 'Delete') {
      ev.preventDefault();
      deleteSelectedAll(w);
    } else if (ev.key === 'Backspace' && ev.altKey) {
      ev.preventDefault();
      navigateUp(w);
    } else if (ev.key === ' ') {
      // Spacebar — fullscreen view. One image → single-image viewer; many
      // → contact-sheet grid window. Folders / non-images are skipped.
      ev.preventDefault();
      const imgs = sel.filter((p) => _IMG_RENDER_RE.test(p));
      if (imgs.length === 1 && window.dash?.openImageViewer) {
        window.dash.openImageViewer(imgs[0]).catch(() => {});
      } else if (imgs.length > 1 && window.dash?.openContactSheet) {
        window.dash.openContactSheet(imgs).catch(() => {});
      }
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
      ev.preventDefault();
      const next = new Set(_exploreEntries[w].map((e) => e.path));
      _exploreSelected[w] = next;
      applyExploreSelection(w);
    }
  }

  // Multi-aware delete: trash every selected entry. Uses the same
  // shell.trashItem path as the single-row delete so items are
  // recoverable from the OS Recycle Bin.
  async function deleteSelectedAll(which) {
    const paths = [..._exploreSelected[which]];
    if (!paths.length) return;
    for (const abs of paths) {
      try {
        const r = await window.dash?.exploreDelete?.(abs);
        if (!r?.ok) console.warn('[explore] delete failed:', abs, r?.error);
      } catch {}
    }
    _exploreSelected[which].clear();
    _exploreAnchor[which] = null;
    refreshExploreSection(which);
  }
  // Copy selected paths to the OS clipboard as Windows file objects so
  // they can be pasted into Explorer / Photos / etc.
  async function copySelectedAll(which) {
    const paths = [..._exploreSelected[which]];
    if (!paths.length || !window.dash?.clipboardCopyFiles) return;
    const r = await window.dash.clipboardCopyFiles(paths);
    if (!r?.ok) console.warn('[explore] copy failed:', r?.error);
  }

  // Double-click on the name span specifically to start a rename even
  // without pre-selecting (matches Explorer-on-Windows behavior).
  function handleNameDblClick(ev) {
    if (!ev.target.classList?.contains('explore-row-name')) return;
    if (!ev.altKey) return; // Alt+dbl-click renames; plain dbl-click navigates/opens
    ev.preventDefault();
    const row = ev.target.closest('.explore-row');
    startRename(row);
  }

  // Right-click context menu — COPY (CF_HDROP via PowerShell Set-Clipboard)
  // and DELETE (Recycle Bin). Floats next to the cursor; auto-dismisses on
  // any outside click or escape. If the right-clicked row isn't already in
  // the selection, switch the selection to just that row first so the
  // menu actions match the visual selection.
  let _exploreCtxMenu = null;
  function hideExploreCtxMenu() {
    _exploreCtxMenu?.remove();
    _exploreCtxMenu = null;
  }
  function showExploreCtxMenu(x, y, which) {
    hideExploreCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'explore-context-menu';
    menu.innerHTML =
      '<button type="button" class="explore-context-item" data-action="copy">COPY</button>' +
      '<button type="button" class="explore-context-item" data-action="delete">DELETE</button>';
    document.body.appendChild(menu);
    // Clamp to viewport edges so the menu doesn't render off-screen.
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth  - r.width  - 4);
    const py = Math.min(y, window.innerHeight - r.height - 4);
    menu.style.left = `${px}px`;
    menu.style.top  = `${py}px`;
    _exploreCtxMenu = menu;
    menu.addEventListener('click', (ev) => {
      const a = ev.target?.dataset?.action;
      if (a === 'copy')   copySelectedAll(which);
      if (a === 'delete') deleteSelectedAll(which);
      hideExploreCtxMenu();
    });
    menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }
  function handleExploreContextMenu(ev) {
    const row = ev.target.closest('.explore-row');
    if (!row) return;
    ev.preventDefault();
    const which = row.dataset.which;
    if (!_exploreSelected[which].has(row.dataset.path)) {
      _selectOnly(which, row.dataset.path);
    }
    showExploreCtxMenu(ev.clientX, ev.clientY, which);
  }
  document.addEventListener('mousedown', (ev) => {
    if (_exploreCtxMenu && !_exploreCtxMenu.contains(ev.target)) hideExploreCtxMenu();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _exploreCtxMenu) hideExploreCtxMenu();
  });

  for (const listEl of Object.values(_exploreListEls)) {
    if (!listEl) continue;
    listEl.addEventListener('click',       handleExploreRowClick);
    listEl.addEventListener('dblclick',    handleExploreRowDblClick);
    listEl.addEventListener('dblclick',    handleNameDblClick);
    listEl.addEventListener('contextmenu', handleExploreContextMenu);
  }
  document.addEventListener('keydown', handleExploreKeydown);

  function bindExploreActionButtons(attr, handler) {
    explorePane?.querySelectorAll(`[${attr}]`).forEach((btn) => {
      btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
      btn.addEventListener('click', () => handler(btn.getAttribute(attr)));
    });
  }
  bindExploreActionButtons('data-explore-refresh', (which) => refreshExploreSection(which));
  bindExploreActionButtons('data-explore-up',      (which) => navigateUp(which));
  bindExploreActionButtons('data-explore-mkdir',   (which) => startNewFolder(which));

  // Header delete button — multi-aware; trashes everything in the
  // selection set. Discoverable equivalent of the Del key.
  bindExploreActionButtons('data-explore-delete', (which) => deleteSelectedAll(which));
  // Same shape as _exploreListBridges — IPC bridges for root-path lookup.
  const _explorePathBridges = {
    gallery:   () => window.dash?.galleryPath,
    docs:      () => window.dash?.docsPath,
    downloads: () => window.dash?.downloadsPath,
  };
  bindExploreActionButtons('data-explore-open', async (which) => {
    const pathFn = _explorePathBridges[which]?.();
    const root = await pathFn?.();
    const sub = _exploreSubdir[which] || '';
    const target = sub ? `${root}\\${sub.replace(/\//g, '\\')}` : root;
    if (target) window.dash?.shellOpenPath?.(target).catch(() => {});
  });

  // ── Visualizer (video player) ───────────────────────────────────────
  // Pulls video files (recursively-ish via the same `gallery-list` IPC,
  // currently flat) from the gallery folder and lets the user pick one to
  // play in an inline <video>. Audio visualization comes for free from the
  // dashboard's existing system-loopback bars — anything playing here
  // routes through Windows audio and shows up in the OUTPUT bars panel.
  const visualizerListEl = document.getElementById('visualizer-list');
  const visualizerVideoEl = document.getElementById('visualizer-video');
  const visualizerWrapEl = visualizerPane?.querySelector('.visualizer-player-wrap');
  const visualizerNowEl = document.getElementById('visualizer-now');
  const visualizerAudioCanvas = document.getElementById('visualizer-audio-canvas');
  let _visualizerEntries = [];
  let _visualizerCurrent = null;
  // Clone the system-output bars onto the visualizer pane's idle canvas
  // so it acts as a "speakers graph" when no video is loaded. The mirror
  // hides automatically once a video plays (CSS `.is-playing`).
  if (visualizerAudioCanvas && audioOutViz?.addMirror) {
    audioOutViz.addMirror(visualizerAudioCanvas);
  }

  function renderVisualizerList(entries) {
    if (!visualizerListEl) return;
    visualizerListEl.innerHTML = '';
    if (!entries.length) {
      visualizerListEl.innerHTML = '<li class="explore-empty">NO VIDEOS · DROP MP4/WEBM/MOV INTO THE GALLERY FOLDER</li>';
      return;
    }
    for (const e of entries) {
      const row = document.createElement('li');
      row.className = 'visualizer-row' + (_visualizerCurrent === e.path ? ' is-playing' : '');
      row.dataset.path = e.path;
      row.dataset.rel  = e.rel;
      row.title = e.path;
      row.innerHTML =
        `<span class="visualizer-row-name">${e.name.replace(/</g, '&lt;')}</span>` +
        `<span class="visualizer-row-size">${fmtBytes(e.size)}</span>` +
        `<span class="visualizer-row-time">${fmtFileTime(e.mtime)}</span>`;
      visualizerListEl.appendChild(row);
    }
  }

  async function refreshVisualizer() {
    if (!window.dash?.galleryList) return;
    const result = await window.dash.galleryList();
    const entries = (result?.entries || []).filter((e) => !e.isDir && _VIDEO_KNOWN_RE.test(e.name));
    _visualizerEntries = entries;
    renderVisualizerList(entries);
  }

  function playVisualizerEntry(entry) {
    if (!visualizerVideoEl || !entry) return;
    if (!_VIDEO_RENDER_RE.test(entry.name)) {
      // Codec the browser can't decode — fall back to the OS default app.
      window.dash?.shellOpenPath?.(entry.path).catch(() => {});
      return;
    }
    _visualizerCurrent = entry.path;
    const url = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
    visualizerVideoEl.src = url;
    visualizerVideoEl.play().catch(() => {});
    visualizerWrapEl?.classList.add('is-playing');
    if (visualizerNowEl) visualizerNowEl.textContent = entry.name;
    // Repaint list to highlight the now-playing row.
    renderVisualizerList(_visualizerEntries);
  }

  // ── Transport controls ──────────────────────────────────────────────
  function togglePlayPause() {
    if (!visualizerVideoEl) return;
    // Nothing loaded — try playing the first entry as a convenience so
    // the play button still does something useful from a cold pane.
    if (!visualizerVideoEl.currentSrc) {
      const first = _visualizerEntries[0];
      if (first) playVisualizerEntry(first);
      return;
    }
    if (visualizerVideoEl.paused) visualizerVideoEl.play().catch(() => {});
    else visualizerVideoEl.pause();
  }
  function playRelative(step) {
    if (!_visualizerEntries.length) return;
    const idx = _visualizerEntries.findIndex((e) => e.path === _visualizerCurrent);
    let nextIdx;
    if (idx < 0) {
      nextIdx = step > 0 ? 0 : _visualizerEntries.length - 1;
    } else {
      nextIdx = (idx + step + _visualizerEntries.length) % _visualizerEntries.length;
    }
    playVisualizerEntry(_visualizerEntries[nextIdx]);
  }
  function updatePlayPauseIcon() {
    const btn = document.getElementById('visualizer-playpause-btn');
    if (!btn) return;
    const playing = visualizerVideoEl && !visualizerVideoEl.paused && !!visualizerVideoEl.currentSrc;
    // Toggle visibility on the two embedded SVGs (.vis-play-icon /
    // .vis-pause-icon). currentColor is bound to the parent button's
    // `color`, so they pick up the theme automatically.
    const playIcon  = btn.querySelector('.vis-play-icon');
    const pauseIcon = btn.querySelector('.vis-pause-icon');
    if (playIcon)  playIcon.hidden  = !!playing;
    if (pauseIcon) pauseIcon.hidden = !playing;
    btn.title = playing ? 'Pause' : 'Play';
  }

  visualizerListEl?.addEventListener('click', (e) => {
    const row = e.target.closest('.visualizer-row');
    if (!row) return;
    const entry = _visualizerEntries.find((x) => x.path === row.dataset.path);
    if (entry) playVisualizerEntry(entry);
  });
  document.getElementById('visualizer-refresh-btn')  ?.addEventListener('click', () => refreshVisualizer());
  document.getElementById('visualizer-playpause-btn')?.addEventListener('click', togglePlayPause);
  document.getElementById('visualizer-prev-btn')     ?.addEventListener('click', () => playRelative(-1));
  document.getElementById('visualizer-next-btn')     ?.addEventListener('click', () => playRelative(+1));

  // V-OFF toggle — flips the audio mirror canvas off. The canvas is
  // display:none'd via .is-viz-off, which collapses its bounding rect
  // to 0×0; renderToTarget then early-outs on the W <= 0 guard so we
  // also stop doing the per-frame paint. Persisted under config.vizOff.
  const vizoffBtn = document.getElementById('visualizer-vizoff-btn');
  function applyVizOff(off) {
    visualizerWrapEl?.classList.toggle('is-viz-off', !!off);
    if (vizoffBtn) {
      vizoffBtn.textContent = off ? 'V-OFF' : 'V-ON';
      vizoffBtn.classList.toggle('is-active', !!off);
      vizoffBtn.title = off ? 'Audio visualization OFF — click to enable' : 'Audio visualization ON — click to disable';
    }
  }
  vizoffBtn?.addEventListener('click', async () => {
    const off = !visualizerWrapEl?.classList.contains('is-viz-off');
    applyVizOff(off);
    if (window.dash?.setConfig) {
      try { await window.dash.setConfig({ vizOff: off }); } catch {}
    }
  });
  // Restore previous V-OFF state on load.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    if (cfg.vizOff) applyVizOff(true);
  })();
  // Keep the play/pause icon in sync regardless of who initiated the
  // state change (transport buttons, native video controls, ended-event
  // auto-advance, etc.).
  visualizerVideoEl?.addEventListener('play',     updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('pause',    updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('emptied',  updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('loadeddata', updatePlayPauseIcon);
  // Auto-advance: when a video ends, cue the next one in the list.
  visualizerVideoEl?.addEventListener('ended', () => {
    const idx = _visualizerEntries.findIndex((e) => e.path === _visualizerCurrent);
    const next = _visualizerEntries[idx + 1];
    if (next) playVisualizerEntry(next);
  });

  // ── BROWSER pane ─────────────────────────────────────────────
  // Lightweight private browser. Each tab is a BrowserView in main (so
  // page rendering is reliable — the <webview> tag's shadow-DOM was
  // leaking <style>/<script> source text into the page on certain sites).
  // The renderer owns the chrome (tab strip, URL bar, splash, results)
  // and IPCs to main for navigation. A tab can be in three "modes":
  //   splash  → home screen with address + search inputs + stats
  //   results → hybrid SERP (DDG + Bing + Brave + Yahoo + Google,
  //             deduped + interleaved) as a web list, image grid, or
  //             video grid depending on the kind picker
  //   page    → the BrowserView is overlaying the stage with a real page
  // The BrowserView is positioned each time the stage's bounding rect
  // changes, and detached entirely when the user leaves the BROWSER tab.
  const browserTabstripEl = document.getElementById('browser-tabstrip');
  const browserNewTabBtn  = document.getElementById('browser-newtab-btn');
  const browserBackBtn    = document.getElementById('browser-back-btn');
  const browserForwardBtn = document.getElementById('browser-forward-btn');
  const browserReloadBtn  = document.getElementById('browser-reload-btn');
  const browserHomeBtn    = document.getElementById('browser-home-btn');
  const browserUrlEl      = document.getElementById('browser-url');
  const browserBookmarkBtn= document.getElementById('browser-bookmark-btn');
  const browserReaderBtn  = document.getElementById('browser-reader-btn');
  const browserDarkBtn    = document.getElementById('browser-dark-btn');
  const browserBookmarksEl= document.getElementById('browser-bookmarks');
  const browserBookmarksEmptyEl = document.getElementById('browser-bookmarks-empty');
  const browserStageEl    = document.getElementById('browser-stage');
  const browserStatusEl   = document.getElementById('browser-status');
  const browserSplashEl   = document.getElementById('browser-splash');
  const browserSplashAddrFormEl = document.getElementById('browser-splash-address-form');
  const browserSplashAddrEl     = document.getElementById('browser-splash-address');
  const browserSplashSearchFormEl = document.getElementById('browser-splash-search-form');
  const browserSplashSearchEl     = document.getElementById('browser-splash-search');
  const browserStatAdsEl    = document.getElementById('browser-stat-ads');
  const browserStatPopupsEl = document.getElementById('browser-stat-popups');
  const browserStatImagesEl = document.getElementById('browser-stat-images');
  const browserResultsEl     = document.getElementById('browser-results');
  const browserResultsListEl = document.getElementById('browser-results-list');
  const browserResultsGridEl = document.getElementById('browser-results-grid');
  const browserResultsLabel  = document.getElementById('browser-results-label');
  const browserResultsCount  = document.getElementById('browser-results-count');
  const browserResultsEmpty  = document.getElementById('browser-results-empty');
  const browserResultsLoadMoreEl = document.getElementById('browser-results-loadmore');

  const _browserState = { tabs: [], activeId: null, inited: false,
                          adsBlocked: 0, popupsBlocked: 0, imagesBlocked: 0,
                          bookmarks: [],
                          searchKind: 'web', inBrowserMode: false,
                          readerMode: false };
  window._browserState = _browserState; // for paintComboHeader's tab count

  function _browserNormalizeUrl(input) {
    const s = (input || '').trim();
    if (!s) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    if (/^about:/i.test(s)) return s;
    if (/^[^\s/]+\.[^\s/]+/.test(s) && !/\s/.test(s)) return `https://${s}`;
    return null;
  }

  function _browserRenderSplashStats() {
    if (browserStatAdsEl)    browserStatAdsEl.textContent    = String(_browserState.adsBlocked || 0);
    if (browserStatPopupsEl) browserStatPopupsEl.textContent = String(_browserState.popupsBlocked || 0);
    if (browserStatImagesEl) browserStatImagesEl.textContent = String(_browserState.imagesBlocked || 0);
  }

  function _browserActiveTab() {
    return _browserState.tabs.find(t => t.id === _browserState.activeId) || null;
  }

  // Drive the stage's data-mode attribute. CSS uses it to show/hide the
  // splash and the results panel. When mode === 'page' both are hidden
  // and the native BrowserView shows through.
  function _browserApplyStageMode() {
    const t = _browserActiveTab();
    const mode = t ? t.mode : 'splash';
    browserStageEl.dataset.mode = mode;
    const shouldShowBv = !!(t && t.mode === 'page' && _browserState.inBrowserMode);
    // Send fresh bounds BEFORE activate, not after. Otherwise main
    // attaches the BrowserView with no bounds and Electron defaults to
    // "fill the BrowserWindow" — the embedded page paints over our
    // chrome until the debounced bounds message catches up.
    if (shouldShowBv) {
      try { window.dash?.browserTabBounds?.(_browserStageRectFraction()); } catch {}
    }
    try { window.dash?.browserTabActivate?.(shouldShowBv ? t.id : null); } catch {}
  }
  // Express the stage rect as fractions (0..1) of the dashboard viewport.
  // Wrinkle: an ancestor (.combo-body) has CSS `zoom: 1.2`, which scales
  // the stage's visual size but Chromium's getBoundingClientRect returns
  // the pre-zoom layout rect. Multiplying by the accumulated ancestor
  // zoom recovers the actual on-screen rect — without it, the BV lands
  // ~83% of the visible stage's size, leaving a black gap below/right.
  function _browserStageRectFraction() {
    let z = 1;
    for (let el = browserStageEl.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const zv = parseFloat(window.getComputedStyle(el).zoom);
      if (zv && zv !== 1) z *= zv;
    }
    const r = browserStageEl.getBoundingClientRect();
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    return {
      x: (r.left   * z) / vw,
      y: (r.top    * z) / vh,
      width:  (r.width  * z) / vw,
      height: (r.height * z) / vh,
    };
  }

  function _browserUpdateChrome() {
    const t = _browserActiveTab();
    if (!t) {
      browserUrlEl.value = '';
      browserBackBtn.disabled = true;
      browserForwardBtn.disabled = true;
      browserBookmarkBtn.classList.remove('is-bookmarked');
      browserBookmarkBtn.disabled = true;
      browserStatusEl.textContent = 'NEW TAB';
      return;
    }
    const onPage = t.mode === 'page';
    const onResults = t.mode === 'results';
    // Keep the user's typed query visible when returning to a results
    // page so they don't have to re-type to refine — falls back to the
    // page URL on 'page' and empty on 'splash'.
    if (document.activeElement !== browserUrlEl) {
      browserUrlEl.value = onPage ? (t.url || '') : (onResults ? (t.query || '') : '');
    }
    // Back / forward are driven by our per-tab nav stack now. BV history
    // is irrelevant because the stack already includes every milestone +
    // every in-page link the user clicked.
    browserBackBtn.disabled    = !_navCanBack(t);
    browserForwardBtn.disabled = !_navCanFwd(t);
    const bookmarked = onPage && (_browserState.bookmarks || []).some(b => b.url === t.url);
    browserBookmarkBtn.classList.toggle('is-bookmarked', bookmarked);
    browserBookmarkBtn.disabled = !onPage;
    browserStatusEl.textContent = t.mode === 'splash' ? 'NEW TAB'
      : t.mode === 'results' ? `RESULTS · ${t.query || ''}`
      : (t.loading ? `LOADING · ${t.url}` : (t.url || 'READY'));
    paintComboHeader();
  }

  function _browserRenderTabStrip() {
    browserTabstripEl.querySelectorAll('.browser-tab').forEach(n => n.remove());
    for (const t of _browserState.tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browser-tab' + (t.id === _browserState.activeId ? ' is-active' : '');
      btn.dataset.tabId = String(t.id);
      const titleSpan = document.createElement('span');
      titleSpan.className = 'browser-tab-title';
      titleSpan.textContent = t.title || 'NEW TAB';
      const closeBtn = document.createElement('span');
      closeBtn.className = 'browser-tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close tab';
      btn.appendChild(titleSpan);
      btn.appendChild(closeBtn);
      btn.addEventListener('click', (e) => {
        if (e.target === closeBtn) { _browserCloseTab(t.id); return; }
        _browserActivateTab(t.id);
      });
      browserTabstripEl.insertBefore(btn, browserNewTabBtn);
    }
  }

  function _browserActivateTab(id) {
    _browserState.activeId = id;
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    _browserRenderResults();
  }

  async function _browserCloseTab(id) {
    const idx = _browserState.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    try { await window.dash?.browserTabClose?.(id); } catch {}
    _browserState.tabs.splice(idx, 1);
    if (_browserState.activeId === id) {
      const next = _browserState.tabs[idx] || _browserState.tabs[idx - 1] || null;
      _browserState.activeId = next ? next.id : null;
    }
    if (!_browserState.tabs.length) await _browserNewTab();
    else _browserActivateTab(_browserState.activeId);
  }

  async function _browserNewTab(url) {
    let backendId = null;
    try {
      const res = await window.dash?.browserTabCreate?.(url || null);
      backendId = res?.id ?? null;
    } catch {}
    if (backendId == null) return null;
    const tab = {
      id: backendId,
      url: url || '',
      title: 'NEW TAB',
      loading: !!url,
      canBack: false,
      canFwd: false,
      mode: url ? 'page' : 'splash',
      query: '',
      results: null,
      page: 1,
      hasMore: true,
      // Per-tab navigation stack: { type, url?, query?, kind?, results?, page?, hasMore? }
      // Back/forward step through this — BV's own history is no longer
      // consulted (it can't represent our app-level results/splash modes).
      nav: { stack: [], idx: -1 },
    };
    _navPush(tab, url ? { type: 'page', url } : { type: 'splash' });
    _browserState.tabs.push(tab);
    _browserActivateTab(backendId);
    return tab;
  }

  // ── Per-tab nav stack ──────────────────────────────────────────
  // Entries are app-level milestones (splash / results / page). Every
  // user-initiated state change pushes; every BV did-navigate event also
  // pushes (covers in-page link clicks). Back/forward simply walk the
  // stack and re-apply each entry's UI/BV state.
  //
  // _navRestoring is the dedupe guard: when we re-navigate the BV from a
  // back/forward restore, the BV fires did-navigate; that one event must
  // NOT push a duplicate entry. We mark the expected URL here and clear
  // it once the matching event arrives.
  const _navRestoring = new Map(); // tabId -> expected url

  function _navEntryEq(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'page')    return a.url === b.url;
    if (a.type === 'results') return a.query === b.query && a.kind === b.kind;
    if (a.type === 'splash')  return true;
    return false;
  }
  function _navPush(t, entry) {
    if (!t.nav) t.nav = { stack: [], idx: -1 };
    t.nav.stack = t.nav.stack.slice(0, t.nav.idx + 1);
    const last = t.nav.stack[t.nav.idx];
    if (last && _navEntryEq(last, entry)) return;
    t.nav.stack.push(entry);
    t.nav.idx = t.nav.stack.length - 1;
  }
  function _navCanBack(t) { return !!(t?.nav && t.nav.idx > 0); }
  function _navCanFwd(t)  { return !!(t?.nav && t.nav.idx < t.nav.stack.length - 1); }
  async function _navBack(t) {
    if (!_navCanBack(t)) return;
    t.nav.idx--;
    await _navApply(t, t.nav.stack[t.nav.idx]);
  }
  async function _navFwd(t) {
    if (!_navCanFwd(t)) return;
    t.nav.idx++;
    await _navApply(t, t.nav.stack[t.nav.idx]);
  }
  async function _navApply(t, entry) {
    if (!entry) return;
    if (entry.type === 'splash') {
      t.mode = 'splash';
      t.url = '';
      t.title = 'NEW TAB';
      t.loading = false;
      t.query = '';
      t.results = null;
    } else if (entry.type === 'results') {
      t.mode = 'results';
      t.query = entry.query || '';
      t.title = `${entry.kind === 'images' ? 'IMG · ' : entry.kind === 'videos' ? 'VID · ' : ''}${entry.query || ''}`;
      t.results = entry.results || null;
      t.page = entry.page || 1;
      t.hasMore = entry.hasMore !== false;
    } else if (entry.type === 'page') {
      t.mode = 'page';
      t.url = entry.url || '';
      t.title = entry.title || entry.url || '';
      t.loading = true;
      if (entry.url) {
        _navRestoring.set(t.id, entry.url);
        try { await window.dash?.browserTabNavigate?.(t.id, entry.url); } catch {}
      }
    }
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    if (t.mode === 'results') _browserRenderResults();
  }

  async function _browserNavigateActive(url) {
    if (!url) return;
    let t = _browserActiveTab();
    if (!t) { t = await _browserNewTab(url); return; }
    t.mode = 'page';
    t.url = url;
    t.loading = true;
    // Mark the BV navigation as ours so the did-navigate echo doesn't
    // re-push, then push the milestone ourselves with proper metadata.
    _navRestoring.set(t.id, url);
    _navPush(t, { type: 'page', url });
    try { await window.dash?.browserTabNavigate?.(t.id, url); } catch {}
    _browserUpdateChrome();
    _browserApplyStageMode();
  }

  async function _browserSearchActive(query, kind) {
    const q = (query || '').trim();
    if (!q) return;
    let t = _browserActiveTab() || await _browserNewTab();
    if (!t) return;
    t.mode = 'results';
    t.query = q;
    t.title = `${kind === 'images' ? 'IMG · ' : kind === 'videos' ? 'VID · ' : ''}${q}`;
    t.page = 1;
    t.hasMore = true;
    t.results = { kind, items: [], loading: true };
    // Push milestone BEFORE the fetch so the back stack reflects intent
    // even mid-load. We update the entry's results snapshot once items
    // arrive below so a back-to-this-search restores the cached items.
    _navPush(t, { type: 'results', query: q, kind, results: t.results, page: 1, hasMore: true });
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    _browserRenderResults();

    const res = await window.dash?.browserSearch?.(q, kind, 1);
    if (!res || !res.ok) {
      t.results = { kind, items: [], loading: false, error: res?.error || 'fetch failed' };
      _browserRenderResults();
      return;
    }
    // Web: main returns a { engine: rawHtml } map (DDG + Bing + Brave +
    // Yahoo + Google fanned out in parallel). We parse each engine here,
    // dedupe by canonical URL, then weave them by per-engine position
    // rank. Images & Videos: main does the vqd handshake + JSON parsing
    // and returns a ready items array.
    const items = (kind === 'images' || kind === 'videos')
      ? (Array.isArray(res.items) ? res.items : [])
      : _browserParseWebHybrid(res.html || {});
    t.results = { kind, items, loading: false, engineErrors: res.errors || {} };
    // If a fresh page-1 search returned nothing, there's no point
    // offering LOAD MORE.
    t.hasMore = items.length > 0;
    // Refresh the current milestone's snapshot so a future back-restore
    // gets the loaded items, not the in-flight placeholder.
    const cur = t.nav?.stack?.[t.nav.idx];
    if (cur && cur.type === 'results' && cur.query === q) {
      cur.results = t.results;
      cur.hasMore = t.hasMore;
    }
    _browserRenderResults();
  }

  // LOAD MORE — fetch the next page from every engine, parse + dedupe
  // against what's already shown, and append only the truly new entries.
  // When a page returns zero new hits, mark the tab as exhausted and hide
  // the button.
  async function _browserLoadMoreActive() {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'results' || !t.results || t.results.loading) return;
    if (t.hasMore === false) return;
    const nextPage = (t.page || 1) + 1;
    t.results.loading = true;
    _browserRenderResults();

    const res = await window.dash?.browserSearch?.(t.query, t.results.kind, nextPage);
    if (!res || !res.ok) {
      t.results.loading = false;
      _browserRenderResults();
      return;
    }
    const incoming = (t.results.kind === 'images' || t.results.kind === 'videos')
      ? (Array.isArray(res.items) ? res.items : [])
      : _browserParseWebHybrid(res.html || {});
    const seen = new Set(t.results.items.map((it) => _canonicalUrl(it.url) || it.image || it.thumb));
    const fresh = [];
    for (const it of incoming) {
      const key = _canonicalUrl(it.url) || it.image || it.thumb;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push(it);
    }
    t.results.items = t.results.items.concat(fresh);
    t.results.loading = false;
    t.page = nextPage;
    if (fresh.length === 0) t.hasMore = false;
    _browserRenderResults();
  }

  // Hybrid web parser — main fans out to several engines in parallel
  // and hands us back a { engineKey: rawHtml } map. We parse each with
  // engine-specific selectors, then weave them together by per-engine
  // position rank: each result's score is (idx + 0.5) / engineSize, so
  // an engine that returned 30 results spreads them evenly across the
  // 30 slots and an engine that returned 5 spreads them across the same
  // visible range. Sort by score → real mix throughout the list, no
  // "Brave block" at the bottom even when one engine returns way more
  // results than the others. Final dedupe by canonical URL collapses
  // overlap; sources chip shows every engine that surfaced it.
  function _browserParseWebHybrid(htmlByEngine) {
    const byEngine = {
      ddg:    htmlByEngine?.ddg    ? _parseDDG(htmlByEngine.ddg)       : [],
      bing:   htmlByEngine?.bing   ? _parseBing(htmlByEngine.bing)     : [],
      brave:  htmlByEngine?.brave  ? _parseBrave(htmlByEngine.brave)   : [],
      yahoo:  htmlByEngine?.yahoo  ? _parseYahoo(htmlByEngine.yahoo)   : [],
      google: htmlByEngine?.google ? _parseGoogle(htmlByEngine.google) : [],
    };
    const keys = Object.keys(byEngine);
    const annotated = [];
    for (let ki = 0; ki < keys.length; ki++) {
      const k = keys[ki];
      const list = byEngine[k];
      const len = list.length;
      if (!len) continue;
      for (let i = 0; i < len; i++) {
        annotated.push({ item: list[i], score: (i + 0.5) / len, eng: ki });
      }
    }
    // Stable score sort; ties break by engine declaration order so any
    // run of equal-score results still alternates engines.
    annotated.sort((a, b) => a.score - b.score || a.eng - b.eng);

    const seen = new Map();
    for (const { item: r } of annotated) {
      const key = _canonicalUrl(r.url);
      if (!key) continue;
      const existing = seen.get(key);
      if (existing) {
        for (const s of r.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
        if ((r.snippet || '').length > (existing.snippet || '').length) existing.snippet = r.snippet;
        if (!existing.title && r.title) existing.title = r.title;
      } else {
        seen.set(key, { ...r, sources: [...r.sources] });
      }
    }
    return Array.from(seen.values());
  }

  function _canonicalUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      let path = u.pathname.replace(/\/+$/, '');
      const params = new URLSearchParams(u.search);
      for (const p of [...params.keys()]) {
        if (/^(utm_|fbclid|gclid|msclkid|mc_eid|mc_cid|_ga|yclid|igshid|si)$/i.test(p)) params.delete(p);
      }
      const search = params.toString();
      return `${host}${path}${search ? '?' + search : ''}`;
    } catch { return null; }
  }

  function _parseDDG(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('.result')) {
        const a = el.querySelector('.result__a');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        if (href.startsWith('//')) href = 'https:' + href;
        try {
          const u = new URL(href);
          const real = u.searchParams.get('uddg');
          if (real) href = decodeURIComponent(real);
        } catch {}
        const title   = (a.textContent || '').trim();
        const snippet = (el.querySelector('.result__snippet')?.textContent || '').trim();
        const display = (el.querySelector('.result__url')?.textContent || '').trim();
        if (title && href && /^https?:\/\//.test(href)) out.push({ title, url: href, snippet, display, sources: ['ddg'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseBing(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('li.b_algo')) {
        const a = el.querySelector('h2 a');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        if (!/^https?:\/\//.test(href)) continue;
        const title = (a.textContent || '').trim();
        const snippet = (el.querySelector('.b_caption p, p')?.textContent || '').trim();
        const display = (el.querySelector('cite, .b_attribution')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: display || href, sources: ['bing'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseBrave(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      // Brave's markup varies; cover a few generations of selectors.
      const containers = doc.querySelectorAll('[data-type="web"], .snippet.fdb, .snippet[data-pos]');
      for (const el of containers) {
        const a = el.querySelector('a.h, a.heading-serpresult, a[data-testid="result-title-a"], a.title, a[href^="http"]');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        if (!/^https?:\/\//.test(href)) continue;
        const title = (
          el.querySelector('.title, .heading, h3, h4')?.textContent ||
          a.textContent ||
          ''
        ).trim();
        const snippet = (el.querySelector('.snippet-description, .desc, .snippet-content')?.textContent || '').trim();
        const display = (el.querySelector('.netloc, cite, .snippet-url')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: display || href, sources: ['brave'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseYahoo(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('div.algo, li.algo, div.algo-sr')) {
        const a = el.querySelector('h3 a, .compTitle a');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        // Yahoo wraps in r.search.yahoo.com/_ylt=…/RU=encoded-url/…/RK=…
        const ruMatch = href.match(/\/RU=([^/]+)\//);
        if (ruMatch) {
          try { href = decodeURIComponent(ruMatch[1]); } catch {}
        }
        if (!/^https?:\/\//.test(href)) continue;
        const title = (a.textContent || '').trim();
        const snippet = (el.querySelector('.compText p, .fz-ms, p')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: href, sources: ['yahoo'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseGoogle(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      // Google's class names rotate every few months. Use structural
      // shape — a heading + a link to an external URL — rather than
      // brittle class hooks.
      const seenHere = new Set();
      for (const h3 of doc.querySelectorAll('h3')) {
        const a = h3.closest('a') || h3.parentElement?.querySelector('a[href]');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        if (href.startsWith('/url?')) {
          try {
            const u = new URL(href, 'https://www.google.com');
            const real = u.searchParams.get('q') || u.searchParams.get('url');
            if (real) href = real;
          } catch {}
        }
        if (!/^https?:\/\//.test(href)) continue;
        // Skip Google's own internal links.
        if (/(?:^|\.)google\.[a-z.]+$/.test(new URL(href).hostname)) continue;
        if (seenHere.has(href)) continue;
        seenHere.add(href);
        const title = (h3.textContent || '').trim();
        const container = h3.closest('div[data-hveid], div.g, div.MjjYud') || h3.parentElement;
        const snippet = (container?.querySelector('div.VwiC3b, span.aCOpRe, div[data-snc]')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: href, sources: ['google'] });
      }
      return out;
    } catch { return []; }
  }

  // (Image results are parsed in main: it does the DuckDuckGo vqd → i.js
  // JSON handshake and returns a flat items array, so the renderer does
  // not need its own image parser.)

  function _browserRenderResults() {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'results') return;
    const r = t.results || { kind: 'web', items: [] };
    const isImages = r.kind === 'images';
    const isVideos = r.kind === 'videos';
    const isGrid   = isImages || isVideos;
    browserResultsEl.classList.toggle('is-images', isImages);
    browserResultsEl.classList.toggle('is-videos', isVideos);
    browserResultsListEl.hidden = isGrid;
    browserResultsGridEl.hidden = !isGrid;
    browserResultsLabel.textContent =
      (isVideos ? 'VIDEOS · ' : isImages ? 'IMAGES · ' : 'RESULTS · ') + t.query;
    if (r.loading && r.items.length === 0) {
      // Fresh search — show "SEARCHING…" while page 1 is in flight.
      browserResultsCount.textContent = 'SEARCHING…';
      browserResultsListEl.innerHTML = '';
      browserResultsGridEl.innerHTML = '';
      browserResultsEmpty.hidden = true;
      browserResultsLoadMoreEl.hidden = true;
      return;
    }
    if (r.error && r.items.length === 0) {
      browserResultsCount.textContent = 'ERROR';
      browserResultsEmpty.hidden = false;
      browserResultsEmpty.textContent = r.error.toUpperCase();
      browserResultsListEl.innerHTML = '';
      browserResultsGridEl.innerHTML = '';
      browserResultsLoadMoreEl.hidden = true;
      return;
    }
    browserResultsCount.textContent = `${r.items.length} HIT${r.items.length === 1 ? '' : 'S'}`
      + (t.page > 1 ? ` · PAGE ${t.page}` : '');
    browserResultsEmpty.hidden = r.items.length > 0;
    if (!r.items.length) browserResultsEmpty.textContent = 'NO RESULTS';
    // LOAD MORE: hidden when empty, when last fetch returned no new
    // unique results, or while a load-more request is in flight.
    browserResultsLoadMoreEl.hidden = !r.items.length || t.hasMore === false;
    browserResultsLoadMoreEl.disabled = !!r.loading;
    browserResultsLoadMoreEl.textContent = r.loading ? 'LOADING…' : 'LOAD MORE';

    if (isGrid) {
      browserResultsGridEl.innerHTML = '';
      for (const it of r.items) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = isVideos ? 'browser-result-img browser-result-vid' : 'browser-result-img';
        cell.title = it.title ? `${it.title}\n${it.url}` : it.url;
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = it.thumb;
        img.referrerPolicy = 'no-referrer';
        cell.appendChild(img);
        if (isVideos) {
          // Play-triangle hint + duration in bottom-right; title gradient
          // overlay along the bottom edge so the source is scannable
          // without hovering.
          const play = document.createElement('span');
          play.className = 'browser-result-vid-play';
          play.textContent = '▶';
          cell.appendChild(play);
          if (it.duration) {
            const dur = document.createElement('span');
            dur.className = 'browser-result-vid-duration';
            dur.textContent = it.duration;
            cell.appendChild(dur);
          }
          if (it.title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'browser-result-vid-title';
            titleEl.textContent = it.title;
            cell.appendChild(titleEl);
          }
        }
        cell.addEventListener('click', (e) => {
          // Videos: always navigate to the source page.
          // Images: left-click → source page, shift/middle → raw image.
          let target = it.url;
          if (isImages && (e.shiftKey || e.button === 1)) target = it.image || it.url;
          _browserNavigateActive(target);
        });
        browserResultsGridEl.appendChild(cell);
      }
    } else {
      browserResultsListEl.innerHTML = '';
      for (const it of r.items) {
        const li = document.createElement('li');
        li.className = 'browser-result';
        // Title row: optional source-count chip + clickable title.
        const titleRow = document.createElement('div');
        titleRow.className = 'browser-result-titlerow';
        const sources = it.sources || [];
        if (sources.length > 0) {
          const chip = document.createElement('span');
          chip.className = 'browser-result-chip';
          chip.textContent = sources.length > 1 ? `${sources.length}×` : sources[0].toUpperCase();
          chip.title = sources.join(' · ');
          if (sources.length > 1) chip.classList.add('is-multi');
          titleRow.appendChild(chip);
        }
        const a = document.createElement('a');
        a.className = 'browser-result-title';
        a.href = '#';
        a.textContent = it.title;
        a.addEventListener('click', (ev) => { ev.preventDefault(); _browserNavigateActive(it.url); });
        titleRow.appendChild(a);
        const url = document.createElement('div');
        url.className = 'browser-result-url';
        url.textContent = it.display || it.url;
        const snip = document.createElement('div');
        snip.className = 'browser-result-snippet';
        snip.textContent = it.snippet || '';
        li.appendChild(titleRow);
        li.appendChild(url);
        if (it.snippet) li.appendChild(snip);
        browserResultsListEl.appendChild(li);
      }
    }
  }

  function _browserRenderBookmarks() {
    const list = _browserState.bookmarks || [];
    browserBookmarksEl.querySelectorAll('.browser-bookmark').forEach(n => n.remove());
    browserBookmarksEmptyEl.hidden = list.length > 0;
    for (const bm of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browser-bookmark';
      btn.textContent = bm.title || bm.url;
      btn.title = bm.url;
      btn.addEventListener('click', () => _browserNavigateActive(bm.url));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        _browserState.bookmarks = list.filter(b => b !== bm);
        window.dash?.setConfig?.({ browserBookmarks: _browserState.bookmarks });
        _browserRenderBookmarks();
        _browserUpdateChrome();
      });
      browserBookmarksEl.appendChild(btn);
    }
  }

  function _browserGoHome() {
    const t = _browserActiveTab();
    if (!t) { _browserNewTab(); return; }
    _navPush(t, { type: 'splash' });
    _navApply(t, { type: 'splash' });
    setTimeout(() => browserSplashAddrEl?.focus(), 30);
  }

  // Geometry sync. The BrowserView lives in the main-process window
  // layer; the renderer tells main where the stage is on screen each
  // time the layout shifts. ResizeObserver covers panel-resize drags;
  // window 'resize' covers viewport / DPI changes.
  let _bvBoundsTimer = null;
  let _bvLastSent = null;
  function _browserSendBounds() {
    if (_bvBoundsTimer) return;
    _bvBoundsTimer = setTimeout(() => {
      _bvBoundsTimer = null;
      if (!_browserState.inBrowserMode) return;
      const t = _browserActiveTab();
      if (!t || t.mode !== 'page') return;
      // Dedup: the 500 ms heartbeat fires whether or not anything moved.
      // Comparing to the last-sent rect (with a half-pixel tolerance to
      // ignore subpixel jitter from layout flushes) skips the IPC ping +
      // native setBounds call when the page is just sitting still.
      const r = _browserStageRectFraction();
      if (_bvLastSent
        && Math.abs(r.x      - _bvLastSent.x)      < 0.0005
        && Math.abs(r.y      - _bvLastSent.y)      < 0.0005
        && Math.abs(r.width  - _bvLastSent.width)  < 0.0005
        && Math.abs(r.height - _bvLastSent.height) < 0.0005) {
        return;
      }
      _bvLastSent = r;
      try { window.dash?.browserTabBounds?.(r); } catch {}
    }, 16);
  }
  try {
    new ResizeObserver(_browserSendBounds).observe(browserStageEl);
  } catch {}
  // Catch the panel being dragged: drag updates panel.style.left/top
  // directly, which fires no resize event, so ResizeObserver alone
  // leaves the BrowserView stranded at its old screen coordinates.
  // Watching attribute mutations on the panel + its parent stack covers
  // drag, fold, layout-recall, and saved-layout restore.
  try {
    const mo = new MutationObserver(_browserSendBounds);
    mo.observe(comboPanel, { attributes: true, attributeFilter: ['style', 'class'] });
    if (comboPanel.parentElement) {
      mo.observe(comboPanel.parentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  } catch {}
  window.addEventListener('resize', _browserSendBounds);
  window.addEventListener('scroll', _browserSendBounds, true);
  // Also re-sync on mouseup as a belt-and-suspenders: ends a drag even if
  // the final mousemove didn't tick a mutation observer.
  window.addEventListener('mouseup', _browserSendBounds);
  // Heartbeat: re-measure every 500 ms while a page tab is showing in
  // the BROWSER pane. Cheap, and recovers from any layout shift our
  // observers happened to miss (saved-layout restores, side-arrange
  // recalcs, parent-style mutations on a non-watched ancestor, etc.).
  setInterval(() => {
    if (!_browserState.inBrowserMode) return;
    const t = _browserActiveTab();
    if (!t || t.mode !== 'page') return;
    _browserSendBounds();
  }, 500);

  // setComboMode (declared above in this same block) handles the
  // attach/detach signaling for the BrowserView by reading
  // window._browserState.inBrowserMode and calling
  // window._browserApplyStageMode / window.dash.browserTabActivate(null).
  // Expose the apply helper so the wrapper can reach it.
  window._browserApplyStageMode = _browserApplyStageMode;

  async function initBrowserOnce() {
    if (_browserState.inited) return;
    _browserState.inited = true;
    const cfg = await window.dash?.getConfig?.() || {};
    _browserState.bookmarks = Array.isArray(cfg.browserBookmarks) ? cfg.browserBookmarks : [];
    _browserState.readerMode = !!cfg.browserReaderMode;
    _browserRenderBookmarks();
    // Sync reader-mode to main so the webRequest handler matches the
    // persisted state from the moment the user enters the BROWSER pane.
    try { window.dash?.browserSetReaderMode?.(_browserState.readerMode); } catch {}
    browserReaderBtn?.classList.toggle('is-active', _browserState.readerMode);
    // Dark-mode default ON unless the user has explicitly turned it off.
    _browserState.darkMode = cfg.browserDarkMode !== false;
    try { window.dash?.browserSetDarkMode?.(_browserState.darkMode); } catch {}
    browserDarkBtn?.classList.toggle('is-active', _browserState.darkMode);
    try {
      const stats = await window.dash?.browserGetStats?.();
      if (stats && typeof stats.adsBlocked    === 'number') _browserState.adsBlocked    = stats.adsBlocked;
      if (stats && typeof stats.imagesBlocked === 'number') _browserState.imagesBlocked = stats.imagesBlocked;
    } catch {}
    _browserRenderSplashStats();
    // Lazy BrowserView allocation: we used to call _browserNewTab() here,
    // which spawned a fresh Chromium renderer process (its own GPU
    // context) at app launch even when the user was only looking at the
    // splash. Combined with the 3D scene init, audio worker, LHM probes,
    // and sensor-panel renders, that added up to the GPU spike on cold
    // start that tripped the emergency-temperature panel red. The
    // BrowserView is now created on first real navigation instead —
    // _browserSearchActive / _browserNavigateActive / + new tab.
    setTimeout(() => browserSplashAddrEl?.focus(), 50);
  }

  // Subscribe to BrowserView lifecycle events from main and reflect them
  // into our local tab state. Each event carries the backend tab id.
  try {
    window.dash?.onBrowserTabEvent?.((data) => {
      if (!data || data.id == null) return;
      const t = _browserState.tabs.find(x => x.id === data.id);
      if (!t) return;
      if (data.type === 'navigate') {
        t.url = data.url || t.url;
        t.mode = 'page';
        // Push to nav stack — unless this navigation is the BV echoing
        // a load we already pushed (back/forward restore, or a fresh
        // URL bar navigation we pushed eagerly above).
        const expecting = _navRestoring.get(t.id);
        if (expecting && (expecting === data.url || expecting === t.url)) {
          _navRestoring.delete(t.id);
        } else if (data.url) {
          _navPush(t, { type: 'page', url: data.url });
        }
        _browserUpdateChrome();
      } else if (data.type === 'title') {
        t.title = data.title || t.title;
        _browserRenderTabStrip();
        _browserUpdateChrome();
      } else if (data.type === 'loading') {
        t.loading  = !!data.loading;
        if (typeof data.canBack === 'boolean') t.canBack = data.canBack;
        if (typeof data.canFwd  === 'boolean') t.canFwd  = data.canFwd;
        _browserUpdateChrome();
      } else if (data.type === 'newwindow') {
        // Main already navigated the current view to the new URL — no
        // tab spawning here. We still tally these as "popups blocked"
        // since the page intended a separate window.
        _browserState.popupsBlocked++;
        _browserRenderSplashStats();
      } else if (data.type === 'fail') {
        // Silent; URL bar still shows last attempted address.
      }
    });
  } catch {}

  browserResultsLoadMoreEl?.addEventListener('click', () => _browserLoadMoreActive());
  browserNewTabBtn?.addEventListener('click', () => _browserNewTab());
  browserBackBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t) return;
    _navBack(t);
  });
  browserForwardBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t) return;
    _navFwd(t);
  });
  browserReloadBtn?.addEventListener('click',  () => {
    const t = _browserActiveTab();
    if (!t) return;
    if (t.mode === 'page')    window.dash?.browserTabReload?.(t.id);
    else if (t.mode === 'results' && t.query) _browserSearchActive(t.query, t.results?.kind || 'web');
  });
  browserHomeBtn?.addEventListener('click', _browserGoHome);
  // Reader mode — image blocking on/off. We persist the choice and tell
  // main to update its webRequest filter. Reload the current page so the
  // new policy actually takes effect on this view (already-loaded images
  // stay cached; blocking only applies to fresh requests).
  browserReaderBtn?.addEventListener('click', () => {
    _browserState.readerMode = !_browserState.readerMode;
    browserReaderBtn.classList.toggle('is-active', _browserState.readerMode);
    window.dash?.setConfig?.({ browserReaderMode: _browserState.readerMode });
    window.dash?.browserSetReaderMode?.(_browserState.readerMode);
    const t = _browserActiveTab();
    if (t && t.mode === 'page') {
      // Force a fresh load — plain reload() would happily serve the same
      // images from the memory cache, which means the new image-block
      // filter would never see those requests.
      try { window.dash?.browserTabReloadFresh?.(t.id); } catch {}
    }
  });
  // Dark mode — insert/remove an invert CSS overlay on every BrowserView.
  // No reload needed; main does insertCSS/removeInsertedCSS at runtime so
  // the toggle is instant.
  browserDarkBtn?.addEventListener('click', async () => {
    _browserState.darkMode = !_browserState.darkMode;
    browserDarkBtn.classList.toggle('is-active', _browserState.darkMode);
    try { await window.dash?.browserSetDarkMode?.(_browserState.darkMode); } catch {}
    playSfx?.('click');
  });
  browserUrlEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const url = _browserNormalizeUrl(browserUrlEl.value);
    if (url) { _browserNavigateActive(url); browserUrlEl.blur(); }
    else if (browserUrlEl.value.trim()) {
      _browserSearchActive(browserUrlEl.value.trim(), _browserState.searchKind);
      browserUrlEl.blur();
    }
  });
  browserUrlEl?.addEventListener('focus', () => { browserUrlEl.select(); });
  browserBookmarkBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'page' || !t.url) return;
    const list = _browserState.bookmarks || [];
    const existing = list.findIndex(b => b.url === t.url);
    if (existing >= 0) list.splice(existing, 1);
    else list.push({ url: t.url, title: t.title || t.url });
    _browserState.bookmarks = list;
    window.dash?.setConfig?.({ browserBookmarks: list });
    _browserRenderBookmarks();
    _browserUpdateChrome();
  });

  // Splash forms.
  browserSplashAddrFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = _browserNormalizeUrl(browserSplashAddrEl.value);
    if (url) { _browserNavigateActive(url); browserSplashAddrEl.value = ''; }
  });
  browserSplashSearchFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = browserSplashSearchEl.value.trim();
    if (q) { _browserSearchActive(q, _browserState.searchKind); browserSplashSearchEl.value = ''; }
  });
  // WEB / IMAGES kind picker on the splash.
  for (const btn of document.querySelectorAll('.browser-splash-kind-btn')) {
    btn.addEventListener('click', () => {
      _browserState.searchKind = btn.dataset.kind || 'web';
      for (const b of document.querySelectorAll('.browser-splash-kind-btn')) {
        b.classList.toggle('is-active', b === btn);
      }
    });
  }

  // Live ad-block + image-block counts from main process. Throttled to
  // 4 Hz over IPC. The image counter exists so reader-mode users can
  // verify the filter is actually firing — if the number goes up after
  // toggling on, the block is working.
  try {
    window.dash?.onBrowserStats?.((data) => {
      if (data && typeof data.adsBlocked    === 'number') _browserState.adsBlocked    = data.adsBlocked;
      if (data && typeof data.imagesBlocked === 'number') _browserState.imagesBlocked = data.imagesBlocked;
      _browserRenderSplashStats();
    });
  } catch {}

  // Popup → new tab. Main fires this whenever a page tries to open a
  // separate window/popup (covers target=_blank, window.open, popups
  // from iframes like Google sign-in). Spawn a fresh tab in our chrome
  // and navigate it to the requested URL, so the user's current page
  // stays where it was.
  try {
    window.dash?.onBrowserNewTabRequest?.((url) => {
      if (url) _browserNewTab(url);
    });
  } catch {}


  // Restore persisted mode + explore-tab.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    setExploreTab(cfg.exploreTab || 'gallery', false);
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
  // Also drop the document at docs/paper.html so it shows up in EXPLORE
  // and can be opened in a real browser / Word.
  if (window.dash?.docsWrite) {
    try { await window.dash.docsWrite('paper.html', paperEditorEl.innerHTML || ''); } catch {}
  }
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

  // Startup layout: if the user previously saved + selected a custom
  // layout slot (STORE → slot 1/2/3, or load-slot click), restore that
  // snapshot. Otherwise fall back to side-arrange (Productivity top-
  // centre, side columns left + right, empty middle) — the grid-aligned
  // baseline that survives monitor swaps and ad-hoc dragging.
  const _activeSlot = cfg?.activeLayoutSlot;
  const _activeLayout = _activeSlot ? (cfg?.savedLayouts || {})[_activeSlot] : null;
  if (_activeLayout) {
    requestAnimationFrame(() => { _applyLayout(_activeLayout); });
  } else {
    requestAnimationFrame(() => { applySideArrange(); });
  }

  // Theme: keep the saved slug only if it's still a known palette;
  // older configs that referenced deleted palette names fall back to
  // null and get cleared so the next launch starts clean.
  const savedTheme = cfg?.theme && THEME_SLUGS.has(cfg.theme) ? cfg.theme : null;
  setUserTheme(savedTheme);
  _themeSetPickerActive(savedTheme);
  if (cfg?.theme && !savedTheme) {
    try { window.dash?.setConfig?.({ theme: null }); } catch {}
  }
  // Restore auto-cycle state. setThemeAuto starts the 20s interval.
  if (cfg?.themeAuto) setThemeAuto(true);
  // Restore background pattern (defaults to 'grid' if missing/invalid).
  setBgPattern(cfg?.bgPattern || 'grid');
  const bgBtn = document.getElementById('bg-pattern-btn');
  if (bgBtn) bgBtn.title = `Background · ${(cfg?.bgPattern || 'grid').toUpperCase()}`;
  applyUiFont(cfg?.uiFont || 'DEFAULT');
  if (cfg?.invert) applyInvert(true);
  if (cfg?.dim)    applyDim(true);
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
  // Restore the persisted visualizer rate (▲/▼ buttons set this).
  if (Number.isFinite(cfg?.audioFrameMs)) setAudioFrameMs(cfg.audioFrameMs);
  if (cfg?.collapsed) {
    for (const [k, v] of Object.entries(cfg.collapsed)) {
      const panel = document.querySelector(`.panel-${k}`);
      if (panel && v) panel.classList.add('is-collapsed');
    }
  }

  initNotes(cfg);
  initChat(cfg);

  if (cfg?.altCity)  applyAltLocation(cfg.altCity);
  // cfg.altCity2 ignored — alt-zone 2 row was removed from the clock.
  if (cfg?.weatherCity) {
    activeLocation = cfg.weatherCity;
    weatherCityEl.value = activeLocation.name || '';
    loadWeather(activeLocation);
    weatherTimer = setInterval(() => loadWeather(activeLocation), 10 * 60 * 1000);
  } else {
    setStatus('ENTER CITY · PRESS ENTER');
  }
})();

// Close button — quits the Electron process. In browser mode (no preload),
// closing a tab is the user's job; we just blur the URL bar so nothing
// silently steals their input.
document.querySelector('#close-btn')?.addEventListener('click', () => {
  if (window.dash?.appQuit) window.dash.appQuit().catch(() => {});
});

// Lock UI — when active, panel drag, panel resize, audio-grid drag/resize,
// and topbar reorder all bail at mousedown. Persists across reloads.
function setUiLocked(on) {
  _uiLocked = !!on;
  document.body.classList.toggle('is-ui-locked', _uiLocked);
  document.querySelector('#lock-ui-btn')?.classList.toggle('is-active', _uiLocked);
}
document.querySelector('#lock-ui-btn')?.addEventListener('click', async () => {
  setUiLocked(!_uiLocked);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ uiLocked: _uiLocked }); } catch {}
  }
  playSfx(_uiLocked ? 'confirm' : 'click');
});
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.uiLocked) setUiLocked(true);
})();

// Eco mode is permanently on. The body class kills the per-character
// diag overlay animation + audio-grid transitions; the audio sampler
// loop is already pinned at ~10 Hz unconditionally. Was previously a
// topbar toggle that we removed since there was no perceptible benefit
// to running without it on real hardware.
document.body.classList.add('is-eco-mode');


// Recall panels — for any panel or audio grid currently outside the
// viewport (or even partially clipped), clamp it back inside and persist
// the new position. Useful after a display change shrinks the work area
// below where panels were dragged.
document.querySelector('#recall-panels-btn')?.addEventListener('click', async () => {
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const margin = 8; // keep a small gap from the edge so the header is grabbable

  const clampRect = (r) => {
    const w = r.width, h = r.height;
    let nx = Math.max(margin, Math.min(r.left, vpW - w - margin));
    let ny = Math.max(margin, Math.min(r.top,  vpH - h - margin));
    if (w > vpW - margin * 2) nx = margin;
    if (h > vpH - margin * 2) ny = margin;
    return { nx, ny };
  };
  const isInView = (r) => r.left >= 0 && r.top >= 0 && r.right <= vpW && r.bottom <= vpH;

  for (const panel of document.querySelectorAll('.panel')) {
    const key = panelKey(panel);
    if (!key) continue;
    const r = panel.getBoundingClientRect();
    if (isInView(r)) continue;
    const { nx, ny } = clampRect(r);
    panel.style.position = 'fixed';
    panel.style.left = `${nx}px`;
    panel.style.top  = `${ny}px`;
    await savePanelSize(key, { x: nx, y: ny });
  }

  // Audio visualizer grids live outside the .panel system — they're
  // .audio-grid elements with their own (audioInPos / audioOutPos) keys.
  const audioGrids = [
    { el: document.querySelector('#audio-in-grid'),  cfgKey: 'audioInPos'  },
    { el: document.querySelector('#audio-out-grid'), cfgKey: 'audioOutPos' },
  ];
  for (const { el, cfgKey } of audioGrids) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (isInView(r)) continue;
    const { nx, ny } = clampRect(r);
    el.style.left = `${nx}px`;
    el.style.top  = `${ny}px`;
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    if (window.dash?.setConfig) {
      try { await window.dash.setConfig({ [cfgKey]: { x: nx, y: ny } }); } catch {}
    }
  }
  playSfx('confirm');
});

// Saved-layout slots — STORE button puts the three numbered slots into
// "armed" mode for ~5s; the next slot click snapshots the current panel
// + audio-grid positions into that slot. A slot click outside armed mode
// restores its saved layout. Layouts persist in cfg.savedLayouts. The
// last-saved or last-loaded slot is remembered in cfg.activeLayoutSlot
// and re-applied on startup (see initFromConfig).
const saveLayoutBtn = document.querySelector('#save-layout-btn');
const layoutSlotBtns = Array.from(document.querySelectorAll('.topbar-slot'));
let _layoutSaveArmed = false;
let _layoutSaveTimer = null;

async function _snapshotCurrentLayout() {
  const cfg = await window.dash?.getConfig?.() || {};
  return {
    panelSizes:   cfg.panelSizes   ? JSON.parse(JSON.stringify(cfg.panelSizes))   : {},
    audioInPos:   cfg.audioInPos   ? { ...cfg.audioInPos }   : null,
    audioOutPos:  cfg.audioOutPos  ? { ...cfg.audioOutPos }  : null,
    audioVizSize: cfg.audioVizSize ? { ...cfg.audioVizSize } : null,
    savedAt:      Date.now(),
  };
}

async function _applyLayout(layout) {
  if (!layout) return;
  if (layout.panelSizes) {
    for (const panel of document.querySelectorAll('.panel')) {
      const key = panelKey(panel);
      if (key && layout.panelSizes[key]) applyPanelSize(panel, layout.panelSizes[key]);
    }
  }
  // Apply audio-grid positions. applySavedGeom handles missing pos/size
  // gracefully — passing null leaves the visualizer at its current geom.
  audioInViz?.applySavedGeom?.(layout.audioInPos,  layout.audioVizSize, undefined);
  audioOutViz?.applySavedGeom?.(layout.audioOutPos, layout.audioVizSize, undefined);
  // Persist as the new active config so the saved positions stay alive
  // through any in-session restoration logic (e.g. recall-panels).
  if (window.dash?.setConfig) {
    try {
      await window.dash.setConfig({
        panelSizes:   layout.panelSizes   || {},
        audioInPos:   layout.audioInPos   || null,
        audioOutPos:  layout.audioOutPos  || null,
        audioVizSize: layout.audioVizSize || null,
      });
    } catch {}
  }
}

async function _refreshLayoutSlotIndicators() {
  const cfg = await window.dash?.getConfig?.() || {};
  const layouts = cfg.savedLayouts || {};
  const activeSlot = cfg.activeLayoutSlot || null;
  for (const btn of layoutSlotBtns) {
    const slot = btn.dataset.slot;
    const has = !!layouts[slot];
    btn.classList.toggle('is-empty', !has);
    btn.classList.toggle('is-active', has && slot === activeSlot);
    btn.title = has
      ? (slot === activeSlot
          ? `Layout slot ${slot} · active (auto-applied on startup)`
          : `Layout slot ${slot} · click to load`)
      : `Layout slot ${slot} · empty (STORE then click here to save)`;
  }
}

function _setLayoutSaveArmed(on) {
  _layoutSaveArmed = !!on;
  document.body.classList.toggle('is-layout-save-armed', _layoutSaveArmed);
  saveLayoutBtn?.classList.toggle('is-armed', _layoutSaveArmed);
  if (_layoutSaveTimer) { clearTimeout(_layoutSaveTimer); _layoutSaveTimer = null; }
  if (_layoutSaveArmed) {
    // Auto-disarm after 5s so the slot buttons return to their normal
    // (load) behavior if the user doesn't pick a slot.
    _layoutSaveTimer = setTimeout(() => _setLayoutSaveArmed(false), 5000);
  }
}

saveLayoutBtn?.addEventListener('click', () => {
  _setLayoutSaveArmed(!_layoutSaveArmed);
  playSfx('click');
});

for (const btn of layoutSlotBtns) {
  btn.addEventListener('click', async () => {
    const slot = btn.dataset.slot;
    if (_layoutSaveArmed) {
      // SAVE: snapshot current layout into this slot AND mark it active
      // so the next app launch auto-applies it.
      const snap = await _snapshotCurrentLayout();
      const cfg = await window.dash?.getConfig?.() || {};
      const next = { ...(cfg.savedLayouts || {}), [slot]: snap };
      try { await window.dash?.setConfig?.({ savedLayouts: next, activeLayoutSlot: slot }); } catch {}
      _setLayoutSaveArmed(false);
      await _refreshLayoutSlotIndicators();
      playSfx('confirm');
      return;
    }
    // LOAD: restore the saved layout for this slot AND mark it active.
    const cfg = await window.dash?.getConfig?.() || {};
    const layout = (cfg.savedLayouts || {})[slot];
    if (!layout) { playSfx('error'); return; }
    await _applyLayout(layout);
    try { await window.dash?.setConfig?.({ activeLayoutSlot: slot }); } catch {}
    await _refreshLayoutSlotIndicators();
    playSfx('confirm');
  });
}

_refreshLayoutSlotIndicators();

// Side-arrange — Productivity (combo) at the top-center, every other panel
// tiled in stacked columns along the left and right edges. Leaves the
// middle area below Productivity intentionally empty so the wallpaper /
// 3D scene shows through. Persists every new position so it survives a
// reload. This is also the default layout on first launch — initFromConfig
// calls applySideArrange() when no panelSizes are stored yet (see below).
async function applySideArrange() {
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  // Every dimension in this layout is a multiple of the bg-grid cell
  // (SNAP_CELL = 40px) so every corner lands on a visible grid line.
  // Helpers: floor/round to the nearest 40 and clamp.
  const U = SNAP_CELL;
  const snapDown = (n) => Math.floor(n / U) * U;
  const snapNear = (n) => Math.round(n / U) * U;

  const margin = U;       // 40px outer gutter (one full grid cell)
  const gap    = U;       // 40px between stacked items

  // Side columns scale to ~26% of the viewport, snapped to the grid and
  // clamped so they never go below PANEL_MIN_W or balloon past 560 (the
  // nearest 40-multiple to the old 540 cap).
  const targetColW = Math.round(vpW * 0.26);
  const colW = Math.max(PANEL_MIN_W, Math.min(560, snapNear(targetColW)));

  // Side column X: left column starts on the very first grid line after
  // the left margin; right column is positioned so its RIGHT edge sits
  // on the last grid line that fits — left edge = rightEdge − colW.
  // Both colW and the X coords are 40-multiples → every left/right
  // border of every side panel falls on a vertical grid line.
  const leftColX  = margin;
  const rightColX = snapDown(vpW - margin) - colW;

  // Productivity (combo) fills the middle area between the two columns.
  // prodW is the largest 40-multiple that fits with one gap of clearance
  // on each side. prodX is the true geometric centre, then snapped down
  // so its left edge is also on a grid line (so combined with the colW
  // sizing the entire layout is one grid-aligned composition).
  const innerLeft  = leftColX  + colW + gap;
  const innerRight = rightColX - gap;
  const prodW = Math.max(PANEL_MIN_W, snapDown(innerRight - innerLeft));
  const prodX = snapNear(innerLeft + (innerRight - innerLeft - prodW) / 2);
  const prodY = margin;
  const prodH = Math.max(PANEL_MIN_H, snapNear(vpH * 0.45));

  // Side columns run from one grid line below the top margin down to
  // the matching grid line above the bottom margin. slotH (per-item
  // height inside a column) is also forced to a 40-multiple, so every
  // panel/audio-grid TOP/BOTTOM edge is on a horizontal grid line.
  const colTop    = margin;
  const colBottom = snapDown(vpH - margin);
  const colH      = Math.max(PANEL_MIN_H, colBottom - colTop);

  // Stack contents per column (top to bottom). Plain string entries are
  // panel keys → `.panel-${key}`. The 'audio-in' / 'audio-out' entries
  // are handled by placeItem below. Items whose elements aren't in the
  // DOM are skipped silently.
  const leftKeys  = ['clock', 'cpu', 'ram', 'storage', 'driveio', 'audio-in'];
  const rightKeys = ['weather', 'gpu', 'thermal', 'network', 'transfers', 'audio-out'];

  // Reset every style prop a previous drag/resize/fold might have set —
  // otherwise a stale `right: 12px` or `min-width: 600px` can fight the
  // new width and push the panel off-centre. Inline style wins on
  // specificity, so we have to clear them explicitly with empty strings.
  const resetPanelStyles = (panel) => {
    panel.style.right    = '';
    panel.style.bottom   = '';
    panel.style.minWidth = '';
    panel.style.minHeight = '';
    panel.classList.remove('is-collapsed', 'is-fold-half', 'is-fold-full');
  };

  const place = async (key, x, y, w, h) => {
    const panel = document.querySelector(`.panel-${key}`);
    if (!panel) return;
    resetPanelStyles(panel);
    panel.style.position = 'fixed';
    panel.style.flex     = '0 0 auto';
    panel.style.left     = `${x}px`;
    panel.style.top      = `${y}px`;
    panel.style.width    = `${w}px`;
    panel.style.height   = `${h}px`;
    panel.style.maxWidth = `${w}px`;
    await savePanelSize(key, { x, y, width: w, height: h });
  };

  // Place an audio visualizer at the given rect. Mirrors place() above
  // exactly: same width, same maxWidth (caps the layout box so any CSS
  // rule that later sets a wider width can't override us), clears the
  // CSS-default right/bottom anchors, and persists position + size so
  // applySavedGeom restores identical dimensions on reload. audioVizSize
  // is shared across both visualizers — by convention they read at the
  // same dimensions as each other and as every other column item.
  const placeAudio = async (side, x, y, w, h) => {
    const id = side === 'in' ? 'audio-in-grid' : 'audio-out-grid';
    const posKey = side === 'in' ? 'audioInPos'  : 'audioOutPos';
    const el = document.getElementById(id);
    if (!el) return;
    el.style.position = 'fixed';
    el.style.left     = `${x}px`;
    el.style.top      = `${y}px`;
    el.style.right    = 'auto';
    el.style.bottom   = 'auto';
    el.style.width    = `${w}px`;
    el.style.height   = `${h}px`;
    el.style.maxWidth = `${w}px`;
    el.style.flex     = '0 0 auto';
    if (window.dash?.setConfig) {
      try {
        await window.dash.setConfig({
          [posKey]: { x, y },
          audioVizSize: { width: w, height: h },
        });
      } catch {}
    }
  };

  const itemExists = (key) => {
    if (key === 'audio-in')  return !!document.getElementById('audio-in-grid');
    if (key === 'audio-out') return !!document.getElementById('audio-out-grid');
    return !!document.querySelector(`.panel-${key}`);
  };

  const placeItem = async (key, x, y, w, h) => {
    if (key === 'audio-in')  return placeAudio('in',  x, y, w, h);
    if (key === 'audio-out') return placeAudio('out', x, y, w, h);
    return place(key, x, y, w, h);
  };

  const stackColumn = async (keys, x) => {
    const present = keys.filter(itemExists);
    if (present.length === 0) return;
    // slotH is forced to a 40-multiple so every panel top/bottom edge
    // sits on a horizontal bg-grid line. We floor-snap (not round) so
    // we never overshoot the column's available height — overshoot
    // would push the last panel past colBottom and off-screen.
    const rawSlotH = (colH - (present.length - 1) * gap) / present.length;
    const slotH = Math.max(PANEL_MIN_H, Math.floor(rawSlotH / U) * U);
    let y = colTop;
    for (const k of present) {
      await placeItem(k, x, y, colW, slotH);
      y += slotH + gap;
    }
  };

  await place('combo', prodX, prodY, prodW, prodH);
  await stackColumn(leftKeys,  leftColX);
  await stackColumn(rightKeys, rightColX);
}

// Background diagnostics overlay — large faint monospace process block
// centered in the viewport. Polls heap / FPS / DOM nodes / draws per
// second once a second, paints into the .diag-block. Toggled by the
// topbar #diag-btn and persisted under config.diagOverlay.
const diagOverlayEl = document.getElementById('diag-overlay');
const diagContentEl = document.getElementById('diag-content');
const diagBtnEl     = document.querySelector('#diag-btn');
let _diagOn = false;

function _fmtUp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function _fmtMb(bytes) { return `${(bytes / 1048576).toFixed(0)} MB`; }

function _setDiagLine(key, text) {
  const el = diagContentEl?.querySelector(`[data-key="${key}"]`);
  if (!el) return;
  // Wrap each character in its own span with a randomized animation
  // phase + duration so every letter pulses independently. Negative
  // delay starts each char mid-cycle so they don't all begin at the
  // dim point together.
  const frag = document.createDocumentFragment();
  for (const ch of text) {
    const span = document.createElement('span');
    span.className = ch === ' ' ? 'diag-char is-space' : 'diag-char';
    span.textContent = ch;
    const dur   = (2.5 + Math.random() * 3.0).toFixed(2);  // 2.5–5.5s
    const delay = (-Math.random() * 4).toFixed(2);          // -4..0s
    span.style.animationDuration = `${dur}s`;
    span.style.animationDelay    = `${delay}s`;
    frag.appendChild(span);
  }
  el.replaceChildren(frag);
}
// Cache of main-process stats — repopulated by the telemetry tick.
let _mainStats = null;
async function pollMainStats() {
  if (!window.dash?.processStats) return;
  try { _mainStats = await window.dash.processStats(); } catch {}
}

function paintDiag() {
  if (!diagContentEl) return;
  const mem = performance.memory || {};
  const rheap   = mem.usedJSHeapSize  ? _fmtMb(mem.usedJSHeapSize)  : '—';
  const rheapMx = mem.jsHeapSizeLimit ? _fmtMb(mem.jsHeapSizeLimit) : '—';
  const mrss    = _mainStats?.rss ? _fmtMb(_mainStats.rss) : '—';
  const nodes   = document.getElementsByTagName('*').length;
  const up      = _fmtUp((Date.now() - _appStartTs) / 1000);
  const theme   = (document.documentElement.getAttribute('data-theme') || 'default').toUpperCase();
  const ver     = document.querySelector('#version-chip')?.textContent || 'v—';
  const dpr     = (window.devicePixelRatio || 1).toFixed(0);
  const vp      = `${window.innerWidth}x${window.innerHeight} @${dpr}x`;

  // Canvas count + a rough estimate of GPU-backed bytes (W * H * 4 bytes
  // per pixel for an RGBA8 framebuffer). Doesn't account for double-
  // buffering or compositor overhead, just gives a sense of scale.
  const canvasEls = document.querySelectorAll('canvas');
  let cmem = 0;
  canvasEls.forEach((c) => { cmem += (c.width * c.height * 4); });
  const canvasLine = `${canvasEls.length} · ${(cmem / 1048576).toFixed(1)} MB`;

  // Audio visualizer state — bar count + LIVE / MUTED.
  const inBars   = audioInViz?.getBarCount?.()  ?? 0;
  const outBars  = audioOutViz?.getBarCount?.() ?? 0;
  const inMuted  = audioInViz?.isMuted?.()  ? 'MUTED' : 'LIVE';
  const outMuted = audioOutViz?.isMuted?.() ? 'MUTED' : 'LIVE';

  // Combo-pane mode + zen state.
  const cpMode = (document.querySelector('.panel-combo')?.dataset.mode || '—').toUpperCase();
  const zen    = document.body.classList.contains('is-zen') ? ' · ZEN' : '';

  // Active alert reasons (cpu-90, gpu-90, offline, error-*).
  const alerts = _alertReasons.size > 0
    ? [..._alertReasons].join(' · ').toUpperCase()
    : 'NONE';

  _setDiagLine('title',   `DASHBOARD3D ${ver}`);
  _setDiagLine('rheap',   `R-HEAP   ${rheap} / ${rheapMx}`);
  _setDiagLine('mrss',    `M-RSS    ${mrss}`);
  _setDiagLine('nodes',   `NODES    ${nodes.toLocaleString()}`);
  _setDiagLine('canvas',  `CANVAS   ${canvasLine}`);
  _setDiagLine('fps',     `FPS      ${_diagFps}`);
  _setDiagLine('draws',   `DRAWS/S  ${_diagDrawPerS}`);
  _setDiagLine('viewport',`VIEWPORT ${vp}`);
  _setDiagLine('audioin', `AUDIO IN  ${inBars} BARS · ${inMuted}`);
  _setDiagLine('audioout',`AUDIO OUT ${outBars} BARS · ${outMuted}`);
  _setDiagLine('mode',    `MODE      ${cpMode}${zen}`);
  _setDiagLine('theme',   `THEME    ${theme}`);
  _setDiagLine('alerts',  `ALERTS   ${alerts}`);
  _setDiagLine('up',      `UP       ${up}`);
}

// FPS counter — counts requestAnimationFrame callbacks; reset each tick.
function _diagFrame() {
  _diagFrames++;
  requestAnimationFrame(_diagFrame);
}
requestAnimationFrame(_diagFrame);

// Telemetry tick — snapshot counters, refresh main-process stats, then
// repaint overlay if visible. FPS / DRAWS-per-second stay accurate at
// the longer window because we divide the raw counters by the window
// length in seconds before displaying.
setInterval(async () => {
  if (document.hidden) return;
  const sec = UI_REFRESH_MS / 1000;
  _diagFps       = Math.round(_diagFrames     / sec);
  _diagDrawPerS  = Math.round(_diagDrawCalls  / sec);
  _diagFrames    = 0;
  _diagDrawCalls = 0;
  if (_diagOn) {
    await pollMainStats();
    paintDiag();
  }
}, UI_REFRESH_MS);

function setDiagOn(on) {
  _diagOn = !!on;
  if (diagOverlayEl) diagOverlayEl.hidden = !_diagOn;
  diagBtnEl?.classList.toggle('is-active', !!on);
  if (_diagOn) {
    pollMainStats().then(paintDiag);
  }
}
diagBtnEl?.addEventListener('click', async () => {
  setDiagOn(!_diagOn);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ diagOverlay: _diagOn }); } catch {}
  }
});
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.diagOverlay) setDiagOn(true);
})();

// Flush RAM button — calls psapi!EmptyWorkingSet on every accessible
// process via the main-process IPC. Logs the count to the console so the
// user can see how many working sets were dropped; the result is roughly
// instant on a modern CPU even with hundreds of processes.
document.querySelector('#flush-ram-btn')?.addEventListener('click', async () => {
  if (!window.dash?.flushRam) return;
  const btn = document.querySelector('#flush-ram-btn');
  btn?.classList.add('is-busy');
  try {
    const r = await window.dash.flushRam();
    if (r?.flushed != null) {
      console.log(`[flush-ram] working sets dropped on ${r.flushed} processes (${r.failed || 0} failed)`);
      playSfx('confirm');
    } else {
      console.warn('[flush-ram] failed:', r?.error);
      playSfx('error');
    }
  } catch (err) {
    console.warn('[flush-ram] error:', err.message || err);
    playSfx('error');
  } finally {
    btn?.classList.remove('is-busy');
  }
});

// ── TASKS pane (process / service monitor) ───────────────────────────────
// Combo-pane mode 'tasks' surfaces app.getAppMetrics() from main: every
// Electron child process (Browser / Renderer / GPU / Utility / …) with
// per-proc CPU + working-set memory. Polled every UI_REFRESH_MS but only
// while the pane is the active combo mode so we don't burn CPU when the
// user is elsewhere. Each piece of text uses the diag-char letter pulse
// from the diagnostics overlay so the whole pane scintillates the way
// the rest of the dashboard chrome does.
window._tasksState = window._tasksState || {
  procCount: null,
  sort:      'memory',    // memory · cpu · pid · name
  selectedPid: null,
  prevCpu: new Map(),     // pid -> last cpu sample, for scramble-on-change
};

function _scrambleInto(el, text) {
  if (!el) return;
  const frag = document.createDocumentFragment();
  for (const ch of String(text)) {
    const span = document.createElement('span');
    span.className = ch === ' ' ? 'diag-char is-space' : 'diag-char';
    span.textContent = ch;
    const dur   = (2.5 + Math.random() * 3.0).toFixed(2);  // 2.5–5.5s
    const delay = (-Math.random() * 4).toFixed(2);          // -4..0s
    span.style.animationDuration = `${dur}s`;
    span.style.animationDelay    = `${delay}s`;
    frag.appendChild(span);
  }
  el.replaceChildren(frag);
}

function _fmtMemKb(kb) {
  if (!Number.isFinite(kb) || kb <= 0) return '—';
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function _fmtMemBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

// Compute system CPU % from two consecutive os.cpus() snapshots. Caches
// the prior sample on _tasksState so successive polls produce a moving
// percentage. Returns null on the very first call (no delta yet).
function _computeSysCpu(sysInfo) {
  if (!sysInfo || !Array.isArray(sysInfo.cpuTimes)) return null;
  const prev = window._tasksState._prevCpuTimes;
  window._tasksState._prevCpuTimes = sysInfo.cpuTimes.map((t) => ({ ...t }));
  if (!prev || prev.length !== sysInfo.cpuTimes.length) return null;
  let busyDelta = 0, totalDelta = 0;
  for (let i = 0; i < sysInfo.cpuTimes.length; i++) {
    const p = prev[i], c = sysInfo.cpuTimes[i];
    const pTotal = (p.user || 0) + (p.nice || 0) + (p.sys || 0) + (p.idle || 0) + (p.irq || 0);
    const cTotal = (c.user || 0) + (c.nice || 0) + (c.sys || 0) + (c.idle || 0) + (c.irq || 0);
    const dT = cTotal - pTotal;
    const dI = (c.idle || 0) - (p.idle || 0);
    if (dT > 0) {
      busyDelta  += (dT - dI);
      totalDelta += dT;
    }
  }
  if (totalDelta <= 0) return null;
  return (busyDelta / totalDelta) * 100;
}

function _fmtUpSec(s) {
  if (!Number.isFinite(s) || s < 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function _procTypeLabel(t) {
  // Electron's process types map to short, fixed-width labels so the
  // PID column lines up regardless of which subprocess is reporting.
  switch ((t || '').toLowerCase()) {
    case 'browser':         return 'MAIN';
    case 'renderer':        return 'RNDR';
    case 'gpu':             return 'GPU';
    case 'utility':         return 'UTIL';
    case 'zygote':          return 'ZYG';
    case 'sandbox helper':  return 'SBOX';
    case 'pepper plugin':   return 'PLUG';
    case 'ppapi':           return 'PPAPI';
    default:                return (t || '?').slice(0, 4).toUpperCase();
  }
}

// Services the app depends on — sourced from src/main/services/. Each
// row is a lightweight status pill that the renderer can probe by
// calling the corresponding window.dash channel (probe = "does the
// channel respond"). Static service catalog so the pane shows what the
// app *requires* even when polling fails.
// Each service maps to a window.dash channel we can call as a liveness
// probe. POWER and WM don't have public read endpoints — they're modules
// in main — so they piggyback on appVersion (any successful main-process
// IPC means the host is alive). `slow` services (sensors via LHM) get a
// longer timeout because PowerShell + native temp reads cost real time.
const TASK_SERVICES = [
  { key: 'system',  label: 'SYSTEM',   code: 'CPU · MEM · OS',     probe: 'systemInfo'      },
  { key: 'sensors', label: 'SENSORS',  code: 'GPU · TEMPS · LHM',  probe: 'tempsInfo',    slow: true },
  { key: 'power',   label: 'POWER',    code: 'PROFILE · ZEN',      probe: 'appVersion'      },
  { key: 'audio',   label: 'AUDIO',    code: 'WASAPI · LOOPBACK',  probe: 'getMuteStates'   },
  { key: 'storage', label: 'STORAGE',  code: 'DISK · DRIVES',      probe: 'storageInfo'     },
  { key: 'network', label: 'NETWORK',  code: 'LIVE TRAFFIC',       probe: 'netInfo'         },
  { key: 'wm',      label: 'WINDOW',   code: 'Z-ORDER · FOCUS',    probe: 'appVersion'      },
  { key: 'browser', label: 'BROWSER',  code: 'BROWSERVIEW · ADS',  probe: 'browserGetStats' },
];
// Last-good cache so a single slow tick doesn't flip a probed service to
// DOWN — we only mark it down after _SVC_DOWN_GRACE consecutive misses.
const _svcLastOk    = new Map();  // key -> ms timestamp of last resolve
const _svcMisses    = new Map();  // key -> consecutive timeout/reject count
const _SVC_FAST_MS  = 1200;
const _SVC_SLOW_MS  = 3500;
const _SVC_DOWN_GRACE = 3;        // ticks of misses before flipping to DOWN

const tasksProcListEl    = document.getElementById('tasks-proc-list');
const tasksSvcListEl     = document.getElementById('tasks-svc-list');
const tasksFlushBtnEl    = document.getElementById('tasks-flush-btn');
const tasksRefreshBtnEl  = document.getElementById('tasks-refresh-btn');
const tasksPaneEl        = document.querySelector('.combo-pane-tasks');

function _sortProcs(metrics) {
  const arr = Array.isArray(metrics) ? metrics.slice() : [];
  const sort = window._tasksState.sort;
  if (sort === 'memory') {
    arr.sort((a, b) => (b?.memory?.workingSetSize || 0) - (a?.memory?.workingSetSize || 0));
  } else if (sort === 'cpu') {
    arr.sort((a, b) => (b?.cpu?.percentCPUUsage || 0) - (a?.cpu?.percentCPUUsage || 0));
  } else if (sort === 'pid') {
    arr.sort((a, b) => (a?.pid || 0) - (b?.pid || 0));
  } else if (sort === 'name') {
    arr.sort((a, b) => String(a?.type || '').localeCompare(String(b?.type || '')));
  }
  return arr;
}

function renderTasks(data, sysInfo) {
  if (!tasksPaneEl || !data) return;
  const metrics = _sortProcs(data.metrics || []);
  window._tasksState.procCount = metrics.length;

  // ── RAM breakdown (in bytes) ────────────────────────────────────
  //   APP   = sum of working-set RAM across every Electron child proc
  //   SYS   = system total used (os.totalmem - os.freemem)
  //   OTHER = SYS - APP  (clamped to zero in case the polls disagree)
  const appKb     = metrics.reduce((s, p) => s + (p?.memory?.workingSetSize || 0), 0);
  const appBytes  = appKb * 1024;
  const sysUsed   = Number.isFinite(sysInfo?.usedMem)  ? sysInfo.usedMem  : null;
  const sysTotal  = Number.isFinite(sysInfo?.totalMem) ? sysInfo.totalMem : null;
  const otherBytes = sysUsed != null ? Math.max(0, sysUsed - appBytes) : null;

  // ── CPU breakdown (% of whole system) ───────────────────────────
  //   getAppMetrics reports percentCPUUsage as 0..(100 * coreCount); to
  //   express as % of the whole system we divide by coreCount.
  //   SYS CPU comes from os.cpus() deltas between two polls — we cache
  //   the previous sample on window._tasksState.
  const coreCount = sysInfo?.cpuCount || (sysInfo?.cpuTimes?.length) || 1;
  const appCpuPct = metrics.reduce((s, p) => s + (p?.cpu?.percentCPUUsage || 0), 0) / coreCount;
  const sysCpuPct = _computeSysCpu(sysInfo);
  const otherCpu  = sysCpuPct != null ? Math.max(0, sysCpuPct - appCpuPct) : null;

  // Hero block — labels stay static (rendered once), values scramble.
  const heroLabels = {
    app:    'APP',
    pid:    'PID',
    upt:    'UPTIME',
    plat:   'PLATFORM',
    apprm:  'APP RAM',
    othrm:  'OTHER RAM',
    sysrm:  'SYS RAM',
    appcpu: 'APP CPU',
    othcpu: 'OTHER CPU',
    syscpu: 'SYS CPU',
  };
  for (const [k, v] of Object.entries(heroLabels)) {
    _scrambleInto(tasksPaneEl.querySelector(`[data-tasks-line="${k}"]`), v);
  }
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="appval"]'),
    `${(data.appName || 'DASHBOARD3D').toUpperCase()} ${data.appVersion ? 'V' + data.appVersion : ''}`);
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="pidval"]'),  String(data.pid ?? '—'));
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="uptval"]'),  _fmtUpSec(data.uptimeSec));
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="platval"]'),
    `${(data.platform || '').toUpperCase()} · CHROMIUM ${data.chrome || '—'}`);
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="apprmval"]'),
    _fmtMemBytes(appBytes));
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="othrmval"]'),
    otherBytes != null ? _fmtMemBytes(otherBytes) : '—');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="sysrmval"]'),
    sysUsed != null && sysTotal != null
      ? `${_fmtMemBytes(sysUsed)} / ${_fmtMemBytes(sysTotal)}`
      : '—');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="appcpuval"]'),
    `${appCpuPct.toFixed(1)} %`);
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="othcpuval"]'),
    otherCpu != null ? `${otherCpu.toFixed(1)} %` : '—');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="syscpuval"]'),
    sysCpuPct != null ? `${sysCpuPct.toFixed(1)} %` : '—');

  // Section headers
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="proctitle"]'), 'PROCESSES');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="proctag"]'),
    `${metrics.length} ACTIVE`);
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="svctitle"]'), 'SERVICES');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="svctag"]'),
    `${TASK_SERVICES.length} REGISTERED`);

  // Process rows. Reuse existing <li> nodes when count matches to avoid
  // re-creating DOM on every tick (cheap-enough animation work stays
  // limited to the inner spans).
  if (!tasksProcListEl) return;
  if (tasksProcListEl.children.length !== metrics.length) {
    tasksProcListEl.replaceChildren();
    for (let i = 0; i < metrics.length; i++) {
      const li = document.createElement('li');
      li.className = 'tasks-proc-row';
      li.innerHTML = `
        <span class="tp-type" data-col="type"></span>
        <span class="tp-pid"  data-col="pid"></span>
        <span class="tp-name" data-col="name"></span>
        <span class="tp-bar"><span class="tp-bar-fill" data-col="bar"></span></span>
        <span class="tp-cpu"  data-col="cpu"></span>
        <span class="tp-mem"  data-col="mem"></span>
      `;
      tasksProcListEl.appendChild(li);
    }
  }
  const maxKb = Math.max(1, ...metrics.map(p => p?.memory?.workingSetSize || 0));
  const rows = tasksProcListEl.children;
  metrics.forEach((p, i) => {
    const row = rows[i]; if (!row) return;
    const pid    = p?.pid ?? '?';
    const type   = _procTypeLabel(p?.type);
    const cpu    = (p?.cpu?.percentCPUUsage || 0).toFixed(1);
    const kb     = p?.memory?.workingSetSize || 0;
    const name   = (p?.serviceName || p?.name || p?.type || '').toString().toUpperCase().slice(0, 28) || '—';
    row.dataset.pid = String(pid);
    row.classList.toggle('is-selected', window._tasksState.selectedPid === pid);
    _scrambleInto(row.querySelector('[data-col="type"]'), type);
    _scrambleInto(row.querySelector('[data-col="pid"]'),  String(pid));
    _scrambleInto(row.querySelector('[data-col="name"]'), name);
    _scrambleInto(row.querySelector('[data-col="cpu"]'),  `${cpu}%`);
    _scrambleInto(row.querySelector('[data-col="mem"]'),  _fmtMemKb(kb));
    const fill = row.querySelector('[data-col="bar"]');
    if (fill) fill.style.width = `${Math.min(100, (kb / maxKb) * 100)}%`;
  });

  // Services list — built once, then live-probed each tick. Each row's
  // dot turns green when the matching window.dash channel resolves.
  if (tasksSvcListEl && tasksSvcListEl.children.length !== TASK_SERVICES.length) {
    tasksSvcListEl.replaceChildren();
    for (const svc of TASK_SERVICES) {
      const li = document.createElement('li');
      li.className = 'tasks-svc-row';
      li.dataset.key = svc.key;
      li.innerHTML = `
        <span class="ts-dot"></span>
        <span class="ts-label" data-col="label"></span>
        <span class="ts-code"  data-col="code"></span>
        <span class="ts-state" data-col="state">PROBE…</span>
      `;
      tasksSvcListEl.appendChild(li);
    }
  }
  if (tasksSvcListEl) {
    for (const li of tasksSvcListEl.children) {
      const key = li.dataset.key;
      const svc = TASK_SERVICES.find(s => s.key === key);
      if (!svc) continue;
      _scrambleInto(li.querySelector('[data-col="label"]'), svc.label);
      _scrambleInto(li.querySelector('[data-col="code"]'),  svc.code);
      const stateEl = li.querySelector('[data-col="state"]');
      if (!svc.probe || !window.dash?.[svc.probe]) {
        // No channel exposed — treat as missing IPC.
        li.classList.remove('is-up', 'is-static');
        li.classList.add('is-down');
        _scrambleInto(stateEl, 'MISSING');
        continue;
      }
      // Probe-with-grace: a timeout doesn't immediately flip the row
      // to DOWN; it just bumps a miss counter. The row only goes DOWN
      // after _SVC_DOWN_GRACE consecutive misses, so slow services
      // (LHM / PowerShell) stay green across the occasional long tick.
      const timeoutMs = svc.slow ? _SVC_SLOW_MS : _SVC_FAST_MS;
      let settled = false;
      const settle = (ok) => {
        if (settled) return; settled = true;
        if (ok) {
          _svcLastOk.set(key, Date.now());
          _svcMisses.set(key, 0);
          li.classList.remove('is-down', 'is-static');
          li.classList.add('is-up');
          _scrambleInto(stateEl, 'ONLINE');
        } else {
          const n = (_svcMisses.get(key) || 0) + 1;
          _svcMisses.set(key, n);
          if (n >= _SVC_DOWN_GRACE) {
            li.classList.remove('is-up', 'is-static');
            li.classList.add('is-down');
            _scrambleInto(stateEl, 'DOWN');
          } else if (_svcLastOk.has(key)) {
            // Keep the previous ONLINE pill while we're inside the grace
            // window so the user doesn't see flapping.
            li.classList.remove('is-down', 'is-static');
            li.classList.add('is-up');
            _scrambleInto(stateEl, 'ONLINE');
          } else {
            _scrambleInto(stateEl, 'PROBE…');
          }
        }
      };
      Promise.resolve()
        .then(() => window.dash[svc.probe]())
        .then(() => settle(true))
        .catch(() => settle(false));
      setTimeout(() => settle(false), timeoutMs);
    }
  }

  paintComboHeader();
}

async function refreshTasksNow() {
  if (!window.dash?.appMetrics) return;
  try {
    // Parallel: appMetrics for per-process detail, systemInfo for the
    // overall system RAM/CPU totals so we can compute OTHER = SYS - APP.
    const [data, sysInfo] = await Promise.all([
      window.dash.appMetrics(),
      window.dash?.systemInfo?.().catch(() => null),
    ]);
    renderTasks(data, sysInfo);
  } catch (err) {
    console.warn('[tasks] poll failed:', err?.message || err);
  }
}

setInterval(() => {
  if (document.hidden) return;
  if (comboPanel?.dataset.mode !== 'tasks') return;
  refreshTasksNow();
}, UI_REFRESH_MS);

// Sort buttons cycle the active mode + immediately repaint.
tasksPaneEl?.querySelectorAll('.tasks-sort-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.tasksSort;
    if (!key) return;
    window._tasksState.sort = key;
    tasksPaneEl.querySelectorAll('.tasks-sort-btn').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tasksSort === key);
    });
    playSfx?.('click');
    refreshTasksNow();
  });
});

// Row select — toggles a highlight on the clicked PID. Selection survives
// across refreshes because renderTasks() applies it from _tasksState.
tasksProcListEl?.addEventListener('click', (e) => {
  const row = e.target.closest?.('.tasks-proc-row');
  if (!row) return;
  const pid = Number(row.dataset.pid);
  if (!Number.isFinite(pid)) return;
  window._tasksState.selectedPid = (window._tasksState.selectedPid === pid) ? null : pid;
  for (const r of tasksProcListEl.children) {
    r.classList.toggle('is-selected', Number(r.dataset.pid) === window._tasksState.selectedPid);
  }
  playSfx?.('click');
});

tasksRefreshBtnEl?.addEventListener('click', () => {
  playSfx?.('click');
  refreshTasksNow();
});

tasksFlushBtnEl?.addEventListener('click', async () => {
  if (!window.dash?.flushRam) return;
  tasksFlushBtnEl.classList.add('is-busy');
  try {
    const r = await window.dash.flushRam();
    if (r?.flushed != null) {
      console.log(`[tasks] flush — ${r.flushed} working sets dropped (${r.failed || 0} failed)`);
      playSfx?.('confirm');
    } else {
      playSfx?.('error');
    }
  } catch (err) {
    console.warn('[tasks] flush failed:', err?.message || err);
    playSfx?.('error');
  } finally {
    tasksFlushBtnEl.classList.remove('is-busy');
    refreshTasksNow();
  }
});

// ── First-run guided setup wizard ──────────────────────────────────────────
// Three-step overlay (WiFi → Location → Name) that opens automatically when
// cfg.setupCompleted is false, and on-demand via the topbar #setup-btn.
// Persists into the same config keys the rest of the app already reads:
//   weatherCity (object), altCity (object), userName (string), setupCompleted
const frOverlayEl = document.getElementById('first-run-overlay');
if (frOverlayEl) {
  const frCard       = frOverlayEl.querySelector('.fr-card');
  const frCloseBtn   = frOverlayEl.querySelector('#fr-close-btn');
  const frStepsEls   = frOverlayEl.querySelectorAll('.fr-step');
  const frPaneEls    = frOverlayEl.querySelectorAll('.fr-pane');
  // WiFi pane
  const frWifiSub        = frOverlayEl.querySelector('#fr-wifi-sub');
  const frWifiCurrent    = frOverlayEl.querySelector('#fr-wifi-current');
  const frWifiCurrentSsid= frOverlayEl.querySelector('#fr-wifi-current-ssid');
  const frWifiRescanBtn  = frOverlayEl.querySelector('#fr-wifi-rescan-btn');
  const frWifiListEl     = frOverlayEl.querySelector('#fr-wifi-list');
  const frWifiPassRow    = frOverlayEl.querySelector('#fr-wifi-password-row');
  const frWifiPassInput  = frOverlayEl.querySelector('#fr-wifi-password');
  const frWifiCancelBtn  = frOverlayEl.querySelector('#fr-wifi-cancel-btn');
  const frWifiConnectBtn = frOverlayEl.querySelector('#fr-wifi-connect-btn');
  const frWifiStatus     = frOverlayEl.querySelector('#fr-wifi-status');
  const frWifiSkipBtn    = frOverlayEl.querySelector('#fr-wifi-skip-btn');
  const frWifiNextBtn    = frOverlayEl.querySelector('#fr-wifi-next-btn');
  // Location pane
  const frLocInput   = frOverlayEl.querySelector('#fr-loc-input');
  const frLocResults = frOverlayEl.querySelector('#fr-loc-results');
  const frLocStatus  = frOverlayEl.querySelector('#fr-loc-status');
  const frLocBackBtn = frOverlayEl.querySelector('#fr-loc-back-btn');
  const frLocNextBtn = frOverlayEl.querySelector('#fr-loc-next-btn');
  // Name pane
  const frNameInput     = frOverlayEl.querySelector('#fr-name-input');
  const frNameBackBtn   = frOverlayEl.querySelector('#fr-name-back-btn');
  const frNameFinishBtn = frOverlayEl.querySelector('#fr-name-finish-btn');

  const STEPS = ['wifi', 'location', 'name'];
  let frPickedSsid = null;       // SSID currently selected in the scan list
  let frPickedLocation = null;   // geocoding hit selected for location step
  let frLocAbort = null;         // AbortController for in-flight geocoding

  // Animate every node tagged [data-fr-anim] with the per-letter pulse the
  // diagnostics overlay uses, so the wizard reads as part of the same UI.
  function _frScrambleAll() {
    frOverlayEl.querySelectorAll('[data-fr-anim]').forEach((el) => {
      const text = el.dataset.frAnimSrc != null ? el.dataset.frAnimSrc : el.textContent;
      el.dataset.frAnimSrc = text;
      _scrambleInto(el, text);
    });
  }

  function _frSetText(el, text) {
    if (!el) return;
    el.dataset.frAnimSrc = text;
    _scrambleInto(el, text);
  }

  function frShowStep(name) {
    frPaneEls.forEach((p) => p.classList.toggle('is-visible', p.dataset.frPane === name));
    const idx = STEPS.indexOf(name);
    frStepsEls.forEach((s, i) => {
      s.classList.toggle('is-active', i === idx);
      s.classList.toggle('is-done',   i <  idx);
    });
    if (name === 'wifi')     frPaintWifiInitial();
    if (name === 'location') setTimeout(() => frLocInput?.focus(), 60);
    if (name === 'name')     setTimeout(() => frNameInput?.focus(), 60);
  }

  function frOpen() {
    frOverlayEl.hidden = false;
    frShowStep('wifi');
    _frScrambleAll();
  }
  function frClose() { frOverlayEl.hidden = true; }

  // ── WiFi pane ─────────────────────────────────────────────────────
  async function frPaintWifiInitial() {
    frWifiListEl.hidden = true;
    frWifiPassRow.hidden = true;
    frWifiStatus.hidden = true;
    frPickedSsid = null;
    _frSetText(frWifiSub, 'CHECKING NETWORK…');
    if (!window.dash?.wifiStatus) {
      _frSetText(frWifiSub, 'WIFI CONTROL UNAVAILABLE · YOU CAN CONTINUE IF ALREADY ONLINE');
      return;
    }
    try {
      const st = await window.dash.wifiStatus();
      if (st?.connected && st.ssid) {
        frWifiCurrent.hidden = false;
        _frSetText(frWifiCurrentSsid, st.ssid);
        _frSetText(frWifiSub, 'YOU LOOK ONLINE · TAP CONTINUE OR PICK A DIFFERENT NETWORK');
      } else {
        frWifiCurrent.hidden = true;
        _frSetText(frWifiSub, 'NOT CONNECTED · CHOOSE A NETWORK BELOW');
        await frScanWifi();
      }
    } catch {
      _frSetText(frWifiSub, 'NETWORK CHECK FAILED · YOU CAN STILL CONTINUE');
    }
  }

  async function frScanWifi() {
    if (!window.dash?.wifiScan) return;
    _frSetText(frWifiSub, 'SCANNING…');
    frWifiListEl.hidden = false;
    frWifiListEl.replaceChildren();
    try {
      const r = await window.dash.wifiScan();
      const nets = r?.networks || [];
      if (!nets.length) {
        const li = document.createElement('li');
        li.className = 'fr-wifi-row';
        li.style.opacity = '0.5';
        li.innerHTML = `<span></span><span class="fr-wifi-ssid">No networks found</span><span></span>`;
        frWifiListEl.appendChild(li);
        _frSetText(frWifiSub, 'NO NETWORKS FOUND');
        return;
      }
      for (const n of nets) {
        const li = document.createElement('li');
        li.className = 'fr-wifi-row';
        li.dataset.ssid = n.ssid;
        const lit = Math.max(1, Math.min(4, Math.ceil((n.signal || 0) / 25)));
        const bars = [1,2,3,4].map((i) => `<span class="${i <= lit ? 'is-lit' : ''}"></span>`).join('');
        const locked = n.auth && !/open/i.test(n.auth);
        li.innerHTML = `
          <span class="fr-wifi-bars">${bars}</span>
          <span class="fr-wifi-ssid">${escapeText(n.ssid)}</span>
          <span class="fr-wifi-lock">${locked ? 'LOCK' : 'OPEN'}</span>
        `;
        li.dataset.locked = locked ? '1' : '0';
        frWifiListEl.appendChild(li);
      }
      _frSetText(frWifiSub, `${nets.length} NETWORK${nets.length === 1 ? '' : 'S'} FOUND`);
    } catch (err) {
      _frSetText(frWifiSub, 'SCAN FAILED · ' + (err?.message || ''));
    }
  }

  frWifiListEl?.addEventListener('click', (e) => {
    const row = e.target.closest?.('.fr-wifi-row');
    if (!row || !row.dataset.ssid) return;
    frWifiListEl.querySelectorAll('.fr-wifi-row').forEach(r => r.classList.toggle('is-selected', r === row));
    frPickedSsid = row.dataset.ssid;
    const locked = row.dataset.locked === '1';
    if (locked) {
      frWifiPassRow.hidden = false;
      setTimeout(() => frWifiPassInput?.focus(), 40);
    } else {
      frWifiPassRow.hidden = true;
      frConnectWifi(frPickedSsid, '');
    }
    playSfx?.('click');
  });

  async function frConnectWifi(ssid, password) {
    if (!window.dash?.wifiConnect) return;
    frWifiStatus.hidden = false;
    frWifiStatus.classList.remove('is-error', 'is-ok');
    frWifiStatus.textContent = `CONNECTING TO ${ssid}…`;
    frWifiConnectBtn?.setAttribute('disabled', 'true');
    try {
      const r = await window.dash.wifiConnect(ssid, password);
      if (r?.ok) {
        frWifiStatus.classList.add('is-ok');
        frWifiStatus.textContent = `CONNECTED TO ${r.ssid || ssid}`;
        frWifiPassRow.hidden = true;
        frWifiCurrent.hidden = false;
        _frSetText(frWifiCurrentSsid, r.ssid || ssid);
        playSfx?.('confirm');
      } else {
        frWifiStatus.classList.add('is-error');
        frWifiStatus.textContent = r?.error || 'Connection failed';
        playSfx?.('error');
      }
    } catch (err) {
      frWifiStatus.classList.add('is-error');
      frWifiStatus.textContent = err?.message || 'Connection failed';
    } finally {
      frWifiConnectBtn?.removeAttribute('disabled');
    }
  }

  frWifiRescanBtn?.addEventListener('click', () => {
    frWifiCurrent.hidden = true;
    frScanWifi();
  });
  frWifiSkipBtn?.addEventListener('click',  () => frShowStep('location'));
  frWifiNextBtn?.addEventListener('click',  () => frShowStep('location'));
  frWifiCancelBtn?.addEventListener('click', () => {
    frWifiPassRow.hidden = true;
    frWifiPassInput.value = '';
    frPickedSsid = null;
    frWifiListEl.querySelectorAll('.fr-wifi-row').forEach(r => r.classList.remove('is-selected'));
  });
  frWifiConnectBtn?.addEventListener('click', () => {
    const pw = frWifiPassInput.value || '';
    if (!frPickedSsid) return;
    frConnectWifi(frPickedSsid, pw);
  });
  frWifiPassInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') frWifiConnectBtn?.click();
  });

  // ── Location pane (Open-Meteo geocoding search) ────────────────────
  function frRenderLocResults(hits) {
    frLocResults.replaceChildren();
    if (!hits || !hits.length) {
      frLocNextBtn.disabled = true;
      return;
    }
    for (const hit of hits) {
      const li = document.createElement('li');
      li.className = 'fr-loc-row';
      const region = [hit.admin1, hit.country_code || hit.country].filter(Boolean).join(' · ');
      li.innerHTML = `
        <span class="fr-loc-name">${escapeText(hit.name || '—')}</span>
        <span class="fr-loc-region">${escapeText(region)}</span>
      `;
      li.addEventListener('click', () => {
        frLocResults.querySelectorAll('.fr-loc-row').forEach(r => r.classList.remove('is-selected'));
        li.classList.add('is-selected');
        frPickedLocation = {
          name: hit.name,
          latitude: hit.latitude,
          longitude: hit.longitude,
          timezone: hit.timezone,
          country: hit.country_code || hit.country,
          admin1: hit.admin1,
        };
        frLocNextBtn.disabled = false;
        playSfx?.('click');
      });
      frLocResults.appendChild(li);
    }
  }

  let _frLocDebounce = null;
  async function frSearchLocation(q) {
    if (frLocAbort) { try { frLocAbort.abort(); } catch {} }
    frLocAbort = new AbortController();
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;
      const res = await fetch(url, { signal: frLocAbort.signal });
      if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
      const data = await res.json();
      const hits = data.results || [];
      frRenderLocResults(hits);
      frLocStatus.hidden = hits.length !== 0;
      if (!hits.length) {
        frLocStatus.hidden = false;
        frLocStatus.classList.remove('is-error');
        frLocStatus.textContent = `NO MATCHES FOR "${q.toUpperCase()}"`;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      frLocStatus.hidden = false;
      frLocStatus.classList.add('is-error');
      frLocStatus.textContent = err?.message || 'Lookup failed';
    }
  }
  frLocInput?.addEventListener('input', () => {
    const q = frLocInput.value.trim();
    frPickedLocation = null;
    frLocNextBtn.disabled = true;
    frLocStatus.hidden = true;
    clearTimeout(_frLocDebounce);
    if (q.length < 2) {
      frLocResults.replaceChildren();
      return;
    }
    _frLocDebounce = setTimeout(() => frSearchLocation(q), 280);
  });
  frLocBackBtn?.addEventListener('click', () => frShowStep('wifi'));
  frLocNextBtn?.addEventListener('click', async () => {
    if (!frPickedLocation) return;
    try {
      // Save into the same keys the rest of the app already consumes:
      // weatherCity drives the WEATHER panel; altCity drives the primary
      // alt-clock in CHRONO. activeLocation gets a live update so the
      // weather panel refreshes without a reload.
      await window.dash?.setConfig?.({
        weatherCity: frPickedLocation,
        altCity: { name: frPickedLocation.name, timezone: frPickedLocation.timezone, country: frPickedLocation.country },
      });
      activeLocation = frPickedLocation;
      try {
        if (weatherCityEl) weatherCityEl.value = frPickedLocation.name || '';
        loadWeather(frPickedLocation);
        if (weatherTimer) clearInterval(weatherTimer);
        weatherTimer = setInterval(() => loadWeather(frPickedLocation), 10 * 60 * 1000);
      } catch {}
      try { applyAltLocation({ name: frPickedLocation.name, timezone: frPickedLocation.timezone, country: frPickedLocation.country }); } catch {}
    } catch (err) {
      console.warn('[setup] location save failed:', err?.message || err);
    }
    frShowStep('name');
  });

  // ── Name pane ─────────────────────────────────────────────────────
  frNameBackBtn?.addEventListener('click', () => frShowStep('location'));
  frNameFinishBtn?.addEventListener('click', async () => {
    const name = (frNameInput.value || '').trim();
    try {
      await window.dash?.setConfig?.({ userName: name, setupCompleted: true });
    } catch {}
    applyUserName(name);
    frClose();
    playSfx?.('confirm');
  });
  frNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') frNameFinishBtn?.click();
  });

  // Close button — skips setup but still marks it completed so it doesn't
  // re-open every boot. The user can re-trigger via the topbar Setup btn.
  frCloseBtn?.addEventListener('click', async () => {
    try { await window.dash?.setConfig?.({ setupCompleted: true }); } catch {}
    frClose();
  });

  // Expose open() so the topbar Setup button (wired further below) can
  // re-launch the wizard at any time.
  window._frOpenSetup = frOpen;
}

function applyUserName(name) {
  const chip = document.getElementById('user-name-chip');
  if (!chip) return;
  const trimmed = String(name || '').trim();
  if (!trimmed) { chip.hidden = true; chip.textContent = ''; return; }
  chip.hidden = false;
  chip.textContent = trimmed.toUpperCase();
}

// Topbar Setup button — re-opens the wizard on demand. Available even
// after first-run so the user can change WiFi / location / name later.
document.querySelector('#setup-btn')?.addEventListener('click', () => {
  if (window._frOpenSetup) window._frOpenSetup();
});

// Boot-time check — if cfg.setupCompleted is false (or undefined), open
// the wizard automatically. Always apply the saved user name to the
// topbar chip, completed or not.
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.userName) applyUserName(cfg.userName);
  if (!cfg.setupCompleted && window._frOpenSetup) {
    // Defer one tick so the rest of the boot config has applied before
    // the overlay paints (avoids the wizard flashing over an unstyled UI).
    setTimeout(() => window._frOpenSetup(), 250);
  }
})();

// SFX toggle button — flips the global mute and persists. The document
// delegate above plays a 'click' first (still-enabled-state), then this
// handler toggles mute. On re-enable we explicitly play 'confirm' so
// there's an audible cue that sound is back on.
document.querySelector('#sfx-btn')?.addEventListener('click', async () => {
  setSfxEnabled(!_sfxEnabled);
  if (_sfxEnabled) playSfx('confirm');
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ sfxEnabled: _sfxEnabled }); } catch {}
  }
});
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.sfxEnabled === false) setSfxEnabled(false);
})();

// Version chip — pulled from package.json via the main process so the topbar
// label stays in sync with the manifest without a renderer rebuild.
(async () => {
  const el = document.querySelector('#version-chip');
  if (!el) return;
  try {
    const v = await window.dash?.appVersion?.();
    if (v) el.textContent = `v${v}`;
  } catch {}
})();

// ── Themes / display toggles ────────────────────────────────────────────────
// Default palette + one Cyberpunk section (4 variants). Pretty labels for
// the topbar chip — the slug (data-theme value) is what gets persisted.
const THEME_LABELS = {
  '':             'DEFAULT',
  'cyber-neon':     'CYBER · NEON',
  'cyber-moody':    'CYBER · MOODY',
  'cyber-violet':   'CYBER · VIOLET',
  'cyber-dark':     'CYBER · DARK',
  'cyber-runner':   'CYBER · RUNNER',
  'cyber-2077':     'CYBER · 2077',
  'cyber-akira':    'CYBER · AKIRA',
  'cyber-synthwave':'CYBER · SYNTHWAVE',
  'pastel-bloom': 'PASTEL · BLOOM',
  'pastel-sky':   'PASTEL · SKY',
  'pastel-spring':'PASTEL · SPRING',
  'pastel-sunset':'PASTEL · SUNSET',
  'pastel-mist':  'PASTEL · MIST',
  'pastel-lilac': 'PASTEL · LILAC',
  'pastel-sorbet':'PASTEL · SORBET',
  'pastel-candy': 'PASTEL · CANDY',
  'earth-clay':    'MUTED · CLAY',
  'earth-moss':    'MUTED · MOSS',
  'earth-sand':    'MUTED · SAND',
  'earth-stone':   'MUTED · STONE',
  'earth-paper':   'MUTED · PAPER',
  'earth-eink':    'MUTED · EINK',
  'earth-sepia':   'MUTED · SEPIA',
  'earth-charcoal':'MUTED · CHARCOAL',
};
const THEME_SLUGS = new Set(Object.keys(THEME_LABELS).filter(Boolean));
// Cycle order — default first, then walks every section in dropdown order.
const THEME_CYCLE = ['', ...Object.keys(THEME_LABELS).filter(Boolean)];

const themeNameEl = document.querySelector('#theme-name');
function applyTheme(name) {
  if (!name) document.documentElement.removeAttribute('data-theme');
  else       document.documentElement.setAttribute('data-theme', name);
  if (themeNameEl) themeNameEl.textContent = THEME_LABELS[name || ''] || 'DEFAULT';
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

// Theme picker — a small dropdown attached to the topbar #theme-btn. Each
// .theme-menu-item carries the slug in data-theme-pick (empty string for
// the default palette). Document-level click closes the menu when the
// user clicks anywhere else.
const themePickerEl  = document.getElementById('theme-picker');
const themeTriggerEl = document.getElementById('theme-name');   // doubles as label + dropdown trigger
const themeMenuEl    = document.getElementById('theme-menu');
const themeAutoBtnEl = document.getElementById('theme-auto-btn');

function _themeSetPickerActive(name) {
  if (!themeMenuEl) return;
  const slug = name || '';
  themeMenuEl.querySelectorAll('.theme-menu-item').forEach((b) => {
    b.classList.toggle('is-active', (b.dataset.themePick || '') === slug);
  });
}

function _themeOpenMenu(open) {
  if (!themeMenuEl || !themeTriggerEl) return;
  themeMenuEl.hidden = !open;
  themeTriggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

themeTriggerEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  _themeOpenMenu(themeMenuEl?.hidden);
  playSfx?.('click');
});

// Cycle button — next theme in THEME_CYCLE, persists. Wraps at end.
async function advanceTheme(step = 1) {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const cur = cfg.theme && THEME_SLUGS.has(cfg.theme) ? cfg.theme : '';
  const idx = THEME_CYCLE.indexOf(cur);
  const len = THEME_CYCLE.length;
  const next = THEME_CYCLE[((idx + step) % len + len) % len];
  const slug = next || null;
  setUserTheme(slug);
  _themeSetPickerActive(slug);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ theme: slug }); } catch {}
  }
  playSfx?.('click');
}
document.querySelector('#theme-cycle-btn')?.addEventListener('click', () => advanceTheme(1));

// Background pattern cycle — one button steps through the 8 variants.
// Default is 'grid' (no data attribute needed but kept explicit so the
// cycle index stays stable). Persisted under cfg.bgPattern.
const BG_PATTERNS = [
  'grid', 'dots', 'diagonal', 'diamond',
  'triangles', 'hexagons', 'herringbone', 'circuit',
];
function setBgPattern(name) {
  const slug = BG_PATTERNS.includes(name) ? name : 'grid';
  document.body.setAttribute('data-bg-pattern', slug);
  return slug;
}
async function cycleBgPattern(step = 1) {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const cur = cfg.bgPattern && BG_PATTERNS.includes(cfg.bgPattern) ? cfg.bgPattern : 'grid';
  const idx = BG_PATTERNS.indexOf(cur);
  const len = BG_PATTERNS.length;
  const next = BG_PATTERNS[((idx + step) % len + len) % len];
  setBgPattern(next);
  // Update the topbar button's title so the user can see what's active.
  const btn = document.getElementById('bg-pattern-btn');
  if (btn) btn.title = `Background · ${next.toUpperCase()}`;
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ bgPattern: next }); } catch {}
  }
  playSfx?.('click');
}
document.getElementById('bg-pattern-btn')?.addEventListener('click', () => cycleBgPattern(1));

// Topbar Hz control — steps the global visualizer refresh rate ±5 Hz.
// Clamped to 10–200 Hz inside stepHz(). Persisted via cfg.audioFrameMs.
document.querySelector('#hz-down')?.addEventListener('click', () => { stepHz(-5); playSfx?.('click'); });
document.querySelector('#hz-up')?.addEventListener('click',   () => { stepHz(+5); playSfx?.('click'); });

// Auto-cycle — flip to the next theme every 20s when active. Persisted
// across launches as cfg.themeAuto so users opt in once.
const THEME_AUTO_MS = 20000;
let _themeAutoTimer = null;
function setThemeAuto(on) {
  themeAutoBtnEl?.classList.toggle('is-active', !!on);
  if (_themeAutoTimer) { clearInterval(_themeAutoTimer); _themeAutoTimer = null; }
  if (on) _themeAutoTimer = setInterval(() => advanceTheme(1), THEME_AUTO_MS);
}
themeAutoBtnEl?.addEventListener('click', async () => {
  const cfg  = (await window.dash?.getConfig?.()) || {};
  const next = !cfg.themeAuto;
  setThemeAuto(next);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ themeAuto: next }); } catch {}
  }
  playSfx?.('click');
});
themeMenuEl?.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('.theme-menu-item');
  if (!btn) return;
  const slug = btn.dataset.themePick || '';
  const next = slug || null;
  setUserTheme(next);
  _themeSetPickerActive(next);
  _themeOpenMenu(false);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ theme: next }); } catch {}
  }
  playSfx?.('confirm');
});
// Click-outside-to-close. Single document handler; the button's own
// click stops propagation above so it doesn't immediately re-close.
document.addEventListener('click', (e) => {
  if (!themeMenuEl || themeMenuEl.hidden) return;
  if (themePickerEl?.contains(e.target)) return;
  _themeOpenMenu(false);
});

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
  // All children with an id — used for saved-order persistence and
  // restore. topbarDraggables() filters out wrappers like #theme-picker
  // that host their own click handlers; making those draggable would
  // swallow the button's clicks.
  function topbarItems()      { return Array.from(topbarEl.children).filter((c) => c.id); }
  function topbarDraggables() { return topbarItems().filter((c) => c.dataset.noDrag !== 'true'); }
  for (const el of topbarDraggables()) {
    el.draggable = true;
  }
  let _dragged = null;
  topbarEl.addEventListener('dragstart', (e) => {
    if (_uiLocked) { e.preventDefault(); return; }
    const t = e.target.closest && e.target.closest('.topbar-controls > *');
    if (!t || t.parentElement !== topbarEl) return;
    _dragged = t;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Centre the drag ghost on the cursor. Without this the browser
      // pins the ghost to the cursor at whatever offset you grabbed —
      // grab the icon's left edge and the ghost trails to the right;
      // grab the right edge and it trails to the left. Centring keeps
      // the ghost directly under the pointer regardless of grab point.
      const r = t.getBoundingClientRect();
      try { e.dataTransfer.setDragImage(t, r.width / 2, r.height / 2); } catch {}
    }
    // Apply the dim class on the *next* frame so the drag-image snapshot
    // (captured during this dragstart turn) uses the original opacity
    // instead of the half-faded look meant for the real element.
    requestAnimationFrame(() => t.classList.add('is-topbar-dragging'));
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
    // If the saved order was written before a button was removed (e.g.
    // the old #restart-btn) — or in any other shape that no longer
    // matches the current HTML — discard it and use the new HTML
    // default. Without this, users who had previously dragged the
    // topbar around would never see new groupings on update.
    const stale = ['restart-btn', 'refresh-btn', 'auto-orient-btn', 'side-arrange-btn', 'eco-mode-btn', 'airplane-btn', 'offline-btn'];
    // Also reset if the saved order pre-dates the introduction of any
    // of these wrappers — without them slotted in, restore would drop
    // them at the end of the bar instead of where the HTML places them.
    const requiredNew = ['theme-picker', 'setup-btn', 'user-name-chip', 'hz-control', 'bg-pattern-btn'];
    const missing = requiredNew.some((id) => !ids.includes(id) && document.getElementById(id));
    if (stale.some((id) => ids.includes(id)) || missing) {
      if (window.dash?.setConfig) {
        try { await window.dash.setConfig({ topbarOrder: null }); } catch {}
      }
      return;
    }
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

// setThemeAuto is defined above with the rest of the theme-picker wiring.

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
  _termTelemetryTimer = setInterval(() => {
    if (!document.hidden) gatherTelemetry();
  }, seconds * 1000);
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
