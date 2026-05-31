// Mail service — IMAP read-only client (v1).
//
// Owns a single long-lived IMAP connection to the user's mail host
// (Gmail by default). Renderer talks to it via the mail:* IPC channels.
// Credentials persist in <userdata>/mail.json, encrypted at rest via
// Electron's safeStorage (OS keychain on macOS, DPAPI on Windows,
// libsecret on Linux). Plaintext password never touches disk.
//
// Lazy: no IMAP connection happens at app boot. The renderer calls
// mail:connect on first MAIL-tab open; we keep that one socket open via
// IMAP NOOP keepalive until the app quits or the user signs out.
//
// Scope (v1): list inbox, fetch a single message body + headers +
// inline attachments list. No send/compose, no other folders, no
// search — those are deliberate follow-ups so this module stays small
// and easy to debug.

const { safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');
const nodemailer = require('nodemailer');

let _client = null;          // ImapFlow instance (singleton)
let _connecting = null;      // in-flight connect promise (dedup)
let _credsPath = null;       // resolved on init()
let _hostPreset = null;      // { host, port, secure } cached after connect
let _onStatus = null;        // optional status callback to renderer

function init({ dataDir, onStatus }) {
  _credsPath = path.join(dataDir, 'mail.json');
  _onStatus = typeof onStatus === 'function' ? onStatus : null;
}

function _emitStatus(state, detail) {
  if (_onStatus) try { _onStatus({ state, detail: detail || null }); } catch {}
}

// ── Credential storage ──────────────────────────────────────────────
// mail.json shape: { host, port, secure, user, passEnc (base64) }.
// pass is never written plaintext; safeStorage handles the OS-bound
// encryption. If the OS keychain is unavailable (Linux without
// libsecret) safeStorage.isEncryptionAvailable() returns false — we
// surface a clear error rather than silently falling back to
// plaintext storage.

function _readCredsFile() {
  if (!_credsPath || !fs.existsSync(_credsPath)) return null;
  try { return JSON.parse(fs.readFileSync(_credsPath, 'utf8')); }
  catch { return null; }
}

function _writeCredsFile(obj) {
  fs.writeFileSync(_credsPath, JSON.stringify(obj, null, 2), 'utf8');
}

function hasCreds() {
  const c = _readCredsFile();
  return !!(c && c.user && c.passEnc);
}

function getCredsInfo() {
  const c = _readCredsFile();
  if (!c) return null;
  // Password never returned — only the public-ish fields the UI needs
  // to render the "currently signed in as" line.
  return { host: c.host, port: c.port, secure: c.secure, user: c.user };
}

function saveCreds({ host, port, secure, user, pass }) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential store unavailable; cannot save password securely');
  }
  if (!host || !user || !pass) throw new Error('host / user / pass required');
  const enc = safeStorage.encryptString(String(pass));
  _writeCredsFile({
    host: String(host),
    port: Number(port) || 993,
    secure: secure !== false,
    user: String(user),
    passEnc: enc.toString('base64'),
  });
  return getCredsInfo();
}

function clearCreds() {
  if (_credsPath && fs.existsSync(_credsPath)) {
    try { fs.unlinkSync(_credsPath); } catch {}
  }
}

function _loadDecryptedCreds() {
  const c = _readCredsFile();
  if (!c) return null;
  const pass = safeStorage.decryptString(Buffer.from(c.passEnc, 'base64'));
  return { host: c.host, port: c.port, secure: c.secure, user: c.user, pass };
}

// ── Connection ──────────────────────────────────────────────────────

// ── Stale-connection safeguard ─────────────────────────────────────
// ImapFlow keeps `client.usable` true even when the underlying socket
// has been half-closed by the server (Gmail idle disconnects ~30 min).
// A subsequent FETCH writes bytes the server will never answer, so the
// call hangs forever. We race every IMAP op against a watchdog: on
// timeout we hard-drop the client so the next call reconnects.

function _withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label + ' (timed out after ' + ms + 'ms)')), ms); }),
  ]).finally(() => clearTimeout(t));
}

function _dropStaleClient() {
  const c = _client;
  _client = null;
  if (c) {
    try { c.close(); } catch {}
  }
  _emitStatus('disconnected');
}

async function _openClient() {
  const creds = _loadDecryptedCreds();
  if (!creds) throw new Error('no credentials saved');
  _hostPreset = { host: creds.host, port: creds.port, secure: creds.secure };
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,        // silence imapflow's own pino logger
    emitLogs: false,
  });
  // Surface connection drops to the renderer so the UI can mark the
  // session as stale without us re-spinning a doomed connection.
  client.on('error', (err) => {
    _emitStatus('error', String(err && err.message || err));
  });
  client.on('close', () => {
    if (_client === client) _client = null;
    _emitStatus('disconnected');
  });
  await client.connect();
  return client;
}

