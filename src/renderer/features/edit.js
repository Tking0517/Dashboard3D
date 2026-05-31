// EDIT ROOM — DaVinci-Resolve-Cut-page-flavored video editor.
//
// Phase 1A: bin browsing, single viewer, 2V+1A timeline, tool-mode toggles
// (Selection/Trim/Razor), snap, in/out source markers, fast-add buttons
// (append + smart-insert + place-on-top + ripple + close-up + source-
// overwrite), JKL transport, keyboard shortcuts, delete-selected.
//
// Out of scope this phase: WebCodecs frame-accurate scrub, dual timeline,
// audio waveform, ffmpeg export, transitions, filters.
//
// Lifecycle (driven by app.js's setComboMode):
//   init(deps)    — wire DOM event handlers + initial paint, ONE-TIME.
//   activate()    — refresh bin, paint timeline, install keyboard shim.
//   deactivate()  — pause video, uninstall keyboard shim, stop any rAF.
//
// CPU-safety: every rAF loop in here gates on `_active === true`. Leaving
// EDIT mode (deactivate) flips _active false and the next tick exits the
// loop. This is the deliberate design lesson from the disabled-in-place
// editor in visualizer.js which leaked rAFs when not visible.

import { groupSequences, extOf } from '../util/sequences.js';

const _VIDEO_RE = /\.(mp4|webm|m4v|ogv|ogg|mov|mkv)$/i;
// Explicit image blacklist — used as a defensive double-check in the
// drop / select / export paths. Anything ending in one of these gets
// rejected with a friendly error before it can reach the <video>
// element, _probeDuration, ffmpeg, etc. — any one of which could
// crash or hang on a non-video input.
const _IMAGE_RE = /\.(png|jpe?g|webp|bmp|tiff?|avif|gif|svg)$/i;
const CAPTURE_ROOTS = ['videos', 'recordings', 'screencap'];

// ── State ────────────────────────────────────────────────────────────

let _ready = false;
let _active = false;
let _deps = null;

// Bin = flat list of media files harvested from gallery/{videos,recordings,
// screencap}/**. Each: { path, rel, name, mtime, duration, fps }.
const _bin = [];
let _binSelected = null; // entry from _bin, currently loaded in the viewer

// Source-clip in/out marks (seconds). When the user fires a fast-add,
// only the marked range is placed on the timeline (or the whole clip
// if marks are unset).
let _markIn  = null;
let _markOut = null;

// Project = the timeline state.
const _project = {
  fps: 30,
  pxPerSec: 80,         // timeline zoom
  playheadTime: 0,      // seconds
  selectedClipId: null,        // PRIMARY selection — drives the inspect pane.
  selectedClipIds: new Set(),  // FULL selection — multi-select. Always includes selectedClipId.
  tracks: { V2: [], V1: [], A1: [] },
};
window._editProject = _project; // surfaced for app.js paint-header

// Tool mode: 'select' | 'trim' | 'razor'. Snap is a separate boolean.
let _tool = 'select';
let _snap = true;
let _viewerMode = 'source'; // 'source' | 'timeline'

// Temporal-denoise state. When armed, _denoise.on === true; strength
// is 0-100 mapping to ffmpeg hqdn3d's luma_tmp / chroma_tmp values on
// export. Live preview applies a CSS filter that approximates the
// "soft, smooth" look of temporal cleanup. Surfaced on window so any
// export pipeline that lands later can read the current denoise
// state without reaching back into this module's closure.
const _denoise = { on: false, strength: 60 };
window._editDenoise = _denoise;

// ── COLOR (DaVinci-style per-clip grading) ─────────────────────────
// Each timeline clip carries an optional `color` object that drives:
//   • the live <video> filter chain (CSS saturate/contrast/brightness/
//     hue-rotate + the SVG #edit-color-svg filter for gamma + sharpen)
//   • the export pipeline (ffmpeg eq + unsharp — TODO wire on export)
// Defaults reflect "no change" — at 100/100/100/100/0/0 the filter
// graph is an identity. Slider ranges:
//   sat  0-200 (CSS saturate 0.0 - 2.0)
//   con  0-200 (CSS contrast 0.0 - 2.0)
//   brt  0-200 (CSS brightness 0.0 - 2.0)
//   gam 50-200 (SVG feFuncN exponent 0.5 - 2.0 — lower = darker mids)
//   hue -180..180 (CSS hue-rotate)
//   shrp 0-100 (SVG feConvolveMatrix unsharp 3x3, capped intensity)
const COLOR_DEFAULTS = Object.freeze({ sat: 100, con: 100, brt: 100, gam: 100, hue: 0, shrp: 0 });
function _ensureColor(clip) {
  if (!clip) return null;
  if (!clip.color) clip.color = { ...COLOR_DEFAULTS };
  for (const k of Object.keys(COLOR_DEFAULTS)) {
    if (typeof clip.color[k] !== 'number') clip.color[k] = COLOR_DEFAULTS[k];
  }
  return clip.color;
}
function _colorIsIdentity(c) {
  if (!c) return true;
  return c.sat === 100 && c.con === 100 && c.brt === 100
      && c.gam === 100 && c.hue === 0 && c.shrp === 0;
}
// Cache the slider DOM nodes once the pane has rendered. Populated
// lazily because the COLOR section is in the INSPECT body which is
// always present in the page (no dynamic mount), but the calls can
// arrive before _grabDom() runs.
let _colorEls = null;
let _colorValEls = null;
function _ensureColorBindings() {
  if (_colorEls) return;
  const keys = ['sat', 'con', 'brt', 'gam', 'hue', 'shrp'];
  _colorEls = {};
  _colorValEls = {};
  for (const k of keys) {
    _colorEls[k] = document.getElementById(`edit-color-${k}`);
    _colorValEls[k] = document.getElementById(`edit-color-${k}-v`);
  }
}
// PROXY button — manual per-clip scrub-cache toggle. Lit when ready.
// Mid-generation it shows a busy indicator + click to cancel. Hidden
// (disabled) when no timeline clip is selected or the clip is an image.
function _renderProxyBtn() {
  const btn = document.getElementById('edit-proxy-btn');
  if (!btn) return;
  const sel = _findSelectedClip();
  if (!sel || sel.clip.kind === 'image') {
    btn.disabled = true;
    btn.classList.remove('is-active', 'is-busy');
    btn.textContent = 'PROXY';
    btn.title = sel ? 'Proxies don\'t apply to image clips' : 'Select a timeline clip first';
    return;
  }
  btn.disabled = false;
  const state = _proxyByPath.get(sel.clip.path);
  if (state?.status === 'ready') {
    btn.classList.add('is-active');
    btn.classList.remove('is-busy');
    btn.textContent = 'PROXY ✓';
    btn.title = 'Proxy cached — scrubbing uses it. Click to delete.';
  } else if (state?.status === 'generating' || state?.status === 'requesting') {
    btn.classList.remove('is-active');
    btn.classList.add('is-busy');
    btn.textContent = 'PROXY ⌛';
    btn.title = 'Generating in background — click to cancel';
  } else {
    btn.classList.remove('is-active', 'is-busy');
    btn.textContent = 'PROXY';
    btn.title = 'Generate scrub cache for this clip\'s source';
  }
}

function _renderColorPanel() {
  _ensureColorBindings();
  const sel = _findSelectedClip();
  const color = sel ? _ensureColor(sel.clip) : COLOR_DEFAULTS;
  for (const k of Object.keys(COLOR_DEFAULTS)) {
    if (_colorEls[k]) _colorEls[k].value = String(color[k]);
    if (_colorValEls[k]) _colorValEls[k].textContent = String(color[k]);
  }
  // Disable when nothing on the timeline is selected — color is
  // per-clip in this build.
  const panelEl = document.querySelector('.edit-inspect-color');
  if (panelEl) panelEl.classList.toggle('is-disabled', !sel);
  const resetBtn = document.getElementById('edit-color-reset');
  if (resetBtn) resetBtn.disabled = !sel;
}

function _applyColorToViewer(color) {
  if (!viewerVideo) return;
  const c = color || COLOR_DEFAULTS;
  // Identity case: clear the inline filter entirely so any existing
  // theme-level filter on .edit-viewer-video (denoise preview, etc.)
  // keeps applying. Setting `filter: none` would override them.
  if (_colorIsIdentity(c)) {
    viewerVideo.style.filter = '';
    return;
  }
  viewerVideo.style.filter =
      `saturate(${c.sat / 100}) ` +
      `contrast(${c.con / 100}) ` +
      `brightness(${c.brt / 100}) ` +
      `hue-rotate(${c.hue}deg) ` +
      `url(#edit-color-svg)`;
  // Gamma — feFuncR/G/B exponent. The slider's 50..200 maps directly
  // to exponent 0.5..2.0 by dividing by 100. exponent=1 is identity.
  const gammaExp = Math.max(0.1, c.gam / 100);
  const gnode = document.getElementById('edit-color-gamma-node');
  if (gnode) {
    for (const fn of gnode.querySelectorAll('feFuncR, feFuncG, feFuncB')) {
      fn.setAttribute('exponent', String(gammaExp));
    }
  }
  // Sharpen — unsharp 3x3 [0,-α,0,-α,1+4α,-α,0,-α,0]. Cap α at 0.6 so
  // even a fully-cranked slider doesn't produce ringing artifacts on
  // top of the already-aggressive proxy compression.
  const alpha = (c.shrp || 0) / 100 * 0.6;
  const center = 1 + 4 * alpha;
  const snode = document.getElementById('edit-color-sharp-node');
  if (snode) {
    snode.setAttribute('kernelMatrix',
      `0 ${-alpha} 0  ${-alpha} ${center} ${-alpha}  0 ${-alpha} 0`);
  }
}

// ── Undo / redo stacks ──────────────────────────────────────────
// Each entry is a deep-clone JSON snapshot of _project.tracks +
// _markIn / _markOut + selectedClipId. Tracks the basic timeline
// state — clip add/remove/move/trim/cut + mark changes. NOT tracked:
// viewer zoom level, tool mode, snap toggle (those are session-level
// preferences, not project edits). Stacks are capped at 50 deep so
// long sessions don't accumulate unbounded memory.
const _HISTORY_MAX = 50;
const _undoStack = [];
const _redoStack = [];
function _snapshotProject() {
  return JSON.stringify({
    tracks: _project.tracks,
    markIn: _markIn,
    markOut: _markOut,
    selectedClipId: _project.selectedClipId,
    selectedClipIds: [..._project.selectedClipIds],
  });
}
function _restoreProject(snap) {
  try {
    const s = JSON.parse(snap);
    _project.tracks = s.tracks || { V2: [], V1: [], A1: [] };
    _markIn  = (typeof s.markIn  === 'number') ? s.markIn  : null;
    _markOut = (typeof s.markOut === 'number') ? s.markOut : null;
    _project.selectedClipId = s.selectedClipId ?? null;
    _project.selectedClipIds = new Set(Array.isArray(s.selectedClipIds) ? s.selectedClipIds : (s.selectedClipId != null ? [s.selectedClipId] : []));
  } catch (err) {
    console.warn('[edit] history restore failed:', err);
  }
}
// Public hook — call BEFORE any mutation that should be undoable.
// Pushes the current snapshot onto _undoStack and clears _redoStack
// (the "branch" semantics every NLE uses: editing after an undo
// discards the redo trail).
function _pushHistory() {
  _undoStack.push(_snapshotProject());
  while (_undoStack.length > _HISTORY_MAX) _undoStack.shift();
  _redoStack.length = 0;
  _updateHistoryButtons();
}
function _updateHistoryButtons() {
  const u = document.getElementById('edit-tool-undo');
  const r = document.getElementById('edit-tool-redo');
  if (u) u.disabled = _undoStack.length === 0;
  if (r) r.disabled = _redoStack.length === 0;
}
function _undo() {
  if (!_undoStack.length) return;
  _redoStack.push(_snapshotProject());
  _restoreProject(_undoStack.pop());
  _renderTimeline();
  _renderInspect();
  _syncViewerToPlayhead();
  _updateHistoryButtons();
  _setStatus('UNDO', 'ok');
}
function _redo() {
  if (!_redoStack.length) return;
  _undoStack.push(_snapshotProject());
  _restoreProject(_redoStack.pop());
  _renderTimeline();
  _renderInspect();
  _syncViewerToPlayhead();
  _updateHistoryButtons();
  _setStatus('REDO', 'ok');
}

// ── Viewer zoom + pan ───────────────────────────────────────────
// Zoom level is a multiplier on the viewer's <video> element via a
// CSS transform applied inline. Pan offset is in fraction-of-stage
// units (-0.5..0.5) so the user can drag the framed crop while
// zoomed in. Reset by clicking 1:1, hitting the keyboard 0 shortcut,
// or scrolling the wheel back to 1.0.
const _zoom = { level: 1.0, x: 0, y: 0 };
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 8.0;
const ZOOM_STEP = 0.25;
function _applyZoom() {
  const v = document.getElementById('edit-viewer-video');
  const hud = document.getElementById('edit-viewer-zoom-hud');
  const val = document.getElementById('edit-viewer-zoom-val');
  if (!v) return;
  // Clamp + apply transform. Translate runs in % of element size,
  // adjusted so the pan vector reads as "drag the visible portion".
  _zoom.level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, _zoom.level));
  const tx = (_zoom.x * 100).toFixed(2);
  const ty = (_zoom.y * 100).toFixed(2);
  v.style.transform = `translate(${tx}%, ${ty}%) scale(${_zoom.level.toFixed(3)})`;
  v.style.transformOrigin = 'center center';
  v.classList.toggle('is-zoomed', _zoom.level > 1.001);
  if (val) val.textContent = `${Math.round(_zoom.level * 100)}%`;
  if (hud) hud.hidden = _zoom.level <= 1.001;
}
// anchorX/anchorY are in fraction-of-stage units, measured from the
// stage center (range -0.5..+0.5). When passed, the point under the
// cursor stays fixed in screen space as the zoom level changes — so
// scrolling the wheel feels like the cursor is the zoom origin. When
// omitted (button + keyboard), zoom centers on the stage.
function _zoomBy(delta, anchorX, anchorY) {
  const prev = _zoom.level;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev + delta));
  if (next === prev) return;
  if (next <= 1.001) {
    _zoom.level = next; _zoom.x = 0; _zoom.y = 0;
  } else {
    const ax = anchorX ?? 0;
    const ay = anchorY ?? 0;
    const ratio = next / prev;
    // Keep the video-space point currently at (ax, ay) fixed under the
    // cursor as zoom changes: x' = ax*(1 - L'/L) + x*(L'/L).
    _zoom.x = ax * (1 - ratio) + _zoom.x * ratio;
    _zoom.y = ay * (1 - ratio) + _zoom.y * ratio;
    _zoom.level = next;
    const limit = (1 - 1 / next) * 0.5;
    _zoom.x = Math.max(-limit, Math.min(limit, _zoom.x));
    _zoom.y = Math.max(-limit, Math.min(limit, _zoom.y));
  }
  _applyZoom();
}
function _resetZoom() {
  _zoom.level = 1.0; _zoom.x = 0; _zoom.y = 0;
  _applyZoom();
}

