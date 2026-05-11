#!/usr/bin/env bash
# Phase 4a — build a Linux Electron binary of the dashboard.
#
# Run from inside WSL Debian (or any modern Linux with Node 20+).
# Outputs `dashboard3d-linux-x64/` next to the Windows packaged build.
#
# Why copy to /tmp first: npm install on /mnt/<drive>/ (Windows NTFS via
# 9P) is 10-20x slower than on Linux-native filesystem because every
# small file op crosses the 9P boundary. node_modules is ~1500 packages;
# the difference is the script taking 90s vs 20 minutes.

set -euo pipefail

# Find dashboard source. Drive letter is autodetected — accommodates the
# `/mnt/c/...` vs `/mnt/e/...` split this repo has historically lived
# under. Override with DASH_SRC=/path env var.
detect_src() {
  if [[ -n "${DASH_SRC:-}" && -f "$DASH_SRC/package.json" ]]; then
    echo "$DASH_SRC"; return
  fi
  for d in /mnt/e/VSCODE/Dashboard3D /mnt/c/VSCODE/Dashboard3D /mnt/d/VSCODE/Dashboard3D; do
    if [[ -f "$d/package.json" ]]; then echo "$d"; return; fi
  done
  echo ""
}

SRC="$(detect_src)"
if [[ -z "$SRC" ]]; then
  echo "ERROR: could not find dashboard source. Set DASH_SRC=/path/to/Dashboard3D" >&2
  exit 1
fi

BUILD_DIR="$HOME/dash-build"
OUT_NAME="dashboard3d-linux-x64"

echo "[phase4a] source: $SRC"
echo "[phase4a] build dir: $BUILD_DIR"

# 1. Fresh build dir on Linux-native FS. rsync excludes the heavy
#    artifacts we'd never want carried in: existing node_modules,
#    previous dist outputs, Windows packaged build, build-portable
#    cache, .git (saves ~hundreds of MB and seconds per copy).
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
echo "[phase4a] copying source..."
rsync -a \
  --exclude='/node_modules' \
  --exclude='/dist' \
  --exclude='/Dashboard3D-win32-x64' \
  --exclude='/build-portable' \
  --exclude='/dashboard3d-linux-x64' \
  --exclude='/.git' \
  --exclude='/linux-kiosk/iso-build' \
  "$SRC/" "$BUILD_DIR/"

cd "$BUILD_DIR"

# 2. Install. audify is in optionalDependencies and is Windows-only —
#    npm gracefully skips it on Linux. The rest installs normally.
echo "[phase4a] npm install (audify will be skipped, that's expected)..."
npm install --no-audit --no-fund --omit=dev || true
# Re-install dev deps too — we need electron-packager + vite at build time.
npm install --no-audit --no-fund

# 3. Build renderer + package Linux binary. The `package:linux` script
#    in package.json runs `vite build` then electron-packager with
#    --platform=linux --arch=x64.
echo "[phase4a] packaging..."
npm run package:linux

# 4. Move output back to the Windows side so the user can find it next
#    to the Windows build.
if [[ -d "$BUILD_DIR/$OUT_NAME" ]]; then
  rm -rf "$SRC/$OUT_NAME"
  mv "$BUILD_DIR/$OUT_NAME" "$SRC/$OUT_NAME"
  echo "[phase4a] done. Linux binary at: $SRC/$OUT_NAME"
  echo "[phase4a]   entry: $SRC/$OUT_NAME/dashboard3d"
else
  echo "[phase4a] ERROR: expected $BUILD_DIR/$OUT_NAME, not found" >&2
  ls "$BUILD_DIR" | head -20
  exit 1
fi
