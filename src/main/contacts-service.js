// Contacts service — flat JSON store for the MAIL room's contacts
// sidebar. Plain file (mail-contacts.json) under the portable userdata
// dir. Not encrypted: addresses + display names are not secrets, and
// the user can hand-edit the file if needed.
//
// Shape: { version: 1, contacts: [{ id, name, email, favorite }] }
//
//   id        — short random string (collision-cheap given <1000 contacts)
//   name      — display name; can be empty (we'll fall back to email)
//   email     — required, lowercased+trimmed on save (the join key)
//   favorite  — boolean; sort order keeps favorites at the top
//
// Update operations are read-modify-write whole-file. Cheap at our
// scale; if contacts get large we'd swap to a real KV store, but for
// hundreds of entries the simplest path is the right one.

const path = require('path');
const fs = require('fs');

let _file = null;

function init({ dataDir }) {
  _file = path.join(dataDir, 'mail-contacts.json');
}

function _load() {
  if (!_file) throw new Error('contacts service not initialised');
  if (!fs.existsSync(_file)) return { version: 1, contacts: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(_file, 'utf8'));
    if (!raw || !Array.isArray(raw.contacts)) return { version: 1, contacts: [] };
    return { version: raw.version || 1, contacts: raw.contacts };
  } catch {
    return { version: 1, contacts: [] };
  }
}

function _save(state) {
  fs.writeFileSync(_file, JSON.stringify(state, null, 2), 'utf8');
}

function _id() {
  // 8-char base36 — uniqueness is sufficient at our scale.
  return Math.random().toString(36).slice(2, 10);
}

function _normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function list() {
  return _load().contacts.slice();
}

function add({ name, email }) {
  const e = _normEmail(email);
  if (!e || !/.+@.+\..+/.test(e)) throw new Error('invalid email');
  const state = _load();
  // Email is the join key; collapse duplicate adds onto the same row
  // so the user can't accidentally fork a contact by re-entering it.
  const existing = state.contacts.find((c) => _normEmail(c.email) === e);
  if (existing) {
    if (name && !existing.name) existing.name = String(name).trim();
    _save(state);
    return existing;
  }
  const created = {
    id: _id(),
    name: name ? String(name).trim() : '',
    email: e,
    favorite: false,
  };
  state.contacts.push(created);
  _save(state);
  return created;
}

function update(id, patch) {
  const state = _load();
  const c = state.contacts.find((x) => x.id === id);
  if (!c) throw new Error('contact not found');
  if (patch && typeof patch === 'object') {
    if ('name'     in patch) c.name     = String(patch.name || '').trim();
    if ('email'    in patch) c.email    = _normEmail(patch.email);
    if ('favorite' in patch) c.favorite = !!patch.favorite;
  }
  _save(state);
  return c;
}

// bulkMerge — batch import from an external source (e.g. Google
// Contacts). For each incoming { name, email }: if the email already
// exists locally, fill in a missing name (don't overwrite a user-set
// one). Otherwise add a new contact. Favorite state on existing rows
// is preserved. One file write at the end.
function bulkMerge(incoming) {
  if (!Array.isArray(incoming)) return { added: 0, updated: 0, total: 0 };
  const state = _load();
  // Index by lowercase email so the lookup is O(1) per item.
  const idx = new Map();
  for (const c of state.contacts) idx.set(_normEmail(c.email), c);
  let added = 0, updated = 0;
  for (const inc of incoming) {
    const e = _normEmail(inc && inc.email);
    if (!e || !/.+@.+\..+/.test(e)) continue;
    const existing = idx.get(e);
    if (existing) {
      if (inc.name && !existing.name) {
        existing.name = String(inc.name).trim();
        updated++;
      }
    } else {
      const created = {
        id: _id(),
        name: inc.name ? String(inc.name).trim() : '',
        email: e,
        favorite: false,
      };
      state.contacts.push(created);
      idx.set(e, created);
      added++;
    }
  }
  _save(state);
  return { added, updated, total: incoming.length };
}

function remove(id) {
  const state = _load();
  const before = state.contacts.length;
  state.contacts = state.contacts.filter((x) => x.id !== id);
  if (state.contacts.length === before) throw new Error('contact not found');
  _save(state);
  return { removed: id };
}

module.exports = { init, list, add, update, remove, bulkMerge };
