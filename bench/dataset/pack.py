"""Packs the generated samples (out/samples) into the Hugging Face dataset (out/hf), as an
image folder the Hub's viewer reads directly:

  train/<id>.png          a preview of the carved design (side, front and top views)
  train/metadata.jsonl    one row per sample: the numbers, the settings, the ScriptCAD document
  arrays/<id>.npz         the voxel arrays: design space fill, carved design, supports, loads
  README.md               the dataset card (card.md, with the counts filled in)

    python bench/dataset/pack.py
    python bench/dataset/pack.py --preview 00012     # write one preview to out/preview.png
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
SAMPLES = HERE / "out" / "samples"
HF = HERE / "out" / "hf"


def depth_view(design, axis, flip=False):
    """Orthographic view along an axis of the (z, y, x) grid: nearer solid is lighter."""
    d = np.flip(design, axis) if flip else design
    hit = d.any(axis)
    first = np.argmax(d, axis)
    depth = 1 - first / max(1, d.shape[axis] - 1)
    return np.where(hit, 70 + 185 * depth, 18).astype(np.uint8)


def preview(npz, size=220):
    """Side, front and top views of the carved design; the design space as a faint shadow."""
    design, space = npz["design"], npz["fill"] > 25
    views = []
    # the view along the thinnest side first (where the structure shows), then the other two
    side = sorted((2, 1), key=lambda ax: design.shape[ax])
    for axis, flip, up in ((side[0], False, True), (side[1], False, True), (0, True, False)):
        v = depth_view(design, axis, flip)
        v = np.where((v == 18) & space.any(axis), 36, v)
        if up:
            v = v[::-1]                       # z up
        im = Image.fromarray(v).convert("RGB")
        scale = size / max(im.size)
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.NEAREST)
        canvas = Image.new("RGB", (size, size), (18, 18, 18))
        canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
        views.append(canvas)
    out = Image.new("RGB", (3 * size + 8, size), (8, 8, 8))
    for k, v in enumerate(views):
        out.paste(v, (k * (size + 4), 0))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview")
    a = ap.parse_args()
    if a.preview:
        preview(np.load(SAMPLES / f"{a.preview}.npz")).save(HERE / "out" / "preview.png")
        print("wrote out/preview.png")
        return
    shutil.rmtree(HF / "train", ignore_errors=True)
    shutil.rmtree(HF / "arrays", ignore_errors=True)
    (HF / "train").mkdir(parents=True)
    (HF / "arrays").mkdir(parents=True)
    rows = []
    for js in sorted(SAMPLES.glob("[0-9]*.json")):
        if js.stem.endswith("labels") or int(js.stem) >= 900000:     # labels are merged below; pilot runs left out
            continue
        lab_file = js.with_name(f"{js.stem}.labels.json")
        if not lab_file.exists():                                     # not labelled yet: next version
            continue
        rec = json.loads(js.read_text(encoding="utf-8"))
        lab = json.loads(lab_file.read_text(encoding="utf-8"))
        z = np.load(js.with_suffix(".npz"))
        preview(z).save(HF / "train" / f"{rec['id']}.png", optimize=True)
        shutil.copy(js.with_suffix(".npz"), HF / "arrays" / f"{rec['id']}.npz")
        mf = lab["manufacturing"]
        rows.append({
            "file_name": f"{rec['id']}.png", "id": rec["id"], "status": "ok", "failure": None, "family": rec["family"],
            "spec": lab["spec"],
            # the part, its material and load (labels: a real alloy, a load that leaves the block a realistic margin)
            "material": lab["material"], "process": lab["process"], "E_MPa": lab["E_MPa"], "poisson": lab["poisson"],
            "density_g_cm3": lab["density_g_cm3"], "yield_MPa": lab["yield_MPa"], "load_N": lab["load_N"], "load_basis": lab.get("load_basis"),
            "fixed_points_mm": rec["fixed_points"], "load_points_mm": rec["load_points"],
            "voxel_mm": rec["h_mm"], "grid_xyz": rec["shape"], "origin_mm": rec["origin"],
            # the carve
            "keep_target": rec["keep_target"], "keep_reached": rec["keep_reached"], "keep_floor": rec["keep_floor"],
            "detail": rec["carve"]["detail"], "solves": rec["solves"], "seconds": rec["seconds"], "stop": rec["stop"],
            "stiffness_per_mass_gain": rec["stiffness_per_mass_gain"],
            # the engineering outcome under the labelled load
            "mass_g_before": lab["mass_g_before"], "mass_g_after": lab["mass_g_after"],
            "safety_factor_before": round(lab["sf_block"], 3), "safety_factor_after": lab["carved"]["safety_factor"],
            "member_stress_MPa_before": lab["block"]["member_von_mises_MPa"], "member_stress_MPa_after": lab["carved"]["member_von_mises_MPa"],
            "corner_peak_MPa_after": lab["carved"]["corner_peak_MPa"],
            "max_disp_mm_before": lab["block"]["max_disp_mm"], "max_disp_mm_after": lab["carved"]["max_disp_mm"],
            "deflection_limit_mm": lab["deflection_limit_mm"],
            "passes_strength": lab["passes"]["strength"], "passes_deflection": lab["passes"]["deflection"], "passes": lab["passes"]["all"],
            # manufacturing
            "pieces": mf["pieces"], "largest_piece_share": mf["largest_piece_share"],
            "thinnest_member_mm": mf["thinnest_member_mm_p5"], "member_mm_median": mf["member_mm_median"],
            "print_direction": mf["best_build_direction"], "print_overhang_unsupported": mf["best_overhang_unsupported"],
            "overhang_by_direction": json.dumps(mf["overhang_unsupported"]),
            # verification
            "reproducible": lab["verify"]["reproducible"], "f64_rel_diff": lab["verify"]["rel_diff"],
            "compliance_before": rec["compliance_before"], "compliance_after": rec["compliance_after"],
            "carve_load_N": rec["load_N"], "carve_E_MPa": rec["E_MPa"],
            # the recipe
            "arrays": f"arrays/{rec['id']}.npz", "params": json.dumps(rec["params"]), "history": json.dumps(rec["history"]),
            "scriptcad_doc": json.dumps(rec["doc"]), "python": lab["code"],
        })
    # failed samples: kept, with the reason, as the documents that did not carve (no design)
    import sys
    sys.path.insert(0, str(HERE))
    import generate
    for f in sorted(SAMPLES.glob("[0-9]*.failed")):
        i = int(f.stem)
        if i >= 900000:
            continue
        family = generate.FAMILY_OF(i)
        rng = np.random.default_rng(1000 + i)
        doc, s, params = generate.FAMILIES[family](rng)
        reason = f.read_text(encoding="utf-8").strip().splitlines()[-1]
        Image.new("RGB", (3 * 220 + 8, 220), (40, 8, 8)).save(HF / "train" / f"{f.stem}.png")
        rows.append({"file_name": f"{f.stem}.png", "id": f.stem, "status": "failed", "failure": reason, "family": family,
                     "params": json.dumps(params), "scriptcad_doc": json.dumps(doc)})
    rows.sort(key=lambda r: r["id"])
    with open(HF / "train" / "metadata.jsonl", "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    DESCR = {"random": "a base block with up to three blocks and cylinders on it, on feet or a wall, one or two load pads, load at a random angle",
             "flange": "a plate with 2-6 bolt holes (held in the holes) and a loaded boss",
             "lbracket": "an L held at the back of its upright, loaded at the end of its arm",
             "chair": "the lounge-chair block: side profile, 3 or 4 feet, seat and back loaded, optionally rounded",
             "beam": "a bar on two or three feet, or held at one end, with a load pad on top",
             "bracket": "a block bolted to a wall by two or four pads, with a load pad on top or in front"}
    fam = {f: sum(r["family"] == f for r in rows if r["status"] == "ok") for f in DESCR}
    table = "| Family | Samples | |\n|---|---:|---|\n" + "\n".join(f"| `{f}` | {fam[f]} | {DESCR[f]} |" for f in DESCR if fam[f])
    ok = [r for r in rows if r["status"] == "ok"]
    gains = sorted(r["stiffness_per_mass_gain"] for r in ok)
    passed = sum(r["passes"] for r in ok)
    card = (HERE / "card.md").read_text(encoding="utf-8")
    for k, v in {"n": len(ok), "failed": len(rows) - len(ok), "passed": passed, "pass_share": f"{passed / max(1, len(ok)):.0%}", "family_table": table,
                 "gain_median": f"{gains[len(gains) // 2]:.2f}", "gain_max": f"{gains[-1]:.2f}"}.items():
        card = card.replace("{" + k + "}", str(v))
    (HF / "README.md").write_text(card, encoding="utf-8")
    print(f"{len(ok)} samples (+{len(rows) - len(ok)} failed); {passed} pass; families {fam}; median gain {gains[len(gains) // 2]:.2f}x, max {gains[-1]:.2f}x")


if __name__ == "__main__":
    main()
