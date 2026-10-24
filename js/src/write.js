// Writing .wfr files. Whole elements in memory for now (positions + cells + attributes);
// a streaming writer for elements too large for that comes later (SPEC §7.2 allows any bricking).
import { createZipWriter } from './zip.js';
import { writeParquet } from './parquet-write.js';
import { bbox, mortonOrder, groupOrder, buildBricks } from './bricks.js';
import { checkTopology } from './topology.js';
import { MIMETYPE } from './wfr.js';

const KIND_K = { points: 0, lines: 2, triangles: 3 };
const CELL_COLS = { lines: ['a', 'b'], triangles: ['a', 'b', 'c'] };
const RESERVED = new Set(['x', 'y', 'z', 'vid', 'a', 'b', 'c']);
const BLOCK = 16 * 1024 * 1024;
const te = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Blocks(b, block = BLOCK) {
  const out = [];
  for (let p = 0; p < b.length; p += block) out.push(hex(await crypto.subtle.digest('SHA-256', b.subarray(p, Math.min(b.length, p + block)))));
  return out;
}

// Typed array → { type, logical, data, encoding } for a Parquet attribute column.
function attrColumn(name, src, perm) {
  const n = perm.length;
  const gather = (Out) => { const o = new Out(n); for (let i = 0; i < n; i++) o[i] = src[perm[i]]; return o; };
  if (src instanceof Float64Array) return { name, type: 'DOUBLE', encoding: 'BYTE_STREAM_SPLIT', data: gather(Float64Array) };
  if (src instanceof Float32Array) return { name, type: 'FLOAT', encoding: 'BYTE_STREAM_SPLIT', data: gather(Float32Array) };
  const logical = src instanceof Uint8Array || src instanceof Uint8ClampedArray ? 'UINT8' : src instanceof Uint16Array ? 'UINT16'
    : src instanceof Int8Array ? 'INT8' : src instanceof Int16Array ? 'INT16' : src instanceof Int32Array ? undefined : null;
  if (logical === null) throw new Error(`wfr write: attribute "${name}" has unsupported array type ${src?.constructor?.name}`);
  return { name, type: 'INT32', encoding: 'DELTA_BINARY_PACKED', logical, data: gather(Int32Array) };
}

function coordsFor(box, opt) {
  if (opt?.mode === 'float64') return { mode: 'float64' };
  const step = opt?.step ?? 1e-4;
  const origin = opt?.origin ?? [Math.floor(box[0]), Math.floor(box[1]), Math.floor(box[2])];
  const s = Array.isArray(step) ? step : [step, step, step];
  for (let a = 0; a < 3; a++) {
    const lo = Math.round((box[a] - origin[a]) / s[a]), hi = Math.round((box[a + 3] - origin[a]) / s[a]);
    if (lo < -2147483648 || hi > 2147483647) throw new Error(`wfr write: step ${s[a]} overflows INT32 on axis ${'xyz'[a]} — use a coarser step or coords.mode "float64"`);
  }
  return { mode: 'grid', origin, step };
}

