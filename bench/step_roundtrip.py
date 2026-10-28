"""STEP robustness benchmark for ScriptCAD's import/export pipeline.

For every STEP file under the given folders it runs, in a fresh process with a
timeout (so a crash or a hang only loses that file):

  occt      OpenCASCADE reads the file: solid count, validity, volume
  convert   step_io.step_to_usd: occt_to_usd per solid, NURBS-fallback retry
  kernel    usd_brep imports each part: manifold?, volume vs OpenCASCADE
  boolean   kernel subtracts a small cylinder at the bbox center; the same cut
            is done in OpenCASCADE as the reference volume
  export    kernel body -> BrepArray .usda -> step_io.usd_to_step: BRepCheck
            validity and volume, then the written STEP is read back
  nvidia    (diagnostic) the same .usda through NVIDIA's usd_to_occt, checked
            with BRepCheck in its own process (it can crash OpenCASCADE)

Usage (from the repo root, in the dev venv with cadquery-ocp):

    python bench/step_roundtrip.py [LABEL=]CORPUS_DIR ... --out bench/results
    python bench/step_roundtrip.py --summarize bench/results/results.json

Writes results.json (one record per file), results.csv (one row per part) and
summary.md (pass rates and failure categories) into --out.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SNAP = "@@SNAP@@"
REL_TOL = 1e-3  # volume agreement counted as a pass
MAX_PARTS = 25  # per file, for the kernel/boolean/export stages


def _now():
    return time.perf_counter()


def _rel(a, b):
    if a is None or b is None or not b:
        return None
    return abs(abs(a) - abs(b)) / abs(b)


def _short(msg, n=600):
    """Drop OpenUSD's harmless python-module warnings and keep the tail."""
    lines = [ln for ln in str(msg).splitlines()
             if ln.strip() and "_LoadLibModules" not in ln and "No module named 'pxr'" not in ln]
    return " | ".join(lines)[-n:]


def _run_tree(args, timeout):
    """Run this script with `args`; on timeout kill the whole process tree (a venv's
    python.exe is a launcher, and the converters are grandchildren that would keep
    the pipes open). Returns (returncode | None on timeout, stdout, stderr)."""
    proc = subprocess.Popen([sys.executable, "-I", __file__, *map(str, args)], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
        else:
            proc.kill()
        try:
            out, err = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            out, err = "", ""
        return None, out, err


def _scrub(text):
    """Replace the home folder (and with it the temp folders) in error messages."""
    home = str(Path.home())
    for h in {home, home.replace("\\", "/"), home.replace("\\", "\\\\")}:
        text = text.replace(h, "~")
    return text


def _snaps(out):
    return [json.loads(ln[len(SNAP):]) for ln in out.splitlines() if ln.startswith(SNAP)]


def _sub(args, timeout):
    """Run a helper process; return (result | None, error string | None)."""
    code, out, err = _run_tree(args, timeout)
    snaps = _snaps(out)
    if code == 0 and snaps:
        return snaps[-1], None
    why = f"timeout after {timeout}s" if code is None else f"crash (exit {code}): {_short(err, 300)}"
    return (snaps[-1] if snaps else None), why


# ---------------------------------------------------------------------------
# OpenCASCADE helpers (own process: OCCT never shares a process with the kernel)
# ---------------------------------------------------------------------------

def occt_refs(spec_path):
    """OpenCASCADE reference values per part.

    BRepGProp's volume integral is not always right (it is ~0.3% off on some
    surfaces of extrusion), so besides the plain integral we record it on the
    NURBS-converted shape and the enclosed volume of an OCCT mesh. The boolean
    reference cuts the part with the same cylinder as the kernel stage.
    """
    from OCP.BRep import BRep_Builder
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.BRepTools import BRepTools
    from OCP.GProp import GProp_GProps
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.TopoDS import TopoDS_Shape

    from scriptcad.occt_bridge import shape_report

    def guard(fn):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            return {"error": f"{type(e).__name__}: {e}"}

    def nurbs_volume(s):
        p = GProp_GProps()
        BRepGProp.VolumeProperties_s(BRepBuilderAPI_NurbsConvert(s, True).Shape(), p, 1e-9)
        return p.Mass()

    def mesh_volume(s, diag):
        BRepMesh_IncrementalMesh(s, 1e-4 * diag, False, 0.1, True)
        p = GProp_GProps()
        BRepGProp.VolumeProperties_s(s, p, False, False, True)  # from the triangulation
        return p.Mass()

    def cut(s, job):
        cx, cy, z0 = job["base"]
        cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(cx, cy, z0), gp_Dir(0, 0, 1)), job["r"], job["h"]).Shape()
        op = BRepAlgoAPI_Cut(s, cyl)
        if not op.IsDone():
            raise RuntimeError("BRepAlgoAPI_Cut failed")
        return shape_report(op.Shape())

    out = []
    for job in json.loads(Path(spec_path).read_text()):
        s = TopoDS_Shape()
        BRepTools.Read_s(s, job["brep"], BRep_Builder())
        ref = {"part": job["part"], "nurbs_volume": guard(lambda: nurbs_volume(s))}
        if job.get("base"):
            ref["cut"] = guard(lambda: cut(s, job))
        ref["mesh_volume"] = guard(lambda: mesh_volume(s, job["diag"]))  # last: meshing changes `s`
        out.append(ref)
        print(SNAP + json.dumps(out), flush=True)  # keep what we have if a later part crashes
    return out


