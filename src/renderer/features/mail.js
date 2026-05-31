// MAIL pane · read-only IMAP client (v1).
//
// Apple-Mail-style three-column layout: sidebar (mailboxes) · list
// (messages in the selected mailbox) · reader (inline sandboxed iframe
// for the selected message). Top toolbar holds refresh / compose
// (disabled, v2) / sign-out / search (disabled, v2). Config form sits
// as a full-pane overlay shown only when there are no creds.
//
// All IPC goes through window.mail.* (bridge in src/main/preload.js).
// The IMAP work lives entirely in main (src/main/mail-service.js);
// this module is just state + DOM + wiring, isolated so the whole
// feature can be debugged without crossing service boundaries.

let _ready = false;
let _deps  = null;
let _statusUnsub = null;

// DOM refs (resolved in init).
let paneEl;
let statusDot, statusText, tbHost;
let refreshBtn, composeBtn, signoutBtn, searchInput;
let sidebarEl, listColEl, listTitleEl, listSubEl, listEl;
let readerEmpty, readerHdr, readerSubject, readerFrom, readerDate, readerFrame;
let cfgOverlay, cfgHost, cfgPort, cfgUser, cfgPass, cfgError, cfgForm;
let mboxCountInbox;
let composeOverlay, composeForm, composeClose, composeCancel;
let composeTo, composeCc, composeSubject, composeBody, composeStatus, composeSend;
let contactsListEl, contactAddBtn, contactAddForm, contactAddName, contactAddEmail, contactAddCancel;
let googleBtn, googleOverlay, googleForm, googleClose, googleClientId, googleClientSecret, googleStatus, googleSave, googleDisconnect;
let _contacts = [];

// In-memory state.
let _lastInbox = null;
let _openUid   = null;       // currently selected message uid
let _activeMbox = 'INBOX';   // only INBOX wired in v1

function _setStatus(state, detail) {
  if (!statusDot) return;
  statusDot.dataset.state = state || 'idle';
  const labels = {
    idle:         'IDLE',
    connecting:   'CONNECTING…',
    connected:    'CONNECTED',
    disconnected: 'DISCONNECTED',
    error:        'ERROR',
  };
  statusText.textContent = labels[state] || (state || '').toUpperCase();
  statusText.title = (state === 'error' && detail) ? String(detail) : '';
}

function _showOverlay(on) {
  cfgOverlay.classList.toggle('is-visible', !!on);
}

function _showCompose(on, prefill) {
  composeOverlay.classList.toggle('is-visible', !!on);
  if (on) {
    composeStatus.textContent = '';
    composeStatus.classList.remove('is-error', 'is-ok');
    composeSend.disabled = false;
    if (prefill) {
      composeTo.value      = prefill.to      || '';
      composeCc.value      = prefill.cc      || '';
      composeSubject.value = prefill.subject || '';
      composeBody.value    = prefill.body    || '';
    } else {
      composeTo.value = composeCc.value = composeSubject.value = composeBody.value = '';
    }
    setTimeout(() => composeTo.focus(), 0);
  }
}

function _fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString([], {
      month: 'short', day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  } catch { return iso; }
}

function _escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _updateListHeader() {
  const total = _lastInbox?.total || 0;
  const unread = (_lastInbox?.messages || []).filter((m) => m.unread).length;
  listTitleEl.textContent = _activeMbox;
  if (!total) {
    listSubEl.textContent = '—';
  } else {
    listSubEl.textContent = unread
      ? `${total} MESSAGES · ${unread} UNREAD`
      : `${total} MESSAGES`;
  }
  // Mirror the unread count into the sidebar inbox badge + the
  // productivity-header tag so the user sees unread at a glance even
  // when on another combo tab.
  if (mboxCountInbox) mboxCountInbox.textContent = unread ? String(unread) : '';
  window._mailState = { unread, total };
  try { _deps?.paintComboHeader?.(); } catch {}
}

