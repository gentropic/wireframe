// Snappy raw-format decompression (no framing), as used by Parquet pages.
export function snappyDecompress(src, outLen) {
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
