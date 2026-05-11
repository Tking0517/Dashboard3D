// Window-manager adapter. The dashboard's "always-on-bottom" trick —
// sliding the BrowserWindow to the bottom of the z-order whenever
// focus/blur fires so it acts like a desktop replacement instead of a
// floating window — is purely a Windows concern.
//
// Interface:
//   sendToBottom(win) — push the window to the bottom of the OS z-order
//   shutdown()        — release any persistent helpers
//
// On Linux (cage kiosk compositor) there's only one window on screen
// and no z-order to fight, so both calls no-op.

module.exports = process.platform === 'win32'
  ? require('./win')
  : require('./linux');
