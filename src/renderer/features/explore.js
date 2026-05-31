// EXPLORE tab · in-panel mini-Explorer for the gallery / docs / downloads
// roots. Lazy combo pane — app.js dynamically import()s this on the first
// EXPLORE tab open. init() receives injected deps from app.js:
//   fmtBytes(n)     — byte-size formatter (shared dashboard helper)
//   pushUndo(batch) — hand a delete batch to the VISUALIZER undo stack
//
//   init(deps)  — one-time: grab elements, wire listeners, restore tab
//   activate()  — EXPLORE tab shown: re-list every section

import { groupSequences, extOf } from '../util/sequences.js';

let deps = {};
let explorePane;
let exploreGalleryListEl, exploreDocsListEl, exploreDownloadsListEl, exploreMusicListEl;
let exploreGalleryPathEl, exploreDocsPathEl, exploreDownloadsPathEl, exploreMusicPathEl;
let exploreViewerEl, exploreViewerNameEl, exploreViewerImgEl, exploreViewerVidEl;
let exploreViewerCloseBtn, exploreViewerFsBtn, exploreViewerPopoutBtn;
let exploreInfoPanel, exploreInfoResize, exploreInfoImg, exploreInfoVid;
let exploreInfoPlaceholder, exploreInfoName, exploreInfoDetails;
let exploreBatchRenameWrap, exploreBatchRenameInput, exploreBatchRenameBtn, exploreBatchRenameStatus;
let _exploreListEls = {};
let _explorePathEls = {};
let _ready = false;
// Latest single-clicked file per section. Drives the info panel
// preview + details. Multi-select shows a "N files" summary instead.
let _exploreInfoCurrent = null; // { which, abs, name, rel, size, mtime, isDir }

// Per-section state. Pure data — safe to initialise at module load.
const _exploreSubdir   = { gallery: '', docs: '', downloads: '', music: '' };
const _exploreSelected = { gallery: new Set(), docs: new Set(), downloads: new Set(), music: new Set() };
const _exploreAnchor   = { gallery: null, docs: null, downloads: null, music: null };
const _exploreEntries  = { gallery: [], docs: [], downloads: [], music: [] };
// Raw IPC entries (pre-sort, pre-group) so we can re-render without
// hitting disk when the user only changes view/sort. Refreshed by
// refreshExploreSection on every IPC list call.
const _rawEntries      = { gallery: [], docs: [], downloads: [], music: [] };
const _exploreRoots    = { gallery: '',  docs: '',  downloads: '', music: '' };
// View / sort / thumb-size — each section persists independently.
// Gallery defaults to grid (matches the prior is-thumbnails behavior);
// docs / downloads / music default to list (folders → grid feels weird
// for actual documents). Defaults are overridden by cfg on init.
const _exploreView      = { gallery: 'grid', docs: 'list', downloads: 'list', music: 'list' };
const _exploreSort      = { gallery: 'name', docs: 'name', downloads: 'date', music: 'name' };
const _exploreSortDir   = { gallery: 'asc',  docs: 'asc',  downloads: 'desc', music: 'asc' };
const _exploreThumbSize = { gallery: 140, docs: 140, downloads: 140, music: 140 };
let _exploreViewerCurrent = null; // { which, abs, name }
let _exploreCtxMenu = null;

// IPC list / path bridges keyed by section — getters so they resolve
// window.dash lazily (it always exists by the time a pane opens).
const _exploreListBridges = {
  gallery:   () => window.dash?.galleryList,
  docs:      () => window.dash?.docsList,
  downloads: () => window.dash?.downloadsList,
  music:     () => window.dash?.musicList,
};
const _explorePathBridges = {
  gallery:   () => window.dash?.galleryPath,
  docs:      () => window.dash?.docsPath,
  downloads: () => window.dash?.downloadsPath,
  music:     () => window.dash?.musicPath,
};

// Image extensions Chromium can render via <img> directly via dash3d-file://.
const _IMG_RENDER_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const _IMG_KNOWN_RE  = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|psd|heic|heif|raw|cr2|nef|arw|dng|orf|rw2|raf)$/i;
// Video extensions. First regex = what Chromium plays in a <video>; second
// catches every video extension we know about so the gallery can include
// them all with a thumbnail and the viewer can decide whether to play
// inline or hand off to the OS.
const _VIDEO_RENDER_RE = /\.(mp4|webm|m4v|ogv|ogg|mov|mkv)$/i;
const _VIDEO_KNOWN_RE  = /\.(mp4|webm|m4v|ogv|ogg|mov|avi|mkv|wmv|flv|3gp|3g2|asf|hevc|h264|h265|mts|m2ts|ts)$/i;
// Files we ask main/thumbnails.js to ffmpeg-encode a JPEG preview for —
// videos + image formats Chromium can't render natively. Rendered via
// the dash3d-thumb:// scheme; everything else uses dash3d-file:// or a
// placeholder glyph.
const _THUMB_VIA_FFMPEG_RE = /\.(mp4|webm|m4v|ogv|ogg|mov|mkv|avi|wmv|flv|3gp|3g2|asf|hevc|h264|h265|mts|m2ts|ts|tiff?|psd|heic|heif|raw|cr2|nef|arw|dng|orf|rw2|raf)$/i;
// Audio extensions the music player handles — double-clicking one in the
// AUDIO section hands it to the music tab.
const _AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|weba)$/i;

// EXPLORE pane tab strip — flips the visible section between gallery,
// docs and downloads. Persists under config.exploreTab.
function setExploreTab(which, persist = true) {
  if (which !== 'gallery' && which !== 'docs' && which !== 'downloads' && which !== 'music') which = 'gallery';
  if (!explorePane) return;
  explorePane.dataset.exploreTab = which;
  explorePane.querySelectorAll('.explore-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.exploreTabBtn === which);
  });
  if (persist && window.dash?.setConfig) window.dash.setConfig({ exploreTab: which });
}

function fmtFileTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: '2-digit' });
}

// Sort entries by the user's current sort + direction. Folders always
// float to the top (Explorer-style) so directory traversal stays at
// hand regardless of the file ordering chosen. Sequence collapsing
// happens *after* this on the sorted list, so a date-sorted view still
// merges same-prefix runs that share a timestamp neighborhood.
function _sortEntries(which, entries) {
  const mode = _exploreSort[which] || 'name';
  const dir  = _exploreSortDir[which] === 'desc' ? -1 : 1;
  const arr = entries.slice();
  const lc = (s) => String(s || '').toLowerCase();
  const ext = (n) => {
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(i + 1).toLowerCase() : '';
  };
  arr.sort((a, b) => {
    // Folders always first within each direction.
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (mode === 'date') {
      cmp = (a.mtime || 0) - (b.mtime || 0);
    } else if (mode === 'size') {
      // Folders compare equal — they don't have meaningful sizes here.
      cmp = (a.size || 0) - (b.size || 0);
    } else if (mode === 'type') {
      cmp = ext(a.name).localeCompare(ext(b.name));
    }
    if (cmp === 0) cmp = lc(a.name).localeCompare(lc(b.name));
    return cmp * dir;
  });
  return arr;
}

