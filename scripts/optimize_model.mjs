/**
 * Bake a point cloud / Gaussian splat into a small web-ready PLY.
 *
 *   node scripts/optimize_model.mjs public/models/me.ply public/models/me-web.ply [--points 65536]
 *
 * Runs the same parse + normalise pipeline the page runs at load (opacity filter, splat flip,
 * outlier crop, opacity-weighted subsample, median-relative sizes) using the app's own code, then
 * keeps only what the renderer reads, quantised:
 *
 *   ushort x, y, z            positions over the cloud's bounding box (6 bytes)
 *   uchar red, green, blue    base colour (3 bytes)
 *   uchar alpha               opacity (1 byte)
 *   uchar size                size relative to the median × 100 (1 byte; the loader re-normalises it)
 *
 * The result is a plain PLY: no splat fields, so the page loads it as-is with no flip/filter/crop.
 * --points should match the field's particle count; extra points are never drawn.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
};
const points = flag('--points', 65536);
const [input, output] = args;
if (!input || !output) {
  console.error('usage: node scripts/optimize_model.mjs <in.ply|in.splat> <out.ply> [--points N]');
  process.exit(1);
}

// Load the app's TypeScript modules through Vite so this matches the runtime exactly.
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { parsePointCloud } = await vite.ssrLoadModule('/src/particles/loaders/pointCloud.ts');
const { normalizeCloud } = await vite.ssrLoadModule('/src/particles/sources/model.ts');
await vite.close();

const file = await readFile(input);
const raw = parsePointCloud(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), input);
const shape = normalizeCloud(raw, { maxPoints: points });
const n = shape.positions.length / 3;
const { min, max } = shape.bounds;

const header = [
  'ply',
  'format binary_little_endian 1.0',
  `comment baked from ${basename(input)} by scripts/optimize_model.mjs`,
  `element vertex ${n}`,
  'property ushort x',
  'property ushort y',
  'property ushort z',
  'property uchar red',
  'property uchar green',
  'property uchar blue',
  'property uchar alpha',
  'property uchar size',
  'end_header',
  '',
].join('\n');

const STRIDE = 11;
const body = Buffer.alloc(n * STRIDE);
const q16 = (v, a) => Math.round(((v - min[a]) / Math.max(1e-9, max[a] - min[a])) * 65535);
const q8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
for (let i = 0; i < n; i++) {
  const o = i * STRIDE;
  for (let a = 0; a < 3; a++) body.writeUInt16LE(q16(shape.positions[i * 3 + a], a), o + a * 2);
  for (let c = 0; c < 4; c++) body[o + 6 + c] = q8(shape.colors[i * 4 + c]);
  body[o + 10] = shape.sizes ? Math.max(1, Math.min(255, Math.round(shape.sizes[i] * 100))) : 100;
}

await writeFile(output, Buffer.concat([Buffer.from(header, 'ascii'), body]));
const mb = (b) => (b / 1e6).toFixed(2) + ' MB';
console.log(`${input}: ${raw.count} points, ${mb(file.byteLength)}`);
console.log(`${output}: ${n} points, ${mb(header.length + body.length)}`);
