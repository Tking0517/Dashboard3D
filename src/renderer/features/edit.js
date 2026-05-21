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

const _VIDEO_RE = /\.(mp4|webm|m4v|ogv|ogg|mov|mkv)$/i;
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
  selectedClipId: null,
  tracks: { V2: [], V1: [], A1: [] },
};
window._editProject = _project; // surfaced for app.js paint-header

// Tool mode: 'select' | 'trim' | 'razor'. Snap is a separate boolean.
let _tool = 'select';
let _snap = true;
let _viewerMode = 'source'; // 'source' | 'timeline'

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
let viewerVideo, viewerEmpty, viewerStage, viewerTcEl;
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
          for (const f of (sub?.entries || [])) {
            if (!f.isDir && _VIDEO_RE.test(f.name)) {
              _bin.push({
                path: f.path,
                rel:  f.rel || `${root}/${e.name}/${f.name}`,
                name: f.name,
                mtime: f.mtime || 0,
                size: f.size || 0,
                duration: 0,
                fps: _project.fps,
              });
            }
          }
        } else if (_VIDEO_RE.test(e.name)) {
          _bin.push({
            path: e.path,
            rel:  e.rel || `${root}/${e.name}`,
            name: e.name,
            mtime: e.mtime || 0,
            size: e.size || 0,
            duration: 0,
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
  for (const e of _bin) {
    const row = document.createElement('div');
    row.className = 'edit-bin-row';
    if (_binSelected && _binSelected.path === e.path) row.classList.add('is-selected');
    row.dataset.path = e.path;
    row.draggable = true;
    const dur = e.duration > 0 ? `${e.duration.toFixed(1)}s` : '—';
    row.innerHTML =
      `<span class="edit-bin-row-name">${e.name}</span>` +
      `<span class="edit-bin-row-dur">${dur}</span>`;
    row.addEventListener('click', () => _selectBinEntry(e));
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('application/x-edit-clip', e.path);
      // Position the drag-image hotspot at its top-LEFT (0, 0) so the
      // user's cursor sits at the leftmost pixel of the ghost. This way
      // "where the cursor is over the timeline" == "where the clip's
      // left edge lands". The default behavior places the cursor where
      // the user grabbed the row — typically 100+ px into the row —
      // which causes the clip to land far to the right of the cursor.
      try { ev.dataTransfer.setDragImage(row, 0, 0); } catch {}
    });
    binListEl.appendChild(row);
  }
}

function _selectBinEntry(entry) {
  _binSelected = entry;
  _markIn = null;
  _markOut = null;
  _renderBin();
  _renderInspect();
  // Load into the viewer in source mode. Use the dash3d-file:// scheme
  // wired in main.js (gallery root → entry.rel).
  if (!viewerVideo) return;
  _viewerMode = 'source';
  _paintViewerMode();
  const url = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
  viewerVideo.src = url;
  viewerVideo.currentTime = 0;
  viewerEmpty?.classList.add('is-hidden');
  // Probe duration once metadata loads.
  viewerVideo.onloadedmetadata = () => {
    entry.duration = viewerVideo.duration || 0;
    _renderBin();
    _renderInspect();
  };
}

// Async best-effort duration probe via a throwaway <video> element.
// Used when a bin row is dragged without ever being clicked first —
// without this, the row's entry.duration stays 0 and _addClipFromBin
// silently rejects the add. Returns 0 if the file can't be read.
function _probeDuration(entry) {
  if (!entry) return Promise.resolve(0);
  if (entry.duration > 0) return Promise.resolve(entry.duration);
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      try { v.src = ''; v.load(); } catch {}
      resolve(d || 0);
    };
    v.addEventListener('loadedmetadata', () => finish(v.duration));
    v.addEventListener('error',         () => finish(0));
    setTimeout(() => finish(0), 5000); // safety net: never hang the drop
    v.src = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
  });
}

