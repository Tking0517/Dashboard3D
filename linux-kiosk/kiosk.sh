# Installed to /etc/profile.d/dashboard3d-kiosk.sh
# Runs at login. On tty1 (the autologin console) it hands off to the
# appliance session; every other tty stays a normal shell for maintenance.
if [[ "$(tty)" == "/dev/tty1" && -z "${DASHBOARD3D_SESSION:-}" ]]; then
  export DASHBOARD3D_SESSION=1
  exec dashboard3d-session
fi
