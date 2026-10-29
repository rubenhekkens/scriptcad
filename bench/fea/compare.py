"""Run the native backends on every benchmark case and append results to native.jsonl.

    uv run --extra step --extra sim python bench/fea/compare.py [case:h:form ...]

The browser (WebGPU) results come from bench.html, which the server scores into
webgpu.jsonl. report.py merges both into RESULTS.md.
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

from scriptcad.fea import cpu, cuda
from scriptcad.fea.benchmarks import CASES
from scriptcad.fea.reference import solve64, solver_error

OUT = Path(__file__).parent / "results" / "native.jsonl"
DEFAULT = ["cantilever:1.0:hex8i", "thin_cantilever:1.0:hex8", "thin_cantilever:1.0:hex8i",
           "thin_cantilever:0.5:hex8", "thin_cantilever:0.5:hex8i", "thin_cantilever:0.25:hex8i",
           "tube_torsion:0.5:hex8i", "lame_ring:0.5:hex8i"]


def scored(p, measure, u, info, name, h, form):
    m = measure(u)
    return {"name": name, "h": h, "form": form, "backend": info["backend"], "free_dofs": int((p.fixed == 0).sum()),
            "iterations": info["iterations"], "seconds": info["seconds"],
            "ms_per_iteration": 1000 * info["seconds"] / max(info["iterations"], 1),
            "setup_seconds": info.get("setup_seconds", info.get("upload_seconds", 0.0)),
            "error_vs_float64": solver_error(p, u),
            "measures": {k: {"fea": v, "reference": r, "unit": unit,
                             "error_pct": None if r is None else 100 * (v - r) / r} for k, (v, r, unit) in m.items()}}


def main(specs):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    for spec in specs:
        name, h, form = spec.split(":")
        h = float(h)
        t = time.perf_counter()
        p, measure = CASES[name](h=h, formulation=form)
        print(f"== {name} h={h} {form}: {int((p.fixed == 0).sum()):,} free DOF (built in {time.perf_counter() - t:.1f} s)")
        solve64(p)                                   # cache the reference first
        runs = []
        u, info = cuda.pcg(p, tol=1e-6, dtype="float32", max_iter=60_000)
        runs.append(scored(p, measure, u, info, name, h, form))
        u, info = cuda.pcg(p, tol=1e-6, dtype="float32", max_iter=60_000, rel=True)
        runs.append(scored(p, measure, u, info, name, h, form))
        u, info = cuda.pcg(p, tol=1e-10, dtype="float64", max_iter=200_000)
        runs.append(scored(p, measure, u, info, name, h, form))
        if p.n_dofs < 2_500_000:
            u, info = cpu.reference(p, tol=1e-10)
            runs.append(scored(p, measure, u, info, name, h, form))
        with open(OUT, "a", encoding="utf-8") as fh:
            for r in runs:
                fh.write(json.dumps(r) + "\n")
                parts = []
                for k, v in r["measures"].items():
                    err = "" if v["error_pct"] is None else f" ({v['error_pct']:+.2f}%)"
                    parts.append(f"{k} {v['fea']:.4g}{err}")
                q = "; ".join(parts)
                print(f"   {r['backend']:20s} it={r['iterations']:>6} {r['seconds']:8.2f} s "
                      f"{r['ms_per_iteration']:7.2f} ms/it  err_vs_f64={r['error_vs_float64']:.1e} | {q}")


if __name__ == "__main__":
    main(sys.argv[1:] or DEFAULT)
