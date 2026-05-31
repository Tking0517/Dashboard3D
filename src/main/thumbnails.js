// Thumbnail cache for the EXPLORE gallery view.
//
// Generates compact JPEG previews for files Chromium can't decode
// natively in an <img>: video files (mp4 / mkv / mov / avi / webm /
// hevc) and exotic image formats (tiff / tif / psd / heic / heif /
// raw + bayer variants). Native-renderable images (png, jpg, etc.)
// are NOT routed through here — the renderer keeps using dash3d-file://
// for those because round-tripping a 50K PNG through ffmpeg would only
// waste cycles.
//
// Cache key = sha1(absPath + '|' + mtimeMs). A new mtime invalidates
// the entry automatically; old entries linger but cost ~10KB each so
// no GC is needed for personal-scale gallery sizes.
//
// Surface:
//   init({ ffmpegBin, cacheDir }) — call once at app boot
//   needsThumb(name)              — true if file format is non-native
//   getThumb(absPath)             — Promise<string|null> path to JPEG

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

let _ffmpegBin = null;
let _cacheDir = null;

// Image extensions that we generate thumbs for (Chromium can't render).
const _IMG_THUMB_RE = /\.(tiff?|psd|heic|heif|raw|cr2|nef|arw|dng|orf|rw2|raf)$/i;
// Video extensions we extract a frame from. HEVC / HEIC video share
// codec lineage; ffmpeg-static handles both via its built-in decoders.
const _VID_THUMB_RE = /\.(mp4|mkv|mov|avi|webm|m4v|flv|wmv|3gp|3g2|asf|hevc|h264|h265|mts|m2ts|ts|ogv|ogg)$/i;

function needsThumb(name) {
  return _IMG_THUMB_RE.test(name) || _VID_THUMB_RE.test(name);
}

function init({ ffmpegBin, cacheDir }) {
  _ffmpegBin = ffmpegBin || null;
  _cacheDir = cacheDir || null;
  if (_cacheDir) {
    try { fs.mkdirSync(_cacheDir, { recursive: true }); } catch {}
  }
}

// Cache lookups in flight, keyed by abs path. Multiple renderer
// requests for the same file collapse into one ffmpeg call.
const _inFlight = new Map();

function _cacheKeyFor(abs, mtimeMs) {
  const h = crypto.createHash('sha1');
  h.update(abs);
  h.update('|');
  h.update(String(mtimeMs | 0));
  return h.digest('hex');
}

function _runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!_ffmpegBin) return reject(new Error('ffmpeg unavailable'));
    execFile(_ffmpegBin, args, {
      windowsHide: true,
      // Stderr from ffmpeg is verbose but harmless; cap so a runaway
      // log can't OOM the main process.
      maxBuffer: 8 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').slice(-512);
        return reject(err);
      }
      resolve();
    });
  });
}

// Extract a single representative frame at ~10% into the file (with
// a 1s floor for short clips). -ss before -i seeks via the container
// index, which is several orders of magnitude faster than decoding
// from the start. -vf scale=240:-1 keeps aspect; -q:v 4 is a good
// quality/size tradeoff for thumbnails (lower number = higher quality).
async function _genVideoThumb(srcAbs, dstAbs) {
  // Probe duration so we can land in a usable spot. Many video files
  // start with a black title card, so seeking to 10% reliably hits
  // actual content. If probe fails (no container metadata, growing
  // file, etc.), fall back to 1s.
  let seekSec = 1;
  try {
    const probe = await new Promise((resolve) => {
      execFile(_ffmpegBin, ['-hide_banner', '-i', srcAbs], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }, (_err, _stdout, stderr) => resolve(String(stderr || '')));
    });
    const m = probe.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) {
      const dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      if (Number.isFinite(dur) && dur > 0) {
        seekSec = Math.max(1, Math.min(dur - 0.2, dur * 0.1));
      }
    }
  } catch {}
  await _runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(seekSec.toFixed(2)),
    '-i', srcAbs,
    '-frames:v', '1',
    '-vf', 'scale=240:-1:flags=lanczos',
    '-q:v', '4',
    '-y',
    dstAbs,
  ]);
}

// Single-frame image conversion. ffmpeg reads TIFF / PSD (composite
// layer) / HEIC / many camera RAWs out of the box; the resize stage
// matches the video path so thumbs are visually consistent.
async function _genImageThumb(srcAbs, dstAbs) {
  await _runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-i', srcAbs,
    '-frames:v', '1',
    '-vf', 'scale=240:-1:flags=lanczos',
    '-q:v', '4',
    '-y',
    dstAbs,
  ]);
}

async function getThumb(absPath) {
  if (!_ffmpegBin || !_cacheDir) return null;
  if (!absPath || typeof absPath !== 'string') return null;
  let stat;
  try { stat = fs.statSync(absPath); } catch { return null; }
  if (!stat.isFile()) return null;
  const name = path.basename(absPath);
  if (!needsThumb(name)) return null;
  const key = _cacheKeyFor(absPath, stat.mtimeMs);
  const dst = path.join(_cacheDir, `${key}.jpg`);
  // Hot path — cached. statSync is faster than reopening ffmpeg every
  // time the user scrolls the gallery.
  try {
    const ds = fs.statSync(dst);
    if (ds.size > 0) return dst;
  } catch {}
  // Coalesce concurrent requests for the same file (multiple thumb
  // rows visible after a refresh would otherwise spawn N ffmpegs).
  if (_inFlight.has(absPath)) return _inFlight.get(absPath);
  const p = (async () => {
    try {
      if (_VID_THUMB_RE.test(name)) await _genVideoThumb(absPath, dst);
      else                          await _genImageThumb(absPath, dst);
      return dst;
    } catch (err) {
      console.warn('[thumb] gen failed:', absPath, err?.message || err, err?.stderr || '');
      // Drop the partial file so the next request retries cleanly.
      try { fs.unlinkSync(dst); } catch {}
      return null;
    } finally {
      _inFlight.delete(absPath);
    }
  })();
  _inFlight.set(absPath, p);
  return p;
}

module.exports = { init, getThumb, needsThumb };
