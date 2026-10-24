"""The reading API on golden.wfr, plus round trips and the topology check."""
from pathlib import Path

import numpy as np
import pytest

import gcu.wireframe as wf

TD = Path(__file__).resolve().parents[2] / "testdata"


def grid(n, ox=400000.0, oy=7000000.0):
    w = n + 1
    i, j = np.meshgrid(np.arange(w), np.arange(w))
    V = np.stack([ox + i.ravel() * 2.0, oy + j.ravel() * 2.0, 300 + np.sin(i.ravel() / 5.0)], axis=1)
    a = (np.arange(n)[None, :] + np.arange(n)[:, None] * w).ravel()
    F = np.concatenate([np.stack([a, a + 1, a + w + 1], 1), np.stack([a, a + w + 1, a + w], 1)])
    return V, F


def cube(s=10.0, o=(300000.0, 7500000.0, 100.0)):
    P = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], float) * s + o
    F = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]])
    return P, F


def test_open_and_query_golden():
    with wf.open(TD / "golden.wfr") as f:
        assert [e.name for e in f] == ["cube", "terrain", "lodes", "strings", "pegs"]
        t = f["terrain"]
        assert t.n_bricks == 7 and t.kind == "triangles"
        bb = t.brick_bbox(0)
        assert bb.shape == (6,) and (bb[:3] <= bb[3:]).all()
        whole = np.array(t.bbox)
        assert t.bricks_in(whole) == list(range(7))
        assert t.bricks_in([0, 0, 0, 1, 1, 1]) == []
        b = t.read_brick(0)
        assert b.cells.min() >= 0 and b.cells.max() < len(b.positions)
        assert "dz" in b.vertex_attributes and "domain" in b.cell_attributes
        m = f["cube"].to_mesh()
        assert m.vertices.shape == (8, 3) and m.cells.shape == (12, 3)
        assert m.vertex_attributes["color.r"].tolist() == [0, 40, 80, 120, 160, 200, 240, 255]
        p = f["pegs"].to_mesh()
        assert p.vertices.shape == (300, 3) and set(p.vertex_attributes["layer"].tolist()) == {"A", "B", "C"}
        s = f["strings"].to_mesh()
        assert s.cells.shape == (12, 2) and set(s.cell_attributes["layer"].tolist()) == {"CREST", "TOE"}


def test_roundtrip_faces_and_positions(tmp_path):
    V, F = grid(60)
    rng = np.random.default_rng(3)
    vp, fp = rng.permutation(len(V)), rng.permutation(len(F))
    V2 = np.empty_like(V); V2[vp] = V
    F2 = vp[F][fp]
    dz = np.sin(np.arange(len(V2))).astype(np.float32)
    out = tmp_path / "t.wfr"
    wf.write(out, [wf.Triangles("t", V2, F2, target=1000, vertex_attributes={"dz": dz})])
    with wf.open(out) as f:
        el = f["t"]
        assert el.n_bricks == int(np.ceil(len(F) / 1000))
        m = el.to_mesh()
        # vid = rank among referenced vertices = input index here (all referenced)
        assert np.abs(m.vertices - V2).max() <= 0.5e-4 + 1e-9
        assert np.array_equal(m.vertex_attributes["dz"], dz)
        norm = lambda T: sorted(tuple(np.roll(t, -int(np.argmin(t)))) for t in T.tolist())
        assert norm(m.cells) == norm(F2)


def test_float64_is_lossless_and_points(tmp_path):
    P = np.random.default_rng(1).random((5000, 3)) * 1000 + [512000, 7400000, 0]
    out = tmp_path / "p.wfr"
    wf.write(out, [wf.Points("p", P, step=None, target=512, keep_vid=True, vertex_attributes={"id": np.arange(5000, dtype=np.int32)})])
    with wf.open(out) as f:
        m = f["p"].to_mesh()
        assert np.array_equal(m.vertices, P)
        assert np.array_equal(m.vertex_attributes["id"], np.arange(5000))


def test_topology():
    P, F = cube()
    t = wf.check_topology(F, P[F], None)
    assert t["closed"] and t["oriented"] and t["manifold"] and abs(t["volume"] - 1000) < 1e-6
    Ff = F.copy(); Ff[0, [1, 2]] = Ff[0, [2, 1]]
    t2 = wf.check_topology(Ff, P[Ff], None)
    assert t2["closed"] and not t2["oriented"] and t2["volume"] is None
    V, G = grid(10)
    t3 = wf.check_topology(G, V[G], None)
    assert not t3["closed"] and t3["oriented"] and t3["manifold"]
    # two cubes sharing one vertex: closed, but that vertex has two fans → not manifold
    P2, F2 = cube(o=(300010.0, 7500010.0, 110.0))
    FF = np.concatenate([F, F2 + 8]); FF[FF == 8] = 6
    PP = np.concatenate([P, P2])
    t4 = wf.check_topology(FF, PP[FF], None)
    assert t4["closed"] and not t4["manifold"]


def test_errors(tmp_path):
    V, F = grid(2)
    with pytest.raises(ValueError, match="reserved"):
        wf.write(tmp_path / "x.wfr", [wf.Triangles("t", V, F, vertex_attributes={"vid": np.zeros(len(V))})])
    with pytest.raises(ValueError, match="overflows INT32"):
        wf.write(tmp_path / "x.wfr", [wf.Triangles("t", V * [1e6, 1, 1], F, step=1e-4)])
    with pytest.raises(ValueError, match="duplicate"):
        wf.write(tmp_path / "x.wfr", [wf.Points("a", V), wf.Points("a", V)])