// Reflect the per-section view mode onto the section root + list +
// thumb-size CSS variable so the layout matches state. Called any time
// view, size, or initial state changes.
function _applyViewMode(which) {
  const sectionEl = explorePane?.querySelector(`.explore-section[data-explore="${which}"]`);
  const listEl    = _exploreListEls[which];
  if (sectionEl) {
    sectionEl.dataset.exploreView = _exploreView[which];
    sectionEl.style.setProperty('--explore-thumb-size', `${_exploreThumbSize[which]}px`);
  }
  if (listEl) listEl.classList.toggle('is-thumbnails', _exploreView[which] === 'grid');
  // Header buttons: light the active view, set direction arrow + label.
  const head = sectionEl?.querySelector('.explore-view-controls');
  if (head) {
    head.querySelectorAll('.explore-view-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mode === _exploreView[which]);
    });
    const sortSel = head.querySelector('.explore-sort-select');
    if (sortSel) sortSel.value = _exploreSort[which];
    const dirBtn = head.querySelector('.explore-sort-dir');
    if (dirBtn) {
      dirBtn.textContent = _exploreSortDir[which] === 'desc' ? '↓' : '↑';
      dirBtn.classList.toggle('is-desc', _exploreSortDir[which] === 'desc');
    }
    const sizeEl = head.querySelector('.explore-thumb-slider');
    if (sizeEl) sizeEl.value = String(_exploreThumbSize[which]);
  }
}

function _persistViewState() {
  try {
    window.dash?.setConfig?.({
      exploreViews:      { ..._exploreView },
      exploreSorts:      { ..._exploreSort },
      exploreSortDirs:   { ..._exploreSortDir },
      exploreThumbSizes: { ..._exploreThumbSize },
    });
  } catch {}
}

function renderExploreList(which, result) {
  const listEl = _exploreListEls[which];
  if (!listEl) return;
  _applyViewMode(which);
  listEl.innerHTML = '';
  if (!result || result.error) {
    listEl.innerHTML = `<li class="explore-empty">${(result?.error || 'NOT FOUND').toUpperCase()}</li>`;
    return;
  }
  const entries = result.entries || [];
  // Cache the raw list so sort/view toggles can re-render without
  // round-tripping the IPC (re-listing a folder on every click would
  // feel laggy on large directories).
  _rawEntries[which] = entries;
  if (!entries.length) {
    listEl.innerHTML = '<li class="explore-empty">EMPTY · DROP FILES INTO THE FOLDER</li>';
    return;
  }
  // Gallery shows everything — videos get an ffmpeg-extracted thumbnail
  // (dash3d-thumb://) and native images get their bytes directly. The
  // earlier "hide videos in gallery" carveout is gone now that the
  // thumbnail pipeline can show them.
  const filteredEntries = entries;
  // Sort BEFORE sequence-grouping so a date-sorted view still folds
  // adjacent same-prefix runs into one row (e.g. SNAP frames captured
  // back-to-back); sorting after groupSequences would split runs that
  // happen to interleave by date with unrelated files.
  const sortedEntries = _sortEntries(which, filteredEntries);
  // Collapse same-prefix numbered runs (e.g. snap captures) into one row
  // per sequence — see util/sequences.js. Folders pass through untouched.
  const groupedEntries = groupSequences(sortedEntries);
  // Capture the ordered entry list for shift-click range selection.
  _exploreEntries[which] = groupedEntries;
  const selSet = _exploreSelected[which];
  // Grid mode (any section) uses the tile layout; list mode shows the
  // detail row. View mode is per-section, persisted in cfg.exploreViews.
  const isGrid = _exploreView[which] === 'grid';
  for (const e of groupedEntries) {
    const row = document.createElement('li');
    const isSel = selSet.has(e.path);
    const isCut = _explorerClipboard.mode === 'cut' && _explorerClipboard.paths.includes(e.path);
    row.className = 'explore-row' + (e.isDir ? ' is-dir' : '') + (e.isSeq ? ' is-seq' : '') + (isSel ? ' is-selected' : '') + (isCut ? ' is-cut' : '');
    row.draggable = true;
    row.dataset.path  = e.path;
    row.dataset.isDir = String(e.isDir);
    row.dataset.name  = e.name;
    row.dataset.which = which;
    if (e.isSeq) row.dataset.seqCount = String(e.seqCount);
    // Relative-to-managed-root path for dash3d-file:// URLs.
    if (e.rel) row.dataset.rel = e.rel;
    row.title = e.isSeq ? `${e.path}  (+ ${e.seqCount - 1} more frames)` : e.path;
    const ext = extOf(e.name);
    const baseName = e.name.replace(/\.[^.]+$/, '');
    if (isGrid) {
      const preview = document.createElement('div');
      preview.className = 'explore-thumb-preview';
      if (e.isDir) {
        preview.innerHTML = '<span class="explore-thumb-icon">▣</span>';
      } else if (_IMG_RENDER_RE.test(e.name)) {
        // Native-renderable image — dash3d-file:// streams the bytes
        // straight from disk.
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = `dash3d-file://${which}/${encodeURI(e.rel)}`;
        img.addEventListener('error', () => {
          preview.innerHTML = `<span class="explore-thumb-ext">${ext || 'IMG'}</span>`;
        });
        preview.appendChild(img);
      } else if (_THUMB_VIA_FFMPEG_RE.test(e.name)) {
        // Video / TIFF / PSD / HEIC / RAW — main process generates a
        // cached JPEG via ffmpeg-static and serves it back through the
        // dash3d-thumb:// scheme. Tagged with .is-video / .is-exotic
        // so CSS can lay a small badge over the thumb.
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = `dash3d-thumb://${which}/${encodeURI(e.rel)}`;
        img.addEventListener('error', () => {
          preview.innerHTML = `<span class="explore-thumb-ext">${ext || '?'}</span>`;
        });
        preview.appendChild(img);
        if (_VIDEO_KNOWN_RE.test(e.name)) {
          const badge = document.createElement('span');
          badge.className = 'explore-thumb-badge';
          badge.textContent = '▶';
          preview.appendChild(badge);
        }
      } else {
        preview.innerHTML = '<span class="explore-thumb-icon">▤</span>';
      }
      if (e.isSeq) {
        const seq = document.createElement('span');
        seq.className = 'explore-thumb-seq';
        seq.textContent = `× ${e.seqCount}`;
        preview.appendChild(seq);
      }
      const name = document.createElement('span');
      name.className = 'explore-row-name';
      name.textContent = e.name;
      row.appendChild(preview);
      row.appendChild(name);
    } else {
      const safeName = baseName.replace(/</g, '&lt;');
      const extBadge = (!e.isDir && ext) ? `<span class="explore-row-ext">${ext}</span>` : '';
      const seqBadge = e.isSeq ? `<span class="explore-row-seq">× ${e.seqCount}</span>` : '';
      // Inline thumbnail in the LIST view. Folders show a chunky glyph;
      // images render their bitmap via dash3d-file://<which>/<rel>;
      // videos / other files show a small type-glyph.
      const isImgFile  = !e.isDir && _IMG_RENDER_RE.test(e.name);
      const isThumbFmt = !e.isDir && _THUMB_VIA_FFMPEG_RE.test(e.name);
      const isVidFile  = !e.isDir && _VIDEO_KNOWN_RE.test(e.name);
      const thumb = e.isDir
        ? `<div class="explore-row-thumb"><span class="explore-row-thumb-glyph">▣</span></div>`
        : isImgFile
          ? `<div class="explore-row-thumb"><img draggable="false" loading="lazy" alt="" src="dash3d-file://${which}/${encodeURI(e.rel)}"></div>`
          : isThumbFmt
            ? `<div class="explore-row-thumb"><img draggable="false" loading="lazy" alt="" src="dash3d-thumb://${which}/${encodeURI(e.rel)}"></div>`
            : `<div class="explore-row-thumb"><span class="explore-row-thumb-glyph">${isVidFile ? '▶' : '∙'}</span></div>`;
      row.innerHTML =
        thumb +
        `<span class="explore-row-name">${safeName}</span>` +
        seqBadge + extBadge +
        `<span class="explore-row-size">${e.isDir ? '—' : deps.fmtBytes(e.size)}</span>` +
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
    refreshExploreSection('music'),
  ]);
}

