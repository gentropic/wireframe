// Wavefront OBJ → .wfr element, streamed line by line. v (optionally with r g b colours),
// f (any polygon, fan-triangulated; v, v/vt, v//vn, v/vt/vn; negative = relative), o/g → a
// "group" cell attribute. Texture coordinates, normals, lines and materials are not kept.
import { lines } from './bytes-in.js';

const BATCH = 65536;

/** convertObj(chunks, writer, { name, spec }) — adds one triangles element. */
export async function convertObj(chunks, writer, { name = 'mesh', spec = {} } = {}) {
  let w = null, hasColor = false, nv = 0, group = '';
  let P = [], C = [], I = [], G = [];
  const stats = { vertices: 0, faces: 0, triangles: 0, skipped: 0, ignored: {} };
  const ensure = () => {
    if (!w) w = writer.element({ name, kind: 'triangles', ...spec, vertexAttributes: hasColor ? { 'color.r': 'u8', 'color.g': 'u8', 'color.b': 'u8' } : {}, cellAttributes: { group: 'string' } });
    return w;
  };
  const flushV = async () => {
    if (!P.length) return;
    const n = P.length / 3, attrs = {};
    if (hasColor) for (let a = 0; a < 3; a++) { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = C[3 * i + a]; attrs[['color.r', 'color.g', 'color.b'][a]] = o; }
    await ensure().vertices(Float64Array.from(P), attrs);
    P = []; C = [];
  };
  const flushF = async () => {
    if (!I.length) return;
    await flushV(); // faces may only reference vertices already pushed
    await ensure().cells(Uint32Array.from(I), { group: G });
    I = []; G = [];
  };
  for await (const batch of lines(chunks)) {
    for (const raw of batch) {
      const l = raw.trim();
      if (!l || l[0] === '#') continue;
      const sp = l.indexOf(' '), tag = sp < 0 ? l : l.slice(0, sp);
      if (tag === 'v') {
        const t = l.split(/\s+/);
        if (!stats.vertices && t.length >= 7) hasColor = true;
        P.push(+t[1], +t[2], +t[3]);
        if (hasColor) { const s = t.length >= 7 && +t[4] <= 1 && +t[5] <= 1 && +t[6] <= 1 ? 255 : 1; C.push(Math.round(+t[4] * s) || 0, Math.round(+t[5] * s) || 0, Math.round(+t[6] * s) || 0); }
        nv++; stats.vertices++;
        if (P.length >= 3 * BATCH) await flushV();
      } else if (tag === 'f') {
        const t = l.split(/\s+/), idx = [];
        for (let i = 1; i < t.length; i++) { const v = parseInt(t[i], 10); idx.push(v < 0 ? nv + v : v - 1); }
        stats.faces++;
        if (idx.length < 3 || idx.some((v) => !(v >= 0))) { stats.skipped++; continue; }
        for (let k = 1; k + 1 < idx.length; k++) {
          if (idx[0] === idx[k] || idx[k] === idx[k + 1] || idx[0] === idx[k + 1]) { stats.skipped++; continue; }
          I.push(idx[0], idx[k], idx[k + 1]); G.push(group); stats.triangles++;
        }
        if (I.length >= 3 * BATCH) await flushF();
      } else if (tag === 'o' || tag === 'g') {
        group = l.slice(sp + 1).trim();
      } else stats.ignored[tag] = (stats.ignored[tag] || 0) + 1;
    }
  }
  await flushV(); await flushF();
  if (!w) throw new Error('obj: no geometry');
  return stats;
}
