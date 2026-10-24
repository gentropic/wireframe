// Build a bench .wfr with the library's own writer: a terrain surface (with a colour and an
// elevation-change attribute) and a closed solid whose topology is checked, not declared.
//   node bench/build.mjs [n=2000] [out=bench/out/bench.wfr]
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terrain, lumpySolid, shuffleMesh } from './mesh.mjs';
import { writeWfr, buildElement } from '../js/src/index.js';

const N = +(process.argv[2] || 2000);
const OUT = process.argv[3] || fileURLToPath(new URL('./out/bench.wfr', import.meta.url));

console.log(`building ${OUT}`);
const t = shuffleMesh(terrain(N)), s = shuffleMesh(lumpySolid(9));
const nv = t.V.length / 3;
const red = new Uint8Array(nv), dz = new Float32Array(nv);
for (let i = 0; i < nv; i++) { red[i] = Math.max(0, Math.min(255, (t.V[3 * i + 2] - 530) * 1.2)); dz[i] = Math.sin(t.V[3 * i] / 50) * 0.3; }

const els = [];
for (const [spec, label] of [
  [{ name: 'terrain', kind: 'triangles', positions: t.V, cells: t.F, vertexAttributes: { 'color.r': red, dz }, topology: { closed: false, oriented: true, manifold: true } }, 'terrain'],
  [{ name: 'solid', kind: 'triangles', positions: s.V, cells: s.F, topology: 'check' }, 'solid (topology checked)'],
]) {
  const t0 = performance.now();
  const built = buildElement(spec);
  const ms = performance.now() - t0, m = built.manifest;
  console.log(`  ${label}: ${m.counts.vertexRows} vertex rows (${m.counts.bricks} bricks), ${m.counts.cells} faces · ${built.members.map(([n, b]) => `${n.split('/').pop()} ${(b.length / 1048576).toFixed(1)} MB`).join(', ')} · ${(ms / 1000).toFixed(2)} s${m.topology.status === 'checked' ? ` · ${JSON.stringify(m.topology)}` : ''}`);
  els.push(built);
}
mkdirSync(dirname(OUT), { recursive: true });
const fd = openSync(OUT, 'w');
const t0 = performance.now();
const { size } = await writeWfr({ write: (b) => { writeSync(fd, b); } }, { elements: els, meta: { lineage: { op: 'bench', n: N } } });
closeSync(fd);
console.log(`wrote ${(size / 1048576).toFixed(1)} MB (zip + hashes ${((performance.now() - t0) / 1000).toFixed(2)} s)`);
