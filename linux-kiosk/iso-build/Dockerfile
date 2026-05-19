# Build environment for the Dashboard3D appliance ISO.
#
# An Arch Linux image with `archiso` (the mkarchiso toolchain) installed.
# The actual build logic lives in container-build.sh, which is bind-mounted
# from the repo at run time — so it can be edited without rebuilding this
# image. mkarchiso needs loop devices and mount, so the container must be
# run with --privileged (see build-iso.sh).
FROM archlinux:latest

RUN pacman -Syu --noconfirm archiso && pacman -Scc --noconfirm

WORKDIR /repo
