// Record batches: struct-of-arrays chunks with a fixed schema, the unit spills hold.
// A chunk is [u32 n][u32 pad] then each field's n·width values, every field 8-byte aligned,
// so a chunk read back into its own ArrayBuffer decodes to zero-copy typed-array views.
//   schema: [{ name, Type, width }]

const align8 = (n) => (n + 7) & ~7;

export function chunkSize(schema, n) {
  let s = 8;
  for (const f of schema) s += align8(n * f.width * f.Type.BYTES_PER_ELEMENT);
  return s;
}

export function encodeChunk(schema, n, fields) {
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
export function decodeChunk(schema, u8) {
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
export class BatchWriter {
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
export async function loadAll(schema, spill, total) {
  const out = { n: total };
  for (const s of schema) out[s.name] = new s.Type(total * s.width);
  let o = 0;
  for await (const u8 of spill.read()) {
    const c = decodeChunk(schema, u8);
    for (const s of schema) out[s.name].set(c[s.name], o * s.width);
    o += c.n;
  }
  if (o !== total) throw new Error(`batch: spill held ${o} records, expected ${total}`);
  return out;
}
