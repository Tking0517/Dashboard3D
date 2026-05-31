// ── §bgm ── MUSIC — local library player ────────────────────────────
// Plays audio files from the managed `music/` folder (next to the .exe
// in a packaged build, or the repo root in dev). This used to be a
// procedural Web-Audio synthesizer; it is now a straight file player
// with a library browser and user-built playlists.
//
// Lazy combo pane — app.js dynamically import()s this on first MUSIC
// open via activateLazyPane(). init() receives { playSfx }. The module
// keeps exposing window._bgmState (read by paintComboHeader) and
// window._bgmMaybeStartMeter (called by setComboMode), plus a new
// window._musicPlayExternal(rel) so the EXPLORE pane can hand a file
// straight to the player.

const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|weba)$/i;

let _ready = false;
let _deps = null;

// ── DOM refs (resolved in init) ─────────────────────────────────────
let bgmNowEl, bgmListEl, bgmMeterEl;
let bgmVolEl, bgmVolValEl;
let bgmPlayBtn, bgmPlayIcon, bgmPauseIcon;

// ── Player ──────────────────────────────────────────────────────────
let audioEl   = null;          // the <audio> element doing playback
let _actx     = null;          // AudioContext (lazy — needs a gesture)
let _srcNode  = null;          // MediaElementSource (once per element)
let _gainNode = null;          // volume
let _bgmAnalyser = null;        // feeds the meter

// ── Data ────────────────────────────────────────────────────────────
let library   = [];            // [{ name, rel }]  — scanned music folder
let playlists = [];            // [{ id, name, tracks: [rel] }]
let queue     = [];            // [rel] currently being walked by prev/next
let queueIndex = -1;
let curRel    = null;          // rel of the loaded track (null = none)

// View state for the #bgm-list area.
let view = 'library';          // 'library' | 'playlists' | 'playlist' | 'add'
let openPlaylistId = null;     // which playlist 'playlist'/'add' views target
let _creatingPlaylist = false; // inline "new playlist" input is showing
let _renamingId = null;        // playlist id whose name is being edited
let _renamingTrackRel = null;  // library track rel being renamed inline

// ── Trim modal state ────────────────────────────────────────────────
let _trimEls = null;           // resolved DOM refs (null if markup absent)
let _trimAudio = null;         // dedicated <audio> for the modal preview
let _trimRel = null;           // track being trimmed
let _trimDur = 0;              // full source duration (s)
let _trimIn = 0;
let _trimOut = 0;
let _trimPreviewing = false;   // PREVIEW playing the selection only
let _trimSeeking = false;      // user is dragging the scrub bar
let _trimRaf = 0;
let _trimBusy = false;         // ffmpeg trim in flight

window._bgmState = window._bgmState || { playing: false, genre: '', volume: 0.5 };

// ── Visualizer state ────────────────────────────────────────────────
let _bgmMeterRaf = 0;
let _bgmBarCount = 0;
let _bgmDisplayed = new Float32Array(0);
let _bgmPeaks = new Float32Array(0);
let _bgmPeakHold = new Float32Array(0);

// ── Helpers ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}
// Display name = file name without its extension.
function trackName(rel) {
  const base = String(rel || '').split('/').pop() || rel;
  return base.replace(/\.[^.]+$/, '');
}
// rel path → dash3d-file:// URL served from the music root by main.js.
function relToUrl(rel) {
  return 'dash3d-file://music/' + String(rel).split('/').map(encodeURIComponent).join('/');
}
function playlistById(id) {
  return playlists.find((p) => p.id === id) || null;
}

// ── Persistence ─────────────────────────────────────────────────────
async function loadConfig() {
  let cfg = {};
  try { cfg = (await window.dash?.getConfig?.()) || {}; } catch {}
  if (Array.isArray(cfg.musicPlaylists)) {
    playlists = cfg.musicPlaylists
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => ({
        id: String(p.id || ('pl-' + Math.random().toString(36).slice(2, 9))),
        name: String(p.name),
        tracks: Array.isArray(p.tracks) ? p.tracks.map(String) : [],
      }));
  }
  if (typeof cfg.musicVolume === 'number') {
    window._bgmState.volume = Math.max(0, Math.min(1, cfg.musicVolume));
  }
}
function savePlaylists() {
  try { window.dash?.setConfig?.({ musicPlaylists: playlists }); } catch {}
}
function saveVolume() {
  try { window.dash?.setConfig?.({ musicVolume: window._bgmState.volume }); } catch {}
}

// ── Library scan ────────────────────────────────────────────────────
async function scanLibrary() {
  let res = null;
  try { res = await window.dash?.musicList?.(''); } catch {}
  const out = [];
  const walk = (entries) => {
    for (const e of (entries || [])) {
      if (e.isDir) continue;            // flat view — top-level files only
      if (AUDIO_RE.test(e.name)) out.push({ name: e.name, rel: e.rel });
    }
  };
  if (res && Array.isArray(res.entries)) walk(res.entries);
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  library = out;
}

