#!/usr/bin/env bash
#
# Builds the Dashboard3D appliance ISO using Docker.
#
# Run this from a Linux shell that can reach Docker — WSL2 with Docker
# Desktop integration is the expected setup on a Windows dev box. It builds
# a small Arch + archiso image, then runs mkarchiso inside a privileged
# container with the repo bind-mounted.
#
# Output: linux-kiosk/iso-build/out/dashboard3d-*.iso
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE=dashboard3d-iso-builder

echo "[iso] repo:  $REPO_ROOT"

# --- preflight --------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found. Install Docker Desktop and enable WSL" >&2
  echo "       integration, or run container-build.sh on an Arch box." >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/dashboard3d-linux-x64/dashboard3d" ]]; then
  echo "ERROR: Linux build of Dashboard3D is missing." >&2
  echo "       Build it first with linux-kiosk/build-dashboard.sh" >&2
  echo "       (expects $REPO_ROOT/dashboard3d-linux-x64/dashboard3d)." >&2
  exit 1
fi

# --- build the builder image ------------------------------------------------
echo "[iso] building Docker image '$IMAGE'..."
docker build -t "$IMAGE" "$SCRIPT_DIR"

# --- run mkarchiso inside the container -------------------------------------
# --privileged: mkarchiso needs loop devices + mount for the squashfs/ISO.
echo "[iso] running mkarchiso in a privileged container..."
docker run --rm --privileged \
  -v "$REPO_ROOT":/repo \
  "$IMAGE" \
  /repo/linux-kiosk/iso-build/container-build.sh

echo
echo "[iso] done. ISO is in: $SCRIPT_DIR/out/"
echo "[iso] flash it to a USB stick with Rufus or balenaEtcher (see README.md)."
