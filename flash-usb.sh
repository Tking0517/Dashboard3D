#!/usr/bin/env bash
# Writes the Dashboard3D appliance ISO to the USB attached into WSL.
# Runs inside WSL (called by flash-usb.ps1). It picks the target purely
# by size — only a ~119 GB disk is accepted — so it cannot hit anything
# else even if disk numbers shift.
set -e

ISO=/mnt/e/VSCODE/Dashboard3D/linux-kiosk/iso-build/out/dashboard3d-2026.05.17-x86_64.iso
[ -f "$ISO" ] || { echo "ABORT: ISO not found: $ISO"; exit 1; }

dev=""
for d in /dev/sd?; do
  [ -b "$d" ] || continue
  sz=$(blockdev --getsize64 "$d" 2>/dev/null || echo 0)
  gib=$(( sz / 1073741824 ))
  echo "candidate $d = ${gib} GiB"
  if [ "$gib" -ge 100 ] && [ "$gib" -le 125 ]; then dev="$d"; fi
done
[ -n "$dev" ] || { echo "ABORT: no ~119 GB USB device attached to WSL"; exit 1; }

echo ">>> flashing $ISO"
echo ">>> to $dev"
dd if="$ISO" of="$dev" bs=4M conv=fsync status=progress
sync
echo ">>> flash complete on $dev"
