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

The format of record is [SPEC.md](SPEC.md). Status: **draft 0.1**, no libraries yet.

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
