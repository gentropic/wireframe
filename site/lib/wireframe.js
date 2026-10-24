// @gcu/wireframe (src/index.js) @ 0682659 — built by site/build.mjs (MIT)

// ── src/zip.js ──

// ZIP for .wfr: a ranged reader (central directory → member byte ranges, nothing read whole)
// and a STORED-only streaming writer with Zip64 and 64-byte data alignment (SPEC §3).

// ── sources: { size, read(offset, length) → Promise<Uint8Array> } ──────────────────────────────
function bytesSource(u8) {
  return { size: u8.length, read: async (off, len) => u8.subarray(off, off + len) };
}
function blobSource(blob) {
  return { size: blob.size, read: async (off, len) => new Uint8Array(await blob.slice(off, off + len).arrayBuffer()) };
}

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u64 = (b, p) => u32(b, p) + u32(b, p + 4) * 4294967296;
const td$zip = new TextDecoder();

// ── reader ─────────────────────────────────────────────────────────────────────────────────────
// → { entries: Map(name → { name, method, crc, size, localOffset }), dataRange(entry) → Promise<{offset,size}> }
async function openZip(src) {
  const tailLen = Math.min(src.size, 65557 + 20);
  const tail = await src.read(src.size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('zip: no end-of-central-directory record');
  let count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if (e >= 20 && u32(tail, e - 20) === 0x07064b50) {
    const z64 = u64(tail, e - 20 + 8);
    const rec = await src.read(z64, 56);
    if (u32(rec, 0) !== 0x06064b50) throw new Error('zip: bad zip64 end-of-central-directory');
    count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
  }
  const cd = await src.read(cdOff, cdSize);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = u16(cd, p + 10), crc = u32(cd, p + 16);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24), lho = u32(cd, p + 42);
    const nlen = u16(cd, p + 28), elen = u16(cd, p + 30), clen = u16(cd, p + 32);
    const name = td$zip.decode(cd.subarray(p + 46, p + 46 + nlen));
    let x = p + 46 + nlen; const xe = x + elen;
    while (x + 4 <= xe) {
      const id = u16(cd, x), sz = u16(cd, x + 2); let q = x + 4;
      if (id === 1) {
        if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (lho === 0xffffffff) { lho = u64(cd, q); q += 8; }
      }
      x += 4 + sz;
    }
    entries.set(name, { name, method, crc, size: usize, csize, localOffset: lho });
    p = xe + clen;
  }
  async function dataRange(entry) {
    if (entry.dataOffset === undefined) {
      const lh = await src.read(entry.localOffset, 30);
      if (u32(lh, 0) !== 0x04034b50) throw new Error(`zip: bad local header for ${entry.name}`);
      entry.dataOffset = entry.localOffset + 30 + u16(lh, 26) + u16(lh, 28);
    }
    return { offset: entry.dataOffset, size: entry.csize };
  }
  return { entries, dataRange, cdOffset: cdOff };
}

