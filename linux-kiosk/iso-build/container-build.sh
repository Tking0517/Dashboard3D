#!/usr/bin/env bash
#
# Assembles the Dashboard3D appliance archiso profile and builds the ISO.
#
# Runs INSIDE the privileged Arch container (see Dockerfile / build-iso.sh)
# with the repo bind-mounted at /repo. Can also be run directly on any Arch
# box that has `archiso` installed and the repo at /repo.
#
# Strategy: start from the stock `releng` profile shipped by archiso, then
# overlay the appliance bits. Deriving from releng (rather than committing a
# whole profile) keeps the bootloader configs current with the archiso
# version and keeps the repo to just the delta.
#
set -euo pipefail

# Repo location. Defaults to /repo (the Docker bind-mount path); override
# with the REPO env var when running directly on an Arch box / Arch WSL.
REPO="${REPO:-/repo}"
ISO_DIR="$REPO/linux-kiosk/iso-build"
OVERLAY="$ISO_DIR/overlay"
APP_SRC="$REPO/dashboard3d-linux-x64"
RELENG=/usr/share/archiso/configs/releng
PROFILE=/tmp/profile
WORK=/tmp/work
OUT="$ISO_DIR/out"

# --- preflight ---------------------------------------------------------------
[[ -d "$RELENG" ]] || { echo "ERROR: archiso releng profile not found at $RELENG"; exit 1; }
if [[ ! -f "$APP_SRC/dashboard3d" ]]; then
  echo "ERROR: Linux build of Dashboard3D not found at $APP_SRC/dashboard3d" >&2
  echo "       Build it first: linux-kiosk/build-dashboard.sh (or npm run package:linux)." >&2
  exit 1
fi

# --- 1. fresh copy of the releng profile ------------------------------------
echo "==> copying stock releng profile"
rm -rf "$PROFILE"
cp -a "$RELENG" "$PROFILE"

# --- 2. enable [multilib] (Steam + 32-bit game libraries) -------------------
if ! grep -q '^\[multilib\]' "$PROFILE/pacman.conf"; then
  echo "==> enabling [multilib] in profile pacman.conf"
  cat >> "$PROFILE/pacman.conf" <<'EOF'

[multilib]
Include = /etc/pacman.d/mirrorlist
EOF
fi

# --- 3. append appliance packages -------------------------------------------
echo "==> adding appliance packages to packages.x86_64"
printf '\n' >> "$PROFILE/packages.x86_64"
# Strip comments / blank lines from packages.add before appending.
grep -vE '^\s*(#|$)' "$OVERLAY/packages.add" >> "$PROFILE/packages.x86_64"

# --- 4. airootfs overlay (units, kiosk config) ------------------------------
echo "==> applying airootfs overlay"
cp -aT "$OVERLAY/airootfs" "$PROFILE/airootfs"

# --- 5. the app itself ------------------------------------------------------
echo "==> installing Dashboard3D into /opt/dashboard3d"
mkdir -p "$PROFILE/airootfs/opt/dashboard3d"
cp -aT "$APP_SRC" "$PROFILE/airootfs/opt/dashboard3d"

# yt-client is a `file:../yt-client` dependency. The Linux app build only
# has the Dashboard3D folder — not its sibling — so npm cannot resolve it
# and node_modules/yt-client ends up missing. Copy it in directly here.
YTC="$REPO/../yt-client"
APP_NM="$PROFILE/airootfs/opt/dashboard3d/resources/app/node_modules"
if [[ -d "$YTC" ]]; then
  echo "==> installing yt-client into node_modules"
  rm -rf "$APP_NM/yt-client"
  cp -aT "$YTC" "$APP_NM/yt-client"
else
  echo "ERROR: yt-client source not found at $YTC" >&2
  exit 1
fi

echo "==> installing session launcher"
install -Dm755 "$REPO/linux-kiosk/dashboard3d-session.sh" \
  "$PROFILE/airootfs/usr/local/bin/dashboard3d-session"

