// bench meshes — synthetic meshes, Morton face ordering, brick builder.
// Everything is typed arrays; meshes are { V: Float64Array(3n), F: Uint32Array(3m) } in WORLD (UTM-ish) coords.

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function permutation(n, r) {
  const p = new Uint32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  return p;
}

// scramble vertex numbering and face order — real files arrive in arbitrary order
export function shuffleMesh(mesh, seed = 7) {
  const r = rng(seed), nv = mesh.V.length / 3, nf = mesh.F.length / 3;
  const vp = permutation(nv, r), fp = permutation(nf, r);
  const V = new Float64Array(mesh.V.length), F = new Uint32Array(mesh.F.length);
  for (let i = 0; i < nv; i++) { const j = vp[i]; V[3 * j] = mesh.V[3 * i]; V[3 * j + 1] = mesh.V[3 * i + 1]; V[3 * j + 2] = mesh.V[3 * i + 2]; }
  for (let f = 0; f < nf; f++) { const g = fp[f]; F[3 * g] = vp[mesh.F[3 * f]]; F[3 * g + 1] = vp[mesh.F[3 * f + 1]]; F[3 * g + 2] = vp[mesh.F[3 * f + 2]]; }
  return { V, F };
}

// a terrain surface: (n+1)² jittered survey-ish points, 2n² triangles, at UTM-ish coordinates
export function terrain(n, { ox = 302117.31, oy = 7804409.87, spacing = 1.0, seed = 3 } = {}) {
  const r = rng(seed), w = n + 1;
  const V = new Float64Array(w * w * 3);
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const k = 3 * (j * w + i);
    const x = ox + i * spacing + (r() - 0.5) * 0.6 * spacing, y = oy + j * spacing + (r() - 0.5) * 0.6 * spacing;
    const u = x - ox, v = y - oy;
    V[k] = x; V[k + 1] = y;
    V[k + 2] = 640 + 85 * Math.sin(u / 710) * Math.cos(v / 930) + 22 * Math.sin(u / 97 + v / 131) + 4 * Math.sin(u / 13) * Math.sin(v / 17) + (r() - 0.5) * 0.08;
  }
  const F = new Uint32Array(n * n * 6);
  let f = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
    F[f++] = a; F[f++] = b; F[f++] = d; F[f++] = a; F[f++] = d; F[f++] = c;
  }
  return { V, F };
}

// a closed, lumpy solid: icosphere subdivided `level` times (20·4^level triangles), welded exactly
export function lumpySolid(level, { cx = 305012.4, cy = 7806030.2, cz = 410.7, radius = 300, seed = 5 } = {}) {
  const t = (1 + Math.sqrt(5)) / 2;
  let P = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const nfinal = 20 * 4 ** level, nvfinal = 10 * 4 ** level + 2;
  const Pf = new Float64Array(nvfinal * 3); Pf.set(P.map((x, i) => x));
  let nv = 12;
  let Fa = Uint32Array.from(F);
  for (let L = 0; L < level; L++) {
    const mid = new Map(), nfa = Fa.length / 3, Fn = new Uint32Array(nfa * 12);
    const m = (a, b) => {
      const key = a < b ? a * nvfinal + b : b * nvfinal + a;
      let v = mid.get(key);
      if (v === undefined) { v = nv++; Pf[3 * v] = (Pf[3 * a] + Pf[3 * b]) / 2; Pf[3 * v + 1] = (Pf[3 * a + 1] + Pf[3 * b + 1]) / 2; Pf[3 * v + 2] = (Pf[3 * a + 2] + Pf[3 * b + 2]) / 2; mid.set(key, v); }
      return v;
    };
    let o = 0;
    for (let f = 0; f < nfa; f++) {
      const a = Fa[3 * f], b = Fa[3 * f + 1], c = Fa[3 * f + 2], ab = m(a, b), bc = m(b, c), ca = m(c, a);
      Fn.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], o); o += 12;
    }
    Fa = Fn;
  }
  const r = rng(seed), ph = [r() * 6, r() * 6, r() * 6];
  for (let v = 0; v < nv; v++) {
    const x = Pf[3 * v], y = Pf[3 * v + 1], z = Pf[3 * v + 2], l = Math.hypot(x, y, z), ux = x / l, uy = y / l, uz = z / l;
    const k = radius * (1 + 0.12 * Math.sin(5 * ux + ph[0]) * Math.cos(4 * uy + ph[1]) + 0.05 * Math.sin(17 * uz + 11 * ux + ph[2]));
    Pf[3 * v] = cx + ux * k; Pf[3 * v + 1] = cy + uy * k; Pf[3 * v + 2] = cz + uz * k;
  }
  if (nv !== nvfinal || Fa.length !== nfinal * 3) throw new Error('icosphere count mismatch');
  return { V: Pf, F: Fa };
}

