// Linux sensors backend — stubbed.
//
// Phase 2 fills these in with:
//   getNativeFallback() → walks /sys/class/hwmon/* to read coretemp,
//     fan RPMs, and /sys/class/drm/card*/device/{hwmon,power*} for
//     AMD/Intel GPU temps + power. NVIDIA already covered by
//     nvidia-smi (cross-platform, runs from main.js's existing path).
//   launchSensorBackend() — no-op. Linux hwmon is a kernel interface,
//     no userspace daemon to start.

async function getNativeFallback() {
  return null;
}

function launchSensorBackend() {
  // no-op
}

module.exports = { launchSensorBackend, getNativeFallback };
