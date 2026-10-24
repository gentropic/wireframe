// Build a bench .wfr: a terrain surface and a closed solid as two triangle elements.
// Parquet tables are written by hyparquet-writer (a dev dependency; the library's own writer comes later).
//   node bench/build.mjs [n=2000] [out=bench/out/bench.wfr]
import { parquetWriteBuffer } from 'hyparquet-writer';
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terrain, lumpySolid, shuffleMesh, mortonFaceOrder, buildBricks, bbox } from './mesh.mjs';
import { createZipWriter } from '../js/src/zip.js';
import { MIMETYPE } from '../js/src/wfr.js';

const N = +(process.argv[2] || 2000);
const OUT = process.argv[3] || fileURLToPath(new URL('./out/bench.wfr', import.meta.url));
const STEP = 1e-4, TARGET = 65536, BLOCK = 16 * 1024 * 1024;
const te = new TextEncoder();

async function sha256Blocks(b) {
  const out = [];
  for (let p = 0; p < b.length; p += BLOCK) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b.subarray(p, Math.min(b.length, p + BLOCK))));
    out.push(Array.from(d, (x) => x.toString(16).padStart(2, '0')).join(''));
  }
  return out;
}

function buildElement(name, mesh, topology) {
  const t0 = performance.now();
  const m = shuffleMesh(mesh), br = buildBricks(m, mortonFaceOrder(m), TARGET);
  const b = bbox(m.V), origin = [Math.floor(b[0]), Math.floor(b[1]), Math.floor(b[2])];
  const nr = br.rows, nf = br.faces.length / 3;
  const X = new Int32Array(nr), Y = new Int32Array(nr), Z = new Int32Array(nr);
  for (let r = 0; r < nr; r++) {
    const v = 3 * br.vid[r];
    X[r] = Math.round((m.V[v] - origin[0]) / STEP); Y[r] = Math.round((m.V[v + 1] - origin[1]) / STEP); Z[r] = Math.round((m.V[v + 2] - origin[2]) / STEP);
  }
  const A = new Int32Array(nf), B = new Int32Array(nf), C = new Int32Array(nf);
  for (let f = 0; f < nf; f++) { A[f] = br.faces[3 * f]; B[f] = br.faces[3 * f + 1]; C[f] = br.faces[3 * f + 2]; }
  const coords = { mode: 'grid', origin, step: STEP };
  const kv = (table) => [{ key: 'wireframe', value: JSON.stringify({ version: '0.1', element: name, kind: 'triangles', table, ...(table === 'vertices' ? { coords } : {}) }) }];
  const col = (n, data) => ({ name: n, data, type: 'INT32', encoding: 'DELTA_BINARY_PACKED', nullable: false });
  const write = (columnData, rowGroupSize, table) => new Uint8Array(parquetWriteBuffer({ columnData, codec: 'UNCOMPRESSED', rowGroupSize, statistics: true, kvMetadata: kv(table) }));
  const vertices = write([col('x', X), col('y', Y), col('z', Z), col('vid', Int32Array.from(br.vid))], Array.from(br.vCount), 'vertices');
  const cells = write([col('a', A), col('b', B), col('c', C)], Array.from(br.fCount), 'cells');
  const directory = [];
  for (let k = 0; k < br.nb; k++) {
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let r = br.vStart[k], e = r + br.vCount[k]; r < e; r++) {
      const q = [X[r], Y[r], Z[r]];
      for (let a = 0; a < 3; a++) { if (q[a] < bb[a]) bb[a] = q[a]; if (q[a] > bb[a + 3]) bb[a + 3] = q[a]; }
    }
    directory.push([br.vCount[k], br.fCount[k], bb.map((v, i) => origin[i % 3] + STEP * v)]);
  }
  const path = `elements/${encodeURIComponent(name)}/`;
  console.log(`  ${name}: ${nr} vertex rows (${br.nb} bricks), ${nf} faces · vertices ${(vertices.length / 1048576).toFixed(1)} MB, cells ${(cells.length / 1048576).toFixed(1)} MB · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return {
    manifest: {
      name, path, kind: 'triangles', coords,
      counts: { vertices: m.V.length / 3, vertexRows: nr, cells: nf, bricks: br.nb },
      bbox: b, topology: { ...topology, status: 'declared' },
      bricks: { order: { by: [], then: 'morton' }, target: TARGET, directory },
      columns: [], meta: {},
    },
    members: [[path + 'vertices.parquet', vertices], [path + 'cells.parquet', cells]],
  };
}

console.log(`building ${OUT}`);
const els = [
  buildElement('terrain', terrain(N), { closed: false, oriented: true, manifold: true, volume: null }),
  buildElement('solid', lumpySolid(9), { closed: true, oriented: true, manifold: true, volume: null }),
];
mkdirSync(dirname(OUT), { recursive: true });
const fd = openSync(OUT, 'w');
const zw = createZipWriter({ write: (b) => { writeSync(fd, b); } });
await zw.add('mimetype', te.encode(MIMETYPE), { aligned: false });
const members = {};
for (const el of els) for (const [name, data] of el.members) {
  await zw.add(name, data);
  members[name] = { size: data.length, block: BLOCK, sha256: await sha256Blocks(data) };
}
const manifest = { format: 'wireframe', version: '0.1', frame: { origin: els[0].manifest.coords.origin, crs: null, units: 'm' }, elements: els.map((e) => e.manifest), members, meta: { lineage: { op: 'bench', n: N } } };
await zw.add('wireframe.json', te.encode(JSON.stringify(manifest)));
const { size } = await zw.finish();
closeSync(fd);
console.log(`wrote ${(size / 1048576).toFixed(1)} MB`);
