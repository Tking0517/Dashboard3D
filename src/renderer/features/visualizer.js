// VISUALIZER / REC ROOM tab · in-pane video player + screen recorder +
// screencap + clip editor. Lazy combo pane — app.js dynamically import()s
// this on the first VISUALIZER open. init() receives { fmtBytes, playSfx }.
//
//   init(deps)  — one-time: build the pane, wire IPC + buttons
//   activate()  — VISUALIZER tab shown: refresh the gallery file list

import { groupSequences, extOf } from '../util/sequences.js';
import { setupProfiles } from './rec/profiles.js';
import { setupOverlays } from './rec/overlays.js';
import { setupScreencap } from './rec/screencap.js';
import { setupCrop } from './rec/crop.js';
import { setupTransport } from './rec/transport.js';
import { setupContextMenu } from './rec/context.js';
import { setupCamFilters } from './rec/cam-filters.js';
import { setupLutApplier } from './rec/lut.js';
import { pickEncoderConfig, createEncoder } from './rec/wc-encoder.js';

// PHASE A experiment flag — WebCodecs GPU-encoded capture instead of the
// raw-RGBA-to-ffmpeg pump. OFF by default; opt in with
//   localStorage.setItem('dash.rec.webcodecs', '1')
// in DevTools (then start a new recording). Any probe/encoder failure
// silently falls back to the proven raw-RGBA path.
function _wcEncodeEnabled() {
  try { return localStorage.getItem('dash.rec.webcodecs') === '1'; }
  catch { return false; }
}

// CHUNKED RECORDING — split long records into finalized ~5-min MP4
// segments so a sleep/crash only loses the in-progress chunk instead of
// the whole file. ON by default; disable per-machine with
//   localStorage.setItem('dash.rec.chunked', '0')
function _chunkedRecEnabled() {
  try { return localStorage.getItem('dash.rec.chunked') !== '0'; }
  catch { return true; }
}
// Chunk length in seconds (default 300 = 5 min). Override with
//   localStorage.setItem('dash.rec.chunkSeconds', '120')
function _chunkSeconds() {
  try {
    const v = parseInt(localStorage.getItem('dash.rec.chunkSeconds'), 10);
    return (Number.isFinite(v) && v >= 10) ? v : 300;
  } catch { return 300; }
}

let _ready = false;
let _activateImpl = null;

// File-type regexes + the captures-list time formatter. These were
// originally shared from the EXPLORE section of app.js; REC ROOM needs
// its own copies now that both panes are standalone modules.
const _IMG_RENDER_RE   = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const _IMG_KNOWN_RE    = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|psd|heic|heif|raw|cr2|nef|arw)$/i;
const _VIDEO_RENDER_RE = /\.(mp4|webm|m4v|ogv|ogg|mov|mkv)$/i;
const _VIDEO_KNOWN_RE  = /\.(mp4|webm|m4v|ogv|ogg|mov|avi|mkv|wmv|flv|3gp|3g2|asf)$/i;
function fmtFileTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: '2-digit' });
}