// ── CRC-32 (slice-by-8) ────────────────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  for (let n = 0; n < 256; n++) for (let s = 1; s < 8; s++) t[s * 256 + n] = (t[(s - 1) * 256 + n] >>> 8) ^ t[t[(s - 1) * 256 + n] & 255];
  return t;
})();
function crc32(b, crc = 0) {
  let c = ~crc >>> 0, i = 0;
  const n8 = b.length & ~7;
  for (; i < n8; i += 8) {
    const lo = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) ^ c;
    c = CRC[1792 + (lo & 255)] ^ CRC[1536 + ((lo >>> 8) & 255)] ^ CRC[1280 + ((lo >>> 16) & 255)] ^ CRC[1024 + (lo >>> 24)] ^
      CRC[768 + b[i + 4]] ^ CRC[512 + b[i + 5]] ^ CRC[256 + b[i + 6]] ^ CRC[b[i + 7]];
  }
  for (; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

// ── writer ─────────────────────────────────────────────────────────────────────────────────────
// sink: { write(Uint8Array) → void|Promise }. Members are whole byte arrays (sizes and CRC known
// up front, so no data descriptors). DOS timestamp fixed at 1980-01-01 so output is deterministic.
const te$zip = new TextEncoder();
const MAX32 = 0xffffffff;
function le(view, p, v, bytes) { for (let i = 0; i < bytes; i++) { view[p + i] = v % 256; v = Math.floor(v / 256); } }

// SHA-256 of consecutive `block`-byte spans, fed incrementally (WebCrypto digests whole buffers).
function blockHasher(block = 16 * 1024 * 1024) {
  let buf = new Uint8Array(Math.min(block, 1 << 20)), n = 0;
  const out = [];
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  const digest = async () => { out.push(hex(await crypto.subtle.digest('SHA-256', buf.subarray(0, n)))); n = 0; };
  return {
    async update(c) {
      let p = 0;
      while (p < c.length) {
        if (n === buf.length && buf.length < block) { const b = new Uint8Array(Math.min(block, buf.length * 2)); b.set(buf); buf = b; }
        const k = Math.min(c.length - p, buf.length - n);
        buf.set(c.subarray(p, p + k), n); n += k; p += k;
        if (n === block) await digest();
      }
    },
    async finish() { if (n) await digest(); return out; },
  };
}

function createZipWriter(sink, { align = 64 } = {}) {
  let offset = 0;
  const cd = [];
  const put = async (b) => { await sink.write(b); offset += b.length; };
  // Local header. Streamed members carry a Zip64 extra with zero sizes; the descriptor has them.
  const localHeader = (nameB, { size = 0, crc = 0, streamed, aligned }) => {
    const big = streamed || size >= MAX32;
    const z64 = big ? 20 : 0;
    let pad = 0;
    const doAlign = aligned && align > 1;
    if (doAlign) {
      const base = offset + 30 + nameB.length + z64 + 6; // + 0xD935 record header (4) + alignment (2)
      pad = (align - (base % align)) % align;
    }
    const elen = z64 + (doAlign ? 6 + pad : 0);
    const h = new Uint8Array(30 + nameB.length + elen);
    le(h, 0, 0x04034b50, 4); le(h, 4, big ? 45 : 20, 2); le(h, 6, streamed ? 0x0808 : 0x0800, 2); le(h, 8, 0, 2);
    le(h, 10, 0, 2); le(h, 12, 0x21, 2); le(h, 14, streamed ? 0 : crc, 4);
    le(h, 18, big ? MAX32 : size, 4); le(h, 22, big ? MAX32 : size, 4);
    le(h, 26, nameB.length, 2); le(h, 28, elen, 2); h.set(nameB, 30);
    let x = 30 + nameB.length;
    if (big) { le(h, x, 1, 2); le(h, x + 2, 16, 2); le(h, x + 4, streamed ? 0 : size, 8); le(h, x + 12, streamed ? 0 : size, 8); x += 20; }
    if (doAlign) { le(h, x, 0xd935, 2); le(h, x + 2, 2 + pad, 2); le(h, x + 4, align, 2); }
    return h;
  };
  return {
    get offset() { return offset; },
    // a whole member at once
    async add(name, data, opts = {}) {
      return this.addChunks(name, data.length, crc32(data), [data], opts);
    },
    // a member whose size and CRC are known, written from an (async) iterable of chunks
    async addChunks(name, size, crc, chunks, { aligned = true, hash = true } = {}) {
      const nameB = te$zip.encode(name), localOffset = offset;
      await put(localHeader(nameB, { size, crc, streamed: false, aligned }));
      const h = hash ? blockHasher() : null;
      let n = 0;
      for await (const c of chunks) { await put(c); if (h) await h.update(c); n += c.length; }
      if (n !== size) throw new Error(`zip: member ${name} wrote ${n} bytes, declared ${size}`);
      cd.push({ nameB, size, crc, localOffset, flags: 0x0800 });
      return { size, crc, sha256: h ? await h.finish() : null };
    },
    // a member of unknown size: data descriptor (flag bit 3) + Zip64 sizes after the data
    begin(name, { aligned = true, hash = true } = {}) {
      const nameB = te$zip.encode(name), localOffset = offset;
      let crc = 0, size = 0, started = false;
      const h = hash ? blockHasher() : null;
      const start = async () => { if (!started) { started = true; await put(localHeader(nameB, { streamed: true, aligned })); } };
      return {
        async write(c) { await start(); crc = crc32(c, crc); size += c.length; await put(c); if (h) await h.update(c); },
        async end() {
          await start();
          const d = new Uint8Array(24);
          le(d, 0, 0x08074b50, 4); le(d, 4, crc, 4); le(d, 8, size, 8); le(d, 16, size, 8);
          await put(d);
          cd.push({ nameB, size, crc, localOffset, flags: 0x0808 });
          return { size, crc, sha256: h ? await h.finish() : null };
        },
      };
    },
    async finish() {
      const cdStart = offset;
      for (const e of cd) {
        const needSize = e.size >= MAX32, needOff = e.localOffset >= MAX32;
        const z = (needSize ? 16 : 0) + (needOff ? 8 : 0);
        const elen = z ? 4 + z : 0;
        const h = new Uint8Array(46 + e.nameB.length + elen);
        le(h, 0, 0x02014b50, 4); le(h, 4, 45, 2); le(h, 6, z || e.flags & 8 ? 45 : 20, 2); le(h, 8, e.flags, 2); le(h, 10, 0, 2);
        le(h, 12, 0, 2); le(h, 14, 0x21, 2); le(h, 16, e.crc, 4);
        le(h, 20, needSize ? MAX32 : e.size, 4); le(h, 24, needSize ? MAX32 : e.size, 4);
        le(h, 28, e.nameB.length, 2); le(h, 30, elen, 2); le(h, 32, 0, 2); le(h, 34, 0, 2); le(h, 36, 0, 2); le(h, 38, 0, 4);
        le(h, 42, needOff ? MAX32 : e.localOffset, 4); h.set(e.nameB, 46);
        if (z) {
          let x = 46 + e.nameB.length;
          le(h, x, 1, 2); le(h, x + 2, z, 2); x += 4;
          if (needSize) { le(h, x, e.size, 8); le(h, x + 8, e.size, 8); x += 16; }
          if (needOff) le(h, x, e.localOffset, 8);
        }
        await put(h);
      }
      const cdSize = offset - cdStart;
      const z64 = cd.length > 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
      if (z64) {
        const r = new Uint8Array(56 + 20), zOff = offset;
        le(r, 0, 0x06064b50, 4); le(r, 4, 44, 8); le(r, 12, 45, 2); le(r, 14, 45, 2); le(r, 16, 0, 4); le(r, 20, 0, 4);
        le(r, 24, cd.length, 8); le(r, 32, cd.length, 8); le(r, 40, cdSize, 8); le(r, 48, cdStart, 8);
        le(r, 56, 0x07064b50, 4); le(r, 60, 0, 4); le(r, 64, zOff, 8); le(r, 72, 1, 4);
        await put(r);
      }
      const eo = new Uint8Array(22);
      le(eo, 0, 0x06054b50, 4); le(eo, 4, 0, 2); le(eo, 6, 0, 2);
      le(eo, 8, z64 ? 0xffff : cd.length, 2); le(eo, 10, z64 ? 0xffff : cd.length, 2);
      le(eo, 12, z64 ? MAX32 : cdSize, 4); le(eo, 16, z64 ? MAX32 : cdStart, 4); le(eo, 20, 0, 2);
      await put(eo);
      return { size: offset };
    },
  };
}

// ── src/thrift.js ──

// Thrift compact protocol — just enough to read Parquet footers and page headers.
// A struct decodes to a plain object keyed by field id: { 1: …, 4: […] }.

const T_TRUE = 1, T_FALSE = 2, T_BYTE = 3, T_I16 = 4, T_I32 = 5, T_I64 = 6, T_DOUBLE = 7,
  T_BINARY = 8, T_LIST = 9, T_SET = 10, T_MAP = 11, T_STRUCT = 12;

// Unsigned varint as a Number (exact below 2^53, which covers every Parquet offset and count).
function readVarint(r) {
  const B = r.b;
  let x = 0, mul = 1, byte;
  do { byte = B[r.p++]; x += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
  return x;
}
function zigzag(n) { return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }
const readZigzag = (r) => zigzag(readVarint(r));

function readValue(r, type) {
  switch (type) {
    case T_TRUE: return true;
    case T_FALSE: return false;
    case T_BYTE: { const v = r.b[r.p++]; return v > 127 ? v - 256 : v; }
    case T_I16: case T_I32: case T_I64: return readZigzag(r);
    case T_DOUBLE: { const v = new DataView(r.b.buffer, r.b.byteOffset + r.p, 8).getFloat64(0, true); r.p += 8; return v; }
    case T_BINARY: { const n = readVarint(r); const v = r.b.subarray(r.p, r.p + n); r.p += n; return v; }
    case T_LIST: case T_SET: {
      const h = r.b[r.p++], et = h & 15;
      let n = h >> 4; if (n === 15) n = readVarint(r);
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = et === T_TRUE || et === T_FALSE ? r.b[r.p++] === 1 : readValue(r, et);
      return a;
    }
    case T_MAP: {
      const n = readVarint(r); const m = new Map(); if (!n) return m;
      const kt = r.b[r.p++], kk = kt >> 4, vt = kt & 15;
      for (let i = 0; i < n; i++) m.set(readValue(r, kk), readValue(r, vt));
      return m;
    }
    case T_STRUCT: return readStruct(r);
    default: throw new Error(`thrift: unknown type ${type} at ${r.p}`);
  }
}

function readStruct(r) {
  const s = {};
  let fid = 0;
  for (;;) {
    const h = r.b[r.p++];
    if (h === 0) return s;
    const type = h & 15, d = h >> 4;
    fid = d ? fid + d : readZigzag(r);
    s[fid] = readValue(r, type);
  }
}

// Decode one struct from bytes at offset; returns { value, end }.
function decodeStruct(bytes, offset = 0) {
  const r = { b: bytes, p: offset };
  const value = readStruct(r);
  return { value, end: r.p };
}

// ── src/unpack.gen.js ──

// GENERATED by js/tools/gen-unpack.mjs — do not edit.
// Unpack one DELTA_BINARY_PACKED miniblock of 32 values at bit width w (the array index).

const DELTA32 = [
function delta32_0(dv, p, O, o, acc, md) {
  O[o + 0] = acc = (acc + md) | 0;
  O[o + 1] = acc = (acc + md) | 0;
  O[o + 2] = acc = (acc + md) | 0;
  O[o + 3] = acc = (acc + md) | 0;
  O[o + 4] = acc = (acc + md) | 0;
  O[o + 5] = acc = (acc + md) | 0;
  O[o + 6] = acc = (acc + md) | 0;
  O[o + 7] = acc = (acc + md) | 0;
  O[o + 8] = acc = (acc + md) | 0;
  O[o + 9] = acc = (acc + md) | 0;
  O[o + 10] = acc = (acc + md) | 0;
  O[o + 11] = acc = (acc + md) | 0;
  O[o + 12] = acc = (acc + md) | 0;
  O[o + 13] = acc = (acc + md) | 0;
  O[o + 14] = acc = (acc + md) | 0;
  O[o + 15] = acc = (acc + md) | 0;
  O[o + 16] = acc = (acc + md) | 0;
  O[o + 17] = acc = (acc + md) | 0;
  O[o + 18] = acc = (acc + md) | 0;
  O[o + 19] = acc = (acc + md) | 0;
  O[o + 20] = acc = (acc + md) | 0;
  O[o + 21] = acc = (acc + md) | 0;
  O[o + 22] = acc = (acc + md) | 0;
  O[o + 23] = acc = (acc + md) | 0;
  O[o + 24] = acc = (acc + md) | 0;
  O[o + 25] = acc = (acc + md) | 0;
  O[o + 26] = acc = (acc + md) | 0;
  O[o + 27] = acc = (acc + md) | 0;
  O[o + 28] = acc = (acc + md) | 0;
  O[o + 29] = acc = (acc + md) | 0;
  O[o + 30] = acc = (acc + md) | 0;
  O[o + 31] = acc = (acc + md) | 0;
  return acc;
},
function delta32_1(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  O[o + 0] = acc = (acc + md + (w0 & 1)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 1) & 1)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 2) & 1)) | 0;
  O[o + 3] = acc = (acc + md + ((w0 >>> 3) & 1)) | 0;
  O[o + 4] = acc = (acc + md + ((w0 >>> 4) & 1)) | 0;
  O[o + 5] = acc = (acc + md + ((w0 >>> 5) & 1)) | 0;
  O[o + 6] = acc = (acc + md + ((w0 >>> 6) & 1)) | 0;
  O[o + 7] = acc = (acc + md + ((w0 >>> 7) & 1)) | 0;
  O[o + 8] = acc = (acc + md + ((w0 >>> 8) & 1)) | 0;
  O[o + 9] = acc = (acc + md + ((w0 >>> 9) & 1)) | 0;
  O[o + 10] = acc = (acc + md + ((w0 >>> 10) & 1)) | 0;
  O[o + 11] = acc = (acc + md + ((w0 >>> 11) & 1)) | 0;
  O[o + 12] = acc = (acc + md + ((w0 >>> 12) & 1)) | 0;
  O[o + 13] = acc = (acc + md + ((w0 >>> 13) & 1)) | 0;
  O[o + 14] = acc = (acc + md + ((w0 >>> 14) & 1)) | 0;
  O[o + 15] = acc = (acc + md + ((w0 >>> 15) & 1)) | 0;
  O[o + 16] = acc = (acc + md + ((w0 >>> 16) & 1)) | 0;
  O[o + 17] = acc = (acc + md + ((w0 >>> 17) & 1)) | 0;
  O[o + 18] = acc = (acc + md + ((w0 >>> 18) & 1)) | 0;
  O[o + 19] = acc = (acc + md + ((w0 >>> 19) & 1)) | 0;
  O[o + 20] = acc = (acc + md + ((w0 >>> 20) & 1)) | 0;
  O[o + 21] = acc = (acc + md + ((w0 >>> 21) & 1)) | 0;
  O[o + 22] = acc = (acc + md + ((w0 >>> 22) & 1)) | 0;
  O[o + 23] = acc = (acc + md + ((w0 >>> 23) & 1)) | 0;
  O[o + 24] = acc = (acc + md + ((w0 >>> 24) & 1)) | 0;
  O[o + 25] = acc = (acc + md + ((w0 >>> 25) & 1)) | 0;
  O[o + 26] = acc = (acc + md + ((w0 >>> 26) & 1)) | 0;
  O[o + 27] = acc = (acc + md + ((w0 >>> 27) & 1)) | 0;
  O[o + 28] = acc = (acc + md + ((w0 >>> 28) & 1)) | 0;
  O[o + 29] = acc = (acc + md + ((w0 >>> 29) & 1)) | 0;
  O[o + 30] = acc = (acc + md + ((w0 >>> 30) & 1)) | 0;
  O[o + 31] = acc = (acc + md + (w0 >>> 31)) | 0;
  return acc;
},
function delta32_2(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  O[o + 0] = acc = (acc + md + (w0 & 3)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 2) & 3)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 4) & 3)) | 0;
  O[o + 3] = acc = (acc + md + ((w0 >>> 6) & 3)) | 0;
  O[o + 4] = acc = (acc + md + ((w0 >>> 8) & 3)) | 0;
  O[o + 5] = acc = (acc + md + ((w0 >>> 10) & 3)) | 0;
  O[o + 6] = acc = (acc + md + ((w0 >>> 12) & 3)) | 0;
  O[o + 7] = acc = (acc + md + ((w0 >>> 14) & 3)) | 0;
  O[o + 8] = acc = (acc + md + ((w0 >>> 16) & 3)) | 0;
  O[o + 9] = acc = (acc + md + ((w0 >>> 18) & 3)) | 0;
  O[o + 10] = acc = (acc + md + ((w0 >>> 20) & 3)) | 0;
  O[o + 11] = acc = (acc + md + ((w0 >>> 22) & 3)) | 0;
  O[o + 12] = acc = (acc + md + ((w0 >>> 24) & 3)) | 0;
  O[o + 13] = acc = (acc + md + ((w0 >>> 26) & 3)) | 0;
  O[o + 14] = acc = (acc + md + ((w0 >>> 28) & 3)) | 0;
  O[o + 15] = acc = (acc + md + (w0 >>> 30)) | 0;
  O[o + 16] = acc = (acc + md + (w1 & 3)) | 0;
  O[o + 17] = acc = (acc + md + ((w1 >>> 2) & 3)) | 0;
  O[o + 18] = acc = (acc + md + ((w1 >>> 4) & 3)) | 0;
  O[o + 19] = acc = (acc + md + ((w1 >>> 6) & 3)) | 0;
  O[o + 20] = acc = (acc + md + ((w1 >>> 8) & 3)) | 0;
  O[o + 21] = acc = (acc + md + ((w1 >>> 10) & 3)) | 0;
  O[o + 22] = acc = (acc + md + ((w1 >>> 12) & 3)) | 0;
  O[o + 23] = acc = (acc + md + ((w1 >>> 14) & 3)) | 0;
  O[o + 24] = acc = (acc + md + ((w1 >>> 16) & 3)) | 0;
  O[o + 25] = acc = (acc + md + ((w1 >>> 18) & 3)) | 0;
  O[o + 26] = acc = (acc + md + ((w1 >>> 20) & 3)) | 0;
  O[o + 27] = acc = (acc + md + ((w1 >>> 22) & 3)) | 0;
  O[o + 28] = acc = (acc + md + ((w1 >>> 24) & 3)) | 0;
  O[o + 29] = acc = (acc + md + ((w1 >>> 26) & 3)) | 0;
  O[o + 30] = acc = (acc + md + ((w1 >>> 28) & 3)) | 0;
  O[o + 31] = acc = (acc + md + (w1 >>> 30)) | 0;
  return acc;
},
function delta32_3(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  O[o + 0] = acc = (acc + md + (w0 & 7)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 3) & 7)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 6) & 7)) | 0;
  O[o + 3] = acc = (acc + md + ((w0 >>> 9) & 7)) | 0;
  O[o + 4] = acc = (acc + md + ((w0 >>> 12) & 7)) | 0;
  O[o + 5] = acc = (acc + md + ((w0 >>> 15) & 7)) | 0;
  O[o + 6] = acc = (acc + md + ((w0 >>> 18) & 7)) | 0;
  O[o + 7] = acc = (acc + md + ((w0 >>> 21) & 7)) | 0;
  O[o + 8] = acc = (acc + md + ((w0 >>> 24) & 7)) | 0;
  O[o + 9] = acc = (acc + md + ((w0 >>> 27) & 7)) | 0;
  O[o + 10] = acc = (acc + md + (((w0 >>> 30) | (w1 << 2)) & 7)) | 0;
  O[o + 11] = acc = (acc + md + ((w1 >>> 1) & 7)) | 0;
  O[o + 12] = acc = (acc + md + ((w1 >>> 4) & 7)) | 0;
  O[o + 13] = acc = (acc + md + ((w1 >>> 7) & 7)) | 0;
  O[o + 14] = acc = (acc + md + ((w1 >>> 10) & 7)) | 0;
  O[o + 15] = acc = (acc + md + ((w1 >>> 13) & 7)) | 0;
  O[o + 16] = acc = (acc + md + ((w1 >>> 16) & 7)) | 0;
  O[o + 17] = acc = (acc + md + ((w1 >>> 19) & 7)) | 0;
  O[o + 18] = acc = (acc + md + ((w1 >>> 22) & 7)) | 0;
  O[o + 19] = acc = (acc + md + ((w1 >>> 25) & 7)) | 0;
  O[o + 20] = acc = (acc + md + ((w1 >>> 28) & 7)) | 0;
  O[o + 21] = acc = (acc + md + (((w1 >>> 31) | (w2 << 1)) & 7)) | 0;
  O[o + 22] = acc = (acc + md + ((w2 >>> 2) & 7)) | 0;
  O[o + 23] = acc = (acc + md + ((w2 >>> 5) & 7)) | 0;
  O[o + 24] = acc = (acc + md + ((w2 >>> 8) & 7)) | 0;
  O[o + 25] = acc = (acc + md + ((w2 >>> 11) & 7)) | 0;
  O[o + 26] = acc = (acc + md + ((w2 >>> 14) & 7)) | 0;
  O[o + 27] = acc = (acc + md + ((w2 >>> 17) & 7)) | 0;
  O[o + 28] = acc = (acc + md + ((w2 >>> 20) & 7)) | 0;
  O[o + 29] = acc = (acc + md + ((w2 >>> 23) & 7)) | 0;
  O[o + 30] = acc = (acc + md + ((w2 >>> 26) & 7)) | 0;
  O[o + 31] = acc = (acc + md + (w2 >>> 29)) | 0;
  return acc;
},
function delta32_4(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  O[o + 0] = acc = (acc + md + (w0 & 15)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 4) & 15)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 8) & 15)) | 0;
  O[o + 3] = acc = (acc + md + ((w0 >>> 12) & 15)) | 0;
  O[o + 4] = acc = (acc + md + ((w0 >>> 16) & 15)) | 0;
  O[o + 5] = acc = (acc + md + ((w0 >>> 20) & 15)) | 0;
  O[o + 6] = acc = (acc + md + ((w0 >>> 24) & 15)) | 0;
  O[o + 7] = acc = (acc + md + (w0 >>> 28)) | 0;
  O[o + 8] = acc = (acc + md + (w1 & 15)) | 0;
  O[o + 9] = acc = (acc + md + ((w1 >>> 4) & 15)) | 0;
  O[o + 10] = acc = (acc + md + ((w1 >>> 8) & 15)) | 0;
  O[o + 11] = acc = (acc + md + ((w1 >>> 12) & 15)) | 0;
  O[o + 12] = acc = (acc + md + ((w1 >>> 16) & 15)) | 0;
  O[o + 13] = acc = (acc + md + ((w1 >>> 20) & 15)) | 0;
  O[o + 14] = acc = (acc + md + ((w1 >>> 24) & 15)) | 0;
  O[o + 15] = acc = (acc + md + (w1 >>> 28)) | 0;
  O[o + 16] = acc = (acc + md + (w2 & 15)) | 0;
  O[o + 17] = acc = (acc + md + ((w2 >>> 4) & 15)) | 0;
  O[o + 18] = acc = (acc + md + ((w2 >>> 8) & 15)) | 0;
  O[o + 19] = acc = (acc + md + ((w2 >>> 12) & 15)) | 0;
  O[o + 20] = acc = (acc + md + ((w2 >>> 16) & 15)) | 0;
  O[o + 21] = acc = (acc + md + ((w2 >>> 20) & 15)) | 0;
  O[o + 22] = acc = (acc + md + ((w2 >>> 24) & 15)) | 0;
  O[o + 23] = acc = (acc + md + (w2 >>> 28)) | 0;
  O[o + 24] = acc = (acc + md + (w3 & 15)) | 0;
  O[o + 25] = acc = (acc + md + ((w3 >>> 4) & 15)) | 0;
  O[o + 26] = acc = (acc + md + ((w3 >>> 8) & 15)) | 0;
  O[o + 27] = acc = (acc + md + ((w3 >>> 12) & 15)) | 0;
  O[o + 28] = acc = (acc + md + ((w3 >>> 16) & 15)) | 0;
  O[o + 29] = acc = (acc + md + ((w3 >>> 20) & 15)) | 0;
  O[o + 30] = acc = (acc + md + ((w3 >>> 24) & 15)) | 0;
  O[o + 31] = acc = (acc + md + (w3 >>> 28)) | 0;
  return acc;
},
function delta32_5(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  O[o + 0] = acc = (acc + md + (w0 & 31)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 5) & 31)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 10) & 31)) | 0;
  O[o + 3] = acc = (acc + md + ((w0 >>> 15) & 31)) | 0;
  O[o + 4] = acc = (acc + md + ((w0 >>> 20) & 31)) | 0;
  O[o + 5] = acc = (acc + md + ((w0 >>> 25) & 31)) | 0;
  O[o + 6] = acc = (acc + md + (((w0 >>> 30) | (w1 << 2)) & 31)) | 0;
  O[o + 7] = acc = (acc + md + ((w1 >>> 3) & 31)) | 0;
  O[o + 8] = acc = (acc + md + ((w1 >>> 8) & 31)) | 0;
  O[o + 9] = acc = (acc + md + ((w1 >>> 13) & 31)) | 0;
  O[o + 10] = acc = (acc + md + ((w1 >>> 18) & 31)) | 0;
  O[o + 11] = acc = (acc + md + ((w1 >>> 23) & 31)) | 0;
  O[o + 12] = acc = (acc + md + (((w1 >>> 28) | (w2 << 4)) & 31)) | 0;
  O[o + 13] = acc = (acc + md + ((w2 >>> 1) & 31)) | 0;
  O[o + 14] = acc = (acc + md + ((w2 >>> 6) & 31)) | 0;
  O[o + 15] = acc = (acc + md + ((w2 >>> 11) & 31)) | 0;
  O[o + 16] = acc = (acc + md + ((w2 >>> 16) & 31)) | 0;
  O[o + 17] = acc = (acc + md + ((w2 >>> 21) & 31)) | 0;
  O[o + 18] = acc = (acc + md + ((w2 >>> 26) & 31)) | 0;
  O[o + 19] = acc = (acc + md + (((w2 >>> 31) | (w3 << 1)) & 31)) | 0;
  O[o + 20] = acc = (acc + md + ((w3 >>> 4) & 31)) | 0;
  O[o + 21] = acc = (acc + md + ((w3 >>> 9) & 31)) | 0;
  O[o + 22] = acc = (acc + md + ((w3 >>> 14) & 31)) | 0;
  O[o + 23] = acc = (acc + md + ((w3 >>> 19) & 31)) | 0;
  O[o + 24] = acc = (acc + md + ((w3 >>> 24) & 31)) | 0;
  O[o + 25] = acc = (acc + md + (((w3 >>> 29) | (w4 << 3)) & 31)) | 0;
  O[o + 26] = acc = (acc + md + ((w4 >>> 2) & 31)) | 0;
  O[o + 27] = acc = (acc + md + ((w4 >>> 7) & 31)) | 0;
  O[o + 28] = acc = (acc + md + ((w4 >>> 12) & 31)) | 0;
  O[o + 29] = acc = (acc + md + ((w4 >>> 17) & 31)) | 0;
  O[o + 30] = acc = (acc + md + ((w4 >>> 22) & 31)) | 0;
  O[o + 31] = acc = (acc + md + (w4 >>> 27)) | 0;
  return acc;
},
function delta32_6(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  O[o + 0] = acc = (acc + md + (w0 & 63)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 6) & 63)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 12) & 63)) | 0;
  O[o + 3] = acc = (acc + md + ((w0 >>> 18) & 63)) | 0;
  O[o + 4] = acc = (acc + md + ((w0 >>> 24) & 63)) | 0;
  O[o + 5] = acc = (acc + md + (((w0 >>> 30) | (w1 << 2)) & 63)) | 0;
  O[o + 6] = acc = (acc + md + ((w1 >>> 4) & 63)) | 0;
  O[o + 7] = acc = (acc + md + ((w1 >>> 10) & 63)) | 0;
  O[o + 8] = acc = (acc + md + ((w1 >>> 16) & 63)) | 0;
  O[o + 9] = acc = (acc + md + ((w1 >>> 22) & 63)) | 0;
  O[o + 10] = acc = (acc + md + (((w1 >>> 28) | (w2 << 4)) & 63)) | 0;
  O[o + 11] = acc = (acc + md + ((w2 >>> 2) & 63)) | 0;
  O[o + 12] = acc = (acc + md + ((w2 >>> 8) & 63)) | 0;
  O[o + 13] = acc = (acc + md + ((w2 >>> 14) & 63)) | 0;
  O[o + 14] = acc = (acc + md + ((w2 >>> 20) & 63)) | 0;
  O[o + 15] = acc = (acc + md + (w2 >>> 26)) | 0;
  O[o + 16] = acc = (acc + md + (w3 & 63)) | 0;
  O[o + 17] = acc = (acc + md + ((w3 >>> 6) & 63)) | 0;
  O[o + 18] = acc = (acc + md + ((w3 >>> 12) & 63)) | 0;
  O[o + 19] = acc = (acc + md + ((w3 >>> 18) & 63)) | 0;
  O[o + 20] = acc = (acc + md + ((w3 >>> 24) & 63)) | 0;
  O[o + 21] = acc = (acc + md + (((w3 >>> 30) | (w4 << 2)) & 63)) | 0;
  O[o + 22] = acc = (acc + md + ((w4 >>> 4) & 63)) | 0;
  O[o + 23] = acc = (acc + md + ((w4 >>> 10) & 63)) | 0;
  O[o + 24] = acc = (acc + md + ((w4 >>> 16) & 63)) | 0;
  O[o + 25] = acc = (acc + md + ((w4 >>> 22) & 63)) | 0;
  O[o + 26] = acc = (acc + md + (((w4 >>> 28) | (w5 << 4)) & 63)) | 0;
  O[o + 27] = acc = (acc + md + ((w5 >>> 2) & 63)) | 0;
  O[o + 28] = acc = (acc + md + ((w5 >>> 8) & 63)) | 0;
  O[o + 29] = acc = (acc + md + ((w5 >>> 14) & 63)) | 0;
  O[o + 30] = acc = (acc + md + ((w5 >>> 20) & 63)) | 0;
  O[o + 31] = acc = (acc + md + (w5 >>> 26)) | 0;
  return acc;
},
function delta32_7(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  O[o + 0] = acc = (acc + md + (w0 & 127)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 7) & 127)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 14) & 127)) | 0;
  O[o + 3] = acc = (acc + md + ((w0 >>> 21) & 127)) | 0;
  O[o + 4] = acc = (acc + md + (((w0 >>> 28) | (w1 << 4)) & 127)) | 0;
  O[o + 5] = acc = (acc + md + ((w1 >>> 3) & 127)) | 0;
  O[o + 6] = acc = (acc + md + ((w1 >>> 10) & 127)) | 0;
  O[o + 7] = acc = (acc + md + ((w1 >>> 17) & 127)) | 0;
  O[o + 8] = acc = (acc + md + ((w1 >>> 24) & 127)) | 0;
  O[o + 9] = acc = (acc + md + (((w1 >>> 31) | (w2 << 1)) & 127)) | 0;
  O[o + 10] = acc = (acc + md + ((w2 >>> 6) & 127)) | 0;
  O[o + 11] = acc = (acc + md + ((w2 >>> 13) & 127)) | 0;
  O[o + 12] = acc = (acc + md + ((w2 >>> 20) & 127)) | 0;
  O[o + 13] = acc = (acc + md + (((w2 >>> 27) | (w3 << 5)) & 127)) | 0;
  O[o + 14] = acc = (acc + md + ((w3 >>> 2) & 127)) | 0;
  O[o + 15] = acc = (acc + md + ((w3 >>> 9) & 127)) | 0;
  O[o + 16] = acc = (acc + md + ((w3 >>> 16) & 127)) | 0;
  O[o + 17] = acc = (acc + md + ((w3 >>> 23) & 127)) | 0;
  O[o + 18] = acc = (acc + md + (((w3 >>> 30) | (w4 << 2)) & 127)) | 0;
  O[o + 19] = acc = (acc + md + ((w4 >>> 5) & 127)) | 0;
  O[o + 20] = acc = (acc + md + ((w4 >>> 12) & 127)) | 0;
  O[o + 21] = acc = (acc + md + ((w4 >>> 19) & 127)) | 0;
  O[o + 22] = acc = (acc + md + (((w4 >>> 26) | (w5 << 6)) & 127)) | 0;
  O[o + 23] = acc = (acc + md + ((w5 >>> 1) & 127)) | 0;
  O[o + 24] = acc = (acc + md + ((w5 >>> 8) & 127)) | 0;
  O[o + 25] = acc = (acc + md + ((w5 >>> 15) & 127)) | 0;
  O[o + 26] = acc = (acc + md + ((w5 >>> 22) & 127)) | 0;
  O[o + 27] = acc = (acc + md + (((w5 >>> 29) | (w6 << 3)) & 127)) | 0;
  O[o + 28] = acc = (acc + md + ((w6 >>> 4) & 127)) | 0;
  O[o + 29] = acc = (acc + md + ((w6 >>> 11) & 127)) | 0;
  O[o + 30] = acc = (acc + md + ((w6 >>> 18) & 127)) | 0;
  O[o + 31] = acc = (acc + md + (w6 >>> 25)) | 0;
  return acc;
},
function delta32_8(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  O[o + 0] = acc = (acc + md + (w0 & 255)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 8) & 255)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 16) & 255)) | 0;
  O[o + 3] = acc = (acc + md + (w0 >>> 24)) | 0;
  O[o + 4] = acc = (acc + md + (w1 & 255)) | 0;
  O[o + 5] = acc = (acc + md + ((w1 >>> 8) & 255)) | 0;
  O[o + 6] = acc = (acc + md + ((w1 >>> 16) & 255)) | 0;
  O[o + 7] = acc = (acc + md + (w1 >>> 24)) | 0;
  O[o + 8] = acc = (acc + md + (w2 & 255)) | 0;
  O[o + 9] = acc = (acc + md + ((w2 >>> 8) & 255)) | 0;
  O[o + 10] = acc = (acc + md + ((w2 >>> 16) & 255)) | 0;
  O[o + 11] = acc = (acc + md + (w2 >>> 24)) | 0;
  O[o + 12] = acc = (acc + md + (w3 & 255)) | 0;
  O[o + 13] = acc = (acc + md + ((w3 >>> 8) & 255)) | 0;
  O[o + 14] = acc = (acc + md + ((w3 >>> 16) & 255)) | 0;
  O[o + 15] = acc = (acc + md + (w3 >>> 24)) | 0;
  O[o + 16] = acc = (acc + md + (w4 & 255)) | 0;
  O[o + 17] = acc = (acc + md + ((w4 >>> 8) & 255)) | 0;
  O[o + 18] = acc = (acc + md + ((w4 >>> 16) & 255)) | 0;
  O[o + 19] = acc = (acc + md + (w4 >>> 24)) | 0;
  O[o + 20] = acc = (acc + md + (w5 & 255)) | 0;
  O[o + 21] = acc = (acc + md + ((w5 >>> 8) & 255)) | 0;
  O[o + 22] = acc = (acc + md + ((w5 >>> 16) & 255)) | 0;
  O[o + 23] = acc = (acc + md + (w5 >>> 24)) | 0;
  O[o + 24] = acc = (acc + md + (w6 & 255)) | 0;
  O[o + 25] = acc = (acc + md + ((w6 >>> 8) & 255)) | 0;
  O[o + 26] = acc = (acc + md + ((w6 >>> 16) & 255)) | 0;
  O[o + 27] = acc = (acc + md + (w6 >>> 24)) | 0;
  O[o + 28] = acc = (acc + md + (w7 & 255)) | 0;
  O[o + 29] = acc = (acc + md + ((w7 >>> 8) & 255)) | 0;
  O[o + 30] = acc = (acc + md + ((w7 >>> 16) & 255)) | 0;
  O[o + 31] = acc = (acc + md + (w7 >>> 24)) | 0;
  return acc;
},
function delta32_9(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  O[o + 0] = acc = (acc + md + (w0 & 511)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 9) & 511)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 18) & 511)) | 0;
  O[o + 3] = acc = (acc + md + (((w0 >>> 27) | (w1 << 5)) & 511)) | 0;
  O[o + 4] = acc = (acc + md + ((w1 >>> 4) & 511)) | 0;
  O[o + 5] = acc = (acc + md + ((w1 >>> 13) & 511)) | 0;
  O[o + 6] = acc = (acc + md + ((w1 >>> 22) & 511)) | 0;
  O[o + 7] = acc = (acc + md + (((w1 >>> 31) | (w2 << 1)) & 511)) | 0;
  O[o + 8] = acc = (acc + md + ((w2 >>> 8) & 511)) | 0;
  O[o + 9] = acc = (acc + md + ((w2 >>> 17) & 511)) | 0;
  O[o + 10] = acc = (acc + md + (((w2 >>> 26) | (w3 << 6)) & 511)) | 0;
  O[o + 11] = acc = (acc + md + ((w3 >>> 3) & 511)) | 0;
  O[o + 12] = acc = (acc + md + ((w3 >>> 12) & 511)) | 0;
  O[o + 13] = acc = (acc + md + ((w3 >>> 21) & 511)) | 0;
  O[o + 14] = acc = (acc + md + (((w3 >>> 30) | (w4 << 2)) & 511)) | 0;
  O[o + 15] = acc = (acc + md + ((w4 >>> 7) & 511)) | 0;
  O[o + 16] = acc = (acc + md + ((w4 >>> 16) & 511)) | 0;
  O[o + 17] = acc = (acc + md + (((w4 >>> 25) | (w5 << 7)) & 511)) | 0;
  O[o + 18] = acc = (acc + md + ((w5 >>> 2) & 511)) | 0;
  O[o + 19] = acc = (acc + md + ((w5 >>> 11) & 511)) | 0;
  O[o + 20] = acc = (acc + md + ((w5 >>> 20) & 511)) | 0;
  O[o + 21] = acc = (acc + md + (((w5 >>> 29) | (w6 << 3)) & 511)) | 0;
  O[o + 22] = acc = (acc + md + ((w6 >>> 6) & 511)) | 0;
  O[o + 23] = acc = (acc + md + ((w6 >>> 15) & 511)) | 0;
  O[o + 24] = acc = (acc + md + (((w6 >>> 24) | (w7 << 8)) & 511)) | 0;
  O[o + 25] = acc = (acc + md + ((w7 >>> 1) & 511)) | 0;
  O[o + 26] = acc = (acc + md + ((w7 >>> 10) & 511)) | 0;
  O[o + 27] = acc = (acc + md + ((w7 >>> 19) & 511)) | 0;
  O[o + 28] = acc = (acc + md + (((w7 >>> 28) | (w8 << 4)) & 511)) | 0;
  O[o + 29] = acc = (acc + md + ((w8 >>> 5) & 511)) | 0;
  O[o + 30] = acc = (acc + md + ((w8 >>> 14) & 511)) | 0;
  O[o + 31] = acc = (acc + md + (w8 >>> 23)) | 0;
  return acc;
},
function delta32_10(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  O[o + 0] = acc = (acc + md + (w0 & 1023)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 10) & 1023)) | 0;
  O[o + 2] = acc = (acc + md + ((w0 >>> 20) & 1023)) | 0;
  O[o + 3] = acc = (acc + md + (((w0 >>> 30) | (w1 << 2)) & 1023)) | 0;
  O[o + 4] = acc = (acc + md + ((w1 >>> 8) & 1023)) | 0;
  O[o + 5] = acc = (acc + md + ((w1 >>> 18) & 1023)) | 0;
  O[o + 6] = acc = (acc + md + (((w1 >>> 28) | (w2 << 4)) & 1023)) | 0;
  O[o + 7] = acc = (acc + md + ((w2 >>> 6) & 1023)) | 0;
  O[o + 8] = acc = (acc + md + ((w2 >>> 16) & 1023)) | 0;
  O[o + 9] = acc = (acc + md + (((w2 >>> 26) | (w3 << 6)) & 1023)) | 0;
  O[o + 10] = acc = (acc + md + ((w3 >>> 4) & 1023)) | 0;
  O[o + 11] = acc = (acc + md + ((w3 >>> 14) & 1023)) | 0;
  O[o + 12] = acc = (acc + md + (((w3 >>> 24) | (w4 << 8)) & 1023)) | 0;
  O[o + 13] = acc = (acc + md + ((w4 >>> 2) & 1023)) | 0;
  O[o + 14] = acc = (acc + md + ((w4 >>> 12) & 1023)) | 0;
  O[o + 15] = acc = (acc + md + (w4 >>> 22)) | 0;
  O[o + 16] = acc = (acc + md + (w5 & 1023)) | 0;
  O[o + 17] = acc = (acc + md + ((w5 >>> 10) & 1023)) | 0;
  O[o + 18] = acc = (acc + md + ((w5 >>> 20) & 1023)) | 0;
  O[o + 19] = acc = (acc + md + (((w5 >>> 30) | (w6 << 2)) & 1023)) | 0;
  O[o + 20] = acc = (acc + md + ((w6 >>> 8) & 1023)) | 0;
  O[o + 21] = acc = (acc + md + ((w6 >>> 18) & 1023)) | 0;
  O[o + 22] = acc = (acc + md + (((w6 >>> 28) | (w7 << 4)) & 1023)) | 0;
  O[o + 23] = acc = (acc + md + ((w7 >>> 6) & 1023)) | 0;
  O[o + 24] = acc = (acc + md + ((w7 >>> 16) & 1023)) | 0;
  O[o + 25] = acc = (acc + md + (((w7 >>> 26) | (w8 << 6)) & 1023)) | 0;
  O[o + 26] = acc = (acc + md + ((w8 >>> 4) & 1023)) | 0;
  O[o + 27] = acc = (acc + md + ((w8 >>> 14) & 1023)) | 0;
  O[o + 28] = acc = (acc + md + (((w8 >>> 24) | (w9 << 8)) & 1023)) | 0;
  O[o + 29] = acc = (acc + md + ((w9 >>> 2) & 1023)) | 0;
  O[o + 30] = acc = (acc + md + ((w9 >>> 12) & 1023)) | 0;
  O[o + 31] = acc = (acc + md + (w9 >>> 22)) | 0;
  return acc;
},
function delta32_11(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  O[o + 0] = acc = (acc + md + (w0 & 2047)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 11) & 2047)) | 0;
  O[o + 2] = acc = (acc + md + (((w0 >>> 22) | (w1 << 10)) & 2047)) | 0;
  O[o + 3] = acc = (acc + md + ((w1 >>> 1) & 2047)) | 0;
  O[o + 4] = acc = (acc + md + ((w1 >>> 12) & 2047)) | 0;
  O[o + 5] = acc = (acc + md + (((w1 >>> 23) | (w2 << 9)) & 2047)) | 0;
  O[o + 6] = acc = (acc + md + ((w2 >>> 2) & 2047)) | 0;
  O[o + 7] = acc = (acc + md + ((w2 >>> 13) & 2047)) | 0;
  O[o + 8] = acc = (acc + md + (((w2 >>> 24) | (w3 << 8)) & 2047)) | 0;
  O[o + 9] = acc = (acc + md + ((w3 >>> 3) & 2047)) | 0;
  O[o + 10] = acc = (acc + md + ((w3 >>> 14) & 2047)) | 0;
  O[o + 11] = acc = (acc + md + (((w3 >>> 25) | (w4 << 7)) & 2047)) | 0;
  O[o + 12] = acc = (acc + md + ((w4 >>> 4) & 2047)) | 0;
  O[o + 13] = acc = (acc + md + ((w4 >>> 15) & 2047)) | 0;
  O[o + 14] = acc = (acc + md + (((w4 >>> 26) | (w5 << 6)) & 2047)) | 0;
  O[o + 15] = acc = (acc + md + ((w5 >>> 5) & 2047)) | 0;
  O[o + 16] = acc = (acc + md + ((w5 >>> 16) & 2047)) | 0;
  O[o + 17] = acc = (acc + md + (((w5 >>> 27) | (w6 << 5)) & 2047)) | 0;
  O[o + 18] = acc = (acc + md + ((w6 >>> 6) & 2047)) | 0;
  O[o + 19] = acc = (acc + md + ((w6 >>> 17) & 2047)) | 0;
  O[o + 20] = acc = (acc + md + (((w6 >>> 28) | (w7 << 4)) & 2047)) | 0;
  O[o + 21] = acc = (acc + md + ((w7 >>> 7) & 2047)) | 0;
  O[o + 22] = acc = (acc + md + ((w7 >>> 18) & 2047)) | 0;
  O[o + 23] = acc = (acc + md + (((w7 >>> 29) | (w8 << 3)) & 2047)) | 0;
  O[o + 24] = acc = (acc + md + ((w8 >>> 8) & 2047)) | 0;
  O[o + 25] = acc = (acc + md + ((w8 >>> 19) & 2047)) | 0;
  O[o + 26] = acc = (acc + md + (((w8 >>> 30) | (w9 << 2)) & 2047)) | 0;
  O[o + 27] = acc = (acc + md + ((w9 >>> 9) & 2047)) | 0;
  O[o + 28] = acc = (acc + md + ((w9 >>> 20) & 2047)) | 0;
  O[o + 29] = acc = (acc + md + (((w9 >>> 31) | (w10 << 1)) & 2047)) | 0;
  O[o + 30] = acc = (acc + md + ((w10 >>> 10) & 2047)) | 0;
  O[o + 31] = acc = (acc + md + (w10 >>> 21)) | 0;
  return acc;
},
function delta32_12(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  O[o + 0] = acc = (acc + md + (w0 & 4095)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 12) & 4095)) | 0;
  O[o + 2] = acc = (acc + md + (((w0 >>> 24) | (w1 << 8)) & 4095)) | 0;
  O[o + 3] = acc = (acc + md + ((w1 >>> 4) & 4095)) | 0;
  O[o + 4] = acc = (acc + md + ((w1 >>> 16) & 4095)) | 0;
  O[o + 5] = acc = (acc + md + (((w1 >>> 28) | (w2 << 4)) & 4095)) | 0;
  O[o + 6] = acc = (acc + md + ((w2 >>> 8) & 4095)) | 0;
  O[o + 7] = acc = (acc + md + (w2 >>> 20)) | 0;
  O[o + 8] = acc = (acc + md + (w3 & 4095)) | 0;
  O[o + 9] = acc = (acc + md + ((w3 >>> 12) & 4095)) | 0;
  O[o + 10] = acc = (acc + md + (((w3 >>> 24) | (w4 << 8)) & 4095)) | 0;
  O[o + 11] = acc = (acc + md + ((w4 >>> 4) & 4095)) | 0;
  O[o + 12] = acc = (acc + md + ((w4 >>> 16) & 4095)) | 0;
  O[o + 13] = acc = (acc + md + (((w4 >>> 28) | (w5 << 4)) & 4095)) | 0;
  O[o + 14] = acc = (acc + md + ((w5 >>> 8) & 4095)) | 0;
  O[o + 15] = acc = (acc + md + (w5 >>> 20)) | 0;
  O[o + 16] = acc = (acc + md + (w6 & 4095)) | 0;
  O[o + 17] = acc = (acc + md + ((w6 >>> 12) & 4095)) | 0;
  O[o + 18] = acc = (acc + md + (((w6 >>> 24) | (w7 << 8)) & 4095)) | 0;
  O[o + 19] = acc = (acc + md + ((w7 >>> 4) & 4095)) | 0;
  O[o + 20] = acc = (acc + md + ((w7 >>> 16) & 4095)) | 0;
  O[o + 21] = acc = (acc + md + (((w7 >>> 28) | (w8 << 4)) & 4095)) | 0;
  O[o + 22] = acc = (acc + md + ((w8 >>> 8) & 4095)) | 0;
  O[o + 23] = acc = (acc + md + (w8 >>> 20)) | 0;
  O[o + 24] = acc = (acc + md + (w9 & 4095)) | 0;
  O[o + 25] = acc = (acc + md + ((w9 >>> 12) & 4095)) | 0;
  O[o + 26] = acc = (acc + md + (((w9 >>> 24) | (w10 << 8)) & 4095)) | 0;
  O[o + 27] = acc = (acc + md + ((w10 >>> 4) & 4095)) | 0;
  O[o + 28] = acc = (acc + md + ((w10 >>> 16) & 4095)) | 0;
  O[o + 29] = acc = (acc + md + (((w10 >>> 28) | (w11 << 4)) & 4095)) | 0;
  O[o + 30] = acc = (acc + md + ((w11 >>> 8) & 4095)) | 0;
  O[o + 31] = acc = (acc + md + (w11 >>> 20)) | 0;
  return acc;
},
function delta32_13(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  O[o + 0] = acc = (acc + md + (w0 & 8191)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 13) & 8191)) | 0;
  O[o + 2] = acc = (acc + md + (((w0 >>> 26) | (w1 << 6)) & 8191)) | 0;
  O[o + 3] = acc = (acc + md + ((w1 >>> 7) & 8191)) | 0;
  O[o + 4] = acc = (acc + md + (((w1 >>> 20) | (w2 << 12)) & 8191)) | 0;
  O[o + 5] = acc = (acc + md + ((w2 >>> 1) & 8191)) | 0;
  O[o + 6] = acc = (acc + md + ((w2 >>> 14) & 8191)) | 0;
  O[o + 7] = acc = (acc + md + (((w2 >>> 27) | (w3 << 5)) & 8191)) | 0;
  O[o + 8] = acc = (acc + md + ((w3 >>> 8) & 8191)) | 0;
  O[o + 9] = acc = (acc + md + (((w3 >>> 21) | (w4 << 11)) & 8191)) | 0;
  O[o + 10] = acc = (acc + md + ((w4 >>> 2) & 8191)) | 0;
  O[o + 11] = acc = (acc + md + ((w4 >>> 15) & 8191)) | 0;
  O[o + 12] = acc = (acc + md + (((w4 >>> 28) | (w5 << 4)) & 8191)) | 0;
  O[o + 13] = acc = (acc + md + ((w5 >>> 9) & 8191)) | 0;
  O[o + 14] = acc = (acc + md + (((w5 >>> 22) | (w6 << 10)) & 8191)) | 0;
  O[o + 15] = acc = (acc + md + ((w6 >>> 3) & 8191)) | 0;
  O[o + 16] = acc = (acc + md + ((w6 >>> 16) & 8191)) | 0;
  O[o + 17] = acc = (acc + md + (((w6 >>> 29) | (w7 << 3)) & 8191)) | 0;
  O[o + 18] = acc = (acc + md + ((w7 >>> 10) & 8191)) | 0;
  O[o + 19] = acc = (acc + md + (((w7 >>> 23) | (w8 << 9)) & 8191)) | 0;
  O[o + 20] = acc = (acc + md + ((w8 >>> 4) & 8191)) | 0;
  O[o + 21] = acc = (acc + md + ((w8 >>> 17) & 8191)) | 0;
  O[o + 22] = acc = (acc + md + (((w8 >>> 30) | (w9 << 2)) & 8191)) | 0;
  O[o + 23] = acc = (acc + md + ((w9 >>> 11) & 8191)) | 0;
  O[o + 24] = acc = (acc + md + (((w9 >>> 24) | (w10 << 8)) & 8191)) | 0;
  O[o + 25] = acc = (acc + md + ((w10 >>> 5) & 8191)) | 0;
  O[o + 26] = acc = (acc + md + ((w10 >>> 18) & 8191)) | 0;
  O[o + 27] = acc = (acc + md + (((w10 >>> 31) | (w11 << 1)) & 8191)) | 0;
  O[o + 28] = acc = (acc + md + ((w11 >>> 12) & 8191)) | 0;
  O[o + 29] = acc = (acc + md + (((w11 >>> 25) | (w12 << 7)) & 8191)) | 0;
  O[o + 30] = acc = (acc + md + ((w12 >>> 6) & 8191)) | 0;
  O[o + 31] = acc = (acc + md + (w12 >>> 19)) | 0;
  return acc;
},
function delta32_14(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  O[o + 0] = acc = (acc + md + (w0 & 16383)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 14) & 16383)) | 0;
  O[o + 2] = acc = (acc + md + (((w0 >>> 28) | (w1 << 4)) & 16383)) | 0;
  O[o + 3] = acc = (acc + md + ((w1 >>> 10) & 16383)) | 0;
  O[o + 4] = acc = (acc + md + (((w1 >>> 24) | (w2 << 8)) & 16383)) | 0;
  O[o + 5] = acc = (acc + md + ((w2 >>> 6) & 16383)) | 0;
  O[o + 6] = acc = (acc + md + (((w2 >>> 20) | (w3 << 12)) & 16383)) | 0;
  O[o + 7] = acc = (acc + md + ((w3 >>> 2) & 16383)) | 0;
  O[o + 8] = acc = (acc + md + ((w3 >>> 16) & 16383)) | 0;
  O[o + 9] = acc = (acc + md + (((w3 >>> 30) | (w4 << 2)) & 16383)) | 0;
  O[o + 10] = acc = (acc + md + ((w4 >>> 12) & 16383)) | 0;
  O[o + 11] = acc = (acc + md + (((w4 >>> 26) | (w5 << 6)) & 16383)) | 0;
  O[o + 12] = acc = (acc + md + ((w5 >>> 8) & 16383)) | 0;
  O[o + 13] = acc = (acc + md + (((w5 >>> 22) | (w6 << 10)) & 16383)) | 0;
  O[o + 14] = acc = (acc + md + ((w6 >>> 4) & 16383)) | 0;
  O[o + 15] = acc = (acc + md + (w6 >>> 18)) | 0;
  O[o + 16] = acc = (acc + md + (w7 & 16383)) | 0;
  O[o + 17] = acc = (acc + md + ((w7 >>> 14) & 16383)) | 0;
  O[o + 18] = acc = (acc + md + (((w7 >>> 28) | (w8 << 4)) & 16383)) | 0;
  O[o + 19] = acc = (acc + md + ((w8 >>> 10) & 16383)) | 0;
  O[o + 20] = acc = (acc + md + (((w8 >>> 24) | (w9 << 8)) & 16383)) | 0;
  O[o + 21] = acc = (acc + md + ((w9 >>> 6) & 16383)) | 0;
  O[o + 22] = acc = (acc + md + (((w9 >>> 20) | (w10 << 12)) & 16383)) | 0;
  O[o + 23] = acc = (acc + md + ((w10 >>> 2) & 16383)) | 0;
  O[o + 24] = acc = (acc + md + ((w10 >>> 16) & 16383)) | 0;
  O[o + 25] = acc = (acc + md + (((w10 >>> 30) | (w11 << 2)) & 16383)) | 0;
  O[o + 26] = acc = (acc + md + ((w11 >>> 12) & 16383)) | 0;
  O[o + 27] = acc = (acc + md + (((w11 >>> 26) | (w12 << 6)) & 16383)) | 0;
  O[o + 28] = acc = (acc + md + ((w12 >>> 8) & 16383)) | 0;
  O[o + 29] = acc = (acc + md + (((w12 >>> 22) | (w13 << 10)) & 16383)) | 0;
  O[o + 30] = acc = (acc + md + ((w13 >>> 4) & 16383)) | 0;
  O[o + 31] = acc = (acc + md + (w13 >>> 18)) | 0;
  return acc;
},
function delta32_15(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  O[o + 0] = acc = (acc + md + (w0 & 32767)) | 0;
  O[o + 1] = acc = (acc + md + ((w0 >>> 15) & 32767)) | 0;
  O[o + 2] = acc = (acc + md + (((w0 >>> 30) | (w1 << 2)) & 32767)) | 0;
  O[o + 3] = acc = (acc + md + ((w1 >>> 13) & 32767)) | 0;
  O[o + 4] = acc = (acc + md + (((w1 >>> 28) | (w2 << 4)) & 32767)) | 0;
  O[o + 5] = acc = (acc + md + ((w2 >>> 11) & 32767)) | 0;
  O[o + 6] = acc = (acc + md + (((w2 >>> 26) | (w3 << 6)) & 32767)) | 0;
  O[o + 7] = acc = (acc + md + ((w3 >>> 9) & 32767)) | 0;
  O[o + 8] = acc = (acc + md + (((w3 >>> 24) | (w4 << 8)) & 32767)) | 0;
  O[o + 9] = acc = (acc + md + ((w4 >>> 7) & 32767)) | 0;
  O[o + 10] = acc = (acc + md + (((w4 >>> 22) | (w5 << 10)) & 32767)) | 0;
  O[o + 11] = acc = (acc + md + ((w5 >>> 5) & 32767)) | 0;
  O[o + 12] = acc = (acc + md + (((w5 >>> 20) | (w6 << 12)) & 32767)) | 0;
  O[o + 13] = acc = (acc + md + ((w6 >>> 3) & 32767)) | 0;
  O[o + 14] = acc = (acc + md + (((w6 >>> 18) | (w7 << 14)) & 32767)) | 0;
  O[o + 15] = acc = (acc + md + ((w7 >>> 1) & 32767)) | 0;
  O[o + 16] = acc = (acc + md + ((w7 >>> 16) & 32767)) | 0;
  O[o + 17] = acc = (acc + md + (((w7 >>> 31) | (w8 << 1)) & 32767)) | 0;
  O[o + 18] = acc = (acc + md + ((w8 >>> 14) & 32767)) | 0;
  O[o + 19] = acc = (acc + md + (((w8 >>> 29) | (w9 << 3)) & 32767)) | 0;
  O[o + 20] = acc = (acc + md + ((w9 >>> 12) & 32767)) | 0;
  O[o + 21] = acc = (acc + md + (((w9 >>> 27) | (w10 << 5)) & 32767)) | 0;
  O[o + 22] = acc = (acc + md + ((w10 >>> 10) & 32767)) | 0;
  O[o + 23] = acc = (acc + md + (((w10 >>> 25) | (w11 << 7)) & 32767)) | 0;
  O[o + 24] = acc = (acc + md + ((w11 >>> 8) & 32767)) | 0;
  O[o + 25] = acc = (acc + md + (((w11 >>> 23) | (w12 << 9)) & 32767)) | 0;
  O[o + 26] = acc = (acc + md + ((w12 >>> 6) & 32767)) | 0;
  O[o + 27] = acc = (acc + md + (((w12 >>> 21) | (w13 << 11)) & 32767)) | 0;
  O[o + 28] = acc = (acc + md + ((w13 >>> 4) & 32767)) | 0;
  O[o + 29] = acc = (acc + md + (((w13 >>> 19) | (w14 << 13)) & 32767)) | 0;
  O[o + 30] = acc = (acc + md + ((w14 >>> 2) & 32767)) | 0;
  O[o + 31] = acc = (acc + md + (w14 >>> 17)) | 0;
  return acc;
},
function delta32_16(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  O[o + 0] = acc = (acc + md + (w0 & 65535)) | 0;
  O[o + 1] = acc = (acc + md + (w0 >>> 16)) | 0;
  O[o + 2] = acc = (acc + md + (w1 & 65535)) | 0;
  O[o + 3] = acc = (acc + md + (w1 >>> 16)) | 0;
  O[o + 4] = acc = (acc + md + (w2 & 65535)) | 0;
  O[o + 5] = acc = (acc + md + (w2 >>> 16)) | 0;
  O[o + 6] = acc = (acc + md + (w3 & 65535)) | 0;
  O[o + 7] = acc = (acc + md + (w3 >>> 16)) | 0;
  O[o + 8] = acc = (acc + md + (w4 & 65535)) | 0;
  O[o + 9] = acc = (acc + md + (w4 >>> 16)) | 0;
  O[o + 10] = acc = (acc + md + (w5 & 65535)) | 0;
  O[o + 11] = acc = (acc + md + (w5 >>> 16)) | 0;
  O[o + 12] = acc = (acc + md + (w6 & 65535)) | 0;
  O[o + 13] = acc = (acc + md + (w6 >>> 16)) | 0;
  O[o + 14] = acc = (acc + md + (w7 & 65535)) | 0;
  O[o + 15] = acc = (acc + md + (w7 >>> 16)) | 0;
  O[o + 16] = acc = (acc + md + (w8 & 65535)) | 0;
  O[o + 17] = acc = (acc + md + (w8 >>> 16)) | 0;
  O[o + 18] = acc = (acc + md + (w9 & 65535)) | 0;
  O[o + 19] = acc = (acc + md + (w9 >>> 16)) | 0;
  O[o + 20] = acc = (acc + md + (w10 & 65535)) | 0;
  O[o + 21] = acc = (acc + md + (w10 >>> 16)) | 0;
  O[o + 22] = acc = (acc + md + (w11 & 65535)) | 0;
  O[o + 23] = acc = (acc + md + (w11 >>> 16)) | 0;
  O[o + 24] = acc = (acc + md + (w12 & 65535)) | 0;
  O[o + 25] = acc = (acc + md + (w12 >>> 16)) | 0;
  O[o + 26] = acc = (acc + md + (w13 & 65535)) | 0;
  O[o + 27] = acc = (acc + md + (w13 >>> 16)) | 0;
  O[o + 28] = acc = (acc + md + (w14 & 65535)) | 0;
  O[o + 29] = acc = (acc + md + (w14 >>> 16)) | 0;
  O[o + 30] = acc = (acc + md + (w15 & 65535)) | 0;
  O[o + 31] = acc = (acc + md + (w15 >>> 16)) | 0;
  return acc;
},
function delta32_17(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  O[o + 0] = acc = (acc + md + (w0 & 131071)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 17) | (w1 << 15)) & 131071)) | 0;
  O[o + 2] = acc = (acc + md + ((w1 >>> 2) & 131071)) | 0;
  O[o + 3] = acc = (acc + md + (((w1 >>> 19) | (w2 << 13)) & 131071)) | 0;
  O[o + 4] = acc = (acc + md + ((w2 >>> 4) & 131071)) | 0;
  O[o + 5] = acc = (acc + md + (((w2 >>> 21) | (w3 << 11)) & 131071)) | 0;
  O[o + 6] = acc = (acc + md + ((w3 >>> 6) & 131071)) | 0;
  O[o + 7] = acc = (acc + md + (((w3 >>> 23) | (w4 << 9)) & 131071)) | 0;
  O[o + 8] = acc = (acc + md + ((w4 >>> 8) & 131071)) | 0;
  O[o + 9] = acc = (acc + md + (((w4 >>> 25) | (w5 << 7)) & 131071)) | 0;
  O[o + 10] = acc = (acc + md + ((w5 >>> 10) & 131071)) | 0;
  O[o + 11] = acc = (acc + md + (((w5 >>> 27) | (w6 << 5)) & 131071)) | 0;
  O[o + 12] = acc = (acc + md + ((w6 >>> 12) & 131071)) | 0;
  O[o + 13] = acc = (acc + md + (((w6 >>> 29) | (w7 << 3)) & 131071)) | 0;
  O[o + 14] = acc = (acc + md + ((w7 >>> 14) & 131071)) | 0;
  O[o + 15] = acc = (acc + md + (((w7 >>> 31) | (w8 << 1)) & 131071)) | 0;
  O[o + 16] = acc = (acc + md + (((w8 >>> 16) | (w9 << 16)) & 131071)) | 0;
  O[o + 17] = acc = (acc + md + ((w9 >>> 1) & 131071)) | 0;
  O[o + 18] = acc = (acc + md + (((w9 >>> 18) | (w10 << 14)) & 131071)) | 0;
  O[o + 19] = acc = (acc + md + ((w10 >>> 3) & 131071)) | 0;
  O[o + 20] = acc = (acc + md + (((w10 >>> 20) | (w11 << 12)) & 131071)) | 0;
  O[o + 21] = acc = (acc + md + ((w11 >>> 5) & 131071)) | 0;
  O[o + 22] = acc = (acc + md + (((w11 >>> 22) | (w12 << 10)) & 131071)) | 0;
  O[o + 23] = acc = (acc + md + ((w12 >>> 7) & 131071)) | 0;
  O[o + 24] = acc = (acc + md + (((w12 >>> 24) | (w13 << 8)) & 131071)) | 0;
  O[o + 25] = acc = (acc + md + ((w13 >>> 9) & 131071)) | 0;
  O[o + 26] = acc = (acc + md + (((w13 >>> 26) | (w14 << 6)) & 131071)) | 0;
  O[o + 27] = acc = (acc + md + ((w14 >>> 11) & 131071)) | 0;
  O[o + 28] = acc = (acc + md + (((w14 >>> 28) | (w15 << 4)) & 131071)) | 0;
  O[o + 29] = acc = (acc + md + ((w15 >>> 13) & 131071)) | 0;
  O[o + 30] = acc = (acc + md + (((w15 >>> 30) | (w16 << 2)) & 131071)) | 0;
  O[o + 31] = acc = (acc + md + (w16 >>> 15)) | 0;
  return acc;
},
function delta32_18(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  O[o + 0] = acc = (acc + md + (w0 & 262143)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 18) | (w1 << 14)) & 262143)) | 0;
  O[o + 2] = acc = (acc + md + ((w1 >>> 4) & 262143)) | 0;
  O[o + 3] = acc = (acc + md + (((w1 >>> 22) | (w2 << 10)) & 262143)) | 0;
  O[o + 4] = acc = (acc + md + ((w2 >>> 8) & 262143)) | 0;
  O[o + 5] = acc = (acc + md + (((w2 >>> 26) | (w3 << 6)) & 262143)) | 0;
  O[o + 6] = acc = (acc + md + ((w3 >>> 12) & 262143)) | 0;
  O[o + 7] = acc = (acc + md + (((w3 >>> 30) | (w4 << 2)) & 262143)) | 0;
  O[o + 8] = acc = (acc + md + (((w4 >>> 16) | (w5 << 16)) & 262143)) | 0;
  O[o + 9] = acc = (acc + md + ((w5 >>> 2) & 262143)) | 0;
  O[o + 10] = acc = (acc + md + (((w5 >>> 20) | (w6 << 12)) & 262143)) | 0;
  O[o + 11] = acc = (acc + md + ((w6 >>> 6) & 262143)) | 0;
  O[o + 12] = acc = (acc + md + (((w6 >>> 24) | (w7 << 8)) & 262143)) | 0;
  O[o + 13] = acc = (acc + md + ((w7 >>> 10) & 262143)) | 0;
  O[o + 14] = acc = (acc + md + (((w7 >>> 28) | (w8 << 4)) & 262143)) | 0;
  O[o + 15] = acc = (acc + md + (w8 >>> 14)) | 0;
  O[o + 16] = acc = (acc + md + (w9 & 262143)) | 0;
  O[o + 17] = acc = (acc + md + (((w9 >>> 18) | (w10 << 14)) & 262143)) | 0;
  O[o + 18] = acc = (acc + md + ((w10 >>> 4) & 262143)) | 0;
  O[o + 19] = acc = (acc + md + (((w10 >>> 22) | (w11 << 10)) & 262143)) | 0;
  O[o + 20] = acc = (acc + md + ((w11 >>> 8) & 262143)) | 0;
  O[o + 21] = acc = (acc + md + (((w11 >>> 26) | (w12 << 6)) & 262143)) | 0;
  O[o + 22] = acc = (acc + md + ((w12 >>> 12) & 262143)) | 0;
  O[o + 23] = acc = (acc + md + (((w12 >>> 30) | (w13 << 2)) & 262143)) | 0;
  O[o + 24] = acc = (acc + md + (((w13 >>> 16) | (w14 << 16)) & 262143)) | 0;
  O[o + 25] = acc = (acc + md + ((w14 >>> 2) & 262143)) | 0;
  O[o + 26] = acc = (acc + md + (((w14 >>> 20) | (w15 << 12)) & 262143)) | 0;
  O[o + 27] = acc = (acc + md + ((w15 >>> 6) & 262143)) | 0;
  O[o + 28] = acc = (acc + md + (((w15 >>> 24) | (w16 << 8)) & 262143)) | 0;
  O[o + 29] = acc = (acc + md + ((w16 >>> 10) & 262143)) | 0;
  O[o + 30] = acc = (acc + md + (((w16 >>> 28) | (w17 << 4)) & 262143)) | 0;
  O[o + 31] = acc = (acc + md + (w17 >>> 14)) | 0;
  return acc;
},
function delta32_19(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  O[o + 0] = acc = (acc + md + (w0 & 524287)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 19) | (w1 << 13)) & 524287)) | 0;
  O[o + 2] = acc = (acc + md + ((w1 >>> 6) & 524287)) | 0;
  O[o + 3] = acc = (acc + md + (((w1 >>> 25) | (w2 << 7)) & 524287)) | 0;
  O[o + 4] = acc = (acc + md + ((w2 >>> 12) & 524287)) | 0;
  O[o + 5] = acc = (acc + md + (((w2 >>> 31) | (w3 << 1)) & 524287)) | 0;
  O[o + 6] = acc = (acc + md + (((w3 >>> 18) | (w4 << 14)) & 524287)) | 0;
  O[o + 7] = acc = (acc + md + ((w4 >>> 5) & 524287)) | 0;
  O[o + 8] = acc = (acc + md + (((w4 >>> 24) | (w5 << 8)) & 524287)) | 0;
  O[o + 9] = acc = (acc + md + ((w5 >>> 11) & 524287)) | 0;
  O[o + 10] = acc = (acc + md + (((w5 >>> 30) | (w6 << 2)) & 524287)) | 0;
  O[o + 11] = acc = (acc + md + (((w6 >>> 17) | (w7 << 15)) & 524287)) | 0;
  O[o + 12] = acc = (acc + md + ((w7 >>> 4) & 524287)) | 0;
  O[o + 13] = acc = (acc + md + (((w7 >>> 23) | (w8 << 9)) & 524287)) | 0;
  O[o + 14] = acc = (acc + md + ((w8 >>> 10) & 524287)) | 0;
  O[o + 15] = acc = (acc + md + (((w8 >>> 29) | (w9 << 3)) & 524287)) | 0;
  O[o + 16] = acc = (acc + md + (((w9 >>> 16) | (w10 << 16)) & 524287)) | 0;
  O[o + 17] = acc = (acc + md + ((w10 >>> 3) & 524287)) | 0;
  O[o + 18] = acc = (acc + md + (((w10 >>> 22) | (w11 << 10)) & 524287)) | 0;
  O[o + 19] = acc = (acc + md + ((w11 >>> 9) & 524287)) | 0;
  O[o + 20] = acc = (acc + md + (((w11 >>> 28) | (w12 << 4)) & 524287)) | 0;
  O[o + 21] = acc = (acc + md + (((w12 >>> 15) | (w13 << 17)) & 524287)) | 0;
  O[o + 22] = acc = (acc + md + ((w13 >>> 2) & 524287)) | 0;
  O[o + 23] = acc = (acc + md + (((w13 >>> 21) | (w14 << 11)) & 524287)) | 0;
  O[o + 24] = acc = (acc + md + ((w14 >>> 8) & 524287)) | 0;
  O[o + 25] = acc = (acc + md + (((w14 >>> 27) | (w15 << 5)) & 524287)) | 0;
  O[o + 26] = acc = (acc + md + (((w15 >>> 14) | (w16 << 18)) & 524287)) | 0;
  O[o + 27] = acc = (acc + md + ((w16 >>> 1) & 524287)) | 0;
  O[o + 28] = acc = (acc + md + (((w16 >>> 20) | (w17 << 12)) & 524287)) | 0;
  O[o + 29] = acc = (acc + md + ((w17 >>> 7) & 524287)) | 0;
  O[o + 30] = acc = (acc + md + (((w17 >>> 26) | (w18 << 6)) & 524287)) | 0;
  O[o + 31] = acc = (acc + md + (w18 >>> 13)) | 0;
  return acc;
},
function delta32_20(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  O[o + 0] = acc = (acc + md + (w0 & 1048575)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 20) | (w1 << 12)) & 1048575)) | 0;
  O[o + 2] = acc = (acc + md + ((w1 >>> 8) & 1048575)) | 0;
  O[o + 3] = acc = (acc + md + (((w1 >>> 28) | (w2 << 4)) & 1048575)) | 0;
  O[o + 4] = acc = (acc + md + (((w2 >>> 16) | (w3 << 16)) & 1048575)) | 0;
  O[o + 5] = acc = (acc + md + ((w3 >>> 4) & 1048575)) | 0;
  O[o + 6] = acc = (acc + md + (((w3 >>> 24) | (w4 << 8)) & 1048575)) | 0;
  O[o + 7] = acc = (acc + md + (w4 >>> 12)) | 0;
  O[o + 8] = acc = (acc + md + (w5 & 1048575)) | 0;
  O[o + 9] = acc = (acc + md + (((w5 >>> 20) | (w6 << 12)) & 1048575)) | 0;
  O[o + 10] = acc = (acc + md + ((w6 >>> 8) & 1048575)) | 0;
  O[o + 11] = acc = (acc + md + (((w6 >>> 28) | (w7 << 4)) & 1048575)) | 0;
  O[o + 12] = acc = (acc + md + (((w7 >>> 16) | (w8 << 16)) & 1048575)) | 0;
  O[o + 13] = acc = (acc + md + ((w8 >>> 4) & 1048575)) | 0;
  O[o + 14] = acc = (acc + md + (((w8 >>> 24) | (w9 << 8)) & 1048575)) | 0;
  O[o + 15] = acc = (acc + md + (w9 >>> 12)) | 0;
  O[o + 16] = acc = (acc + md + (w10 & 1048575)) | 0;
  O[o + 17] = acc = (acc + md + (((w10 >>> 20) | (w11 << 12)) & 1048575)) | 0;
  O[o + 18] = acc = (acc + md + ((w11 >>> 8) & 1048575)) | 0;
  O[o + 19] = acc = (acc + md + (((w11 >>> 28) | (w12 << 4)) & 1048575)) | 0;
  O[o + 20] = acc = (acc + md + (((w12 >>> 16) | (w13 << 16)) & 1048575)) | 0;
  O[o + 21] = acc = (acc + md + ((w13 >>> 4) & 1048575)) | 0;
  O[o + 22] = acc = (acc + md + (((w13 >>> 24) | (w14 << 8)) & 1048575)) | 0;
  O[o + 23] = acc = (acc + md + (w14 >>> 12)) | 0;
  O[o + 24] = acc = (acc + md + (w15 & 1048575)) | 0;
  O[o + 25] = acc = (acc + md + (((w15 >>> 20) | (w16 << 12)) & 1048575)) | 0;
  O[o + 26] = acc = (acc + md + ((w16 >>> 8) & 1048575)) | 0;
  O[o + 27] = acc = (acc + md + (((w16 >>> 28) | (w17 << 4)) & 1048575)) | 0;
  O[o + 28] = acc = (acc + md + (((w17 >>> 16) | (w18 << 16)) & 1048575)) | 0;
  O[o + 29] = acc = (acc + md + ((w18 >>> 4) & 1048575)) | 0;
  O[o + 30] = acc = (acc + md + (((w18 >>> 24) | (w19 << 8)) & 1048575)) | 0;
  O[o + 31] = acc = (acc + md + (w19 >>> 12)) | 0;
  return acc;
},
function delta32_21(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  O[o + 0] = acc = (acc + md + (w0 & 2097151)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 21) | (w1 << 11)) & 2097151)) | 0;
  O[o + 2] = acc = (acc + md + ((w1 >>> 10) & 2097151)) | 0;
  O[o + 3] = acc = (acc + md + (((w1 >>> 31) | (w2 << 1)) & 2097151)) | 0;
  O[o + 4] = acc = (acc + md + (((w2 >>> 20) | (w3 << 12)) & 2097151)) | 0;
  O[o + 5] = acc = (acc + md + ((w3 >>> 9) & 2097151)) | 0;
  O[o + 6] = acc = (acc + md + (((w3 >>> 30) | (w4 << 2)) & 2097151)) | 0;
  O[o + 7] = acc = (acc + md + (((w4 >>> 19) | (w5 << 13)) & 2097151)) | 0;
  O[o + 8] = acc = (acc + md + ((w5 >>> 8) & 2097151)) | 0;
  O[o + 9] = acc = (acc + md + (((w5 >>> 29) | (w6 << 3)) & 2097151)) | 0;
  O[o + 10] = acc = (acc + md + (((w6 >>> 18) | (w7 << 14)) & 2097151)) | 0;
  O[o + 11] = acc = (acc + md + ((w7 >>> 7) & 2097151)) | 0;
  O[o + 12] = acc = (acc + md + (((w7 >>> 28) | (w8 << 4)) & 2097151)) | 0;
  O[o + 13] = acc = (acc + md + (((w8 >>> 17) | (w9 << 15)) & 2097151)) | 0;
  O[o + 14] = acc = (acc + md + ((w9 >>> 6) & 2097151)) | 0;
  O[o + 15] = acc = (acc + md + (((w9 >>> 27) | (w10 << 5)) & 2097151)) | 0;
  O[o + 16] = acc = (acc + md + (((w10 >>> 16) | (w11 << 16)) & 2097151)) | 0;
  O[o + 17] = acc = (acc + md + ((w11 >>> 5) & 2097151)) | 0;
  O[o + 18] = acc = (acc + md + (((w11 >>> 26) | (w12 << 6)) & 2097151)) | 0;
  O[o + 19] = acc = (acc + md + (((w12 >>> 15) | (w13 << 17)) & 2097151)) | 0;
  O[o + 20] = acc = (acc + md + ((w13 >>> 4) & 2097151)) | 0;
  O[o + 21] = acc = (acc + md + (((w13 >>> 25) | (w14 << 7)) & 2097151)) | 0;
  O[o + 22] = acc = (acc + md + (((w14 >>> 14) | (w15 << 18)) & 2097151)) | 0;
  O[o + 23] = acc = (acc + md + ((w15 >>> 3) & 2097151)) | 0;
  O[o + 24] = acc = (acc + md + (((w15 >>> 24) | (w16 << 8)) & 2097151)) | 0;
  O[o + 25] = acc = (acc + md + (((w16 >>> 13) | (w17 << 19)) & 2097151)) | 0;
  O[o + 26] = acc = (acc + md + ((w17 >>> 2) & 2097151)) | 0;
  O[o + 27] = acc = (acc + md + (((w17 >>> 23) | (w18 << 9)) & 2097151)) | 0;
  O[o + 28] = acc = (acc + md + (((w18 >>> 12) | (w19 << 20)) & 2097151)) | 0;
  O[o + 29] = acc = (acc + md + ((w19 >>> 1) & 2097151)) | 0;
  O[o + 30] = acc = (acc + md + (((w19 >>> 22) | (w20 << 10)) & 2097151)) | 0;
  O[o + 31] = acc = (acc + md + (w20 >>> 11)) | 0;
  return acc;
},
function delta32_22(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  O[o + 0] = acc = (acc + md + (w0 & 4194303)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 22) | (w1 << 10)) & 4194303)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 12) | (w2 << 20)) & 4194303)) | 0;
  O[o + 3] = acc = (acc + md + ((w2 >>> 2) & 4194303)) | 0;
  O[o + 4] = acc = (acc + md + (((w2 >>> 24) | (w3 << 8)) & 4194303)) | 0;
  O[o + 5] = acc = (acc + md + (((w3 >>> 14) | (w4 << 18)) & 4194303)) | 0;
  O[o + 6] = acc = (acc + md + ((w4 >>> 4) & 4194303)) | 0;
  O[o + 7] = acc = (acc + md + (((w4 >>> 26) | (w5 << 6)) & 4194303)) | 0;
  O[o + 8] = acc = (acc + md + (((w5 >>> 16) | (w6 << 16)) & 4194303)) | 0;
  O[o + 9] = acc = (acc + md + ((w6 >>> 6) & 4194303)) | 0;
  O[o + 10] = acc = (acc + md + (((w6 >>> 28) | (w7 << 4)) & 4194303)) | 0;
  O[o + 11] = acc = (acc + md + (((w7 >>> 18) | (w8 << 14)) & 4194303)) | 0;
  O[o + 12] = acc = (acc + md + ((w8 >>> 8) & 4194303)) | 0;
  O[o + 13] = acc = (acc + md + (((w8 >>> 30) | (w9 << 2)) & 4194303)) | 0;
  O[o + 14] = acc = (acc + md + (((w9 >>> 20) | (w10 << 12)) & 4194303)) | 0;
  O[o + 15] = acc = (acc + md + (w10 >>> 10)) | 0;
  O[o + 16] = acc = (acc + md + (w11 & 4194303)) | 0;
  O[o + 17] = acc = (acc + md + (((w11 >>> 22) | (w12 << 10)) & 4194303)) | 0;
  O[o + 18] = acc = (acc + md + (((w12 >>> 12) | (w13 << 20)) & 4194303)) | 0;
  O[o + 19] = acc = (acc + md + ((w13 >>> 2) & 4194303)) | 0;
  O[o + 20] = acc = (acc + md + (((w13 >>> 24) | (w14 << 8)) & 4194303)) | 0;
  O[o + 21] = acc = (acc + md + (((w14 >>> 14) | (w15 << 18)) & 4194303)) | 0;
  O[o + 22] = acc = (acc + md + ((w15 >>> 4) & 4194303)) | 0;
  O[o + 23] = acc = (acc + md + (((w15 >>> 26) | (w16 << 6)) & 4194303)) | 0;
  O[o + 24] = acc = (acc + md + (((w16 >>> 16) | (w17 << 16)) & 4194303)) | 0;
  O[o + 25] = acc = (acc + md + ((w17 >>> 6) & 4194303)) | 0;
  O[o + 26] = acc = (acc + md + (((w17 >>> 28) | (w18 << 4)) & 4194303)) | 0;
  O[o + 27] = acc = (acc + md + (((w18 >>> 18) | (w19 << 14)) & 4194303)) | 0;
  O[o + 28] = acc = (acc + md + ((w19 >>> 8) & 4194303)) | 0;
  O[o + 29] = acc = (acc + md + (((w19 >>> 30) | (w20 << 2)) & 4194303)) | 0;
  O[o + 30] = acc = (acc + md + (((w20 >>> 20) | (w21 << 12)) & 4194303)) | 0;
  O[o + 31] = acc = (acc + md + (w21 >>> 10)) | 0;
  return acc;
},
function delta32_23(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  O[o + 0] = acc = (acc + md + (w0 & 8388607)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 23) | (w1 << 9)) & 8388607)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 14) | (w2 << 18)) & 8388607)) | 0;
  O[o + 3] = acc = (acc + md + ((w2 >>> 5) & 8388607)) | 0;
  O[o + 4] = acc = (acc + md + (((w2 >>> 28) | (w3 << 4)) & 8388607)) | 0;
  O[o + 5] = acc = (acc + md + (((w3 >>> 19) | (w4 << 13)) & 8388607)) | 0;
  O[o + 6] = acc = (acc + md + (((w4 >>> 10) | (w5 << 22)) & 8388607)) | 0;
  O[o + 7] = acc = (acc + md + ((w5 >>> 1) & 8388607)) | 0;
  O[o + 8] = acc = (acc + md + (((w5 >>> 24) | (w6 << 8)) & 8388607)) | 0;
  O[o + 9] = acc = (acc + md + (((w6 >>> 15) | (w7 << 17)) & 8388607)) | 0;
  O[o + 10] = acc = (acc + md + ((w7 >>> 6) & 8388607)) | 0;
  O[o + 11] = acc = (acc + md + (((w7 >>> 29) | (w8 << 3)) & 8388607)) | 0;
  O[o + 12] = acc = (acc + md + (((w8 >>> 20) | (w9 << 12)) & 8388607)) | 0;
  O[o + 13] = acc = (acc + md + (((w9 >>> 11) | (w10 << 21)) & 8388607)) | 0;
  O[o + 14] = acc = (acc + md + ((w10 >>> 2) & 8388607)) | 0;
  O[o + 15] = acc = (acc + md + (((w10 >>> 25) | (w11 << 7)) & 8388607)) | 0;
  O[o + 16] = acc = (acc + md + (((w11 >>> 16) | (w12 << 16)) & 8388607)) | 0;
  O[o + 17] = acc = (acc + md + ((w12 >>> 7) & 8388607)) | 0;
  O[o + 18] = acc = (acc + md + (((w12 >>> 30) | (w13 << 2)) & 8388607)) | 0;
  O[o + 19] = acc = (acc + md + (((w13 >>> 21) | (w14 << 11)) & 8388607)) | 0;
  O[o + 20] = acc = (acc + md + (((w14 >>> 12) | (w15 << 20)) & 8388607)) | 0;
  O[o + 21] = acc = (acc + md + ((w15 >>> 3) & 8388607)) | 0;
  O[o + 22] = acc = (acc + md + (((w15 >>> 26) | (w16 << 6)) & 8388607)) | 0;
  O[o + 23] = acc = (acc + md + (((w16 >>> 17) | (w17 << 15)) & 8388607)) | 0;
  O[o + 24] = acc = (acc + md + ((w17 >>> 8) & 8388607)) | 0;
  O[o + 25] = acc = (acc + md + (((w17 >>> 31) | (w18 << 1)) & 8388607)) | 0;
  O[o + 26] = acc = (acc + md + (((w18 >>> 22) | (w19 << 10)) & 8388607)) | 0;
  O[o + 27] = acc = (acc + md + (((w19 >>> 13) | (w20 << 19)) & 8388607)) | 0;
  O[o + 28] = acc = (acc + md + ((w20 >>> 4) & 8388607)) | 0;
  O[o + 29] = acc = (acc + md + (((w20 >>> 27) | (w21 << 5)) & 8388607)) | 0;
  O[o + 30] = acc = (acc + md + (((w21 >>> 18) | (w22 << 14)) & 8388607)) | 0;
  O[o + 31] = acc = (acc + md + (w22 >>> 9)) | 0;
  return acc;
},
function delta32_24(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  O[o + 0] = acc = (acc + md + (w0 & 16777215)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 24) | (w1 << 8)) & 16777215)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 16) | (w2 << 16)) & 16777215)) | 0;
  O[o + 3] = acc = (acc + md + (w2 >>> 8)) | 0;
  O[o + 4] = acc = (acc + md + (w3 & 16777215)) | 0;
  O[o + 5] = acc = (acc + md + (((w3 >>> 24) | (w4 << 8)) & 16777215)) | 0;
  O[o + 6] = acc = (acc + md + (((w4 >>> 16) | (w5 << 16)) & 16777215)) | 0;
  O[o + 7] = acc = (acc + md + (w5 >>> 8)) | 0;
  O[o + 8] = acc = (acc + md + (w6 & 16777215)) | 0;
  O[o + 9] = acc = (acc + md + (((w6 >>> 24) | (w7 << 8)) & 16777215)) | 0;
  O[o + 10] = acc = (acc + md + (((w7 >>> 16) | (w8 << 16)) & 16777215)) | 0;
  O[o + 11] = acc = (acc + md + (w8 >>> 8)) | 0;
  O[o + 12] = acc = (acc + md + (w9 & 16777215)) | 0;
  O[o + 13] = acc = (acc + md + (((w9 >>> 24) | (w10 << 8)) & 16777215)) | 0;
  O[o + 14] = acc = (acc + md + (((w10 >>> 16) | (w11 << 16)) & 16777215)) | 0;
  O[o + 15] = acc = (acc + md + (w11 >>> 8)) | 0;
  O[o + 16] = acc = (acc + md + (w12 & 16777215)) | 0;
  O[o + 17] = acc = (acc + md + (((w12 >>> 24) | (w13 << 8)) & 16777215)) | 0;
  O[o + 18] = acc = (acc + md + (((w13 >>> 16) | (w14 << 16)) & 16777215)) | 0;
  O[o + 19] = acc = (acc + md + (w14 >>> 8)) | 0;
  O[o + 20] = acc = (acc + md + (w15 & 16777215)) | 0;
  O[o + 21] = acc = (acc + md + (((w15 >>> 24) | (w16 << 8)) & 16777215)) | 0;
  O[o + 22] = acc = (acc + md + (((w16 >>> 16) | (w17 << 16)) & 16777215)) | 0;
  O[o + 23] = acc = (acc + md + (w17 >>> 8)) | 0;
  O[o + 24] = acc = (acc + md + (w18 & 16777215)) | 0;
  O[o + 25] = acc = (acc + md + (((w18 >>> 24) | (w19 << 8)) & 16777215)) | 0;
  O[o + 26] = acc = (acc + md + (((w19 >>> 16) | (w20 << 16)) & 16777215)) | 0;
  O[o + 27] = acc = (acc + md + (w20 >>> 8)) | 0;
  O[o + 28] = acc = (acc + md + (w21 & 16777215)) | 0;
  O[o + 29] = acc = (acc + md + (((w21 >>> 24) | (w22 << 8)) & 16777215)) | 0;
  O[o + 30] = acc = (acc + md + (((w22 >>> 16) | (w23 << 16)) & 16777215)) | 0;
  O[o + 31] = acc = (acc + md + (w23 >>> 8)) | 0;
  return acc;
},
function delta32_25(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  O[o + 0] = acc = (acc + md + (w0 & 33554431)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 25) | (w1 << 7)) & 33554431)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 18) | (w2 << 14)) & 33554431)) | 0;
  O[o + 3] = acc = (acc + md + (((w2 >>> 11) | (w3 << 21)) & 33554431)) | 0;
  O[o + 4] = acc = (acc + md + ((w3 >>> 4) & 33554431)) | 0;
  O[o + 5] = acc = (acc + md + (((w3 >>> 29) | (w4 << 3)) & 33554431)) | 0;
  O[o + 6] = acc = (acc + md + (((w4 >>> 22) | (w5 << 10)) & 33554431)) | 0;
  O[o + 7] = acc = (acc + md + (((w5 >>> 15) | (w6 << 17)) & 33554431)) | 0;
  O[o + 8] = acc = (acc + md + (((w6 >>> 8) | (w7 << 24)) & 33554431)) | 0;
  O[o + 9] = acc = (acc + md + ((w7 >>> 1) & 33554431)) | 0;
  O[o + 10] = acc = (acc + md + (((w7 >>> 26) | (w8 << 6)) & 33554431)) | 0;
  O[o + 11] = acc = (acc + md + (((w8 >>> 19) | (w9 << 13)) & 33554431)) | 0;
  O[o + 12] = acc = (acc + md + (((w9 >>> 12) | (w10 << 20)) & 33554431)) | 0;
  O[o + 13] = acc = (acc + md + ((w10 >>> 5) & 33554431)) | 0;
  O[o + 14] = acc = (acc + md + (((w10 >>> 30) | (w11 << 2)) & 33554431)) | 0;
  O[o + 15] = acc = (acc + md + (((w11 >>> 23) | (w12 << 9)) & 33554431)) | 0;
  O[o + 16] = acc = (acc + md + (((w12 >>> 16) | (w13 << 16)) & 33554431)) | 0;
  O[o + 17] = acc = (acc + md + (((w13 >>> 9) | (w14 << 23)) & 33554431)) | 0;
  O[o + 18] = acc = (acc + md + ((w14 >>> 2) & 33554431)) | 0;
  O[o + 19] = acc = (acc + md + (((w14 >>> 27) | (w15 << 5)) & 33554431)) | 0;
  O[o + 20] = acc = (acc + md + (((w15 >>> 20) | (w16 << 12)) & 33554431)) | 0;
  O[o + 21] = acc = (acc + md + (((w16 >>> 13) | (w17 << 19)) & 33554431)) | 0;
  O[o + 22] = acc = (acc + md + ((w17 >>> 6) & 33554431)) | 0;
  O[o + 23] = acc = (acc + md + (((w17 >>> 31) | (w18 << 1)) & 33554431)) | 0;
  O[o + 24] = acc = (acc + md + (((w18 >>> 24) | (w19 << 8)) & 33554431)) | 0;
  O[o + 25] = acc = (acc + md + (((w19 >>> 17) | (w20 << 15)) & 33554431)) | 0;
  O[o + 26] = acc = (acc + md + (((w20 >>> 10) | (w21 << 22)) & 33554431)) | 0;
  O[o + 27] = acc = (acc + md + ((w21 >>> 3) & 33554431)) | 0;
  O[o + 28] = acc = (acc + md + (((w21 >>> 28) | (w22 << 4)) & 33554431)) | 0;
  O[o + 29] = acc = (acc + md + (((w22 >>> 21) | (w23 << 11)) & 33554431)) | 0;
  O[o + 30] = acc = (acc + md + (((w23 >>> 14) | (w24 << 18)) & 33554431)) | 0;
  O[o + 31] = acc = (acc + md + (w24 >>> 7)) | 0;
  return acc;
},
function delta32_26(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  const w25 = dv.getInt32(p + 100, true);
  O[o + 0] = acc = (acc + md + (w0 & 67108863)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 26) | (w1 << 6)) & 67108863)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 20) | (w2 << 12)) & 67108863)) | 0;
  O[o + 3] = acc = (acc + md + (((w2 >>> 14) | (w3 << 18)) & 67108863)) | 0;
  O[o + 4] = acc = (acc + md + (((w3 >>> 8) | (w4 << 24)) & 67108863)) | 0;
  O[o + 5] = acc = (acc + md + ((w4 >>> 2) & 67108863)) | 0;
  O[o + 6] = acc = (acc + md + (((w4 >>> 28) | (w5 << 4)) & 67108863)) | 0;
  O[o + 7] = acc = (acc + md + (((w5 >>> 22) | (w6 << 10)) & 67108863)) | 0;
  O[o + 8] = acc = (acc + md + (((w6 >>> 16) | (w7 << 16)) & 67108863)) | 0;
  O[o + 9] = acc = (acc + md + (((w7 >>> 10) | (w8 << 22)) & 67108863)) | 0;
  O[o + 10] = acc = (acc + md + ((w8 >>> 4) & 67108863)) | 0;
  O[o + 11] = acc = (acc + md + (((w8 >>> 30) | (w9 << 2)) & 67108863)) | 0;
  O[o + 12] = acc = (acc + md + (((w9 >>> 24) | (w10 << 8)) & 67108863)) | 0;
  O[o + 13] = acc = (acc + md + (((w10 >>> 18) | (w11 << 14)) & 67108863)) | 0;
  O[o + 14] = acc = (acc + md + (((w11 >>> 12) | (w12 << 20)) & 67108863)) | 0;
  O[o + 15] = acc = (acc + md + (w12 >>> 6)) | 0;
  O[o + 16] = acc = (acc + md + (w13 & 67108863)) | 0;
  O[o + 17] = acc = (acc + md + (((w13 >>> 26) | (w14 << 6)) & 67108863)) | 0;
  O[o + 18] = acc = (acc + md + (((w14 >>> 20) | (w15 << 12)) & 67108863)) | 0;
  O[o + 19] = acc = (acc + md + (((w15 >>> 14) | (w16 << 18)) & 67108863)) | 0;
  O[o + 20] = acc = (acc + md + (((w16 >>> 8) | (w17 << 24)) & 67108863)) | 0;
  O[o + 21] = acc = (acc + md + ((w17 >>> 2) & 67108863)) | 0;
  O[o + 22] = acc = (acc + md + (((w17 >>> 28) | (w18 << 4)) & 67108863)) | 0;
  O[o + 23] = acc = (acc + md + (((w18 >>> 22) | (w19 << 10)) & 67108863)) | 0;
  O[o + 24] = acc = (acc + md + (((w19 >>> 16) | (w20 << 16)) & 67108863)) | 0;
  O[o + 25] = acc = (acc + md + (((w20 >>> 10) | (w21 << 22)) & 67108863)) | 0;
  O[o + 26] = acc = (acc + md + ((w21 >>> 4) & 67108863)) | 0;
  O[o + 27] = acc = (acc + md + (((w21 >>> 30) | (w22 << 2)) & 67108863)) | 0;
  O[o + 28] = acc = (acc + md + (((w22 >>> 24) | (w23 << 8)) & 67108863)) | 0;
  O[o + 29] = acc = (acc + md + (((w23 >>> 18) | (w24 << 14)) & 67108863)) | 0;
  O[o + 30] = acc = (acc + md + (((w24 >>> 12) | (w25 << 20)) & 67108863)) | 0;
  O[o + 31] = acc = (acc + md + (w25 >>> 6)) | 0;
  return acc;
},
function delta32_27(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  const w25 = dv.getInt32(p + 100, true);
  const w26 = dv.getInt32(p + 104, true);
  O[o + 0] = acc = (acc + md + (w0 & 134217727)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 27) | (w1 << 5)) & 134217727)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 22) | (w2 << 10)) & 134217727)) | 0;
  O[o + 3] = acc = (acc + md + (((w2 >>> 17) | (w3 << 15)) & 134217727)) | 0;
  O[o + 4] = acc = (acc + md + (((w3 >>> 12) | (w4 << 20)) & 134217727)) | 0;
  O[o + 5] = acc = (acc + md + (((w4 >>> 7) | (w5 << 25)) & 134217727)) | 0;
  O[o + 6] = acc = (acc + md + ((w5 >>> 2) & 134217727)) | 0;
  O[o + 7] = acc = (acc + md + (((w5 >>> 29) | (w6 << 3)) & 134217727)) | 0;
  O[o + 8] = acc = (acc + md + (((w6 >>> 24) | (w7 << 8)) & 134217727)) | 0;
  O[o + 9] = acc = (acc + md + (((w7 >>> 19) | (w8 << 13)) & 134217727)) | 0;
  O[o + 10] = acc = (acc + md + (((w8 >>> 14) | (w9 << 18)) & 134217727)) | 0;
  O[o + 11] = acc = (acc + md + (((w9 >>> 9) | (w10 << 23)) & 134217727)) | 0;
  O[o + 12] = acc = (acc + md + ((w10 >>> 4) & 134217727)) | 0;
  O[o + 13] = acc = (acc + md + (((w10 >>> 31) | (w11 << 1)) & 134217727)) | 0;
  O[o + 14] = acc = (acc + md + (((w11 >>> 26) | (w12 << 6)) & 134217727)) | 0;
  O[o + 15] = acc = (acc + md + (((w12 >>> 21) | (w13 << 11)) & 134217727)) | 0;
  O[o + 16] = acc = (acc + md + (((w13 >>> 16) | (w14 << 16)) & 134217727)) | 0;
  O[o + 17] = acc = (acc + md + (((w14 >>> 11) | (w15 << 21)) & 134217727)) | 0;
  O[o + 18] = acc = (acc + md + (((w15 >>> 6) | (w16 << 26)) & 134217727)) | 0;
  O[o + 19] = acc = (acc + md + ((w16 >>> 1) & 134217727)) | 0;
  O[o + 20] = acc = (acc + md + (((w16 >>> 28) | (w17 << 4)) & 134217727)) | 0;
  O[o + 21] = acc = (acc + md + (((w17 >>> 23) | (w18 << 9)) & 134217727)) | 0;
  O[o + 22] = acc = (acc + md + (((w18 >>> 18) | (w19 << 14)) & 134217727)) | 0;
  O[o + 23] = acc = (acc + md + (((w19 >>> 13) | (w20 << 19)) & 134217727)) | 0;
  O[o + 24] = acc = (acc + md + (((w20 >>> 8) | (w21 << 24)) & 134217727)) | 0;
  O[o + 25] = acc = (acc + md + ((w21 >>> 3) & 134217727)) | 0;
  O[o + 26] = acc = (acc + md + (((w21 >>> 30) | (w22 << 2)) & 134217727)) | 0;
  O[o + 27] = acc = (acc + md + (((w22 >>> 25) | (w23 << 7)) & 134217727)) | 0;
  O[o + 28] = acc = (acc + md + (((w23 >>> 20) | (w24 << 12)) & 134217727)) | 0;
  O[o + 29] = acc = (acc + md + (((w24 >>> 15) | (w25 << 17)) & 134217727)) | 0;
  O[o + 30] = acc = (acc + md + (((w25 >>> 10) | (w26 << 22)) & 134217727)) | 0;
  O[o + 31] = acc = (acc + md + (w26 >>> 5)) | 0;
  return acc;
},
function delta32_28(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  const w25 = dv.getInt32(p + 100, true);
  const w26 = dv.getInt32(p + 104, true);
  const w27 = dv.getInt32(p + 108, true);
  O[o + 0] = acc = (acc + md + (w0 & 268435455)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 28) | (w1 << 4)) & 268435455)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 24) | (w2 << 8)) & 268435455)) | 0;
  O[o + 3] = acc = (acc + md + (((w2 >>> 20) | (w3 << 12)) & 268435455)) | 0;
  O[o + 4] = acc = (acc + md + (((w3 >>> 16) | (w4 << 16)) & 268435455)) | 0;
  O[o + 5] = acc = (acc + md + (((w4 >>> 12) | (w5 << 20)) & 268435455)) | 0;
  O[o + 6] = acc = (acc + md + (((w5 >>> 8) | (w6 << 24)) & 268435455)) | 0;
  O[o + 7] = acc = (acc + md + (w6 >>> 4)) | 0;
  O[o + 8] = acc = (acc + md + (w7 & 268435455)) | 0;
  O[o + 9] = acc = (acc + md + (((w7 >>> 28) | (w8 << 4)) & 268435455)) | 0;
  O[o + 10] = acc = (acc + md + (((w8 >>> 24) | (w9 << 8)) & 268435455)) | 0;
  O[o + 11] = acc = (acc + md + (((w9 >>> 20) | (w10 << 12)) & 268435455)) | 0;
  O[o + 12] = acc = (acc + md + (((w10 >>> 16) | (w11 << 16)) & 268435455)) | 0;
  O[o + 13] = acc = (acc + md + (((w11 >>> 12) | (w12 << 20)) & 268435455)) | 0;
  O[o + 14] = acc = (acc + md + (((w12 >>> 8) | (w13 << 24)) & 268435455)) | 0;
  O[o + 15] = acc = (acc + md + (w13 >>> 4)) | 0;
  O[o + 16] = acc = (acc + md + (w14 & 268435455)) | 0;
  O[o + 17] = acc = (acc + md + (((w14 >>> 28) | (w15 << 4)) & 268435455)) | 0;
  O[o + 18] = acc = (acc + md + (((w15 >>> 24) | (w16 << 8)) & 268435455)) | 0;
  O[o + 19] = acc = (acc + md + (((w16 >>> 20) | (w17 << 12)) & 268435455)) | 0;
  O[o + 20] = acc = (acc + md + (((w17 >>> 16) | (w18 << 16)) & 268435455)) | 0;
  O[o + 21] = acc = (acc + md + (((w18 >>> 12) | (w19 << 20)) & 268435455)) | 0;
  O[o + 22] = acc = (acc + md + (((w19 >>> 8) | (w20 << 24)) & 268435455)) | 0;
  O[o + 23] = acc = (acc + md + (w20 >>> 4)) | 0;
  O[o + 24] = acc = (acc + md + (w21 & 268435455)) | 0;
  O[o + 25] = acc = (acc + md + (((w21 >>> 28) | (w22 << 4)) & 268435455)) | 0;
  O[o + 26] = acc = (acc + md + (((w22 >>> 24) | (w23 << 8)) & 268435455)) | 0;
  O[o + 27] = acc = (acc + md + (((w23 >>> 20) | (w24 << 12)) & 268435455)) | 0;
  O[o + 28] = acc = (acc + md + (((w24 >>> 16) | (w25 << 16)) & 268435455)) | 0;
  O[o + 29] = acc = (acc + md + (((w25 >>> 12) | (w26 << 20)) & 268435455)) | 0;
  O[o + 30] = acc = (acc + md + (((w26 >>> 8) | (w27 << 24)) & 268435455)) | 0;
  O[o + 31] = acc = (acc + md + (w27 >>> 4)) | 0;
  return acc;
},
function delta32_29(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  const w25 = dv.getInt32(p + 100, true);
  const w26 = dv.getInt32(p + 104, true);
  const w27 = dv.getInt32(p + 108, true);
  const w28 = dv.getInt32(p + 112, true);
  O[o + 0] = acc = (acc + md + (w0 & 536870911)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 29) | (w1 << 3)) & 536870911)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 26) | (w2 << 6)) & 536870911)) | 0;
  O[o + 3] = acc = (acc + md + (((w2 >>> 23) | (w3 << 9)) & 536870911)) | 0;
  O[o + 4] = acc = (acc + md + (((w3 >>> 20) | (w4 << 12)) & 536870911)) | 0;
  O[o + 5] = acc = (acc + md + (((w4 >>> 17) | (w5 << 15)) & 536870911)) | 0;
  O[o + 6] = acc = (acc + md + (((w5 >>> 14) | (w6 << 18)) & 536870911)) | 0;
  O[o + 7] = acc = (acc + md + (((w6 >>> 11) | (w7 << 21)) & 536870911)) | 0;
  O[o + 8] = acc = (acc + md + (((w7 >>> 8) | (w8 << 24)) & 536870911)) | 0;
  O[o + 9] = acc = (acc + md + (((w8 >>> 5) | (w9 << 27)) & 536870911)) | 0;
  O[o + 10] = acc = (acc + md + ((w9 >>> 2) & 536870911)) | 0;
  O[o + 11] = acc = (acc + md + (((w9 >>> 31) | (w10 << 1)) & 536870911)) | 0;
  O[o + 12] = acc = (acc + md + (((w10 >>> 28) | (w11 << 4)) & 536870911)) | 0;
  O[o + 13] = acc = (acc + md + (((w11 >>> 25) | (w12 << 7)) & 536870911)) | 0;
  O[o + 14] = acc = (acc + md + (((w12 >>> 22) | (w13 << 10)) & 536870911)) | 0;
  O[o + 15] = acc = (acc + md + (((w13 >>> 19) | (w14 << 13)) & 536870911)) | 0;
  O[o + 16] = acc = (acc + md + (((w14 >>> 16) | (w15 << 16)) & 536870911)) | 0;
  O[o + 17] = acc = (acc + md + (((w15 >>> 13) | (w16 << 19)) & 536870911)) | 0;
  O[o + 18] = acc = (acc + md + (((w16 >>> 10) | (w17 << 22)) & 536870911)) | 0;
  O[o + 19] = acc = (acc + md + (((w17 >>> 7) | (w18 << 25)) & 536870911)) | 0;
  O[o + 20] = acc = (acc + md + (((w18 >>> 4) | (w19 << 28)) & 536870911)) | 0;
  O[o + 21] = acc = (acc + md + ((w19 >>> 1) & 536870911)) | 0;
  O[o + 22] = acc = (acc + md + (((w19 >>> 30) | (w20 << 2)) & 536870911)) | 0;
  O[o + 23] = acc = (acc + md + (((w20 >>> 27) | (w21 << 5)) & 536870911)) | 0;
  O[o + 24] = acc = (acc + md + (((w21 >>> 24) | (w22 << 8)) & 536870911)) | 0;
  O[o + 25] = acc = (acc + md + (((w22 >>> 21) | (w23 << 11)) & 536870911)) | 0;
  O[o + 26] = acc = (acc + md + (((w23 >>> 18) | (w24 << 14)) & 536870911)) | 0;
  O[o + 27] = acc = (acc + md + (((w24 >>> 15) | (w25 << 17)) & 536870911)) | 0;
  O[o + 28] = acc = (acc + md + (((w25 >>> 12) | (w26 << 20)) & 536870911)) | 0;
  O[o + 29] = acc = (acc + md + (((w26 >>> 9) | (w27 << 23)) & 536870911)) | 0;
  O[o + 30] = acc = (acc + md + (((w27 >>> 6) | (w28 << 26)) & 536870911)) | 0;
  O[o + 31] = acc = (acc + md + (w28 >>> 3)) | 0;
  return acc;
},
function delta32_30(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  const w25 = dv.getInt32(p + 100, true);
  const w26 = dv.getInt32(p + 104, true);
  const w27 = dv.getInt32(p + 108, true);
  const w28 = dv.getInt32(p + 112, true);
  const w29 = dv.getInt32(p + 116, true);
  O[o + 0] = acc = (acc + md + (w0 & 1073741823)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 30) | (w1 << 2)) & 1073741823)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 28) | (w2 << 4)) & 1073741823)) | 0;
  O[o + 3] = acc = (acc + md + (((w2 >>> 26) | (w3 << 6)) & 1073741823)) | 0;
  O[o + 4] = acc = (acc + md + (((w3 >>> 24) | (w4 << 8)) & 1073741823)) | 0;
  O[o + 5] = acc = (acc + md + (((w4 >>> 22) | (w5 << 10)) & 1073741823)) | 0;
  O[o + 6] = acc = (acc + md + (((w5 >>> 20) | (w6 << 12)) & 1073741823)) | 0;
  O[o + 7] = acc = (acc + md + (((w6 >>> 18) | (w7 << 14)) & 1073741823)) | 0;
  O[o + 8] = acc = (acc + md + (((w7 >>> 16) | (w8 << 16)) & 1073741823)) | 0;
  O[o + 9] = acc = (acc + md + (((w8 >>> 14) | (w9 << 18)) & 1073741823)) | 0;
  O[o + 10] = acc = (acc + md + (((w9 >>> 12) | (w10 << 20)) & 1073741823)) | 0;
  O[o + 11] = acc = (acc + md + (((w10 >>> 10) | (w11 << 22)) & 1073741823)) | 0;
  O[o + 12] = acc = (acc + md + (((w11 >>> 8) | (w12 << 24)) & 1073741823)) | 0;
  O[o + 13] = acc = (acc + md + (((w12 >>> 6) | (w13 << 26)) & 1073741823)) | 0;
  O[o + 14] = acc = (acc + md + (((w13 >>> 4) | (w14 << 28)) & 1073741823)) | 0;
  O[o + 15] = acc = (acc + md + (w14 >>> 2)) | 0;
  O[o + 16] = acc = (acc + md + (w15 & 1073741823)) | 0;
  O[o + 17] = acc = (acc + md + (((w15 >>> 30) | (w16 << 2)) & 1073741823)) | 0;
  O[o + 18] = acc = (acc + md + (((w16 >>> 28) | (w17 << 4)) & 1073741823)) | 0;
  O[o + 19] = acc = (acc + md + (((w17 >>> 26) | (w18 << 6)) & 1073741823)) | 0;
  O[o + 20] = acc = (acc + md + (((w18 >>> 24) | (w19 << 8)) & 1073741823)) | 0;
  O[o + 21] = acc = (acc + md + (((w19 >>> 22) | (w20 << 10)) & 1073741823)) | 0;
  O[o + 22] = acc = (acc + md + (((w20 >>> 20) | (w21 << 12)) & 1073741823)) | 0;
  O[o + 23] = acc = (acc + md + (((w21 >>> 18) | (w22 << 14)) & 1073741823)) | 0;
  O[o + 24] = acc = (acc + md + (((w22 >>> 16) | (w23 << 16)) & 1073741823)) | 0;
  O[o + 25] = acc = (acc + md + (((w23 >>> 14) | (w24 << 18)) & 1073741823)) | 0;
  O[o + 26] = acc = (acc + md + (((w24 >>> 12) | (w25 << 20)) & 1073741823)) | 0;
  O[o + 27] = acc = (acc + md + (((w25 >>> 10) | (w26 << 22)) & 1073741823)) | 0;
  O[o + 28] = acc = (acc + md + (((w26 >>> 8) | (w27 << 24)) & 1073741823)) | 0;
  O[o + 29] = acc = (acc + md + (((w27 >>> 6) | (w28 << 26)) & 1073741823)) | 0;
  O[o + 30] = acc = (acc + md + (((w28 >>> 4) | (w29 << 28)) & 1073741823)) | 0;
  O[o + 31] = acc = (acc + md + (w29 >>> 2)) | 0;
  return acc;
},
function delta32_31(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  const w25 = dv.getInt32(p + 100, true);
  const w26 = dv.getInt32(p + 104, true);
  const w27 = dv.getInt32(p + 108, true);
  const w28 = dv.getInt32(p + 112, true);
  const w29 = dv.getInt32(p + 116, true);
  const w30 = dv.getInt32(p + 120, true);
  O[o + 0] = acc = (acc + md + (w0 & 2147483647)) | 0;
  O[o + 1] = acc = (acc + md + (((w0 >>> 31) | (w1 << 1)) & 2147483647)) | 0;
  O[o + 2] = acc = (acc + md + (((w1 >>> 30) | (w2 << 2)) & 2147483647)) | 0;
  O[o + 3] = acc = (acc + md + (((w2 >>> 29) | (w3 << 3)) & 2147483647)) | 0;
  O[o + 4] = acc = (acc + md + (((w3 >>> 28) | (w4 << 4)) & 2147483647)) | 0;
  O[o + 5] = acc = (acc + md + (((w4 >>> 27) | (w5 << 5)) & 2147483647)) | 0;
  O[o + 6] = acc = (acc + md + (((w5 >>> 26) | (w6 << 6)) & 2147483647)) | 0;
  O[o + 7] = acc = (acc + md + (((w6 >>> 25) | (w7 << 7)) & 2147483647)) | 0;
  O[o + 8] = acc = (acc + md + (((w7 >>> 24) | (w8 << 8)) & 2147483647)) | 0;
  O[o + 9] = acc = (acc + md + (((w8 >>> 23) | (w9 << 9)) & 2147483647)) | 0;
  O[o + 10] = acc = (acc + md + (((w9 >>> 22) | (w10 << 10)) & 2147483647)) | 0;
  O[o + 11] = acc = (acc + md + (((w10 >>> 21) | (w11 << 11)) & 2147483647)) | 0;
  O[o + 12] = acc = (acc + md + (((w11 >>> 20) | (w12 << 12)) & 2147483647)) | 0;
  O[o + 13] = acc = (acc + md + (((w12 >>> 19) | (w13 << 13)) & 2147483647)) | 0;
  O[o + 14] = acc = (acc + md + (((w13 >>> 18) | (w14 << 14)) & 2147483647)) | 0;
  O[o + 15] = acc = (acc + md + (((w14 >>> 17) | (w15 << 15)) & 2147483647)) | 0;
  O[o + 16] = acc = (acc + md + (((w15 >>> 16) | (w16 << 16)) & 2147483647)) | 0;
  O[o + 17] = acc = (acc + md + (((w16 >>> 15) | (w17 << 17)) & 2147483647)) | 0;
  O[o + 18] = acc = (acc + md + (((w17 >>> 14) | (w18 << 18)) & 2147483647)) | 0;
  O[o + 19] = acc = (acc + md + (((w18 >>> 13) | (w19 << 19)) & 2147483647)) | 0;
  O[o + 20] = acc = (acc + md + (((w19 >>> 12) | (w20 << 20)) & 2147483647)) | 0;
  O[o + 21] = acc = (acc + md + (((w20 >>> 11) | (w21 << 21)) & 2147483647)) | 0;
  O[o + 22] = acc = (acc + md + (((w21 >>> 10) | (w22 << 22)) & 2147483647)) | 0;
  O[o + 23] = acc = (acc + md + (((w22 >>> 9) | (w23 << 23)) & 2147483647)) | 0;
  O[o + 24] = acc = (acc + md + (((w23 >>> 8) | (w24 << 24)) & 2147483647)) | 0;
  O[o + 25] = acc = (acc + md + (((w24 >>> 7) | (w25 << 25)) & 2147483647)) | 0;
  O[o + 26] = acc = (acc + md + (((w25 >>> 6) | (w26 << 26)) & 2147483647)) | 0;
  O[o + 27] = acc = (acc + md + (((w26 >>> 5) | (w27 << 27)) & 2147483647)) | 0;
  O[o + 28] = acc = (acc + md + (((w27 >>> 4) | (w28 << 28)) & 2147483647)) | 0;
  O[o + 29] = acc = (acc + md + (((w28 >>> 3) | (w29 << 29)) & 2147483647)) | 0;
  O[o + 30] = acc = (acc + md + (((w29 >>> 2) | (w30 << 30)) & 2147483647)) | 0;
  O[o + 31] = acc = (acc + md + (w30 >>> 1)) | 0;
  return acc;
},
function delta32_32(dv, p, O, o, acc, md) {
  const w0 = dv.getInt32(p + 0, true);
  const w1 = dv.getInt32(p + 4, true);
  const w2 = dv.getInt32(p + 8, true);
  const w3 = dv.getInt32(p + 12, true);
  const w4 = dv.getInt32(p + 16, true);
  const w5 = dv.getInt32(p + 20, true);
  const w6 = dv.getInt32(p + 24, true);
  const w7 = dv.getInt32(p + 28, true);
  const w8 = dv.getInt32(p + 32, true);
  const w9 = dv.getInt32(p + 36, true);
  const w10 = dv.getInt32(p + 40, true);
  const w11 = dv.getInt32(p + 44, true);
  const w12 = dv.getInt32(p + 48, true);
  const w13 = dv.getInt32(p + 52, true);
  const w14 = dv.getInt32(p + 56, true);
  const w15 = dv.getInt32(p + 60, true);
  const w16 = dv.getInt32(p + 64, true);
  const w17 = dv.getInt32(p + 68, true);
  const w18 = dv.getInt32(p + 72, true);
  const w19 = dv.getInt32(p + 76, true);
  const w20 = dv.getInt32(p + 80, true);
  const w21 = dv.getInt32(p + 84, true);
  const w22 = dv.getInt32(p + 88, true);
  const w23 = dv.getInt32(p + 92, true);
  const w24 = dv.getInt32(p + 96, true);
  const w25 = dv.getInt32(p + 100, true);
  const w26 = dv.getInt32(p + 104, true);
  const w27 = dv.getInt32(p + 108, true);
  const w28 = dv.getInt32(p + 112, true);
  const w29 = dv.getInt32(p + 116, true);
  const w30 = dv.getInt32(p + 120, true);
  const w31 = dv.getInt32(p + 124, true);
  O[o + 0] = acc = (acc + md + (w0 >>> 0)) | 0;
  O[o + 1] = acc = (acc + md + (w1 >>> 0)) | 0;
  O[o + 2] = acc = (acc + md + (w2 >>> 0)) | 0;
  O[o + 3] = acc = (acc + md + (w3 >>> 0)) | 0;
  O[o + 4] = acc = (acc + md + (w4 >>> 0)) | 0;
  O[o + 5] = acc = (acc + md + (w5 >>> 0)) | 0;
  O[o + 6] = acc = (acc + md + (w6 >>> 0)) | 0;
  O[o + 7] = acc = (acc + md + (w7 >>> 0)) | 0;
  O[o + 8] = acc = (acc + md + (w8 >>> 0)) | 0;
  O[o + 9] = acc = (acc + md + (w9 >>> 0)) | 0;
  O[o + 10] = acc = (acc + md + (w10 >>> 0)) | 0;
  O[o + 11] = acc = (acc + md + (w11 >>> 0)) | 0;
  O[o + 12] = acc = (acc + md + (w12 >>> 0)) | 0;
  O[o + 13] = acc = (acc + md + (w13 >>> 0)) | 0;
  O[o + 14] = acc = (acc + md + (w14 >>> 0)) | 0;
  O[o + 15] = acc = (acc + md + (w15 >>> 0)) | 0;
  O[o + 16] = acc = (acc + md + (w16 >>> 0)) | 0;
  O[o + 17] = acc = (acc + md + (w17 >>> 0)) | 0;
  O[o + 18] = acc = (acc + md + (w18 >>> 0)) | 0;
  O[o + 19] = acc = (acc + md + (w19 >>> 0)) | 0;
  O[o + 20] = acc = (acc + md + (w20 >>> 0)) | 0;
  O[o + 21] = acc = (acc + md + (w21 >>> 0)) | 0;
  O[o + 22] = acc = (acc + md + (w22 >>> 0)) | 0;
  O[o + 23] = acc = (acc + md + (w23 >>> 0)) | 0;
  O[o + 24] = acc = (acc + md + (w24 >>> 0)) | 0;
  O[o + 25] = acc = (acc + md + (w25 >>> 0)) | 0;
  O[o + 26] = acc = (acc + md + (w26 >>> 0)) | 0;
  O[o + 27] = acc = (acc + md + (w27 >>> 0)) | 0;
  O[o + 28] = acc = (acc + md + (w28 >>> 0)) | 0;
  O[o + 29] = acc = (acc + md + (w29 >>> 0)) | 0;
  O[o + 30] = acc = (acc + md + (w30 >>> 0)) | 0;
  O[o + 31] = acc = (acc + md + (w31 >>> 0)) | 0;
  return acc;
},
];

