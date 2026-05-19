#!/usr/bin/env bash
#
# Dashboard3D Game Mode — Steam Big Picture under gamescope.
#
# Runs as the 'gamer' user, the SAME uid as the dashboard session. So
# gamescope and Steam share one user and one XDG_RUNTIME_DIR — Steam
# can reach the display with no cross-user permission problems.
#
# Self-diagnosing: waits for the network, relaunches across Steam's
# first-run restart, and on failure prints one photographable screen.

set -u

LOG=/tmp/gamemode.log
DIAG=/tmp/gamemode-diag.txt
: > "$LOG"

echo
echo "================== Dashboard3D Game Mode =================="

# --- wait for the network -------------------------------------------
# Steam's first run downloads its client; with no internet it quits.
echo "waiting for the network (Steam's first run needs internet) ..."
NET=OFFLINE
for i in $(seq 1 30); do
  if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then NET=online; break; fi
  printf '\r  no internet yet ... %2ds ' "$((i*2))"
  sleep 1
done
printf '\r                              \r'

# --- diagnostics (reprinted in the failure report) -----------------
{
  echo "=== Game Mode diagnostics @ $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "build    : $(cat /etc/dashboard3d-build 2>/dev/null || echo unknown)"
  echo "user     : $(id -un) (uid $(id -u))"
  echo "network  : $NET"
  echo "DRM      : $(ls /dev/dri/ 2>/dev/null | tr '\n' ' ')"
  echo "seat     : seat=${XDG_SEAT:-?} vt=${XDG_VTNR:-?} session=${XDG_SESSION_ID:-?}"
  echo "runtime  : ${XDG_RUNTIME_DIR:-<unset>}"
  echo "gamescope: $(command -v gamescope 2>/dev/null || echo '!! MISSING')"
  echo "steam    : $(command -v steam 2>/dev/null || echo '!! MISSING')"
  echo "free RAM : $(free -h 2>/dev/null | awk '/^Mem:/{print $7" of "$2}')"
  echo "steam dir: $(du -sh "$HOME/.local/share/Steam" 2>/dev/null | cut -f1)"
  echo "==========================================================="
} | tee "$DIAG"

if [[ "$NET" == OFFLINE ]]; then
  echo
  echo ">>> WARNING: no internet — Steam's first run will likely fail."
fi
echo
echo "launching gamescope + Steam ..."
echo "(first run downloads the Steam client — several minutes; the"
echo " screen may look idle. To leave Game Mode: Steam menu > Exit.)"
echo

# --- launch loop ----------------------------------------------------
# Steam's first run bootstraps then restarts itself, ending the
# gamescope session; relaunch on a short run. A long run (>= 3 min) is
# a real session the user ended -> back to the dashboard.
MAX=6
rc=0; dur=0; attempt=0
while (( attempt < MAX )); do
  attempt=$(( attempt + 1 ))
  { echo; echo "===== gamescope+Steam attempt $attempt @ $(date '+%H:%M:%S') ====="; } >> "$LOG"
  start=$SECONDS
  # NOTE: no -e/--steam flag. -e puts gamescope in Steam Deck mode, where it
  # waits for Steam to send a "Deck UI ready" handshake before it paints.
  # During Steam's first-run download that handshake never arrives, so
  # gamescope hangs forever with a blank screen. Plain gamescope just shows
  # Steam's window as soon as it appears (same as the Dashboard launch).
  gamescope -f -- steam >>"$LOG" 2>&1
  rc=$?
  dur=$(( SECONDS - start ))
  clear 2>/dev/null || true

  if (( dur >= 180 )); then
    echo "Steam session ended (ran ${dur}s). Returning to the dashboard."
    sleep 2
    exit 0
  fi

  (( attempt >= MAX )) && break
  echo "Steam exited after ${dur}s (attempt $attempt of $MAX, exit=$rc)."
  echo "This is expected while Steam bootstraps/restarts its client."
  echo "Relaunching in 5s — press X to stop and return to the dashboard."
  if read -t 5 -r -n 1 k 2>/dev/null && [[ "${k:-}" == [xX] ]]; then
    echo; echo "Returning to the dashboard."
    exit 0
  fi
done

# --- failure report (fits one screen) ------------------------------
clear 2>/dev/null || true
echo "############################################################"
echo "## GAME MODE COULD NOT START"
echo "## $attempt attempts, last exit=$rc after ${dur}s, net=$NET"
echo "############################################################"
cat "$DIAG" 2>/dev/null
echo "--- last 40 lines of /tmp/gamemode.log --------------------"
tail -n 40 "$LOG" 2>/dev/null
echo "-----------------------------------------------------------"
echo
echo ">>> PHOTOGRAPH this whole screen and send it."
echo ">>> Press ENTER to return to the dashboard."
read -r _ || true
exit 0
