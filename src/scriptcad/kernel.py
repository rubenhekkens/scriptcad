"""Geometry worker: turns a feature history (or a user script) into meshes.

Everything that touches usd_brep lives here and runs in a separate process
(see server.py), so a kernel crash or a runaway script never takes the UI
server down with it.

The feature history is compiled to Python source, one snippet per feature,
and each snippet is executed in a shared namespace. The same snippets,
concatenated, are what "Export to script" hands the user, so the script view
and the parametric model can never disagree about what a feature does.
"""

from __future__ import annotations

import contextlib
import io
import math
import os
import re
import traceback

import usd_brep as sm

# ---------------------------------------------------------------------------
# Runtime helpers available to features and user scripts
# ---------------------------------------------------------------------------

PICK_TOL = 1e-3  # how far a stored reference point may drift from its entity


def _dist(a, b):
    return math.dist(a, b)


def edges_at(body, points):
    """Resolve stored 3D reference points to edges of `body`."""
    edges = body.edges()
    out = []
    for p in points:
        idx, t = sm.find_edge(body, tuple(p))
        e = edges[idx]
        d = _dist(e.point_at(t), p)
        if d > max(PICK_TOL, 1e-3 * _diag(body)):
            raise LookupError(
                f"edge reference {tuple(round(c, 4) for c in p)} no longer lies on the model "
                f"(nearest edge is {d:.4g} away) - reselect the edges"
            )
        if e not in out:
            out.append(e)
    return out


def faces_at(body, points):
    """Resolve stored 3D reference points to faces of `body`."""
    out = []
    for p in points:
        f = sm.find_face(body, tuple(p))
        _q, d = f.closest_point(tuple(p))
        if d > max(PICK_TOL, 1e-3 * _diag(body)):
            raise LookupError(
                f"face reference {tuple(round(c, 4) for c in p)} no longer lies on the model - reselect the faces"
            )
        if f not in out:
            out.append(f)
    return out


def _diag(body):
    lo, hi = body.bounding_box()
    return _dist(lo, hi)


def linear_pattern(body, count, step):
    """Union `count` copies of `body`, each offset by `step` from the last."""
    result = sm.brep_copy(body)
    for i in range(1, int(count)):
        c = sm.brep_copy(body)
        sm.translate(c, (step[0] * i, step[1] * i, step[2] * i))
        result = sm.boolean_union(result, c)
    return result


def polar_pattern(body, count, axis_point, axis, total_angle=360.0):
    """Union `count` copies of `body` rotated about an axis."""
    count = int(count)
    full = abs(total_angle) >= 360.0 - 1e-9
    step = total_angle / count if full else total_angle / max(count - 1, 1)
    result = sm.brep_copy(body)
    for i in range(1, count):
        c = sm.brep_copy(body)
        sm.rotate(c, tuple(axis_point), tuple(axis), step * i)
        result = sm.boolean_union(result, c)
    return result


# Profile plane orientation: profiles are built in local XY and the finished
# solid is rotated onto the requested plane.
#   XY: identity                     (extrude toward +Z)
#   XZ: rotate +90 about X           local y -> world z, extrude toward -Y
#   YZ: rotate 120 about (1,1,1)     local x->y, y->z, extrude toward +X
def to_plane(body, plane):
    if plane == "XZ":
        sm.rotate(body, (0, 0, 0), (1, 0, 0), 90.0)
    elif plane == "YZ":
        sm.rotate(body, (0, 0, 0), (1, 1, 1), 120.0)
    return body


def polyline(points, closed=True):
    pts = [tuple(p) + (0.0,) * (3 - len(p)) for p in points]
    n = len(pts)
    segs = []
    for i in range(n if closed else n - 1):
        a, b = pts[i], pts[(i + 1) % n]
        if _dist(a, b) > 1e-9:
            segs.append(sm.create_line_segment(a, b))
    return segs


# ---------------------------------------------------------------------------
# Feature -> Python source
# ---------------------------------------------------------------------------

def _f(x):
    """Format a number for generated code."""
    return repr(round(float(x), 9))


def _v(*xs):
    return "(" + ", ".join(_f(x) for x in xs) + ")"


def _pts(points):
    return "[" + ", ".join(_v(*p) for p in points) + "]"


