// Round trips through the library's own writer and reader.   node --test js/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeWfr, openWfr, bytesSource, checkTopology, writeParquet, parseFooter, decodeChunk } from '../src/index.js';

async function roundtrip(spec) {
  const parts = [];
  await writeWfr({ write: (b) => { parts.push(b.slice()); } }, spec);
  const n = parts.reduce((s, b) => s + b.length, 0), u8 = new Uint8Array(n);
  let o = 0; for (const b of parts) { u8.set(b, o); o += b.length; }
  return { bytes: u8, wfr: await openWfr(bytesSource(u8)) };
}

// world positions of every vertex row of an element, plus cells mapped back to world triples
async function readAll(el) {
  const s = el.coords.mode === 'grid' ? [].concat(el.coords.step).flatMap((x, _, a) => (a.length === 1 ? [x, x, x] : [x])) : null;
  const out = { rows: [], cells: [] };
  for (let k = 0; k < el.bricks; k++) {
    const b = await el.readBrick(k, { vid: el.kind !== 'points' });
    const pos = (i) => (s ? [el.coords.origin[0] + s[0] * b.x[i], el.coords.origin[1] + s[1] * b.y[i], el.coords.origin[2] + s[2] * b.z[i]] : [b.x[i], b.y[i], b.z[i]]);
    for (let i = 0; i < b.x.length; i++) out.rows.push({ vid: b.vid?.[i], p: pos(i) });
    if (b.cells) { const kk = el.kind === 'lines' ? 2 : 3; for (let i = 0; i < b.cells.length; i += kk) out.cells.push(Array.from(b.cells.subarray(i, i + kk), (r) => b.vid[r])); }
  }
  return out;
}

const rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();

function grid(n, ox = 400000, oy = 7000000) {
  const w = n + 1, V = new Float64Array(w * w * 3), F = [];
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) { const k = 3 * (j * w + i); V[k] = ox + i + rnd() * 0.3; V[k + 1] = oy + j + rnd() * 0.3; V[k + 2] = 500 + Math.sin(i / 7) * 10; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * w + i, b = a + 1, c = a + w, d = c + 1; F.push(a, b, d, a, d, c); }
  return { V, F: Uint32Array.from(F) };
}

function cube(s = 10, o = [300000, 7500000, 100]) {
  const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const V = Float64Array.from(P.flatMap((p) => p.map((c, a) => o[a] + c * s)));
  const F = Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { V, F };
}

test('triangles: geometry, welding by vid, brick invariant, attributes', async () => {
  const { V, F } = grid(120);
  const nf = F.length / 3, nv = V.length / 3;
  const elev = new Float64Array(nv).map((_, i) => V[3 * i + 2] * 2);
  const domain = new Int32Array(nf).map((_, i) => (i * 7) % 5);
  const rgb = new Uint8Array(nf).map((_, i) => i % 256);
  const { wfr } = await roundtrip({ elements: [{ name: 'topo', kind: 'triangles', positions: V, cells: F, target: 4096, vertexAttributes: { elev }, cellAttributes: { domain, 'color.r': rgb } }] });
  const el = wfr.element('topo');
  assert.equal(el.meta.counts.cells, nf);
  assert.equal(el.meta.counts.vertices, nv);
  assert.ok(el.bricks > 5);
  const all = await readAll(el);
  // every row reproduces its vertex within step/2
  for (const r of all.rows) for (let a = 0; a < 3; a++) assert.ok(Math.abs(r.p[a] - V[3 * r.vid + a]) <= 0.5e-4 + 1e-9);
  // the multiset of faces (as vid triples, rotation-normalized) is unchanged
  const norm = (t) => { const m = t.indexOf(Math.min(...t)); return [t[m], t[(m + 1) % 3], t[(m + 2) % 3]].join(','); };
  const want = []; for (let f = 0; f < nf; f++) want.push(norm([F[3 * f], F[3 * f + 1], F[3 * f + 2]]));
  assert.deepEqual(all.cells.map(norm).sort(), want.sort());
  // attributes ride the same permutation
  let row = 0;
  for (let k = 0; k < el.bricks; k++) {
    const v = await el.readRowGroup('vertices', k, ['vid', 'elev']);
    for (let i = 0; i < v.vid.length; i++) assert.equal(v.elev[i], elev[v.vid[i]]);
    const c = await el.readRowGroup('cells', k, ['a', 'domain', 'color.r']);
    row += c.a.length;
    for (let i = 0; i < c.domain.length; i++) assert.ok(c.domain[i] >= 0 && c.domain[i] < 5 && c['color.r'][i] >= 0 && c['color.r'][i] < 256);
  }
  assert.equal(row, nf);
});

test('brickBy: every brick holds one value, and footer stats prove it', async () => {
  const { V, F } = grid(60);
  const nf = F.length / 3, lode = new Int32Array(nf).map((_, i) => (i % 3) * 10);
  const { wfr } = await roundtrip({ elements: [{ name: 'g', kind: 'triangles', positions: V, cells: F, target: 2048, cellAttributes: { lode }, brickBy: 'lode' }] });
  const el = wfr.element('g');
  assert.deepEqual(el.meta.bricks.order.by, ['lode']);
  for (const rg of el.tables.cells.footer.rowGroups) { const c = rg.columns.find((x) => x.name === 'lode'); assert.equal(c.min, c.max); }
});