// ── Audio graph ─────────────────────────────────────────────────────
function ensureAudio() {
  if (audioEl) return;
  audioEl = document.createElement('audio');
  audioEl.preload = 'metadata';
  // Required before any src is set — lets createMediaElementSource() tap
  // the stream without a cross-origin taint silencing the graph.
  audioEl.crossOrigin = 'anonymous';
  audioEl.addEventListener('ended', () => playRelativeInQueue(+1, true));
  audioEl.addEventListener('error', () => {
    // Bad / unreadable file — skip forward so one dud doesn't wedge play.
    if (queue.length > 1) playRelativeInQueue(+1, true);
    else stopPlayback();
  });
  audioEl.addEventListener('play',  () => { window._bgmState.playing = true;  syncTransport(); });
  audioEl.addEventListener('pause', () => { window._bgmState.playing = false; syncTransport(); });
  const host = document.querySelector('.combo-pane-music') || document.body;
  audioEl.style.display = 'none';
  host.appendChild(audioEl);
}
function ensureGraph() {
  if (_actx) return;
  try {
    _actx = new (window.AudioContext || window.webkitAudioContext)();
    _srcNode = _actx.createMediaElementSource(audioEl);
    _gainNode = _actx.createGain();
    _gainNode.gain.value = window._bgmState.volume;
    _bgmAnalyser = _actx.createAnalyser();
    _bgmAnalyser.fftSize = 1024;
    _bgmAnalyser.smoothingTimeConstant = 0.6;
    _srcNode.connect(_gainNode).connect(_bgmAnalyser).connect(_actx.destination);
  } catch (err) {
    console.warn('[music] audio graph init failed', err);
  }
}

// ── Playback ────────────────────────────────────────────────────────
function loadAndPlay(rel) {
  if (!rel) return;
  ensureAudio();
  ensureGraph();
  curRel = rel;
  audioEl.src = relToUrl(rel);
  try { _actx?.resume?.(); } catch {}
  const p = audioEl.play();
  if (p && p.catch) p.catch((err) => console.warn('[music] play failed', err));
  window._bgmState.genre = trackName(rel);   // header tag reads this
  updateNow();
  renderList();
  window._bgmMaybeStartMeter?.();
}
// Start a fresh queue from `list` at `index` and play that entry.
function playQueue(list, index) {
  queue = (list || []).slice();
  queueIndex = Math.max(0, Math.min(queue.length - 1, index | 0));
  if (queue.length) loadAndPlay(queue[queueIndex]);
}
// Step within the queue. `wrap` loops past the ends (used by auto-advance
// and the prev/next buttons). Returns quietly if the queue is empty.
function playRelativeInQueue(delta, wrap) {
  if (!queue.length) return;
  let i = queueIndex + delta;
  if (wrap) i = (i % queue.length + queue.length) % queue.length;
  if (i < 0 || i >= queue.length) { stopPlayback(); return; }
  queueIndex = i;
  loadAndPlay(queue[queueIndex]);
}
function togglePlay() {
  ensureAudio();
  if (!curRel) {
    // Nothing loaded yet — start the library from the top.
    if (library.length) playQueue(library.map((t) => t.rel), 0);
    return;
  }
  if (audioEl.paused) {
    try { _actx?.resume?.(); } catch {}
    audioEl.play()?.catch?.(() => {});
  } else {
    audioEl.pause();
  }
}
function stopPlayback() {
  if (audioEl) { try { audioEl.pause(); audioEl.currentTime = 0; } catch {} }
  window._bgmState.playing = false;
  window._bgmState.genre = '';
  curRel = null;
  updateNow();
  syncTransport();
  renderList();
}

// ── UI sync ─────────────────────────────────────────────────────────
function updateNow() {
  if (!bgmNowEl) return;
  bgmNowEl.textContent = curRel
    ? trackName(curRel)
    : '— STOPPED —';
}
function syncTransport() {
  const playing = !!window._bgmState.playing;
  if (bgmPlayIcon)  bgmPlayIcon.hidden  = playing;
  if (bgmPauseIcon) bgmPauseIcon.hidden = !playing;
  if (bgmPlayBtn) bgmPlayBtn.classList.toggle('is-playing', playing);
}
function setVolume(v01) {
  const v = Math.max(0, Math.min(1, v01));
  window._bgmState.volume = v;
  if (_gainNode) _gainNode.gain.value = v;
  if (bgmVolEl) bgmVolEl.value = String(Math.round(v * 100));
  if (bgmVolValEl) bgmVolValEl.textContent = `${Math.round(v * 100)}%`;
  saveVolume();
}

