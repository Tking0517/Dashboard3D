// Windows power-profile backend.
// Drives the active scheme's processor min/max via powercfg.exe. Both
// AC + DC index slots are written so the throttle applies on battery
// and on wall power, then `/setactive SCHEME_CURRENT` forces Windows
// to re-apply the scheme so the new values take effect immediately.
const { execFile } = require('child_process');

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('powercfg.exe', args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr?.trim() || err.message)); return; }
      resolve(stdout);
    });
  });
}

async function setProfile({ maxCpu, minCpu } = {}) {
  const max = Math.max(0, Math.min(100, Math.round(Number(maxCpu))));
  const min = Math.max(0, Math.min(100, Math.round(Number(minCpu))));
  if (!Number.isFinite(max) || !Number.isFinite(min)) {
    return { ok: false, error: 'invalid maxCpu/minCpu' };
  }
  const settings = [
    ['SUB_PROCESSOR', 'PROCTHROTTLEMAX', max],
    ['SUB_PROCESSOR', 'PROCTHROTTLEMIN', min],
  ];
  try {
    for (const [sub, setting, val] of settings) {
      await run(['/setacvalueindex', 'SCHEME_CURRENT', sub, setting, String(val)]);
      await run(['/setdcvalueindex', 'SCHEME_CURRENT', sub, setting, String(val)]);
    }
    await run(['/setactive', 'SCHEME_CURRENT']);
    return { ok: true, max, min };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { setProfile };