function _renderInbox(payload) {
  _lastInbox = payload;
  const messages = (payload && payload.messages) || [];
  _updateListHeader();
  if (!messages.length) {
    listEl.innerHTML = '<div class="mail-empty">INBOX EMPTY</div>';
    return;
  }
  const rows = messages.map((m) => `
    <button type="button" class="mail-row${m.unread ? ' is-unread' : ''}${m.uid === _openUid ? ' is-selected' : ''}" data-uid="${m.uid}">
      <span class="mail-row-from">${_escapeHtml(m.from)}</span>
      <span class="mail-row-date">${_escapeHtml(_fmtDate(m.date))}</span>
      <span class="mail-row-subj">${_escapeHtml(m.subject)}</span>
      <span class="mail-row-snip">${_escapeHtml(m.snippet)}</span>
    </button>
  `).join('');
  listEl.innerHTML = rows;
}

async function _refreshInbox() {
  _setStatus('connecting');
  const r = await window.mail.listInbox({ limit: 50 });
  if (!r.ok) {
    _setStatus('error', r.error);
    listEl.innerHTML = `<div class="mail-empty mail-empty-error">${_escapeHtml(r.error || 'listInbox failed')}</div>`;
    return;
  }
  _setStatus('connected');
  _renderInbox(r);
}

function _setReaderEmpty(text) {
  readerEmpty.textContent = text || 'SELECT A MESSAGE';
  readerEmpty.hidden = false;
  readerHdr.hidden = true;
  readerFrame.hidden = true;
}

function _setReaderLoaded(msg) {
  readerEmpty.hidden = true;
  readerHdr.hidden = false;
  readerFrame.hidden = false;
  readerSubject.textContent = msg.subject || '(no subject)';
  readerFrom.textContent = msg.from || '—';
  readerDate.textContent = _fmtDate(msg.date);
  // Wrap the (already-sanitized) body in a minimal dashboard stylesheet
  // so the email reads on dark. The iframe sandbox blocks scripts +
  // same-origin so this CSS can't be exfiltrated by message HTML.
  const styled = `
    <!doctype html><html><head><meta charset="utf-8"><style>
      :root { color-scheme: dark; }
      html, body { margin: 0; padding: 16px; background: #0c1014; color: #cfe6f7;
                   font: 13px/1.5 'Inter', 'Segoe UI', sans-serif; word-wrap: break-word; }
      a { color: #5ccfff; }
      img { max-width: 100%; height: auto; }
      pre, code { background: #070a0e; padding: 2px 4px; border: 1px solid rgba(92,207,255,0.22); white-space: pre-wrap; }
      blockquote { border-left: 2px solid rgba(92,207,255,0.4); margin: 0; padding: 0 12px; color: #6e8aa3; }
      table { max-width: 100%; }
    </style></head><body>${msg.html || _escapeHtml(msg.text)}</body></html>
  `;
  readerFrame.srcdoc = styled;
}

async function _openMessage(uid) {
  _openUid = uid;
  // Mark the row as selected immediately. We don't re-render the whole
  // list (would lose scroll position); just flip the .is-selected class.
  listEl.querySelectorAll('.mail-row.is-selected').forEach((el) => el.classList.remove('is-selected'));
  const row = listEl.querySelector(`.mail-row[data-uid="${uid}"]`);
  if (row) row.classList.add('is-selected');
  _setReaderEmpty('LOADING…');
  const r = await window.mail.getMessage(uid);
  if (!r.ok || !r.message) {
    _setReaderEmpty(r.error ? `ERROR: ${r.error}` : 'FAILED TO LOAD');
    return;
  }
  _setReaderLoaded(r.message);
  // Optimistically clear unread on this row + recompute the header
  // counts. Main has already marked the message \Seen on the server.
  if (row) row.classList.remove('is-unread');
  if (_lastInbox && _lastInbox.messages) {
    const m = _lastInbox.messages.find((x) => x.uid === uid);
    if (m) m.unread = false;
    _updateListHeader();
  }
}

