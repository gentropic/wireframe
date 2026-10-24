# The wireframe format (`.wfr`) — version 0.1 (draft)

A `.wfr` file holds one or more triangle meshes for reading by byte range: a reader opens a
multi-gigabyte file, finds the parts of a mesh that intersect a query, and decodes only those.
Every table inside is ordinary Apache Parquet, and the container is an ordinary ZIP archive, so
the contents stay usable with stock tools.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Sections marked
*informative* explain or recommend and impose no requirements.

## 1. Overview

```
file.wfr  (ZIP, every member STORED)
├── mimetype                        "application/vnd.gentropic.wireframe", first member
├── meshes/<mesh>/vertices.parquet  x, y, z, vid      one row group per brick
├── meshes/<mesh>/faces.parquet     a, b, c           one row group per brick
├── meshes/<mesh>/columns/…         attribute columns appended later (optional)
├── lod/…                           reserved
└── wireframe.json                  the manifest, written last
```

A mesh is cut into **bricks**: spatially compact groups of faces, about 64k faces each. Brick *k*
is row group *k* of the vertex table **and** row group *k* of the face table, and its faces
reference only its own vertex rows. A reader that wants a region reads the two footers, picks the
bricks whose bounding boxes intersect it, and decodes those row groups. Each brick's bounding box
is the min/max statistics Parquet already writes for the `x`, `y`, `z` columns.

## 2. Conventions

- **Axes.** Coordinates are `x` = East, `y` = North, `z` = Up, in the file's `frame.units`.
- **Orientation.** For a mesh whose `topology.oriented` is true, a face `(a, b, c)` has its outward
  normal along `(B − A) × (C − A)`, the right-hand rule. That makes faces counter-clockwise seen from
  outside a solid, or from above a surface.
- **Integers.** Parquet INT32 and INT64 are signed. Every index in this format is non-negative.
- **Text.** Strings are UTF-8, and JSON follows RFC 8259.

## 3. Container

### 3.1 ZIP requirements

A `.wfr` is a ZIP archive (PKWARE APPNOTE 6.3.x) with these restrictions:

- Every member MUST use compression method 0 (stored). Parquet does its own encoding, and storing
  members is what makes them range-readable.
- Members MUST NOT be encrypted. The archive MUST NOT be split or spanned.
- Member names MUST be UTF-8 (general-purpose flag bit 11 set), use `/` as the separator, and contain
  no `.` or `..` path segments, no leading `/`, and no drive letters.
- The writer MUST use Zip64 records when any size or offset exceeds 0xFFFFFFFF, or there are more
  than 65535 entries. It MAY use them unconditionally.
- Writers MAY use data descriptors (flag bit 3) so that members can be streamed to a non-seekable
  sink. **Readers MUST take sizes and offsets from the central directory**, never from local headers.
- Each member's CRC-32 MUST be correct. Readers MAY skip CRC verification, since §7 provides sha256.

### 3.2 Locating members (informative)

1. Find the End of Central Directory record. It lies within the last 65,557 bytes; if a Zip64 EOCD
   locator precedes it, follow that to the Zip64 EOCD.
2. Read the central directory, which maps names to local-header offsets and sizes.
3. Member data starts at `localHeaderOffset + 30 + nameLength + extraLength`, where both lengths
   come from the **local** header. Its extra field can differ from the central one, so the 30-byte
   local header has to be read.

### 3.3 Required members and order

- The first member MUST be named `mimetype`, be stored, have no extra field, and contain exactly the
  ASCII bytes `application/vnd.gentropic.wireframe` with no newline. A file can therefore be
  identified by reading 73 bytes: the string starts at offset 38.
- The manifest `wireframe.json` MUST exist and SHOULD be the last member, its data followed only by
  the central directory.
- Readers MUST ignore members they do not recognise.

### 3.4 Appending and dead space

A file can gain members without being rewritten, for example a computed attribute column.

