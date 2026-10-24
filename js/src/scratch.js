// Scratch storage for the streaming writer: append-only spills of chunks that stay in memory
// while the store is under budget and go to a backing store (temp files, OPFS…) beyond it.
// With no backing, everything stays resident — the in-memory writer is just this with no limit.
//
// backing: { open(name) → Promise<{ write(u8, pos), read(pos, len) → Promise<u8>, close(), remove() }> }

export function createScratch({ backing = null, budget = Infinity } = {}) {
  let resident = 0, seq = 0, peakResident = 0, spilledBytes = 0;
  const store = {
    get resident() { return resident; },
    get stats() { return { peakResident, spilledBytes }; },
    budget,
    spill(label = 'spill') {
      const name = `${label}-${seq++}`;
      const chunks = []; // { mem: Uint8Array|null, pos, len }
      let file = null, filePos = 0, bytes = 0, deleted = false;
      return {
        name,
        get bytes() { return bytes; },
        get chunkCount() { return chunks.length; },
        // takes ownership of u8
        async append(u8) {
          if (deleted) throw new Error(`scratch: append to deleted ${name}`);
          bytes += u8.length;
          if (!backing || resident + u8.length <= budget) {
            chunks.push({ mem: u8, pos: 0, len: u8.length });
            resident += u8.length;
            if (resident > peakResident) peakResident = resident;
            return;
          }
          if (!file) file = await backing.open(name);
          await file.write(u8, filePos);
          chunks.push({ mem: null, pos: filePos, len: u8.length });
          filePos += u8.length; spilledBytes += u8.length;
        },
        async *read() {
          for (const c of chunks) yield c.mem ? c.mem : await file.read(c.pos, c.len);
        },
        async readChunk(i) { const c = chunks[i]; return c.mem ? c.mem : file.read(c.pos, c.len); },
        async delete() {
          if (deleted) return;
          deleted = true;
          for (const c of chunks) if (c.mem) resident -= c.len;
          chunks.length = 0;
          if (file) { await file.close(); await file.remove(); file = null; }
        },
      };
    },
  };
  return store;
}

// Node backing: one file per spill under a fresh temp directory.
export async function nodeBacking(dir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const root = dir || await fs.mkdtemp(path.join(os.tmpdir(), 'wfr-'));
  return {
    root,
    async open(name) {
      const p = path.join(root, name);
      const fh = await fs.open(p, 'w+');
      return {
        write: async (u8, pos) => { await fh.write(u8, 0, u8.length, pos); },
        read: async (pos, len) => { const b = new Uint8Array(len); await fh.read(b, 0, len, pos); return b; },
        close: () => fh.close(),
        remove: () => fs.rm(p, { force: true }),
      };
    },
    async dispose() { await fs.rm(root, { recursive: true, force: true }); },
  };
}