async function connect() {
  if (_client && _client.usable) return { ok: true };
  if (_connecting) return _connecting;
  _emitStatus('connecting');
  _connecting = _openClient()
    .then((c) => {
      _client = c;
      _emitStatus('connected', _hostPreset);
      return { ok: true };
    })
    .catch((err) => {
      _emitStatus('error', String(err.message || err));
      throw err;
    })
    .finally(() => { _connecting = null; });
  return _connecting;
}

async function disconnect() {
  const c = _client;
  _client = null;
  if (c) {
    try { await c.logout(); } catch {}
  }
  _emitStatus('disconnected');
}

// ── Reading ────────────────────────────────────────────────────────
// listInbox({ limit }) — newest first, snippet-only payload.
// getMessage(uid)     — full sanitized body for the viewer.
//
// IMAP UIDs are stable within a mailbox, so we use them as the
// renderer-facing message ID. They're sufficient for v1 (single
// mailbox = INBOX). When we add other folders we'll prefix with
// the folder path.

async function _listInboxOnce({ limit }) {
  if (!_client || !_client.usable) await connect();
  const lock = await _client.getMailboxLock('INBOX');
  try {
    const status = _client.mailbox;
    const total = status.exists || 0;
    if (!total) return { total: 0, messages: [] };
    // Fetch the last `limit` UIDs by sequence range. IMAP sequence
    // numbers count from 1; sliding the window backwards from the end
    // gives newest-first with one round-trip.
    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;
    const out = [];
    // Drain the fetch iterator under a single watchdog so a stalled
    // connection times out as a unit rather than hanging on one row.
    await _withTimeout((async () => {
      for await (const msg of _client.fetch(range, {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        bodyStructure: false,
        // bodyParts is heavier — we only want a snippet, so we ask for
        // the first ~256 bytes of the text/plain part.
        bodyParts: ['TEXT'],
      })) {
        const env = msg.envelope || {};
        const from = (env.from && env.from[0]) ? (env.from[0].name || env.from[0].address) : '—';
        const subject = env.subject || '(no subject)';
        const dt = env.date || msg.internalDate || null;
        const unread = !msg.flags || !msg.flags.has || !msg.flags.has('\\Seen');
        let snippet = '';
        // bodyParts → Map<partKey, Buffer>; the TEXT key holds the
        // first text body part. We slice + strip newlines so the row
        // stays a single line.
        if (msg.bodyParts && msg.bodyParts.get) {
          const buf = msg.bodyParts.get('TEXT');
          if (buf) snippet = buf.toString('utf8', 0, Math.min(buf.length, 256))
            .replace(/[\r\n\t]+/g, ' ')
            .trim();
        }
        out.push({
          uid: msg.uid,
          from,
          fromAddress: env.from && env.from[0] && env.from[0].address || null,
          subject,
          date: dt ? new Date(dt).toISOString() : null,
          unread,
          snippet: snippet.slice(0, 240),
        });
      }
    })(), 15000, 'IMAP list timed out');
    // IMAP returns oldest-first within the range; flip to newest-first.
    out.reverse();
    return { total, messages: out };
  } finally {
    lock.release();
  }
}

// Public listInbox — runs _listInboxOnce; on any IMAP error (including
// the watchdog timeout) drops the stale client and retries once.
async function listInbox(opts = {}) {
  const o = { limit: opts.limit || 40 };
  try {
    return await _listInboxOnce(o);
  } catch (err) {
    _dropStaleClient();
    return await _listInboxOnce(o);
  }
}

// ── Attachments ────────────────────────────────────────────────────
// HTML email sanitization. Strip <script>, on* event attributes, and
// remote-image refs. We keep cid: references intact and rewrite them
// to data: URLs after parse so embedded inline images render without
// hitting the network (no tracking pixels, no privacy leaks).

