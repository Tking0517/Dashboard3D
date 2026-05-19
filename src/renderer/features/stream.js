// STREAM tab · embedded BrowserView host (Discord + future sibs).
// Main owns the actual BrowserView; this module measures the
// stream-stage rect and tells main where to draw. Lazy combo pane —
// app.js dynamically import()s this on the first STREAM tab open, so
// none of it parses or runs until then.
//
//   init()       — one-time: grab elements, wire the sub-tab buttons
//   activate()   — STREAM tab shown: mount + position the BrowserView
//   deactivate() — STREAM tab left: detach the BrowserView

let paneEl, tabsEl, stageEl, statusEl;
let _activeKind = 'discord';
let _mounted = false;
let _ro = null;
let _lastRect = null;
let _ready = false;
let _bootWaitArmed = false;

// Returns the stream-stage rect as FRACTIONS (0..1) of the window
// viewport, walking up the DOM to multiply in any CSS `zoom` applied on
// ancestor panels. This matches the convention the BROWSER tab uses —
// main multiplies the fractions against getContentBounds() to convert
// back into DIPs. Raw pixel coords would place the BV at the wrong
// absolute position whenever the renderer's CSS zoom != 1.
function rectInWindow() {
  let z = 1;
  for (let el = stageEl.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const zv = parseFloat(window.getComputedStyle(el).zoom);
    if (zv && zv !== 1) z *= zv;
  }
  const r = stageEl.getBoundingClientRect();
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  return {
    x: (r.left * z) / vw,
    y: (r.top * z) / vh,
    width: (r.width * z) / vw,
    height: (r.height * z) / vh,
  };
}
function rectsEqual(a, b) {
  if (!a || !b) return false;
  // Half-pixel tolerance on fractions — ignore sub-pixel jitter from
  // layout flushes that wouldn't be visible anyway.
  return Math.abs(a.x - b.x) < 0.0005
      && Math.abs(a.y - b.y) < 0.0005
      && Math.abs(a.width - b.width) < 0.0005
      && Math.abs(a.height - b.height) < 0.0005;
}
async function pushBounds() {
  const next = rectInWindow();
  if (!next.width || !next.height) return;
  if (rectsEqual(next, _lastRect)) return;
  _lastRect = next;
  try { await window.dash?.streamBounds?.(next); } catch {}
}
// Reconcile the native embed against the stage. The stage collapses to
// 0×0 when the Productivity panel is collapsed (`.panel-body` →
// display:none) — the embed is a native view, not DOM, so it would keep
// floating over the collapsed panel unless we explicitly detach it here.
// The observer stays live while detached so the embed re-mounts the
// moment the stage is laid out again.
function reconcileStage() {
  const next = rectInWindow();
  const tiny = !next.width || !next.height
            || next.width < 0.001 || next.height < 0.001;
  if (tiny) {
    if (_mounted) {
      _mounted = false;
      _lastRect = null;
      try { window.dash?.streamHide?.(); } catch {}
      if (statusEl) {
        statusEl.textContent = 'CONNECTING TO ' + _activeKind.toUpperCase() + '…';
        statusEl.classList.remove('is-error');
        statusEl.style.opacity = '1';
      }
    }
    return;
  }
  if (!_mounted) { showActive(); return; }
  pushBounds();
}
function startObserving() {
  if (_ro) return;
  // ResizeObserver covers stage resizes (panel-fold animation, collapse,
  // etc). Window resizes affect the stage's offsetTop/left too — handle
  // via a separate listener since RO only fires on the observed element.
  _ro = new ResizeObserver(() => reconcileStage());
  _ro.observe(stageEl);
  window.addEventListener('resize', reconcileStage);
  reconcileStage();
}
function stopObserving() {
  if (_ro) { try { _ro.disconnect(); } catch {} _ro = null; }
  window.removeEventListener('resize', reconcileStage);
}

