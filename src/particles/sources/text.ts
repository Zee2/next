import type { PointShape } from '../types';
import { sampleCanvas, type RasterSampleOptions } from './raster';

export interface TextOptions extends RasterSampleOptions {
  /** CSS font-family list. Web fonts must be declared on the page (e.g. a Google Fonts link). */
  font?: string;
  weight?: string | number;
  italic?: boolean;
  /** Size relative to fitting the view (1 = fills it, 0.5 = half as big). */
  size?: number;
  /** Opacity multiplier for the text's points. Text is dense, so it defaults lighter. */
  opacity?: number;
  /** Particle density multiplier for the text (fewer, more distinct points below 1). */
  density?: number;
  /** Extra space between letters, in em. */
  letterSpacing?: number;
  /** Line height as a multiple of the font size. */
  lineHeight?: number;
  /** Raster font size in px; higher = more accurate but slower to sample. */
  resolution?: number;
}

/** Text (multi-line via "\n") → points. Emoji and single glyphs work too. */
export async function textShape(text: string, opts: TextOptions = {}): Promise<PointShape> {
  const {
    font = 'Inter, "Helvetica Neue", system-ui, sans-serif',
    weight = 800,
    italic = false,
    size = 1,
    opacity = 0.27,
    density = 0.45,
    letterSpacing = 0,
    lineHeight = 1.05,
    resolution = 220,
    ...sample
  } = opts;
  const fontStr = `${italic ? 'italic ' : ''}${weight} ${resolution}px ${font}`;
  try {
    await document.fonts.load(fontStr, text);
  } catch {
    /* fall back to whatever is available */
  }

  const lines = text.split('\n');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const setup = () => {
    ctx.font = fontStr;
    ctx.letterSpacing = `${letterSpacing * resolution}px`;
  };
  setup();
  const pad = resolution * 0.25;
  const widths = lines.map((l) => ctx.measureText(l).width);
  canvas.width = Math.ceil(Math.max(1, ...widths) + pad * 2);
  canvas.height = Math.ceil(lines.length * resolution * lineHeight + pad * 2);

  // Resizing resets context state.
  setup();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.fillText(line, canvas.width / 2, pad + (i + 0.5) * resolution * lineHeight);
  });

  return { ...sampleCanvas(canvas, sample), scale: size, opacity, density };
}