export function init(deps) {
  if (_ready) return;
  _ready = true;
  const fmtBytes = deps?.fmtBytes || ((n) => String(n));
  const playSfx = deps?.playSfx;
  const visualizerPane = document.querySelector('.combo-pane-visualizer');

  // ── Visualizer (video player) ───────────────────────────────────────
  // Pulls video files (recursively-ish via the same `gallery-list` IPC,
  // currently flat) from the gallery folder and lets the user pick one to
  // play in an inline <video>. Audio visualization comes for free from the
  // dashboard's existing system-loopback bars — anything playing here
  // routes through Windows audio and shows up in the OUTPUT bars panel.
  const visualizerListEl = document.getElementById('visualizer-list');
  const visualizerVideoEl = document.getElementById('visualizer-video');
  const visualizerWrapEl = visualizerPane?.querySelector('.visualizer-player-wrap');
  // Toolbar status / diagnostic readout. Lives at the right end of the
  // rec-room button row and surfaces things like REC frame/audio counts,
  // URL load errors, and mic capture failures. (Kept the legacy
  // `visualizerNowEl` name so every existing call site that writes to it
  // continues to work; the variable now points at the toolbar console
  // rather than a now-playing label under the player.)
  const visualizerNowEl = document.getElementById('visualizer-console')
    || document.getElementById('visualizer-now');
  let _visualizerEntries = [];
  let _visualizerCurrent = null;
  // Subdir within the gallery root. '' = top of gallery; otherwise a
  // forward-slash relative path like 'recordings' or 'screencap'.
  // The list acts as a navigator — clicking a folder enters it, the
  // first row is an UP entry when not at root.
  let _visualizerSubdir = '';
  // Multi-select state — only image entries can be selected (used by
  // the PROCESS button to stitch snaps into a video). Anchor is the
  // last non-shift clicked path; shift-click range-selects to it.
  let _visualizerSelected = new Set();
  let _visualizerAnchor = null;

  function _crumbFromSubdir(subdir) {
    if (!subdir) return 'REC ROOM · CAPTURES';
    return 'REC ROOM / ' + subdir.split('/').filter(Boolean).map(s => s.toUpperCase()).join(' / ');
  }

  function renderVisualizerList(entries) {
    if (!visualizerListEl) return;
    visualizerListEl.innerHTML = '';
    // Up-row when in a subdir, so the user can climb back out without
    // a separate button.
    if (_visualizerSubdir) {
      const upRow = document.createElement('li');
      upRow.className = 'visualizer-row is-dir is-up';
      upRow.dataset.action = 'up';
      upRow.innerHTML =
        `<span class="visualizer-row-name">.. (UP)</span>` +
        `<span class="visualizer-row-size">—</span>` +
        `<span class="visualizer-row-time">—</span>`;
      visualizerListEl.appendChild(upRow);
    }
    if (!entries.length && !_visualizerSubdir) {
      const empty = document.createElement('li');
      empty.className = 'explore-empty';
      empty.textContent = 'EMPTY · USE REC / SNAP TO CREATE CAPTURES, OR DROP MEDIA INTO gallery/';
      visualizerListEl.appendChild(empty);
      return;
    }
    // Collapse same-prefix numbered runs (snap-001.jpg, snap-002.jpg, …)
    // into one representative row per sequence — see util/sequences.js.
    const grouped = groupSequences(entries);
    for (const e of grouped) {
      const row = document.createElement('li');
      row.className = 'visualizer-row'
        + (e.isDir ? ' is-dir' : '')
        + (e.isSeq ? ' is-seq' : '')
        + (_visualizerCurrent === e.path ? ' is-playing' : '')
        + (_visualizerSelected.has(e.path) ? ' is-selected' : '');
      row.dataset.path  = e.path;
      row.dataset.rel   = e.rel;
      row.dataset.isDir = String(e.isDir);
      row.dataset.name  = e.name;
      if (e.isSeq) row.dataset.seqCount = String(e.seqCount);
      row.title = e.isSeq ? `${e.path}  (+ ${e.seqCount - 1} more frames)` : e.path;
      // Make video AND image rows draggable into the editor's
      // timeline. The custom mime carries the path + a `kind` token so
      // the drop target knows whether to set up a video or still-image
      // clip without re-checking the extension. Sequence rows also
      // carry the full member-path list so a single drop becomes N
      // back-to-back clips on the EDIT timeline.
      const isVidRow = !e.isDir && _VIDEO_RENDER_RE.test(e.name);
      const isImgRow = !e.isDir && _IMG_RENDER_RE.test(e.name);
      if (isVidRow || isImgRow) {
        row.draggable = true;
        row.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('application/x-dash3d-capture', e.path);
          ev.dataTransfer.setData('application/x-dash3d-kind', isImgRow ? 'image' : 'video');
          ev.dataTransfer.setData('text/plain', e.name);
          ev.dataTransfer.effectAllowed = 'copy';
          if (e.isSeq && Array.isArray(e.seqPaths)) {
            ev.dataTransfer.setData('application/x-edit-clip-seq', JSON.stringify(e.seqPaths));
          }
        });
      }
      const ext = extOf(e.name);
      const baseName = e.name.replace(/\.[^.]+$/, '');
      const safeName = baseName.replace(/</g, '&lt;');
      const seqBadge = e.isSeq ? `<span class="visualizer-row-seq">× ${e.seqCount}</span>` : '';
      const extBadge = (!e.isDir && ext) ? `<span class="visualizer-row-ext">${ext}</span>` : '';
      // Inline thumbnail. Sequence rows show the first frame, which is
      // exactly the snap-capture preview we want at a glance.
      const thumb = e.isDir
        ? `<div class="visualizer-row-thumb"><span class="visualizer-row-thumb-glyph">▣</span></div>`
        : isImgRow
          ? `<div class="visualizer-row-thumb"><img draggable="false" loading="lazy" alt="" src="dash3d-file://gallery/${encodeURI(e.rel)}"></div>`
          : `<div class="visualizer-row-thumb"><span class="visualizer-row-thumb-glyph">${isVidRow ? '▶' : '∙'}</span></div>`;
      row.innerHTML =
        thumb +
        `<div class="visualizer-row-namebox">` +
          `<span class="visualizer-row-name">${safeName}</span>` +
          seqBadge + extBadge +
        `</div>` +
        `<span class="visualizer-row-size">${e.isDir ? '—' : fmtBytes(e.size)}</span>` +
        `<span class="visualizer-row-time">${fmtFileTime(e.mtime)}</span>`;
      visualizerListEl.appendChild(row);
    }
  }

  // Folders the rec-room is allowed to surface at root. Both live under
  // the main gallery so they're also visible in the EXPLORE pane, but
  // the rec-room only ever shows these two and what's inside them —
  // user-imported gallery files stay invisible here.
  const RECROOM_ROOT_DIRS = ['videos', 'recordings', 'screencap'];
  async function refreshVisualizer() {
    if (!window.dash?.galleryList) return;
    try {
    let entries;
    if (!_visualizerSubdir) {
      // Synthesize the two managed folders at root. We don't show any
      // other top-level gallery content here — only the rec-room's own
      // captures. If a folder doesn't physically exist yet (no caps
      // recorded), inject an empty placeholder so the user can still
      // see it. Sizes / mtimes come from the real galleryList entry
      // when available so the row reads accurately.
      const result = await window.dash.galleryList('');
      const real = new Map();
      for (const e of (result?.entries || [])) {
        if (e.isDir && RECROOM_ROOT_DIRS.includes(e.name)) real.set(e.name, e);
      }
      entries = RECROOM_ROOT_DIRS.map((name) => real.get(name) || {
        name, path: '', rel: name, isDir: true, size: 0, mtime: 0,
      });
    } else {
      const result = await window.dash.galleryList(_visualizerSubdir);
      // Inside recordings/ or screencap/: show every video + image.
      entries = (result?.entries || []).filter((e) => e.isDir
        || _VIDEO_KNOWN_RE.test(e.name)
        || _IMG_KNOWN_RE.test(e.name));
    }
    _visualizerEntries = entries;
    renderVisualizerList(entries);
    const titleEl = visualizerPane?.querySelector('.visualizer-list-title');
    if (titleEl) titleEl.textContent = _crumbFromSubdir(_visualizerSubdir);
    } catch (err) {
      console.error('[visualizer] refreshVisualizer threw:', err);
      if (visualizerNowEl) visualizerNowEl.textContent = 'CAPTURES LIST ERROR · ' + (err?.message || err);
    }
  }

  function playVisualizerEntry(entry) {
    if (!visualizerVideoEl || !entry) return;
    if (!_VIDEO_RENDER_RE.test(entry.name)) {
      // Codec the browser can't decode — fall back to the OS default app.
      window.dash?.shellOpenPath?.(entry.path).catch(() => {});
      return;
    }
    // If the mirror is live, tear it down first — playing a recorded
    // file means switching the <video> element from MediaStream
    // (srcObject) back to a plain URL (src), which is messy if both
    // are set. _stopVisualizerMirror cascades into _stopScreenrec so
    // any in-progress recording is flushed cleanly first.
    if (_mirrorStream) {
      try { _stopVisualizerMirror(); } catch {}
    }
    // Auto-disable CROP when starting playback. CROP applies to the
    // live mirror; once a recorded file is on screen the user wants
    // the full frame, not a cropped subregion.
    try { _crop?.deactivate(); } catch {}
    // Switch out of still-image mode (in case the last click was a snap).
    const stillEl = document.getElementById('visualizer-still');
    if (stillEl) stillEl.src = '';
    visualizerWrapEl?.classList.remove('is-still');
    _visualizerCurrent = entry.path;
    const url = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
    // Setting src on a fresh video element naturally starts it
    // paused at currentTime=0 — no need to force pause() or
    // currentTime=0 here (forcing them before metadata had loaded
    // was leaving the element in a state where the subsequent
    // play() click from the toolbar would silently reject).
    visualizerVideoEl.src = url;
    // (Mirror's force-mute used to be reset here. Mirror now stays
    // muted independently of playback so the source-playback path
    // doesn't need to restore anything.)
    // `is-playing` here means "a video is loaded" (toggles the empty
    // overlay off) — keep adding it even though we're not actively
    // playing. CSS that depends on it stays correct.
    visualizerWrapEl?.classList.add('is-playing');
    if (visualizerNowEl) visualizerNowEl.textContent = entry.name;
    // Repaint list to highlight the now-playing row.
    renderVisualizerList(_visualizerEntries);
    _refreshDeleteBtn();
    if (typeof _refreshEditBtn === 'function') _refreshEditBtn();
  }

  // Show a still image (snap) in the player wrap. We stop any video
  // playback first so the audio doesn't keep going while staring at a
  // static frame, and never call openImageViewer — per the rec-room
  // rule that media plays in this pane and nowhere else.
  // Source dimensions — updated whenever a mirror starts, a recording's
  // metadata loads, or a still snap loads. Drives the wrap's aspect
  // (auto-fit always wins now — no manual portrait/landscape toggle).
  let _lastSourceW = 0;
  let _lastSourceH = 0;
  // Reduced-fraction aspect label (1920×1080 → "16:9"). Snaps to common
  // monitor ratios so 1366×768 (technically 683:384) reads as "16:9"
  // rather than a noisy fraction. Used by the MIRROR NOW string so the
  // user can confirm a 16:9 capture is actually 16:9 without DevTools.
  function _aspectLabel(w, h) {
    if (!w || !h) return '?';
    const r = w / h;
    const COMMON = [
      [32, 9], [21, 9], [16, 9], [16, 10], [3, 2], [4, 3], [5, 4], [1, 1],
      [9, 16], [10, 16], [2, 3], [3, 4], [4, 5], [9, 21],
    ];
    for (const [a, b] of COMMON) {
      if (Math.abs(r - a / b) / (a / b) < 0.01) return `${a}:${b}`;
    }
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    const g = gcd(w, h);
    return `${w / g}:${h / g}`;
  }
  function _refreshWrapShape() {
    if (!visualizerWrapEl) return;
    let w = 0, h = 0;
    if (_lastSourceW > 0 && _lastSourceH > 0) {
      w = _lastSourceW;
      h = _lastSourceH;
    }
    if (w > 0 && h > 0) {
      visualizerWrapEl.style.setProperty('--source-aspect', `${w} / ${h}`);
      // Cap the wrap to the source's native pixel size so the player
      // never upscales beyond what's actually in the file/stream. A
      // 1280x720 .mp4 will display at 1280x720 (or smaller if the pane
      // can't fit it), not stretched up to fill 1920x1080. CSS reads
      // these as `max-width: min(100%, var(...))` etc.
      visualizerWrapEl.style.setProperty('--source-max-width',  `${Math.round(w)}px`);
      visualizerWrapEl.style.setProperty('--source-max-height', `${Math.round(h)}px`);
      visualizerWrapEl.classList.add('is-source-aspect');
    } else {
      visualizerWrapEl.style.removeProperty('--source-aspect');
      visualizerWrapEl.style.removeProperty('--source-max-width');
      visualizerWrapEl.style.removeProperty('--source-max-height');
      visualizerWrapEl.classList.remove('is-source-aspect');
    }
  }
  function _setSourceDims(w, h) {
    _lastSourceW = w | 0;
    _lastSourceH = h | 0;
    _refreshWrapShape();
  }

  function showStillImage(entry) {
    if (!entry || !_IMG_KNOWN_RE.test(entry.name)) return;
    // Tear down the mirror so viewing a snap doesn't keep a live
    // MediaStream silently churning behind the still image.
    if (_mirrorStream) {
      try { _stopVisualizerMirror(); } catch {}
    }
    if (visualizerVideoEl) {
      try { visualizerVideoEl.pause(); } catch {}
      visualizerVideoEl.removeAttribute('src');
      try { visualizerVideoEl.load(); } catch {}
    }
    _visualizerCurrent = entry.path;
    const stillEl = document.getElementById('visualizer-still');
    if (stillEl) stillEl.src = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
    visualizerWrapEl?.classList.remove('is-playing');
    visualizerWrapEl?.classList.add('is-still');
    if (visualizerNowEl) visualizerNowEl.textContent = entry.name;
    renderVisualizerList(_visualizerEntries);
    _refreshDeleteBtn();
    if (typeof _refreshEditBtn === 'function') _refreshEditBtn();
  }

  // ── Transport + themed playback control bar ─────────────────────
  // Lives in ./rec/transport.js. Wires the big play/pause/prev/next
  // buttons, the scrubber, volume, fullscreen, and the rAF-coalesced
  // seek logic. Needs accessors into the gallery state so prev/next
  // can navigate the playable-video subset.
  setupTransport({
    playSfx,
    visualizerVideoEl,
    getPlayable:    () => _visualizerEntries.filter((e) => !e.isDir && _VIDEO_KNOWN_RE.test(e.name)),
    getCurrentPath: () => _visualizerCurrent,
    playEntry:      (entry) => playVisualizerEntry(entry),
  });

  // List of image entries from the current view, ordered as displayed
  // (folders + the up-row are skipped). Used for shift-click range
  // selection so the range only includes selectable items.
  function _repaintSelection() {
    if (!visualizerListEl) return;
    for (const row of visualizerListEl.querySelectorAll('.visualizer-row')) {
      row.classList.toggle('is-selected', _visualizerSelected.has(row.dataset.path));
    }
    _refreshDeleteBtn();
    if (typeof _refreshEditBtn === 'function') _refreshEditBtn();
  }
  function _refreshDeleteBtn() {
    const btn = document.getElementById('visualizer-delete-btn');
    if (!btn) return;
    const n = _visualizerSelected.size;
    btn.disabled = n === 0 && !_visualizerCurrent;
    btn.textContent = n >= 2 ? `DELETE (${n})` : 'DELETE';
  }
  function _clearVisualizerSelection() {
    _visualizerSelected.clear();
    _visualizerAnchor = null;
    _repaintSelection();
  }

  visualizerListEl?.addEventListener('click', (e) => {
    const row = e.target.closest('.visualizer-row');
    if (!row) return;
    // Up-row: pop the last segment off the subdir and refresh.
    if (row.dataset.action === 'up') {
      _clearVisualizerSelection();
      const parts = _visualizerSubdir.split('/').filter(Boolean);
      parts.pop();
      _visualizerSubdir = parts.join('/');
      refreshVisualizer();
      return;
    }
    const entry = _visualizerEntries.find((x) => x.path === row.dataset.path);
    if (!entry) return;
    // Canonical Windows selection rules — separated from activation:
    //   • shift            → replace selection with range from anchor
    //   • ctrl+shift       → add range from anchor to selection
    //   • ctrl (no shift)  → toggle this row in selection, anchor moves
    //   • plain click      → select only this row, anchor=this, ACTIVATE
    // If shift is pressed but the anchor is missing or no longer in the
    // current view, the click falls through to plain-click behaviour.
    const view = _visualizerEntries;
    const haveAnchor = _visualizerAnchor
      && view.some((x) => x.path === _visualizerAnchor);
    if (e.shiftKey && haveAnchor) {
      const ai = view.findIndex((x) => x.path === _visualizerAnchor);
      const bi = view.findIndex((x) => x.path === entry.path);
      const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
      const range = view.slice(lo, hi + 1).map((x) => x.path);
      if (e.ctrlKey || e.metaKey) {
        for (const p of range) _visualizerSelected.add(p);
      } else {
        _visualizerSelected = new Set(range);
      }
      // Anchor stays put so successive shift-clicks expand from the
      // original point (Explorer-style).
      _repaintSelection();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (_visualizerSelected.has(entry.path)) _visualizerSelected.delete(entry.path);
      else _visualizerSelected.add(entry.path);
      _visualizerAnchor = entry.path;
      _repaintSelection();
      return;
    }
    // Plain click (or shift with no usable anchor). Always select-only +
    // set anchor; the activation (preview / play / nothing) depends on
    // the row type.
    _visualizerSelected = new Set([entry.path]);
    _visualizerAnchor = entry.path;
    _repaintSelection();
    // Shift-with-no-anchor: act as plain selection, no activation —
    // matches Explorer when you shift-click without a prior selection.
    if (e.shiftKey) return;
    if (entry.isDir) {
      // Plain click on a folder just selects (Windows behaviour).
      // Double-click handler navigates into it.
      return;
    }
    if (_IMG_KNOWN_RE.test(entry.name)) {
      showStillImage(entry);
    } else {
      // Video — play in-place.
      playVisualizerEntry(entry);
    }
  });

  // ── Rec-room context menu + delete/undo ───────────────────────────
  // Lives in ./rec/context.js. Selection/current-playing state lives
  // here in visualizer.js (it's touched everywhere); the module gets
  // accessor functions so reassignments are visible across the closure.
  setupContextMenu({
    visualizerListEl, visualizerVideoEl, visualizerWrapEl,
    visualizerNowEl, visualizerPane,
    getSelected: () => _visualizerSelected,
    setSelected: (s) => { _visualizerSelected = s; },
    setAnchor:   (p) => { _visualizerAnchor = p; },
    getCurrent:  () => _visualizerCurrent,
    clearCurrent: () => { _visualizerCurrent = null; },
    repaintSelection: () => _repaintSelection(),
    clearSelection:   () => _clearVisualizerSelection(),
    refreshVisualizer: () => refreshVisualizer(),
  });
  // Double-click on a folder enters it. Single-click no longer navigates so
  // selecting / right-clicking folders doesn't dump the user into them.
  visualizerListEl?.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.visualizer-row');
    if (!row) return;
    if (row.dataset.action === 'up') return;
    if (row.dataset.isDir !== 'true') return;
    _clearVisualizerSelection();
    _visualizerSubdir = row.dataset.rel;
    refreshVisualizer();
  });
  document.getElementById('visualizer-refresh-btn')  ?.addEventListener('click', () => refreshVisualizer());

  // ── §rec-split ── DRAGGABLE SPLITTER ──────────────────────────────
  // Slim horizontal bar between the player/edit area and the captures
  // list. Drag it to give more vertical space to either side. The %
  // is stored in cfg.recSplitPct so it survives restarts.
  const recSplitEl = document.getElementById('visualizer-split');
  const _CLAMP = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  // Upper bound on the player-wrap height. When the bottom strip is
  // visible we cap at 85% so the mixer/sources/cameras row stays at
  // least a sliver visible; when collapsed we lift to 100% so the
  // player can be dragged all the way down with nothing underneath.
  function _isPortrait() { return !!visualizerPane?.classList.contains('is-portrait-source'); }
  function _splitMaxPct() {
    if (_isPortrait()) return visualizerPane?.classList.contains('is-bottom-collapsed') ? 100 : 80;
    return visualizerPane?.classList.contains('is-bottom-collapsed') ? 100 : 85;
  }
  function _splitVarName() { return _isPortrait() ? '--rec-portrait-pct' : '--rec-split-pct'; }
  function _splitCfgKey()  { return _isPortrait() ? 'recPortraitPct' : 'recSplitPct'; }
  function _splitDefault() { return _isPortrait() ? 35 : 60; }
  function _applyRecSplit(pct) {
    if (!visualizerPane) return;
    const v = _CLAMP(Number(pct) || _splitDefault(), 15, _splitMaxPct());
    visualizerPane.style.setProperty(_splitVarName(), `${v}%`);
  }
  (async () => {
    try {
      const cfg = (await window.dash?.getConfig?.()) || {};
      // Restore both axes from config so a user who toggles between
      // landscape and portrait gets the size they last set for each.
      const lp = Number.isFinite(cfg.recSplitPct)    ? cfg.recSplitPct    : 60;
      const pp = Number.isFinite(cfg.recPortraitPct) ? cfg.recPortraitPct : 35;
      visualizerPane?.style.setProperty('--rec-split-pct',    `${_CLAMP(lp, 15, 100)}%`);
      visualizerPane?.style.setProperty('--rec-portrait-pct', `${_CLAMP(pp, 15, 100)}%`);
    } catch {
      visualizerPane?.style.setProperty('--rec-split-pct',    '60%');
      visualizerPane?.style.setProperty('--rec-portrait-pct', '35%');
    }
  })();
  let _splitDragging = false;
  let _splitStart = 0;
  let _splitStartPct = 60;
  let _splitDragAxis = 'y'; // captured at pointerdown so a mid-drag
                            // orientation toggle can't confuse the math
  recSplitEl?.addEventListener('pointerdown', (e) => {
    if (!visualizerPane) return;
    _splitDragging = true;
    _splitDragAxis = _isPortrait() ? 'x' : 'y';
    _splitStart = _splitDragAxis === 'x' ? e.clientX : e.clientY;
    const curPctStr = getComputedStyle(visualizerPane).getPropertyValue(_splitVarName()).trim();
    _splitStartPct = parseFloat(curPctStr) || _splitDefault();
    recSplitEl.classList.add('is-dragging');
    recSplitEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  recSplitEl?.addEventListener('pointermove', (e) => {
    if (!_splitDragging || !visualizerPane) return;
    const paneRect = visualizerPane.getBoundingClientRect();
    if (_splitDragAxis === 'x') {
      if (paneRect.width <= 0) return;
      // Player sits on the RIGHT in portrait mode, so dragging the
      // splitter LEFT enlarges the player → invert the sign.
      const dx = e.clientX - _splitStart;
      const deltaPct = -(dx / paneRect.width) * 100;
      const next = _CLAMP(_splitStartPct + deltaPct, 15, _splitMaxPct());
      visualizerPane.style.setProperty('--rec-portrait-pct', `${next}%`);
    } else {
      if (paneRect.height <= 0) return;
      const dy = e.clientY - _splitStart;
      const deltaPct = (dy / paneRect.height) * 100;
      const next = _CLAMP(_splitStartPct + deltaPct, 20, _splitMaxPct());
      visualizerPane.style.setProperty('--rec-split-pct', `${next}%`);
    }
  });
  function _endSplitDrag() {
    if (!_splitDragging) return;
    _splitDragging = false;
    recSplitEl?.classList.remove('is-dragging');
    if (visualizerPane) {
      const varName = _splitDragAxis === 'x' ? '--rec-portrait-pct' : '--rec-split-pct';
      const cfgKey  = _splitDragAxis === 'x' ? 'recPortraitPct'    : 'recSplitPct';
      const curPctStr = getComputedStyle(visualizerPane).getPropertyValue(varName).trim();
      const v = parseFloat(curPctStr) || _splitDefault();
      window.dash?.setConfig?.({ [cfgKey]: v });
    }
  }
  recSplitEl?.addEventListener('pointerup',     _endSplitDrag);
  recSplitEl?.addEventListener('pointercancel', _endSplitDrag);

  // Bottom-strip collapse toggle. Hides the MIXER / CAMERAS / FILTERS
  // row so the player wrap can use the full pane height. The topbar
  // REC indicator (managed independently in _startScreenrec /
  // _stopScreenrec) stays visible whenever a recording is running, so
  // the user never loses the "still capturing" signal while collapsed.
  const bottomCollapseBtn = document.getElementById('visualizer-bottom-collapse');
  function _setBottomCollapsed(collapsed) {
    if (!visualizerPane) return;
    visualizerPane.classList.toggle('is-bottom-collapsed', !!collapsed);
    bottomCollapseBtn?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
  (async () => {
    try {
      const cfg = (await window.dash?.getConfig?.()) || {};
      if (cfg.recRoomBottomCollapsed) _setBottomCollapsed(true);
    } catch {}
  })();
  bottomCollapseBtn?.addEventListener('click', async () => {
    const next = !visualizerPane?.classList.contains('is-bottom-collapsed');
    _setBottomCollapsed(next);
    try { await window.dash?.setConfig?.({ recRoomBottomCollapsed: next }); } catch {}
    playSfx?.('click');
  });

  // ── §rec-edit ── EDIT MODE (trim + filters) ────────────────────
  // Opens a split-pane editor on the currently-playing video. The
  // ORIGINAL side plays straight; the EDITED side has a live CSS
  // `filter:` chain driven by sliders. EXPORT pipes the same params
  // (plus trim in/out) to ffmpeg in main, producing a new file in
  // gallery/recordings/ next to the source.
  const editBtn       = document.getElementById('visualizer-edit-btn');
  const editPane      = document.getElementById('visualizer-edit-pane');
  const editOrigVid   = document.getElementById('vis-edit-orig');
  const editOutVid    = document.getElementById('vis-edit-out');
  const editNameEl    = document.getElementById('vis-edit-name');
  const editTimelineEl= document.getElementById('vis-edit-timeline');
  const editTrimRangeEl= document.getElementById('vis-edit-trim-range');
  const editTrimInEl  = document.getElementById('vis-edit-trim-in');
  const editTrimOutEl = document.getElementById('vis-edit-trim-out');
  const editPlayheadEl= document.getElementById('vis-edit-playhead');
  const editTimeEl    = document.getElementById('vis-edit-time');
  const editTrimTimesEl = document.getElementById('vis-edit-trim-times');
  const editPlayBtn   = document.getElementById('vis-edit-play');
  const editResetBtn  = document.getElementById('vis-edit-reset');
  const editExportBtn = document.getElementById('vis-edit-export');
  const editCloseBtn  = document.getElementById('vis-edit-close');
  const editAutoBtn   = document.getElementById('vis-edit-auto');
  const editDenoiseBtn= document.getElementById('vis-edit-denoise');
  const editStatusEl  = document.getElementById('vis-edit-status');

  // Editor state. trimIn/Out in seconds; duration cached once metadata
  // loads. All filter values default to identity (no-op CSS string).
  // sliders[*]:
  //   brightness/contrast/saturation/hue/blur — CSS filter() chain
  //   sharpen  — 0..200, unsharp-mask amount on export
  //   vignette — 0..100, edge darkening strength
  //   speed    — 25..400, playback rate as %
  //   volume   — 0..200, audio gain as %
  // crop is normalized [0..1] x [0..1]; rotate is degrees (0/90/180/270).
  const _editState = {
    open: false,
    src: '',           // absolute file path of the source/anchor video
    // Optional appended clips. First entry mirrors `src` and is treated
    // as the anchor — trim handles on the timeline apply to it. The
    // rest play in full after the anchor. Each: { path, name, duration }.
    clips: [],
    duration: 0,
    trimIn: 0,
    trimOut: 0,
    auto: false,
    denoise: false,
    bw: false,
    sepia: false,
    invert: false,
    reverse: false,
    mute: false,
    flipH: false,
    flipV: false,
    rotate: 0,
    cropOn: false,
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    sliders: {
      brightness: 100, contrast: 100, saturation: 100, hue: 0, blur: 0,
      sharpen: 0, vignette: 0, speed: 100, volume: 100,
    },
  };
  function _editIsIdentity(s, flags) {
    return s.brightness === 100 && s.contrast === 100 && s.saturation === 100
      && s.hue === 0 && s.blur === 0 && !flags.auto && !flags.denoise;
  }
  function _editCssFilter(state) {
    const s = state.sliders;
    const parts = [];
    let brightness = s.brightness, contrast = s.contrast, saturation = s.saturation;
    if (state.auto) { contrast = Math.min(200, contrast + 15); saturation = Math.min(200, saturation + 10); }
    if (brightness !== 100) parts.push(`brightness(${brightness}%)`);
    if (contrast   !== 100) parts.push(`contrast(${contrast}%)`);
    if (saturation !== 100) parts.push(`saturate(${saturation}%)`);
    if (s.hue !== 0)        parts.push(`hue-rotate(${s.hue}deg)`);
    if (s.blur > 0)         parts.push(`blur(${s.blur}px)`);
    // Sharpen has no native CSS filter. The "sharper" look comes from a
    // contrast nudge in preview; the real unsharp-mask runs in ffmpeg.
    if (s.sharpen > 0) parts.push(`contrast(${100 + s.sharpen * 0.1}%)`);
    // Black-and-white / sepia / invert as single-shot toggles.
    if (state.bw)      parts.push('grayscale(100%)');
    if (state.sepia)   parts.push('sepia(100%)');
    if (state.invert)  parts.push('invert(100%)');
    // CSS approximation of denoise: light blur so the user sees that
    // SOMETHING happens live. True denoising runs in ffmpeg on export.
    if (state.denoise) parts.push('blur(0.3px) contrast(102%)');
    return parts.join(' ') || 'none';
  }
  // Pan/zoom view state — applied to BOTH the original and edited
  // videos in sync so they show the same region. translate is in pixels
  // relative to the side container; scale is a multiplier. The rotate
  // + flip from _editState is composed on top of pan/zoom on the
  // EDITED side only.
  const _editView = { scale: 1, tx: 0, ty: 0 };
  function _editCssTransform(state, withRotate) {
    const parts = [];
    if (_editView.tx || _editView.ty) parts.push(`translate(${_editView.tx}px, ${_editView.ty}px)`);
    if (_editView.scale !== 1)        parts.push(`scale(${_editView.scale})`);
    if (withRotate) {
      if (state.rotate) parts.push(`rotate(${state.rotate}deg)`);
      if (state.flipH)  parts.push('scaleX(-1)');
      if (state.flipV)  parts.push('scaleY(-1)');
    }
    return parts.join(' ') || 'none';
  }
  function _applyEditPreview() {
    if (!editOutVid) return;
    editOutVid.style.filter = _editCssFilter(_editState);
    editOutVid.style.transform = _editCssTransform(_editState, true);
    // Mirror pan/zoom (without rotate/flip) on the ORIGINAL side so
    // both windows show the same region.
    if (editOrigVid) editOrigVid.style.transform = _editCssTransform(_editState, false);
    // Mirror the playback rate so the EDITED side previews the speed.
    const rate = Math.max(0.25, Math.min(4, (_editState.sliders.speed || 100) / 100));
    if (editOrigVid && Math.abs(editOrigVid.playbackRate - rate) > 0.005) {
      try { editOrigVid.playbackRate = rate; editOutVid.playbackRate = rate; } catch {}
    }
    // Toggle the crop overlay visibility based on cropOn.
    const cropEl = document.getElementById('vis-edit-crop');
    if (cropEl) cropEl.hidden = !_editState.cropOn;
  }
  function _resetEditView() {
    _editView.scale = 1;
    _editView.tx = 0;
    _editView.ty = 0;
    _applyEditPreview();
  }
  function _fmtTime(t) {
    if (!Number.isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  // ── §rec-edit-timeline ── DaVinci-style multi-track timeline ────
  // Project state — separate from the single-clip _editState because
  // it's a distinct mental model (a real NLE timeline). Each track
  // has a list of clips; each clip has its own in/out (trim) and a
  // start time on the global timeline.
  const _editProject = {
    fps: 30,
    width: 1920,
    height: 1080,
    pxPerSec: 50,
    duration: 30,    // bumped as clips are added/moved
    tracks: {
      V2: [],
      V1: [],
      A1: [],
    },
    selectedClipId: null,
  };
  let _editClipSeq = 0;

  // Cap the timeline length at 24h so a bogus duration (Chromium
  // returns Infinity for some webm clips that have no duration
  // metadata in the header) can't blow up the ruler render loop.
  const _EDIT_MAX_DURATION = 24 * 60 * 60;
  function _safeDur(v, fallback) {
    if (!Number.isFinite(v) || v < 0) return fallback;
    return Math.min(v, _EDIT_MAX_DURATION);
  }
  function _editTotalDuration() {
    let max = 30;
    for (const tid of ['V2', 'V1', 'A1']) {
      for (const c of _editProject.tracks[tid]) {
        const start = _safeDur(c.start, 0);
        const trim  = _safeDur((c.out || 0) - (c.in || 0), 0);
        const end = start + trim;
        if (end > max) max = end;
      }
    }
    return Math.ceil(Math.min(max + 5, _EDIT_MAX_DURATION));
  }

  function _editFmtTC(t) {
    if (!Number.isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Render the time ruler. Tick every second; major tick every 5 s
  // with a numeric label. Density adapts to pxPerSec so the ruler
  // doesn't crowd at low zoom.
  function _renderEditRuler() {
    const ruler = document.getElementById('vis-edit-tl-ruler');
    if (!ruler) return;
    // Hard-clamp every input to finite, sane numbers so a bogus duration
    // can't generate an infinite loop here.
    const dur = _safeDur(_editProject.duration, 30);
    const pps = Math.max(1, Math.min(2000, _editProject.pxPerSec || 50));
    const w = Math.max(1, Math.min(1_000_000, Math.round(dur * pps)));
    ruler.innerHTML = '';
    // Choose tick interval based on zoom — keep labels at least 60px apart.
    const minLabelPx = 60;
    let tickSec = 1;
    while (tickSec * pps < minLabelPx / 5 && tickSec < dur) tickSec *= 2;
    let labelSec = tickSec * 5;
    while (labelSec * pps < minLabelPx && labelSec < dur) labelSec *= 2;
    // Cap the number of ticks generated as a final safety net (e.g. user
    // sets fps=24 + zooms way out + duration is 12h — still bounded).
    const MAX_TICKS = 4000;
    let ticksDrawn = 0;
    for (let t = 0; t <= dur && ticksDrawn < MAX_TICKS; t += tickSec) {
      const x = Math.round(t * pps);
      const isMajor = (Math.round(t / labelSec) * labelSec === Math.round(t));
      const tick = document.createElement('div');
      tick.className = 'vis-edit-tl-ruler-tick' + (isMajor ? ' is-major' : '');
      tick.style.left = `${x}px`;
      ruler.appendChild(tick);
      if (isMajor) {
        const lbl = document.createElement('span');
        lbl.className = 'vis-edit-tl-ruler-label';
        lbl.style.left = `${x}px`;
        lbl.textContent = _editFmtTC(t);
        ruler.appendChild(lbl);
      }
      ticksDrawn++;
    }
    const content = document.getElementById('vis-edit-tl-content');
    if (content) content.style.width = `${w}px`;
  }

  function _editTrackEl(trackId) {
    return document.getElementById(`vis-edit-tl-track-${trackId}`);
  }

  function _renderEditTracks() {
    const pps = _editProject.pxPerSec;
    for (const tid of ['V2', 'V1', 'A1']) {
      const trackEl = _editTrackEl(tid);
      if (!trackEl) continue;
      trackEl.innerHTML = '';
      for (const clip of _editProject.tracks[tid]) {
        const el = document.createElement('div');
        el.className = 'vis-edit-tl-clip';
        if (clip.id === _editProject.selectedClipId) el.classList.add('is-selected');
        el.dataset.clipId = clip.id;
        const dur = Math.max(0.05, clip.out - clip.in);
        el.style.left  = `${Math.round(clip.start * pps)}px`;
        el.style.width = `${Math.max(20, Math.round(dur * pps))}px`;
        // Resize handles on the LEFT and RIGHT edges. Dragging stretches
        // the clip along the time axis. For images the duration grows
        // freely; for videos out is capped at srcDuration so we can't
        // extend past the source's length.
        el.innerHTML =
          `<span class="vis-edit-tl-clip-resize is-left"  data-resize="left"></span>` +
          `<span class="vis-edit-tl-clip-name">${clip.name}</span>` +
          `<button class="vis-edit-tl-clip-remove" title="Remove clip">×</button>` +
          `<span class="vis-edit-tl-clip-resize is-right" data-resize="right"></span>`;
        _wireClipDrag(el, clip, tid);
        _wireClipResize(el, clip, tid);
        el.querySelector('.vis-edit-tl-clip-remove')?.addEventListener('mousedown', (e) => e.stopPropagation());
        el.querySelector('.vis-edit-tl-clip-remove')?.addEventListener('click', (e) => {
          e.stopPropagation();
          _removeEditClip(clip.id);
        });
        trackEl.appendChild(el);
      }
    }
    _refreshEditPlayhead();
  }

  function _refreshEditPlayhead() {
    const ph = document.getElementById('vis-edit-tl-playhead');
    if (!ph) return;
    const t = _safeDur(editOrigVid?.currentTime, 0);
    const pps = Math.max(1, Math.min(2000, _editProject.pxPerSec || 50));
    ph.style.left = `${Math.round(t * pps)}px`;
    _renderEditOverlays();
  }

  // Render every V2 clip that's "live" at the current playhead time
  // as an absolutely-positioned overlay over the EDITED video. The
  // selected clip (if it's on V2) gets a dashed border + 8 resize
  // handles. Only image overlays for now — video-on-video compositing
  // is a follow-up.
  function _renderEditOverlays() {
    const layer = document.getElementById('vis-edit-overlays');
    if (!layer) return;
    const t = _safeDur(editOrigVid?.currentTime, 0);
    // Diff against the existing children so we don't thrash the DOM
    // on every timeupdate. We rebuild only if the active-clip set
    // changes or a clip's position is dirty.
    const active = _editProject.tracks.V2.filter((c) => {
      const dur = Math.max(0.05, (c.out || c.srcDuration || 3) - (c.in || 0));
      return c.kind === 'image' && t >= c.start && t < c.start + dur;
    });
    const sigOf = (arr) => arr.map((c) => `${c.id}:${c.x.toFixed(4)},${c.y.toFixed(4)},${c.w.toFixed(4)},${c.h.toFixed(4)}:${c.id === _editProject.selectedClipId}`).join('|');
    const sig = sigOf(active);
    if (layer.dataset.sig === sig) return;
    layer.dataset.sig = sig;
    layer.innerHTML = '';
    for (const clip of active) {
      const el = document.createElement('div');
      el.className = 'vis-edit-overlay' + (clip.id === _editProject.selectedClipId ? ' is-selected' : '');
      el.dataset.clipId = clip.id;
      el.style.left   = `${(clip.x * 100).toFixed(3)}%`;
      el.style.top    = `${(clip.y * 100).toFixed(3)}%`;
      el.style.width  = `${(clip.w * 100).toFixed(3)}%`;
      el.style.height = `${(clip.h * 100).toFixed(3)}%`;
      const img = document.createElement('img');
      const rel = (_visualizerEntries.find((e) => e.path === clip.path)?.rel) || '';
      img.src = `dash3d-file://gallery/${encodeURI(rel)}`;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
      if (clip.id === _editProject.selectedClipId) {
        for (const side of ['nw','n','ne','e','se','s','sw','w']) {
          const h = document.createElement('span');
          h.className = `vis-edit-overlay-handle is-h-${side}`;
          h.dataset.handle = side;
          el.appendChild(h);
        }
      }
      _wireOverlayDrag(el, clip);
      layer.appendChild(el);
    }
  }

  function _wireOverlayDrag(el, clip) {
    const layer = document.getElementById('vis-edit-overlays');
    if (!layer) return;
    let drag = null;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Select this clip so handles appear (and the timeline reflects).
      _editProject.selectedClipId = clip.id;
      _renderEditTracks();
      const handle = e.target.closest?.('.vis-edit-overlay-handle');
      const r = layer.getBoundingClientRect();
      drag = {
        mode: handle ? 'resize' : 'move',
        side: handle?.dataset.handle || null,
        startX: e.clientX,
        startY: e.clientY,
        layerW: r.width,
        layerH: r.height,
        orig: { x: clip.x, y: clip.y, w: clip.w, h: clip.h },
      };
      e.preventDefault();
      e.stopPropagation();
    });
    function onMove(e) {
      if (!drag) return;
      const dxFrac = (e.clientX - drag.startX) / Math.max(1, drag.layerW);
      const dyFrac = (e.clientY - drag.startY) / Math.max(1, drag.layerH);
      const o = drag.orig;
      if (drag.mode === 'move') {
        clip.x = Math.max(0, Math.min(1 - o.w, o.x + dxFrac));
        clip.y = Math.max(0, Math.min(1 - o.h, o.y + dyFrac));
      } else {
        const s = drag.side;
        // East / South: adjust w/h directly.
        if (s.includes('e')) clip.w = Math.max(0.03, Math.min(1 - o.x, o.w + dxFrac));
        if (s.includes('s')) clip.h = Math.max(0.03, Math.min(1 - o.y, o.h + dyFrac));
        // West / North: adjust x/y and inverse w/h so the opposite edge
        // stays pinned.
        if (s.includes('w')) {
          const right = o.x + o.w;
          const nx = Math.max(0, Math.min(right - 0.03, o.x + dxFrac));
          clip.x = nx; clip.w = right - nx;
        }
        if (s.includes('n')) {
          const bottom = o.y + o.h;
          const ny = Math.max(0, Math.min(bottom - 0.03, o.y + dyFrac));
          clip.y = ny; clip.h = bottom - ny;
        }
      }
      _renderEditOverlays();
    }
    function onUp() {
      drag = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    }
    el.addEventListener('mousedown', () => {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',   onUp);
    });
  }

  function _addEditClip(trackId, capture, startSec) {
    const kind = capture.kind || (_IMG_RENDER_RE.test(capture.name) ? 'image' : 'video');
    // Images have no inherent duration — give them a sensible default
    // (3s) that the user can later resize. Video duration comes from
    // its metadata probe.
    const dur = Number.isFinite(capture.duration) && capture.duration > 0
      ? capture.duration
      : (kind === 'image' ? 3 : 5);
    const clip = {
      id: ++_editClipSeq,
      path: capture.path,
      name: capture.name,
      kind,
      srcDuration: dur,
      in: 0,
      out: dur,
      start: Math.max(0, startSec),
      track: trackId,
      // Transform (position + size) for overlay clips on V2. Fractions
      // of the EDITED preview canvas. V1 anchors ignore these (they
      // cover the canvas). Default: centered at 50% size.
      x: 0.25, y: 0.25, w: 0.5, h: 0.5,
    };
    _editProject.tracks[trackId].push(clip);
    _editProject.duration = _editTotalDuration();
    _renderEditRuler();
    _renderEditTracks();
    // If V1 is empty no longer, retarget preview to this clip.
    if (trackId === 'V1' && _editProject.tracks.V1.length === 1) {
      _retargetEditorAnchor(clip);
    }
    // Newly-added V2 overlays should appear immediately if their time
    // range covers the current playhead. Auto-select the new clip so
    // the handles are visible right away.
    if (trackId === 'V2' && clip.kind === 'image') {
      _editProject.selectedClipId = clip.id;
      _renderEditOverlays();
    }
  }

  function _removeEditClip(clipId) {
    for (const tid of ['V2', 'V1', 'A1']) {
      const idx = _editProject.tracks[tid].findIndex((c) => c.id === clipId);
      if (idx !== -1) {
        const wasFirstV1 = (tid === 'V1' && idx === 0);
        _editProject.tracks[tid].splice(idx, 1);
        if (_editProject.selectedClipId === clipId) _editProject.selectedClipId = null;
        _editProject.duration = _editTotalDuration();
        _renderEditRuler();
        _renderEditTracks();
        _renderEditOverlays();
        if (wasFirstV1) {
          const next = _editProject.tracks.V1[0];
          if (next) _retargetEditorAnchor(next);
        }
        return;
      }
    }
  }

  // Reposition a clip by dragging. Clip can move left/right along
  // time, and up/down between tracks of the same kind (V2↔V1 for
  // video, A1 only for audio).
  //
  // Hot path optimization: during drag we DO NOT re-render the
  // whole track DOM on every mousemove (used to call
  // _renderEditTracks() per move — that's ~3 destroyAll + N create
  // for every pointer event, blowing GC and the compositor when the
  // user has any sizable clip list). Instead we mutate the live
  // element's `style.left` directly, and only re-render at mouseup
  // (which also handles track changes properly). Project-duration
  // recalc is deferred to mouseup too.
  // Resize a timeline clip from either edge. Dragging the RIGHT edge
  // extends/shrinks the out point (and srcDuration for images, which
  // have no inherent length). Dragging the LEFT edge moves the start
  // and in point together so the right edge stays where it is.
  function _wireClipResize(el, clip, trackId) {
    const leftH  = el.querySelector('.vis-edit-tl-clip-resize.is-left');
    const rightH = el.querySelector('.vis-edit-tl-clip-resize.is-right');
    function wireEdge(handle, side) {
      if (!handle) return;
      let drag = null;
      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        _editProject.selectedClipId = clip.id;
        drag = {
          startX: e.clientX,
          origStart: clip.start,
          origIn:    clip.in,
          origOut:   clip.out,
          origSrc:   clip.srcDuration,
        };
        el.classList.add('is-dragging');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);
        e.preventDefault();
        e.stopPropagation();   // don't fire the body-drag handler
      });
      function onMove(e) {
        if (!drag) return;
        const pps = Math.max(1, _editProject.pxPerSec || 50);
        const dt = (e.clientX - drag.startX) / pps;
        if (side === 'right') {
          // Drag right edge — change out (and srcDuration for images).
          let newOut = Math.max(drag.origIn + 0.1, drag.origOut + dt);
          if (clip.kind === 'video') {
            // Videos can't go past their natural source length.
            const cap = Number.isFinite(drag.origSrc) && drag.origSrc > 0
              ? drag.origSrc : newOut;
            newOut = Math.min(newOut, cap);
          } else {
            // Images: stretch srcDuration freely. Cap at 24h so we
            // can never feed Infinity through the ruler math.
            newOut = Math.min(newOut, 24 * 60 * 60);
            clip.srcDuration = newOut - drag.origIn;
          }
          clip.out = newOut;
          el.style.width = `${Math.max(20, Math.round((clip.out - clip.in) * pps))}px`;
        } else {
          // Drag left edge — start + in shift by dt; right edge stays
          // anchored (so the visible content's right border doesn't
          // move). For images, in stays 0; we just adjust start and
          // srcDuration symmetrically.
          if (clip.kind === 'image') {
            let newStart = Math.max(0, drag.origStart + dt);
            // Don't let the clip shrink to nothing — keep at least 0.1s.
            const minLen = 0.1;
            const rightEdge = drag.origStart + (drag.origOut - drag.origIn);
            if (newStart > rightEdge - minLen) newStart = rightEdge - minLen;
            clip.start = newStart;
            clip.srcDuration = Math.max(minLen, rightEdge - newStart);
            clip.in  = 0;
            clip.out = clip.srcDuration;
          } else {
            let newIn = Math.max(0, drag.origIn + dt);
            const minLen = 0.1;
            if (newIn > drag.origOut - minLen) newIn = drag.origOut - minLen;
            clip.in    = newIn;
            clip.start = drag.origStart + (newIn - drag.origIn);
          }
          el.style.left  = `${Math.round(clip.start * pps)}px`;
          el.style.width = `${Math.max(20, Math.round((clip.out - clip.in) * pps))}px`;
        }
      }
      function onUp() {
        if (!drag) return;
        drag = null;
        el.classList.remove('is-dragging');
        _editProject.duration = _editTotalDuration();
        _renderEditRuler();
        _renderEditTracks();
        _renderEditOverlays();
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup',   onUp);
      }
    }
    wireEdge(leftH,  'left');
    wireEdge(rightH, 'right');
  }

  function _wireClipDrag(el, clip, trackId) {
    let drag = null;
    function onDown(e) {
      if (e.button !== 0) return;
      _editProject.selectedClipId = clip.id;
      // Re-render overlays so the selected V2 clip's handles appear.
      _renderEditOverlays();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        origStart: clip.start,
        origTrack: trackId,
        movedTrack: false,
      };
      el.classList.add('is-dragging');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',   onUp);
      e.preventDefault();
      e.stopPropagation();
    }
    function onMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const newStart = Math.max(0, drag.origStart + dx / _editProject.pxPerSec);
      clip.start = newStart;
      // Cheap live update — just slide the element. No DOM rebuild.
      el.style.left = `${Math.round(newStart * _editProject.pxPerSec)}px`;
      // Vertical movement between video tracks. Triggers a one-time
      // full re-render so the clip ends up in the right track's DOM,
      // but only on the threshold cross — not every move.
      const dy = e.clientY - drag.startY;
      const kind = (drag.origTrack === 'A1') ? 'audio' : 'video';
      if (Math.abs(dy) > 22 && kind === 'video') {
        const nextTrack = (dy < 0) ? 'V2' : 'V1';
        if (nextTrack !== clip.track) {
          const from = _editProject.tracks[clip.track];
          const idx = from.findIndex((c) => c.id === clip.id);
          if (idx !== -1) from.splice(idx, 1);
          _editProject.tracks[nextTrack].push(clip);
          clip.track = nextTrack;
          drag.origTrack = nextTrack;
          drag.startY = e.clientY;
          drag.movedTrack = true;
          _renderEditTracks(); // unavoidable for track changes
        }
      }
    }
    function onUp() {
      if (!drag) return;
      drag = null;
      el.classList.remove('is-dragging');
      _editProject.duration = _editTotalDuration();
      // Final reconcile (ruler width, sort order, etc.) once.
      _renderEditRuler();
      _renderEditTracks();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    }
    el.addEventListener('mousedown', onDown);
  }

  // Re-point the preview at the first V1 clip (or the supplied clip).
  // For a video clip, both <video> elements get its src. For an image
  // clip, the <video>s are hidden and the <img>s show the still — pan
  // / zoom / filters still apply because both elements share the same
  // .vis-edit-video / .vis-edit-still CSS rule chain.
  function _retargetEditorAnchor(clipOverride) {
    const anchor = clipOverride || _editProject.tracks.V1[0];
    if (!anchor) return;
    _editState.src = anchor.path;
    const rel = (_visualizerEntries.find((e) => e.path === anchor.path)?.rel) || '';
    const url = `dash3d-file://gallery/${encodeURI(rel)}`;
    const origImg = document.getElementById('vis-edit-orig-img');
    const outImg  = document.getElementById('vis-edit-out-img');
    if (anchor.kind === 'image') {
      // Hide video elements, show image stills.
      if (editOrigVid) { try { editOrigVid.pause(); } catch {} editOrigVid.hidden = true; editOrigVid.removeAttribute('src'); try { editOrigVid.load(); } catch {} }
      if (editOutVid)  { try { editOutVid.pause();  } catch {} editOutVid.hidden = true;  editOutVid.removeAttribute('src');  try { editOutVid.load();  } catch {} }
      if (origImg) { origImg.src = url; origImg.hidden = false; }
      if (outImg)  { outImg.src  = url; outImg.hidden  = false; }
      // For images, the editor's playback model is "static" — set
      // duration to the clip's chosen length and stop the playhead.
      _editState.duration = anchor.srcDuration || 3;
      _editState.trimIn   = 0;
      _editState.trimOut  = _editState.duration;
      _refreshEditTimeUi();
    } else {
      if (origImg) { origImg.hidden = true; origImg.removeAttribute('src'); }
      if (outImg)  { outImg.hidden  = true; outImg.removeAttribute('src');  }
      if (editOrigVid) { editOrigVid.hidden = false; editOrigVid.src = url; try { editOrigVid.load(); } catch {} }
      if (editOutVid)  { editOutVid.hidden  = false; editOutVid.src  = url; try { editOutVid.load();  } catch {} }
      // Keep the preview paused on the first frame — re-selecting a
      // clip shouldn't auto-start playback.
      try { editOrigVid?.pause(); editOutVid?.pause(); } catch {}
      try { if (editOrigVid) editOrigVid.currentTime = 0; if (editOutVid) editOutVid.currentTime = 0; } catch {}
    }
    if (editNameEl)  editNameEl.textContent = anchor.name;
  }

  // Compatibility shim — old code still calls _renderEditClips at
  // various points. Route it to the new timeline render.
  function _renderEditClips() { _renderEditTracks(); _renderEditRuler(); }

  function _refreshEditTimeUi() {
    if (!editOrigVid) return;
    const cur = editOrigVid.currentTime || 0;
    const dur = _editState.duration || 0;
    if (editTimeEl) editTimeEl.textContent = `${_fmtTime(cur)} / ${_fmtTime(dur)}`;
    if (editTrimTimesEl) {
      editTrimTimesEl.textContent = `TRIM ${_fmtTime(_editState.trimIn)} → ${_fmtTime(_editState.trimOut)}`;
    }
    if (editPlayheadEl && dur > 0) {
      const pct = Math.max(0, Math.min(1, cur / dur)) * 100;
      editPlayheadEl.style.left = `${pct}%`;
    }
    if (editTrimInEl && dur > 0)  editTrimInEl.style.left  = `${(_editState.trimIn  / dur) * 100}%`;
    if (editTrimOutEl && dur > 0) editTrimOutEl.style.left = `${(_editState.trimOut / dur) * 100}%`;
    if (editTrimRangeEl && dur > 0) {
      const a = (_editState.trimIn  / dur) * 100;
      const b = (_editState.trimOut / dur) * 100;
      editTrimRangeEl.style.left  = `${a}%`;
      editTrimRangeEl.style.width = `${Math.max(0, b - a)}%`;
    }
  }
  function _refreshEditBtn() {
    // The button hands the currently-playing video off to EDIT ROOM
    // (features/edit.js) via window._editHandoff + a combo-mode switch.
    // Enabled whenever a playable video is loaded in the REC ROOM player.
    if (!editBtn) return;
    const hasVideo = _visualizerCurrent && _VIDEO_RENDER_RE.test(_visualizerCurrent);
    editBtn.hidden = false;
    editBtn.disabled = !hasVideo;
  }
  function _closeEditor() {
    _editState.open = false;
    document.body.classList.remove('is-editing');
    if (editPane) editPane.hidden = true;
    if (visualizerWrapEl) visualizerWrapEl.style.display = '';
    // Tear down the video decoders fully — pause alone leaves Chromium's
    // video decoder allocated and the source buffered. Clearing src +
    // calling load() releases the decoder + GPU textures.
    try {
      if (editOrigVid) { editOrigVid.pause(); editOrigVid.removeAttribute('src'); editOrigVid.load(); }
      if (editOutVid)  { editOutVid.pause();  editOutVid.removeAttribute('src');  editOutVid.load();  }
    } catch {}
  }
  // Keep the two videos in lockstep — when ORIGINAL drives play/seek,
  // EDITED follows. We don't use editOutVid.captureStream because
  // recordings often use codecs (mkv/h264) that don't play in muted
  // captureStream cleanly; same-file double-load is simpler and works.
  editOrigVid?.addEventListener('loadedmetadata', () => {
    // Some .webm files report duration = Infinity until the user
    // seeks past the end (Chromium quirk for clips missing duration
    // metadata in the header). Coerce to a safe finite value so the
    // ruler / trim handles / total-duration math don't blow up.
    const rawDur = editOrigVid.duration;
    _editState.duration = (Number.isFinite(rawDur) && rawDur > 0) ? rawDur : 30;
    _editState.trimIn   = 0;
    _editState.trimOut  = _editState.duration;
    // Belt-and-suspenders: pause again here. Chromium occasionally
    // resumes playback once metadata arrives if the element was
    // previously playing under a different src — explicitly stop
    // that so opening the editor never starts audio on its own.
    try { editOrigVid.pause(); editOutVid?.pause(); } catch {}
    // Push the video's natural aspect into a CSS variable so the
    // side containers shrink-to-fit instead of letterboxing.
    const w = editOrigVid.videoWidth;
    const h = editOrigVid.videoHeight;
    if (w > 0 && h > 0 && editPane) {
      editPane.style.setProperty('--vid-aspect', `${w} / ${h}`);
    }
    // Record the anchor clip's duration into the timeline so its
    // bar is sized correctly. Recompute project duration + redraw.
    const anchor = _editProject.tracks.V1[0];
    if (anchor) {
      anchor.srcDuration = _editState.duration || 5;
      anchor.in  = 0;
      anchor.out = anchor.srcDuration;
    }
    _editProject.duration = _editTotalDuration();
    _renderEditRuler();
    _renderEditTracks();
    _refreshEditTimeUi();
  });
  editOrigVid?.addEventListener('timeupdate', () => {
    if (editOutVid && Math.abs((editOutVid.currentTime || 0) - editOrigVid.currentTime) > 0.15) {
      try { editOutVid.currentTime = editOrigVid.currentTime; } catch {}
    }
    _refreshEditTimeUi();
    if (typeof _refreshEditPlayhead === 'function') _refreshEditPlayhead();
    // Honour trim while playing: bounce back to trimIn if we overshot.
    if (!editOrigVid.paused && editOrigVid.currentTime >= _editState.trimOut) {
      try { editOrigVid.currentTime = _editState.trimIn; } catch {}
    }
  });
  editOrigVid?.addEventListener('play',  () => editOutVid?.play().catch(() => {}));
  editOrigVid?.addEventListener('pause', () => editOutVid?.pause());
  editOrigVid?.addEventListener('seeked',() => {
    if (editOutVid) try { editOutVid.currentTime = editOrigVid.currentTime; } catch {}
  });
  // ── Pan + zoom on the previews ───────────────────────────────────
  // Mouse-wheel zooms (anchored on the cursor); plain drag pans. Both
  // sides receive the same transform so they show the same region.
  // Double-click resets the view. Crop drag-rect still wins on the
  // EDITED side when CROP is on (it grabs mousedown first).
  function _wirePanZoom(el) {
    if (!el) return;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Cursor position in element-relative pixels.
      const cx = e.clientX - r.left - r.width  / 2;
      const cy = e.clientY - r.top  - r.height / 2;
      const oldS = _editView.scale;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newS = Math.max(1, Math.min(8, oldS * factor));
      // Shift translate so the point under the cursor stays put.
      const ratio = newS / oldS;
      _editView.tx = cx - (cx - _editView.tx) * ratio;
      _editView.ty = cy - (cy - _editView.ty) * ratio;
      _editView.scale = newS;
      // Snap exactly back to 1× and clear pan when nearly identity.
      if (Math.abs(newS - 1) < 0.01) { _editView.scale = 1; _editView.tx = 0; _editView.ty = 0; }
      _applyEditPreview();
    }, { passive: false });
    let _panDrag = null;
    el.addEventListener('mousedown', (e) => {
      // Don't fight CROP drags or trim-handle drags.
      if (_editState.cropOn && el === editOutVid) return;
      if (e.button !== 0) return;
      _panDrag = { x: e.clientX, y: e.clientY, tx: _editView.tx, ty: _editView.ty };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!_panDrag) return;
      _editView.tx = _panDrag.tx + (e.clientX - _panDrag.x);
      _editView.ty = _panDrag.ty + (e.clientY - _panDrag.y);
      _applyEditPreview();
    });
    window.addEventListener('mouseup', () => { _panDrag = null; });
    el.addEventListener('dblclick', () => _resetEditView());
  }
  _wirePanZoom(editOrigVid);
  _wirePanZoom(editOutVid);
  // Preview-audio volume + mute. ORIGINAL is the source of audio; EDITED
  // stays muted to avoid double-audio. The slider drives ORIGINAL.volume,
  // the speaker button toggles muted state. We default to muted so
  // opening the editor doesn't blast audio that was previously off.
  (() => {
    const volSlider = document.getElementById('vis-edit-vol');
    const volBtn    = document.getElementById('vis-edit-vol-btn');
    if (!volSlider || !volBtn || !editOrigVid) return;
    // Start muted — user opts in via the speaker button or by moving
    // the slider. EDITED stays muted permanently (avoid stereo doubling).
    editOrigVid.muted = true;
    editOrigVid.volume = (parseInt(volSlider.value, 10) || 80) / 100;
    if (editOutVid) editOutVid.muted = true;
    volBtn.classList.add('is-muted');
    volBtn.textContent = '🔇';
    volSlider.addEventListener('input', () => {
      const v = Math.max(0, Math.min(100, parseInt(volSlider.value, 10) || 0)) / 100;
      editOrigVid.volume = v;
      // Bumping the slider also un-mutes.
      if (v > 0 && editOrigVid.muted) {
        editOrigVid.muted = false;
        volBtn.classList.remove('is-muted');
        volBtn.textContent = '🔊';
      }
    });
    volBtn.addEventListener('click', () => {
      editOrigVid.muted = !editOrigVid.muted;
      volBtn.classList.toggle('is-muted', editOrigVid.muted);
      volBtn.textContent = editOrigVid.muted ? '🔇' : '🔊';
    });
  })();
  // Timeline scrub: click empty timeline → seek; drag a handle →
  // move trim. Listeners are attached directly to each handle so we
  // don't depend on event delegation through the timeline (which can
  // miss when the click lands on a pseudo-element or 1px off-edge).
  let _dragHandle = null;
  function _timelineFracFromEvent(e) {
    if (!editTimelineEl) return 0;
    const r = editTimelineEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  function _wireTrimHandle(el) {
    if (!el) return;
    el.addEventListener('mousedown', (e) => {
      _dragHandle = el.dataset.handle;
      el.classList.add('is-dragging');
      e.preventDefault();
      e.stopPropagation();
    });
  }
  _wireTrimHandle(editTrimInEl);
  _wireTrimHandle(editTrimOutEl);
  // Click on the timeline body (not on a handle) — seek.
  editTimelineEl?.addEventListener('mousedown', (e) => {
    if (e.target.closest('.vis-edit-trim-handle')) return; // handle wins
    const frac = _timelineFracFromEvent(e);
    if (editOrigVid) try { editOrigVid.currentTime = frac * _editState.duration; } catch {}
  });
  // ── Multi-track timeline scrubbing ──────────────────────────────
  // Click + drag anywhere on the ruler / V2 / V1 / A1 backgrounds
  // (NOT on a clip — clips handle their own drag) to seek the preview
  // through the project's time axis. Position is computed against the
  // timeline content's left edge, using the current pxPerSec.
  let _tlScrubbing = false;
  function _tlSeekFromEvent(e) {
    const tlContent = document.getElementById('vis-edit-tl-content');
    if (!tlContent || !editOrigVid) return;
    const r = tlContent.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const pps = Math.max(1, _editProject.pxPerSec || 50);
    const t = x / pps;
    // Clamp by the source's actual duration so a wide project
    // timeline doesn't park the video past its end (which would just
    // show the last frame anyway).
    const dur = Number.isFinite(editOrigVid.duration) && editOrigVid.duration > 0
      ? editOrigVid.duration
      : t;
    try { editOrigVid.currentTime = Math.max(0, Math.min(dur, t)); } catch {}
    if (typeof _refreshEditPlayhead === 'function') _refreshEditPlayhead();
  }
  const tlContentEl = document.getElementById('vis-edit-tl-content');
  tlContentEl?.addEventListener('mousedown', (e) => {
    // Clicks on a clip should NOT seek — the clip drag wins.
    if (e.target.closest('.vis-edit-tl-clip')) return;
    if (e.target.closest('.vis-edit-tl-clip-remove')) return;
    if (e.button !== 0) return;
    _tlScrubbing = true;
    _tlSeekFromEvent(e);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (_tlScrubbing) _tlSeekFromEvent(e);
  });
  window.addEventListener('mouseup', () => { _tlScrubbing = false; });
  window.addEventListener('mousemove', (e) => {
    if (!_dragHandle) return;
    const frac = _timelineFracFromEvent(e);
    const t = frac * _editState.duration;
    if (_dragHandle === 'in') {
      _editState.trimIn = Math.max(0, Math.min(t, _editState.trimOut - 0.1));
    } else if (_dragHandle === 'out') {
      _editState.trimOut = Math.min(_editState.duration, Math.max(t, _editState.trimIn + 0.1));
    }
    _refreshEditTimeUi();
    // Seek the preview to the active trim point so the user can see
    // exactly where they're cutting.
    if (editOrigVid) {
      try { editOrigVid.currentTime = (_dragHandle === 'in') ? _editState.trimIn : _editState.trimOut; } catch {}
    }
  });
  window.addEventListener('mouseup', () => {
    if (_dragHandle) {
      editTrimInEl?.classList.remove('is-dragging');
      editTrimOutEl?.classList.remove('is-dragging');
    }
    _dragHandle = null;
  });
  // Slider wiring — generic factory for the EDIT panel filter controls.
  function _bindSlider(id, valSel, state, key, suffix, decimals) {
    const slider = document.getElementById(id);
    const valEl  = document.querySelector(`.vis-edit-filter-val[data-for="${valSel}"]`);
    if (!slider || !valEl) return;
    const paint = () => {
      const n = parseFloat(slider.value);
      state.sliders[key] = n;
      valEl.textContent = decimals ? `${n.toFixed(decimals)} ${suffix}` : `${Math.round(n)}${suffix}`;
    };
    slider.addEventListener('input', () => {
      paint();
      _applyEditPreview();
    });
    paint();
  }
  _bindSlider('vis-edit-brightness',  'brightness', _editState, 'brightness', '%',  0);
  _bindSlider('vis-edit-contrast',    'contrast',   _editState, 'contrast',   '%',  0);
  _bindSlider('vis-edit-saturation',  'saturation', _editState, 'saturation', '%',  0);
  _bindSlider('vis-edit-hue',         'hue',        _editState, 'hue',        '°',  0);
  _bindSlider('vis-edit-blur',        'blur',       _editState, 'blur',       'px', 1);
  // New EDIT sliders.
  _bindSlider('vis-edit-sharpen',  'sharpen',  _editState, 'sharpen',  '%', 0);
  _bindSlider('vis-edit-vignette', 'vignette', _editState, 'vignette', '%', 0);
  _bindSlider('vis-edit-volume',   'volume',   _editState, 'volume',   '%', 0);
  // Speed slider — uses a `×` suffix and 2-decimal formatting because
  // the user-facing unit is a multiplier, not a percentage.
  (function bindSpeed() {
    const slider = document.getElementById('vis-edit-speed');
    const valEl  = document.querySelector('.vis-edit-filter-val[data-for="speed"]');
    if (!slider || !valEl) return;
    const paint = () => {
      const n = parseFloat(slider.value);
      _editState.sliders.speed = n;
      valEl.textContent = `${(n / 100).toFixed(2)}×`;
    };
    slider.addEventListener('input', () => { paint(); _applyEditPreview(); });
    paint();
  })();
  // Toggle helpers
  function _wireToggle(btn, state, key, onChange) {
    btn?.addEventListener('click', () => {
      state[key] = !state[key];
      btn.classList.toggle('is-active', state[key]);
      if (onChange) onChange();
    });
  }
  _wireToggle(editAutoBtn,    _editState, 'auto',    _applyEditPreview);
  _wireToggle(editDenoiseBtn, _editState, 'denoise', _applyEditPreview);
  // EFFECTS toggles: B&W / sepia / invert (mutex — picking one clears
  // the others), reverse, mute. flipH/flipV (TRANSFORM) handled here too
  // since they also use the same toggle pattern.
  function _wireMutex(btns, state, keys) {
    btns.forEach((btn, idx) => {
      btn?.addEventListener('click', () => {
        const key = keys[idx];
        const willEnable = !state[key];
        keys.forEach((k, i) => {
          state[k] = (i === idx) ? willEnable : false;
          btns[i]?.classList.toggle('is-active', state[k]);
        });
        _applyEditPreview();
      });
    });
  }
  _wireMutex(
    [document.getElementById('vis-edit-bw'),
     document.getElementById('vis-edit-sepia'),
     document.getElementById('vis-edit-invert')],
    _editState, ['bw', 'sepia', 'invert']);
  _wireToggle(document.getElementById('vis-edit-reverse'), _editState, 'reverse', null);
  _wireToggle(document.getElementById('vis-edit-mute'),    _editState, 'mute',    null);
  _wireToggle(document.getElementById('vis-edit-flip-h'),  _editState, 'flipH',   _applyEditPreview);
  _wireToggle(document.getElementById('vis-edit-flip-v'),  _editState, 'flipV',   _applyEditPreview);

  // ROTATE cycles 0 → 90 → 180 → 270 → 0 on each click.
  const editRotateBtn = document.getElementById('vis-edit-rotate');
  editRotateBtn?.addEventListener('click', () => {
    _editState.rotate = (_editState.rotate + 90) % 360;
    editRotateBtn.textContent = `↻ ROTATE ${_editState.rotate}°`;
    editRotateBtn.classList.toggle('is-active', _editState.rotate !== 0);
    _applyEditPreview();
  });

  // CROP toggle + reset.
  _wireToggle(document.getElementById('vis-edit-crop-toggle'), _editState, 'cropOn', _applyEditPreview);
  document.getElementById('vis-edit-crop-reset')?.addEventListener('click', () => {
    _editState.crop = { x: 0, y: 0, w: 1, h: 1 };
    _applyCropOverlay();
  });

  // Crop drag-rect interactions. Coordinates are normalized [0..1] and
  // converted to pixels on render. Drag the body to move; drag a handle
  // to resize. Renamed `editCropOverlay` to avoid collision with the
  // live-mirror crop overlay declared elsewhere in this file.
  const editCropOverlay = document.getElementById('vis-edit-crop');
  const editCropRect    = document.getElementById('vis-edit-crop-rect');
  function _applyCropOverlay() {
    if (!editCropRect) return;
    const c = _editState.crop;
    editCropRect.style.left   = `${(c.x * 100).toFixed(2)}%`;
    editCropRect.style.top    = `${(c.y * 100).toFixed(2)}%`;
    editCropRect.style.width  = `${(c.w * 100).toFixed(2)}%`;
    editCropRect.style.height = `${(c.h * 100).toFixed(2)}%`;
  }
  _applyCropOverlay();
  let _editCropDrag = null;
  function _editCropFromEvent(e, box) {
    const r = box.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  editCropOverlay?.addEventListener('mousedown', (e) => {
    if (!_editState.cropOn) return;
    const handle = e.target.closest?.('.vis-edit-crop-handle');
    if (handle) {
      _editCropDrag = { mode: 'resize', side: handle.dataset.chandle, start: { ..._editState.crop } };
    } else if (e.target.closest?.('.vis-edit-crop-rect')) {
      const p = _editCropFromEvent(e, editCropOverlay);
      _editCropDrag = { mode: 'move', offset: { x: p.x - _editState.crop.x, y: p.y - _editState.crop.y } };
    }
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!_editCropDrag || !editCropOverlay) return;
    const p = _editCropFromEvent(e, editCropOverlay);
    const c = _editState.crop;
    if (_editCropDrag.mode === 'move') {
      c.x = Math.max(0, Math.min(1 - c.w, p.x - _editCropDrag.offset.x));
      c.y = Math.max(0, Math.min(1 - c.h, p.y - _editCropDrag.offset.y));
    } else {
      const s = _editCropDrag.side;
      const start = _editCropDrag.start;
      if (s.includes('e')) c.w = Math.max(0.02, Math.min(1 - start.x, p.x - start.x));
      if (s.includes('s')) c.h = Math.max(0.02, Math.min(1 - start.y, p.y - start.y));
      if (s.includes('w')) {
        const right = start.x + start.w;
        const nx = Math.max(0, Math.min(right - 0.02, p.x));
        c.x = nx; c.w = right - nx;
      }
      if (s.includes('n')) {
        const bottom = start.y + start.h;
        const ny = Math.max(0, Math.min(bottom - 0.02, p.y));
        c.y = ny; c.h = bottom - ny;
      }
    }
    _applyCropOverlay();
  });
  window.addEventListener('mouseup', () => { _editCropDrag = null; });

  // TAB switching for the new COLOR / TRANSFORM / EFFECTS panes.
  document.querySelectorAll('.vis-edit-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.vis-edit-tab').forEach((t) =>
        t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.vis-edit-tabpane').forEach((p) =>
        p.classList.toggle('is-active', p.dataset.tabpane === target));
    });
  });
  // Collapse toggle on the tab strip — hides the entire tool body
  // (sliders + presets) so the timeline + previews get more room.
  // State stored in cfg.editToolsCollapsed and restored on next open.
  const editTabsCollapseBtn = document.getElementById('vis-edit-tabs-collapse');
  function _applyEditToolsCollapsed(collapsed) {
    if (editPane) editPane.classList.toggle('is-tools-collapsed', !!collapsed);
    if (editTabsCollapseBtn) editTabsCollapseBtn.textContent = collapsed ? '▸' : '▾';
  }
  (async () => {
    try {
      const cfg = (await window.dash?.getConfig?.()) || {};
      _applyEditToolsCollapsed(!!cfg.editToolsCollapsed);
    } catch {}
  })();
  editTabsCollapseBtn?.addEventListener('click', () => {
    const next = !editPane?.classList.contains('is-tools-collapsed');
    _applyEditToolsCollapsed(next);
    window.dash?.setConfig?.({ editToolsCollapsed: next });
  });

  // EXPAND button — toggles a body class that the CSS uses to elevate
  // the visualizer combo-pane over the rest of the combo panel and
  // hide the captures list, giving the editor the whole canvas.
  const editExpandBtn = document.getElementById('vis-edit-expand');
  editExpandBtn?.addEventListener('click', () => {
    const on = !document.body.classList.contains('has-rec-edit-expanded');
    document.body.classList.toggle('has-rec-edit-expanded', on);
    editExpandBtn.classList.toggle('is-active', on);
    editExpandBtn.textContent = on ? '⛶ COLLAPSE' : '⛶';
  });

  // + ADD — append a clip to the timeline. Picks the first selected
  // capture (or the currently-playing one if nothing is selected) and
  // appends it to the clip list. Probes the file via a hidden video
  // element to record its duration for the clip-bar label.
  const editAddClipBtn = document.getElementById('vis-edit-clips-add');
  editAddClipBtn?.addEventListener('click', () => {
    // Source candidates: selection first, else currently-playing.
    const candidates = _visualizerSelected.size
      ? [..._visualizerSelected]
      : (_visualizerCurrent ? [_visualizerCurrent] : []);
    const pool = candidates
      .map((abs) => _visualizerEntries.find((e) => e.path === abs))
      .filter((e) => e && _VIDEO_RENDER_RE.test(e.name));
    if (!pool.length) {
      if (editStatusEl) { editStatusEl.textContent = 'SELECT A RECORDING TO ADD'; editStatusEl.className = 'vis-edit-status is-error'; }
      return;
    }
    for (const e of pool) {
      // Skip duplicates of the anchor or any already-listed clip.
      if (_editState.clips.some((c) => c.path === e.path)) continue;
      const clip = { path: e.path, name: e.name, duration: 0 };
      _editState.clips.push(clip);
      // Probe duration off-screen so the bar label can show it.
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = `dash3d-file://gallery/${encodeURI(e.rel)}`;
      probe.addEventListener('loadedmetadata', () => {
        clip.duration = probe.duration || 0;
        try { probe.remove(); } catch {}
        _renderEditClips();
      });
      probe.addEventListener('error', () => { try { probe.remove(); } catch {} });
    }
    _renderEditClips();
    if (editStatusEl) { editStatusEl.textContent = `${_editState.clips.length} clip(s) queued`; editStatusEl.className = 'vis-edit-status is-ok'; }
  });

  // SNAPSHOT — draw the current EDITED frame to a canvas (including
  // applied CSS filter + transform) and save as PNG via comfySaveOutput
  // (re-uses that handler since it writes to gallery/generated/image/).
  const editSnapBtn = document.getElementById('vis-edit-snap');
  editSnapBtn?.addEventListener('click', async () => {
    if (!editOutVid || !editOutVid.videoWidth) return;
    if (editStatusEl) { editStatusEl.textContent = 'SNAPSHOTTING…'; editStatusEl.className = 'vis-edit-status'; }
    try {
      const c = document.createElement('canvas');
      c.width = editOutVid.videoWidth;
      c.height = editOutVid.videoHeight;
      const ctx = c.getContext('2d');
      ctx.filter = _editCssFilter(_editState);
      // Manual flip/rotate via canvas transform.
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      if (_editState.rotate) ctx.rotate(_editState.rotate * Math.PI / 180);
      ctx.scale(_editState.flipH ? -1 : 1, _editState.flipV ? -1 : 1);
      ctx.translate(-c.width / 2, -c.height / 2);
      ctx.drawImage(editOutVid, 0, 0, c.width, c.height);
      ctx.restore();
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const buf  = new Uint8Array(await blob.arrayBuffer());
      const stem = (_editState.src.split(/[\\/]/).pop() || 'frame').replace(/\.[^.]+$/, '');
      const r = await window.dash?.comfySaveOutput?.('image', buf, '.png', `${stem} FRAME`);
      if (r?.ok) {
        if (editStatusEl) { editStatusEl.textContent = `SNAP SAVED · ${r.name}`; editStatusEl.className = 'vis-edit-status is-ok'; }
        try { await refreshVisualizer(); } catch {}
      } else {
        if (editStatusEl) { editStatusEl.textContent = `SNAP ERROR · ${r?.error || 'unknown'}`; editStatusEl.className = 'vis-edit-status is-error'; }
      }
    } catch (err) {
      if (editStatusEl) { editStatusEl.textContent = `SNAP ERROR · ${err.message || err}`; editStatusEl.className = 'vis-edit-status is-error'; }
    }
  });
  // Buttons
  editBtn?.addEventListener('click', () => {
    // EDIT ROOM handoff: stash the current clip's path so EDIT ROOM's
    // activate() can pick it up out of the bin and load it in the
    // viewer. setComboMode comes from app.js's _paneDeps.
    if (!_visualizerCurrent || !_VIDEO_RENDER_RE.test(_visualizerCurrent)) return;
    const name = _visualizerCurrent.split(/[\\/]/).pop();
    window._editHandoff = { path: _visualizerCurrent, name };
    try { deps?.setComboMode?.('edit'); } catch (err) { console.warn('[visualizer] setComboMode failed:', err?.message || err); }
    playSfx?.('click');
  });
  editCloseBtn?.addEventListener('click', () => { _closeEditor(); playSfx?.('click'); });
  // Manual playhead tick — used when there's no real <video> driving
  // playback (e.g. V1 anchor is an image, or the user wants the
  // timeline to scrub through V2 overlays without an underlying clip).
  // Advances editOrigVid.currentTime manually so the playhead and
  // overlay-timing math keep working.
  let _editFakePlayTimer = null;
  function _editStartFakePlay() {
    if (_editFakePlayTimer) return;
    const startWall = performance.now();
    const startT    = editOrigVid?.currentTime || 0;
    _editFakePlayTimer = setInterval(() => {
      if (!editOrigVid) return;
      const elapsed = (performance.now() - startWall) / 1000;
      const dur = _editProject.duration || 30;
      let t = startT + elapsed;
      if (t >= dur) { t = 0; /* loop back */ }
      try { editOrigVid.currentTime = t; } catch {}
      if (typeof _refreshEditPlayhead === 'function') _refreshEditPlayhead();
    }, 1000 / 30); // 30fps tick
  }
  function _editStopFakePlay() {
    if (_editFakePlayTimer) { clearInterval(_editFakePlayTimer); _editFakePlayTimer = null; }
  }
  function _editPaintPlayBtn(isPlaying) {
    if (editPlayBtn) editPlayBtn.textContent = isPlaying ? '⏸' : '▶';
  }
  editPlayBtn?.addEventListener('click', async () => {
    if (!editOrigVid) return;
    const v1Anchor = _editProject.tracks.V1[0];
    const anchorIsImage = v1Anchor?.kind === 'image';
    if (anchorIsImage || !editOrigVid.src) {
      // No real video to play — drive the playhead manually.
      if (_editFakePlayTimer) { _editStopFakePlay(); _editPaintPlayBtn(false); }
      else                    { _editStartFakePlay(); _editPaintPlayBtn(true); }
      return;
    }
    // Normal video path.
    if (editOrigVid.paused) {
      _editPaintPlayBtn(true);
      try {
        await editOrigVid.play();
      } catch (err) {
        console.warn('[edit] play failed:', err?.message || err);
        _editPaintPlayBtn(false);
      }
    } else {
      editOrigVid.pause();
      _editPaintPlayBtn(false);
    }
  });
  // Keep the button icon in sync if play state changes from somewhere
  // else (auto-pause on trim drag, end-of-clip, etc.).
  editOrigVid?.addEventListener('play',   () => _editPaintPlayBtn(true));
  editOrigVid?.addEventListener('pause',  () => _editPaintPlayBtn(false));
  editOrigVid?.addEventListener('ended',  () => _editPaintPlayBtn(false));
  editResetBtn?.addEventListener('click', () => {
    Object.assign(_editState.sliders, {
      brightness: 100, contrast: 100, saturation: 100, hue: 0, blur: 0,
      sharpen: 0, vignette: 0, speed: 100, volume: 100,
    });
    Object.assign(_editState, {
      auto: false, denoise: false, bw: false, sepia: false, invert: false,
      reverse: false, mute: false, flipH: false, flipV: false, rotate: 0,
      cropOn: false, crop: { x: 0, y: 0, w: 1, h: 1 },
      trimIn: 0, trimOut: _editState.duration,
    });
    // Slider inputs back to defaults.
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal('vis-edit-brightness', 100);
    setVal('vis-edit-contrast',   100);
    setVal('vis-edit-saturation', 100);
    setVal('vis-edit-hue',        0);
    setVal('vis-edit-blur',       0);
    setVal('vis-edit-sharpen',    0);
    setVal('vis-edit-vignette',   0);
    setVal('vis-edit-speed',      100);
    setVal('vis-edit-volume',     100);
    // Clear all toggle pressed-states.
    document.querySelectorAll('.visualizer-edit-pane .vis-edit-toggle').forEach((b) =>
      b.classList.remove('is-active'));
    if (editRotateBtn) editRotateBtn.textContent = '↻ ROTATE 0°';
    // Re-paint slider value labels.
    document.querySelectorAll('#visualizer-edit-pane .vis-edit-filter-val').forEach((el) => {
      const k = el.dataset.for;
      if (!k || !(k in _editState.sliders)) return;
      const v = _editState.sliders[k];
      if (k === 'blur')         el.textContent = `${(v || 0).toFixed(1)} px`;
      else if (k === 'hue')     el.textContent = `${Math.round(v || 0)}°`;
      else if (k === 'speed')   el.textContent = `${(v / 100).toFixed(2)}×`;
      else                      el.textContent = `${Math.round(v || 0)}%`;
    });
    _editView.scale = 1; _editView.tx = 0; _editView.ty = 0;
    _applyCropOverlay();
    _applyEditPreview();
    _refreshEditTimeUi();
  });
  // Progress bar lives in the status row of the editor. We inject it
  // once on first export; subsequent exports just update its width.
  function _ensureExportProgressEl() {
    let bar = document.getElementById('vis-edit-progress');
    if (bar) return bar;
    const wrap = document.createElement('div');
    wrap.className = 'vis-edit-progress-wrap';
    bar = document.createElement('div');
    bar.id = 'vis-edit-progress';
    bar.className = 'vis-edit-progress';
    wrap.appendChild(bar);
    editStatusEl?.parentNode?.insertBefore(wrap, editStatusEl);
    return bar;
  }
  function _renderEditExportProgress(p) {
    const bar = _ensureExportProgressEl();
    const pct = Math.max(0, Math.min(100, p?.percent || 0));
    bar.style.width = `${pct}%`;
    if (editStatusEl) {
      const fps = p?.fps ? ` · ${Math.round(p.fps)}fps` : '';
      const enc = p?.encoder ? ` · ${p.encoder}` : '';
      editStatusEl.textContent = `RENDERING ${pct.toFixed(0)}%${fps}${enc}`;
    }
  }
  function _hideEditExportProgress() {
    const bar = document.getElementById('vis-edit-progress');
    if (bar) bar.style.width = '0%';
  }
  editExportBtn?.addEventListener('click', async () => {
    if (!_editState.src) return;
    if (editStatusEl) { editStatusEl.textContent = 'PREPARING…'; editStatusEl.className = 'vis-edit-status'; }
    _renderEditExportProgress({ percent: 0 });
    editExportBtn.disabled = true;
    editExportBtn.textContent = '… RENDERING';
    try {
      // Wire progress updates from main → progress bar in the editor.
      const progressUnsub = window.dash?.onEditExportProgress?.((p) => {
        _renderEditExportProgress(p);
      });
      const r = await window.dash?.editExportVideo?.({
        srcPath: _editState.src,
        trimIn:  _editState.trimIn,
        trimOut: _editState.trimOut,
        sliders: { ..._editState.sliders },
        auto:    _editState.auto,
        denoise: _editState.denoise,
        bw:      _editState.bw,
        sepia:   _editState.sepia,
        invert:  _editState.invert,
        reverse: _editState.reverse,
        mute:    _editState.mute,
        flipH:   _editState.flipH,
        flipV:   _editState.flipV,
        rotate:  _editState.rotate,
        crop:    _editState.cropOn ? _editState.crop : null,
        // Project output resolution — drives overlay scaling math.
        projectWidth:  _editProject.width  || 1920,
        projectHeight: _editProject.height || 1080,
        projectFps:    _editProject.fps    || 30,
        // Anchor metadata for the export pipeline. If the first clip
        // is an image, the export pipeline switches into still-mode
        // for the anchor input (`-loop 1 -t <duration>`).
        anchorKind: _editProject.tracks.V1[0]?.kind || 'video',
        anchorDuration: _editProject.tracks.V1[0]?.srcDuration || 3,
        // Extra appended clips (V1 track in start-time order, skipping
        // the anchor). Each entry carries its kind + duration so still
        // images become looped inputs in the concat.
        extraClips: _editProject.tracks.V1
          .slice()
          .sort((a, b) => a.start - b.start)
          .slice(1)
          .map((c) => ({
            path: c.path,
            kind: c.kind || 'video',
            duration: c.srcDuration || 3,
          })),
        // V2 image overlays — each composes on top of the V1 output
        // for its time range. Coordinates are fractions of the
        // project canvas (same as the preview overlay).
        v2Overlays: _editProject.tracks.V2
          .filter((c) => c.kind === 'image')
          .map((c) => ({
            path: c.path,
            start: c.start,
            duration: Math.max(0.05, (c.out || 0) - (c.in || 0)),
            x: c.x, y: c.y, w: c.w, h: c.h,
          })),
      });
      try { progressUnsub?.(); } catch {}
      if (r?.ok) {
        if (editStatusEl) { editStatusEl.textContent = `SAVED · ${r.name}`; editStatusEl.className = 'vis-edit-status is-ok'; }
        await refreshVisualizer();
      } else {
        if (editStatusEl) { editStatusEl.textContent = `ERROR · ${r?.error || 'unknown'}`; editStatusEl.className = 'vis-edit-status is-error'; }
      }
    } catch (err) {
      if (editStatusEl) { editStatusEl.textContent = `ERROR · ${err.message || err}`; editStatusEl.className = 'vis-edit-status is-error'; }
    } finally {
      editExportBtn.disabled = false;
      editExportBtn.textContent = '▶ EXPORT';
      _hideEditExportProgress();
    }
  });
  // Initial paint — the EDIT button's enabled state is also refreshed
  // alongside DELETE at every playback / selection change point (see
  // the `_refreshEditBtn();` calls added next to each `_refreshDeleteBtn()`
  // callsite).
  _refreshEditBtn();

  // ── SOUND toggle (recording-audio gate) ─────────────────────────
  // The mirror video element is always muted — the source app is
  // already playing through the OS speakers, so anything we'd play
  // from the mirror would double the user's audio. The button used
  // to toggle that mute, which is what was causing the doubling.
  //
  // It now controls a single flag, `_recCaptureAudio`, that
  // determines whether _startScreenrec spins up the WASAPI loopback
  // track. Default is TRUE (recordings get audio). The button is
  // `is-active` (lit/red) when the flag is OFF — a deliberate
  // warning style: "your next recording will be silent."
  const muteBtn = document.getElementById('visualizer-mute-btn');
  let _recCaptureAudio = true;
  // Surface on the closure scope so _startScreenrec can read it.
  function _shouldCaptureAudio() { return _recCaptureAudio; }
  function _paintSoundBtn() {
    if (!muteBtn) return;
    muteBtn.textContent = 'SOUND';
    muteBtn.title = _recCaptureAudio
      ? 'System audio capture ON — click to mute all system sources'
      : 'System audio capture OFF — click to enable';
    // Normal toggle: lit = ON. Use the MIXER rows to control
    // per-source levels and mutes; this button is the global gate.
    muteBtn.classList.toggle('is-active', _recCaptureAudio);
  }
  muteBtn?.addEventListener('click', async () => {
    _recCaptureAudio = !_recCaptureAudio;
    _paintSoundBtn();
    try { await window.dash?.setConfig?.({ recRoomCaptureAudio: _recCaptureAudio }); } catch {}
    _renderMixer();
    playSfx?.('click');
  });

  // ── MIC toggle (mic capture into the recording) ─────────────────
  // Mirror of SOUND: lit when OFF, default ON. The permission grant
  // is deferred to recording start so the mic doesn't sit open
  // between sessions; this button just controls the flag.
  const micBtn = document.getElementById('visualizer-mic-btn');
  let _recCaptureMic = true;
  function _shouldCaptureMic() { return _recCaptureMic; }
  function _paintMicBtn() {
    if (!micBtn) return;
    micBtn.textContent = 'MIC';
    micBtn.title = _recCaptureMic
      ? 'Microphone capture ON — click to mute all mics'
      : 'Microphone capture OFF — click to enable';
    // Normal toggle: lit = ON. Per-mic levels live in the MIXER.
    micBtn.classList.toggle('is-active', _recCaptureMic);
  }
  micBtn?.addEventListener('click', async () => {
    _recCaptureMic = !_recCaptureMic;
    _paintMicBtn();
    try { await window.dash?.setConfig?.({ recRoomCaptureMic: _recCaptureMic }); } catch {}
    _renderMixer();
    playSfx?.('click');
  });

  // ── MIXER (pre-record audio bus) ────────────────────────────────
  // Per-source mute + volume that the recorder honors. State is
  // keyed by source kind: 'system' / 'mic' / 'window'. Sources only
  // render in the panel when their owning toggle is on (SOUND for
  // system, MIC for mic, mirror-audio-tracks-present for window).
  const _mixer = {
    system: { muted: false, vol: 100 },
    mic:    { muted: false, vol: 100 },
    window: { muted: false, vol: 100 },
  };
  const _mixerRowsEl = document.getElementById('visualizer-mixer-rows');
  function _activeMixerSources() {
    const active = [];
    if (_recCaptureAudio) active.push({ kind: 'system', label: 'SYSTEM' });
    if (_recCaptureMic)   active.push({ kind: 'mic',    label: 'MIC' });
    // Window audio shows up when the mirror exposes an audio track —
    // depends on the source the user picked. Re-check on every render
    // so picking a new source updates the panel.
    if (_mirrorStream?.getAudioTracks?.().length) {
      active.push({ kind: 'window', label: 'WINDOW' });
    }
    return active;
  }
  function _renderMixer() {
    if (!_mixerRowsEl) return;
    const sources = _activeMixerSources();
    _mixerRowsEl.innerHTML = '';
    if (!sources.length) {
      const empty = document.createElement('div');
      empty.className = 'visualizer-mixer-empty';
      empty.textContent = 'NO ACTIVE SOURCES · TURN ON SOUND OR MIC TO ENABLE';
      _mixerRowsEl.appendChild(empty);
      return;
    }
    for (const src of sources) {
      const state = _mixer[src.kind];
      const row = document.createElement('div');
      row.className = 'visualizer-mixer-row' + (state.muted ? ' is-muted' : '');
      row.dataset.kind = src.kind;
      const k = document.createElement('span'); k.className = 'visualizer-mixer-k'; k.textContent = src.label;
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'visualizer-mixer-mute' + (state.muted ? ' is-muted' : '');
      mute.textContent = state.muted ? 'MUTED' : 'MUTE';
      mute.title = state.muted ? 'Un-mute this source in the mix' : 'Mute this source in the mix';
      mute.addEventListener('click', async () => {
        state.muted = !state.muted;
        await _persistMixer();
        _renderMixer();
        playSfx?.('click');
      });
      const slide = document.createElement('input');
      slide.type = 'range'; slide.min = '0'; slide.max = '150'; slide.step = '1'; slide.value = String(state.vol);
      const v = document.createElement('span'); v.className = 'visualizer-mixer-v'; v.textContent = String(state.vol);
      slide.addEventListener('input', () => {
        const next = parseInt(slide.value, 10);
        if (Number.isFinite(next)) {
          state.vol = next;
          v.textContent = String(next);
          // Hot-apply when a recording is active — gain nodes are
          // kept on _screenrecState.mixerNodes for exactly this.
          const mn = _screenrecState?.mixerNodes?.[src.kind];
          if (mn?.gain) mn.gain.gain.value = (state.muted ? 0 : next / 100);
        }
      });
      slide.addEventListener('change', _persistMixer);
      // Peak-style level meter. Width is driven by a CSS --level custom
      // property that _meterLoop sets every ~33 ms during recording.
      // Idle (no recording) just stays at 0 — the dark bar is the
      // "this source is wired but not active" cue.
      const meter = document.createElement('div');
      meter.className = 'visualizer-mixer-meter';
      meter.title = 'Signal level — green/yellow/red = quiet/loud/clipping';
      const meterFill = document.createElement('div');
      meterFill.className = 'visualizer-mixer-meter-fill';
      meter.appendChild(meterFill);
      row.appendChild(k);
      row.appendChild(mute);
      row.appendChild(slide);
      row.appendChild(v);
      row.appendChild(meter);
      _mixerRowsEl.appendChild(row);
    }
  }
  async function _persistMixer() {
    try { await window.dash?.setConfig?.({ recRoomMixer: _mixer }); } catch {}
  }
  window.addEventListener('rec-mirror-changed', _renderMixer);

  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    // Default ON; only OFF if explicitly disabled by a prior session.
    _recCaptureAudio = cfg.recRoomCaptureAudio !== false;
    _recCaptureMic   = cfg.recRoomCaptureMic   !== false;
    if (cfg.recRoomMixer && typeof cfg.recRoomMixer === 'object') {
      for (const k of ['system', 'mic', 'window']) {
        if (cfg.recRoomMixer[k]) Object.assign(_mixer[k], cfg.recRoomMixer[k]);
      }
    }
    _paintSoundBtn();
    _paintMicBtn();
    _renderMixer();
    // Meter loop runs forever — it reads from _mon.{kind}.analyser
    // which is only populated when mirror is active, so the meters
    // sit at 0 until the user starts mirroring (which calls
    // _refreshMonitor to populate _mon).
    _startMeterLoop();
  })();

  // ── Persistent monitor graph (always-on level metering) ─────────
  // Separate from _buildMixerStream's per-recording graph. This one is
  // live whenever a source is toggled ON or the mirror has window audio,
  // so the level meters animate at all times (not just during REC).
  // Cheap: just an AnalyserNode per source; no MediaRecorder, no dest.
  // Source streams:
  //   • system: WASAPI loopback PCM (we subscribe to the same audify
  //             worker the recording uses, scheduled into BufferSource
  //             nodes that feed the analyser).
  //   • mic:    a dedicated getUserMedia stream (separate from the
  //             one _buildMixerStream opens at REC start).
  //   • window: a MediaStreamSource off whatever audio tracks the
  //             active mirror exposes.
  const _mon = { ctx: null, system: null, mic: null, window: null };
  async function _monCtx() {
    if (_mon.ctx) return _mon.ctx;
    try { _mon.ctx = new (window.AudioContext || window.webkitAudioContext)(); return _mon.ctx; }
    catch (err) { console.warn('[mon] AudioContext failed:', err?.message || err); return null; }
  }
  function _makeMonAnalyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = 512;
    a.smoothingTimeConstant = 0.35;
    return a;
  }
  async function _monAttachSystem() {
    if (_mon.system) return;
    const ctx = await _monCtx(); if (!ctx) return;
    const analyser = _makeMonAnalyser(ctx);
    let nextStart = 0;
    const handler = (data) => {
      if (!data?.pcm) return;
      const samples = data.pcm;
      const ch = Math.max(1, data.channels | 0 || 2);
      const sr = data.sampleRate | 0 || ctx.sampleRate;
      const frames = (samples.length / ch) | 0;
      if (frames < 1) return;
      let buf;
      try { buf = ctx.createBuffer(ch, frames, sr); } catch { return; }
      for (let c = 0; c < ch; c++) {
        const cd = buf.getChannelData(c);
        for (let i = 0; i < frames; i++) cd[i] = samples[i * ch + c];
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(analyser);
      const now = ctx.currentTime;
      if (nextStart < now + 0.06) nextStart = now + 0.06;
      try { src.start(nextStart); } catch {}
      nextStart += buf.duration;
    };
    const unsub = window.dash?.onLoopbackPcm?.(handler) || (() => {});
    try { await window.dash?.setLoopbackPcm?.(true); }
    catch (err) { try { unsub(); } catch {}; console.warn('[mon] setLoopbackPcm failed:', err?.message || err); return; }
    _mon.system = { analyser, unsub };
    console.log('[mon] system attached');
  }
  function _monDetachSystem() {
    if (!_mon.system) return;
    try { _mon.system.unsub(); } catch {}
    _mon.system = null;
    // We do NOT call setLoopbackPcm(false) here — the recording path
    // also turns it on/off via _buildLoopbackAudioTrack and we'd race.
    // Leaving the worker forwarding PCM costs ~nothing if nobody's
    // subscribed (it's a flag in main).
    console.log('[mon] system detached');
  }
  async function _monAttachMic() {
    if (_mon.mic) return;
    const ctx = await _monCtx(); if (!ctx) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    } catch (err) {
      const msg = err?.message || err?.name || 'unknown';
      console.warn('[mon] mic gUM failed:', msg, err);
      if (visualizerNowEl) visualizerNowEl.textContent = `MIC FAILED · ${msg}`;
      return;
    }
    const t0 = stream.getAudioTracks()[0];
    console.log('[mon] mic attached:', { label: t0?.label || '(no label)', muted: t0?.muted, deviceId: t0?.getSettings?.()?.deviceId });
    if (t0?.muted) {
      if (visualizerNowEl) visualizerNowEl.textContent = `MIC MUTED AT OS · check Windows mic privacy`;
    }
    const src = ctx.createMediaStreamSource(stream);
    const analyser = _makeMonAnalyser(ctx);
    src.connect(analyser);
    _mon.mic = { analyser, stream };
  }
  function _monDetachMic() {
    if (!_mon.mic) return;
    for (const t of _mon.mic.stream.getTracks()) { try { t.stop(); } catch {} }
    _mon.mic = null;
    console.log('[mon] mic detached');
  }
  async function _monAttachWindow() {
    if (_mon.window) return;
    const tracks = _mirrorStream?.getAudioTracks?.() || [];
    if (!tracks.length) return;
    const ctx = await _monCtx(); if (!ctx) return;
    const stream = new MediaStream(tracks);
    const src = ctx.createMediaStreamSource(stream);
    const analyser = _makeMonAnalyser(ctx);
    src.connect(analyser);
    _mon.window = { analyser };
    console.log('[mon] window attached:', tracks.length, 'track(s)');
  }
  function _monDetachWindow() {
    if (!_mon.window) return;
    _mon.window = null;
    console.log('[mon] window detached');
  }
  // Called whenever a toggle flips, mirror changes, or recording
  // starts/stops. Monitor is torn down when:
  //   • mirror is OFF (no source to monitor)
  //   • REC is active (the recording's _buildMixerStream opens its own
  //     gUM / loopback subscription, and running both monitor + record
  //     graphs in parallel was stalling MediaRecorder by contending for
  //     the mic device / loopback PCM subscription on Windows).
  // During REC the meter loop falls through to _screenrecState.mixerNodes
  // analysers so meters keep animating from the recording's graph.
  async function _refreshMonitor() {
    const mirrorActive = !!_mirrorStream;
    const recActive = !!_screenrecState;
    if (!mirrorActive || recActive) {
      _monDetachSystem(); _monDetachMic(); _monDetachWindow();
      return;
    }
    if (_recCaptureAudio) await _monAttachSystem(); else _monDetachSystem();
    if (_recCaptureMic)   await _monAttachMic();    else _monDetachMic();
    const hasWin = (_mirrorStream?.getAudioTracks?.() || []).length > 0;
    if (hasWin) await _monAttachWindow(); else _monDetachWindow();
  }
  // Special-case: when the mirror source changes, the WINDOW node still
  // points at the old stream's tracks. Tear down + rebuild so the
  // analyser tracks the new mirror.
  function _monRebuildWindow() {
    _monDetachWindow();
    const hasWin = (_mirrorStream?.getAudioTracks?.() || []).length > 0;
    if (hasWin) _monAttachWindow();
  }

  // Meter loop — always running. Per row, peak-detects from the active
  // monitor analyser (or zeros the meter if that source isn't attached).
  // The meter element is a CSS-driven fill bar; the only per-frame work
  // is the analyser fill + a peak scan over 512 samples.
  let _meterRaf = 0;
  const _meterBuf = new Uint8Array(512);
  function _startMeterLoop() {
    if (_meterRaf) return;
    const tick = () => {
      if (!_mixerRowsEl) { _meterRaf = 0; return; }
      for (const kind of ['system', 'mic', 'window']) {
        const row = _mixerRowsEl.querySelector(`[data-kind="${kind}"]`);
        if (!row) continue;
        // Prefer the recording graph's analyser when REC is active —
        // the monitor is torn down during REC to avoid hardware
        // contention, so this is where meters come from mid-recording.
        const analyser = _screenrecState?.mixerNodes?.[kind]?.analyser
                       || _mon[kind]?.analyser;
        if (!analyser) { row.style.setProperty('--level', '0'); continue; }
        try { analyser.getByteTimeDomainData(_meterBuf); } catch { continue; }
        // Peak deviation from 128 (silence) → 0..128 → map to dB then
        // to 0..1 across a -60 dB → 0 dB range so quiet speech is
        // still visible instead of crammed into the bottom 5%.
        let peak = 0;
        for (let i = 0; i < _meterBuf.length; i++) {
          const v = Math.abs(_meterBuf[i] - 128);
          if (v > peak) peak = v;
        }
        const amp = peak / 128;
        const db  = amp > 0.0001 ? 20 * Math.log10(amp) : -80;
        const lvl = Math.max(0, Math.min(1, (db + 60) / 60));
        row.style.setProperty('--level', lvl.toFixed(3));
      }
      _meterRaf = requestAnimationFrame(tick);
    };
    _meterRaf = requestAnimationFrame(tick);
  }
  function _stopMeterLoop() {
    if (_meterRaf) { cancelAnimationFrame(_meterRaf); _meterRaf = 0; }
  }


  // ── MIRROR: route the active video into this pane ────────────────
  // Uses Electron's desktopCapturer (via the visualizer-get-video-source
  // IPC, which picks the YT popout window first, then the dashboard
  // window for in-pane BrowserView videos, then a screen as a last
  // resort) plus the legacy `chromeMediaSource: 'desktop'` constraint
  // on getUserMedia to grab a MediaStream of that source. The stream
  // is piped directly into the existing #visualizer-video element, so
  // the surrounding chrome (play/pause, audio viz, etc.) keeps working.
  // Toggle off → tracks are stopped and srcObject cleared.
  const mirrorBtn = document.getElementById('visualizer-mirror-btn');
  // Inline source strip — replaces the old fullscreen picker. Holds one
  // button per available screen/window; SCAN refreshes the list. Cameras
  // live in their own strip next to the mixer (see camStripBodyEl).
  const sourceStripEl = document.getElementById('visualizer-source-strip');
  const sourceScanBtn = document.getElementById('visualizer-source-scan');
  // Direct-URL playback — paste a .mp4 / .webm / .m3u8 / etc. and the
  // mirror switches to URL mode (videoEl.src = url) instead of screen
  // capture. captureStream() turns the playing element back into a
  // MediaStream so the rec pipeline records it identically.
  const sourceUrlEl   = document.getElementById('visualizer-source-url');
  const sourceUrlGoBtn = document.getElementById('visualizer-source-url-go');
  const camStripBodyEl = document.getElementById('visualizer-cam-strip-body');
  const screencapBtn  = document.getElementById('visualizer-screencap-btn');
  const stealthBtn    = document.getElementById('visualizer-stealth-btn');
  let _mirrorStream = null;
  // Track which mirror MODE is currently active so teardown knows
  // whether it also needs to clear videoEl.src (URL mode) on top of
  // the always-required srcObject reset (stream mode).
  let _urlMirrorActive = false;
  // STEALTH: mute the preview speakers while leaving the recording
  // audio fully intact. Chromium's captureStream() drops audio when
  // the element's `muted` flag is set, so we route playback through a
  // Web Audio graph:
  //
  //   MediaElementSource → stealthGain → AudioContext.destination  (speakers, gated)
  //                      → MediaStreamDestination                   (recording, always full)
  //
  // The graph is lazy-created on the first URL mirror — once it
  // exists, the element's default <audio> output is gone forever
  // (Chromium routes everything through the graph), so the gain
  // ALSO controls speaker output for screen / multi-cam mirror modes.
  // _updateGainForCurrentMode picks the right gain target each time
  // a mirror starts / stops or stealth toggles.
  let _stealthOn = false;
  let _audioCtx = null;
  let _mediaSrc = null;
  let _stealthGain = null;
  let _recAudioDest = null;
  function _ensureAudioGraph() {
    if (_mediaSrc || !visualizerVideoEl) return !!_mediaSrc;
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      _mediaSrc = _audioCtx.createMediaElementSource(visualizerVideoEl);
      _stealthGain = _audioCtx.createGain();
      _stealthGain.gain.value = 1;
      _mediaSrc.connect(_stealthGain).connect(_audioCtx.destination);
      _recAudioDest = _audioCtx.createMediaStreamDestination();
      _mediaSrc.connect(_recAudioDest);
      return true;
    } catch (err) {
      console.warn('[stealth] audio graph init failed:', err?.message || err);
      _audioCtx = null; _mediaSrc = null; _stealthGain = null; _recAudioDest = null;
      return false;
    }
  }
  // Resolve the target gain based on what's currently driving the
  // <video> element. Cam mirror + screen mirror always 0 (their audio
  // reaches the recorder through other paths and we don't want the
  // page speakers doubling it); URL mirror obeys stealth; file
  // playback / no source uses 1 so the gallery still has sound.
  function _updateGainForCurrentMode() {
    if (!_stealthGain) return;
    let g = 1;
    if (_urlMirrorActive) g = _stealthOn ? 0 : 1;
    else if (_multiCamState) g = 0;
    else if (_mirrorStream)  g = 0;
    _stealthGain.gain.value = g;
  }
  // Kept for the existing call sites that ask "apply current preview-
  // mute state" — now just re-evaluates the gain.
  function _applyPreviewMute() {
    _updateGainForCurrentMode();
  }
  function _setStealth(on) {
    _stealthOn = !!on;
    stealthBtn?.classList.toggle('is-active', _stealthOn);
    // Blackout overlay only applies when stealth is on AND a URL
    // mirror is the live source (the only mode where stealth means
    // anything to the user). Without the second guard, the overlay
    // would also cover gallery file playback.
    _refreshStealthOverlay();
    _updateGainForCurrentMode();
    // User-gesture moment — kick the AudioContext awake if Chromium
    // has suspended it since URL mirror startup (idle timer, device
    // change, etc.). A suspended _audioCtx makes _recAudioDest emit
    // no samples; a record fired immediately after a stealth toggle
    // would otherwise produce a silent clip even though stealth was
    // meant to preserve the recording branch. .resume() is a no-op
    // when the context is already running, so this is safe to call
    // unconditionally on every toggle.
    if (_audioCtx && _audioCtx.state === 'suspended') {
      _audioCtx.resume().catch((err) => {
        console.warn('[stealth] audio ctx resume failed:', err?.message || err);
      });
    }
    try { window.dash?.setConfig?.({ recRoomStealth: _stealthOn }); } catch {}
  }
  function _refreshStealthOverlay() {
    if (!visualizerWrapEl) return;
    visualizerWrapEl.classList.toggle('is-stealth', _stealthOn && _urlMirrorActive);
  }
  stealthBtn?.addEventListener('click', () => {
    _setStealth(!_stealthOn);
    playSfx?.('click');
  });
  (async () => {
    try {
      const cfg = await window.dash?.getConfig?.();
      if (cfg?.recRoomStealth) _setStealth(true);
    } catch {}
  })();

  // ── Player-wrap overlay STEALTH + REC buttons ──────────────────
  // Forward clicks to the source topbar buttons so there's one
  // logic owner (_setStealth / _startScreenrec / _stopScreenrec).
  // MutationObserver mirrors .is-active from the source buttons so
  // the overlay visual state stays in sync without us touching every
  // toggle site. Cheap — only fires on actual class changes.
  const stealthBtnOverlay   = document.getElementById('visualizer-stealth-btn-overlay');
  const screenrecBtnOverlay = document.getElementById('visualizer-screenrec-btn-overlay');
  stealthBtnOverlay?.addEventListener('click', (e) => {
    e.stopPropagation();
    stealthBtn?.click();
  });
  screenrecBtnOverlay?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('visualizer-screenrec-btn')?.click();
  });
  const _mirrorBtnActive = (src, dst) => {
    if (!src || !dst) return;
    const sync = () => dst.classList.toggle('is-active', src.classList.contains('is-active'));
    new MutationObserver(sync).observe(src, { attributes: true, attributeFilter: ['class'] });
    sync();
  };
  _mirrorBtnActive(stealthBtn, stealthBtnOverlay);
  _mirrorBtnActive(document.getElementById('visualizer-screenrec-btn'), screenrecBtnOverlay);
  // Manual orientation toggle. Auto-detect by source dims was tried first
  // but failed to fire reliably (loadedmetadata races, captureStream-only
  // sources with no early dims, etc.), so the user chose to drive this
  // by hand. The button label always shows the OTHER orientation —
  // clicking does what the label says.
  const orientBtn = document.getElementById('visualizer-orient-btn');
  let _portraitLayout = false;
  function _setPortraitLayout(on) {
    _portraitLayout = !!on;
    visualizerPane?.classList.toggle('is-portrait-source', _portraitLayout);
    if (orientBtn) {
      orientBtn.classList.toggle('is-active', _portraitLayout);
      orientBtn.setAttribute('aria-pressed', _portraitLayout ? 'true' : 'false');
      const label = orientBtn.querySelector('.visualizer-orient-label');
      if (label) label.textContent = _portraitLayout ? '16:9' : '9:16';
      orientBtn.title = _portraitLayout
        ? 'Switch player layout back to horizontal (16:9)'
        : 'Switch player layout to vertical (9:16) — controls move to a column on the right';
    }
    try { window.dash?.setConfig?.({ recRoomPortrait: _portraitLayout }); } catch {}
  }
  orientBtn?.addEventListener('click', () => {
    _setPortraitLayout(!_portraitLayout);
    playSfx?.('click');
  });
  (async () => {
    try {
      const cfg = await window.dash?.getConfig?.();
      if (cfg?.recRoomPortrait) _setPortraitLayout(true);
    } catch {}
  })();
  // Multi-cam composite state. Populated by _startMultiCamMirror; torn
  // down by _stopVisualizerMirror. Holds the per-cam streams, hidden
  // <video> elements, the compositing canvas + raf, and the Web Audio
  // graph so stop can release everything cleanly.
  let _multiCamState = null;
  // Cached videoinput/audioinput devices, refreshed on each picker open.
  // groupId is used to pair a cam with its built-in mic.
  let _camDevices = [];
  let _micDevices = [];
  // Set of deviceIds currently ticked in the WEBCAMS list.
  let _camPicked = new Set();
  // Resolution presets for the multi-cam composite. Drives both the
  // getUserMedia constraint and the canvas size, so the recording lands
  // at exactly the chosen resolution.
  const _CAM_RES_PRESETS = {
    '480p':  { w:  854, h:  480 },
    '720p':  { w: 1280, h:  720 },
    '1080p': { w: 1920, h: 1080 },
    '4k':    { w: 3840, h: 2160 },
  };
  let _camResolution = '720p';
  // When set (via picker), startMirror uses this source instead of
  // calling the auto-pick IPC. Cleared on stop so the next plain MIRROR
  // click falls back to auto-pick.
  let _mirrorSourceOverride = null;
  function _stopVisualizerMirror() {
    // Flush any in-progress screen record first so its writer closes
    // cleanly before we kill the source stream.
    if (typeof _stopScreenrec === 'function' && _screenrecState) {
      try { _stopScreenrec(); } catch {}
    }
    // Multi-cam composite: stop the per-cam streams, detach the hidden
    // video elements, cancel the draw loop, and close the audio mix
    // graph. Done BEFORE we stop _mirrorStream's tracks so the canvas
    // captureStream gets a clean shutdown.
    if (_multiCamState) {
      try { _multiCamState.cancel?.(); } catch {}
      // Order matters for OS device release on Chromium: detach the
      // video element FIRST (so Chromium drops its internal pin on
      // the stream), THEN remove each track from its stream AND
      // call stop(). Skipping removeTrack often leaves the OS-level
      // capture alive (cam LED stays on) even though stop() returned.
      for (const v of _multiCamState.videos || []) {
        try { v.pause(); } catch {}
        v.srcObject = null;
        try { v.parentNode?.removeChild(v); } catch {}
      }
      let _stopCount = 0;
      for (const c of _multiCamState.cams || []) {
        const tracks = c.stream?.getTracks?.() || [];
        for (const tr of tracks) {
          try { c.stream.removeTrack?.(tr); } catch {}
          try { tr.stop(); _stopCount++; }
          catch (err) { console.warn('[multi-cam] track.stop() threw:', err?.message || err); }
        }
        // Drop our reference so GC can release the stream object.
        c.stream = null;
        console.log('[multi-cam] stopped tracks for', c.label || c.camId, '→', tracks.length, 'tracks');
      }
      console.log('[multi-cam] teardown: stopped', _stopCount, 'tracks total across', _multiCamState.cams?.length || 0, 'cams');
      // Composite canvas was parented to the cam-video host; detach so
      // it doesn't linger after stop.
      try { _multiCamState.canvas?.parentNode?.removeChild(_multiCamState.canvas); } catch {}
      for (const n of _multiCamState.audioNodes || []) { try { n.disconnect(); } catch {} }
      try { _multiCamState.mixDest?.disconnect?.(); } catch {}
      try { _multiCamState.audioCtx?.close?.(); } catch {}
      _multiCamState = null;
    }
    if (_mirrorStream) {
      // Audio tracks from our persistent Web Audio dest belong to the
      // graph — stopping them would kill the dest for future URL
      // mirrors. Filter them out and stop everything else.
      const graphAudioTracks = _recAudioDest?.stream?.getAudioTracks?.() || [];
      for (const tr of _mirrorStream.getTracks()) {
        if (graphAudioTracks.includes(tr)) continue;
        try { tr.stop(); } catch {}
      }
      _mirrorStream = null;
    }
    if (visualizerVideoEl) {
      // Clear BOTH attachment modes — screen mirror uses srcObject,
      // URL mirror uses src. Setting both to empty guarantees the
      // element releases its resources regardless of which path was
      // active.
      visualizerVideoEl.srcObject = null;
      if (_urlMirrorActive) {
        try { visualizerVideoEl.pause(); } catch {}
        visualizerVideoEl.removeAttribute('src');
        try { visualizerVideoEl.load(); } catch {}
      }
      // .muted has been a no-op since the Web Audio graph was created
      // (Chromium routes through the graph from then on), but reset
      // it to false anyway so gallery file playback before any URL
      // mirror still has audio.
      visualizerVideoEl.muted = false;
    }
    _urlMirrorActive = false;
    _updateGainForCurrentMode(); // file playback / no source → gain=1
    _refreshStealthOverlay();    // no URL mirror → overlay off even if stealth still flagged
    mirrorBtn?.classList.remove('is-active');
    if (mirrorBtn) mirrorBtn.textContent = 'MIRROR';
    visualizerWrapEl?.classList.remove('is-mirroring', 'is-url-mirror');
    _mirrorSourceOverride = null;
    // Mirror is gone — the WINDOW source row in the MIXER also goes
    // away. Refresh the panel so the user sees the change without
    // having to toggle SOUND/MIC.
    try { _renderMixer?.(); } catch {}
    // Drop the dynamic source-aspect; the wrap goes back to default
    // full-pane-width sizing until the next mirror or playback.
    if (typeof _setSourceDims === 'function') _setSourceDims(0, 0);
  }
  // Multi-cam composite: open N webcams in parallel, paint each into a
  // tile of one canvas, mix all their mics into one audio track via Web
  // Audio, then expose the canvas-captureStream + mixed audio as the
  // mirror stream so REC / KEYS / OSD / mute all keep working unchanged.
  //
  // Grid: 1=full, 2=side-by-side, 3-4=2x2, 5-9=3x3. Each tile is
  // letterboxed to preserve aspect.
  function _camGridLayout(n) {
    if (n <= 1) return { cols: 1, rows: 1 };
    if (n <= 2) return { cols: 2, rows: 1 };
    if (n <= 4) return { cols: 2, rows: 2 };
    return { cols: 3, rows: 3 };
  }
  async function _startMultiCamMirror(deviceIds) {
    if (!visualizerVideoEl || !deviceIds?.length) return;
    // Cap at the 9-tile grid limit so we don't try to open 12 cams.
    if (deviceIds.length > 9) deviceIds = deviceIds.slice(0, 9);
    // Any prior mirror (single source OR a previous multi-cam) must be
    // fully torn down before we acquire new tracks. _stopVisualizerMirror
    // already cascades into any running screen record.
    if (_mirrorStream || _multiCamState) {
      try { _stopVisualizerMirror(); } catch {}
    }
    // Pair each cam with its same-groupId mic (built-in array). If none
    // exists, the cam goes video-only and the rest still get audio.
    // Resolution comes from the active CAM RES preset — drives both the
    // getUserMedia request and the composite canvas size below.
    const preset = _CAM_RES_PRESETS[_camResolution] || _CAM_RES_PRESETS['720p'];
    const open = await Promise.all(deviceIds.map(async (camId) => {
      const cam = _camDevices.find((d) => d.deviceId === camId);
      const pairedMic = cam && _micDevices.find((m) => m.groupId && m.groupId === cam.groupId);
      const constraints = {
        video: {
          deviceId: { exact: camId },
          width:  { ideal: preset.w },
          height: { ideal: preset.h },
          frameRate: { ideal: 30 },
        },
        audio: pairedMic ? { deviceId: { exact: pairedMic.deviceId } } : false,
      };
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        return { camId, label: cam?.label || 'Camera', stream, hadAudio: !!pairedMic };
      } catch (err1) {
        // Retry video-only — common when the paired mic is busy or denied.
        if (constraints.audio) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: false });
            console.warn('[multi-cam] mic dropped for', cam?.label || camId, '—', err1?.message || err1);
            return { camId, label: cam?.label || 'Camera', stream, hadAudio: false };
          } catch (err2) {
            console.warn('[multi-cam] cam failed:', cam?.label || camId, err2?.message || err2);
            return null;
          }
        }
        console.warn('[multi-cam] cam failed:', cam?.label || camId, err1?.message || err1);
        return null;
      }
    }));
    const cams = open.filter(Boolean);
    if (!cams.length) {
      playSfx?.('error');
      return;
    }
    // Hidden <video> per cam — drawImage needs a video element, not a
    // raw MediaStream. Chromium can SUSPEND rendering for video
    // elements that are off-DOM OR far offscreen (the compositor
    // skips them, so drawImage reads back black). Workaround: park
    // them inside the visualizer wrap (which is always on-screen
    // while REC ROOM is open) at 1×1 with opacity 0. The element is
    // technically rendering — invisibly — so its frame data is
    // actually available to the canvas.
    let _camVideoHost = document.getElementById('visualizer-cam-video-host');
    if (!_camVideoHost) {
      _camVideoHost = document.createElement('div');
      _camVideoHost.id = 'visualizer-cam-video-host';
      _camVideoHost.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;z-index:0;';
      // Park inside the visualizer player wrap so the host moves with
      // the panel and stays "on-screen" as far as the compositor cares.
      // Fall back to document.body if the wrap isn't in the DOM yet.
      const host = visualizerWrapEl || document.body;
      host.appendChild(_camVideoHost);
    }
    const videos = cams.map((c) => {
      const v = document.createElement('video');
      v.autoplay = true;
      v.muted = true;        // we capture mics via Web Audio; the <video> must not play them
      v.playsInline = true;
      v.style.cssText = 'width:1px;height:1px;display:block;';
      v.srcObject = c.stream;
      _camVideoHost.appendChild(v);
      v.play().catch((err) => console.warn('[multi-cam] hidden video play() rejected:', err?.message || err));
      // Diagnostic — fires once the cam pumps its first frame into the
      // hidden video. If this never logs, the canvas will stay black
      // regardless of filters because drawImage has nothing to read.
      v.addEventListener('loadedmetadata', () => {
        console.log('[multi-cam] cam frame source live:', c.label || c.camId, `${v.videoWidth}x${v.videoHeight}`);
      }, { once: true });
      return v;
    });
    // Composite canvas sized by the active CAM RES preset — same number
    // of pixels as the user asked the cam to deliver, so we don't
    // upscale or downscale on the recording pass.
    const COMPOSITE_W = preset.w, COMPOSITE_H = preset.h, FPS = 30;
    const canvas = document.createElement('canvas');
    canvas.width = COMPOSITE_W;
    canvas.height = COMPOSITE_H;
    // Park the composite canvas inside the cam-video host (same opacity-0
    // 1×1 trick we use for the hidden cam <video>s). When the canvas is
    // fully detached from the DOM, Chromium's ctx.filter pipeline drops
    // CSS filter functions (brightness/contrast/saturate/hue) silently
    // — only SVG-filter url() references make it through, and even those
    // fail above 720p. Re-parenting forces the canvas into the renderer
    // tree so every filter applies regardless of res.
    try {
      canvas.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
      _camVideoHost.appendChild(canvas);
    } catch {}
    const ctx = canvas.getContext('2d', { alpha: false });
    const { cols, rows } = _camGridLayout(cams.length);
    const tw = COMPOSITE_W / cols;
    const th = COMPOSITE_H / rows;
    let canceled = false;
    let intervalId = 0;
    const draw = () => {
      if (canceled) return;
      // Two passes: filtered drawImage for the cam tiles, then a
      // clean (unfiltered) pass for the letterbox bg + tile borders
      // so the user's B&W / gamma / hue chain only colors actual
      // camera pixels, not the chrome around them.
      ctx.filter = 'none';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, COMPOSITE_W, COMPOSITE_H);
      // Pass 1 — apply the live cam-filter chain, drawImage each cam.
      let filterStr = 'none';
      try { filterStr = _camFilterMod.getFilterString(); } catch {}
      ctx.filter = filterStr;
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        const vw = v.videoWidth | 0;
        const vh = v.videoHeight | 0;
        if (!vw || !vh) continue;
        const r = Math.floor(i / cols), c = i % cols;
        const tx = c * tw, ty = r * th;
        const sr = vw / vh, dr = tw / th;
        let dw, dh;
        if (sr > dr) { dw = tw; dh = tw / sr; }
        else { dh = th; dw = th * sr; }
        const dx = tx + (tw - dw) / 2;
        const dy = ty + (th - dh) / 2;
        try { ctx.drawImage(v, dx, dy, dw, dh); }
        catch (err) { console.warn('[multi-cam] drawImage threw cam', i, ':', err?.message || err); }
      }
      // Pass 1.5 — LUT grade. Routes the just-drawn composite through
      // a WebGL2 sampler3D, then paints the graded result back onto
      // the same canvas with drawImage. We do this BEFORE borders so
      // the white tile outlines stay pure (LUT can dramatically warp
      // pure whites otherwise).
      try {
        if (_lutApplier) {
          const sel = _camFilterMod.getLut?.() || null;
          // Kick a load when the picker changes — loadFromPath is
          // idempotent against the current key, so re-calling each
          // frame is cheap. The await happens in the background; the
          // next frame after it settles will see hasLut() === true.
          if (sel?.path) {
            if (_lutApplier.getKey() !== sel.path) {
              _lutApplier.loadFromPath(sel.path);
            }
          } else if (_lutApplier.getKey()) {
            _lutApplier.loadFromPath(null);
          }
          if (_lutApplier.hasLut() && sel?.path) {
            const amt = Math.max(0, Math.min(1, (_camFilterMod.getLutAmount?.() ?? 100) / 100));
            if (_lutApplier.applyTo(canvas, amt)) {
              ctx.filter = 'none';
              ctx.drawImage(_lutApplier.getCanvas(), 0, 0, COMPOSITE_W, COMPOSITE_H);
            }
          }
        }
      } catch (err) {
        console.warn('[multi-cam] LUT apply threw:', err?.message || err);
      }
      // Pass 2 — borders unfiltered so the white tile outlines don't
      // pick up the user's B&W / hue settings.
      ctx.filter = 'none';
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2;
      for (let i = 0; i < videos.length; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        const tx = c * tw, ty = r * th;
        ctx.strokeRect(tx + 1, ty + 1, tw - 2, th - 2);
      }
    };
    // setInterval, NOT requestAnimationFrame. The composite canvas is
    // detached from the DOM (we only feed its captureStream into the
    // visible <video>), and Chromium can pause rAF for detached pages
    // — that bug stranded the loop at frame 1 ("draw tick 1 dims=0x0")
    // before the cam's metadata arrived, so the player only ever saw
    // a single black frame. setInterval fires regardless of compositor
    // state, matching what the screen recorder already does for the
    // same reason.
    draw(); // sync first frame so captureStream has data on attach
    intervalId = setInterval(draw, Math.floor(1000 / FPS));
    // Web Audio mix of every cam's mic into one track. Cams that came
    // back without audio simply contribute nothing here.
    let audioCtx = null;
    let mixDest = null;
    const audioNodes = [];
    const audioCams = cams.filter((c) => c.stream.getAudioTracks().length > 0);
    if (audioCams.length) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        mixDest = audioCtx.createMediaStreamDestination();
        for (const c of audioCams) {
          const src = audioCtx.createMediaStreamSource(c.stream);
          // Equal-weight mix — if everyone yells at once it can clip,
          // but matches the user's mental model of "every mic is on".
          src.connect(mixDest);
          audioNodes.push(src);
        }
      } catch (err) {
        console.warn('[multi-cam] audio mix failed:', err?.message || err);
        try { await audioCtx?.close?.(); } catch {}
        audioCtx = null;
        mixDest = null;
      }
    }
    // Assemble the final mirror stream: composite video + mixed audio.
    const composite = canvas.captureStream(FPS);
    const tracks = [composite.getVideoTracks()[0]];
    if (mixDest) {
      const mixTrack = mixDest.stream.getAudioTracks()[0];
      if (mixTrack) tracks.push(mixTrack);
    }
    const finalStream = new MediaStream(tracks.filter(Boolean));
    _mirrorStream = finalStream;
    _multiCamState = {
      cams,
      videos,
      canvas,
      cancel: () => { canceled = true; if (intervalId) { clearInterval(intervalId); intervalId = 0; } },
      audioCtx,
      mixDest,
      audioNodes,
    };
    visualizerVideoEl.srcObject = finalStream;
    visualizerVideoEl.muted = true; // no-op once the Web Audio graph exists
    _updateGainForCurrentMode();     // gain=0 for multi-cam (cam mics route via mixDest)
    if (typeof _setSourceDims === 'function') _setSourceDims(COMPOSITE_W, COMPOSITE_H);
    const _playProm = visualizerVideoEl.play();
    if (_playProm && typeof _playProm.then === 'function') {
      _playProm.then(() => {
        console.log('[multi-cam] visualizerVideoEl playing:',
          visualizerVideoEl.videoWidth + 'x' + visualizerVideoEl.videoHeight,
          'readyState=' + visualizerVideoEl.readyState,
          'paused=' + visualizerVideoEl.paused);
      }).catch((err) => {
        console.warn('[multi-cam] visualizerVideoEl.play() rejected:', err?.message || err);
      });
    }
    // Log captureStream track info — if no video track or settings are
    // 0×0, the canvas isn't being captured properly.
    try {
      const vt = finalStream.getVideoTracks()[0];
      const settings = vt?.getSettings?.() || {};
      console.log('[multi-cam] captureStream:',
        'tracks=' + finalStream.getTracks().length,
        'video=' + finalStream.getVideoTracks().length,
        'audio=' + finalStream.getAudioTracks().length,
        'settings=' + JSON.stringify({ w: settings.width, h: settings.height, fps: settings.frameRate }));
    } catch {}
    visualizerWrapEl?.classList.add('is-mirroring');
    mirrorBtn?.classList.add('is-active');
    if (mirrorBtn) mirrorBtn.textContent = 'MIRROR ON';
    if (visualizerNowEl) {
      const names = cams.map((c) => c.label.split(' ').slice(0, 2).join(' ')).join(' + ');
      visualizerNowEl.textContent = `MIRROR · ${cams.length} CAM${cams.length === 1 ? '' : 'S'} · ${names}`.toUpperCase();
    }
    // New mirror up — pull any WINDOW audio it brings into the mixer.
    try { _renderMixer?.(); } catch {}
    console.log('[multi-cam] started:', {
      cams: cams.length,
      audioTracks: finalStream.getAudioTracks().length,
      videoTracks: finalStream.getVideoTracks().length,
      grid: `${cols}x${rows}`,
    });
    // If the composite track ends (shouldn't normally — it's our canvas)
    // disengage the mirror so the UI doesn't lie.
    const vt = finalStream.getVideoTracks()[0];
    if (vt) vt.addEventListener('ended', _stopVisualizerMirror, { once: true });
    playSfx?.('confirm');
  }

  async function _startVisualizerMirror() {
    if (!visualizerVideoEl) return;
    let src = _mirrorSourceOverride;
    if (!src && window.dash?.visualizerGetVideoSource) {
      try { src = await window.dash.visualizerGetVideoSource(); } catch { src = null; }
    }
    if (!src?.id) { playSfx?.('error'); return; }
    try {
      // chromeMediaSource constraints are legacy/Chromium-specific but
      // remain supported in Electron. Audio is also routed via the same
      // capture so anything in the source plays through here too.
      _mirrorStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            // Max-only constraints. min* forces Chromium to upscale
            // (or fall back to a default 4:3 format) when the source is
            // smaller than the minimum on either axis — which breaks
            // portrait monitors (1080×1920 has width < 1280). Without
            // mins, the desktop-capture path emits at the source's
            // native dimensions, preserving aspect for both landscape
            // and portrait sources.
            maxWidth: 3840,
            maxHeight: 3840,
            maxFrameRate: 60,
          },
        },
      });
    } catch (errAv) {
      // Some sources only allow video capture (no audio loopback for
      // that window). Retry video-only.
      try {
        _mirrorStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: src.id,
              maxWidth: 3840,
              maxHeight: 3840,
              maxFrameRate: 60,
            },
          },
        });
      } catch (errV) {
        console.warn('[visualizer] mirror failed:', errV?.message || errV);
        playSfx?.('error');
        return;
      }
    }
    visualizerVideoEl.srcObject = _mirrorStream;
    // Force-mute the playback element while mirroring — the source
    // audio already plays through the OS speakers, so unmuting here
    // would double it. The MediaStream still carries the audio tracks
    // so MediaRecorder picks them up.
    visualizerVideoEl.muted = true; // no-op once the Web Audio graph exists
    _updateGainForCurrentMode();     // gain=0 for screen mirror (OS plays loopback)
    // Read source dimensions off the track settings ASAP so the wrap
    // can size itself before the first frame paints. loadedmetadata
    // below also fires once the stream produces its first frame, which
    // catches the case where getSettings() returns no dims yet.
    try {
      const settings = _mirrorStream.getVideoTracks()[0]?.getSettings?.() || {};
      if (settings.width && settings.height) {
        _setSourceDims(settings.width, settings.height);
      }
    } catch {}
    visualizerVideoEl.play().catch(() => {});
    visualizerWrapEl?.classList.add('is-mirroring');
    mirrorBtn?.classList.add('is-active');
    if (mirrorBtn) mirrorBtn.textContent = 'MIRROR ON';
    // Compute a reduced aspect-ratio label (e.g. 1920×1080 → 16:9,
    // 2560×1080 → 64:27 ~ 21:9). Snap to common monitor ratios so the
    // label reads cleanly even when capture rounds dims by a pixel.
    const _dimsLabel = () => {
      const s = _mirrorStream?.getVideoTracks()[0]?.getSettings?.() || {};
      const w = s.width | 0, h = s.height | 0;
      if (!w || !h) return '';
      return ` · ${w}×${h} (${_aspectLabel(w, h)})`;
    };
    if (visualizerNowEl) {
      visualizerNowEl.textContent = `MIRROR · ${src.name || 'source'}${_dimsLabel()}`.toUpperCase();
      // Settings may be empty until loadedmetadata; re-paint the line
      // once the dims actually arrive so the user sees a real ratio.
      const _refreshNow = () => {
        if (!visualizerNowEl) return;
        visualizerNowEl.textContent = `MIRROR · ${src.name || 'source'}${_dimsLabel()}`.toUpperCase();
      };
      visualizerVideoEl.addEventListener('loadedmetadata', _refreshNow, { once: true });
    }
    // Pin the active source so the strip button lights up — covers the
    // auto-pick case (MIRROR clicked with no explicit selection), where
    // _mirrorSourceOverride was null before this call.
    _mirrorSourceOverride = { id: src.id, name: src.name };
    try { _renderSourceStrip?.(); } catch {}
    // New source up — pull any WINDOW audio it brings into the mixer.
    try { _renderMixer?.(); } catch {}
    // If the captured stream ends (window closed, user revoked share),
    // auto-disengage so the UI doesn't lie about being live.
    const track = _mirrorStream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', _stopVisualizerMirror, { once: true });
  }
  mirrorBtn?.addEventListener('click', async () => {
    if (_mirrorStream) {
      _stopVisualizerMirror();
      playSfx?.('click');
    } else {
      await _startVisualizerMirror();
      playSfx?.('confirm');
    }
  });

  // ── URL playback mirror ──────────────────────────────────────────
  // Sets videoEl.src directly (no desktopCapturer) and uses
  // captureStream() to surface the playing video as a MediaStream so
  // the rec pipeline records the exact pixels and audio the user sees.
  // Native HTML5 controls (play/pause/scrub/volume) work for free.
  // Aspect is driven off the loaded video's intrinsic dimensions, so
  // portrait sources render tall + narrow automatically.
  async function _startUrlMirror(rawUrl) {
    if (!visualizerVideoEl) return;
    const url = String(rawUrl || '').trim();
    if (!url) { playSfx?.('error'); return; }
    // Tear down anything else holding the video element first — a
    // prior screen mirror, multi-cam composite, or a previous URL
    // session — so srcObject and src don't fight.
    if (_mirrorStream || _multiCamState) {
      try { _stopVisualizerMirror(); } catch {}
    }
    visualizerVideoEl.srcObject = null;
    // URL audio plays through the page (not OS loopback). _applyPreviewMute
    // below resolves to !stealth — if STEALTH is on, no speaker output;
    // captureStream still emits the audio tracks for the recording.
    _urlMirrorActive = true; // flag set early so _applyPreviewMute uses URL rules
    // URL captures default to STEALTH ON per user spec: the user
    // already knows what the video is (they pasted the URL), so the
    // assumption is "obscure the preview by default, toggle to view".
    // Idempotent — _setStealth(true) on a wrap that's already in
    // stealth is a no-op visually and just rewrites config.
    if (!_stealthOn) _setStealth(true);
    _applyPreviewMute();
    // Do NOT set crossOrigin='anonymous' — that forces a CORS request,
    // and on servers without CORS headers (common for random hosted
    // video files) the load fails entirely. Without the attribute,
    // playback works opaque; only canvas drawImage of the frames would
    // be blocked, which we don't do here.
    visualizerVideoEl.removeAttribute('crossorigin');
    visualizerVideoEl.src = url;
    // Resolve once the video either produces a frame or errors out.
    const ready = new Promise((resolve, reject) => {
      const onMeta = () => { cleanup(); resolve(); };
      const onErr  = () => {
        cleanup();
        const err = visualizerVideoEl.error;
        reject(new Error(err ? `code ${err.code}: ${err.message || 'media error'}` : 'load failed'));
      };
      const cleanup = () => {
        visualizerVideoEl.removeEventListener('loadedmetadata', onMeta);
        visualizerVideoEl.removeEventListener('error', onErr);
      };
      visualizerVideoEl.addEventListener('loadedmetadata', onMeta, { once: true });
      visualizerVideoEl.addEventListener('error', onErr, { once: true });
    });
    try {
      await ready;
    } catch (err) {
      console.warn('[url-mirror] failed:', err?.message || err);
      _urlMirrorActive = false;
      visualizerVideoEl.removeAttribute('src');
      try { visualizerVideoEl.load(); } catch {}
      if (visualizerNowEl) visualizerNowEl.textContent = `URL ERROR · ${err?.message || 'load failed'}`.toUpperCase();
      playSfx?.('error');
      return;
    }
    // Lazy-init the Web Audio graph. Once running, the videoEl audio
    // is fully managed by us — that's what lets STEALTH gate the
    // speakers without affecting the recording dest.
    const graphReady = _ensureAudioGraph();
    if (_audioCtx?.state === 'suspended') {
      try { await _audioCtx.resume(); } catch {}
    }
    _updateGainForCurrentMode();
    // Build the recording stream: VIDEO from captureStream (the
    // element's frame source), AUDIO from the Web Audio dest (which
    // sees the raw decoded samples before they hit the gain). With
    // this split, stealth can zero the speaker gain without the
    // recording ever going silent.
    let videoCapture = null;
    try {
      videoCapture = visualizerVideoEl.captureStream
        ? visualizerVideoEl.captureStream()
        : visualizerVideoEl.mozCaptureStream?.();
    } catch (err) {
      console.warn('[url-mirror] captureStream threw:', err?.message || err);
    }
    const videoTracks = videoCapture?.getVideoTracks?.() || [];
    const audioTracks = graphReady
      ? (_recAudioDest?.stream?.getAudioTracks?.() || [])
      : (videoCapture?.getAudioTracks?.() || []); // fallback if Web Audio refused
    console.log('[url-mirror] assembled stream:',
      'video=' + videoTracks.length,
      'audio=' + audioTracks.length,
      'graph=' + graphReady,
      'ctx=' + _audioCtx?.state);
    if (videoTracks.length || audioTracks.length) {
      _mirrorStream = new MediaStream([...videoTracks, ...audioTracks]);
    } else {
      _mirrorStream = null;
    }
    visualizerVideoEl.play().catch((err) => {
      console.warn('[url-mirror] play() rejected:', err?.message || err);
    });
    // Source dims drive the wrap aspect — _refreshWrapShape reads
    // _lastSourceW/H. We also have a global loadedmetadata listener
    // that does this, but call it explicitly here so the player
    // resizes before the first painted frame.
    if (visualizerVideoEl.videoWidth && visualizerVideoEl.videoHeight) {
      if (typeof _setSourceDims === 'function') {
        _setSourceDims(visualizerVideoEl.videoWidth, visualizerVideoEl.videoHeight);
      }
    }
    visualizerWrapEl?.classList.add('is-mirroring', 'is-url-mirror');
    _refreshStealthOverlay(); // URL mirror is now live → overlay if stealth is on
    mirrorBtn?.classList.add('is-active');
    if (mirrorBtn) mirrorBtn.textContent = 'MIRROR ON';
    if (visualizerNowEl) {
      const short = url.length > 56 ? `…${url.slice(-55)}` : url;
      const w = visualizerVideoEl.videoWidth | 0;
      const h = visualizerVideoEl.videoHeight | 0;
      const dims = (w && h) ? ` · ${w}×${h} (${_aspectLabel(w, h)})` : '';
      visualizerNowEl.textContent = `URL · ${short}${dims}`.toUpperCase();
    }
    // DO NOT auto-stop on captureStream track 'ended' — that event
    // fires spuriously on buffer-stalls and CORS-tainted streams, and
    // would yank the mirror out from under the user mid-watch. The
    // user has explicit STOP via the MIRROR button; a real natural
    // end-of-video is signaled by the video element's own 'ended'
    // event, which file-playback code handles separately.
    try { _renderMixer?.(); } catch {}
    playSfx?.('confirm');
  }
  sourceUrlGoBtn?.addEventListener('click', () => {
    _startUrlMirror(sourceUrlEl?.value || '');
  });
  sourceUrlEl?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      _startUrlMirror(sourceUrlEl.value || '');
    }
  });

  // ── Inline source strip ──────────────────────────────────────────
  // Replaces the old fullscreen picker. Each available SCREEN / WINDOW
  // / CAM gets its own button in the toolbar. Screens + windows are
  // single-select (clicking starts mirror with that source); cams are
  // multi-select toggles (each click adds/removes from the composite
  // and auto-applies). The currently-active source(s) get .is-active.
  let _availableSources = [];

  // Enumerate cams (and pair each with its same-groupId mic) so the
  // strip can show one button per cam. Labels are empty until any
  // getUserMedia grant lands, so we probe once if needed.
  async function _refreshCamList() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch {}
    let cams = devices.filter((d) => d.kind === 'videoinput');
    if (cams.length && cams.every((c) => !c.label)) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        for (const t of probe.getTracks()) { try { t.stop(); } catch {} }
        devices = await navigator.mediaDevices.enumerateDevices();
        cams = devices.filter((d) => d.kind === 'videoinput');
      } catch (err) {
        console.warn('[rec-room] cam label probe failed:', err?.message || err);
      }
    }
    _camDevices = cams;
    _micDevices = devices.filter((d) => d.kind === 'audioinput');
    const camIds = new Set(cams.map((c) => c.deviceId));
    for (const id of [..._camPicked]) if (!camIds.has(id)) _camPicked.delete(id);
  }
  function _renderSourceStrip() {
    if (!sourceStripEl) return;
    // Remove any previously-rendered source buttons; keep the SCAN pill
    // at the front so the user always has a "rescan" affordance.
    for (const el of sourceStripEl.querySelectorAll('.vis-source-btn')) el.remove();
    const activeId = _mirrorSourceOverride?.id || null;
    const screens = _availableSources.filter((s) => s.kind === 'screen');
    const windows = _availableSources.filter((s) => s.kind !== 'screen');
    screens.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    windows.sort((a, b) => {
      const ak = (a.appName || '') + ' ' + (a.name || '');
      const bk = (b.appName || '') + ' ' + (b.name || '');
      return ak.localeCompare(bk);
    });
    const makeBtn = (label, title, dataset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'explore-action vis-source-btn';
      btn.textContent = label;
      btn.title = title;
      for (const [k, v] of Object.entries(dataset)) btn.dataset[k] = v;
      return btn;
    };
    for (const s of screens) {
      const safe = String(s.name || 'Screen');
      const btn = makeBtn(
        `SCR · ${safe.length > 18 ? safe.slice(0, 17) + '…' : safe}`,
        `Mirror screen: ${safe}`,
        { kind: 'desktop', id: s.id, name: s.name },
      );
      if (s.id === activeId) btn.classList.add('is-active');
      sourceStripEl.appendChild(btn);
    }
    for (const w of windows) {
      const safe = String(w.name || 'Window');
      const tag  = (w.appName || 'WIN').toUpperCase().slice(0, 8);
      const btn  = makeBtn(
        `${tag} · ${safe.length > 18 ? safe.slice(0, 17) + '…' : safe}`,
        `Mirror window: ${safe}`,
        { kind: 'desktop', id: w.id, name: w.name },
      );
      if (w.id === activeId) btn.classList.add('is-active');
      sourceStripEl.appendChild(btn);
    }
  }
  function _renderCamStrip() {
    if (!camStripBodyEl) return;
    camStripBodyEl.innerHTML = '';
    if (!_camDevices.length) {
      const empty = document.createElement('div');
      empty.className = 'visualizer-cam-strip-empty';
      empty.textContent = 'NO CAMERAS DETECTED · CLICK SCAN';
      camStripBodyEl.appendChild(empty);
      return;
    }
    _camDevices.forEach((d, i) => {
      const safe = String(d.label || `Cam ${i + 1}`);
      const pairedMic = _micDevices.find((m) => m.groupId && m.groupId === d.groupId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'explore-action vis-source-btn vis-source-cam';
      if (_camPicked.has(d.deviceId)) btn.classList.add('is-active');
      btn.dataset.kind = 'cam';
      btn.dataset.id   = d.deviceId;
      btn.textContent  = safe.length > 22 ? safe.slice(0, 21) + '…' : safe;
      btn.title = `Toggle camera: ${safe}` + (pairedMic ? ` · mic: ${pairedMic.label || 'paired'}` : ' · no paired mic');
      camStripBodyEl.appendChild(btn);
    });
  }
  async function _refreshSourceStrip() {
    // Desktop sources + cams are independent — fetch in parallel.
    const [sources] = await Promise.all([
      window.dash?.visualizerListSources?.().catch(() => []) ?? Promise.resolve([]),
      _refreshCamList().catch(() => {}),
    ]);
    _availableSources = Array.isArray(sources) ? sources : [];
    _renderSourceStrip();
    _renderCamStrip();
  }

  sourceScanBtn?.addEventListener('click', () => {
    _refreshSourceStrip();
    playSfx?.('click');
  });
  sourceStripEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.vis-source-btn');
    if (!btn) return;
    // Single-select: pick this screen/window as the new mirror source.
    // Clear any cam picks so we don't have stale composite state.
    _mirrorSourceOverride = { id: btn.dataset.id, name: btn.dataset.name };
    _camPicked.clear();
    if (_mirrorStream) {
      for (const tr of _mirrorStream.getTracks()) { try { tr.stop(); } catch {} }
      _mirrorStream = null;
      if (visualizerVideoEl) visualizerVideoEl.srcObject = null;
    }
    _renderSourceStrip();
    _renderCamStrip();
    await _startVisualizerMirror();
    playSfx?.('confirm');
  });
  camStripBodyEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.vis-source-btn');
    if (!btn) return;
    // Multi-select toggle: add/remove this cam from the composite and
    // re-apply on every change. Switching to cam mode clears any
    // screen/window override so they're not double-active.
    const id = btn.dataset.id;
    if (_camPicked.has(id)) _camPicked.delete(id);
    else _camPicked.add(id);
    _mirrorSourceOverride = null;
    if (_camPicked.size === 0) {
      _stopVisualizerMirror();
    } else {
      await _startMultiCamMirror([..._camPicked]);
    }
    _renderSourceStrip();
    _renderCamStrip();
    playSfx?.('click');
  });
  // Initial fill — runs once the visualizer module wires up. Errors are
  // swallowed so a missing IPC handler (older main) doesn't break init.
  _refreshSourceStrip().catch(() => {});

  // ── Camera resolution presets ─────────────────────────────────────
  // Buttons in the cam strip select a CAM RES preset. Picking one
  // while cams are running re-acquires them at the new resolution.
  const camResEl = document.getElementById('visualizer-cam-res');
  function _paintCamResButtons() {
    if (!camResEl) return;
    for (const b of camResEl.querySelectorAll('[data-camres]')) {
      b.classList.toggle('is-active', b.dataset.camres === _camResolution);
    }
  }
  async function _applyCamResolution(key, opts = {}) {
    if (!_CAM_RES_PRESETS[key]) return;
    if (key === _camResolution && !opts.force) return;
    _camResolution = key;
    _paintCamResButtons();
    try { window.dash?.setConfig?.({ recRoomCamResolution: key }); } catch {}
    // Re-acquire ONLY if a cam mirror is currently live. Using
    // _camPicked here was wrong — it's the user's persistent selection
    // memory, so clicking a resolution would start the cam even when
    // the user had toggled it off (just because their selection
    // history still listed the id). Source the device list from the
    // active _multiCamState so resolution is purely a stream-swap and
    // never a start/stop.
    if (_multiCamState && _multiCamState.cams?.length) {
      const liveIds = _multiCamState.cams.map((c) => c.camId).filter(Boolean);
      if (liveIds.length) {
        try { await _startMultiCamMirror(liveIds); }
        catch (err) { console.warn('[cam-res] re-acquire failed:', err?.message || err); }
      }
    }
  }
  camResEl?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-camres]');
    if (!b) return;
    _applyCamResolution(b.dataset.camres);
    playSfx?.('confirm');
  });
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    const saved = typeof cfg.recRoomCamResolution === 'string' ? cfg.recRoomCamResolution : null;
    if (saved && _CAM_RES_PRESETS[saved]) _camResolution = saved;
    _paintCamResButtons();
  })();

  // ── CAM filters ───────────────────────────────────────────────────
  // Lives in ./rec/cam-filters.js. Owns the CSS filter sliders + SVG
  // gamma curve for the multi-cam composite canvas. getFilterString()
  // returns the string the composite draw loop assigns to ctx.filter.
  const _camFilterMod = setupCamFilters({ playSfx });
  // WebGL2 3D-LUT applier — re-grades the composite each frame when
  // the user has a .cube selected. Null if WebGL2 is unavailable.
  // Lazy-loads the LUT texture when the picker selection changes.
  const _lutApplier = setupLutApplier();

  // ── Screencap: input-driven JPEG capture ─────────────────────────
  // Lives in ./rec/screencap.js. getMirror() lets the module read the
  // current mirror state without pulling state directly across files.
  setupScreencap({
    playSfx,
    visualizerVideoEl,
    screencapBtn,
    getMirror: () => ({ stream: _mirrorStream, override: _mirrorSourceOverride }),
  });


  // ── Recording quality profiles ───────────────────────────────────
  // Lives in ./rec/profiles.js. Returns getters the screen recorder
  // calls when it spawns ffmpeg.
  const _profiles = setupProfiles({ playSfx });

  // ── Free-capture crop region ─────────────────────────────────────
  // Lives in ./rec/crop.js. The screen recorder reads getActive() +
  // getRect() in its frame loop; the playback handler calls
  // deactivate() to drop the crop when starting a recorded file.
  const _crop = setupCrop({
    playSfx,
    visualizerWrapEl,
    refreshWrapShape: _refreshWrapShape,
  });

  // ── KEYS + OSD overlays ───────────────────────────────────────────
  // Lives in ./rec/overlays.js. Recording-only paints; the screen
  // recorder calls drawKeys/drawOsd in its frame loop and uses the
  // is*On() getters to decide on the no-canvas fast path.
  const _overlays = setupOverlays({ playSfx });

  // ── Screen record: continuous video capture to gallery/recordings/ ─
  // Live OBS-style pipe — renderer pumps raw I420 video frames + raw
  // f32le PCM straight to a long-running ffmpeg child (NVENC-encoded,
  // +faststart MP4). See feedback_screenrec_pipeline.md memory for
  // the full architecture notes. Stops automatically if the mirror is
  // torn down.
  const screenrecBtn = document.getElementById('visualizer-screenrec-btn');
  const pcmBtn       = document.getElementById('visualizer-pcm-btn');
  let _screenrecState = null; // { id, mixerNodes, cancelPumps, getPendingWrites, getStats, finalTeardown }
  let _pcmRec = null;         // audio-only record: { id, audio, pending: [] }
  // Build a recording-target MediaStream from the live mirror, applying
  // (a) the free-capture crop region if active and (b) the active
  // quality profile's resolution. With no crop and no downscale we
  // hand back the mirror stream as-is. Otherwise we drawImage(source
  // region → output canvas) every frame and captureStream() the canvas;
  // audio tracks from the mirror are mixed in so recordings keep sound.
  function _buildRecorderStream() {
    if (!_mirrorStream) return null;
    const vTrack = _mirrorStream.getVideoTracks()[0];
    const settings = vTrack?.getSettings?.() || {};
    const srcW = settings.width  || visualizerVideoEl?.videoWidth  || 1920;
    const srcH = settings.height || visualizerVideoEl?.videoHeight || 1080;
    const _cr = _crop.getRect();
    const cropOn = _crop.getActive() && _cr.w > 0 && _cr.h > 0;
    let sx = cropOn ? Math.round(_cr.x * srcW) : 0;
    let sy = cropOn ? Math.round(_cr.y * srcH) : 0;
    let sw = cropOn ? Math.round(_cr.w * srcW) : srcW;
    let sh = cropOn ? Math.round(_cr.h * srcH) : srcH;
    // I420 (Chromium's desktopCapturer output format) has chroma
    // planes at half resolution, so `new VideoFrame(src, {visibleRect})`
    // requires sx, sy, sw, sh to all be EVEN — otherwise the U/V
    // sample grid can't align. An odd sx throws TypeError per frame
    // ("x is not sample-aligned in plane 1") and recording stalls.
    sx = sx & ~1;
    sy = sy & ~1;
    sw = Math.max(2, sw & ~1);
    sh = Math.max(2, sh & ~1);
    // After rounding inward, clamp to the source bounds so we never
    // ask for a visibleRect that extends past the frame.
    if (sx + sw > srcW) sw = Math.max(2, (srcW - sx) & ~1);
    if (sy + sh > srcH) sh = Math.max(2, (srcH - sy) & ~1);
    const target = _profiles.getProfile().resolution;
    let outH = sh;
    if (target !== 'source' && typeof target === 'number' && target < sh) outH = target;
    let outW = Math.max(2, Math.round(sw * (outH / sh)));
    // YUV 4:2:0 (the I420 layout we copyTo and ffmpeg ingests) can't
    // represent a fractional final chroma row/column, so the encoder
    // pipeline requires EVEN width + height. Easy to hit when CROP is
    // active: the crop rect's w/h floats round to odd pixel counts. Force
    // both down to even before handing to the track processor.
    outH = Math.max(2, outH - (outH % 2));
    outW = Math.max(2, outW - (outW % 2));
    // Fast path: no crop, no downscale, no overlays → hand original
    // through. Any overlay (keys / OSD) needs the canvas so the overlay
    // is drawn into the recording without appearing in the preview.
    const keysOn = _overlays.isKeysOn();
    const osdOn  = _overlays.isOsdAnyOn();
    if (!cropOn && outH === srcH && !keysOn && !osdOn) {
      return { stream: _mirrorStream, cleanup: () => {} };
    }
    // Transform fast path: crop AND/OR downscale (no overlays) handled
    // via MediaStreamTrackProcessor + new VideoFrame(src, {visibleRect,
    // displayWidth, displayHeight}). One zero-canvas pass — no canvas,
    // no setInterval, no drawImage. Critical because:
    //   • Dashboard3D goes occluded the moment the user switches focus
    //     to the source app (the whole point of screen recording).
    //   • The downstream live-pipe pump then calls frame.copyTo({format:
    //     'I420'}) on this track's frames. That conversion is reliable
    //     for desktopCapturer-origin frames but NOT for canvas-origin
    //     frames (RGBA→I420 silently fails on canvas-derived VideoFrames
    //     in Chromium), so we MUST keep canvas out of the path for
    //     anything we can do via VideoFrame metadata alone.
    const needsTransform = cropOn || outH !== srcH || outW !== srcW;
    const canUseTrackProcessor = typeof MediaStreamTrackProcessor !== 'undefined'
      && typeof MediaStreamTrackGenerator !== 'undefined'
      && typeof VideoFrame !== 'undefined';
    if (needsTransform && !keysOn && !osdOn && canUseTrackProcessor) {
      const sourceTrack = _mirrorStream.getVideoTracks()[0];
      if (sourceTrack) {
        try {
          const _logXform = (line, extra) => {
            try { window.dash?.screenrecLogDiag?.(extra ? `${line} ${JSON.stringify(extra)}` : line); } catch {}
          };
          _logXform('XFORM_OPEN', { sx, sy, sw, sh, outW, outH, srcW, srcH, cropOn });
          const processor = new MediaStreamTrackProcessor({ track: sourceTrack });
          const generator = new MediaStreamTrackGenerator({ kind: 'video' });
          const reader = processor.readable.getReader();
          const writer = generator.writable.getWriter();
          let canceled = false;
          let _drawCount = 0;
          let _xformFirstFrameLogged = false;
          let _xformFirstWriteLogged = false;
          let _xformFailLogged = 0;
          (async () => {
            while (!canceled) {
              let frame;
              try {
                const r = await reader.read();
                if (r.done) { _logXform('XFORM_SOURCE_DONE', { drawCount: _drawCount }); break; }
                frame = r.value;
              } catch (err) {
                _logXform('XFORM_SOURCE_THROW', { error: err?.message || String(err), drawCount: _drawCount });
                break;
              }
              if (!_xformFirstFrameLogged) {
                _xformFirstFrameLogged = true;
                _logXform('XFORM_SOURCE_FIRST_FRAME', {
                  codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
                  visibleRect: frame.visibleRect && { x: frame.visibleRect.x, y: frame.visibleRect.y, width: frame.visibleRect.width, height: frame.visibleRect.height },
                  format: frame.format,
                });
              }
              try {
                // visibleRect = crop region (full source when CROP is
                // off). displayWidth/Height = output size (downscale
                // when the profile caps below source, otherwise same
                // as visibleRect dims). Both crop and LITE downscale
                // ride this single path.
                const cropped = new VideoFrame(frame, {
                  visibleRect: { x: sx, y: sy, width: sw, height: sh },
                  displayWidth:  outW,
                  displayHeight: outH,
                });
                frame.close();
                await writer.write(cropped);
                _drawCount++;
                if (!_xformFirstWriteLogged) {
                  _xformFirstWriteLogged = true;
                  _logXform('XFORM_FIRST_WRITE', { outW, outH });
                }
              } catch (err) {
                try { frame.close(); } catch {}
                if (_xformFailLogged < 3) {
                  _xformFailLogged++;
                  _logXform('XFORM_FRAME_FAIL', { error: err?.message || String(err), name: err?.name });
                }
              }
            }
          })();
          return {
            stream: new MediaStream([generator]),
            cleanup: () => {
              canceled = true;
              try { reader.cancel(); } catch {}
              try { writer.close(); } catch {}
              try { generator.stop(); } catch {}
            },
            getDrawCount: () => _drawCount,
          };
        } catch (err) {
          console.warn('[screenrec] track processor unavailable, falling back to canvas', err?.message || err);
          // fall through to canvas path
        }
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    let canceled = false;
    // Driver = setInterval (NOT requestAnimationFrame). For screen
    // recording the user MUST switch focus away from Dashboard3D to
    // record another app, which puts Dashboard3D fully behind/occluded;
    // Chromium then pauses rAF for that renderer (even with the main
    // BrowserWindow's `backgroundThrottling: false`, occlusion-based
    // pauses still kick in on some setups). setInterval keeps firing
    // on a wall-clock timer regardless of compositor state, so the
    // canvas keeps getting drawn and captureStream keeps producing
    // frames. The A/V sync work we did (SCHED_AHEAD=0 in the loopback
    // + `-af asetpts=PTS-0.4/TB` in the ffmpeg transcode) compensates
    // for setInterval's small timing irregularity vs source frames.
    const recFps = Math.max(1, Number(_profiles.getFps()) || 30);
    const frameInterval = 1000 / recFps;
    let _drawCount = 0;
    const draw = () => {
      if (canceled) return;
      if (visualizerVideoEl && visualizerVideoEl.readyState >= 2) {
        try {
          ctx.drawImage(visualizerVideoEl, sx, sy, sw, sh, 0, 0, outW, outH);
          _drawCount++;
        } catch {}
      }
      if (_overlays.isKeysOn())   _overlays.drawKeys(ctx, outW, outH);
      if (_overlays.isOsdAnyOn()) _overlays.drawOsd(ctx, outW, outH);
      _overlays.trackFps();
    };
    draw(); // synchronous initial frame so captureStream has data on attach
    const intervalId = setInterval(draw, frameInterval);
    const out = canvas.captureStream(recFps);
    // Intentionally NO mirror audio attach here. Audio is the mixer
    // bus's exclusive job — adding mirror audio tracks on top of the
    // mixer was one of the paths that gave us the double-audio echo.
    return {
      stream: out,
      cleanup: () => {
        canceled = true;
        clearInterval(intervalId);
      },
      getDrawCount: () => _drawCount,
    };
  }
  // Build a MediaStream audio track from the WASAPI loopback worker.
  // The audify worker (already running for the audio visualizer) is
  // pushed into PCM-forwarding mode for the duration of recording; each
  // batched chunk is wrapped in an AudioBuffer and scheduled into a
  // MediaStreamDestination, whose track we hand back. The destination
  // node is NOT connected to the speakers — the user hears the source
  // app directly through the OS, this path only exists to feed the
  // MediaRecorder. Returns { track, teardown } or null on failure.
  async function _buildLoopbackAudioTrack() {
    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (err) {
      console.warn('[screenrec] AudioContext failed:', err?.message || err);
      return null;
    }
    // Same autoplay-policy hedge as _buildMixerPcmTap — the loopback's
    // BufferSource scheduling depends on this context running.
    try { await ctx.resume(); }
    catch (err) { console.warn('[screenrec] loopback ctx.resume() failed:', err?.message || err); }
    const dest = ctx.createMediaStreamDestination();
    // Scheduling-ahead margin. 60 ms → user reported audio lagging
    // video. 15 ms → still slightly out. 0 → each PCM chunk plays at
    // `ctx.currentTime` (or later if its scheduled slot already passed).
    // This eliminates the constant audio-vs-video offset in the
    // recording. Risk: if a PCM event arrives late (>43 ms after the
    // previous chunk's slot ended), there's a brief audible gap — but
    // that's acceptable for recordings, and the audify worker batches
    // tightly enough that this should be rare.
    // Scheduling-ahead margin = constant audio-behind-video offset in
    // the recording. 60 ms → "slightly out". 30 → "still behind".
    // 10 → "very close, but still off". 0 → audio plays the moment the
    // PCM event arrives. Tiny risk of audible underrun on the very
    // first chunk if AudioContext's clock hasn't caught up yet, but
    // that's an acceptable trade for genuine lipsync.
    const SCHED_AHEAD = 0;
    let nextStart = 0;
    let chunkCount = 0;
    const handler = (data) => {
      if (!data?.pcm) return;
      const samples = data.pcm;
      const ch = Math.max(1, data.channels | 0 || 2);
      const sr = data.sampleRate | 0 || ctx.sampleRate;
      const frames = (samples.length / ch) | 0;
      if (frames < 1) return;
      let buf;
      try { buf = ctx.createBuffer(ch, frames, sr); }
      catch { return; }
      for (let c = 0; c < ch; c++) {
        const cd = buf.getChannelData(c);
        for (let i = 0; i < frames; i++) cd[i] = samples[i * ch + c];
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      const now = ctx.currentTime;
      if (nextStart < now + SCHED_AHEAD) nextStart = now + SCHED_AHEAD;
      try { src.start(nextStart); } catch {}
      nextStart += buf.duration;
      chunkCount++;
    };
    const unsub = window.dash?.onLoopbackPcm?.(handler) || (() => {});
    try { await window.dash?.setLoopbackPcm?.(true); }
    catch (err) {
      console.warn('[screenrec] setLoopbackPcm(true) failed:', err?.message || err);
      try { unsub(); } catch {}
      try { await ctx.close(); } catch {}
      return null;
    }
    const track = dest.stream.getAudioTracks()[0];
    if (!track) {
      try { unsub(); } catch {}
      try { await window.dash?.setLoopbackPcm?.(false); } catch {}
      try { await ctx.close(); } catch {}
      return null;
    }
    return {
      track,
      teardown: async () => {
        try { unsub(); } catch {}
        try { await window.dash?.setLoopbackPcm?.(false); } catch {}
        try { dest.disconnect(); } catch {}
        try { track.stop(); } catch {}
        try { await ctx.close(); } catch {}
        console.log('[screenrec] loopback teardown — chunks:', chunkCount);
      },
    };
  }

  // Build the live PCM tap that feeds the recorder's audio pipe.
  // Spins up a single AudioContext, attaches each enabled source
  // (system loopback / mic / window-audio) through its own GainNode +
  // AnalyserNode, sums them through a master gain, and routes the sum
  // into an inline AudioWorklet whose only job is to post each block
  // of mixed Float32 interleaved PCM out the worklet port. Gain nodes
  // are returned in `nodes` so the mixer sliders can hot-apply volume
  // changes mid-recording (see _renderMixer reading
  // _screenrecState.mixerNodes[kind].gain.gain.value) and the meter
  // UI keeps reading from nodes[kind].analyser unchanged.
  async function _buildMixerPcmTap(tapOpts = {}) {
    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (err) { console.warn('[mixer] AudioContext failed:', err?.message || err); return null; }
    // Force the context out of 'suspended' state. The new pipeline
    // routes the worklet through ctx.destination (silenced via a gain=0
    // node) so Chromium considers the graph alive — but if autoplay
    // policy parked the context after the long async chain inside
    // _startScreenrec, the worklet's process() never fires and ffmpeg
    // gets EOF on the audio pipe at stop (= zero-audio MP4).
    try { await ctx.resume(); }
    catch (err) { console.warn('[mixer] ctx.resume() failed:', err?.message || err); }

    // Inline AudioWorklet via Blob URL — taps the post-mix bus and
    // posts batched Float32 interleaved PCM to the main thread. Batch
    // size ~1024 frames (~21 ms at 48 kHz) so we send ~50 messages/sec
    // instead of one-per-128-frame quantum (~375/s).
    const workletCode = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._batch = null;
    this._offset = 0;
    this._target = 1024;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0] || input[0].length === 0) return true;
    const ch = input.length;
    const frames = input[0].length;
    if (!this._batch) {
      this._batch = new Float32Array(this._target * ch);
      this._offset = 0;
    }
    const need = this._batch.length / ch;
    for (let f = 0; f < frames; f++) {
      const o = (this._offset + f) * ch;
      for (let c = 0; c < ch; c++) this._batch[o + c] = input[c][f];
    }
    this._offset += frames;
    if (this._offset >= need) {
      this.port.postMessage(this._batch, [this._batch.buffer]);
      this._batch = null;
      this._offset = 0;
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;
    let workletUrl;
    try {
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(workletUrl);
    } catch (err) {
      console.warn('[mixer] worklet addModule failed:', err?.message || err);
      try { if (workletUrl) URL.revokeObjectURL(workletUrl); } catch {}
      try { await ctx.close(); } catch {}
      return null;
    }
    const CHANNELS = 2;
    const tap = new AudioWorkletNode(ctx, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1, // 1 silent output keeps the graph "active"
      channelCount: CHANNELS,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    let onPcm = null;
    tap.port.onmessage = (e) => { if (onPcm) onPcm(e.data); };

    // Master mix bus + silent fan-out so Chromium considers the
    // graph reachable (some Chromium versions skip processing for
    // worklets whose only "output" is the port).
    const master = ctx.createGain();
    master.connect(tap);
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    tap.connect(silentSink).connect(ctx.destination);

    const nodes = {};
    const teardowns = [];
    const _makeAnalyser = () => {
      const a = ctx.createAnalyser();
      a.fftSize = 512;
      a.smoothingTimeConstant = 0.35;
      return a;
    };

    // forceSystem (PCM audio-only record) captures system loopback even
    // when the SOUND toggle is off, so the "record the audio" button
    // works without the user first arming SOUND.
    if (_recCaptureAudio || tapOpts.forceSystem) {
      const lp = await _buildLoopbackAudioTrack();
      if (lp?.track) {
        const ms = new MediaStream([lp.track]);
        const src = ctx.createMediaStreamSource(ms);
        const gain = ctx.createGain();
        const analyser = _makeAnalyser();
        gain.gain.value = _mixer.system.muted ? 0 : _mixer.system.vol / 100;
        src.connect(gain).connect(master);
        gain.connect(analyser);
        nodes.system = { src, gain, analyser };
        teardowns.push(async () => { try { await lp.teardown?.(); } catch {} });
      }
    }

    if (_recCaptureMic) {
      try {
        // Mic constraints: keep echoCancellation OFF so the EC algorithm
        // doesn't subtract system-loopback content from the mic (we're
        // recording both simultaneously; cancelling overlap would gut the
        // mic). noiseSuppression OFF so the user's recording stays raw.
        // autoGainControl IS ON — without it, a quietly-configured
        // Windows mic produces near-silent recordings even at slider 100.
        const ms = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
        const tracks = ms.getAudioTracks();
        if (!tracks.length) {
          console.warn('[mixer] mic getUserMedia returned a stream with no audio tracks');
        } else {
          const t0 = tracks[0];
          const settings = t0.getSettings?.() || {};
          console.log('[mixer] mic attached:', { label: t0.label || '(no label)', deviceId: settings.deviceId, sampleRate: settings.sampleRate, channelCount: settings.channelCount, readyState: t0.readyState, muted: t0.muted });
          if (t0.muted) {
            if (visualizerNowEl) visualizerNowEl.textContent = `MIC MUTED AT OS · check Windows mic privacy`;
            console.warn('[mixer] mic track is OS-muted — Windows mic privacy or device-level mute is blocking capture');
          }
        }
        const src = ctx.createMediaStreamSource(ms);
        const gain = ctx.createGain();
        const analyser = _makeAnalyser();
        gain.gain.value = _mixer.mic.muted ? 0 : _mixer.mic.vol / 100;
        src.connect(gain).connect(master);
        gain.connect(analyser);
        nodes.mic = { src, gain, analyser };
        teardowns.push(() => { for (const t of ms.getTracks()) { try { t.stop(); } catch {} } });
      } catch (err) {
        const msg = err?.message || err?.name || 'unknown';
        console.warn('[mixer] mic getUserMedia failed:', msg, err);
        if (visualizerNowEl) visualizerNowEl.textContent = `MIC FAILED · ${msg}`;
      }
    }

    // Window audio: only if the chosen mirror source emits an audio
    // track AND system loopback isn't already capturing it.
    //
    // CRITICAL — the double-audio trap (regressed three times):
    //   When you mirror a window/screen that plays sound, the OS is
    //   playing that sound through the speakers. WASAPI loopback grabs
    //   *everything* coming out of the speakers, INCLUDING the source
    //   window's audio. getDisplayMedia({audio:true}) ALSO exposes that
    //   window's audio as a separate MediaStream track. Mixing both in
    //   gives you the same audio twice, ~tens-of-ms apart → audible echo
    //   on every recording.
    //
    // Policy: system loopback wins. If the loopback attached, drop the
    // window-audio track entirely (system already covers it). Window
    // audio only attaches on the loopback-disabled path (recCaptureAudio
    // off, or loopback build failed — e.g., Linux build).
    const winTracks = _mirrorStream?.getAudioTracks?.() || [];
    // Normally we drop window-audio when system loopback attached
    // (loopback is hearing the same speakers anyway → echo). EXCEPTION:
    // URL mirror under STEALTH — the gain in the Web Audio graph is at
    // 0 there, so the speakers are silent and system loopback is NOT
    // capturing the URL audio. The window track from our Web Audio
    // dest IS the URL audio, and it must attach or the recording goes
    // silent. The two sources won't conflict because they're carrying
    // different content (system = OS sounds; window = URL grade).
    const isStealthUrl = _urlMirrorActive && _stealthOn;
    const attachWindow = winTracks.length && (!nodes.system || isStealthUrl);
    if (attachWindow) {
      try {
        const ms = new MediaStream(winTracks);
        const src = ctx.createMediaStreamSource(ms);
        const gain = ctx.createGain();
        const analyser = _makeAnalyser();
        gain.gain.value = _mixer.window.muted ? 0 : _mixer.window.vol / 100;
        src.connect(gain).connect(master);
        gain.connect(analyser);
        nodes.window = { src, gain, analyser };
        console.log('[mixer] window-audio attached:', winTracks.length, 'tracks · stealthUrl=' + isStealthUrl);
      } catch (err) {
        console.warn('[mixer] window-audio attach failed:', err?.message || err);
      }
    } else if (winTracks.length && nodes.system) {
      console.log('[mixer] skipping window-audio (' + winTracks.length + ' track) — already covered by system loopback');
    } else if (!winTracks.length) {
      console.log('[mixer] no window-audio tracks in _mirrorStream');
    }

    if (!Object.keys(nodes).length) {
      // No sources actually produced audio.
      try { tap.port.onmessage = null; } catch {}
      try { silentSink.disconnect(); } catch {}
      try { tap.disconnect(); } catch {}
      try { master.disconnect(); } catch {}
      try { URL.revokeObjectURL(workletUrl); } catch {}
      try { await ctx.close(); } catch {}
      return null;
    }
    return {
      ctx,
      nodes,
      sampleRate: ctx.sampleRate,
      channels: CHANNELS,
      attachOnPcm: (cb) => { onPcm = cb; },
      teardown: async () => {
        onPcm = null;
        try { tap.port.onmessage = null; } catch {}
        try { silentSink.disconnect(); } catch {}
        try { tap.disconnect(); } catch {}
        try { master.disconnect(); } catch {}
        for (const td of teardowns) { try { await td(); } catch {} }
        try { URL.revokeObjectURL(workletUrl); } catch {}
        try { await ctx.close(); } catch {}
      },
    };
  }

  async function _startScreenrec() {
    if (_screenrecState) return;
    if (!_mirrorStream) {
      // Auto-start the mirror so REC works in one click. If that fails, bail.
      await _startVisualizerMirror();
      if (!_mirrorStream) { playSfx?.('error'); return; }
    }
    // Belt-and-suspenders ctx resume — if the URL mirror's audio graph
    // exists but got suspended at any point after startup (Chromium
    // can suspend on long idle, device swap, etc.), _recAudioDest
    // emits no samples and the recording starts silent. The REC
    // button click IS a fresh user gesture, so resume() will succeed.
    // Logged so a recurring "no audio in clip" is traceable.
    if (_audioCtx && _audioCtx.state === 'suspended') {
      console.log('[screenrec] resuming suspended audio ctx before record');
      try { await _audioCtx.resume(); } catch (err) {
        console.warn('[screenrec] audio ctx resume failed:', err?.message || err);
      }
    }
    const built = _buildRecorderStream();
    if (!built?.stream) { playSfx?.('error'); return; }
    const vTrack = built.stream.getVideoTracks()[0];
    if (!vTrack || typeof MediaStreamTrackProcessor === 'undefined' || typeof VideoFrame === 'undefined') {
      console.warn('[screenrec] WebCodecs MediaStreamTrackProcessor unavailable — cannot record');
      try { built.cleanup?.(); } catch {}
      playSfx?.('error');
      if (visualizerNowEl) visualizerNowEl.textContent = 'REC unavailable · WebCodecs missing';
      return;
    }
    // Diagnostic log helper — persists to <gallery>/rec-diagnostic.log
    // so the user has a record on disk even when DevTools is closed.
    const _logDiag = (line, extra) => {
      const msg = extra ? `${line} ${JSON.stringify(extra)}` : line;
      try { window.dash?.screenrecLogDiag?.(msg); } catch {}
    };
    // Audio comes from the MIXER bus — system loopback + mic + any
    // captured-window audio, each through its own GainNode/AnalyserNode
    // (so the sliders/meters keep working), summed into an AudioWorklet
    // PCM tap. Returns null if no source produced audio.
    const audio = await _buildMixerPcmTap();
    const mixerNodeKinds = Object.keys(audio?.nodes || {}).join('+') || 'none';
    const srcKind = _mirrorSourceOverride?.id?.startsWith?.('window:') ? 'window'
                  : _mirrorSourceOverride?.id?.startsWith?.('screen:') ? 'screen'
                  : 'unknown';
    // Open the video processor and read the first frame BEFORE telling
    // main to spawn ffmpeg — that way we can pass real codedWidth/Height
    // (rather than guessing from settings, which may not yet be filled
    // on a freshly-started desktopCapturer track).
    const processor = new MediaStreamTrackProcessor({ track: vTrack });
    const reader = processor.readable.getReader();
    let first;
    try {
      first = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('first frame timeout 3s')), 3000)),
      ]);
    } catch (err) {
      _logDiag('STALL_3S', { reason: 'no first frame', error: err?.message || String(err) });
      try { reader.cancel(); } catch {}
      try { built.cleanup?.(); } catch {}
      try { await audio?.teardown?.(); } catch {}
      playSfx?.('error');
      if (visualizerNowEl) visualizerNowEl.textContent = 'REC FAILED · no frames from source';
      if (screenrecBtn) { screenrecBtn.textContent = 'REC ⚠ STALL'; screenrecBtn.title = 'No frames in 3s — source not producing'; }
      return;
    }
    if (first.done || !first.value) {
      try { reader.cancel(); } catch {}
      try { built.cleanup?.(); } catch {}
      try { await audio?.teardown?.(); } catch {}
      playSfx?.('error');
      if (visualizerNowEl) visualizerNowEl.textContent = 'REC FAILED · video track ended immediately';
      return;
    }
    const f0 = first.value;
    // YUV 4:2:0 requires even dimensions. Modern captures always satisfy
    // this, but defensive even-rounding here keeps copyTo from throwing.
    //
    // Use displayWidth/displayHeight (the intended output size) rather
    // than codedWidth/codedHeight (the underlying buffer size). When a
    // cropped VideoFrame is created with a non-origin visibleRect,
    // Chromium keeps codedWidth/Height equal to the SOURCE's full coded
    // dimensions and only encodes the cropped size into displayWidth/
    // displayHeight. Reading codedWidth/Height here told ffmpeg the
    // source's full size while the canvas raster path produced the
    // smaller cropped content → wrong aspect on every CROP recording.
    const W = ((f0.displayWidth  || f0.codedWidth)  | 0) & ~1;
    const H = ((f0.displayHeight || f0.codedHeight) | 0) & ~1;
    if (W < 2 || H < 2) {
      try { f0.close(); } catch {}
      try { reader.cancel(); } catch {}
      try { built.cleanup?.(); } catch {}
      try { await audio?.teardown?.(); } catch {}
      _logDiag('STALL_3S', { reason: 'invalid first frame dims', w: f0.codedWidth, h: f0.codedHeight });
      playSfx?.('error');
      if (visualizerNowEl) visualizerNowEl.textContent = `REC FAILED · invalid frame dims ${f0.codedWidth}×${f0.codedHeight}`;
      return;
    }
    const _p = _profiles.getProfile();
    const recFps = Math.max(1, Number(_profiles.getFps()) || 30);
    const targetBps = _p.bitsPerSec || 5_000_000;
    // PHASE A — probe for a hardware WebCodecs encoder BEFORE spawning
    // ffmpeg, because main needs to know whether to build the `-c:v copy`
    // (encoded) pipeline or the raw-RGBA one. Null → keep the legacy path.
    let _wcConfig = null;
    if (_wcEncodeEnabled()) {
      try {
        _wcConfig = await pickEncoderConfig({ width: W, height: H, fps: recFps, bitrate: targetBps });
        _logDiag('WC_PROBE', { picked: _wcConfig ? _wcConfig.codec : null, w: W, h: H, fps: recFps });
      } catch (err) {
        _wcConfig = null;
        _logDiag('WC_PROBE_THREW', { error: err?.message || String(err) });
      }
    }
    // Tell main: spawn ffmpeg with the stream geometry we just measured.
    let started;
    try {
      started = await window.dash?.screenrecStart?.({
        width: W, height: H, fps: recFps,
        sampleRate: audio?.sampleRate || 48000,
        channels:   audio?.channels   || 2,
        hasAudio:   !!audio,
        sourceName: _mirrorSourceOverride?.name || '',
        videoBitsPerSecond: targetBps,
        profileKey: _p.key || 'custom',
        encodedInput: !!_wcConfig,
        chunked: _chunkedRecEnabled(),
        chunkSeconds: _chunkSeconds(),
      });
    } catch (err) { started = { ok: false, error: err?.message || String(err) }; }
    if (!started?.ok || !started.id) {
      try { f0.close(); } catch {}
      try { reader.cancel(); } catch {}
      try { built.cleanup?.(); } catch {}
      try { await audio?.teardown?.(); } catch {}
      _logDiag('REC_START_FAILED', { error: started?.error || 'unknown' });
      playSfx?.('error');
      if (visualizerNowEl) visualizerNowEl.textContent = `REC FAILED · ${started?.error || 'spawn failed'}`;
      return;
    }
    _logDiag('REC_START', {
      width: W, height: H, fps: recFps,
      audio: audio ? `${audio.channels}ch@${audio.sampleRate}Hz` : 'none',
      mixerSources: mixerNodeKinds,
      cropOn: _crop.getActive(), crop: _crop.getRect(),
      kind: srcKind,
      sourceName: _mirrorSourceOverride?.name || '',
      encoder: started.encoder,
      bps: targetBps,
    });

    // The dim-probe frame's content is stale — it was captured while
    // we were still building the audio mixer + spawning ffmpeg, so
    // using it as video PTS 0 puts the video several hundred ms
    // behind the first audio block (which represents what's playing
    // RIGHT NOW). Close it and start the pump fresh.
    try { f0.close(); } catch {}

    // Sync gate. Both pumps drop their output until BOTH sides have
    // produced at least one packet — then the gate opens and the next
    // packet from each side becomes ffmpeg's PTS 0. Since audio is
    // batched every ~21 ms and video at the source frame rate, the
    // residual A/V skew is at most one packet of each (~30 ms).
    let gateOpen = false;
    let haveAudioReady = !audio; // no audio source → audio side is trivially "ready"
    let haveVideoReady = false;
    const openGate = () => {
      if (gateOpen) return;
      if (haveAudioReady && haveVideoReady) {
        gateOpen = true;
        _logDiag('SYNC_GATE_OPEN', { wallClockMs: performance.now() });
      }
    };

    // Wire format = tight RGBA via a 2D canvas. VideoFrame.copyTo's
    // format-conversion is "implementation-defined" and Chromium's
    // build here NO-OPS the request — asking for BGRA or I420 returns
    // whatever native format the source actually has, with stride
    // metadata that doesn't match the requested format. Routing each
    // VideoFrame through canvas.drawImage + ctx.getImageData uses
    // Chromium's known-good rasterization path and always yields tight
    // RGBA bytes in CPU memory. Cost: one GPU→CPU readback per frame,
    // amortized by willReadFrequently which pins the backing on CPU.
    const rgbaSize = W * H * 4;
    const _recCanvas = document.createElement('canvas');
    _recCanvas.width  = W;
    _recCanvas.height = H;
    const _recCanvasCtx = _recCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
    let videoCanceled = false;
    let audioCanceled = false;
    let frameCount = 0;
    let audioBlocks = 0;
    let firstFrameLogged = false;
    let firstAudioLogged = false;
    let lastTsUs = -Infinity;
    const intervalUs = 1_000_000 / recFps;
    const pendingWrites = [];

    // PHASE A — if main spawned the encoded (`-c:v copy`) pipeline AND we
    // have a hardware config, build the WebCodecs encoder. Its output
    // callback ships finished H.264 bytes over the SAME write IPC the raw
    // path uses (fd 3 is just bytes either way) and tracks them in
    // pendingWrites so stop() drains them before closing the pipe. On any
    // construction failure we null it out — the emitter then falls back to
    // sendFrame (raw RGBA), but note main is already expecting H.264 on
    // fd 3 in that case, so we also flag the recording as degraded.
    let _wcEncoder = null;
    let _wcFatal = false;
    if (_wcConfig && started.encoder === 'webcodecs-copy') {
      try {
        _wcEncoder = createEncoder({
          config: _wcConfig,
          fps: recFps,
          onChunk: (bytes) => {
            try {
              const p = window.dash?.screenrecWriteVideo?.(started.id, bytes);
              if (p) { pendingWrites.push(p); p.catch(() => {}); }
              frameCount++;
              if (!firstFrameLogged) {
                firstFrameLogged = true;
                _logDiag('FIRST_FRAME_SENT', { encoded: true, bytes: bytes.byteLength, wallClockMs: performance.now() });
              }
            } catch (err) {
              if (frameCount < 3) console.warn('[screenrec] encoded write IPC failed:', err?.message || err);
            }
          },
          onError: (err) => {
            _wcFatal = true;
            _logDiag('WC_ENCODER_ERROR', { error: err?.message || String(err) });
            console.warn('[screenrec] WebCodecs encoder error — recording may be truncated:', err?.message || err);
          },
        });
        _logDiag('WC_ENCODER_OPEN', { codec: _wcConfig.codec });
      } catch (err) {
        _wcEncoder = null;
        _logDiag('WC_ENCODER_OPEN_FAILED', { error: err?.message || String(err) });
      }
    }

    const sendFrame = (frame) => {
      // Synchronous canvas raster — drawImage handles every input
      // pixel format Chromium understands (NV12, I420, RGBA, etc.) and
      // produces a tight 4-bytes-per-pixel RGBA buffer in CPU memory.
      try {
        _recCanvasCtx.drawImage(frame, 0, 0, W, H);
      } catch (err) {
        if (frameCount < 3) console.warn('[screenrec] canvas drawImage failed:', err?.message || err);
        return;
      }
      let imageData;
      try {
        imageData = _recCanvasCtx.getImageData(0, 0, W, H);
      } catch (err) {
        if (frameCount < 3) console.warn('[screenrec] canvas getImageData failed:', err?.message || err);
        return;
      }
      // imageData.data is a Uint8ClampedArray (RGBA, tight, W*H*4 bytes).
      // Wrap in a Uint8Array view of the same memory so the IPC byte-
      // view path in main hands ffmpeg the exact bytes.
      const buf = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
      try {
        const p = window.dash?.screenrecWriteVideo?.(started.id, buf);
        if (p) {
          pendingWrites.push(p);
          p.catch(() => {});
        }
        frameCount++;
        if (!firstFrameLogged) {
          firstFrameLogged = true;
          _logDiag('FIRST_FRAME_SENT', {
            width: W, height: H, bytes: buf.byteLength, expected: rgbaSize,
            sourceTs: frame.timestamp, wallClockMs: performance.now(),
          });
        }
      } catch (err) {
        if (frameCount < 3) console.warn('[screenrec] video write IPC failed:', err?.message || err);
      }
    };

    // Constant-rate video pipeline. ffmpeg's `-f rawvideo -framerate N`
    // has no per-packet timestamps — it stamps frame[i].pts = i/N. So
    // whatever rate we deliver at, ffmpeg labels it as N fps. If we
    // delivered 28 fps to a 30 fps declaration, video plays back at
    // 28/30 = 0.93× while audio plays back at 1× → audio lands ~2s
    // behind a 30s recording.
    //
    // Solution: decouple the source rate from the delivery rate. The
    // CAPTURE LOOP keeps a single `latestFrame` reference always up-to-
    // date with whatever the source last produced. The EMITTER fires
    // on a wall-clock cadence at exactly recFps and ships a copy of
    // latestFrame each tick — duplicating on slow source rates,
    // dropping on fast ones. Output frame count always matches what
    // ffmpeg's -framerate expects, so the audio stream stays locked.
    let latestFrame = null;
    let emitTimerId = null;
    let nextEmitMs = 0;

    // Capture loop — drains the processor as fast as the source
    // produces frames, parks the latest one in `latestFrame`.
    (async () => {
      while (!videoCanceled) {
        let r;
        try { r = await reader.read(); }
        catch { break; }
        if (r.done) break;
        const frame = r.value;
        if (!haveVideoReady) {
          haveVideoReady = true;
          _logDiag('VIDEO_READY', { sourceTs: frame.timestamp, wallClockMs: performance.now() });
          openGate();
        }
        if (latestFrame) { try { latestFrame.close(); } catch {} }
        latestFrame = frame;
      }
      // Loop exited — release the final frame so its GPU/CPU backing
      // memory isn't held until GC.
      if (latestFrame) { try { latestFrame.close(); } catch {} latestFrame = null; }
    })();

    // Emitter — self-rescheduling setTimeout aligned to absolute
    // wall-clock targets so jitter doesn't accumulate over long
    // recordings. Skips ticks while the gate is closed; once open,
    // ships exactly recFps frames per second to ffmpeg.
    const emitTick = () => {
      if (videoCanceled) return;
      if (gateOpen && latestFrame) {
        let send;
        try { send = latestFrame.clone(); }
        catch (err) {
          // VideoFrame.clone is supported in Chromium 94+; on the off
          // chance it's missing, skip this tick rather than crash.
          if (frameCount < 3) console.warn('[screenrec] VideoFrame.clone unavailable:', err?.message || err);
        }
        if (send) {
          // PHASE A — encoded path hands the VideoFrame straight to the
          // GPU encoder (no readback, no getImageData, no raw-RGBA IPC).
          // onChunk ships the resulting H.264 bytes + bumps frameCount.
          // Legacy path: sendFrame rasterizes to RGBA and ships that.
          // Either way the clone is ours to close after the synchronous
          // hand-off; the original latestFrame stays valid for next tick.
          try {
            if (_wcEncoder) _wcEncoder.encode(send);
            else            sendFrame(send);
          }
          finally { try { send.close(); } catch {} }
        }
      }
      if (nextEmitMs === 0) nextEmitMs = performance.now();
      nextEmitMs += intervalMs;
      const delayMs = Math.max(0, nextEmitMs - performance.now());
      emitTimerId = setTimeout(emitTick, delayMs);
    };
    const intervalMs = 1000 / recFps;
    nextEmitMs = performance.now();
    emitTimerId = setTimeout(emitTick, intervalMs);

    // Audio pump — AudioWorklet pushes ~1024-frame batches. Pre-gate
    // blocks signal "audio ready" then are discarded.
    if (audio) {
      audio.attachOnPcm((pcm) => {
        if (audioCanceled) return;
        if (!haveAudioReady) {
          haveAudioReady = true;
          _logDiag('AUDIO_READY', { workletTime: audio.ctx?.currentTime, wallClockMs: performance.now() });
          openGate();
        }
        if (!gateOpen) return;
        try {
          const p = window.dash?.screenrecWriteAudio?.(started.id, pcm);
          if (p) {
            pendingWrites.push(p);
            p.catch(() => {});
          }
          audioBlocks++;
          if (!firstAudioLogged) {
            firstAudioLogged = true;
            _logDiag('FIRST_AUDIO_SENT', { bytes: pcm.byteLength, wallClockMs: performance.now() });
          }
        } catch (err) {
          if (audioBlocks < 3) console.warn('[screenrec] audio write IPC failed:', err?.message || err);
        }
      });
    }

    // Heartbeat — every 5 s log the actual frame + audio block counts
    // along with what we EXPECT based on wall-clock elapsed. If actual
    // < expected, the emitter is being throttled (= video file content
    // is shorter than real time = audio appears behind video on
    // playback). Stops on cancel.
    const _recStartMs = performance.now();
    let _lastHeartbeatFrames = 0;
    let _lastHeartbeatAudio  = 0;
    const _heartbeatTimer = setInterval(() => {
      const elapsedSec = (performance.now() - _recStartMs) / 1000;
      const dFrames = frameCount - _lastHeartbeatFrames;
      const dAudio  = audioBlocks - _lastHeartbeatAudio;
      _lastHeartbeatFrames = frameCount;
      _lastHeartbeatAudio  = audioBlocks;
      _logDiag('HEARTBEAT', {
        elapsedSec: Number(elapsedSec.toFixed(2)),
        frames: frameCount,
        audioBlocks,
        expectedFrames: Math.round(elapsedSec * recFps),
        expectedAudioBlocks: Math.round(elapsedSec * 46.875),
        lastIntervalFrames: dFrames,
        lastIntervalAudio:  dAudio,
        gateOpen,
      });
    }, 5000);
    // Watchdog — same shape as the MediaRecorder version. Fires at 3 s.
    const _watchdogTimer = setTimeout(() => {
      if (frameCount === 0) {
        const diag = {
          videoTrackReadyState: vTrack?.readyState,
          videoTrackMuted: vTrack?.muted,
          videoTrackEnabled: vTrack?.enabled,
          videoTrackSettings: vTrack?.getSettings?.(),
          audioBlocks,
          cropOn: _crop.getActive(),
          mirrorAlive: !!_mirrorStream,
          mirrorVideoReady: visualizerVideoEl?.readyState,
          mirrorVideoDims: { w: visualizerVideoEl?.videoWidth, h: visualizerVideoEl?.videoHeight },
        };
        console.warn('[screenrec] STALL · 0 frames after 3s ·', diag);
        _logDiag('STALL_3S', diag);
        const why = vTrack?.muted ? 'video track muted'
                  : vTrack?.readyState !== 'live' ? `video track ${vTrack?.readyState}`
                  : 'unknown';
        if (visualizerNowEl) visualizerNowEl.textContent = `REC STALL · ${why} · see rec-diagnostic.log`;
        if (screenrecBtn) {
          screenrecBtn.title = `REC STALL · ${why} · diagnostic written to <gallery>/rec-diagnostic.log`;
          screenrecBtn.textContent = 'REC ⚠ STALL';
        }
      } else {
        console.log('[screenrec] healthy · frames:', frameCount, 'audio:', audioBlocks);
        _logDiag('HEALTHY_3S', { frames: frameCount, audioBlocks });
        // Surface the audio-block count to the visible NOW text so the
        // user can verify recording is capturing audio without opening
        // DevTools. audio=0 after 3 s of recording means something in
        // the mixer pipeline isn't delivering samples; non-zero means
        // the recording WILL have audio in the saved file.
        if (visualizerNowEl) {
          const mode = _urlMirrorActive
            ? (_stealthOn ? 'URL+STEALTH' : 'URL')
            : (_multiCamState ? 'CAMS' : 'SCREEN');
          visualizerNowEl.textContent = `REC · ${mode} · frames=${frameCount} audio=${audioBlocks}`;
        }
      }
    }, 3000);

    _screenrecState = {
      id: started.id,
      // Mixer gain nodes so MIXER sliders can rebalance volumes mid-
      // recording — _renderMixer reads _screenrecState.mixerNodes[kind].gain
      // on every slider input, and meter UI reads .analyser.
      mixerNodes: audio?.nodes || {},
      cancelPumps: () => {
        clearTimeout(_watchdogTimer);
        try { clearInterval(_heartbeatTimer); } catch {}
        try { clearTimeout(emitTimerId); } catch {}
        videoCanceled = true;
        audioCanceled = true;
        try { reader.cancel(); } catch {}
      },
      getPendingWrites: () => pendingWrites,
      getStats: () => ({ frames: frameCount, audioBlocks }),
      // PHASE A — drain the encoder's queued frames (the last GOP hasn't
      // been emitted yet when the emitter stops) and close it. No-op on
      // the legacy raw path. Called by _stopScreenrec BEFORE it awaits
      // pendingWrites, so flush()'s trailing onChunk writes get queued in
      // time to be waited on before the fd 3 pipe is closed.
      flushEncoder: async () => {
        if (!_wcEncoder) return;
        try { await _wcEncoder.flush(); } catch {}
        try { _wcEncoder.close(); } catch {}
      },
      finalTeardown: async () => {
        try { built.cleanup?.(); } catch {}
        try { await audio?.teardown?.(); } catch {}
      },
    };
    screenrecBtn?.classList.add('is-active');
    // is-recording on the player wrap drives the stealth-overlay pill
    // swap (STEALTH chip → red flashing REC chip) — see the CSS rules
    // for .visualizer-player-wrap.is-stealth.is-recording::before.
    visualizerWrapEl?.classList.add('is-recording');
    try { document.getElementById('topbar-rec-indicator')?.removeAttribute('hidden'); } catch {}
    if (screenrecBtn) {
      const wantedAudio = _shouldCaptureAudio();
      if (audio) {
        screenrecBtn.textContent = 'REC ●';
        screenrecBtn.title = `Recording · live ${started.encoder} · ${(targetBps/1_000_000).toFixed(1)} Mbps`;
      } else if (wantedAudio) {
        screenrecBtn.textContent = 'REC ⚠';
        screenrecBtn.title = 'Recording WITHOUT audio — mixer build returned no sources';
        console.warn('[screenrec] audio requested but mixer unavailable — recording will be silent');
      } else {
        screenrecBtn.textContent = 'REC (silent) ●';
        screenrecBtn.title = 'Recording without audio (SOUND is off)';
      }
    }
  }

  async function _stopScreenrec() {
    const st = _screenrecState;
    if (!st) return;
    _screenrecState = null;
    screenrecBtn?.classList.remove('is-active');
    visualizerWrapEl?.classList.remove('is-recording');
    if (screenrecBtn) screenrecBtn.textContent = 'REC';
    try { document.getElementById('topbar-rec-indicator')?.setAttribute('hidden', ''); } catch {}
    try {
      // Stop new writes from being scheduled, but keep the audio worklet
      // running until cleanup so any block already in-flight finishes.
      try { st.cancelPumps?.(); } catch {}
      // PHASE A — flush the WebCodecs encoder before draining writes so
      // its final queued frames become pendingWrites entries. No-op on
      // the legacy raw path.
      try { await st.flushEncoder?.(); } catch {}
      // Wait for any IPC writes already in flight to land in main —
      // otherwise we'd close the ffmpeg pipes with bytes still queued
      // in the renderer and lose the trailing fragment.
      try { await Promise.allSettled(st.getPendingWrites?.() || []); } catch {}
      const res = await window.dash?.screenrecStop?.(st.id);
      if (res?.ok) {
        console.log('[screenrec] saved:', res.path, '·', res.encoder, '·', res.size, 'bytes');
        try { window.dash?.screenrecLogDiag?.(`REC_SAVED ${JSON.stringify({ name: res.name, size: res.size, encoder: res.encoder, profile: res.profile, targetBps: res.targetBps, chunks: res.chunks, joined: res.joined, warning: res.warning })}`); } catch {}
        // Chunk suffix for the toast: "· 4 chunks joined" or, if the
        // join failed, "· 4 chunks (join failed — parts kept)".
        const chunkInfo = res.chunked
          ? (res.joined ? ` · ${res.chunks} chunks joined` : ` · ${res.chunks} chunks (parts kept)`)
          : '';
        if (screenrecBtn) screenrecBtn.title = `Saved ${res.name} (${(res.size / 1024 / 1024).toFixed(1)} MB · ${res.encoder})${chunkInfo} · click to record again`;
        if (visualizerNowEl) visualizerNowEl.textContent = `SAVED · ${res.name} · ${res.encoder}${chunkInfo}`;
      } else {
        const why = res?.error || 'no response from main process';
        console.error('[screenrec] SAVE FAILED:', why, res);
        try { window.dash?.screenrecLogDiag?.(`REC_SAVE_FAILED ${JSON.stringify({ error: why })}`); } catch {}
        if (screenrecBtn) screenrecBtn.title = `SAVE FAILED — ${why}`;
        if (visualizerNowEl) visualizerNowEl.textContent = `REC SAVE FAILED · ${why}`;
      }
      try { _visualizerSubdir = 'recordings'; refreshVisualizer(); } catch {}
    } catch (err) {
      console.warn('[screenrec] stop failed:', err?.message || err);
    } finally {
      // Final teardown closes the AudioContext + tears down the
      // loopback. Fire-and-forget so the next REC can spin up without
      // waiting on setLoopbackPcm(false) to round-trip.
      try { Promise.resolve(st.finalTeardown?.()).catch(() => {}); } catch {}
    }
  }
  screenrecBtn?.addEventListener('click', () => {
    // Toggle: was-on → turn off → 'close'; was-off → turn on → 'click'.
    if (_screenrecState) { _stopScreenrec(); playSfx?.('close'); }
    else                 { _startScreenrec(); playSfx?.('click'); }
  });

  // ── PCM: audio-only record → high-quality MP3 to the music folder ──
  // Independent of the video REC path. Captures the mixer audio (system
  // loopback always, + mic when MIC is armed), streams f32le PCM to the
  // same ffmpeg pump main spawns, and main encodes a 320k MP3. No video
  // is captured or piped. Toggle: click to start, click again to stop.
  async function _startPcmRec() {
    if (_pcmRec) return;
    if (_screenrecState) {
      // Video REC already owns the audio mixer; don't double-capture.
      if (visualizerNowEl) visualizerNowEl.textContent = 'PCM: stop the video REC first';
      playSfx?.('error');
      return;
    }
    // REC button press is a fresh user gesture — resume any parked ctx.
    if (_audioCtx && _audioCtx.state === 'suspended') {
      try { await _audioCtx.resume(); } catch {}
    }
    const audio = await _buildMixerPcmTap({ forceSystem: true });
    if (!audio) {
      if (visualizerNowEl) visualizerNowEl.textContent = 'PCM FAILED · no audio sources';
      playSfx?.('error');
      return;
    }
    let started;
    try {
      started = await window.dash?.screenrecStart?.({
        audioOnly: true,
        hasAudio: true,
        sampleRate: audio.sampleRate || 48000,
        channels:   audio.channels   || 2,
        sourceName: _mirrorSourceOverride?.name || '',
      });
    } catch (err) { started = { ok: false, error: err?.message || String(err) }; }
    if (!started?.ok || !started.id) {
      try { await audio.teardown?.(); } catch {}
      if (visualizerNowEl) visualizerNowEl.textContent = `PCM FAILED · ${started?.error || 'spawn failed'}`;
      playSfx?.('error');
      return;
    }
    const rec = { id: started.id, audio, pending: [] };
    audio.attachOnPcm((pcm) => {
      if (!_pcmRec) return;
      try {
        const p = window.dash?.screenrecWriteAudio?.(rec.id, pcm);
        if (p) { rec.pending.push(p); p.catch(() => {}); }
      } catch {}
    });
    _pcmRec = rec;
    pcmBtn?.classList.add('is-active');
    if (pcmBtn) pcmBtn.textContent = 'PCM ●';
    if (visualizerNowEl) visualizerNowEl.textContent = 'PCM · recording audio…';
  }
  async function _stopPcmRec() {
    const rec = _pcmRec;
    if (!rec) return;
    _pcmRec = null;
    pcmBtn?.classList.remove('is-active');
    if (pcmBtn) pcmBtn.textContent = 'PCM';
    try {
      // Detach the tap so no further blocks schedule, drain in-flight
      // writes, then close the ffmpeg audio pipe so it finalizes the MP3.
      try { rec.audio.attachOnPcm(null); } catch {}
      try { await Promise.allSettled(rec.pending); } catch {}
      const res = await window.dash?.screenrecStop?.(rec.id);
      if (res?.ok) {
        if (visualizerNowEl) visualizerNowEl.textContent = `SAVED · ${res.name} → music`;
      } else {
        if (visualizerNowEl) visualizerNowEl.textContent = `PCM SAVE FAILED · ${res?.error || 'unknown'}`;
      }
    } catch (err) {
      console.warn('[pcm] stop failed:', err?.message || err);
    } finally {
      try { Promise.resolve(rec.audio.teardown?.()).catch(() => {}); } catch {}
    }
  }
  pcmBtn?.addEventListener('click', () => {
    if (_pcmRec) { _stopPcmRec(); playSfx?.('close'); }
    else         { _startPcmRec(); playSfx?.('click'); }
  });

  // Global REC hotkeys (F9 = PCM, F10 = screen REC). Main grabs the keys
  // system-wide and forwards the intent here so they fire even while the
  // app being recorded is focused. Routed through the same button-click
  // toggles so SFX + state stay consistent. Active once the REC ROOM has
  // been opened this session (this module is lazy-loaded on first open).
  try {
    window.dash?.onRecHotkey?.(({ which }) => {
      if (which === 'pcm') pcmBtn?.click();
      else if (which === 'screenrec') screenrecBtn?.click();
    });
  } catch {}
  // Drive the wrap's aspect ratio off the actual video's intrinsic
  // dimensions as soon as they're known. Covers both file playback
  // (src URL) and the mirror case where getSettings() may not have
  // returned dims yet at start time.
  visualizerVideoEl?.addEventListener('loadedmetadata', () => {
    if (visualizerVideoEl.videoWidth && visualizerVideoEl.videoHeight) {
      _setSourceDims(visualizerVideoEl.videoWidth, visualizerVideoEl.videoHeight);
    }
  });
  visualizerVideoEl?.addEventListener('emptied', () => {
    // Source went away (e.g. mirror stop cleared srcObject) — drop the
    // dynamic aspect so the next click against an empty wrap doesn't
    // inherit a stale ratio.
    _setSourceDims(0, 0);
  });
  // Match aspect to the still image when a snap is shown.
  document.getElementById('visualizer-still')?.addEventListener('load', (ev) => {
    const img = ev.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      _setSourceDims(img.naturalWidth, img.naturalHeight);
    }
  });
  // Auto-advance: when a video ends, cue the next one in the list.
  // URL mirror takes precedence — if the URL playback is what ended
  // and a screen recording is in progress, stop the recording and
  // tear down the mirror so the saved file's duration matches the
  // source. Without this, the recorder would keep capturing a frozen
  // last frame after the source video finished.
  visualizerVideoEl?.addEventListener('ended', async () => {
    if (_urlMirrorActive) {
      try {
        if (_screenrecState && typeof _stopScreenrec === 'function') {
          await _stopScreenrec();
        }
      } catch (err) {
        console.warn('[url-mirror] auto-stop record failed:', err?.message || err);
      }
      try { _stopVisualizerMirror(); } catch {}
      return;
    }
    const playable = _visualizerEntries.filter((e) => !e.isDir && _VIDEO_KNOWN_RE.test(e.name));
    const idx = playable.findIndex((e) => e.path === _visualizerCurrent);
    const next = playable[idx + 1];
    if (next) playVisualizerEntry(next);
  });

  _activateImpl = () => { try { refreshVisualizer(); } catch {} };

  // Cross-room sync: EXPLORE (or anywhere) renames / moves / deletes a
  // gallery file → refresh our recordings list so the user doesn't see
  // a ghost row. Coalesced to one rAF so a burst of mutations (paste
  // of 20 files) only re-fetches once. detail.which lets us skip the
  // refetch when an unrelated section changed.
  let _filesChangedQueued = false;
  window.addEventListener('dash:files-changed', (ev) => {
    const which = ev?.detail?.which;
    if (which && which !== 'gallery') return; // recordings live under gallery
    if (_filesChangedQueued) return;
    _filesChangedQueued = true;
    requestAnimationFrame(() => {
      _filesChangedQueued = false;
      try { refreshVisualizer(); } catch {}
    });
  });
}

export function activate() { _activateImpl?.(); }
