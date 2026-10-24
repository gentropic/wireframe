// wireframe inspector — what a .wfr holds, and whether it follows the spec. No network.
import { openWfr, openZip, blobSource, decodeChunk, MIMETYPE } from '../lib/wireframe.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
const fmt = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B');
const n = (v) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString() : String(v));
const ALLOWED_CODECS = new Set(['UNCOMPRESSED', 'SNAPPY']);

function checkList(title) {
  const sec = el('section', {}, el('h2', { textContent: title }));
  const ul = el('ul', { className: 'checks' });
  sec.append(ul);
  const add = (level, text, why) => { const li = el('li', { className: level, textContent: text }); if (why) li.append(el('span', { className: 'why', textContent: ` — ${why}` })); ul.append(li); return li; };
  return { sec, pass: (t, w) => add('pass', t, w), warn: (t, w) => add('warn', t, w), fail: (t, w) => add('fail', t, w), info: (t, w) => add('info', t, w), ul };
}
function table(head, rows) {
  const t = el('table', { className: 'kv' });
  t.append(el('tr', {}, ...head.map((h) => el('th', { textContent: h }))));
  for (const r of rows) t.append(el('tr', {}, ...r.map((c) => el('td', { textContent: c }))));
  return t;
}

async function inspect(file) {
  const out = $('#out'); out.textContent = '';
  const head = el('div', { className: 'status', textContent: `reading ${file.name} (${fmt(file.size)})…` });
  out.append(head);
  const src = blobSource(file);
  let zip, wfr;
  const C = checkList('container');
  try { zip = await openZip(src); } catch (e) { out.append(C.sec); C.fail(`not a ZIP archive: ${e.message}`); head.textContent = file.name; return; }

  // ── container ──
  const entries = [...zip.entries.values()];
  const local = new Map();
  for (const e of entries) {
    const lh = new Uint8Array(await src.read(e.localOffset, 30));
    const dv = new DataView(lh.buffer);
    local.set(e, { nameLen: dv.getUint16(26, true), extraLen: dv.getUint16(28, true), data: (await zip.dataRange(e)).offset });
  }
  const byOffset = entries.slice().sort((a, b) => a.localOffset - b.localOffset);
  const mt = zip.entries.get('mimetype');
  if (!mt) C.fail('no "mimetype" member', 'SPEC §3.4');
  else {
    const txt = new TextDecoder().decode(await src.read(local.get(mt).data, mt.size));
    if (byOffset[0] !== mt) C.fail('"mimetype" is not the first member', 'SPEC §3.4');
    else if (txt !== MIMETYPE) C.fail(`mimetype is "${txt}"`, `expected ${MIMETYPE}`);
    else if (local.get(mt).extraLen) C.warn('mimetype has an extra field', 'SPEC §3.4 — the type string then no longer sits at offset 38');
    else C.pass(`mimetype ${MIMETYPE} at offset 38`);
  }
  const compressed = entries.filter((e) => e.method !== 0);
  if (compressed.length) C.fail(`${compressed.length} member(s) compressed: ${compressed.map((e) => e.name).slice(0, 4).join(', ')}`, 'SPEC §3.1 — every member is stored');
  else C.pass(`${entries.length} members, all stored`);
  const mis = entries.filter((e) => e !== mt && local.get(e).data % 64);
  if (mis.length) C.warn(`${mis.length} member(s) not 64-byte aligned`, 'SPEC §3.2 SHOULD'); else C.pass('member data 64-byte aligned');
  const tail = byOffset.filter((e) => e.name !== 'signature.json').pop();
  if (tail && tail.name !== 'wireframe.json') C.warn('wireframe.json is not the last member', 'SPEC §3.4 SHOULD');
  const used = entries.reduce((s, e) => s + e.csize + 30 + local.get(e).nameLen + local.get(e).extraLen, 0);
  const dead = zip.cdOffset - used;
  if (dead > 1024) C.info(`${fmt(dead)} before the central directory is not referenced by it`, 'left by appends — a compact rewrite reclaims it');
  if (entries.some((e) => e.size >= 0xffffffff || e.localOffset >= 0xffffffff)) C.info('Zip64 records in use');

  // ── manifest ──
  const M = checkList('manifest');
  try { wfr = await openWfr(src); }
  catch (e) { out.append(C.sec, M.sec); M.fail(`cannot open: ${e.message}`); head.textContent = file.name; return; }
  const m = wfr.manifest;
  head.textContent = `${file.name} — ${fmt(file.size)} · wireframe ${m.version} · ${m.elements.length} element${m.elements.length === 1 ? '' : 's'}`;
  M.pass(`format "${m.format}", version ${m.version}`);
  if (m.spec) M.pass(`spec: ${m.spec}`); else M.warn('no "spec" URL', 'SPEC §4 SHOULD');
  M.info(`frame: origin ${m.frame && m.frame.origin ? m.frame.origin.join(', ') : '—'} · crs ${(m.frame && m.frame.crs) || 'unstated'} · units ${(m.frame && m.frame.units) || 'm'}`);
  const listed = new Set(Object.keys(m.members || {}));
  const unlisted = entries.filter((e) => !['mimetype', 'wireframe.json', 'signature.json'].includes(e.name) && !listed.has(e.name));
  if (unlisted.length) M.warn(`${unlisted.length} member(s) without hashes in "members"`, unlisted.map((e) => e.name).slice(0, 3).join(', '));
  else M.pass(`every member has SHA-256 block hashes (${listed.size})`);
  const names = new Set(); for (const e of m.elements) { if (names.has(e.name)) M.fail(`duplicate element name "${e.name}"`); names.add(e.name); }
  if (zip.entries.has('signature.json')) M.info('signed (signature.json present — verification not implemented here yet)');

  // ── overview + map ──
  const ov = el('section', {}, el('h2', { textContent: 'elements' }));
  ov.append(table(['element', 'kind', 'cells', 'vertices', 'vertex rows', 'bricks', 'coords', 'topology'], wfr.elements.map((E) => {
    const x = E.meta, t = x.topology;
    const words = t ? [t.closed === false ? 'open' : '', ...['closed', 'oriented', 'manifold'].filter((k) => t[k] === true)].filter(Boolean).join(' ') : '';
    return [x.name, x.kind, x.kind === 'points' ? '—' : n(x.counts.cells), n(x.counts.vertices), n(x.counts.vertexRows), n(x.counts.bricks), x.coords.mode === 'grid' ? `grid ${x.coords.step}` : x.coords.mode,
      t ? `${t.status}: ${words || '—'}${t.volume != null ? ` · ${t.volume.toFixed(1)}` : ''}` : '—'];
  })));
  const canvas = el('canvas', { className: 'map' });
  ov.append(el('h2', { textContent: 'bricks, from above' }), canvas, el('p', { className: 'note', textContent: 'each rectangle is one brick’s x/y bounding box, read from the Parquet footer statistics alone' }));

  const sections = [C.sec, M.sec, ov];
  // ── per element ──
  for (const E of wfr.elements) {
    const x = E.meta, S = checkList(`element “${x.name}” (${x.kind})`);
    const tabs = Object.keys(E.tables);
    for (const tname of tabs) {
      const f = E.tables[tname].footer;
      const rgs = f.rowGroups;
      if (rgs.length !== x.counts.bricks) S.fail(`${tname}: ${rgs.length} row groups, manifest says ${x.counts.bricks} bricks`, 'SPEC §7.2');
      let kv = null; try { kv = JSON.parse(f.kv.wireframe); } catch { /* missing */ }
      if (!kv) S.fail(`${tname}: no "wireframe" key–value entry`, 'SPEC §6.3');
      else if (kv.element !== x.name || kv.table !== tname) S.fail(`${tname}: self-description says ${kv.element}/${kv.table}`, 'SPEC §6.3');
      const want = tname === 'vertices' ? ['x', 'y', 'z', ...(x.kind === 'points' ? [] : ['vid'])] : (x.kind === 'lines' ? ['a', 'b'] : ['a', 'b', 'c']);
      const cols = rgs.length ? rgs[0].columns : [];
      const probs = [];
      for (const w of want) {
        const c = cols.find((cc) => cc.name === w);
        if (!c) { if (rgs.length) probs.push(`${w} missing`); continue; }
        const isCoord = 'xyz'.includes(w);
        const okType = isCoord ? (x.coords.mode === 'grid' ? c.type === 'INT32' : c.type === 'DOUBLE') : (c.type === 'INT32' || c.type === 'INT64');
        const okEnc = isCoord && x.coords.mode !== 'grid' ? c.encodings.every((e) => e === 'BYTE_STREAM_SPLIT' || e === 'PLAIN' || e === 'RLE') : c.encodings.every((e) => e === 'DELTA_BINARY_PACKED' || e === 'PLAIN' || e === 'RLE');
        if (!okType) probs.push(`${w} is ${c.type}`);
        if (!okEnc) probs.push(`${w} encoded ${c.encodings.join('+')}`);
        if (c.repetition !== 'REQUIRED') probs.push(`${w} is ${c.repetition}`);
        if (!ALLOWED_CODECS.has(c.codec)) probs.push(`${w} uses ${c.codec}`);
        if (isCoord && rgs.some((rg) => { const cc = rg.columns.find((q) => q.name === w); return cc.min === undefined || cc.max === undefined; })) probs.push(`${w} lacks min/max statistics`);
      }
      if (probs.length) S.fail(`${tname}: ${probs.join('; ')}`, 'SPEC §6.1 / §7.1 / §11');
      else S.pass(`${tname}: core columns ${want.join(' ')} — REQUIRED, allowed encodings, ${[...new Set(want.map((w) => (cols.find((c) => c.name === w) || {}).codec))].join('/')}${tname === 'vertices' ? ', min/max statistics on every brick' : ''}`);
      const attrs = cols.filter((c) => !want.includes(c.name));
      if (attrs.length) S.info(`${tname} attributes: ${attrs.map((c) => `${c.name} (${c.type.toLowerCase()}${c.repetition !== 'REQUIRED' ? ', nullable' : ''})`).join(', ')}`);
      const rows = rgs.reduce((s, rg) => s + rg.numRows, 0);
      const expect = tname === 'vertices' ? x.counts.vertexRows : x.counts.cells;
      if (rows !== expect) S.fail(`${tname}: ${n(rows)} rows, manifest says ${n(expect)}`);
    }
    for (const c of x.columns || []) {
      const t = E.tables[c.location === 'vertices' ? 'vertices' : 'cells'];
      if (c.member && !(t && t.footer.rowGroups.length && t.footer.rowGroups[0].columns.some((q) => q.name === c.name))) S.fail(`attribute "${c.name}" not found in ${c.member}`);
      if (c.path && !zip.entries.has(c.path)) S.fail(`attribute member ${c.path} missing`);
    }
    if (x.bricks && x.bricks.directory) {
      const dir = x.bricks.directory, rgs = E.tables.vertices.footer.rowGroups;
      const off = dir.filter((d, k) => !rgs[k] || d[0] !== rgs[k].numRows).length;
      if (off) S.warn(`brick directory disagrees with the footer on ${off} brick(s)`, 'the footer wins (SPEC §4)'); else S.pass(`brick directory matches the footer (${dir.length} bricks)`);
    }
    const sizes = E.tables.cells ? E.tables.cells.footer.rowGroups.map((rg) => rg.numRows) : E.tables.vertices.footer.rowGroups.map((rg) => rg.numRows);
    if (sizes.length) { const s = sizes.slice().sort((a, b) => a - b); S.info(`brick sizes: ${n(s[0])} – ${n(s[s.length - 1])} ${x.kind === 'points' ? 'points' : 'cells'}, median ${n(s[s.length >> 1])}${x.bricks && x.bricks.order ? ` · order ${[...(x.bricks.order.by || []), x.bricks.order.then].join(' → ')}` : ''}`); }
    if (x.counts.vertexRows && x.counts.vertices && x.kind !== 'points') S.info(`${((x.counts.vertexRows / x.counts.vertices - 1) * 100).toFixed(2)}% of vertex rows are brick-boundary duplicates`);
    // deep check
    const row = el('div', { className: 'row' });
    const deepBtn = el('button', { className: 'sec', textContent: 'deep check (decode every brick)' });
    const deepSt = el('span', { className: 'status' });
    row.append(deepBtn, deepSt);
    S.sec.append(row);
    deepBtn.onclick = () => deepCheck(E, S, deepBtn, deepSt);
    sections.push(S.sec);
  }
  // hashes
  const H = checkList('integrity');
  const hrow = el('div', { className: 'row' });
  const hBtn = el('button', { className: 'sec', textContent: 'verify SHA-256 block hashes' });
  const hSt = el('span', { className: 'status' });
  hrow.append(hBtn, hSt); H.sec.append(hrow);
  hBtn.onclick = () => verifyHashes(zip, src, m, H, hBtn, hSt);
  sections.push(H.sec);
  sections.push(el('details', {}, el('summary', { textContent: 'wireframe.json' }), el('pre', { textContent: JSON.stringify(m, (k, v) => (k === 'directory' && Array.isArray(v) && v.length > 20 ? `[${v.length} bricks]` : k === 'sha256' && Array.isArray(v) && v.length > 4 ? [...v.slice(0, 4), `… ${v.length} blocks`] : v), 2) })));
  out.append(...sections);
  drawMap(canvas, wfr);
}