async function _handleConfigSubmit(ev) {
  ev.preventDefault();
  cfgError.textContent = '';
  const creds = {
    host:   cfgHost.value.trim() || 'imap.gmail.com',
    port:   Number(cfgPort.value) || 993,
    secure: true,
    user:   cfgUser.value.trim(),
    pass:   cfgPass.value,
  };
  if (!creds.user || !creds.pass) {
    cfgError.textContent = 'EMAIL AND PASSWORD REQUIRED';
    return;
  }
  cfgError.textContent = 'SAVING…';
  const save = await window.mail.saveCreds(creds);
  if (!save.ok) { cfgError.textContent = save.error || 'SAVE FAILED'; return; }
  cfgError.textContent = 'CONNECTING…';
  const con = await window.mail.connect();
  if (!con.ok) { cfgError.textContent = con.error || 'CONNECT FAILED'; return; }
  cfgPass.value = '';
  tbHost.textContent = creds.user;
  _showOverlay(false);
  await _refreshInbox();
}

// ── Contacts ────────────────────────────────────────────────────────

function _renderContacts() {
  if (!contactsListEl) return;
  if (!_contacts.length) {
    contactsListEl.innerHTML = '<div class="mail-contacts-empty">NO CONTACTS</div>';
    return;
  }
  // Favorites first; within each group, sort alphabetically by name
  // (or email if name is missing).
  const sorted = _contacts.slice().sort((a, b) => {
    if (!!b.favorite - !!a.favorite) return b.favorite ? 1 : -1;
    const an = (a.name || a.email).toLowerCase();
    const bn = (b.name || b.email).toLowerCase();
    return an.localeCompare(bn);
  });
  contactsListEl.innerHTML = sorted.map((c) => `
    <div class="mail-contact${c.favorite ? ' is-favorite' : ''}" data-id="${c.id}" data-email="${_escapeHtml(c.email)}" data-name="${_escapeHtml(c.name || '')}">
      <button type="button" class="mail-contact-star" title="${c.favorite ? 'Unfavorite' : 'Favorite'}">${c.favorite ? '★' : '☆'}</button>
      <span class="mail-contact-name" title="${_escapeHtml(c.email)}">
        ${_escapeHtml(c.name || c.email)}
        ${c.name ? `<small>${_escapeHtml(c.email)}</small>` : ''}
      </span>
      <button type="button" class="mail-contact-compose" title="Compose to ${_escapeHtml(c.email)}">&#9998;</button>
      <button type="button" class="mail-contact-remove"  title="Remove">&times;</button>
    </div>
  `).join('');
}

async function _loadContacts() {
  const r = await window.mail.contacts.list();
  if (r && r.ok) {
    _contacts = r.contacts || [];
    _renderContacts();
  }
}

async function _handleContactRowClick(ev) {
  const row = ev.target.closest?.('.mail-contact');
  if (!row) return;
  const id    = row.dataset.id;
  const email = row.dataset.email;
  const name  = row.dataset.name;
  const c     = _contacts.find((x) => x.id === id);
  if (!c) return;
  if (ev.target.closest('.mail-contact-star')) {
    const r = await window.mail.contacts.update(id, { favorite: !c.favorite });
    if (r.ok && r.contact) {
      const idx = _contacts.findIndex((x) => x.id === id);
      if (idx >= 0) _contacts[idx] = r.contact;
      _renderContacts();
    }
    return;
  }
  if (ev.target.closest('.mail-contact-remove')) {
    const r = await window.mail.contacts.remove(id);
    if (r.ok) {
      _contacts = _contacts.filter((x) => x.id !== id);
      _renderContacts();
    }
    return;
  }
  // Default click (anywhere else on the row, incl. the compose icon)
  // opens the compose modal with To pre-filled to "Name <email>" when
  // we have a name, or bare email otherwise.
  const to = name ? `${name} <${email}>` : email;
  _showCompose(true, { to });
}

function _showAddForm(on) {
  contactAddForm.hidden = !on;
  if (on) {
    contactAddName.value = '';
    contactAddEmail.value = '';
    setTimeout(() => contactAddName.focus(), 0);
  }
}

async function _handleAddContact(ev) {
  ev.preventDefault();
  const name = contactAddName.value.trim();
  const email = contactAddEmail.value.trim();
  if (!email) return;
  const r = await window.mail.contacts.add({ name, email });
  if (!r.ok) return;
  // Add or replace in the local cache (add() coalesces dupes by email).
  const idx = _contacts.findIndex((c) => c.id === r.contact.id);
  if (idx >= 0) _contacts[idx] = r.contact;
  else          _contacts.push(r.contact);
  _renderContacts();
  _showAddForm(false);
}

