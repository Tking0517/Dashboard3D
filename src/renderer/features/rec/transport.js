// REC ROOM · transport controls + themed playback bar
//
// Owns the play/pause/prev/next buttons, the themed playback control
// bar (#visualizer-pc — scrubber, clock, volume, fullscreen), and the
// rAF-coalesced seek logic that keeps scrubbing smooth on long clips.
//
// Surface:
//   setupTransport({
//     playSfx,
//     visualizerVideoEl,
//     getPlayable,        // () => entries[] — filtered to playable videos
//     getCurrentPath,     // () => string | null
//     playEntry,          // (entry) => void — runs the visualizer's full
//                         // play handler (mirror teardown, crop reset, etc.)
//   })
//
// The module wires every transport input + every video-element event
// it needs and returns nothing — there are no remaining call sites
// outside the transport itself once it's set up.

export function setupTransport({
  playSfx,
  visualizerVideoEl,
  getPlayable,
  getCurrentPath,
  playEntry,
} = {}) {
  // ── Big transport buttons (play/pause/prev/next) ────────────────
  function togglePlayPause() {
    if (!visualizerVideoEl) return;
    if (!visualizerVideoEl.currentSrc) {
      const first = (getPlayable?.() || [])[0];
      if (first) playEntry?.(first);
      return;
    }
    if (visualizerVideoEl.paused) {
      visualizerVideoEl.play().catch((err) => {
        console.warn('[rec-room] play() rejected:', err?.name, err?.message);
      });
    } else {
      visualizerVideoEl.pause();
    }
  }
  function playRelative(step) {
    const playable = getPlayable?.() || [];
    if (!playable.length) return;
    const current = getCurrentPath?.();
    const idx = playable.findIndex((e) => e.path === current);
    let nextIdx;
    if (idx < 0) nextIdx = step > 0 ? 0 : playable.length - 1;
    else         nextIdx = (idx + step + playable.length) % playable.length;
    playEntry?.(playable[nextIdx]);
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
  document.getElementById('visualizer-playpause-btn')?.addEventListener('click', togglePlayPause);
  document.getElementById('visualizer-prev-btn')     ?.addEventListener('click', () => playRelative(-1));
  document.getElementById('visualizer-next-btn')     ?.addEventListener('click', () => playRelative(+1));
  visualizerVideoEl?.addEventListener('play',       updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('pause',      updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('emptied',    updatePlayPauseIcon);
  visualizerVideoEl?.addEventListener('loadeddata', updatePlayPauseIcon);

  // ── Themed playback control bar ────────────────────────────────
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
  //
  // The naive "currentTime = frac*dur" on every pointermove fires 60+
  // seeks/sec during a drag and stutters on long clips. Strategy here:
  //   1. UI (fill / knob / clock) tracks the cursor immediately so the
  //      drag *feels* responsive even when the decoder is catching up.
  //   2. Actual video seeks are coalesced into one per rAF (~60 Hz cap),
  //      using precise currentTime= — fastSeek() was tried but lands on
  //      the nearest keyframe, which on canvas-captureStream/MediaRecorder
  //      output with sparse keyframes can be far from where you clicked.
  //   3. On pointerup we do one final currentTime= so the user lands
  //      exactly where they let go (in case rAF coalesced their last move).
  //   4. Pause during *drag* (not a plain click) so playback isn't fighting
  //      the seek storm. A click without movement just seeks and is done.
  let _pcScrubbing = false;
  let _pcScrubMoved = false;
  let _pcScrubTargetFrac = 0;
  let _pcScrubRaf = 0;
  let _pcScrubLastSeek = -1;
  let _pcScrubStartX = 0;
  let _pcWasPlayingBeforeScrub = false;
  function _pcUpdateScrubUi(frac) {
    if (_pcFillEl) _pcFillEl.style.width = `${frac * 100}%`;
    if (_pcKnobEl) _pcKnobEl.style.left  = `${frac * 100}%`;
    if (_pcCurEl && visualizerVideoEl) {
      const dur = Number.isFinite(visualizerVideoEl.duration) ? visualizerVideoEl.duration : 0;
      _pcCurEl.textContent = _fmtClock(frac * dur);
    }
  }
  function _pcCommitScrubSeek() {
    _pcScrubRaf = 0;
    if (!_pcScrubbing || !visualizerVideoEl) return;
    const dur = visualizerVideoEl.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const t = _pcScrubTargetFrac * dur;
    // Skip near-duplicate seeks — within 50 ms of last commit they're noise.
    if (Math.abs(t - _pcScrubLastSeek) < 0.05) return;
    _pcScrubLastSeek = t;
    try { visualizerVideoEl.currentTime = t; } catch {}
  }
  function _pcSeekToEvent(ev) {
    if (!_pcSeekEl || !visualizerVideoEl) return;
    const r = _pcSeekEl.getBoundingClientRect();
    if (r.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    _pcScrubTargetFrac = frac;
    _pcUpdateScrubUi(frac);
    if (!_pcScrubRaf) _pcScrubRaf = requestAnimationFrame(_pcCommitScrubSeek);
  }
  _pcSeekEl?.addEventListener('pointerdown', (ev) => {
    _pcScrubbing = true;
    _pcScrubMoved = false;
    _pcScrubLastSeek = -1;
    _pcScrubStartX = ev.clientX;
    _pcWasPlayingBeforeScrub = !!(visualizerVideoEl && !visualizerVideoEl.paused);
    _pcSeekEl.classList.add('is-scrubbing');
    try { _pcSeekEl.setPointerCapture(ev.pointerId); } catch {}
    _pcSeekToEvent(ev);
  });
  _pcSeekEl?.addEventListener('pointermove', (ev) => {
    if (!_pcScrubbing) return;
    if (!_pcScrubMoved && Math.abs(ev.clientX - _pcScrubStartX) > 3) {
      _pcScrubMoved = true;
      if (_pcWasPlayingBeforeScrub && visualizerVideoEl) {
        try { visualizerVideoEl.pause(); } catch {}
      }
    }
    _pcSeekToEvent(ev);
  });
  const _pcEndScrub = (ev) => {
    if (!_pcScrubbing) return;
    _pcScrubbing = false;
    if (_pcScrubRaf) { cancelAnimationFrame(_pcScrubRaf); _pcScrubRaf = 0; }
    _pcSeekEl.classList.remove('is-scrubbing');
    if (visualizerVideoEl) {
      const dur = visualizerVideoEl.duration;
      if (Number.isFinite(dur) && dur > 0) {
        try { visualizerVideoEl.currentTime = _pcScrubTargetFrac * dur; } catch {}
      }
      if (_pcScrubMoved && _pcWasPlayingBeforeScrub) {
        try { visualizerVideoEl.play().catch(() => {}); } catch {}
      }
    }
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
}
