import type { PointShape } from '../types';
import { loadImage, rasterize, sampleCanvas, type RasterSampleOptions } from './raster';

export interface ImageOptions extends RasterSampleOptions {
  /** Long-side raster size in px. */
  resolution?: number;
}

/**
 * An SVG document (markup string) → points. Any icon/logo SVG works; it is rendered
 * as an image so fills, strokes and transforms all behave as in a browser.
 */
export async function svgShape(svg: string, opts: ImageOptions = {}): Promise<PointShape> {
  const { resolution = 512, ...sample } = opts;
  // Make sure the SVG has an intrinsic size so it rasterises at `resolution`.
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const vb = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const aspect = vb && vb.length === 4 ? vb[2] / vb[3] : 1;
  root.setAttribute('width', String(aspect >= 1 ? resolution : resolution * aspect));
  root.setAttribute('height', String(aspect >= 1 ? resolution / aspect : resolution));
  const markup = new XMLSerializer().serializeToString(root);

  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    return sampleCanvas(rasterize(img, resolution), sample);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Shorthand for a single SVG path `d` string (e.g. copied from an icon set). */
export function pathShape(d: string, viewBox = '0 0 24 24', opts: ImageOptions = {}): Promise<PointShape> {
  return svgShape(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path fill="#fff" d="${d}"/></svg>`, opts);
}

/** A raster image URL (PNG with transparency, or set `luminance`) → points. */
export async function imageShape(src: string, opts: ImageOptions = {}): Promise<PointShape> {
  const { resolution = 512, ...sample } = opts;
  const img = await loadImage(src);
  return sampleCanvas(rasterize(img, resolution), { useColor: true, ...sample });
}
