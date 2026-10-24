"""Python reader/writer timings on the bench file (bench/out/bench.wfr from bench/build.mjs).
    python/.venv/Scripts/python bench/py_bench.py"""
import time
from pathlib import Path

import numpy as np

import gcu.wireframe as wf

root = Path(__file__).resolve().parent / "out"
src = root / "bench.wfr"
t = time.perf_counter()
f = wf.open(src)
print(f"open {1e3 * (time.perf_counter() - t):.1f} ms — {[e.name for e in f]}")
el = f["terrain"]
t = time.perf_counter()
tab_v, tab_c = el.table("vertices", ["x", "y", "z", "vid"]), el.table("cells")
dt = time.perf_counter() - t
raw = el.counts["vertexRows"] * 28 + el.counts["cells"] * 12
print(f"decode all core columns (pyarrow C++): {1e3 * dt:.0f} ms — {raw / dt / 1e9:.2f} GB/s raw-equiv")
t = time.perf_counter()
m = el.to_mesh(attributes=False)
print(f"to_mesh (welded, world float64): {1e3 * (time.perf_counter() - t):.0f} ms — {m.vertices.shape[0]:,} vertices, {m.cells.shape[0]:,} triangles")
t = time.perf_counter()
x0, y0 = el.bbox[0], el.bbox[1]
ks = el.bricks_in([x0 + 900, y0 + 900, -1e9, x0 + 1100, y0 + 1100, 1e9])
n = sum(len(el.read_brick(k, attributes=False).cells) for k in ks)
print(f"region 200×200 m: {len(ks)} bricks, {n:,} faces, {1e3 * (time.perf_counter() - t):.1f} ms")
f.close()
t = time.perf_counter()
man = wf.write(root / "py-bench.wfr", [wf.Triangles("terrain", m.vertices, m.cells)])
dt = time.perf_counter() - t
print(f"write {m.cells.shape[0]:,} triangles: {dt:.1f} s → {(root / 'py-bench.wfr').stat().st_size / 2**20:.1f} MB, {man['elements'][0]['counts']['bricks']} bricks")
t = time.perf_counter()
topo = wf.check_topology(m.cells)
print(f"check_topology: {time.perf_counter() - t:.1f} s → {topo}")
