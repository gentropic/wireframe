"""Cross-language conformance against testdata/ (written by the JS reference, testdata/make.mjs):
read golden.wfr to the expected decoded-column hashes, and WRITE the same inputs to the same hashes."""
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

import gcu.wireframe as wf

TD = Path(__file__).resolve().parents[2] / "testdata"
EXPECTED = json.loads((TD / "expected.json").read_text())


def summarize(path):
    out = {"elements": {}}
    with wf.open(path) as f:
        out["spec"] = f.manifest.get("spec")
        for el in f:
            e = out["elements"][el.name] = {"kind": el.kind, "counts": el.counts, "coords": el.coords, "topology": el.topology, "tables": {}}
            for tname, pf in el.tables.items():
                md = pf.metadata
                tab = e["tables"][tname] = {"rowGroups": [md.row_group(k).num_rows for k in range(md.num_row_groups)], "columns": {}}
                for i, name in enumerate(pf.schema_arrow.names):
                    phys = pf.schema.column(i).physical_type
                    h = hashlib.sha256()
                    for k in range(md.num_row_groups):
                        col = pf.read_row_group(k, columns=[name]).column(0)
                        if phys == "BYTE_ARRAY":
                            h.update(("\n".join(col.to_pylist()) + ("\n" if k < md.num_row_groups - 1 else "")).encode())
                        else:
                            dt = {"DOUBLE": "<f8", "FLOAT": "<f4", "INT32": "<i4", "INT64": "<i8"}[phys]
                            h.update(np.ascontiguousarray(col.to_numpy(), dtype=dt).tobytes())
                    tab["columns"][name] = h.hexdigest()
    return out


def compare(got, want):
    assert got["spec"] == want["spec"]
    assert set(got["elements"]) == set(want["elements"])
    for name, w in want["elements"].items():
        g = got["elements"][name]
        assert g["kind"] == w["kind"], name
        assert g["counts"] == w["counts"], name
        assert g["coords"] == w["coords"], name
        assert g["topology"] == w["topology"], name
        for t, wt in w["tables"].items():
            assert g["tables"][t]["rowGroups"] == wt["rowGroups"], (name, t)
            assert g["tables"][t]["columns"] == wt["columns"], (name, t)


def test_reads_the_js_golden_file_to_the_expected_hashes():
    compare(summarize(TD / "golden.wfr"), EXPECTED)


def build_inputs():
    inp = json.loads((TD / "inputs.json").read_text())
    dt = {"u8": np.uint8, "i32": np.int32, "f32": np.float32, "f64": np.float64}
    attrs = lambda o: {k: (v["values"] if v["type"] == "string" else np.asarray(v["values"], dt[v["type"]])) for k, v in (o or {}).items()}
    els = []
    for e in inp["elements"]:
        kw = dict(vertex_attributes=attrs(e.get("vertexAttributes")), cell_attributes=attrs(e.get("cellAttributes")),
                  topology=e.get("topology"), brick_by=e.get("brickBy"), target=e.get("target", 65536))
        if (e.get("coords") or {}).get("mode") == "float64":
            kw["step"] = None
        P = np.asarray(e["positions"], np.float64).reshape(-1, 3)
        if e["kind"] == "points":
            kw.pop("cell_attributes"); kw.pop("topology")
            els.append(wf.Points(e["name"], P, **kw))
        elif e["kind"] == "lines":
            kw.pop("topology")
            els.append(wf.Lines(e["name"], P, np.asarray(e["cells"]).reshape(-1, 2), **kw))
        else:
            els.append(wf.Triangles(e["name"], P, np.asarray(e["cells"]).reshape(-1, 3), **kw))
    return els


def test_writes_the_same_inputs_to_the_same_hashes(tmp_path):
    out = tmp_path / "py.wfr"
    wf.write(out, build_inputs(), frame={"origin": [512000, 7400000, 300], "crs": "EPSG:31983", "units": "m"})
    compare(summarize(out), EXPECTED)


def test_python_output_is_a_valid_container(tmp_path):
    import zipfile
    out = tmp_path / "py.wfr"
    m = wf.write(out, build_inputs())
    with zipfile.ZipFile(out) as z:
        assert z.testzip() is None
        names = [i.filename for i in z.infolist()]
        assert names[0] == "mimetype" and names[-1] == "wireframe.json"
        assert all(i.compress_type == 0 for i in z.infolist())
    with open(out, "rb") as f:
        assert f.read(73)[38:] == b"application/vnd.gentropic.wireframe"
    from gcu.wireframe._zip import members, sha256_blocks
    mem = members(out)
    raw = out.read_bytes()
    for name, info in m["members"].items():
        mm = mem[name]
        assert mm.offset % 64 == 0, name
        assert sha256_blocks(raw[mm.offset:mm.offset + mm.size]) == info["sha256"], name
    # every table describes itself (SPEC §6.3) — the inspector caught this missing once
    import io
    import pyarrow.parquet as pq
    for el in m["elements"]:
        for t in (["vertices"] if el["kind"] == "points" else ["vertices", "cells"]):
            mm = mem[el["path"] + t + ".parquet"]
            kv = pq.ParquetFile(io.BytesIO(raw[mm.offset:mm.offset + mm.size])).metadata.metadata or {}
            d = json.loads(kv[b"wireframe"])
            assert d["element"] == el["name"] and d["table"] == t and d["spec"] == wf.SPEC_URL, (el["name"], t)
