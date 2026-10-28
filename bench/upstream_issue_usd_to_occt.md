<!-- DRAFT, not filed. Target: https://github.com/NVIDIA-Omniverse/usd-brep/issues -->

# `usd_to_occt`: output from kernel-exported USD has no pcurves on curved faces and null surfaces for zero-angle cones, and `BRepCheck_Analyzer` crashes on it

## Summary

When a body made with the `usd_brep` kernel is written with `usd_brep.usd.export_brep`/`export_breps` and then converted with `usd_to_occt`, the `.brep` that comes out is not a valid OpenCASCADE shape for anything except planar bodies:

1. **No pcurves on non-planar faces.** `export_brep` writes no 2D trim curves (`brep:curveUv:*`), and `usd_to_occt` does not compute them when they are missing. Every edge use on a cylinder, cone, sphere, torus or NURBS face has no curve-on-surface. `BRepCheck_Analyzer` reports the shape as invalid, and OCCT's volume is wrong (a cylinder comes back with 1/3 of its volume, a sphere with 0).
2. **Null surfaces for zero-angle cones.** The kernel still writes the cylindrical faces of fillets as `BrepSurfaceConeAPI` with `semiAngle = 0` (#14 fixed this for `create_cylinder` in 1.0.1, but not for fillets). `usd_to_occt` writes those as OCCT conical surfaces (record type `3 ... 0`) with a zero semi-angle. OCCT cannot build a `Geom_ConicalSurface` with a zero angle, so after `BRepTools::Read` those faces have a null surface.
3. **Crash.** Running `BRepCheck_Analyzer` on a shape with those null-surface faces dereferences the null surface and kills the process (access violation, exit 139 under Git Bash), so a caller can't even find out that the shape is invalid.

`usd_to_occt` exits with code 0 and prints `1 wrote, 0 failed` in every case below.

This is related to #5, which was closed because the attachment was missing. The inputs here come from the kernel's own exporter rather than from `occt_to_usd`, and the reproducer needs no attachments.

## Environment

- `usd-brep` 1.0.1 wheel (PyPI), CPython 3.12.10, Windows 11 x64
- `usd_to_occt` from the usd-brep **v1.0.0** source release (prebuilt `USDBrep_jll` v1.0.0+0, x86_64-w64-mingw32). I could not find a 1.0.1 build of the converters. If 1.0.1 already fixes this, please close.
- OpenCASCADE 8.0.1 (`cadquery-ocp` 8.0.1.1.0) to read and check the output

## Reproduce

```python
import subprocess, usd_brep as sm

def make(name, body):
    sm.usd.export_brep(body, f"{name}.usda")
    subprocess.run(["usd_to_occt", f"{name}.usda", f"{name}.brep"], check=True)

make("box", sm.create_box((0, 0, 0), 20, 10, 5))
make("cylinder", sm.create_cylinder((0, 0, 0), 5, 10))
make("sphere", sm.create_sphere((0, 0, 0), 7))
make("fillet_box", sm.circular_fillet(sm.create_box((0, 0, 0), 20, 20, 20), 3))
```

Check each result in a **separate process**, because the last one crashes:

```python
# check.py <file.brep>
import sys
from OCP.BRep import BRep_Builder
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepTools import BRepTools
from OCP.TopoDS import TopoDS_Shape

s = TopoDS_Shape()
BRepTools.Read_s(s, sys.argv[1], BRep_Builder())
print(BRepCheck_Analyzer(s).IsValid())
```

The bigger reproducer is the example part of ScriptCAD, a bracket built from boxes, cylinders, booleans, patterns and fillets: [`example.json`](https://github.com/rubenhekkens/scriptcad/blob/main/src/scriptcad/web/example.json), exported with `scriptcad.kernel.export("bracket.usda", "usd-brep", doc=example)`. That is a plain `sm.usd.export_breps` of the single result body. I can attach `bracket.usda` (100 KB) and the `usd_to_occt` output.

## Results

In each case `usd_to_occt` exits with 0. The OCCT columns are measured on the `.brep` it writes.

| body | surface types in the USD | zero-angle cones | faces with null surface | edge uses without pcurve | `BRepCheck` | OCCT volume / kernel volume |
|---|---|---|---|---|---|---|
| box | plane | 0 | 0 | 0 / 24 | valid | 1000 / 1000 |
| cylinder r5 h10 | plane, cylinder | 0 | 0 | 4 / 6 | invalid | 261.8 / 785.4 |
| cone r6→2 h10 | plane, cone | 0 | 0 | 4 / 6 | invalid | 209.4 / 544.5 |
| sphere r7 | sphere | 0 | 0 | 2 / 2 | invalid | 0 / 1436.8 |
| torus 10/3 | torus | 0 | 0 | 4 / 4 | invalid | 0 / 1776.5 |
| box minus cylinder | plane, cylinder | 0 | 0 | 4 / 30 | invalid | 2276.2 / 1748.7 |
| `circular_fillet(box 20³, 3)` | plane, cone, sphere | 12 | 12 | 72 / 96 | **crash** | not computed |
| ScriptCAD bracket | plane, cone, cylinder, NURBS | 4 | 4 | 42 / 124 | **crash** | not computed |

The only edge uses that have pcurves are the ones on planes (OCCT computes those on the fly). The faces with a null surface are the faces that were `BrepSurfaceConeAPI` with `semiAngle = 0` in the USD. In the `.brep` they are written as conical-surface records (type `3`) whose last field, the semi-angle, is `0`.

At scale: in a benchmark of 233 real-world STEP files (NIST MBE PMI test models and 200 files from ABC chunk 0000), 548 solid parts were imported with `occt_to_usd`, loaded into the kernel, written back with `export_brep`, and converted with `usd_to_occt`:

| outcome of `usd_to_occt` | parts |
|---|---|
| `BRepCheck` valid | 97 (18%) |
| invalid, edge uses without pcurves | 394 (72%) |
| invalid, all pcurves present | 36 (7%) |
| `BRepCheck_Analyzer` crashes | 21 (4%) |

Every valid result has pcurves on every edge use. The same kernel bodies, rebuilt in OCCT from the same `.usda` arrays by computing the pcurves with `ShapeFix_Face`, are valid solids in 539 of 548 cases (see the workaround below). For details, see [`bench/RESULTS.md`](https://github.com/rubenhekkens/scriptcad/blob/main/bench/RESULTS.md) in ScriptCAD.

## Expected

- `usd_to_occt` should compute pcurves (for example with `BRepLib::BuildPCurveForEdgeOnPlane` / `ShapeFix_Edge::FixAddPCurve`, or by projecting the 3D curve) when the BrepArray has no `brep:curveUv` data. `export_brep` never writes them, so without this, kernel output can never reach OCCT intact.
- Zero-angle `BrepSurfaceConeAPI` should be written as a cylindrical surface (`Geom_CylindricalSurface` with the same placement and radius), and the kernel should stop writing fillet faces as zero-angle cones (the rest of #14).
- If a face can't be converted, `usd_to_occt` should report a failure instead of writing a face with a null surface.

## Workaround

ScriptCAD does not use `usd_to_occt` for STEP export. It rebuilds the shape from the BrepArray arrays with its own builder: exact 3D curves and surfaces, zero-angle cones mapped to cylinders, pcurves computed with `ShapeFix_Face`, then sewing. See `src/scriptcad/occt_bridge.py` (`brep_arrays_to_shape`). With that builder, every body in the table above exports as a valid solid within 1e-4 of the kernel volume (checked for this report; most of these shapes are also in ScriptCAD's tests).
