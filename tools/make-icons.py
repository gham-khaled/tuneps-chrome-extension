#!/usr/bin/env python3
"""Generate the extension's PNG icons.

Dependency free on purpose: the extension ships no build step and no image
library, so the two PNGs are written straight from a pixel buffer with zlib.

    python3 tools/make-icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

TEAL = (15, 118, 110)
AMBER = (245, 158, 11)
WHITE = (255, 255, 255)

ICONS_DIR = Path(__file__).resolve().parent.parent / "icons"


def rounded_square(x: float, y: float, radius: float) -> bool:
    """True when (x, y) in the unit square lies inside a rounded square."""
    dx = max(radius - x, x - (1.0 - radius), 0.0)
    dy = max(radius - y, y - (1.0 - radius), 0.0)
    return dx * dx + dy * dy <= radius * radius


def shade(u: float, v: float) -> tuple[int, int, int, int]:
    """Colour for normalised coordinates u, v in [0, 1)."""
    if not rounded_square(u, v, 0.22):
        return (0, 0, 0, 0)

    # Arrow shaft.
    if 0.44 <= u <= 0.56 and 0.20 <= v <= 0.58:
        return WHITE + (255,)

    # Arrow head: a triangle narrowing as v grows.
    if 0.54 <= v <= 0.74:
        half = 0.22 * (0.74 - v) / 0.20
        if abs(u - 0.5) <= half:
            return WHITE + (255,)

    # Tray under the arrow.
    if 0.78 <= v <= 0.86 and 0.24 <= u <= 0.76:
        return AMBER + (255,)

    return TEAL + (255,)


def render(size: int) -> bytes:
    """Supersampled RGBA raster, 2x2 samples per pixel."""
    rows = bytearray()
    for py in range(size):
        rows.append(0)  # PNG filter type 0 for this scanline
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in (0.25, 0.75):
                for sx in (0.25, 0.75):
                    r, g, b, a = shade((px + sx) / size, (py + sy) / size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            alpha = acc[3] // 4
            if alpha == 0:
                rows.extend((0, 0, 0, 0))
            else:
                rows.extend(
                    (
                        min(255, acc[0] // acc[3]),
                        min(255, acc[1] // acc[3]),
                        min(255, acc[2] // acc[3]),
                        alpha,
                    )
                )
    return bytes(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int) -> None:
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(render(size), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"wrote {path} ({len(png)} bytes)")


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for size in (48, 128):
        write_png(ICONS_DIR / f"icon{size}.png", size)


if __name__ == "__main__":
    main()
