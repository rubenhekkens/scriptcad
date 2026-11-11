"""A wooden lounge chair, after Santiago Calatrava, built in ScriptCAD for CNC production.

The side frame follows the load paths Carve found (side_frame.py): a front leg, the seat rail, a
diagonal spine from under the seat to the rear foot, the back rail and a rear post, as tapered
members joined by large radii. Two side frames (birch plywood, 2 x 18 mm glued) carry ash slats
across the seat and the back, like ribs.

    python bench/wood/chair.py      # -> out/calatrava_chair.json (ScriptCAD project), out/*.dxf, out/cut_list.md,
                                    #    out/frame.png; and the chair's strength under a seated person

Coordinates: x across the chair, y from front to back, z up (mm).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy import ndimage

HERE = Path(__file__).parent
OUT = HERE / "out"

W = 560.0                    # overall width
N_FRAMES = 5                 # profiles across the chair, evenly spaced, like ribs
T = 18.0                     # each profile: one sheet of 18 mm birch plywood
SLIM = 0.66                  # member widths, as a share of the first (36 mm, two-frame) design
SLAT_T, SLAT_W, GAP = 15.0, 52.0, 16.0          # 15 mm: the slats now span only about 118 mm between profiles          # ash slats: thickness, width, gap between
SEAT = ((55.0, 405.0), (480.0, 375.0))          # top line of the seat rail (front -> back)
BACK = ((500.0, 392.0), (642.0, 830.0))         # front line of the back rail (bottom -> top)
CORNER_R = 25.0                                 # the seat-back inside corner
FILLET = 26.0                                   # radius of the junctions
# members: (start, control, end, width at start, width at end); quadratic curves
MEMBERS = {
    "seat rail": (None, None, None, 54, 46),               # along the seat line (filled in below)
    "front leg": ((92, 392), (98, 200), (112, -20), 56, 44),
    "spine": ((250, 372), (430, 240), (604, -20), 46, 60),
    "back rail": (None, None, None, 52, 40),
    "rear post": ((652, -20), (676, 400), (668, 812), 64, 44),
    "top cap": ((640, 808), (657, 818), (676, 808), 40, 40),
}


def offset_line(a, b, d):
    """The line a-b moved by d into the frame (to the right of the direction a -> b)."""
    a, b = np.array(a), np.array(b)
    t = (b - a) / np.linalg.norm(b - a)
    n = np.array([t[1], -t[0]])
    return a + d * n, b + d * n


def members():
    m = dict(MEMBERS)
    a, b = offset_line(*SEAT, 27 * SLIM)
    m["seat rail"] = (tuple(a + [-8, 0]), tuple((a + b) / 2), tuple(b + [12, 0]), 54, 70)      # deeper into the seat-back corner
    a, b = offset_line(*BACK, 26 * SLIM)
    m["back rail"] = (tuple(a), tuple((a + b) / 2), tuple(b), 78, 40)       # the lever arm when leaning back
    return m


def raster(res=1.0):
    """The side frame as a mask (z, y) at res mm: tapered members, then the junctions rounded."""
    ys, zs = np.arange(-20, 760, res), np.arange(-40, 880, res)
    Y, Z = np.meshgrid(ys, zs)
    m = np.zeros(Y.shape, bool)
    for name, (p0, pc, p1, w0, w1) in members().items():
        for t in np.linspace(0, 1, 160):
            p = (1 - t) ** 2 * np.array(p0) + 2 * (1 - t) * t * np.array(pc) + t * t * np.array(p1)
            r = SLIM * ((1 - t) * w0 + t * w1) / 2
            iy, iz = int((p[0] - ys[0]) / res), int((p[1] - zs[0]) / res)
            k = int(math.ceil(r / res)) + 1
            sl = (slice(max(0, iz - k), iz + k + 1), slice(max(0, iy - k), iy + k + 1))
            m[sl] |= (Y[sl] - p[0]) ** 2 + (Z[sl] - p[1]) ** 2 <= r * r
    # keep the seat and back lines straight: nothing above the seat line or in front of the back line
    def side(a, b):
        a, b = np.array(a), np.array(b)
        return (b[0] - a[0]) * (Z - a[1]) - (b[1] - a[1]) * (Y - a[0])
    above_seat = (side(*SEAT) > 0) & (Y < SEAT[1][0] + 15)
    before_back = (side(*BACK) > 0) & (Z > BACK[0][1] - 10) & (Z < 830) & (Y > SEAT[1][0] - 5)
    r = int(FILLET / res)
    disk = np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r
    m = ndimage.binary_closing(np.pad(m, r), structure=disk)[r:-r, r:-r]       # rounded junctions
    m &= ~above_seat & ~before_back & (Z >= 0) & (Z <= 830)
    # a radius in the inside corner where the seat line meets the back line (stress gathers in sharp
    # inside corners, and wood cracks there); only near the corner, so the slat lines stay straight
    rc = int(CORNER_R / res)
    disk = np.hypot(*np.mgrid[-rc:rc + 1, -rc:rc + 1]) <= rc
    near = np.hypot(Y - (SEAT[1][0] + BACK[0][0]) / 2, Z - (SEAT[1][1] + BACK[0][1]) / 2) < 2.2 * CORNER_R
    m |= ndimage.binary_closing(np.pad(m, rc), structure=disk)[rc:-rc, rc:-rc] & near & (Z <= 830)
    return m, ys, zs, res


def loops_of(m, ys, zs):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cs = plt.contour(ys, zs, np.pad(m.astype(float), 0), levels=[0.5])
    loops = [np.asarray(q) for q in cs.get_paths()[0].to_polygons()]
    plt.close("all")
    from side_frame import simplify
    area = lambda L: 0.5 * float(np.sum(L[:, 0] * np.roll(L[:, 1], -1) - np.roll(L[:, 0], -1) * L[:, 1]))
    loops = sorted((L for L in loops if len(L) > 8), key=lambda L: -abs(area(L)))
    out = []
    for L in loops:
        pts = [(round(float(a), 2), round(max(0.0, float(b)) if b > 1.0 else 0.0, 2)) for a, b in L[:-1]]
        out.append(simplify(pts, 0.35))
    return out, area


def slats():
    """Slat cross-sections (y, z polygons) on the seat and back lines, evenly spaced."""
    out = []
    for (a, b), side_name in ((SEAT, "seat"), (BACK, "back")):
        a, b = np.array(a), np.array(b)
        L = np.linalg.norm(b - a)
        t = (b - a) / L
        n = np.array([-t[1], t[0]])                                 # away from the frame
        k = int((L + GAP) // (SLAT_W + GAP))
        start = (L - (k * SLAT_W + (k - 1) * GAP)) / 2
        for i in range(k):
            s0 = start + i * (SLAT_W + GAP)
            p0, p1 = a + t * s0, a + t * (s0 + SLAT_W)
            poly = [p0, p1, p1 + n * SLAT_T, p0 + n * SLAT_T]
            out.append((side_name, i, [(round(float(p[0]), 2), round(float(p[1]), 2)) for p in poly], p0 + t * SLAT_W / 2 + n * SLAT_T))
    return out


def pts_str(pts):
    return "; ".join(f"{a}, {b}" for a, b in pts)


def build():
    m, ys, zs, res = raster()
    loops, area = loops_of(m, ys, zs)
    outer, holes = loops[0], loops[1:]
    feats = [{"id": "frame", "type": "extrude", "name": f"Profile 1 (birch ply {T:.0f} mm)",
              "params": {"plane": "YZ", "profile": "polyline", "points": pts_str(outer), "dist": T, "offset": 0, "cx": 0, "cy": 0}}]
    for k, L in enumerate(holes):
        feats.append({"id": f"o{k}", "type": "extrude", "name": f"Opening {k + 1}",
                      "params": {"plane": "YZ", "profile": "polyline", "points": pts_str(L), "dist": T + 2, "offset": -1, "cx": 0, "cy": 0}})
        feats.append({"id": f"c{k}", "type": "boolean", "name": f"Cut opening {k + 1}", "params": {"op": "difference", "target": "frame", "tool": f"o{k}", "keep_tool": False}})
    xs = [round(k * (W - T) / (N_FRAMES - 1), 3) for k in range(N_FRAMES)]       # where each profile starts
    for k, x in enumerate(xs[1:], start=2):
        feats.append({"id": f"frame{k}", "type": "copy", "name": f"Profile {k}", "params": {"target": "frame", "tx": x, "ty": 0, "tz": 0}})
        feats.append({"id": f"j{k}", "type": "boolean", "name": f"Join profile {k}", "params": {"op": "union", "target": "frame", "tool": f"frame{k}", "keep_tool": False}})
    loads, fixed = [], []
    for side_name, i, poly, top in slats():
        sid = f"{side_name}{i}"
        feats.append({"id": sid, "type": "extrude", "name": f"{side_name.capitalize()} slat {i + 1} (ash {SLAT_T:.0f} x {SLAT_W:.0f})",
                      "params": {"plane": "YZ", "profile": "polyline", "points": pts_str(poly), "dist": W, "offset": 0, "cx": 0, "cy": 0}})
        feats.append({"id": f"j{sid}", "type": "boolean", "name": f"Fix {side_name} slat {i + 1}", "params": {"op": "union", "target": "frame", "tool": sid, "keep_tool": False}})
        loads.append([W / 2, round(float(top[0]), 2), round(float(top[1]), 2)])
    # the feet: the bottom of each leg, in both frames
    floor = [p for p in outer if p[1] == 0.0]
    for y0, y1 in ((0, 300), (300, 800)):
        fy = [p[0] for p in floor if y0 <= p[0] < y1]
        for x in (x0 + T / 2 for x0 in xs):
            fixed.append([x, round((min(fy) + max(fy)) / 2, 2), 0.0])
    doc = {"name": "Calatrava lounge chair (wood)", "variables": [
               {"name": "W", "value": W}, {"name": "T", "value": T}],
           "features": feats,
           "analysis": {"body": "frame", "material": "birch", "quality": "normal", "live": False,
                        "load": {"type": "force", "vector": [0, 500, -1600], "pressure": 1, "torque": 10, "axis": "Z"},
                        "bodies": {"frame": {"fixed": fixed, "loads": loads}},
                        "carve": {"keep": 0.3, "defl": None, "detail": "medium", "smooth": True}}}
    OUT.mkdir(exist_ok=True)
    (OUT / "calatrava_chair.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    a_frame = abs(area(np.array(outer))) - sum(abs(area(np.array(L))) for L in holes)
    return doc, outer, holes, a_frame


def dxf(path, loops):
    """Closed polylines (mm) as a minimal DXF (R12 POLYLINE entities): what a CNC router's CAM reads."""
    out = ["0", "SECTION", "2", "ENTITIES"]
    for L in loops:
        out += ["0", "POLYLINE", "8", "CUT", "66", "1", "70", "1"]
        for a, b in L:
            out += ["0", "VERTEX", "8", "CUT", "10", f"{a:.3f}", "20", f"{b:.3f}"]
        out += ["0", "SEQEND"]
    out += ["0", "ENDSEC", "0", "EOF"]
    Path(path).write_text("\n".join(out) + "\n", encoding="ascii")