function applyExploreSelection(which) {
  const listEl = _exploreListEls[which];
  const set = _exploreSelected[which];
  listEl?.querySelectorAll('.explore-row').forEach((r) => {
    r.classList.toggle('is-selected', set.has(r.dataset.path));
  });
  // Selection drives the info-panel content. Called on every selection
  // change so single-clicks, range selects, ctrl-toggles, and keyboard
  // navigation all keep the panel in sync.
  _updateInfoPanel(which);
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
  // Anchor stays at `fromAbs` so successive shift-clicks expand from the
  // original point, Explorer-style.
  applyExploreSelection(which);
}
// Ctrl+Shift-click: ADD the anchor→target range to the existing selection.
function _addRange(which, fromAbs, toAbs) {
  const entries = _exploreEntries[which];
  const fi = entries.findIndex((e) => e.path === fromAbs);
  const ti = entries.findIndex((e) => e.path === toAbs);
  if (fi < 0 || ti < 0) return _toggleSelected(which, toAbs);
  const [a, b] = fi <= ti ? [fi, ti] : [ti, fi];
  for (let i = a; i <= b; i++) _exploreSelected[which].add(entries[i].path);
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
  // Anchor is only valid if it still exists in the current entries list.
  const anchor = _exploreAnchor[which];
  const haveAnchor = anchor
    && _exploreEntries[which].some((x) => x.path === anchor);
  // Windows-style rules: shift = replace range, ctrl+shift = add range to
  // existing, ctrl alone = toggle, plain click = select only.
  if (e.shiftKey && haveAnchor) {
    if (e.ctrlKey || e.metaKey) _addRange(which, anchor, abs);
    else                        _selectRange(which, anchor, abs);
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
  const rel   = row.dataset.rel || name;
  if (isDir) {
    navigateInto(which, name);
    return;
  }
  // Audio files in the AUDIO section hand off to the music tab.
  if (which === 'music' && _AUDIO_RE.test(name)) {
    window._musicPlayExternal?.(rel);
    document.querySelector('.combo-mode-tab[data-mode="music"]')?.click();
    return;
  }
  // Images + videos play in the inline viewer; anything else falls
  // through to the OS default app.
  if (_IMG_RENDER_RE.test(name) || _VIDEO_RENDER_RE.test(name)) {
    _openExploreViewer(which, abs, name, rel);
  } else {
    window.dash?.shellOpenPath?.(abs).catch(() => {});
  }
}

// ── Inline media viewer ──────────────────────────────────────────────
function _openExploreViewer(which, abs, name, rel) {
  if (!exploreViewerEl) return;
  _exploreViewerCurrent = { which, abs, name };
  if (exploreViewerNameEl) exploreViewerNameEl.textContent = name;
  const url = `dash3d-file://${which}/${encodeURI(rel || name)}`;
  const isVid = _VIDEO_RENDER_RE.test(name);
  if (isVid) {
    if (exploreViewerImgEl) { exploreViewerImgEl.hidden = true; exploreViewerImgEl.removeAttribute('src'); }
    if (exploreViewerVidEl) {
      exploreViewerVidEl.hidden = false;
      exploreViewerVidEl.src = url;
      try { exploreViewerVidEl.load(); } catch {}
      // Auto-play unmuted on click — user intent is clear.
      exploreViewerVidEl.play?.().catch(() => {});
    }
  } else {
    if (exploreViewerVidEl) {
      try { exploreViewerVidEl.pause(); } catch {}
      exploreViewerVidEl.removeAttribute('src');
      try { exploreViewerVidEl.load(); } catch {}
      exploreViewerVidEl.hidden = true;
    }
    if (exploreViewerImgEl) {
      exploreViewerImgEl.hidden = false;
      exploreViewerImgEl.src = url;
    }
  }
  exploreViewerEl.hidden = false;
}
function _closeExploreViewer() {
  if (!exploreViewerEl || exploreViewerEl.hidden) return;
  if (document.fullscreenElement === exploreViewerEl) {
    try { document.exitFullscreen(); } catch {}
  }
  if (exploreViewerVidEl) {
    try { exploreViewerVidEl.pause(); } catch {}
    exploreViewerVidEl.removeAttribute('src');
    try { exploreViewerVidEl.load(); } catch {}
    exploreViewerVidEl.hidden = true;
  }
  if (exploreViewerImgEl) {
    exploreViewerImgEl.removeAttribute('src');
    exploreViewerImgEl.hidden = true;
  }
  exploreViewerEl.hidden = true;
  _exploreViewerCurrent = null;
}
// ⛶ fullscreen — request fullscreen on the viewer wrapper so both image +
// video modes get edge-to-edge display.
function _toggleExploreViewerFullscreen() {
  if (!exploreViewerEl) return;
  if (document.fullscreenElement === exploreViewerEl) {
    try { document.exitFullscreen(); } catch {}
  } else {
    try { exploreViewerEl.requestFullscreen?.(); } catch {}
  }
}

// Inline new-folder row — prepends a placeholder row with an input. Enter
// calls exploreMkdir; Esc / empty-blur drops the row.
function startNewFolder(which) {
  const listEl = _exploreListEls[which];
  if (!listEl) return;
  // Drop any existing placeholder so successive clicks don't stack rows.
  listEl.querySelector('.explore-row.is-creating')?.remove();
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
    else notifyFilesChanged(which, 'mkdir');
    refreshExploreSection(which);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (ev) => ev.stopPropagation());
}

