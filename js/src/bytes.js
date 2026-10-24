// A growable little-endian byte writer, plus the thrift compact-protocol encoder on top of it.

export class ByteWriter {
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
const te = new TextEncoder();

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
    case 'string': { const b = te.encode(v); w.varint(b.length); w.bytes(b); return; }
    case 'struct': writeStruct(w, v); return;
    default: throw new Error(`thrift write: type ${type}`);
  }
}

export function writeStruct(w, fields) {
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