1. Write the new members **after** the existing central directory and EOCD, leaving them intact.
2. Write a new `wireframe.json`.
3. Write a new central directory and EOCD that list every live member.

The old central directory, the old manifest and any replaced member become dead space. **The
central directory at the end of the file is authoritative**: a member it does not list does not
exist. Readers MAY recover from an interrupted append by searching backwards for the previous
complete EOCD. A **compact** operation rewrites the file without dead space.

## 4. Manifest — `wireframe.json`

```jsonc
{
  "format": "wireframe",
  "version": "0.1",
  "frame": { "origin": [512000, 7400000, 0], "crs": "EPSG:31983", "units": "m" },
  "meshes": [
    {
      "name": "topo 2024-09",
      "path": "meshes/topo%202024-09/",
      "coords": { "mode": "grid", "origin": [512000, 7400000, 0], "step": 0.0001 },
      "counts": { "vertices": 4004001, "vertexRows": 4086933, "faces": 8000000, "bricks": 123 },
      "bbox": [512000.0, 7400000.0, 610.2, 514000.0, 7402000.0, 847.9],
      "topology": {
        "kind": "surface",
        "closed": false, "oriented": true, "manifold": true,
        "volume": null,
        "status": "checked"
      },
      "bricks": {
        "order": "morton",
        "targetFaces": 65536,
        "directory": [[33210, 65536, [512000.0, 7400000.0, 610.2, 512180.4, 7400177.9, 655.0]], "…"]
      },
      "columns": [
        { "location": "vertices", "name": "elevation_change", "path": "meshes/topo%202024-09/columns/vertices/elevation_change.parquet" },
        { "location": "faces", "name": "domain", "member": "faces.parquet" }
      ],
      "lineage": { "op": "import", "source": "topo_2024_09.dxf", "at": "2026-10-24T12:00:00Z" }
    }
  ],
  "members": {
    "meshes/topo%202024-09/vertices.parquet": { "size": 36812044, "sha256": "…" },
    "meshes/topo%202024-09/faces.parquet":    { "size": 30101771, "sha256": "…" }
  },
  "lineage": null
}
```

| Field | Rule |
|---|---|
| `format` | MUST be `"wireframe"`. |
| `version` | `"<major>.<minor>"`. Readers MUST reject an unknown major version, and SHOULD read a newer minor version, ignoring fields they don't know. |
| `frame` | The file's coordinate frame, in @gcu/frame's shape. `origin` is a recommended local origin for rendering; it does not change how stored coordinates are interpreted (§5.2 does that). `crs` is a string such as `"EPSG:31983"`, or null when unstated. `units` defaults to `"m"`. Every mesh in a file shares the frame. |
| `meshes[]` | Zero or more meshes. Each `name` MUST be unique within the file and MAY be any non-empty string. |
| `meshes[].path` | The member prefix of the mesh's tables, ending in `/`. Writers derive it from the name by percent-encoding (RFC 3986 unreserved characters kept). **Readers MUST use `path` as written and never derive it.** |
| `coords` | §5.2. |
| `counts` | `vertices` = number of distinct `vid` values; `vertexRows` = rows in the vertex table (larger, because brick-boundary vertices repeat); `faces`; `bricks`. MUST match the tables. |
| `bbox` | World `[minx, miny, minz, maxx, maxy, maxz]` of the mesh, or null for an empty mesh. |
| `topology` | `kind` is `"surface"`, `"solid"` (closed and meant to enclose a volume) or `"soup"` (no topological claims). `closed`, `oriented` and `manifold` are booleans or null for unknown. `volume` is a number in units³, or null. `status` is `"checked"` when the writer verified the claims against the faces, or `"declared"` when they were taken from the source. |
| `bricks` | Informative. `order` names the sort that built the bricks (`"morton"`, §6.3). `directory[k]` = `[vertexRows, faces, worldBbox]` for brick *k*: a **cache** of what the Parquet footers say, so a reader can plan without reading footers. When the cache and a footer disagree, the footer wins. Writers MAY omit `directory`. |
| `columns[]` | Attribute columns beyond the core ones (§8). `member` names a column stored inside a core table (`"vertices.parquet"` or `"faces.parquet"`); `path` names a separate member. Exactly one of the two MUST be present. |
| `lineage` | Free-form provenance, per mesh and per file. Null or an object. |
| `members` | §7. |

