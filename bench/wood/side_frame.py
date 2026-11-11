"""The side frame of a wooden chair, shaped by Carve: a 36 mm plywood plate in the chair's side
profile, carved under the load of a sitting person, then turned into a flat profile a CNC router
can cut (the carve is projected through the plate's thickness, smoothed, and given webs and
openings that suit plywood).

    python bench/wood/side_frame.py            # carve, then trace -> out/frame_carved.npz, out/frame_profile.json
    python bench/wood/side_frame.py --trace    # trace again from the saved carve

Coordinates: y from front to back, z up (mm); the plate is extruded along x.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

HERE = Path(__file__).parent
OUT = HERE / "out"
sys.path.insert(0, str(HERE.parent / "dataset"))

T = 36.0                                   # two sheets of 18 mm birch plywood, glued
# the side profile (y, z): seat front 400 mm high, seat sloping back to 370, back reclined ~20 degrees
PROFILE = [(20, 0), (20, 385), (60, 405), (470, 372), (505, 395), (640, 830), (695, 830), (695, 0)]
SEAT = ((60, 405), (470, 372))             # the edges the slats rest on
BACK = ((505, 395), (640, 830))
FEET = [(20, 110), (600, 695)]             # y ranges of the front and rear foot
PAD = 8.0                                  # feet pads under the plate (supports, for the carve only)
# per side frame: half of 1.6 kN on the seat and 0.5 kN on the back (pushing back, along its normal)
LOAD = [0.0, 230.0, -870.0]


def mid(a, b):
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]


def carve_doc():
    pts = "; ".join(f"{y}, {z}" for y, z in PROFILE)
    feats = [{"id": "env", "type": "extrude", "name": "Side frame (design space)", "params": {"plane": "YZ", "profile": "polyline", "points": pts, "dist": T, "offset": 0, "cx": 0, "cy": 0}}]
    fixed = []
    for k, (y0, y1) in enumerate(FEET):
        feats.append({"id": f"f{k}", "type": "box", "name": f"Foot {k + 1}", "params": {"x": 0, "y": y0, "z": -PAD, "l": T, "w": y1 - y0, "h": PAD}})
        feats.append({"id": f"u{k}", "type": "boolean", "name": f"Add foot {k + 1}", "params": {"op": "union", "target": "env", "tool": f"f{k}", "keep_tool": False}})
        fixed.append([T / 2, (y0 + y1) / 2, -PAD])
    seat, back = mid(*SEAT), mid(*BACK)
    loads = [[T / 2, seat[0], seat[1]], [T / 2, back[0], back[1]]]
    return {"name": "Wooden chair: side frame to carve", "variables": [], "features": feats,
            "analysis": {"body": "env", "material": "steel", "quality": "fine", "live": False,
                         "load": {"type": "force", "vector": LOAD, "pressure": 1, "torque": 10, "axis": "Z"},
                         "bodies": {"env": {"fixed": fixed, "loads": loads}},
                         "carve": {"keep": 0.32, "defl": None, "detail": "coarse", "smooth": True}}}, fixed, loads


def carve():
    import generate as G
    from scriptcad import kernel
    from scriptcad.fea import analyze
    doc, fixed, loads = carve_doc()
    geom = kernel.analysis_geometry(doc, "env", {"fixed": fixed, "load": loads}, "fine")
    cid, _, meta = analyze.build(geom, {"body": "env", "material": "steel", "quality": "fine", "fixed": fixed,
                                        "load": {"type": "force", "vector": LOAD, "faces": loads}})
    p = analyze._cases.pop(cid)["p"]
    G.OUT.mkdir(parents=True, exist_ok=True)
    rmin = G.DETAIL_VOX["coarse"] * (meta["cad_volume"] / G.NORMAL_VOXELS) ** (1 / 3) / meta["h"]
    design, info = G.carve(p, {"target": 0.32, "rmin": rmin, "maxIter": 160})
    OUT.mkdir(exist_ok=True)
    np.savez_compressed(OUT / "frame_carved.npz", design=design.reshape(p.shape[::-1]), fill=(p.emod > 0).reshape(p.shape[::-1]),
                        h=p.h, origin=p.origin)
    (OUT / "frame_carve.json").write_text(json.dumps({**{k: info[k] for k in ("stop", "fraction", "compliance", "solves")}, "h": p.h,
                                                      "compliance_before": info["steps"][0]["compliance"], "doc": doc}), encoding="utf-8")
    print(f"carved: {info['fraction']:.0%} kept, {info['solves']} solves, h {p.h} mm, stop: {info['stop']}")


def chaikin(pts, n=2):
    for _ in range(n):
        q = []
        for a, b in zip(pts, pts[1:] + pts[:1]):
            q += [(0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]), (0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1])]
        pts = q
    return pts


def simplify(pts, tol):
    """Douglas-Peucker on a closed loop."""
    def dp(seg):
        if len(seg) < 3:
            return seg
        a, b = np.array(seg[0]), np.array(seg[-1])
        ab = b - a
        L = np.linalg.norm(ab) or 1e-9
        d = [abs(ab[0] * (p[1] - a[1]) - ab[1] * (p[0] - a[0])) / L for p in seg[1:-1]]
        i = int(np.argmax(d)) + 1
        return dp(seg[:i + 1])[:-1] + dp(seg[i:]) if d[i - 1] > tol else [seg[0], seg[-1]]
    k = len(pts) // 2
    return dp(pts[:k + 1])[:-1] + dp(pts[k:] + [pts[0]])[:-1]


def trace(min_web=30.0, min_hole=2500.0):
    """The carve as a flat profile: through-thickness majority, then smoothed, the seat and back edges and
    the feet kept solid, webs at least min_web wide, openings smaller than min_hole mm^2 filled."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    z = np.load(OUT / "frame_carved.npz")
    design, space, h, origin = z["design"], z["fill"], float(z["h"]), z["origin"]     # [z, y, x]
    m = design.mean(axis=2) > 0.5                                    # (z, y): solid through most of the thickness
    inside = space.any(axis=2)
    ny, nzz = m.shape[1], m.shape[0]
    Y = origin[1] + (np.arange(ny) + 0.5) * h
    Z = origin[2] + (np.arange(nzz) + 0.5) * h
    YY, ZZ = np.meshgrid(Y, Z)
    # keep a band under the seat and back edges (the slats sit on them) and the feet solid
    def band(a, b, width):
        a, b = np.array(a, float), np.array(b, float)
        t = b - a
        L = np.linalg.norm(t)
        t /= L
        n = np.array([t[1], -t[0]])                                  # pointing down/into the frame
        P = np.stack([YY - a[0], ZZ - a[1]], -1)
        s, d = P @ t, P @ n
        return (s >= -5) & (s <= L + 5) & (d >= -2) & (d <= width)
    keep = band(*SEAT, 45) | band(*BACK, 45)               # the feet: Carve always keeps material at supports
    m = (m | keep) & inside & (ZZ >= 0)
    # smooth the voxel steps, then webs of at least min_web and no small openings
    f = ndimage.gaussian_filter(m.astype(float), sigma=18.0 / h)
    m = (f > 0.5) | keep
    r = int(round(min_web / 2 / h))
    disk = np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r
    m = ndimage.binary_closing(m, structure=np.ones((3, 3))) & inside & (ZZ >= 0)
    thin = m & ~ndimage.binary_opening(m, structure=disk)            # webs thinner than min_web
    m = m | ndimage.binary_dilation(thin, structure=disk) & inside & (ZZ >= 0)
    holes = ndimage.binary_fill_holes(m) & ~m
    lab, n = ndimage.label(holes)
    for k in range(1, n + 1):
        if (lab == k).sum() * h * h < min_hole:
            m[lab == k] = True
    # trace: pad with empty, so the bottom edge is the floor (z = 0 between the first row and the pad)
    pad = np.pad(m.astype(float), 1)
    Yp = np.concatenate([[Y[0] - h], Y, [Y[-1] + h]])
    Zp = np.concatenate([[Z[0] - h], Z, [Z[-1] + h]])
    cs = plt.contour(Yp, Zp, pad, levels=[0.5])
    loops = [np.asarray(q) for q in cs.get_paths()[0].to_polygons()]
    plt.close("all")
    # the feet stand on the floor: points within a voxel of it go to z = 0
    loops = [[(float(a), 0.0 if b < h else float(b)) for a, b in L] for L in loops if len(L) > 8]
    area = lambda L: 0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(L, L[1:] + L[:1]))
    loops.sort(key=lambda L: -abs(area(L)))
    outer, holes = loops[0], loops[1:]
    out = {"outer": simplify(chaikin(simplify(outer, 1.5), 3), 0.5), "holes": [simplify(chaikin(simplify(L, 1.5), 3), 0.5) for L in holes],
           "thickness": T, "h": h, "min_web": min_web}
    out["area_mm2"] = abs(area(out["outer"])) - sum(abs(area(L)) for L in out["holes"])
    (OUT / "frame_profile.json").write_text(json.dumps(out), encoding="utf-8")
    # a quick picture
    fig, ax = plt.subplots(figsize=(6, 7))
    for L in [out["outer"]] + out["holes"]:
        a = np.array(L + L[:1])
        ax.plot(a[:, 0], a[:, 1], "k-", lw=1.2)
    ax.set_aspect("equal"); ax.set_title(f"side frame: {len(out['holes'])} openings, {out['area_mm2'] / 1e4:.0f} dm2")
    fig.savefig(OUT / "frame_profile.png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    print(f"profile: outer {len(out['outer'])} points, {len(out['holes'])} openings, area {out['area_mm2'] / 1e4:.1f} dm2")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--trace", action="store_true")
    a = ap.parse_args()
    if not a.trace:
        carve()
    trace()
