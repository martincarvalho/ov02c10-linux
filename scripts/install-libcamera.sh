#!/usr/bin/env bash
# Rebuild the distribution's libcamera with the software ISP work applied.
#
# Everything here lives in libcamera, which every `pacman -Syu` that updates it
# will overwrite. Run this again afterwards.
#
# Tested end to end: clean clone of the Arch package, extract, patch, full
# build. If you change the patch, test it from scratch again - a recovery path
# that has never been run is not a recovery path.
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH="$REPO/libcamera/softisp-ov02c10.patch"
SHADERS="$REPO/libcamera/shaders"
WORK="${WORK:-$HOME/.cache/ov02c10-build}"

[ -f "$PATCH" ] || { echo "patch not found at $PATCH"; exit 1; }

mkdir -p "$WORK"
cd "$WORK"
rm -rf libcamera
git clone --depth 1 --branch main \
  https://gitlab.archlinux.org/archlinux/packaging/packages/libcamera.git
cd libcamera
makepkg -o --nodeps --skipchecksums

SRC=$(dirname "$(find src -path '*/src/ipa/libipa/camera_sensor_helper.cpp' | head -1)")
SRC=${SRC%/src/ipa/libipa}
[ -n "$SRC" ] || { echo "extracted source tree not found"; exit 1; }

if grep -q ov02c10 "$SRC/src/ipa/libipa/camera_sensor_helper.cpp"; then
  echo "note: upstream now carries the sensor helper; the patch may need trimming"
fi

# The new shaders are whole files, so they cannot travel in a unified diff.
cp "$SHADERS"/*.frag "$SRC/src/libcamera/shaders/"

# Check before applying, so a mismatch explains itself instead of failing
# halfway through.
if ! git -C "$SRC" apply --check "$PATCH" 2>/tmp/ov02c10-patch.err; then
  echo
  echo "The patch does not apply to this version of libcamera."
  sed 's/^/  /' /tmp/ov02c10-patch.err
  echo
  echo "Most likely libcamera moved and the patch needs rebasing. One other"
  echo "cause seen in practice: a patch generated with a plain 'git diff' in"
  echo "the extracted tree picks up the distribution's own patches as if they"
  echo "were yours, and then conflicts with them on the next extraction."
  echo "Regenerate excluding those files, for example:"
  echo
  echo "  git diff -- . ':(exclude)src/py/libcamera/meson.build'"
  echo
  exit 1
fi

git -C "$SRC" apply "$PATCH"
echo "patch applied"

makepkg -e -s --noconfirm --skipchecksums --nocheck
sudo pacman -U --noconfirm \
  libcamera-0.*.pkg.tar.zst libcamera-ipa-0.*.pkg.tar.zst libcamera-tools-0.*.pkg.tar.zst

echo
echo "Done. Restart the camera stack:"
echo "  systemctl --user restart pipewire wireplumber"
