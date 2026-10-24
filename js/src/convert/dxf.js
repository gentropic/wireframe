// DXF → .wfr elements, streamed through @gcu/dxf's push parser (never resident).
//   3DFACE / polyface / polygon meshes → a triangles element (soup, welded by position)
//   polylines, lines, arcs, circles    → a lines element (each string's chords as segments)
//   points                             → a points element
// Every element carries the DXF layer (string) and colour (color.r/g/b; unset → white, ACI 7).
const BATCH = 65536;

/** convertDxf(chunks, writer, { name, spec, dxf }) — dxf: the @gcu/dxf module, passed in (no dynamic import, so browser bundles carry none). */
export async function convertDxf(chunks, writer, { name = 'dxf', spec = {}, dxf = null } = {}) {
  if (!dxf || !dxf.createSceneStream) throw new Error('convertDxf needs { dxf } — the @gcu/dxf module (or any object with its createSceneStream)');
  const { createSceneStream } = dxf;
  const els = {};
  const colorAttrs = { 'color.r': 'u8', 'color.g': 'u8', 'color.b': 'u8' };
  const get = (kind) => {
    if (els[kind]) return els[kind];
    const nm = kind === 'triangles' ? name : `${name}:${kind === 'lines' ? 'strings' : 'points'}`;
    const attrs = { layer: 'string', ...colorAttrs, ...(kind === 'lines' ? { line: 'i32', seq: 'i32' } : {}) };   // line + seq: polyline order (SPEC §5)
    const w = writer.element({ name: nm, kind, ...spec, ...(kind === 'points' ? { vertexAttributes: attrs } : { cellAttributes: attrs }) });
    const loc = kind === 'points' ? 'vertices' : 'cells';
    return (els[kind] = { w, loc, P: [], L: [], R: [], Gc: [], B: [], S: [], Q: [], layerCode: new Map() });
  };
  const code = (e, layer) => { let c = e.layerCode.get(layer); if (c === undefined) { c = e.w.label('layer', layer, e.loc); e.layerCode.set(layer, c); } return c; };
  const col = (e, rgb) => { if (rgb) { e.R.push(rgb[0]); e.Gc.push(rgb[1]); e.B.push(rgb[2]); } else { e.R.push(255); e.Gc.push(255); e.B.push(255); } };
  let strings = 0;
  const stats = { triangles: 0, segments: 0, points: 0 };
  const sink = {
    tri(l, rgb, ax, ay, az, bx, by, bz, cx, cy, cz) {
      if ((ax === bx && ay === by && az === bz) || (bx === cx && by === cy && bz === cz) || (ax === cx && ay === cy && az === cz)) return; // degenerate after the 4th-corner rule
      const e = get('triangles'); e.P.push(ax, ay, az, bx, by, bz, cx, cy, cz); e.L.push(code(e, l)); col(e, rgb); stats.triangles++;
    },
    string(l, rgb, pts) {
      const e = get('lines'), n = pts.length / 3, c = code(e, l), id = strings++;
      let q = 0;   // seq: zero-length chords are skipped, and their neighbours still meet at one welded vertex
      for (let i = 0; i + 1 < n; i++) {
        const a = 3 * i, b = a + 3;
        if (pts[a] === pts[b] && pts[a + 1] === pts[b + 1] && pts[a + 2] === pts[b + 2]) continue;
        e.P.push(pts[a], pts[a + 1], pts[a + 2], pts[b], pts[b + 1], pts[b + 2]); e.L.push(c); col(e, rgb); e.S.push(id); e.Q.push(q++); stats.segments++;
      }
    },
    point(l, rgb, x, y, z) { const e = get('points'); e.P.push(x, y, z); e.L.push(code(e, l)); col(e, rgb); stats.points++; },
  };
  const flush = async (force) => {
    for (const [kind, e] of Object.entries(els)) {
      const per = kind === 'triangles' ? 9 : kind === 'lines' ? 6 : 3;
      if (!e.P.length || (!force && e.P.length < per * BATCH)) continue;
      const attrs = { layer: Int32Array.from(e.L), 'color.r': Uint8Array.from(e.R), 'color.g': Uint8Array.from(e.Gc), 'color.b': Uint8Array.from(e.B), ...(kind === 'lines' ? { line: Int32Array.from(e.S), seq: Int32Array.from(e.Q) } : {}) };
      if (kind === 'points') await e.w.points(Float64Array.from(e.P), attrs);
      else await e.w.soup(Float64Array.from(e.P), attrs);
      e.P = []; e.L = []; e.R = []; e.Gc = []; e.B = []; e.S = []; e.Q = [];
    }
  };
  const st = createSceneStream(sink);
  for await (const c of chunks) { st.push(c instanceof Uint8Array ? c : new Uint8Array(c)); await flush(false); }
  const summary = st.end();
  await flush(true);
  return { ...stats, warnings: summary.warnings?.length || 0, header: summary.header };
}
