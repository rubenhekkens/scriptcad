"""Analyze mode: a body from the feature history -> voxel problem -> stress on the viewer mesh.

The browser solves the problem (WebGPU multigrid, web/fea/multigrid.js); this module
only builds it and post-processes the displacements it sends back.

Supports and loads are faces of the body (picked in the viewport, stored as 3D
reference points and resolved by the kernel). Their triangles are sampled at half a
voxel spacing so every face is fully held or loaded regardless of how coarsely it
was tessellated.
"""

from __future__ import annotations

import math
import time
import uuid

import numpy as np

from .grid import Problem, voxelize_mesh

# Typical room-temperature values (E in MPa). Enough for comparing designs, not for sign-off.
MATERIALS = {   # key: (label, E MPa, Poisson, density g/cm3)
    "steel": ("Steel", 210_000.0, 0.30, 7.85),
    "aluminium": ("Aluminium", 70_000.0, 0.33, 2.70),
    "titanium": ("Titanium Ti-6Al-4V", 114_000.0, 0.34, 4.43),
    "pa6gf30": ("PA6-GF30 (glass-filled nylon)", 9_000.0, 0.35, 1.36),
    "abs": ("ABS", 2_300.0, 0.35, 1.05),
    "pla": ("PLA", 3_500.0, 0.36, 1.24),
}
QUALITY_VOXELS = {"draft": 60_000, "normal": 200_000, "fine": 600_000}
MAX_GRID_CELLS = 40_000_000

_cases: dict[str, dict] = {}


def _sample_triangles(tris, spacing):
    """Points covering each triangle at ~spacing, with area weights and unit normals."""
    pts, wts, nrm = [], [], []
    for tri in tris:
        n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        area = 0.5 * np.linalg.norm(n)
        if area < 1e-12:
            continue
        n = n / (2 * area)
        # Grid aligned with the longest edge: ~L/spacing along it, ~height/spacing across.
        # The count scales with area, so long thin CAD triangles (slivers on big planar
        # faces) stay cheap and still get covered end to end.
        lens = [np.linalg.norm(tri[(i + 1) % 3] - tri[i]) for i in range(3)]
        i0 = int(np.argmax(lens))
        a, b, c = tri[i0], tri[(i0 + 1) % 3], tri[(i0 + 2) % 3]
        ns = max(1, int(math.ceil(lens[i0] / spacing)))
        nt = max(4, int(math.ceil((2 * area / lens[i0]) / spacing)))
        u = (np.arange(ns) + 0.5) / ns
        v = (np.arange(nt) + 0.5) / nt
        U, V = np.meshgrid(u, v, indexing="ij")
        U, V = U.ravel(), V.ravel()
        p = (1 - V)[:, None] * (a + U[:, None] * (b - a)) + V[:, None] * c
        w = area * 2 * (1 - V) / (ns * nt)          # Jacobian of the square-to-triangle map
        pts.append(p)
        wts.append(w * (area / w.sum()))
        nrm.append(np.tile(n, (len(p), 1)))
    if not pts:
        return np.zeros((0, 3)), np.zeros(0), np.zeros((0, 3))
    return np.concatenate(pts), np.concatenate(wts), np.concatenate(nrm)


