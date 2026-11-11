"""Generates the ScriptCAD Carve dataset: parametric parts, carved by the app's own optimiser.

Every sample is a ScriptCAD document (it opens in the app) of one of three families, with its
supports, load and carve settings drawn at random from a seeded generator:

  chair    the lounge-chair block: a side profile, three or four feet, seat and back loaded,
           optionally rounded corners (the family of the Bone-inspired chair)
  beam     a bar on two or three feet, or held at one end, with a load pad on top
  bracket  a block bolted to a wall by two or four pads, with a load pad at the front

The document is voxelised exactly as the app does (fea.analyze.build), and carved by
web/fea/topo.js in Node, with every solve done here on the GPU (CUDA multigrid, float32).

    python bench/dataset/generate.py --n 200 --start 0         # samples 0..199
    python bench/dataset/generate.py --n 3 --start 0 --quality draft   # a quick pilot

Writes bench/dataset/out/samples/<id>.npz and <id>.json; it skips samples already done.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
import traceback
from importlib.resources import files
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
OUT = HERE / "out" / "samples"
WEB = Path(str(files("scriptcad") / "web")).resolve()
CHAIR = json.loads((WEB / "examples" / "chair.json").read_text(encoding="utf-8"))
DETAIL_VOX = {"fine": 2.5, "medium": 4.0, "coarse": 6.0}      # web/carve.js DETAIL
NORMAL_VOXELS = 200_000


# ---- the families: (doc, setup) from a random generator ---------------------------------------

def pad(*dims):
    """Thickness of a support or load pad: at least about one voxel at Normal resolution, or the voxeliser
    drops it as a sliver and the load lands on nothing."""
    return round(max(4.0, 0.025 * max(dims)), 1)


def box(fid, name, x, y, z, l, w, h):
    return {"id": fid, "type": "box", "name": name, "params": {"x": x, "y": y, "z": z, "l": l, "w": w, "h": h}}


def union(fid, name, tool):
    return {"id": fid, "type": "boolean", "name": name, "params": {"op": "union", "target": "env", "tool": tool, "keep_tool": False}}


def carve_settings(rng):
    return {"keep": float(rng.choice([0.1, 0.15, 0.2, 0.25, 0.3, 0.4])),
            "detail": str(rng.choice(["fine", "medium", "coarse"], p=[0.4, 0.4, 0.2]))}


def chair(rng):
    v = {x["name"]: x["value"] for x in CHAIR["variables"]}
    W, D, H = rng.uniform(380, 600), rng.uniform(650, 950), rng.uniform(650, 850)
    lip = rng.uniform(300, 400)
    seatFront = lip + rng.uniform(10, 60)
    seatDepth = rng.uniform(0.45, 0.6) * D
    seatRear = rng.uniform(220, min(360, seatFront - 10))
    gapY = seatDepth + rng.uniform(15, 40)
    gapZ = seatRear + rng.uniform(10, 60)
    backTopY = D - rng.uniform(30, 90)
    P = rng.uniform(28, 40)
    feet4 = rng.random() < 0.4
    footX = rng.uniform(20, 0.4 * W - P) if feet4 else rng.uniform(20, 0.42 * W - P)
    footY = rng.uniform(40, 0.35 * D)
    rearFootY = rng.uniform(0.6 * D, D - P - 10)
    v.update(W=W, D=D, H=H, lip=lip, seatFront=seatFront, seatDepth=seatDepth, seatRear=seatRear, gapY=gapY, gapZ=gapZ,
             backTopY=backTopY, P=P, tp=12, footX=footX, footY=footY, rearFootY=rearFootY)
    v = {k: round(float(x), 1) for k, x in v.items()}
    doc = json.loads(json.dumps(CHAIR))
    doc["name"] = "Carve dataset: chair"
    doc["variables"] = [{"name": k, "value": x} for k, x in v.items()]
    z, yF, yR = -v["tp"], v["footY"] + v["P"] / 2, v["rearFootY"] + v["P"] / 2
    xL, xR = v["footX"] + v["P"] / 2, v["W"] - v["footX"] - v["P"] / 2
    fixed = [[xL, yF, z], [xR, yF, z], [v["W"] / 2, yR, z]]
    if feet4:
        f3 = next(f for f in doc["features"] if f["id"] == "f3")
        f3["name"], f3["params"]["x"] = "Foot rear left", "footX"
        i3 = doc["features"].index(f3)
        doc["features"].insert(i3 + 1, {"id": "f4", "type": "box", "name": "Foot rear right", "params": {**f3["params"], "x": "W - footX - P"}})
        doc["features"].append(union("u4", "Add rear right foot", "f4"))
        fixed = [[xL, yF, z], [xR, yF, z], [xL, yR, z], [xR, yR, z]]
    loads = [[v["W"] / 2, (70 + v["seatDepth"]) / 2, (v["seatFront"] + v["seatRear"]) / 2],
             [v["W"] / 2, (v["gapY"] + v["backTopY"]) / 2, (v["gapZ"] + v["H"]) / 2]]
    rounded = rng.random() < 0.5
    if rounded:
        round_corners(doc, v, rng)
    params = {"feet": 4 if feet4 else 3, "rounded": rounded, **v}
    return doc, {"material": "aluminium", "fixed": fixed, "loads": loads,
                 "load": [0.0, round(float(rng.uniform(0, 500))), -1000.0]}, params


def round_corners(doc, v, rng):
    """Cut the block with a rounded plan (with a waist at the seat-back junction) and a front
    outline with rounded top corners (as the Bone-inspired chair)."""
    W, D, H = v["W"], v["D"], v["H"]
    Rf, Rb, Rtop = rng.uniform(100, 0.45 * W), rng.uniform(80, 0.35 * W), rng.uniform(80, 0.35 * W)
    yJ = (v["seatDepth"] + v["gapY"]) / 2
    waist = max(0.0, min(120.0, D - Rb - yJ - 10, yJ - Rf - 10))
    notch = rng.uniform(0, 0.12 * W) if waist > 30 else 0.0
    arc = lambda cx, cy, r, a0, a1, n=10: [(cx + r * math.cos(a0 + (a1 - a0) * k / n), cy + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]
    inset = lambda y: notch * 0.5 * (1 + math.cos(math.pi * (y - yJ) / waist)) if waist and abs(y - yJ) < waist else 0.0
    side = lambda y0, y1, left: [((inset(y) if left else W - inset(y)), y) for y in np.linspace(y0, y1, 25)]
    plan = (arc(W - Rf, Rf, Rf, -math.pi / 2, 0) + side(Rf, D - Rb, False) + arc(W - Rb, D - Rb, Rb, 0, math.pi / 2)
            + arc(Rb, D - Rb, Rb, math.pi / 2, math.pi) + side(D - Rb, Rf, True) + arc(Rf, Rf, Rf, math.pi, 1.5 * math.pi))
    front = [(0, -60), (W, -60)] + arc(W - Rtop, H - Rtop, Rtop, 0, math.pi / 2) + arc(Rtop, H - Rtop, Rtop, math.pi / 2, math.pi)
    s = lambda pts: "; ".join(f"{x:.2f}, {y:.2f}" for x, y in pts)
    i0 = next(i for i, f in enumerate(doc["features"]) if f["id"] == "env") + 1
    doc["features"][i0:i0] = [
        {"id": "plan", "type": "extrude", "name": "Rounded plan", "params": {"plane": "XY", "profile": "polyline", "points": s(plan), "dist": H + 120, "offset": -60, "cx": 0, "cy": 0}},
        {"id": "r1", "type": "boolean", "name": "Round the corners (plan)", "params": {"op": "intersection", "target": "env", "tool": "plan", "keep_tool": False}},
        {"id": "front", "type": "extrude", "name": "Rounded front", "params": {"plane": "XZ", "profile": "polyline", "points": s(front), "dist": D + 40, "offset": -(D + 20), "cx": 0, "cy": 0}},
        {"id": "r2", "type": "boolean", "name": "Round the corners (front)", "params": {"op": "intersection", "target": "env", "tool": "front", "keep_tool": False}},
    ]


def beam(rng):
    L, W, H = rng.uniform(150, 420), rng.uniform(20, 90), rng.uniform(30, 120)
    tp, P = pad(L, W, H), rng.uniform(8, 20)
    kind = str(rng.choice(["two feet", "three feet", "cantilever"], p=[0.45, 0.2, 0.35]))
    feats, fixed = [box("env", "Beam", 0, 0, 0, L, W, H)], []
    if kind == "cantilever":
        feats.append(box("s1", "Wall", -tp, 0, 0, tp, W, H)); feats.append(union("u1", "Add wall", "s1"))
        fixed = [[-tp, W / 2, H / 2]]
    else:
        xs = [0.0, L - P] + ([L / 2 - P / 2] if kind == "three feet" else [])
        for i, x in enumerate(xs):
            feats.append(box(f"s{i}", f"Foot {i + 1}", x, 0, -tp, P, W, tp)); feats.append(union(f"u{i}", f"Add foot {i + 1}", f"s{i}"))
            fixed.append([x + P / 2, W / 2, -tp])
    a = rng.uniform(10, 0.3 * L)
    xl = float(rng.uniform(0.6 * L, L - a) if kind == "cantilever" else rng.uniform(0.15 * L, 0.85 * L - a))
    feats.append(box("pad", "Load pad", xl, 0, H, a, W, tp)); feats.append(union("upad", "Add load pad", "pad"))
    p = {"kind": kind, "L": L, "W": W, "H": H, "pad_x": xl, "pad_len": a, "foot": P}
    p = {k: (round(x, 1) if isinstance(x, float) else x) for k, x in p.items()}
    return ({"name": "Carve dataset: beam", "variables": [], "features": feats},
            {"material": "steel", "fixed": fixed, "loads": [[xl + a / 2, W / 2, H + tp]],
             "load": [round(float(rng.uniform(-300, 300))), 0.0, -2000.0]}, p)


def bracket(rng):
    Wx, Dy, Hz = rng.uniform(60, 200), rng.uniform(60, 220), rng.uniform(60, 200)
    tp, P = pad(Wx, Dy, Hz), rng.uniform(10, 0.3 * min(Wx, Hz))
    feats, fixed = [box("env", "Bracket", 0, 0, 0, Wx, Dy, Hz)], []
    four = rng.random() < 0.5
    zs = [0.15 * Hz, 0.85 * Hz - P] if four else [rng.uniform(0.1, 0.9) * (Hz - P)]
    xs = [0.12 * Wx, 0.88 * Wx - P]
    k = 0
    for z in zs:
        for x in xs:
            feats.append(box(f"b{k}", f"Bolt pad {k + 1}", x, Dy, z, P, tp, P)); feats.append(union(f"ub{k}", f"Add bolt pad {k + 1}", f"b{k}"))
            fixed.append([x + P / 2, Dy + tp, z + P / 2]); k += 1
    a, b = rng.uniform(10, 0.4 * Wx), rng.uniform(10, 0.3 * Dy)
    xa = float(rng.uniform(0, Wx - a))
    on_top = rng.random() < 0.6
    if on_top:
        feats.append(box("pad", "Load pad", xa, 0, Hz, a, b, tp)); loads = [[xa + a / 2, b / 2, Hz + tp]]
    else:
        zb = float(rng.uniform(0, 0.5 * Hz))
        feats.append(box("pad", "Load pad", xa, -tp, zb, a, tp, b)); loads = [[xa + a / 2, -tp, zb + b / 2]]
    feats.append(union("upad", "Add load pad", "pad"))
    p = {"Wx": Wx, "Dy": Dy, "Hz": Hz, "bolts": len(fixed), "pad_on_top": on_top, "pad": [a, b]}
    p = {k: (round(x, 1) if isinstance(x, float) else x) for k, x in p.items()}
    return ({"name": "Carve dataset: bracket", "variables": [], "features": feats},
            {"material": "steel", "fixed": fixed, "loads": loads,
             "load": [round(float(rng.uniform(-200, 200))), round(float(rng.uniform(-200, 200))), -1000.0]}, p)


def cyl(fid, name, x, y, z, r, h):
    return {"id": fid, "type": "cylinder", "name": name, "params": {"x": x, "y": y, "z": z, "r": r, "h": h}}


def bool_op(fid, name, op, tool):
    return {"id": fid, "type": "boolean", "name": name, "params": {"op": op, "target": "env", "tool": tool, "keep_tool": False}}


def load_vector(rng, F):
    """A load at a random angle, mostly downward."""
    d = np.array([rng.uniform(-0.7, 0.7), rng.uniform(-0.7, 0.7), -1.0])
    return [round(float(x), 1) for x in F * d / np.linalg.norm(d)]


def random_shape(rng):
    """A base block with up to three blocks and cylinders on it (L, T and stepped shapes), on feet
    or a wall, with one or two load pads on the highest part and a load at a random angle."""
    Bx, By, Bz = rng.uniform(60, 300), rng.uniform(30, 200), rng.uniform(20, 120)
    tp = pad(Bx, By, 2.5 * Bz)
    feats, parts = [box("env", "Base", 0, 0, 0, Bx, By, Bz)], [("box", 0, 0, 0, Bx, By, Bz)]
    for k in range(int(rng.integers(0, 4))):
        if rng.random() < 0.6:
            l, w, h = rng.uniform(0.2, 0.8) * Bx, rng.uniform(0.2, 1.0) * By, rng.uniform(0.3, 1.5) * Bz
            x, y = rng.uniform(0, Bx - l), rng.uniform(0, By - w)
            feats += [box(f"p{k}", f"Block {k + 1}", x, y, Bz - 1, l, w, h), bool_op(f"up{k}", f"Add block {k + 1}", "union", f"p{k}")]
            parts.append(("box", x, y, Bz - 1, l, w, h))
        else:
            r = rng.uniform(0.1, 0.3) * min(Bx, By); h = rng.uniform(0.5, 2.0) * Bz
            x, y = rng.uniform(r, Bx - r), rng.uniform(r, By - r)
            feats += [cyl(f"p{k}", f"Cylinder {k + 1}", x, y, Bz - 1, r, h), bool_op(f"up{k}", f"Add cylinder {k + 1}", "union", f"p{k}")]
            parts.append(("cyl", x, y, Bz - 1, r, h))
    fixed = []
    if rng.random() < 0.7:                                   # feet under the base
        for k in range(int(rng.integers(1, 4))):
            P = rng.uniform(0.06, 0.2) * min(Bx, By)
            x, y = rng.uniform(0, Bx - P), rng.uniform(0, By - P)
            feats += [box(f"s{k}", f"Foot {k + 1}", x, y, -tp, P, P, tp), bool_op(f"us{k}", f"Add foot {k + 1}", "union", f"s{k}")]
            fixed.append([x + P / 2, y + P / 2, -tp])
    else:                                                    # a wall at one end
        feats += [box("s0", "Wall", -tp, 0, 0, tp, By, Bz), bool_op("us0", "Add wall", "union", "s0")]
        fixed.append([-tp, By / 2, Bz / 2])
    top = max(parts, key=lambda q: q[3] + (q[6] if q[0] == "box" else q[5]))      # the highest part
    loads = []
    for k in range(int(rng.integers(1, 3))):
        if top[0] == "box":
            _, x0, y0, z0, l, w, h = top
            a, b = rng.uniform(0.15, 0.5) * l, rng.uniform(0.15, 0.6) * w
            x, y = rng.uniform(x0, x0 + l - a), rng.uniform(y0, y0 + w - b)
        else:
            _, cx, cy, z0, r, h = top
            a = b = 0.6 * r
            x, y = cx - a / 2, cy - b / 2
        zt = z0 + h
        feats += [box(f"q{k}", f"Load pad {k + 1}", x, y, zt, a, b, tp), bool_op(f"uq{k}", f"Add load pad {k + 1}", "union", f"q{k}")]
        loads.append([x + a / 2, y + b / 2, zt + tp])
    params = {"base": [round(Bx, 1), round(By, 1), round(Bz, 1)], "parts": len(parts) - 1, "supports": len(fixed), "load_pads": len(loads),
              "wall": fixed[0][0] < 0}
    return ({"name": "Carve dataset: random shape", "variables": [], "features": feats},
            {"material": "steel", "fixed": fixed, "loads": loads, "load": load_vector(rng, 2000.0)}, params)


def flange(rng):
    """A plate with bolt holes (held in the holes) and a boss on top that carries the load."""
    L, W, T = rng.uniform(80, 260), rng.uniform(60, 200), rng.uniform(10, 40)
    n = int(rng.integers(2, 7))
    rh = rng.uniform(3, 9)
    feats, fixed = [box("env", "Plate", 0, 0, 0, L, W, T)], []
    margin = rh + 6
    for k in range(n):
        ang = 2 * math.pi * k / n + rng.uniform(-0.2, 0.2)
        x = L / 2 + (L / 2 - margin) * math.cos(ang)
        y = W / 2 + (W / 2 - margin) * math.sin(ang)
        feats += [cyl(f"h{k}", f"Hole {k + 1}", x, y, -1, rh, T + 2), bool_op(f"d{k}", f"Drill hole {k + 1}", "difference", f"h{k}")]
        fixed.append([x + rh, y, T / 2])
    rb = rng.uniform(0.08, 0.2) * min(L, W); hb = rng.uniform(10, 60)
    bx, by = rng.uniform(0.35, 0.65) * L, rng.uniform(0.35, 0.65) * W
    feats += [cyl("boss", "Boss", bx, by, T - 1, rb, hb + 1), bool_op("ub", "Add boss", "union", "boss")]
    params = {"L": round(L, 1), "W": round(W, 1), "T": round(T, 1), "holes": n, "hole_r": round(rh, 1), "boss_r": round(rb, 1), "boss_h": round(hb, 1)}
    return ({"name": "Carve dataset: flange", "variables": [], "features": feats},
            {"material": "steel", "fixed": fixed, "loads": [[bx, by, T + hb]], "load": load_vector(rng, 3000.0)}, params)


def lbracket(rng):
    """An L held at the back of its upright, loaded at the end of its arm."""
    Hv, La, W = rng.uniform(60, 220), rng.uniform(60, 260), rng.uniform(20, 120)
    t1, t2 = rng.uniform(0.15, 0.5) * La, rng.uniform(0.15, 0.5) * Hv
    tp = pad(Hv, La, W)
    feats = [box("env", "Upright", 0, 0, 0, t1, W, Hv), box("arm", "Arm", 0, 0, 0, La, W, t2), bool_op("ua", "Add arm", "union", "arm"),
             box("wall", "Wall", -tp, 0, 0, tp, W, Hv), bool_op("uw", "Add wall", "union", "wall")]
    a = rng.uniform(10, 0.35 * La)
    feats += [box("pad", "Load pad", La - a, 0, t2, a, W, tp), bool_op("up", "Add load pad", "union", "pad")]
    params = {"Hv": round(Hv, 1), "La": round(La, 1), "W": round(W, 1), "t_upright": round(t1, 1), "t_arm": round(t2, 1), "pad": round(a, 1)}
    return ({"name": "Carve dataset: L-bracket", "variables": [], "features": feats},
            {"material": "steel", "fixed": [[-tp, W / 2, Hv / 2]], "loads": [[La - a / 2, W / 2, t2 + tp]], "load": load_vector(rng, 1500.0)}, params)


FAMILIES = {"chair": chair, "beam": beam, "bracket": bracket, "random": random_shape, "flange": flange, "lbracket": lbracket}


def FAMILY_OF(i):
    """Samples 0-299: chairs, beams and brackets in turn. From 300: half random shapes, the rest
    flanges, L-brackets and the first three families."""
    if i < 300:
        return ("chair", "beam", "bracket")[i % 3]
    return ("random", "random", "random", "random", "random", "flange", "flange", "lbracket", "lbracket", "chair", "beam", "bracket")[i % 12]


# ---- one sample ---------------------------------------------------------------------------------

def carve(p, opts):
    """The app's optimiser in Node, every solve here on the GPU. Returns (design bool, info)."""
    from scriptcad.fea import multigrid
    from scriptcad.fea.grid import Problem
    blob = OUT / "_current.vxf"
    blob.write_bytes(p.to_bytes())
    node = subprocess.Popen(["node", str(HERE / "run_carve.mjs"), str(blob), WEB.as_uri() + "/", json.dumps(opts)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    nv, nn = p.emod.size, p.n_nodes
    q = Problem(p.shape, p.h, p.origin, p.emod.copy(), p.nu, fixed=p.fixed.copy(), force=p.force.copy())
    solves, solve_s = 0, 0.0
    while True:
        tag = node.stdout.read(1)
        if tag == b"S":
            q.emod = np.frombuffer(node.stdout.read(4 * nv), "<f4").astype(np.float64)
            q.fixed = np.frombuffer(node.stdout.read(12 * nn), "<u4").astype(np.uint8)
            for attr in ("_cpu_cache", "_element_nodes"):
                if hasattr(q, attr) and attr == "_cpu_cache":
                    setattr(q, attr, None)
            if not np.abs(q.force * (q.fixed == 0)).any():
                node.kill()
                raise ValueError("the carve cut the load off from the supports (the member between them was removed)")
            t = time.perf_counter()
            u, _ = multigrid.pcg(q, tol=1e-6, dtype="float32")
            solve_s += time.perf_counter() - t
            node.stdin.write(u.astype("<f4").tobytes()); node.stdin.flush()
            solves += 1
        elif tag == b"D":
            n = int.from_bytes(node.stdout.read(4), "little")
            info = json.loads(node.stdout.read(n))
            emod = np.frombuffer(node.stdout.read(4 * nv), "<f4")
            node.wait()
            return emod > 0, {**info, "solves": solves, "solve_seconds": round(solve_s, 2)}
        else:
            raise RuntimeError(f"node ended unexpectedly ({node.wait()}): {node.stderr}")


def sample(i, quality):
    from scriptcad import kernel
    from scriptcad.fea import analyze
    family = FAMILY_OF(i)
    rng = np.random.default_rng(1000 + i)
    doc, s, params = FAMILIES[family](rng)
    cs = carve_settings(rng)
    doc["analysis"] = {"body": "env", "material": s["material"], "quality": quality, "live": False,
                       "load": {"type": "force", "vector": s["load"], "pressure": 1, "torque": 10, "axis": "Z"},
                       "bodies": {"env": {"fixed": s["fixed"], "loads": s["loads"]}},
                       "carve": {"keep": cs["keep"], "defl": None, "detail": cs["detail"], "smooth": True}}
    t0 = time.perf_counter()
    geom = kernel.analysis_geometry(doc, "env", {"fixed": s["fixed"], "load": s["loads"]}, quality)
    setup = {"body": "env", "material": s["material"], "quality": quality, "fixed": s["fixed"],
             "load": {"type": "force", "vector": s["load"], "faces": s["loads"]}}
    cid, _blob, meta = analyze.build(geom, setup)
    p = analyze._cases[cid]["p"]
    analyze._cases.pop(cid, None)
    if not np.abs(p.force * (p.fixed == 0)).any():
        raise ValueError("the load reached no free node (its face lies on held or empty voxels)")
    rmin = DETAIL_VOX[cs["detail"]] * (meta["cad_volume"] / NORMAL_VOXELS) ** (1 / 3) / meta["h"]
    design, info = carve(p, {"target": cs["keep"], "rmin": rmin, "maxIter": 160})
    _, E, nu, rho = analyze.MATERIALS[s["material"]]
    fill = p.emod / E                                             # how full each voxel is (0..1)
    vox_g = rho / 1000 * p.h ** 3
    rec = {
        "id": f"{i:05d}", "family": family, "params": params, "carve": cs, "material": s["material"], "E_MPa": E, "nu": nu,
        "density_g_cm3": rho, "load_N": s["load"], "fixed_points": s["fixed"], "load_points": s["loads"],
        "h_mm": p.h, "shape": list(p.shape), "origin": p.origin.tolist(), "quality": quality,
        "keep_target": cs["keep"], "keep_reached": round(float(info["fraction"]), 4), "keep_floor": round(float(info["minShare"]), 4),
        "mass_g_before": round(float(fill.sum() * vox_g), 2), "mass_g_after": round(float(fill[design].sum() * vox_g), 2),
        "compliance_before": info["steps"][0]["compliance"], "compliance_after": info["compliance"],
        "max_disp_mm_before": info["steps"][0]["dmax"], "max_disp_mm_after": info["dmax"],
        "stop": info["stop"], "solves": info["solves"], "seconds": round(time.perf_counter() - t0, 1), "solve_seconds": info["solve_seconds"],
        "history": info["steps"], "doc": doc,
    }
    rec["stiffness_per_mass_gain"] = round((rec["compliance_before"] * rec["mass_g_before"]) / (rec["compliance_after"] * rec["mass_g_after"]), 4)
    held = p.fixed.reshape(-1, 3).any(axis=1)
    loaded = np.flatnonzero(np.abs(p.force) > 0)
    np.savez_compressed(OUT / f"{i:05d}.npz", fill=np.round(fill * 255).astype(np.uint8).reshape(p.shape[::-1]),
                        design=design.reshape(p.shape[::-1]), held_nodes=held.reshape(tuple(n + 1 for n in p.shape[::-1])),
                        force_dofs=loaded.astype(np.uint32), force_values=p.force[loaded].astype(np.float32))
    (OUT / f"{i:05d}.json").write_text(json.dumps(rec), encoding="utf-8")
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--quality", default="normal", choices=["draft", "normal", "fine"])
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for i in range(a.start, a.start + a.n):
        if (OUT / f"{i:05d}.json").exists():
            continue
        try:
            r = sample(i, a.quality)
            print(f"{r['id']} {r['family']:<8} keep {r['keep_target']:.2f}->{r['keep_reached']:.2f} "
                  f"gain {r['stiffness_per_mass_gain']:.2f}x  {r['solves']} solves  {r['seconds']:.0f} s", flush=True)
        except Exception:
            print(f"{i:05d} FAILED\n{traceback.format_exc()}", flush=True)
            (OUT / f"{i:05d}.failed").write_text(traceback.format_exc(), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
