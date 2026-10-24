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

// Browser backing: the Origin Private File System, one file per spill under a fresh directory.
// On the main thread OPFS writes go through a FileSystemWritableFileStream whose data only becomes
// readable once it is closed — so each file closes its writer lazily on the first read and reopens
// it (keeping data) if writing resumes. (A worker could use sync access handles instead.)
export async function opfsBacking({ root: rootName = 'wfr-scratch' } = {}) {
  const top = await navigator.storage.getDirectory();
  const base = await top.getDirectoryHandle(rootName, { create: true });
  const dirName = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = await base.getDirectoryHandle(dirName, { create: true });
  return {
    root: `${rootName}/${dirName}`,
    async open(name) {
      const fh = await dir.getFileHandle(name, { create: true });
      let w = null, file = null;
      const writer = async () => { if (!w) { file = null; w = await fh.createWritable({ keepExistingData: true }); } return w; };
      return {
        write: async (u8, pos) => { await (await writer()).write({ type: 'write', position: pos, data: u8 }); },
        read: async (pos, len) => {
          if (w) { await w.close(); w = null; }
          if (!file) file = await fh.getFile();
          return new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
        },
        close: async () => { if (w) { await w.close(); w = null; } },
        remove: async () => { if (w) { try { await w.abort(); } catch { /* already closed */ } w = null; } await dir.removeEntry(name).catch(() => {}); },
      };
    },
    async dispose() { await base.removeEntry(dirName, { recursive: true }).catch(() => {}); },
  };
}

// Leftover scratch from runs that never disposed (a closed tab mid-conversion): remove it all.
export async function clearOpfsScratch({ root: rootName = 'wfr-scratch' } = {}) {
  const top = await navigator.storage.getDirectory();
  await top.removeEntry(rootName, { recursive: true }).catch(() => {});
}
