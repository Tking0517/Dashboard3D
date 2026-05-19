# Dashboard3D Appliance

Turns a PC into a dedicated appliance that boots straight into Dashboard3D —
no desktop, no display manager. Arch Linux base, `gamescope` compositor,
Steam + Proton for gaming.

## Boot chain

```
UEFI -> systemd-boot -> kernel -> systemd (multi-user.target)
  -> getty autologin on tty1            (getty-autologin.conf)
  -> /etc/profile.d/dashboard3d-kiosk.sh hands off on tty1   (kiosk.sh)
  -> dashboard3d-session                (dashboard3d-session.sh)
  -> gamescope -f -- Dashboard3D        the app IS the shell
```

There is no graphical.target and no display manager. Crash recovery is
layered: a renderer crash is relaunched inside the running gamescope; if
gamescope itself dies, getty respawns the whole session.

## Files

| File | Installed to | Purpose |
|------|--------------|---------|
| `install.sh` | — | One-shot installer, run as root on fresh Arch |
| `dashboard3d-session.sh` | `/usr/local/bin/dashboard3d-session` | Launches gamescope + the app |
| `getty-autologin.conf` | `/etc/systemd/system/getty@tty1.service.d/override.conf` | Passwordless autologin on tty1 |
| `kiosk.sh` | `/etc/profile.d/dashboard3d-kiosk.sh` | Hands tty1 login off to the session |

## Build steps

1. Install a minimal Arch Linux (base + linux + a bootloader) on the target
   machine or VM. Run `pacman -Syu` and make sure networking works.
2. Build the Linux package of Dashboard3D. From WSL/Linux run
   `linux-kiosk/build-dashboard.sh` (handles the slow-NTFS workaround), or
   on a Linux dev box directly:
   ```
   npm run package:linux
   ```
   Copy the resulting `dashboard3d-linux-x64/` contents to `/opt/dashboard3d/`
   on the appliance (the binary must end up at `/opt/dashboard3d/dashboard3d`).
3. Copy this `linux-kiosk/` directory to the target and run:
   ```
   sudo ./install.sh
   ```
   Override the session user with `APPLIANCE_USER=name sudo -E ./install.sh`.
4. Reboot. The machine lands in Dashboard3D.

## Maintenance

- The appliance session only takes over **tty1**. Switch to **tty2**
  (`Ctrl+Alt+F2`) for a normal login shell to update or debug.
- Session log: `~/.local/state/dashboard3d/session.log` for the appliance user.

## GPU support

`install.sh` detects the GPU with `lspci` and installs the matching driver
set — NVIDIA (proprietary dkms), AMD or Intel (mesa + vulkan-*). A machine
with multiple GPUs gets all matching sets.

## Gaming

Steam is installed and runs natively under gamescope (the same compositor the
Steam Deck uses). Steam ships its own Proton. Launching Steam / Big Picture
from inside Dashboard3D is wired up in a later phase.