def occt_check(brep_path):
    """Inspect a .brep written by NVIDIA's usd_to_occt."""
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepTools import BRepTools
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS, TopoDS_Shape

    from scriptcad.occt_bridge import shape_report

    s = TopoDS_Shape()
    if not BRepTools.Read_s(s, str(brep_path), BRep_Builder()):
        raise RuntimeError("could not read .brep")
    faces = null_surface = no_pcurve = edge_uses = 0
    fx = TopExp_Explorer(s, TopAbs_FACE)
    while fx.More():
        f = TopoDS.Face(fx.Current())
        faces += 1
        if BRep_Tool.Surface_s(f) is None:
            null_surface += 1
        ex = TopExp_Explorer(f, TopAbs_EDGE)
        while ex.More():
            edge_uses += 1
            if BRep_Tool.CurveOnSurface_s(TopoDS.Edge(ex.Current()), f, 0.0, 1.0) is None:
                no_pcurve += 1
            ex.Next()
        fx.Next()
    res = {"faces": faces, "null_surface_faces": null_surface,
           "edge_uses": edge_uses, "edge_uses_without_pcurve": no_pcurve}
    print(SNAP + json.dumps(res), flush=True)  # survives a BRepCheck crash below
    if null_surface:
        res["valid"] = False  # BRepCheck dereferences the null surface and crashes
    else:
        res.update(shape_report(s))
    return res


def mesh_volume(sm, body):
    lo, hi = body.bounding_box()
    diag = sum((hi[k] - lo[k]) ** 2 for k in range(3)) ** 0.5
    poly, report = sm.tessellate(body, chord_height_tolerance=2e-4 * diag, surface_angle_tolerance_deg=5.0,
                                 allow_partial=True, return_report=True)
    if isinstance(report, dict) and report.get("face_failures"):
        raise RuntimeError(f"{len(report['face_failures'])} face(s) failed to tessellate")
    a = poly.to_mesh_arrays()
    pts, stream = a["points"], a["faces"]
    vol, i = 0.0, 0
    while i < len(stream):
        n = stream[i]
        idx = stream[i + 1:i + 1 + n]
        x0, y0, z0 = pts[idx[0]]
        for k in range(1, n - 1):
            x1, y1, z1 = pts[idx[k]]
            x2, y2, z2 = pts[idx[k + 1]]
            vol += x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2)
        i += n + 1
    return vol / 6.0


def apply_refs(p, ref):
    """Fold the OpenCASCADE references into a part's record and (re)compute its errors.

    A volume matches OpenCASCADE if it is within REL_TOL of either OCCT integral
    (plain or on the NURBS-converted shape): when those two disagree, OCCT's own
    integration is the uncertain side. The boolean is judged on the removed
    volume, so an integration error common to both sides cancels.
    """
    for key in ("nurbs_volume", "mesh_volume"):
        v = ref.get(key)
        if isinstance(v, (int, float)):
            p["occt_" + key] = v
        elif isinstance(v, dict):
            p["occt_" + key + "_error"] = v.get("error")
    refs = [v for v in (p.get("occt_volume"), p.get("occt_nurbs_volume")) if v]
    p["occt_ref_spread"] = _rel(p.get("occt_nurbs_volume"), p.get("occt_volume"))

    def err(v):
        es = [e for e in (_rel(v, r) for r in refs) if e is not None]
        return min(es) if es else None

    p["kernel_rel_err"] = err(p.get("kernel_volume"))
    p["mesh_rel_err"] = err(p.get("mesh_volume"))
    p["export_rel_err"] = err(p.get("export_volume"))
    p["reread_rel_err"] = err(p.get("reread_volume"))
    p["occt_mesh_rel_err"] = err(p.get("occt_mesh_volume"))
    c = ref.get("cut") or {}
    if "error" in c:
        p["boolean_ref_error"] = c["error"]
    elif c:
        p["boolean_ref_volume"], p["boolean_ref_valid"] = c["volume"], c["valid"]
        if p.get("boolean_volume") is not None and p.get("kernel_volume") is not None and p.get("occt_volume"):
            removed_k = abs(p["kernel_volume"]) - abs(p["boolean_volume"])
            removed_o = abs(p["occt_volume"]) - abs(c["volume"])
            p["boolean_rel_err"] = abs(removed_k - removed_o) / abs(p["occt_volume"])


