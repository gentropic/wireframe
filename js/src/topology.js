// Topology of a triangle element, checked against the faces (SPEC §7.3). Edges compare by
// vertex identity (the input vertex index = vid), so the answer holds across bricks.
//   closed   — every edge is shared by exactly two faces
//   oriented — every edge shared by two faces is traversed in opposite directions by them
//   manifold — the faces around every vertex form a single fan
//   volume   — signed enclosed volume (outward-oriented → positive), when closed and oriented

export function checkTopology(V, F) {
  const nv = V.length / 3, nf = F.length / 3;
  // per-vertex link: for the corner at a of face (a, b, c), store (b, c) — the opposite edge
  const deg = new Int32Array(nv + 1);
  for (let i = 0; i < F.length; i++) deg[F[i] + 1]++;
  for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
  const off = deg, fill = off.slice(0, nv);
  const lb = new Int32Array(F.length), lc = new Int32Array(F.length);
  for (let f = 0; f < nf; f++) {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
    let p = fill[a]++; lb[p] = b; lc[p] = c;
    p = fill[b]++; lb[p] = c; lc[p] = a;
    p = fill[c]++; lb[p] = a; lc[p] = b;
  }
  let closed = true, oriented = true, manifold = true;
  const nodes = [], ndeg = [];
  for (let a = 0; a < nv; a++) {
    const s = off[a], e = off[a + 1];
    if (s === e) continue;
    // directed half-edges a→b: forward count in a's link, reverse count (b→a) in b's link
    for (let i = s; i < e; i++) {
      const b = lb[i];
      let fwd = 0, rev = 0;
      for (let j = s; j < e; j++) if (lb[j] === b) fwd++;
      for (let j = off[b], je = off[b + 1]; j < je; j++) if (lb[j] === a) rev++;
      // the undirected edge {a,b} is also used by faces where b→a; count faces through either direction
      let undirected = fwd + rev;
      if (undirected !== 2) closed = false;
      if (fwd > 1 || rev > 1) oriented = false;
      if (undirected > 2) manifold = false;
    }
    // link graph of a: nodes = link vertices, edges = (b, c) pairs; a single fan ⇔ connected,
    // every node degree ≤ 2, and (edges = nodes) cycle or (edges = nodes − 1) path
    if (!manifold) continue;
    nodes.length = 0; ndeg.length = 0;
    const id = (x) => { let i = nodes.indexOf(x); if (i < 0) { i = nodes.length; nodes.push(x); ndeg.push(0); } return i; };
    const ea = [], eb = [];
    for (let i = s; i < e; i++) { const p = id(lb[i]), q = id(lc[i]); ndeg[p]++; ndeg[q]++; ea.push(p); eb.push(q); }
    const m = e - s, k = nodes.length;
    if (ndeg.some((d) => d > 2) || (m !== k && m !== k - 1)) { manifold = false; continue; }
    // connectivity by union-find over the small link
    const par = Array.from({ length: k }, (_, i) => i);
    const find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    for (let i = 0; i < m; i++) par[find(ea[i])] = find(eb[i]);
    const r = find(0);
    for (let i = 1; i < k; i++) if (find(i) !== r) { manifold = false; break; }
  }
  let volume = null;
  if (closed && oriented) {
    // relative to a vertex for precision at UTM magnitudes
    const ox = V[0], oy = V[1], oz = V[2];
    let s6 = 0;
    for (let f = 0; f < nf; f++) {
      const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
      const ax = V[a] - ox, ay = V[a + 1] - oy, az = V[a + 2] - oz;
      const bx = V[b] - ox, by = V[b + 1] - oy, bz = V[b + 2] - oz;
      const cx = V[c] - ox, cy = V[c + 1] - oy, cz = V[c + 2] - oz;
      s6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    volume = s6 / 6;
  }
  return { closed, oriented, manifold, volume, status: 'checked' };
}