def parse_points(text):
    """'0,0; 4,0; 4,2' -> [(0,0), (4,0), (4,2)]"""
    pts = []
    for chunk in re.split(r"[;\n]+", str(text)):
        chunk = chunk.strip()
        if not chunk:
            continue
        nums = [float(n) for n in re.split(r"[,\s]+", chunk) if n]
        if len(nums) < 2:
            raise ValueError(f"bad point '{chunk}' - use 'x, y' pairs separated by ';'")
        pts.append(tuple(nums[:2]))
    return pts


def _profile_code(p):
    kind = p.get("profile", "rect")
    if kind == "rect":
        return f"sm.create_rectangle({_v(p['cx'], p['cy'], 0)}, {_f(p['w'])}, {_f(p['h'])})"
    if kind == "circle":
        return f"[sm.create_circle({_v(p['cx'], p['cy'], 0)}, {_f(p['r'])})]"
    if kind == "polygon":
        return f"sm.create_regular_polygon({_v(p['cx'], p['cy'], 0)}, {int(p['sides'])}, {_f(p['r'])})"
    if kind == "polyline":
        pts = parse_points(p["points"])
        if len(pts) < 3:
            raise ValueError("a polyline profile needs at least 3 points")
        return f"polyline({_pts(pts)})"
    raise ValueError(f"unknown profile '{kind}'")


AXES = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}


def feature_code(feat, var, live):
    """Return (code, creates, consumes) for one feature.

    `var(fid)` maps a body id to its Python variable name; `live` is the set
    of body ids alive before this feature.
    """
    t = feat["type"]
    p = feat.get("params", {})
    fid = feat["id"]
    me = var(fid)

    def need(key):
        bid = p.get(key)
        if not bid:
            raise ValueError(f"choose a {key} body")
        if bid not in live:
            raise ValueError(f"{key} body '{bid}' does not exist at this point in the history")
        return bid

    if t == "box":
        return f"{me} = sm.create_box({_v(p['x'], p['y'], p['z'])}, {_f(p['l'])}, {_f(p['w'])}, {_f(p['h'])})", [fid], []
    if t == "cylinder":
        return f"{me} = sm.create_cylinder({_v(p['x'], p['y'], p['z'])}, {_f(p['r'])}, {_f(p['h'])})", [fid], []
    if t == "sphere":
        return f"{me} = sm.create_sphere({_v(p['x'], p['y'], p['z'])}, {_f(p['r'])})", [fid], []
    if t == "cone":
        return (f"{me} = sm.create_cone({_v(p['x'], p['y'], p['z'])}, {_f(p['r1'])}, {_f(p['r2'])}, {_f(p['h'])})",
                [fid], [])
    if t == "torus":
        return f"{me} = sm.create_torus({_v(p['x'], p['y'], p['z'])}, {_f(p['R'])}, {_f(p['r'])})", [fid], []
    if t == "pyramid":
        return f"{me} = sm.create_pyramid({_v(p['x'], p['y'], p['z'])}, {_f(p['l'])}, {_f(p['h'])})", [fid], []

    if t == "extrude":
        prof = _profile_code(p)
        lines = [
            f"{me} = sm.linear_sweep({prof}, (0.0, 0.0, 1.0), {_f(p['dist'])})",
        ]
        if float(p.get("offset", 0)):
            lines.append(f"sm.translate({me}, (0.0, 0.0, {_f(p['offset'])}))")
        if p.get("plane", "XY") != "XY":
            lines.append(f"to_plane({me}, {p['plane']!r})")
        return "\n".join(lines), [fid], []

    if t == "revolve":
        prof = _profile_code(p)
        ax = AXES[p.get("axis", "Y")]
        lines = [f"{me} = sm.rotational_sweep({prof}, (0.0, 0.0, 0.0), {_v(*ax)}, {_f(p['angle'])})"]
        if p.get("plane", "XY") != "XY":
            lines.append(f"to_plane({me}, {p['plane']!r})")
        return "\n".join(lines), [fid], []

    if t == "boolean":
        a, b = need("target"), need("tool")
        if a == b:
            raise ValueError("target and tool must be different bodies")
        op = {"union": "boolean_union", "difference": "boolean_difference",
              "intersection": "boolean_intersection"}[p.get("op", "union")]
        keep = bool(p.get("keep_tool"))
        tool = f"sm.brep_copy({var(b)})" if keep else var(b)
        return f"{var(a)} = sm.{op}({var(a)}, {tool})", [], ([] if keep else [b])

    if t == "fillet":
        a = need("target")
        refs = p.get("edges") or []
        if refs:
            xs = 0 if p.get("kind") == "chamfer" else (2 if p.get("kind") == "blend" else 1)
            return (f"sm.fillet_edges({var(a)}, edges_at({var(a)}, {_pts(refs)}), "
                    f"radius={_f(p['radius'])}, xsect_type={xs})"), [], []
        fn = "chamfer_fillet" if p.get("kind") == "chamfer" else "circular_fillet"
        return f"sm.{fn}({var(a)}, {_f(p['radius'])})  # every edge", [], []

    if t == "shell":
        a = need("target")
        refs = p.get("faces") or []
        faces = f", faces_to_shell=faces_at({var(a)}, {_pts(refs)})" if refs else ""
        return f"{var(a)} = sm.shell_brep({var(a)}, {_f(-abs(float(p['thickness'])))}{faces})", [], []

    if t == "offset":
        a = need("target")
        return f"{var(a)} = sm.offset_brep({var(a)}, {_f(p['distance'])})", [], []

    if t == "move":
        a = need("target")
        lines = []
        if float(p.get("angle", 0)):
            ax = AXES[p.get("axis", "Z")]
            lines.append(f"sm.rotate({var(a)}, {_v(p['px'], p['py'], p['pz'])}, {_v(*ax)}, {_f(p['angle'])})")
        if any(float(p.get(k, 0)) for k in ("tx", "ty", "tz")):
            lines.append(f"sm.translate({var(a)}, {_v(p['tx'], p['ty'], p['tz'])})")
        if float(p.get("scale", 1)) != 1.0:
            s = float(p["scale"])
            lines.append(f"sm.scale_about_point({var(a)}, {_v(p['px'], p['py'], p['pz'])}, {_v(s, s, s)})")
        return ("\n".join(lines) or f"pass  # no-op move of {var(a)}"), [], []

    if t == "copy":
        a = need("target")
        lines = [f"{me} = sm.brep_copy({var(a)})"]
        if any(float(p.get(k, 0)) for k in ("tx", "ty", "tz")):
            lines.append(f"sm.translate({me}, {_v(p['tx'], p['ty'], p['tz'])})")
        return "\n".join(lines), [fid], []

    if t == "pattern":
        a = need("target")
        n = int(p["count"])
        if n < 2:
            raise ValueError("pattern count must be at least 2")
        if p.get("mode", "linear") == "polar":
            ax = AXES[p.get("axis", "Z")]
            return (f"{var(a)} = polar_pattern({var(a)}, {n}, {_v(p['px'], p['py'], p['pz'])}, {_v(*ax)}, "
                    f"{_f(p.get('angle', 360))})"), [], []
        return f"{var(a)} = linear_pattern({var(a)}, {n}, {_v(p['dx'], p['dy'], p['dz'])})", [], []

    if t == "import":
        path = p.get("file")
        if not path:
            raise ValueError("no file chosen")
        idx = int(p.get("index", 0))
        return f"{me} = sm.usd.import_breps({path!r})[{idx}]", [fid], []

    raise ValueError(f"unknown feature type '{t}'")


