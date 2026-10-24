// The streaming element writer. One pipeline for every size: the memory budget decides how
// much stays resident, and with no budget it is simply the in-memory writer. The output does
// not depend on the budget — a tiny budget and an unlimited one write the same bytes.
//
//   pass 1  push*()      quantize to the grid as the source streams; compact records to scratch
//   pass 2  keys         Morton keys (cells by centroid; soup corners by position) + histograms
//   pass 3  partition    recursive histogram splits until every leaf fits the budget
//   (soup)  weld         per corner leaf: sort by (key, x, y, z), unique → global vid order
//   pass 4  bricks       per face leaf in key order: sort, cut bricks (a partial brick carries
//                        into the next leaf), renumber by first use, encode row groups
//   (check) topology     half-edges and vertex links grouped by vid range
import { BatchWriter, decodeChunk as decodeBatch, loadAll, chunkSize, encodeChunk } from './batch.js';
import { ParquetStream } from './parquet-write.js';
import { crc32 } from './zip.js';
import { FORMAT_VERSION, SPEC_URL } from './wfr.js';

const KIND_K = { points: 1, lines: 2, triangles: 3 };
const CELL_COLS = { lines: ['a', 'b'], triangles: ['a', 'b', 'c'] };
const RESERVED = new Set(['x', 'y', 'z', 'vid', 'a', 'b', 'c']);
const ATTR = { f64: Float64Array, f32: Float32Array, i32: Int32Array, u8: Uint8Array, u16: Uint16Array, i8: Int8Array, i16: Int16Array, string: Int32Array };
const PQ = {
  f64: { type: 'DOUBLE', encoding: 'BYTE_STREAM_SPLIT' }, f32: { type: 'FLOAT', encoding: 'BYTE_STREAM_SPLIT' },
  i32: { type: 'INT32', encoding: 'DELTA_BINARY_PACKED' }, u8: { type: 'INT32', encoding: 'DELTA_BINARY_PACKED', logical: 'UINT8' },
  u16: { type: 'INT32', encoding: 'DELTA_BINARY_PACKED', logical: 'UINT16' }, i8: { type: 'INT32', encoding: 'DELTA_BINARY_PACKED', logical: 'INT8' },
  i16: { type: 'INT32', encoding: 'DELTA_BINARY_PACKED', logical: 'INT16' }, string: { type: 'STRING' },
};
const PAGE = 65536;     // indexed vertex store page
const NB = 65536;       // histogram bins
const P32 = 4294967296;

// ── Morton (16 bits per axis → 48-bit key as a Number) ──────────────────────────────────────────
const SLO = [0, 1, 2].map(() => new Uint32Array(65536)), SHI = [0, 1, 2].map(() => new Uint32Array(65536));
for (let k = 0; k < 3; k++) for (let v = 0; v < 65536; v++) {
  let lo = 0, hi = 0;
  for (let b = 0; b < 16; b++) if ((v >>> b) & 1) { const pos = 3 * b + k; if (pos < 32) lo |= 1 << pos; else hi |= 1 << (pos - 32); }
  SLO[k][v] = lo >>> 0; SHI[k][v] = hi >>> 0;
}
function keyer(bb) { // bb: stored-unit bbox
  const ext = Math.max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) || 1, s = 65535 / ext;
  const q = (v, a) => { const t = Math.floor((v - bb[a]) * s); return t < 0 ? 0 : t > 65535 ? 65535 : t; };
  return (x, y, z) => { const qx = q(x, 0), qy = q(y, 1), qz = q(z, 2); return (SHI[0][qx] | SHI[1][qy] | SHI[2][qz]) * P32 + ((SLO[0][qx] | SLO[1][qy] | SLO[2][qz]) >>> 0); };
}

// Stable LSD radix sort of n Number keys (< 2^53) → permutation.
function sortKeys(keys, n) {
  const lo = new Uint32Array(n), hi = new Uint32Array(n);
  for (let i = 0; i < n; i++) { const k = keys[i]; lo[i] = k % P32; hi[i] = Math.floor(k / P32); }
  let idx = new Uint32Array(n), tmp = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const cnt = new Uint32Array(256);
  for (let pass = 0; pass < 7; pass++) {
    const key = pass < 4 ? lo : hi, sh = (pass % 4) * 8;
    cnt.fill(0);
    for (let i = 0; i < n; i++) cnt[(key[i] >>> sh) & 255]++;
    if (cnt[(key[0] >>> sh) & 255] === n) continue; // every record shares this byte
    let sum = 0; for (let k = 0; k < 256; k++) { const c = cnt[k]; cnt[k] = sum; sum += c; }
    for (let i = 0; i < n; i++) { const id = idx[i]; tmp[cnt[(key[id] >>> sh) & 255]++] = id; }
    const t = idx; idx = tmp; tmp = t;
  }
  return idx;
}

// Gather records perm[i] → new SoA arrays (optionally prefixed by `head`, already ordered).
function gather(schema, src, perm, head = null) {
  const h = head ? head.n : 0, n = h + perm.length, out = { n };
  for (const f of schema) {
    const w = f.width, a = new f.Type(n * w), s = src[f.name];
    if (h) a.set(head[f.name].subarray(0, h * w));
    if (w === 1) for (let i = 0; i < perm.length; i++) a[h + i] = s[perm[i]];
    else for (let i = 0; i < perm.length; i++) { const d = (h + i) * w, o = perm[i] * w; for (let j = 0; j < w; j++) a[d + j] = s[o + j]; }
    out[f.name] = a;
  }
  return out;
}
function slice(schema, rec, s, e) {
  const out = { n: e - s };
  for (const f of schema) out[f.name] = rec[f.name].slice(s * f.width, e * f.width);
  return out;
}

