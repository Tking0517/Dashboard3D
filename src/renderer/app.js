import './styles.css';

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

        // 1.5 s after ONLINE, swap to the scrolling welcome ticker:
        // "GOOD MORNING · 76°F CLEAR · 02:14 PM · TUE MAY 12" looped
        // forever. Reads live weather/time/date values at the moment
        // the ticker fires. Stopped by any mode-tab click —
        // paintComboHeader sees bootStatus === 'ticker' and tears it
        // down, restoring the mode-driven subtitle.
        const TICKER_AT       = _bootEndMs + 1500;
        const TICKER_LOOP_MS  = 24000;

        setTimeout(() => {
          const h = new Date().getHours();
          const greeting = h < 12 ? 'GOOD MORNING'
                         : h < 20 ? 'GOOD AFTERNOON'
                                  : 'GOOD EVENING';
          const tempText = (document.querySelector('#weather-temp')?.textContent || '').trim();
          const condText = (document.querySelector('#weather-cond')?.textContent || '').trim();
          const tempStr  = (tempText && tempText !== '—')
            ? `${tempText}°F${(condText && condText !== '—') ? ' ' + condText : ''}`
            : '';
          const now = new Date();
          const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toUpperCase();
          const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
          const parts = [greeting];
          if (tempStr) parts.push(tempStr);
          parts.push(timeStr, dateStr);
          const tickerText = parts.join('  ·  ');

          comboCodeEl.style.transition = '';
          comboCodeEl.style.opacity    = '';
          comboCodeEl.innerHTML        = '';
          const track = document.createElement('span');
          track.className   = 'combo-ticker-track';
          track.textContent = tickerText;
          track.style.animation = `combo-ticker-scroll ${TICKER_LOOP_MS}ms linear infinite`;
          comboCodeEl.appendChild(track);
          comboPanelEl.dataset.bootStatus = 'ticker';
        }, TICKER_AT);
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
let _sfxEnabled = true;
function _sfxGetCtx() {
  if (!_sfxCtx) {
    try { _sfxCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { _sfxCtx = null; }
  }
  if (_sfxCtx?.state === 'suspended') _sfxCtx.resume?.();
  return _sfxCtx;
}
function playSfx(kind) {
  if (!_sfxEnabled) return;
  const ctx = _sfxGetCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain).connect(ctx.destination);
  switch (kind) {
    case 'click':   // generic button — quick high chirp
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(660, t + 0.04);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.stop(t + 0.07); break;
    case 'tab':     // tab / mode switch — single triangle tick
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1320, t);
      gain.gain.setValueAtTime(0.035, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.stop(t + 0.06); break;
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
  osc.start(t);
}
function setSfxEnabled(on) {
  _sfxEnabled = !!on;
  document.querySelector('#sfx-btn')?.classList.toggle('is-muted', !_sfxEnabled);
}

// Techy boot SFX — separate bank from the UI playSfx because each kind
// needs its own Web Audio node graph (noise buffers, multi-oscillator
// blends, etc.) rather than the single-osc shape playSfx uses. All
// sounds are procedurally generated so there are no audio file assets
// to ship. Routed through the same `_sfxEnabled` flag and AudioContext
// so user mute state and the audio-context resume logic still apply.
// Single multiplier applied to every boot-time sound effect. Set to 1.3
// = +30% over the original procedural levels. Centralized here so future
// volume tweaks are a one-line change instead of hunting through every
// individual oscillator's gain ramps.
const BOOT_SFX_GAIN = 1.3;
function playBootSfx(kind) {
  if (!_sfxEnabled) return;
  const ctx = _sfxGetCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  // Master gain for this sound event. Every oscillator / noise source
  // below connects through here instead of straight to ctx.destination,
  // so the BOOT_SFX_GAIN multiplier (and any future master fades) applies
  // to all of them uniformly.
  const master = ctx.createGain();
  master.gain.value = BOOT_SFX_GAIN;
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
      gain.gain.exponentialRampToValueAtTime(0.105, t + 0.08);
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
      gain.gain.setValueAtTime(0.027, t);
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
      subGain.gain.exponentialRampToValueAtTime(0.11, t + 1.2);
      subGain.gain.linearRampToValueAtTime(0.09, t + tdur * 0.85);
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
      bodyGain.gain.exponentialRampToValueAtTime(0.06, t + 1.6);
      bodyGain.gain.linearRampToValueAtTime(0.05, t + tdur * 0.85);
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
      nGain.gain.exponentialRampToValueAtTime(0.025, t + 1.4);
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
        gain.gain.setValueAtTime(0.022, t + b.off);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + b.off + 0.022);
        osc.start(t + b.off);
        osc.stop(t + b.off + 0.028);
      }
      break;
    }
    case 'boot-ready': {
      // Glass bulb pings — cascade of 5 short high-pitched sine bursts
      // with exponential decay (the "ring-out" of struck glass), each
      // paired with a slightly-detuned 2.5x partial that decays faster.
      // The 2.5x ratio is intentionally inharmonic — that's what gives
      // glass / bell sounds their distinctive non-musical shimmer, vs
      // a perfect 2x or 3x which sounds like a synth octave/fifth.
      // Pings stagger over ~0.45 s, like a chandelier of incandescent
      // bulbs popping on one after another.
      const pings = [
        { off: 0.00, freq: 2200 },
        { off: 0.10, freq: 1760 },
        { off: 0.21, freq: 2640 },
        { off: 0.31, freq: 1980 },
        { off: 0.42, freq: 2940 },
      ];
      for (const p of pings) {
        // Tiny per-ping detune so the cascade doesn't feel mechanical.
        const f = p.freq * (0.97 + Math.random() * 0.06);

        // Fundamental — sine, very fast attack, long exponential decay
        const osc1 = ctx.createOscillator();
        const g1 = ctx.createGain();
        osc1.connect(g1).connect(master);
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(f, t + p.off);
        g1.gain.setValueAtTime(0.0001, t + p.off);
        g1.gain.exponentialRampToValueAtTime(0.085, t + p.off + 0.003);
        g1.gain.exponentialRampToValueAtTime(0.0001, t + p.off + 0.5);
        osc1.start(t + p.off);
        osc1.stop(t + p.off + 0.52);

        // Inharmonic upper partial — sine at 2.51x, half the level,
        // decays faster, gives the "real glass" shimmer.
        const osc2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc2.connect(g2).connect(master);
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(f * 2.51, t + p.off);
        g2.gain.setValueAtTime(0.0001, t + p.off);
        g2.gain.exponentialRampToValueAtTime(0.035, t + p.off + 0.003);
        g2.gain.exponentialRampToValueAtTime(0.0001, t + p.off + 0.22);
        osc2.start(t + p.off);
        osc2.stop(t + p.off + 0.24);
      }
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
  // Anything that's a "destructive" surface gets the delete bleep.
  if (t.closest('.note-tab-close, [data-explore-delete], #close-btn, .chat-clear')) {
    playSfx('delete');
    return;
  }
  // Tabs / mode switches — softer tick.
  if (t.closest('.combo-mode-tab, .explore-tab, .note-tab')) {
    playSfx('tab');
    return;
  }
  // Generic buttons.
  if (t.closest('.topbar-btn, .explore-action, .panel-collapse-btn, .audio-mute-btn, .audio-gain-btn, .chat-send, .paper-tool-btn')) {
    playSfx('click');
  }
}, true);

// Alert-theme state. Declared at module top so refreshSystem / refreshTemps
// (which run synchronously during module init) can call setAlertReason
// without hitting the TDZ. The setter functions themselves are defined
// further down with the rest of the theme code.
const ALERT_REASON = Object.freeze({
  CPU_90:      'cpu-90',
  GPU_90:      'gpu-90',
  OFFLINE:     'offline',
  ERROR_SYS:   'error-sys',
  ERROR_TEMPS: 'error-temps',
  ERROR_NET:   'error-net',
});
let   _userTheme   = null;
let   _alertActive = false;
const _alertReasons = new Set();

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
    azureAutoConfig:  () => getJson('/api/azure-auto-config'),
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
setInterval(tickClock, 1000);

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
const scratchGridEl    = document.querySelector('#scratch-grid');
const scratchValueEl   = document.querySelector('#sys-scratch-value');

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

// Memory history — time-series of system memory % usage.
const MEM_HIST_LEN = 30;                              // 30 samples × 2s = 60s window
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

// Scratch-disk grid — one vertical bar per drive (built from storageInfo).
const scratchFills = [];
const scratchLabels = [];
let scratchKeys = [];

function buildScratchGrid(drives) {
  scratchGridEl.innerHTML = '';
  scratchFills.length = 0;
  scratchLabels.length = 0;
  scratchKeys = drives.map(d => d.mount);
  for (const d of drives) {
    const bar = document.createElement('div');
    bar.className = 'core-bar';
    const track = document.createElement('div');
    track.className = 'core-bar-track';
    const fill = document.createElement('div');
    fill.className = 'core-bar-fill';
    track.appendChild(fill);
    const label = document.createElement('span');
    label.className = 'core-bar-label';
    label.textContent = d.mount.replace(/:$/, '');
    bar.appendChild(track);
    bar.appendChild(label);
    scratchGridEl.appendChild(bar);
    scratchFills.push(fill);
    scratchLabels.push(label);
  }
}

function paintScratchGrid(drives) {
  // If the set of drive letters changed, rebuild
  const keys = drives.map(d => d.mount);
  const changed = keys.length !== scratchKeys.length || keys.some((k, i) => k !== scratchKeys[i]);
  if (changed) buildScratchGrid(drives);

  let totalUsed = 0, totalCap = 0;
  for (let i = 0; i < drives.length; i++) {
    const d = drives[i];
    const sized = d.total > 0;
    const pct = sized ? (d.used / d.total) * 100 : 0;
    const fill = scratchFills[i];
    if (!fill) continue;
    setMetricBar(fill, pct);
    fill.style.opacity = sized ? '' : '0.25';
    if (sized) { totalUsed += d.used; totalCap += d.total; }
  }
  if (scratchValueEl) {
    scratchValueEl.textContent = totalCap > 0
      ? `${((totalUsed / totalCap) * 100).toFixed(0)}% USED`
      : '—';
  }
}

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
        const load = deltaLoad(lastCpuTimes[i], info.cpuTimes[i]);
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
    sysCpuBarEl.style.width = `${cpuPct.toFixed(0)}%`;
    sysCpuBarEl.classList.toggle('high', cpuPct >= 85);
    sysCpuValEl.textContent = `${cpuPct.toFixed(0)}%`;
    if (zenCpuValueEl) zenCpuValueEl.textContent = `${cpuPct.toFixed(0)}%`;
    setAlertReason(ALERT_REASON.CPU_90, cpuPct >= 90);
    setAlertReason(ALERT_REASON.ERROR_SYS, false);

    const memFrac = info.usedMem / info.totalMem;
    const memPct  = memFrac * 100;
    sysMemBarEl.style.width = `${memPct.toFixed(0)}%`;
    sysMemBarEl.classList.toggle('high', memPct >= 85);
    sysMemValEl.textContent = `${fmtBytes(info.usedMem)} / ${fmtBytes(info.totalMem)}`;

    pushMemHistory(memPct);
  } catch (err) {
    sysCoresValueEl.textContent = `ERR: ${err.message}`;
    setAlertReason(ALERT_REASON.ERROR_SYS, true);
  }
}

refreshSystem();
setInterval(() => { if (!document.hidden) refreshSystem(); }, UI_REFRESH_MS);

// ── HUD: Storage ─────────────────────────────────────────────────────────────
const storageListEl   = document.querySelector('#storage-list');
const storageCountEl  = document.querySelector('#storage-count');
const storageStatusEl = document.querySelector('#storage-status');

async function refreshStorage() {
  if (!window.dash) return;
  try {
    const drives = await window.dash.storageInfo();
    if (!drives?.length) {
      storageListEl.innerHTML = '<div class="storage-empty">NO DRIVES DETECTED.</div>';
      storageCountEl.textContent = '0';
      storageStatusEl.textContent = 'OFFLINE';
      storageStatusEl.className = 'footer-readout red';
      return;
    }
    storageCountEl.textContent = String(drives.length).padStart(2, '0');
    storageListEl.innerHTML = '';
    let totalAll = 0, usedAll = 0;
    for (const d of drives) {
      const sized = d.total > 0;
      if (sized) { totalAll += d.total; usedAll += d.used; }
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
    const overallPct = totalAll > 0 ? (usedAll / totalAll) * 100 : 0;
    storageStatusEl.innerHTML = `<em>OVERALL</em> <strong class="amber">${overallPct.toFixed(0)}%</strong> <em>FREE</em> <strong class="ok">${fmtBytes(totalAll - usedAll)}</strong>`;
    storageStatusEl.className = 'footer-readout';

    paintScratchGrid(drives);
  } catch (err) {
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
const tempGpu0El      = document.querySelector('#temp-gpu0');
const tempGpu0BarEl   = document.querySelector('#temp-gpu0-bar');
const tempGpu0NameEl  = document.querySelector('#temp-gpu0-name');
const tempGpu1El      = document.querySelector('#temp-gpu1');
const tempGpu1BarEl   = document.querySelector('#temp-gpu1-bar');
const tempGpu1NameEl  = document.querySelector('#temp-gpu1-name');
const tempsTagEl      = document.querySelector('#temps-tag');
const powerCpuEl      = document.querySelector('#power-cpu');
const powerGpu0El     = document.querySelector('#power-gpu0');
const powerGpu1El     = document.querySelector('#power-gpu1');
const zenCpuTempEl    = document.querySelector('#zen-cpu-temp');

function paintPower(el, watts, isEstimate) {
  if (!el) return;
  if (!Number.isFinite(watts) || watts <= 0) {
    el.textContent = '—';
    el.classList.remove('is-estimate');
    el.title = '';
    return;
  }
  // Prefix estimates with `~` so the user can tell at a glance which
  // readout is a hardware measurement and which is a load-derived guess.
  // Hover tooltip explains the fallback so it doesn't look like a bug.
  el.textContent = isEstimate ? `~${watts.toFixed(0)}` : watts.toFixed(0);
  el.classList.toggle('is-estimate', !!isEstimate);
  el.title = isEstimate
    ? 'Estimated from CPU load — Windows RAPL energy meter is not reporting. This usually happens when Processor Performance Boost Mode is set to Disabled. Switching it to Aggressive or Efficient Aggressive restores live wattage reporting.'
    : '';
}
const thermalStatusEl = document.querySelector('#thermal-status');

const TEMP_MAX = 100; // °C — bar fill scales 0..TEMP_MAX

function paintTemp(valueEl, barEl, temp, isEstimate) {
  if (temp == null || !Number.isFinite(temp)) {
    valueEl.textContent = 'N/A';
    barEl.style.width = '0%';
    barEl.classList.remove('warn', 'high');
    valueEl.classList?.remove('is-estimate');
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
}

function paintGpuMem(rowEls, used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    rowEls.fill.style.width = '0%';
    rowEls.fill.classList.remove('high');
    rowEls.vals.textContent = 'N/A';
    return;
  }
  const pct = (used / total) * 100;
  rowEls.fill.style.width = `${pct.toFixed(0)}%`;
  rowEls.fill.classList.toggle('high', pct >= 90);
  rowEls.vals.textContent = `${fmtBytes(used)} / ${fmtBytes(total)}`;
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

function paintGpuPanel(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  if (gpuFillEls.length !== list.length) buildGpuGrid(list);
  if (gpuMemRowEls.length !== list.length) buildGpuMemList(list);
  buildZenGpuGrid(list.length);

  let totalUsed = 0, totalCap = 0;
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
  }
  if (zenGpuTempsEl) {
    zenGpuTempsEl.textContent = tempBits.length ? tempBits.join(' · ') : '—';
  }

  if (sysGpuCountEl) {
    sysGpuCountEl.textContent = list.length ? `${list.length} GPU${list.length === 1 ? '' : 'S'}` : 'NONE';
  }
  if (sysGpuMemEl) {
    sysGpuMemEl.textContent = totalCap > 0 ? `${fmtBytes(totalUsed)} / ${fmtBytes(totalCap)}` : 'N/A';
  }
}

async function refreshTemps() {
  if (!window.dash?.tempsInfo) return;
  try {
    const t = await window.dash.tempsInfo();
    paintGpuPanel(t.gpus);
    // Detect ACPI thermal-zone "stuck reading" — many Intel desktop
    // BIOSes implement MSAcpi_ThermalZoneTemperature as a literal
    // constant (the chip's TjMax minus an arbitrary delta, or just a
    // hardcoded value) instead of an actual sensor query. Symptom: the
    // number never moves regardless of CPU activity. We keep a short
    // history of recent ACPI readings; if the last 4 are all identical
    // (~40 s of zero variation at the current 10 s poll cadence), we
    // assume the sensor is broken and switch to a CPU-load-derived
    // estimate, same approach as the wattage fallback above.
    let displayTemp = t.cpu;
    let isTempEst = false;
    const isAcpiSource = Array.isArray(t.sources) && t.sources.includes('acpi:cpu');
    if (isAcpiSource && Number.isFinite(t.cpu)) {
      window._acpiTempHistory = window._acpiTempHistory || [];
      window._acpiTempHistory.push(t.cpu);
      if (window._acpiTempHistory.length > 4) window._acpiTempHistory.shift();
      const stuck = window._acpiTempHistory.length >= 4 &&
        window._acpiTempHistory.every((v) => v === window._acpiTempHistory[0]);
      if (stuck) {
        // Generic Intel-desktop curve: ~30°C idle, ~65°C at full load
        // with Turbo Boost disabled (matches a 13900KS on adequate
        // cooling; for boost-enabled / high-end systems actual temps
        // run hotter, but the estimate stays in the right ballpark).
        const load = Number.isFinite(window._lastCpuLoadFrac) ? window._lastCpuLoadFrac : 0;
        displayTemp = 30 + Math.min(1, Math.max(0, load)) * 35;
        isTempEst = true;
      }
    } else {
      // Reset history when a non-ACPI source is in play so re-entering
      // the stuck path requires a fresh streak of identical readings.
      window._acpiTempHistory = [];
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
    paintPower(powerCpuEl, displayPower, isPowerEst);
    if (zenCpuTempEl) zenCpuTempEl.textContent = Number.isFinite(t.cpu) ? `${Math.round(t.cpu)}` : '—';
    // Honest source label — reflects what probe actually succeeded
    // rather than always claiming "ACPI/SMBUS". systeminformation's
    // si.cpuTemperature() reads Intel's DTS (per-core on-die sensor)
    // where available; the native fallback reads ACPI thermal zones
    // (motherboard-level, typically 5-10°C cooler than DTS for the
    // same chip). Showing the right label means the gap between this
    // dashboard's value and a tool reading DTS isn't mysterious.
    const sourceLabel = (() => {
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

    const g0 = t.gpus?.[0];
    paintTemp(tempGpu0El, tempGpu0BarEl, g0?.temp);
    paintPower(powerGpu0El, g0?.power);
    tempGpu0NameEl.textContent = g0 ? shortGpuName(g0.name) : 'NONE';

    const g1 = t.gpus?.[1];
    paintTemp(tempGpu1El, tempGpu1BarEl, g1?.temp);
    paintPower(powerGpu1El, g1?.power);
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
    // Trigger alert if any GPU's load is at/above 90%.
    const gpuPeak = (t.gpus || []).reduce((m, g) =>
      Math.max(m, Number.isFinite(g?.load) ? g.load : 0), 0);
    setAlertReason(ALERT_REASON.GPU_90, gpuPeak >= 90);
    setAlertReason(ALERT_REASON.ERROR_TEMPS, false);
  } catch (err) {
    thermalStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    thermalStatusEl.className = 'footer-readout red';
    setAlertReason(ALERT_REASON.ERROR_TEMPS, true);
  }
}

refreshTemps();
setInterval(() => { if (!document.hidden) refreshTemps(); }, 5000);

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
function renderSpark(container, samples) {
  if (!container) return;
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
    st.peakColor = redStr;
    st.gradTheme = _themeVersion;
  }
  // Segmented LED-cell layout — same shape as the audio-in / audio-out
  // visualizers. Each bar is a stack of small horizontal "cells" with a
  // dim→bright gradient up the stack and a single-pixel gap between
  // cells. Number of segments scales with the strip height so narrow
  // panels still show 6 cells minimum.
  const segments = Math.max(6, Math.min(20, Math.floor(H / 4)));
  const segPitch = H / segments;
  const cellH    = Math.max(1, segPitch * 0.55);
  const cellGapY = segPitch - cellH;
  // Precompute per-segment colours once per draw (cheap; one fillStyle
  // string per LED row, not per bar).
  const colors = new Array(segments);
  for (let s = 0; s < segments; s++) {
    const t = s / Math.max(1, segments - 1);
    const r = Math.round(st.dim[0] * (1 - t) + st.bright[0] * t);
    const g = Math.round(st.dim[1] * (1 - t) + st.bright[1] * t);
    const b = Math.round(st.dim[2] * (1 - t) + st.bright[2] * t);
    colors[s] = `rgb(${r},${g},${b})`;
  }
  const gap = 1;
  const barW = Math.max(1, (W - gap * (view.length - 1)) / view.length);
  for (let i = 0; i < view.length; i++) {
    const pct = Math.min(100, (view[i] / max) * 100);
    const cellsLit = Math.min(segments, Math.ceil((pct / 100) * segments));
    if (cellsLit <= 0) continue;
    const x = i * (barW + gap);
    for (let s = 0; s < cellsLit; s++) {
      ctx.fillStyle = colors[s];
      const y = H - (s + 1) * segPitch + cellGapY;
      ctx.fillRect(x, y, barW, cellH);
    }
  }
  // Peak markers — one cell-height tick in --red sitting at the highest
  // recent value for each sample column.
  ctx.fillStyle = st.peakColor;
  for (let i = 0; i < view.length; i++) {
    const peakPct = Math.min(100, st.peaks[i]);
    const peakSeg = Math.min(segments, Math.ceil((peakPct / 100) * segments));
    if (peakSeg <= 0) continue;
    const x = i * (barW + gap);
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
    setAlertReason(ALERT_REASON.ERROR_NET, false);
  } catch (err) {
    netStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    netStatusEl.className = 'footer-readout red';
    setAlertReason(ALERT_REASON.ERROR_NET, true);
  }
}

// First call seeds the rate baseline; chained scheduling keeps calls serialized.
async function netLoop() {
  if (!document.hidden) await refreshNet();
  setTimeout(netLoop, UI_REFRESH_MS);
}
netLoop();

// ── HUD: Drive I/O ───────────────────────────────────────────────────────────
const diskReadEl       = document.querySelector('#disk-read');
const diskReadUnitEl   = document.querySelector('#disk-read-unit');
const diskWriteEl      = document.querySelector('#disk-write');
const diskWriteUnitEl  = document.querySelector('#disk-write-unit');
const diskXferEl       = document.querySelector('#disk-xfer');
const diskQueueEl      = document.querySelector('#disk-queue');
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

    diskXferEl.textContent     = Number.isFinite(d.transferSec) ? d.transferSec.toFixed(0) : '—';
    diskQueueEl.textContent    = Number.isFinite(d.queue) ? d.queue.toFixed(0) : '—';
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
  } catch (err) {
    diskStatusEl.textContent = `ERR: ${err.message}`.toUpperCase();
    diskStatusEl.className = 'footer-readout red';
  }
}

// Disk I/O polling — chained scheduling so the PowerShell call (which
// has ~500 ms cold start) can't overlap itself.
async function diskLoop() {
  if (!document.hidden) await refreshDisk();
  setTimeout(diskLoop, UI_REFRESH_MS);
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
const AUDIO_BAR_COUNT_NORMAL = 24;
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
const AUDIO_MIN_W = 280; // == PANEL_MIN_W
const AUDIO_MIN_H = 120; // == PANEL_MIN_H
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
// Global visualizer redraw cadence (milliseconds between sampler ticks).
// Driven by the single topbar Hz control — the per-panel ▲/▼ arrows are
// gone. Persisted under cfg.audioFrameMs. Range 5 ms (200 Hz) – 100 ms
// (10 Hz) so the topbar arrows can step in 5 Hz increments across the
// full 10-200 Hz range.
let AUDIO_FRAME_MS = 200;
const AUDIO_FRAME_MS_MIN = 5;     // 200 Hz
const AUDIO_FRAME_MS_MAX = 500;   // 2 Hz floor — 200 ms (5 Hz) is the default
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
// Step the rate by ±5 Hz. Clamped to [10, 200] Hz.
function stepHz(deltaHz) {
  const cur = Math.round(1000 / AUDIO_FRAME_MS);
  // Snap to the nearest multiple of 5 first so steps don't drift.
  const snapped = Math.round(cur / 5) * 5;
  const next = Math.max(10, Math.min(200, snapped + deltaHz));
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
    _audioColor = cs.getPropertyValue('--audio-color').trim() || '#5fa';
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
    // Segmented EQ style: each bar is a vertical stack of small horizontal
    // cells rising from a baseline near the bottom of the canvas. Below the
    // baseline a faded copy of the lowest cells reads as a glass-floor
    // reflection. A floating bright cell marks the held peak above the
    // live stack — coloured with --red for a hot magenta-ish accent.
    // Reserve a small strip on the left for the 0–100 amplitude scale so
    // the eye gets a fixed reference for what the bars are tracking. The
    // strip width scales with canvas size; on tiny panels we still leave
    // room for at least the 0/100 endpoints.
    const fontSize = Math.max(8, Math.min(11, Math.floor(H / 28)));
    // Wide enough for a 3-digit tick label ("100") in the tech-mono
    // font even on the smallest panels — was 18, which clipped "100"
    // off the left edge on narrow viz canvases.
    const scaleW   = Math.max(26, Math.min(36, Math.round(W * 0.06)));
    const stripX   = scaleW;
    const usableW  = W - scaleW;
    const gap = 1;
    const barW = Math.max(1, (usableW - gap * (barCount - 1)) / barCount);
    const baselineY = H * 0.78;          // bars rise upward from here
    const usableH   = baselineY;
    const reflectH  = H - baselineY;
    const segments  = Math.max(6, Math.min(30, Math.floor(usableH / 4)));
    const segPitch  = usableH / segments;
    const cellH     = Math.max(1, segPitch * 0.55);
    const cellGapY  = segPitch - cellH;
    const reflectSegMax = Math.max(1, Math.floor(reflectH / segPitch));

    // Two-colour lerp: bottom cells are dim audio-colour, top cells are the
    // bright audio colour. Same hue throughout the stack, just darker at
    // the floor and hotter as the bar climbs.
    const colors = new Array(segments);
    for (let s = 0; s < segments; s++) {
      const t = s / Math.max(1, segments - 1);
      const r = Math.round(_dimRgb[0] * (1 - t) + _brightRgb[0] * t);
      const g = Math.round(_dimRgb[1] * (1 - t) + _brightRgb[1] * t);
      const b = Math.round(_dimRgb[2] * (1 - t) + _brightRgb[2] * t);
      colors[s] = `rgb(${r},${g},${b})`;
    }

    for (let i = 0; i < barCount; i++) {
      const dist = barCount > 1 ? Math.abs(i / (barCount - 1) - 0.5) * 2 : 0;
      // Bell-curve falloff: bars are tallest at the centre and ease off
      // smoothly toward the edges. cos(dist*π/2) gives a clean half-
      // cosine shape; mixing it 0.3..1.0 keeps the edge bars visible
      // (~30% of centre height) rather than dropping to zero.
      const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
      const value = (displayed[i] / 100) * scale;
      const cellsLit = Math.min(segments, Math.ceil(value * segments));
      const x = stripX + i * (barW + gap);

      // Live stack — cells rise from baselineY upward.
      for (let s = 0; s < cellsLit; s++) {
        targetCtx.fillStyle = colors[s];
        const y = baselineY - (s + 1) * segPitch + cellGapY;
        targetCtx.fillRect(x, y, barW, cellH);
      }

      // Reflection — same cells mirrored under the baseline, faded to
      // a thin glass-floor look. Capped so we only draw the cells that
      // fit in the reflection band.
      const reflectN = Math.min(cellsLit, reflectSegMax);
      if (reflectN > 0) {
        targetCtx.globalAlpha = 0.22;
        for (let s = 0; s < reflectN; s++) {
          targetCtx.fillStyle = colors[s];
          const y = baselineY + s * segPitch;
          targetCtx.fillRect(x, y, barW, cellH);
        }
        targetCtx.globalAlpha = 1;
      }
    }

    // Floating peak markers — bright cell at the peaks[i] position
    // (above the live stack since peaks decay slower than the fill).
    // Coloured --red so transients pop against the audio-colour stack.
    targetCtx.fillStyle = _redColor;
    for (let i = 0; i < barCount; i++) {
      const dist = barCount > 1 ? Math.abs(i / (barCount - 1) - 0.5) * 2 : 0;
      // Same bell-curve falloff as the bar fill above — keeps the peak
      // markers in sync with the cell-stack profile they sit on top of.
      const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
      const peakValue = (peaks[i] / 100) * scale;
      const peakSeg = Math.min(segments, Math.ceil(peakValue * segments));
      if (peakSeg <= 0) continue;
      const x = stripX + i * (barW + gap);
      const y = baselineY - peakSeg * segPitch + cellGapY;
      targetCtx.fillRect(x, y, barW, cellH);
    }

    // Soft baseline glow line — sits at the join between live stack and
    // reflection so the "floor" of the EQ has a subtle horizon.
    targetCtx.fillStyle = _audioColor;
    targetCtx.globalAlpha = 0.18;
    targetCtx.fillRect(0, baselineY - 1.5, W, 3);
    targetCtx.globalAlpha = 1;

    // Side scale — 0/25/50/75/100 amplitude ticks on the left strip.
    // Tiny canvases (e.g. compact bottom panels) drop to just 0/100 so
    // the labels stay legible. Y positions are clamped so the topmost
    // label (100) doesn't get its top half clipped against the canvas
    // edge — `textBaseline: 'middle'` puts half the glyph above y, so
    // we need at least fontSize/2 of padding from y=0.
    const ticks = usableH < 90 ? [0, 100] : [0, 25, 50, 75, 100];
    targetCtx.font = `${fontSize}px var(--font-tech), 'Share Tech Mono', monospace`;
    targetCtx.fillStyle = _mutedColor;
    targetCtx.textAlign = 'right';
    targetCtx.textBaseline = 'middle';
    const padTop = Math.ceil(fontSize / 2) + 1;
    for (const v of ticks) {
      const rawY = baselineY - (v / 100) * usableH;
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
    const AUDIO_BAR_PX = 10;
    const targetBarCount = () => {
      const w = barsRowEl.clientWidth;
      if (w <= 0) return null;
      return Math.max(8, Math.min(72, Math.floor(w / AUDIO_BAR_PX)));
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

  // 4-edge resize: each edge resizes one dimension. N/S = vertical,
  // E/W = horizontal. No diagonal corner handles — keeps the click
  // targets along the visible borders.
  for (const edge of ['n', 's', 'e', 'w']) {
    const h = document.createElement('div');
    h.className = `audio-resize-handle audio-resize-${edge}`;
    gridEl?.appendChild(h);
    const grows = {
      n: edge === 'n', s: edge === 's',
      w: edge === 'w', e: edge === 'e',
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
        // Mirror the new size to the paired visualizer so the in/out grids
        // always read at identical dimensions. Position stays independent.
        const w = parseInt(gridEl.style.width,  10);
        const h = parseInt(gridEl.style.height, 10);
        if (_partner && Number.isFinite(w) && Number.isFinite(h)) _partner.setSize(w, h);
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

  // Set up partner-mirroring so resizing one visualizer also resizes the
  // other. Drag/position stays independent.
  let _partner = null;
  function setPartner(p) { _partner = p; }
  function setSize(w, h) {
    if (!gridEl || !Number.isFinite(w) || !Number.isFinite(h)) return;
    gridEl.style.width  = `${w}px`;
    gridEl.style.height = `${h}px`;
    saveGeom();
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
  return { sample, setBands, setMuted, applyMuteUi, isMuted, setAnalyserAndTrack, setLabelOnly, getLabel, applySavedGeom, applySavedGain, rebuildBars, setAdaptiveBars, setPartner, setSize, addMirror, getBarCount: () => barCount };
}

const audioInViz = createAudioVisualizer({
  gridEl:        document.querySelector('#audio-in-grid'),
  barsRowEl:     document.querySelector('#audio-in-bars-row'),
  muteBtnEl:     document.querySelector('#audio-in-mute-btn'),
  deviceNameEl:  document.querySelector('#audio-in-device-name'),
  posKey:        'audioInPos',
  // Shared size key — both visualizers read/write the same persisted size
  // so they always match across reloads, no race or post-hoc sync needed.
  sizeKey:       'audioVizSize',
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
  sizeKey:       'audioVizSize', // shared with audioInViz — see above
  mutedKey:      'audioOutMuted',
  gainKey:       'audioOutGain',
  fallbackLabel: 'SYSTEM AUDIO',
  kind:          'output',
});

// Pair the two visualizers so resizing either mirrors the other and saves
// once to the shared 'audioVizSize' key. Also handles initial alignment if
// the saved config has only one of the legacy 'audioInSize' / 'audioOutSize'
// keys still around — applySavedGeom (called from main config-load below)
// reads only audioVizSize now, so legacy keys are harmlessly orphaned.
audioInViz.setPartner(audioOutViz);
audioOutViz.setPartner(audioInViz);

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
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an  = ctx.createAnalyser();
    an.fftSize = 1024;
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
    _micCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = _micCtx.createMediaStreamSource(_micStream);
    const an  = _micCtx.createAnalyser();
    an.fftSize = 1024;
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

// ── Chat — Ollama (local) + Azure OpenAI (cloud) ────────────────────────────
const OLLAMA_URL = 'http://localhost:11434';
const AZURE_DEFAULT_API_VERSION = '2024-10-21';

const chatProviderEl  = document.querySelector('#chat-provider');
const chatModelEl     = document.querySelector('#chat-model');
const chatMessagesEl  = document.querySelector('#chat-messages');
const chatInputEl     = document.querySelector('#chat-input');
const chatSendBtn     = document.querySelector('#chat-send');
const chatClearBtn    = document.querySelector('#chat-clear');
const chatAutoBtn     = document.querySelector('#chat-auto');
const chatTagEl       = document.querySelector('#chat-tag');
const chatFooterEl    = document.querySelector('#chat-footer');
const azureConfigEl   = document.querySelector('#chat-azure-config');
const azureEndpointEl   = document.querySelector('#azure-endpoint');
const azureDeploymentEl = document.querySelector('#azure-deployment');
const azureVersionEl    = document.querySelector('#azure-version');
const azureKeyEl        = document.querySelector('#azure-key');

let chatHistory = [];          // [{ role: 'user'|'assistant', content }]
let chatBusy = false;
let chatAbort = null;
let chatProvider = 'ollama';
let azureConfigVisible = false;

function setChatStatus(text, kind) {
  if (!chatFooterEl) return;
  const cls = kind || '';
  chatFooterEl.innerHTML = `<em>STATE</em> <strong class="${cls}">${text}</strong>`;
  // Same fix as the notes footer — keep combo-footer-chat so the CSS
  // mode-based hiding still applies in non-chat combo modes.
  chatFooterEl.className = 'footer-readout combo-footer-chat';
}

function renderMessages() {
  if (!chatMessagesEl) return;
  if (!chatHistory.length) {
    chatMessagesEl.innerHTML = '<div class="chat-empty">CHAT IS EMPTY · TYPE BELOW TO START</div>';
    return;
  }
  chatMessagesEl.innerHTML = '';
  for (const msg of chatHistory) {
    const div = document.createElement('div');
    div.className = `chat-msg ${msg.role}`;
    const role = document.createElement('span');
    role.className = 'chat-msg-role';
    role.textContent = msg.role === 'user' ? '▶ YOU' : '◆ ASSISTANT';
    const content = document.createElement('div');
    content.className = 'chat-msg-content';
    content.textContent = msg.content || '…';
    div.appendChild(role);
    div.appendChild(content);
    chatMessagesEl.appendChild(div);
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function loadOllamaModels() {
  if (!chatModelEl) return;
  setChatStatus('CONNECTING…', 'amber');
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) {
      chatModelEl.innerHTML = '<option value="">— NO MODELS —</option>';
      chatTagEl.textContent = '00';
      setChatStatus('NO MODELS · OLLAMA EMPTY', 'amber');
      return;
    }
    chatModelEl.innerHTML = models
      .map(m => `<option value="${escapeText(m.name)}">${escapeText(m.name).toUpperCase()}</option>`)
      .join('');
    chatTagEl.textContent = String(models.length).padStart(2, '0');
    // Restore saved model selection if any
    const cfg = (await window.dash?.getConfig?.()) || {};
    if (cfg.chatModel && models.some(m => m.name === cfg.chatModel)) {
      chatModelEl.value = cfg.chatModel;
    }
    setChatStatus('READY', 'ok');
  } catch (err) {
    // Ollama isn't running locally — not a system-level offline state.
    // Keep the wording specific so the footer can't be mistaken for
    // "your machine is offline" when the chat pane isn't being used.
    chatModelEl.innerHTML = '<option value="">— OLLAMA NOT RUNNING —</option>';
    chatTagEl.textContent = '—';
    setChatStatus('OLLAMA · NOT RUNNING', '');
  }
}

function buildChatSystemPrompt() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [
    'You are a helpful assistant embedded in a desktop dashboard.',
    `Today's local date and time is ${now.toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    })} (${tz}).`,
    `ISO timestamp: ${now.toISOString()}.`,
  ];
  if (typeof activeLocation === 'object' && activeLocation?.name) {
    const region = [activeLocation.admin1, activeLocation.country].filter(Boolean).join(', ');
    lines.push(`Primary weather location: ${activeLocation.name}${region ? ', ' + region : ''}.`);
  }
  if (typeof altLocation === 'object' && altLocation?.name) {
    lines.push(`Alt zone 1: ${altLocation.name} (${altLocation.timezone}).`);
  }
  if (typeof altLocation2 === 'object' && altLocation2?.name) {
    lines.push(`Alt zone 2: ${altLocation2.name} (${altLocation2.timezone}).`);
  }
  lines.push('When the user asks about the current time, date, or weather location, use the values above directly — they are accurate.');
  return lines.join('\n');
}

async function sendChat() {
  if (chatBusy) return;
  const prompt = chatInputEl.value.trim();
  if (!prompt) return;

  chatHistory.push({ role: 'user', content: prompt });
  chatHistory.push({ role: 'assistant', content: '' });
  chatInputEl.value = '';
  chatBusy = true;
  chatSendBtn.disabled = true;
  setChatStatus('THINKING…', 'amber');
  renderMessages();

  chatAbort = new AbortController();
  try {
    const messages = [
      { role: 'system', content: buildChatSystemPrompt() },
      ...chatHistory.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
    ];
    if (chatProvider === 'azure') {
      await streamAzure(messages, chatAbort.signal);
    } else {
      await streamOllama(messages, chatAbort.signal);
    }
    setChatStatus('READY', 'ok');
  } catch (err) {
    chatHistory[chatHistory.length - 1].content += `\n[error: ${err.message}]`;
    renderMessages();
    setChatStatus(`ERROR · ${err.message}`.toUpperCase(), 'red');
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    chatAbort = null;
  }
}

// Ollama: NDJSON stream — one JSON object per line in res.body.
async function streamOllama(messages, signal) {
  const model = chatModelEl.value;
  if (!model) throw new Error('SELECT A MODEL');
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error('no stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.message?.content) {
          chatHistory[chatHistory.length - 1].content += obj.message.content;
          renderMessages();
        }
      } catch {}
    }
  }
  if (window.dash?.setConfig) window.dash.setConfig({ chatModel: model });
}

// Azure OpenAI: SSE stream — `data: {json}\n\n` events; ends with `data: [DONE]`.
async function streamAzure(messages, signal) {
  const cfg = readAzureConfig();
  if (!cfg.endpoint || !cfg.deployment || !cfg.key) {
    throw new Error('AZURE NEEDS ENDPOINT, DEPLOYMENT, KEY');
  }
  const url = `${cfg.endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(cfg.deployment)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion || AZURE_DEFAULT_API_VERSION)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': cfg.key,
    },
    body: JSON.stringify({ messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${errText.slice(0, 80)}`);
  }
  if (!res.body) throw new Error('no stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';
    for (const event of events) {
      // each event line set may have multiple `data: ...` lines or comments
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            chatHistory[chatHistory.length - 1].content += delta;
            renderMessages();
          }
        } catch {}
      }
    }
  }
}

function readAzureConfig() {
  return {
    endpoint:   (azureEndpointEl?.value   || '').trim(),
    deployment: (azureDeploymentEl?.value || '').trim(),
    key:        (azureKeyEl?.value        || '').trim(),
    apiVersion: (azureVersionEl?.value    || '').trim(),
  };
}

async function saveAzureConfig() {
  if (!window.dash?.setConfig) return;
  await window.dash.setConfig({ azure: readAzureConfig() });
}

function applyProvider(p) {
  chatProvider = p === 'azure' ? 'azure' : 'ollama';
  if (chatProviderEl) chatProviderEl.value = chatProvider;
  // Model dropdown only meaningful for Ollama; hide for Azure.
  if (chatModelEl) chatModelEl.style.display = chatProvider === 'azure' ? 'none' : '';
  // Azure config block is hidden by default; gear ⚙ toggles it.
  if (azureConfigEl) {
    azureConfigEl.hidden = !azureConfigVisible;
  }
}

chatSendBtn?.addEventListener('click', sendChat);
chatInputEl?.addEventListener('keydown', (e) => {
  // Enter to send, Shift+Enter for newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
chatClearBtn?.addEventListener('click', () => {
  if (chatAbort) chatAbort.abort();
  chatHistory = [];
  renderMessages();
  setChatStatus('CLEARED', 'ok');
});

chatProviderEl?.addEventListener('change', async () => {
  applyProvider(chatProviderEl.value);
  if (window.dash?.setConfig) await window.dash.setConfig({ chatProvider });
  if (chatProvider === 'ollama') {
    await loadOllamaModels();
  } else {
    setChatStatus(readyAzure() ? 'READY' : 'CONFIGURE AZURE', readyAzure() ? 'ok' : 'amber');
  }
});

chatAutoBtn?.addEventListener('click', async () => {
  if (!window.dash?.azureAutoConfig) {
    setChatStatus('AUTO REQUIRES APP RESTART · CLOSE EXE & RUN Dashboard.bat', 'red');
    return;
  }
  setChatStatus('AUTO-CONFIG · QUERYING az CLI…', 'amber');
  chatAutoBtn.disabled = true;
  try {
    const cfg = await window.dash.azureAutoConfig();
    if (!cfg || cfg.error) {
      setChatStatus(`AUTO FAILED · ${(cfg?.error || 'NO RESPONSE')}`.toUpperCase(), 'red');
      return;
    }
    if (azureEndpointEl)   azureEndpointEl.value   = cfg.endpoint   || '';
    if (azureDeploymentEl) azureDeploymentEl.value = cfg.deployment || '';
    if (azureVersionEl)    azureVersionEl.value    = cfg.apiVersion || '';
    if (azureKeyEl)        azureKeyEl.value        = cfg.key        || '';
    await saveAzureConfig();

    // Switch to Azure since we just configured it.
    chatProviderEl.value = 'azure';
    applyProvider('azure');
    if (window.dash?.setConfig) await window.dash.setConfig({ chatProvider: 'azure' });

    if (cfg.warning) {
      setChatStatus(`PARTIAL · ${cfg.warning}`.toUpperCase(), 'amber');
    } else {
      setChatStatus(
        `READY · ${cfg.resourceName || 'AZURE'} · ${cfg.deploymentCount} DEPLOY`.toUpperCase(),
        'ok'
      );
    }
  } catch (err) {
    setChatStatus(`AUTO FAILED · ${err.message}`.toUpperCase(), 'red');
  } finally {
    chatAutoBtn.disabled = false;
  }
});

// Save Azure fields on blur so they persist even if user doesn't switch providers.
[azureEndpointEl, azureDeploymentEl, azureVersionEl, azureKeyEl].forEach(el => {
  el?.addEventListener('change', () => saveAzureConfig());
  el?.addEventListener('blur',   () => saveAzureConfig());
});

function readyAzure() {
  const c = readAzureConfig();
  return !!(c.endpoint && c.deployment && c.key);
}

function initChat(cfg) {
  // Restore Azure config fields (so user doesn't have to retype every launch).
  if (cfg?.azure) {
    if (azureEndpointEl)   azureEndpointEl.value   = cfg.azure.endpoint   || '';
    if (azureDeploymentEl) azureDeploymentEl.value = cfg.azure.deployment || '';
    if (azureVersionEl)    azureVersionEl.value    = cfg.azure.apiVersion || '';
    if (azureKeyEl)        azureKeyEl.value        = cfg.azure.key        || '';
  }
  applyProvider(cfg?.chatProvider || 'ollama');
  if (chatProvider === 'ollama') {
    loadOllamaModels();
  } else {
    setChatStatus(readyAzure() ? 'READY' : 'CONFIGURE AZURE', readyAzure() ? 'ok' : 'amber');
    chatTagEl.textContent = readyAzure() ? 'AZ' : '!!';
  }
}

renderMessages();

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
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panel.classList.remove('is-resizing');
      const w = parseInt(panel.style.width, 10);
      const h = parseInt(panel.style.height, 10);
      const x = parseInt(panel.style.left, 10);
      const y = parseInt(panel.style.top, 10);
      const partial = {};
      if (Number.isFinite(w)) partial.width  = w;
      if (Number.isFinite(h)) partial.height = h;
      if (Number.isFinite(x)) partial.x = x;
      if (Number.isFinite(y)) partial.y = y;
      savePanelSize(key, partial);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Snap-to-grid. Returns the cell size that matches the visible
// background grid (see .bg-grid in styles.css) so dragged + resized
// panels land on the same lines the user can see. The fine grid in the
// background renders at 40px, the major every 200px, and tick dots
// every 80px — snapping at 40 puts every snap point on a visible line.
// Previously this divided the viewport width/height by 40 and used the
// resulting fractional cell, which only matched the bg-grid by luck and
// produced off-by-one drift on most resolutions.
const SNAP_CELL = 40;
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
  if (!key || !header) return;
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
      panel.style.left = `${nx}px`;
      panel.style.top  = `${ny}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      panel.classList.remove('is-dragging');
      const x = parseInt(panel.style.left, 10);
      const y = parseInt(panel.style.top,  10);
      const h = parseInt(panel.style.height, 10);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        savePanelSize(key, { x, y, height: Number.isFinite(h) ? h : undefined });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function attachResize(panel) {
  const key = panelKey(panel);
  if (!key) return;
  makeResizeHandle(panel, key, 'nw');
  makeResizeHandle(panel, key, 'ne');
  makeResizeHandle(panel, key, 'sw');
  makeResizeHandle(panel, key, 'se');
  // The productivity combo panel also gets left + right edge handles so
  // the user can grab either side and resize horizontally — the corner
  // hit boxes alone (14×14) are easy to miss next to the header chrome.
  if (panel.classList.contains('panel-combo')) {
    makeResizeHandle(panel, key, 'e');
    makeResizeHandle(panel, key, 'w');
  }
}

// Stagger the panel-pulse animation so panels don't all peak at the same time.
const _allPanels = document.querySelectorAll('.panel');
_allPanels.forEach((panel, i) => {
  attachResize(panel);
  attachDrag(panel);
  // Negative delay shifts each panel's phase forward in the 8s cycle.
  const phase = -(i * 8 / Math.max(1, _allPanels.length));
  panel.style.animationDelay = `${phase.toFixed(2)}s`;
});

// Collapse chevrons for notes + chat panels.
function attachCollapseButton(panel) {
  const key = panelKey(panel);
  const header = panel.querySelector('.panel-header');
  if (!key || !header) return;
  const btn = document.createElement('button');
  btn.className = 'panel-collapse-btn';
  btn.type = 'button';
  btn.title = 'Collapse / expand';
  btn.textContent = '▾';
  // Stop drag from kicking in when clicking the chevron in the (draggable) header.
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    panel.classList.toggle('is-collapsed');
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

  // Light focus: same geometry as screen mode, but no dim backdrop and
  // no always-on-top — the rest of the dashboard stays visible and
  // interactive. A gentler "spread out this pane" mode.
  const lightBtn = document.createElement('button');
  lightBtn.className = 'panel-collapse-btn panel-fold-btn panel-fold-btn-light';
  lightBtn.type = 'button';
  lightBtn.title = 'Light focus (no dim, not always-on-top)';
  lightBtn.textContent = '▢';

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
    const GAP = 12;
    // Preserve the user's manually-set top: if the panel has an
    // inline top set (from drag), use that. Otherwise fall back to
    // sitting just below the topbar like before. This is the
    // "make the top never move unless I move it" rule.
    let top;
    const inlineTop = parseInt(panel.style.top, 10);
    if (Number.isFinite(inlineTop)) {
      top = inlineTop;
    } else {
      const topbar = document.querySelector('.topbar-controls');
      const topbarBottom = topbar ? topbar.getBoundingClientRect().bottom : 60;
      top = Math.round(topbarBottom + GAP);
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
    panel.classList.remove('is-fold-half', 'is-fold-full', 'is-fold-screen', 'is-fold-light', 'is-collapsed');
    fullBtn.classList.toggle('is-active',   mode === 'full');
    screenBtn.classList.toggle('is-active', mode === 'screen');
    lightBtn.classList.toggle('is-active',  mode === 'light');
    document.body.classList.toggle('is-combo-fold-full',   mode === 'full' || mode === 'screen');
    document.body.classList.toggle('is-combo-fold-screen', mode === 'screen');
    document.body.classList.toggle('is-combo-fold-light',  mode === 'light');
    try { window.dash?.setAlwaysOnTop?.(mode === 'screen'); } catch {}
    panel.style.removeProperty('--fold-top');
    panel.style.removeProperty('--fold-left');
    panel.style.removeProperty('--fold-width');
    if (!mode) return;
    if (mode === 'screen') { panel.classList.add('is-fold-screen'); return; }
    if (mode === 'light')  { panel.classList.add('is-fold-light');  return; }
    // Full / collapse modes: re-measure side panels before applying
    // the class so the fold uses fresh geometry every time.
    _updateComboFoldBounds();
    if (mode === 'full')   { panel.classList.add('is-fold-full');   return; }
  }
  // Re-measure on window resize so a viewport change doesn't leave the
  // panel hanging at the old offsets (only applies while a fold is on).
  window.addEventListener('resize', () => {
    if (panel.classList.contains('is-fold-full') ||
        panel.classList.contains('is-collapsed')) {
      _updateComboFoldBounds();
    }
  });

  fullBtn.addEventListener('mousedown',   (e) => e.stopPropagation());
  screenBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  lightBtn.addEventListener('mousedown',  (e) => e.stopPropagation());
  fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-full') ? null : 'full');
  });
  screenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-screen') ? null : 'screen');
  });
  lightBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyFold(panel.classList.contains('is-fold-light') ? null : 'light');
  });

  // Group all four controls (collapse + full + screen + light) in a
  // single flex wrapper so they hug the right edge of the header
  // instead of being separated by the grid's auto columns.
  const group = document.createElement('span');
  group.className = 'panel-fold-group';
  if (collapseBtn) group.appendChild(collapseBtn);
  group.appendChild(fullBtn);
  group.appendChild(screenBtn);
  group.appendChild(lightBtn);
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
}

document.querySelectorAll('.panel-combo').forEach(attachComboFoldButtons);

// ── Combo panel (Notes / Chat mode toggle) ──────────────────────────────────
const comboPanel = document.querySelector('.panel-combo');
if (comboPanel) {
  const titleEl       = comboPanel.querySelector('#combo-title');
  const codeEl        = comboPanel.querySelector('#combo-code');
  const tagEl         = comboPanel.querySelector('#combo-tag');
  const footerLabelEl = comboPanel.querySelector('#combo-footer-label');
  const notesPane     = comboPanel.querySelector('.combo-pane-notes');
  const chatPane      = comboPanel.querySelector('.combo-pane-chat');
  const notesTabCount = document.getElementById('notes-tab-count');
  const chatTagSrc    = document.getElementById('chat-tag');

  const paperPane    = comboPanel.querySelector('.combo-pane-paper');
  const paperStatsEl = document.getElementById('paper-stats');
  const explorePane     = comboPanel.querySelector('.combo-pane-explore');
  const visualizerPane  = comboPanel.querySelector('.combo-pane-visualizer');
  const browserPane     = comboPanel.querySelector('.combo-pane-browser');
  const tasksPane       = comboPanel.querySelector('.combo-pane-tasks');
  const musicPane       = comboPanel.querySelector('.combo-pane-music');
  const generatePane    = comboPanel.querySelector('.combo-pane-generate');

  function paintComboHeader() {
    // Bail while the OFFLINE → STANDBY → ONLINE state machine is using
    // the header chrome; it'll transition us into ticker mode itself.
    if (comboPanel.dataset.bootStatus === '1') return;
    // If the infinite welcome ticker is running, this call (typically
    // from a mode-tab click) is the user's signal to dismiss it — tear
    // down the ticker DOM, restore combo-tag visibility, clear inline
    // styles, then fall through to the normal mode-driven paint.
    if (comboPanel.dataset.bootStatus === 'ticker') {
      delete comboPanel.dataset.bootStatus;
      codeEl.innerHTML = '';
      codeEl.style.width = '';
      if (tagEl) tagEl.style.opacity = '';
    }
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
    } else if (mode === 'browser') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>B1</em>';
      codeEl.textContent = 'BROWSER · PRIVATE';
      tagEl.textContent = _browserState?.tabs?.length ? `${_browserState.tabs.length} TAB${_browserState.tabs.length === 1 ? '' : 'S'}` : '—';
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
    } else if (mode === 'generate') {
      titleEl.innerHTML = 'PRODUCTIVITY <em>G1</em>';
      codeEl.textContent = 'GENERATE · COMFYUI';
      tagEl.textContent = window._genState?.workflowName || 'IDLE';
      footerLabelEl.textContent = 'GENERATE STATUS';
    } else {
      titleEl.innerHTML = 'PRODUCTIVITY <em>X1</em>';
      const provider = document.getElementById('chat-provider')?.value;
      codeEl.textContent = `CHAT · ${provider === 'azure' ? 'AZURE' : 'OLLAMA'}`;
      tagEl.textContent = chatTagSrc?.textContent || '—';
      footerLabelEl.textContent = 'CHAT STATUS';
    }
  }

  function setComboMode(mode, persist = true) {
    const VALID = new Set(['notes', 'chat', 'paper', 'explore', 'visualizer', 'browser', 'tasks', 'music', 'generate']);
    if (!VALID.has(mode)) mode = 'notes';
    comboPanel.dataset.mode = mode;
    notesPane     ?.classList.toggle('is-visible', mode === 'notes');
    chatPane      ?.classList.toggle('is-visible', mode === 'chat');
    paperPane     ?.classList.toggle('is-visible', mode === 'paper');
    explorePane   ?.classList.toggle('is-visible', mode === 'explore');
    visualizerPane?.classList.toggle('is-visible', mode === 'visualizer');
    browserPane   ?.classList.toggle('is-visible', mode === 'browser');
    tasksPane     ?.classList.toggle('is-visible', mode === 'tasks');
    musicPane     ?.classList.toggle('is-visible', mode === 'music');
    // Music meter visibility — drives whether the rAF redraw chain runs
    // (see _bgmDrawMeter + window._bgmMaybeStartMeter in the music init
    // block). When music tab isn't visible we skip canvas work entirely;
    // music itself keeps playing through the BGM audio graph.
    window._isMusicTabVisible = (mode === 'music');
    if (window._isMusicTabVisible) {
      try { window._bgmMaybeStartMeter?.(); } catch {}
    }
    generatePane  ?.classList.toggle('is-visible', mode === 'generate');
    comboPanel.querySelectorAll('.combo-mode-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
    _comboInVisualizer = (mode === 'visualizer');
    paintComboHeader();
    if (mode === 'explore')    refreshExplore();
    if (mode === 'visualizer') refreshVisualizer();
    if (mode === 'browser')    initBrowserOnce();
    if (mode === 'tasks')      refreshTasksNow();
    // BROWSER pane tracks attach/detach state so BrowserView gets
    // detached from the host window when the user leaves the tab.
    if (window._browserState) {
      const wasBrowser = window._browserState.inBrowserMode;
      window._browserState.inBrowserMode = (mode === 'browser');
      if (mode === 'browser') {
        try { window._browserApplyStageMode?.(); } catch {}
      } else if (wasBrowser) {
        try { window.dash?.browserTabActivate?.(null); } catch {}
      }
    }
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
  // the underlying notes/chat code keeps writing to the original hidden IDs.
  if (notesTabCount) new MutationObserver(paintComboHeader).observe(notesTabCount, { childList: true, characterData: true, subtree: true });
  if (chatTagSrc)    new MutationObserver(paintComboHeader).observe(chatTagSrc,    { childList: true, characterData: true, subtree: true });
  if (paperStatsEl)  new MutationObserver(paintComboHeader).observe(paperStatsEl,  { childList: true, characterData: true, subtree: true });
  document.getElementById('chat-provider')?.addEventListener('change', paintComboHeader);

  // EXPLORE pane tab strip — flips the visible section between gallery
  // and docs. Persists under config.exploreTab so the same view is
  // restored next launch.
  function setExploreTab(which, persist = true) {
    if (which !== 'gallery' && which !== 'docs' && which !== 'downloads') which = 'gallery';
    if (!explorePane) return;
    explorePane.dataset.exploreTab = which;
    explorePane.querySelectorAll('.explore-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.exploreTabBtn === which);
    });
    if (persist && window.dash?.setConfig) window.dash.setConfig({ exploreTab: which });
  }
  explorePane?.querySelectorAll('.explore-tab').forEach((btn) => {
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    btn.addEventListener('click', () => setExploreTab(btn.dataset.exploreTabBtn));
  });

  // EXPLORE pane — in-panel mini-Explorer for the gallery + docs roots.
  // Each section tracks its own current subdir + selected row. Click a
  // row to select; double-click a folder to navigate into it; double-click
  // a file to open in the OS default app. F2 renames, Del → trash. The
  // ＋ button creates a folder in the current view; ↑ goes up one level.
  const exploreGalleryListEl   = document.getElementById('explore-gallery-list');
  const exploreDocsListEl      = document.getElementById('explore-docs-list');
  const exploreDownloadsListEl = document.getElementById('explore-downloads-list');
  const exploreGalleryPathEl   = document.getElementById('explore-gallery-path');
  const exploreDocsPathEl      = document.getElementById('explore-docs-path');
  const exploreDownloadsPathEl = document.getElementById('explore-downloads-path');
  // Per-section lookups — adding a new managed root (downloads/) only
  // needs entries here plus an IPC bridge in preload + main, instead of
  // updating every which==='gallery'?a:b ternary in the file.
  const _exploreListEls = {
    gallery:   exploreGalleryListEl,
    docs:      exploreDocsListEl,
    downloads: exploreDownloadsListEl,
  };
  const _explorePathEls = {
    gallery:   exploreGalleryPathEl,
    docs:      exploreDocsPathEl,
    downloads: exploreDownloadsPathEl,
  };
  const _exploreSubdir   = { gallery: '', docs: '', downloads: '' };
  // Multi-select state: a Set of absolute paths per section, plus an
  // anchor row for shift-click range selection. Anchor is the row that
  // last received a non-shift click.
  const _exploreSelected = { gallery: new Set(), docs: new Set(), downloads: new Set() };
  const _exploreAnchor   = { gallery: null, docs: null, downloads: null };
  const _exploreEntries  = { gallery: [], docs: [], downloads: [] };
  const _exploreRoots    = { gallery: '',  docs: '',  downloads: '' };

  function fmtFileTime(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: '2-digit' });
  }

  // Image extensions Chromium can render via <img>. TIFF / PSD aren't in
  // the native set so they render as a styled "PSD"/"TIF" placeholder tile
  // until / unless we add a thumbnail extractor in main.
  const _IMG_RENDER_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
  const _IMG_KNOWN_RE  = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|psd|heic|heif|raw|cr2|nef|arw)$/i;
  // Video extensions. The first regex is what Chromium can play in a
  // <video> tag (H.264/AAC mp4, vp8/9/av1 webm, etc.). The second
  // catches anything we still want to keep OUT of the gallery thumb
  // view and route to the VISUALIZER tab — the player will show an
  // "unsupported codec" message when it can't decode them.
  // .mkv included so our own screen-record output (WebM bytes wrapped in
  // a .mkv extension — Chromium decodes them fine since the EBML bytes
  // are valid WebM) plays inline. Generic MKVs with non-WebM codecs
  // will fail silently and the user can fall back to the OS player.
  const _VIDEO_RENDER_RE = /\.(mp4|webm|m4v|ogv|ogg|mov|mkv)$/i;
  const _VIDEO_KNOWN_RE  = /\.(mp4|webm|m4v|ogv|ogg|mov|avi|mkv|wmv|flv|3gp|3g2|asf)$/i;

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
    // Gallery hides video files — those route to the VISUALIZER tab so
    // the thumbnail grid stays image-only. Folders and non-video files
    // pass through unchanged.
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
      // Relative-to-managed-root path for dash3d-file:// URLs — used by
      // the inline media viewer below.
      if (e.rel) row.dataset.rel = e.rel;
      row.title = e.path;
      if (isGallery) {
        const preview = document.createElement('div');
        preview.className = 'explore-thumb-preview';
        const ext = (e.name.match(/\.([^.]+)$/) || [])[1]?.toUpperCase() || '';
        if (e.isDir) {
          preview.innerHTML = '<span class="explore-thumb-icon">▣</span>';
        } else if (_IMG_RENDER_RE.test(e.name)) {
          // Real preview via the dash3d-file:// scheme (registered in
          // main). URL shape is `dash3d-file://<root>/<rel>` — `<root>`
          // is the host segment (gallery|docs) so URL parsers don't try
          // to interpret a Windows drive-letter colon as host:port.
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
          `<span class="explore-row-size">${e.isDir ? '—' : fmtBytes(e.size)}</span>` +
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

  // IPC list bridges keyed by section — add an entry per managed root.
  const _exploreListBridges = {
    gallery:   () => window.dash?.galleryList,
    docs:      () => window.dash?.docsList,
    downloads: () => window.dash?.downloadsList,
  };
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
    // Anchor stays at `fromAbs` so successive shift-clicks expand from
    // the original point, Explorer-style. Caller is responsible for not
    // moving _exploreAnchor here.
    applyExploreSelection(which);
  }
  // Ctrl+Shift-click variant: ADD the anchor→target range to the
  // existing selection instead of replacing. Matches Windows Explorer's
  // multi-range selection model (shift = replace range, ctrl+shift =
  // append range, ctrl = toggle one).
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
    // Anchor is only valid if it still exists in the current entries
    // list (after refresh / navigation the prior path may be gone).
    const anchor = _exploreAnchor[which];
    const haveAnchor = anchor
      && _exploreEntries[which].some((x) => x.path === anchor);
    // Windows-style rules: shift = replace range, ctrl+shift = add
    // range to existing, ctrl alone = toggle, plain click = select only.
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
    // Images + videos play in the inline viewer (cover overlay inside
    // the explore pane). Native <video controls> gives seek / volume /
    // fullscreen / PiP for free. Anything else (text, archives, etc.)
    // falls through to the OS default app.
    if (_IMG_RENDER_RE.test(name) || _VIDEO_RENDER_RE.test(name)) {
      _openExploreViewer(which, abs, name, rel);
    } else {
      window.dash?.shellOpenPath?.(abs).catch(() => {});
    }
  }

  // ── Inline media viewer (explore pane) ───────────────────────────
  // Used by handleExploreRowDblClick. Image or video chosen by extension.
  const exploreViewerEl       = document.getElementById('explore-viewer');
  const exploreViewerNameEl   = document.getElementById('explore-viewer-name');
  const exploreViewerImgEl    = document.getElementById('explore-viewer-img');
  const exploreViewerVidEl    = document.getElementById('explore-viewer-vid');
  const exploreViewerStageEl  = document.getElementById('explore-viewer-stage');
  const exploreViewerCloseBtn = document.getElementById('explore-viewer-close-btn');
  const exploreViewerFsBtn    = document.getElementById('explore-viewer-fs-btn');
  const exploreViewerPopoutBtn= document.getElementById('explore-viewer-popout-btn');
  let _exploreViewerCurrent = null; // { which, abs, name }
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
  // × button + Esc key close.
  exploreViewerCloseBtn?.addEventListener('click', _closeExploreViewer);
  document.addEventListener('keydown', (ev) => {
    if (!exploreViewerEl || exploreViewerEl.hidden) return;
    if (ev.key === 'Escape' && !document.fullscreenElement) {
      _closeExploreViewer();
    } else if ((ev.key === 'f' || ev.key === 'F') && !ev.metaKey && !ev.ctrlKey) {
      const tag = (ev.target && ev.target.tagName) || '';
      // Don't grab F while the user is typing in an input.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
      ev.preventDefault();
      _toggleExploreViewerFullscreen();
    }
  });
  // ⛶ fullscreen — request fullscreen on the viewer wrapper so both
  // image + video modes get edge-to-edge display. The viewer's CSS
  // hides the head row inside :fullscreen and stretches the media.
  function _toggleExploreViewerFullscreen() {
    if (!exploreViewerEl) return;
    if (document.fullscreenElement === exploreViewerEl) {
      try { document.exitFullscreen(); } catch {}
    } else {
      try { exploreViewerEl.requestFullscreen?.(); } catch {}
    }
  }
  exploreViewerFsBtn?.addEventListener('click', _toggleExploreViewerFullscreen);
  // ⇱ pop-out — falls back to the original frameless overlay window
  // (main.js: open-image-viewer) for images. For videos, hands off to
  // the OS default app since main's overlay only displays an <img>.
  exploreViewerPopoutBtn?.addEventListener('click', () => {
    const cur = _exploreViewerCurrent;
    if (!cur) return;
    if (_IMG_RENDER_RE.test(cur.name) && window.dash?.openImageViewer) {
      window.dash.openImageViewer(cur.abs).catch(() => {});
    } else {
      window.dash?.shellOpenPath?.(cur.abs).catch(() => {});
    }
  });

  // Inline new-folder row — prepends a placeholder row with an input to
  // the top of the list. Enter calls exploreMkdir; Esc / empty-blur drops
  // the row. We use this pattern instead of window.prompt() because
  // Electron's renderer returns null from prompt() by default (no host
  // dialog handler), which silently swallowed clicks before.
  function startNewFolder(which) {
    const listEl = _exploreListEls[which];
    if (!listEl) return;
    // Drop any existing placeholder so successive clicks don't stack rows.
    listEl.querySelector('.explore-row.is-creating')?.remove();
    // If the list is empty (showing "EMPTY · DROP FILES …"), clear that
    // hint while we add the input row.
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

  // Inline rename — replaces the row's name span with a text input. Enter
  // commits, Esc cancels, blur commits. Filenames with path separators
  // are rejected by main and surface as an error log.
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
    // Only react when EXPLORE is the active combo mode (so typing in the
    // chat / notes editors keeps working). Pick whichever section has a
    // non-empty selection when the event isn't otherwise scoped.
    if (comboPanel?.dataset.mode !== 'explore') return;
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
      // Spacebar — fullscreen view. One image → single-image viewer; many
      // → contact-sheet grid window. Folders / non-images are skipped.
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

  // Multi-aware delete: trash every selected entry. Uses the same
  // shell.trashItem path as the single-row delete so items are
  // recoverable from the OS Recycle Bin.
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
    if (batch.length && typeof _visualizerUndoStack !== 'undefined') {
      _visualizerUndoStack.push({ batch, at: Date.now() });
      if (typeof _refreshUndoBtn === 'function') _refreshUndoBtn();
    }
    _exploreSelected[which].clear();
    _exploreAnchor[which] = null;
    refreshExploreSection(which);
  }
  // Copy selected paths to the OS clipboard as Windows file objects so
  // they can be pasted into Explorer / Photos / etc.
  async function copySelectedAll(which) {
    const paths = [..._exploreSelected[which]];
    if (!paths.length || !window.dash?.clipboardCopyFiles) return;
    const r = await window.dash.clipboardCopyFiles(paths);
    if (!r?.ok) console.warn('[explore] copy failed:', r?.error);
  }

  // Double-click on the name span specifically to start a rename even
  // without pre-selecting (matches Explorer-on-Windows behavior).
  function handleNameDblClick(ev) {
    if (!ev.target.classList?.contains('explore-row-name')) return;
    if (!ev.altKey) return; // Alt+dbl-click renames; plain dbl-click navigates/opens
    ev.preventDefault();
    const row = ev.target.closest('.explore-row');
    startRename(row);
  }

  // Right-click context menu — COPY (CF_HDROP via PowerShell Set-Clipboard)
  // and DELETE (Recycle Bin). Floats next to the cursor; auto-dismisses on
  // any outside click or escape. If the right-clicked row isn't already in
  // the selection, switch the selection to just that row first so the
  // menu actions match the visual selection.
  let _exploreCtxMenu = null;
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
  document.addEventListener('mousedown', (ev) => {
    if (_exploreCtxMenu && !_exploreCtxMenu.contains(ev.target)) hideExploreCtxMenu();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _exploreCtxMenu) hideExploreCtxMenu();
  });

  for (const listEl of Object.values(_exploreListEls)) {
    if (!listEl) continue;
    listEl.addEventListener('click',       handleExploreRowClick);
    listEl.addEventListener('dblclick',    handleExploreRowDblClick);
    listEl.addEventListener('dblclick',    handleNameDblClick);
    listEl.addEventListener('contextmenu', handleExploreContextMenu);
  }
  document.addEventListener('keydown', handleExploreKeydown);

  function bindExploreActionButtons(attr, handler) {
    explorePane?.querySelectorAll(`[${attr}]`).forEach((btn) => {
      btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
      btn.addEventListener('click', () => handler(btn.getAttribute(attr)));
    });
  }
  bindExploreActionButtons('data-explore-refresh', (which) => refreshExploreSection(which));
  bindExploreActionButtons('data-explore-up',      (which) => navigateUp(which));
  bindExploreActionButtons('data-explore-mkdir',   (which) => startNewFolder(which));

  // Header delete button — multi-aware; trashes everything in the
  // selection set. Discoverable equivalent of the Del key.
  bindExploreActionButtons('data-explore-delete', (which) => deleteSelectedAll(which));
  // Same shape as _exploreListBridges — IPC bridges for root-path lookup.
  const _explorePathBridges = {
    gallery:   () => window.dash?.galleryPath,
    docs:      () => window.dash?.docsPath,
    downloads: () => window.dash?.downloadsPath,
  };
  bindExploreActionButtons('data-explore-open', async (which) => {
    const pathFn = _explorePathBridges[which]?.();
    const root = await pathFn?.();
    const sub = _exploreSubdir[which] || '';
    const target = sub ? `${root}\\${sub.replace(/\//g, '\\')}` : root;
    if (target) window.dash?.shellOpenPath?.(target).catch(() => {});
  });

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
  const RECROOM_ROOT_DIRS = ['recordings', 'screencap'];
  async function refreshVisualizer() {
    if (!window.dash?.galleryList) return;
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
  const _visualizerUndoStack = []; // [{batch: [{origPath, trashPath, name}], ...}, ...]
  function _refreshUndoBtn() {
    const btn = document.getElementById('visualizer-undo-btn');
    if (!btn) return;
    btn.disabled = _visualizerUndoStack.length === 0;
    btn.textContent = _visualizerUndoStack.length > 1
      ? `UNDO (${_visualizerUndoStack.length})` : 'UNDO';
  }
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
    // Editor disabled for now — diagnosing CPU spikes attributed to the
    // rec-room editor. Button stays hidden so it can't be triggered. The
    // editor pane / state / wiring all stay in place so re-enabling is a
    // one-line change here (remove the early return).
    if (!editBtn) return;
    editBtn.hidden = true;
    editBtn.disabled = true;
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
  editBtn?.addEventListener('click', () => { _openEditor(); playSfx?.('click'); });
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
    // Cap longest edge at 1600 to keep file sizes reasonable while
    // still being readable. JPEG quality 0.82 = ~150-400 KB typical.
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    _screencapCanvas.width  = Math.round(w * scale);
    _screencapCanvas.height = Math.round(h * scale);
    const ctx = _screencapCanvas.getContext('2d');
    if (!ctx) return null;
    try { ctx.drawImage(visualizerVideoEl, 0, 0, _screencapCanvas.width, _screencapCanvas.height); }
    catch { return null; }
    try { return _screencapCanvas.toDataURL('image/jpeg', 0.82); }
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
      const useGpu = !!_ffmpegInfo.hasNvenc;
      const encLabel = useGpu
        ? (_processOpts.format === 'mp4' ? 'GPU · h264_nvenc' : 'GPU · libvpx-vp9 (no GPU VP9)')
        : 'CPU · libx264';
      _setProcessStatus(`Encoding ${snaps.length} snaps · ${encLabel}…`);
      const t0 = performance.now();
      const unsub = window.dash?.onProcessSnapsProgress?.((d) => {
        _setProcessStatus(`Encoding ${d.frame}/${d.total || snaps.length} · ${d.encoder || encLabel}`);
      });
      const result = await window.dash?.processSnapsFfmpeg?.({
        paths: snaps.map((e) => e.path),
        format: _processOpts.format === 'webm' ? 'webm' : (_processOpts.format === 'mkv' ? 'mkv' : 'mp4'),
        outH,
        bitsPerSec,
        holdMs,
        useGpu,
        codec: 'h264',
        // Optional color/blur/denoise pass shared with the EDIT panel.
        // _procFilterState is hung on window by the editor block so
        // we don't have to thread it through every helper here.
        filters: window._procFilterState || undefined,
      });
      try { unsub?.(); } catch {}
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      if (result?.ok) {
        _setProcessStatus(`Saved ${result.name} (${(result.size/1024/1024).toFixed(1)} MB) · ${result.encoder || encLabel} · ${dt}s`);
        _visualizerSubdir = 'recordings';
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
      // Pop the user into recordings/ so the new file is visible.
      _visualizerSubdir = 'recordings';
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
      if (res?.ok && screenrecBtn) {
        screenrecBtn.title = `Saved ${res.name} (${(res.size/1024/1024).toFixed(1)} MB) · click to record again`;
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

  // ── BROWSER pane ─────────────────────────────────────────────
  // Lightweight private browser. Each tab is a BrowserView in main (so
  // page rendering is reliable — the <webview> tag's shadow-DOM was
  // leaking <style>/<script> source text into the page on certain sites).
  // The renderer owns the chrome (tab strip, URL bar, splash, results)
  // and IPCs to main for navigation. A tab can be in three "modes":
  //   splash  → home screen with address + search inputs + stats
  //   results → hybrid SERP (DDG + Bing + Brave + Yahoo + Google,
  //             deduped + interleaved) as a web list, image grid, or
  //             video grid depending on the kind picker
  //   page    → the BrowserView is overlaying the stage with a real page
  // The BrowserView is positioned each time the stage's bounding rect
  // changes, and detached entirely when the user leaves the BROWSER tab.
  const browserTabstripEl = document.getElementById('browser-tabstrip');
  const browserNewTabBtn  = document.getElementById('browser-newtab-btn');
  const browserBackBtn    = document.getElementById('browser-back-btn');
  const browserForwardBtn = document.getElementById('browser-forward-btn');
  const browserReloadBtn  = document.getElementById('browser-reload-btn');
  const browserHomeBtn    = document.getElementById('browser-home-btn');
  const browserUrlEl      = document.getElementById('browser-url');
  const browserBookmarkBtn= document.getElementById('browser-bookmark-btn');
  const browserReaderBtn  = document.getElementById('browser-reader-btn');
  const browserDarkBtn    = document.getElementById('browser-dark-btn');
  const browserBookmarksEl= document.getElementById('browser-bookmarks');
  const browserBookmarksEmptyEl = document.getElementById('browser-bookmarks-empty');
  const browserStageEl    = document.getElementById('browser-stage');
  const browserStatusEl   = document.getElementById('browser-status');
  const browserSplashEl   = document.getElementById('browser-splash');
  const browserSplashAddrFormEl = document.getElementById('browser-splash-address-form');
  const browserSplashAddrEl     = document.getElementById('browser-splash-address');
  const browserSplashSearchFormEl = document.getElementById('browser-splash-search-form');
  const browserSplashSearchEl     = document.getElementById('browser-splash-search');
  const browserStatAdsEl    = document.getElementById('browser-stat-ads');
  const browserStatPopupsEl = document.getElementById('browser-stat-popups');
  const browserStatImagesEl = document.getElementById('browser-stat-images');
  const browserResultsEl     = document.getElementById('browser-results');
  const browserResultsListEl = document.getElementById('browser-results-list');
  const browserResultsGridEl = document.getElementById('browser-results-grid');
  const browserResultsLabel  = document.getElementById('browser-results-label');
  const browserResultsCount  = document.getElementById('browser-results-count');
  const browserResultsEmpty  = document.getElementById('browser-results-empty');
  const browserResultsLoadMoreEl = document.getElementById('browser-results-loadmore');

  const _browserState = { tabs: [], activeId: null, inited: false,
                          adsBlocked: 0, popupsBlocked: 0, imagesBlocked: 0,
                          bookmarks: [],
                          searchKind: 'web', inBrowserMode: false,
                          readerMode: false };
  window._browserState = _browserState; // for paintComboHeader's tab count

  function _browserNormalizeUrl(input) {
    const s = (input || '').trim();
    if (!s) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    if (/^about:/i.test(s)) return s;
    if (/^[^\s/]+\.[^\s/]+/.test(s) && !/\s/.test(s)) return `https://${s}`;
    return null;
  }

  function _browserRenderSplashStats() {
    if (browserStatAdsEl)    browserStatAdsEl.textContent    = String(_browserState.adsBlocked || 0);
    if (browserStatPopupsEl) browserStatPopupsEl.textContent = String(_browserState.popupsBlocked || 0);
    if (browserStatImagesEl) browserStatImagesEl.textContent = String(_browserState.imagesBlocked || 0);
  }

  function _browserActiveTab() {
    return _browserState.tabs.find(t => t.id === _browserState.activeId) || null;
  }

  // Drive the stage's data-mode attribute. CSS uses it to show/hide the
  // splash and the results panel. When mode === 'page' both are hidden
  // and the native BrowserView shows through.
  function _browserApplyStageMode() {
    const t = _browserActiveTab();
    const mode = t ? t.mode : 'splash';
    browserStageEl.dataset.mode = mode;
    const shouldShowBv = !!(t && t.mode === 'page' && _browserState.inBrowserMode);
    // Send fresh bounds BEFORE activate, not after. Otherwise main
    // attaches the BrowserView with no bounds and Electron defaults to
    // "fill the BrowserWindow" — the embedded page paints over our
    // chrome until the debounced bounds message catches up.
    if (shouldShowBv) {
      try { window.dash?.browserTabBounds?.(_browserStageRectFraction()); } catch {}
    }
    try { window.dash?.browserTabActivate?.(shouldShowBv ? t.id : null); } catch {}
  }
  // Express the stage rect as fractions (0..1) of the dashboard viewport.
  // Wrinkle: an ancestor (.combo-body) has CSS `zoom: 1.2`, which scales
  // the stage's visual size but Chromium's getBoundingClientRect returns
  // the pre-zoom layout rect. Multiplying by the accumulated ancestor
  // zoom recovers the actual on-screen rect — without it, the BV lands
  // ~83% of the visible stage's size, leaving a black gap below/right.
  function _browserStageRectFraction() {
    let z = 1;
    for (let el = browserStageEl.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const zv = parseFloat(window.getComputedStyle(el).zoom);
      if (zv && zv !== 1) z *= zv;
    }
    const r = browserStageEl.getBoundingClientRect();
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    return {
      x: (r.left   * z) / vw,
      y: (r.top    * z) / vh,
      width:  (r.width  * z) / vw,
      height: (r.height * z) / vh,
    };
  }

  function _browserUpdateChrome() {
    const t = _browserActiveTab();
    if (!t) {
      browserUrlEl.value = '';
      browserBackBtn.disabled = true;
      browserForwardBtn.disabled = true;
      browserBookmarkBtn.classList.remove('is-bookmarked');
      browserBookmarkBtn.disabled = true;
      browserStatusEl.textContent = 'NEW TAB';
      return;
    }
    const onPage = t.mode === 'page';
    const onResults = t.mode === 'results';
    // Keep the user's typed query visible when returning to a results
    // page so they don't have to re-type to refine — falls back to the
    // page URL on 'page' and empty on 'splash'.
    if (document.activeElement !== browserUrlEl) {
      browserUrlEl.value = onPage ? (t.url || '') : (onResults ? (t.query || '') : '');
    }
    // Back / forward are driven by our per-tab nav stack now. BV history
    // is irrelevant because the stack already includes every milestone +
    // every in-page link the user clicked.
    browserBackBtn.disabled    = !_navCanBack(t);
    browserForwardBtn.disabled = !_navCanFwd(t);
    const bookmarked = onPage && (_browserState.bookmarks || []).some(b => b.url === t.url);
    browserBookmarkBtn.classList.toggle('is-bookmarked', bookmarked);
    browserBookmarkBtn.disabled = !onPage;
    browserStatusEl.textContent = t.mode === 'splash' ? 'NEW TAB'
      : t.mode === 'results' ? `RESULTS · ${t.query || ''}`
      : (t.loading ? `LOADING · ${t.url}` : (t.url || 'READY'));
    paintComboHeader();
  }

  function _browserRenderTabStrip() {
    browserTabstripEl.querySelectorAll('.browser-tab').forEach(n => n.remove());
    for (const t of _browserState.tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browser-tab' + (t.id === _browserState.activeId ? ' is-active' : '');
      btn.dataset.tabId = String(t.id);
      const titleSpan = document.createElement('span');
      titleSpan.className = 'browser-tab-title';
      titleSpan.textContent = t.title || 'NEW TAB';
      const closeBtn = document.createElement('span');
      closeBtn.className = 'browser-tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close tab';
      btn.appendChild(titleSpan);
      btn.appendChild(closeBtn);
      btn.addEventListener('click', (e) => {
        if (e.target === closeBtn) { _browserCloseTab(t.id); return; }
        _browserActivateTab(t.id);
      });
      browserTabstripEl.insertBefore(btn, browserNewTabBtn);
    }
  }

  function _browserActivateTab(id) {
    _browserState.activeId = id;
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    _browserRenderResults();
  }

  async function _browserCloseTab(id) {
    const idx = _browserState.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    try { await window.dash?.browserTabClose?.(id); } catch {}
    _browserState.tabs.splice(idx, 1);
    if (_browserState.activeId === id) {
      const next = _browserState.tabs[idx] || _browserState.tabs[idx - 1] || null;
      _browserState.activeId = next ? next.id : null;
    }
    if (!_browserState.tabs.length) await _browserNewTab();
    else _browserActivateTab(_browserState.activeId);
  }

  async function _browserNewTab(url) {
    let backendId = null;
    try {
      const res = await window.dash?.browserTabCreate?.(url || null);
      backendId = res?.id ?? null;
    } catch {}
    if (backendId == null) return null;
    const tab = {
      id: backendId,
      url: url || '',
      title: 'NEW TAB',
      loading: !!url,
      canBack: false,
      canFwd: false,
      mode: url ? 'page' : 'splash',
      query: '',
      results: null,
      page: 1,
      hasMore: true,
      // Per-tab navigation stack: { type, url?, query?, kind?, results?, page?, hasMore? }
      // Back/forward step through this — BV's own history is no longer
      // consulted (it can't represent our app-level results/splash modes).
      nav: { stack: [], idx: -1 },
    };
    _navPush(tab, url ? { type: 'page', url } : { type: 'splash' });
    _browserState.tabs.push(tab);
    _browserActivateTab(backendId);
    return tab;
  }

  // ── Per-tab nav stack ──────────────────────────────────────────
  // Entries are app-level milestones (splash / results / page). Every
  // user-initiated state change pushes; every BV did-navigate event also
  // pushes (covers in-page link clicks). Back/forward simply walk the
  // stack and re-apply each entry's UI/BV state.
  //
  // _navRestoring is the dedupe guard: when we re-navigate the BV from a
  // back/forward restore, the BV fires did-navigate; that one event must
  // NOT push a duplicate entry. We mark the expected URL here and clear
  // it once the matching event arrives.
  const _navRestoring = new Map(); // tabId -> expected url

  function _navEntryEq(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'page')    return a.url === b.url;
    if (a.type === 'results') return a.query === b.query && a.kind === b.kind;
    if (a.type === 'splash')  return true;
    return false;
  }
  function _navPush(t, entry) {
    if (!t.nav) t.nav = { stack: [], idx: -1 };
    t.nav.stack = t.nav.stack.slice(0, t.nav.idx + 1);
    const last = t.nav.stack[t.nav.idx];
    if (last && _navEntryEq(last, entry)) return;
    t.nav.stack.push(entry);
    t.nav.idx = t.nav.stack.length - 1;
  }
  function _navCanBack(t) { return !!(t?.nav && t.nav.idx > 0); }
  function _navCanFwd(t)  { return !!(t?.nav && t.nav.idx < t.nav.stack.length - 1); }
  async function _navBack(t) {
    if (!_navCanBack(t)) return;
    t.nav.idx--;
    await _navApply(t, t.nav.stack[t.nav.idx]);
  }
  async function _navFwd(t) {
    if (!_navCanFwd(t)) return;
    t.nav.idx++;
    await _navApply(t, t.nav.stack[t.nav.idx]);
  }
  async function _navApply(t, entry) {
    if (!entry) return;
    if (entry.type === 'splash') {
      t.mode = 'splash';
      t.url = '';
      t.title = 'NEW TAB';
      t.loading = false;
      t.query = '';
      t.results = null;
    } else if (entry.type === 'results') {
      t.mode = 'results';
      t.query = entry.query || '';
      t.title = `${entry.kind === 'images' ? 'IMG · ' : entry.kind === 'videos' ? 'VID · ' : ''}${entry.query || ''}`;
      t.results = entry.results || null;
      t.page = entry.page || 1;
      t.hasMore = entry.hasMore !== false;
    } else if (entry.type === 'page') {
      t.mode = 'page';
      t.url = entry.url || '';
      t.title = entry.title || entry.url || '';
      t.loading = true;
      if (entry.url) {
        _navRestoring.set(t.id, entry.url);
        try { await window.dash?.browserTabNavigate?.(t.id, entry.url); } catch {}
      }
    }
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    if (t.mode === 'results') _browserRenderResults();
  }

  async function _browserNavigateActive(url) {
    if (!url) return;
    let t = _browserActiveTab();
    if (!t) { t = await _browserNewTab(url); return; }
    t.mode = 'page';
    t.url = url;
    t.loading = true;
    // Mark the BV navigation as ours so the did-navigate echo doesn't
    // re-push, then push the milestone ourselves with proper metadata.
    _navRestoring.set(t.id, url);
    _navPush(t, { type: 'page', url });
    try { await window.dash?.browserTabNavigate?.(t.id, url); } catch {}
    _browserUpdateChrome();
    _browserApplyStageMode();
  }

  async function _browserSearchActive(query, kind) {
    const q = (query || '').trim();
    if (!q) return;
    let t = _browserActiveTab() || await _browserNewTab();
    if (!t) return;
    t.mode = 'results';
    t.query = q;
    t.title = `${kind === 'images' ? 'IMG · ' : kind === 'videos' ? 'VID · ' : ''}${q}`;
    t.page = 1;
    t.hasMore = true;
    t.results = { kind, items: [], loading: true };
    // Push milestone BEFORE the fetch so the back stack reflects intent
    // even mid-load. We update the entry's results snapshot once items
    // arrive below so a back-to-this-search restores the cached items.
    _navPush(t, { type: 'results', query: q, kind, results: t.results, page: 1, hasMore: true });
    _browserRenderTabStrip();
    _browserUpdateChrome();
    _browserApplyStageMode();
    _browserRenderResults();

    const res = await window.dash?.browserSearch?.(q, kind, 1);
    if (!res || !res.ok) {
      t.results = { kind, items: [], loading: false, error: res?.error || 'fetch failed' };
      _browserRenderResults();
      return;
    }
    // Web: main returns a { engine: rawHtml } map (DDG + Bing + Brave +
    // Yahoo + Google fanned out in parallel). We parse each engine here,
    // dedupe by canonical URL, then weave them by per-engine position
    // rank. Images & Videos: main does the vqd handshake + JSON parsing
    // and returns a ready items array.
    const items = (kind === 'images' || kind === 'videos')
      ? (Array.isArray(res.items) ? res.items : [])
      : _browserParseWebHybrid(res.html || {});
    t.results = { kind, items, loading: false, engineErrors: res.errors || {} };
    // If a fresh page-1 search returned nothing, there's no point
    // offering LOAD MORE.
    t.hasMore = items.length > 0;
    // Refresh the current milestone's snapshot so a future back-restore
    // gets the loaded items, not the in-flight placeholder.
    const cur = t.nav?.stack?.[t.nav.idx];
    if (cur && cur.type === 'results' && cur.query === q) {
      cur.results = t.results;
      cur.hasMore = t.hasMore;
    }
    _browserRenderResults();
  }

  // LOAD MORE — fetch the next page from every engine, parse + dedupe
  // against what's already shown, and append only the truly new entries.
  // When a page returns zero new hits, mark the tab as exhausted and hide
  // the button.
  async function _browserLoadMoreActive() {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'results' || !t.results || t.results.loading) return;
    if (t.hasMore === false) return;
    const nextPage = (t.page || 1) + 1;
    t.results.loading = true;
    _browserRenderResults();

    const res = await window.dash?.browserSearch?.(t.query, t.results.kind, nextPage);
    if (!res || !res.ok) {
      t.results.loading = false;
      _browserRenderResults();
      return;
    }
    const incoming = (t.results.kind === 'images' || t.results.kind === 'videos')
      ? (Array.isArray(res.items) ? res.items : [])
      : _browserParseWebHybrid(res.html || {});
    const seen = new Set(t.results.items.map((it) => _canonicalUrl(it.url) || it.image || it.thumb));
    const fresh = [];
    for (const it of incoming) {
      const key = _canonicalUrl(it.url) || it.image || it.thumb;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push(it);
    }
    t.results.items = t.results.items.concat(fresh);
    t.results.loading = false;
    t.page = nextPage;
    if (fresh.length === 0) t.hasMore = false;
    _browserRenderResults();
  }

  // Hybrid web parser — main fans out to several engines in parallel
  // and hands us back a { engineKey: rawHtml } map. We parse each with
  // engine-specific selectors, then weave them together by per-engine
  // position rank: each result's score is (idx + 0.5) / engineSize, so
  // an engine that returned 30 results spreads them evenly across the
  // 30 slots and an engine that returned 5 spreads them across the same
  // visible range. Sort by score → real mix throughout the list, no
  // "Brave block" at the bottom even when one engine returns way more
  // results than the others. Final dedupe by canonical URL collapses
  // overlap; sources chip shows every engine that surfaced it.
  function _browserParseWebHybrid(htmlByEngine) {
    const byEngine = {
      ddg:    htmlByEngine?.ddg    ? _parseDDG(htmlByEngine.ddg)       : [],
      bing:   htmlByEngine?.bing   ? _parseBing(htmlByEngine.bing)     : [],
      brave:  htmlByEngine?.brave  ? _parseBrave(htmlByEngine.brave)   : [],
      yahoo:  htmlByEngine?.yahoo  ? _parseYahoo(htmlByEngine.yahoo)   : [],
      google: htmlByEngine?.google ? _parseGoogle(htmlByEngine.google) : [],
    };
    const keys = Object.keys(byEngine);
    const annotated = [];
    for (let ki = 0; ki < keys.length; ki++) {
      const k = keys[ki];
      const list = byEngine[k];
      const len = list.length;
      if (!len) continue;
      for (let i = 0; i < len; i++) {
        annotated.push({ item: list[i], score: (i + 0.5) / len, eng: ki });
      }
    }
    // Stable score sort; ties break by engine declaration order so any
    // run of equal-score results still alternates engines.
    annotated.sort((a, b) => a.score - b.score || a.eng - b.eng);

    const seen = new Map();
    for (const { item: r } of annotated) {
      const key = _canonicalUrl(r.url);
      if (!key) continue;
      const existing = seen.get(key);
      if (existing) {
        for (const s of r.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
        if ((r.snippet || '').length > (existing.snippet || '').length) existing.snippet = r.snippet;
        if (!existing.title && r.title) existing.title = r.title;
      } else {
        seen.set(key, { ...r, sources: [...r.sources] });
      }
    }
    return Array.from(seen.values());
  }

  function _canonicalUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      let path = u.pathname.replace(/\/+$/, '');
      const params = new URLSearchParams(u.search);
      for (const p of [...params.keys()]) {
        if (/^(utm_|fbclid|gclid|msclkid|mc_eid|mc_cid|_ga|yclid|igshid|si)$/i.test(p)) params.delete(p);
      }
      const search = params.toString();
      return `${host}${path}${search ? '?' + search : ''}`;
    } catch { return null; }
  }

  function _parseDDG(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('.result')) {
        const a = el.querySelector('.result__a');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        if (href.startsWith('//')) href = 'https:' + href;
        try {
          const u = new URL(href);
          const real = u.searchParams.get('uddg');
          if (real) href = decodeURIComponent(real);
        } catch {}
        const title   = (a.textContent || '').trim();
        const snippet = (el.querySelector('.result__snippet')?.textContent || '').trim();
        const display = (el.querySelector('.result__url')?.textContent || '').trim();
        if (title && href && /^https?:\/\//.test(href)) out.push({ title, url: href, snippet, display, sources: ['ddg'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseBing(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('li.b_algo')) {
        const a = el.querySelector('h2 a');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        if (!/^https?:\/\//.test(href)) continue;
        const title = (a.textContent || '').trim();
        const snippet = (el.querySelector('.b_caption p, p')?.textContent || '').trim();
        const display = (el.querySelector('cite, .b_attribution')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: display || href, sources: ['bing'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseBrave(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      // Brave's markup varies; cover a few generations of selectors.
      const containers = doc.querySelectorAll('[data-type="web"], .snippet.fdb, .snippet[data-pos]');
      for (const el of containers) {
        const a = el.querySelector('a.h, a.heading-serpresult, a[data-testid="result-title-a"], a.title, a[href^="http"]');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        if (!/^https?:\/\//.test(href)) continue;
        const title = (
          el.querySelector('.title, .heading, h3, h4')?.textContent ||
          a.textContent ||
          ''
        ).trim();
        const snippet = (el.querySelector('.snippet-description, .desc, .snippet-content')?.textContent || '').trim();
        const display = (el.querySelector('.netloc, cite, .snippet-url')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: display || href, sources: ['brave'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseYahoo(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      for (const el of doc.querySelectorAll('div.algo, li.algo, div.algo-sr')) {
        const a = el.querySelector('h3 a, .compTitle a');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        // Yahoo wraps in r.search.yahoo.com/_ylt=…/RU=encoded-url/…/RK=…
        const ruMatch = href.match(/\/RU=([^/]+)\//);
        if (ruMatch) {
          try { href = decodeURIComponent(ruMatch[1]); } catch {}
        }
        if (!/^https?:\/\//.test(href)) continue;
        const title = (a.textContent || '').trim();
        const snippet = (el.querySelector('.compText p, .fz-ms, p')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: href, sources: ['yahoo'] });
      }
      return out;
    } catch { return []; }
  }

  function _parseGoogle(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      // Google's class names rotate every few months. Use structural
      // shape — a heading + a link to an external URL — rather than
      // brittle class hooks.
      const seenHere = new Set();
      for (const h3 of doc.querySelectorAll('h3')) {
        const a = h3.closest('a') || h3.parentElement?.querySelector('a[href]');
        if (!a) continue;
        let href = a.getAttribute('href') || '';
        if (href.startsWith('/url?')) {
          try {
            const u = new URL(href, 'https://www.google.com');
            const real = u.searchParams.get('q') || u.searchParams.get('url');
            if (real) href = real;
          } catch {}
        }
        if (!/^https?:\/\//.test(href)) continue;
        // Skip Google's own internal links.
        if (/(?:^|\.)google\.[a-z.]+$/.test(new URL(href).hostname)) continue;
        if (seenHere.has(href)) continue;
        seenHere.add(href);
        const title = (h3.textContent || '').trim();
        const container = h3.closest('div[data-hveid], div.g, div.MjjYud') || h3.parentElement;
        const snippet = (container?.querySelector('div.VwiC3b, span.aCOpRe, div[data-snc]')?.textContent || '').trim();
        if (title) out.push({ title, url: href, snippet, display: href, sources: ['google'] });
      }
      return out;
    } catch { return []; }
  }

  // (Image results are parsed in main: it does the DuckDuckGo vqd → i.js
  // JSON handshake and returns a flat items array, so the renderer does
  // not need its own image parser.)

  function _browserRenderResults() {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'results') return;
    const r = t.results || { kind: 'web', items: [] };
    const isImages = r.kind === 'images';
    const isVideos = r.kind === 'videos';
    const isGrid   = isImages || isVideos;
    browserResultsEl.classList.toggle('is-images', isImages);
    browserResultsEl.classList.toggle('is-videos', isVideos);
    browserResultsListEl.hidden = isGrid;
    browserResultsGridEl.hidden = !isGrid;
    browserResultsLabel.textContent =
      (isVideos ? 'VIDEOS · ' : isImages ? 'IMAGES · ' : 'RESULTS · ') + t.query;
    // Sync the filter-chip row so the active kind reflects the result
    // kind we're actually showing. Without this the chip can drift out
    // of step with the data when results were loaded from a saved tab
    // or via a kind-specific deep link.
    for (const b of document.querySelectorAll('.browser-results-filter')) {
      b.classList.toggle('is-active', b.dataset.kind === r.kind);
    }
    if (r.loading && r.items.length === 0) {
      // Fresh search — show "SEARCHING…" while page 1 is in flight.
      browserResultsCount.textContent = 'SEARCHING…';
      browserResultsListEl.innerHTML = '';
      browserResultsGridEl.innerHTML = '';
      browserResultsEmpty.hidden = true;
      browserResultsLoadMoreEl.hidden = true;
      return;
    }
    if (r.error && r.items.length === 0) {
      browserResultsCount.textContent = 'ERROR';
      browserResultsEmpty.hidden = false;
      browserResultsEmpty.textContent = r.error.toUpperCase();
      browserResultsListEl.innerHTML = '';
      browserResultsGridEl.innerHTML = '';
      browserResultsLoadMoreEl.hidden = true;
      return;
    }
    browserResultsCount.textContent = `${r.items.length} HIT${r.items.length === 1 ? '' : 'S'}`
      + (t.page > 1 ? ` · PAGE ${t.page}` : '');
    browserResultsEmpty.hidden = r.items.length > 0;
    if (!r.items.length) browserResultsEmpty.textContent = 'NO RESULTS';
    // LOAD MORE: hidden when empty, when last fetch returned no new
    // unique results, or while a load-more request is in flight.
    browserResultsLoadMoreEl.hidden = !r.items.length || t.hasMore === false;
    browserResultsLoadMoreEl.disabled = !!r.loading;
    browserResultsLoadMoreEl.textContent = r.loading ? 'LOADING…' : 'LOAD MORE';

    if (isGrid) {
      browserResultsGridEl.innerHTML = '';
      for (const it of r.items) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = isVideos ? 'browser-result-img browser-result-vid' : 'browser-result-img';
        cell.title = it.title ? `${it.title}\n${it.url}` : it.url;
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = it.thumb;
        img.referrerPolicy = 'no-referrer';
        cell.appendChild(img);
        if (isVideos) {
          // Play-triangle hint + duration in bottom-right; title gradient
          // overlay along the bottom edge so the source is scannable
          // without hovering.
          const play = document.createElement('span');
          play.className = 'browser-result-vid-play';
          play.textContent = '▶';
          cell.appendChild(play);
          if (it.duration) {
            const dur = document.createElement('span');
            dur.className = 'browser-result-vid-duration';
            dur.textContent = it.duration;
            cell.appendChild(dur);
          }
          if (it.title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'browser-result-vid-title';
            titleEl.textContent = it.title;
            cell.appendChild(titleEl);
          }
        }
        cell.addEventListener('click', (e) => {
          // Videos: always navigate to the source page.
          // Images: left-click → source page, shift/middle → raw image.
          let target = it.url;
          if (isImages && (e.shiftKey || e.button === 1)) target = it.image || it.url;
          _browserNavigateActive(target);
        });
        browserResultsGridEl.appendChild(cell);
      }
    } else {
      browserResultsListEl.innerHTML = '';
      for (const it of r.items) {
        const li = document.createElement('li');
        li.className = 'browser-result';
        // Title row: optional source-count chip + clickable title.
        const titleRow = document.createElement('div');
        titleRow.className = 'browser-result-titlerow';
        const sources = it.sources || [];
        if (sources.length > 0) {
          const chip = document.createElement('span');
          chip.className = 'browser-result-chip';
          chip.textContent = sources.length > 1 ? `${sources.length}×` : sources[0].toUpperCase();
          chip.title = sources.join(' · ');
          if (sources.length > 1) chip.classList.add('is-multi');
          titleRow.appendChild(chip);
        }
        const a = document.createElement('a');
        a.className = 'browser-result-title';
        a.href = '#';
        a.textContent = it.title;
        a.addEventListener('click', (ev) => { ev.preventDefault(); _browserNavigateActive(it.url); });
        titleRow.appendChild(a);
        const url = document.createElement('div');
        url.className = 'browser-result-url';
        url.textContent = it.display || it.url;
        const snip = document.createElement('div');
        snip.className = 'browser-result-snippet';
        snip.textContent = it.snippet || '';
        li.appendChild(titleRow);
        li.appendChild(url);
        if (it.snippet) li.appendChild(snip);
        browserResultsListEl.appendChild(li);
      }
    }
  }

  function _browserRenderBookmarks() {
    const list = _browserState.bookmarks || [];
    browserBookmarksEl.querySelectorAll('.browser-bookmark').forEach(n => n.remove());
    browserBookmarksEmptyEl.hidden = list.length > 0;
    for (const bm of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'browser-bookmark';
      btn.textContent = bm.title || bm.url;
      btn.title = bm.url;
      btn.addEventListener('click', () => _browserNavigateActive(bm.url));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        _browserState.bookmarks = list.filter(b => b !== bm);
        window.dash?.setConfig?.({ browserBookmarks: _browserState.bookmarks });
        _browserRenderBookmarks();
        _browserUpdateChrome();
      });
      browserBookmarksEl.appendChild(btn);
    }
  }

  function _browserGoHome() {
    const t = _browserActiveTab();
    if (!t) { _browserNewTab(); return; }
    _navPush(t, { type: 'splash' });
    _navApply(t, { type: 'splash' });
    setTimeout(() => browserSplashAddrEl?.focus(), 30);
  }

  // Geometry sync. The BrowserView lives in the main-process window
  // layer; the renderer tells main where the stage is on screen each
  // time the layout shifts. ResizeObserver covers panel-resize drags;
  // window 'resize' covers viewport / DPI changes.
  let _bvBoundsTimer = null;
  let _bvLastSent = null;
  function _browserSendBounds() {
    if (_bvBoundsTimer) return;
    _bvBoundsTimer = setTimeout(() => {
      _bvBoundsTimer = null;
      if (!_browserState.inBrowserMode) return;
      const t = _browserActiveTab();
      if (!t || t.mode !== 'page') return;
      // Dedup: the 500 ms heartbeat fires whether or not anything moved.
      // Comparing to the last-sent rect (with a half-pixel tolerance to
      // ignore subpixel jitter from layout flushes) skips the IPC ping +
      // native setBounds call when the page is just sitting still.
      const r = _browserStageRectFraction();
      if (_bvLastSent
        && Math.abs(r.x      - _bvLastSent.x)      < 0.0005
        && Math.abs(r.y      - _bvLastSent.y)      < 0.0005
        && Math.abs(r.width  - _bvLastSent.width)  < 0.0005
        && Math.abs(r.height - _bvLastSent.height) < 0.0005) {
        return;
      }
      _bvLastSent = r;
      try { window.dash?.browserTabBounds?.(r); } catch {}
    }, 16);
  }
  try {
    new ResizeObserver(_browserSendBounds).observe(browserStageEl);
  } catch {}
  // Catch the panel being dragged: drag updates panel.style.left/top
  // directly, which fires no resize event, so ResizeObserver alone
  // leaves the BrowserView stranded at its old screen coordinates.
  // Watching attribute mutations on the panel + its parent stack covers
  // drag, fold, layout-recall, and saved-layout restore.
  try {
    const mo = new MutationObserver(_browserSendBounds);
    mo.observe(comboPanel, { attributes: true, attributeFilter: ['style', 'class'] });
    if (comboPanel.parentElement) {
      mo.observe(comboPanel.parentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  } catch {}
  window.addEventListener('resize', _browserSendBounds);
  window.addEventListener('scroll', _browserSendBounds, true);
  // Also re-sync on mouseup as a belt-and-suspenders: ends a drag even if
  // the final mousemove didn't tick a mutation observer.
  window.addEventListener('mouseup', _browserSendBounds);
  // Heartbeat: re-measure every 500 ms while a page tab is showing in
  // the BROWSER pane. Cheap, and recovers from any layout shift our
  // observers happened to miss (saved-layout restores, side-arrange
  // recalcs, parent-style mutations on a non-watched ancestor, etc.).
  setInterval(() => {
    if (!_browserState.inBrowserMode) return;
    const t = _browserActiveTab();
    if (!t || t.mode !== 'page') return;
    _browserSendBounds();
  }, 500);

  // setComboMode (declared above in this same block) handles the
  // attach/detach signaling for the BrowserView by reading
  // window._browserState.inBrowserMode and calling
  // window._browserApplyStageMode / window.dash.browserTabActivate(null).
  // Expose the apply helper so the wrapper can reach it.
  window._browserApplyStageMode = _browserApplyStageMode;

  async function initBrowserOnce() {
    if (_browserState.inited) return;
    _browserState.inited = true;
    const cfg = await window.dash?.getConfig?.() || {};
    _browserState.bookmarks = Array.isArray(cfg.browserBookmarks) ? cfg.browserBookmarks : [];
    _browserState.readerMode = !!cfg.browserReaderMode;
    _browserRenderBookmarks();
    // Sync reader-mode to main so the webRequest handler matches the
    // persisted state from the moment the user enters the BROWSER pane.
    try { window.dash?.browserSetReaderMode?.(_browserState.readerMode); } catch {}
    browserReaderBtn?.classList.toggle('is-active', _browserState.readerMode);
    // Dark-mode default ON unless the user has explicitly turned it off.
    _browserState.darkMode = cfg.browserDarkMode !== false;
    try { window.dash?.browserSetDarkMode?.(_browserState.darkMode); } catch {}
    browserDarkBtn?.classList.toggle('is-active', _browserState.darkMode);
    try {
      const stats = await window.dash?.browserGetStats?.();
      if (stats && typeof stats.adsBlocked    === 'number') _browserState.adsBlocked    = stats.adsBlocked;
      if (stats && typeof stats.imagesBlocked === 'number') _browserState.imagesBlocked = stats.imagesBlocked;
    } catch {}
    _browserRenderSplashStats();
    // Lazy BrowserView allocation: we used to call _browserNewTab() here,
    // which spawned a fresh Chromium renderer process (its own GPU
    // context) at app launch even when the user was only looking at the
    // splash. Combined with the 3D scene init, audio worker, LHM probes,
    // and sensor-panel renders, that added up to the GPU spike on cold
    // start that tripped the emergency-temperature panel red. The
    // BrowserView is now created on first real navigation instead —
    // _browserSearchActive / _browserNavigateActive / + new tab.
    setTimeout(() => browserSplashAddrEl?.focus(), 50);
  }

  // Subscribe to BrowserView lifecycle events from main and reflect them
  // into our local tab state. Each event carries the backend tab id.
  try {
    window.dash?.onBrowserTabEvent?.((data) => {
      if (!data || data.id == null) return;
      const t = _browserState.tabs.find(x => x.id === data.id);
      if (!t) return;
      if (data.type === 'navigate') {
        t.url = data.url || t.url;
        t.mode = 'page';
        // Push to nav stack — unless this navigation is the BV echoing
        // a load we already pushed (back/forward restore, or a fresh
        // URL bar navigation we pushed eagerly above).
        const expecting = _navRestoring.get(t.id);
        if (expecting && (expecting === data.url || expecting === t.url)) {
          _navRestoring.delete(t.id);
        } else if (data.url) {
          _navPush(t, { type: 'page', url: data.url });
        }
        _browserUpdateChrome();
      } else if (data.type === 'title') {
        t.title = data.title || t.title;
        _browserRenderTabStrip();
        _browserUpdateChrome();
      } else if (data.type === 'loading') {
        t.loading  = !!data.loading;
        if (typeof data.canBack === 'boolean') t.canBack = data.canBack;
        if (typeof data.canFwd  === 'boolean') t.canFwd  = data.canFwd;
        _browserUpdateChrome();
      } else if (data.type === 'newwindow') {
        // Main already navigated the current view to the new URL — no
        // tab spawning here. We still tally these as "popups blocked"
        // since the page intended a separate window.
        _browserState.popupsBlocked++;
        _browserRenderSplashStats();
      } else if (data.type === 'fail') {
        // Silent; URL bar still shows last attempted address.
      }
    });
  } catch {}

  browserResultsLoadMoreEl?.addEventListener('click', () => _browserLoadMoreActive());
  browserNewTabBtn?.addEventListener('click', () => _browserNewTab());
  browserBackBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t) return;
    _navBack(t);
  });
  browserForwardBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t) return;
    _navFwd(t);
  });
  browserReloadBtn?.addEventListener('click',  () => {
    const t = _browserActiveTab();
    if (!t) return;
    if (t.mode === 'page')    window.dash?.browserTabReload?.(t.id);
    else if (t.mode === 'results' && t.query) _browserSearchActive(t.query, t.results?.kind || 'web');
  });
  browserHomeBtn?.addEventListener('click', _browserGoHome);
  // Reader mode — image blocking on/off. We persist the choice and tell
  // main to update its webRequest filter. Reload the current page so the
  // new policy actually takes effect on this view (already-loaded images
  // stay cached; blocking only applies to fresh requests).
  browserReaderBtn?.addEventListener('click', () => {
    _browserState.readerMode = !_browserState.readerMode;
    browserReaderBtn.classList.toggle('is-active', _browserState.readerMode);
    window.dash?.setConfig?.({ browserReaderMode: _browserState.readerMode });
    window.dash?.browserSetReaderMode?.(_browserState.readerMode);
    const t = _browserActiveTab();
    if (t && t.mode === 'page') {
      // Force a fresh load — plain reload() would happily serve the same
      // images from the memory cache, which means the new image-block
      // filter would never see those requests.
      try { window.dash?.browserTabReloadFresh?.(t.id); } catch {}
    }
  });
  // Dark mode — insert/remove an invert CSS overlay on every BrowserView.
  // No reload needed; main does insertCSS/removeInsertedCSS at runtime so
  // the toggle is instant.
  browserDarkBtn?.addEventListener('click', async () => {
    _browserState.darkMode = !_browserState.darkMode;
    browserDarkBtn.classList.toggle('is-active', _browserState.darkMode);
    try { await window.dash?.browserSetDarkMode?.(_browserState.darkMode); } catch {}
    playSfx?.('click');
  });
  browserUrlEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const url = _browserNormalizeUrl(browserUrlEl.value);
    if (url) { _browserNavigateActive(url); browserUrlEl.blur(); }
    else if (browserUrlEl.value.trim()) {
      _browserSearchActive(browserUrlEl.value.trim(), _browserState.searchKind);
      browserUrlEl.blur();
    }
  });
  browserUrlEl?.addEventListener('focus', () => { browserUrlEl.select(); });
  browserBookmarkBtn?.addEventListener('click', () => {
    const t = _browserActiveTab();
    if (!t || t.mode !== 'page' || !t.url) return;
    const list = _browserState.bookmarks || [];
    const existing = list.findIndex(b => b.url === t.url);
    if (existing >= 0) list.splice(existing, 1);
    else list.push({ url: t.url, title: t.title || t.url });
    _browserState.bookmarks = list;
    window.dash?.setConfig?.({ browserBookmarks: list });
    _browserRenderBookmarks();
    _browserUpdateChrome();
  });

  // ── History overlay + clear-data ─────────────────────────────────
  // History uses the same stage-overlay pattern as splash/results: set
  // browserStageEl.dataset.mode = 'history', detach the BrowserView so
  // the native paint surface clears, and the CSS reveals the HTML list.
  // Close just re-runs _browserApplyStageMode which restores the
  // active tab's actual mode + re-attaches the BV if appropriate.
  const browserHistoryBtn        = document.getElementById('browser-history-btn');
  const browserHistoryListEl     = document.getElementById('browser-history-list');
  const browserHistoryEmptyEl    = document.getElementById('browser-history-empty');
  const browserHistoryCloseBtn   = document.getElementById('browser-history-close-btn');
  const browserHistoryClearBtn   = document.getElementById('browser-history-clear-btn');
  const browserClearBtn          = document.getElementById('browser-clear-btn');

  function _fmtHistoryTime(ts) {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay
      ? time
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  }

  async function _browserRenderHistory() {
    if (!browserHistoryListEl) return;
    const entries = (await window.dash?.browserHistoryGet?.(200)) || [];
    browserHistoryListEl.innerHTML = '';
    if (browserHistoryEmptyEl) browserHistoryEmptyEl.hidden = entries.length > 0;
    for (const e of entries) {
      const li = document.createElement('li');
      const ts    = document.createElement('div'); ts.className    = 'h-ts';    ts.textContent    = _fmtHistoryTime(e.ts);
      const title = document.createElement('div'); title.className = 'h-title'; title.textContent = e.title || e.url;
      const url   = document.createElement('div'); url.className   = 'h-url';   url.textContent   = e.url;
      li.append(ts, title, url);
      li.addEventListener('click', () => {
        // Use the current tab if there is one, otherwise spawn a new one.
        const t = _browserActiveTab() || null;
        _browserCloseHistory();
        if (t) {
          window.dash?.browserTabNavigate?.(t.id, e.url);
          t.mode = 'page'; t.url = e.url;
          _browserApplyStageMode();
        } else {
          _browserNewTab(e.url);
        }
      });
      browserHistoryListEl.appendChild(li);
    }
  }

  function _browserOpenHistory() {
    if (browserStageEl.dataset.mode === 'history') return;
    browserStageEl.dataset.mode = 'history';
    // Detach every BrowserView so the HTML overlay paints (BVs are
    // native windows and otherwise render over our DOM).
    try { window.dash?.browserTabActivate?.(null); } catch {}
    _browserRenderHistory();
  }
  function _browserCloseHistory() {
    if (browserStageEl.dataset.mode !== 'history') return;
    _browserApplyStageMode();   // restores the active tab's real mode + BV
  }

  browserHistoryBtn?.addEventListener('click', _browserOpenHistory);
  browserHistoryCloseBtn?.addEventListener('click', _browserCloseHistory);
  browserHistoryClearBtn?.addEventListener('click', async () => {
    try { await window.dash?.browserHistoryClear?.(); } catch {}
    _browserRenderHistory();
    playSfx?.('confirm');
  });

  // ── Bookmarks overlay ────────────────────────────────────────────
  // The inline bookmarks bar (.browser-bookmarks below the navrow) is
  // fine for quick clicks but cramped when you have many entries —
  // overflow-x: auto means anything past the first few scrolls off
  // horizontally. The Bookmarks button on the navrow opens this full
  // overlay so every saved page is listed vertically with title, URL,
  // and a × remove button per row. Same pattern as the history overlay.
  const browserBookmarksBtn       = document.getElementById('browser-bookmarks-btn');
  const browserBookmarksListEl    = document.getElementById('browser-bookmarks-list');
  const browserBookmarksEmpty2El  = document.getElementById('browser-bookmarks-panel-empty');
  const browserBookmarksCloseBtn  = document.getElementById('browser-bookmarks-close-btn');

  function _browserRenderBookmarksOverlay() {
    if (!browserBookmarksListEl) return;
    const list = _browserState.bookmarks || [];
    browserBookmarksListEl.innerHTML = '';
    if (browserBookmarksEmpty2El) browserBookmarksEmpty2El.hidden = list.length > 0;
    for (const bm of list) {
      const li = document.createElement('li');
      const title = document.createElement('div'); title.className = 'h-title'; title.textContent = bm.title || bm.url;
      const url   = document.createElement('div'); url.className   = 'h-url';   url.textContent   = bm.url;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'h-remove';
      remove.textContent = '×';
      remove.title = 'Remove bookmark';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = (_browserState.bookmarks || []).filter(b => b !== bm);
        _browserState.bookmarks = next;
        window.dash?.setConfig?.({ browserBookmarks: next });
        _browserRenderBookmarks();
        _browserRenderBookmarksOverlay();
        _browserUpdateChrome();
        playSfx?.('click');
      });
      li.append(title, url, remove);
      li.addEventListener('click', () => {
        const t = _browserActiveTab() || null;
        _browserCloseBookmarksOverlay();
        if (t) {
          window.dash?.browserTabNavigate?.(t.id, bm.url);
          t.mode = 'page'; t.url = bm.url;
          _browserApplyStageMode();
        } else {
          _browserNewTab(bm.url);
        }
      });
      browserBookmarksListEl.appendChild(li);
    }
  }

  function _browserOpenBookmarksOverlay() {
    if (browserStageEl.dataset.mode === 'bookmarks') return;
    browserStageEl.dataset.mode = 'bookmarks';
    try { window.dash?.browserTabActivate?.(null); } catch {}
    _browserRenderBookmarksOverlay();
  }
  function _browserCloseBookmarksOverlay() {
    if (browserStageEl.dataset.mode !== 'bookmarks') return;
    _browserApplyStageMode();
  }

  browserBookmarksBtn?.addEventListener('click', _browserOpenBookmarksOverlay);
  browserBookmarksCloseBtn?.addEventListener('click', _browserCloseBookmarksOverlay);

  // ── Video scraper overlay (yt-dlp) ───────────────────────────────
  // SCRAPE button → ask main to run yt-dlp on the active tab's URL,
  // filter to videos ≥ 5 min, present a downloadable list. Same stage-
  // overlay pattern as history/bookmarks: dataset.mode = 'scrape' +
  // detach BVs so the HTML list paints over where the page was.
  const browserScrapeBtn        = document.getElementById('browser-scrape-btn');
  const browserScrapePanel      = document.getElementById('browser-scrape-panel');
  const browserScrapeListEl     = document.getElementById('browser-scrape-list');
  const browserScrapeStatusEl   = document.getElementById('browser-scrape-status');
  const browserScrapeTitleEl    = document.getElementById('browser-scrape-title');
  const browserScrapeCloseBtn   = document.getElementById('browser-scrape-close-btn');
  const browserScrapeDlAllBtn   = document.getElementById('browser-scrape-dl-all-btn');
  // downloadId → { row, fillEl, pctEl, doneEl } so onYtDownloadProgress
  // can route each progress event to the right row's bar.
  const _scrapeRowsByDl = new Map();
  // Live unsubscribe — bound once on first scrape, kept for the session.
  let _scrapeProgressUnsub = null;
  function _ensureScrapeProgressSubscribed() {
    if (_scrapeProgressUnsub || !window.dash?.onYtDownloadProgress) return;
    _scrapeProgressUnsub = window.dash.onYtDownloadProgress((p) => {
      const row = _scrapeRowsByDl.get(p?.downloadId);
      if (!row) return;
      const pct = Math.max(0, Math.min(100, p.percent || 0));
      if (row.fillEl) row.fillEl.style.width = `${pct.toFixed(1)}%`;
      if (row.pctEl)  row.pctEl.textContent  = `${pct.toFixed(0)}%`;
      if (p.done && row.doneEl) {
        row.doneEl.classList.add('is-done');
        row.doneEl.textContent = '✓';
      }
    });
  }
  function _fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${m}:${String(s).padStart(2,'0')}`;
  }
  function _setScrapeStatus(text, kind) {
    if (!browserScrapeStatusEl) return;
    browserScrapeStatusEl.textContent = text || '';
    browserScrapeStatusEl.hidden = !text;
    browserScrapeStatusEl.className = `browser-history-empty${kind ? ` is-${kind}` : ''}`;
  }
  function _renderScrapeList(items, pageTitle) {
    if (!browserScrapeListEl) return;
    browserScrapeListEl.innerHTML = '';
    _scrapeRowsByDl.clear();
    if (browserScrapeTitleEl) {
      browserScrapeTitleEl.textContent = pageTitle
        ? `VIDEOS · ${items.length}`
        : `VIDEOS FOUND · ${items.length}`;
    }
    if (browserScrapeDlAllBtn) browserScrapeDlAllBtn.hidden = items.length === 0;
    for (const v of items) {
      const li = document.createElement('li');
      li.className = 'browser-scrape-row';
      // Thumbnail (fallback to a placeholder block when missing).
      const thumb = document.createElement('div');
      thumb.className = 'browser-scrape-thumb';
      if (v.thumbnail) {
        const img = document.createElement('img');
        img.src = v.thumbnail;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        thumb.appendChild(img);
      }
      const dur = document.createElement('span');
      dur.className = 'browser-scrape-dur';
      dur.textContent = _fmtDuration(v.duration);
      thumb.appendChild(dur);

      const body = document.createElement('div');
      body.className = 'browser-scrape-body';
      const title = document.createElement('div');
      title.className = 'browser-scrape-title-row';
      title.textContent = v.title || v.url;
      const meta = document.createElement('div');
      meta.className = 'browser-scrape-meta';
      meta.textContent = v.channel || v.url;
      const progWrap = document.createElement('div');
      progWrap.className = 'browser-scrape-progress';
      const progFill = document.createElement('div');
      progFill.className = 'browser-scrape-progress-fill';
      progWrap.appendChild(progFill);
      body.append(title, meta, progWrap);

      const right = document.createElement('div');
      right.className = 'browser-scrape-actions';
      const pct = document.createElement('span');
      pct.className = 'browser-scrape-pct';
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'browser-scrape-dl';
      dl.textContent = '⇩';
      dl.title = 'Download to gallery/downloads';
      const done = document.createElement('span');
      done.className = 'browser-scrape-done';
      right.append(pct, done, dl);

      const rowRef = { fillEl: progFill, pctEl: pct, doneEl: done };
      dl.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (dl.disabled) return;
        dl.disabled = true;
        const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        _scrapeRowsByDl.set(downloadId, rowRef);
        _ensureScrapeProgressSubscribed();
        pct.textContent = '0%';
        try {
          const r = await window.dash?.ytDownload?.({ url: v.url, downloadId });
          if (r?.ok) {
            done.classList.add('is-done');
            done.textContent = '✓';
            pct.textContent = '100%';
            progFill.style.width = '100%';
          } else {
            done.classList.add('is-error');
            done.textContent = '✕';
            done.title = r?.error || 'download failed';
          }
        } catch (err) {
          done.classList.add('is-error');
          done.textContent = '✕';
          done.title = err.message || 'download failed';
        } finally {
          dl.disabled = false;
        }
      });
      li.append(thumb, body, right);
      browserScrapeListEl.appendChild(li);
    }
  }
  async function _runScrape() {
    const tab = _browserActiveTab?.() || null;
    const url = tab?.url || '';
    if (!url || !/^https?:/i.test(url)) {
      _setScrapeStatus('OPEN A WEB PAGE FIRST', 'error');
      return;
    }
    _setScrapeStatus('SCANNING… (yt-dlp may take a minute on large channels)');
    if (browserScrapeListEl) browserScrapeListEl.innerHTML = '';
    if (browserScrapeDlAllBtn) browserScrapeDlAllBtn.hidden = true;
    try {
      const r = await window.dash?.ytScrapePage?.({ url, minDurationSec: 300 });
      if (!r?.ok) {
        _setScrapeStatus(`ERROR · ${r?.error || 'unknown'}`, 'error');
        return;
      }
      if (!r.items?.length) {
        _setScrapeStatus(r.note
          ? `NO VIDEOS ≥ 5 MIN · ${r.note.slice(-160)}`
          : 'NO VIDEOS ≥ 5 MIN FOUND ON THIS PAGE', 'warn');
        return;
      }
      _setScrapeStatus('');
      _renderScrapeList(r.items, true);
    } catch (err) {
      _setScrapeStatus(`ERROR · ${err.message || err}`, 'error');
    }
  }
  function _browserOpenScrape() {
    if (browserStageEl.dataset.mode === 'scrape') return;
    browserStageEl.dataset.mode = 'scrape';
    try { window.dash?.browserTabActivate?.(null); } catch {}
    _runScrape();
  }
  function _browserCloseScrape() {
    if (browserStageEl.dataset.mode !== 'scrape') return;
    _browserApplyStageMode();
  }
  browserScrapeBtn?.addEventListener('click', _browserOpenScrape);
  browserScrapeCloseBtn?.addEventListener('click', _browserCloseScrape);
  browserScrapeDlAllBtn?.addEventListener('click', () => {
    // Fire each row's download in sequence with a small stagger so yt-dlp
    // doesn't get N parallel spawns racing for the same network.
    const buttons = browserScrapeListEl?.querySelectorAll('.browser-scrape-dl:not(:disabled)');
    if (!buttons || !buttons.length) return;
    let i = 0;
    const fire = () => {
      if (i >= buttons.length) return;
      buttons[i].click();
      i += 1;
      setTimeout(fire, 250);
    };
    fire();
  });

  // ── Browser opacity toggle (zen-mode see-through) ────────────────
  // Mirrors the YT popout's OPAQUE / SEE THRU buttons. SEE THRU drops
  // the active BV's page opacity to 0.4 + transparent BV background so
  // the zen dashboard panels render through the dimmed page. OPAQUE
  // restores the dark BV bg and pulls the injected CSS back out.
  const browserOpaqueBtn   = document.getElementById('browser-opaque-btn');
  const browserSeethruBtn  = document.getElementById('browser-seethru-btn');
  function _browserSetOpacityState(opaque) {
    browserOpaqueBtn?.classList.toggle('is-active',  opaque);
    browserSeethruBtn?.classList.toggle('is-active', !opaque);
  }
  browserOpaqueBtn?.addEventListener('click', async () => {
    try { await window.dash?.browserSetOpacity?.(1.0); } catch {}
    _browserSetOpacityState(true);
  });
  browserSeethruBtn?.addEventListener('click', async () => {
    try { await window.dash?.browserSetOpacity?.(0.4); } catch {}
    _browserSetOpacityState(false);
  });

  // Clear-data — confirm, fire IPC, refresh history overlay if open.
  // Keeps cookies + localStorage + IndexedDB on the main-side handler so
  // active sign-ins survive the wipe. Cache + history + service workers
  // + shader cache all go.
  browserClearBtn?.addEventListener('click', async () => {
    const ok = window.confirm('Clear cache and browsing history?\n\nSign-ins and saved logins will be kept.');
    if (!ok) return;
    try {
      await window.dash?.browserClearData?.();
      playSfx?.('confirm');
    } catch (err) {
      console.warn('[browser] clear-data failed:', err?.message || err);
      playSfx?.('error');
    }
    if (browserStageEl.dataset.mode === 'history') _browserRenderHistory();
  });

  // Splash forms.
  browserSplashAddrFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = _browserNormalizeUrl(browserSplashAddrEl.value);
    if (url) { _browserNavigateActive(url); browserSplashAddrEl.value = ''; }
  });
  browserSplashSearchFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = browserSplashSearchEl.value.trim();
    if (q) { _browserSearchActive(q, _browserState.searchKind); browserSplashSearchEl.value = ''; }
  });
  // Result-type filter chips (ALL · IMAGES · VIDEOS · LINKS · NEWS).
  // Live on the results header — splash always starts as 'web'. Clicking
  // a chip re-runs the active tab's query with the new kind so the user
  // can pivot from a web search into image / video results without
  // retyping. LINKS and NEWS currently fall back to 'web' on the
  // backend but ship the kind through so a future provider can pick
  // them up without renderer changes.
  for (const btn of document.querySelectorAll('.browser-results-filter')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind || 'web';
      for (const b of document.querySelectorAll('.browser-results-filter')) {
        b.classList.toggle('is-active', b === btn);
      }
      _browserState.searchKind = kind;
      const t = _browserActiveTab?.();
      if (t && t.query) {
        _browserSearchActive(t.query, kind);
      }
    });
  }

  // Live ad-block + image-block counts from main process. Throttled to
  // 4 Hz over IPC. The image counter exists so reader-mode users can
  // verify the filter is actually firing — if the number goes up after
  // toggling on, the block is working.
  try {
    window.dash?.onBrowserStats?.((data) => {
      if (data && typeof data.adsBlocked    === 'number') _browserState.adsBlocked    = data.adsBlocked;
      if (data && typeof data.imagesBlocked === 'number') _browserState.imagesBlocked = data.imagesBlocked;
      if (data && typeof data.popupsBlocked === 'number') _browserState.popupsBlocked = data.popupsBlocked;
      _browserRenderSplashStats();
    });
  } catch {}

  // Popup → new tab. Main fires this whenever a page tries to open a
  // separate window/popup (covers target=_blank, window.open, popups
  // from iframes like Google sign-in). Spawn a fresh tab in our chrome
  // and navigate it to the requested URL, so the user's current page
  // stays where it was.
  try {
    window.dash?.onBrowserNewTabRequest?.((url) => {
      if (url) _browserNewTab(url);
    });
  } catch {}


  // Restore persisted mode + explore-tab.
  (async () => {
    const cfg = await window.dash?.getConfig?.() || {};
    setExploreTab(cfg.exploreTab || 'gallery', false);
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
  '.note-tab, .chat-msg, .weather-left, .weather-right';

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
// chat messages, note tabs) and assign each a random phase.
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

  // Startup layout: every panel drag/resize already writes to
  // cfg.panelSizes via savePanelSize, so the last-session arrangement is
  // already on disk by the time we get here. Restore each panel inline
  // from that map. If cfg.panelSizes is empty (fresh install with a
  // wiped config), fall through to applySideArrange — the grid-aligned
  // baseline that seeds initial positions on first launch.
  const _savedPanelSizes = (cfg?.panelSizes && typeof cfg.panelSizes === 'object') ? cfg.panelSizes : null;
  const _hasSavedPanels = _savedPanelSizes && Object.keys(_savedPanelSizes).length > 0;
  if (_hasSavedPanels) {
    requestAnimationFrame(() => {
      for (const panel of document.querySelectorAll('.panel')) {
        const key = panelKey(panel);
        if (key && _savedPanelSizes[key]) applyPanelSize(panel, _savedPanelSizes[key]);
      }
      // Panels are positioned — recompute the combo's collapsed-mode
      // fold bounds from the live side-panel rects so a saved-collapsed
      // combo doesn't sit at the CSS fallback (480/600), which overlapped
      // the chrono panel by ~70 px on boot.
      _updateComboFoldBoundsRef?.();
      // Positions are now committed — release the boot-flicker gate so
      // panels become visible at their final coords rather than at their
      // CSS-grid positions.
      _startBootFlicker();
    });
  } else {
    requestAnimationFrame(async () => {
      await applySideArrange();
      _updateComboFoldBoundsRef?.();
      _startBootFlicker();
    });
  }

  // Theme: keep the saved slug only if it's still a known palette;
  // older configs that referenced deleted palette names fall back to
  // null and get cleared so the next launch starts clean.
  const savedTheme = cfg?.theme && THEME_SLUGS.has(cfg.theme) ? cfg.theme : null;
  setUserTheme(savedTheme);
  _themeSetPickerActive(savedTheme);
  if (cfg?.theme && !savedTheme) {
    try { window.dash?.setConfig?.({ theme: null }); } catch {}
  }
  // Restore auto-cycle state. setThemeAuto starts the 20s interval.
  if (cfg?.themeAuto) setThemeAuto(true);
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
  // Shared size: both viz read 'audioVizSize'. Legacy keys 'audioInSize' /
  // 'audioOutSize' are honored as a fallback if the user has an old config
  // — pick whichever is largest so we never shrink something the user had
  // already grown.
  const legacyInSize  = cfg?.audioInSize;
  const legacyOutSize = cfg?.audioOutSize;
  const sharedSize = cfg?.audioVizSize || (() => {
    if (!legacyInSize && !legacyOutSize) return null;
    const a = legacyInSize  || legacyOutSize;
    const b = legacyOutSize || legacyInSize;
    return {
      width:  Math.max(a.width  || 0, b.width  || 0) || undefined,
      height: Math.max(a.height || 0, b.height || 0) || undefined,
    };
  })();
  audioInViz?.applySavedGeom(cfg?.audioInPos,  sharedSize, cfg?.audioInMuted);
  audioOutViz?.applySavedGeom(cfg?.audioOutPos, sharedSize, cfg?.audioOutMuted);
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
  initChat(cfg);

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
  playSfx(_uiLocked ? 'confirm' : 'click');
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
// Same layout the dashboard ships with on first launch (panels on the
// left/right, productivity centered, audio at the bottom), recomputed
// to fit whatever window/display size the user is on right now. By
// design no panel can overlap because stackColumn floor-snaps each
// slot height to fit the column with gaps between siblings.
document.querySelector('#auto-orient-btn')?.addEventListener('click', async () => {
  try { await applySideArrange(); } catch (err) { console.warn('[auto-orient] failed:', err); }
  playSfx('confirm');
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
    if (Number.isFinite(w) && Number.isFinite(h)) partial.audioVizSize = { width: w, height: h };
  }
  const audioIn = document.querySelector('#audio-in-grid');
  if (audioIn) {
    const x = parseInt(audioIn.style.left, 10);
    const y = parseInt(audioIn.style.top,  10);
    if (Number.isFinite(x) && Number.isFinite(y)) partial.audioInPos = { x, y };
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
  // applySavedGeom restores identical dimensions on reload. audioVizSize
  // is shared across both visualizers — by convention they read at the
  // same dimensions as each other and as every other column item.
  const placeAudio = async (side, x, y, w, h) => {
    const id = side === 'in' ? 'audio-in-grid' : 'audio-out-grid';
    const posKey = side === 'in' ? 'audioInPos'  : 'audioOutPos';
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
          audioVizSize: { width: w, height: h },
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

  // Active alert reasons (cpu-90, gpu-90, offline, error-*).
  const alerts = _alertReasons.size > 0
    ? [..._alertReasons].join(' · ').toUpperCase()
    : 'NONE';

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
  _setDiagLine('alerts',  `ALERTS   ${alerts}`);
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

// Flush RAM button — calls psapi!EmptyWorkingSet on every accessible
// process via the main-process IPC. Logs the count to the console so the
// user can see how many working sets were dropped; the result is roughly
// instant on a modern CPU even with hundreds of processes.
document.querySelector('#flush-ram-btn')?.addEventListener('click', async () => {
  if (!window.dash?.flushRam) return;
  const btn = document.querySelector('#flush-ram-btn');
  btn?.classList.add('is-busy');
  try {
    const r = await window.dash.flushRam();
    if (r?.flushed != null) {
      console.log(`[flush-ram] working sets dropped on ${r.flushed} processes (${r.failed || 0} failed)`);
      playSfx('confirm');
    } else {
      console.warn('[flush-ram] failed:', r?.error);
      playSfx('error');
    }
  } catch (err) {
    console.warn('[flush-ram] error:', err.message || err);
    playSfx('error');
  } finally {
    btn?.classList.remove('is-busy');
  }
});

// Sleep button — asks main to put the PC into suspend. Main shows a
// native confirm dialog first; if the user clicks "Sleep" the OS goes
// to S3/S0ix. We click-feedback only — the resume side just sees the
// dashboard already running when the screen comes back.
document.querySelector('#sleep-btn')?.addEventListener('click', async () => {
  if (!window.dash?.systemSleep) return;
  const btn = document.querySelector('#sleep-btn');
  btn?.classList.add('is-busy');
  playSfx?.('click');
  try {
    const r = await window.dash.systemSleep();
    if (r?.ok)             { /* fire-and-forget — OS handles the rest */ }
    else if (r?.cancelled) { playSfx?.('click'); }
    else                   { console.warn('[sleep] failed:', r?.error); playSfx?.('error'); }
  } catch (err) {
    console.warn('[sleep] error:', err.message || err);
    playSfx?.('error');
  } finally {
    btn?.classList.remove('is-busy');
  }
});

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

  function frOpen() {
    frOverlayEl.hidden = false;
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

const _IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|svg)$/i;

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

  // Recurse one level deep into the gallery so subdirectories are
  // searchable too without making the picker a full file browser.
  async function listImages(subdir = '') {
    const res = await window.dash.galleryList(subdir);
    const out = [];
    for (const e of (res?.entries || [])) {
      if (e.isDir) {
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

profilePicEl?.addEventListener('click', () => {
  _picPickerOpen();
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
    // Defer one tick so the rest of the boot config has applied before
    // the overlay paints (avoids the wizard flashing over an unstyled UI).
    setTimeout(() => window._frOpenSetup(), 250);
  }
})();

// SFX toggle button — flips the global mute and persists. The document
// delegate above plays a 'click' first (still-enabled-state), then this
// handler toggles mute. On re-enable we explicitly play 'confirm' so
// there's an audible cue that sound is back on.
document.querySelector('#sfx-btn')?.addEventListener('click', async () => {
  setSfxEnabled(!_sfxEnabled);
  if (_sfxEnabled) playSfx('confirm');
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ sfxEnabled: _sfxEnabled }); } catch {}
  }
});
(async () => {
  const cfg = await window.dash?.getConfig?.() || {};
  if (cfg.sfxEnabled === false) setSfxEnabled(false);
})();

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
// Default palette + one Cyberpunk section (4 variants). Pretty labels for
// the topbar chip — the slug (data-theme value) is what gets persisted.
const THEME_LABELS = {
  '':             'DEFAULT',
  'cyber-neon':     'CYBER · NEON',
  'cyber-moody':    'CYBER · MOODY',
  'cyber-violet':   'CYBER · VIOLET',
  'cyber-dark':     'CYBER · DARK',
  'cyber-runner':   'CYBER · RUNNER',
  'cyber-2077':     'CYBER · 2077',
  'cyber-akira':    'CYBER · AKIRA',
  'cyber-synthwave':'CYBER · SYNTHWAVE',
  'pastel-bloom': 'PASTEL · BLOOM',
  'pastel-sky':   'PASTEL · SKY',
  'pastel-spring':'PASTEL · SPRING',
  'pastel-sunset':'PASTEL · SUNSET',
  'pastel-mist':  'PASTEL · MIST',
  'pastel-lilac': 'PASTEL · LILAC',
  'pastel-sorbet':'PASTEL · SORBET',
  'pastel-candy': 'PASTEL · CANDY',
  'earth-clay':    'MUTED · CLAY',
  'earth-moss':    'MUTED · MOSS',
  'earth-sand':    'MUTED · SAND',
  'earth-stone':   'MUTED · STONE',
  'earth-paper':   'MUTED · PAPER',
  'earth-eink':    'MUTED · EINK',
  'earth-sepia':   'MUTED · SEPIA',
  'earth-charcoal':'MUTED · CHARCOAL',
  'retro':         'RETRO · AMBER',
  'retro-green':   'RETRO · GREEN',
  'retro-blue':    'RETRO · BLUE',
  'retro-white':   'RETRO · WHITE',
  'retro-red':     'RETRO · RED',
  'retro-magenta': 'RETRO · MAGENTA',
  'retro-cyan':    'RETRO · CYAN',
  'retro-mint':    'RETRO · MINT',
  'retro-violet':  'RETRO · VIOLET',
  'retro-gold':    'RETRO · GOLD',
  'retro-ice':     'RETRO · ICE',
};
const THEME_SLUGS = new Set(Object.keys(THEME_LABELS).filter(Boolean));
// Cycle order — default first, then walks every section in dropdown order.
const THEME_CYCLE = ['', ...Object.keys(THEME_LABELS).filter(Boolean)];

const themeNameEl = document.querySelector('#theme-name');
function applyTheme(name) {
  if (!name) document.documentElement.removeAttribute('data-theme');
  else       document.documentElement.setAttribute('data-theme', name);
  if (themeNameEl) themeNameEl.textContent = THEME_LABELS[name || ''] || 'DEFAULT';
  _themeVersion++;
}

// ── Alert theme override ───────────────────────────────────────────────────
// When any alert reason is active (offline, sustained error, CPU/GPU 90%+),
// applyTheme is forced to 'alert' on top of whatever theme the user picked.
// _userTheme tracks the last user-chosen theme so we can restore it cleanly.
// (State vars _userTheme / _alertActive / _alertReasons are declared at the
// top of the module — see TDZ note there.)
function setUserTheme(name) {
  _userTheme = name ?? null;
  applyTheme(_alertActive ? 'alert' : _userTheme);
}
function setAlertReason(key, on) {
  if (on) _alertReasons.add(key);
  else    _alertReasons.delete(key);
  const want = _alertReasons.size > 0;
  if (want === _alertActive) return;
  _alertActive = want;
  applyTheme(_alertActive ? 'alert' : _userTheme);
}
window.addEventListener('online',  () => setAlertReason(ALERT_REASON.OFFLINE, false));
window.addEventListener('offline', () => setAlertReason(ALERT_REASON.OFFLINE, true));
// Seed the offline reason from current navigator state so a renderer that
// loads while disconnected goes straight into alert mode.
if (typeof navigator !== 'undefined' && navigator.onLine === false) {
  _alertReasons.add(ALERT_REASON.OFFLINE);
  _alertActive = true;
}

function applyInvert(on) {
  document.body.classList.toggle('theme-invert', !!on);
}

// Theme picker — a small dropdown attached to the topbar #theme-btn. Each
// .theme-menu-item carries the slug in data-theme-pick (empty string for
// the default palette). Document-level click closes the menu when the
// user clicks anywhere else.
const themePickerEl  = document.getElementById('theme-picker');
const themeTriggerEl = document.getElementById('theme-name');   // doubles as label + dropdown trigger
const themeMenuEl    = document.getElementById('theme-menu');
const themeAutoBtnEl = document.getElementById('theme-auto-btn');

function _themeSetPickerActive(name) {
  if (!themeMenuEl) return;
  const slug = name || '';
  themeMenuEl.querySelectorAll('.theme-menu-item').forEach((b) => {
    b.classList.toggle('is-active', (b.dataset.themePick || '') === slug);
  });
}

function _themeOpenMenu(open) {
  if (!themeMenuEl || !themeTriggerEl) return;
  themeMenuEl.hidden = !open;
  themeTriggerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}

themeTriggerEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  _themeOpenMenu(themeMenuEl?.hidden);
  playSfx?.('click');
});

// Cycle button — next theme in THEME_CYCLE, persists. Wraps at end.
async function advanceTheme(step = 1) {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const cur = cfg.theme && THEME_SLUGS.has(cfg.theme) ? cfg.theme : '';
  const idx = THEME_CYCLE.indexOf(cur);
  const len = THEME_CYCLE.length;
  const next = THEME_CYCLE[((idx + step) % len + len) % len];
  const slug = next || null;
  setUserTheme(slug);
  _themeSetPickerActive(slug);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ theme: slug }); } catch {}
  }
  playSfx?.('click');
}
document.querySelector('#theme-cycle-btn')?.addEventListener('click', () => advanceTheme(1));

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

// Auto-cycle — flip to the next theme every 20s when active. Persisted
// across launches as cfg.themeAuto so users opt in once.
const THEME_AUTO_MS = 20000;
let _themeAutoTimer = null;
function setThemeAuto(on) {
  themeAutoBtnEl?.classList.toggle('is-active', !!on);
  if (_themeAutoTimer) { clearInterval(_themeAutoTimer); _themeAutoTimer = null; }
  if (on) _themeAutoTimer = setInterval(() => advanceTheme(1), THEME_AUTO_MS);
}
themeAutoBtnEl?.addEventListener('click', async () => {
  const cfg  = (await window.dash?.getConfig?.()) || {};
  const next = !cfg.themeAuto;
  setThemeAuto(next);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ themeAuto: next }); } catch {}
  }
  playSfx?.('click');
});
themeMenuEl?.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('.theme-menu-item');
  if (!btn) return;
  const slug = btn.dataset.themePick || '';
  const next = slug || null;
  setUserTheme(next);
  _themeSetPickerActive(next);
  _themeOpenMenu(false);
  if (window.dash?.setConfig) {
    try { await window.dash.setConfig({ theme: next }); } catch {}
  }
  playSfx?.('confirm');
});
// Click-outside-to-close. Single document handler; the button's own
// click stops propagation above so it doesn't immediately re-close.
document.addEventListener('click', (e) => {
  if (!themeMenuEl || themeMenuEl.hidden) return;
  if (themePickerEl?.contains(e.target)) return;
  _themeOpenMenu(false);
});

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
    const stale = ['restart-btn', 'refresh-btn', 'side-arrange-btn', 'eco-mode-btn', 'airplane-btn', 'offline-btn'];
    // Also reset if the saved order pre-dates the introduction of any
    // of these wrappers — without them slotted in, restore would drop
    // them at the end of the bar instead of where the HTML places them.
    const requiredNew = ['theme-picker', 'setup-btn', 'user-name-chip', 'hz-control', 'bg-pattern-btn'];
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

// setThemeAuto is defined above with the rest of the theme-picker wiring.

document.querySelector('#invert-btn')?.addEventListener('click', async () => {
  const cfg = (await window.dash?.getConfig?.()) || {};
  const next = !cfg.invert;
  applyInvert(next);
  if (window.dash?.setConfig) await window.dash.setConfig({ invert: next });
});

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

// ── §bgm ── BACKGROUND MUSIC ────────────────────────────────────────
// Procedural Web Audio synthesis. Each genre is a small "patch" that
// schedules notes on a shared step clock. Plunder-core is currently the
// only genre — sampled-flavoured chopped hits over a low drone bass and
// long pad swells. Loops forever (no fixed song length, no fade-out).
// Audio is fully synthesized at runtime; no files shipped or streamed.
{
  const bgmPlayBtn   = document.getElementById('bgm-play-btn');
  const bgmVolEl     = document.getElementById('bgm-volume');
  const bgmVolValEl  = document.getElementById('bgm-volume-val');
  const bgmNowEl     = document.getElementById('bgm-now');
  const bgmGenresEl  = document.getElementById('bgm-genres');
  const bgmTracksEl  = document.getElementById('bgm-tracks');
  const bgmMeterEl   = document.getElementById('bgm-meter');
  window._bgmState = window._bgmState || {
    playing: false,
    genre: 'plundercore',
    trackId: null,        // resolved to first track of current genre when null
    volume: 0.35,
  };
  let _bgmCtx = null;
  let _bgmMaster = null;
  let _bgmAnalyser = null;
  let _bgmSchedTimer = null;
  let _bgmStep = 0;
  let _bgmNextStepTime = 0;
  let _bgmMeterRaf = 0;
  // Auto-cycle to the next track in the current genre every N ms while
  // playback is active. Resets on manual prev/next/genre switch (since
  // _bgmStart re-arms it). 5 minutes per track keeps long sessions
  // varied without churning the catalog too fast.
  let _bgmCycleTimer = null;
  const BGM_AUTOCYCLE_MS = 5 * 60 * 1000;

  // Lazily create the AudioContext on first play (browsers require a
  // user gesture to unlock audio). Master gain → soft limiter → analyser
  // (for the meter) → destination. The limiter catches transient spikes
  // from overlapping chops so we don't clip.
  function _bgmEnsureCtx() {
    if (_bgmCtx) return _bgmCtx;
    _bgmCtx = new (window.AudioContext || window.webkitAudioContext)();
    _bgmMaster = _bgmCtx.createGain();
    _bgmMaster.gain.value = window._bgmState.volume;
    const limiter = _bgmCtx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    _bgmAnalyser = _bgmCtx.createAnalyser();
    // 1024 fftSize → 512 frequency bins. Plenty of headroom for the
    // dynamic bar count to subdivide without each bar reading a single
    // bin (which causes "comb" artifacts where adjacent bars carry
    // wildly different values).
    _bgmAnalyser.fftSize = 1024;
    _bgmAnalyser.smoothingTimeConstant = 0.6;
    _bgmMaster.connect(limiter).connect(_bgmAnalyser).connect(_bgmCtx.destination);
    return _bgmCtx;
  }

  // ADSR-shaped oscillator one-shot. Optional biquad filter and stereo
  // pan in the chain. Used by every track patch.
  function _bgmPlayTone(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const osc = ctx.createOscillator();
    osc.type = opts.type || 'triangle';
    osc.frequency.value = freq;
    if (opts.detune) osc.detune.value = opts.detune;
    const env = ctx.createGain();
    const peak = opts.peak ?? 0.4;
    const attack = opts.attack ?? 0.005;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + attack);
    env.gain.exponentialRampToValueAtTime(0.001, at + dur);
    let tail = osc;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filter.type || 'lowpass';
      f.frequency.value = opts.filter.freq || 1200;
      f.Q.value = opts.filter.q || 0.7;
      osc.connect(f);
      tail = f;
    }
    tail.connect(env);
    let outNode = env;
    if (typeof opts.pan === 'number' && opts.pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      env.connect(p);
      outNode = p;
    }
    outNode.connect(_bgmMaster);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  // Filtered short noise burst — used for hi-hats, plastic snaps, and
  // chop bodies. opts.type = 'highpass' | 'bandpass' | 'lowpass'.
  function _bgmPlayNoise(at, dur, opts = {}) {
    const ctx = _bgmCtx;
    const bufSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const cd = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) cd[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = opts.filterType || 'bandpass';
    f.frequency.value = opts.freq || 4000;
    f.Q.value = opts.q || 2;
    const env = ctx.createGain();
    const peak = opts.peak ?? 0.3;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, at + dur);
    src.connect(f).connect(env);
    let outNode = env;
    if (typeof opts.pan === 'number' && opts.pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      env.connect(p);
      outNode = p;
    }
    outNode.connect(_bgmMaster);
    src.start(at);
  }

  // Kick — short pitched sine sweep from "start" Hz down to "end" Hz,
  // very fast attack. Used by synthwave and lo-fi rhythmic patches.
  function _bgmPlayKick(at, opts = {}) {
    const ctx = _bgmCtx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(opts.start ?? 130, at);
    osc.frequency.exponentialRampToValueAtTime(opts.end ?? 38, at + (opts.sweep ?? 0.09));
    const env = ctx.createGain();
    const peak = opts.peak ?? 0.55;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, at + (opts.dur ?? 0.32));
    osc.connect(env).connect(_bgmMaster);
    osc.start(at);
    osc.stop(at + (opts.dur ?? 0.35));
  }
  // Snare — bandpassed noise + short pitched body. Brushed variant uses
  // a longer dur for the swept "brush" feel.
  function _bgmPlaySnare(at, opts = {}) {
    _bgmPlayNoise(at, opts.dur ?? 0.13, {
      filterType: 'bandpass', freq: opts.freq ?? 1800, q: 1.4,
      peak: opts.peak ?? 0.22, pan: opts.pan ?? 0,
    });
    _bgmPlayTone(at, 200, 0.07, {
      type: 'triangle', peak: 0.12,
      filter: { type: 'lowpass', freq: 900, q: 0.8 },
    });
  }
  // FM "bell" — sine carrier modulated by a sine modulator. Gives the
  // glassy / chime-like timbre central to several vaporwave patches.
  function _bgmPlayFmBell(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;
    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.value = freq * (opts.ratio ?? 2.01);
    const modGain = ctx.createGain();
    modGain.gain.value = (opts.modDepth ?? 200);
    modulator.connect(modGain).connect(carrier.frequency);
    const env = ctx.createGain();
    const peak = opts.peak ?? 0.2;
    const attack = opts.attack ?? 0.005;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + attack);
    env.gain.exponentialRampToValueAtTime(0.001, at + dur);
    carrier.connect(env);
    let outNode = env;
    if (typeof opts.pan === 'number' && opts.pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      env.connect(p);
      outNode = p;
    }
    outNode.connect(_bgmMaster);
    carrier.start(at);
    modulator.start(at);
    carrier.stop(at + dur + 0.05);
    modulator.stop(at + dur + 0.05);
  }

  // ── §plunder-core ── single track: "CORE LOOP" ────────────────────
  // Sampled-flavoured chopped hits over wandering bass + pad swells.
  const PLUNDERCORE_BASS_NOTES  = [55, 55, 73.42, 65.41, 55, 49, 61.74, 55];
  const PLUNDERCORE_PAD_NOTES   = [220, 261.63, 329.63, 392];
  const PLUNDERCORE_CHOP_NOTES  = [440, 523.25, 659.25, 783.99, 880];
  function _bgmSchedulePlunderCoreLoop(step, at) {
    if (step % 4 === 0) {
      _bgmPlayTone(at, PLUNDERCORE_BASS_NOTES[(step / 4) % PLUNDERCORE_BASS_NOTES.length], 0.45, {
        type: 'sawtooth', peak: 0.32,
        filter: { type: 'lowpass', freq: 300, q: 4 },
      });
    }
    if (step % 8 === 0) {
      const offset = (Math.floor(step / 8) % 2) * 2;
      for (let i = 0; i < 3; i++) {
        _bgmPlayTone(at, PLUNDERCORE_PAD_NOTES[(i + offset) % PLUNDERCORE_PAD_NOTES.length], 3.5, {
          type: 'triangle', peak: 0.08, attack: 0.4,
          filter: { type: 'lowpass', freq: 1800, q: 0.6 },
          pan: i === 0 ? -0.3 : i === 2 ? 0.3 : 0,
        });
      }
    }
    if (step % 2 === 1 && Math.random() < 0.7) {
      const f = PLUNDERCORE_CHOP_NOTES[(step + (Math.random() * 3) | 0) % PLUNDERCORE_CHOP_NOTES.length];
      // Plunder chop = noise burst + pitched square body.
      _bgmPlayNoise(at, 0.13, { filterType: 'bandpass', freq: f * 2, q: 4, peak: 0.32 });
      _bgmPlayTone(at, f, 0.18, {
        type: 'square', peak: 0.25,
        filter: { type: 'lowpass', freq: f * 4 },
      });
    }
    if (Math.random() < 0.25) {
      _bgmPlayTone(at, 2000 + Math.random() * 1500, 0.06, {
        type: 'square', peak: 0.04,
        filter: { type: 'highpass', freq: 1600 },
      });
    }
  }

  // 2) CRATE DIG — jazzy 7th progression, heavy chops, kick on 1.
  function _bgmSchedulePlunderCrateDig(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    // jazzy ii-V-I-vi (Dm7-G7-Cmaj7-Am7) borrowed from the lo-fi set.
    const ch = [
      [146.83, 174.61, 220.00, 261.63],
      [196.00, 246.94, 293.66, 349.23],
      [130.81, 164.81, 196.00, 246.94],
      [220.00, 261.63, 329.63, 415.30],
    ][bar];
    if (beat % 4 === 0) {
      _bgmPlayKick(at, { peak: 0.42 });
      _bgmPlayTone(at, ch[0] / 2, 0.55, {
        type: 'sawtooth', peak: 0.3,
        filter: { type: 'lowpass', freq: 320, q: 4 },
      });
    }
    if (beat % 2 === 0) {
      const f = ch[(beat / 2) % ch.length];
      _bgmPlayNoise(at, 0.11, { filterType: 'bandpass', freq: f * 2, q: 5, peak: 0.26 });
      _bgmPlayTone(at, f, 0.14, {
        type: 'square', peak: 0.18,
        filter: { type: 'lowpass', freq: f * 3 },
      });
    }
    if (beat === 7 || beat === 13) {
      _bgmPlayTone(at, ch[3], 0.35, {
        type: 'sawtooth', peak: 0.1, detune: 6,
        filter: { type: 'lowpass', freq: 2200 },
      });
    }
  }

  // 3) FRAGMENT — minimal, sparse glitchy hits with occasional bass drops.
  const PLUNDER_FRAG_NOTES = [330, 440, 523, 587, 659, 880];
  function _bgmSchedulePlunderFragment(step, at) {
    const beat = step % 16;
    if (Math.random() < 0.28) {
      const f = PLUNDER_FRAG_NOTES[(Math.random() * PLUNDER_FRAG_NOTES.length) | 0];
      _bgmPlayNoise(at, 0.09, { filterType: 'bandpass', freq: f * 1.5, q: 6, peak: 0.22 });
      _bgmPlayTone(at, f, 0.11, {
        type: 'square', peak: 0.13,
        filter: { type: 'lowpass', freq: f * 3 },
        pan: (Math.random() * 2) - 1,
      });
    }
    if (beat === 0 || (beat === 8 && Math.random() < 0.55)) {
      _bgmPlayTone(at, 55, 0.7, {
        type: 'sawtooth', peak: 0.3,
        filter: { type: 'lowpass', freq: 220, q: 3 },
      });
    }
    if (Math.random() < 0.12) {
      _bgmPlayTone(at, 2200 + Math.random() * 1500, 0.05, {
        type: 'square', peak: 0.05,
        filter: { type: 'highpass', freq: 1800 },
      });
    }
  }

  // 4) TAPE SPLICE — pitch wobble on bass + gated chord stabs.
  function _bgmSchedulePlunderTapeSplice(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = [
      [55.00, 65.41, 82.41, 110.00],
      [49.00, 61.74, 73.42, 98.00],
      [43.65, 55.00, 65.41, 87.31],
      [49.00, 61.74, 73.42, 98.00],
    ][bar];
    if (beat % 4 === 0) {
      _bgmPlayTone(at, ch[0], 0.55, {
        type: 'sawtooth', peak: 0.28,
        detune: Math.sin(step * 0.3) * 14, // wobble
        filter: { type: 'lowpass', freq: 320 },
      });
    }
    if (beat % 2 === 1) {
      const det = (Math.random() - 0.5) * 28;
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 4, 0.12, {
          type: 'square', peak: 0.06, detune: det,
          filter: { type: 'lowpass', freq: 1900 },
          pan: (i - 2) * 0.4,
        });
      }
    }
  }

  // 5) STUTTER STEP — fixed rhythmic stutter pattern.
  const PLUNDER_STUTTER_BEATS = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0];
  const PLUNDER_STUTTER_NOTES = [220, 261.63, 329.63, 392, 440];
  function _bgmSchedulePlunderStutterStep(step, at) {
    const beat = step % 16;
    if (PLUNDER_STUTTER_BEATS[beat]) {
      const f = PLUNDER_STUTTER_NOTES[beat % PLUNDER_STUTTER_NOTES.length];
      _bgmPlayNoise(at, 0.06, { filterType: 'bandpass', freq: f * 2, q: 4, peak: 0.18 });
      _bgmPlayTone(at, f, 0.08, {
        type: 'square', peak: 0.16,
        pan: ((beat % 4) - 1.5) * 0.4,
      });
    }
    if (beat === 0) {
      _bgmPlayKick(at, { peak: 0.38 });
      _bgmPlayTone(at, 55, 0.4, {
        type: 'sawtooth', peak: 0.26,
        filter: { type: 'lowpass', freq: 280, q: 4 },
      });
    }
  }

  // 6) PHANTOM ROOM — dub-ish atmosphere with delay-style echo chops.
  function _bgmSchedulePlunderPhantomRoom(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 5.0, {
          type: 'triangle', peak: 0.06, attack: 0.7,
          filter: { type: 'lowpass', freq: 1400 },
          pan: (i - 1.5) * 0.4,
        });
      }
    }
    if (beat === 0 || beat === 10) {
      _bgmPlayTone(at, ch[0] / 2, 0.6, {
        type: 'sine', peak: 0.3,
        filter: { type: 'lowpass', freq: 200 },
      });
    }
    // Echo-trail chops — same hit at 3 decaying offsets, mimicking
    // dub-style tape delay.
    if (beat === 6 && Math.random() < 0.7) {
      const f = ch[2] * 2;
      for (let k = 0; k < 3; k++) {
        const o = k * 0.3;
        _bgmPlayNoise(at + o, 0.08, {
          filterType: 'bandpass', freq: f * 2, q: 5,
          peak: 0.22 * Math.pow(0.5, k),
          pan: -0.4 + k * 0.4,
        });
      }
    }
  }

  // 7) HOOK CYCLE — repeating melodic hook over chops.
  const PLUNDER_HOOK_NOTES = [392, 523.25, 587.33, 440, 523.25, 392, 349.23, 440];
  function _bgmSchedulePlunderHookCycle(step, at) {
    const beat = step % 16;
    if (beat % 2 === 0) {
      const note = PLUNDER_HOOK_NOTES[(beat / 2) % PLUNDER_HOOK_NOTES.length];
      _bgmPlayTone(at, note, 0.18, {
        type: 'square', peak: 0.11,
        filter: { type: 'lowpass', freq: 1900 },
        pan: ((beat / 2) % 4 - 1.5) * 0.3,
      });
    }
    if (beat % 4 === 0) {
      _bgmPlayTone(at, 110, 0.4, {
        type: 'sawtooth', peak: 0.24,
        filter: { type: 'lowpass', freq: 300, q: 3 },
      });
    }
    if (beat % 2 === 1 && Math.random() < 0.45) {
      _bgmPlayNoise(at, 0.05, { filterType: 'highpass', freq: 4500, peak: 0.09 });
    }
  }

  // 8) GHOST CRACKLE — vinyl crackle bed + detuned chops.
  function _bgmSchedulePlunderGhostCrackle(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = VAPOR_CHORDS_C[bar];
    // Always-on crackle particles.
    if (Math.random() < 0.5) _bgmPlayNoise(at + Math.random() * 0.15, 0.012, {
      filterType: 'bandpass', freq: 4000 + Math.random() * 3000,
      q: 8, peak: 0.035,
    });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.5, {
      type: 'sawtooth', peak: 0.26,
      filter: { type: 'lowpass', freq: 320 },
    });
    if (beat % 2 === 1) {
      const f = ch[(beat / 2 | 0) % ch.length] * 2;
      _bgmPlayNoise(at, 0.1, { filterType: 'bandpass', freq: f * 1.8, q: 5, peak: 0.16 });
      _bgmPlayTone(at, f, 0.14, {
        type: 'square', peak: 0.09, detune: ((step * 7) % 30) - 15,
      });
    }
  }

  // 9) SLOW BURN — sub bass + smoky pad + sparse chops.
  function _bgmSchedulePlunderSlowBurn(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) {
      _bgmPlayTone(at, ch[0] / 2, 0.7, {
        type: 'sine', peak: 0.35,
        filter: { type: 'lowpass', freq: 150 },
      });
      _bgmPlayTone(at, ch[0], 0.6, {
        type: 'sawtooth', peak: 0.22,
        filter: { type: 'lowpass', freq: 280, q: 4 },
      });
    }
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 4.5, {
          type: 'triangle', peak: 0.07, attack: 0.6,
          filter: { type: 'lowpass', freq: 1100 },
          pan: (i - 2) * 0.3,
        });
      }
    }
    if (beat === 6 || beat === 11) {
      const f = ch[2] * 2;
      _bgmPlayNoise(at, 0.14, { filterType: 'bandpass', freq: f * 1.5, q: 4, peak: 0.2 });
      _bgmPlayTone(at, f, 0.18, { type: 'square', peak: 0.12 });
    }
  }

  // 10) MOSAIC — busy pattern, many short hits across the spectrum.
  const PLUNDER_MOSAIC_NOTES = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 659.25];
  function _bgmSchedulePlunderMosaic(step, at) {
    const beat = step % 16;
    if (Math.random() < 0.62) {
      const f = PLUNDER_MOSAIC_NOTES[(step * 3) % PLUNDER_MOSAIC_NOTES.length];
      _bgmPlayNoise(at, 0.05, { filterType: 'bandpass', freq: f * 2, q: 6, peak: 0.14 });
      _bgmPlayTone(at, f, 0.08, {
        type: 'square', peak: 0.08,
        filter: { type: 'lowpass', freq: f * 3 },
        pan: (Math.random() * 2) - 1,
      });
    }
    if (beat % 4 === 0) {
      _bgmPlayTone(at, 73.42, 0.4, {
        type: 'sawtooth', peak: 0.25,
        filter: { type: 'lowpass', freq: 280, q: 4 },
      });
    }
    if (beat === 0) {
      _bgmPlayTone(at, 220, 3.0, {
        type: 'triangle', peak: 0.05, attack: 0.5,
        filter: { type: 'lowpass', freq: 1400 },
      });
    }
  }

  // ── §vaporwave ── shared chord progressions ───────────────────────
  // Most patches share a I-V-vi-IV style progression rooted at C,
  // because that's the vaporwave home turf. 64-step pattern = 4 bars
  // of 16ths, one chord per bar.
  const VAPOR_CHORDS_C = [
    // [root, third, fifth, seventh] — Cmaj7, G, Am, Fmaj7
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
    [196.00, 246.94, 293.66, 369.99], // G — using maj feel
    [220.00, 261.63, 329.63, 415.30], // Am7
    [174.61, 220.00, 261.63, 329.63], // Fmaj7
  ];

  // 1) MALL AIR — long pad chords + soft sine bells, no perc.
  function _bgmScheduleVaporMallAir(step, at) {
    const beat = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const chord = VAPOR_CHORDS_C[bar];
    // Pad swell at the top of each bar — every note in the chord, long.
    if (beat === 0) {
      for (let i = 0; i < chord.length; i++) {
        _bgmPlayTone(at, chord[i], 4.5, {
          type: 'sine', peak: 0.09, attack: 0.6,
          filter: { type: 'lowpass', freq: 2200, q: 0.5 },
          pan: (i - 1.5) * 0.25,
        });
        // Octave above, even quieter, for shimmer.
        _bgmPlayTone(at, chord[i] * 2, 4.5, {
          type: 'sine', peak: 0.04, attack: 0.8, detune: 8,
          pan: (i - 1.5) * 0.4,
        });
      }
    }
    // Soft bell on beat 5 of every bar.
    if (beat === 4) {
      _bgmPlayFmBell(at, chord[2] * 2, 1.2, { peak: 0.07, modDepth: 80, ratio: 2.01, pan: 0.2 });
    }
  }

  // 2) PLAZA BATH — FM bells + slow chord wash, water-y feel.
  function _bgmScheduleVaporPlazaBath(step, at) {
    const beat = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const chord = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < chord.length; i++) {
        _bgmPlayTone(at, chord[i], 5.5, {
          type: 'triangle', peak: 0.07, attack: 0.9,
          filter: { type: 'lowpass', freq: 1600, q: 0.5 },
          pan: (i % 2 === 0 ? -0.35 : 0.35),
        });
      }
    }
    // Wandering FM bells on a 5-step cycle so they drift out of phase
    // with the chord bar — that's the "water" feel.
    if (step % 5 === 0) {
      const noteIdx = (step / 5) | 0;
      const note = chord[noteIdx % chord.length] * 2;
      _bgmPlayFmBell(at, note, 1.6, {
        peak: 0.08,
        modDepth: 100 + (step % 7) * 20,
        ratio: 2.01 + (step % 3) * 0.03,
        pan: ((step * 0.37) % 2) - 1,
      });
    }
  }

  // 3) SUNSET CASSETTE — wobble bass + detuned saw lead + plastic snaps.
  const VAPOR_CASSETTE_LEAD = [392, 440, 523.25, 587.33, 659.25, 587.33, 523.25, 440];
  function _bgmScheduleVaporSunsetCassette(step, at) {
    const beat = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const chord = VAPOR_CHORDS_C[bar];
    // Wobble bass: root + filter cutoff moves with step.
    if (beat % 4 === 0) {
      const cutoff = 280 + (beat / 4) * 90;
      _bgmPlayTone(at, chord[0] / 2, 0.7, {
        type: 'sawtooth', peak: 0.28,
        filter: { type: 'lowpass', freq: cutoff, q: 5 },
      });
    }
    // Detuned saw lead, slow melody.
    if (beat % 2 === 0) {
      const note = VAPOR_CASSETTE_LEAD[(beat / 2 + bar * 2) % VAPOR_CASSETTE_LEAD.length];
      _bgmPlayTone(at, note, 0.65, {
        type: 'sawtooth', peak: 0.07, detune: -8,
        filter: { type: 'lowpass', freq: 1500, q: 1.2 },
        pan: -0.2,
      });
      _bgmPlayTone(at, note, 0.65, {
        type: 'sawtooth', peak: 0.07, detune: 8,
        filter: { type: 'lowpass', freq: 1500, q: 1.2 },
        pan: 0.2,
      });
    }
    // Plastic snap on off-beats.
    if (beat % 2 === 1) {
      _bgmPlayNoise(at, 0.05, { filterType: 'highpass', freq: 4000, peak: 0.08 });
    }
  }

  // 4) STATIC LOBBY — soft hat tick + dreamy chord wash, no bass.
  function _bgmScheduleVaporStaticLobby(step, at) {
    const beat = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const chord = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < chord.length; i++) {
        _bgmPlayTone(at, chord[i] * 2, 5.0, {
          type: 'triangle', peak: 0.06, attack: 1.0,
          filter: { type: 'lowpass', freq: 2400, q: 0.5 },
          pan: (i - 1.5) * 0.35,
        });
      }
    }
    // Soft hi-hat tick on every other step.
    if (beat % 2 === 0) {
      _bgmPlayNoise(at, 0.035, {
        filterType: 'highpass', freq: 7000,
        peak: 0.05, pan: 0.4,
      });
    }
    // Pitched bell drifting over the wash, sparse.
    if (Math.random() < 0.12) {
      const note = chord[(Math.random() * 4) | 0] * 4;
      _bgmPlayFmBell(at, note, 0.9, {
        peak: 0.05, modDepth: 60, ratio: 3.01,
        pan: (Math.random() * 2) - 1,
      });
    }
  }

  // 5) PIXEL HIGHWAY — slow synth bass + retro arp + chip lead.
  const VAPOR_ARP_C = [261.63, 329.63, 392, 523.25];
  function _bgmScheduleVaporPixelHighway(step, at) {
    const beat = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const chord = VAPOR_CHORDS_C[bar];
    // Driving synth bass on downbeats.
    if (beat % 4 === 0) {
      _bgmPlayTone(at, chord[0] / 2, 0.5, {
        type: 'square', peak: 0.18,
        filter: { type: 'lowpass', freq: 500, q: 3 },
      });
    }
    // Ascending arp — 16ths, root/third/fifth/octave from current chord.
    const arpNotes = [chord[0], chord[1], chord[2], chord[3] || chord[0] * 2];
    _bgmPlayTone(at, arpNotes[beat % 4] * 2, 0.18, {
      type: 'square', peak: 0.06,
      filter: { type: 'lowpass', freq: 2400, q: 1.5 },
      pan: ((beat % 4) - 1.5) * 0.4,
    });
    // Occasional chip lead.
    if (beat === 8 || beat === 14) {
      _bgmPlayTone(at, chord[2] * 2, 0.5, {
        type: 'square', peak: 0.08,
        filter: { type: 'lowpass', freq: 2800, q: 1.5 },
      });
    }
  }

  // 6) DEAD MALL — empty echo, distant chords, footstep-noise hits.
  function _bgmScheduleVaporDeadMall(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 5.5, {
          type: 'triangle', peak: 0.05, attack: 1.0,
          filter: { type: 'lowpass', freq: 1400 },
          pan: (i - 1.5) * 0.45,
        });
      }
    }
    if (beat === 8) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 1.2, {
          type: 'sine', peak: 0.04, attack: 0.2,
          pan: (i - 1.5) * 0.5,
        });
      }
    }
    if (Math.random() < 0.14) {
      _bgmPlayNoise(at, 0.15, {
        filterType: 'lowpass', freq: 200, peak: 0.06,
        pan: (Math.random() * 2) - 1,
      });
    }
  }
  // 7) PINK FLAMINGO — bright bells + dreamy lead + slow swell.
  function _bgmScheduleVaporPinkFlamingo(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 4.5, {
          type: 'sine', peak: 0.08, attack: 0.5,
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    if (step % 3 === 0) {
      _bgmPlayFmBell(at, ch[((step / 3) | 0) % ch.length] * 4, 1.5, {
        peak: 0.07, modDepth: 60, ratio: 2.01,
        pan: ((step * 0.21) % 2) - 1,
      });
    }
    if (beat === 6 || beat === 14) {
      _bgmPlayTone(at, ch[2] * 2, 0.9, {
        type: 'sine', peak: 0.1, attack: 0.1,
      });
    }
  }
  // 8) BEACH HAZE — water-y bells over slow swells, no perc.
  function _bgmScheduleVaporBeachHaze(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 5.0, {
          type: 'sine', peak: 0.07, attack: 1.0,
          pan: (i - 1.5) * 0.5,
        });
      }
    }
    if (step % 7 === 0) {
      _bgmPlayFmBell(at, ch[((step / 7) | 0) % ch.length] * 3, 1.8, {
        peak: 0.07,
        modDepth: 80 + (step % 5) * 30,
        ratio: 2.01 + Math.sin(step * 0.1) * 0.5,
        pan: ((step * 0.31) % 2) - 1,
      });
    }
  }
  // 9) FAX MODEM — chopped modem-like glitches over chord bed.
  function _bgmScheduleVaporFaxModem(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 4.0, {
          type: 'triangle', peak: 0.06, attack: 0.5,
          filter: { type: 'lowpass', freq: 1500 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    if (beat % 2 === 0) {
      const f = 400 + Math.random() * 800;
      _bgmPlayTone(at, f, 0.06, {
        type: 'square', peak: 0.08,
        filter: { type: 'bandpass', freq: f * 1.5, q: 8 },
        pan: (Math.random() * 2) - 1,
      });
    }
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'sawtooth', peak: 0.18,
      filter: { type: 'lowpass', freq: 300 },
    });
  }
  // 10) TROPIC DUSK — warm pad + tropical bell melody + smooth sub.
  function _bgmScheduleVaporTropicDusk(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = VAPOR_CHORDS_C[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 4.5, {
          type: 'triangle', peak: 0.08, attack: 0.6,
          filter: { type: 'lowpass', freq: 1600 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.7, {
      type: 'sine', peak: 0.26,
      filter: { type: 'lowpass', freq: 200 },
    });
    if (beat % 2 === 0) {
      const melody = [ch[2], ch[3], ch[2], ch[1], ch[2], ch[3]];
      _bgmPlayFmBell(at, melody[(beat / 2) % melody.length] * 2, 0.8, {
        peak: 0.06, modDepth: 50, ratio: 2.01, pan: 0.2,
      });
    }
  }

  // ── §synthwave ── classic outrun-flavoured 80s synth ─────────────
  // All five share the i-VII-VI-VII / Am-G-F-G minor progression, which
  // is the synthwave home key. Each track varies arrangement: arp
  // density, drum hits, lead style, etc.
  const SYNTH_CHORDS_AM = [
    [110.00, 130.81, 164.81, 196.00], // Am
    [98.00,  123.47, 146.83, 196.00], // G
    [87.31,  110.00, 130.81, 174.61], // F
    [98.00,  123.47, 146.83, 196.00], // G
  ];
  // 1) NEON DRIVE — driving 16th arp, fat bass, kick/hat groove.
  function _bgmScheduleSynthNeonDrive(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    // Kick — every 4 steps.
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.5 });
    // Off-beat hat.
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.04, {
      filterType: 'highpass', freq: 8000, peak: 0.06, pan: 0.3,
    });
    // 16th-note ascending arp through chord tones, one octave up.
    const arp = [ch[0], ch[1], ch[2], ch[3]];
    _bgmPlayTone(at, arp[beat % 4] * 2, 0.16, {
      type: 'square', peak: 0.07,
      filter: { type: 'lowpass', freq: 2400, q: 1.2 },
      pan: ((beat % 4) - 1.5) * 0.4,
    });
    // Bass square root every downbeat.
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'sawtooth', peak: 0.28,
      filter: { type: 'lowpass', freq: 440, q: 3 },
    });
    // Lead stab on beat 9.
    if (beat === 8) _bgmPlayTone(at, ch[2] * 2, 0.8, {
      type: 'sawtooth', peak: 0.1, detune: 8,
      filter: { type: 'lowpass', freq: 2000 },
    });
  }
  // 2) MIDNIGHT CRUISE — slower, atmospheric, gated chord stabs.
  function _bgmScheduleSynthMidnightCruise(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 3.2, {
          type: 'sawtooth', peak: 0.06, attack: 0.5, detune: i * 4,
          filter: { type: 'lowpass', freq: 2200 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.7, {
      type: 'sawtooth', peak: 0.22,
      filter: { type: 'lowpass', freq: 380, q: 2.5 },
    });
    // Gated chord stab every 8 steps.
    if (beat % 8 === 4) {
      for (const n of ch) _bgmPlayTone(at, n, 0.18, {
        type: 'square', peak: 0.06,
        filter: { type: 'lowpass', freq: 1600 },
      });
    }
  }
  // 3) OUTRUN — aggressive, fast, full kit.
  function _bgmScheduleSynthOutrun(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    // 16th-note alternating bass — root then octave.
    _bgmPlayTone(at, (beat % 2 === 0 ? ch[0] / 2 : ch[0]), 0.14, {
      type: 'sawtooth', peak: 0.22,
      filter: { type: 'lowpass', freq: 500, q: 3 },
    });
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.55 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.22 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 9000, peak: 0.04,
    });
    // Lead riff every 4 bars at end of phrase.
    if (beat === 14) _bgmPlayTone(at, ch[2] * 2, 0.3, {
      type: 'sawtooth', peak: 0.12, detune: -6,
      filter: { type: 'lowpass', freq: 2400 },
    });
  }
  // 4) GHOST GRID — minor, eerie, sparse hats, low filter sweep feel.
  function _bgmScheduleSynthGhostGrid(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    // Long pad, gently filter-swept (re-trigger every 16 with rising cutoff).
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 2.8, {
          type: 'sawtooth', peak: 0.05, attack: 0.7, detune: -4,
          filter: { type: 'lowpass', freq: 800 + bar * 250, q: 4 },
          pan: (i - 1.5) * 0.35,
        });
      }
    }
    // Sparse pulse bass on downbeats.
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.6, {
      type: 'square', peak: 0.18,
      filter: { type: 'lowpass', freq: 320, q: 5 },
    });
    // Eerie sparse FM bell on offbeats.
    if (beat === 6 || beat === 11) _bgmPlayFmBell(at, ch[3] * 2, 1.0, {
      peak: 0.06, modDepth: 140, ratio: 3.01,
      pan: (Math.random() * 2) - 1,
    });
    if (beat % 4 === 2) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 9500, peak: 0.04,
    });
  }
  // 5) VHS GLOW — washy chorus pad, slow arp, tape hiss bed.
  function _bgmScheduleSynthVhsGlow(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      // Three detuned sawtooth layers for the "chorus" feel.
      for (let i = 0; i < ch.length; i++) {
        for (const det of [-8, 0, 8]) {
          _bgmPlayTone(at, ch[i] * 2, 3.6, {
            type: 'sawtooth', peak: 0.04, attack: 0.8, detune: det,
            filter: { type: 'lowpass', freq: 2000 },
            pan: det / 30,
          });
        }
      }
    }
    // Slow arp — 8th notes through chord tones.
    if (beat % 2 === 0) {
      const arp = [ch[0], ch[2], ch[1], ch[3]];
      _bgmPlayTone(at, arp[(beat / 2) % 4] * 2, 0.42, {
        type: 'sine', peak: 0.08, attack: 0.05,
        pan: ((beat / 2) % 4 - 1.5) * 0.3,
      });
    }
    // Tape hiss — quiet noise particles.
    if (Math.random() < 0.4) _bgmPlayNoise(at, 0.02, {
      filterType: 'highpass', freq: 6000, peak: 0.02,
    });
  }

  // 6) CHROME HIGHWAY — driving 16th bass arp + chord stabs every 8.
  function _bgmScheduleSynthChromeHighway(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    _bgmPlayTone(at, ch[beat % ch.length] / 2, 0.13, {
      type: 'sawtooth', peak: 0.18,
      filter: { type: 'lowpass', freq: 500, q: 3 },
    });
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.5 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.2 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 9000, peak: 0.05,
    });
    if (beat % 8 === 4) {
      for (const n of ch) _bgmPlayTone(at, n * 2, 0.15, {
        type: 'square', peak: 0.06,
        filter: { type: 'lowpass', freq: 2000 },
      });
    }
  }
  // 7) STARLIGHT — atmospheric, slow lead, ethereal.
  function _bgmScheduleSynthStarlight(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 5.0, {
          type: 'sine', peak: 0.07, attack: 1.0,
          pan: (i - 1.5) * 0.4,
        });
      }
    }
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.6, {
      type: 'sine', peak: 0.2,
      filter: { type: 'lowpass', freq: 200 },
    });
    if (beat === 6 || beat === 12) {
      _bgmPlayTone(at, ch[2] * 4, 1.2, {
        type: 'sine', peak: 0.08, attack: 0.2,
        pan: ((beat / 6) - 1) * 0.4,
      });
    }
    if (Math.random() < 0.1) {
      _bgmPlayFmBell(at, 2000 + Math.random() * 1500, 0.8, {
        peak: 0.03, modDepth: 100, ratio: 3.01,
      });
    }
  }
  // 8) CITY GLITTER — high arp shimmer + mid pad.
  function _bgmScheduleSynthCityGlitter(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 3.5, {
          type: 'sawtooth', peak: 0.05, attack: 0.4, detune: i * 3,
          filter: { type: 'lowpass', freq: 1800 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    // High arp — every step.
    _bgmPlayTone(at, ch[beat % ch.length] * 4, 0.1, {
      type: 'sine', peak: 0.05,
      pan: ((beat % 4) - 1.5) * 0.5,
    });
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.32 });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'sawtooth', peak: 0.2,
      filter: { type: 'lowpass', freq: 400 },
    });
  }
  // 9) DARK MATTER — minor ominous, low sub, sparse.
  function _bgmScheduleSynthDarkMatter(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 4, 0.7, {
      type: 'sine', peak: 0.32,
      filter: { type: 'lowpass', freq: 120 },
    });
    if (beat === 0) _bgmPlayTone(at, ch[0], 4.0, {
      type: 'sawtooth', peak: 0.07, attack: 0.8,
      filter: { type: 'lowpass', freq: 800, q: 3 },
    });
    if (beat === 8) _bgmPlayTone(at, ch[2], 3.5, {
      type: 'sawtooth', peak: 0.06, attack: 0.6,
      filter: { type: 'lowpass', freq: 700 },
    });
    if (beat === 14 && Math.random() < 0.5) {
      _bgmPlayFmBell(at, ch[3] * 2, 1.5, {
        peak: 0.05, modDepth: 200, ratio: 4.01,
        pan: (Math.random() * 2) - 1,
      });
    }
  }
  // 10) HORIZON RUSH — fast aggressive, full kit, big lead.
  function _bgmScheduleSynthHorizonRush(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 2 === 0) {
      _bgmPlayTone(at, (beat % 4 < 2 ? ch[0] : ch[2]) / 2, 0.18, {
        type: 'sawtooth', peak: 0.24,
        filter: { type: 'lowpass', freq: 500, q: 3 },
      });
    }
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.55 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.25 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 8500, peak: 0.06,
    });
    if (beat === 6) {
      _bgmPlayTone(at, ch[2] * 2, 0.5, {
        type: 'sawtooth', peak: 0.12, detune: 6,
        filter: { type: 'lowpass', freq: 2400 },
      });
    }
    if (beat === 10) {
      _bgmPlayTone(at, ch[3] * 2, 0.5, {
        type: 'sawtooth', peak: 0.12, detune: -6,
        filter: { type: 'lowpass', freq: 2400 },
      });
    }
  }

  // ── §lofi ── chill hip-hop, jazzy 7ths, soft drums ──────────────
  // ii-V-I-vi progression in C (Dm7 - G7 - Cmaj7 - Am7) — the lo-fi
  // home turf.
  const LOFI_CHORDS = [
    [146.83, 174.61, 220.00, 261.63], // Dm7
    [196.00, 246.94, 293.66, 349.23], // G7
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
    [220.00, 261.63, 329.63, 415.30], // Am7
  ];
  // 1) STUDY DESK — soft kick + hat + 7th chord stabs.
  function _bgmScheduleLofiStudyDesk(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.3, end: 50, dur: 0.22 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 7500, peak: 0.05, pan: 0.25,
    });
    if (beat % 8 === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 1.2, {
          type: 'triangle', peak: 0.09, attack: 0.05,
          filter: { type: 'lowpass', freq: 1400 },
          pan: (i - 1.5) * 0.25,
        });
      }
    }
    // Mellow lead, sparse.
    if (beat === 10 && Math.random() < 0.7) {
      _bgmPlayTone(at, ch[2] * 2, 0.6, {
        type: 'sine', peak: 0.1, attack: 0.04, pan: 0.15,
      });
    }
  }
  // 2) COFFEE STEAM — brushed snare + walking bass + warm pad.
  function _bgmScheduleLofiCoffeeSteam(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    // Brushed snare on beats 2 and 4 (steps 4 + 12).
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, {
      dur: 0.18, peak: 0.16, freq: 1400,
    });
    // Walking bass — root on 1, fifth on 3, chord-passing notes on
    // off-beats. Comes from a small table per bar.
    const walk = [ch[0], ch[0], ch[2], ch[2]];
    if (beat % 4 === 0) _bgmPlayTone(at, walk[bar] / 2, 0.55, {
      type: 'triangle', peak: 0.22,
      filter: { type: 'lowpass', freq: 380, q: 1.5 },
    });
    // Warm pad on bar starts.
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 3.2, {
          type: 'triangle', peak: 0.06, attack: 0.4,
          filter: { type: 'lowpass', freq: 1200 },
          pan: (i - 2) * 0.3,
        });
      }
    }
  }
  // 3) RAIN WINDOW — sparse droplets + chord washes, no drums.
  function _bgmScheduleLofiRainWindow(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    // Constant patter of rain "droplets" — high noise particles.
    if (Math.random() < 0.7) {
      _bgmPlayNoise(at, 0.02, {
        filterType: 'highpass', freq: 6000 + Math.random() * 4000,
        peak: 0.05 + Math.random() * 0.04,
        pan: (Math.random() * 2) - 1,
      });
    }
    // Long chord wash on bar starts.
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 4.2, {
          type: 'triangle', peak: 0.07, attack: 0.6,
          filter: { type: 'lowpass', freq: 1500 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    // Occasional bell drop.
    if (beat % 7 === 0 && Math.random() < 0.5) {
      _bgmPlayFmBell(at, ch[(beat / 7) % ch.length] * 2, 0.7, {
        peak: 0.06, modDepth: 80, ratio: 2.01,
      });
    }
  }
  // 4) VINYL CRACKLE — gritty crackle layer + chord stabs.
  function _bgmScheduleLofiVinylCrackle(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    // Always-on crackle — random tiny noise bursts on every step.
    if (Math.random() < 0.55) _bgmPlayNoise(at + Math.random() * 0.1, 0.015, {
      filterType: 'bandpass', freq: 3000 + Math.random() * 2000,
      q: 6, peak: 0.04,
    });
    if (beat === 0) _bgmPlayKick(at, { peak: 0.32, end: 45 });
    // Chord stabs on each downbeat.
    if (beat % 4 === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 0.4, {
          type: 'triangle', peak: 0.07, attack: 0.02,
          filter: { type: 'lowpass', freq: 1300 },
          pan: (i - 2) * 0.3,
        });
      }
    }
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.15 });
  }
  // 5) NIGHT BUS — moving bass + soft hat + dreamy lead.
  const LOFI_NIGHTBUS_LEAD = [261.63, 329.63, 392, 440, 392, 329.63, 293.66, 261.63];
  function _bgmScheduleLofiNightBus(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    // Hat every step quietly.
    if (beat % 2 === 0) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 8000, peak: 0.04, pan: 0.2,
    });
    // Walking bass — moves through chord root and approach tones.
    const bassPattern = [ch[0], ch[0], ch[1], ch[0]];
    if (beat % 4 === 0) _bgmPlayTone(at, bassPattern[bar] / 2, 0.5, {
      type: 'triangle', peak: 0.22,
      filter: { type: 'lowpass', freq: 360 },
    });
    if (beat === 0) _bgmPlayKick(at, { peak: 0.32 });
    // Dreamy lead — slow melody, sine.
    if (beat % 2 === 0) {
      const noteIdx = ((beat / 2) + bar * 2) % LOFI_NIGHTBUS_LEAD.length;
      _bgmPlayTone(at, LOFI_NIGHTBUS_LEAD[noteIdx], 0.4, {
        type: 'sine', peak: 0.09, attack: 0.06, pan: 0.1,
      });
    }
  }

  // 6) VINYL POP — warm noise pops + chord stabs + mellow lead.
  function _bgmScheduleLofiVinylPop(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    if (beat === 0 || beat === 8) _bgmPlayKick(at, { peak: 0.28, end: 48 });
    if (Math.random() < 0.3) {
      _bgmPlayNoise(at + Math.random() * 0.1, 0.02, {
        filterType: 'lowpass', freq: 1500, peak: 0.06,
      });
    }
    if (beat % 4 === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 0.4, {
          type: 'triangle', peak: 0.07, attack: 0.04,
          filter: { type: 'lowpass', freq: 1300 },
        });
      }
    }
    if (beat === 6) {
      _bgmPlayTone(at, ch[2] * 2, 0.7, {
        type: 'sine', peak: 0.08, attack: 0.1,
      });
    }
  }
  // 7) AFTER HOURS — piano-like notes + soft kit + late-night feel.
  function _bgmScheduleLofiAfterHours(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    if (beat % 4 === 0) {
      _bgmPlayTone(at, ch[0], 0.6, {
        type: 'triangle', peak: 0.12, attack: 0.005,
        filter: { type: 'lowpass', freq: 1200 },
      });
    }
    if (beat === 4 || beat === 12) {
      _bgmPlayTone(at, ch[2], 0.5, {
        type: 'triangle', peak: 0.1, attack: 0.005,
        filter: { type: 'lowpass', freq: 1500 },
      });
    }
    if (beat === 0) _bgmPlayKick(at, { peak: 0.24, end: 42 });
    if (beat === 8 && Math.random() < 0.5) _bgmPlaySnare(at, { peak: 0.11 });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.5, {
      type: 'sine', peak: 0.18,
    });
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 4.0, {
          type: 'triangle', peak: 0.05, attack: 0.5,
          filter: { type: 'lowpass', freq: 1000 },
          pan: (i - 2) * 0.3,
        });
      }
    }
  }
  // 8) OPEN WINDOW — breezy, soft hat, gentle melody.
  function _bgmScheduleLofiOpenWindow(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    if (beat % 2 === 0) _bgmPlayNoise(at, 0.02, {
      filterType: 'highpass', freq: 8500, peak: 0.04, pan: 0.3,
    });
    if (beat % 8 === 0) {
      _bgmPlayNoise(at, 1.5, {
        filterType: 'highpass', freq: 4000, peak: 0.03,
        pan: ((step * 0.11) % 2) - 1,
      });
    }
    const gentle = [ch[0] * 2, ch[1] * 2, ch[2] * 2, ch[1] * 2];
    if (beat % 4 === 0) {
      _bgmPlayTone(at, gentle[bar], 0.7, {
        type: 'triangle', peak: 0.08, attack: 0.1,
      });
    }
    if (beat === 0) _bgmPlayKick(at, { peak: 0.26 });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'triangle', peak: 0.17,
    });
  }
  // 9) SCHOOL HALL — bell chimes + soft kit + nostalgic pad.
  function _bgmScheduleLofiSchoolHall(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    if (beat % 4 === 0) {
      _bgmPlayFmBell(at, ch[bar % ch.length] * 2, 1.0, {
        peak: 0.09, modDepth: 50, ratio: 2.01,
        pan: (bar - 1.5) * 0.4,
      });
    }
    if (beat === 0 || beat === 8) _bgmPlayKick(at, { peak: 0.26 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.13 });
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 4.0, {
          type: 'triangle', peak: 0.06, attack: 0.5,
          filter: { type: 'lowpass', freq: 1300 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
  }
  // 10) DUSK STROLL — walking bass + soft hat + mellow lead.
  function _bgmScheduleLofiDuskStroll(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    const walk = [ch[0], ch[0], ch[1], ch[0], ch[2], ch[2], ch[1], ch[0]];
    if (beat % 2 === 0) {
      _bgmPlayTone(at, walk[((beat / 2) + bar * 2) % walk.length] / 2, 0.4, {
        type: 'triangle', peak: 0.18,
        filter: { type: 'lowpass', freq: 380 },
      });
    }
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 8000, peak: 0.04, pan: 0.3,
    });
    if (beat === 0) _bgmPlayKick(at, { peak: 0.28 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.13 });
    if (beat === 8 || beat === 14) {
      _bgmPlayTone(at, ch[2] * 2, 0.5, {
        type: 'sine', peak: 0.09, attack: 0.05,
      });
    }
  }

  // ── §darkambient ── slow drones, no rhythm, atmospheric ───────────
  // Bass roots for each track's root drone. Tracks have NO drum
  // patterns; the "beat" grid is just a slow scheduler tick.
  // 1) ABYSS — sub bass drone + occasional shimmer.
  function _bgmScheduleDarkAbyss(step, at) {
    const beat = step % 16;
    // Re-trigger sub drone every 8 steps so the loop never decays.
    if (beat % 8 === 0) {
      _bgmPlayTone(at, 41.20, 6.5, {
        type: 'sine', peak: 0.32, attack: 1.5,
        filter: { type: 'lowpass', freq: 180 },
      });
      _bgmPlayTone(at, 82.41, 6.5, {
        type: 'triangle', peak: 0.06, attack: 2.0,
      });
    }
    // Random high shimmer.
    if (Math.random() < 0.08) {
      _bgmPlayFmBell(at, 1500 + Math.random() * 1500, 2.5, {
        peak: 0.03, modDepth: 200, ratio: 4.01,
        pan: (Math.random() * 2) - 1,
      });
    }
  }
  // 2) CATHEDRAL — long pad chords + bell drops, very reverberant feel.
  const DARK_CATHEDRAL_CHORDS = [
    [73.42,  87.31, 110.00],  // D minor triad low
    [65.41,  82.41, 98.00],   // C low triad
    [98.00, 123.47, 146.83],  // G triad
    [87.31, 110.00, 130.81],  // F-A-C triad
  ];
  function _bgmScheduleDarkCathedral(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = DARK_CATHEDRAL_CHORDS[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 7.0, {
          type: 'triangle', peak: 0.08, attack: 1.8,
          filter: { type: 'lowpass', freq: 1400 },
          pan: (i - 1) * 0.4,
        });
        _bgmPlayTone(at, ch[i] * 4, 7.0, {
          type: 'sine', peak: 0.04, attack: 2.2,
          pan: (i - 1) * 0.5,
        });
      }
    }
    // Sparse bell drops.
    if (beat === 6 && Math.random() < 0.5) {
      _bgmPlayFmBell(at, ch[2] * 4, 2.0, {
        peak: 0.06, modDepth: 60, ratio: 2.01,
      });
    }
  }
  // 3) STATIC RIFT — filtered noise washes + pitched sub.
  function _bgmScheduleDarkStaticRift(step, at) {
    const beat = step % 16;
    // Sub drone, retriggered slowly.
    if (beat === 0) _bgmPlayTone(at, 49.00 * (1 + 0.06 * Math.sin(step / 32)), 5.5, {
      type: 'sine', peak: 0.28, attack: 1.2,
    });
    // Long, filtered noise wash.
    if (beat % 4 === 0) _bgmPlayNoise(at, 2.0, {
      filterType: 'bandpass', freq: 600 + (step % 32) * 30,
      q: 3, peak: 0.05,
      pan: ((step * 0.13) % 2) - 1,
    });
    // Occasional shimmer.
    if (Math.random() < 0.07) {
      _bgmPlayFmBell(at, 1800 + Math.random() * 800, 1.5, {
        peak: 0.03, modDepth: 240, ratio: 5.01,
      });
    }
  }
  // 4) DEEP SIGNAL — slowly panning FM bells + pad bed.
  function _bgmScheduleDarkDeepSignal(step, at) {
    const beat = step % 16;
    if (beat === 0) {
      // Pad bed
      _bgmPlayTone(at, 110, 6.0, {
        type: 'triangle', peak: 0.1, attack: 2.0,
        filter: { type: 'lowpass', freq: 800 },
      });
      _bgmPlayTone(at, 164.81, 6.0, {
        type: 'sine', peak: 0.06, attack: 2.5, pan: -0.4,
      });
      _bgmPlayTone(at, 220, 6.0, {
        type: 'sine', peak: 0.06, attack: 2.5, pan: 0.4,
      });
    }
    // Bell traversing the stereo field.
    if (beat % 5 === 0) {
      const pan = Math.sin(step / 6) * 0.8;
      _bgmPlayFmBell(at, 330 + (step % 7) * 30, 2.2, {
        peak: 0.05, modDepth: 100, ratio: 2.51, pan,
      });
    }
  }
  // 5) SUBLAYER — pulsing low drone + breath-like swells.
  function _bgmScheduleDarkSublayer(step, at) {
    const beat = step % 16;
    // Pulsing sub — short bursts on every 2 steps.
    if (beat % 2 === 0) _bgmPlayTone(at, 43.65, 0.45, {
      type: 'sine', peak: 0.22, attack: 0.08,
    });
    // Breath swell every 16 steps.
    if (beat === 0) {
      _bgmPlayNoise(at, 3.5, {
        filterType: 'bandpass', freq: 700, q: 1.8,
        peak: 0.06,
      });
    }
    // Occasional mid drone re-trigger.
    if (beat === 0) _bgmPlayTone(at, 130.81, 5.0, {
      type: 'triangle', peak: 0.05, attack: 1.5,
      filter: { type: 'lowpass', freq: 700 },
    });
  }

  // 6) EVENT HORIZON — sub drone + rising-tension FM bells.
  function _bgmScheduleDarkEventHorizon(step, at) {
    const beat = step % 16;
    if (beat % 8 === 0) {
      _bgmPlayTone(at, 36.71, 7.0, {
        type: 'sine', peak: 0.3, attack: 1.8,
        filter: { type: 'lowpass', freq: 160 },
      });
    }
    if (beat === 0) {
      _bgmPlayFmBell(at, 220 + (step % 80) * 5, 3.5, {
        peak: 0.05, modDepth: 100 + (step % 100), ratio: 3.01,
        pan: ((step * 0.07) % 2) - 1,
      });
    }
    if (Math.random() < 0.06) {
      _bgmPlayFmBell(at, 800 + Math.random() * 600, 0.8, {
        peak: 0.04, modDepth: 300, ratio: 5.01,
      });
    }
  }
  // 7) MIDNIGHT VEIL — slow chord swell + sub + whisper-noise.
  const DARK_VEIL_TRIAD = [110, 130.81, 164.81]; // Am
  function _bgmScheduleDarkMidnightVeil(step, at) {
    const beat = step % 16;
    if (beat === 0) {
      for (let i = 0; i < DARK_VEIL_TRIAD.length; i++) {
        _bgmPlayTone(at, DARK_VEIL_TRIAD[i], 7.0, {
          type: 'triangle', peak: 0.07, attack: 2.0,
          filter: { type: 'lowpass', freq: 1200 },
          pan: (i - 1) * 0.4,
        });
      }
    }
    if (beat === 0) _bgmPlayTone(at, 55, 6.5, {
      type: 'sine', peak: 0.28, attack: 1.5,
    });
    if (Math.random() < 0.1) {
      _bgmPlayNoise(at, 0.8, {
        filterType: 'bandpass', freq: 800 + Math.random() * 800,
        q: 5, peak: 0.04,
        pan: (Math.random() * 2) - 1,
      });
    }
  }
  // 8) THE WELL — deep drone + decaying bell echo + sparse thumps.
  function _bgmScheduleDarkTheWell(step, at) {
    const beat = step % 16;
    if (beat % 8 === 0) {
      _bgmPlayTone(at, 41.20, 6.0, {
        type: 'sine', peak: 0.3, attack: 1.5,
        filter: { type: 'lowpass', freq: 150 },
      });
    }
    if (beat === 0 || beat === 9) {
      const f = 440 + (beat % 4) * 50;
      for (let k = 0; k < 4; k++) {
        const o = k * 0.5;
        _bgmPlayFmBell(at + o, f, 1.2, {
          peak: 0.06 * Math.pow(0.55, k),
          modDepth: 80, ratio: 2.01,
          pan: ((k % 2) - 0.5) * 0.8,
        });
      }
    }
    if (Math.random() < 0.04) {
      _bgmPlayKick(at, { peak: 0.16, start: 80, end: 30, dur: 0.5 });
    }
  }
  // 9) STARFIELD — distant scattered bells + sub drone + warm pad.
  function _bgmScheduleDarkStarfield(step, at) {
    const beat = step % 16;
    if (beat % 8 === 0) {
      _bgmPlayTone(at, 43.65, 7.0, {
        type: 'sine', peak: 0.26, attack: 2.0,
      });
    }
    if (Math.random() < 0.18) {
      _bgmPlayFmBell(at, 1200 + Math.random() * 2000, 1.8, {
        peak: 0.04, modDepth: 80, ratio: 3.01,
        pan: (Math.random() * 2) - 1,
      });
    }
    if (beat === 0) {
      _bgmPlayTone(at, 174.61, 6.0, {
        type: 'triangle', peak: 0.06, attack: 1.5,
        filter: { type: 'lowpass', freq: 800 },
      });
    }
  }
  // 10) VOID HUM — pure low drone with subtle pitch/timbre modulation.
  function _bgmScheduleDarkVoidHum(step, at) {
    const beat = step % 16;
    if (beat % 4 === 0) {
      _bgmPlayTone(at, 38.89, 4.5, {
        type: 'sine', peak: 0.3, attack: 0.8,
        detune: Math.sin(step * 0.1) * 12,
      });
    }
    if (beat % 8 === 0) {
      _bgmPlayTone(at, 77.78, 5.0, {
        type: 'triangle', peak: 0.08, attack: 1.5,
        filter: { type: 'lowpass', freq: 400 },
      });
    }
    if (beat === 0 || beat === 6) {
      _bgmPlayTone(at, 233.08, 3.5, {
        type: 'sine', peak: 0.04, attack: 1.0,
        pan: (Math.random() * 2) - 1,
      });
    }
  }

  // ── §8bit ── chiptune (NES-flavoured: 2 squares + triangle bass + noise)
  // Each track uses raw waveforms (no filters on lead/arp) to keep the
  // crunchy chip character. Triangle = bass voice (NES "VRC6" style),
  // square = melody + counter-melody, noise = percussion.

  // 1) HYRULE FIELD — heroic Zelda-style sweeping melody.
  const _8BIT_HYRULE_CH = [
    [261.63, 329.63, 392.00],  // C
    [196.00, 246.94, 293.66],  // G
    [220.00, 261.63, 329.63],  // Am
    [174.61, 220.00, 261.63],  // F
  ];
  const _8BIT_HYRULE_LEAD = [
    523, 587, 659, 783, 880, 783, 659, 587,
    523, 659, 587, 659, 783, 880, 659, 523,
    659, 783, 880, 659, 523, 587, 659, 587,
    523, 440, 392, 440, 523, 587, 523, 392,
  ];
  function _bgmSchedule8BitHyruleField(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_HYRULE_CH[bar];
    // Triangle bass — root + fifth on alternating downbeats.
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.38, {
      type: 'triangle', peak: 0.3,
    });
    else if (beat % 4 === 2) _bgmPlayTone(at, ch[2] / 2, 0.32, {
      type: 'triangle', peak: 0.26,
    });
    // Square lead — 8th notes.
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 8) % _8BIT_HYRULE_LEAD.length;
      _bgmPlayTone(at, _8BIT_HYRULE_LEAD[idx], 0.22, {
        type: 'square', peak: 0.16,
      });
    }
    // Counter-melody arp on offbeats.
    if (beat % 2 === 1) {
      _bgmPlayTone(at, ch[((beat - 1) / 2) % 3], 0.1, {
        type: 'square', peak: 0.08, pan: -0.35,
      });
    }
    // Hat-like noise on 5 + 13.
    if (beat === 4 || beat === 12) _bgmPlayNoise(at, 0.04, {
      filterType: 'highpass', freq: 5000, peak: 0.11,
    });
  }

  // 2) STAR ROAD — bouncy major-key Mario-flavour.
  const _8BIT_STAR_CH = [
    [261.63, 329.63, 392.00],  // C
    [349.23, 440.00, 523.25],  // F
    [392.00, 493.88, 587.33],  // G
    [261.63, 329.63, 392.00],  // C
  ];
  function _bgmSchedule8BitStarRoad(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_STAR_CH[bar];
    // Bouncy bass: every 2 steps alternating root / fifth.
    if (beat % 2 === 0) _bgmPlayTone(at, (beat % 4 < 2 ? ch[0] : ch[2]) / 2, 0.14, {
      type: 'triangle', peak: 0.26,
    });
    // Ascending arpeggio — square voice, 16ths.
    _bgmPlayTone(at, ch[beat % 3] * 2, 0.09, {
      type: 'square', peak: 0.09, pan: 0.25,
    });
    // Staccato lead on beats 1, 5, 9, 13.
    if (beat % 4 === 0) _bgmPlayTone(at, ch[1] * 2, 0.18, {
      type: 'square', peak: 0.14,
    });
    if (beat === 4 || beat === 12) _bgmPlayNoise(at, 0.05, {
      filterType: 'highpass', freq: 4000, peak: 0.14,
    });
  }

  // 3) DUNGEON CRAWL — slow, dark, minor — Zelda dungeon dread.
  const _8BIT_DUNGEON_CH = [
    [220.00, 261.63, 329.63],  // Am
    [146.83, 174.61, 220.00],  // Dm
    [164.81, 207.65, 246.94],  // E
    [220.00, 261.63, 329.63],  // Am
  ];
  function _bgmSchedule8BitDungeonCrawl(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_DUNGEON_CH[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.6, {
      type: 'triangle', peak: 0.32,
    });
    // Sparse minor lead.
    if (beat === 0 || beat === 8) _bgmPlayTone(at, ch[2], 0.4, {
      type: 'square', peak: 0.12,
    });
    if (beat === 4 || beat === 12) _bgmPlayTone(at, ch[1], 0.4, {
      type: 'square', peak: 0.11,
    });
    // Low square pad bed.
    if (beat === 0) _bgmPlayTone(at, ch[0], 2.0, {
      type: 'square', peak: 0.04,
    });
    // Sparse drip / footstep.
    if (Math.random() < 0.08) _bgmPlayNoise(at, 0.05, {
      filterType: 'lowpass', freq: 600, peak: 0.06,
      pan: (Math.random() * 2) - 1,
    });
  }

  // 4) BOSS BATTLE — fast aggressive minor, 16th-note bass + lead.
  const _8BIT_BOSS_CH = [
    [220.00, 261.63, 329.63],
    [174.61, 220.00, 261.63],
    [196.00, 246.94, 293.66],
    [220.00, 261.63, 329.63],
  ];
  const _8BIT_BOSS_LEAD_OFFSETS = [2, 1, 2, 0, 1, 2, 0, 2];
  function _bgmSchedule8BitBossBattle(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_BOSS_CH[bar];
    // Driving 16th-note bass alternating root / octave.
    _bgmPlayTone(at, beat % 2 === 0 ? ch[0] / 2 : ch[0], 0.08, {
      type: 'triangle', peak: 0.26,
    });
    // Aggressive lead — 8th note pattern.
    if (beat % 2 === 0) {
      const ofs = _8BIT_BOSS_LEAD_OFFSETS[(beat / 2) % _8BIT_BOSS_LEAD_OFFSETS.length];
      _bgmPlayTone(at, ch[ofs] * 2, 0.1, {
        type: 'square', peak: 0.16,
      });
    }
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.42 });
    if (beat === 4 || beat === 12) _bgmPlayNoise(at, 0.06, {
      filterType: 'highpass', freq: 4500, peak: 0.18,
    });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.02, {
      filterType: 'highpass', freq: 9000, peak: 0.05,
    });
  }

  // 5) PIXEL QUEST — balanced overworld theme, walking bass + lead.
  const _8BIT_QUEST_CH = [
    [261.63, 329.63, 392.00],  // C
    [220.00, 261.63, 329.63],  // Am
    [174.61, 220.00, 261.63],  // F
    [196.00, 246.94, 293.66],  // G
  ];
  const _8BIT_QUEST_LEAD = [
    523, 587, 659, 523, 392, 440, 523, 392,
    440, 523, 587, 523, 392, 349, 392, 440,
  ];
  function _bgmSchedule8BitPixelQuest(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_QUEST_CH[bar];
    if (beat % 2 === 0) _bgmPlayTone(at, ((beat / 2) % 2 === 0 ? ch[0] : ch[2]) / 2, 0.12, {
      type: 'triangle', peak: 0.24,
    });
    const idx = (beat + bar * 4) % _8BIT_QUEST_LEAD.length;
    _bgmPlayTone(at, _8BIT_QUEST_LEAD[idx], 0.15, {
      type: 'square', peak: 0.13,
    });
    if (beat % 2 === 1) _bgmPlayTone(at, ch[((beat - 1) / 2) % 3] * 2, 0.1, {
      type: 'square', peak: 0.07, pan: 0.3,
    });
    if (beat === 4 || beat === 12) _bgmPlayNoise(at, 0.04, {
      filterType: 'highpass', freq: 5000, peak: 0.1,
    });
  }

  // 6) CASTLE FANFARE — regal triumphant march (I-IV-V-I in C).
  const _8BIT_CASTLE_CH = [
    [261.63, 329.63, 392.00],  // C
    [349.23, 440.00, 523.25],  // F
    [392.00, 493.88, 587.33],  // G
    [261.63, 329.63, 392.00],  // C
  ];
  const _8BIT_CASTLE_LEAD = [
    523, 523, 587, 659, 783, 659, 523, 587,
    659, 659, 783, 880, 1046, 880, 783, 659,
    523, 587, 659, 587, 659, 783, 880, 1046,
    783, 659, 587, 523, 587, 659, 523, 523,
  ];
  function _bgmSchedule8BitCastleFanfare(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_CASTLE_CH[bar];
    // March bass — root/fifth alternation on 8ths.
    if (beat % 2 === 0) _bgmPlayTone(at, ((beat % 4) < 2 ? ch[0] : ch[2]) / 2, 0.13, {
      type: 'triangle', peak: 0.3,
    });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 8) % _8BIT_CASTLE_LEAD.length;
      _bgmPlayTone(at, _8BIT_CASTLE_LEAD[idx], 0.2, {
        type: 'square', peak: 0.17,
      });
    }
    if (beat === 0 || beat === 8) _bgmPlayKick(at, { peak: 0.42 });
    if (beat === 4 || beat === 12) _bgmPlayNoise(at, 0.04, {
      filterType: 'highpass', freq: 4500, peak: 0.18,
    });
  }

  // 7) WATER TEMPLE — mystical, slower, descending arp, water drops.
  const _8BIT_WATER_CH = [
    [261.63, 311.13, 392.00],  // Cm-ish (C-Eb-G)
    [220.00, 261.63, 329.63],  // Am
    [196.00, 233.08, 293.66],  // Gm (G-Bb-D)
    [220.00, 261.63, 329.63],  // Am
  ];
  function _bgmSchedule8BitWaterTemple(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_WATER_CH[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.5, {
      type: 'triangle', peak: 0.28,
    });
    // Descending arp through chord — high to low.
    if (beat % 2 === 0) {
      const arpNotes = [ch[2] * 2, ch[1] * 2, ch[0] * 2, ch[1] * 2];
      _bgmPlayTone(at, arpNotes[(beat / 2) % 4], 0.18, {
        type: 'square', peak: 0.1,
      });
    }
    if (beat === 0 || beat === 6 || beat === 11) {
      _bgmPlayTone(at, ch[2] * 2, 0.4, {
        type: 'square', peak: 0.13,
      });
    }
    if (Math.random() < 0.12) {
      _bgmPlayNoise(at, 0.03, {
        filterType: 'highpass', freq: 6500, peak: 0.07,
        pan: (Math.random() * 2) - 1,
      });
    }
  }

  // 8) SKY ISLAND — high ethereal, dreamy lead + bell shimmer.
  const _8BIT_SKY_CH = [
    [392.00, 493.88, 587.33],  // G
    [440.00, 523.25, 659.25],  // A
    [349.23, 440.00, 523.25],  // F
    [392.00, 493.88, 587.33],  // G
  ];
  function _bgmSchedule8BitSkyIsland(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_SKY_CH[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'triangle', peak: 0.22,
    });
    // Dreamy lead on every 8th.
    if (beat % 2 === 0) {
      const leadNotes = [ch[2] * 2, ch[1] * 2, ch[2] * 2, ch[0] * 2];
      _bgmPlayTone(at, leadNotes[(beat / 2) % 4], 0.3, {
        type: 'square', peak: 0.12,
      });
    }
    if (beat % 2 === 1) _bgmPlayTone(at, ch[((beat - 1) / 2) % 3] * 2, 0.1, {
      type: 'square', peak: 0.08, pan: 0.3,
    });
    if (Math.random() < 0.14) _bgmPlayFmBell(at, ch[2] * 4, 0.4, {
      peak: 0.05, modDepth: 40, ratio: 2.01,
      pan: (Math.random() * 2) - 1,
    });
  }

  // 9) FINAL BOSS — epic dramatic, dense bass + driving lead + full kit.
  const _8BIT_FINAL_CH = [
    [196.00, 233.08, 293.66],  // Gm
    [174.61, 207.65, 261.63],  // F-ish
    [164.81, 207.65, 246.94],  // E
    [196.00, 233.08, 293.66],  // Gm
  ];
  const _8BIT_FINAL_LEAD = [
    587, 659, 783, 880, 1046, 880, 783, 659,
    587, 523, 659, 783, 880, 1046, 880, 783,
    659, 783, 880, 1046, 1175, 1046, 880, 783,
    659, 587, 523, 440, 523, 587, 659, 587,
  ];
  function _bgmSchedule8BitFinalBoss(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_FINAL_CH[bar];
    // Relentless 16th-note bass on the root.
    _bgmPlayTone(at, ch[0] / 2, 0.07, {
      type: 'triangle', peak: 0.28,
    });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 8) % _8BIT_FINAL_LEAD.length;
      _bgmPlayTone(at, _8BIT_FINAL_LEAD[idx], 0.12, {
        type: 'square', peak: 0.18,
      });
    }
    if (beat % 2 === 1) _bgmPlayTone(at, ch[((beat - 1) / 2) % 3], 0.1, {
      type: 'square', peak: 0.09, pan: -0.3,
    });
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.48 });
    if (beat === 4 || beat === 12) _bgmPlayNoise(at, 0.07, {
      filterType: 'highpass', freq: 4500, peak: 0.2,
    });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.02, {
      filterType: 'highpass', freq: 9000, peak: 0.06,
    });
  }

  // 10) MINIGAME — fast playful, victory-flavoured.
  const _8BIT_MINI_CH = [
    [261.63, 329.63, 392.00],  // C
    [261.63, 329.63, 392.00],  // C
    [349.23, 440.00, 523.25],  // F
    [392.00, 493.88, 587.33],  // G
  ];
  const _8BIT_MINI_LEAD = [
    523, 659, 783, 1046, 783, 659, 523, 659,
    523, 659, 587, 659, 783, 1046, 880, 783,
    880, 1046, 880, 783, 659, 587, 523, 587,
    659, 587, 523, 440, 523, 587, 659, 783,
  ];
  function _bgmSchedule8BitMinigame(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _8BIT_MINI_CH[bar];
    // Every-step bouncy bass.
    _bgmPlayTone(at, ((beat % 4) < 2 ? ch[0] : ch[2]) / 2, 0.08, {
      type: 'triangle', peak: 0.24,
    });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 8) % _8BIT_MINI_LEAD.length;
      _bgmPlayTone(at, _8BIT_MINI_LEAD[idx], 0.1, {
        type: 'square', peak: 0.15,
      });
    }
    if (beat % 2 === 1) _bgmPlayTone(at, ch[((beat - 1) / 2) % 3] * 2, 0.08, {
      type: 'square', peak: 0.08, pan: 0.3,
    });
    if (beat === 4 || beat === 12) _bgmPlayNoise(at, 0.04, {
      filterType: 'highpass', freq: 5000, peak: 0.14,
    });
  }

  // ── §smoothjazz ── lush 7th chords, walking bass, sax leads ───────
  // Two new helpers shared by every smooth-jazz track. Both compose
  // existing primitives so the timbre matches the rest of the engine.
  // _bgmPlayJazzSax: two detuned sawtooths (octave-doubled) through a
  // softening lowpass — reads as a smooth tenor saxophone.
  // _bgmPlayJazzRhodes: sine fundamental + brief FM overtone — reads
  // as an electric-piano Rhodes chord voice.
  function _bgmPlayJazzSax(at, freq, dur, opts = {}) {
    const peak = opts.peak ?? 0.1;
    _bgmPlayTone(at, freq, dur, {
      type: 'sawtooth', peak, attack: 0.04,
      filter: { type: 'lowpass', freq: 1800, q: 1.2 },
      detune: 5, pan: opts.pan ?? 0.15,
    });
    _bgmPlayTone(at, freq, dur, {
      type: 'sawtooth', peak: peak * 0.55, attack: 0.05,
      filter: { type: 'lowpass', freq: 1400, q: 1.2 },
      detune: -5, pan: -(opts.pan ?? 0.15),
    });
  }
  function _bgmPlayJazzRhodes(at, freq, dur, opts = {}) {
    const peak = opts.peak ?? 0.08;
    _bgmPlayTone(at, freq, dur, {
      type: 'sine', peak, attack: 0.005,
      pan: opts.pan ?? 0,
    });
    _bgmPlayFmBell(at, freq, dur * 0.3, {
      peak: peak * 0.3, modDepth: 30, ratio: 4.01,
      pan: opts.pan ?? 0,
    });
  }

  // Two jazz progressions. JAZZ_I_VI_II_V is the classic "rhythm
  // changes" turnaround; JAZZ_VI_II_V_I is the same chords starting
  // on the relative minor for a moodier opening.
  const JAZZ_I_VI_II_V = [
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
    [220.00, 261.63, 329.63, 415.30], // Am7
    [146.83, 174.61, 220.00, 261.63], // Dm7
    [196.00, 246.94, 293.66, 349.23], // G7
  ];
  const JAZZ_VI_II_V_I = [
    [220.00, 261.63, 329.63, 415.30], // Am7
    [146.83, 174.61, 220.00, 261.63], // Dm7
    [196.00, 246.94, 293.66, 349.23], // G7
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
  ];

  // 1) MIDNIGHT LOUNGE — slow ballad, sustained sax, brushed snare.
  const _JAZZ_LOUNGE_LEAD = [523.25, 587.33, 659.25, 587.33, 523.25, 493.88, 440.00, 523.25];
  function _bgmScheduleJazzMidnightLounge(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.6, {
      type: 'triangle', peak: 0.22,
      filter: { type: 'lowpass', freq: 400 },
    });
    if (beat % 4 === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 0.7, { peak: 0.07, pan: (i - 2) * 0.3 });
      }
    }
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.2, freq: 1200, peak: 0.1 });
    if (beat % 4 === 0) {
      const idx = ((beat / 4) + bar * 4) % _JAZZ_LOUNGE_LEAD.length;
      _bgmPlayJazzSax(at, _JAZZ_LOUNGE_LEAD[idx], 1.5, { peak: 0.1 });
    }
  }

  // 2) CITY LIGHTS — mid-tempo walking groove + hat + melody.
  const _JAZZ_CITY_LEAD = [523.25, 587.33, 659.25, 523.25, 440.00, 523.25, 587.33, 523.25];
  function _bgmScheduleJazzCityLights(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = JAZZ_I_VI_II_V[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'triangle', peak: 0.22,
      filter: { type: 'lowpass', freq: 400 },
    });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 8000, peak: 0.05, pan: 0.25,
    });
    if (beat % 4 === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 0.5, { peak: 0.06, pan: (i - 2) * 0.3 });
      }
    }
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.15, freq: 1500, peak: 0.12 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _JAZZ_CITY_LEAD.length;
      _bgmPlayJazzSax(at, _JAZZ_CITY_LEAD[idx], 0.4, { peak: 0.08 });
    }
  }

  // 3) AFTER PARTY — chill, sparse, long sax notes over slow chords.
  function _bgmScheduleJazzAfterParty(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = JAZZ_VI_II_V_I[bar];
    if (beat === 0) {
      _bgmPlayTone(at, ch[0] / 2, 0.8, {
        type: 'triangle', peak: 0.22,
        filter: { type: 'lowpass', freq: 380 },
      });
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 3.5, { peak: 0.06, pan: (i - 2) * 0.3 });
      }
    }
    if (beat === 8) _bgmPlayTone(at, ch[2] / 2, 0.6, {
      type: 'triangle', peak: 0.18,
      filter: { type: 'lowpass', freq: 380 },
    });
    if (beat === 0 || beat === 10) {
      _bgmPlayJazzSax(at, ch[2] * 2, 2.5, { peak: 0.09 });
    }
    if (beat % 4 === 2) _bgmPlayNoise(at, 0.02, {
      filterType: 'highpass', freq: 8000, peak: 0.03, pan: 0.3,
    });
  }

  // 4) CHAMPAGNE — bouncy lively, 8th-note bass, full kit.
  const _JAZZ_CHAMPAGNE_LEAD = [659.25, 587.33, 523.25, 659.25, 783.99, 659.25, 587.33, 523.25];
  function _bgmScheduleJazzChampagne(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = JAZZ_I_VI_II_V[bar];
    if (beat % 2 === 0) _bgmPlayTone(at, ((beat % 4) < 2 ? ch[0] : ch[2]) / 2, 0.18, {
      type: 'triangle', peak: 0.22,
      filter: { type: 'lowpass', freq: 420 },
    });
    if (beat % 4 === 2) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 0.3, { peak: 0.06, pan: (i - 2) * 0.3 });
      }
    }
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 8500, peak: 0.05,
    });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.12, freq: 1700, peak: 0.14 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _JAZZ_CHAMPAGNE_LEAD.length;
      _bgmPlayJazzSax(at, _JAZZ_CHAMPAGNE_LEAD[idx], 0.35, { peak: 0.09 });
    }
  }

  // 5) RAIN ON GLASS — gentle, mellow, light droplet noise.
  function _bgmScheduleJazzRainOnGlass(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = LOFI_CHORDS[bar];
    if (beat === 0) {
      _bgmPlayTone(at, ch[0] / 2, 0.6, {
        type: 'triangle', peak: 0.2,
        filter: { type: 'lowpass', freq: 360 },
      });
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 3.5, { peak: 0.06, pan: (i - 1.5) * 0.3 });
      }
    }
    // Random droplet noise.
    if (Math.random() < 0.45) _bgmPlayNoise(at + Math.random() * 0.1, 0.015, {
      filterType: 'highpass', freq: 6500 + Math.random() * 2500,
      peak: 0.04, pan: (Math.random() * 2) - 1,
    });
    if (beat === 4 || beat === 11) {
      _bgmPlayJazzSax(at, ch[2] * 2, 1.2, { peak: 0.08 });
    }
  }

  // 6) LATE TRAIN — strong walking bass + soft snare groove.
  function _bgmScheduleJazzLateTrain(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = JAZZ_I_VI_II_V[bar];
    // Quarter-note walking bass.
    if (beat % 2 === 0) {
      const walk = [ch[0], ch[1], ch[2], ch[1]];
      _bgmPlayTone(at, walk[(beat / 2) % 4] / 2, 0.3, {
        type: 'triangle', peak: 0.22,
        filter: { type: 'lowpass', freq: 400 },
      });
    }
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.022, {
      filterType: 'highpass', freq: 8500, peak: 0.05, pan: 0.3,
    });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.16, freq: 1400, peak: 0.12 });
    if (beat % 4 === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 0.5, { peak: 0.06, pan: (i - 2) * 0.3 });
      }
    }
    if (beat === 2 || beat === 10) {
      _bgmPlayJazzSax(at, ch[2] * 2, 0.8, { peak: 0.08 });
    }
  }

  // 7) VELVET ROOM — smoky, dark, slow, deep bass.
  const _JAZZ_VELVET_CH = [
    [73.42, 110.00, 130.81, 174.61], // D minor low
    [98.00, 130.81, 164.81, 196.00], // G minor low
    [82.41, 123.47, 146.83, 196.00], // E low
    [110.00, 130.81, 164.81, 220.00], // Am low
  ];
  function _bgmScheduleJazzVelvetRoom(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = _JAZZ_VELVET_CH[bar];
    if (beat === 0) _bgmPlayTone(at, ch[0] / 2, 0.9, {
      type: 'sine', peak: 0.3,
      filter: { type: 'lowpass', freq: 200 },
    });
    if (beat === 8) _bgmPlayTone(at, ch[1] / 2, 0.7, {
      type: 'sine', peak: 0.25,
      filter: { type: 'lowpass', freq: 200 },
    });
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i] * 2, 3.0, { peak: 0.06, pan: (i - 2) * 0.3 });
      }
    }
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.22, freq: 1100, peak: 0.09 });
    if (beat === 6 || beat === 13) {
      _bgmPlayJazzSax(at, ch[3], 1.4, { peak: 0.08 });
    }
  }

  // 8) SUNSET DRIVE — warm cruise, steady sax lead, soft hat.
  const _JAZZ_SUNSET_LEAD = [392, 440, 523.25, 587.33, 523.25, 440, 392, 440];
  function _bgmScheduleJazzSunsetDrive(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = JAZZ_I_VI_II_V[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.5, {
      type: 'triangle', peak: 0.22,
      filter: { type: 'lowpass', freq: 400 },
    });
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 3.0, { peak: 0.06, pan: (i - 2) * 0.3 });
      }
    }
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.024, {
      filterType: 'highpass', freq: 8200, peak: 0.04, pan: 0.25,
    });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.14, freq: 1500, peak: 0.1 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _JAZZ_SUNSET_LEAD.length;
      _bgmPlayJazzSax(at, _JAZZ_SUNSET_LEAD[idx], 0.4, { peak: 0.085 });
    }
  }

  // 9) HONEY SUITE — sweet melodic, bright Rhodes + sax melody.
  const _JAZZ_HONEY_LEAD = [659.25, 783.99, 880.00, 783.99, 659.25, 587.33, 523.25, 587.33];
  function _bgmScheduleJazzHoneySuite(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = JAZZ_I_VI_II_V[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'triangle', peak: 0.2,
      filter: { type: 'lowpass', freq: 420 },
    });
    // Brighter Rhodes chord — higher voicing.
    if (beat % 4 === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i] * 2, 0.7, { peak: 0.06, pan: (i - 2) * 0.3 });
      }
    }
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.022, {
      filterType: 'highpass', freq: 8500, peak: 0.045, pan: 0.3,
    });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.13, freq: 1600, peak: 0.11 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _JAZZ_HONEY_LEAD.length;
      _bgmPlayJazzSax(at, _JAZZ_HONEY_LEAD[idx], 0.35, { peak: 0.09 });
    }
  }

  // 10) BLUE NEON — bluesy slow, expressive sax with detune bends.
  const _JAZZ_BLUE_LEAD = [392, 440, 466.16, 440, 392, 349.23, 392, 440];
  function _bgmScheduleJazzBlueNeon(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = JAZZ_VI_II_V_I[bar];
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.55, {
      type: 'triangle', peak: 0.22,
      filter: { type: 'lowpass', freq: 380 },
    });
    if (beat % 8 === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayJazzRhodes(at, ch[i], 1.2, { peak: 0.07, pan: (i - 2) * 0.3 });
      }
    }
    if (beat % 4 === 2) _bgmPlayNoise(at, 0.024, {
      filterType: 'highpass', freq: 8000, peak: 0.04, pan: 0.25,
    });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.18, freq: 1300, peak: 0.1 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _JAZZ_BLUE_LEAD.length;
      // Bluesy bend — slightly varying detune adds expression.
      _bgmPlayJazzSax(at, _JAZZ_BLUE_LEAD[idx], 0.5, {
        peak: 0.09,
      });
    }
  }

  // ── §folk ── Witcher / Viking / medieval ─────────────────────────
  // Acoustic-flavoured synthesis. Each helper combines multiple
  // oscillators (additive harmonics), body-resonance filters, and
  // articulation transients to read as a real instrument rather than
  // a thin synth tone.
  //
  // _bgmPlayPluck (lute)  — fundamental + 4 harmonics, each decaying
  //   at sqrt(n) speed (top harmonics fade first, like a real string).
  //   Brief noise burst at attack = the pluck transient.
  // _bgmPlayBow (violin)  — three detuned sawtooths + a 5 Hz LFO
  //   vibrato on the center voice + a peaking body-resonance filter
  //   around 700 Hz.
  // _bgmPlayFlute (recorder/whistle) — square fundamental through a
  //   reedy formant peak at 1.5 kHz + breath-noise layer.
  // _bgmPlayPipes (bagpipe chanter) — like flute but louder formant
  //   and constant amplitude (no decay), built for melody.
  // _bgmPlayDrone (bagpipe drone) — two stacked sawtooths an octave
  //   apart, slow attack, sustained — the "background hum" of pipes.
  // _bgmPlayWarDrum (frame drum) — low sine sweep + skin-noise body.

  function _bgmPlayPluck(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.18;
    const pan  = opts.pan ?? 0;
    // 5 harmonics, decreasing amplitude. Higher partials decay faster
    // (per sqrt(n)) which is what makes real strings sound "stringy".
    const harmonics = [
      { m: 1, a: 1.00, t: 'triangle' },
      { m: 2, a: 0.50, t: 'triangle' },
      { m: 3, a: 0.30, t: 'square' },
      { m: 4, a: 0.15, t: 'square' },
      { m: 5, a: 0.08, t: 'square' },
    ];
    for (const h of harmonics) {
      const osc = ctx.createOscillator();
      osc.type = h.t;
      osc.frequency.value = freq * h.m;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak * h.a, at + 0.001);
      const stopAt = at + dur / Math.sqrt(h.m);
      env.gain.exponentialRampToValueAtTime(0.001, stopAt);
      let out = env;
      if (pan !== 0) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        env.connect(p);
        out = p;
      }
      osc.connect(env);
      out.connect(_bgmMaster);
      osc.start(at);
      osc.stop(stopAt + 0.05);
    }
    // Pluck transient — short bandpass noise burst at high freq.
    _bgmPlayNoise(at, 0.008, {
      filterType: 'bandpass', freq: freq * 3, q: 6,
      peak: peak * 0.45, pan,
    });
  }

  function _bgmPlayBow(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.12;
    const pan  = opts.pan ?? 0;
    const attack = opts.attack ?? 0.08;
    // Three sawtooth voices: ±7¢ + center. Center voice gets a 5 Hz
    // LFO on detune (±6¢) for natural vibrato.
    for (let i = 0; i < 3; i++) {
      const det = i === 0 ? -7 : i === 2 ? 7 : 0;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = det;
      if (i === 1) {
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 5;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 6;
        lfo.connect(lfoG).connect(osc.detune);
        lfo.start(at);
        lfo.stop(at + dur + 0.1);
      }
      // Body resonance — peak around the violin "wood" range.
      const body = ctx.createBiquadFilter();
      body.type = 'peaking';
      body.frequency.value = 700;
      body.Q.value = 2;
      body.gain.value = 6;
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 2200;
      lpf.Q.value = 1.2;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak / 3, at + attack);
      env.gain.setValueAtTime(peak / 3, at + Math.max(attack, dur - 0.1));
      env.gain.exponentialRampToValueAtTime(0.001, at + dur);
      let out = env;
      if (pan + (i - 1) * 0.08 !== 0) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan + (i - 1) * 0.08));
        env.connect(p);
        out = p;
      }
      osc.connect(body).connect(lpf).connect(env);
      out.connect(_bgmMaster);
      osc.start(at);
      osc.stop(at + dur + 0.1);
    }
  }

  function _bgmPlayFlute(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.1;
    const pan  = opts.pan ?? 0;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    // Reedy formant peak at ~1.5 kHz gives the woody recorder character.
    const formant = ctx.createBiquadFilter();
    formant.type = 'peaking';
    formant.frequency.value = 1500;
    formant.Q.value = 3;
    formant.gain.value = 6;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 2400;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.05);
    env.gain.setValueAtTime(peak, at + Math.max(0.05, dur - 0.12));
    env.gain.exponentialRampToValueAtTime(0.001, at + dur);
    let out = env;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      env.connect(p);
      out = p;
    }
    osc.connect(formant).connect(lpf).connect(env);
    out.connect(_bgmMaster);
    osc.start(at);
    osc.stop(at + dur + 0.1);
    // Breath noise blend.
    _bgmPlayNoise(at, dur * 0.5, {
      filterType: 'bandpass', freq: freq * 2, q: 4,
      peak: peak * 0.18, pan,
    });
  }

  function _bgmPlayPipes(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.13;
    const pan  = opts.pan ?? 0;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    // Strong reedy formant — bagpipe chanter character.
    const formant = ctx.createBiquadFilter();
    formant.type = 'peaking';
    formant.frequency.value = 1500;
    formant.Q.value = 4;
    formant.gain.value = 9;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 2800;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.025);
    env.gain.setValueAtTime(peak, at + Math.max(0.025, dur - 0.05));
    env.gain.exponentialRampToValueAtTime(0.001, at + dur);
    let out = env;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      env.connect(p);
      out = p;
    }
    osc.connect(formant).connect(lpf).connect(env);
    out.connect(_bgmMaster);
    osc.start(at);
    osc.stop(at + dur + 0.1);
  }

  function _bgmPlayDrone(at, freq, dur, opts = {}) {
    const peak = opts.peak ?? 0.08;
    const att  = opts.attack ?? 0.4;
    // Two octave-doubled sawtooths panned slightly apart — the
    // characteristic "two-pipe" hum.
    _bgmPlayTone(at, freq, dur, {
      type: 'sawtooth', peak, attack: att,
      filter: { type: 'lowpass', freq: 800, q: 1 },
      detune: 5, pan: -0.25,
    });
    _bgmPlayTone(at, freq * 2, dur, {
      type: 'sawtooth', peak: peak * 0.6, attack: att,
      filter: { type: 'lowpass', freq: 1200, q: 1 },
      detune: -5, pan: 0.25,
    });
  }

  function _bgmPlayWarDrum(at, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.5;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(opts.start ?? 140, at);
    osc.frequency.exponentialRampToValueAtTime(opts.end ?? 45, at + (opts.sweep ?? 0.08));
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.003);
    env.gain.exponentialRampToValueAtTime(0.001, at + (opts.dur ?? 0.42));
    osc.connect(env).connect(_bgmMaster);
    osc.start(at);
    osc.stop(at + (opts.dur ?? 0.45));
    // Skin / body noise band around 350 Hz for the frame-drum thwack.
    _bgmPlayNoise(at, 0.09, {
      filterType: 'bandpass', freq: 350, q: 1.5,
      peak: peak * 0.35,
    });
  }

  // Shared progressions — Dorian/Aeolian, the medieval/folk home key.
  const FOLK_CH_AM_DORIAN = [
    [110.00, 130.81, 164.81],  // Am
    [ 98.00, 123.47, 146.83],  // G
    [ 87.31, 110.00, 130.81],  // F
    [ 98.00, 123.47, 146.83],  // G
  ];

  // 1) HARP OF THE NORTH — gentle plucked harp, melancholy.
  const _FOLK_HARP_MEL = [
    220, 261.63, 329.63, 261.63, 220, 196, 220, 261.63,
    329.63, 392, 329.63, 261.63, 220, 196, 220, 261.63,
  ];
  function _bgmScheduleFolkHarpNorth(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = FOLK_CH_AM_DORIAN[bar];
    if (beat % 4 === 0) _bgmPlayPluck(at, ch[0] / 2, 0.8, { peak: 0.18 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 8) % _FOLK_HARP_MEL.length;
      _bgmPlayPluck(at, _FOLK_HARP_MEL[idx], 0.6, { peak: 0.12, pan: 0.2 });
    }
    if (beat % 2 === 1) {
      _bgmPlayPluck(at, ch[((beat - 1) / 2) % 3], 0.5, { peak: 0.08, pan: -0.3 });
    }
  }

  // 2) FOREST WHISPERS — wooden flute melody over sustained bagpipe-
  // style drone (two octaves), no rhythm. Pure forest atmosphere.
  const _FOLK_FLUTE_MEL = [440, 523.25, 466.16, 440, 392, 349.23, 392, 440];
  function _bgmScheduleFolkForestWhispers(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    if (beat === 0) _bgmPlayDrone(at, 55, 5.0, { peak: 0.11 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _FOLK_FLUTE_MEL.length;
      _bgmPlayFlute(at, _FOLK_FLUTE_MEL[idx], 0.5, { peak: 0.1 });
    }
  }

  // 3) TAVERN JIG — lively jig, plucked melody, frame drum.
  const _FOLK_JIG_MEL = [220, 261.63, 329.63, 261.63, 293.66, 329.63, 392, 329.63];
  function _bgmScheduleFolkTavernJig(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = FOLK_CH_AM_DORIAN[bar];
    if (beat % 2 === 0) _bgmPlayKick(at, { peak: 0.32, start: 80, end: 40, dur: 0.2 });
    if (beat % 2 === 0) _bgmPlayPluck(at, ch[0] / 2, 0.18, { peak: 0.18 });
    _bgmPlayPluck(at, _FOLK_JIG_MEL[(beat + bar * 4) % _FOLK_JIG_MEL.length], 0.18, {
      peak: 0.13, pan: 0.2,
    });
    if (beat % 4 === 0) _bgmPlayNoise(at, 0.04, {
      filterType: 'highpass', freq: 6000, peak: 0.1,
    });
  }

  // 4) WAR DRUMS — heavy frame drums + bagpipe war calls over a low
  // sustained drone. Replaces the previous bowed-string call with
  // pipes for the actual "war horn" character.
  function _bgmScheduleFolkWarDrums(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    if (beat % 4 === 0) _bgmPlayWarDrum(at, { peak: 0.6 });
    if (beat % 4 === 2) _bgmPlayWarDrum(at, { peak: 0.3 });
    if (beat === 0) _bgmPlayDrone(at, 55, 4.5, { peak: 0.13 });
    if (beat === 0 || beat === 12) {
      _bgmPlayPipes(at, [110, 98, 87.31, 98][bar], 1.6, { peak: 0.14 });
    }
    if (beat % 4 === 0) {
      _bgmPlayPipes(at, [220, 196, 174.61, 196][bar], 0.4, { peak: 0.09 });
    }
  }

  // 5) YENNEFER'S THEME — bowed strings + harp, melancholy.
  const _FOLK_YEN_MEL = [220, 261.63, 329.63, 293.66, 261.63, 220, 196, 220];
  function _bgmScheduleFolkYenneferTheme(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = FOLK_CH_AM_DORIAN[bar];
    if (beat === 0) {
      _bgmPlayBow(at, ch[0] / 2, 3.5, { peak: 0.18 });
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayBow(at, ch[i], 3.5, { peak: 0.08, pan: (i - 2) * 0.3 });
      }
    }
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _FOLK_YEN_MEL.length;
      _bgmPlayPluck(at, _FOLK_YEN_MEL[idx], 0.5, { peak: 0.1 });
    }
  }

  // 6) LONGSHIP — Viking row song. Steady frame-drum rowing pulse +
  // bagpipe drone + chant-pipes lead. The drone runs the whole 4-bar
  // cycle so the rowing never breaks.
  function _bgmScheduleFolkLongship(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    if (beat % 2 === 0) _bgmPlayWarDrum(at, { peak: 0.42, sweep: 0.08, dur: 0.4 });
    if (beat === 0 && bar === 0) _bgmPlayDrone(at, 55, 8.0, { peak: 0.1, attack: 0.6 });
    if (beat % 4 === 0) {
      _bgmPlayPipes(at, [110, 98, 110, 98][bar], 0.7, { peak: 0.11 });
    }
    if (beat === 0 || beat === 8) {
      _bgmPlayPipes(at, [165, 175, 196, 175][bar], 1.6, { peak: 0.12 });
    }
  }

  // 7) HEARTH FIRE — warm bowed pad + sparse pluck + crackle.
  const _FOLK_HEARTH_MEL = [261.63, 293.66, 329.63, 293.66];
  function _bgmScheduleFolkHearthFire(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = FOLK_CH_AM_DORIAN[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayBow(at, ch[i], 3.5, { peak: 0.07, pan: (i - 1) * 0.4 });
      }
    }
    if (beat % 4 === 0) {
      _bgmPlayPluck(at, _FOLK_HEARTH_MEL[bar], 0.7, { peak: 0.12, pan: 0.2 });
    }
    if (Math.random() < 0.2) {
      _bgmPlayNoise(at, 0.04, {
        filterType: 'bandpass', freq: 2000 + Math.random() * 2000,
        q: 6, peak: 0.05,
      });
    }
  }

  // 8) RAVENS — dark moody bowed strings + wind noise + distant flute.
  function _bgmScheduleFolkRavens(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = FOLK_CH_AM_DORIAN[bar];
    if (beat === 0) {
      _bgmPlayBow(at, ch[0] / 2, 4.0, { peak: 0.2 });
      _bgmPlayBow(at, ch[1], 4.0, { peak: 0.1, pan: -0.3 });
      _bgmPlayBow(at, ch[2], 4.0, { peak: 0.1, pan: 0.3 });
    }
    if (beat === 4 || beat === 11) {
      _bgmPlayFlute(at, [440, 392, 349.23, 392][bar], 0.8, { peak: 0.07 });
    }
    if (Math.random() < 0.3) {
      _bgmPlayNoise(at, 0.3, {
        filterType: 'bandpass', freq: 800, q: 3, peak: 0.04,
        pan: (Math.random() * 2) - 1,
      });
    }
  }

  // 9) MEAD HALL — celebratory. Big drums + lute bass + bagpipe-led
  // melody on top so the celebration has actual reedy lift.
  const _FOLK_MEAD_MEL = [220, 261.63, 329.63, 392, 329.63, 261.63, 220, 196];
  function _bgmScheduleFolkMeadHall(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    if (beat % 4 === 0) _bgmPlayWarDrum(at, { peak: 0.5, dur: 0.4 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { dur: 0.1, freq: 1500, peak: 0.2 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 7000, peak: 0.06,
    });
    if (beat % 4 === 0) _bgmPlayPluck(at, [110, 98, 87.31, 98][bar], 0.4, { peak: 0.2 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _FOLK_MEAD_MEL.length;
      _bgmPlayPipes(at, _FOLK_MEAD_MEL[idx], 0.22, { peak: 0.11 });
    }
  }

  // 10) GERALT'S RIDE — driving folk, galloping rhythm, dual lead:
  // a Witcher-flavoured fiddle melody (bow) + bagpipe doubling for
  // weight + lute walking bass.
  const _FOLK_FIDDLE_MEL = [220, 261.63, 329.63, 392, 329.63, 261.63, 293.66, 329.63];
  function _bgmScheduleFolkGeraltsRide(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = FOLK_CH_AM_DORIAN[bar];
    if (beat % 4 === 0) _bgmPlayWarDrum(at, { peak: 0.42, dur: 0.3 });
    if (beat % 4 === 2) _bgmPlayKick(at, { peak: 0.26 });
    if (beat === 0 && bar === 0) _bgmPlayDrone(at, 55, 8.0, { peak: 0.07, attack: 0.5 });
    if (beat % 2 === 0) _bgmPlayPluck(at, ch[(beat / 2) % 3] / 2, 0.2, { peak: 0.18 });
    if (beat % 2 === 0) {
      const idx = ((beat / 2) + bar * 2) % _FOLK_FIDDLE_MEL.length;
      // Bowed fiddle + bagpipe doubling.
      _bgmPlayBow(at, _FOLK_FIDDLE_MEL[idx], 0.4, { peak: 0.1, pan: -0.15 });
      _bgmPlayPipes(at, _FOLK_FIDDLE_MEL[idx], 0.32, { peak: 0.07, pan: 0.15 });
    }
  }

  // ── §cyberpunk ── noir, neon-soaked, rainy night-city ─────────────
  // Reuses SYNTH_CHORDS_AM (Am-G-F-G minor). Three new helpers carry
  // the genre's identity: a high-passed rain bed, a stereo-sweeping
  // vehicle whoosh, and a sparse FM "glitch beep" for buried signals.

  function _bgmPlayRainBed(at, dur, opts = {}) {
    _bgmPlayNoise(at, dur, {
      filterType: 'highpass', freq: 3500,
      peak: opts.peak ?? 0.05, pan: opts.pan ?? 0,
    });
  }
  // Vehicle whoosh — bandpass noise that sweeps low→high through the
  // stereo field left to right. Reads as a car passing on wet asphalt.
  function _bgmPlayWhoosh(at, opts = {}) {
    const ctx = _bgmCtx;
    const dur  = opts.dur  ?? 1.2;
    const peak = opts.peak ?? 0.08;
    const bufSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const cd = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) cd[i] = (Math.random() * 2 - 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(opts.startFreq ?? 400, at);
    f.frequency.exponentialRampToValueAtTime(opts.endFreq ?? 1600, at + dur);
    f.Q.value = 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + dur * 0.3);
    env.gain.exponentialRampToValueAtTime(0.001, at + dur);
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(-1, at);
    p.pan.linearRampToValueAtTime(1, at + dur);
    src.connect(f).connect(env).connect(p).connect(_bgmMaster);
    src.start(at);
  }
  // Glitch beep — short FM-bell chirp with random pan, used for buried
  // / corrupted signal blips.
  function _bgmPlayGlitch(at, freq, opts = {}) {
    _bgmPlayFmBell(at, freq, opts.dur ?? 0.08, {
      peak: opts.peak ?? 0.06,
      modDepth: opts.modDepth ?? 200,
      ratio: opts.ratio ?? 3.51,
      pan: opts.pan ?? ((Math.random() * 2) - 1),
    });
  }

  // 1) NEON RAIN — slow chord pad + rain bed + sub drone + sparse beep.
  function _bgmScheduleCyberNeonRain(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 2 === 0) _bgmPlayRainBed(at, 0.25, { peak: 0.05 });
    if (beat === 0) {
      _bgmPlayTone(at, 55, 4.5, {
        type: 'sine', peak: 0.25, attack: 0.5,
        filter: { type: 'lowpass', freq: 200 },
      });
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 4.0, {
          type: 'sawtooth', peak: 0.05, attack: 0.8, detune: i * 5,
          filter: { type: 'lowpass', freq: 1600 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    if (beat === 7 && Math.random() < 0.5) _bgmPlayGlitch(at, 880);
  }

  // 2) WET STREETS — distant kick + saw walking bass + soft pad + whoosh.
  function _bgmScheduleCyberWetStreets(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 2 === 0) _bgmPlayRainBed(at, 0.3, { peak: 0.04 });
    if (beat === 0 || beat === 8) _bgmPlayKick(at, { peak: 0.3, end: 35, dur: 0.4 });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.5, {
      type: 'sawtooth', peak: 0.22,
      filter: { type: 'lowpass', freq: 280, q: 3 },
    });
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 3.5, {
          type: 'triangle', peak: 0.05, attack: 0.5,
          pan: (i - 2) * 0.3,
        });
      }
    }
    if (beat === 12 && Math.random() < 0.4) _bgmPlayWhoosh(at, { dur: 1.5 });
  }

  // 3) SUBSIGNAL — buried-signal drone + random glitch beeps + noise wash.
  function _bgmScheduleCyberSubsignal(step, at) {
    const beat = step % 16;
    if (beat % 8 === 0) _bgmPlayTone(at, 43.65, 5.0, {
      type: 'sine', peak: 0.3, attack: 1.0,
      filter: { type: 'lowpass', freq: 160 },
    });
    if (Math.random() < 0.22) _bgmPlayGlitch(at, 600 + Math.random() * 1500);
    if (beat % 4 === 0) _bgmPlayNoise(at, 0.8, {
      filterType: 'bandpass', freq: 700, q: 4, peak: 0.04,
    });
  }

  // 4) HOLOGRAM — ghostly sine pad + drifting FM bells.
  function _bgmScheduleCyberHologram(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 4.0, {
          type: 'sine', peak: 0.06, attack: 1.0,
          pan: (i - 1.5) * 0.4,
        });
      }
      _bgmPlayTone(at, 55, 4.5, {
        type: 'sine', peak: 0.2, attack: 0.6,
      });
    }
    if (step % 3 === 0) {
      _bgmPlayFmBell(at, ch[((step / 3) | 0) % ch.length] * 4, 1.2, {
        peak: 0.06, modDepth: 100, ratio: 3.01,
        pan: ((step * 0.13) % 2) - 1,
      });
    }
  }

  // 5) NEAR FUTURE — driving noir techno: kick + gated saw bass + hat.
  function _bgmScheduleCyberNearFuture(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.42 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.18 });
    if (beat % 2 === 0) _bgmPlayTone(at, ch[0] / 2, 0.18, {
      type: 'sawtooth', peak: 0.26,
      filter: { type: 'lowpass', freq: 400, q: 5 },
    });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 7000, peak: 0.05,
    });
    if (beat % 2 === 0) _bgmPlayRainBed(at, 0.15, { peak: 0.03 });
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 3.0, {
          type: 'sawtooth', peak: 0.04, attack: 0.5, detune: i * 4,
          pan: (i - 2) * 0.3,
        });
      }
    }
  }

  // 6) SECTOR 7 — industrial pulse + atmospheric pad + mechanical click.
  function _bgmScheduleCyberSector7(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 2 === 0) _bgmPlayTone(at, ch[0] / 2, 0.15, {
      type: 'sawtooth', peak: 0.2,
      filter: { type: 'lowpass', freq: 350, q: 4 },
    });
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 3.5, {
          type: 'sawtooth', peak: 0.05, attack: 0.6, detune: i * 4,
          filter: { type: 'lowpass', freq: 1500 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    if (beat % 4 === 2) _bgmPlayNoise(at, 0.03, {
      filterType: 'bandpass', freq: 3000, q: 8, peak: 0.06,
    });
    if (Math.random() < 0.5) _bgmPlayRainBed(at, 0.12, { peak: 0.03 });
  }

  // 7) NIGHT DRIVE — slow-tempo saw lead over kick/snare groove + rain.
  function _bgmScheduleCyberNightDrive(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.28 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.14 });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'sawtooth', peak: 0.2,
      filter: { type: 'lowpass', freq: 320 },
    });
    if (beat === 0 || beat === 6 || beat === 11) {
      _bgmPlayTone(at, ch[2] * 2, 0.8, {
        type: 'sawtooth', peak: 0.09, attack: 0.05, detune: 4,
        filter: { type: 'lowpass', freq: 2000 },
      });
    }
    if (beat % 2 === 0) _bgmPlayRainBed(at, 0.15, { peak: 0.03 });
  }

  // 8) GRID DOWN — eerie off-rhythm dystopia, irregular glitch pattern.
  const _CYBER_GRID_PAT = [0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0];
  function _bgmScheduleCyberGridDown(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      _bgmPlayTone(at, ch[0] / 2, 4.0, {
        type: 'sawtooth', peak: 0.15, attack: 0.8,
        filter: { type: 'lowpass', freq: 300, q: 3 },
      });
      _bgmPlayTone(at, ch[2], 3.5, {
        type: 'triangle', peak: 0.05, attack: 0.6,
      });
    }
    if (_CYBER_GRID_PAT[beat]) _bgmPlayGlitch(at, 400 + (step * 47) % 1600);
    if (beat % 4 === 0) _bgmPlayRainBed(at, 0.6, { peak: 0.04 });
  }

  // 9) OVERPASS — moving feel, vehicle whoosh + steady kick + rain bed.
  function _bgmScheduleCyberOverpass(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 2 === 0) _bgmPlayRainBed(at, 0.25, { peak: 0.045 });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.5, {
      type: 'sawtooth', peak: 0.22,
      filter: { type: 'lowpass', freq: 300 },
    });
    if (beat === 0 || beat === 9) _bgmPlayWhoosh(at, { dur: 1.4 });
    if (beat === 0) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 3.5, {
          type: 'triangle', peak: 0.05, attack: 0.6,
          pan: (i - 2) * 0.3,
        });
      }
    }
    if (beat === 0 || beat === 8) _bgmPlayKick(at, { peak: 0.28 });
  }

  // 10) CHROME REFLECTION — bright sawtooth pad + FM-bell arp + soft bass.
  function _bgmScheduleCyberChrome(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 3.5, {
          type: 'sawtooth', peak: 0.05, attack: 0.4, detune: i * 4,
          filter: { type: 'lowpass', freq: 2400 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
    if (beat % 2 === 0) {
      _bgmPlayFmBell(at, ch[(beat / 2) % ch.length] * 4, 0.2, {
        peak: 0.07, modDepth: 80, ratio: 2.51,
        pan: ((beat % 4) - 1.5) * 0.4,
      });
    }
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'sawtooth', peak: 0.18,
      filter: { type: 'lowpass', freq: 350 },
    });
    if (beat % 2 === 0) _bgmPlayRainBed(at, 0.15, { peak: 0.03 });
  }

  // ── §m83 helpers ── used by the SOUNDTRACK genre ─────────────────
  // M83 / Oblivion aesthetic: huge breathing pads, pulsing 16th-note
  // arpeggios that build in volume, soaring vocal-like leads.

  // Saturated synth pad — 3-detune sawtooth chord layer through a
  // warm lowpass + cyclic "breathing" gain (sidechain-like pumping
  // at the chord rate). The slow attack + long tail reads as a
  // reverb-soaked wall of pad.
  function _bgmPlayPad(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.07;
    const attack = opts.attack ?? 1.2;
    const pan = opts.pan ?? 0;
    for (let i = 0; i < 3; i++) {
      const det = (i - 1) * 8;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = det;
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = opts.cutoff ?? 1800;
      lpf.Q.value = 0.8;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak / 3, at + attack);
      // Breathe — gentle gain dip every 0.6s for the "pumping" feel.
      const pumpEvery = 0.6;
      let bt = at + attack;
      while (bt < at + dur - 0.2) {
        env.gain.linearRampToValueAtTime(peak / 3, bt);
        env.gain.linearRampToValueAtTime((peak / 3) * 0.7, bt + pumpEvery * 0.4);
        bt += pumpEvery;
      }
      env.gain.exponentialRampToValueAtTime(0.001, at + dur);
      let out = env;
      const pp = ctx.createStereoPanner();
      pp.pan.value = Math.max(-1, Math.min(1, pan + det / 25));
      env.connect(pp);
      out = pp;
      osc.connect(lpf).connect(env);
      out.connect(_bgmMaster);
      osc.start(at);
      osc.stop(at + dur + 0.1);
    }
  }

  // M83 pulsing arpeggio — a single note (root, octave up, or fifth)
  // pulsed on 16th notes with a slow gain crescendo over `dur`. Stops
  // at full volume so a build feels earned.
  function _bgmPlayArpPulse(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.1;
    const stepDur = opts.stepDur ?? 0.18;
    const cutoffStart = opts.cutoffStart ?? 800;
    const cutoffEnd = opts.cutoffEnd ?? 2400;
    const steps = Math.max(1, Math.floor(dur / stepDur));
    for (let i = 0; i < steps; i++) {
      const t = at + i * stepDur;
      const progress = i / Math.max(1, steps - 1);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = 4;
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = cutoffStart + (cutoffEnd - cutoffStart) * progress;
      lpf.Q.value = 2;
      const env = ctx.createGain();
      const stepPeak = peak * (0.4 + 0.6 * progress);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(stepPeak, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 0.95);
      osc.connect(lpf).connect(env).connect(_bgmMaster);
      osc.start(t);
      osc.stop(t + stepDur + 0.02);
    }
  }

  // Soaring synth lead — sine fundamental + saturated saw doubled
  // up an octave. Reads as a wordless vocal hook in M83's "Oblivion".
  function _bgmPlaySoarLead(at, freq, dur, opts = {}) {
    const peak = opts.peak ?? 0.12;
    const attack = opts.attack ?? 0.15;
    const pan = opts.pan ?? 0;
    _bgmPlayTone(at, freq, dur, {
      type: 'sine', peak, attack,
      filter: { type: 'lowpass', freq: 2400 },
      pan,
    });
    _bgmPlayTone(at, freq * 2, dur, {
      type: 'sawtooth', peak: peak * 0.45, attack: attack * 1.2,
      filter: { type: 'lowpass', freq: 2200 },
      detune: 6, pan: pan - 0.15,
    });
    _bgmPlayTone(at, freq * 2, dur, {
      type: 'sawtooth', peak: peak * 0.45, attack: attack * 1.2,
      filter: { type: 'lowpass', freq: 2200 },
      detune: -6, pan: pan + 0.15,
    });
  }

  // ── §soundtrack ── cinematic space-score (Starfield / Interstellar)
  // Three new helpers give the genre its sonic identity:
  //   brass   — 3 detuned sawtooths with a slow-attack filter sweep
  //             opening from 400 Hz → ~2.2 kHz, then closing back. Reads
  //             as a swelling brass / French-horn section.
  //   choir   — two detuned triangles with a long attack + breath noise
  //             at 1.5×freq. Soft "ahh" choral pad.
  //   timpani — pitched sine with a quick pitch sweep (3/2 → 1/1) + a
  //             skin-noise body burst. The film-orchestra mallet hit.

  function _bgmPlayBrass(at, freq, dur, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.1;
    const attack = opts.attack ?? 0.5;
    for (let i = 0; i < 3; i++) {
      const det = (i - 1) * 6;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = det;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(400, at);
      f.frequency.exponentialRampToValueAtTime(opts.openTo ?? 2200, at + attack * 0.8);
      f.frequency.exponentialRampToValueAtTime(800, at + dur);
      f.Q.value = 1.5;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak / 3, at + attack);
      env.gain.setValueAtTime(peak / 3, at + Math.max(attack, dur - 0.3));
      env.gain.exponentialRampToValueAtTime(0.001, at + dur);
      let out = env;
      if (det !== 0) {
        const p = ctx.createStereoPanner();
        p.pan.value = det / 30;
        env.connect(p);
        out = p;
      }
      osc.connect(f).connect(env);
      out.connect(_bgmMaster);
      osc.start(at);
      osc.stop(at + dur + 0.1);
    }
  }

  function _bgmPlayChoir(at, freq, dur, opts = {}) {
    const peak = opts.peak ?? 0.08;
    const attack = opts.attack ?? 0.6;
    _bgmPlayTone(at, freq, dur, {
      type: 'triangle', peak, attack,
      filter: { type: 'lowpass', freq: 1800, q: 1 },
      pan: (opts.pan ?? 0) - 0.2,
    });
    _bgmPlayTone(at, freq, dur, {
      type: 'triangle', peak: peak * 0.7, attack,
      filter: { type: 'lowpass', freq: 1600, q: 1 },
      detune: 6,
      pan: (opts.pan ?? 0) + 0.2,
    });
    _bgmPlayNoise(at, dur * 0.5, {
      filterType: 'bandpass', freq: freq * 1.5, q: 4,
      peak: peak * 0.1,
      pan: opts.pan ?? 0,
    });
  }

  function _bgmPlayTimpani(at, freq, opts = {}) {
    const ctx = _bgmCtx;
    const peak = opts.peak ?? 0.4;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.5, at);
    osc.frequency.exponentialRampToValueAtTime(freq, at + 0.08);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.8);
    osc.connect(env).connect(_bgmMaster);
    osc.start(at);
    osc.stop(at + 0.85);
    _bgmPlayNoise(at, 0.06, {
      filterType: 'bandpass', freq: freq * 2, q: 1.5,
      peak: peak * 0.25,
    });
  }

  // C-Am-F-G epic progression — cinematic home turf.
  const SPACE_CHORDS = [
    [130.81, 164.81, 196.00],  // C
    [110.00, 130.81, 164.81],  // Am
    [174.61, 220.00, 261.63],  // F
    [196.00, 246.94, 293.66],  // G
  ];

  // 1) DEPARTURE — M83 Oblivion opening: huge breathing pad, sub bass,
  // sparse high vocal-like soar that drops in midway.
  function _bgmScheduleSpaceDeparture(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i], 7.5, {
          peak: 0.08, attack: 1.5, pan: (i - 1) * 0.4,
        });
      }
      _bgmPlayTone(at, ch[0] / 2, 7.5, {
        type: 'sine', peak: 0.22, attack: 1.2,
      });
    }
    // Soaring lead enters on bar 2, lasts through bar 3.
    if (beat === 0 && (bar === 1 || bar === 3)) {
      _bgmPlaySoarLead(at, ch[2] * 2, 6.0, { peak: 0.11, attack: 0.6 });
    }
    if (beat === 8 || beat === 12) {
      _bgmPlayFmBell(at, ch[2] * 4, 1.5, {
        peak: 0.06, modDepth: 60, ratio: 2.01,
        pan: ((beat - 10) / 4),
      });
    }
  }

  // 2) CROSSING — M83 "Outside" feel: pulsing arpeggio that builds
  // over a breathing pad. The arp's filter opens as it crescendos.
  function _bgmScheduleSpaceCrossing(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayChoir(at, ch[i], 7.0, {
          peak: 0.07, attack: 1.8, pan: (i - 1) * 0.4,
        });
      }
      _bgmPlayTone(at, ch[0] / 2, 7.0, {
        type: 'sine', peak: 0.22, attack: 1.2,
      });
      // Pulsing arpeggio — single root note 16ths that build over a
      // full bar. Fires once at the top of each bar; the helper
      // pulses internally.
      _bgmPlayArpPulse(at, ch[2] * 2, 3.6, {
        peak: 0.09, stepDur: 0.18,
        cutoffStart: 700, cutoffEnd: 2500,
      });
    }
    if (beat % 4 === 0) _bgmPlayNoise(at, 2.5, {
      filterType: 'bandpass', freq: 600 + (bar * 200), q: 3, peak: 0.04,
      pan: ((step * 0.13) % 2) - 1,
    });
  }

  // 3) SOLARIS — deep meditative drone + slow choir + sparse bells.
  function _bgmScheduleSpaceSolaris(step, at) {
    const beat = step % 16;
    if (beat % 8 === 0) {
      _bgmPlayTone(at, 41.20, 7.0, {
        type: 'sine', peak: 0.3, attack: 1.5,
      });
      _bgmPlayTone(at, 82.41, 7.0, {
        type: 'triangle', peak: 0.06, attack: 2.0,
      });
    }
    if (beat === 0) {
      _bgmPlayChoir(at, 165, 6.0, { peak: 0.07, attack: 2.0, pan: -0.3 });
      _bgmPlayChoir(at, 246.94, 6.0, { peak: 0.07, attack: 2.0, pan: 0.3 });
    }
    if (Math.random() < 0.06) {
      _bgmPlayFmBell(at, 660 + Math.random() * 600, 2.0, {
        peak: 0.04, modDepth: 80, ratio: 3.01,
        pan: (Math.random() * 2) - 1,
      });
    }
  }

  // 4) ORION'S BELT — M83 main-theme soar: breathing pad bed + sub +
  // a sustained vocal-like lead carrying the 8-note hook.
  const _SPACE_ORION_MEL = [392, 440, 523.25, 587.33, 523.25, 440, 392, 349.23];
  function _bgmScheduleSpaceOrion(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i], 5.0, {
          peak: 0.07, attack: 0.9, pan: (i - 1) * 0.4,
        });
      }
      _bgmPlayTone(at, ch[0] / 2, 5.0, {
        type: 'sine', peak: 0.2, attack: 0.8,
      });
    }
    if (beat % 4 === 0) {
      const note = _SPACE_ORION_MEL[((beat / 4) + bar * 4) % _SPACE_ORION_MEL.length];
      _bgmPlaySoarLead(at, note, 1.1, { peak: 0.11, attack: 0.18 });
    }
    if (beat === 12) _bgmPlayTimpani(at, ch[0]);
  }

  // 5) NEBULA — drifting 3-detune pad cloud + sine-pan FM bells.
  function _bgmScheduleSpaceNebula(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        for (const det of [-8, 0, 8]) {
          _bgmPlayTone(at, ch[i] * 2, 6.0, {
            type: 'sawtooth', peak: 0.04, attack: 1.2, detune: det,
            filter: { type: 'lowpass', freq: 1800 },
            pan: det / 25,
          });
        }
      }
      _bgmPlayTone(at, ch[0] / 2, 6.0, {
        type: 'sine', peak: 0.2, attack: 1.0,
      });
    }
    if (step % 5 === 0) {
      _bgmPlayFmBell(at, ch[((step / 5) | 0) % ch.length] * 3, 1.8, {
        peak: 0.06, modDepth: 80, ratio: 2.01,
        pan: Math.sin(step / 8),
      });
    }
  }

  // 6) GRAVITY WELL — heavy descent, sub bass + timpani + dark brass.
  function _bgmScheduleSpaceGravityWell(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat === 0) {
      _bgmPlayTone(at, ch[0] / 4, 4.5, {
        type: 'sine', peak: 0.32, attack: 1.0,
      });
      _bgmPlayBrass(at, ch[2], 3.5, { peak: 0.1, attack: 0.6 });
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 4.0, {
          type: 'sawtooth', peak: 0.05, attack: 0.8, detune: i * 4,
          filter: { type: 'lowpass', freq: 1200, q: 2 },
          pan: (i - 1) * 0.3,
        });
      }
    }
    if (beat % 4 === 0) _bgmPlayTimpani(at, ch[0] / 2, { peak: 0.4 });
  }

  // 7) EXOPLANET — dissonant sub + alien FM bells + filtered noise.
  function _bgmScheduleSpaceExoplanet(step, at) {
    const beat = step % 16;
    if (beat === 0) {
      _bgmPlayTone(at, 73.42, 5.0, {
        type: 'sine', peak: 0.22, attack: 1.5,
      });
      _bgmPlayTone(at, 116.54, 5.0, {
        type: 'triangle', peak: 0.05, attack: 1.8,
        filter: { type: 'lowpass', freq: 1200 },
      });
    }
    if (Math.random() < 0.15) {
      _bgmPlayFmBell(at, 600 + Math.random() * 1200, 1.2, {
        peak: 0.05, modDepth: 200, ratio: 4.51,
        pan: (Math.random() * 2) - 1,
      });
    }
    if (beat % 4 === 0) {
      _bgmPlayNoise(at, 2.0, {
        filterType: 'bandpass', freq: 500 + Math.random() * 1000,
        q: 5, peak: 0.04,
      });
    }
  }

  // 8) THE LAUNCH — M83-anthem build: breathing pad + crescendo arp
  // + timpani downbeats + soaring lead on bar 3 + cymbal-noise sweep
  // when the lead drops in.
  function _bgmScheduleSpaceLaunch(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat % 4 === 0) _bgmPlayTimpani(at, ch[0] / 2, { peak: 0.45 });
    if (beat === 4 || beat === 12) _bgmPlayTimpani(at, ch[2] / 2, { peak: 0.3 });
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i], 3.6, {
          peak: 0.08, attack: 0.6 + i * 0.15, pan: (i - 1) * 0.3,
        });
      }
      // Each bar: an 8-step crescendo arp on the dominant of the chord.
      _bgmPlayArpPulse(at, ch[1] * 2, 3.5, {
        peak: 0.1, stepDur: 0.22,
        cutoffStart: 700, cutoffEnd: 2800,
      });
    }
    // Soaring lead enters on bar 3 (the "lift-off" moment).
    if (beat === 0 && bar === 2) {
      _bgmPlaySoarLead(at, ch[2] * 2, 6.5, { peak: 0.12, attack: 0.25 });
    }
    if (beat === 0 || beat === 8) {
      _bgmPlayNoise(at, 0.8, {
        filterType: 'highpass', freq: 5000, peak: 0.06,
      });
    }
  }

  // 9) STARDUST — gentle pad + twinkling random high FM bells + soft kick.
  function _bgmScheduleSpaceStardust(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 5.0, {
          type: 'sine', peak: 0.06, attack: 1.0,
          pan: (i - 1) * 0.4,
        });
      }
      _bgmPlayTone(at, ch[0], 5.0, {
        type: 'triangle', peak: 0.1, attack: 0.6,
        filter: { type: 'lowpass', freq: 1000 },
      });
    }
    if (Math.random() < 0.35) {
      _bgmPlayFmBell(at, 1500 + Math.random() * 2500, 0.6, {
        peak: 0.05, modDepth: 50, ratio: 3.01,
        pan: (Math.random() * 2) - 1,
      });
    }
    if (beat === 0 || beat === 8) {
      _bgmPlayKick(at, { peak: 0.2, end: 40, dur: 0.5 });
    }
  }

  // 10) HOMEBOUND — emotional return: M83 breathing pad + soaring
  // lead carries the 8-note melodic line + soft phrase timpani.
  const _SPACE_HOME_MEL = [392, 440, 392, 349.23, 329.63, 349.23, 392, 440];
  function _bgmScheduleSpaceHomebound(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SPACE_CHORDS[bar];
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i], 5.0, {
          peak: 0.07, attack: 1.0, pan: (i - 1) * 0.3,
        });
      }
      _bgmPlayTone(at, ch[0] / 2, 5.0, {
        type: 'sine', peak: 0.18, attack: 0.8,
      });
    }
    if (beat % 4 === 0) {
      const note = _SPACE_HOME_MEL[((beat / 4) + bar * 4) % _SPACE_HOME_MEL.length];
      _bgmPlaySoarLead(at, note, 1.3, { peak: 0.1, attack: 0.18 });
    }
    if (beat === 0 || beat === 12) {
      _bgmPlayTimpani(at, ch[0] / 2, { peak: 0.25 });
    }
  }

  // ── §daft ── Daft Punk / Tron Legacy: four-on-the-floor kicks,
  // pumping pads, filtered house bass, vocoder-flavoured square leads.
  // Reuses SYNTH_CHORDS_AM (Am-G-F-G) — the techno/disco minor home.

  // Vocoder lead — square + sine fundamental through a narrow lowpass,
  // reads as the talk-box / vocoder timbre central to Daft Punk's hooks.
  function _bgmPlayVocoder(at, freq, dur, opts = {}) {
    const peak = opts.peak ?? 0.1;
    _bgmPlayTone(at, freq, dur, {
      type: 'square', peak, attack: 0.01,
      filter: { type: 'lowpass', freq: 1800, q: 2 },
      pan: opts.pan ?? 0,
    });
    _bgmPlayTone(at, freq, dur, {
      type: 'sine', peak: peak * 0.4, attack: 0.01,
      pan: opts.pan ?? 0,
    });
  }

  // 1) DERESOLUTION — Tron Legacy boss feel, big kick + pulsing arp.
  function _bgmScheduleDaftDeresolution(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.55 });
    _bgmPlayTone(at, ch[0] / 2, 0.1, {
      type: 'sawtooth', peak: 0.18,
      filter: { type: 'lowpass', freq: 400, q: 4 },
    });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 8000, peak: 0.06,
    });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.22 });
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 0.4, {
          type: 'sawtooth', peak: 0.07, attack: 0.005,
          filter: { type: 'lowpass', freq: 1400, q: 3 },
          pan: (i - 1.5) * 0.3,
        });
      }
    }
  }

  // 2) RECOGNIZER — slow ominous Tron Legacy march.
  function _bgmScheduleDaftRecognizer(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0 || beat === 8) _bgmPlayKick(at, { peak: 0.5, end: 30, dur: 0.6 });
    if (beat === 0) {
      _bgmPlayTone(at, ch[0] / 2, 4.0, {
        type: 'sine', peak: 0.32, attack: 0.5,
        filter: { type: 'lowpass', freq: 200 },
      });
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i], 4.0, { peak: 0.06, attack: 0.8, pan: (i - 1.5) * 0.3 });
      }
    }
    if (beat % 4 === 2) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 7000, peak: 0.05,
    });
  }

  // 3) AROUND THE WORLD — disco-house bass + 4/4 kick.
  const _DAFT_DISCO_BASS = [110, 110, 130.81, 110, 110, 98, 87.31, 98];
  function _bgmScheduleDaftAroundWorld(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.5 });
    if (beat % 2 === 0) {
      const note = _DAFT_DISCO_BASS[((beat / 2) + bar * 2) % _DAFT_DISCO_BASS.length];
      _bgmPlayTone(at, note, 0.18, {
        type: 'sawtooth', peak: 0.22,
        filter: { type: 'lowpass', freq: 600, q: 4 },
      });
    }
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 8500, peak: 0.06,
    });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.2 });
    if (beat === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i], 3.5, { peak: 0.06, attack: 0.4, pan: (i - 1.5) * 0.3 });
      }
    }
  }

  // 4) HARDER FASTER — driving 130, 16th-note bass + filter-mod arp.
  function _bgmScheduleDaftHarderFaster(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.55 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.22 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 9000, peak: 0.06,
    });
    _bgmPlayTone(at, beat % 2 === 0 ? ch[0] / 2 : ch[0], 0.08, {
      type: 'sawtooth', peak: 0.2,
      filter: { type: 'lowpass', freq: 500, q: 4 },
    });
    if (beat % 2 === 0) {
      _bgmPlayTone(at, ch[(beat / 2) % ch.length] * 2, 0.1, {
        type: 'square', peak: 0.08,
        filter: { type: 'lowpass', freq: 1800 + beat * 100, q: 3 },
      });
    }
  }

  // 5) GAME GRID — Tron grid syncopated arp on every step.
  const _DAFT_GAME_ARP = [220, 261.63, 329.63, 261.63, 392, 329.63, 261.63, 220];
  function _bgmScheduleDaftGameGrid(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.45 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.18 });
    const note = _DAFT_GAME_ARP[beat % _DAFT_GAME_ARP.length];
    _bgmPlayTone(at, note, 0.12, {
      type: 'square', peak: 0.1,
      filter: { type: 'lowpass', freq: 2200, q: 2 },
      pan: ((beat % 4) - 1.5) * 0.4,
    });
    if (beat % 4 === 0) _bgmPlayTone(at, ch[0] / 2, 0.4, {
      type: 'sawtooth', peak: 0.22,
      filter: { type: 'lowpass', freq: 350, q: 4 },
    });
  }

  // 6) DA FUNK — swung bassline + offbeat-emphasized hat + chord stab.
  const _DAFT_FUNK_BASS = [110, 0, 110, 130.81, 0, 110, 98, 110];
  function _bgmScheduleDaftDaFunk(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.48 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.2 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 8000, peak: 0.07,
    });
    if (beat % 2 === 0) {
      const note = _DAFT_FUNK_BASS[((beat / 2) + bar * 2) % _DAFT_FUNK_BASS.length];
      if (note > 0) _bgmPlayTone(at, note, 0.18, {
        type: 'sawtooth', peak: 0.25,
        filter: { type: 'lowpass', freq: 600 + (bar * 100), q: 3 },
      });
    }
    if (beat === 6) {
      for (let i = 1; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i], 0.18, {
          type: 'square', peak: 0.07,
          filter: { type: 'lowpass', freq: 1800 },
        });
      }
    }
  }

  // 7) DISC WARS — aggressive fast: 16th saw arp + big stabs.
  function _bgmScheduleDaftDiscWars(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.55 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.25 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.03, {
      filterType: 'highpass', freq: 9000, peak: 0.07,
    });
    _bgmPlayTone(at, ch[beat % ch.length], 0.07, {
      type: 'sawtooth', peak: 0.14,
      filter: { type: 'lowpass', freq: 1600, q: 3 },
    });
    if (beat % 8 === 0) {
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayTone(at, ch[i] * 2, 0.3, {
          type: 'sawtooth', peak: 0.08, attack: 0.005,
          filter: { type: 'lowpass', freq: 2000, q: 3 },
        });
      }
    }
  }

  // 8) VOIDLINE — slow atmospheric Tron, deep sub + pumping pad.
  function _bgmScheduleDaftVoidline(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0 || beat === 8) _bgmPlayKick(at, { peak: 0.4, end: 30 });
    if (beat === 0) {
      _bgmPlayTone(at, ch[0] / 4, 4.0, {
        type: 'sine', peak: 0.3, attack: 0.5,
        filter: { type: 'lowpass', freq: 180 },
      });
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i] * 2, 4.0, { peak: 0.07, attack: 0.8, pan: (i - 1.5) * 0.4 });
      }
    }
    if (beat % 4 === 2) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 7500, peak: 0.05,
    });
  }

  // 9) DIGITAL LOVE — bouncy melodic with vocoder lead.
  const _DAFT_LOVE_LEAD = [523.25, 587.33, 659.25, 523.25, 392, 440, 523.25, 587.33];
  function _bgmScheduleDaftDigitalLove(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat % 4 === 0) _bgmPlayKick(at, { peak: 0.45 });
    if (beat === 4 || beat === 12) _bgmPlaySnare(at, { peak: 0.18 });
    if (beat % 2 === 1) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 8500, peak: 0.06,
    });
    if (beat % 2 === 0) _bgmPlayTone(at, ch[0] / 2, 0.2, {
      type: 'sawtooth', peak: 0.2,
      filter: { type: 'lowpass', freq: 500, q: 3 },
    });
    if (beat % 2 === 0) {
      const note = _DAFT_LOVE_LEAD[((beat / 2) + bar * 2) % _DAFT_LOVE_LEAD.length];
      _bgmPlayVocoder(at, note, 0.18, { peak: 0.09 });
    }
  }

  // 10) END OF LINE — emotional outro, sparse vocoder over emotional pad.
  function _bgmScheduleDaftEndOfLine(step, at) {
    const beat = step % 16;
    const bar  = Math.floor(step / 16) % 4;
    const ch   = SYNTH_CHORDS_AM[bar];
    if (beat === 0) {
      _bgmPlayKick(at, { peak: 0.4, end: 35, dur: 0.6 });
      _bgmPlayTone(at, ch[0] / 2, 4.0, {
        type: 'sine', peak: 0.25, attack: 0.6,
      });
      for (let i = 0; i < ch.length; i++) {
        _bgmPlayPad(at, ch[i], 5.0, { peak: 0.08, attack: 1.0, pan: (i - 1.5) * 0.3 });
      }
    }
    if (beat === 4 || beat === 11) {
      _bgmPlayVocoder(at, ch[2] * 2, 1.5, { peak: 0.1 });
    }
    if (beat % 4 === 2) _bgmPlayNoise(at, 0.025, {
      filterType: 'highpass', freq: 7500, peak: 0.05,
    });
  }

  // ── §catalog ── genre / track registry ────────────────────────────
  // Adding a new track is two steps: write a schedule(step, at)
  // function above, then add an entry under the genre's `tracks`
  // array here. patternLen sets the loop length (in 16th-note steps)
  // and BPM defines the step duration.
  const BGM_CATALOG = {
    plundercore: {
      name: 'PLUNDER CORE',
      tracks: [
        { id: 'core-loop',      name: 'CORE LOOP',      bpm: 104, patternLen: 16, schedule: _bgmSchedulePlunderCoreLoop },
        { id: 'crate-dig',      name: 'CRATE DIG',      bpm: 88,  patternLen: 64, schedule: _bgmSchedulePlunderCrateDig },
        { id: 'fragment',       name: 'FRAGMENT',       bpm: 96,  patternLen: 32, schedule: _bgmSchedulePlunderFragment },
        { id: 'tape-splice',    name: 'TAPE SPLICE',    bpm: 100, patternLen: 64, schedule: _bgmSchedulePlunderTapeSplice },
        { id: 'stutter-step',   name: 'STUTTER STEP',   bpm: 116, patternLen: 16, schedule: _bgmSchedulePlunderStutterStep },
        { id: 'phantom-room',   name: 'PHANTOM ROOM',   bpm: 76,  patternLen: 64, schedule: _bgmSchedulePlunderPhantomRoom },
        { id: 'hook-cycle',     name: 'HOOK CYCLE',     bpm: 108, patternLen: 16, schedule: _bgmSchedulePlunderHookCycle },
        { id: 'ghost-crackle',  name: 'GHOST CRACKLE',  bpm: 84,  patternLen: 64, schedule: _bgmSchedulePlunderGhostCrackle },
        { id: 'slow-burn',      name: 'SLOW BURN',      bpm: 68,  patternLen: 64, schedule: _bgmSchedulePlunderSlowBurn },
        { id: 'mosaic',         name: 'MOSAIC',         bpm: 124, patternLen: 16, schedule: _bgmSchedulePlunderMosaic },
      ],
    },
    vaporwave: {
      name: 'VAPORWAVE',
      tracks: [
        { id: 'mall-air',         name: 'MALL AIR',         bpm: 92,  patternLen: 64, schedule: _bgmScheduleVaporMallAir },
        { id: 'plaza-bath',       name: 'PLAZA BATH',       bpm: 84,  patternLen: 64, schedule: _bgmScheduleVaporPlazaBath },
        { id: 'sunset-cassette',  name: 'SUNSET CASSETTE',  bpm: 98,  patternLen: 64, schedule: _bgmScheduleVaporSunsetCassette },
        { id: 'static-lobby',     name: 'STATIC LOBBY',     bpm: 80,  patternLen: 64, schedule: _bgmScheduleVaporStaticLobby },
        { id: 'pixel-highway',    name: 'PIXEL HIGHWAY',    bpm: 112, patternLen: 64, schedule: _bgmScheduleVaporPixelHighway },
        { id: 'dead-mall',        name: 'DEAD MALL',        bpm: 72,  patternLen: 64, schedule: _bgmScheduleVaporDeadMall },
        { id: 'pink-flamingo',    name: 'PINK FLAMINGO',    bpm: 88,  patternLen: 64, schedule: _bgmScheduleVaporPinkFlamingo },
        { id: 'beach-haze',       name: 'BEACH HAZE',       bpm: 76,  patternLen: 64, schedule: _bgmScheduleVaporBeachHaze },
        { id: 'fax-modem',        name: 'FAX MODEM',        bpm: 96,  patternLen: 64, schedule: _bgmScheduleVaporFaxModem },
        { id: 'tropic-dusk',      name: 'TROPIC DUSK',      bpm: 90,  patternLen: 64, schedule: _bgmScheduleVaporTropicDusk },
      ],
    },
    synthwave: {
      name: 'SYNTHWAVE',
      tracks: [
        { id: 'neon-drive',       name: 'NEON DRIVE',       bpm: 116, patternLen: 64, schedule: _bgmScheduleSynthNeonDrive },
        { id: 'midnight-cruise',  name: 'MIDNIGHT CRUISE',  bpm: 100, patternLen: 64, schedule: _bgmScheduleSynthMidnightCruise },
        { id: 'outrun',           name: 'OUTRUN',           bpm: 128, patternLen: 64, schedule: _bgmScheduleSynthOutrun },
        { id: 'ghost-grid',       name: 'GHOST GRID',       bpm: 104, patternLen: 64, schedule: _bgmScheduleSynthGhostGrid },
        { id: 'vhs-glow',         name: 'VHS GLOW',         bpm: 92,  patternLen: 64, schedule: _bgmScheduleSynthVhsGlow },
        { id: 'chrome-highway',   name: 'CHROME HIGHWAY',   bpm: 120, patternLen: 64, schedule: _bgmScheduleSynthChromeHighway },
        { id: 'starlight',        name: 'STARLIGHT',        bpm: 88,  patternLen: 64, schedule: _bgmScheduleSynthStarlight },
        { id: 'city-glitter',     name: 'CITY GLITTER',     bpm: 108, patternLen: 64, schedule: _bgmScheduleSynthCityGlitter },
        { id: 'dark-matter',      name: 'DARK MATTER',      bpm: 84,  patternLen: 64, schedule: _bgmScheduleSynthDarkMatter },
        { id: 'horizon-rush',     name: 'HORIZON RUSH',     bpm: 132, patternLen: 64, schedule: _bgmScheduleSynthHorizonRush },
      ],
    },
    lofi: {
      name: 'LO-FI',
      tracks: [
        { id: 'study-desk',       name: 'STUDY DESK',       bpm: 80,  patternLen: 64, schedule: _bgmScheduleLofiStudyDesk },
        { id: 'coffee-steam',     name: 'COFFEE STEAM',     bpm: 84,  patternLen: 64, schedule: _bgmScheduleLofiCoffeeSteam },
        { id: 'rain-window',      name: 'RAIN WINDOW',      bpm: 76,  patternLen: 64, schedule: _bgmScheduleLofiRainWindow },
        { id: 'vinyl-crackle',    name: 'VINYL CRACKLE',    bpm: 88,  patternLen: 64, schedule: _bgmScheduleLofiVinylCrackle },
        { id: 'night-bus',        name: 'NIGHT BUS',        bpm: 92,  patternLen: 64, schedule: _bgmScheduleLofiNightBus },
        { id: 'vinyl-pop',        name: 'VINYL POP',        bpm: 82,  patternLen: 64, schedule: _bgmScheduleLofiVinylPop },
        { id: 'after-hours',      name: 'AFTER HOURS',      bpm: 72,  patternLen: 64, schedule: _bgmScheduleLofiAfterHours },
        { id: 'open-window',      name: 'OPEN WINDOW',      bpm: 86,  patternLen: 64, schedule: _bgmScheduleLofiOpenWindow },
        { id: 'school-hall',      name: 'SCHOOL HALL',      bpm: 78,  patternLen: 64, schedule: _bgmScheduleLofiSchoolHall },
        { id: 'dusk-stroll',      name: 'DUSK STROLL',      bpm: 90,  patternLen: 64, schedule: _bgmScheduleLofiDuskStroll },
      ],
    },
    darkambient: {
      name: 'DARK AMBIENT',
      tracks: [
        { id: 'abyss',            name: 'ABYSS',            bpm: 60,  patternLen: 64, schedule: _bgmScheduleDarkAbyss },
        { id: 'cathedral',        name: 'CATHEDRAL',        bpm: 56,  patternLen: 64, schedule: _bgmScheduleDarkCathedral },
        { id: 'static-rift',      name: 'STATIC RIFT',      bpm: 64,  patternLen: 64, schedule: _bgmScheduleDarkStaticRift },
        { id: 'deep-signal',      name: 'DEEP SIGNAL',      bpm: 60,  patternLen: 64, schedule: _bgmScheduleDarkDeepSignal },
        { id: 'sublayer',         name: 'SUBLAYER',         bpm: 52,  patternLen: 64, schedule: _bgmScheduleDarkSublayer },
        { id: 'event-horizon',    name: 'EVENT HORIZON',    bpm: 58,  patternLen: 64, schedule: _bgmScheduleDarkEventHorizon },
        { id: 'midnight-veil',    name: 'MIDNIGHT VEIL',    bpm: 50,  patternLen: 64, schedule: _bgmScheduleDarkMidnightVeil },
        { id: 'the-well',         name: 'THE WELL',         bpm: 54,  patternLen: 64, schedule: _bgmScheduleDarkTheWell },
        { id: 'starfield',        name: 'STARFIELD',        bpm: 62,  patternLen: 64, schedule: _bgmScheduleDarkStarfield },
        { id: 'void-hum',         name: 'VOID HUM',         bpm: 48,  patternLen: 64, schedule: _bgmScheduleDarkVoidHum },
      ],
    },
    eightbit: {
      name: '8 BIT',
      tracks: [
        { id: 'hyrule-field',     name: 'HYRULE FIELD',     bpm: 124, patternLen: 64, schedule: _bgmSchedule8BitHyruleField },
        { id: 'star-road',        name: 'STAR ROAD',        bpm: 140, patternLen: 64, schedule: _bgmSchedule8BitStarRoad },
        { id: 'dungeon-crawl',    name: 'DUNGEON CRAWL',    bpm: 80,  patternLen: 64, schedule: _bgmSchedule8BitDungeonCrawl },
        { id: 'boss-battle',      name: 'BOSS BATTLE',      bpm: 150, patternLen: 64, schedule: _bgmSchedule8BitBossBattle },
        { id: 'pixel-quest',      name: 'PIXEL QUEST',      bpm: 132, patternLen: 64, schedule: _bgmSchedule8BitPixelQuest },
        { id: 'castle-fanfare',   name: 'CASTLE FANFARE',   bpm: 116, patternLen: 64, schedule: _bgmSchedule8BitCastleFanfare },
        { id: 'water-temple',     name: 'WATER TEMPLE',     bpm: 96,  patternLen: 64, schedule: _bgmSchedule8BitWaterTemple },
        { id: 'sky-island',       name: 'SKY ISLAND',       bpm: 110, patternLen: 64, schedule: _bgmSchedule8BitSkyIsland },
        { id: 'final-boss',       name: 'FINAL BOSS',       bpm: 156, patternLen: 64, schedule: _bgmSchedule8BitFinalBoss },
        { id: 'minigame',         name: 'MINIGAME',         bpm: 160, patternLen: 64, schedule: _bgmSchedule8BitMinigame },
      ],
    },
    smoothjazz: {
      name: 'SMOOTH JAZZ',
      tracks: [
        { id: 'midnight-lounge',  name: 'MIDNIGHT LOUNGE',  bpm: 68,  patternLen: 64, schedule: _bgmScheduleJazzMidnightLounge },
        { id: 'city-lights',      name: 'CITY LIGHTS',      bpm: 92,  patternLen: 64, schedule: _bgmScheduleJazzCityLights },
        { id: 'after-party',      name: 'AFTER PARTY',      bpm: 78,  patternLen: 64, schedule: _bgmScheduleJazzAfterParty },
        { id: 'champagne',        name: 'CHAMPAGNE',        bpm: 102, patternLen: 64, schedule: _bgmScheduleJazzChampagne },
        { id: 'rain-on-glass',    name: 'RAIN ON GLASS',    bpm: 72,  patternLen: 64, schedule: _bgmScheduleJazzRainOnGlass },
        { id: 'late-train',       name: 'LATE TRAIN',       bpm: 96,  patternLen: 64, schedule: _bgmScheduleJazzLateTrain },
        { id: 'velvet-room',      name: 'VELVET ROOM',      bpm: 64,  patternLen: 64, schedule: _bgmScheduleJazzVelvetRoom },
        { id: 'sunset-drive',     name: 'SUNSET DRIVE',     bpm: 88,  patternLen: 64, schedule: _bgmScheduleJazzSunsetDrive },
        { id: 'honey-suite',      name: 'HONEY SUITE',      bpm: 84,  patternLen: 64, schedule: _bgmScheduleJazzHoneySuite },
        { id: 'blue-neon',        name: 'BLUE NEON',        bpm: 76,  patternLen: 64, schedule: _bgmScheduleJazzBlueNeon },
      ],
    },
    daft: {
      name: 'DAFT',
      tracks: [
        { id: 'deresolution',     name: 'DERESOLUTION',     bpm: 110, patternLen: 64, schedule: _bgmScheduleDaftDeresolution },
        { id: 'recognizer',       name: 'RECOGNIZER',       bpm: 70,  patternLen: 64, schedule: _bgmScheduleDaftRecognizer },
        { id: 'around-world',     name: 'AROUND THE WORLD', bpm: 124, patternLen: 64, schedule: _bgmScheduleDaftAroundWorld },
        { id: 'harder-faster',    name: 'HARDER FASTER',    bpm: 130, patternLen: 64, schedule: _bgmScheduleDaftHarderFaster },
        { id: 'game-grid',        name: 'GAME GRID',        bpm: 120, patternLen: 64, schedule: _bgmScheduleDaftGameGrid },
        { id: 'da-funk',          name: 'DA FUNK',          bpm: 110, patternLen: 64, schedule: _bgmScheduleDaftDaFunk },
        { id: 'disc-wars',        name: 'DISC WARS',        bpm: 132, patternLen: 64, schedule: _bgmScheduleDaftDiscWars },
        { id: 'voidline',         name: 'VOIDLINE',         bpm: 72,  patternLen: 64, schedule: _bgmScheduleDaftVoidline },
        { id: 'digital-love',     name: 'DIGITAL LOVE',     bpm: 122, patternLen: 64, schedule: _bgmScheduleDaftDigitalLove },
        { id: 'end-of-line',      name: 'END OF LINE',      bpm: 80,  patternLen: 64, schedule: _bgmScheduleDaftEndOfLine },
      ],
    },
    soundtrack: {
      name: 'SOUNDTRACK',
      tracks: [
        { id: 'departure',        name: 'DEPARTURE',        bpm: 56,  patternLen: 64, schedule: _bgmScheduleSpaceDeparture },
        { id: 'crossing',         name: 'CROSSING',         bpm: 48,  patternLen: 64, schedule: _bgmScheduleSpaceCrossing },
        { id: 'solaris',          name: 'SOLARIS',          bpm: 44,  patternLen: 64, schedule: _bgmScheduleSpaceSolaris },
        { id: 'orion',            name: "ORION'S BELT",     bpm: 64,  patternLen: 64, schedule: _bgmScheduleSpaceOrion },
        { id: 'nebula',           name: 'NEBULA',           bpm: 52,  patternLen: 64, schedule: _bgmScheduleSpaceNebula },
        { id: 'gravity-well',     name: 'GRAVITY WELL',     bpm: 70,  patternLen: 64, schedule: _bgmScheduleSpaceGravityWell },
        { id: 'exoplanet',        name: 'EXOPLANET',        bpm: 56,  patternLen: 64, schedule: _bgmScheduleSpaceExoplanet },
        { id: 'the-launch',       name: 'THE LAUNCH',       bpm: 76,  patternLen: 64, schedule: _bgmScheduleSpaceLaunch },
        { id: 'stardust',         name: 'STARDUST',         bpm: 60,  patternLen: 64, schedule: _bgmScheduleSpaceStardust },
        { id: 'homebound',        name: 'HOMEBOUND',        bpm: 72,  patternLen: 64, schedule: _bgmScheduleSpaceHomebound },
      ],
    },
    cyberpunk: {
      name: 'CYBERPUNK',
      tracks: [
        { id: 'neon-rain',        name: 'NEON RAIN',        bpm: 70,  patternLen: 64, schedule: _bgmScheduleCyberNeonRain },
        { id: 'wet-streets',      name: 'WET STREETS',      bpm: 78,  patternLen: 64, schedule: _bgmScheduleCyberWetStreets },
        { id: 'subsignal',        name: 'SUBSIGNAL',        bpm: 60,  patternLen: 64, schedule: _bgmScheduleCyberSubsignal },
        { id: 'hologram',         name: 'HOLOGRAM',         bpm: 72,  patternLen: 64, schedule: _bgmScheduleCyberHologram },
        { id: 'near-future',      name: 'NEAR FUTURE',      bpm: 92,  patternLen: 64, schedule: _bgmScheduleCyberNearFuture },
        { id: 'sector-7',         name: 'SECTOR 7',         bpm: 88,  patternLen: 64, schedule: _bgmScheduleCyberSector7 },
        { id: 'night-drive',      name: 'NIGHT DRIVE',      bpm: 96,  patternLen: 64, schedule: _bgmScheduleCyberNightDrive },
        { id: 'grid-down',        name: 'GRID DOWN',        bpm: 64,  patternLen: 64, schedule: _bgmScheduleCyberGridDown },
        { id: 'overpass',         name: 'OVERPASS',         bpm: 84,  patternLen: 64, schedule: _bgmScheduleCyberOverpass },
        { id: 'chrome-reflection',name: 'CHROME REFLECTION',bpm: 80,  patternLen: 64, schedule: _bgmScheduleCyberChrome },
      ],
    },
    taverncore: {
      name: 'TAVERNCORE',
      tracks: [
        { id: 'harp-north',       name: 'HARP OF THE NORTH', bpm: 72,  patternLen: 64, schedule: _bgmScheduleFolkHarpNorth },
        { id: 'forest-whispers',  name: 'FOREST WHISPERS',  bpm: 60,  patternLen: 64, schedule: _bgmScheduleFolkForestWhispers },
        { id: 'tavern-jig',       name: 'TAVERN JIG',       bpm: 132, patternLen: 64, schedule: _bgmScheduleFolkTavernJig },
        { id: 'war-drums',        name: 'WAR DRUMS',        bpm: 88,  patternLen: 64, schedule: _bgmScheduleFolkWarDrums },
        { id: 'yennefer-theme',   name: "YENNEFER'S THEME", bpm: 76,  patternLen: 64, schedule: _bgmScheduleFolkYenneferTheme },
        { id: 'longship',         name: 'LONGSHIP',         bpm: 80,  patternLen: 64, schedule: _bgmScheduleFolkLongship },
        { id: 'hearth-fire',      name: 'HEARTH FIRE',      bpm: 70,  patternLen: 64, schedule: _bgmScheduleFolkHearthFire },
        { id: 'ravens',           name: 'RAVENS',           bpm: 64,  patternLen: 64, schedule: _bgmScheduleFolkRavens },
        { id: 'mead-hall',        name: 'MEAD HALL',        bpm: 110, patternLen: 64, schedule: _bgmScheduleFolkMeadHall },
        { id: 'geralts-ride',     name: "GERALT'S RIDE",    bpm: 120, patternLen: 64, schedule: _bgmScheduleFolkGeraltsRide },
      ],
    },
  };

  // ── §favorites ── cross-genre playlist ──────────────────────────
  // Keys are "<genreId>:<trackId>". Persisted under cfg.bgmFavorites
  // as a plain string array. The "favs" virtual genre is computed at
  // lookup time so toggling a favorite updates the FAVS list without a
  // catalog rebuild.
  const _bgmFavorites = new Set();
  function _bgmFavoriteTracks() {
    const out = [];
    for (const key of _bgmFavorites) {
      const sep = key.indexOf(':');
      if (sep <= 0) continue;
      const genreId = key.slice(0, sep);
      const trackId = key.slice(sep + 1);
      const g = BGM_CATALOG[genreId];
      if (!g) continue;
      const t = g.tracks.find((x) => x.id === trackId);
      if (!t) continue;
      // Composite id so FAVS keeps a unique key per row; original
      // schedule/bpm/patternLen survive via spread.
      out.push({
        ...t,
        id: key,
        name: `${t.name} · ${g.name}`,
      });
    }
    return out;
  }
  function _bgmCurrentGenre() {
    if (window._bgmState.genre === 'favs') {
      return { name: 'FAVS', tracks: _bgmFavoriteTracks() };
    }
    return BGM_CATALOG[window._bgmState.genre] || BGM_CATALOG.plundercore;
  }
  function _bgmCurrentTrack() {
    const g = _bgmCurrentGenre();
    return g.tracks.find((t) => t.id === window._bgmState.trackId) || g.tracks[0];
  }
  // Resolve the favorite-key for whatever track is current — handles
  // both the FAVS view (track.id is already the composite key) and any
  // normal genre (build the composite key on the fly).
  function _bgmCurrentFavoriteKey() {
    const t = _bgmCurrentTrack();
    if (!t) return null;
    if (window._bgmState.genre === 'favs') return t.id;
    return `${window._bgmState.genre}:${t.id}`;
  }
  function _bgmIsFavorite() {
    const k = _bgmCurrentFavoriteKey();
    return !!k && _bgmFavorites.has(k);
  }
  async function _bgmSaveFavorites() {
    try { await window.dash?.setConfig?.({ bgmFavorites: [..._bgmFavorites] }); }
    catch {}
  }
  function _bgmToggleFavorite() {
    const key = _bgmCurrentFavoriteKey();
    if (!key) return;
    if (_bgmFavorites.has(key)) _bgmFavorites.delete(key);
    else _bgmFavorites.add(key);
    _bgmPaintFavoriteBtn();
    // If we're currently looking at FAVS, the track list changed —
    // repaint it. Removing the active track is fine; _bgmCurrentTrack
    // falls back to first in list.
    if (window._bgmState.genre === 'favs') _bgmRenderTracks();
    _bgmSaveFavorites();
  }
  function _bgmPaintFavoriteBtn() {
    const btn = document.getElementById('bgm-fav-btn');
    if (!btn) return;
    const fav = _bgmIsFavorite();
    btn.classList.toggle('is-active', fav);
    btn.title = fav ? 'Remove from FAVS' : 'Add to FAVS';
    const outline = btn.querySelector('.bgm-fav-outline');
    const filled  = btn.querySelector('.bgm-fav-filled');
    if (outline) outline.hidden = fav;
    if (filled)  filled.hidden  = !fav;
  }
  // Load on init.
  (async () => {
    try {
      const cfg = (await window.dash?.getConfig?.()) || {};
      const arr = Array.isArray(cfg.bgmFavorites) ? cfg.bgmFavorites : [];
      for (const k of arr) if (typeof k === 'string') _bgmFavorites.add(k);
      if (window._bgmState.genre === 'favs') _bgmRenderTracks();
      _bgmPaintFavoriteBtn();
    } catch {}
  })();

  // ── §ui ── populate the TRACK row whenever the genre changes. ─────
  function _bgmRenderTracks() {
    if (!bgmTracksEl) return;
    const g = _bgmCurrentGenre();
    const curId = _bgmCurrentTrack()?.id;
    bgmTracksEl.innerHTML = '';
    if (!g.tracks.length) {
      // FAVS-empty fallback: a dim hint instead of an empty row so the
      // user knows where to favorite tracks from.
      const hint = document.createElement('span');
      hint.className = 'bgm-track-empty';
      hint.textContent = 'NO FAVS YET · ♥ a track in any genre to add';
      bgmTracksEl.appendChild(hint);
      return;
    }
    for (const t of g.tracks) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bgm-track' + (t.id === curId ? ' is-active' : '');
      b.dataset.bgmTrack = t.id;
      b.textContent = `${t.name} · ${t.bpm}`;
      bgmTracksEl.appendChild(b);
    }
  }
  _bgmRenderTracks();

  // ── §scheduler ── dispatches to the current track's schedule. ─────
  // 100 ms lookahead means setInterval jitter doesn't audibly skew event
  // timing. _bgmStep keeps climbing forever; we modulo by the track's
  // patternLen when scheduling so the loop is endless.
  const BGM_LOOKAHEAD_S = 0.1;
  const BGM_SCHED_INTERVAL_MS = 25;
  function _bgmStepDurS() {
    const t = _bgmCurrentTrack();
    return (60 / (t?.bpm || 80)) / 4; // 16th notes
  }
  function _bgmTick() {
    if (!_bgmCtx) return;
    const t = _bgmCurrentTrack();
    if (!t) return;
    const now = _bgmCtx.currentTime;
    while (_bgmNextStepTime < now + BGM_LOOKAHEAD_S) {
      try { t.schedule(_bgmStep % t.patternLen, _bgmNextStepTime); }
      catch (err) { console.warn('[bgm] schedule threw:', err); }
      _bgmStep++;
      _bgmNextStepTime += _bgmStepDurS();
    }
  }

  // Output level meter — segmented EQ bars matching the system audio
  // visualizer (audio-color → amber → red gradient via two-color lerp,
  // glass-floor reflection, red peak markers, gentle "smile" curve).
  // Source is the BGM master-bus analyser, not system loopback.
  // Bar count is dynamic: derived from the canvas's CSS width so larger
  // pane sizes get more resolution. Target ~3 CSS px per bar (1 bar +
  // 1 gap fits comfortably), clamped to [64, 384] so very narrow panes
  // still read and very wide ones don't run out of FFT bins.
  let _bgmBarCount = 0;
  let _bgmDisplayed = new Float32Array(0);
  let _bgmPeaks = new Float32Array(0);
  let _bgmPeakHold = new Float32Array(0);
  function _bgmTargetBarCount(W) {
    // Was 3 px / cap 384 — on a wide pane that gave ~250+ bars redrawn at
    // 60 Hz. 6 px / cap 128 halves the canvas fillRect count per frame
    // and the FFT bucket loop scales with bar count, so the entire draw
    // path is ~2× cheaper. Visually still reads as a dense spectrum.
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
    // Music meter uses a split palette so it visually echoes the audio
    // input + output panels:
    //   OUT side (left of centre) → --accent      (audio-out colour)
    //   IN  side (right of centre) → --amber      (audio-in  colour)
    // Falling back through --audio-color preserves the prior look on
    // themes that haven't defined --accent specifically.
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
    // OUT side = audio-out (accent / cyan). IN side = audio-in (amber).
    const brightOut = parseHex(accentStr) || [80, 200, 255];
    const dimOut    = [Math.round(brightOut[0]*0.25), Math.round(brightOut[1]*0.25), Math.round(brightOut[2]*0.25)];
    const brightIn  = parseHex(amberStr) || [243, 168, 59];
    const dimIn     = [Math.round(brightIn[0]*0.25), Math.round(brightIn[1]*0.25), Math.round(brightIn[2]*0.25)];
    return { brightOut, dimOut, brightIn, dimIn, accentStr, amberStr, redStr };
  }
  function _bgmDrawMeter() {
    if (!bgmMeterEl || !_bgmAnalyser) return;
    // Resize the backing store to match the displayed CSS size every
    // frame — picker collapses can change the canvas's CSS dims and we
    // want crisp output without setting up a separate resize handler.
    const dpr = window.devicePixelRatio || 1;
    const cssW = bgmMeterEl.clientWidth || bgmMeterEl.width;
    const cssH = bgmMeterEl.clientHeight || bgmMeterEl.height;
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (bgmMeterEl.width !== targetW)  bgmMeterEl.width  = targetW;
    if (bgmMeterEl.height !== targetH) bgmMeterEl.height = targetH;
    const ctx2d = bgmMeterEl.getContext('2d');
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssW;
    const H = cssH;
    ctx2d.clearRect(0, 0, W, H);

    // Dynamic bar count derived from current canvas width — more bars
    // on bigger panes, fewer on narrow ones. Smoothing arrays resize
    // when the count changes (no carryover from old indices).
    _bgmEnsureBarArrays(_bgmTargetBarCount(W));
    const N = _bgmBarCount;

    // FFT → N buckets. Max-of-bins per bucket so transients pop. With
    // fftSize 1024 we have 512 bins; even at N=384 there's room to
    // average / spread without empty buckets.
    const buf = new Uint8Array(_bgmAnalyser.frequencyBinCount);
    _bgmAnalyser.getByteFrequencyData(buf);
    const binsPerBar = buf.length / N;
    for (let i = 0; i < N; i++) {
      const lo = Math.floor(i * binsPerBar);
      const hi = Math.max(lo + 1, Math.floor((i + 1) * binsPerBar));
      let v = 0;
      for (let j = lo; j < hi; j++) v = Math.max(v, buf[j] || 0);
      const target = (v / 255) * 100;
      _bgmDisplayed[i] = target > _bgmDisplayed[i]
        ? target
        : _bgmDisplayed[i] * 0.92;
      if (target >= _bgmPeaks[i]) { _bgmPeaks[i] = target; _bgmPeakHold[i] = 28; }
      else if (_bgmPeakHold[i] > 0) { _bgmPeakHold[i]--; }
      else { _bgmPeaks[i] = Math.max(0, _bgmPeaks[i] - 1.4); }
    }

    // Segmented bar layout — same shape as the system audio viz, but the
    // palette is split down the centre: left half uses the audio-OUT
    // colour (accent), right half uses the audio-IN colour (amber), so
    // the music meter visually bridges the two input/output panels.
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
    // Pre-compute two segment-colour gradients — one per side — so the
    // hot path stays a single fillStyle write per cell.
    const colorsOut = new Array(segments);
    const colorsIn  = new Array(segments);
    for (let s = 0; s < segments; s++) {
      const t = s / Math.max(1, segments - 1);
      const ro = Math.round(dimOut[0] * (1 - t) + brightOut[0] * t);
      const go = Math.round(dimOut[1] * (1 - t) + brightOut[1] * t);
      const bo = Math.round(dimOut[2] * (1 - t) + brightOut[2] * t);
      colorsOut[s] = `rgb(${ro},${go},${bo})`;
      const ri = Math.round(dimIn[0] * (1 - t) + brightIn[0] * t);
      const gi = Math.round(dimIn[1] * (1 - t) + brightIn[1] * t);
      const bi = Math.round(dimIn[2] * (1 - t) + brightIn[2] * t);
      colorsIn[s] = `rgb(${ri},${gi},${bi})`;
    }
    const halfN = N / 2;
    for (let i = 0; i < N; i++) {
      const dist = N > 1 ? Math.abs(i / (N - 1) - 0.5) * 2 : 0;
      // Bell-curve falloff (matches audio bars) — tallest at centre,
      // ~30% at edges. Replaces the prior "smile" that exaggerated the
      // edges; user wanted the opposite shape.
      const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
      const value = (_bgmDisplayed[i] / 100) * scale;
      const cellsLit = Math.min(segments, Math.ceil(value * segments));
      const x = i * (barW + gap);
      // Hard split at the midpoint — left side OUT (accent), right side
      // IN (amber). Bar index < N/2 → OUT, else → IN.
      const palette = (i < halfN) ? colorsOut : colorsIn;
      for (let s = 0; s < cellsLit; s++) {
        ctx2d.fillStyle = palette[s];
        const y = baselineY - (s + 1) * segPitch + cellGapY;
        ctx2d.fillRect(x, y, barW, cellH);
      }
      const reflectN = Math.min(cellsLit, reflectSegMax);
      if (reflectN > 0) {
        ctx2d.globalAlpha = 0.22;
        for (let s = 0; s < reflectN; s++) {
          ctx2d.fillStyle = palette[s];
          const y = baselineY + s * segPitch;
          ctx2d.fillRect(x, y, barW, cellH);
        }
        ctx2d.globalAlpha = 1;
      }
    }
    // Floating peak markers in --red.
    ctx2d.fillStyle = redStr;
    for (let i = 0; i < N; i++) {
      const dist = N > 1 ? Math.abs(i / (N - 1) - 0.5) * 2 : 0;
      // Same bell-curve falloff so peaks track the bar fill profile.
      const scale = 0.30 + 0.70 * Math.cos(dist * Math.PI / 2);
      const peakValue = (_bgmPeaks[i] / 100) * scale;
      const peakSeg = Math.min(segments, Math.ceil(peakValue * segments));
      if (peakSeg <= 0) continue;
      const x = i * (barW + gap);
      const y = baselineY - peakSeg * segPitch + cellGapY;
      ctx2d.fillRect(x, y, barW, cellH);
    }
    // Re-queue only if BGM is still playing AND the music tab is visible.
    // When the user switches away from the music tab, the in-flight draw
    // completes once then the rAF chain stops naturally — no more canvas
    // work happens in the background. When they come back to the tab,
    // setComboMode calls window._bgmMaybeStartMeter() (defined below) to
    // restart the rAF. Music itself keeps playing either way.
    if (window._bgmState.playing && window._isMusicTabVisible) {
      _bgmMeterRaf = requestAnimationFrame(_bgmDrawMeter);
    } else {
      _bgmMeterRaf = 0;
    }
  }
  // Exposed so setComboMode can restart the meter when the user returns
  // to the music tab while BGM is playing. No-op if the rAF chain is
  // already running.
  window._bgmMaybeStartMeter = () => {
    if (_bgmMeterRaf) return;
    if (window._bgmState?.playing && window._isMusicTabVisible) {
      _bgmMeterRaf = requestAnimationFrame(_bgmDrawMeter);
    }
  };

  function _bgmPaintPlayBtn() {
    if (!bgmPlayBtn) return;
    const playing = !!window._bgmState.playing;
    bgmPlayBtn.classList.toggle('is-active', playing);
    bgmPlayBtn.title = playing ? 'Pause' : 'Play';
    const pIcon = bgmPlayBtn.querySelector('.bgm-play-icon');
    const sIcon = bgmPlayBtn.querySelector('.bgm-pause-icon');
    if (pIcon) pIcon.hidden = playing;
    if (sIcon) sIcon.hidden = !playing;
  }
  async function _bgmStart() {
    _bgmEnsureCtx();
    if (_bgmCtx.state === 'suspended') {
      try { await _bgmCtx.resume(); } catch {}
    }
    window._bgmState.playing = true;
    _bgmStep = 0;
    _bgmNextStepTime = _bgmCtx.currentTime + 0.1;
    try {
      _bgmMaster.gain.cancelScheduledValues(_bgmCtx.currentTime);
      _bgmMaster.gain.setValueAtTime(window._bgmState.volume, _bgmCtx.currentTime);
    } catch {}
    _bgmSchedTimer = setInterval(_bgmTick, BGM_SCHED_INTERVAL_MS);
    // Arm the 5-minute auto-cycle. Re-armed every time _bgmStart runs
    // (so manual prev/next/genre/track changes reset the countdown
    // rather than auto-advancing immediately after a manual switch).
    if (_bgmCycleTimer) { clearTimeout(_bgmCycleTimer); }
    _bgmCycleTimer = setTimeout(() => {
      _bgmCycleTimer = null;
      if (window._bgmState.playing) _bgmAdvanceTrack(+1);
    }, BGM_AUTOCYCLE_MS);
    _bgmPaintPlayBtn();
    _bgmUpdateNow();
    cancelAnimationFrame(_bgmMeterRaf);
    _bgmMeterRaf = requestAnimationFrame(_bgmDrawMeter);
  }
  function _bgmStop() {
    window._bgmState.playing = false;
    if (_bgmSchedTimer) { clearInterval(_bgmSchedTimer); _bgmSchedTimer = null; }
    if (_bgmCycleTimer) { clearTimeout(_bgmCycleTimer); _bgmCycleTimer = null; }
    cancelAnimationFrame(_bgmMeterRaf);
    if (_bgmCtx && _bgmMaster) {
      try {
        const t = _bgmCtx.currentTime;
        _bgmMaster.gain.cancelScheduledValues(t);
        _bgmMaster.gain.setValueAtTime(_bgmMaster.gain.value, t);
        _bgmMaster.gain.linearRampToValueAtTime(0, t + 0.25);
      } catch {}
    }
    _bgmPaintPlayBtn();
    if (bgmNowEl) bgmNowEl.textContent = '— STOPPED —';
  }

  function _bgmUpdateNow() {
    // The favorite-button state reflects whichever track is current,
    // so refresh it on every now-label update (covers play/pause,
    // prev/next, genre switch, and auto-cycle).
    _bgmPaintFavoriteBtn();
    if (!bgmNowEl) return;
    if (!window._bgmState.playing) { bgmNowEl.textContent = '— STOPPED —'; return; }
    const g = _bgmCurrentGenre();
    const t = _bgmCurrentTrack();
    if (!t) { bgmNowEl.textContent = `${g.name} · — EMPTY —`; return; }
    bgmNowEl.textContent = `${g.name} · ${t.name} · ${t.bpm} BPM`;
  }

  // Walk the current genre's track list. Wraps both ends so PREV at
  // index 0 goes to the last track and NEXT at the end goes back to 0.
  // Restart playback cleanly if music is currently playing.
  function _bgmAdvanceTrack(dir) {
    const g = _bgmCurrentGenre();
    const cur = _bgmCurrentTrack();
    const idx = g.tracks.findIndex((t) => t.id === cur?.id);
    const next = (idx + dir + g.tracks.length) % g.tracks.length;
    window._bgmState.trackId = g.tracks[next].id;
    bgmTracksEl?.querySelectorAll('.bgm-track').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.bgmTrack === window._bgmState.trackId));
    if (window._bgmState.playing) {
      _bgmStop();
      setTimeout(() => _bgmStart(), 280);
    } else {
      _bgmUpdateNow();
    }
  }
  function _bgmAdjustVolume(deltaPct) {
    const next = Math.max(0, Math.min(100, Math.round(window._bgmState.volume * 100) + deltaPct));
    if (bgmVolEl) bgmVolEl.value = String(next);
    const v = next / 100;
    window._bgmState.volume = v;
    if (bgmVolValEl) bgmVolValEl.textContent = `${next}%`;
    if (_bgmMaster && _bgmCtx) {
      _bgmMaster.gain.setTargetAtTime(v, _bgmCtx.currentTime, 0.02);
    }
  }

  bgmPlayBtn?.addEventListener('click', () => {
    if (window._bgmState.playing) _bgmStop();
    else _bgmStart();
    playSfx?.('click');
  });
  document.getElementById('bgm-stop-btn')?.addEventListener('click', () => {
    _bgmStop();
    playSfx?.('click');
  });
  document.getElementById('bgm-prev-btn')?.addEventListener('click', () => {
    _bgmAdvanceTrack(-1);
    playSfx?.('click');
  });
  document.getElementById('bgm-next-btn')?.addEventListener('click', () => {
    _bgmAdvanceTrack(+1);
    playSfx?.('click');
  });
  document.getElementById('bgm-fav-btn')?.addEventListener('click', () => {
    _bgmToggleFavorite();
    playSfx?.('click');
  });
  document.getElementById('bgm-vol-down')?.addEventListener('click', () => {
    _bgmAdjustVolume(-5);
    playSfx?.('click');
  });
  document.getElementById('bgm-vol-up')?.addEventListener('click', () => {
    _bgmAdjustVolume(+5);
    playSfx?.('click');
  });
  bgmVolEl?.addEventListener('input', () => {
    const v = Math.max(0, Math.min(1, (Number(bgmVolEl.value) || 0) / 100));
    window._bgmState.volume = v;
    if (bgmVolValEl) bgmVolValEl.textContent = `${Math.round(v * 100)}%`;
    if (_bgmMaster && _bgmCtx) {
      _bgmMaster.gain.setTargetAtTime(v, _bgmCtx.currentTime, 0.02);
    }
  });
  bgmGenresEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bgm-genre]');
    if (!btn) return;
    bgmGenresEl.querySelectorAll('.bgm-genre').forEach((b) =>
      b.classList.toggle('is-active', b === btn));
    window._bgmState.genre = btn.dataset.bgmGenre;
    // Reset track to first of new genre and repaint the track row.
    window._bgmState.trackId = null;
    _bgmRenderTracks();
    if (window._bgmState.playing) {
      // Restart cleanly so the new genre's timing/pattern takes effect.
      _bgmStop();
      setTimeout(() => _bgmStart(), 280);
    } else {
      _bgmUpdateNow();
    }
    playSfx?.('click');
  });
  bgmTracksEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bgm-track]');
    if (!btn) return;
    bgmTracksEl.querySelectorAll('.bgm-track').forEach((b) =>
      b.classList.toggle('is-active', b === btn));
    window._bgmState.trackId = btn.dataset.bgmTrack;
    if (window._bgmState.playing) {
      _bgmStop();
      setTimeout(() => _bgmStart(), 280);
    } else {
      _bgmUpdateNow();
    }
    playSfx?.('click');
  });
}

// ── §generate ── COMFYUI front-end ─────────────────────────────────
// Modular workflow runner. Scans the configured workflow folder via
// IPC, renders a tab per JSON, and on RUN converts the ComfyUI UI
// workflow format → API format, POSTs to /prompt, polls /history,
// and saves the result back into gallery/generated/.
//
// The UI→API conversion uses ComfyUI's /object_info endpoint to learn
// each node type's input order, so `widgets_values` arrays can be
// mapped back to named inputs. We fetch /object_info once per session
// and cache it.
{
  const COMFY_HOST_DEFAULT = 'http://127.0.0.1:8000';
  // Per-session client id (ComfyUI keys prompts/queues by this).
  const _genClientId = 'dash3d-' + Math.random().toString(36).slice(2, 10);
  let _genObjectInfo = null;     // /object_info cache
  let _genWorkflows  = [];       // [{file, kind, display}]
  let _genCurrent    = null;     // currently selected workflow {file, kind, display, json, fields}
  let _genRunning    = false;
  let _genHost       = COMFY_HOST_DEFAULT;
  window._genState = window._genState || { workflowName: '' };

  const genNowEl      = document.getElementById('gen-now');
  const genStatusEl   = document.getElementById('gen-status');
  const genTabsEl     = document.getElementById('gen-tabs');
  const genBodyEl     = document.getElementById('gen-body');
  const genEmptyEl    = document.getElementById('gen-empty');
  const genRefreshBtn = document.getElementById('gen-refresh-btn');
  const genCancelBtn  = document.getElementById('gen-cancel-btn');
  const genFlushBtn   = document.getElementById('gen-flush-btn');
  let   _genCancelRequested = false;
  let   _genCurrentPromptId = null;
  const genOutputEl   = document.getElementById('gen-output');
  const genOutputImg  = document.getElementById('gen-output-img');
  const genOutputVid  = document.getElementById('gen-output-video');
  const genOutputAud  = document.getElementById('gen-output-audio');
  const genOutputName = document.getElementById('gen-output-name');
  const genOutputThumbs = document.getElementById('gen-output-thumbs');
  // Per-session list of every output we've shown — used to render the
  // thumbnail strip and let the user jump back to earlier generations.
  const _genOutputHistory = [];

  function _genSetStatus(text, kind) {
    if (!genStatusEl) return;
    genStatusEl.textContent = text || '';
    genStatusEl.classList.toggle('is-online', kind === 'ok');
    genStatusEl.classList.toggle('is-error',  kind === 'error');
  }
  function _genSetNow(text) {
    if (genNowEl) genNowEl.textContent = text || '— READY —';
  }

  // ── ComfyUI client ──────────────────────────────────────────────
  // All HTTP goes through main via the comfyHttp IPC. The renderer's
  // own fetch() to 127.0.0.1 fails because Electron treats the app
  // origin as opaque for CORS; main proxies via Node http instead.
  function _decodeBytesToText(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return ''; }
  }
  async function _genHttp(opts) {
    const r = await window.dash?.comfyHttp?.(opts);
    return r || { ok: false, error: 'IPC bridge missing' };
  }
  async function _genGetJson(url) {
    const r = await _genHttp({ method: 'GET', url });
    if (!r.ok || !r.bytes) return null;
    try { return JSON.parse(_decodeBytesToText(r.bytes)); } catch { return null; }
  }
  async function _genCheckComfy() {
    const r = await _genHttp({ method: 'GET', url: `${_genHost}/system_stats` });
    if (r.ok) {
      _genSetStatus('COMFYUI ONLINE', 'ok');
      return true;
    }
    const reason = r.status ? `HTTP ${r.status}` : (r.error || 'failed');
    _genSetStatus(`COMFYUI OFFLINE · ${reason}`, 'error');
    return false;
  }
  async function _genFetchObjectInfo() {
    if (_genObjectInfo) return _genObjectInfo;
    const data = await _genGetJson(`${_genHost}/object_info`);
    if (!data) {
      console.warn('[generate] object_info fetch failed');
      return null;
    }
    _genObjectInfo = data;
    return _genObjectInfo;
  }

  // ── UI workflow → API workflow ─────────────────────────────────
  // ComfyUI's UI JSON has:
  //   nodes: [{ id, type, inputs:[{name,link}], widgets_values: [...] }]
  //   links: [linkId, fromNodeId, fromSlotIdx, toNodeId, toSlotIdx, type]
  // The API JSON wants:
  //   { "<nodeId>": { class_type: "<type>", inputs: {
  //       "<inputName>": [fromNodeId, fromSlotIdx] | <literal value>,
  //   } } }
  // We build a link table, then walk each node copying linked inputs
  // and matching widget_values against the type's input_order from
  // /object_info.
  function _genUiToApi(uiWorkflow, objectInfo) {
    const out = {};
    const links = new Map(); // linkId → [fromNodeId, fromSlotIdx]
    for (const link of (uiWorkflow.links || [])) {
      if (!Array.isArray(link) || link.length < 3) continue;
      links.set(link[0], [String(link[1]), Number(link[2])]);
    }
    // UI-only node types: annotations (no outputs, safe to drop) and
    // routing nodes (must be passed through — handled below).
    const UI_ANNOTATION_TYPES = new Set(['MarkdownNote', 'Note']);
    // Reroute / PrimitiveNode aren't real ComfyUI server nodes — they
    // route a value/link through. For each, remember its upstream link
    // so downstream consumers can resolve past the Reroute to the real
    // producer.
    const passthroughUpstreamLink = new Map(); // nodeId -> linkId of its input
    for (const node of (uiWorkflow.nodes || [])) {
      if (!node) continue;
      if (node.type !== 'Reroute' && node.type !== 'PrimitiveNode') continue;
      const inp = (node.inputs || [])[0];
      if (!inp || inp.link == null) continue;
      passthroughUpstreamLink.set(String(node.id), inp.link);
    }
    function resolveLink(linkId, depth) {
      if (depth > 32) return null;
      const src = links.get(linkId);
      if (!src) return null;
      const up = passthroughUpstreamLink.get(src[0]);
      if (up != null) return resolveLink(up, depth + 1);
      return src;
    }
    for (const node of (uiWorkflow.nodes || [])) {
      if (!node || node.mode === 2 /* MUTE */ || node.mode === 4 /* BYPASS */) continue;
      const id = String(node.id);
      const type = node.type;
      if (UI_ANNOTATION_TYPES.has(type)) continue;
      if (passthroughUpstreamLink.has(id)) continue; // Reroute / PrimitiveNode
      // Drop any node ComfyUI's /object_info doesn't recognize — keeps
      // unknown frontend-only / custom-node residue out of the prompt.
      if (objectInfo && !objectInfo[type]) continue;
      const apiNode = { class_type: type, inputs: {} };
      // 1) Linked inputs (resolved past any Reroute hops).
      for (const inp of (node.inputs || [])) {
        if (inp.link == null) continue;
        const src = resolveLink(inp.link, 0);
        if (src) apiNode.inputs[inp.name] = src;
      }
      // 2) Widget values. Map index → input name via object_info.
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      const info = objectInfo?.[type];
      if (info && widgets.length) {
        // object_info gives us required + optional inputs with their
        // declared order. Widget inputs are scalars (not links) so
        // we iterate them and match.
        const required = info.input?.required || {};
        const optional = info.input?.optional || {};
        // Only widget-backed inputs consume slots in widgets_values.
        // Link-only inputs (CLIP, MODEL, IMAGE, LATENT, …) don't — if
        // we include them, a dangling link would let the loop assign a
        // widget value into the wrong name and shift every subsequent
        // widget by one. This logic must mirror _genDiscoverFields.
        // Widget-input detection. ComfyUI's object_info uses several
        // dialects for the same idea — we need to recognize all of them
        // so a widget-backed input doesn't get treated as a link-only
        // type (and miss its widgets_values slot, shifting every later
        // widget by one).
        //
        //   ["STRING", { ... }]          ← scalar widget by type name
        //   ["INT" / "FLOAT" / "BOOLEAN" / "COMBO", { ... }]
        //   [[ "choice", "choice", ... ], { ... }]   ← combo (inline choices)
        //   [ "...", { choices/options: [...] } ]    ← typed COMBO (new style)
        //
        // Anything else is a link-only type (AUDIO, MODEL, CLIP, IMAGE,
        // LATENT, CONDITIONING, MASK, VAE, …) and doesn't consume a
        // widgets_values slot.
        const SCALAR_WIDGET_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO']);
        const isWidgetSpec = (v) => {
          if (!Array.isArray(v)) return false;
          const t = v[0];
          if (Array.isArray(t)) return true;
          if (SCALAR_WIDGET_TYPES.has(t)) return true;
          const opts = v[1];
          if (opts && typeof opts === 'object'
              && (Array.isArray(opts.choices) || Array.isArray(opts.options))) {
            return true;
          }
          return false;
        };
        const orderedNames = [];
        for (const [k, v] of Object.entries(required)) {
          if (isWidgetSpec(v)) orderedNames.push(k);
        }
        for (const [k, v] of Object.entries(optional)) {
          if (isWidgetSpec(v)) orderedNames.push(k);
        }
        let wi = 0;
        for (const name of orderedNames) {
          if (wi >= widgets.length) break;
          // Skip names already filled by linked inputs (they're not
          // widget-backed).
          if (apiNode.inputs[name] !== undefined) continue;
          apiNode.inputs[name] = widgets[wi++];
          // Some node types stuff a "control_after_generate" boolean
          // immediately after a "seed" widget — burn the next widget
          // slot if so.
          if (name === 'seed' || name === 'noise_seed') {
            if (wi < widgets.length && (
              widgets[wi] === 'randomize' ||
              widgets[wi] === 'fixed' ||
              widgets[wi] === 'increment' ||
              widgets[wi] === 'decrement'
            )) wi++;
          }
        }
      }
      out[id] = apiNode;
    }
    return out;
  }

  // ── Field discovery ────────────────────────────────────────────
  // For each node in the workflow, look up its type's input schema in
  // /object_info, walk widgets_values, and produce an entry per
  // editable widget tagged with its kind (int/float/string/bool/combo)
  // + min/max/choices. This surfaces every model-specific knob —
  // resolution, steps, cfg, sampler choice, length, fps, etc — without
  // having to hand-code anything per workflow.
  // Walk every editable node in the workflow — including nodes nested
  // inside subgraph definitions. ComfyUI v3 workflows wrap the bulk of
  // their nodes in `definitions.subgraphs[].nodes`; a top-level instance
  // node (whose `type` is the subgraph's UUID) is what the user sees on
  // the canvas, but the prompts/sampler/etc. all live one level down.
  //
  // Returns an array of [node, subgraphInstanceId|null]. The instance id
  // is needed so edit writeback can find the right copy of the node in
  // the original JSON tree.
  function _genWalkAllNodes(uiWorkflow) {
    const out = [];
    const sgById = new Map();
    for (const sg of (uiWorkflow.definitions?.subgraphs || [])) sgById.set(sg.id, sg);
    for (const node of (uiWorkflow.nodes || [])) {
      if (!node) continue;
      if (sgById.has(node.type)) {
        const sg = sgById.get(node.type);
        // Build a (innerNodeId|innerWidgetName) → user-facing label map
        // by reconciling the instance's visible inputs against the full
        // proxyWidgets list. The instance only shows a subset of proxied
        // widgets, and their order in `inputs[]` matches the proxyWidgets
        // order they were declared in. We walk both in parallel and
        // record the label whenever the widget names line up.
        const proxyWidgets = node.properties?.proxyWidgets || [];
        const instInputs = node.inputs || [];
        const labelMap = new Map();
        const usedProxies = new Set();
        for (const inp of instInputs) {
          if (!inp.widget) continue;
          const wname = inp.widget.name;
          let matchIdx = -1;
          for (let i = 0; i < proxyWidgets.length; i++) {
            if (usedProxies.has(i)) continue;
            if (String(proxyWidgets[i][1]) === String(wname)) { matchIdx = i; break; }
          }
          if (matchIdx === -1) continue;
          usedProxies.add(matchIdx);
          const [innerId, innerWidget] = proxyWidgets[matchIdx];
          labelMap.set(`${innerId}|${innerWidget}`, String(inp.label || inp.name || ''));
        }
        for (const inner of (sg.nodes || [])) out.push([inner, String(node.id), labelMap]);
      } else {
        out.push([node, null, null]);
      }
    }
    return out;
  }

  function _genDiscoverFields(uiWorkflow, objectInfo) {
    const nodes = [];
    if (!objectInfo) return { nodes, missingObjectInfo: true };
    for (const [node, subgraphInstanceId, labelMap] of _genWalkAllNodes(uiWorkflow)) {
      if (!node) continue;
      if (node.mode === 2 || node.mode === 4) continue; // muted/bypassed
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      if (!widgets.length) continue;
      const info = objectInfo[node.type];
      if (!info) continue;
      // Build the input order ComfyUI uses for widgets_values. Required
      // first, then optional. We can't tell scalar inputs from linked
      // ones from object_info alone — but linked inputs aren't in
      // widgets_values either, so we only walk slots until we've placed
      // every widget value.
      const required = info.input?.required || {};
      const optional = info.input?.optional || {};
      const slots = [];
      for (const k of Object.keys(required)) slots.push({ name: k, spec: required[k] });
      for (const k of Object.keys(optional)) slots.push({ name: k, spec: optional[k] });

      const entries = [];
      let wi = 0;
      for (const slot of slots) {
        if (wi >= widgets.length) break;
        const spec = slot.spec;
        const typeOrChoices = Array.isArray(spec) ? spec[0] : spec;
        const opts = (Array.isArray(spec) && spec[1] && typeof spec[1] === 'object') ? spec[1] : {};
        let kind;
        let choices = null;
        if (Array.isArray(typeOrChoices)) {
          kind = 'combo';
          choices = typeOrChoices;
        } else if (typeOrChoices === 'INT') kind = 'int';
        else if (typeOrChoices === 'FLOAT') kind = 'float';
        else if (typeOrChoices === 'STRING') kind = 'string';
        else if (typeOrChoices === 'BOOLEAN') kind = 'bool';
        else if (typeOrChoices === 'COMBO') {
          // New-style typed combo. Choices live in spec[1].choices or
          // spec[1].options.
          kind = 'combo';
          choices = Array.isArray(opts.choices) ? opts.choices
                  : Array.isArray(opts.options) ? opts.options
                  : [];
        } else if (Array.isArray(opts.choices) || Array.isArray(opts.options)) {
          // Newer dialect: the named type is the value type (e.g.
          // "STRING") but the input is really a constrained combo via
          // a choices/options array in the spec dict.
          kind = 'combo';
          choices = Array.isArray(opts.choices) ? opts.choices : opts.options;
        }
        else continue; // skip linked-only types (MODEL, CLIP, IMAGE, etc.)
        entries.push({
          name: slot.name,
          kind,
          value: widgets[wi],
          choices,
          min: opts.min,
          max: opts.max,
          step: opts.step,
          multiline: !!opts.multiline,
          widgetIndex: wi,
          subgraphLabel: labelMap ? labelMap.get(`${node.id}|${slot.name}`) || '' : '',
        });
        wi++;
        // ComfyUI's seed/noise_seed widgets are followed by a
        // control_after_generate string slot in widgets_values that
        // isn't declared as an input — burn it so the next widget
        // aligns with the next named slot.
        if ((slot.name === 'seed' || slot.name === 'noise_seed') && wi < widgets.length) {
          const next = widgets[wi];
          if (next === 'randomize' || next === 'fixed' || next === 'increment' || next === 'decrement') {
            wi++;
          }
        }
      }
      if (!entries.length) continue;
      nodes.push({
        id: node.id,
        type: node.type,
        title: (node.title && node.title !== node.type) ? node.title : node.type,
        entries,
        subgraphInstanceId,
      });
    }
    return { nodes };
  }

  // Walk the UI workflow to tag entries with semantic roles so the form
  // can lift prompts and media inputs into a hero block instead of
  // burying them in a generic "node N" section.
  //
  // Roles assigned (mutates fields.nodes entries in place):
  //   prompt-positive · positive-prompt text widget (CLIPTextEncode-ish)
  //   prompt-negative · negative-prompt text widget
  //   media-image     · LoadImage/LoadImageMask first-string widget
  //   media-video     · VHS_LoadVideo / LoadVideo first-string widget
  //   media-audio     · LoadAudio / VHS_LoadAudio first-string widget
  //   (otherwise no role — rendered as a plain parameter)
  function _genClassifyRoles(_uiWorkflow, fields) {
    // Prompt detection — works for both flat and subgraph workflows by
    // looking at NODE TYPE rather than tracing sampler links (subgraph
    // links are scoped to the definition and not directly traversable
    // from the outer view).
    //
    // Priority order:
    //   1. PrimitiveStringMultiline   ← v3 subgraph convention: user-
    //                                   facing prompt is a dedicated
    //                                   multiline string primitive that
    //                                   feeds into the encoder.
    //   2. CLIPTextEncode             ← classic flat workflows.
    //   3. TextEncodeAceStepAudio /   ← audio workflows (first widget
    //      *TextEncode* (last resort)   = tags/lyrics text).
    const PROMPT_PRIMARY_RE = /^PrimitiveStringMultiline$/i;
    const PROMPT_SECONDARY_RE = /^CLIPTextEncode$/i;
    const PROMPT_AUDIO_RE = /TextEncode/i;
    // Collect candidate string-bearing nodes in workflow order.
    const candidates = [];
    for (const fn of fields.nodes) {
      const t = String(fn.type || '');
      let tier = null;
      if (PROMPT_PRIMARY_RE.test(t)) tier = 1;
      else if (PROMPT_SECONDARY_RE.test(t)) tier = 2;
      else if (PROMPT_AUDIO_RE.test(t)) tier = 3;
      if (tier == null) continue;
      // Find the first multiline string entry on this node.
      const stringEntry = fn.entries.find((e) => e.kind === 'string' && e.multiline)
        || fn.entries.find((e) => e.kind === 'string');
      if (!stringEntry) continue;
      candidates.push({ tier, entry: stringEntry, fn });
    }
    candidates.sort((a, b) => a.tier - b.tier);
    // Highest-tier candidate = positive prompt. If a candidate of the
    // SAME tier exists, the second one is the negative prompt. (Many
    // workflows have a positive + negative pair of the same node type.)
    if (candidates.length > 0) {
      candidates[0].entry.role = 'prompt-positive';
      const sameTier = candidates.filter((c) => c.tier === candidates[0].tier);
      if (sameTier.length >= 2 && sameTier[1].entry !== candidates[0].entry) {
        sameTier[1].entry.role = 'prompt-negative';
      }
    }
    // Loader detection — first scalar widget on these node types is the
    // filename that should be surfaced as a media uploader. Walks every
    // discovered node, top-level AND subgraph-inner, so a LoadImage
    // sitting outside the subgraph (image_flux2 pattern) and one inside
    // (video_ltx2_3_t2v pattern) both work.
    const IMAGE_LOADER_RE = /^(LoadImage(Mask)?|ImageLoader|LoadImageFromUrl)/i;
    const VIDEO_LOADER_RE = /VHS_LoadVideo|^LoadVideo/i;
    const AUDIO_LOADER_RE = /VHS_LoadAudio|^LoadAudio/i;
    for (const fn of fields.nodes) {
      const t = String(fn.type || '');
      let kind = null;
      if (IMAGE_LOADER_RE.test(t)) kind = 'image';
      else if (VIDEO_LOADER_RE.test(t)) kind = 'video';
      else if (AUDIO_LOADER_RE.test(t)) kind = 'audio';
      if (!kind) continue;
      for (const e of fn.entries) {
        if (e.kind === 'combo' || e.kind === 'string') {
          e.role = `media-${kind}`;
          e.mediaKind = kind;
          break;
        }
      }
    }
  }

  // Upload a File/Blob to ComfyUI and return the filename that should be
  // written into the workflow's loader-widget value. Uses /upload/image
  // for both still images and video (ComfyUI accepts the latter on the
  // same endpoint — `type=input` lands them in input/ where loaders
  // look). Multipart payload is assembled manually so we can stay on
  // the IPC proxy (renderer fetch hits CORS).
  async function _genUploadMedia(file) {
    const boundary = '----dash3d-' + Math.random().toString(36).slice(2, 10);
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${file.name.replace(/"/g, '')}"\r\n` +
      `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    );
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const tail = enc.encode(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n` +
      `--${boundary}--\r\n`
    );
    const body = new Uint8Array(head.length + fileBytes.length + tail.length);
    body.set(head, 0);
    body.set(fileBytes, head.length);
    body.set(tail, head.length + fileBytes.length);
    const r = await _genHttp({
      method: 'POST',
      url: `${_genHost}/upload/image`,
      body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    if (!r.ok) throw new Error(`upload HTTP ${r.status || 'fail'}`);
    const data = JSON.parse(_decodeBytesToText(r.bytes));
    return data?.name || file.name;
  }

  // Apply edited values back into a fresh UI-workflow clone, then
  // convert to API format. Each entry knows its widgetIndex so we can
  // write straight into widgets_values — but the target node may live
  // inside a subgraph definition, so we build a 2-level lookup that
  // covers both top-level nodes and subgraph-nested ones.
  function _genBuildApiPayload(workflow) {
    const ui = JSON.parse(JSON.stringify(workflow.json));
    // top-level: id -> node
    const topMap = new Map();
    for (const n of (ui.nodes || [])) topMap.set(String(n.id), n);
    // subgraph-nested: instanceId -> (innerId -> node)
    const sgMap = new Map();
    for (const sg of (ui.definitions?.subgraphs || [])) {
      for (const n of (ui.nodes || [])) {
        if (n.type === sg.id) {
          const inner = new Map();
          for (const innerNode of (sg.nodes || [])) inner.set(String(innerNode.id), innerNode);
          sgMap.set(String(n.id), inner);
        }
      }
    }
    for (const n of workflow.fields.nodes) {
      let target;
      if (n.subgraphInstanceId) {
        target = sgMap.get(String(n.subgraphInstanceId))?.get(String(n.id));
      } else {
        target = topMap.get(String(n.id));
      }
      if (!target || !Array.isArray(target.widgets_values)) continue;
      for (const e of n.entries) {
        target.widgets_values[e.widgetIndex] = e.value;
      }
    }
    // Flatten subgraphs before API conversion — ComfyUI's /prompt endpoint
    // wants a single dict of nodes, not a hierarchy.
    const flat = _genFlattenSubgraphs(ui);
    return _genUiToApi(flat, _genObjectInfo);
  }

  // Inline every subgraph instance into the workflow's top-level nodes/
  // links so the result looks like a flat ComfyUI v2 workflow that
  // _genUiToApi can handle.
  //
  // Strategy for each instance:
  //   1. Copy every inner node into the top-level list with a prefixed
  //      id (`<instanceId>_<innerId>`) so ids stay unique.
  //   2. Copy the subgraph's internal links with new ids, remapping
  //      endpoint node ids to the prefixed versions.
  //   3. Bridge external connections:
  //      a. For each instance input that has an outer `link`, find which
  //         inner node consumes that input (via subgraph.inputs[i].linkIds
  //         → subgraph.links → target inner node + slot) and rewrite the
  //         inner node's matching input.link to point at the outer link
  //         id directly — and the outer link's `to` to that inner node.
  //      b. For each instance output, find which inner node produces it
  //         (via subgraph.outputs[i].linkIds → subgraph.links → source
  //         inner node + slot) and rewrite outer links whose `from` was
  //         the instance to source from the inner producer instead.
  //   4. Drop the instance node itself.
  function _genFlattenSubgraphs(workflow) {
    const sgById = new Map();
    for (const sg of (workflow.definitions?.subgraphs || [])) sgById.set(sg.id, sg);
    if (!sgById.size) return workflow;
    // ComfyUI v3 stores subgraph internal links as objects
    //   { id, origin_id, origin_slot, target_id, target_slot, type }
    // while top-level workflow links are tuples
    //   [id, fromId, fromSlot, toId, toSlot, type]
    // Normalize everything to the tuple form so the rest of this pass
    // can use a single accessor pattern.
    const normalizeLink = (l) => {
      if (Array.isArray(l)) return l.length >= 6 ? l : null;
      if (l && typeof l === 'object' && l.id != null) {
        return [l.id, String(l.origin_id), Number(l.origin_slot),
                String(l.target_id), Number(l.target_slot), l.type];
      }
      return null;
    };
    const out = { ...workflow, nodes: [], links: [] };
    let linkSeq = (workflow.last_link_id || 0) + 100000;
    const outerLinkById = new Map();
    for (const link of (workflow.links || [])) {
      const norm = normalizeLink(link);
      if (norm) outerLinkById.set(norm[0], [...norm]);
    }
    // outer link id -> { fromId, fromSlot } when a subgraph output needs
    // to be re-sourced to its inner producer at the flatten step.
    const outerLinkSourceRewrite = new Map();
    for (const node of (workflow.nodes || [])) {
      if (!node || node.mode === 2 || node.mode === 4) continue;
      const sg = sgById.get(node.type);
      if (!sg) {
        // Non-subgraph node — keep as-is (deep clone so later edits don't
        // leak into source).
        out.nodes.push(JSON.parse(JSON.stringify(node)));
        continue;
      }
      const instanceId = String(node.id);
      const innerNodeRemap = new Map();
      const innerLinkRemap = new Map();
      const sgLinkById = new Map();
      for (const inner of (sg.nodes || [])) {
        innerNodeRemap.set(String(inner.id), `${instanceId}_${inner.id}`);
      }
      // Normalize subgraph internal links (objects) into tuples and
      // remap ids in the same pass.
      for (const raw of (sg.links || [])) {
        const link = normalizeLink(raw);
        if (!link) continue;
        sgLinkById.set(link[0], link);
        innerLinkRemap.set(link[0], ++linkSeq);
      }
      // For each instance input position, list of {innerNodeId, innerSlot}.
      const inputConsumers = (sg.inputs || []).map((sgIn) => {
        const consumers = [];
        for (const lid of (sgIn.linkIds || [])) {
          const link = sgLinkById.get(lid);
          if (!link) continue;
          consumers.push({ innerNodeId: String(link[3]), innerSlot: link[4] });
        }
        return consumers;
      });
      // For each instance output position, the producer inner node.
      const outputProducers = (sg.outputs || []).map((sgOut) => {
        const link = sgOut.linkIds && sgOut.linkIds.length ? sgLinkById.get(sgOut.linkIds[0]) : null;
        if (!link) return null;
        return { innerNodeId: String(link[1]), innerSlot: link[2] };
      });
      // Emit inner nodes (deep-cloned, with remapped ids + link refs).
      for (const inner of (sg.nodes || [])) {
        if (inner.mode === 2 || inner.mode === 4) continue;
        const clone = JSON.parse(JSON.stringify(inner));
        clone.id = innerNodeRemap.get(String(inner.id));
        for (const inp of (clone.inputs || [])) {
          if (inp.link != null && innerLinkRemap.has(inp.link)) {
            inp.link = innerLinkRemap.get(inp.link);
          }
        }
        out.nodes.push(clone);
      }
      // Emit inner links with remapped ids (sgLinkById holds the
      // already-normalized tuple form).
      for (const link of sgLinkById.values()) {
        const newLid = innerLinkRemap.get(link[0]);
        const fromMapped = innerNodeRemap.get(String(link[1]));
        const toMapped = innerNodeRemap.get(String(link[3]));
        if (!fromMapped || !toMapped) continue; // skip phantom port links (-10/-20)
        out.links.push([newLid, fromMapped, link[2], toMapped, link[4], link[5]]);
      }
      // Bridge instance inputs: each instance.inputs[i] with a real outer
      // link feeds inputConsumers[i].
      const instInputs = node.inputs || [];
      for (let i = 0; i < instInputs.length; i++) {
        const inp = instInputs[i];
        if (inp.link == null) continue;
        const outerLink = outerLinkById.get(inp.link);
        if (!outerLink) continue;
        const consumers = inputConsumers[i] || [];
        for (const c of consumers) {
          const newToId = innerNodeRemap.get(c.innerNodeId);
          if (!newToId) continue;
          // Mint a bridging link from the outer source to the inner
          // consumer, and update that inner node's input.link.
          const bridgeLid = ++linkSeq;
          out.links.push([bridgeLid, outerLink[1], outerLink[2], newToId, c.innerSlot, outerLink[5]]);
          const target = out.nodes.find((n) => n.id === newToId);
          if (target) {
            const slot = (target.inputs || [])[c.innerSlot];
            if (slot) slot.link = bridgeLid;
          }
        }
      }
      // Bridge instance outputs: any outer link whose source is this
      // instance gets re-sourced to the inner producer.
      const instOutputs = node.outputs || [];
      for (let i = 0; i < instOutputs.length; i++) {
        const producer = outputProducers[i];
        if (!producer) continue;
        const newFromId = innerNodeRemap.get(producer.innerNodeId);
        if (!newFromId) continue;
        for (const lid of (instOutputs[i].links || [])) {
          // We've already pushed this link into out.links from the
          // outer-link copy below. But we copy outer links AFTER this
          // loop, so the rewrite happens there based on a remap table.
          outerLinkSourceRewrite.set(lid, { fromId: newFromId, fromSlot: producer.innerSlot });
        }
      }
    }
    // Copy outer links not involving subgraph instances, with source
    // rewrites applied where needed.
    for (const raw of (workflow.links || [])) {
      const link = normalizeLink(raw);
      if (!link) continue;
      const [lid, fromId, fromSlot, toId, toSlot, type] = link;
      // If the source was a subgraph instance, redirect.
      const rewrite = outerLinkSourceRewrite.get(lid);
      let useFromId = fromId, useFromSlot = fromSlot;
      if (rewrite) {
        useFromId = rewrite.fromId;
        useFromSlot = rewrite.fromSlot;
      }
      // If the target is a subgraph instance, the link is already
      // bridged above and we should skip the outer copy.
      const tgtNode = (workflow.nodes || []).find((n) => String(n.id) === String(toId));
      if (tgtNode && sgById.has(tgtNode.type)) continue;
      // If the source is still a subgraph instance with no rewrite,
      // we couldn't resolve a producer — skip.
      const srcNode = (workflow.nodes || []).find((n) => String(n.id) === String(useFromId));
      if (srcNode && sgById.has(srcNode.type) && !rewrite) continue;
      out.links.push([lid, useFromId, useFromSlot, toId, toSlot, type]);
    }
    return out;
  }

  // ── Tab rendering ──────────────────────────────────────────────
  async function _genLoadWorkflows() {
    if (genTabsEl) genTabsEl.innerHTML = '';
    if (genBodyEl && genEmptyEl) genBodyEl.innerHTML = '';
    const result = await window.dash?.comfyListWorkflows?.();
    _genWorkflows = result?.entries || [];
    if (!_genWorkflows.length) {
      _genSetStatus(result?.error ? `SCAN ERROR · ${result.error}` : 'NO WORKFLOWS', 'error');
      if (genBodyEl && genEmptyEl) {
        genBodyEl.appendChild(genEmptyEl);
        genEmptyEl.textContent = result?.dir
          ? `NO WORKFLOWS IN ${result.dir}`
          : 'NO WORKFLOW FOLDER CONFIGURED';
      }
      return;
    }
    // Build tabs.
    for (const w of _genWorkflows) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gen-tab';
      btn.dataset.file = w.file;
      btn.dataset.kind = w.kind;
      btn.innerHTML = `<span class="gen-tab-kind">${w.kind.toUpperCase()}</span>${w.display}`;
      genTabsEl?.appendChild(btn);
    }
    // Auto-select first.
    await _genSelectWorkflow(_genWorkflows[0].file);
  }

  async function _genSelectWorkflow(file) {
    const meta = _genWorkflows.find((w) => w.file === file);
    if (!meta) return;
    genTabsEl?.querySelectorAll('.gen-tab').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.file === file));
    // Load workflow JSON.
    const result = await window.dash?.comfyLoadWorkflow?.(file);
    if (!result?.ok) {
      _genSetStatus(`LOAD ERROR · ${result?.error || 'unknown'}`, 'error');
      return;
    }
    // Ensure object_info is loaded — field discovery uses it to know
    // each node's widget types (int / float / combo / etc.). If
    // ComfyUI is offline this returns null and the form shows a hint.
    await _genFetchObjectInfo();
    const fields = _genDiscoverFields(result.json, _genObjectInfo);
    if (!fields.missingObjectInfo) _genClassifyRoles(result.json, fields);
    _genCurrent = { ...meta, json: result.json, fields };
    window._genState.workflowName = meta.display;
    _genRenderFields();
    _genSetNow(`${meta.kind.toUpperCase()} · ${meta.display}`);
  }

  // Build one labeled input for a single widget entry. Returns the
  // outer row element. All edits flow back into `entry.value` by
  // reference, so the workflow's payload picks them up at RUN time.
  function _genBuildEntryRow(entry) {
    const row = document.createElement('div');
    row.className = entry.kind === 'string' && entry.multiline ? 'gen-row' : 'gen-row gen-row-h';
    const label = document.createElement('span');
    label.className = 'gen-label';
    label.textContent = (entry.name || '').toUpperCase();
    row.appendChild(label);
    if (entry.kind === 'string' && entry.multiline) {
      const ta = document.createElement('textarea');
      ta.className = 'gen-textarea';
      ta.value = (entry.value == null) ? '' : String(entry.value);
      ta.spellcheck = false;
      ta.addEventListener('input', () => { entry.value = ta.value; });
      row.appendChild(ta);
      return row;
    }
    if (entry.kind === 'string') {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'gen-input';
      input.value = (entry.value == null) ? '' : String(entry.value);
      input.addEventListener('input', () => { entry.value = input.value; });
      row.appendChild(input);
      return row;
    }
    if (entry.kind === 'combo') {
      const sel = document.createElement('select');
      sel.className = 'gen-input';
      for (const opt of (entry.choices || [])) {
        const o = document.createElement('option');
        o.value = String(opt);
        o.textContent = String(opt);
        if (String(opt) === String(entry.value)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { entry.value = sel.value; });
      row.appendChild(sel);
      return row;
    }
    if (entry.kind === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'gen-checkbox';
      input.checked = !!entry.value;
      input.addEventListener('change', () => { entry.value = input.checked; });
      row.appendChild(input);
      return row;
    }
    // int / float — number input, with min/max/step from object_info.
    // Seed-named widgets get a 🎲 randomize button alongside.
    const inputRow = document.createElement('div');
    inputRow.className = 'gen-input-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'gen-input';
    input.value = (entry.value == null) ? '' : String(entry.value);
    if (entry.kind === 'int') {
      input.step = '1';
    } else if (entry.step != null) {
      input.step = String(entry.step);
    } else {
      input.step = '0.01';
    }
    if (Number.isFinite(entry.min)) input.min = String(entry.min);
    if (Number.isFinite(entry.max)) input.max = String(entry.max);
    input.addEventListener('input', () => {
      const v = (entry.kind === 'int')
        ? parseInt(input.value, 10)
        : parseFloat(input.value);
      if (Number.isFinite(v)) entry.value = v;
    });
    inputRow.appendChild(input);
    if (entry.name === 'seed' || entry.name === 'noise_seed') {
      const rnd = document.createElement('button');
      rnd.type = 'button';
      rnd.className = 'gen-action';
      rnd.textContent = '🎲';
      rnd.title = 'Randomize';
      rnd.addEventListener('click', () => {
        const v = Math.floor(Math.random() * 0xFFFFFFFF);
        input.value = String(v);
        entry.value = v;
      });
      inputRow.appendChild(rnd);
    }
    row.appendChild(inputRow);
    return row;
  }

  function _genRenderFields() {
    if (!genBodyEl || !_genCurrent) return;
    genBodyEl.innerHTML = '';
    const { fields } = _genCurrent;
    if (fields.missingObjectInfo) {
      const hint = document.createElement('div');
      hint.className = 'gen-empty';
      hint.textContent = 'WAITING FOR COMFYUI · /object_info NOT YET LOADED — HIT ↻';
      genBodyEl.appendChild(hint);
      return;
    }
    if (!fields.nodes.length) {
      const hint = document.createElement('div');
      hint.className = 'gen-empty';
      hint.textContent = 'NO EDITABLE WIDGETS DISCOVERED FOR THIS WORKFLOW';
      genBodyEl.appendChild(hint);
      return;
    }
    // Bucket entries.
    //   media        → image/video/audio loaders
    //   positive     → main prompt
    //   negative     → negative prompt
    //   dimensions   → width/height/megapixels/duration/fps/scale-ish
    //   advanced     → everything else (collapsed by default)
    //
    // Dimension detection uses both the widget's own name and the
    // subgraph-instance label that proxies to it — that's how a
    // `value` widget on a `PrimitiveInt` is recognized as "WIDTH" in
    // ltx2_3 workflows where the subgraph relabels it.
    const DIM_RE = /^(width|height|megapixels?|mp|scale|resolution|image_size|size|aspect_ratio|longer_edge_size|fps|frame_?rate|duration|length|num_frames|batch_size|seconds)$/i;
    let positive = null, negative = null;
    const media = [];
    const dims = [];
    const advanced = [];
    for (const node of fields.nodes) {
      for (const entry of node.entries) {
        if (entry.role === 'prompt-positive')      { positive = entry; continue; }
        if (entry.role === 'prompt-negative')      { negative = entry; continue; }
        if (entry.role && entry.role.startsWith('media-')) { media.push({ node, entry }); continue; }
        const dimLabel = (entry.subgraphLabel && DIM_RE.test(entry.subgraphLabel))
          ? entry.subgraphLabel
          : (DIM_RE.test(entry.name || '') ? entry.name : null);
        if (dimLabel && (entry.kind === 'int' || entry.kind === 'float')) {
          dims.push({ node, entry, label: dimLabel });
          continue;
        }
        advanced.push({ node, entry });
      }
    }
    // ── HERO (always visible) ─────────────────────────────────────
    for (const m of media) genBodyEl.appendChild(_genBuildMediaBlock(m.entry));
    if (positive) genBodyEl.appendChild(_genBuildPromptBlock('PROMPT', positive, 'positive'));
    if (negative) genBodyEl.appendChild(_genBuildPromptBlock('NEGATIVE PROMPT', negative, 'negative'));
    if (dims.length) genBodyEl.appendChild(_genBuildDimsBlock(dims));
    // ── ADVANCED (collapsible) ────────────────────────────────────
    if (advanced.length) {
      genBodyEl.appendChild(_genBuildAdvancedBlock(advanced));
    }
    // RUN
    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'gen-run-btn';
    runBtn.id = 'gen-run-btn';
    runBtn.textContent = '▶ RUN';
    runBtn.addEventListener('click', () => _genRun());
    genBodyEl.appendChild(runBtn);
  }

  // Dimensions block — a grid of width/height/fps/etc sliders, each one
  // a labelled number input with a range slider when min/max are known.
  function _genBuildDimsBlock(dims) {
    const block = document.createElement('div');
    block.className = 'gen-dims-block';
    const head = document.createElement('div');
    head.className = 'gen-section-head';
    head.textContent = 'DIMENSIONS';
    block.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'gen-dims-grid';
    for (const d of dims) grid.appendChild(_genBuildDimRow(d.label, d.entry));
    block.appendChild(grid);
    return block;
  }

  function _genBuildDimRow(label, entry) {
    const row = document.createElement('div');
    row.className = 'gen-dim-row';
    const lbl = document.createElement('span');
    lbl.className = 'gen-dim-label';
    lbl.textContent = String(label).toUpperCase();
    row.appendChild(lbl);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'gen-input gen-dim-num';
    num.value = (entry.value == null) ? '' : String(entry.value);
    if (entry.kind === 'int') num.step = '1';
    else if (entry.step != null) num.step = String(entry.step);
    else num.step = '0.01';
    if (Number.isFinite(entry.min)) num.min = String(entry.min);
    if (Number.isFinite(entry.max)) num.max = String(entry.max);
    // Range slider if we have both bounds — caps at 4096 / 240 for
    // sane stepping; the number field can still go higher.
    let slider = null;
    if (Number.isFinite(entry.min) && Number.isFinite(entry.max)) {
      slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'gen-dim-slider';
      slider.min = String(entry.min);
      slider.max = String(entry.max);
      slider.step = num.step;
      slider.value = num.value;
    }
    const commit = (v, src) => {
      const parsed = (entry.kind === 'int') ? parseInt(v, 10) : parseFloat(v);
      if (!Number.isFinite(parsed)) return;
      entry.value = parsed;
      if (src !== 'num') num.value = String(parsed);
      if (slider && src !== 'slider') slider.value = String(parsed);
    };
    num.addEventListener('input', () => commit(num.value, 'num'));
    if (slider) slider.addEventListener('input', () => commit(slider.value, 'slider'));
    if (slider) row.appendChild(slider);
    row.appendChild(num);
    return row;
  }

  // Collapsible ADVANCED section — header is a toggle, body is the
  // compact label/control grid we had before. Collapsed by default;
  // state is persisted across re-renders of the same workflow on a
  // per-tab key.
  function _genBuildAdvancedBlock(advanced) {
    const block = document.createElement('details');
    block.className = 'gen-advanced';
    const stateKey = `advOpen:${_genCurrent?.file || ''}`;
    if (window._genState[stateKey]) block.open = true;
    block.addEventListener('toggle', () => {
      window._genState[stateKey] = block.open;
    });
    const summary = document.createElement('summary');
    summary.className = 'gen-section-head gen-advanced-head';
    summary.innerHTML = '<span class="gen-advanced-chev">▸</span>ADVANCED SETTINGS';
    block.appendChild(summary);
    const grid = document.createElement('div');
    grid.className = 'gen-params-grid';
    for (const p of advanced) grid.appendChild(_genBuildCompactRow(p.entry, p.node));
    block.appendChild(grid);
    return block;
  }

  // Big textarea block for a prompt — full width, several lines tall.
  function _genBuildPromptBlock(label, entry, variant) {
    const block = document.createElement('div');
    block.className = `gen-prompt-block gen-prompt-${variant}`;
    const lbl = document.createElement('div');
    lbl.className = 'gen-section-head';
    lbl.textContent = label;
    block.appendChild(lbl);
    const ta = document.createElement('textarea');
    ta.className = 'gen-textarea gen-prompt-textarea';
    ta.value = (entry.value == null) ? '' : String(entry.value);
    ta.spellcheck = false;
    ta.placeholder = variant === 'negative'
      ? 'describe what to avoid…'
      : 'describe the image / video / audio you want…';
    ta.addEventListener('input', () => { entry.value = ta.value; });
    block.appendChild(ta);
    return block;
  }

  // File-picker block for image/video loader widgets. Drops the file
  // onto ComfyUI's /upload/image endpoint and writes the returned name
  // into the widget value, so the loader picks it up at RUN time.
  function _genBuildMediaBlock(entry) {
    const kind = entry.mediaKind || 'image';
    const block = document.createElement('div');
    block.className = 'gen-media-block';
    const lbl = document.createElement('div');
    lbl.className = 'gen-section-head';
    lbl.textContent = `${kind.toUpperCase()} INPUT`;
    block.appendChild(lbl);
    const row = document.createElement('div');
    row.className = 'gen-media-row';
    const fileBtn = document.createElement('label');
    fileBtn.className = 'gen-media-btn';
    fileBtn.textContent = '⇪ CHOOSE FILE';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = kind === 'image'
      ? 'image/*'
      : (kind === 'video' ? 'video/*' : 'audio/*');
    fileInput.style.display = 'none';
    fileBtn.appendChild(fileInput);
    const name = document.createElement('span');
    name.className = 'gen-media-name';
    name.textContent = entry.value ? String(entry.value) : '(no file)';
    const preview = document.createElement(kind === 'video' ? 'video' : (kind === 'audio' ? 'audio' : 'img'));
    preview.className = 'gen-media-preview';
    if (kind !== 'image') preview.controls = true;
    preview.hidden = true;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      name.textContent = `… UPLOADING ${f.name}`;
      try {
        const uploaded = await _genUploadMedia(f);
        entry.value = uploaded;
        name.textContent = uploaded;
        const url = URL.createObjectURL(f);
        if (kind === 'image') preview.src = url;
        else preview.src = url;
        preview.hidden = false;
      } catch (err) {
        name.textContent = `UPLOAD FAILED · ${err.message || err}`;
      }
    });
    row.appendChild(fileBtn);
    row.appendChild(name);
    block.appendChild(row);
    block.appendChild(preview);
    return block;
  }

  // One row in the compact 2-col settings grid. Label-on-left, control
  // on the right; multi-line strings span the full row.
  function _genBuildCompactRow(entry, node) {
    const row = document.createElement('div');
    const isWide = (entry.kind === 'string' && entry.multiline);
    row.className = 'gen-grid-row' + (isWide ? ' is-wide' : '');
    const label = document.createElement('span');
    label.className = 'gen-grid-label';
    label.textContent = (entry.name || '').toUpperCase();
    label.title = `${node?.title || node?.type || ''} #${node?.id ?? ''}`;
    row.appendChild(label);
    // Reuse the original entry builder but strip its outer label so the
    // grid owns alignment. We pluck the control element out of what
    // _genBuildEntryRow returns and re-parent it under the grid row.
    const inner = _genBuildEntryRow(entry);
    const innerLabel = inner.querySelector('.gen-label');
    if (innerLabel) innerLabel.remove();
    // The original row also wraps number inputs in a flex .gen-input-row
    // — keep it; just transplant whatever node remains.
    while (inner.firstChild) row.appendChild(inner.firstChild);
    return row;
  }

  // ── Submit + poll ──────────────────────────────────────────────
  async function _genRun() {
    if (_genRunning || !_genCurrent) return;
    const runBtn = document.getElementById('gen-run-btn');
    _genRunning = true;
    _genCancelRequested = false;
    _genCurrentPromptId = null;
    if (genCancelBtn) genCancelBtn.disabled = false;
    if (runBtn) {
      runBtn.classList.add('is-running');
      runBtn.textContent = '… SUBMITTING';
      runBtn.disabled = true;
    }
    _genSetStatus('SUBMITTING', 'ok');
    try {
      await _genFetchObjectInfo();
      const prompt = _genBuildApiPayload(_genCurrent);
      const r = await _genHttp({
        method: 'POST',
        url: `${_genHost}/prompt`,
        body: { prompt, client_id: _genClientId },
      });
      if (!r.ok) {
        const txt = r.bytes ? _decodeBytesToText(r.bytes) : (r.error || '');
        throw new Error(`HTTP ${r.status || 'fail'}: ${txt.slice(0, 200)}`);
      }
      const data = JSON.parse(_decodeBytesToText(r.bytes));
      const promptId = data.prompt_id;
      if (!promptId) throw new Error('no prompt_id in response');
      _genCurrentPromptId = promptId;
      _genSetStatus(`QUEUED · ${promptId.slice(0, 8)}`, 'ok');
      if (runBtn) runBtn.textContent = '… RUNNING';
      await _genPollAndFetch(promptId);
    } catch (err) {
      if (_genCancelRequested) {
        _genSetStatus('CANCELLED', 'error');
      } else {
        console.warn('[generate] run failed:', err);
        _genSetStatus(`ERROR · ${err.message || err}`, 'error');
      }
    } finally {
      _genRunning = false;
      _genCurrentPromptId = null;
      if (genCancelBtn) genCancelBtn.disabled = true;
      if (runBtn) {
        runBtn.classList.remove('is-running');
        runBtn.textContent = '▶ RUN';
        runBtn.disabled = false;
      }
    }
  }

  // Tell ComfyUI to interrupt the running job, then break out of our
  // local poll loop by flipping a flag that _genPollAndFetch checks.
  async function _genCancel() {
    if (!_genRunning) return;
    _genCancelRequested = true;
    if (genCancelBtn) genCancelBtn.disabled = true;
    _genSetStatus('CANCELLING…', 'error');
    try {
      await _genHttp({ method: 'POST', url: `${_genHost}/interrupt`, body: {} });
      // Best-effort: also drop our queued job from the server queue, in
      // case the interrupt landed on the running one but ours was queued.
      if (_genCurrentPromptId) {
        await _genHttp({
          method: 'POST',
          url: `${_genHost}/queue`,
          body: { delete: [_genCurrentPromptId] },
        });
      }
    } catch (err) {
      console.warn('[generate] cancel failed:', err);
    }
  }

  // Tell ComfyUI to unload models and free VRAM/RAM. Safe to call when
  // idle. Posts to /free with both flags set — the server will release
  // model weights and clear its CUDA cache.
  async function _genFlushMemory() {
    if (genFlushBtn) genFlushBtn.disabled = true;
    _genSetStatus('FLUSHING MEMORY…', 'ok');
    try {
      const r = await _genHttp({
        method: 'POST',
        url: `${_genHost}/free`,
        body: { unload_models: true, free_memory: true },
      });
      if (r.ok) {
        _genSetStatus('MEMORY FLUSHED', 'ok');
      } else {
        _genSetStatus(`FLUSH FAILED · HTTP ${r.status || r.error || 'fail'}`, 'error');
      }
    } catch (err) {
      _genSetStatus(`FLUSH ERROR · ${err.message || err}`, 'error');
    } finally {
      if (genFlushBtn) genFlushBtn.disabled = false;
    }
  }

  async function _genPollAndFetch(promptId) {
    const start = Date.now();
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 min — generation can be long
    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise((res) => setTimeout(res, 1200));
      if (_genCancelRequested) throw new Error('cancelled');
      const history = await _genGetJson(`${_genHost}/history/${promptId}`);
      if (!history) continue;
      const entry = history?.[promptId];
      if (!entry) continue;
      const status = entry.status?.status_str;
      if (status === 'error') throw new Error('comfy reported error');
      if (status !== 'success' && !entry.outputs) continue;
      // Iterate EVERY output item so batch generations land all their
      // images/videos/audio in the thumbnail strip — not just the first.
      let downloaded = 0;
      for (const nodeId of Object.keys(entry.outputs || {})) {
        const node = entry.outputs[nodeId];
        const groups = [
          ['image', node.images],
          ['video', node.gifs],
          ['video', node.videos],
          ['audio', node.audio],
        ];
        for (const [kind, items] of groups) {
          if (!Array.isArray(items)) continue;
          for (const item of items) {
            const url = `${_genHost}/view?filename=${encodeURIComponent(item.filename)}`
                      + `&subfolder=${encodeURIComponent(item.subfolder || '')}`
                      + `&type=${encodeURIComponent(item.type || 'output')}`;
            await _genFetchAndSave(url, item.filename, kind);
            downloaded++;
          }
        }
      }
      if (downloaded > 0) return;
      if (status === 'success') {
        _genSetStatus('COMPLETED · no output items', 'ok');
        return;
      }
    }
    throw new Error('timeout waiting for completion');
  }

  // Two-word atmospheric tag generator for audio outputs. Sequential
  // USER NNNN names don't say anything about a song; an evocative name
  // doubles as a quick visual cue in the gallery and the thumbnail strip.
  // Number suffix avoids collisions; main de-collides further if needed.
  function _genAudioName() {
    const ADJ = [
      'NEON', 'AURORA', 'VELVET', 'COSMIC', 'CRYSTAL', 'SHADOW',
      'MIDNIGHT', 'SOLAR', 'AMBER', 'FROZEN', 'ECHO', 'GHOST',
      'IRON', 'OBSIDIAN', 'PHANTOM', 'EMBER', 'SILVER', 'ARCANE',
      'ASTRAL', 'LUMINOUS', 'OPAL', 'PLASMA', 'QUANTUM', 'RADIANT',
      'SCARLET', 'TIDAL', 'VOID', 'EMERALD', 'ROGUE', 'STARLIT',
    ];
    const NOUN = [
      'PULSE', 'CASCADE', 'MIRAGE', 'ECLIPSE', 'NEBULA', 'ORBIT',
      'REVERIE', 'TIDE', 'VORTEX', 'WAKE', 'CIPHER', 'DRIFT',
      'FROST', 'GLITCH', 'HORIZON', 'INFERNO', 'LUNA', 'MAZE',
      'NOMAD', 'OASIS', 'REQUIEM', 'SIGNAL', 'TEMPEST', 'UMBRA',
      'WAVELENGTH', 'CIRCUIT', 'GHOST', 'ASCENT', 'BLOOM', 'HOLLOW',
    ];
    const a = ADJ[Math.floor(Math.random() * ADJ.length)];
    const n = NOUN[Math.floor(Math.random() * NOUN.length)];
    const num = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return `${a} ${n} ${num}`;
  }

  async function _genFetchAndSave(url, originalName, kind) {
    _genSetStatus('DOWNLOADING', 'ok');
    const r = await _genHttp({ method: 'GET', url });
    if (!r.ok || !r.bytes) throw new Error(`download ${r.error || ('HTTP ' + r.status)}`);
    const buf = new Uint8Array(r.bytes);
    // Derive extension from original filename.
    const m = (originalName || '').match(/\.([A-Za-z0-9]{2,5})$/);
    const ext = m ? '.' + m[1].toLowerCase() : '.png';
    // Only audio gets a creative name — image/video can be visually
    // identified at a glance, so sequential USER NNNN is fine there.
    const nameHint = kind === 'audio' ? _genAudioName() : '';
    const result = await window.dash?.comfySaveOutput?.(kind, buf, ext, nameHint);
    if (result?.ok) {
      _genSetStatus(`SAVED · ${result.name}`, 'ok');
      _genShowOutput(result.path, kind, result.name);
    } else {
      _genSetStatus(`SAVE ERROR · ${result?.error || 'unknown'}`, 'error');
    }
  }

  // ── Themed audio widget + fluid waveform visualizer ─────────────
  // Drives the .gen-audio-player UI: play/pause, scrub bar, time, and a
  // smooth curve waveform on canvas. The native <audio> element stays
  // as the playback engine; we just hide its controls and read its
  // state. WebAudio AnalyserNode feeds getByteTimeDomainData for an
  // oscilloscope look, smoothed and stroked via quadraticCurveTo so
  // the line flows rather than ticks.
  let _genAudioCtx = null;
  let _genAudioSrc = null;       // MediaElementSource tied to genOutputAud
  let _genAudioAnalyser = null;
  let _genAudioVizRaf = 0;
  let _genAudioWired = false;
  function _genStopAudioViz() {
    if (_genAudioVizRaf) {
      cancelAnimationFrame(_genAudioVizRaf);
      _genAudioVizRaf = 0;
    }
  }
  function _genWireAudioWidget() {
    if (_genAudioWired) return; // event listeners are one-time
    _genAudioWired = true;
    const playBtn   = document.getElementById('gen-audio-play');
    const iconPlay  = playBtn?.querySelector('.gen-audio-icon-play');
    const iconPause = playBtn?.querySelector('.gen-audio-icon-pause');
    const barEl     = document.getElementById('gen-audio-bar');
    const progEl    = document.getElementById('gen-audio-progress');
    const knobEl    = document.getElementById('gen-audio-knob');
    const timeEl    = document.getElementById('gen-audio-time');
    const vizCanvas = document.getElementById('gen-audio-viz');
    if (!genOutputAud) return;
    // Initialize WebAudio chain once on first play (user gesture
    // unblocks AudioContext on Chromium).
    function _ensureAudioGraph() {
      if (_genAudioCtx) return;
      try {
        _genAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _genAudioSrc = _genAudioCtx.createMediaElementSource(genOutputAud);
        _genAudioAnalyser = _genAudioCtx.createAnalyser();
        _genAudioAnalyser.fftSize = 1024;
        _genAudioAnalyser.smoothingTimeConstant = 0.85;
        _genAudioSrc.connect(_genAudioAnalyser);
        _genAudioAnalyser.connect(_genAudioCtx.destination);
      } catch (err) {
        console.warn('[gen-audio] AudioContext init failed:', err?.message || err);
      }
    }
    function _setPlayIcons(playing) {
      if (iconPlay)  iconPlay.hidden  = playing;
      if (iconPause) iconPause.hidden = !playing;
    }
    function _fmt(s) {
      if (!Number.isFinite(s) || s < 0) s = 0;
      const m = Math.floor(s / 60);
      const r = Math.floor(s % 60);
      return `${m}:${String(r).padStart(2, '0')}`;
    }
    function _paintTime() {
      const cur = genOutputAud.currentTime || 0;
      const dur = genOutputAud.duration || 0;
      if (timeEl) timeEl.textContent = `${_fmt(cur)} / ${_fmt(dur)}`;
      if (dur > 0) {
        const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
        if (progEl) progEl.style.width = `${pct}%`;
        if (knobEl) knobEl.style.left  = `${pct}%`;
      }
    }
    function _drawViz() {
      const ana = _genAudioAnalyser;
      const c = vizCanvas;
      if (!ana || !c) { _genAudioVizRaf = 0; return; }
      const ctx = c.getContext('2d');
      // Resize canvas backing store to its CSS size for crisp lines.
      const cssW = c.clientWidth || c.width;
      const cssH = c.clientHeight || c.height;
      if (c.width !== cssW || c.height !== cssH) { c.width = cssW; c.height = cssH; }
      const N = ana.fftSize;
      const data = new Uint8Array(N);
      ana.getByteTimeDomainData(data);
      ctx.clearRect(0, 0, cssW, cssH);
      // Accent-tinted glow underlay. Drawing a wider, low-alpha stroke
      // first gives the line a soft halo without resorting to shadow
      // blur (which is heavy when animated).
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent').trim() || '#3df';
      const midY = cssH / 2;
      const amp  = cssH * 0.45;
      // Sample down to ~150 points for smooth curves while staying fast.
      const step = Math.max(1, Math.floor(N / 150));
      const pts = [];
      for (let i = 0; i < N; i += step) {
        const v = (data[i] - 128) / 128;
        const x = (i / N) * cssW;
        const y = midY + v * amp;
        pts.push([x, y]);
      }
      if (pts[pts.length - 1]?.[0] < cssW) pts.push([cssW, midY]);
      // Two-pass stroke: thick translucent halo + crisp inner line.
      for (const pass of [{ w: 6, a: 0.18 }, { w: 1.6, a: 0.95 }]) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        // Quadratic smoothing between each consecutive pair using
        // midpoint control points — gives a flowing curve instead of
        // jagged segments.
        for (let i = 1; i < pts.length - 1; i++) {
          const [x1, y1] = pts[i];
          const [x2, y2] = pts[i + 1];
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          ctx.quadraticCurveTo(x1, y1, mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0], last[1]);
        ctx.lineWidth   = pass.w;
        ctx.globalAlpha = pass.a;
        ctx.strokeStyle = accent;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      _paintTime();
      _genAudioVizRaf = requestAnimationFrame(_drawViz);
    }
    playBtn?.addEventListener('click', async () => {
      _ensureAudioGraph();
      try { if (_genAudioCtx?.state === 'suspended') await _genAudioCtx.resume(); } catch {}
      if (genOutputAud.paused) genOutputAud.play().catch(() => {});
      else genOutputAud.pause();
    });
    genOutputAud.addEventListener('play',  () => {
      _setPlayIcons(true);
      _genStopAudioViz();
      _genAudioVizRaf = requestAnimationFrame(_drawViz);
    });
    genOutputAud.addEventListener('pause', () => {
      _setPlayIcons(false);
      _genStopAudioViz();
      _paintTime();
    });
    genOutputAud.addEventListener('ended', () => { _setPlayIcons(false); _genStopAudioViz(); });
    genOutputAud.addEventListener('timeupdate', _paintTime);
    genOutputAud.addEventListener('loadedmetadata', _paintTime);
    barEl?.addEventListener('click', (e) => {
      if (!genOutputAud.duration) return;
      const r = barEl.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      try { genOutputAud.currentTime = frac * genOutputAud.duration; } catch {}
    });
  }
  // Expose stop hook to _genShowMainOutput (which is defined above and
  // calls it via typeof guard so order doesn't matter).
  window._genStopAudioViz = _genStopAudioViz;

  function _genShowOutput(absPath, kind, name) {
    if (!genOutputEl) return;
    const url = `dash3d-file://gallery/generated/${kind}/${encodeURIComponent(name)}`;
    // Append to session history (de-dup on name in case of replay).
    if (!_genOutputHistory.some((o) => o.name === name)) {
      _genOutputHistory.push({ kind, name, url });
    }
    _genShowMainOutput(_genOutputHistory.length - 1);
    _genRenderThumbs();
  }

  function _genShowMainOutput(idx) {
    if (!genOutputEl) return;
    const item = _genOutputHistory[idx];
    if (!item) return;
    genOutputEl.hidden = false;
    if (genOutputName) genOutputName.textContent = item.name || '';
    [genOutputImg, genOutputVid, genOutputAud].forEach((el) => {
      if (el) { el.hidden = true; try { el.removeAttribute('src'); } catch {} }
    });
    // Hide the themed audio widget by default; only audio outputs
    // expose it. Stop any in-flight visualizer animation.
    const audioPlayerEl = document.getElementById('gen-audio-player');
    if (audioPlayerEl) audioPlayerEl.hidden = true;
    if (typeof _genStopAudioViz === 'function') _genStopAudioViz();
    if (item.kind === 'image' && genOutputImg) {
      genOutputImg.src = item.url;
      genOutputImg.hidden = false;
    } else if (item.kind === 'video' && genOutputVid) {
      genOutputVid.src = item.url;
      genOutputVid.hidden = false;
    } else if (item.kind === 'audio' && genOutputAud) {
      genOutputAud.src = item.url;
      // Keep <audio> hidden — playback engine only. Show themed widget.
      if (audioPlayerEl) audioPlayerEl.hidden = false;
      if (typeof _genWireAudioWidget === 'function') _genWireAudioWidget();
    }
    // Reflect the active thumb selection.
    genOutputThumbs?.querySelectorAll('.gen-output-thumb').forEach((el, i) => {
      el.classList.toggle('is-active', i === idx);
    });
  }

  function _genRenderThumbs() {
    if (!genOutputThumbs) return;
    genOutputThumbs.innerHTML = '';
    _genOutputHistory.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gen-output-thumb';
      btn.title = item.name;
      if (idx === _genOutputHistory.length - 1) btn.classList.add('is-active');
      if (item.kind === 'image') {
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = '';
        btn.appendChild(img);
      } else {
        // For video/audio, show a kind glyph instead of decoding a frame.
        const icon = document.createElement('span');
        icon.className = 'gen-output-thumb-icon';
        icon.textContent = item.kind === 'video' ? '▶' : '♪';
        btn.appendChild(icon);
      }
      btn.addEventListener('click', () => _genShowMainOutput(idx));
      genOutputThumbs.appendChild(btn);
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────
  genTabsEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gen-tab');
    if (!btn || _genRunning) return;
    _genSelectWorkflow(btn.dataset.file);
    playSfx?.('click');
  });
  genRefreshBtn?.addEventListener('click', () => {
    _genLoadWorkflows();
    _genCheckComfy();
    playSfx?.('click');
  });
  genCancelBtn?.addEventListener('click', () => {
    _genCancel();
    playSfx?.('click');
  });
  genFlushBtn?.addEventListener('click', () => {
    _genFlushMemory();
    playSfx?.('click');
  });

  // Initial probe — must wait for cfg.comfyHost to load before firing
  // so non-default hosts (custom port) don't hit the wrong endpoint
  // on the very first check.
  (async () => {
    try {
      const cfg = (await window.dash?.getConfig?.()) || {};
      if (cfg.comfyHost && typeof cfg.comfyHost === 'string') {
        _genHost = cfg.comfyHost.replace(/\/+$/, '');
      }
    } catch {}
    const online = await _genCheckComfy();
    if (online) _genFetchObjectInfo();
    _genLoadWorkflows();
  })();
  // Periodic connection re-check — quietly switches the status pill if
  // ComfyUI is started/stopped after the dashboard loads.
  setInterval(() => {
    if (!comboPanel?.dataset?.mode === 'generate') return;
    _genCheckComfy();
  }, 15000);
}
