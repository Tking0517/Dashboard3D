// REC ROOM · input-driven JPEG capture (SNAP button)
//
// Renderer owns frame encoding; main owns the powerMonitor poll and
// the file write. We only fire if there's *something* to capture (a
// live mirror or a video file loaded in the rec-room player) and
// throttle to >= 1 s between saves so continuous typing doesn't flood
// the gallery folder.
//
// Surface:
//   setupScreencap({ playSfx, visualizerVideoEl, screencapBtn, getMirror })
// where getMirror is a () => ({ stream, override }) accessor returning
// the visualizer's current mirror state — needed so we don't drift out
// of sync with visualizer.js's _mirrorStream and _mirrorSourceOverride.

export function setupScreencap({ playSfx, visualizerVideoEl, screencapBtn, getMirror } = {}) {
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

  async function _maybeCapture() {
    if (!_screencapOn) return;
    // Need *something* to capture from — either an active live mirror
    // or a video file currently loaded in the rec-room player. Without
    // either, the canvas draw produces a black frame.
    const m = getMirror?.() || {};
    const hasVideoContent = (visualizerVideoEl && visualizerVideoEl.videoWidth > 0 && visualizerVideoEl.videoHeight > 0);
    if (!m.stream && !hasVideoContent) return;
    const now = Date.now();
    if (now - _screencapLastAt < 1000) return; // throttle 1/sec
    const dataUrl = _screencapEncode();
    if (!dataUrl) return;
    _screencapLastAt = now;
    try { await window.dash?.screencapSave?.(dataUrl, { sourceName: m.override?.name || '' }); } catch {}
    // Flash the button briefly so the user sees activity.
    if (screencapBtn) {
      screencapBtn.classList.add('is-flashing');
      setTimeout(() => screencapBtn.classList.remove('is-flashing'), 220);
    }
  }

  async function start() {
    if (_screencapOn) return;
    _screencapOn = true;
    _screencapLastAt = 0;
    screencapBtn?.classList.add('is-active');
    if (screencapBtn) screencapBtn.textContent = 'REC ON';
    _screencapTriggerUnsub = window.dash?.onScreencapTrigger?.(_maybeCapture) || null;
    // Pass the captured source's id so main can gate triggers by the
    // OS foreground window. Without this, every key/click anywhere on
    // the system snaps a frame — including activity in other apps.
    const m = getMirror?.() || {};
    try {
      await window.dash?.screencapWatchStart?.({
        sourceId: m.override?.id || '',
      });
    } catch {}
  }

  async function stop() {
    if (!_screencapOn) return;
    _screencapOn = false;
    screencapBtn?.classList.remove('is-active');
    if (screencapBtn) screencapBtn.textContent = 'RECORD';
    if (_screencapTriggerUnsub) { try { _screencapTriggerUnsub(); } catch {} _screencapTriggerUnsub = null; }
    try { await window.dash?.screencapWatchStop?.(); } catch {}
  }

  screencapBtn?.addEventListener('click', () => {
    // Toggle: was-on → turn off → 'close'; was-off → turn on → 'click'.
    if (_screencapOn) { stop();  playSfx?.('close'); }
    else              { start(); playSfx?.('click'); }
  });

  return { start, stop, isOn: () => _screencapOn };
}
