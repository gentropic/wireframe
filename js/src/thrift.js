// Thrift compact protocol — just enough to read Parquet footers and page headers.
// A struct decodes to a plain object keyed by field id: { 1: …, 4: […] }.

const T_TRUE = 1, T_FALSE = 2, T_BYTE = 3, T_I16 = 4, T_I32 = 5, T_I64 = 6, T_DOUBLE = 7,
  T_BINARY = 8, T_LIST = 9, T_SET = 10, T_MAP = 11, T_STRUCT = 12;

// Unsigned varint as a Number (exact below 2^53, which covers every Parquet offset and count).
export function readVarint(r) {
  const B = r.b;
  let x = 0, mul = 1, byte;
  do { byte = B[r.p++]; x += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
  return x;
}
export function zigzag(n) { return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }
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

export function readStruct(r) {
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
export function decodeStruct(bytes, offset = 0) {
  const r = { b: bytes, p: offset };
  const value = readStruct(r);
  return { value, end: r.p };
}
