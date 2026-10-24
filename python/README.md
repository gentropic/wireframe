# gcu-wireframe

Read and write **`.wfr`** — a single-file container for large triangle meshes, line networks and
point sets (topography, pit shells, geological solids, design strings), made to be read by byte
range. Spec, converter and inspector: **https://gentropic.org/wireframe/**

```
pip install gcu-wireframe            # numpy + pyarrow
pip install "gcu-wireframe[pyvista]" # + to_pyvista()
```

## Reading

Opening reads only the zip directory, the manifest and the Parquet footers. Bricks decode on demand;
coordinates come back in world units.

```python
import gcu.wireframe as wf

with wf.open("topo.wfr") as f:
    el = f["topo"]                          # elements by name; iterate f for all of them
    el.counts, el.coords, el.topology       # from the manifest
    ks = el.bricks_in([x0, y0, -1e9, x1, y1, 1e9])   # from footer statistics alone
    b = el.read_brick(ks[0])                # .positions (n,3) float64 · .cells (m,3) local · .vid · attributes
    mesh = el.to_mesh()                     # the whole element, welded: .vertices by vid, .cells as vid triples
    t = el.table("cells", columns=["layer"])    # the raw pyarrow table
    poly = el.to_pyvista()                  # with the [pyvista] extra
```

## Writing

```python
wf.write("out.wfr", [
    wf.Triangles("surface", vertices, faces,                 # (n,3) world, (m,3) indices
                 vertex_attributes={"color.r": r, "color.g": g, "color.b": b},
                 cell_attributes={"domain": codes},
                 topology="check"),                          # closed · oriented · manifold · volume
    wf.Lines("strings", xyz, segments, cell_attributes={"layer": layer_names}),
    wf.Points("pegs", pegs, step=None),                      # step=None → lossless float64
], frame={"crs": "EPSG:31983"})
```

Grid coordinates (the default, `step=1e-4` m) make every brick's bounding box readable from stock
Parquet statistics. `brick_by="lode"` keeps each brick to one value of a label column.

The writer is the same algorithm as the JavaScript reference, so the same input gives the same
bricks, rows and vertex ids in both languages (checked against `testdata/` in the repository). It
works in memory; for multi-gigabyte sources use the streaming converter
(`node js/cli.mjs convert …` or https://gentropic.org/wireframe/convert/).

```
python -m gcu.wireframe info topo.wfr
```

MIT · Geoscientific Chaos Union
