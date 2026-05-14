// Windows sensors backend — non-elevated, in-process.
//
// CPU temperature is read by trying several non-elevated WMI / perf-
// counter paths in order. None of these need UAC or a kernel driver:
//   1. MSAcpi_ThermalZoneTemperature (root\WMI)        — ACPI directly
//   2. \Thermal Zone Information(*)\Temperature        — PDH counter
//   3. Win32_PerfFormattedData_Counters_ThermalZoneInformation — same
//      ACPI data via the performance-counter WMI provider
//   4. Win32_TemperatureProbe (WMI)                    — older legacy
//
// Most modern desktops expose thermal data via at least one of these.
// The first probe that returns a plausible reading (≥ 10 °C, ≤ 120 °C)
// wins. Each probe's result is also stamped into `lastDiagnostics` so
// the renderer can log "why no temp" without ambiguity.
//
// The previous build launched a bundled LibreHardwareMonitor.exe with
// `-Verb RunAs` to read CPU MSRs directly. That gave per-core accuracy
// but required a UAC prompt + a second process. This adapter trades
// that for non-elevated read access; on machines where ACPI isn't
// wired up, the dashboard's CPU-temp panel simply shows N/A rather
// than prompting for admin rights.

const { runPowerShell } = require('../_util/powershell');

let _lastDiagnostics = null;
function getLastDiagnostics() { return _lastDiagnostics; }

// Multi-probe PowerShell — each block is wrapped in its own try so a
// missing class/counter doesn't kill subsequent probes. Returns a
// structured JSON object the JS side parses + picks from.
//
// Power probes (cpu watts) are best-effort: Windows exposes RAPL data
// through `\Power Meter(*)\Power` and `Win32_PerfFormattedData_Counters_
// PowerMeter` only when the system has the EnergyEstimationEngine /
// Intel Power Gadget driver installed. On bare-stock systems these
// return empty, and there's no non-elevated alternative — we just
// surface "no data" rather than prompt for admin.
const _TEMP_PROBE_PS = `
$ErrorActionPreference = 'Continue'
$probes = @()
$powerProbes = @()

# Probe 1 — ACPI thermal zones via WMI (root\\WMI). Sensors report in
# tenths of Kelvin. Usually available on desktops; sometimes empty
# or stuck on broken-DSDT laptops.
try {
  $tz = Get-CimInstance -Namespace 'root/WMI' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
  if ($tz) {
    $vals = @($tz | ForEach-Object { [math]::Round((($_.CurrentTemperature / 10) - 273.15), 1) })
    $max = ($vals | Measure-Object -Maximum).Maximum
    $probes += @{ name = 'MSAcpi'; values = $vals; max = $max }
  } else {
    $probes += @{ name = 'MSAcpi'; error = 'no instances' }
  }
} catch {
  $probes += @{ name = 'MSAcpi'; error = $_.Exception.Message }
}

# Probe 2 — Performance Data Helper counter. Same ACPI data, different
# interface; on some BIOSes one works when the other doesn't.
try {
  $pc = Get-Counter '\\Thermal Zone Information(*)\\Temperature' -ErrorAction Stop
  $vals = @($pc.CounterSamples | ForEach-Object { [math]::Round(($_.CookedValue - 273.15), 1) })
  $max = ($vals | Measure-Object -Maximum).Maximum
  $probes += @{ name = 'PerfCounter'; values = $vals; max = $max }
} catch {
  $probes += @{ name = 'PerfCounter'; error = $_.Exception.Message }
}

# Probe 3 — Win32_PerfFormattedData_Counters_ThermalZoneInformation.
# Same data via WMI's perf provider; works on a few machines where the
# previous two paths return empty.
try {
  $tz3 = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop
  if ($tz3) {
    $vals = @($tz3 | ForEach-Object { [math]::Round(($_.Temperature - 273.15), 1) })
    $max = ($vals | Measure-Object -Maximum).Maximum
    $probes += @{ name = 'Win32_Perf'; values = $vals; max = $max }
  } else {
    $probes += @{ name = 'Win32_Perf'; error = 'no instances' }
  }
} catch {
  $probes += @{ name = 'Win32_Perf'; error = $_.Exception.Message }
}

# Probe 4 — Win32_TemperatureProbe legacy WMI. Rarely populated on
# modern hardware but free to try.
try {
  $tp = Get-CimInstance -ClassName Win32_TemperatureProbe -ErrorAction Stop |
        Where-Object { $_.CurrentReading -ne $null }
  if ($tp) {
    $vals = @($tp | ForEach-Object { [math]::Round((($_.CurrentReading / 10) - 273.15), 1) })
    $max = ($vals | Measure-Object -Maximum).Maximum
    $probes += @{ name = 'TempProbe'; values = $vals; max = $max }
  }
} catch {
  $probes += @{ name = 'TempProbe'; error = $_.Exception.Message }
}

# Power probe A — \Power Meter(*)\Power PDH counter. The Windows
# kernel exposes RAPL through this counter when the EnergyEstimation
# driver is loaded. Unit: milliwatts on most systems, watts on some.
try {
  $pm = Get-Counter '\\Power Meter(*)\\Power' -ErrorAction Stop
  $vals = @($pm.CounterSamples | ForEach-Object { $_.CookedValue })
  # Auto-detect mW vs W — anything > 200 is almost certainly mW.
  $max = ($vals | Measure-Object -Maximum).Maximum
  $isMilli = ($max -gt 200)
  $watts = if ($isMilli) { $vals | ForEach-Object { [math]::Round($_ / 1000.0, 1) } } else { $vals | ForEach-Object { [math]::Round($_, 1) } }
  $maxW = ($watts | Measure-Object -Maximum).Maximum
  $powerProbes += @{ name = 'PowerMeterPC'; values = $watts; max = $maxW; unit = (if ($isMilli) { 'mW->W' } else { 'W' }) }
} catch {
  $powerProbes += @{ name = 'PowerMeterPC'; error = $_.Exception.Message }
}

# Power probe B — Win32_PerfFormattedData_Counters_PowerMeter WMI.
# Same data; sometimes available when Get-Counter isn't.
try {
  $pm2 = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_PowerMeter -ErrorAction Stop |
         Where-Object { $_.Power -ne $null -and $_.Power -gt 0 }
  if ($pm2) {
    $vals = @($pm2 | ForEach-Object { $_.Power })
    $max = ($vals | Measure-Object -Maximum).Maximum
    $isMilli = ($max -gt 200)
    $watts = if ($isMilli) { $vals | ForEach-Object { [math]::Round($_ / 1000.0, 1) } } else { $vals | ForEach-Object { [math]::Round($_, 1) } }
    $maxW = ($watts | Measure-Object -Maximum).Maximum
    $powerProbes += @{ name = 'PowerMeterWMI'; values = $watts; max = $maxW; unit = (if ($isMilli) { 'mW->W' } else { 'W' }) }
  } else {
    $powerProbes += @{ name = 'PowerMeterWMI'; error = 'no instances' }
  }
} catch {
  $powerProbes += @{ name = 'PowerMeterWMI'; error = $_.Exception.Message }
}

ConvertTo-Json -Compress -Depth 4 @{ probes = $probes; powerProbes = $powerProbes }
`.trim();

