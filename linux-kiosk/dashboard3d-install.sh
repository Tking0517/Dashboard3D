#!/usr/bin/env bash
#
# Dashboard3D appliance installer.
#
# Run from the live USB (installed at /usr/local/bin/dashboard3d-install,
# offered by the 'i' key at the boot prompt). Installs the appliance as a
# real, persistent Arch system onto an internal drive.
#
# DESTRUCTIVE to the chosen target disk. The disk that carries the Windows
# boot manager (EFI/Microsoft/Boot/bootmgfw.efi) is hard-protected and
# cannot be selected.
#
# Why a real install (not the live USB): the live image runs in RAM, so
# Steam re-downloads its whole client every boot and nothing persists.

set -u

MSR_GUID="e3c9e316-0b5c-4db8-817d-f92df00215ae"
ESP_GUID="c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
MNT=/mnt/d3d-install

# drain buffered keystrokes so a stray Enter cannot skip a prompt
drain() { read -rs -t 1 -N 100000 _drain 2>/dev/null || true; }
pause() { drain; echo; read -r -p ">>> Press ENTER to return to the dashboard. " _ || true; }
say()   { echo "==> $*"; }

die() {
  echo
  echo "############################################################"
  echo "## INSTALL STOPPED"
  echo "##   $*"
  echo "############################################################"
  echo "## Nothing was changed unless a step above says otherwise."
  pause
  exit 1
}

[[ $EUID -eq 0 ]] || die "must run as root"

echo
echo "############################################################"
echo "##         Dashboard3D appliance — disk installer         ##"
echo "############################################################"
echo
echo "Installs Dashboard3D onto an INTERNAL drive as a real OS."
echo "The disk you pick is ERASED. The Windows boot disk is detected"
echo "and cannot be selected."
echo

# --- network (pacstrap downloads ~2 GB) ------------------------------------
while true; do
  say "checking the network"
  online=0
  for i in $(seq 1 20); do
    if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then online=1; break; fi
    printf '\r  waiting for internet ... %2ds ' "$((i*2))"
    sleep 1
  done
  printf '\r                                  \r'
  (( online )) && { say "network is up"; break; }
  echo "!! no internet — the install needs it to download packages."
  echo "   Plug in Ethernet, then:"
  drain
  read -r -p "   press R to retry, or Q to cancel> " ans || true
  [[ "${ans:-}" == [Qq] ]] && { echo "cancelled."; exit 0; }
done

# --- discover disks --------------------------------------------------------
# role: BOOT = carries the Windows boot manager (protected)
#       DATA = has NTFS / a Microsoft Reserved partition (erasable, warn)
#       FREE = nothing of the sort
disk_role() {
  local disk="$1" part pt fst m role=FREE
  while read -r part; do
    [[ -n "$part" ]] || continue
    pt=$(lsblk -dno PARTTYPE "$part" 2>/dev/null | tr 'A-Z' 'a-z')
    fst=$(lsblk -dno FSTYPE "$part" 2>/dev/null)
    [[ "$fst" == ntfs && "$role" == FREE ]] && role=DATA
    [[ "$pt" == "$MSR_GUID" && "$role" == FREE ]] && role=DATA
    if [[ "$pt" == "$ESP_GUID" ]]; then
      m=$(mktemp -d)
      if mount -o ro "$part" "$m" 2>/dev/null; then
        if [[ -e "$m/EFI/Microsoft/Boot/bootmgfw.efi" \
           || -e "$m/efi/microsoft/boot/bootmgfw.efi" ]]; then
          role=BOOT
        fi
        umount "$m" 2>/dev/null || true
      fi
      rmdir "$m" 2>/dev/null || true
    fi
  done < <(lsblk -lnpo NAME,TYPE "$disk" | awk '$2=="part"{print $1}')
  echo "$role"
}

