"""Write testdata/inputs.json with the Python writer → bench/out/py-golden.wfr, for check_golden.mjs.
    python/.venv/Scripts/python conformance/python_golden.py   (or any env with gcu-wireframe)"""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "python" / "tests"))
from test_conformance import build_inputs  # noqa: E402  — the same input mapping the pytest suite uses

import gcu.wireframe as wf  # noqa: E402

out = root / "bench" / "out" / "py-golden.wfr"
out.parent.mkdir(parents=True, exist_ok=True)
wf.write(out, build_inputs(), frame={"origin": [512000, 7400000, 300], "crs": "EPSG:31983", "units": "m"})
print(f"wrote {out} ({out.stat().st_size} bytes)")