async function getNativeFallback() {
  const obj = await runPowerShell(_TEMP_PROBE_PS, { timeout: 6000 });
  _lastDiagnostics = obj;
  // Log every probe result so DevTools / the main-process console
  // shows exactly which path landed (or why none did).
  try {
    const probes = Array.isArray(obj?.probes) ? obj.probes : [];
    for (const p of probes) {
      if (p?.error) {
        console.log(`[sensors] ${p.name} → error: ${p.error}`);
      } else if (Number.isFinite(p?.max)) {
        console.log(`[sensors] ${p.name} → ${p.max} °C (zones: ${JSON.stringify(p.values || [])})`);
      } else {
        console.log(`[sensors] ${p.name} → empty`);
      }
    }
    const powerProbes = Array.isArray(obj?.powerProbes) ? obj.powerProbes : [];
    for (const p of powerProbes) {
      if (p?.error) {
        console.log(`[sensors] ${p.name} → error: ${p.error}`);
      } else if (Number.isFinite(p?.max)) {
        console.log(`[sensors] ${p.name} → ${p.max} W (${p.unit || 'W'}, values: ${JSON.stringify(p.values || [])})`);
      } else {
        console.log(`[sensors] ${p.name} → empty`);
      }
    }
  } catch {}
  if (!obj) return null;
  // Pick the first plausible CPU temperature reading.
  let cpu = null, tempSource = null;
  for (const p of (obj.probes || [])) {
    if (Number.isFinite(p?.max) && p.max >= 10 && p.max <= 120) {
      cpu = p.max;
      tempSource = p.name;
      break;
    }
  }
  // Pick the first plausible CPU power reading. RAPL-driven meters
  // typically land between 1 W (deep idle) and 400 W (HEDT max). Reject
  // anything outside that band — most likely a non-CPU power meter
  // (battery / display) that snuck into the counter set.
  let cpuPower = null, powerSource = null;
  for (const p of (obj.powerProbes || [])) {
    if (Number.isFinite(p?.max) && p.max >= 1 && p.max <= 500) {
      cpuPower = p.max;
      powerSource = p.name;
      break;
    }
  }
  if (cpu == null && cpuPower == null) return null;
  return {
    cpu,
    cpuPower,
    gpus: [],
    gpusPower: [],
    source: tempSource || powerSource,
  };
}

// LHM is no longer required. Kept as an exported no-op so the adapter
// interface (callers in main.js + the cross-platform index.js shim)
// doesn't need to learn a new method shape.
function launchSensorBackend() {
  // Intentionally empty — the dashboard now reads thermal zones
  // directly through WMI; no external monitor process to spawn.
}

module.exports = { launchSensorBackend, getNativeFallback, getLastDiagnostics };
