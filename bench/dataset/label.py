"""Engineering labels for the generated samples (out/samples/<id>.json -> <id>.labels.json):

  verification   the part rebuilt from its own ScriptCAD document, its carved design re-solved
                 independently in float64 (CUDA multigrid, tight tolerance) and compared with the
                 optimiser's float32 compliance
  material       a real alloy and process (with the Poisson's ratio the part was carved with, so
                 the carved shape is the right one for it: in linear elasticity the layout does not
                 depend on E or on the size of the load, only on the load's direction and on nu)
  load           scaled so the uncarved block has a realistic safety factor (drawn from 3 to 15,
                 log-uniform): the designer gave the design space margin, Carve spends it
  outcome        the carved part under that load: peak von Mises away from the supports and load
                 faces (where a voxel model's stresses are singular), safety factor against yield,
                 largest deflection; pass/fail against safety factor 1.5 and deflection span/500
  manufacturing  pieces, thinnest member, and for 3D printing the unsupported overhang (45 degree
                 rule) for each of the six build directions
  recipe         the ScriptCAD document as Python (the kernel's own code) and as a plain-language spec

    python bench/dataset/label.py                 # every sample without labels
    python bench/dataset/label.py --ids 00000,00001
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import traceback
from pathlib import Path

import numpy as np
from scipy import ndimage

HERE = Path(__file__).parent
SAMPLES = HERE / "out" / "samples"

# name: (E MPa, nu, density g/cm3, yield MPa, process)
MATERIALS = {
    "steel S355": (210_000.0, 0.30, 7.85, 355.0, "machined or welded"),
    "stainless 316L": (193_000.0, 0.30, 8.00, 450.0, "3D printed (metal powder bed)"),
    "aluminium 6061-T6": (69_000.0, 0.33, 2.70, 276.0, "machined or cast"),
    "aluminium AlSi10Mg": (70_000.0, 0.33, 2.67, 230.0, "3D printed (metal powder bed)"),
    "titanium Ti-6Al-4V": (114_000.0, 0.34, 4.43, 880.0, "3D printed (metal powder bed)"),
}
BY_NU = {"steel": ["steel S355", "stainless 316L"],                                  # carved with nu 0.30
         "aluminium": ["aluminium 6061-T6", "aluminium AlSi10Mg", "titanium Ti-6Al-4V"]}   # nu 0.33
SF_REQUIRED, DEFL_RATIO = 1.5, 500
CHAIR_LOAD_N = 2100.0


def solve64(p):
    from scriptcad.fea import multigrid
    u, info = multigrid.pcg(p, tol=1e-9, dtype="float64", max_iter=5000)
    return u, info


def stress(case_p, u, setup_cid):
    """Member stress: the 99th percentile of von Mises away from supports and loads (MPa per the
    case's E; the single peak sits at the voxel-sharp corners of the pads, where a real part has
    fillets), the corner peak, the largest displacement and the compliance."""
    from scriptcad.fea import analyze
    case = analyze._cases[setup_cid]
    case["p"] = case_p
    case.pop("geo", None)
    st = analyze.result(setup_cid, u.astype(np.float32), field=False)["stats"]
    geo = case["geo"]
    sig = (u[geo["edofs"]] @ geo["b0"].T) @ geo["d"].T * case["E"]
    vm = analyze.von_mises(sig)
    member = float(np.percentile(vm[geo["far"]], 99)) if geo["far"].any() else st["p99"]
    return member, st["max_away"] if st["max_away"] is not None else st["p999"], st["max_displacement"], st["compliance"]


def overhangs(design):
    """Unsupported share of the downward-facing surface for each build direction (45 degree rule:
    a voxel is supported if the voxel below it, or one of the four diagonally below it, is solid)."""
    out = {}
    d = design
    for name, axis, sign in (("+z", 0, 1), ("-z", 0, -1), ("+y", 1, 1), ("-y", 1, -1), ("+x", 2, 1), ("-x", 2, -1)):
        g = np.moveaxis(d, axis, 0)
        if sign < 0:
            g = g[::-1]
        below = np.zeros_like(g)
        below[1:] = g[:-1]
        support = below.copy()
        for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            support[1:] |= np.roll(np.roll(g[:-1], a, axis=1), b, axis=2)
        facing_down = g & ~below
        facing_down[0] = False                      # the first layer stands on the build plate
        unsupported = facing_down & ~support
        out[name] = round(float(unsupported.sum() / max(1, facing_down.sum())), 4)
    return out


def thinnest(design, h):
    """Member thickness along the medial voxels (local maxima of the distance to the surface), mm."""
    edt = ndimage.distance_transform_edt(design)
    medial = design & (edt >= ndimage.maximum_filter(edt, size=3)) & (edt > 0)
    t = 2 * edt[medial] * h
    return (round(float(np.percentile(t, 5)), 2), round(float(np.median(t)), 2)) if t.size else (0.0, 0.0)


def spec(rec, mat, F, lab):
    fam = {"chair": "lounge chair", "beam": "beam", "bracket": "wall bracket", "random": "part", "flange": "flange",
           "lbracket": "L-bracket"}[rec["family"]]
    sx, sy, sz = (np.array(rec["shape"]) * rec["h_mm"]).round().astype(int)
    supports = len(rec["fixed_points"])
    fdir = np.array(F) / np.linalg.norm(F)
    angle = math.degrees(math.acos(min(1.0, max(-1.0, -fdir[2]))))
    return (f"A {mat} {fam} ({MATERIALS[mat][4]}), within a {sx} x {sy} x {sz} mm design space, held at {supports} "
            f"support face{'s' if supports > 1 else ''}, carrying {np.linalg.norm(F) / 1000:.2f} kN "
            f"{'straight down' if angle < 5 else f'at {angle:.0f} degrees from vertical'} on "
            f"{len(rec['load_points'])} load face{'s' if len(rec['load_points']) > 1 else ''}. Keep "
            f"{rec['keep_target'] * 100:.0f}% of the material, smallest member {rec['carve']['detail']}; it should hold "
            f"with a safety factor of at least {SF_REQUIRED} and deflect at most 1/{DEFL_RATIO} of its span.")


def label(i_str):
    from scriptcad import kernel
    from scriptcad.fea import analyze
    from scriptcad.fea.grid import Problem
    rec = json.loads((SAMPLES / f"{i_str}.json").read_text(encoding="utf-8"))
    z = np.load(SAMPLES / f"{i_str}.npz")
    rng = np.random.default_rng(5000 + int(i_str))
    t0 = time.perf_counter()
    doc, s = rec["doc"], rec["doc"]["analysis"]
    pts = s["bodies"]["env"]
    geom = kernel.analysis_geometry(doc, "env", {"fixed": pts["fixed"], "load": pts["loads"]}, rec["quality"])
    setup = {"body": "env", "material": rec["material"], "quality": rec["quality"], "fixed": pts["fixed"],
             "load": {"type": "force", "vector": s["load"]["vector"], "faces": pts["loads"]}}
    cid, _blob, _meta = analyze.build(geom, setup)
    p0 = analyze._cases[cid]["p"]
    design = z["design"].ravel()                       # [z, y, x] flattened = the voxel index order
    reproducible = list(p0.shape) == rec["shape"] and abs(p0.h - rec["h_mm"]) < 1e-9
    # the uncarved block and the carved design, at the original load, float64
    block = Problem(p0.shape, p0.h, p0.origin, p0.emod.copy(), p0.nu, fixed=p0.fixed.copy(), force=p0.force.copy())
    carved = Problem(p0.shape, p0.h, p0.origin, np.where(design, p0.emod, 0.0), p0.nu, fixed=p0.fixed.copy(), force=p0.force.copy())
    ub, _ = solve64(block)
    uc, info = solve64(carved)
    s_block, pk_block, d_block, c_block = stress(block, ub, cid)
    s_carv, pk_carv, d_carv, c_carv = stress(carved, uc, cid)
    analyze._cases.pop(cid, None)
    # a real material for the carved part, and a load that leaves the block a realistic margin
    E0 = rec["E_MPa"]
    mat = str(rng.choice(BY_NU[rec["material"]]))
    E, nu, rho, sy, process = MATERIALS[mat]
    if rec["family"] == "chair":
        # a chair's load is known: a seated person, about 1.6 kN on the seat and 0.5 kN on the back in
        # furniture strength tests; the total, in the direction the chair was carved for
        scale = CHAIR_LOAD_N / float(np.linalg.norm(rec["load_N"]))
        basis = "seated person, 2.1 kN total (furniture static seat and back loads)"
        sf_block = sy / (s_block * scale)
    else:
        # a generic part's load is not known: one that leaves the design space a realistic margin
        sf_block = float(math.exp(rng.uniform(math.log(3), math.log(15))))
        scale = (sy / sf_block) / s_block              # stresses scale with the load, not with E
        basis = "scaled so the design space has a safety factor of 3 to 15"
    F = (np.array(rec["load_N"]) * scale).round(1).tolist()
    span = float(max(np.array(rec["shape"]) * rec["h_mm"]))
    vm = s_carv * scale
    defl = d_carv * scale * E0 / E
    lab = {
        "id": i_str, "seconds": 0.0,
        "verify": {"reproducible": reproducible, "compliance_f32": rec["compliance_after"], "compliance_f64": c_carv,
                   "rel_diff": float(f"{abs(c_carv - rec['compliance_after']) / c_carv:.3g}"),
                   "f64_iterations": int(info.get("iterations", 0)) if isinstance(info, dict) else None},
        "material": mat, "process": process, "E_MPa": E, "poisson": nu, "density_g_cm3": rho, "yield_MPa": sy,
        "load_N": F, "load_basis": basis, "sf_block": round(sf_block, 3),
        "block": {"member_von_mises_MPa": round(s_block * scale, 2), "corner_peak_MPa": round(pk_block * scale, 2),
                  "max_disp_mm": round(d_block * scale * E0 / E, 5)},
        "carved": {"member_von_mises_MPa": round(vm, 2), "corner_peak_MPa": round(pk_carv * scale, 2),
                   "safety_factor": round(sy / vm, 3), "max_disp_mm": round(defl, 5)},
        "mass_g_before": round(rec["mass_g_before"] * rho / rec["density_g_cm3"], 2),
        "mass_g_after": round(rec["mass_g_after"] * rho / rec["density_g_cm3"], 2),
        "span_mm": round(span, 1), "deflection_limit_mm": round(span / DEFL_RATIO, 4),
    }
    lab["passes"] = {"strength": lab["carved"]["safety_factor"] >= SF_REQUIRED, "deflection": defl <= span / DEFL_RATIO}
    lab["passes"]["all"] = all(lab["passes"].values())
    d3 = z["design"]
    lbl, pieces = ndimage.label(d3)
    sizes = np.bincount(lbl.ravel())[1:]
    largest = round(float(sizes.max() / sizes.sum()), 5) if pieces else 0.0
    t5, t50 = thinnest(d3, rec["h_mm"])
    oh = overhangs(d3)
    best = min(oh, key=oh.get)
    lab["manufacturing"] = {"pieces": int(pieces), "largest_piece_share": largest, "thinnest_member_mm_p5": t5, "member_mm_median": t50,
                            "overhang_unsupported": oh, "best_build_direction": best, "best_overhang_unsupported": oh[best]}
    lab["code"] = kernel.history_to_script(doc)
    lab["spec"] = spec(rec, mat, F, lab)
    lab["seconds"] = round(time.perf_counter() - t0, 1)
    (SAMPLES / f"{i_str}.labels.json").write_text(json.dumps(lab), encoding="utf-8")
    return lab


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids")
    a = ap.parse_args()
    ids = a.ids.split(",") if a.ids else [p.stem for p in sorted(SAMPLES.glob("[0-9]*.json")) if not p.stem.endswith("labels")
                                         and not (SAMPLES / f"{p.stem}.labels.json").exists() and int(p.stem) < 900000]
    for i in ids:
        try:
            lab = label(i)
            print(f"{i} {lab['material']:<20} SF block {lab['sf_block']:.1f} -> carved {lab['carved']['safety_factor']:.2f}  "
                  f"defl {lab['carved']['max_disp_mm']:.3f}/{lab['deflection_limit_mm']:.3f} mm  pass {lab['passes']['all']}  "
                  f"f64 diff {lab['verify']['rel_diff']:.1e}  pieces {lab['manufacturing']['pieces']}  "
                  f"best print dir {lab['manufacturing']['best_build_direction']} ({lab['manufacturing']['best_overhang_unsupported']:.0%})  "
                  f"{lab['seconds']:.0f} s", flush=True)
        except Exception:
            print(f"{i} LABEL FAILED\n{traceback.format_exc()}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
