# The wireframe format (`.wfr`) — version 0.1 (draft)

A `.wfr` file holds one or more spatial **elements** — point sets, line networks, triangle meshes —
laid out to be read by byte range: open a multi-gigabyte file, find the parts that intersect a
query, decode only those. Inside, every table is ordinary Apache Parquet and the container is an
ordinary ZIP archive, so the contents remain usable with stock tools.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119. Sections
marked *informative* explain or recommend; they impose no requirements.

## 1. Overview

```
file.wfr  (ZIP, every member STORED)
├── mimetype                                  "application/vnd.gentropic.wireframe" — first
├── elements/<element>/vertices.parquet       x, y, z, vid   — one row group per brick
├── elements/<element>/cells.parquet          a, b[, c]      — one row group per brick (absent for points)
├── elements/<element>/columns/<location>/…   attributes appended later (optional)
├── lod/…                                     reserved
├── textures/…                                reserved
├── wireframe.json                            the manifest
└── signature.json                            optional — last
```

An element is cut into **bricks** — spatially compact groups of about 64k cells. Brick *k* is row
group *k* of the vertex table **and** row group *k* of the cell table, and its cells reference only
its own vertex rows. To read a region, a reader picks the bricks whose bounding boxes intersect it
and decodes those row groups. The bounding boxes are the min/max statistics Parquet already writes
for `x`, `y`, `z`.

The format defines what is needed to decode and trust the geometry. Everything else — dates,
provenance, units, styling — is free-form `meta` (§9).

## 2. Conventions

- **Axes.** `x` = East, `y` = North, `z` = Up, in the file's `frame.units`.
- **Orientation.** In a triangle element whose topology is `oriented`, a face `(a, b, c)` has its
  outward normal along `(B − A) × (C − A)` (right-hand rule): counter-clockwise seen from outside a
  solid, or from above a surface.
- **Integers.** Parquet INT32/INT64 are signed; every index in this format is non-negative.
- **Text.** UTF-8. JSON per RFC 8259.

## 3. Container

### 3.1 ZIP requirements

A `.wfr` is a ZIP archive (PKWARE APPNOTE 6.3.x) with these restrictions:

- Every member MUST use compression method 0 (stored).
- Members MUST NOT be encrypted. The archive MUST NOT be split or spanned.
- Member names MUST be UTF-8 (general-purpose flag bit 11), use `/` as separator, and contain no `.`
  or `..` segments, leading `/`, or drive letters.
- Writers MUST use Zip64 records when any size or offset exceeds 0xFFFFFFFF or there are more than
  65535 entries, and MAY use them unconditionally.
- Writers MAY use data descriptors (flag bit 3) to stream members to a non-seekable sink. **Readers
  MUST take sizes and offsets from the central directory**, never from local headers.
- CRC-32 values MUST be correct. Readers MAY skip CRC verification (§10 provides SHA-256).

### 3.2 Alignment

