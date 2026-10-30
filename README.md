# ScriptCAD

A browser-based CAD interface on top of NVIDIA's open-source **USD BRep** kernel
(`usd-brep`, the SMLib NURBS solid modeler, Apache-2.0, released October 2026).

There are two ways to model, and both use the same viewport:

- **Model** is a parametric feature history: primitives, sketch extrude/revolve,
  booleans, fillet/chamfer on picked edges, shell with picked faces, offset,
  move/copy, linear and circular patterns, and STEP and USD BRep import. When you edit a
  feature, everything after it regenerates.
- **Script** is plain Python against the kernel (`sm` = `usd_brep`, `show(brep)`
  to display), with `sm.` autocompletion. **From history** turns the feature
  tree into the equivalent script. That works because the history is compiled
  to exactly that code.

Exports: STEP (AP214), exact BRep as OpenUSD (`.usda` / `.usdc`, `BrepArray` prims),
tessellated `UsdGeomMesh`, and STL.

## Install and run

ScriptCAD runs on **Windows (x86_64) and Linux (x86_64, aarch64)** with CPython
3.12, because those are the only builds of `usd-brep`. **macOS isn't supported.**

With [uv](https://docs.astral.sh/uv/) you don't need a Python 3.12 install first,
because uv fetches one:

```bash
uvx --python 3.12 scriptcad
```

Or with pip in a Python 3.12 environment:

```bash
pip install scriptcad
scriptcad
```

The browser opens at http://127.0.0.1:8765. Options: `--port 9000`, `--no-browser`.
To change the per-request kernel timeout (default 90 s), set `SCRIPTCAD_TIMEOUT`.
Imported USD files are copied to a per-user data folder: `%LOCALAPPDATA%\scriptcad\uploads`
on Windows, `~/.local/share/scriptcad/uploads` on Linux.

### STEP import and export

STEP support is optional. It needs OpenCASCADE, which ships as a separate wheel:

```bash
uvx --python 3.12 "scriptcad[step]"      # or: pip install "scriptcad[step]"
```

Then use **File → Import STEP or USD BRep…** (`Ctrl+I`) and **File → Export STEP**.
Each solid in a STEP file becomes an editable body.

How it works:

- **Import:** OpenCASCADE reads the STEP file. NVIDIA's `occt_to_usd`
  converter then turns each solid into the kernel's USD BRep format.
- **Export:** ScriptCAD's own exporter (`occt_bridge.py`) rebuilds each body from
  the kernel's exact curves and surfaces in OpenCASCADE and writes AP214 STEP.

NVIDIA's converter isn't in the `usd-brep` wheel. On first STEP import,
ScriptCAD downloads a prebuilt copy for Windows x86_64 or Linux x86_64, about
46 MB. It's Julia's [BinaryBuilder](https://github.com/JuliaPackaging/Yggdrasil)
build of NVIDIA's usd-brep v1.0.0 source, plus its OpenUSD, oneTBB and C++
runtime libraries. ScriptCAD pins every download by sha256 and unpacks it into
the per-user data folder. To download ahead of time, run
`scriptcad --install-step-tools`. To use your own build of usd-brep's tools
instead, set `SCRIPTCAD_OCCT_TOOLS` to the folder containing `occt_to_usd`.

Known limits of the v1.0.0 converter:

- Some analytic faces fail to translate, for example the apex of a pointed cone.
  ScriptCAD retries those parts with every surface converted to NURBS and warns
  when it does. The geometry stays exact, but faces lose their analytic type.
- NVIDIA reports planar faces bounded by rational B-spline edges importing about
  0.65% too large ([usd-brep#11](https://github.com/NVIDIA-Omniverse/usd-brep/issues/11)).

### From source

```bash
git clone <this repo>
cd scriptcad
uv sync          # creates .venv with Python 3.12 and the dev tools
uv run scriptcad
uv run pytest
```

## Using it

| | |
|---|---|
| Orbit / pan / zoom | left drag / right or middle drag / wheel |
| Selection filter | `1` body, `2` face, `3` edge (Shift/Ctrl-click to add) |
| Fit view | `F` |
| Measure | `M`, then click two points |
| Confirm / cancel a feature | `Enter` / `Esc` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Save / open project (`.scad.json`) | `Ctrl+S` / `Ctrl+O` |
| Run script | `Ctrl+Enter` |

To pre-fill a feature, select edges before you press **Fillet** or **Chamfer**,
or select two bodies before you press a **Combine** tool. While you pick edges
or faces for a feature, the model rolls back to the state just before that
feature.

**Variables** (left panel) are named numbers, such as `tf = 3`. Any number field
takes an expression over them (`40 - tf`, `bf / 2`, `max(tw, 2)`), and so does each
coordinate of a polyline (`50 + bf/2, H - tf`). The field shows the value it works out
to. Change a variable and every feature that uses it follows. Angles in `sin`, `cos` and
`tan` are in degrees.

## Analyze: stress on your GPU, in the browser

![Analyze mode on the example bracket](docs/analyze-mode.jpg)

**Simulate → Analyze** runs a linear-elastic stress analysis of a body and colours it by
von Mises stress. The solve happens on your GPU through WebGPU, so it needs a recent
Chrome or Edge, and the simulation extra on the server:

```bash
uvx --python 3.12 "scriptcad[sim]"        # or: pip install "scriptcad[sim]"
```

1. Press **Pick** next to *Fixed faces* and click the faces that are held (bolt holes,
   a clamped face). Then pick *Load faces*.
2. Choose a load: a total **force** (N), a **pressure** (MPa) or a **torque** (N·m about an
   axis through the load faces), a material and a resolution.
3. **Run analysis.** With *Re-run when the model changes* on, every edit to the feature
   history re-runs it, so you can change a dimension and watch the stress follow.

The example bracket (four bolt holes held, 2 kN down on the bore, ~670k unknowns) solves
in about 1 s on an RTX 5070 and 1.5 s on Intel integrated graphics.

### Example: less material, more stiffness

**File → Load bridge example** opens three 200 mm steel bridges, each clamped at both ends
with 2 kN spread over its deck, and runs all three. Supports and loads are set per body;
material, load and resolution are shared, so the comparison is fair, and every body uses
the same colour scale and the same deformation scale.

| Design | Mass | Deflection | Stress (99th pct) | Stiffness per gram |
|---|---:|---:|---:|---:|
| A · Solid slab | 502 g | 32.6 µm | 29.8 MPa | 1× |
| B · I-girder | 349 g (−31%) | **10.5 µm** | **15.4 MPa** | **4.5×** |
| C · Truss | 333 g (−34%) | 19.2 µm | 24.1 MPa | 2.6× |

![Three bridges, stress](docs/bridges-stress.jpg)
![Three bridges, deformed shape at the same exaggeration](docs/bridges-deformed.jpg)

Material placed far from the middle of the section does the work: the girder's
flanges give it 7.5× the slab's bending stiffness with less steel. Its deflection is
higher than bending theory alone (3.9 µm) because the thin web also shears, which adds
~6 µm and matches the textbook shear term. The truss is stiffer than the slab too, but its
sharp joints concentrate stress (55.6 MPa peak away from the supports, against the slab's
35.7 MPa), which is why real trusses use gusset plates.

**Show → Underused material** makes the reason visible. It shades the material that
carries less than a fifth of the design's own 99th-percentile stress, and the *Idle* column
gives that share of the volume: **40%** of the slab (about 200 g of steel), 24% of the truss,
13% of the girder. Seen from the front, the slab's idle material is a band along the middle
of its height, splitting toward the quarter points where the bending moment changes sign.
That band is exactly the material the girder leaves out.

![Underused material, front view: the slab's idle band along its middle](docs/bridges-underused.jpg)

How to read it:

- **The colour scale stops at the 99th percentile** by default. Next to supports and
  load faces the peak stress is singular: it keeps rising as the voxels get finer, so the
  panel shows it as "not converged" and reports the maximum *away* from them separately.
- It is for **comparing designs**, not sign-off: linear elastic, small deflections, no
  contact, faces fully fixed, typical material values. See `bench/fea/README.md` for the
  measured accuracy (a few percent on closed-form benchmarks).
- On a laptop with two GPUs, browsers often get the integrated one. The panel says which
  GPU it is using; set your browser to *High performance* in Windows Settings › System ›
  Display › Graphics and fully restart it for several times faster results.

### Explore: let it find a lighter design

*Explore variants*, at the bottom of the Analyze panel, solves many versions of a body
and plots mass against deflection. Tick the variables to vary and give each a range;
optionally set a maximum deflection and a maximum stress. ScriptCAD spreads the variants
evenly over the ranges, rebuilds and solves each one exactly like a normal analysis, and
marks the ones that meet the limits. A line joins the best trade-offs: the variants that
no other variant beats on both mass and deflection. Click a dot, or **Use it** on the
suggestion, and its values go into your variables. The result is your own feature tree
with new numbers in it, not a mesh to redraw.

In the bridge example the girder is drawn from four variables: flange width `bf`, flange
thickness `tf`, web thickness `tw` and depth `H`. Varying the first three over ±50%
with a 15 µm deflection limit takes 25 solves (about 2.5 minutes on integrated graphics):

| I-girder | bf | tf | tw | Mass | Deflection | Stress (99th pct) | Stiffness per gram |
|---|---:|---:|---:|---:|---:|---:|---:|
| As drawn | 20 | 3 | 3 | 349 g | 10.5 µm | 15.4 MPa | 4.5× |
| Lightest under 15 µm | 10.1 | 3.3 | 1.9 | **204 g (−41%)** | 14.9 µm | 23.9 MPa | **5.4×** |

Narrow, thick flanges on a thin web: the steel goes to the top and bottom of the
section, where it carries the most bending load. The girder as drawn (the ring) is not on
the line at all: some variants are both lighter and stiffer. Limits use the
99th-percentile stress, never the peak, which grows without bound next to supports and
loads.

![Explore: 25 girder variants, mass against deflection; grey dots miss the 15 µm limit](docs/bridges-explore.jpg)

### Remove unused material: let the load decide the shape

Explore changes numbers in your design. *Remove unused material*, below it, needs no
design at all. It keeps the body's outer dimensions and carves the inside voxel by voxel:
solve, drop the voxels that store the least strain energy, solve again. Each step removes
3% of the material until you reach the share you chose (5–70%), or, with a *Max deflection*,
until the next step would deflect more than that. Scores are smoothed over the *Smallest
member* size, so the shape doesn't break up into a checkerboard, and voids next to busy
material can fill back in. Material at supports and loads always stays, and any piece that
loses its connection to a support is removed. This is BESO (bi-directional evolutionary
structural optimisation). It runs in the browser on the GPU solver. After every step the
viewport shows the shape as a smoothed surface, coloured by how hard the material works,
with the original body as a ghost. *Surface → Voxels* shows the design as solved.

Carving the solid slab down to half its steel takes 32 solves (72 s on integrated
graphics). Cut through the middle of its width, the result is a truss: a top chord over
the whole span, a bottom chord across the middle, and diagonal struts carrying the load
out to the clamped ends.

| Solid slab | Mass | Deflection | Stiffness per gram |
|---|---:|---:|---:|
| Original | 502 g | 32.6 µm | 1× |
| Carved to 50% | 251 g | 45.6 µm | **1.4×** |

A slab half as deep, the obvious way to halve the steel, would have an eighth of the
bending stiffness.
The result is a voxel mesh (**Download STL**), not editable features: use it to redraw the
part, or print it.

![The slab carved to 50%, cut through the middle of its width (black is removed material)](docs/bridges-carved.jpg)

**How accurate is it?** On the standard MBB beam, Carve's designs are within 1–2% of the
stiffness of a SIMP reference (the method of the classic 88-line code), as long as the
smallest member spans at least about 3 voxels. Below that they fall well short. The layout
of the slab is the same at Normal and Fine resolution. Carve maximises stiffness for one
load case: it doesn't check strength or buckling, and a design tuned for one load can do
worse under another. See [bench/topo](bench/topo/README.md).

### More carving examples (File menu)

| Example | Set-up | Result |
|---|---|---|
| **Lounge chair** | a long, low block with three feet, seat and reclined back as the loaded faces (aluminium, 8%) | struts fan out of the rear foot into seat and back, slim front legs |
| **Chaise longue** | a 160 cm curved lying surface on four feet (ABS, 10%); a body-weight load distribution is in `bench/topo/chaise_carve.js` | a branching tree grows from each foot |
| **B1 pile table** | the platform that lifts a pallet with a B1 paper pile into a press feeder, on four chain lugs (steel) | at equal mass 1.5× stiffer than a welded tube frame; see [PALLET.md](bench/topo/PALLET.md) |

![Lounge chair carved to 8%](docs/lounge-chair-side.jpg)
![Chaise longue carved to 10%](docs/chaise-carved-side.jpg)
![B1 pile table from below: welded frame, carved to the same mass, carved to the same stiffness](docs/pile-table-designs.jpg)

## How it works

- `src/scriptcad/kernel.py` holds all the `usd_brep` calls. Each feature compiles to
  a Python snippet. Regeneration runs the snippets in order, then tessellates
  the bodies that remain, producing per-triangle face IDs, exact BRep edge
  polylines and mass properties. Edge and face picks are stored as 3D points
  and re-resolved with `find_edge`/`find_face`, so a reference still works
  after upstream edits as long as that geometry still exists.
- `src/scriptcad/server.py` is a FastAPI server. Kernel work runs in a separate
  worker process, which is restarted if it crashes or times out.
- `src/scriptcad/web/` holds the three.js viewport and the UI. There is no
  build step. three.js 0.169.0 and CodeMirror 5.65.16 are vendored in
  `web/vendor/` (both MIT, license files included), so the app works offline.

Scripts run as ordinary Python on your machine, so only run scripts you trust.
The server listens only on 127.0.0.1.

## License

Apache-2.0. See [LICENSE](LICENSE).
