"""OpenCASCADE side of STEP import/export.

Runs as its own process (``python -m scriptcad.occt_bridge ...``) so OpenCASCADE
never shares a process with the kernel's OpenUSD runtime, and a crash in either
library only fails the one request.

Import:  STEP -> one OCCT ``.brep`` per solid (then NVIDIA's ``occt_to_usd``).
Export:  kernel-written BrepArray ``.usda`` -> OCCT shape -> STEP.

The export path reads the BrepArray arrays directly: edges are rebuilt from the
exact 3D curves and shared vertices, faces from the exact surfaces, and
OpenCASCADE's ShapeFix computes the UV curves (pcurves) and sewing restores the
shared topology. NVIDIA's ``usd_to_occt`` is not used for export because its
v1.0.x output is invalid for many kernel-made parts.
"""

from __future__ import annotations

import ast
import json
import math
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# BrepArray .usda reader (only the attribute arrays, which is all we need)
# ---------------------------------------------------------------------------

_ATTR = re.compile(r"^\s*(?:uniform\s+)?[\w]+(?:\[\])?\s+([\w:]+)\s*=\s*(\[.*)$")


def read_brep_arrays(path):
    """Return one dict of attribute arrays per BrepArray prim in a .usda file."""
    prims, cur, pending = [], None, None
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if re.match(r"^\s*def\s+BrepArray\b", line):
            cur = {}
            prims.append(cur)
            continue
        if cur is None:
            continue
        if pending is not None:
            pending[1].append(line)
            text = "\n".join(pending[1])
            if text.count("[") == text.count("]"):
                cur[pending[0]] = _parse_value(text)
                pending = None
            continue
        m = _ATTR.match(line)
        if m:
            name, text = m.groups()
            if text.count("[") == text.count("]"):
                cur[name] = _parse_value(text)
            else:
                pending = (name, [text])
    return prims


def _parse_value(text):
    text = re.sub(r"(?<![\w.])-inf\b", "-1e309", text)
    text = re.sub(r"(?<![\w.\-])inf\b", "1e309", text)
    text = re.sub(r"\bnan\b", "0", text)
    return ast.literal_eval(text)


def compress_knots(flat):
    knots, mults = [], []
    for k in flat:
        if knots and abs(k - knots[-1]) <= 1e-12 * max(1.0, abs(k)):
            mults[-1] += 1
        else:
            knots.append(float(k))
            mults.append(1)
    return knots, mults


# ---------------------------------------------------------------------------
# BrepArray -> OCCT
# ---------------------------------------------------------------------------

def _occ():
    # imported lazily so `read_brep_arrays` works without OCP installed
    import OCP  # noqa: F401
    return True


def _pnt(p):
    from OCP.gp import gp_Pnt
    return gp_Pnt(float(p[0]), float(p[1]), float(p[2]))


def _dir(d):
    from OCP.gp import gp_Dir
    return gp_Dir(float(d[0]), float(d[1]), float(d[2]))


def _ax3(origin, axis, ref):
    from OCP.gp import gp_Ax3
    return gp_Ax3(_pnt(origin), _dir(axis), _dir(ref))


def _bspline_curve(cvs, weights, flat_knots, order):
    from OCP.collections import Array1_double as TColStd_Array1OfReal
    from OCP.collections import Array1_gp_Pnt as TColgp_Array1OfPnt
    from OCP.collections import Array1_int as TColStd_Array1OfInteger
    from OCP.Geom import Geom_BSplineCurve

    n = len(cvs)
    poles = TColgp_Array1OfPnt(1, n)
    for i, p in enumerate(cvs):
        poles.SetValue(i + 1, _pnt(p))
    knots, mults = compress_knots(flat_knots)
    kk = TColStd_Array1OfReal(1, len(knots))
    mm = TColStd_Array1OfInteger(1, len(mults))
    for i, (k, m) in enumerate(zip(knots, mults)):
        kk.SetValue(i + 1, k)
        mm.SetValue(i + 1, m)
    if weights and any(abs(w - 1.0) > 1e-12 for w in weights):
        ww = TColStd_Array1OfReal(1, n)
        for i, w in enumerate(weights):
            ww.SetValue(i + 1, float(w))
        return Geom_BSplineCurve(poles, ww, kk, mm, order - 1)
    return Geom_BSplineCurve(poles, kk, mm, order - 1)


