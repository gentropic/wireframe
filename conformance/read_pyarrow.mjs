// Decode the pyarrow-written files from pyarrow_check.py with the narrow reader; compare to the .bin truth.
//   node conformance/read_pyarrow.mjs
import { readFileSync } from 'node:fs';
import { parseFooter, decodeChunk } from '../js/src/parquet.js';

const dir = new URL('../bench/out/pyarrow/', import.meta.url);
const cases = JSON.parse(readFileSync(new URL('cases.json', dir)));
const ARR = { int32: Int32Array, float64: Float64Array };
const truth = {};
for (const [k, t] of Object.entries(cases.columns)) {
  const b = readFileSync(new URL(`${k}.bin`, dir));
  truth[k] = new ARR[t](b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
let failed = 0;
for (const f of cases.files) {
  const b = readFileSync(new URL(f, dir)), u8 = new Uint8Array(b.buffer, b.byteOffset, b.length);
  const footer = parseFooter(u8, u8.length);
  const pages = new Set();
  for (const k of Object.keys(truth)) {
    const out = new truth[k].constructor(cases.n);
    let o = 0;
    for (const rg of footer.rowGroups) {
      const c = rg.columns.find((cc) => cc.name === k);
      c.encodings.forEach((e) => pages.add(e));
      decodeChunk(u8.subarray(c.start, c.start + c.length), c, out, o);
      o += rg.numRows;
    }
    for (let i = 0; i < cases.n; i++) if (!Object.is(out[i], truth[k][i])) { console.log(`  FAIL ${f} ${k}[${i}]: ${out[i]} vs ${truth[k][i]}`); failed++; break; }
  }
  console.log(`${failed ? '…' : 'ok'}  ${f.padEnd(30)} ${footer.rowGroups.length} row groups · ${footer.createdBy} · ${[...pages].join(',')}`);
}
if (failed) { console.log(`${failed} failures`); process.exit(1); }
console.log('all pyarrow files decode exactly');
