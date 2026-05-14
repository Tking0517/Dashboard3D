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
//     Fire-and-forget. On Windows this is now a no-op — the backend
//     reads CPU temp directly via WMI's ACPI thermal zone class, so no
//     external monitor process / UAC prompt is required. On Linux it's
//     also a no-op (hwmon kernel sensors are always present).
//     Kept as an exported method for interface stability.

module.exports = process.platform === 'win32'
  ? require('./win')
  : require('./linux');