// Transport: dir is -1 / 0 / +1. rateMult escalates on repeated J/L taps.
let _playDir = 0;
let _playRate = 1;
let _lastTransportTap = 0;

// Clip ID counter — monotonic across the session.
let _clipSeq = 0;

// rAF handle for the playhead/viewer sync loop. Reset to null on cancel.
let _rafHandle = null;

// Keyboard handler (installed on document during activate, removed on
// deactivate so it doesn't intercept keys when the user is in NOTES etc).
let _kbHandler = null;

// ── DOM refs (populated in init) ─────────────────────────────────────

let paneEl, binListEl, binRefreshBtn;
let viewerVideo, viewerImg, viewerEmpty, viewerStage, viewerTcEl;
let toolBtns, snapBtn, zoomInput, statusEl, readoutEl;
let trackV1El, trackV2El, trackA1El, rulerEl, playheadEl, tlContent, tlScroll;
let viewerModeBtns;
let fastAddBtns = {};
let transportBtns = {};
let insName, insDur, insIn, insOut, insFps;

// ── Helpers ──────────────────────────────────────────────────────────

function _fmtTc(secs) {
  // HH:MM:SS:FF (frames at project fps)
  const s = Math.max(0, secs || 0);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const f  = Math.floor((s - Math.floor(s)) * _project.fps);
  const pad = (n, w=2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}:${pad(f)}`;
}

function _setStatus(text, kind) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = 'edit-tools-status' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
}

// Live state readout — always visible at the top of the timeline. Shows
// what the editor THINKS its state is, so the user (and future-me) can
// debug "why didn't X happen" without DevTools. Cheap to call — just
// flips text. Hook every state mutation that affects what's displayed.
function _paintReadout() {
  if (!readoutEl) return;
  const tool = (_tool || 'select').toUpperCase();
  const view = (_viewerMode || 'source').toUpperCase();
  const tc   = _fmtTc(_project.playheadTime);
  const nClips = _project.tracks.V2.length + _project.tracks.V1.length + _project.tracks.A1.length;
  const sel = _project.selectedClipId != null ? ' · SEL #' + _project.selectedClipId : '';
  // "Playhead-over" hint: tells the user whether the playhead is
  // currently inside any clip, and on which track. Critical for razor
  // mode — you can SEE before clicking whether the cut will succeed
  // or refuse with "PLAYHEAD NOT OVER THIS CLIP".
  const t = _project.playheadTime;
  let over = '';
  for (const tid of ['V2', 'V1', 'A1']) {
    const c = _project.tracks[tid].find((c) => t >= c.start && t < c.start + c.dur);
    if (c) { over += ` · ${tid}✓`; }
  }
  if (!over && nClips > 0) over = ' · GAP';
  readoutEl.textContent = `TOOL: ${tool} · VIEW: ${view} · TC: ${tc} · CLIPS: ${nClips}${over}${sel}`;
}

function _trackDuration(track) {
  // Track length = max(start + dur) across its clips.
  let end = 0;
  for (const c of track) {
    const e = (c.start || 0) + (c.dur || 0);
    if (e > end) end = e;
  }
  return end;
}
function _projectDuration() {
  return Math.max(_trackDuration(_project.tracks.V1),
                  _trackDuration(_project.tracks.V2),
                  _trackDuration(_project.tracks.A1));
}

// Viewport clientX → timeline time, in seconds. Uses tlContent's bounding
// rect which already accounts for the in-container scroll (left edge moves
// left as scrollLeft grows). Don't add scrollLeft back in here — that
// double-counted the scroll in earlier versions.
function _clientXToTime(clientX) {
  if (!tlContent) return 0;
  const rect = tlContent.getBoundingClientRect();
  const x = clientX - rect.left;
  return Math.max(0, x / _project.pxPerSec);
}

function _snapTime(t, ignoreClipId) {
  // Snap candidates: playhead + all clip starts/ends across all tracks.
  // Tolerance is ±6 timeline-px → convert to seconds via pxPerSec.
  if (!_snap) return t;
  const tolSec = 6 / _project.pxPerSec;
  let bestDiff = Infinity, best = t;
  const try_ = (cand) => {
    const d = Math.abs(cand - t);
    if (d < tolSec && d < bestDiff) { bestDiff = d; best = cand; }
  };
  try_(_project.playheadTime);
  for (const tid of ['V1', 'V2', 'A1']) {
    for (const c of _project.tracks[tid]) {
      if (c.id === ignoreClipId) continue;
      try_(c.start);
      try_(c.start + c.dur);
    }
  }
  return best;
}

// ── Bin (file list) ──────────────────────────────────────────────────

async function _refreshBin() {
  if (!window.dash?.galleryList) {
    _bin.length = 0;
    _renderBin();
    _setStatus('GALLERY BRIDGE UNAVAILABLE', 'error');
    return;
  }
  _bin.length = 0;
  try {
    // Walk each capture-root subdir one level deep. Most REC ROOM output
    // lands in date-stamped subdirs under recordings/ + screencap/.
    for (const root of CAPTURE_ROOTS) {
      const top = await window.dash.galleryList(root).catch(() => null);
      if (!top || !top.entries) continue;
      for (const e of top.entries) {
        if (e.isDir) {
          const sub = await window.dash.galleryList(`${root}/${e.name}`).catch(() => null);
          // SNAP SESSION FOLDERS: screencap/ subfolders hold the
          // sequential JPEGs from a single SNAP session. Surface the
          // whole folder as ONE bin entry (kind 'snap-folder') so the
          // user can stitch it to MP4 in one click rather than scrubbing
          // through dozens of individual JPEGs.
          if (root === 'screencap') {
            const imgs = (sub?.entries || [])
              .filter((f) => !f.isDir && _IMAGE_RE.test(f.name))
              .sort((a, b) => a.name.localeCompare(b.name));
            if (imgs.length) {
              _bin.push({
                path: e.path,
                rel:  e.rel || `${root}/${e.name}`,
                name: e.name,
                mtime: e.mtime || 0,
                size: imgs.reduce((s, f) => s + (f.size || 0), 0),
                kind: 'snap-folder',
                imageCount: imgs.length,
                imagePaths: imgs.map((f) => f.path),
                imageRels:  imgs.map((f) => f.rel || `${root}/${e.name}/${f.name}`),
                thumbRel:   imgs[0].rel || `${root}/${e.name}/${imgs[0].name}`,
                duration: imgs.length, // 1s/frame baseline; stitch picks actual hold
                fps: _project.fps,
              });
            }
            continue;
          }
          for (const f of (sub?.entries || [])) {
            if (f.isDir) continue;
            const kind = _VIDEO_RE.test(f.name) ? 'video' : _IMAGE_RE.test(f.name) ? 'image' : null;
            if (!kind) continue;
            _bin.push({
              path: f.path,
              rel:  f.rel || `${root}/${e.name}/${f.name}`,
              name: f.name,
              mtime: f.mtime || 0,
              size: f.size || 0,
              kind,
              duration: kind === 'image' ? 5 : 0,
              fps: _project.fps,
            });
          }
        } else {
          const kind = _VIDEO_RE.test(e.name) ? 'video' : _IMAGE_RE.test(e.name) ? 'image' : null;
          if (!kind) continue;
          _bin.push({
            path: e.path,
            rel:  e.rel || `${root}/${e.name}`,
            name: e.name,
            mtime: e.mtime || 0,
            size: e.size || 0,
            kind,
            duration: kind === 'image' ? 5 : 0,
            fps: _project.fps,
          });
        }
      }
    }
    _bin.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } catch (err) {
    console.warn('[edit] bin refresh failed:', err?.message || err);
    _setStatus('BIN REFRESH FAILED', 'error');
  }
  _renderBin();
}

function _renderBin() {
  if (!binListEl) return;
  if (!_bin.length) {
    binListEl.innerHTML = '<div class="edit-bins-empty">NO CLIPS · RECORD SOMETHING IN REC ROOM FIRST</div>';
    return;
  }
  binListEl.innerHTML = '';
  // Coalesce same-prefix numbered runs (`snap-001.jpg`, `snap-002.jpg`, …)
  // into one representative row per sequence — see util/sequences.js.
  const grouped = groupSequences(_bin);
  for (const e of grouped) {
    const row = document.createElement('div');
    row.className = 'edit-bin-row';
    if (e.isSeq) row.classList.add('is-seq');
    const isSnapFolder = e.kind === 'snap-folder';
    if (isSnapFolder) row.classList.add('is-snap-folder');
    if (_binSelected && _binSelected.path === e.path) row.classList.add('is-selected');
    row.dataset.path = e.path;
    // Folders aren't directly placeable on the timeline (they need a
    // stitch pass first). Image/video rows stay draggable.
    row.draggable = !isSnapFolder;
    const dur = (Number.isFinite(e.duration) && e.duration > 0) ? `${e.duration.toFixed(1)}s` : '—';
    const ext = extOf(e.name);
    const baseName = e.name.replace(/\.[^.]+$/, '');
    const seqBadge = e.isSeq ? `<span class="edit-bin-row-seq">× ${e.seqCount}</span>` : '';
    const folderBadge = isSnapFolder ? `<span class="edit-bin-row-seq">× ${e.imageCount}</span>` : '';
    const extBadge = (!isSnapFolder && ext) ? `<span class="edit-bin-row-ext">${ext}</span>` : '';
    const isImg = (e.kind === 'image') || _IMAGE_RE.test(e.name);
    // Snap-folder thumb: first image in the folder, with a small folder
    // glyph overlay so the row reads as "this is a folder of snaps".
    const thumb = isSnapFolder
      ? `<div class="edit-bin-row-thumb is-folder"><img draggable="false" loading="lazy" alt="" src="dash3d-file://gallery/${encodeURI(e.thumbRel)}"><span class="edit-bin-row-thumb-glyph">▣</span></div>`
      : isImg
        ? `<div class="edit-bin-row-thumb"><img draggable="false" loading="lazy" alt="" src="dash3d-file://gallery/${encodeURI(e.rel)}"></div>`
        : `<div class="edit-bin-row-thumb"><span class="edit-bin-row-thumb-glyph">${_VIDEO_RE.test(e.name) ? '▶' : '∙'}</span></div>`;
    const tail = isSnapFolder
      ? `<button type="button" class="edit-bin-row-stitch" title="Stitch this snap folder into an MP4">STITCH → MP4</button>`
      : `<span class="edit-bin-row-dur">${dur}</span>`;
    const delBtn = `<button type="button" class="edit-bin-row-del" title="Move to trash">×</button>`;
    row.innerHTML =
      thumb +
      `<span class="edit-bin-row-name">${baseName}</span>` +
      seqBadge + folderBadge + extBadge +
      tail + delBtn;
    row.querySelector('.edit-bin-row-del')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _deleteBinEntry(e);
    });
    if (isSnapFolder) {
      const stitchBtn = row.querySelector('.edit-bin-row-stitch');
      stitchBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        _stitchSnapFolder(e);
      });
      row.addEventListener('click', () => _previewSnapFolder(e));
    } else {
      row.addEventListener('click', () => _selectBinEntry(e));
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData('application/x-edit-clip', e.path);
        // Sequence rows carry the full member list so the drop handler can
        // place every frame back-to-back on the timeline. Single rows omit
        // this MIME and fall through to the normal one-clip drop.
        if (e.isSeq && Array.isArray(e.seqPaths)) {
          ev.dataTransfer.setData('application/x-edit-clip-seq', JSON.stringify(e.seqPaths));
        }
        // Position the drag-image hotspot at its top-LEFT (0, 0) so the
        // user's cursor sits at the leftmost pixel of the ghost. This way
        // "where the cursor is over the timeline" == "where the clip's
        // left edge lands". The default behavior places the cursor where
        // the user grabbed the row — typically 100+ px into the row —
        // which causes the clip to land far to the right of the cursor.
        try { ev.dataTransfer.setDragImage(row, 0, 0); } catch {}
      });
    }
    binListEl.appendChild(row);
  }
}

// Preview a snap-folder's first frame in the viewer without committing
// to a timeline placement. Lets the user spot-check before they stitch.
function _previewSnapFolder(entry) {
  _binSelected = entry;
  _renderBin();
  _renderInspect?.();
  if (!viewerVideo || !viewerImg) return;
  _viewerMode = 'source';
  _paintViewerMode?.();
  try { viewerVideo.pause(); } catch {}
  viewerVideo.removeAttribute('src');
  try { viewerVideo.load(); } catch {}
  viewerVideo.hidden = true;
  viewerEmpty?.classList.add('is-hidden');
  viewerImg.hidden = false;
  viewerImg.src = `dash3d-file://gallery/${encodeURI(entry.thumbRel)}`;
}

// Stitch a snap-folder's JPEG sequence into an MP4 via the bundled
// ffmpeg pipeline (same path REC ROOM uses for PROCESS SNAPS). Drops
// the result in gallery/videos/ and refreshes the bin so the new clip
// shows up alongside the folder it came from.
async function _stitchSnapFolder(entry) {
  if (!entry?.imagePaths?.length) {
    _setStatus('FOLDER HAS NO FRAMES', 'error');
    return;
  }
  if (!window.dash?.processSnapsFfmpeg) {
    _setStatus('FFMPEG BRIDGE UNAVAILABLE', 'error');
    return;
  }
  _setStatus(`STITCHING ${entry.imagePaths.length} FRAMES…`);
  const unsub = window.dash.onProcessSnapsProgress?.((d) => {
    _setStatus(`STITCHING ${d.frame}/${d.total || entry.imagePaths.length}`);
  });
  try {
    // 1 input frame = 1 output frame at the project's fps. holdMs is the
    // per-input-frame display duration that ffmpeg's concat demuxer uses;
    // the matching `-r <fps>` is derived from it in main, so picking
    // 1000/fps gives a video that plays one snap per video frame.
    const fps = _project?.fps || 30;
    const result = await window.dash.processSnapsFfmpeg({
      paths: entry.imagePaths,
      format: 'mp4',
      outH: 0,             // keep source resolution
      bitsPerSec: 12_000_000,
      holdMs: 1000 / fps,
      useGpu: true,
      codec: 'h264',
      nameHint: entry.name,
    });
    if (result?.ok) {
      _setStatus(`STITCHED ${result.name}`, 'ok');
      await _refreshBin();
    } else {
      _setStatus(`STITCH FAILED · ${result?.error || 'unknown'}`, 'error');
    }
  } catch (err) {
    _setStatus(`STITCH THREW · ${err?.message || err}`, 'error');
  } finally {
    try { unsub?.(); } catch {}
  }
}

