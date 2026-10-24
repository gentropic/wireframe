// The narrow Parquet writer: flat schema, REQUIRED columns, row groups streamed to a sink as
// they're produced, one V1 data page per column chunk, UNCOMPRESSED, per-chunk min/max
// statistics with TypeDefinedOrder declared (so stock readers trust min_value/max_value).
// Numeric columns: DELTA_BINARY_PACKED / BYTE_STREAM_SPLIT / PLAIN. String columns: per-chunk
// dictionary (RLE_DICTIONARY), fed as int codes into a label table.
import { ByteWriter, writeStruct } from './bytes.js';
import { deltaInt32, byteStreamSplit, plain } from './encode.js';

const TYPE = { INT32: 1, INT64: 2, FLOAT: 4, DOUBLE: 5, STRING: 6 };
const ENC = { PLAIN: 0, RLE: 3, DELTA_BINARY_PACKED: 5, RLE_DICTIONARY: 8, BYTE_STREAM_SPLIT: 9 };
const ARRAY = { INT32: Int32Array, FLOAT: Float32Array, DOUBLE: Float64Array, STRING: Int32Array };
// logical integer types carried on INT32: name → [converted_type, bitWidth, signed]
const INT_LOGICAL = { UINT8: [11, 8, false], UINT16: [12, 16, false], INT8: [15, 8, true], INT16: [16, 16, true] };
const MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
const te = new TextEncoder();

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
export class ParquetStream {
  constructor(sink, columns, { kv = {}, createdBy = '@gcu/wireframe' } = {}) {
    for (const c of columns) {
      if (!ARRAY[c.type]) throw new Error(`parquet write: column "${c.name}" type ${c.type} unsupported`);
      if (c.type === 'STRING') { c.encoding = 'RLE_DICTIONARY'; if (!c.labels) throw new Error(`parquet write: string column "${c.name}" needs labels`); }
      if (ENC[c.encoding] === undefined) throw new Error(`parquet write: encoding ${c.encoding}`);
      if (c.encoding === 'DELTA_BINARY_PACKED' && c.type !== 'INT32') throw new Error(`parquet write: delta needs INT32 ("${c.name}")`);
      if (c.logical && !INT_LOGICAL[c.logical]) throw new Error(`parquet write: logical type ${c.logical}`);
    }
    Object.assign(this, { sink, columns, kv, createdBy, offset: 0, rows: 0, rgMeta: [], page: new ByteWriter(1 << 16), started: false });
    this.labelBytes = columns.map((c) => (c.type === 'STRING' ? c.labels.map((s) => te.encode(s)) : null));
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
      if (!(v instanceof ARRAY[c.type])) throw new Error(`parquet write: column "${c.name}" data must be ${ARRAY[c.type].name}`);
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
        writeStruct(w, [[1, 'i32', 2], [2, 'i32', dict.p], [3, 'i32', dict.p], [7, 'struct', [[1, 'i32', order.length], [2, 'i32', ENC.PLAIN]]]]);
        w.bytes(dict.result());
        const bw = order.length <= 1 ? 0 : 32 - Math.clz32(order.length - 1);
        hybrid(page, idx, count, bw);
        stats = count ? [[3, 'i64', 0], [5, 'binary', mx], [6, 'binary', mn]] : [[3, 'i64', 0]];
      } else {
        if (c.encoding === 'DELTA_BINARY_PACKED') deltaInt32(page, v, from, from + count);
        else if (c.encoding === 'BYTE_STREAM_SPLIT') byteStreamSplit(page, v, from, from + count, c.type);
        else plain(page, v, from, from + count, c.type);
        let mn = Infinity, mx = -Infinity;
        for (let i = from, e = from + count; i < e; i++) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x; }
        stats = count ? [[3, 'i64', 0], [5, 'binary', statBytes(c.type, mx)], [6, 'binary', statBytes(c.type, mn)]] : [[3, 'i64', 0]];
      }
      const dataOffset = start + w.p;
      writeStruct(w, [
        [1, 'i32', 0], [2, 'i32', page.p], [3, 'i32', page.p],
        [5, 'struct', [[1, 'i32', count], [2, 'i32', ENC[c.encoding]], [3, 'i32', ENC.RLE], [4, 'i32', ENC.RLE]]],
      ]);
      w.bytes(page.result());
      await this.put(w.result().slice());
      const size = this.offset - start;
      const encs = c.type === 'STRING' ? [ENC.PLAIN, ENC.RLE_DICTIONARY, ENC.RLE] : [ENC[c.encoding]];
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
export function writeParquet({ columns, rowGroups, kv = {}, createdBy }) {
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
