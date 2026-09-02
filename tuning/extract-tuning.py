#!/usr/bin/env python3
"""Extract colour matrices from an Intel camera tuning file (.aiqb).

Intel ships a per-module characterisation with its Windows camera driver: the
colour matrices for that exact sensor and lens, measured in a lab against a
colour chart. On a machine that dual boots, that measurement is already on the
disk, and it describes the very camera you are trying to fix.

This reads one and writes a libcamera tuning file. It ships no data of its own:
run it against your own driver, on your own machine.

    sudo mount -o ro /dev/nvmeXnYpZ /mnt/win
    ./extract-tuning.py /mnt/win/Windows/System32/OV02C10_*.aiqb > ov02c10.yaml
    sudo umount /mnt/win

The .aiqb is an undocumented Intel container ("CPFF"), so this does not parse
it. It looks for the one thing colour matrices cannot hide: every row of one
sums to 1, because a matrix that changes the colour of grey would change the
white balance. A block of N matrices therefore averages to exactly 1/3. Scan
for runs of floats with that mean, check every row really does sum to 1, and
what is left is the matrices.

Each block is preceded by 24 bytes holding an index, four floats of white
point, and the illuminant's colour temperature in kelvin - which is what makes
the result usable, since libcamera interpolates between temperatures.

Tested against OV02C10_KBFC645_MTL.aiqb. Other sensors use the same container
and should work; check the temperatures it reports look like real illuminants
before trusting the output.
"""
import struct
import sys

import numpy as np

MATRICES_PER_BLOCK = 25       # Intel stores one matrix per hue sector
HEADER = 24                   # index, 4 white point floats, temperature


def find_blocks(data):
    """Every run of floats whose rows each sum to one."""
    floats = np.frombuffer(data[:len(data) // 4 * 4], dtype='<f4')
    span = MATRICES_PER_BLOCK * 9
    found = []

    for off in range(0, len(data) - span * 4, 4):
        v = floats[off // 4:off // 4 + span]
        if len(v) < span or not np.isfinite(v).all() or np.abs(v).max() > 50:
            continue
        if np.abs(v.reshape(MATRICES_PER_BLOCK, 3, 3).sum(2) - 1).max() > 1e-4:
            continue
        if found and off - found[-1] < 36:
            continue                      # same run, shifted by a few bytes
        found.append(off)

    return found, floats


def read(path):
    data = open(path, 'rb').read()
    if data[:4] != b'CPFF':
        print('%s: not an Intel CPFF container' % path, file=sys.stderr)
        sys.exit(1)

    offsets, floats = find_blocks(data)
    if not offsets:
        print('no colour matrices found', file=sys.stderr)
        sys.exit(1)

    out = {}
    for off in offsets:
        if off < HEADER:
            continue
        head = data[off - HEADER:off]
        cct = struct.unpack('<I', head[20:24])[0]
        if not 1500 < cct < 12000:        # not an illuminant, so not a block
            continue

        m = floats[off // 4:off // 4 + MATRICES_PER_BLOCK * 9]
        m = m.reshape(MATRICES_PER_BLOCK, 3, 3)

        # The software ISP applies one matrix, not one per hue sector. The
        # median across sectors stands up to the extreme ones better than the
        # mean does.
        single = np.median(m, axis=0)
        single = single / single.sum(axis=1, keepdims=True)

        # The same illuminant appears in several tables; they agree closely,
        # so the first is as good as any.
        out.setdefault(cct, single)

    return out


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)

    ccms = read(sys.argv[1])
    if not ccms:
        print('no illuminants recognised', file=sys.stderr)
        sys.exit(1)

    print('# Software ISP tuning, colour matrices extracted from')
    print('# %s' % sys.argv[1].split('/')[-1])
    print('#')
    print('# %d illuminants: %s' %
          (len(ccms), ', '.join('%d K' % k for k in sorted(ccms))))
    print('#')
    print('# These numbers describe one camera module and came from a vendor')
    print('# driver. They are fine on the machine they were read from. Do not')
    print('# redistribute them.')
    print('%YAML 1.1')
    print('---')
    print('version: 1')
    print('algorithms:')
    print('  - BlackLevel:')
    print('  - Awb:')
    print('  - Ccm:')
    print('      ccms:')
    for cct in sorted(ccms):
        r = ccms[cct].ravel()
        print('        - ct: %d' % cct)
        print('          ccm: [ %s,' % ', '.join('%7.4f' % x for x in r[0:3]))
        print('                 %s,' % ', '.join('%7.4f' % x for x in r[3:6]))
        print('                 %s ]' % ', '.join('%7.4f' % x for x in r[6:9]))
    print('  - Adjust:')
    print('  - Agc:')
    print('...')


if __name__ == '__main__':
    main()
