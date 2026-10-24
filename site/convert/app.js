// wireframe converter — PLY / OBJ / DXF → .wfr, entirely in the page (no network).
import { createWfrWriter, opfsBacking } from '../lib/wireframe.js';
import { convertPly, convertObj, convertDxf } from '../lib/convert.js';
import { createSceneStream } from '../lib/dxf.js';

const $ = (s) => document.querySelector(s);
const fmt = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB');
const base = (n) => n.replace(/\.[^.]+$/, '');
let files = [], job = null, touchedName = false;

function renderFiles() {
  const ul = $('#files'); ul.textContent = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('span'), { className: 'nm', textContent: f.name }), Object.assign(document.createElement('span'), { className: 'sz', textContent: fmt(f.size) }));
    const x = Object.assign(document.createElement('button'), { textContent: '×', title: 'remove' });
    x.onclick = () => { files = files.filter((g) => g !== f); renderFiles(); };
    li.append(x); ul.append(li);
  }
  if (!touchedName) $('#outName').value = (files.length === 1 ? base(files[0].name) : files.length ? base(files[0].name) + '-set' : 'converted') + '.wfr';
  $('#go').disabled = !files.length || !!job;
}
function addFiles(list) {
  const bad = [];
  for (const f of list) { if (/\.(ply|obj|dxf)$/i.test(f.name)) files.push(f); else bad.push(f.name); }
  $('#status').textContent = bad.length ? `skipped (not PLY/OBJ/DXF): ${bad.join(', ')}` : '';
  renderFiles();
}
$('#pick').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
const drop = $('#drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
$('#outName').oninput = () => { touchedName = true; };

async function* chunks(file, onBytes, signal) {
  const SLAB = 8 << 20;
  for (let at = 0; at < file.size; at += SLAB) {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const end = Math.min(file.size, at + SLAB);
    yield new Uint8Array(await file.slice(at, end).arrayBuffer());
    onBytes(end);
  }
}
// element names stay unique across files (two "mesh.ply" from different folders)
function uniqueNames(wr) {
  return { element(spec) { let n = spec.name; const taken = new Set(wr.names()); for (let i = 2; taken.has(n); i++) n = `${spec.name} (${i})`; return wr.element({ ...spec, name: n }); } };
}

$('#go').onclick = async () => {
  if (job || !files.length) return;
  let fname = ($('#outName').value.trim() || 'converted.wfr').replace(/[\\/]/g, '_');
  if (!/\.wfr$/i.test(fname)) fname += '.wfr';
  const stepV = $('#step').value, spec = { coords: stepV === 'f64' ? { mode: 'float64' } : { step: +stepV }, ...($('#topo').checked ? { topology: 'check' } : {}) };
  let ws = null, parts = null;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: 'wireframe mesh', accept: { 'application/vnd.gentropic.wireframe': ['.wfr'] } }] });
      ws = await h.createWritable(); fname = h.name;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (!ws) parts = [];
  const sink = { write: (u8) => (ws ? ws.write(u8) : parts.push(u8.slice())) };
  const ctrl = new AbortController();
  job = { ctrl }; $('#go').disabled = true; $('#cancel').disabled = false; $('#result').hidden = true;
  const fill = $('#fill'), st = $('#status'), t0 = performance.now();
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0, backing = null;
  try {
    backing = await opfsBacking();
    const wr = createWfrWriter(sink, { budget: +$('#budget').value * 1024 * 1024, backing });
    const w = uniqueNames(wr);
    for (const f of files) {
      const onBytes = (n) => { fill.style.width = `${Math.round(75 * (done + n) / total)}%`; st.textContent = `reading ${f.name} — ${Math.round(100 * n / f.size)}%`; };
      const name = base(f.name), opts = { name, spec: { ...spec, meta: { lineage: { op: 'convert', source: f.name, tool: 'gentropic.org/wireframe/convert' } } } };
      const src = chunks(f, onBytes, ctrl.signal);
      if (/\.ply$/i.test(f.name)) await convertPly(src, w, opts);
      else if (/\.obj$/i.test(f.name)) await convertObj(src, w, opts);
      else await convertDxf(src, w, { ...opts, dxf: { createSceneStream } });
      done += f.size;
    }
    if (ctrl.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    if (!wr.names().length) throw new Error('no meshes, polylines or points found');
    fill.style.width = '85%'; st.textContent = 'sorting into bricks, encoding, writing…';
    const res = await wr.finish({ meta: { tool: 'gentropic.org/wireframe/convert' } });
    if (ws) await ws.close();
    fill.style.width = '100%';
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    st.textContent = `${fname} — ${fmt(res.size)} in ${secs} s (${fmt(total)} in → ${(100 * res.size / total).toFixed(1)}%)`;
    const word = { triangles: 'triangles', lines: 'segments', points: 'points' };
    const lines = res.manifest.elements.map((e) => `${e.name}  ${e.kind}  ${(e.kind === 'points' ? e.counts.vertices : e.counts.cells).toLocaleString()} ${word[e.kind]} · ${e.counts.vertices.toLocaleString()} vertices · ${e.counts.bricks} bricks${e.topology && e.topology.status === 'checked' ? ` · ${[e.topology.closed === false ? 'open' : '', ...['closed', 'oriented', 'manifold'].filter((k) => e.topology[k])].filter(Boolean).join(' ')}${e.topology.volume != null ? ` · ${e.topology.volume.toFixed(1)} m³` : ''}` : ''}`);
    const r = $('#result'); r.textContent = lines.join('\n'); r.hidden = false;
    if (parts) {
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/vnd.gentropic.wireframe' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: fname, textContent: `\n↓ download ${fname}` });
      r.append(a); a.click();
    }
  } catch (e) {
    if (ws) await ws.abort().catch(() => {});
    st.textContent = e.name === 'AbortError' ? 'cancelled — nothing written' : `failed: ${e.message}`;
    fill.style.width = '0%';
  } finally {
    if (backing) await backing.dispose();
    job = null; $('#cancel').disabled = true; renderFiles();
  }
};
$('#cancel').onclick = () => { if (job) { job.ctrl.abort(); $('#status').textContent = 'cancelling…'; } };
renderFiles();
