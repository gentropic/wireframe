#!/usr/bin/env node
// Build the gentropic.org/wireframe site into site/ (outputs are committed; Pages just publishes).
//   - <version>/index.html: SPEC.md rendered (a frozen snapshot per format version — the URL every
//     .wfr's manifest points to). An existing snapshot is NOT overwritten unless --force.
//   - lib/: the browser bundles the converter + inspector import (wireframe core + adapters, @gcu/dxf)
//   - assets/: Switchboard tokens + fonts (self-hosted, so the pages work anywhere, offline)
// Needs a sibling checkout of gentropic/auditable (for @gcu/build, @gcu/markdown, @gcu/dxf, Switchboard):
//   node site/build.mjs [--force]        (or AUDITABLE=<path>)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const site = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(site, '..');
const au = resolve(process.env.AUDITABLE || join(repo, '../auditable'));
if (!existsSync(join(au, 'ext/build/src/main.js'))) throw new Error(`auditable checkout not found at ${au} (set AUDITABLE=…)`);
const force = process.argv.includes('--force');
const { bundle } = await import(pathToFileURL(join(au, 'ext/build/src/main.js')).href);
const md = await import(pathToFileURL(join(au, 'ext/markdown/index.js')).href);
const rev = (() => { try { return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const { FORMAT_VERSION } = await import(new URL('../js/src/wfr.js', import.meta.url));

// ── assets ──
mkdirSync(join(site, 'assets/fonts'), { recursive: true });
copyFileSync(join(au, 'ext/switchboard/switchboard.css'), join(site, 'assets/switchboard.css'));
for (const f of readdirSync(join(au, 'ext/switchboard/fonts'))) copyFileSync(join(au, 'ext/switchboard/fonts', f), join(site, 'assets/fonts', f));

// ── lib ──
mkdirSync(join(site, 'lib'), { recursive: true });
for (const [entry, out] of [['src/index.js', 'wireframe.js'], ['src/convert.js', 'convert.js']]) {
  const r = bundle({ dir: join(repo, 'js'), entry, write: false, sourcemap: false, meta: false, header: `// @gcu/wireframe (${entry}) @ ${rev} — built by site/build.mjs (MIT)` });
  writeFileSync(join(site, 'lib', out), r.code);
}
copyFileSync(join(au, 'ext/dxf/index.js'), join(site, 'lib/dxf.js'));   // @gcu/dxf (MIT) — createSceneStream for the converter

// ── the spec snapshot ──
const page = ({ title, desc, body, depth, extraHead = '' }) => {
  const up = '../'.repeat(depth);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="icon" type="image/svg+xml" href="${up}assets/icon.svg">
<script src="${up}assets/theme.js"></script>
<link rel="stylesheet" href="${up}assets/switchboard.css">
<link rel="stylesheet" href="${up}assets/site.css">
${extraHead}</head>
<body>
<header class="top"><a class="brand" href="${up}">wireframe <span>.wfr</span></a>
<nav><a href="${up}${FORMAT_VERSION}/">spec</a><a href="${up}convert/">convert</a><a href="${up}inspect/">inspect</a><a href="https://github.com/gentropic/wireframe">source</a><button class="theme" id="themeToggle" title="light / dark">◐</button></nav></header>
${body}
<footer>MIT · <a href="https://gentropic.org">Geoscientific Chaos Union</a> · nothing on these pages talks to a server — your files stay in your browser</footer>
<script type="module" src="${up}assets/chrome.js"></script>
</body>
</html>
`;
};
const specDir = join(site, FORMAT_VERSION);
if (!existsSync(join(specDir, 'index.html')) || force) {
  mkdirSync(specDir, { recursive: true });
  const src = readFileSync(join(repo, 'SPEC.md'), 'utf8');
  const html = md.render(src, md.presets.docs);
  const toc = [...src.matchAll(/^## (.+)$/gm)].map((m) => `<a href="#${md.slugify(m[1])}">${md.escapeHtml(m[1]).replace(/`([^`]*)`/g, '<code>$1</code>')}</a>`).join('');
  writeFileSync(join(specDir, 'index.html'), page({
    title: `wireframe ${FORMAT_VERSION} — specification`,
    desc: `The .wfr wireframe format, version ${FORMAT_VERSION}.`,
    depth: 1,
    body: `<main class="spec"><aside class="toc"><div class="toc-h">contents</div>${toc}</aside><article class="doc">
<p class="stamp">snapshot of SPEC.md @ gentropic/wireframe ${rev} · <a href="https://github.com/gentropic/wireframe/blob/main/SPEC.md">latest on GitHub</a></p>
${html}</article></main>`,
  }));
  console.log(`wrote ${FORMAT_VERSION}/index.html`);
} else console.log(`${FORMAT_VERSION}/index.html exists — a published spec snapshot is frozen (use --force while it is still a draft)`);

// ── pages that share the chrome (landing, convert, inspect) are hand-written *.src.html bodies ──
for (const [dir, title, desc, depth] of [['', 'wireframe — .wfr', 'A single-file container for large meshes, line networks and point sets, read by byte range.', 0], ['convert', 'convert to .wfr', 'Convert PLY, OBJ and DXF to .wfr in your browser.', 1], ['inspect', 'inspect a .wfr', 'Open a .wfr and check it against the specification, in your browser.', 1]]) {
  const body = readFileSync(join(site, dir, 'body.src.html'), 'utf8');
  const script = existsSync(join(site, dir, 'app.js')) ? `<script type="module" src="app.js"></script>\n` : '';
  writeFileSync(join(site, dir, 'index.html'), page({ title, desc, depth, body, extraHead: script }));
  console.log(`wrote ${dir || '.'}/index.html`);
}
