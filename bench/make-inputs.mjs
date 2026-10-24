// Large synthetic inputs for the converter: a terrain as a 3DFACE DXF (soup — the hard case)
// and as a binary PLY with colours. Written in streaming fashion; nothing big is held.
//   node bench/make-inputs.mjs [n=1500] [dir=bench/out]
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { terrain } from './mesh.mjs';

const N = +(process.argv[2] || 1500);
const DIR = process.argv[3] || fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(DIR, { recursive: true });
const { V, F } = terrain(N);
const nv = V.length / 3, nf = F.length / 3;
const te = new TextEncoder();

function writer(path) {
  const fd = openSync(path, 'w');
  let buf = [], len = 0;
  return {
    s(str) { buf.push(str); len += str.length; if (len > 1 << 22) this.flush(); },
    b(u8) { this.flush(); writeSync(fd, u8); },
    flush() { if (buf.length) { writeSync(fd, te.encode(buf.join(''))); buf = []; len = 0; } },
    close() { this.flush(); closeSync(fd); },
  };
}

// DXF: one 3DFACE per triangle (4th corner = 3rd), two layers by elevation, coordinates at mm
const t0 = performance.now();
const d = writer(DIR + `terrain-${N}.dxf`);
d.s('0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n');
const f3 = (v) => v.toFixed(3);
for (let f = 0; f < nf; f++) {
  const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
  const layer = V[a + 2] > 660 ? 'TOPO_HIGH' : 'TOPO_LOW';
  d.s(`0\n3DFACE\n8\n${layer}\n10\n${f3(V[a])}\n20\n${f3(V[a + 1])}\n30\n${f3(V[a + 2])}\n11\n${f3(V[b])}\n21\n${f3(V[b + 1])}\n31\n${f3(V[b + 2])}\n12\n${f3(V[c])}\n22\n${f3(V[c + 1])}\n32\n${f3(V[c + 2])}\n13\n${f3(V[c])}\n23\n${f3(V[c + 1])}\n33\n${f3(V[c + 2])}\n`);
}
d.s('0\nENDSEC\n0\nEOF\n');
d.close();
console.log(`terrain-${N}.dxf: ${nf} 3DFACEs (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// PLY: binary little-endian, double xyz + uchar rgb, int faces
const t1 = performance.now();
const p = writer(DIR + `terrain-${N}.ply`);
p.s(`ply\nformat binary_little_endian 1.0\nelement vertex ${nv}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`);
p.flush();
const CH = 1 << 16;
for (let s = 0; s < nv; s += CH) {
  const n = Math.min(CH, nv - s), b = new Uint8Array(27 * n), dv = new DataView(b.buffer);
  for (let i = 0; i < n; i++) { const v = 3 * (s + i); dv.setFloat64(27 * i, V[v], true); dv.setFloat64(27 * i + 8, V[v + 1], true); dv.setFloat64(27 * i + 16, V[v + 2], true); const g = Math.max(0, Math.min(255, (V[v + 2] - 530) * 1.2)) | 0; b[27 * i + 24] = g; b[27 * i + 25] = 255 - g; b[27 * i + 26] = 90; }
  p.b(b);
}
for (let s = 0; s < nf; s += CH) {
  const n = Math.min(CH, nf - s), b = new Uint8Array(13 * n), dv = new DataView(b.buffer);
  for (let i = 0; i < n; i++) { b[13 * i] = 3; for (let j = 0; j < 3; j++) dv.setInt32(13 * i + 1 + 4 * j, F[3 * (s + i) + j], true); }
  p.b(b);
}
p.close();
console.log(`terrain-${N}.ply: ${nv} vertices, ${nf} faces (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
