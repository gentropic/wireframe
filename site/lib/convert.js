// @gcu/wireframe (src/convert.js) @ fda8d21 — built by site/build.mjs (MIT)

// ── src/convert/bytes-in.js ──

// Pull-style reading over an async iterable of byte chunks (a file stream, a Blob's stream()).
class ChunkReader {
  constructor(chunks) { this.it = chunks[Symbol.asyncIterator](); this.buf = new Uint8Array(0); this.p = 0; this.done = false; this.consumed = 0; }
  get available() { return this.buf.length - this.p; }
  // make at least n bytes available (fewer only at the end of input); returns how many are
  async need(n) {
    while (this.available < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) { this.done = true; break; }
      const v = value instanceof Uint8Array ? value : new Uint8Array(value);
      const rest = this.buf.subarray(this.p), b = new Uint8Array(rest.length + v.length);
      b.set(rest); b.set(v, rest.length);
      this.consumed += this.p; this.buf = b; this.p = 0;
    }
    return this.available;
  }
  take(n) { const s = this.buf.subarray(this.p, this.p + n); this.p += n; return s; }
}

// Lines of text from byte chunks (LF or CRLF), decoded as UTF-8; yields arrays of lines per chunk.
async function* lines(chunks) {
  const td = new TextDecoder();
  let carry = '';
  for await (const c of chunks) {
    const s = carry + td.decode(c, { stream: true });
    const parts = s.split('\n');
    carry = parts.pop();
    yield parts;
  }
  const tail = carry + td.decode();
  if (tail) yield [tail];
}

// ── src/convert/ply.js ──

// PLY → .wfr element, streamed: ascii, binary_little_endian, binary_big_endian.
// vertex x/y/z + every other scalar vertex property as an attribute (red/green/blue → color.*,
// nx/ny/nz → normal.*); face vertex lists fan-triangulated, other scalar face properties as cell
// attributes. No faces → a points element.

const TYPES = {
  char: ['i8', 1, 'getInt8'], int8: ['i8', 1, 'getInt8'], uchar: ['u8', 1, 'getUint8'], uint8: ['u8', 1, 'getUint8'],
  short: ['i16', 2, 'getInt16'], int16: ['i16', 2, 'getInt16'], ushort: ['u16', 2, 'getUint16'], uint16: ['u16', 2, 'getUint16'],
  int: ['i32', 4, 'getInt32'], int32: ['i32', 4, 'getInt32'], uint: ['f64', 4, 'getUint32'], uint32: ['f64', 4, 'getUint32'],
  float: ['f32', 4, 'getFloat32'], float32: ['f32', 4, 'getFloat32'], double: ['f64', 8, 'getFloat64'], float64: ['f64', 8, 'getFloat64'],
};
const RENAME = { red: 'color.r', green: 'color.g', blue: 'color.b', alpha: 'color.a', nx: 'normal.x', ny: 'normal.y', nz: 'normal.z' };
const ARR = { i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array, i32: Int32Array, f32: Float32Array, f64: Float64Array };
const BATCH$ply = 65536;

function parseHeader(text) {
  const L = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (L[0] !== 'ply') throw new Error('ply: missing "ply" magic');
  let format = null; const elements = [];
  for (const l of L.slice(1)) {
    const t = l.split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: +t[2], props: [] });
    else if (t[0] === 'property') {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ list: true, ct: TYPES[t[2]], it: TYPES[t[3]], name: t[4] });
      else { if (!TYPES[t[1]]) throw new Error(`ply: property type ${t[1]}`); el.props.push({ list: false, t: TYPES[t[1]], name: t[2] }); }
    }
  }
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) throw new Error(`ply: format ${format}`);
  return { format, elements };
}

