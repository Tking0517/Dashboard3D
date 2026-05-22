#!/usr/bin/env python3
"""Dashboard3D media + brightness key daemon.

Listens for the kernel function-key events on every input device that
advertises them and dispatches each press:

  KEY_VOLUMEUP / KEY_VOLUMEDOWN / KEY_MUTE  -> WirePlumber (wpctl)
  KEY_BRIGHTNESSUP / KEY_BRIGHTNESSDOWN     -> backlight (brightnessctl)
  KEY_PROG1 (ASUS Armoury Crate key)        -> toggle dashboard overlay
                                               (SIGUSR2 to the Electron app)

Runs as the gamer user under a systemd-user service so it stays alive
across the X session, Steam Big Picture and individual game launches —
wherever the keyboard input lands, this catches it.

Why evdev and not a desktop hotkey daemon: the appliance has no DE, so
there is no settings daemon to handle the Fn media/brightness keys.
evdev reads straight from /dev/input/event*, which works regardless of
what compositor is in front. logind grants uaccess on the seat-owner's
input devices, so no `input` group membership is required.

brightnessctl writes /sys/class/backlight; its packaged udev rule
chgrp's those files to `video` (mode 0664), so the gamer user needs to
be in the `video` group (granted via the sysusers.d entry) — then no
root is required for brightness changes either.

Hot-plug isn't handled — a Bluetooth keyboard paired AFTER launch will
not have its keys caught. systemd Restart=always picks it up on the
next launch; for now that's the simplest behaviour.
"""

import os
import select
import signal
import subprocess
import sys
import time

try:
    from evdev import InputDevice, list_devices, ecodes
except ImportError:
    print("python-evdev not installed; daemon cannot run.", file=sys.stderr)
    sys.exit(1)

VOLUME_STEP = "5%"
SINK = "@DEFAULT_AUDIO_SINK@"
WPCTL = "/usr/bin/wpctl"

BRIGHTNESS_STEP = "8%"
BRIGHTNESSCTL = "/usr/bin/brightnessctl"

# The Electron dashboard writes its main-process PID here at startup.
# The Armoury Crate key (KEY_PROG1) toggles the dashboard overlay by
# sending that process SIGUSR2 — the same action as the F13 hotkey.
MAIN_PID_FILE = "/tmp/dashboard3d-main.pid"


def _wpctl(*args: str) -> None:
    try:
        subprocess.run([WPCTL, *args], check=False, timeout=2)
    except Exception as exc:
        print(f"wpctl {args} failed: {exc}", file=sys.stderr)


def _brightness(delta: str) -> None:
    # brightnessctl auto-detects the backlight class device. `set N%-`
    # clamps at 0 (panel dark); `set N%+` clamps at max. Standard laptop
    # behaviour — the brightness-up key always brings it back.
    try:
        subprocess.run([BRIGHTNESSCTL, "set", delta], check=False, timeout=2)
    except Exception as exc:
        print(f"brightnessctl {delta} failed: {exc}", file=sys.stderr)


def _toggle_overlay() -> None:
    # Armoury Crate key -> toggle the dashboard overlay. We signal the
    # Electron main process (SIGUSR2). The PID is verified against
    # /proc/<pid>/cmdline first so a stale PID file (recycled PID) can
    # never deliver SIGUSR2 to an unrelated process.
    try:
        with open(MAIN_PID_FILE) as fh:
            pid = int(fh.read().strip())
    except Exception as exc:
        print(f"overlay toggle: no dashboard PID ({exc})", file=sys.stderr)
        return
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            if b"dashboard3d" not in fh.read():
                print(f"overlay toggle: PID {pid} is not the dashboard", file=sys.stderr)
                return
        os.kill(pid, signal.SIGUSR2)
    except (ProcessLookupError, FileNotFoundError):
        print(f"overlay toggle: dashboard PID {pid} not running", file=sys.stderr)
    except Exception as exc:
        print(f"overlay toggle failed: {exc}", file=sys.stderr)


HANDLERS = {
    ecodes.KEY_VOLUMEUP:      lambda: _wpctl("set-volume", SINK, f"{VOLUME_STEP}+"),
    ecodes.KEY_VOLUMEDOWN:    lambda: _wpctl("set-volume", SINK, f"{VOLUME_STEP}-"),
    ecodes.KEY_MUTE:          lambda: _wpctl("set-mute",   SINK, "toggle"),
    ecodes.KEY_BRIGHTNESSUP:  lambda: _brightness(f"{BRIGHTNESS_STEP}+"),
    ecodes.KEY_BRIGHTNESSDOWN:lambda: _brightness(f"{BRIGHTNESS_STEP}-"),
    # Armoury Crate key (ASUS ROG laptops). Absent on other hardware —
    # open_devices() simply won't bind it, so this is self-gating.
    ecodes.KEY_PROG1:         _toggle_overlay,
}


def open_devices() -> list:
    """Open every input device that exports at least one of our keys."""
    devs = []
    for path in list_devices():
        try:
            d = InputDevice(path)
        except (OSError, PermissionError) as exc:
            print(f"skip {path}: {exc}", file=sys.stderr)
            continue
        caps = d.capabilities().get(ecodes.EV_KEY, [])
        if any(k in caps for k in HANDLERS):
            devs.append(d)
            print(f"watching {d.path}: {d.name}", flush=True)
    return devs


def main() -> None:
    # On first boot the input devices may not all be ready yet (USB
    # keyboards enumerate a beat after agetty hands off). Retry briefly.
    devs = []
    for _ in range(15):
        devs = open_devices()
        if devs:
            break
        time.sleep(1)
    if not devs:
        print("no input devices with volume keys found; exiting.", file=sys.stderr)
        sys.exit(1)

    fdmap = {d.fd: d for d in devs}
    while True:
        try:
            ready, _, _ = select.select(list(fdmap), [], [])
        except KeyboardInterrupt:
            return
        for fd in ready:
            d = fdmap[fd]
            try:
                events = list(d.read())
            except OSError as exc:
                # Device was unplugged. Drop it and keep going.
                print(f"device {d.path} dropped: {exc}", file=sys.stderr)
                fdmap.pop(fd, None)
                if not fdmap:
                    sys.exit(0)  # systemd will restart us; reopen devices fresh
                continue
            for ev in events:
                if ev.type != ecodes.EV_KEY or ev.value != 1:
                    continue  # ignore non-key + key-up/auto-repeat
                handler = HANDLERS.get(ev.code)
                if handler:
                    handler()


if __name__ == "__main__":
    main()
