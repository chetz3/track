#!/usr/bin/env python3
"""Generates the FueLoop PNG app icons (192, 512) and logo-120.png using only the
standard library (zlib + struct) — no Pillow/npm dependency needed.

Same mark as icons/logo.svg: a coral→amber diagonal gradient with a white
infinity loop (lemniscate). The square is
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

# Geometry in the 64-unit space of logo.svg: a lemniscate (infinity loop)
# x = a*cos t/(1+sin^2 t), y = a*sin t*cos t/(1+sin^2 t), centred at 32,32.
CX, CY, A, STROKE = 32.0, 32.0, 22.0, 5.0
N_POINTS = 240
CURVE = []
for _i in range(N_POINTS):
    _t = 2 * math.pi * _i / N_POINTS
    _d = 1 + math.sin(_t) ** 2
    CURVE.append((CX + A * math.cos(_t) / _d, CY + A * math.sin(_t) * math.cos(_t) / _d))
SEGMENTS = list(zip(CURVE, CURVE[1:] + CURVE[:1]))
# Bounding box of the curve (inflated by half the stroke) to skip far pixels fast.
BX0, BX1 = CX - A - STROKE, CX + A + STROKE
BY0, BY1 = CY - A * 0.36 - STROKE, CY + A * 0.36 + STROKE


def dist_to_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def is_mark(u, v):
    if not (BX0 <= u <= BX1 and BY0 <= v <= BY1):
        return False
    half = STROKE / 2
    for (x1, y1), (x2, y2) in SEGMENTS:
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
    write_png(os.path.join(out_dir, 'logo-120.png'), 120)  # Google consent screen logo (full-bleed, same mark)
    print('wrote icon-192.png, icon-512.png and logo-120.png')
