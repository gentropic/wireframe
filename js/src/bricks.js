// Brick building (SPEC §7.4): order cells (or points) along a Morton curve of their centroids,
// optionally grouped by a label column first, cut into runs, renumber vertices by first use per
// brick. Only the brick invariant is normative; this is the reference way to get good bricks.

// 16 bits per axis → a 48-bit key as hi (bits 32…47) + lo (bits 0…31).
const SLO = [0, 1, 2].map(() => new Uint32Array(65536)), SHI = [0, 1, 2].map(() => new Uint32Array(65536));
for (let k = 0; k < 3; k++) for (let v = 0; v < 65536; v++) {
  let lo = 0, hi = 0;
  for (let b = 0; b < 16; b++) if ((v >>> b) & 1) { const pos = 3 * b + k; if (pos < 32) lo |= 1 << pos; else hi |= 1 << (pos - 32); }
  SLO[k][v] = lo >>> 0; SHI[k][v] = hi >>> 0;
}

export function bbox(V) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) for (let a = 0; a < 3; a++) { const x = V[i + a]; if (x < b[a]) b[a] = x; if (x > b[a + 3]) b[a + 3] = x; }
  return b;
}

// Stable LSD radix passes over (lo, hi) keys → permutation.
function radix(lo, hi, n, idx) {
  let tmp = new Uint32Array(n);
  const cnt = new Uint32Array(256);
  for (let pass = 0; pass < 6; pass++) {
    const key = pass < 4 ? lo : hi, sh = (pass % 4) * 8;
    cnt.fill(0);
    for (let i = 0; i < n; i++) cnt[(key[idx[i]] >>> sh) & 255]++;
    let sum = 0; for (let k = 0; k < 256; k++) { const c = cnt[k]; cnt[k] = sum; sum += c; }
    for (let i = 0; i < n; i++) { const id = idx[i]; tmp[cnt[(key[id] >>> sh) & 255]++] = id; }
    const t = idx; idx = tmp; tmp = t;
  }
  return idx;
}

// Morton order of k-vertex cells (k = 0: the vertices themselves). → Uint32Array permutation.
export function mortonOrder(V, cells, k, box = bbox(V)) {
  const n = k ? cells.length / k : V.length / 3;
  const ext = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]) || 1, s = 65535 / ext;
  const lo = new Uint32Array(n), hi = new Uint32Array(n);
  for (let f = 0; f < n; f++) {
    let cx = 0, cy = 0, cz = 0;
    if (k === 0) { cx = V[3 * f]; cy = V[3 * f + 1]; cz = V[3 * f + 2]; }
    else {
      for (let j = 0; j < k; j++) { const v = 3 * cells[k * f + j]; cx += V[v]; cy += V[v + 1]; cz += V[v + 2]; }
      cx /= k; cy /= k; cz /= k;
    }
    const qx = Math.max(0, Math.min(65535, (cx - box[0]) * s)) | 0;
    const qy = Math.max(0, Math.min(65535, (cy - box[1]) * s)) | 0;
    const qz = Math.max(0, Math.min(65535, (cz - box[2]) * s)) | 0;
    lo[f] = (SLO[0][qx] | SLO[1][qy] | SLO[2][qz]) >>> 0;
    hi[f] = SHI[0][qx] | SHI[1][qy] | SHI[2][qz];
  }
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return radix(lo, hi, n, idx);
}

// Stable regroup of an order by integer group codes (from a label column): groups ascending,
// Morton order kept inside each. → { order, groupOf } where groupOf[i] is the code at order[i].
export function groupOrder(order, codes, ngroups) {
  const n = order.length, cnt = new Uint32Array(ngroups + 1);
  for (let i = 0; i < n; i++) cnt[codes[order[i]] + 1]++;
  for (let g = 0; g < ngroups; g++) cnt[g + 1] += cnt[g];
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) { const id = order[i]; out[cnt[codes[id]]++] = id; }
  return out;
}

// Cut an ordered cell list into bricks and renumber vertices by first use within each brick.
// codes (optional): a brick never spans two code values. For k = 0 (points) bricks are runs of points.
// → { rows, vid: Int32Array(rows) original vertex per row, cells: Int32Array(k·n) GLOBAL rows (k > 0),
//     vCount, cCount: per brick, cellOrder: the order used }
export function buildBricks(nv, cells, k, order, target, codes = null) {
  const n = order.length;
  const vCount = [], cCount = [];
  if (k === 0) {
    let s = 0;
    while (s < n) {
      let e = Math.min(n, s + target);
      if (codes) { const c = codes[order[s]]; let j = s + 1; while (j < e && codes[order[j]] === c) j++; e = j; }
      vCount.push(e - s); cCount.push(0); s = e;
    }
    return { rows: n, vid: Int32Array.from(order), cells: null, vCount, cCount, cellOrder: order };
  }
  const stamp = new Int32Array(nv).fill(-1), local = new Int32Array(nv);
  const out = new Int32Array(n * k);
  let vid = new Int32Array(Math.ceil(nv * 1.1) + 1024), rows = 0, s = 0, brick = 0, o = 0;
  while (s < n) {
    let e = Math.min(n, s + target);
    if (codes) { const c = codes[order[s]]; let j = s + 1; while (j < e && codes[order[j]] === c) j++; e = j; }
    const r0 = rows;
    for (let i = s; i < e; i++) {
      const f = order[i];
      for (let j = 0; j < k; j++) {
        const v = cells[k * f + j];
        if (stamp[v] !== brick) {
          stamp[v] = brick; local[v] = rows;
          if (rows === vid.length) { const g = new Int32Array(vid.length * 2); g.set(vid); vid = g; }
          vid[rows++] = v;
        }
        out[o++] = local[v];
      }
    }
    vCount.push(rows - r0); cCount.push(e - s);
    s = e; brick++;
  }
  return { rows, vid: vid.slice(0, rows), cells: out, vCount, cCount, cellOrder: order };
}