def _bspline_surface(cvs, weights, uflat, vflat, uorder, vorder, nu, nv):
    from OCP.collections import Array1_double as TColStd_Array1OfReal
    from OCP.collections import Array1_int as TColStd_Array1OfInteger
    from OCP.collections import Array2_double as TColStd_Array2OfReal
    from OCP.collections import Array2_gp_Pnt as TColgp_Array2OfPnt
    from OCP.Geom import Geom_BSplineSurface

    poles = TColgp_Array2OfPnt(1, nu, 1, nv)
    for i in range(nu):
        for j in range(nv):
            poles.SetValue(i + 1, j + 1, _pnt(cvs[i * nv + j]))  # U-major

    def arr(flat):
        k, m = compress_knots(flat)
        kk = TColStd_Array1OfReal(1, len(k))
        mm = TColStd_Array1OfInteger(1, len(m))
        for i, (a, b) in enumerate(zip(k, m)):
            kk.SetValue(i + 1, a)
            mm.SetValue(i + 1, b)
        return kk, mm

    uk, um = arr(uflat)
    vk, vm = arr(vflat)
    if weights and any(abs(w - 1.0) > 1e-12 for w in weights):
        ww = TColStd_Array2OfReal(1, nu, 1, nv)
        for i in range(nu):
            for j in range(nv):
                ww.SetValue(i + 1, j + 1, float(weights[i * nv + j]))
        return Geom_BSplineSurface(poles, ww, uk, vk, um, vm, uorder - 1, vorder - 1)
    return Geom_BSplineSurface(poles, uk, vk, um, vm, uorder - 1, vorder - 1)


class _Packed:
    """Per-type sub-indexing: element i of a given type uses the k-th entry of
    that type's packed arrays, where k counts earlier elements of the same type."""

    def __init__(self, types):
        self.sub = []
        seen = {}
        for t in types:
            self.sub.append(seen.get(t, 0))
            seen[t] = seen.get(t, 0) + 1


def _edge_curves(a):
    """Return [(Geom_Curve | None, first, last)] per edge; None for degenerate edges."""
    from OCP.Geom import Geom_Circle, Geom_Ellipse, Geom_Line
    from OCP.gp import gp_Ax2, gp_Elips, gp_Circ

    types = a.get("edge:curveType", [])
    rng = a.get("edge:range", [])
    sub = _Packed(types).sub

    # NURBS offsets
    vcs = a.get("brep:edge3dNurb:curve3d:nurb:vertexCount", [])
    ords = a.get("brep:edge3dNurb:curve3d:nurb:order", [])
    cp_start, k_start = [0], [0]
    for vc, o in zip(vcs, ords):
        cp_start.append(cp_start[-1] + vc)
        k_start.append(k_start[-1] + vc + o)
    cps = a.get("brep:edge3dNurb:curve3d:nurb:controlVertices", [])
    knots = a.get("brep:edge3dNurb:curve3d:nurb:knots", [])
    wts = a.get("brep:edge3dNurb:curve3d:nurb:weights", [])

    out = []
    for e, t in enumerate(types):
        t0, t1 = float(rng[2 * e]), float(rng[2 * e + 1])
        if abs(t1 - t0) < 1e-12:
            out.append((None, t0, t1))
            continue
        s = sub[e]
        if t == "BrepCurve3dNurbAPI":
            vc, o = vcs[s], ords[s]
            pts = cps[cp_start[s]:cp_start[s] + vc]
            fk = knots[k_start[s]:k_start[s] + vc + o]
            w = wts[cp_start[s]:cp_start[s] + vc] if len(wts) >= cp_start[s] + vc else []
            if o == 2 and vc == 2 and not (w and any(abs(x - 1) > 1e-12 for x in w)):
                # straight segment: use an exact line with the same parameterisation
                p0, p1 = pts
                d = [p1[i] - p0[i] for i in range(3)]
                length = math.sqrt(sum(c * c for c in d))
                span = fk[-1] - fk[0]
                if length > 0 and abs(length / span - 1.0) < 1e-9:
                    u = [c / length for c in d]
                    loc = [p0[i] - u[i] * fk[0] for i in range(3)]
                    out.append((Geom_Line(_pnt(loc), _dir(u)), t0, t1))
                    continue
            out.append((_bspline_curve(pts, w, fk, o), t0, t1))
        elif t == "BrepCurve3dLineAPI":
            o = a["brep:edge3dLine:curve3d:line:origin"][s]
            d = a["brep:edge3dLine:curve3d:line:direction"][s]
            out.append((Geom_Line(_pnt(o), _dir(d)), t0, t1))
        elif t == "BrepCurve3dCircleAPI":
            c = a["brep:edge3dCircle:curve3d:circle:center"][s]
            ax = a["brep:edge3dCircle:curve3d:circle:axis"][s]
            rd = a["brep:edge3dCircle:curve3d:circle:refDirection"][s]
            r = a["brep:edge3dCircle:curve3d:circle:radius"][s]
            out.append((Geom_Circle(gp_Circ(gp_Ax2(_pnt(c), _dir(ax), _dir(rd)), float(r))), t0, t1))
        elif t == "BrepCurve3dEllipseAPI":
            c = a["brep:edge3dEllipse:curve3d:ellipse:center"][s]
            ax = a["brep:edge3dEllipse:curve3d:ellipse:axis"][s]
            rd = a["brep:edge3dEllipse:curve3d:ellipse:refDirection"][s]
            rx = a["brep:edge3dEllipse:curve3d:ellipse:xRadius"][s]
            ry = a["brep:edge3dEllipse:curve3d:ellipse:yRadius"][s]
            out.append((Geom_Ellipse(gp_Elips(gp_Ax2(_pnt(c), _dir(ax), _dir(rd)), float(rx), float(ry))), t0, t1))
        else:
            raise ValueError(f"unsupported edge curve type {t}")
    return out


