// Shared FFT + frequency-band engine. Both audio loopback workers
// (Windows: audify-worker.js, Linux: audify-worker-linux.js) consume
// raw interleaved PCM from their respective capture backends and feed
// it through this engine to produce the same `{rms, bands}` shape the
// renderer expects.
//
// Usage:
//   const eng = createFftEngine({ sampleRate: 48000, channels: 2 });
//   eng.feed(samplesFloat32, channels);    // accumulate into ring
//   const ready = eng.tick();              // returns { rms, bands? }
//                                          // bands present every Nth tick
//
// Keep this file dependency-free — no Electron, no Node-only APIs.
// Makes it trivially testable from a bare-Node REPL.

const FFT_SIZE = 1024;
const NUM_BANDS = 24;
// Default FFT-per-tick divisor. Workers override via createFftEngine
// options if their chunk size doesn't match. Windows worker uses 2048
// samples per tick @ 48 kHz → ~23 Hz natively → fftEvery: 1. Linux worker
// still chunks at 512 → ~94 Hz callbacks → fftEvery: 4 → ~23 Hz output.
const FFT_EVERY_DEFAULT = 1;

function makeHann(n) {
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return h;
}

// In-place radix-2 Cooley-Tukey FFT.
function fft(real, imag) {
  const N = real.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < N; i += size) {
      for (let k = 0; k < half; k++) {
        const ang = step * k;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        const tr = real[i + k + half] * wr - imag[i + k + half] * wi;
        const ti = real[i + k + half] * wi + imag[i + k + half] * wr;
        real[i + k + half] = real[i + k] - tr;
        imag[i + k + half] = imag[i + k] - ti;
        real[i + k] += tr;
        imag[i + k] += ti;
      }
    }
  }
}

function makeBandBins(sampleRate) {
  const lo = new Int32Array(NUM_BANDS);
  const hi = new Int32Array(NUM_BANDS);
  const fMin = 60;
  const fMax = Math.min(16000, sampleRate / 2);
  for (let b = 0; b < NUM_BANDS; b++) {
    const fLo = fMin * Math.pow(fMax / fMin, b / NUM_BANDS);
    const fHi = fMin * Math.pow(fMax / fMin, (b + 1) / NUM_BANDS);
    lo[b] = Math.max(1, Math.floor((fLo * FFT_SIZE) / sampleRate));
    hi[b] = Math.max(lo[b] + 1, Math.floor((fHi * FFT_SIZE) / sampleRate));
  }
  return { lo, hi };
}

function createFftEngine({ sampleRate = 48000, fftEvery = FFT_EVERY_DEFAULT } = {}) {
  const FFT_EVERY = Math.max(1, fftEvery | 0);
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const ring = new Float32Array(FFT_SIZE);
  let ringIdx = 0;
  const hann = makeHann(FFT_SIZE);
  const { lo: bandLo, hi: bandHi } = makeBandBins(sampleRate);
  const bandsOut = new Float32Array(NUM_BANDS);
  let lastRms = 0;
  let tickCount = 0;

  // Feed interleaved PCM (typed Float32Array). channels = 1 or 2.
  // Mono-mixes and appends into the ring; updates `lastRms` for the
  // most-recent chunk so callers always have a quick scalar to report.
  function feed(samples, channels) {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    lastRms = Math.sqrt(sumSq / Math.max(1, samples.length));

    for (let i = 0; i < samples.length; i += channels) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += samples[i + c];
      ring[ringIdx] = s / channels;
      ringIdx = (ringIdx + 1) % FFT_SIZE;
    }
  }

  // Call once per capture callback. Returns { rms } every tick and
  // additionally { bands } every FFT_EVERY-th tick. Caller decides
  // which to forward to the renderer (we send `rms` continuously,
  // `bands` only when present).
  function tick() {
    tickCount++;
    if ((tickCount & (FFT_EVERY - 1)) !== 0) {
      return { rms: lastRms };
    }
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (ringIdx + i) % FFT_SIZE;
      real[i] = ring[idx] * hann[i];
      imag[i] = 0;
    }
    fft(real, imag);
    for (let b = 0; b < NUM_BANDS; b++) {
      const l = bandLo[b];
      const h = bandHi[b];
      let sum = 0;
      for (let k = l; k < h; k++) {
        const re = real[k];
        const im = imag[k];
        sum += Math.sqrt(re * re + im * im);
      }
      const avg = sum / (h - l);
      // Same dynamic-range compression the audify worker used: pow(.5)
      // log-compress, scale to give the renderer's AGC enough headroom
      // (250 ceiling against a 0-100 display scale).
      bandsOut[b] = Math.min(250, Math.pow(avg, 0.5) * 42);
    }
    return { rms: lastRms, bands: Array.from(bandsOut) };
  }

  return { feed, tick, NUM_BANDS, FFT_SIZE };
}

module.exports = { createFftEngine, NUM_BANDS, FFT_SIZE };
