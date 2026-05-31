// APP LAUNCHER — appliance feature module.
//
// Topbar #launcher-btn opens a grid of pinned programs (click to launch,
// ADD APP to pin one via a native file dialog). The pinned list persists
// in config under cfg.launcherApps. Built for the appliance build where
// the dashboard is the shell and there is no Start menu / taskbar.
//
// (Power menu — #power-btn + #power-overlay — was removed; users power
// the box off via OS-native means.)
//
// initLauncher() is called once from app.js with the renderer helpers it
// needs — keeps the module free of app.js globals.
export function initLauncher({ playSfx } = {}) {
  initAppLauncher({ playSfx });
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

