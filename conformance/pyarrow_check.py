"""Cross-check against pyarrow, both directions.

1. Read every Parquet member of a .wfr with pyarrow (stock tools must open what we write).
2. Write delta/BSS/plain columns with pyarrow — V1 and V2 pages, uncompressed and snappy,
   small pages so chunks hold several — plus the expected values as raw .bin files, for
   conformance/read_pyarrow.mjs to decode with the narrow reader.

    uv run --with pyarrow --with numpy python conformance/pyarrow_check.py [bench/out/bench.wfr]
"""
import io
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

wfr = Path(sys.argv[1] if len(sys.argv) > 1 else "bench/out/bench.wfr")
out = Path("bench/out/pyarrow")
out.mkdir(parents=True, exist_ok=True)

# 1. pyarrow reads our tables
with zipfile.ZipFile(wfr) as z:
    manifest = json.loads(z.read("wireframe.json"))
    for el in manifest["elements"]:
        for table in ("vertices", "cells"):
            data = z.read(el["path"] + table + ".parquet")
            f = pq.ParquetFile(io.BytesIO(data))
            md = f.metadata
            kv = json.loads(md.metadata[b"wireframe"])
            t = f.read()
            assert md.num_row_groups == el["counts"]["bricks"], "row groups != bricks"
            assert kv["table"] == table and kv["element"] == el["name"]
            assert kv["spec"] == manifest["spec"] == "https://gentropic.org/wireframe/0.1", "spec URL in manifest and table"
            sums = {c: int(np.asarray(t[c]).astype(np.int64).sum()) for c in t.column_names}
            print(f"pyarrow read {el['name']}/{table}: {t.num_rows} rows, {md.num_row_groups} row groups, sums {sums}")

# 2. pyarrow writes, we read
rng = np.random.default_rng(1)
n = 300_001  # not a multiple of 128 or 32: exercises the partial last miniblock
walk = np.cumsum(rng.integers(-5000, 5000, n)).astype(np.int32)
extremes = rng.integers(-(2**31), 2**31 - 1, n, dtype=np.int64).astype(np.int32)  # full-width deltas, wraparound
const = np.full(n, 7, dtype=np.int32)  # zero-width miniblocks
dbl = (rng.standard_normal(n) * 1000 + 512000).astype(np.float64)
cols = {"walk": walk, "extremes": extremes, "const": const, "dbl": dbl}
for name, arr in cols.items():
    arr.tofile(out / f"{name}.bin")
schema = pa.schema([pa.field(k, pa.from_numpy_dtype(v.dtype), nullable=False) for k, v in cols.items()])
table = pa.Table.from_arrays([pa.array(v) for v in cols.values()], schema=schema)
cases = []
for page_version in ("1.0", "2.0"):
    for comp in ("none", "snappy"):
        for enc in ("delta", "plain"):
            encodings = {"walk": "DELTA_BINARY_PACKED", "extremes": "DELTA_BINARY_PACKED", "const": "DELTA_BINARY_PACKED",
                         "dbl": "BYTE_STREAM_SPLIT"} if enc == "delta" else {k: "PLAIN" for k in cols}
            name = f"pa-v{page_version[0]}-{comp}-{enc}.parquet"
            pq.write_table(table, out / name, use_dictionary=False, column_encoding=encodings, compression=comp,
                           data_page_version=page_version, data_page_size=64 * 1024, row_group_size=100_000,
                           write_statistics=True)
            cases.append(name)
(out / "cases.json").write_text(json.dumps({"n": n, "columns": {k: str(v.dtype) for k, v in cols.items()}, "files": cases}))
print(f"wrote {len(cases)} pyarrow files to {out}")