## 5. Vertex table — `<path>vertices.parquet`

### 5.1 Columns

The first four columns, in this order:

| Column | Physical type | Repetition | Encoding |
|---|---|---|---|
| `x`, `y`, `z` | INT32 in grid mode, DOUBLE in float64 mode (§5.2) | REQUIRED | grid: DELTA_BINARY_PACKED · float64: BYTE_STREAM_SPLIT |
| `vid` | INT32, or INT64 when `counts.vertices` > 2³¹ − 1 | REQUIRED | DELTA_BINARY_PACKED |

- `vid` is the welded vertex identity, dense in `0 … counts.vertices − 1`. Rows with the same `vid`
  MUST have identical `x`, `y` and `z`. Rows repeat a `vid` only across bricks, never within one.
- Every vertex row MUST be referenced by at least one face of its brick.
- Attribute columns stored in this table (§8) follow the four core columns.

### 5.2 Coordinate modes

`coords.mode` is either:

- **`"grid"`** (the default). Stored integers `i` map to world coordinates by
  `world = coords.origin + coords.step × i`, per axis, evaluated in IEEE-754 double precision.
  `coords.step` is a positive number, either one scalar or `[sx, sy, sz]`. `coords.origin` is a
  world point. A writer quantises by rounding to the nearest integer, so the error is at most
  `step / 2`. It MUST pick a `step` and `origin` that keep every coordinate within the INT32 range;
  if it cannot, it MUST use float64 mode.
  - In this mode the Parquet min/max statistics of `x`, `y`, `z` in each row group are exact
    lattice bounds, which convert to world bounds by the same formula.
  - Meshes that share the same `step` and `origin` lie on the same lattice. Their shared vertices
    compare exactly as integers, which makes seams between neighbouring meshes bit-exact.
- **`"float64"`**. `x`, `y`, `z` are DOUBLE world coordinates, stored without loss.
  `coords.origin` and `coords.step` MUST be absent.

### 5.3 Self-description

Unzipped, a table should still say what it is. `vertices.parquet` MUST carry a Parquet key–value
metadata entry `wireframe` whose value is JSON:

```json
{ "version": "0.1", "mesh": "topo 2024-09", "table": "vertices", "coords": { "mode": "grid", "origin": [512000, 7400000, 0], "step": 0.0001 } }
```

`faces.parquet` carries the same entry with `"table": "faces"` and no `coords`. The manifest is
authoritative wherever the two differ.

## 6. Face table — `<path>faces.parquet`

### 6.1 Columns

| Column | Physical type | Repetition | Encoding |
|---|---|---|---|
| `a`, `b`, `c` | INT32, or INT64 when `counts.vertexRows` > 2³¹ − 1 | REQUIRED | DELTA_BINARY_PACKED |

- Values are **global row indices** into the vertex table: row numbers counted from the start of the
  table, not from the start of the brick. They are not `vid`s.
- A face MUST NOT repeat a vertex row: `a`, `b` and `c` are distinct. Two rows with the same `vid`
  are a different matter. Readers SHOULD tolerate faces that are geometrically degenerate.

### 6.2 The brick invariant

Both tables MUST have exactly `counts.bricks` row groups. For every brick *k*:

- Row group *k* of the face table holds the faces of brick *k*.
- Every index in those faces lies in row group *k* of the vertex table, that is in
  `[vStart_k, vStart_k + vRows_k)`, where `vStart_k` is the sum of the earlier row groups' row
  counts.

Brick *k* therefore decodes without touching any other brick, and its faces' indices become local
by subtracting `vStart_k`.

### 6.3 Building bricks (informative)

