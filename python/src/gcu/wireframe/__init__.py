"""gcu.wireframe — read and write .wfr (https://gentropic.org/wireframe/).

    import gcu.wireframe as wf
    with wf.open("topo.wfr") as f:
        el = f["topo"]
        ks = el.bricks_in([x0, y0, -1e9, x1, y1, 1e9])     # footer statistics only
        b = el.read_brick(ks[0])                            # world float64 positions + local cells
        mesh = el.to_mesh()                                 # the whole element, welded by vid

    wf.write("out.wfr", [wf.Triangles("surface", vertices, faces, topology="check"),
                         wf.Points("pegs", xyz, vertex_attributes={"id": ids})])
"""
from ._read import open, WfrFile, Element, Brick, Mesh, MIMETYPE
from ._write import write, Triangles, Lines, Polylines, Points, FORMAT_VERSION, SPEC_URL
from ._topology import check_topology

__all__ = ["open", "write", "Triangles", "Lines", "Polylines", "Points", "WfrFile", "Element", "Brick", "Mesh", "check_topology", "MIMETYPE", "FORMAT_VERSION", "SPEC_URL"]
__version__ = "0.0.1"