export function bbox(V) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) for (let a = 0; a < 3; a++) { const x = V[i + a]; if (x < b[a]) b[a] = x; if (x > b[a + 3]) b[a + 3] = x; }
  return b;
}

// 16 bits per axis → a 48-bit Morton key, held as hi (bits 32..47) + lo (bits 0..31).
// Per axis k (0=x,1=y,2=z): bit b lands at 3b+k; tables give each axis' lo/hi contribution directly.
const SLO = [0, 1, 2].map(() => new Uint32Array(65536)), SHI = [0, 1, 2].map(() => new Uint32Array(65536));
for (let k = 0; k < 3; k++) for (let v = 0; v < 65536; v++) {
  let lo = 0, hi = 0;
  for (let b = 0; b < 16; b++) if ((v >>> b) & 1) { const pos = 3 * b + k; if (pos < 32) lo |= 1 << pos; else hi |= 1 << (pos - 32); }
  SLO[k][v] = lo >>> 0; SHI[k][v] = hi >>> 0;
}

// face order along a Morton curve of the centroids (LSD radix, 6 byte-passes)
export function mortonFaceOrder(mesh) {
  const { V, F } = mesh, nf = F.length / 3, b = bbox(V);
  const ext = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1, s = 65535 / ext;
  const lo = new Uint32Array(nf), hi = new Uint32Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = 3 * F[3 * f], c = 3 * F[3 * f + 1], d = 3 * F[3 * f + 2];
    const qx = Math.min(65535, ((V[a] + V[c] + V[d]) / 3 - b[0]) * s) | 0;
    const qy = Math.min(65535, ((V[a + 1] + V[c + 1] + V[d + 1]) / 3 - b[1]) * s) | 0;
    const qz = Math.min(65535, ((V[a + 2] + V[c + 2] + V[d + 2]) / 3 - b[2]) * s) | 0;
    lo[f] = (SLO[0][qx] | SLO[1][qy] | SLO[2][qz]) >>> 0;
    hi[f] = SHI[0][qx] | SHI[1][qy] | SHI[2][qz];
  }
  let idx = new Uint32Array(nf), tmp = new Uint32Array(nf);
  for (let i = 0; i < nf; i++) idx[i] = i;
  const cnt = new Uint32Array(256);
  for (let pass = 0; pass < 6; pass++) {
    const key = pass < 4 ? lo : hi, sh = (pass % 4) * 8;
    cnt.fill(0);
    for (let i = 0; i < nf; i++) cnt[(key[idx[i]] >>> sh) & 255]++;
    let sum = 0; for (let k = 0; k < 256; k++) { const c = cnt[k]; cnt[k] = sum; sum += c; }
    for (let i = 0; i < nf; i++) { const id = idx[i]; tmp[cnt[(key[id] >>> sh) & 255]++] = id; }
    const t = idx; idx = tmp; tmp = t;
  }
  return idx;
}

// cut the ordered faces into bricks; per brick, number vertices by first use (boundary vertices duplicated).
// → { rows: total vertex rows, vid: Int32Array(rows) original vertex per row, faces: Int32Array(3·nf) GLOBAL row indices,
//     vStart/vCount/fStart/fCount per brick }
export function buildBricks(mesh, order, facesPerBrick) {
  const { F } = mesh, nv = mesh.V.length / 3, nf = F.length / 3;
  const nb = Math.ceil(nf / facesPerBrick);
  const stamp = new Int32Array(nv).fill(-1), local = new Int32Array(nv);
  const faces = new Int32Array(nf * 3);
  let vid = new Int32Array(Math.ceil(nv * 1.3) + 1024), rows = 0;
  const vStart = new Int32Array(nb), vCount = new Int32Array(nb), fStart = new Int32Array(nb), fCount = new Int32Array(nb);
  let fo = 0;
  for (let k = 0; k < nb; k++) {
    vStart[k] = rows; fStart[k] = fo / 3;
    const end = Math.min(nf, (k + 1) * facesPerBrick);
    for (let i = k * facesPerBrick; i < end; i++) {
      const f = order[i];
      for (let c = 0; c < 3; c++) {
        const v = F[3 * f + c];
        if (stamp[v] !== k) {
          stamp[v] = k; local[v] = rows;
          if (rows === vid.length) { const g = new Int32Array(vid.length * 2); g.set(vid); vid = g; }
          vid[rows++] = v;
        }
        faces[fo++] = local[v];
      }
    }
    vCount[k] = rows - vStart[k]; fCount[k] = fo / 3 - fStart[k];
  }
  return { rows, vid: vid.subarray(0, rows), faces, nb, vStart, vCount, fStart, fCount };
}

export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
export const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
