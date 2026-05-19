// EXPLORE tab · in-panel mini-Explorer for the gallery / docs / downloads
// roots. Lazy combo pane — app.js dynamically import()s this on the first
// EXPLORE tab open. init() receives injected deps from app.js:
//   fmtBytes(n)     — byte-size formatter (shared dashboard helper)
//   pushUndo(batch) — hand a delete batch to the VISUALIZER undo stack
//
//   init(deps)  — one-time: grab elements, wire listeners, restore tab
//   activate()  — EXPLORE tab shown: re-list every section

let deps = {};
let explorePane;
let exploreGalleryListEl, exploreDocsListEl, exploreDownloadsListEl, exploreMusicListEl;
let exploreGalleryPathEl, exploreDocsPathEl, exploreDownloadsPathEl, exploreMusicPathEl;
let exploreViewerEl, exploreViewerNameEl, exploreViewerImgEl, exploreViewerVidEl;
let exploreViewerCloseBtn, exploreViewerFsBtn, exploreViewerPopoutBtn;
let _exploreListEls = {};
let _explorePathEls = {};
let _ready = false;

// Per-section state. Pure data — safe to initialise at module load.
const _exploreSubdir   = { gallery: '', docs: '', downloads: '', music: '' };
const _exploreSelected = { gallery: new Set(), docs: new Set(), downloads: new Set(), music: new Set() };
const _exploreAnchor   = { gallery: null, docs: null, downloads: null, music: null };
const _exploreEntries  = { gallery: [], docs: [], downloads: [], music: [] };
const _exploreRoots    = { gallery: '',  docs: '',  downloads: '', music: '' };
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

// Image extensions Chromium can render via <img>. TIFF / PSD aren't in
// the native set so they render as a styled "PSD"/"TIF" placeholder tile.
const _IMG_RENDER_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const _IMG_KNOWN_RE  = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|psd|heic|heif|raw|cr2|nef|arw)$/i;
// Video extensions. First regex = what Chromium plays in a <video>; second
// catches anything we keep OUT of the gallery thumb view. .mkv included so
// our own screen-record output (WebM bytes in a .mkv) plays inline.
const _VIDEO_RENDER_RE = /\.(mp4|webm|m4v|ogv|ogg|mov|mkv)$/i;
const _VIDEO_KNOWN_RE  = /\.(mp4|webm|m4v|ogv|ogg|mov|avi|mkv|wmv|flv|3gp|3g2|asf)$/i;
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
  // Gallery hides video files — those route to the VISUALIZER tab so the
  // thumbnail grid stays image-only. Folders / non-video files pass through.
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
    // Relative-to-managed-root path for dash3d-file:// URLs.
    if (e.rel) row.dataset.rel = e.rel;
    row.title = e.path;
    if (isGallery) {
      const preview = document.createElement('div');
      preview.className = 'explore-thumb-preview';
      const ext = (e.name.match(/\.([^.]+)$/) || [])[1]?.toUpperCase() || '';
      if (e.isDir) {
        preview.innerHTML = '<span class="explore-thumb-icon">▣</span>';
      } else if (_IMG_RENDER_RE.test(e.name)) {
        // Real preview via the dash3d-file:// scheme (registered in main).
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
  if (batch.length) deps.pushUndo?.(batch);
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

// Right-click context menu — COPY + DELETE.
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

function bindExploreActionButtons(attr, handler) {
  explorePane?.querySelectorAll(`[${attr}]`).forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    btn.addEventListener('click', () => handler(btn.getAttribute(attr)));
  });
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

  // Restore the saved section tab (was a config-restore call in app.js).
  try {
    const cfg = await window.dash?.getConfig?.();
    setExploreTab(cfg?.exploreTab || 'gallery', false);
  } catch { setExploreTab('gallery', false); }

  _ready = true;
}

export function activate() { if (_ready) refreshExplore(); }
