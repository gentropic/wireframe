// Build a bench .wfr with the library's writer: a terrain surface (with a colour and an
// elevation-change attribute) and a closed solid whose topology is checked, not declared.
//   node bench/build.mjs [n=2000] [out=bench/out/bench.wfr]
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terrain, lumpySolid, shuffleMesh } from './mesh.mjs';
import { writeWfr } from '../js/src/index.js';

const N = +(process.argv[2] || 2000);
const OUT = process.argv[3] || fileURLToPath(new URL('./out/bench.wfr', import.meta.url));

console.log(`building ${OUT}`);
const t = shuffleMesh(terrain(N)), s = shuffleMesh(lumpySolid(9));
const nv = t.V.length / 3;
const red = new Uint8Array(nv), dz = new Float32Array(nv);
for (let i = 0; i < nv; i++) { red[i] = Math.max(0, Math.min(255, (t.V[3 * i + 2] - 530) * 1.2)); dz[i] = Math.sin(t.V[3 * i] / 50) * 0.3; }

mkdirSync(dirname(OUT), { recursive: true });
const fd = openSync(OUT, 'w');
const t0 = performance.now();
const { size, manifest } = await writeWfr({ write: (b) => { writeSync(fd, b); } }, {
  elements: [
    { name: 'terrain', kind: 'triangles', positions: t.V, cells: t.F, vertexAttributes: { 'color.r': red, dz }, topology: { closed: false, oriented: true, manifold: true } },
    { name: 'solid', kind: 'triangles', positions: s.V, cells: s.F, topology: 'check' },
  ],
  meta: { lineage: { op: 'bench', n: N } },
});
closeSync(fd);
for (const e of manifest.elements) console.log(`  ${e.name}: ${e.counts.vertexRows} vertex rows (${e.counts.bricks} bricks), ${e.counts.cells} faces · ${JSON.stringify(e.topology)}`);
console.log(`wrote ${(size / 1048576).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
