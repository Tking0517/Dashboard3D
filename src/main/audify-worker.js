// Runs in an Electron utilityProcess (Node-only). Loads audify, opens
// WASAPI loopback on the default output device, and posts {rms, deviceName}
// messages back to the parent. Isolated from the main process so a native
// crash here can't kill the app.

let audify;
try { audify = require('audify'); }
catch (err) {
  process.parentPort.postMessage({ error: `audify load: ${err.message}` });
  process.exit(0);
}

const { RtAudio, RtAudioFormat, RtAudioApi } = audify;

let rt = null;
function start() {
  try {
    rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
    const devices = rt.getDevices();
    const defaultId = rt.getDefaultOutputDevice();

    // Send the full device list back so the UI can let the user pick.
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
      // Default = OS default output, but skip virtual cables / hidden routes
      // unless the user has nothing else.
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

    rt.openStream(
      null,
      { deviceId: dev.id, nChannels: channels, firstChannel: 0 },
      RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      512,
      'dash3d-loopback',
      (pcm) => {
        const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
        const rms = Math.sqrt(sumSq / samples.length);
        process.parentPort.postMessage({ rms, deviceName: dev.name });
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
