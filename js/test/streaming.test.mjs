// The streaming writer: output independent of the memory budget; soup welding; strings; streamed topology.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeWfr, createWfrWriter, openWfr, bytesSource, checkTopology } from '../src/index.js';

// scratch "disk" in memory, so tests exercise the spilled path without touching the filesystem
function memoryBacking() {
  const files = new Map();
  const backing = {
    files,
    async open(name) {
      let buf = new Uint8Array(1 << 16), len = 0;
      files.set(name, () => len);
      return {
        write: async (u8, pos) => { if (pos + u8.length > buf.length) { let n = buf.length; while (n < pos + u8.length) n *= 2; const b = new Uint8Array(n); b.set(buf.subarray(0, len)); buf = b; } buf.set(u8, pos); len = Math.max(len, pos + u8.length); },
        read: async (pos, n) => buf.slice(pos, pos + n),
        close: async () => {},
        remove: async () => { files.delete(name); },
      };
    },
  };
  return backing;
}

const collect = () => { const parts = []; return { sink: { write: (b) => { parts.push(b.slice()); } }, bytes: () => { const n = parts.reduce((s, b) => s + b.length, 0), u = new Uint8Array(n); let o = 0; for (const b of parts) { u.set(b, o); o += b.length; } return u; } }; };

const rnd = (() => { let s = 99; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
function sheet(n, ox = 400000, oy = 7000000) {
  const w = n + 1, V = new Float64Array(w * w * 3), F = [];
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) { const q = 3 * (j * w + i); V[q] = ox + i * 2 + rnd() * 0.5; V[q + 1] = oy + j * 2 + rnd() * 0.5; V[q + 2] = 300 + Math.sin(i / 9) * 20; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * w + i, b = a + 1, c = a + w, d = c + 1; F.push(a, b, d, a, d, c); }
  return { V, F: Uint32Array.from(F) };
}
function shuffle(V, F) { // scramble vertex and face order
  const nv = V.length / 3, nf = F.length / 3, vp = Uint32Array.from({ length: nv }, (_, i) => i), fp = Uint32Array.from({ length: nf }, (_, i) => i);
  for (const p of [vp, fp]) for (let i = p.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  const V2 = new Float64Array(V.length), F2 = new Uint32Array(F.length);
  for (let i = 0; i < nv; i++) V2.set(V.subarray(3 * i, 3 * i + 3), 3 * vp[i]);
  for (let f = 0; f < nf; f++) for (let j = 0; j < 3; j++) F2[3 * fp[f] + j] = vp[F[3 * f + j]];
  return { V: V2, F: F2 };
}

test('budget independence: a tiny budget with spills writes the same bytes as unlimited', async () => {
  const { V, F } = shuffle(...Object.values(sheet(150)));
  const nv = V.length / 3, nf = F.length / 3;
  const elev = new Float32Array(nv).map((_, i) => V[3 * i + 2]), dom = new Int32Array(nf).map((_, i) => i % 4);
  const layer = Array.from({ length: nf }, (_, i) => ['ore', 'waste', 'cover'][i % 3]);
  const spec = { elements: [{ name: 'sheet', kind: 'triangles', positions: V, cells: F, target: 3000, topology: 'check', vertexAttributes: { elev }, cellAttributes: { dom, layer } }] };
  const a = collect(); await writeWfr(a.sink, spec);
  const backing = memoryBacking(), b = collect();
  const res = await writeWfr(b.sink, spec, { budget: 256 * 1024, backing });
  assert.ok(res.stats.spilledBytes > 0, 'the small budget really spilled');
  assert.equal(backing.files.size, 0, 'every scratch file was removed');
  assert.deepEqual(b.bytes(), a.bytes());
  const t = (await openWfr(bytesSource(a.bytes()))).manifest.elements[0].topology;
  const ref = checkTopology(V, F);
  assert.equal(t.closed, ref.closed); assert.equal(t.oriented, ref.oriented); assert.equal(t.manifold, ref.manifold);
});

test('soup welds to the same mesh as the indexed input', async () => {
  const { V, F } = shuffle(...Object.values(sheet(60)));
  const nf = F.length / 3, P = new Float64Array(nf * 9);
  for (let f = 0; f < nf; f++) for (let j = 0; j < 3; j++) P.set(V.subarray(3 * F[3 * f + j], 3 * F[3 * f + j] + 3), 9 * f + 3 * j);
  for (const budget of [Infinity, 64 * 1024]) {
    const out = collect();
    const wr = createWfrWriter(out.sink, { budget, backing: memoryBacking() });
    const w = wr.element({ name: 'soup', kind: 'triangles', target: 1000, topology: 'check' });
    for (let s = 0; s < nf; s += 777) await w.soup(P.subarray(9 * s, 9 * Math.min(nf, s + 777)));
    await wr.finish();
    const wfr = await openWfr(bytesSource(out.bytes())), el = wfr.element('soup');
    assert.equal(el.meta.counts.vertices, V.length / 3, `welded every shared corner (budget ${budget})`);
    assert.equal(el.meta.counts.cells, nf);
    assert.deepEqual({ ...el.meta.topology }, { ...checkTopology(V, F), volume: null }, 'an open sheet: closed false, oriented, manifold');
    // each vid has one position, and faces use distinct vids
    const pos = new Map();
    for (let k = 0; k < el.bricks; k++) {
      const b = await el.readBrick(k, { vid: true });
      for (let i = 0; i < b.vid.length; i++) { const key = `${b.x[i]},${b.y[i]},${b.z[i]}`, p = pos.get(b.vid[i]); if (p) assert.equal(p, key); else pos.set(b.vid[i], key); }
      for (let i = 0; i < b.cells.length; i += 3) assert.equal(new Set([b.vid[b.cells[i]], b.vid[b.cells[i + 1]], b.vid[b.cells[i + 2]]]).size, 3);
    }
    assert.equal(pos.size, V.length / 3);
  }
});

test('string attributes round-trip; brickBy a string column', async () => {
  const { V, F } = sheet(40);
  const nf = F.length / 3, layer = Array.from({ length: nf }, (_, i) => (i < nf / 2 ? 'PIT_2024' : 'PIT_2025'));
  const out = collect();
  await writeWfr(out.sink, { elements: [{ name: 'pit', kind: 'triangles', positions: V, cells: F, cellAttributes: { layer }, brickBy: 'layer', target: 500 }] });
  const el = (await openWfr(bytesSource(out.bytes()))).element('pit');
  const seen = new Map();
  for (let k = 0; k < el.bricks; k++) {
    const { layer: L } = await el.readRowGroup('cells', k, ['layer']);
    assert.equal(new Set(L).size, 1, 'one layer per brick');
    seen.set(L[0], (seen.get(L[0]) || 0) + L.length);
    const st = el.tables.cells.footer.rowGroups[k].columns.find((c) => c.name === 'layer');
    assert.equal(st.encodings.includes('RLE_DICTIONARY'), true);
  }
  assert.deepEqual([...seen.entries()].sort(), [['PIT_2024', nf / 2], ['PIT_2025', nf / 2]]);
});

test('nodeBacking disposes only its own fresh directory, never the one it was given', async () => {
  const { nodeBacking } = await import('../src/index.js');
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os');
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wfr-parent-'));
  await fs.writeFile(path.join(parent, 'keep.txt'), 'x');
  const b = await nodeBacking(parent);
  const f = await b.open('s'); await f.write(new Uint8Array([1, 2, 3]), 0); await f.close();
  await b.dispose();
  assert.deepEqual(await fs.readdir(parent), ['keep.txt']);
  const b2 = await nodeBacking(parent); await b2.dispose(); // a second run in the same parent works
  await fs.rm(parent, { recursive: true });
});

test('lines from soup: polylines welded at shared points, segment ids kept', async () => {
  const out = collect();
  const wr = createWfrWriter(out.sink, { budget: 32 * 1024, backing: memoryBacking() });
  const w = wr.element({ name: 'strings', kind: 'lines', cellAttributes: { line: 'i32' }, target: 200 });
  let segs = 0;
  for (let L = 0; L < 50; L++) {
    const n = 30, P = new Float64Array((n - 1) * 6), id = new Int32Array(n - 1).fill(L);
    for (let i = 0; i < n - 1; i++) { P.set([500000 + L * 10, 7000000 + i, 100], 6 * i); P.set([500000 + L * 10, 7000000 + i + 1, 100], 6 * i + 3); }
    await w.soup(P, { line: id });
    segs += n - 1;
  }
  await wr.finish();
  const el = (await openWfr(bytesSource(out.bytes()))).element('strings');
  assert.equal(el.meta.counts.cells, segs);
  assert.equal(el.meta.counts.vertices, 50 * 30, 'consecutive segments share their joint');
});
