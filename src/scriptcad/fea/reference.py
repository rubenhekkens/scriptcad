"""Cached float64 reference solutions, so each backend is judged two ways:

* discretisation error: its quantities against the analytic reference (benchmarks.py)
* solver error: its displacement field against a float64 solve of the *same* voxel
  model, ||u - u64|| / ||u64||. This separates "the voxel model is coarse" from
  "the float32 solver didn't converge", which a float64 residual of a float32
  solution cannot do (rounding u to float32 alone leaves a residual of ~1e-2 here).
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np

CACHE = Path(__file__).resolve().parents[3] / "bench" / "fea" / "ref_cache"


def _key(p) -> str:
    h = hashlib.sha1()
    for a in (p.emod, p.fixed, p.force):
        h.update(np.ascontiguousarray(a).tobytes())
    h.update(repr((p.shape, p.h, p.nu, p.formulation)).encode())
    return h.hexdigest()[:16]


def solve64(p):
    """float64 solution of p, from cache, CUDA (Warp) or PyAMG in that order."""
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{p.name or 'case'}_{_key(p)}.npy"
    if f.exists():
        return np.load(f)
    try:
        from . import cuda
        u, info = cuda.pcg(p, tol=1e-11, dtype="float64", max_iter=200_000)
    except Exception:
        from . import cpu
        u, info = cpu.reference(p, tol=1e-12)
    np.save(f, u)
    return u


def solver_error(p, u) -> float:
    ref = solve64(p)
    return float(np.linalg.norm(u - ref) / np.linalg.norm(ref))
