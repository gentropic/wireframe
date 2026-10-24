// The format adapters: PLY (binary + ascii), OBJ, DXF — fed in odd chunk sizes, checked against the mesh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWfrWriter, openWfr, bytesSource, checkTopology } from '../src/index.js';
import { convertPly } from '../convert/ply.js';
import { convertObj } from '../convert/obj.js';
import { convertDxf } from '../convert/dxf.js';

const te = new TextEncoder();
async function* chunked(u8, size) { for (let p = 0; p < u8.length; p += size) yield u8.slice(p, p + size); }
function cube(s = 10, o = [300000, 7500000, 100]) {
  const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const V = Float64Array.from(P.flatMap((p) => p.map((c, a) => o[a] + c * s)));
  // quads, outward
  const Q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return { V, Q };
}
async function convert(fn, bytes, chunk, opts = {}) {
  const parts = [];
  const wr = createWfrWriter({ write: (b) => { parts.push(b.slice()); } }, opts.writer);
  const st = await fn(chunked(bytes, chunk), wr, { name: 'm', spec: { topology: 'check', ...(opts.spec || {}) } });
  await wr.finish();
  const n = parts.reduce((s, b) => s + b.length, 0), u = new Uint8Array(n); let o = 0; for (const b of parts) { u.set(b, o); o += b.length; }
  return { st, wfr: await openWfr(bytesSource(u)) };
}

function plyBinary(V, Q, colors) {
  const hdr = te.encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${V.length / 3}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${Q.length}\nproperty list uchar int vertex_indices\nproperty uchar quality\nend_header\n`);
  const vb = new Uint8Array((V.length / 3) * 27), dv = new DataView(vb.buffer);
  for (let i = 0; i < V.length / 3; i++) { for (let a = 0; a < 3; a++) dv.setFloat64(27 * i + 8 * a, V[3 * i + a], true); for (let a = 0; a < 3; a++) vb[27 * i + 24 + a] = colors[3 * i + a]; }
  const fparts = Q.map((q, f) => { const b = new Uint8Array(1 + 4 * q.length + 1), d = new DataView(b.buffer); b[0] = q.length; q.forEach((v, i) => d.setInt32(1 + 4 * i, v, true)); b[b.length - 1] = f * 10; return b; });
  const all = [hdr, vb, ...fparts], n = all.reduce((s, b) => s + b.length, 0), u = new Uint8Array(n); let o = 0; for (const b of all) { u.set(b, o); o += b.length; }
  return u;
}

test('PLY binary: quads fan to closed triangles; colours become color.*, face props cell attributes', async () => {
  const { V, Q } = cube();
  const colors = Uint8Array.from({ length: 24 }, (_, i) => i * 10);
  for (const chunk of [7, 64, 1 << 20]) {
    const { st, wfr } = await convert(convertPly, plyBinary(V, Q, colors), chunk);
    const el = wfr.element('m');
    assert.equal(st.triangles, 12);
    assert.equal(el.meta.counts.cells, 12); assert.equal(el.meta.counts.vertices, 8);
    assert.equal(el.meta.topology.closed, true); assert.equal(el.meta.topology.oriented, true);
    assert.ok(Math.abs(el.meta.topology.volume - 1000) < 1e-6);
    const v = await el.readRowGroup('vertices', 0, ['vid', 'color.r', 'color.b']);
    for (let i = 0; i < v.vid.length; i++) { assert.equal(v['color.r'][i], colors[3 * v.vid[i]]); assert.equal(v['color.b'][i], colors[3 * v.vid[i] + 2]); }
    const c = await el.readRowGroup('cells', 0, ['quality']);
    assert.deepEqual([...new Set(c.quality)].sort((a, b) => a - b), [0, 10, 20, 30, 40, 50]);
  }
});

test('PLY ascii, and vertices-only PLY as points', async () => {
  const { V, Q } = cube();
  const txt = `ply\nformat ascii 1.0\ncomment cube\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 6\nproperty list uchar int vertex_indices\nend_header\n`
    + Array.from({ length: 8 }, (_, i) => `${V[3 * i]} ${V[3 * i + 1]} ${V[3 * i + 2]}`).join('\n') + '\n' + Q.map((q) => `4 ${q.join(' ')}`).join('\n') + '\n';
  const { wfr } = await convert(convertPly, te.encode(txt), 13);
  assert.equal(wfr.element('m').meta.topology.closed, true);
  const pts = `ply\nformat ascii 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nproperty float intensity\nend_header\n1 2 3 0.5\n4 5 6 0.25\n7 8 9 1\n`;
  const { wfr: w2 } = await convert(convertPly, te.encode(pts), 5);
  const el = w2.element('m');
  assert.equal(el.kind, 'points'); assert.equal(el.meta.counts.vertices, 3);
  const r = await el.readRowGroup('vertices', 0, ['x', 'intensity']);
  assert.deepEqual([...r.intensity].sort(), [0.25, 0.5, 1]);
});

test('OBJ: polygons, negative indices, v/vt/vn tokens, groups', async () => {
  const { V, Q } = cube();
  let s = '# cube\n';
  for (let i = 0; i < 8; i++) s += `v ${V[3 * i]} ${V[3 * i + 1]} ${V[3 * i + 2]}\n`;
  s += 'vt 0 0\nvn 0 0 1\n';
  Q.forEach((q, f) => { if (f === 3) s += 'g side\n'; s += 'f ' + q.map((v, i) => (f === 1 ? `${v - 8}` : f === 2 ? `${v + 1}/1/1` : `${v + 1}//1`)).join(' ') + '\n'; });
  const { st, wfr } = await convert(convertObj, te.encode(s), 11);
  const el = wfr.element('m');
  assert.equal(st.triangles, 12);
  assert.equal(el.meta.topology.closed, true); assert.equal(el.meta.topology.oriented, true);
  const g = await el.readRowGroup('cells', 0, ['group']);
  assert.deepEqual([...new Set(g.group)].sort(), ['', 'side']);
});