// ── Google OAuth + Contacts import ─────────────────────────────────

function _showGoogleOverlay(on) {
  googleOverlay.classList.toggle('is-visible', !!on);
  if (on) {
    googleStatus.textContent = '';
    googleStatus.classList.remove('is-error', 'is-ok');
    googleSave.disabled = false;
  }
}

function _setGoogleStatus(text, kind) {
  googleStatus.classList.remove('is-error', 'is-ok');
  if (kind) googleStatus.classList.add(`is-${kind}`);
  googleStatus.textContent = text || '';
}

async function _refreshGoogleStatus() {
  const r = await window.mail.google.status();
  if (!r.ok) return null;
  // Reflect connected state on the G button so the user sees at a
  // glance whether Google is wired up.
  googleBtn.classList.toggle('is-connected', !!r.isAuthorized);
  googleBtn.title = r.isAuthorized
    ? 'Google connected — click to re-import'
    : (r.hasSetup ? 'Authorize Google to import contacts' : 'Set up Google to import contacts');
  // Mirror current setup into the form so the user can see what's saved.
  if (googleClientId && r.info && r.info.clientId) {
    googleClientId.value = r.info.clientId;
  }
  if (googleDisconnect) googleDisconnect.hidden = !r.isAuthorized;
  return r;
}

async function _runGoogleImport() {
  _setGoogleStatus('IMPORTING…');
  const r = await window.mail.google.importContacts();
  if (!r.ok) {
    _setGoogleStatus(r.error || 'IMPORT FAILED', 'error');
    return false;
  }
  _setGoogleStatus(`IMPORTED ${r.added} NEW · ${r.updated} UPDATED · ${r.total} TOTAL`, 'ok');
  if (r.contacts) {
    _contacts = r.contacts;
    _renderContacts();
  } else {
    await _loadContacts();
  }
  return true;
}

async function _handleGoogleButton() {
  const status = await _refreshGoogleStatus();
  if (!status) return;
  if (!status.hasSetup) {
    _showGoogleOverlay(true);
    return;
  }
  if (!status.isAuthorized) {
    // Already have client_id/secret; just run the OAuth flow.
    _showGoogleOverlay(true);
    _setGoogleStatus('OPENING BROWSER…');
    const auth = await window.mail.google.authorize();
    if (!auth.ok) {
      _setGoogleStatus(auth.error || 'AUTH FAILED', 'error');
      return;
    }
    await _refreshGoogleStatus();
    const ok = await _runGoogleImport();
    if (ok) setTimeout(() => _showGoogleOverlay(false), 1200);
    return;
  }
  // Connected → just refresh from Google.
  const ok = await _runGoogleImport();
  // No overlay needed for a routine refresh — show a brief status
  // chip in the toolbar by reusing the connection status text.
  if (ok) {
    statusText.title = `Last Google import: ${new Date().toLocaleTimeString()}`;
  }
}

async function _handleGoogleSave(ev) {
  ev.preventDefault();
  const clientId     = googleClientId.value.trim();
  const clientSecret = googleClientSecret.value.trim();
  if (!clientId || !clientSecret) {
    _setGoogleStatus('CLIENT ID + SECRET REQUIRED', 'error');
    return;
  }
  googleSave.disabled = true;
  _setGoogleStatus('SAVING…');
  const saved = await window.mail.google.setup({ clientId, clientSecret });
  if (!saved.ok) {
    _setGoogleStatus(saved.error || 'SAVE FAILED', 'error');
    googleSave.disabled = false;
    return;
  }
  // Clear the secret from the DOM as soon as it's been persisted
  // encrypted — no need to keep it in renderer memory.
  googleClientSecret.value = '';
  _setGoogleStatus('OPENING BROWSER…');
  const auth = await window.mail.google.authorize();
  if (!auth.ok) {
    _setGoogleStatus(auth.error || 'AUTH FAILED', 'error');
    googleSave.disabled = false;
    return;
  }
  await _refreshGoogleStatus();
  const ok = await _runGoogleImport();
  googleSave.disabled = false;
  if (ok) setTimeout(() => _showGoogleOverlay(false), 1200);
}

