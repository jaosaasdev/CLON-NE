"""Gera os icones PNG da extensao (16/48/128) sem dependencias externas.

Renderiza em 4x com supersampling e reduz para obter antialiasing.
Execute:  python tools/generate_icons.py
"""

import os
import struct
import zlib

SS = 4  # fator de supersampling

BG_TOP = (99, 102, 241)     # indigo-500
BG_BOTTOM = (14, 165, 233)  # sky-500
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_rect_alpha(x, y, x0, y0, x1, y1, r):
    """Retorna 1.0 se o ponto (x, y) esta dentro do retangulo arredondado."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return 0.0
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return 1.0 if (dx * dx + dy * dy) <= r * r else 0.0


def render(size):
    s = size * SS
    px = [[(0, 0, 0, 0)] * s for _ in range(s)]

    pad = s * 0.05
    radius = s * 0.24

    # Geometria do simbolo de "clone": dois retangulos deslocados.
    back = (s * 0.24, s * 0.22, s * 0.64, s * 0.62)
    front = (s * 0.36, s * 0.34, s * 0.78, s * 0.76)
    br = s * 0.07
    stroke = max(s * 0.055, 1.0)

    # Seta de download dentro do retangulo da frente.
    ax = (front[0] + front[2]) / 2
    a_top = front[1] + s * 0.06
    a_bottom = front[3] - s * 0.09
    shaft_w = s * 0.045
    head_w = s * 0.13
    head_h = s * 0.10

    for yy in range(s):
        y = yy + 0.5
        t = y / s
        bg = (
            int(lerp(BG_TOP[0], BG_BOTTOM[0], t)),
            int(lerp(BG_TOP[1], BG_BOTTOM[1], t)),
            int(lerp(BG_TOP[2], BG_BOTTOM[2], t)),
        )
        row = px[yy]
        for xx in range(s):
            x = xx + 0.5
            if not rounded_rect_alpha(x, y, pad, pad, s - pad, s - pad, radius):
                continue

            color = bg

            # Contorno do retangulo de tras (apenas a borda visivel).
            inside_back = rounded_rect_alpha(x, y, *back, br)
            inner_back = rounded_rect_alpha(
                x, y, back[0] + stroke, back[1] + stroke, back[2] - stroke, back[3] - stroke, br
            )
            inside_front = rounded_rect_alpha(x, y, *front, br)
            gap_front = rounded_rect_alpha(
                x,
                y,
                front[0] - stroke,
                front[1] - stroke,
                front[2] + stroke,
                front[3] + stroke,
                br,
            )

            if inside_back and not inner_back and not gap_front:
                color = WHITE

            if inside_front:
                color = WHITE
                in_shaft = abs(x - ax) <= shaft_w / 2 and a_top <= y <= a_bottom - head_h * 0.2
                prog = (y - (a_bottom - head_h)) / head_h if head_h else 0
                in_head = (
                    a_bottom - head_h <= y <= a_bottom
                    and abs(x - ax) <= (head_w / 2) * (1 - max(0.0, min(1.0, prog)))
                )
                if in_shaft or in_head:
                    color = (
                        int(lerp(BG_TOP[0], BG_BOTTOM[0], t)),
                        int(lerp(BG_TOP[1], BG_BOTTOM[1], t)),
                        int(lerp(BG_TOP[2], BG_BOTTOM[2], t)),
                    )

            row[xx] = (color[0], color[1], color[2], 255)

    # Downsample (media dos blocos SS x SS) para gerar antialiasing.
    out = bytearray()
    for y in range(size):
        out.append(0)  # filtro PNG "none"
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    pr, pg, pb, pa = px[y * SS + dy][x * SS + dx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = SS * SS
            if a == 0:
                out += bytes((0, 0, 0, 0))
            else:
                out += bytes((r // a, g // a, b // a, a // n))
    return bytes(out)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


if __name__ == "__main__":
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(base, exist_ok=True)
    for dim in (16, 48, 128):
        target = os.path.normpath(os.path.join(base, f"icon{dim}.png"))
        write_png(target, dim, render(dim))
        print("gerado:", target)