// ── src/decode.js ──

// Value decoders for the encodings the core columns may use (SPEC §11):
// DELTA_BINARY_PACKED (INT32), BYTE_STREAM_SPLIT (DOUBLE/FLOAT/INT32), PLAIN (INT32/DOUBLE/FLOAT).

const scratch = new Int32Array(32);

// DELTA_BINARY_PACKED → Int32Array. B: page data bytes, from p. Writes `count` values to out[o…].
// Returns the byte position after the encoded run.
function deltaInt32$decode(B, p, out, o, count) {
  const r = { b: B, p };
  const blockSize = readVarint(r), nMini = readVarint(r), total = readVarint(r);
  let acc = zigzag(readVarint(r)) | 0;
  if (total !== count) throw new Error(`delta: header says ${total} values, page says ${count}`);
  if (total === 0) return r.p;
  const per = blockSize / nMini;
  if (!Number.isInteger(per) || per % 8 !== 0) throw new Error(`delta: bad block shape ${blockSize}/${nMini}`);
  out[o] = acc;
  const dv = new DataView(B.buffer, B.byteOffset, B.byteLength);
  const U = per === 32 ? DELTA32 : null;
  let i = 1;
  p = r.p;
  while (i < total) {
    r.p = p;
    const md = zigzag(readVarint(r));
    const wp = r.p;
    p = wp + nMini;
    for (let m = 0; m < nMini && i < total; m++) {
      const w = B[wp + m];
      if (w > 32) throw new Error(`delta: bit width ${w} > 32 for INT32`);
      const n = Math.min(per, total - i);
      if (U !== null) {
        if (n === 32) acc = U[w](dv, p, out, o + i, acc, md);
        else { acc = U[w](dv, p, scratch, 0, acc, md); for (let j = 0; j < n; j++) out[o + i + j] = scratch[j]; }
      } else acc = unpackGeneric(B, p, w, n, out, o + i, acc, md);
      p += (per * w) >>> 3;
      i += n;
    }
  }
  return p;
}