function _renderInspect() {
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
  insDur.textContent  = _binSelected.duration ? `${_binSelected.duration.toFixed(2)}s` : '—';
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
      if (clip.id === _project.selectedClipId) c.classList.add('is-selected');
      c.style.left  = `${clip.start * pps}px`;
      c.style.width = `${Math.max(2, clip.dur * pps)}px`;
      c.dataset.clipId = clip.id;
      c.dataset.track = tid;
      c.innerHTML =
        `<span class="edit-tl-clip-resize is-left"  data-resize="left"></span>` +
        `<span class="edit-tl-clip-name">${clip.name || ''}</span>` +
        `<span class="edit-tl-clip-resize is-right" data-resize="right"></span>`;
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
  const srcDur = _binSelected.duration || 0;
  if (srcDur <= 0) { _setStatus('SOURCE DURATION UNKNOWN — WAIT FOR METADATA', 'error'); return; }
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
  _project.selectedClipId = newClip.id;
  _renderTimeline();
  _setStatus(`${behavior.toUpperCase()} · ${newClip.name}`, 'ok');
  _depsPaint();
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
    _project.selectedClipId = clip.id;
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
  _project.selectedClipId = clip.id;
  _renderTimeline();
  _renderInspect();

  const startX = ev.clientX;
  const startTime = clip.start;
  let mode = 'pending'; // 'pending' → either 'drag' or 'scrub'

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
      clip.start = next;
      _renderTimeline();
    } else {
      // 'scrub' — playhead follows the cursor in viewport coords.
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
  if (rateEl) rateEl.textContent = '⏸';
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
  const startX = downEv.clientX;
  function onMove(mv) {
    const dxPx = mv.clientX - startX;
    const dt = dxPx / _project.pxPerSec;
    if (side === 'left') {
      let nextStart = origStart + dt;
      if (nextStart < 0) nextStart = 0;
      if (nextStart > origStart + origDur - 0.05) nextStart = origStart + origDur - 0.05;
      nextStart = _snapTime(nextStart, clip.id);
      const delta = nextStart - origStart;
      clip.start = nextStart;
      clip.dur   = origDur - delta;
      clip.srcIn = origSrcIn + delta;
    } else {
      let nextDur = origDur + dt;
      if (nextDur < 0.05) nextDur = 0.05;
      let nextEnd = origStart + nextDur;
      nextEnd = _snapTime(nextEnd, clip.id);
      clip.dur = nextEnd - origStart;
      clip.srcOut = origSrcIn + clip.dur;
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
  left.dur = atTime - clip.start;
  left.srcOut = (clip.srcIn || 0) + left.dur;
  right.start = atTime;
  right.dur = (clip.start + clip.dur) - atTime;
  right.srcIn = (clip.srcIn || 0) + left.dur;
  const arr = _project.tracks[trackId];
  const idx = arr.findIndex((c) => c.id === clip.id);
  if (idx >= 0) arr.splice(idx, 1, left, right);
  _project.selectedClipId = right.id;
  _renderTimeline();
  _setStatus(`CUT @ ${_fmtTc(atTime)}`, 'ok');
  _depsPaint();
}

function _deleteSelectedClip() {
  if (_project.selectedClipId == null) return;
  for (const tid of ['V2', 'V1', 'A1']) {
    const arr = _project.tracks[tid];
    const idx = arr.findIndex((c) => c.id === _project.selectedClipId);
    if (idx >= 0) {
      const name = arr[idx].name;
      arr.splice(idx, 1);
      _project.selectedClipId = null;
      _renderTimeline();
      _setStatus(`DELETED · ${name}`, 'ok');
      _depsPaint();
      return;
    }
  }
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
  // Initial jump + viewer sync.
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

function _syncViewerToPlayhead() {
  // Phase 1A: find the topmost clip at the playhead (V2 > V1) and seek
  // the viewer to the corresponding source time. Single-element preview
  // — no compositing yet. WebCodecs frame-accurate path lands in 1B.
  if (_viewerMode !== 'timeline' || !viewerVideo) return;
  const t = _project.playheadTime;
  const topV2 = _project.tracks.V2.find((c) => t >= c.start && t < c.start + c.dur);
  const topV1 = _project.tracks.V1.find((c) => t >= c.start && t < c.start + c.dur);
  const top = topV2 || topV1;
  if (!top) {
    viewerEmpty?.classList.remove('is-hidden');
    try { viewerVideo.pause(); } catch {}
    return;
  }
  viewerEmpty?.classList.add('is-hidden');
  const wantUrl = `dash3d-file://gallery/${encodeURI(top.rel)}`;
  if (viewerVideo.currentSrc !== wantUrl && !viewerVideo.src.endsWith(top.rel)) {
    viewerVideo.src = wantUrl;
  }
  const offset = (top.srcIn || 0) + (t - top.start);
  try { viewerVideo.currentTime = offset; } catch {}
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
  if (rateEl) rateEl.textContent = dir === 0 ? '⏸' : `${dir < 0 ? '-' : ''}${_playRate}×`;
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
    tlContent.classList.remove('tool-select', 'tool-trim', 'tool-razor');
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
      _project.playheadTime = top.start + (srcT - (top.srcIn || 0));
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
  binRefreshBtn?.addEventListener('click', () => _refreshBin());
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
  fastAddBtns.append   ?.addEventListener('click', () => _addClipFromBin('append'));
  fastAddBtns.smart    ?.addEventListener('click', () => _addClipFromBin('smart'));
  fastAddBtns.top      ?.addEventListener('click', () => _addClipFromBin('top'));
  fastAddBtns.ripple   ?.addEventListener('click', () => _addClipFromBin('ripple'));
  fastAddBtns.closeup  ?.addEventListener('click', () => _addClipFromBin('closeup'));
  fastAddBtns.overwrite?.addEventListener('click', () => _addClipFromBin('overwrite'));
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
      const path = ev.dataTransfer?.getData('application/x-edit-clip');
      if (!path) return;
      const entry = _bin.find((e) => e.path === path);
      if (!entry) return;
      // Capture the drop position from the event BEFORE awaiting — by
      // the time the metadata probe resolves, ev.clientX/clientY may
      // already be pointer-cleaned-up by the browser. NO snap on drop:
      // the user wants the clip to land EXACTLY where the cursor was.
      // Snap-to-edges is helpful when dragging clips on the timeline,
      // not when placing a fresh clip from the bin.
      const dropT = _clientXToTime(ev.clientX);
      // Full-select the dragged entry. This loads the viewer's <video>
      // so transport works immediately after a drop. Also resets the
      // IN/OUT marks — which is fine, because drag-drop will ignore
      // marks anyway (drop adds the WHOLE clip; marks are for the
      // fast-add buttons on the toolbar).
      _selectBinEntry(entry);
      // If the row was dragged without ever being clicked-selected
      // first, its duration may still be 0. Probe via a throwaway
      // <video> before adding so the clip isn't rejected with
      // "SOURCE DURATION UNKNOWN".
      if (!entry.duration || entry.duration <= 0) {
        _setStatus('PROBING METADATA…');
        entry.duration = await _probeDuration(entry);
        if (!entry.duration) { _setStatus('CANNOT READ DURATION', 'error'); return; }
        _renderBin();
        _renderInspect();
      }
      _project.playheadTime = dropT;
      // Smart Insert (auto-pick free track at playhead). ignoreMarks
      // = true: drag-drop always places the full clip, regardless of
      // any IN/OUT marks set on the source viewer. (Use the fast-add
      // toolbar buttons if you want a marked-range insert.)
      _addClipFromBin('smart', /* ignoreMarks */ true);
      // Auto-preview: switch viewer to TIMELINE so the user sees the
      // clip they just dropped in the context of the cut (instead of
      // the now-stale SOURCE view of the bin entry). _setViewerMode
      // calls _syncViewerToPlayhead which seeks to the topmost clip
      // at the playhead — which is exactly the freshly-added clip.
      _setViewerMode('timeline');
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