async function _handleGoogleDisconnect() {
  await window.mail.google.disconnect();
  await _refreshGoogleStatus();
  _setGoogleStatus('DISCONNECTED', 'ok');
}

async function _handleComposeSubmit(ev) {
  ev.preventDefault();
  const msg = {
    to:      composeTo.value.trim(),
    cc:      composeCc.value.trim() || undefined,
    subject: composeSubject.value.trim(),
    body:    composeBody.value,
  };
  if (!msg.to) {
    composeStatus.textContent = 'RECIPIENT REQUIRED';
    composeStatus.classList.add('is-error');
    composeStatus.classList.remove('is-ok');
    return;
  }
  composeSend.disabled = true;
  composeStatus.classList.remove('is-error', 'is-ok');
  composeStatus.textContent = 'SENDING…';
  const r = await window.mail.send(msg);
  if (!r.ok) {
    composeStatus.textContent = r.error || 'SEND FAILED';
    composeStatus.classList.add('is-error');
    composeSend.disabled = false;
    return;
  }
  composeStatus.textContent = 'SENT';
  composeStatus.classList.add('is-ok');
  setTimeout(() => _showCompose(false), 600);
}

async function _handleSignOut() {
  await window.mail.clearCreds();
  _lastInbox = null;
  _openUid = null;
  listEl.innerHTML = '';
  tbHost.textContent = '—';
  _setReaderEmpty('SELECT A MESSAGE');
  _setStatus('idle');
  _showOverlay(true);
}