// Trash a bin entry — works for individual files (mp4/jpg) AND for
// snap-folder rows (the whole session folder, including its JPEGs, gets
// moved into the gallery's .trash for recovery).
async function _deleteBinEntry(entry) {
  if (!entry?.path) return;
  if (!window.dash?.exploreDelete) {
    _setStatus('DELETE BRIDGE UNAVAILABLE', 'error');
    return;
  }
  const label = entry.kind === 'snap-folder'
    ? `folder "${entry.name}" (${entry.imageCount} frames)`
    : `"${entry.name}"`;
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Move ${label} to trash?`)) return;
  // If the viewer is showing this entry, clear it so the soon-to-be-
  // gone file isn't still bound to the <video>/<img>.
  if (_binSelected && _binSelected.path === entry.path) {
    _binSelected = null;
    try { viewerVideo?.pause(); } catch {}
    if (viewerVideo) { viewerVideo.removeAttribute('src'); try { viewerVideo.load(); } catch {} viewerVideo.hidden = true; }
    if (viewerImg)   { viewerImg.removeAttribute('src');   viewerImg.hidden = true; }
    viewerEmpty?.classList.remove('is-hidden');
  }
  try {
    const r = await window.dash.exploreDelete(entry.path);
    if (r?.ok) {
      _setStatus(`TRASHED ${entry.name}`, 'ok');
      await _refreshBin();
    } else {
      _setStatus(`DELETE FAILED · ${r?.error || 'unknown'}`, 'error');
    }
  } catch (err) {
    _setStatus(`DELETE THREW · ${err?.message || err}`, 'error');
  }
}

function _selectBinEntry(entry) {
  _binSelected = entry;
  _markIn = null;
  _markOut = null;
  _renderBin();
  _renderInspect();
  if (!viewerVideo) return;
  _viewerMode = 'source';
  _paintViewerMode();
  const url = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
  viewerEmpty?.classList.add('is-hidden');
  if (entry.kind === 'image') {
    // Images render into a separate <img>; pause/clear the <video> so
    // it doesn't try to keep decoding a stale source.
    try { viewerVideo.pause(); } catch {}
    viewerVideo.removeAttribute('src');
    try { viewerVideo.load(); } catch {}
    viewerVideo.hidden = true;
    if (viewerImg) {
      viewerImg.hidden = false;
      viewerImg.src = url;
    }
    return;
  }
  // Video path. If a proxy already exists for this source (e.g. the
  // clip was previously on the timeline and the proxy is cached),
  // play that — otherwise play the source. Proxy GENERATION is no
  // longer triggered from a bin click; it happens when the clip
  // lands on the timeline (see _addClipFromBin).
  viewerImg && (viewerImg.hidden = true);
  viewerVideo.hidden = false;
  const cachedProxy = _proxyByPath.get(entry.path)?.url;
  const initialUrl = cachedProxy || url;
  viewerVideo.src = initialUrl;
  _viewerSrcSet = initialUrl;
  viewerVideo.currentTime = 0;
  // Probe duration once metadata loads. Some files (MediaRecorder /
  // Discord / OBS captures) report `Infinity` — recover via the
  // seek-past-end trick before storing on the entry.
  viewerVideo.onloadedmetadata = async () => {
    let d = viewerVideo.duration;
    if (!Number.isFinite(d) || d <= 0) d = await _recoverInfiniteDuration(viewerVideo);
    entry.duration = (Number.isFinite(d) && d > 0) ? d : 0;
    _renderBin();
    _renderInspect();
  };
}

// Proxy state by SOURCE PATH — survives bin refreshes (which would
// otherwise drop entry.proxyUrl every time the user hit ↻) and lets
// the same map serve both source-mode and timeline-mode lookups.
//   path -> { status: 'requesting'|'generating'|'ready'|'failed', url? }
const _proxyByPath = new Map();

// Kick off proxy generation for a source path. No-op for images, no-
// op if already in flight or done. The done-event listener in init()
// fills _proxyByPath when ffmpeg finishes.
function _requestProxyForPath(srcPath, displayName) {
  if (!srcPath) return;
  if (_IMAGE_RE.test(srcPath)) return;
  const cur = _proxyByPath.get(srcPath);
  if (cur?.url || cur?.status === 'generating' || cur?.status === 'requesting') return;
  if (!window.dash?.editProxyEnsure) return;
  _proxyByPath.set(srcPath, { status: 'requesting' });
  window.dash.editProxyEnsure(srcPath).then((res) => {
    if (!res) { _proxyByPath.set(srcPath, { status: 'failed' }); return; }
    if (res.status === 'ready' && res.rel) {
      _proxyByPath.set(srcPath, { status: 'ready', url: `dash3d-file://proxy/${encodeURI(res.rel)}` });
      _swapToProxyForPath(srcPath);
      if (_viewerMode === 'timeline') _syncViewerToPlayhead();
    } else {
      _proxyByPath.set(srcPath, { status: res.status });
      if (res.status === 'generating' && displayName) {
        _setStatus(`PROXY · GENERATING · ${displayName}`);
      }
    }
  }).catch(() => { _proxyByPath.set(srcPath, { status: 'failed' }); });
}

// If the source-mode viewer is currently playing `srcPath`, hot-swap
// it over to the just-finished proxy URL without losing the playhead.
function _swapToProxyForPath(srcPath) {
  const proxyUrl = _proxyByPath.get(srcPath)?.url;
  if (!proxyUrl) return;
  if (!_binSelected || _binSelected.path !== srcPath) return;
  if (_viewerMode !== 'source') return;
  if (!viewerVideo || _viewerSrcSet === proxyUrl) return;
  const t = viewerVideo.currentTime || 0;
  viewerVideo.src = proxyUrl;
  _viewerSrcSet = proxyUrl;
  viewerVideo.currentTime = t;
}

// Lookup the proxy URL for a timeline clip. Reads from the path-keyed
// map so a proxy that becomes ready mid-edit applies on the next
// _syncViewerToPlayhead — no clip-object state to keep in sync.
function _proxyUrlForClip(clip) {
  if (!clip || clip.kind === 'image') return null;
  return _proxyByPath.get(clip.path)?.url || null;
}

// Session-scoped cache GC. Walks the current tracks, computes the
// set of source paths still referenced by at least one clip, and
// drops any _proxyByPath entry + asks main to delete the on-disk
// proxy file for paths that are no longer referenced. Call this
// after any timeline mutation that could orphan a path:
// deleteSelectedClip, source overwrite, undo/redo restoring an older
// state, etc. Razor-split keeps the same path on both halves, so
// it doesn't orphan anything and doesn't need to call this.
function _gcProxies() {
  const referenced = new Set();
  for (const tid of ['V2', 'V1', 'A1']) {
    for (const c of _project.tracks[tid]) {
      if (c?.path && c.kind !== 'image') referenced.add(c.path);
    }
  }
  for (const path of [..._proxyByPath.keys()]) {
    if (!referenced.has(path)) {
      _proxyByPath.delete(path);
      window.dash?.editProxyDeleteOne?.(path).catch(() => {});
    }
  }
}

// Hard reset — drop ALL proxy state on both sides. Called after a
// successful export, which is the project's "I'm done" signal in
// this build (no save/load).
function _clearAllProxies() {
  _proxyByPath.clear();
  if (_viewerSrcSet && _viewerSrcSet.startsWith('dash3d-file://proxy/')) {
    _viewerSrcSet = '';
  }
  window.dash?.editProxyClearAll?.().catch(() => {});
}

// Some encoders (MediaRecorder, Discord, certain OBS profiles) emit
// MP4/WebM files with no duration atom — viewerVideo.duration then
// reads back `Infinity`. The standard recovery is to seek past the
// end; once the seek lands, .duration reports the real value. We
// reset currentTime so the user-visible state doesn't drift.
function _recoverInfiniteDuration(v) {
  return new Promise((resolve) => {
    if (Number.isFinite(v.duration) && v.duration > 0) { resolve(v.duration); return; }
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error',  onErr);
      try { v.currentTime = 0; } catch {}
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    const onSeeked = () => finish(v.duration);
    const onErr    = () => finish(0);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error',  onErr);
    setTimeout(() => finish(0), 3000);
    try { v.currentTime = 1e101; } catch { finish(0); }
  });
}

// Async best-effort duration probe via a throwaway <video> element.
// Used when a bin row is dragged without ever being clicked first —
// without this, the row's entry.duration stays 0 and _addClipFromBin
// silently rejects the add. Returns 0 if the file can't be read.
function _probeDuration(entry) {
  if (!entry) return Promise.resolve(0);
  if (entry.duration > 0 && Number.isFinite(entry.duration)) return Promise.resolve(entry.duration);
  // Images have no native duration — use the bin default (5s).
  if (entry.kind === 'image') return Promise.resolve(5);
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      try { v.src = ''; v.load(); } catch {}
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    v.addEventListener('loadedmetadata', async () => {
      let d = v.duration;
      if (!Number.isFinite(d) || d <= 0) d = await _recoverInfiniteDuration(v);
      finish(d);
    });
    v.addEventListener('error', () => finish(0));
    setTimeout(() => finish(0), 8000); // accommodate the recovery seek
    v.src = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
  });
}

function _renderInspect() {
  // The color panel + proxy button mirror the selected timeline clip;
  // refresh them on every inspect render so selection changes update
  // all three sections in lockstep.
  _renderColorPanel();
  _renderProxyBtn();
  if (!insName) return;
  if (!_binSelected) {
    insName.textContent = '—';
    insDur.textContent  = '—';
    insIn.textContent   = '—';
    insOut.textContent  = '—';
    insFps.textContent  = '—';
    return;
  }
  insName.textContent = _binSelected.name;
  insDur.textContent  = (Number.isFinite(_binSelected.duration) && _binSelected.duration > 0)
    ? `${_binSelected.duration.toFixed(2)}s` : '—';
  insIn.textContent   = _markIn  != null ? _fmtTc(_markIn)  : '—';
  insOut.textContent  = _markOut != null ? _fmtTc(_markOut) : '—';
  insFps.textContent  = `${_binSelected.fps || _project.fps}`;
}

// ── Timeline render ──────────────────────────────────────────────────

function _renderTimeline() {
  if (!tlContent) return;
  const pps = _project.pxPerSec;
  const dur = Math.max(_projectDuration() + 5, 30); // +5s headroom
  const width = Math.ceil(dur * pps);
  // Resize content to allow horizontal scrolling at zoomed widths.
  tlContent.style.width = `${width}px`;
  _renderRuler(dur, pps);
  _renderTracks(pps);
  _renderPlayhead();
}

function _renderRuler(dur, pps) {
  if (!rulerEl) return;
  rulerEl.innerHTML = '';
  // Pick a tick interval such that ticks are at least 40px apart.
  const minPx = 40;
  const minSec = minPx / pps;
  const niceSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let step = niceSteps[niceSteps.length - 1];
  for (const s of niceSteps) { if (s >= minSec) { step = s; break; } }
  // Major every Nth tick where N is closest to making major ticks ~120px.
  const majorEvery = Math.max(1, Math.round(120 / (step * pps)));
  let i = 0;
  for (let t = 0; t <= dur; t += step, i++) {
    const tick = document.createElement('div');
    const isMajor = (i % majorEvery === 0);
    tick.className = 'edit-tl-ruler-tick' + (isMajor ? ' is-major' : '');
    tick.style.left = `${t * pps}px`;
    if (isMajor) {
      const lbl = document.createElement('div');
      lbl.className = 'edit-tl-ruler-label';
      lbl.style.left = `${t * pps}px`;
      lbl.textContent = _fmtTc(t).slice(3); // drop the HH:
      rulerEl.appendChild(lbl);
    }
    rulerEl.appendChild(tick);
  }
}

function _renderTracks(pps) {
  for (const tid of ['V2', 'V1', 'A1']) {
    const el = (tid === 'V2') ? trackV2El : (tid === 'V1') ? trackV1El : trackA1El;
    if (!el) continue;
    el.innerHTML = '';
    for (const clip of _project.tracks[tid]) {
      const c = document.createElement('div');
      c.className = 'edit-tl-clip';
      if (_project.selectedClipIds.has(clip.id) || clip.id === _project.selectedClipId) c.classList.add('is-selected');
      if (clip.id === _project.selectedClipId) c.classList.add('is-primary');
      c.style.left  = `${clip.start * pps}px`;
      c.style.width = `${Math.max(2, clip.dur * pps)}px`;
      c.dataset.clipId = clip.id;
      c.dataset.track = tid;
      const sp = (clip.speed && clip.speed > 1.01) ? clip.speed : 0;
      const speedBadge = sp
        ? `<span class="edit-tl-clip-speed">${sp >= 10 ? sp.toFixed(0) : sp.toFixed(1)}×</span>`
        : '';
      c.innerHTML =
        `<span class="edit-tl-clip-resize is-left"  data-resize="left"></span>` +
        speedBadge +
        `<span class="edit-tl-clip-name">${clip.name || ''}</span>` +
        `<span class="edit-tl-clip-resize is-right" data-resize="right"></span>`;
      if (sp) c.classList.add('is-timelapsed');
      c.addEventListener('mousedown', (ev) => _onClipMouseDown(ev, clip, tid));
      el.appendChild(c);
    }
  }
}

function _renderPlayhead() {
  if (!playheadEl) return;
  playheadEl.style.left = `${_project.playheadTime * _project.pxPerSec}px`;
}

// ── Clip add (fast-add operations) ───────────────────────────────────