def _face_surfaces(a):
    from OCP.Geom import (Geom_ConicalSurface, Geom_CylindricalSurface, Geom_Plane,
                          Geom_SphericalSurface, Geom_ToroidalSurface)

    types = a.get("face:surfaceType", [])
    sub = _Packed(types).sub
    nu_l = a.get("brep:surface:nurb:uVertexCount", [])
    nv_l = a.get("brep:surface:nurb:vVertexCount", [])
    uo_l = a.get("brep:surface:nurb:uOrder", [])
    vo_l = a.get("brep:surface:nurb:vOrder", [])
    cp0, uk0, vk0 = [0], [0], [0]
    for nu, nv, uo, vo in zip(nu_l, nv_l, uo_l, vo_l):
        cp0.append(cp0[-1] + nu * nv)
        uk0.append(uk0[-1] + nu + uo)
        vk0.append(vk0[-1] + nv + vo)
    cps = a.get("brep:surface:nurb:controlVertices", [])
    uk = a.get("brep:surface:nurb:uKnots", [])
    vk = a.get("brep:surface:nurb:vKnots", [])
    wts = a.get("brep:surface:nurb:weights", [])

    def g(kind, name, s):
        return a[f"brep:surface:{kind}:{name}"][s]

    out = []
    for f, t in enumerate(types):
        s = sub[f]
        if t == "BrepSurfacePlaneAPI":
            out.append(Geom_Plane(_ax3(g("plane", "origin", s), g("plane", "axis", s), g("plane", "refDirection", s))))
        elif t == "BrepSurfaceCylinderAPI":
            out.append(Geom_CylindricalSurface(
                _ax3(g("cylinder", "origin", s), g("cylinder", "axis", s), g("cylinder", "refDirection", s)),
                float(g("cylinder", "radius", s))))
        elif t == "BrepSurfaceConeAPI":
            ax3 = _ax3(g("cone", "origin", s), g("cone", "axis", s), g("cone", "refDirection", s))
            angle, radius = float(g("cone", "semiAngle", s)), float(g("cone", "radius", s))
            if abs(angle) < 1e-12:
                # the kernel writes some cylinders (e.g. fillet faces) as zero-angle cones
                out.append(Geom_CylindricalSurface(ax3, radius))
            else:
                out.append(Geom_ConicalSurface(ax3, angle, radius))
        elif t == "BrepSurfaceSphereAPI":
            out.append(Geom_SphericalSurface(
                _ax3(g("sphere", "center", s), g("sphere", "axis", s), g("sphere", "refDirection", s)),
                float(g("sphere", "radius", s))))
        elif t == "BrepSurfaceTorusAPI":
            out.append(Geom_ToroidalSurface(
                _ax3(g("torus", "origin", s), g("torus", "axis", s), g("torus", "refDirection", s)),
                float(g("torus", "majorRadius", s)), float(g("torus", "minorRadius", s))))
        elif t == "BrepSurfaceNurbAPI":
            nu, nv, uo, vo = nu_l[s], nv_l[s], uo_l[s], vo_l[s]
            w = wts[cp0[s]:cp0[s] + nu * nv] if len(wts) >= cp0[s] + nu * nv else []
            out.append(_bspline_surface(cps[cp0[s]:cp0[s] + nu * nv], w,
                                        uk[uk0[s]:uk0[s] + nu + uo], vk[vk0[s]:vk0[s] + nv + vo],
                                        uo, vo, nu, nv))
        else:
            raise ValueError(f"unsupported surface type {t}")
    return out


