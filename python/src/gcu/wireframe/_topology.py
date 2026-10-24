"""Topology of a triangle element (SPEC §7.3), vectorized. Edges compare by vid.
   closed   — every edge is shared by exactly two faces
   oriented — every edge shared by two faces is traversed in opposite directions by them
   manifold — the faces around every vertex form a single fan
   volume   — signed enclosed volume, when closed and oriented (summed face by face in the given
              order, like the JS reference, so both report the same number)"""
from __future__ import annotations

import numpy as np


def check_topology(F, corner_pos=None, step=None, n_vertices=None):
    """F: (m, 3) vertex ids. corner_pos: (m, 3, 3) corner coordinates (stored units) for the volume;
    step: grid step(s) converting stored units to world (None → already world)."""
    F = np.asarray(F, np.int64).reshape(-1, 3)
    m = len(F)
    if m == 0:
        return {"closed": False, "oriented": True, "manifold": True, "volume": None, "status": "checked"}
    # half-edges u→v of every face, as (lo, hi, dir)
    u = F.ravel()
    v = F[:, [1, 2, 0]].ravel()
    lo, hi, fwd = np.minimum(u, v), np.maximum(u, v), (u < v)
    o = np.argsort(lo * (int(F.max()) + 1) + hi)       # one int64 key: ~4× faster than lexsort((hi, lo))
    lo_s, hi_s, fwd_s = lo[o], hi[o], fwd[o]
    new = np.ones(len(o), bool)
    new[1:] = (lo_s[1:] != lo_s[:-1]) | (hi_s[1:] != hi_s[:-1])
    eid = np.cumsum(new) - 1
    tot = np.bincount(eid)
    nf = np.bincount(eid, weights=fwd_s).astype(np.int64)
    nr = tot - nf
    closed = bool((tot == 2).all())
    oriented = bool(((nf <= 1) & (nr <= 1)).all())
    manifold = bool((tot <= 2).all())
    if manifold:
        manifold = _single_fans(F, o, eid, tot)
    volume = None
    if closed and oriented:
        P = np.asarray(corner_pos, np.float64)
        ref = P[0, 0]
        s = np.ones(3) if step is None else np.asarray(step, np.float64)
        A, B, C = (P[:, 0] - ref) * s, (P[:, 1] - ref) * s, (P[:, 2] - ref) * s
        t = A[:, 0] * (B[:, 1] * C[:, 2] - B[:, 2] * C[:, 1]) - A[:, 1] * (B[:, 0] * C[:, 2] - B[:, 2] * C[:, 0]) + A[:, 2] * (B[:, 0] * C[:, 1] - B[:, 1] * C[:, 0])
        volume = float(np.cumsum(t)[-1] / 6)            # sequential, as the reference sums it
    return {"closed": closed, "oriented": oriented, "manifold": manifold, "volume": volume, "status": "checked"}


def _single_fans(F, o, eid, tot):
    """Every vertex's faces form one fan: label-propagate over 'corner' nodes (face f at vertex v),
    joining the two corners of an interior edge at each of its endpoints; then count components per
    vertex. (Edges here are already known to have ≤ 2 faces.)"""
    m = len(F)
    # corner c = 3f + j is face f at vertex F[f, j]. Half-edge h = 3f + j runs F[f,j] → F[f,j+1]:
    # at its start it is corner c's slot-0 edge, at its end corner (3f + (j+1)%3)'s slot-1 edge. Each
    # corner thus has ≤ 2 neighbours (one per slot), so propagation is two gathers — no ufunc.at.
    nb = np.tile(np.arange(3 * m), (2, 1))            # nb[slot, corner] → neighbour (self if none)
    pair = np.nonzero(eid[:-1] == eid[1:])[0] if len(eid) > 1 else np.zeros(0, np.int64)
    h1, h2 = o[pair], o[pair + 1]                       # the two half-edges of each interior edge
    f1, j1, f2, j2 = h1 // 3, h1 % 3, h2 // 3, h2 % 3
    s1, e1 = 3 * f1 + j1, 3 * f1 + (j1 + 1) % 3         # h1's start / end corners
    s2, e2 = 3 * f2 + j2, 3 * f2 + (j2 + 1) % 3
    same = F[f1, j1] == F[f2, j2]                       # same direction → starts meet starts
    a2, b2 = np.where(same, s2, e2), np.where(same, e2, s2)          # h2's corners at h1's start / end
    sa2, sb2 = np.where(same, 0, 1), np.where(same, 1, 0)            # …and their slots
    nb[0, s1], nb[1, e1] = a2, b2
    nb[sa2, a2], nb[sb2, b2] = s1, e1
    lab = np.arange(3 * m)
    for _ in range(10000):
        nxt = np.minimum(lab, np.minimum(lab[nb[0]], lab[nb[1]]))
        nxt = nxt[nxt]                                  # pointer jump
        if np.array_equal(nxt, lab):
            break
        lab = nxt
    # a component's label is its smallest corner id — itself a corner at that vertex — so the fans at
    # a vertex are its corners that are their own label (no sort needed)
    roots = lab == np.arange(3 * m)
    fans = np.bincount(F.ravel()[roots])
    return bool((fans[fans > 0] == 1).all())