def _varname_factory(features):
    names = {}
    used = set()
    for f in features:
        base = re.sub(r"\W+", "_", (f.get("name") or f["type"]).strip().lower()).strip("_") or "body"
        if base[0].isdigit():
            base = "b_" + base
        name, i = base, 2
        while name in used or name in {"sm", "show"}:
            name, i = f"{base}{i}", i + 1
        used.add(name)
        names[f["id"]] = name
    return lambda fid: names.get(fid, "body_" + re.sub(r"\W", "_", fid))


def compile_history(doc):
    """Compile a document into per-feature code snippets.

    Returns (snippets, live_bodies) where snippets is a list of
    dicts {id, code, error, creates, consumes}.
    """
    features = doc.get("features", [])
    var = _varname_factory(features)
    live = []
    out = []
    for feat in features:
        entry = {"id": feat["id"], "code": "", "error": None, "creates": [], "consumes": []}
        if feat.get("suppressed"):
            entry["skipped"] = True
            out.append(entry)
            continue
        try:
            code, creates, consumes = feature_code(feat, var, set(live))
            entry.update(code=code, creates=creates, consumes=consumes)
        except Exception as e:  # bad parameters: report on the feature
            entry["error"] = str(e)
        out.append(entry)
        if not entry["error"]:
            for c in entry["consumes"]:
                if c in live:
                    live.remove(c)
            live.extend(entry["creates"])
    return out, live, var