echo "==> installing Game Mode launcher"
install -Dm755 "$REPO/linux-kiosk/dashboard3d-gamemode.sh" \
  "$PROFILE/airootfs/usr/local/bin/dashboard3d-gamemode"

echo "==> installing disk installer"
install -Dm755 "$REPO/linux-kiosk/dashboard3d-install.sh" \
  "$PROFILE/airootfs/usr/local/bin/dashboard3d-install"

echo "==> installing hardware-prep service"
install -Dm755 "$REPO/linux-kiosk/dashboard3d-prep.sh" \
  "$PROFILE/airootfs/usr/local/bin/dashboard3d-prep"
install -Dm644 "$REPO/linux-kiosk/dashboard3d-prep.service" \
  "$PROFILE/airootfs/etc/systemd/system/dashboard3d-prep.service"

echo "==> installing power helper (CPU boost + ACPI platform_profile)"
install -Dm755 "$REPO/linux-kiosk/dashboard3d-power.sh" \
  "$PROFILE/airootfs/usr/local/bin/dashboard3d-power"

echo "==> installing media-key daemon (XF86Audio* -> wpctl)"
install -Dm755 "$REPO/linux-kiosk/dashboard3d-media-keys.py" \
  "$PROFILE/airootfs/usr/local/bin/dashboard3d-media-keys"
install -Dm644 "$REPO/linux-kiosk/dashboard3d-media-keys.service" \
  "$PROFILE/airootfs/etc/systemd/user/dashboard3d-media-keys.service"
# Enable the user service for every user via the user-level
# default.target.wants. systemctl --user --global enable does the same
# thing as creating this symlink, but the symlink is the only thing that
# survives mkarchiso reliably.
mkdir -p "$PROFILE/airootfs/etc/systemd/user/default.target.wants"
ln -sf /etc/systemd/user/dashboard3d-media-keys.service \
       "$PROFILE/airootfs/etc/systemd/user/default.target.wants/dashboard3d-media-keys.service"

# A Windows->container bind mount can drop the executable bit; set it
# explicitly on everything that must run.
chmod 755 "$PROFILE/airootfs/usr/local/bin/dashboard3d-session"
chmod 755 "$PROFILE/airootfs/usr/local/bin/dashboard3d-gamemode"
chmod 755 "$PROFILE/airootfs/usr/local/bin/dashboard3d-install"
chmod 755 "$PROFILE/airootfs/usr/local/bin/dashboard3d-prep"
chmod 755 "$PROFILE/airootfs/usr/local/bin/dashboard3d-power"
chmod 755 "$PROFILE/airootfs/usr/local/bin/dashboard3d-media-keys"
chmod 755 "$PROFILE/airootfs/opt/dashboard3d/dashboard3d"

# --- 6. enable services -----------------------------------------------------
# archiso has no `systemctl enable` step; services are enabled by creating
# the .wants symlinks the enable would have made.
echo "==> enabling NetworkManager + the hardware-prep service"
WANTS="$PROFILE/airootfs/etc/systemd/system/multi-user.target.wants"
mkdir -p "$WANTS"
ln -sf /usr/lib/systemd/system/NetworkManager.service "$WANTS/NetworkManager.service"
ln -sf /etc/systemd/system/dashboard3d-prep.service "$WANTS/dashboard3d-prep.service"
# releng enables systemd-networkd; drop it so it doesn't fight
# NetworkManager over the interfaces. systemd-resolved is KEPT — it only
# provides DNS (no interface conflict) and NetworkManager integrates with
# it; without it /etc/resolv.conf dangles and name lookup fails.
rm -f "$WANTS/systemd-networkd.service" \
      "$PROFILE/airootfs/etc/systemd/system/sockets.target.wants/systemd-networkd.socket"

# The appliance session runs as the unprivileged 'gamer' user, auto-
# logged-in on tty1, so gamescope + the dashboard + Steam share one uid
# (Steam can then reach the display). gamer's login shell is the session
# script (set in the sysusers .conf; gamer is created at first boot).
# tty2 autologins root for a no-password maintenance shell.
echo "==> setting up tty autologin (gamer on tty1, root on tty2)"
mkdir -p "$PROFILE/airootfs/etc/systemd/system/getty@tty1.service.d" \
         "$PROFILE/airootfs/etc/systemd/system/getty@tty2.service.d"
