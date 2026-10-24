// Writing .wfr files. Everything goes through the streaming pipeline (pipeline.js); the memory
// budget decides how much of it stays resident, and the output does not depend on the budget.
import { createZipWriter } from './zip.js';
import { createScratch } from './scratch.js';
import { createElementWriter } from './pipeline.js';
import { MIMETYPE, FORMAT_VERSION, SPEC_URL } from './wfr.js';

const te = new TextEncoder();
const BLOCK = 16 * 1024 * 1024;

// The attribute type of a typed array (or a JS array of strings).
export function attrType(a) {
  if (a instanceof Float64Array) return 'f64';
  if (a instanceof Float32Array) return 'f32';
  if (a instanceof Int32Array) return 'i32';
  if (a instanceof Uint8Array || a instanceof Uint8ClampedArray) return 'u8';
  if (a instanceof Uint16Array) return 'u16';
  if (a instanceof Int8Array) return 'i8';
  if (a instanceof Int16Array) return 'i16';
  if (Array.isArray(a)) return 'string';
  throw new Error(`wfr write: unsupported attribute array ${a?.constructor?.name}`);
}

/**
 * createWfrWriter(sink, opts) → { element(spec) → ElementWriter, finish({ frame, meta }) → { size, manifest } }
 *   sink: { write(Uint8Array) → void|Promise }
 *   opts: { budget = Infinity (bytes kept resident), backing (scratch files beyond the budget),
 *           scratch (a ready store; overrides budget/backing) }
 * Elements are pushed in any order while the source streams (pass 1); finish() runs the
 * remaining passes element by element and writes the archive.
 */
export function createWfrWriter(sink, { budget = Infinity, backing = null, scratch = null } = {}) {
  const store = scratch || createScratch({ backing, budget: backing ? budget / 2 : Infinity });
  const ctx = { scratch: store, leafBytes: Number.isFinite(budget) ? budget / 4 : Infinity, cacheBytes: Number.isFinite(budget) ? budget / 8 : Infinity };
  const writers = [];
  return {
    ctx,
    names: () => writers.map((w) => w.name), // element names claimed so far (callers de-duplicate with it)
    element(spec) {
      if (!spec.name) throw new Error('wfr write: element without a name');
      if (writers.some((w) => w.name === spec.name)) throw new Error(`wfr write: duplicate element "${spec.name}"`);
      const w = createElementWriter(spec, ctx);
      writers.push(w);
      return w;
    },
    async finish({ frame = null, meta = {} } = {}) {
      const zw = createZipWriter(sink);
      await zw.add('mimetype', te.encode(MIMETYPE), { aligned: false, hash: false });
      const members = {}, elements = [];
      for (const w of writers) {
        const { manifest, members: mem } = await w.end(zw);
        for (const [name, info] of Object.entries(mem)) members[name] = { size: info.size, block: BLOCK, sha256: info.sha256 };
        elements.push(manifest);
      }
      const f = frame || { origin: elements.find((e) => e.coords.origin)?.coords.origin || [0, 0, 0] };
      const manifest = { format: 'wireframe', version: FORMAT_VERSION, spec: SPEC_URL, frame: { crs: null, units: 'm', ...f }, elements, members, meta };
      await zw.add('wireframe.json', te.encode(JSON.stringify(manifest)), { hash: false });
      const { size } = await zw.finish();
      return { size, manifest, stats: store.stats };
    },
  };
}

/**
 * writeWfr(sink, { elements, frame, meta }, opts) — whole elements given as arrays:
 *   { name, kind, positions: Float64Array(3n), cells?: (k per cell), vertexAttributes?: { name: array },
 *     cellAttributes?: { name: array }, coords?, topology?: 'check'|{…}, brickBy?, target?, keepVid?, meta? }
 * opts as createWfrWriter (default: everything in memory).
 */
export async function writeWfr(sink, { elements, frame = null, meta = {} }, opts = {}) {
  const wr = createWfrWriter(sink, opts);
  for (const el of elements) {
    const vAttrs = el.vertexAttributes || {}, cAttrs = el.cellAttributes || {};
    const types = (o) => Object.fromEntries(Object.entries(o).map(([n, a]) => [n, attrType(a)]));
    const w = wr.element({ ...el, vertexAttributes: types(vAttrs), cellAttributes: types(cAttrs) });
    if (el.kind === 'points') await w.points(el.positions, vAttrs);
    else { await w.vertices(el.positions, vAttrs); await w.cells(el.cells, cAttrs); }
  }
  return wr.finish({ frame, meta });
}
