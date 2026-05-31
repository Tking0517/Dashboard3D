// Google OAuth2 — installed-app loopback flow.
//
// Generic helper that any Google API surface in the dashboard can lean
// on (Contacts today, Calendar / Drive / Tasks later). The flow:
//
//   1. Renderer hands over a Client ID + Client Secret (from a project
//      the user created in console.cloud.google.com → APIs &
//      Services → Credentials → Desktop app).
//   2. authorize({ scopes }) opens an ephemeral HTTP server on a
//      random localhost port and points the system browser at
//      accounts.google.com/o/oauth2/v2/auth with that port as
//      redirect_uri. After the user consents, Google redirects back
//      to localhost with ?code=…; we exchange it for an
//      access_token + refresh_token, store both encrypted via
//      safeStorage, and tear the server down.
//   3. getAccessToken() refreshes transparently when the cached
//      token is within 30 s of expiry.
//
// All persistent state lives in <userdata>/google-oauth.json. Client
// secret + tokens are encrypted at rest; client ID is plaintext (it's
// not a secret). The file is local-only — never sent anywhere except
// to google's own oauth endpoints.

const { safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let _file = null;

function init({ dataDir }) {
  _file = path.join(dataDir, 'google-oauth.json');
}

function _loadFile() {
  if (!_file || !fs.existsSync(_file)) return null;
  try { return JSON.parse(fs.readFileSync(_file, 'utf8')); }
  catch { return null; }
}

function _saveFile(obj) {
  fs.writeFileSync(_file, JSON.stringify(obj, null, 2), 'utf8');
}

function _enc(s) {
  return safeStorage.encryptString(String(s)).toString('base64');
}

function _dec(b64) {
  return safeStorage.decryptString(Buffer.from(b64, 'base64'));
}

function _requireSafeStorage() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential store unavailable; cannot persist OAuth tokens securely');
  }
}

// ── Setup (client_id + client_secret) ──────────────────────────────

function hasSetup() {
  const f = _loadFile();
  return !!(f && f.clientId && f.clientSecretEnc);
}

function isAuthorized() {
  const f = _loadFile();
  return !!(f && f.refreshTokenEnc);
}

function getSetupInfo() {
  const f = _loadFile();
  if (!f) return null;
  return {
    clientId:        f.clientId || null,
    hasSecret:       !!f.clientSecretEnc,
    hasRefreshToken: !!f.refreshTokenEnc,
    scopes:          Array.isArray(f.scopes) ? f.scopes : [],
  };
}

function setup({ clientId, clientSecret }) {
  _requireSafeStorage();
  const id  = String(clientId || '').trim();
  const sec = String(clientSecret || '').trim();
  if (!id || !sec) throw new Error('clientId and clientSecret required');
  const cur = _loadFile() || {};
  _saveFile({ ...cur, clientId: id, clientSecretEnc: _enc(sec) });
  return getSetupInfo();
}

function clearSetup() {
  if (_file && fs.existsSync(_file)) {
    try { fs.unlinkSync(_file); } catch {}
  }
}

function disconnect() {
  // Drop tokens but keep the client_id/secret so re-authorize doesn't
  // require re-pasting them.
  const f = _loadFile();
  if (!f) return;
  delete f.refreshTokenEnc;
  delete f.accessTokenEnc;
  delete f.expiresAt;
  delete f.scopes;
  _saveFile(f);
}

function _getClient() {
  const f = _loadFile();
  if (!f || !f.clientId || !f.clientSecretEnc) {
    throw new Error('Google OAuth not set up — paste Client ID + Secret first');
  }
  return {
    clientId:     f.clientId,
    clientSecret: _dec(f.clientSecretEnc),
    state:        f,
  };
}

// ── HTTPS helpers ──────────────────────────────────────────────────