def drawing(outer, holes):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(6, 7))
    for L in [outer] + holes:
        a = np.array(L + L[:1])
        ax.plot(a[:, 0], a[:, 1], "k-", lw=1.2)
    for side_name, i, poly, _ in slats():
        a = np.array(poly + poly[:1])
        ax.fill(a[:, 0], a[:, 1], color="#c8a46a", lw=0)
    ax.set_aspect("equal")
    ax.set_title(f"profile (birch ply {T:.0f} mm, {N_FRAMES} of them) with ash slats, mm")
    fig.savefig(OUT / "frame.png", dpi=110, bbox_inches="tight")
    plt.close(fig)


def main():
    import sys
    sys.path.insert(0, str(HERE))
    doc, outer, holes, a_frame = build()
    drawing(outer, holes)
    dxf(OUT / "side_frame_x2.dxf", [outer] + holes)
    seat_n = sum(1 for s in slats() if s[0] == "seat")
    back_n = sum(1 for s in slats() if s[0] == "back")
    dxf(OUT / "slat_section.dxf", [slats()[0][2]])
    frame_kg = a_frame * T * 0.68e-6 * N_FRAMES / 2           # per pair, as the lines below count pairs
    slat_kg = (seat_n + back_n) * SLAT_T * SLAT_W * W * 0.67e-6
    (OUT / "cut_list.md").write_text(f"""# Calatrava lounge chair: cut list

| Part | Material | Size (mm) | Quantity | Notes |
|---|---|---|---|---|
| Profile | birch plywood {T:.0f} mm (BB/BB) | `side_frame_x2.dxf`, about 700 x 830 | {N_FRAMES} | cut from the DXF with the face grain vertical (along the rear post), {(W - T) / (N_FRAMES - 1):.0f} mm apart (centre to centre), round all edges r = 4 |
| Seat slat | ash | {SLAT_T:.0f} x {SLAT_W:.0f} x {W:.0f} | {seat_n} | gaps {GAP:.0f} mm |
| Back slat | ash | {SLAT_T:.0f} x {SLAT_W:.0f} x {W:.0f} | {back_n} | gaps {GAP:.0f} mm |

Weight: profiles about {2 * frame_kg:.1f} kg (birch ply 680 kg/m3), slats about {slat_kg:.1f} kg (ash 670 kg/m3).
Each slat: 2 x 8 mm dowels + glue into each side frame (the frames' top edges carry the slats), or
2 x 4.5 x 50 mm wood screws from below if it should come apart. Finish: hard-wax oil.
""", encoding="utf-8")
    print(f"frame area {a_frame / 1e4:.1f} dm2, {len(holes)} openings; {seat_n} seat + {back_n} back slats; "
          f"about {2 * frame_kg + slat_kg:.1f} kg")


if __name__ == "__main__":
    main()
