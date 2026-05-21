#!/usr/bin/env bash
#
# Dashboard3D power helper — root-side knobs for Mobile Game Mode.
#
# Two responsibilities, both writing to /sys files that require root:
#   1. CPU turbo/boost on or off
#   2. ACPI platform_profile (quiet / balanced / performance)
#
# Invoked via NOPASSWD sudo by dashboard3d-gamemode (see the rule in
# /etc/sudoers.d/dashboard3d). Kept narrowly-scoped — accepts only the
# arg shapes below — so the sudoers rule grants a small, predictable
# surface instead of a blanket "write anything to /sys" permission.
#
# Vendor handling:
#   AMD:   /sys/devices/system/cpu/cpufreq/boost            (1 = boost on,  0 = off)
#   Intel: /sys/devices/system/cpu/intel_pstate/no_turbo    (0 = boost on,  1 = off — INVERTED)
# The two paths are exclusive in practice; whichever exists is what the
# running kernel scheduler is using. We try AMD first, fall back to
# Intel. Silent no-op if neither is present (e.g. ARM).

set -u

usage() {
  cat >&2 <<USAGE
Usage:
  dashboard3d-power boost on|off
  dashboard3d-power profile quiet|balanced|performance
USAGE
  exit 2
}

ACTION="${1:-}"
VAL="${2:-}"

set_boost() {
  local on intel
  case "$1" in
    on)  on=1; intel=0 ;;
    off) on=0; intel=1 ;;
    *) usage ;;
  esac
  if [[ -w /sys/devices/system/cpu/cpufreq/boost ]]; then
    echo "$on" > /sys/devices/system/cpu/cpufreq/boost \
      && echo "AMD cpufreq boost -> $1" \
      || echo "WARN: write to cpufreq/boost failed"
  elif [[ -w /sys/devices/system/cpu/intel_pstate/no_turbo ]]; then
    echo "$intel" > /sys/devices/system/cpu/intel_pstate/no_turbo \
      && echo "Intel turbo -> $1" \
      || echo "WARN: write to intel_pstate/no_turbo failed"
  else
    echo "INFO: no CPU boost sysfs found (kernel scheduler doesn't expose one)"
  fi
}

set_profile() {
  local name="$1"
  if [[ -z "$name" ]]; then usage; fi
  if [[ ! -w /sys/firmware/acpi/platform_profile ]]; then
    echo "INFO: /sys/firmware/acpi/platform_profile not writable; firmware doesn't expose ACPI profiles"
    return 0
  fi
  # Vendor-vendor naming varies. Try the asked-for name, then graceful
  # neighbours — never silently use 'performance' when the user asked
  # for 'quiet' or vice-versa.
  local candidates=()
  case "$name" in
    quiet|low-power)   candidates=(low-power quiet balanced) ;;
    balanced)          candidates=(balanced) ;;
    performance)       candidates=(performance balanced) ;;
    *)                 candidates=("$name") ;;
  esac
  local choices prof
  choices="$(cat /sys/firmware/acpi/platform_profile_choices 2>/dev/null)"
  for prof in "${candidates[@]}"; do
    if echo " $choices " | grep -qw "$prof"; then
      if echo "$prof" > /sys/firmware/acpi/platform_profile 2>/dev/null; then
        echo "platform_profile -> $prof"
        return 0
      fi
    fi
  done
  echo "WARN: no matching platform_profile (asked '$name'; firmware offers '${choices:-<none>}')"
}

case "$ACTION" in
  boost)   set_boost   "$VAL" ;;
  profile) set_profile "$VAL" ;;
  *)       usage ;;
esac