test('points and lines; float64 mode is lossless', async () => {
  const n = 5000, P = new Float64Array(3 * n).map(() => 512000 + rnd() * 1000);
  const S = new Uint32Array(2 * (n - 1)).map((_, i) => (i >> 1) + (i & 1));
  const id = new Int32Array(n).map((_, i) => i * 3);
  const { wfr } = await roundtrip({ elements: [
    { name: 'pegs', kind: 'points', positions: P, coords: { mode: 'float64' }, target: 512, vertexAttributes: { id } },
    { name: 'string', kind: 'lines', positions: P, cells: S, target: 512 },
  ] });
  const pegs = wfr.element('pegs');
  assert.equal(pegs.tables.cells, undefined);
  const seen = new Set();
  for (let k = 0; k < pegs.bricks; k++) {
    const b = await pegs.readRowGroup('vertices', k, ['x', 'y', 'z', 'id']);
    for (let i = 0; i < b.x.length; i++) { const v = b.id[i] / 3; seen.add(v); assert.equal(b.x[i], P[3 * v]); assert.equal(b.z[i], P[3 * v + 2]); }
  }
  assert.equal(seen.size, n);
  const lines = await readAll(wfr.element('string'));
  assert.equal(lines.cells.length, n - 1);
  for (const [a, b] of lines.cells) assert.equal(Math.abs(a - b), 1);
});

test('topology: an open sheet, a closed cube, a flipped face', async () => {
  const g = grid(10);
  assert.deepEqual(checkTopology(g.V, g.F), { closed: false, oriented: true, manifold: true, volume: null, status: 'checked' });
  const c = cube(10);
  const t = checkTopology(c.V, c.F);
  assert.equal(t.closed, true); assert.equal(t.oriented, true); assert.equal(t.manifold, true);
  assert.ok(Math.abs(t.volume - 1000) < 1e-6, `volume ${t.volume}`);
  const flipped = c.F.slice(); [flipped[1], flipped[2]] = [flipped[2], flipped[1]];
  const tf = checkTopology(c.V, flipped);
  assert.equal(tf.closed, true); assert.equal(tf.oriented, false); assert.equal(tf.volume, null);
  // two cubes sharing only a vertex: closed, oriented, NOT manifold (bow-tie vertex)
  const c2 = cube(10, [300010, 7500010, 110]);
  const V2 = new Float64Array([...c.V, ...c2.V]); const F2 = Uint32Array.from([...c.F, ...c2.F].map((x, i) => (i >= 36 ? x + 8 : x)));
  // weld c2's vertex 0 onto c's vertex 6 (same position)
  for (let i = 36; i < F2.length; i++) if (F2[i] === 8) F2[i] = 6;
  const tb = checkTopology(V2, F2);
  assert.equal(tb.closed, true); assert.equal(tb.manifold, false);
});

test('manifest: block hashes match the members; topology "check" lands in the manifest', async () => {
  const c = cube(5);
  const { bytes, wfr } = await roundtrip({ elements: [{ name: 'cube', kind: 'triangles', positions: c.V, cells: c.F, topology: 'check' }] });
  assert.equal(wfr.manifest.elements[0].topology.status, 'checked');
  assert.ok(Math.abs(wfr.manifest.elements[0].topology.volume - 125) < 1e-6);
  for (const [name, m] of Object.entries(wfr.manifest.members)) {
    const { offset, size } = await wfr.zip.dataRange(wfr.zip.entries.get(name));
    assert.equal(size, m.size);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(offset, offset + size)));
    assert.equal(Array.from(d, (x) => x.toString(16).padStart(2, '0')).join(''), m.sha256[0]);
    assert.equal(offset % 64, 0, `${name} data is 64-byte aligned`);
  }
});

test('parquet writer: delta round-trips extreme int32 deltas and partial miniblocks', async () => {
  const n = 1000 + 37, a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i % 3 === 0 ? -2147483648 : i % 3 === 1 ? 2147483647 : (i * 7919) | 0;
  const d = new Float64Array(n).map((_, i) => Math.sin(i) * 1e6);
  const bytes = await writeParquet({ columns: [{ name: 'a', type: 'INT32', encoding: 'DELTA_BINARY_PACKED', data: a }, { name: 'd', type: 'DOUBLE', encoding: 'BYTE_STREAM_SPLIT', data: d }], rowGroups: [500, 537] });
  const f = parseFooter(bytes, bytes.length);
  const outA = new Int32Array(n), outD = new Float64Array(n);
  let o = 0;
  for (const rg of f.rowGroups) {
    for (const c of rg.columns) decodeChunk(bytes.subarray(c.start, c.start + c.length), c, c.name === 'a' ? outA : outD, o);
    o += rg.numRows;
  }
  assert.deepEqual(outA, a); assert.deepEqual(outD, d);
  assert.equal(f.rowGroups[0].columns[0].min, -2147483648); assert.equal(f.rowGroups[0].columns[0].max, 2147483647);
});
