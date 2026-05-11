// Linux sensors backend.
//
// `getNativeFallback()` returns the same shape as the Windows backend:
//   { cpu, cpuPower, gpus: number[], gpusPower: number[] } | null
// where cpu / cpuPower are scalars and gpus / gpusPower are arrays
// indexed by GPU (parallel to the cross-platform si.graphics() output).
//
// Sources walked here:
//   /sys/class/hwmon/hwmon*/
//     Each hwmon entry has a `name` file (k10temp, coretemp, nct6798,
//     amdgpu, …) and a set of tempN_input / fanN_input / powerN_input
//     files (millidegrees, RPM, microwatts respectively, plus optional
//     tempN_label / fanN_label files for human-readable names).
//   /sys/class/drm/card*/device/hwmon/   — same shape, scoped to GPUs.
//
// We're permissive: any failure on a single file just skips it, so a
// missing label or a permission-denied power file doesn't kill the
// whole read. Function never throws.

const fs = require('fs');
const path = require('path');

const HWMON_ROOT = '/sys/class/hwmon';

function readTrim(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); }
  catch { return null; }
}

function readNum(p, scale = 1) {
  const s = readTrim(p);
  if (s == null) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n / scale;
}

// One hwmon directory → { name, temps: [{label, value}], fans: [...], powers: [...] }
function readHwmonEntry(dir) {
  const name = readTrim(path.join(dir, 'name'));
  if (!name) return null;
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  const temps  = [];
  const fans   = [];
  const powers = [];
  for (const f of files) {
    const m = /^(temp|fan|power)(\d+)_(input|label)$/.exec(f);
    if (!m) continue;
    if (m[3] !== 'input') continue;
    const idx = m[2];
    if (m[1] === 'temp') {
      const v = readNum(path.join(dir, f), 1000);  // millidegrees → °C
      if (v != null) temps.push({ label: readTrim(path.join(dir, `temp${idx}_label`)) || '', value: v });
    } else if (m[1] === 'fan') {
      const v = readNum(path.join(dir, f));  // RPM
      if (v != null) fans.push({ label: readTrim(path.join(dir, `fan${idx}_label`)) || '', value: v });
    } else if (m[1] === 'power') {
      const v = readNum(path.join(dir, f), 1_000_000);  // microwatts → W
      if (v != null) powers.push({ label: readTrim(path.join(dir, `power${idx}_label`)) || '', value: v });
    }
  }
  return { name, dir, temps, fans, powers };
}

function listHwmon() {
  let entries;
  try { entries = fs.readdirSync(HWMON_ROOT); }
  catch { return []; }
  return entries
    .map((d) => readHwmonEntry(path.join(HWMON_ROOT, d)))
    .filter(Boolean);
}

// Heuristic match for which hwmon entry belongs to the CPU. Most boxes
// have one of: coretemp (Intel), k10temp / k8temp / zenpower (AMD),
// or a generic "Package" label. We pick the first hit so heavy-handed
// motherboard chips (nct6798, it8728, etc.) don't shadow it.
const CPU_NAMES = /^(coretemp|k10temp|k8temp|zenpower|amd_energy|fam15h_power)$/i;

// AMDGPU exposes itself via /sys/class/drm/card*/device/hwmon, but those
// hwmon dirs ALSO show up under /sys/class/hwmon — and the entry name
// is just 'amdgpu'. Same for Intel via 'i915'. Use the name match
// rather than walking the drm tree separately.
const GPU_NAMES = /^(amdgpu|i915|nouveau|radeon)$/i;

function pickCpuTemp(entry) {
  // Prefer a labelled "Package id 0" / "Tctl" / "Tdie" if present,
  // otherwise take the first temp reading the chip exposes. The kernel
  // orders sensors with the most useful one first on most chips.
  const labelled = entry.temps.find((t) => /package|tctl|tdie/i.test(t.label));
  return labelled?.value ?? entry.temps[0]?.value ?? null;
}

function pickCpuPower(entry) {
  // 'package' / 'core' powers are the useful ones; otherwise first.
  const labelled = entry.powers.find((p) => /package|core/i.test(p.label));
  return labelled?.value ?? entry.powers[0]?.value ?? null;
}

function pickGpuTemp(entry) {
  // edge / junction / mem temps all exist on AMD; junction is the
  // hottest die-internal temp and matches what GPU monitoring apps show.
  // Fall back to edge then first.
  const j = entry.temps.find((t) => /junction|hotspot/i.test(t.label));
  if (j) return j.value;
  const e = entry.temps.find((t) => /edge|core|gpu/i.test(t.label));
  if (e) return e.value;
  return entry.temps[0]?.value ?? null;
}

function pickGpuPower(entry) {
  // average power if labelled, otherwise first.
  const avg = entry.powers.find((p) => /average|input/i.test(p.label));
  return avg?.value ?? entry.powers[0]?.value ?? null;
}

async function getNativeFallback() {
  const entries = listHwmon();
  if (!entries.length) return null;

  const out = { cpu: null, cpuPower: null, gpus: [], gpusPower: [] };

  const cpuEntry = entries.find((e) => CPU_NAMES.test(e.name));
  if (cpuEntry) {
    out.cpu = pickCpuTemp(cpuEntry);
    out.cpuPower = pickCpuPower(cpuEntry);
  }

  const gpuEntries = entries.filter((e) => GPU_NAMES.test(e.name));
  for (const e of gpuEntries) {
    out.gpus.push(pickGpuTemp(e));
    out.gpusPower.push(pickGpuPower(e));
  }

  if (out.cpu == null && out.cpuPower == null && out.gpus.length === 0) {
    return null;
  }
  return out;
}

function launchSensorBackend() {
  // hwmon is a kernel interface — always present, no daemon to start.
}

module.exports = { launchSensorBackend, getNativeFallback };
