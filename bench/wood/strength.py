"""The chair's strength in ScriptCAD (headless): three load cases on the whole chair, birch plywood.

    python bench/wood/strength.py [project.json] [quality]   # -> strength.json next to the project
"""
import json, sys
from pathlib import Path
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "dataset"))
import label as L
from scriptcad import kernel
from scriptcad.fea import analyze

DESIGN_STRENGTH = 27.0       # birch plywood in bending: 40 MPa characteristic x 0.8 (long-term) / 1.2 (material)


def main(doc_path=str(HERE / "out" / "calatrava_chair.json"), quality="normal"):
    doc_path = Path(doc_path)
    doc = json.load(open(doc_path))
    a = doc["analysis"]; pts = a["bodies"]["frame"]
    seat = [p for p in pts["loads"] if p[2] < 420]
    back = [p for p in pts["loads"] if p[2] >= 420]
    cases = {
        "seated person (seat 1.6 kN + back 0.5 kN)": (pts["loads"], [0, 500, -1600]),
        "hard lean back (0.6 kN, top of the back)": ([q for q in back if q[2] > max(r[2] for r in back) - 160], [0, 550, -250]),
        "sideways push (0.3 kN, seat loaded 1.0 kN)": (seat, [300, 0, -1000]),
    }
    res = {}
    for name, (loads, vec) in cases.items():
        geom = kernel.analysis_geometry(doc, "frame", {"fixed": pts["fixed"], "load": loads}, quality)
        cid, _, meta = analyze.build(geom, {"body": "frame", "material": "birch", "quality": quality, "fixed": pts["fixed"],
                                            "load": {"type": "force", "vector": vec, "faces": loads}})
        p = analyze._cases[cid]["p"]
        u, _ = L.solve64(p)
        member, peak, dmax, _ = L.stress(p, u, cid)
        analyze._cases.pop(cid, None)
        res[name] = {"member_MPa": round(member, 2), "peak_MPa": round(peak, 2), "deflection_mm": round(dmax, 2),
                     "margin": round(DESIGN_STRENGTH / peak, 1), "faces": [len(geom["groups"]["fixed"]), len(geom["groups"]["load"])], "h_mm": meta["h"]}
        print(f"{name:<45} member {member:5.2f} MPa  peak {peak:5.2f} MPa  deflection {dmax:5.2f} mm  margin {DESIGN_STRENGTH / peak:4.1f}x  "
              f"(supports {res[name]['faces'][0]}, loads {res[name]['faces'][1]}, h {meta['h']} mm)", flush=True)
    (doc_path.parent / "strength.json").write_text(json.dumps(res, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main(*sys.argv[1:3])