function _rewriteCidImages(html, attachments) {
  if (!html || !attachments || !attachments.length) return html;
  const cidMap = new Map();
  for (const a of attachments) {
    if (a.cid && a.content) {
      const b64 = Buffer.isBuffer(a.content) ? a.content.toString('base64') : '';
      if (b64) cidMap.set(a.cid, `data:${a.contentType || 'application/octet-stream'};base64,${b64}`);
    }
  }
  return html.replace(/(["'])cid:([^"']+)\1/g, (m, q, cid) => {
    const data = cidMap.get(cid);
    return data ? `${q}${data}${q}` : m;
  });
}

const _SANITIZE_OPTS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'style', 'span', 'font',
  ]),
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'border', 'colspan', 'rowspan', 'bgcolor'],
    a: ['href', 'name', 'target', 'title', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'srcset'],
    table: ['cellpadding', 'cellspacing', 'border', 'width', 'align', 'bgcolor'],
    td: ['width', 'height', 'align', 'valign', 'colspan', 'rowspan', 'bgcolor'],
  },
  // Allow data: URLs (inline images, post-cid rewrite) + https.
  // Remote http:// images are blocked — same privacy stance most mail
  // clients take ("Display external images" toggle).
  allowedSchemes: ['https', 'data', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['data'] },
  transformTags: {
    // Force all links to open in a new window via the renderer's
    // external-link handler. The renderer iframe is sandboxed —
    // `target=_blank` will be rewritten by the renderer to
    // shell.openExternal so links don't navigate the viewer away.
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

async function _getMessageOnce(uid) {
  console.log('[mail] getMessage start uid=' + uid);
  if (!_client || !_client.usable) await connect();
  const lock = await _client.getMailboxLock('INBOX');
  try {
    // Fetch + parse + sanitize all under one 15 s watchdog. Any step
    // hanging on a half-dead Gmail socket will surface a clean error
    // for the user to see (and trigger the outer retry) instead of
    // a perpetual "LOADING…".
    const result = await _withTimeout((async () => {
      console.log('[mail] fetchOne uid=' + uid);
      const msg = await _client.fetchOne(
        String(uid),
        { source: true, envelope: true, flags: true },
        { uid: true }
      );
      console.log('[mail] fetchOne done, source bytes=' + (msg && msg.source ? msg.source.length : 0));
      if (!msg || !msg.source) throw new Error('message not found');
      const parsed = await simpleParser(msg.source);
      console.log('[mail] simpleParser done');
      const htmlSrc = parsed.html || (parsed.textAsHtml || (parsed.text ? `<pre>${parsed.text}</pre>` : ''));
      const withCid = _rewriteCidImages(htmlSrc, parsed.attachments || []);
      const safeHtml = sanitizeHtml(withCid, _SANITIZE_OPTS);
      console.log('[mail] sanitize done, html bytes=' + safeHtml.length);
      return { msg, parsed, safeHtml };
    })(), 15000, 'IMAP getMessage timed out');
    // Mark as read fire-and-forget — never await it, so a stalled
    // \Seen command can't block the response the user is waiting on.
    Promise.resolve()
      .then(() => _client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }))
      .catch((err) => console.warn('[mail] mark-as-read failed:', err.message));
    const { msg, parsed, safeHtml } = result;
    return {
      uid: msg.uid,
      subject: parsed.subject || '(no subject)',
      from: parsed.from && parsed.from.text || '',
      to: parsed.to && parsed.to.text || '',
      cc: parsed.cc && parsed.cc.text || '',
      date: parsed.date ? parsed.date.toISOString() : null,
      html: safeHtml,
      text: parsed.text || '',
      attachments: (parsed.attachments || [])
        .filter((a) => !a.cid)            // cid-attachments already inlined
        .map((a) => ({
          filename: a.filename || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || (a.content && a.content.length) || 0,
        })),
    };
  } finally {
    lock.release();
  }
}

// Public getMessage — same retry-once pattern as listInbox. The first
// call after the dashboard's been idle a while is the most likely to
// hit a half-dead socket; a forced reconnect on the retry leg fixes
// it without the user ever seeing a stuck "LOADING…" state.
async function getMessage(uid) {
  try {
    return await _getMessageOnce(uid);
  } catch (err) {
    _dropStaleClient();
    return await _getMessageOnce(uid);
  }
}

// ── Sending ────────────────────────────────────────────────────────
// Plain-text SMTP send via nodemailer, reusing the same App Password
// the IMAP side decrypted from safeStorage. Host/port are derived from
// the saved IMAP host (imap.gmail.com → smtp.gmail.com / 465, etc.).
// Connection isn't pooled — SMTP transactions are short-lived; we open
// the TLS socket, send, and close. Auth failures surface via the
// nodemailer Error which our IPC wrap stringifies for the UI.

function _smtpFromImap(imapHost) {
  // Most providers mirror the imap.* / smtp.* convention. Outlook is
  // the notable exception (imap-mail.outlook.com / smtp-mail.outlook.com)
  // and the substitution still works for it. If you add another
  // provider whose SMTP host doesn't follow this pattern, branch here.
  return String(imapHost || '').replace(/^imap/i, 'smtp');
}

async function sendMessage(msg) {
  const creds = _loadDecryptedCreds();
  if (!creds) throw new Error('not signed in');
  if (!msg || !msg.to)      throw new Error('recipient (to) required');
  if (!msg.subject && !msg.body) throw new Error('subject or body required');
  const transporter = nodemailer.createTransport({
    host: _smtpFromImap(creds.host),
    port: 465,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
  });
  try {
    const info = await transporter.sendMail({
      from: creds.user,
      to: String(msg.to),
      cc: msg.cc ? String(msg.cc) : undefined,
      bcc: msg.bcc ? String(msg.bcc) : undefined,
      subject: String(msg.subject || ''),
      // Plain-text body in v1. We pass it as `text` so nodemailer
      // sets the right Content-Type; no HTML render path on send yet.
      text: String(msg.body || ''),
    });
    return { messageId: info.messageId };
  } finally {
    try { transporter.close(); } catch {}
  }
}

module.exports = {
  init,
  hasCreds,
  getCredsInfo,
  saveCreds,
  clearCreds,
  connect,
  disconnect,
  listInbox,
  getMessage,
  sendMessage,
};
