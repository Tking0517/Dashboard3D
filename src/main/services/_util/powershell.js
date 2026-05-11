// Shared PowerShell runner used by every Windows-side service backend.
// Spawn powershell.exe with a single -Command, parse stdout as JSON,
// resolve to null on any failure (spawn error, non-zero exit, invalid
// JSON). Callers branch on the null to decide whether to surface an
// error or fall back to another source.
//
// Linux-side service backends never load this file — they use sysfs,
// bash CLIs, or native bindings instead.
const { execFile } = require('child_process');

function runPowerShell(script, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try { resolve(JSON.parse(stdout || 'null')); }
        catch { resolve(null); }
      },
    );
  });
}

module.exports = { runPowerShell };