function _addClipFromBin(behavior, ignoreMarks) {
  if (!_binSelected) { _setStatus('NO SOURCE CLIP SELECTED', 'error'); return; }
  const p = _binSelected.path || '';
  if (!_VIDEO_RE.test(p) && !_IMAGE_RE.test(p)) {
    _setStatus(`UNSUPPORTED FILE TYPE — ${p.split('.').pop()?.toUpperCase()}`, 'error');
    return;
  }
  const srcDur = Number(_binSelected.duration) || 0;
  if (!Number.isFinite(srcDur) || srcDur <= 0) { _setStatus('SOURCE DURATION UNKNOWN — WAIT FOR METADATA', 'error'); return; }
  // Snapshot pre-mutation state for undo.
  _pushHistory();
  // Treat marks as unset under any of:
  //   • caller explicitly opted out (drag-drop should always use full clip)
  //   • either mark is missing
  //   • marks are within 0.05s of each other (the user accidentally
  //     hit I and O at the same frame → a 0.01s clip is just invisible)
  let inT, outT;
  if (ignoreMarks || _markIn == null || _markOut == null
      || Math.abs((_markOut || 0) - (_markIn || 0)) < 0.05) {
    inT = 0;
    outT = srcDur;
  } else {
    inT = _markIn;
    outT = _markOut;
  }
  const useDur = Math.max(0.01, outT - inT);
  const newClip = {
    id: ++_clipSeq,
    path: _binSelected.path,
    rel:  _binSelected.rel,
    name: _binSelected.name,
    kind: _binSelected.kind || 'video',
    srcIn:  inT,
    srcOut: outT,
    dur: useDur,
    start: 0,
  };
  switch (behavior) {
    case 'append': {
      const v1 = _project.tracks.V1;
      newClip.start = _trackDuration(v1);
      v1.push(newClip);
      break;
    }
    case 'smart': {
      // Smart Insert at playhead. Pick V1 if free at this time, else V2.
      const t = _project.playheadTime;
      const v1Free = !_clipAt(_project.tracks.V1, t);
      const target = v1Free ? _project.tracks.V1 : _project.tracks.V2;
      newClip.start = t;
      target.push(newClip);
      break;
    }
    case 'top': {
      // Place on Top → V2 at playhead.
      newClip.start = _project.playheadTime;
      _project.tracks.V2.push(newClip);
      break;
    }
    case 'ripple': {
      // Ripple Overwrite: insert into V1 at playhead, pushing later clips right.
      const t = _project.playheadTime;
      newClip.start = t;
      for (const c of _project.tracks.V1) {
        if (c.start >= t) c.start += useDur;
      }
      _project.tracks.V1.push(newClip);
      break;
    }
    case 'closeup': {
      // Close-Up = Place on Top with a "scale 1.25" hint (effects later).
      newClip.start = _project.playheadTime;
      newClip.effects = { zoom: 1.25 };
      _project.tracks.V2.push(newClip);
      break;
    }
    case 'overwrite': {
      // Source Overwrite: replace currently-selected timeline clip with
      // the bin source. Keeps the timeline clip's start; uses src's dur.
      const sel = _findSelectedClip();
      if (!sel) { _setStatus('NO TIMELINE CLIP SELECTED', 'error'); return; }
      sel.clip.path = newClip.path;
      sel.clip.rel  = newClip.rel;
      sel.clip.name = newClip.name;
      sel.clip.srcIn  = newClip.srcIn;
      sel.clip.srcOut = newClip.srcOut;
      sel.clip.dur    = newClip.dur;
      _renderTimeline();
      _setStatus(`OVERWROTE ${sel.clip.name}`, 'ok');
      _depsPaint();
      return;
    }
  }
  _setSelectionTo(newClip.id);
  _renderTimeline();
  _setStatus(`${behavior.toUpperCase()} · ${newClip.name}`, 'ok');
  _depsPaint();
  // Proxy generation is OPT-IN now: the user clicks the PROXY button
  // in the INSPECT panel when they want a scrub cache for a clip.
  // Cheap clips (short captures, already-fast formats) don't need
  // one and shouldn't pay the encode cost.
}

function _clipAt(track, t) {
  return track.find((c) => t >= c.start && t < c.start + c.dur);
}
function _findSelectedClip() {
  if (_project.selectedClipId == null) return null;
  for (const tid of ['V2', 'V1', 'A1']) {
    const c = _project.tracks[tid].find((c) => c.id === _project.selectedClipId);
    if (c) return { clip: c, track: tid };
  }
  return null;
}

function _depsPaint() {
  // Ask app.js to repaint the combo-header so the duration chip updates.
  try { _deps?.paintComboHeader?.(); } catch {}
}

// ── Clip interactions on the timeline ────────────────────────────────