// Inline rename — replaces the row's name span with a text input.
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
    else notifyFilesChanged(which, 'rename');
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
  // Only react when EXPLORE is the active combo mode.
  if (!explorePane || !explorePane.classList.contains('is-visible')) return;
  // If the user is typing into an input / textarea / contenteditable
  // (inline rename, batch-rename basename, new-folder input, info-panel
  // search, etc.), let the keystroke pass through untouched. Otherwise
  // the space-bar fullscreen shortcut steals every space the user tries
  // to type, F2 rename rebinds during rename, etc.
  const t = ev.target;
  if (t && (t.matches?.('input, textarea, [contenteditable=""], [contenteditable="true"]'))) return;
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
    // Spacebar — fullscreen view. One image → single-image viewer; many →
    // contact-sheet grid window.
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

// Multi-aware delete: trash every selected entry. Recoverable from the OS
// Recycle Bin; the delete batch is also handed to the VISUALIZER undo
// stack via the injected pushUndo() dep.
async function deleteSelectedAll(which) {
  const paths = [..._exploreSelected[which]];
  if (!paths.length) return;
  const batch = [];
  for (const abs of paths) {
    try {
      const r = await window.dash?.exploreDelete?.(abs);
      if (r?.ok && r.trashPath && r.origPath) {
        batch.push({ origPath: r.origPath, trashPath: r.trashPath, name: r.name });
      } else if (!r?.ok) {
        console.warn('[explore] delete failed:', abs, r?.error);
      }
    } catch {}
  }
  if (batch.length) {
    deps.pushUndo?.(batch);
    notifyFilesChanged(which, 'delete');
  }
  _exploreSelected[which].clear();
  _exploreAnchor[which] = null;
  refreshExploreSection(which);
}
// Copy selected paths to the OS clipboard as Windows file objects.
async function copySelectedAll(which) {
  const paths = [..._exploreSelected[which]];
  if (!paths.length || !window.dash?.clipboardCopyFiles) return;
  const r = await window.dash.clipboardCopyFiles(paths);
  if (!r?.ok) console.warn('[explore] copy failed:', r?.error);
}

// Alt+double-click on the name span starts a rename without pre-selecting.
function handleNameDblClick(ev) {
  if (!ev.target.classList?.contains('explore-row-name')) return;
  if (!ev.altKey) return;
  ev.preventDefault();
  const row = ev.target.closest('.explore-row');
  startRename(row);
}

// Cross-room file-change broadcast. Any mutation (rename / move / copy
// / delete / mkdir / paste) fires this so feature modules that mirror
// the same folders (visualizer recordings list, music library, etc.)
// can refresh without polling. Listeners attach via:
//   window.addEventListener('dash:files-changed', (e) => {...});
// detail.which is one of 'gallery'|'docs'|'downloads'|'music' (or null
// for cross-section moves).
function notifyFilesChanged(which = null, kind = 'mutation') {
  try {
    window.dispatchEvent(new CustomEvent('dash:files-changed', {
      detail: { which, kind },
    }));
  } catch {}
}

// Right-click context menu — CUT / COPY / PASTE / NEW FOLDER / RENAME /
// DELETE. Renderer-side clipboard holds {mode, paths}; PASTE walks each
// path through exploreMove (cut) or exploreCopy (copy). After cut +
// paste the clipboard clears so a second paste doesn't move ghosts.
//
// _ctxRow is whatever row was right-clicked (null if the click landed
// on empty list space). Drives whether RENAME and CUT/COPY are usable —
// those require a target; PASTE and NEW FOLDER work anywhere.
let _ctxRow = null;
const _explorerClipboard = { mode: '', paths: [] };

function _setClipboardMode(mode, paths) {
  _explorerClipboard.mode = mode;
  _explorerClipboard.paths = paths.slice();
  // Mark cut rows visually so the user remembers the pending move.
  // Plain copy doesn't get a marker — too noisy and the OS clipboard
  // doesn't show one either.
  for (const w of ['gallery', 'docs', 'downloads', 'music']) {
    const list = _exploreListEls[w];
    list?.querySelectorAll('.explore-row.is-cut').forEach((r) => r.classList.remove('is-cut'));
  }
  if (mode === 'cut') {
    for (const p of paths) {
      const esc = CSS.escape(p);
      document.querySelectorAll(`.explore-row[data-path="${esc}"]`).forEach((r) => r.classList.add('is-cut'));
    }
  }
}

async function pasteFromClipboard(which) {
  if (!_explorerClipboard.paths.length) return;
  // Destination = the current subdir of the section pasted into. This
  // mirrors how Explorer treats Ctrl+V (acts on the open folder).
  const sub  = _exploreSubdir[which] || '';
  const root = _exploreRoots[which];
  if (!root) return;
  const dest = sub ? `${root}\\${sub.replace(/\//g, '\\')}` : root;
  const mode = _explorerClipboard.mode;
  for (const src of _explorerClipboard.paths) {
    try {
      const r = mode === 'cut'
        ? await window.dash?.exploreMove?.(src, dest)
        : await window.dash?.exploreCopy?.(src, dest);
      if (!r?.ok) console.warn('[explore]', mode, 'failed:', src, r?.error);
    } catch (err) {
      console.warn('[explore] paste threw:', err?.message || err);
    }
  }
  // Cut clears the clipboard after the move; copy keeps it so the
  // user can paste the same set into multiple folders.
  if (mode === 'cut') _setClipboardMode('', []);
  notifyFilesChanged();
  refreshExploreSection(which);
}

