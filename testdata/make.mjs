// Golden files for cross-language conformance. Deterministic inputs → testdata/inputs.json; the JS
// writer's output → testdata/golden.wfr; and expected.json: for every element, every table, every
// column, the SHA-256 of its decoded values in row order (ints as int32/int64 LE, floats as float64/
// float32 LE, strings as UTF-8 joined by \n) plus the row-group sizes. Any implementation must
// (1) read golden.wfr to exactly these hashes and (2) WRITE the same inputs to the same hashes —
// the bricking algorithm (Morton keys, stable sort, cuts, first-use rows) is shared, not just the format.
//   node testdata/make.mjs            (regenerate — only when the format or the reference writer changes)
import { writeFileSync, readFileSync } from 'node:fs';
import { writeWfr } from '../js/src/index.js';
import { summarize } from './summarize.mjs';

let seed = 20261024;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const r3 = (v) => Math.round(v * 1000) / 1000;    // inputs at mm, so JSON round-trips them exactly

// cube: closed, coloured vertices, topology checked
const cubeP = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].flatMap((p) => p.map((c, a) => [512000, 7400000, 300][a] + c * 10));
const cubeF = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
// terrain: a jittered 40×40 grid (multi-brick at target 512), shuffled vertex + face order
const n = 40, w = n + 1, terrP = [], terrF = [];
for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) terrP.push(r3(512000 + i * 2 + (rnd() - 0.5)), r3(7400000 + j * 2 + (rnd() - 0.5)), r3(300 + 10 * Math.sin(i / 6) * Math.cos(j / 9)));
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * w + i, b = a + 1, c = a + w, d = c + 1; terrF.push(a, b, d, a, d, c); }
const perm = (m) => { const p = [...Array(m).keys()]; for (let i = m - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; };
const vp = perm(w * w), fp = perm(terrF.length / 3);
const terrP2 = new Array(terrP.length), terrF2 = new Array(terrF.length);
for (let i = 0; i < w * w; i++) for (let a = 0; a < 3; a++) terrP2[3 * vp[i] + a] = terrP[3 * i + a];
for (let f = 0; f < terrF.length / 3; f++) for (let a = 0; a < 3; a++) terrF2[3 * fp[f] + a] = vp[terrF[3 * f + a]];
const dz = Array.from({ length: w * w }, (_, i) => Math.fround(Math.sin(i) * 0.25));
const domain = Array.from({ length: terrF2.length / 3 }, (_, f) => (f * 7) % 5);
// two lodes in one element, bricked by a string label
const lodeP = [...cubeP, ...cubeP.map((v, i) => v + (i % 3 === 2 ? 0 : 30))];
const lodeF = [...cubeF, ...cubeF.map((v) => v + 8)];
const lode = [...Array(12).fill('north'), ...Array(12).fill('south')];
// strings: three polylines, indexed segments with layer + string id
const strP = [], strS = [], layer = [], sid = [];
[['CREST', 6], ['TOE', 5], ['CREST', 4]].forEach(([L, m], s) => {
  const base = strP.length / 3;
  for (let i = 0; i < m; i++) strP.push(r3(512000 + i * 3), r3(7400050 + s * 7), r3(310 + i * 0.5));
  for (let i = 0; i + 1 < m; i++) { strS.push(base + i, base + i + 1); layer.push(L); sid.push(s); }
});
// pegs: float64 points with a label and an id
const pegP = [], pegL = [], pegId = [];
for (let i = 0; i < 300; i++) { pegP.push(512000 + rnd() * 80, 7400000 + rnd() * 80, 290 + rnd() * 30); pegL.push(['A', 'B', 'C'][i % 3]); pegId.push(i * 11); }

const inputs = {
  note: 'shared inputs for the golden files — see make.mjs',
  elements: [
    { name: 'cube', kind: 'triangles', positions: cubeP, cells: cubeF, topology: 'check', vertexAttributes: { 'color.r': { type: 'u8', values: [0, 40, 80, 120, 160, 200, 240, 255] }, 'color.g': { type: 'u8', values: Array(8).fill(64) }, 'color.b': { type: 'u8', values: Array(8).fill(190) } } },
    { name: 'terrain', kind: 'triangles', positions: terrP2, cells: terrF2, target: 512, topology: 'check', vertexAttributes: { dz: { type: 'f32', values: dz } }, cellAttributes: { domain: { type: 'i32', values: domain } } },
    { name: 'lodes', kind: 'triangles', positions: lodeP, cells: lodeF, target: 8, brickBy: 'lode', topology: 'check', cellAttributes: { lode: { type: 'string', values: lode } } },
    { name: 'strings', kind: 'lines', positions: strP, cells: strS, target: 4, cellAttributes: { layer: { type: 'string', values: layer }, string: { type: 'i32', values: sid } } },
    { name: 'pegs', kind: 'points', positions: pegP, coords: { mode: 'float64' }, target: 64, vertexAttributes: { layer: { type: 'string', values: pegL }, id: { type: 'i32', values: pegId } } },
  ],
};
writeFileSync(new URL('./inputs.json', import.meta.url), JSON.stringify(inputs) + '\n');

// write golden.wfr from the JSON (exactly what other implementations will read back)
const back = JSON.parse(readFileSync(new URL('./inputs.json', import.meta.url), 'utf8'));
const TA = { u8: Uint8Array, i32: Int32Array, f32: Float32Array, f64: Float64Array };
const arr = (a) => (a.type === 'string' ? a.values : TA[a.type].from(a.values));
const attrs = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, arr(v)]));
const elements = back.elements.map((e) => ({ ...e, positions: Float64Array.from(e.positions), cells: e.cells ? Uint32Array.from(e.cells) : undefined, vertexAttributes: attrs(e.vertexAttributes), cellAttributes: attrs(e.cellAttributes) }));
const parts = [];
await writeWfr({ write: (b) => { parts.push(b.slice()); } }, { elements, frame: { origin: [512000, 7400000, 300], crs: 'EPSG:31983', units: 'm' } });
const bytes = new Uint8Array(parts.reduce((s, b) => s + b.length, 0)); let o = 0; for (const b of parts) { bytes.set(b, o); o += b.length; }
writeFileSync(new URL('./golden.wfr', import.meta.url), bytes);

const expected = await summarize(bytes);
writeFileSync(new URL('./expected.json', import.meta.url), JSON.stringify(expected, null, 1) + '\n');
console.log(`golden.wfr ${bytes.length} bytes · ${Object.keys(expected.elements).join(', ')}`);
for (const [nm, e] of Object.entries(expected.elements)) console.log(`  ${nm}: ${e.kind} ${e.counts.cells} cells, ${e.counts.vertices} vertices, bricks ${JSON.stringify(e.tables.vertices.rowGroups)}${e.topology ? ' · ' + JSON.stringify(e.topology) : ''}`);