def build(geom, setup):
    """Problem for one body. geom: kernel.analysis_geometry output. Returns (case_id, blob, meta)."""
    t0 = time.perf_counter()
    corners = np.asarray(geom["positions"], dtype=np.float64).reshape(-1, 3)
    tris = corners.reshape(-1, 3, 3)
    tri_face = np.asarray(geom["triFace"])
    mat_key = setup.get("material", "steel")
    if mat_key not in MATERIALS:
        raise ValueError(f"unknown material {mat_key}")
    _, E, nu, rho = MATERIALS[mat_key]

    lo, hi = np.array(geom["bbox"][0]), np.array(geom["bbox"][1])
    volume = float(geom.get("volume") or 0.0)
    if volume <= 0:
        raise ValueError("this body has no volume")
    target = QUALITY_VOXELS.get(setup.get("quality", "normal"), QUALITY_VOXELS["normal"])
    h = (volume / target) ** (1 / 3)
    span = hi - lo
    while np.prod(np.ceil(span / h) + 2) > MAX_GRID_CELLS:
        h *= 1.15
    h = float(f"{h:.3g}")

    occ, origin, shape = voxelize_mesh(tris, h)
    if not occ.any():
        raise ValueError("voxelization found no solid; is the body closed?")
    p = Problem(shape, h, origin, np.where(occ, E, 0.0), nu, "hex8i", name="analysis")

    groups = geom["groups"]
    fixed_tris = tris[np.isin(tri_face, groups.get("fixed", []))]
    load_tris = tris[np.isin(tri_face, groups.get("load", []))]
    if not len(fixed_tris):
        raise ValueError("pick at least one fixed face")
    if not len(load_tris):
        raise ValueError("pick at least one load face")

    fp, _, _ = _sample_triangles(fixed_tris, 0.5 * h)
    n_fixed = p.fix_near(fp, radius=0.75 * h)
    if n_fixed < 3:
        raise ValueError("the fixed faces hold too few voxel nodes - use a finer quality")

    lp, lw, ln = _sample_triangles(load_tris, 0.5 * h)
    load = setup.get("load", {})
    kind = load.get("type", "force")
    if kind == "force":
        F = np.asarray(load.get("vector", [0, 0, -1000]), dtype=np.float64)
        forces = np.outer(lw / lw.sum(), F)
        applied = f"{np.linalg.norm(F):.4g} N"
    elif kind == "pressure":
        pr = float(load.get("pressure", 1.0))
        forces = -pr * ln * lw[:, None]
        applied = f"{pr:.4g} MPa on {lw.sum():.4g} mm²"
    elif kind == "torque":
        axis = np.asarray({"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[load.get("axis", "Z")], dtype=np.float64)
        T = float(load.get("torque", 10.0)) * 1000.0                   # N.m -> N.mm
        centre = (lp * lw[:, None]).sum(0) / lw.sum() if load.get("center") is None else np.asarray(load["center"])
        rel = lp - centre
        rel -= np.outer(rel @ axis, axis)                              # radial vector from the axis
        r = np.linalg.norm(rel, axis=1)
        if np.sum(lw * r * r) < 1e-9:
            raise ValueError("the load faces lie on the torque axis - pick faces away from it")
        tang = np.cross(axis, rel)
        mag = T * lw / np.sum(lw * r * r)                               # sum(r x f) = T exactly
        forces = tang * mag[:, None]
        applied = f"{T / 1000:.4g} N·m about {load.get('axis', 'Z')}"
    else:
        raise ValueError(f"unknown load type {kind}")
    p.add_point_forces(lp, forces)

    cid = uuid.uuid4().hex[:10]
    _cases[cid] = {"p": p, "corners": corners, "normals": np.asarray(geom.get("normals") or np.zeros(corners.size), dtype=np.float64).reshape(-1, 3),
                   "tri_face": tri_face, "anchors": np.concatenate([fp, lp]), "material": mat_key}
    while len(_cases) > 4:
        _cases.pop(next(iter(_cases)))
    meta = {"h": h, "shape": list(shape), "solid_voxels": int(p.n_solid), "free_dofs": int((p.fixed == 0).sum()),
            "material": MATERIALS[mat_key][0], "E": E, "nu": nu, "applied": applied,
            "voxel_volume": float(p.n_solid * h ** 3), "cad_volume": volume, "mass_g": volume * rho / 1000.0,
            "build_ms": round(1000 * (time.perf_counter() - t0))}
    return cid, p.to_bytes(), meta


MAX_DISPLAY_TRIANGLES = 100_000


def display_mesh(corners, normals, tri_face, target):
    """Refine the CAD tessellation until no triangle edge is longer than `target`.

    The viewer's CAD mesh is as coarse as the geometry allows (a flat box face is two
    long triangles), so a field sampled only at its vertices loses everything in between.
    Longest-edge bisection splits only where needed, so the triangle count follows the
    surface area instead of exploding on long thin CAD slivers.
    Returns (positions (n, 3), normals (n, 3), tri_face (n / 3,)) as flat triangles.
    """
    P = corners.reshape(-1, 3, 3).copy()
    N = normals.reshape(-1, 3, 3).copy()
    F = np.asarray(tri_face).copy()
    area = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1).sum()
    target = max(target, math.sqrt(8 * area / MAX_DISPLAY_TRIANGLES))   # bisection makes ~2x the ideal count
    for _ in range(64):
        e = np.stack([np.linalg.norm(P[:, 1] - P[:, 0], axis=1), np.linalg.norm(P[:, 2] - P[:, 1], axis=1),
                      np.linalg.norm(P[:, 0] - P[:, 2], axis=1)], 1)
        k = np.argmax(e, axis=1)
        split = e[np.arange(len(P)), k] > target
        if not split.any():
            break
        keepP, keepN, keepF = P[~split], N[~split], F[~split]
        S, SN, SF, sk = P[split], N[split], F[split], k[split]
        r = np.arange(len(S))
        # rotate each triangle so the edge to split is (v0, v1); v2 is opposite
        a_, b_, c_ = S[r, sk], S[r, (sk + 1) % 3], S[r, (sk + 2) % 3]
        na, nb, nc = SN[r, sk], SN[r, (sk + 1) % 3], SN[r, (sk + 2) % 3]
        m, nm = 0.5 * (a_ + b_), 0.5 * (na + nb)
        P = np.concatenate([keepP, np.stack([a_, m, c_], 1), np.stack([m, b_, c_], 1)])
        N = np.concatenate([keepN, np.stack([na, nm, nc], 1), np.stack([nm, nb, nc], 1)])
        F = np.concatenate([keepF, SF, SF])
    pos = P.reshape(-1, 3)
    nrm = N.reshape(-1, 3)
    nrm = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    return pos, nrm, F


def result(cid, u_f32):
    """Von Mises and displacement on a refined copy of the viewer mesh, plus statistics."""
    from scipy.spatial import cKDTree
    case = _cases.get(cid)
    if case is None:
        raise KeyError("analysis expired - run it again")
    p = case["p"]
    u = np.asarray(u_f32, dtype=np.float64)
    if u.size != p.n_dofs:
        raise ValueError(f"expected {p.n_dofs} values, got {u.size}")
    vm = p.von_mises(u)
    solid = np.flatnonzero(p.emod > 0)
    centres = p.voxel_centers()[solid]

    pos, nrm, tri_face = display_mesh(case["corners"], case["normals"], case["tri_face"], 3.0 * p.h)
    _, near_vox = cKDTree(centres).query(pos)
    vox = solid[near_vox]
    vm_pos = vm[vox]

    # displacement: trilinear inside the point's (nearest solid) voxel
    nx, ny, nz = p.shape
    ijk = np.stack([vox % nx, (vox // nx) % ny, vox // (nx * ny)], 1)
    loc = np.clip((pos - p.origin) / p.h - ijk, 0.0, 1.0)
    en = p.element_nodes()[vox]
    disp = np.zeros_like(pos)
    for a in range(8):
        di, dj, dk = a & 1, (a >> 1) & 1, (a >> 2) & 1
        w = ((loc[:, 0] if di else 1 - loc[:, 0]) * (loc[:, 1] if dj else 1 - loc[:, 1])
             * (loc[:, 2] if dk else 1 - loc[:, 2]))
        disp += w[:, None] * u.reshape(-1, 3)[en[:, a]]

    vs = vm[solid]
    # peaks next to supports and load points are singular (they grow without bound with
    # refinement), so report the maximum away from them separately.
    # "near" = within 3 voxels of a support or load sample: bin the samples into the voxel
    # grid and dilate (a KD-tree over the samples took seconds on large faces)
    from scipy.ndimage import binary_dilation
    near = np.zeros((nz, ny, nx), dtype=bool)
    a_ijk = np.floor((case["anchors"] - p.origin) / p.h).astype(int)
    a_ijk = np.clip(a_ijk, 0, [nx - 1, ny - 1, nz - 1])
    near[a_ijk[:, 2], a_ijk[:, 1], a_ijk[:, 0]] = True
    near = binary_dilation(near, structure=np.ones((3, 3, 3), dtype=bool), iterations=3)
    far = ~near.ravel()[solid]
    dmag = np.linalg.norm(u.reshape(-1, 3), axis=1)
    i_far = int(np.argmax(np.where(far, vs, -1))) if far.any() else int(np.argmax(vs))
    stats = {
        "p50": float(np.percentile(vs, 50)), "p99": float(np.percentile(vs, 99)),
        "p999": float(np.percentile(vs, 99.9)), "max": float(vs.max()),
        "max_away": float(vs[far].max()) if far.any() else None,
        "max_away_at": centres[i_far].round(2).tolist(),
        "max_displacement": float(dmag.max()),
        # every voxel has the same volume, so these percentiles give the volume fraction
        # below any stress (the viewer's underused-material view)
        "vm_pct": np.percentile(vs, np.arange(101)).round(4).tolist(),
    }
    return {"stats": stats, "positions": pos, "normals": nrm, "triFace": tri_face,
            "vonMises": vm_pos, "displacement": disp}


def result_blob(res):
    """Binary layout for the browser: u32 vertex count n, then f32 positions (3n),
    f32 normals (3n), f32 von Mises (n), f32 displacement (3n), i32 face id per triangle (n/3)."""
    n = len(res["positions"])
    return b"".join([
        np.array([n], dtype="<u4").tobytes(),
        res["positions"].astype("<f4").tobytes(), res["normals"].astype("<f4").tobytes(),
        res["vonMises"].astype("<f4").tobytes(), res["displacement"].astype("<f4").tobytes(),
        res["triFace"].astype("<i4").tobytes(),
    ])
