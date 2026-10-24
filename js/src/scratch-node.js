// Node backing for the streaming writer: one file per spill under a FRESH directory created inside
// `dir` (default: the OS temp dir). dispose() removes only that fresh directory — never the caller's.
// Kept out of index.js so browser bundles carry no node: imports.
import { mkdir, mkdtemp, open as fsOpen, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function nodeBacking(dir) {
  const parent = dir || tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'wfr-'));
  return {
    root,
    async open(name) {
      const p = join(root, name);
      const fh = await fsOpen(p, 'w+');
      return {
        write: async (u8, pos) => { await fh.write(u8, 0, u8.length, pos); },
        read: async (pos, len) => { const b = new Uint8Array(len); await fh.read(b, 0, len, pos); return b; },
        close: () => fh.close(),
        remove: () => rm(p, { force: true }),
      };
    },
    async dispose() { await rm(root, { recursive: true, force: true }); },
  };
}