# ---------------------------------------------------------------------------
# Per-file worker
# ---------------------------------------------------------------------------

def run_one(step_path, work, timeout):
    """Benchmark one STEP file. Prints a snapshot of the record after each stage."""
    import usd_brep as sm

    from scriptcad import kernel, occt_tools, step_io

    work = Path(work)
    rec = {"stage": "occt", "parts": []}

    def snap(stage, at=None):
        rec["stage"] = stage
        rec["at"] = at or stage  # what the worker is doing now (for timeouts)
        print(SNAP + json.dumps(rec), flush=True)

    snap("occt")

    # -- occt + convert, through the real step_io.step_to_usd ------------------
    attempts = defaultdict(list)  # part index -> [{kind, ok, seconds, error}]
    orig_bridge, orig_convert = step_io._bridge, step_io._occt_to_usd

    def spy_bridge(*args):
        t = _now()
        if args[0] == "nurbs":
            snap("convert", f"NURBS conversion of {Path(args[1]).stem}")
        try:
            out = orig_bridge(*args)
        except Exception as e:
            if args[0] == "import":
                rec["occt"] = {"ok": False, "seconds": _now() - t, "error": _short(e)}
            raise
        if args[0] == "import":
            ps = out["parts"]
            rec["occt"] = {"ok": True, "seconds": _now() - t, "parts": len(ps),
                           "solids": sum(p["solids"] for p in ps),
                           "volume": sum(p["volume"] for p in ps),
                           "all_valid": all(p["valid"] for p in ps)}
            rec["parts"] = [{"index": i, "occt_valid": p["valid"], "occt_solids": p["solids"],
                             "occt_faces": p["faces"], "occt_volume": p["volume"], "brep": p["brep"]}
                            for i, p in enumerate(ps)]
            snap("convert")
        return out

    def spy_convert(brep, usda):
        i = int(re.match(r"part_(\d+)", Path(usda).name).group(1))
        kind = "nurbs" if "_nurbs" in Path(usda).name else "exact"
        snap("convert", f"occt_to_usd part {i} ({kind})")
        t = _now()
        try:
            orig_convert(brep, usda)
        except Exception as e:
            attempts[i].append({"kind": kind, "step": "occt_to_usd", "seconds": _now() - t, "error": _short(e)})
            raise
        attempts[i].append({"kind": kind, "step": "occt_to_usd", "seconds": _now() - t})

    def check(usda):
        i = int(re.match(r"part_(\d+)", Path(usda).name).group(1))
        snap("convert", f"kernel load part {i} ({attempts[i][-1]['kind']})")
        try:
            kernel.inspect_usd(usda)
        except Exception as e:
            attempts[i].append({"kind": attempts[i][-1]["kind"], "step": "kernel_load", "error": _short(e)})
            raise

    step_io._bridge, step_io._occt_to_usd = spy_bridge, spy_convert
    t = _now()
    try:
        converted, _failed = step_io.step_to_usd(step_path, work / "in", check)
        rec["convert"] = {"ok": True, "seconds": _now() - t}
    except step_io.StepError as e:
        converted = []
        rec["convert"] = {"ok": False, "seconds": _now() - t, "error": _short(e)}
    finally:
        step_io._bridge, step_io._occt_to_usd = orig_bridge, orig_convert

    by_part = {int(re.match(r"part_(\d+)", Path(c["path"]).name).group(1)): c for c in converted}
    for p in rec["parts"]:
        c = by_part.get(p["index"])
        p["attempts"] = attempts.get(p["index"], [])
        p["converted"] = c is not None
        p["route"] = None if c is None else ("exact" if c["exact"] else "nurbs")
        if c is None:
            errs = [a["error"] for a in p["attempts"] if a.get("error")]
            p["convert_error"] = errs[0] if errs else "not attempted"
        else:
            p["usda"] = c["path"]
    snap("kernel")
    if not converted:
        snap("done")
        return rec

    # -- kernel / boolean / export, per part -----------------------------------
    ref_jobs = []
    for p in rec["parts"]:
        if not p["converted"]:
            continue
        if p["index"] >= MAX_PARTS:
            p["skipped"] = True
            continue
        idx = p["index"]
        t = _now()
        try:
            bodies = sm.usd.import_breps(p["usda"])
            body = bodies[0]
        except Exception as e:  # noqa: BLE001
            p["kernel_error"] = _short(e)
            continue
        p["kernel_bodies"] = len(bodies)
        p["kernel_faces"] = body.face_count()
        p["kernel_manifold"] = bool(body.is_manifold_solid())
        try:
            p["kernel_volume"] = body.volume(1e-6) if p["kernel_manifold"] else None
        except Exception as e:  # noqa: BLE001
            p["kernel_volume"], p["kernel_volume_error"] = None, _short(e)
        p["kernel_seconds"] = _now() - t
        p["kernel_rel_err"] = _rel(p["kernel_volume"], p["occt_volume"])
        try:  # independent of volume(): enclosed volume of the kernel's tessellation
            p["mesh_volume"] = mesh_volume(sm, body)
            p["mesh_rel_err"] = _rel(p["mesh_volume"], p["occt_volume"])
        except Exception as e:  # noqa: BLE001
            p["mesh_error"] = _short(e)
        snap(f"boolean part {idx}")

        # boolean: a through-cylinder at the bbox center, r = 10% of the smaller xy extent
        lo, hi = body.bounding_box()
        dx, dy, dz = (hi[k] - lo[k] for k in range(3))
        r = 0.1 * min(dx, dy)
        job = {"part": idx, "brep": p["brep"], "diag": (dx * dx + dy * dy + dz * dz) ** 0.5}
        ref_jobs.append(job)
        if r > 0 and dz > 0:
            base = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] - 0.1 * dz)
            h = 1.2 * dz
            job.update(base=base, r=r, h=h)
            t = _now()
            try:
                res = sm.boolean_difference(sm.brep_copy(body), sm.create_cylinder(base, r, h))
                p["boolean_ok"] = True
                p["boolean_manifold"] = bool(res.is_manifold_solid())
                p["boolean_volume"] = res.volume(1e-6) if p["boolean_manifold"] else None
            except Exception as e:  # noqa: BLE001
                p["boolean_ok"], p["boolean_error"] = False, _short(e)
            p["boolean_seconds"] = _now() - t
        else:
            p["boolean_ok"], p["boolean_error"] = None, "degenerate bbox"
        snap(f"export part {idx}")

        # export: kernel -> BrepArray .usda -> our OCCT builder -> STEP -> read back
        usda = work / f"out_{idx}.usda"
        sm.usd.export_brep(body, str(usda))
        t = _now()
        try:
            [rep] = step_io.usd_to_step([str(usda)], work / f"out_{idx}.step")
            p.update(export_ok=True, export_valid=rep["valid"], export_solids=rep["solids"],
                     export_volume=rep["volume"])
            back = step_io._bridge("import", work / f"out_{idx}.step", work / f"back_{idx}")["parts"]
            p["reread_volume"] = sum(b["volume"] for b in back)
            p["reread_valid"] = all(b["valid"] for b in back)
        except Exception as e:  # noqa: BLE001
            p["export_ok"], p["export_error"] = False, _short(e)
        p["export_seconds"] = _now() - t
        p["export_rel_err"] = _rel(p.get("export_volume"), p["occt_volume"])
        p["reread_rel_err"] = _rel(p.get("reread_volume"), p["occt_volume"])
        snap(f"nvidia part {idx}")

        # diagnostic: NVIDIA's usd_to_occt on the same .usda
        nv = work / f"nv_{idx}.brep"
        exe, env = occt_tools.tool("usd_to_occt")
        try:
            proc = subprocess.run([exe, str(usda), str(nv)], capture_output=True, text=True, env=env, timeout=120)
            if proc.returncode or not nv.exists():
                p["nv_error"] = f"usd_to_occt exit {proc.returncode}: {_short(proc.stderr or proc.stdout, 200)}"
            else:
                res, err = _sub(["--occt-check", nv], 120)
                p["nv"] = res
                if err:
                    p["nv_error"] = "BRepCheck " + err
        except subprocess.TimeoutExpired:
            p["nv_error"] = "usd_to_occt timeout"
        snap(f"kernel part {idx + 1}")

    if ref_jobs:
        snap("references")
        spec = work / "refs.json"
        spec.write_text(json.dumps(ref_jobs))
        refs, err = _sub(["--occt-refs", spec], max(60, timeout // 3))
        for p in rec["parts"]:
            if not any(j["part"] == p["index"] for j in ref_jobs):
                continue
            ref = next((r for r in refs or [] if r["part"] == p["index"]), None)
            if ref is None:
                p["ref_error"] = err or "missing"
                ref = {}
            apply_refs(p, ref)
    snap("done")
    return rec


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def bench_file(path, corpus, timeout, keep):
    work = Path(tempfile.mkdtemp(prefix="stepbench_"))
    t = _now()
    rec = {"stage": "start", "parts": []}
    status = "ok"
    try:
        code, out, err = _run_tree(["--one", path, work, timeout], timeout)
        snaps = _snaps(out)
        if snaps:
            rec = snaps[-1]
        if code is None:
            status = "timeout"
        elif code != 0 or rec.get("stage") != "done":
            status = "crash"
            rec["crash"] = f"exit {code}: {_short(err, 400)}"
    finally:
        if not keep:
            import shutil
            shutil.rmtree(work, ignore_errors=True)
    rec.update(file=str(path), name=path.name, corpus=corpus, bytes=path.stat().st_size,
               status=status, seconds=_now() - t)
    for p in rec["parts"]:
        p.pop("brep", None)
        p.pop("usda", None)
    return rec


def collect(dirs):
    files = []
    for d in dirs:
        label, _, path = d.rpartition("=") if "=" in d else ("", "", d)
        d = Path(path)
        for f in sorted(d.rglob("*")):
            if f.suffix.lower() in (".step", ".stp") and f.is_file():
                files.append((f, label or d.name))
    return files


def main_run(args):
    from scriptcad import occt_tools, step_io

    if not step_io.ocp_available():
        sys.exit('needs OpenCASCADE: pip install "scriptcad[step]"')
    occt_tools.install()
    files = collect(args.dirs)
    if args.limit:
        files = files[:args.limit]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"{len(files)} STEP files, {args.jobs} at a time, {args.timeout}s timeout each", flush=True)
    records = []
    with ThreadPoolExecutor(args.jobs) as pool:
        futs = {pool.submit(bench_file, f, c, args.timeout, args.keep): f for f, c in files}
        for n, fut in enumerate(as_completed(futs), 1):
            r = fut.result()
            records.append(r)
            with open(out / "partial.jsonl", "a", encoding="utf-8") as fh:  # survives an aborted run
                fh.write(json.dumps(r) + "\n")
            ok = sum(1 for p in r["parts"] if _part_pass(p, r))
            print(f"[{n}/{len(files)}] {r['corpus']}/{r['name']}: {r['status']} at {r['stage']}, "
                  f"{ok}/{len(r['parts'])} parts pass, {r['seconds']:.1f}s", flush=True)
    if args.retry:
        slow = [r for r in records if r["status"] == "timeout"]
        print(f"rerunning {len(slow)} timed-out files with {args.retry}s each", flush=True)
        with ThreadPoolExecutor(args.jobs) as pool:
            futs = {pool.submit(bench_file, Path(r["file"]), r["corpus"], args.retry, False): r for r in slow}
            for fut in as_completed(futs):
                r, x = futs[fut], fut.result()
                r["retry"] = {"status": x["status"], "at": x.get("at"), "seconds": x["seconds"],
                              "parts": len(x["parts"]), "passing": sum(_part_pass(q, x) for q in x["parts"])}
                print(f"retry {r['corpus']}/{r['name']}: {x['status']} at {x.get('at')}, {x['seconds']:.0f}s",
                      flush=True)
    records.sort(key=lambda r: (r["corpus"], r["name"]))
    meta = {**environment(), "timeout": args.timeout, "retry_timeout": args.retry}
    for r in records:
        r["file"] = f"{r['corpus']}/{Path(r['file']).name}"
    records = json.loads(_scrub(json.dumps(records)))
    (out / "results.json").write_text(json.dumps({"meta": meta, "files": records}, indent=1))
    write_outputs(meta, records, out)
    (out / "partial.jsonl").unlink(missing_ok=True)


def environment():
    import platform
    from importlib.metadata import version

    from scriptcad import occt_tools
    return {"date": time.strftime("%Y-%m-%d"), "platform": f"{platform.system()} {platform.machine()}",
            "python": platform.python_version(), "usd_brep": version("usd-brep"),
            "cadquery_ocp": version("cadquery-ocp"), "converters": occt_tools.VERSION}


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

CSV_COLS = ["corpus", "name", "bytes", "status", "stage", "at", "seconds", "index", "occt_valid", "occt_solids",
            "occt_faces", "occt_volume", "occt_nurbs_volume", "occt_mesh_volume", "occt_ref_spread", "converted", "route", "convert_error", "kernel_faces", "kernel_manifold",
            "kernel_volume", "kernel_rel_err", "mesh_volume", "mesh_rel_err", "kernel_seconds", "boolean_ok",
            "boolean_manifold", "boolean_volume", "boolean_ref_volume", "boolean_rel_err", "boolean_error",
            "boolean_seconds", "export_ok", "export_valid", "export_solids", "export_volume", "export_rel_err",
            "reread_volume", "reread_rel_err", "export_error", "export_seconds", "nv_valid",
            "nv_null_surface_faces", "nv_edge_uses_without_pcurve", "nv_error", "failure"]


def _part_pass(p, rec=None):
    return failure(p, rec) is None


def _unfinished(p):
    """True if the worker stopped before this part went through every stage."""
    if "converted" not in p:
        return True
    if not p["converted"] or p.get("skipped") or p.get("kernel_error"):
        return False
    return "nv" not in p and "nv_error" not in p


def _at(rec):
    """'occt_to_usd part 3 (exact)' -> 'occt_to_usd'; 'boolean part 0' -> 'boolean'."""
    return re.sub(r" (part|of) .*", "", rec.get("at") or rec.get("stage") or "?")


def failure(p, rec=None):
    """First failing stage of a part as a category string, or None if it passes."""
    if rec is not None and rec.get("status") in ("timeout", "crash") and _unfinished(p):
        return f"file {rec['status']} during {_at(rec)}"
    if not p.get("converted"):
        return "convert: " + categorize(p.get("convert_error", ""))
    if p.get("skipped"):
        return None  # not run through the kernel stages (part cap); counted separately
    if p.get("occt_solids") == 0:
        return "input is a shell, not a solid (solid checks do not apply)"
    if p.get("kernel_error"):
        return "kernel: " + categorize(p["kernel_error"])
    if "kernel_manifold" not in p:
        return "crash/timeout in kernel import"
    if not p["kernel_manifold"]:
        return "kernel: not a manifold solid"
    if p.get("kernel_rel_err") is None or p["kernel_rel_err"] > REL_TOL:
        m = p.get("mesh_rel_err")
        if m is not None and m <= 1e-2:
            return "kernel: volume() differs from OpenCASCADE, tessellation agrees"
        return "kernel: volume() and tessellation differ from OpenCASCADE"
    if "boolean_ok" not in p:
        return "crash/timeout in boolean"
    if p["boolean_ok"] is False:
        return "boolean: " + categorize(p.get("boolean_error", ""))
    if p["boolean_ok"] and not p.get("boolean_manifold"):
        return "boolean: result not manifold"
    if p["boolean_ok"] and p.get("boolean_rel_err") is not None and p["boolean_rel_err"] > REL_TOL:
        return "boolean: volume differs from OpenCASCADE cut"
    if "export_ok" not in p:
        return "crash/timeout in export"
    if not p["export_ok"]:
        return "export: " + categorize(p.get("export_error", ""))
    if not p.get("export_valid"):
        return "export: OpenCASCADE BRepCheck invalid"
    if p.get("export_rel_err") is None or p["export_rel_err"] > REL_TOL:
        return "export: volume differs"
    return None


def categorize(msg):
    m = str(msg)
    m = re.sub(r"\(first attempt:.*", "", m)
    m = re.sub(r"Kernel trace:.*", "", m)
    m = re.sub(r"[A-Za-z]:[\\/][^\s:'\"]+", "<path>", m)
    m = re.sub(r"/[\w./-]+\.(usda|brep|step)", "<path>", m)
    m = re.sub(r"0x[0-9a-fA-F]+", "<hex>", m)
    m = re.sub(r"-?\d+(\.\d+)?(e[-+]?\d+)?", "N", m)
    m = re.sub(r"^part N: ", "", m)
    return m.strip(" |.;")[:110] or "(no message)"


def _pct(n, d):
    return f"{n}/{d} ({100 * n / d:.0f}%)" if d else "0/0"


def _q(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


def write_outputs(meta, records, out):
    rows = []
    for r in records:
        base = {k: r.get(k) for k in ("corpus", "name", "bytes", "status", "stage", "at", "seconds")}
        if not r["parts"]:
            reason = r.get("occt", {}).get("error") or r.get("crash") or r["status"]
            rows.append({**base, "failure": "occt: " + categorize(reason)})
        for p in r["parts"]:
            nv = p.get("nv") or {}
            rows.append({**base, **{k: p.get(k) for k in CSV_COLS if k in p}, "nv_valid": nv.get("valid"),
                         "nv_null_surface_faces": nv.get("null_surface_faces"),
                         "nv_edge_uses_without_pcurve": nv.get("edge_uses_without_pcurve"),
                         "failure": failure(p, r) or ""})
    with open(out / "results.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, CSV_COLS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    (out / "summary.md").write_text(summarize(meta, records), encoding="utf-8")
    print(f"wrote {out / 'results.json'}, results.csv, summary.md")


def _file_pass(r):
    return r["status"] == "ok" and bool(r["parts"]) and all(_part_pass(p, r) for p in r["parts"])


def summarize(meta, records):
    L = [f"# STEP benchmark summary ({meta['date']})", "",
         f"usd-brep {meta['usd_brep']}, converters {meta['converters']}, cadquery-ocp {meta['cadquery_ocp']}, "
         f"Python {meta['python']}, {meta['platform']}. Per-file budget {meta.get('timeout', '?')}s. "
         f"Volume tolerance {REL_TOL:g} (relative).", "",
         "Part-level rates count only parts of files that finished (no timeout or crash); "
         "parts beyond the first %d of a file are not run through the kernel stages." % MAX_PARTS, ""]
    for corpus in sorted({r["corpus"] for r in records}) + ["ALL"]:
        rs = [r for r in records if corpus in ("ALL", r["corpus"])]
        done = [r for r in rs if r["status"] == "ok"]
        ps = [p for r in done for p in r["parts"] if not p.get("skipped") and p.get("occt_solids") != 0]
        shells = [p for r in done for p in r["parts"] if not p.get("skipped") and p.get("occt_solids") == 0]
        conv = [p for p in ps if p.get("converted")]
        kern = [p for p in conv if "kernel_manifold" in p]
        man = [p for p in kern if p["kernel_manifold"]]
        volok = [p for p in man if p.get("kernel_rel_err") is not None and p["kernel_rel_err"] <= REL_TOL]
        meshok = [p for p in kern if p.get("mesh_rel_err") is not None and p["mesh_rel_err"] <= 1e-2]
        boo = [p for p in kern if p.get("boolean_ok") is not None]
        boook = [p for p in boo if p["boolean_ok"] and p.get("boolean_manifold")]
        boovol = [p for p in boook if p.get("boolean_rel_err") is not None and p["boolean_rel_err"] <= REL_TOL]
        exp = [p for p in kern if "export_ok" in p]
        expvalid = [p for p in exp if p.get("export_valid")]
        expvol = [p for p in expvalid if p.get("export_rel_err") is not None and p["export_rel_err"] <= REL_TOL]
        nvs = [p for p in kern if "nv" in p or "nv_error" in p]
        nvok = [p for p in nvs if (p.get("nv") or {}).get("valid")]
        nvcrash = [p for p in nvs if "crash" in (p.get("nv_error") or "")]
        bad = [r for r in rs if r["status"] != "ok"]
        L += [f"## {corpus}", "",
              "| stage | pass |", "|---|---|",
              f"| files | {len(rs)} |",
              f"| OpenCASCADE reads file | {_pct(sum(1 for r in rs if r.get('occt', {}).get('ok')), len(rs))} |",
              f"| files finished within budget | {_pct(len(done), len(rs))} |",
              f"| &nbsp;&nbsp;timed out / crashed | {sum(r['status'] == 'timeout' for r in rs)} / "
              f"{sum(r['status'] == 'crash' for r in rs)} ({sum(len(r['parts']) for r in bad)} parts) |",
              f"| **files whose every part passes every stage** | **{_pct(sum(map(_file_pass, rs)), len(rs))}** |",
              f"| solid parts in finished files | {len(ps)} (+{len(shells)} shell-only parts, "
              f"+{sum(1 for r in done for p in r['parts'] if p.get('skipped'))} beyond the {MAX_PARTS}-part cap) |",
              f"| parts OpenCASCADE-valid | {_pct(sum(1 for p in ps if p.get('occt_valid')), len(ps))} |",
              f"| &nbsp;&nbsp;OCCT plain vs NURBS-converted volume integral differ by > {REL_TOL:g} | "
              f"{sum(1 for p in ps if (p.get('occt_ref_spread') or 0) > REL_TOL)} |",
              f"| converted to kernel (any route) | {_pct(len(conv), len(ps))} |",
              f"| &nbsp;&nbsp;exact route / NURBS fallback | {sum(p.get('route') == 'exact' for p in conv)} / "
              f"{sum(p.get('route') == 'nurbs' for p in conv)} |",
              f"| kernel: manifold solid | {_pct(len(man), len(ps))} |",
              f"| kernel: volume() within {REL_TOL:g} of OpenCASCADE | {_pct(len(volok), len(ps))} |",
              f"| kernel: tessellation volume within 1e-2 (diagnostic) | {_pct(len(meshok), len(kern))} |",
              f"| boolean: succeeds, manifold result | {_pct(len(boook), len(boo))} |",
              f"| boolean: volume within {REL_TOL:g} of OpenCASCADE cut | {_pct(len(boovol), len(boo))} |",
              f"| export: valid STEP solid | {_pct(len(expvalid), len(exp))} |",
              f"| export: valid and volume within {REL_TOL:g} | {_pct(len(expvol), len(exp))} |",
              f"| NVIDIA usd_to_occt: BRepCheck-valid (diagnostic) | {_pct(len(nvok), len(nvs))} |",
              f"| NVIDIA usd_to_occt: BRepCheck crashes (diagnostic) | {_pct(len(nvcrash), len(nvs))} |",
              f"| **parts passing every stage** | **{_pct(sum(_part_pass(p) for p in ps), len(ps))}** |", ""]
        errs = [p["kernel_rel_err"] for p in man if p.get("kernel_rel_err") is not None]
        if errs:
            bins = [(0, 1e-9), (1e-9, 1e-6), (1e-6, 1e-4), (1e-4, 1e-3), (1e-3, 1e-2), (1e-2, float("inf"))]
            L += ["Kernel volume() vs OpenCASCADE (manifold parts):", "",
                  "| relative error | parts |", "|---|---|"]
            for a, b in bins:
                L.append(f"| [{a:g}, {b:g}) | {sum(a <= e < b for e in errs)} |")
            L += ["", f"median {_q(errs, .5):.2e}, p90 {_q(errs, .9):.2e}, max {max(errs):.2e}", ""]
        secs = [r["seconds"] for r in done]
        if secs:
            L += [f"Wall time of finished files: median {_q(secs, .5):.1f}s, p90 {_q(secs, .9):.1f}s, "
                  f"max {max(secs):.1f}s", ""]
        cats, examples = Counter(), {}
        for r in rs:
            if not r["parts"]:
                c = "occt: " + categorize(r.get("occt", {}).get("error") or r.get("crash") or r["status"])
                cats[c] += 1
                examples.setdefault(c, r["name"])
            for p in r["parts"]:
                c = failure(p, r)
                if c:
                    cats[c] += 1
                    route = f" ({p['route']})" if p.get("route") else ""
                    examples.setdefault(c, f"{r['name']} part {p['index']}{route}")
        if cats:
            L += ["| failure (first failing stage) | parts | example |", "|---|---|---|"]
            for c, n in cats.most_common():
                L.append(f"| {c.replace('|', '/')} | {n} | {examples[c]} |")
            L.append("")
    retried = [r for r in records if r.get("retry")]
    if retried:
        L += ["## Timed-out files rerun with a longer budget", "",
              "| file | parts | stopped at (first run) | rerun result | rerun time | parts passing |",
              "|---|---|---|---|---|---|"]
        for r in retried:
            x = r["retry"]
            where = f" at {x['at']}" if x["status"] != "ok" else ""
            L.append(f"| {r['corpus']}/{r['name']} | {len(r['parts']) or '?'} | {r.get('at')} | "
                     f"{x['status']}{where} | {x['seconds']:.0f}s | {x['passing']}/{x['parts']} |")
        L.append("")
    return "\n".join(L) + "\n"


def main():
    if sys.argv[1:2] == ["--one"]:
        run_one(sys.argv[2], sys.argv[3], int(sys.argv[4]))
        sys.stdout.flush()
        os._exit(0)  # skip interpreter/kernel teardown, which can hang
    if sys.argv[1:2] == ["--occt-refs"]:
        print(SNAP + json.dumps(occt_refs(sys.argv[2])), flush=True)
        return
    if sys.argv[1:2] == ["--occt-check"]:
        print(SNAP + json.dumps(occt_check(sys.argv[2])), flush=True)
        return
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dirs", nargs="*", help="[LABEL=]FOLDER, searched recursively for .step/.stp files")
    ap.add_argument("--out", default="bench/results")
    ap.add_argument("--timeout", type=int, default=300, help="seconds per file")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 3))
    ap.add_argument("--retry", type=int, metavar="SECONDS", help="rerun timed-out files with this budget")
    ap.add_argument("--limit", type=int, help="only the first N files")
    ap.add_argument("--keep", action="store_true", help="keep each file's work folder")
    ap.add_argument("--summarize", metavar="RESULTS_JSON", help="rebuild csv/summary from a results.json")
    args = ap.parse_args()
    if args.summarize:
        data = json.loads(Path(args.summarize).read_text())
        write_outputs(data["meta"], data["files"], Path(args.summarize).parent)
    elif args.dirs:
        main_run(args)
    else:
        ap.error("give at least one corpus folder")


if __name__ == "__main__":
    main()