// ── List rendering ──────────────────────────────────────────────────
function renderList() {
  if (!bgmListEl) return;
  document.getElementById('bgm-view-library')
    ?.classList.toggle('is-active', view === 'library');
  document.getElementById('bgm-view-playlists')
    ?.classList.toggle('is-active', view !== 'library');

  if (view === 'library')   { bgmListEl.innerHTML = renderLibrary();   return; }
  if (view === 'playlists') { bgmListEl.innerHTML = renderPlaylists(); return; }
  if (view === 'playlist')  { bgmListEl.innerHTML = renderPlaylistDetail(); return; }
  if (view === 'add')       { bgmListEl.innerHTML = renderAddTracks();  return; }
}
function trackRow(rel, opts = {}) {
  const playing = rel === curRel;
  const cls = 'bgm-item' + (playing ? ' is-playing' : '');
  const btn = opts.removeFromPl
    ? `<button type="button" class="bgm-item-x" data-act="rm-track" data-rel="${esc(rel)}" title="Remove from playlist">✕</button>`
    : opts.addToggle
      ? `<button type="button" class="bgm-item-x bgm-item-add${opts.inPlaylist ? ' is-in' : ''}" data-act="toggle-track" data-rel="${esc(rel)}" title="${opts.inPlaylist ? 'Remove from playlist' : 'Add to playlist'}">${opts.inPlaylist ? '✓' : '+'}</button>`
      : '';
  // Library rows get a hover cluster: rename, trim, delete.
  const libActions = opts.libActions
    ? `<span class="bgm-row-actions">`
      + `<button type="button" class="bgm-item-x" data-act="rename-track" data-rel="${esc(rel)}" title="Rename">✎</button>`
      + `<button type="button" class="bgm-item-x" data-act="trim-track" data-rel="${esc(rel)}" title="Trim">✂</button>`
      + `<button type="button" class="bgm-item-x bgm-act-del" data-act="del-track" data-rel="${esc(rel)}" title="Delete (Recycle Bin)">✕</button>`
      + `</span>`
    : '';
  return `<div class="${cls}" data-act="${esc(opts.act || 'play')}" data-rel="${esc(rel)}">`
       + `<span class="bgm-item-eq">${playing ? '▶' : ''}</span>`
       + `<span class="bgm-item-name">${esc(trackName(rel))}</span>`
       + btn
       + libActions
       + `</div>`;
}
function renderLibrary() {
  if (!library.length) {
    return `<div class="bgm-empty">No audio files found.<br>`
         + `Put music in the <b>music</b> folder, then press ⟳ to rescan —`
         + ` or use <b>BROWSE</b>.</div>`;
  }
  return `<div class="bgm-list-head">LIBRARY · ${library.length} TRACK${library.length === 1 ? '' : 'S'}</div>`
       + library.map((t) => (
           _renamingTrackRel === t.rel
             ? `<div class="bgm-item bgm-item-input">`
               + `<span class="bgm-item-eq">✎</span>`
               + `<input type="text" class="bgm-inline-input" data-rename-track="${esc(t.rel)}" value="${esc(trackName(t.rel))}" maxlength="120">`
               + `</div>`
             : trackRow(t.rel, { libActions: true })
         )).join('');
}
function renderPlaylists() {
  let html = '';
  if (_creatingPlaylist) {
    html += `<div class="bgm-item bgm-item-input">`
          + `<input type="text" id="bgm-new-pl-input" class="bgm-inline-input" placeholder="Playlist name…" maxlength="48">`
          + `</div>`;
  } else {
    html += `<div class="bgm-item bgm-item-action" data-act="new-pl">`
          + `<span class="bgm-item-eq">+</span><span class="bgm-item-name">NEW PLAYLIST</span></div>`;
  }
  if (!playlists.length && !_creatingPlaylist) {
    html += `<div class="bgm-empty">No playlists yet.<br>Make one, then add tracks from the library.</div>`;
  }
  for (const p of playlists) {
    if (_renamingId === p.id) {
      html += `<div class="bgm-item bgm-item-input">`
            + `<input type="text" class="bgm-inline-input" data-rename="${esc(p.id)}" value="${esc(p.name)}" maxlength="48">`
            + `</div>`;
      continue;
    }
    html += `<div class="bgm-item" data-act="open-pl" data-pl="${esc(p.id)}">`
          + `<span class="bgm-item-eq">♪</span>`
          + `<span class="bgm-item-name">${esc(p.name)}</span>`
          + `<span class="bgm-item-meta">${p.tracks.length}</span>`
          + `<button type="button" class="bgm-item-x" data-act="rename-pl" data-pl="${esc(p.id)}" title="Rename">✎</button>`
          + `<button type="button" class="bgm-item-x" data-act="del-pl" data-pl="${esc(p.id)}" title="Delete playlist">✕</button>`
          + `</div>`;
  }
  return html;
}
function renderPlaylistDetail() {
  const pl = playlistById(openPlaylistId);
  if (!pl) { view = 'playlists'; return renderPlaylists(); }
  let html = `<div class="bgm-item bgm-item-action" data-act="back"><span class="bgm-item-eq">‹</span>`
           + `<span class="bgm-item-name">PLAYLISTS</span></div>`
           + `<div class="bgm-list-head">${esc(pl.name)} · ${pl.tracks.length} TRACK${pl.tracks.length === 1 ? '' : 'S'}</div>`
           + `<div class="bgm-item bgm-item-action" data-act="add-mode"><span class="bgm-item-eq">+</span>`
           + `<span class="bgm-item-name">ADD FROM LIBRARY</span></div>`;
  if (!pl.tracks.length) {
    html += `<div class="bgm-empty">Empty playlist.</div>`;
  } else {
    html += pl.tracks.map((rel) => trackRow(rel, { act: 'play-pl', removeFromPl: true })).join('');
  }
  return html;
}
function renderAddTracks() {
  const pl = playlistById(openPlaylistId);
  if (!pl) { view = 'playlists'; return renderPlaylists(); }
  let html = `<div class="bgm-item bgm-item-action" data-act="back-detail"><span class="bgm-item-eq">‹</span>`
           + `<span class="bgm-item-name">DONE</span></div>`
           + `<div class="bgm-list-head">ADD TO ${esc(pl.name)}</div>`;
  if (!library.length) {
    html += `<div class="bgm-empty">Library is empty.</div>`;
    return html;
  }
  const inSet = new Set(pl.tracks);
  html += library.map((t) => trackRow(t.rel, { act: 'noop', addToggle: true, inPlaylist: inSet.has(t.rel) })).join('');
  return html;
}