The reference writers:

1. Sort faces by the Morton key of their centroids, quantised to 16 bits per axis over the mesh
   bbox.
2. Cut the sorted faces into runs of `targetFaces`, 65536 by default. The last run may be shorter.
3. Within each brick, give vertices rows in order of first use by that brick's faces. A vertex
   shared with another brick gets a row in each.

Measured on 8M-face meshes: 2–2.2% of vertex rows are duplicates at 64k faces per brick, against
about 485% if faces are cut into bricks in their original, unsorted order.

Statistics: writers MUST write per-column-chunk min/max statistics for `x`, `y`, `z`. They SHOULD
write them for `a`, `b`, `c` and `vid`, and MAY write the column and offset indexes.

## 7. Integrity

`members` maps member names to `{ size, sha256 }`, the byte length and lowercase hex SHA-256 of the
member's data. It covers every member except `mimetype` and `wireframe.json`. Writers MUST fill it
for every member they write; readers MAY verify on demand. A member present in the central
directory but missing from `members` is not an error, but a verifying reader SHOULD report it.

## 8. Attribute columns

An attribute is a value per vertex or per face: grade, a domain code, colour, a normal, a part id.

- `location` is `"vertices"` or `"faces"`. Attribute values are per **row** of that table. For
  vertex attributes, rows sharing a `vid` MUST have equal values.
- **Inline** (`member`): extra columns in a core table, written when the mesh is created.
- **Separate** (`path`): a member holding a single Parquet column named after the attribute, with
  row groups of the same sizes as that location's core table, so brick *k* is row group *k* here as
  well. Separate members are how columns are added later (§3.4). The reference writers use
  `<mesh path>columns/<location>/<percent-encoded name>.parquet`, but readers MUST take the path
  from the manifest.
- Attributes MAY have any Parquet type, logical type, encoding or nullability. Readers that support
  only some MUST fail with an error naming the column, never by returning wrong values. (Required
  columns decode faster than nullable ones, so writers SHOULD prefer REQUIRED.)
- Column names MUST be unique per mesh and location. `x`, `y`, `z`, `vid`, `a`, `b` and `c` are
  reserved.

## 9. Constraints on core columns

So that small, fast readers are possible, the core columns (`x y z vid a b c`) MUST:

- be REQUIRED (maximum definition and repetition levels 0);
- use only the encodings given in §5.1 and §6.1, with no dictionary pages;
- use compression codec UNCOMPRESSED or SNAPPY (UNCOMPRESSED is RECOMMENDED: delta coding has already
  removed the redundancy snappy would find);
- use data page V1 or V2. Readers MUST accept both.

Readers MUST NOT rely on any particular page size or count within a column chunk.

## 10. Reserved

- `lod/` is reserved for level-of-detail and other derived caches. Contents are unspecified in 0.1;
  readers MUST ignore it.
- Manifest fields not defined here are reserved for future minor versions. Writers MUST NOT invent
  top-level fields; private extensions go under a key prefixed `x-`.

## 11. Reading by region (informative)

1. Open the ZIP (§3.2), check `mimetype`, and parse `wireframe.json`.
2. For each mesh of interest, pick bricks from `bricks.directory`, or from the vertex table's footer
   (the row-group statistics of `x`, `y`, `z`, converted to world by §5.2).
3. For each chosen brick, range-read row group *k* of both tables, decode, and subtract `vStart_k`
   from the face indices.
4. Weld across bricks by `vid` when needed. Rendering usually doesn't need it, since duplicated
   rows are bit-identical.

## 12. Open questions for 0.2

- An optional GPU-ready cache under `lod/` or a sibling prefix: frame-of-reference bit-packed
  blocks, unpackable in a vertex shader. In experiments FOR was slightly smaller than Parquet delta
  for first-use vertex order, and independently decodable.
- Polylines (design strings, contours) and points as mesh-adjacent element kinds.
- Named parts and per-part topology.
- Variable-size bricks for meshes with very uneven density.