def brep_arrays_to_shape(a):
    """Build a TopoDS shape (solid if closed) from one BrepArray's arrays."""
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
    from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape
    from OCP.TopAbs import TopAbs_FACE, TopAbs_FORWARD, TopAbs_REVERSED, TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS, TopoDS_Edge, TopoDS_Face, TopoDS_Shell, TopoDS_Vertex, TopoDS_Wire

    tol = float((a.get("brep:intersectTol3d") or [1e-5])[0]) or 1e-5
    tol = max(tol, 1e-7)
    bb = BRep_Builder()

    verts = []
    for p in a.get("brep:vertexPoint:point:position", []):
        v = TopoDS_Vertex()
        bb.MakeVertex(v, _pnt(p), tol)
        verts.append(v)

    vidx = a.get("edge:vertexIndices", [])
    edges = []
    for e, (curve, t0, t1) in enumerate(_edge_curves(a)):
        if curve is None:
            edges.append(None)
            continue
        E = TopoDS_Edge()
        bb.MakeEdge(E, curve, tol)
        bb.Range(E, t0, t1)
        i0, i1 = vidx[e]
        bb.Add(E, verts[i0].Oriented(TopAbs_FORWARD))
        bb.Add(E, verts[i1].Oriented(TopAbs_REVERSED))
        edges.append(E)

    surfaces = _face_surfaces(a)
    loop_counts = a.get("face:loopCount", [])
    eu_counts = a.get("loop:edgeuseCount", [])
    eu_edge = a.get("edgeuse:edgeIndex", [])
    eu_orient = a.get("edgeuse:orientationType", [])

    faces = []
    loop = eu = 0
    for f, surf in enumerate(surfaces):
        F = TopoDS_Face()
        bb.MakeFace(F, surf, tol)
        for _ in range(loop_counts[f]):
            n = eu_counts[loop]
            loop += 1
            if n == 0:
                continue
            W = TopoDS_Wire()
            bb.MakeWire(W)
            for k in range(eu, eu + n):
                E = edges[eu_edge[k]]
                if E is None:
                    continue  # degenerate pole edge: ShapeFix rebuilds it
                same = k >= len(eu_orient) or eu_orient[k] == "same"
                bb.Add(W, E.Oriented(TopAbs_FORWARD if same else TopAbs_REVERSED))
            eu += n
            bb.Add(F, W)
        fix = ShapeFix_Face(F)
        fix.SetPrecision(tol)
        fix.SetMaxTolerance(max(1e-3, tol * 100))
        fix.Perform()
        faces.append(fix.Face())

    sew = BRepBuilderAPI_Sewing(max(tol * 10, 1e-6))
    for F in faces:
        sew.Add(F)
    sew.Perform()
    sewn = sew.SewedShape()

    shells = []
    ex = TopExp_Explorer(sewn, TopAbs_SHELL)
    while ex.More():
        shells.append(TopoDS.Shell(ex.Current()))
        ex.Next()
    if not shells:
        # sewing a single face (a sphere, a torus) returns the bare face
        sh = TopoDS_Shell()
        bb.MakeShell(sh)
        ex = TopExp_Explorer(sewn, TopAbs_FACE)
        while ex.More():
            bb.Add(sh, ex.Current())
            ex.Next()
        sh.Closed(BRep_Tool.IsClosed_s(sh))
        shells = [sh]
    shape = sewn
    if shells and all(BRep_Tool.IsClosed_s(s) for s in shells):
        ms = BRepBuilderAPI_MakeSolid()
        for s in shells:
            ms.Add(s)
        shape = ms.Solid()

    fixer = ShapeFix_Shape(shape)
    fixer.SetPrecision(tol)
    fixer.SetMaxTolerance(max(1e-3, tol * 100))
    fixer.Perform()
    return fixer.Shape()