def history_to_script(doc):
    snippets, live, var = compile_history(doc)
    names = {f["id"]: f.get("name") or f["type"] for f in doc.get("features", [])}
    lines = [
        "# Generated by ScriptCAD from the feature history.",
        "# `sm` is usd_brep (NVIDIA USD BRep / SMLib). show(), edges_at(), faces_at(),",
        "# polyline(), to_plane(), linear_pattern() and polar_pattern() are ScriptCAD helpers.",
        "import usd_brep as sm",
        "",
    ]
    for s in snippets:
        title = names.get(s["id"], s["id"])
        if s.get("skipped"):
            lines.append(f"# [{title}] suppressed\n")
            continue
        if s["error"]:
            lines.append(f"# [{title}] skipped: {s['error']}\n")
            continue
        lines.append(f"# {title}")
        lines.append(s["code"])
        lines.append("")
    for bid in live:
        lines.append(f"show({var(bid)}, {names.get(bid, bid)!r})")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Execution and meshing
# ---------------------------------------------------------------------------

def _namespace(shown):
    def show(body, name=None, color=None):
        if not isinstance(body, sm.Brep):
            raise TypeError(f"show() expects a Brep, got {type(body).__name__}")
        shown.append({"brep": body, "name": name or f"Body {len(shown) + 1}", "color": color})
        return body

    return {
        "__name__": "__scriptcad__",
        "sm": sm,
        "usd_brep": sm,
        "math": math,
        "show": show,
        "edges_at": edges_at,
        "faces_at": faces_at,
        "polyline": polyline,
        "to_plane": to_plane,
        "linear_pattern": linear_pattern,
        "polar_pattern": polar_pattern,
    }


def _r(x):
    return round(float(x), 5)


def mesh_body(brep, quality):
    """Tessellate a Brep into flat arrays the viewer can upload directly."""
    lo, hi = brep.bounding_box()
    diag = max(_dist(lo, hi), 1e-6)
    chord = {"draft": 4e-3, "normal": 1e-3, "fine": 2.5e-4}.get(quality, 1e-3) * diag
    angle = {"draft": 20.0, "normal": 12.0, "fine": 6.0}.get(quality, 12.0)

    poly, report = sm.tessellate(
        brep, chord_height_tolerance=chord, surface_angle_tolerance_deg=angle,
        curve_angle_tolerance_deg=angle, allow_partial=True, return_report=True,
    )
    arrays = poly.to_mesh_arrays(face_varying_normals=True)
    pts, stream, cn = arrays["points"], arrays["faces"], arrays["normals"]

    faces = brep.faces()
    face_index = {}
    positions, normals, tri_face = [], [], []
    i = corner = 0
    while i < len(stream):
        n = stream[i]
        idx = stream[i + 1:i + 1 + n]
        nrm = cn[corner:corner + n]
        i += n + 1
        corner += n
        c = [sum(pts[k][j] for k in idx) / n for j in range(3)]
        f = sm.find_face(brep, tuple(c))
        fi = face_index.get(id(f))
        if fi is None:
            try:
                fi = faces.index(f)
            except ValueError:
                fi = -1
        for a in range(1, n - 1):  # fan-triangulate (stream is normally all triangles)
            for k, nn in ((idx[0], nrm[0]), (idx[a], nrm[a]), (idx[a + 1], nrm[a + 1])):
                positions.extend(_r(v) for v in pts[k])
                normals.extend(round(float(v), 4) for v in nn)
            tri_face.append(fi)

    epts, counts, _handles = sm.tessellate_boundaries(brep, angle_tolerance_deg=angle / 2, allow_partial=True)
    edge_pos = [_r(v) for p in epts for v in p]

    face_info = []
    for f in faces:
        try:
            ip = f.interior_point()
            ip = ip if isinstance(ip[0], (int, float)) else ip[0]
        except Exception:
            ip = f.centroid()
        try:
            area = f.area()
        except Exception:
            area = None
        face_info.append({"area": area, "ref": [_r(v) for v in ip]})

    edge_info = []
    for e in brep.edges():
        t0, t1 = e.parameter_range()
        try:
            length = e.length()
        except Exception:
            length = None
        edge_info.append({"length": length, "ref": [_r(v) for v in e.point_at((t0 + t1) / 2)]})

    manifold = brep.is_manifold_solid()
    try:
        volume = brep.volume() if manifold else None
    except Exception:
        volume = None
    try:
        area = brep.area()
    except Exception:
        area = None
    try:
        tlo, thi = sm.brep_bounding_box(brep, True)
    except Exception:
        tlo, thi = lo, hi

    warnings = []
    fails = (report or {}).get("face_failures") if isinstance(report, dict) else None
    if fails:
        warnings.append(f"{len(fails)} face(s) failed to tessellate")

    return {
        "positions": positions,
        "normals": normals,
        "triFace": tri_face,
        "edgePositions": edge_pos,
        "edgeCounts": list(counts),
        "faces": face_info,
        "edges": edge_info,
        "props": {
            "faces": brep.face_count(), "edges": brep.edge_count(), "vertices": brep.vertex_count(),
            "manifold": bool(manifold), "volume": volume, "area": area,
            "bbox": [[_r(v) for v in tlo], [_r(v) for v in thi]],
        },
        "warnings": warnings,
    }


