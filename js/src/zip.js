// ZIP for .wfr: a ranged reader (central directory → member byte ranges, nothing read whole)
// and a STORED-only streaming writer with Zip64 and 64-byte data alignment (SPEC §3).

// ── sources: { size, read(offset, length) → Promise<Uint8Array> } ──────────────────────────────
export function bytesSource(u8) {
  return { size: u8.length, read: async (off, len) => u8.subarray(off, off + len) };
}
export function blobSource(blob) {
  return { size: blob.size, read: async (off, len) => new Uint8Array(await blob.slice(off, off + len).arrayBuffer()) };
}

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u64 = (b, p) => u32(b, p) + u32(b, p + 4) * 4294967296;
const td = new TextDecoder();

// ── reader ─────────────────────────────────────────────────────────────────────────────────────
// → { entries: Map(name → { name, method, crc, size, localOffset }), dataRange(entry) → Promise<{offset,size}> }
export async function openZip(src) {
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
    const name = td.decode(cd.subarray(p + 46, p + 46 + nlen));
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
export function crc32(b, crc = 0) {
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
const te = new TextEncoder();
const MAX32 = 0xffffffff;
function le(view, p, v, bytes) { for (let i = 0; i < bytes; i++) { view[p + i] = v % 256; v = Math.floor(v / 256); } }

export function createZipWriter(sink, { align = 64 } = {}) {
  let offset = 0;
  const cd = [];
  const put = async (b) => { await sink.write(b); offset += b.length; };
  return {
    get offset() { return offset; },
    async add(name, data, { aligned = true } = {}) {
      const nameB = te.encode(name), size = data.length, crc = crc32(data);
      const big = size >= MAX32;
      const z64 = big ? 20 : 0; // id, len, usize, csize
      let pad = 0;
      if (aligned && align > 1) {
        const base = offset + 30 + nameB.length + z64 + 6; // + 0xD935 record header (4) + alignment (2)
        pad = (align - (base % align)) % align;
      }
      const elen = z64 + (aligned && align > 1 ? 6 + pad : 0);
      const h = new Uint8Array(30 + nameB.length + elen);
      le(h, 0, 0x04034b50, 4); le(h, 4, big ? 45 : 20, 2); le(h, 6, 0x0800, 2); le(h, 8, 0, 2);
      le(h, 10, 0, 2); le(h, 12, 0x21, 2); le(h, 14, crc, 4);
      le(h, 18, big ? MAX32 : size, 4); le(h, 22, big ? MAX32 : size, 4);
      le(h, 26, nameB.length, 2); le(h, 28, elen, 2); h.set(nameB, 30);
      let x = 30 + nameB.length;
      if (big) { le(h, x, 1, 2); le(h, x + 2, 16, 2); le(h, x + 4, size, 8); le(h, x + 12, size, 8); x += 20; }
      if (aligned && align > 1) { le(h, x, 0xd935, 2); le(h, x + 2, 2 + pad, 2); le(h, x + 4, align, 2); }
      const localOffset = offset;
      await put(h);
      await put(data);
      cd.push({ nameB, size, crc, localOffset });
    },
    async finish() {
      const cdStart = offset;
      for (const e of cd) {
        const needSize = e.size >= MAX32, needOff = e.localOffset >= MAX32;
        const z = (needSize ? 16 : 0) + (needOff ? 8 : 0);
        const elen = z ? 4 + z : 0;
        const h = new Uint8Array(46 + e.nameB.length + elen);
        le(h, 0, 0x02014b50, 4); le(h, 4, 45, 2); le(h, 6, z ? 45 : 20, 2); le(h, 8, 0x0800, 2); le(h, 10, 0, 2);
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
