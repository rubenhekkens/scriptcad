# STEP robustness benchmark

How well does ScriptCAD's STEP pipeline, which runs on NVIDIA's usd-brep (SMLib) kernel, hold up on real CAD files? This benchmark runs 233 public STEP files through the whole pipeline: import into the kernel, a kernel boolean, and export back to STEP. Every stage is checked against OpenCASCADE.

Run on 2026-10-28 with usd-brep 1.0.1 (PyPI), the usd-brep **1.0.0** converters (`occt_to_usd` / `usd_to_occt`, prebuilt by Julia's `USDBrep_jll`), and cadquery-ocp 8.0.1. Python 3.12.10, Windows 11 x64, 24 cores, 8 files at a time, 300 s budget per file. The raw data is in [`results/`](results/): `results.json` has one record per file, `results.csv` one row per part, and `summary.md` holds the generated tables.

## Headline

| | NIST (33 files) | ABC sample (200 files) | all (233) |
|---|---|---|---|
| OpenCASCADE reads the file | 100% | 100% | 100% |
| **files where every part passes every stage** | **27 (82%)** | **158 (79%)** | **185 (79%)** |
| files finished within 300 s | 32 | 191 | 223 (96%) |
| solid parts in finished files | 32 | 517 | 549 |
| ...imported into the kernel (any route) | 100% | 99.8% | 99.8% |
| ...kernel `volume()` within 1e-3 of OpenCASCADE | 84% | 94% | 94% |
| ...boolean succeeds with a manifold result | 100% | 96% | 96% |
| ...boolean removes the same volume as OpenCASCADE (1e-3) | 97% | 90% | 91% |
| ...exported as a valid STEP solid | 100% | 98% | 98% |
| ...exported valid and within 1e-3 of the original volume | 97% | 95% | 95% |
| **solid parts passing every stage** | **27/32 (84%)** | **471/517 (91%)** | **498/549 (91%)** |
| for comparison: NVIDIA `usd_to_occt` output that is BRepCheck-valid | 3% | 19% | 18% |

When the kernel's volume agrees with OpenCASCADE, it agrees closely: the median relative error over all manifold parts is **1.9e-8**, the 90th percentile is 7.8e-5, and 425 of 549 parts are within 1e-6.

The two corpora behave alike. NIST parts are larger (139 to 663 faces) and more often need the NURBS fallback (6 of 32, against 9 of 517 in ABC). The ABC files hit more boolean and timeout problems because there are many more of them.

## Corpus

| corpus | files | source | license |
|---|---|---|---|
| NIST MBE PMI test models | 33 `.stp` (CTC 01-05, FTC 06-11, STC 06-10; AP242, AP203 with PMI, AP203 geometry only) | [nist.gov download page](https://www.nist.gov/el/systems-integration-division-73400/mbe-pmi-validation-and-conformance-testing/download-free-cad), `NIST-PMI-STEP-Files.zip` | free to use without restriction; NIST asks for acknowledgement |
| [ABC dataset](https://deep-geometry.github.io/abc-dataset/) chunk 0000 | 200 `.step`: every 50th file of the sorted archive (positions 0, 50, 100, ...) | `abc_0000_step_v00.7z` from NYU's archive (handle 2451/44309) | models are © their Onshape creators, distributed for research; **not redistributed here**, only file ids and results |

The files are not in this repository. To reproduce, download them and run:

```bash
python bench/step_roundtrip.py nist=PATH/TO/NIST-PMI-STEP-Files abc=PATH/TO/abc_sample --jobs 8 --timeout 300 --retry 1800 --out bench/results
```

A STEP file can hold several bodies. OpenCASCADE splits each file into **parts**: one per solid, or one per shell when a file has no solids. 4 files have no solids: 3 ABC files with sheet bodies (579 shells, 34 of them within the 25-part cap described below) and NIST `ftc_08 ... -tg`, which holds tessellated geometry (273 parts). Their shell parts are reported separately, because "manifold solid" and "volume" don't apply to them.

## What each stage checks

Each file runs in its own process, with a timeout that kills the whole process tree. A crash or a hang only loses that file. The worker writes a snapshot after every stage, so a crash or timeout still records how far the file got.

| stage | what runs | pass criterion |
|---|---|---|
| occt | `occt_bridge import`: OpenCASCADE `STEPControl_Reader` + `ShapeFix`, one `.brep` per part | file read, parts found |
| convert | the real `step_io.step_to_usd`: `occt_to_usd` per part, the kernel loads it, and if either fails, a retry with every surface converted to NURBS | the kernel loads the part |
| kernel | `usd_brep` import, `is_manifold_solid()`, `volume(1e-6)` | manifold, volume within 1e-3 of OpenCASCADE |
| boolean | `boolean_difference(part, cylinder)`, with a cylinder through the bbox center (r = 10% of the smaller xy extent); OpenCASCADE `BRepAlgoAPI_Cut` with the same cylinder as the reference | no error, manifold result, removed volume within 1e-3 (of the part volume) |
| export | kernel `export_brep`, then `step_io.usd_to_step` (ScriptCAD's own BrepArray-to-OCCT builder), then STEP; the STEP file is read back | `BRepCheck` valid, volume within 1e-3 |
| nvidia (diagnostic) | the same `.usda` through NVIDIA's `usd_to_occt`, inspected in its own process | `BRepCheck` valid; does not count toward pass/fail |

**Volume reference.** OpenCASCADE's own volume integral is not always right. On 12 parts, `BRepGProp` on the shape as read differs by more than 1e-3 from the same integral on the NURBS-converted shape. One example is ABC `00003600` part 0: an extruded B-spline profile where the plain integral is 0.28% high, while OCCT's mesh, the NURBS-converted integral, the kernel and the exported solid all agree to about 1e-4 or better. A volume therefore counts as matching if it is within 1e-3 of *either* OCCT integral. The boolean is judged on the volume it removes, so an integration error shared by both sides cancels out. The tessellation volume (kernel mesh, chord 2e-4 x diagonal) is recorded as an independent check of the kernel's `volume()`.

**Part cap.** Only the first 25 parts of a file go through the kernel, boolean and export stages; the 654 parts beyond that were converted but not checked further. A file "passes" if every part that was run passes. Of the 233 files, 4 have more than 25 parts.

## Failures, by first failing stage

Counts are over parts of all files. The full list with every part is in `results/results.csv` (column `failure`).

### 1. Timeouts in `occt_to_usd` (9 files, 433 parts)

All 9 timeouts happened while `occt_to_usd` was running. Normally that converter takes **0.05 s** per part (median; the slowest part that finished took 0.5 s). When rerun alone with a 30-minute budget, 8 of the 9 files finished in 17 to 784 s, and every part that ran in them passes. The exceptions are one part each in `00000700`, `00003500` and `00009850`, and four parts in `00003650`.

| file | parts | stopped at | rerun alone |
|---|---|---|---|
| abc/00000000 | 6 | `occt_to_usd` part 5 | ok, 32 s |
| abc/00000050 | 3 | `occt_to_usd` part 1 | ok, 17 s |
| abc/00003600 | 20 | `occt_to_usd` part 16 | ok, 73 s |
| abc/00003500, 00003650, 00007400, 00009850 | 9 / 6 / 87 / 27 | `occt_to_usd` | ok, 72 to 283 s |
| abc/00000700 | 2 | `occt_to_usd` part 1 (NURBS retry) | ok, 784 s |
| nist/ftc_08 ...-tg (273 tessellated shells) | 273 | `occt_to_usd` part 13 | timeout again after 1800 s (reached part 114) |

Which files time out varies between runs: an earlier full run of the same corpus timed out on 16 files, only partly the same set: 4 of this run's 9 finished within the budget there. Running the stalled part of `00000000` 48 times in isolation, 1 and 8 at a time, took 0.1 s every time. So this is a load-dependent stall of `occt_to_usd` while kernel processes run next to it, not a hang tied to a particular file. The cause is not yet known. The tessellated NIST file is simply too large: each of its 273 shells is a separate face-per-triangle shell.

### 2. Conversion (3 parts lost, 15 rescued by the NURBS fallback)

`step_to_usd` first converts each part exactly. If the converter or the kernel rejects the result, it converts all surfaces to NURBS and tries again. These were the errors on the first attempt:

| first-attempt error | rescued by NURBS | lost |
|---|---|---|
| `occt_to_usd`: `staging failed: face N: unsupported or missing surface` | 5 | |
| `occt_to_usd`: `multi-turn analytic U trim requires topology splitting` | 4 | 1 (abc/00000450 part 1) |
| kernel import: `SmCone::CreateCanonical failed for face index N` (cones the 1.0.0 converter writes but the kernel can't rebuild) | 4 | |
| `occt_to_usd`: `multi-turn cylinder trim overlaps adjacent face` | 2 | |
| `occt_to_usd`: `topology resolve failed: face has no loops` | | 2 (abc/00009600, a sheet-body file) |

The fallback works: 15 of 18 problem parts get through. The cost is that NURBS-route parts lose their analytic surfaces, and 5 of the 15 then have volume problems (see 3).

### 3. Kernel volume (34 solid parts outside 1e-3)

For a part outside tolerance, there are two ways to tell whether the *geometry* in the kernel is wrong or only the *volume integral*. The first is the volume of the kernel's own tessellation. The second is the exported solid: it is rebuilt from the kernel's curves and surfaces and measured by OpenCASCADE.

- **14 parts: the geometry is right, and `Brep.volume()` is wrong.** The exported solid matches OpenCASCADE within 1e-3, and usually much closer. The worst cases:
  - abc/`00006950` part 2 (17 faces, exact route): `volume()` is **+186%**, while the tessellation is within 1.1e-7 and the export is exact.
  - nist/`ctc_02 ... rc` (663 faces, NURBS route): `volume()` is **34x** too large, while the export is within 1.7e-6.
  - The others: `ctc_04 ap242`, `ftc_06 rd`, `stc_06`, and ABC `00001550`, `00002550` (x2), `00006000`, `00006300`, `00008600` (x2) and `00009200` (x2), all 1e-3 to 0.5 off.

  This is the same symptom as **usd-brep#11** (`Face.area()` error that plateaus instead of converging) and **#19** (volume ±3.4% depending on orientation). Both are closed as fixed in 1.0.1, but these parts were measured *on* 1.0.1. Before filing, the next step is to check whether the error moves with `relative_accuracy`.
- **20 parts: the geometry itself differs.** The tessellation and the export are off as well (for example abc/`00000100` part 4, `00002550` part 0, nist/`ctc_02 ap203` at 2.4%). The exported solid is built from the kernel's geometry, so the difference was already there after import. That means `occt_to_usd` 1.0.0 lost or changed something. One 1.0.0 converter bug fixed in 1.0.1 is the planar `face:range` taken from 24 samples per edge (usd-brep#11). These parts should be rerun with 1.0.1 converters before anything is reported upstream. No 1.0.1 converter build exists yet; `USDBrep_jll` stops at 1.0.0.

### 4. Boolean (14 parts and 1 process crash)

| result | parts | examples |
|---|---|---|
| removed volume differs from OpenCASCADE's cut | 6 | abc/`00001700` part 0 (97% off), `00007500` part 0 (2%), `00003100` part 22 (2.6%) |
| result is not manifold | 5 | abc/`00000150` part 7, `00004350` part 2, `00007700` parts 0 and 1, `00007950` part 4 |
| `SmApiBooleanDifference failed: SM_ERR (1001)` | 2 | abc/`00004100` part 2, `00004750` part 3 |
| kernel process crash in `boolean_difference` | 1 | abc/`00009450` part 0 (NURBS route); crashed in every full run |

The cutting tool is a plain cylinder, and all of these parts imported with a correct volume. So these are kernel boolean failures on real geometry. They are in the same family as the open usd-brep#32, #33 and #35 (SM_ERR, invalid results and empty results from booleans). The deterministic crash on `00009450` is the best candidate for a new upstream report.

### 5. STEP export (3 parts)

ScriptCAD's own exporter wrote a valid solid within 1e-3 for 523 of 548 parts. The 3 parts where only the export stage failed:

- abc/`00004500` part 4 and `00005000` part 0: `BRepCheck` invalid (in `00004500` the volume is also 73% off)
- abc/`00006600` part 0: valid, but the volume is 1.6e-3 off

These are ScriptCAD bugs (in `occt_bridge.brep_arrays_to_shape`), and they are the next thing to fix on our side. Reading the exported STEP files back gives a volume within 1e-3 of the original for 557 of the 576 parts read back (shell parts included).

### 6. NVIDIA `usd_to_occt` (diagnostic)

The same kernel-written `.usda` files through NVIDIA's converter (548 solid parts):

| outcome | parts |
|---|---|
| `BRepCheck` valid | 97 (18%) |
| invalid: edge uses on curved faces have no pcurves | 394 |
| invalid: pcurves present | 36 |
| `BRepCheck_Analyzer` **crashes the process** | 21 |

Every valid output has pcurves on every edge use. The kernel's `export_brep` writes no 2D trim curves (`brep:curveUv`), and `usd_to_occt` doesn't compute them when they are missing. So only bodies that are effectively planar get through. This is why ScriptCAD exports STEP with its own builder. The problem is written up for upstream in [`upstream_issue_usd_to_occt.md`](upstream_issue_usd_to_occt.md), with a second failure that only kernel-made fillets trigger: zero-angle cones become null surfaces (the rest of usd-brep#14).

## Timing

Medians per solid part: kernel import and checks 0.03 s, boolean 0.04 s, export to STEP and read back 1.5 s, `occt_to_usd` 0.05 s. A whole file takes 6.7 s at the median and 31.5 s at the 90th percentile, under the 8-way parallel load. Most of the wall time is process startup and OpenCASCADE: each STEP read or write runs in a fresh `occt_bridge` process.

## Upstream issues this ties to

| issue | status | what this benchmark shows |
|---|---|---|
| usd-brep#5 `usd_to_occt` writes invalid `.brep` | closed (no attachment) | reproduced at scale: 82% invalid, 4% crash `BRepCheck`. New draft: `upstream_issue_usd_to_occt.md` |
| usd-brep#14 cylinders exported as zero-angle cones | fixed in 1.0.1 for `create_cylinder` | still happens for fillet faces on 1.0.1; `usd_to_occt` turns them into null surfaces |
| usd-brep#11 face-range / area bugs | fixed in 1.0.1 (converter and kernel) | the converter fix isn't usable yet (no 1.0.1 build); 20 parts with geometry differences after `occt_to_usd` 1.0.0 are candidates |
| usd-brep#19 volume accuracy | closed | 14 parts where `volume()` is wrong on 1.0.1 while the geometry is right, up to 34x |
| usd-brep#32 / #33 / #35 boolean failures | open | 13 boolean failures and 1 deterministic crash on real parts |

## Caveats

- The OpenCASCADE reference has its own errors. The two-integral rule handles the cases that were found, but a few small "geometry differs" results could still come from OCCT.
- Timeouts depend on load (see 1). With `--jobs 1` there would be fewer.
- 200 of the ~1 million ABC files is a small sample: rates are ±3 points or so at 95% confidence, and the failure list is not exhaustive.
- Only the first 25 parts of a file are checked past conversion.