def _run(code, ns, stdout):
    with contextlib.redirect_stdout(stdout):
        exec(compile(code, "<script>", "exec"), ns)


def _format_exc(e, code_name="<script>"):
    tb = traceback.extract_tb(e.__traceback__)
    line = next((fr.lineno for fr in reversed(tb) if fr.filename == code_name), None)
    msg = f"{type(e).__name__}: {e}"
    return msg, line


def regen(doc, quality="normal"):
    """Rebuild the feature history. Returns bodies + per-feature status."""
    snippets, live, var = compile_history(doc)
    feats = {f["id"]: f for f in doc.get("features", [])}
    names = {fid: f.get("name") or f["type"] for fid, f in feats.items()}
    shown = []
    ns = _namespace(shown)
    out = io.StringIO()
    status = {}
    alive = []
    for s in snippets:
        st = {"code": s["code"]}
        if s.get("skipped"):
            st["state"] = "suppressed"
        elif s["error"]:
            st["state"] = "error"
            st["error"] = s["error"]
        else:
            # Kernel ops consume or mutate their inputs even when they fail, so
            # keep copies to roll back to; later features then still see them.
            params = feats[s["id"]].get("params", {})
            backup = {}
            for key in ("target", "tool"):
                name = var(params[key]) if params.get(key) else None
                if name and isinstance(ns.get(name), sm.Brep):
                    backup[name] = sm.brep_copy(ns[name])
            try:
                _run(s["code"], ns, out)
                st["state"] = "ok"
                for c in s["consumes"]:
                    if c in alive:
                        alive.remove(c)
                alive.extend(s["creates"])
            except Exception as e:
                st["state"] = "error"
                st["error"], _ = _format_exc(e)
                # a failed feature must not leave a half-made body behind
                for c in s["creates"]:
                    ns.pop(var(c), None)
                ns.update(backup)
        status[s["id"]] = st

    bodies = []
    for bid in alive:
        brep = ns.get(var(bid))
        if brep is None:
            continue
        try:
            m = mesh_body(brep, quality)
        except Exception as e:
            status.setdefault(bid, {})["error"] = f"tessellation failed: {e}"
            continue
        m.update(id=bid, name=names.get(bid, bid))
        bodies.append(m)
    return {"bodies": bodies, "status": status, "stdout": out.getvalue()}


def run_script(code, quality="normal"):
    shown = []
    ns = _namespace(shown)
    out = io.StringIO()
    error = None
    try:
        _run(code, ns, out)
    except Exception as e:
        msg, line = _format_exc(e)
        error = {"message": msg, "line": line}
    if not shown and error is None:
        # convenience: show any Brep left in a top-level variable
        for k, v in list(ns.items()):
            if isinstance(v, sm.Brep) and not k.startswith("_"):
                shown.append({"brep": v, "name": k, "color": None})
    bodies = []
    for i, s in enumerate(shown):
        try:
            m = mesh_body(s["brep"], quality)
        except Exception as e:
            out.write(f"[tessellation of {s['name']} failed: {e}]\n")
            continue
        m.update(id=f"s{i}", name=s["name"], color=s["color"])
        bodies.append(m)
    return {"bodies": bodies, "stdout": out.getvalue(), "error": error}


