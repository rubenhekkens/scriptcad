"""How good is Carve (web/fea/topo.js, hard-kill BESO)? Benchmark and resolution study.

Problem: the MBB beam, the standard topology-optimisation test case, in full (no symmetry
plane): 60 x 10 mm, 1 mm thick, pinned on a 1 mm patch at the bottom left, on a roller on a
1 mm patch at the bottom right, 1 N spread over 2 mm at the middle of the top. 50% of the
material. Loads and supports act on patches of fixed physical size, so compliance converges
as the grid is refined (a point load would make it diverge).

For each voxel size (1, 0.5, 0.25 mm; smoothing radius fixed at 1.5 mm):
  * BESO: the app's own optimiser, run in Node; every solve is done here in float64 (PyAMG).
  * SIMP: the reference method (penalised densities, density filter, optimality criteria;
    the algorithm of the 88-line code by Andreassen et al. 2011), on the same voxels, element
    and passive (always solid) region, then thresholded to the same 50% of solid voxels.
Both final designs are scored by the same float64 solve: compliance f.u (lower = stiffer).

usage: python bench/topo/benchmark.py [--sizes 1,0.5,0.25] [--simp-iters 200]
       python bench/topo/benchmark.py --draw     (redraw layouts.png from the saved designs)
writes bench/topo/results/{results.json, designs_<h>.npz, layouts.png}
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from importlib.resources import files
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from scriptcad.fea import cpu
from scriptcad.fea.grid import Problem

HERE = Path(__file__).parent
L, H, T = 60.0, 10.0, 1.0          # mm
E0, NU, VOLFRAC, RMIN_MM = 1.0, 0.3, 0.5, 1.5


def mbb(h):
    nx, ny, nz = round(L / h), max(1, round(T / h)), round(H / h)
    p = Problem((nx, ny, nz), h, np.zeros(3), np.full(nx * ny * nz, E0), NU)
    xyz = p.node_xyz()
    bottom, top = xyz[:, 2] <= 1e-9, xyz[:, 2] >= H - 1e-9
    pin = bottom & (xyz[:, 0] <= 1.0 + 1e-9)
    roller = bottom & (xyz[:, 0] >= L - 1.0 - 1e-9)
    for c in (0, 1, 2):
        p.fixed[3 * np.flatnonzero(pin) + c] = 1
    p.fixed[3 * np.flatnonzero(roller) + 1] = 1
    p.fixed[3 * np.flatnonzero(roller) + 2] = 1
    load = np.flatnonzero(top & (np.abs(xyz[:, 0] - L / 2) <= 1.0 + 1e-9))
    # consistent nodal loads for a uniform pressure: interior nodes get a full share, edges half
    w = np.ones(len(load))
    for a, (lo, hi) in ((0, (L / 2 - 1, L / 2 + 1)), (1, (0, T))):
        w[np.isclose(xyz[load, a], lo) | np.isclose(xyz[load, a], hi)] *= 0.5
    p.force[3 * load + 2] = -w / w.sum()
    return p


def set_design(p, emod, base_fixed):
    """Solid/void (or graded) design: nodes no solid voxel touches are held, as the app does."""
    p.emod = np.asarray(emod, dtype=np.float64)
    p.fixed = base_fixed.copy()
    p.fixed[np.repeat(~p.active_nodes(), 3)] = 1
    p._cpu_cache = None


def compliance(p):
    u, _ = cpu.reference(p, tol=1e-10)
    return float(p.force @ u), u


def passive(p):
    """Voxels the app always keeps: touching a held or loaded node, plus one layer (topo.js prepare)."""
    held = (p.fixed.reshape(-1, 3).any(1)) & p.active_nodes()
    loaded = p.force.reshape(-1, 3).any(1)
    en = p.element_nodes()
    keep = (held[en] | loaded[en]).any(1)
    nx, ny, nz = p.shape
    keep = ndimage.binary_dilation(keep.reshape(nz, ny, nx), structure=ndimage.generate_binary_structure(3, 1))
    return keep.ravel()


def connected_to_supports(p, solid, base_fixed):
    """Drop solid pieces (face connectivity) that touch no held node, as topo.js removeIslands."""
    nx, ny, nz = p.shape
    lab, n = ndimage.label(solid.reshape(nz, ny, nx), structure=ndimage.generate_binary_structure(3, 1))
    lab = lab.ravel()
    held = base_fixed.reshape(-1, 3).any(1)
    anchored = np.unique(lab[(held[p.element_nodes()]).any(1) & (lab > 0)])
    return np.isin(lab, anchored) & solid


def run_beso(p, rmin_vox):
    blob = HERE / "results" / f"mbb_{p.shape[0]}.vxf"
    blob.write_bytes(p.to_bytes())
    web = Path(str(files("scriptcad") / "web")).resolve().as_uri() + "/"
    opts = json.dumps({"target": VOLFRAC, "rmin": rmin_vox, "maxIter": 120})
    node = subprocess.Popen(["node", str(HERE / "run_beso.mjs"), str(blob), web, opts],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    base = p.fixed.copy()
    nv, nn = p.emod.size, p.n_nodes
    q = Problem(p.shape, p.h, p.origin, p.emod.copy(), p.nu, fixed=base.copy(), force=p.force.copy())
    solves = 0
    while True:
        tag = node.stdout.read(1)
        if tag == b"S":
            emod = np.frombuffer(node.stdout.read(4 * nv), "<f4").astype(np.float64)
            fixed = np.frombuffer(node.stdout.read(12 * nn), "<u4").astype(np.uint8)
            q.emod, q.fixed, q._cpu_cache = emod, fixed, None
            u, _ = cpu.reference(q, tol=1e-10)
            node.stdin.write(u.astype("<f4").tobytes())
            node.stdin.flush()
            solves += 1
        elif tag == b"D":
            n = int.from_bytes(node.stdout.read(4), "little")
            info = json.loads(node.stdout.read(n))
            emod = np.frombuffer(node.stdout.read(4 * nv), "<f4").astype(np.float64)
            node.wait()
            return emod > 0, {**info, "solves": solves}
        else:
            raise RuntimeError(f"node ended unexpectedly ({node.wait()})")


def run_simp(p, rmin_vox, keep, iters, penal=3.0, emin=1e-9, move=0.2):
    base = p.fixed.copy()
    nv = p.emod.size
    centres = p.voxel_centers() / p.h
    tree = cKDTree(centres)
    pairs = tree.query_pairs(rmin_vox, output_type="ndarray")
    rows = np.concatenate([pairs[:, 0], pairs[:, 1], np.arange(nv)])
    cols = np.concatenate([pairs[:, 1], pairs[:, 0], np.arange(nv)])
    d = np.linalg.norm(centres[rows] - centres[cols], axis=1)
    import scipy.sparse as sp
    Hf = sp.csr_matrix((rmin_vox - d, (rows, cols)), shape=(nv, nv))
    Hs = np.asarray(Hf.sum(1)).ravel()
    ke = p.ke()
    edofs = p.element_dofs()
    x = np.full(nv, VOLFRAC)
    x[keep] = 1.0
    hist = []
    for it in range(iters):
        xp = np.asarray(Hf @ x).ravel() / Hs
        xp[keep] = 1.0
        set_design(p, emin + xp ** penal * (E0 - emin), base)
        c, u = compliance(p)
        ue = u[edofs]
        ce = np.einsum("ij,jk,ik->i", ue, ke, ue)
        dc = -penal * xp ** (penal - 1) * (E0 - emin) * ce
        dc = np.asarray(Hf @ (dc / Hs)).ravel()
        dv = np.asarray(Hf @ (np.ones(nv) / Hs)).ravel()
        lo, hi = 0.0, 1e9
        free = ~keep
        while (hi - lo) / (hi + lo) > 1e-4:          # optimality criteria, bisection on the volume
            lm = 0.5 * (lo + hi)
            xn = np.clip(x * np.sqrt(np.maximum(-dc, 0) / dv / lm), np.maximum(0, x - move), np.minimum(1, x + move))
            xn[keep] = 1.0
            xpn = np.asarray(Hf @ xn).ravel() / Hs
            xpn[keep] = 1.0
            lo, hi = (lm, hi) if xpn.mean() > VOLFRAC else (lo, lm)
        change = np.abs(xn[free] - x[free]).max()
        x = xn
        hist.append(c)
        if change < 0.01:
            break
    xp = np.asarray(Hf @ x).ravel() / Hs
    xp[keep] = 1.0
    grey = float(np.mean(4 * xp * (1 - xp)))           # 0: crisp solid/void, 1: all half-dense
    n_solid = int(round(VOLFRAC * nv))
    solid = np.zeros(nv, bool)
    solid[np.argsort(-xp)[:n_solid]] = True
    return solid, {"iterations": it + 1, "grey": grey, "compliance_grey": hist[-1]}


def draw():
    """layouts.png: one row per voxel size, BESO left, SIMP right; side view, solid share through
    the thickness (darker = solid), all rows drawn at the same width."""
    from PIL import Image, ImageDraw
    rows = json.loads((HERE / "results" / "results.json").read_text())
    W, gap, pad = 900, 24, 30
    tiles = []
    for r in rows:
        d = np.load(HERE / "results" / f"designs_{r['h_mm']:g}.npz")
        nx, ny, nz = d["shape"]
        pair = []
        for key in ("beso", "simp"):
            img = d[key].reshape(nz, ny, nx).mean(1)[::-1]
            pair.append(Image.fromarray((255 - img * 215).astype(np.uint8)).resize((W, round(W * nz / nx)), Image.NEAREST))
        tiles.append((r, pair))
    H = sum(p[0].height + pad + gap for _, p in tiles)
    canvas = Image.new("L", (2 * W + gap, H + pad), 255)
    ink = ImageDraw.Draw(canvas)
    ink.text((0, 4), "BESO (Carve)", fill=0)
    ink.text((W + gap, 4), "SIMP reference", fill=0)
    y = pad
    for r, (a, b) in tiles:
        ink.text((0, y), f"voxel {r['h_mm']:g} mm: compliance {r['beso']['compliance']:.1f}", fill=0)
        ink.text((W + gap, y), f"compliance {r['simp']['compliance']:.1f}", fill=0)
        canvas.paste(a, (0, y + 14))
        canvas.paste(b, (W + gap, y + 14))
        y += a.height + pad + gap
    canvas.save(HERE / "results" / "layouts.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", default="1,0.5,0.25")
    ap.add_argument("--simp-iters", type=int, default=200)
    ap.add_argument("--draw", action="store_true")
    args = ap.parse_args()
    if args.draw:
        return draw()
    (HERE / "results").mkdir(exist_ok=True)
    rows = []
    for h in [float(s) for s in args.sizes.split(",")]:
        p = mbb(h)
        base = p.fixed.copy()
        rmin = RMIN_MM / h
        keep = passive(p)
        c_full, _ = compliance(p)
        t0 = time.perf_counter()
        beso, info_b = run_beso(p, rmin)
        tb = time.perf_counter() - t0
        set_design(p, np.where(beso, E0, 0.0), base)
        c_beso, _ = compliance(p)
        t0 = time.perf_counter()
        set_design(p, np.full(p.emod.size, E0), base)
        simp, info_s = run_simp(p, rmin, keep, args.simp_iters)
        ts = time.perf_counter() - t0
        simp = connected_to_supports(p, simp, base)
        set_design(p, np.where(simp, E0, 0.0), base)
        c_simp, _ = compliance(p)
        row = {"h_mm": h, "voxels": int(p.emod.size), "rmin_voxels": rmin, "passive_share": float(keep.mean()),
               "compliance_full": c_full,
               "beso": {"compliance": c_beso, "volume": float(beso.mean()), "solves": info_b["solves"],
                        "stop": info_b["stop"], "seconds": round(tb, 1)},
               "simp": {"compliance": c_simp, "volume": float(simp.mean()), "iterations": info_s["iterations"],
                        "grey": info_s["grey"], "compliance_grey": info_s["compliance_grey"], "seconds": round(ts, 1)},
               "beso_over_simp": c_beso / c_simp,
               "layouts_differ": float(np.mean(beso != simp))}
        rows.append(row)
        print(json.dumps(row), flush=True)
        np.savez_compressed(HERE / "results" / f"designs_{h:g}.npz", shape=np.array(p.shape), beso=beso, simp=simp)
    (HERE / "results" / "results.json").write_text(json.dumps(rows, indent=2))
    draw()


if __name__ == "__main__":
    sys.exit(main())
