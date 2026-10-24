// Polyline order (SPEC §5: line + seq), and soup cells that collapse under welding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dxfModule from '@gcu/dxf';
import { writeWfr, createWfrWriter, openWfr, bytesSource, linesFromPolylines } from '../src/index.js';
import { convertDxf } from '../src/convert.js';

const collect = () => { const parts = []; return { sink: { write: (b) => { parts.push(b.slice()); } }, bytes: () => { const u = new Uint8Array(parts.reduce((s, b) => s + b.length, 0)); let o = 0; for (const b of parts) { u.set(b, o); o += b.length; } return u; } }; };
const P = (pts) => Float64Array.from(pts.flatMap(([x, y, z]) => [512000 + x, 7400000 + y, z]));
const close = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-4);

test('polylines round-trip in order: open, a switchback that revisits a point, a closed loop', async () => {
  const polys = [
    { positions: P([[0, 0, 1], [5, 0, 2], [10, 0, 3]]) },
    { positions: P([[20, 0, 5], [24, 0, 6], [28, 4, 7], [24, 8, 8], [24, 0, 6], [20, -4, 9]]) },   // 5th vertex = 2nd
    { positions: P([[40, 0, 0], [60, 0, 0], [60, 20, 0], [40, 20, 0]]), closed: true },
  ];
  const el = { name: 'strings', kind: 'lines', ...linesFromPolylines(polys), target: 3 };   // tiny bricks: order must survive bricking
  const out = collect();
  await writeWfr(out.sink, { elements: [el] });
  const wfr = await openWfr(bytesSource(out.bytes()));
  const e = wfr.element('strings');
  assert.ok(e.bricks >= 4, `spread over ${e.bricks} bricks`);
  const got = await e.polylines();
  assert.equal(got.length, 3);
  assert.ok(close(got[0].vertices, polys[0].positions) && !got[0].closed);
  assert.ok(close(got[1].vertices, polys[1].positions) && !got[1].closed, 'the switchback keeps its order through the revisited point');
  assert.ok(close(got[2].vertices, polys[2].positions) && got[2].closed, 'the loop is closed and starts where it started');
});

test('DXF polylines through the soup path: welded, ordered, closed', async () => {
  let s = '0\nSECTION\n2\nENTITIES\n';
  s += '0\nLWPOLYLINE\n8\nPIT\n90\n4\n70\n1\n38\n100\n';           // closed lwpolyline at z=100
  for (const [x, y] of [[0, 0], [30, 0], [30, 20], [0, 20]]) s += `10\n${512000 + x}\n20\n${7400000 + y}\n`;
  s += '0\nPOLYLINE\n8\nRAMP\n66\n1\n70\n8\n';
  for (const [x, y, z] of [[0, 50, 1], [10, 50, 2], [10, 60, 3], [0, 60, 4], [10, 50, 2], [20, 50, 5]]) s += `0\nVERTEX\n8\nRAMP\n10\n${512000 + x}\n20\n${7400000 + y}\n30\n${z}\n70\n32\n`;
  s += '0\nSEQEND\n0\nENDSEC\n0\nEOF\n';
  const out = collect();
  const wr = createWfrWriter(out.sink);
  await convertDxf([new TextEncoder().encode(s)], wr, { name: 'd', dxf: dxfModule, spec: { target: 3 } });
  await wr.finish();
  const e = (await openWfr(bytesSource(out.bytes()))).element('d:strings');
  const got = await e.polylines();
  assert.equal(got.length, 2);
  const pit = got[0], ramp = got[1];
  assert.ok(pit.closed && pit.vertices.length === 12, `pit closed with 4 vertices (got ${pit.vertices.length / 3}, closed ${pit.closed})`);
  assert.equal(ramp.closed, false);
  assert.equal(ramp.vertices.length / 3, 6, 'the ramp keeps all 6 vertices in order, through the revisited one');
  assert.equal(ramp.vids[1], ramp.vids[4], 'welding gives the revisited point one vid — order comes from seq, not geometry');
});

test('soup cells that collapse under welding are dropped, leaving no unused rows', async () => {
  const out = collect();
  const wr = createWfrWriter(out.sink);
  const w = wr.element({ name: 't', kind: 'triangles' });
  const T = [
    [0, 0, 0, 10, 0, 0, 0, 10, 0],                 // fine
    [0, 0, 0, 0.00001, 0, 0, 5, 5, 0],             // first two corners 0.01 mm apart → one vertex at 0.1 mm
    [10, 0, 0, 10, 10, 0, 0, 10, 0],               // fine
  ].flat().map((v, i) => v + [512000, 7400000, 0][i % 3]);
  await w.soup(Float64Array.from(T));
  const l = wr.element({ name: 's', kind: 'lines', cellAttributes: { line: 'i32', seq: 'i32' } });
  const S = [[0, 0, 0, 5, 0, 0], [5, 0, 0, 5.00002, 0, 0], [5.00002, 0, 0, 9, 0, 0]].flat().map((v, i) => v + [512000, 7400000, 0][i % 3]);
  await l.soup(Float64Array.from(S), { line: Int32Array.of(0, 0, 0), seq: Int32Array.of(0, 1, 2) });
  await wr.finish();
  const wfr = await openWfr(bytesSource(out.bytes()));
  const t = wfr.element('t');
  assert.equal(t.meta.counts.cells, 2, 'the collapsed triangle is gone');
  const b = await t.readBrick(0, { vid: true });
  const used = new Set(b.cells); assert.equal(used.size, b.x.length, 'every vertex row is used');
  const s2 = wfr.element('s');
  assert.equal(s2.meta.counts.cells, 2, 'the zero-length segment is gone');
  const [line] = await s2.polylines();
  assert.equal(line.vertices.length / 3, 3, 'the line still chains across the gap in seq (0, 2)');
});
