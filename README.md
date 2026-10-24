# wireframe

**`.wfr`** — a single-file container for large spatial elements (triangle meshes such as
topography, pit shells and geological solids; line networks such as design strings and contours;
point sets), designed to be read without ever being held whole in memory.

- **One file, many elements.** A `.wfr` is a ZIP archive with every member stored uncompressed, so
  any member can be read by byte range.
- **Bricks.** Cells (faces or segments) are sorted spatially and cut into bricks. Brick *k* is row
  group *k* of both the vertex table and the cell table, and it is self-contained: its cells index
  only its own vertices.
- **Pushdown from stock Parquet.** Vertices sit on an integer grid, so each row group's ordinary
  min/max statistics are that brick's bounding box. A spatial query skips bricks using the
  footer alone.
- **Faster than raw.** Coordinates and indices are delta bit-packed to about a third of their
  raw size, and decode at gigabytes per second.
- **Plain formats inside.** Unzip a `.wfr` and every table opens in pyarrow, DuckDB or Polars.

- **Written in bounded memory.** The writer streams: inputs are quantized as they arrive, spilled
  to scratch beyond a memory budget, and sorted by recursive partition. The budget changes how
  much is resident, never the output — a 64 MB budget and an unlimited one write the same bytes.

The format of record is [SPEC.md](SPEC.md). Status: **draft 0.1**. The JS library reads and writes
it; the Python package is next.

## Converting

```
node js/cli.mjs convert topo.dxf              # → topo.wfr, 1 GB budget, scratch in the temp dir
node js/cli.mjs convert scan.ply --budget 256m --check
node js/cli.mjs info topo.wfr
```

PLY (ascii and binary), OBJ and DXF (via `@gcu/dxf`'s streaming parser) are read as streams.
Indexed inputs keep their vertex identity; polygon soup (DXF 3DFACEs) is welded by position.
`--check` verifies topology (closed, oriented, manifold, volume) instead of declaring it.
On an 813 MB, 4.5M-face 3DFACE DXF: 16 s, 35.6 MB out, ~400 MB peak RSS at any budget from 64 MB
up. Most of that floor is Node itself and typed-array storage outside the JS heap; the JS heap
stays under 160 MB.

## Development

```
npm install            # dev: hyparquet (reference reader), @gcu/dxf (linked from ../auditable)
npm test               # round trips, streaming (budget independence, welding), format adapters
npm run conformance    # pyarrow both ways (uv run, no global install)
npm run bench:build && npm run bench:read
node bench/make-inputs.mjs 1500   # large DXF + PLY inputs for the converter
```

## Layout

| Path | What |
|---|---|
| `SPEC.md` | the format |
| `testdata/` | golden files that both libraries must read and write identically |
| `js/` | `@gcu/wireframe` (zero-dependency ESM) |
| `python/` | `gcu-wireframe`, imported as `gcu.wireframe` (numpy + pyarrow) |
| `conformance/` | cross-language checks: JS writes and Python reads, and vice versa |
| `bench/` | encoding and decode benchmarks |

## License

MIT — Geoscientific Chaos Union, <https://gentropic.org>