mapfile -t DISKS < <(lsblk -dnpo NAME,TYPE | awk '$2=="disk"{print $1}')
[[ ${#DISKS[@]} -gt 0 ]] || die "no disks found"

declare -A ROLE
for d in "${DISKS[@]}"; do ROLE[$d]=$(disk_role "$d"); done

# --- pick the target -------------------------------------------------------
TARGET=""
while true; do
  echo
  echo "Disks in this machine:"
  echo
  n=0
  for d in "${DISKS[@]}"; do
    n=$(( n + 1 ))
    size=$(lsblk -dno SIZE "$d")
    model=$(lsblk -dno MODEL "$d" | sed 's/  *$//')
    case "${ROLE[$d]}" in
      BOOT) tag=">> WINDOWS boot disk — PROTECTED, cannot pick" ;;
      DATA) tag=">> has existing data — will be ERASED if picked" ;;
      *)    tag=">> empty / no OS — ready to use" ;;
    esac
    printf '  [%d]  %-14s %8s   %s\n' "$n" "$d" "$size" "$model"
    echo   "        $tag"
    lsblk -no NAME,SIZE,FSTYPE,LABEL "$d" | sed 's/^/          /'
    echo
  done
  drain
  read -r -p "Enter the NUMBER of the disk to install onto (Q to cancel)> " sel || true
  [[ "${sel:-}" == [Qq] ]] && { echo "cancelled — nothing changed."; exit 0; }
  [[ "${sel:-}" =~ ^[0-9]+$ ]] || { echo; echo "!! '$sel' is not a number — try again."; continue; }
  (( sel >= 1 && sel <= ${#DISKS[@]} )) || { echo; echo "!! number out of range — try again."; continue; }
  TARGET="${DISKS[$(( sel - 1 ))]}"
  if [[ "${ROLE[$TARGET]}" == BOOT ]]; then
    echo
    echo "!! $TARGET is the WINDOWS boot disk — it is protected. Pick the other disk."
    TARGET=""
    continue
  fi
  break
done

echo
echo "############################################################"
echo "##  TARGET: $TARGET   (everything on it will be destroyed)"
lsblk -no NAME,SIZE,FSTYPE,LABEL "$TARGET" | sed 's/^/##    /'
echo "############################################################"
drain
read -r -p "Type  ERASE  (capitals) to wipe this disk and install> " confirm || true
[[ "${confirm:-}" == "ERASE" ]] || die "not confirmed (you typed '${confirm:-}') — nothing changed"

# --- partition + format ----------------------------------------------------
if [[ "$TARGET" == *nvme* || "$TARGET" == *mmcblk* ]]; then
  ESP="${TARGET}p1"; ROOT="${TARGET}p2"
else
  ESP="${TARGET}1";  ROOT="${TARGET}2"
fi

say "wiping and partitioning $TARGET"
umount -R "$MNT" 2>/dev/null || true
swapoff -a 2>/dev/null || true
wipefs -a "$TARGET" >/dev/null 2>&1 || true
sgdisk --zap-all "$TARGET" >/dev/null 2>&1 || true
sgdisk -n1:0:+1GiB -t1:ef00 -c1:D3D-EFI \
       -n2:0:0     -t2:8300 -c2:d3d-root "$TARGET" >/dev/null \
  || die "partitioning failed"
partprobe "$TARGET" 2>/dev/null || true
sleep 2

say "formatting"
mkfs.fat -F32 -n D3D-EFI "$ESP"  >/dev/null 2>&1 || die "formatting the EFI partition failed"
mkfs.ext4 -F -L d3d-root "$ROOT" >/dev/null 2>&1 || die "formatting the root partition failed"

say "mounting"
mkdir -p "$MNT"
mount "$ROOT" "$MNT"     || die "could not mount the new root partition"
mkdir -p "$MNT/boot"
mount "$ESP" "$MNT/boot" || die "could not mount the new EFI partition"

# --- base system -----------------------------------------------------------
say "collecting the package set from this live system"
mapfile -t PKGS < <(pacman -Qqe | grep -vx archiso)
for must in base linux linux-firmware mkinitcpio amd-ucode networkmanager; do
  printf '%s\n' "${PKGS[@]}" | grep -qx "$must" || PKGS+=("$must")
done
# DNS check — the live system can have a dangling resolv.conf symlink, so
# ping-by-IP works but mirror HOSTNAMES will not resolve and pacstrap fails
# every time. Install a working resolv.conf if name lookup is dead.
ensure_dns() {
  getent hosts archlinux.org >/dev/null 2>&1 && return 0
  say "DNS name lookup is broken — installing a working resolv.conf"
  rm -f /etc/resolv.conf
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
  getent hosts archlinux.org >/dev/null 2>&1
}
ensure_dns || say "DNS still not resolving — continuing, pacstrap may fail"

# Steam and every lib32-* package live in the [multilib] repo, which the
# live system's pacman.conf does NOT enable. pacstrap uses THIS pacman.conf,
# so without this they all fail as 'target not found'.
if ! grep -q '^\[multilib\]' /etc/pacman.conf; then
  say "enabling the [multilib] repo (Steam + 32-bit libraries)"
  printf '\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n' >> /etc/pacman.conf
fi
pacman -Sy >/dev/null 2>&1 || true

say "installing ${#PKGS[@]} packages with pacstrap — this takes several minutes"
# pacstrap re-run resumes (installed packages are skipped), so a flaky
# connection just costs more attempts, not a restart.
PLOG=/tmp/pacstrap.log
pac_ok=0
for attempt in 1 2 3 4 5 6; do
  say "pacstrap attempt $attempt of 6"
  pacstrap -K "$MNT" "${PKGS[@]}" 2>&1 | tee "$PLOG"
  if [[ ${PIPESTATUS[0]} -eq 0 ]]; then pac_ok=1; break; fi
  say "attempt $attempt failed — rechecking the connection ..."
  ensure_dns || true
  for i in $(seq 1 30); do ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && break; sleep 1; done
  sleep 3
done
if (( ! pac_ok )); then
  echo
  echo "--- network state -----------------------------------------"
  echo "resolv.conf:"; sed 's/^/   /' /etc/resolv.conf 2>&1
  ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && echo "ping 1.1.1.1      : OK" || echo "ping 1.1.1.1      : FAILED"
  getent hosts archlinux.org >/dev/null 2>&1 && echo "DNS archlinux.org : OK" || echo "DNS archlinux.org : FAILED"
  echo "--- last lines of pacstrap output -------------------------"
  tail -n 15 "$PLOG" 2>/dev/null
  echo "-----------------------------------------------------------"
  die "package install failed after 6 attempts — see the state above"
fi

say "generating fstab"
genfstab -U "$MNT" >> "$MNT/etc/fstab"

# --- appliance layer (copied from this live system) ------------------------
say "installing the appliance layer"
for s in dashboard3d-session dashboard3d-gamemode dashboard3d-install dashboard3d-prep; do
  [[ -f "/usr/local/bin/$s" ]] \
    && install -Dm755 "/usr/local/bin/$s" "$MNT/usr/local/bin/$s"
done
[[ -f /etc/sysusers.d/dashboard3d-gamer.conf ]] \
  && install -Dm644 /etc/sysusers.d/dashboard3d-gamer.conf \
       "$MNT/etc/sysusers.d/dashboard3d-gamer.conf"
[[ -f /etc/systemd/system/dashboard3d-prep.service ]] \
  && install -Dm644 /etc/systemd/system/dashboard3d-prep.service \
       "$MNT/etc/systemd/system/dashboard3d-prep.service"
[[ -f /etc/sudoers.d/dashboard3d ]] \
  && install -Dm440 /etc/sudoers.d/dashboard3d "$MNT/etc/sudoers.d/dashboard3d"

[[ -d /opt/dashboard3d ]] || die "/opt/dashboard3d is missing on the live system"
mkdir -p "$MNT/opt/dashboard3d"
cp -a /opt/dashboard3d/. "$MNT/opt/dashboard3d/"
chmod 755 "$MNT/opt/dashboard3d/dashboard3d" 2>/dev/null || true
# The app runs as 'gamer' (uid 1000) and writes config under it.
chown -R 1000:1000 "$MNT/opt/dashboard3d" 2>/dev/null || true

# modprobe rules for the INSTALLED system: amdgpu loads normally (the real
# initramfs has firmware); the NVIDIA dGPU stays dark.
install -Dm644 /dev/stdin "$MNT/etc/modprobe.d/dashboard3d.conf" <<'EOF'
blacklist nouveau
blacklist nvidia
blacklist nvidia_drm
blacklist nvidia_modeset
blacklist nvidia_uvm
EOF

cp /etc/dashboard3d-build "$MNT/etc/dashboard3d-build" 2>/dev/null \
  || date '+%Y-%m-%d %H:%M (installed)' > "$MNT/etc/dashboard3d-build"

# --- configure inside the new system --------------------------------------
say "configuring the installed system"
ROOT_UUID=$(blkid -s UUID -o value "$ROOT")
[[ -n "$ROOT_UUID" ]] || die "could not read the new root partition UUID"

{
  echo '#!/bin/bash'
  echo 'set -e'
  echo "ROOT_UUID='$ROOT_UUID'"
  cat <<'CHROOT'
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
hwclock --systohc 2>/dev/null || true
grep -q '^\[multilib\]' /etc/pacman.conf || \
  printf '\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n' >> /etc/pacman.conf
sed -i 's/^#\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen
locale-gen
echo 'LANG=en_US.UTF-8' > /etc/locale.conf
echo 'dashboard3d' > /etc/hostname

passwd -d root

# The appliance session runs as the unprivileged 'gamer' user (created
# at first boot by systemd-sysusers from the .conf, with the session
# script as its login shell). Autologin gamer on tty1; autologin root on
# tty2 for a no-password maintenance shell.
mkdir -p /etc/systemd/system/getty@tty1.service.d \
         /etc/systemd/system/getty@tty2.service.d
cat > /etc/systemd/system/getty@tty1.service.d/override.conf <<EOF
[Service]
ExecStart=
ExecStart=-/usr/bin/agetty --autologin gamer --noclear %I \$TERM
EOF
cat > /etc/systemd/system/getty@tty2.service.d/override.conf <<EOF
[Service]
ExecStart=
ExecStart=-/usr/bin/agetty --autologin root --noclear %I \$TERM
EOF

systemctl enable NetworkManager
systemctl enable dashboard3d-prep.service
systemctl set-default multi-user.target
mkinitcpio -P

bootctl install
mkdir -p /boot/loader/entries
cat > /boot/loader/loader.conf <<EOF
default dashboard3d.conf
timeout 1
console-mode max
EOF
cat > /boot/loader/entries/dashboard3d.conf <<EOF
title   Dashboard3D Appliance
linux   /vmlinuz-linux
initrd  /amd-ucode.img
initrd  /initramfs-linux.img
options root=UUID=$ROOT_UUID rw amdgpu.sg_display=0 amdgpu.dcdebugmask=0x10
EOF
CHROOT
} > "$MNT/root/.d3d-setup.sh"
chmod +x "$MNT/root/.d3d-setup.sh"
arch-chroot "$MNT" /root/.d3d-setup.sh || die "in-system configuration failed"
rm -f "$MNT/root/.d3d-setup.sh"

sync
umount -R "$MNT" 2>/dev/null || true

echo
echo "############################################################"
echo "##  INSTALL COMPLETE — Dashboard3D is on $TARGET"
echo "############################################################"
echo
echo "  1. Press ENTER to power off."
echo "  2. Remove the USB stick."
echo "  3. Power on — in the firmware boot menu pick the internal"
echo "     'Linux Boot Manager' (your Windows entry is untouched)."
echo
drain
read -r -p "Press ENTER to power off ... " _ || true
systemctl poweroff
