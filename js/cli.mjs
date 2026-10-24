#!/usr/bin/env node
// wfr — convert meshes to .wfr in bounded memory, and inspect .wfr files.
//   wfr convert <in.ply|.obj|.dxf> [out.wfr] [--budget 1g] [--step 1e-4] [--float64] [--check] [--target 65536] [--brick-by layer] [--tmp dir]
//   wfr info <file.wfr>
import { createReadStream, openSync, writeSync, closeSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createWfrWriter, nodeBacking, openWfr } from './src/index.js';
import { convertPly } from './convert/ply.js';
import { convertObj } from './convert/obj.js';
import { convertDxf } from './convert/dxf.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n) => { const i = args.indexOf('--' + n); if (i < 0) return false; args.splice(i, 1); return true; };
const size = (s) => { const m = /^([\d.]+)\s*([kmgt]?)b?$/i.exec(String(s)); if (!m) throw new Error(`bad size ${s}`); return +m[1] * 1024 ** ' kmgt'.indexOf((m[2] || ' ').toLowerCase()); };
const fmt = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : (b / (1 << 20)).toFixed(1) + ' MB');

async function convert() {
  const budget = size(flag('budget', '1g')), step = +flag('step', '1e-4'), float64 = bool('float64'), check = bool('check');
  const target = +flag('target', '65536'), brickBy = flag('brick-by', null), tmp = flag('tmp', null);
  const [input, outArg] = args.slice(1);
  if (!input) throw new Error('usage: wfr convert <in> [out.wfr]');
  const ext = extname(input).toLowerCase(), name = basename(input, extname(input));
  const out = outArg || input.slice(0, -ext.length) + '.wfr';
  const spec = { coords: float64 ? { mode: 'float64' } : { step }, target, ...(check ? { topology: 'check' } : {}), ...(brickBy ? { brickBy } : {}) };
  const backing = await nodeBacking(tmp);
  const fd = openSync(out, 'w');
  const t0 = performance.now();
  let peak = 0;
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
  try {
    const wr = createWfrWriter({ write: (b) => { writeSync(fd, b); } }, { budget, backing });
    const chunks = createReadStream(input, { highWaterMark: 8 << 20 });
    const convs = { '.ply': convertPly, '.obj': convertObj, '.dxf': convertDxf };
    if (!convs[ext]) throw new Error(`don't know how to read ${ext}`);
    const st = await convs[ext](chunks, wr, { name, spec });
    const t1 = performance.now();
    const { size: bytes, manifest, stats } = await wr.finish({ meta: { lineage: { op: 'convert', source: basename(input), tool: '@gcu/wireframe' } } });
    const t2 = performance.now();
    peak = Math.max(peak, process.memoryUsage().rss);
    console.log(`${input} (${fmt((await stat(input)).size)}) → ${out} (${fmt(bytes)})`);
    console.log(`  read ${((t1 - t0) / 1000).toFixed(1)} s · write ${((t2 - t1) / 1000).toFixed(1)} s · peak RSS ${fmt(peak)} · budget ${fmt(budget)} · spilled ${fmt(stats.spilledBytes)}`);
    console.log(`  source: ${JSON.stringify(st)}`);
    for (const e of manifest.elements) console.log(`  ${e.name} [${e.kind}]: ${e.counts.cells} cells, ${e.counts.vertices} vertices (${e.counts.vertexRows} rows), ${e.counts.bricks} bricks${e.topology ? ' · ' + JSON.stringify(e.topology) : ''}`);
  } finally {
    clearInterval(tick); closeSync(fd); await backing.dispose();
  }
}

async function info() {
  const file = args[1];
  const fh = await open(file, 'r'), s = await fh.stat();
  const wfr = await openWfr({ size: s.size, read: async (off, len) => { const b = new Uint8Array(len); await fh.read(b, 0, len, off); return b; } });
  const m = wfr.manifest;
  console.log(`${file}: ${fmt(s.size)}, wireframe ${m.version}, frame ${JSON.stringify(m.frame)}`);
  for (const e of wfr.elements) {
    const mm = e.meta;
    console.log(`  ${mm.name} [${mm.kind}] ${mm.counts.cells} cells · ${mm.counts.vertices} vertices · ${mm.counts.bricks} bricks · coords ${JSON.stringify(mm.coords)}`);
    if (mm.topology) console.log(`    topology ${JSON.stringify(mm.topology)}`);
    for (const t of Object.keys(e.tables)) console.log(`    ${t}: ${e.tables[t].footer.rowGroups[0]?.columns.map((c) => `${c.name}:${c.type}`).join(' ') ?? '(empty)'}`);
  }
  await fh.close();
}

const cmd = args[0];
(cmd === 'convert' ? convert() : cmd === 'info' ? info() : Promise.reject(new Error('usage: wfr convert <in> [out] | wfr info <file>'))).catch((e) => { console.error(e.message); process.exit(1); });
