// STEAM pane — dedicated BrowserView pointed at the Steam web store/library
// so the user can sign in and browse just like a normal browser tab. Game
// launches hand off to the native Steam client via the steam://run/<appid>
// URL protocol; FULLSCREEN minimises this dashboard window so the game
// (a separate native window owned by Steam) dominates the screen.

let _activateImpl = null;
let _deactivateImpl = null;

export function init(_deps) {
  const stageEl    = document.getElementById('steam-stage');
  const statusEl   = document.getElementById('steam-status');
  const urlEl      = document.getElementById('steam-url');
  const appidEl    = document.getElementById('steam-appid');
  const backBtn    = document.getElementById('steam-back-btn');
  const forwardBtn = document.getElementById('steam-forward-btn');
  const reloadBtn  = document.getElementById('steam-reload-btn');
  const homeBtn    = document.getElementById('steam-home-btn');
  const libraryBtn = document.getElementById('steam-library-btn');
  const launchBtn  = document.getElementById('steam-launch-btn');
  const fsBtn      = document.getElementById('steam-fullscreen-btn');
  const pane = document.querySelector('.combo-pane-steam');
  if (!stageEl || !pane) return;

  // Stage rect → fractional viewport coords, matching browser.js so the
  // accumulated CSS zoom (combo-body has `zoom: 1.2`) doesn't shrink the
  // BrowserView away from the visible stage bounds.
  function _stageRectFraction() {
    let z = 1;
    for (let el = stageEl.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const zv = parseFloat(window.getComputedStyle(el).zoom);
      if (zv && zv !== 1) z *= zv;
    }
    const r = stageEl.getBoundingClientRect();
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    return {
      x: (r.left   * z) / vw,
      y: (r.top    * z) / vh,
      width:  (r.width  * z) / vw,
      height: (r.height * z) / vh,
    };
  }
  let _lastSent = null;
  let _boundsTimer = 0;
  function _sendBounds() {
    if (_boundsTimer) return;
    _boundsTimer = window.setTimeout(() => {
      _boundsTimer = 0;
      const r = _stageRectFraction();
      if (_lastSent
        && Math.abs(r.x - _lastSent.x) < 0.0005
        && Math.abs(r.y - _lastSent.y) < 0.0005
        && Math.abs(r.width  - _lastSent.width)  < 0.0005
        && Math.abs(r.height - _lastSent.height) < 0.0005) return;
      _lastSent = r;
      try { window.dash?.steamBounds?.(r); } catch {}
    }, 16);
  }
  try { new ResizeObserver(_sendBounds).observe(stageEl); } catch {}
  try {
    const mo = new MutationObserver(_sendBounds);
    const comboPanel = document.getElementById('combo-panel');
    if (comboPanel) {
      mo.observe(comboPanel, { attributes: true, attributeFilter: ['style', 'class'] });
      if (comboPanel.parentElement) mo.observe(comboPanel.parentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  } catch {}
  window.addEventListener('resize', _sendBounds);

  function _paintNav(state) {
    if (!state) return;
    if (backBtn)    backBtn.disabled    = !state.canBack;
    if (forwardBtn) forwardBtn.disabled = !state.canFwd;
    if (urlEl && document.activeElement !== urlEl) urlEl.value = state.url || '';
    // If the user lands on a store/app/<id>/ page and the AppID field is
    // empty, pre-fill it from the URL — saves typing for the LAUNCH button.
    if (appidEl && !appidEl.value && state.url) {
      const m = state.url.match(/\/app\/(\d+)/);
      if (m) appidEl.value = m[1];
    }
    if (statusEl) statusEl.classList.toggle('is-hidden', !state.loading && !!state.url);
  }

  try {
    window.dash?.onSteamEvent?.((evt) => _paintNav(evt));
  } catch {}

  backBtn   ?.addEventListener('click', () => window.dash?.steamBack?.());
  forwardBtn?.addEventListener('click', () => window.dash?.steamForward?.());
  reloadBtn ?.addEventListener('click', () => window.dash?.steamReload?.());
  homeBtn   ?.addEventListener('click', () => window.dash?.steamHome?.());
  libraryBtn?.addEventListener('click', () => window.dash?.steamLibrary?.());

  urlEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = urlEl.value.trim();
    if (v) window.dash?.steamNavigate?.(v);
  });

  appidEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); launchBtn?.click(); }
  });

  launchBtn?.addEventListener('click', async () => {
    let id = (appidEl?.value || '').trim();
    // Fall back to extracting the AppID from the current URL — saves the
    // user from copying it manually when they're already on the store page.
    if (!/^\d{1,10}$/.test(id)) {
      try {
        const st = await window.dash?.steamGetState?.();
        const m = String(st?.url || '').match(/\/app\/(\d+)/);
        if (m) id = m[1];
      } catch {}
    }
    if (!/^\d{1,10}$/.test(id)) {
      if (statusEl) {
        statusEl.textContent = 'ENTER AN APPID (e.g. 440) OR OPEN A GAME’S STORE PAGE';
        statusEl.classList.remove('is-hidden');
        setTimeout(() => { statusEl.classList.add('is-hidden'); }, 2400);
      }
      return;
    }
    if (appidEl) appidEl.value = id;
    const r = await window.dash?.steamLaunch?.(id);
    if (statusEl) {
      statusEl.textContent = (r?.ok ? `LAUNCHING APPID ${id}… STEAM IS TAKING OVER` : `LAUNCH FAILED FOR APPID ${id}`);
      statusEl.classList.remove('is-hidden');
      setTimeout(() => { statusEl.classList.add('is-hidden'); }, 2400);
    }
  });

  fsBtn?.addEventListener('click', () => window.dash?.steamMinimizeDashboard?.());

  _activateImpl = async () => {
    pane?.classList.add('is-visible');
    _sendBounds();
    try { await window.dash?.steamShow?.(); } catch {}
    try {
      const st = await window.dash?.steamGetState?.();
      _paintNav(st);
    } catch {}
    // Hide the splash once the BV is mounted; first-paint may take a beat
    // on the very first activation, so keep the splash visible until
    // did-stop-loading lands via onSteamEvent.
    if (statusEl) statusEl.classList.toggle('is-hidden', !!_lastSent && !!_lastSent.width);
  };
  _deactivateImpl = () => {
    try { window.dash?.steamHide?.(); } catch {}
    pane?.classList.remove('is-visible');
  };
}

export function activate()   { _activateImpl?.(); }
export function deactivate() { _deactivateImpl?.(); }