function currentPalette() {
  // Read the live dashboard theme tokens from :root computedStyle so the
  // Discord embed retints + retypes to match the active theme.
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  // Is a matte theme active? Matte themes want monochrome icons in the
  // embeds; cyber themes keep icons full colour. data-theme lives on
  // <html> — see app.js theme picker.
  const eink = String(document.documentElement.dataset.theme || '').startsWith('matte');
  return {
    eink,
    bg:          pick('--bg',           '#070a0e'),
    panelBg:     pick('--panel-bg',     '#0c1014'),
    ruleDim:     pick('--rule-dim',     'rgba(92,207,255,0.22)'),
    accent:      pick('--accent',       '#5ccfff'),
    amber:       pick('--amber',        '#ffd05b'),
    ok:          pick('--ok',           '#5fe39a'),
    red:         pick('--red',          '#ff5f6e'),
    text:        pick('--text',         '#cfe6f7'),
    muted:       pick('--muted',        '#6e8aa3'),
    fontTech:    pick('--font-tech',    "'Share Tech Mono','Consolas',monospace"),
    fontDisplay: pick('--font-display', "'Rajdhani','Arial Narrow',sans-serif"),
  };
}
async function showActive() {
  // During the boot intro the dashboard DOM is blurred + flickered via
  // `body.is-booting` CSS. The embed is a native BrowserView — it can't
  // receive that filter, so it would float crisp over the effect. Hold
  // the mount until boot finishes (the is-booting class drops), then
  // re-run showActive once.
  if (document.body.classList.contains('is-booting')) {
    if (!_bootWaitArmed) {
      _bootWaitArmed = true;
      const obs = new MutationObserver(() => {
        if (!document.body.classList.contains('is-booting')) {
          obs.disconnect();
          _bootWaitArmed = false;
          showActive();
        }
      });
      obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    return;
  }
  const bounds = rectInWindow();
  // Fractions are 0..1; treat anything below 0.001 as "stage isn't laid
  // out yet" (combo-pane just became visible, layout hasn't flushed).
  // Re-measure next frame.
  if (bounds.width < 0.001 || bounds.height < 0.001) {
    requestAnimationFrame(showActive);
    return;
  }
  _lastRect = bounds;
  try {
    const r = await window.dash?.streamShow?.({ kind: _activeKind, bounds, palette: currentPalette() });
    if (r?.ok) {
      _mounted = true;
      if (statusEl) statusEl.textContent = 'CONNECTED';
      // Status placeholder is painted under the BrowserView; hide it so
      // any z-stacking quirk doesn't show ghost text.
      statusEl?.style.setProperty('opacity', '0');
      startObserving();
    } else if (statusEl) {
      statusEl.textContent = 'FAILED TO MOUNT · ' + (r?.error || 'unknown');
      statusEl.classList.add('is-error');
      statusEl.style.opacity = '1';
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'IPC ERROR · ' + err.message;
      statusEl.classList.add('is-error');
    }
  }
}
async function hideActive() {
  stopObserving();
  if (!_mounted) return;
  _mounted = false;
  _lastRect = null;
  try { await window.dash?.streamHide?.(); } catch {}
  if (statusEl) {
    statusEl.textContent = 'CONNECTING TO ' + _activeKind.toUpperCase() + '…';
    statusEl.classList.remove('is-error');
    statusEl.style.opacity = '1';
  }
}

export function init() {
  if (_ready) return;
  paneEl   = document.querySelector('.combo-pane-stream');
  tabsEl   = document.getElementById('stream-tabs');
  stageEl  = document.getElementById('stream-stage');
  statusEl = document.getElementById('stream-status');
  if (!paneEl || !tabsEl || !stageEl) return;
  _activeKind = stageEl.dataset.streamTab || 'discord';

  // Sub-tab buttons. The wire-up is generic so future TWITCH / YOUTUBE
  // additions just need a new <button> + matching main-process kind.
  tabsEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest?.('.stream-tab');
    if (!btn) return;
    const kind = btn.dataset.streamTab;
    if (!kind || kind === _activeKind) return;
    _activeKind = kind;
    stageEl.dataset.streamTab = kind;
    tabsEl.querySelectorAll('.stream-tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.streamTab === kind);
    });
    // Re-mount under the new kind. showActive handles the swap
    // server-side via stream:show which detaches the previous view first.
    if (statusEl) {
      statusEl.textContent = 'SWITCHING TO ' + kind.toUpperCase() + '…';
      statusEl.classList.remove('is-error');
      statusEl.style.opacity = '1';
    }
    await showActive();
  });
  // Re-theme the embed live when the dashboard theme changes. The embed
  // is a native BrowserView — it can't see the dashboard's CSS — so on
  // every data-theme swap we re-measure + re-push the fresh palette via
  // showActive(), and main re-injects the themed stylesheet.
  try {
    const themeObs = new MutationObserver(() => { if (_mounted) showActive(); });
    themeObs.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
  } catch {}

  _ready = true;
}

export function activate()   { if (_ready) showActive(); }
export function deactivate() { if (_ready) hideActive(); }
