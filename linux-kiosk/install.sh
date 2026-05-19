#!/usr/bin/env bash
#
# Dashboard3D appliance installer.
#
# Run as root on a fresh, minimal Arch Linux install that has already had
# `pacman -Syu` run once and has a working network.
#
# It turns the machine into a kiosk that boots straight into Dashboard3D
# running under gamescope, with Steam + gaming support. No desktop, no
# display manager: getty autologin -> gamescope session -> Dashboard3D.
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

# --- config ------------------------------------------------------------------
# The unprivileged user the appliance session runs as. Override with env var.
APPLIANCE_USER="${APPLIANCE_USER:-dash}"
# Where the packaged Linux build of Dashboard3D is expected to live.
APP_DIR="/opt/dashboard3d"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Dashboard3D appliance install (user: $APPLIANCE_USER)"

# --- 1. multilib -------------------------------------------------------------
# Steam and every 32-bit game library live in the [multilib] repo, which Arch
# ships disabled by default.
if ! grep -q '^\[multilib\]' /etc/pacman.conf; then
  echo "==> enabling [multilib] repo"
  printf '\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n' >> /etc/pacman.conf
fi
pacman -Sy --noconfirm

# --- 2. GPU detection --------------------------------------------------------
# The appliance must support whatever GPU the target box has, so detect at
# install time rather than baking in one vendor.
gpu_info="$(lspci -nn | grep -Ei 'vga|3d controller|display' || true)"
echo "==> detected display adapters:"
echo "${gpu_info:-  (none found)}" | sed 's/^/    /'

gpu_pkgs=()
need_headers=0
if grep -qi 'nvidia' <<<"$gpu_info"; then
  echo "==> NVIDIA present -> proprietary driver (dkms)"
  gpu_pkgs+=(nvidia-dkms nvidia-utils lib32-nvidia-utils egl-wayland)
  need_headers=1
fi
if grep -Eqi 'amd|ati|radeon' <<<"$gpu_info"; then
  echo "==> AMD present -> mesa / vulkan-radeon"
  gpu_pkgs+=(vulkan-radeon lib32-vulkan-radeon)
fi
if grep -qi 'intel' <<<"$gpu_info"; then
  echo "==> Intel present -> mesa / vulkan-intel"
  gpu_pkgs+=(vulkan-intel lib32-vulkan-intel)
fi
if [[ ${#gpu_pkgs[@]} -eq 0 ]]; then
  echo "!! no known GPU vendor detected; installing mesa only." >&2
fi
(( need_headers )) && gpu_pkgs+=(linux-headers)

# --- 3. package install ------------------------------------------------------
base_pkgs=(
  # compositor / session
  gamescope
  mesa lib32-mesa
  vulkan-icd-loader lib32-vulkan-icd-loader
  # audio
  pipewire pipewire-pulse pipewire-alsa lib32-pipewire wireplumber
  # network
  networkmanager
  # gaming
  steam gamemode lib32-gamemode mangohud lib32-mangohud
  # misc
  noto-fonts ttf-dejavu
)
echo "==> installing packages"
pacman -S --needed --noconfirm "${base_pkgs[@]}" "${gpu_pkgs[@]}"

# --- 4. appliance user -------------------------------------------------------
# Groups: video+render = direct DRM access for gamescope; input = evdev;
# audio = pipewire; gamemode = realtime priority for games.
if ! id "$APPLIANCE_USER" &>/dev/null; then
  echo "==> creating user '$APPLIANCE_USER'"
  useradd -m -G video,render,input,audio,gamemode "$APPLIANCE_USER"
  passwd -d "$APPLIANCE_USER"   # no password; box is a single-purpose appliance
else
  usermod -aG video,render,input,audio,gamemode "$APPLIANCE_USER"
fi

# --- 5. install session files ------------------------------------------------
echo "==> installing session launcher + autostart"
install -Dm755 "$REPO_DIR/dashboard3d-session.sh" /usr/local/bin/dashboard3d-session
install -Dm644 "$REPO_DIR/kiosk.sh"               /etc/profile.d/dashboard3d-kiosk.sh

# getty autologin drop-in: tty1 logs the appliance user straight in.
install -Dm644 "$REPO_DIR/getty-autologin.conf" \
  /etc/systemd/system/getty@tty1.service.d/override.conf
# The drop-in references the user by name; patch in the configured value.
sed -i "s/@APPLIANCE_USER@/$APPLIANCE_USER/g" \
  /etc/systemd/system/getty@tty1.service.d/override.conf

# --- 6. services + boot target ----------------------------------------------
# No display manager and no graphical.target: a plain multi-user boot plus a
# getty autologin on tty1 is the whole session chain.
systemctl enable NetworkManager
systemctl set-default multi-user.target
systemctl daemon-reload

echo
echo "==> done."
echo "   Place the packaged Linux build of Dashboard3D at: $APP_DIR/dashboard3d"
echo "   (build it with 'npm run package:linux', then copy the output there.)"
echo "   Reboot to land in the appliance session."
