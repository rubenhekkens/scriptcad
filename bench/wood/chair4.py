"""A wooden lounge chair with four fanned profiles, after Santiago Calatrava.

The side profile is one gesture: an S-curve rises from the front foot, takes the front of the seat,
and swoops under it into a node at the seat-back corner; from that node a tendon runs down to the rear
foot and a single blade rises as the back. Every member swells at the node and thins to its ends. The
four profiles fan out like ribs (-4, -1.5, 1.5, 4 degrees about seat height), the seat dishes and the
back wraps round you, and the bent ash slats thin to a blade at their ends.

    python bench/wood/chair4.py     # -> out4/calatrava_chair4.json, out4/profile_<k>.dxf, out4/forms.dxf,
                                    #    out4/cut_list.md, out4/profiles.png
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import chair as C                                      # loops_of, dxf

OUT = HERE / "out4"
W, T, N = 600.0, 18.0, 4                               # width at the seat, profile thickness, profiles
LEAN = [4.0, 1.5, -1.5, -4.0]                          # degrees; positive leans the foot out to -x
PIVOT_Z = 330.0                                        # the profiles fan about seat height
SEAT0 = ((40.0, 360.0), (470.0, 300.0))                # seat line, front -> rear (8 degrees back)
BACK0 = ((495.0, 312.0), (735.0, 800.0))               # back line, bottom -> top (26 degrees from vertical)
SEAT_SLAT, BACK_SLAT, SLAT_T, GAP = 60.0, 70.0, 15.0, 14.0
DISH_SEAT, DISH_BACK = 25.0, 35.0
FILLET, CORNER_R = 22.0, 30.0
XC = [T / 2 + k * (W - T) / (N - 1) for k in range(N)]  # centre planes at seat height


def dish(x, depth):
    half = (XC[-1] - XC[0]) / 2
    u = (x - (XC[0] + XC[-1]) / 2) / half
    return max(0.0, depth * (1 - u * u))


def frame_of(line):
    a, b = np.array(line[0], float), np.array(line[1], float)
    t = (b - a) / np.linalg.norm(b - a)
    return a, b, t, np.array([-t[1], t[0]])            # n: out of the profile (up / forward)


def catmull(pts, n=240):
    """A smooth curve through pts (uniform Catmull-Rom), and the parameter of each sample."""
    P = np.array(pts, float)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out, u = [], []
    segs = len(P) - 3
    for i in range(segs):
        p0, p1, p2, p3 = P[i:i + 4]
        for t in np.linspace(0, 1, n // segs, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
            u.append((i + t) / segs)
    out.append(P[-2]); u.append(1.0)
    return np.array(out), np.array(u)


def members(d_seat, d_back):
    """The profile's members as (points, widths at those points), for a profile whose seat sits d_seat
    lower and whose back sits d_back further back (the dish where it stands)."""
    sa, sb, st, sn = frame_of(SEAT0)
    ba, bb, bt, bn = frame_of(BACK0)
    sa, sb = sa - d_seat * sn, sb - d_seat * sn
    ba, bb = ba - d_back * bn, bb - d_back * bn
    lift = lambda p, k=1.0: (p[0], p[1] - k * d_seat * min(1.0, max(0.0, p[1] / 300.0)))   # feet stay on the floor
    node = (sb + ba) / 2 - 34 * (sn + bn) / np.linalg.norm(sn + bn)                      # under the seat-back corner
    seat_rail = ([sa - 16 * sn + [6, 0], (sa + sb) / 2 - 20 * sn, sb - 24 * sn], [30, 38, 66])
    back_blade = ([ba - 26 * bn, ba + bt * 0.45 * np.linalg.norm(bb - ba) - 20 * bn, bb - 12 * bn], [84, 44, 22])
    s_curve = ([lift((132, -25)), lift((140, 160)), lift((160, 296)), sa + st * 150 - 18 * sn, lift((310, 165)), lift((420, 205)), node],
               [34, 34, 38, 32, 40, 56, 90])
    tendon = ([node, lift((600, 150), 0.5), lift((690, -25), 0)], [88, 50, 32])
    return [seat_rail, back_blade, s_curve, tendon], (sa, sb, st, sn), (ba, bb, bt, bn), node


def raster(d_seat, d_back, res=1.0):
    ys, zs = np.arange(-40, 820, res), np.arange(-40, 860, res)
    Y, Z = np.meshgrid(ys, zs)
    m = np.zeros(Y.shape, bool)
    mem, (sa, sb, st, sn), (ba, bb, bt, bn), node = members(d_seat, d_back)
    for pts, widths in mem:
        curve, u = catmull(pts)
        # widths along the curve: interpolated between the control points' widths
        wu = np.interp(u, np.linspace(0, 1, len(widths)), widths)
        for p, w in zip(curve, wu):
            r = w / 2
            iy, iz = int((p[0] - ys[0]) / res), int((p[1] - zs[0]) / res)
            k = int(math.ceil(r / res)) + 1
            sl = (slice(max(0, iz - k), iz + k + 1), slice(max(0, iy - k), iy + k + 1))
            m[sl] |= (Y[sl] - p[0]) ** 2 + (Z[sl] - p[1]) ** 2 <= r * r
    rf = int(FILLET / res)
    disk = np.hypot(*np.mgrid[-rf:rf + 1, -rf:rf + 1]) <= rf
    m = ndimage.binary_closing(np.pad(m, rf), structure=disk)[rf:-rf, rf:-rf]
    # the seat and back lines stay straight (the slats sit on them), the feet on the floor
    side = lambda a, b: (b[0] - a[0]) * (Z - a[1]) - (b[1] - a[1]) * (Y - a[0])
    above_seat = (side(sa, sb) > 0) & (Y < sb[0] + 12)
    before_back = (side(ba, bb) > 0) & (Z > ba[1] - 12) & (Y > sb[0] - 5)
    m &= ~above_seat & ~before_back & (Z >= 0)
    rc = int(CORNER_R / res)
    disk = np.hypot(*np.mgrid[-rc:rc + 1, -rc:rc + 1]) <= rc
    near = np.hypot(Y - (sb[0] + ba[0]) / 2, Z - (sb[1] + ba[1]) / 2) < 2.2 * CORNER_R
    m |= ndimage.binary_closing(np.pad(m, rc), structure=disk)[rc:-rc, rc:-rc] & near
    return m, ys, zs


def profile(k):
    m, ys, zs = raster(dish(XC[k], DISH_SEAT), dish(XC[k], DISH_BACK))
    loops, area = C.loops_of(m, ys, zs)
    from side_frame import simplify
    loops = [simplify(L, 0.8) for L in loops]
    return loops[0], loops[1:], abs(area(np.array(loops[0]))) - sum(abs(area(np.array(L))) for L in loops[1:])


def rot_y(x, z, xc, deg):
    a = math.radians(deg)
    dx, dz = x - xc, z - PIVOT_Z
    return xc + dx * math.cos(a) + dz * math.sin(a), PIVOT_Z - dx * math.sin(a) + dz * math.cos(a)


def pts_str(pts):
    return "; ".join(f"{a:.2f}, {b:.2f}" for a, b in pts)


SLAT_XS = np.array([0, 15, 35, 60] + list(np.linspace(110, W - 110, 9)) + [W - 60, W - 35, W - 15, W])


def slat_outline(depth):
    """A bent slat: dished, and thinning from SLAT_T to 9 mm over its last 60 mm (a blade at the ends)."""
    th = lambda x: SLAT_T - (SLAT_T - 9.0) * max(0.0, 1 - min(x, W - x) / 60.0) ** 1.5
    top = [(x, th(x) - dish(x, depth)) for x in SLAT_XS]
    bot = [(x, -dish(x, depth)) for x in SLAT_XS[::-1]]
    return top + bot


def build():
    feats, fixed, loads, areas = [], [], [], []
    xs0 = [x - T / 2 for x in XC]
    for k in range(N):
        outer, holes, a = profile(k)
        areas.append(a)
        pid = "frame" if k == 0 else f"p{k}"
        feats.append({"id": pid, "type": "extrude", "name": f"Profile {k + 1} (birch ply {T:.0f} mm)",
                      "params": {"plane": "YZ", "profile": "polyline", "points": pts_str(outer), "dist": T, "offset": xs0[k], "cx": 0, "cy": 0}})
        for h, L in enumerate(holes):
            feats.append({"id": f"o{k}_{h}", "type": "extrude", "name": f"Profile {k + 1}: opening {h + 1}",
                          "params": {"plane": "YZ", "profile": "polyline", "points": pts_str(L), "dist": T + 2, "offset": xs0[k] - 1, "cx": 0, "cy": 0}})
            feats.append({"id": f"c{k}_{h}", "type": "boolean", "name": f"Profile {k + 1}: cut opening {h + 1}",
                          "params": {"op": "difference", "target": pid, "tool": f"o{k}_{h}", "keep_tool": False}})
        feats.append({"id": f"s{k}", "type": "move", "name": f"Profile {k + 1}: fan {LEAN[k]:+.1f} degrees",
                      "params": {"target": pid, "angle": LEAN[k], "axis": "Y", "px": XC[k], "py": 0, "pz": PIVOT_Z, "tx": 0, "ty": 0, "tz": 0}})
        if k:
            feats.append({"id": f"j{k}", "type": "boolean", "name": f"Join profile {k + 1}", "params": {"op": "union", "target": "frame", "tool": pid, "keep_tool": False}})
        floor = [p for p in outer if p[1] == 0.0]
        for y0, y1 in ((0, 350), (350, 900)):
            fy = [p[0] for p in floor if y0 <= p[0] < y1]
            x, z = rot_y(XC[k], 0.0, XC[k], LEAN[k])
            fixed.append([round(x, 2), round((min(fy) + max(fy)) / 2, 2), round(z, 2)])
    for line, depth, width, side_name in ((SEAT0, DISH_SEAT, SEAT_SLAT, "seat"), (BACK0, DISH_BACK, BACK_SLAT, "back")):
        a, b, t, n = frame_of(line)
        L = np.linalg.norm(b - a)
        count = int((L + GAP) // (width + GAP))
        start = (L - (count * width + (count - 1) * GAP)) / 2
        ang = math.degrees(math.atan2(t[1], t[0]))
        for i in range(count):
            p0 = a + t * (start + i * (width + GAP))
            sid = f"{side_name}{i}"
            feats.append({"id": sid, "type": "extrude", "name": f"{side_name.capitalize()} slat {i + 1} (ash, bent, {SLAT_T:.0f} x {width:.0f})",
                          "params": {"plane": "XZ", "profile": "polyline", "points": pts_str(slat_outline(depth)), "dist": width, "offset": -width, "cx": 0, "cy": 0}})
            feats.append({"id": f"m{sid}", "type": "move", "name": f"Place {side_name} slat {i + 1}",
                          "params": {"target": sid, "angle": round(ang, 4), "axis": "X", "px": 0, "py": 0, "pz": 0,
                                     "tx": 0, "ty": round(float(p0[0]), 3), "tz": round(float(p0[1]), 3)}})
            feats.append({"id": f"j{sid}", "type": "boolean", "name": f"Fix {side_name} slat {i + 1}", "params": {"op": "union", "target": "frame", "tool": sid, "keep_tool": False}})
            for x0, x1 in zip(SLAT_XS, SLAT_XS[1:]):
                xm = (x0 + x1) / 2
                if abs(xm - W / 2) > 180:
                    continue
                top = p0 + t * width / 2 + n * (SLAT_T - (dish(x0, depth) + dish(x1, depth)) / 2)
                loads.append([round(float(xm), 2), round(float(top[0]), 2), round(float(top[1]), 2)])
    doc = {"name": "Calatrava lounge chair, four profiles (wood)",
           "variables": [{"name": "W", "value": W}, {"name": "T", "value": T}],
           "features": feats,
           "analysis": {"body": "frame", "material": "birch", "quality": "normal", "live": False,
                        "load": {"type": "force", "vector": [0, 500, -1600], "pressure": 1, "torque": 10, "axis": "Z"},
                        "bodies": {"frame": {"fixed": fixed, "loads": loads}},
                        "carve": {"keep": 0.3, "defl": None, "detail": "medium", "smooth": True}}}
    OUT.mkdir(exist_ok=True)
    (OUT / "calatrava_chair4.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    return doc, areas


def outputs(areas):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(7.5, 7))
    for k in range(N):
        outer, holes, _ = profile(k)
        C.dxf(OUT / f"profile_{k + 1}.dxf", [outer] + holes)
        for Lp in [outer] + holes:
            a = np.array(Lp + Lp[:1])
            ax.plot(a[:, 0], a[:, 1], lw=1.0, color=plt.cm.viridis(k / (N - 1)), label=f"profile {k + 1}" if Lp is outer else None)
    ax.set_aspect("equal"); ax.legend(loc="lower left", fontsize=8); ax.set_title("the four profiles (mm)")
    fig.savefig(OUT / "profiles.png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    C.dxf(OUT / "forms.dxf", [[(x, -dish(x, DISH_SEAT)) for x in np.linspace(0, W, 61)] + [(W, -60), (0, -60)],
                              [(x, -dish(x, DISH_BACK) + 200) for x in np.linspace(0, W, 61)] + [(W, 140), (0, 140)]])
    counts = {}
    for line, width, nm in ((SEAT0, SEAT_SLAT, "seat"), (BACK0, BACK_SLAT, "back")):
        counts[nm] = int((np.linalg.norm(np.subtract(*line)) + GAP) // (width + GAP))
    frames_kg = sum(areas) * T * 0.68e-6
    slats_kg = (counts["seat"] * SEAT_SLAT + counts["back"] * BACK_SLAT) * SLAT_T * W * 0.67e-6 * 0.93
    (OUT / "cut_list.md").write_text(f"""# Calatrava lounge chair, four profiles: cut list

