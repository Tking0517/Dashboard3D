// Runs in an Electron utilityProcess (Node-only). Loads audify, opens
// WASAPI loopback on the default output device, and posts visualization
// data back to the parent: per-band FFT magnitudes and an overall RMS.
// Isolated from the main process so a native crash here can't kill the app.

let audify;
try { audify = require('audify'); }
catch (err) {
  process.parentPort.postMessage({ error: `audify load: ${err.message}` });
  process.exit(0);
}

const { RtAudio, RtAudioFormat, RtAudioApi } = audify;

// FFT / band config. 1024-pt FFT every 2 callbacks at 512 frames each ≈ 47 Hz
// updates at 48 kHz — comfortably above display refresh, well below audio
// callback rate so we don't burn CPU.
const FFT_SIZE = 1024;
const NUM_BANDS = 24;

const fftReal = new Float64Array(FFT_SIZE);
const fftImag = new Float64Array(FFT_SIZE);
const sampleBuf = new Float32Array(FFT_SIZE); // ring buffer of mono-mixed samples
let sampleBufIdx = 0;

const hann = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
}

let bandLowBin = null;
let bandHighBin = null;

function setupBands(sampleRate) {
  bandLowBin  = new Int32Array(NUM_BANDS);
  bandHighBin = new Int32Array(NUM_BANDS);
  const fMin = 60;
  const fMax = Math.min(16000, sampleRate / 2);
  for (let b = 0; b < NUM_BANDS; b++) {
    const fLo = fMin * Math.pow(fMax / fMin, b / NUM_BANDS);
    const fHi = fMin * Math.pow(fMax / fMin, (b + 1) / NUM_BANDS);
    bandLowBin[b]  = Math.max(1, Math.floor((fLo * FFT_SIZE) / sampleRate));
    bandHighBin[b] = Math.max(bandLowBin[b] + 1, Math.floor((fHi * FFT_SIZE) / sampleRate));
  }
}

// In-place radix-2 Cooley-Tukey FFT. real/imag are length N (power of 2).
function fft(real, imag) {
  const N = real.length;
  // Bit-reversal permutation
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

let rt = null;
function start() {
  try {
    rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
    const devices = rt.getDevices();
    const defaultId = rt.getDefaultOutputDevice();

    process.parentPort.postMessage({
      devices: devices
        .filter(d => d.outputChannels > 0)
        .map(d => ({
          id: d.id, name: d.name,
          channels: d.outputChannels,
          sampleRate: d.preferredSampleRate,
          isDefault: d.id === defaultId,
        })),
    });

    const requestedId = process.env.DASH3D_AUDIO_DEVICE_ID
      ? Number(process.env.DASH3D_AUDIO_DEVICE_ID)
      : null;

    let dev = null;
    if (requestedId != null) {
      dev = devices.find(d => d.id === requestedId && d.outputChannels > 0);
    }
    if (!dev) {
      const VIRTUAL_RE = /\b(cable|vb[- ]?audio|voicemeeter|nvidia broadcast|virtual)\b/i;
      const real = devices.filter(d => d.outputChannels > 0 && !VIRTUAL_RE.test(d.name));
      const def = devices.find(d => d.id === defaultId);
      if (def && !VIRTUAL_RE.test(def.name)) {
        dev = def;
      } else {
        dev = real.find(d => d.id === defaultId)
           || real[0]
           || def
           || devices.find(d => d.outputChannels > 0);
      }
    }
    if (!dev) throw new Error('no output device');

    const sampleRate = dev.preferredSampleRate || 48000;
    const channels   = Math.min(2, Math.max(1, dev.outputChannels || 2));

    setupBands(sampleRate);

    let frameCount = 0;
    const bandsOut = new Float32Array(NUM_BANDS);

    rt.openStream(
      null,
      { deviceId: dev.id, nChannels: channels, firstChannel: 0 },
      RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      512,
      'dash3d-loopback',
      (pcm) => {
        const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);

        // Overall RMS for backward-compat / fallback display.
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / samples.length);

        // Mix interleaved channels to mono and append to ring buffer.
        for (let i = 0; i < samples.length; i += channels) {
          let s = 0;
          for (let c = 0; c < channels; c++) s += samples[i + c];
          sampleBuf[sampleBufIdx] = s / channels;
          sampleBufIdx = (sampleBufIdx + 1) % FFT_SIZE;
        }

        frameCount++;
        // Run the FFT every fourth callback (~43 ms cadence at 48 kHz/512,
        // ~23 Hz). Halved from the previous ~47 Hz — these meters don't
        // need realtime updates and the lower cadence cuts the renderer
        // canvas redraws + IPC traffic in half.
        if ((frameCount & 3) === 0) {
          for (let i = 0; i < FFT_SIZE; i++) {
            const idx = (sampleBufIdx + i) % FFT_SIZE;
            fftReal[i] = sampleBuf[idx] * hann[i];
            fftImag[i] = 0;
          }
          fft(fftReal, fftImag);

          for (let b = 0; b < NUM_BANDS; b++) {
            const lo = bandLowBin[b];
            const hi = bandHighBin[b];
            let sum = 0;
            for (let k = lo; k < hi; k++) {
              const re = fftReal[k];
              const im = fftImag[k];
              sum += Math.sqrt(re * re + im * im);
            }
            const avg = sum / (hi - lo);
            // Compress dynamic range (audio is logarithmic). pow(.5)*76
            // keeps quiet content visible without slamming most of the
            // bars to 100% on normal listening volume.
            bandsOut[b] = Math.min(100, Math.pow(avg, 0.5) * 76);
          }

          process.parentPort.postMessage({
            rms,
            bands: Array.from(bandsOut),
            deviceName: dev.name,
          });
        } else {
          process.parentPort.postMessage({ rms, deviceName: dev.name });
        }
      },
      null,
    );
    rt.start();
    process.parentPort.postMessage({ status: 'started', deviceName: dev.name, sampleRate, channels });
  } catch (err) {
    process.parentPort.postMessage({ error: `audify start: ${err.message}` });
    try { rt?.closeStream(); } catch {}
    rt = null;
  }
}

process.parentPort.on('message', (e) => {
  if (e.data === 'stop') {
    try { if (rt?.isStreamRunning()) rt.stop(); } catch {}
    try { if (rt?.isStreamOpen())    rt.closeStream(); } catch {}
    rt = null;
    process.exit(0);
  }
});

start();
