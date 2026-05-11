// Linux audio backend.
//
// wpctl (WirePlumber's CLI) is the canonical way to talk to PipeWire
// without writing a native binding. It's tiny and present in every
// modern Debian/Ubuntu/Arch shipping PipeWire — exactly what our kiosk
// image bundles in Phase 4. PulseAudio compat builds also have `pactl`
// as a fallback, but we standardise on PipeWire for the kiosk so wpctl
// is what we drive.
//
// Implemented in this file:
//   setSystemMute(dataFlow, mute)   → wpctl set-mute @DEFAULT_*@ 0|1
//   getSystemMuteStates()           → parses wpctl get-volume output
//   setDefaultEndpoint(flow, name)  → wpctl status → find node id by
//                                     friendly name → wpctl set-default
//
// Still stubbed (Phase 3c):
//   startLoopback / stopLoopback / restartLoopback — needs a pw-cat
//     subprocess piping raw PCM to a JS FFT worker that produces the
//     same `{bands, deviceName, sampleRate, channels}` message shape
//     the Windows worker emits. The dashboard renderer is unchanged.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { utilityProcess } = require('electron');

// dataFlow: 0 = render (sinks / speakers), 1 = capture (sources / mic).
// wpctl uses @DEFAULT_AUDIO_SINK@ and @DEFAULT_AUDIO_SOURCE@ as magic
// identifiers for the current defaults — saves us looking up node ids
// for the simple mute case.
const TARGET = {
  0: '@DEFAULT_AUDIO_SINK@',
  1: '@DEFAULT_AUDIO_SOURCE@',
};

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message || '').trim() });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

async function setSystemMute(dataFlow, mute) {
  const target = TARGET[dataFlow];
  if (!target) return { ok: false, error: 'invalid dataFlow' };
  // `wpctl set-mute <target> 0|1` — 1 = muted, 0 = unmuted.
  const r = await run('wpctl', ['set-mute', target, mute ? '1' : '0']);
  if (!r.ok) return { ok: false, error: r.error };
  // Read back to confirm. set-mute prints nothing on success.
  const check = await run('wpctl', ['get-volume', target]);
  if (!check.ok) return { ok: true, muted: !!mute }; // best-effort
  return { ok: true, muted: /\[MUTED\]/.test(check.stdout) };
}

async function getSystemMuteStates() {
  // `wpctl get-volume @DEFAULT_*@` prints e.g. "Volume: 0.50 [MUTED]"
  // when muted, or "Volume: 0.50" otherwise.
  const [out, inp] = await Promise.all([
    run('wpctl', ['get-volume', TARGET[0]]),
    run('wpctl', ['get-volume', TARGET[1]]),
  ]);
  if (!out.ok && !inp.ok) {
    return { ok: false, error: out.error || inp.error || 'wpctl unavailable' };
  }
  return {
    ok: true,
    out: out.ok ? /\[MUTED\]/.test(out.stdout) : null,
    in:  inp.ok ? /\[MUTED\]/.test(inp.stdout) : null,
  };
}