cat > "$PROFILE/airootfs/etc/systemd/system/getty@tty1.service.d/autologin.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=-/usr/bin/agetty --autologin gamer --noclear %I $TERM
EOF
cat > "$PROFILE/airootfs/etc/systemd/system/getty@tty2.service.d/autologin.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=-/usr/bin/agetty --autologin root --noclear %I $TERM
EOF

# Let 'gamer' run the disk installer + the power helper as root
# without a password. The power helper is invoked by Mobile Game Mode
# to toggle CPU boost and the ACPI platform_profile; both /sys writes
# are root-only. Scope is narrow on purpose — both binaries accept only
# a small whitelist of arg shapes (see their headers).
echo "==> installing the sudoers rule for the installer + power helper"
install -Dm440 /dev/stdin "$PROFILE/airootfs/etc/sudoers.d/dashboard3d" <<'EOF'
gamer ALL=(root) NOPASSWD: /usr/local/bin/dashboard3d-install
gamer ALL=(root) NOPASSWD: /usr/local/bin/dashboard3d-power
EOF

# Stamp a build id so the running appliance can be matched to a build.
echo "==> stamping build id"
date '+%Y-%m-%d %H:%M' > "$PROFILE/airootfs/etc/dashboard3d-build"

# --- 7. branding ------------------------------------------------------------
echo "==> branding profiledef.sh"
sed -i \
  -e 's/^iso_name=.*/iso_name="dashboard3d"/' \
  -e 's/^iso_label=.*/iso_label="DASH3D"/' \
  -e 's/^iso_publisher=.*/iso_publisher="Dashboard3D <appliance>"/' \
  -e 's/^iso_application=.*/iso_application="Dashboard3D Appliance"/' \
  "$PROFILE/profiledef.sh"

# Guarantee executable bits survive into the squashfs. mkarchiso applies the
# file_permissions array regardless of how the airootfs files were copied.
cat >> "$PROFILE/profiledef.sh" <<'EOF'
file_permissions+=(
  ["/opt/dashboard3d/dashboard3d"]="0:0:0755"
  ["/usr/local/bin/dashboard3d-session"]="0:0:0755"
  ["/usr/local/bin/dashboard3d-gamemode"]="0:0:0755"
  ["/usr/local/bin/dashboard3d-install"]="0:0:0755"
  ["/usr/local/bin/dashboard3d-prep"]="0:0:0755"
  ["/usr/local/bin/dashboard3d-power"]="0:0:0755"
  ["/usr/local/bin/dashboard3d-media-keys"]="0:0:0755"
  ["/etc/sudoers.d/dashboard3d"]="0:0:0440"
)
EOF

# Work around the amdgpu DMCUB display-engine error seen on RENOIR APU
# laptops: disable scatter-gather display and PSR. Appended to the kernel
# command line in every boot config (syslinux/BIOS, systemd-boot, GRUB),
# which all carry the archisobasedir= token.
echo "==> adding amdgpu DMCUB workaround kernel parameters"
AMDGPU_PARAMS="amdgpu.sg_display=0 amdgpu.dcdebugmask=0x10"
grep -rl 'archisobasedir=' "$PROFILE/syslinux" "$PROFILE/efiboot" "$PROFILE/grub" 2>/dev/null \
  | while read -r f; do
      sed -i "/archisobasedir=/ s#\$# $AMDGPU_PARAMS#" "$f"
      echo "   patched: $f"
    done

# --- 8. build ---------------------------------------------------------------
echo "==> running mkarchiso — this pulls all packages and can take a while"
mkdir -p "$OUT"
rm -rf "$WORK"
mkarchiso -v -w "$WORK" -o "$OUT" "$PROFILE"

echo
echo "==> ISO build complete:"
ls -lh "$OUT"/*.iso
