# Dashboard3D — Roadmap / TODO

Major items deferred for later. Captured 2026-05-22.

## Linux appliance

### 1. ISO build — under-the-hood optimization
The appliance ISO / flash needs optimization under the hood.
_Scope to define — candidates: boot speed, image size, package trimming,
squashfs settings, build time._

### 2. Discord room audio + video usable from Steam Big Picture
The dashboard's Discord room (voice + video) must keep working while Steam
Big Picture is the foreground layer — audio and video continue even when the
dashboard overlay is hidden behind Big Picture. Likely involves audio routing
(PipeWire) and keeping the dashboard's media capture alive while backgrounded.

### 3. Delay auto-config until the start animation finishes
Auto-config currently applies before the startup animation has finished.
Defer it until the intro animation completes so it doesn't preempt the intro.

### 4. Remove / defer the Steam Big Picture splash screen
Take out the Steam Big Picture splash screen — or at least don't start Big
Picture until the user's first button-press into it from the dashboard.
Currently `steam -bigpicture` launches eagerly at session start as the
always-on base layer (see `linux-kiosk/dashboard3d-session.sh`).
