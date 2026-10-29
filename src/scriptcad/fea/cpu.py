"""CPU solvers: matrix-free Jacobi-PCG (same algorithm as the GPU backends) and an
assembled float64 reference solved with algebraic multigrid (PyAMG).
"""

from __future__ import annotations

import time

import numpy as np


def _cache(p):
    c = getattr(p, "_cpu_cache", None)
    if c is None:
        solid = np.flatnonzero(p.emod > 0)
        c = p._cpu_cache = {
            "solid": solid,
            "edofs": p.element_dofs()[solid],
            "scale": p.emod[solid],
        }
    return c


def apply_k(p, u, dtype=np.float64):
    """K u, matrix-free: gather element DOFs, multiply by the shared KE, scatter back."""
    c = _cache(p)
    ke = p.ke().astype(dtype)
    ue = u.astype(dtype, copy=False)[c["edofs"]]
    fe = (ue @ ke.T) * c["scale"].astype(dtype)[:, None]
    return np.bincount(c["edofs"].ravel(), weights=fe.ravel(), minlength=p.n_dofs).astype(dtype)


def diagonal(p):
    c = _cache(p)
    kd = np.diag(p.ke())
    return np.bincount(c["edofs"].ravel(), weights=(c["scale"][:, None] * kd[None, :]).ravel(),
                       minlength=p.n_dofs)


def pcg(p, tol=1e-8, max_iter=20000, dtype=np.float64, callback=None):
    """Jacobi-preconditioned CG on the free DOFs, matrix-free. Returns (u, info)."""
    t0 = time.perf_counter()
    free = (p.fixed == 0)
    dinv = np.zeros(p.n_dofs, dtype=dtype)
    d = diagonal(p)
    dinv[free] = 1.0 / d[free]
    f = np.where(free, p.force, 0).astype(dtype)
    u = np.zeros(p.n_dofs, dtype=dtype)
    r = f.copy()
    z = dinv * r
    q = z.copy()
    rz = r @ z
    fn = np.linalg.norm(f)
    it = 0
    hist = []
    while it < max_iter:
        aq = apply_k(p, q, dtype)
        aq[~free] = 0
        alpha = rz / (q @ aq)
        u += alpha * q
        r -= alpha * aq
        it += 1
        rel = np.linalg.norm(r) / fn
        hist.append(float(rel))
        if callback:
            callback(it, rel)
        if rel < tol:
            break
        z = dinv * r
        rz_new = r @ z
        q = z + (rz_new / rz) * q
        rz = rz_new
    return u.astype(np.float64), {"iterations": it, "rel_residual": hist[-1] if hist else 0.0,
                                  "seconds": time.perf_counter() - t0, "history": hist,
                                  "backend": f"cpu-numpy-{np.dtype(dtype).name}"}


def assemble(p):
    """Sparse K over the free DOFs (CSR, float64) plus the free-DOF index."""
    import scipy.sparse as sp
    c = _cache(p)
    ke = p.ke()
    ed = c["edofs"]
    rows = np.repeat(ed, 24, axis=1).ravel()
    cols = np.tile(ed, (1, 24)).ravel()
    vals = (c["scale"][:, None, None] * ke[None]).ravel()
    k = sp.coo_matrix((vals, (rows, cols)), shape=(p.n_dofs, p.n_dofs)).tocsr()
    free = np.flatnonzero(p.fixed == 0)
    return k[free][:, free], free


def reference(p, tol=1e-12):
    """float64 reference: assembled K, smoothed-aggregation AMG preconditioned CG."""
    import pyamg
    t0 = time.perf_counter()
    k, free = assemble(p)
    xyz = p.node_xyz()[free // 3]
    comp = free % 3
    # rigid-body near-null space (3 translations, 3 rotations) helps AMG on elasticity
    b = np.zeros((len(free), 6))
    for c in range(3):
        b[comp == c, c] = 1
    for m, (i, j) in enumerate(((0, 1), (1, 2), (0, 2))):
        b[comp == i, 3 + m] = -xyz[comp == i, j]
        b[comp == j, 3 + m] = xyz[comp == j, i]
    ml = pyamg.smoothed_aggregation_solver(k, B=b, symmetry="symmetric", max_coarse=500)
    t1 = time.perf_counter()
    res = []
    x = ml.solve(p.force[free], tol=tol, accel="cg", maxiter=500, residuals=res)
    u = np.zeros(p.n_dofs)
    u[free] = x
    return u, {"iterations": len(res) - 1, "rel_residual": res[-1] / res[0], "seconds": time.perf_counter() - t0,
               "setup_seconds": t1 - t0, "backend": "cpu-pyamg-float64"}
