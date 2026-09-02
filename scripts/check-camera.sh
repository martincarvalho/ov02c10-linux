#!/usr/bin/env bash
# Report what the camera is actually doing, so a regression is visible.
set -u

SD=$(for x in /sys/class/video4linux/v4l-subdev*; do
       n=$(cat "$x/name" 2>/dev/null)
       case "$n" in *ov02c10*) echo "/dev/$(basename "$x")";; esac
     done | head -1)

echo "=== sensor controls (after libcamera has configured it) ==="
if [ -n "$SD" ]; then
  sudo v4l2-ctl -d "$SD" --list-ctrls 2>/dev/null |
    grep -E 'exposure |vertical_blank|analogue_gain' | sed 's/^/  /'
  echo "  expected: exposure max 3164 (4 x 791, flicker-safe steps), vblank 2080"
else
  echo "  ov02c10 subdev not found"
fi

echo
echo "=== module parameters ==="
for p in /sys/module/ov02c10/parameters/*; do
  [ -e "$p" ] && echo "  $(basename "$p") = $(cat "$p" 2>/dev/null)"
done

echo
echo "=== PipeWire source ==="
wpctl status 2>/dev/null | sed -n '/^Video/,/^Settings/p' |
  grep -A3 "Sources:" | sed 's/^/  /'

echo
echo "=== ISP stages ==="
export __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
LOG=$(mktemp)
timeout 60 cam -c 1 --stream pixelformat=XRGB8888,width=1280,height=720 \
  --capture=60 --file=/tmp/ov02c10-check-#.bin >"$LOG" 2>&1 || true
grep -E "Temporal denoise|Sharpening|Motion compensation" "$LOG" | sed 's/^.*Debayer /  /'

python3 - <<'PY' 2>/dev/null
import glob, os
import numpy as np
W, H = 1280, 720
frames = [f for f in sorted(glob.glob('/tmp/ov02c10-check-*.bin'),
                            key=os.path.getmtime)
          if os.path.getsize(f) >= W * H * 4][-20:]
if frames:
    s = np.stack([np.fromfile(f, dtype=np.uint8, count=W * H * 4)
                  .reshape(H, W, 4)[:, :, 2::-1].astype(np.float32)
                  for f in frames])
    print()
    print('=== image ===')
    print('  median %.0f   blacks (p0.1) %.0f   tonal range in use %.0f'
          % (np.percentile(s[-1], 50), np.percentile(s[-1], 0.1),
             np.percentile(s[-1], 99.9) - np.percentile(s[-1], 0.1)))
    print('  residual noise %.2f DN' % (s - s.mean(0)).std())
PY
rm -f /tmp/ov02c10-check-*.bin "$LOG"
