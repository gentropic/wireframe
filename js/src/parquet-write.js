// The narrow Parquet writer: flat schema, REQUIRED columns, one V1 data page per column chunk,
// UNCOMPRESSED, per-chunk min/max statistics with TypeDefinedOrder declared (so stock readers
// trust min_value/max_value), key–value metadata.
import { ByteWriter, writeStruct } from './bytes.js';
import { deltaInt32, byteStreamSplit, plain } from './encode.js';

const TYPE = { INT32: 1, INT64: 2, FLOAT: 4, DOUBLE: 5 };
const ENC = { PLAIN: 0, DELTA_BINARY_PACKED: 5, BYTE_STREAM_SPLIT: 9 };
const ARRAY = { INT32: Int32Array, FLOAT: Float32Array, DOUBLE: Float64Array };
const RLE = 3;
// logical integer types carried on INT32: name → [converted_type, bitWidth, signed]
const INT_LOGICAL = { UINT8: [11, 8, false], UINT16: [12, 16, false], INT8: [15, 8, true], INT16: [16, 16, true] };

function statBytes(type, v) {
  const b = new Uint8Array(type === 'DOUBLE' ? 8 : 4), dv = new DataView(b.buffer);
  if (type === 'INT32') dv.setInt32(0, v, true);
  else if (type === 'FLOAT') dv.setFloat32(0, v, true);
  else dv.setFloat64(0, v, true);
  return b;
}

// columns: [{ name, type: 'INT32'|'FLOAT'|'DOUBLE', encoding, data: typed array of ARRAY[type], logical?: 'UINT8'… }]
// rowGroups: row counts per group (sum = data length). kv: { key: string }.
export function writeParquet({ columns, rowGroups, kv = {}, createdBy = '@gcu/wireframe' }) {
  const n = columns.length ? columns[0].data.length : 0;
  for (const c of columns) {
    if (!ARRAY[c.type]) throw new Error(`parquet write: column "${c.name}" type ${c.type} unsupported`);
    if (!(c.data instanceof ARRAY[c.type])) throw new Error(`parquet write: column "${c.name}" data must be ${ARRAY[c.type].name}`);
    if (c.data.length !== n) throw new Error(`parquet write: column "${c.name}" has ${c.data.length} rows, expected ${n}`);
    if (ENC[c.encoding] === undefined) throw new Error(`parquet write: encoding ${c.encoding}`);
    if (c.encoding === 'DELTA_BINARY_PACKED' && c.type !== 'INT32') throw new Error(`parquet write: delta needs INT32 ("${c.name}")`);
  }
  if (rowGroups.reduce((s, x) => s + x, 0) !== n) throw new Error('parquet write: row groups do not sum to the row count');

  const w = new ByteWriter(Math.max(1 << 16, n * columns.length * 2));
  w.bytes(new Uint8Array([0x50, 0x41, 0x52, 0x31]));
  const page = new ByteWriter(1 << 16);
  const rgMeta = [];
  let row = 0;
  for (const count of rowGroups) {
    const chunks = [];
    const rgStart = w.p;
    for (const c of columns) {
      page.p = 0;
      if (c.encoding === 'DELTA_BINARY_PACKED') deltaInt32(page, c.data, row, row + count);
      else if (c.encoding === 'BYTE_STREAM_SPLIT') byteStreamSplit(page, c.data, row, row + count, c.type);
      else plain(page, c.data, row, row + count, c.type);
      let mn = Infinity, mx = -Infinity;
      for (let i = row, e = row + count; i < e; i++) { const v = c.data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      const start = w.p;
      writeStruct(w, [
        [1, 'i32', 0], [2, 'i32', page.p], [3, 'i32', page.p],
        [5, 'struct', [[1, 'i32', count], [2, 'i32', ENC[c.encoding]], [3, 'i32', RLE], [4, 'i32', RLE]]],
      ]);
      w.bytes(page.result());
      const size = w.p - start;
      const stats = count ? [[3, 'i64', 0], [5, 'binary', statBytes(c.type, mx)], [6, 'binary', statBytes(c.type, mn)]] : [[3, 'i64', 0]];
      chunks.push([
        [2, 'i64', start],
        [3, 'struct', [
          [1, 'i32', TYPE[c.type]], [2, ['list', 'i32'], [ENC[c.encoding]]], [3, ['list', 'string'], [c.name]],
          [4, 'i32', 0], [5, 'i64', count], [6, 'i64', size], [7, 'i64', size], [9, 'i64', start],
          [12, 'struct', stats],
        ]],
      ]);
    }
    rgMeta.push([[1, ['list', 'struct'], chunks], [2, 'i64', w.p - rgStart], [3, 'i64', count], [5, 'i64', rgStart], [6, 'i64', w.p - rgStart]]);
    row += count;
  }
  const schema = [[[4, 'string', 'schema'], [5, 'i32', columns.length]]];
  for (const c of columns) {
    const e = [[1, 'i32', TYPE[c.type]], [3, 'i32', 0], [4, 'string', c.name]];
    const lg = c.logical && INT_LOGICAL[c.logical];
    if (c.logical && !lg) throw new Error(`parquet write: logical type ${c.logical}`);
    if (lg) e.push([6, 'i32', lg[0]], [10, 'struct', [[10, 'struct', [[1, 'i8', lg[1]], [2, 'bool', lg[2]]]]]]);
    schema.push(e);
  }
  const footerStart = w.p;
  writeStruct(w, [
    [1, 'i32', 2], [2, ['list', 'struct'], schema], [3, 'i64', n], [4, ['list', 'struct'], rgMeta],
    [5, ['list', 'struct'], Object.entries(kv).map(([k, v]) => [[1, 'string', k], [2, 'string', v]])],
    [6, 'string', createdBy],
    [7, ['list', 'struct'], columns.map(() => [[1, 'struct', []]])], // ColumnOrder: TYPE_ORDER
  ]);
  w.u32(w.p - footerStart);
  w.bytes(new Uint8Array([0x50, 0x41, 0x52, 0x31]));
  return w.result().slice();
}