// Any miniblock size (a multiple of 8): bit-at-a-time-ish fallback.
function unpackGeneric(B, p, w, n, out, o, acc, md) {
  for (let j = 0; j < n; j++) {
    let v = 0;
    if (w) {
      const bit = j * w;
      let byte = p + (bit >>> 3), got = 0;
      const sh = bit & 7;
      while (got < w + sh) { v += B[byte++] * 2 ** got; got += 8; }
      v = Math.floor(v / 2 ** sh) % 2 ** w;
    }
    acc = (acc + md + v) | 0;
    out[o + j] = acc;
  }
  return acc;
}

const WIDTH$decode = { INT32: 4, FLOAT: 4, INT64: 8, DOUBLE: 8 };

// BYTE_STREAM_SPLIT: stream b holds byte b of every value. out is a typed array of the column's type.
function byteStreamSplit$decode(B, p, out, o, count, type) {
  const w = WIDTH$decode[type];
  const dst = new Uint8Array(out.buffer, out.byteOffset + o * w, count * w);
  for (let b = 0; b < w; b++) {
    const s = p + b * count;
    for (let i = 0, d = b; i < count; i++, d += w) dst[d] = B[s + i];
  }
  return p + count * w;
}

// PLAIN fixed-width little-endian values.
function plain$decode(B, p, out, o, count, type) {
  const w = WIDTH$decode[type];
  new Uint8Array(out.buffer, out.byteOffset + o * w, count * w).set(B.subarray(p, p + count * w));
  return p + count * w;
}

