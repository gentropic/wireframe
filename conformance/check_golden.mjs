// The JS reader against a .wfr written elsewhere (default: the Python writer's bench/out/py-golden.wfr):
// its decoded-column hashes, counts, coords and topology must equal testdata/expected.json.
//   node conformance/check_golden.mjs [file.wfr]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarize } from '../testdata/summarize.mjs';

const file = process.argv[2] || fileURLToPath(new URL('../bench/out/py-golden.wfr', import.meta.url));
const want = JSON.parse(readFileSync(new URL('../testdata/expected.json', import.meta.url), 'utf8'));
const got = await summarize(new Uint8Array(readFileSync(file)));
let bad = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const num = (o) => JSON.parse(JSON.stringify(o), (k, v) => v);   // normalizes 512000.0 vs 512000 (JSON numbers)
if (got.spec !== want.spec) { console.log(`spec: ${got.spec} ≠ ${want.spec}`); bad++; }
for (const [name, w] of Object.entries(want.elements)) {
  const g = got.elements[name];
  if (!g) { console.log(`missing element ${name}`); bad++; continue; }
  for (const k of ['kind', 'counts', 'coords', 'topology']) if (!eq(num(g[k]), num(w[k]))) { console.log(`${name}.${k}: ${JSON.stringify(g[k])} ≠ ${JSON.stringify(w[k])}`); bad++; }
  for (const [t, wt] of Object.entries(w.tables)) {
    const gt = g.tables[t];
    if (!eq(gt.rowGroups, wt.rowGroups)) { console.log(`${name}.${t} row groups ${gt.rowGroups} ≠ ${wt.rowGroups}`); bad++; }
    for (const [c, h] of Object.entries(wt.columns)) if (gt.columns[c] !== h) { console.log(`${name}.${t}.${c} differs`); bad++; }
  }
}
console.log(bad ? `${bad} difference(s)` : `${file.split(/[\\/]/).pop()}: every element, table and column matches testdata/expected.json`);
process.exit(bad ? 1 : 0);