/** convertPly(chunks, writer, { name, kind? }) — adds one element to a createWfrWriter writer. */
async function convertPly(chunks, writer, { name = 'mesh', spec = {} } = {}) {
  const r = new ChunkReader(chunks);
  // header
  let hdr = null;
  for (;;) {
    const n = await r.need(r.available + 4096);
    const s = new TextDecoder('latin1').decode(r.buf.subarray(r.p, r.p + n));
    const at = s.indexOf('end_header');
    if (at >= 0) { const nl = s.indexOf('\n', at); if (nl >= 0) { hdr = parseHeader(s.slice(0, nl)); r.take(nl + 1); break; } }
    if (r.done) throw new Error('ply: no end_header');
  }
  const ve = hdr.elements.find((e) => e.name === 'vertex'), fe = hdr.elements.find((e) => e.name === 'face');
  if (!ve) throw new Error('ply: no vertex element');
  const ix = ['x', 'y', 'z'].map((n) => ve.props.findIndex((p) => p.name === n));
  if (ix.some((i) => i < 0)) throw new Error('ply: vertex needs x, y, z');
  const vAttr = ve.props.filter((p, i) => !p.list && !ix.includes(i)).map((p) => ({ p, name: RENAME[p.name] || p.name }));
  const fList = fe ? fe.props.findIndex((p) => p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index')) : -1;
  const fAttr = fe ? fe.props.filter((p) => !p.list).map((p) => ({ p, name: RENAME[p.name] || p.name })) : [];
  const triangles = fe && fe.count > 0 && fList >= 0;
  const w = writer.element({
    name, kind: triangles ? 'triangles' : 'points', ...spec,
    vertexAttributes: Object.fromEntries(vAttr.map((a) => [a.name, a.p.t[0]])),
    ...(triangles ? { cellAttributes: Object.fromEntries(fAttr.map((a) => [a.name, a.p.t[0]])) } : {}),
  });
  const le = hdr.format === 'binary_little_endian', ascii = hdr.format === 'ascii';
  const stats = { vertices: 0, faces: 0, triangles: 0, skippedFaces: 0 };

  // ascii tokens, across chunk boundaries
  let tokLine = [], tokAt = 0;
  const td = new TextDecoder('latin1');
  async function nextLine() {
    for (;;) {
      const s = td.decode(r.buf.subarray(r.p, r.p + Math.min(r.available, 1 << 16)));
      const nl = s.indexOf('\n');
      if (nl >= 0) { r.take(nl + 1); return s.slice(0, nl).trim(); }
      if (r.done) { if (!r.available) return null; const all = td.decode(r.take(r.available)); return all.trim(); }
      await r.need(r.available + (1 << 16));
    }
  }
  async function asciiValues() { let l; do { l = await nextLine(); if (l === null) throw new Error('ply: truncated'); } while (l === ''); return l.split(/\s+/).map(Number); }

  for (const el of hdr.elements) {
    if (el === ve) {
      const fixed = ve.props.reduce((s, p) => s + p.t[1], 0);
      let done = 0;
      while (done < ve.count) {
        const n = Math.min(BATCH$ply, ve.count - done);
        const P = new Float64Array(3 * n), A = vAttr.map((a) => new ARR[a.p.t[0]](n));
        if (ascii) {
          for (let i = 0; i < n; i++) {
            const v = await asciiValues();
            for (let a = 0; a < 3; a++) P[3 * i + a] = v[ix[a]];
            vAttr.forEach((at, j) => { A[j][i] = v[ve.props.indexOf(at.p)]; });
          }
        } else {
          if (await r.need(n * fixed) < n * fixed) throw new Error('ply: truncated vertex data');
          const b = r.take(n * fixed), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
          const off = []; let o = 0; for (const p of ve.props) { off.push(o); o += p.t[1]; }
          for (let i = 0; i < n; i++) {
            const base = i * fixed;
            for (let a = 0; a < 3; a++) { const p = ve.props[ix[a]]; P[3 * i + a] = dv[p.t[2]](base + off[ix[a]], le); }
            for (let j = 0; j < vAttr.length; j++) { const p = vAttr[j].p, q = ve.props.indexOf(p); A[j][i] = dv[p.t[2]](base + off[q], le); }
          }
        }
        const attrs = Object.fromEntries(vAttr.map((a, j) => [a.name, A[j]]));
        if (triangles) await w.vertices(P, attrs); else await w.points(P, attrs);
        done += n; stats.vertices += n;
      }
    } else if (el === fe && triangles) {
      let done = 0, dv = null;
      const maxFace = fe.props.reduce((s, p) => s + (p.list ? p.ct[1] + 255 * p.it[1] : p.t[1]), 0);
      while (done < fe.count) {
        const n = Math.min(BATCH$ply, fe.count - done);
        const I = [], A = fAttr.map(() => []);
        for (let f = 0; f < n; f++) {
          let idx, vals = [];
          if (ascii) {
            const v = await asciiValues(); let q = 0;
            for (const p of fe.props) { if (p.list) { const c = v[q++]; idx = v.slice(q, q + c); q += c; } else vals.push(v[q++]); }
          } else {
            // parse synchronously from the buffer; refill only when a worst-case face might not fit
            if (r.available < maxFace && !r.done) await r.need(Math.max(1 << 20, 2 * maxFace));
            for (;;) {
              if (!dv || dv.buffer !== r.buf.buffer) dv = new DataView(r.buf.buffer, r.buf.byteOffset, r.buf.byteLength);
              let q = r.p, ok = true;
              vals = [];
              for (const p of fe.props) {
                if (p.list) {
                  if (q + p.ct[1] > r.buf.length) { ok = false; break; }
                  const c = dv[p.ct[2]](q, le); q += p.ct[1];
                  if (q + c * p.it[1] > r.buf.length) { ok = false; break; }
                  idx = new Array(c); for (let i = 0; i < c; i++, q += p.it[1]) idx[i] = dv[p.it[2]](q, le);
                } else { if (q + p.t[1] > r.buf.length) { ok = false; break; } vals.push(dv[p.t[2]](q, le)); q += p.t[1]; }
              }
              if (ok) { r.p = q; break; }
              if (r.done) throw new Error('ply: truncated face data');
              await r.need(2 * r.available + (1 << 20)); // a face larger than the buffer: grow and retry
            }
          }
          if (!idx || idx.length < 3) { stats.skippedFaces++; continue; }
          for (let t = 1; t + 1 < idx.length; t++) {
            if (idx[0] === idx[t] || idx[t] === idx[t + 1] || idx[0] === idx[t + 1]) { stats.skippedFaces++; continue; }
            I.push(idx[0], idx[t], idx[t + 1]);
            fAttr.forEach((a, j) => A[j].push(vals[fe.props.filter((p) => !p.list).indexOf(a.p)]));
            stats.triangles++;
          }
        }
        await w.cells(Uint32Array.from(I), Object.fromEntries(fAttr.map((a, j) => [a.name, ARR[a.p.t[0]].from(A[j])])));
        done += n; stats.faces += n;
      }
    } else {
      // skip an element we don't keep
      for (let i = 0; i < el.count; i++) {
        if (ascii) { await asciiValues(); continue; }
        for (const p of el.props) {
          if (p.list) { await r.need(p.ct[1]); const cb = r.take(p.ct[1]); const c = new DataView(cb.buffer, cb.byteOffset, p.ct[1])[p.ct[2]](0, le); await r.need(c * p.it[1]); r.take(c * p.it[1]); }
          else { await r.need(p.t[1]); r.take(p.t[1]); }
        }
      }
    }
  }
  return stats;
}

// ── src/convert/obj.js ──

// Wavefront OBJ → .wfr element, streamed line by line. v (optionally with r g b colours),
// f (any polygon, fan-triangulated; v, v/vt, v//vn, v/vt/vn; negative = relative), o/g → a
// "group" cell attribute. Texture coordinates, normals, lines and materials are not kept.

const BATCH$obj = 65536;

/** convertObj(chunks, writer, { name, spec }) — adds one triangles element. */
async function convertObj(chunks, writer, { name = 'mesh', spec = {} } = {}) {
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
        if (P.length >= 3 * BATCH$obj) await flushV();
      } else if (tag === 'f') {
        const t = l.split(/\s+/), idx = [];
        for (let i = 1; i < t.length; i++) { const v = parseInt(t[i], 10); idx.push(v < 0 ? nv + v : v - 1); }
        stats.faces++;
        if (idx.length < 3 || idx.some((v) => !(v >= 0))) { stats.skipped++; continue; }
        for (let k = 1; k + 1 < idx.length; k++) {
          if (idx[0] === idx[k] || idx[k] === idx[k + 1] || idx[0] === idx[k + 1]) { stats.skipped++; continue; }
          I.push(idx[0], idx[k], idx[k + 1]); G.push(group); stats.triangles++;
        }
        if (I.length >= 3 * BATCH$obj) await flushF();
      } else if (tag === 'o' || tag === 'g') {
        group = l.slice(sp + 1).trim();
      } else stats.ignored[tag] = (stats.ignored[tag] || 0) + 1;
    }
  }
  await flushV(); await flushF();
  if (!w) throw new Error('obj: no geometry');
  return stats;
}

// ── src/convert/dxf.js ──

// DXF → .wfr elements, streamed through @gcu/dxf's push parser (never resident).
//   3DFACE / polyface / polygon meshes → a triangles element (soup, welded by position)
//   polylines, lines, arcs, circles    → a lines element (each string's chords as segments)
//   points                             → a points element
// Every element carries the DXF layer (string) and colour (color.r/g/b; unset → white, ACI 7).
const BATCH$dxf = 65536;

/** convertDxf(chunks, writer, { name, spec, dxf }) — dxf: the @gcu/dxf module, passed in (no dynamic import, so browser bundles carry none). */
async function convertDxf(chunks, writer, { name = 'dxf', spec = {}, dxf = null } = {}) {
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
      if (!e.P.length || (!force && e.P.length < per * BATCH$dxf)) continue;
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

// ── src/convert.js ──

// @gcu/wireframe/convert — streamed format adapters feeding a createWfrWriter writer.
// PLY (ascii/binary), OBJ, and DXF (given @gcu/dxf's createSceneStream). Browser-safe.

export {
  convertPly,
  convertObj,
  convertDxf,
  ChunkReader,
  lines,
};