// ── src/snappy.js ──

// Snappy raw-format decompression (no framing), as used by Parquet pages.
function snappyDecompress(src, outLen) {
  let p = 0, len = 0, shift = 0, byte;
  do { byte = src[p++]; len += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  if (outLen !== undefined && len !== outLen) throw new Error(`snappy: length ${len}, expected ${outLen}`);
  const out = new Uint8Array(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++], t = tag & 3;
    if (t === 0) {
      let n = tag >>> 2;
      if (n >= 60) { const k = n - 59; n = 0; for (let i = 0; i < k; i++) n |= src[p++] << (8 * i); n >>>= 0; }
      n += 1;
      out.set(src.subarray(p, p + n), o); p += n; o += n;
      continue;
    }
    let n, off;
    if (t === 1) { n = ((tag >>> 2) & 7) + 4; off = ((tag >>> 5) << 8) | src[p++]; }
    else if (t === 2) { n = (tag >>> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
    else { n = (tag >>> 2) + 1; off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4; }
    if (off === 0 || off > o) throw new Error('snappy: bad copy offset');
    if (off >= n) out.copyWithin(o, o - off, o - off + n);
    else for (let i = 0; i < n; i++) out[o + i] = out[o - off + i];
    o += n;
  }
  if (o !== len) throw new Error(`snappy: wrote ${o} of ${len}`);
  return out;
}

// ── src/parquet.js ──

// The narrow Parquet reader: footer + REQUIRED flat columns in the encodings SPEC §11 allows.
// Anything outside that fails loudly, naming the column — never returns wrong values.

const TYPES = ['BOOLEAN', 'INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE', 'BYTE_ARRAY', 'FIXED_LEN_BYTE_ARRAY'];
const REPETITION = ['REQUIRED', 'OPTIONAL', 'REPEATED'];
const CODECS = ['UNCOMPRESSED', 'SNAPPY', 'GZIP', 'LZO', 'BROTLI', 'LZ4', 'ZSTD', 'LZ4_RAW'];
const ENC$parquet = { PLAIN: 0, PLAIN_DICTIONARY: 2, RLE: 3, DELTA_BINARY_PACKED: 5, RLE_DICTIONARY: 8, BYTE_STREAM_SPLIT: 9 };
const ENC_NAME = Object.fromEntries(Object.entries(ENC$parquet).map(([k, v]) => [v, k]));
const ARRAY$parquet = { INT32: Int32Array, FLOAT: Float32Array, DOUBLE: Float64Array };
const PAGE_DATA = 0, PAGE_DICT = 2, PAGE_DATA_V2 = 3;
const td$parquet = new TextDecoder();
const str = (b) => (b === undefined ? undefined : td$parquet.decode(b));

function statValue(b, type) {
  if (!b || !b.length) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (type) {
    case 'INT32': return dv.getInt32(0, true);
    case 'INT64': return Number(dv.getBigInt64(0, true));
    case 'FLOAT': return dv.getFloat32(0, true);
    case 'DOUBLE': return dv.getFloat64(0, true);
    default: return undefined;
  }
}

// Parse the footer from the file's last bytes. `tail` must end at the end of the file.
// Returns null with { need } when the tail is too short to hold the footer.
function parseFooter(tail, fileSize) {
  const n = tail.length;
  if (n < 8 || td$parquet.decode(tail.subarray(n - 4)) !== 'PAR1') throw new Error('parquet: missing PAR1 magic');
  const len = new DataView(tail.buffer, tail.byteOffset + n - 8, 4).getUint32(0, true);
  if (len + 8 > n) return { need: len + 8 };
  const { value: fm } = decodeStruct(tail, n - 8 - len);
  const schema = fm[2].map((e) => ({ name: str(e[4]), type: TYPES[e[1]], repetition: REPETITION[e[3]], children: e[5] || 0 }));
  // nested schemas are outside the narrow reader: the footer still parses, their columns won't decode
  const leaves = schema.slice(1);
  const rowGroups = (fm[4] || []).map((rg) => ({
    numRows: rg[3],
    columns: rg[1].map((cc, i) => {
      const md = cc[3];
      const name = md[3].map(str).join('.');
      const leaf = leaves.find((l) => l.name === name) || leaves[i];
      const st = md[12] || {};
      const type = TYPES[md[1]];
      const start = md[11] !== undefined && md[11] > 0 ? Math.min(md[11], md[9]) : md[9];
      return {
        name, type, repetition: leaf?.repetition, codec: CODECS[md[4]], encodings: md[2].map((e) => ENC_NAME[e] ?? e),
        numValues: md[5], start, length: md[7],
        min: statValue(st[6] ?? st[2], type), max: statValue(st[5] ?? st[1], type), nullCount: st[3],
      };
    }),
  }));
  const kv = {};
  for (const e of fm[5] || []) kv[str(e[1])] = str(e[2]);
  return { numRows: fm[3], schema, rowGroups, kv, createdBy: str(fm[6]), footerLength: len + 8, fileSize };
}

// RLE/bit-packed hybrid (dictionary indices): n values at bit width bw from B[p…end).
function hybridDecode(B, p, end, bw, n) {
  const out = new Int32Array(n);
  let o = 0;
  const r = { b: B, p };
  while (o < n && r.p < end) {
    let h = 0, mul = 1, byte;
    do { byte = B[r.p++]; h += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
    if (h % 2 === 0) {
      const run = h / 2, nb = Math.ceil(bw / 8);
      let v = 0; for (let i = 0; i < nb; i++) v += B[r.p++] * 2 ** (8 * i);
      for (let i = 0; i < run && o < n; i++) out[o++] = v;
    } else {
      const groups = (h - 1) / 2, total = groups * 8;
      let acc = 0, bits = 0, q = r.p;
      for (let i = 0; i < total; i++) {
        while (bits < bw) { acc += B[q++] * 2 ** bits; bits += 8; }
        const v = acc % 2 ** bw; acc = Math.floor(acc / 2 ** bw); bits -= bw;
        if (o < n) out[o++] = v;
      }
      r.p += groups * bw;
    }
  }
  return out;
}

// BYTE_ARRAY (UTF-8 strings): dictionary pages + RLE_DICTIONARY data pages, or PLAIN.
function decodeStrings(bytes, col, out, o) {
  if (col.codec !== 'UNCOMPRESSED' && col.codec !== 'SNAPPY') throw new Error(`parquet: column "${col.name}" uses codec ${col.codec}`);
  out = out || new Array(col.numValues);
  let p = 0, done = 0, dict = null;
  while (done < col.numValues) {
    const { value: h, end } = decodeStruct(bytes, p);
    let data = bytes.subarray(end, end + h[3]);
    p = end + h[3];
    if (col.codec === 'SNAPPY' && h[1] !== PAGE_DATA_V2) data = snappyDecompress(data, h[2]); // V2: below, after the levels
    let count, encoding;
    if (h[1] === PAGE_DICT) {
      const n = h[7][1]; dict = new Array(n);
      for (let i = 0, q = 0; i < n; i++) { const len = data[q] | (data[q + 1] << 8) | (data[q + 2] << 16) | (data[q + 3] << 24); dict[i] = td$parquet.decode(data.subarray(q + 4, q + 4 + len)); q += 4 + len; }
      continue;
    }
    if (h[1] === PAGE_DATA) { count = h[5][1]; encoding = h[5][2]; }
    else if (h[1] === PAGE_DATA_V2) {
      const v2 = h[8]; count = v2[1]; encoding = v2[4];
      if (v2[2]) throw new Error(`parquet: column "${col.name}" has nulls`);
      const lv = (v2[5] || 0) + (v2[6] || 0);
      data = data.subarray(lv);
      if (col.codec === 'SNAPPY' && v2[7] !== false) data = snappyDecompress(data, h[2] - lv);
    } else continue;
    if (encoding === ENC$parquet.RLE_DICTIONARY || encoding === ENC$parquet.PLAIN_DICTIONARY) {
      if (!dict) throw new Error(`parquet: column "${col.name}" has dictionary indices but no dictionary page`);
      const idx = hybridDecode(data, 1, data.length, data[0], count);
      for (let i = 0; i < count; i++) out[o + done + i] = dict[idx[i]];
    } else if (encoding === ENC$parquet.PLAIN) {
      for (let i = 0, q = 0; i < count; i++) { const len = data[q] | (data[q + 1] << 8) | (data[q + 2] << 16) | (data[q + 3] << 24); out[o + done + i] = td$parquet.decode(data.subarray(q + 4, q + 4 + len)); q += 4 + len; }
    } else throw new Error(`parquet: column "${col.name}" uses ${ENC_NAME[encoding] ?? encoding} for strings`);
    done += count;
  }
  return out;
}

// Decode one column chunk. `bytes` holds exactly the chunk (col.start … col.start + col.length).
// out: an optional preallocated typed array (or Array for strings); values land at out[o…].
function decodeChunk$parquet(bytes, col, out, o = 0) {
  if (col.type === 'BYTE_ARRAY') {
    if (col.repetition !== 'REQUIRED') throw new Error(`parquet: column "${col.name}" is ${col.repetition}, the narrow reader decodes REQUIRED columns only`);
    return decodeStrings(bytes, col, out, o);
  }
  const A = ARRAY$parquet[col.type];
  if (!A) throw new Error(`parquet: column "${col.name}" has type ${col.type}, outside the narrow reader`);
  if (col.repetition !== 'REQUIRED') throw new Error(`parquet: column "${col.name}" is ${col.repetition}, the narrow reader decodes REQUIRED columns only`);
  if (col.codec !== 'UNCOMPRESSED' && col.codec !== 'SNAPPY') throw new Error(`parquet: column "${col.name}" uses codec ${col.codec}`);
  out = out || new A(col.numValues);
  let p = 0, done = 0;
  while (done < col.numValues) {
    const { value: h, end } = decodeStruct(bytes, p);
    const type = h[1], csize = h[3];
    let data = bytes.subarray(end, end + csize);
    p = end + csize;
    let count, encoding;
    if (type === PAGE_DATA) {
      count = h[5][1]; encoding = h[5][2];
      if (col.codec === 'SNAPPY') data = snappyDecompress(data, h[2]);
    } else if (type === PAGE_DATA_V2) {
      const v2 = h[8];
      count = v2[1]; encoding = v2[4];
      if (v2[2]) throw new Error(`parquet: column "${col.name}" has nulls`);
      const lv = (v2[5] || 0) + (v2[6] || 0);
      data = data.subarray(lv);
      if (col.codec === 'SNAPPY' && v2[7] !== false) data = snappyDecompress(data, h[2] - lv);
    } else if (type === PAGE_DICT) {
      throw new Error(`parquet: column "${col.name}" is dictionary-encoded, outside the narrow reader`);
    } else continue; // index pages etc.
    const at = o + done;
    if (encoding === ENC$parquet.DELTA_BINARY_PACKED && col.type === 'INT32') deltaInt32$decode(data, 0, out, at, count);
    else if (encoding === ENC$parquet.BYTE_STREAM_SPLIT) byteStreamSplit$decode(data, 0, out, at, count, col.type);
    else if (encoding === ENC$parquet.PLAIN) plain$decode(data, 0, out, at, count, col.type);
    else throw new Error(`parquet: column "${col.name}" uses ${ENC_NAME[encoding] ?? encoding} for ${col.type}, outside the narrow reader`);
    done += count;
  }
  return out;
}

// ── src/wfr.js ──

// Reading .wfr files: open → manifest + per-element footers → bricks decoded on demand.

const MIMETYPE = 'application/vnd.gentropic.wireframe';
const FORMAT_VERSION = '0.1';
// informative: where this format is described (SPEC §4) — written, never fetched
const SPEC_URL = `https://gentropic.org/wireframe/${FORMAT_VERSION}`;
const td$wfr = new TextDecoder();

// A ranged view of one stored member.
function memberSource(src, offset, size) {
  return { size, read: (off, len) => src.read(offset + off, len) };
}

async function readFooter(ms) {
  let len = Math.min(ms.size, 65536);
  for (;;) {
    const tail = await ms.read(ms.size - len, len);
    const f = parseFooter(tail, ms.size);
    if (!f.need) return f;
    len = f.need;
  }
}

// Open a .wfr from a source ({ size, read }). Reads the zip directory, the manifest, and the
// footers of every element's tables — nothing else.
async function openWfr(src) {
  const zip = await openZip(src);
  const member = async (name) => {
    const e = zip.entries.get(name);
    if (!e) return null;
    if (e.method !== 0) throw new Error(`wfr: member ${name} is compressed (method ${e.method}); .wfr members are stored`);
    const { offset, size } = await zip.dataRange(e);
    return memberSource(src, offset, size);
  };
  const mt = await member('mimetype');
  if (!mt || td$wfr.decode(await mt.read(0, mt.size)) !== MIMETYPE) throw new Error('wfr: not a wireframe file (mimetype)');
  const mm = await member('wireframe.json');
  if (!mm) throw new Error('wfr: missing wireframe.json');
  const manifest = JSON.parse(td$wfr.decode(await mm.read(0, mm.size)));
  if (manifest.format !== 'wireframe') throw new Error('wfr: manifest format is not "wireframe"');
  if (String(manifest.version).split('.')[0] !== '0') throw new Error(`wfr: unsupported version ${manifest.version}`);

  const elements = [];
  for (const el of manifest.elements) {
    const tables = {};
    for (const t of el.kind === 'points' ? ['vertices'] : ['vertices', 'cells']) {
      const ms = await member(el.path + t + '.parquet');
      if (!ms) throw new Error(`wfr: element "${el.name}" lacks ${t}.parquet`);
      tables[t] = { src: ms, footer: await readFooter(ms) };
    }
    const nb = tables.vertices.footer.rowGroups.length;
    if (tables.cells && tables.cells.footer.rowGroups.length !== nb) throw new Error(`wfr: element "${el.name}" breaks the brick invariant (row-group counts differ)`);
    const vStart = new Array(nb + 1); vStart[0] = 0;
    tables.vertices.footer.rowGroups.forEach((rg, k) => { vStart[k + 1] = vStart[k] + rg.numRows; });
    elements.push(new Element(el, tables, vStart));
  }
  return { manifest, elements, element: (name) => elements.find((e) => e.name === name), zip };
}

class Element {
  constructor(el, tables, vStart) {
    Object.assign(this, { meta: el, name: el.name, kind: el.kind, tables, vStart });
    this.bricks = tables.vertices.footer.rowGroups.length;
    const c = el.coords || {};
    this.coords = c;
  }

  // World bbox of brick k from the vertex footer's statistics.
  brickBox(k) {
    const cols = this.tables.vertices.footer.rowGroups[k].columns;
    const g = (n) => cols.find((c) => c.name === n);
    const x = g('x'), y = g('y'), z = g('z');
    if (this.coords.mode === 'float64') return [x.min, y.min, z.min, x.max, y.max, z.max];
    const o = this.coords.origin, s = Array.isArray(this.coords.step) ? this.coords.step : [this.coords.step, this.coords.step, this.coords.step];
    return [o[0] + s[0] * x.min, o[1] + s[1] * y.min, o[2] + s[2] * z.min, o[0] + s[0] * x.max, o[1] + s[1] * y.max, o[2] + s[2] * z.max];
  }

  // Bricks whose bbox intersects the world box [minx, miny, minz, maxx, maxy, maxz].
  bricksIn(box) {
    const out = [];
    for (let k = 0; k < this.bricks; k++) {
      const b = this.brickBox(k);
      if (b[0] <= box[3] && b[3] >= box[0] && b[1] <= box[4] && b[4] >= box[1] && b[2] <= box[5] && b[5] >= box[2]) out.push(k);
    }
    return out;
  }

  // Read the given columns of row group k of a table in one ranged read. → { name: TypedArray }
  async readRowGroup(table, k, names) {
    const t = this.tables[table], rg = t.footer.rowGroups[k];
    const cols = names.map((n) => {
      const c = rg.columns.find((cc) => cc.name === n);
      if (!c) throw new Error(`wfr: ${table} has no column "${n}"`);
      return c;
    });
    const lo = Math.min(...cols.map((c) => c.start)), hi = Math.max(...cols.map((c) => c.start + c.length));
    const bytes = await t.src.read(lo, hi - lo);
    const out = {};
    for (const c of cols) out[c.name] = decodeChunk$parquet(bytes.subarray(c.start - lo, c.start - lo + c.length), c);
    return out;
  }

  // Brick k → { x, y, z (stored units), vid?, cells (brick-LOCAL indices, interleaved) }.
  async readBrick(k, { vid = false } = {}) {
    const v = await this.readRowGroup('vertices', k, vid ? ['x', 'y', 'z', 'vid'] : ['x', 'y', 'z']);
    if (this.kind === 'points') return v;
    const names = this.kind === 'lines' ? ['a', 'b'] : ['a', 'b', 'c'];
    const c = await this.readRowGroup('cells', k, names);
    const m = names.length, n = c.a.length, cells = new Int32Array(n * m), s = this.vStart[k];
    for (let j = 0; j < m; j++) { const col = c[names[j]]; for (let i = 0; i < n; i++) cells[i * m + j] = col[i] - s; }
    return { ...v, cells };
  }
}

// ── src/scratch.js ──

// Scratch storage for the streaming writer: append-only spills of chunks that stay in memory
// while the store is under budget and go to a backing store (temp files, OPFS…) beyond it.
// With no backing, everything stays resident — the in-memory writer is just this with no limit.
//
// backing: { open(name) → Promise<{ write(u8, pos), read(pos, len) → Promise<u8>, close(), remove() }> }

function createScratch({ backing = null, budget = Infinity } = {}) {
  let resident = 0, seq = 0, peakResident = 0, spilledBytes = 0;
  const store = {
    get resident() { return resident; },
    get stats() { return { peakResident, spilledBytes }; },
    budget,
    spill(label = 'spill') {
      const name = `${label}-${seq++}`;
      const chunks = []; // { mem: Uint8Array|null, pos, len }
      let file = null, filePos = 0, bytes = 0, deleted = false;
      return {
        name,
        get bytes() { return bytes; },
        get chunkCount() { return chunks.length; },
        // takes ownership of u8
        async append(u8) {
          if (deleted) throw new Error(`scratch: append to deleted ${name}`);
          bytes += u8.length;
          if (!backing || resident + u8.length <= budget) {
            chunks.push({ mem: u8, pos: 0, len: u8.length });
            resident += u8.length;
            if (resident > peakResident) peakResident = resident;
            return;
          }
          if (!file) file = await backing.open(name);
          await file.write(u8, filePos);
          chunks.push({ mem: null, pos: filePos, len: u8.length });
          filePos += u8.length; spilledBytes += u8.length;
        },
        async *read() {
          for (const c of chunks) yield c.mem ? c.mem : await file.read(c.pos, c.len);
        },
        async readChunk(i) { const c = chunks[i]; return c.mem ? c.mem : file.read(c.pos, c.len); },
        async delete() {
          if (deleted) return;
          deleted = true;
          for (const c of chunks) if (c.mem) resident -= c.len;
          chunks.length = 0;
          if (file) { await file.close(); await file.remove(); file = null; }
        },
      };
    },
  };
  return store;
}

// Browser backing: the Origin Private File System, one file per spill under a fresh directory.
// On the main thread OPFS writes go through a FileSystemWritableFileStream whose data only becomes
// readable once it is closed — so each file closes its writer lazily on the first read and reopens
// it (keeping data) if writing resumes. (A worker could use sync access handles instead.)
async function opfsBacking({ root: rootName = 'wfr-scratch' } = {}) {
  const top = await navigator.storage.getDirectory();
  const base = await top.getDirectoryHandle(rootName, { create: true });
  const dirName = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = await base.getDirectoryHandle(dirName, { create: true });
  return {
    root: `${rootName}/${dirName}`,
    async open(name) {
      const fh = await dir.getFileHandle(name, { create: true });
      let w = null, file = null;
      const writer = async () => { if (!w) { file = null; w = await fh.createWritable({ keepExistingData: true }); } return w; };
      return {
        write: async (u8, pos) => { await (await writer()).write({ type: 'write', position: pos, data: u8 }); },
        read: async (pos, len) => {
          if (w) { await w.close(); w = null; }
          if (!file) file = await fh.getFile();
          return new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
        },
        close: async () => { if (w) { await w.close(); w = null; } },
        remove: async () => { if (w) { try { await w.abort(); } catch { /* already closed */ } w = null; } await dir.removeEntry(name).catch(() => {}); },
      };
    },
    async dispose() { await base.removeEntry(dirName, { recursive: true }).catch(() => {}); },
  };
}

// Leftover scratch from runs that never disposed (a closed tab mid-conversion): remove it all.
async function clearOpfsScratch({ root: rootName = 'wfr-scratch' } = {}) {
  const top = await navigator.storage.getDirectory();
  await top.removeEntry(rootName, { recursive: true }).catch(() => {});
}

// ── src/batch.js ──

// Record batches: struct-of-arrays chunks with a fixed schema, the unit spills hold.
// A chunk is [u32 n][u32 pad] then each field's n·width values, every field 8-byte aligned,
// so a chunk read back into its own ArrayBuffer decodes to zero-copy typed-array views.
//   schema: [{ name, Type, width }]

const align8 = (n) => (n + 7) & ~7;

function chunkSize(schema, n) {
  let s = 8;
  for (const f of schema) s += align8(n * f.width * f.Type.BYTES_PER_ELEMENT);
  return s;
}

function encodeChunk(schema, n, fields) {
  const out = new Uint8Array(chunkSize(schema, n));
  new DataView(out.buffer).setUint32(0, n, true);
  let p = 8;
  for (const f of schema) {
    const len = n * f.width, src = fields[f.name];
    new f.Type(out.buffer, p, len).set(len === src.length ? src : src.subarray(0, len));
    p += align8(len * f.Type.BYTES_PER_ELEMENT);
  }
  return out;
}

// → { n, [name]: TypedArray view }
function decodeChunk$batch(schema, u8) {
  const buf = u8.byteOffset % 8 === 0 ? u8 : u8.slice();
  const n = new DataView(buf.buffer, buf.byteOffset, 8).getUint32(0, true);
  const out = { n };
  let p = buf.byteOffset + 8;
  for (const f of schema) {
    out[f.name] = new f.Type(buf.buffer, p, n * f.width);
    p += align8(n * f.width * f.Type.BYTES_PER_ELEMENT);
  }
  return out;
}

// Accumulates records and flushes full chunks to a spill. Fill pattern (no await per record):
//   while (left) { const k = Math.min(bw.free, left); …write slots bw.n … bw.n+k−1 of bw.f…;
//                  bw.advance(k); left -= k; if (!bw.free) await bw.flush(); }
class BatchWriter {
  constructor(schema, spill, cap = 32768) {
    this.schema = schema; this.spill = spill; this.cap = cap; this.n = 0; this.count = 0;
    this.f = {};
    for (const s of schema) this.f[s.name] = new s.Type(cap * s.width);
  }
  get free() { return this.cap - this.n; }
  advance(k) { this.n += k; this.count += k; }
  async flush() {
    if (!this.n) return;
    await this.spill.append(encodeChunk(this.schema, this.n, this.f));
    this.n = 0;
  }
}

// Read every record of a spill back into one set of contiguous arrays (for a leaf that fits).
async function loadAll(schema, spill, total) {
  const out = { n: total };
  for (const s of schema) out[s.name] = new s.Type(total * s.width);
  let o = 0;
  for await (const u8 of spill.read()) {
    const c = decodeChunk$batch(schema, u8);
    for (const s of schema) out[s.name].set(c[s.name], o * s.width);
    o += c.n;
  }
  if (o !== total) throw new Error(`batch: spill held ${o} records, expected ${total}`);
  return out;
}

// ── src/bytes.js ──

// A growable little-endian byte writer, plus the thrift compact-protocol encoder on top of it.

class ByteWriter {
  constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.dv = new DataView(this.buf.buffer); this.p = 0; }
  ensure(n) {
    if (this.p + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.p + n) cap *= 2;
    const b = new Uint8Array(cap); b.set(this.buf.subarray(0, this.p));
    this.buf = b; this.dv = new DataView(b.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.p++] = v; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.p, v, true); this.p += 4; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.p); this.p += b.length; }
  varint(v) { // unsigned, exact below 2^53
    this.ensure(10);
    while (v >= 128) { this.buf[this.p++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.buf[this.p++] = v;
  }
  zigzag(v) { this.varint(v >= 0 ? v * 2 : -v * 2 - 1); }
  result() { return this.buf.subarray(0, this.p); }
}

// ── thrift compact protocol ────────────────────────────────────────────────────────────────────
// A struct is an array of [fieldId, type, value]; undefined values are skipped.
// Types: 'bool' 'i8' 'i32' 'i64' 'binary' 'string' 'struct' ['list', elemType]
const TT = { bool: 1, i8: 3, i16: 4, i32: 5, i64: 6, double: 7, binary: 8, string: 8, list: 9, struct: 12 };
const te$bytes = new TextEncoder();

function writeValue(w, type, v) {
  if (Array.isArray(type)) { // ['list', elemType]
    const et = type[1], ett = TT[Array.isArray(et) ? 'list' : et];
    if (v.length < 15) w.u8((v.length << 4) | ett); else { w.u8(0xf0 | ett); w.varint(v.length); }
    for (const x of v) {
      if (et === 'bool') w.u8(x ? 1 : 2);
      else writeValue(w, et, x);
    }
    return;
  }
  switch (type) {
    case 'i8': w.u8(v & 255); return;
    case 'i16': case 'i32': case 'i64': w.zigzag(v); return;
    case 'binary': w.varint(v.length); w.bytes(v); return;
    case 'string': { const b = te$bytes.encode(v); w.varint(b.length); w.bytes(b); return; }
    case 'struct': writeStruct(w, v); return;
    default: throw new Error(`thrift write: type ${type}`);
  }
}

function writeStruct(w, fields) {
  let last = 0;
  for (const [fid, type, v] of fields) {
    if (v === undefined || v === null) continue;
    const t = type === 'bool' ? (v ? 1 : 2) : TT[Array.isArray(type) ? 'list' : type];
    const d = fid - last;
    if (d > 0 && d <= 15) w.u8((d << 4) | t); else { w.u8(t); w.zigzag(fid); }
    last = fid;
    if (type !== 'bool') writeValue(w, type, v);
  }
  w.u8(0);
}

// ── src/encode.js ──

// Value encoders, the inverse of decode.js: DELTA_BINARY_PACKED (INT32), BYTE_STREAM_SPLIT, PLAIN.

const words = new Uint32Array(32);
const adj = new Uint32Array(128);

// DELTA_BINARY_PACKED for INT32 values v[from…to). Blocks of 128 values, 4 miniblocks of 32.
// Deltas use int32 wraparound, so every miniblock width is ≤ 32 and the decoder's |0 undoes it.
function deltaInt32$encode(w, v, from, to) {
  const count = to - from;
  w.varint(128); w.varint(4); w.varint(count); w.zigzag(count ? v[from] : 0);
  for (let i = from + 1; i < to; i += 128) {
    const n = Math.min(128, to - i);
    let md = 2147483647;
    for (let j = 0; j < n; j++) { const d = (v[i + j] - v[i + j - 1]) | 0; if (d < md) md = d; adj[j] = d; }
    for (let j = 0; j < n; j++) adj[j] = (adj[j] | 0) - md; // in [0, 2^32): exact in Uint32Array
    w.zigzag(md);
    const nm = Math.ceil(n / 32), widths = [0, 0, 0, 0];
    for (let m = 0; m < nm; m++) {
      let or = 0;
      for (let j = m * 32, e = Math.min(n, j + 32); j < e; j++) or |= adj[j];
      widths[m] = or === 0 ? 0 : 32 - Math.clz32(or);
    }
    w.ensure(4); for (let m = 0; m < 4; m++) w.buf[w.p++] = widths[m];
    for (let m = 0; m < nm; m++) {
      const bw = widths[m];
      if (bw === 0) continue;
      words.fill(0, 0, bw);
      for (let j = 0; j < 32; j++) {
        const idx = m * 32 + j, val = idx < n ? adj[idx] : 0;
        if (val === 0) continue;
        const bit = j * bw, k = bit >>> 5, sh = bit & 31;
        words[k] |= val << sh;
        if (sh + bw > 32) words[k + 1] |= val >>> (32 - sh);
      }
      w.ensure(4 * bw);
      for (let k = 0; k < bw; k++) { w.dv.setUint32(w.p, words[k], true); w.p += 4; }
    }
  }
}

const WIDTH$encode = { INT32: 4, FLOAT: 4, DOUBLE: 8 };

// BYTE_STREAM_SPLIT: stream b holds byte b of every value.
function byteStreamSplit$encode(w, v, from, to, type) {
  const bw = WIDTH$encode[type], count = to - from;
  const src = new Uint8Array(v.buffer, v.byteOffset + from * bw, count * bw);
  w.ensure(count * bw);
  const B = w.buf, p0 = w.p;
  for (let b = 0; b < bw; b++) {
    const s = p0 + b * count;
    for (let i = 0, d = b; i < count; i++, d += bw) B[s + i] = src[d];
  }
  w.p += count * bw;
}

// PLAIN: fixed-width little-endian values, copied.
function plain$encode(w, v, from, to, type) {
  const bw = WIDTH$encode[type];
  w.bytes(new Uint8Array(v.buffer, v.byteOffset + from * bw, (to - from) * bw));
}

// ── src/parquet-write.js ──

// The narrow Parquet writer: flat schema, REQUIRED columns, row groups streamed to a sink as
// they're produced, one V1 data page per column chunk, UNCOMPRESSED, per-chunk min/max
// statistics with TypeDefinedOrder declared (so stock readers trust min_value/max_value).
// Numeric columns: DELTA_BINARY_PACKED / BYTE_STREAM_SPLIT / PLAIN. String columns: per-chunk
// dictionary (RLE_DICTIONARY), fed as int codes into a label table.

const TYPE = { INT32: 1, INT64: 2, FLOAT: 4, DOUBLE: 5, STRING: 6 };
const ENC$parquet_write = { PLAIN: 0, RLE: 3, DELTA_BINARY_PACKED: 5, RLE_DICTIONARY: 8, BYTE_STREAM_SPLIT: 9 };
const ARRAY$parquet_write = { INT32: Int32Array, FLOAT: Float32Array, DOUBLE: Float64Array, STRING: Int32Array };
// logical integer types carried on INT32: name → [converted_type, bitWidth, signed]
const INT_LOGICAL = { UINT8: [11, 8, false], UINT16: [12, 16, false], INT8: [15, 8, true], INT16: [16, 16, true] };
const MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
const te$parquet_write = new TextEncoder();

function statBytes(type, v) {
  const b = new Uint8Array(type === 'DOUBLE' ? 8 : 4), dv = new DataView(b.buffer);
  if (type === 'INT32') dv.setInt32(0, v, true);
  else if (type === 'FLOAT') dv.setFloat32(0, v, true);
  else dv.setFloat64(0, v, true);
  return b;
}
function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// RLE/bit-packed hybrid for dictionary indices: one RLE run when constant, else bit-packed groups of 8.
function hybrid(w, idx, n, bw) {
  w.u8(bw);
  if (n === 0) return;
  let same = true;
  for (let i = 1; i < n; i++) if (idx[i] !== idx[0]) { same = false; break; }
  if (same) {
    w.varint(n * 2);
    for (let b = 0, v = idx[0]; b < Math.ceil(bw / 8); b++, v >>>= 8) w.u8(v & 255);
    return;
  }
  const groups = Math.ceil(n / 8);
  w.varint(groups * 2 + 1);
  w.ensure(groups * bw);
  let acc = 0, bits = 0;
  for (let i = 0; i < groups * 8; i++) {
    const v = i < n ? idx[i] : 0;
    acc += v * 2 ** bits; bits += bw;
    while (bits >= 8) { w.buf[w.p++] = acc % 256; acc = Math.floor(acc / 256); bits -= 8; }
  }
}

// columns: [{ name, type: 'INT32'|'FLOAT'|'DOUBLE'|'STRING', encoding?, logical?, labels? (STRING) }]
// sink: { write(Uint8Array) → void|Promise } — receives the bytes in file order.
class ParquetStream {
  constructor(sink, columns, { kv = {}, createdBy = '@gcu/wireframe' } = {}) {
    for (const c of columns) {
      if (!ARRAY$parquet_write[c.type]) throw new Error(`parquet write: column "${c.name}" type ${c.type} unsupported`);
      if (c.type === 'STRING') { c.encoding = 'RLE_DICTIONARY'; if (!c.labels) throw new Error(`parquet write: string column "${c.name}" needs labels`); }
      if (ENC$parquet_write[c.encoding] === undefined) throw new Error(`parquet write: encoding ${c.encoding}`);
      if (c.encoding === 'DELTA_BINARY_PACKED' && c.type !== 'INT32') throw new Error(`parquet write: delta needs INT32 ("${c.name}")`);
      if (c.logical && !INT_LOGICAL[c.logical]) throw new Error(`parquet write: logical type ${c.logical}`);
    }
    Object.assign(this, { sink, columns, kv, createdBy, offset: 0, rows: 0, rgMeta: [], page: new ByteWriter(1 << 16), started: false });
    this.labelBytes = columns.map((c) => (c.type === 'STRING' ? c.labels.map((s) => te$parquet_write.encode(s)) : null));
  }
  async put(b) { await this.sink.write(b); this.offset += b.length; }

  // data: { name: typed array (≥ from+count) }; writes rows [from, from+count) of each column
  async writeRowGroup(data, count, from = 0) {
    if (!this.started) { this.started = true; await this.put(MAGIC); }
    const chunks = [], rgStart = this.offset;
    const w = new ByteWriter(1 << 16);
    for (let ci = 0; ci < this.columns.length; ci++) {
      const c = this.columns[ci], v = data[c.name];
      if (!v) throw new Error(`parquet write: row group lacks column "${c.name}"`);
      if (!(v instanceof ARRAY$parquet_write[c.type])) throw new Error(`parquet write: column "${c.name}" data must be ${ARRAY$parquet_write[c.type].name}`);
      if (v.length < from + count) throw new Error(`parquet write: column "${c.name}" is short`);
      const page = this.page; page.p = 0;
      w.p = 0;
      const start = this.offset;
      let dictOffset, stats;
      if (c.type === 'STRING') {
        // per-chunk dictionary of the codes used here
        const lb = this.labelBytes[ci], local = new Map(), order = [], idx = new Int32Array(count);
        for (let i = 0; i < count; i++) {
          const code = v[from + i];
          let j = local.get(code);
          if (j === undefined) { j = order.length; local.set(code, j); order.push(code); }
          idx[i] = j;
        }
        const dict = new ByteWriter(1 << 12);
        let mn = null, mx = null;
        for (const code of order) {
          const b = lb[code]; dict.u32(b.length); dict.bytes(b);
          if (!mn || cmpBytes(b, mn) < 0) mn = b;
          if (!mx || cmpBytes(b, mx) > 0) mx = b;
        }
        dictOffset = start;
        writeStruct(w, [[1, 'i32', 2], [2, 'i32', dict.p], [3, 'i32', dict.p], [7, 'struct', [[1, 'i32', order.length], [2, 'i32', ENC$parquet_write.PLAIN]]]]);
        w.bytes(dict.result());
        const bw = order.length <= 1 ? 0 : 32 - Math.clz32(order.length - 1);
        hybrid(page, idx, count, bw);
        stats = count ? [[3, 'i64', 0], [5, 'binary', mx], [6, 'binary', mn]] : [[3, 'i64', 0]];
      } else {
        if (c.encoding === 'DELTA_BINARY_PACKED') deltaInt32$encode(page, v, from, from + count);
        else if (c.encoding === 'BYTE_STREAM_SPLIT') byteStreamSplit$encode(page, v, from, from + count, c.type);
        else plain$encode(page, v, from, from + count, c.type);
        let mn = Infinity, mx = -Infinity;
        for (let i = from, e = from + count; i < e; i++) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x; }
        stats = count ? [[3, 'i64', 0], [5, 'binary', statBytes(c.type, mx)], [6, 'binary', statBytes(c.type, mn)]] : [[3, 'i64', 0]];
      }
      const dataOffset = start + w.p;
      writeStruct(w, [
        [1, 'i32', 0], [2, 'i32', page.p], [3, 'i32', page.p],
        [5, 'struct', [[1, 'i32', count], [2, 'i32', ENC$parquet_write[c.encoding]], [3, 'i32', ENC$parquet_write.RLE], [4, 'i32', ENC$parquet_write.RLE]]],
      ]);
      w.bytes(page.result());
      await this.put(w.result().slice());
      const size = this.offset - start;
      const encs = c.type === 'STRING' ? [ENC$parquet_write.PLAIN, ENC$parquet_write.RLE_DICTIONARY, ENC$parquet_write.RLE] : [ENC$parquet_write[c.encoding]];
      chunks.push([
        [2, 'i64', start],
        [3, 'struct', [
          [1, 'i32', TYPE[c.type]], [2, ['list', 'i32'], encs], [3, ['list', 'string'], [c.name]],
          [4, 'i32', 0], [5, 'i64', count], [6, 'i64', size], [7, 'i64', size], [9, 'i64', dataOffset],
          [11, 'i64', dictOffset], [12, 'struct', stats],
        ]],
      ]);
    }
    this.rgMeta.push([[1, ['list', 'struct'], chunks], [2, 'i64', this.offset - rgStart], [3, 'i64', count], [5, 'i64', rgStart], [6, 'i64', this.offset - rgStart]]);
    this.rows += count;
  }

  async finish() {
    if (!this.started) { this.started = true; await this.put(MAGIC); }
    const schema = [[[4, 'string', 'schema'], [5, 'i32', this.columns.length]]];
    for (const c of this.columns) {
      const e = [[1, 'i32', TYPE[c.type]], [3, 'i32', 0], [4, 'string', c.name]];
      const lg = c.logical && INT_LOGICAL[c.logical];
      if (lg) e.push([6, 'i32', lg[0]], [10, 'struct', [[10, 'struct', [[1, 'i8', lg[1]], [2, 'bool', lg[2]]]]]]);
      if (c.type === 'STRING') e.push([6, 'i32', 0], [10, 'struct', [[1, 'struct', []]]]);
      schema.push(e);
    }
    const w = new ByteWriter(1 << 16);
    writeStruct(w, [
      [1, 'i32', 2], [2, ['list', 'struct'], schema], [3, 'i64', this.rows], [4, ['list', 'struct'], this.rgMeta],
      [5, ['list', 'struct'], Object.entries(this.kv).map(([k, v]) => [[1, 'string', k], [2, 'string', v]])],
      [6, 'string', this.createdBy],
      [7, ['list', 'struct'], this.columns.map(() => [[1, 'struct', []]])], // ColumnOrder: TYPE_ORDER
    ]);
    const len = w.p;
    w.u32(len); w.bytes(MAGIC);
    await this.put(w.result().slice());
  }
}

// Whole-table convenience (tests, small tables): columns carry their own data.
function writeParquet({ columns, rowGroups, kv = {}, createdBy }) {
  const parts = [];
  const ps = new ParquetStream({ write: (b) => { parts.push(b); } }, columns.map(({ data, ...c }) => c), { kv, createdBy });
  const data = Object.fromEntries(columns.map((c) => [c.name, c.data]));
  const n = columns.length ? columns[0].data.length : 0;
  if (rowGroups.reduce((s, x) => s + x, 0) !== n) throw new Error('parquet write: row groups do not sum to the row count');
  let from = 0;
  // ParquetStream is async only through the sink; with a sync sink the promises resolve in order
  const run = (async () => { for (const c of rowGroups) { await ps.writeRowGroup(data, c, from); from += c; } await ps.finish(); })();
  return run.then(() => { const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0)); let o = 0; for (const b of parts) { out.set(b, o); o += b.length; } return out; });
}