// Two-key stable order: by a, ties by b (LSD: sort by b, then stably by a).
function sortKeys2(a, b, n) {
  const p1 = sortKeys(b, n), ap = new Float64Array(n);
  for (let i = 0; i < n; i++) ap[i] = a[p1[i]];
  const p2 = sortKeys(ap, n), out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = p1[p2[i]];
  return out;
}

// LRU over decoded chunks of a spill. get(i) is synchronous on a hit (null on a miss), so hot
// loops only await on misses:  const c = cache.get(i) ?? await cache.load(i)
function chunkCache(spill, schema, maxBytes) {
  const slot = [], resident = [];
  let bytes = 0, tick = 0;
  return {
    // a hit is one array read and a stamp; recency is only consulted when evicting
    get(i) { const c = slot[i]; if (c !== undefined) { c._t = ++tick; return c; } return null; },
    async load(i) {
      const u8 = await spill.readChunk(i);
      const c = decodeBatch(schema, u8); c._bytes = u8.length; c._i = i; c._t = ++tick;
      slot[i] = c; resident.push(c); bytes += c._bytes;
      while (bytes > maxBytes && resident.length > 4) { // a record may need 3 chunks at once: never thrash below that
        let o = 0; for (let r = 1; r < resident.length; r++) if (resident[r]._t < resident[o]._t) o = r;
        const v = resident[o]; resident[o] = resident[resident.length - 1]; resident.pop();
        slot[v._i] = undefined; bytes -= v._bytes;
      }
      return c;
    },
  };
}

// Recursive partition: visit the records of `spill` in ascending key order, in leaves that fit.
// hist: optional precomputed histogram over [lo, hi) with power-of-two bin width.
async function partition(ctx, spill, schema, count, lo, hi, hist, onLeaf) {
  const recBytes = chunkSize(schema, 1) + 24;
  const fits = count * recBytes <= ctx.leafBytes;
  if (count === 0) { await spill.delete(); return; }
  if (fits) { const rec = await loadAll(schema, spill, count); await spill.delete(); await onLeaf(rec, false); return; }
  if (hi - lo <= 1) {
    // one key, too many records to hold: they are already in input (= sorted) order — stream them
    for await (const u8 of spill.read()) { const c = decodeBatch(schema, u8.byteOffset % 8 ? u8.slice() : u8); await onLeaf(slice(schema, c, 0, c.n), true); }
    await spill.delete();
    return;
  }
  let w = 1; while ((hi - lo) / w > NB) w *= 2;
  const nbins = Math.ceil((hi - lo) / w);
  if (!hist || hist.w !== w || hist.lo !== lo) {
    hist = { w, lo, c: new Float64Array(nbins) };
    for await (const u8 of spill.read()) { const c = decodeBatch(schema, u8); const k = c.key; for (let i = 0; i < c.n; i++) hist.c[Math.floor((k[i] - lo) / w)]++; }
  }
  // everything in one bin: narrow the range to it (same spill, finer bins next level)
  let only = -1, nonEmpty = 0;
  for (let b = 0; b < nbins; b++) if (hist.c[b]) { nonEmpty++; only = b; }
  if (nonEmpty === 1) return partition(ctx, spill, schema, count, lo + only * w, Math.min(hi, lo + (only + 1) * w), null, onLeaf);
  // group bins into sub-ranges of ≤ leaf size (an oversize bin stands alone and recurses)
  const leafCount = Math.max(1, Math.floor(ctx.leafBytes / recBytes));
  const subOf = new Int32Array(nbins), subs = [];
  let cur = null;
  for (let b = 0; b < nbins; b++) {
    const c = hist.c[b];
    if (!cur || (cur.count + c > leafCount && cur.count > 0)) { cur = { b0: b, b1: b + 1, count: 0 }; subs.push(cur); }
    cur.b1 = b + 1; cur.count += c; subOf[b] = subs.length - 1;
  }
  const writers = subs.map((s) => new BatchWriter(schema, ctx.scratch.spill('part'), 8192));
  const dest = new Int32Array(8192 * 4);
  for await (const u8 of spill.read()) {
    const c = decodeBatch(schema, u8), k = c.key, n = c.n;
    const D = n <= dest.length ? dest : new Int32Array(n);
    for (let i = 0; i < n; i++) D[i] = subOf[Math.floor((k[i] - lo) / w)];
    // field by field over the chunk: one tight loop per field instead of a loop per record
    let i = 0;
    while (i < n) {
      // records i… up to the first writer that would fill — then flush it and continue
      let stop = n;
      for (let j = i; j < n; j++) { const bw = writers[D[j]]; if (bw.n + (bw._pend = (bw._pend || 0) + 1) > bw.cap) { stop = j; break; } }
      for (const bw of writers) bw._pend = 0;
      for (const f of schema) {
        const wd = f.width, s = c[f.name], name = f.name;
        if (wd === 1) for (let j = i; j < stop; j++) { const bw = writers[D[j]]; bw.f[name][bw.n + bw._pend++] = s[j]; }
        else for (let j = i; j < stop; j++) { const bw = writers[D[j]], d = bw.f[name], o = (bw.n + bw._pend++) * wd, q = j * wd; for (let t = 0; t < wd; t++) d[o + t] = s[q + t]; }
        for (const bw of writers) bw._pend = 0;
      }
      for (let j = i; j < stop; j++) writers[D[j]]._pend++;
      for (const bw of writers) { if (bw._pend) { bw.advance(bw._pend); bw._pend = 0; } if (!bw.free) await bw.flush(); }
      i = stop;
    }
  }
  await spill.delete();
  for (const bw of writers) await bw.flush();
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i], slo = lo + s.b0 * w, shi = Math.min(hi, lo + s.b1 * w);
    await partition(ctx, writers[i].spill, schema, writers[i].count, slo, shi, null, onLeaf);
  }
}

