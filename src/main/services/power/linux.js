// Linux power-profile backend — stub.
// Phase 2 will fill this in with cpupower frequency-set / sysfs writes
// to /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq. For now it
// just refuses cleanly so the renderer's UI shows a "not supported"
// state instead of throwing.

async function setProfile() {
  return { ok: false, error: 'power profile not yet implemented on linux' };
}

module.exports = { setProfile };