Except for `mimetype`, each member's data SHOULD begin at a file offset that is a multiple of 64.
Writers achieve this by padding the local header's extra field with an extra-field record of ID
`0xD935` (the ID Android's zipalign uses); readers MUST NOT depend on alignment.

### 3.3 Locating members (informative)

1. Find the End of Central Directory record in the last 65,557 bytes; if a Zip64 EOCD locator
   precedes it, follow it to the Zip64 EOCD.
2. Read the central directory: name → local header offset, sizes.
3. Member data begins at `localHeaderOffset + 30 + nameLength + extraLength`, where both lengths
   come from the **local** header (its extra field may differ from the central one), so read the
   30-byte local header first.

### 3.4 Required members and order

- The first member MUST be named `mimetype`, be stored, have no extra field, and contain exactly
  the ASCII bytes `application/vnd.gentropic.wireframe` with no newline. A file is identifiable by
  reading 73 bytes: the string starts at offset 38.
- The manifest `wireframe.json` MUST exist. It and the optional `signature.json` SHOULD be the last
  members, in that order, followed only by the central directory.
- Readers MUST ignore members they do not recognise.

### 3.5 Appending, dead space, writers

A file can gain or replace members without being rewritten:

1. Write new members **after** the existing central directory and EOCD, leaving them intact.
2. Write a new `wireframe.json` (and `signature.json`, if signing).
3. Write a new central directory and EOCD listing every live member.

The old central directory, manifest and any superseded member become dead space. **The central
directory at the end of the file is authoritative**: a member it does not list does not exist.
Readers MAY recover from an interrupted append by searching backward for the previous complete
EOCD. A **compact** operation rewrites the file without dead space.

Appending assumes a single writer. The format provides no locking; concurrent writers corrupt the
file. Readers are always safe, since the last complete central directory wins.

## 4. Manifest — `wireframe.json`

```jsonc
{
  "format": "wireframe",
  "version": "0.1",
  "frame": { "origin": [512000, 7400000, 0], "crs": "EPSG:31983", "units": "m" },
  "elements": [
    {
      "name": "topo 2024-09",
      "path": "elements/topo%202024-09/",
      "kind": "triangles",
      "coords": { "mode": "grid", "origin": [512000, 7400000, 0], "step": 0.0001 },
      "counts": { "vertices": 4004001, "vertexRows": 4086933, "cells": 8000000, "bricks": 123 },
      "bbox": [512000.0, 7400000.0, 610.2, 514000.0, 7402000.0, 847.9],
      "topology": { "closed": false, "oriented": true, "manifold": true, "volume": null, "status": "checked" },
      "bricks": {
        "order": { "by": [], "then": "morton" },
        "target": 65536,
        "directory": [[33210, 65536, [512000.0, 7400000.0, 610.2, 512180.4, 7400177.9, 655.0]], "…"]
      },
      "columns": [
        { "location": "vertices", "name": "elevation_change", "path": "elements/topo%202024-09/columns/vertices/elevation_change.parquet", "meta": { "units": "m" } },
        { "location": "cells", "name": "layer", "member": "cells.parquet" }
      ],
      "meta": { "time": "2024-09-30", "lineage": { "op": "import", "source": "topo_2024_09.dxf" } }
    }
  ],
  "members": {
    "elements/topo%202024-09/vertices.parquet": { "size": 36812044, "block": 16777216, "sha256": ["…", "…", "…"] }
  },
  "meta": {}
}
```

| Field | Rule |
|---|---|
| `format` | MUST be `"wireframe"`. |
| `version` | `"<major>.<minor>"`. Readers MUST reject an unknown major version and SHOULD read a newer minor, ignoring unknown fields. |
| `frame` | The file's coordinate frame, in @gcu/frame's shape: `origin` (a recommended local origin for rendering — it does not affect how stored coordinates are interpreted, §6.2), `crs` (a string such as `"EPSG:31983"`, or null for unstated), `units` (default `"m"`). Shared by every element. |
| `elements[]` | Zero or more elements. `name` MUST be unique within the file; any non-empty string. |
| `path` | The member prefix of the element's tables, ending in `/`. Writers derive it from the name by percent-encoding (RFC 3986 unreserved characters kept). **Readers MUST use `path` as written, never derive it.** |
| `kind` | `"points"`, `"lines"` or `"triangles"` (§5). |
| `coords` | §6.2. |
| `counts` | `vertices` = distinct `vid` values; `vertexRows` = rows of the vertex table; `cells` = rows of the cell table (0 for points); `bricks`. MUST match the tables. |
| `bbox` | World `[minx, miny, minz, maxx, maxy, maxz]`, or null for an empty element. |
| `topology` | Triangle elements only (§7.3); absent otherwise. |
| `bricks` | `order` records how bricks were built: `by` is a list of attribute column names sorted on first (possibly empty), `then` is `"morton"` or `"none"`. Informative — readers MUST NOT rely on it for correctness. `target` is the intended cells per brick. `directory[k]` = `[vertexRows, cells, worldBbox]` for brick *k* — a **cache** of the Parquet footers, letting a reader plan without reading them. Where cache and footer disagree, the footer wins. Writers MAY omit `directory`. |
| `columns[]` | Attributes (§8). |
| `members` | §10. |
| `meta` | Free-form (§9), at file, element and column level. |

## 5. Element kinds

Every element has a vertex table. Elements other than points also have a cell table whose rows
each list a fixed number of vertex rows:

| `kind` | Cell table | Cell columns | A cell is |
|---|---|---|---|
| `points` | — | — | (none; the vertex is the record) |
| `lines` | `cells.parquet` | `a`, `b` | a segment from `a` to `b` |
| `triangles` | `cells.parquet` | `a`, `b`, `c` | a face |

Polylines are lines elements: a polyline is a chain of segments, and networks with branches
(junctions where three or more segments meet) need no special case. Which polyline a segment
belongs to, and any per-polyline property, is an ordinary attribute on cells. Arcs are densified
into chords by writers.

`"tets"` (`a`, `b`, `c`, `d`) is reserved for a future version. Faces with more than three
vertices are triangulated by writers.

## 6. Vertex table — `<path>vertices.parquet`

### 6.1 Columns

First, in this order:

| Column | Physical type | Repetition | Encoding |
|---|---|---|---|
| `x`, `y`, `z` | INT32 (grid mode) / DOUBLE (float64 mode) | REQUIRED | grid: DELTA_BINARY_PACKED · float64: BYTE_STREAM_SPLIT |
| `vid` | INT32, or INT64 when `counts.vertices` > 2³¹ − 1 | REQUIRED | DELTA_BINARY_PACKED |

- `vid` is the welded vertex identity, dense in `0 … counts.vertices − 1`. Rows with equal `vid`
  MUST have identical `x`, `y`, `z`. A `vid` repeats only across bricks, never within one.
- In lines and triangles elements, every vertex row MUST be referenced by at least one cell of its
  brick.
- **Points** elements have no duplicated rows; for them `vid` MAY be omitted, in which case a
  point's identity is its row index and `counts.vertices` = `counts.vertexRows`.
- Attribute columns stored inline (§8) follow the core columns.

### 6.2 Coordinate modes

`coords.mode` is one of:

- **`"grid"`** (default). Stored integers `i` map to world coordinates by
  `world = coords.origin + coords.step × i` per axis, evaluated in IEEE-754 double precision.
  `coords.step` is a positive number or `[sx, sy, sz]`; `coords.origin` is a world point. Writers
  quantize by rounding to the nearest integer (error ≤ step/2), and MUST choose `step` and `origin`
  so every coordinate fits INT32 — or else use float64 mode.
  - The Parquet min/max statistics of `x`, `y`, `z` per row group are then exact lattice bounds,
    convertible to world bounds by the same formula.
  - Elements with equal `step` and `origin` share a lattice: shared vertices compare exactly as
    integers, so seams between neighbouring elements are bit-exact.
- **`"float64"`**. `x`, `y`, `z` are DOUBLE world coordinates, stored losslessly. `coords.origin`
  and `coords.step` MUST be absent.

### 6.3 Self-description

Each table MUST carry a Parquet key–value metadata entry `wireframe` whose value is JSON, so a
table read outside the archive still says what it is:

```json
{ "version": "0.1", "element": "topo 2024-09", "kind": "triangles", "table": "vertices",
  "coords": { "mode": "grid", "origin": [512000, 7400000, 0], "step": 0.0001 } }
```

`cells.parquet` carries the same entry with `"table": "cells"` and no `coords`; separate attribute
members carry `"table": "column"` and their `location`. The manifest is authoritative where they
differ.

## 7. Cell table — `<path>cells.parquet`

### 7.1 Columns

| Column | Physical type | Repetition | Encoding |
|---|---|---|---|
| `a`, `b` (`c` for triangles) | INT32, or INT64 when `counts.vertexRows` > 2³¹ − 1 | REQUIRED | DELTA_BINARY_PACKED |

- Values are **global row indices** into the vertex table — counted from the start of the table,
  not of the brick. They are not `vid`s.
- A cell MUST NOT repeat a vertex row (`a`, `b`, `c` distinct). Readers SHOULD tolerate cells that
  are geometrically degenerate (distinct rows, coincident positions).

### 7.2 The brick invariant

Both tables MUST have exactly `counts.bricks` row groups, and for every brick *k*:

- row group *k* of the cell table holds the cells of brick *k*;
- every index in those cells lies in row group *k* of the vertex table, i.e. in
  `[vStart_k, vStart_k + vRows_k)` where `vStart_k` is the sum of the preceding row groups' row
  counts.

Brick *k* thus decodes without touching any other brick, and its cells' indices become local by
subtracting `vStart_k`. For points elements, bricks are the vertex table's row groups alone.

**The invariant is the only bricking requirement.** How bricks are formed — the sort, their size,
their compactness — is a matter of quality, not validity; writers MAY use any method, including
bucketed external sorts for elements too large to sort in memory.

Writers MUST write per-column-chunk min/max statistics for `x`, `y`, `z`, SHOULD write them for
`vid` and the cell columns, and MAY write column and offset indexes.

### 7.3 Topology (triangle elements)

`topology` = `{ closed, oriented, manifold, volume, status }`. Edges are compared by the `vid`s of
their endpoints, so the definitions hold across bricks:

- **`closed`** — every edge is shared by exactly two faces.
- **`oriented`** — every edge shared by two faces is traversed in opposite directions by them.
- **`manifold`** — the faces around every vertex form a single fan (edge-connected, at most one
  boundary gap).
- **`volume`** — enclosed volume in units³ (meaningful when closed and oriented), or null.

Each of `closed`, `oriented`, `manifold` is a boolean or null (unknown). `status` is `"checked"`
when the writer verified the claims against the faces, `"declared"` when they were taken from the
source unverified.

### 7.4 Building bricks (informative)

The reference writers:

1. sort cells by `bricks.order.by` columns, if any, then by the Morton key of their centroids
   quantized to 16 bits per axis over the element bbox;
2. cut the sorted cells into runs of `target` (default 65536), the last possibly shorter, and
   starting a new brick wherever a `by` value changes;
3. within each brick, assign vertex rows in order of first use by that brick's cells; a vertex used
   by several bricks gets a row in each.

Sorting by a column first makes each brick hold a single value of it, so that column's row-group
min/max gives exact pushdown ("only lode 7"), at some cost in spatial compactness.

Measured on 8M-face meshes: 2–2.2% of vertex rows are duplicates at 64k faces per brick (vs. ~485%
for bricks cut in unsorted order); encoded size is about a third of raw.

## 8. Attributes

An attribute is a Parquet column of values per row of one table.

- `location` is `"vertices"` or `"cells"`. Values are per **row**: for vertex attributes, rows
  sharing a `vid` MUST have equal values.
- **Inline** (`member`: `"vertices.parquet"` or `"cells.parquet"`): extra columns in a core table,
  written at creation.
- **Separate** (`path`): a member holding one Parquet column, named as the attribute, whose row
  groups have the same sizes as its location's table — so brick *k* is row group *k* here too. This
  is how attributes are added later (§3.5). Reference writers use
  `<element path>columns/<location>/<percent-encoded name>.parquet`; readers MUST take the path
  from the manifest.
- Exactly one of `member` / `path` MUST be present. Names MUST be unique per element and location;
  the core column names are reserved.
- Attributes MAY use any Parquet type, logical type, encoding, compression or nullability. Labels
  are best stored as strings (Parquet dictionary-encodes repeated values; Arrow-based readers
  surface them as categoricals). Readers that support only some encodings MUST fail with an error
  naming the column — never return wrong values. REQUIRED columns decode faster than nullable ones.
- **Vectors are separate scalar columns** named `<name>.<component>` (e.g. `normal.x`), not Parquet
  lists.

**Reserved names** — when present they MUST have these meanings:

| Name | Location | Meaning |
|---|---|---|
| `color.r`, `color.g`, `color.b`, `color.a` | either | colour, UINT8 (`a` optional) |
| `normal.x`, `normal.y`, `normal.z` | vertices | unit normal |
| `src_id` | either | the source's own identifier for the vertex or cell, for faithful round trips |
| `uv.u`, `uv.v` | vertices | reserved for texture coordinates |

## 9. `meta`

`meta` objects at file, element and column level are free-form JSON. The format attaches no
meaning to them, and readers MUST NOT require any key. Conventional keys, so tools agree on
spelling (informative):

| Key | Meaning |
|---|---|
| `time` | an ISO 8601 date or datetime the data represents (a survey date) |
| `lineage` | a provenance object (operation, parameters, sources, tool build, timestamp) |
| `units` | a column's units |
| `description` | human-readable text |
| `nodata` | a sentinel value meaning missing (e.g. −1e30) |
| `colors` | for a label column: an object from value to colour |

## 10. Integrity and signing

`members` maps every member except `mimetype`, `wireframe.json` and `signature.json` to
`{ size, block, sha256 }`: the byte length, the block size (SHOULD be 16 MiB = 16777216), and the
lowercase hex SHA-256 of each consecutive `block`-byte span of the member's data (the last span
may be shorter; an empty member has an empty list). Hashing by block lets a ranged reader verify
exactly the bytes it read, and keeps each hash within one call of a non-streaming digest API such
as WebCrypto's.