// ── src/pipeline.js ──

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
      const c = decodeChunk$batch(schema, u8); c._bytes = u8.length; c._i = i; c._t = ++tick;
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
    for await (const u8 of spill.read()) { const c = decodeChunk$batch(schema, u8.byteOffset % 8 ? u8.slice() : u8); await onLeaf(slice(schema, c, 0, c.n), true); }
    await spill.delete();
    return;
  }
  let w = 1; while ((hi - lo) / w > NB) w *= 2;
  const nbins = Math.ceil((hi - lo) / w);
  if (!hist || hist.w !== w || hist.lo !== lo) {
    hist = { w, lo, c: new Float64Array(nbins) };
    for await (const u8 of spill.read()) { const c = decodeChunk$batch(schema, u8); const k = c.key; for (let i = 0; i < c.n; i++) hist.c[Math.floor((k[i] - lo) / w)]++; }
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
    const c = decodeChunk$batch(schema, u8), k = c.key, n = c.n;
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
function createElementWriter(spec, ctx) {
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
        for await (const u8 of src.spill.read()) { const c = decodeChunk$batch(src.schema, u8), a = c[gField]; for (let i = 0; i < c.n; i++) vals.add(a[i]); }
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
        const c = decodeChunk$batch(src.schema, u8);
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

    async function emitBrick(rec, s, e) {
      local.clear();
      const nc = e - s, cap = mode === 'points' ? nc : nc * k;
      const X = new CT(cap), Y = new CT(cap), Z = new CT(cap), VID = new Int32Array(cap);
      const vat = vNames.map((n) => new ATTR[vA[n]](cap));
      const cells = ccols ? CELL_COLS[spec.kind].map(() => new Int32Array(nc)) : null;
      let rows = 0, miss = null;
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
          for (let j = 0; j < k; j++) {
            const pi = (i * k + j) * 3, x = rec.p[pi], y = rec.p[pi + 1], z = rec.p[pi + 2];
            let vid, wt = null, wr = 0;
            if (mode === 'indexed') vid = rank(rec.src[i * k + j]);
            else if (mode === 'soup') {
              const kk = key48(x, y, z), L = leafFor(kk);
              wt = ucache.get(L.chunk); wr = weldIn(wt, L, kk, x, y, z); vid = L.vidStart + wr;
            } else vid = rec.src[i];
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
            if (cells) cells[j][i - s] = rowBase + row;
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
      const vdata = { x: X, y: Y, z: Z, vid: VID };
      vNames.forEach((n, q) => { vdata[n] = toPQ(vat[q], vA[n]); });
      await vps.writeRowGroup(vdata, rows);
      if (cells) {
        const cdata = Object.fromEntries(CELL_COLS[spec.kind].map((n, j) => [n, cells[j]]));
        for (const n of cNames) cdata[n] = toPQ(rec['C:' + n].subarray(s, e), cA[n]);
        await cps.writeRowGroup(cdata, nc);
      }
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], C = [X, Y, Z];
      for (let a = 0; a < 3; a++) { const A = C[a]; for (let r = 0; r < rows; r++) { const q = A[r]; if (q < b[a]) b[a] = q; if (q > b[a + 3]) b[a + 3] = q; } }
      directory.push([rows, ccols ? nc : 0, b.map((q, i) => toWorld(q, i % 3))]);
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
      counts: { vertices: V, vertexRows: rowBase, cells: spec.kind === 'points' ? 0 : m, bricks: brickCount },
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

// ── src/write.js ──

// Writing .wfr files. Everything goes through the streaming pipeline (pipeline.js); the memory
// budget decides how much of it stays resident, and the output does not depend on the budget.

const te$write = new TextEncoder();
const BLOCK = 16 * 1024 * 1024;

// The attribute type of a typed array (or a JS array of strings).
function attrType(a) {
  if (a instanceof Float64Array) return 'f64';
  if (a instanceof Float32Array) return 'f32';
  if (a instanceof Int32Array) return 'i32';
  if (a instanceof Uint8Array || a instanceof Uint8ClampedArray) return 'u8';
  if (a instanceof Uint16Array) return 'u16';
  if (a instanceof Int8Array) return 'i8';
  if (a instanceof Int16Array) return 'i16';
  if (Array.isArray(a)) return 'string';
  throw new Error(`wfr write: unsupported attribute array ${a?.constructor?.name}`);
}

/**
 * createWfrWriter(sink, opts) → { element(spec) → ElementWriter, finish({ frame, meta }) → { size, manifest } }
 *   sink: { write(Uint8Array) → void|Promise }
 *   opts: { budget = Infinity (bytes kept resident), backing (scratch files beyond the budget),
 *           scratch (a ready store; overrides budget/backing) }
 * Elements are pushed in any order while the source streams (pass 1); finish() runs the
 * remaining passes element by element and writes the archive.
 */
function createWfrWriter(sink, { budget = Infinity, backing = null, scratch = null } = {}) {
  const store = scratch || createScratch({ backing, budget: backing ? budget / 2 : Infinity });
  const ctx = { scratch: store, leafBytes: Number.isFinite(budget) ? budget / 4 : Infinity, cacheBytes: Number.isFinite(budget) ? budget / 8 : Infinity };
  const writers = [];
  return {
    ctx,
    names: () => writers.map((w) => w.name), // element names claimed so far (callers de-duplicate with it)
    element(spec) {
      if (!spec.name) throw new Error('wfr write: element without a name');
      if (writers.some((w) => w.name === spec.name)) throw new Error(`wfr write: duplicate element "${spec.name}"`);
      const w = createElementWriter(spec, ctx);
      writers.push(w);
      return w;
    },
    async finish({ frame = null, meta = {} } = {}) {
      const zw = createZipWriter(sink);
      await zw.add('mimetype', te$write.encode(MIMETYPE), { aligned: false, hash: false });
      const members = {}, elements = [];
      for (const w of writers) {
        const { manifest, members: mem } = await w.end(zw);
        for (const [name, info] of Object.entries(mem)) members[name] = { size: info.size, block: BLOCK, sha256: info.sha256 };
        elements.push(manifest);
      }
      const f = frame || { origin: elements.find((e) => e.coords.origin)?.coords.origin || [0, 0, 0] };
      const manifest = { format: 'wireframe', version: FORMAT_VERSION, spec: SPEC_URL, frame: { crs: null, units: 'm', ...f }, elements, members, meta };
      await zw.add('wireframe.json', te$write.encode(JSON.stringify(manifest)), { hash: false });
      const { size } = await zw.finish();
      return { size, manifest, stats: store.stats };
    },
  };
}

/**
 * writeWfr(sink, { elements, frame, meta }, opts) — whole elements given as arrays:
 *   { name, kind, positions: Float64Array(3n), cells?: (k per cell), vertexAttributes?: { name: array },
 *     cellAttributes?: { name: array }, coords?, topology?: 'check'|{…}, brickBy?, target?, keepVid?, meta? }
 * opts as createWfrWriter (default: everything in memory).
 */
async function writeWfr(sink, { elements, frame = null, meta = {} }, opts = {}) {
  const wr = createWfrWriter(sink, opts);
  for (const el of elements) {
    const vAttrs = el.vertexAttributes || {}, cAttrs = el.cellAttributes || {};
    const types = (o) => Object.fromEntries(Object.entries(o).map(([n, a]) => [n, attrType(a)]));
    const w = wr.element({ ...el, vertexAttributes: types(vAttrs), cellAttributes: types(cAttrs) });
    if (el.kind === 'points') await w.points(el.positions, vAttrs);
    else { await w.vertices(el.positions, vAttrs); await w.cells(el.cells, cAttrs); }
  }
  return wr.finish({ frame, meta });
}

// ── src/topology.js ──

// Topology of a triangle element, checked against the faces (SPEC §7.3). Edges compare by
// vertex identity (the input vertex index = vid), so the answer holds across bricks.
//   closed   — every edge is shared by exactly two faces
//   oriented — every edge shared by two faces is traversed in opposite directions by them
//   manifold — the faces around every vertex form a single fan
//   volume   — signed enclosed volume (outward-oriented → positive), when closed and oriented

function checkTopology(V, F) {
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

// ── src/index.js ──

// @gcu/wireframe — browser-safe entry (no node: imports). Node adds src/node.js (nodeBacking).

export {
  openWfr,
  MIMETYPE,
  FORMAT_VERSION,
  SPEC_URL,
  writeWfr,
  createWfrWriter,
  attrType,
  createScratch,
  opfsBacking,
  clearOpfsScratch,
  checkTopology,
  openZip,
  createZipWriter,
  bytesSource,
  blobSource,
  crc32,
  parseFooter,
  decodeChunk$parquet as decodeChunk,
  writeParquet,
  ParquetStream,
};