// Per-brick first-use renumbering: open addressing vid → local row, cleared per brick.
class LocalIndex {
  constructor(cap) { let n = 1; while (n < cap * 2) n *= 2; this.mask = n - 1; this.keys = new Int32Array(n).fill(-1); this.vals = new Int32Array(n); this.used = []; }
  clear() { for (const s of this.used) this.keys[s] = -1; this.used.length = 0; }
  get(k) { let s = (Math.imul(k, 0x9e3779b1) >>> 0) & this.mask; while (true) { const v = this.keys[s]; if (v === k) return this.vals[s]; if (v === -1) return -1; s = (s + 1) & this.mask; } }
  set(k, val) { let s = (Math.imul(k, 0x9e3779b1) >>> 0) & this.mask; while (this.keys[s] !== -1) s = (s + 1) & this.mask; this.keys[s] = k; this.vals[s] = val; this.used.push(s); }
}

/**
 * createElementWriter(spec, ctx) — ctx: { scratch, leafBytes, cacheBytes }
 * spec: { name, kind, coords?: { mode: 'grid'|'float64', step, origin }, vertexAttributes?: { name: type },
 *         cellAttributes?: { name: type }, brickBy?, target?, topology?: 'check'|{…}, keepVid?, meta? }
 *   types: f64 f32 i32 u8 u16 i8 i16 string (strings: JS strings, or int codes from label())
 * push: vertices(positions, attrs) + cells(indices, attrs)   — indexed (cells index vertices in push order)
 *       soup(positions [3k per cell], cellAttrs, cornerAttrs [k per cell]) — no indices: welded by position
 *       points(positions, attrs)                                — kind 'points'
 * end(zw) → { manifest, members } (members already written to the zip writer)
 */
