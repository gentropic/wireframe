// Site smoke: serve site/ at /wireframe/ (the path Pages uses) and drive every page in Chromium —
// no console errors or CSP violations; the spec renders; the converter turns a PLY + DXF into a .wfr
// (download path); the inspector opens it, finds no failures, and passes the deep check and the hashes.
//   node site/smoke.mjs [--shots]
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('.', import.meta.url));
const shots = process.argv.includes('--shots');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith('/wireframe/')) { res.writeHead(404); return res.end(); }
  p = p.slice('/wireframe/'.length); if (p === '' || p.endsWith('/')) p += 'index.html';
  try { const data = await readFile(join(site, p)); res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/wireframe/`;

// fixtures: a coloured PLY terrain (indexed) and a DXF (3DFACE cube + a polyline + a point)
function ply(n) {
  const w = n + 1, nv = w * w, nf = 2 * n * n;
  const hdr = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${nv}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`);
  const vb = Buffer.alloc(nv * 27);
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) { const k = j * w + i; vb.writeDoubleLE(612000 + i, 27 * k); vb.writeDoubleLE(7300000 + j, 27 * k + 8); vb.writeDoubleLE(400 + Math.sin(i / 7), 27 * k + 16); vb[27 * k + 24] = i & 255; vb[27 * k + 25] = j & 255; vb[27 * k + 26] = 90; }
  const fb = Buffer.alloc(nf * 13); let f = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * w + i, b = a + 1, c = a + w, d = c + 1; for (const t of [[a, b, d], [a, d, c]]) { fb[13 * f] = 3; t.forEach((v, q) => fb.writeInt32LE(v, 13 * f + 1 + 4 * q)); f++; } }
  return Buffer.concat([hdr, vb, fb]);
}
const cube = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((c, a) => [612050, 7300050, 380][a] + c * 10));
let dxf = '0\nSECTION\n2\nENTITIES\n';
[[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]].forEach((q) => { dxf += '0\n3DFACE\n8\nORE\n62\n1\n'; q.forEach((v, k) => { dxf += `${10 + k}\n${cube[v][0]}\n${20 + k}\n${cube[v][1]}\n${30 + k}\n${cube[v][2]}\n`; }); });
dxf += '0\nPOLYLINE\n8\nCREST\n66\n1\n70\n8\n'; for (let i = 0; i < 4; i++) dxf += `0\nVERTEX\n8\nCREST\n10\n${612000 + i * 5}\n20\n7300090\n30\n${395 + i}\n70\n32\n`;
dxf += '0\nSEQEND\n0\nPOINT\n8\nPEGS\n10\n612001\n20\n7300001\n30\n401\n0\nENDSEC\n0\nEOF\n';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1200, height: 820 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showSaveFilePicker; });   // exercise the download path
let ok = true; const chk = (n, c) => { console.log(`${c ? 'ok ' : 'FAIL'} ${n}`); ok = ok && c; };
const p = await ctx.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push(e.message));

await p.goto(BASE, { waitUntil: 'load' });
chk('landing: renders, links to spec / convert / inspect', (await p.locator('.card').count()) >= 3 && /wireframe/.test(await p.title()));
if (shots) await p.screenshot({ path: join(site, '../bench/out/site-landing.png'), fullPage: true });
await p.goto(BASE + '0.1/', { waitUntil: 'load' });
const spec = await p.evaluate(() => ({ h2: document.querySelectorAll('.doc h2').length, tables: document.querySelectorAll('.doc table').length, toc: document.querySelectorAll('.toc a').length, anchor: !!document.getElementById(document.querySelector('.toc a').getAttribute('href').slice(1)) }));
chk(`spec 0.1: ${spec.h2} sections, ${spec.tables} tables, contents links resolve`, spec.h2 >= 10 && spec.tables >= 5 && spec.toc === spec.h2 && spec.anchor);
if (shots) await p.screenshot({ path: join(site, '../bench/out/site-spec.png') });

await p.goto(BASE + 'convert/', { waitUntil: 'load' });
await p.setInputFiles('#pick', [{ name: 'terrain.ply', mimeType: 'application/octet-stream', buffer: ply(80) }, { name: 'pit.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from(dxf) }]);
chk('convert: two files listed, output name suggested', (await p.locator('#files li').count()) === 2 && (await p.inputValue('#outName')) === 'terrain-set.wfr');
await p.check('#topo');
const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.click('#go')]);
const result = await p.textContent('#result');
console.log(result.trim());
chk('convert: 4 elements (terrain, pit, pit:strings, pit:points), cube checked closed', /terrain\s+triangles\s+12,800/.test(result) && /pit\s+triangles\s+12 .* closed oriented manifold · 1000\.0/.test(result) && /pit:strings/.test(result) && /pit:points/.test(result));
const wfrPath = join(site, '../bench/out/site-smoke.wfr');
await dl.saveAs(wfrPath);
if (shots) await p.screenshot({ path: join(site, '../bench/out/site-convert.png'), fullPage: true });

await p.goto(BASE + 'inspect/', { waitUntil: 'load' });
await p.setInputFiles('#pick', wfrPath);
await p.waitForSelector('.checks li');
const fails = await p.locator('.checks li.fail').allTextContents();
chk('inspect: opens the converted file with no failures', fails.length === 0 && (await p.locator('.checks li.pass').count()) >= 10);
if (fails.length) console.log(fails);
for (const btn of await p.locator('button', { hasText: 'deep check' }).all()) await btn.click();
await p.locator('button', { hasText: 'verify SHA-256' }).click();
await p.waitForFunction(() => /all \d+ members match/.test(document.body.textContent) && [...document.querySelectorAll('.status')].filter((s) => /decoded/.test(s.textContent)).length === 4, null, { timeout: 60000 });
const after = await p.evaluate(() => ({ fail: [...document.querySelectorAll('.checks li.fail')].map((l) => l.textContent), invariant: document.querySelectorAll('.checks li.pass').length, text: document.body.textContent }));
chk('inspect: deep check passes on every element (invariant, used rows, dense vid), hashes match', after.fail.length === 0 && /brick invariant holds/.test(after.text) && /vid dense/.test(after.text) && /members match their SHA-256/.test(after.text));
if (shots) await p.screenshot({ path: join(site, '../bench/out/site-inspect.png'), fullPage: true });
chk('no console errors or CSP violations on any page', errors.length === 0);
if (errors.length) console.log(errors);
await b.close(); server.close();
console.log(ok ? 'SITE SMOKE: PASS' : 'SITE SMOKE: FAIL');
process.exit(ok ? 0 : 1);
