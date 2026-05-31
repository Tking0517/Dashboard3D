// REC ROOM · context menu, delete batch, undo stack, keyboard shortcuts
//
// Owns:
//   - The right-click menu (COPY / DELETE)
//   - The DELETE button handler (with a session-scoped undo stack)
//   - The UNDO button handler (restores most recent batch)
//   - Keyboard shortcuts (Delete, Ctrl+C) scoped to the REC ROOM pane
//
// Selection / current-playing state lives in visualizer.js (it's
// touched all over that file). This module gets accessors (deps) so
// it can read and mutate that state without holding stale references.
//
// The undo stack is shared with EXPLORE via window._visualizerUndoStack
// (seeded by app.js at boot) so deletes done before REC ROOM is opened
// still land here.

export function setupContextMenu({
  visualizerListEl,
  visualizerVideoEl,
  visualizerWrapEl,
  visualizerNowEl,
  visualizerPane,
  getSelected,
  setSelected,
  setAnchor,
  getCurrent,
  clearCurrent,
  repaintSelection,
  clearSelection,
  refreshVisualizer,
} = {}) {
  // ── Right-click menu ─────────────────────────────────────────────
  let _ctxMenu = null;
  function _hideCtxMenu() {
    _ctxMenu?.remove();
    _ctxMenu = null;
  }
  async function _copySelection() {
    const paths = [...(getSelected?.() || [])];
    if (!paths.length) return;
    try {
      const r = await window.dash?.clipboardCopyFiles?.(paths);
      if (!r?.ok) console.warn('[rec-room] copy failed:', r?.error);
    } catch (err) { console.warn('[rec-room] copy threw:', err); }
  }
  async function _deleteSelection() {
    const sel = getSelected?.() || new Set();
    const current = getCurrent?.();
    const targets = sel.size ? [...sel] : (current ? [current] : []);
    if (!targets.length) return;
    if (current && targets.includes(current)) {
      try { visualizerVideoEl?.pause(); } catch {}
      try { visualizerVideoEl?.removeAttribute('src'); visualizerVideoEl?.load(); } catch {}
      clearCurrent?.();
      visualizerWrapEl?.classList.remove('is-playing', 'is-still');
      if (visualizerNowEl) visualizerNowEl.textContent = '—';
    }
    for (const abs of targets) {
      try {
        const r = await window.dash?.exploreDelete?.(abs);
        if (!r?.ok) console.warn('[rec-room] delete failed:', abs, r?.error);
      } catch {}
    }
    clearSelection?.();
    await refreshVisualizer?.();
  }
  function _showCtxMenu(x, y) {
    _hideCtxMenu();
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
    _ctxMenu = menu;
    menu.addEventListener('click', (ev) => {
      const a = ev.target?.dataset?.action;
      if (a === 'copy')   _copySelection();
      if (a === 'delete') _deleteSelection();
      _hideCtxMenu();
    });
    menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }

  visualizerListEl?.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.visualizer-row');
    if (!row) return;
    if (row.dataset.action === 'up' || row.dataset.isDir === 'true') return;
    ev.preventDefault();
    const p = row.dataset.path;
    const sel = getSelected?.() || new Set();
    if (!sel.has(p)) {
      setSelected?.(new Set([p]));
      setAnchor?.(p);
      repaintSelection?.();
    }
    _showCtxMenu(ev.clientX, ev.clientY);
  });
  document.addEventListener('mousedown', (ev) => {
    if (_ctxMenu && !_ctxMenu.contains(ev.target)) _hideCtxMenu();
  }, true);

  // ── Keyboard shortcuts (Delete, Ctrl+C) ──────────────────────────
  // Only fire when REC ROOM is the visible pane AND either the list
  // owns focus or there's an active selection — that's the clear
  // signal the user is acting on this pane, not EXPLORE or a textbox.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _ctxMenu) _hideCtxMenu();
    const focusInList = document.activeElement === visualizerListEl
      || visualizerListEl?.contains(document.activeElement);
    const recRoomVisible = visualizerPane?.classList?.contains('is-visible');
    if (!recRoomVisible) return;
    const sel = getSelected?.() || new Set();
    if (!focusInList && !sel.size) return;
    if (ev.target.matches?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    if (ev.key === 'Delete') {
      ev.preventDefault();
      _deleteSelection();
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C')) {
      ev.preventDefault();
      _copySelection();
    }
  });

  // ── Delete button (with undo stack) ──────────────────────────────
  // Session-scoped undo: each entry remembers the managed-trash path
  // + original path so one click restores the most recent batch. The
  // file remains in <root>/.trash after Empty Trash → OS Recycle Bin.
  const _undoStack = (window._visualizerUndoStack = window._visualizerUndoStack || []);
  function _refreshUndoBtn() {
    const btn = document.getElementById('visualizer-undo-btn');
    if (!btn) return;
    btn.disabled = _undoStack.length === 0;
    btn.textContent = _undoStack.length > 1 ? `UNDO (${_undoStack.length})` : 'UNDO';
  }
  window._visualizerRefreshUndoBtn = _refreshUndoBtn;

  document.getElementById('visualizer-delete-btn')?.addEventListener('click', async () => {
    const sel = getSelected?.() || new Set();
    const current = getCurrent?.();
    const targets = sel.size ? [...sel] : (current ? [current] : []);
    if (!targets.length) return;
    if (current && targets.includes(current)) {
      try { visualizerVideoEl?.pause(); } catch {}
      try { visualizerVideoEl?.removeAttribute('src'); visualizerVideoEl?.load(); } catch {}
      clearCurrent?.();
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
      _undoStack.push({ batch, at: Date.now() });
      _refreshUndoBtn();
      if (visualizerNowEl) visualizerNowEl.textContent = `DELETED ${batch.length} · UNDO READY`;
    }
    clearSelection?.();
    await refreshVisualizer?.();
  });

  document.getElementById('visualizer-undo-btn')?.addEventListener('click', async () => {
    const entry = _undoStack.pop();
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
    await refreshVisualizer?.();
  });
  _refreshUndoBtn();
}
