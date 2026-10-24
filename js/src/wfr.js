// Reading .wfr files: open → manifest + per-element footers → bricks decoded on demand.
import { openZip } from './zip.js';
import { parseFooter, decodeChunk } from './parquet.js';

export const MIMETYPE = 'application/vnd.gentropic.wireframe';
export const FORMAT_VERSION = '0.1';
// informative: where this format is described (SPEC §4) — written, never fetched
export const SPEC_URL = `https://gentropic.org/wireframe/${FORMAT_VERSION}`;
const td = new TextDecoder();

// A ranged view of one stored member.
function memberSource(src, offset, size) {
  return { size, read: (off, len) => src.read(offset + off, len) };
}

async function readFooter(ms) {
  let len = Math.min(ms.size, 65536);
  for (;;) {
    const tail = await ms.read(ms.size - len, len);
    const f = parseFooter(tail, ms.size);
    if (!f.need) return f;
    len = f.need;
  }
}

// Open a .wfr from a source ({ size, read }). Reads the zip directory, the manifest, and the
// footers of every element's tables — nothing else.
export async function openWfr(src) {
  const zip = await openZip(src);
  const member = async (name) => {
    const e = zip.entries.get(name);
    if (!e) return null;
    if (e.method !== 0) throw new Error(`wfr: member ${name} is compressed (method ${e.method}); .wfr members are stored`);
    const { offset, size } = await zip.dataRange(e);
    return memberSource(src, offset, size);
  };
  const mt = await member('mimetype');
  if (!mt || td.decode(await mt.read(0, mt.size)) !== MIMETYPE) throw new Error('wfr: not a wireframe file (mimetype)');
  const mm = await member('wireframe.json');
  if (!mm) throw new Error('wfr: missing wireframe.json');
  const manifest = JSON.parse(td.decode(await mm.read(0, mm.size)));
  if (manifest.format !== 'wireframe') throw new Error('wfr: manifest format is not "wireframe"');
  if (String(manifest.version).split('.')[0] !== '0') throw new Error(`wfr: unsupported version ${manifest.version}`);

  const elements = [];
  for (const el of manifest.elements) {
    const tables = {};
    for (const t of el.kind === 'points' ? ['vertices'] : ['vertices', 'cells']) {
      const ms = await member(el.path + t + '.parquet');
      if (!ms) throw new Error(`wfr: element "${el.name}" lacks ${t}.parquet`);
      tables[t] = { src: ms, footer: await readFooter(ms) };
    }
    const nb = tables.vertices.footer.rowGroups.length;
    if (tables.cells && tables.cells.footer.rowGroups.length !== nb) throw new Error(`wfr: element "${el.name}" breaks the brick invariant (row-group counts differ)`);
    const vStart = new Array(nb + 1); vStart[0] = 0;
    tables.vertices.footer.rowGroups.forEach((rg, k) => { vStart[k + 1] = vStart[k] + rg.numRows; });
    elements.push(new Element(el, tables, vStart));
  }
  return { manifest, elements, element: (name) => elements.find((e) => e.name === name), zip };
}

class Element {
  constructor(el, tables, vStart) {
    Object.assign(this, { meta: el, name: el.name, kind: el.kind, tables, vStart });
    this.bricks = tables.vertices.footer.rowGroups.length;
    const c = el.coords || {};
    this.coords = c;
  }

  // World bbox of brick k from the vertex footer's statistics.
  brickBox(k) {
    const cols = this.tables.vertices.footer.rowGroups[k].columns;
    const g = (n) => cols.find((c) => c.name === n);
    const x = g('x'), y = g('y'), z = g('z');
    if (this.coords.mode === 'float64') return [x.min, y.min, z.min, x.max, y.max, z.max];
    const o = this.coords.origin, s = Array.isArray(this.coords.step) ? this.coords.step : [this.coords.step, this.coords.step, this.coords.step];
    return [o[0] + s[0] * x.min, o[1] + s[1] * y.min, o[2] + s[2] * z.min, o[0] + s[0] * x.max, o[1] + s[1] * y.max, o[2] + s[2] * z.max];
  }

  // Bricks whose bbox intersects the world box [minx, miny, minz, maxx, maxy, maxz].
  bricksIn(box) {
    const out = [];
    for (let k = 0; k < this.bricks; k++) {
      const b = this.brickBox(k);
      if (b[0] <= box[3] && b[3] >= box[0] && b[1] <= box[4] && b[4] >= box[1] && b[2] <= box[5] && b[5] >= box[2]) out.push(k);
    }
    return out;
  }

  // Read the given columns of row group k of a table in one ranged read. → { name: TypedArray }
  async readRowGroup(table, k, names) {
    const t = this.tables[table], rg = t.footer.rowGroups[k];
    const cols = names.map((n) => {
      const c = rg.columns.find((cc) => cc.name === n);
      if (!c) throw new Error(`wfr: ${table} has no column "${n}"`);
      return c;
    });
    const lo = Math.min(...cols.map((c) => c.start)), hi = Math.max(...cols.map((c) => c.start + c.length));
    const bytes = await t.src.read(lo, hi - lo);
    const out = {};
    for (const c of cols) out[c.name] = decodeChunk(bytes.subarray(c.start - lo, c.start - lo + c.length), c);
    return out;
  }

  // Brick k → { x, y, z (stored units), vid?, cells (brick-LOCAL indices, interleaved) }.
  async readBrick(k, { vid = false } = {}) {
    const v = await this.readRowGroup('vertices', k, vid ? ['x', 'y', 'z', 'vid'] : ['x', 'y', 'z']);
    if (this.kind === 'points') return v;
    const names = this.kind === 'lines' ? ['a', 'b'] : ['a', 'b', 'c'];
    const c = await this.readRowGroup('cells', k, names);
    const m = names.length, n = c.a.length, cells = new Int32Array(n * m), s = this.vStart[k];
    for (let j = 0; j < m; j++) { const col = c[names[j]]; for (let i = 0; i < n; i++) cells[i * m + j] = col[i] - s; }
    return { ...v, cells };
  }
}