// ── List interaction ────────────────────────────────────────────────
function onListClick(e) {
  const row = e.target.closest('[data-act]');
  if (!row || !bgmListEl.contains(row)) return;
  const act = row.dataset.act;
  const rel = row.dataset.rel;
  const plId = row.dataset.pl;
  _deps?.playSfx?.('click');
  switch (act) {
    case 'play': {
      const idx = library.findIndex((t) => t.rel === rel);
      if (idx >= 0) playQueue(library.map((t) => t.rel), idx);
      break;
    }
    case 'play-pl': {
      const pl = playlistById(openPlaylistId);
      if (pl) {
        const idx = pl.tracks.indexOf(rel);
        if (idx >= 0) playQueue(pl.tracks, idx);
      }
      break;
    }
    case 'new-pl':
      _creatingPlaylist = true;
      renderList();
      document.getElementById('bgm-new-pl-input')?.focus();
      break;
    case 'open-pl':
      openPlaylistId = plId;
      view = 'playlist';
      renderList();
      break;
    case 'del-pl':
      playlists = playlists.filter((p) => p.id !== plId);
      savePlaylists();
      renderList();
      break;
    case 'rename-pl':
      _renamingId = plId;
      renderList();
      bgmListEl.querySelector(`[data-rename="${CSS.escape(plId)}"]`)?.focus();
      break;
    case 'back':
      view = 'playlists';
      renderList();
      break;
    case 'add-mode':
      view = 'add';
      renderList();
      break;
    case 'back-detail':
      view = 'playlist';
      renderList();
      break;
    case 'rm-track': {
      const pl = playlistById(openPlaylistId);
      if (pl) { pl.tracks = pl.tracks.filter((r) => r !== rel); savePlaylists(); renderList(); }
      break;
    }
    case 'toggle-track': {
      const pl = playlistById(openPlaylistId);
      if (pl) {
        if (pl.tracks.includes(rel)) pl.tracks = pl.tracks.filter((r) => r !== rel);
        else pl.tracks.push(rel);
        savePlaylists();
        renderList();
      }
      break;
    }
    case 'rename-track':
      _renamingTrackRel = rel;
      renderList();
      bgmListEl.querySelector(`[data-rename-track="${CSS.escape(rel)}"]`)?.focus();
      break;
    case 'trim-track':
      _openTrim(rel);
      break;
    case 'del-track':
      _deleteTrack(rel);
      break;
    default: break;
  }
}
function onListKeydown(e) {
  const input = e.target.closest('.bgm-inline-input');
  if (!input) return;
  if (e.key === 'Enter') {
    if (input.dataset.renameTrack) { _commitTrackRename(input.dataset.renameTrack, input.value); return; }
    const name = input.value.trim();
    const renameId = input.dataset.rename;
    if (renameId) {
      const pl = playlistById(renameId);
      if (pl && name) pl.name = name;
      _renamingId = null;
      savePlaylists();
    } else if (name) {
      playlists.push({ id: 'pl-' + Math.random().toString(36).slice(2, 9), name, tracks: [] });
      _creatingPlaylist = false;
      savePlaylists();
    } else {
      _creatingPlaylist = false;
    }
    renderList();
  } else if (e.key === 'Escape') {
    _creatingPlaylist = false;
    _renamingId = null;
    _renamingTrackRel = null;
    renderList();
  }
}

// ── Library file ops (rename / delete) ──────────────────────────────
async function _commitTrackRename(rel, raw) {
  const name = String(raw || '').trim();
  _renamingTrackRel = null;
  if (!name || name === trackName(rel)) { renderList(); return; }
  let res = null;
  try { res = await window.dash?.musicRename?.(rel, name); }
  catch (err) { res = { ok: false, error: err?.message }; }
  if (!res?.ok) {
    renderList();
    window.alert('Rename failed: ' + (res?.error || 'unknown error'));
    return;
  }
  // Follow the file in playback state so the rename doesn't desync.
  if (curRel === rel) { curRel = res.rel; window._bgmState.genre = trackName(res.rel); updateNow(); }
  const qi = queue.indexOf(rel);
  if (qi >= 0) queue[qi] = res.rel;
  await scanLibrary();
  renderList();
}

async function _deleteTrack(rel) {
  const ok = window.confirm(`Delete "${trackName(rel)}"?\nIt will be moved to the Recycle Bin.`);
  if (!ok) return;
  // Release the playing handle first so the OS can move the file.
  if (curRel === rel) {
    stopPlayback();
    if (audioEl) { try { audioEl.removeAttribute('src'); audioEl.load(); } catch {} }
  }
  let res = null;
  try { res = await window.dash?.musicDelete?.(rel); }
  catch (err) { res = { ok: false, error: err?.message }; }
  if (!res?.ok) {
    window.alert('Delete failed: ' + (res?.error || 'unknown error'));
    return;
  }
  queue = queue.filter((r) => r !== rel);
  let plChanged = false;
  for (const p of playlists) {
    const before = p.tracks.length;
    p.tracks = p.tracks.filter((r) => r !== rel);
    if (p.tracks.length !== before) plChanged = true;
  }
  if (plChanged) savePlaylists();
  await scanLibrary();
  renderList();
}

