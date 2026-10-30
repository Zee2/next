import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import { loadPointCloud, parsePointCloud, type RawPointCloud } from '../loaders/pointCloud';
import { computeBounds, type PointShape } from '../types';

export interface ModelOptions {
  /** Max points kept (random subsample, weighted towards opaque points). */
  maxPoints?: number;
  /** Euler rotation in degrees applied before normalising. Splats default to [180, 0, 0] (they're y-down). */
  rotation?: [number, number, number];
  /** Drop points with opacity below this (splats have many near-invisible floaters). */
  minOpacity?: number;
  /** Percentile (0–0.5) trimmed on each side when computing the frame, and crop outliers beyond it. */
  trim?: number;
  /** How far outside the trimmed box points are kept, as a multiple of its size. 0 disables cropping. */
  crop?: number;
  /** Use per-point sizes from the file (splats). */
  useSizes?: boolean;
  /** Size relative to fitting the view (1 = fills it). */
  scale?: number;
  /** Opacity multiplier for this model's points. */
  opacity?: number;
  /** Particle density multiplier for this model. */
  density?: number;
  /** Multiplier on the field's depth fade for this model (0 turns it off). */
  depthFade?: number;
}

/** Load a .ply / .splat from a URL or an in-memory buffer (e.g. a dropped file). */
export async function modelShape(src: string | ArrayBuffer, opts: ModelOptions & { name?: string } = {}): Promise<PointShape> {
  const raw = typeof src === 'string' ? await loadPointCloud(src) : parsePointCloud(src, opts.name);
  return normalizeCloud(raw, opts);
}

export function normalizeCloud(raw: RawPointCloud, opts: ModelOptions = {}): PointShape {
  const {
    maxPoints = 200_000,
    rotation = raw.isSplat ? [180, 0, 0] : [0, 0, 0],
    minOpacity = raw.isSplat ? 0.2 : 0,
    trim = raw.isSplat ? 0.02 : 0,
    crop = raw.isSplat ? 0.25 : 0,
    useSizes = true,
  } = opts;

  // 1. Opacity filter.
  let keep: number[] = [];
  for (let i = 0; i < raw.count; i++) if (raw.colors[i * 4 + 3] >= minOpacity) keep.push(i);

  // 2. Rotate.
  const m = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(...(rotation.map(THREE.MathUtils.degToRad) as [number, number, number])),
  );
  const v = new THREE.Vector3();
  const pos = new Float32Array(raw.count * 3);
  for (const i of keep) {
    v.fromArray(raw.positions, i * 3).applyMatrix4(m).toArray(pos, i * 3);
  }

  // 3. Robust frame from per-axis percentiles.
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const vals = Float32Array.from(keep, (i) => pos[i * 3 + a]).sort();
    lo[a] = vals[Math.floor(trim * (vals.length - 1))] ?? 0;
    hi[a] = vals[Math.ceil((1 - trim) * (vals.length - 1))] ?? 0;
  }
  if (crop > 0) {
    keep = keep.filter((i) => {
      for (let a = 0; a < 3; a++) {
        const pad = (hi[a] - lo[a]) * crop;
        const x = pos[i * 3 + a];
        if (x < lo[a] - pad || x > hi[a] + pad) return false;
      }
      return true;
    });
  }
  const center = lo.map((l, a) => (l + hi[a]) / 2);
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const scale = 2 / extent;

  // 4. Subsample, favouring opaque points.
  if (keep.length > maxPoints) {
    const keyed = keep.map((i) => ({ i, k: Math.pow(Math.random(), 1 / Math.max(1e-3, raw.colors[i * 4 + 3])) }));
    keyed.sort((a, b) => b.k - a.k);
    keep = keyed.slice(0, maxPoints).map((e) => e.i);
  }

  const n = keep.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 4);
  const sizes = useSizes && raw.sizes ? new Float32Array(n) : undefined;
  keep.forEach((i, j) => {
    for (let a = 0; a < 3; a++) positions[j * 3 + a] = (pos[i * 3 + a] - center[a]) * scale;
    for (let c = 0; c < 4; c++) colors[j * 4 + c] = raw.colors[i * 4 + c];
    if (sizes) sizes[j] = raw.sizes![i];
  });

  // Sizes relative to the median, clamped so a few huge splats don't dominate.
  if (sizes && n > 0) {
    const median = Float32Array.from(sizes).sort()[n >> 1] || 1;
    for (let j = 0; j < n; j++) sizes[j] = THREE.MathUtils.clamp(sizes[j] / median, 0.5, 2.5);
  }

  return { positions, colors, sizes, bounds: computeBounds(positions), is3D: true, scale: opts.scale, opacity: opts.opacity, density: opts.density, depthFade: opts.depthFade };
}

/** Sample points on the surface of any three.js geometry (procedural shapes, loaded meshes…). */
export function geometryShape(geometry: THREE.BufferGeometry, count = 60_000): PointShape {
  const mesh = new THREE.Mesh(geometry);
  const sampler = new MeshSurfaceSampler(mesh).build();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = 2 / Math.max(size.x, size.y, size.z);
  const positions = new Float32Array(count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    sampler.sample(p);
    p.sub(center).multiplyScalar(scale).toArray(positions, i * 3);
  }
  return { positions, bounds: computeBounds(positions), is3D: true };
}
