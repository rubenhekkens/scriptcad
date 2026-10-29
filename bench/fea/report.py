"""Merge native.jsonl and webgpu.jsonl into one comparison table (results/summary.md)."""

import json
from pathlib import Path

HERE = Path(__file__).parent / "results"
ORDER = ["cpu-pyamg-float64", "cuda-warp-float64", "cuda-warp-float32", "cuda-warp-float32-rel",
         "webgpu-float32-nvidia", "webgpu-float32-intel",
         "cuda-warp-float64-mg", "cuda-warp-float32-mg", "webgpu-float32-mg-nvidia", "webgpu-float32-mg-intel"]
LABEL = {
    "cpu-pyamg-float64": "CPU, float64, AMG-CG (reference)",
    "cuda-warp-float64": "RTX 5070 CUDA, float64, Jacobi-PCG",
    "cuda-warp-float32": "RTX 5070 CUDA, float32, Jacobi-PCG, plain K p",
    "cuda-warp-float32-rel": "RTX 5070 CUDA, float32, Jacobi-PCG, relative K p",
    "webgpu-float32-nvidia": "Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p",
    "webgpu-float32-intel": "Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p",
    "cuda-warp-float64-mg": "RTX 5070 CUDA, float64, **multigrid** MG-PCG",
    "cuda-warp-float32-mg": "RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p",
    "webgpu-float32-mg-nvidia": "Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG",
    "webgpu-float32-mg-intel": "Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG",
}


def load(name):
    f = HERE / name
    return [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()] if f.exists() else []


def main():
    rows = load("native.jsonl") + load("webgpu.jsonl")
    for r in rows:
        if "seconds" not in r and "solve_ms" in r:
            r["seconds"] = r["solve_ms"] / 1000
        if r["backend"] == "webgpu-float32":
            if r.get("method") == "mg":
                r["backend"] += "-mg"
            r["backend"] += "-" + ((r.get("adapter") or {}).get("vendor") or "unknown")
    keys = []
    for r in rows:
        k = (r["name"], r["h"], r["form"])
        if k not in keys:
            keys.append(k)
    out = ["# Voxel FEA: browser vs native", ""]
    for k in keys:
        group = {r["backend"]: r for r in rows if (r["name"], r["h"], r["form"]) == k}
        any_r = next(iter(group.values()))
        out += [f"## {k[0]}, h = {k[1]} mm, {k[2]} ({any_r['free_dofs']:,} free DOF)", ""]
        qnames = list(any_r["measures"])
        out.append("| Backend | Iterations | Solve s | ms/iter | Error vs float64 | " + " | ".join(qnames) + " |")
        out.append("|---|---:|---:|---:|---:|" + "---:|" * len(qnames))
        refs = []
        for q in qnames:
            m = any_r["measures"][q]
            refs.append("" if m["reference"] is None else f"{m['reference']:.4g} {m['unit']}")
        if any(refs):
            out.append("| *Analytic reference* | | | | | " + " | ".join(refs) + " |")
        for b in ORDER:
            r = group.get(b)
            if not r:
                continue
            if r.get("invalid"):
                out.append(f"| {LABEL[b]} | {r['iterations']:,} | — | — | {r['error_vs_float64']:.0e} | "
                           + " | ".join("did not converge" for _ in qnames) + " |")
                continue
            cells = []
            for q in qnames:
                m = r["measures"][q]
                err = "" if m.get("error_pct") is None else f" ({m['error_pct']:+.2f}%)"
                cells.append(f"{m['fea']:.4g}{err}")
            out.append(f"| {LABEL[b]} | {r['iterations']:,} | {r['seconds']:.2f} | {r['ms_per_iteration']:.2f} | "
                       f"{r['error_vs_float64']:.1e} | " + " | ".join(cells) + " |")
        out.append("")
    (HERE / "summary.md").write_text("\n".join(out), encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
