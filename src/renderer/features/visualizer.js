// VISUALIZER / REC ROOM tab · in-pane video player + screen recorder +
// screencap + clip editor. Lazy combo pane — app.js dynamically import()s
// this on the first VISUALIZER open. init() receives { fmtBytes, playSfx }.
//
//   init(deps)  — one-time: build the pane, wire IPC + buttons
//   activate()  — VISUALIZER tab shown: refresh the gallery file list
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
  const visualizerNowEl = document.getElementById('visualizer-now');
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
    for (const e of entries) {
      const row = document.createElement('li');
      row.className = 'visualizer-row'
        + (e.isDir ? ' is-dir' : '')
        + (_visualizerCurrent === e.path ? ' is-playing' : '')
        + (_visualizerSelected.has(e.path) ? ' is-selected' : '');
      row.dataset.path  = e.path;
      row.dataset.rel   = e.rel;
      row.dataset.isDir = String(e.isDir);
      row.dataset.name  = e.name;
      row.title = e.path;
      // Make video AND image rows draggable into the editor's
      // timeline. The custom mime carries the path + a `kind` token so
      // the drop target knows whether to set up a video or still-image
      // clip without re-checking the extension.
      const isVidRow = !e.isDir && _VIDEO_RENDER_RE.test(e.name);
      const isImgRow = !e.isDir && _IMG_RENDER_RE.test(e.name);
      if (isVidRow || isImgRow) {
        row.draggable = true;
        row.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('application/x-dash3d-capture', e.path);
          ev.dataTransfer.setData('application/x-dash3d-kind', isImgRow ? 'image' : 'video');
          ev.dataTransfer.setData('text/plain', e.name);
          ev.dataTransfer.effectAllowed = 'copy';
        });
      }
      // Lead glyph hints at the type without taking grid space.
      const glyph = e.isDir ? '▣ '
        : _VIDEO_KNOWN_RE.test(e.name) ? '▶ '
        : _IMG_KNOWN_RE.test(e.name) ? '◇ '
        : '∙ ';
      row.innerHTML =
        `<span class="visualizer-row-name">${glyph}${e.name.replace(/</g, '&lt;')}</span>` +
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
    // the full frame, not a cropped subregion. Mirror the click-handler
    // side-effects so the toggle button, overlay, and FIT view all
    // reflect the new state.
    if (_cropActive) {
      _cropActive = false;
      const btn = document.getElementById('visualizer-crop-btn');
      if (btn) {
        btn.classList.remove('is-active');
        btn.textContent = 'CROP';
      }
      try { _refreshCropFitView(); } catch {}
    }
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
    // Honour the saved mute preference — without this, the element
    // would inherit the force-mute it picked up during a prior mirror
    // session and recordings would play silently.
    if (typeof _applyMute === 'function') _applyMute(!!_recRoomMutedPref);
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
  // (auto-fit always wins now — no manual portrait/landscape toggle)
  // and the FIT-crop preview pipeline below.
  let _lastSourceW = 0;
  let _lastSourceH = 0;
  let _cropFitActive = false;
  function _refreshWrapShape() {
    if (!visualizerWrapEl) return;
    // FIT+CROP active → wrap reshapes to the crop region's pixel
    // aspect, so the cropped fill fills the wrap with no letterbox.
    // Otherwise → wrap matches the raw source aspect.
    let w = 0, h = 0;
    if (_cropFitActive && _cropActive && _lastSourceW > 0 && _lastSourceH > 0) {
      w = Math.max(1, _cropRect.w * _lastSourceW);
      h = Math.max(1, _cropRect.h * _lastSourceH);
    } else if (_lastSourceW > 0 && _lastSourceH > 0) {
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

  // ── Transport controls ──────────────────────────────────────────────
  // List of playable video entries from the current view. Used by the
  // play/pause + prev/next transport so they skip over folders and
  // image files that the gallery browser also surfaces.
  function _playableEntries() {
    return _visualizerEntries.filter((e) => !e.isDir && _VIDEO_KNOWN_RE.test(e.name));
  }
  function togglePlayPause() {
    if (!visualizerVideoEl) return;
    if (!visualizerVideoEl.currentSrc) {
      const first = _playableEntries()[0];
      if (first) playVisualizerEntry(first);
      return;
    }
    if (visualizerVideoEl.paused) {
      // Log a rejected play() — it used to be silently swallowed,
      // which made "click play, nothing happens" indistinguishable
      // from a real bug. Now we'll see the actual reason in dev
      // tools (autoplay-policy, unsupported codec, etc.).
      visualizerVideoEl.play().catch((err) => {
        console.warn('[rec-room] play() rejected:', err?.name, err?.message);
      });
    }
    else visualizerVideoEl.pause();
  }
  function playRelative(step) {
    const playable = _playableEntries();
    if (!playable.length) return;
    const idx = playable.findIndex((e) => e.path === _visualizerCurrent);
    let nextIdx;
    if (idx < 0) {
      nextIdx = step > 0 ? 0 : playable.length - 1;
    } else {
      nextIdx = (idx + step + playable.length) % playable.length;
    }
    playVisualizerEntry(playable[nextIdx]);
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

  // ── Themed playback control bar ──────────────────────────────────────
  // Drives #visualizer-pc (the dashboard-styled replacement for the
  // native <video> controls): play/pause, scrub seek, time, volume,
  // fullscreen. Only shown for seekable file playback — hidden during
  // the live mirror and still-image view.
  const _pcEl      = document.getElementById('visualizer-pc');
  const _pcPlayBtn = document.getElementById('vis-pc-play');
  const _pcCurEl   = document.getElementById('vis-pc-cur');
  const _pcDurEl   = document.getElementById('vis-pc-dur');
  const _pcSeekEl  = document.getElementById('vis-pc-seek');
  const _pcFillEl  = document.getElementById('vis-pc-fill');
  const _pcBufEl   = document.getElementById('vis-pc-buffered');
  const _pcKnobEl  = document.getElementById('vis-pc-knob');
  const _pcMuteBtn = document.getElementById('vis-pc-mute');
  const _pcVolEl   = document.getElementById('vis-pc-vol');
  const _pcFsBtn   = document.getElementById('vis-pc-fs');

  function _fmtClock(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  // Two-SVG toggle buttons: svg[0] is the default glyph, svg[1] the
  // alternate. `alt` true shows the second.
  function _pcSwapIcon(btn, alt) {
    const svgs = btn?.querySelectorAll('svg');
    if (!svgs || svgs.length < 2) return;
    svgs[0].hidden = !!alt;
    svgs[1].hidden = !alt;
  }
  // Bar applies only to a real file source — a live mirror sets
  // srcObject (not seekable) and stills have no <video> src at all.
  function _pcVisible() {
    return !!(visualizerVideoEl && visualizerVideoEl.src && !visualizerVideoEl.srcObject);
  }
  function _pcSync() {
    if (!_pcEl) return;
    const show = _pcVisible();
    _pcEl.hidden = !show;
    if (!show) return;
    const v = visualizerVideoEl;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const cur = v.currentTime || 0;
    const frac = dur > 0 ? Math.min(1, cur / dur) : 0;
    if (_pcFillEl) _pcFillEl.style.width = `${frac * 100}%`;
    if (_pcKnobEl) _pcKnobEl.style.left  = `${frac * 100}%`;
    if (_pcCurEl)  _pcCurEl.textContent  = _fmtClock(cur);
    if (_pcDurEl)  _pcDurEl.textContent  = _fmtClock(dur);
    if (_pcBufEl) {
      let bufFrac = 0;
      try {
        const b = v.buffered;
        if (b && b.length && dur > 0) bufFrac = Math.min(1, b.end(b.length - 1) / dur);
      } catch {}
      _pcBufEl.style.width = `${bufFrac * 100}%`;
    }
    _pcSwapIcon(_pcPlayBtn, !v.paused);
    _pcSwapIcon(_pcMuteBtn, v.muted || v.volume === 0);
    if (_pcVolEl && document.activeElement !== _pcVolEl) {
      _pcVolEl.value = String(Math.round((v.muted ? 0 : v.volume) * 100));
    }
  }
  // Scrub: pointer drag anywhere on the seek track maps x → currentTime.
  let _pcScrubbing = false;
  function _pcSeekToEvent(ev) {
    if (!_pcSeekEl || !visualizerVideoEl) return;
    const r = _pcSeekEl.getBoundingClientRect();
    if (r.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const dur = visualizerVideoEl.duration;
    if (Number.isFinite(dur) && dur > 0) {
      try { visualizerVideoEl.currentTime = frac * dur; } catch {}
    }
    _pcSync();
  }
  _pcSeekEl?.addEventListener('pointerdown', (ev) => {
    _pcScrubbing = true;
    _pcSeekEl.classList.add('is-scrubbing');
    try { _pcSeekEl.setPointerCapture(ev.pointerId); } catch {}
    _pcSeekToEvent(ev);
  });
  _pcSeekEl?.addEventListener('pointermove', (ev) => { if (_pcScrubbing) _pcSeekToEvent(ev); });
  const _pcEndScrub = (ev) => {
    if (!_pcScrubbing) return;
    _pcScrubbing = false;
    _pcSeekEl.classList.remove('is-scrubbing');
    try { _pcSeekEl.releasePointerCapture(ev.pointerId); } catch {}
  };
  _pcSeekEl?.addEventListener('pointerup', _pcEndScrub);
  _pcSeekEl?.addEventListener('pointercancel', _pcEndScrub);
  // Arrow keys nudge ±5s when the seek bar is focused.
  _pcSeekEl?.addEventListener('keydown', (ev) => {
    if (!visualizerVideoEl) return;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const d = ev.key === 'ArrowRight' ? 5 : -5;
      try { visualizerVideoEl.currentTime = Math.max(0, (visualizerVideoEl.currentTime || 0) + d); } catch {}
    }
  });
  _pcPlayBtn?.addEventListener('click', () => { togglePlayPause(); playSfx?.('click'); });
  _pcMuteBtn?.addEventListener('click', () => {
    if (!visualizerVideoEl) return;
    visualizerVideoEl.muted = !visualizerVideoEl.muted;
    _pcSync();
  });
  _pcVolEl?.addEventListener('input', () => {
    if (!visualizerVideoEl) return;
    const vol = Math.min(1, Math.max(0, (Number(_pcVolEl.value) || 0) / 100));
    visualizerVideoEl.volume = vol;
    if (vol > 0 && visualizerVideoEl.muted) visualizerVideoEl.muted = false;
  });
  _pcFsBtn?.addEventListener('click', () => {
    const wrap = visualizerVideoEl?.closest('.visualizer-player-wrap');
    if (!wrap) return;
    if (document.fullscreenElement === wrap) {
      try { document.exitFullscreen(); } catch {}
    } else {
      try { wrap.requestFullscreen?.(); } catch {}
    }
  });
  // Keep the bar live off every relevant <video> event.
  for (const ev of ['timeupdate', 'progress', 'play', 'pause', 'loadedmetadata',
                     'loadeddata', 'emptied', 'volumechange', 'durationchange', 'seeked']) {
    visualizerVideoEl?.addEventListener(ev, _pcSync);
  }

  // List of image entries from the current view, ordered as displayed
  // (folders + the up-row are skipped). Used for shift-click range
  // selection so the range only includes selectable items.
  function _imageEntriesInView() {
    return _visualizerEntries.filter((e) => !e.isDir && _IMG_KNOWN_RE.test(e.name));
  }
  function _repaintSelection() {
    if (!visualizerListEl) return;
    for (const row of visualizerListEl.querySelectorAll('.visualizer-row')) {
      row.classList.toggle('is-selected', _visualizerSelected.has(row.dataset.path));
    }
    _refreshProcessBtn();
    _refreshDeleteBtn();
    if (typeof _refreshEditBtn === 'function') _refreshEditBtn();
  }
  function _refreshProcessBtn() {
    const btn = document.getElementById('visualizer-process-btn');
    if (!btn) return;
    // Enable when the selection has any folder (folders get expanded to
    // their image children at PROCESS time) OR ≥2 standalone images.
    let folders = 0, images = 0;
    for (const p of _visualizerSelected) {
      const ent = _visualizerEntries.find((x) => x.path === p);
      if (!ent) continue;
      if (ent.isDir) folders++;
      else if (_IMG_KNOWN_RE.test(ent.name)) images++;
    }
    btn.disabled = folders === 0 && images < 2;
    if (folders > 0) btn.textContent = `PROCESS (${folders === 1 ? 'folder' : folders + ' folders'})`;
    else if (images >= 2) btn.textContent = `PROCESS (${images})`;
    else btn.textContent = 'PROCESS';
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

  // ── Rec-room context menu: COPY (files to clipboard) + DELETE.
  // Mirrors the EXPLORE pane's right-click. COPY uses the existing
  // clipboardCopyFiles IPC (Windows CF_HDROP via PowerShell) so paths
  // can be pasted into File Explorer, Photos, chat apps, etc. If the
  // right-clicked row isn't already in the selection we switch the
  // selection to just that row first so the menu actions match what's
  // visually highlighted.
  let _recCtxMenu = null;
  function _hideRecCtxMenu() {
    _recCtxMenu?.remove();
    _recCtxMenu = null;
  }
  async function _copyVisualizerSelection() {
    const paths = [..._visualizerSelected];
    if (!paths.length) return;
    try {
      const r = await window.dash?.clipboardCopyFiles?.(paths);
      if (!r?.ok) console.warn('[rec-room] copy failed:', r?.error);
    } catch (err) { console.warn('[rec-room] copy threw:', err); }
  }
  async function _deleteVisualizerSelection() {
    const targets = _visualizerSelected.size
      ? [..._visualizerSelected]
      : (_visualizerCurrent ? [_visualizerCurrent] : []);
    if (!targets.length) return;
    if (_visualizerCurrent && targets.includes(_visualizerCurrent)) {
      try { visualizerVideoEl?.pause(); } catch {}
      try { visualizerVideoEl?.removeAttribute('src'); visualizerVideoEl?.load(); } catch {}
      _visualizerCurrent = null;
      visualizerWrapEl?.classList.remove('is-playing', 'is-still');
      if (visualizerNowEl) visualizerNowEl.textContent = '—';
    }
    for (const abs of targets) {
      try {
        const r = await window.dash?.exploreDelete?.(abs);
        if (!r?.ok) console.warn('[rec-room] delete failed:', abs, r?.error);
      } catch {}
    }
    _clearVisualizerSelection();
    await refreshVisualizer();
  }
  function _showRecCtxMenu(x, y) {
    _hideRecCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'explore-context-menu';
    menu.innerHTML =
      '<button type="button" class="explore-context-item" data-action="copy">COPY</button>' +
      '<button type="button" class="explore-context-item" data-action="delete">DELETE</button>';
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth  - r.width  - 4);
    const py = Math.min(y, window.innerHeight - r.height - 4);
    menu.style.left = `${px}px`;
    menu.style.top  = `${py}px`;
    _recCtxMenu = menu;
    menu.addEventListener('click', (ev) => {
      const a = ev.target?.dataset?.action;
      if (a === 'copy')   _copyVisualizerSelection();
      if (a === 'delete') _deleteVisualizerSelection();
      _hideRecCtxMenu();
    });
    menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }
  visualizerListEl?.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.visualizer-row');
    if (!row) return;
    if (row.dataset.action === 'up' || row.dataset.isDir === 'true') return;
    ev.preventDefault();
    const p = row.dataset.path;
    if (!_visualizerSelected.has(p)) {
      _visualizerSelected = new Set([p]);
      _visualizerAnchor = p;
      _repaintSelection();
    }
    _showRecCtxMenu(ev.clientX, ev.clientY);
  });
  document.addEventListener('mousedown', (ev) => {
    if (_recCtxMenu && !_recCtxMenu.contains(ev.target)) _hideRecCtxMenu();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _recCtxMenu) _hideRecCtxMenu();
    // Delete / Ctrl+C in the rec room — only fires when the rec-room
    // list owns the active element so it doesn't conflict with the
    // explore pane or text inputs.
    const focusInList = document.activeElement === visualizerListEl
      || visualizerListEl?.contains(document.activeElement);
    const recRoomVisible = visualizerPane?.classList?.contains('is-visible');
    if (!recRoomVisible) return;
    // The visualizer list isn't normally focused (no tabindex), so also
    // accept key events when the rec-room pane is the visible mode AND
    // there's a non-empty selection — that's the user's clear signal
    // that they're acting on the rec-room.
    if (!focusInList && !_visualizerSelected.size) return;
    if (ev.target.matches?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    if (ev.key === 'Delete') {
      ev.preventDefault();
      _deleteVisualizerSelection();
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C')) {
      ev.preventDefault();
      _copyVisualizerSelection();
    }
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
  document.getElementById('visualizer-playpause-btn')?.addEventListener('click', togglePlayPause);
  document.getElementById('visualizer-prev-btn')     ?.addEventListener('click', () => playRelative(-1));
  document.getElementById('visualizer-next-btn')     ?.addEventListener('click', () => playRelative(+1));
  // Session-scoped undo stack for deletions. Each entry remembers the
  // managed-trash path + original path so a single button-click can
  // restore the most recent batch. Cleared on app restart (the file
  // remains in <root>/.trash so it's still recoverable via Empty Trash
  // → OS Recycle Bin if needed).
  // Shared with EXPLORE via window — app.js seeds window._visualizerUndoStack
  // at boot so deletes made before REC ROOM is opened still land here.
  const _visualizerUndoStack = (window._visualizerUndoStack = window._visualizerUndoStack || []);
  function _refreshUndoBtn() {
    const btn = document.getElementById('visualizer-undo-btn');
    if (!btn) return;
    btn.disabled = _visualizerUndoStack.length === 0;
    btn.textContent = _visualizerUndoStack.length > 1
      ? `UNDO (${_visualizerUndoStack.length})` : 'UNDO';
  }
  window._visualizerRefreshUndoBtn = _refreshUndoBtn;
  document.getElementById('visualizer-delete-btn')   ?.addEventListener('click', async () => {
    const targets = _visualizerSelected.size
      ? [..._visualizerSelected]
      : (_visualizerCurrent ? [_visualizerCurrent] : []);
    if (!targets.length) return;
    if (_visualizerCurrent && targets.includes(_visualizerCurrent)) {
      try { visualizerVideoEl?.pause(); } catch {}
      try { visualizerVideoEl?.removeAttribute('src'); visualizerVideoEl?.load(); } catch {}
      _visualizerCurrent = null;
      visualizerWrapEl?.classList.remove('is-playing', 'is-still');
      if (visualizerNowEl) visualizerNowEl.textContent = '—';
    }
    const batch = [];
    for (const abs of targets) {
      try {
        const r = await window.dash?.exploreDelete?.(abs);
        if (r?.ok && r.trashPath && r.origPath) {
          batch.push({ origPath: r.origPath, trashPath: r.trashPath, name: r.name });
        } else if (!r?.ok) {
          console.warn('[rec-room] delete failed:', abs, r?.error);
        }
      } catch (err) { console.warn('[rec-room] delete threw:', err); }
    }
    if (batch.length) {
      _visualizerUndoStack.push({ batch, at: Date.now() });
      _refreshUndoBtn();
      if (visualizerNowEl) visualizerNowEl.textContent = `DELETED ${batch.length} · UNDO READY`;
    }
    _clearVisualizerSelection();
    await refreshVisualizer();
  });
  document.getElementById('visualizer-undo-btn')?.addEventListener('click', async () => {
    const entry = _visualizerUndoStack.pop();
    if (!entry) return;
    _refreshUndoBtn();
    let restored = 0;
    for (const item of entry.batch) {
      try {
        const r = await window.dash?.exploreRestore?.({
          origPath: item.origPath, trashPath: item.trashPath,
        });
        if (r?.ok) restored++;
        else console.warn('[rec-room] restore failed:', item.name, r?.error);
      } catch (err) { console.warn('[rec-room] restore threw:', err); }
    }
    if (visualizerNowEl) visualizerNowEl.textContent = `RESTORED ${restored}/${entry.batch.length}`;
    await refreshVisualizer();
  });
  _refreshUndoBtn();

  // ── §rec-split ── DRAGGABLE SPLITTER ──────────────────────────────
  // Slim horizontal bar between the player/edit area and the captures
  // list. Drag it to give more vertical space to either side. The %
  // is stored in cfg.recSplitPct so it survives restarts.
  const recSplitEl = document.getElementById('visualizer-split');
  const _CLAMP = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function _applyRecSplit(pct) {
    if (!visualizerPane) return;
    const v = _CLAMP(Number(pct) || 60, 20, 85);
    visualizerPane.style.setProperty('--rec-split-pct', `${v}%`);
  }
  (async () => {
    try {
      const cfg = (await window.dash?.getConfig?.()) || {};
      if (Number.isFinite(cfg.recSplitPct)) _applyRecSplit(cfg.recSplitPct);
      else _applyRecSplit(60);
    } catch { _applyRecSplit(60); }
  })();
  let _splitDragging = false;
  let _splitStartY = 0;
  let _splitStartPct = 60;
  recSplitEl?.addEventListener('pointerdown', (e) => {
    if (!visualizerPane) return;
    _splitDragging = true;
    _splitStartY = e.clientY;
    const paneRect = visualizerPane.getBoundingClientRect();
    const curPctStr = getComputedStyle(visualizerPane).getPropertyValue('--rec-split-pct').trim();
    _splitStartPct = parseFloat(curPctStr) || 60;
    recSplitEl.classList.add('is-dragging');
    recSplitEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  recSplitEl?.addEventListener('pointermove', (e) => {
    if (!_splitDragging || !visualizerPane) return;
    const paneRect = visualizerPane.getBoundingClientRect();
    if (paneRect.height <= 0) return;
    const dy = e.clientY - _splitStartY;
    const deltaPct = (dy / paneRect.height) * 100;
    const next = _CLAMP(_splitStartPct + deltaPct, 20, 85);
    visualizerPane.style.setProperty('--rec-split-pct', `${next}%`);
  });
  function _endSplitDrag() {
    if (!_splitDragging) return;
    _splitDragging = false;
    recSplitEl?.classList.remove('is-dragging');
    if (visualizerPane) {
      const curPctStr = getComputedStyle(visualizerPane).getPropertyValue('--rec-split-pct').trim();
      const v = parseFloat(curPctStr) || 60;
      window.dash?.setConfig?.({ recSplitPct: v });
    }
  }
  recSplitEl?.addEventListener('pointerup',     _endSplitDrag);
  recSplitEl?.addEventListener('pointercancel', _endSplitDrag);

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
  // Mirror process popover filter state — same shape so the same
  // helpers serialize both into a -vf string.
  const _procFilterState = {
    auto: false,
    denoise: false,
    sliders: {
      brightness: 100, contrast: 100, saturation: 100, hue: 0, blur: 0,
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

  // Wire each track body to accept drops from the captures list.
  // The drag payload is the dragged row's data-path; we look up the
  // entry to get its name + probed duration.
  function _wireTrackDrop(trackId) {
    const trackEl = _editTrackEl(trackId);
    if (!trackEl) return;
    trackEl.addEventListener('dragover', (e) => {
      // Only accept drops if the drag carries a recording path.
      if (e.dataTransfer?.types?.includes('application/x-dash3d-capture')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        trackEl.classList.add('is-drag-over');
      }
    });
    trackEl.addEventListener('dragleave', () => trackEl.classList.remove('is-drag-over'));
    trackEl.addEventListener('drop', (e) => {
      e.preventDefault();
      trackEl.classList.remove('is-drag-over');
      const path = e.dataTransfer.getData('application/x-dash3d-capture');
      const kindHint = e.dataTransfer.getData('application/x-dash3d-kind');
      if (!path) return;
      const entry = _visualizerEntries.find((x) => x.path === path);
      if (!entry) return;
      const isVideo = _VIDEO_RENDER_RE.test(entry.name);
      const isImage = _IMG_RENDER_RE.test(entry.name);
      if (!isVideo && !isImage) return;
      // Audio track only accepts video (we pull audio out of it on export).
      if (trackId === 'A1' && isImage) return;
      const rect = trackEl.getBoundingClientRect();
      const startSec = Math.max(0, (e.clientX - rect.left) / _editProject.pxPerSec);
      if (isImage || kindHint === 'image') {
        // Images have no duration to probe — drop straight in with the
        // default duration (3s, resizable later).
        _addEditClip(trackId, { path: entry.path, name: entry.name, kind: 'image' }, startSec);
        return;
      }
      // Video: probe duration off-screen so the clip bar is sized
      // correctly even before the user previews it.
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
      probe.addEventListener('loadedmetadata', () => {
        _addEditClip(trackId, { path: entry.path, name: entry.name, kind: 'video', duration: probe.duration || 5 }, startSec);
        try { probe.remove(); } catch {}
      });
      probe.addEventListener('error', () => {
        _addEditClip(trackId, { path: entry.path, name: entry.name, kind: 'video', duration: 5 }, startSec);
        try { probe.remove(); } catch {}
      });
    });
  }

  function _initEditTimeline() {
    ['V2', 'V1', 'A1'].forEach(_wireTrackDrop);
    const fpsSel = document.getElementById('vis-edit-tl-fps');
    const resSel = document.getElementById('vis-edit-tl-res');
    const zoomEl = document.getElementById('vis-edit-tl-zoom');
    fpsSel?.addEventListener('change', () => { _editProject.fps = parseInt(fpsSel.value, 10) || 30; });
    resSel?.addEventListener('change', () => {
      const [w, h] = String(resSel.value || '1920x1080').split('x').map((n) => parseInt(n, 10));
      _editProject.width = w || 1920;
      _editProject.height = h || 1080;
    });
    zoomEl?.addEventListener('input', () => {
      _editProject.pxPerSec = parseInt(zoomEl.value, 10) || 50;
      _renderEditRuler();
      _renderEditTracks();
    });
    _renderEditRuler();
    _renderEditTracks();
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
    // The OLD inline editor here (the disabled _openEditor below) is
    // dead code now — replaced by the standalone EDIT ROOM combo-pane
    // (see features/edit.js). This button now hands the currently-
    // playing video off to EDIT ROOM via window._editHandoff and a
    // combo-mode switch. The button is enabled whenever a playable
    // video is loaded in the REC ROOM player.
    if (!editBtn) return;
    const hasVideo = _visualizerCurrent && _VIDEO_RENDER_RE.test(_visualizerCurrent);
    editBtn.hidden = false;
    editBtn.disabled = !hasVideo;
  }
  // Open editor on the current playing video or image.
  function _openEditor() {
    // Editor disabled — see _refreshEditBtn note above.
    return;
    // eslint-disable-next-line no-unreachable
    if (!_visualizerCurrent) return;
    if (!_VIDEO_RENDER_RE.test(_visualizerCurrent) && !_IMG_RENDER_RE.test(_visualizerCurrent)) return;
    _editState.src = _visualizerCurrent;
    _editState.open = true;
    document.body.classList.add('is-editing');
    // Pause the main player while editing so audio doesn't double up.
    try { visualizerVideoEl?.pause(); } catch {}
    if (editPane) editPane.hidden = false;
    if (visualizerWrapEl) visualizerWrapEl.style.display = 'none';
    const url = `dash3d-file://gallery/${encodeURI((_visualizerEntries.find((e) => e.path === _editState.src)?.rel) || '')}`;
    // Force metadata fetch (via .load()) so the video element gets its
    // intrinsic dimensions BEFORE first paint. Without this, Chromium
    // sometimes lazy-loads metadata only on first play, and the video
    // renders stretched-to-container until the user hits play.
    if (editOrigVid) { editOrigVid.src = url; try { editOrigVid.load(); } catch {} }
    if (editOutVid)  { editOutVid.src  = url; try { editOutVid.load();  } catch {} }
    if (editNameEl)  editNameEl.textContent = _editState.src.split(/[\\/]/).pop();
    if (editStatusEl) { editStatusEl.textContent = ''; editStatusEl.className = 'vis-edit-status'; }
    // Open paused — user has to press play to start. Otherwise the
    // load() above can let the video auto-start when its metadata
    // arrives (Chromium auto-resumes some preloaded media).
    try { editOrigVid?.pause(); editOutVid?.pause(); } catch {}
    try { if (editOrigVid) editOrigVid.currentTime = 0; if (editOutVid) editOutVid.currentTime = 0; } catch {}
    // Seed the V1 track with the just-opened clip so the timeline
    // isn't empty on first open.
    const seedName = _editState.src.split(/[\\/]/).pop();
    const seedKind = _IMG_RENDER_RE.test(seedName) ? 'image' : 'video';
    _editProject.tracks.V2 = [];
    _editProject.tracks.V1 = [{
      id: ++_editClipSeq,
      path: _editState.src,
      name: seedName,
      kind: seedKind,
      srcDuration: seedKind === 'image' ? 3 : 0,
      in: 0,
      out: seedKind === 'image' ? 3 : 5,
      start: 0,
      track: 'V1',
    }];
    _editProject.tracks.A1 = [];
    _editProject.selectedClipId = null;
    _editProject.duration = _editTotalDuration();
    _initEditTimeline();
    // If we opened from an image still, immediately retarget so the
    // <img> preview shows (skipping the video-load path).
    if (seedKind === 'image') _retargetEditorAnchor(_editProject.tracks.V1[0]);
    // Start each clip at fit (scale 1, no pan) — leftover pan from a
    // previous clip is rarely what the user wants.
    _editView.scale = 1; _editView.tx = 0; _editView.ty = 0;
    _applyEditPreview();
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
  // Slider wiring — generic factory so the EDIT panel and the PROCESS
  // popover use the same code path.
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
  _bindSlider('vis-proc-brightness',  'proc-brightness', _procFilterState, 'brightness', '%',  0);
  _bindSlider('vis-proc-contrast',    'proc-contrast',   _procFilterState, 'contrast',   '%',  0);
  _bindSlider('vis-proc-saturation',  'proc-saturation', _procFilterState, 'saturation', '%',  0);
  _bindSlider('vis-proc-hue',         'proc-hue',        _procFilterState, 'hue',        '°',  0);
  _bindSlider('vis-proc-blur',        'proc-blur',       _procFilterState, 'blur',       'px', 1);
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
  _wireToggle(document.getElementById('vis-proc-auto'),    _procFilterState, 'auto',    null);
  _wireToggle(document.getElementById('vis-proc-denoise'), _procFilterState, 'denoise', null);
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
  // Expose process-filter state so the existing PROCESS submission
  // can read it without us threading it through every helper.
  window._procFilterState = _procFilterState;

  // ── MUTE toggle ─────────────────────────────────────────────────
  // Drives visualizerVideoEl.muted. Persists the user's preference
  // separately from the live element state — the mirror needs to
  // force-mute (so audio doesn't double up since the source already
  // plays through the OS speakers), but that shouldn't permanently
  // override what the user picked for recording playback. _applyMute()
  // is called whenever we transition between playback modes to keep
  // the live state in sync with the saved preference.
  const muteBtn = document.getElementById('visualizer-mute-btn');
  let _recRoomMutedPref = false;
  function _paintMuteBtn(muted) {
    if (!muteBtn) return;
    muteBtn.textContent = muted ? 'SOUND' : 'MUTE';
    muteBtn.title = muted ? 'Audio muted — click to unmute' : 'Audio on — click to mute';
    muteBtn.classList.toggle('is-active', !!muted);
  }
  function _applyMute(muted) {
    if (visualizerVideoEl) visualizerVideoEl.muted = !!muted;
    _paintMuteBtn(!!muted);
  }
  muteBtn?.addEventListener('click', async () => {
    _recRoomMutedPref = !_recRoomMutedPref;
    _applyMute(_recRoomMutedPref);
    try { await window.dash?.setConfig?.({ recRoomMuted: _recRoomMutedPref }); } catch {}
    playSfx?.('click');
  });
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    _recRoomMutedPref = !!cfg.recRoomMuted;
    _applyMute(_recRoomMutedPref);
  })();


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
  const sourceBtn = document.getElementById('visualizer-source-btn');
  const sourcePickerEl = document.getElementById('visualizer-source-picker');
  const sourceListEl   = document.getElementById('visualizer-source-list');
  const sourceCloseBtn = document.getElementById('visualizer-source-close');
  const screencapBtn   = document.getElementById('visualizer-screencap-btn');
  let _mirrorStream = null;
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
    if (_mirrorStream) {
      for (const tr of _mirrorStream.getTracks()) { try { tr.stop(); } catch {} }
      _mirrorStream = null;
    }
    if (visualizerVideoEl) {
      visualizerVideoEl.srcObject = null;
    }
    mirrorBtn?.classList.remove('is-active');
    if (mirrorBtn) mirrorBtn.textContent = 'MIRROR';
    visualizerWrapEl?.classList.remove('is-mirroring');
    _mirrorSourceOverride = null;
    // Drop the dynamic source-aspect; the wrap goes back to default
    // full-pane-width sizing until the next mirror or playback.
    if (typeof _setSourceDims === 'function') _setSourceDims(0, 0);
    // Restore the user's saved mute preference now that the mirror's
    // force-mute is no longer needed.
    if (typeof _applyMute === 'function') _applyMute(!!_recRoomMutedPref);
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
    // Diagnostic — confirm what tracks Chromium actually handed us.
    // Window sources on Win32 always yield 0 audio tracks; screen
    // sources usually yield 1. The REC button surfaces this to the
    // user; the console log is the deep diagnostic.
    console.log('[mirror] started:', {
      sourceId: src.id,
      kind: src.id?.startsWith('window:') ? 'window' : src.id?.startsWith('screen:') ? 'screen' : 'unknown',
      audioTracks: _mirrorStream.getAudioTracks().length,
      videoTracks: _mirrorStream.getVideoTracks().length,
    });
    visualizerVideoEl.srcObject = _mirrorStream;
    // Force-mute the playback element while mirroring — the source
    // audio already plays through the OS speakers, so unmuting here
    // would double it. The MediaStream still carries the audio tracks
    // so MediaRecorder picks them up. We don't write through to
    // _recRoomMutedPref, so the user's saved preference is restored
    // when the mirror stops.
    visualizerVideoEl.muted = true;
    _paintMuteBtn(true);
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
    if (visualizerNowEl) visualizerNowEl.textContent = `MIRROR · ${src.name || 'source'}`.toUpperCase();
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

  // ── Source picker ────────────────────────────────────────────────
  // SOURCE button opens an inline list of every window + screen with
  // thumbnails. Clicking one tears down the current mirror (if any)
  // and restarts capture against the chosen source.
  function _hideSourcePicker() {
    if (!sourcePickerEl) return;
    sourcePickerEl.hidden = true;
    sourceBtn?.classList.remove('is-active');
  }
  async function _showSourcePicker() {
    if (!sourcePickerEl || !sourceListEl || !window.dash?.visualizerListSources) return;
    sourceListEl.innerHTML = '<li class="explore-empty">LOADING SOURCES…</li>';
    sourcePickerEl.hidden = false;
    sourceBtn?.classList.add('is-active');
    let sources;
    try { sources = await window.dash.visualizerListSources(); } catch { sources = null; }
    if (!Array.isArray(sources) || !sources.length) {
      sourceListEl.innerHTML = '<li class="explore-empty">NO SOURCES AVAILABLE</li>';
      return;
    }
    // Layout: screens first, then windows grouped by owning application
    // so picking "the Discord window" is one read down the list rather
    // than a search through every visible window title. Within each
    // app group the windows are sorted by title.
    const screens = sources.filter((s) => s.kind === 'screen');
    const windows = sources.filter((s) => s.kind !== 'screen');
    screens.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const appGroups = new Map();
    for (const w of windows) {
      const key = w.appName || 'Other';
      if (!appGroups.has(key)) appGroups.set(key, []);
      appGroups.get(key).push(w);
    }
    // Sort groups alphabetically; sort windows within a group by title.
    const sortedGroups = [...appGroups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (const [, list] of sortedGroups) {
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    sourceListEl.innerHTML = '';
    const renderRow = (s) => {
      const row = document.createElement('li');
      row.className = 'visualizer-source-row';
      row.dataset.id = s.id;
      row.dataset.name = s.name;
      const safeName = String(s.name || '').replace(/</g, '&lt;');
      const thumb = s.thumbnail
        ? `<img class="visualizer-source-thumb" src="${s.thumbnail}" alt="">`
        : `<div class="visualizer-source-thumb is-empty"></div>`;
      row.innerHTML =
        thumb +
        `<span class="visualizer-source-name">${safeName}</span>` +
        `<span class="visualizer-source-kind">${s.kind === 'screen' ? 'SCREEN' : 'WIN'}</span>`;
      sourceListEl.appendChild(row);
    };
    // Screens section header + rows (only when at least one screen is
    // reported — skip the empty header otherwise).
    if (screens.length) {
      const head = document.createElement('li');
      head.className = 'visualizer-source-group';
      head.textContent = 'SCREENS';
      sourceListEl.appendChild(head);
      for (const s of screens) renderRow(s);
    }
    // One group header per application — gives the user a quick scan
    // by app instead of a flat list of every window title.
    for (const [appName, list] of sortedGroups) {
      const head = document.createElement('li');
      head.className = 'visualizer-source-group';
      head.textContent = String(appName).toUpperCase() + ` · ${list.length}`;
      sourceListEl.appendChild(head);
      for (const s of list) renderRow(s);
    }
  }
  sourceBtn?.addEventListener('click', () => {
    if (sourcePickerEl?.hidden) { _showSourcePicker(); playSfx?.('click'); }
    else { _hideSourcePicker(); playSfx?.('click'); }
  });
  sourceCloseBtn?.addEventListener('click', () => { _hideSourcePicker(); playSfx?.('click'); });
  sourceListEl?.addEventListener('click', async (e) => {
    const row = e.target.closest('.visualizer-source-row');
    if (!row) return;
    _mirrorSourceOverride = { id: row.dataset.id, name: row.dataset.name };
    // Restart the mirror with the new source. Stop first so the
    // override doesn't get cleared by _stopVisualizerMirror.
    if (_mirrorStream) {
      for (const tr of _mirrorStream.getTracks()) { try { tr.stop(); } catch {} }
      _mirrorStream = null;
      visualizerVideoEl.srcObject = null;
    }
    _hideSourcePicker();
    await _startVisualizerMirror();
    playSfx?.('confirm');
  });

  // ── Screencap: input-driven JPEG capture ─────────────────────────
  // Renderer owns frame encoding; main owns the powerMonitor poll and
  // the file write. We only fire if the mirror stream is live (no
  // point taking blank frames) and throttle to >= 1s between saves so
  // continuous typing doesn't flood the gallery folder.
  let _screencapOn = false;
  let _screencapLastAt = 0;
  let _screencapTriggerUnsub = null;
  const _screencapCanvas = document.createElement('canvas');
  function _screencapEncode() {
    if (!visualizerVideoEl) return null;
    const w = visualizerVideoEl.videoWidth  | 0;
    const h = visualizerVideoEl.videoHeight | 0;
    if (!w || !h) return null;
    _screencapCanvas.width  = w;
    _screencapCanvas.height = h;
    const ctx = _screencapCanvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try { ctx.drawImage(visualizerVideoEl, 0, 0, w, h); }
    catch { return null; }
    try { return _screencapCanvas.toDataURL('image/jpeg', 0.92); }
    catch { return null; }
  }
  async function _screencapMaybeCapture() {
    if (!_screencapOn) return;
    // Need *something* to capture from — either an active live mirror
    // or a video file currently loaded in the rec-room player. Without
    // either, the canvas draw produces a black frame.
    const hasVideoContent = (visualizerVideoEl && visualizerVideoEl.videoWidth > 0 && visualizerVideoEl.videoHeight > 0);
    if (!_mirrorStream && !hasVideoContent) return;
    const now = Date.now();
    if (now - _screencapLastAt < 1000) return; // throttle 1/sec
    const dataUrl = _screencapEncode();
    if (!dataUrl) return;
    _screencapLastAt = now;
    try { await window.dash?.screencapSave?.(dataUrl); } catch {}
    // Flash the button briefly so the user sees activity.
    if (screencapBtn) {
      screencapBtn.classList.add('is-flashing');
      setTimeout(() => screencapBtn.classList.remove('is-flashing'), 220);
    }
  }
  async function _startScreencap() {
    if (_screencapOn) return;
    _screencapOn = true;
    _screencapLastAt = 0;
    screencapBtn?.classList.add('is-active');
    if (screencapBtn) screencapBtn.textContent = 'REC ON';
    _screencapTriggerUnsub = window.dash?.onScreencapTrigger?.(_screencapMaybeCapture) || null;
    try { await window.dash?.screencapWatchStart?.(); } catch {}
  }
  async function _stopScreencap() {
    if (!_screencapOn) return;
    _screencapOn = false;
    screencapBtn?.classList.remove('is-active');
    if (screencapBtn) screencapBtn.textContent = 'RECORD';
    if (_screencapTriggerUnsub) { try { _screencapTriggerUnsub(); } catch {} _screencapTriggerUnsub = null; }
    try { await window.dash?.screencapWatchStop?.(); } catch {}
  }
  screencapBtn?.addEventListener('click', () => {
    if (_screencapOn) { _stopScreencap(); playSfx?.('click'); }
    else              { _startScreencap(); playSfx?.('confirm'); }
  });

  // ── PROCESS: stitch selected snaps into a video ──────────────────
  // Pipeline: decode each selected JPEG → drawImage to a fixed-size
  // canvas (letterboxed) → canvas.captureStream into MediaRecorder →
  // collect blob → send to main for write into gallery/recordings/.
  // Time crunch is percentage-based: 100% = 1 s per snap (base hold);
  // 200% = 0.5 s; 3000% = ~33 ms. Bitrate is a 3-way preset matrix
  // indexed by [resolution][quality].
  const processBtn        = document.getElementById('visualizer-process-btn');
  const processPickerEl   = document.getElementById('visualizer-process-picker');
  const processCloseBtn   = document.getElementById('visualizer-process-close');
  const processCountEl    = document.getElementById('visualizer-process-count');
  const processSpeedEl    = document.getElementById('visualizer-process-speed');
  const processSpeedVal   = document.getElementById('visualizer-process-speed-val');
  const processGoBtn      = document.getElementById('visualizer-process-go');
  const processStatusEl   = document.getElementById('visualizer-process-status');
  const _processOpts = { format: 'mp4', res: 'source', quality: 'std' };
  // Cached ffmpeg probe — populated once at startup. When .available is
  // true we route PROCESS through the GPU-accelerated ffmpeg pipeline
  // (real-time savings vs MediaRecorder are 10-50x for snap stitching).
  let _ffmpegInfo = null;
  (async () => { try { _ffmpegInfo = await window.dash?.ffmpegInfo?.() || null; } catch {} })();

  // Compression presets — chosen by eye for screen content where text
  // legibility matters more than action smoothness. LITE = comfortable
  // for embedding, STD = good general default, CRISP = near-archival.
  const PROCESS_BITRATES = {
    '720':    { lite: 1_500_000, std:  2_500_000, crisp:  5_000_000 },
    '1080':   { lite: 3_000_000, std:  5_000_000, crisp:  8_000_000 },
    '2160':   { lite: 8_000_000, std: 15_000_000, crisp: 25_000_000 },
    'source': { lite: 5_000_000, std: 10_000_000, crisp: 20_000_000 },
  };

  function _setProcessStatus(msg, isErr) {
    if (!processStatusEl) return;
    processStatusEl.textContent = msg || '';
    processStatusEl.classList.toggle('is-error', !!isErr);
  }
  function _formatSpeed(percent) {
    const holdSec = 100 / percent;        // seconds per snap at this %
    // Prefer the resolved image count (folder-expanded) when the picker
    // has finished resolving; fall back to raw selection size otherwise.
    const count = _processResolvedCount || _visualizerSelected.size;
    const totalSec = holdSec * count;
    return `${percent}% · ${holdSec.toFixed(2)}s/snap · ~${totalSec < 60 ? totalSec.toFixed(1) + 's' : (totalSec / 60).toFixed(1) + 'm'} total`;
  }
  function _paintProcessRadios() {
    processPickerEl?.querySelectorAll('.visualizer-process-radios').forEach((grp) => {
      const group = grp.dataset.group;
      const val = _processOpts[group];
      for (const btn of grp.querySelectorAll('button')) {
        btn.classList.toggle('is-active', btn.dataset.val === val);
      }
    });
  }
  // Wire radio button groups to update _processOpts.
  processPickerEl?.querySelectorAll('.visualizer-process-radios').forEach((grp) => {
    grp.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-val]');
      if (!btn) return;
      _processOpts[grp.dataset.group] = btn.dataset.val;
      _paintProcessRadios();
      playSfx?.('click');
    });
  });
  processSpeedEl?.addEventListener('input', () => {
    if (processSpeedVal) processSpeedVal.textContent = _formatSpeed(Number(processSpeedEl.value) || 100);
    // Live preview reads holdMs on every tick, so the new pace takes
    // effect on the next frame — no need to restart the loop.
  });

  // ── Live time-crunch preview ────────────────────────────────────────
  // Cycles the in-picker <img id="visualizer-process-preview-img">
  // through the selected snaps at the current speed-slider pace. The
  // preview lives INSIDE the picker (in its own slot) because the
  // picker covers the player wrap; routing the preview through the
  // wrap meant it was always hidden behind the controls.
  // Each tick reads holdMs fresh from the slider, so moving the slider
  // updates the pace without restarting.
  const processPreviewImgEl  = document.getElementById('visualizer-process-preview-img');
  const processPreviewSlotEl = document.querySelector('.visualizer-process-preview-slot');
  let _processPreviewSnaps  = [];
  let _processPreviewIdx    = 0;
  let _processPreviewActive = false;
  let _processPreviewTimer  = null;
  function _previewHoldMs() {
    const percent = Math.max(100, Number(processSpeedEl?.value) || 100);
    return Math.max(16, (100 / percent) * 1000);
  }
  function _processPreviewTick() {
    if (!_processPreviewActive || !_processPreviewSnaps.length) return;
    const entry = _processPreviewSnaps[_processPreviewIdx % _processPreviewSnaps.length];
    if (processPreviewImgEl && entry) {
      processPreviewImgEl.src = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
    }
    _processPreviewIdx++;
    _processPreviewTimer = setTimeout(_processPreviewTick, _previewHoldMs());
  }
  function _startProcessPreview(snaps) {
    _stopProcessPreview();
    if (!Array.isArray(snaps) || snaps.length < 2) return;
    _processPreviewSnaps = snaps.slice(0);
    _processPreviewIdx = 0;
    _processPreviewActive = true;
    processPreviewSlotEl?.classList.add('is-running');
    _processPreviewTick();
  }
  function _stopProcessPreview() {
    _processPreviewActive = false;
    if (_processPreviewTimer) { clearTimeout(_processPreviewTimer); _processPreviewTimer = null; }
    _processPreviewSnaps = [];
    _processPreviewIdx = 0;
    processPreviewSlotEl?.classList.remove('is-running');
    if (processPreviewImgEl) processPreviewImgEl.src = '';
  }

  // Cached resolved image count when the picker is open with a folder
  // selection — so the speed-slider preview shows a real total duration
  // instead of "1 item × N seconds".
  let _processResolvedCount = 0;
  function _openProcessPicker() {
    if (!processPickerEl) return;
    // Close any other picker.
    sourcePickerEl   && (sourcePickerEl.hidden   = true);
    sourceBtn        ?.classList.remove('is-active');
    qualityPickerEl  && (qualityPickerEl.hidden  = true);
    qualityBtn       ?.classList.remove('is-active');
    osdPickerEl      && (osdPickerEl.hidden      = true);
    processPickerEl.hidden = false;
    processBtn?.classList.add('is-active');
    if (processCountEl) processCountEl.textContent = String(_visualizerSelected.size);
    _paintProcessRadios();
    if (processSpeedVal) processSpeedVal.textContent = _formatSpeed(Number(processSpeedEl.value) || 100);
    _setProcessStatus('Resolving images…');
    // Async-resolve actual image count (folder expansion). Updates the
    // count badge and re-renders the speed-time estimate when ready.
    _processResolvedCount = 0;
    _collectSelectedSnapsExpanded().then((list) => {
      if (processPickerEl.hidden) return; // closed before resolve
      _processResolvedCount = list.length;
      if (processCountEl) processCountEl.textContent = String(list.length);
      if (processSpeedVal) processSpeedVal.textContent = _formatSpeed(Number(processSpeedEl.value) || 100);
      _setProcessStatus(list.length >= 2 ? '' : 'Selection has fewer than 2 images.', list.length < 2);
      // Kick off the live preview once we know what we're working with.
      if (list.length >= 2) _startProcessPreview(list);
    }).catch(() => {});
  }
  function _closeProcessPicker() {
    if (!processPickerEl) return;
    processPickerEl.hidden = true;
    processBtn?.classList.remove('is-active');
    _processResolvedCount = 0;
    _stopProcessPreview();
  }
  processBtn?.addEventListener('click', () => {
    if (processBtn.disabled) return;
    if (processPickerEl?.hidden) _openProcessPicker();
    else _closeProcessPicker();
    playSfx?.('click');
  });
  processCloseBtn?.addEventListener('click', () => { _closeProcessPicker(); playSfx?.('click'); });

  // PREVIEW button — restart / toggle the live time-crunch preview.
  // Auto-preview kicks off when the picker opens; this button lets the
  // user restart it from frame 0 after fiddling with the slider, or
  // pause it entirely. Click while active → stop; click while inactive
  // → restart from frame 0.
  const processPreviewBtn = document.getElementById('visualizer-process-preview');
  function _paintProcessPreviewBtn() {
    processPreviewBtn?.classList.toggle('is-active', _processPreviewActive);
  }
  processPreviewBtn?.addEventListener('click', async () => {
    if (_processPreviewActive) {
      _stopProcessPreview();
      _paintProcessPreviewBtn();
      playSfx?.('click');
      return;
    }
    // Restart from frame 0 with whatever the current selection resolves
    // to (folder selections expand to image children).
    _setProcessStatus('Resolving images…');
    const list = await _collectSelectedSnapsExpanded();
    if (list.length < 2) {
      _setProcessStatus('Need at least 2 images to preview.', true);
      playSfx?.('error');
      return;
    }
    _setProcessStatus('');
    _startProcessPreview(list);
    _paintProcessPreviewBtn();
    playSfx?.('confirm');
  });
  // Poll the preview state every ~250ms while the picker is open so the
  // button reflects auto-start/auto-stop too (preview can also stop on
  // close / GO press). Cheap; runs only when picker is visible.
  setInterval(() => {
    if (!processPickerEl || processPickerEl.hidden) return;
    _paintProcessPreviewBtn();
  }, 250);

  // Collect the selected snap entries IN ORIGINAL DISPLAY ORDER from
  // the current _visualizerEntries list (so the video plays back in
  // the order they appear in the captures view, not in click order).
  function _collectSelectedSnaps() {
    return _visualizerEntries.filter((e) => _visualizerSelected.has(e.path)
      && !e.isDir && _IMG_KNOWN_RE.test(e.name));
  }
  // Expanding variant: any selected FOLDER gets recursively flattened
  // (one level deep — the rec-room only stores one-level-deep snap
  // session folders) into its image children. Returns an array of
  // image entries with absolute paths, in render order: selected
  // images first, then folder contents sorted by filename within
  // each folder (snaps are timestamp-prefixed so name order ==
  // capture order).
  async function _collectSelectedSnapsExpanded() {
    const out = [];
    const seen = new Set();
    const push = (entry) => {
      if (!entry || seen.has(entry.path)) return;
      seen.add(entry.path);
      out.push(entry);
    };
    // Walk in render order so picks stay grouped sensibly.
    for (const ent of _visualizerEntries) {
      if (!_visualizerSelected.has(ent.path)) continue;
      if (ent.isDir) {
        try {
          const result = await window.dash?.galleryList?.(ent.rel || '');
          const kids = (result?.entries || [])
            .filter((k) => !k.isDir && _IMG_KNOWN_RE.test(k.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const k of kids) push(k);
        } catch {}
      } else if (_IMG_KNOWN_RE.test(ent.name)) {
        push(ent);
      }
    }
    return out;
  }
  // Decode one image. Resolves with null on failure so a stray corrupt
  // snap doesn't take down the whole batch.
  function _decodeImage(entry) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `dash3d-file://gallery/${encodeURI(entry.rel)}`;
    });
  }
  // Pick the first supported MediaRecorder MIME for the chosen format.
  // For MP4 in older Chromium that lacks the muxer we fall back to
  // WebM and rename the output accordingly so the file extension never
  // lies about its bytes.
  function _pickProcessMime(format) {
    const mp4Candidates = [
      'video/mp4;codecs=avc1.640033,mp4a.40.2',
      'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
    ];
    const webmCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const probe = (list) => list.find((m) => window.MediaRecorder?.isTypeSupported?.(m));
    if (format === 'mp4') {
      const m = probe(mp4Candidates);
      if (m) return { mime: m, ext: '.mp4' };
      // No MP4 support → fall back to WebM (and use .webm so the file
      // isn't mislabelled).
      const fall = probe(webmCandidates);
      return fall ? { mime: fall, ext: '.webm', fellBack: true } : null;
    }
    const m = probe(webmCandidates);
    return m ? { mime: m, ext: '.mkv' } : null;
  }

  async function _processSnapsRun() {
    processGoBtn.disabled = true;
    // Halt the live preview so it stops fighting the encoder for image
    // decodes (and so the player wrap can hand off to the saved video
    // when ffmpeg returns).
    _stopProcessPreview();
    _setProcessStatus('Resolving selection…');
    const snaps = await _collectSelectedSnapsExpanded();
    if (snaps.length < 2) {
      _setProcessStatus(snaps.length === 0
        ? 'Selection has no images — pick a folder of snaps or 2+ images.'
        : 'Need at least 2 images to stitch.', true);
      processGoBtn.disabled = false;
      return;
    }
    const percent = Math.max(100, Number(processSpeedEl?.value) || 100);
    const holdMs = (100 / percent) * 1000;
    const resKey = _processOpts.res;
    const bitsPerSec = PROCESS_BITRATES[resKey]?.[_processOpts.quality]
      ?? PROCESS_BITRATES.source.std;

    // Make sure the ffmpeg probe has completed before we decide which
    // path to use. The module-load probe is async and could race a
    // very fast PROCESS click. Re-fetch synchronously if null/false so
    // we don't accidentally fall through to MediaRecorder (which would
    // produce a .webm output since Chromium typically lacks an MP4
    // muxer in MediaRecorder).
    let ffmpegIpcError = null;
    if (!_ffmpegInfo?.available) {
      try { _ffmpegInfo = await window.dash?.ffmpegInfo?.() || _ffmpegInfo; }
      catch (err) { ffmpegIpcError = err?.message || String(err); }
    }
    console.log('[process] ffmpeg info:', _ffmpegInfo, 'format:', _processOpts.format, 'ipcErr:', ffmpegIpcError);
    // If ffmpeg isn't usable, surface WHY in the status bar so the user
    // can see what's going wrong without opening DevTools. Then continue
    // (we still try MediaRecorder as a last resort — but the user now
    // knows the file will be webm).
    if (!_ffmpegInfo?.available) {
      const why = ffmpegIpcError
        ? `IPC error: ${ffmpegIpcError}`
        : (!_ffmpegInfo ? 'ffmpegInfo() returned null'
          : `path=${_ffmpegInfo.path || '(none)'} available=${_ffmpegInfo.available}`);
      _setProcessStatus(`FFmpeg unavailable (${why}) — falling back to MediaRecorder (WebM only)`, true);
    }

    // Fast path: bundled ffmpeg. NVENC when present, libx264/x265
    // otherwise — both run as fast as the encoder can chew through
    // the frames (not real-time), so this is the path we want by
    // default. MediaRecorder fallback only runs if ffmpeg failed to
    // load (older builds, missing binary, etc).
    if (_ffmpegInfo?.available) {
      const outH = resKey === 'source' ? 0 : Number(resKey) || 0;
      const isHevc = _processOpts.format === 'hevc';
      const useGpu = !!_ffmpegInfo.hasNvenc && (!isHevc || !!_ffmpegInfo.hasHevcNvenc);
      const encLabel = useGpu
        ? (isHevc ? 'GPU · hevc_nvenc' : 'GPU · h264_nvenc')
        : (isHevc ? 'CPU · libx265' : 'CPU · libx264');
      _setProcessStatus(`Encoding ${snaps.length} snaps · ${encLabel}…`);
      const t0 = performance.now();
      const unsub = window.dash?.onProcessSnapsProgress?.((d) => {
        _setProcessStatus(`Encoding ${d.frame}/${d.total || snaps.length} · ${d.encoder || encLabel}`);
      });
      const result = await window.dash?.processSnapsFfmpeg?.({
        paths: snaps.map((e) => e.path),
        format: _processOpts.format === 'mkv' ? 'mkv' : 'mp4',
        outH,
        bitsPerSec,
        holdMs,
        useGpu,
        codec: isHevc ? 'hevc' : 'h264',
        // Optional color/blur/denoise pass shared with the EDIT panel.
        // _procFilterState is hung on window by the editor block so
        // we don't have to thread it through every helper here.
        filters: window._procFilterState || undefined,
      });
      try { unsub?.(); } catch {}
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      if (result?.ok) {
        _setProcessStatus(`Saved ${result.name} (${(result.size/1024/1024).toFixed(1)} MB) · ${result.encoder || encLabel} · ${dt}s`);
        _visualizerSubdir = 'videos';
        refreshVisualizer();
      } else {
        _setProcessStatus('ffmpeg failed: ' + (result?.error || 'unknown') + ' — falling back to MediaRecorder', true);
        // fall through to legacy path below
      }
      if (result?.ok) { processGoBtn.disabled = false; return; }
    }

    // Legacy fallback: canvas + MediaRecorder (real-time, CPU).
    _setProcessStatus(`Decoding ${snaps.length} snaps…`);
    const images = [];
    for (let i = 0; i < snaps.length; i++) {
      const img = await _decodeImage(snaps[i]);
      if (img) images.push(img);
      _setProcessStatus(`Decoding ${i+1}/${snaps.length}…`);
    }
    const first = images.find((im) => im.naturalWidth) || images[0];
    if (!first?.naturalWidth) {
      _setProcessStatus('No snaps could be decoded.', true);
      processGoBtn.disabled = false;
      return;
    }
    let outH = first.naturalHeight;
    if (resKey !== 'source') {
      const targetH = Number(resKey);
      if (targetH && targetH < outH) outH = targetH;
    }
    const outW = Math.max(2, Math.round(first.naturalWidth * (outH / first.naturalHeight)));
    const canvas = document.createElement('canvas');
    canvas.width  = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');

    if (_processOpts.format === 'hevc') {
      _setProcessStatus('HEVC requires ffmpeg — MediaRecorder cannot encode H.265.', true);
      processGoBtn.disabled = false;
      return;
    }
    const picked = _pickProcessMime(_processOpts.format);
    if (!picked) {
      _setProcessStatus('No supported MediaRecorder codec.', true);
      processGoBtn.disabled = false;
      return;
    }
    const stream = canvas.captureStream(30);
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: bitsPerSec });
    } catch (err) {
      _setProcessStatus('Recorder init failed: ' + err.message, true);
      processGoBtn.disabled = false;
      return;
    }
    const chunks = [];
    recorder.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };
    const stopped = new Promise((res) => { recorder.onstop = res; });
    recorder.start(500);

    const fellBackNote = picked.fellBack ? ' (MP4 unsupported · saved as WebM)' : '';
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outW, outH);
      if (img?.naturalWidth) {
        const ratio = Math.min(outW / img.naturalWidth, outH / img.naturalHeight);
        const w = img.naturalWidth * ratio;
        const h = img.naturalHeight * ratio;
        ctx.drawImage(img, (outW - w) / 2, (outH - h) / 2, w, h);
      }
      _setProcessStatus(`Encoding ${i+1}/${images.length} · ${percent}%${fellBackNote}`);
      await new Promise((res) => setTimeout(res, holdMs));
    }
    // Hold the final frame for a beat so MediaRecorder picks up the
    // last drawn frame before stop.
    await new Promise((res) => setTimeout(res, 300));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: picked.mime });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    _setProcessStatus('Saving…');
    const result = await window.dash?.processSnapsSave?.(bytes, picked.ext);
    if (result?.ok) {
      _setProcessStatus(`Saved ${result.name} (${(result.size/1024/1024).toFixed(1)} MB)${fellBackNote}`);
      // Pop the user into videos/ so the new file is visible.
      _visualizerSubdir = 'videos';
      refreshVisualizer();
    } else {
      _setProcessStatus('Save failed: ' + (result?.error || 'unknown'), true);
    }
    processGoBtn.disabled = false;
  }
  processGoBtn?.addEventListener('click', () => {
    _processSnapsRun().catch((err) => {
      console.warn('[process] failed', err);
      _setProcessStatus('Failed: ' + err.message, true);
      processGoBtn.disabled = false;
    });
    playSfx?.('confirm');
  });

  // ── Recording quality profiles ───────────────────────────────────
  // Profile shape: { key, label, resolution: 'source'|number, bitsPerSec }
  // Resolution is the target *height* in pixels — 'source' keeps the
  // native size and skips the canvas downscale step entirely.
  const REC_PROFILES = {
    lite:  { key: 'lite',  label: 'LITE',  resolution: 720,      bitsPerSec:  1_500_000, fps: 30, hint: '720p · 1.5 Mbps · 30 fps' },
    med:   { key: 'med',   label: 'MED',   resolution: 'source', bitsPerSec:  5_000_000, fps: 30, hint: 'Source · 5 Mbps · 30 fps' },
    large: { key: 'large', label: 'LARGE', resolution: 'source', bitsPerSec: 12_000_000, fps: 60, hint: 'Source · 12 Mbps · 60 fps' },
    max:   { key: 'max',   label: 'MAX',   resolution: 'source', bitsPerSec: 40_000_000, fps: 60, hint: 'Source · 40 Mbps · 60 fps' },
  };
  let _recProfile = { ...REC_PROFILES.med };
  const qualityBtn        = document.getElementById('visualizer-quality-btn');
  const qualityPickerEl   = document.getElementById('visualizer-quality-picker');
  const qualityListEl     = document.getElementById('visualizer-quality-list');
  const qualityCloseBtn   = document.getElementById('visualizer-quality-close');
  const qualityResSel     = document.getElementById('visualizer-quality-res');
  const qualityBitrateEl  = document.getElementById('visualizer-quality-bitrate');
  const qualityBitrateVal = document.getElementById('visualizer-quality-bitrate-val');
  const qualityFpsSel     = document.getElementById('visualizer-quality-fps');
  const qualityApplyBtn   = document.getElementById('visualizer-quality-apply');
  function _formatProfileButton() {
    if (!qualityBtn) return;
    const k = _recProfile.key || 'custom';
    qualityBtn.textContent = `Q:${k.toUpperCase()}`;
    qualityBtn.title = `Recording quality — ${_recProfile.hint || `${_recProfile.resolution} · ${(_recProfile.bitsPerSec/1_000_000).toFixed(1)} Mbps`}`;
  }
  function _paintQualityList() {
    if (!qualityListEl) return;
    for (const row of qualityListEl.querySelectorAll('.visualizer-quality-row')) {
      row.classList.toggle('is-active', row.dataset.profile === _recProfile.key);
    }
  }
  function _applyProfile(key) {
    const p = REC_PROFILES[key];
    if (!p) return;
    _recProfile = { ...p };
    _formatProfileButton();
    _paintQualityList();
    try { window.dash?.setConfig?.({ recQuality: { key, resolution: p.resolution, bitsPerSec: p.bitsPerSec, fps: p.fps } }); } catch {}
  }
  function _applyCustom() {
    const res = qualityResSel?.value || 'source';
    const kbps = Number(qualityBitrateEl?.value) || 5000;
    const fps  = Math.max(15, Math.min(240, Number(qualityFpsSel?.value) || 30));
    const resolution = res === 'source' ? 'source' : Number(res);
    const bitsPerSec = Math.max(500_000, Math.min(50_000_000, kbps * 1000));
    _recProfile = {
      key: 'custom',
      label: 'CUSTOM',
      resolution,
      bitsPerSec,
      fps,
      hint: `${res === 'source' ? 'Source' : res + 'p'} · ${(bitsPerSec/1_000_000).toFixed(1)} Mbps · ${fps} fps`,
    };
    _formatProfileButton();
    _paintQualityList();
    try { window.dash?.setConfig?.({ recQuality: { key: 'custom', resolution, bitsPerSec, fps } }); } catch {}
  }
  qualityBtn?.addEventListener('click', () => {
    if (!qualityPickerEl) return;
    if (qualityPickerEl.hidden) {
      // Hide the source picker if it happens to be open so they don't stack.
      sourcePickerEl && (sourcePickerEl.hidden = true);
      sourceBtn?.classList.remove('is-active');
      qualityPickerEl.hidden = false;
      qualityBtn.classList.add('is-active');
      _paintQualityList();
    } else {
      qualityPickerEl.hidden = true;
      qualityBtn.classList.remove('is-active');
    }
    playSfx?.('click');
  });
  qualityCloseBtn?.addEventListener('click', () => {
    qualityPickerEl.hidden = true;
    qualityBtn?.classList.remove('is-active');
    playSfx?.('click');
  });
  qualityListEl?.addEventListener('click', (e) => {
    const row = e.target.closest('.visualizer-quality-row');
    if (!row) return;
    _applyProfile(row.dataset.profile);
    playSfx?.('confirm');
  });
  qualityBitrateEl?.addEventListener('input', () => {
    if (qualityBitrateVal) qualityBitrateVal.textContent = `${(Number(qualityBitrateEl.value)/1000).toFixed(1)} Mbps`;
  });
  qualityApplyBtn?.addEventListener('click', () => {
    _applyCustom();
    playSfx?.('confirm');
  });
  // Restore previous selection on load.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    const saved = cfg.recQuality;
    if (saved?.key && REC_PROFILES[saved.key]) {
      _applyProfile(saved.key);
    } else if (saved?.key === 'custom' && typeof saved.bitsPerSec === 'number') {
      const fps = Number(saved.fps) || 30;
      _recProfile = {
        key: 'custom', label: 'CUSTOM',
        resolution: saved.resolution || 'source',
        bitsPerSec: saved.bitsPerSec,
        fps,
        hint: `${saved.resolution === 'source' ? 'Source' : saved.resolution + 'p'} · ${(saved.bitsPerSec/1_000_000).toFixed(1)} Mbps · ${fps} fps`,
      };
      if (qualityResSel) qualityResSel.value = String(saved.resolution || 'source');
      if (qualityBitrateEl) qualityBitrateEl.value = String(Math.round(saved.bitsPerSec / 1000));
      if (qualityBitrateVal) qualityBitrateVal.textContent = `${(saved.bitsPerSec/1_000_000).toFixed(1)} Mbps`;
      if (qualityFpsSel) qualityFpsSel.value = String(fps);
      _formatProfileButton();
      _paintQualityList();
    } else {
      _formatProfileButton();
      _paintQualityList();
    }
  })();

  // ── Free-capture crop region ─────────────────────────────────────
  // Draggable + resizable rectangle inside the player wrap; when
  // active, _buildRecorderStream below crops the recording to its
  // bounds. Rect is stored in 0..1 fractions of the wrap so it stays
  // valid across resize, and persisted under config.cropRect.
  const cropBtn      = document.getElementById('visualizer-crop-btn');
  const cropOverlay  = document.getElementById('visualizer-crop');
  const cropRectEl   = document.getElementById('visualizer-crop-rect');
  let _cropActive = false;
  let _cropRect = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  const MIN_CROP_FRAC = 0.05;
  function _paintCropRect() {
    if (!cropRectEl) return;
    cropRectEl.style.left   = `${_cropRect.x * 100}%`;
    cropRectEl.style.top    = `${_cropRect.y * 100}%`;
    cropRectEl.style.width  = `${_cropRect.w * 100}%`;
    cropRectEl.style.height = `${_cropRect.h * 100}%`;
  }
  function _clampCropRect(r) {
    let { x, y, w, h } = r;
    w = Math.max(MIN_CROP_FRAC, Math.min(1, w));
    h = Math.max(MIN_CROP_FRAC, Math.min(1, h));
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    return { x, y, w, h };
  }
  function _persistCropRect() {
    try { window.dash?.setConfig?.({ cropRect: { ..._cropRect } }); } catch {}
  }
  cropRectEl?.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.target?.dataset?.handle || 'move';
    const wrapRect = visualizerWrapEl.getBoundingClientRect();
    if (!wrapRect.width || !wrapRect.height) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const start = { ..._cropRect };
    cropRectEl.classList.add('is-dragging');
    function onMove(e) {
      const dx = (e.clientX - startX) / wrapRect.width;
      const dy = (e.clientY - startY) / wrapRect.height;
      let { x, y, w, h } = start;
      if (handle === 'move') { x += dx; y += dy; }
      else {
        if (handle.includes('w')) { x += dx; w -= dx; }
        if (handle.includes('e')) {           w += dx; }
        if (handle.includes('n')) { y += dy; h -= dy; }
        if (handle.includes('s')) {           h += dy; }
      }
      _cropRect = _clampCropRect({ x, y, w, h });
      _paintCropRect();
      // If FIT-crop is active, the wrap's aspect tracks the crop's
      // pixel aspect — keep them in sync as the rect resizes so the
      // preview canvas reshapes live with the drag.
      if (_cropFitActive) _refreshWrapShape();
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      cropRectEl.classList.remove('is-dragging');
      _persistCropRect();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  cropBtn?.addEventListener('click', () => {
    _cropActive = !_cropActive;
    cropBtn.classList.toggle('is-active', _cropActive);
    cropBtn.textContent = _cropActive ? 'CROP ●' : 'CROP';
    if (_cropActive) _paintCropRect();
    _refreshCropFitView();
    playSfx?.(_cropActive ? 'confirm' : 'click');
  });

  // ── FIT: when CROP is on, show the cropped region filling the wrap
  // (a live canvas preview of just sx,sy,sw,sh of the video element).
  // Wrap aspect also reshapes to the crop region's pixel aspect so
  // the cropped fill fills with no letterboxing.
  const fitBtn = document.getElementById('visualizer-fit-btn');
  const cropPreviewEl = document.getElementById('visualizer-crop-preview');
  let _cropPreviewRaf = 0;
  function _startCropPreviewLoop() {
    if (_cropPreviewRaf || !cropPreviewEl) return;
    const ctx = cropPreviewEl.getContext('2d');
    cropPreviewEl.hidden = false;
    const tick = () => {
      if (!_cropFitActive || !_cropActive) {
        cropPreviewEl.hidden = true;
        _cropPreviewRaf = 0;
        return;
      }
      const vw = visualizerVideoEl?.videoWidth || _lastSourceW;
      const vh = visualizerVideoEl?.videoHeight || _lastSourceH;
      if (vw && vh && visualizerVideoEl?.readyState >= 2) {
        const sx = Math.max(0, _cropRect.x * vw);
        const sy = Math.max(0, _cropRect.y * vh);
        const sw = Math.max(1, _cropRect.w * vw);
        const sh = Math.max(1, _cropRect.h * vh);
        // Match canvas resolution to the wrap's CSS box at device pixels
        // so the preview stays sharp on hidpi displays without ballooning
        // CPU on plain 1× monitors.
        const rect = visualizerWrapEl.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cw = Math.max(2, Math.round(rect.width  * dpr));
        const ch = Math.max(2, Math.round(rect.height * dpr));
        if (cropPreviewEl.width  !== cw) cropPreviewEl.width  = cw;
        if (cropPreviewEl.height !== ch) cropPreviewEl.height = ch;
        try { ctx.drawImage(visualizerVideoEl, sx, sy, sw, sh, 0, 0, cw, ch); } catch {}
      }
      _cropPreviewRaf = requestAnimationFrame(tick);
    };
    _cropPreviewRaf = requestAnimationFrame(tick);
  }
  function _stopCropPreviewLoop() {
    if (_cropPreviewRaf) {
      cancelAnimationFrame(_cropPreviewRaf);
      _cropPreviewRaf = 0;
    }
    if (cropPreviewEl) cropPreviewEl.hidden = true;
  }
  function _refreshCropFitView() {
    const fitOn = _cropFitActive && _cropActive;
    // Hide the rect editor overlay while in fit mode — the wrap IS the
    // crop now, so the rect overlay is redundant. To re-edit the rect
    // the user clicks FIT again (toggles fit off) which restores the
    // overlay + full-source view.
    if (cropOverlay) cropOverlay.hidden = !_cropActive || fitOn;
    if (visualizerWrapEl) visualizerWrapEl.classList.toggle('is-crop-fit', fitOn);
    if (fitOn) _startCropPreviewLoop();
    else _stopCropPreviewLoop();
    _refreshWrapShape();
  }
  fitBtn?.addEventListener('click', async () => {
    _cropFitActive = !_cropFitActive;
    fitBtn.classList.toggle('is-active', _cropFitActive);
    fitBtn.textContent = _cropFitActive ? 'FIT ●' : 'FIT';
    _refreshCropFitView();
    try { await window.dash?.setConfig?.({ recRoomCropFit: _cropFitActive }); } catch {}
    playSfx?.(_cropFitActive ? 'confirm' : 'click');
  });
  // Restore preference on load.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    _cropFitActive = !!cfg.recRoomCropFit;
    fitBtn?.classList.toggle('is-active', _cropFitActive);
    if (fitBtn) fitBtn.textContent = _cropFitActive ? 'FIT ●' : 'FIT';
    _refreshCropFitView();
  })();
  // Restore crop rect on load. The overlay stays hidden until CROP is
  // toggled — we just preload the rect so the previous shape returns.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    if (cfg.cropRect && typeof cfg.cropRect.w === 'number' && typeof cfg.cropRect.h === 'number') {
      _cropRect = _clampCropRect(cfg.cropRect);
    }
    _paintCropRect();
  })();

  // ── Auto key capture: render pressed keys onto the recording canvas
  // (recording-only; never drawn on this screen). Main spawns a global
  // GetAsyncKeyState poller in PowerShell and pushes each fresh key-
  // down edge. We keep a rolling FIFO of the last ~12 events with 3-
  // second fade — the overlay drawer below reads from this and paints
  // each frame inside _buildRecorderStream's canvas loop.
  const keysBtn = document.getElementById('visualizer-keys-btn');
  let _keysOverlayOn = false;
  let _keyEvents = []; // { key, ts (perf.now ms) }
  let _keyUnsub = null;
  const KEY_OVERLAY_FADE_MS = 3000;
  const KEY_OVERLAY_MAX = 12;
  function _onKeyEvent(ev) {
    if (!ev || !ev.name) return;
    _keyEvents.push({ key: ev.name, ts: performance.now() });
    if (_keyEvents.length > KEY_OVERLAY_MAX * 2) {
      _keyEvents = _keyEvents.slice(-KEY_OVERLAY_MAX * 2);
    }
  }
  // Cached parsed accent color, refreshed on theme changes. Reading
  // getComputedStyle every frame works but is wasteful — cache and let
  // the theme observer invalidate.
  let _accentRGB = null;
  function _readAccentRGB() {
    try {
      const raw = getComputedStyle(document.body).getPropertyValue('--accent').trim();
      let r = 92, g = 207, b = 255; // sensible fallback
      if (raw.startsWith('#')) {
        const hex = raw.length === 4
          ? raw.slice(1).split('').map(c => c + c).join('')
          : raw.slice(1);
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
      } else {
        const m = raw.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
      }
      _accentRGB = `${r}, ${g}, ${b}`;
    } catch {
      _accentRGB = '92, 207, 255';
    }
    return _accentRGB;
  }
  function _accentRgbCached() { return _accentRGB || _readAccentRGB(); }
  // Cheap theme change invalidator — listen to the broad attribute
  // changes on <html> (theme is usually toggled there). If theme isn't
  // on <html> the cache just stays valid — fallback colour still works.
  new MutationObserver(() => { _accentRGB = null; }).observe(document.documentElement, { attributes: true });

  // Paint the keys overlay onto the recording canvas. Right-aligned
  // column near the bottom-right, newest on top, fading by age.
  function _drawKeysOverlay(ctx, w, h) {
    const now = performance.now();
    const cutoff = now - KEY_OVERLAY_FADE_MS;
    while (_keyEvents.length && _keyEvents[0].ts < cutoff) _keyEvents.shift();
    const recent = _keyEvents.slice(-KEY_OVERLAY_MAX);
    if (!recent.length) return;
    const fontSize = Math.max(16, Math.round(h * 0.032));
    const padX = Math.round(w * 0.018);
    const padY = Math.round(h * 0.018);
    const cellPadX = Math.round(fontSize * 0.6);
    const cellPadY = Math.round(fontSize * 0.35);
    const gap = Math.round(fontSize * 0.35);
    const accent = _accentRgbCached();
    ctx.save();
    ctx.font = `bold ${fontSize}px 'JetBrains Mono', 'Consolas', monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let y = h - padY - fontSize / 2 - cellPadY;
    for (let i = recent.length - 1; i >= 0; i--) {
      const ev = recent[i];
      const age = (now - ev.ts) / KEY_OVERLAY_FADE_MS;
      const alpha = Math.max(0, Math.min(1, 1 - age));
      if (alpha <= 0) continue;
      const text = ev.key;
      const tw = ctx.measureText(text).width;
      const cellW = tw + cellPadX * 2;
      const cellH = fontSize + cellPadY * 2;
      const x = w - padX - cellW;
      ctx.fillStyle = `rgba(0, 0, 0, ${0.6 * alpha})`;
      ctx.fillRect(x, y - cellH / 2, cellW, cellH);
      ctx.lineWidth = Math.max(1, fontSize * 0.08);
      ctx.strokeStyle = `rgba(${accent}, ${alpha})`;
      ctx.strokeRect(x + 0.5, y - cellH / 2 + 0.5, cellW - 1, cellH - 1);
      ctx.shadowColor = `rgba(${accent}, ${alpha * 0.9})`;
      ctx.shadowBlur = fontSize * 0.45;
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fillText(text, w - padX - cellPadX, y);
      ctx.shadowBlur = 0;
      y -= cellH + gap;
      if (y - cellH / 2 < padY) break;
    }
    ctx.restore();
  }

  // ── On-screen display overlays (TIME / DATE / FPS) ───────────────
  // Recording-only, drawn on the recording canvas — same approach as
  // the keys overlay. Each toggle persists in config.osd.
  const osdBtn         = document.getElementById('visualizer-osd-btn');
  const osdPickerEl    = document.getElementById('visualizer-osd-picker');
  const osdCloseBtn    = document.getElementById('visualizer-osd-close');
  let _osdState = { time: false, date: false, fps: false };
  function _osdAnyOn() { return _osdState.time || _osdState.date || _osdState.fps; }
  function _paintOsdRows() {
    osdPickerEl?.querySelectorAll('.visualizer-osd-row').forEach((row) => {
      row.classList.toggle('is-active', !!_osdState[row.dataset.osd]);
    });
  }
  function _updateOsdBtn() {
    const on = _osdAnyOn();
    osdBtn?.classList.toggle('is-active', on);
    if (osdBtn) osdBtn.textContent = on ? 'OSD ●' : 'OSD';
  }
  // Rolling FPS tracker — pushes a perf.now() on each canvas draw and
  // computes frames-per-second over the most recent ~1 s window. Reset
  // when overlay is hidden so stale numbers don't linger.
  const _fpsTimes = [];
  let _fpsValue = 0;
  function _trackFps() {
    const now = performance.now();
    _fpsTimes.push(now);
    while (_fpsTimes.length && now - _fpsTimes[0] > 1000) _fpsTimes.shift();
    _fpsValue = _fpsTimes.length;
  }
  // Paint TIME/DATE/FPS chips at top-left of the recording canvas.
  function _drawOsdOverlay(ctx, w, h) {
    if (!_osdAnyOn()) return;
    const fontSize = Math.max(14, Math.round(h * 0.024));
    const lineH = Math.round(fontSize * 1.35);
    const padX = Math.round(w * 0.018);
    const padY = Math.round(h * 0.018);
    const cellPadX = Math.round(fontSize * 0.55);
    const cellPadY = Math.round(fontSize * 0.3);
    const accent = _accentRgbCached();
    const lines = [];
    const now = new Date();
    if (_osdState.date) lines.push(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`);
    if (_osdState.time) lines.push(`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`);
    if (_osdState.fps)  lines.push(`${_fpsValue} FPS`);
    if (!lines.length) return;
    ctx.save();
    ctx.font = `bold ${fontSize}px 'JetBrains Mono', 'Consolas', monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let maxW = 0;
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
    const cellW = maxW + cellPadX * 2;
    const cellH = lineH + cellPadY * 0.5;
    let y = padY;
    for (const line of lines) {
      ctx.fillStyle = `rgba(0, 0, 0, 0.6)`;
      ctx.fillRect(padX, y, cellW, cellH);
      ctx.lineWidth = Math.max(1, fontSize * 0.08);
      ctx.strokeStyle = `rgba(${accent}, 0.85)`;
      ctx.strokeRect(padX + 0.5, y + 0.5, cellW - 1, cellH - 1);
      ctx.shadowColor = `rgba(${accent}, 0.85)`;
      ctx.shadowBlur = fontSize * 0.4;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.fillText(line, padX + cellPadX, y + cellH / 2);
      ctx.shadowBlur = 0;
      y += cellH + 3;
    }
    ctx.restore();
  }
  osdBtn?.addEventListener('click', () => {
    if (!osdPickerEl) return;
    if (osdPickerEl.hidden) {
      // Close any other picker so they don't stack.
      sourcePickerEl && (sourcePickerEl.hidden = true);
      sourceBtn?.classList.remove('is-active');
      qualityPickerEl && (qualityPickerEl.hidden = true);
      qualityBtn?.classList.remove('is-active');
      osdPickerEl.hidden = false;
      _paintOsdRows();
    } else {
      osdPickerEl.hidden = true;
    }
    playSfx?.('click');
  });
  osdCloseBtn?.addEventListener('click', () => {
    osdPickerEl.hidden = true;
    playSfx?.('click');
  });
  osdPickerEl?.addEventListener('click', (ev) => {
    const row = ev.target.closest('.visualizer-osd-row');
    if (!row) return;
    const k = row.dataset.osd;
    _osdState[k] = !_osdState[k];
    _paintOsdRows();
    _updateOsdBtn();
    try { window.dash?.setConfig?.({ osd: { ..._osdState } }); } catch {}
    playSfx?.(_osdState[k] ? 'confirm' : 'click');
  });
  // Restore from config.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    const saved = cfg.osd;
    if (saved && typeof saved === 'object') {
      _osdState.time = !!saved.time;
      _osdState.date = !!saved.date;
      _osdState.fps  = !!saved.fps;
      _paintOsdRows();
      _updateOsdBtn();
    }
  })();

  keysBtn?.addEventListener('click', async () => {
    _keysOverlayOn = !_keysOverlayOn;
    keysBtn.classList.toggle('is-active', _keysOverlayOn);
    keysBtn.textContent = _keysOverlayOn ? 'KEYS ●' : 'KEYS';
    if (_keysOverlayOn) {
      _keyUnsub = window.dash?.onKeycapture?.(_onKeyEvent) || null;
      try { await window.dash?.keycaptureStart?.(); } catch {}
    } else {
      try { await window.dash?.keycaptureStop?.(); } catch {}
      if (_keyUnsub) { try { _keyUnsub(); } catch {} _keyUnsub = null; }
      _keyEvents = [];
    }
    playSfx?.(_keysOverlayOn ? 'confirm' : 'click');
  });

  // ── Screen record: continuous video capture to gallery/recordings/ ─
  // Uses MediaRecorder on the active mirror stream. Each 1-second
  // chunk is streamed straight to main and appended to the .mkv file
  // so we don't hold the whole recording in renderer memory. Stops
  // automatically if the mirror is torn down.
  const screenrecBtn = document.getElementById('visualizer-screenrec-btn');
  let _screenrecState = null; // { id, recorder, pending: Promise[], cleanup }
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
    const cropOn = _cropActive && _cropRect.w > 0 && _cropRect.h > 0;
    const sx = cropOn ? Math.round(_cropRect.x * srcW) : 0;
    const sy = cropOn ? Math.round(_cropRect.y * srcH) : 0;
    const sw = cropOn ? Math.round(_cropRect.w * srcW) : srcW;
    const sh = cropOn ? Math.round(_cropRect.h * srcH) : srcH;
    const target = _recProfile.resolution;
    let outH = sh;
    if (target !== 'source' && typeof target === 'number' && target < sh) outH = target;
    const outW = Math.max(2, Math.round(sw * (outH / sh)));
    // Fast path: no crop, no downscale, no overlays → hand original
    // through. Any overlay (keys / OSD) needs the canvas so the overlay
    // is drawn into the recording without appearing in the preview.
    const osdOn = _osdAnyOn();
    if (!cropOn && outH === srcH && !_keysOverlayOn && !osdOn) {
      return { stream: _mirrorStream, cleanup: () => {} };
    }
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    let canceled = false;
    let rafId = 0;
    // Throttle the draw to the profile's fps. rAF runs at the display
    // refresh (60/144/240 Hz), so without throttling the OSD counts
    // monitor refresh — not what's being encoded. We sample one frame
    // per `frameInterval` ms; the 0.5 ms fudge keeps frame intervals
    // from drifting to the next rAF tick. Caps at display refresh: if
    // you pick 120 fps on a 60 Hz monitor, the actual rate is 60.
    const recFps = Math.max(1, Number(_recProfile.fps) || 30);
    const frameInterval = 1000 / recFps;
    let lastFrameTime = -Infinity;
    const draw = (timestamp) => {
      if (canceled) return;
      const t = (typeof timestamp === 'number') ? timestamp : performance.now();
      if (t - lastFrameTime >= frameInterval - 0.5) {
        if (visualizerVideoEl && visualizerVideoEl.readyState >= 2) {
          try { ctx.drawImage(visualizerVideoEl, sx, sy, sw, sh, 0, 0, outW, outH); } catch {}
        }
        if (_keysOverlayOn) _drawKeysOverlay(ctx, outW, outH);
        if (_osdAnyOn()) _drawOsdOverlay(ctx, outW, outH);
        _trackFps();
        lastFrameTime = t;
      }
      rafId = requestAnimationFrame(draw);
    };
    draw();
    const out = canvas.captureStream(recFps);
    for (const t of _mirrorStream.getAudioTracks()) {
      try { out.addTrack(t); } catch {}
    }
    return {
      stream: out,
      cleanup: () => {
        canceled = true;
        if (rafId) cancelAnimationFrame(rafId);
      },
    };
  }
  function _pickRecorderMime() {
    // Prefer H.264 in MP4 — Chromium hardware-encodes that path on
    // most systems (NVENC / QuickSync / AMF), which cuts the
    // recording CPU cost roughly in half compared to VP9 software
    // encode. Fall back to VP8 (cheaper than VP9) before VP9 since
    // VP9 software encode is the heaviest combo on the renderer.
    const candidates = [
      'video/mp4;codecs=avc1.42E01F,mp4a.40.2', // H.264 Baseline + AAC
      'video/mp4;codecs=avc1.4D401F,mp4a.40.2', // H.264 Main + AAC
      'video/mp4;codecs=avc1.64001F,mp4a.40.2', // H.264 High + AAC
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp8,opus',  // VP8 next — lighter than VP9
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm',
    ];
    for (const m of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
    }
    return '';
  }
  // Reports whether the picked MediaRecorder mime is hardware-friendly
  // (H.264 family). Used to skip the screenrec-stop transcode when the
  // recorder already emits MP4 directly.
  function _mimeIsMp4(mime) { return /^video\/mp4/.test(String(mime || '')); }
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
    const dest = ctx.createMediaStreamDestination();
    // Scheduling-ahead margin so the first few chunks don't underrun
    // before the AudioContext clock catches up. 60 ms is plenty for the
    // ~43 ms batched chunks the worker emits.
    const SCHED_AHEAD = 0.06;
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

  async function _startScreenrec() {
    if (_screenrecState) return;
    if (!_mirrorStream) {
      // Auto-start the mirror so REC works in one click. If that fails,
      // bail.
      await _startVisualizerMirror();
      if (!_mirrorStream) { playSfx?.('error'); return; }
    }
    const built = _buildRecorderStream();
    if (!built?.stream) { playSfx?.('error'); return; }
    // Always pull audio from the WASAPI loopback worker — it captures
    // whatever is currently going to the OS default render endpoint,
    // which means the user hears the source through their speakers as
    // usual and the recording gets a copy. We replace any mirror-derived
    // audio (some screen sources hand us an audio track that's already
    // a duplicate of the loopback, so dropping it avoids double audio).
    const loopback = await _buildLoopbackAudioTrack();
    let recStream = built.stream;
    if (loopback?.track) {
      recStream = new MediaStream([
        ...built.stream.getVideoTracks(),
        loopback.track,
      ]);
    }
    const audioCount = recStream.getAudioTracks().length;
    const videoCount = recStream.getVideoTracks().length;
    const srcKind = _mirrorSourceOverride?.id?.startsWith?.('window:') ? 'window'
                  : _mirrorSourceOverride?.id?.startsWith?.('screen:') ? 'screen'
                  : 'unknown';
    console.log('[screenrec] recorder stream:', { audio: audioCount, video: videoCount, kind: srcKind, loopback: !!loopback?.track });
    // Pick the mime FIRST so we can tell main whether to expect MP4
    // bytes (hardware-encoded H.264 — skip the post-stop transcode)
    // or WebM (software VP8/VP9 — re-encode to .mp4 on stop).
    const mime = _pickRecorderMime();
    let started;
    try { started = await window.dash?.screenrecStart?.({ mime }); } catch { started = null; }
    if (!started?.ok || !started.id) {
      built.cleanup?.();
      try { await loopback?.teardown?.(); } catch {}
      playSfx?.('error');
      return;
    }
    const opts = { videoBitsPerSecond: _recProfile.bitsPerSec || 5_000_000 };
    if (mime) opts.mimeType = mime;
    let recorder;
    try {
      recorder = new MediaRecorder(recStream, opts);
    } catch (err) {
      console.warn('[screenrec] MediaRecorder failed:', err?.message || err);
      built.cleanup?.();
      try { await loopback?.teardown?.(); } catch {}
      try { await window.dash?.screenrecStop?.(started.id); } catch {}
      playSfx?.('error');
      return;
    }
    console.log('[screenrec] recording started:', { mime: recorder.mimeType, bps: opts.videoBitsPerSecond });
    // Surface the chosen encoder path in the toolbar tooltip so the
    // user can see at a glance whether they got the GPU path
    // (H.264/MP4) or the software fallback (VP8/VP9/WebM).
    if (screenrecBtn) {
      const isGpu = _mimeIsMp4(recorder.mimeType);
      screenrecBtn.title = isGpu
        ? `REC · hardware H.264 (low CPU) · ${(opts.videoBitsPerSecond/1_000_000).toFixed(1)} Mbps`
        : `REC · software VP8/VP9 (CPU-bound) · ${(opts.videoBitsPerSecond/1_000_000).toFixed(1)} Mbps`;
    }
    const pending = [];
    recorder.ondataavailable = async (ev) => {
      if (!ev.data || !ev.data.size) return;
      try {
        const buf = new Uint8Array(await ev.data.arrayBuffer());
        // Track in flight so stop() can await them and we don't lose
        // the trailing chunk.
        const p = window.dash?.screenrecChunk?.(started.id, buf);
        pending.push(p);
      } catch (err) {
        console.warn('[screenrec] chunk send failed:', err?.message || err);
      }
    };
    recorder.onerror = (e) => console.warn('[screenrec] recorder error', e?.error || e);
    recorder.start(1000); // 1-second chunks
    _screenrecState = {
      id: started.id,
      recorder,
      pending,
      cleanup: async () => {
        try { built.cleanup?.(); } catch {}
        try { await loopback?.teardown?.(); } catch {}
      },
    };
    screenrecBtn?.classList.add('is-active');
    if (screenrecBtn) {
      screenrecBtn.textContent = 'REC ●';
      screenrecBtn.title = audioCount > 0
        ? 'Recording with loopback audio (system audio)'
        : 'Recording WITHOUT audio (loopback unavailable)';
    }
  }
  async function _stopScreenrec() {
    const st = _screenrecState;
    if (!st) return;
    _screenrecState = null;
    screenrecBtn?.classList.remove('is-active');
    if (screenrecBtn) screenrecBtn.textContent = 'REC';
    try {
      // Wait for the final ondataavailable to fire on stop, then for
      // any in-flight chunks to land in main before closing the file.
      await new Promise((resolve) => {
        try { st.recorder.addEventListener('stop', () => resolve(), { once: true }); st.recorder.stop(); }
        catch { resolve(); }
      });
      await Promise.allSettled(st.pending);
      const res = await window.dash?.screenrecStop?.(st.id);
      if (res?.ok) {
        console.log('[screenrec] saved:', res.path, '·', res.encoder, '·', res.size, 'bytes');
        if (screenrecBtn) {
          screenrecBtn.title = `Saved ${res.name} (${(res.size / 1024 / 1024).toFixed(1)} MB) · click to record again`;
        }
        if (visualizerNowEl) visualizerNowEl.textContent = `SAVED · ${res.name}`;
      } else {
        // Surface the failure so it's not silent — main returns a reason.
        const why = res?.error || 'no response from main process';
        console.error('[screenrec] SAVE FAILED:', why, res);
        if (screenrecBtn) screenrecBtn.title = `SAVE FAILED — ${why}`;
        if (visualizerNowEl) visualizerNowEl.textContent = `REC SAVE FAILED · ${why}`;
      }
      // Auto-navigate the gallery browser into recordings/ so the new
      // file is immediately visible without the user having to dig.
      try { _visualizerSubdir = 'recordings'; refreshVisualizer(); } catch {}
    } catch (err) {
      console.warn('[screenrec] stop failed:', err?.message || err);
    } finally {
      // cleanup is async (it awaits setLoopbackPcm(false) + ctx.close);
      // fire-and-forget is fine — the audio worker only takes a few ms
      // to flip flag, and we don't want to block the user from starting
      // the next recording.
      try { Promise.resolve(st.cleanup?.()).catch(() => {}); } catch {}
    }
  }
  screenrecBtn?.addEventListener('click', () => {
    if (_screenrecState) { _stopScreenrec(); playSfx?.('click'); }
    else                 { _startScreenrec(); playSfx?.('confirm'); }
  });
  // Keep the play/pause icon in sync regardless of who initiated the
  // state change (transport buttons, native video controls, ended-event
  // auto-advance, etc.).
  visualizerVideoEl?.addEventListener('play',     updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('pause',    updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('emptied',  updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('loadeddata', updatePlayPauseIcon);
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
  visualizerVideoEl?.addEventListener('ended', () => {
    const playable = _playableEntries();
    const idx = playable.findIndex((e) => e.path === _visualizerCurrent);
    const next = playable[idx + 1];
    if (next) playVisualizerEntry(next);
  });

  _activateImpl = () => { try { refreshVisualizer(); } catch {} };
}

export function activate() { _activateImpl?.(); }
