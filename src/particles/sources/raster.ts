import { computeBounds, type PointShape } from '../types';

export interface RasterSampleOptions {
  /** Number of points to sample. */
  count?: number;
  /** Alpha (0–255) a pixel needs to count as "inside". */
  threshold?: number;
  /** Keep the source pixel colours instead of using the field palette. */
  useColor?: boolean;
  /** Random z thickness (in normalised units, shape width ≈ 2). */
  depth?: number;
  /** 0–1: extra probability weight for pixels near an edge, for crisper outlines. */
  edgeBias?: number;
  /** When set, sample by luminance instead of alpha (for images without transparency). */
  luminance?: 'bright' | 'dark';
}

/**
 * Sample points from the "ink" of a canvas. Shared by text, SVG and image sources.
 * Output is centred and scaled so the larger dimension spans [-1, 1].
 */
export function sampleCanvas(canvas: HTMLCanvasElement, opts: RasterSampleOptions = {}): PointShape {
  const { count = 65536, threshold = 128, useColor = false, depth = 0.04, edgeBias = 0.35, luminance } = opts;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;

  const inkAt = (i: number) => {
    if (!luminance) return data[i * 4 + 3];
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    const v = luminance === 'bright' ? l : 255 - l;
    return (v * data[i * 4 + 3]) / 255;
  };

  // Collect inside pixels and a sampling weight (edges weighted up).
  const idx: number[] = [];
  const weights: number[] = [];
  const step = 2; // neighbour distance for edge detection
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (inkAt(i) < threshold) continue;
      let edge = 0;
      if (edgeBias > 0) {
        const n =
          (x >= step && inkAt(i - step) < threshold ? 1 : 0) +
          (x < w - step && inkAt(i + step) < threshold ? 1 : 0) +
          (y >= step && inkAt(i - step * w) < threshold ? 1 : 0) +
          (y < h - step && inkAt(i + step * w) < threshold ? 1 : 0);
        edge = n > 0 ? 1 : 0;
      }
      idx.push(i);
      weights.push(1 + edge * edgeBias * 8);
    }
  }

  if (idx.length === 0) {
    return { positions: new Float32Array(3), bounds: computeBounds(new Float32Array(3)) };
  }

  // Inside-pixel bounding box, so the shape is centred on its ink rather than the canvas.
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const i of idx) {
    const x = i % w, y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX + 1) / 2;
  const cy = (minY + maxY + 1) / 2;
  const scale = 2 / Math.max(maxX - minX + 1, maxY - minY + 1);

  // Cumulative weights for weighted sampling with replacement.
  const cdf = new Float64Array(weights.length);
  let acc = 0;
  for (let k = 0; k < weights.length; k++) cdf[k] = acc += weights[k];

  const positions = new Float32Array(count * 3);
  const colors = useColor ? new Float32Array(count * 4) : undefined;
  for (let p = 0; p < count; p++) {
    const r = Math.random() * acc;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const i = idx[lo];
    const x = (i % w) + Math.random();
    const y = ((i / w) | 0) + Math.random();
    positions[p * 3] = (x - cx) * scale;
    positions[p * 3 + 1] = -(y - cy) * scale;
    positions[p * 3 + 2] = (Math.random() - 0.5) * depth;
    if (colors) {
      colors[p * 4] = data[i * 4] / 255;
      colors[p * 4 + 1] = data[i * 4 + 1] / 255;
      colors[p * 4 + 2] = data[i * 4 + 2] / 255;
      colors[p * 4 + 3] = 1;
    }
  }

  return { positions, colors, bounds: computeBounds(positions) };
}

/** Draw an image-like source onto a canvas, fitted inside `resolution` px on its long side. */
export function rasterize(source: CanvasImageSource & { width: number; height: number }, resolution = 512): HTMLCanvasElement {
  const s = resolution / Math.max(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * s));
  canvas.height = Math.max(1, Math.round(source.height * s));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}
