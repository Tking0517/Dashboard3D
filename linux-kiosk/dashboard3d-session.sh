#!/usr/bin/env bash
#
# Dashboard3D appliance session.
#
# Runs as the unprivileged 'gamer' user, auto-logged-in on tty1. Because
# gamescope, the dashboard and Steam all run under this one uid, Steam
# can reach the display gamescope owns — which the old root/gamer split
# could not do.
#
# Root-only hardware setup (GPU driver, thermal, fans) is done earlier,
# at boot, by dashboard3d-prep.service.
#
# On any tty other than tty1 this just hands off to a normal shell, so
# the maintenance consoles stay usable.

if [[ "$(tty)" != "/dev/tty1" ]]; then
  exec /usr/bin/bash
fi

APP_BIN="/opt/dashboard3d/dashboard3d"
GS_LOG=/tmp/gamescope.log
GAMEMODE_FLAG=/tmp/dashboard3d-gamemode
GAMEMODE_SCRIPT=/usr/local/bin/dashboard3d-gamemode
INSTALL_SCRIPT=/usr/local/bin/dashboard3d-install

# We are inside our own logind session on tty1 — force libseat to the
# logind backend so gamescope takes the seat from it.
export LIBSEAT_BACKEND=logind

# Wait for the GPU device (dashboard3d-prep.service loads amdgpu).
for _ in $(seq 1 75); do
  compgen -G "/dev/dri/card*" >/dev/null && break
  sleep 0.2
done

echo
echo "=============== Dashboard3D appliance ==============="
echo "build   : $(cat /etc/dashboard3d-build 2>/dev/null || echo unknown)"
echo "user    : $(id -un) (uid $(id -u))"
echo "DRM     : $(ls /dev/dri/ 2>/dev/null | tr '\n' ' ')"
echo "seat    : seat=${XDG_SEAT:-UNSET} vt=${XDG_VTNR:-UNSET} session=${XDG_SESSION_ID:-UNSET}"
echo "runtime : ${XDG_RUNTIME_DIR:-UNSET}"
echo "====================================================="
echo ">>> Press  g  for GAME MODE (Steam),  i  to INSTALL to a disk,"
echo ">>> or press Enter / wait 12s for the Dashboard."
read -t 12 -r -n 1 _key || true
echo

# 'i' -> the disk installer. It needs root, so via sudo (a NOPASSWD
# rule for this one command is installed in /etc/sudoers.d).
if [[ "${_key:-}" == [iI] ]]; then
  if [[ -x "$INSTALL_SCRIPT" ]]; then
    sudo "$INSTALL_SCRIPT"
  else
    echo ">>> installer not found at $INSTALL_SCRIPT"; sleep 3
  fi
fi

# 'g' -> Game Mode (also reachable from the in-app button, which drops
# the same flag file).
if [[ "${_key:-}" == [gG] ]]; then
  : > "$GAMEMODE_FLAG"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "FATAL: $APP_BIN is missing or not executable."
  exec /usr/bin/bash -i
fi

# Main session loop.
while true; do
  if [[ -f "$GAMEMODE_FLAG" ]]; then
    rm -f "$GAMEMODE_FLAG"
    echo "Entering Game Mode ..."
    if [[ -x "$GAMEMODE_SCRIPT" ]]; then
      "$GAMEMODE_SCRIPT"
    else
      echo "Game Mode script missing: $GAMEMODE_SCRIPT"; sleep 3
    fi
    continue
  fi

  echo "Launching gamescope + Dashboard3D ..."
  gamescope -f -- "$APP_BIN" --no-sandbox >"$GS_LOG" 2>&1
  rc=$?
  clear 2>/dev/null || true
  # The in-app Game Mode button leaves the flag — loop to run it.
  [[ -f "$GAMEMODE_FLAG" ]] && continue

  echo "============ gamescope output (exit $rc) ============"
  cat "$GS_LOG" 2>/dev/null
  echo "====================================================="
  echo "gamescope / Dashboard3D exited. Output above, saved at $GS_LOG."
  break
done
exec /usr/bin/bash -i