def shape_report(shape):
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    def count(t):
        ex, n = TopExp_Explorer(shape, t), 0
        while ex.More():
            n += 1
            ex.Next()
        return n

    p = GProp_GProps()
    # adaptive integration: the default fixed-order rule is ~0.1% off on rational boundaries
    BRepGProp.VolumeProperties_s(shape, p, 1e-9)
    return {"valid": bool(BRepCheck_Analyzer(shape).IsValid()), "volume": p.Mass(),
            "solids": count(TopAbs_SOLID), "faces": count(TopAbs_FACE)}


# ---------------------------------------------------------------------------
# STEP
# ---------------------------------------------------------------------------

def export_step(usd_files, out_path, names=None):
    from OCP.BRep import BRep_Builder
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopoDS import TopoDS_Compound

    reports, shapes = [], []
    for path in usd_files:
        for arrays in read_brep_arrays(path):
            s = brep_arrays_to_shape(arrays)
            shapes.append(s)
            reports.append(shape_report(s))
    if not shapes:
        raise ValueError("no BRep bodies to export")

    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w = STEPControl_Writer()
    if len(shapes) == 1:
        w.Transfer(shapes[0], STEPControl_AsIs)
    else:
        comp = TopoDS_Compound()
        bb = BRep_Builder()
        bb.MakeCompound(comp)
        for s in shapes:
            bb.Add(comp, s)
        w.Transfer(comp, STEPControl_AsIs)
    if w.Write(str(out_path)) != IFSelect_RetDone:
        raise RuntimeError("OpenCASCADE could not write the STEP file")
    return reports


def import_step(step_path, out_dir):
    """Write one OCCT .brep per solid (or per shell/face group if there are none)."""
    from OCP.BRepTools import BRepTools
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.ShapeFix import ShapeFix_Shape
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    r = STEPControl_Reader()
    if r.ReadFile(str(step_path)) != IFSelect_RetDone:
        raise ValueError("not a readable STEP file")
    r.TransferRoots()
    root = r.OneShape()
    fix = ShapeFix_Shape(root)
    fix.Perform()
    root = fix.Shape()

    parts = []
    for kind in (TopAbs_SOLID, TopAbs_SHELL):
        ex = TopExp_Explorer(root, kind)
        while ex.More():
            parts.append(ex.Current())
            ex.Next()
        if parts:
            break
    if not parts:
        raise ValueError("the STEP file contains no solids or shells")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    result = []
    for i, s in enumerate(parts):
        p = out_dir / f"part_{i}.brep"
        BRepTools.Write_s(s, str(p))
        result.append({"brep": str(p), **shape_report(s)})
    return result


def to_nurbs(in_brep, out_brep):
    """Rewrite a part with every surface as NURBS (fallback for parts whose
    analytic faces the v1.0.0 converter mis-translates, such as pointed cones)."""
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
    from OCP.BRepTools import BRepTools
    from OCP.TopoDS import TopoDS_Shape

    s = TopoDS_Shape()
    BRepTools.Read_s(s, str(in_brep), BRep_Builder())
    BRepTools.Write_s(BRepBuilderAPI_NurbsConvert(s, True).Shape(), str(out_brep))
    return {"brep": str(out_brep)}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if argv[:1] == ["export"]:
            out = {"ok": True, "bodies": export_step(argv[2:], argv[1])}
        elif argv[:1] == ["import"]:
            out = {"ok": True, "parts": import_step(argv[1], argv[2])}
        elif argv[:1] == ["nurbs"]:
            out = {"ok": True, **to_nurbs(argv[1], argv[2])}
        else:
            raise SystemExit("usage: occt_bridge export OUT.step IN.usda... | import IN.step OUTDIR"
                             " | nurbs IN.brep OUT.brep")
    except Exception as e:  # reported to the caller as JSON
        out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print("@@RESULT@@" + json.dumps(out))


if __name__ == "__main__":
    main()