def _collect(doc=None, code=None):
    if code is not None:
        shown = []
        ns = _namespace(shown)
        _run(code, ns, io.StringIO())
        return [s["brep"] for s in shown], [s["name"] for s in shown]
    snippets, live, var = compile_history(doc)
    ns = _namespace([])
    names = {f["id"]: f.get("name") or f["type"] for f in doc.get("features", [])}
    alive = []
    for s in snippets:
        if s.get("skipped") or s["error"]:
            continue
        try:
            _run(s["code"], ns, io.StringIO())
            for c in s["consumes"]:
                if c in alive:
                    alive.remove(c)
            alive.extend(s["creates"])
        except Exception:
            pass
    breps = [ns[var(b)] for b in alive if var(b) in ns]
    return breps, [names.get(b, b) for b in alive if var(b) in ns]


def export(path, fmt, doc=None, code=None, quality="fine"):
    breps, _names = _collect(doc, code)
    if not breps:
        raise ValueError("nothing to export - the model has no bodies")
    if fmt == "usd-brep":
        sm.usd.export_breps(breps, path)
    elif fmt == "usd-mesh":
        meshes = []
        for b in breps:
            lo, hi = b.bounding_box()
            meshes.append(sm.tessellate(b, chord_height_tolerance=2.5e-4 * _dist(lo, hi),
                                        surface_angle_tolerance_deg=8.0))
        sm.usd.export_meshes(meshes, path)
    elif fmt == "stl":
        _write_stl(breps, path)
    else:
        raise ValueError(f"unknown export format '{fmt}'")
    return {"bodies": len(breps)}


def _write_stl(breps, path):
    with open(path, "w", encoding="ascii") as fh:
        fh.write("solid scriptcad\n")
        for b in breps:
            lo, hi = b.bounding_box()
            a = sm.tessellate(b, chord_height_tolerance=2.5e-4 * _dist(lo, hi),
                              surface_angle_tolerance_deg=8.0).to_mesh_arrays()
            pts, stream, fns = a["points"], a["faces"], a["face_normals"]
            i = fi = 0
            while i < len(stream):
                n = stream[i]
                idx = stream[i + 1:i + 1 + n]
                nx, ny, nz = fns[fi]
                for k in range(1, n - 1):
                    fh.write(f"facet normal {nx:e} {ny:e} {nz:e}\n outer loop\n")
                    for v in (idx[0], idx[k], idx[k + 1]):
                        x, y, z = pts[v]
                        fh.write(f"  vertex {x:e} {y:e} {z:e}\n")
                    fh.write(" endloop\nendfacet\n")
                i += n + 1
                fi += 1
        fh.write("endsolid scriptcad\n")


def export_usd_bodies(out_dir, doc=None, code=None):
    """Write each body to its own BrepArray .usda (input for the STEP exporter)."""
    breps, names = _collect(doc, code)
    if not breps:
        raise ValueError("nothing to export - the model has no bodies")
    paths = []
    for i, b in enumerate(breps):
        p = os.path.join(out_dir, f"body_{i}.usda")
        sm.usd.export_brep(b, p)
        paths.append(p)
    return {"paths": paths, "names": names,
            "volumes": [b.volume() if b.is_manifold_solid() else None for b in breps]}


def inspect_usd(path):
    breps = sm.usd.import_breps(path)
    if not breps:
        raise ValueError("no BRep bodies in file")
    for b in breps:
        if b.face_count() == 0:
            raise ValueError("empty BRep body")
    return {"count": len(breps), "bodies": [{"faces": b.face_count(), "edges": b.edge_count(),
                                             "manifold": bool(b.is_manifold_solid())} for b in breps]}


def warmup():
    sm.create_box((0, 0, 0), 1, 1, 1)
    from importlib.metadata import version
    return {"usd_brep": version("usd-brep"), "pid": os.getpid()}


def api_names():
    """Names for script autocompletion: sm.<name> and sm.<module>.<name>."""
    import types as _t
    skip = {"os", "sys", "types", "importlib"}
    top, subs = [], {}
    for n in dir(sm):
        if n.startswith("_") or n in skip:
            continue
        obj = getattr(sm, n)
        top.append(n)
        if isinstance(obj, _t.ModuleType):
            subs[n] = [m for m in dir(obj) if not m.startswith("_")]
    docs = {}
    for n in top:
        d = (getattr(getattr(sm, n), "__doc__", "") or "").strip().split("\n")[0]
        if "(" in d and d.startswith(n):
            docs[n] = d
    return {"top": top, "subs": subs, "sigs": docs}