test('DXF: 3DFACE soup welds to a closed solid; layers and strings come through', async () => {
  const { V, Q } = cube();
  const p = (i) => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
  let s = '0\nSECTION\n2\nENTITIES\n';
  Q.forEach((q, f) => {
    const c = q.map(p); // 4-corner 3DFACE (a quad)
    s += `0\n3DFACE\n8\n${f < 3 ? 'ROOF' : 'WALL'}\n62\n${f < 3 ? 1 : 3}\n`;
    c.forEach((xyz, k) => { s += `${10 + k}\n${xyz[0]}\n${20 + k}\n${xyz[1]}\n${30 + k}\n${xyz[2]}\n`; });
  });
  s += '0\nPOLYLINE\n8\nSTRINGS\n66\n1\n70\n8\n';
  for (let i = 0; i < 4; i++) s += `0\nVERTEX\n8\nSTRINGS\n10\n${300000 + i}\n20\n7500000\n30\n${100 + i}\n70\n32\n`;
  s += '0\nSEQEND\n0\nPOINT\n8\nPEGS\n10\n1\n20\n2\n30\n3\n0\nENDSEC\n0\nEOF\n';
  const { st, wfr } = await convert(convertDxf, te.encode(s), 17, { spec: {} });
  assert.equal(st.triangles, 12);
  const tri = wfr.element('m');
  assert.equal(tri.meta.counts.vertices, 8, 'soup welded');
  assert.equal(tri.meta.topology.closed, true); assert.equal(tri.meta.topology.oriented, true);
  const c = await tri.readRowGroup('cells', 0, ['layer', 'color.r']);
  assert.deepEqual([...new Set(c.layer)].sort(), ['ROOF', 'WALL']);
  assert.ok(c['color.r'].includes(255), 'ACI 1 (red) resolved');
  const str = wfr.element('m:strings');
  assert.equal(str.meta.counts.cells, 3); assert.equal(str.meta.counts.vertices, 4);
  assert.equal(wfr.element('m:points').meta.counts.vertices, 1);
});