function hideExploreCtxMenu() {
  _exploreCtxMenu?.remove();
  _exploreCtxMenu = null;
}
function showExploreCtxMenu(x, y, which) {
  hideExploreCtxMenu();
  const sel = _exploreSelected[which];
  const hasTarget = !!_ctxRow;
  const canPaste = _explorerClipboard.paths.length > 0;
  const canRename = hasTarget && sel.size === 1;
  const menu = document.createElement('div');
  menu.className = 'explore-context-menu';
  // Items: rename + cut + copy require a clicked row; paste + new
  // folder always show. Disabled items dim out and ignore clicks.
  const mk = (action, label, enabled = true) =>
    `<button type="button" class="explore-context-item${enabled ? '' : ' is-disabled'}" data-action="${action}">${label}</button>`;
  menu.innerHTML =
    mk('cut',        'CUT',         hasTarget) +
    mk('copy',       'COPY',        hasTarget) +
    mk('paste',      'PASTE',       canPaste) +
    '<div class="explore-context-sep"></div>' +
    mk('rename',     'RENAME',      canRename) +
    mk('mkdir',      'NEW FOLDER',  true) +
    '<div class="explore-context-sep"></div>' +
    mk('delete',     'DELETE',      hasTarget);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth  - r.width  - 4);
  const py = Math.min(y, window.innerHeight - r.height - 4);
  menu.style.left = `${px}px`;
  menu.style.top  = `${py}px`;
  _exploreCtxMenu = menu;
  menu.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('.explore-context-item');
    if (!btn || btn.classList.contains('is-disabled')) return;
    const a = btn.dataset.action;
    const paths = [..._exploreSelected[which]];
    if (a === 'cut') {
      _setClipboardMode('cut', paths);
    } else if (a === 'copy') {
      _setClipboardMode('copy', paths);
      copySelectedAll(which); // also push to OS clipboard for Explorer-paste
    } else if (a === 'paste') {
      pasteFromClipboard(which);
    } else if (a === 'rename') {
      const listEl = _exploreListEls[which];
      const row = listEl?.querySelector(`.explore-row[data-path="${CSS.escape(paths[0])}"]`);
      startRename(row);
    } else if (a === 'mkdir') {
      startNewFolder(which);
    } else if (a === 'delete') {
      deleteSelectedAll(which);
    }
    hideExploreCtxMenu();
  });
  menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
}
function handleExploreContextMenu(ev) {
  const row = ev.target.closest('.explore-row');
  // Right-click on empty list space is still useful — at minimum the
  // user can PASTE / NEW FOLDER there. Resolve which section from the
  // list element itself.
  const list = ev.target.closest('.explore-list');
  if (!row && !list) return;
  ev.preventDefault();
  _ctxRow = row || null;
  const which = row?.dataset.which || list?.id?.replace('explore-', '').replace('-list', '');
  if (!which) return;
  if (row && !_exploreSelected[which].has(row.dataset.path)) {
    _selectOnly(which, row.dataset.path);
  } else if (!row) {
    // Empty-area click clears the selection so PASTE / NEW FOLDER land
    // in the current folder context, not "next to" a selected file.
    _clearSelection(which);
  }
  showExploreCtxMenu(ev.clientX, ev.clientY, which);
}

// ── Drag-and-drop: row → folder move ────────────────────────────────
//
// Source: any row (file or folder). dataTransfer carries the JSON-
// encoded array of selected paths; if the dragged row isn't part of
// the current selection, the drag uses just that single path.
//
// Target: any folder row, plus the section's title-bar UP button so the
// user can yank items back up a level. Drop calls exploreMove for each
// path. We do NOT allow dropping onto a file, dropping into the same
// folder it already lives in, or dropping a folder onto its own
// descendant (those would be no-ops or errors — main rejects anyway).

let _dragPayload = null; // { which, paths }

function handleExploreDragStart(ev) {
  const row = ev.target.closest('.explore-row');
  if (!row) return;
  const which = row.dataset.which;
  const abs = row.dataset.path;
  // If the dragged row is part of the current multi-select, move the
  // whole selection. Otherwise treat the drag as that single row.
  let paths;
  if (_exploreSelected[which].has(abs)) {
    paths = [..._exploreSelected[which]];
  } else {
    paths = [abs];
    _selectOnly(which, abs);
  }
  _dragPayload = { which, paths };
  ev.dataTransfer.setData('application/x-dash-paths', JSON.stringify(paths));
  ev.dataTransfer.effectAllowed = 'move';
  row.classList.add('is-dragging');
}

function handleExploreDragEnd(ev) {
  const row = ev.target.closest('.explore-row');
  row?.classList.remove('is-dragging');
  // Drop any lingering drop-target highlight.
  document.querySelectorAll('.explore-row.is-drop-target').forEach((r) => r.classList.remove('is-drop-target'));
  _dragPayload = null;
}

function _isValidDropTarget(targetAbs, paths) {
  if (!targetAbs || !paths?.length) return false;
  for (const src of paths) {
    if (src === targetAbs) return false; // can't drop onto itself
    // Block dropping a folder onto its own descendant — main blocks
    // this too, but skipping the visual cue keeps the UX honest.
    if (targetAbs.startsWith(src + '\\') || targetAbs.startsWith(src + '/')) return false;
  }
  return true;
}

function handleExploreDragOver(ev) {
  if (!_dragPayload) return;
  const row = ev.target.closest('.explore-row');
  if (!row || row.dataset.isDir !== 'true') return;
  if (!_isValidDropTarget(row.dataset.path, _dragPayload.paths)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  // Clear other highlights, mark this one.
  document.querySelectorAll('.explore-row.is-drop-target').forEach((r) => {
    if (r !== row) r.classList.remove('is-drop-target');
  });
  row.classList.add('is-drop-target');
}

function handleExploreDragLeave(ev) {
  // dragleave fires when the cursor crosses into a child — only clear
  // the highlight when the cursor actually leaves the row's bounds.
  const row = ev.target.closest('.explore-row');
  if (!row) return;
  const rect = row.getBoundingClientRect();
  const x = ev.clientX, y = ev.clientY;
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    row.classList.remove('is-drop-target');
  }
}

async function handleExploreDrop(ev) {
  if (!_dragPayload) return;
  const row = ev.target.closest('.explore-row');
  if (!row || row.dataset.isDir !== 'true') return;
  const dest = row.dataset.path;
  if (!_isValidDropTarget(dest, _dragPayload.paths)) return;
  ev.preventDefault();
  row.classList.remove('is-drop-target');
  const { which, paths } = _dragPayload;
  _dragPayload = null;
  for (const src of paths) {
    try {
      const r = await window.dash?.exploreMove?.(src, dest);
      if (!r?.ok) console.warn('[explore] move failed:', src, '→', dest, r?.error);
    } catch (err) {
      console.warn('[explore] move threw:', err?.message || err);
    }
  }
  _clearSelection(which);
  notifyFilesChanged(which, 'move');
  refreshExploreSection(which);
}

function bindExploreActionButtons(attr, handler) {
  explorePane?.querySelectorAll(`[${attr}]`).forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    btn.addEventListener('click', () => handler(btn.getAttribute(attr), btn));
  });
}

// ── Right-side info panel ────────────────────────────────────────────
//
// Shows a larger preview + file details for the most-recently-clicked
// file. Videos load with native <video controls> for built-in scrub.
// Panel width is user-adjustable via the resize handle on its left
// edge; the width is persisted under cfg.exploreInfoWidth.

function _fmtDuration(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
           : `${m}:${String(s).padStart(2,'0')}`;
}
function _fmtDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function _entryByPath(which, abs) {
  return _rawEntries[which]?.find((e) => e.path === abs) || null;
}

function _renderInfoDetails(rows) {
  if (!exploreInfoDetails) return;
  exploreInfoDetails.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.className = 'explore-info-k';
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.className = 'explore-info-v';
    dd.textContent = v == null ? '—' : String(v);
    exploreInfoDetails.appendChild(dt);
    exploreInfoDetails.appendChild(dd);
  }
}

function _clearInfoPanel() {
  _exploreInfoCurrent = null;
  if (exploreInfoImg) { exploreInfoImg.hidden = true; exploreInfoImg.removeAttribute('src'); }
  if (exploreInfoVid) {
    try { exploreInfoVid.pause(); } catch {}
    exploreInfoVid.hidden = true;
    exploreInfoVid.removeAttribute('src');
    try { exploreInfoVid.load(); } catch {}
  }
  if (exploreInfoPlaceholder) {
    exploreInfoPlaceholder.hidden = false;
    exploreInfoPlaceholder.textContent = 'SELECT A FILE';
  }
  if (exploreInfoName) exploreInfoName.textContent = '—';
  _renderInfoDetails([]);
  _setBatchRenameVisibility(null);
}

