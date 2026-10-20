import os, struct, zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (28, 32, 48)
LINE = (78, 158, 255)
UP = (46, 204, 113)
DOWN = (231, 76, 60)


def blank(w, h, color):
    px = [[list(color) + [255] for _ in range(w)] for _ in range(h)]
    return px


def plot(px, x, y, color, r):
    h = len(px); w = len(px[0])
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            xx, yy = x + dx, y + dy
            if 0 <= xx < w and 0 <= yy < h:
                px[yy][xx] = list(color) + [255]


def line(px, x0, y0, x1, y1, color, r):
    steps = max(abs(x1 - x0), abs(y1 - y0)) * 2 + 1
    for i in range(steps + 1):
        t = i / steps
        x = round(x0 + (x1 - x0) * t)
        y = round(y0 + (y1 - y0) * t)
        plot(px, x, y, color, r)


def make(size):
    px = blank(size, size, BG)
    s = size / 128.0
    r = max(1, round(2 * s))
    # zigzag rising chart line (data points in 0..127 space)
    pts = [(10, 95), (40, 70), (62, 85), (90, 40), (118, 22)]
    pts = [(round(x * s), round(y * s)) for x, y in pts]
    for i in range(len(pts) - 1):
        line(px, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], LINE, r)
    # attention markers
    plot(px, pts[1][0], pts[1][1], DOWN, max(2, round(4 * s)))
    plot(px, pts[3][0], pts[3][1], UP, max(2, round(4 * s)))
    plot(px, pts[4][0], pts[4][1], UP, max(2, round(4 * s)))
    return px


def write_png(path, px):
    h = len(px); w = len(px[0])
    raw = bytearray()
    for row in px:
        raw.append(0)
        for p in row:
            raw.extend(p)
    comp = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
        return c

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))


for size in (16, 48, 128, 192, 512):
    write_png(os.path.join(OUT, f"icon{size}.png"), make(size))
    print("wrote", f"icon{size}.png")
