# Voxel FEA spike: browser (WebGPU) vs native (CUDA)

Question: can linear-elastic stress analysis of a real part run *in the browser* on
the GPU, fast and accurately enough for design-time feedback and, later, generative
design? And how does it compare with running the same solver natively?

## Method

One algorithm, three implementations with identical data layouts, so results compare
value by value:

| Backend | Code | Precision |
|---|---|---|
| Browser | `src/scriptcad/web/fea/solver.js` (WGSL compute shaders) | float32 only (WebGPU has no f64) |
| Native GPU | `src/scriptcad/fea/cuda.py` (NVIDIA Warp, CUDA) | float32 or float64 |
| Native CPU | `src/scriptcad/fea/cpu.py` (assembled K, PyAMG smoothed-aggregation CG) | float64, the reference |

* **Voxels, matrix-free.** Every solid voxel is the same cube, so one 24×24 element
  matrix (times the voxel's E and size) serves the whole part. Nothing is assembled:
  each node *gathers* forces from the up to 8 voxels around it. That avoids the float
  atomics WGSL doesn't have.
* **Element:** trilinear brick enriched with Wilson's incompatible modes (`hex8i`),
  statically condensed to 24 DOF. Same cost as the plain brick (`hex8`), far less
  shear locking in thin walls.
* **Solver:** Jacobi-preconditioned conjugate gradients, scalars kept on the GPU,
  residual read back every 25 iterations (in the browser, 25 iterations per command
  buffer submission also keeps clear of the OS GPU watchdog).
* **Translation-relative operator.** The element matrix ignores rigid translation, so
  each voxel's `K (p - p_corner0)` equals `K p` exactly, but in float32 the small
  differences cancel far less than the raw values. This one change is what makes a
  float32 solver usable on slender and thin-walled parts (see the results).

Each run is scored twice:

* **discretisation error**: quantities against closed-form references
  (`src/scriptcad/fea/benchmarks.py`), never other software's output;
* **solver error**: `||u - u64|| / ||u64||` against a float64 solve of the *same* voxel
  model, which isolates float32 effects from voxel coarseness.

## Cases

| Case | What it checks | Reference |
|---|---|---|
| `cantilever` | bending, slender part | Euler-Bernoulli + Timoshenko shear; M c / I |
| `thin_cantilever` | a 2 mm wall with 2–8 voxels through it: shear locking | same, b = 2t so plate stiffening stays out of the reference |
| `tube_torsion` | 62 N·m through a tube with a 2.5 mm wall; curved staircase | Saint-Venant torsion, T r / J |
| `lame_ring` | internal pressure on a ring seat (press-fit load) | Lamé, open ends |

Real-part cases can be added in a local, untracked `src/scriptcad/fea/local_cases.py`
(a `CASES` dict, merged into `benchmarks.CASES`).

## Running it

```bash
uv sync --extra step --extra sim
uv run python bench/fea/compare.py            # native backends -> results/native.jsonl
uv run scriptcad                              # then open /fea/bench.html and press Run
uv run python bench/fea/compare_mg.py         # multigrid (MG-PCG) rows -> results/native.jsonl
# in /fea/bench.html: "Run multigrid" (or runBenchMG() in the console)
uv run python bench/fea/report.py             # merged table -> results/summary.md
```

## Results (28 Oct 2026, RTX 5070 Laptop GPU and Intel Xe-LPG iGPU)

Full table: `results/summary.md`. WebGPU reports the RTX 5070 as "nvidia / blackwell"
(its architecture). By default Chrome on this hybrid laptop got only the Intel iGPU, even
when the page asked for "high-performance"; it moved to the RTX 5070 after setting
Chrome to High performance in Windows Settings > System > Display > Graphics **and**
fully restarting Chrome (background apps kept the old process alive).

| Jacobi-PCG, 0.5 mm voxels | Free DOF | Chrome WebGPU, RTX 5070, f32 | Native CUDA (Warp), RTX 5070, f32 | Native CUDA, f64 | Browser, Intel iGPU, f32 | CPU AMG, f64 |
|---|---:|---:|---:|---:|---:|---:|
| tube_torsion | 670k | **1.29 s** | 2.78 s | 7.97 s | 9.28 s | (skipped) |
| lame_ring | 388k | 0.36 s | 0.36 s | 1.47 s | 1.47 s | 20.4 s |

Solution error against float64 is 3e-5 (tube) and 8e-7 (ring) in every float32 backend;
every reported quantity agrees with float64 to 3–4 significant figures.

The browser beating native CUDA on the same GPU reflects implementation tuning, not the
platform: the WGSL kernel caches the 24x24 element matrix in workgroup shared memory,
while the Warp kernel reads it from global memory with a fully unrolled 8x8 loop. A
tuned CUDA kernel should match or beat it. The point that stands: on the same GPU the
browser gives up nothing that matters.

**Findings**

1. **Browser = native.** The WGSL and CUDA solvers agree to the last digit reported. On
   the same RTX 5070 the browser was even faster (see above); the real gap is which GPU
   the browser is given: the integrated GPU was 4–7× slower than the RTX 5070 in Chrome.
2. **Plain float32 is not safe.** With the straightforward operator, float32 CG stalls
   at a wrong answer on slender and thin-walled parts while reporting convergence:
   -21% tip deflection on a 2 mm wall (4 voxels thick), -51% at 8 voxels. Tightening
   the tolerance does not help. The translation-relative operator brings that to
   0.3–0.6% at no cost. Mixed-precision refinement works only if the outer residual is
   float64, which the browser does not have.
3. **Shear locking is real and cheap to fix.** 2 voxels across a 2 mm wall: plain brick
   -12.6%, incompatible-mode brick -0.74% (same solve cost).
4. **Staircase error is 2–2.5%** on curved surfaces (tube, ring) at 4–5 voxels per wall.
5. **Peak stress at load introduction does not converge** (on a real cast part it
   doubled from 0.8 to 0.5 mm voxels at the loaded lugs). Report percentiles, field plots and displacement-based
   quantities; never the raw maximum.
6. **Jacobi-PCG iterations grow with resolution** (roughly 2× per halving of h), so the
   next speed step is multigrid, not a faster GPU.

## Multigrid

Finding 6 has been addressed: a geometric multigrid preconditioner. The CUDA version is in
`src/scriptcad/fea/multigrid.py`. The WebGPU version is in `src/scriptcad/web/fea/multigrid.js`
(`VoxelSolver.solveMG`). The two run the same algorithm and build identical level hierarchies.

* **Levels:** each level halves the voxel grid. A coarse voxel's E is the **volume average** of
  its 8 children (void counts as 0). The coarse operator reuses the same KE, scaled by the coarse h
  (rediscretised). A coarse DOF is held if a held fine DOF lies in its stencil. Coarsening stops at
  ≤ 200 free DOF (5–7 levels here), or when a level would split the part or leave a piece unsupported.
* **Transfer:** trilinear prolongation; restriction is its transpose.
* **Smoothing:** Chebyshev, 2 pre and 2 post steps, on [λ/8, λ]. λ = λmax(diag(KE)⁻¹KE) = 5.99 is a
  proven upper bound for every level, so no eigenvalue estimate is needed.
* **Coarsest level:** 100 Jacobi-PCG iterations, with no readback.
* **Outer solver:** flexible CG, because the inner CG is not a linear operator. The
  translation-relative K p is used on every level.
* **Cost per iteration:** about 4 fine-level K p plus about 850 small dispatches. On CUDA one
  outer iteration is captured once as a CUDA graph and replayed.

| Float32, tol 1e-6 | Jacobi-PCG iterations | MG-PCG iterations | CUDA MG | Chrome MG (RTX 5070) | Chrome MG (Intel iGPU) |
|---|---:|---:|---:|---:|---:|
| thin_cantilever hex8i, 1.0 / 0.5 / 0.25 mm | 1,575 / 3,550 / 7,175 | 40–45 / 40–45 / 45 | 0.09–0.12 s | 0.23–0.29 s | 0.33–0.39 s |
| tube_torsion 0.5 mm (670k DOF) | 1,500 | 55 | 0.63 s | 0.56 s | 2.8 s |
| lame_ring 0.5 mm (388k DOF) | 525 | 30 | 0.17 s (Jacobi 0.36) | 0.22 s (0.36) | 0.70 s (1.47) |

* **Iteration counts are flat under refinement:** 25–55 for every case, against Jacobi doubling per
  halving of h. Float64 MG to 1e-10 takes 35–95 iterations.
* **Accuracy:** the error against float64 equals the Jacobi float32 error (for example 3.2e-5 on the
  tube, within about 1e-3 everywhere). Precision, not the solver, sets the floor.
* **Speed:** 2–4× faster on the 0.4–0.7M DOF cases (4–7× on a 1.5M DOF real part). On the tiny cases (< 100k DOF) the coarse-level
  dispatch overhead (2–9 ms per iteration) dominates. Jacobi is just as fast there.
* **Volume averaging vs majority vote:** a majority vote (solid if ≥ 4 of 8 children) lets thin walls
  vanish. The 2.5 mm tube splits into 11 pieces at 4 mm voxels, so coarsening must stop there. With a larger coarsest level the 100 inner iterations no longer
  solve it well: tube 165 iterations (5.8 s), against 55 with averaging. Volume averaging keeps every thin wall as a softer, thicker wall that stays connected,
  which is the default.
* **The coarsest solve decides the iteration count.** Stopping at 3,000 DOF with 40 inner
  iterations gave 250–630 iterations on the thin cantilever, so the default coarsens to ≤ 200 DOF
  and runs 100 inner iterations.
* **Other settings, a 1.5M DOF real part:** 1 / 2 / 3 smoothing steps give 85 / 55 / 45 iterations;
  damped Jacobi instead of Chebyshev gives 60.

