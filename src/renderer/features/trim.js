// SYSTEM TRIM (service sweep) — renderer feature module.
// Topbar #trim-btn opens a modal listing running, non-essential Windows
// services. Selected ones get stopped + set to Manual startup (one UAC
// prompt, handled in main). RESTORE LAST reverts every trimmed service
// to its prior startup type. Protected services are filtered out in main.
//
// initTrim() is called once from app.js with the renderer helpers this
// feature needs — keeps the module free of app.js globals.
export function initTrim({ playSfx } = {}) {
  const overlay  = document.querySelector('#trim-overlay');
  const openBtn  = document.querySelector('#trim-btn');
  if (!overlay || !openBtn || !window.dash?.servicesScan) return;
  const listEl    = overlay.querySelector('#trim-list');
  const emptyEl   = overlay.querySelector('#trim-empty');
  const countEl   = overlay.querySelector('#trim-count');
  const statusEl  = overlay.querySelector('#trim-status');
  const closeBtn  = overlay.querySelector('#trim-close-btn');
  const rescanBtn = overlay.querySelector('#trim-rescan-btn');
  const selTpBtn  = overlay.querySelector('#trim-sel-thirdparty');
  const selNonBtn = overlay.querySelector('#trim-sel-none');
  const applyBtn  = overlay.querySelector('#trim-apply-btn');
  const restoreBtn= overlay.querySelector('#trim-restore-btn');

  let candidates = [];   // [{ name, displayName, state, startMode, pid, category }]
  let busy = false;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.dataset.kind = kind || '';
  }
  function updateCount() {
    const checks = listEl.querySelectorAll('input[type=checkbox]');
    let sel = 0;
    checks.forEach((c) => { if (c.checked) sel++; });
    countEl.textContent = `${sel} / ${candidates.length} selected`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!candidates.length) {
      emptyEl.hidden = false;
      updateCount();
      return;
    }
    emptyEl.hidden = true;
    const order = { thirdparty: 0, windows: 1 };
    const sorted = candidates.slice().sort((a, b) => {
      const d = (order[a.category] ?? 9) - (order[b.category] ?? 9);
      if (d) return d;
      return a.displayName.localeCompare(b.displayName);
    });
    for (const svc of sorted) {
      const row = document.createElement('label');
      row.className = 'trim-row';
      const tp = svc.category === 'thirdparty';
      row.innerHTML =
        `<input type="checkbox" class="trim-check"${tp ? ' checked' : ''}>` +
        `<span class="trim-row-name">${escapeHtml(svc.displayName)}</span>` +
        `<span class="trim-row-id">${escapeHtml(svc.name)}</span>` +
        `<span class="trim-row-tag trim-tag-${tp ? 'tp' : 'win'}">${tp ? '3RD-PARTY' : 'WINDOWS'}</span>`;
      row.querySelector('input').dataset.name = svc.name;
      row.querySelector('input').addEventListener('change', updateCount);
      listEl.appendChild(row);
    }
    updateCount();
  }

  async function scan() {
    if (busy) return;
    busy = true;
    setStatus('Scanning services…');
    listEl.innerHTML = '';
    emptyEl.hidden = true;
    try {
      const r = await window.dash.servicesScan();
      if (!r?.ok) { setStatus(r?.error || 'scan failed', 'err'); candidates = []; renderList(); return; }
      // Only running, non-protected services are worth stopping.
      candidates = (r.services || []).filter(
        (s) => s.category !== 'protected' && s.state === 'Running',
      );
      restoreBtn.hidden = !r.hasBackup;
      renderList();
      setStatus(r.hasBackup ? 'A previous trim can be restored.' : '');
    } catch (err) {
      setStatus(err.message || 'scan error', 'err');
    } finally {
      busy = false;
    }
  }

  function open() {
    overlay.hidden = false;
    playSfx?.('click');
    scan();
  }
  function close() {
    overlay.hidden = true;
    playSfx?.('click');
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
  rescanBtn.addEventListener('click', scan);
  selTpBtn.addEventListener('click', () => {
    listEl.querySelectorAll('.trim-row').forEach((row) => {
      const c = row.querySelector('input');
      c.checked = row.querySelector('.trim-tag-tp') != null;
    });
    updateCount();
  });
  selNonBtn.addEventListener('click', () => {
    listEl.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; });
    updateCount();
  });

  applyBtn.addEventListener('click', async () => {
    if (busy) return;
    const names = [];
    listEl.querySelectorAll('input[type=checkbox]').forEach((c) => {
      if (c.checked && c.dataset.name) names.push(c.dataset.name);
    });
    if (!names.length) { setStatus('Select at least one service.', 'err'); return; }
    if (!window.confirm(
      `Stop ${names.length} service(s) and set them to Manual startup?\n\n` +
      `They won't auto-start at next boot. You can undo this with RESTORE LAST.`,
    )) return;
    busy = true;
    setStatus('Awaiting elevation… (approve the UAC prompt)');
    playSfx?.('click');
    try {
      const r = await window.dash.servicesTrim(names);
      if (r?.cancelled) { setStatus('Cancelled — UAC declined.'); return; }
      if (!r?.ok) { setStatus(r?.error || 'trim failed', 'err'); playSfx?.('error'); return; }
      const results = Array.isArray(r.results) ? r.results : [r.results].filter(Boolean);
      const done = results.filter((x) => x && x.ok).length;
      const failed = results.length - done;
      setStatus(`Stopped ${done} service(s)${failed ? `, ${failed} failed` : ''}.`, failed ? 'err' : 'ok');
      playSfx?.(failed ? 'error' : 'click');
    } catch (err) {
      setStatus(err.message || 'trim error', 'err');
      playSfx?.('error');
    } finally {
      busy = false;
      scan();
    }
  });

  restoreBtn.addEventListener('click', async () => {
    if (busy) return;
    if (!window.confirm('Restore every previously trimmed service to its original startup type and start it again?')) return;
    busy = true;
    setStatus('Awaiting elevation… (approve the UAC prompt)');
    playSfx?.('click');
    try {
      const r = await window.dash.servicesRestore();
      if (r?.cancelled) { setStatus('Cancelled — UAC declined.'); return; }
      if (!r?.ok) { setStatus(r?.error || 'restore failed', 'err'); playSfx?.('error'); return; }
      const results = Array.isArray(r.results) ? r.results : [r.results].filter(Boolean);
      const done = results.filter((x) => x && x.ok).length;
      const failed = results.length - done;
      setStatus(`Restored ${done} service(s)${failed ? `, ${failed} failed` : ''}.`, failed ? 'err' : 'ok');
      playSfx?.(failed ? 'error' : 'click');
    } catch (err) {
      setStatus(err.message || 'restore error', 'err');
      playSfx?.('error');
    } finally {
      busy = false;
      scan();
    }
  });
}
