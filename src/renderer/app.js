import './styles.css';
import { initTrim } from './features/trim.js';
import { initLauncher } from './features/launcher.js';

// ── Global rAF throttle ──────────────────────────────────────────────
// Cap renderer animation callbacks at 60 Hz regardless of monitor refresh
// rate. On a 117 Hz / 144 Hz display the native rAF fires at the panel's
// rate, which doubles JS work and GC pressure for the dashboard's many
// always-on loops (audio bars, BGM meter, audio waveform, FPS counter).
// We wrap requestAnimationFrame so the callback only runs when ≥ ~16.6 ms
// have elapsed since the last invocation; in-between native ticks just
// re-queue. The native compositor still wakes at display rate, but our JS
// payload + the DOM/canvas writes it causes drop to 60 fps. cancelAnimationFrame
// stays correct via a user-id → native-id map.
(() => {
  const _nativeRAF = window.requestAnimationFrame.bind(window);
  const _nativeCAF = window.cancelAnimationFrame.bind(window);
  const TARGET_MS = 1000 / 60;
  const _pending = new Map();
  let _lastT = 0;
  let _nextId = 1;
  window.requestAnimationFrame = function (cb) {
    const userId = _nextId++;
    const tick = (t) => {
      if (!_pending.has(userId)) return; // cancelled mid-flight
      if (t - _lastT >= TARGET_MS - 0.5) {
        _pending.delete(userId);
        _lastT = t;
        cb(t);
      } else {
        _pending.set(userId, _nativeRAF(tick));
      }
    };
    _pending.set(userId, _nativeRAF(tick));
    return userId;
  };
  window.cancelAnimationFrame = function (id) {
    const nativeId = _pending.get(id);
    if (nativeId != null) { _nativeCAF(nativeId); _pending.delete(id); }
  };
})();

// Module-scope ref to the productivity panel's header repaint function.
// Assigned by the panel-combo init block; called from the boot-status
// fade-out path to restore the mode-driven subtitle/tag after the
// greeting fades.
let _paintComboHeader = null;

// Module-scope ref to the productivity panel's fold-bounds recomputer.
// Assigned by the panel-combo init block. initFromConfig calls it AFTER
// panels have been positioned, so a saved-collapsed combo lands in the
// gap between the side columns instead of using the CSS fallback (480/
// 600) which overlapped CHRONO on boot.
let _updateComboFoldBoundsRef = null;

// Boot count-up: animate a numeric textContent from 0 up to its current
// value over `durationMs`. Used during the info-trickle pass so panels'
// big numeric readouts don't just snap into existence — they cycle up to
// their target value. Skips elements whose text isn't a clean integer
// or decimal (clocks like "01:47:42", ratios like "16/128 GB",
// placeholders like "—"). Once the animation finishes, the live
// telemetry loop takes over and writes normal values.
function animateCountUp(el, targetText, durationMs) {
  const target = parseFloat(targetText);
  if (!Number.isFinite(target)) return;
  const decimals = (String(targetText).split('.')[1] || '').length;
  const fmt = (v) => decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
  const start = performance.now();
  el.textContent = fmt(0);
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);   // ease-out cubic
    el.textContent = fmt(target * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Boot static-noise overlay ────────────────────────────────────────────
// Canvas redraws horizontal stripes of variable length / opacity each
// frame in the theme accent — reads as VHS / CRT static while the boot
// flicker + SFX play. mix-blend-mode: screen on the canvas (CSS) makes
// the result composite over the dashboard, not paint over it. The tick
// loop self-terminates the next frame after `body.is-booting` drops, so
// no separate stop signal is needed — the CSS opacity transition then
// fades the canvas out smoothly.
(function setupBootBlur() {
  // Snow / TV-noise retired — boot now uses a light body-level blur
  // (styles.css `body.is-boot-glowing { filter: blur(2.5px) }`) that
  // fades off via the body's filter transition (3 s ease-out) when the
  // class is removed. is-boot-glowing is set on <body> in index.html
  // at app start, so we only need to drop it at the right moment.
  // 3 s in lines up with the panel-flicker peak; the 3-second fade
  // then carries the blur away across the brightness-ramp window.
  setTimeout(() => {
    document.body.classList.remove('is-boot-glowing');
  }, 3000);
})();
// Legacy snow canvas setup removed — boot now uses a light body-level
// blur driven by is-boot-glowing (see setupBootBlur above + styles.css
// §boot).

// ── Boot flicker ─────────────────────────────────────────────────────────
// index.html ships with `class="is-booting"` on <body>; CSS hides panels
// (visibility: hidden) and dims the topbar to ~8% brightness on the very
// first paint. We DON'T start the stagger here — if it fired before
// initFromConfig applied saved panel positions, panels would briefly
// flash at their CSS-grid positions, then snap to their final fixed
// positions, which reads as "movement". Instead, this block defines the
// stagger closure and exposes it via `_startBootFlicker()`; initFromConfig
// invokes it after positions are written. A safety timeout starts the
// flicker anyway if init never gets to that point (e.g., headless render
// with no window.dash preload).
let _startBootFlicker = () => {};
{
  // Force every panel into the collapsed (header-only) state before the
  // first paint. The flicker stagger removes `.is-collapsed` per panel
  // as that panel's flicker fires, so panels visibly "open" alongside
  // their brightness ramp. Panels that should stay collapsed (per saved
  // cfg.collapsed — notes/chat/combo, etc.) are tagged later in init
  // with `data-stay-collapsed="1"`, which the stagger respects.
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.add('is-collapsed');
  }

  // bgGrid is held separately so it always flickers on LAST — the rest
  // of the dashboard powers up first (panels, audio, topbar), and the
  // grid wallpaper is the final element to brighten, like the last bank
  // of warehouse lights catching after the foreground fixtures.
  const bgGrid = document.querySelector('.bg-grid');
  const targets = [
    ...document.querySelectorAll('.panel'),
    document.querySelector('#audio-out-grid'),
    document.querySelector('#audio-in-grid'),
    document.querySelector('.topbar-controls'),
  ].filter(Boolean);

  if (!targets.length && !bgGrid) {
    document.body.classList.remove('is-booting');
  } else {
    // Fisher–Yates so the foreground flicker doesn't read as a clean
    // left-to-right wipe. bgGrid sits outside this shuffle.
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [targets[i], targets[j]] = [targets[j], targets[i]];
    }

    const SPREAD_MS = 2400;  // total stagger window (last panel starts this far in)
    const ANIM_MS   = 1200;  // matches the duration in .is-flicker-in CSS rule

    // The three flicker variants in styles.css. Each panel picks one at
    // random so the wake-up doesn't feel mechanically uniform — some
    // panels strike once, others stutter through two or three weak
    // flicks before catching, all ending in the same gradual bulb-style
    // ramp to full brightness.
    const FLICKER_VARIANTS = ['boot-flicker-1', 'boot-flicker-2', 'boot-flicker-3'];

    let _started = false;

    _startBootFlicker = () => {
      if (_started) return;
      _started = true;

      // CRT power-on tone the moment the cascade starts.
      try { playBootSfx('boot-power'); } catch {}

      // BG-grid pattern churn during the settle: walk through all 7
      // remaining presets ONCE, with 2 random patterns getting a
      // longer "hitch" dwell (500–750 ms) and the rest flashing
      // through fast (55–110 ms). Total runtime lands in ~1.2–1.7 s
      // — done well before the dashboard finishes flickering. The
      // user's saved pattern is restored at the end of the sequence.
      // Each step is its own setTimeout so we can clear any pending
      // ones at boot-end if the user reloads mid-cycle.
      const _origBgPattern = document.body.getAttribute('data-bg-pattern') || 'grid';
      let _origBgPatternIdx = BG_PATTERNS.indexOf(_origBgPattern);
      if (_origBgPatternIdx < 0) _origBgPatternIdx = 0;
      const _bgCycleTimers = [];
      {
        const stepCount = BG_PATTERNS.length - 1;  // skip the user's current pattern
        // Pick 2 random step indices to "hitch" on. >=1 so the first
        // step isn't always a hitch (which would feel like a delay
        // before anything moves).
        const hitchSet = new Set();
        while (hitchSet.size < 2) {
          hitchSet.add(1 + Math.floor(Math.random() * (stepCount - 1)));
        }
        let elapsed = 0;
        for (let i = 0; i < stepCount; i++) {
          const idx = (_origBgPatternIdx + i + 1) % BG_PATTERNS.length;
          const dwell = hitchSet.has(i)
            ? 500 + Math.floor(Math.random() * 250)   // 500–750 ms hitch
            :  55 + Math.floor(Math.random() *  55);  // 55–110 ms flash
          const tm = setTimeout(() => {
            document.body.setAttribute('data-bg-pattern', BG_PATTERNS[idx]);
          }, elapsed);
          _bgCycleTimers.push(tm);
          elapsed += dwell;
        }
        // Final restore tick — locks back to the user's saved pattern
        // immediately after the last flash, no extra dwell at the end.
        _bgCycleTimers.push(setTimeout(() => {
          document.body.setAttribute('data-bg-pattern', _origBgPattern);
        }, elapsed));
      }

      // Each panel keeps its `.is-flicker-in` class until boot finishes —
      // the CSS keyframe's `forwards` mode holds brightness(1), so it
      // stays lit while later panels are still flickering in. Removing
      // earlier would snap the panel back to the dim base state.
      // Track the latest flicker offset (across panels AND audio grids)
      // so we know when the cascade has settled. Info-trickle waits for
      // that moment so values don't start coming in while neighbouring
      // surfaces are still flickering — see staggered trickle below.
      let _lastPanelFlickerEnd = 0;

      targets.forEach((el, i) => {
        const base = targets.length > 1 ? (i / (targets.length - 1)) * SPREAD_MS : 0;
        const jitter = (Math.random() - 0.5) * 400;
        const delay = Math.max(0, base + jitter);
        setTimeout(() => {
          const variant = FLICKER_VARIANTS[Math.floor(Math.random() * FLICKER_VARIANTS.length)];
          el.style.setProperty('--flicker-anim', variant);
          el.classList.add('is-flicker-in');
          // ~45 % of panels emit a random-pitched bit blip as they
          // flicker on — sparse enough that the cascade doesn't sound
          // like a fax machine, dense enough to feel alive.
          if (Math.random() < 0.45) try { playBootSfx('boot-bit'); } catch {}
          // Open the panel as part of its flicker — unless cfg said it
          // should stay collapsed (tagged during initFromConfig).
          if (el.classList.contains('panel') && el.dataset.stayCollapsed !== '1') {
            el.classList.remove('is-collapsed');
          }
        }, delay);
        // Panels AND audio grids both gate the synchronized info-trickle
        // start — neither should start revealing inner content while
        // the other category is still flickering.
        if (el.classList.contains('panel') || el.classList.contains('audio-grid')) {
          _lastPanelFlickerEnd = Math.max(_lastPanelFlickerEnd, delay + ANIM_MS);
        }
      });

      // Staggered info-trickle: once every panel + audio grid has
      // reached the settle point of its flicker, reveal each surface's
      // data ~1–2 at a time rather than all at once. Targets are
      // shuffled so the order isn't tied to flicker order, then offset
      // by ~320ms ± jitter so the start times overlap slightly (a
      // second surface begins while the first is still trickling its
      // own per-element fills in). Reads as a relaxed "one-by-one
      // with overlap" cascade across panels AND audio visualizers.
      const panelTargets = targets.filter(el =>
        el.classList.contains('panel') || el.classList.contains('audio-grid')
      );
      for (let i = panelTargets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [panelTargets[i], panelTargets[j]] = [panelTargets[j], panelTargets[i]];
      }
      const TRICKLE_PER_PANEL_MS = 270;  // base stagger between panel reveals
      const TRICKLE_JITTER_MS    = 150;  // ± per-panel jitter
      const PER_ELEMENT_MAX_MS   = 360;  // per-child random delay window (within a panel)
      const TRICKLE_ANIM_MS      = 300;  // matches CSS info-trickle duration

      let _lastTrickleEnd = _lastPanelFlickerEnd;
      panelTargets.forEach((el, i) => {
        const base = i * TRICKLE_PER_PANEL_MS;
        const jitter = (Math.random() - 0.5) * TRICKLE_JITTER_MS;
        const offset = Math.max(0, base + jitter);
        const startAt = _lastPanelFlickerEnd + offset;
        setTimeout(() => {
          const infoEls = el.querySelectorAll(
            // Panel info children
            '.bigvalue, .micro-val, .footer-readout, .panel-id, ' +
            '.meter, .core-grid, .gpu-grid, .mem-history-grid, ' +
            '.net-spark, .disk-spark, .storage-list, .storage-row, ' +
            '.gpu-mem, .gpu-mem-row, .temp-row, .net-row, ' +
            '.weather-cond, .weather-icon-big, .seg-bar, ' +
            // Audio-grid info children (canvas of bars + meta footer)
            '.audio-bars-row, .audio-meta-row'
          );
          for (const child of infoEls) {
            child.style.setProperty('--info-delay', `${Math.floor(Math.random() * PER_ELEMENT_MAX_MS)}ms`);
          }
          el.classList.add('info-on');
          // ~25 % of panels emit a short data-burst on info trickle —
          // sounds like a packet being decoded as the values fill in.
          if (Math.random() < 0.25) try { playBootSfx('boot-data'); } catch {}

          // Numeric readouts cycle 0 → current value to match the bars
          // growing in. Only fires on .bigvalue-num spans whose text is
          // a clean int/decimal — clocks, ratios, placeholders ("—")
          // are filtered out by the regex. Brief 200ms delay so the
          // opacity fade-in starts before the digits begin moving.
          for (const numEl of el.querySelectorAll('.bigvalue-num')) {
            const text = String(numEl.textContent || '').trim();
            if (/^-?\d{1,5}(\.\d{1,3})?$/.test(text)) {
              setTimeout(() => animateCountUp(numEl, text, 1150), 180);
            }
          }
        }, startAt);
        _lastTrickleEnd = Math.max(_lastTrickleEnd, startAt + PER_ELEMENT_MAX_MS + TRICKLE_ANIM_MS);
      });

      // Background grid flickers LAST — kicked off just after the
      // foreground cascade ends so the wallpaper coming on reads as the
      // closing beat of the wake-up sequence.
      const BG_DELAY_MS = SPREAD_MS + 250;
      if (bgGrid) {
        setTimeout(() => {
          const variant = FLICKER_VARIANTS[Math.floor(Math.random() * FLICKER_VARIANTS.length)];
          bgGrid.style.setProperty('--flicker-anim', variant);
          bgGrid.classList.add('is-flicker-in');
        }, BG_DELAY_MS);
      }

      // After info-trickle finishes, the dashboard is fully populated
      // but every flicker target is still sitting at the dim 0.55
      // brightness its per-element boot-flicker keyframe settled at.
      // Now fire the coordinated final brightness ramp on every target
      // (panels, audio grids, topbar, bg-grid) — they all ramp from
      // 0.55 → 1.0 in unison, reading as "everything warming to full"
      // the moment the dashboard finishes loading.
      const FINAL_BRIGHT_MS = 1500;
      const _finalBrightAt  = _lastTrickleEnd + 200;
      setTimeout(() => {
        for (const el of targets) el.classList.add('is-final-bright');
        if (bgGrid) bgGrid.classList.add('is-final-bright');
      }, _finalBrightAt);

      // Boot officially ends after the bg-grid flicker AND the final
      // brightness ramp BOTH finish. Holding the body.is-booting flag
      // until then keeps the `:not(.info-on)` hide rule + dim-state CSS
      // active so unrevealed panels don't pop and the ramp can play.
      const _bgEndMs   = (bgGrid ? BG_DELAY_MS : SPREAD_MS) + ANIM_MS + 200;
      const _bootEndMs = Math.max(_bgEndMs, _finalBrightAt + FINAL_BRIGHT_MS + 200);
      setTimeout(() => {
        document.body.classList.remove('is-booting');
        for (const el of targets) {
          el.classList.remove('is-flicker-in');
          el.classList.remove('is-final-bright');
        }
        if (bgGrid) {
          bgGrid.classList.remove('is-flicker-in');
          bgGrid.classList.remove('is-final-bright');
        }
        // Stop the bg-pattern churn and restore whatever the user had set.
        // Cancel any still-pending bg-cycle steps and force-restore
        // the user's pattern in case the sequence didn't finish (e.g.
        // boot ended very quickly or a reload triggered mid-cycle).
        for (const tm of _bgCycleTimers) clearTimeout(tm);
        document.body.setAttribute('data-bg-pattern', _origBgPattern);
      }, _bootEndMs);

      // ── Boot status in the PRODUCTIVITY header ────────────────────
      // Uses #combo-code (the "NOTES · SCRATCHPAD"-style subtitle) as
      // the status surface:
      //   t=0                       → OFFLINE
      //   t=_lastPanelFlickerEnd    → STANDBY    (panels lit, no data)
      //   t=_bootEndMs              → ONLINE     (data has trickled in)
      //   t=_bootEndMs + 1500       → time-of-day greeting
      //   t=greeting + 15000        → fade out
      //   t=fade-end                → restore mode-driven subtitle
      // paintComboHeader is gated on dataset.bootStatus so mode-switch
      // repaints during the sequence don't overwrite our status.
      const comboCodeEl = document.querySelector('#combo-code');
      const comboTagEl  = document.querySelector('#combo-tag');
      const comboPanelEl = document.querySelector('.panel-combo');
      if (comboCodeEl && comboPanelEl) {
        comboPanelEl.dataset.bootStatus = '1';
        comboCodeEl.style.transition = 'opacity 1200ms ease';
        comboCodeEl.textContent = 'OFFLINE';
        if (comboTagEl) {
          comboTagEl.style.transition = 'opacity 1200ms ease';
          comboTagEl.style.opacity = '0';
        }

        setTimeout(() => {
          comboCodeEl.textContent = 'STANDBY';
          // Computer-thinking noise burst as the panels settle and
          // the system starts hydrating data.
          try { playBootSfx('boot-think'); } catch {}
        }, _lastPanelFlickerEnd);
        setTimeout(() => {
          comboCodeEl.textContent = 'ONLINE';
          // Two-tone "system ready" chime when info trickle is done.
          try { playBootSfx('boot-ready'); } catch {}
        }, _bootEndMs);

        // 1.5 s after ONLINE, hand the combo header back to its normal
        // mode-driven paint (NOTES · SCRATCHPAD, etc). A scrolling
        // welcome ticker used to run here; it was removed because its
        // 24s infinite loop re-rasterized the text layer on every
        // restart and produced a recurring GPU temp spike.
        setTimeout(() => {
          delete comboPanelEl.dataset.bootStatus;
          comboCodeEl.style.transition = '';
          comboCodeEl.style.opacity    = '';
          comboCodeEl.innerHTML        = '';
          _paintComboHeader?.();
        }, _bootEndMs + 1500);
      }
    };

    // Safety net: if initFromConfig never resolves layout (no preload),
    // start the flicker anyway so the dashboard doesn't stay hidden.
    setTimeout(_startBootFlicker, 800);
  }
}

// Bumped on every theme change. Canvas renderers (audio bars, sparklines)
// cache CSS-variable lookups + LinearGradient objects keyed by this version
// so they don't call getComputedStyle on every frame. Declared at module
// top so factory functions defined further down (createAudioVisualizer)
// can read it during their init render() pass without hitting the TDZ.
let _themeVersion = 0;

// Single knob for how often the data-driven panels re-poll their
// sources. Applied to refreshSystem, netLoop, diskLoop, mute-state
// poll, and the diag overlay tick. Intentionally NOT applied to:
//   - tickClock (1s — would visibly stutter at 5s)
//   - refreshTemps / refreshStorage (already match or exceed this)
//   - weather (already 10 min)
//   - audio bars (real-time visualization; runs at ~15–23 Hz)
// 10 s refresh cadence drives refreshSystem, netLoop, diskLoop, mute-state
// poll, and the diag telemetry tick. Halved the per-second wakeup pressure
// on the i9-13900KS where bursty short polls keep cores from staying parked.
const UI_REFRESH_MS = 10000;

// Background diagnostics overlay counters. Hoisted so the audio
// visualizer's renderToTarget can bump the draw counter without
// reaching into the diag block's closure. Reset every second by the
// telemetry tick.
let _diagDrawCalls = 0;
let _diagFrames    = 0;
let _diagFps       = 0;
let _diagDrawPerS  = 0;
const _appStartTs  = Date.now();

// Tracks whether the combo panel is showing the visualizer pane. The audio
// factory's render() reads this to skip mirror-canvas painting when no one
// is looking — saves a full second draw pass at every audio sample tick.
// Updated by setComboMode().
let _comboInVisualizer = false;

// When the UI is locked, panel drag, panel resize, audio-grid drag/resize,
// and topbar reorder all bail at mousedown. Toggled by #lock-ui-btn,
// persisted under config.uiLocked, restored on load.
let _uiLocked = false;

// ── UI sound effects ────────────────────────────────────────────────────────
// Synthesized via Web Audio so we don't bundle any asset files. The context
// is created lazily on the first user gesture (Chromium suspends fresh
// AudioContexts otherwise) and reused across calls. `playSfx(kind)` dispatches
// to a small bank of short envelopes keyed by interaction type.
let _sfxCtx = null;
// UI sounds enabled. The on/off toggle UI is gone but the underlying
// flag stays so it's a one-line revert if needed. AudioContext is
// still created lazily on the first user gesture (Chromium suspends
// fresh contexts otherwise), so this flag costs nothing until SFX
// actually fires.
const _sfxEnabled = true;
function _sfxGetCtx() {
  if (!_sfxCtx) {
    try { _sfxCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { _sfxCtx = null; }
  }
  if (_sfxCtx?.state === 'suspended') _sfxCtx.resume?.();
  return _sfxCtx;
}
// SINGLE volume knob for ALL synthesized sound effects — UI clicks /
// tabs / confirm / error / delete bleeps AND the boot sequence. Both
// playSfx and playBootSfx route through this. Tweak this one number
// to make every dash sound louder or quieter; no need to touch per-
// kind gain ramps below. 10.0 = +100% over the 5.0 step.
// Clip note: the two loudest boot peaks (boot-power 0.105, boot-think
// sub 0.11) now exceed full-scale (1.05 and 1.10). Listen for crackle
// on those specifically — if you hear it, back off to ~9.0 or we can
// re-engineer the per-kind ramps. UI clicks all stay safely below 1.0.
const SFX_GAIN = 10.0;
// Dedup window for double-trigger suppression. The document-level
// click delegate (~line 753) auto-plays a sound for any button with
// one of a handful of marker classes; many feature modules also call
// playSfx() explicitly in their own click handlers. When a button
// matches both paths, the same DOM event fires playSfx twice within
// the same tick → audible doubled / overlapping bleep.
//
// Global (any-kind) dedup, not per-kind: toggle handlers now pick
// between 'click' and 'close' depending on the button's state, while
// the delegate still emits a generic 'click'. Without a global window
// we'd hear close+click stacked on every toggle-off. 30 ms is below
// the ~50 ms temporal resolution at which the ear hears two distinct
// click events, so legit fast user-clicking still rings each time,
// but two fires for the same DOM event collapse into one.
let _sfxLastFireAt = -1;
// 'type' has its own dedup so sustained typing doesn't block a click
// happening alongside it (and vice versa). 8 ms covers the same-event
// double-fire case without suppressing legit fast keystrokes — 125
// chars/sec is well above any realistic typing speed.
let _sfxLastTypeAt = -1;
const _SFX_DEDUP_WINDOW = 0.03;
const _SFX_TYPE_DEDUP_WINDOW = 0.008;
function playSfx(kind) {
  if (!_sfxEnabled) return;
  const ctx = _sfxGetCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (kind === 'type') {
    if (_sfxLastTypeAt >= 0 && now - _sfxLastTypeAt < _SFX_TYPE_DEDUP_WINDOW) return;
    _sfxLastTypeAt = now;
  } else {
    if (_sfxLastFireAt >= 0 && now - _sfxLastFireAt < _SFX_DEDUP_WINDOW) return;
    _sfxLastFireAt = now;
  }
  const t = now;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const master = ctx.createGain();
  master.gain.value = SFX_GAIN;
  osc.connect(gain).connect(master).connect(ctx.destination);
  // Start BEFORE the switch — modern Chromium throws "cannot call
  // stop without calling start first" if the case below schedules
  // osc.stop() on a not-yet-started source. (Used to be permissive;
  // tightened up in a recent Web Audio spec change.)
  osc.start(t);
  switch (kind) {
    // 'click' shares the soft triangle character with 'tab' — square
    // waves felt harsh in the rec room buttons (lots of odd harmonics
    // → buzzy), so we moved the default click to a triangle tick that
    // sits well across every surface. Kept as a separate kind from
    // 'tab' for semantic clarity (tabs vs buttons) and future tuning.
    case 'click':   // generic button — soft triangle tick
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1320, t);
      gain.gain.setValueAtTime(0.035, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.stop(t + 0.06); break;
    case 'close':   // dismiss / toggle-OFF — descending triangle
      // Mirrors 'click' but pitched downward: 1320 → 660 Hz (full
      // octave drop) across a slightly longer envelope so the
      // descent reads as a "settling down" / dismissal gesture.
      // Same triangle family so it doesn't feel like a different
      // button — just the same surface going the other way.
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1320, t);
      osc.frequency.exponentialRampToValueAtTime(660, t + 0.05);
      gain.gain.setValueAtTime(0.035, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.stop(t + 0.08); break;
    case 'tab':     // tab / mode switch — same triangle as 'click'
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1320, t);
      gain.gain.setValueAtTime(0.035, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.stop(t + 0.06); break;
    case 'type':    // keystroke — high triangle chirp with jitter
      // Per-keystroke pitch jitter (~±5%) keeps sustained typing from
      // feeling mechanical / sample-loop-y. Very short envelope (~15 ms)
      // keeps it from stacking into noise during fast typing. At
      // SFX_GAIN=10 the peak lands at ~0.45 of full-scale, comparable
      // in loudness to the click/close family — clearly audible without
      // dominating UI clicks happening alongside.
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(2100 * (0.95 + Math.random() * 0.10), t);
      gain.gain.setValueAtTime(0.045, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      osc.stop(t + 0.018); break;
    case 'delete':  // destructive — descending sawtooth bleep
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.18);
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.stop(t + 0.24); break;
    case 'confirm': // success — ascending two-step sine
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.exponentialRampToValueAtTime(990, t + 0.1);
      gain.gain.setValueAtTime(0.045, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.stop(t + 0.16); break;
    case 'error':   // failure — low square buzz
      osc.type = 'square';
      osc.frequency.setValueAtTime(220, t);
      osc.frequency.linearRampToValueAtTime(180, t + 0.15);
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.stop(t + 0.22); break;
    default:
      osc.type = 'square';
      osc.frequency.setValueAtTime(660, t);
      gain.gain.setValueAtTime(0.04, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.stop(t + 0.06);
  }
}
// Techy boot SFX — separate bank from the UI playSfx because each kind
// needs its own Web Audio node graph (noise buffers, multi-oscillator
// blends, etc.) rather than the single-osc shape playSfx uses. All
// sounds are procedurally generated so there are no audio file assets
// to ship. Routed through the same `_sfxEnabled` flag and AudioContext
// so user mute state and the audio-context resume logic still apply.
// Boot sounds share the unified SFX_GAIN multiplier with playSfx —
// see top of file. One number controls everything.
function playBootSfx(kind) {
  if (!_sfxEnabled) return;
  const ctx = _sfxGetCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  // Master gain for this sound event. Every oscillator / noise source
  // below connects through here instead of straight to ctx.destination,
  // so the SFX_GAIN multiplier applies uniformly to all of them.
  const master = ctx.createGain();
  master.gain.value = SFX_GAIN;
  master.connect(ctx.destination);

  switch (kind) {
    case 'boot-power': {
      // CRT power-on: low sawtooth that swells in, briefly bends up,
      // then fades. The "thunk" of the dashboard waking up.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain).connect(master);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(50, t);
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.4);
      gain.gain.setValueAtTime(0.0001, t);
      // Was 0.105 (clipped at SFX_GAIN=10 → 1.05). Trim to 0.09 so
      // the post-master signal lands at 0.90 — clean, no harmonic
      // crackle from a flat-topped sawtooth.
      gain.gain.exponentialRampToValueAtTime(0.09, t + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.start(t);
      osc.stop(t + 0.6);
      break;
    }
    case 'boot-bit': {
      // Single bit blip — random pitch per call so a burst of them
      // sounds like data ticking across a serial bus. Very quiet so
      // many can stack without becoming noise.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain).connect(master);
      const freq = 800 + Math.random() * 1800;
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      // Was 0.027 — bumped to 0.07 so each bit-tick reads as a sharp
      // pop instead of a faint click. Stays well clear of clip (0.70
      // final at SFX_GAIN=10). Square-wave at 800–2600 Hz lands in
      // the ear's most-sensitive band so this carries audible weight.
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
      osc.start(t);
      osc.stop(t + 0.035);
      break;
    }
    case 'boot-think': {
      // Deep humming to life — three sine layers, no sawtooth. Sawtooth
      // at low frequencies has the brassy harmonic stack that reads as
      // a trumpet / "fart" — pure sines have no harmonics beyond the
      // fundamental so they sound like a thick mechanical hum.
      // Pitch motion is tiny (45 → 60 Hz sub, 90 → 120 body) — large
      // bends are what made the prior version sound like a tone slide.
      // Total length 2.8 s with a slow ~1.2 s attack — the sound BUILDS
      // gradually to its peak so you feel the power gathering, not a
      // quick blurt. Overlapping the trickle/data phase is intentional
      // and approved; the bits + pings sit on top of this sustained bed.
      const tdur = 2.8;

      // (1) Sub-bass — very low sine, nearly stationary
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.connect(subGain).connect(master);
      sub.type = 'sine';
      sub.frequency.setValueAtTime(45, t);
      sub.frequency.linearRampToValueAtTime(60, t + tdur);
      subGain.gain.setValueAtTime(0.0001, t);
      // Was 0.11 (clipped at SFX_GAIN=10 → 1.10). Trim sub to 0.08
      // so the bass layer stays clean. Sub-bass at 45–60 Hz is
      // mostly felt rather than heard, so this drop is barely
      // audible — the body layer below does the actual lifting.
      subGain.gain.exponentialRampToValueAtTime(0.08, t + 1.2);
      subGain.gain.linearRampToValueAtTime(0.07, t + tdur * 0.85);
      subGain.gain.exponentialRampToValueAtTime(0.0001, t + tdur);
      sub.start(t);
      sub.stop(t + tdur + 0.02);

      // (2) Mid body — sine octave above the sub
      const body = ctx.createOscillator();
      const bodyGain = ctx.createGain();
      body.connect(bodyGain).connect(master);
      body.type = 'sine';
      body.frequency.setValueAtTime(90, t);
      body.frequency.linearRampToValueAtTime(120, t + tdur);
      bodyGain.gain.setValueAtTime(0.0001, t);
      // Was 0.06 — bumped to 0.09 so the mid-hum (the actual audible
      // layer for most speakers) gets close to full-scale at the
      // SFX_GAIN=10 master. Final 0.90; clean.
      bodyGain.gain.exponentialRampToValueAtTime(0.09, t + 1.6);
      bodyGain.gain.linearRampToValueAtTime(0.08, t + tdur * 0.85);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + tdur);
      body.start(t);
      body.stop(t + tdur + 0.02);

      // (3) Low-passed noise — "live circuit" texture, sub-audible
      // hiss that gives the sound its "powered on" character without
      // adding pitch content.
      const ndur = tdur;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * ndur), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const nFilter = ctx.createBiquadFilter();
      const nGain = ctx.createGain();
      noise.connect(nFilter).connect(nGain).connect(master);
      nFilter.type = 'lowpass';
      nFilter.Q.value = 1;
      nFilter.frequency.setValueAtTime(200, t);
      nFilter.frequency.linearRampToValueAtTime(400, t + tdur);
      nGain.gain.setValueAtTime(0.0001, t);
      // Was 0.025 — bumped to 0.05 so the "live circuit" texture
      // sits more audibly under the body hum. Still subtle by design;
      // this is texture, not melody.
      nGain.gain.exponentialRampToValueAtTime(0.05, t + 1.4);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + ndur);
      noise.start(t);
      noise.stop(t + ndur + 0.02);
      break;
    }
    case 'boot-data': {
      // Little bits of data — 3 quick square blips with subtle pitch
      // variation, spread over ~80 ms. Reads as a brief flicker of
      // data activity (same character as boot-bit but as a tight
      // cluster instead of a single tick). Far fewer than the prior
      // 5-blip melody, no rhythmic pattern.
      const blips = [
        { off: 0.00, base: 1400 },
        { off: 0.04, base: 1900 },
        { off: 0.07, base: 1100 },
      ];
      for (const b of blips) {
        const f = b.base * (0.92 + Math.random() * 0.16);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain).connect(master);
        osc.type = 'square';
        osc.frequency.setValueAtTime(f, t + b.off);
        // Was 0.022 — bumped to 0.07 so the 3-blip flicker cluster
        // reads as a distinct data-burst event, not faint background
        // ticking. Final 0.70 at SFX_GAIN=10; clean.
        gain.gain.setValueAtTime(0.07, t + b.off);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + b.off + 0.022);
        osc.start(t + b.off);
        osc.stop(t + b.off + 0.028);
      }
      break;
    }
    case 'boot-ready': {
      // High-sci-fi "system online" arpeggio. Replaces the prior glass-
      // bell cascade (warm/incandescent) with a clean ascending tonal
      // sequence (cool/digital) — think TNG bridge panel powering up
      // or Mass Effect's interface chime.
      //
      // Composition: ascending A-major arpeggio (A4 → C#5 → E5 → A5)
      // — four staccato notes 80 ms apart — resolving onto a sustained
      // C#6 with a perfect-fifth (G#6) layered on top for the "lock-in"
      // chord. Tonal harmony (vs the prior inharmonic 2.51x ratio) is
      // what gives this the synth-console character: every interval is
      // a "real" musical relationship, not a struck-glass overtone.
      //
      // Voice: triangle waves with a slightly-detuned second oscillator
      // per note (+7 cents) for synth-chorus thickness — close enough
      // to unison to read as one voice, far enough apart to feel like
      // hardware/analog rather than a single sterile sine.
      const ARP_NOTES = [
        { off: 0.00, freq: 440,  dur: 0.18, peak: 0.045 }, // A4
        { off: 0.08, freq: 554,  dur: 0.18, peak: 0.045 }, // C#5
        { off: 0.16, freq: 660,  dur: 0.18, peak: 0.045 }, // E5
        { off: 0.24, freq: 880,  dur: 0.20, peak: 0.05  }, // A5
        { off: 0.34, freq: 1108, dur: 0.60, peak: 0.06  }, // C#6 — sustained final
      ];
      for (const n of ARP_NOTES) {
        // Primary triangle voice — clean, soft, no buzzy harmonics.
        const osc1 = ctx.createOscillator();
        const g1 = ctx.createGain();
        osc1.connect(g1).connect(master);
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(n.freq, t + n.off);
        g1.gain.setValueAtTime(0.0001, t + n.off);
        g1.gain.exponentialRampToValueAtTime(n.peak, t + n.off + 0.005);
        g1.gain.exponentialRampToValueAtTime(0.0001, t + n.off + n.dur);
        osc1.start(t + n.off);
        osc1.stop(t + n.off + n.dur + 0.01);

        // Detuned chorus partner — +7 cents (×1.004) above the
        // fundamental, ~60% level. Tight enough to fuse with osc1 into
        // one perceived note; the small phase drift makes it "alive".
        const osc2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc2.connect(g2).connect(master);
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(n.freq * 1.004, t + n.off);
        g2.gain.setValueAtTime(0.0001, t + n.off);
        g2.gain.exponentialRampToValueAtTime(n.peak * 0.6, t + n.off + 0.005);
        g2.gain.exponentialRampToValueAtTime(0.0001, t + n.off + n.dur);
        osc2.start(t + n.off);
        osc2.stop(t + n.off + n.dur + 0.01);
      }

      // "Lock-in" chord — perfect fifth above the sustained final note
      // (C#6 + 5th = G#6 ≈ 1661 Hz), enters with the final note and
      // sustains alongside it. A perfect fifth is the most consonant
      // non-unison interval — what makes the sound feel resolved /
      // "system ready" rather than still climbing.
      const FINAL_OFF = 0.34;
      const FINAL_DUR = 0.60;
      const fifth = ctx.createOscillator();
      const gF = ctx.createGain();
      fifth.connect(gF).connect(master);
      fifth.type = 'triangle';
      fifth.frequency.setValueAtTime(1661, t + FINAL_OFF);
      gF.gain.setValueAtTime(0.0001, t + FINAL_OFF);
      // 25 ms attack (slower than the arpeggio notes' 5 ms) so the
      // chord blooms IN rather than punching. Lower peak than the
      // root so it feels like harmonic support, not a separate note.
      gF.gain.exponentialRampToValueAtTime(0.035, t + FINAL_OFF + 0.025);
      gF.gain.exponentialRampToValueAtTime(0.0001, t + FINAL_OFF + FINAL_DUR);
      fifth.start(t + FINAL_OFF);
      fifth.stop(t + FINAL_OFF + FINAL_DUR + 0.01);
      break;
    }
  }
}

// Document-level delegate: any click on a recognized control plays a click
// or delete bleep. We map by class so adding a new button (with the right
// class) gets the SFX automatically. Delete-class controls win over click
// when both apply.
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  // Truly destructive surfaces — file deletion etc. — get the
  // descending sawtooth 'delete' bleep. Don't add X-style dismiss
  // buttons here; those belong on 'close'.
  if (t.closest('[data-explore-delete]')) {
    playSfx('delete');
    return;
  }
  // X-style close buttons across every modal / overlay / tab — these
  // are dismissals, not deletions, so they get the soft descending
  // 'close' tick that mirrors the standard 'click'. Centralising the
  // selector list here means new overlays only need to use one of
  // these class hooks to inherit the sound automatically.
  if (t.closest([
    '.note-tab-close',         // note tab × (dismisses the tab, not the note)
    '.browser-tab-close',      // browser tab ×
    '.explore-viewer-close',   // EXPLORE inline-viewer ×
    '.browser-history-close',  // history / bookmarks / scrape ×
    '.fans-editor-close',      // fans editor ×
    '.trim-close',             // trim modal ×
    '.lx-close',               // launcher ×
    '.picture-picker-close',   // picture / source picker ×
    '.fr-close-btn',           // first-run wizard ×
    '.terminal-close',         // terminal ×
    '.webcam-close',           // webcam popout ×
    '#close-btn',              // topbar quit
  ].join(','))) {
    playSfx('close');
    return;
  }
  // Tabs / mode switches — same triangle as 'click', kept as its own
  // kind so we can re-pitch them independently later if needed.
  if (t.closest('.combo-mode-tab, .explore-tab, .note-tab')) {
    playSfx('tab');
    return;
  }
  // Generic buttons — catch-all so every room (rec, music, edit,
  // browser, visualizer, etc.) gets a click sound without each
  // module needing its own per-element wiring. Native <button>
  // and role="button" elements catch the bulk; the explicit class
  // hooks below stay for the few clickable non-button elements
  // (spans / divs with click handlers) that should also chirp.
  if (t.closest('button, [role="button"], .topbar-btn, .explore-action, .panel-collapse-btn, .audio-mute-btn, .audio-gain-btn, .paper-tool-btn')) {
    playSfx('click');
  }
});
// Bubble phase (no capture flag) is deliberate: per-element click
// handlers run first and can play a more specific kind ('close' for
// toggle-off, etc.); the delegate above falls back with 'click' only
// when nothing else claimed the event. With capture phase the delegate
// would fire first and the global dedup would suppress the more
// specific per-element sound.

// Keystroke SFX: a quiet sci-fi chirp on every typing keydown while
// the user is focused in a text-input context. Wired at the document
// level so all rooms / overlays pick it up automatically.
//
// Filters out:
//   • modifier-only or shortcut combos (Ctrl/Cmd/Alt) — those are
//     commands, not characters
//   • pure navigation keys (Arrow*, Home/End, PageUp/Down, etc.) —
//     they don't insert characters
//   • events outside text-input surfaces — clicking elsewhere and
//     hitting Space shouldn't chirp
//
// Tab triggers a chirp because in a multiline textarea it inserts
// a tab character; in inputs that move focus it still feels like
// keyboard activity.
const _TYPE_INPUT_SELECTOR = [
  'input[type="text"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="email"]',
  'input[type="password"]',
  'input[type="number"]',
  'input[type="tel"]',
  'input:not([type])',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(',');
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Held-key auto-repeat would machine-gun the chirp every ~30 ms
  // once the OS kicks in. Skip the repeated events so the sound only
  // fires on the user's actual key-down moment.
  if (e.repeat) return;
  const k = e.key;
  // Single-char keys (letters / digits / punctuation / space) plus
  // the editing keys that insert or remove visible characters.
  const isTypingKey = k.length === 1
    || k === 'Backspace' || k === 'Delete' || k === 'Enter' || k === 'Tab';
  if (!isTypingKey) return;
  const target = e.target;
  if (!target || !target.matches) return;
  if (!target.matches(_TYPE_INPUT_SELECTOR)) return;
  playSfx('type');
});

// Tracks the user-chosen theme so setTheme can persist it. The auto-engaged
// "alert" theme override was removed — error paths still surface ERR inline
// without forcing a global palette swap.
let   _userTheme   = null;

// ── Browser-mode shim ───────────────────────────────────────────────────────
// When loaded outside Electron (iPad, phone, another laptop on the LAN), the
// preload bridge isn't injected, so we install a fetch-backed equivalent that
// hits the HTTP API the main process exposes. Window-only operations
// (fullscreen, always-on-bottom IPC) become no-ops in this mode.
const IS_ELECTRON = !!window.dash;
if (!IS_ELECTRON) {
  async function getJson(p) {
    const r = await fetch(p);
    if (!r.ok) throw new Error(`${p} ${r.status}`);
    return r.json();
  }
  async function postJson(p, body) {
    const r = await fetch(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${p} ${r.status}`);
    return r.json();
  }
  window.dash = {
    platform:         'browser',
    systemInfo:       () => getJson('/api/system-info'),
    storageInfo:      () => getJson('/api/storage-info'),
    tempsInfo:        () => getJson('/api/temps-info'),
    netInfo:          () => getJson('/api/net-info'),
    diskInfo:         () => getJson('/api/disk-info'),
    getConfig:        () => getJson('/api/config'),
    setConfig:        (partial) => postJson('/api/config', partial),
    configPath:       () => Promise.resolve('(server-side)'),
    getScreenSources: () => getJson('/api/screen-sources'),
    toggleFullscreen: async () => {
      // Use the browser's own fullscreen API as a best-effort.
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen?.();
      return !!document.fullscreenElement;
    },
  };
}

// Background is a pure CSS flat grid with a slow pulse animation — no
// WebGL, no per-cell DOM. Earlier versions painted one <div> per 200 px
// grid cell with a randomized opacity flicker, but every opacity change
// triggered a GPU layer promotion and the compositor spent most of its
// budget rebuilding the layer tree. Removed entirely; the `.bg-grid`
// element keeps the visual grid pattern (see styles.css §3).
const BG_OVERLAY = document.querySelector('#bg-grid-overlay');
if (BG_OVERLAY) BG_OVERLAY.innerHTML = '';

// ── HUD: Clock ───────────────────────────────────────────────────────────────
const clockTimeEl   = document.querySelector('#clock-time');
const clockAmpmEl   = document.querySelector('#clock-ampm');
const clockDateEl   = document.querySelector('#clock-date');
const clockTzEl     = document.querySelector('#clock-tz');
const clockLocalNameEl = document.querySelector('#clock-local-name');

// The "LOCAL" block in the clock shows three things stacked: the static
// label, the user's chosen city (from cfg.weatherCity), and the IANA
// timezone. selectCity / first-run setup / initFromConfig all call this
// helper so the city stays in sync with the rest of the dashboard.
function setLocalClockCity(loc) {
  if (!clockLocalNameEl) return;
  const name = loc?.name ? String(loc.name).toUpperCase() : '—';
  clockLocalNameEl.textContent = name;
}
const clockDoyEl    = document.querySelector('#clock-doy');
const clockDoyHdrEl = document.querySelector('#clock-doy-header');
const clockIdentEl  = document.querySelector('#clock-ident');

const altTimeEl     = document.querySelector('#alt-time');
const altAmpmEl     = document.querySelector('#alt-ampm');
const altNameEl     = document.querySelector('#alt-name');
const altTzEl       = document.querySelector('#alt-tz');
const altCityInput  = document.querySelector('#alt-city-input');

// Alt-zone 2 was removed from the clock panel; refs kept null so any
// downstream code that may still reference them falls through cleanly.
const alt2TimeEl    = null;
const alt2AmpmEl    = null;
const alt2NameEl    = null;
const alt2TzEl      = null;
const alt2CityInput = null;

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' });
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function makeTimeFmt(tz) {
  return new Intl.DateTimeFormat([], {
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true,
    ...(tz ? { timeZone: tz } : {}),
  });
}

function splitTime(fmt, date) {
  // Returns { hms: "11:42:35", ampm: "AM" }
  const parts = fmt.formatToParts(date);
  let h = '', m = '', s = '', ampm = '';
  for (const p of parts) {
    if (p.type === 'hour')      h = p.value;
    else if (p.type === 'minute') m = p.value;
    else if (p.type === 'second') s = p.value;
    else if (p.type === 'dayPeriod') ampm = p.value;
  }
  return { hms: `${h.padStart(2, '0')}:${m}:${s}`, ampm: ampm.toUpperCase() };
}

const localTimeFmt = makeTimeFmt(localTz);
let altTimeFmt = null;
let altLocation = null;  // { name, timezone }
let altTimeFmt2 = null;
let altLocation2 = null; // { name, timezone }

function dayOfYear(d) {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

const zenTimeEl       = document.querySelector('#zen-time');
const zenAmpmEl       = document.querySelector('#zen-ampm');
const zenAmpmMirEl    = document.querySelector('#zen-ampm-mirror');
const zenDateEl       = document.querySelector('#zen-date');
const webcamStampEl   = document.querySelector('#webcam-timestamp');

// Pad helper for the webcam date stamp.
function _pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Build the zen clock as per-character spans with fixed widths so the
// centered clock can't drift sideways as digits change.
const _zenTimeCells = [];
let _zenTimeInitialized = false;
function paintZenTime(text) {
  if (!zenTimeEl) return;
  // First call: blow away the placeholder text node ("--:--:--") that sits
  // next to the spans we're about to add. Without this you see the dashes
  // ghosted in front of the live clock on the first tick.
  if (!_zenTimeInitialized) {
    zenTimeEl.textContent = '';
    _zenTimeInitialized = true;
  }
  // Reuse spans where possible to keep DOM thrash to a minimum.
  while (_zenTimeCells.length < text.length) {
    const s = document.createElement('span');
    s.className = 'zen-time-char';
    zenTimeEl.appendChild(s);
    _zenTimeCells.push(s);
  }
  while (_zenTimeCells.length > text.length) {
    const s = _zenTimeCells.pop();
    zenTimeEl.removeChild(s);
  }
  let anyChanged = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const cell = _zenTimeCells[i];
    if (cell.textContent !== ch) {
      cell.textContent = ch;
      anyChanged = true;
      // Restart the pop animation: drop the class, force a reflow so the
      // browser commits the removed state, then re-add. Without the
      // reflow trick the animation wouldn't re-trigger when the same
      // class is removed and re-added in the same frame.
      cell.classList.remove('is-popping');
      void cell.offsetWidth;
      cell.classList.add('is-popping');
    }
    const sep = (ch === ':' || ch === '.') ? '1' : '0';
    if (cell.dataset.sep !== sep) cell.dataset.sep = sep;
  }
  // Whole-clock hop on any digit change — same reflow trick to retrigger.
  if (anyChanged) {
    const clockEl = zenTimeEl.parentElement;
    if (clockEl) {
      clockEl.classList.remove('is-jumping');
      void clockEl.offsetWidth;
      clockEl.classList.add('is-jumping');
    }
  }
}

// Whole-month calendar — every day of the current month, laid out
// Sun-to-Sat with a week-aligned header row and leading/trailing pad
// cells from the adjacent months so the grid always fills a clean
// 7-column block. Rebuilt only when the calendar date rolls over.
const clockCalEl = document.querySelector('#clock-calendar');
const calWdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const calMoFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
let _calDayKey = '';
function renderCalendar(now) {
  if (!clockCalEl) return;
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (key === _calDayKey) return;
  _calDayKey = key;
  clockCalEl.replaceChildren();

  // Weekday header row (S M T W T F S) so the user can scan columns
  // without each cell needing its own weekday chip.
  const sundayRef = new Date(2024, 5, 2); // any Sunday — used purely to format weekday names
  for (let i = 0; i < 7; i++) {
    const d = new Date(sundayRef.getFullYear(), sundayRef.getMonth(), sundayRef.getDate() + i);
    const head = document.createElement('div');
    head.className = 'cal-head';
    if (i === 0 || i === 6) head.classList.add('is-weekend');
    head.textContent = calWdFmt.format(d).slice(0, 1).toUpperCase();
    clockCalEl.appendChild(head);
  }

  const year = now.getFullYear();
  const month = now.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();           // 0 = Sun
  // The "grid start" is the Sunday on or before the 1st — so leading
  // pad cells show the previous month's tail. Total cells = 6 rows ×
  // 7 cols = 42, which always covers the longest possible month
  // alignment (29-31 days starting on any weekday).
  const gridStart = new Date(year, month, 1 - startWeekday);
  const today = now.getDate();
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    const inMonth = (d.getMonth() === month && d.getFullYear() === year);
    if (!inMonth) cell.classList.add('is-out-of-month');
    if (inMonth && d.getDate() === today) cell.classList.add('is-today');
    const wd = d.getDay();
    if (wd === 0 || wd === 6) cell.classList.add('is-weekend');
    const numEl = document.createElement('span');
    numEl.className = 'cal-day-num';
    numEl.textContent = String(d.getDate());
    cell.appendChild(numEl);
    // First cell of any month (the 1st) gets a small MMM tag so the
    // user can see which month the pad cells belong to.
    if (d.getDate() === 1) {
      const moEl = document.createElement('span');
      moEl.className = 'cal-day-mo';
      moEl.textContent = calMoFmt.format(d).toUpperCase();
      cell.appendChild(moEl);
    }
    clockCalEl.appendChild(cell);
  }
}

function tickClock() {
  const now = new Date();
  const { hms: lhms, ampm: lap } = splitTime(localTimeFmt, now);
  clockTimeEl.textContent = lhms;
  clockAmpmEl.textContent = lap;
  clockDateEl.textContent = dateFmt.format(now).toUpperCase();
  const doy = String(dayOfYear(now)).padStart(3, '0');
  clockDoyEl.textContent    = doy;
  clockDoyHdrEl.textContent = doy;
  clockIdentEl.textContent  = doy;
  const clockCodeEl = document.getElementById('clock-code');
  if (clockCodeEl) clockCodeEl.textContent = `${lhms} ${lap} · DOY ${doy}`;
  renderCalendar(now);
  // Mirror to the zen overlay (visible only while idle). Mirror element
  // tracks the visible AM/PM text so the invisible spacer width matches
  // exactly, keeping the time pinned to viewport center. Each character of
  // the time goes into its own fixed-width span so the display-font (which
  // doesn't have true tabular numerals) can't make the row jiggle.
  if (zenTimeEl) paintZenTime(lhms);
  if (zenAmpmEl)    zenAmpmEl.textContent    = lap;
  if (zenAmpmMirEl) zenAmpmMirEl.textContent = lap;
  if (zenDateEl)    zenDateEl.textContent    = dateFmt.format(now).toUpperCase();
  // Security-cam style timestamp on the webcam panel: ISO date + 24h time.
  if (webcamStampEl) {
    const iso = `${now.getFullYear()}-${_pad2(now.getMonth() + 1)}-${_pad2(now.getDate())}`;
    const t24 = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    webcamStampEl.textContent = `${iso}  ${t24}`;
  }

  if (altTimeFmt && altLocation) {
    const { hms, ampm } = splitTime(altTimeFmt, now);
    altTimeEl.textContent = hms;
    altAmpmEl.textContent = ampm;
  } else {
    altTimeEl.textContent = '--:--:--';
    altAmpmEl.textContent = '--';
  }

  // Alt-zone 2 removed; skip its tick.
}
clockTzEl.textContent = (localTz || '—').toUpperCase();
tickClock();
// Gated on visibility — no point reformatting the clock while the
// dashboard is hidden. visibilitychange fires an immediate tick so the
// clock is never visibly stale when the dashboard comes back.
setInterval(() => { if (!document.hidden) tickClock(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickClock(); });

function applyAltLocation(loc) {
  altLocation = loc;
  altTimeFmt = loc?.timezone ? makeTimeFmt(loc.timezone) : null;
  altNameEl.textContent = loc ? (loc.name || '—').toUpperCase() : '—';
  altTzEl.textContent   = loc?.timezone ? loc.timezone.toUpperCase() : '—';
  if (loc) altCityInput.value = loc.name || '';
  tickClock();
}

// applyAltLocation2 / alt2 city handler — removed along with the
// alt-zone-2 row. Boot config code below also skips cfg.altCity2.

async function geocodeForTimezone(name) {
  // Reuses Open-Meteo's geocoding API; the response includes .timezone.
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error(`Couldn't find "${name}"`);
  return { name: hit.name, timezone: hit.timezone, country: hit.country_code || hit.country };
}

altCityInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const v = altCityInput.value.trim();
  if (!v) return;
  altNameEl.textContent = 'LOOKING UP…';
  try {
    const hit = await geocodeForTimezone(v);
    await window.dash?.setConfig?.({ altCity: hit });
    applyAltLocation(hit);
  } catch (err) {
    altNameEl.textContent = 'NOT FOUND';
  }
});


// ── HUD: System ──────────────────────────────────────────────────────────────
const sysCoresEl       = document.querySelector('#sys-cores');
const sysCoresValueEl  = document.querySelector('#sys-cores-value');
const sysCoresIdentEl  = document.querySelector('#sys-cores-ident');
const sysCpuBarEl      = document.querySelector('#sys-cpu-bar');
const sysCpuValEl      = document.querySelector('#sys-cpu-value');
const sysMemBarEl      = document.querySelector('#sys-mem-bar');
const sysMemValEl      = document.querySelector('#sys-mem-value');
const coreGridEl       = document.querySelector('#core-grid');
const memHistGridEl    = document.querySelector('#mem-hist-grid');
const memHistValueEl   = document.querySelector('#sys-mem-hist-value');
// SCRATCH DISK meter (scratchGridEl / scratchValueEl) was removed from
// the RAM panel — per-drive usage is already covered by the STORAGE panel.

let lastCpuTimes = null;
const coreFillEls = []; // index = logical processor

function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${u[i]}`;
}

function deltaLoad(prev, curr) {
  // Returns load fraction [0,1] from two cpus.times samples.
  const pTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
  const cTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;
  const totalDelta = cTotal - pTotal;
  const idleDelta  = curr.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - idleDelta / totalDelta));
}

// Generic metric-bar helper: paints a .core-bar-fill or .gpu-bar-fill, then
// manages a floating peak marker (snap up, hold, slow decay) as a sibling
// inside the same track. Replaces the old warn/high class swap — the
// underlying fill background is now a cool→warm→hot vertical gradient
// anchored to the track's pixel height via --bar-h, so the peak alone
// communicates urgency.
//
// Tuned for the slow update rates of these graphs (CPU/GPU/RAM tick every
// 2 s). HOLD=1 frame ≈ 2 s pause at the peak; DECAY=30 means the peak drops
// 30 percentage points per update, so a fresh 100 % peak clears in ~3
// frames (≈ 6 s). The CSS transition on .core-bar-peak / .gpu-bar-peak
// smooths the visual fall between the discrete updates.
const METRIC_PEAK_HOLD_FRAMES = 1;
const METRIC_PEAK_DECAY = 30;

function setMetricBar(fill, pct) {
  if (!fill) return;
  pct = Math.max(0, Math.min(100, +pct || 0));
  // Set a CSS variable instead of style.height. The CSS rule reads it via
  // transform: translateY(calc((100 - var(--bar-pct)) * 1%)), which moves
  // the bar on the compositor without triggering Layout. The 0.35 s height
  // transition formerly fired 21 Layouts per bar per refresh × 32 cores =
  // ~672 Layouts per refresh — visible as ~120 ms "Layout" in the profile.
  // Variable writes don't trigger Layout; transform transitions don't either.
  fill.style.setProperty('--bar-pct', pct.toFixed(0));
  const track = fill.parentElement;
  if (!track) return;
  const peakClass = fill.classList.contains('gpu-bar-fill') ? 'gpu-bar-peak' : 'core-bar-peak';
  let peak = track.querySelector(`:scope > .${peakClass}`);
  if (!peak) {
    peak = document.createElement('div');
    peak.className = peakClass;
    track.appendChild(peak);
    const updateBarH = () => {
      const h = track.clientHeight;
      if (h > 0) track.style.setProperty('--bar-h', `${h}px`);
    };
    updateBarH();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(updateBarH).observe(track);
    }
  }
  let pk   = parseFloat(track.dataset.peak)     || 0;
  let hold = parseInt(track.dataset.peakHold, 10) || 0;
  if (pct >= pk) { pk = pct; hold = METRIC_PEAK_HOLD_FRAMES; }
  else if (hold > 0) hold--;
  else pk = Math.max(pct, pk - METRIC_PEAK_DECAY);
  track.dataset.peak = pk.toFixed(2);
  track.dataset.peakHold = hold;
  // Same Layout-avoidance trick for the peak marker. The CSS rule uses
  // transform translateY off the bottom edge instead of `bottom: X%`.
  peak.style.setProperty('--peak-pct', pk.toFixed(0));
}

// Mirror grid for the zen overlay (no labels, smaller).
const zenCoreGridEl  = document.querySelector('#zen-core-grid');
const zenCpuValueEl  = document.querySelector('#zen-cpu-value');
const zenCoreFillEls = [];

function buildCoreGrid(count) {
  coreGridEl.innerHTML = '';
  coreFillEls.length = 0;
  for (let i = 0; i < count; i++) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill  = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'core-bar-label';
    label.textContent = String(i).padStart(2, '0');
    bar.appendChild(track);
    bar.appendChild(label);
    coreGridEl.appendChild(bar);
    coreFillEls.push(fill);
  }
  // Build matching grid in the zen overlay (same number of bars, no labels).
  if (zenCoreGridEl) {
    zenCoreGridEl.innerHTML = '';
    zenCoreFillEls.length = 0;
    for (let i = 0; i < count; i++) {
      const bar = document.createElement('div');
      bar.className = 'core-bar';
      const track = document.createElement('div');
      track.className = 'core-bar-track';
      const fill = document.createElement('div');
      fill.className = 'core-bar-fill';
      track.appendChild(fill);
      bar.appendChild(track);
      zenCoreGridEl.appendChild(bar);
      zenCoreFillEls.push(fill);
    }
  }
}

function paintCore(fill, load) {
  setMetricBar(fill, load * 100);
}

// Per-core rolling-average smoothing. Individual logical cores spike
// wildly between samples even at a slow refresh rate — the OS shifts
// threads between cores constantly, so any single 500 ms window can
// catch a core idle one tick and pegged the next. Averaging the last
// N samples per core damps the visual chaos without hiding real
// trends; total cpuLoad (mean of smoothed cores) becomes calmer too,
// which feeds the TASKS-pane wire-graph cleanly.
//
// 4 samples × 500 ms PANEL_REFRESH_MS = 2 s smoothing window.
const CORE_LOAD_SMOOTH_N = 4;
const _coreLoadHistory = [];

// Memory history — time-series of system memory % usage.
// 33 samples × 2s = 66s window. Length was bumped from 30 to align with
// the DOS-theme #mem-hist-grid layout (11 cols × 3 rows = 33 cells) so
// the grid fills cleanly with no trailing empty cells.
const MEM_HIST_LEN = 32;
const memHistBuf = new Array(MEM_HIST_LEN).fill(0);
const memHistFills = [];
const zenMemGridEl  = document.querySelector('#zen-mem-grid');
const zenMemValueEl = document.querySelector('#zen-mem-value');
const zenMemFills   = [];

function ensureMemHistGrid() {
  if (memHistFills.length === MEM_HIST_LEN) return;
  memHistGridEl.innerHTML = '';
  memHistFills.length = 0;
  for (let i = 0; i < MEM_HIST_LEN; i++) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    bar.appendChild(track);
    memHistGridEl.appendChild(bar);
    memHistFills.push(fill);
  }
  if (zenMemGridEl && zenMemFills.length !== MEM_HIST_LEN) {
    zenMemGridEl.innerHTML = '';
    zenMemFills.length = 0;
    for (let i = 0; i < MEM_HIST_LEN; i++) {
      const bar = document.createElement('div');
      bar.className = 'core-bar';
      const track = document.createElement('div');
      track.className = 'core-bar-track';
      const fill = document.createElement('div');
      fill.className = 'core-bar-fill';
      track.appendChild(fill);
      bar.appendChild(track);
      zenMemGridEl.appendChild(bar);
      zenMemFills.push(fill);
    }
  }
}

function pushMemHistory(pct) {
  ensureMemHistGrid();
  memHistBuf.push(pct);
  if (memHistBuf.length > MEM_HIST_LEN) memHistBuf.shift();
  for (let i = 0; i < MEM_HIST_LEN; i++) {
    setMetricBar(memHistFills[i], memHistBuf[i]);
    if (zenMemFills[i]) setMetricBar(zenMemFills[i], memHistBuf[i]);
  }
  const cur = memHistBuf[memHistBuf.length - 1] || 0;
  if (zenMemValueEl) zenMemValueEl.textContent = `${cur.toFixed(0)}%`;
  if (memHistValueEl) {
    memHistValueEl.textContent = `${cur.toFixed(0)}%`;
  }
}

// SCRATCH DISK grid (buildScratchGrid / paintScratchGrid) removed — the
// per-drive bar grid that used to sit in the RAM panel under
// MEM HISTORY · 60S no longer exists. The STORAGE panel already shows
// per-drive usage in more detail, so this was redundant. paintStorage
// no longer calls paintScratchGrid; the 500ms grid-line sweep loop also
// drops scratchGridEl from its iteration list.

async function refreshSystem() {
  if (!window.dash) return;
  try {
    const info = await window.dash.systemInfo();

    if (coreFillEls.length !== info.cpuCount) {
      buildCoreGrid(info.cpuCount);
      sysCoresEl.textContent      = String(info.cpuCount).padStart(2, '0');
      sysCoresValueEl.textContent = `${info.cpuCount} LOGICAL`;
      sysCoresIdentEl.textContent = String(info.cpuCount).padStart(3, '0');
    }

    let cpuLoad = 0;
    if (lastCpuTimes && info.cpuTimes.length === lastCpuTimes.length) {
      let sum = 0;
      for (let i = 0; i < info.cpuTimes.length; i++) {
        const raw = deltaLoad(lastCpuTimes[i], info.cpuTimes[i]);
        // Per-core rolling avg — see CORE_LOAD_SMOOTH_N comment.
        let hist = _coreLoadHistory[i];
        if (!hist) { hist = []; _coreLoadHistory[i] = hist; }
        hist.push(raw);
        if (hist.length > CORE_LOAD_SMOOTH_N) hist.shift();
        const load = hist.reduce((a, b) => a + b, 0) / hist.length;
        if (coreFillEls[i])    paintCore(coreFillEls[i], load);
        if (zenCoreFillEls[i]) paintCore(zenCoreFillEls[i], load);
        sum += load;
      }
      cpuLoad = sum / info.cpuTimes.length;
    } else {
      cpuLoad = Math.min(1, (info.loadavg?.[0] || 0) / Math.max(1, info.cpuCount));
    }
    lastCpuTimes = info.cpuTimes;
    // Expose last load fraction to refreshTemps so it can estimate CPU
    // wattage when Windows' RAPL energy meter is not reporting (common
    // when Turbo Boost is disabled, see paintPower comment below).
    window._lastCpuLoadFrac = cpuLoad;

    const cpuPct = cpuLoad * 100;
    // Feed the TASKS-pane wire-graph. CPU buffer captured here so the
    // line reflects the same number the bar shows below.
    pushTasksCpuHist(cpuLoad);
    sysCpuBarEl.style.width = `${cpuPct.toFixed(0)}%`;
    sysCpuBarEl.classList.toggle('high', cpuPct >= 85);
    sysCpuValEl.textContent = `${cpuPct.toFixed(0)}%`;
    if (zenCpuValueEl) zenCpuValueEl.textContent = `${cpuPct.toFixed(0)}%`;
    // HUD theme — CPU LOAD bar joins the gauge family (badge above +
    // segmented LEDs + tick scale below).
    if (document.documentElement.dataset.theme?.startsWith('hud')) {
      const cpuBarParent = sysCpuBarEl.parentElement;
      if (cpuBarParent) _renderFixedGauge(cpuBarParent, cpuPct, `${Math.round(cpuPct)}%`);
    }

    const memFrac = info.usedMem / info.totalMem;
    const memPct  = memFrac * 100;
    sysMemBarEl.style.width = `${memPct.toFixed(0)}%`;
    sysMemBarEl.classList.toggle('high', memPct >= 85);
    sysMemValEl.textContent = `${fmtBytes(info.usedMem)} / ${fmtBytes(info.totalMem)}`;
    // HUD theme — paint the memory bar with the full canvas gauge
    // (badge above + marker + tick scale below), same shape the
    // thermal panel uses.
    if (document.documentElement.dataset.theme?.startsWith('hud')) {
      const memBarParent = sysMemBarEl.parentElement;
      if (memBarParent) _renderFixedGauge(memBarParent, memPct, `${Math.round(memPct)}%`);
    }

    pushMemHistory(memPct);
    // Feed the TASKS-pane wire-graph RAM line.
    pushTasksRamHist(memPct);

    // Live header summaries — show at-a-glance state in the panel
    // headers so the user can read current usage even when the panel
    // is collapsed.
    const cpuCodeEl = document.getElementById('cpu-code');
    if (cpuCodeEl) cpuCodeEl.textContent = `${cpuPct.toFixed(0)}% · ${info.cpuCount} CORES`;
    const ramCodeEl = document.getElementById('ram-code');
    if (ramCodeEl) ramCodeEl.textContent = `${memPct.toFixed(0)}% · ${fmtBytes(info.usedMem)} / ${fmtBytes(info.totalMem)}`;
  } catch (err) {
    sysCoresValueEl.textContent = `ERR: ${err.message}`;
  }
}

// CPU/RAM tick. Chained setTimeout at PANEL_REFRESH_MS — decoupled
// from the audio visualizer so the wire-graph CPU line stays alive
// (10 Hz feed) even when the user has throttled audio to a calm
// 1–2 Hz on the topbar dial. systemInfo IPC is os.cpus() + os.totalmem()
// in-process, microseconds per call, so 10 Hz is essentially free.
async function _systemLoop() {
  if (!document.hidden) await refreshSystem();
  setTimeout(_systemLoop, PANEL_REFRESH_MS);
}
_systemLoop();

// ── HUD: Battery ─────────────────────────────────────────────────────────────
// Laptop-only. si.battery() reports hasBattery:false on a desktop — in
// that case the widget stays hidden and we stop polling entirely. The
// widget is themed purely via CSS vars (see .topbar-battery), so it
// follows every palette. Battery % moves slowly → 30s cadence, gated
// on document.hidden like the other HUD polls.
const batteryWidgetEl = document.querySelector('#battery-widget');
const batteryFillEl   = document.querySelector('#battery-fill');
const batteryBoltEl   = document.querySelector('#battery-bolt');
const batteryPctEl    = document.querySelector('#battery-pct');
let _batteryTimer = null;

async function refreshBattery() {
  if (!window.dash?.batteryInfo || !batteryWidgetEl) return;
  let b;
  try { b = await window.dash.batteryInfo(); } catch { return; }
  if (!b?.hasBattery) {
    // Desktop — no battery. Hide the widget and stop polling for good.
    batteryWidgetEl.hidden = true;
    if (_batteryTimer) { clearInterval(_batteryTimer); _batteryTimer = null; }
    return;
  }
  batteryWidgetEl.hidden = false;
  const pct = b.percent;
  if (batteryFillEl) {
    batteryFillEl.style.width = pct + '%';
    // Amber/red only while discharging — a charging battery stays accent.
    batteryFillEl.classList.toggle('crit', pct <= 15 && !b.isCharging);
    batteryFillEl.classList.toggle('low',  pct > 15 && pct <= 30 && !b.isCharging);
  }
  if (batteryBoltEl) batteryBoltEl.hidden = !b.isCharging;
  if (batteryPctEl)  batteryPctEl.textContent = pct + '%';
  const state = b.isCharging ? 'Charging'
              : b.acConnected ? 'Plugged in'
              : 'On battery';
  const tr = b.timeRemaining
    ? ` · ${Math.floor(b.timeRemaining / 60)}h ${String(b.timeRemaining % 60).padStart(2, '0')}m left`
    : '';
  batteryWidgetEl.title = `Battery ${pct}% · ${state}${tr}`;
}
_batteryTimer = setInterval(() => { if (!document.hidden) refreshBattery(); }, 30_000);
refreshBattery();

// ── HUD: Storage ─────────────────────────────────────────────────────────────
// Drives render as a 3-column grid that auto-flows into as many rows as
// it needs — every drive is on screen at once, no cycling. _storageDrives
// is kept around purely as a "last known list" cache in case other code
// (footer totals etc.) wants to read it between polls.
const storageListEl      = document.querySelector('#storage-list');
const storageCountEl     = document.querySelector('#storage-count');
const storageStatusEl    = document.querySelector('#storage-status');
let _storageDrives = [];

function _renderStorageList() {
  const drives = _storageDrives;
  storageListEl.innerHTML = '';
  for (const d of drives) {
    const sized = d.total > 0;
    const usedPct = sized ? (d.used / d.total) * 100 : 0;
    const high = usedPct >= 90;
    const labelHtml = d.label ? ` <em>${escapeText(d.label)}</em>` : '';
    const valsHtml = sized
      ? `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`
      : `<span class="amber">[${(d.type || 'NETWORK').toUpperCase()}]</span>`;
    const barHtml = sized
      ? `<div class="seg-bar"><div class="seg-bar-fill seg-disk${high ? ' high' : ''}" style="width:${usedPct.toFixed(1)}%"></div></div>`
      : `<div class="seg-bar"><div class="seg-bar-fill seg-disk" style="width:0%; opacity:0.3"></div></div>`;
    const row = document.createElement('div');
    row.className = 'storage-row';
    row.innerHTML = `
      <div class="storage-row-head">
        <span class="storage-mount">&#9656; ${escapeText(d.mount)}${labelHtml}</span>
        <span class="storage-vals">${valsHtml}</span>
      </div>
      ${barHtml}
    `;
    storageListEl.appendChild(row);
  }
}

async function refreshStorage() {
  if (!window.dash) return;
  try {
    const drives = await window.dash.storageInfo();
    if (!drives?.length) {
      _storageDrives = [];
      storageListEl.innerHTML = '<div class="storage-empty">NO DRIVES DETECTED.</div>';
      storageCountEl.textContent = '0';
      storageStatusEl.textContent = 'OFFLINE';
      storageStatusEl.className = 'footer-readout red';
      return;
    }
    _storageDrives = drives;
    storageCountEl.textContent = String(drives.length).padStart(2, '0');
    // Totals across every drive — same set the list shows, since the
    // grid no longer pages.
    let totalAll = 0, usedAll = 0;
    for (const d of drives) {
      if (d.total > 0) { totalAll += d.total; usedAll += d.used; }
    }
    _renderStorageList();
    const overallPct = totalAll > 0 ? (usedAll / totalAll) * 100 : 0;
    storageStatusEl.innerHTML = `<em>OVERALL</em> <strong class="amber">${overallPct.toFixed(0)}%</strong> <em>FREE</em> <strong class="ok">${fmtBytes(totalAll - usedAll)}</strong>`;
    storageStatusEl.className = 'footer-readout';

    const storageCodeEl = document.getElementById('storage-code');
    if (storageCodeEl) {
      storageCodeEl.textContent = `${overallPct.toFixed(0)}% · ${drives.length} DRIVE${drives.length === 1 ? '' : 'S'} · ${fmtBytes(totalAll - usedAll)} FREE`;
    }

  } catch (err) {
    _storageDrives = [];
    storageListEl.innerHTML = `<div class="storage-empty">ERROR: ${err.message}</div>`;
    storageStatusEl.textContent = 'ERR';
    storageStatusEl.className = 'footer-readout red';
  }
}

refreshStorage();
setInterval(() => { if (!document.hidden) refreshStorage(); }, 30_000);

// ── HUD: Thermal ─────────────────────────────────────────────────────────────
const tempCpuEl       = document.querySelector('#temp-cpu');
const tempCpuBarEl    = document.querySelector('#temp-cpu-bar');
const tempCpuNameEl   = document.querySelector('#temp-cpu-name');
// GPU 0 (integrated) row was removed from the thermal panel — the iGPU
// reading always tracks the CPU package since it's on the same die,
// which made the row redundant.
const tempGpu1El      = document.querySelector('#temp-gpu1');
const tempGpu1BarEl   = document.querySelector('#temp-gpu1-bar');
const tempGpu1NameEl  = document.querySelector('#temp-gpu1-name');
const tempsTagEl      = document.querySelector('#temps-tag');
// Power graphs replace the inline wattage numbers — each thermal row
// now shows a POWER gauge under the temp gauge, styled the same way
// (HUD pill+badge+ticks in HUD theme, flat seg-bar fill elsewhere).
const powerCpuBarEl   = document.querySelector('#power-cpu-bar');
const powerGpu1BarEl  = document.querySelector('#power-gpu1-bar');
const powerCpuNameEl  = document.querySelector('#power-cpu-name');
const powerGpu1NameEl = document.querySelector('#power-gpu1-name');
// RAM temp row + bar — populated only when a sensor backend reports
// DIMM temps; the row stays hidden otherwise.
const tempRamRowEl    = document.querySelector('#temp-row-ram');
const tempRamEl       = document.querySelector('#temp-ram');
const tempRamBarEl    = document.querySelector('#temp-ram-bar');
const tempRamNameEl   = document.querySelector('#temp-ram-name');
const zenCpuTempEl    = document.querySelector('#zen-cpu-temp');

// Per-rail full-scale wattage for the power gauges. The bar tops out
// at the max so the rail still reads % full but the badge shows real
// watts. CPU envelope tracks modern desktop chips (~250 W absolute
// max under boost); GPU envelope covers a flagship card (~500 W).
const POWER_MAX_CPU = 250;
const POWER_MAX_GPU = 500;
function paintPowerBar(barEl, nameEl, watts, isEstimate, maxW) {
  if (!barEl) return;
  const isHud = document.documentElement.dataset.theme?.startsWith('hud');
  const parent = barEl.parentElement;
  if (!Number.isFinite(watts) || watts <= 0) {
    barEl.style.width = '0%';
    if (nameEl) { nameEl.textContent = '—'; nameEl.title = ''; }
    if (isHud && parent) _renderFixedGauge(parent, 0, 'N/A');
    return;
  }
  const pct = Math.max(0, Math.min(100, (watts / maxW) * 100));
  barEl.style.width = `${pct.toFixed(0)}%`;
  if (nameEl) {
    nameEl.textContent = isEstimate ? `~${watts.toFixed(0)} W` : `${watts.toFixed(0)} W`;
    nameEl.title = isEstimate
      ? 'Estimated from CPU load — Windows RAPL energy meter is not reporting. Switching Processor Performance Boost Mode to Aggressive restores live wattage.'
      : '';
  }
  if (isHud && parent) {
    const label = isEstimate ? `~${Math.round(watts)}W` : `${Math.round(watts)}W`;
    _renderFixedGauge(parent, pct, label);
  }
}
const thermalStatusEl = document.querySelector('#thermal-status');

const TEMP_MAX = 100; // °C — bar fill scales 0..TEMP_MAX

function paintTemp(valueEl, barEl, temp, isEstimate) {
  const isHud = document.documentElement.dataset.theme?.startsWith('hud');
  if (temp == null || !Number.isFinite(temp)) {
    valueEl.textContent = 'N/A';
    barEl.style.width = '0%';
    barEl.classList.remove('warn', 'high');
    valueEl.classList?.remove('is-estimate');
    // HUD theme — draw an empty gauge so the row doesn't go blank
    // when a sensor isn't reporting; badge reads "N/A".
    if (isHud) {
      const parent = barEl.parentElement;
      if (parent) _renderFixedGauge(parent, 0, 'N/A');
    }
    return;
  }
  // Prefix estimates with ~ so the user can tell at a glance that the
  // value is derived from load, not a real sensor reading.
  valueEl.textContent = isEstimate ? `~${Math.round(temp)}` : String(Math.round(temp));
  valueEl.classList?.toggle('is-estimate', !!isEstimate);
  const pct = Math.max(0, Math.min(100, (temp / TEMP_MAX) * 100));
  barEl.style.width = `${pct.toFixed(0)}%`;
  barEl.classList.toggle('warn', temp >= 70 && temp < 85);
  barEl.classList.toggle('high', temp >= 85);
  // HUD theme — additionally paint the canvas gauge (badge + marker
  // + tick scale) into the parent .seg-bar so thermal bars match the
  // network-style gauge look. Badge shows percent (of TEMP_MAX) so
  // every HUD gauge reads with the same "<N>%" chip language.
  if (isHud) {
    const parent = barEl.parentElement;
    if (parent) _renderFixedGauge(parent, pct, `${Math.round(pct)}%`);
  }
}

function shortGpuName(name) {
  if (!name) return '—';
  return name
    .replace(/NVIDIA |GeForce |AMD |Radeon |Intel\(R\) /gi, '')
    .trim()
    .toUpperCase()
    .slice(0, 28);
}

// GPU UTIL grid + GPU MEMORY rows (live in System panel; fed by tempsInfo)
const gpuGridEl       = document.querySelector('#gpu-grid');
const gpuMemListEl    = document.querySelector('#gpu-mem-list');
const sysGpuCountEl   = document.querySelector('#sys-gpu-count-value');
const sysGpuMemEl     = document.querySelector('#sys-gpu-mem-value');
const gpuFillEls = [];   // per-index util bar fills
const gpuPctEls  = [];   // per-index util % readout
const gpuMemRowEls = []; // per-index { row, fill, vals }

function buildGpuGrid(gpus) {
  gpuGridEl.innerHTML = '';
  gpuFillEls.length = 0;
  gpuPctEls.length = 0;
  for (let i = 0; i < gpus.length; i++) {
    const bar = document.createElement('div');
    bar.className = 'gpu-bar';
    const track = document.createElement('div');
    track.className = 'gpu-bar-track';
    const fill = document.createElement('div');
    fill.className = 'gpu-bar-fill';
    track.appendChild(fill);

    const labelRow = document.createElement('div');
    labelRow.className = 'gpu-bar-label';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'gpu-name';
    nameSpan.textContent = `GPU ${i} · ${shortGpuName(gpus[i]?.name)}`;
    const pctSpan = document.createElement('span');
    pctSpan.className = 'gpu-pct';
    pctSpan.textContent = '—';
    labelRow.appendChild(nameSpan);
    labelRow.appendChild(pctSpan);

    bar.appendChild(track);
    bar.appendChild(labelRow);
    gpuGridEl.appendChild(bar);
    gpuFillEls.push(fill);
    gpuPctEls.push(pctSpan);
  }
}

function buildGpuMemList(gpus) {
  gpuMemListEl.innerHTML = '';
  gpuMemRowEls.length = 0;
  for (let i = 0; i < gpus.length; i++) {
    const row = document.createElement('div');
    row.className = 'gpu-mem-row';
    const head = document.createElement('div');
    head.className = 'gpu-mem-head';
    const lbl = document.createElement('span');
    lbl.className = 'gpu-mem-label';
    lbl.textContent = `GPU ${i}`;
    const vals = document.createElement('span');
    vals.className = 'gpu-mem-vals';
    vals.textContent = '—';
    head.appendChild(lbl);
    head.appendChild(vals);
    const bar = document.createElement('div');
    bar.className = 'seg-bar';
    const fill = document.createElement('div');
    fill.className = 'seg-bar-fill seg-mem';
    bar.appendChild(fill);
    row.appendChild(head);
    row.appendChild(bar);
    gpuMemListEl.appendChild(row);
    gpuMemRowEls.push({ row, fill, vals });
  }
}

// Rolling-average buffer per GPU index for smoothing nvidia-smi's
// utilization.gpu. The raw value is "% of time in the past sample
// window that any kernel was executing", which on fast cards swings
// widely from snapshot to snapshot because every short compositor
// burst counts. Averaging the last 4 samples (≈20s window at 5s
// polling) gives a steadier reading that better represents sustained
// load and stops the displayed % from flicking ±10 between refreshes.
const _gpuLoadHistory = new Map();
const GPU_LOAD_SMOOTH_N = 4;

function paintGpuUtil(fill, pctEl, util, gpuIndex) {
  if (util == null || !Number.isFinite(util)) {
    fill.style.height = '0%';
    fill.classList.remove('warn', 'high');
    pctEl.textContent = 'N/A';
    _gpuLoadHistory.delete(gpuIndex);
    return;
  }
  let hist = _gpuLoadHistory.get(gpuIndex);
  if (!hist) { hist = []; _gpuLoadHistory.set(gpuIndex, hist); }
  hist.push(util);
  if (hist.length > GPU_LOAD_SMOOTH_N) hist.shift();
  const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
  const pct = Math.max(0, Math.min(100, avg));
  setMetricBar(fill, pct);
  pctEl.textContent = `${pct.toFixed(0)}%`;
  // Wire-graph push is centralised in paintGpuPanel (uses the max
  // across all GPUs) so Intel-iGPU-at-index-0-with-null-load systems
  // still report the dGPU's real load to the chart.
}

function paintGpuMem(rowEls, used, total) {
  const isHud = document.documentElement.dataset.theme?.startsWith('hud');
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    rowEls.fill.style.width = '0%';
    rowEls.fill.classList.remove('high');
    rowEls.vals.textContent = 'N/A';
    // HUD theme — even with no data, draw an empty gauge so the row
    // doesn't go blank (matches the thermal panel when a sensor
    // isn't reporting). The badge reads "N/A" instead of a number.
    if (isHud) {
      const parent = rowEls.fill.parentElement;
      if (parent) _renderFixedGauge(parent, 0, 'N/A');
    }
    return;
  }
  const pct = (used / total) * 100;
  rowEls.fill.style.width = `${pct.toFixed(0)}%`;
  rowEls.fill.classList.toggle('high', pct >= 90);
  rowEls.vals.textContent = `${fmtBytes(used)} / ${fmtBytes(total)}`;
  // HUD theme — paint the same canvas gauge as the thermal + RAM
  // bars so per-GPU memory reads with badge + marker + tick scale.
  if (isHud) {
    const parent = rowEls.fill.parentElement;
    if (parent) _renderFixedGauge(parent, pct, `${Math.round(pct)}%`);
  }
}

// Zen overlay GPU mirror — one vertical bar per GPU, parallel to CPU cores.
const zenGpuGridEl = document.querySelector('#zen-gpu-grid');
const zenGpuTempsEl = document.querySelector('#zen-gpu-temps');
const zenGpuFillEls = [];

function buildZenGpuGrid(count) {
  if (!zenGpuGridEl) return;
  if (zenGpuFillEls.length === count) return;
  zenGpuGridEl.innerHTML = '';
  zenGpuFillEls.length = 0;
  for (let i = 0; i < count; i++) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    bar.appendChild(track);
    zenGpuGridEl.appendChild(bar);
    zenGpuFillEls.push(fill);
  }
}

// ── Matte grid charts ───────────────────────────────────────────
// Under a matte-* theme the DOM .core-bar / .gpu-bar grids (CPU cores,
// memory history, GPU util) are hidden by CSS and this
// draws a flat line chart over the same container instead — the same
// treatment the network / drive sparklines and the audio visualizers
// get. Values are read straight off each fill's --bar-pct, so one
// function serves every grid. Under any non-matte theme it removes its
// canvas and is otherwise a no-op.
const _gridChartCanvas = new WeakMap(); // container → overlay canvas
function _einkHexRgb(s) {
  let h = (s || '').trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
// Value-coloured vertical gradient for e-ink line charts. Bottom (low
// values) reads washed green, mid washed yellow, top (high values)
// washed red — a colored-e-paper heat scale. Reads the live theme
// tokens so it tracks the active e-ink variant. `alpha` < 1 gives the
// faint translucent version used for the area fill under the trace.
function einkChartGradient(ctx, topY, botY, alpha) {
  const cs  = getComputedStyle(document.documentElement);
  const rgb = (name, fb) => _einkHexRgb(cs.getPropertyValue(name).trim()) || fb;
  const ok    = rgb('--ok',    [86, 113, 75]);
  const amber = rgb('--amber', [188, 164, 78]);
  const red   = rgb('--red',   [143, 78, 68]);
  const a   = alpha == null ? 1 : alpha;
  const css = (c) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const grad = ctx.createLinearGradient(0, topY, 0, botY);
  // Biased so red occupies the upper band and green only the lower
  // quarter — otherwise an idle system (all low values) never shows any
  // red at all. Roughly: >65% reads red, 30–65% yellow, <30% green.
  grad.addColorStop(0,    css(red));    // top of plot = high value
  grad.addColorStop(0.35, css(red));
  grad.addColorStop(0.62, css(amber));
  grad.addColorStop(1,    css(ok));     // bottom of plot = low value
  return grad;
}
function renderGridLine(container) {
  if (!container) return;
  const eink = (document.documentElement.getAttribute('data-theme') || '').startsWith('matte');
  let canvas = _gridChartCanvas.get(container);
  if (canvas && !canvas.isConnected) canvas = null; // wiped by an innerHTML rebuild
  if (!eink) {
    if (canvas) { canvas.remove(); _gridChartCanvas.delete(container); }
    return;
  }
  let values = [...container.querySelectorAll('.core-bar-fill, .gpu-bar-fill')]
    .map((f) => parseFloat(f.style.getPropertyValue('--bar-pct')) || 0);
  if (values.length === 0) return;
  if (values.length === 1) values = [values[0], values[0]]; // single bar → flat line
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'grid-line-canvas';
    container.appendChild(canvas);
    _gridChartCanvas.set(container, canvas);
  }
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(0, container.clientWidth);
  const h = Math.max(0, container.clientHeight);
  if (w <= 0 || h <= 0) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const rgb = _einkHexRgb(getComputedStyle(container).getPropertyValue('--accent')) || [180, 184, 188];
  const [r, g, b] = rgb;
  const frame = drawEinkChartFrame(ctx, w, h, rgb, [
    { frac: 0,   text: '0'   },
    { frac: 0.5, text: '50'  },
    { frac: 1,   text: '100' },
  ]);
  const n = values.length;
  const baseY = frame.py + frame.ph;
  const xOf = (i) => frame.px + (n > 1 ? (i / (n - 1)) * frame.pw : 0);
  const yOf = (v) => frame.py + frame.ph * (1 - Math.min(100, Math.max(0, v)) / 100);
  // Faint solid fill under the trace — green→yellow→red by height.
  ctx.beginPath();
  ctx.moveTo(xOf(0), baseY);
  for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(values[i]));
  ctx.lineTo(xOf(n - 1), baseY);
  ctx.closePath();
  ctx.fillStyle = einkChartGradient(ctx, frame.py, baseY, 0.16);
  ctx.fill();
  // The trace — the value gradient colours each point by its level.
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xOf(i); const y = yOf(values[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = einkChartGradient(ctx, frame.py, baseY, 1);
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}
// Slow shared sweep — the grids update every ~2s and their values live
// in the DOM, so a 500ms repaint keeps every chart current and picks up
// theme switches (into and out of e-ink) without hooking each grid's
// own paint path.
setInterval(() => {
  if (document.hidden) return;
  for (const el of [coreGridEl, memHistGridEl, gpuGridEl,
                    zenCoreGridEl, zenMemGridEl, zenGpuGridEl]) {
    renderGridLine(el);
  }
}, 500);

function paintGpuPanel(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  if (gpuFillEls.length !== list.length) buildGpuGrid(list);
  if (gpuMemRowEls.length !== list.length) buildGpuMemList(list);
  buildZenGpuGrid(list.length);

  let totalUsed = 0, totalCap = 0;
  let maxLoad = null;  // for the TASKS-pane wire-graph
  const tempBits = [];
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    paintGpuUtil(gpuFillEls[i], gpuPctEls[i], g?.load, i);
    paintGpuMem(gpuMemRowEls[i], g?.memUsed, g?.memTotal);
    if (zenGpuFillEls[i]) {
      const util = Math.max(0, Math.min(100, Number.isFinite(g?.load) ? g.load : 0));
      setMetricBar(zenGpuFillEls[i], util);
    }
    if (Number.isFinite(g?.temp)) tempBits.push(`G${i} ${Math.round(g.temp)}°`);
    if (Number.isFinite(g?.memUsed))  totalUsed += g.memUsed;
    if (Number.isFinite(g?.memTotal)) totalCap  += g.memTotal;
    // Track the busiest GPU's load — on Intel-iGPU + NVIDIA-dGPU
    // setups the iGPU at index 0 often reports null, so we can't
    // rely on a fixed index. Max across the list captures whichever
    // card is actually doing work.
    if (Number.isFinite(g?.load) && (maxLoad == null || g.load > maxLoad)) {
      maxLoad = g.load;
    }
  }
  // Feed the wire-graph once per refresh with the busiest GPU's load.
  // Push 0 if no GPU reported a valid load — keeps the line alive at
  // the floor instead of going flat-missing on iGPU-only systems with
  // no telemetry.
  pushTasksGpuHist(maxLoad == null ? 0 : maxLoad);
  if (zenGpuTempsEl) {
    zenGpuTempsEl.textContent = tempBits.length ? tempBits.join(' · ') : '—';
  }

  if (sysGpuCountEl) {
    sysGpuCountEl.textContent = list.length ? `${list.length} GPU${list.length === 1 ? '' : 'S'}` : 'NONE';
  }
  if (sysGpuMemEl) {
    sysGpuMemEl.textContent = totalCap > 0 ? `${fmtBytes(totalUsed)} / ${fmtBytes(totalCap)}` : 'N/A';
  }
  // Live header summary — average GPU load + count.
  const gpuCodeEl = document.getElementById('gpu-code');
  if (gpuCodeEl) {
    if (!list.length) {
      gpuCodeEl.textContent = 'NONE';
    } else {
      const loads = list.map((g) => Number.isFinite(g?.load) ? g.load : null).filter((v) => v != null);
      const avgLoad = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : null;
      const memBit  = totalCap > 0 ? ` · ${fmtBytes(totalUsed)} / ${fmtBytes(totalCap)}` : '';
      gpuCodeEl.textContent = `${avgLoad != null ? `${avgLoad.toFixed(0)}%` : '—%'} · ${list.length} GPU${list.length === 1 ? '' : 'S'}${memBit}`;
    }
  }
}

async function refreshTemps() {
  if (!window.dash?.tempsInfo) return;
  try {
    const t = await window.dash.tempsInfo();
    paintGpuPanel(t.gpus);
    // LHM (when running) gives us accurate sensor data via its kernel
    // driver. Prefer it over systeminformation / WMI / RAPL, all of
    // which have known failure modes on Windows (negative temps from
    // load-based fallbacks, stuck ACPI zones, RAPL silenced after
    // Turbo Boost is disabled, etc.). The fans IIFE writes the latest
    // snapshot to window._lhmSnapshot on every poll.
    const lhm = window._lhmSnapshot;
    let lhmCpuTemp = null;
    if (lhm?.temps?.length) {
      // Prefer "CPU Package" by name (the on-die thermal sensor),
      // then any CPU-prefixed sensor, then any temp on a CPU device.
      lhmCpuTemp =
        lhm.temps.find((s) => /package/i.test(s.name)) ||
        lhm.temps.find((s) => /^cpu/i.test(s.name)) ||
        lhm.temps.find((s) => /(intel|amd|ryzen|core i)/i.test(s.device));
    }
    let displayTemp;
    let isTempEst = false;
    let lhmCpuActive = false;
    if (lhmCpuTemp && Number.isFinite(lhmCpuTemp.value)) {
      displayTemp = lhmCpuTemp.value;
      lhmCpuActive = true;
      window._acpiTempHistory = [];
    } else {
      // Detect ACPI thermal-zone "stuck reading" — many Intel desktop
      // BIOSes implement MSAcpi_ThermalZoneTemperature as a literal
      // constant (the chip's TjMax minus an arbitrary delta, or just
      // a hardcoded value) instead of an actual sensor query. Symptom:
      // the number never moves regardless of CPU activity. We keep a
      // short history of recent ACPI readings; if the last 4 are all
      // identical we assume the sensor is broken and switch to a
      // CPU-load-derived estimate.
      displayTemp = t.cpu;
      const isAcpiSource = Array.isArray(t.sources) && t.sources.includes('acpi:cpu');
      if (isAcpiSource && Number.isFinite(t.cpu)) {
        window._acpiTempHistory = window._acpiTempHistory || [];
        window._acpiTempHistory.push(t.cpu);
        if (window._acpiTempHistory.length > 4) window._acpiTempHistory.shift();
        const stuck = window._acpiTempHistory.length >= 4 &&
          window._acpiTempHistory.every((v) => v === window._acpiTempHistory[0]);
        if (stuck) {
          // Generic Intel-desktop curve: ~30°C idle, ~65°C at full load
          // with Turbo Boost disabled. Clamped so a NaN or negative
          // load fraction can't produce a negative temperature.
          const load = Math.max(0, Math.min(1, Number(window._lastCpuLoadFrac) || 0));
          displayTemp = 30 + load * 35;
          isTempEst = true;
        }
      } else {
        window._acpiTempHistory = [];
      }
    }
    paintTemp(tempCpuEl, tempCpuBarEl, displayTemp, isTempEst);
    // Estimate CPU watts when Windows RAPL is offline. Common cause:
    // Turbo Boost disabled in the power plan (Windows stops driving
    // EnergyEstimation when boost is off). We derive an approximate
    // wattage from the latest CPU load fraction using a generic curve:
    //   idle ≈ 20 W, full load ≈ 125 W (matches a boost-disabled 13900KS;
    //   for boost-enabled high-end CPUs the real number can run hotter
    //   but the estimate stays in the right ballpark for the dashboard).
    let displayPower = t.cpuPower;
    let isPowerEst = false;
    if (!Number.isFinite(t.cpuPower) || t.cpuPower <= 0) {
      const load = Number.isFinite(window._lastCpuLoadFrac) ? window._lastCpuLoadFrac : 0;
      displayPower = 20 + Math.min(1, Math.max(0, load)) * 105;
      isPowerEst = true;
    }
    paintPowerBar(powerCpuBarEl, powerCpuNameEl, displayPower, isPowerEst, POWER_MAX_CPU);
    if (zenCpuTempEl) zenCpuTempEl.textContent = Number.isFinite(t.cpu) ? `${Math.round(t.cpu)}` : '—';
    // Honest source label — reflects what probe actually succeeded
    // rather than always claiming "ACPI/SMBUS". systeminformation's
    // si.cpuTemperature() reads Intel's DTS (per-core on-die sensor)
    // where available; the native fallback reads ACPI thermal zones
    // (motherboard-level, typically 5-10°C cooler than DTS for the
    // same chip). Showing the right label means the gap between this
    // dashboard's value and a tool reading DTS isn't mysterious.
    const sourceLabel = (() => {
      if (lhmCpuActive) return 'LHM · CPU';
      if (t.cpu == null) return 'NEEDS LHM/OHM';
      if (isTempEst) return 'EST CPU';
      const srcs = Array.isArray(t.sources) ? t.sources : [];
      if (srcs.includes('si:cpu'))   return 'INTEL DTS';
      if (srcs.includes('acpi:cpu')) return 'ACPI ZONE';
      return 'CPU SENSOR';
    })();
    tempCpuNameEl.textContent = sourceLabel;
    if (tempCpuNameEl) {
      let title = '';
      if (t.cpu == null) {
        title = 'CPU package temperature is not exposed by Windows. Install LibreHardwareMonitor or OpenHardwareMonitor and run it (admin) — this app reads its WMI namespace automatically.';
      } else if (isTempEst) {
        title = 'Estimated from CPU load — the motherboard ACPI thermal zone was returning a constant value (a common BIOS bug on Intel desktops). For exact temperatures, install LibreHardwareMonitor / OpenHardwareMonitor / HWiNFO and run it as admin.';
      } else if (sourceLabel === 'ACPI ZONE') {
        title = 'Reading from the motherboard ACPI thermal zone — typically 5–10°C cooler than the per-core Intel DTS that tools like HWiNFO show. Both are valid; they\'re different physical sensors on the chip.';
      }
      tempCpuNameEl.title = title;
    }

    // LHM-sourced GPU temp lookup. LHM groups sensors under a device
    // name like "NVIDIA GeForce RTX 4090" / "Intel UHD Graphics" /
    // "AMD Radeon …". For each si-reported GPU we look up a matching
    // LHM temp sensor and prefer that reading.
    function pickLhmGpuTemp(siName) {
      if (!lhm?.temps?.length || !siName) return null;
      const n = String(siName).toLowerCase();
      const isNv     = /nvidia|geforce|gtx|rtx/.test(n);
      const isAmdGpu = /amd|radeon|rx\s?\d/.test(n);
      const isIntel  = /intel|uhd|iris|arc/.test(n);
      return lhm.temps.find((s) => {
        const d = String(s.device || '').toLowerCase();
        if (isNv     && /nvidia|geforce|gtx|rtx/.test(d)) return true;
        if (isAmdGpu && /amd|radeon|rx\s?\d/.test(d))     return true;
        if (isIntel  && /intel|uhd|iris|arc/.test(d))     return true;
        return false;
      }) || null;
    }

    const g1 = t.gpus?.[1];
    const g1LhmTemp = pickLhmGpuTemp(g1?.name);
    paintTemp(tempGpu1El, tempGpu1BarEl, g1LhmTemp ? g1LhmTemp.value : g1?.temp);
    paintPowerBar(powerGpu1BarEl, powerGpu1NameEl, g1?.power, false, POWER_MAX_GPU);

    // RAM temperature — only shown when a sensor backend (LHM/HWiNFO)
    // reports DIMM temps. Search lhm.temps for memory/dram/dimm
    // sensors; show the hottest reading. Row stays hidden otherwise.
    if (tempRamRowEl) {
      const ramSensor = lhm?.temps?.find?.((s) => /memory|dram|dimm/i.test(s.name) || /memory|dram|dimm/i.test(s.device));
      if (ramSensor && Number.isFinite(ramSensor.value)) {
        tempRamRowEl.removeAttribute('hidden');
        paintTemp(tempRamEl, tempRamBarEl, ramSensor.value);
        if (tempRamNameEl) tempRamNameEl.textContent = (ramSensor.device || 'LHM · RAM').toUpperCase().slice(0, 24);
      } else {
        tempRamRowEl.setAttribute('hidden', '');
      }
    }
    tempGpu1NameEl.textContent = g1 ? shortGpuName(g1.name) : 'NONE';

    const sources = [];
    if (t.cpu != null) sources.push('CPU');
    if (g0?.temp != null) sources.push('GPU0');
    if (g1?.temp != null) sources.push('GPU1');
    tempsTagEl.textContent = String(sources.length).padStart(2, '0');
    if (!sources.length) {
      thermalStatusEl.innerHTML = '<em>SENSOR</em> <strong class="amber">OFFLINE</strong> <em>HINT</em> <strong>RUN LHM</strong>';
      thermalStatusEl.className = 'footer-readout';
    } else {
      thermalStatusEl.innerHTML = `<em>SOURCES</em> <strong class="ok">${sources.join(' · ')}</strong>`;
      thermalStatusEl.className = 'footer-readout';
    }

    const thermalCodeEl = document.getElementById('thermal-code');
    if (thermalCodeEl) {
      const gpu0 = t.gpus?.[0];
      const gpu1 = t.gpus?.[1];
      const bits = [];
      if (Number.isFinite(displayTemp))   bits.push(`CPU ${Math.round(displayTemp)}°`);
      if (Number.isFinite(gpu0?.temp))    bits.push(`GPU ${Math.round(gpu0.temp)}°`);
      if (Number.isFinite(gpu1?.temp))    bits.push(`GPU2 ${Math.round(gpu1.temp)}°`);
      thermalCodeEl.textContent = bits.length ? bits.join(' · ') : 'OFFLINE';
    }
  } catch (err) {
    thermalStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    thermalStatusEl.className = 'footer-readout red';
  }
}

// Temps / GPU tick. Chained setTimeout at PANEL_REFRESH_MS — matches
// net/disk/system, so the wire-graph GPU line ticks at the same
// cadence as the CPU line. Safe to poll fast because the main-process
// getTempsInfoCached wrapper rate-limits the actual nvidia-smi +
// si.graphics() work to ~1 underlying refresh per 1.5 s regardless
// of how many renderer-side calls arrive in between.
async function _tempsLoop() {
  if (!document.hidden) await refreshTemps();
  setTimeout(_tempsLoop, PANEL_REFRESH_MS);
}
_tempsLoop();

// ── HUD: Network ─────────────────────────────────────────────────────────────
const netRxEl       = document.querySelector('#net-rx');
const netRxUnitEl   = document.querySelector('#net-rx-unit');
const netTxEl       = document.querySelector('#net-tx');
const netTxUnitEl   = document.querySelector('#net-tx-unit');
const netRxTotalEl  = document.querySelector('#net-rx-total');
const netTxTotalEl  = document.querySelector('#net-tx-total');
const netIfaceEl    = document.querySelector('#net-iface');
const netIfaceTagEl = document.querySelector('#net-iface-tag');
const netStatusEl   = document.querySelector('#net-status');
const netRxSparkEl  = document.querySelector('#net-rx-spark');
const netTxSparkEl  = document.querySelector('#net-tx-spark');
const zenNetRxSparkEl = document.querySelector('#zen-net-rx-spark');
const zenNetTxSparkEl = document.querySelector('#zen-net-tx-spark');
const zenNetRxRateEl  = document.querySelector('#zen-net-rx-rate');
const zenNetTxRateEl  = document.querySelector('#zen-net-tx-rate');

const SPARK_SAMPLES = 96;
const rxBuf = new Array(SPARK_SAMPLES).fill(0);
const txBuf = new Array(SPARK_SAMPLES).fill(0);

function fmtRate(bytesPerSec) {
  const u = ['B/S', 'KB/S', 'MB/S', 'GB/S'];
  let i = 0; let v = bytesPerSec;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const num = v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
  return { num, unit: u[i] };
}

function pushSpark(buf, val) {
  buf.push(val);
  if (buf.length > SPARK_SAMPLES) buf.shift();
}

// ── Tasks pane wire-graph history ───────────────────────────────────
// Rolling buffers of CPU + GPU + RAM utilisation feeding the line
// chart in the TASKS pane. Kept renderer-side (no extra IPC) — we
// snoop on values already being computed by refreshSystem (CPU/RAM)
// and paintGpuUtil (GPU). Length intentionally short — too long and
// the lines compress into a flat smear at higher Hz settings.
const TASKS_HIST_LEN = 180;
const _tasksCpuHist = [];
const _tasksGpuHist = [];
const _tasksRamHist = [];
let   _tasksGraphRafPending = false;
function _scheduleTasksGraphDraw() {
  if (_tasksGraphRafPending) return;
  // Only draw when the user is looking at the tasks tab — the rest
  // of the time we just accumulate samples in the buffers.
  if (typeof comboPanel !== 'undefined' && comboPanel?.dataset.mode !== 'tasks') return;
  _tasksGraphRafPending = true;
  requestAnimationFrame(() => {
    _tasksGraphRafPending = false;
    drawTasksGraph();
  });
}
function pushTasksCpuHist(loadFrac) {
  // loadFrac is 0..1; store as percent for direct plot mapping.
  _tasksCpuHist.push(Math.max(0, Math.min(100, (loadFrac || 0) * 100)));
  if (_tasksCpuHist.length > TASKS_HIST_LEN) _tasksCpuHist.shift();
  _scheduleTasksGraphDraw();
}
function pushTasksGpuHist(utilPct) {
  // utilPct is already 0..100.
  _tasksGpuHist.push(Math.max(0, Math.min(100, utilPct || 0)));
  if (_tasksGpuHist.length > TASKS_HIST_LEN) _tasksGpuHist.shift();
  _scheduleTasksGraphDraw();
}
function pushTasksRamHist(pct) {
  // pct is 0..100 (system RAM usage).
  _tasksRamHist.push(Math.max(0, Math.min(100, pct || 0)));
  if (_tasksRamHist.length > TASKS_HIST_LEN) _tasksRamHist.shift();
  _scheduleTasksGraphDraw();
}
let _tasksGraphRO = null;
function drawTasksGraph() {
  const canvas = document.getElementById('tasks-graph-canvas');
  if (!canvas) return;
  // First call: attach a ResizeObserver so the chart re-paints any
  // time the canvas changes size — covers the case where the tasks
  // pane is hidden → visible transition lays it out asynchronously
  // and the initial requestAnimationFrame draw lands while rect is
  // still 0×0. Without this the chart often stays blank on first
  // open until a sample arrives that triggers a redraw.
  if (!_tasksGraphRO && typeof ResizeObserver !== 'undefined') {
    _tasksGraphRO = new ResizeObserver(() => {
      if (typeof comboPanel !== 'undefined' && comboPanel?.dataset.mode !== 'tasks') return;
      _scheduleTasksGraphDraw();
    });
    _tasksGraphRO.observe(canvas);
  }
  // Size the backing buffer to the layout box × DPR so lines stay
  // crisp at any zoom level. If the canvas is still 0×0 (pane not
  // yet laid out) bail — the ResizeObserver above will fire us back
  // when it gets size.
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const wantW = Math.round(rect.width * dpr);
  const wantH = Math.round(rect.height * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW; canvas.height = wantH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);
  // Pull theme colours fresh so the chart re-tints on theme switch
  // without restart. RAM uses a fixed white-with-alpha rather than a
  // theme var because every theme already paints CPU + GPU lines and
  // we need a third hue that contrasts on all of them.
  const cs = getComputedStyle(canvas);
  const accent = cs.getPropertyValue('--accent').trim() || '#5fa';
  const amber  = cs.getPropertyValue('--amber').trim()  || '#ffaa00';
  const ramCol = 'rgba(255, 255, 255, 0.7)';
  const rule   = cs.getPropertyValue('--rule-dim').trim() || 'rgba(255,255,255,0.12)';
  // Grid: faint horizontal rules at 25/50/75/100% to read amplitude.
  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const frac of [0.25, 0.5, 0.75]) {
    const y = Math.round(H * (1 - frac)) + 0.5;
    ctx.moveTo(0, y); ctx.lineTo(W, y);
  }
  ctx.stroke();
  // Plot a single buffer as a polyline. We render against the full
  // TASKS_HIST_LEN so newer samples land at the right edge regardless
  // of how full the buffer is — the line grows left-to-right as data
  // accumulates instead of stretching across the whole width with N=2.
  const plot = (buf, colour, glow) => {
    if (!buf.length) return;
    const n = buf.length;
    const start = TASKS_HIST_LEN - n; // pad the left
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    if (glow) { ctx.shadowColor = colour; ctx.shadowBlur = 6; }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = ((start + i) / (TASKS_HIST_LEN - 1)) * W;
      const y = H * (1 - buf[i] / 100);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  };
  // Draw order (back-to-front): RAM (usually high, would obscure others
  // if on top) → GPU → CPU. CPU + GPU are the most-watched lines so
  // they sit foreground.
  plot(_tasksRamHist, ramCol, false);
  plot(_tasksGpuHist, amber,  true);
  plot(_tasksCpuHist, accent, true);
}

// Bar-grid sparkline renderer: builds N skinny bars on first call, then on
// each call re-heights them from the samples buffer and updates a floating
// peak marker per bar (snap up, hold, then slow decay).
const _sparkState = new WeakMap(); // container → { peaks: Float32Array, hold: Int32Array, fills: HTMLElement[], peakEls: HTMLElement[], ro: ResizeObserver }
// Tuned for 1 Hz spark updates (network) / 0.5 Hz (disk). HOLD=2 frames = 1–2 s
// hover; DECAY=20 means the peak loses 20 percentage points per update, so
// it visibly falls toward the current bar over a few seconds. CSS transition
// on .spark-bar-peak smooths the fall between the discrete updates.
const SPARK_PEAK_HOLD_FRAMES = 2;
const SPARK_PEAK_DECAY = 20;

// Bar count derived from container width: ~4 px per bar (3 px bar + 1 px gap)
// keeps a dense, readable spectrum that grows with the panel. Clamped so a
// hidden / collapsed container doesn't render zero bars.
// 8 px per bar — doubled from the prior 4 to make individual ticks
// easier to read in the Network / Drive I/O strips. On a typical ~500 px
// strip that produces ~60 bars (was ~115). Combined with the new
// segmented-LED rendering this reads as a chunky meter rather than a
// pixel-dense sparkline.
const SPARK_BAR_PX = 8;
function targetSparkBarCount(container, sampleCap) {
  const w = container.clientWidth || (sampleCap * SPARK_BAR_PX);
  return Math.max(8, Math.min(sampleCap, Math.floor(w / SPARK_BAR_PX)));
}
// Take the most recent N values from the rolling buffer — the spark visually
// scrolls right→left, so showing the tail is correct regardless of buffer size.
function tailSamples(buf, n) {
  return buf.length > n ? buf.slice(-n) : buf;
}

// Sparkline renderer is canvas-backed for the same reason audio bars are:
// per-bar DOM (one fill div + one peak div per bar, ×~96 bars × 5 panels)
// trashes flex layout on every refresh. A single <canvas> per spark draws
// the same picture in one GPU-composited pass.
function _sparkSizeCanvas(st, container) {
  if (!st.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(0, container.clientWidth);
  const h = Math.max(0, container.clientHeight);
  st.canvas.width  = Math.round(w * dpr);
  st.canvas.height = Math.round(h * dpr);
  st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  st.grad = null; // height changed → rebuild gradient on next draw
}
// E-Ink chart frame — draws a left Y-axis with scale labels, a dashed
// bottom X-axis and faint horizontal gridlines, then returns the inner
// plot rect { px, py, pw, ph } the caller draws its trace into. `rgb`
// is the ink colour triple; `yLabels` is [{ frac, text }] measured from
// the bottom (frac 0 = bottom edge, 1 = top). Pass empty `text` for a
// gridline with no label. Labels + their left margin collapse on
// canvases too small to print them legibly.
function drawEinkChartFrame(ctx, w, h, rgb, yLabels) {
  const [r, g, b] = rgb;
  const axisCol  = `rgba(${r},${g},${b},0.55)`;
  const gridCol  = `rgba(${r},${g},${b},0.16)`;
  const labelCol = `rgba(${r},${g},${b},0.70)`;
  const hasText  = !!(yLabels && yLabels.some((l) => l.text));
  const showLabels = hasText && w >= 120 && h >= 46;
  const fs = Math.max(7, Math.min(10, Math.floor(h / 9)));
  const mL = showLabels ? Math.round(fs * 2.4) + 7 : 1;
  const mT = 3, mB = 3, mR = 2;
  const px = mL, py = mT;
  const pw = Math.max(1, w - mL - mR);
  const ph = Math.max(1, h - mT - mB);
  const baseY = py + ph;
  // Gridlines + scale labels.
  if (yLabels && yLabels.length) {
    ctx.font = `${fs}px 'Share Tech Mono', monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const yl of yLabels) {
      const gy = baseY - yl.frac * ph;
      if (yl.frac > 0.01) {            // frac 0 is the X-axis itself
        ctx.strokeStyle = gridCol;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(px, Math.round(gy) + 0.5);
        ctx.lineTo(px + pw, Math.round(gy) + 0.5);
        ctx.stroke();
      }
      if (showLabels && yl.text) {
        ctx.fillStyle = labelCol;
        ctx.fillText(yl.text, mL - 5, Math.min(h - fs / 2, Math.max(fs / 2, gy)));
      }
    }
  }
  // Left Y-axis (solid) + bottom X-axis (dashed, like graph paper).
  ctx.strokeStyle = axisCol;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(px + 0.5, py);
  ctx.lineTo(px + 0.5, baseY);
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(px, baseY + 0.5);
  ctx.lineTo(px + pw, baseY + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  return { px, py, pw, ph };
}
// Exposed for feature modules in their own chunks (music.js) so their
// e-ink visualizers can draw the same axis-framed line chart.
window.drawEinkChartFrame = drawEinkChartFrame;

// HUD-mode spark renderer — replaces the bar-grid with a horizontal
// pill gauge: segmented LED fill up to the current value, a vertical
// white marker line, a small red-outlined badge above the marker
// with the value, and a tick scale (10/20/.../100) along the bottom.
// For sparklines the value is "current sample / recent max %" so the
// gauge stays meaningful without a fixed scale; for thermal /
// other fixed-range bars there's a sibling _renderFixedGauge.
function _renderSparkGauge(container, samples) {
  if (!samples?.length) return;
  const max = Math.max(1, ...samples);
  const cur = samples[samples.length - 1] || 0;
  const pct = Math.max(0, Math.min(100, (cur / max) * 100));
  _renderHudGauge(container, pct, `${Math.round(pct)}%`);
}

// Fixed-scale gauge (temp, power) — caller passes the already-
// computed percentage and the display string (e.g. "32°"). Same
// canvas / state cache as the spark gauges so swapping themes
// doesn't leak DOM nodes.
function _renderFixedGauge(container, pct, displayText) {
  _renderHudGauge(container, pct, displayText);
}

function _renderHudGauge(container, pct, displayText) {
  if (!container) return;
  let st = _sparkState.get(container);
  if (!st) {
    // Don't wipe the container — caller may have child elements
    // (e.g. .seg-bar-fill) that need to stay in the DOM so other
    // code paths (parentElement lookups, transition listeners) still
    // work. Just add a canvas as a sibling and let CSS hide whatever
    // shouldn't paint.
    let canvas = container.querySelector(':scope > .spark-bars-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'spark-bars-canvas';
      container.appendChild(canvas);
    }
    st = { canvas, ctx: canvas.getContext('2d'), ro: null };
    _sparkState.set(container, st);
    _sparkSizeCanvas(st, container);
    if (typeof ResizeObserver !== 'undefined') {
      st.ro = new ResizeObserver(() => _sparkSizeCanvas(st, container));
      st.ro.observe(container);
    }
  }
  const ctx = st.ctx;
  const dpr = window.devicePixelRatio || 1;
  const W = st.canvas.width  / dpr;
  const H = st.canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  if (W <= 8 || H <= 8) return;

  // Pull theme colors from CSS vars so the gauge re-tints with the
  // active HUD variant. Lit LEDs use --amber (the variant's LED
  // colour, distinct from --accent which is the chrome). spark-bars
  // containers override --spark-color when they want a different
  // tint (e.g. TX uplink); falls back to --amber, then a default.
  const cs = getComputedStyle(container);
  const sparkColor = cs.getPropertyValue('--spark-color').trim()
                  || cs.getPropertyValue('--amber').trim()
                  || '#5fe6c0';
  const redColor   = cs.getPropertyValue('--red').trim() || '#ff3b3b';
  // Badge fill follows the panel-bg grey so the chip blends into the
  // panel surface — the red outline + number still pop. Reading from
  // CSS keeps it in sync if the HUD palette retunes the grey later.
  const panelBg    = cs.getPropertyValue('--panel-bg').trim() || '#333333';

  // Layout: % badge on TOP, pill in the middle, tick scale below.
  // The right side reserves extra padding so the "100" tick label
  // doesn't get clipped at the panel edge.
  // Shift the gauge content left by reserving more right padding —
  // the "100" tick label has room AND the whole graph reads as
  // pushed toward the left of its container.
  // Bars start close to the canvas left edge so they read as a
  // continuation of the row label sitting to the LEFT of the spark
  // container, not as a centered chip floating in white space. The
  // right side still reserves room for the "100" tick label.
  const padLeft  = 6;
  const padRight = 28;
  // Fully fixed-pixel sizes (no H scaling) so every gauge across the
  // dashboard renders at identical dimensions regardless of how tall
  // its host container ends up — the Network sparks now match the
  // Drive I/O sparks pixel-for-pixel.
  const badgeH   = 16;
  const barH     = 18;
  const tickH    = 14;            // height reserved for the tick label baseline
  const badgeGap = 3;             // gap between badge and bar
  const tickGap  = 4;             // gap between bar and tick scale
  // Total stack height: badge + gap + bar + gap + tick label.
  const contentH = badgeH + badgeGap + barH + tickGap + tickH;
  // Vertical-center the whole composition inside the canvas so a tall
  // host container doesn't push the bar up against the top — extra
  // space gets split evenly above the badge and below the ticks.
  const yOffset  = Math.max(1, Math.floor((H - contentH) / 2));
  const badgeY   = yOffset;
  const barTop   = badgeY + badgeH + badgeGap;
  const barLeft  = padLeft;
  const barRight = W - padRight;
  const barW     = barRight - barLeft;
  const radius   = barH / 2;
  const fillEnd  = barLeft + (pct / 100) * barW;
  const tickTop  = barTop + barH + tickGap;
  const labelY   = tickTop + tickH;

  // Pill outline (track).
  ctx.lineWidth = 1;
  ctx.strokeStyle = sparkColor;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(barLeft + 0.5, barTop + 0.5, barW - 1, barH - 1, radius);
    ctx.stroke();
  } else {
    ctx.strokeRect(barLeft + 0.5, barTop + 0.5, barW - 1, barH - 1);
  }

  // Clip to the pill so the segmented LED tiles never poke past the
  // curved ends.
  ctx.save();
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(barLeft, barTop, barW, barH, radius);
    ctx.clip();
  }
  // Segmented LED tiles — each tile is 6 px wide with a 3 px gap.
  // A tile is "lit" if its centre lies left of the current fillEnd.
  // Lit tiles paint in the bright spark color; unlit tiles paint at
  // 14 % opacity so the track structure is visible end-to-end.
  // Vertical inset of 4 px top + 4 px bottom leaves a visible gap
  // between the tiles and the pill border (tile height = barH - 8).
  const tileW   = 6;
  const tileGap = 3;
  const stepX   = tileW + tileGap;
  // Vertical inset bumped from 4 → 6 so each tile sits visibly INSIDE
  // the pill outline with clear breathing room above + below. Tile
  // height = barH − (inset * 2) = 18 − 12 = 6 px.
  const tileInsetY = 6;
  for (let tx = barLeft + 2; tx + tileW <= barRight - 2; tx += stepX) {
    const centre = tx + tileW / 2;
    const lit = centre <= fillEnd;
    ctx.fillStyle = sparkColor;
    ctx.globalAlpha = lit ? 1 : 0.14;
    ctx.fillRect(tx, barTop + tileInsetY, tileW, barH - tileInsetY * 2);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Vertical marker line through the bar at the current value.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(Math.round(fillEnd), barTop - 2);
  ctx.lineTo(Math.round(fillEnd), barTop + barH + 2);
  ctx.stroke();

  // Black-fill / red-outlined-and-numbered badge ABOVE the marker.
  // Red keeps the alarm-chip association — the value chip reads
  // as the focal point against the white chrome.
  const badgeText = String(displayText ?? `${Math.round(pct)}%`);
  ctx.font = `bold 12px 'Share Tech Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const badgeW = Math.max(22, ctx.measureText(badgeText).width + 8);
  const badgeX = Math.max(badgeW / 2 + 1, Math.min(W - badgeW / 2 - 1, fillEnd));
  // Panel-bg fill so the chip blends into the surrounding grey instead
  // of punching a black hole in it. Red outline + number still pop.
  ctx.fillStyle = panelBg;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(badgeX - badgeW / 2, badgeY, badgeW, badgeH, 3);
    ctx.fill();
  } else {
    ctx.fillRect(badgeX - badgeW / 2, badgeY, badgeW, badgeH);
  }
  // Red outline
  ctx.strokeStyle = redColor;
  ctx.lineWidth = 1;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(badgeX - badgeW / 2 + 0.5, badgeY + 0.5, badgeW - 1, badgeH - 1, 3);
    ctx.stroke();
  } else {
    ctx.strokeRect(badgeX - badgeW / 2 + 0.5, badgeY + 0.5, badgeW - 1, badgeH - 1);
  }
  // Red number
  ctx.fillStyle = redColor;
  ctx.fillText(badgeText, badgeX, badgeY + badgeH / 2 + 0.5);

  // Tick scale (10..100) along the bottom — quiet color so the
  // badge stays the focal point.
  ctx.fillStyle = _withAlpha(sparkColor, 0.7);
  const tickFontSize = 10;
  ctx.font = `${tickFontSize}px 'Share Tech Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let v = 10; v <= 100; v += 10) {
    const x = barLeft + (v / 100) * barW;
    // tick mark
    ctx.fillRect(Math.round(x), barTop + barH + 2, 1, 3);
    ctx.fillText(String(v), x, labelY - tickFontSize);
  }
}
function _withAlpha(hex, a) {
  // Accept #rgb / #rrggbb. Fall back to rgba on parse fail.
  let h = (hex || '').trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return `rgba(95,230,192,${a})`;
  const r = parseInt(h.slice(0,2), 16);
  const g = parseInt(h.slice(2,4), 16);
  const b = parseInt(h.slice(4,6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function renderSpark(container, samples) {
  if (!container) return;
  // HUD theme: replace the bar-grid sparkline with a horizontal
  // pill-gauge + value marker + tick scale, matching the LED-bar
  // reference. Same _sparkState cache + canvas; just a different
  // drawing routine.
  if (document.documentElement.dataset.theme?.startsWith('hud')) {
    _renderSparkGauge(container, samples);
    return;
  }
  const targetN = targetSparkBarCount(container, samples.length);
  const view = tailSamples(samples, targetN);
  let st = _sparkState.get(container);
  if (!st) {
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.className = 'spark-bars-canvas';
    container.appendChild(canvas);
    st = {
      canvas,
      ctx: canvas.getContext('2d'),
      peaks: new Float32Array(view.length),
      hold:  new Int32Array(view.length),
      grad:  null,
      ro:    null,
    };
    _sparkState.set(container, st);
    _sparkSizeCanvas(st, container);
    if (typeof ResizeObserver !== 'undefined') {
      st.ro = new ResizeObserver(() => _sparkSizeCanvas(st, container));
      st.ro.observe(container);
    }
  }
  // Resize state arrays without losing peak history when bar count changes.
  if (st.peaks.length !== view.length) {
    const newPeaks = new Float32Array(view.length);
    const newHold  = new Int32Array(view.length);
    const copy = Math.min(st.peaks.length, view.length);
    for (let i = 0; i < copy; i++) { newPeaks[i] = st.peaks[i]; newHold[i] = st.hold[i]; }
    st.peaks = newPeaks;
    st.hold  = newHold;
  }
  const max = Math.max(1, ...view);
  // Update peak state.
  for (let i = 0; i < view.length; i++) {
    const pct = Math.min(100, (view[i] / max) * 100);
    if (pct >= st.peaks[i]) {
      st.peaks[i] = pct;
      st.hold[i] = SPARK_PEAK_HOLD_FRAMES;
    } else if (st.hold[i] > 0) {
      st.hold[i]--;
    } else {
      st.peaks[i] = Math.max(pct, st.peaks[i] - SPARK_PEAK_DECAY);
    }
  }
  // Draw.
  const ctx = st.ctx;
  const dpr = window.devicePixelRatio || 1;
  const W = st.canvas.width  / dpr;
  const H = st.canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  if (W <= 0 || H <= 0 || view.length === 0) return;
  // Resolve palette (cached per theme). Match the audio bar visualizer
  // structure: a per-segment ramp from dim→bright in the panel's spark
  // colour, plus a --red for the peak marker.
  if (st.gradTheme !== _themeVersion) {
    const cs = getComputedStyle(container);
    const sparkStr = cs.getPropertyValue('--spark-color').trim()
                  || cs.getPropertyValue('--accent').trim()
                  || '#5fa';
    const redStr   = cs.getPropertyValue('--red').trim() || '#ff3b30';
    const parseHex = (s) => {
      let h = (s || '').trim();
      if (h.startsWith('#')) h = h.slice(1);
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
      return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
    };
    st.bright = parseHex(sparkStr) || [110, 220, 180];
    st.dim    = [Math.round(st.bright[0]*0.25), Math.round(st.bright[1]*0.25), Math.round(st.bright[2]*0.25)];
    // Peak marker — accent-tinted-white (matches .core-bar-peak's
    // `color-mix(in srgb, var(--accent) 30%, white)`). Two-colour rule:
    // sparklines are bright-accent cells + bright-white-accent peak,
    // no other hues. (Was st.peakColor = redStr — that was the third
    // colour the user asked to drop.)
    st.peakColor = `rgb(${Math.round(st.bright[0]*0.3 + 255*0.7)},${Math.round(st.bright[1]*0.3 + 255*0.7)},${Math.round(st.bright[2]*0.3 + 255*0.7)})`;
    st.gradTheme = _themeVersion;
  }
  // E-Ink themes swap the segmented-LED meter for a flat line chart:
  // a continuous 1px ink stroke over a faint solid fill, no segments,
  // no glow, no peak markers — matching the still, matte e-paper look.
  if ((document.documentElement.getAttribute('data-theme') || '').startsWith('matte')) {
    const [ir, ig, ib] = st.bright;
    const ink = `rgb(${ir},${ig},${ib})`;
    const frame = drawEinkChartFrame(ctx, W, H, st.bright, [
      { frac: 0,   text: '0' },
      { frac: 0.5, text: '' },
      { frac: 1,   text: fmtRate(max).num },
    ]);
    const n = view.length;
    const baseY = frame.py + frame.ph;
    const xOf = (i) => frame.px + (n > 1 ? (i / (n - 1)) * frame.pw : 0);
    const yOf = (v) => frame.py + frame.ph * (1 - Math.min(100, (v / max) * 100) / 100);
    // Faint solid fill under the trace.
    ctx.beginPath();
    ctx.moveTo(xOf(0), baseY);
    for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(view[i]));
    ctx.lineTo(xOf(n - 1), baseY);
    ctx.closePath();
    ctx.fillStyle = einkChartGradient(ctx, frame.py, baseY, 0.16);
    ctx.fill();
    // The trace — green→yellow→red value gradient by height.
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i); const y = yOf(view[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = einkChartGradient(ctx, frame.py, baseY, 1);
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    // Dot marker on the most recent sample.
    ctx.beginPath();
    ctx.arc(xOf(n - 1), yOf(view[n - 1]), 2, 0, Math.PI * 2);
    ctx.fillStyle = einkChartGradient(ctx, frame.py, baseY, 1);
    ctx.fill();
    return;
  }
  // Segmented LED-cell layout. Each bar is a stack of small horizontal
  // "cells". Two-colour rule: every lit cell uses the solid bright
  // accent (no dim→bright per-cell ramp). Number of segments scales
  // with the strip height so narrow panels still show 6 cells minimum.
  const segments = Math.max(6, Math.min(20, Math.floor(H / 4)));
  const segPitch = H / segments;
  const cellH    = Math.max(1, segPitch * 0.55);
  const cellGapY = segPitch - cellH;
  const fillCol  = `rgb(${st.bright[0]},${st.bright[1]},${st.bright[2]})`;
  const gap = 1;
  // slotW = per-sample column width (was the old barW). The sample-
  // to-sample center distance stays at (slotW + gap), so the graph's
  // horizontal rhythm is unchanged. barW is the actual painted width
  // — 50% of the slot, centered inside it — giving thinner cubes
  // with the same cadence per user feedback ("too wide").
  const slotW = Math.max(1, (W - gap * (view.length - 1)) / view.length);
  const barW  = Math.max(1, slotW * 0.5);
  const barOffset = (slotW - barW) / 2;
  ctx.fillStyle = fillCol;
  for (let i = 0; i < view.length; i++) {
    const pct = Math.min(100, (view[i] / max) * 100);
    const cellsLit = Math.min(segments, Math.ceil((pct / 100) * segments));
    if (cellsLit <= 0) continue;
    const x = i * (slotW + gap) + barOffset;
    for (let s = 0; s < cellsLit; s++) {
      const y = H - (s + 1) * segPitch + cellGapY;
      ctx.fillRect(x, y, barW, cellH);
    }
  }
  // Peak markers — one cell-height tick sitting at the highest recent
  // value for each sample column. Same slot + offset math as the bars.
  ctx.fillStyle = st.peakColor;
  for (let i = 0; i < view.length; i++) {
    const peakPct = Math.min(100, st.peaks[i]);
    const peakSeg = Math.min(segments, Math.ceil((peakPct / 100) * segments));
    if (peakSeg <= 0) continue;
    const x = i * (slotW + gap) + barOffset;
    const y = H - peakSeg * segPitch + cellGapY;
    ctx.fillRect(x, y, barW, cellH);
  }
}

async function refreshNet() {
  if (!window.dash?.netInfo) return;
  try {
    const n = await window.dash.netInfo();
    pushSpark(rxBuf, n.rxSec || 0);
    pushSpark(txBuf, n.txSec || 0);

    const r = fmtRate(n.rxSec || 0);
    const t = fmtRate(n.txSec || 0);
    netRxEl.textContent = r.num;
    netRxUnitEl.textContent = r.unit;
    netTxEl.textContent = t.num;
    netTxUnitEl.textContent = t.unit;

    netRxTotalEl.textContent = fmtBytes(n.rxTotal || 0);
    netTxTotalEl.textContent = fmtBytes(n.txTotal || 0);
    netIfaceEl.textContent   = (n.iface || 'NONE').toUpperCase();
    netIfaceTagEl.textContent = String(n.interfaces || 0).padStart(2, '0');

    renderSpark(netRxSparkEl, rxBuf);
    renderSpark(netTxSparkEl, txBuf);

    // Mirror to zen overlay sparks (visible only while idle).
    if (zenNetRxSparkEl) renderSpark(zenNetRxSparkEl, rxBuf);
    if (zenNetTxSparkEl) renderSpark(zenNetTxSparkEl, txBuf);
    if (zenNetRxRateEl) zenNetRxRateEl.textContent = `${r.num} ${r.unit}`;
    if (zenNetTxRateEl) zenNetTxRateEl.textContent = `${t.num} ${t.unit}`;

    const total = (n.rxSec || 0) + (n.txSec || 0);
    if (total <= 0) {
      netStatusEl.innerHTML = '<em>STATE</em> <strong class="amber">IDLE</strong>';
    } else {
      netStatusEl.innerHTML = `<em>STATE</em> <strong class="ok">ACTIVE</strong> <em>RATE</em> <strong>${fmtRate(total).num} ${fmtRate(total).unit}</strong>`;
    }
    netStatusEl.className = 'footer-readout';

    const netCodeEl = document.getElementById('network-code');
    if (netCodeEl) {
      netCodeEl.textContent = `↓ ${r.num} ${r.unit} · ↑ ${t.num} ${t.unit}`;
    }
  } catch (err) {
    netStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    netStatusEl.className = 'footer-readout red';
  }
}

// First call seeds the rate baseline; chained scheduling keeps calls
// serialized (next call only schedules after this one's IPC completes,
// so a slow netInfo can't pile up overlapping calls). Fixed cadence
// PANEL_REFRESH_MS — decoupled from the audio visualizer Hz so
// throttling the audio dial doesn't slow the network readout.
async function netLoop() {
  if (!document.hidden) await refreshNet();
  setTimeout(netLoop, PANEL_REFRESH_MS);
}
netLoop();

// ── HUD: Drive I/O ───────────────────────────────────────────────────────────
const diskReadEl       = document.querySelector('#disk-read');
const diskReadUnitEl   = document.querySelector('#disk-read-unit');
const diskWriteEl      = document.querySelector('#disk-write');
const diskWriteUnitEl  = document.querySelector('#disk-write-unit');
// XFER/S + QUEUE + TARGET micro-grid was removed from the panel —
// the underlying elements no longer exist, so we drop the cached refs.
const diskQueueTagEl   = document.querySelector('#disk-queue-tag');
const diskStatusEl     = document.querySelector('#disk-status');
const diskReadSparkEl  = document.querySelector('#disk-read-spark');
const diskWriteSparkEl = document.querySelector('#disk-write-spark');

const dRBuf = new Array(SPARK_SAMPLES).fill(0);
const dWBuf = new Array(SPARK_SAMPLES).fill(0);

async function refreshDisk() {
  if (!window.dash?.diskInfo) return;
  try {
    const d = await window.dash.diskInfo();
    pushSpark(dRBuf, d.readSec  || 0);
    pushSpark(dWBuf, d.writeSec || 0);

    const r = fmtRate(d.readSec  || 0);
    const w = fmtRate(d.writeSec || 0);
    diskReadEl.textContent      = r.num;
    diskReadUnitEl.textContent  = r.unit;
    diskWriteEl.textContent     = w.num;
    diskWriteUnitEl.textContent = w.unit;

    diskQueueTagEl.textContent = Number.isFinite(d.queue) ? String(d.queue).padStart(2, '0') : '00';

    renderSpark(diskReadSparkEl,  dRBuf);
    renderSpark(diskWriteSparkEl, dWBuf);

    if (!d.supported) {
      diskStatusEl.innerHTML = '<em>STATE</em> <strong class="amber">UNSUPPORTED</strong>';
    } else {
      const total = (d.readSec || 0) + (d.writeSec || 0);
      if (total <= 0) {
        diskStatusEl.innerHTML = '<em>STATE</em> <strong class="amber">IDLE</strong>';
      } else {
        const t = fmtRate(total);
        diskStatusEl.innerHTML = `<em>STATE</em> <strong class="ok">ACTIVE</strong> <em>RATE</em> <strong>${t.num} ${t.unit}</strong>`;
      }
    }
    diskStatusEl.className = 'footer-readout';

    const driveioCodeEl = document.getElementById('driveio-code');
    if (driveioCodeEl) {
      driveioCodeEl.textContent = d.supported
        ? `R ${r.num} ${r.unit} · W ${w.num} ${w.unit}`
        : 'UNSUPPORTED';
    }
  } catch (err) {
    diskStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    diskStatusEl.className = 'footer-readout red';
  }
}

// Disk I/O polling — chained scheduling so the PowerShell call (which
// has ~500 ms cold start) can't overlap itself. Fixed PANEL_REFRESH_MS
// cadence; the chained pattern self-limits to ~2 Hz regardless because
// of the IPC cost, so this naturally caps without needing a separate
// disk-specific rate.
async function diskLoop() {
  if (!document.hidden) await refreshDisk();
  setTimeout(diskLoop, PANEL_REFRESH_MS);
}
diskLoop();

// ── HUD: Weather (Open-Meteo) ────────────────────────────────────────────────
const weatherCityEl     = document.querySelector('#weather-city');
const weatherTempEl     = document.querySelector('#weather-temp');
const weatherCondEl     = document.querySelector('#weather-cond');
const weatherIconBigEl  = document.querySelector('#weather-icon-big');
const weatherMoonEl     = document.querySelector('#weather-moon');
const weatherLocEl    = document.querySelector('#weather-loc');
const weatherDetailEl = document.querySelector('#weather-detail');
const weatherAirEl    = document.querySelector('#weather-air');
const weatherPollenEl = document.querySelector('#weather-pollen');
const weatherStatusEl = document.querySelector('#weather-status');
const weatherPidEl    = document.querySelector('#weather-pid');

// https://open-meteo.com/en/docs#weather_variable_documentation
const WEATHER_CODES = {
  0:  ['Clear', '☀'],
  1:  ['Mainly clear', '🌤'],
  2:  ['Partly cloudy', '⛅'],
  3:  ['Overcast', '☁'],
  45: ['Fog', '🌫'],
  48: ['Rime fog', '🌫'],
  51: ['Light drizzle', '🌦'],
  53: ['Drizzle', '🌦'],
  55: ['Heavy drizzle', '🌧'],
  56: ['Freezing drizzle', '🌧'],
  57: ['Heavy freezing drizzle', '🌧'],
  61: ['Light rain', '🌦'],
  63: ['Rain', '🌧'],
  65: ['Heavy rain', '🌧'],
  66: ['Freezing rain', '🌧'],
  67: ['Heavy freezing rain', '🌧'],
  71: ['Light snow', '🌨'],
  73: ['Snow', '🌨'],
  75: ['Heavy snow', '❄'],
  77: ['Snow grains', '🌨'],
  80: ['Rain showers', '🌦'],
  81: ['Heavy showers', '🌧'],
  82: ['Violent showers', '⛈'],
  85: ['Snow showers', '🌨'],
  86: ['Heavy snow showers', '❄'],
  95: ['Thunderstorm', '⛈'],
  96: ['Thunderstorm + hail', '⛈'],
  99: ['Severe thunderstorm', '⛈'],
};

function describeWeather(code) {
  return WEATHER_CODES[code] || ['Unknown', '·'];
}

// ── Theme-colored weather SVG icons ─────────────────────────────
// All icons use stroke/fill: currentColor so the parent's color (set
// to var(--accent) in CSS) propagates through. No emoji = no hardcoded
// colors. Same Open-Meteo code → glyph mapping as describeWeather,
// with the clear-sky codes (0, 1) swapping to a moon SVG at night.

const _SVG_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.6" y1="4.6" x2="6.7" y2="6.7"/><line x1="17.3" y1="17.3" x2="19.4" y2="19.4"/><line x1="4.6" y1="19.4" x2="6.7" y2="17.3"/><line x1="17.3" y1="6.7" x2="19.4" y2="4.6"/></svg>';
const _SVG_CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M7 18 a4 4 0 0 1 -0.5 -7.95 a5 5 0 0 1 9.7 -1.05 a3.5 3.5 0 0 1 1.8 7 z"/></svg>';
const _SVG_SUN_CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><circle cx="8" cy="8" r="2.6"/><line x1="8" y1="2.2" x2="8" y2="3.4"/><line x1="2.2" y1="8" x2="3.4" y2="8"/><line x1="4" y1="4" x2="4.9" y2="4.9"/><line x1="12.3" y1="4" x2="11.4" y2="4.9"/><path d="M10 19 a3.2 3.2 0 0 1 -0.4 -6.4 a4 4 0 0 1 7.7 -0.8 a3 3 0 0 1 1 5.8 z"/></svg>';
const _SVG_FOG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="7" x2="20" y2="7"/><line x1="4" y1="11" x2="21" y2="11"/><line x1="3" y1="15" x2="20" y2="15"/><line x1="5" y1="19" x2="18" y2="19"/></svg>';
const _SVG_RAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M7 14 a4 4 0 0 1 -0.5 -7.95 a5 5 0 0 1 9.7 -1.05 a3.5 3.5 0 0 1 1.8 7 z"/><line x1="8.5" y1="18" x2="7.5" y2="22"/><line x1="13" y1="18" x2="12" y2="22"/><line x1="17.5" y1="18" x2="16.5" y2="22"/></svg>';
const _SVG_DRIZZLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M7 14 a4 4 0 0 1 -0.5 -7.95 a5 5 0 0 1 9.7 -1.05 a3.5 3.5 0 0 1 1.8 7 z"/><line x1="9" y1="18.5" x2="8.5" y2="21"/><line x1="13" y1="18.5" x2="12.5" y2="21"/><line x1="17" y1="18.5" x2="16.5" y2="21"/></svg>';
const _SVG_SNOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M7 14 a4 4 0 0 1 -0.5 -7.95 a5 5 0 0 1 9.7 -1.05 a3.5 3.5 0 0 1 1.8 7 z"/><line x1="8" y1="19.5" x2="10" y2="19.5"/><line x1="9" y1="18.5" x2="9" y2="20.5"/><line x1="12.7" y1="18.7" x2="13.3" y2="20.3"/><line x1="12.7" y1="20.3" x2="13.3" y2="18.7"/><line x1="16" y1="19.5" x2="18" y2="19.5"/><line x1="17" y1="18.5" x2="17" y2="20.5"/></svg>';
const _SVG_STORM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M7 14 a4 4 0 0 1 -0.5 -7.95 a5 5 0 0 1 9.7 -1.05 a3.5 3.5 0 0 1 1.8 7 z"/><path d="M13.5 14 L9 21 L12 19.5 L10.5 23"/></svg>';

// Synodic month (lunar cycle, days). Reference new moon: 2000-01-06
// 18:14 UTC (a well-known astronomical reference).
const _MOON_SYNODIC_MS = 29.530588853 * 86400 * 1000;
const _MOON_REF_MS = Date.UTC(2000, 0, 6, 18, 14, 0);
function moonPhase(date = new Date()) {
  let diff = (date.getTime() - _MOON_REF_MS) % _MOON_SYNODIC_MS;
  if (diff < 0) diff += _MOON_SYNODIC_MS;
  return diff / _MOON_SYNODIC_MS;
}
function moonPhaseName(phase) {
  if (phase < 0.0625 || phase >= 0.9375) return 'NEW MOON';
  if (phase < 0.1875) return 'WAXING CRESCENT';
  if (phase < 0.3125) return 'FIRST QUARTER';
  if (phase < 0.4375) return 'WAXING GIBBOUS';
  if (phase < 0.5625) return 'FULL MOON';
  if (phase < 0.6875) return 'WANING GIBBOUS';
  if (phase < 0.8125) return 'LAST QUARTER';
  return 'WANING CRESCENT';
}
// Illumination fraction 0–1, peaks at 1 at full moon.
function moonIllumination(phase) {
  return (1 - Math.cos(phase * 2 * Math.PI)) / 2;
}
// SVG path for the LIT portion of the moon at a given phase. The
// terminator is approximated as an ellipse arc; its x-radius shrinks
// from r (at new) to 0 (at quarter) and back to r (at full). The
// sweep flag on the terminator flips between crescent and gibbous
// shapes, and between waxing (right-lit) and waning (left-lit).
function moonPhasePathD(phase, cx = 12, cy = 12, r = 9) {
  // New moon — nothing lit, return empty so only the outline draws.
  if (phase < 0.005 || phase > 0.995) return '';
  // Full moon — the lit portion is the entire disc.
  if (Math.abs(phase - 0.5) < 0.005) {
    return `M ${cx-r} ${cy} a ${r} ${r} 0 1 0 ${r*2} 0 a ${r} ${r} 0 1 0 ${-r*2} 0 Z`;
  }
  const waxing = phase < 0.5;                // light on right vs left
  const isGibbous = (phase > 0.25 && phase < 0.5) || (phase > 0.5 && phase < 0.75);
  const termRx = Math.abs(Math.cos(phase * 2 * Math.PI)) * r;
  const outerSweep = waxing ? 1 : 0;
  // Crescent → terminator bows toward lit side; gibbous → bows into shadow side.
  const termSweep = waxing ? (isGibbous ? 0 : 1) : (isGibbous ? 1 : 0);
  return `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${outerSweep} ${cx} ${cy + r} A ${termRx} ${r} 0 0 ${termSweep} ${cx} ${cy - r} Z`;
}
function moonSvgIcon(phase = moonPhase()) {
  const d = moonPhasePathD(phase);
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="12" cy="12" r="9"/>
    ${d ? `<path d="${d}" fill="currentColor" stroke="none"/>` : ''}
  </svg>`;
}

// Theme-colored hero icon for a weather code. Night for clear codes
// (0, 1) shows a moon at the CURRENT moon phase rather than a generic
// crescent. Cloudy nights fall through to the cloud icon since the
// moon wouldn't be visible anyway.
function weatherSvgIcon(code, isDay) {
  const isNight = isDay === 0 || isDay === false;
  if (isNight && (code === 0 || code === 1)) return moonSvgIcon(moonPhase());
  switch (code) {
    case 0: case 1: return _SVG_SUN;
    case 2: return _SVG_SUN_CLOUD;
    case 3: return _SVG_CLOUD;
    case 45: case 48: return _SVG_FOG;
    case 51: case 53: case 55: case 56: case 57: return _SVG_DRIZZLE;
    case 61: case 63: case 65: case 66: case 67: case 80: case 81: return _SVG_RAIN;
    case 71: case 73: case 75: case 77: case 85: case 86: return _SVG_SNOW;
    case 82: case 95: case 96: case 99: return _SVG_STORM;
    default: return _SVG_CLOUD;
  }
}

async function geocodeCity(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = await res.json();
  const hit = data.results?.[0];
  if (!hit) throw new Error(`Couldn't find "${name}"`);
  return hit;
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    forecast_days: '5',
    timezone: 'auto',
    wind_speed_unit: 'mph',
    temperature_unit: 'fahrenheit',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
  return await res.json();
}

// Open-Meteo CAMS air-quality endpoint — separate API from the forecast.
// AQI is global; pollen series come from the CAMS European model and are
// null outside coverage (most of North America). We render whatever's
// returned and fall back to '—' for missing fields.
async function fetchAirQuality(lat, lon) {
  const params = new URLSearchParams({
    latitude:  String(lat),
    longitude: String(lon),
    current: [
      'us_aqi', 'pm2_5', 'pm10', 'ozone', 'uv_index',
      'alder_pollen', 'birch_pollen', 'grass_pollen',
      'mugwort_pollen', 'olive_pollen', 'ragweed_pollen',
    ].join(','),
    timezone: 'auto',
  });
  const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`);
  if (!res.ok) throw new Error(`Air quality fetch failed (${res.status})`);
  return await res.json();
}

// US AQI category cutoffs (EPA): 0-50 good, 51-100 moderate, 101-150
// unhealthy for sensitive groups (USG), 151-200 unhealthy, 201-300 very
// unhealthy, 301+ hazardous. Returns null for non-numeric input.
function aqiLabel(aqi) {
  if (!Number.isFinite(aqi)) return null;
  if (aqi <= 50)  return 'GOOD';
  if (aqi <= 100) return 'MODERATE';
  if (aqi <= 150) return 'USG';
  if (aqi <= 200) return 'UNHEALTHY';
  if (aqi <= 300) return 'V. UNHEALTHY';
  return 'HAZARDOUS';
}

// Common pollen-grain thresholds (grains/m³). Vary slightly by allergen
// but these midline cuts are good enough for a single LOW/MOD/HIGH chip.
function pollenLabel(g) {
  if (!Number.isFinite(g)) return null;
  if (g < 1)   return 'NONE';
  if (g < 30)  return 'LOW';
  if (g < 100) return 'MODERATE';
  if (g < 300) return 'HIGH';
  return 'V. HIGH';
}

// Pollen.com's 0–12 index. Their own site labels:
//   0.0–2.4 LOW · 2.5–4.8 LOW-MED · 4.9–7.2 MEDIUM · 7.3–9.6 MED-HIGH · 9.7–12 HIGH
function pollenIndexLabel(idx) {
  if (!Number.isFinite(idx)) return null;
  if (idx <= 2.4) return 'LOW';
  if (idx <= 4.8) return 'LOW-MED';
  if (idx <= 7.2) return 'MEDIUM';
  if (idx <= 9.6) return 'MED-HIGH';
  return 'HIGH';
}

let activeLocation = null;
let weatherTimer = null;

function setStatus(msg, kind = '') {
  weatherStatusEl.textContent = (msg || '').toUpperCase();
  weatherStatusEl.className = `footer-readout ${kind}`;
}

function locationCode(loc) {
  // Compact 4-char ID: signed lat truncated + signed lon truncated, last 2 digits each
  const lat = Math.abs(Math.round(loc.latitude || 0)).toString().padStart(2, '0').slice(-2);
  const lon = Math.abs(Math.round(loc.longitude || 0)).toString().padStart(2, '0').slice(-2);
  return `${lat}-${lon}`;
}

const zenTempEl    = document.querySelector('#zen-temp');
const zenTempLowEl = document.querySelector('#zen-temp-low');
const zenCondEl    = document.querySelector('#zen-cond');
const zenLocEl     = document.querySelector('#zen-loc');

// Cached 5-day forecast + cycling state for zen mode.
let _forecastDaily = []; // [{ date, max, min, code }, ...]
let _forecastLocLabel = '';
let _zenForecastIdx = 0;
let _zenForecastTimer = null;
const ZEN_FORECAST_CYCLE_MS = 5000;

function paintZenForecast(idx) {
  if (!_forecastDaily.length || !zenCondEl) return;
  const d = _forecastDaily[idx % _forecastDaily.length];
  if (!d) return;
  const [text, icon] = describeWeather(d.code);
  const dayLabel = idx === 0
    ? 'TODAY'
    : (d.date instanceof Date && !isNaN(d.date)
        ? d.date.toLocaleDateString([], { weekday: 'short' }).toUpperCase()
        : '—');
  zenCondEl.textContent = `${dayLabel} · ${icon} ${text.toUpperCase()}`;
  if (zenTempEl)    zenTempEl.textContent    = Number.isFinite(d.max) ? `${Math.round(d.max)}` : '—';
  if (zenTempLowEl) zenTempLowEl.textContent = Number.isFinite(d.min) ? `${Math.round(d.min)}` : '—';
  if (zenLocEl)     zenLocEl.textContent     = _forecastLocLabel;
}

async function loadWeather(loc) {
  setStatus('UPDATING…');
  try {
    const data = await fetchWeather(loc.latitude, loc.longitude);
    const c = data.current || {};
    const [text] = describeWeather(c.weather_code);
    weatherTempEl.textContent = c.temperature_2m != null ? `${Math.round(c.temperature_2m)}` : '—';
    // Hero icon carries the visual now — condition text drops the inline
    // glyph and shows just the uppercased label.
    weatherCondEl.textContent = text.toUpperCase();
    if (weatherIconBigEl) weatherIconBigEl.innerHTML = weatherSvgIcon(c.weather_code, c.is_day);
    if (weatherMoonEl) {
      const phase = moonPhase();
      const pct = Math.round(moonIllumination(phase) * 100);
      weatherMoonEl.textContent = `${moonPhaseName(phase)} · ${pct}%`;
    }
    const region = [loc.admin1, loc.country_code || loc.country].filter(Boolean).join(' · ');
    weatherLocEl.textContent = `${loc.name}${region ? ' · ' + region : ''}`.toUpperCase();

    // Cache the 5-day forecast for the zen overlay's cycling display.
    _forecastDaily = [];
    if (data.daily?.time?.length) {
      _forecastDaily = data.daily.time.map((t, i) => ({
        date: new Date(`${t}T12:00:00`),
        max:  data.daily.temperature_2m_max?.[i],
        min:  data.daily.temperature_2m_min?.[i],
        code: data.daily.weather_code?.[i],
      }));
    }
    _forecastLocLabel = `${loc.name}${region ? ' · ' + region : ''}`.toUpperCase();
    paintZenForecast(_zenForecastIdx);
    const feels = c.apparent_temperature != null ? `FEELS ${Math.round(c.apparent_temperature)}°` : '';
    const hum   = c.relative_humidity_2m != null ? `${c.relative_humidity_2m}% RH` : '';
    const wind  = c.wind_speed_10m != null ? `${Math.round(c.wind_speed_10m)} MPH` : '';
    weatherDetailEl.textContent = [feels, hum, wind].filter(Boolean).join(' · ') || '—';
    weatherPidEl.textContent = locationCode(loc);
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    weatherStatusEl.innerHTML = `<em>SYNC</em> <strong class="ok">OK</strong> <em>UPDATED</em> <strong>${stamp}</strong>`;
    weatherStatusEl.className = 'footer-readout';

    const weatherCodeEl = document.getElementById('weather-code');
    if (weatherCodeEl) {
      const tempBit = c.temperature_2m != null ? `${Math.round(c.temperature_2m)}°` : '—°';
      weatherCodeEl.textContent = `${(loc.name || '').toUpperCase()} · ${tempBit} · ${text.toUpperCase()}`;
    }
  } catch (err) {
    setStatus(err.message, 'red');
  }

  // Air quality + pollen — fired in parallel so the main weather render
  // never waits on this endpoint. Failures fall through to '—'.
  try {
    const air = await fetchAirQuality(loc.latitude, loc.longitude);
    const a = air.current || {};

    if (weatherAirEl) {
      if (Number.isFinite(a.us_aqi)) {
        weatherAirEl.textContent = `${Math.round(a.us_aqi)} · ${aqiLabel(a.us_aqi)}`;
      } else if (Number.isFinite(a.pm2_5)) {
        // Outside US-AQI coverage the API still returns particulate
        // numbers — show PM2.5 µg/m³ as a fallback so the cell isn't dead.
        weatherAirEl.textContent = `PM2.5 ${a.pm2_5.toFixed(1)} µg/m³`;
      } else {
        weatherAirEl.textContent = '—';
      }
    }

    if (weatherPollenEl) {
      // Pollen: Pollen.com first (US ZIP → today's index + trigger
      // allergens), Open-Meteo CAMS series as Europe fallback. Pollen.com
      // call routes through the main process so we can set Referer.
      const zip = Array.isArray(loc?.postcodes) ? String(loc.postcodes[0] || '').trim() : '';
      let pollenSet = false;
      if (/^\d{5}$/.test(zip) && window.dash?.getPollen) {
        try {
          const r = await window.dash.getPollen(zip);
          const today = r?.ok && r.data?.Location?.periods?.find?.(p => p.Type === 'Today');
          if (today && Number.isFinite(today.Index)) {
            const triggers = (today.Triggers || [])
              .map(t => String(t.Name || t.Genus || '').toUpperCase().trim())
              .filter(Boolean);
            const top = triggers.slice(0, 3).join(', ');
            const label = pollenIndexLabel(today.Index);
            weatherPollenEl.textContent = top
              ? `${today.Index.toFixed(1)} ${label} · ${top}`
              : `${today.Index.toFixed(1)} · ${label}`;
            pollenSet = true;
          }
        } catch { /* fall through to Open-Meteo */ }
      }

      if (!pollenSet) {
        // Open-Meteo CAMS European pollen series. Pick the highest
        // reported allergen and chip it; null everywhere outside Europe.
        const pollenMap = {
          GRASS:   a.grass_pollen,
          BIRCH:   a.birch_pollen,
          ALDER:   a.alder_pollen,
          OLIVE:   a.olive_pollen,
          MUGWORT: a.mugwort_pollen,
          RAGWEED: a.ragweed_pollen,
        };
        let topName = null, topVal = -1;
        for (const [name, val] of Object.entries(pollenMap)) {
          if (Number.isFinite(val) && val > topVal) { topName = name; topVal = val; }
        }
        if (topName && topVal >= 0) {
          weatherPollenEl.textContent = `${topName} ${topVal.toFixed(1)} · ${pollenLabel(topVal)}`;
        } else {
          weatherPollenEl.textContent = 'N/A';
        }
      }
    }
  } catch {
    if (weatherAirEl)    weatherAirEl.textContent    = '—';
    if (weatherPollenEl) weatherPollenEl.textContent = '—';
  }
}

async function selectCity(name) {
  setStatus('LOOKING UP…');
  try {
    const hit = await geocodeCity(name);
    activeLocation = hit;
    await window.dash?.setConfig?.({ weatherCity: hit });
    setLocalClockCity(hit);
    if (weatherTimer) clearInterval(weatherTimer);
    weatherTimer = setInterval(() => loadWeather(hit), 10 * 60 * 1000);
    await loadWeather(hit);
  } catch (err) {
    setStatus(err.message, 'red');
  }
}

weatherCityEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = weatherCityEl.value.trim();
  if (v) selectCity(v);
});

// ── Audio bar-grids (mic input + system output loopback) ────────────────────
// Two distinct counts:
//   AUDIO_BAND_COUNT  — number of FFT bands the worker (loopback) and the
//                       mic sampler emit. Fixed at 24 because that's what
//                       the worker hardcodes.
//   AUDIO_BAR_COUNT_* — number of visible bars per visualizer. Bars upsample
//                       from bands via linear interpolation when count > 24.
const AUDIO_BAND_COUNT = 24;
const AUDIO_BAR_COUNT_NORMAL = 12;
// 96 was visually nice but each FFT update touched 96 × 2 (fill + peak)
// DOM properties at ~47 Hz — a real cost for the renderer to absorb on
// top of video decode in zen. 64 still reads as a dense spectrum and
// halves the per-frame DOM-update load.
const AUDIO_BAR_COUNT_ZEN    = 64;
// Multiplier applied to incoming band/level values. 1.0 in normal mode;
// lower in zen so the dense bar spectrum reads as a calm visualization
// rather than a wall of solid color.
const AUDIO_ZEN_GAIN_SCALE = 0.65;
let _audioGainScale = 1.0;
// Audio visualizers share the panel min-size constants so drag, resize,
// and snap-to-grid behave identically across .panel and .audio-grid.
// Previously the audio grids had their own (much smaller) 100×40 mins
// and started at a fixed 320×72, which meant they never lined up with
// the column widths under side-arrange. Kept as literals (not a reference
// to PANEL_MIN_W/H) because those are declared further down the file and
// the audio-init runs at module load — referencing them here would TDZ.
// Constraints loosened to 80×80. The chip needs SOMETHING > 0 or the
// resize math goes degenerate (negative widths, clamp loops); 80 is
// small enough to squish to a single-row strip and big enough that
// the resize handles stay reachable.
const AUDIO_MIN_W = 80;
const AUDIO_MIN_H = 80;
// Mic byte-frequency to percent multiplier. Byte data is already dB-mapped
// (0 ≈ -100dB, 255 ≈ -30dB on a default AnalyserNode), so this is a linear
// gain on top of that log scale. ~0.55 saturates roughly at typical speech.
const AUDIO_MIC_GAIN = 0.55;
// Mic noise gate (in byte units) — bins below this get squashed so ambient
// hiss doesn't keep all the bars lit.
const AUDIO_MIC_FLOOR = 24;
// FFT band layout matches the audify worker (60 Hz – 16 kHz, log-spaced).
const AUDIO_BAND_FMIN = 60;
const AUDIO_BAND_FMAX = 16000;

// ── Audio context suspend-on-hide ────────────────────────────────────
// In the overlay architecture the dashboard window is HIDDEN whenever
// the user is in Steam / a game. Chromium auto-throttles rAF + the
// document.hidden-gated setIntervals, but an AudioContext keeps running
// its FFT on every audio buffer regardless of window visibility. That
// would mean the dashboard is still doing real work while "away" —
// exactly the double-process cost we want to avoid. So: every
// AudioContext registers here, and a visibilitychange handler suspends
// them all when the dashboard is hidden and resumes them when it's
// shown again. Suspended = the analyser's FFT + the sampler stop dead.
const _audioCtxRegistry = new Set();
function _registerAudioCtx(ctx) {
  if (ctx && typeof ctx.suspend === 'function') {
    _audioCtxRegistry.add(ctx);
    // If we register while already hidden, start suspended.
    if (document.hidden) { try { ctx.suspend(); } catch {} }
  }
  return ctx;
}
document.addEventListener('visibilitychange', () => {
  for (const ctx of _audioCtxRegistry) {
    try { document.hidden ? ctx.suspend() : ctx.resume(); } catch {}
  }
});
// Global visualizer redraw cadence (milliseconds between sampler ticks).
// Driven by the single topbar Hz control — the per-panel ▲/▼ arrows are
// gone. Persisted under cfg.audioFrameMs. Range 5 ms (200 Hz) – 100 ms
// (10 Hz) so the topbar arrows can step in 5 Hz increments across the
// full 10-200 Hz range.
let AUDIO_FRAME_MS = 200;
// Hz range is intentionally narrow [5, 60] — audio visualizers above
// 60 Hz buy nothing perceptually (the eye can't follow per-frame
// changes that fast) and burn CPU. 5 Hz is the slow floor for users
// who want a chill, minimal-CPU dashboard.
const AUDIO_FRAME_MS_MIN = 17;    // 60 Hz ceiling — 1000/60 ≈ 16.67 → round up
const AUDIO_FRAME_MS_MAX = 200;   // 5 Hz floor — 200 ms (5 Hz) is the default
// Info-panel refresh cadence — net, disk, cpu/ram, temps/gpu.
// Decoupled from the audio visualizer Hz: panels want a calm rate;
// audio wants a user-tunable redraw on the topbar dial.
//
// 500 ms = 2 Hz. The previous 100 ms (10 Hz) made the readouts feel
// chaotic — at 100 ms windows the CPU/network rate deltas are small
// and high-variance, so the bars + wire-graph jittered all over the
// place even when actual load was steady. 500 ms gives each delta
// enough time to average out the noise while still feeling live.
// Bump down (250 ms = 4 Hz) for snappier, up (1000 ms = 1 Hz) for
// even calmer.
const PANEL_REFRESH_MS = 500;
function setAudioFrameMs(ms) {
  const clamped = Math.max(AUDIO_FRAME_MS_MIN, Math.min(AUDIO_FRAME_MS_MAX, Math.round(ms)));
  AUDIO_FRAME_MS = clamped;
  // Update the topbar Hz readout. Step is 5 Hz so we display whole Hz
  // values without decimals.
  const hz = Math.round(1000 / clamped);
  const hzValueEl = document.getElementById('hz-value');
  if (hzValueEl) hzValueEl.textContent = `${hz} Hz`;
  if (window.dash?.setConfig) window.dash.setConfig({ audioFrameMs: clamped });
  return clamped;
}
// Step the rate by ±5 Hz. Clamped to [5, 60] Hz.
function stepHz(deltaHz) {
  const cur = Math.round(1000 / AUDIO_FRAME_MS);
  // Snap to the nearest multiple of 5 first so steps don't drift.
  const snapped = Math.round(cur / 5) * 5;
  const next = Math.max(5, Math.min(60, snapped + deltaHz));
  setAudioFrameMs(1000 / next);
}
// Initial display before any user interaction.
setAudioFrameMs(AUDIO_FRAME_MS);
// Per-bar fill decay. Snap up on rises; fall by this many percent per
// frame on drops so the bar gracefully tails off instead of flickering.
// Unchanged from the 23 Hz tuning — at 10 Hz this yields a slightly
// slower per-second decay (40/s vs 92/s) which actually reads as a
// more graceful fall.
const AUDIO_DECAY_PER_FRAME = 4;
// Peak-hold: independent floating marker that snaps to the highest recent
// fill, holds for HOLD frames, then falls slowly. Scaled so hold stays
// ~500 ms regardless of AUDIO_FRAME_MS — 5 frames * 100 ms.
const AUDIO_PEAK_HOLD_FRAMES = 5;
const AUDIO_PEAK_DECAY_PER_FRAME = 3.3;

function shortDeviceName(label, fallback) {
  if (!label) return fallback || 'DEFAULT';
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase().slice(0, 38);
}

// Factory: builds + manages a single audio visualizer (bars + drag/resize +
// mute + persistence). Returns { sample(), setMuted(b), setLabel(s) }.
function createAudioVisualizer({
  gridEl, barsRowEl, muteBtnEl, deviceNameEl, posKey, sizeKey, mutedKey, gainKey, fallbackLabel, kind,
}) {
  // User-adjustable bar-height multiplier. Independent of _audioGainScale
  // (the zen-mode global throttle) so each visualizer can be tuned without
  // affecting the other. Persisted under gainKey so it survives reloads.
  let userGain = 1.0;
  function clampGain(g) { return Math.max(0.2, Math.min(3.0, g)); }
  function setUserGain(g) {
    userGain = clampGain(g);
    if (gainKey && window.dash?.setConfig) window.dash.setConfig({ [gainKey]: userGain });
  }
  let levels    = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0);
  let displayed = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0); // visible bar height
  let peaks     = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0); // floating peak marker
  let peakHold  = new Array(AUDIO_BAR_COUNT_NORMAL).fill(0); // frames before peak starts falling
  let barCount  = AUDIO_BAR_COUNT_NORMAL;
  // Auto-normalizer: the largest band in any incoming frame becomes the
  // 100% reference. Decays slowly toward AGC_FLOOR during quiet passages
  // so silence still draws as silence (no noise amplification), but loud
  // content that *exceeds* the prior peak instantly raises the ceiling.
  // Net effect — bar tops graze 100 on the loudest band and everything
  // else compresses below it, instead of music constantly slamming to
  // 100 across every band.
  const AGC_FLOOR = 25;     // never scale below this — keeps silent → silent
  const AGC_DECAY = 0.995;  // ~98.5% retained per second at 60 fps
  let agcPeak = AGC_FLOOR;
  let analyser = null;
  let track = null;
  let muted = false;

  // Canvas-backed renderer. The previous implementation rebuilt N×2 DOM
  // elements (fill + peak per bar) and updated `style.height`/`bottom` on
  // every frame — at 96 bars × 2 visualizers × 60 Hz that's ~23 k DOM style
  // writes / sec, each forcing flex-row reflow. A single <canvas> is GPU-
  // composited as one texture; per-frame work drops to ~0.1 ms in 2D.
  let canvas = null;
  let ctx    = null;
  let _gradCache = null;
  let _gradH = 0;
  let _gradTheme = -1;
  let _peakColor = '#fff';
  function setupCanvas() {
    if (!barsRowEl) return;
    barsRowEl.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.className = 'audio-bars-canvas';
    barsRowEl.appendChild(canvas);
    ctx = canvas.getContext('2d');
    sizeCanvas();
  }
  function sizeCanvas() {
    if (!canvas || !barsRowEl) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(0, barsRowEl.clientWidth);
    const h = Math.max(0, barsRowEl.clientHeight);
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _gradCache = null; // height changed → rebuild gradient on next render
  }
  // Theme-color cache (audio/amber/red CSS vars). Invalidated by
  // _themeVersion bump. Resolved colors get reused across both the
  // source and mirror canvases without re-reading getComputedStyle.
  let _audioColor = '', _amberColor = '', _redColor = '', _mutedColor = '';
  let _brightRgb = [0, 200, 255], _dimRgb = [0, 60, 76];
  function _parseHex(hex) {
    if (!hex) return null;
    let h = hex.trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
    return [parseInt(h.substr(0,2),16), parseInt(h.substr(2,2),16), parseInt(h.substr(4,2),16)];
  }
  function refreshThemeColorsIfNeeded() {
    if (_gradTheme === _themeVersion && _audioColor) return;
    const cs = getComputedStyle(barsRowEl || document.documentElement);
    _audioColor = cs.getPropertyValue('--audio-color').trim()
               || cs.getPropertyValue('--accent').trim() || '#5fa';
    _amberColor = cs.getPropertyValue('--amber').trim()       || '#f3a83b';
    _redColor   = cs.getPropertyValue('--red').trim()         || '#ff3b30';
    _mutedColor = cs.getPropertyValue('--muted').trim()       || '#6e8aa3';
    // Pre-compute bright + dim RGB triplets for the per-segment lerp so we
    // don't parse hex inside the render loop. Dim = 25% of bright channels
    // (mixed toward black) — preserves hue, just drops the value.
    const rgb = _parseHex(_audioColor) || [80, 200, 255];
    _brightRgb = rgb;
    _dimRgb = [Math.round(rgb[0] * 0.25), Math.round(rgb[1] * 0.25), Math.round(rgb[2] * 0.25)];
    _gradTheme = _themeVersion;
    _peakColor = _audioColor;
  }
  function makeGradient(targetCtx, h) {
    const g = targetCtx.createLinearGradient(0, h, 0, 0); // bottom → top
    g.addColorStop(0.00, _audioColor);
    g.addColorStop(0.55, _audioColor);
    g.addColorStop(0.62, _amberColor);
    g.addColorStop(0.78, _amberColor);
    g.addColorStop(0.90, _redColor);
    g.addColorStop(1.00, _redColor);
    return g;
  }
  // Mirror canvases — opt-in clones that draw the same bars whenever the
  // source renders. Used by the VISUALIZER pane to show the speakers
  // graph in a much larger area when no video is playing. The mirror's
  // bar count tracks the source so visuals stay consistent.
  const _mirrors = new Set();
  function _sizeMirror(m) {
    const dpr = window.devicePixelRatio || 1;
    const r = m.canvas.getBoundingClientRect();
    const tw = Math.round(r.width  * dpr);
    const th = Math.round(r.height * dpr);
    if (m.canvas.width !== tw || m.canvas.height !== th) {
      m.canvas.width = tw;
      m.canvas.height = th;
      m.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  function addMirror(canvasEl) {
    if (!canvasEl) return () => {};
    const m = { canvas: canvasEl, ctx: canvasEl.getContext('2d') };
    _mirrors.add(m);
    return () => _mirrors.delete(m);
  }
  function renderToTarget(targetCanvas, targetCtx) {
    if (!targetCanvas || !targetCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = targetCanvas.width  / dpr;
    const H = targetCanvas.height / dpr;
    targetCtx.clearRect(0, 0, W, H);
    if (barCount <= 0 || W <= 0 || H <= 0) return;
    _diagDrawCalls++;
    // E-Ink themes render the spectrum as a flat line chart — a 1px ink
    // trace over a faint solid fill, matching the network / drive
    // sparklines. No segmented cells, no reflection, no peak markers,
    // no side scale; just the spectrum profile as a still e-paper graph.
    if ((document.documentElement.getAttribute('data-theme') || '').startsWith('matte')) {
      const n = barCount;
      const frame = drawEinkChartFrame(targetCtx, W, H, _brightRgb, [
        { frac: 0,   text: '0'   },
        { frac: 0.5, text: '50'  },
        { frac: 1,   text: '100' },
      ]);
      const baseY = frame.py + frame.ph;
      const xOf = (i) => frame.px + (n > 1 ? (i / (n - 1)) * frame.pw : 0);
      const yOf = (i) => {
        const dist  = n > 1 ? Math.abs(i / (n - 1) - 0.5) * 2 : 0;
        const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
        const v     = Math.min(1, (displayed[i] / 100) * scale);
        return frame.py + frame.ph * (1 - v);
      };
      // Faint solid fill under the trace — green→yellow→red by height.
      targetCtx.beginPath();
      targetCtx.moveTo(xOf(0), baseY);
      for (let i = 0; i < n; i++) targetCtx.lineTo(xOf(i), yOf(i));
      targetCtx.lineTo(xOf(n - 1), baseY);
      targetCtx.closePath();
      targetCtx.fillStyle = einkChartGradient(targetCtx, frame.py, baseY, 0.16);
      targetCtx.fill();
      // The spectrum trace — value gradient colours each band by level.
      targetCtx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xOf(i); const y = yOf(i);
        if (i === 0) targetCtx.moveTo(x, y); else targetCtx.lineTo(x, y);
      }
      targetCtx.strokeStyle = einkChartGradient(targetCtx, frame.py, baseY, 1);
      targetCtx.lineWidth = 1.25;
      targetCtx.lineJoin = 'round';
      targetCtx.lineCap = 'round';
      targetCtx.stroke();
      return;
    }
    // CYBER / default: core-bar style — outlined rectangle bars with a
    // gradient fill (accent → amber → red bottom-to-top), horizontal
    // scanline overlay, and floating peak markers as bright horizontal
    // lines. Mirrors the look of the PROCESSORS / MEM HISTORY grids so
    // the audio meters read as the same UI dialect as the system bars.
    // No bell-curve falloff (cores show direct readings, not aesthetic
    // shaping); no reflection floor.
    const fontSize = Math.max(8, Math.min(11, Math.floor(H / 28)));
    const scaleW   = Math.max(26, Math.min(36, Math.round(W * 0.06)));
    const stripX   = scaleW;
    const usableW  = W - scaleW;
    const gap = 3;
    const barW = Math.max(2, (usableW - gap * (barCount - 1)) / barCount);
    const padTopH = 3;
    const padBotH = 3;
    const trackY  = padTopH;
    const trackH  = Math.max(8, H - padTopH - padBotH);

    // Two-color, NO gradient — solid audio-color fill + dark scanline
    // overlay. Matches the CSS .core-bar-fill rule which dropped its
    // accent→amber→red value gradient. Bar colour stays constant
    // regardless of level.
    const outlineColor = `rgba(${_brightRgb[0]},${_brightRgb[1]},${_brightRgb[2]},0.30)`;
    const scanColor    = 'rgba(0,0,0,0.62)';
    // HUD theme: pill-shaped bars + chunkier 7 px lit / 3 px gap LED
    // tiles instead of the default 3 px / 2 px scanlines, matching
    // the LED-strip references the user supplied.
    const isHud = !!document.documentElement.dataset.theme?.startsWith('hud');
    const tileLit = isHud ? 7 : 3;
    const tileGap = isHud ? 3 : 2;
    const tileCycle = tileLit + tileGap;
    targetCtx.lineWidth = 1;

    for (let i = 0; i < barCount; i++) {
      const x  = Math.round(stripX + i * (barW + gap));
      const bw = Math.max(1, Math.floor(barW));

      // Outlined box — full track height. HUD theme uses a pill-shaped
      // rounded outline so each bar reads like the reference LED strip.
      targetCtx.strokeStyle = outlineColor;
      if (isHud && typeof targetCtx.roundRect === 'function') {
        targetCtx.beginPath();
        targetCtx.roundRect(x + 0.5, trackY + 0.5, bw - 1, trackH - 1, Math.min(bw, trackH) / 2);
        targetCtx.stroke();
      } else {
        targetCtx.strokeRect(x + 0.5, trackY + 0.5, bw - 1, trackH - 1);
      }

      // Fill — solid audio-color, scaled bottom-up by the displayed value.
      const value = Math.max(0, Math.min(1, displayed[i] / 100));
      const fillH = Math.max(0, Math.floor(value * trackH));
      const fillY = trackY + (trackH - fillH);
      // Dim-color tint behind the whole bar so the LED groove is
      // visible even when the bar is silent. Matches the dial gauges
      // where unlit tiles read as faint colored cells, not voids.
      const dimFill = `rgba(${_brightRgb[0]},${_brightRgb[1]},${_brightRgb[2]},0.14)`;
      targetCtx.save();
      if (isHud && typeof targetCtx.roundRect === 'function') {
        targetCtx.beginPath();
        targetCtx.roundRect(x + 1, trackY + 1, Math.max(1, bw - 2), Math.max(1, trackH - 2), Math.min(bw, trackH) / 2);
        targetCtx.clip();
      }
      // 1. Dim background across whole track.
      targetCtx.fillStyle = dimFill;
      targetCtx.fillRect(x + 1, trackY + 1, Math.max(1, bw - 2), Math.max(1, trackH - 2));
      // 2. Bright fill over the lit portion.
      if (fillH > 0) {
        targetCtx.fillStyle = _audioColor;
        targetCtx.fillRect(x + 1, fillY, Math.max(1, bw - 2), fillH);
      }
      // 3. Scanline cuts across the WHOLE track so the LED-tile groove
      //    reads identically in lit and unlit segments.
      targetCtx.fillStyle = scanColor;
      for (let sy = trackY + tileLit; sy < trackY + trackH; sy += tileCycle) {
        targetCtx.fillRect(x + 1, sy, Math.max(1, bw - 2), tileGap);
      }
      targetCtx.restore();

      // Peak marker — 2px horizontal line at the held peak position.
      const peakValue = Math.max(0, Math.min(1, peaks[i] / 100));
      if (peakValue > 0) {
        const peakY = trackY + (trackH - Math.floor(peakValue * trackH));
        targetCtx.fillStyle = _redColor;
        targetCtx.fillRect(x + 1, Math.max(trackY, peakY - 1), Math.max(1, bw - 2), 2);
      }
    }

    // Left-side scale — 0/25/50/75/100 amplitude ticks. Tiny canvases
    // drop to 0/100 only so labels stay legible.
    const ticks = trackH < 90 ? [0, 100] : [0, 25, 50, 75, 100];
    targetCtx.font = `${fontSize}px var(--font-tech), 'Share Tech Mono', monospace`;
    targetCtx.fillStyle = _mutedColor;
    targetCtx.textAlign = 'right';
    targetCtx.textBaseline = 'middle';
    const padTop = Math.ceil(fontSize / 2) + 1;
    for (const v of ticks) {
      const rawY = trackY + trackH - (v / 100) * trackH;
      const y    = Math.max(padTop, Math.min(H - padTop, rawY));
      targetCtx.fillText(String(v), scaleW - 4, y);
      targetCtx.fillRect(scaleW - 3, y - 0.5, 3, 1);
    }
  }
  function render() {
    refreshThemeColorsIfNeeded();
    renderToTarget(canvas, ctx);
    if (_comboInVisualizer && _mirrors.size > 0) {
      for (const m of _mirrors) {
        _sizeMirror(m);
        renderToTarget(m.canvas, m.ctx);
      }
    }
  }

  function rebuildBars(n) {
    levels    = new Array(n).fill(0);
    displayed = new Array(n).fill(0);
    peaks     = new Array(n).fill(0);
    peakHold  = new Array(n).fill(0);
    barCount  = n;
    render();
  }

  setupCanvas();
  rebuildBars(AUDIO_BAR_COUNT_NORMAL);

  // Whether width-driven bar-count rebuilding is active. Zen mode flips
  // this off and back on around its own forced AUDIO_BAR_COUNT_ZEN call so
  // the resize observer doesn't immediately overwrite it.
  let _adaptiveBarsActive = true;
  function setAdaptiveBars(active) { _adaptiveBarsActive = !!active; }

  if (barsRowEl) {
    // Track the row's pixel height so the 3-zone color gradient on each fill
    // can be anchored to the full bar height instead of the fill's own height.
    // Without this the warm/hot zones would scale with the fill and you'd
    // never see them at low levels.
    //
    // Recompute bar count from the row's width. Was 5 px/bar capped at 160
    // — on a 550 px panel that produced 110 bars, each redrawn every render.
    // 10 px/bar capped at 72 cuts that in half (~55 bars per panel × 2 panels
    // = ~110 canvas rectangles per redraw, down from 220). Still reads as a
    // dense spectrum at any reasonable panel width; zen mode forces a
    // different count via setAdaptiveBars(false).
    const AUDIO_BAR_PX = 20;
    const targetBarCount = () => {
      const w = barsRowEl.clientWidth;
      if (w <= 0) return null;
      return Math.max(4, Math.min(36, Math.floor(w / AUDIO_BAR_PX)));
    };
    const updateBars = () => {
      sizeCanvas();
      if (!_adaptiveBarsActive) { render(); return; }
      const n = targetBarCount();
      if (n != null && n !== barCount) rebuildBars(n);
      render();
    };
    updateBars();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(updateBars).observe(barsRowEl);
    }
  }

  // UI-only mute reflection. Used both by the click handler (after also
  // pushing an IPC set) and by the system-state poller (which has just
  // observed an external mute change — keyboard volume key, mixer, etc.)
  // and needs to update the button without echoing back via IPC.
  function applyMuteUi(m) {
    muted = !!m;
    if (track) track.enabled = !muted;
    gridEl?.classList.toggle('is-muted', muted);
    if (muteBtnEl) muteBtnEl.textContent = muted ? 'X' : 'M';
  }
  function setMuted(m) {
    applyMuteUi(m);
    // Mute the OS-level endpoint so the user's microphone really stops
    // capturing / their speakers really go silent — not just our analyser.
    if (kind === 'input'  && window.dash?.setInputMute)  window.dash.setInputMute(muted).catch(() => {});
    if (kind === 'output' && window.dash?.setOutputMute) window.dash.setOutputMute(muted).catch(() => {});
  }
  function isMuted() { return muted; }

  // Per-band bin ranges, computed when the analyser is attached so we can
  // average byte-frequency data into the same 24 log-spaced bands the worker
  // produces for the loopback path.
  let bandLoBin = null, bandHiBin = null, freqBuf = null;

  function setAnalyserAndTrack(an, tr) {
    analyser = an;
    track = tr;
    if (deviceNameEl) deviceNameEl.textContent = shortDeviceName(track?.label, fallbackLabel);
    if (muted && track) track.enabled = false;
    if (an) {
      const sr = an.context?.sampleRate || 48000;
      const N  = an.fftSize;
      const fMax = Math.min(AUDIO_BAND_FMAX, sr / 2);
      bandLoBin = new Int32Array(AUDIO_BAND_COUNT);
      bandHiBin = new Int32Array(AUDIO_BAND_COUNT);
      for (let b = 0; b < AUDIO_BAND_COUNT; b++) {
        const fLo = AUDIO_BAND_FMIN * Math.pow(fMax / AUDIO_BAND_FMIN, b       / AUDIO_BAND_COUNT);
        const fHi = AUDIO_BAND_FMIN * Math.pow(fMax / AUDIO_BAND_FMIN, (b + 1) / AUDIO_BAND_COUNT);
        bandLoBin[b] = Math.max(1, Math.floor((fLo * N) / sr));
        bandHiBin[b] = Math.max(bandLoBin[b] + 1, Math.floor((fHi * N) / sr));
      }
      freqBuf = new Uint8Array(an.frequencyBinCount);
    }
  }

  function setLabelOnly(text) {
    if (deviceNameEl) deviceNameEl.textContent = text;
  }
  function getLabel() {
    return deviceNameEl?.textContent || '';
  }

  function sample() {
    if (!analyser || !barCount || !bandLoBin || !freqBuf) return;
    analyser.getByteFrequencyData(freqBuf);
    const out = new Array(AUDIO_BAND_COUNT);
    for (let b = 0; b < AUDIO_BAND_COUNT; b++) {
      const lo = bandLoBin[b], hi = bandHiBin[b];
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += freqBuf[k];
      const avg = sum / (hi - lo);
      const lifted = Math.max(0, avg - AUDIO_MIC_FLOOR);
      // Pre-AGC clamp at 250 (not 100) so the renderer's AGC has real
      // dynamic range to scale from — clamping at 100 here would make
      // loud speech read as a flat ceiling.
      out[b] = Math.min(250, lifted * AUDIO_MIC_GAIN);
    }
    setBands(out);
  }

  // Squeeze incoming bands so the loudest band in the current frame
  // (after slow decay of past peaks) lands at exactly 100. Quiet
  // content scales relative to that ceiling instead of slamming into it.
  function agcNormalize(bands) {
    let frameMax = 0;
    for (let i = 0; i < bands.length; i++) {
      const v = Number.isFinite(bands[i]) ? bands[i] : 0;
      if (v > frameMax) frameMax = v;
    }
    agcPeak = Math.max(agcPeak * AGC_DECAY, frameMax, AGC_FLOOR);
    const k = 100 / agcPeak;
    const norm = new Array(bands.length);
    for (let i = 0; i < bands.length; i++) {
      const v = Number.isFinite(bands[i]) ? bands[i] : 0;
      norm[i] = Math.min(100, v * k);
    }
    return norm;
  }

  // Frequency-band push — used by the loopback visualizer (each bar = a
  // log-spaced FFT band). When the visible bar count exceeds the input band
  // count (e.g. zen mode with 96 bars vs 24 bands), linearly interpolate so
  // the bars look like a smooth-ish spectrum instead of repeating in groups.
  function setBands(bands) {
    if (!barCount || !bands) return;
    const src = agcNormalize(bands);
    const n = barCount;
    const m = src.length;
    const g = _audioGainScale * userGain;
    for (let i = 0; i < n; i++) {
      let target;
      if (n === m) {
        target = src[i];
      } else {
        const f  = (i / Math.max(1, n - 1)) * (m - 1);
        const lo = Math.floor(f);
        const hi = Math.min(m - 1, lo + 1);
        const t  = f - lo;
        target = src[lo] * (1 - t) + src[hi] * t;
      }
      updateBar(i, target * g);
    }
    render();
  }

  function updateBar(i, target) {
    // Fill: snap up on a rise, decay on a drop.
    if (target >= displayed[i]) {
      displayed[i] = target;
    } else {
      displayed[i] = Math.max(target, displayed[i] - AUDIO_DECAY_PER_FRAME);
    }
    // Peak: track highest fill; hold briefly; then fall slower than the fill.
    if (displayed[i] >= peaks[i]) {
      peaks[i] = displayed[i];
      peakHold[i] = AUDIO_PEAK_HOLD_FRAMES;
    } else if (peakHold[i] > 0) {
      peakHold[i]--;
    } else {
      peaks[i] = Math.max(displayed[i], peaks[i] - AUDIO_PEAK_DECAY_PER_FRAME);
    }
    // Canvas renderer reads displayed[i]/peaks[i] in render() — no DOM write
    // needed per bar. Caller invokes render() once after the loop.
  }

  // Drag-to-move
  gridEl?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (_uiLocked) return;
    if (e.target.classList?.contains('audio-resize-handle')) return;
    e.preventDefault();
    const rect = gridEl.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = rect.left, startTop = rect.top;
    gridEl.classList.add('is-dragging');
    gridEl.style.left = `${startLeft}px`;
    gridEl.style.top  = `${startTop}px`;
    gridEl.style.right  = 'auto';
    gridEl.style.bottom = 'auto';
    const onMove = (ev) => {
      // Absolute-position snap: target final position rounds to the
      // nearest grid line so panels actually land ON the grid (not just
      // move in grid-sized increments from a non-grid start).
      let nx = startLeft + (ev.clientX - startX);
      let ny = startTop  + (ev.clientY - startY);
      if (!ev.altKey) {
        const g = getGridSize();
        nx = snap(nx, g.w);
        ny = snap(ny, g.h);
        // Resolve overlap with panels + the other audio visualizer.
        const resolved = resolveDragOverlap(nx, ny, rect.width, rect.height, getNeighborRects(gridEl));
        nx = resolved.left;
        ny = resolved.top;
      }
      gridEl.style.left = `${nx}px`;
      gridEl.style.top  = `${ny}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      gridEl.classList.remove('is-dragging');
      saveGeom();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Corner-only resize (matches panels — N/S/E/W edge handles were
  // dropped so the audio chip behaves the same as a data panel: drag
  // the body to move, grab a corner to diagonal-resize, grab a side
  // edge to slide the whole flush column horizontally). `grows` is
  // computed from the edge string so 'sw' sets both s+w.
  for (const edge of ['nw', 'ne', 'sw', 'se']) {
    const h = document.createElement('div');
    h.className = `audio-resize-handle audio-resize-${edge}`;
    gridEl?.appendChild(h);
    const grows = {
      n: edge.includes('n'), s: edge.includes('s'),
      w: edge.includes('w'), e: edge.includes('e'),
    };
    h.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (_uiLocked) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = gridEl.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const startW = rect.width, startH = rect.height;
      const startLeft = rect.left, startTop = rect.top;
      gridEl.classList.add('is-resizing');
      gridEl.style.left = `${startLeft}px`;
      gridEl.style.top  = `${startTop}px`;
      gridEl.style.right  = 'auto';
      gridEl.style.bottom = 'auto';
      const onMove = (ev) => {
        // Absolute-edge snap (matches the panel resize). Snapping the
        // delta keeps any off-grid grid off-grid forever; snapping the
        // moved edge pulls it onto the lattice so audio grids and
        // panels re-converge to the same snap lines after any drag.
        const rawDx = ev.clientX - startX;
        const rawDy = ev.clientY - startY;
        const startRight  = startLeft + startW;
        const startBottom = startTop  + startH;
        const g = ev.altKey ? null : getGridSize();
        let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;
        if (grows.e) {
          const edge = g ? snap(startRight + rawDx, g.w) : (startRight + rawDx);
          newW = edge - startLeft;
        }
        if (grows.w) {
          newLeft = g ? snap(startLeft + rawDx, g.w) : (startLeft + rawDx);
          newW = startRight - newLeft;
        }
        if (grows.s) {
          const edge = g ? snap(startBottom + rawDy, g.h) : (startBottom + rawDy);
          newH = edge - startTop;
        }
        if (grows.n) {
          newTop = g ? snap(startTop + rawDy, g.h) : (startTop + rawDy);
          newH = startBottom - newTop;
        }
        if (newW < AUDIO_MIN_W) {
          if (grows.w) newLeft = startRight - AUDIO_MIN_W;
          newW = AUDIO_MIN_W;
        }
        if (newH < AUDIO_MIN_H) {
          if (grows.n) newTop = startBottom - AUDIO_MIN_H;
          newH = AUDIO_MIN_H;
        }
        // Clamp moved edges against neighbors to prevent overlap. Alt
        // bypasses for free placement.
        if (!ev.altKey) {
          const r = resolveResizeOverlap(newLeft, newTop, newW, newH, grows, getNeighborRects(gridEl));
          if (r.width >= AUDIO_MIN_W && r.height >= AUDIO_MIN_H) {
            newLeft = r.left; newTop = r.top; newW = r.width; newH = r.height;
          }
        }
        gridEl.style.width  = `${Math.round(newW)}px`;
        gridEl.style.height = `${Math.round(newH)}px`;
        gridEl.style.left   = `${Math.round(newLeft)}px`;
        gridEl.style.top    = `${Math.round(newTop)}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        gridEl.classList.remove('is-resizing');
        saveGeom();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Mute click
  muteBtnEl?.addEventListener('mousedown', (e) => e.stopPropagation());
  muteBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    setMuted(!muted);
    if (window.dash?.setConfig) await window.dash.setConfig({ [mutedKey]: muted });
  });

  // Per-panel ▲/▼ Hz arrows removed; rate is now driven by the single
  // topbar #hz-control (see stepHz / setAudioFrameMs below).

  async function saveGeom() {
    if (!window.dash?.setConfig || !gridEl) return;
    const x = parseInt(gridEl.style.left, 10);
    const y = parseInt(gridEl.style.top,  10);
    const w = parseInt(gridEl.style.width,  10);
    const h = parseInt(gridEl.style.height, 10);
    const partial = {};
    if (Number.isFinite(x) && Number.isFinite(y)) partial[posKey]  = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial[sizeKey] = { width: w, height: h };
    if (Object.keys(partial).length) await window.dash.setConfig(partial);
  }

  function applySavedGeom(savedPos, savedSize, savedMuted) {
    if (!gridEl) return;
    if (savedPos) {
      gridEl.style.left = `${savedPos.x}px`;
      gridEl.style.top  = `${savedPos.y}px`;
      gridEl.style.right  = 'auto';
      gridEl.style.bottom = 'auto';
    }
    if (savedSize) {
      gridEl.style.width  = `${savedSize.width}px`;
      gridEl.style.height = `${savedSize.height}px`;
    }
    if (savedMuted) setMuted(true);
  }

  // Apply a previously-persisted gain without writing back to config.
  function applySavedGain(g) { if (Number.isFinite(g)) userGain = clampGain(g); }
  return { sample, setBands, setMuted, applyMuteUi, isMuted, setAnalyserAndTrack, setLabelOnly, getLabel, applySavedGeom, applySavedGain, rebuildBars, setAdaptiveBars, addMirror, getBarCount: () => barCount };
}

const audioInViz = createAudioVisualizer({
  gridEl:        document.querySelector('#audio-in-grid'),
  barsRowEl:     document.querySelector('#audio-in-bars-row'),
  muteBtnEl:     document.querySelector('#audio-in-mute-btn'),
  deviceNameEl:  document.querySelector('#audio-in-device-name'),
  posKey:        'audioInPos',
  // Per-chip size key — chips are fully independent like panels, so each
  // one persists its own width/height. Previously both shared
  // 'audioVizSize' which forced them to the same dimensions on every
  // reload regardless of how the user resized each one.
  sizeKey:       'audioInSize',
  mutedKey:      'audioInMuted',
  gainKey:       'audioInGain',
  fallbackLabel: 'DEFAULT MIC',
  kind:          'input',
});

const audioOutViz = createAudioVisualizer({
  gridEl:        document.querySelector('#audio-out-grid'),
  barsRowEl:     document.querySelector('#audio-out-bars-row'),
  muteBtnEl:     document.querySelector('#audio-out-mute-btn'),
  deviceNameEl:  document.querySelector('#audio-out-device-name'),
  posKey:        'audioOutPos',
  sizeKey:       'audioOutSize',
  mutedKey:      'audioOutMuted',
  gainKey:       'audioOutGain',
  fallbackLabel: 'SYSTEM AUDIO',
  kind:          'output',
});

// Native WASAPI loopback path: main process pushes RMS levels to us via IPC.
// When this is wired up, we don't need any browser-side capture at all — the
// main-process audify binding talks directly to WASAPI.
const NATIVE_LOOPBACK_BOUND = !!(IS_ELECTRON && window.dash?.onAudioOutLevel);
let _nativeReceivedFirst = false;
// Last render timestamp for the loopback viz — used to throttle the
// worker's ~23 Hz IPC push down to AUDIO_FRAME_MS so the ▲/▼ arrows
// actually control the displayed rate.
let _lastOutRenderMs = 0;
let _audioDeviceList = [];
if (NATIVE_LOOPBACK_BOUND) {
  audioOutViz.setLabelOnly('NATIVE LOOPBACK · STARTING…');
  window.dash.onAudioOutLevel((data) => {
    if (data?.error) {
      audioOutViz.setLabelOnly(`NATIVE FAIL · ${data.error}`.toUpperCase().slice(0, 60));
      return;
    }
    if (Array.isArray(data?.devices)) {
      _audioDeviceList = data.devices;
      return;
    }
    if (data?.status === 'started' && data.deviceName) {
      audioOutViz.setLabelOnly(shortDeviceName(data.deviceName, 'SYSTEM AUDIO'));
      _nativeReceivedFirst = true;
      return;
    }
    if (!_nativeReceivedFirst && data?.deviceName) {
      audioOutViz.setLabelOnly(shortDeviceName(data.deviceName, 'SYSTEM AUDIO'));
      _nativeReceivedFirst = true;
    }
    // Throttle the render path to AUDIO_FRAME_MS so the ▲/▼ arrows
    // actually control the output viz refresh rate. The worker keeps
    // emitting at its own ~23 Hz; we just drop the inter-frame ones.
    if (Array.isArray(data?.bands)) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - _lastOutRenderMs >= AUDIO_FRAME_MS) {
        _lastOutRenderMs = now;
        audioOutViz.setBands(data.bands);
      }
    }
    // RMS-only off-frames are ignored — FFT frames arrive every ~21 ms
    // which is plenty for the visual decay/peak-hold logic.
  });

  // Click anywhere on the meta-row (except the mute button) to pick which
  // output to use. Useful when the OS default is a virtual cable (VB-Audio)
  // but real audio is going to a headset / speakers — this both switches
  // the OS default endpoint and re-points the loopback visualizer.
  const labelEl = document.querySelector('#audio-out-device-name');
  const rowEl   = labelEl?.closest('.audio-meta-row');
  if (rowEl && labelEl) {
    rowEl.classList.add('is-clickable');
    rowEl.title = 'Click to choose audio output device';
    rowEl.addEventListener('mousedown', (e) => {
      // Let the mute button keep its own mousedown for stopPropagation; the
      // row's mousedown otherwise stops drag/resize on the parent grid.
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
    });
    rowEl.addEventListener('click', (e) => {
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
      if (!_audioDeviceList.length) {
        console.warn('[picker] audio-out: _audioDeviceList empty — audify worker probably did not enumerate');
        return;
      }
      openAudioDevicePicker(labelEl, _audioDeviceList, async (d) => {
        audioOutViz.setLabelOnly(`SWITCHING · ${shortDeviceName(d.name, '')}`);
        _nativeReceivedFirst = false;
        // 1) Restart the loopback monitor so the visualizer reads from the
        //    chosen device. 2) Flip the OS default render endpoint so any
        //    audio actually plays through the chosen device.
        try { await window.dash.setAudioDevice(d.id); } catch (err) {
          audioOutViz.setLabelOnly(`SWITCH FAIL · ${err.message}`.toUpperCase().slice(0, 60));
        }
        if (window.dash?.setDefaultEndpoint) {
          try { await window.dash.setDefaultEndpoint(0, d.name); }
          catch (err) { console.warn('SetDefault output:', err.message); }
        }
      });
    });
  }
}

function openAudioDevicePicker(anchor, devices, onSelect) {
  document.querySelector('.audio-device-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'audio-device-menu';
  for (const d of devices) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'audio-device-menu-item';
    item.textContent = d.name + (d.isDefault ? '  ·  OS default' : '');
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      menu.remove();
      onSelect(d);
    });
    menu.appendChild(item);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
  document.body.appendChild(menu);
  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

// Attempt to wire up the system-output analyser using the three-stage capture
// chain. Returns true on success, false if all paths failed. Pulled out of
// startAudioWaves so we can re-invoke it from a click after a permission /
// user-activation failure.
async function tryStartOutputCapture() {
  // Main process is feeding us native WASAPI loopback over IPC — skip the
  // browser-side capture entirely (which has been failing in this
  // environment anyway).
  if (NATIVE_LOOPBACK_BOUND) return true;

  if (!IS_ELECTRON) {
    audioOutViz.setLabelOnly('BROWSER · NO HOST LOOPBACK');
    return false;
  }
  let stream, track, sourceLabel;
  const captureErrors = [];

  if (!track && window.dash?.getScreenSources) {
    try {
      const sources = await window.dash.getScreenSources();
      if (!sources || !sources.length) throw new Error('no screen sources');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sources[0].id,
            maxWidth: 1, maxHeight: 1, maxFrameRate: 1,
          },
        },
      });
      stream.getVideoTracks().forEach(t => t.stop());
      track = stream.getAudioTracks()[0];
      if (!track) throw new Error('stream had no audio track');
      sourceLabel = `DESKTOP · ${sources[0].name || 'SCREEN'}`;
    } catch (err) { captureErrors.push(`[1 desktop] ${err.message}`); }
  }

  if (!track) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const patterns = [
        /stereo\s*mix/i, /what\s*u\s*hear/i, /^\s*wave\s*out/i, /loopback/i,
        /cable\s*output/i, /voicemeeter.*(out|output|vaio|b\d)/i, /vb-audio/i,
      ];
      let dev = null;
      for (const p of patterns) {
        dev = inputs.find(d => p.test(d.label || ''));
        if (dev) break;
      }
      if (!dev) {
        throw new Error(`no loopback device (have: ${inputs.map(d => d.label).filter(Boolean).slice(0, 3).join(', ') || 'unlabeled'})`);
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dev.deviceId } },
        video: false,
      });
      track = stream.getAudioTracks()[0];
      if (!track) throw new Error('stream had no audio track');
      sourceLabel = dev.label;
    } catch (err) { captureErrors.push(`[2 loopback-dev] ${err.message}`); }
  }

  if (!track) {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 320, height: 180, frameRate: 1 },
      });
      stream.getVideoTracks().forEach(t => t.stop());
      track = stream.getAudioTracks()[0];
      if (!track) throw new Error('stream had no audio track');
      sourceLabel = track.label || 'SYSTEM AUDIO';
    } catch (err) { captureErrors.push(`[3 getDisplayMedia] ${err.message}`); }
  }

  if (track) {
    const ctx = _registerAudioCtx(new (window.AudioContext || window.webkitAudioContext)());
    const src = ctx.createMediaStreamSource(stream);
    const an  = ctx.createAnalyser();
    // 512 bins (was 1024). We only render 24 log-spaced bars, so even
    // 512 averages ~21 bins/bar at the high end — still smooth. Halves
    // the per-buffer FFT cost; the browser runs FFT at ~43 Hz on every
    // audio buffer regardless of our 5 Hz draw rate, so this is the
    // single biggest knob for always-on cost.
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.3;
    src.connect(an);
    audioOutViz.setAnalyserAndTrack(an, track);
    if (sourceLabel) audioOutViz.setLabelOnly(shortDeviceName(sourceLabel, 'SYSTEM AUDIO'));
    return true;
  }
  console.error('All audio output capture paths failed:\n  ' + captureErrors.join('\n  '));
  const last = captureErrors[captureErrors.length - 1] || 'unknown';
  audioOutViz.setLabelOnly(last.toUpperCase().slice(0, 60));
  return false;
}

// One-shot retry triggered by a user click, which gives Chromium the user
// gesture some capture paths require even with permissions granted.
function armOutputCaptureRetryOnClick() {
  const retry = async () => {
    document.removeEventListener('click', retry, true);
    audioOutViz.setLabelOnly('RETRYING…');
    const ok = await tryStartOutputCapture();
    if (!ok) {
      // Re-arm on next click so the user can try again after fixing whatever
      // (eg. plugging in a device, enabling Stereo Mix, etc.).
      audioOutViz.setLabelOnly('CLICK TO RETRY · ' + (audioOutViz.getLabel?.() || 'NO OUTPUT'));
      document.addEventListener('click', retry, true);
    }
  };
  document.addEventListener('click', retry, true);
}

// Mic capture state — kept module-scope so the device picker can stop
// the existing stream and restart with a different deviceId.
let _micStream = null;
let _micCtx = null;
let _micDeviceList = [];

async function startMicCapture(deviceId) {
  if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  if (_micCtx)    { try { await _micCtx.close(); } catch {} _micCtx = null; }
  try {
    const constraints = deviceId
      ? { audio: { deviceId: { exact: deviceId } }, video: false }
      : { audio: true, video: false };
    _micStream = await navigator.mediaDevices.getUserMedia(constraints);
    _micCtx = _registerAudioCtx(new (window.AudioContext || window.webkitAudioContext)());
    const src = _micCtx.createMediaStreamSource(_micStream);
    const an  = _micCtx.createAnalyser();
    // See output-capture analyser above for why 512 (was 1024).
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.3;
    src.connect(an);
    audioInViz.setAnalyserAndTrack(an, _micStream.getAudioTracks()[0]);
    if (window.dash?.setConfig) window.dash.setConfig({ audioInDeviceId: deviceId || null });
    return true;
  } catch (err) {
    audioInViz.setLabelOnly('NO MIC ACCESS');
    return false;
  }
}

async function populateMicDeviceList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    _micDeviceList = devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId)
      .map((d) => ({
        id: d.deviceId,
        name: d.label || `Microphone ${d.deviceId.slice(0, 6)}`,
        isDefault: d.deviceId === 'default' || d.deviceId === 'communications',
      }));
  } catch {}
}

async function startAudioWaves() {
  // Mic — restore the previously chosen input from config, else system default.
  let savedMicId = null;
  try { savedMicId = (await window.dash?.getConfig?.())?.audioInDeviceId || null; } catch {}
  const micOk = await startMicCapture(savedMicId);
  if (!micOk && savedMicId) {
    // Saved device may be unplugged — fall back to default.
    await startMicCapture(null);
  }
  populateMicDeviceList(); // populate cache for the picker
  // Wire the audio-in meta-row as a clickable picker (mirror of audio-out).
  // Whole row is clickable except the mute button so the hit target is
  // easy to find — mute keeps its own click handler.
  const micLabelEl = document.querySelector('#audio-in-device-name');
  const micRowEl   = micLabelEl?.closest('.audio-meta-row');
  if (micRowEl && micLabelEl) {
    micRowEl.classList.add('is-clickable');
    micRowEl.title = 'Click to choose microphone';
    micRowEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
    });
    micRowEl.addEventListener('click', async (e) => {
      if (e.target.closest('.audio-mute-btn')) return;
      e.stopPropagation();
      await populateMicDeviceList();
      if (!_micDeviceList.length) {
        console.warn('[picker] audio-in: no devices — enumerateDevices may need permission');
        return;
      }
      openAudioDevicePicker(micLabelEl, _micDeviceList, async (d) => {
        audioInViz.setLabelOnly(`SWITCHING · ${shortDeviceName(d.name, '')}`);
        await startMicCapture(d.id === 'default' ? null : d.id);
        // Also flip the OS default capture endpoint so other apps follow.
        if (window.dash?.setDefaultEndpoint) {
          try { await window.dash.setDefaultEndpoint(1, d.name); }
          catch (err) { console.warn('SetDefault input:', err.message); }
        }
      });
    });
  }
  // Keep the device list fresh as devices are plugged/unplugged.
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateMicDeviceList);
  }

  // System OUTPUT capture — three-stage chain in tryStartOutputCapture(). If
  // the auto attempt fails (often because Chromium wants a user gesture for
  // getDisplayMedia even with permissions granted), arm a one-shot click
  // retry so the user can tap to enable.
  const ok = await tryStartOutputCapture();
  if (!ok) armOutputCaptureRetryOnClick();

  drawAudioFrame();
}

// Audio sampler loop. AUDIO_FRAME_MS controls the visualizer redraw
// cadence — currently 100 ms (10 Hz). Worker still produces FFT bands
// at ~23 Hz; we just sample the latest at each tick. Lower the rate to
// trade visual smoothness for renderer CPU.
function drawAudioFrame() {
  audioInViz.sample();
  audioOutViz.sample();
  setTimeout(drawAudioFrame, AUDIO_FRAME_MS);
}
startAudioWaves();

// Keep the dashboard mute buttons in sync with the OS endpoint state.
// Volume keyboard keys auto-unmute on Windows, and the user can also
// toggle from the volume mixer or other apps — without polling, our
// button would lie about the device's actual state.
if (window.dash?.getMuteStates) {
  setInterval(async () => {
    if (document.hidden) return;
    let st;
    try { st = await window.dash.getMuteStates(); } catch { return; }
    if (!st?.ok) return;
    if (typeof st.out === 'boolean' && audioOutViz.isMuted() !== st.out) audioOutViz.applyMuteUi(st.out);
    if (typeof st.in  === 'boolean' && audioInViz .isMuted() !== st.in ) audioInViz .applyMuteUi(st.in );
  }, UI_REFRESH_MS);
}

// ── Notes (tabbed scratchpad) ───────────────────────────────────────────────
const noteTabsEl      = document.querySelector('#note-tabs');
const noteTextareaEl  = document.querySelector('#note-textarea');
const notesStatusEl   = document.querySelector('#notes-status');
const notesTabCountEl = document.querySelector('#notes-tab-count');

// Time helpers used by the per-line stamp + the top-right "updated" chip.
function fmtNoteTime(ms = Date.now()) {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
function fmtNoteStamp(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da} ${fmtNoteTime(ms)}`;
}
function refreshNoteUpdatedDisplay() {
  const el = document.querySelector('#note-updated');
  if (!el) return;
  const tab = activeNoteTab();
  el.textContent = `UPDATED ${fmtNoteStamp(tab?.updatedAt)}`;
}

const TAB_NAME_MAX = 14;
let notesState = { active: null, tabs: [] };
let noteSaveTimer = null;
let activeTabNameSpan = null;

function newTabId() { return 'tab-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4); }

function activeNoteTab() {
  return notesState.tabs.find(t => t.id === notesState.active) || null;
}

// Derive a tab's display name. Manual override (`tab.name`) wins; otherwise
// take the first non-empty line of the note body. Falls back to NOTE N if
// the note is still blank.
function tabDisplayName(tab, idx) {
  if (tab.name && tab.name.trim()) return tab.name;
  const firstLine = (tab.body || '').split(/\r?\n/).find(l => l.trim());
  if (firstLine) return firstLine.trim().toUpperCase().slice(0, TAB_NAME_MAX);
  return `NOTE ${idx + 1}`;
}

function makeTabEl(tab) {
  const btn = document.createElement('button');
  btn.className = 'note-tab' + (tab.id === notesState.active ? ' is-active' : '');
  btn.dataset.id = tab.id;
  btn.title = 'Click to switch · Double-click to rename';
  btn.type = 'button';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'note-tab-name';
  nameSpan.textContent = tabDisplayName(tab, notesState.tabs.indexOf(tab));
  if (tab.id === notesState.active) activeTabNameSpan = nameSpan;

  const closeSpan = document.createElement('span');
  closeSpan.className = 'note-tab-close';
  closeSpan.textContent = '×'; // ×
  closeSpan.title = 'Delete tab';

  btn.appendChild(nameSpan);
  btn.appendChild(closeSpan);

  btn.addEventListener('click', (e) => {
    if (e.target === closeSpan) {
      e.stopPropagation();
      deleteNote(tab.id);
      return;
    }
    switchNote(tab.id);
  });

  btn.addEventListener('dblclick', (e) => {
    if (e.target === closeSpan) return;
    // Manual override. Leave blank to revert to first-line auto-naming.
    const newName = window.prompt('Tab name (leave blank to auto-name from first line)', tab.name || '');
    if (newName === null) return;
    tab.name = newName.trim().toUpperCase().slice(0, TAB_NAME_MAX);
    renderNoteTabs();
    saveNotesNow();
  });

  return btn;
}

function renderNoteTabs() {
  noteTabsEl.innerHTML = '';
  for (const tab of notesState.tabs) noteTabsEl.appendChild(makeTabEl(tab));

  const addBtn = document.createElement('button');
  addBtn.className = 'note-tab note-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New tab';
  addBtn.type = 'button';
  addBtn.addEventListener('click', addNote);
  noteTabsEl.appendChild(addBtn);

  // Top-right "UPDATED YYYY-MM-DD HH:MM" chip — shows when the active tab's
  // body was last edited. margin-left: auto in CSS pushes it to the right
  // edge of the tabs row.
  const updatedSpan = document.createElement('span');
  updatedSpan.className = 'note-updated';
  updatedSpan.id = 'note-updated';
  noteTabsEl.appendChild(updatedSpan);
  refreshNoteUpdatedDisplay();

  if (notesTabCountEl) {
    notesTabCountEl.textContent = String(notesState.tabs.length).padStart(2, '0');
  }
}

function renderActiveNote() {
  const tab = activeNoteTab();
  noteTextareaEl.value = tab?.body || '';
  refreshNoteUpdatedDisplay();
}

function switchNote(id) {
  // Sync current textarea back to the previously active tab before switching
  const prev = activeNoteTab();
  if (prev) prev.body = noteTextareaEl.value;
  if (notesState.active === id) return;
  notesState.active = id;
  renderNoteTabs();
  renderActiveNote();
  saveNotesNow();
}

function addNote() {
  const id = newTabId();
  // Empty name → display falls back to first line of body (or NOTE N if blank).
  notesState.tabs.push({ id, name: '', body: '' });
  notesState.active = id;
  renderNoteTabs();
  renderActiveNote();
  noteTextareaEl.focus();
  saveNotesNow();
}

function deleteNote(id) {
  const idx = notesState.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  if (notesState.tabs.length <= 1) {
    // Last tab — clear contents but don't delete
    notesState.tabs[0].body = '';
    noteTextareaEl.value = '';
    saveNotesNow();
    return;
  }
  notesState.tabs.splice(idx, 1);
  if (notesState.active === id) {
    notesState.active = notesState.tabs[Math.max(0, idx - 1)].id;
  }
  renderNoteTabs();
  renderActiveNote();
  saveNotesNow();
}

function setNotesStatus(state, color) {
  if (!notesStatusEl) return;
  notesStatusEl.innerHTML = `<em>STATE</em> <strong class="${color}">${state}</strong> <em>TABS</em> <strong>${notesState.tabs.length}</strong>`;
  // Preserve combo-footer-notes so the CSS rule that hides this readout
  // in non-notes combo modes still applies.
  notesStatusEl.className = 'footer-readout combo-footer-notes';
}

function scheduleNoteSave() {
  // Buffer the active body in memory immediately so tab switches don't lose data.
  const tab = activeNoteTab();
  if (tab) {
    tab.body = noteTextareaEl.value;
    tab.updatedAt = Date.now();
  }
  setNotesStatus('EDITING', 'amber');
  refreshNoteUpdatedDisplay();
  // Live-update the active tab's title from the first line of the body.
  if (tab && activeTabNameSpan) {
    activeTabNameSpan.textContent = tabDisplayName(tab, notesState.tabs.indexOf(tab));
  }
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(saveNotesNow, 500);
}

async function saveNotesNow() {
  clearTimeout(noteSaveTimer);
  const tab = activeNoteTab();
  if (tab) tab.body = noteTextareaEl.value;
  if (window.dash?.setConfig) {
    try {
      await window.dash.setConfig({ notes: notesState });
      setNotesStatus('SAVED', 'ok');
    } catch (err) {
      setNotesStatus(`ERR: ${err.message}`.toUpperCase(), 'red');
    }
  } else {
    setNotesStatus('LOCAL', 'amber');
  }
  // Mirror the active tab to docs/notes/<safe-name>.txt so the EXPLORE
  // pane (and Explorer) sees a real file. Use the same auto-derived title
  // that's shown on the tab UI (manual name → first line of body → NOTE N)
  // so untitled notes don't all collide into one file. Also: when the
  // first line changes, the file gets a new name — track the previous
  // filename on the tab so we can delete the orphan instead of leaving
  // a stale copy behind on every rename.
  if (tab && window.dash?.docsWrite) {
    const idx = notesState.tabs.indexOf(tab);
    const display = tabDisplayName(tab, idx >= 0 ? idx : 0);
    const safe = display.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'note';
    const rel = `notes/${safe}.txt`;
    const prev = tab._lastNoteFile;
    if (prev && prev !== rel && window.dash?.docsPath && window.dash?.exploreDelete) {
      try {
        const root = await window.dash.docsPath();
        if (root) await window.dash.exploreDelete(`${root}/${prev}`);
      } catch {}
    }
    try { await window.dash.docsWrite(rel, tab.body || ''); tab._lastNoteFile = rel; } catch {}
  }
}

noteTextareaEl.addEventListener('input', scheduleNoteSave);

// Per-line timestamp: pressing Enter inserts "\n[HH:MM] " at the caret and
// places the caret after the prefix. Shift+Enter, Ctrl+Enter etc. fall
// through to the textarea's default newline behavior so the user has an
// escape hatch when they don't want a stamp.
noteTextareaEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  const ta = noteTextareaEl;
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const insert = `\n[${fmtNoteTime()}] `;
  ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
  const caret = start + insert.length;
  ta.selectionStart = ta.selectionEnd = caret;
  // Flush the debounced save immediately so the file on disk shows up
  // with its first-line title the moment the user finishes a line.
  scheduleNoteSave();
  saveNotesNow();
});

function initNotes(cfg) {
  const saved = cfg?.notes;
  if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
    notesState = {
      active: saved.active,
      tabs: saved.tabs.map(t => ({
        id: t.id || newTabId(),
        // Empty name means "auto-generate from first line" (see
        // tabDisplayName). Older configs stamped the literal placeholder
        // 'NOTE' / 'NOTES' as the default, which made every tab read as
        // manually-named and froze the title — treat those as empty so
        // the auto-naming kicks back in on load.
        name: (() => {
          const n = (t.name || '').trim();
          return (n && n !== 'NOTE' && n !== 'NOTES' ? n : '').slice(0, TAB_NAME_MAX);
        })(),
        body: typeof t.body === 'string' ? t.body : '',
      })),
    };
    if (!notesState.tabs.find(t => t.id === notesState.active)) {
      notesState.active = notesState.tabs[0].id;
    }
  } else {
    const id = newTabId();
    notesState = { active: id, tabs: [{ id, name: '', body: '' }] };
  }
  renderNoteTabs();
  renderActiveNote();
  setNotesStatus('SAVED', 'ok');
}

// ── Panel resize (4 corner handles — both axes, anchor follows cursor) ─────
const PANEL_MIN_W = 280;
const PANEL_MIN_H = 120;

function panelKey(panel) {
  for (const cls of panel.classList) {
    if (cls.startsWith('panel-')) return cls.slice('panel-'.length);
  }
  return null;
}

function applyPanelSize(panel, size) {
  if (!size) return;
  if (Number.isFinite(size.width)) {
    panel.style.flex = '0 0 auto';
    panel.style.width = `${size.width}px`;
    panel.style.maxWidth = `${size.width}px`;
  }
  if (Number.isFinite(size.x) && Number.isFinite(size.y)) {
    panel.style.position = 'fixed';
    panel.style.left = `${size.x}px`;
    panel.style.top  = `${size.y}px`;
    if (Number.isFinite(size.height)) panel.style.height = `${size.height}px`;
  }
  // Whenever a SIDE panel moves/resizes, refresh the combo panel's
  // horizontal pinning so it stays flush against the new edges. Skip
  // when sizing the combo itself (its own left/width are CSS-forced,
  // not driven by this code).
  if (!panel.classList.contains('panel-combo') && typeof _updateComboFoldBoundsRef === 'function') {
    _updateComboFoldBoundsRef();
  }
}

function clearPanelSize(panel) {
  panel.style.flex = '';
  panel.style.width = '';
  panel.style.height = '';
  panel.style.maxWidth = '';
  panel.style.position = '';
  panel.style.left = '';
  panel.style.top = '';
}

async function savePanelSize(id, partial) {
  // partial = { width? , x?, y?, height? } — merged into existing entry.
  if (!window.dash?.getConfig) return;
  const cfg = await window.dash.getConfig();
  const sizes = { ...(cfg.panelSizes || {}) };
  sizes[id] = { ...(sizes[id] || {}), ...partial };
  await window.dash.setConfig({ panelSizes: sizes });
}

async function resetAllPanelSizes() {
  for (const panel of document.querySelectorAll('.panel')) clearPanelSize(panel);
  if (!window.dash?.setConfig) return;
  await window.dash.setConfig({ panelSizes: {} });
}

function makeResizeHandle(panel, key, dir /* 'nw'|'ne'|'sw'|'se' corners, or 'n'|'s'|'e'|'w' edges */) {
  const handle = document.createElement('div');
  handle.className = `resize-handle resize-handle-${dir}`;
  handle.title = 'Drag to resize · Ctrl+Shift+R to reset';
  panel.appendChild(handle);

  // .includes works for both 2-char corners ('nw') and 1-char edges ('w'),
  // so an edge handle grows along a single axis while corners grow along
  // two axes — same downstream math.
  const grows = {
    n: dir.includes('n'),
    s: dir.includes('s'),
    w: dir.includes('w'),
    e: dir.includes('e'),
  };

  handle.addEventListener('mousedown', (e) => {
    // PRODUCTIVITY (panel-combo) is exempt from the lock — see attachDrag.
    if (_uiLocked && !panel.classList.contains('panel-combo')) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = rect.width, startH = rect.height;
    const startLeft = rect.left, startTop = rect.top;
    panel.classList.add('is-resizing');

    // Detach panel from the grid so left/top can be controlled. Lock current
    // position so the panel doesn't visually jump on the first move.
    panel.style.position = 'fixed';
    panel.style.left = `${startLeft}px`;
    panel.style.top  = `${startTop}px`;
    panel.style.flex = '0 0 auto';

    // COHORT detection — only on pure single-axis EDGE handles
    // ('e','w','n','s'), never corners. Strict FLUSH-TOUCHING rule:
    // a panel only joins the cohort if it shares the dragged
    // panel's column (same left + width within tol) AND is
    // physically touching another cohort member's top or bottom
    // edge (within tol). For N/S drag the rule flips: same row
    // (same top + height) + horizontally adjacent.
    //
    // A panel on the right side of the screen is NOT in the cohort
    // even if it vertically overlaps the dragged left-side panel,
    // because they're not touching. Holding Shift bypasses cohort
    // entirely (solo resize).
    const isEdge = (dir === 'e' || dir === 'w' || dir === 'n' || dir === 's');
    const isHoriz = (dir === 'e' || dir === 'w');
    const cohortDisabled = e.shiftKey || panel.classList.contains('panel-combo');
    const cohort = [];
    if (isEdge && !cohortDisabled) {
      // Cohort tolerance — was 4 px which was too tight: audio strips
      // often sit a few extra pixels narrower than the panel above
      // due to their own border / padding, so a 4 px window missed
      // them. 10 px is still well below any actual column gap on a
      // 4K layout so it can't bridge two unrelated columns.
      const tol = 10;
      // Snapshot every visible non-combo panel + audio-grid.
      const all = [];
      for (const el of document.querySelectorAll('.panel, .audio-grid')) {
        if (el.classList.contains('is-collapsed')) continue;
        if (el.classList.contains('panel-combo')) continue;
        if (el.hasAttribute('hidden')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        all.push({ el, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
      }
      // Seed = dragged panel. BFS adds (a) SYNC members — same column
      // with flush vertical contact (same direction as drag) — and
      // (b) JOINT members — the adjacent panel sharing the dragged
      // edge, whose opposite edge tracks the boundary so two
      // snapped-together panels scale against each other.
      const addMember = (cand, mode) => {
        cand.el.style.position = 'fixed';
        cand.el.style.left   = `${cand.left}px`;
        cand.el.style.top    = `${cand.top}px`;
        cand.el.style.width  = `${cand.width}px`;
        cand.el.style.height = `${cand.height}px`;
        cand.el.style.maxWidth = `${cand.width}px`;
        cand.el.style.flex = '0 0 auto';
        cand.el.classList.add('is-resizing');
        const isAudio = cand.el.classList.contains('audio-grid');
        const id = cand.el.id || '';
        cohort.push({
          el: cand.el, mode,
          startLeft: cand.left, startTop: cand.top,
          startWidth: cand.width, startHeight: cand.height,
          kind: isAudio ? 'audio' : 'panel',
          key:  isAudio ? null : panelKey(cand.el),
          audioSide: isAudio ? (id.includes('out') ? 'out' : 'in') : null,
        });
      };
      const seed = all.find((c) => c.el === panel);
      if (seed) {
        const visited = new Set([panel]);
        const queue = [seed];
        while (queue.length) {
          const cur = queue.shift();
          for (const cand of all) {
            if (visited.has(cand.el)) continue;
            let mode = null;
            if (isHoriz) {
              // SYNC: same column + vertically flush.
              const sameCol =
                Math.abs(cand.left  - cur.left)  <= tol &&
                Math.abs(cand.right - cur.right) <= tol;
              const vFlush = sameCol && (
                Math.abs(cand.top    - cur.bottom) <= tol ||
                Math.abs(cand.bottom - cur.top)    <= tol);
              if (vFlush) {
                mode = 'sync';
              } else {
                // JOINT: candidate sits on the dragged-edge side and
                // its OPPOSITE edge touches the cur element. Must
                // also vertically overlap so the two share a real
                // boundary segment (not just a corner).
                const vOverlap = !(cand.bottom < cur.top || cand.top > cur.bottom);
                if (vOverlap) {
                  if (grows.e && Math.abs(cand.left  - cur.right) <= tol) mode = 'joint-east';
                  if (grows.w && Math.abs(cand.right - cur.left)  <= tol) mode = 'joint-west';
                }
              }
            } else {
              const sameRow =
                Math.abs(cand.top    - cur.top)    <= tol &&
                Math.abs(cand.bottom - cur.bottom) <= tol;
              const hFlush = sameRow && (
                Math.abs(cand.left  - cur.right) <= tol ||
                Math.abs(cand.right - cur.left)  <= tol);
              if (hFlush) {
                mode = 'sync';
              } else {
                const hOverlap = !(cand.right < cur.left || cand.left > cur.right);
                if (hOverlap) {
                  if (grows.s && Math.abs(cand.top    - cur.bottom) <= tol) mode = 'joint-south';
                  if (grows.n && Math.abs(cand.bottom - cur.top)    <= tol) mode = 'joint-north';
                }
              }
            }
            if (!mode) continue;
            visited.add(cand.el);
            // SYNC members can extend the BFS further (their column
            // members join too). JOINT neighbours don't transit —
            // we only want the panel directly sharing the boundary,
            // not its column.
            if (mode === 'sync') queue.push(cand);
            addMember(cand, mode);
          }
        }
      }
    }

    const onMove = (ev) => {
      // Snap the *absolute* edge position to the grid, not the cursor
      // delta. Delta-snap (the old behaviour) keeps a panel off-grid if
      // it starts off-grid, so two panels can never re-align without a
      // full reset — exactly the "never get realigned" symptom users hit.
      // By snapping the moved edge to an absolute grid line we converge:
      // every resize pulls the edge onto the lattice, so panels and
      // audio grids all end up sharing the same snap points. Alt bypasses.
      const rawDx = ev.clientX - startX;
      const rawDy = ev.clientY - startY;
      const startRight  = startLeft + startW;
      const startBottom = startTop  + startH;
      const g = ev.altKey ? null : getGridSize();
      let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;

      if (grows.e) {
        const target = startRight + rawDx;
        const edge = g ? snap(target, g.w) : target;
        newW = edge - startLeft;
      }
      if (grows.w) {
        const target = startLeft + rawDx;
        newLeft = g ? snap(target, g.w) : target;
        newW = startRight - newLeft;
      }
      if (grows.s) {
        const target = startBottom + rawDy;
        const edge = g ? snap(target, g.h) : target;
        newH = edge - startTop;
      }
      if (grows.n) {
        const target = startTop + rawDy;
        newTop = g ? snap(target, g.h) : target;
        newH = startBottom - newTop;
      }

      if (newW < PANEL_MIN_W) {
        if (grows.w) newLeft = startRight - PANEL_MIN_W;
        newW = PANEL_MIN_W;
      }
      if (newH < PANEL_MIN_H) {
        if (grows.n) newTop = startBottom - PANEL_MIN_H;
        newH = PANEL_MIN_H;
      }
      // Clamp the moved edges against neighbors so the panel can't grow
      // into another panel. Skipped under Alt (free placement).
      if (!ev.altKey) {
        const r = resolveResizeOverlap(newLeft, newTop, newW, newH, grows, getNeighborRects(panel));
        if (r.width >= PANEL_MIN_W && r.height >= PANEL_MIN_H) {
          newLeft = r.left; newTop = r.top; newW = r.width; newH = r.height;
        }
      }

      panel.style.width    = `${Math.round(newW)}px`;
      panel.style.height   = `${Math.round(newH)}px`;
      panel.style.maxWidth = `${Math.round(newW)}px`;
      panel.style.left = `${Math.round(newLeft)}px`;
      panel.style.top  = `${Math.round(newTop)}px`;

      // Apply per-member geometry. `sync` members scale with the
      // dragged edge (same direction). `joint-*` members are the
      // adjacent panel sharing the dragged boundary: their OPPOSITE
      // edge tracks the moved edge, so dragging the boundary
      // grows one panel while shrinking its neighbour.
      if (cohort.length) {
        const dxLeft  = Math.round(newLeft) - startLeft;
        const dxRight = (Math.round(newLeft) + Math.round(newW)) - (startLeft + startW);
        const dyTop   = Math.round(newTop)  - startTop;
        const dyBot   = (Math.round(newTop)  + Math.round(newH)) - (startTop  + startH);
        for (const m of cohort) {
          let mx = m.startLeft, my = m.startTop, mw = m.startWidth, mh = m.startHeight;
          if (m.mode === 'sync') {
            if (isHoriz) {
              if (grows.w) { mx = m.startLeft + dxLeft; mw = m.startWidth - dxLeft; }
              if (grows.e) { mw = m.startWidth + dxRight; }
            } else {
              if (grows.n) { my = m.startTop + dyTop; mh = m.startHeight - dyTop; }
              if (grows.s) { mh = m.startHeight + dyBot; }
            }
          } else if (m.mode === 'joint-east') {
            // Neighbour to the east of dragged panel. Its left edge
            // moves with the dragged panel's right edge; its right
            // edge stays anchored, so it shrinks as we grow.
            mx = m.startLeft + dxRight;
            mw = m.startWidth - dxRight;
          } else if (m.mode === 'joint-west') {
            // Neighbour to the west. Its right edge moves with the
            // dragged panel's left edge; left stays anchored.
            mw = m.startWidth + dxLeft;
          } else if (m.mode === 'joint-south') {
            my = m.startTop + dyBot;
            mh = m.startHeight - dyBot;
          } else if (m.mode === 'joint-north') {
            mh = m.startHeight + dyTop;
          }
          mw = Math.max(40, mw);
          mh = Math.max(40, mh);
          m.el.style.left   = `${Math.round(mx)}px`;
          m.el.style.top    = `${Math.round(my)}px`;
          m.el.style.width  = `${Math.round(mw)}px`;
          m.el.style.height = `${Math.round(mh)}px`;
          m.el.style.maxWidth = `${Math.round(mw)}px`;
        }
      }
      // Keep PRODUCTIVITY (combo) flush against the side panels as they
      // resize. Its left/right are pinned to the live side-panel edges,
      // so re-running the bounds calc every move makes it track the drag
      // instead of separating (gap) or being overlapped. Skipped when the
      // combo itself is the one being resized (its geometry is special).
      if (!panel.classList.contains('panel-combo')) _updateComboFoldBoundsRef?.();
    };
    const persistGeom = (el, k, isAudio, audioSide) => {
      const w = parseInt(el.style.width, 10);
      const h = parseInt(el.style.height, 10);
      const x = parseInt(el.style.left, 10);
      const y = parseInt(el.style.top, 10);
      const partial = {};
      if (Number.isFinite(w)) partial.width  = w;
      if (Number.isFinite(h)) partial.height = h;
      if (Number.isFinite(x)) partial.x = x;
      if (Number.isFinite(y)) partial.y = y;
      if (k) {
        savePanelSize(k, partial);
      } else if (isAudio) {
        const posKey  = audioSide === 'out' ? 'audioOutPos'  : 'audioInPos';
        const sizeKey = audioSide === 'out' ? 'audioOutSize' : 'audioInSize';
        const cfgPartial = {};
        if (Number.isFinite(x) && Number.isFinite(y)) cfgPartial[posKey]  = { x, y };
        if (Number.isFinite(w) && Number.isFinite(h)) cfgPartial[sizeKey] = { width: w, height: h };
        if (Object.keys(cfgPartial).length) {
          try { window.dash?.setConfig?.(cfgPartial); } catch {}
        }
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panel.classList.remove('is-resizing');
      const isAudio = panel.classList.contains('audio-grid');
      const audioSide = isAudio ? ((panel.id || '').includes('out') ? 'out' : 'in') : null;
      persistGeom(panel, key, isAudio, audioSide);
      for (const m of cohort) {
        m.el.classList.remove('is-resizing');
        persistGeom(m.el, m.key, m.kind === 'audio', m.audioSide);
      }
      // Final flush re-pin so the combo settles exactly against the
      // released side-panel edges.
      if (!panel.classList.contains('panel-combo')) _updateComboFoldBoundsRef?.();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Snap-to-grid. The bg-grid renders fine lines at 40px (major every
// 200px, tick dots every 80px). The snap was previously locked to 40
// so every snap point fell on a visible line — but that grid resolution
// was too coarse for fine layout work, so we now snap at HALF a fine
// cell (20px). Every other snap point still lands on a visible bg-grid
// line; the in-between points snap to the unmarked midpoint, giving
// twice the resolution without changing the visible grid.
const SNAP_CELL = 20;
function getGridSize() {
  return { w: SNAP_CELL, h: SNAP_CELL };
}
function snap(value, cell) {
  return Math.round(value / cell) * cell;
}

// Collision detection so panels (+ audio visualizers) can't overlap during
// drag or resize. They share viewport space; preventing overlap also
// produces "snap together edge-to-edge" behavior for free — when you push
// one against another, the dragged element stops with its edge flush
// against the neighbor's edge.
function getNeighborRects(self) {
  const els = document.querySelectorAll('.panel, .audio-grid');
  const out = [];
  for (const el of els) {
    if (el === self) continue;
    if (el.classList.contains('is-collapsed')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}

// Drag-collision: if proposed rect overlaps a neighbor, translate by the
// minimum axis-aligned distance that resolves the overlap. Iterates so
// resolving one collision can't put us inside a different neighbor.
function resolveDragOverlap(left, top, width, height, neighbors) {
  let l = left, t = top;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const n of neighbors) {
      const r = l + width, b = t + height;
      if (r <= n.left || l >= n.right || b <= n.top || t >= n.bottom) continue;
      // Distance to push out on each axis.
      const pushR = n.right - l;       // shift right so left edge meets n.right
      const pushL = r - n.left;        // shift left so right edge meets n.left
      const pushD = n.bottom - t;
      const pushU = b - n.top;
      const m = Math.min(pushR, pushL, pushD, pushU);
      if (m === pushR)      l = n.right;
      else if (m === pushL) l = n.left - width;
      else if (m === pushD) t = n.bottom;
      else                  t = n.top  - height;
      moved = true;
    }
    if (!moved) break;
  }
  return { left: l, top: t };
}

// Resize-collision: clamp moved edges to neighbor edges so we can't grow
// into another panel. grows = { n, s, e, w } indicates which edges are
// being dragged; only those are eligible to clamp. Returns clamped rect.
function resolveResizeOverlap(left, top, width, height, grows, neighbors) {
  let l = left, t = top, w = width, h = height;
  for (const n of neighbors) {
    const r = l + w, b = t + h;
    if (r <= n.left || l >= n.right || b <= n.top || t >= n.bottom) continue;
    if (grows.e && r > n.left && l < n.left) {
      w = n.left - l;
    }
    if (grows.w && l < n.right && r > n.right) {
      const right = l + w;
      l = n.right;
      w = right - l;
    }
    if (grows.s && b > n.top && t < n.top) {
      h = n.top - t;
    }
    if (grows.n && t < n.bottom && b > n.bottom) {
      const bottom = t + h;
      t = n.bottom;
      h = bottom - t;
    }
  }
  return { left: l, top: t, width: w, height: h };
}

// Drag-to-move via the panel header.
function attachDrag(panel) {
  const key = panelKey(panel);
  const header = panel.querySelector('.panel-header');
  if (!header) return;
  const isAudio = panel.classList.contains('audio-grid');
  // Regular panel without a key (shouldn't happen on real panels) bails.
  if (!key && !isAudio) return;
  header.classList.add('is-draggable');

  header.addEventListener('mousedown', (e) => {
    // Don't hijack clicks on inputs/buttons inside the header.
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
    // The lock-UI button skips the combo (PRODUCTIVITY) panel — it's
    // always free to drag/resize so the user can still move it around
    // while everything else is pinned in place.
    if (_uiLocked && !panel.classList.contains('panel-combo')) return;

    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop  = rect.top;
    panel.classList.add('is-dragging');

    // Detach from the grid: lock current size + position so layout doesn't jump.
    panel.style.position = 'fixed';
    panel.style.left   = `${startLeft}px`;
    panel.style.top    = `${startTop}px`;
    panel.style.width  = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
    panel.style.maxWidth = `${rect.width}px`;

    const onMove = (ev) => {
      // Absolute-position snap: target final position lands on a grid line.
      let nx = startLeft + (ev.clientX - startX);
      let ny = startTop  + (ev.clientY - startY);
      if (!ev.altKey) {
        const g = getGridSize();
        nx = snap(nx, g.w);
        ny = snap(ny, g.h);
        // Resolve collision with other panels / audio grids — translate to
        // the closest non-overlapping position. Naturally aligns edges.
        const resolved = resolveDragOverlap(nx, ny, rect.width, rect.height, getNeighborRects(panel));
        nx = resolved.left;
        ny = resolved.top;
      }
      // The PRODUCTIVITY (combo) panel carries the fused control bar as
      // its first child — its own top edge IS the topbar — so just clamp
      // to the viewport top so the control bar can't slide off-screen.
      if (panel.classList.contains('panel-combo')) {
        if (ny < 0) ny = 0;
      }
      panel.style.left = `${nx}px`;
      panel.style.top  = `${ny}px`;
      // Re-pin PRODUCTIVITY (combo) flush as a side panel is dragged
      // around, so it never separates from a moved neighbor. Skipped
      // when the combo itself is being dragged.
      if (!panel.classList.contains('panel-combo')) _updateComboFoldBoundsRef?.();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panel.classList.remove('is-dragging');
      if (!panel.classList.contains('panel-combo')) _updateComboFoldBoundsRef?.();
      const x = parseInt(panel.style.left, 10);
      const y = parseInt(panel.style.top,  10);
      const w = parseInt(panel.style.width,  10);
      const h = parseInt(panel.style.height, 10);
      if (!(Number.isFinite(x) && Number.isFinite(y))) return;
      if (key) {
        savePanelSize(key, { x, y, width: Number.isFinite(w) ? w : undefined, height: Number.isFinite(h) ? h : undefined });
      } else if (isAudio) {
        const side = (panel.id || '').includes('out') ? 'out' : 'in';
        const posKey  = side === 'out' ? 'audioOutPos'  : 'audioInPos';
        const sizeKey = side === 'out' ? 'audioOutSize' : 'audioInSize';
        const cfgPartial = { [posKey]: { x, y } };
        if (Number.isFinite(w) && Number.isFinite(h)) cfgPartial[sizeKey] = { width: w, height: h };
        try { window.dash?.setConfig?.(cfgPartial); } catch {}
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function attachResize(panel) {
  // All panels — regular + audio-grid — get the same 8 handles. Key
  // may be null for audio; the handler routes persistence through
  // audio{In,Out}{Pos,Size} cfg keys in that case.
  const key = panelKey(panel);
  for (const d of ['nw','ne','sw','se','n','s','e','w']) {
    makeResizeHandle(panel, key, d);
  }
}

// ── Column-edge resize ───────────────────────────────────────────────
// Side-column elements get 4 edge handles:
//
//   l / r   horizontal resize. Drags the moving edge of every panel
//           in the flush cohort (same x + width, vertically touching);
//           the opposite edge stays anchored. Lets the user shrink the
//           whole column toward the screen edge or grow it back toward
//           the productivity panel as one gesture.
//
//   n / s   vertical joint resize. Walks one panel up or down inside
//           the cohort and slides the shared border between this panel
//           and its flush neighbour; the two heights sum stays constant
//           (one grows, the other shrinks). Other column members are
//           untouched. Bails if there's no flush neighbour on that side.
//
// Works for both .panel and .audio-grid elements — audio strips behave
// the same as data panels for both gestures. Title-bar drag (panels)
// or center-body drag (audio) still moves an individual element and
// breaks the stack.
function attachColumnEdge(el) {
  if (el.classList.contains('panel-combo')) return; // combo owns its own e/w resize
  const isAudio = el.classList.contains('audio-grid');
  const isPanel = el.classList.contains('panel');
  if (!isAudio && !isPanel) return;
  if (isPanel && !panelKey(el)) return;
  for (const side of ['l', 'r', 'n', 's']) {
    const handle = document.createElement('div');
    handle.className = `column-edge-handle column-edge-handle-${side}`;
    handle.title = side === 'l' || side === 'r'
      ? 'Drag horizontally to resize the column width'
      : 'Drag vertically to resize this panel and its neighbour';
    el.appendChild(handle);
    if (side === 'l' || side === 'r') {
      handle.addEventListener('mousedown', (e) => onColumnHorizResize(e, el, side));
    } else {
      handle.addEventListener('mousedown', (e) => onColumnVertJointResize(e, el, side));
    }
  }
}

// Horizontal column resize. The moved edge tracks the cursor; the
// opposite edge of every cohort member stays anchored. Clamped by
// PANEL_MIN_W / AUDIO_MIN_W (per-member) and by any non-cohort
// element that vertically overlaps the cohort on the moving side.
function onColumnHorizResize(e, el, side) {
  if (_uiLocked) return;
  // Always swallow so the underlying element's own body-drag handler
  // (audio-grid in particular) never fires from a column-edge click.
  e.preventDefault();
  e.stopPropagation();
  const cohort = buildColumnCohort(el);
  if (!cohort.members.length) return;
  const isWest = side === 'l';

  for (const m of cohort.members) {
    const r = m.el.getBoundingClientRect();
    m.startLeft   = r.left;
    m.startTop    = r.top;
    m.startWidth  = r.width;
    m.startHeight = r.height;
    m.el.style.position = 'fixed';
    m.el.style.left   = `${r.left}px`;
    m.el.style.top    = `${r.top}px`;
    m.el.style.width  = `${r.width}px`;
    m.el.style.height = `${r.height}px`;
    m.el.classList.add('is-resizing');
  }

  // Per-member min-width — audio strips are allowed narrower than data panels.
  const minWidthOf = (m) => m.kind === 'audio' ? AUDIO_MIN_W : PANEL_MIN_W;
  // Use the ORIGIN panel's geometry for column bounds — every cohort
  // member force-aligns to this during drag so audio strips with
  // slightly different starting width snap into perfect column
  // alignment as soon as the user touches the edge.
  const colLeft  = (cohort.members.find((m) => m.el === el) || cohort.members[0]).startLeft;
  const colRight = colLeft + (cohort.members.find((m) => m.el === el) || cohort.members[0]).startWidth;
  const minW = Math.max(...cohort.members.map(minWidthOf));

  // Bounds for the moving edge in viewport coordinates.
  let edgeMin, edgeMax;
  if (isWest) {
    edgeMin = 0;
    edgeMax = colRight - minW;
  } else {
    edgeMin = colLeft + minW;
    edgeMax = window.innerWidth;
  }
  // Clamp against non-cohort elements that vertically intersect any member.
  const others = getNonCohortRects(cohort);
  for (const m of cohort.members) {
    const myMidY = m.startTop + m.startHeight / 2;
    const myCenterX = m.startLeft + m.startWidth / 2;
    for (const n of others) {
      if (n.bottom <= m.startTop + 0.5 || n.top >= m.startTop + m.startHeight - 0.5) continue;
      const nCenter = (n.left + n.right) / 2;
      if (isWest && nCenter < myCenterX && n.right > edgeMin) edgeMin = n.right;
      if (!isWest && nCenter > myCenterX && n.left  < edgeMax) edgeMax = n.left;
      void myMidY;
    }
  }
  if (edgeMax < edgeMin) edgeMax = edgeMin;

  const onMove = (ev) => {
    const g = ev.altKey ? null : getGridSize();
    let edgePos = ev.clientX;
    if (g) edgePos = snap(edgePos, g.w);
    edgePos = Math.max(edgeMin, Math.min(edgeMax, edgePos));
    // Force-align every cohort member to the dragged column. Members
    // that were misaligned (audio strip slightly narrower or shifted)
    // snap into the column as soon as the drag begins.
    for (const m of cohort.members) {
      if (isWest) {
        const newLeft  = edgePos;
        const newWidth = colRight - newLeft;
        m.el.style.left  = `${Math.round(newLeft)}px`;
        m.el.style.width = `${Math.round(newWidth)}px`;
      } else {
        const newLeft  = colLeft;
        const newWidth = edgePos - colLeft;
        m.el.style.left  = `${Math.round(newLeft)}px`;
        m.el.style.width = `${Math.round(newWidth)}px`;
      }
    }
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    for (const m of cohort.members) {
      m.el.classList.remove('is-resizing');
      persistColumnMemberGeom(m);
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Vertical joint resize between this element and its flush neighbour.
// `side === 'n'` looks for a flush neighbour above (the neighbour's
// bottom touches this element's top); `'s'` looks for a flush neighbour
// below. The pair's combined height stays constant — the shared border
// slides under the cursor, redistributing height between top and bottom.
// When there's no flush neighbour on that side we let the event fall
// through so the underlying handler (title-bar drag / audio body drag)
// can still take over — the top edge of the column-topmost panel
// otherwise becomes a dead zone.
function onColumnVertJointResize(e, el, side) {
  if (_uiLocked) return;
  const neighbor = findFlushVerticalNeighbor(el, side === 'n' ? 'up' : 'down');
  if (!neighbor) return;
  e.preventDefault();
  e.stopPropagation();
  const top = side === 'n' ? neighbor : el;
  const bot = side === 'n' ? el : neighbor;
  const topRect = top.getBoundingClientRect();
  const botRect = bot.getBoundingClientRect();
  const topStart  = topRect.top;
  const topStartH = topRect.height;
  const botStartH = botRect.height;
  const totalH    = topStartH + botStartH;

  for (const el2 of [top, bot]) {
    const r = el2.getBoundingClientRect();
    el2.style.position = 'fixed';
    el2.style.left   = `${r.left}px`;
    el2.style.top    = `${r.top}px`;
    el2.style.width  = `${r.width}px`;
    el2.style.height = `${r.height}px`;
    el2.classList.add('is-resizing');
  }

  const minTopH = top.classList.contains('audio-grid') ? AUDIO_MIN_H : PANEL_MIN_H;
  const minBotH = bot.classList.contains('audio-grid') ? AUDIO_MIN_H : PANEL_MIN_H;
  const minBorder = topStart + minTopH;
  const maxBorder = topStart + totalH - minBotH;

  const onMove = (ev) => {
    const g = ev.altKey ? null : getGridSize();
    let borderY = ev.clientY;
    if (g) borderY = snap(borderY, g.h);
    borderY = Math.max(minBorder, Math.min(maxBorder, borderY));
    const newTopH = borderY - topStart;
    const newBotH = totalH - newTopH;
    top.style.height = `${Math.round(newTopH)}px`;
    bot.style.top    = `${Math.round(borderY)}px`;
    bot.style.height = `${Math.round(newBotH)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    for (const el2 of [top, bot]) {
      el2.classList.remove('is-resizing');
      persistElementGeom(el2);
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Element-level geom save — dispatches to panel or audio persistence
// based on the element kind. Reads the current inline styles.
function persistElementGeom(el) {
  const x = parseInt(el.style.left,   10);
  const y = parseInt(el.style.top,    10);
  const w = parseInt(el.style.width,  10);
  const h = parseInt(el.style.height, 10);
  if (el.classList.contains('audio-grid')) {
    const isOut = (el.id || '').includes('out');
    const posKey  = isOut ? 'audioOutPos'  : 'audioInPos';
    const sizeKey = isOut ? 'audioOutSize' : 'audioInSize';
    const partial = {};
    if (Number.isFinite(x) && Number.isFinite(y)) partial[posKey]  = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial[sizeKey] = { width: w, height: h };
    if (Object.keys(partial).length) {
      try { window.dash?.setConfig?.(partial); } catch {}
    }
  } else {
    const key = panelKey(el);
    if (!key) return;
    const partial = {};
    if (Number.isFinite(x)) partial.x = x;
    if (Number.isFinite(y)) partial.y = y;
    if (Number.isFinite(w)) partial.width  = w;
    if (Number.isFinite(h)) partial.height = h;
    if (Object.keys(partial).length) savePanelSize(key, partial);
  }
}

// Cohort-member geom save (uses the member's kind hint). Same persistence
// targets as persistElementGeom but skipping the classList check.
function persistColumnMemberGeom(m) {
  const x = parseInt(m.el.style.left,   10);
  const y = parseInt(m.el.style.top,    10);
  const w = parseInt(m.el.style.width,  10);
  const h = parseInt(m.el.style.height, 10);
  if (m.kind === 'audio') {
    const posKey  = m.audioSide === 'in' ? 'audioInPos'  : 'audioOutPos';
    const sizeKey = m.audioSide === 'in' ? 'audioInSize' : 'audioOutSize';
    const partial = {};
    if (Number.isFinite(x) && Number.isFinite(y)) partial[posKey]  = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial[sizeKey] = { width: w, height: h };
    if (Object.keys(partial).length) {
      try { window.dash?.setConfig?.(partial); } catch {}
    }
  } else if (m.key) {
    const partial = {};
    if (Number.isFinite(x)) partial.x = x;
    if (Number.isFinite(y)) partial.y = y;
    if (Number.isFinite(w)) partial.width  = w;
    if (Number.isFinite(h)) partial.height = h;
    if (Object.keys(partial).length) savePanelSize(m.key, partial);
  }
}

// Find the element in the same column (same x, same width) whose
// bottom is flush against this element's top (`dir === 'up'`) or whose
// top is flush against this element's bottom (`dir === 'down'`). Tol 2 px.
function findFlushVerticalNeighbor(el, dir) {
  const tol = 2;
  const r = el.getBoundingClientRect();
  for (const candidate of document.querySelectorAll('.panel:not(.panel-combo), .audio-grid')) {
    if (candidate === el) continue;
    if (candidate.classList.contains('is-collapsed')) continue;
    const cr = candidate.getBoundingClientRect();
    if (Math.abs(cr.left  - r.left)  > tol) continue;
    if (Math.abs(cr.width - r.width) > tol) continue;
    if (dir === 'up'   && Math.abs(cr.bottom - r.top)    <= tol) return candidate;
    if (dir === 'down' && Math.abs(cr.top    - r.bottom) <= tol) return candidate;
  }
  return null;
}

// Collect bounding rects for every visible non-cohort panel + audio-grid.
function getNonCohortRects(cohort) {
  const cohortSet = new Set(cohort.members.map((m) => m.el));
  const out = [];
  for (const el of document.querySelectorAll('.panel, .audio-grid')) {
    if (cohortSet.has(el)) continue;
    if (el.classList.contains('is-collapsed')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  return out;
}

// Column cohort = every panel + audio-grid living in the same
// vertical band as `originPanel`. "Same column" is now overlap-based
// (≥50% of the narrower element's width lies inside the origin's
// horizontal range) instead of strict left/width equality, so an
// audio strip that the user has shrunk/shifted slightly still joins
// the cohort and scales with the panels above it. Vertical gaps no
// longer break the cohort either — anything in the column travels
// together, even if there's empty space between members.
function buildColumnCohort(originPanel) {
  const rOrigin = originPanel.getBoundingClientRect();
  const cands = [];
  for (const el of document.querySelectorAll('.panel:not(.panel-combo), .audio-grid')) {
    if (el.classList.contains('is-collapsed')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const overlap = Math.max(0, Math.min(r.right, rOrigin.right) - Math.max(r.left, rOrigin.left));
    const narrowW = Math.max(1, Math.min(r.width, rOrigin.width));
    if (overlap / narrowW < 0.5) continue;
    cands.push({ el, top: r.top });
  }
  cands.sort((a, b) => a.top - b.top);
  const members = cands.map((c) => {
    const isAudio = c.el.classList.contains('audio-grid');
    const id = c.el.id || '';
    return {
      el: c.el,
      kind: isAudio ? 'audio' : 'panel',
      key:  isAudio ? null : panelKey(c.el),
      audioSide: isAudio ? (id.includes('out') ? 'out' : 'in') : null,
    };
  });
  return { members };
}

document.querySelectorAll('.panel').forEach((panel) => {
  attachResize(panel);
  attachDrag(panel);
});
// Audio grids + media panel go through the EXACT same path as a
// regular panel: 8-handle resize via attachResize + header drag via
// attachDrag. Persistence routes through their own cfg keys
// (audio{In,Out}{Pos,Size}) inside the shared handlers when
// panelKey is null.
document.querySelectorAll('.audio-grid').forEach((el) => {
  attachResize(el);
  attachDrag(el);
});

// Side-aware collapse chevron. The arrow lives on the panel's
// INSIDE-facing edge (right for left-column panels, left for right-
// column panels) and collapsing pins the panel as a thin strip at
// the corresponding OUTER edge of the viewport. The center
// productivity panel (panel-combo) keeps its vertical fold behavior;
// only true side panels get this treatment.
function attachCollapseButton(panel) {
  const key = panelKey(panel);
  const header = panel.querySelector('.panel-header');
  if (!key || !header) return;
  const isCombo = panel.classList.contains('panel-combo');
  // Combo panel uses its own bottom-bar pill button for vertical
  // collapse (see combo-collapse-toggle in HTML). Skip the in-header
  // chevron entirely — collapse affordance lives at the bottom now.
  if (isCombo) return;
  const btn = document.createElement('button');
  btn.className = 'panel-collapse-btn';
  btn.type = 'button';
  btn.title = 'Collapse / expand';
  btn.textContent = '▾';
  // Stop drag from kicking in when clicking the chevron in the (draggable) header.
  btn.addEventListener('mousedown', (e) => e.stopPropagation());

  // Re-evaluate which side of the viewport this panel currently sits
  // on. Drives the .panel-side-left / .panel-side-right class flip
  // that CSS uses to position the arrow on the inside edge.
  function _refreshSideClass() {
    if (isCombo) return;
    const r = panel.getBoundingClientRect();
    if (r.width < 2) return;
    const isLeft = (r.left + r.width / 2) < (window.innerWidth / 2);
    panel.classList.toggle('panel-side-left',  isLeft);
    panel.classList.toggle('panel-side-right', !isLeft);
  }
  _refreshSideClass();
  // Refresh on viewport changes — auto-orient + monitor swaps shuffle
  // panels between columns. Cheap enough to wire to resize directly.
  window.addEventListener('resize', () => { clearTimeout(panel._sideTo); panel._sideTo = setTimeout(_refreshSideClass, 200); });

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Combo panel keeps its original up/down collapse — the side-edge
    // pin doesn't make sense for a center-anchored productivity pane.
    if (isCombo) {
      panel.classList.toggle('is-collapsed');
      if (window.dash?.getConfig && window.dash?.setConfig) {
        const cfg = await window.dash.getConfig();
        const collapsed = { ...(cfg.collapsed || {}) };
        collapsed[key] = panel.classList.contains('is-collapsed');
        await window.dash.setConfig({ collapsed });
      }
      return;
    }
    _refreshSideClass();
    const willCollapse = !panel.classList.contains('is-collapsed');
    if (willCollapse) {
      // Snapshot the live geometry so we can restore it on expand.
      const r = panel.getBoundingClientRect();
      panel.dataset.origLeft   = String(Math.round(r.left));
      panel.dataset.origTop    = String(Math.round(r.top));
      panel.dataset.origWidth  = String(Math.round(r.width));
      panel.dataset.origHeight = String(Math.round(r.height));
      panel.classList.add('is-collapsed');
      const STUB = 30;
      const isLeft = panel.classList.contains('panel-side-left');
      const newX = isLeft ? 0 : (window.innerWidth - STUB);
      applyPanelSize(panel, { x: newX, y: Math.round(r.top), width: STUB, height: Math.round(r.height) });
    } else {
      panel.classList.remove('is-collapsed');
      const x = Number(panel.dataset.origLeft);
      const y = Number(panel.dataset.origTop);
      const w = Number(panel.dataset.origWidth);
      const h = Number(panel.dataset.origHeight);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)) {
        applyPanelSize(panel, { x, y, width: w, height: h });
      }
    }
    if (window.dash?.getConfig && window.dash?.setConfig) {
      const cfg = await window.dash.getConfig();
      const collapsed = { ...(cfg.collapsed || {}) };
      collapsed[key] = panel.classList.contains('is-collapsed');
      await window.dash.setConfig({ collapsed });
    }
  });
  header.appendChild(btn);
}

document.querySelectorAll('.panel').forEach(attachCollapseButton);

// Combo panel fold buttons — half-down + full-down. Sit beside the existing
// collapse chevron in the header. Each button toggles its state; clicking
// the active button returns the panel to its default size. The panel is
// re-anchored to its grid-cell column via CSS custom properties so it
// extends straight down without shifting horizontally.
function attachComboFoldButtons(panel) {
  const header = panel.querySelector('.panel-header');
  if (!header) return;
  const collapseBtn = header.querySelector('.panel-collapse-btn');

  // (Half-down ◐ button removed — full / focus / light cover the same
  // territory and the user wanted the row simpler.)

  const fullBtn = document.createElement('button');
  fullBtn.className = 'panel-collapse-btn panel-fold-btn panel-fold-btn-full';
  fullBtn.type = 'button';
  fullBtn.title = 'Fold full-down';
  fullBtn.textContent = '●';

  // Screen-fill ("heavy" focus): fixed overlay covering nearly the
  // whole viewport with a dim backdrop behind it AND the dashboard
  // pinned always-on-top so the panel stays visible above every other
  // app. For deep focus on one pane.
  const screenBtn = document.createElement('button');
  screenBtn.className = 'panel-collapse-btn panel-fold-btn panel-fold-btn-screen';
  screenBtn.type = 'button';
  screenBtn.title = 'Focus mode (always-on-top, dim backdrop)';
  screenBtn.textContent = '⛶';

  // (▢ native-fullscreen button removed — the screenBtn ⛶ focus mode
  // covers the same "make this panel huge" need, and F11 / dash IPC
  // still provide true OS fullscreen when wanted.)

  // Walk every visible non-combo panel and audio grid, classify each as
  // "left column" (center to the left of viewport center) or "right
  // column", and record the rightmost-right-edge / leftmost-left-edge.
  // The combo panel's fold geometry is pinned between those edges plus
  // a small gap so half/full/collapse never overlap any side panel.
  function _updateComboFoldBounds() {
    const vw = window.innerWidth;
    const cx = vw / 2;
    let leftMax  = 0;
    let rightMin = vw;
    // Include both .panel siblings and .audio-grid floats so audio
    // visualizers at the bottom corners are respected too.
    document.querySelectorAll('.panel:not(.panel-combo), .audio-grid').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const center = (r.left + r.right) / 2;
      if (center < cx) leftMax  = Math.max(leftMax,  r.right);
      else             rightMin = Math.min(rightMin, r.left);
    });
    // GAP = 0: per user spec the combo panel butts directly against
    // the side panels on left + right. Vertical top still uses a tiny
    // inset to clear the topbar edge if there's no inline override.
    const GAP = 0;
    const TOP_INSET = 12;
    // Preserve the user's manually-set top: if the panel has an
    // inline top set (from drag), use that. Otherwise fall back to
    // sitting just below the topbar like before. This is the
    // "make the top never move unless I move it" rule.
    let top;
    const inlineTop = parseInt(panel.style.top, 10);
    if (Number.isFinite(inlineTop)) {
      top = inlineTop;
    } else {
      top = TOP_INSET;
    }
    panel.style.setProperty('--combo-fold-top',   `${top}px`);
    panel.style.setProperty('--combo-fold-left',  `${Math.round(leftMax + GAP)}px`);
    panel.style.setProperty('--combo-fold-right', `${Math.round(vw - rightMin + GAP)}px`);
  }
  // Expose so initFromConfig can recompute the bounds the moment panel
  // positions are applied — otherwise a saved-collapsed combo boots at
  // the CSS fallback (left: 480px) and overlaps the chrono panel.
  _updateComboFoldBoundsRef = _updateComboFoldBounds;

  function applyFold(mode) {
    panel.classList.remove('is-fold-half', 'is-fold-full', 'is-fold-screen', 'is-collapsed');
    fullBtn.classList.toggle('is-active',   mode === 'full');
    screenBtn.classList.toggle('is-active', mode === 'screen');
    document.body.classList.toggle('is-combo-fold-full',   mode === 'full' || mode === 'screen');
    document.body.classList.toggle('is-combo-fold-screen', mode === 'screen');
    try { window.dash?.setAlwaysOnTop?.(mode === 'screen'); } catch {}
    panel.style.removeProperty('--fold-top');
    panel.style.removeProperty('--fold-left');
    panel.style.removeProperty('--fold-width');
    if (!mode) return;
    if (mode === 'screen') { panel.classList.add('is-fold-screen'); return; }
    // Full / collapse modes: re-measure side panels before applying
    // the class so the fold uses fresh geometry every time.
    _updateComboFoldBounds();
    if (mode === 'full')   { panel.classList.add('is-fold-full');   return; }
  }
  // The combo panel is always pinned horizontally now (see base CSS
  // rule for .panel-combo), so the bounds need to refresh on EVERY
  // viewport resize — not just when a fold class is active. Run once
  // immediately so the CSS vars have correct values from mount.
  _updateComboFoldBounds();
  window.addEventListener('resize', _updateComboFoldBounds);

  fullBtn.addEventListener('mousedown',   (e) => e.stopPropagation());
  screenBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-full') ? null : 'full');
  });
  screenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-screen') ? null : 'screen');
  });

  // Group the remaining controls (collapse + full + screen) in a
  // single flex wrapper so they hug the right edge of the header
  // instead of being separated by the grid's auto columns.
  const group = document.createElement('span');
  group.className = 'panel-fold-group';
  if (collapseBtn) group.appendChild(collapseBtn);
  group.appendChild(fullBtn);
  group.appendChild(screenBtn);
  header.appendChild(group);

  // Existing collapse chevron must clear any fold state so the three modes
  // are mutually exclusive. Also re-measure side-panel bounds so the
  // collapsed header sits in the centered gap, not at its grid column.
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      if (panel.classList.contains('is-collapsed')) {
        applyFold(null);
        panel.classList.add('is-collapsed');
        _updateComboFoldBounds();
      } else {
        _updateComboFoldBounds();
      }
    });
  }

  // Re-pin geometry on viewport resize while a fold is active (the column
  // width can change when the dashboard window is resized). Screen mode
  // is pinned to viewport edges by CSS so it doesn't need re-pinning.
  window.addEventListener('resize', () => {
    if (panel.classList.contains('is-fold-full')) { applyFold('full'); return; }
  });

  // ── Bottom-bar one-click vertical collapse ─────────────────────────
  // Replaces the prior header chevron. The pill button sits below the
  // panel-body/footer (see .combo-bottom-bar in HTML) so it remains
  // visible after .is-collapsed display:none's the body+footer. The
  // arrow inside flips on collapse via CSS.
  const bottomToggle = panel.querySelector('#combo-collapse-toggle');
  if (bottomToggle) {
    // Don't let the click bubble to the panel-drag mousedown handler.
    bottomToggle.addEventListener('mousedown', (e) => e.stopPropagation());
    bottomToggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Clear any active fold first so this acts as a clean toggle —
      // fold-full / fold-screen have their own positioning that the
      // basic is-collapsed shouldn't compete with.
      if (panel.classList.contains('is-fold-full') ||
          panel.classList.contains('is-fold-screen')) {
        applyFold(null);
      }
      panel.classList.toggle('is-collapsed');
      // Persist so a reload reopens to the same state.
      if (window.dash?.getConfig && window.dash?.setConfig) {
        try {
          const cfg = await window.dash.getConfig();
          const collapsed = { ...(cfg.collapsed || {}) };
          collapsed[panelKey(panel)] = panel.classList.contains('is-collapsed');
          await window.dash.setConfig({ collapsed });
        } catch {}
      }
    });
  }
}

document.querySelectorAll('.panel-combo').forEach(attachComboFoldButtons);

// ── Combo (Productivity) panel — mode switcher across notes, paper,
//     explore, rec-room, browser, tasks, music, stream. ─────────────
const comboPanel = document.querySelector('.panel-combo');
if (comboPanel) {
  const titleEl       = comboPanel.querySelector('#combo-title');
  const codeEl        = comboPanel.querySelector('#combo-code');
  const tagEl         = comboPanel.querySelector('#combo-tag');
  const footerLabelEl = comboPanel.querySelector('#combo-footer-label');
  const notesPane     = comboPanel.querySelector('.combo-pane-notes');
  const notesTabCount = document.getElementById('notes-tab-count');

  const paperPane    = comboPanel.querySelector('.combo-pane-paper');
  const paperStatsEl = document.getElementById('paper-stats');
  const explorePane     = comboPanel.querySelector('.combo-pane-explore');
  const visualizerPane  = comboPanel.querySelector('.combo-pane-visualizer');
  const editPane        = comboPanel.querySelector('.combo-pane-edit');
  const browserPane     = comboPanel.querySelector('.combo-pane-browser');
  const tasksPane       = comboPanel.querySelector('.combo-pane-tasks');
  const musicPane       = comboPanel.querySelector('.combo-pane-music');
  const streamPane      = comboPanel.querySelector('.combo-pane-stream');
  const mailPane        = comboPanel.querySelector('.combo-pane-mail');

  function paintComboHeader() {
    // Bail while the OFFLINE → STANDBY → ONLINE boot state machine owns
    // the header chrome. It clears bootStatus + calls this function
    // itself once boot settles, handing the header back to mode paint.
    if (comboPanel.dataset.bootStatus === '1') return;
    const mode = comboPanel.dataset.mode || 'notes';
    // Parent name stays "PRODUCTIVITY" across every mode — the active
    // sub-mode is reflected in the em-chip (N1/X1/P1/W1/E1/V1) and in the
    // code slot below the title (NOTES · SCRATCHPAD, etc).
    if (mode === 'notes') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>N1</em>';
      codeEl.textContent = 'NOTES · SCRATCHPAD';
      tagEl.textContent = notesTabCount?.textContent || '—';
      footerLabelEl.textContent = 'NOTES STATUS';
    } else if (mode === 'paper') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>P1</em>';
      codeEl.textContent = 'PAPER · WORD PROCESSOR';
      tagEl.textContent = paperStatsEl?.textContent || '—';
      footerLabelEl.textContent = 'PAPER STATUS';
    } else if (mode === 'explore') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>E1</em>';
      codeEl.textContent = 'EXPLORE · GALLERY · DOCS';
      tagEl.textContent = '—';
      footerLabelEl.textContent = 'EXPLORE STATUS';
    } else if (mode === 'visualizer') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>R1</em>';
      codeEl.textContent = 'REC ROOM · CAPTURE STUDIO';
      tagEl.textContent = '—';
      footerLabelEl.textContent = 'CAPTURE';
    } else if (mode === 'edit') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>D1</em>';
      codeEl.textContent = 'EDIT ROOM · CUT';
      tagEl.textContent = window._editProject?.duration
        ? `${Math.round(window._editProject.duration)}s`
        : '—';
      footerLabelEl.textContent = 'EDIT STATUS';
    } else if (mode === 'browser') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>B1</em>';
      codeEl.textContent = 'BROWSER · PRIVATE';
      tagEl.textContent = window._browserState?.tabs?.length ? `${window._browserState.tabs.length} TAB${window._browserState.tabs.length === 1 ? '' : 'S'}` : '—';
      footerLabelEl.textContent = 'BROWSER URL';
    } else if (mode === 'tasks') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>T1</em>';
      codeEl.textContent = 'TASKS · PROCESS MONITOR';
      tagEl.textContent = window._tasksState?.procCount != null
        ? `${window._tasksState.procCount} PROC`
        : '—';
      footerLabelEl.textContent = 'TASK STATUS';
    } else if (mode === 'music') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>M1</em>';
      codeEl.textContent = 'BACKGROUND MUSIC · AMBIENT';
      tagEl.textContent = window._bgmState?.playing
        ? (window._bgmState.genre || '—').toUpperCase()
        : 'IDLE';
      footerLabelEl.textContent = 'MUSIC STATUS';
    } else if (mode === 'stream') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>S1</em>';
      codeEl.textContent = 'STREAM · EMBEDS';
      tagEl.textContent = '—';
      footerLabelEl.textContent = 'STREAM STATUS';
    } else if (mode === 'mail') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>MX1</em>';
      codeEl.textContent = 'MAIL · IMAP READER';
      tagEl.textContent = window._mailState?.unread != null
        ? `${window._mailState.unread} UNREAD`
        : '—';
      footerLabelEl.textContent = 'MAIL STATUS';
    } else {
      // Unknown mode — fall back to notes header so the chrome doesn't
      // strand with a stale label. setComboMode validates the input
      // against VALID before dispatch, so this branch should be
      // unreachable in practice.
      titleEl.innerHTML = 'PRODUCTIVITY <em>N1</em>';
      codeEl.textContent = 'NOTES · SCRATCHPAD';
      tagEl.textContent = '—';
      footerLabelEl.textContent = 'NOTES STATUS';
    }
  }

  // ── Lazy combo panes ───────────────────────────────────────────
  // Each entry's code lives in its own file and is fetched as a
  // separate Vite chunk only the first time its tab is opened — it
  // never parses or runs at startup. Modules export init() (one-time
  // setup), activate() (tab shown) and deactivate() (tab left).
  const _lazyPaneImports = {
    stream:     () => import('./features/stream.js'),
    explore:    () => import('./features/explore.js'),
    browser:    () => import('./features/browser.js'),
    visualizer: () => import('./features/visualizer.js'),
    edit:       () => import('./features/edit.js'),
    music:      () => import('./features/music.js'),
    mail:       () => import('./features/mail.js'),
  };
  const _lazyPaneState = {};   // mode -> loaded module
  // Seeded here (not in visualizer.js) so file deletes made in EXPLORE
  // before REC ROOM is ever opened still get recorded for UNDO.
  window._visualizerUndoStack = window._visualizerUndoStack || [];
  // Dependencies handed to each lazy pane's init() so the extracted
  // modules stay free of this file's enclosing scope.
  const _paneDeps = {
    fmtBytes,
    playSfx,
    paintComboHeader,
    // EXPLORE hands delete batches to the VISUALIZER undo stack. The
    // refresh callback is a no-op until REC ROOM has been opened.
    pushUndo: (batch) => {
      window._visualizerUndoStack.push({ batch, at: Date.now() });
      try { window._visualizerRefreshUndoBtn?.(); } catch {}
    },
    // Lets a pane switch the combo to another mode — used by REC ROOM's
    // EDIT button on a capture row to bounce the user into EDIT ROOM
    // with the clicked clip as the source.
    setComboMode: (mode) => setComboMode(mode),
  };

  function activateLazyPane(mode) {
    // Detach any other lazy pane that's currently loaded + active.
    for (const k of Object.keys(_lazyPaneState)) {
      if (k !== mode) { try { _lazyPaneState[k]?.deactivate?.(); } catch {} }
    }
    const importer = _lazyPaneImports[mode];
    if (!importer) return;
    const loaded = _lazyPaneState[mode];
    if (loaded) { try { loaded.activate?.(); } catch {} return; }
    importer().then(async (m) => {
      _lazyPaneState[mode] = m;
      try { await m.init?.(_paneDeps); } catch (e) { console.warn(`[pane:${mode}] init failed`, e); }
      try { m.activate?.(); } catch (e) { console.warn(`[pane:${mode}] activate failed`, e); }
    }).catch((e) => console.warn(`[pane:${mode}] load failed`, e));
  }

  function setComboMode(mode, persist = true) {
    const VALID = new Set(['notes', 'paper', 'explore', 'visualizer', 'edit', 'browser', 'tasks', 'music', 'stream', 'mail']);
    if (!VALID.has(mode)) mode = 'notes';
    comboPanel.dataset.mode = mode;
    notesPane     ?.classList.toggle('is-visible', mode === 'notes');
    paperPane     ?.classList.toggle('is-visible', mode === 'paper');
    explorePane   ?.classList.toggle('is-visible', mode === 'explore');
    visualizerPane?.classList.toggle('is-visible', mode === 'visualizer');
    editPane      ?.classList.toggle('is-visible', mode === 'edit');
    browserPane   ?.classList.toggle('is-visible', mode === 'browser');
    tasksPane     ?.classList.toggle('is-visible', mode === 'tasks');
    musicPane     ?.classList.toggle('is-visible', mode === 'music');
    streamPane    ?.classList.toggle('is-visible', mode === 'stream');
    mailPane      ?.classList.toggle('is-visible', mode === 'mail');
    // Music meter visibility — drives whether the rAF redraw chain runs
    // (see _bgmDrawMeter + window._bgmMaybeStartMeter in the music init
    // block). When music tab isn't visible we skip canvas work entirely;
    // music itself keeps playing through the BGM audio graph.
    window._isMusicTabVisible = (mode === 'music');
    if (window._isMusicTabVisible) {
      try { window._bgmMaybeStartMeter?.(); } catch {}
    }
    comboPanel.querySelectorAll('.combo-mode-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
    _comboInVisualizer = (mode === 'visualizer');
    paintComboHeader();
    if (mode === 'tasks') {
      refreshTasksNow();
      // Wire-graph caches data even while the pane is hidden but only
      // paints when visible; render once on activation so the user
      // doesn't stare at a blank chart until the next sample arrives.
      requestAnimationFrame(drawTasksGraph);
    }
    // Lazy combo panes (STREAM, …) — load the module on first open,
    // then activate it / deactivate any other lazy pane that was up.
    activateLazyPane(mode);
    if (persist && window.dash?.setConfig) window.dash.setConfig({ comboMode: mode });
  }

  comboPanel.querySelectorAll('.combo-mode-tab').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't drag-grab
    btn.addEventListener('click', () => setComboMode(btn.dataset.mode));
  });

  // ── Reorderable combo-mode tabs ────────────────────────────────
  // Native HTML5 drag inside .combo-mode-tabs. Same pattern as the
  // topbar reorder + CREATE preset reorder: setDragImage centred on
  // the cursor, a dim-while-dragging class added one frame after
  // dragstart (so the ghost keeps full opacity), drop position
  // computed by sibling midpoint. Order persists as cfg.comboModeOrder
  // (array of data-mode strings) and re-applies on load.
  const comboTabsEl = comboPanel.querySelector('.combo-mode-tabs');
  if (comboTabsEl) {
    const tabsList = () => Array.from(comboTabsEl.querySelectorAll('.combo-mode-tab'));
    for (const btn of tabsList()) btn.draggable = true;
    let _modeDragged = null;
    let _modeDragMoved = false;
    comboTabsEl.addEventListener('dragstart', (e) => {
      const t = e.target.closest?.('.combo-mode-tab');
      if (!t || t.parentElement !== comboTabsEl) return;
      _modeDragged = t;
      _modeDragMoved = false;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        const r = t.getBoundingClientRect();
        try { e.dataTransfer.setDragImage(t, r.width / 2, r.height / 2); } catch {}
      }
      requestAnimationFrame(() => t.classList.add('is-mode-dragging'));
    });
    comboTabsEl.addEventListener('dragover', (e) => {
      if (!_modeDragged) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const x = e.clientX;
      const sibs = tabsList().filter((c) => c !== _modeDragged);
      let before = null;
      for (const el of sibs) {
        const r = el.getBoundingClientRect();
        if (x < r.left + r.width / 2) { before = el; break; }
      }
      if (before && _modeDragged.nextElementSibling !== before) {
        comboTabsEl.insertBefore(_modeDragged, before);
        _modeDragMoved = true;
      } else if (!before && _modeDragged !== comboTabsEl.lastElementChild) {
        comboTabsEl.appendChild(_modeDragged);
        _modeDragMoved = true;
      }
    });
    comboTabsEl.addEventListener('dragend', async () => {
      if (_modeDragged) _modeDragged.classList.remove('is-mode-dragging');
      _modeDragged = null;
      if (_modeDragMoved && window.dash?.setConfig) {
        const order = tabsList().map((b) => b.dataset.mode);
        try { await window.dash.setConfig({ comboModeOrder: order }); } catch {}
      }
    });
    // Restore saved order on load. Any mode not present in the saved
    // list (added in a later build) stays in its HTML position at the
    // end so new features don't disappear after an update.
    (async () => {
      const cfg = (await window.dash?.getConfig?.()) || {};
      const order = cfg.comboModeOrder;
      if (!Array.isArray(order) || !order.length) return;
      const byMode = Object.fromEntries(tabsList().map((b) => [b.dataset.mode, b]));
      const seen = new Set();
      for (const mode of order) {
        const btn = byMode[mode];
        if (!btn) continue;
        comboTabsEl.appendChild(btn);
        seen.add(mode);
      }
      for (const btn of tabsList()) {
        if (!seen.has(btn.dataset.mode)) comboTabsEl.appendChild(btn);
      }
    })();
  }

  // Keep the visible tag/code chip in sync with whichever mode is active —
  // the underlying notes code keeps writing to the original hidden IDs.
  if (notesTabCount) new MutationObserver(paintComboHeader).observe(notesTabCount, { childList: true, characterData: true, subtree: true });
  if (paperStatsEl)  new MutationObserver(paintComboHeader).observe(paperStatsEl,  { childList: true, characterData: true, subtree: true });

  // ── EXPLORE tab ──────────────────────────────────────────────────────
  // Lazy combo pane — code lives in features/explore.js, loaded on first
  // open by activateLazyPane(). Its injected pushUndo dep feeds deletes
  // into the VISUALIZER undo stack.

  // ── VISUALIZER / REC ROOM tab ────────────────────────────────────────
  // Lazy combo pane — code lives in features/visualizer.js, loaded on
  // first open by activateLazyPane(). Shares window._visualizerUndoStack
  // with EXPLORE (seeded near _paneDeps so deletes pre-load still record).

  // ── BROWSER pane ─────────────────────────────────────────────────────
  // Lazy combo pane — code lives in features/browser.js, loaded on first
  // open by activateLazyPane(). It exposes window._browserState (tab count
  // for paintComboHeader) and window._browserApplyStageMode.

  // Restore persisted combo mode. The EXPLORE section tab is restored by
  // features/explore.js itself when that lazy pane first loads.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    setComboMode(cfg.comboMode || 'notes', false);
  })();
}

// ── Paper (basic word processor) ────────────────────────────────────────────
// contenteditable + execCommand. execCommand is technically deprecated but
// every Chromium build still supports it and reimplementing rich-text
// editing on top of the Selection/Range API is a massive undertaking. For a
// "basic but usable" doc editor this trade-off is fine; if Chromium ever
// drops it we can swap the toolbar handlers to a Selection-based path.
const paperEditorEl  = document.getElementById('paper-editor');
const paperToolbarEl = document.getElementById('paper-toolbar');
const paperStatsElGlobal = document.getElementById('paper-stats');
let paperSaveTimer = null;

function updatePaperStats() {
  if (!paperEditorEl || !paperStatsElGlobal) return;
  const text = paperEditorEl.innerText || '';
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  paperStatsElGlobal.textContent = `${words.toLocaleString()} W · ${chars.toLocaleString()} C`;
}

async function savePaperNow() {
  clearTimeout(paperSaveTimer);
  if (!paperEditorEl || !window.dash?.setConfig) return;
  try { await window.dash.setConfig({ paperContent: paperEditorEl.innerHTML }); } catch {}
  // Also drop the document at docs/paper.html so it shows up in EXPLORE
  // and can be opened in a real browser / Word.
  if (window.dash?.docsWrite) {
    try { await window.dash.docsWrite('paper.html', paperEditorEl.innerHTML || ''); } catch {}
  }
}
function schedulePaperSave() {
  updatePaperStats();
  clearTimeout(paperSaveTimer);
  paperSaveTimer = setTimeout(savePaperNow, 500);
}

if (paperEditorEl && paperToolbarEl) {
  // Toolbar dispatch. data-cmd values match execCommand names except for
  // headings (h1/h2/h3/p) and the formatBlock:X shorthand (e.g. blockquote).
  paperToolbarEl.addEventListener('mousedown', (e) => {
    // Stop the panel from drag-grabbing on the toolbar.
    if (e.target.closest('.paper-tool')) e.stopPropagation();
  });
  paperToolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.paper-tool');
    if (!btn) return;
    e.stopPropagation();
    const cmd = btn.dataset.cmd;
    paperEditorEl.focus();
    if (cmd === 'h1' || cmd === 'h2' || cmd === 'h3' || cmd === 'p') {
      const tag = cmd === 'p' ? 'p' : cmd;
      document.execCommand('formatBlock', false, tag);
    } else if (cmd?.startsWith('formatBlock:')) {
      document.execCommand('formatBlock', false, cmd.slice('formatBlock:'.length));
    } else if (cmd) {
      document.execCommand(cmd, false, null);
    }
    schedulePaperSave();
  });

  // Plain-text paste so users pasting from Word/web don't drag in colors,
  // fonts, weird spacing, etc. that fight our theme.
  paperEditorEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
    document.execCommand('insertText', false, text);
  });

  paperEditorEl.addEventListener('input', schedulePaperSave);
  paperEditorEl.addEventListener('blur', savePaperNow);

  // Font selector — picks the editor's base font-family. Per-selection font
  // overrides via execCommand('fontName') still work over top of this.
  const paperFontEl = document.getElementById('paper-font');
  function applyPaperFont(key) {
    if (!paperEditorEl || !paperFontEl) return;
    const opt = paperFontEl.querySelector(`option[value="${CSS.escape(key)}"]`) || paperFontEl.options[0];
    if (!opt) return;
    paperEditorEl.style.fontFamily = opt.dataset.stack || '';
    if (paperFontEl.value !== opt.value) paperFontEl.value = opt.value;
  }
  if (paperFontEl) {
    paperFontEl.addEventListener('mousedown', (e) => e.stopPropagation());
    paperFontEl.addEventListener('change', () => {
      applyPaperFont(paperFontEl.value);
      if (window.dash?.setConfig) window.dash.setConfig({ paperFont: paperFontEl.value });
    });
  }

  // Restore persisted content + font + initial stats.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    if (typeof cfg.paperContent === 'string') paperEditorEl.innerHTML = cfg.paperContent;
    applyPaperFont(cfg.paperFont || 'tech');
    updatePaperStats();
  })();
}

// Per-element strobe staggering — each meter/row/cell gets a random phase.
const STROBE_SELECTOR =
  '.meter, .time-row, .temp-row, .storage-row, .net-row, .gpu-mem-row, ' +
  '.note-tab, .weather-left, .weather-right';

function randomStrobeDelay() {
  return `-${(Math.random() * 7).toFixed(2)}s`;
}

function staggerStrobeAll(root = document) {
  root.querySelectorAll(STROBE_SELECTOR).forEach(el => {
    if (!el.dataset.strobed) {
      el.style.animationDelay = randomStrobeDelay();
      el.dataset.strobed = '1';
    }
  });
}

// Watch for dynamically-added strobe targets (storage rows, gpu mem rows,
// note tabs) and assign each a random phase.
const _strobeObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue; // element only
      if (node.matches?.(STROBE_SELECTOR)) {
        node.style.animationDelay = randomStrobeDelay();
        node.dataset.strobed = '1';
      }
      staggerStrobeAll(node);
    }
  }
});
_strobeObserver.observe(document.body, { childList: true, subtree: true });

// Initial pass for everything already in the DOM.
staggerStrobeAll();

// ── Init from persistent config ──────────────────────────────────────────────
(async function initFromConfig() {
  if (!window.dash?.getConfig) {
    setStatus('ENTER CITY · PRESS ENTER');
    initNotes(null);
    _startBootFlicker();
    return;
  }
  const cfg = await window.dash.getConfig();

  // Startup layout: apply the canonical layout (STARTUP_LAYOUT) scaled to
  // the CURRENT viewport, so the dashboard boots into the exact same
  // arrangement, proportionally filled to whatever screen it is on. The
  // auto-orient button re-runs the identical thing on demand.
  requestAnimationFrame(async () => {
    // Boot picks portrait OR canonical-2-column based on the current
    // viewport — so users on a vertical monitor land in the stacked
    // panels-top / productivity-bottom shape from frame zero.
    await applyAdaptiveLayout();
    // Panels are positioned — recompute the combo's collapsed-mode fold
    // bounds from the live side-panel rects, then release the boot-flicker
    // gate so panels appear at their final coords.
    _updateComboFoldBoundsRef?.();
    _startBootFlicker();
  });

  // Theme: keep the saved slug only if it's still a known palette;
  // older configs that referenced deleted palette names fall back to
  // null and get cleared so the next launch starts clean.
  const savedTheme = cfg?.theme && THEME_SLUGS.has(cfg.theme) ? cfg.theme : null;
  setUserTheme(savedTheme);
  _themeUpdateCatButtons(savedTheme || '');
  if (cfg?.theme && !savedTheme) {
    try { window.dash?.setConfig?.({ theme: null }); } catch {}
  }
  // Auto-cycle was retired along with its topbar button — the category
  // buttons are now the only theme control. Clear any stale themeAuto
  // flag so an old config doesn't silently rotate themes.
  if (cfg?.themeAuto) {
    try { window.dash?.setConfig?.({ themeAuto: false }); } catch {}
  }
  // Restore background pattern (defaults to 'grid' if missing/invalid).
  setBgPattern(cfg?.bgPattern || 'grid');
  const bgBtn = document.getElementById('bg-pattern-btn');
  if (bgBtn) bgBtn.title = `Background · ${(cfg?.bgPattern || 'grid').toUpperCase()}`;
  applyUiFont(cfg?.uiFont || 'DEFAULT');
  if (cfg?.invert) applyInvert(true);
  if (webcamPanelEl && cfg?.webcamPos) {
    webcamPanelEl.style.left = `${cfg.webcamPos.x}px`;
    webcamPanelEl.style.top  = `${cfg.webcamPos.y}px`;
    webcamPanelEl.style.right = 'auto';
  }
  if (webcamPanelEl && cfg?.webcamSize) {
    webcamPanelEl.style.width  = `${cfg.webcamSize.width}px`;
    webcamPanelEl.style.height = `${cfg.webcamSize.height}px`;
  }
  if (cfg?.webcamOpen) setWebcamOpen(true, cfg.webcamDeviceId || undefined);
  if (terminalPanelEl && cfg?.terminalPos) {
    terminalPanelEl.style.left = `${cfg.terminalPos.x}px`;
    terminalPanelEl.style.top  = `${cfg.terminalPos.y}px`;
  }
  if (terminalPanelEl && cfg?.terminalSize) {
    terminalPanelEl.style.width  = `${cfg.terminalSize.width}px`;
    terminalPanelEl.style.height = `${cfg.terminalSize.height}px`;
  }
  if (cfg?.terminalOpen) {
    terminalPanelEl.hidden = false;
    terminalBtnEl?.classList.add('is-active');
  }
  if (cfg?.terminalChannels && typeof cfg.terminalChannels === 'object') {
    Object.assign(_termChannels, cfg.terminalChannels);
    terminalChannelEls.forEach(cb => { cb.checked = !!_termChannels[cb.dataset.ch]; });
  }
  if (cfg?.terminalTimeFmt) {
    _termTimeFmt = cfg.terminalTimeFmt;
    if (terminalTfmtEl) terminalTfmtEl.value = _termTimeFmt;
  }
  // Default to 5s if nothing saved (matches the <select> initial selected).
  const startInterval = Number.isFinite(cfg?.terminalInterval) ? cfg.terminalInterval : 5;
  if (terminalIntervalEl) terminalIntervalEl.value = String(startInterval);
  applyTermInterval(startInterval);
  // Per-chip sizes (chips are independent now). Legacy 'audioVizSize'
  // is honored as a fallback so a one-shot migration from the old
  // shared-size layout doesn't visibly reset the user. Any saved size
  // that doesn't meet the current minimum (broken values from earlier
  // experimental builds, or chips smaller than the user can usefully
  // grab) is treated as missing — CSS defaults will paint a usable
  // chip and saveGeom() will write a sane size the next time the user
  // drags.
  const _isValidSize = (s) => s && Number.isFinite(s.width) && Number.isFinite(s.height)
    && s.width >= 280 && s.height >= 120;
  const _legacy = cfg?.audioVizSize;
  const inSize  = _isValidSize(cfg?.audioInSize)  ? cfg.audioInSize
                 : _isValidSize(_legacy) ? _legacy : null;
  const outSize = _isValidSize(cfg?.audioOutSize) ? cfg.audioOutSize
                 : _isValidSize(_legacy) ? _legacy : null;
  audioInViz?.applySavedGeom(cfg?.audioInPos,  inSize,  cfg?.audioInMuted);
  audioOutViz?.applySavedGeom(cfg?.audioOutPos, outSize, cfg?.audioOutMuted);
  audioInViz?.applySavedGain?.(cfg?.audioInGain);
  audioOutViz?.applySavedGain?.(cfg?.audioOutGain);
  // Restore the persisted visualizer rate (▲/▼ buttons set this).
  if (Number.isFinite(cfg?.audioFrameMs)) setAudioFrameMs(cfg.audioFrameMs);
  // Saved-collapsed: panels already have `.is-collapsed` (forced by the
  // module-top boot loop), so the only thing we do here is tag the ones
  // that should STAY collapsed across the flicker. Panels not in this
  // map have `.is-collapsed` removed by the flicker stagger; panels in
  // it keep it, so notes/chat/combo (the typical saved-collapsed three)
  // remain shut.
  if (cfg?.collapsed) {
    for (const [k, v] of Object.entries(cfg.collapsed)) {
      const panel = document.querySelector(`.panel-${k}`);
      if (panel && v) panel.dataset.stayCollapsed = '1';
    }
  }

  initNotes(cfg);

  if (cfg?.altCity)  applyAltLocation(cfg.altCity);
  // cfg.altCity2 ignored — alt-zone 2 row was removed from the clock.
  if (cfg?.weatherCity) {
    activeLocation = cfg.weatherCity;
    weatherCityEl.value = activeLocation.name || '';
    setLocalClockCity(activeLocation);
    loadWeather(activeLocation);
    weatherTimer = setInterval(() => loadWeather(activeLocation), 10 * 60 * 1000);
  } else {
    setStatus('ENTER CITY · PRESS ENTER');
  }
})();

// ── Focus mode ──────────────────────────────────────────────────────────
// Toggles body.is-focused: side panels + audio strips shrink → collapse
// → slide off-screen in three staggered phases; productivity panel
// expands to fill the viewport in the same window. Clicking the button
// again reverses the animation via the is-unfocusing class (transition
// rules live under both is-focused and is-unfocusing in styles.css).
// Per-element --focus-exit-dx tells each member which way to exit:
// left-column members translate left, right-column members translate
// right. The exit-dx CSS vars are cleaned after the unfocus settles so
// they don't leak into later layout passes.
const focusModeBtnEl = document.querySelector('#focus-mode-btn');
// Per-panel stagger window for both the collapse (enter) and expand
// (exit) scale phases. Slide phases are synchronized across panels.
const FOCUS_STAGGER_MS         = 700;
const FOCUS_JITTER_MS          = 220;
const FOCUS_COLLAPSE_ANIM_MS   = 400;   // matches the focus-collapse-sy keyframe duration
const FOCUS_SLIDE_OFF_ANIM_MS  = 500;   // matches the focus-slide-off-tx keyframe duration
const FOCUS_EXPAND_ANIM_MS     = 1100;  // matches focus-expand-tx / focus-expand-sy duration
const FOCUS_FLICKER_MS         = 1300;  // brightness flicker duration
const FOCUS_FLICKER_VARIANTS   = ['unfold-flicker-1', 'unfold-flicker-2', 'unfold-flicker-3'];
let _focusUnfocusTimer = 0;
function setFocusMode(on) {
  clearTimeout(_focusUnfocusTimer);
  const targets = Array.from(document.querySelectorAll('.panel:not(.panel-combo), .audio-grid'));
  // Shuffle so the cascade order doesn't track DOM order.
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  if (on) {
    // Direction the panel exits — refreshed every enter so a panel
    // that's been dragged into the opposite half of the screen still
    // leaves via the correct edge.
    const vpW = window.innerWidth;
    targets.forEach((el) => {
      const r = el.getBoundingClientRect();
      const center = r.left + r.width / 2;
      const dx = center < vpW / 2 ? -vpW : vpW;
      el.style.setProperty('--focus-exit-dx', `${dx}px`);
    });
    // Per-panel collapse delay. The slide-off delay is the SAME for
    // every panel and is calculated to land just after the slowest
    // panel finishes collapsing, so all panels move off-screen
    // together once every one is flat.
    let maxCollapseDelay = 0;
    targets.forEach((el, i) => {
      const base   = targets.length > 1 ? (i / (targets.length - 1)) * FOCUS_STAGGER_MS : 0;
      const jitter = (Math.random() - 0.5) * FOCUS_JITTER_MS;
      const delay  = Math.max(0, Math.round(base + jitter));
      if (delay > maxCollapseDelay) maxCollapseDelay = delay;
      el.style.setProperty('--collapse-delay-ms', `${delay}ms`);
    });
    const slideOffDelay = maxCollapseDelay + FOCUS_COLLAPSE_ANIM_MS;
    targets.forEach((el) => {
      el.style.setProperty('--slide-off-delay-ms', `${slideOffDelay}ms`);
    });
    document.body.classList.remove('is-unfocusing');
    document.body.classList.add('is-focused');
    focusModeBtnEl?.classList.add('is-active');
  } else {
    // Restore the canonical 2-column layout before the unfold so the
    // panels reappear at their "defaulted view" positions. Portrait
    // viewports fall through to the stacked portrait layout instead.
    try { applyAdaptiveLayout(); } catch (err) { console.warn('[focus-mode] applyAdaptiveLayout failed:', err); }
    // Per-panel expand delay (slide-back + grow ride on the same
    // delay so each panel does its own combined translate-then-grow
    // motion staggered against the others). Plus a random flicker
    // variant per panel — boot wake-up styling.
    let maxExpandDelay = 0;
    targets.forEach((el, i) => {
      const base   = targets.length > 1 ? (i / (targets.length - 1)) * FOCUS_STAGGER_MS : 0;
      const jitter = (Math.random() - 0.5) * FOCUS_JITTER_MS;
      const delay  = Math.max(0, Math.round(base + jitter));
      if (delay > maxExpandDelay) maxExpandDelay = delay;
      el.style.setProperty('--expand-delay-ms', `${delay}ms`);
      el.style.setProperty(
        '--unfold-flicker',
        FOCUS_FLICKER_VARIANTS[Math.floor(Math.random() * FOCUS_FLICKER_VARIANTS.length)],
      );
    });
    document.body.classList.add('is-unfocusing');
    document.body.classList.remove('is-focused');
    focusModeBtnEl?.classList.remove('is-active');
    // Cleanup after the slowest panel finishes both its expand AND
    // its flicker — whichever is later. +100 ms guard.
    const lastExpand  = maxExpandDelay + FOCUS_EXPAND_ANIM_MS;
    const lastFlicker = maxExpandDelay + FOCUS_FLICKER_MS;
    const totalMs     = Math.max(lastExpand, lastFlicker) + 100;
    _focusUnfocusTimer = setTimeout(() => {
      document.body.classList.remove('is-unfocusing');
      document.querySelectorAll('.panel:not(.panel-combo), .audio-grid').forEach((el) => {
        el.style.removeProperty('--focus-exit-dx');
        el.style.removeProperty('--collapse-delay-ms');
        el.style.removeProperty('--slide-off-delay-ms');
        el.style.removeProperty('--expand-delay-ms');
        el.style.removeProperty('--unfold-flicker');
      });
    }, totalMs);
  }
}
focusModeBtnEl?.addEventListener('click', () => {
  setFocusMode(!document.body.classList.contains('is-focused'));
  // Toggle pattern: now-ON → 'click' (activate), now-OFF → 'close' (dismiss).
  try { playSfx?.(document.body.classList.contains('is-focused') ? 'click' : 'close'); } catch {}
});

// Refresh button — reloads the renderer in place. Picks up CSS / JS edits
// during dev iteration without killing the main process (so background
// services like the audio loopback, screen-record encoder, mirror capture,
// and any open BrowserViews stay alive across the reload).
document.querySelector('#app-refresh-btn')?.addEventListener('click', () => {
  try { playSfx?.('click'); } catch {}
  location.reload();
});

// Restart button — full Electron relaunch (main + renderer). Use this when
// changes need a fresh process: main.js edits, preload.js edits, anything
// that's set once at BrowserWindow creation. The handler in main.js calls
// app.relaunch() + app.exit(0), so saved cfg + window placement come back.
document.querySelector('#app-restart-btn')?.addEventListener('click', () => {
  try { playSfx?.('confirm'); } catch {}
  if (window.dash?.appRelaunch) window.dash.appRelaunch().catch(() => {});
});

// Close button — quits the Electron process. In browser mode (no preload),
// closing a tab is the user's job; we just blur the URL bar so nothing
// silently steals their input.
document.querySelector('#close-btn')?.addEventListener('click', () => {
  if (window.dash?.appQuit) window.dash.appQuit().catch(() => {});
});

// Lock UI — when active, panel drag, panel resize, audio-grid drag/resize,
// and topbar reorder all bail at mousedown. Persists across reloads.
function setUiLocked(on) {
  _uiLocked = !!on;
  document.body.classList.toggle('is-ui-locked', _uiLocked);
  document.querySelector('#lock-ui-btn')?.classList.toggle('is-active', _uiLocked);
}
document.querySelector('#lock-ui-btn')?.addEventListener('click', async () => {
  setUiLocked(!_uiLocked);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ uiLocked: _uiLocked }); } catch {}
  }
  // Toggle: now-locked → 'click' (engaged), now-unlocked → 'close' (released).
  playSfx(_uiLocked ? 'click' : 'close');
});
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.uiLocked) setUiLocked(true);
})();

// Eco mode is permanently on. The body class kills the per-character
// diag overlay animation + audio-grid transitions; the audio sampler
// loop is already pinned at ~10 Hz unconditionally. Was previously a
// topbar toggle that we removed since there was no perceptible benefit
// to running without it on real hardware.
document.body.classList.add('is-eco-mode');


// Recall panels — for any panel or audio grid currently outside the
// viewport (or even partially clipped), clamp it back inside and persist
// the new position. Useful after a display change shrinks the work area
// below where panels were dragged.
document.querySelector('#recall-panels-btn')?.addEventListener('click', async () => {
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const margin = 8; // keep a small gap from the edge so the header is grabbable

  const clampRect = (r) => {
    const w = r.width, h = r.height;
    let nx = Math.max(margin, Math.min(r.left, vpW - w - margin));
    let ny = Math.max(margin, Math.min(r.top,  vpH - h - margin));
    if (w > vpW - margin * 2) nx = margin;
    if (h > vpH - margin * 2) ny = margin;
    return { nx, ny };
  };
  const isInView = (r) => r.left >= 0 && r.top >= 0 && r.right <= vpW && r.bottom <= vpH;

  for (const panel of document.querySelectorAll('.panel')) {
    const key = panelKey(panel);
    if (!key) continue;
    const r = panel.getBoundingClientRect();
    if (isInView(r)) continue;
    const { nx, ny } = clampRect(r);
    panel.style.position = 'fixed';
    panel.style.left = `${nx}px`;
    panel.style.top  = `${ny}px`;
    await savePanelSize(key, { x: nx, y: ny });
  }

  // Audio visualizer grids live outside the .panel system — they're
  // .audio-grid elements with their own (audioInPos / audioOutPos) keys.
  const audioGrids = [
    { el: document.querySelector('#audio-in-grid'),  cfgKey: 'audioInPos'  },
    { el: document.querySelector('#audio-out-grid'), cfgKey: 'audioOutPos' },
  ];
  for (const { el, cfgKey } of audioGrids) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (isInView(r)) continue;
    const { nx, ny } = clampRect(r);
    el.style.left = `${nx}px`;
    el.style.top  = `${ny}px`;
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
    if (window.dash?.setConfig) {
      try { await window.dash.setConfig({ [cfgKey]: { x: nx, y: ny } }); } catch {}
    }
  }
  playSfx('confirm');
});

// Auto-orient — re-runs applySideArrange against the current viewport.
// ── CANONICAL LAYOUT ─────────────────────────────────────────────────────
// applyStartupLayout tiles the panels GAPLESSLY across the whole viewport:
// two side columns flush to the left/right screen edges, the PRODUCTIVITY
// panel filling the middle, every panel flush against its neighbour (zero
// gaps), and the audio visualizers as an equal-height strip flush at the
// bottom of each column. It is fully computed, so it tiles perfectly at any
// screen size / aspect ratio. Both startup and the auto-orient button run it.
// Two-column layout helper — places every side panel + audio strip + the
// combo into a left/right column arrangement, with the side columns at
// `colWFraction` of the viewport width. Used by both applyStartupLayout
// (canonical, 21%) and applyCompactSideLayout (narrow, 8.5%). The vertical
// weights stay constant — only the column width changes.
//
//   ┌─ clock ──┬──────────────────────┬─ weather ──┐
//   ├─ cpu ────┤                      ├─ thermal ──┤
//   ├─ network ┤    productivity      ├─ gpu ──────┤
//   ├─ ram ────┤                      ├─ storage ──┤
//   ├──────────┤                      ├─ driveio ──┤
//   └─ audio-in┴──────────────────────┴─ audio-out ┘
// Canonical panel weights (proportional heights at 3840×2160). Keyed by
// the panel-* class suffix. Used by every preset layout so the per-panel
// height ratio stays consistent across canonical/medium/compact AND when
// the user has swapped sides — the weight always travels with the panel.
const _PANEL_WEIGHTS = {
  clock: 664, cpu: 454, network: 384, ram: 420,
  weather: 358, thermal: 447, gpu: 372, storage: 358, driveio: 387,
};
const _DEFAULT_LEFT_KEYS  = ['clock', 'cpu', 'network', 'ram'];
const _DEFAULT_RIGHT_KEYS = ['weather', 'thermal', 'gpu', 'storage', 'driveio'];

// Detect which panels currently live on the LEFT vs the RIGHT side of
// the viewport (by panel-centre x). Returns null if the split isn't
// clear (one side empty) — caller falls back to the canonical defaults.
// This lets auto-orient respect a user's hand-arranged side swaps:
// dragging WEATHER over to the left and CLOCK over to the right makes
// the next auto-orient press lay them out that way too.
function _detectColumnLayout() {
  const midX = window.innerWidth / 2;
  const left  = [];
  const right = [];
  for (const key of Object.keys(_PANEL_WEIGHTS)) {
    const el = document.querySelector(`.panel-${key}`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cx = r.left + r.width / 2;
    (cx < midX ? left : right).push({ key, y: r.top });
  }
  if (!left.length || !right.length) return null;
  left .sort((a, b) => a.y - b.y);
  right.sort((a, b) => a.y - b.y);
  return {
    leftPanels:  left .map((p) => [p.key, _PANEL_WEIGHTS[p.key]]),
    rightPanels: right.map((p) => [p.key, _PANEL_WEIGHTS[p.key]]),
  };
}

async function _applyTwoColumnLayout(colWFraction) {
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  // The topbar is now fused into the Productivity panel as its first
  // child, so there's no separate strip to sit beneath — every panel
  // tiles from the viewport top.
  const top = 0;
  const availH = vpH - top;

  const colW    = Math.round(vpW * colWFraction);
  const centerW = vpW - colW * 2;
  const leftX   = 0;
  const rightX  = vpW - colW;

  // Audio strip height stays at the canonical 238/2160 = 11.02% so it
  // doesn't get squashed when the columns get narrower.
  const audioH    = Math.round(availH * (238 / 2160));
  const panelArea = availH - audioH;
  const audioY    = top + panelArea;

  // Weight = each panel's canonical height at 3840×2160. The DOM-driven
  // detector lets a user swap WEATHER↔CLOCK (or any other pair) and
  // have auto-orient keep that arrangement instead of forcing the
  // panels back to canonical positions. Fallback to canonical when
  // detection can't find a clear two-column split (e.g. first boot).
  const detected = _detectColumnLayout();
  const leftPanels  = detected?.leftPanels  || _DEFAULT_LEFT_KEYS .map((k) => [k, _PANEL_WEIGHTS[k]]);
  const rightPanels = detected?.rightPanels || _DEFAULT_RIGHT_KEYS.map((k) => [k, _PANEL_WEIGHTS[k]]);

  const placePanel = async (key, x, y, w, h) => {
    const panel = document.querySelector(`.panel-${key}`);
    if (!panel) return;
    clearPanelSize(panel);
    applyPanelSize(panel, { x, y, width: w, height: h });
    await savePanelSize(key, { x, y, width: w, height: h });
  };
  const placeAudio = async (side, x, y, w, h) => {
    const viz = side === 'in' ? audioInViz : audioOutViz;
    viz?.applySavedGeom?.({ x, y }, { width: w, height: h });
    if (window.dash?.setConfig) {
      const posKey  = side === 'in' ? 'audioInPos'  : 'audioOutPos';
      const sizeKey = side === 'in' ? 'audioInSize' : 'audioOutSize';
      try { await window.dash.setConfig({ [posKey]: { x, y }, [sizeKey]: { width: w, height: h } }); } catch {}
    }
  };
  // Stack a column's panels flush, from the topbar down to the audio strip.
  const stackPanels = async (panels, x) => {
    const total = panels.reduce((s, [, wt]) => s + wt, 0);
    let y = top;
    for (let i = 0; i < panels.length; i++) {
      const [key, wt] = panels[i];
      // Last panel takes the exact remainder so the stack ends on audioY
      // with no rounding drift.
      const h = (i === panels.length - 1) ? (audioY - y) : Math.round((wt / total) * panelArea);
      await placePanel(key, x, y, colW, h);
      y += h;
    }
  };

  await placePanel('combo', colW, top, centerW, availH);
  await stackPanels(leftPanels,  leftX);
  await stackPanels(rightPanels, rightX);
  await placeAudio('in',  leftX,  audioY, colW, audioH);
  await placeAudio('out', rightX, audioY, colW, audioH);
}

// Canonical "defaulted view" — 21% side columns, productivity middle.
// Side-column width presets for the auto-orient cycle. CANONICAL =
// dashboard's "defaulted view" (21% sides). MEDIUM = mid-narrow state
// good for keeping a wider productivity area while still reading
// side panels at-a-glance. COMPACT = snap-to-sides minimum.
const LAYOUT_CANONICAL_FRAC = 810 / 3840;  // 0.2109
const LAYOUT_MEDIUM_FRAC    = 0.13;
const LAYOUT_COMPACT_FRAC   = 0.085;

async function applyStartupLayout() {
  await _applyTwoColumnLayout(LAYOUT_CANONICAL_FRAC);
}

async function applyMediumSideLayout() {
  await _applyTwoColumnLayout(LAYOUT_MEDIUM_FRAC);
}

async function applyCompactSideLayout() {
  await _applyTwoColumnLayout(LAYOUT_COMPACT_FRAC);
}

// CLAMP-only alignment used by the auto-orient BUTTON. The dashboard
// has three regions: LEFT band [0, colW], CENTRE band [colW, vpW-colW]
// reserved for the productivity (combo) panel, RIGHT band
// [vpW-colW, vpW]. This pass walks every panel and only adjusts its
// geometry if it's poking outside the band it belongs to —
//   • side panels: clamped into LEFT or RIGHT band (whichever their
//     centre x is closer to), width capped to colW
//   • combo: clamped into the CENTRE band, width capped to centerW
// Panels already inside their band are LEFT EXACTLY where the user
// dragged them. Y and height are never touched.
async function _alignPanelsToCols(colWFraction) {
  const vpW = window.innerWidth;
  const colW    = Math.round(vpW * colWFraction);
  const centerW = vpW - colW * 2;
  const midX    = vpW / 2;

  // Clamp `panel` so its horizontal extent lies fully inside
  // [bandMin, bandMax]. Width is also capped to the band so nothing
  // ever pokes past — but if the panel already fits, no change.
  const clampToBand = async (panel, bandMin, bandMax) => {
    const r = panel.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const bandW = bandMax - bandMin;
    let x = Math.round(r.left);
    let w = Math.round(r.width);
    const y = Math.round(r.top);
    const h = Math.round(r.height);
    if (w > bandW) w = bandW;
    if (x < bandMin) x = bandMin;
    if (x + w > bandMax) x = bandMax - w;
    // Nothing to do — panel was already inside the band.
    if (x === Math.round(r.left) && w === Math.round(r.width)) return;
    applyPanelSize(panel, { x, y, width: w, height: h });
    const key = panelKey(panel);
    if (key) { try { await savePanelSize(key, { x, y, width: w, height: h }); } catch {} }
  };

  // Side panels: pick the band whose centre is closer to the panel's
  // own centre, then clamp into it. A panel sitting fully in the
  // middle gets pushed to whichever side it's nearest.
  for (const panel of document.querySelectorAll('.panel:not(.panel-combo)')) {
    const r = panel.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cx = r.left + r.width / 2;
    if (cx < midX) await clampToBand(panel, 0, colW);
    else           await clampToBand(panel, vpW - colW, vpW);
  }

  // Productivity (combo) panel — clamped into the centre band only.
  const combo = document.querySelector('.panel-combo');
  if (combo) await clampToBand(combo, colW, vpW - colW);

  // Audio strips — same clamp rule as side panels, but routed through
  // the audio viz geometry persistence path.
  for (const side of ['in', 'out']) {
    const viz = side === 'in' ? audioInViz : audioOutViz;
    const el  = document.querySelector(side === 'in' ? '#audio-in-grid' : '#audio-out-grid');
    if (!el || !viz?.applySavedGeom) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cx = r.left + r.width / 2;
    const [bandMin, bandMax] = (cx < midX) ? [0, colW] : [vpW - colW, vpW];
    const bandW = bandMax - bandMin;
    let x = Math.round(r.left);
    let w = Math.round(r.width);
    const y = Math.round(r.top);
    const h = Math.round(r.height);
    if (w > bandW) w = bandW;
    if (x < bandMin) x = bandMin;
    if (x + w > bandMax) x = bandMax - w;
    if (x === Math.round(r.left) && w === Math.round(r.width)) continue;
    viz.applySavedGeom({ x, y }, { width: w, height: h });
    if (window.dash?.setConfig) {
      const posKey  = side === 'in' ? 'audioInPos'  : 'audioOutPos';
      const sizeKey = side === 'in' ? 'audioInSize' : 'audioOutSize';
      try { await window.dash.setConfig({ [posKey]: { x, y }, [sizeKey]: { width: w, height: h } }); } catch {}
    }
  }
  void centerW;
}

async function alignCanonical() { await _alignPanelsToCols(LAYOUT_CANONICAL_FRAC); }
async function alignMedium()    { await _alignPanelsToCols(LAYOUT_MEDIUM_FRAC);    }
async function alignCompact()   { await _alignPanelsToCols(LAYOUT_COMPACT_FRAC);   }

// Portrait / vertical viewport layout.
// Top half of the screen = all status panels (2 columns) + audio
// strips at the bottom of that half. Bottom half = productivity
// (combo) panel full width. Triggered whenever vpH > vpW so the
// dashboard reads sensibly on rotated / vertical monitors.
async function applyPortraitLayout() {
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const topH = Math.round(vpH * 0.5);          // upper half = panels
  const bottomY = topH;
  const bottomH = vpH - topH;                  // lower half = productivity

  // Inside the top half: two equal-width columns of panels + audio
  // strips along the bottom of that half. Audio takes ~12% of the
  // top half (same proportion as the canonical layout's 238/2160).
  const colW = Math.floor(vpW / 2);
  const leftX = 0;
  const rightX = vpW - colW;
  const audioH = Math.max(80, Math.round(topH * 0.12));
  const panelArea = topH - audioH;
  const audioY = panelArea;

  // Honour any user-driven side swap (WEATHER↔CLOCK, etc.) when
  // entering portrait too. Falls back to canonical defaults if no
  // panel is in the DOM yet.
  const detected = _detectColumnLayout();
  const leftPanels  = detected?.leftPanels  || _DEFAULT_LEFT_KEYS .map((k) => [k, _PANEL_WEIGHTS[k]]);
  const rightPanels = detected?.rightPanels || _DEFAULT_RIGHT_KEYS.map((k) => [k, _PANEL_WEIGHTS[k]]);

  const placePanel = async (key, x, y, w, h) => {
    const panel = document.querySelector(`.panel-${key}`);
    if (!panel) return;
    clearPanelSize(panel);
    applyPanelSize(panel, { x, y, width: w, height: h });
    await savePanelSize(key, { x, y, width: w, height: h });
  };
  const placeAudio = async (side, x, y, w, h) => {
    const viz = side === 'in' ? audioInViz : audioOutViz;
    viz?.applySavedGeom?.({ x, y }, { width: w, height: h });
    if (window.dash?.setConfig) {
      const posKey  = side === 'in' ? 'audioInPos'  : 'audioOutPos';
      const sizeKey = side === 'in' ? 'audioInSize' : 'audioOutSize';
      try { await window.dash.setConfig({ [posKey]: { x, y }, [sizeKey]: { width: w, height: h } }); } catch {}
    }
  };
  const stackPanels = async (panels, x) => {
    const total = panels.reduce((s, [, wt]) => s + wt, 0);
    let y = 0;
    for (let i = 0; i < panels.length; i++) {
      const [key, wt] = panels[i];
      const h = (i === panels.length - 1) ? (audioY - y) : Math.round((wt / total) * panelArea);
      await placePanel(key, x, y, colW, h);
      y += h;
    }
  };

  await placePanel('combo', 0, bottomY, vpW, bottomH);
  await stackPanels(leftPanels,  leftX);
  await stackPanels(rightPanels, rightX);
  await placeAudio('in',  leftX,  audioY, colW, audioH);
  await placeAudio('out', rightX, audioY, colW, audioH);
}

// Pick the right top-level layout for the current viewport. Used by
// boot, focus-mode exit, monitor-switch, and the resize debouncer so
// every code path that "redo the layout" goes through one decision.
function _viewportIsPortrait() {
  return window.innerHeight > window.innerWidth;
}
// True when the dashboard is on a 1080p-or-lower display. The CSS
// rule for body.is-low-res zooms each panel's contents to 70%, so the
// 4K-tuned text density reads correctly on smaller monitors without
// any explicit user toggle.
function _viewportIsLowRes() {
  return Math.min(window.innerWidth, window.innerHeight) <= 1080;
}
function _applyResolutionScale() {
  document.body.classList.toggle('is-low-res', _viewportIsLowRes());
}
// Apply every saved per-panel geometry (cfg.panelSizes) onto the live
// DOM. Returns true when at least one entry was applied — caller uses
// that to skip the canonical-default layout pass on boot so the user's
// arrangement isn't overwritten.
async function restoreSavedPanelGeometry() {
  if (!window.dash?.getConfig) return false;
  let cfg;
  try { cfg = await window.dash.getConfig(); } catch { return false; }
  const sizes = cfg?.panelSizes || {};
  let count = 0;
  for (const [key, entry] of Object.entries(sizes)) {
    if (!entry || typeof entry !== 'object') continue;
    const panel = document.querySelector(`.panel-${key}`);
    if (!panel) continue;
    if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
    if (!Number.isFinite(entry.width) || !Number.isFinite(entry.height)) continue;
    clearPanelSize(panel);
    applyPanelSize(panel, entry);
    count++;
  }
  // Audio strips persist their geometry under audioInPos/audioOutPos +
  // audioInSize/audioOutSize. Restore those too so the bus strips
  // return to where the user dragged them, not the canonical defaults.
  for (const side of ['in', 'out']) {
    const pos  = cfg?.[side === 'in' ? 'audioInPos'  : 'audioOutPos'];
    const size = cfg?.[side === 'in' ? 'audioInSize' : 'audioOutSize'];
    if (!pos || !size) continue;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) continue;
    const viz = side === 'in' ? audioInViz : audioOutViz;
    viz?.applySavedGeom?.({ x: pos.x, y: pos.y }, { width: size.width, height: size.height });
    count++;
  }
  return count > 0;
}

async function applyAdaptiveLayout() {
  _applyResolutionScale();
  // First-boot or wiped config → fall through to the canonical default
  // arrangement. Otherwise restore each panel where the user last left
  // it — a previous "auto-orient on every boot" cascade was undoing
  // every drag the user made.
  if (await restoreSavedPanelGeometry()) return;
  if (_viewportIsPortrait()) await applyPortraitLayout();
  else                       await applyStartupLayout();
}

// Re-apply the user's CURRENT layout preset against the current
// viewport. Used when the viewport changes underneath the panels —
// display switch, window resize, monitor rotation. Portrait viewports
// always get the stacked portrait layout (panels top, productivity
// bottom) regardless of which landscape preset the user had selected.
async function reapplyCurrentLayout() {
  try {
    _applyResolutionScale();
    if (_viewportIsPortrait()) { await applyPortraitLayout(); return; }
    const clock = document.querySelector('.panel-clock');
    let frac = LAYOUT_CANONICAL_FRAC;
    if (clock) {
      const cur = clock.getBoundingClientRect().width / Math.max(1, window.innerWidth);
      const midCanMed = (LAYOUT_CANONICAL_FRAC + LAYOUT_MEDIUM_FRAC) / 2;
      const midMedCom = (LAYOUT_MEDIUM_FRAC + LAYOUT_COMPACT_FRAC) / 2;
      if      (cur > midCanMed) frac = LAYOUT_CANONICAL_FRAC;
      else if (cur > midMedCom) frac = LAYOUT_MEDIUM_FRAC;
      else                      frac = LAYOUT_COMPACT_FRAC;
    }
    await _applyTwoColumnLayout(frac);
  } catch (err) {
    console.warn('[reapply-layout] failed:', err?.message || err);
  }
}

// Debounced viewport-change re-layout. Catches every path that
// changes window dimensions — manual drag-resize, fullscreen toggle,
// monitor switch via the display strip, OS resolution change. Skipped
// while focus mode's transform is in flight (the focus animation
// owns panel transforms during its 1.6 s window).
let _reapplyLayoutTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(_reapplyLayoutTimer);
  _reapplyLayoutTimer = setTimeout(() => {
    if (document.body.classList.contains('is-focused') ||
        document.body.classList.contains('is-unfocusing')) return;
    reapplyCurrentLayout();
  }, 200);
});

// Auto-orient — three-state cycle. Reads the current side-panel width,
// snaps the layout to the NEXT preset in the cycle:
//   canonical (21%) → medium (13%) → compact (8.5%) → canonical → …
// A custom layout that doesn't match any preset is bucketed by its
// nearest midpoint, so the button always acts as "advance to the next
// step from where I am now".
document.querySelector('#auto-orient-btn')?.addEventListener('click', async () => {
  try {
    // Portrait viewport — the 3-preset landscape cycle doesn't apply
    // (the layout is panels-top / productivity-bottom). Re-snap to it
    // so the button acts as a "fix my layout" affordance.
    if (_viewportIsPortrait()) { await applyPortraitLayout(); playSfx('confirm'); return; }
    // FORMAT-ONLY align (not a full re-layout): snap each panel's
    // width to the next preset's column width and pull it flush to
    // its side, but keep y + height where the user has placed them.
    // A panel the user dragged into a specific stack position stays
    // in that stack position — only the side-column horizontal
    // alignment is enforced.
    const probe = document.querySelector('.panel-clock')
              || document.querySelector('.panel:not(.panel-combo)');
    let next = alignMedium;
    if (probe) {
      const frac = probe.getBoundingClientRect().width / window.innerWidth;
      const midCanMed = (LAYOUT_CANONICAL_FRAC + LAYOUT_MEDIUM_FRAC) / 2; // ~0.171
      const midMedCom = (LAYOUT_MEDIUM_FRAC + LAYOUT_COMPACT_FRAC) / 2;   // ~0.108
      if      (frac > midCanMed) next = alignMedium;
      else if (frac > midMedCom) next = alignCompact;
      else                       next = alignCanonical;
    }
    await next();
  } catch (err) {
    console.warn('[auto-orient] failed:', err);
  }
  playSfx('confirm');
});

// ── Align edges ──────────────────────────────────────────────────────────
// Respects the current layout but snaps every panel edge that's within
// ALIGN_TOLERANCE of another panel edge to a shared coordinate, so panels
// that have drifted a couple of cells out of sync land flush against each
// other (and panels with their own column line up to the same gridline).
//
// Algorithm:
//   1. Collect every visible panel + both audio visualizers as items with
//      {x, y, w, h}. All four edges (left/top/right/bottom) participate —
//      we don't distinguish "lefts cluster with lefts" because the goal is
//      the same: shared X coordinates. A panel's right edge clustering
//      with another panel's left edge means they butt flush.
//   2. Sort + cluster the X edges (lefts + rights together) using a simple
//      single-link scan: an edge joins the current cluster if it's within
//      ALIGN_TOLERANCE of the cluster's last edge. Same for Y edges.
//   3. Each cluster picks a representative = mean of its members, snapped
//      to SNAP_CELL so the result still lands on the bg-grid.
//   4. For each item, look up the new X for its left + right (and Y for
//      top + bottom), compute width = newRight - newLeft, then re-apply
//      and persist. width/height floor at SNAP_CELL*8 (160px) so a freak
//      cluster collapse can't shrink a panel to nothing.
async function alignPanelEdges() {
  const ALIGN_TOLERANCE = SNAP_CELL * 2;   // 40px — two grid cells
  const MIN_DIM         = SNAP_CELL * 8;   // 160px — minimum panel side

  const items = [];
  document.querySelectorAll('.panel').forEach((panel) => {
    if (panel.classList.contains('is-collapsed')) return;
    const x = parseInt(panel.style.left,   10);
    const y = parseInt(panel.style.top,    10);
    const w = parseInt(panel.style.width,  10);
    const h = parseInt(panel.style.height, 10);
    if (![x, y, w, h].every(Number.isFinite)) return;
    const key = panelKey(panel);
    if (!key) return;
    items.push({ kind: 'panel', el: panel, key, x, y, w, h });
  });
  for (const side of ['in', 'out']) {
    const viz = side === 'in' ? audioInViz : audioOutViz;
    const el  = document.getElementById(side === 'in' ? 'audio-in-grid' : 'audio-out-grid');
    if (!viz || !el) continue;
    const x = parseInt(el.style.left,   10);
    const y = parseInt(el.style.top,    10);
    const w = parseInt(el.style.width,  10);
    const h = parseInt(el.style.height, 10);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    items.push({ kind: 'audio', viz, side, x, y, w, h });
  }
  if (items.length < 2) return;

  // Cluster a flat list of edge values; return a Map<oldEdge, newEdge>.
  const buildClusterMap = (vals, tol) => {
    const sorted = [...new Set(vals)].sort((a, b) => a - b);
    const groups = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const last = groups[groups.length - 1];
      if (sorted[i] - last[last.length - 1] <= tol) last.push(sorted[i]);
      else groups.push([sorted[i]]);
    }
    const map = new Map();
    for (const g of groups) {
      const mean = g.reduce((s, v) => s + v, 0) / g.length;
      const rep  = Math.round(mean / SNAP_CELL) * SNAP_CELL;
      for (const v of g) map.set(v, rep);
    }
    return map;
  };

  const xMap = buildClusterMap(items.flatMap((it) => [it.x, it.x + it.w]), ALIGN_TOLERANCE);
  const yMap = buildClusterMap(items.flatMap((it) => [it.y, it.y + it.h]), ALIGN_TOLERANCE);

  for (const it of items) {
    const newLeft   = xMap.get(it.x);
    const newRight  = xMap.get(it.x + it.w);
    const newTop    = yMap.get(it.y);
    const newBot    = yMap.get(it.y + it.h);
    const newW      = Math.max(MIN_DIM, newRight - newLeft);
    const newH      = Math.max(MIN_DIM, newBot   - newTop);
    if (it.kind === 'panel') {
      applyPanelSize(it.el, { x: newLeft, y: newTop, width: newW, height: newH });
      await savePanelSize(it.key, { x: newLeft, y: newTop, width: newW, height: newH });
    } else {
      it.viz?.applySavedGeom?.({ x: newLeft, y: newTop }, { width: newW, height: newH });
      if (window.dash?.setConfig) {
        const posKey  = it.side === 'in' ? 'audioInPos'  : 'audioOutPos';
        const sizeKey = it.side === 'in' ? 'audioInSize' : 'audioOutSize';
        try { await window.dash.setConfig({ [posKey]: { x: newLeft, y: newTop }, [sizeKey]: { width: newW, height: newH } }); } catch {}
      }
    }
  }
}

document.querySelector('#align-edges-btn')?.addEventListener('click', async () => {
  try { await alignPanelEdges(); } catch (err) { console.warn('[align-edges] failed:', err); }
  playSfx('confirm');
});

// Store Config — explicit "lock in current state" gesture. Calls the
// same _snapshotLayoutToConfig the beforeunload handler uses so every
// panel, audio chip, webcam float, and terminal position lands on disk
// in one IPC; theme + bgPattern are auto-saved on change but written
// again here so the button serves as a single source of truth for
// "this is the layout I want next time the app starts". Briefly flashes
// the button so the click registers visibly.
document.querySelector('#store-config-btn')?.addEventListener('click', async () => {
  const btn = document.querySelector('#store-config-btn');
  try {
    _snapshotLayoutToConfig();
    if (window.dash?.setConfig) {
      const theme   = document.documentElement.getAttribute('data-theme') || null;
      const bgPattern = document.body.getAttribute('data-bg-pattern') || 'grid';
      await window.dash.setConfig({ theme, bgPattern });
    }
    if (btn) {
      btn.classList.add('is-active');
      const prevTitle = btn.title;
      btn.title = 'Layout stored';
      setTimeout(() => {
        btn.classList.remove('is-active');
        btn.title = prevTitle;
      }, 900);
    }
    playSfx('confirm');
  } catch (err) {
    console.warn('[store-config] failed:', err);
    playSfx('error');
  }
});

// ── Save-on-close ────────────────────────────────────────────────────────
// Every drag/resize already writes its key via savePanelSize, so per-change
// persistence is the primary save path. This handler is the explicit
// "store state on close" — at the moment the renderer is about to unload
// (window close, F5 reload, app quit), it sweeps every panel + visualizer +
// float window's *inline* left/top/width/height (NOT getBoundingClientRect,
// so a zen-mode transform can't poison the saved positions) and ships them
// to disk in a single IPC call. setConfig is fire-and-forget here: the
// invoke message dispatches synchronously, the main process flushes the
// write before the window actually closes, and we don't need the Promise
// to resolve before returning.
function _snapshotLayoutToConfig() {
  if (!window.dash?.setConfig) return;
  const partial = {};

  // Build panelSizes from current inline positions. CRITICAL: if zero
  // panels have valid coords (the snapshot fired before init applied
  // positions), DO NOT write `panelSizes: {}` — main's setConfig does a
  // shallow merge, which would wipe the saved layout for every panel.
  const panelSizes = {};
  let panelCount = 0;
  for (const panel of document.querySelectorAll('.panel')) {
    const key = panelKey(panel);
    if (!key) continue;
    const x = parseInt(panel.style.left,   10);
    const y = parseInt(panel.style.top,    10);
    const w = parseInt(panel.style.width,  10);
    const h = parseInt(panel.style.height, 10);
    if (!(Number.isFinite(x) && Number.isFinite(y))) continue;
    const entry = { x, y };
    if (Number.isFinite(w)) entry.width  = w;
    if (Number.isFinite(h)) entry.height = h;
    panelSizes[key] = entry;
    panelCount++;
  }
  if (panelCount > 0) partial.panelSizes = panelSizes;

  const audioOut = document.querySelector('#audio-out-grid');
  if (audioOut) {
    const x = parseInt(audioOut.style.left,   10);
    const y = parseInt(audioOut.style.top,    10);
    const w = parseInt(audioOut.style.width,  10);
    const h = parseInt(audioOut.style.height, 10);
    if (Number.isFinite(x) && Number.isFinite(y)) partial.audioOutPos = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial.audioOutSize = { width: w, height: h };
  }
  const audioIn = document.querySelector('#audio-in-grid');
  if (audioIn) {
    const x = parseInt(audioIn.style.left,   10);
    const y = parseInt(audioIn.style.top,    10);
    const w = parseInt(audioIn.style.width,  10);
    const h = parseInt(audioIn.style.height, 10);
    if (Number.isFinite(x) && Number.isFinite(y)) partial.audioInPos = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial.audioInSize = { width: w, height: h };
  }

  const webcam = document.querySelector('#webcam-panel');
  if (webcam && !webcam.hidden) {
    const x = parseInt(webcam.style.left,   10);
    const y = parseInt(webcam.style.top,    10);
    const w = parseInt(webcam.style.width,  10);
    const h = parseInt(webcam.style.height, 10);
    if (Number.isFinite(x) && Number.isFinite(y)) partial.webcamPos = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial.webcamSize = { width: w, height: h };
  }
  const terminal = document.querySelector('#terminal-panel');
  if (terminal && !terminal.hidden) {
    const x = parseInt(terminal.style.left,   10);
    const y = parseInt(terminal.style.top,    10);
    const w = parseInt(terminal.style.width,  10);
    const h = parseInt(terminal.style.height, 10);
    if (Number.isFinite(x) && Number.isFinite(y)) partial.terminalPos = { x, y };
    if (Number.isFinite(w) && Number.isFinite(h)) partial.terminalSize = { width: w, height: h };
  }

  try { window.dash.setConfig(partial); } catch {}
}

// beforeunload fires on F5, window close, and app quit. pagehide covers
// the few cases beforeunload doesn't (some browser-mode paths). Both
// dispatch the same snapshot; main-process readModifyWrite dedupes.
window.addEventListener('beforeunload', _snapshotLayoutToConfig);
window.addEventListener('pagehide',     _snapshotLayoutToConfig);

// Side-arrange — Productivity (combo) at the top-center, every other panel
// tiled in stacked columns along the left and right edges. Leaves the
// middle area below Productivity intentionally empty so the wallpaper /
// 3D scene shows through. Persists every new position so it survives a
// reload. This is also the default layout on first launch — initFromConfig
// calls applySideArrange() when no panelSizes are stored yet (see below).
async function applySideArrange() {
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  // Every dimension in this layout is a multiple of the bg-grid cell
  // (SNAP_CELL = 40px) so every corner lands on a visible grid line.
  // Helpers: floor/round to the nearest 40 and clamp.
  const U = SNAP_CELL;
  const snapDown = (n) => Math.floor(n / U) * U;
  const snapNear = (n) => Math.round(n / U) * U;

  const margin = U;       // 40px outer gutter (one full grid cell)
  const gap    = U;       // 40px between stacked items

  // Side columns scale to ~26% of the viewport, snapped to the grid and
  // clamped so they never go below PANEL_MIN_W or balloon past 560 (the
  // nearest 40-multiple to the old 540 cap).
  const targetColW = Math.round(vpW * 0.26);
  const colW = Math.max(PANEL_MIN_W, Math.min(560, snapNear(targetColW)));

  // Side column X: left column starts on the very first grid line after
  // the left margin; right column is positioned so its RIGHT edge sits
  // on the last grid line that fits — left edge = rightEdge − colW.
  // Both colW and the X coords are 40-multiples → every left/right
  // border of every side panel falls on a vertical grid line.
  const leftColX  = margin;
  const rightColX = snapDown(vpW - margin) - colW;

  // Productivity (combo) fills the full middle area between the two
  // columns and runs top-to-bottom of the work area. prodW is the
  // largest 40-multiple that fits with one gap on each side. prodX is
  // the geometric centre, snapped down so its left edge sits on a grid
  // line — combined with the colW sizing the entire layout is one
  // grid-aligned composition.
  const innerLeft  = leftColX  + colW + gap;
  const innerRight = rightColX - gap;
  const prodW = Math.max(PANEL_MIN_W, snapDown(innerRight - innerLeft));
  const prodX = snapNear(innerLeft + (innerRight - innerLeft - prodW) / 2);
  const prodY = margin;
  const prodH = Math.max(PANEL_MIN_H, snapDown(vpH - margin) - margin);

  // Side columns run from one grid line below the top margin down to
  // the matching grid line above the bottom margin. slotH (per-item
  // height inside a column) is also forced to a 40-multiple, so every
  // panel/audio-grid TOP/BOTTOM edge is on a horizontal grid line.
  const colTop    = margin;
  const colBottom = snapDown(vpH - margin);
  const colH      = Math.max(PANEL_MIN_H, colBottom - colTop);

  // Column assignments per the rec-room rules: panels stack vertically
  // on the LEFT and RIGHT, with audio-in / audio-out at the bottom of
  // each column. The 'transfers' panel was removed from the app, so
  // it's not listed. Items whose elements aren't in the DOM are
  // skipped silently by stackColumn below.
  const leftKeys  = ['clock', 'cpu', 'network', 'ram', 'audio-in'];
  const rightKeys = ['weather', 'thermal', 'gpu', 'storage', 'driveio', 'audio-out'];

  // Reset every style prop a previous drag/resize/fold might have set —
  // otherwise a stale `right: 12px` or `min-width: 600px` can fight the
  // new width and push the panel off-centre. Inline style wins on
  // specificity, so we have to clear them explicitly with empty strings.
  const resetPanelStyles = (panel) => {
    panel.style.right    = '';
    panel.style.bottom   = '';
    panel.style.minWidth = '';
    panel.style.minHeight = '';
    panel.classList.remove('is-collapsed', 'is-fold-half', 'is-fold-full');
  };

  const place = async (key, x, y, w, h) => {
    const panel = document.querySelector(`.panel-${key}`);
    if (!panel) return;
    resetPanelStyles(panel);
    panel.style.position = 'fixed';
    panel.style.flex     = '0 0 auto';
    panel.style.left     = `${x}px`;
    panel.style.top      = `${y}px`;
    panel.style.width    = `${w}px`;
    panel.style.height   = `${h}px`;
    panel.style.maxWidth = `${w}px`;
    await savePanelSize(key, { x, y, width: w, height: h });
  };

  // Place an audio visualizer at the given rect. Mirrors place() above
  // exactly: same width, same maxWidth (caps the layout box so any CSS
  // rule that later sets a wider width can't override us), clears the
  // CSS-default right/bottom anchors, and persists position + size so
  // applySavedGeom restores identical dimensions on reload. Per-chip
  // size keys keep the two chips independent — auto-orient places both
  // at the same dimensions here, but the user can resize each one
  // separately afterward.
  const placeAudio = async (side, x, y, w, h) => {
    const id = side === 'in' ? 'audio-in-grid' : 'audio-out-grid';
    const posKey  = side === 'in' ? 'audioInPos'  : 'audioOutPos';
    const sizeKey = side === 'in' ? 'audioInSize' : 'audioOutSize';
    const el = document.getElementById(id);
    if (!el) return;
    el.style.position = 'fixed';
    el.style.left     = `${x}px`;
    el.style.top      = `${y}px`;
    el.style.right    = 'auto';
    el.style.bottom   = 'auto';
    el.style.width    = `${w}px`;
    el.style.height   = `${h}px`;
    el.style.maxWidth = `${w}px`;
    el.style.flex     = '0 0 auto';
    if (window.dash?.setConfig) {
      try {
        await window.dash.setConfig({
          [posKey]: { x, y },
          [sizeKey]: { width: w, height: h },
        });
      } catch {}
    }
  };

  const itemExists = (key) => {
    if (key === 'audio-in')  return !!document.getElementById('audio-in-grid');
    if (key === 'audio-out') return !!document.getElementById('audio-out-grid');
    return !!document.querySelector(`.panel-${key}`);
  };

  const placeItem = async (key, x, y, w, h) => {
    if (key === 'audio-in')  return placeAudio('in',  x, y, w, h);
    if (key === 'audio-out') return placeAudio('out', x, y, w, h);
    return place(key, x, y, w, h);
  };

  // Hard rule: audio-in and audio-out are ALWAYS the same size,
  // regardless of how many other panels share each column. Reserve a
  // shared slot at the bottom of each column for them, computed from
  // the column height (clamped + snapped to the grid). Both columns
  // share colH so this single value applies to both audio grids.
  const audioHTarget  = Math.round(colH * 0.13);
  const audioHClamped = Math.max(120, Math.min(240, audioHTarget));
  const audioH = Math.max(PANEL_MIN_H, Math.floor(audioHClamped / U) * U);

  const stackColumn = async (keys, x) => {
    const present = keys.filter(itemExists);
    if (present.length === 0) return;
    // Pull the audio entry (if any) out of the regular flow so we can
    // pin it to the column bottom at the shared audioH height.
    const audioKey = present.find((k) => k === 'audio-in' || k === 'audio-out') || null;
    const nonAudio = audioKey ? present.filter((k) => k !== audioKey) : present;
    // Subtract the audio slot + its leading gap from the column space
    // available to the other panels. Floor-snap each panel's height to
    // the 40-multiple so every top/bottom edge lands on a bg-grid line
    // and no item gets bumped off-screen by accumulated rounding.
    const reserved = audioKey ? (audioH + gap) : 0;
    const remaining = colH - reserved;
    let slotH = PANEL_MIN_H;
    if (nonAudio.length > 0) {
      const rawSlotH = (remaining - (nonAudio.length - 1) * gap) / nonAudio.length;
      slotH = Math.max(PANEL_MIN_H, Math.floor(rawSlotH / U) * U);
    }
    let y = colTop;
    for (const k of nonAudio) {
      await placeItem(k, x, y, colW, slotH);
      y += slotH + gap;
    }
    if (audioKey) {
      const audioY = colBottom - audioH;
      await placeItem(audioKey, x, audioY, colW, audioH);
    }
  };

  await place('combo', prodX, prodY, prodW, prodH);
  await stackColumn(leftKeys,  leftColX);
  await stackColumn(rightKeys, rightColX);
}

// Background diagnostics overlay — large faint monospace process block
// centered in the viewport. Polls heap / FPS / DOM nodes / draws per
// second once a second, paints into the .diag-block. Toggled by the
// topbar #diag-btn and persisted under config.diagOverlay.
const diagOverlayEl = document.getElementById('diag-overlay');
const diagContentEl = document.getElementById('diag-content');
const diagBtnEl     = document.querySelector('#diag-btn');
let _diagOn = false;

function _fmtUp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function _fmtMb(bytes) { return `${(bytes / 1048576).toFixed(0)} MB`; }

function _setDiagLine(key, text) {
  const el = diagContentEl?.querySelector(`[data-key="${key}"]`);
  if (!el) return;
  // Wrap each character in its own span with a randomized animation
  // phase + duration so every letter pulses independently. Negative
  // delay starts each char mid-cycle so they don't all begin at the
  // dim point together.
  const frag = document.createDocumentFragment();
  for (const ch of text) {
    const span = document.createElement('span');
    span.className = ch === ' ' ? 'diag-char is-space' : 'diag-char';
    span.textContent = ch;
    const dur   = (2.5 + Math.random() * 3.0).toFixed(2);  // 2.5–5.5s
    const delay = (-Math.random() * 4).toFixed(2);          // -4..0s
    span.style.animationDuration = `${dur}s`;
    span.style.animationDelay    = `${delay}s`;
    frag.appendChild(span);
  }
  el.replaceChildren(frag);
}
// Cache of main-process stats — repopulated by the telemetry tick.
let _mainStats = null;
async function pollMainStats() {
  if (!window.dash?.processStats) return;
  try { _mainStats = await window.dash.processStats(); } catch {}
}

function paintDiag() {
  if (!diagContentEl) return;
  const mem = performance.memory || {};
  const rheap   = mem.usedJSHeapSize  ? _fmtMb(mem.usedJSHeapSize)  : '—';
  const rheapMx = mem.jsHeapSizeLimit ? _fmtMb(mem.jsHeapSizeLimit) : '—';
  const mrss    = _mainStats?.rss ? _fmtMb(_mainStats.rss) : '—';
  const nodes   = document.getElementsByTagName('*').length;
  const up      = _fmtUp((Date.now() - _appStartTs) / 1000);
  const theme   = (document.documentElement.getAttribute('data-theme') || 'default').toUpperCase();
  const ver     = document.querySelector('#version-chip')?.textContent || 'v—';
  const dpr     = (window.devicePixelRatio || 1).toFixed(0);
  const vp      = `${window.innerWidth}x${window.innerHeight} @${dpr}x`;

  // Canvas count + a rough estimate of GPU-backed bytes (W * H * 4 bytes
  // per pixel for an RGBA8 framebuffer). Doesn't account for double-
  // buffering or compositor overhead, just gives a sense of scale.
  const canvasEls = document.querySelectorAll('canvas');
  let cmem = 0;
  canvasEls.forEach((c) => { cmem += (c.width * c.height * 4); });
  const canvasLine = `${canvasEls.length} · ${(cmem / 1048576).toFixed(1)} MB`;

  // Audio visualizer state — bar count + LIVE / MUTED.
  const inBars   = audioInViz?.getBarCount?.()  ?? 0;
  const outBars  = audioOutViz?.getBarCount?.() ?? 0;
  const inMuted  = audioInViz?.isMuted?.()  ? 'MUTED' : 'LIVE';
  const outMuted = audioOutViz?.isMuted?.() ? 'MUTED' : 'LIVE';

  // Combo-pane mode + zen state.
  const cpMode = (document.querySelector('.panel-combo')?.dataset.mode || '—').toUpperCase();
  const zen    = document.body.classList.contains('is-zen') ? ' · ZEN' : '';

  _setDiagLine('title',   `DASHBOARD3D ${ver}`);
  _setDiagLine('rheap',   `R-HEAP   ${rheap} / ${rheapMx}`);
  _setDiagLine('mrss',    `M-RSS    ${mrss}`);
  _setDiagLine('nodes',   `NODES    ${nodes.toLocaleString()}`);
  _setDiagLine('canvas',  `CANVAS   ${canvasLine}`);
  _setDiagLine('fps',     `FPS      ${_diagFps}`);
  _setDiagLine('draws',   `DRAWS/S  ${_diagDrawPerS}`);
  _setDiagLine('viewport',`VIEWPORT ${vp}`);
  _setDiagLine('audioin', `AUDIO IN  ${inBars} BARS · ${inMuted}`);
  _setDiagLine('audioout',`AUDIO OUT ${outBars} BARS · ${outMuted}`);
  _setDiagLine('mode',    `MODE      ${cpMode}${zen}`);
  _setDiagLine('theme',   `THEME    ${theme}`);
  _setDiagLine('up',      `UP       ${up}`);
}

// FPS counter — counts requestAnimationFrame callbacks; reset each tick.
// Only runs while the diagnostic overlay is visible. Keeping a rAF loop
// alive at display refresh (e.g. 117 Hz here) kept the compositor + GPU
// thread + V8 hot 24/7 across every Electron child process and produced
// constant parallel-GC bursts across all CPU cores even when the user
// wasn't looking at the FPS number. Now it spins up on setDiagOn(true)
// and shuts off on setDiagOn(false).
let _diagFpsRaf = 0;
function _diagFrame() {
  _diagFrames++;
  _diagFpsRaf = requestAnimationFrame(_diagFrame);
}
function _startDiagFpsCounter() {
  if (_diagFpsRaf) return;
  _diagFpsRaf = requestAnimationFrame(_diagFrame);
}
function _stopDiagFpsCounter() {
  if (_diagFpsRaf) {
    cancelAnimationFrame(_diagFpsRaf);
    _diagFpsRaf = 0;
  }
  _diagFrames = 0;
}

// Telemetry tick — snapshot counters, refresh main-process stats, then
// repaint overlay if visible. FPS / DRAWS-per-second stay accurate at
// the longer window because we divide the raw counters by the window
// length in seconds before displaying.
setInterval(async () => {
  if (document.hidden) return;
  const sec = UI_REFRESH_MS / 1000;
  _diagFps       = Math.round(_diagFrames     / sec);
  _diagDrawPerS  = Math.round(_diagDrawCalls  / sec);
  _diagFrames    = 0;
  _diagDrawCalls = 0;
  if (_diagOn) {
    await pollMainStats();
    paintDiag();
  }
}, UI_REFRESH_MS);

function setDiagOn(on) {
  _diagOn = !!on;
  if (diagOverlayEl) diagOverlayEl.hidden = !_diagOn;
  diagBtnEl?.classList.toggle('is-active', !!on);
  if (_diagOn) {
    _startDiagFpsCounter();
    pollMainStats().then(paintDiag);
  } else {
    _stopDiagFpsCounter();
  }
}
diagBtnEl?.addEventListener('click', async () => {
  setDiagOn(!_diagOn);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ diagOverlay: _diagOn }); } catch {}
  }
});
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.diagOverlay) setDiagOn(true);
})();

// Topbar flush-RAM / refresh / sleep buttons + their handlers were
// removed per user request. The underlying IPC (window.dash.flushRam,
// window.dash.systemSleep) is left in place because tasks-flush-btn in
// the productivity Tasks panel still uses flushRam; sleep IPC has no
// remaining caller and can be pruned from main/preload separately if
// you want full mechanism removal.

// ── SYSTEM TRIM (service sweep) ──────────────────────────────────────────
// Feature lives in features/trim.js — wired up here with the renderer
// helpers it needs (playSfx). See that module for the modal logic.
initTrim({ playSfx });

// ── APP LAUNCHER (appliance) ────────────────────────────────────────────
// Feature lives in features/launcher.js — the topbar #launcher-btn pins/
// starts other programs. Built for the appliance build where the
// dashboard is the shell.
initLauncher({ playSfx });

// ── POWER/THERMAL PROFILE (appliance fan control) ────────────────────────
// Profile selector in the thermal panel. Clicks are handled by a single
// capture-phase listener on the document — the per-button listeners used
// before were dead on the appliance; a capture-phase document listener
// fires before anything downstream can swallow the event.
async function initThermalProfile() {
  const wrap = document.getElementById('thermal-profile');
  const btns = document.getElementById('thermal-profile-btns');
  if (!wrap || !btns || !window.dash?.fansGetProfile) return;
  let info = null;
  try { info = await window.dash.fansGetProfile(); } catch {}
  if (!info?.ok || !Array.isArray(info.choices) || !info.choices.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  let status = wrap.querySelector('.thermal-profile-status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'thermal-profile-status';
    wrap.appendChild(status);
  }
  const render = (current) => {
    btns.innerHTML = '';
    for (const choice of info.choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'thermal-profile-btn' + (choice === current ? ' is-active' : '');
      b.textContent = choice;
      b.dataset.profile = choice;
      btns.appendChild(b);
    }
  };
  const applyProfile = async (choice) => {
    playSfx?.('click');
    status.textContent = `${choice} …`;
    try {
      const r = await window.dash.fansSetProfile(choice);
      if (r?.ok) { render(r.current); playSfx?.('click'); }
      else playSfx?.('error');
      const parts = [`${choice} -> ${r?.current ?? '?'}`];
      if (Array.isArray(r?.steps) && r.steps.length) parts.push(r.steps.join(' · '));
      if (r?.error) parts.push(`ERR ${r.error}`);
      status.textContent = parts.join('  |  ');
    } catch (e) {
      playSfx?.('error');
      status.textContent = `${choice} -> exception ${e?.message || e}`;
    }
  };
  document.addEventListener('click', (ev) => {
    const b = ev.target?.closest?.('.thermal-profile-btn');
    if (b && btns.contains(b)) applyProfile(b.dataset.profile);
  }, true);
  render(info.current);
}
initThermalProfile();

// Hardware/thermal diagnostic — "HW DIAG" button in the thermal panel.
// Click handled via capture-phase document delegation (see above).
async function initHwDiag() {
  const wrap = document.getElementById('thermal-hwdiag');
  const btn = document.getElementById('hwdiag-btn');
  const out = document.getElementById('hwdiag-out');
  if (!wrap || !btn || !out || !window.dash?.hwDiag) return;
  let probe = null;
  try { probe = await window.dash.hwDiag(); } catch {}
  if (!probe?.ok || /linux appliance only/.test(probe.report || '')) return;
  wrap.hidden = false;
  document.addEventListener('click', async (ev) => {
    if (!ev.target?.closest?.('#hwdiag-btn')) return;
    playSfx?.('click');
    if (!out.hidden) { out.hidden = true; return; }
    out.textContent = 'reading hardware …';
    out.hidden = false;
    try {
      const r = await window.dash.hwDiag();
      out.textContent = r?.ok ? r.report : ('hw-diag failed: ' + (r?.error || '?'));
    } catch (e) {
      out.textContent = 'hw-diag exception: ' + (e?.message || e);
    }
  }, true);
}
initHwDiag();

// ── GAME MODE ────────────────────────────────────────────────────────────
// Topbar button: on the Linux appliance the dashboard and Steam Big
// Picture both run for the whole session. This button just HIDES the
// dashboard overlay — Steam is already running underneath, instantly
// revealed. Press F13 (or the controller chord mapped to it) to bring
// the dashboard back. No process is killed, no hand-off.
// Capture-phase delegation, like the thermal buttons.
function initGameMode() {
  const btn = document.getElementById('gamemode-btn');
  if (!btn) return;
  // Transient error surface — only used if the bridge is missing or the
  // hide call fails. The success path shows nothing: the window just
  // hides, and comes back clean on F13.
  const showError = (msg) => {
    let ov = document.getElementById('gamemode-overlay-msg');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'gamemode-overlay-msg';
      ov.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;background:#000;' +
        'color:#39ff14;font:bold 22px/1.6 monospace;white-space:pre-wrap;' +
        'display:flex;align-items:center;justify-content:center;text-align:center;padding:6vw;';
      document.body.appendChild(ov);
    }
    ov.textContent = msg + '\n\n(tap to dismiss)';
    ov.onclick = () => ov.remove();
  };
  document.addEventListener('click', async (ev) => {
    if (!ev.target?.closest?.('#gamemode-btn')) return;
    playSfx?.('click');
    if (!window.dash?.enterGameMode) {
      showError('Game Mode: the enterGameMode bridge is missing.');
      return;
    }
    try {
      const r = await window.dash.enterGameMode();
      if (!r?.ok) {
        showError('Game Mode failed:\n' + (r?.error || 'unknown'));
        playSfx?.('error');
      }
      // On success the window is already hidden — nothing to paint.
    } catch (e) {
      showError('Game Mode exception:\n' + (e?.message || e));
      playSfx?.('error');
    }
  }, true);
}
initGameMode();

// ── TASKS pane (process / service monitor) ───────────────────────────────
// Combo-pane mode 'tasks' surfaces app.getAppMetrics() from main: every
// Electron child process (Browser / Renderer / GPU / Utility / …) with
// per-proc CPU + working-set memory. Polled every UI_REFRESH_MS but only
// while the pane is the active combo mode so we don't burn CPU when the
// user is elsewhere. Each piece of text uses the diag-char letter pulse
// from the diagnostics overlay so the whole pane scintillates the way
// the rest of the dashboard chrome does.
window._tasksState = window._tasksState || {
  procCount: null,
  sort:      'memory',    // memory · cpu · pid · name
  selectedPid: null,
  prevCpu: new Map(),     // pid -> last cpu sample, for scramble-on-change
};

function _scrambleInto(el, text) {
  if (!el) return;
  const frag = document.createDocumentFragment();
  for (const ch of String(text)) {
    const span = document.createElement('span');
    span.className = ch === ' ' ? 'diag-char is-space' : 'diag-char';
    span.textContent = ch;
    const dur   = (2.5 + Math.random() * 3.0).toFixed(2);  // 2.5–5.5s
    const delay = (-Math.random() * 4).toFixed(2);          // -4..0s
    span.style.animationDuration = `${dur}s`;
    span.style.animationDelay    = `${delay}s`;
    frag.appendChild(span);
  }
  el.replaceChildren(frag);
}

function _fmtMemKb(kb) {
  if (!Number.isFinite(kb) || kb <= 0) return '—';
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function _fmtMemBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

// Compute system CPU % from two consecutive os.cpus() snapshots. Caches
// the prior sample on _tasksState so successive polls produce a moving
// percentage. Returns null on the very first call (no delta yet).
function _computeSysCpu(sysInfo) {
  if (!sysInfo || !Array.isArray(sysInfo.cpuTimes)) return null;
  const prev = window._tasksState._prevCpuTimes;
  window._tasksState._prevCpuTimes = sysInfo.cpuTimes.map((t) => ({ ...t }));
  if (!prev || prev.length !== sysInfo.cpuTimes.length) return null;
  let busyDelta = 0, totalDelta = 0;
  for (let i = 0; i < sysInfo.cpuTimes.length; i++) {
    const p = prev[i], c = sysInfo.cpuTimes[i];
    const pTotal = (p.user || 0) + (p.nice || 0) + (p.sys || 0) + (p.idle || 0) + (p.irq || 0);
    const cTotal = (c.user || 0) + (c.nice || 0) + (c.sys || 0) + (c.idle || 0) + (c.irq || 0);
    const dT = cTotal - pTotal;
    const dI = (c.idle || 0) - (p.idle || 0);
    if (dT > 0) {
      busyDelta  += (dT - dI);
      totalDelta += dT;
    }
  }
  if (totalDelta <= 0) return null;
  return (busyDelta / totalDelta) * 100;
}

function _fmtUpSec(s) {
  if (!Number.isFinite(s) || s < 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function _procTypeLabel(t) {
  // Electron's process types map to short, fixed-width labels so the
  // PID column lines up regardless of which subprocess is reporting.
  switch ((t || '').toLowerCase()) {
    case 'browser':         return 'MAIN';
    case 'renderer':        return 'RNDR';
    case 'gpu':             return 'GPU';
    case 'utility':         return 'UTIL';
    case 'zygote':          return 'ZYG';
    case 'sandbox helper':  return 'SBOX';
    case 'pepper plugin':   return 'PLUG';
    case 'ppapi':           return 'PPAPI';
    default:                return (t || '?').slice(0, 4).toUpperCase();
  }
}

// Services the app depends on — sourced from src/main/services/. Each
// row is a lightweight status pill that the renderer can probe by
// calling the corresponding window.dash channel (probe = "does the
// channel respond"). Static service catalog so the pane shows what the
// app *requires* even when polling fails.
// Each service maps to a window.dash channel we can call as a liveness
// probe. POWER and WM don't have public read endpoints — they're modules
// in main — so they piggyback on appVersion (any successful main-process
// IPC means the host is alive). `slow` services (sensors via LHM) get a
// longer timeout because PowerShell + native temp reads cost real time.
const TASK_SERVICES = [
  { key: 'system',  label: 'SYSTEM',   code: 'CPU · MEM · OS',     probe: 'systemInfo'      },
  { key: 'sensors', label: 'SENSORS',  code: 'GPU · TEMPS · LHM',  probe: 'tempsInfo',    slow: true },
  { key: 'power',   label: 'POWER',    code: 'PROFILE · ZEN',      probe: 'appVersion'      },
  { key: 'audio',   label: 'AUDIO',    code: 'WASAPI · LOOPBACK',  probe: 'getMuteStates'   },
  { key: 'storage', label: 'STORAGE',  code: 'DISK · DRIVES',      probe: 'storageInfo'     },
  { key: 'network', label: 'NETWORK',  code: 'LIVE TRAFFIC',       probe: 'netInfo'         },
  { key: 'wm',      label: 'WINDOW',   code: 'Z-ORDER · FOCUS',    probe: 'appVersion'      },
  { key: 'browser', label: 'BROWSER',  code: 'BROWSERVIEW · ADS',  probe: 'browserGetStats' },
];
// Last-good cache so a single slow tick doesn't flip a probed service to
// DOWN — we only mark it down after _SVC_DOWN_GRACE consecutive misses.
const _svcLastOk    = new Map();  // key -> ms timestamp of last resolve
const _svcMisses    = new Map();  // key -> consecutive timeout/reject count
const _SVC_FAST_MS  = 1200;
const _SVC_SLOW_MS  = 3500;
const _SVC_DOWN_GRACE = 3;        // ticks of misses before flipping to DOWN

const tasksProcListEl    = document.getElementById('tasks-proc-list');
const tasksSvcListEl     = document.getElementById('tasks-svc-list');
const tasksFlushBtnEl    = document.getElementById('tasks-flush-btn');
const tasksRefreshBtnEl  = document.getElementById('tasks-refresh-btn');
const tasksPaneEl        = document.querySelector('.combo-pane-tasks');

function _sortProcs(metrics) {
  const arr = Array.isArray(metrics) ? metrics.slice() : [];
  const sort = window._tasksState.sort;
  if (sort === 'memory') {
    arr.sort((a, b) => (b?.memory?.workingSetSize || 0) - (a?.memory?.workingSetSize || 0));
  } else if (sort === 'cpu') {
    arr.sort((a, b) => (b?.cpu?.percentCPUUsage || 0) - (a?.cpu?.percentCPUUsage || 0));
  } else if (sort === 'pid') {
    arr.sort((a, b) => (a?.pid || 0) - (b?.pid || 0));
  } else if (sort === 'name') {
    arr.sort((a, b) => String(a?.type || '').localeCompare(String(b?.type || '')));
  }
  return arr;
}

function renderTasks(data, sysInfo) {
  if (!tasksPaneEl || !data) return;
  const metrics = _sortProcs(data.metrics || []);
  window._tasksState.procCount = metrics.length;

  // ── RAM breakdown (in bytes) ────────────────────────────────────
  //   APP   = sum of working-set RAM across every Electron child proc
  //   SYS   = system total used (os.totalmem - os.freemem)
  //   OTHER = SYS - APP  (clamped to zero in case the polls disagree)
  const appKb     = metrics.reduce((s, p) => s + (p?.memory?.workingSetSize || 0), 0);
  const appBytes  = appKb * 1024;
  const sysUsed   = Number.isFinite(sysInfo?.usedMem)  ? sysInfo.usedMem  : null;
  const sysTotal  = Number.isFinite(sysInfo?.totalMem) ? sysInfo.totalMem : null;
  const otherBytes = sysUsed != null ? Math.max(0, sysUsed - appBytes) : null;

  // ── CPU breakdown (% of whole system) ───────────────────────────
  //   getAppMetrics reports percentCPUUsage as 0..(100 * coreCount); to
  //   express as % of the whole system we divide by coreCount.
  //   SYS CPU comes from os.cpus() deltas between two polls — we cache
  //   the previous sample on window._tasksState.
  const coreCount = sysInfo?.cpuCount || (sysInfo?.cpuTimes?.length) || 1;
  const appCpuPct = metrics.reduce((s, p) => s + (p?.cpu?.percentCPUUsage || 0), 0) / coreCount;
  const sysCpuPct = _computeSysCpu(sysInfo);
  const otherCpu  = sysCpuPct != null ? Math.max(0, sysCpuPct - appCpuPct) : null;

  // Hero block — labels stay static (rendered once), values scramble.
  const heroLabels = {
    app:     'APP',
    pid:     'PID',
    upt:     'UPTIME',
    plat:    'PLATFORM',
    appstat: 'APP USAGE',
    othstat: 'UNDERLYING SYSTEM',
    totstat: 'USAGE TOTAL',
  };
  for (const [k, v] of Object.entries(heroLabels)) {
    _scrambleInto(tasksPaneEl.querySelector(`[data-tasks-line="${k}"]`), v);
  }
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="appval"]'),
    `${(data.appName || 'DASHBOARD3D').toUpperCase()} ${data.appVersion ? 'V' + data.appVersion : ''}`);
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="pidval"]'),  String(data.pid ?? '—'));
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="uptval"]'),  _fmtUpSec(data.uptimeSec));
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="platval"]'),
    `${(data.platform || '').toUpperCase()} · CHROMIUM ${data.chrome || '—'}`);
  // Combined-stat lines: "RAM <bytes> · CPU <pct>%" per concept.
  const fmtStat = (bytes, cpu) => `RAM ${_fmtMemBytes(bytes)} · CPU ${cpu.toFixed(1)} %`;
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="appstatval"]'),
    fmtStat(appBytes, appCpuPct));
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="othstatval"]'),
    otherBytes != null && otherCpu != null
      ? fmtStat(otherBytes, otherCpu)
      : '—');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="totstatval"]'),
    sysUsed != null && sysCpuPct != null
      ? `RAM ${_fmtMemBytes(sysUsed)} / ${_fmtMemBytes(sysTotal)} · CPU ${sysCpuPct.toFixed(1)} %`
      : '—');

  // Section headers
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="proctitle"]'), 'PROCESSES');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="proctag"]'),
    `${metrics.length} ACTIVE`);
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="svctitle"]'), 'SERVICES');
  _scrambleInto(tasksPaneEl.querySelector('[data-tasks-line="svctag"]'),
    `${TASK_SERVICES.length} REGISTERED`);

  // Process rows. Reuse existing <li> nodes when count matches to avoid
  // re-creating DOM on every tick (cheap-enough animation work stays
  // limited to the inner spans).
  if (!tasksProcListEl) return;
  if (tasksProcListEl.children.length !== metrics.length) {
    tasksProcListEl.replaceChildren();
    for (let i = 0; i < metrics.length; i++) {
      const li = document.createElement('li');
      li.className = 'tasks-proc-row';
      li.innerHTML = `
        <span class="tp-type" data-col="type"></span>
        <span class="tp-pid"  data-col="pid"></span>
        <span class="tp-name" data-col="name"></span>
        <span class="tp-bar"><span class="tp-bar-fill" data-col="bar"></span></span>
        <span class="tp-cpu"  data-col="cpu"></span>
        <span class="tp-mem"  data-col="mem"></span>
      `;
      tasksProcListEl.appendChild(li);
    }
  }
  const maxKb = Math.max(1, ...metrics.map(p => p?.memory?.workingSetSize || 0));
  const rows = tasksProcListEl.children;
  metrics.forEach((p, i) => {
    const row = rows[i]; if (!row) return;
    const pid    = p?.pid ?? '?';
    const type   = _procTypeLabel(p?.type);
    const cpu    = (p?.cpu?.percentCPUUsage || 0).toFixed(1);
    const kb     = p?.memory?.workingSetSize || 0;
    const name   = (p?.serviceName || p?.name || p?.type || '').toString().toUpperCase().slice(0, 28) || '—';
    row.dataset.pid = String(pid);
    row.classList.toggle('is-selected', window._tasksState.selectedPid === pid);
    _scrambleInto(row.querySelector('[data-col="type"]'), type);
    _scrambleInto(row.querySelector('[data-col="pid"]'),  String(pid));
    _scrambleInto(row.querySelector('[data-col="name"]'), name);
    _scrambleInto(row.querySelector('[data-col="cpu"]'),  `${cpu}%`);
    _scrambleInto(row.querySelector('[data-col="mem"]'),  _fmtMemKb(kb));
    const fill = row.querySelector('[data-col="bar"]');
    if (fill) fill.style.width = `${Math.min(100, (kb / maxKb) * 100)}%`;
  });

  // Services list — built once, then live-probed each tick. Each row's
  // dot turns green when the matching window.dash channel resolves.
  if (tasksSvcListEl && tasksSvcListEl.children.length !== TASK_SERVICES.length) {
    tasksSvcListEl.replaceChildren();
    for (const svc of TASK_SERVICES) {
      const li = document.createElement('li');
      li.className = 'tasks-svc-row';
      li.dataset.key = svc.key;
      li.innerHTML = `
        <span class="ts-dot"></span>
        <span class="ts-label" data-col="label"></span>
        <span class="ts-code"  data-col="code"></span>
        <span class="ts-state" data-col="state">PROBE…</span>
      `;
      tasksSvcListEl.appendChild(li);
    }
  }
  if (tasksSvcListEl) {
    for (const li of tasksSvcListEl.children) {
      const key = li.dataset.key;
      const svc = TASK_SERVICES.find(s => s.key === key);
      if (!svc) continue;
      _scrambleInto(li.querySelector('[data-col="label"]'), svc.label);
      _scrambleInto(li.querySelector('[data-col="code"]'),  svc.code);
      const stateEl = li.querySelector('[data-col="state"]');
      if (!svc.probe || !window.dash?.[svc.probe]) {
        // No channel exposed — treat as missing IPC.
        li.classList.remove('is-up', 'is-static');
        li.classList.add('is-down');
        _scrambleInto(stateEl, 'MISSING');
        continue;
      }
      // Probe-with-grace: a timeout doesn't immediately flip the row
      // to DOWN; it just bumps a miss counter. The row only goes DOWN
      // after _SVC_DOWN_GRACE consecutive misses, so slow services
      // (LHM / PowerShell) stay green across the occasional long tick.
      const timeoutMs = svc.slow ? _SVC_SLOW_MS : _SVC_FAST_MS;
      let settled = false;
      const settle = (ok) => {
        if (settled) return; settled = true;
        if (ok) {
          _svcLastOk.set(key, Date.now());
          _svcMisses.set(key, 0);
          li.classList.remove('is-down', 'is-static');
          li.classList.add('is-up');
          _scrambleInto(stateEl, 'ONLINE');
        } else {
          const n = (_svcMisses.get(key) || 0) + 1;
          _svcMisses.set(key, n);
          if (n >= _SVC_DOWN_GRACE) {
            li.classList.remove('is-up', 'is-static');
            li.classList.add('is-down');
            _scrambleInto(stateEl, 'DOWN');
          } else if (_svcLastOk.has(key)) {
            // Keep the previous ONLINE pill while we're inside the grace
            // window so the user doesn't see flapping.
            li.classList.remove('is-down', 'is-static');
            li.classList.add('is-up');
            _scrambleInto(stateEl, 'ONLINE');
          } else {
            _scrambleInto(stateEl, 'PROBE…');
          }
        }
      };
      Promise.resolve()
        .then(() => window.dash[svc.probe]())
        .then(() => settle(true))
        .catch(() => settle(false));
      setTimeout(() => settle(false), timeoutMs);
    }
  }

  paintComboHeader();
  // Expose so the boot-status sequence (in the boot-flicker block at
  // module top) can call this after its greeting fade-out finishes,
  // to restore the mode-driven subtitle without duplicating the
  // mode → text mapping here.
  _paintComboHeader = paintComboHeader;
}

async function refreshTasksNow() {
  if (!window.dash?.appMetrics) return;
  try {
    // Parallel: appMetrics for per-process detail, systemInfo for the
    // overall system RAM/CPU totals so we can compute OTHER = SYS - APP.
    const [data, sysInfo] = await Promise.all([
      window.dash.appMetrics(),
      window.dash?.systemInfo?.().catch(() => null),
    ]);
    renderTasks(data, sysInfo);
  } catch (err) {
    console.warn('[tasks] poll failed:', err?.message || err);
  }
}

setInterval(() => {
  if (document.hidden) return;
  if (comboPanel?.dataset.mode !== 'tasks') return;
  refreshTasksNow();
}, UI_REFRESH_MS);

// Sort buttons cycle the active mode + immediately repaint.
tasksPaneEl?.querySelectorAll('.tasks-sort-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.tasksSort;
    if (!key) return;
    window._tasksState.sort = key;
    tasksPaneEl.querySelectorAll('.tasks-sort-btn').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tasksSort === key);
    });
    playSfx?.('click');
    refreshTasksNow();
  });
});

// Hero-stat row select — clicking one of the three combined-stat rows
// (APP USAGE / UNDERLYING SYSTEM / USAGE TOTAL) toggles a persistent
// highlight; selection survives across refreshes via _tasksState.
tasksPaneEl?.addEventListener('click', (e) => {
  const row = e.target.closest?.('.tasks-hero-stat');
  if (!row || !tasksPaneEl.contains(row)) return;
  const key = row.dataset.tasksLine;
  if (!key) return;
  window._tasksState.selectedStat = (window._tasksState.selectedStat === key) ? null : key;
  tasksPaneEl.querySelectorAll('.tasks-hero-stat').forEach((r) => {
    r.classList.toggle('is-selected', r.dataset.tasksLine === window._tasksState.selectedStat);
  });
  playSfx?.('click');
});

// Process-row select — toggles a highlight on the clicked PID. Selection
// survives across refreshes because renderTasks() applies it from
// _tasksState.
tasksProcListEl?.addEventListener('click', (e) => {
  const row = e.target.closest?.('.tasks-proc-row');
  if (!row) return;
  const pid = Number(row.dataset.pid);
  if (!Number.isFinite(pid)) return;
  window._tasksState.selectedPid = (window._tasksState.selectedPid === pid) ? null : pid;
  for (const r of tasksProcListEl.children) {
    r.classList.toggle('is-selected', Number(r.dataset.pid) === window._tasksState.selectedPid);
  }
  playSfx?.('click');
});

tasksRefreshBtnEl?.addEventListener('click', () => {
  playSfx?.('click');
  refreshTasksNow();
});

tasksFlushBtnEl?.addEventListener('click', async () => {
  if (!window.dash?.flushRam) return;
  tasksFlushBtnEl.classList.add('is-busy');
  try {
    const r = await window.dash.flushRam();
    if (r?.flushed != null) {
      console.log(`[tasks] flush — ${r.flushed} working sets dropped (${r.failed || 0} failed)`);
      playSfx?.('confirm');
    } else {
      playSfx?.('error');
    }
  } catch (err) {
    console.warn('[tasks] flush failed:', err?.message || err);
    playSfx?.('error');
  } finally {
    tasksFlushBtnEl.classList.remove('is-busy');
    refreshTasksNow();
  }
});

// ── First-run guided setup wizard ──────────────────────────────────────────
// Three-step overlay (WiFi → Location → Name) that opens automatically when
// cfg.setupCompleted is false, and on-demand via the topbar #setup-btn.
// Persists into the same config keys the rest of the app already reads:
//   weatherCity (object), altCity (object), userName (string), setupCompleted
const frOverlayEl = document.getElementById('first-run-overlay');
if (frOverlayEl) {
  const frCard       = frOverlayEl.querySelector('.fr-card');
  const frCloseBtn   = frOverlayEl.querySelector('#fr-close-btn');
  const frStepsEls   = frOverlayEl.querySelectorAll('.fr-step');
  const frPaneEls    = frOverlayEl.querySelectorAll('.fr-pane');
  // WiFi pane
  const frWifiSub        = frOverlayEl.querySelector('#fr-wifi-sub');
  const frWifiCurrent    = frOverlayEl.querySelector('#fr-wifi-current');
  const frWifiCurrentSsid= frOverlayEl.querySelector('#fr-wifi-current-ssid');
  const frWifiRescanBtn  = frOverlayEl.querySelector('#fr-wifi-rescan-btn');
  const frWifiListEl     = frOverlayEl.querySelector('#fr-wifi-list');
  const frWifiPassRow    = frOverlayEl.querySelector('#fr-wifi-password-row');
  const frWifiPassInput  = frOverlayEl.querySelector('#fr-wifi-password');
  const frWifiCancelBtn  = frOverlayEl.querySelector('#fr-wifi-cancel-btn');
  const frWifiConnectBtn = frOverlayEl.querySelector('#fr-wifi-connect-btn');
  const frWifiStatus     = frOverlayEl.querySelector('#fr-wifi-status');
  const frWifiSkipBtn    = frOverlayEl.querySelector('#fr-wifi-skip-btn');
  const frWifiNextBtn    = frOverlayEl.querySelector('#fr-wifi-next-btn');
  // Location pane
  const frLocInput   = frOverlayEl.querySelector('#fr-loc-input');
  const frLocResults = frOverlayEl.querySelector('#fr-loc-results');
  const frLocStatus  = frOverlayEl.querySelector('#fr-loc-status');
  const frLocBackBtn = frOverlayEl.querySelector('#fr-loc-back-btn');
  const frLocNextBtn = frOverlayEl.querySelector('#fr-loc-next-btn');
  // Name pane
  const frNameInput     = frOverlayEl.querySelector('#fr-name-input');
  const frNameBackBtn   = frOverlayEl.querySelector('#fr-name-back-btn');
  const frNameFinishBtn = frOverlayEl.querySelector('#fr-name-finish-btn');

  const STEPS = ['wifi', 'location', 'name'];
  let frPickedSsid = null;       // SSID currently selected in the scan list
  let frPickedLocation = null;   // geocoding hit selected for location step
  let frLocAbort = null;         // AbortController for in-flight geocoding

  // Animate every node tagged [data-fr-anim] with the per-letter pulse the
  // diagnostics overlay uses, so the wizard reads as part of the same UI.
  function _frScrambleAll() {
    frOverlayEl.querySelectorAll('[data-fr-anim]').forEach((el) => {
      const text = el.dataset.frAnimSrc != null ? el.dataset.frAnimSrc : el.textContent;
      el.dataset.frAnimSrc = text;
      _scrambleInto(el, text);
    });
  }

  function _frSetText(el, text) {
    if (!el) return;
    el.dataset.frAnimSrc = text;
    _scrambleInto(el, text);
  }

  function frShowStep(name) {
    frPaneEls.forEach((p) => p.classList.toggle('is-visible', p.dataset.frPane === name));
    const idx = STEPS.indexOf(name);
    frStepsEls.forEach((s, i) => {
      s.classList.toggle('is-active', i === idx);
      s.classList.toggle('is-done',   i <  idx);
    });
    if (name === 'wifi')     frPaintWifiInitial();
    if (name === 'location') setTimeout(() => frLocInput?.focus(), 60);
    if (name === 'name')     setTimeout(() => frNameInput?.focus(), 60);
  }

  async function frOpen() {
    frOverlayEl.hidden = false;
    // Restore everything the user previously entered so an interrupted
    // restart (or a manual re-open) doesn't make them re-type. The
    // wizard always starts at the WiFi step but the later panes show
    // their saved values straight away, so clicking through is a
    // single tap on each pane's NEXT / FINISH.
    try {
      const cfg = await window.dash?.getConfig?.() || {};
      if (cfg.weatherCity && typeof cfg.weatherCity === 'object') {
        // Restore the picked location so the user can hit NEXT without
        // re-searching — frPickedLocation is what frLocNextBtn requires
        // to be non-null before it advances.
        frPickedLocation = cfg.weatherCity;
        if (frLocInput) frLocInput.value = cfg.weatherCity.name || '';
        if (frLocNextBtn) frLocNextBtn.disabled = false;
      }
      if (cfg.userName && frNameInput) {
        frNameInput.value = cfg.userName;
      }
    } catch {}
    frShowStep('wifi');
    _frScrambleAll();
  }
  function frClose() { frOverlayEl.hidden = true; }

  // ── WiFi pane ─────────────────────────────────────────────────────
  async function frPaintWifiInitial() {
    frWifiListEl.hidden = true;
    frWifiPassRow.hidden = true;
    frWifiStatus.hidden = true;
    frPickedSsid = null;
    _frSetText(frWifiSub, 'CHECKING NETWORK…');
    if (!window.dash?.wifiStatus) {
      _frSetText(frWifiSub, 'WIFI CONTROL UNAVAILABLE · YOU CAN CONTINUE IF ALREADY ONLINE');
      return;
    }
    try {
      const st = await window.dash.wifiStatus();
      if (st?.connected && st.ssid) {
        frWifiCurrent.hidden = false;
        _frSetText(frWifiCurrentSsid, st.ssid);
        _frSetText(frWifiSub, 'YOU LOOK ONLINE · TAP CONTINUE OR PICK A DIFFERENT NETWORK');
      } else {
        frWifiCurrent.hidden = true;
        _frSetText(frWifiSub, 'NOT CONNECTED · CHOOSE A NETWORK BELOW');
        await frScanWifi();
      }
    } catch {
      _frSetText(frWifiSub, 'NETWORK CHECK FAILED · YOU CAN STILL CONTINUE');
    }
  }

  async function frScanWifi() {
    if (!window.dash?.wifiScan) return;
    _frSetText(frWifiSub, 'SCANNING…');
    frWifiListEl.hidden = false;
    frWifiListEl.replaceChildren();
    try {
      const r = await window.dash.wifiScan();
      const nets = r?.networks || [];
      if (!nets.length) {
        const li = document.createElement('li');
        li.className = 'fr-wifi-row';
        li.style.opacity = '0.5';
        li.innerHTML = `<span></span><span class="fr-wifi-ssid">No networks found</span><span></span>`;
        frWifiListEl.appendChild(li);
        _frSetText(frWifiSub, 'NO NETWORKS FOUND');
        return;
      }
      for (const n of nets) {
        const li = document.createElement('li');
        li.className = 'fr-wifi-row';
        li.dataset.ssid = n.ssid;
        const lit = Math.max(1, Math.min(4, Math.ceil((n.signal || 0) / 25)));
        const bars = [1,2,3,4].map((i) => `<span class="${i <= lit ? 'is-lit' : ''}"></span>`).join('');
        const locked = n.auth && !/open/i.test(n.auth);
        li.innerHTML = `
          <span class="fr-wifi-bars">${bars}</span>
          <span class="fr-wifi-ssid">${escapeText(n.ssid)}</span>
          <span class="fr-wifi-lock">${locked ? 'LOCK' : 'OPEN'}</span>
        `;
        li.dataset.locked = locked ? '1' : '0';
        frWifiListEl.appendChild(li);
      }
      _frSetText(frWifiSub, `${nets.length} NETWORK${nets.length === 1 ? '' : 'S'} FOUND`);
    } catch (err) {
      _frSetText(frWifiSub, 'SCAN FAILED · ' + (err?.message || ''));
    }
  }

  frWifiListEl?.addEventListener('click', (e) => {
    const row = e.target.closest?.('.fr-wifi-row');
    if (!row || !row.dataset.ssid) return;
    frWifiListEl.querySelectorAll('.fr-wifi-row').forEach(r => r.classList.toggle('is-selected', r === row));
    frPickedSsid = row.dataset.ssid;
    const locked = row.dataset.locked === '1';
    if (locked) {
      frWifiPassRow.hidden = false;
      setTimeout(() => frWifiPassInput?.focus(), 40);
    } else {
      frWifiPassRow.hidden = true;
      frConnectWifi(frPickedSsid, '');
    }
    playSfx?.('click');
  });

  async function frConnectWifi(ssid, password) {
    if (!window.dash?.wifiConnect) return;
    frWifiStatus.hidden = false;
    frWifiStatus.classList.remove('is-error', 'is-ok');
    frWifiStatus.textContent = `CONNECTING TO ${ssid}…`;
    frWifiConnectBtn?.setAttribute('disabled', 'true');
    try {
      const r = await window.dash.wifiConnect(ssid, password);
      if (r?.ok) {
        frWifiStatus.classList.add('is-ok');
        frWifiStatus.textContent = `CONNECTED TO ${r.ssid || ssid}`;
        frWifiPassRow.hidden = true;
        frWifiCurrent.hidden = false;
        _frSetText(frWifiCurrentSsid, r.ssid || ssid);
        playSfx?.('confirm');
      } else {
        frWifiStatus.classList.add('is-error');
        frWifiStatus.textContent = r?.error || 'Connection failed';
        playSfx?.('error');
      }
    } catch (err) {
      frWifiStatus.classList.add('is-error');
      frWifiStatus.textContent = err?.message || 'Connection failed';
    } finally {
      frWifiConnectBtn?.removeAttribute('disabled');
    }
  }

  frWifiRescanBtn?.addEventListener('click', () => {
    frWifiCurrent.hidden = true;
    frScanWifi();
  });
  frWifiSkipBtn?.addEventListener('click',  () => frShowStep('location'));
  frWifiNextBtn?.addEventListener('click',  () => frShowStep('location'));
  frWifiCancelBtn?.addEventListener('click', () => {
    frWifiPassRow.hidden = true;
    frWifiPassInput.value = '';
    frPickedSsid = null;
    frWifiListEl.querySelectorAll('.fr-wifi-row').forEach(r => r.classList.remove('is-selected'));
  });
  frWifiConnectBtn?.addEventListener('click', () => {
    const pw = frWifiPassInput.value || '';
    if (!frPickedSsid) return;
    frConnectWifi(frPickedSsid, pw);
  });
  frWifiPassInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') frWifiConnectBtn?.click();
  });

  // ── Location pane (Open-Meteo geocoding search) ────────────────────
  function frRenderLocResults(hits) {
    frLocResults.replaceChildren();
    if (!hits || !hits.length) {
      frLocNextBtn.disabled = true;
      return;
    }
    for (const hit of hits) {
      const li = document.createElement('li');
      li.className = 'fr-loc-row';
      const region = [hit.admin1, hit.country_code || hit.country].filter(Boolean).join(' · ');
      li.innerHTML = `
        <span class="fr-loc-name">${escapeText(hit.name || '—')}</span>
        <span class="fr-loc-region">${escapeText(region)}</span>
      `;
      li.addEventListener('click', () => {
        frLocResults.querySelectorAll('.fr-loc-row').forEach(r => r.classList.remove('is-selected'));
        li.classList.add('is-selected');
        frPickedLocation = {
          name: hit.name,
          latitude: hit.latitude,
          longitude: hit.longitude,
          timezone: hit.timezone,
          country: hit.country_code || hit.country,
          admin1: hit.admin1,
        };
        frLocNextBtn.disabled = false;
        playSfx?.('click');
      });
      frLocResults.appendChild(li);
    }
  }

  let _frLocDebounce = null;
  async function frSearchLocation(q) {
    if (frLocAbort) { try { frLocAbort.abort(); } catch {} }
    frLocAbort = new AbortController();
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;
      const res = await fetch(url, { signal: frLocAbort.signal });
      if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
      const data = await res.json();
      const hits = data.results || [];
      frRenderLocResults(hits);
      frLocStatus.hidden = hits.length !== 0;
      if (!hits.length) {
        frLocStatus.hidden = false;
        frLocStatus.classList.remove('is-error');
        frLocStatus.textContent = `NO MATCHES FOR "${q.toUpperCase()}"`;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      frLocStatus.hidden = false;
      frLocStatus.classList.add('is-error');
      frLocStatus.textContent = err?.message || 'Lookup failed';
    }
  }
  frLocInput?.addEventListener('input', () => {
    const q = frLocInput.value.trim();
    frPickedLocation = null;
    frLocNextBtn.disabled = true;
    frLocStatus.hidden = true;
    clearTimeout(_frLocDebounce);
    if (q.length < 2) {
      frLocResults.replaceChildren();
      return;
    }
    _frLocDebounce = setTimeout(() => frSearchLocation(q), 280);
  });
  frLocBackBtn?.addEventListener('click', () => frShowStep('wifi'));
  frLocNextBtn?.addEventListener('click', async () => {
    if (!frPickedLocation) return;
    try {
      // Save into the same keys the rest of the app already consumes:
      // weatherCity drives the WEATHER panel; altCity drives the primary
      // alt-clock in CHRONO. activeLocation gets a live update so the
      // weather panel refreshes without a reload.
      await window.dash?.setConfig?.({
        weatherCity: frPickedLocation,
        altCity: { name: frPickedLocation.name, timezone: frPickedLocation.timezone, country: frPickedLocation.country },
      });
      activeLocation = frPickedLocation;
      setLocalClockCity(frPickedLocation);
      try {
        if (weatherCityEl) weatherCityEl.value = frPickedLocation.name || '';
        loadWeather(frPickedLocation);
        if (weatherTimer) clearInterval(weatherTimer);
        weatherTimer = setInterval(() => loadWeather(frPickedLocation), 10 * 60 * 1000);
      } catch {}
      try { applyAltLocation({ name: frPickedLocation.name, timezone: frPickedLocation.timezone, country: frPickedLocation.country }); } catch {}
    } catch (err) {
      console.warn('[setup] location save failed:', err?.message || err);
    }
    frShowStep('name');
  });

  // ── Name pane ─────────────────────────────────────────────────────
  frNameBackBtn?.addEventListener('click', () => frShowStep('location'));
  frNameFinishBtn?.addEventListener('click', async () => {
    const name = (frNameInput.value || '').trim();
    try {
      await window.dash?.setConfig?.({ userName: name, setupCompleted: true });
    } catch {}
    applyUserName(name);
    frClose();
    playSfx?.('confirm');
  });
  frNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') frNameFinishBtn?.click();
  });
  // Live-persist the typed name so a forced restart mid-wizard doesn't
  // discard it. Debounced so we're not hammering setConfig on every
  // keystroke. Note: setupCompleted is NOT set here — that only flips
  // when the user actually clicks FINISH.
  let _frNameSaveTimer = 0;
  frNameInput?.addEventListener('input', () => {
    clearTimeout(_frNameSaveTimer);
    _frNameSaveTimer = setTimeout(async () => {
      const v = (frNameInput.value || '').trim();
      try { await window.dash?.setConfig?.({ userName: v }); } catch {}
    }, 250);
  });

  // Close button — skips setup but still marks it completed so it doesn't
  // re-open every boot. The user can re-trigger via the topbar Setup btn.
  frCloseBtn?.addEventListener('click', async () => {
    try { await window.dash?.setConfig?.({ setupCompleted: true }); } catch {}
    frClose();
  });

  // Expose open() so the topbar Setup button (wired further below) can
  // re-launch the wizard at any time.
  window._frOpenSetup = frOpen;
}

// ── Profile picture ─────────────────────────────────────────────
// Click the .profile-pic box (clock panel) to open a picker scoped to
// the dashboard's gallery folder. The chosen image is persisted as
// cfg.userPicture (absolute path) and shown both in the clock-panel
// avatar slot and as the preview swatch in the picker.
const profilePicEl      = document.getElementById('profile-pic');
const profilePicImgEl   = document.getElementById('profile-pic-img');
const profilePicVideoEl = document.getElementById('profile-pic-video');

// Mirror the active webcam stream into the clock-panel profile picture.
// Called from start/stopWebcam in the webcam-popout block below. Passing
// a MediaStream attaches it + hides the static img/placeholder via the
// `.is-live` class; passing null detaches and reveals whatever the user
// had picked (or the smiley placeholder if nothing was set).
function setProfilePicLive(stream) {
  if (!profilePicVideoEl || !profilePicEl) return;
  if (stream) {
    profilePicVideoEl.srcObject = stream;
    profilePicVideoEl.hidden = false;
    profilePicEl.classList.add('is-live');
  } else {
    profilePicVideoEl.srcObject = null;
    profilePicVideoEl.hidden = true;
    profilePicEl.classList.remove('is-live');
  }
}
const picPickerOverlay = document.getElementById('picture-picker-overlay');
const picPickerGrid    = document.getElementById('picture-picker-grid');
const picPickerEmpty   = document.getElementById('picture-picker-empty');
const picPickerClose   = document.getElementById('picture-picker-close');
const picPickerClear   = document.getElementById('picture-picker-clear');

// Single-frame image formats only. .gif was removed deliberately —
// animated GIFs read as "video" once they're set as a profile picture
// and the request was for still-image sources only. The extensions
// here are also matched against any file the recursive listing turns
// up, so videos / recordings can never sneak through this regex.
const _IMG_EXT = /\.(png|jpe?g|webp|bmp|tiff?|avif|svg)$/i;

// Subfolders under gallery/ that hold machine-generated session data
// (screen captures, screen recordings, processed videos, downloads,
// soft-deleted files). The picture-picker skips recursing into these
// so still-image picks come only from the user's curated gallery
// root + the AI-generated subfolder. To allow a folder back in, just
// remove its name from this Set.
const _GALLERY_SKIP_DIRS = new Set([
  'recordings',   // screen + webcam clips (.webm / .mp4)
  'screencap',    // per-session PNG frame grabs from screen capture
  'videos',       // process-snaps output
  'downloads',    // yt-dlp output (videos, not curated images)
  'trash',        // soft-deleted files awaiting Recycle Bin
  '.trash',
]);

function applyProfilePicture(absPath) {
  if (!profilePicImgEl) return;
  const path = String(absPath || '').trim();
  if (!path) {
    profilePicImgEl.removeAttribute('src');
    profilePicImgEl.hidden = true;
    return;
  }
  // file:// URL with forward slashes — Electron's renderer accepts both
  // forms but normalizing here keeps the markup tidy.
  const url = path.startsWith('file://')
    ? path
    : 'file:///' + path.replace(/\\/g, '/');
  profilePicImgEl.src = url;
  profilePicImgEl.hidden = false;
}

async function _picPickerOpen() {
  if (!picPickerOverlay || !window.dash?.galleryList) return;
  picPickerOverlay.hidden = false;
  picPickerGrid.replaceChildren();
  picPickerEmpty.hidden = true;

  // Recurse through the gallery and collect still-image files only.
  // Subfolders listed in _GALLERY_SKIP_DIRS are pruned at the descent
  // step so the picker never sees PNG frame-grabs from screen-cap
  // sessions, recordings, or downloads — only curated images from
  // the gallery root + AI-generated images.
  async function listImages(subdir = '') {
    const res = await window.dash.galleryList(subdir);
    const out = [];
    for (const e of (res?.entries || [])) {
      if (e.isDir) {
        if (_GALLERY_SKIP_DIRS.has(e.name.toLowerCase())) continue;
        const sub = await listImages(subdir ? `${subdir}/${e.name}` : e.name);
        out.push(...sub);
      } else if (_IMG_EXT.test(e.name)) {
        out.push(e);
      }
    }
    return out;
  }
  let images = [];
  try { images = await listImages(); } catch {}
  if (!images.length) {
    picPickerEmpty.hidden = false;
    return;
  }
  // Most-recent first (galleryList sorts folders first then by mtime
  // desc; we already flattened, so it's already in that order).
  const cfg = (await window.dash?.getConfig?.()) || {};
  const active = cfg.userPicture || '';
  for (const img of images) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'picture-picker-tile' + (img.path === active ? ' is-active' : '');
    const imgEl = document.createElement('img');
    imgEl.src = 'file:///' + img.path.replace(/\\/g, '/');
    imgEl.alt = '';
    tile.appendChild(imgEl);
    const name = document.createElement('span');
    name.className = 'picture-picker-tile-name';
    name.textContent = img.name;
    tile.appendChild(name);
    tile.addEventListener('click', async () => {
      applyProfilePicture(img.path);
      try { await window.dash?.setConfig?.({ userPicture: img.path }); } catch {}
      _picPickerClose();
      playSfx?.('confirm');
    });
    picPickerGrid.appendChild(tile);
  }
}

function _picPickerClose() {
  if (picPickerOverlay) picPickerOverlay.hidden = true;
}

// ── Profile-picture SOURCE chooser ──────────────────────────────
// Clicking the profile-pic body opens this small modal first so the
// user can choose between picking from the gallery, toggling the
// webcam, or cycling to the next camera device. GALLERY routes into
// the existing _picPickerOpen() flow; CAMERA toggles the webcam on/
// off; CYCLE (only shown when the camera is live AND 2+ devices are
// detected) calls cycleCamera(). The corner chips on the avatar
// bypass this modal via stopPropagation and act directly.
const profileSourceOverlay     = document.getElementById('profile-source-overlay');
const profileSourceCloseBtn    = document.getElementById('profile-source-close');
const profileSourceGalleryBtn  = document.getElementById('profile-source-gallery');
const profileSourceCameraBtn   = document.getElementById('profile-source-camera');
const profileSourceCameraLabel = document.getElementById('profile-source-camera-label');
const profileSourceCameraDesc  = document.getElementById('profile-source-camera-desc');
const profileSourceCycleBtn    = document.getElementById('profile-source-cycle');
const profileSourceCycleDesc   = document.getElementById('profile-source-cycle-desc');

// Refresh the modal's CAMERA-button label and the CYCLE-button
// visibility every time it opens, since either could have changed
// since the previous open (camera toggled via the corner chip, new
// USB camera plugged in, etc.).
async function _profileSourceRefresh() {
  const live = !!_webcamStream;
  if (profileSourceCameraLabel) profileSourceCameraLabel.textContent = live ? 'CAMERA OFF' : 'CAMERA';
  if (profileSourceCameraDesc)  profileSourceCameraDesc.textContent  = live ? 'Stop the live webcam' : 'Use live webcam';
  // Cycle button: show only when the camera is live and we have at
  // least two devices available. refreshCameraList populates _cameras
  // and is cheap (it just enumerates the OS device list).
  let showCycle = false;
  if (live && typeof refreshCameraList === 'function') {
    try { await refreshCameraList(); } catch {}
    showCycle = _cameras.length >= 2;
    if (profileSourceCycleDesc && _cameras.length) {
      profileSourceCycleDesc.textContent = `${_cameras.length} devices · next`;
    }
  }
  if (profileSourceCycleBtn) profileSourceCycleBtn.hidden = !showCycle;
}

function _profileSourceOpen()  {
  if (!profileSourceOverlay) return;
  profileSourceOverlay.hidden = false;
  _profileSourceRefresh();
}
function _profileSourceClose() { if (profileSourceOverlay) profileSourceOverlay.hidden = true; }

// Click anywhere on the profile-pic body toggles the camera off when
// it's live (instant kill-switch, no modal), and opens the source-
// chooser modal otherwise. The two state branches mean the user never
// needs to find a corner chip to stop the webcam — a single click on
// the avatar always does the contextually-right thing.
profilePicEl?.addEventListener('click', () => {
  if (_webcamStream) {
    if (typeof stopWebcam === 'function') stopWebcam();
  } else {
    _profileSourceOpen();
  }
  playSfx?.('click');
});
profileSourceCloseBtn?.addEventListener('click', () => {
  _profileSourceClose();
  playSfx?.('click');
});
// Backdrop click closes the source modal.
profileSourceOverlay?.addEventListener('click', (e) => {
  if (e.target === profileSourceOverlay) _profileSourceClose();
});
profileSourceGalleryBtn?.addEventListener('click', () => {
  _profileSourceClose();
  _picPickerOpen();
  playSfx?.('confirm');
});
profileSourceCameraBtn?.addEventListener('click', () => {
  _profileSourceClose();
  // If the camera is already live, the choice button toggles it OFF;
  // otherwise it starts the webcam. Same toggle semantics as the
  // top-right chip on the avatar, just behind a labelled button.
  if (_webcamStream) {
    if (typeof stopWebcam === 'function') stopWebcam();
  } else {
    if (typeof startWebcam === 'function') startWebcam().catch?.(() => {});
  }
  playSfx?.('confirm');
});
profileSourceCycleBtn?.addEventListener('click', () => {
  // cycleCamera handles the OS-level device enumeration + stream swap
  // with a brief VHS-style transition. Keep the modal open so the user
  // can cycle again immediately if there are 3+ devices; the label
  // refresh below shows which device count we're on.
  if (typeof cycleCamera === 'function') {
    cycleCamera().then(() => _profileSourceRefresh()).catch?.(() => {});
  }
  playSfx?.('confirm');
});

// ── Record (profile-pic chip) ──────────────────────────────────────
// REC sits on the LEFT side of the avatar, visible only when the webcam
// is live. Starts a MediaRecorder on the webcam stream; when stopped,
// the captured bytes go through processSnapsSave (which writes to
// gallery/recordings/ with a date-stamped name). Recording state is
// mirrored onto the .profile-pic element via .is-recording so the frame
// border turns red and the REC chip pulses.
const profilePicRecordBtn = document.getElementById('profile-pic-record');
let _profileRecorder   = null;
let _profileRecChunks  = [];
let _profileRecMime    = '';

// Brief visual feedback on the chip: green flash on success, red
// flash on error, both auto-clear after the timeout.
function _flashChip(el, kind) {
  if (!el) return;
  const cls = kind === 'error' ? 'is-error' : 'is-flash';
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), kind === 'error' ? 1400 : 500);
}

async function _toggleProfileRecord() {
  if (!_webcamStream) {
    console.warn('[profile-pic record] no webcam stream');
    _flashChip(profilePicRecordBtn, 'error');
    return;
  }
  // Already recording? Stop and let the onstop handler save + cleanup.
  if (_profileRecorder) {
    try { _profileRecorder.stop(); } catch {}
    return;
  }
  if (!window.dash?.processSnapsSave) {
    console.warn('[profile-pic record] processSnapsSave IPC unavailable');
    _flashChip(profilePicRecordBtn, 'error');
    return;
  }
  // Start. Pick the best supported codec from a small ranked list.
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  const mime = candidates.find((m) => {
    try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
  });
  if (!mime) {
    console.warn('[profile-pic record] no supported codec');
    _flashChip(profilePicRecordBtn, 'error');
    return;
  }
  try {
    _profileRecorder = new MediaRecorder(_webcamStream, { mimeType: mime });
  } catch (err) {
    console.warn('[profile-pic record] MediaRecorder init failed:', err);
    _profileRecorder = null;
    _flashChip(profilePicRecordBtn, 'error');
    return;
  }
  _profileRecMime   = mime;
  _profileRecChunks = [];
  _profileRecorder.ondataavailable = (ev) => { if (ev.data?.size) _profileRecChunks.push(ev.data); };
  _profileRecorder.onstop = async () => {
    try {
      const blob = new Blob(_profileRecChunks, { type: _profileRecMime });
      if (!blob.size) {
        console.warn('[profile-pic record] empty blob — nothing to save');
        _flashChip(profilePicRecordBtn, 'error');
        return;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ext = _profileRecMime.includes('mp4') ? '.mp4' : '.webm';
      const result = await window.dash.processSnapsSave(bytes, ext);
      if (result?.ok) {
        console.log('[profile-pic record] saved to', result.path, `(${(result.size/1024/1024).toFixed(2)} MB)`);
        _flashChip(profilePicRecordBtn, 'ok');
      } else {
        console.warn('[profile-pic record] save failed:', result?.error || 'unknown');
        _flashChip(profilePicRecordBtn, 'error');
      }
    } catch (err) {
      console.warn('[profile-pic record] save failed:', err);
      _flashChip(profilePicRecordBtn, 'error');
    } finally {
      profilePicEl?.classList.remove('is-recording');
      _profileRecorder   = null;
      _profileRecChunks  = [];
      _profileRecMime    = '';
    }
  };
  // 500ms timeslice — chunks accrue in memory; that's fine for clips
  // up to a few minutes. Longer recordings should swap to the
  // screenrec API (renderer ships chunks to main on each timeslice).
  _profileRecorder.start(500);
  profilePicEl?.classList.add('is-recording');
}

profilePicRecordBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  _toggleProfileRecord();
  playSfx?.('click');
});

// (Camera ON/OFF toggle chip removed — the avatar body click handler
// above now toggles the camera off directly when it's live. The
// source-chooser modal still offers an explicit CAMERA OFF button as
// an alternative path.)

// Cycle-cameras chip overlaid on the profile pic. Visible only when
// the parent has .is-live (webcam stream is attached). Click swaps
// to the next camera device via the existing cycleCamera() helper.
// stopPropagation prevents the parent's picker handler from firing.
const profilePicCycleBtn = document.getElementById('profile-pic-cycle');
profilePicCycleBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (typeof cycleCamera === 'function') {
    cycleCamera().catch?.(() => {});
  }
  playSfx?.('click');
});
picPickerClose?.addEventListener('click', _picPickerClose);
picPickerOverlay?.addEventListener('click', (e) => {
  // Click on the dim backdrop (not the card) to close.
  if (e.target === picPickerOverlay) _picPickerClose();
});
picPickerClear?.addEventListener('click', async () => {
  applyProfilePicture('');
  try { await window.dash?.setConfig?.({ userPicture: '' }); } catch {}
  _picPickerClose();
  playSfx?.('click');
});

// Boot — restore saved picture.
(async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  if (cfg.userPicture) applyProfilePicture(cfg.userPicture);
})();

function applyUserName(name) {
  const chip = document.getElementById('user-name-chip');
  if (!chip) return;
  const trimmed = String(name || '').trim();
  if (!trimmed) { chip.hidden = true; chip.textContent = ''; return; }
  chip.hidden = false;
  chip.textContent = trimmed.toUpperCase();
}

// Topbar Setup button — re-opens the wizard on demand. Available even
// after first-run so the user can change WiFi / location / name later.
document.querySelector('#setup-btn')?.addEventListener('click', () => {
  if (window._frOpenSetup) window._frOpenSetup();
});

// Boot-time check — if cfg.setupCompleted is false (or undefined), open
// the wizard automatically. Always apply the saved user name to the
// topbar chip, completed or not.
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.userName) applyUserName(cfg.userName);
  if (!cfg.setupCompleted && window._frOpenSetup) {
    // Wait for the boot sequence to fully complete before raising the
    // wizard. The boot animation drops `body.is-booting` after its CRT
    // flicker + brightness ramp finishes (~3-4 s), and the wizard
    // popping up mid-flicker was visually jarring and stole focus
    // before the dashboard had even stopped fading in. A short
    // settle delay after that gives the panels a beat to land before
    // the modal slides in.
    const _openWhenReady = () => {
      if (document.body.classList.contains('is-booting')) {
        setTimeout(_openWhenReady, 200);
        return;
      }
      setTimeout(() => window._frOpenSetup(), 350);
    };
    _openWhenReady();
  }
})();

// SFX toggle button + cfg restore removed. _sfxEnabled is now a const
// false (see top of file); every playSfx / playBootSfx short-circuits.

// Version chip — pulled from package.json via the main process so the topbar
// label stays in sync with the manifest without a renderer rebuild.
(async () => {
  const el = document.querySelector('#version-chip');
  if (!el) return;
  try {
    const v = await window.dash?.appVersion?.();
    if (v) el.textContent = `v${v}`;
  } catch {}
})();

// ── Themes / display toggles ────────────────────────────────────────────────
// Default palette plus the Cyberpunk · Pastel · Muted · Retro · E-Ink
// sections. Pretty labels for the topbar chip — the slug (data-theme
// value) is what gets persisted. Retro and E-Ink are structural themes
// (a `body[data-theme^="..."]` block in styles.css adds/strips chrome),
// the rest are pure palette swaps.
const THEME_LABELS = {
  '':             'DEFAULT',
  'cyber-neon':     'CYBER · NEON',
  'cyber-dark':     'CYBER · DARK',
  'cyber-runner':   'CYBER · RUNNER',
  'cyber-2077':     'CYBER · 2077',
  'cyber-akira':    'CYBER · AKIRA',
  'pastel-sky':   'PASTEL · SKY',
  'pastel-spring':'PASTEL · SPRING',
  'pastel-lilac': 'PASTEL · LILAC',
  'pastel-sorbet':'PASTEL · SORBET',
  'earth-clay':    'MUTED · CLAY',
  'earth-moss':    'MUTED · MOSS',
  'earth-sand':    'MUTED · SAND',
  'earth-stone':   'MUTED · STONE',
  'earth-paper':   'MUTED · PAPER',
  'earth-sepia':   'MUTED · SEPIA',
  'earth-charcoal':'MUTED · CHARCOAL',
  'earth-amber':   'MUTED · AMBER',
  'retro-green':   'RETRO · GREEN',
  'retro-white':   'RETRO · WHITE',
  'retro-mint':    'RETRO · MINT',
  'retro-violet':  'RETRO · VIOLET',
  'hud-tactical':   'HUD · TACTICAL',
  'hud-amber':      'HUD · AMBER',
  'hud-cyan':       'HUD · CYAN',
  'hud-emerald':    'HUD · EMERALD',
  'hud-violet':     'HUD · VIOLET',
  'hud-rose':       'HUD · ROSE',
  'hud-azure':      'HUD · AZURE',
  'hud-gold':       'HUD · GOLD',
};
const THEME_SLUGS = new Set(Object.keys(THEME_LABELS).filter(Boolean));
// Theme categories — two families: CYBER (the catch-all, default
// cyan + every non-prefixed palette) and HUD (hud-*, sci-fi cockpit
// overlay). The topbar exposes one button per category plus a cycle
// button that steps colours within whichever category is active.
// (MATTE family was retired; the matte-* palettes + structural CSS
// were deleted in favour of the expanded HUD variant set.)
const CYBER_THEMES = Object.keys(THEME_LABELS).filter((k) => !k.startsWith('hud'));
const HUD_THEMES   = Object.keys(THEME_LABELS).filter((k) => k.startsWith('hud'));
const themeCategory = (slug) => {
  const s = slug || '';
  if (s.startsWith('hud'))   return 'hud';
  return 'cyber';
};

const themeNameEl = document.querySelector('#theme-name');
function applyTheme(name) {
  if (!name) document.documentElement.removeAttribute('data-theme');
  else       document.documentElement.setAttribute('data-theme', name);
  if (themeNameEl) themeNameEl.textContent = THEME_LABELS[name || ''] || 'DEFAULT';
  _themeVersion++;
}

// Persist the user-chosen theme. The auto-engaged "alert" override was
// removed — the theme the user picks is the theme that's shown.
function setUserTheme(name) {
  _userTheme = name ?? null;
  applyTheme(_userTheme);
}

function applyInvert(on) {
  document.body.classList.toggle('theme-invert', !!on);
  // Invert is UI-only — BrowserView embeds (Discord, browser tabs,
  // YouTube popout, Stream services) are left alone. Sites carry
  // their own dark/light theme; flipping our chrome shouldn't
  // re-tint their content. If you want embed-wide dark mode, use
  // the browser-dark-mode toggle, which is independent.
}

// Theme picker — two category buttons (CYBER · MATTE) plus a colour cycle
// button. Clicking a category applies the variant last used in it; the
// cycle button steps through that category's colours. The active slug
// persists as cfg.theme; cfg.themeLastCyber / cfg.themeLastMatte remember
// the per-category variant so switching back returns where you left off.
const themeCyberBtn = document.getElementById('theme-cat-cyber');
const themeHudBtn   = document.getElementById('theme-cat-hud');

function _themeUpdateCatButtons(slug) {
  const cat = themeCategory(slug);
  themeCyberBtn?.classList.toggle('is-active', cat === 'cyber');
  themeHudBtn?.classList.toggle('is-active',   cat === 'hud');
}

// Apply a theme slug, persist it, and remember it as the last-used
// variant of its category. '' / null / unknown = the default palette.
async function setTheme(slug) {
  const norm    = THEME_SLUGS.has(slug) ? slug : '';
  const useSlug = norm || null;
  setUserTheme(useSlug);
  _themeUpdateCatButtons(norm);
  if (window.dash?.setConfig) {
    const patch = { theme: useSlug };
    const lastKey = {
      cyber: 'themeLastCyber',
      hud:   'themeLastHud',
    }[themeCategory(norm)];
    if (lastKey) patch[lastKey] = useSlug;
    try { await window.dash.setConfig(patch); } catch {}
  }
}

// Map category slug → theme list + last-used cfg key. Keeps the
// category dispatch in one place so adding another family later is
// a single-line edit.
function _themeListFor(cat) {
  if (cat === 'hud') return HUD_THEMES;
  return CYBER_THEMES;
}
function _themeLastKeyFor(cat) {
  if (cat === 'hud') return 'themeLastHud';
  return 'themeLastCyber';
}

// Category button — jump to the variant last used in that category
// (its first colour if none has been used yet).
async function selectThemeCategory(cat) {
  const cfg  = (await window.dash?.getConfig?.()) || {};
  const list = _themeListFor(cat);
  let slug = cfg[_themeLastKeyFor(cat)];
  if (slug == null || !list.includes(slug)) slug = list[0];
  await setTheme(slug);
  playSfx?.('confirm');
}
themeCyberBtn?.addEventListener('click', () => selectThemeCategory('cyber'));
themeHudBtn  ?.addEventListener('click', () => selectThemeCategory('hud'));

// Cycle button — next colour within the active category, wraps at the end.
async function cycleThemeColor(step = 1) {
  const cfg  = (await window.dash?.getConfig?.()) || {};
  const cur  = cfg.theme && THEME_SLUGS.has(cfg.theme) ? cfg.theme : '';
  const cat  = themeCategory(cur);
  const list = _themeListFor(cat);
  let idx = list.indexOf(cur);
  if (idx < 0) idx = 0;
  const len = list.length;
  await setTheme(list[((idx + step) % len + len) % len]);
  playSfx?.('click');
}
document.querySelector('#theme-cycle-btn')?.addEventListener('click', () => cycleThemeColor(1));

// Background pattern cycle — one button steps through the 8 variants.
// Default is 'grid' (no data attribute needed but kept explicit so the
// cycle index stays stable). Persisted under cfg.bgPattern.
const BG_PATTERNS = [
  'grid', 'dots', 'diagonal', 'diamond',
  'triangles', 'triangles-fine', 'triangles-bold', 'iso-grid',
  'hexagons', 'herringbone', 'circuit',
  'spiderweb', 'spiderweb-tight', 'radial',
];
function setBgPattern(name) {
  const slug = BG_PATTERNS.includes(name) ? name : 'grid';
  document.body.setAttribute('data-bg-pattern', slug);
  return slug;
}
async function cycleBgPattern(step = 1) {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const cur = cfg.bgPattern && BG_PATTERNS.includes(cfg.bgPattern) ? cfg.bgPattern : 'grid';
  const idx = BG_PATTERNS.indexOf(cur);
  const len = BG_PATTERNS.length;
  const next = BG_PATTERNS[((idx + step) % len + len) % len];
  setBgPattern(next);
  // Update the topbar button's title so the user can see what's active.
  const btn = document.getElementById('bg-pattern-btn');
  if (btn) btn.title = `Background · ${next.toUpperCase()}`;
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ bgPattern: next }); } catch {}
  }
  playSfx?.('click');
}
document.getElementById('bg-pattern-btn')?.addEventListener('click', () => cycleBgPattern(1));

// Topbar Hz control — steps the global visualizer refresh rate ±5 Hz.
// Clamped to 10–200 Hz inside stepHz(). Persisted via cfg.audioFrameMs.
document.querySelector('#hz-down')?.addEventListener('click', () => { stepHz(-5); playSfx?.('click'); });
document.querySelector('#hz-up')?.addEventListener('click',   () => { stepHz(+5); playSfx?.('click'); });

// ── UI font cycle ───────────────────────────────────────────────
// Each entry maps to a body class (or null = default Rajdhani+Tech-Mono)
// that swaps --font-display + --font-tech across the entire dashboard.
const UI_FONTS = [
  // Originals (Rajdhani / mixed) — kept first for compatibility with
  // saved cfg.uiFont values from older builds.
  { name: 'DEFAULT',   cls: null },
  { name: 'TECH',      cls: 'font-tech' },
  { name: 'CLEAN',     cls: 'font-clean' },
  { name: 'CLASSIC',   cls: 'font-classic' },
  { name: 'MONO',      cls: 'font-mono' },
  { name: 'MIXED',     cls: 'font-mixed' },
  { name: 'WRITING',   cls: 'font-writing' },
  // Bundled web fonts
  { name: 'INTER',     cls: 'font-inter' },
  { name: 'JETBRAINS', cls: 'font-jetbrains' },
  { name: 'PLEX SANS', cls: 'font-plex-sans' },
  { name: 'PLEX MONO', cls: 'font-plex-mono' },
  { name: 'SOURCE',    cls: 'font-source' },
  { name: 'LORA',      cls: 'font-lora' },
  { name: 'SPACE',     cls: 'font-space' },
  // System sans-serifs
  { name: 'HELVETICA', cls: 'font-helvetica' },
  { name: 'ARIAL',     cls: 'font-arial' },
  { name: 'SEGOE',     cls: 'font-segoe' },
  { name: 'SYSTEM',    cls: 'font-system' },
  { name: 'VERDANA',   cls: 'font-verdana' },
  { name: 'TAHOMA',    cls: 'font-tahoma' },
  { name: 'TREBUCHET', cls: 'font-trebuchet' },
  { name: 'IMPACT',    cls: 'font-impact' },
  { name: 'COMIC',     cls: 'font-comic' },
  // System serifs
  { name: 'GEORGIA',   cls: 'font-georgia' },
  { name: 'TIMES',     cls: 'font-times' },
  { name: 'CAMBRIA',   cls: 'font-cambria' },
  { name: 'PALATINO',  cls: 'font-palatino' },
  { name: 'GARAMOND',  cls: 'font-garamond' },
  // System monos
  { name: 'CONSOLE',   cls: 'font-console' },
  { name: 'COURIER',   cls: 'font-courier' },
];
const fontNameEl = document.querySelector('#font-name');
function applyUiFont(name) {
  const entry = UI_FONTS.find((f) => f.name === name) || UI_FONTS[0];
  for (const f of UI_FONTS) if (f.cls) document.body.classList.remove(f.cls);
  if (entry.cls) document.body.classList.add(entry.cls);
  if (fontNameEl) fontNameEl.textContent = entry.name;
}
async function advanceUiFont(step = 1) {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const cur = cfg.uiFont || 'DEFAULT';
  const idx = Math.max(0, UI_FONTS.findIndex((f) => f.name === cur));
  const next = UI_FONTS[((idx + step) % UI_FONTS.length + UI_FONTS.length) % UI_FONTS.length];
  applyUiFont(next.name);
  if (window.dash?.setConfig) await window.dash.setConfig({ uiFont: next.name });
}
document.querySelector('#font-btn')?.addEventListener('click', () => advanceUiFont(1));

// ── Topbar drag-to-reorder ──────────────────────────────────────
// Each direct child of .topbar-controls (theme button, font button,
// dim, refresh, zen, etc.) becomes individually draggable. Drop
// position is computed against sibling midpoints so the dragged
// element slots in cleanly. Order is saved under config.topbarOrder
// (array of element IDs) and re-applied on load.
const topbarEl = document.querySelector('.topbar-controls');
if (topbarEl) {
  // All children with an id — used for saved-order persistence and
  // restore. topbarDraggables() filters out wrappers like #theme-picker
  // that host their own click handlers; making those draggable would
  // swallow the button's clicks.
  function topbarItems()      { return Array.from(topbarEl.children).filter((c) => c.id); }
  function topbarDraggables() { return topbarItems().filter((c) => c.dataset.noDrag !== 'true'); }
  for (const el of topbarDraggables()) {
    el.draggable = true;
  }
  let _dragged = null;
  topbarEl.addEventListener('dragstart', (e) => {
    if (_uiLocked) { e.preventDefault(); return; }
    const t = e.target.closest && e.target.closest('.topbar-controls > *');
    if (!t || t.parentElement !== topbarEl) return;
    _dragged = t;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Centre the drag ghost on the cursor. Without this the browser
      // pins the ghost to the cursor at whatever offset you grabbed —
      // grab the icon's left edge and the ghost trails to the right;
      // grab the right edge and it trails to the left. Centring keeps
      // the ghost directly under the pointer regardless of grab point.
      const r = t.getBoundingClientRect();
      try { e.dataTransfer.setDragImage(t, r.width / 2, r.height / 2); } catch {}
    }
    // Apply the dim class on the *next* frame so the drag-image snapshot
    // (captured during this dragstart turn) uses the original opacity
    // instead of the half-faded look meant for the real element.
    requestAnimationFrame(() => t.classList.add('is-topbar-dragging'));
  });
  topbarEl.addEventListener('dragend', async () => {
    if (_dragged) _dragged.classList.remove('is-topbar-dragging');
    _dragged = null;
    if (window.dash?.setConfig) {
      try { await window.dash.setConfig({ topbarOrder: topbarItems().map((el) => el.id) }); } catch {}
    }
  });
  topbarEl.addEventListener('dragover', (e) => {
    if (!_dragged) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // Find the first sibling whose midpoint is past the cursor; insert
    // before it. If none, append at end.
    const x = e.clientX;
    const sibs = Array.from(topbarEl.children).filter((c) => c !== _dragged && c.id);
    let after = null;
    for (const el of sibs) {
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) { after = el; break; }
    }
    if (after === null) topbarEl.appendChild(_dragged);
    else if (_dragged.nextElementSibling !== after) topbarEl.insertBefore(_dragged, after);
  });
  // Restore saved order on load.
  (async () => {
    const cfg = (await window.dash?.getConfig?.()) || {};
    const ids = cfg.topbarOrder;
    if (!Array.isArray(ids) || !ids.length) return;
    // If the saved order was written before a button was removed (e.g.
    // the old #restart-btn) — or in any other shape that no longer
    // matches the current HTML — discard it and use the new HTML
    // default. Without this, users who had previously dragged the
    // topbar around would never see new groupings on update.
    const stale = ['restart-btn', 'refresh-btn', 'side-arrange-btn', 'eco-mode-btn', 'airplane-btn', 'offline-btn', 'calm-btn',
      // Pre-collapsible-groups top-level buttons. These now live inside
      // #theme-group / #ui-group, so any saved order containing them
      // is from before this refactor and must be reset.
      'theme-picker', 'bg-pattern-btn',
      'recall-panels-btn', 'store-config-btn', 'align-edges-btn',
      'lock-ui-btn', 'diag-btn',
      'font-name', 'font-btn',
      // Power menu removed entirely — its topbar entry must be purged
      // from any saved order so the rest of the bar doesn't shift.
      'power-btn'];
    // Also reset if the saved order pre-dates the introduction of any
    // of these wrappers — without them slotted in, restore would drop
    // them at the end of the bar instead of where the HTML places them.
    const requiredNew = ['theme-group', 'text-group', 'ui-group', 'setup-btn', 'user-name-chip', 'hz-control', 'app-refresh-btn', 'app-restart-btn', 'focus-mode-btn', 'invert-btn', 'display-strip'];
    const missing = requiredNew.some((id) => !ids.includes(id) && document.getElementById(id));
    if (stale.some((id) => ids.includes(id)) || missing) {
      if (window.dash?.setConfig) {
        try { await window.dash.setConfig({ topbarOrder: null }); } catch {}
      }
      return;
    }
    const byId = Object.fromEntries(topbarItems().map((el) => [el.id, el]));
    const seen = new Set();
    const frag = document.createDocumentFragment();
    for (const id of ids) {
      if (byId[id]) { frag.appendChild(byId[id]); seen.add(id); }
    }
    // Append any new buttons (added in a future build) at the end so they
    // don't disappear when the saved order pre-dates them.
    for (const el of topbarItems()) {
      if (!seen.has(el.id)) frag.appendChild(el);
    }
    topbarEl.appendChild(frag);
  })();
}

document.querySelector('#invert-btn')?.addEventListener('click', async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const next = !cfg.invert;
  applyInvert(next);
  if (window.dash?.setConfig) await window.dash.setConfig({ invert: next });
});

// ── Topbar drag-to-shift handles ────────────────────────────────
// ── System mute → body class ──────────────────────────────────────
// The floating media controller (SMTC widget) was removed because it
// was perpetually broken. We still want the rest of the app to know
// when the OS master volume is muted — audio strips, REC ROOM mixer
// mute, EDIT room preview — so they can light their mute chips red
// in unison via the body.is-system-muted CSS rules. This slim watcher
// keeps that wiring alive without any UI of its own.
(() => {
  function applyVolumeInfo(jsonStr) {
    let d = null;
    try { d = JSON.parse(jsonStr || ''); } catch { return; }
    if (!d || d.ok === false) return;
    if (typeof d.muted === 'boolean') {
      document.body.classList.toggle('is-system-muted', d.muted);
    }
  }
  (async () => {
    try {
      const last = await window.dash?.volumeInfo?.();
      if (last) applyVolumeInfo(last);
    } catch {}
  })();
  window.dash?.onVolumeInfoChanged?.(applyVolumeInfo);
})();

// Topbar is locked, buttons stay centred. Any previously-persisted
// horizontal shift is cleared on boot, the .topbar-grab handles are
// hidden via CSS, and the --topbar-shift var is forced to 0 so the
// flex auto-margins center the row regardless of whatever state cfg
// might still carry from a prior session.
(() => {
  const tbEl = document.querySelector('.topbar-controls');
  if (!tbEl) return;
  tbEl.style.setProperty('--topbar-shift', '0px');
  for (const h of tbEl.querySelectorAll('.topbar-grab')) {
    h.style.pointerEvents = 'none';
    h.style.cursor = 'default';
    h.setAttribute('aria-hidden', 'true');
  }
  // Clear any stale persisted offset so a future unlock doesn't restore
  // an unexpected shift.
  (async () => {
    try {
      const cfg = (await window.dash?.getConfig?.()) || {};
      if (Number.isFinite(cfg.topbarShiftX) && cfg.topbarShiftX !== 0) {
        await window.dash?.setConfig?.({ topbarShiftX: 0 });
      }
    } catch {}
  })();
})();

// ── Collapsible topbar groups (THEME / TEXT / UI) ───────────────
// Each .topbar-group contains a toggle pill (label + caret) and a
// body holding the sub-buttons. Clicking the toggle flips is-open
// on the group, which the CSS uses to slide the body in/out.
for (const grp of document.querySelectorAll('.topbar-group')) {
  const toggle = grp.querySelector('.topbar-group-toggle');
  if (!toggle) continue;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = grp.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

// ── Display strip — one icon per attached monitor ────────────────
// Each icon is a small rectangle whose aspect ratio reflects the
// monitor's orientation (landscape = wide, portrait = tall). The
// active display (the one the dashboard's main window is currently
// on) gets .is-active. Click any other to move the dashboard there.
// Re-renders on display-added / -removed / -metrics-changed events.
const displayStripEl = document.querySelector('#display-strip');
if (displayStripEl && window.dash?.displaysList) {
  function _renderDisplayStrip(displays) {
    if (!Array.isArray(displays) || !displays.length) {
      displayStripEl.innerHTML = '';
      return;
    }
    // Detect which display the dashboard currently lives on by matching
    // the window's screen position against each display's bounds.
    const winX = window.screenX | 0;
    const winY = window.screenY | 0;
    const cx = winX + (window.innerWidth  | 0) / 2;
    const cy = winY + (window.innerHeight | 0) / 2;
    const activeId = (displays.find((d) =>
      cx >= d.bounds.x && cx <= d.bounds.x + d.bounds.width &&
      cy >= d.bounds.y && cy <= d.bounds.y + d.bounds.height
    ) || {}).id;
    displayStripEl.innerHTML = '';
    displays.forEach((d, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'display-icon' + (d.portrait ? ' is-portrait' : ' is-landscape');
      if (d.id === activeId) btn.classList.add('is-active');
      btn.dataset.id = String(d.id);
      btn.title = `${d.label} · ${d.bounds.width}×${d.bounds.height}${d.portrait ? ' · portrait' : ' · landscape'}${d.primary ? ' · primary' : ''} — click to move dashboard here`;
      btn.setAttribute('aria-label', `Move dashboard to ${d.label}`);
      btn.textContent = String(i + 1);
      displayStripEl.appendChild(btn);
    });
  }
  async function _refreshDisplayStrip() {
    try {
      const r = await window.dash.displaysList();
      if (r?.ok) _renderDisplayStrip(r.displays);
    } catch (err) {
      console.warn('[display-strip] list failed:', err?.message || err);
    }
  }
  displayStripEl.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('.display-icon');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (!Number.isFinite(id)) return;
    try {
      const r = await window.dash.displayMoveTo(id);
      if (!r?.ok) console.warn('[display-strip] move failed:', r?.error);
    } catch (err) {
      console.warn('[display-strip] move threw:', err?.message || err);
    }
    // The window-move triggers a viewport resize on the renderer —
    // re-layout panels against the new viewport so a smaller / wider
    // / portrait monitor doesn't leave panels off-screen or oversized.
    // The debounced 'resize' listener also catches this, but firing
    // now makes the snap feel instant instead of waiting 200 ms.
    setTimeout(() => {
      try { reapplyCurrentLayout(); } catch {}
      _refreshDisplayStrip();
    }, 200);
    playSfx('confirm');
  });
  // Auto-refresh on Electron's display-changed events. Also nudge a
  // refresh on every window resize so the active-state tracks moves
  // the user makes by dragging the window between monitors.
  window.dash.onDisplaysChanged?.((displays) => _renderDisplayStrip(displays));
  // Display-move done in main → re-run the adaptive layout decision
  // even when the new viewport dims didn't change (e.g. same pixel
  // count, different orientation). The resize listener catches the
  // common case; this catches the edge cases.
  window.dash.onWindowDisplayChanged?.(() => {
    try { applyAdaptiveLayout(); } catch (err) { console.warn('[display-strip] adaptive layout failed:', err?.message || err); }
    _refreshDisplayStrip();
  });
  window.addEventListener('resize', () => {
    // Coalesce resize bursts to avoid spam on drag-resize.
    clearTimeout(window._displayStripResizeTo);
    window._displayStripResizeTo = setTimeout(_refreshDisplayStrip, 250);
  });
  _refreshDisplayStrip();
}

// ── YouTube popout button ───────────────────────────────────────────────────
document.querySelector('#youtube-btn')?.addEventListener('click', async () => {
  await window.dash?.openYoutube?.();
  // If we're already in zen, immediately apply the zen treatment to the
  // brand-new window (enterZen has already fired and won't fire again).
  if (document.body.classList.contains('is-zen')) {
    setTimeout(() => window.dash?.setYoutubeZenMode?.(true), 250);
  }
});

// Keyboard shortcuts:
//   F11           — toggle fullscreen
//   F5            — reload the dashboard
//   Ctrl+Shift+R  — reset all panel widths
window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    e.preventDefault();
    window.dash?.toggleFullscreen?.();
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    window.location.reload();
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
    e.preventDefault();
    resetAllPanelSizes();
  }
});

// ── Terminal / diagnostics overlay ──────────────────────────────────────────
const terminalBtnEl    = document.querySelector('#terminal-btn');
const terminalPanelEl  = document.querySelector('#terminal-panel');
const terminalHeaderEl = document.querySelector('#terminal-header');
const terminalLogEl    = document.querySelector('#terminal-log');
const terminalClearEl  = document.querySelector('#terminal-clear');
const terminalCloseEl  = document.querySelector('#terminal-close');
const terminalResizeEl = document.querySelector('#terminal-resize');

const TERMINAL_MAX_LINES = 500;
const TERMINAL_START = Date.now();
let _termTimeFmt = 'hms';

function _termTs() {
  const d = new Date();
  if (_termTimeFmt === 'iso') {
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (_termTimeFmt === 'rel') {
    const s = ((Date.now() - TERMINAL_START) / 1000).toFixed(1);
    return `+${s.padStart(7, ' ')}s`;
  }
  return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
}

function termLog(level, args) {
  if (!terminalLogEl) return;
  const line = document.createElement('div');
  line.className = `log-line lvl-${level}`;
  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = _termTs();
  const lvlEl = document.createElement('span');
  lvlEl.className = 'log-lvl';
  lvlEl.textContent = level;
  const text = document.createElement('span');
  text.textContent = (Array.isArray(args) ? args : [args]).map(a => {
    if (a == null) return String(a);
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  line.appendChild(timeEl);
  line.appendChild(lvlEl);
  line.appendChild(text);
  terminalLogEl.appendChild(line);
  while (terminalLogEl.children.length > TERMINAL_MAX_LINES) {
    terminalLogEl.removeChild(terminalLogEl.firstChild);
  }
  terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
}

// Mirror console.log / warn / error into the terminal panel without
// breaking DevTools logging — original methods are still called.
const _origConsole = {
  log:   console.log.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
  info:  console.info.bind(console),
};
console.log   = (...a) => { _origConsole.log(...a);   termLog('info',  a); };
console.info  = (...a) => { _origConsole.info(...a);  termLog('info',  a); };
console.warn  = (...a) => { _origConsole.warn(...a);  termLog('warn',  a); };
console.error = (...a) => { _origConsole.error(...a); termLog('error', a); };

window.addEventListener('error', (e) => {
  termLog('error', [`${e.message || 'Error'}  (${e.filename || '?'}:${e.lineno || '?'}:${e.colno || '?'})`]);
});
window.addEventListener('unhandledrejection', (e) => {
  termLog('error', ['Unhandled rejection:', e.reason]);
});

// Initial diagnostics line so the user sees the terminal is alive.
termLog('info', [`DASHBOARD3D · UA=${navigator.userAgent.split(' ').slice(-2).join(' ')}`]);

terminalBtnEl?.addEventListener('click', async () => {
  if (!terminalPanelEl) return;
  const next = terminalPanelEl.hidden;
  terminalPanelEl.hidden = !next;
  terminalBtnEl.classList.toggle('is-active', next);
  if (next) terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalOpen: next });
});

async function closeTerminal() {
  if (!terminalPanelEl) return;
  terminalPanelEl.hidden = true;
  terminalBtnEl?.classList.remove('is-active');
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalOpen: false });
}

// Event-delegated handlers on the panel itself — survive any inner DOM
// changes and won't be accidentally suppressed by sibling listeners.
terminalPanelEl?.addEventListener('mousedown', (e) => {
  // Don't let action-button mousedowns reach the header's drag listener.
  if (e.target.closest && e.target.closest('.terminal-action')) {
    e.stopPropagation();
  }
});
terminalPanelEl?.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#terminal-close')) {
    e.stopPropagation();
    closeTerminal();
    return;
  }
  if (e.target.closest && e.target.closest('#terminal-clear')) {
    e.stopPropagation();
    if (terminalLogEl) terminalLogEl.innerHTML = '';
    return;
  }
});

// Drag from the header (so clicks on log text don't grab a drag).
// Use closest() so a click on any descendant (icon, text node, span)
// of an action button is treated as a button click, not a drag start.
terminalHeaderEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('.terminal-action')) return;
  e.preventDefault();
  const rect = terminalPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startLeft = rect.left, startTop = rect.top;
  terminalPanelEl.style.left = `${startLeft}px`;
  terminalPanelEl.style.top  = `${startTop}px`;
  terminalPanelEl.style.right = 'auto';
  const onMove = (ev) => {
    terminalPanelEl.style.left = `${startLeft + (ev.clientX - startX)}px`;
    terminalPanelEl.style.top  = `${startTop  + (ev.clientY - startY)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveTerminalGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

terminalResizeEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = terminalPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startW = rect.width, startH = rect.height;
  const onMove = (ev) => {
    terminalPanelEl.style.width  = `${Math.max(280, startW + (ev.clientX - startX))}px`;
    terminalPanelEl.style.height = `${Math.max(140, startH + (ev.clientY - startY))}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveTerminalGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

async function saveTerminalGeom() {
  if (!terminalPanelEl || !window.dash?.setConfig) return;
  const x = parseInt(terminalPanelEl.style.left, 10);
  const y = parseInt(terminalPanelEl.style.top,  10);
  const w = parseInt(terminalPanelEl.style.width,  10);
  const h = parseInt(terminalPanelEl.style.height, 10);
  const partial = {};
  if (Number.isFinite(x) && Number.isFinite(y)) partial.terminalPos  = { x, y };
  if (Number.isFinite(w) && Number.isFinite(h)) partial.terminalSize = { width: w, height: h };
  if (Object.keys(partial).length) await window.dash.setConfig(partial);
}

// ── Terminal telemetry ──────────────────────────────────────────────────────
const terminalIntervalEl = document.querySelector('#terminal-interval');
const terminalTfmtEl     = document.querySelector('#terminal-tfmt');
const terminalChannelEls = document.querySelectorAll('.terminal-toggles input[type="checkbox"]');
let _termTelemetryTimer = null;
let _termChannels = { sys: true, temp: true, net: true, disk: true, store: false };

function fmt1(n)   { return Number.isFinite(n) ? n.toFixed(1) : '—'; }
function fmt0(n)   { return Number.isFinite(n) ? Math.round(n).toString() : '—'; }
function fmtRateShort(b) {
  const r = fmtRate(b || 0);
  return `${r.num}${r.unit.replace('B/S', 'B').replace('/S', '')}`;
}

async function gatherTelemetry() {
  if (!window.dash) return;
  const tasks = [];
  if (_termChannels.sys && window.dash.systemInfo)
    tasks.push(window.dash.systemInfo().then(d => ['SYS', formatSys(d)]).catch(e => ['SYS', `ERR ${e.message}`]));
  if (_termChannels.temp && window.dash.tempsInfo)
    tasks.push(window.dash.tempsInfo().then(d => ['TEMP', formatTemp(d)]).catch(e => ['TEMP', `ERR ${e.message}`]));
  if (_termChannels.net && window.dash.netInfo)
    tasks.push(window.dash.netInfo().then(d => ['NET', formatNet(d)]).catch(e => ['NET', `ERR ${e.message}`]));
  if (_termChannels.disk && window.dash.diskInfo)
    tasks.push(window.dash.diskInfo().then(d => ['DISK', formatDisk(d)]).catch(e => ['DISK', `ERR ${e.message}`]));
  if (_termChannels.store && window.dash.storageInfo)
    tasks.push(window.dash.storageInfo().then(d => ['STORE', formatStore(d)]).catch(e => ['STORE', `ERR ${e.message}`]));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const [tag, msg] = r.value;
    termLog('info', [`[${tag}] ${msg}`]);
  }
}

function formatSys(d) {
  if (!d) return 'no data';
  const cpuCount = d.cpuCount || 0;
  const memUsedGB  = d.usedMem  ? (d.usedMem  / 1073741824) : null;
  const memTotalGB = d.totalMem ? (d.totalMem / 1073741824) : null;
  const memPct = memUsedGB && memTotalGB ? (memUsedGB / memTotalGB) * 100 : null;
  return `cores=${cpuCount} mem=${fmt1(memUsedGB)}/${fmt1(memTotalGB)}GB (${fmt0(memPct)}%)`;
}
function formatTemp(d) {
  if (!d) return 'no data';
  const cpu = Number.isFinite(d.cpu) ? `cpu=${fmt0(d.cpu)}°C` : 'cpu=—';
  const cpuP = Number.isFinite(d.cpuPower) ? `${fmt0(d.cpuPower)}W` : '';
  const gpus = (d.gpus || []).map((g, i) => {
    const t = Number.isFinite(g.temp)  ? `${fmt0(g.temp)}°C` : '—';
    const u = Number.isFinite(g.load)  ? `${fmt0(g.load)}%`  : '—';
    const p = Number.isFinite(g.power) ? ` ${fmt0(g.power)}W` : '';
    return `gpu${i}=${t}/${u}${p}`;
  }).join(' ');
  return [cpu + (cpuP ? `(${cpuP})` : ''), gpus, `src=${(d.sources || []).join(',') || 'none'}`].filter(Boolean).join(' ');
}
function formatNet(d) {
  if (!d) return 'no data';
  return `iface=${d.iface || 'none'} rx=${fmtRateShort(d.rxSec)} tx=${fmtRateShort(d.txSec)} total rx=${fmtBytes(d.rxTotal || 0)} tx=${fmtBytes(d.txTotal || 0)}`;
}
function formatDisk(d) {
  if (!d) return 'no data';
  return `read=${fmtRateShort(d.readSec)} write=${fmtRateShort(d.writeSec)} q=${fmt0(d.queueLen)} ${d.unsupported ? 'UNSUPPORTED' : ''}`.trim();
}
function formatStore(d) {
  if (!Array.isArray(d) || !d.length) return 'no drives';
  return d.slice(0, 6).map(x => {
    const used = x.used ? `${fmtBytes(x.used)}/${fmtBytes(x.total)}` : '[net]';
    return `${x.mount}=${used}`;
  }).join(' ');
}

function applyTermInterval(seconds) {
  clearInterval(_termTelemetryTimer);
  _termTelemetryTimer = null;
  if (!seconds || seconds <= 0) {
    termLog('info', ['telemetry: OFF']);
    return;
  }
  termLog('info', [`telemetry: every ${seconds}s, channels=${Object.entries(_termChannels).filter(([,v]) => v).map(([k]) => k).join(',')}`]);
  // Fire one immediately so the user sees data right away, then on interval.
  gatherTelemetry();
  _termTelemetryTimer = setInterval(() => {
    if (!document.hidden) gatherTelemetry();
  }, seconds * 1000);
}

terminalIntervalEl?.addEventListener('change', async () => {
  const sec = parseInt(terminalIntervalEl.value, 10);
  applyTermInterval(sec);
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalInterval: sec });
});
terminalTfmtEl?.addEventListener('change', async () => {
  _termTimeFmt = terminalTfmtEl.value;
  if (window.dash?.setConfig) await window.dash.setConfig({ terminalTimeFmt: _termTimeFmt });
});
terminalChannelEls.forEach(cb => {
  cb.addEventListener('change', async () => {
    _termChannels[cb.dataset.ch] = cb.checked;
    if (window.dash?.setConfig) await window.dash.setConfig({ terminalChannels: { ..._termChannels } });
  });
});

// ── Webcam preview ──────────────────────────────────────────────────────────
const cameraBtnEl    = document.querySelector('#camera-btn');
const webcamPanelEl  = document.querySelector('#webcam-panel');
const webcamVideoEl  = document.querySelector('#webcam-video');
const webcamCloseEl  = document.querySelector('#webcam-close');
const webcamCycleEl  = document.querySelector('#webcam-cycle');
const webcamLabelEl  = document.querySelector('#webcam-label');
const webcamResizeEl = document.querySelector('#webcam-resize');
const webcamPixelEl  = document.querySelector('#webcam-pixel');

// rAF loop that downsamples the live video into the small canvas. Only runs
// while zen is active AND the webcam panel is open. Sync via syncWebcamPixel.
let _pixelRAF = null;
function startPixelLoop() {
  if (_pixelRAF || !webcamPixelEl || !webcamVideoEl) return;
  const ctx = webcamPixelEl.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const draw = () => {
    if (webcamVideoEl.videoWidth > 0 && webcamVideoEl.videoHeight > 0) {
      ctx.drawImage(webcamVideoEl, 0, 0, webcamPixelEl.width, webcamPixelEl.height);
    }
    _pixelRAF = requestAnimationFrame(draw);
  };
  _pixelRAF = requestAnimationFrame(draw);
}
function stopPixelLoop() {
  if (_pixelRAF) cancelAnimationFrame(_pixelRAF);
  _pixelRAF = null;
}
function syncWebcamPixel() {
  const zen = document.body.classList.contains('is-zen');
  const open = webcamPanelEl && !webcamPanelEl.hidden;
  if (zen && open) startPixelLoop();
  else stopPixelLoop();
}
// Painted random-noise canvas adds true TV-static dropout on top of the
// CSS scanlines + tracking bar. Stops automatically after the transition
// window. _noiseRAF guards against overlapping loops on rapid cycles.
const webcamNoiseEl = document.querySelector('#webcam-noise');
let _noiseRAF = null;
function runNoise(durationMs = 700) {
  if (!webcamNoiseEl || _noiseRAF) return;
  const ctx = webcamNoiseEl.getContext('2d', { willReadFrequently: false });
  if (!ctx) return;
  const w = webcamNoiseEl.width;
  const h = webcamNoiseEl.height;
  const stop = performance.now() + durationMs;
  const step = () => {
    if (performance.now() > stop) { _noiseRAF = null; return; }
    const img = ctx.createImageData(w, h);
    const d = img.data;
    // Pure fine-grain monochrome snow at canvas resolution. 320×240 against
    // ~280×200 panels means each canvas pixel is ~= one screen pixel, so
    // the grain is fine instead of chunky. The CSS layer (.webcam-static)
    // adds the scanlines on top of this.
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 230) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    _noiseRAF = requestAnimationFrame(step);
  };
  _noiseRAF = requestAnimationFrame(step);
}
let _webcamStream = null;
let _cameras = [];           // cached video input device list
let _activeCameraId = null;  // deviceId of the currently streaming camera

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    _cameras = devices.filter(d => d.kind === 'videoinput');
  } catch (err) {
    console.warn('enumerateDevices failed:', err.message);
  }
}

function updateWebcamLabel() {
  if (!webcamLabelEl) return;
  if (!_activeCameraId || !_cameras.length) {
    webcamLabelEl.textContent = 'CAMERA';
    return;
  }
  const idx = _cameras.findIndex(c => c.deviceId === _activeCameraId);
  const cam = idx >= 0 ? _cameras[idx] : null;
  // Labels are only populated after a getUserMedia grant, so fall back to
  // a numeric index until we have the friendly name.
  const name = cam?.label?.trim();
  const tag = `${idx + 1}/${_cameras.length}`;
  webcamLabelEl.textContent = (name ? name : `CAMERA`).toUpperCase().slice(0, 26) + (
    _cameras.length > 1 ? `  ·  ${tag}` : ''
  );
}

async function startWebcam(deviceId = null) {
  // Stop any prior stream cleanly so the camera light goes off in between.
  if (_webcamStream) {
    for (const t of _webcamStream.getTracks()) { try { t.stop(); } catch {} }
    _webcamStream = null;
  }
  try {
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };
    _webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (webcamVideoEl) webcamVideoEl.srcObject = _webcamStream;
    // Mirror the same stream into the clock-panel profile picture so the
    // camera also takes over that slot whenever the webcam popout is on.
    setProfilePicLive(_webcamStream);
    const settings = _webcamStream.getVideoTracks()[0]?.getSettings?.();
    _activeCameraId = deviceId || settings?.deviceId || _activeCameraId;
    await refreshCameraList(); // labels are now usable
    updateWebcamLabel();
    return true;
  } catch (err) {
    console.error('webcam start failed:', err);
    return false;
  }
}

function stopWebcam() {
  if (webcamVideoEl) webcamVideoEl.srcObject = null;
  // Release the stream from the profile-pic too and reveal whatever the
  // user had picked (img / placeholder) underneath.
  setProfilePicLive(null);
  if (_webcamStream) {
    for (const t of _webcamStream.getTracks()) { try { t.stop(); } catch {} }
    _webcamStream = null;
  }
}

async function cycleCamera() {
  await refreshCameraList();
  if (_cameras.length < 2) return;
  const curIdx = Math.max(0, _cameras.findIndex(c => c.deviceId === _activeCameraId));
  const nextIdx = (curIdx + 1) % _cameras.length;
  const nextId = _cameras[nextIdx].deviceId;
  // VHS transition: scanlines + tracking bar + painted RGB noise + roll
  // for ~700ms while the new stream comes up under it.
  webcamPanelEl?.classList.add('is-switching');
  runNoise(700);
  await startWebcam(nextId);
  setTimeout(() => webcamPanelEl?.classList.remove('is-switching'), 700);
  if (window.dash?.setConfig) await window.dash.setConfig({ webcamDeviceId: nextId });
}

async function setWebcamOpen(on, deviceId = undefined) {
  if (!webcamPanelEl) return;
  cameraBtnEl?.classList.toggle('is-active', !!on);
  if (on) {
    webcamPanelEl.hidden = false;
    const ok = await startWebcam(deviceId);
    if (!ok) {
      webcamPanelEl.hidden = true;
      cameraBtnEl?.classList.remove('is-active');
      return;
    }
  } else {
    webcamPanelEl.hidden = true;
    stopWebcam();
  }
  syncWebcamPixel();
  if (window.dash?.setConfig) await window.dash.setConfig({ webcamOpen: on });
}

cameraBtnEl?.addEventListener('click', async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  await setWebcamOpen(!cfg.webcamOpen, cfg.webcamDeviceId || undefined);
});
webcamCloseEl?.addEventListener('mousedown', (e) => e.stopPropagation());
webcamCloseEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  setWebcamOpen(false);
});
webcamCycleEl?.addEventListener('mousedown', (e) => e.stopPropagation());
webcamCycleEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  cycleCamera();
});

// Drag to move (anywhere on the panel except the resize handle/close button)
webcamPanelEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target === webcamCloseEl || e.target === webcamResizeEl) return;
  e.preventDefault();
  const rect = webcamPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startLeft = rect.left, startTop = rect.top;
  webcamPanelEl.style.left = `${startLeft}px`;
  webcamPanelEl.style.top  = `${startTop}px`;
  webcamPanelEl.style.right = 'auto';
  const onMove = (ev) => {
    webcamPanelEl.style.left = `${startLeft + (ev.clientX - startX)}px`;
    webcamPanelEl.style.top  = `${startTop  + (ev.clientY - startY)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveWebcamGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// Resize from the bottom-right handle
webcamResizeEl?.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = webcamPanelEl.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const startW = rect.width, startH = rect.height;
  const onMove = (ev) => {
    const w = Math.max(160, startW + (ev.clientX - startX));
    const h = Math.max(120, startH + (ev.clientY - startY));
    webcamPanelEl.style.width  = `${w}px`;
    webcamPanelEl.style.height = `${h}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveWebcamGeom();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

async function saveWebcamGeom() {
  if (!webcamPanelEl || !window.dash?.setConfig) return;
  const x = parseInt(webcamPanelEl.style.left, 10);
  const y = parseInt(webcamPanelEl.style.top,  10);
  const w = parseInt(webcamPanelEl.style.width,  10);
  const h = parseInt(webcamPanelEl.style.height, 10);
  const partial = {};
  if (Number.isFinite(x) && Number.isFinite(y)) partial.webcamPos  = { x, y };
  if (Number.isFinite(w) && Number.isFinite(h)) partial.webcamSize = { width: w, height: h };
  if (Object.keys(partial).length) await window.dash.setConfig(partial);
}

// ── Zen idle mode ───────────────────────────────────────────────────────────
// After ZEN_IDLE_MS of no input, slide every tool panel
// off-screen so only the audio meters and background grid remain. Any input
// brings them back. CSS handles the actual motion via `body.is-zen`.
//
// While zen is active, swap to a low-contrast palette + dim filter so the
// remaining audio bars + grid read as a calm screensaver. Snapshot the
// user's previous theme/dim before swapping so we can restore on exit
// without writing to config (so the user's saved theme is preserved).
// ZEN_IDLE_MS was the no-input-before-auto-enter delay. Auto-enter has
// been removed (zen is manual-only now); the constant stays so the
// auto path is a one-line restore inside armZenTimer if we ever want
// it back.
const ZEN_IDLE_MS = 5 * 60 * 1000;
let _zenTimer = null;
// Single timer shared by the fade-in/fade-out CSS transitions. Tracked so
// leaveZen can cancel an in-flight entry (and vice versa) — otherwise the
// orphaned callback re-applies its class after the opposite transition
// already ran, leaving body.is-zen stuck on while _zenActive is false.
let _zenTransitionTimer = null;
// After ZEN_CURSOR_HIDE_MS of being in zen with no input, hide the
// cursor so the screen reads as a pure clock/visualizer. Any mousemove
// already triggers leaveZen via armZenTimer, which clears this timer
// and the cursor-hidden class together.
const ZEN_CURSOR_HIDE_MS = 3000;
let _zenCursorTimer = null;
let _zenActive = false;
// _zenPrevTheme stays for the leaveZen() safety call. Since enterZen no
// longer changes the theme, the call is a no-op in the happy path —
// kept defensive for any future code that does swap the palette.
let _zenPrevTheme = null;

// Zen-mode CPU throttle. 85% ceiling keeps real headroom for HEVC/AV1
// decode + GPU compositing of the dimmed overlay; tighter caps cause
// concurrent-video stutter.
const ZEN_POWER_ZEN    = { maxCpu: 85, minCpu: 5 };
const ZEN_POWER_NORMAL = { maxCpu: 90, minCpu: 5 };

function applyZenPower(opts) {
  if (!window.dash?.setPowerProfile) return;
  window.dash.setPowerProfile(opts).then((r) => {
    if (r?.ok) console.log(`power: max=${r.max}% min=${r.min}%`);
    else if (r?.error) console.warn(`power: ${r.error}`);
  }).catch((err) => console.warn('power:', err.message));
}

// ── Zen video backdrop ─────────────────────────────────────────
// When the in-pane media player has a video playing and the user
// enters zen, the parent panel fades to opacity 0 — which also hides
// the video because opacity composes multiplicatively from parent →
// child. Workaround: hoist the <video> element out of its panel and
// up to <body> for the duration of zen, then put it back exactly
// where it came from. A comment-node placeholder preserves the
// original DOM position even if siblings shift while it's gone.
let _zenVideoOrigin = null;
function _zenVideoEnter() {
  const vid = document.getElementById('visualizer-video');
  if (!vid || vid.dataset.zenMoved === '1') return;
  if (!vid.src || vid.paused) return;
  const marker = document.createComment(' zen-video-origin ');
  vid.parentNode.insertBefore(marker, vid);
  _zenVideoOrigin = marker;
  document.body.appendChild(vid);
  vid.dataset.zenMoved = '1';
}
function _zenVideoExit() {
  const vid = document.getElementById('visualizer-video');
  if (!vid || vid.dataset.zenMoved !== '1') return;
  if (_zenVideoOrigin && _zenVideoOrigin.parentNode) {
    _zenVideoOrigin.parentNode.insertBefore(vid, _zenVideoOrigin);
    _zenVideoOrigin.parentNode.removeChild(_zenVideoOrigin);
  }
  _zenVideoOrigin = null;
  delete vid.dataset.zenMoved;
}

function enterZen() {
  if (_zenActive) return;
  _zenActive = true;
  // Preserve the user's current theme — zen mode used to randomize on
  // entry and cycle every N seconds, which made the focus mode flicker
  // between palettes the user hadn't picked. Keep _zenPrevTheme in case
  // we ever want to restore (no-op now since we don't change it).
  _zenPrevTheme = document.documentElement.getAttribute('data-theme') || null;
  applyZenPower(ZEN_POWER_ZEN);
  // Kick off the entry transition; settle into the steady zen state once
  // the fade-through-black completes (CSS-only; see styles.css).
  clearTimeout(_zenTransitionTimer);
  document.body.classList.remove('is-zen-leaving');
  document.body.classList.add('is-zen-entering');
  _zenTransitionTimer = setTimeout(() => {
    if (!_zenActive) return;
    document.body.classList.remove('is-zen-entering');
    document.body.classList.add('is-zen');
  }, 1100);
  clearTimeout(_zenCursorTimer);
  _zenCursorTimer = setTimeout(() => {
    if (!_zenActive) return;
    document.body.classList.add('is-zen-cursor-hidden');
  }, ZEN_CURSOR_HIDE_MS);
  // Audio bars get expanded and stretched wide → upsample from 24 to 96.
  // Drop the gain so the dense bar spectrum reads as a calm visualization.
  // Pause width-adaptive rebuilding so the zen count sticks.
  audioOutViz?.setAdaptiveBars?.(false);
  audioInViz ?.setAdaptiveBars?.(false);
  audioOutViz?.rebuildBars?.(AUDIO_BAR_COUNT_ZEN);
  audioInViz ?.rebuildBars?.(AUDIO_BAR_COUNT_ZEN);
  _audioGainScale = AUDIO_ZEN_GAIN_SCALE;
  syncWebcamPixel();
  // YouTube popout (if open): fullscreen + 50% transparent so it plays
  // as a clear backdrop behind the zen overlay.
  window.dash?.setYoutubeZenMode?.(true);
  // In-pane media player: hoist its <video> out of the fading panel
  // so it stays visible as a fullscreen backdrop.
  _zenVideoEnter();
  // Browser pane: if any tab has a playing video, main expands that
  // BrowserView to fullscreen and injects CSS so the video covers the
  // page. Skips silently when nothing is playing.
  try { window.dash?.browserSetZenMode?.(true); } catch {}
  // Pause diagnostic-terminal telemetry while in zen — the per-interval
  // PowerShell child-process spawns (disk I/O, temps via LHM, storage)
  // briefly thrash CPU + disk, which is enough to hitch concurrent video
  // playback. Resumes on zen exit at the user's previously-saved interval.
  if (_termTelemetryTimer) {
    clearInterval(_termTelemetryTimer);
    _termTelemetryTimer = null;
  }
  // Cycle through the 5-day forecast in the corner widget.
  _zenForecastIdx = 0;
  paintZenForecast(0);
  clearInterval(_zenForecastTimer);
  _zenForecastTimer = setInterval(() => {
    if (!_forecastDaily.length) return;
    _zenForecastIdx = (_zenForecastIdx + 1) % _forecastDaily.length;
    paintZenForecast(_zenForecastIdx);
  }, ZEN_FORECAST_CYCLE_MS);
}

function leaveZen() {
  if (!_zenActive) return;
  _zenActive = false;
  // Reverse the fade-through-black on exit (CSS-only).
  clearTimeout(_zenTransitionTimer);
  clearTimeout(_zenCursorTimer);
  document.body.classList.remove('is-zen-cursor-hidden');
  document.body.classList.remove('is-zen');
  document.body.classList.remove('is-zen-entering');
  document.body.classList.add('is-zen-leaving');
  _zenTransitionTimer = setTimeout(() => {
    if (_zenActive) return;
    document.body.classList.remove('is-zen-leaving');
  }, 950);
  applyTheme(_zenPrevTheme);
  applyZenPower(ZEN_POWER_NORMAL);
  audioOutViz?.rebuildBars?.(AUDIO_BAR_COUNT_NORMAL);
  audioInViz ?.rebuildBars?.(AUDIO_BAR_COUNT_NORMAL);
  // Re-enable width-adaptive rebuilding now that we're back to normal mode.
  audioOutViz?.setAdaptiveBars?.(true);
  audioInViz ?.setAdaptiveBars?.(true);
  _audioGainScale = 1.0;
  clearInterval(_zenForecastTimer);
  _zenForecastTimer = null;
  _zenForecastIdx = 0;
  syncWebcamPixel();
  window.dash?.setYoutubeZenMode?.(false);
  try { window.dash?.browserSetZenMode?.(false); } catch {}
  _zenVideoExit();
  // Resume telemetry polling at the user's saved cadence.
  const sec = parseInt(terminalIntervalEl?.value, 10);
  if (Number.isFinite(sec) && sec > 0) applyTermInterval(sec);
}

// When the user clicks the zen button, the same click bubbles up to the
// global input listeners that would normally exit zen — so we suppress the
// arm/leave path for a short window around the button click.
let _zenForceArming = false;

// Zen is now MANUAL-ONLY. Earlier this function also scheduled
// `enterZen` after ZEN_IDLE_MS of no input — that auto-trigger has been
// removed per user request. The function still runs on every input
// event so an already-active zen session exits the moment the user
// interacts, but no setTimeout is queued any more. ZEN_IDLE_MS is kept
// in the file so re-enabling auto-zen is a one-line restore.
function armZenTimer() {
  if (_zenForceArming) return;
  if (_zenActive) leaveZen();
  clearTimeout(_zenTimer);
  _zenTimer = null;
}
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'touchmove']
  .forEach(ev => window.addEventListener(ev, armZenTimer, { passive: true }));
armZenTimer();

// The YouTube popout can request a zen exit (its Esc handler routes here
// when the dashboard is in zen). Re-arm so the idle timer doesn't
// immediately tip back into zen.
window.dash?.onForceLeaveZen?.(() => {
  if (_zenActive) {
    leaveZen();
    armZenTimer();
  }
});

// Escape key — dedicated zen exit. Listening in the capture phase so a
// focused input (notes textarea, chat input, browser URL bar) can't
// swallow the keystroke before it reaches us. We don't preventDefault
// so the focused element still gets its Esc handler too (e.g. blur an
// input) — we just guarantee that zen always lifts on Esc regardless
// of where focus is.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!_zenActive) return;
  leaveZen();
  armZenTimer();
}, true);

// Visible exit button rendered inside the zen overlay. Stops the click
// from bubbling to the global armZenTimer / mousedown handlers so the
// only side-effect is leaveZen + a clean timer re-arm.
const zenExitBtnEl = document.querySelector('#zen-exit-btn');
zenExitBtnEl?.addEventListener('mousedown', (e) => e.stopPropagation());
zenExitBtnEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (_zenActive) {
    leaveZen();
    armZenTimer();
  }
});

const zenBtnEl = document.querySelector('#zen-btn');
zenBtnEl?.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  _zenForceArming = true; // suppress leaveZen on the bubbling mousedown
});
zenBtnEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  clearTimeout(_zenTimer);
  enterZen();
  // Re-enable the normal arm/exit behavior after this click cycle settles
  // so the user can leave zen by moving the mouse / typing.
  setTimeout(() => { _zenForceArming = false; }, 1000);
});

// ── §bgm ── BACKGROUND MUSIC ────────────────────────────────────────────
// Lazy combo pane — code lives in features/music.js, loaded on first open
// by activateLazyPane(). Exposes window._bgmState (for paintComboHeader)
// and window._bgmMaybeStartMeter (for setComboMode).

// ── FANS: read-only Stage 1 (monitor + curve designer) ─────────────
// LibreHardwareMonitor exposes sensor data over HTTP when its "Remote
// Web Server" option is enabled (default port 8085). The main process
// polls /data.json and flattens the tree into fans/temps/pwm arrays.
// This block renders the HUD panel + the curve-editor overlay. No
// writes — Stage 1 is purely a designer + monitor.
(() => {
  const POLL_MS = 2000;
  // viewBox of the plot SVG. Width = temp axis (0 → 100 °C), height =
  // pct axis (100 → 0 %, since SVG y grows downward).
  const PLOT_W = 400, PLOT_H = 240;
  const DEFAULT_POINTS = [
    { temp: 30, pct: 30 },
    { temp: 50, pct: 50 },
    { temp: 70, pct: 75 },
    { temp: 85, pct: 90 },
    { temp: 100, pct: 100 },
  ];

  const listEl       = document.getElementById('fans-list');
  const emptyEl      = document.getElementById('fans-empty');
  const statusTagEl  = document.getElementById('fans-status-tag');
  const editBtn      = document.getElementById('fans-edit-btn');
  const curvesCntEl  = document.getElementById('fans-curves-count');
  if (!listEl || !editBtn) return;

  // Curve editor refs.
  const overlay      = document.getElementById('fans-editor-overlay');
  const closeBtn     = document.getElementById('fans-editor-close-btn');
  const fanSelect    = document.getElementById('fans-editor-fan');
  const tempSelect   = document.getElementById('fans-editor-temp');
  const curTempEl    = document.getElementById('fans-editor-cur-temp');
  const curRpmEl     = document.getElementById('fans-editor-cur-rpm');
  const targetPctEl  = document.getElementById('fans-editor-target-pct');
  const plotEl       = document.getElementById('fans-editor-plot');
  const gridEl       = document.getElementById('fans-editor-grid');
  const tempLineEl   = document.getElementById('fans-editor-temp-line');
  const fillEl       = document.getElementById('fans-editor-fill');
  const strokeEl     = document.getElementById('fans-editor-stroke');
  const pointsEl     = document.getElementById('fans-editor-points');
  const statusEl     = document.getElementById('fans-editor-status');
  const saveBtn      = document.getElementById('fans-editor-save-btn');
  const resetBtn     = document.getElementById('fans-editor-reset-btn');
  const deleteBtn    = document.getElementById('fans-editor-delete-btn');

  // In-memory state. Curves are now keyed by GROUP, not by individual
  // fan id. Two groups:
  //   cpu — CPU socket fan + AIO pump + every chassis/case fan on the
  //         motherboard super-I/O chip. They share a curve driven by
  //         CPU package temperature.
  //   gpu — every fan whose parent device is a GPU (NVIDIA/AMD/Intel
  //         Arc / GeForce / RTX / Radeon). Curve driven by GPU temp.
  // Case fans get lumped into the CPU group because case airflow on a
  // typical desktop tracks CPU heat load; the GPU has its own loop.
  // Stage 1 is read-only — curves are designed and saved but not yet
  // applied to the hardware.
  const GPU_DEVICE_RE = /(nvidia|geforce|gtx|rtx|radeon|amd\s|intel\s+arc|\bgpu\b)/i;
  function classifyFan(f) {
    return GPU_DEVICE_RE.test(f?.device || '') ? 'gpu' : 'cpu';
  }
  const GROUPS = ['cpu', 'gpu'];
  const GROUP_LABELS = { cpu: 'CPU + CASE', gpu: 'GPU' };

  let _curves = { cpu: null, gpu: null };  // { cpu: {sourceTempId, sourceTempName, points} | null, gpu: same }
  let _last = null;             // last fans:poll result
  let _editorGroup = 'cpu';     // group currently being edited ('cpu' | 'gpu')
  let _editorPoints = [];       // working copy of points (committed on SAVE)

  const tempToX = (t) => Math.max(0, Math.min(PLOT_W, (t / 100) * PLOT_W));
  const pctToY  = (p) => Math.max(0, Math.min(PLOT_H, ((100 - p) / 100) * PLOT_H));
  const xToTemp = (x) => Math.max(0, Math.min(100, (x / PLOT_W) * 100));
  const yToPct  = (y) => Math.max(0, Math.min(100, ((PLOT_H - y) / PLOT_H) * 100));

  // Linear interpolation of pct at a given temp across the sorted points
  // array. Below the lowest point clamps to that point's pct; above the
  // highest does the same. Returns null if no points.
  function interpPct(points, t) {
    if (!points.length) return null;
    const sorted = points.slice().sort((a, b) => a.temp - b.temp);
    if (t <= sorted[0].temp) return sorted[0].pct;
    if (t >= sorted[sorted.length - 1].temp) return sorted[sorted.length - 1].pct;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (t >= a.temp && t <= b.temp) {
        const r = (t - a.temp) / (b.temp - a.temp || 1);
        return a.pct + (b.pct - a.pct) * r;
      }
    }
    return sorted[sorted.length - 1].pct;
  }

  // Build the static gridlines + axis labels once; the curve path,
  // points, and live temp line update every paint.
  function buildGrid() {
    if (!gridEl) return;
    const frag = [];
    for (let pct = 0; pct <= 100; pct += 25) {
      const y = pctToY(pct);
      frag.push(`<line x1="0" y1="${y}" x2="${PLOT_W}" y2="${y}"></line>`);
    }
    for (let t = 0; t <= 100; t += 20) {
      const x = tempToX(t);
      frag.push(`<line x1="${x}" y1="0" x2="${x}" y2="${PLOT_H}"></line>`);
    }
    gridEl.innerHTML = frag.join('');
  }

  function paintCurve() {
    if (!plotEl) return;
    const pts = _editorPoints.slice().sort((a, b) => a.temp - b.temp);
    // Stroke + fill path. Fill closes the polygon along the bottom edge
    // so the area under the curve reads as filled.
    const coords = pts.map((p) => `${tempToX(p.temp).toFixed(1)},${pctToY(p.pct).toFixed(1)}`);
    const strokeD = coords.length ? 'M ' + coords.join(' L ') : '';
    const fillD = coords.length
      ? `M ${tempToX(pts[0].temp).toFixed(1)},${PLOT_H} L ` + coords.join(' L ') + ` L ${tempToX(pts[pts.length - 1].temp).toFixed(1)},${PLOT_H} Z`
      : '';
    strokeEl.setAttribute('d', strokeD);
    fillEl.setAttribute('d', fillD);
    // Re-render handles. Each <circle> stores its index in data-idx so
    // the pointer handlers know which point to mutate.
    pointsEl.innerHTML = pts.map((p, i) =>
      `<circle class="fans-editor-point" data-idx="${i}" cx="${tempToX(p.temp).toFixed(1)}" cy="${pctToY(p.pct).toFixed(1)}" r="6"></circle>`
    ).join('');
    // Live temp marker + target readout.
    paintLiveOverlay();
  }
  function paintLiveOverlay() {
    if (!_last || _last.status !== 'connected') {
      tempLineEl.setAttribute('visibility', 'hidden');
      if (targetPctEl) targetPctEl.textContent = '—';
      return;
    }
    // Average RPM of every fan in the current group — gives a single
    // readout that summarizes "what the group is doing right now".
    const groupFans = (_last.fans || []).filter((f) => Number(f.value) > 0 && classifyFan(f) === _editorGroup);
    const avgRpm = groupFans.length
      ? groupFans.reduce((sum, f) => sum + Number(f.value), 0) / groupFans.length
      : null;
    const tempId = tempSelect?.value || null;
    const temp = (_last.temps || []).find((t) => t.id === tempId);
    if (curRpmEl)  curRpmEl.textContent  = avgRpm != null ? `${Math.round(avgRpm)} RPM` : '—';
    if (curTempEl) curTempEl.textContent = temp ? `${temp.value.toFixed(1)}°C` : '—';
    if (temp) {
      const x = tempToX(temp.value);
      tempLineEl.setAttribute('x1', x);
      tempLineEl.setAttribute('x2', x);
      tempLineEl.setAttribute('y1', 0);
      tempLineEl.setAttribute('y2', PLOT_H);
      tempLineEl.removeAttribute('visibility');
      const tgt = interpPct(_editorPoints, temp.value);
      if (targetPctEl) targetPctEl.textContent = tgt == null ? '—' : `${tgt.toFixed(0)}%`;
    } else {
      tempLineEl.setAttribute('visibility', 'hidden');
      if (targetPctEl) targetPctEl.textContent = '—';
    }
  }

  // Pointer drag handling — single delegated listener on the SVG so
  // dynamic points work without re-binding.
  let _drag = null; // { idx, pointerId }
  function clientToPlot(ev) {
    const r = plotEl.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width)  * PLOT_W;
    const y = ((ev.clientY - r.top)  / r.height) * PLOT_H;
    return { x, y };
  }
  plotEl?.addEventListener('pointerdown', (ev) => {
    const target = ev.target;
    if (!(target instanceof SVGCircleElement)) return;
    const idx = Number(target.dataset.idx);
    if (!Number.isFinite(idx)) return;
    _drag = { idx, pointerId: ev.pointerId };
    target.classList.add('is-dragging');
    plotEl.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  plotEl?.addEventListener('pointermove', (ev) => {
    if (!_drag || ev.pointerId !== _drag.pointerId) return;
    const { x, y } = clientToPlot(ev);
    const pts = _editorPoints.slice().sort((a, b) => a.temp - b.temp);
    const p = pts[_drag.idx];
    if (!p) return;
    // Constrain temp between neighbors so the curve stays monotonic in x.
    const minT = _drag.idx > 0              ? pts[_drag.idx - 1].temp + 0.5 : 0;
    const maxT = _drag.idx < pts.length - 1 ? pts[_drag.idx + 1].temp - 0.5 : 100;
    p.temp = Math.max(minT, Math.min(maxT, xToTemp(x)));
    p.pct  = yToPct(y);
    _editorPoints = pts;
    paintCurve();
  });
  function endDrag(ev) {
    if (!_drag) return;
    if (ev.pointerId !== _drag.pointerId) return;
    try { plotEl.releasePointerCapture(ev.pointerId); } catch {}
    pointsEl.querySelectorAll('.is-dragging').forEach((n) => n.classList.remove('is-dragging'));
    _drag = null;
  }
  plotEl?.addEventListener('pointerup', endDrag);
  plotEl?.addEventListener('pointercancel', endDrag);
  // Double-click empty space → insert a new control point at the
  // cursor position, sorted into the points array.
  plotEl?.addEventListener('dblclick', (ev) => {
    if (ev.target instanceof SVGCircleElement) return; // ignore dblclick on existing point
    const { x, y } = clientToPlot(ev);
    _editorPoints.push({ temp: xToTemp(x), pct: yToPct(y) });
    _editorPoints.sort((a, b) => a.temp - b.temp);
    paintCurve();
  });
  // Right-click point → remove (min 2 points so the curve has a slope).
  plotEl?.addEventListener('contextmenu', (ev) => {
    if (!(ev.target instanceof SVGCircleElement)) return;
    ev.preventDefault();
    if (_editorPoints.length <= 2) return;
    const idx = Number(ev.target.dataset.idx);
    const sorted = _editorPoints.slice().sort((a, b) => a.temp - b.temp);
    sorted.splice(idx, 1);
    _editorPoints = sorted;
    paintCurve();
  });

  // ── HUD panel render ──────────────────────────────────────────────
  function renderFanList() {
    if (!listEl) return;
    if (!_last) {
      // First poll hasn't returned yet — keep the boot-empty hint.
      return;
    }
    if (_last.status !== 'connected') {
      listEl.innerHTML = '';
      listEl.appendChild(emptyEl);
      emptyEl.hidden = false;
      if (statusTagEl) {
        statusTagEl.textContent = 'OFFLINE';
        statusTagEl.classList.add('is-offline');
        statusTagEl.classList.remove('is-connected');
      }
      if (curvesCntEl) curvesCntEl.textContent = `${Object.keys(_curves).length} SAVED`;
      return;
    }
    // Hide fans reporting 0 RPM — those are empty fan headers or
    // fans not currently spinning. LHM reports every header the
    // super-I/O chip exposes, including unconnected ones, which
    // clutters the panel with rows that never move.
    const fansAll = _last.fans || [];
    const fans = fansAll.filter((f) => Number(f.value) > 0);
    const savedCount = GROUPS.filter((g) => _curves[g]).length;
    if (statusTagEl) {
      statusTagEl.textContent = 'LHM · ' + fans.length;
      statusTagEl.classList.add('is-connected');
      statusTagEl.classList.remove('is-offline');
    }
    if (curvesCntEl) curvesCntEl.textContent = `${savedCount}/${GROUPS.length} SAVED`;
    if (!fans.length) {
      listEl.innerHTML = '';
      emptyEl.textContent = fansAll.length
        ? 'ALL FANS REPORTING 0 RPM · NOTHING SPINNING'
        : 'NO FANS REPORTED · CHECK LHM SENSOR PERMISSIONS';
      emptyEl.hidden = false;
      listEl.appendChild(emptyEl);
      return;
    }
    emptyEl.hidden = true;
    // Group fans by classifyFan(). Each group is rendered as a single
    // "linked" row — one curve target, one seg-bar, with the member
    // fans listed underneath. CPU fans are linked: a single CPU curve
    // commands all of them at the same PWM, so showing per-fan bars
    // would mis-imply they can diverge.
    const parts = [];
    for (const group of GROUPS) {
      const groupFans = fans.filter((f) => classifyFan(f) === group);
      if (!groupFans.length) continue;
      const curve = _curves[group];
      // Resolve curve → current target % (and the temp driving it).
      let targetPct = null;
      let tempLabel = null;
      if (curve) {
        const tempSensor = (_last.temps || []).find((t) => t.id === curve.sourceTempId);
        if (tempSensor) {
          targetPct = interpPct(curve.points, Number(tempSensor.value));
          tempLabel = `${tempSensor.name} ${tempSensor.value.toFixed(1)}°C`;
        }
      }
      const high = targetPct != null && targetPct >= 80 ? ' high' : '';
      const targetTxt = targetPct == null ? '—' : `${targetPct.toFixed(0)}`;
      const barW = targetPct == null ? 0 : Math.max(0, Math.min(100, targetPct));
      // Average RPM across the group's fans (informational — gives a
      // sense of "what the group is doing right now" without per-fan
      // detail clutter).
      const avgRpm = Math.round(groupFans.reduce((s, f) => s + Number(f.value), 0) / groupFans.length);
      // Member sub-list: each fan, name + RPM only (no per-fan bar
      // because the group is linked — they all run the same curve).
      const members = groupFans.map((f) => `
        <li class="fans-member">
          <span class="fans-member-name" title="${escapeHtml(f.device || '')} · ${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          <span class="fans-member-rpm">${Math.round(f.value)} RPM</span>
        </li>`).join('');
      parts.push(`<li class="fans-group" data-group="${group}">
        <div class="fans-group-head">
          <span class="fans-group-label">${GROUP_LABELS[group]}</span>
          <span class="fans-group-readout">
            <span class="caret">▸</span>
            <span class="fans-group-target">${targetTxt}</span>
            <span class="fans-group-unit">%</span>
            <span class="fans-group-rpm">${groupFans.length} FAN${groupFans.length === 1 ? '' : 'S'} · AVG ${avgRpm} RPM</span>
          </span>
        </div>
        <div class="seg-bar"><div class="seg-bar-fill seg-fan${high}" style="width:${barW.toFixed(1)}%"></div></div>
        <div class="fans-group-source">${curve ? escapeHtml(tempLabel || 'curve set · driving temp not detected') : 'NO CURVE · CLICK CURVE TO CREATE'}</div>
        <ul class="fans-members">${members}</ul>
      </li>`);
    }
    listEl.innerHTML = parts.join('');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  // ── Editor open/close ────────────────────────────────────────────
  function groupFanCount(group) {
    return (_last?.fans || []).filter((f) => Number(f.value) > 0 && classifyFan(f) === group).length;
  }
  function populateSelects() {
    const temps = _last?.temps || [];
    // Group picker (CPU + Case / GPU). We always show both groups
    // even if no fans were detected in one yet — the user might be
    // designing offline, or a fan may be momentarily stopped.
    fanSelect.innerHTML = GROUPS.map((g) => {
      const n = groupFanCount(g);
      return `<option value="${g}">${GROUP_LABELS[g]}${n ? ' · ' + n + ' fan' + (n === 1 ? '' : 's') : ' · 0 active'}</option>`;
    }).join('');
    if (!temps.length) {
      tempSelect.innerHTML = `<option value="">(no temp sensors detected)</option>`;
    } else {
      tempSelect.innerHTML = temps.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.device || '')} · ${escapeHtml(t.name)}</option>`).join('');
    }
    fanSelect.value = _editorGroup;
    syncFromCurve();
  }
  function syncFromCurve() {
    const saved = _curves[_editorGroup];
    _editorPoints = saved ? saved.points.slice() : DEFAULT_POINTS.slice();
    if (saved?.sourceTempId) {
      tempSelect.value = saved.sourceTempId;
    } else {
      // Group-appropriate default temp source:
      //   cpu group → first option containing "CPU"
      //   gpu group → first option containing "GPU"
      // Both fall back to the first temp sensor in the list.
      const opts = Array.from(tempSelect.options);
      const want = _editorGroup === 'gpu' ? /gpu/i : /cpu/i;
      const pick = opts.find((o) => want.test(o.textContent));
      tempSelect.value = (pick || opts[0])?.value || '';
    }
    paintCurve();
    setEditorStatus('', false);
  }
  function setEditorStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isErr);
  }
  function openEditor() {
    if (!overlay) return;
    populateSelects();
    if (!_last || _last.status !== 'connected') {
      setEditorStatus('Sensor backend not responding yet. You can design curves offline; they save once a fan is detected.', true);
    } else {
      setEditorStatus('', false);
    }
    overlay.hidden = false;
  }
  function closeEditor() {
    if (!overlay) return;
    overlay.hidden = true;
  }
  editBtn?.addEventListener('click', openEditor);
  closeBtn?.addEventListener('click', closeEditor);
  overlay?.addEventListener('click', (ev) => { if (ev.target === overlay) closeEditor(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && overlay && !overlay.hidden) closeEditor();
  });
  fanSelect?.addEventListener('change', () => {
    _editorGroup = fanSelect.value === 'gpu' ? 'gpu' : 'cpu';
    syncFromCurve();
  });
  tempSelect?.addEventListener('change', () => {
    // Just repaint the live overlay; don't reset points.
    paintLiveOverlay();
  });

  resetBtn?.addEventListener('click', () => {
    _editorPoints = DEFAULT_POINTS.slice();
    paintCurve();
    setEditorStatus('Reset to default curve (not yet saved).', false);
  });
  deleteBtn?.addEventListener('click', async () => {
    _curves[_editorGroup] = null;
    try {
      const r = await window.dash?.fansSaveCurves?.(_curves);
      if (r?.ok) setEditorStatus(`${GROUP_LABELS[_editorGroup]} curve deleted.`, false);
      else setEditorStatus('Delete failed: ' + (r?.error || 'unknown'), true);
    } catch (err) { setEditorStatus('Delete failed: ' + err.message, true); }
    renderFanList();
    syncFromCurve();
  });
  saveBtn?.addEventListener('click', async () => {
    const temp = (_last?.temps || []).find((t) => t.id === tempSelect.value);
    const fanCount = groupFanCount(_editorGroup);
    _curves[_editorGroup] = {
      sourceTempId: temp?.id || null,
      sourceTempName: temp?.name || null,
      points: _editorPoints.slice().sort((a, b) => a.temp - b.temp),
    };
    let ok = false;
    try {
      const r = await window.dash?.fansSaveCurves?.(_curves);
      if (r?.ok) {
        ok = true;
        // On the appliance the curve is pushed to the ASUS hardware;
        // report whether that took so the user knows it's live.
        const ap = r.applied;
        let msg;
        if (ap && ap.ok) {
          msg = `Saved · curve applied to hardware (${ap.applied.join(', ')}).`;
        } else if (ap && !ap.ok) {
          msg = `Saved to disk, but hardware apply failed: ${ap.error || 'unknown'}.`;
        } else {
          msg = `Saved · ${GROUP_LABELS[_editorGroup]} curve (${fanCount} fan${fanCount === 1 ? '' : 's'}).`;
        }
        setEditorStatus(msg, !!(ap && !ap.ok));
      } else {
        setEditorStatus('Save failed: ' + (r?.error || 'unknown'), true);
      }
    } catch (err) { setEditorStatus('Save failed: ' + err.message, true); }
    renderFanList();
    // Close on a clean save; on hardware-apply failure leave it open so
    // the message is readable.
    if (ok) setTimeout(closeEditor, 1400);
  });

  // ── Boot + poll loop ─────────────────────────────────────────────
  buildGrid();
  (async () => {
    try {
      const r = await window.dash?.fansLoadCurves?.();
      // Normalize: accept only the new {cpu, gpu} shape. Old per-fan
      // curve data (keyed by sensor id) is silently discarded — those
      // curves wouldn't apply correctly under the group model anyway.
      if (r?.ok && r.curves) {
        _curves = { cpu: r.curves.cpu || null, gpu: r.curves.gpu || null };
      }
    } catch {}
    renderFanList();
  })();
  async function poll() {
    try {
      const r = await window.dash?.fansPoll?.();
      _last = r || { status: 'unavailable', reason: 'no response' };
    } catch (err) {
      _last = { status: 'unavailable', reason: err.message };
    }
    // Cross-block share: refreshTemps() reads from this snapshot so
    // the main THERMAL panel can prefer LHM's accurate CPU/GPU temps
    // over the systeminformation/RAPL fallback (which has been known
    // to return broken values, e.g. -39°C from a stuck ACPI zone).
    window._lhmSnapshot = (_last && _last.status === 'connected') ? _last : null;
    renderFanList();
    if (overlay && !overlay.hidden) paintLiveOverlay();
  }
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
})();

// ── STREAM tab ───────────────────────────────────────────────────────────
// Lazy combo pane — code lives in features/stream.js, loaded on first
// open by activateLazyPane() (see the _lazyPaneImports registry).