export async function init(deps) {
  if (_ready) return;
  _deps = deps || {};
  paneEl = document.querySelector('.combo-pane-mail');
  if (!paneEl) return;

  statusDot   = document.getElementById('mail-status-dot');
  statusText  = document.getElementById('mail-status-text');
  tbHost      = document.getElementById('mail-tb-host');
  refreshBtn  = document.getElementById('mail-refresh-btn');
  composeBtn  = document.getElementById('mail-compose-btn');
  signoutBtn  = document.getElementById('mail-signout-btn');
  searchInput = document.getElementById('mail-search');

  sidebarEl     = paneEl.querySelector('.mail-sidebar');
  listColEl     = paneEl.querySelector('.mail-list-col');
  listTitleEl   = document.getElementById('mail-list-title');
  listSubEl     = document.getElementById('mail-list-sub');
  listEl        = document.getElementById('mail-list');
  mboxCountInbox= document.getElementById('mail-mbox-count-inbox');

  readerEmpty   = document.getElementById('mail-reader-empty');
  readerHdr     = document.getElementById('mail-reader-hdr');
  readerSubject = document.getElementById('mail-reader-subject');
  readerFrom    = document.getElementById('mail-reader-from');
  readerDate    = document.getElementById('mail-reader-date');
  readerFrame   = document.getElementById('mail-reader-frame');

  cfgOverlay    = document.getElementById('mail-config-overlay');
  cfgHost       = document.getElementById('mail-cfg-host');
  cfgPort       = document.getElementById('mail-cfg-port');
  cfgUser       = document.getElementById('mail-cfg-user');
  cfgPass       = document.getElementById('mail-cfg-pass');
  cfgError      = document.getElementById('mail-config-error');
  cfgForm       = document.getElementById('mail-config-form');

  contactsListEl  = document.getElementById('mail-contacts-list');
  contactAddBtn   = document.getElementById('mail-contact-add-btn');
  contactAddForm  = document.getElementById('mail-contact-add-form');
  contactAddName  = document.getElementById('mail-contact-add-name');
  contactAddEmail = document.getElementById('mail-contact-add-email');
  contactAddCancel= document.getElementById('mail-contact-add-cancel');

  googleBtn          = document.getElementById('mail-google-btn');
  googleOverlay      = document.getElementById('mail-google-overlay');
  googleForm         = document.getElementById('mail-google-form');
  googleClose        = document.getElementById('mail-google-close');
  googleClientId     = document.getElementById('mail-google-client-id');
  googleClientSecret = document.getElementById('mail-google-client-secret');
  googleStatus       = document.getElementById('mail-google-status');
  googleSave         = googleForm.querySelector('.mail-google-save');
  googleDisconnect   = document.getElementById('mail-google-disconnect');

  composeOverlay = document.getElementById('mail-compose-overlay');
  composeForm    = document.getElementById('mail-compose-form');
  composeClose   = document.getElementById('mail-compose-close');
  composeCancel  = document.getElementById('mail-compose-cancel');
  composeTo      = document.getElementById('mail-compose-to');
  composeCc      = document.getElementById('mail-compose-cc');
  composeSubject = document.getElementById('mail-compose-subject');
  composeBody    = document.getElementById('mail-compose-body');
  composeStatus  = document.getElementById('mail-compose-status');
  composeSend    = composeForm.querySelector('.mail-compose-send');

  // Toolbar wiring. COMPOSE is now live; the disabled attribute on
  // the markup is removed at runtime once init runs so users on a
  // stale build don't see a permanently dead button.
  refreshBtn.addEventListener('click', _refreshInbox);
  signoutBtn.addEventListener('click', _handleSignOut);
  composeBtn.disabled = false;
  composeBtn.title = 'Compose new message';
  composeBtn.addEventListener('click', () => _showCompose(true));
  // Config submit.
  cfgForm.addEventListener('submit', _handleConfigSubmit);
  // Compose modal.
  composeForm.addEventListener('submit', _handleComposeSubmit);
  composeClose.addEventListener('click', () => _showCompose(false));
  composeCancel.addEventListener('click', () => _showCompose(false));
  // Contacts.
  contactsListEl.addEventListener('click', _handleContactRowClick);
  contactAddBtn.addEventListener('click', () => _showAddForm(contactAddForm.hidden));
  contactAddCancel.addEventListener('click', () => _showAddForm(false));
  contactAddForm.addEventListener('submit', _handleAddContact);
  // Google contacts import.
  googleBtn.addEventListener('click', _handleGoogleButton);
  googleClose.addEventListener('click', () => _showGoogleOverlay(false));
  googleForm.addEventListener('submit', _handleGoogleSave);
  googleDisconnect.addEventListener('click', _handleGoogleDisconnect);
  // Message row click (event delegation; list re-renders re-create rows).
  listEl.addEventListener('click', (ev) => {
    const row = ev.target.closest?.('.mail-row');
    if (!row) return;
    const uid = Number(row.dataset.uid);
    if (Number.isFinite(uid)) _openMessage(uid);
  });
  // Sidebar mailbox switching. Only INBOX is wired in v1; the others
  // are visually present (.is-disabled) so the layout looks complete
  // but their buttons are disabled at the markup level.
  sidebarEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('.mail-mbox');
    if (!btn || btn.disabled) return;
    const mbox = btn.dataset.mbox || 'INBOX';
    if (mbox === _activeMbox) return;
    sidebarEl.querySelectorAll('.mail-mbox.is-active').forEach((el) => el.classList.remove('is-active'));
    btn.classList.add('is-active');
    _activeMbox = mbox;
    _updateListHeader();
    // Future: re-fetch using mailService.listMailbox(mbox).
  });

  // Server pushes — status state transitions outside our UI loop.
  _statusUnsub = window.mail.onStatus((s) => {
    _setStatus(s.state, s.detail && (typeof s.detail === 'object' ? null : String(s.detail)));
  });

  _ready = true;
}

export async function activate() {
  if (!_ready) return;
  const h = await window.mail.hasCreds();
  if (h.ok && h.hasCreds) {
    _showOverlay(false);
    const c = await window.mail.getCreds();
    if (c.ok && c.creds) tbHost.textContent = c.creds.user || '—';
    if (!_lastInbox) await _refreshInbox();
    await _loadContacts();
    // Reflect Google status (sets button title + green tint if
    // authorized); doesn't block the inbox render.
    _refreshGoogleStatus().catch(() => {});
  } else {
    _showOverlay(true);
  }
}

export function deactivate() {
  // Keep the IMAP socket alive across combo-tab switches. Renderer
  // state (last list + open uid) is preserved so the user comes back
  // to exactly where they left off.
}
