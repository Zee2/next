/**
 * General point-cloud loader. Reads only position, colour, opacity and size from:
 *  - PLY (ascii / binary little- or big-endian) with plain `red green blue` colours and an
 *    optional per-point `size` (e.g. from scripts/optimize_model.mjs)
 *  - PLY written by 3D Gaussian Splatting (`f_dc_*`, `opacity`, `scale_*`)
 *  - antimatter15-style `.splat` (32 bytes/point)
 * Everything else (rotation, higher-order SH, faces…) is ignored.
 */
export interface RawPointCloud {
  count: number;
  positions: Float32Array; // xyz
  colors: Float32Array; // rgba 0–1
  /** World-space size per point, if the format provides one. */
  sizes?: Float32Array;
  /** True for Gaussian-splat sources (they are usually y-down). */
  isSplat: boolean;
}

const SH_C0 = 0.28209479177387814;

export async function loadPointCloud(url: string): Promise<RawPointCloud> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return parsePointCloud(await res.arrayBuffer(), url);
}

export function parsePointCloud(buffer: ArrayBuffer, nameHint = ''): RawPointCloud {
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)));
  if (magic.startsWith('ply')) return parsePly(buffer);
  if (/\.splat$/i.test(nameHint) || buffer.byteLength % 32 === 0) return parseSplat(buffer);
  throw new Error(`Unrecognised point cloud format${nameHint ? `: ${nameHint}` : ''}`);
}

// ---------------------------------------------------------------- .splat

function parseSplat(buffer: ArrayBuffer): RawPointCloud {
  const count = Math.floor(buffer.byteLength / 32);
  const f = new Float32Array(buffer, 0, count * 8);
  const u = new Uint8Array(buffer);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = f[i * 8];
    positions[i * 3 + 1] = f[i * 8 + 1];
    positions[i * 3 + 2] = f[i * 8 + 2];
    sizes[i] = (f[i * 8 + 3] + f[i * 8 + 4] + f[i * 8 + 5]) / 3;
    for (let c = 0; c < 4; c++) colors[i * 4 + c] = u[i * 32 + 24 + c] / 255;
  }
  return { count, positions, colors, sizes, isSplat: true };
}

// ---------------------------------------------------------------- PLY

type PlyType = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const TYPE_ALIASES: Record<string, PlyType> = {
  char: 'int8', int8: 'int8',
  uchar: 'uint8', uint8: 'uint8',
  short: 'int16', int16: 'int16',
  ushort: 'uint16', uint16: 'uint16',
  int: 'int32', int32: 'int32',
  uint: 'uint32', uint32: 'uint32',
  float: 'float32', float32: 'float32',
  double: 'float64', float64: 'float64',
};
const TYPE_SIZE: Record<PlyType, number> = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8 };
const TYPE_MAX: Partial<Record<PlyType, number>> = { uint8: 255, uint16: 65535, int8: 127, int16: 32767 };

interface PlyProperty {
  name: string;
  type: PlyType;
  /** For list properties: the type of the length prefix. */
  countType?: PlyType;
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProperty[];
}

function readValue(view: DataView, offset: number, type: PlyType, le: boolean): number {
  switch (type) {
    case 'int8': return view.getInt8(offset);
    case 'uint8': return view.getUint8(offset);
    case 'int16': return view.getInt16(offset, le);
    case 'uint16': return view.getUint16(offset, le);
    case 'int32': return view.getInt32(offset, le);
    case 'uint32': return view.getUint32(offset, le);
    case 'float32': return view.getFloat32(offset, le);
    case 'float64': return view.getFloat64(offset, le);
  }
}