async function deepCheck(E, S, btn, st) {
  btn.disabled = true;
  const x = E.meta, k = { lines: 2, triangles: 3 }[x.kind] || 0;
  const V = x.counts.vertices, grid = x.coords.mode === 'grid';
  const track = x.kind !== 'points' && V <= 40_000_000;
  const pos = track ? new Float64Array(3 * V).fill(NaN) : null;
  let badRange = 0, repeats = 0, unused = 0, vidOut = 0, vidMismatch = 0;
  const t0 = performance.now();
  try {
    let vStart = 0;
    for (let b = 0; b < E.bricks; b++) {
      st.textContent = `brick ${b + 1} / ${E.bricks}…`;
      if (b % 8 === 0) await new Promise((r) => setTimeout(r));
      const br = await E.readBrick(b, { vid: x.kind !== 'points' });
      const rows = br.x.length;
      if (k) {
        const used = new Uint8Array(rows), cells = br.cells;
        for (let i = 0; i < cells.length; i += k) {
          for (let j = 0; j < k; j++) { const r = cells[i + j]; if (r < 0 || r >= rows) badRange++; else used[r] = 1; }
          if (cells[i] === cells[i + 1] || (k === 3 && (cells[i + 1] === cells[i + 2] || cells[i] === cells[i + 2]))) repeats++;
        }
        for (let r = 0; r < rows; r++) if (!used[r]) unused++;
      }
      if (track && br.vid) for (let r = 0; r < rows; r++) {
        const v = br.vid[r];
        if (v < 0 || v >= V) { vidOut++; continue; }
        const p = 3 * v;
        if (Number.isNaN(pos[p])) { pos[p] = br.x[r]; pos[p + 1] = br.y[r]; pos[p + 2] = br.z[r]; }
        else if (pos[p] !== br.x[r] || pos[p + 1] !== br.y[r] || pos[p + 2] !== br.z[r]) vidMismatch++;
      }
      vStart += rows;
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (k) {
      if (badRange) S.fail(`${n(badRange)} cell indices point outside their own brick`, 'SPEC §7.2 — the brick invariant');
      else S.pass(`brick invariant holds: every cell indexes only its own brick (${n(x.counts.cells)} cells)`);
      if (repeats) S.fail(`${n(repeats)} cells repeat a vertex row`, 'SPEC §7.1'); else S.pass('no cell repeats a vertex row');
      if (unused) S.fail(`${n(unused)} vertex rows are not used by any cell of their brick`, 'SPEC §6.1'); else S.pass('every vertex row is used by its brick');
    }
    if (track) {
      let missing = 0; for (let v = 0; v < V; v++) if (Number.isNaN(pos[3 * v])) missing++;
      if (vidOut) S.fail(`${n(vidOut)} vid values outside 0…${n(V - 1)}`, 'SPEC §6.1');
      if (missing) S.fail(`${n(missing)} vids never appear — vid is not dense`, 'SPEC §6.1');
      if (vidMismatch) S.fail(`${n(vidMismatch)} rows disagree with another row of the same vid on position`, 'SPEC §6.1');
      if (!vidOut && !missing && !vidMismatch) S.pass(`vid dense 0…${n(V - 1)}, and rows sharing a vid share a position${grid ? ' exactly' : ''}`);
    } else if (x.kind !== 'points') S.info('vid check skipped (over 40M vertices)');
    st.textContent = `decoded ${E.bricks} bricks in ${secs} s`;
  } catch (e) { S.fail(`decoding failed: ${e.message}`); st.textContent = ''; btn.disabled = false; }
}

async function verifyHashes(zip, src, m, H, btn, st) {
  btn.disabled = true;
  const hex = (b) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
  let ok = 0, bad = 0, blocks = 0;
  const t0 = performance.now();
  for (const [name, info] of Object.entries(m.members || {})) {
    const e = zip.entries.get(name);
    if (!e) { H.fail(`${name}: listed in "members" but not in the archive`); bad++; continue; }
    const { offset, size } = await zip.dataRange(e);
    if (size !== info.size) { H.fail(`${name}: ${n(size)} bytes, manifest says ${n(info.size)}`); bad++; continue; }
    const B = info.block || 16777216;
    let memberOk = true;
    for (let i = 0, p = 0; p < size || (size === 0 && i === 0 && info.sha256.length); i++, p += B) {
      if (size === 0) break;
      st.textContent = `${name} — block ${i + 1}/${info.sha256.length}`;
      const d = hex(await crypto.subtle.digest('SHA-256', await src.read(offset + p, Math.min(B, size - p))));
      blocks++;
      if (d !== info.sha256[i]) { memberOk = false; H.fail(`${name}: block ${i} hash differs`); break; }
    }
    if (memberOk) ok++; else bad++;
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (!bad) H.pass(`all ${ok} members match their SHA-256 block hashes (${blocks} blocks)`);
  st.textContent = `checked in ${secs} s`;
}

function drawMap(canvas, wfr) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, Hh = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = Hh * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const boxes = [];
  for (const E of wfr.elements) for (let k = 0; k < E.bricks; k++) boxes.push([E, E.brickBox(k)]);
  if (!boxes.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [, b] of boxes) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); }
  const pad = 14, s = Math.min((W - 2 * pad) / ((x1 - x0) || 1), (Hh - 2 * pad - 14) / ((y1 - y0) || 1));
  const css = getComputedStyle(document.documentElement);
  const pal = ['--au-action', '--au-info', '--au-success', '--au-selected', '--au-warn', '--au-error'].map((v) => css.getPropertyValue(v).trim() || '#c80');
  const X = (x) => pad + (x - x0) * s, Y = (y) => Hh - pad - 14 - (y - y0) * s;
  g.lineWidth = 1;
  wfr.elements.forEach((E, i) => {
    g.strokeStyle = pal[i % pal.length]; g.globalAlpha = 0.85;
    for (const [EE, b] of boxes) if (EE === E) g.strokeRect(X(b[0]), Y(b[4]), Math.max(1, (b[3] - b[0]) * s), Math.max(1, (b[4] - b[1]) * s));
  });
  g.globalAlpha = 1; g.fillStyle = css.getPropertyValue('--au-fg-soft').trim() || '#888'; g.font = '11px ' + (css.getPropertyValue('--sw-mono').trim() || 'monospace');
  g.fillText(`x ${x0.toFixed(1)} … ${x1.toFixed(1)}   y ${y0.toFixed(1)} … ${y1.toFixed(1)}   ${boxes.length} bricks`, pad, Hh - 6);
  let lx = W - pad;
  wfr.elements.slice().reverse().forEach((E, ri) => {
    const i = wfr.elements.length - 1 - ri, label = E.name, w = g.measureText(label).width;
    lx -= w; g.fillStyle = pal[i % pal.length]; g.fillText(label, lx, Hh - 6); lx -= 14;
  });
}

$('#pick').onchange = (e) => { if (e.target.files[0]) inspect(e.target.files[0]); e.target.value = ''; };
const drop = $('#drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) inspect(e.dataTransfer.files[0]); };
