// Sequence detection + extension helpers — shared by EDIT bin,
// EXPLORE panes, and the REC ROOM (visualizer) capture list.
//
// A "sequence" is a run of files whose names share the same prefix
// and extension and differ only in a trailing zero-padded number —
// the natural shape of snap-capture output (`screencap-001.jpg`,
// `screencap-002.jpg`, …). Grouping them lets the UI surface one
// row per sequence with a `× N` indicator instead of flooding the
// list with hundreds of near-identical entries.

// "foo-001.jpg" → ["foo", "-", "001", "jpg"]
// "name_42.png" → ["name", "_", "42",  "png"]
const SEQ_RE = /^(.*?)([_\-.\s])(\d+)\.([a-z0-9]+)$/i;

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toUpperCase() : '';
}

// Returns a stable key for grouping, or null if the name has no
// trailing number suffix worth grouping by. We require ≥2 digits so
// `clip2.mp4` isn't dragged into a fake sequence with `clip3.mp4`.
export function seqKeyOf(name) {
  const m = SEQ_RE.exec(name || '');
  if (!m) return null;
  if (m[3].length < 2) return null;
  return `${m[1]}${m[2]}#.${m[4]}`;
}

// Only entries whose path/rel sits inside a screencap session dir
// (`…/screencap/session-<stamp>/<file>`) are eligible for grouping.
// Anything else — gallery imports, recordings, downloads — keeps its
// individual row even if it happens to end in a number. Without this
// guard `clip-01.mp4` next to `clip-02.mp4` would collapse just from
// sharing a numeric suffix, which is the wrong default everywhere
// outside the snap-capture flow.
const SESSION_PATH_RE = /(?:^|[\\/])screencap[\\/]session-[^\\/]+[\\/]/;

// Coalesce same-key entries (from a snap-capture session) into a single
// representative entry with:
//   isSeq: true
//   seqCount: total members
//   seqPaths: full paths sorted by name
//   seqMembers: full entry list sorted by name
// `key(entry) -> string` extracts the filename (defaults to entry.name).
// Original list order is preserved at the position of each sequence's
// FIRST occurrence; lone files and non-session entries pass through.
export function groupSequences(entries, opts = {}) {
  const getName = opts.key || ((e) => e.name);
  const buckets = new Map();
  const slots = [];
  for (const e of entries) {
    const probe = (e.path || e.rel || '');
    const inSession = SESSION_PATH_RE.test(probe);
    const k = inSession ? seqKeyOf(getName(e)) : null;
    if (!k) { slots.push({ kind: 'plain', e }); continue; }
    let bucket = buckets.get(k);
    if (!bucket) {
      bucket = { kind: 'bucket', members: [] };
      buckets.set(k, bucket);
      slots.push(bucket);
    }
    bucket.members.push(e);
  }
  return slots.map((slot) => {
    if (slot.kind === 'plain') return slot.e;
    const sorted = slot.members.slice().sort((a, b) => getName(a).localeCompare(getName(b)));
    if (sorted.length === 1) return sorted[0];
    return {
      ...sorted[0],
      isSeq: true,
      seqCount: sorted.length,
      seqPaths: sorted.map((e) => e.path).filter(Boolean),
      seqMembers: sorted,
    };
  });
}
