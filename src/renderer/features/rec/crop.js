// REC ROOM · free-capture crop region
//
// Draggable + resizable rectangle inside the player wrap. When active,
// the screen recorder crops the recording to its bounds. The rect is
// stored as 0..1 fractions of the wrap so it stays valid across
// resizes; persisted under config.cropRect.
//
// Surface:
//   setupCrop({ playSfx, visualizerWrapEl, refreshWrapShape }) → {
//     getActive(),
//     getRect(),
//     deactivate(),  // for the playback handler when starting a recorded file
//   }
// refreshWrapShape is called whenever the wrap may need to re-measure
// — currently a no-op delta but kept as a hook in case crop ever
// reshapes the wrap again.

const MIN_CROP_FRAC = 0.05;

export function setupCrop({ playSfx, visualizerWrapEl, refreshWrapShape } = {}) {
  const cropBtn     = document.getElementById('visualizer-crop-btn');
  const cropOverlay = document.getElementById('visualizer-crop');
  const cropRectEl  = document.getElementById('visualizer-crop-rect');

  let _cropActive = false;
  let _cropRect = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };

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
  function _refreshCropView() {
    if (cropOverlay) cropOverlay.hidden = !_cropActive;
    try { refreshWrapShape?.(); } catch {}
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
    _refreshCropView();
    // Toggle: now-active → 'click' (light up), now-inactive → 'close' (dismiss).
    playSfx?.(_cropActive ? 'click' : 'close');
  });

  // Restore crop rect on load. Overlay stays hidden until CROP is
  // toggled — we just preload the rect so the previous shape returns.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    if (cfg.cropRect && typeof cfg.cropRect.w === 'number' && typeof cfg.cropRect.h === 'number') {
      _cropRect = _clampCropRect(cfg.cropRect);
    }
    _paintCropRect();
  })();

  return {
    getActive: () => _cropActive,
    getRect:   () => _cropRect,
    deactivate() {
      if (!_cropActive) return;
      _cropActive = false;
      if (cropBtn) {
        cropBtn.classList.remove('is-active');
        cropBtn.textContent = 'CROP';
      }
      _refreshCropView();
    },
  };
}
