#!/usr/bin/env python3
"""Generates simple solid PNG app icons (192 and 512) using only the
standard library (zlib + struct) — no Pillow/npm dependency needed.

Draws a rounded teal square with a white checkmark, roughly matching the
app's green/checked-day motif.
"""
import struct
import zlib
import os

BG = (13, 110, 100)       # dark teal
FG = (255, 255, 255)      # white checkmark
ACCENT = (46, 125, 50)    # green circle behind the check


def make_icon(size):
    pixels = [[BG for _ in range(size)] for _ in range(size)]
    cx, cy = size / 2, size / 2
    r = size * 0.36

    def in_circle(x, y):
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

    def near_segment(px, py, x1, y1, x2, y2, width):
        dx, dy = x2 - x1, y2 - y1
        length2 = dx * dx + dy * dy
        if length2 == 0:
            return False
        t = max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / length2))
        proj_x, proj_y = x1 + t * dx, y1 + t * dy
        dist2 = (px - proj_x) ** 2 + (py - proj_y) ** 2
        return dist2 <= (width / 2) ** 2

    # checkmark endpoints, scaled to icon size
    x1, y1 = size * 0.30, size * 0.52
    x2, y2 = size * 0.44, size * 0.66
    x3, y3 = size * 0.72, size * 0.36
    stroke = max(4, size * 0.07)

    corner_r = size * 0.18

    for y in range(size):
        for x in range(size):
            # rounded-corner square mask
            in_corner_zone = (
                (x < corner_r and y < corner_r) or
                (x > size - corner_r and y < corner_r) or
                (x < corner_r and y > size - corner_r) or
                (x > size - corner_r and y > size - corner_r)
            )
            if in_corner_zone:
                cxx = corner_r if x < corner_r else size - corner_r
                cyy = corner_r if y < corner_r else size - corner_r
                if (x - cxx) ** 2 + (y - cyy) ** 2 > corner_r * corner_r:
                    pixels[y][x] = None  # transparent-ish (rendered as bg page colour)
                    continue

            if in_circle(x, y):
                pixels[y][x] = ACCENT
            if near_segment(x, y, x1, y1, x2, y2, stroke) or near_segment(x, y, x2, y2, x3, y3, stroke):
                pixels[y][x] = FG

    return pixels


def write_png(path, size):
    pixels = make_icon(size)
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # no filter
        for x in range(size):
            p = pixels[y][x]
            if p is None:
                raw.extend((BG[0], BG[1], BG[2], 0))
            else:
                raw.extend((p[0], p[1], p[2], 255))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out_dir = os.path.dirname(os.path.abspath(__file__))
    write_png(os.path.join(out_dir, 'icon-192.png'), 192)
    write_png(os.path.join(out_dir, 'icon-512.png'), 512)
    print('wrote icon-192.png and icon-512.png')
