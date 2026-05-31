// REC ROOM · recording quality profiles
//
// Owns the resolution + bitrate + fps state that the screen recorder
// consumes when it spawns ffmpeg. The screen recorder reads these via
// the getters returned from setupProfiles(); everything else (DOM
// wiring, click handlers, config persistence) is internal here.
//
// Profile shape: { key, label, resolution: 'source'|number, bitsPerSec }
// `resolution` is the target *height* in pixels — 'source' keeps the
// native size and skips the canvas downscale step in the recorder.

const REC_PROFILES = {
  lite:  { key: 'lite',  label: 'LITE',  resolution: 720,      bitsPerSec:  2_000_000, hint: '720p · 2 Mbps' },
  med:   { key: 'med',   label: 'MED',   resolution: 'source', bitsPerSec:  5_000_000, hint: 'Source · 5 Mbps' },
  large: { key: 'large', label: 'LARGE', resolution: 'source', bitsPerSec: 20_000_000, hint: 'Source · 20 Mbps · near-lossless' },
};
const REC_FPS_OPTIONS = [24, 30, 60];

export function setupProfiles({ playSfx } = {}) {
  let _recProfile = { ...REC_PROFILES.med };
  let _recFps = 30;
  // CUSTOM-tier inputs live in the mixer foot; their values feed into
  // the CUSTOM button's effective bitrate/fps.
  let _customMbps = 20;
  let _customFps  = 48;

  const qualityBtnsEl        = document.getElementById('visualizer-quality-buttons');
  const fpsBtnsEl            = document.getElementById('visualizer-fps-buttons');
  const qualityCustomInputEl = document.getElementById('visualizer-quality-custom-input');
  const fpsCustomInputEl     = document.getElementById('visualizer-fps-custom-input');

  function _paintQualityButtons() {
    if (qualityBtnsEl) {
      for (const b of qualityBtnsEl.querySelectorAll('[data-profile]')) {
        b.classList.toggle('is-active', b.dataset.profile === _recProfile.key);
      }
    }
    if (fpsBtnsEl) {
      for (const b of fpsBtnsEl.querySelectorAll('[data-fps]')) {
        const isCustomBtn = b.dataset.fps === 'custom';
        const isCustomFps = !REC_FPS_OPTIONS.includes(_recFps);
        if (isCustomBtn) b.classList.toggle('is-active', isCustomFps);
        else b.classList.toggle('is-active', Number(b.dataset.fps) === _recFps);
      }
    }
    // Inputs are only "live" when their row's CUSTOM button is the
    // active selection — otherwise gray them so the user knows preset wins.
    if (qualityCustomInputEl) {
      qualityCustomInputEl.classList.toggle('is-active', _recProfile.key === 'custom');
    }
    if (fpsCustomInputEl) {
      fpsCustomInputEl.classList.toggle('is-active', !REC_FPS_OPTIONS.includes(_recFps));
    }
  }

  function _applyProfile(key) {
    if (key === 'custom') {
      const mbps = Math.max(1, Math.min(200, Number(_customMbps) || 20));
      _recProfile = {
        key: 'custom',
        label: 'CUSTOM',
        resolution: 'source',
        bitsPerSec: mbps * 1_000_000,
        hint: `Source · ${mbps} Mbps · CUSTOM`,
      };
      _paintQualityButtons();
      try { window.dash?.setConfig?.({ recQuality: 'custom', recQualityCustomMbps: mbps }); } catch {}
      return;
    }
    const p = REC_PROFILES[key];
    if (!p) return;
    _recProfile = { ...p };
    _paintQualityButtons();
    try { window.dash?.setConfig?.({ recQuality: key }); } catch {}
  }

  function _applyFps(n) {
    // Any positive integer is allowed via the CUSTOM input; the three
    // preset buttons just write 24/30/60 here for parity.
    const fps = Math.max(1, Math.min(240, Number(n) || 30));
    _recFps = fps;
    _paintQualityButtons();
    const persistKey = REC_FPS_OPTIONS.includes(fps)
      ? { recFps: fps }
      : { recFps: fps, recFpsCustom: fps };
    try { window.dash?.setConfig?.(persistKey); } catch {}
  }

  qualityBtnsEl?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-profile]');
    if (!b) return;
    _applyProfile(b.dataset.profile);
    playSfx?.('confirm');
  });
  fpsBtnsEl?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fps]');
    if (!b) return;
    if (b.dataset.fps === 'custom') _applyFps(_customFps);
    else _applyFps(Number(b.dataset.fps));
    playSfx?.('confirm');
  });
  qualityCustomInputEl?.addEventListener('input', () => {
    const v = Math.max(1, Math.min(200, Number(qualityCustomInputEl.value) || 1));
    _customMbps = v;
    _applyProfile('custom');
  });
  fpsCustomInputEl?.addEventListener('input', () => {
    const v = Math.max(1, Math.min(240, Number(fpsCustomInputEl.value) || 1));
    _customFps = v;
    _applyFps(v);
  });

  // Restore previous selection on load. Accepts both the new shape
  // (recQuality: string) and the pre-rework shape (recQuality: { key }).
  // The retired "max" key promotes to "large" (the new uncompressed slot).
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    let key = typeof cfg.recQuality === 'string' ? cfg.recQuality : cfg.recQuality?.key;
    if (key === 'max') key = 'large';
    const savedMbps = Number(cfg.recQualityCustomMbps);
    if (Number.isFinite(savedMbps) && savedMbps > 0) {
      _customMbps = Math.max(1, Math.min(200, Math.round(savedMbps)));
      if (qualityCustomInputEl) qualityCustomInputEl.value = String(_customMbps);
    }
    if (key === 'custom') _applyProfile('custom');
    else if (key && REC_PROFILES[key]) _applyProfile(key);
    const cfgFps = Number(cfg.recFps);
    if (Number.isFinite(cfgFps) && cfgFps > 0) _applyFps(cfgFps);
    const savedCustFps = Number(cfg.recFpsCustom);
    if (Number.isFinite(savedCustFps) && savedCustFps > 0) {
      _customFps = Math.max(1, Math.min(240, Math.round(savedCustFps)));
      if (fpsCustomInputEl) fpsCustomInputEl.value = String(_customFps);
    }
    _paintQualityButtons();
  })();

  return {
    getProfile: () => _recProfile,
    getFps:     () => _recFps,
  };
}