| Part | Material | Size (mm) | Qty | Notes |
|---|---|---|---|---|
| Profiles 1 and 4 (outer) | birch plywood {T:.0f} mm | `profile_1.dxf`, `profile_4.dxf` | 1 + 1 | fan out {abs(LEAN[0]):.1f} degrees about seat height; bevel the feet to match |
| Profiles 2 and 3 (inner) | birch plywood {T:.0f} mm | `profile_2.dxf`, `profile_3.dxf` | 1 + 1 | fan out {abs(LEAN[1]):.1f} degrees; the seat lower and the back deeper (the dish) |
| Seat slat | ash, bent laminate (5 x 3 mm veneers) | {SLAT_T:.0f} x {SEAT_SLAT:.0f} x {W:.0f}, dish {DISH_SEAT:.0f} | {counts['seat']} | one form (`forms.dxf`, lower curve); thin the last 60 mm to 9 mm |
| Back slat | ash, bent laminate (5 x 3 mm veneers) | {SLAT_T:.0f} x {BACK_SLAT:.0f} x {W:.0f}, dish {DISH_BACK:.0f} | {counts['back']} | one form (`forms.dxf`, upper curve); thin the ends the same way |

Profiles {(W - T) / (N - 1):.0f} mm apart at seat height, centre to centre.
Weight: profiles about {frames_kg:.1f} kg, slats about {slats_kg:.1f} kg, together about {frames_kg + slats_kg:.1f} kg.
Joints: one 8 mm dowel and glue where each slat crosses a profile ({(counts['seat'] + counts['back']) * N} dowels).
""", encoding="utf-8")
    print(f"{N} profiles, {counts['seat']} + {counts['back']} slats, about {frames_kg + slats_kg:.1f} kg")


if __name__ == "__main__":
    doc, areas = build()
    outputs(areas)
