// Value encoders, the inverse of decode.js: DELTA_BINARY_PACKED (INT32), BYTE_STREAM_SPLIT, PLAIN.

const words = new Uint32Array(32);
const adj = new Uint32Array(128);

// DELTA_BINARY_PACKED for INT32 values v[from…to). Blocks of 128 values, 4 miniblocks of 32.
// Deltas use int32 wraparound, so every miniblock width is ≤ 32 and the decoder's |0 undoes it.
export function deltaInt32(w, v, from, to) {
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

const WIDTH = { INT32: 4, FLOAT: 4, DOUBLE: 8 };

// BYTE_STREAM_SPLIT: stream b holds byte b of every value.
export function byteStreamSplit(w, v, from, to, type) {
  const bw = WIDTH[type], count = to - from;
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
export function plain(w, v, from, to, type) {
  const bw = WIDTH[type];
  w.bytes(new Uint8Array(v.buffer, v.byteOffset + from * bw, (to - from) * bw));
}
