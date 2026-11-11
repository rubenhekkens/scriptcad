---
license: cc-by-4.0
pretty_name: ScriptCAD Carve
size_categories:
- n<1K
task_categories:
- other
tags:
- topology-optimization
- generative-design
- engineering
- cad
- 3d
- voxels
- fea
- text-to-cad
configs:
- config_name: default
  data_files:
  - split: train
    path: train/*
---

# ScriptCAD Carve: 3D topology optimisation, with engineering outcomes

{n} parts carved to their stiffest shape for their weight by [ScriptCAD](https://github.com/rubenhekkens/scriptcad)'s
**Carve** tool, each with its own dimensions, supports, load, material budget and smallest member size:

{family_table}

Every design comes from a full optimisation in 3D, with every step solved by finite elements; nothing is
predicted. Each part is then labelled the way an engineer would judge it:

- **Would it hold?** A real alloy and process, a load that gives the uncarved design space a realistic
  margin, and the carved part's stress, safety factor and deflection under it. **{passed} of {n} ({pass_share})
  pass** both a safety factor of 1.5 and a deflection of at most 1/500 of the span; the rest are labelled
  as failing, which is as useful to learn from.
- **Can it be made?** The number of pieces, the thinnest member, and for 3D printing the unsupported
  overhang for each of the six build directions.
- **Is the result right?** Each part is rebuilt from its own CAD document, and its carved design re-solved
  independently in float64.
- **What is the recipe?** The parametric ScriptCAD document, the same model as Python code (the kernel's
  own), and a plain-language spec: spec → CAD code → design space → carved design, in one row.

The carved designs are on median **{gain_median}×** (up to {gain_max}×) as stiff per gram as their design
space. {failed} drawn parts failed to set up (their load face was not found); they are kept, marked
`status: failed`, with the reason, and have no design.

Open any part in ScriptCAD (save `scriptcad_doc` as `part.scad.json`, **File → Open project**) or in the
[online demo](https://huggingface.co/spaces/mcsnekkeh/scriptcad), change it, and carve it again.

## What is in a row

The viewer shows a preview of each design: the view along its thinnest side, the other side view, and the
top view (lighter is nearer; the design space is a faint shadow).

| Column | |
|---|---|
| `status`, `failure` | `ok`, or `failed` with the reason |
| `family`, `params` | the part family and its parameters (JSON) |
| `spec` | the requirement in plain language |
| `material`, `process`, `E_MPa`, `poisson`, `density_g_cm3`, `yield_MPa` | a real alloy and how it would be made |
| `load_N`, `fixed_points_mm`, `load_points_mm` | the total force (spread over the load faces) and a point on each support and load face |
| `load_basis` | where the load comes from: a seated person for chairs, otherwise scaled to the design space's margin |
| `keep_target`, `keep_reached`, `keep_floor` | the material share asked for, reached, and the share that supports and loads keep on their own |
| `detail` | smallest member: `fine`, `medium`, `coarse` (about 2.5, 4 and 6 voxels at Normal resolution) |
| `mass_g_before`, `mass_g_after` | mass of the design space and of the carved part |
| `safety_factor_before`, `safety_factor_after` | yield over member stress, uncarved and carved |
| `member_stress_MPa_before`, `member_stress_MPa_after` | 99th percentile of von Mises away from the supports and load faces |
| `corner_peak_MPa_after` | the single highest stress away from them (at voxel-sharp corners; a real part has fillets there) |
| `max_disp_mm_before`, `max_disp_mm_after`, `deflection_limit_mm` | largest displacement, and span / 500 |
| `passes_strength`, `passes_deflection`, `passes` | safety factor ≥ 1.5; deflection within the limit; both |
| `stiffness_per_mass_gain` | (compliance × mass) of the design space over that of the carved part |
| `pieces`, `largest_piece_share` | connected pieces of the design, and the largest one's share |
| `thinnest_member_mm`, `member_mm_median` | member thickness (5th percentile and median along the medial voxels) |
| `print_direction`, `print_overhang_unsupported`, `overhang_by_direction` | for 3D printing: the build direction with the least unsupported overhang (45° rule), that share, and all six (JSON) |
| `reproducible`, `f64_rel_diff` | rebuilt from its document to the same grid; float64 re-solve vs the optimiser's float32 compliance |
| `compliance_before`, `compliance_after`, `carve_load_N`, `carve_E_MPa` | the carve as it ran (its own load and stiffness) |
| `voxel_mm`, `grid_xyz`, `origin_mm` | the voxel grid |
| `solves`, `seconds`, `stop`, `history` | how the optimisation went (history: share, compliance and deflection per step, JSON) |
| `scriptcad_doc`, `python` | the part as a ScriptCAD document and as Python for its kernel |
| `arrays` | the path of the voxel arrays |

`arrays/<id>.npz` holds the voxel arrays, indexed `[z, y, x]`:

- `fill` (uint8, 0–255): how full each voxel of the design space is (surface voxels are partly full)
- `design` (bool): the carved design
- `held_nodes` (bool, one larger in each direction): the nodes that are held (the supports)
- `force_dofs`, `force_values`: the loaded degrees of freedom (node × 3 + axis) and their forces at `carve_load_N`

```python
from huggingface_hub import hf_hub_download
from datasets import load_dataset
import numpy as np

ds = load_dataset("mcsnekkeh/scriptcad-carve", split="train").filter(lambda r: r["status"] == "ok")
row = ds[0]
print(row["spec"])
z = np.load(hf_hub_download("mcsnekkeh/scriptcad-carve", row["arrays"], repo_type="dataset"))
design, space = z["design"], z["fill"] > 0           # [z, y, x]
print(row["family"], design.shape, row["safety_factor_after"], row["passes"])
```

## How it was made

`bench/dataset/` in the ScriptCAD repository (`generate.py`, then `label.py`, then `pack.py`):

1. **Draw the part.** A family generator draws the dimensions, supports, load direction and carve settings
   from a seeded random generator (sample `i` uses seed `1000 + i`).
2. **Build and voxelise.** The CAD kernel (NVIDIA's open-source SMLib, USD BRep) builds the part, and
   ScriptCAD voxelises it at *Normal* resolution (about 200,000 voxels), with partly full voxels at the
   surface.
3. **Carve.** The app's own optimiser (hard-kill BESO, smoothed over the smallest member size) removes the
   material that stores the least strain energy, 3% per step, until the share asked for is left and the
   stiffness has settled. Material at supports and loads always stays, and parts that lose their support are
   removed. Every step is a linear-elastic finite element solve (8-node hexahedra with incompatible modes)
   on the GPU (CUDA multigrid, float32).
4. **Label.**
   - The part is rebuilt from its document, and the design space and the carved design are solved in
     float64.
   - A material is drawn with the Poisson's ratio the part was carved with. In linear elasticity the
     optimal layout depends only on the load's direction and on Poisson's ratio, not on the material's
     stiffness or the load's size, so the design is the right one for it.
   - Chairs carry a seated person: 2.1 kN in total (about 1.6 kN on the seat and 0.5 kN on the back, as in
     furniture static strength tests). The safety factor follows from it, and shows how far a chair could
     be carved further.
   - Other parts have no known load, so theirs is scaled to give the design space a safety factor drawn
     from 3 to 15 (log-uniform): the designer gave the space margin, and Carve spends it.

## Limits

- One load case per part; linear elasticity; strength judged by yield on member stress (no fatigue,
  buckling or contact).
- Designs are voxel grids. Supports and loads act on whole faces, held rigidly. The seat and back of the
  chairs, being loaded faces, stay as plates.
- Hard-kill BESO gives designs within 1–2% of the stiffness of a SIMP reference on the MBB beam when
  members span at least about 3 voxels ([benchmark](https://github.com/rubenhekkens/scriptcad/blob/main/bench/topo/README.md)).
- Design spaces are generated, not taken from real products; half of the newer samples are random shapes
  to cover more ground. Real-part design spaces, keep-out and keep-solid regions, and several load cases per
  part are planned.

## Licence and citation

CC BY 4.0. Please cite ScriptCAD: <https://github.com/rubenhekkens/scriptcad>.
