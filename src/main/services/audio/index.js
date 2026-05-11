// Audio service adapter.
//
// Interface (both backends export the same shape):
//
//   startLoopback(win, deviceId = null) — fire-and-forget. Spawn a
//     worker that captures system audio levels and pushes them to
//     `win.webContents` over the 'audio-out-level' IPC channel.
//
//   stopLoopback() — kill the worker. Safe to call when nothing
//     is running.
//
//   restartLoopback(win, deviceId) — stop + restart on a small gap so
//     the underlying audio backend can release the prior endpoint.
//
//   setSystemMute(dataFlow, mute) → Promise<{ok, muted?, error?}>
//     dataFlow: 0 = render (speakers), 1 = capture (mic).
//
//   getSystemMuteStates() → Promise<{ok, out?, in?, error?}>
//
//   setDefaultEndpoint(dataFlow, namePattern) →
//     Promise<{ok, name?, id?, error?, available?}>
//     Switch the OS default device. namePattern is a friendly-name
//     substring; backends do their own matching against system info.
//
// Windows uses audify (WASAPI) + inline C# COM via PowerShell.
// Linux will use PipeWire bindings + wpctl CLI (Phase 3).

module.exports = process.platform === 'win32'
  ? require('./win')
  : require('./linux');
