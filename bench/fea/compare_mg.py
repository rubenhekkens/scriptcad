"""Multigrid (MG-PCG) rows for the native CUDA backend, appended to native.jsonl.

    uv run --extra step --extra sim python bench/fea/compare_mg.py [case:h:form ...]

Same cases and scoring as compare.py (its DEFAULT plus thin_cantilever at 0.25 mm is
already in it). Each solve runs twice and the faster run is kept, because the laptop
GPU's clocks (and anything else using it) make a single short timing noisy.
Backends: cuda-warp-float32-mg (the browser-equivalent) and cuda-warp-float64-mg.
"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from compare import DEFAULT, OUT, scored  # noqa: E402

from scriptcad.fea import multigrid  # noqa: E402
from scriptcad.fea.benchmarks import CASES  # noqa: E402
from scriptcad.fea.reference import solve64  # noqa: E402


def best_of(n, fn):
    runs = [fn() for _ in range(n)]
    return min(runs, key=lambda r: r[1]["seconds"])


def main(specs):
    for spec in specs:
        name, h, form = spec.split(":")
        h = float(h)
        t = time.perf_counter()
        p, measure = CASES[name](h=h, formulation=form)
        print(f"== {name} h={h} {form}: {int((p.fixed == 0).sum()):,} free DOF (built in {time.perf_counter() - t:.1f} s)")
        solve64(p)
        runs = []
        for dtype, tol in (("float32", 1e-6), ("float64", 1e-10)):
            u, info = best_of(2, lambda: multigrid.pcg(p, tol=tol, dtype=dtype))
            r = scored(p, measure, u, info, name, h, form)
            r.update(levels=info["levels"], stop=info["stop"], settings=info["settings"])
            runs.append(r)
        with open(OUT, "a", encoding="utf-8") as fh:
            for r in runs:
                fh.write(json.dumps(r) + "\n")
                print(f"   {r['backend']:22s} it={r['iterations']:>5} {r['seconds']:7.3f} s {r['ms_per_iteration']:6.2f} ms/it "
                      f"err_vs_f64={r['error_vs_float64']:.1e} levels={len(r['levels'])} ({r['stop']})")


if __name__ == "__main__":
    main(sys.argv[1:] or DEFAULT)
