// Decoded-content hashes of a .wfr — the cross-language contract (see make.mjs).
import { createHash } from 'node:crypto';
import { openWfr, bytesSource } from '../js/src/index.js';

export async function summarize(u8) {
  const wfr = await openWfr(bytesSource(u8));
  const out = { spec: wfr.manifest.spec, elements: {} };
  for (const el of wfr.elements) {
    const e = out.elements[el.name] = { kind: el.kind, counts: el.meta.counts, coords: el.meta.coords, topology: el.meta.topology || null, tables: {} };
    for (const [tname, t] of Object.entries(el.tables)) {
      const rgs = t.footer.rowGroups, cols = rgs[0].columns.map((c) => c.name);
      const tab = e.tables[tname] = { rowGroups: rgs.map((rg) => rg.numRows), columns: {} };
      for (const name of cols) {
        const h = createHash('sha256');
        for (let k = 0; k < rgs.length; k++) {
          const v = (await el.readRowGroup(tname, k, [name]))[name];
          if (Array.isArray(v)) h.update(Buffer.from(v.join('\n') + (k < rgs.length - 1 ? '\n' : ''), 'utf8'));
          else { const c = rgs[k].columns.find((q) => q.name === name); const T = c.type === 'DOUBLE' ? Float64Array : c.type === 'FLOAT' ? Float32Array : Int32Array; h.update(Buffer.from(new T(v).buffer)); }
        }
        tab.columns[name] = h.digest('hex');
      }
    }
  }
  return out;
}
