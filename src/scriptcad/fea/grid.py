"""Voxel linear-elastic problem shared by every solver backend.

Units are mm, N and MPa (N/mm^2), matching the CAD side.

Layout (identical in NumPy, Warp and WGSL so results can be compared value by value):

* voxel (i, j, k), i fastest:      e = i + nx * (j + ny * k)
* node  (I, J, K), I fastest:      n = I + (nx + 1) * (J + (ny + 1) * K)
* DOF 3 n + c, c = x, y, z
* ``emod[e]``: Young's modulus of voxel e (0 for void)
* ``fixed[3 n + c]``: 1 if that DOF is held at zero (supports, and every DOF of
  a node no solid voxel touches)
* ``force[3 n + c]``: applied nodal force
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

from .element import CORNERS, center_strain_operator, constitutive, stiffness, von_mises


@dataclass
class Problem:
    shape: tuple[int, int, int]          # (nx, ny, nz) voxels
    h: float                             # voxel edge, mm
    origin: np.ndarray                   # world position of node (0, 0, 0)
    emod: np.ndarray                     # (nvox,) float, MPa
    nu: float
    formulation: str = "hex8i"
    fixed: np.ndarray = None             # (3 nn,) uint8
    force: np.ndarray = None             # (3 nn,) float64
    name: str = ""
    meta: dict = field(default_factory=dict)

    def __post_init__(self):
        self.origin = np.asarray(self.origin, dtype=np.float64)
        self.emod = np.ascontiguousarray(self.emod, dtype=np.float64).ravel()
        if self.fixed is None:
            self.fixed = np.zeros(3 * self.n_nodes, dtype=np.uint8)
        if self.force is None:
            self.force = np.zeros(3 * self.n_nodes)
        self.fixed[np.repeat(~self.active_nodes(), 3)] = 1

    # --- indexing -----------------------------------------------------------
    @property
    def n_nodes(self):
        nx, ny, nz = self.shape
        return (nx + 1) * (ny + 1) * (nz + 1)

    @property
    def n_dofs(self):
        return 3 * self.n_nodes

    @property
    def n_solid(self):
        return int((self.emod > 0).sum())

    def voxel_ijk(self):
        nx, ny, nz = self.shape
        e = np.arange(nx * ny * nz)
        return e % nx, (e // nx) % ny, e // (nx * ny)

    def element_nodes(self):
        """(nvox, 8) node indices of every voxel, corner order of element.CORNERS (kept: the
        grid never changes shape, and supports, loads and stresses each need it)."""
        if getattr(self, "_element_nodes", None) is None:
            nx, ny, _ = self.shape
            i, j, k = self.voxel_ijk()
            self._element_nodes = np.stack([(i + di) + (nx + 1) * ((j + dj) + (ny + 1) * (k + dk))
                                            for di, dj, dk in CORNERS], axis=1)
        return self._element_nodes

    def element_dofs(self):
        en = self.element_nodes()
        return (3 * en[:, :, None] + np.arange(3)).reshape(len(en), 24)

    def node_xyz(self):
        nx, ny, nz = self.shape
        n = np.arange(self.n_nodes)
        ii, jj, kk = n % (nx + 1), (n // (nx + 1)) % (ny + 1), n // ((nx + 1) * (ny + 1))
        return self.origin + self.h * np.stack([ii, jj, kk], axis=1)

    def voxel_centers(self):
        i, j, k = self.voxel_ijk()
        return self.origin + self.h * (np.stack([i, j, k], axis=1) + 0.5)

    def active_nodes(self):
        act = np.zeros(self.n_nodes, dtype=bool)
        solid = self.emod > 0
        act[self.element_nodes()[solid].ravel()] = True
        return act

    # --- element data -------------------------------------------------------
    def ke(self) -> np.ndarray:
        """24x24 stiffness for E = 1 at this voxel size."""
        return stiffness(float(self.nu), self.formulation) * self.h

    # --- supports and loads -------------------------------------------------
    def _locate(self, pts):
        """Containing voxel of each point, snapped to the nearest solid voxel within 1.5 h."""
        from scipy.spatial import cKDTree
        solid = np.flatnonzero(self.emod > 0)
        tree = cKDTree(self.voxel_centers()[solid])
        d, idx = tree.query(np.asarray(pts, dtype=np.float64))
        if np.any(d > 1.5 * self.h):
            raise ValueError(f"{int((d > 1.5 * self.h).sum())} load points are more than 1.5 voxels from the solid")
        return solid[idx]

    def add_point_forces(self, pts, forces):
        """Distribute point forces to the 8 nodes of their voxel with trilinear weights."""
        pts = np.asarray(pts, dtype=np.float64)
        forces = np.asarray(forces, dtype=np.float64)
        vox = self._locate(pts)
        nx, ny, _ = self.shape
        i, j, k = vox % nx, (vox // nx) % ny, vox // (nx * ny)
        local = (pts - self.origin) / self.h - np.stack([i, j, k], axis=1)
        local = np.clip(local, 0.0, 1.0)
        nodes = self.element_nodes()[vox]
        for a, (di, dj, dk) in enumerate(CORNERS):
            w = ((local[:, 0] if di else 1 - local[:, 0]) * (local[:, 1] if dj else 1 - local[:, 1])
                 * (local[:, 2] if dk else 1 - local[:, 2]))
            for c in range(3):
                np.add.at(self.force, 3 * nodes[:, a] + c, w * forces[:, c])

    def fix_near(self, pts, radius=None, components=(0, 1, 2)):
        """Hold every active node within `radius` (default 0.75 h) of the given points."""
        from scipy.spatial import cKDTree
        radius = 0.75 * self.h if radius is None else radius
        act = np.flatnonzero(self.active_nodes())
        tree = cKDTree(self.node_xyz()[act])
        hit = set()
        for lst in tree.query_ball_point(np.asarray(pts, dtype=np.float64), radius):
            hit.update(lst)
        nodes = act[sorted(hit)]
        for c in components:
            self.fixed[3 * nodes + c] = 1
        return len(nodes)

    def fix_where(self, predicate, components=(0, 1, 2)):
        """Hold active nodes whose coordinates satisfy predicate(xyz) -> bool array."""
        act = self.active_nodes()
        sel = act & predicate(self.node_xyz())
        for c in components:
            self.fixed[3 * np.flatnonzero(sel) + c] = 1
        return int(sel.sum())

    # --- post-processing ----------------------------------------------------
    def stresses(self, u: np.ndarray) -> np.ndarray:
        """Voigt stress (nvox, 6) at each voxel centre; zero in void."""
        b0 = center_strain_operator() / self.h
        d = constitutive(self.nu)
        ue = u[self.element_dofs()]
        s = (ue @ b0.T) @ d.T
        return s * self.emod[:, None]

    def von_mises(self, u):
        return von_mises(self.stresses(u))

    def residual(self, u):
        """|f - K u| / |f| with K applied matrix-free in float64 (fixed DOFs excluded)."""
        from .cpu import apply_k
        r = self.force - apply_k(self, u)
        r[self.fixed == 1] = 0
        f = self.force.copy()
        f[self.fixed == 1] = 0
        return float(np.linalg.norm(r) / np.linalg.norm(f))

    # --- wire format (for the browser) --------------------------------------
    def to_bytes(self) -> bytes:
        """Little-endian blob: header, KE (f32 24x24), emod (f32), fixed (u8 padded), force (f32)."""
        nx, ny, nz = self.shape
        head = struct.pack("<4s6I4f", b"VXF1", nx, ny, nz, self.n_nodes, self.n_solid, 0,
                           self.h, *self.origin.astype(np.float32))
        fixed = self.fixed.astype(np.uint32)       # WGSL storage has no u8
        return b"".join([
            head,
            self.ke().astype("<f4").tobytes(),
            self.emod.astype("<f4").tobytes(),
            fixed.astype("<u4").tobytes(),
            self.force.astype("<f4").tobytes(),
        ])

    def to_wire(self) -> bytes:
        """to_bytes() for sending, a third of the size: the held flags as bits (every node off
        the part is held), the loads as a sparse list (VXF2: header, KE, emod, held bits
        padded to 4 bytes, u32 count + u32 indices + f32 forces). solver.js inflate() makes
        a VXF1 of it."""
        nx, ny, nz = self.shape
        head = struct.pack("<4s6I4f", b"VXF2", nx, ny, nz, self.n_nodes, self.n_solid, 0,
                           self.h, *self.origin.astype(np.float32))
        held = np.packbits(self.fixed != 0, bitorder="little")
        held = np.concatenate([held, np.zeros(-len(held) % 4, dtype=np.uint8)])
        loaded = np.flatnonzero(self.force).astype("<u4")
        return b"".join([
            head,
            self.ke().astype("<f4").tobytes(),
            self.emod.astype("<f4").tobytes(),
            held.tobytes(),
            np.array([len(loaded)], dtype="<u4").tobytes(), loaded.tobytes(),
            self.force[loaded].astype("<f4").tobytes(),
        ])


def voxelize_mesh(tris: np.ndarray, h: float, pad: int = 1, lo=None, shape=None) -> tuple[np.ndarray, np.ndarray, tuple]:
    """Solid occupancy of a closed triangle mesh by ray parity along +z.

    tris: (n, 3, 3) triangle vertices. Returns (occ (nvox,) bool, origin, shape). lo and
    shape: a given grid (to compare two meshes voxel by voxel), else the mesh's bounds + pad.
    A voxel is solid when its centre is inside. Rays are cast through voxel-centre
    columns and nudged off exact vertex/edge alignment to keep the parity count robust.
    """
    tris = np.asarray(tris, dtype=np.float64)
    if lo is None:
        lo = tris.reshape(-1, 3).min(0) - pad * h
        hi = tris.reshape(-1, 3).max(0) + pad * h
        shape = tuple(int(np.ceil((hi[a] - lo[a]) / h)) for a in range(3))
    lo = np.asarray(lo, dtype=np.float64)
    nx, ny, nz = shape
    occ = np.zeros((nz, ny, nx), dtype=bool)
    eps = 1e-7 * h
    cx = lo[0] + h * (np.arange(nx) + 0.5) + 0.37 * eps
    cy = lo[1] + h * (np.arange(ny) + 0.5) + 0.61 * eps
    zc = lo[2] + h * (np.arange(nz) + 0.5)
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    # bounding columns per triangle
    tmin = tris[:, :, :2].min(1)
    tmax = tris[:, :, :2].max(1)
    i0 = np.clip(np.floor((tmin[:, 0] - lo[0]) / h - 0.5).astype(int), 0, nx - 1)
    i1 = np.clip(np.ceil((tmax[:, 0] - lo[0]) / h - 0.5).astype(int), 0, nx - 1)
    j0 = np.clip(np.floor((tmin[:, 1] - lo[1]) / h - 0.5).astype(int), 0, ny - 1)
    j1 = np.clip(np.ceil((tmax[:, 1] - lo[1]) / h - 0.5).astype(int), 0, ny - 1)
    hits = [[[] for _ in range(nx)] for _ in range(ny)]
    for t in range(len(tris)):
        ii = np.arange(i0[t], i1[t] + 1)
        jj = np.arange(j0[t], j1[t] + 1)
        if not len(ii) or not len(jj):
            continue
        X, Y = np.meshgrid(cx[ii], cy[jj])
        # barycentric test in xy
        v0, v1 = b[t, :2] - a[t, :2], c[t, :2] - a[t, :2]
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-18:
            continue
        px, py = X - a[t, 0], Y - a[t, 1]
        s = (px * v1[1] - v1[0] * py) / den
        r = (v0[0] * py - px * v0[1]) / den
        inside = (s >= 0) & (r >= 0) & (s + r <= 1)
        if not inside.any():
            continue
        z = a[t, 2] + s * (b[t, 2] - a[t, 2]) + r * (c[t, 2] - a[t, 2])
        for (jn, in_), zz in zip(np.argwhere(inside), z[inside]):
            hits[jj[jn]][ii[in_]].append(zz)
    for j in range(ny):
        for i in range(nx):
            zs = hits[j][i]
            if len(zs) < 2:
                continue
            zs = np.sort(zs)
            for z0, z1 in zip(zs[0::2], zs[1::2]):
                occ[(zc > z0) & (zc < z1), j, i] = True
    return occ.ravel(), lo, shape


def _ray_fill(tris: np.ndarray, h: float, lo: np.ndarray, shape: tuple, axis: int):
    """Rays parallel to `axis` through the voxel centres of a grid: per voxel (z, y, x order),
    whether its centre is inside the closed mesh and the fraction of its length along the
    ray that is inside."""
    a, b = [(1, 2), (2, 0), (0, 1)][axis]                  # the other two axes, as x and y of the rays
    T = tris[:, :, [a, b, axis]]
    la, lb, lc = lo[a], lo[b], lo[axis]
    na, nb, nc = shape[a], shape[b], shape[axis]
    eps = 1e-7 * h
    ca = la + h * (np.arange(na) + 0.5) + 0.37 * eps
    cb = lb + h * (np.arange(nb) + 0.5) + 0.61 * eps
    inside = np.zeros((nc, nb, na), dtype=bool)
    fill = np.zeros((nc, nb, na))
    p, q, r = T[:, 0], T[:, 1], T[:, 2]
    tmin, tmax = T[:, :, :2].min(1), T[:, :, :2].max(1)
    i0 = np.clip(np.floor((tmin[:, 0] - la) / h - 0.5).astype(int), 0, na - 1)
    i1 = np.clip(np.ceil((tmax[:, 0] - la) / h - 0.5).astype(int), 0, na - 1)
    j0 = np.clip(np.floor((tmin[:, 1] - lb) / h - 0.5).astype(int), 0, nb - 1)
    j1 = np.clip(np.ceil((tmax[:, 1] - lb) / h - 0.5).astype(int), 0, nb - 1)
    hits = {}
    for t in range(len(T)):
        ii, jj = np.arange(i0[t], i1[t] + 1), np.arange(j0[t], j1[t] + 1)
        if not len(ii) or not len(jj):
            continue
        X, Y = np.meshgrid(ca[ii], cb[jj])
        v0, v1 = q[t, :2] - p[t, :2], r[t, :2] - p[t, :2]
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-18:
            continue
        px, py = X - p[t, 0], Y - p[t, 1]
        s = (px * v1[1] - v1[0] * py) / den
        w = (v0[0] * py - px * v0[1]) / den
        hit = (s >= 0) & (w >= 0) & (s + w <= 1)
        if not hit.any():
            continue
        z = p[t, 2] + s * (q[t, 2] - p[t, 2]) + w * (r[t, 2] - p[t, 2])
        for (jn, in_), zz in zip(np.argwhere(hit), z[hit]):
            hits.setdefault((jj[jn], ii[in_]), []).append(zz)
    # every inside interval of every ray at once: voxels it covers whole, as +1/-1 at its ends
    # summed along the ray, and the two partly covered voxels at its ends added on top
    J, I, Z0, Z1 = [], [], [], []
    for (j, i), zs in hits.items():
        if len(zs) < 2:
            continue
        zs = np.sort(zs)
        J += [j] * (len(zs) // 2); I += [i] * (len(zs) // 2)
        Z0 += list(zs[0::2]); Z1 += list(zs[1::2])
    if J:
        J, I, Z0, Z1 = np.array(J), np.array(I), np.array(Z0), np.array(Z1)
        a0, a1 = (Z0 - lc) / h, (Z1 - lc) / h                # interval ends, in voxels along the ray
        k0, k1 = np.floor(a0).astype(int), np.floor(a1).astype(int)
        run = np.zeros((nc + 1, nb, na))
        full0, full1 = np.clip(k0 + 1, 0, nc), np.clip(k1, 0, nc)    # whole voxels: k0+1 .. k1-1
        ok = full1 > full0
        np.add.at(run, (full0[ok], J[ok], I[ok]), 1)
        np.add.at(run, (full1[ok], J[ok], I[ok]), -1)
        fill += np.cumsum(run, axis=0)[:nc]
        same = k0 == k1                                         # an interval within one voxel
        for k, part in ((k0, np.where(same, a1 - a0, k0 + 1 - a0)), (k1[~same], (a1 - k1)[~same])):
            jj, ii = (J, I) if len(k) == len(J) else (J[~same], I[~same])
            m = (k >= 0) & (k < nc)
            np.add.at(fill, (k[m], jj[m], ii[m]), part[m])
        c0 = np.clip(np.ceil(a0 - 0.5 + 1e-9).astype(int), 0, nc)        # centres strictly inside
        c1 = np.clip(np.floor(a1 - 0.5 - 1e-9).astype(int) + 1, 0, nc)
        ok = c1 > c0
        run[:] = 0
        np.add.at(run, (c0[ok], J[ok], I[ok]), 1)
        np.add.at(run, (c1[ok], J[ok], I[ok]), -1)
        inside |= np.cumsum(run, axis=0)[:nc] > 0
    order = [(axis, b, a).index(t) for t in (2, 1, 0)]
    return inside.transpose(order), np.minimum(fill, 1).transpose(order)


def voxel_fill(tris: np.ndarray, h: float, pad: int = 1, lo=None, shape=None) -> tuple[np.ndarray, np.ndarray, tuple]:
    """How much of each voxel a closed triangle mesh fills, 0..1: (fill (nvox,), origin, shape).

    Rays along x, y and z through the voxel centres each give the fraction of a voxel's length
    inside; a voxel whose centre is inside takes the least of the three, one whose centre is
    outside the most. Exact for a face square to an axis, so a stiffness scaled by it changes
    smoothly as a face moves within a voxel (all-or-nothing voxels change in jumps of a whole
    voxel). lo and shape: a given grid, else the mesh's bounds + pad (as voxelize_mesh).
    """
    tris = np.asarray(tris, dtype=np.float64)
    if lo is None:
        lo = tris.reshape(-1, 3).min(0) - pad * h
        hi = tris.reshape(-1, 3).max(0) + pad * h
        shape = tuple(int(np.ceil((hi[a] - lo[a]) / h)) for a in range(3))
    lo = np.asarray(lo, dtype=np.float64)
    inside, fz = _ray_fill(tris, h, lo, shape, 2)
    _, fx = _ray_fill(tris, h, lo, shape, 0)
    _, fy = _ray_fill(tris, h, lo, shape, 1)
    f = np.where(inside, np.minimum(np.minimum(fx, fy), fz), np.maximum(np.maximum(fx, fy), fz))
    return f.ravel(), lo, shape
