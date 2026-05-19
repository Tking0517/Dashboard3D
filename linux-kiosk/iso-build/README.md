# Dashboard3D Appliance ISO

Builds a **live-bootable Arch Linux ISO** that boots straight into
Dashboard3D running under gamescope — the dashboard *is* the OS. Meant for
testing the appliance on a laptop from a USB stick: it runs entirely from
the USB and **never touches the laptop's own disk**.

## What gets baked in

- The packaged Linux build of Dashboard3D at `/opt/dashboard3d`
- `gamescope` compositor, the open GPU stack (AMD / Intel / NVIDIA-nouveau)
- Steam + gamemode/mangohud, pipewire audio, NetworkManager
- A `dashboard3d.service` systemd unit that owns tty1, with `Restart=always`

The boot chain: `systemd → dashboard3d.service → gamescope → Dashboard3D`.

## Prerequisites

1. **The Linux app build.** Run `linux-kiosk/build-dashboard.sh` first — the
   ISO build expects `dashboard3d-linux-x64/dashboard3d` in the repo root.
2. **Docker Desktop** with WSL2 integration enabled (the build runs
   `mkarchiso` inside a privileged Arch container, so it works regardless of
   the Windows host). No Docker? Run `container-build.sh` directly on any
   Arch box with `archiso` installed and the repo at `/repo`.

## Build

From a WSL2 shell:

```sh
linux-kiosk/iso-build/build-iso.sh
```

The ISO lands in `linux-kiosk/iso-build/out/dashboard3d-*.iso`. First build
is slow (downloads every package); expect a multi-GB ISO because Steam and
the GPU stacks are large.

PowerShell equivalent, if you prefer not to use WSL:

```powershell
docker build -t dashboard3d-iso-builder linux-kiosk\iso-build
docker run --rm --privileged -v ${PWD}:/repo dashboard3d-iso-builder `
  /repo/linux-kiosk/iso-build/container-build.sh
```

## Flash to USB — do this yourself, carefully

Use **Rufus** (https://rufus.ie) or **balenaEtcher** — GUI tools that show
the target device clearly.

> ⚠️ Flashing **erases the entire USB drive**. Double-check you have
> selected the USB stick and not another disk. This is why it is a manual
> GUI step and not scripted.

In Rufus: select the USB device → select the `dashboard3d-*.iso` → write in
**DD image mode** if prompted → Start.

## Boot the laptop

1. Insert the USB, power on, and open the **boot menu** (usually F12 / F10 /
   F9 / Esc — varies by vendor).
2. Pick the USB device.
3. If it won't boot, enter BIOS/UEFI setup and **disable Secure Boot**, then
   retry.
4. It should land in Dashboard3D within a minute.

## Maintenance / escape hatch

- The appliance session owns **tty1**. Press **Ctrl+Alt+F2** for a normal
  root shell to poke around or read logs.
- Session log: `journalctl -u dashboard3d.service`.

## Known limitations of the live test ISO

- Runs as **root** from RAM — fine for a boot/UX test, not a daily driver.
- Audio (pipewire) may need extra wiring; the first goal is "does it boot
  into the dashboard."
- For an NVIDIA laptop that needs the proprietary driver, uncomment the
  `nvidia` lines in `overlay/packages.add` and rebuild.
- A persistent install (real disk, dedicated user) is the separate
  `linux-kiosk/install.sh` path, not this live ISO.
