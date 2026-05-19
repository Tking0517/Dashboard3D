#!/usr/bin/env bash
#
# Dashboard3D appliance — hardware prep.
#
# Run ONCE at boot, as root, by dashboard3d-prep.service, BEFORE the
# unprivileged 'gamer' session starts. Does the things that need root:
# load the GPU driver, set the thermal profile + fan curve, and power
# down the idle NVIDIA dGPU.
#
# The appliance session itself runs as the unprivileged 'gamer' user (so
# gamescope, the dashboard and Steam share one uid and Steam can reach
# the display) — which is exactly why this root-only work is split out
# into a boot service.

set -u
LOG=/tmp/hw-diag.txt
GAME_USER=gamer

# The gamer session needs its home to exist and be owned by it.
mkdir -p "/home/$GAME_USER"
chown 1000:1000 "/home/$GAME_USER" 2>/dev/null || true

# The dashboard app runs as 'gamer' and writes its config/cache under
# /opt/dashboard3d — make the app tree gamer-owned (once, on first boot).
if [[ -d /opt/dashboard3d ]] \
   && [[ "$(stat -c %u /opt/dashboard3d 2>/dev/null)" != 1000 ]]; then
  chown -R 1000:1000 /opt/dashboard3d 2>/dev/null || true
fi

# amdgpu drives the laptop panel. On the live ISO it is blacklisted (the
# archiso initramfs lacks GPU firmware); load it now. On an installed
# system it is already loaded — modprobe is then a harmless no-op.
modprobe amdgpu 2>/dev/null
for _ in $(seq 1 75); do
  compgen -G "/dev/dri/card*" >/dev/null && break
  sleep 0.2
done

# Aggressive-but-quiet fan curve. temps °C, pwm 0-255.
FAN_TEMPS=(40 55 65 72 80 87 92 97)
FAN_PWMS=(0 45 90 140 195 240 255 255)

# performance platform profile + the ASUS turbo throttle policy.
apply_profiles() {
  local applied="" prof p
  if [[ -w /sys/firmware/acpi/platform_profile ]]; then
    for prof in performance balanced; do
      grep -qw "$prof" /sys/firmware/acpi/platform_profile_choices 2>/dev/null \
        && echo "$prof" > /sys/firmware/acpi/platform_profile 2>/dev/null \
        && { applied="platform_profile=$prof"; break; }
    done
  fi
  for p in /sys/devices/platform/asus-nb-wmi/throttle_thermal_policy \
           /sys/devices/platform/asus-wmi/throttle_thermal_policy; do
    [[ -w "$p" ]] && echo 1 > "$p" 2>/dev/null && applied="$applied throttle=1"
  done
  echo "${applied:-<none>}"
}

# Write the 8-point curve, enable it, force any plain writable pwmN.
apply_fan_curve() {
  local hw fan i
  for hw in /sys/class/hwmon/hwmon*; do
    [[ -e "$hw/pwm1_auto_point1_pwm" || -e "$hw/pwm1" ]] || continue
    for fan in 1 2 3; do
      if [[ -e "$hw/pwm${fan}_auto_point1_pwm" ]]; then
        for i in $(seq 0 7); do
          echo "${FAN_TEMPS[$i]}" > "$hw/pwm${fan}_auto_point$((i+1))_temp" 2>/dev/null
          echo "${FAN_PWMS[$i]}"  > "$hw/pwm${fan}_auto_point$((i+1))_pwm"  2>/dev/null
        done
      fi
      echo 1 > "$hw/pwm${fan}_enable" 2>/dev/null
      [[ -w "$hw/pwm${fan}" ]] && echo 255 > "$hw/pwm${fan}" 2>/dev/null
    done
  done
}

# The undriven NVIDIA dGPU idles hot; enable PCI runtime PM + D3cold.
power_down_dgpu() {
  local d ven cls res=""
  for d in /sys/bus/pci/devices/*; do
    ven=$(cat "$d/vendor" 2>/dev/null)
    cls=$(cat "$d/class" 2>/dev/null)
    [[ "$ven" == "0x10de" ]] || continue
    [[ "$cls" == 0x0300* || "$cls" == 0x0302* ]] || continue
    [[ -e "$d/d3cold_allowed" ]] && echo 1 > "$d/d3cold_allowed" 2>/dev/null
    echo auto > "$d/power/control" 2>/dev/null
    sleep 3
    res="${d##*/} -> $(cat "$d/power/runtime_status" 2>/dev/null)"
  done
  echo "${res:-<no NVIDIA dGPU found>}"
}

{
  echo "=== Dashboard3D hardware prep @ $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "DRM devices : $(ls /dev/dri/ 2>/dev/null | tr '\n' ' ')"
  echo "profiles    : $(apply_profiles)"
  echo "nvidia dGPU : $(power_down_dgpu)"
  apply_fan_curve
  echo "fan curve   : applied"
  echo "=== done ==="
} > "$LOG" 2>&1

exit 0
