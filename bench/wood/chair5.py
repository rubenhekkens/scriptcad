"""The wooden lounge chair with five graded profiles: a dished seat and a back that wraps round
you, as the chair's own deflection suggested (Analyze, strongly exaggerated), but designed in.

- The seat dips by DISH_SEAT at the centre and the back by DISH_BACK (parabolas across the width,
  nothing at the outer profiles). Each of the five profiles follows the dish where it stands, so all
  five are slightly different flat outlines (one DXF each).
- The slats are bent to the dish: all seat slats on one bending form, all back slats on another
  (bent lamination, e.g. 5 x 3 mm ash veneers).
- The two outer profiles lean out by SPLAY degrees about seat height: a wider stance at the feet.

    python bench/wood/chair5.py     # -> out5/calatrava_chair5.json, out5/profile_<k>.dxf, out5/forms.dxf,
                                    #    out5/cut_list.md, out5/profiles.png
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import chair as C                                     # the profile builder (members, junction radii)

OUT = HERE / "out5"
W, T, N = 560.0, 18.0, 5
SLAT_T, SLAT_W, GAP = 15.0, 52.0, 16.0
DISH_SEAT, DISH_BACK = 25.0, 35.0                     # mm, at the centre
SPLAY = 4.0                                           # degrees, outer profiles only
PIVOT_Z = 390.0                                       # the outer profiles lean about seat height
XS = [k * (W - T) / (N - 1) for k in range(N)]        # where each profile starts (x)
XC = [x + T / 2 for x in XS]                          # its centre plane


def dish(x, depth):
    """How far the seat (or back) is moved in at x: a parabola, zero at the outer profiles."""
    half = (XC[-1] - XC[0]) / 2
    u = (x - (XC[0] + XC[-1]) / 2) / half
    return max(0.0, depth * (1 - u * u))


def normal(a, b):
    """Unit direction a->b, and the normal pointing out of the profile (up for the seat, forward for the back)."""
    a, b = np.array(a, float), np.array(b, float)
    t = (b - a) / np.linalg.norm(b - a)
    return t, np.array([-t[1], t[0]])


def shifted(line, d):
    """The seat or back line moved d into the profile (down / backward)."""
    t, n = normal(*line)
    return tuple(tuple(np.array(p) - d * n) for p in line)


def profile(k):
    """The flat outline of profile k: (outer loop, holes), with the seat and back lines at its dish."""
    C.SEAT, C.BACK = shifted(SEAT0, dish(XC[k], DISH_SEAT)), shifted(BACK0, dish(XC[k], DISH_BACK))
    m, ys, zs, res = C.raster()
    loops, area = C.loops_of(m, ys, zs)
    from side_frame import simplify
    loops = [simplify(L, 0.8) for L in loops]              # 0.8 mm: far finer than a router needs, and quick to rebuild
    return loops[0], loops[1:], abs(area(np.array(loops[0]))) - sum(abs(area(np.array(L))) for L in loops[1:])


SEAT0, BACK0 = C.SEAT, C.BACK
# a strut from the front foot up to the middle of the spine: the front leg, the strut and the spine
# form an arch in the side view (and triangulate the space under the seat)
C.MEMBERS["front strut"] = ((114, -20), (262, 72), (428, 208), 58, 50)


def splay_of(k):
    return SPLAY if k == 0 else (-SPLAY if k == N - 1 else 0.0)


def rot_y(x, z, xc, deg):
    """A point of profile k after it leans by deg about the y axis through (xc, PIVOT_Z)."""
    a = math.radians(deg)
    dx, dz = x - xc, z - PIVOT_Z
    return xc + dx * math.cos(a) + dz * math.sin(a), PIVOT_Z - dx * math.sin(a) + dz * math.cos(a)


def pts_str(pts):
    return "; ".join(f"{a:.2f}, {b:.2f}" for a, b in pts)


def slat_outline(depth):
    """A bent slat in its own frame: length along x (0..W), thickness along local z, moved in by the
    dish (local -z). The outline in the XZ plane, for an extrusion of SLAT_W along y."""
    xs = np.linspace(0, W, 13)
    top = [(x, SLAT_T - dish(x, depth)) for x in xs]
    bot = [(x, -dish(x, depth)) for x in xs[::-1]]
    return top + bot


def build():
    feats, fixed, loads, areas = [], [], [], []
    for k in range(N):
        outer, holes, a = profile(k)
        areas.append(a)
        pid = "frame" if k == 0 else f"p{k}"
        feats.append({"id": pid, "type": "extrude", "name": f"Profile {k + 1} (birch ply {T:.0f} mm)",
                      "params": {"plane": "YZ", "profile": "polyline", "points": pts_str(outer), "dist": T, "offset": XS[k], "cx": 0, "cy": 0}})
        for h, L in enumerate(holes):
            feats.append({"id": f"o{k}_{h}", "type": "extrude", "name": f"Profile {k + 1}: opening {h + 1}",
                          "params": {"plane": "YZ", "profile": "polyline", "points": pts_str(L), "dist": T + 2, "offset": XS[k] - 1, "cx": 0, "cy": 0}})
            feats.append({"id": f"c{k}_{h}", "type": "boolean", "name": f"Profile {k + 1}: cut opening {h + 1}",
                          "params": {"op": "difference", "target": pid, "tool": f"o{k}_{h}", "keep_tool": False}})
        if splay_of(k):
            feats.append({"id": f"s{k}", "type": "move", "name": f"Profile {k + 1}: lean out {abs(splay_of(k)):.0f} degrees",
                          "params": {"target": pid, "angle": splay_of(k), "axis": "Y", "px": XC[k], "py": 0, "pz": PIVOT_Z, "tx": 0, "ty": 0, "tz": 0}})
        if k:
            feats.append({"id": f"j{k}", "type": "boolean", "name": f"Join profile {k + 1}", "params": {"op": "union", "target": "frame", "tool": pid, "keep_tool": False}})
        # the feet of this profile (front and rear), where they stand after leaning
        floor = [p for p in outer if p[1] == 0.0]
        for y0, y1 in ((0, 300), (300, 800)):
            fy = [p[0] for p in floor if y0 <= p[0] < y1]
            x, z = rot_y(XC[k], 0.0, XC[k], splay_of(k))
            fixed.append([round(x, 2), round((min(fy) + max(fy)) / 2, 2), round(z, 2)])
    # the slats, bent to the dish: built flat in their own frame, turned to the seat or back line, moved there
    for line, depth, side_name in ((SEAT0, DISH_SEAT, "seat"), (BACK0, DISH_BACK, "back")):
        a = np.array(line[0], float)
        t, n = normal(*line)
        L = np.linalg.norm(np.array(line[1]) - a)
        count = int((L + GAP) // (SLAT_W + GAP))
        start = (L - (count * SLAT_W + (count - 1) * GAP)) / 2
        ang = math.degrees(math.atan2(t[1], t[0]))
        for i in range(count):
            p0 = a + t * (start + i * (SLAT_W + GAP))
            sid = f"{side_name}{i}"
            feats.append({"id": sid, "type": "extrude", "name": f"{side_name.capitalize()} slat {i + 1} (ash, bent, {SLAT_T:.0f} x {SLAT_W:.0f})",
                          "params": {"plane": "XZ", "profile": "polyline", "points": pts_str(slat_outline(depth)), "dist": SLAT_W, "offset": -SLAT_W, "cx": 0, "cy": 0}})
            feats.append({"id": f"m{sid}", "type": "move", "name": f"Place {side_name} slat {i + 1}",
                          "params": {"target": sid, "angle": round(ang, 4), "axis": "X", "px": 0, "py": 0, "pz": 0,
                                     "tx": 0, "ty": round(float(p0[0]), 3), "tz": round(float(p0[1]), 3)}})
            feats.append({"id": f"j{sid}", "type": "boolean", "name": f"Fix {side_name} slat {i + 1}", "params": {"op": "union", "target": "frame", "tool": sid, "keep_tool": False}})
            # a seated person spreads over about 350 mm of the seat's width: load the slat's facets there
            xs = np.linspace(0, W, 13)
            for x0, x1 in zip(xs, xs[1:]):
                xm = (x0 + x1) / 2
                if abs(xm - W / 2) > 180:
                    continue
                top = p0 + t * SLAT_W / 2 + n * (SLAT_T - (dish(x0, depth) + dish(x1, depth)) / 2)
                loads.append([round(xm, 2), round(float(top[0]), 2), round(float(top[1]), 2)])
    doc = {"name": "Calatrava lounge chair, five profiles (wood)",
           "variables": [{"name": "W", "value": W}, {"name": "T", "value": T}],
           "features": feats,
           "analysis": {"body": "frame", "material": "birch", "quality": "normal", "live": False,
                        "load": {"type": "force", "vector": [0, 500, -1600], "pressure": 1, "torque": 10, "axis": "Z"},
                        "bodies": {"frame": {"fixed": fixed, "loads": loads}},
                        "carve": {"keep": 0.3, "defl": None, "detail": "medium", "smooth": True}}}
    OUT.mkdir(exist_ok=True)
    (OUT / "calatrava_chair5.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    return doc, areas


def outputs(areas):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(7, 7))
    for k in range(N):
        outer, holes, _ = profile(k)
        C.dxf(OUT / f"profile_{k + 1}.dxf", [outer] + holes)
        for Lp in [outer] + holes:
            a = np.array(Lp + Lp[:1])
            ax.plot(a[:, 0], a[:, 1], lw=1.0, color=plt.cm.viridis(k / (N - 1)), label=f"profile {k + 1}" if Lp is outer else None)
    ax.set_aspect("equal"); ax.legend(loc="lower left", fontsize=8); ax.set_title("the five profiles (mm): the middle ones follow the dish")
    fig.savefig(OUT / "profiles.png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    # the two bending forms: the slat's inner curve (seat and back), full length
    C.dxf(OUT / "forms.dxf", [[(x, -dish(x, DISH_SEAT)) for x in np.linspace(0, W, 57)] + [(W, -60), (0, -60)],
                              [(x, -dish(x, DISH_BACK) + 200) for x in np.linspace(0, W, 57)] + [(W, 140), (0, 140)]])
    seat_n = int((np.linalg.norm(np.subtract(*SEAT0)) + GAP) // (SLAT_W + GAP))
    back_n = int((np.linalg.norm(np.subtract(*BACK0)) + GAP) // (SLAT_W + GAP))
    frames_kg = sum(areas) * T * 0.68e-6
    slats_kg = (seat_n + back_n) * SLAT_T * SLAT_W * W * 0.67e-6
    (OUT / "cut_list.md").write_text(f"""# Calatrava lounge chair, five profiles: cut list

