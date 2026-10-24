// Read-side bench on a real .wfr: the narrow reader vs stock hyparquet (and the patched copy, if present).
// Exactness is checked value-for-value against stock hyparquet's output.
//   node bench/read.mjs [file=bench/out/bench.wfr] [rounds=7]
import { readFileSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parquetRead } from 'hyparquet';
import { openWfr, bytesSource } from '../js/src/index.js';
import { decodeChunk } from '../js/src/parquet.js';

const FILE = process.argv[2] || fileURLToPath(new URL('./out/bench.wfr', import.meta.url));
const ROUNDS = +(process.argv[3] || 7);
const PATCHED = new URL('../../auditable/experiments/wfr/hyparquet-fast/src/index.js', import.meta.url);
const patched = existsSync(fileURLToPath(PATCHED)) ? (await import(PATCHED.href)).parquetRead : null;

const file = readFileSync(FILE);
const u8 = new Uint8Array(file.buffer, file.byteOffset, file.length);
const min = (a) => Math.min(...a);
const time = async (fn) => { const t = []; for (let r = 0; r < ROUNDS; r++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } return min(t); };

let t0 = performance.now();
const wfr = await openWfr(bytesSource(u8));
console.log(`${FILE} — ${(u8.length / 1048576).toFixed(1)} MB · open (zip directory + manifest + 4 footers, in memory) ${(performance.now() - t0).toFixed(1)} ms`);

// raw-equivalent bytes: coordinates as f64 (the world data), vid and indices as i32
const rawOf = (el) => el.meta.counts.vertexRows * (3 * 8 + 4) + el.meta.counts.cells * 3 * 4;
const valuesOf = (el) => el.meta.counts.vertexRows * 4 + el.meta.counts.cells * 3;

// The core columns only (what raw-equiv counts); attributes are left alone by both readers.
const CORE = new Set(['x', 'y', 'z', 'vid', 'a', 'b', 'c']);

// narrow: decode every core column chunk of both tables into per-column preallocated arrays
async function narrowAll(el) {
  const out = {};
  for (const table of ['vertices', 'cells']) {
    const t = el.tables[table], cols = t.footer.rowGroups[0].columns.map((c) => c.name).filter((n) => CORE.has(n));
    const bytes = await t.src.read(0, t.src.size); // in-memory: a subarray
    const n = t.footer.numRows;
    for (const name of cols) out[name] = new Int32Array(n);
    let o = 0;
    for (const rg of t.footer.rowGroups) {
      for (const c of rg.columns) if (CORE.has(c.name)) decodeChunk(bytes.subarray(c.start, c.start + c.length), c, out[c.name], o);
      o += rg.numRows;
    }
  }
  return out;
}

async function hyAll(read, el) {
  const out = {};
  for (const table of ['vertices', 'cells']) {
    const t = el.tables[table], b = await t.src.read(0, t.src.size);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const n = t.footer.numRows, starts = [0];
    for (const rg of t.footer.rowGroups) starts.push(starts[starts.length - 1] + rg.numRows);
    const columns = t.footer.rowGroups[0].columns.map((c) => c.name).filter((n) => CORE.has(n));
    for (const name of columns) out[name] = new Int32Array(n);
    await read({ file: ab, columns, onChunk:({ columnName, columnData, rowStart }) => { out[columnName].set(columnData, rowStart); } });
  }
  return out;
}

const report = (label, el, ms) => console.log(`    ${label.padEnd(30)} ${ms.toFixed(1).padStart(8)} ms   ${(valuesOf(el) / ms / 1e6).toFixed(2).padStart(5)} Gval/s   ${(rawOf(el) / 1e9 / (ms / 1000)).toFixed(2).padStart(6)} GB/s raw-equiv`);

for (const el of wfr.elements) {
  console.log(`\n  ${el.name}: ${el.meta.counts.vertexRows} vertex rows, ${el.meta.counts.cells} faces, ${el.bricks} bricks · raw-equiv ${(rawOf(el) / 1048576).toFixed(0)} MB`);
  const ref = await hyAll(parquetRead, el);
  const got = await narrowAll(el);
  for (const k of Object.keys(ref)) for (let i = 0; i < ref[k].length; i++) if (ref[k][i] !== got[k][i]) throw new Error(`${el.name}.${k}[${i}]: hyparquet ${ref[k][i]} vs narrow ${got[k][i]}`);
  console.log('    exact match with stock hyparquet, every column');
  report('hyparquet (stock)', el, await time(() => hyAll(parquetRead, el)));
  if (patched) report('hyparquet (patched)', el, await time(() => hyAll(patched, el)));
  report('narrow reader', el, await time(() => narrowAll(el)));
}

// From disk (OS cache likely warm): open + a 200 m × 200 m region query on the terrain, by pread.
const fh = await open(FILE, 'r');
const st = await fh.stat();
let reads = 0, readBytes = 0;
const diskSrc = { size: st.size, read: async (off, len) => { reads++; readBytes += len; const b = new Uint8Array(len); await fh.read(b, 0, len, off); return b; } };
t0 = performance.now();
const w2 = await openWfr(diskSrc);
const tOpen = performance.now() - t0;
const terr = w2.element('terrain'), bb = terr.meta.bbox, cx = (bb[0] + bb[3]) / 2, cy = (bb[1] + bb[4]) / 2;
const box = [cx - 100, cy - 100, -1e9, cx + 100, cy + 100, 1e9];
const r0 = reads, b0 = readBytes;
t0 = performance.now();
const ks = terr.bricksIn(box);
let faces = 0;
for (const k of ks) faces += (await terr.readBrick(k)).cells.length / 3;
const tRegion = performance.now() - t0;
console.log(`\n  from disk: open ${tOpen.toFixed(1)} ms (${r0} reads, ${(b0 / 1024).toFixed(0)} KB) · region 200×200 m → ${ks.length}/${terr.bricks} bricks, ${faces} faces in ${tRegion.toFixed(1)} ms (${reads - r0} reads, ${((readBytes - b0) / 1048576).toFixed(2)} MB)`);
await fh.close();
