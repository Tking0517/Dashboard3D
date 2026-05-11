// Linux audio backend — stubbed for Phase 1.
//
// Phase 3 fills these in:
//   startLoopback() — capture PipeWire's default sink monitor stream
//     (sink_name + ".monitor") via a small native binding or `pw-cat`
//     subprocess. Compute the same FFT bands the Windows worker does
//     and post the same { bands, deviceName, sampleRate, channels }
//     message shape so the renderer code is identical.
//   setSystemMute / getSystemMuteStates — `wpctl set-mute @DEFAULT_*`
//     and `wpctl get-volume` parsing.
//   setDefaultEndpoint — `wpctl set-default <node-id>` after looking
//     up the node id from `wpctl status` filtered by friendly name.

function startLoopback() {
  // no-op
}

function stopLoopback() {
  // no-op
}

function restartLoopback() {
  // no-op
}

async function setSystemMute(_dataFlow, _mute) {
  return { ok: false, error: 'system mute not yet implemented on linux' };
}

async function getSystemMuteStates() {
  return { ok: false, error: 'mute state not yet implemented on linux' };
}

async function setDefaultEndpoint(_dataFlow, _namePattern) {
  return { ok: false, error: 'default endpoint switch not yet implemented on linux' };
}

module.exports = {
  startLoopback,
  stopLoopback,
  restartLoopback,
  setSystemMute,
  getSystemMuteStates,
  setDefaultEndpoint,
};