function _showMultiSelection(which) {
  const sel = _exploreSelected[which];
  const items = [...sel]
    .map((p) => _entryByPath(which, p))
    .filter(Boolean);
  if (exploreInfoImg) { exploreInfoImg.hidden = true; exploreInfoImg.removeAttribute('src'); }
  if (exploreInfoVid) {
    try { exploreInfoVid.pause(); } catch {}
    exploreInfoVid.hidden = true;
    exploreInfoVid.removeAttribute('src');
  }
  if (exploreInfoPlaceholder) {
    exploreInfoPlaceholder.hidden = false;
    exploreInfoPlaceholder.textContent = `${items.length} ITEMS`;
  }
  if (exploreInfoName) exploreInfoName.textContent = `${items.length} items selected`;
  const totalSize = items.reduce((acc, e) => acc + (e.isDir ? 0 : (e.size || 0)), 0);
  const fileCount = items.filter((e) => !e.isDir).length;
  const dirCount  = items.filter((e) => e.isDir).length;
  _renderInfoDetails([
    ['ITEMS',  String(items.length)],
    ['FILES',  String(fileCount)],
    ['FOLDERS', String(dirCount)],
    ['TOTAL',  fileCount ? deps.fmtBytes(totalSize) : '—'],
  ]);
  _setBatchRenameVisibility(which);
}

// Batch-rename tool visibility + button text. Shown only when 2+ items
// are selected in the active section. Button label always quotes the
// live count so the user knows how many will be touched.
function _setBatchRenameVisibility(which) {
  if (!exploreBatchRenameWrap) return;
  const sel = which ? _exploreSelected[which] : null;
  const n = sel ? sel.size : 0;
  if (n >= 2) {
    exploreBatchRenameWrap.hidden = false;
    if (exploreBatchRenameBtn) exploreBatchRenameBtn.textContent = `RENAME ${n} FILES`;
    exploreBatchRenameWrap.dataset.which = which;
  } else {
    exploreBatchRenameWrap.hidden = true;
    if (exploreBatchRenameStatus) {
      exploreBatchRenameStatus.textContent = '';
      exploreBatchRenameStatus.classList.remove('is-error');
    }
  }
}

// Run a batch rename: for every selected file (sorted by original
// path), build "<base>_<index>.<ext>" with zero-padded index. Width of
// the index pad is chosen by the total count's digit length (10 files
// → 01, 100 files → 001). Folders in the selection are skipped — only
// files get renamed. Issues a single notifyFilesChanged at the end so
// every dependent view (gallery, music, edit-room bins) refreshes once.
async function _runBatchRename() {
  if (!exploreBatchRenameWrap || exploreBatchRenameWrap.hidden) return;
  const which = exploreBatchRenameWrap.dataset.which;
  if (!which) return;
  const baseRaw = (exploreBatchRenameInput?.value || '').trim();
  const setStatus = (msg, isErr) => {
    if (!exploreBatchRenameStatus) return;
    exploreBatchRenameStatus.textContent = msg;
    exploreBatchRenameStatus.classList.toggle('is-error', !!isErr);
  };
  if (!baseRaw) { setStatus('NEEDS A BASE NAME', true); return; }
  // Reject path separators (we only rename inside the source folder).
  if (/[\\/]/.test(baseRaw)) { setStatus('NAME CAN\'T CONTAIN / OR \\', true); return; }
  // Snapshot the selection so concurrent UI changes don't race the loop.
  const sel = [..._exploreSelected[which]];
  // Sort by entry order (matches what the user sees), filter out dirs.
  const entries = _exploreEntries[which]
    .filter((e) => sel.includes(e.path) && !e.isDir);
  if (entries.length < 2) { setStatus('NEED 2+ FILES SELECTED', true); return; }
  const padW = Math.max(3, String(entries.length).length);
  exploreBatchRenameBtn.disabled = true;
  let ok = 0;
  let lastErr = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const dot = e.name.lastIndexOf('.');
    const ext = dot > 0 ? e.name.slice(dot) : '';
    const idx = String(i + 1).padStart(padW, '0');
    const next = `${baseRaw}_${idx}${ext}`;
    setStatus(`RENAMING ${i + 1}/${entries.length}…`, false);
    try {
      const r = await window.dash?.exploreRename?.(e.path, next);
      if (r?.ok) ok++;
      else lastErr = r?.error || 'unknown';
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }
  exploreBatchRenameBtn.disabled = false;
  if (ok === entries.length) {
    setStatus(`RENAMED ${ok} FILES`, false);
    exploreBatchRenameInput.value = '';
  } else {
    setStatus(`RENAMED ${ok}/${entries.length} · ${lastErr}`.toUpperCase(), true);
  }
  // Selection paths are now stale — drop them and refresh. notify
  // first so cross-room listeners (music / visualizer) repopulate
  // their own lists; refreshExploreSection re-renders this section
  // immediately so the user sees the new names without switching tabs.
  _exploreSelected[which] = new Set();
  _exploreAnchor[which] = null;
  notifyFilesChanged(which, 'rename');
  refreshExploreSection(which);
}

