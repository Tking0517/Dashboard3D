// Windows window-manager backend.
// Always-on-bottom: pin the dashboard BrowserWindow to the bottom of
// the z-order so it acts like a desktop replacement. A persistent
// powershell.exe stays alive for the life of the process — every
// SetWindowPos call costs ~10 ms via this pipe vs ~300 ms cold-spawn.
const { spawn } = require('child_process');

let _psBg = null;

function getBgShell() {
  if (_psBg && !_psBg.killed && _psBg.exitCode == null) return _psBg;
  _psBg = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  _psBg.on('error', () => { _psBg = null; });
  _psBg.on('exit',  () => { _psBg = null; });
  // Define the SetWindowPos P/Invoke once for the life of this process.
  _psBg.stdin.write(
    `Add-Type -ErrorAction SilentlyContinue -MemberDefinition '` +
      `[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);` +
    `' -Name N -Namespace W;\r\n`
  );
  return _psBg;
}

function sendToBottom(win) {
  if (!win || win.isDestroyed()) return;
  let hwnd;
  try {
    // HWND fits in 32 bits on Windows (even on x64).
    hwnd = win.getNativeWindowHandle().readUInt32LE(0);
  } catch {
    return;
  }
  // SetWindowPos(hwnd, HWND_BOTTOM=1, 0, 0, 0, 0,
  //              SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE = 0x0013)
  const sh = getBgShell();
  if (!sh || !sh.stdin || sh.stdin.destroyed) return;
  try {
    sh.stdin.write(
      `[W.N]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]1, 0, 0, 0, 0, 0x13) | Out-Null\r\n`
    );
  } catch {}
}

function shutdown() {
  if (_psBg && !_psBg.killed) {
    try { _psBg.stdin.end(); } catch {}
    _psBg = null;
  }
}

module.exports = { sendToBottom, shutdown };
