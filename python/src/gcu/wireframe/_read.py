"""Reading .wfr: memory-map the file, read the zip directory, the manifest and the Parquet footers;
decode bricks on demand. Coordinates come back in world units (float64)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from ._zip import members as _members

MIMETYPE = "application/vnd.gentropic.wireframe"
_CELL_COLS = {"lines": ["a", "b"], "triangles": ["a", "b", "c"]}
_CORE = {"x", "y", "z", "vid", "a", "b", "c"}


@dataclass
class Brick:
    positions: np.ndarray                 # (n, 3) world float64
    vid: np.ndarray | None                # (n,) welded identity (None for points without vid)
    cells: np.ndarray | None              # (m, k) brick-LOCAL row indices
    vertex_attributes: dict = field(default_factory=dict)
    cell_attributes: dict = field(default_factory=dict)


@dataclass
class Mesh:
    vertices: np.ndarray                  # (V, 3) world float64, indexed by vid
    cells: np.ndarray | None              # (m, k) vid indices
    vertex_attributes: dict = field(default_factory=dict)
    cell_attributes: dict = field(default_factory=dict)


def _np(col):
    if pa.types.is_string(col.type) or pa.types.is_large_string(col.type) or pa.types.is_dictionary(col.type):
        return np.asarray(col.to_pylist(), dtype=object)
    return col.to_numpy()


class Element:
    def __init__(self, wfr, meta):
        self._wfr, self.meta = wfr, meta
        self.name, self.kind = meta["name"], meta["kind"]
        self.coords, self.counts = meta["coords"], meta["counts"]
        self.topology, self.bbox = meta.get("topology"), meta.get("bbox")
        self.tables = {}
        for t in (["vertices"] if self.kind == "points" else ["vertices", "cells"]):
            m = wfr._members.get(meta["path"] + t + ".parquet")
            if m is None:
                raise ValueError(f"wfr: element {self.name!r} lacks {t}.parquet")
            if m.method != 0:
                raise ValueError(f"wfr: member {m.name} is compressed; .wfr members are stored")
            self.tables[t] = pq.ParquetFile(pa.BufferReader(wfr._map.read_at(m.size, m.offset)))
        self.n_bricks = self.tables["vertices"].metadata.num_row_groups
        if "cells" in self.tables and self.tables["cells"].metadata.num_row_groups != self.n_bricks:
            raise ValueError(f"wfr: element {self.name!r} breaks the brick invariant (row-group counts differ)")
        rows = [self.tables["vertices"].metadata.row_group(k).num_rows for k in range(self.n_bricks)]
        self.v_start = np.concatenate([[0], np.cumsum(rows)]).astype(np.int64)
        names = self.tables["vertices"].schema_arrow.names
        self._vcol = {n: i for i, n in enumerate(names)}
        if self.coords["mode"] == "grid":
            st = self.coords["step"]
            self._step = np.array(st if isinstance(st, (list, tuple)) else [st] * 3, np.float64)
            self._origin = np.array(self.coords["origin"], np.float64)
        else:
            self._step = self._origin = None

    def __repr__(self):
        return f"<wfr element {self.name!r} {self.kind}: {self.counts.get('cells', 0)} cells, {self.counts['vertices']} vertices, {self.n_bricks} bricks>"

    def _world(self, x, y, z):
        P = np.stack([x, y, z], axis=1).astype(np.float64)
        return P if self._step is None else self._origin + self._step * P

    def brick_bbox(self, k):
        """World [minx, miny, minz, maxx, maxy, maxz] of brick k, from the footer statistics alone."""
        rg = self.tables["vertices"].metadata.row_group(k)
        lo, hi = [], []
        for a in "xyz":
            st = rg.column(self._vcol[a]).statistics
            lo.append(st.min); hi.append(st.max)
        lo, hi = np.array(lo, np.float64), np.array(hi, np.float64)
        if self._step is not None:
            lo, hi = self._origin + self._step * lo, self._origin + self._step * hi
        return np.concatenate([lo, hi])

    def bricks_in(self, box):
        """Bricks whose bbox intersects box [minx, miny, minz, maxx, maxy, maxz] (footer only)."""
        box = np.asarray(box, np.float64)
        return [k for k in range(self.n_bricks) if (lambda b: (b[:3] <= box[3:]).all() and (b[3:] >= box[:3]).all())(self.brick_bbox(k))]

    def table(self, which="vertices", columns=None, bricks=None):
        """The raw Parquet table (stored values: grid integers, global row indices) of some bricks."""
        pf = self.tables[which]
        return pf.read_row_groups(list(range(self.n_bricks)) if bricks is None else list(bricks), columns=columns)

    def read_brick(self, k, vid=True, attributes=True) -> Brick:
        vt = self.tables["vertices"].read_row_group(k)
        pos = self._world(vt.column("x").to_numpy(), vt.column("y").to_numpy(), vt.column("z").to_numpy())
        v = vt.column("vid").to_numpy() if (vid and "vid" in vt.column_names) else None
        va = {n: _np(vt.column(n)) for n in vt.column_names if n not in _CORE} if attributes else {}
        cells, ca = None, {}
        if self.kind != "points":
            ct = self.tables["cells"].read_row_group(k)
            cols = _CELL_COLS[self.kind]
            cells = np.stack([ct.column(c).to_numpy() for c in cols], axis=1).astype(np.int64) - self.v_start[k]
            ca = {n: _np(ct.column(n)) for n in ct.column_names if n not in _CORE} if attributes else {}
        return Brick(pos, v, cells, va, ca)

    def to_mesh(self, attributes=True) -> Mesh:
        """The whole element, welded: vertices at their vid, cells as vid tuples (resident)."""
        V = self.counts["vertices"]
        if self.kind == "points":
            bricks = [self.read_brick(k, attributes=attributes) for k in range(self.n_bricks)]
            P = np.concatenate([b.positions for b in bricks]) if bricks else np.zeros((0, 3))
            if bricks and bricks[0].vid is not None:
                vid = np.concatenate([b.vid for b in bricks]).astype(np.int64)
                order = np.argsort(vid)
                P = P[order]
            else:
                order = None
            va = {n: (np.concatenate([b.vertex_attributes[n] for b in bricks]) if bricks else np.zeros(0)) for n in (bricks[0].vertex_attributes if bricks else {})}
            if order is not None:
                va = {n: a[order] for n, a in va.items()}
            return Mesh(P, None, va, {})
        verts = np.full((V, 3), np.nan)
        va, ca_parts, cells_parts = {}, {}, []
        for k in range(self.n_bricks):
            b = self.read_brick(k, attributes=attributes)
            verts[b.vid] = b.positions
            for n, a in b.vertex_attributes.items():
                if n not in va:
                    va[n] = np.empty(V, dtype=a.dtype)
                va[n][b.vid] = a
            cells_parts.append(b.vid[b.cells])
            for n, a in b.cell_attributes.items():
                ca_parts.setdefault(n, []).append(a)
        k = len(_CELL_COLS[self.kind])
        cells = np.concatenate(cells_parts) if cells_parts else np.zeros((0, k), np.int64)
        return Mesh(verts, cells, va, {n: np.concatenate(p) for n, p in ca_parts.items()})

    def to_pyvista(self):
        """A pyvista PolyData (needs `pip install gcu-wireframe[pyvista]`)."""
        import pyvista as pv
        m = self.to_mesh()
        if self.kind == "points":
            poly = pv.PolyData(m.vertices)
        else:
            k = m.cells.shape[1]
            flat = np.hstack([np.full((len(m.cells), 1), k), m.cells]).ravel()
            poly = pv.PolyData(m.vertices, faces=flat) if k == 3 else pv.PolyData(m.vertices, lines=flat)
        for n, a in m.vertex_attributes.items():
            poly.point_data[n] = a
        for n, a in m.cell_attributes.items():
            poly.cell_data[n] = a
        return poly


class WfrFile:
    """An open .wfr. Use as a context manager, or call close()."""

    def __init__(self, path):
        self.path = str(path)
        self._members = _members(self.path)
        self._map = pa.memory_map(self.path, "r")
        mt = self._members.get("mimetype")
        if mt is None or bytes(self._map.read_at(mt.size, mt.offset)) != MIMETYPE.encode():
            raise ValueError(f"{path}: not a wireframe file (mimetype)")
        mm = self._members.get("wireframe.json")
        if mm is None:
            raise ValueError(f"{path}: missing wireframe.json")
        self.manifest = json.loads(bytes(self._map.read_at(mm.size, mm.offset)))
        if self.manifest.get("format") != "wireframe":
            raise ValueError(f"{path}: manifest format is not 'wireframe'")
        if str(self.manifest.get("version", "")).split(".")[0] != "0":
            raise ValueError(f"{path}: unsupported wireframe version {self.manifest.get('version')}")
        self.elements = [Element(self, e) for e in self.manifest["elements"]]

    def __getitem__(self, name):
        for e in self.elements:
            if e.name == name:
                return e
        raise KeyError(name)

    def __iter__(self):
        return iter(self.elements)

    def __repr__(self):
        return f"<wfr {self.path!r}: {', '.join(e.name for e in self.elements)}>"

    def close(self):
        self.elements = []
        self._map.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def open(path) -> WfrFile:  # noqa: A001 — mirrors the builtin on purpose: gcu.wireframe.open(path)
    return WfrFile(path)
