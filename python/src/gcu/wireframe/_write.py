"""Writing .wfr from numpy arrays — the same algorithm as the JS reference writer (js/src/pipeline.js),
so the same input gives the same bricks, rows and vids in both languages (testdata/ checks it):
quantize (origin = floor of the first vertex), Morton keys of cell centroids over the stored bbox,
optional regroup by a label column, stable sort, cut into runs of `target` that never span a group,
vertices numbered by first use within each brick."""
from __future__ import annotations

import io
import json
import math
from dataclasses import dataclass, field

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from ._zip import ZipWriter, BLOCK
from ._topology import check_topology

MIMETYPE = "application/vnd.gentropic.wireframe"
FORMAT_VERSION = "0.1"
SPEC_URL = f"https://gentropic.org/wireframe/{FORMAT_VERSION}"
_K = {"points": 1, "lines": 2, "triangles": 3}
_CELL_COLS = {"lines": ["a", "b"], "triangles": ["a", "b", "c"]}
_RESERVED = {"x", "y", "z", "vid", "a", "b", "c"}


@dataclass
class _Element:
    name: str
    kind: str
    positions: np.ndarray
    cells: np.ndarray | None = None
    vertex_attributes: dict = field(default_factory=dict)
    cell_attributes: dict = field(default_factory=dict)
    step: float | tuple | None = 1e-4      # grid step; None → lossless float64 coordinates
    origin: tuple | None = None
    topology: str | dict | None = None     # "check" | a declared dict | None
    brick_by: str | None = None
    target: int = 65536
    keep_vid: bool = False                 # points only
    meta: dict = field(default_factory=dict)


def Triangles(name, vertices, faces, **kw):
    """A triangle element. vertices: (n, 3) world coordinates; faces: (m, 3) vertex indices."""
    return _Element(name, "triangles", np.asarray(vertices, np.float64), np.asarray(faces), **kw)


def Lines(name, vertices, segments, **kw):
    """A line-network element. segments: (m, 2) vertex indices (polylines as chains of segments)."""
    return _Element(name, "lines", np.asarray(vertices, np.float64), np.asarray(segments), **kw)


def Polylines(name, polylines, closed=False, cell_attributes=None, **kw):
    """A lines element from ordered polylines, keeping their order (SPEC §5: `line` + `seq`).
    polylines: a list of (n, 3) arrays; closed: one bool for all, or a list (a closed polyline gets a
    final segment back to its first vertex). Each polyline keeps its own vertices, so a string that
    revisits a point stays unambiguous. cell_attributes may hold per-POLYLINE values (one per
    polyline), spread to every segment of it."""
    pts, cells, line, seq, owner = [], [], [], [], []
    base = 0
    for i, p in enumerate(polylines):
        p = np.asarray(p, np.float64).reshape(-1, 3)
        n = len(p)
        c = closed[i] if isinstance(closed, (list, tuple, np.ndarray)) else closed
        if n < 2:
            continue
        idx = np.arange(base, base + n)
        segs = np.stack([idx[:-1], idx[1:]], axis=1)
        if c and n > 2:
            segs = np.vstack([segs, [[idx[-1], idx[0]]]])
        pts.append(p); cells.append(segs)
        line.append(np.full(len(segs), i, np.int32)); seq.append(np.arange(len(segs), dtype=np.int32)); owner.append(np.full(len(segs), i))
        base += n
    P = np.concatenate(pts) if pts else np.zeros((0, 3))
    S = np.concatenate(cells) if cells else np.zeros((0, 2), np.int64)
    own = np.concatenate(owner) if owner else np.zeros(0, np.int64)
    ca = {}
    for k_, v in (cell_attributes or {}).items():
        arr = np.asarray(v, dtype=object if len(v) and isinstance(v[0], str) else None)
        if len(arr) != len(polylines):
            raise ValueError(f"wfr write: polyline attribute {k_!r} needs one value per polyline ({len(polylines)})")
        ca[k_] = arr[own].tolist() if arr.dtype == object else arr[own]
    ca["line"] = np.concatenate(line) if line else np.zeros(0, np.int32)
    ca["seq"] = np.concatenate(seq) if seq else np.zeros(0, np.int32)
    return _Element(name, "lines", P, S, cell_attributes=ca, **kw)


def Points(name, points, **kw):
    """A point-set element. points: (n, 3)."""
    return _Element(name, "points", np.asarray(points, np.float64), None, **kw)


# ── Morton (16 bits per axis → 48-bit key) ────────────────────────────────────────────────────────
def _spread_table():
    q = np.arange(65536, dtype=np.uint64)
    out = np.zeros_like(q)
    for b in range(16):
        out |= ((q >> np.uint64(b)) & np.uint64(1)) << np.uint64(3 * b)
    return out


