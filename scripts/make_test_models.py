"""Generate small synthetic point clouds in each supported format for testing the loader.

    python3 scripts/make_test_models.py public/models
"""

import math
import random
import struct
import sys
from pathlib import Path

SH_C0 = 0.28209479177387814
random.seed(7)


def hsv(h, s, v):
    i = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]


def trefoil(n):
    """Tube around a trefoil knot, rainbow coloured along its length."""
    pts = []
    for _ in range(n):
        t = random.random() * 2 * math.pi
        cx, cy, cz = math.sin(t) + 2 * math.sin(2 * t), math.cos(t) - 2 * math.cos(2 * t), -math.sin(3 * t)
        a = random.random() * 2 * math.pi
        r = 0.35 * math.sqrt(random.random()) ** 0.3
        # Cheap tube offset: random direction scaled, good enough for a test cloud.
        ox, oy, oz = math.cos(a) * r, math.sin(a) * r, (random.random() - 0.5) * r
        rgb = hsv(t / (2 * math.pi), 0.7, 1.0)
        pts.append((cx + ox, cy + oy, cz + oz, rgb))
    return pts


def galaxy(n):
    pts = []
    for _ in range(n):
        arm = random.randrange(3)
        d = random.random() ** 1.5 * 3
        ang = arm * 2 * math.pi / 3 + d * 1.6 + random.gauss(0, 0.18)
        x, z = math.cos(ang) * d, math.sin(ang) * d
        y = random.gauss(0, 0.08 * (1.2 - d / 3))
        rgb = hsv(0.08 + d / 6, 0.6, 1.0 - d / 5)
        pts.append((x, y, z, rgb))
    return pts


def planet(n):
    """Planet + ring, written y-down like real 3DGS output, with some faint floaters."""
    pts = []
    for i in range(n):
        if i < n * 0.6:
            u, v = random.uniform(-1, 1), random.random() * 2 * math.pi
            s = math.sqrt(1 - u * u)
            x, y, z = s * math.cos(v), u, s * math.sin(v)
            band = 0.5 + 0.5 * math.sin(u * 14)
            rgb = (0.9, 0.55 + 0.25 * band, 0.3 + 0.2 * band)
            scale, opacity = 0.012, 0.95
        elif i < n * 0.97:
            a, r = random.random() * 2 * math.pi, random.uniform(1.4, 2.1)
            x, y, z = math.cos(a) * r, random.gauss(0, 0.01), math.sin(a) * r
            # Tilt the ring.
            y, z = y * 0.94 - z * 0.34, y * 0.34 + z * 0.94
            rgb = (0.75, 0.8, 0.95)
            scale, opacity = 0.008, 0.8
        else:
            x, y, z = (random.uniform(-6, 6) for _ in range(3))
            rgb, scale, opacity = (1, 1, 1), 0.05, 0.05
        pts.append((x, -y, z, rgb, scale, opacity))  # y-down
    return pts


def write_plain_binary(path, pts):
    header = (
        "ply\nformat binary_little_endian 1.0\ncomment test cloud\n"
        f"element vertex {len(pts)}\nproperty float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "element face 1\nproperty list uchar int vertex_indices\nend_header\n"
    )
    with open(path, "wb") as f:
        f.write(header.encode())
        for x, y, z, (r, g, b) in pts:
            f.write(struct.pack("<fffBBB", x, y, z, int(r * 255), int(g * 255), int(b * 255)))
        f.write(struct.pack("<Biii", 3, 0, 1, 2))


def write_ascii(path, pts):
    with open(path, "w") as f:
        f.write(
            "ply\nformat ascii 1.0\n"
            f"element vertex {len(pts)}\nproperty float x\nproperty float y\nproperty float z\n"
            "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
        )
        for x, y, z, (r, g, b) in pts:
            f.write(f"{x:.4f} {y:.4f} {z:.4f} {int(r * 255)} {int(g * 255)} {int(b * 255)}\n")


def write_3dgs(path, pts):
    props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    props += [f"f_rest_{i}" for i in range(9)]
    props += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {len(pts)}\n"
    header += "".join(f"property float {p}\n" for p in props) + "end_header\n"
    with open(path, "wb") as f:
        f.write(header.encode())
        for x, y, z, rgb, scale, opacity in pts:
            dc = [(c - 0.5) / SH_C0 for c in rgb]
            logit = math.log(opacity / (1 - opacity))
            ls = math.log(scale)
            row = [x, y, z, 0, 0, 0, *dc, *([0.0] * 9), logit, ls, ls, ls, 1, 0, 0, 0]
            f.write(struct.pack(f"<{len(row)}f", *row))


def write_splat(path, pts):
    with open(path, "wb") as f:
        for x, y, z, rgb, scale, opacity in pts:
            rgba = [int(c * 255) for c in rgb] + [int(opacity * 255)]
            f.write(struct.pack("<ffffffBBBBBBBB", x, y, z, scale, scale, scale, *rgba, 255, 128, 128, 128))


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "public/models")
    out.mkdir(parents=True, exist_ok=True)
    write_plain_binary(out / "knot.ply", trefoil(80_000))
    write_ascii(out / "galaxy_ascii.ply", galaxy(50_000))
    p = planet(80_000)
    write_3dgs(out / "planet_3dgs.ply", p)
    write_splat(out / "planet.splat", p)
    for f in sorted(out.iterdir()):
        print(f"{f}  {f.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
