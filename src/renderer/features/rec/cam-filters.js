// REC ROOM · CAM filters
//
// CSS-style filter chain + an SVG gamma curve, both applied to the
// canvas the multi-cam composite draws into. State is persisted under
// config.recRoomCamFilters so the look survives restarts.
//
// Surface:
//   setupCamFilters({ playSfx }) → { getFilterString }
//
// getFilterString() returns a string usable with canvas2d `ctx.filter`
// (e.g. "brightness(110%) contrast(95%) url(#cam-gamma-filter)"), or
// "none" when every slider is at its identity value.

export function setupCamFilters({ playSfx } = {}) {
  const _camFilters = {
    bw: false,
    brightness: 100,
    contrast: 100,
    saturate: 100,
    hue: 0,
    gamma: 1.00,
    blur: 0,       // px; 0 = off
    sharpen: 0,    // 0..200 (% of strong-sharpen kernel)
  };
  // LUT selection — { name, path } when active, null when off. The
  // composite draw loop reads this via getLut(); it returns null while
  // _lutBypassed is true so the LUT button A/B toggle works without
  // losing the user's chosen entry.
  let _activeLut = null;
  let _lutAmount = 100;        // 0..100 blend strength
  let _lutBypassed = false;    // LUT header button toggles this
  let _lutEntries = [];        // loaded from main on init: [{ name, path, rel }]

  function buildFilterString() {
    const parts = [];
    if (_camFilters.bw) {
      parts.push('saturate(0)');
    } else if (_camFilters.saturate !== 100) {
      parts.push(`saturate(${_camFilters.saturate}%)`);
    }
    if (_camFilters.brightness !== 100) parts.push(`brightness(${_camFilters.brightness}%)`);
    if (_camFilters.contrast   !== 100) parts.push(`contrast(${_camFilters.contrast}%)`);
    if (_camFilters.hue        !== 0)   parts.push(`hue-rotate(${_camFilters.hue}deg)`);
    if (_camFilters.blur       > 0)     parts.push(`blur(${_camFilters.blur}px)`);
    // Gamma + sharpen use registered SVG filters — canvas.ctx.filter
    // accepts `url(#id)` references. We skip the references at their
    // identity values to save the (real) per-frame composite cost.
    if (_camFilters.gamma !== 1.00) parts.push('url(#cam-gamma-filter)');
    if (_camFilters.sharpen > 0)    parts.push('url(#cam-sharpen-filter)');
    return parts.length ? parts.join(' ') : 'none';
  }

  // Push the GAMMA exponent into the SVG filter's three feFunc nodes.
  // Same exponent for R/G/B = grayscale gamma curve.
  const _gammaNode = document.getElementById('cam-gamma-node');
  function _applyGammaToSvg() {
    if (!_gammaNode) return;
    const exp = String(1 / Math.max(0.01, _camFilters.gamma)); // invert so 1.5 = brighter mids
    const funcs = _gammaNode.querySelectorAll('feFuncR, feFuncG, feFuncB');
    for (const f of funcs) f.setAttribute('exponent', exp);
  }

  // SHARPEN — push a 3×3 convolve kernel into the SVG filter.
  // Strength S scales the corner-cross + center weight:
  //   [0  -S  0]
  //   [-S 1+4S -S]
  //   [0  -S  0]
  // 0 = identity. 1.0 ≈ standard sharpen. >1 amplifies edges.
  const _sharpenNode = document.getElementById('cam-sharpen-node');
  function _applySharpenToSvg() {
    if (!_sharpenNode) return;
    const s = Math.max(0, _camFilters.sharpen / 100); // 0..2 from slider 0..200
    const center = (1 + 4 * s).toFixed(3);
    const edge   = (-s).toFixed(3);
    const km = `0 ${edge} 0  ${edge} ${center} ${edge}  0 ${edge} 0`;
    _sharpenNode.setAttribute('kernelMatrix', km);
  }

  const camBwBtn      = document.getElementById('vis-cam-bw');
  const camLutBtn     = document.getElementById('vis-cam-lut');
  const camResetBtn   = document.getElementById('vis-cam-filters-reset');
  const camBrightEl   = document.getElementById('vis-cam-brightness');
  const camContrastEl = document.getElementById('vis-cam-contrast');
  const camSatEl      = document.getElementById('vis-cam-saturate');
  const camHueEl      = document.getElementById('vis-cam-hue');
  const camGammaEl    = document.getElementById('vis-cam-gamma');
  const camBlurEl     = document.getElementById('vis-cam-blur');
  const camSharpenEl  = document.getElementById('vis-cam-sharpen');
  const camFiltersEl  = document.getElementById('visualizer-cam-filters');
  // LUT controls — name pill (mousewheel cycles entries) + AMOUNT slider
  // that now lives inside the main slider grid (under GAMMA in column 2).
  const lutNameEl      = document.getElementById('vis-cam-lut-name');
  const lutAmountEl    = document.getElementById('vis-cam-lut-amount');

  function _paintReadouts() {
    if (!camFiltersEl) return;
    const setVal = (key, txt) => {
      const el = camFiltersEl.querySelector(`.visualizer-cam-filter-val[data-for="${key}"]`);
      if (el) el.textContent = txt;
    };
    setVal('brightness', `${_camFilters.brightness}%`);
    setVal('contrast',   `${_camFilters.contrast}%`);
    setVal('saturate',   _camFilters.bw ? 'B&W' : `${_camFilters.saturate}%`);
    setVal('hue',        `${_camFilters.hue >= 0 ? '+' : ''}${_camFilters.hue}°`);
    setVal('gamma',      _camFilters.gamma.toFixed(2));
    setVal('blur',       `${_camFilters.blur.toFixed(1)} px`);
    setVal('sharpen',    `${_camFilters.sharpen}%`);
    setVal('lut-amount', `${_lutAmount}%`);
    if (lutNameEl) {
      lutNameEl.textContent = _activeLut?.name
        || (_lutEntries.length ? '— OFF —' : 'NO LUTS');
      lutNameEl.classList.toggle('is-bypassed', _lutBypassed || !_activeLut);
      lutNameEl.title = _activeLut
        ? `Active: ${_activeLut.name} — scroll to cycle, click to advance`
        : 'Scroll to pick a LUT';
    }
    camBwBtn?.classList.toggle('is-active', _camFilters.bw);
    camLutBtn?.classList.toggle('is-active', !!_activeLut && !_lutBypassed);
  }
  function _persist() {
    try {
      window.dash?.setConfig?.({
        recRoomCamFilters: { ..._camFilters },
        recRoomCamLut: _activeLut ? { name: _activeLut.name, path: _activeLut.path } : null,
        recRoomCamLutAmount: _lutAmount,
        recRoomCamLutBypass: _lutBypassed,
      });
    } catch {}
  }

  camBwBtn?.addEventListener('click', () => {
    _camFilters.bw = !_camFilters.bw;
    _paintReadouts();
    _persist();
    playSfx?.('click');
  });
  camResetBtn?.addEventListener('click', () => {
    _camFilters.bw = false;
    _camFilters.brightness = 100;
    _camFilters.contrast   = 100;
    _camFilters.saturate   = 100;
    _camFilters.hue        = 0;
    _camFilters.gamma      = 1.00;
    _camFilters.blur       = 0;
    _camFilters.sharpen    = 0;
    if (camBrightEl)   camBrightEl.value   = '100';
    if (camContrastEl) camContrastEl.value = '100';
    if (camSatEl)      camSatEl.value      = '100';
    if (camHueEl)      camHueEl.value      = '0';
    if (camGammaEl)    camGammaEl.value    = '100';
    if (camBlurEl)     camBlurEl.value     = '0';
    if (camSharpenEl)  camSharpenEl.value  = '0';
    _applyGammaToSvg();
    _applySharpenToSvg();
    _paintReadouts();
    _persist();
    playSfx?.('confirm');
  });
  camBrightEl?.addEventListener('input', () => {
    _camFilters.brightness = Number(camBrightEl.value) || 100;
    _paintReadouts();
    _persist();
  });
  camContrastEl?.addEventListener('input', () => {
    _camFilters.contrast = Number(camContrastEl.value) || 100;
    _paintReadouts();
    _persist();
  });
  camSatEl?.addEventListener('input', () => {
    _camFilters.saturate = Number(camSatEl.value) || 100;
    // Typing on the saturation slider implicitly disables B&W so the
    // user doesn't fight a hidden override.
    if (_camFilters.bw) _camFilters.bw = false;
    _paintReadouts();
    _persist();
  });
  camHueEl?.addEventListener('input', () => {
    _camFilters.hue = Number(camHueEl.value) || 0;
    _paintReadouts();
    _persist();
  });
  camGammaEl?.addEventListener('input', () => {
    // Slider stores gamma * 100 so it can be an integer; convert back.
    _camFilters.gamma = (Number(camGammaEl.value) || 100) / 100;
    _applyGammaToSvg();
    _paintReadouts();
    _persist();
  });
  camBlurEl?.addEventListener('input', () => {
    _camFilters.blur = Math.max(0, Number(camBlurEl.value) || 0);
    _paintReadouts();
    _persist();
  });
  camSharpenEl?.addEventListener('input', () => {
    _camFilters.sharpen = Math.max(0, Number(camSharpenEl.value) || 0);
    _applySharpenToSvg();
    _paintReadouts();
    _persist();
  });

  // ── LUT scroll-wheel selector ─────────────────────────────────
  // The wheel cycles a virtual list [null, ...entries] where null
  // represents OFF. wheel-up moves to the previous entry, wheel-down
  // to the next, both wrapping. Clicking is equivalent to wheel-down
  // for trackpad users without a discrete wheel.
  function _lutCycle(dir) {
    if (!_lutEntries.length) return;
    const all = [null, ..._lutEntries];
    const idx = _activeLut
      ? all.findIndex((e) => e && e.path === _activeLut.path)
      : 0;
    const safeIdx = idx < 0 ? 0 : idx;
    const next = all[(safeIdx + dir + all.length) % all.length];
    _activeLut = next
      ? { name: next.name, path: next.path, rel: next.rel }
      : null;
    _paintReadouts();
    _persist();
    playSfx?.('click');
  }
  lutNameEl?.addEventListener('wheel', (ev) => {
    // Prevent the scroll from bubbling up to a parent scroller (e.g.
    // the cam strip). passive:false is set via the listener form below
    // because preventDefault() inside a passive wheel listener is a
    // no-op in modern Chromium.
    ev.preventDefault();
    _lutCycle(ev.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  lutNameEl?.addEventListener('click', () => _lutCycle(1));
  // LUT header button — toggles bypass. Selection is preserved so
  // A/B comparison is one click each way.
  camLutBtn?.addEventListener('click', () => {
    _lutBypassed = !_lutBypassed;
    _paintReadouts();
    _persist();
    playSfx?.('click');
  });
  lutAmountEl?.addEventListener('input', () => {
    _lutAmount = Math.max(0, Math.min(100, Number(lutAmountEl.value) || 0));
    _paintReadouts();
    _persist();
  });

  // Restore on load.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    const saved = cfg.recRoomCamFilters;
    if (saved && typeof saved === 'object') {
      _camFilters.bw         = !!saved.bw;
      _camFilters.brightness = Number(saved.brightness) || 100;
      _camFilters.contrast   = Number(saved.contrast)   || 100;
      _camFilters.saturate   = Number(saved.saturate)   || 100;
      _camFilters.hue        = Number(saved.hue)        || 0;
      _camFilters.gamma      = Number(saved.gamma)      || 1.00;
      _camFilters.blur       = Number(saved.blur)       || 0;
      _camFilters.sharpen    = Number(saved.sharpen)    || 0;
      if (camBrightEl)   camBrightEl.value   = String(_camFilters.brightness);
      if (camContrastEl) camContrastEl.value = String(_camFilters.contrast);
      if (camSatEl)      camSatEl.value      = String(_camFilters.saturate);
      if (camHueEl)      camHueEl.value      = String(_camFilters.hue);
      if (camGammaEl)    camGammaEl.value    = String(Math.round(_camFilters.gamma * 100));
      if (camBlurEl)     camBlurEl.value     = String(_camFilters.blur);
      if (camSharpenEl)  camSharpenEl.value  = String(_camFilters.sharpen);
    }
    if (Number.isFinite(Number(cfg.recRoomCamLutAmount))) {
      _lutAmount = Math.max(0, Math.min(100, Number(cfg.recRoomCamLutAmount)));
      if (lutAmountEl) lutAmountEl.value = String(_lutAmount);
    }
    if (typeof cfg.recRoomCamLutBypass === 'boolean') {
      _lutBypassed = cfg.recRoomCamLutBypass;
    }
    _applyGammaToSvg();
    _applySharpenToSvg();
    // Pull the LUT bank from main. Empty result → "NO LUTS" shows in
    // the picker pill (see _paintReadouts); errors degrade silently
    // to the same state.
    try {
      const res = await window.dash?.lutList?.();
      _lutEntries = Array.isArray(res?.entries) ? res.entries : [];
    } catch (err) {
      console.warn('[lut] lutList threw:', err?.message || err);
    }
    // Restore previous active LUT IF its path is still present.
    const savedLut = cfg.recRoomCamLut;
    if (savedLut?.path) {
      const match = _lutEntries.find((e) => e.path === savedLut.path);
      if (match) _activeLut = { name: match.name, path: match.path, rel: match.rel };
    }
    _paintReadouts();
  })();

  return {
    getFilterString: buildFilterString,
    // getLut returns null while bypassed so the composite draw loop
    // just stops applying the LUT — the user's selection is kept so
    // toggling LUT back on restores the same grade instantly.
    getLut:       () => (_lutBypassed ? null : _activeLut),
    getLutAmount: () => _lutAmount,
  };
}
