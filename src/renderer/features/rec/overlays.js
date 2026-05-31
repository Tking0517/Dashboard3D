// REC ROOM · keys + OSD overlays
//
// Both are recording-only — painted into the recording canvas, never
// drawn on the user's screen. The screen recorder calls drawKeys() /
// drawOsd() inside its frame loop, and isKeysOn() / isOsdAnyOn() to
// decide whether to take the no-canvas fast path. trackFps() is called
// once per recorded frame so the FPS OSD chip has fresh data.
//
// Internals (key listener subscription, OSD picker UI, config
// persistence, accent-colour cache) stay encapsulated in here.

const KEY_OVERLAY_FADE_MS = 3000;
const KEY_OVERLAY_MAX     = 12;

export function setupOverlays({ playSfx } = {}) {
  // ── KEYS overlay ───────────────────────────────────────────────
  const keysBtn = document.getElementById('visualizer-keys-btn');
  let _keysOverlayOn = false;
  let _keyEvents = []; // { key, ts (perf.now ms) }
  let _keyUnsub = null;

  function _onKeyEvent(ev) {
    if (!ev || !ev.name) return;
    _keyEvents.push({ key: ev.name, ts: performance.now() });
    if (_keyEvents.length > KEY_OVERLAY_MAX * 2) {
      _keyEvents = _keyEvents.slice(-KEY_OVERLAY_MAX * 2);
    }
  }

  // Cached parsed accent color, refreshed on theme changes. Reading
  // getComputedStyle every frame works but is wasteful.
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
  new MutationObserver(() => { _accentRGB = null; })
    .observe(document.documentElement, { attributes: true });

  // Paint the keys overlay onto the recording canvas. Right-aligned
  // column near the bottom-right, newest on top, fading by age.
  function drawKeys(ctx, w, h) {
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
    // Toggle: now-on → 'click' (light up), now-off → 'close' (dismiss).
    playSfx?.(_keysOverlayOn ? 'click' : 'close');
  });

  // ── OSD overlay (TIME / DATE / FPS) ───────────────────────────
  const osdBtn      = document.getElementById('visualizer-osd-btn');
  const osdPickerEl = document.getElementById('visualizer-osd-picker');
  const osdCloseBtn = document.getElementById('visualizer-osd-close');
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
  // computes frames-per-second over the most recent ~1 s window.
  const _fpsTimes = [];
  let _fpsValue = 0;
  function trackFps() {
    const now = performance.now();
    _fpsTimes.push(now);
    while (_fpsTimes.length && now - _fpsTimes[0] > 1000) _fpsTimes.shift();
    _fpsValue = _fpsTimes.length;
  }

  function drawOsd(ctx, w, h) {
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
    // Toggle: now-on → 'click' (light up), now-off → 'close' (dismiss).
    playSfx?.(_osdState[k] ? 'click' : 'close');
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

  return {
    isKeysOn:   () => _keysOverlayOn,
    isOsdAnyOn: () => _osdAnyOn(),
    drawKeys,
    drawOsd,
    trackFps,
  };
}
