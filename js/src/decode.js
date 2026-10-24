// Value decoders for the encodings the core columns may use (SPEC §11):
// DELTA_BINARY_PACKED (INT32), BYTE_STREAM_SPLIT (DOUBLE/FLOAT/INT32), PLAIN (INT32/DOUBLE/FLOAT).
import { readVarint, zigzag } from './thrift.js';
import { DELTA32 } from './unpack.gen.js';

const scratch = new Int32Array(32);

// DELTA_BINARY_PACKED → Int32Array. B: page data bytes, from p. Writes `count` values to out[o…].
// Returns the byte position after the encoded run.
export function deltaInt32(B, p, out, o, count) {
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

const WIDTH = { INT32: 4, FLOAT: 4, INT64: 8, DOUBLE: 8 };

// BYTE_STREAM_SPLIT: stream b holds byte b of every value. out is a typed array of the column's type.
export function byteStreamSplit(B, p, out, o, count, type) {
  const w = WIDTH[type];
  const dst = new Uint8Array(out.buffer, out.byteOffset + o * w, count * w);
  for (let b = 0; b < w; b++) {
    const s = p + b * count;
    for (let i = 0, d = b; i < count; i++, d += w) dst[d] = B[s + i];
  }
  return p + count * w;
}

// PLAIN fixed-width little-endian values.
export function plain(B, p, out, o, count, type) {
  const w = WIDTH[type];
  new Uint8Array(out.buffer, out.byteOffset + o * w, count * w).set(B.subarray(p, p + count * w));
  return p + count * w;
}