| Part | Material | Size (mm) | Qty | Notes |
|---|---|---|---|---|
| Profile 1 and 5 (outer) | birch plywood {T:.0f} mm | `profile_1.dxf`, `profile_5.dxf` | 1 + 1 | lean out {SPLAY:.0f} degrees about seat height: bevel the feet {SPLAY:.0f} degrees so they stand flat |
| Profile 2 and 4 | birch plywood {T:.0f} mm | `profile_2.dxf`, `profile_4.dxf` | 1 + 1 | |
| Profile 3 (middle) | birch plywood {T:.0f} mm | `profile_3.dxf` | 1 | the lowest seat, the deepest back |
| Seat slat | ash, bent laminate (5 x 3 mm veneers) | {SLAT_T:.0f} x {SLAT_W:.0f} x {W:.0f}, dish {DISH_SEAT:.0f} | {seat_n} | all on one form (`forms.dxf`, lower curve) |
| Back slat | ash, bent laminate (5 x 3 mm veneers) | {SLAT_T:.0f} x {SLAT_W:.0f} x {W:.0f}, dish {DISH_BACK:.0f} | {back_n} | all on one form (`forms.dxf`, upper curve) |

Profiles {(W - T) / (N - 1):.1f} mm apart, centre to centre (the outer two measured at seat height).
Weight: profiles about {frames_kg:.1f} kg, slats about {slats_kg:.1f} kg, together about {frames_kg + slats_kg:.1f} kg.
Joints: one 8 mm dowel and glue where each slat crosses a profile ({seat_n + back_n} slats x {N} profiles = {(seat_n + back_n) * N} dowels).
""", encoding="utf-8")
    print(f"{N} profiles, {seat_n} + {back_n} bent slats, about {frames_kg + slats_kg:.1f} kg")


if __name__ == "__main__":
    doc, areas = build()
    outputs(areas)
