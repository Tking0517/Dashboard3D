// Linux window-manager backend — no-op.
// Under cage (the Wayland kiosk compositor we target for the bootable
// USB image), the dashboard is the only client on screen — no stacking
// to fight, nothing to push down. Phase 4 ships cage configured to give
// the dashboard fullscreen, no decorations, no escape.

function sendToBottom() {
  // no-op
}

function shutdown() {
  // no-op
}

module.exports = { sendToBottom, shutdown };
