/**
 * A set of target points the particle field can morph into.
 * Everything a source (text, SVG, image, model…) produces is reduced to this.
 */
export interface PointShape {
  /** xyz triplets, roughly centred on the origin. */
  positions: Float32Array;
  /** Optional rgba (0–1) per point. When omitted the field's palette is used. */
  colors?: Float32Array;
  /** Optional relative size multiplier per point (1 = default). */
  sizes?: Float32Array;
  /** Axis-aligned extent, used to frame the camera. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** 3D shapes get slow auto-rotation; flat ones only sway. */
  is3D?: boolean;
  /** Multiplier on the automatic fit-to-view (1 = fills the view). */
  scale?: number;
  /** Opacity multiplier for this shape's points (on top of the field's `opacity`). */
  opacity?: number;
  /** Particle density multiplier for this shape (on top of the field's `density`). */
  density?: number;
  /** Multiplier on the field's `depthFade` for this shape (default 1; 0 turns it off). */
  depthFade?: number;
}

export function pointCount(shape: PointShape): number {
  return shape.positions.length / 3;
}

export function computeBounds(positions: Float32Array): PointShape['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
