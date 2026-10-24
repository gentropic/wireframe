import time
from pathlib import Path
import numpy as np
import gcu.wireframe as wf

with wf.open(Path(__file__).resolve().parent / "out" / "bench.wfr") as f:
    F = f["terrain"].to_mesh(attributes=False).cells.astype(np.int64)
m = len(F)
t = time.perf_counter(); lap = lambda s: print(f"{s:28s} {time.perf_counter() - t:6.2f} s")
u = F.ravel(); v = F[:, [1, 2, 0]].ravel()
lo, hi = np.minimum(u, v), np.maximum(u, v)
o = np.argsort(lo * (int(F.max()) + 1) + hi); lap("argsort")
lo_s, hi_s = lo[o], hi[o]
new = np.ones(len(o), bool); new[1:] = (lo_s[1:] != lo_s[:-1]) | (hi_s[1:] != hi_s[:-1]); eid = np.cumsum(new) - 1
tot = np.bincount(eid); lap("eid + bincount")
nb = np.tile(np.arange(3 * m), (2, 1))
pair = np.nonzero(eid[:-1] == eid[1:])[0]
h1, h2 = o[pair], o[pair + 1]
f1, j1, f2, j2 = h1 // 3, h1 % 3, h2 // 3, h2 % 3
s1, e1 = 3 * f1 + j1, 3 * f1 + (j1 + 1) % 3
s2, e2 = 3 * f2 + j2, 3 * f2 + (j2 + 1) % 3
same = F[f1, j1] == F[f2, j2]
a2, b2 = np.where(same, s2, e2), np.where(same, e2, s2)
sa2, sb2 = np.where(same, 0, 1), np.where(same, 1, 0)
nb[0, s1], nb[1, e1] = a2, b2
nb[sa2, a2], nb[sb2, b2] = s1, e1; lap("neighbours")
lab = np.arange(3 * m); it = 0
while True:
    it += 1
    nxt = np.minimum(lab, np.minimum(lab[nb[0]], lab[nb[1]])); nxt = nxt[nxt]
    if np.array_equal(nxt, lab): break
    lab = nxt
lap(f"propagation ({it} rounds)")
key = np.unique(F.ravel() * (3 * m) + lab); lap("unique")
fans = np.bincount(key // (3 * m)); lap("bincount")
