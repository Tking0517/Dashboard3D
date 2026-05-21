#!/usr/bin/env python3
"""Dashboard3D media-key daemon.

Listens for kernel KEY_VOLUMEUP / KEY_VOLUMEDOWN / KEY_MUTE events on
every input device that advertises them and dispatches each press to
WirePlumber's wpctl. Runs as the gamer user under a systemd-user
service so it stays alive across gamescope sessions, Steam Big Picture
and individual game launches — wherever the keyboard input lands, this
catches it.

Why evdev and not a desktop hotkey daemon: the appliance has no DE.
gamescope grabs the seat, and Steam Big Picture under it has no system
volume UI. Anything that wants an X/Wayland keymap fails. evdev reads
straight from /dev/input/event*, which works regardless of what
compositor (if any) is in front. logind grants uaccess on the seat-
owner's input devices, so no `input` group membership is required.

Hot-plug isn't handled — a Bluetooth keyboard paired AFTER launch will
not have its volume keys caught. systemd Restart=always will pick it
up on the next launch; for now that's the simplest behaviour.
"""

import select
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


def _wpctl(*args: str) -> None:
    try:
        subprocess.run([WPCTL, *args], check=False, timeout=2)
    except Exception as exc:
        print(f"wpctl {args} failed: {exc}", file=sys.stderr)


HANDLERS = {
    ecodes.KEY_VOLUMEUP:   lambda: _wpctl("set-volume", SINK, f"{VOLUME_STEP}+"),
    ecodes.KEY_VOLUMEDOWN: lambda: _wpctl("set-volume", SINK, f"{VOLUME_STEP}-"),
    ecodes.KEY_MUTE:       lambda: _wpctl("set-mute",   SINK, "toggle"),
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
