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
    """One element. Its Parquet footers are parsed lazily, the first time something needs them —
    opening a file costs only the zip directory and the manifest."""

    def __init__(self, wfr, meta):
        self._wfr, self.meta = wfr, meta
        self.name, self.kind = meta["name"], meta["kind"]
        self.coords, self.counts = meta["coords"], meta["counts"]
        self.topology, self.bbox = meta.get("topology"), meta.get("bbox")
        self._members = {}
        for t in (["vertices"] if self.kind == "points" else ["vertices", "cells"]):
            m = wfr._members.get(meta["path"] + t + ".parquet")
            if m is None:
                raise ValueError(f"wfr: element {self.name!r} lacks {t}.parquet")
            if m.method != 0:
                raise ValueError(f"wfr: member {m.name} is compressed; .wfr members are stored")
            self._members[t] = m
        self._tables = None
        if self.coords["mode"] == "grid":
            st = self.coords["step"]
            self._step = np.array(st if isinstance(st, (list, tuple)) else [st] * 3, np.float64)
            self._origin = np.array(self.coords["origin"], np.float64)
        else:
            self._step = self._origin = None

    @property
    def tables(self) -> dict:
        """{'vertices': ParquetFile, 'cells': ParquetFile} — footers parsed on first access."""
        if self._tables is None:
            mp = self._wfr._map
            tabs = {t: pq.ParquetFile(pa.BufferReader(mp.read_at(m.size, m.offset))) for t, m in self._members.items()}
            nb = tabs["vertices"].metadata.num_row_groups
            if "cells" in tabs and tabs["cells"].metadata.num_row_groups != nb:
                raise ValueError(f"wfr: element {self.name!r} breaks the brick invariant (row-group counts differ)")
            rows = [tabs["vertices"].metadata.row_group(k).num_rows for k in range(nb)]
            self._v_start = np.concatenate([[0], np.cumsum(rows)]).astype(np.int64)
            self._vcol = {n: i for i, n in enumerate(tabs["vertices"].schema_arrow.names)}
            self._tables = tabs
        return self._tables

    @property
    def n_bricks(self) -> int:
        return self.tables["vertices"].metadata.num_row_groups

    @property
    def v_start(self):
        """First vertex row of each brick (and the total, last)."""
        self.tables
        return self._v_start

    def __repr__(self):
        return f"<wfr element {self.name!r} {self.kind}: {self.counts.get('cells', 0)} cells, {self.counts['vertices']} vertices, {self.counts['bricks']} bricks>"

    def _world(self, x, y, z):
        P = np.stack([x, y, z], axis=1).astype(np.float64)
        return P if self._step is None else self._origin + self._step * P

    def brick_bbox(self, k):
        """World [minx, miny, minz, maxx, maxy, maxz] of brick k, from the footer statistics alone."""
        rg = self.tables["vertices"].metadata.row_group(k)   # (self.tables also fills _vcol)
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
        # one brick is a small read: pyarrow's thread pool costs more than it saves here
        vt = self.tables["vertices"].read_row_group(k, use_threads=False)
        pos = self._world(vt.column("x").to_numpy(), vt.column("y").to_numpy(), vt.column("z").to_numpy())
        v = vt.column("vid").to_numpy() if (vid and "vid" in vt.column_names) else None
        va = {n: _np(vt.column(n)) for n in vt.column_names if n not in _CORE} if attributes else {}
        cells, ca = None, {}
        if self.kind != "points":
            ct = self.tables["cells"].read_row_group(k, use_threads=False)
            cols = _CELL_COLS[self.kind]
            cells = np.stack([ct.column(c).to_numpy() for c in cols], axis=1).astype(np.int64) - self.v_start[k]
            ca = {n: _np(ct.column(n)) for n in ct.column_names if n not in _CORE} if attributes else {}
        return Brick(pos, v, cells, va, ca)

    def to_mesh(self, attributes=True) -> Mesh:
        """The whole element, welded: vertices at their vid, cells as vid tuples (resident).
        Whole tables in one threaded read each, then a vectorized scatter — cells hold GLOBAL vertex
        rows, so vid[cell] is each corner's identity without any per-brick work."""
        vnames = self.tables["vertices"].schema_arrow.names
        keep = [n for n in vnames if n in ("x", "y", "z", "vid") or (attributes and n not in _CORE)]
        vt = self.tables["vertices"].read(columns=keep)
        pos = self._world(vt.column("x").to_numpy(), vt.column("y").to_numpy(), vt.column("z").to_numpy())
        vattr = {n: _np(vt.column(n)) for n in keep if n not in _CORE}
        if "vid" not in vt.column_names:                    # points without vid: identity = row
            return Mesh(pos, None, vattr, {})
        vid = vt.column("vid").to_numpy().astype(np.int64)
        V = self.counts["vertices"]
        verts = np.full((V, 3), np.nan)
        verts[vid] = pos
        va = {}
        for n, a in vattr.items():
            dst = np.empty(V, dtype=a.dtype)
            dst[vid] = a
            va[n] = dst
        if self.kind == "points":
            return Mesh(verts, None, va, {})
        cols = _CELL_COLS[self.kind]
        cnames = self.tables["cells"].schema_arrow.names
        ct = self.tables["cells"].read(columns=[*cols, *([n for n in cnames if n not in _CORE] if attributes else [])])
        cells = vid[np.stack([ct.column(c).to_numpy() for c in cols], axis=1)]
        ca = {n: _np(ct.column(n)) for n in ct.column_names if n not in _CORE}
        return Mesh(verts, cells, va, ca)

    def polylines(self):
        """A lines element's polylines in order (SPEC §5: `line` + `seq`), world coordinates.
        → [{"line": id, "vertices": (n, 3), "vids": (n,), "closed": bool}] sorted by line id; a closed
        polyline's closing point is not repeated. Raises if a line repeats a seq or its chain breaks."""
        if self.kind != "lines":
            raise ValueError(f"wfr: {self.name!r} is {self.kind}, not lines")
        cn = self.tables["cells"].schema_arrow.names
        if "line" not in cn or "seq" not in cn:
            raise ValueError(f"wfr: {self.name!r} carries no polyline structure (no line/seq attributes)")
        vt = self.tables["vertices"].read(columns=["x", "y", "z", "vid"])
        pos = self._world(vt.column("x").to_numpy(), vt.column("y").to_numpy(), vt.column("z").to_numpy())
        vid = vt.column("vid").to_numpy().astype(np.int64)
        ct = self.tables["cells"].read(columns=["a", "b", "line", "seq"])
        a, b = ct.column("a").to_numpy().astype(np.int64), ct.column("b").to_numpy().astype(np.int64)
        ln, sq = ct.column("line").to_numpy().astype(np.int64), ct.column("seq").to_numpy().astype(np.int64)
        o = np.lexsort((sq, ln))
        a, b, ln, sq = a[o], b[o], ln[o], sq[o]
        va, vb = vid[a], vid[b]
        same = ln[1:] == ln[:-1]
        if (same & (sq[1:] == sq[:-1])).any():
            raise ValueError(f"wfr: a line repeats a seq (SPEC §5)")
        brk = same & (vb[:-1] != va[1:])
        if brk.any():
            raise ValueError(f"wfr: line {int(ln[1:][brk][0])} breaks its chain (SPEC §5)")
        starts = np.concatenate([[0], np.nonzero(~same)[0] + 1, [len(ln)]])
        out = []
        for s, e in zip(starts[:-1], starts[1:]):
            if s == e:
                continue
            closed = bool(e - s > 1 and vb[e - 1] == va[s])
            rows = a[s:e] if closed else np.concatenate([a[s:e], b[e - 1:e]])
            out.append({"line": int(ln[s]), "vertices": pos[rows], "vids": vid[rows], "closed": closed})
        return out

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