function _httpsPost(host, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', host, path: urlPath,
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...(headers || {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Google ${urlPath} HTTP ${res.statusCode}: ${buf.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Google response parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function _httpsGet(host, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET', host, path: urlPath, headers: headers || {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Google ${urlPath} HTTP ${res.statusCode}: ${buf.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Google response parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Loopback authorize flow ────────────────────────────────────────

async function authorize({ scopes }) {
  const { clientId, clientSecret } = _getClient();
  const scopeStr = (scopes || []).join(' ');
  if (!scopeStr) throw new Error('authorize: scopes required');

  // Bind to an ephemeral localhost port; Google's installed-app flow
  // permits http://127.0.0.1:<any-port>/ as a redirect_uri.
  const server = http.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/`;
  const csrfState = crypto.randomBytes(16).toString('hex');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         scopeStr);
  // access_type=offline + prompt=consent guarantees Google returns a
  // refresh_token. Without prompt=consent, a returning user only gets
  // an access_token (no refresh_token) and we'd be stuck re-authing
  // every hour.
  authUrl.searchParams.set('access_type',   'offline');
  authUrl.searchParams.set('prompt',        'consent');
  authUrl.searchParams.set('state',         csrfState);

  // Hand off to system browser. The user's normal Google session
  // there means most don't have to re-enter credentials.
  shell.openExternal(authUrl.toString());

  // Wait for Google to redirect back to localhost. 5-minute timeout
  // covers the consent screen flow with some slack.
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { server.close(); } catch {}
      reject(new Error('OAuth timed out — close the browser tab and try again'));
    }, 5 * 60 * 1000);
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      const cb = {
        code:  url.searchParams.get('code'),
        error: url.searchParams.get('error'),
        state: url.searchParams.get('state'),
      };
      // Always respond with a self-closing page so the browser tab is
      // tidy whether or not the auth succeeded.
      const ok = !cb.error && cb.code && cb.state === csrfState;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8">
        <title>Dashboard3D · Google Auth</title>
        <body style="font-family:system-ui,sans-serif;background:#0c1014;color:#cfe6f7;padding:40px;text-align:center">
          <h1 style="font-weight:300;letter-spacing:.2em">${ok ? 'AUTHORIZED' : 'AUTH FAILED'}</h1>
          <p>${ok ? 'You can close this window and return to Dashboard3D.' : (cb.error || 'Unknown error')}</p>
        </body>`);
      clearTimeout(timer);
      // Defer close so the browser actually receives the response body.
      setTimeout(() => { try { server.close(); } catch {} }, 250);
      if (cb.error)              return reject(new Error('Google: ' + cb.error));
      if (!cb.code)              return reject(new Error('Google: no code in callback'));
      if (cb.state !== csrfState) return reject(new Error('Google: state mismatch (possible CSRF)'));
      resolve(cb.code);
    });
  });

  // Exchange code for tokens.
  const body = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  }).toString();
  const tokens = await _httpsPost('oauth2.googleapis.com', '/token', body);
  if (!tokens.refresh_token) {
    // Some flows (especially re-auth without prompt=consent) skip
    // refresh_token. We forced prompt=consent, so this shouldn't
    // happen — but bail clearly if it does, so the caller doesn't
    // store a half-baked credential.
    throw new Error('Google did not return a refresh_token; try Disconnect → Authorize again');
  }
  const f = _loadFile() || {};
  f.refreshTokenEnc = _enc(tokens.refresh_token);
  f.accessTokenEnc  = _enc(tokens.access_token);
  // 30 s skew gives us a margin before refresh.
  f.expiresAt = Date.now() + ((tokens.expires_in || 3600) - 30) * 1000;
  f.scopes    = (scopes || []).slice();
  _saveFile(f);
  return { ok: true };
}

async function _refreshAccessToken() {
  const { clientId, clientSecret, state: f } = _getClient();
  if (!f.refreshTokenEnc) throw new Error('not authorized — run authorize() first');
  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: _dec(f.refreshTokenEnc),
    grant_type:    'refresh_token',
  }).toString();
  const tokens = await _httpsPost('oauth2.googleapis.com', '/token', body);
  f.accessTokenEnc = _enc(tokens.access_token);
  f.expiresAt      = Date.now() + ((tokens.expires_in || 3600) - 30) * 1000;
  // Refresh responses *sometimes* rotate the refresh_token; persist if so.
  if (tokens.refresh_token) f.refreshTokenEnc = _enc(tokens.refresh_token);
  _saveFile(f);
  return tokens.access_token;
}

async function getAccessToken() {
  const f = _loadFile();
  if (!f || !f.refreshTokenEnc) throw new Error('not authorized — run authorize() first');
  if (f.accessTokenEnc && f.expiresAt && f.expiresAt > Date.now()) {
    return _dec(f.accessTokenEnc);
  }
  return _refreshAccessToken();
}

// ── Authenticated request helper for downstream API modules. ───────
// Adds the Bearer header so callers don't have to know about tokens.

async function apiGet(host, urlPath) {
  const token = await getAccessToken();
  return _httpsGet(host, urlPath, { Authorization: `Bearer ${token}` });
}

module.exports = {
  init,
  hasSetup, isAuthorized, getSetupInfo,
  setup, clearSetup, disconnect,
  authorize, getAccessToken, apiGet,
};
