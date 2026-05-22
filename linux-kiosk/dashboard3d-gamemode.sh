#!/usr/bin/env bash
#
# Dashboard3D Game Mode — Steam (desktop client) under a minimal Xorg
# session.
#
# Why no gamescope: every attempt to run Steam Big Picture under
# gamescope on this Optimus laptop hit DRM master / connector errors
# we couldn't dodge cleanly. startx + openbox + steam is the boring,
# reliable Linux gaming kiosk pattern — Xorg owns the display, openbox
# is a tiny stacking WM, Steam opens as a normal window.
#
# Flow:
#   1. Write a one-shot ~/.xinitrc that starts openbox (background)
#      then exec's steam (foreground).
#   2. startx → Xorg sources xinitrc → openbox + steam come up.
#   3. When the user quits Steam (File > Exit), xinitrc exits → Xorg
#      exits → session.sh's loop relaunches the dashboard.
#
# Modes:
#   (default)   regular Game Mode — platform_profile stays at boot
#               default ('balanced' on this build)
#   --quiet     Mobile Game Mode — CPU boost OFF + platform_profile
#               quiet, restored to defaults on exit.

set -u

QUIET=0
while (( $# )); do
  case "$1" in
    --quiet|-q) QUIET=1 ;;
    --app)      shift; ;;   # legacy from the gamescope/bigpicture path
    --app=*)    ;;          # legacy
    '')         ;;
    *)
      echo "Usage: dashboard3d-gamemode [--quiet]" >&2
      exit 2
      ;;
  esac
  shift || break
done

LOG=/tmp/gamemode.log
DIAG=/tmp/gamemode-diag.txt
POWER=/usr/local/bin/dashboard3d-power
XINITRC="$HOME/.xinitrc"
: > "$LOG"

# MangoHud overlay — shows GPU name + FPS in-game so we can prove
# which GPU is actually rendering. Toggle with Shift+Right Shift+F12.
export MANGOHUD=1
export MANGOHUD_CONFIGFILE=/etc/MangoHud.conf

# PRIME render offload. The nvidia driver is loaded (RTD3 keeps the
# dGPU asleep at idle); these env vars tell Steam + every Vulkan/GL
# title it launches to render on the NVIDIA dGPU. Opening the nvidia
# device is exactly what wakes it from D3cold — RTD3 powers it back
# down on its own once the game exits. gamescope still scans out on
# the iGPU panel. No-op on AMD-only / iGPU-only hardware.
if [[ -d /proc/driver/nvidia ]] || [[ -e /dev/nvidiactl ]]; then
  export __NV_PRIME_RENDER_OFFLOAD=1
  export __GLX_VENDOR_LIBRARY_NAME=nvidia
  export __VK_LAYER_NV_optimus=NVIDIA_only
fi

# Mobile Game Mode hooks. Power helper runs via NOPASSWD sudo (see
# /etc/sudoers.d/dashboard3d). EXIT trap restores defaults on every
# exit path so we never strand the system in low-power on the way
# back to the dashboard.
apply_quiet() {
  (( QUIET )) || return 0
  echo ">>> Mobile Game Mode: lowering CPU boost + platform profile ..."
  sudo -n "$POWER" boost off     2>&1 | sed 's/^/    /'
  sudo -n "$POWER" profile quiet 2>&1 | sed 's/^/    /'
}
restore_quiet() {
  (( QUIET )) || return 0
  echo ">>> Mobile Game Mode: restoring platform profile ..."
  # CPU boost stays OFF on exit — the appliance defaults to boost-off
  # (see dashboard3d-prep.sh) and the user manages boost manually via
  # the in-app toggle. Re-enabling it here would contradict the policy.
  sudo -n "$POWER" profile balanced 2>&1 | sed 's/^/    /'
}
trap restore_quiet EXIT

echo
if (( QUIET )); then
  echo "============= Dashboard3D Mobile Game Mode ================"
else
  echo "================== Dashboard3D Game Mode =================="
fi

# Wait for network — Steam first-run downloads its client.
echo "waiting for the network (Steam needs internet on first run) ..."
NET=OFFLINE
for i in $(seq 1 30); do
  if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then NET=online; break; fi
  printf '\r  no internet yet ... %2ds ' "$((i*2))"
  sleep 1
done
printf '\r                              \r'

# Diagnostics — reprinted in the failure report if we fall through.
{
  echo "=== Game Mode diagnostics @ $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "build    : $(cat /etc/dashboard3d-build 2>/dev/null || echo unknown)"
  echo "user     : $(id -un) (uid $(id -u))"
  echo "network  : $NET"
  echo "DRM      : $(ls /dev/dri/ 2>/dev/null | tr '\n' ' ')"
  echo "seat     : seat=${XDG_SEAT:-?} vt=${XDG_VTNR:-?} session=${XDG_SESSION_ID:-?}"
  echo "runtime  : ${XDG_RUNTIME_DIR:-<unset>}"
  echo "Xorg     : $(command -v Xorg 2>/dev/null || echo '!! MISSING')"
  echo "startx   : $(command -v startx 2>/dev/null || echo '!! MISSING')"
  echo "openbox  : $(command -v openbox-session 2>/dev/null || echo '!! MISSING')"
  echo "steam    : $(command -v steam 2>/dev/null || echo '!! MISSING')"
  echo "free RAM : $(free -h 2>/dev/null | awk '/^Mem:/{print $7" of "$2}')"
  echo "steam dir: $(du -sh "$HOME/.local/share/Steam" 2>/dev/null | cut -f1)"
  echo "==========================================================="
} | tee "$DIAG"

if [[ "$NET" == OFFLINE ]]; then
  echo
  echo ">>> WARNING: no internet — Steam's first run will likely fail."
fi
apply_quiet

# Write the one-shot xinitrc. openbox-session runs in the background
# (provides window management). steam runs in the foreground; when the
# user picks File > Exit, steam exits, the script exits, Xorg exits,
# we return to the dashboard.
cat > "$XINITRC" <<'XINITRC_EOF'
#!/usr/bin/env bash
# Auto-generated by dashboard3d-gamemode. Started by `startx`.
openbox-session &
sleep 1
exec steam
XINITRC_EOF
chmod +x "$XINITRC"

echo
echo "Starting Xorg + openbox + Steam (desktop client) ..."
echo "(first run downloads the Steam client — several minutes."
echo " To leave Game Mode: Steam menu > File > Exit.)"
echo

# startx blocks until the X session ends. We pass NO client argument
# so startx auto-discovers ~/.xinitrc (the one we just wrote above) —
# passing the path explicitly makes startx treat it as a client and
# can bypass the proper xinitrc sourcing, which left us hitting the
# system /etc/X11/xinit/xinitrc (xterm/twm not-found errors).
# `-- vt1` ties Xorg to the VT we're already on (auto-login gamer).
startx -- vt1 >>"$LOG" 2>&1
rc=$?
clear 2>/dev/null || true

if (( rc == 0 )); then
  echo "Steam session ended. Returning to the dashboard ..."
  sleep 1
  exit 0
fi

# Failure report — fits one screen, photographable.
echo "############################################################"
echo "## GAME MODE COULD NOT START"
echo "## startx exit=$rc, net=$NET"
echo "############################################################"
cat "$DIAG" 2>/dev/null
echo "--- last 40 lines of /tmp/gamemode.log --------------------"
tail -n 40 "$LOG" 2>/dev/null
echo "-----------------------------------------------------------"
echo
echo ">>> PHOTOGRAPH this whole screen and send it."
echo ">>> Press ENTER to return to the dashboard."
read -r _ || true
exit 0
