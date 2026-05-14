// Linux loopback worker — same role as audify-worker.js on Windows.
// Spawned in an Electron utilityProcess by services/audio/linux.js.
//
// Capture path:
//   1. `pactl get-default-sink` → friendly name of the active output
//   2. spawn `parec --format=float32le --rate=48000 --channels=2
//      -d <sink>.monitor` to read raw PCM from that sink's monitor
//   3. feed every chunk through the shared FFT engine
//   4. post the same `{ rms, bands, deviceName, sampleRate, channels }`
//      shape the Windows worker emits so the renderer code is identical
//
// parec is part of PulseAudio compat tools; PipeWire ships a drop-in
// replacement under the same name, so the kiosk image only needs
// `pipewire-pulse` installed (which we'd ship by default).
//
// Why not pw-cat? pw-cat is the PipeWire-native equivalent but its
// CLI surface has churned across PipeWire releases — parec's interface
// has been stable for a decade and works against both implementations.

const { spawn, execFileSync } = require('child_process');
const { createFftEngine, FFT_SIZE } = require('./audio-fft');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 4;      // float32
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;
// 512 frames per tick matches the Windows worker's audify callback
// granularity → same ~23 Hz FFT update cadence after the FFT_EVERY=4
// divisor in audio-fft.js.
const FRAMES_PER_TICK = 512;
const TICK_BYTES = FRAMES_PER_TICK * FRAME_BYTES;

function getDefaultSinkName() {
  try {
    return execFileSync('pactl', ['get-default-sink'], { encoding: 'utf8' }).trim();
  } catch (err) {
    return null;
  }
}

let child = null;
let leftover = Buffer.alloc(0);
// Linux worker still chunks at 512 frames per tick → ~94 Hz callbacks at
// 48 kHz. fftEvery: 4 keeps the renderer-side output at ~23 Hz, matching
// what Windows now produces natively from its 2048-sample buffer.
const fft = createFftEngine({ sampleRate: SAMPLE_RATE, fftEvery: 4 });

function start() {
  const sink = getDefaultSinkName();
  if (!sink) {
    process.parentPort.postMessage({ error: 'pactl unavailable — is PipeWire/Pulse running?' });
    process.exit(0);
    return;
  }
  const monitor = `${sink}.monitor`;
  const deviceName = sink;

  try {
    child = spawn('parec', [
      '--format=float32le',
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      '-d', monitor,
      '--raw',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    process.parentPort.postMessage({ error: `parec spawn: ${err.message}` });
    process.exit(0);
    return;
  }

  child.stderr.on('data', (b) => process.stderr.write(`[parec] ${b}`));
  child.on('error', (err) => {
    process.parentPort.postMessage({ error: `parec error: ${err.message}` });
  });
  child.on('exit', (code) => {
    process.parentPort.postMessage({ error: `parec exit ${code}` });
    process.exit(0);
  });

  child.stdout.on('data', (chunk) => {
    // Buffer + split into FRAMES_PER_TICK-sized blocks before feeding
    // the FFT, so the tick cadence matches the Windows worker. parec
    // delivers chunks at PipeWire's quantum boundary, which is usually
    // smaller than 512 frames and varies by sample rate.
    leftover = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    while (leftover.length >= TICK_BYTES) {
      const block = leftover.subarray(0, TICK_BYTES);
      leftover = leftover.subarray(TICK_BYTES);
      const samples = new Float32Array(block.buffer, block.byteOffset, FRAMES_PER_TICK * CHANNELS);
      fft.feed(samples, CHANNELS);
      const result = fft.tick();
      // Only post when bands are present (every FFT_EVERY-th tick = ~23 Hz).
      // RMS-only off-frames are ignored by the renderer; posting them was
      // ~94 messages/sec across worker → main → renderer. Dropped.
      if (result.bands) {
        process.parentPort.postMessage({
          rms: result.rms,
          bands: result.bands,
          deviceName,
        });
      }
    }
  });

  process.parentPort.postMessage({
    status: 'started',
    deviceName,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  });
}

process.parentPort.on('message', (e) => {
  if (e?.data === 'stop') {
    try { child?.kill('SIGTERM'); } catch {}
    process.exit(0);
  }
});

start();