function parsePly(buffer: ArrayBuffer): RawPointCloud {
  // Header is ascii and ends with "end_header\n" (or \r\n).
  const bytes = new Uint8Array(buffer);
  const headText = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  const endMatch = /end_header\r?\n/.exec(headText);
  if (!endMatch) throw new Error('PLY: missing end_header');
  const headerLen = new TextEncoder().encode(headText.slice(0, endMatch.index + endMatch[0].length)).length;

  let format = '';
  const elements: PlyElement[] = [];
  for (const raw of headText.slice(0, endMatch.index).split(/\r?\n/)) {
    const tok = raw.trim().split(/\s+/);
    if (tok[0] === 'format') format = tok[1];
    else if (tok[0] === 'element') elements.push({ name: tok[1], count: parseInt(tok[2], 10), props: [] });
    else if (tok[0] === 'property') {
      const el = elements[elements.length - 1];
      if (tok[1] === 'list') el.props.push({ name: tok[4], type: TYPE_ALIASES[tok[3]], countType: TYPE_ALIASES[tok[2]] });
      else el.props.push({ name: tok[2], type: TYPE_ALIASES[tok[1]] });
    }
  }

  const vertexIdx = elements.findIndex((e) => e.name === 'vertex');
  if (vertexIdx < 0) throw new Error('PLY: no vertex element');
  const vertex = elements[vertexIdx];
  if (elements.some((e) => e.name === 'chunk') || vertex.props.some((p) => p.name.startsWith('packed_'))) {
    throw new Error('PLY: compressed splat PLY is not supported; export an uncompressed .ply or .splat');
  }

  const n = vertex.count;
  const has = (name: string) => vertex.props.findIndex((p) => p.name === name);
  const pick = (...names: string[]) => names.map(has).find((i) => i >= 0) ?? -1;
  const ix = has('x'), iy = has('y'), iz = has('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY: vertex has no x/y/z');
  const ir = pick('red', 'r', 'diffuse_red'), ig = pick('green', 'g', 'diffuse_green'), ib = pick('blue', 'b', 'diffuse_blue');
  const ia = pick('alpha', 'a');
  const idc = [has('f_dc_0'), has('f_dc_1'), has('f_dc_2')];
  const iop = has('opacity');
  const isc = [has('scale_0'), has('scale_1'), has('scale_2')];
  const isSplat = idc[0] >= 0;
  const hasScale = isc.every((i) => i >= 0);
  const isize = has('size');

  // Read the vertex element into a row of numbers per vertex, then map fields.
  const row = new Float64Array(vertex.props.length);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 4).fill(1);
  const sizes = hasScale || isize >= 0 ? new Float32Array(n) : undefined;
  const norm = (pi: number, v: number) => v / (TYPE_MAX[vertex.props[pi].type] ?? 1);

  const emit = (i: number) => {
    positions[i * 3] = row[ix];
    positions[i * 3 + 1] = row[iy];
    positions[i * 3 + 2] = row[iz];
    if (isSplat) {
      for (let c = 0; c < 3; c++) colors[i * 4 + c] = Math.min(1, Math.max(0, 0.5 + SH_C0 * row[idc[c]]));
    } else if (ir >= 0 && ig >= 0 && ib >= 0) {
      colors[i * 4] = norm(ir, row[ir]);
      colors[i * 4 + 1] = norm(ig, row[ig]);
      colors[i * 4 + 2] = norm(ib, row[ib]);
    }
    if (iop >= 0) colors[i * 4 + 3] = 1 / (1 + Math.exp(-row[iop]));
    else if (ia >= 0) colors[i * 4 + 3] = norm(ia, row[ia]);
    if (sizes) sizes[i] = hasScale ? (Math.exp(row[isc[0]]) + Math.exp(row[isc[1]]) + Math.exp(row[isc[2]])) / 3 : row[isize];
  };

  if (format === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(headerLen));
    const tokens = body.split(/\s+/).filter(Boolean);
    let t = 0;
    for (let e = 0; e < vertexIdx; e++) {
      const el = elements[e];
      for (let k = 0; k < el.count; k++) {
        for (const p of el.props) t += p.countType ? 1 + parseInt(tokens[t], 10) : 1;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let p = 0; p < vertex.props.length; p++) {
        const prop = vertex.props[p];
        if (prop.countType) t += 1 + parseInt(tokens[t], 10);
        else row[p] = parseFloat(tokens[t++]);
      }
      emit(i);
    }
  } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    const le = format === 'binary_little_endian';
    const view = new DataView(buffer);
    let off = headerLen;
    const skipElement = (el: PlyElement) => {
      for (let k = 0; k < el.count; k++) {
        for (const p of el.props) {
          if (p.countType) {
            const len = readValue(view, off, p.countType, le);
            off += TYPE_SIZE[p.countType] + len * TYPE_SIZE[p.type];
          } else off += TYPE_SIZE[p.type];
        }
      }
    };
    for (let e = 0; e < vertexIdx; e++) skipElement(elements[e]);
    for (let i = 0; i < n; i++) {
      for (let p = 0; p < vertex.props.length; p++) {
        const prop = vertex.props[p];
        if (prop.countType) {
          const len = readValue(view, off, prop.countType, le);
          off += TYPE_SIZE[prop.countType] + len * TYPE_SIZE[prop.type];
        } else {
          row[p] = readValue(view, off, prop.type, le);
          off += TYPE_SIZE[prop.type];
        }
      }
      emit(i);
    }
  } else {
    throw new Error(`PLY: unsupported format "${format}"`);
  }

  return { count: n, positions, colors, sizes, isSplat };
}