function _updateInfoPanel(which) {
  if (!exploreInfoPanel) return;
  const sel = _exploreSelected[which];
  if (!sel || sel.size === 0) { _clearInfoPanel(); return; }
  if (sel.size > 1) { _showMultiSelection(which); return; }
  // Single-select case — hide the batch tool (n < 2).
  _setBatchRenameVisibility(null);
  const abs = _exploreAnchor[which] || [...sel][0];
  const entry = _entryByPath(which, abs);
  if (!entry) { _clearInfoPanel(); return; }
  _exploreInfoCurrent = { which, abs, name: entry.name, rel: entry.rel, size: entry.size, mtime: entry.mtime, isDir: entry.isDir };
  if (exploreInfoName) exploreInfoName.textContent = entry.name;
  // Preview routing: image → <img> via dash3d-file://; video → <video>
  // via dash3d-file:// (native controls); thumb-via-ffmpeg formats →
  // <img> via dash3d-thumb:// (still preview only — they're not <video>-
  // playable so no scrubbing for them).
  if (exploreInfoImg) { exploreInfoImg.hidden = true; exploreInfoImg.removeAttribute('src'); }
  if (exploreInfoVid) {
    try { exploreInfoVid.pause(); } catch {}
    exploreInfoVid.hidden = true;
    exploreInfoVid.removeAttribute('src');
    try { exploreInfoVid.load(); } catch {}
  }
  if (exploreInfoPlaceholder) exploreInfoPlaceholder.hidden = true;
  if (entry.isDir) {
    if (exploreInfoPlaceholder) {
      exploreInfoPlaceholder.hidden = false;
      exploreInfoPlaceholder.textContent = '▣ FOLDER';
    }
  } else if (_VIDEO_RENDER_RE.test(entry.name)) {
    if (exploreInfoVid) {
      exploreInfoVid.hidden = false;
      exploreInfoVid.src = `dash3d-file://${which}/${encodeURI(entry.rel || entry.name)}`;
      try { exploreInfoVid.load(); } catch {}
    }
  } else if (_IMG_RENDER_RE.test(entry.name)) {
    if (exploreInfoImg) {
      exploreInfoImg.hidden = false;
      exploreInfoImg.src = `dash3d-file://${which}/${encodeURI(entry.rel || entry.name)}`;
    }
  } else if (_THUMB_VIA_FFMPEG_RE.test(entry.name)) {
    if (exploreInfoImg) {
      exploreInfoImg.hidden = false;
      // Same cached jpeg the grid view loads — already at thumbnail
      // resolution (240px wide). It'll be upscaled to fit the info
      // pane preview, which is fine for a quick visual; the user can
      // double-click to open the full viewer for a real-size view.
      exploreInfoImg.src = `dash3d-thumb://${which}/${encodeURI(entry.rel || entry.name)}`;
    }
  } else {
    if (exploreInfoPlaceholder) {
      exploreInfoPlaceholder.hidden = false;
      const ext = extOf(entry.name) || '?';
      exploreInfoPlaceholder.textContent = ext;
    }
  }
  // Details rows. DIMENSIONS / DURATION are filled in lazily via
  // metadata-load events on the <img>/<video> below.
  const ext = extOf(entry.name) || (entry.isDir ? '' : '—');
  const rows = [
    ['TYPE',     entry.isDir ? 'FOLDER' : (ext.toUpperCase() || 'FILE')],
    ['SIZE',     entry.isDir ? '—' : deps.fmtBytes(entry.size || 0)],
    ['MODIFIED', _fmtDate(entry.mtime)],
    ['PATH',     entry.path],
  ];
  _renderInfoDetails(rows);
  // Pick up real dimensions / duration once the asset loads. We push a
  // single DIMENSIONS row at the front of the details after dimensions
  // resolve to avoid re-rendering the whole list as the user scrolls.
  if (exploreInfoImg && !exploreInfoImg.hidden) {
    const onLoad = () => {
      const w = exploreInfoImg.naturalWidth | 0;
      const h = exploreInfoImg.naturalHeight | 0;
      if (w && h) _renderInfoDetails([['DIMS', `${w}×${h}`], ...rows]);
    };
    if (exploreInfoImg.complete) onLoad();
    else exploreInfoImg.addEventListener('load', onLoad, { once: true });
  }
  if (exploreInfoVid && !exploreInfoVid.hidden) {
    const onMeta = () => {
      const w = exploreInfoVid.videoWidth | 0;
      const h = exploreInfoVid.videoHeight | 0;
      const d = exploreInfoVid.duration;
      const extra = [];
      if (w && h) extra.push(['DIMS', `${w}×${h}`]);
      if (Number.isFinite(d) && d > 0) extra.push(['DURATION', _fmtDuration(d)]);
      _renderInfoDetails([...extra, ...rows]);
    };
    exploreInfoVid.addEventListener('loadedmetadata', onMeta, { once: true });
  }
}

// Drag-to-resize on the info panel. Pointer events keep capture across
// the whole pane so the cursor doesn't lose the handle when the user
// flicks the mouse. Width clamps to [180, 60% of pane] to keep both
// columns usable.
function _setInfoWidth(px) {
  if (!explorePane) return;
  const paneRect = explorePane.getBoundingClientRect();
  const max = Math.max(220, Math.floor(paneRect.width * 0.6));
  const min = 180;
  const v = Math.max(min, Math.min(max, Math.round(px)));
  explorePane.style.setProperty('--explore-info-width', `${v}px`);
}
function _initInfoResize() {
  if (!exploreInfoResize || !exploreInfoPanel) return;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  exploreInfoResize.addEventListener('pointerdown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    startW = exploreInfoPanel.getBoundingClientRect().width;
    exploreInfoResize.classList.add('is-dragging');
    exploreInfoResize.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  });
  exploreInfoResize.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    // Dragging LEFT widens the right panel (negative dx). Match the
    // user's mental model: pull-handle-left → panel-grows-left.
    const dx = ev.clientX - startX;
    _setInfoWidth(startW - dx);
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    exploreInfoResize.classList.remove('is-dragging');
    const w = exploreInfoPanel.getBoundingClientRect().width;
    try { window.dash?.setConfig?.({ exploreInfoWidth: Math.round(w) }); } catch {}
  };
  exploreInfoResize.addEventListener('pointerup',     finish);
  exploreInfoResize.addEventListener('pointercancel', finish);
}

