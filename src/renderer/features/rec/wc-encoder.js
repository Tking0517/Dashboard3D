// PHASE A — WebCodecs hardware H.264 encoder for screen recording.
//
// WHY THIS EXISTS
// The legacy capture pump (visualizer.js sendFrame) ships RAW RGBA to
// ffmpeg: per frame it does drawImage(VideoFrame → 2D canvas) +
// getImageData() (a GPU→CPU readback + a full W*H*4 copy) and then
// hands those bytes over IPC. At 1080p30 that's ~250 MB/s through two
// CPU copies + the IPC boundary, which is what drops frames when the
// source app is busy. ffmpeg then ALSO has to encode (NVENC/x264).
//
// This module replaces all of that with a WebCodecs VideoEncoder: the
// VideoFrame is handed straight to the GPU encoder (prefer-hardware →
// NVENC/QSV/AMF), which emits finished H.264 (annex-b) chunks. We ship
// those already-compressed bytes to ffmpeg, which does `-c:v copy` —
// zero video work in ffmpeg, no readback, no raw-RGBA IPC.
//
// SCOPE / SAFETY
// Strictly opt-in. visualizer.js only builds this when the experiment
// flag is set AND isConfigSupported() returns a hardware config; on any
// failure the caller falls back to the proven raw-RGBA path untouched.
// We deliberately mirror the legacy path's contract: caller feeds us
// the SAME constant-rate clones the emitter already produces (so CFR /
// audio-sync behaviour is unchanged) and is responsible for closing the
// frames it passes — we never take ownership.

// Candidate codec strings, widest-compatibility first within each tier.
// We need a level high enough for the resolution; 5.2 covers up to 4K.
// isConfigSupported() picks the first the platform accepts with the
// requested hardware acceleration.
const _CODEC_CANDIDATES = [
  'avc1.640034', // High    L5.2 — up to 4K
  'avc1.4D4034', // Main    L5.2
  'avc1.640028', // High    L4.0 — up to 1080p
  'avc1.42E028', // Baseline L4.0
];

// Probe whether a usable hardware (or any) AVC config exists for these
// dimensions. Returns the chosen VideoEncoderConfig or null. Never
// throws — a thrown/absent VideoEncoder just yields null so the caller
// keeps the legacy path.
export async function pickEncoderConfig({ width, height, fps, bitrate }) {
  if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) {
    return null;
  }
  // Try hardware first, then fall back to allowing software — but only
  // hardware is worth switching paths for; a software WebCodecs encoder
  // is not clearly better than ffmpeg x264, so we return null and let
  // the caller keep ffmpeg if no hardware config is available.
  for (const accel of ['prefer-hardware']) {
    for (const codec of _CODEC_CANDIDATES) {
      const cfg = {
        codec,
        width, height,
        bitrate: Math.max(500_000, bitrate | 0),
        framerate: fps,
        hardwareAcceleration: accel,
        latencyMode: 'realtime',
        // annex-b so ffmpeg's `-f h264` elementary-stream demuxer parses
        // it directly; the mp4 muxer re-wraps to length-prefixed on copy.
        avc: { format: 'annexb' },
      };
      try {
        const support = await VideoEncoder.isConfigSupported(cfg);
        if (support && support.supported) return support.config || cfg;
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

// Build a live encoder. `onChunk(uint8)` receives each encoded H.264
// access unit's bytes (annex-b) in order; `onError(err)` fires on a
// fatal encoder error (caller should stop the recording / fall back on
// the NEXT recording, not mid-stream). Returns:
//   { encode(frame, force), flush(), close(), get count() }
// encode() is fire-and-forget; flush() resolves once the encoder has
// drained all queued frames (call before closing the ffmpeg pipe so the
// trailing GOP isn't lost).
export function createEncoder({ config, fps, onChunk, onError }) {
  let count = 0;
  let closed = false;
  // Force a keyframe every 2 s — matches the legacy ffmpeg path's
  // `-g fps*2`. Keeps the MP4 seekable in 2 s granularity. The very
  // first frame is always a keyframe (carries SPS/PPS in annex-b).
  const gop = Math.max(1, Math.round(fps * 2));
  let sinceKey = gop; // force a keyframe on the first encode

  const encoder = new VideoEncoder({
    output: (chunk) => {
      try {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        onChunk?.(buf);
        count++;
      } catch (err) {
        onError?.(err);
      }
    },
    error: (err) => { onError?.(err); },
  });
  encoder.configure(config);

  return {
    encode(frame, force = false) {
      if (closed) return;
      const keyFrame = force || sinceKey >= gop;
      if (keyFrame) sinceKey = 0; else sinceKey++;
      try {
        encoder.encode(frame, { keyFrame });
      } catch (err) {
        onError?.(err);
      }
    },
    async flush() {
      if (closed) return;
      try { await encoder.flush(); } catch (err) { onError?.(err); }
    },
    close() {
      if (closed) return;
      closed = true;
      try { encoder.close(); } catch {}
    },
    get count() { return count; },
  };
}
