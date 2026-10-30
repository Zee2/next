"""Sample a coloured point cloud from a glTF binary (.glb) mesh and write a binary PLY.

    python3 scripts/glb_to_ply.py in.glb out.ply [--texture color.jpg] [--points 100000]

Needs numpy (and Pillow for --texture). Uses the first primitive of each mesh,
ignores node transforms, and samples triangles uniformly by area.
"""

import argparse
import json
import struct

import numpy as np

COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    data = open(path, "rb").read()
    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + json_len])
    bin_start = 20 + json_len + 8
    return gltf, data[bin_start:]


def accessor(gltf, binary, index):
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    dtype = COMPONENT[acc["componentType"]]
    width = WIDTH[acc["type"]]
    offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    arr = np.frombuffer(binary, dtype=dtype, count=acc["count"] * width, offset=offset)
    return arr.reshape(acc["count"], width) if width > 1 else arr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("out")
    ap.add_argument("--texture")
    ap.add_argument("--points", type=int, default=100_000)
    args = ap.parse_args()

    gltf, binary = read_glb(args.glb)
    prim = gltf["meshes"][0]["primitives"][0]
    pos = accessor(gltf, binary, prim["attributes"]["POSITION"]).astype(np.float64)
    tris = accessor(gltf, binary, prim["indices"]).astype(np.int64).reshape(-1, 3)
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)

    rng = np.random.default_rng(1)
    pick = rng.choice(len(tris), size=args.points, p=area / area.sum())
    r1, r2 = rng.random(args.points), rng.random(args.points)
    flip = r1 + r2 > 1
    r1[flip], r2[flip] = 1 - r1[flip], 1 - r2[flip]
    w = np.stack([1 - r1 - r2, r1, r2], axis=1)
    pts = (w[:, :, None] * pos[tris[pick]]).sum(axis=1)

    colors = np.full((args.points, 3), 200, dtype=np.uint8)
    if args.texture and "TEXCOORD_0" in prim["attributes"]:
        from PIL import Image

        img = np.asarray(Image.open(args.texture).convert("RGB"))
        uv = accessor(gltf, binary, prim["attributes"]["TEXCOORD_0"]).astype(np.float64)
        uvs = (w[:, :, None] * uv[tris[pick]]).sum(axis=1)
        h, wd = img.shape[:2]
        px = np.clip((uvs[:, 0] % 1) * wd, 0, wd - 1).astype(int)
        py = np.clip((uvs[:, 1] % 1) * h, 0, h - 1).astype(int)
        colors = img[py, px]

    rec = np.empty(args.points, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    rec["x"], rec["y"], rec["z"] = pts.T
    rec["r"], rec["g"], rec["b"] = colors.T
    header = (
        f"ply\nformat binary_little_endian 1.0\ncomment sampled from {args.glb.split('/')[-1]}\n"
        f"element vertex {args.points}\nproperty float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
    )
    with open(args.out, "wb") as f:
        f.write(header.encode())
        f.write(rec.tobytes())
    print(f"wrote {args.out}: {args.points} points")


if __name__ == "__main__":
    main()