export function createElementWriter(spec, ctx) {
  const k = KIND_K[spec.kind];
  if (!k) throw new Error(`wfr write: element "${spec.name}" kind "${spec.kind}"`);
  const vA = spec.vertexAttributes || {}, cA = spec.cellAttributes || {};
  for (const [n, t] of [...Object.entries(vA), ...Object.entries(cA)]) {
    if (RESERVED.has(n)) throw new Error(`wfr write: attribute name "${n}" is reserved`);
    if (!ATTR[t]) throw new Error(`wfr write: attribute "${n}" type "${t}" (use ${Object.keys(ATTR).join(' ')})`);
  }
  if (spec.kind === 'points' && Object.keys(cA).length) throw new Error('wfr write: points elements have no cells — put attributes on vertices');
  const grid = spec.coords?.mode !== 'float64';
  const CT = grid ? Int32Array : Float64Array;
  const step = grid ? (spec.coords?.step ?? 1e-4) : null;
  const S = grid ? (Array.isArray(step) ? step : [step, step, step]) : null;
  let origin = grid ? spec.coords?.origin ?? null : null;
  const target = spec.target ?? 65536;
  // string attributes: per location+name label tables (code = first-seen order)
  const labels = {};
  for (const [n, t] of Object.entries(vA)) if (t === 'string') labels['V:' + n] = { map: new Map(), list: [] };
  for (const [n, t] of Object.entries(cA)) if (t === 'string') labels['C:' + n] = { map: new Map(), list: [] };
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let mode = null; // 'indexed' | 'soup' | 'points'
  let nv = 0, m = 0, V1 = null, C1 = null, S1 = null;
  let refBits = new Uint32Array(1024);

  const fields = (attrs, prefix, width = 1) => Object.entries(attrs).map(([n, t]) => ({ name: prefix + n, Type: ATTR[t], width }));
  const code = (key, s) => { const L = labels[key]; let c = L.map.get(s); if (c === undefined) { c = L.list.length; L.map.set(s, c); L.list.push(s); } return c; };
  // caller's attribute arrays → stored arrays (strings → codes), length-checked
  const prep = (attrs, types, prefix, len) => Object.entries(types).map(([n, t]) => {
    let a = attrs?.[n];
    if (!a || a.length !== len) throw new Error(`wfr write: attribute "${n}" needs ${len} values, got ${a ? a.length : 'none'}`);
    if (t === 'string' && !ArrayBuffer.isView(a)) { const o = new Int32Array(len); for (let i = 0; i < len; i++) o[i] = code(prefix + n, String(a[i])); a = o; }
    return [prefix + n, a];
  });
  const quant = (v, a) => {
    if (!Number.isFinite(v)) throw new Error(`wfr write: element "${spec.name}" has a non-finite coordinate`);
    if (!grid) return v;
    const q = Math.round((v - origin[a]) / S[a]);
    if (q < -2147483648 || q > 2147483647) throw new Error(`wfr write: element "${spec.name}" overflows INT32 at step ${S[a]} on ${'xyz'[a]} — use a coarser step or coords.mode "float64"`);
    return q;
  };
  const setMode = (want, P) => {
    if (mode && mode !== want) throw new Error(`wfr write: element "${spec.name}" mixes ${mode} and ${want} input`);
    if (grid && !origin && P && P.length >= 3) origin = [Math.floor(P[0]), Math.floor(P[1]), Math.floor(P[2])];
    if (mode) return;
    mode = want;
    const P3 = (w) => ({ name: 'p', Type: CT, width: w });
    if (want === 'indexed') {
      if (spec.kind === 'points') throw new Error('wfr write: points take points(), not vertices()/cells()');
      V1 = new BatchWriter([P3(3), ...fields(vA, 'V:')], ctx.scratch.spill('v1'), PAGE);
      C1 = new BatchWriter([{ name: 'i', Type: Uint32Array, width: k }, ...fields(cA, 'C:')], ctx.scratch.spill('c1'), 8192);
    } else if (want === 'soup') {
      if (spec.kind === 'points') throw new Error('wfr write: points take points(), not soup()');
      S1 = new BatchWriter([P3(3 * k), ...fields(cA, 'C:'), ...fields(vA, 'V:', k)], ctx.scratch.spill('s1'), 8192);
    } else {
      if (spec.kind !== 'points') throw new Error('wfr write: points() is for kind "points"');
      S1 = new BatchWriter([P3(3), ...fields(vA, 'V:')], ctx.scratch.spill('s1'), 8192);
    }
  };

  // n records of pw coordinates each (+ attribute arrays [field, array, width]) into bw
  async function pushRecords(bw, n, P, pw, arrs) {
    let i = 0;
    while (i < n) {
      const t = Math.min(bw.free, n - i), p = bw.f.p, o = bw.n;
      for (let r = 0; r < t; r++) for (let j = 0; j < pw; j++) {
        const a = j % 3, v = quant(P[(i + r) * pw + j], a);
        p[(o + r) * pw + j] = v;
        if (v < bb[a]) bb[a] = v; if (v > bb[a + 3]) bb[a + 3] = v;
      }
      for (const [f, a, w] of arrs) bw.f[f].set(a.subarray(i * w, (i + t) * w), o * w);
      bw.advance(t); i += t;
      if (!bw.free) await bw.flush();
    }
  }

  return {
    get name() { return spec.name; },
    // string attribute value → code, for adapters that pass Int32Array codes
    label: (name, s, location = spec.kind === 'points' ? 'vertices' : 'cells') => code((location === 'vertices' ? 'V:' : 'C:') + name, s),
    async vertices(P, attrs) {
      setMode('indexed', P);
      const n = P.length / 3;
      await pushRecords(V1, n, P, 3, prep(attrs, vA, 'V:', n).map(([f, a]) => [f, a, 1]));
      nv += n;
    },
    async cells(I, attrs) {
      setMode('indexed');
      const n = I.length / k;
      if (!Number.isInteger(n)) throw new Error(`wfr write: cells need ${k} indices each`);
      const arrs = prep(attrs, cA, 'C:', n);
      let i = 0;
      while (i < n) {
        const t = Math.min(C1.free, n - i), d = C1.f.i, o = C1.n;
        for (let r = 0; r < t * k; r++) {
          const v = I[i * k + r];
          if (!(v >= 0) || v !== Math.floor(v)) throw new Error(`wfr write: bad cell index ${v}`);
          for (let q = 0; q < r % k; q++) if (I[i * k + r - 1 - q] === v) throw new Error(`wfr write: a cell repeats vertex ${v}`);
          d[o * k + r] = v;
          const wd = v >>> 5;
          if (wd >= refBits.length) { const g = new Uint32Array(Math.max(refBits.length * 2, wd + 1)); g.set(refBits); refBits = g; }
          refBits[wd] |= 1 << (v & 31);
        }
        for (const [f, a] of arrs) C1.f[f].set(a.subarray(i, i + t), o);
        C1.advance(t); i += t;
        if (!C1.free) await C1.flush();
      }
      m += n;
    },
    async soup(P, cellAttrs, cornerAttrs) {
      setMode('soup', P);
      const n = P.length / (3 * k);
      if (!Number.isInteger(n)) throw new Error(`wfr write: soup needs ${3 * k} coordinates per cell`);
      const arrs = [...prep(cellAttrs, cA, 'C:', n).map(([f, a]) => [f, a, 1]), ...prep(cornerAttrs, vA, 'V:', n * k).map(([f, a]) => [f, a, k])];
      await pushRecords(S1, n, P, 3 * k, arrs);
      m += n;
    },
    async points(P, attrs) {
      setMode('points', P);
      const n = P.length / 3;
      await pushRecords(S1, n, P, 3, prep(attrs, vA, 'V:', n).map(([f, a]) => [f, a, 1]));
      m += n; nv += n;
    },
    end: (zw) => finish(zw),
  };

  // ── after the source: keys, partition, weld, bricks, topology ─────────────────────────────────
  async function finish(zw) {
    for (const bw of [V1, C1, S1]) if (bw) await bw.flush();
    if (grid && !origin) origin = [0, 0, 0];
    const empty = m === 0;
    const sbox = empty ? [0, 0, 0, 0, 0, 0] : bb.slice();
    const key48 = keyer(sbox);
    const toWorld = (v, a) => (grid ? origin[a] + S[a] * v : v);
    const recPrefix = mode === 'points' ? 'V:' : 'C:';
    const recTypes = mode === 'points' ? vA : cA;

    // brickBy groups: values in sorted order → group code (composite key g·2^kb + key48 >> (48−kb))
    let G = 1, groupOf = null, gField = null;
    const src = mode === 'indexed' ? C1 : S1;
    if (spec.brickBy) {
      const n = spec.brickBy, t = recTypes[n];
      if (!t) throw new Error(`wfr write: brickBy "${n}" is not a ${mode === 'points' ? 'vertex' : 'cell'} attribute`);
      gField = recPrefix + n;
      if (t === 'string') {
        const list = labels[gField].list, order = list.map((s, i) => i).sort((a, b) => (list[a] < list[b] ? -1 : list[a] > list[b] ? 1 : 0));
        const r = new Int32Array(list.length); order.forEach((i, j) => { r[i] = j; });
        G = Math.max(1, list.length); groupOf = (v) => r[v];
      } else if (src) {
        const vals = new Set();
        for await (const u8 of src.spill.read()) { const c = decodeBatch(src.schema, u8), a = c[gField]; for (let i = 0; i < c.n; i++) vals.add(a[i]); }
        const sorted = [...vals].sort((a, b) => a - b), map = new Map(sorted.map((v, i) => [v, i]));
        G = Math.max(1, sorted.length); groupOf = (v) => map.get(v);
      }
    }
    const gbits = G <= 1 ? 0 : Math.ceil(Math.log2(G));
    if (gbits > 32) throw new Error('wfr write: too many brickBy groups');
    const kb = Math.min(48, 53 - gbits), KS = 2 ** (gbits + kb), kdiv = 2 ** (48 - kb), gmul = 2 ** kb;

    // indexed: referenced vertices → dense vid by rank
    let rankPrefix = null, V = nv;
    const popc = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24; };
    if (mode === 'indexed') {
      const words = Math.ceil(nv / 32);
      rankPrefix = new Uint32Array(words + 1);
      for (let w = 0; w < words; w++) rankPrefix[w + 1] = rankPrefix[w] + popc(w < refBits.length ? refBits[w] : 0);
      V = rankPrefix[words];
    }
    const rank = (i) => { const w = i >>> 5, b = i & 31; return rankPrefix[w] + (b ? popc(refBits[w] & ((1 << b) - 1)) : 0); };
    const vpage = V1 ? chunkCache(V1.spill, V1.schema, ctx.cacheBytes) : null;

    // pass 2: keyed face records F0 (+ soup corners W0) from the pass-1 spills
    const F0s = [{ name: 'key', Type: Float64Array, width: 1 }, { name: 'p', Type: CT, width: 3 * k },
      ...(mode === 'soup' ? [] : [{ name: 'src', Type: Uint32Array, width: k }]), ...fields(recTypes, recPrefix)];
    const W0s = [{ name: 'key', Type: Float64Array, width: 1 }, { name: 'p', Type: CT, width: 3 }, ...fields(vA, 'V:')];
    const F0 = new BatchWriter(F0s, ctx.scratch.spill('f0'), 8192);
    const W0 = mode === 'soup' ? new BatchWriter(W0s, ctx.scratch.spill('w0'), 8192) : null;
    let hw = 1; while (KS / hw > NB) hw *= 2;
    const fh = { w: hw, lo: 0, c: new Float64Array(Math.ceil(KS / hw)) };
    let ww = 1; while (2 ** 48 / ww > NB) ww *= 2;
    const wh = { w: ww, lo: 0, c: new Float64Array(Math.ceil(2 ** 48 / ww)) };
    const recF = fields(recTypes, recPrefix).map((f) => f.name), vF = fields(vA, 'V:').map((f) => f.name);
    let seq = 0;
    // synchronous inner loop over records [i, c.n) of one chunk; stops (returning the index to
    // resume at) when an output batch fills or a vertex page isn't resident (→ missPage)
    let missPage = -1;
    const indexed = mode === 'indexed';
    function pass2(c, i) {
      const P = F0.f.p, key = F0.f.key, fsrc = F0.f.src, ci = c.i, cp = c.p;
      for (; i < c.n; i++) {
        if (!F0.free || (W0 && W0.free < k)) return i;
        if (indexed) for (let j = 0; j < k; j++) { const pi = Math.floor(ci[i * k + j] / PAGE); if (vpage.get(pi) === null) { missPage = pi; return i; } }
        const o = F0.n;
        let cx = 0, cy = 0, cz = 0;
        for (let j = 0; j < k; j++) {
          let x, y, z;
          if (indexed) {
            const vi = ci[i * k + j];
            if (vi >= nv) throw new Error(`wfr write: element "${spec.name}" cell index ${vi} ≥ ${nv} vertices`);
            const pg = vpage.get(Math.floor(vi / PAGE)).p, r = 3 * (vi % PAGE);
            x = pg[r]; y = pg[r + 1]; z = pg[r + 2];
            fsrc[o * k + j] = vi;
          } else { const r = (i * k + j) * 3; x = cp[r]; y = cp[r + 1]; z = cp[r + 2]; }
          const d = (o * k + j) * 3;
          P[d] = x; P[d + 1] = y; P[d + 2] = z;
          cx += x; cy += y; cz += z;
          if (W0) {
            const wo = W0.n, kk = key48(x, y, z);
            W0.f.key[wo] = kk; W0.f.p[3 * wo] = x; W0.f.p[3 * wo + 1] = y; W0.f.p[3 * wo + 2] = z;
            for (const f of vF) W0.f[f][wo] = c[f][i * k + j];
            W0.advance(1);
            wh.c[Math.floor(kk / ww)]++;
          }
        }
        if (mode === 'points') fsrc[o] = seq;
        seq++;
        const g = groupOf ? groupOf(c[gField][i]) : 0;
        const kk = g * gmul + Math.floor(key48(cx / k, cy / k, cz / k) / kdiv);
        key[o] = kk;
        fh.c[Math.floor(kk / hw)]++;
        for (const f of recF) F0.f[f][o] = c[f][i];
        F0.advance(1);
      }
      return i;
    }
    if (src) {
      for await (const u8 of src.spill.read()) {
        const c = decodeBatch(src.schema, u8);
        let i = 0;
        while (i < c.n) {
          missPage = -1;
          i = pass2(c, i);
          if (missPage >= 0) await vpage.load(missPage);
          if (!F0.free) await F0.flush();
          if (W0 && W0.free < k) await W0.flush();
        }
      }
      await src.spill.delete();
    }
    await F0.flush(); if (W0) await W0.flush();

    // soup: weld — per corner leaf, unique by (key, x, y, z); vid = global rank in that order
    const weldLeaves = [];
    let U = null;
    if (mode === 'soup') {
      U = ctx.scratch.spill('u');
      let vidStart = 0, chunk = 0;
      await partition(ctx, W0.spill, W0s, W0.count, 0, 2 ** 48, wh, async (rec, piece) => {
        const n = rec.n, perm = sortKeys(rec.key, n), key = rec.key, p = rec.p;
        for (let s = 0; s < n;) { // ties on key: by (x, y, z), stable
          let e = s + 1, same = true;
          const a0 = perm[s];
          while (e < n && key[perm[e]] === key[a0]) { const b = perm[e]; if (same && (p[3 * b] !== p[3 * a0] || p[3 * b + 1] !== p[3 * a0 + 1] || p[3 * b + 2] !== p[3 * a0 + 2])) same = false; e++; }
          if (e - s > 1 && !same) { // only runs that hold distinct positions need ordering
            const run = Array.from(perm.subarray(s, e));
            run.sort((a, b) => (p[3 * a] - p[3 * b]) || (p[3 * a + 1] - p[3 * b + 1]) || (p[3 * a + 2] - p[3 * b + 2]) || (a - b));
            perm.set(run, s);
          }
          s = e;
        }
        const keep = [];
        for (let i = 0; i < n; i++) {
          const a = perm[i], b = i ? perm[i - 1] : -1;
          if (b >= 0 && key[a] === key[b] && p[3 * a] === p[3 * b] && p[3 * a + 1] === p[3 * b + 1] && p[3 * a + 2] === p[3 * b + 2]) continue;
          keep.push(a);
        }
        const uniq = gather(W0s, rec, Uint32Array.from(keep));
        if (piece && weldLeaves.length && weldLeaves[weldLeaves.length - 1].lo === uniq.key[0]) throw new Error('wfr write: too many coincident corners in one Morton cell for the memory budget');
        await U.append(encodeChunk(W0s, uniq.n, uniq));
        weldLeaves.push({ lo: uniq.key[0], vidStart, chunk: chunk++, n: uniq.n });
        vidStart += uniq.n;
      });
      V = vidStart;
    }
    const ucache = U ? chunkCache(U, W0s, ctx.cacheBytes) : null;
    const leafFor = (kk) => { let a = 0, b = weldLeaves.length - 1; while (a < b) { const mid = (a + b + 1) >> 1; if (weldLeaves[mid].lo <= kk) a = mid; else b = mid - 1; } return weldLeaves[a]; };
    const weldIn = (t, L, kk, x, y, z) => {
      const key = t.key, p = t.p;
      let lo = 0, hi = t.n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const d = (key[mid] - kk) || (p[3 * mid] - x) || (p[3 * mid + 1] - y) || (p[3 * mid + 2] - z);
        if (d === 0) return mid;
        if (d < 0) lo = mid + 1; else hi = mid - 1;
      }
      throw new Error('wfr write: internal — welded vertex not found');
    };

    // outputs: the vertex table streams into the zip; the cell table goes to scratch, copied in after
    const path = `elements/${encodeURIComponent(spec.name)}/`;
    const coords = grid ? { mode: 'grid', origin, step } : { mode: 'float64' };
    const kvFor = (table) => ({ wireframe: JSON.stringify({ version: FORMAT_VERSION, spec: SPEC_URL, element: spec.name, kind: spec.kind, table, ...(table === 'vertices' ? { coords } : {}) }) });
    const ctype = grid ? { type: 'INT32', encoding: 'DELTA_BINARY_PACKED' } : { type: 'DOUBLE', encoding: 'BYTE_STREAM_SPLIT' };
    const keepVid = spec.kind !== 'points' || !!spec.keepVid;
    const pqCol = (n, t, prefix) => ({ name: n, ...PQ[t], ...(t === 'string' ? { labels: labels[prefix + n].list } : {}) });
    const vcols = [{ name: 'x', ...ctype }, { name: 'y', ...ctype }, { name: 'z', ...ctype },
      ...(keepVid ? [{ name: 'vid', type: 'INT32', encoding: 'DELTA_BINARY_PACKED' }] : []), ...Object.entries(vA).map(([n, t]) => pqCol(n, t, 'V:'))];
    const ccols = spec.kind === 'points' ? null
      : [...CELL_COLS[spec.kind].map((n) => ({ name: n, type: 'INT32', encoding: 'DELTA_BINARY_PACKED' })), ...Object.entries(cA).map(([n, t]) => pqCol(n, t, 'C:'))];
    const vmember = zw.begin(path + 'vertices.parquet');
    const vps = new ParquetStream(vmember, vcols, { kv: kvFor('vertices') });
    let cspill = null, ccrc = 0, csize = 0, cps = null;
    if (ccols) {
      cspill = ctx.scratch.spill('cells');
      cps = new ParquetStream({ write: async (b) => { ccrc = crc32(b, ccrc); csize += b.length; await cspill.append(b); } }, ccols, { kv: kvFor('cells') });
    }

    // topology check: half-edges keyed by their lower vid, vertex links keyed by vid
    const check = spec.kind === 'triangles' && spec.topology === 'check';
    const L_S = [{ name: 'key', Type: Float64Array, width: 1 }, { name: 'bc', Type: Int32Array, width: 2 }];
    const E_S = [{ name: 'key', Type: Float64Array, width: 1 }, { name: 'hi', Type: Float64Array, width: 1 }, { name: 'dir', Type: Uint8Array, width: 1 }];
    const edgeW = check ? new BatchWriter(E_S, ctx.scratch.spill('edges'), 8192) : null;
    const linkW = check ? new BatchWriter(L_S, ctx.scratch.spill('links'), 8192) : null;
    let vol6 = 0, vref = null;

    const directory = [];
    let rowBase = 0, carry = null, brickCount = 0;
    const local = new LocalIndex(target * k);
    const vNames = Object.keys(vA), cNames = Object.keys(cA);
    const tri = new Float64Array(12);
    const wv = new Float64Array(3), wtab = [null, null, null], wrow = new Int32Array(3);   // soup: one cell's welded corners
    let dropped = 0;                                       // soup cells collapsed by welding

    async function emitBrick(rec, s, e) {
      local.clear();
      const nc = e - s, cap = mode === 'points' ? nc : nc * k;
      const X = new CT(cap), Y = new CT(cap), Z = new CT(cap), VID = new Int32Array(cap);
      const vat = vNames.map((n) => new ATTR[vA[n]](cap));
      const cells = ccols ? CELL_COLS[spec.kind].map(() => new Int32Array(nc)) : null;
      let rows = 0, miss = null, nk = 0;                     // nk: cells kept (soup drops collapsed ones)
      const kept = mode === 'soup' ? new Int32Array(nc) : null;
      const needAttrPages = mode === 'indexed' && vNames.length > 0;
      // records [i, e) synchronously; returns where it stopped (a chunk to load → miss, or a full topology batch)
      const run = (i) => {
        for (; i < e; i++) {
          // everything record i needs must be resident before any of its corners is taken
          if (check && (linkW.free < 3 || edgeW.free < 3)) return i;
          for (let j = 0; j < k; j++) {
            if (mode === 'soup') {
              const pi = (i * k + j) * 3, L = leafFor(key48(rec.p[pi], rec.p[pi + 1], rec.p[pi + 2]));
              if (ucache.get(L.chunk) === null) { miss = [ucache, L.chunk]; return i; }
            } else if (needAttrPages) {
              const pg = Math.floor(rec.src[i * k + j] / PAGE);
              if (vpage.get(pg) === null) { miss = [vpage, pg]; return i; }
            }
          }
          // soup: weld every corner first — corners closer than the grid step weld to ONE vertex, and a
          // cell that collapses that way would repeat a vertex row (SPEC §7.1): it is dropped here,
          // before it can create rows nothing references
          if (mode === 'soup') {
            for (let j = 0; j < k; j++) {
              const pi = (i * k + j) * 3, x = rec.p[pi], y = rec.p[pi + 1], z = rec.p[pi + 2];
              const kk = key48(x, y, z), L = leafFor(kk), wt = ucache.get(L.chunk), wr = weldIn(wt, L, kk, x, y, z);
              wv[j] = L.vidStart + wr; wtab[j] = wt; wrow[j] = wr;
            }
            if (wv[0] === wv[1] || (k === 3 && (wv[1] === wv[2] || wv[0] === wv[2]))) { dropped++; continue; }
            kept[nk] = i - s;
          }
          const ci = mode === 'soup' ? nk++ : i - s;
          for (let j = 0; j < k; j++) {
            const pi = (i * k + j) * 3, x = rec.p[pi], y = rec.p[pi + 1], z = rec.p[pi + 2];
            let vid, wt = null, wr = 0;
            if (mode === 'indexed') vid = rank(rec.src[i * k + j]);
            else if (mode === 'soup') { vid = wv[j]; wt = wtab[j]; wr = wrow[j]; }
            else vid = rec.src[i];
            let row = mode === 'points' ? -1 : local.get(vid);
            if (row < 0) {
              row = rows++;
              if (mode !== 'points') local.set(vid, row);
              X[row] = x; Y[row] = y; Z[row] = z; VID[row] = vid;
              if (vNames.length) {
                let from, at;
                if (mode === 'indexed') { const vi = rec.src[i * k + j]; from = vpage.get(Math.floor(vi / PAGE)); at = vi % PAGE; }
                else if (mode === 'soup') { from = wt; at = wr; }
                else { from = rec; at = i; }
                for (let q = 0; q < vNames.length; q++) vat[q][row] = from['V:' + vNames[q]][at];
              }
            }
            if (cells) cells[j][ci] = rowBase + row;
            if (check) { tri[4 * j] = vid; tri[4 * j + 1] = x; tri[4 * j + 2] = y; tri[4 * j + 3] = z; }
          }
          if (check) {
            if (!vref) vref = [tri[1], tri[2], tri[3]];
            const sx = grid ? S[0] : 1, sy = grid ? S[1] : 1, sz = grid ? S[2] : 1;
            const Ax = (tri[1] - vref[0]) * sx, Ay = (tri[2] - vref[1]) * sy, Az = (tri[3] - vref[2]) * sz;
            const Bx = (tri[5] - vref[0]) * sx, By = (tri[6] - vref[1]) * sy, Bz = (tri[7] - vref[2]) * sz;
            const Cx = (tri[9] - vref[0]) * sx, Cy = (tri[10] - vref[1]) * sy, Cz = (tri[11] - vref[2]) * sz;
            vol6 += Ax * (By * Cz - Bz * Cy) - Ay * (Bx * Cz - Bz * Cx) + Az * (Bx * Cy - By * Cx);
            for (let c = 0; c < 3; c++) {
              const u = tri[4 * c], v = tri[4 * ((c + 1) % 3)], q = tri[4 * ((c + 2) % 3)];
              const o = linkW.n; linkW.f.key[o] = u; linkW.f.bc[2 * o] = v; linkW.f.bc[2 * o + 1] = q; linkW.advance(1);
              const eo = edgeW.n; edgeW.f.key[eo] = u < v ? u : v; edgeW.f.hi[eo] = u < v ? v : u; edgeW.f.dir[eo] = u < v ? 1 : 0; edgeW.advance(1);
            }
          }
        }
        return i;
      };
      for (let i = s; i < e;) {
        miss = null;
        i = run(i);
        if (miss) await miss[0].load(miss[1]);
        if (check) { if (linkW.free < 3) await linkW.flush(); if (edgeW.free < 3) await edgeW.flush(); }
      }
      const ncOut = mode === 'soup' ? nk : nc;
      if (!ncOut) return;                                  // every cell collapsed: no brick at all
      const vdata = { x: X, y: Y, z: Z, vid: VID };
      vNames.forEach((n, q) => { vdata[n] = toPQ(vat[q], vA[n]); });
      await vps.writeRowGroup(vdata, rows);
      if (cells) {
        const cdata = Object.fromEntries(CELL_COLS[spec.kind].map((n, j) => [n, cells[j]]));
        for (const n of cNames) {
          let a = rec['C:' + n].subarray(s, e);
          if (ncOut < nc) { const g = new a.constructor(ncOut); for (let q = 0; q < ncOut; q++) g[q] = a[kept[q]]; a = g; }
          cdata[n] = toPQ(a, cA[n]);
        }
        await cps.writeRowGroup(cdata, ncOut);
      }
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], C = [X, Y, Z];
      for (let a = 0; a < 3; a++) { const A = C[a]; for (let r = 0; r < rows; r++) { const q = A[r]; if (q < b[a]) b[a] = q; if (q > b[a + 3]) b[a + 3] = q; } }
      directory.push([rows, ccols ? ncOut : 0, b.map((q, i) => toWorld(q, i % 3))]);
      rowBase += rows; brickCount++;
    }
    async function cut(rec) {
      const n = rec.n;
      let s = 0;
      while (s < n) {
        let e = Math.min(n, s + target), split = false;
        const g = Math.floor(rec.key[s] / gmul);
        for (let j = s + 1; j < e; j++) if (Math.floor(rec.key[j] / gmul) !== g) { e = j; split = true; break; }
        if (e === n && !split && e - s < target) { carry = slice(F0s, rec, s, n); return; }
        await emitBrick(rec, s, e);
        s = e;
      }
      carry = null;
    }
    await partition(ctx, F0.spill, F0s, F0.count, 0, KS, fh, async (rec) => {
      await cut(gather(F0s, rec, sortKeys(rec.key, rec.n), carry));
    });
    if (carry && carry.n) await emitBrick(carry, 0, carry.n);
    if (U) await U.delete();
    if (V1) await V1.spill.delete();

    await vps.finish();
    const vinfo = await vmember.end();
    let cinfo = null;
    if (cps) {
      await cps.finish();
      cinfo = await zw.addChunks(path + 'cells.parquet', csize, ccrc, cspill.read());
      await cspill.delete();
    }

    let topology;
    if (spec.kind === 'triangles') topology = check ? await checkStreamed()
      : { closed: null, oriented: null, manifold: null, volume: null, ...(typeof spec.topology === 'object' ? spec.topology : {}), status: 'declared' };
    async function checkStreamed() {
      await edgeW.flush(); await linkW.flush();
      let closed = true, oriented = true, manifold = true;
      const span = 2 ** Math.ceil(Math.log2(Math.max(2, V)));
      await partition(ctx, edgeW.spill, E_S, edgeW.count, 0, span, null, async (rec, piece) => {
        if (piece) throw new Error('wfr write: a vertex has too many edges for the memory budget');
        const perm = sortKeys2(rec.key, rec.hi, rec.n), key = rec.key, hi = rec.hi, dir = rec.dir;
        for (let s = 0; s < rec.n;) {
          const a = perm[s];
          let e = s + 1, fwd = dir[a], rev = 1 - dir[a];
          while (e < rec.n && key[perm[e]] === key[a] && hi[perm[e]] === hi[a]) { fwd += dir[perm[e]]; rev += 1 - dir[perm[e]]; e++; }
          const tot = e - s;
          if (tot !== 2) closed = false;
          if (fwd > 1 || rev > 1) oriented = false;
          if (tot > 2) manifold = false;
          s = e;
        }
      });
      await partition(ctx, linkW.spill, L_S, linkW.count, 0, span, null, async (rec, piece) => {
        if (piece) throw new Error('wfr write: a vertex has too many faces for the memory budget');
        if (!manifold) return;
        const perm = sortKeys(rec.key, rec.n), key = rec.key, bc = rec.bc;
        // the link of one vertex: small, so linear scans over typed scratch beat maps
        let cap = 64, nodes = new Int32Array(cap), ndeg = new Int32Array(cap), par = new Int32Array(cap), ea = new Int32Array(cap), eb = new Int32Array(cap);
        const find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
        for (let s = 0; s < rec.n && manifold;) {
          let e = s + 1; while (e < rec.n && key[perm[e]] === key[perm[s]]) e++;
          const mm = e - s;
          if (2 * mm > cap) { cap = 4 * mm; nodes = new Int32Array(cap); ndeg = new Int32Array(cap); par = new Int32Array(cap); ea = new Int32Array(cap); eb = new Int32Array(cap); }
          let kk = 0;
          const id = (x) => { for (let i = 0; i < kk; i++) if (nodes[i] === x) return i; nodes[kk] = x; ndeg[kk] = 0; return kk++; };
          for (let i = 0; i < mm; i++) { const r = perm[s + i], p = id(bc[2 * r]), q = id(bc[2 * r + 1]); ndeg[p]++; ndeg[q]++; ea[i] = p; eb[i] = q; }
          let bad = mm !== kk && mm !== kk - 1;
          for (let i = 0; i < kk && !bad; i++) if (ndeg[i] > 2) bad = true;
          if (!bad) {
            for (let i = 0; i < kk; i++) par[i] = i;
            for (let i = 0; i < mm; i++) par[find(ea[i])] = find(eb[i]);
            const r0 = find(0);
            for (let i = 1; i < kk; i++) if (find(i) !== r0) { bad = true; break; }
          }
          if (bad) { manifold = false; break; }
          s = e;
        }
      });
      return { closed, oriented, manifold, volume: closed && oriented ? vol6 / 6 : null, status: 'checked' };
    }

    const columns = [
      ...vNames.map((n) => ({ location: 'vertices', name: n, member: 'vertices.parquet' })),
      ...cNames.map((n) => ({ location: 'cells', name: n, member: 'cells.parquet' })),
    ];
    const manifest = {
      name: spec.name, path, kind: spec.kind, coords,
      counts: { vertices: V, vertexRows: rowBase, cells: spec.kind === 'points' ? 0 : m - dropped, bricks: brickCount },
      bbox: empty ? null : sbox.map((q, i) => toWorld(q, i % 3)), ...(topology ? { topology } : {}),
      bricks: { order: { by: spec.brickBy ? [spec.brickBy] : [], then: 'morton' }, target, directory },
      columns, meta: spec.meta || {},
    };
    const members = { [path + 'vertices.parquet']: vinfo };
    if (cinfo) members[path + 'cells.parquet'] = cinfo;
    return { manifest, members };
  }
}

// stored attribute array → the Parquet column's array type
function toPQ(a, t) { return t === 'f64' || t === 'f32' || t === 'i32' || t === 'string' ? a : Int32Array.from(a); }