export async function init(d) {
  if (_ready) return;
  deps = d || {};
  explorePane            = document.querySelector('.combo-pane-explore');
  exploreGalleryListEl   = document.getElementById('explore-gallery-list');
  exploreDocsListEl      = document.getElementById('explore-docs-list');
  exploreDownloadsListEl = document.getElementById('explore-downloads-list');
  exploreMusicListEl     = document.getElementById('explore-music-list');
  exploreGalleryPathEl   = document.getElementById('explore-gallery-path');
  exploreDocsPathEl      = document.getElementById('explore-docs-path');
  exploreDownloadsPathEl = document.getElementById('explore-downloads-path');
  exploreMusicPathEl     = document.getElementById('explore-music-path');
  exploreViewerEl        = document.getElementById('explore-viewer');
  exploreViewerNameEl    = document.getElementById('explore-viewer-name');
  exploreViewerImgEl     = document.getElementById('explore-viewer-img');
  exploreViewerVidEl     = document.getElementById('explore-viewer-vid');
  exploreViewerCloseBtn  = document.getElementById('explore-viewer-close-btn');
  exploreViewerFsBtn     = document.getElementById('explore-viewer-fs-btn');
  exploreViewerPopoutBtn = document.getElementById('explore-viewer-popout-btn');
  exploreInfoPanel        = document.getElementById('explore-info-panel');
  exploreInfoResize       = document.getElementById('explore-info-resize');
  exploreInfoImg          = document.getElementById('explore-info-img');
  exploreInfoVid          = document.getElementById('explore-info-vid');
  exploreInfoPlaceholder  = document.getElementById('explore-info-placeholder');
  exploreInfoName         = document.getElementById('explore-info-name');
  exploreInfoDetails      = document.getElementById('explore-info-details');
  exploreBatchRenameWrap   = document.getElementById('explore-batch-rename');
  exploreBatchRenameInput  = document.getElementById('explore-batch-rename-input');
  exploreBatchRenameBtn    = document.getElementById('explore-batch-rename-btn');
  exploreBatchRenameStatus = document.getElementById('explore-batch-rename-status');
  exploreBatchRenameBtn?.addEventListener('click', () => { _runBatchRename(); });
  exploreBatchRenameInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); _runBatchRename(); }
  });
  _exploreListEls = {
    gallery:   exploreGalleryListEl,
    docs:      exploreDocsListEl,
    downloads: exploreDownloadsListEl,
    music:     exploreMusicListEl,
  };
  _explorePathEls = {
    gallery:   exploreGalleryPathEl,
    docs:      exploreDocsPathEl,
    downloads: exploreDownloadsPathEl,
    music:     exploreMusicPathEl,
  };

  explorePane?.querySelectorAll('.explore-tab').forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    btn.addEventListener('click', () => setExploreTab(btn.dataset.exploreTabBtn));
  });

  // Viewer controls — × close, Esc close, F fullscreen, ⇱ pop-out.
  exploreViewerCloseBtn?.addEventListener('click', _closeExploreViewer);
  document.addEventListener('keydown', (ev) => {
    if (!exploreViewerEl || exploreViewerEl.hidden) return;
    if (ev.key === 'Escape' && !document.fullscreenElement) {
      _closeExploreViewer();
    } else if ((ev.key === 'f' || ev.key === 'F') && !ev.metaKey && !ev.ctrlKey) {
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
      ev.preventDefault();
      _toggleExploreViewerFullscreen();
    }
  });
  exploreViewerFsBtn?.addEventListener('click', _toggleExploreViewerFullscreen);
  // ⇱ pop-out — frameless overlay window for images, OS app for videos.
  exploreViewerPopoutBtn?.addEventListener('click', () => {
    const cur = _exploreViewerCurrent;
    if (!cur) return;
    if (_IMG_RENDER_RE.test(cur.name) && window.dash?.openImageViewer) {
      window.dash.openImageViewer(cur.abs).catch(() => {});
    } else {
      window.dash?.shellOpenPath?.(cur.abs).catch(() => {});
    }
  });

  for (const listEl of Object.values(_exploreListEls)) {
    if (!listEl) continue;
    listEl.addEventListener('click',       handleExploreRowClick);
    listEl.addEventListener('dblclick',    handleExploreRowDblClick);
    listEl.addEventListener('dblclick',    handleNameDblClick);
    listEl.addEventListener('contextmenu', handleExploreContextMenu);
    // Drag-and-drop via event delegation — rows are re-created on
    // every refresh so per-row listeners would leak.
    listEl.addEventListener('dragstart', handleExploreDragStart);
    listEl.addEventListener('dragend',   handleExploreDragEnd);
    listEl.addEventListener('dragover',  handleExploreDragOver);
    listEl.addEventListener('dragleave', handleExploreDragLeave);
    listEl.addEventListener('drop',      handleExploreDrop);
  }
  document.addEventListener('keydown', handleExploreKeydown);
  document.addEventListener('mousedown', (ev) => {
    if (_exploreCtxMenu && !_exploreCtxMenu.contains(ev.target)) hideExploreCtxMenu();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _exploreCtxMenu) hideExploreCtxMenu();
  });

  bindExploreActionButtons('data-explore-refresh', (which) => refreshExploreSection(which));
  bindExploreActionButtons('data-explore-up',      (which) => navigateUp(which));
  bindExploreActionButtons('data-explore-mkdir',   (which) => startNewFolder(which));
  bindExploreActionButtons('data-explore-delete',  (which) => deleteSelectedAll(which));
  bindExploreActionButtons('data-explore-open', async (which) => {
    const pathFn = _explorePathBridges[which]?.();
    const root = await pathFn?.();
    const sub = _exploreSubdir[which] || '';
    const target = sub ? `${root}\\${sub.replace(/\//g, '\\')}` : root;
    if (target) window.dash?.shellOpenPath?.(target).catch(() => {});
  });
  // View mode (grid / list) — click on either of the two buttons sets
  // the section's view to that mode. Re-rendering picks up the new
  // layout AND swaps in the right per-row template (grid tile vs
  // detail row).
  bindExploreActionButtons('data-explore-view', (which, btn) => {
    const mode = btn.dataset.mode === 'list' ? 'list' : 'grid';
    if (_exploreView[which] === mode) return;
    _exploreView[which] = mode;
    _persistViewState();
    renderExploreList(which, { entries: _rawEntries[which] || _exploreEntries[which] || [] });
  });
  // Sort field — re-renders the same fetched entries with the new key
  // (no IPC re-fetch needed; we cache the raw result in _rawEntries).
  explorePane?.querySelectorAll('[data-explore-sort]').forEach((sel) => {
    sel.addEventListener('mousedown', (ev) => ev.stopPropagation());
    sel.addEventListener('change', () => {
      const which = sel.dataset.exploreSort;
      _exploreSort[which] = sel.value;
      _persistViewState();
      renderExploreList(which, { entries: _rawEntries[which] || [] });
    });
  });
  // Sort direction — toggles asc/desc for the current field.
  bindExploreActionButtons('data-explore-sort-dir', (which) => {
    _exploreSortDir[which] = _exploreSortDir[which] === 'desc' ? 'asc' : 'desc';
    _persistViewState();
    renderExploreList(which, { entries: _rawEntries[which] || [] });
  });
  // Thumbnail size slider — applies live (input event) for instant
  // feedback while dragging. Persist on the value AT the input event;
  // dragging fires often enough that we don't need a separate "change"
  // commit (and it lets the user undo by dragging back).
  explorePane?.querySelectorAll('[data-explore-thumb-size]').forEach((slider) => {
    slider.addEventListener('mousedown', (ev) => ev.stopPropagation());
    slider.addEventListener('input', () => {
      const which = slider.dataset.exploreThumbSize;
      _exploreThumbSize[which] = Number(slider.value) || 140;
      _applyViewMode(which);
      _persistViewState();
    });
  });

  // Resize-drag on the info panel handle (sets --explore-info-width).
  _initInfoResize();

  // Restore the saved section tab + per-section view state + info
  // panel width. Defaults: gallery grid, docs/downloads/music list,
  // 280px info panel.
  try {
    const cfg = await window.dash?.getConfig?.();
    setExploreTab(cfg?.exploreTab || 'gallery', false);
    for (const w of ['gallery', 'docs', 'downloads', 'music']) {
      const v = cfg?.exploreViews?.[w];
      if (v === 'grid' || v === 'list') _exploreView[w] = v;
      const s = cfg?.exploreSorts?.[w];
      if (s === 'name' || s === 'date' || s === 'size' || s === 'type') _exploreSort[w] = s;
      const d = cfg?.exploreSortDirs?.[w];
      if (d === 'asc' || d === 'desc') _exploreSortDir[w] = d;
      const t = Number(cfg?.exploreThumbSizes?.[w]);
      if (Number.isFinite(t) && t >= 80 && t <= 260) _exploreThumbSize[w] = t;
      _applyViewMode(w);
    }
    const iw = Number(cfg?.exploreInfoWidth);
    if (Number.isFinite(iw) && iw > 0) _setInfoWidth(iw);
  } catch { setExploreTab('gallery', false); }
  _clearInfoPanel();

  _ready = true;
}

export function activate() { if (_ready) refreshExplore(); }