_SPREAD = _spread_table()   # bit b of a 16-bit value → bit 3b: one gather per axis instead of a bit loop


def _morton(x, y, z, bb):
    ext = max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) or 1
    s = 65535 / ext
    q = [np.clip(np.floor((v - bb[a]) * s), 0, 65535).astype(np.int64) for a, v in enumerate((x, y, z))]
    return _SPREAD[q[0]] | (_SPREAD[q[1]] << np.uint64(1)) | (_SPREAD[q[2]] << np.uint64(2))


def _js_round(x):
    """JavaScript's Math.round: nearest integer, halves toward +infinity (numpy rounds them to even)."""
    r = np.floor(x)
    return r + ((x - r) >= 0.5)


# ── attributes ────────────────────────────────────────────────────────────────────────────────────
_ATTR_TYPES = {  # numpy dtype → (arrow type, parquet encoding)
    "f8": (pa.float64(), "BYTE_STREAM_SPLIT"), "f4": (pa.float32(), "BYTE_STREAM_SPLIT"),
    "i4": (pa.int32(), "DELTA_BINARY_PACKED"), "u1": (pa.uint8(), "DELTA_BINARY_PACKED"),
    "u2": (pa.uint16(), "DELTA_BINARY_PACKED"), "i1": (pa.int8(), "DELTA_BINARY_PACKED"), "i2": (pa.int16(), "DELTA_BINARY_PACKED"),
}


def _attr(name, values, n):
    if isinstance(values, (list, tuple)) and values and isinstance(values[0], str) or (isinstance(values, np.ndarray) and values.dtype.kind in "UO"):
        arr = np.asarray(values, dtype=object)
        if len(arr) != n:
            raise ValueError(f"wfr write: attribute {name!r} has {len(arr)} values, expected {n}")
        return arr, "string"
    arr = np.asarray(values)
    key = arr.dtype.str[1:]
    if arr.dtype.kind == "u" and arr.dtype.itemsize == 4:   # uint32 has no lossless INT32 home → float64
        arr, key = arr.astype(np.float64), "f8"
    if arr.dtype.kind == "i" and arr.dtype.itemsize == 8:
        arr, key = arr.astype(np.float64), "f8"
    if key not in _ATTR_TYPES:
        raise ValueError(f"wfr write: attribute {name!r} dtype {arr.dtype} unsupported")
    if len(arr) != n:
        raise ValueError(f"wfr write: attribute {name!r} has {len(arr)} values, expected {n}")
    return arr, key


def _table(columns):
    """columns: [(name, values, kind)] — kind is an _ATTR_TYPES key, 'grid' (int32 coords), 'f64c' or 'string'."""
    fields, arrays, enc, dict_cols = [], [], {}, []
    for name, values, kind in columns:
        if kind == "string":
            arrays.append(pa.array(values.tolist(), type=pa.string()))
            fields.append(pa.field(name, pa.string(), nullable=False))
            dict_cols.append(name)
            continue
        if kind == "grid":
            t, e = pa.int32(), "DELTA_BINARY_PACKED"
        elif kind == "f64c":
            t, e = pa.float64(), "BYTE_STREAM_SPLIT"
        else:
            t, e = _ATTR_TYPES[kind]
        arrays.append(pa.array(values, type=t))
        fields.append(pa.field(name, t, nullable=False))
        enc[name] = e
    return pa.Table.from_arrays(arrays, schema=pa.schema(fields)), enc, dict_cols


def _parquet(columns, row_groups, kv):
    tab, enc, dict_cols = _table(columns)
    tab = tab.replace_schema_metadata({"wireframe": kv})
    buf = io.BytesIO()
    w = pq.ParquetWriter(buf, tab.schema, compression="none", use_dictionary=dict_cols or False,
                         column_encoding=enc or None, write_statistics=True, data_page_version="1.0",
                         store_schema=True)   # pyarrow writes user metadata (the wireframe kv, SPEC §6.3) only alongside its schema
    at = 0
    for n in row_groups:                      # one write per brick → exactly one row group per brick
        w.write_table(tab.slice(at, n), row_group_size=max(1, n))
        at += n
    w.close()
    return buf.getvalue()


