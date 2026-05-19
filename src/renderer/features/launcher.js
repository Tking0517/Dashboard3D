// APP LAUNCHER + POWER MENU — appliance feature module.
//
// Topbar #launcher-btn opens a grid of pinned programs (click to launch,
// ADD APP to pin one via a native file dialog). The pinned list persists
// in config under cfg.launcherApps.
//
// Topbar #power-btn opens the power menu — power off / restart go through
// main's system-power handler; sleep reuses the existing system-sleep one.
// Both are built for the appliance build where the dashboard is the shell
// and there is no Start menu / taskbar to do this.
//
// initLauncher() is called once from app.js with the renderer helpers it
// needs — keeps the module free of app.js globals.
export function initLauncher({ playSfx } = {}) {
  initAppLauncher({ playSfx });
  initPowerMenu({ playSfx });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function initAppLauncher({ playSfx }) {
  const overlay = document.querySelector('#launcher-overlay');
  const openBtn = document.querySelector('#launcher-btn');
  if (!overlay || !openBtn || !window.dash?.launcherRun) return;
  const gridEl   = overlay.querySelector('#launcher-grid');
  const emptyEl  = overlay.querySelector('#launcher-empty');
  const statusEl = overlay.querySelector('#launcher-status');
  const closeBtn = overlay.querySelector('#launcher-close-btn');
  const addBtn   = overlay.querySelector('#launcher-add-btn');

  let apps = [];   // [{ id, name, exec, args }]
  let busy = false;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.dataset.kind = kind || '';
  }

  async function loadApps() {
    try {
      const cfg = await window.dash.getConfig();
      apps = Array.isArray(cfg?.launcherApps) ? cfg.launcherApps : [];
    } catch {
      apps = [];
    }
  }
  async function saveApps() {
    try { await window.dash.setConfig({ launcherApps: apps }); }
    catch (err) { setStatus(err.message || 'could not save', 'err'); }
  }

  function render() {
    gridEl.innerHTML = '';
    emptyEl.hidden = apps.length > 0;
    for (const app of apps) {
      const tile = document.createElement('button');
      tile.className = 'lx-tile';
      tile.type = 'button';
      const letter = (app.name || '?').trim().charAt(0).toUpperCase() || '?';
      tile.innerHTML =
        `<span class="lx-tile-del" title="Remove">×</span>` +
        `<span class="lx-tile-icon">${escapeHtml(letter)}</span>` +
        `<span class="lx-tile-name">${escapeHtml(app.name || app.exec)}</span>`;
      tile.title = app.exec;
      tile.querySelector('.lx-tile-del').addEventListener('click', (e) => {
        e.stopPropagation();
        removeApp(app.id);
      });
      tile.addEventListener('click', () => launch(app));
      gridEl.appendChild(tile);
    }
  }

  async function launch(app) {
    if (busy) return;
    busy = true;
    setStatus(`Launching ${app.name}…`);
    playSfx?.('click');
    try {
      const r = await window.dash.launcherRun({ exec: app.exec, args: app.args });
      if (r?.ok) { setStatus(`Launched ${app.name}.`, 'ok'); }
      else { setStatus(r?.error || 'launch failed', 'err'); playSfx?.('error'); }
    } catch (err) {
      setStatus(err.message || 'launch error', 'err');
      playSfx?.('error');
    } finally {
      busy = false;
    }
  }

  async function removeApp(id) {
    apps = apps.filter((a) => a.id !== id);
    render();
    await saveApps();
    setStatus('Removed.');
  }

  async function addApp() {
    if (busy) return;
    busy = true;
    playSfx?.('click');
    try {
      const r = await window.dash.launcherPick();
      if (r?.cancelled) { setStatus(''); return; }
      if (!r?.ok) { setStatus(r?.error || 'could not pick a program', 'err'); return; }
      const name = window.prompt('Name for this app:', r.name || r.path) || r.name || r.path;
      apps.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: String(name).trim().slice(0, 40),
        exec: r.path,
        args: [],
      });
      render();
      await saveApps();
      setStatus(`Pinned ${name}.`, 'ok');
    } catch (err) {
      setStatus(err.message || 'add error', 'err');
    } finally {
      busy = false;
    }
  }

  async function open() {
    overlay.hidden = false;
    playSfx?.('click');
    setStatus('');
    await loadApps();
    render();
  }
  function close() {
    overlay.hidden = true;
    playSfx?.('click');
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  addBtn.addEventListener('click', addApp);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
}

function initPowerMenu({ playSfx }) {
  const overlay = document.querySelector('#power-overlay');
  const openBtn = document.querySelector('#power-btn');
  if (!overlay || !openBtn) return;
  const statusEl  = overlay.querySelector('#power-status');
  const closeBtn  = overlay.querySelector('#power-close-btn');
  const offBtn    = overlay.querySelector('#power-off-btn');
  const restartBtn= overlay.querySelector('#power-restart-btn');
  const sleepBtn  = overlay.querySelector('#power-sleep-btn');

  let busy = false;
  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.dataset.kind = kind || '';
  }

  function open() {
    overlay.hidden = false;
    playSfx?.('click');
    setStatus('');
  }
  function close() {
    overlay.hidden = true;
    playSfx?.('click');
  }

  // action: 'poweroff' | 'reboot' | 'sleep'. Main shows the native
  // confirm dialog; here we only surface the outcome.
  async function runPower(action) {
    if (busy) return;
    busy = true;
    playSfx?.('click');
    setStatus('Awaiting confirmation…');
    try {
      const r = action === 'sleep'
        ? await window.dash.systemSleep()
        : await window.dash.systemPower(action);
      if (r?.cancelled) { setStatus('Cancelled.'); return; }
      if (!r?.ok) { setStatus(r?.error || 'failed', 'err'); playSfx?.('error'); return; }
      setStatus(action === 'sleep' ? 'Sleeping…' : 'Goodbye…', 'ok');
    } catch (err) {
      setStatus(err.message || 'error', 'err');
      playSfx?.('error');
    } finally {
      busy = false;
    }
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  offBtn.addEventListener('click', () => runPower('poweroff'));
  restartBtn.addEventListener('click', () => runPower('reboot'));
  sleepBtn.addEventListener('click', () => runPower('sleep'));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
}