// ════════════════════════════════════════════════════════════════════
// TRIM MODAL — scrub to set IN/OUT on a dedicated <audio>, PREVIEW the
// selection, then SAVE overwrites the source file in place via the
// music-trim IPC (lossless stream-copy in main). All refs resolved in
// init(); _openTrim/_closeTrim manage visibility + the preview element.
// ════════════════════════════════════════════════════════════════════
function _fmtT(s) {
  s = Math.max(0, Number(s) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
function _trimSetSaveEnabled(on) { if (_trimEls?.save) _trimEls.save.disabled = !on; }
function _trimSetPlayIcon(playing) { if (_trimEls?.play) _trimEls.play.textContent = playing ? '❚❚' : '▶'; }
function _setTrimStatus(msg, kind) {
  if (!_trimEls) return;
  _trimEls.status.hidden = !msg;
  _trimEls.status.textContent = msg || '';
  _trimEls.status.className = 'bgm-trim-status' + (kind ? ' is-' + kind : '');
}
function _trimUpdatePlayhead() {
  if (!_trimEls || !_trimAudio) return;
  const d = _trimDur || 1;
  const t = Math.min(_trimDur, Math.max(0, _trimAudio.currentTime || 0));
  if (!_trimSeeking) _trimEls.seek.value = String(Math.round((t / d) * 1000));
  _trimEls.pos.textContent = _fmtT(t);
}
function _trimTick() {
  if (!_trimAudio) { _trimRaf = 0; return; }
  if (_trimPreviewing && _trimAudio.currentTime >= _trimOut) {
    _trimAudio.pause();
    _trimPreviewing = false;
  }
  _trimUpdatePlayhead();
  _trimRaf = _trimAudio.paused ? 0 : requestAnimationFrame(_trimTick);
}
function _trimUpdate() {
  if (!_trimEls) return;
  const d = _trimDur || 0;
  _trimIn = Math.max(0, Math.min(_trimIn, d));
  _trimOut = Math.max(0, Math.min(_trimOut || d, d));
  if (_trimOut < _trimIn) { const x = _trimIn; _trimIn = _trimOut; _trimOut = x; }
  _trimEls.in.textContent = _fmtT(_trimIn);
  _trimEls.out.textContent = _fmtT(_trimOut);
  const newLen = Math.max(0, _trimOut - _trimIn);
  _trimEls.newlen.textContent = _fmtT(newLen);
  const inFrac = d > 0 ? _trimIn / d : 0;
  const outFrac = d > 0 ? _trimOut / d : 1;
  _trimEls.bar.style.setProperty('--in', inFrac.toFixed(4));
  _trimEls.bar.style.setProperty('--out', outFrac.toFixed(4));
  // Valid only when there's a real cut to make (not the whole file).
  const valid = d > 0 && newLen > 0.05 && !(inFrac <= 0.001 && outFrac >= 0.999);
  _trimSetSaveEnabled(valid && !_trimBusy);
  _trimUpdatePlayhead();
}
function _openTrim(rel) {
  if (!_trimEls || !rel) return;
  _trimRel = rel;
  // Pause library playback so we don't double up audio.
  if (audioEl && !audioEl.paused) audioEl.pause();
  if (!_trimAudio) {
    _trimAudio = new Audio();
    _trimAudio.preload = 'metadata';
    _trimAudio.addEventListener('loadedmetadata', () => {
      _trimDur = Number.isFinite(_trimAudio.duration) ? _trimAudio.duration : 0;
      _trimIn = 0; _trimOut = _trimDur;
      _trimEls.dur.textContent = _fmtT(_trimDur);
      _trimUpdate();
    });
    _trimAudio.addEventListener('play',  () => { _trimSetPlayIcon(true); if (!_trimRaf) _trimRaf = requestAnimationFrame(_trimTick); });
    _trimAudio.addEventListener('pause', () => { _trimSetPlayIcon(false); _trimPreviewing = false; });
    _trimAudio.addEventListener('ended', () => { _trimSetPlayIcon(false); _trimPreviewing = false; });
  }
  _trimPreviewing = false;
  _trimBusy = false;
  _trimDur = 0; _trimIn = 0; _trimOut = 0;
  _trimEls.name.textContent = trackName(rel);
  _trimEls.dur.textContent = '0:00.0';
  _trimEls.seek.value = '0';
  _setTrimStatus('', null);
  _trimSetSaveEnabled(false);
  _trimSetPlayIcon(false);
  _trimAudio.src = relToUrl(rel);
  try { _trimAudio.currentTime = 0; } catch {}
  _trimEls.root.hidden = false;
  _trimUpdate();
}
function _closeTrim() {
  if (_trimRaf) { cancelAnimationFrame(_trimRaf); _trimRaf = 0; }
  if (_trimAudio) { try { _trimAudio.pause(); _trimAudio.removeAttribute('src'); _trimAudio.load(); } catch {} }
  _trimPreviewing = false;
  _trimRel = null;
  if (_trimEls) _trimEls.root.hidden = true;
}
async function _saveTrim() {
  if (_trimBusy || !_trimRel) return;
  const rel = _trimRel;
  const inSec = _trimIn, outSec = _trimOut;
  if (!(outSec > inSec + 0.05)) return;
  _trimBusy = true;
  _trimSetSaveEnabled(false);
  _setTrimStatus('TRIMMING…', 'busy');
  // Release every handle on the file before main overwrites it.
  if (_trimAudio) { try { _trimAudio.pause(); _trimAudio.removeAttribute('src'); _trimAudio.load(); } catch {} }
  const wasLoaded = (curRel === rel);
  const wasPlaying = wasLoaded && !!window._bgmState.playing;
  if (wasLoaded) {
    stopPlayback();
    if (audioEl) { try { audioEl.removeAttribute('src'); audioEl.load(); } catch {} }
  }
  let res = null;
  try { res = await window.dash?.musicTrim?.({ rel, inSec, outSec }); }
  catch (err) { res = { ok: false, error: err?.message }; }
  if (!res?.ok) {
    _trimBusy = false;
    _setTrimStatus('FAILED · ' + (res?.error || 'unknown error'), 'error');
    if (_trimAudio) { _trimAudio.src = relToUrl(rel); }   // rebind for retry
    _trimUpdate();
    return;
  }
  await scanLibrary();
  if (wasPlaying) {
    const idx = library.findIndex((t) => t.rel === rel);
    if (idx >= 0) playQueue(library.map((t) => t.rel), idx);
  }
  renderList();
  _trimBusy = false;
  _closeTrim();
}
function _wireTrim() {
  if (!_trimEls) return;
  _trimEls.seek.addEventListener('input', () => {
    _trimSeeking = true;
    const d = _trimDur || 0;
    const t = ((parseInt(_trimEls.seek.value, 10) || 0) / 1000) * d;
    if (_trimAudio) { try { _trimAudio.currentTime = t; } catch {} }
    _trimEls.pos.textContent = _fmtT(t);
  });
  _trimEls.seek.addEventListener('change', () => { _trimSeeking = false; });
  _trimEls.play.addEventListener('click', () => {
    _deps?.playSfx?.('click');
    if (!_trimAudio) return;
    _trimPreviewing = false;
    if (_trimAudio.paused) _trimAudio.play()?.catch?.(() => {});
    else _trimAudio.pause();
  });
  _trimEls.preview.addEventListener('click', () => {
    _deps?.playSfx?.('click');
    if (!_trimAudio || _trimDur <= 0) return;
    try { _trimAudio.currentTime = _trimIn; } catch {}
    _trimPreviewing = true;
    _trimAudio.play()?.catch?.(() => {});
  });
  _trimEls.setIn.addEventListener('click', () => {
    _deps?.playSfx?.('click');
    if (_trimAudio) _trimIn = _trimAudio.currentTime;
    if (_trimIn > _trimOut) _trimOut = _trimDur;
    _trimUpdate();
  });
  _trimEls.setOut.addEventListener('click', () => {
    _deps?.playSfx?.('click');
    if (_trimAudio) _trimOut = _trimAudio.currentTime;
    if (_trimOut < _trimIn) _trimIn = 0;
    _trimUpdate();
  });
  _trimEls.cancel.addEventListener('click', () => { _deps?.playSfx?.('click'); _closeTrim(); });
  _trimEls.save.addEventListener('click', () => { _deps?.playSfx?.('click'); _saveTrim(); });
  // Backdrop click (outside the card) closes; Escape closes too.
  _trimEls.root.addEventListener('click', (e) => { if (e.target === _trimEls.root) _closeTrim(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _trimEls && !_trimEls.root.hidden && !_trimBusy) _closeTrim();
  });
}

// ════════════════════════════════════════════════════════════════════
// VISUALIZER — the master-bus level meter. Segmented EQ bars on most
// themes; under e-ink it draws the same axis-framed flat line chart the
// system audio + panel graphs use (drawEinkChartFrame is exposed on
// window by app.js — music.js is its own chunk).
// ════════════════════════════════════════════════════════════════════
function _bgmTargetBarCount(W) {
  const TARGET_BAR_PX = 6;
  return Math.max(48, Math.min(128, Math.floor(W / TARGET_BAR_PX)));
}
function _bgmEnsureBarArrays(n) {
  if (_bgmBarCount === n) return;
  _bgmBarCount = n;
  _bgmDisplayed = new Float32Array(n);
  _bgmPeaks = new Float32Array(n);
  _bgmPeakHold = new Float32Array(n);
}
function _bgmResolveColors() {
  const cs = getComputedStyle(bgmMeterEl || document.documentElement);
  const accentStr = (cs.getPropertyValue('--accent').trim()
                  || cs.getPropertyValue('--audio-color').trim()
                  || '#5ccfff');
  const amberStr  = (cs.getPropertyValue('--amber').trim() || '#f3a83b');
  const redStr    = (cs.getPropertyValue('--red').trim()   || '#ff3b30');
  const parseHex = (s) => {
    let h = (s || '').trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  };
  const brightOut = parseHex(accentStr) || [80, 200, 255];
  const dimOut    = [Math.round(brightOut[0]*0.25), Math.round(brightOut[1]*0.25), Math.round(brightOut[2]*0.25)];
  const brightIn  = parseHex(amberStr) || [243, 168, 59];
  const dimIn     = [Math.round(brightIn[0]*0.25), Math.round(brightIn[1]*0.25), Math.round(brightIn[2]*0.25)];
  return { brightOut, dimOut, brightIn, dimIn, accentStr, amberStr, redStr };
}
function _bgmDrawMeter() {
  if (!bgmMeterEl || !_bgmAnalyser) { _bgmMeterRaf = 0; return; }
  const dpr = window.devicePixelRatio || 1;
  const cssW = bgmMeterEl.clientWidth || bgmMeterEl.width;
  const cssH = bgmMeterEl.clientHeight || bgmMeterEl.height;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (bgmMeterEl.width !== targetW)  bgmMeterEl.width  = targetW;
  if (bgmMeterEl.height !== targetH) bgmMeterEl.height = targetH;
  const ctx2d = bgmMeterEl.getContext('2d');
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;
  ctx2d.clearRect(0, 0, W, H);

  _bgmEnsureBarArrays(_bgmTargetBarCount(W));
  const N = _bgmBarCount;

  const buf = new Uint8Array(_bgmAnalyser.frequencyBinCount);
  _bgmAnalyser.getByteFrequencyData(buf);
  const binsPerBar = buf.length / N;
  for (let i = 0; i < N; i++) {
    const lo = Math.floor(i * binsPerBar);
    const hi = Math.max(lo + 1, Math.floor((i + 1) * binsPerBar));
    let v = 0;
    for (let j = lo; j < hi; j++) v = Math.max(v, buf[j] || 0);
    const target = (v / 255) * 100;
    _bgmDisplayed[i] = target > _bgmDisplayed[i] ? target : _bgmDisplayed[i] * 0.92;
    if (target >= _bgmPeaks[i]) { _bgmPeaks[i] = target; _bgmPeakHold[i] = 28; }
    else if (_bgmPeakHold[i] > 0) { _bgmPeakHold[i]--; }
    else { _bgmPeaks[i] = Math.max(0, _bgmPeaks[i] - 1.4); }
  }

  // Matte — flat axis-framed line chart, matching the other graphs.
  if ((document.documentElement.getAttribute('data-theme') || '').startsWith('matte')
      && typeof window.drawEinkChartFrame === 'function') {
    const { brightOut } = _bgmResolveColors();
    const [er, eg, eb] = brightOut;
    const frame = window.drawEinkChartFrame(ctx2d, W, H, brightOut, [
      { frac: 0, text: '0' }, { frac: 0.5, text: '50' }, { frac: 1, text: '100' },
    ]);
    const baseY = frame.py + frame.ph;
    const xOf = (i) => frame.px + (N > 1 ? (i / (N - 1)) * frame.pw : 0);
    const yOf = (i) => {
      const dist  = N > 1 ? Math.abs(i / (N - 1) - 0.5) * 2 : 0;
      const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
      const vv    = Math.min(1, (_bgmDisplayed[i] / 100) * scale);
      return frame.py + frame.ph * (1 - vv);
    };
    ctx2d.beginPath();
    ctx2d.moveTo(xOf(0), baseY);
    for (let i = 0; i < N; i++) ctx2d.lineTo(xOf(i), yOf(i));
    ctx2d.lineTo(xOf(N - 1), baseY);
    ctx2d.closePath();
    ctx2d.fillStyle = `rgba(${er},${eg},${eb},0.13)`;
    ctx2d.fill();
    ctx2d.beginPath();
    for (let i = 0; i < N; i++) {
      const x = xOf(i); const y = yOf(i);
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.strokeStyle = `rgb(${er},${eg},${eb})`;
    ctx2d.lineWidth = 1.25;
    ctx2d.lineJoin = 'round';
    ctx2d.lineCap = 'round';
    ctx2d.stroke();
    if (window._bgmState.playing && window._isMusicTabVisible) {
      _bgmMeterRaf = requestAnimationFrame(_bgmDrawMeter);
    } else { _bgmMeterRaf = 0; }
    return;
  }

  // Segmented EQ bars — split palette: OUT colour left, IN colour right.
  const { brightOut, dimOut, brightIn, dimIn, redStr } = _bgmResolveColors();
  const gap = 1;
  const barW = Math.max(1, (W - gap * (N - 1)) / N);
  const baselineY = H * 0.78;
  const usableH = baselineY;
  const reflectH = H - baselineY;
  const segments = Math.max(6, Math.min(30, Math.floor(usableH / 4)));
  const segPitch = usableH / segments;
  const cellH = Math.max(1, segPitch * 0.55);
  const cellGapY = segPitch - cellH;
  const reflectSegMax = Math.max(1, Math.floor(reflectH / segPitch));
  const colorsOut = new Array(segments);
  const colorsIn  = new Array(segments);
  for (let s = 0; s < segments; s++) {
    const t = s / Math.max(1, segments - 1);
    colorsOut[s] = `rgb(${Math.round(dimOut[0]*(1-t)+brightOut[0]*t)},${Math.round(dimOut[1]*(1-t)+brightOut[1]*t)},${Math.round(dimOut[2]*(1-t)+brightOut[2]*t)})`;
    colorsIn[s]  = `rgb(${Math.round(dimIn[0]*(1-t)+brightIn[0]*t)},${Math.round(dimIn[1]*(1-t)+brightIn[1]*t)},${Math.round(dimIn[2]*(1-t)+brightIn[2]*t)})`;
  }
  const halfN = N / 2;
  for (let i = 0; i < N; i++) {
    const dist = N > 1 ? Math.abs(i / (N - 1) - 0.5) * 2 : 0;
    const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
    const value = (_bgmDisplayed[i] / 100) * scale;
    const cellsLit = Math.min(segments, Math.ceil(value * segments));
    const x = i * (barW + gap);
    const palette = (i < halfN) ? colorsOut : colorsIn;
    for (let s = 0; s < cellsLit; s++) {
      ctx2d.fillStyle = palette[s];
      ctx2d.fillRect(x, baselineY - (s + 1) * segPitch + cellGapY, barW, cellH);
    }
    const reflectN = Math.min(cellsLit, reflectSegMax);
    if (reflectN > 0) {
      ctx2d.globalAlpha = 0.22;
      for (let s = 0; s < reflectN; s++) {
        ctx2d.fillStyle = palette[s];
        ctx2d.fillRect(x, baselineY + s * segPitch, barW, cellH);
      }
      ctx2d.globalAlpha = 1;
    }
  }
  ctx2d.fillStyle = redStr;
  for (let i = 0; i < N; i++) {
    const dist = N > 1 ? Math.abs(i / (N - 1) - 0.5) * 2 : 0;
    const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
    const peakSeg = Math.min(segments, Math.ceil(((_bgmPeaks[i] / 100) * scale) * segments));
    if (peakSeg <= 0) continue;
    ctx2d.fillRect(i * (barW + gap), baselineY - peakSeg * segPitch + cellGapY, barW, cellH);
  }
  if (window._bgmState.playing && window._isMusicTabVisible) {
    _bgmMeterRaf = requestAnimationFrame(_bgmDrawMeter);
  } else { _bgmMeterRaf = 0; }
}
// Restart the meter rAF — called by setComboMode when the user returns
// to the music tab while playback is active.
window._bgmMaybeStartMeter = function () {
  if (!_bgmMeterRaf && window._bgmState.playing && window._isMusicTabVisible) {
    _bgmMeterRaf = requestAnimationFrame(_bgmDrawMeter);
  }
};

// Lets the EXPLORE pane hand a music-folder file straight to the player.
window._musicPlayExternal = function (rel) {
  if (!rel) return;
  const idx = library.findIndex((t) => t.rel === rel);
  if (idx >= 0) playQueue(library.map((t) => t.rel), idx);
  else playQueue([rel], 0);              // not scanned yet — play standalone
};

// ── Module lifecycle ────────────────────────────────────────────────
export async function init(deps) {
  if (_ready) return;
  _ready = true;
  _deps = deps || {};

  bgmNowEl     = document.getElementById('bgm-now');
  bgmListEl    = document.getElementById('bgm-list');
  bgmMeterEl   = document.getElementById('bgm-meter');
  bgmVolEl     = document.getElementById('bgm-volume');
  bgmVolValEl  = document.getElementById('bgm-volume-val');
  bgmPlayBtn   = document.getElementById('bgm-play-btn');
  bgmPlayIcon  = bgmPlayBtn?.querySelector('.bgm-play-icon');
  bgmPauseIcon = bgmPlayBtn?.querySelector('.bgm-pause-icon');

  await loadConfig();

  // Transport.
  bgmPlayBtn?.addEventListener('click', () => { _deps?.playSfx?.('click'); togglePlay(); });
  document.getElementById('bgm-stop-btn')?.addEventListener('click', () => { _deps?.playSfx?.('click'); stopPlayback(); });
  document.getElementById('bgm-prev-btn')?.addEventListener('click', () => { _deps?.playSfx?.('click'); playRelativeInQueue(-1, true); });
  document.getElementById('bgm-next-btn')?.addEventListener('click', () => { _deps?.playSfx?.('click'); playRelativeInQueue(+1, true); });

  // Volume.
  bgmVolEl?.addEventListener('input', () => setVolume((parseInt(bgmVolEl.value, 10) || 0) / 100));
  document.getElementById('bgm-vol-down')?.addEventListener('click', () => setVolume(window._bgmState.volume - 0.05));
  document.getElementById('bgm-vol-up')?.addEventListener('click',   () => setVolume(window._bgmState.volume + 0.05));

  // View tabs.
  document.getElementById('bgm-view-library')?.addEventListener('click', () => {
    view = 'library'; _creatingPlaylist = false; _renamingId = null; renderList();
  });
  document.getElementById('bgm-view-playlists')?.addEventListener('click', () => {
    view = 'playlists'; _creatingPlaylist = false; _renamingId = null; renderList();
  });

  // Library actions.
  document.getElementById('bgm-refresh-btn')?.addEventListener('click', async () => {
    _deps?.playSfx?.('click');
    await scanLibrary();
    renderList();
  });
  document.getElementById('bgm-browse-btn')?.addEventListener('click', () => {
    _deps?.playSfx?.('click');
    // Open the EXPLORE pane — its Audio section browses the same folder.
    document.querySelector('.combo-mode-tab[data-mode="explore"]')?.click();
  });

  // List interaction (event-delegated).
  bgmListEl?.addEventListener('click', onListClick);
  bgmListEl?.addEventListener('keydown', onListKeydown);

  // Trim modal — resolve refs + wire once. Absent markup → feature off.
  const trimRoot = document.getElementById('bgm-trim');
  if (trimRoot) {
    _trimEls = {
      root:    trimRoot,
      name:    document.getElementById('bgm-trim-name'),
      bar:     document.getElementById('bgm-trim-bar'),
      seek:    document.getElementById('bgm-trim-seek'),
      pos:     document.getElementById('bgm-trim-pos'),
      dur:     document.getElementById('bgm-trim-dur'),
      play:    document.getElementById('bgm-trim-play'),
      preview: document.getElementById('bgm-trim-preview'),
      setIn:   document.getElementById('bgm-trim-set-in'),
      setOut:  document.getElementById('bgm-trim-set-out'),
      in:      document.getElementById('bgm-trim-in'),
      out:     document.getElementById('bgm-trim-out'),
      newlen:  document.getElementById('bgm-trim-newlen'),
      status:  document.getElementById('bgm-trim-status'),
      cancel:  document.getElementById('bgm-trim-cancel'),
      save:    document.getElementById('bgm-trim-save'),
    };
    _wireTrim();
  }

  setVolume(window._bgmState.volume);
  syncTransport();
  updateNow();
  await scanLibrary();
  renderList();
  // Cross-room sync: EXPLORE mutates a music file → re-scan so the
  // library list mirrors disk. Coalesced via rAF so a burst of moves
  // only triggers one IPC roundtrip.
  let _musicRescanQueued = false;
  window.addEventListener('dash:files-changed', (ev) => {
    const which = ev?.detail?.which;
    if (which && which !== 'music') return;
    if (_musicRescanQueued) return;
    _musicRescanQueued = true;
    requestAnimationFrame(async () => {
      _musicRescanQueued = false;
      try { await scanLibrary(); renderList(); } catch {}
    });
  });
}

export async function activate() {
  if (!_ready) return;
  // Rescan so files dropped into the folder since last visit show up.
  await scanLibrary();
  renderList();
  window._bgmMaybeStartMeter?.();
}

export function deactivate() {
  // Music keeps playing in the background; just stop the meter rAF.
  if (_bgmMeterRaf) { cancelAnimationFrame(_bgmMeterRaf); _bgmMeterRaf = 0; }
}
