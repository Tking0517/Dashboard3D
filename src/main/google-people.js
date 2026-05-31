// Google People API wrapper — fetches the user's Contacts (the same
// list visible at contacts.google.com). One narrow surface: list, with
// pagination handled internally so the caller gets a flat array.
//
// Auth is delegated to google-oauth.js; we just supply the URL and
// parse the response. Scope required:
//   https://www.googleapis.com/auth/contacts.readonly

const googleOauth = require('./google-oauth');

const SCOPE      = 'https://www.googleapis.com/auth/contacts.readonly';
const API_HOST   = 'people.googleapis.com';
const PAGE_SIZE  = 1000;

// Returns: [{ name, email, primary }, ...]
// Flattened: one record per <person × email>. People API stores
// multiple emails per person; collapsing onto our flat contacts shape
// here keeps the downstream merge logic dead simple.
async function listContacts() {
  const fields = 'names,emailAddresses';
  let pageToken = '';
  let out = [];
  // Cap pages at 50 so a misconfigured tenant can't lock us into an
  // infinite loop. 50 × 1000 = 50k contacts, well past typical reality.
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({
      personFields: fields,
      pageSize:     String(PAGE_SIZE),
      sortOrder:    'FIRST_NAME_ASCENDING',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await googleOauth.apiGet(API_HOST, '/v1/people/me/connections?' + params.toString());
    for (const p of (data.connections || [])) {
      const emails = (p.emailAddresses || []).filter((e) => e.value);
      if (!emails.length) continue;
      const name = (p.names && p.names[0] && (p.names[0].displayName || p.names[0].unstructuredName)) || '';
      for (const e of emails) {
        out.push({ name, email: e.value, primary: !!(e.metadata && e.metadata.primary) });
      }
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

module.exports = { listContacts, SCOPE };
