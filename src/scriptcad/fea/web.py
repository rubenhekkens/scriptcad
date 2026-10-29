"""HTTP endpoints for the browser solver benchmark.

The browser fetches a voxel problem as a binary blob, solves it with WebGPU, and
posts the displacements back. The server scores them in float64 against the same
analytic references the CPU and CUDA backends use, so all three are judged alike.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from .benchmarks import CASES
from .reference import solver_error

router = APIRouter(prefix="/api/fea")
_problems: dict[str, tuple] = {}
RESULTS = Path(__file__).resolve().parents[3] / "bench" / "fea" / "results"


def _jsonable(m):
    return {k: {"fea": v, "reference": r, "unit": unit, "error_pct": None if r is None else 100 * (v - r) / r}
            for k, (v, r, unit) in m.items()}


@router.get("/cases")
def cases():
    return {"cases": list(CASES)}


@router.get("/case")
def case(name: str, h: float, form: str = "hex8i"):
    if name not in CASES:
        raise HTTPException(404, f"unknown case {name}")
    t = time.perf_counter()
    p, measure = CASES[name](h=h, formulation=form)
    cid = uuid.uuid4().hex[:10]
    _problems[cid] = (p, measure, {"name": name, "h": h, "form": form})
    while len(_problems) > 8:
        _problems.pop(next(iter(_problems)))
    return Response(p.to_bytes(), media_type="application/octet-stream",
                    headers={"X-Case-Id": cid, "X-Build-Seconds": f"{time.perf_counter() - t:.3f}",
                             "X-Free-Dofs": str(int((p.fixed == 0).sum()))})


@router.post("/result")
async def result(request: Request, id: str):
    if id not in _problems:
        raise HTTPException(404, "case expired - fetch it again")
    p, measure, info = _problems[id]
    meta = json.loads(request.headers.get("X-Meta", "{}"))
    u = np.frombuffer(await request.body(), dtype="<f4").astype(np.float64)
    if u.size != p.n_dofs:
        raise HTTPException(400, f"expected {p.n_dofs} values, got {u.size}")
    out = {**info, **meta, "backend": "webgpu-float32", "error_vs_float64": solver_error(p, u),
           "free_dofs": int((p.fixed == 0).sum()), "measures": _jsonable(measure(u))}
    RESULTS.mkdir(parents=True, exist_ok=True)
    with open(RESULTS / "webgpu.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(out) + "\n")
    return out


@router.get("/field")
def field(name: str, h: float, form: str = "hex8i"):
    """Outer voxel faces of the solved part, coloured by von Mises (float64 solution).

    Blob: u32 quad count, then f32 positions (quads x 4 x 3), then f32 von Mises per quad,
    then f32 [p50, p99, p99.9, max] of the interior distribution for the legend.
    """
    from .reference import solve64
    if name not in CASES:
        raise HTTPException(404, f"unknown case {name}")
    p, _ = CASES[name](h=h, formulation=form)
    u = solve64(p)
    vm = p.von_mises(u)
    nx, ny, nz = p.shape
    solid = (p.emod > 0).reshape(nz, ny, nx)
    pad = np.pad(solid, 1)
    quads, vals = [], []
    k, j, i = np.nonzero(solid)
    vmg = vm.reshape(nz, ny, nx)
    # (axis offset in k,j,i order, the 4 corner offsets of that face in x,y,z)
    faces = [((0, 0, -1), [(0, 0, 0), (0, 1, 0), (0, 1, 1), (0, 0, 1)]), ((0, 0, 1), [(1, 0, 0), (1, 0, 1), (1, 1, 1), (1, 1, 0)]),
             ((0, -1, 0), [(0, 0, 0), (0, 0, 1), (1, 0, 1), (1, 0, 0)]), ((0, 1, 0), [(0, 1, 0), (1, 1, 0), (1, 1, 1), (0, 1, 1)]),
             ((-1, 0, 0), [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]), ((1, 0, 0), [(0, 0, 1), (0, 1, 1), (1, 1, 1), (1, 0, 1)])]
    for (dk, dj, di), corners in faces:
        exposed = ~pad[k + 1 + dk, j + 1 + dj, i + 1 + di]
        ii, jj, kk = i[exposed], j[exposed], k[exposed]
        base = np.stack([ii, jj, kk], 1).astype(np.float64)
        q = np.stack([base + np.array(c) for c in corners], 1) * p.h + p.origin
        quads.append(q)
        vals.append(vmg[kk, jj, ii])
    quads = np.concatenate(quads).astype("<f4")
    vals = np.concatenate(vals).astype("<f4")
    stats = np.percentile(vm[p.emod > 0], [50, 99, 99.9, 100]).astype("<f4")
    blob = np.array([len(vals)], dtype="<u4").tobytes() + quads.tobytes() + vals.tobytes() + stats.tobytes()
    return Response(blob, media_type="application/octet-stream")