function _onClipMouseDown(ev, clip, trackId) {
  // Razor mode: cut at the click position. The user's mental model is
  // "where I clicked is where it cuts." Playhead also jumps to the
  // click so they see it. Simple, no gating.
  if (_tool === 'razor') {
    ev.stopPropagation();
    _razorCutAtClick(ev.clientX);
    return;
  }
  // Trim handles (only the L/R resize spans) — grab the edge to retime
  // the clip. The body of the clip is handled below.
  const onResize = ev.target.closest?.('.edit-tl-clip-resize');
  if (onResize) {
    ev.stopPropagation();
    _setSelectionTo(clip.id);
    _renderTimeline();
    _renderInspect();
    const side = onResize.dataset.resize; // 'left' or 'right'
    _startResize(ev, clip, trackId, side);
    return;
  }
  // Clip BODY in SELECT/TRIM mode — split intent into two behaviors:
  //   • Click (no significant drag) → scrub to the click position.
  //   • Drag (mouse moves > 4px before mouseup) → MOVE the clip.
  // stopPropagation here so the event doesn't bubble to tlContent and
  // fire _onContentMouseDown a second time (which would race with us).
  ev.stopPropagation();
  ev.preventDefault();
  // Multi-select modifiers:
  //   plain click → replace selection with this clip
  //   ctrl/⌘ click → toggle this clip in/out of selection
  //   shift click → add this clip (no removal)
  // Plain click on an already-selected member keeps the existing set so
  // the user can drag the whole group; we only collapse to single when
  // they click an UNSELECTED clip with no modifier.
  if (ev.ctrlKey || ev.metaKey) {
    if (_project.selectedClipIds.has(clip.id)) {
      _project.selectedClipIds.delete(clip.id);
      if (_project.selectedClipId === clip.id) {
        _project.selectedClipId = _project.selectedClipIds.values().next().value ?? null;
      }
    } else {
      _project.selectedClipIds.add(clip.id);
      _project.selectedClipId = clip.id;
    }
  } else if (ev.shiftKey) {
    _project.selectedClipIds.add(clip.id);
    _project.selectedClipId = clip.id;
  } else if (!_project.selectedClipIds.has(clip.id)) {
    _setSelectionTo(clip.id);
  } else {
    _project.selectedClipId = clip.id;
  }
  _renderTimeline();
  _renderInspect();

  // Snapshot every selected clip's start time so the drag can move the
  // whole group by a single delta. Even a single-clip selection runs
  // through this path so the move logic stays uniform.
  const groupSnap = [];
  for (const tid of ['V2', 'V1', 'A1']) {
    for (const c of _project.tracks[tid]) {
      if (_project.selectedClipIds.has(c.id) || c.id === clip.id) {
        groupSnap.push({ clip: c, tid, startTime: c.start });
      }
    }
  }
  const startX = ev.clientX;
  const startTime = clip.start;
  let mode = 'pending'; // 'pending' → either 'drag' or 'scrub'
  // Mutable during the drag — swaps when the cursor crosses lane
  // boundaries. Audio (A1) clips stay on A1; only V1 <-> V2 swap.
  let currentTid = trackId;
  const allowTrackSwap = (currentTid === 'V1' || currentTid === 'V2');
  const v2Rect = allowTrackSwap ? trackV2El?.getBoundingClientRect() : null;
  const v1Rect = allowTrackSwap ? trackV1El?.getBoundingClientRect() : null;

  function onMove(mv) {
    const dx = mv.clientX - startX;
    if (mode === 'pending') {
      if (Math.abs(dx) < 4) return; // dead band — still might be a click
      mode = (_tool === 'select') ? 'drag' : 'scrub';
    }
    if (mode === 'drag') {
      let next = startTime + dx / _project.pxPerSec;
      if (next < 0) next = 0;
      next = _snapTime(next, clip.id);
      const delta = next - startTime;
      // Move every selected clip by the same delta, but clamp so the
      // earliest-starting selected clip doesn't go past 0.
      let earliestNew = Infinity;
      for (const g of groupSnap) {
        const candidate = g.startTime + delta;
        if (candidate < earliestNew) earliestNew = candidate;
      }
      const correction = earliestNew < 0 ? -earliestNew : 0;
      for (const g of groupSnap) g.clip.start = g.startTime + delta + correction;
      // Vertical lane swap: V1 <-> V2 when the cursor crosses lane Y bounds.
      // Only swaps the primary clip — multi-select doesn't reshuffle tracks
      // because cross-track moves get ambiguous fast.
      if (allowTrackSwap && v1Rect && v2Rect && groupSnap.length === 1) {
        let newTid = currentTid;
        if (mv.clientY >= v2Rect.top && mv.clientY < v2Rect.bottom) newTid = 'V2';
        else if (mv.clientY >= v1Rect.top && mv.clientY < v1Rect.bottom) newTid = 'V1';
        if (newTid !== currentTid) {
          const src = _project.tracks[currentTid];
          const dst = _project.tracks[newTid];
          const idx = src.indexOf(clip);
          if (idx >= 0) { src.splice(idx, 1); dst.push(clip); currentTid = newTid; }
        }
      }
      _renderTimeline();
    } else {
      // 'scrub' — playhead follows the cursor in viewport coords.
      _beginScrub();
      const next = _snapTime(_clientXToTime(mv.clientX));
      if (Math.abs(next - _project.playheadTime) < 0.001) return;
      _project.playheadTime = next;
      _renderPlayhead();
      _syncViewerToPlayhead();
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    if (mode === 'pending') {
      // No significant movement → treat as a click. Scrub to the click
      // position. This is what gives "click anywhere on a clip = jump
      // the playhead there + preview the frame."
      _scrubToClick(ev.clientX);
    } else if (mode === 'drag') {
      _depsPaint();
    }
    _endScrub();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// Shared scrub-on-click helper. Used by clip click-without-drag, and
// directly by _onContentMouseDown when the click misses every clip.
// Switches viewer to TIMELINE mode (so the video preview tracks the
// playhead), pauses any in-flight playback, jumps the playhead, and
// syncs the viewer.
function _scrubToClick(clientX) {
  const hasClips = _project.tracks.V2.length + _project.tracks.V1.length > 0;
  if (hasClips && _viewerMode !== 'timeline') {
    _viewerMode = 'timeline';
    _paintViewerMode();
  }
  try { viewerVideo?.pause(); } catch {}
  _playDir = 0;
  const rateEl = document.getElementById('edit-transport-rate');
  // Scrub-during-drag paused state — use the monochrome em-dash, not
  // the unicode ⏸ which falls through to Segoe UI Emoji and renders
  // as a blue colour glyph (the persistent "blue pause button" bug).
  // This second write site was missed in the first pass.
  if (rateEl) rateEl.textContent = '—';
  _project.playheadTime = _snapTime(_clientXToTime(clientX));
  _renderTimeline();
  _renderInspect();
  _syncViewerToPlayhead();
}

function _startDrag(downEv, clip, trackId) {
  const origStart = clip.start;
  const startX = downEv.clientX;
  function onMove(mv) {
    const dxPx = mv.clientX - startX;
    let next = origStart + dxPx / _project.pxPerSec;
    if (next < 0) next = 0;
    next = _snapTime(next, clip.id);
    clip.start = next;
    _renderTimeline();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    _depsPaint();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _startResize(downEv, clip, trackId, side) {
  const origStart = clip.start;
  const origDur   = clip.dur;
  const origSrcIn = clip.srcIn || 0;
  const origSrcOut= clip.srcOut || origDur;
  // Source-side length the clip references (unaffected by retiming).
  // We pin this here so subsequent drags don't compound speed math
  // through floating-point noise.
  const srcLen    = origSrcOut - origSrcIn;
  const origSpeed = (clip.speed && clip.speed > 0) ? clip.speed : 1;
  const startX   = downEv.clientX;
  const timelapseMode = (_tool === 'timelapse');
  function onMove(mv) {
    const dxPx = mv.clientX - startX;
    const dt = dxPx / _project.pxPerSec;
    if (timelapseMode && side === 'right') {
      // TIMELAPSE: dragging the right edge LEFT compresses the visible
      // length without trimming the source — speed climbs so the same
      // frames play faster. srcIn/srcOut stay put; only clip.dur and
      // clip.speed change. Capped at 64× because beyond that the
      // motion is meaningless on screen.
      let nextDur = origDur + dt;
      const minDur = srcLen / 64;
      if (nextDur < Math.max(0.05, minDur)) nextDur = Math.max(0.05, minDur);
      if (nextDur > srcLen) nextDur = srcLen; // can't slow below 1× in this mode
      nextDur = _snapTime(origStart + nextDur, clip.id) - origStart;
      clip.dur   = nextDur;
      clip.speed = srcLen / Math.max(0.0001, nextDur);
      // Keep srcIn/srcOut untouched so the WHOLE source still plays.
      clip.srcIn  = origSrcIn;
      clip.srcOut = origSrcOut;
      _renderTimeline();
      return;
    }
    if (side === 'left') {
      let nextStart = origStart + dt;
      if (nextStart < 0) nextStart = 0;
      if (nextStart > origStart + origDur - 0.05) nextStart = origStart + origDur - 0.05;
      nextStart = _snapTime(nextStart, clip.id);
      const delta = nextStart - origStart;
      clip.start = nextStart;
      clip.dur   = origDur - delta;
      clip.srcIn = origSrcIn + delta * origSpeed;
    } else {
      let nextDur = origDur + dt;
      if (nextDur < 0.05) nextDur = 0.05;
      let nextEnd = origStart + nextDur;
      nextEnd = _snapTime(nextEnd, clip.id);
      clip.dur    = nextEnd - origStart;
      clip.srcOut = origSrcIn + clip.dur * origSpeed;
    }
    _renderTimeline();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    _depsPaint();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Razor "click anywhere" — runs from BOTH the clip mousedown handler
// (when the click landed on a clip element) and the content mousedown
// handler (when the click landed on track background or ruler). The
// behavior is the same either way: compute click time, move the
// playhead there, and split every clip whose range contains that time.
// Cuts at click X — no playhead-based gating, no clip-vs-track gating.
function _razorCutAtClick(clientX) {
  const cutT = _clientXToTime(clientX);
  _project.playheadTime = cutT;
  // Snapshot pre-cut state so the user can undo a razor split.
  // We snapshot BEFORE we know if anything was actually cut — if no
  // clips were under the cursor, _undo restores the same state which
  // is a no-op, fine.
  _pushHistory();
  let cuts = 0;
  for (const tid of ['V2', 'V1', 'A1']) {
    // Snapshot the track array — _splitClip mutates the array (splice),
    // so iterating live would re-cut the new right-half if we kept
    // walking. One pass over a snapshot is safe.
    const snapshot = _project.tracks[tid].slice();
    for (const c of snapshot) {
      if (cutT > c.start + 0.02 && cutT < c.start + c.dur - 0.02) {
        _splitClip(c, tid, cutT);
        cuts++;
      }
    }
  }
  if (cuts === 0) {
    _renderTimeline(); // still repaint so playhead moves visibly
    _setStatus(`NO CLIPS AT ${_fmtTc(cutT)} TO CUT`, 'error');
  } else {
    _setStatus(`CUT ${cuts} CLIP${cuts > 1 ? 'S' : ''} @ ${_fmtTc(cutT)}`, 'ok');
  }
  _syncViewerToPlayhead();
}

function _splitClip(clip, trackId, atTime) {
  const left = { ...clip, id: ++_clipSeq };
  const right = { ...clip, id: ++_clipSeq };
  const sp = (clip.speed && clip.speed > 0) ? clip.speed : 1;
  left.dur = atTime - clip.start;
  left.srcOut = (clip.srcIn || 0) + left.dur * sp;
  right.start = atTime;
  right.dur = (clip.start + clip.dur) - atTime;
  right.srcIn = (clip.srcIn || 0) + left.dur * sp;
  const arr = _project.tracks[trackId];
  const idx = arr.findIndex((c) => c.id === clip.id);
  if (idx >= 0) arr.splice(idx, 1, left, right);
  // If the original was multi-selected, swap it for both halves so the
  // user's selection state survives the cut.
  if (_project.selectedClipIds.has(clip.id)) {
    _project.selectedClipIds.delete(clip.id);
    _project.selectedClipIds.add(left.id);
    _project.selectedClipIds.add(right.id);
  } else {
    _project.selectedClipIds = new Set([right.id]);
  }
  _project.selectedClipId = right.id;
  _renderTimeline();
  _setStatus(`CUT @ ${_fmtTc(atTime)}`, 'ok');
  _depsPaint();
}

// Replace the multi-selection with a single clip (and pin it as the
// primary). Used by the trim-handle grab and any plain-click path that
// wants to collapse the selection.
function _setSelectionTo(clipId) {
  _project.selectedClipId = clipId;
  _project.selectedClipIds = new Set(clipId == null ? [] : [clipId]);
}

function _deleteSelectedClip() {
  // Snapshot the IDs to remove — the multi-selection set is used by the
  // renderer; mutating it mid-iteration would skip clips.
  const ids = new Set(_project.selectedClipIds);
  if (_project.selectedClipId != null) ids.add(_project.selectedClipId);
  if (!ids.size) return;
  let removed = 0;
  let lastName = '';
  for (const tid of ['V2', 'V1', 'A1']) {
    const arr = _project.tracks[tid];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (ids.has(arr[i].id)) {
        lastName = arr[i].name;
        arr.splice(i, 1);
        removed++;
      }
    }
  }
  _setSelectionTo(null);
  _renderTimeline();
  _setStatus(removed > 1 ? `DELETED · ${removed} CLIPS` : `DELETED · ${lastName}`, 'ok');
  _depsPaint();
  // If these were the last clips referencing their source paths, drop
  // the proxies too — the workspace isn't persisted, so neither
  // should the derived cache be.
  _gcProxies();
}

// ── Timeline pointer (click+drag anywhere = scrub) ───────────────────

// Dedicated ruler scrub. Always scrubs — regardless of tool, regardless
// of whether clips exist. Drag continues until mouseup, updating both
// the playhead and the viewer on every move. stopPropagation so the
// event doesn't ALSO trigger the tlContent listener (which would also
// scrub, double-firing on the same event).
function _onRulerMouseDown(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  _beginScrub();
  _scrubToClick(ev.clientX);
  function onMove(mv) {
    const next = _snapTime(_clientXToTime(mv.clientX));
    if (Math.abs(next - _project.playheadTime) < 0.001) return;
    _project.playheadTime = next;
    _renderPlayhead();
    _syncViewerToPlayhead();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    _endScrub();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

function _onContentMouseDown(ev) {
  // The ruler has its own dedicated handler — let it run.
  if (ev.target.closest('.edit-tl-ruler')) return;
  // Bail if the click landed on a clip — the clip's own mousedown
  // handler (_onClipMouseDown) owns the interaction (move-or-scrub
  // decision via dead-band). Without this bail, the same mousedown
  // event fires both handlers and the two scrub sessions race.
  if (ev.target.closest('.edit-tl-clip')) return;
  ev.preventDefault();
  // Razor mode: an off-clip click cuts every clip whose range contains
  // the click time.
  if (_tool === 'razor') {
    _razorCutAtClick(ev.clientX);
    return;
  }
  // Background click outside any clip — clear multi-selection. Modifier
  // keys preserve it so the user can rubber-band intent later without
  // losing what they had.
  if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey && (_project.selectedClipIds.size || _project.selectedClipId != null)) {
    _setSelectionTo(null);
    _renderTimeline();
    _renderInspect();
  }
  // Initial jump + viewer sync.
  _beginScrub();
  _scrubToClick(ev.clientX);
  // Continue scrubbing while the button is held.
  function onMove(mv) {
    const next = _snapTime(_clientXToTime(mv.clientX));
    if (Math.abs(next - _project.playheadTime) < 0.001) return;
    _project.playheadTime = next;
    _renderPlayhead();
    _syncViewerToPlayhead();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    _endScrub();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

// ── Viewer / transport ───────────────────────────────────────────────

function _paintViewerMode() {
  for (const b of viewerModeBtns || []) {
    b.classList.toggle('is-active', b.dataset.viewerMode === _viewerMode);
  }
}

function _setViewerMode(mode) {
  _viewerMode = mode;
  _paintViewerMode();
  if (mode === 'timeline') _syncViewerToPlayhead();
  else if (_binSelected) viewerVideo.src = `dash3d-file://gallery/${encodeURI(_binSelected.rel)}`;
  _paintReadout();
}

// Toggle the viewer between the <video> and <img> element based on
// the kind of the clip currently in scope. For images, the URL is
// idempotent — we set src once per distinct source so we don't
// reload the bitmap on every playhead tick.
let _viewerImgRel = null;
function _paintViewerForClip(clip) {
  if (!viewerVideo) return;
  if (!clip) {
    viewerVideo.hidden = false;
    viewerImg && (viewerImg.hidden = true);
    _viewerImgRel = null;
    return;
  }
  if (clip.kind === 'image') {
    if (!viewerVideo.paused) { try { viewerVideo.pause(); } catch {} }
    viewerVideo.hidden = true;
    if (viewerImg) {
      viewerImg.hidden = false;
      if (_viewerImgRel !== clip.rel) {
        viewerImg.src = `dash3d-file://gallery/${encodeURI(clip.rel)}`;
        _viewerImgRel = clip.rel;
      }
    }
    return;
  }
  // Video clip.
  viewerImg && (viewerImg.hidden = true);
  viewerVideo.hidden = false;
  _viewerImgRel = null;
}

// Track the URL we last assigned to the <video>. Comparing against
// `viewerVideo.currentSrc` is unreliable — Chromium re-normalizes the
// URL on read (e.g. encoding differences) so the comparison can
// repeatedly fail and reload the entire video on every mousemove.
let _viewerSrcSet = '';
// Scrub gate. The proxy is the low-res scrub-only cache; only swap
// to it while the user is actively dragging the playhead. On
// mouseup we revert to the source URL so paused/playing preview
// stays at full quality. _beginScrub / _endScrub bracket each
// scrub drag.
let _scrubbing = false;
function _beginScrub() {
  if (_scrubbing) return;
  _scrubbing = true;
  if (_viewerMode === 'timeline') _syncViewerToPlayhead();
}
function _endScrub() {
  if (!_scrubbing) return;
  _scrubbing = false;
  if (_viewerMode === 'timeline') _syncViewerToPlayhead();
}
function _syncViewerToPlayhead() {
  if (_viewerMode !== 'timeline' || !viewerVideo) return;
  const t = _project.playheadTime;
  const topV2 = _project.tracks.V2.find((c) => t >= c.start && t < c.start + c.dur);
  const topV1 = _project.tracks.V1.find((c) => t >= c.start && t < c.start + c.dur);
  const top = topV2 || topV1;
  if (!top) {
    viewerEmpty?.classList.remove('is-hidden');
    try { viewerVideo.pause(); } catch {}
    _paintViewerForClip(null);
    return;
  }
  viewerEmpty?.classList.add('is-hidden');
  _paintViewerForClip(top);
  // Whatever clip is under the playhead drives the viewer's color
  // filter so scrubbing across clips shows each one's grade.
  _applyColorToViewer(top.color);
  if (top.kind === 'image') return;
  // Use the proxy ONLY while actively scrubbing — fast seek when it
  // matters, original quality at rest. When scrub ends, _endScrub
  // re-calls this and the source URL wins. First scrub mousedown
  // pays a load cost as the proxy starts streaming; same on the way
  // back to source. Trade-off is intentional.
  const proxyUrl  = _scrubbing ? _proxyUrlForClip(top) : null;
  const sourceUrl = `dash3d-file://gallery/${encodeURI(top.rel)}`;
  const wantUrl   = proxyUrl || sourceUrl;
  if (_viewerSrcSet !== wantUrl) {
    console.warn('[edit] viewer src swap', proxyUrl ? 'PROXY' : 'SOURCE', wantUrl);
    _viewerSrcSet = wantUrl;
    viewerVideo.src = wantUrl;
  }
  const sp = (top.speed && top.speed > 0) ? top.speed : 1;
  const offset = (top.srcIn || 0) + (t - top.start) * sp;
  try { viewerVideo.currentTime = offset; } catch {}
  // Drive the <video>'s playback rate from the clip's speed so timeline
  // playback runs the timelapse live — 4× clip plays at 4× rate. Capped
  // at 16× because Chromium clamps anything higher anyway.
  try { viewerVideo.playbackRate = Math.min(16, sp * Math.abs(_playRate || 1)); } catch {}
}

function _transportPlay(dir) {
  if (!viewerVideo) return;
  // No source loaded? Try to recover by auto-loading the first bin
  // clip (best-effort smart default). If the bin is empty too, surface
  // a status line so the user understands why the button "did nothing".
  // Empty viewer.src is the #1 reason JKL appeared dead in early testing.
  if (!viewerVideo.src && dir !== 0) {
    if (_bin.length) {
      _selectBinEntry(_bin[0]);
    } else {
      _setStatus('NO MEDIA · LOAD A CLIP FROM THE BIN FIRST', 'error');
      return;
    }
  }
  const now = Date.now();
  if (dir === _playDir && (now - _lastTransportTap) < 600) {
    _playRate = Math.min(8, _playRate * 2);
  } else {
    _playRate = 1;
  }
  _playDir = dir;
  _lastTransportTap = now;
  // playbackRate sign: most browsers don't actually play in reverse;
  // setting a negative rate keeps the property but the video stays
  // paused. JKL reverse will land properly when we add WebCodecs scrub
  // in Phase 1B. For now, reverse just sets the rate; pause is real.
  try { viewerVideo.playbackRate = Math.abs(_playRate); } catch {}
  if (dir === 0) {
    try { viewerVideo.pause(); } catch {}
  } else {
    // play() returns a Promise — handle rejection so silent failures
    // (autoplay policy, missing source, decode error) surface as status.
    const p = viewerVideo.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => _setStatus('PLAY FAILED · ' + (err?.name || err?.message || 'unknown'), 'error'));
    }
  }
  const rateEl = document.getElementById('edit-transport-rate');
  // When paused, show a monochrome em-dash instead of the unicode ⏸
  // glyph. The pause character falls through to Segoe UI Emoji on
  // Windows (var(--font-tech) doesn't include it), which paints it
  // in colour and makes the rate indicator look like a second
  // (blue) pause button sitting beside the real pause control.
  if (rateEl) rateEl.textContent = dir === 0 ? '—' : `${dir < 0 ? '-' : ''}${_playRate}×`;
}

function _stepFrame(dirFrames) {
  if (!viewerVideo) return;
  const fps = _project.fps;
  const dt = dirFrames / fps;
  viewerVideo.currentTime = Math.max(0, viewerVideo.currentTime + dt);
  _project.playheadTime = Math.max(0, _project.playheadTime + dt);
  _renderPlayhead();
}

function _jumpToEditPoint(dir) {
  // dir: -1 = previous, +1 = next. Look across all tracks for clip
  // boundaries.
  const boundaries = new Set([0]);
  for (const tid of ['V2', 'V1', 'A1']) {
    for (const c of _project.tracks[tid]) {
      boundaries.add(c.start);
      boundaries.add(c.start + c.dur);
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const t = _project.playheadTime;
  let target = t;
  if (dir > 0) target = sorted.find((b) => b > t + 0.001) ?? t;
  else         target = [...sorted].reverse().find((b) => b < t - 0.001) ?? 0;
  _project.playheadTime = target;
  _renderPlayhead();
  _syncViewerToPlayhead();
}

// ── In/Out markers (source-clip range) ───────────────────────────────

function _markSource(which) {
  if (!viewerVideo || !_binSelected) { _setStatus('NO SOURCE CLIP', 'error'); return; }
  _pushHistory();   // undoable mark
  const t = viewerVideo.currentTime;
  if (which === 'in')       _markIn  = t;
  else if (which === 'out') _markOut = t;
  // Auto-correct ordering: if out < in, swap so the range stays valid.
  if (_markIn != null && _markOut != null && _markOut < _markIn) {
    const tmp = _markIn; _markIn = _markOut; _markOut = tmp;
  }
  _renderInspect();
  _setStatus(`MARK ${which.toUpperCase()} @ ${_fmtTc(t)}`, 'ok');
}

// ── Tool mode / snap ─────────────────────────────────────────────────

function _setTool(name) {
  _tool = name;
  for (const b of toolBtns || []) {
    if (b.dataset.tool) b.classList.toggle('is-active', b.dataset.tool === name);
  }
  // Cursor hint on the timeline content.
  if (tlContent) {
    tlContent.classList.remove('tool-select', 'tool-trim', 'tool-razor', 'tool-timelapse');
    tlContent.classList.add(`tool-${name}`);
  }
  _setStatus(`TOOL · ${name.toUpperCase()}`);
  _paintReadout();
}

function _setSnap(on) {
  _snap = !!on;
  if (snapBtn) snapBtn.classList.toggle('is-active', _snap);
  _paintReadout();
}

// ── rAF loop: sync playhead position from viewer.currentTime ─────────

function _rafTick() {
  if (!_active) { _rafHandle = null; return; }
  // When in timeline mode and the video is playing, drive the playhead
  // off currentTime. Single-element preview means we approximate the
  // top-clip-at-playhead's source-offset back into project time.
  if (_viewerMode === 'timeline' && viewerVideo && !viewerVideo.paused) {
    const t = _project.playheadTime;
    const top = _project.tracks.V2.find((c) => t >= c.start && t < c.start + c.dur)
             || _project.tracks.V1.find((c) => t >= c.start && t < c.start + c.dur);
    if (top) {
      const srcT = viewerVideo.currentTime;
      const sp = (top.speed && top.speed > 0) ? top.speed : 1;
      _project.playheadTime = top.start + (srcT - (top.srcIn || 0)) / sp;
      _renderPlayhead();
    }
  }
  // Always refresh the timecode chip near the viewer.
  if (viewerTcEl && viewerVideo) {
    viewerTcEl.textContent = _fmtTc(_viewerMode === 'timeline'
      ? _project.playheadTime
      : (viewerVideo.currentTime || 0));
  }
  // Refresh the live readout (timecode + state). Cheap; one textContent.
  _paintReadout();
  _rafHandle = requestAnimationFrame(_rafTick);
}

function _startRaf() {
  if (_rafHandle != null) return;
  _rafHandle = requestAnimationFrame(_rafTick);
}
function _stopRaf() {
  if (_rafHandle != null) cancelAnimationFrame(_rafHandle);
  _rafHandle = null;
}

// ── Keyboard ─────────────────────────────────────────────────────────

function _onKey(ev) {
  // Don't hijack typing in inputs / textareas / contenteditable.
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = ev.key.toLowerCase();
  switch (k) {
    case 'a': _setTool('select'); break;
    case 't': _setTool('trim'); break;
    case 'b': _setTool('razor'); break;
    case 'y': _setTool('timelapse'); break;
    case 's': _setSnap(!_snap); _setStatus(`SNAP ${_snap ? 'ON' : 'OFF'}`); break;
    case 'i': _markSource('in'); break;
    case 'o': _markSource('out'); break;
    case 'j': _transportPlay(-1); break;
    case 'k': _transportPlay(0); break;
    case 'l': _transportPlay(+1); break;
    case ' ':
      ev.preventDefault();
      if (viewerVideo?.paused) _transportPlay(+1); else _transportPlay(0);
      break;
    case 'delete': case 'backspace': _deleteSelectedClip(); break;
    case 'arrowleft':  _stepFrame(ev.shiftKey ? -10 : -1); break;
    case 'arrowright': _stepFrame(ev.shiftKey ? +10 : +1); break;
    case 'arrowup':    _jumpToEditPoint(-1); break;
    case 'arrowdown':  _jumpToEditPoint(+1); break;
    case 'home':       _project.playheadTime = 0; _renderPlayhead(); _syncViewerToPlayhead(); break;
    case 'end':        _project.playheadTime = _projectDuration(); _renderPlayhead(); _syncViewerToPlayhead(); break;
    default: return;
  }
  ev.stopPropagation();
}

// ── DOM wiring (one-time, in init) ───────────────────────────────────

function _grabDom() {
  paneEl        = document.querySelector('.combo-pane-edit');
  binListEl     = document.getElementById('edit-bins-list');
  binRefreshBtn = document.getElementById('edit-bins-refresh');
  viewerVideo   = document.getElementById('edit-viewer-video');
  viewerImg     = document.getElementById('edit-viewer-img');
  viewerEmpty   = document.getElementById('edit-viewer-empty');
  viewerStage   = document.getElementById('edit-viewer-stage');
  viewerTcEl    = document.getElementById('edit-viewer-tc');
  snapBtn       = document.getElementById('edit-tool-snap');
  zoomInput     = document.getElementById('edit-tl-zoom');
  statusEl      = document.getElementById('edit-status');
  readoutEl     = document.getElementById('edit-readout');
  trackV1El     = document.getElementById('edit-tl-track-V1');
  trackV2El     = document.getElementById('edit-tl-track-V2');
  trackA1El     = document.getElementById('edit-tl-track-A1');
  rulerEl       = document.getElementById('edit-tl-ruler');
  playheadEl    = document.getElementById('edit-tl-playhead');
  tlContent     = document.getElementById('edit-tl-content');
  tlScroll      = document.getElementById('edit-tl-scroll');
  toolBtns      = Array.from(paneEl?.querySelectorAll('.edit-tool-btn[data-tool]') || []);
  viewerModeBtns= Array.from(paneEl?.querySelectorAll('.edit-viewer-mode') || []);
  fastAddBtns = {
    append:    document.getElementById('edit-fa-append'),
    smart:     document.getElementById('edit-fa-smart'),
    top:       document.getElementById('edit-fa-top'),
    ripple:    document.getElementById('edit-fa-ripple'),
    closeup:   document.getElementById('edit-fa-closeup'),
    overwrite: document.getElementById('edit-fa-overwrite'),
  };
  transportBtns = {
    jstart:  document.getElementById('edit-tp-jstart'),
    jprev:   document.getElementById('edit-tp-jprev'),
    jback:   document.getElementById('edit-tp-jback'),
    jpause:  document.getElementById('edit-tp-jpause'),
    jfwd:    document.getElementById('edit-tp-jfwd'),
    jnext:   document.getElementById('edit-tp-jnext'),
    jend:    document.getElementById('edit-tp-jend'),
    markIn:  document.getElementById('edit-tp-mark-in'),
    markOut: document.getElementById('edit-tp-mark-out'),
  };
  insName = document.getElementById('edit-ins-name');
  insDur  = document.getElementById('edit-ins-dur');
  insIn   = document.getElementById('edit-ins-in');
  insOut  = document.getElementById('edit-ins-out');
  insFps  = document.getElementById('edit-ins-fps');
}

function _wireEvents() {
  // Aspect-ratio sync — every time the viewer video loads new metadata,
  // mirror its captured ratio onto the element so the box stays at
  // the source ratio instead of stretching. We write the value to
  // BOTH style.aspectRatio (highest specificity, wins regardless of
  // stylesheet order) and --video-ar (so any other rule reading the
  // var stays in agreement). Lives here, not in .onloadedmetadata,
  // because other code paths (timeline-sync, viewer-mode switch)
  // reassign .onloadedmetadata and would otherwise wipe this listener.
  //
  // Important: we do NOT clear the aspect on 'emptied' — that event
  // fires briefly between seeks/src-swaps even when a valid source
  // is still set, and clearing the ratio there leaves the next paint
  // at the 16:9 fallback for a beat (which is the "two frames look
  // different" symptom you'd see during scrubbing). Only clear when
  // the element has no src at all.
  if (viewerVideo) {
    const _syncVideoAr = () => {
      const w = viewerVideo.videoWidth || 0;
      const h = viewerVideo.videoHeight || 0;
      if (w > 0 && h > 0) {
        const ar = `${w} / ${h}`;
        viewerVideo.style.aspectRatio = ar;
        viewerVideo.style.setProperty('--video-ar', ar);
      }
    };
    viewerVideo.addEventListener('loadedmetadata', _syncVideoAr);
    viewerVideo.addEventListener('loadeddata',     _syncVideoAr);
    viewerVideo.addEventListener('resize',         _syncVideoAr);
    viewerVideo.addEventListener('emptied', () => {
      // Only fully clear when there's truly no source anymore.
      if (!viewerVideo.src) {
        viewerVideo.style.removeProperty('aspect-ratio');
        viewerVideo.style.removeProperty('--video-ar');
      }
    });
  }
  binRefreshBtn?.addEventListener('click', () => _refreshBin());
  // Bins collapse toggle — folds the bin list away so the viewer can
  // claim that horizontal space when the user is focused on the
  // timeline. The grid template flips via :has() in CSS; we only
  // need to toggle the class on .edit-bins here.
  const binsCollapseBtn = document.getElementById('edit-bins-collapse');
  const binsEl          = document.getElementById('edit-bins');
  binsCollapseBtn?.addEventListener('click', () => {
    binsEl?.classList.toggle('is-collapsed');
  });
  // Bins width drag handle. Sets --edit-bins-width on .edit-top while
  // dragging; persists to localStorage on release so the column width
  // survives reloads. Min 160px keeps the head buttons in their cell;
  // max half-viewport keeps the viewer from collapsing to zero.
  const binsResize = document.getElementById('edit-bins-resize');
  const editTopEl  = paneEl?.querySelector('.edit-top');
  const BIN_WIDTH_KEY = 'edit.binsWidth';
  const BIN_WIDTH_MIN = 160;
  const BIN_WIDTH_MAX_FRAC = 0.5;
  try {
    const saved = parseInt(localStorage.getItem(BIN_WIDTH_KEY) || '', 10);
    if (Number.isFinite(saved) && saved >= BIN_WIDTH_MIN) {
      editTopEl?.style.setProperty('--edit-bins-width', `${saved}px`);
    }
  } catch {}
  if (binsResize && editTopEl) {
    binsResize.addEventListener('mousedown', (ev) => {
      if (binsEl?.classList.contains('is-collapsed')) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const startW = (binsEl?.getBoundingClientRect().width) || 260;
      binsResize.classList.add('is-dragging');
      document.body.style.cursor = 'col-resize';
      function onMove(mv) {
        const dx = mv.clientX - startX;
        const maxW = Math.floor(window.innerWidth * BIN_WIDTH_MAX_FRAC);
        const next = Math.max(BIN_WIDTH_MIN, Math.min(maxW, Math.round(startW + dx)));
        editTopEl.style.setProperty('--edit-bins-width', `${next}px`);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        binsResize.classList.remove('is-dragging');
        document.body.style.cursor = '';
        const current = getComputedStyle(editTopEl).getPropertyValue('--edit-bins-width').trim();
        const px = parseInt(current, 10);
        if (Number.isFinite(px)) {
          try { localStorage.setItem(BIN_WIDTH_KEY, String(px)); } catch {}
        }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }
  // Inspector collapse toggle — mirror of bins on the right side.
  // Same :has()-driven grid response; same class toggle pattern.
  const inspectCollapseBtn = document.getElementById('edit-inspect-collapse');
  const inspectEl          = document.getElementById('edit-inspect');
  inspectCollapseBtn?.addEventListener('click', () => {
    inspectEl?.classList.toggle('is-collapsed');
  });

  // ── COLOR panel wiring ──────────────────────────────────────────
  // Each slider writes to the currently-selected timeline clip's
  // color state and immediately refreshes the viewer's CSS+SVG
  // filter chain. The reset chip restores defaults.
  _ensureColorBindings();
  for (const k of Object.keys(COLOR_DEFAULTS)) {
    const el = _colorEls?.[k];
    if (!el) continue;
    el.addEventListener('input', () => {
      const sel = _findSelectedClip();
      if (!sel) return;
      const color = _ensureColor(sel.clip);
      const val = parseFloat(el.value);
      if (!Number.isFinite(val)) return;
      color[k] = val;
      if (_colorValEls[k]) _colorValEls[k].textContent = String(val);
      _applyColorToViewer(color);
    });
  }
  document.getElementById('edit-color-reset')?.addEventListener('click', () => {
    const sel = _findSelectedClip();
    if (!sel) return;
    _pushHistory();
    sel.clip.color = { ...COLOR_DEFAULTS };
    _renderColorPanel();
    _applyColorToViewer(sel.clip.color);
    _setStatus('COLOR · RESET', 'ok');
  });

  // ── PROXY toggle ────────────────────────────────────────────────
  // Click cycles: none → requesting → generating → ready → (click) →
  // deleted (back to none). Cancelling mid-generation also deletes
  // the in-flight job.
  document.getElementById('edit-proxy-btn')?.addEventListener('click', () => {
    const sel = _findSelectedClip();
    if (!sel || sel.clip.kind === 'image') return;
    const path = sel.clip.path;
    const state = _proxyByPath.get(path);
    if (state?.status === 'ready') {
      _proxyByPath.delete(path);
      window.dash?.editProxyDeleteOne?.(path).catch(() => {});
      _renderProxyBtn();
      _setStatus(`PROXY · OFF · ${sel.clip.name}`, 'ok');
      // If we were scrubbing against the proxy, drop back to source.
      if (_viewerSrcSet?.startsWith('dash3d-file://proxy/')) {
        _viewerSrcSet = '';
        if (_viewerMode === 'timeline') _syncViewerToPlayhead();
      }
    } else if (state?.status === 'generating' || state?.status === 'requesting') {
      _proxyByPath.delete(path);
      window.dash?.editProxyDeleteOne?.(path).catch(() => {});
      _renderProxyBtn();
      _setStatus(`PROXY · CANCELED · ${sel.clip.name}`, 'ok');
    } else {
      _requestProxyForPath(path, sel.clip.name);
      _renderProxyBtn();
    }
  });

  // Tool mode toggles
  for (const b of toolBtns) {
    b.addEventListener('click', () => _setTool(b.dataset.tool));
  }
  snapBtn?.addEventListener('click', () => _setSnap(!_snap));
  // Viewer mode toggles
  for (const b of viewerModeBtns) {
    b.addEventListener('click', () => _setViewerMode(b.dataset.viewerMode));
  }
  // Fast-add buttons
  // Fast-add buttons — wrap each in a try/catch so a malformed
  // _binSelected (image slipped in, NaN duration, etc.) surfaces as
  // a status line instead of crashing the renderer.
  const _safeAdd = (kind) => {
    try { _addClipFromBin(kind); }
    catch (err) {
      console.warn('[edit] addClipFromBin failed:', err);
      _setStatus(`ADD ${kind.toUpperCase()} FAILED · ${err?.message || err}`, 'error');
    }
  };
  fastAddBtns.append   ?.addEventListener('click', () => _safeAdd('append'));
  fastAddBtns.smart    ?.addEventListener('click', () => _safeAdd('smart'));
  fastAddBtns.top      ?.addEventListener('click', () => _safeAdd('top'));
  fastAddBtns.ripple   ?.addEventListener('click', () => _safeAdd('ripple'));
  fastAddBtns.closeup  ?.addEventListener('click', () => _safeAdd('closeup'));
  fastAddBtns.overwrite?.addEventListener('click', () => _safeAdd('overwrite'));
  // Transport buttons
  transportBtns.jstart?.addEventListener('click', () => { _project.playheadTime = 0; _renderPlayhead(); _syncViewerToPlayhead(); });
  transportBtns.jprev ?.addEventListener('click', () => _jumpToEditPoint(-1));
  transportBtns.jback ?.addEventListener('click', () => _transportPlay(-1));
  transportBtns.jpause?.addEventListener('click', () => _transportPlay(0));
  transportBtns.jfwd  ?.addEventListener('click', () => _transportPlay(+1));
  transportBtns.jnext ?.addEventListener('click', () => _jumpToEditPoint(+1));
  transportBtns.jend  ?.addEventListener('click', () => { _project.playheadTime = _projectDuration(); _renderPlayhead(); _syncViewerToPlayhead(); });
  transportBtns.markIn ?.addEventListener('click', () => _markSource('in'));
  transportBtns.markOut?.addEventListener('click', () => _markSource('out'));
  // Zoom slider
  zoomInput?.addEventListener('input', () => {
    _project.pxPerSec = parseInt(zoomInput.value, 10) || 80;
    _renderTimeline();
  });
  // ── Temporal-denoise toggle + strength slider ─────────────────
  // Toggle arms the live-preview filter on the viewer and sets the
  // .is-active class on the button. Strength slider re-applies the
  // filter values without re-toggling. The actual ffmpeg hqdn3d
  // params get derived in _applyDenoise() from _denoise.strength.
  const denoiseBtn   = document.getElementById('edit-tool-denoise');
  const denoiseSlide = document.getElementById('edit-tl-denoise');
  const denoiseWrap  = document.getElementById('edit-tool-denoise-strength');
  function _applyDenoise() {
    if (!viewerVideo) return;
    if (_denoise.on) {
      // Strength 0-100 → blur radius 0-1.8px (very subtle; real
      // temporal smoothing is sub-pixel — anything more reads as
      // bokeh, not denoise). Contrast lifts slightly to avoid a
      // muddy grey look at higher strengths.
      const blur = (_denoise.strength / 100) * 1.8;
      const ctr  = 1 + (_denoise.strength / 100) * 0.05;
      viewerVideo.style.setProperty('--denoise-blur', blur.toFixed(2));
      viewerVideo.style.setProperty('--denoise-contrast', ctr.toFixed(2));
      denoiseBtn?.classList.add('is-active');
      if (denoiseWrap) denoiseWrap.hidden = false;
    } else {
      viewerVideo.style.setProperty('--denoise-blur', '0');
      viewerVideo.style.setProperty('--denoise-contrast', '1');
      denoiseBtn?.classList.remove('is-active');
      if (denoiseWrap) denoiseWrap.hidden = true;
    }
  }
  denoiseBtn?.addEventListener('click', () => {
    _denoise.on = !_denoise.on;
    _applyDenoise();
  });
  denoiseSlide?.addEventListener('input', () => {
    _denoise.strength = parseInt(denoiseSlide.value, 10) || 0;
    if (_denoise.on) _applyDenoise();   // only refresh visuals if armed
  });
  // Seed initial state (off, strength 60).
  _applyDenoise();

  // ── EXPORT button ─────────────────────────────────────────────
  // Renders the currently-selected source clip (trimmed to mark
  // IN/OUT if set, otherwise full duration) through the main process
  // ffmpeg pipeline. Auto-picks NVENC (NVIDIA CUDA) when available;
  // falls back to QSV / AMF / libx264. The current DENOISE state
  // flows through automatically — no extra UI step required.
  const exportBtn      = document.getElementById('edit-tool-export');
  const exportProgress = document.getElementById('edit-tool-export-progress');
  let _exportInFlight  = false;
  let _exportProgressUnsub = null;
  function _setExportProgress(percent, encoder) {
    if (!exportProgress) return;
    if (percent == null) { exportProgress.hidden = true; return; }
    exportProgress.hidden = false;
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    exportProgress.textContent = encoder
      ? `${pct}% · ${String(encoder).toUpperCase()}`
      : `${pct}%`;
  }
  // Container/codec maps for the modal's FORMAT picker. The actual
  // encoder selection (NVENC vs libx264 vs libx265 vs libvpx-vp9) is
  // resolved in main.js — here we just forward the chosen format key.
  const _FORMAT_EXT = {
    'mp4-h264': '.mp4',
    'mp4-h265': '.mp4',
    'webm-vp9': '.webm',
    'mov-hevc': '.mov',
  };
  // Open the export-options modal. Reads current state (trim marks,
  // denoise) so the user only has to pick the OUTPUT settings.
  function _openExportModal() {
    if (_exportInFlight) return;
    if (!_binSelected) {
      _setStatus('EXPORT · NO SOURCE CLIP SELECTED', 'error');
      return;
    }
    const srcPath = _binSelected.path || '';
    if (_IMAGE_RE.test(srcPath) || !_VIDEO_RE.test(srcPath)) {
      _setStatus('EXPORT · IMAGES NOT SUPPORTED — VIDEO ONLY', 'error');
      return;
    }
    const modal = document.getElementById('edit-export-modal');
    if (!modal) { _doExport(); return; } // legacy fallback if HTML is stale
    // Pre-fill filename suggestion from the source basename (stripped
    // of extension). Leaving it empty triggers the USER NNNN sequence
    // on the main side.
    const nameInput = document.getElementById('edit-export-name');
    if (nameInput && !nameInput.value) {
      const base = (_binSelected.name || _binSelected.rel || '')
        .replace(/\.[^.]+$/, '')
        .replace(/[\\/]/g, '_')
        .slice(0, 64);
      nameInput.value = base;
    }
    _refreshExportSuffix();
    modal.hidden = false;
    // Pull focus into the modal so keystrokes hit the filename field
    // instead of bubbling to the timeline's global keyhandler. Selects
    // the pre-filled basename so the user can immediately overtype it.
    requestAnimationFrame(() => {
      try {
        nameInput?.focus();
        nameInput?.select?.();
      } catch {}
    });
  }
  function _closeExportModal() {
    const modal = document.getElementById('edit-export-modal');
    if (modal) modal.hidden = true;
  }
  function _refreshExportSuffix() {
    const fmt = (document.getElementById('edit-export-format')?.value) || 'mp4-h264';
    const suf = document.getElementById('edit-export-suffix');
    if (suf) suf.textContent = _FORMAT_EXT[fmt] || '.mp4';
    // Custom-bitrate row is only meaningful when QUALITY is "custom".
    const qual = (document.getElementById('edit-export-quality')?.value) || 'high';
    const brRow = document.getElementById('edit-export-row-bitrate');
    if (brRow) brRow.hidden = qual !== 'custom';
  }
  // Read the modal's current values into a clean opts object the IPC
  // can consume. Returns null if validation fails (caller stays open).
  function _readExportOpts() {
    const nameRaw  = (document.getElementById('edit-export-name')?.value || '').trim();
    // Filesystem-safe — drop anything that isn't alnum/space/_/-/.
    const name     = nameRaw.replace(/[^A-Za-z0-9 _\-.]/g, '').slice(0, 80);
    const format   = (document.getElementById('edit-export-format')?.value) || 'mp4-h264';
    const quality  = (document.getElementById('edit-export-quality')?.value) || 'high';
    const bitrate  = Number(document.getElementById('edit-export-bitrate')?.value) || 0;
    const fpsRaw   = (document.getElementById('edit-export-fps')?.value) || '';
    const resRaw   = (document.getElementById('edit-export-res')?.value) || '';
    const fps      = fpsRaw ? Math.max(15, Math.min(120, Number(fpsRaw))) : null;
    const resHeight = resRaw ? Math.max(120, Math.min(4320, Number(resRaw))) : null;
    if (quality === 'custom' && (!Number.isFinite(bitrate) || bitrate <= 0)) {
      _setStatus('EXPORT · ENTER A VALID BITRATE', 'error');
      return null;
    }
    return { name, format, quality, bitrate, fps, resHeight };
  }
  async function _doExport(userOpts) {
    if (_exportInFlight) return;
    if (!_binSelected) {
      _setStatus('EXPORT · NO SOURCE CLIP SELECTED', 'error');
      return;
    }
    // Defensive type-check — ffmpeg will reject images via the
    // existing IPC's filter chain, but a stray PNG/JPG sent to the
    // pipeline can hang stderr parsing for a long time before erroring
    // out. Catching the wrong type here is cheaper and gives a
    // clearer message.
    const srcPath = _binSelected.path || '';
    if (_IMAGE_RE.test(srcPath) || !_VIDEO_RE.test(srcPath)) {
      _setStatus('EXPORT · IMAGES NOT SUPPORTED — VIDEO ONLY', 'error');
      return;
    }
    if (!window.dash?.editExportVideo) {
      _setStatus('EXPORT · IPC UNAVAILABLE', 'error');
      return;
    }
    // Trim range: mark IN/OUT if both set and form a valid range,
    // otherwise the full clip duration.
    const dur = _binSelected.duration || 0;
    let trimIn  = 0;
    let trimOut = dur > 0.05 ? dur : 0.05;
    if (_markIn != null && _markOut != null && Math.abs(_markOut - _markIn) > 0.05) {
      trimIn  = Math.max(0, Math.min(_markIn, _markOut));
      trimOut = Math.max(0, Math.max(_markIn, _markOut));
    }
    _exportInFlight = true;
    exportBtn?.classList.add('is-exporting');
    if (exportBtn) exportBtn.disabled = true;
    _setExportProgress(0, null);
    _setStatus('EXPORT · STARTING…');
    // Subscribe to progress events; unsubscribe on finish.
    try { _exportProgressUnsub?.(); } catch {}
    _exportProgressUnsub = window.dash?.onEditExportProgress?.((p) => {
      _setExportProgress(p?.percent ?? 0, p?.encoder);
    }) || null;
    try {
      const result = await window.dash.editExportVideo({
        srcPath: _binSelected.path,
        trimIn,
        trimOut,
        // Temporal-denoise state flows straight from the UI — main.js
        // maps strength → hqdn3d's luma_tmp + chroma_tmp values.
        denoiseTemporal: _denoise.on,
        denoiseTemporalStrength: _denoise.strength,
        // Output settings from the modal (or undefined for legacy path).
        outputName:     userOpts?.name || undefined,
        outputFormat:   userOpts?.format || undefined,
        outputQuality:  userOpts?.quality || undefined,
        outputBitrate:  userOpts?.bitrate || undefined,
        outputFps:      userOpts?.fps || undefined,
        outputHeight:   userOpts?.resHeight || undefined,
      });
      if (result?.ok) {
        const sizeMb = result.size ? (result.size / (1024 * 1024)).toFixed(1) + ' MB' : '';
        _setStatus(`EXPORT · SAVED ${result.name || ''} ${sizeMb}`.trim(), 'ok');
        _setExportProgress(100, null);
        // Workspace's "I'm done" signal: drop every proxy. The user
        // is treating this build as session-scoped — no save means
        // no persistent cache either.
        _clearAllProxies();
        // Clear the chip after a beat so the user sees the final %
        // before it disappears.
        setTimeout(() => _setExportProgress(null), 2500);
      } else {
        _setStatus(`EXPORT · FAILED · ${result?.error || 'unknown'}`, 'error');
        _setExportProgress(null);
      }
    } catch (err) {
      _setStatus(`EXPORT · ERROR · ${err?.message || err}`, 'error');
      _setExportProgress(null);
    } finally {
      _exportInFlight = false;
      exportBtn?.classList.remove('is-exporting');
      if (exportBtn) exportBtn.disabled = false;
      try { _exportProgressUnsub?.(); } catch {}
      _exportProgressUnsub = null;
    }
  }
  exportBtn?.addEventListener('click', () => { _openExportModal(); });

  // ── Export modal wiring ───────────────────────────────────────
  document.getElementById('edit-export-format')?.addEventListener('change', _refreshExportSuffix);
  document.getElementById('edit-export-quality')?.addEventListener('change', _refreshExportSuffix);
  document.getElementById('edit-export-cancel')?.addEventListener('click', _closeExportModal);
  document.getElementById('edit-export-cancel-x')?.addEventListener('click', _closeExportModal);
  document.getElementById('edit-export-modal')?.addEventListener('click', (e) => {
    // Click outside the card closes the modal (the card itself stops propagation).
    if (e.target?.id === 'edit-export-modal') _closeExportModal();
  });
  // Guarantee clicks on the modal card don't bubble to global handlers
  // (timeline / topbar drag) that might steal focus before the input
  // gets it. mousedown is the critical event for focus capture.
  document.querySelector('#edit-export-modal .edit-export-card')
    ?.addEventListener('mousedown', (e) => e.stopPropagation());
  document.getElementById('edit-export-go')?.addEventListener('click', () => {
    const opts = _readExportOpts();
    if (!opts) return; // validation failed; status already set
    _closeExportModal();
    _doExport(opts);
  });

  // ── UNDO / REDO buttons ───────────────────────────────────────
  document.getElementById('edit-tool-undo')?.addEventListener('click', () => _undo());
  document.getElementById('edit-tool-redo')?.addEventListener('click', () => _redo());

  // ── Viewer zoom HUD + wheel + pan ─────────────────────────────
  const stageEl     = document.getElementById('edit-viewer-stage');
  const zoomInBtn   = document.getElementById('edit-viewer-zoom-in');
  const zoomOutBtn  = document.getElementById('edit-viewer-zoom-out');
  const zoomResetBt = document.getElementById('edit-viewer-zoom-reset');
  zoomInBtn  ?.addEventListener('click', () => _zoomBy(+ZOOM_STEP));
  zoomOutBtn ?.addEventListener('click', () => _zoomBy(-ZOOM_STEP));
  zoomResetBt?.addEventListener('click', () => _resetZoom());

  // Mouse wheel zoom — anchored at the cursor position so zoom feels
  // natural (the pixel under the cursor stays put as you zoom in).
  stageEl?.addEventListener('wheel', (ev) => {
    // Only intercept when the cursor is over the stage AND a video is
    // loaded. Otherwise let the wheel scroll the surrounding container.
    if (!viewerVideo?.src) return;
    ev.preventDefault();
    const dir = ev.deltaY < 0 ? +1 : -1;
    const rect = stageEl.getBoundingClientRect();
    const ax = (ev.clientX - rect.left) / rect.width  - 0.5;
    const ay = (ev.clientY - rect.top)  / rect.height - 0.5;
    _zoomBy(dir * ZOOM_STEP, ax, ay);
  }, { passive: false });

  // Double-click anywhere on the stage resets zoom + pan. Matches the
  // affordance promised in the panel-title tooltip.
  stageEl?.addEventListener('dblclick', (ev) => {
    if (!viewerVideo?.src) return;
    if (_zoom.level <= 1.001) return;
    ev.preventDefault();
    _resetZoom();
  });

  // Click-and-drag pan when zoomed in.
  let _panActive = false, _panStartX = 0, _panStartY = 0, _panOrigX = 0, _panOrigY = 0;
  stageEl?.addEventListener('mousedown', (ev) => {
    if (_zoom.level <= 1.001) return;        // no pan when not zoomed
    if (ev.button !== 0) return;             // left button only
    _panActive = true;
    _panStartX = ev.clientX; _panStartY = ev.clientY;
    _panOrigX = _zoom.x; _panOrigY = _zoom.y;
    viewerVideo?.classList.add('is-panning');
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!_panActive) return;
    const rect = stageEl?.getBoundingClientRect();
    if (!rect) return;
    // Pan delta in fraction-of-stage units, scaled DOWN by the zoom
    // level so dragging feels 1:1 with the on-screen pixel motion
    // regardless of how zoomed in we are.
    const dx = (ev.clientX - _panStartX) / rect.width  / _zoom.level;
    const dy = (ev.clientY - _panStartY) / rect.height / _zoom.level;
    // Clamp pan so the user can't drag the video entirely off the
    // viewport (limit = half the "extra" zoomed extent).
    const limit = (1 - 1 / _zoom.level) * 0.5;
    _zoom.x = Math.max(-limit, Math.min(limit, _panOrigX + dx));
    _zoom.y = Math.max(-limit, Math.min(limit, _panOrigY + dy));
    _applyZoom();
  });
  window.addEventListener('mouseup', () => {
    if (!_panActive) return;
    _panActive = false;
    viewerVideo?.classList.remove('is-panning');
  });

  // Keyboard shortcuts — Ctrl+Z / Ctrl+Y for undo/redo, + / - for
  // zoom, 0 to reset. Only fires when the EDIT pane is active and
  // focus isn't inside a text input (so the user can still type in
  // the city name fields, etc.).
  document.addEventListener('keydown', (ev) => {
    if (!_active) return;
    const tag = (ev.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable) return;
    if (ev.ctrlKey || ev.metaKey) {
      // Ctrl+Z = undo. Ctrl+Y or Ctrl+Shift+Z = redo.
      const k = ev.key.toLowerCase();
      if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); _undo(); return; }
      if (k === 'z' &&  ev.shiftKey) { ev.preventDefault(); _redo(); return; }
      if (k === 'y')                 { ev.preventDefault(); _redo(); return; }
    } else {
      if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); _zoomBy(+ZOOM_STEP); }
      else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); _zoomBy(-ZOOM_STEP); }
      else if (ev.key === '0') { ev.preventDefault(); _resetZoom(); }
    }
  });

  // Initial history-button state (both disabled).
  _updateHistoryButtons();
  // Timeline click-to-seek + drag-to-scrub
  tlContent?.addEventListener('mousedown', _onContentMouseDown);
  // Dedicated ruler scrub — the ruler is the conventional scrub bar in
  // every NLE. Bind a direct mousedown handler so the scrub is
  // guaranteed regardless of any other listener wiring. Drag continues
  // until mouseup anywhere on the document. The dedicated handler also
  // makes scrubbing work even before any clip is dropped: it just
  // updates the playhead time and lets the rAF / sync handle the rest
  // once a clip arrives.
  rulerEl?.addEventListener('mousedown', _onRulerMouseDown);
  // Drop from bin onto a track. Three handlers per lane:
  //   dragover  → must preventDefault so the drop event fires
  //   dragenter → show the dashed-outline hover affordance
  //   dragleave → clear the affordance
  //   drop      → fully select the clip (so viewer.src loads) and add it
  //
  // The dragover handler also previews where the playhead would land,
  // so the user gets immediate spatial feedback while hovering.
  for (const [tid, el] of [['V1', trackV1El], ['V2', trackV2El], ['A1', trackA1El]]) {
    if (!el) continue;
    el.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      el.classList.add('is-drop-hover');
      // Live preview of where the drop will land. Updates the playhead
      // so the user sees the drop target before committing. Cheap —
      // dragover fires ~60Hz which is fine for moving a CSS-positioned
      // line.
      const previewT = _clientXToTime(ev.clientX);
      _project.playheadTime = previewT;
      _renderPlayhead();
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-hover'));
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      el.classList.remove('is-drop-hover');
      // Wrap the entire async drop pipeline in a try/catch so any
      // single failure (bad file, metadata probe throw, render error)
      // surfaces as a status line instead of crashing the renderer
      // and forcing a window reload.
      try {
        // Sequence drop: every frame in a snap-capture run lands as
        // a back-to-back image clip at the cursor.
        const seqJson = ev.dataTransfer?.getData('application/x-edit-clip-seq');
        if (seqJson) {
          const paths = (() => { try { return JSON.parse(seqJson); } catch { return null; } })();
          if (Array.isArray(paths) && paths.length) {
            const dropT = _clientXToTime(ev.clientX);
            _pushHistory();
            const PER_FRAME = 1.0;
            let cursor = dropT;
            const v1Free = !_clipAt(_project.tracks.V1, cursor);
            const targetTid = v1Free ? 'V1' : 'V2';
            let placed = 0;
            for (const p of paths) {
              const e = _bin.find((b) => b.path === p);
              if (!e) continue;
              const dur = (e.kind === 'image') ? PER_FRAME
                : (Number.isFinite(e.duration) && e.duration > 0 ? e.duration : PER_FRAME);
              _project.tracks[targetTid].push({
                id: ++_clipSeq,
                path: e.path,
                rel:  e.rel,
                name: e.name,
                kind: e.kind || 'image',
                start: cursor,
                dur,
                srcIn: 0,
                srcOut: dur,
              });
              cursor += dur;
              placed++;
            }
            _project.playheadTime = dropT;
            _renderTimeline();
            _depsPaint();
            _setViewerMode('timeline');
            _setStatus(`SEQUENCE · ${placed} FRAMES ON ${targetTid}`, 'ok');
            return;
          }
        }
        const path = ev.dataTransfer?.getData('application/x-edit-clip');
        if (!path) return;
        if (!_VIDEO_RE.test(path) && !_IMAGE_RE.test(path)) {
          _setStatus(`UNSUPPORTED FILE TYPE — ${path.split('.').pop()?.toUpperCase()}`, 'error');
          return;
        }
        const entry = _bin.find((e) => e.path === path);
        if (!entry) return;
        // Capture the drop position from the event BEFORE awaiting —
        // by the time the metadata probe resolves, ev.clientX/clientY
        // may already be pointer-cleaned-up by the browser. NO snap
        // on drop: the user wants the clip to land EXACTLY where the
        // cursor was.
        const dropT = _clientXToTime(ev.clientX);
        // Full-select the dragged entry. This loads the viewer's
        // <video> so transport works immediately after a drop. Also
        // resets the IN/OUT marks.
        _selectBinEntry(entry);
        // If the row was dragged without ever being clicked-selected
        // first, its duration may still be 0. Probe via a throwaway
        // <video> before adding so the clip isn't rejected with
        // "SOURCE DURATION UNKNOWN".
        if (!entry.duration || entry.duration <= 0) {
          _setStatus('PROBING METADATA…');
          const probed = await _probeDuration(entry);
          // Reject NaN / Infinity / 0 — any of those would propagate
          // into _addClipFromBin's clip.dur and corrupt the timeline.
          entry.duration = (Number.isFinite(probed) && probed > 0) ? probed : 0;
          if (!entry.duration) {
            _setStatus('CANNOT READ DURATION — IS THIS A REAL VIDEO?', 'error');
            return;
          }
          _renderBin();
          _renderInspect();
        }
        _project.playheadTime = dropT;
        // Smart Insert (auto-pick free track at playhead). ignoreMarks
        // = true: drag-drop always places the full clip.
        _addClipFromBin('smart', /* ignoreMarks */ true);
        _setViewerMode('timeline');
      } catch (err) {
        console.warn('[edit] timeline drop failed:', err);
        _setStatus(`DROP FAILED · ${err?.message || err}`, 'error');
      }
    });
  }
}

// ── Public lifecycle ─────────────────────────────────────────────────

export function init(deps) {
  if (_ready) return;
  _deps = deps || null;
  _grabDom();
  if (!paneEl) return; // markup missing — guard against partial loads
  _wireEvents();
  _setTool(_tool);
  _setSnap(_snap);
  _renderTimeline();
  _renderInspect();
  _paintViewerMode();
  // Self-healing proxy fallback. If a proxy URL fails to decode
  // (e.g. an older cached file that predates a pixel-format fix),
  // evict it from the path map and re-sync the viewer so it falls
  // back to the source URL automatically. Without this the viewer
  // just goes black with a console NotSupportedError and the user
  // has no way to recover except deleting the cache folder.
  viewerVideo?.addEventListener('error', () => {
    const failedUrl = _viewerSrcSet;
    const code = viewerVideo.error?.code;
    const codeName = code === 1 ? 'ABORTED'
                   : code === 2 ? 'NETWORK'
                   : code === 3 ? 'DECODE'
                   : code === 4 ? 'NOT_SUPPORTED'
                   : `UNKNOWN(${code})`;
    const msg = viewerVideo.error?.message || '';
    console.warn('[edit] video error', {
      code, codeName, message: msg,
      networkState: viewerVideo.networkState,
      readyState: viewerVideo.readyState,
      src: failedUrl,
    });
    if (!failedUrl || !failedUrl.startsWith('dash3d-file://proxy/')) {
      _setStatus(`VIDEO ERROR · ${codeName} · ${msg.slice(0, 80)}`, 'error');
      return;
    }
    console.warn('[edit] proxy playback failed, evicting', failedUrl);
    // Diagnostic — what does the protocol handler actually return for
    // this URL? If we see a real MP4's `ftyp` magic in the bytes, the
    // file is fine and the bug is in Chromium's demuxer. If we see
    // anything else, the file or route is wrong.
    fetch(failedUrl, { headers: { 'Range': 'bytes=0-31' } })
      .then(async (res) => {
        const buf = new Uint8Array(await res.arrayBuffer());
        const hex = Array.from(buf).slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
        const asc = Array.from(buf).slice(0, 16).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
        console.warn('[edit] proxy diag', { url: failedUrl, http: res.status, len: res.headers.get('content-length'), type: res.headers.get('content-type'), hex, asc });
        _setStatus(`PROXY DIAG · http:${res.status} type:${res.headers.get('content-type')} bytes:${hex.slice(0, 16)} ascii:"${asc.slice(0, 8)}"`, 'error');
      })
      .catch((e) => {
        console.warn('[edit] proxy diag fetch failed', e);
        _setStatus(`PROXY DIAG · fetch threw · ${e.message}`, 'error');
      });
    for (const [path, entry] of _proxyByPath) {
      if (entry?.url === failedUrl) { _proxyByPath.delete(path); break; }
    }
    _viewerSrcSet = '';
    if (_viewerMode === 'timeline') _syncViewerToPlayhead();
    else if (_binSelected) {
      const url = `dash3d-file://gallery/${encodeURI(_binSelected.rel)}`;
      viewerVideo.src = url;
      _viewerSrcSet = url;
    }
  });

  // Subscribe to main's proxy-done events. The path-keyed map is the
  // single source of truth — once written, both the source-mode and
  // timeline-mode viewers will pick up the proxy URL on their next
  // sync. _swapToProxyForPath hot-swaps a currently-playing source
  // viewer in place; the timeline path re-syncs explicitly.
  window.dash?.onEditProxyDone?.((payload) => {
    if (!payload?.srcPath) return;
    console.warn('[edit] proxy done', payload);
    if (payload.status === 'ready' && payload.rel) {
      _proxyByPath.set(payload.srcPath, {
        status: 'ready',
        url: `dash3d-file://proxy/${encodeURI(payload.rel)}`,
      });
      _swapToProxyForPath(payload.srcPath);
      if (_viewerMode === 'timeline') _syncViewerToPlayhead();
      const name = _bin.find((e) => e.path === payload.srcPath)?.name || '';
      const took = payload.elapsedSec ? ` · ${payload.elapsedSec}s` : '';
      const mb = payload.size ? ` · ${(payload.size / 1024 / 1024).toFixed(1)}MB` : '';
      _setStatus(`PROXY · READY${name ? ' · ' + name : ''}${took}${mb}`, 'ok');
    } else if (payload.status === 'failed') {
      _proxyByPath.set(payload.srcPath, { status: 'failed' });
      _setStatus(`PROXY · FAILED · ${payload.error || 'unknown'}`, 'error');
    } else {
      _proxyByPath.set(payload.srcPath, { status: payload.status });
    }
    // Refresh the PROXY button in case the user is still on the clip
    // whose proxy just finished/failed.
    _renderProxyBtn();
  });
  _ready = true;
}

export async function activate() {
  if (!_ready) return;
  _active = true;
  // Force the Electron renderer back to 100% zoom. If the user
  // accidentally hit Ctrl+Plus/Minus, the page zoom drifts and click
  // coordinates stop matching what they see.
  try {
    const electron = (window.require ? window.require('electron') : null);
    if (electron?.webFrame?.setZoomFactor) electron.webFrame.setZoomFactor(1);
    if (electron?.webFrame?.setZoomLevel)  electron.webFrame.setZoomLevel(0);
  } catch {}
  // Install keyboard handler. Bound + saved so deactivate can remove it.
  _kbHandler = (ev) => _onKey(ev);
  document.addEventListener('keydown', _kbHandler);
  // Refresh bin (cheap-ish, max 1-level recursion across 3 dirs).
  await _refreshBin();
  // Consume REC ROOM → EDIT ROOM handoff if one is pending.
  const h = window._editHandoff;
  if (h && h.path) {
    window._editHandoff = null;
    const entry = _bin.find((e) => e.path === h.path);
    if (entry) _selectBinEntry(entry);
  }
  _renderTimeline();
  _startRaf();
  _setStatus('READY');
}

export function deactivate() {
  _active = false;
  _stopRaf();
  if (_kbHandler) {
    document.removeEventListener('keydown', _kbHandler);
    _kbHandler = null;
  }
  try { viewerVideo?.pause(); } catch {}
}
