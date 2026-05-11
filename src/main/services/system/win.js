// Windows system utilities backend.
const { execFile } = require('child_process');
const { runPowerShell } = require('../_util/powershell');

// Walk every process and call psapi!EmptyWorkingSet on each. Trims
// resident pages back to what's actively in use — system reclaims the
// rest. Only flushes user-owned processes; system-protected ones
// quietly fail and get counted as 'failed'.
async function flushRam() {
  const ps =
    'Add-Type -MemberDefinition \'[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);\' ' +
    '-Name MM -Namespace W -ErrorAction SilentlyContinue; ' +
    '$f = 0; $x = 0; ' +
    'Get-Process | ForEach-Object { ' +
      'try { if ([W.MM]::EmptyWorkingSet($_.Handle)) { $f++ } else { $x++ } } catch { $x++ } ' +
    '}; ' +
    'ConvertTo-Json @{ flushed = $f; failed = $x }';
  const r = await runPowerShell(ps, { timeout: 30000 });
  return r || { ok: false, error: 'powershell failed' };
}

// Copy a list of file paths to the OS clipboard as Windows shell file
// objects (CF_HDROP). Paste targets (Explorer, chat apps, Photos)
// receive them as if they came from Explorer's own Ctrl+C. Caller is
// expected to have already filtered paths to ones the user is
// authorised to copy.
function copyFilesToClipboard(paths) {
  if (!paths.length) return Promise.resolve({ ok: false, error: 'no valid paths' });
  const escaped = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -Path ${escaped}`],
      { timeout: 6000, windowsHide: true },
      (err) => resolve(err
        ? { ok: false, error: err.message }
        : { ok: true, count: paths.length }),
    );
  });
}

// List active BITS transfers (Windows Update + any app routing through
// the Background Intelligent Transfer Service). Returned objects expose
// just the fields the dashboard's progress UI needs; caller computes
// speed + smoothing on top. Always returns an array (empty on failure
// so the caller doesn't have to guard).
async function getActiveBitsTransfers() {
  const ps = `Get-BitsTransfer -AllUsers -ErrorAction SilentlyContinue |
    Where-Object { $_.JobState -in 'Transferring','Connecting','Queued' } |
    Select-Object @{n='id';e={[string]$_.JobId}}, DisplayName, BytesTotal, BytesTransferred, TransferType |
    ConvertTo-Json -Compress -Depth 2`;
  const r = await runPowerShell(ps, { timeout: 2500 });
  if (r == null) return [];
  return Array.isArray(r) ? r : [r];
}

module.exports = { flushRam, copyFilesToClipboard, getActiveBitsTransfers };
