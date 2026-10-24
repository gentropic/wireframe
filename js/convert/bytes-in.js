// Pull-style reading over an async iterable of byte chunks (a file stream, a Blob's stream()).
export class ChunkReader {
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
export async function* lines(chunks) {
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
