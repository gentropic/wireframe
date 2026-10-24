// The narrow Parquet reader: footer + REQUIRED flat columns in the encodings SPEC §11 allows.
// Anything outside that fails loudly, naming the column — never returns wrong values.
import { decodeStruct } from './thrift.js';
import { deltaInt32, byteStreamSplit, plain } from './decode.js';
import { snappyDecompress } from './snappy.js';

const TYPES = ['BOOLEAN', 'INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE', 'BYTE_ARRAY', 'FIXED_LEN_BYTE_ARRAY'];
const REPETITION = ['REQUIRED', 'OPTIONAL', 'REPEATED'];
const CODECS = ['UNCOMPRESSED', 'SNAPPY', 'GZIP', 'LZO', 'BROTLI', 'LZ4', 'ZSTD', 'LZ4_RAW'];
const ENC = { PLAIN: 0, PLAIN_DICTIONARY: 2, RLE: 3, DELTA_BINARY_PACKED: 5, RLE_DICTIONARY: 8, BYTE_STREAM_SPLIT: 9 };
const ENC_NAME = Object.fromEntries(Object.entries(ENC).map(([k, v]) => [v, k]));
const ARRAY = { INT32: Int32Array, FLOAT: Float32Array, DOUBLE: Float64Array };
const PAGE_DATA = 0, PAGE_DICT = 2, PAGE_DATA_V2 = 3;
const td = new TextDecoder();
const str = (b) => (b === undefined ? undefined : td.decode(b));

function statValue(b, type) {
  if (!b || !b.length) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (type) {
    case 'INT32': return dv.getInt32(0, true);
    case 'INT64': return Number(dv.getBigInt64(0, true));
    case 'FLOAT': return dv.getFloat32(0, true);
    case 'DOUBLE': return dv.getFloat64(0, true);
    default: return undefined;
  }
}

// Parse the footer from the file's last bytes. `tail` must end at the end of the file.
// Returns null with { need } when the tail is too short to hold the footer.
export function parseFooter(tail, fileSize) {
  const n = tail.length;
  if (n < 8 || td.decode(tail.subarray(n - 4)) !== 'PAR1') throw new Error('parquet: missing PAR1 magic');
  const len = new DataView(tail.buffer, tail.byteOffset + n - 8, 4).getUint32(0, true);
  if (len + 8 > n) return { need: len + 8 };
  const { value: fm } = decodeStruct(tail, n - 8 - len);
  const schema = fm[2].map((e) => ({ name: str(e[4]), type: TYPES[e[1]], repetition: REPETITION[e[3]], children: e[5] || 0 }));
  // nested schemas are outside the narrow reader: the footer still parses, their columns won't decode
  const leaves = schema.slice(1);
  const rowGroups = (fm[4] || []).map((rg) => ({
    numRows: rg[3],
    columns: rg[1].map((cc, i) => {
      const md = cc[3];
      const name = md[3].map(str).join('.');
      const leaf = leaves.find((l) => l.name === name) || leaves[i];
      const st = md[12] || {};
      const type = TYPES[md[1]];
      const start = md[11] !== undefined && md[11] > 0 ? Math.min(md[11], md[9]) : md[9];
      return {
        name, type, repetition: leaf?.repetition, codec: CODECS[md[4]], encodings: md[2].map((e) => ENC_NAME[e] ?? e),
        numValues: md[5], start, length: md[7],
        min: statValue(st[6] ?? st[2], type), max: statValue(st[5] ?? st[1], type), nullCount: st[3],
      };
    }),
  }));
  const kv = {};
  for (const e of fm[5] || []) kv[str(e[1])] = str(e[2]);
  return { numRows: fm[3], schema, rowGroups, kv, createdBy: str(fm[6]), footerLength: len + 8, fileSize };
}

// Decode one column chunk. `bytes` holds exactly the chunk (col.start … col.start + col.length).
// out: an optional preallocated typed array; values land at out[o…].
export function decodeChunk(bytes, col, out, o = 0) {
  const A = ARRAY[col.type];
  if (!A) throw new Error(`parquet: column "${col.name}" has type ${col.type}, outside the narrow reader`);
  if (col.repetition !== 'REQUIRED') throw new Error(`parquet: column "${col.name}" is ${col.repetition}, the narrow reader decodes REQUIRED columns only`);
  if (col.codec !== 'UNCOMPRESSED' && col.codec !== 'SNAPPY') throw new Error(`parquet: column "${col.name}" uses codec ${col.codec}`);
  out = out || new A(col.numValues);
  let p = 0, done = 0;
  while (done < col.numValues) {
    const { value: h, end } = decodeStruct(bytes, p);
    const type = h[1], csize = h[3];
    let data = bytes.subarray(end, end + csize);
    p = end + csize;
    let count, encoding;
    if (type === PAGE_DATA) {
      count = h[5][1]; encoding = h[5][2];
      if (col.codec === 'SNAPPY') data = snappyDecompress(data, h[2]);
    } else if (type === PAGE_DATA_V2) {
      const v2 = h[8];
      count = v2[1]; encoding = v2[4];
      if (v2[2]) throw new Error(`parquet: column "${col.name}" has nulls`);
      const lv = (v2[5] || 0) + (v2[6] || 0);
      data = data.subarray(lv);
      if (col.codec === 'SNAPPY' && v2[7] !== false) data = snappyDecompress(data, h[2] - lv);
    } else if (type === PAGE_DICT) {
      throw new Error(`parquet: column "${col.name}" is dictionary-encoded, outside the narrow reader`);
    } else continue; // index pages etc.
    const at = o + done;
    if (encoding === ENC.DELTA_BINARY_PACKED && col.type === 'INT32') deltaInt32(data, 0, out, at, count);
    else if (encoding === ENC.BYTE_STREAM_SPLIT) byteStreamSplit(data, 0, out, at, count, col.type);
    else if (encoding === ENC.PLAIN) plain(data, 0, out, at, count, col.type);
    else throw new Error(`parquet: column "${col.name}" uses ${ENC_NAME[encoding] ?? encoding} for ${col.type}, outside the narrow reader`);
    done += count;
  }
  return out;
}