# ── one element ───────────────────────────────────────────────────────────────────────────────────
def _build(el: _Element):
    k = _K.get(el.kind)
    if k is None:
        raise ValueError(f"wfr write: element {el.name!r} kind {el.kind!r}")
    for n in [*el.vertex_attributes, *el.cell_attributes]:
        if n in _RESERVED:
            raise ValueError(f"wfr write: attribute name {n!r} is reserved")
    V = np.ascontiguousarray(el.positions, np.float64).reshape(-1, 3)
    nv = len(V)
    if not np.isfinite(V).all():
        raise ValueError(f"wfr write: element {el.name!r} has a non-finite coordinate")
    grid = el.step is not None
    if el.kind == "points":
        if el.cell_attributes:
            raise ValueError("wfr write: points elements have no cells — put attributes on vertices")
        cells = np.arange(nv, dtype=np.int64).reshape(-1, 1)
    else:
        cells = np.asarray(el.cells, dtype=np.int64).reshape(-1, k)
        if cells.size and (cells.min() < 0 or cells.max() >= nv):
            raise ValueError(f"wfr write: element {el.name!r} has a cell index outside 0…{nv - 1}")
        if k == 2 and (cells[:, 0] == cells[:, 1]).any() or k == 3 and ((cells[:, 0] == cells[:, 1]) | (cells[:, 1] == cells[:, 2]) | (cells[:, 0] == cells[:, 2])).any():
            raise ValueError("wfr write: a cell repeats a vertex")
    m = len(cells)
    # quantize
    if grid:
        S = np.array(el.step if isinstance(el.step, (tuple, list)) else (el.step,) * 3, np.float64)
        origin = np.array(el.origin if el.origin is not None else (np.floor(V[0]) if nv else (0, 0, 0)), np.float64)
        Q = _js_round((V - origin) / S)
        if Q.size and (Q.min() < -2**31 or Q.max() > 2**31 - 1):
            raise ValueError(f"wfr write: element {el.name!r} overflows INT32 at step {el.step} — use a coarser step or step=None (float64)")
        P = Q.astype(np.int32)
        PF = Q
    else:
        S = origin = None
        P = PF = V
    bb = [*(PF.min(axis=0) if nv else (0, 0, 0)), *(PF.max(axis=0) if nv else (0, 0, 0))]
    # keys: centroids (sequential sum, as the reference does) → Morton → optional group prefix
    cen = PF[cells[:, 0]]                                   # one corner at a time: no (m, k, 3) copy
    for j in range(1, k):
        cen = cen + PF[cells[:, j]]
    cen = cen / k
    key48 = _morton(cen[:, 0], cen[:, 1], cen[:, 2], bb) if m else np.zeros(0, np.uint64)
    group = np.zeros(m, np.int64)
    G = 1
    if el.brick_by:
        src = el.cell_attributes if el.kind != "points" else el.vertex_attributes
        if el.brick_by not in src:
            raise ValueError(f"wfr write: brick_by {el.brick_by!r} is not a {'vertex' if el.kind == 'points' else 'cell'} attribute")
        vals = np.asarray(src[el.brick_by], dtype=object if isinstance(src[el.brick_by][0], str) else None)
        uniq = sorted(set(vals.tolist()))
        rank = {v: i for i, v in enumerate(uniq)}
        group = np.array([rank[v] for v in vals.tolist()], np.int64)
        G = max(1, len(uniq))
    gbits = 0 if G <= 1 else math.ceil(math.log2(G))
    kb = min(48, 53 - gbits)
    sort_key = group.astype(np.uint64) * np.uint64(2 ** kb) + (key48 >> np.uint64(48 - kb))
    order = np.argsort(sort_key, kind="stable")
    g_sorted = group[order]
    # bricks: runs of ≤ target, never spanning a group
    starts, s = [], 0
    while s < m:
        e = min(m, s + el.target)
        if el.brick_by:
            ch = np.nonzero(g_sorted[s + 1:e] != g_sorted[s])[0]
            if len(ch):
                e = s + 1 + int(ch[0])
        starts.append((s, e))
        s = e
    # vertex identity: indexed → rank among referenced vertices; points → input index
    if el.kind == "points":
        vid_of = np.arange(nv, dtype=np.int64)
        V_count = nv
    else:
        ref = np.zeros(nv, bool)
        ref[cells.ravel()] = True
        vid_of = np.cumsum(ref) - 1
        V_count = int(ref.sum())
    # rows by first use within each brick
    sc = cells[order]                                       # (m, k) input vertex indices, brick order
    # first-use rows, brick by brick, in linear time: scattering corner positions REVERSED leaves each
    # vertex's FIRST position in the scratch array (numpy keeps the last write of a repeated index)
    corner_v = sc.ravel()
    corner_row = np.empty(len(corner_v), np.int64)
    first_pos = np.empty(nv, np.int64)
    local_id = np.empty(nv, np.int64)
    row_parts, v_counts, base = [], [], 0
    for s0, e0 in starts:
        cv = corner_v[s0 * k:e0 * k]
        pos = np.arange(len(cv))
        first_pos[cv[::-1]] = pos[::-1]
        is_first = first_pos[cv] == pos
        rows_v = cv[is_first]                               # this brick's vertices, by first use
        local_id[rows_v] = np.arange(len(rows_v))
        corner_row[s0 * k:e0 * k] = base + local_id[cv]
        row_parts.append(rows_v)
        v_counts.append(len(rows_v))
        base += len(rows_v)
    row_vertex = np.concatenate(row_parts) if row_parts else np.zeros(0, np.int64)
    n_rows = base
    c_counts = [e0 - s0 for s0, e0 in starts]
    # tables
    kind_c = "grid" if grid else "f64c"
    RP = P[row_vertex]
    vcols = [("x", RP[:, 0], kind_c), ("y", RP[:, 1], kind_c), ("z", RP[:, 2], kind_c)]
    keep_vid = el.kind != "points" or el.keep_vid
    if keep_vid:
        vcols.append(("vid", vid_of[row_vertex].astype(np.int32), "i4"))
    va_meta = []
    for n_, values in el.vertex_attributes.items():
        arr, kind = _attr(n_, values, nv)
        vcols.append((n_, arr[row_vertex], kind))
        va_meta.append(n_)
    coords = {"mode": "grid", "origin": [float(v) for v in origin], "step": el.step} if grid else {"mode": "float64"}
    kv = lambda table: json.dumps({"version": FORMAT_VERSION, "spec": SPEC_URL, "element": el.name, "kind": el.kind, "table": table, **({"coords": coords} if table == "vertices" else {})})
    path = f"elements/{_pct(el.name)}/"
    members = [(path + "vertices.parquet", _parquet(vcols, v_counts, kv("vertices")))]
    ca_meta = []
    if el.kind != "points":
        ccols = [(nm, corner_row.reshape(m, k)[:, j].astype(np.int32), "i4") for j, nm in enumerate(_CELL_COLS[el.kind])]
        for n_, values in el.cell_attributes.items():
            arr, kind = _attr(n_, values, m)
            ccols.append((n_, arr[order], kind))
            ca_meta.append(n_)
        members.append((path + "cells.parquet", _parquet(ccols, c_counts, kv("cells"))))
    # directory (world bboxes from stored values), manifest bbox
    to_world = (lambda q, a: float(origin[a] + S[a] * q)) if grid else (lambda q, a: float(q))
    directory, r0 = [], 0
    for b, nr in enumerate(v_counts):
        blk = PF[row_vertex[r0:r0 + nr]]
        directory.append([nr, c_counts[b] if el.kind != "points" else 0, [to_world(v, i % 3) for i, v in enumerate([*blk.min(axis=0), *blk.max(axis=0)])]])
        r0 += nr
    topology = None
    if el.kind == "triangles":
        if el.topology == "check":
            vid_cells = vid_of[sc]
            corner_pos = PF[sc]                             # stored units, brick order
            topology = check_topology(vid_cells, corner_pos, S if grid else None, V_count)
        else:
            topology = {"closed": None, "oriented": None, "manifold": None, "volume": None, **(el.topology or {}), "status": "declared"}
    manifest = {
        "name": el.name, "path": path, "kind": el.kind, "coords": coords,
        "counts": {"vertices": V_count, "vertexRows": n_rows, "cells": 0 if el.kind == "points" else m, "bricks": len(starts)},
        "bbox": [to_world(v, i % 3) for i, v in enumerate(bb)] if m else None,
        **({"topology": topology} if topology else {}),
        "bricks": {"order": {"by": [el.brick_by] if el.brick_by else [], "then": "morton"}, "target": el.target, "directory": directory},
        "columns": [*({"location": "vertices", "name": n_, "member": "vertices.parquet"} for n_ in va_meta),
                    *({"location": "cells", "name": n_, "member": "cells.parquet"} for n_ in ca_meta)],
        "meta": el.meta or {},
    }
    return manifest, members


def _pct(s):
    from urllib.parse import quote
    return quote(s, safe="-_.!~*'()")


def write(path, elements, frame=None, meta=None) -> dict:
    """Write elements (Triangles / Lines / Points) to a .wfr. Returns the manifest."""
    names = [e.name for e in elements]
    if len(set(names)) != len(names):
        raise ValueError("wfr write: duplicate element names")
    built = [_build(e) for e in elements]
    with open(path, "wb") as f:
        z = ZipWriter(f)
        z.add("mimetype", MIMETYPE.encode(), aligned=False)
        members = {}
        for _, mem in built:
            for name, data in mem:
                info = z.add(name, data)
                members[name] = {"size": info["size"], "block": BLOCK, "sha256": info["sha256"]}
        mans = [m for m, _ in built]
        fr = frame or {"origin": next((m["coords"]["origin"] for m in mans if "origin" in m["coords"]), [0, 0, 0])}
        manifest = {"format": "wireframe", "version": FORMAT_VERSION, "spec": SPEC_URL, "frame": {"crs": None, "units": "m", **fr},
                    "elements": mans, "members": members, "meta": meta or {}}
        z.add("wireframe.json", json.dumps(manifest).encode())
        z.finish()
    return manifest
