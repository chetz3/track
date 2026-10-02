#!/usr/bin/env python3
"""Generates the Habitly PNG app icons (192 and 512) using only the
standard library (zlib + struct) — no Pillow/npm dependency needed.

Same mark as icons/logo.svg: a coral→amber diagonal gradient with a white
habit loop (an almost-closed ring) and a check inside. The square is
full-bleed (no rounded corners) because the OS applies its own icon mask;
the mark sits well inside the maskable safe zone. Edges are anti-aliased by
3×3 supersampling.
"""
import math
import os
import struct
import zlib

C1 = (0xFF, 0x6B, 0x4A)  # coral  (#FF6B4A)
C2 = (0xF5, 0x9E, 0x0B)  # amber  (#F59E0B)
WHITE = (255, 255, 255)

# Geometry in the 64-unit space of logo.svg.
CX, CY, R, STROKE = 32.0, 32.0, 18.0, 5.0
GAP_FROM, GAP_TO = -45.0, 0.0  # ring is open between these angles (degrees, y down)
ARC_ENDS = [(44.7279, 19.2721), (50.0, 32.0)]
CHECK = [(24.0, 32.5), (30.0, 38.5), (41.0, 26.5)]


def dist_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def is_mark(u, v):
    half = STROKE / 2
    # ring, minus the gap, plus round caps at both ends
    d = math.hypot(u - CX, v - CY)
    if abs(d - R) <= half:
        ang = math.degrees(math.atan2(v - CY, u - CX))
        if not (GAP_FROM < ang < GAP_TO):
            return True
    for ex, ey in ARC_ENDS:
        if math.hypot(u - ex, v - ey) <= half:
            return True
    # check mark (round joins/caps come free from distance-to-segment)
    for (x1, y1), (x2, y2) in zip(CHECK, CHECK[1:]):
        if dist_to_segment(u, v, x1, y1, x2, y2) <= half:
            return True
    return False


def make_icon(size):
    ss = 3
    rows = []
    for y in range(size):
        row = bytearray([0])  # PNG filter: none
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            bg = [C1[i] + (C2[i] - C1[i]) * t for i in range(3)]
            hits = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) / ss) * 64 / size
                    v = (y + (sy + 0.5) / ss) * 64 / size
                    hits += is_mark(u, v)
            a = hits / (ss * ss)
            row.extend(round(bg[i] * (1 - a) + WHITE[i] * a) for i in range(3))
            row.append(255)
        rows.append(bytes(row))
    return b''.join(rows)


def write_png(path, size):
    raw = make_icon(size)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out_dir = os.path.dirname(os.path.abspath(__file__))
    write_png(os.path.join(out_dir, 'icon-192.png'), 192)
    write_png(os.path.join(out_dir, 'icon-512.png'), 512)
    print('wrote icon-192.png and icon-512.png')