Writers MUST fill `members` for every member they write; readers MAY verify on demand. A member in
the central directory but missing from `members` is not an error, but a verifying reader SHOULD
report it.

**`signature.json`** (optional) signs the file by signing the manifest, which in turn pins every
member:

```json
{ "v": 1, "alg": "Ed25519", "manifest": "<sha256 hex of wireframe.json's bytes>", "pub": "<base64>", "sig": "<base64 signature over the manifest hash bytes>" }
```

## 11. Core-column constraints

So that small, fast readers are possible, the core columns (`x y z vid a b c`) MUST:

- be REQUIRED (maximum definition and repetition levels 0);
- use only the encodings of §6.1 and §7.1, with no dictionary pages;
- use compression UNCOMPRESSED or SNAPPY (UNCOMPRESSED RECOMMENDED — delta coding has already
  removed what snappy would find);
- use data page V1 or V2 (readers MUST accept both).

Readers MUST NOT rely on any particular page size or count within a column chunk.

## 12. Reserved

- `lod/` — level-of-detail and other derived caches. Unspecified in 0.1; readers MUST ignore it.
- `textures/` — texture images (with the `uv` attributes, §8). Unspecified in 0.1.
- Element kind `"tets"`.
- Manifest fields not defined here belong to future minor versions. Writers MUST NOT invent
  structural fields; anything else goes in `meta`.

## 13. Reading by region (informative)

1. Open the ZIP (§3.3), check `mimetype`, parse `wireframe.json`.
2. For each element of interest, choose bricks from `bricks.directory`, or from the vertex table
   footer's row-group statistics of `x`, `y`, `z` (converted to world by §6.2).
3. For each chosen brick, range-read row group *k* of both tables (verifying the covering blocks if
   desired), decode, and subtract `vStart_k` from the cell indices.
4. Weld across bricks by `vid` if needed. Rendering usually doesn't need it: duplicated rows are
   bit-identical.

## 14. Candidates for 0.2

- A GPU-ready cache under `lod/`: frame-of-reference bit-packed blocks that a vertex shader can
  unpack. In experiments, FOR was slightly smaller than Parquet delta for first-use vertex order
  and needs no prefix sum.
- Textures (`textures/` + `uv` + a per-face texture attribute).
- Exact arcs as a segment attribute.
- `tets`.
- Variable-size bricks for very uneven density.
