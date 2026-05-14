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
const { createFftEngine } = require('./audio-fft');

let rt = null;
// PCM forwarding gate. Enabled by main when a screen recording starts
// so the renderer can pipe loopback audio into the recording's MediaStream
// (Chromium's chromeMediaSource: 'desktop' doesn't capture audio from
// window sources; this worker has the real samples already, so we just
// forward them when asked). Disabled otherwise to avoid IPC traffic.
let _pcmOn = false;
// Batch N callbacks before posting so we don't spam IPC ~93 Hz at
// 48 kHz/512. 4 ≈ 23 messages/sec ≈ 43 ms of audio per chunk — small
// enough to feel synchronous to the recorder, large enough to be cheap.
const PCM_BATCH = 4;
let _pcmBatch = [];
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

    // Shared FFT engine. Same code path Linux's parec worker uses, so
    // the renderer sees identical `{rms, bands?}` messages regardless
    // of OS.
    const fftEngine = createFftEngine({ sampleRate });

    rt.openStream(
      null,
      { deviceId: dev.id, nChannels: channels, firstChannel: 0 },
      RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      512,
      'dash3d-loopback',
      (pcm) => {
        const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
        fftEngine.feed(samples, channels);
        const result = fftEngine.tick();
        if (result.bands) {
          process.parentPort.postMessage({
            rms: result.rms,
            bands: result.bands,
            deviceName: dev.name,
          });
        } else {
          process.parentPort.postMessage({ rms: result.rms, deviceName: dev.name });
        }
        // PCM forwarding: copy this callback's samples into a fresh
        // Float32Array (the audify buffer gets reused) and batch
        // PCM_BATCH callbacks before posting. Posting a typed array
        // through utilityProcess.postMessage uses structured clone.
        if (_pcmOn) {
          _pcmBatch.push(new Float32Array(samples));
          if (_pcmBatch.length >= PCM_BATCH) {
            // Concatenate the batch into one interleaved buffer.
            let total = 0;
            for (const a of _pcmBatch) total += a.length;
            const merged = new Float32Array(total);
            let off = 0;
            for (const a of _pcmBatch) { merged.set(a, off); off += a.length; }
            _pcmBatch.length = 0;
            try {
              process.parentPort.postMessage({
                pcm: merged,
                sampleRate,
                channels,
              });
            } catch {}
          }
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
  if (e.data === 'pcm-on')  { _pcmOn = true;  _pcmBatch.length = 0; }
  if (e.data === 'pcm-off') { _pcmOn = false; _pcmBatch.length = 0; }
});

start();
