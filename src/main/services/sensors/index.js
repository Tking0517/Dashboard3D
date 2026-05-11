// Sensors adapter — platform-specific fallback path for CPU/GPU temps
// and power. The cross-platform happy path (systeminformation + nvidia-
// smi, both work on Win + Linux) stays in main.js; only when those
// can't fill in a value does main.js call into this service.
//
// Interface (both backends export the same shape):
//   getNativeFallback() → Promise<{
//     cpu?:       number | null,   // °C
//     cpuPower?:  number | null,   // W
//     gpus?:      Array<number|null>,  // per-GPU temp °C
//     gpusPower?: Array<number|null>,  // per-GPU power W
//   } | null>
//
//   launchSensorBackend() → void
//     Fire-and-forget. On Windows this kicks the bundled
//     LibreHardwareMonitor.exe if it isn't already running (UAC prompt
//     on first launch). On Linux it's a no-op — hwmon sensors are
//     always present in the kernel, no daemon needed.

module.exports = process.platform === 'win32'
  ? require('./win')
  : require('./linux');