// Walk `wpctl status` output (a tree of devices/nodes) looking for the
// section that matches our dataFlow ("Sinks" for render, "Sources" for
// capture) and return the node id whose friendly name substring-matches
// `pattern`. The active default is prefixed with " *" — we don't care
// about that here, we just want any node that matches.
//
// Sample line we're parsing (after stripping tree drawing chars):
//   "  *   55. Built-in Audio Analog Stereo  [vol: 0.50]"
function _parseStatusForNodeId(statusText, sectionTitle, pattern) {
  if (!statusText) return null;
  const lines = statusText.split('\n');
  let inAudio = false;
  let inSection = false;
  const re = new RegExp(`${sectionTitle}:`, 'i');
  const want = String(pattern || '').toLowerCase();
  for (const raw of lines) {
    const line = raw.replace(/[│├└─]/g, ' '); // strip box-drawing
    if (/^Audio\b/i.test(line.trim())) { inAudio = true; continue; }
    if (/^Video\b/i.test(line.trim()) || /^Settings\b/i.test(line.trim())) {
      inAudio = false; inSection = false; continue;
    }
    if (!inAudio) continue;
    if (re.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    // Stop at next sub-header (e.g. "Sources:" while we're in Sinks:).
    if (/^[A-Z][A-Za-z ]+:\s*$/.test(line.trim())) { inSection = false; continue; }
    const m = line.match(/^\s*\*?\s*(\d+)\.\s+(.+?)(\s+\[vol|$)/);
    if (!m) continue;
    const id = m[1];
    const name = m[2].toLowerCase();
    if (name.includes(want)) return id;
  }
  return null;
}

async function setDefaultEndpoint(dataFlow, namePattern) {
  const status = await run('wpctl', ['status']);
  if (!status.ok) return { ok: false, error: status.error };
  const sectionTitle = dataFlow === 1 ? 'Sources' : 'Sinks';
  const nodeId = _parseStatusForNodeId(status.stdout, sectionTitle, namePattern);
  if (!nodeId) {
    return { ok: false, error: 'no match', pattern: namePattern };
  }
  const r = await run('wpctl', ['set-default', nodeId]);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, name: namePattern, id: nodeId };
}

// Loopback capture — forks audify-worker-linux.js as a utilityProcess.
// The worker spawns `parec` to read the default sink's monitor stream,
// runs it through the shared FFT engine, and posts `{rms, bands?,
// deviceName}` back to us. We forward to the dashboard window on the
// same `audio-out-level` IPC channel the Windows worker uses.
let _audioProc = null;
let _audioWin  = null;

function startLoopback(win) {
  if (process.env.DASH3D_DISABLE_AUDIFY) return;
  if (_audioProc) return;
  _audioWin = win;

  const workerPath = path.join(__dirname, '..', '..', 'audify-worker-linux.js');
  if (!fs.existsSync(workerPath)) {
    console.warn('linux audio worker missing at', workerPath);
    return;
  }

  try {
    _audioProc = utilityProcess.fork(workerPath, [], {
      stdio: 'pipe',
      serviceName: 'dash3d-parec',
      env: process.env,
    });
  } catch (err) {
    console.error('utilityProcess.fork (linux audio) failed:', err.message);
    _audioProc = null;
    return;
  }

  _audioProc.stdout?.on('data', (b) => process.stdout.write(`[parec] ${b}`));
  _audioProc.stderr?.on('data', (b) => process.stderr.write(`[parec] ${b}`));

  _audioProc.on('message', (data) => {
    if (data?.status === 'started') {
      console.log(`PipeWire loopback started on "${data.deviceName}" (${data.sampleRate}Hz, ${data.channels}ch)`);
    }
    if (_audioWin && !_audioWin.isDestroyed()) {
      _audioWin.webContents.send('audio-out-level', data);
    }
  });

  _audioProc.on('exit', (code) => {
    console.log('parec worker exited code', code);
    if (_audioWin && !_audioWin.isDestroyed()) {
      _audioWin.webContents.send('audio-out-level', { error: `worker exit ${code}` });
    }
    _audioProc = null;
  });
}

function stopLoopback() {
  if (!_audioProc) return;
  try { _audioProc.postMessage('stop'); } catch {}
  const p = _audioProc;
  setTimeout(() => { try { p.kill(); } catch {} }, 200);
  _audioProc = null;
}

function restartLoopback(win) {
  stopLoopback();
  // PipeWire/Pulse releases the monitor source quickly — same 350 ms
  // safety margin as the Windows worker for parity.
  setTimeout(() => startLoopback(win), 350);
}

module.exports = {
  startLoopback,
  stopLoopback,
  restartLoopback,
  setSystemMute,
  getSystemMuteStates,
  setDefaultEndpoint,
};