// One element → { manifest entry, members: [[name, bytes]] }.
//   el = { name, kind, positions: Float64Array(3n) world, cells?: Uint32Array|Int32Array (k per cell),
//          vertexAttributes?: { name: TypedArray(n) }, cellAttributes?: { name: TypedArray(m) },
//          coords?: { mode, step, origin }, topology?: 'check' | {…declared}, brickBy?: cell attribute name,
//          target?: 65536, keepVid?: bool (points), meta? }
export function buildElement(el) {
  const k = KIND_K[el.kind];
  if (k === undefined) throw new Error(`wfr write: element "${el.name}" kind "${el.kind}"`);
  const V = el.positions, nv = V.length / 3, cells = k ? el.cells : null;
  if (k && (!cells || cells.length % k)) throw new Error(`wfr write: element "${el.name}" needs cells with ${k} indices each`);
  const m = k ? cells.length / k : nv;
  if (k) for (let i = 0; i < cells.length; i++) if (cells[i] >= nv) throw new Error(`wfr write: element "${el.name}" cell index ${cells[i]} ≥ ${nv} vertices`);
  const vAttrs = el.vertexAttributes || {}, cAttrs = el.cellAttributes || {};
  for (const n of [...Object.keys(vAttrs), ...Object.keys(cAttrs)]) if (RESERVED.has(n)) throw new Error(`wfr write: attribute name "${n}" is reserved`);
  if (k === 0 && Object.keys(cAttrs).length) throw new Error('wfr write: points elements have no cells — put attributes on vertices');

  const box = nv ? bbox(V) : null;
  const coords = coordsFor(box || [0, 0, 0, 0, 0, 0], el.coords);
  const target = el.target ?? 65536;
  let order = nv ? mortonOrder(V, cells, k, box) : new Uint32Array(0);
  let codes = null;
  if (el.brickBy) {
    const src = k ? cAttrs[el.brickBy] : vAttrs[el.brickBy];
    if (!src) throw new Error(`wfr write: brickBy "${el.brickBy}" is not a ${k ? 'cell' : 'vertex'} attribute`);
    const uniq = [...new Set(src)].sort((a, b) => a - b), map = new Map(uniq.map((v, i) => [v, i]));
    codes = new Uint32Array(src.length); for (let i = 0; i < src.length; i++) codes[i] = map.get(src[i]);
    order = groupOrder(order, codes, uniq.length);
  }
  const br = buildBricks(nv, cells, k, order, target, codes);

  // vertex table
  const rows = br.rows, X = new (coords.mode === 'grid' ? Int32Array : Float64Array)(rows);
  const Y = new X.constructor(rows), Z = new X.constructor(rows);
  const s = coords.mode === 'grid' ? (Array.isArray(coords.step) ? coords.step : [coords.step, coords.step, coords.step]) : null;
  for (let r = 0; r < rows; r++) {
    const v = 3 * br.vid[r];
    if (s) { X[r] = Math.round((V[v] - coords.origin[0]) / s[0]); Y[r] = Math.round((V[v + 1] - coords.origin[1]) / s[1]); Z[r] = Math.round((V[v + 2] - coords.origin[2]) / s[2]); }
    else { X[r] = V[v]; Y[r] = V[v + 1]; Z[r] = V[v + 2]; }
  }
  const ct = s ? { type: 'INT32', encoding: 'DELTA_BINARY_PACKED' } : { type: 'DOUBLE', encoding: 'BYTE_STREAM_SPLIT' };
  const vcols = [{ name: 'x', data: X, ...ct }, { name: 'y', data: Y, ...ct }, { name: 'z', data: Z, ...ct }];
  const keepVid = k > 0 || el.keepVid;
  if (keepVid) vcols.push({ name: 'vid', type: 'INT32', encoding: 'DELTA_BINARY_PACKED', data: br.vid });
  for (const [n, a] of Object.entries(vAttrs)) {
    if (a.length !== nv) throw new Error(`wfr write: vertex attribute "${n}" has ${a.length} values, expected ${nv}`);
    vcols.push(attrColumn(n, a, br.vid));
  }
  const kvFor = (table) => ({ wireframe: JSON.stringify({ version: '0.1', element: el.name, kind: el.kind, table, ...(table === 'vertices' ? { coords } : {}) }) });
  const path = `elements/${encodeURIComponent(el.name)}/`;
  const members = [[path + 'vertices.parquet', writeParquet({ columns: vcols, rowGroups: br.vCount, kv: kvFor('vertices') })]];

  // cell table
  if (k) {
    const names = CELL_COLS[el.kind];
    const ccols = names.map((n, j) => { const d = new Int32Array(m); for (let i = 0; i < m; i++) d[i] = br.cells[k * i + j]; return { name: n, type: 'INT32', encoding: 'DELTA_BINARY_PACKED', data: d }; });
    for (const [n, a] of Object.entries(cAttrs)) {
      if (a.length !== m) throw new Error(`wfr write: cell attribute "${n}" has ${a.length} values, expected ${m}`);
      ccols.push(attrColumn(n, a, br.cellOrder));
    }
    members.push([path + 'cells.parquet', writeParquet({ columns: ccols, rowGroups: br.cCount, kv: kvFor('cells') })]);
  }

  // brick directory (world bboxes from the stored values)
  const directory = [];
  for (let b = 0, r0 = 0; b < br.vCount.length; r0 += br.vCount[b], b++) {
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], C = [X, Y, Z];
    for (let r = r0, e = r0 + br.vCount[b]; r < e; r++) for (let a = 0; a < 3; a++) { const q = C[a][r]; if (q < bb[a]) bb[a] = q; if (q > bb[a + 3]) bb[a + 3] = q; }
    directory.push([br.vCount[b], br.cCount[b], s ? bb.map((q, i) => coords.origin[i % 3] + s[i % 3] * q) : bb]);
  }
  let topology;
  if (el.kind === 'triangles') topology = el.topology === 'check' ? checkTopology(V, cells) : { closed: null, oriented: null, manifold: null, volume: null, ...(el.topology || {}), status: 'declared' };
  const columns = [
    ...Object.keys(vAttrs).map((n) => ({ location: 'vertices', name: n, member: 'vertices.parquet' })),
    ...Object.keys(cAttrs).map((n) => ({ location: 'cells', name: n, member: 'cells.parquet' })),
  ];
  const manifest = {
    name: el.name, path, kind: el.kind, coords,
    counts: { vertices: nv, vertexRows: rows, cells: k ? m : 0, bricks: br.vCount.length },
    bbox: box, ...(topology ? { topology } : {}),
    bricks: { order: { by: el.brickBy ? [el.brickBy] : [], then: 'morton' }, target, directory },
    columns, meta: el.meta || {},
  };
  return { manifest, members };
}

// Write a .wfr to sink ({ write(Uint8Array) }). → { size, manifest }
export async function writeWfr(sink, { elements, frame = null, meta = {} }) {
  const names = new Set();
  for (const e of elements) {
    const name = e.manifest ? e.manifest.name : e.name;
    if (!name) throw new Error('wfr write: element without a name');
    if (names.has(name)) throw new Error(`wfr write: duplicate element "${name}"`);
    names.add(name);
  }
  const zw = createZipWriter(sink);
  await zw.add('mimetype', te.encode(MIMETYPE), { aligned: false });
  const members = {}, manifests = [];
  for (const e of elements) {
    const built = e.manifest && e.members ? e : buildElement(e);
    for (const [name, data] of built.members) {
      await zw.add(name, data);
      members[name] = { size: data.length, block: BLOCK, sha256: await sha256Blocks(data) };
    }
    manifests.push(built.manifest);
  }
  const f = frame || { origin: manifests.find((m) => m.coords.origin)?.coords.origin || [0, 0, 0], crs: null, units: 'm' };
  const manifest = { format: 'wireframe', version: '0.1', frame: { units: 'm', crs: null, ...f }, elements: manifests, members, meta };
  await zw.add('wireframe.json', te.encode(JSON.stringify(manifest)));
  const { size } = await zw.finish();
  return { size, manifest };
}
