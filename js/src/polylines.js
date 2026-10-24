// Polylines ↔ lines elements (SPEC §5): segments carry `line` (which polyline) and `seq` (position
// along it, from 0), so order survives bricking — a string that revisits a point, a closed loop's
// start, the direction of travel.

/**
 * linesFromPolylines(polylines) → { positions, cells, cellAttributes: { line, seq } } — input for a
 * lines element (writeWfr / createWfrWriter). Each polyline is a Float64Array of xyz triples (world),
 * or { positions, closed }; a closed one gets a final segment back to its first vertex. Every
 * polyline keeps its own vertices, so a string that crosses itself is never confused with its
 * crossing. Polylines with fewer than 2 vertices are skipped (their line id is still consumed).
 */
export function linesFromPolylines(polylines) {
  let nv = 0, ns = 0;
  const items = polylines.map((p) => (ArrayBuffer.isView(p) || Array.isArray(p) ? { positions: p, closed: false } : p));
  for (const { positions, closed } of items) {
    const n = positions.length / 3;
    if (n < 2) continue;
    nv += n; ns += n - 1 + (closed && n > 2 ? 1 : 0);
  }
  const positions = new Float64Array(3 * nv), cells = new Uint32Array(2 * ns), line = new Int32Array(ns), seq = new Int32Array(ns);
  let v = 0, s = 0;
  items.forEach(({ positions: P, closed }, id) => {
    const n = P.length / 3;
    if (n < 2) return;
    positions.set(P, 3 * v);
    let q = 0;
    for (let i = 0; i + 1 < n; i++, s++, q++) { cells[2 * s] = v + i; cells[2 * s + 1] = v + i + 1; line[s] = id; seq[s] = q; }
    if (closed && n > 2) { cells[2 * s] = v + n - 1; cells[2 * s + 1] = v; line[s] = id; seq[s] = q; s++; }
    v += n;
  });
  return { positions, cells, cellAttributes: { line, seq } };
}

/**
 * Rebuild polylines from decoded segments. segs: arrays aligned by segment — line, seq, va/vb (vids),
 * and A/B (xyz, 3 per segment). → [{ line, vertices: Float64Array (xyz, open: n+1 points, closed:
 * n — the closing point is not repeated), vids: Int32Array, closed }] sorted by line id.
 * Throws when a line repeats a seq or its chain breaks (SPEC §5); gaps in seq are fine.
 */
export function chainPolylines({ line, seq, va, vb, A, B }) {
  const n = line.length, byLine = new Map();
  for (let i = 0; i < n; i++) { let a = byLine.get(line[i]); if (!a) byLine.set(line[i], a = []); a.push(i); }
  const out = [];
  for (const id of [...byLine.keys()].sort((x, y) => x - y)) {
    const segs = byLine.get(id).sort((x, y) => seq[x] - seq[y]);
    for (let k = 1; k < segs.length; k++) {
      if (seq[segs[k]] === seq[segs[k - 1]]) throw new Error(`wfr: line ${id} repeats seq ${seq[segs[k]]} (SPEC §5)`);
      if (vb[segs[k - 1]] !== va[segs[k]]) throw new Error(`wfr: line ${id} breaks between seq ${seq[segs[k - 1]]} and ${seq[segs[k]]} (SPEC §5)`);
    }
    const last = segs[segs.length - 1], closed = segs.length > 1 && vb[last] === va[segs[0]];
    const m = closed ? segs.length : segs.length + 1;
    const vertices = new Float64Array(3 * m), vids = new Int32Array(m);
    segs.forEach((s, k) => { vertices.set(A.subarray(3 * s, 3 * s + 3), 3 * k); vids[k] = va[s]; });
    if (!closed) { vertices.set(B.subarray(3 * last, 3 * last + 3), 3 * segs.length); vids[segs.length] = vb[last]; }
    out.push({ line: id, vertices, vids, closed });
  }
  return out;
}
