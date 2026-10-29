# FEA groundwork research for SolidCraft (issue #1620)

Research for [tangency-labs/solidcraft#1620](https://github.com/tangency-labs/solidcraft/issues/1620), "Research Request for Plugin: FEA". The issue text still links to `bherbruck/solidcraft`; the repository now lives at [github.com/tangency-labs/solidcraft](https://github.com/tangency-labs/solidcraft), and every SolidCraft link in this file uses that address.

This is research only. It describes how FEA works, how accurate it is, what existing programs do and what users ask for. It does not design SolidCraft code and does not say how SolidCraft should implement anything.

## About this research

### Who wrote it

- Written by Ruben Hekkens (GitHub: [rubenhekkens](https://github.com/rubenhekkens)) with an AI research assistant (Claude, by Anthropic), in October 2026.
- Shared under **MIT OR Apache-2.0**, the same licence as SolidCraft, so it can be quoted in SolidCraft's documentation.

### Method

- The work was split by kind of source, and literature searches ran in parallel on six topics: theory (fundamentals), verification and accuracy, meshing and mesh-avoiding methods, GPU and browser solvers, programs, and community complaints and workflows. Each search wrote dated, cited notes. This file is a synthesis of those notes; it adds no facts that the notes do not contain.
- Primary sources were read where they are public (for example NASA-STD-7009B in full, the W3C WebGPU and WGSL drafts, the TetWild, fTetWild and constrained-Delaunay papers, NASA bulletins, vendor help pages, licence files).
- Paywalled sources (ASME V&V 10, NAFEMS booklets, MacNeal-Harder 1985, most textbooks and standards) were recorded only from their abstracts or contents pages, or from public documents that quote them. They are marked "to read" and nothing is guessed about their content.
- Where sources disagree, both are given with dates, and the more reliable one is named with a reason.
- Access date for web pages without their own date: October 2026.

### Rules followed

- Public sources only. No private or company data.
- No copyleft source code was read (CalculiX, code_aster, Elmer, FEniCSx/DOLFINx, FreeCAD, Gmsh, Netgen, TetGen, OpenCASCADE and others). Their documentation, papers and licence pages were used. Licences of other projects were checked from licence files or repository metadata before anything else was opened, and in practice no project source code was opened at all.
- No commercial software was run, driven, scripted or automated. Numbers that a commercial program produced (for example in a vendor verification manual) are labelled **vendor verification result** or **vendor claim**. They describe that program only and are never used as reference values.
- No screenshots. No sign-ins, posts, votes or comments anywhere.
- Own words throughout; at most one quoted sentence at a time, with its source.

### How claims are labelled

| Label | Meaning |
|---|---|
| (no label) | A fact read in the cited source. |
| (unverified) | Carried over from the notes as not confirmed in a primary source (from memory, a search snippet or a secondary source). Do not rely on it without checking. |
| "to read" | A paywalled or unread source; only its bibliographic data or abstract was seen. |
| Vendor claim / vendor verification result | A number or statement from a vendor or vendor-hosted page. Describes that product only. |
| Opinion | A view of a forum member, blogger or analyst. |
| Inference | A conclusion drawn in the notes from cited facts, not itself a cited fact. |
| Own calculation | A worked example computed in the notes from the formula next to it. |
| Personal experience | From the author's own spike, described below. |

Units: millimetres (mm), newtons (N), megapascals (MPa = N/mm²), seconds (s), hertz (Hz), radians (rad). In this unit system mass is in tonnes (t) and density in t/mm³. Where an original benchmark uses other units, they are stated.

### Personal experience (labelled as personal experience)

The author has **no commercial FEA experience** and claims none. The only hands-on experience is **a short spike, not production use**: a self-written voxel FEA solver built in October 2026 inside the author's ScriptCAD project, over days, not years. It was written to answer one question: can linear elastic stress analysis of a real part run in the browser on the GPU, fast and accurately enough for design-time feedback? Source: the spike's own README and results summary (local project files, 28 October 2026; not a public source, not peer reviewed).

What it was:

- **Discretisation:** voxels (every solid cell is the same cube), so one 24 x 24 element stiffness matrix, scaled by the cell's Young's modulus and size, serves the whole part. Nothing is assembled: each node gathers forces from the up to 8 voxels around it. This avoids the floating-point atomic operations that WGSL lacks.
- **Element:** hex8 enriched with Wilson's incompatible modes and condensed back to 24 DOF (called hex8i here). Same cost per solve as plain hex8.
- **Solver:** matrix-free Jacobi-preconditioned conjugate gradients (Jacobi-PCG), with all scalars kept on the GPU and the residual read back every 25 iterations.
- **Three implementations with identical data layouts:** WGSL compute shaders in Chrome (float32 only), native CUDA through NVIDIA Warp (float32 or float64), and a CPU float64 reference with an assembled matrix and smoothed-aggregation AMG-preconditioned CG (PyAMG).
- **Scoring:** discretisation error against closed-form solutions (Euler-Bernoulli plus Timoshenko shear for cantilevers, Saint-Venant torsion for a tube, Lamé for a pressurised ring), never against another program's output; and solver error ||u - u64|| / ||u64|| against a float64 solve of the same voxel model.
- **Hardware:** one laptop with an NVIDIA RTX 5070 Laptop GPU and an Intel Xe-LPG integrated GPU; Chrome 156.

What it measured (one person, one machine; references are closed-form solutions; not peer reviewed):

| Finding | Measured numbers | Caveat |
|---|---|---|
| Plain float32 CG can stall at a wrong answer while reporting convergence | 2 mm wall, hex8i: tip deflection -21.1 % at 4 voxels through the wall (h = 0.5 mm), -50.7 % at 8 voxels (h = 0.25 mm), against the closed-form 0.3911 mm. Plain hex8 at h = 0.5 mm gave +18.7 %, so the error can go either way. Tightening the tolerance did not help. | Found on slender and thin-walled cases only. On the stockier ring and tube cases plain float32 was within 0.1 % of float64. |
| A translation-relative element operator removes that error | The element matrix ignores rigid translation, so each voxel's K (p - p_corner0) equals K p exactly in exact arithmetic, but in float32 it loses far fewer digits. Error against float64 dropped to 0.3-0.6 % of tip deflection (for example -0.89 % against -0.74 % for float64 at h = 1 mm). | Its own design; no published paper on this specific fix was found (see Accuracy). |
| Shear locking is real and cheap to remove | 2 voxels across a 2 mm wall (h = 1 mm): plain hex8 -12.6 %, hex8i -0.74 % tip deflection, same solve cost. | Cantilever reference uses beam theory with b = 2t to keep plate stiffening out. |
| Staircase error on curved surfaces | 2-2.5 % at 4-5 voxels through the wall: tube twist +2.49 % (0.02002 deg against 0.01953 deg, i.e. about 3.49e-4 rad against 3.41e-4 rad); ring bore growth +1.95 % (0.02806 mm against 0.02752 mm) and mean hoop stress +2.42 % (81.62 MPa against 79.7 MPa). | Mean stresses through the wall; surface peaks not scored. |
| Peak stress at load introduction does not converge | Real gearcase part: maximum von Mises 341 MPa at 0.8 mm voxels, 688 MPa at 0.5 mm voxels. The 99th percentile moved only from 34.6 MPa to 36.6 MPa. | Real part from the author's own project, no closed form; loads idealised. The author's reading: report percentiles, field plots and displacement-based quantities, not the raw maximum. |
| Jacobi-PCG iteration count grows with resolution | About 2x per halving of h (thin cantilever hex8i: 725, 1,350, 2,800 float64 iterations at h = 1, 0.5, 0.25 mm). The float64 AMG-CG reference needed 15-39 iterations on every case. | Matches textbook O(1/h) scaling for Jacobi-PCG (see Fundamentals, Solvers). |
| Browser WebGPU matched native CUDA on the same GPU | Real gearcase part, 1.52 million free DOF: 2.62 s in Chrome WebGPU against 4.76 s in native CUDA (Warp), both float32, RTX 5070 Laptop GPU; 398 k DOF: 0.43 s against 0.76 s. Float32 error against float64: 5e-5 (0.8 mm) and 9e-5 (0.5 mm); every reported quantity agreed with float64 to 3-4 significant figures. | The speed difference reflects kernel tuning, not the platform: the WGSL kernel cached the element matrix in workgroup memory, the Warp kernel read it from global memory. A tuned CUDA kernel should match or beat it. |
| The browser may be given the slow GPU | The integrated GPU was about 8x slower (20.6 s against 2.62 s at 1.52 M DOF). On this hybrid laptop Chrome used the integrated GPU by default even when the page asked for "high-performance"; it switched only after setting Chrome to high performance in Windows graphics settings and fully restarting Chrome. | One laptop, one browser version. |
| Mixed-precision refinement needs a float64 outer residual | The spike's author notes that iterative refinement works only if the outer residual is float64, which the browser does not have. | Author's observation, not separately published. |

No commercial FEA program was used for any of this.

### SolidCraft context used here

From the issue body and the house rules: SolidCraft is an open-source parametric CAD application under MIT OR Apache-2.0, written in Rust, running on the desktop and in the browser through WebAssembly (wasm) and wgpu, and it works in millimetres and radians internally. Related items listed by the requester: [#1221](https://github.com/tangency-labs/solidcraft/issues/1221) (plugin system; [comment listing plugins](https://github.com/tangency-labs/solidcraft/issues/1221#issuecomment-6179150042)), [#1569](https://github.com/tangency-labs/solidcraft/issues/1569) (SolidCraft glossary), [#785](https://github.com/tangency-labs/solidcraft/issues/785), [#922](https://github.com/tangency-labs/solidcraft/issues/922), [#923](https://github.com/tangency-labs/solidcraft/issues/923), [#1094](https://github.com/tangency-labs/solidcraft/issues/1094) (materials), [#3239](https://github.com/tangency-labs/solidcraft/issues/3239) (FieldCraft simulation branch), [discussion #2381](https://github.com/tangency-labs/solidcraft/discussions/2381) (names on faces in STEP), [#2356](https://github.com/tangency-labs/solidcraft/issues/2356) (export defects), [#834](https://github.com/tangency-labs/solidcraft/pull/834) (face-tagged 3MF), [#934](https://github.com/tangency-labs/solidcraft/issues/934), and [#6971](https://github.com/tangency-labs/solidcraft/issues/6971) (linear static request). #934 and #1569 were not reviewed in the notes (see Open questions).

## Summary

The most important findings, each detailed and cited in the sections below.

1. **The request already defines a first tier.** [solidcraft#6971](https://github.com/tangency-labs/solidcraft/issues/6971) (opened 2026-10-26) asks for a first step limited to **linear static stress analysis of a single body**: material from the library, fixed faces, pinned holes, face force, pressure, gravity and remote force as supports and loads; an automatic tet mesh with local refinement; von Mises stress, displacement and factor of safety as outputs; and a re-run when the parametric model changes. A triager asked whether single-body static was the intended first step and the requester confirmed it was. In the field's own terms, later tiers are modal analysis, linear buckling analysis, assemblies with contact, nonlinear analysis (geometric and material) and fatigue. Commercial CAD tools tier the same way: Fusion includes only linear static in the base subscription and charges tokens for the rest, and SOLIDWORKS splits analysis types across three product tiers.

2. **Volume meshing of real CAD geometry is the practical bottleneck.** Sandia-related sources put geometry preparation plus meshing at "the largest portion" of analysis effort (primary abstract, no number) or 70-80 % (secondary attributions); recent vendor surveys say about 25-38 %. On 10,000 real-world surface models (Thingi10k), TetGen produced a mesh for 49.5 %, CGAL for 79.0 %, TetWild for 99.9 % and fTetWild for 99.97 % (Hu et al. 2018, 2020). Most failures come from invalid input: only 4,408 of the 10,000 models are valid. On those valid inputs TetGen still failed on 8.6 % and a 2023 exact constrained-Delaunay method on none.

3. **No permissively licensed tet mesher reads STEP or B-rep directly.** fTetWild (MPL-2.0), geogram (BSD-3-Clause) and Quartet (ISC) are permissive but take triangle surfaces. Gmsh, Netgen, TetGen, CGAL's mesher, Mmg and pygalmesh are copyleft. The 2023 exact CDT code's licence was not checked.

4. **Mesh-avoiding methods trade boundary-stress accuracy for robustness, and most published accuracy numbers come from vendors.** Embedded-domain methods (finite cell, CutFEM, shifted boundary) can match body-fitted convergence rates in theory. Plain voxel FEM has staircase error (2-2.5 % in the author's spike; global stiffness within 4 % at coarse voxels in a bone study while local damage predictions still differed). SimSolid, Ansys Discovery Explore and Intact publish numbers such as "within 10 %", "1.7 %" or "0.422 mm against 0.421 mm", but all are vendor-run or vendor-hosted; no peer-reviewed independent accuracy study of any of them was found.

5. **Element choice alone can cause errors of tens of percent.** Linear tetrahedra in bending gave 10-70 % errors in displacement and stress (Benzley et al. 1995, secondary citation). Fully integrated linear bricks reach only about 56 % of the theoretical tip deflection of a cantilever (Abaqus documentation). Quadratic tets and bricks reach a few percent on the same problems. The author's spike measured -12.6 % for plain hex8 against -0.74 % for the incompatible-mode hex8i.

6. **The peak stress is the least trustworthy number on the screen.** At sharp re-entrant corners, point loads and edges of fixed faces the exact elastic stress is infinite, so the computed peak grows with every refinement. Commercial convergence checks (SOLIDWORKS energy-norm target, Creo percent convergence, Ansys 20 % default) measure global quantities; SOLIDWORKS help itself says its target is not the stress accuracy. Users on every major forum report "stress keeps rising as I refine the mesh".

7. **Verification and validation have clear, free frameworks.** NASA-STD-7009B (2024-03-05) is free and requires every reported result to carry a best estimate, an uncertainty statement or an explicit "none available", credibility levels, and explicit warnings when assumptions or limits are violated. ASME V&V 10-2019 and NAFEMS ESQMS:01 are paywalled and were not read.

8. **A permissively usable benchmark set exists.** Ten closed-form cases (cantilever, Lamé cylinder, tube torsion, Kirsch hole, plate, Euler column, beam frequencies, thermal bar, Hertz contact, manufactured solutions) need no licence. Published targets confirmed in two or more public documents: NAFEMS LE1 92.7 MPa, LE10 -5.38 MPa, LE11 -105 MPa, Scordelis-Lo roof 0.3024 (ft) and the pinched cylinder 1.8248e-5 (in). Hemisphere, twisted beam, FV32 and Cook's membrane targets are unverified.

9. **GPU and browser solving is feasible but has hard constraints.** WGSL (W3C draft 2026-10-26) has no 64-bit float and only integer atomics. Default WebGPU limits are 128 MiB per storage binding, 256 MiB per buffer and 16 KiB of workgroup memory, and a watchdog may stop long GPU work. wasm32 is capped at 4 GiB; Memory64 shipped in Chrome 133 and Firefox 134 but not Safari. Permissive GPU solver libraries exist (AmgX BSD-3-Clause, hypre Apache-2.0 OR MIT, Ginkgo BSD-3-Clause, AMGCL MIT, MFEM BSD-3-Clause, libCEED BSD-2-Clause, NVIDIA Warp Apache-2.0 since 2025-03-07) but none targets WebGPU. The author's spike found browser WebGPU on par with native CUDA on the same GPU, and found plain float32 CG unsafe on thin walls.

10. **Live-in-CAD competitors already exist.** Ansys Discovery (voxel GPU "Explore" mode plus meshed "Refine" mode), Altair/Siemens SimSolid (meshless "external approximations") and Creo Simulation Live (built on Discovery technology) give results in seconds. Their vendors position the fast mode as trend-level and advise validating with a conventional solver.

11. **ML surrogates need training data and give no error bound.** Ansys SimAI typically needs 30-100 simulations to train; its confidence score is a distance to the training data, and Ansys's own documentation says it is not correlated with error. NVIDIA PhysicsNeMo (Apache-2.0) is a framework, not a product with an accuracy claim. Simcenter PhysicsAI, Neural Concept and Monolith publish no accuracy figures.

12. **What users ask for.** In SolidCraft's own tracker the clearest user story is the export-check-edit-re-export round trip on every design change (#6971, #3239), supported by requests to keep face names (#2381, #834) and engineering material data (#785, #922, #923, #1094) attached to the model. Across vendor forums the recurring complaints are misread results (singularities, ambiguous factor of safety), Fusion's 2022 move to cloud-only solving and per-solve tokens, and weak handling of contact, welds and bolts in assemblies. Vote counts could not be collected (Reddit and Autodesk forums were not reachable), so the ordering of themes is by how often they recur, not by votes.

## Fundamentals

Citation note for this section. Standard theory is cited to the main textbooks: Cook, Malkus, Plesha and Witt, *Concepts and Applications of Finite Element Analysis*, 4th ed., Wiley 2001/2002 (cited as Cook 2002); Zienkiewicz, Taylor and Zhu, *The Finite Element Method: Its Basis and Fundamentals*, 7th ed., 2013 (8th ed. 2024 with Govindjee exists; cited as Zienkiewicz 2013); Bathe, *Finite Element Procedures*, 2nd ed., 2014; Belytschko, Liu, Moran and Elkhodary, *Nonlinear Finite Elements for Continua and Structures*, 2nd ed., 2014. These books were not opened during the research, so **chapter numbers are (unverified)**; the formulas are the same in every major text. Worked numbers marked "own calculation" were computed in the notes from the formula next to them.

### Analysis tiers: what the request covers and what comes later

**Fact about the request.** [solidcraft#6971](https://github.com/tangency-labs/solidcraft/issues/6971), "Simulation: linear static stress analysis (FEA) for parts", was opened on 2026-10-26. The requester designs sheet-metal and machined parts for motion simulators. Each design iteration today means exporting STEP, checking the part in another program, editing, and re-exporting. The issue asks for a first step limited to linear static analysis of a single body. Per the research brief, its scope is: fixed faces, pinned holes, face force, pressure, gravity and remote force; an automatic tet mesh with local refinement; von Mises stress, displacement and factor of safety; and a parametric re-run. A triager found no stress command in SolidCraft 0.23.1 and asked whether single-body static was the intended first step. The requester replied that it was fine as a start. The issue was closed the same day; the close reason is not stated in its comments (unverified why). Source: [solidcraft#6971](https://github.com/tangency-labs/solidcraft/issues/6971), read 2026-10-28.

The table places that request among the analysis types in the field's own terms. It describes the physics and inputs; it does not propose an order of work.

| Analysis type | What it adds over the one above | Extra inputs the user must supply | Where covered below |
|---|---|---|---|
| Linear static analysis, single body (the #6971 scope) | Displacement, strain and stress under time-independent loads; small strain, small rotation, linear elastic material. Solves K u = f once. | Young's modulus E, Poisson's ratio ν, yield or ultimate strength for a factor of safety, density for gravity. Supports and loads. | Governing equations to Reading results |
| Modal analysis | Natural frequencies and mode shapes from (K - ω²M)φ = 0. Needs only K and the mass matrix M. | Density. | Dynamics |
| Linear buckling analysis | Load multiplier at which K plus the geometric stiffness becomes singular. Needs a linear static solution first. | Reference load case. Imperfection or knock-down factor to make it safe. | Buckling |
| Assemblies with contact | Several bodies; parts may separate, slide or press together. Contact is nonlinear. | Contact type, friction coefficient, bolt preload. | Supports and loads; Nonlinearity |
| Nonlinear analysis | Large displacement or rotation (geometric), plasticity or rubber (material), contact. Incremental and iterative. | Stress-strain curves, hyperelastic constants, load steps. | Materials; Nonlinearity |
| Dynamic response | Harmonic, transient, response-spectrum and random vibration, usually built on modes. | Damping, load history or spectrum. | Dynamics |
| Fatigue | Life or damage from cyclic stress, usually a post-processing step on static or dynamic stress results. | S-N or strain-life data, load history, surface and size factors, mean-stress rule. | Fatigue |

Commercial CAD tools tier in a similar way:

- Autodesk Fusion includes linear static stress in the base subscription. Modal, thermal, thermal stress and shape optimisation are "Basic" studies at 3 tokens per solve; buckling, event simulation, nonlinear static, injection moulding and electronics cooling are "Advanced" at 6 tokens, or covered by the Simulation Extension subscription ([Autodesk Flex rate sheet, accessed 2026-10](https://autodesk.com/flexratesheet-ppr); [Fusion Simulation Extension blog](https://www.autodesk.com/products/fusion-360/blog/fusion-360-simulation-extension/)).
- SOLIDWORKS Simulation is sold as Standard, Professional and Premium; its in-product verification problems are flagged by the tier they need ([SOLIDWORKS blog, 2013-06](https://blogs.solidworks.com/solidworksblog/2013/06/simulation-tip-solidworks-simulation-verification-problems.html)).
- Inventor's built-in Stress Analysis covers linear static and modal; Inventor Nastran adds more types (list unverified) ([Autodesk Support "h refinement threshold"](https://knowledge.autodesk.com/support/inventor-products/learn-explore/caas/sfdcarticles/sfdcarticles/h-refinement-threshold-s.html)).
- Onshape Simulation covers linear static and modal only ([Onshape Simulation page, accessed 2026-10](https://www.onshape.com/en/features/simulation)).

Inference (from the programs notes): the CAD-embedded tier converges on the same base set, which is linear static plus modal on solids with an automatic tet mesh and von Mises, displacement and factor-of-safety plots.

### Governing equations

**Strong form** (Cook 2002 ch. 3-4; Zienkiewicz 2013 ch. 2-3; chapters unverified):

- Equilibrium: ∂σ_ij/∂x_j + b_i = 0 in the volume V, where σ is the Cauchy stress and b the body force per unit volume (for gravity b = ρg).
- Displacement boundary condition: u_i = ū_i on the supported surface S_u.
- Traction boundary condition: σ_ij n_j = t̄_i on the loaded surface S_t.
- The strong form needs second derivatives of u everywhere.

**Weak form (principle of virtual work)** (same chapters):

- For every admissible virtual displacement δu with δu = 0 on S_u: ∫_V δε : σ dV = ∫_V δu·b dV + ∫_{S_t} δu·t̄ dS.
- Only first derivatives of u appear, so shape functions that are continuous but kinked between elements (C0) are enough.
- Traction conditions are satisfied in the integral sense ("natural"). Displacement conditions must be built into the trial functions ("essential").

**Minimum total potential energy** (Cook 2002 ch. 4; Felippa, *Introduction to Finite Element Methods*, University of Colorado ASEN 5007 lecture notes, Fall 2004 version, which circulates on mirrors such as [Scribd](https://www.scribd.com/doc/53200407/Introduction-to-Finite-Element-Methods); version unverified):

- Π(u) = ½∫ε:C:ε dV - ∫u·b dV - ∫u·t̄ dS. For linear elastic, conservative problems the exact u minimises Π.
- Consequence: a compatible displacement model is too stiff. Its displacements are too small in the energy sense (Cook 2002 ch. 4; section unverified).
- Inference (from the notes): an under-refined mesh usually gives deflections and stresses that are too low, which is unconservative. The exceptions are stresses at singularities, which grow without bound, and some reduced-integration or hybrid elements, which can be too flexible.

**Small strain and finite strain** (Belytschko 2014 ch. 3; Bathe 2014 ch. 6; unverified chapters):

- Linear analysis uses ε = ½(∇u + ∇uᵀ). This measure is not invariant under rigid rotation: a rigid rotation by θ produces a spurious strain of order θ²/2.
- Finite-strain analysis uses the Green-Lagrange strain E = ½(FᵀF - I) with F = I + ∇u, paired with the second Piola-Kirchhoff stress.
- Own calculation: a rigid rotation of 0.1 rad gives a spurious linear strain of about 1 - cos(0.1) ≈ 0.005. With E = 210 000 MPa that is about 1 050 MPa of false stress. This is why thin cantilevers and cables that rotate a lot need geometric nonlinearity even while strains stay elastic.

**Hooke's law, isotropic** (Cook 2002 ch. 1, 3):

- σ = λ tr(ε) I + 2μ ε, with λ = Eν/((1+ν)(1-2ν)), μ = G = E/(2(1+ν)), bulk modulus K_b = E/(3(1-2ν)).
- Own calculation, steel (E = 210 000 MPa, ν = 0.3): G = 80 769 MPa, λ = 121 154 MPa, K_b = 175 000 MPa.
- Own calculation, as ν approaches 0.5: K_b = 16.7 E at ν = 0.49 and 1 667 E at ν = 0.4999. This blow-up drives volumetric locking (Element problems).

**From weak form to K u = f** (Cook 2002 ch. 2; Felippa, direct stiffness chapters, unverified):

- Interpolate u ≈ N d in each element; strain ε = B d, with B the derivatives of the shape functions N.
- Element stiffness k_e = ∫ Bᵀ C B dV; element load f_e = ∫ Nᵀ b dV + ∫ Nᵀ t̄ dS.
- Add every k_e into the global stiffness matrix K by element connectivity, apply the supports, and solve K u = f.
- K is symmetric and sparse. It is positive definite only once rigid-body motion is suppressed.

**Worked check value (own calculation).** Steel cantilever, L = 100 mm, square section 10 x 10 mm, tip load F = 100 N:

- I = bh³/12 = 833.3 mm⁴.
- Euler-Bernoulli tip deflection δ = FL³/(3EI) = 0.1905 mm.
- Root bending stress σ = Mc/I = (100 N x 100 mm x 5 mm)/833.3 mm⁴ = 60.0 MPa.
- Timoshenko shear term FL/(κGA) = 0.0015 mm, which is +0.8 %.

### Elements

**Shape functions** (Cook 2002 ch. 3, 6; Zienkiewicz 2013 ch. 6):

- Each N_i equals 1 at its own node and 0 at the others, and they sum to 1, so rigid translation is represented exactly.
- tet4: linear in volume coordinates, so strain is constant in the element ("constant strain tetrahedron").
- tet10: quadratic (corner functions L_i(2L_i - 1), mid-edge functions 4L_iL_j), so strain varies linearly.
- hex8: trilinear, N_i = ⅛(1+ξξ_i)(1+ηη_i)(1+ζζ_i). hex20: quadratic serendipity. hex27: full quadratic Lagrange.

**Isoparametric mapping** (Cook 2002 ch. 6; Bathe 2014 ch. 5):

- Geometry and displacement use the same shape functions: x = Σ N_i(ξ) x_i. The Jacobian J = ∂x/∂ξ converts derivatives and volumes (dV = det J dξ dη dζ).
- det J must stay positive everywhere. Zero or negative det J means a folded or inverted element whose stiffness is meaningless.
- Curved quadratic elements with mid-side nodes far off the straight line can push det J towards zero (section unverified).

**Numerical integration** (Cook 2002 ch. 6):

- n Gauss points per direction integrate a polynomial of degree 2n - 1 exactly.
- Usual full rules: hex8 2x2x2, hex20 3x3x3 (some codes use a 14-point rule, unverified), tet4 1 point, tet10 4 points.
- Reduced integration (hex8 with 1 point, hex20 with 2x2x2) avoids locking but risks hourglass modes.
- For distorted elements the integrand is rational, so no Gauss rule is exact.

**Linear against quadratic, tet against hex:**

- Benzley, Perry, Merkley, Clark and Sjaardema (1995), *A comparison of all hexagonal and all tetrahedral finite element meshes for elastic and elasto-plastic analysis*, Proc. 4th International Meshing Roundtable, Sandia, pp. 179-191. Their abstract reports a strong preference for linear hexes over linear tets, says quadratic formulations significantly improve both, and that in shear-dominated plasticity linear hexes may beat quadratic tets ([abstract via BibSonomy](https://www.bibsonomy.org/bibtex/1186886d560f3171c13e0dc8b71bdb4ce)). Full text "to read".
- Kalbag (1992), *Finite Elements in Analysis and Design* 12, pp. 313-318, reportedly found quadratic tets and hexes equivalent in accuracy and CPU time ([IBM listing, search summary](https://researchweb.draco.res.ibm.com/publications/a-performance-study-of-tetrahedral-and-hexahedral-elements-in-3-d-finite-element-structural-analysis)). Full paper "to read".
- Schneider et al. (2019), *A large scale comparison of tetrahedral and hexahedral elements for finite element analysis*, summarise that quadratic tets and hexes perform similarly, quadratic hexes cost more, and linear tets are too stiff ([PDF](https://web.uvic.ca/~teseo/profile/publications/tet-vs-hex/Schneider.2019.tet-vs-hex.pdf); search snippet; full paper not read). The accuracy notes record from a snippet that quadratic tets outperformed hexes in all their settings. The two snippet summaries differ in emphasis; the full paper resolves it ("to read").
- Inference (from the notes): for automatically tet-meshed CAD solids, tet10 is the practical baseline in commercial practice; tet4 needs very fine meshes in bending.

**h- and p-refinement** (Szabó and Babuška, *Finite Element Analysis*, 1991, 2nd ed. 2021; Zienkiewicz 2013 ch. 13-14; chapters unverified):

- h-refinement makes elements smaller at fixed polynomial order p. For smooth solutions the energy-norm error falls as O(h^p).
- p-refinement raises the order on a fixed mesh. For smooth solutions the error falls exponentially in p. Near singularities both converge only algebraically unless the mesh is graded (hp).
- Displacement converges one order faster than stress: O(h^(p+1)) against O(h^p).
- Own calculation: for tet10 (p = 2) in the asymptotic range, halving h should cut the stress error about 4x and the displacement error about 8x.

**Solid, shell and beam idealisation** (Cook 2002 ch. 15-16; Zienkiewicz, Taylor and Fox, *The FEM for Solid and Structural Mechanics*, 7th ed., 2014):

- Beams need a cross-section much smaller than the length. Euler-Bernoulli (no shear deformation) is good to about 1 % when L/h ≳ 10 (own calculation above: 0.8 % at L/h = 10). Timoshenko beams cover stubbier members.
- Plates and shells: thin (Kirchhoff) theory for span/thickness above roughly 20; thick (Mindlin-Reissner) theory for about 5-20; solid below about 5. These thresholds are rules of thumb that vary by source (unverified as exact numbers).
- Shells cannot report through-thickness stress and miss 3D effects at joints, fillets and load points.
- Solid models of thin walls need several elements through the thickness, or at least one quadratic layer. A vendor forum example (Mecway forum, 2015) reports one tet10 layer matched quad8 shells closely in bending but needed about 4.4x as many nodes (38 603 against 8 737) (vendor claim; [Mecway forum](https://mecway.com/forum/discussion/comment/378), search snippet).

### Element problems

**Shear locking** (Cook 2002 ch. 6, 15; Zienkiewicz 2013):

- Edges of a linear quad or hex stay straight, so pure bending produces spurious shear strain that absorbs energy. The element is far too stiff when it is slender in the bending plane.
- The same happens in thin plates and shells as thickness goes to zero.
- Remedies: quadratic elements, reduced or selective integration, incompatible modes, assumed-strain methods.
- Measured example (vendor documentation): fully integrated first-order elements reach only about 56 % of the theoretical tip deflection of a cantilever even on an 8 x 24 mesh, while quadratic elements reach 0.994-1.000 ([Abaqus Analysis User's Guide, "Full integration", 2017 docs](https://abaqus-docs.mit.edu/2017/English/SIMACAEGSARefMap/simagsa-c-ctmfull.htm)). The phenomenon is general textbook theory; the number describes that element family.
- Personal experience: plain hex8, 2 voxels across a 2 mm wall, tip deflection -12.6 %; hex8i -0.74 %.

**Volumetric locking** (Hughes, *The Finite Element Method*, 1987/Dover 2000, ch. 4; Belytschko 2014 ch. 8):

- As ν approaches 0.5 the bulk modulus dwarfs the shear modulus, and low-order elements cannot keep the volume constant at every integration point. Displacements come out near zero and pressure oscillates (checkerboard).
- It appears in rubber and in metal plasticity, where plastic flow keeps volume constant.
- Remedies: selective reduced integration, B-bar, mixed displacement-pressure (u/p) elements, F-bar at finite strain. A 2009 review also names locking as a drawback of tetrahedra for nearly incompressible materials ([arXiv 0911.3884](https://arxiv.org/pdf/0911.3884)).

**Hourglass modes** (Belytschko 2014 ch. 8; Flanagan and Belytschko 1981, IJNME 17:679-706, details unverified):

- A one-point hex8 has 12 deformation modes with no strain at its centre point, so they carry no stiffness; a one-point quad4 has 2. They show as zig-zag patterns.
- Fixes: hourglass control (artificial stiffness or viscosity), full or selective integration. A commonly quoted check is that hourglass energy stays under 5-10 % of internal energy (unverified).

**Distortion sensitivity.** Accuracy drops with aspect ratio, skew, taper, warped faces and det J near zero. Altair publishes its own MacNeal-Harder straight-cantilever results, normalised to the reference (**vendor verification result**, describes OptiStruct only; [Altair OptiStruct help](https://help.altair.com/hwsolvers/os/topics/solvers/os/straight_cantilever_beam_verification_r.htm), accessed 2026-10):

| Element | Mesh shape | In-plane bending | Transverse bending | Twist |
|---|---|---|---|---|
| hex8 | rectangular | 0.978 | 0.973 | 0.892 |
| hex8 | parallelogram | 0.624 | 0.529 | 0.820 |
| hex8 | trapezoidal | 0.047 | 0.030 | 0.563 |
| hex20 | rectangular | 0.992 | 0.992 | 0.905 |
| hex20 | parallelogram | 0.976 | 0.977 | 0.905 |
| hex20 | trapezoidal | 0.902 | 0.950 | 0.905 |

The point it illustrates: distortion can make a linear brick 20-30x too stiff while a quadratic brick barely changes.

**Incompatible-mode element** (Cook 2002 ch. 6; Wilson, Taylor, Doherty and Ghaboussi 1973, in *Numerical and Computer Methods in Structural Mechanics*, Academic Press, pp. 43-57; Taylor, Beresford and Wilson 1976, IJNME 10:1211-1219; bibliographic details unverified):

- Adds internal bubble modes (1-ξ²), (1-η²), (1-ζ²) to hex8 so it can bend; they are condensed out inside the element.
- Wilson's original version fails the patch test on non-parallelogram shapes. Taylor et al. (1976) fixed this by evaluating the extra mode derivatives with the Jacobian at the element centre.
- Programs ship it as "incompatible modes", "enhanced strain" or C3D8I.
- Personal experience: on regular voxels (always parallelograms) this element is the hex8i used in the spike.

**Patch test** (Irons and Razzaque 1972, in *Mathematical Foundations of the FEM*, Academic Press; Zienkiewicz 2013 ch. 9):

- Impose boundary displacements matching a constant-strain field on a small patch of distorted elements; every element must reproduce the constant strain exactly.
- Taylor, Simo, Zienkiewicz and Chan (1986), IJNME 22:39-62, [doi:10.1002/nme.1620220105](https://doi.org/10.1002/nme.1620220105): per its abstract the patch test is a necessary condition for convergence (equivalent to consistency) and, extended to check stability, also sufficient ([UTAS record](https://figshare.utas.edu.au/articles/journal_contribution/The_patch_test_-_a_condition_for_assessing_FEM_convergence/22944206)). Wikipedia says the patch test is in general neither necessary nor sufficient ([Wikipedia, accessed 2026-10](https://en.wikipedia.org/wiki/Patch_test_(finite_elements))). The 1986 paper is the primary and more reliable statement; the disagreement is about which version of the test is meant.

**MacNeal-Harder test set.** R. H. MacNeal and R. L. Harder, "A proposed standard set of problems to test finite element accuracy", *Finite Elements in Analysis and Design* 1 (1985) 3-20, [doi:10.1016/0168-874X(85)90003-4](https://doi.org/10.1016/0168-874X(85)90003-4). Paywalled; a scanned copy could not be text-extracted. It contains patch tests and beam, plate and shell problems: the straight cantilever with rectangular, trapezoidal and parallelogram meshes, curved beam, twisted beam, rectangular plate, Scordelis-Lo roof, hemispherical shell and a thick-walled cylinder at ν up to 0.4999 (problem list from memory plus vendor listings; dimensions unverified).

**Why tet4 is too stiff in bending.** It has constant strain, so it can only make a staircase of the linearly varying bending strain, and its stress is constant per element, so the peak surface stress is underestimated (Cook 2002 ch. 3, 6). Benzley et al. (1995) found that linear tets in a rectangular bar in bending gave **10-70 % errors in both displacement and stress**, while linear hexes, quadratic hexes and quadratic tets were acceptable even on coarse meshes. This number comes through the 2009 review [arXiv 0911.3884](https://arxiv.org/pdf/0911.3884); the primary paper was not read and the mesh densities behind the range are unknown.

### Meshing and convergence

#### Mesh convergence studies and error estimates

- **Convergence study** (Cook 2002 ch. 9, unverified; Roache, *Verification and Validation in Computational Science and Engineering*, Hermosa 1998): refine globally or locally by a constant ratio r (often 2), watch a quantity of interest (peak stress away from singularities, maximum deflection, first frequency), and check that it changes monotonically by ever smaller amounts. "Converged" means the change is below a user-chosen tolerance, such as 2-5 %; no standard fixes the threshold.
- **Richardson extrapolation and observed order** (Roache 1994, J. Fluids Eng. 116:405-413, pages unverified; Celik et al. 2008, J. Fluids Eng. 130:078001): with fine, medium and coarse results f1, f2, f3 at constant ratio r:
  - observed order p = ln((f3 - f2)/(f2 - f1)) / ln r;
  - extrapolated value f_ext = f1 + (f1 - f2)/(r^p - 1);
  - grid convergence index GCI_fine = F_s · |(f1 - f2)/f1| / (r^p - 1).
- **Safety factor F_s**: 1.25 with three or more grids in the asymptotic range, 3.0 with only two grids ([cfd-verify docs](https://cfd-verify.readthedocs.io/en/stable/discretization_uncertainty.html); [arXiv 2103.14559](https://arxiv.org/pdf/2103.14559); [arXiv 2309.05509](https://arxiv.org/pdf/2309.05509); secondary sources that agree). A 2021 paper notes that the 95 % confidence claimed for F_s = 1.25 rests on no published statistical sample ([arXiv 2103.14559](https://arxiv.org/pdf/2103.14559), snippet). Xing and Stern proposed a factor-of-safety method because GCI can give unreasonably small uncertainty when the observed order exceeds the theoretical one ([U. Iowa course PDF](https://user.engineering.uiowa.edu/~me_160/CFD%20Labs/xing.pdf), snippet).
- **Own calculation**: peak fillet stress on three tet10 meshes with r = 2 of 91.0, 97.0 and 100.0 MPa gives p = ln(6/3)/ln 2 = 1.0 (below the theoretical 2, a hint the meshes are not yet asymptotic), f_ext = 103 MPa and GCI_fine = 1.25 x 0.03 = 3.75 %, so "100 MPa ± 3.75 MPa". A negative p or an oscillating sequence makes the extrapolation meaningless.
- **Zienkiewicz-Zhu (ZZ) error estimator** (Zienkiewicz and Zhu 1987, IJNME 24:337-357, [doi:10.1002/nme.1620240206](https://doi.org/10.1002/nme.1620240206); the 1992 superconvergent patch recovery (SPR) papers, IJNME 33:1331-1364 and 1365-1382, pages unverified): element stresses jump between elements; a smoother recovered field σ* is built by nodal averaging (1987) or local least-squares fits at superconvergent points (1992). The energy-norm error is estimated from ∫(σ* - σ_h)ᵀ C⁻¹ (σ* - σ_h) dV, element by element. A code_aster reference document (R4.10.01) says the 1987 version was found to underestimate error for even-degree elements, which led to SPR ([code_aster R4.10.01, mirror](https://ericca.uqtr.ca/fr14.4/man_r/r4/r4.10.01.pdf); documentation, snippet).
- **Adaptive meshing** (Zienkiewicz 2013 ch. 14): refine elements whose estimated local error exceeds the allowed average and repeat. Near a singularity the estimator keeps refining forever, so adaptivity needs a minimum element size or an exclusion of known singular features.

#### Volume meshing of CAD geometry: the practical bottleneck

**How much time it takes (sources disagree):**

| Figure | What it says | Source and reliability |
|---|---|---|
| "Largest portion", no number | Geometry manipulation and meshing is the largest part of an analyst's effort, especially for structural problems. | Hardwick, Clay, Boggs, Walsh, SAND2005-4647 "DART system analysis", 2005-08-01, abstract ([Sandia](https://sandia.gov/research/publications/details/dart-system-analysis-2005-08-01)). Primary, but the abstract gives no percentage. |
| > 70 % | Model preparation takes over 70 % of total analysis time. | A SMiRT-20 paper citing "Hardwick (2005)" ([NCSU repository](https://repository.lib.ncsu.edu/server/api/core/bitstreams/ef3d4985-b353-419b-bc83-5bd47187f0a4/content)); also a 2021 European LS-DYNA conference paper (Shepherd, BYU) ([dynalook](https://www.dynalook.com/conferences/13th-european-ls-dyna-conference-2021/crash/shepherd_brigham_young_university.pdf/view)). Secondary; not found in the primary abstract (unverified). |
| "Upwards of three-quarters" | Not unusual for meshing to take that share of simulation time. | Sandia Cubit 15.7 manual, ITEM chapter ([Sandia](https://www.sandia.gov/files/cubit/15.7/help_manual/WebHelp/item/item.htm)). |
| 80 % (60 % geometry, 20 % meshing) | Analysis-suitable geometry about 60 %, mesh generation about 20 %, analysis about 20 %. | Attributed to Ted Blacker (Sandia) in a TU Delft thesis ([TU Delft](https://repository.tudelft.nl/file/File_87125b2e-8786-4531-8c12-81681972e24c?preview=1)). Secondary attribution (unverified). |
| About 38 % | Preprocessing share of analysis time. | Spatial blog, 2026-04-21 ([Spatial](https://blog.spatial.com/fem-preprocessing-is-the-bottleneck)). Vendor claim; no study cited. |
| About 25 % | Preprocessing share. | Tech-Clarity/Siemens infographic, 2016 ([Siemens PDF](https://www.plm.automation.siemens.com/media/global/es/Siemens-PLM-Addressing-bottlenecks-in-the-simulation-process-infographic_tcm54-58950.pdf)). Vendor-affiliated; extracted text garbled (unverified). |

Inference (from the notes): the figures differ by a factor of 2-3. The high ones are older, from defence-lab and crash contexts with complex geometry; the low ones are recent vendor marketing. Neither is a robust measurement. A NAFEMS UK 2020 abstract (CFD context) names mesh generation performance and robustness as main impediments without a percentage ([NAFEMS c_nov_20_uk_11](https://www.nafems.org/publications/resource_center/c_nov_20_uk_11)).

**How tet meshers work:**

- Production tet meshers combine a constrained Delaunay or advancing-front core, boundary recovery with Steiner points, and refinement plus optimisation for quality and sliver removal ([Diazzi et al. 2023](https://cims.nyu.edu/gcl/papers/2023-CDT.pdf), sec. 2; textbook: Cheng, Dey and Shewchuk, *Delaunay Mesh Generation*, CRC 2012, [book page](https://people.eecs.berkeley.edu/~jrs/meshbook.html), "to read").
- In 3D, some polyhedra cannot be tetrahedralised without extra (Steiner) points. Diazzi, Panozzo, Vaxman and Attene (ACM TOG, SIGGRAPH Asia, Sept 2023) identify an algorithmic gap in TetGen's cavity expansion that can fail on valid input regardless of floating-point issues ([PDF](https://cims.nyu.edu/gcl/papers/2023-CDT.pdf), secs. 3.5, 6).
- **Exact against approximate boundary conformity:** Diazzi et al. state that DelPSC, CGAL, Quartet and TetWild give only approximate boundary conformity, even with sharp-feature preservation; only TetGen, a 2021 method (DA2021) and their own method keep the input surface exactly ([Diazzi et al. 2023](https://cims.nyu.edu/gcl/papers/2023-CDT.pdf), sec. 6). In their example, lowering CGAL's protected-edge angle below 15° caused convergence failure.
- **Envelope-based meshing (TetWild 2018):** inserts input triangles with exact rational arithmetic, then lets the boundary move within a user-set ε-envelope of the input, rounds to floats and optimises ([Hu et al. 2018](https://www.cs.toronto.edu/~jacobson/images/tetrahedral-meshing-in-the-wild-siggraph-2018-compressed-hu-et-al.pdf), secs. 3-4). With its k = 2 setting, 99.98 % of outputs had a minimum dihedral angle above 1° (99.52 % with k = 1).
- **fTetWild (2020)** defaults: envelope ε = 1e-3 x the bounding-box diagonal d, target edge length d/20, optimisation stops at maximum AMIPS energy below 10 or after 80 iterations; output elements are guaranteed to have positive volume and float coordinates, but not every input triangle is guaranteed to be inserted (all were in their tests) ([Hu et al. 2020, arXiv 1908.03581](https://ar5iv.arxiv.org/html/1908.03581)). It supports per-face tags (`--tag`, `--epsr-tags`).
- **Quality metrics** in this literature: AMIPS energy (3 for an ideal tet), minimum dihedral angle, volume-to-edge ratio, aspect ratio, radius-edge ratio ([fTetWild](https://ar5iv.arxiv.org/html/1908.03581)). Sandia's Verdict library (BSD) computes standard element-quality metrics ([Cubit licensing page](https://cubit.sandia.gov/licensing/)).
- **Slivers:** flat tetrahedra with no short edge. Sliver exudation (Cheng, Dey, Edelsbrunner, Facello, Teng, J. ACM 47(5):883-904, 2000) assigns vertex weights so that the weighted Delaunay mesh has none; the provable angle bound is positive but tiny, and experiments suggest it works well in practice ([ISTA record](https://research-explorer.ista.ac.at/record/4010); [Edelsbrunner and Guoy](https://people.eecs.berkeley.edu/%7Ejrs/meshpapers/EdelsbrunnerGuoy.pdf)).
- **Isosurface stuffing (Quartet):** builds a signed distance field on a grid from a watertight triangle surface and fills it with an acute tetrahedral tiling; boundary accuracy is limited by grid spacing ([Quartet README](https://github.com/crawforddoran/quartet), ISC).
- **Curved quadratic meshes:** snapping tet10 mid-edge nodes onto curved CAD faces can create invalid elements. Johnen, Remacle and Geuzaine use Bézier bounds on the Jacobian determinant to prove validity; Toulorge et al., J. Comput. Phys. 254:8-26 (2013), untangle invalid elements by optimisation ([Gmsh preprint](https://gmsh.info/doc/preprints/gmsh_curved2_preprint.pdf); [Geuzaine preprint](https://people.montefiore.uliege.be/geuzaine/preprints/curvilinear_preprint.pdf); [Toulorge abstract](https://dial.uclouvain.be/pr/boreal/en/object/boreal%3A130557); papers only, no code opened).
- **Hex meshing:** no general automatic all-hex mesher exists for arbitrary B-rep solids; Sandia Cubit relies on sweeping, mapping and user-guided decomposition ([Cubit ITEM](https://www.sandia.gov/files/cubit/15.7/help_manual/WebHelp/item/item.htm); the general claim beyond Cubit's docs is unverified).
- **CAD input quality:** STEP files exported from CAD are often not watertight in the tolerance sense; faces carry their own tolerances and small gaps and slivers between faces are common. No quantitative public survey was found (unverified). SolidCraft's own example: [#2356](https://github.com/tangency-labs/solidcraft/issues/2356) reports a Boolean retry that left a step of about 1e-4 mm (0.1 µm); the STL export had 19 open and 70 non-manifold edges, the 3MF export 41 open and 35 non-manifold, and an external mesher (FieldCraft 0.7.0) refused the face-tagged 3MF as an invalid boundary surface with 76 defects.

**Robustness numbers on real-world surfaces.** All on Thingi10k, a public set of 10,000 3D-printing surface models (not CAD B-reps):

| Mesher | Success rate | Average time | Source |
|---|---|---|---|
| TetGen | 49.5 % | 32.3 s | [Hu et al. 2018](https://www.cs.toronto.edu/~jacobson/images/tetrahedral-meshing-in-the-wild-siggraph-2018-compressed-hu-et-al.pdf) Table 2; [Hu et al. 2020](https://ar5iv.arxiv.org/html/1908.03581) Table 2 (limits 3 h, 32 GB) |
| CGAL, explicit polyhedral oracle, no feature protection | 79.0 % | 11.7 s | same |
| CGAL with feature protection | 57.2 % (5.4 % out of memory, 15.7 % timeout) | not recorded | Hu et al. 2018 |
| CGAL, implicit oracle | 55.7 % (32.6 % timeout) | 997.3 s | Hu et al. 2018 |
| DelPSC | 37.1 % | not recorded | Hu et al. 2018 |
| Quartet | 87.2 % | 15.3 s | Hu et al. 2018 |
| MMG3D | 56.2 % | 2,182.3 s | Hu et al. 2018 |
| TetWild (2018) | 99.89 % (100 % within 27 h) | 360 s | Hu et al. 2018, 2020 |
| fTetWild (2020) | 99.97 % (100 % within 11 h) | 49.8 s on 8 cores; 80.4 s serial | Hu et al. 2020 |
| TetGen, on the 4,408 valid inputs only | 91.4 % (fails on 378) | not recorded | [Diazzi et al. 2023](https://cims.nyu.edu/gcl/papers/2023-CDT.pdf), sec. 6 |
| Diazzi et al. exact CDT, on the 4,408 valid inputs | 100 % (cavity-expansion fallback on 2) | 95.2 % of models under 10 s (TetGen 98.5 %) | Diazzi et al. 2023 |
| TetGen, 3,000-model subset | 59.1 % (1,183 failures, 46 timeouts at 20 min) | not recorded | [arXiv 2106.01326](https://arxiv.org/pdf/2106.01326) (snippet; unverified) |

Further details:

- Only 4,408 of the 10,000 Thingi10k models are valid piecewise-linear complexes (no self-intersections and so on). Setting TetGen's vertex-snapping tolerance (default 1e-8) to zero raised its failures on valid input from 378 to 720 ([Diazzi et al. 2023](https://cims.nyu.edu/gcl/papers/2023-CDT.pdf)).
- On the 4,540 models where all four of CGAL, TetGen, TetWild and fTetWild succeed, average times were fTetWild 18.5 s, TetGen 22 s, CGAL 95 s, TetWild 107 s; fTetWild finished 98.7 % within 2 min ([Hu et al. 2020](https://ar5iv.arxiv.org/html/1908.03581)).
- The fTetWild text claims 100 % success while its Table 2 shows 99.97 %; the difference is three models that needed more than 3 h but finished within 11 h. Both statements are in the same paper and consistent once the time limit is taken into account.
- Inference (from the notes): robust tet meshing of clean, valid input is largely solved (about 90-100 % success); the remaining bottleneck is invalid input (gaps, self-intersections, tiny features) and defeaturing decisions. These benchmarks are on STL models, not CAD B-reps; no equivalent benchmark on a STEP corpus (such as the ABC dataset) was found.

**Meshers and their licences** (licence pages or repository front pages, accessed 2026-10):

| Mesher | Licence | Kind | Input | Boundary conformity | Source |
|---|---|---|---|---|---|
| fTetWild | MPL-2.0 (the notes class it as permissive; MPL-2.0 file-level conditions were not analysed in the notes, unverified) | Envelope-based tet mesher | Triangle surface (.off/.obj/.stl/.ply) | Approximate, within ε; per-face tags | [wildmeshing/fTetWild](https://github.com/wildmeshing/fTetWild); dependency GMP is LGPL (unverified) |
| pytetwild (Python wrapper) | MPL-2.0 | Wrapper | as fTetWild | as fTetWild | [PyPI](https://pypi.org/project/pytetwild) |
| geogram | BSD-3-Clause | 3D Delaunay, 2D constrained Delaunay | Points, surfaces | No 3D constrained Delaunay claimed on the front page; optional third-party parts unchecked (unverified) | [BrunoLevy/geogram](https://github.com/BrunoLevy/geogram) |
| Quartet | ISC | Isosurface stuffing | Watertight triangle surface | Approximate | [crawforddoran/quartet](https://github.com/crawforddoran/quartet) |
| Diazzi-Attene CDT (2023) | Not checked (unverified) | Exact constrained Delaunay | Valid PLC | Exact | [Diazzi et al. 2023](https://cims.nyu.edu/gcl/papers/2023-CDT.pdf), sec. 5; code at github.com/MarcoAttene/CDT |
| Verdict (Sandia) | BSD | Quality metrics only | Mesh | n/a | [Cubit licensing](https://cubit.sandia.gov/licensing/) |
| Gmsh | GPL-2.0-or-later with a linking exception (copyleft) | Full mesher; uses OpenCASCADE | STEP/IGES B-rep and others | Exact | [gmsh.info](https://gmsh.info/), stable 4.15.2 (2026-03-24) |
| Netgen | LGPL-2.1 (copyleft) | Tet mesher | STEP/IGES via a geometry kernel, CSG, STL | Exact | [NGSolve/netgen](https://github.com/NGSolve/netgen) |
| TetGen | AGPL-3.0-or-later, or commercial from WIAS | Constrained Delaunay | PLC | Exact | [TetGen licence FAQ](https://wias-berlin.de/software/tetgen/1.5/FAQ-license.html); latest 1.5.0 (2013-11-04) |
| CGAL Mesh_3, triangulations, tetrahedral remeshing | GPL, or commercial (commercial seller unverified) | Delaunay refinement | Surfaces, implicit functions | Approximate | [CGAL package overview 6.2.1](https://doc.cgal.org/latest/Manual/packages.html) (geometry kernels are LGPL) |
| pygalmesh | GPL-3.0 plus commercial | CGAL front end | Implicit, surface, voxel | as CGAL | [meshpro/pygalmesh](https://github.com/meshpro/pygalmesh) |
| Mmg | LGPL-3 | Remesher (adapts an existing mesh) | Existing mesh | n/a | [MmgTools/mmg](https://github.com/MmgTools/mmg) |
| TetWild (2018) | Mixed or unclear ("MPL with some GPL code", one listing says GPL-3.0) (unverified) | Envelope-based | Triangle surface | Approximate | [awesome.ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2Fyixin-hu%2Ftetwild); [Blender devtalk](https://devtalk.blender.org/t/gsoc-2020-soft-body-sim-discussion-and-suggestions/13765) |
| SALOME SMESH | LGPL (version unverified) | Mesher | CAD | Exact | not confirmed on a licence page |
| Sandia Cubit / Coreform Cubit | US-government use only / commercial | Hex and tet, interactive | CAD | Exact | [cubit.sandia.gov/licensing](https://cubit.sandia.gov/licensing/); [develop3d](https://develop3d.com/simulation/coreform-acquires-cubit-cae-meshing-technology/) |
| Triangle (2D only) | Custom; no redistribution for compensation (effectively non-commercial) | 2D constrained Delaunay | 2D | Exact | as quoted in [MeshPy LICENSE](https://gitlab.tiker.net/inducer/meshpy/-/raw/main/LICENSE) |
| Rust crates (spade, "tetra"-named crates) | Not checked (unverified) | | | | |

Inference (from the notes): none of the permissive meshers reads STEP or a B-rep. All of them take a triangle surface, so a watertight, face-tagged tessellation is the input they need. Exact face conformity, which matters for face loads and supports, comes naturally from constrained-Delaunay meshers; envelope methods keep face identity only through tags and place the boundary within ε of the input. No study was found that measures the stress error caused by fTetWild's ε-boundary against an exactly conforming mesh. Gmsh's linking exception does not make Gmsh permissive.

**Defeaturing research.** Buffa, Chanon and Vázquez developed a posteriori estimators of the error caused by removing geometric features ("analysis-aware defeaturing"): Poisson with one Neumann feature (M3AS 2022, [doi:10.1142/S0218202522500099](https://infoscience.epfl.ch/entities/publication/37c143d3-fd63-4aeb-b9fc-6b06b34bdd08)), an adaptive strategy that decides which feature to put back, with IGA (arXiv 2212.05183, Dec 2022, [mirror](https://deepai.org/publication/adaptive-analysis-aware-defeaturing)), and a follow-up covering multiple features, linear elasticity and Stokes ([EPFL](https://infoscience.epfl.ch/items/0226100f-07c4-4991-967a-9cd7ecf5e613)). Theory so far covers traction-free (Neumann) features best.

#### Mesh-avoiding methods

These methods avoid building a body-fitted volume mesh. They put the body on a simple background grid, or use no mesh at all.

**Voxel FEM.**

- Voxel boundaries give stair-stepped surfaces. A 2002 study found voxel models not feasible for contact, and composite studies report spurious local stress peaks at jagged boundaries ([Univ. Iowa voxel contact article](https://iro.uiowa.edu/esploro/outputs/journalArticle/A-Voxel-based-Formulation-for-Contact-Finite/9984040564602771) and related search results; snippet level, unverified).
- Bone micro-FE: in a femur study comparing 20, 40 and 80 µm voxels, 40 µm was enough for boundary displacements and principal strains. In 14 vertebrae, stiffness at 3 mm voxels was on average only 4 % above high-resolution models (p = 0.03), yet damage predictions differed significantly (p = 0.01) ([arXiv 2512.24401](https://arxiv.org/pdf/2512.24401); [Lievers bone database](https://wbldb.lievers.net/10200880.html); search summaries, unverified). Global stiffness converges before local strain or damage does.
- Large-scale voxel FEM is routine in topology optimisation: Aage, Andreassen, Lazarov and Sigmund, "Giga-voxel computational morphogenesis for structural design", *Nature* 550:84-86 (2017), optimised a full-scale wing ([RePEc](https://ideas.repec.org/a/nat/nature/v550y2017i7674d10.1038_nature23911.html)). The commonly quoted 1.1 billion voxels, PETSc multigrid-preconditioned Krylov solver and about 8,000 CPU cores for several days are unverified (the paper page could not be read).
- Voxel finite cell with phase-field (diffuse) boundary conditions can match sharp-surface accuracy if interface width, voxel spacing and mesh size are related properly ([CRIS IUCC record](https://cris.iucc.ac.il/en/publications/phase-field-boundary-conditions-for-the-voxel-finite-cell-method-/)).
- Personal experience: 2-2.5 % staircase error on curved surfaces at 4-5 voxels through the wall; shear locking removed by hex8i.

**Finite cell method (FCM).** Combines a fictitious domain, high-order shape functions and adaptive integration of cut cells. Dauge, Düster and Rank (J. Sci. Comput. 2015) prove exponential convergence under p-extension for Laplace and Lamé problems in 1D-3D and confirm it on an elasticity benchmark ([Dauge page](https://perso.univ-rennes1.fr/monique.dauge/publis/DaDusRank.html)); review by Schillinger and Ruess, Arch. Comput. Methods Eng. 2015 ([doi:10.1007/s11831-014-9115-y](https://www.doi.org/10.1007/S11831-014-9115-Y)). Original papers: Parvizian, Düster and Rank, Comput. Mech. 41:121-133 (2007); Düster et al., CMAME 197:3768-3782 (2008) (to read; unverified). Known issues (unverified in a primary source): ill-conditioning from small cut cells, costly cut-cell integration and weak imposition of supports.

**CutFEM.** Burman, Claus, Hansbo, Larson and Massing, "CutFEM: Discretizing geometry and partial differential equations", IJNME 104(7):472-501 (2015), doi 10.1002/nme.4823 ([UCL Discovery](https://discovery-pp.ucl.ac.uk/id/eprint/1471066)). Aims at robust unfitted FEM on cut meshes for CAD or image geometry. Ghost-penalty stabilisation (bounding the condition number whatever the cut) and Nitsche's method (weak supports) are its standard ingredients but were not confirmed in the abstract (unverified).

**Shifted boundary method (SBM).** Main and Scovazzi, J. Comput. Phys. 2018, Parts I-II: boundary conditions move to a surrogate boundary made of whole elements and are corrected by a Taylor expansion, so no cut-cell integration is needed ([Duke Scholars](https://scholars.duke.edu/publication/1916955)). A 2026 "Gap-SBM" paper reports sub-optimal L2 convergence of primal SBM on linear elements with traction boundary conditions in solid mechanics and fixes it with gap integration ([DukeSpace thesis](https://dukespace.lib.duke.edu/items/94a1ee98-cd85-40ea-a7f6-64c1c97789fd/full)). High-order SBM: Atallah, Canuto and Scovazzi 2022 ([PDF](https://iris.polito.it/retrieve/handle/11583/2973271/6c33bb53-8f21-4d96-bc7f-77f417699aa3/SBM_High-Order.pdf)).

**Isogeometric analysis (IGA).** Hughes, Cottrell and Bazilevs, CMAME 194:4135-4195 (2005), doi 10.1016/j.cma.2004.10.008: analysis uses the CAD's NURBS basis; in 2016 it was still the most downloaded CMAME paper ([Hughes 2016 slides](https://www.ices.utexas.edu/~babuska/babuska_forum/slides/Tom_Hughes_Babuska_2016.pdf); [Oden report 2006](https://www.oden.utexas.edu/media/reports/2006/0604.pdf)). CAD B-reps are trimmed surface NURBS, but solid IGA needs a volumetric spline, which CAD does not give, so trimmed patches need immersed or FCM-type treatment (widely stated; unverified in a primary source).

**Meshless methods.** Element-free Galerkin (Belytschko, Lu and Gu, IJNME 37:229-256, 1994) and the reproducing kernel particle method (Liu, Jun and Zhang, 1995) still need a background integration grid and special handling of supports (to read; unverified). SimSolid uses "external approximations" (Apanovitch; described in his book *The Method of External Finite Element Approximations*) ([Altair product intro](https://2021.help.altair.com/2021/ss/topics/simsolid/get%20started/product_intro_r.htm)).

**Commercial mesh-avoiding tools.** Ansys Discovery's Explore mode voxelises geometry and runs CUDA GPU solvers, which per Ansys removes mesh generation; Refine mode uses meshed Mechanical and Fluent solvers; case size is limited by GPU memory ([Ansys FAQ](https://innovationspace.ansys.com/knowledge/forums/topic/what-simulation-technology-does-ansys-discovery-use-in-explore-mode/); [SimuTech 2024 R1](https://simutechgroup.com/?p=13395)). Intact Solutions' "Immersed Method of Moments" discretises space into cells independent of the geometry and integrates over the implicit domain in cut cells; it is used in Intact.Simulation for nTop ([Intact](https://intact-solutions.com/?p=7588)).

**Monte Carlo walk on spheres (WoS).** Sawhney and Crane (SIGGRAPH 2020) solve Poisson and Laplace-type problems pointwise without a mesh. Extensions cover varying coefficients (2022), mixed boundary conditions via Walk on Stars (SIGGRAPH 2023, [arXiv 2302.11815](https://arxiv.org/pdf/2302.11815)), surface PDEs (2024) and time-dependent diffusion (arXiv 2609.12306, 2026). The curated resource list shows no 3D linear elasticity WoS paper ([mcgp-resources](https://rohan-sawhney.github.io/mcgp-resources/)); Walk on Stars mentions elasticity only as a possible direction. Elasticity work: Sabelfeld, Shalimova and Levykin, random walk on fixed spheres for Laplace and Lamé equations (2006, [TIB](https://oa.tib.eu/renate/handle/123456789/3156)); Shalimova and Sabelfeld (2023), branching WoS for the 2D elastostatic Lamé equation (cited in [arXiv 2608.07017](https://arxiv.org/pdf/2608.07017)).

**Published accuracy numbers for mesh-avoiding methods, with who published them:**

| Method / product | Published number | Compared against | Who published it | Status |
|---|---|---|---|---|
| Voxel FEM (bone micro-FE) | Stiffness +4 % on average at 3 mm voxels; damage predictions significantly different (p = 0.01) | High-resolution voxel models | Independent academic ([arXiv 2512.24401](https://arxiv.org/pdf/2512.24401); [Lievers](https://wbldb.lievers.net/10200880.html)) | Snippet level (unverified) |
| Voxel FEM (bone, femur) | 40 µm voxels enough for boundary displacements and principal strains | 20 µm voxels | Independent academic (same) | Snippet level (unverified) |
| Voxel FEM, hex8i (author's spike) | Staircase error 2-2.5 % on curved surfaces at 4-5 voxels per wall; hex8i thin wall -0.74 % (2 voxels) | Closed-form Lamé, torsion, beam | Personal experience, not peer reviewed | One machine, one person |
| Voxel FEM, contact | "Not feasible" for contact | not recorded | Independent academic (2002) | Snippet level (unverified) |
| Finite cell method | Exponential convergence under p-extension, proven and confirmed numerically for Lamé | Exact solutions | Independent academic (Dauge, Düster, Rank 2015) | Rates only; no stress-error tables read |
| CutFEM | No number read | | | Gap |
| Shifted boundary method | Sub-optimal L2 rate with traction boundary conditions on linear elements; fixed by gap integration | Convergence theory | Independent academic (Gap-SBM 2026) | Rates only |
| IGA | No number read | | | Gap |
| Walk on spheres (elasticity) | No 3D elasticity method found; 2D Lamé only | | Independent academic | Gap |
| SimSolid | Static stresses within 10 % on 18 models | SOLIDWORKS Simulation results | Third-party user (Dr Richard King), hosted by the vendor ([Altair validation guide](https://web.altair.com/simsolid_validation_guide); [Altair blog](https://altair.com/blog/articles/Is-SimSolid-Accurate-We-Dare-You-to-Find-Out!)) | Vendor claim |
| SimSolid | Maximum stress 1.7 % off; NX Nastran tet10 at default mesh 41 % off, refined 24 % off; Inventor adaptive about 27 % off; reference about 10,300 psi (about 71 MPa) from manual mesh refinement | Converged conventional FEA of a welded tube joint | Vendor blog ([Altair blog, now redirects to Siemens](https://altair.com/blog/articles/Comparing-Altair-SimSolid-with-a-FEA-Benchmark)) | Vendor claim |
| SimSolid | 8 benchmarks; example 0.82 MPa against a 0.802 MPa target (2.2 %), another 0 % | Mesh-converged conventional FEA | NAFEMS staff author (Ian Symington, *Benchmark* magazine, 2020-01), distributed by the vendor ([Altair/Siemens resource](https://altair.com/resource/nafems-simsolid-benchmark)); example figures from a reseller deck ([Symetri](https://www.symetri.us/media/jwzixymu/large-scale-assemblies-webinar.pdf)) | Independent author, vendor-distributed; full tables not read |
| SimSolid | 21 NAFEMS benchmarks (LE1, LE2, LE3, LE6, FV2, FV4, FV12, FV22, FV32, FV52, R0016 x 4, R0015 x 2, P16 x 2, R0049, R0065, R0024) | NAFEMS targets | Vendor-performed, listed by NAFEMS ([NAFEMS Code Verification, SimSolid 2022.3](https://www.nafems.org/publications/code-verification/simsolid-code-verification/)) | Vendor verification result; percentages only in the downloadable manual |
| SimSolid | "Good correlation" on large assemblies | HyperWorks FEA | Customer pilot (CNH), vendor-hosted ([Altair](https://altairengineering.fr/resource/piloting-simsolid-for-fast-directional-feedback)) | Vendor claim |
| Ansys Discovery Explore | Maximum temperature 2.7 % (Explore), 0.3 % (Refine) | Ansys Fluent (thermal CFD, not structural) | Vendor partner webinar ([DRD](https://drd.com/discovery-webinar-2-6_27_24-empowering-design-engineers-with-faster-and-more-accurate-gpu-physics-solvers)) | Vendor claim |
| Ansys Discovery Explore | "Up to 10x" accuracy improvement for thin features (2024 R1) | Previous release | Vendor ([Ansys webinar](https://www.ansys.com/webinars/ansys-2024-r1-ansys-discovery-whats-new)) | Vendor claim |
| Ansys Discovery Live (older release) | Stresses about 80 % higher than Mechanical on the same model | Ansys Mechanical | Single user, 2020 ([Ansys forum](https://innovationspace.ansys.com/knowledge/?p=159582)) | Anecdotal |
| Ansys Discovery Explore (fluid) | 7,572.7 Pa at highest fidelity, against 1,475 Pa (Refine) and 1,411.59 Pa (CFX) | Ansys CFX | Single user ([Ansys forum](https://innovationspace.ansys.com/forum/forums/topic/very-different-results-in-explore-and-refine-mode)) | Anecdotal, fluid; another user found Explore closer to STAR-CCM+ than Refine ([Ansys forum](https://innovationspace.ansys.com/forum/?p=372062)) |
| Intact IMM | Connecting-rod displacement 0.422 mm against 0.421 mm; no stress comparison | nTop FEA | Vendor ([Intact](https://intact-solutions.com/?p=7588)) | Vendor claim |
| Creo Simulation Live | No percentages public; verification models compared with calculated results, Creo Simulate and Discovery | | Vendor ([PTC verification guide, Creo 12](https://support.ptc.com/help/creo/creo_pma/r12/usascii/simulate/simulation_live/verification_models_sim_live.html)) | Gap |

Inference (from the notes): in every embedded or meshless method, displacement and global stiffness converge faster than boundary stress, and boundary (peak) stress is exactly what voxel and low-order cut methods resolve worst. Vendor comparisons also depend on how well converged their reference was: the vendor's own welded-tube example shows a body-fitted tet10 mesh at default size can be 24-41 % off at a stress concentration. **No peer-reviewed independent accuracy study of SimSolid, Ansys Discovery Explore or Intact IMM was found.**

### Supports and loads

- **Rigid-body modes** (Cook 2002 ch. 2): a free 3D body has 6 zero-energy modes (3 translations, 3 rotations). K is singular until at least 6 independent DOF are restrained. Too few supports gives a singular-matrix or zero-pivot error, or huge displacements. Partial under-restraint can hide inside assemblies (a mechanism, or frictionless contact). Workarounds: inertia relief, soft springs.
- **Over-restraint** (Cook 2002 ch. 9, unverified): fixing whole faces in all three directions blocks Poisson contraction and thermal expansion. It creates artificial stress peaks at the edge of the support (a re-entrant-corner type singularity) and a stiffer response. Example: a beam with both end faces fixed shows end-face singularities and less deflection than a real bolted joint allows.
- **Symmetry** (Cook 2002 ch. 9): a symmetry plane takes zero normal displacement and zero in-plane rotation, valid only if geometry, material, loads and supports are all symmetric. In modal and buckling analysis symmetric supports suppress antisymmetric modes, which can hide the lowest mode.
- **Point loads and point supports** (Cook 2002 ch. 9; Boussinesq solution): in 3D a point force on a half-space gives displacement proportional to 1/r and stress to 1/r². Under a nodal point load in a solid mesh, displacement and stress at that node grow without limit as the mesh is refined; they are mesh artefacts. In 2D (Flamant) displacement goes as ln r. Point loads are valid in beam and shell theory; in solids, loads are spread over a realistic area.
- **Remote loads: kinematic against distributing coupling** (textbook-level summary; RBE2 and RBE3 are Nastran element names, "kinematic" and "distributing coupling" are Abaqus terms, "rigid" and "deformable" remote loads appear in other programs; vendor definitions not read, unverified):
  - Kinematic coupling (RBE2): attached nodes follow a reference node rigidly. This adds infinite stiffness to the face, so the face cannot deform and stress at its edge is overestimated.
  - Distributing coupling (RBE3): the reference node's motion is a weighted average of the attached nodes; the load is spread by force and moment balance and adds no stiffness.
  - Own illustration: 1 000 N applied 50 mm off a bolt-hole face carries a 50 000 N·mm moment. Distributing coupling spreads it as a linearly varying traction on the hole face; kinematic coupling forces the hole to stay perfectly round and rigid.
- **Bolt preload** (Shigley's *Mechanical Engineering Design*, 10th ed., 2015, ch. 8, unverified): modelled as an initial axial strain or force in the bolt shank, applied in a first step and then locked while service loads are added. It needs contact between the clamped parts to capture separation, which makes the analysis nonlinear. Shigley's guidance for reusable joints is preload about 0.75 x proof load (unverified).
- Boundary conditions are often called the most common source of large FEA errors in practice; this is expert opinion found in NAFEMS literature, not a measured statistic (unverified).
- Inference (from the notes): with fixed-face and pinned-hole supports on a single body, spurious peaks at the edges of fixed faces are the most likely misleading output, and stress read about one section depth away from them is meaningful (Saint-Venant).

### Singularities and stress concentrations

- **Re-entrant corners** (Williams 1952, J. Appl. Mech. 19:526-528, pages unverified; Szabó and Babuška 1991): near a sharp corner, stress varies as r^(λ-1) with 0 < λ < 1. For a 270° (L-shaped) corner λ ≈ 0.5445 in the symmetric mode (last digit unverified), so stress goes as r^-0.456. A crack (360°) gives λ = 0.5, stress as r^-½; that is the basis of linear elastic fracture mechanics, K_I = σ√(πa)·Y.
- **Point loads**: see Supports and loads (stress as 1/r² in 3D).
- **Saint-Venant's principle** (Timoshenko and Goodier, *Theory of Elasticity*, 3rd ed., 1970, chapter unverified; Cook 2002 ch. 9): two statically equivalent load distributions give stress fields that differ only within about one characteristic dimension of the loaded region. Stress about one section depth away from an idealised load or support can be trusted even when the local peak cannot.
- **Stress concentration factor Kt** (Pilkey and Pilkey, *Peterson's Stress Concentration Factors*, 3rd ed., Wiley 2008, "to read"): Kt = σ_max/σ_nom. Kirsch solution: a circular hole in an infinite plate under uniaxial tension gives Kt = 3.0 (Timoshenko and Goodier). A commonly quoted finite-width value is Kt (net) ≈ 2.5 at d/W = 0.2 (unverified). A converged fillet stress can be checked against Kt x σ_nom.
- **Notch sensitivity** (Shigley 10th ed. ch. 6, unverified): fatigue factor Kf = 1 + q(Kt - 1); small radii in high-strength steel have q close to 1.
- **Hot-spot (structural) stress, IIW** (Hobbacher, *Recommendations for Fatigue Design of Welded Joints and Components*, IIW-2259-15, 2nd ed., Springer 2016, "to read"; 3rd ed. 2024 by Hobbacher and Baumgartner, [doi:10.1007/978-3-031-57667-6](https://doi.org/10.1007/978-3-031-57667-6), also "to read"): the weld toe stress is mesh-dependent, so surface stress is extrapolated linearly from reference points outside the notch zone. For type "a" hot spots on a fine mesh, σ_hs = 1.67 σ(0.4t) - 0.67 σ(1.0t), with t the plate thickness; type "b" uses 4, 8 and 12 mm with quadratic extrapolation; hot-spot S-N classes are about FAT 90 and FAT 100 (all from memory, unverified).
- **Effective notch stress, IIW**: weld toe and root are modelled with a fictitious radius r_ref = 1 mm (for plate thickness ≥ 5 mm in steel and aluminium; the thickness limit is unverified), with FAT 225 for steel. Hobbacher (2003) reported that, based on Neuber's theory and more than 80 fatigue test series, steel welds can be modelled with a 1 mm fictitious radius, adopted by IIW ([Paton Welding Journal 2003](https://patonpublishinghouse.com/eng/journals/tpwj/2003/10/17), snippet). Pedersen et al. (Int. J. Fatigue 2010) found most fillet-weld data agree well with FAT 225 but suggest FAT 200 for some cases ([AAU PDF](https://vbn.aau.dk/ws/files/221973786/Pedersen_IJF2010.pdf), snippet). For thin joints r_ref = 0.05 mm (and 0.3 mm in some studies) is used with other FAT classes ([LUT paper](https://lutpub.lut.fi/bitstream/10024/162057/3/rohani_raftar_et_al_re-evaluation_of_weld_final_draft.pdf), snippet; the 0.05 mm IIW value is unverified). Mesh guidance of about r/4 with quadratic elements is unverified.
- Inference (from the notes): the fingerprint of a singularity is a peak that keeps rising with refinement (observed order p ≤ 0 in the GCI procedure); the fingerprint of a real stress concentration is convergence to a finite value. Personal experience shows the same fingerprint: 341 MPa to 688 MPa at a load introduction, while the 99th percentile barely moved.

### Materials

- **Inputs for linear static** (inference from the notes): E, ν, density (for gravity and modes), yield strength and ultimate tensile strength, and whether these are typical or minimum values.
- **Orthotropic and composite linear elastic** (Jones, *Mechanics of Composite Materials*, 2nd ed., 1999, chapters unverified): orthotropic materials have 9 independent constants (E1, E2, E3, G12, G13, G23, ν12, ν13, ν23); transversely isotropic ones have 5. Laminates use classical lamination theory (ABD matrix). Failure criteria include Tsai-Wu, Tsai-Hill, Hashin and maximum stress. Material axes must be oriented per element; getting them wrong is a typical error.
- **Plasticity** (Simo and Hughes, *Computational Inelasticity*, 1998, ch. 2-3; de Souza Neto, Perić and Owen, *Computational Methods for Plasticity*, 2008): von Mises (J2) yield f = σ_vm - σ_y(ε̄_p) ≤ 0, associative flow, volume-preserving plastic flow, radial return algorithm. Hardening: isotropic, kinematic (Prager, Armstrong-Frederick) or combined. Input is true stress against true plastic strain: σ_t = σ_e(1 + ε_e), ε_t = ln(1 + ε_e), valid up to necking. Perfect plasticity at a singularity gives unbounded local plastic strain.
- **Hyperelastic rubber** (Holzapfel, *Nonlinear Solid Mechanics*, 2000, ch. 6; Ogden 1972, Proc. R. Soc. Lond. A 326:565-584, unverified):
  - Neo-Hookean W = C10(Ī1 - 3) + (1/D1)(J - 1)², initial shear modulus μ = 2C10.
  - Mooney-Rivlin W = C10(Ī1 - 3) + C01(Ī2 - 3) + ..., μ = 2(C10 + C01).
  - Ogden W = Σ (2μ_i/α_i²)(λ̄1^α_i + λ̄2^α_i + λ̄3^α_i - 3) plus a volumetric term; normalisation of μ_i varies between texts and programs.
  - Fit to several deformation modes (uniaxial, equibiaxial, planar shear); a fit to uniaxial data alone can be unstable in other modes (Drucker stability check). Nearly incompressible materials need mixed u/p elements.
- **Viscoelasticity** (Ferry, *Viscoelastic Properties of Polymers*, 3rd ed., 1980; Simo and Hughes 1998 ch. 10, unverified): relaxation modulus as a Prony series G(t) = G∞ + Σ G_i e^(-t/τ_i); time-temperature superposition with a shift factor (WLF above Tg, Arrhenius below).
- **Creep** (Penny and Marriott, *Design for Creep*, 2nd ed., 1995, unverified): Norton law ε̇_cr = A σ^n for secondary creep, n typically 3-8 for metals (unverified range); stress redistributes from peaks over time.
- **Where test data comes from** (titles and scope from general knowledge; documents paywalled, "to read"; current revisions unverified): ASTM E8/E8M (tension testing of metals: yield, ultimate, elongation); ASTM E111 (Young's modulus); ASTM E1049-85 (cycle counting); MMPDS (successor to MIL-HDBK-5), which defines A-basis as the value at least 99 % of the population exceeds with 95 % confidence and B-basis as 90 % with 95 % confidence (definitions standard; MMPDS not opened).
- **Scatter**: typical coefficients of variation of roughly 1-5 % for modulus and ultimate strength of metals, 5-10 % for yield, and much more for fatigue life, with a factor-of-10 scatter in life at one stress level common (all unverified; no primary source fetched). Own illustration: a steel grade might have a typical yield of 300 MPa against a specification minimum of 235 MPa, so a factor of safety must say which it is based on.
- **SolidCraft context**: [#922](https://github.com/tangency-labs/solidcraft/issues/922) states that density alone does not make a material ready for FEA; [#923](https://github.com/tangency-labs/solidcraft/issues/923) (closed 2026-10-14) describes typed SI material cards with isotropic E/ν or orthotropic E/G/ν, tensile, compressive, yield and shear strengths, thermal properties and source records.

### Nonlinearity

- **Residual form and Newton-Raphson** (Bathe 2014 ch. 6, 8; Belytschko 2014 ch. 6; Crisfield, *Non-linear Finite Element Analysis of Solids and Structures*, Vol. 1, 1991): solve R(u) = f_ext(λ) - f_int(u) = 0 by K_T Δu = R, u ← u + Δu, with tangent stiffness K_T = ∂f_int/∂u (material plus geometric stiffness). Convergence is quadratic near the solution if K_T is consistent. Modified Newton and quasi-Newton (BFGS) are cheaper per iteration but converge more slowly.
- **Load stepping** (Crisfield 1991): apply the load in increments, each converged before the next, with automatic cut-back on failure. Path-dependent materials need small steps for accuracy, not only for convergence.
- **Arc-length (Riks, Crisfield)** (Riks 1979, Int. J. Solids Struct. 15:529-551; Crisfield 1981, Comput. Struct. 13:55-62; pages unverified): the load factor becomes an unknown with a constraint ‖Δu‖² + ψ²Δλ²‖f‖² = Δl², which lets the solver pass limit points (snap-through) and follow post-buckling paths.
- **Own illustration**: a 1-DOF softening spring f_int = k u (1 - u/u0) has K_T = k(1 - 2u/u0), which is zero at u = u0/2; the limit load is k u0/4 and load control cannot continue beyond it.
- **Convergence criteria** (Bathe 2014 ch. 8): force ‖R‖ ≤ ε_f ‖f_ext‖; displacement ‖Δu‖ ≤ ε_u ‖u‖; energy |Δuᵀ R| ≤ ε_e x its initial value. Typical force tolerances are 1e-3 to 1e-2 (program defaults differ; unverified). Loose tolerances accumulate path error.
- **Contact** (Wriggers, *Computational Contact Mechanics*, 2nd ed., 2006; Laursen, *Computational Contact and Impact Mechanics*, 2002):
  - Conditions: gap g ≥ 0, contact pressure p ≥ 0, p·g = 0.
  - Penalty method: p = ε_N ⟨-g⟩, allowing small penetration; too small ε_N gives large penetration, too large gives ill-conditioning; ε_N is often chosen relative to element stiffness, for example 0.1-10 x E/h (unverified rule).
  - Lagrange multipliers enforce g = 0 exactly but give an indefinite (saddle-point) matrix.
  - Augmented Lagrange combines penalty with multiplier updates.
  - Coulomb friction: stick when |t_T| < μp, slip otherwise; makes K_T unsymmetric and the solution path-dependent.
  - Node-to-surface or surface-to-surface (mortar) discretisation; mortar passes the contact patch test better (chapter unverified).
- **Geometric stiffness (stress stiffening)**: a tensioned membrane gets stiffer and a compressed column softer under load; this geometric stiffness K_σ is also the basis of linear buckling analysis (Cook 2002 ch. 18, unverified).
- Inference (from the notes): linear static analysis excludes all three nonlinearities, so a linear result is only meaningful while rotations stay small, stress stays below yield and parts would not separate.

### Solvers

**Direct and iterative solvers** (George and Liu, *Computer Solution of Large Sparse Positive Definite Systems*, 1981; Davis, *Direct Methods for Sparse Linear Systems*, SIAM 2006; Saad, *Iterative Methods for Sparse Linear Systems*, 2nd ed., SIAM 2003, ch. 6, 9, 10, 13):

- Direct: K = LLᵀ (Cholesky) or LDLᵀ for indefinite systems (Lagrange contact, u/p). Fill-in is reduced by ordering (nested dissection, minimum degree). Nested dissection on a regular 3D grid of n unknowns gives fill O(n^(4/3)) and work O(n²); in 2D, O(n log n) and O(n^(3/2)) (George 1973, SIAM J. Numer. Anal. 10:345-363 for 2D; 3D estimates standard; details unverified). Once factorised, extra load cases cost only substitutions.
- Iterative: preconditioned conjugate gradients (PCG) for symmetric positive definite K. Iterations grow as √κ, where κ is the condition number. For second-order elliptic problems κ = O(h⁻²), so plain or Jacobi-preconditioned CG needs O(1/h) iterations. With algebraic multigrid (AMG) iteration counts stay nearly constant, so total work is close to O(n). Smoothed aggregation for elasticity uses the rigid-body modes as its near-null space.
- Iterative solvers struggle with thin shells modelled as solids, large stiffness jumps (steel with rubber), near-incompressibility, soft springs and nearly unsupported models.
- **Conditioning**: κ grows with refinement, aspect ratio, stiffness contrast and penalty values. Digits lost ≈ log10(κ); in double precision (about 16 digits) with κ = 1e10, about 6 significant digits remain.
- **Memory (own back-of-envelope, unverified magnitudes)**: a tet10 mesh has about 80 nonzeros per row of K; for 1 million DOF the stored matrix needs about 1 GB with indices, and a direct factor several times more.
- Inference (from the notes): for single-part linear static models up to a few hundred thousand DOF a sparse direct solver is robust; above that, or within browser memory limits, PCG with AMG becomes attractive. This is a performance trade-off reported in the notes, not a recommendation.
- Personal experience: float64 AMG-CG needed 15-39 iterations on every spike case, while Jacobi-PCG needed 525-3,750 (float64) and doubled per halving of h.

**Time integration** (Hughes 1987 ch. 9; Bathe 2014 ch. 9; Belytschko 2014 ch. 6):

- Implicit Newmark average acceleration (β = 1/4, γ = 1/2) is unconditionally stable for linear systems with no numerical damping; HHT-α adds controlled high-frequency damping. Each step solves a linear system.
- Explicit central difference uses a lumped (diagonal) mass, needs no solve, and is stable only for Δt ≤ 2/ω_max ≈ L_min/c, with c = √(E/ρ) in 1D.
- Own calculation, steel: c = √(210 000 MPa / 7.85e-9 t/mm³) = 5.17e6 mm/s; a 1 mm element gives Δt_crit ≈ 0.19 µs; simulating 10 ms takes about 52 000 steps. Halving the smallest element halves Δt, which is why explicit codes use mass scaling.
- Explicit suits short events (impact, crash); implicit suits static, modal and long dynamic analyses.

**GPU-friendly methods: matrix-free, multigrid, PCG, mixed precision**

- **Matrix-free operator application**: the stiffness matrix is never stored; K·u is computed element by element from quadrature or a precomputed element matrix. In deal.II this is cell-based evaluation with sum factorisation (Kronbichler and Kormann, Computers and Fluids 63 (2012) 135-147, doi:10.1016/j.compfluid.2012.04.012; ACM TOMS 45(3) (2019) art. 29; to read, bibliographic data unverified). For tensor-product hex elements of degree p in 3D, sum factorisation cuts per-element work from O(p⁶) to O(p⁴) with O(p³) data (unverified this session). For trilinear hex8 the gain is small, and applying one precomputed 24 x 24 element matrix is the usual voxel approach (unverified). Kronbichler et al. study merging vector updates into the operator sweep for cache locality ([arXiv 2205.08909](https://arxiv.org/abs/2205.08909), to read).
- **CG convergence**: error reduction per iteration is bounded by (√κ - 1)/(√κ + 1) (Saad 2003 sec. 6.11; Shewchuk 1994, "An introduction to the conjugate gradient method without the agonizing pain"; standard, unverified this session). Inference (from the notes): the author's measured 2x iterations per halving of h is exactly this O(1/h) scaling; with per-iteration cost growing as h⁻³ in 3D, total Jacobi-PCG work grows roughly as h⁻⁴ against h⁻³ for multigrid-preconditioned CG.
- **Multigrid** as a preconditioner gives iteration counts independent of h for elliptic problems (Trottenberg, Oosterlee and Schüller, *Multigrid*, Academic Press 2001; to read). Chebyshev polynomial smoothers need only matrix-vector products and the diagonal, with no inner products, and are the default smoother in deal.II's matrix-free multigrid and in libCEED and MFEM GPU examples (unverified). Damped Jacobi is the simplest fully parallel smoother (unverified).
- **Algebraic multigrid**: smoothed aggregation (Vaněk, Mandel and Brezina, Computing 56 (1996) 179-196) and classical Ruge-Stüben AMG (1987); to read. GPU AMG exists in AmgX, hypre BoomerAMG, Ginkgo and AMGCL.
- **Domain decomposition**: BDDC (Dohrmann 2003, SIAM J. Sci. Comput. 25(1) 246-258) and FETI/FETI-DP (Farhat and Roux 1991; Farhat et al. 2001) have condition numbers bounded by C(1 + log(H/h))² (to read; unverified). They need local direct solves per subdomain.
- Inference (from the notes): methods that need only matrix-vector products, the diagonal, vector updates and dot products (Jacobi-PCG, Chebyshev smoothing, geometric multigrid on structured grids) fit compute-shader APIs without float atomics or sparse factorisation. AMG setup and BDDC/FETI local direct solves are much harder to express in WGSL.
- **Mixed precision**:
  - Carson and Higham, "Accelerating the Solution of Linear Systems by Iterative Refinement in Three Precisions", SIAM J. Sci. Comput. 40(2) (2018) A817-A847: separate precisions for the working data, the correction solve and the residual, with rounding-error bounds and GMRES-based refinement ([Manchester eprint 2629](https://eprints.maths.manchester.ac.uk/2629/); summary only). Follow-up error analysis ([eprint 2735](https://eprints.maths.manchester.ac.uk/2735/), title only).
  - Liu, Hu, Zhu, Matusik and Sifakis, "Narrow-band topology optimization on a sparsely populated grid", ACM TOG 37(6), SIGGRAPH Asia 2018: over one billion voxels on a single shared-memory CPU machine with a mixed-precision multigrid-preconditioned solver that keeps double-precision accuracy, two orders of magnitude faster than earlier approaches ([SIGGRAPH archive](https://history.siggraph.org/?p=198051), abstract read).
  - Göddeke, Strzodka and Turek, Int. J. Parallel Emergent Distrib. Syst. 22(4) (2007) 221-256: the classic GPU FEM study of float32 inner multigrid with float64 defect correction (to read; unverified summary).
  - Float32 CG pitfalls (standard numerical analysis, unverified this session): the recursively updated residual drifts from the true residual b - Ax, so attainable accuracy stalls near u·κ with u ≈ 6e-8 for float32 (Greenbaum, *Iterative Methods for Solving Linear Systems*, SIAM 1997, ch. 7, to read); dot products over 1e6-1e7 entries need tree reduction; element computations from large absolute coordinates lose digits.
  - Inference (from the notes): the condition number of elasticity grows with slenderness, so the float32 floor is likelier to bite on slender and thin-walled parts, and a higher-precision outer residual loop is the published remedy pattern. No paper was found that quantifies float32 against float64 stress error on thin-walled FE models.
  - Personal experience: plain float32 CG stalled at -21 % (4 voxels through the wall) and -51 % (8 voxels) tip deflection on a 2 mm wall while reporting convergence; the translation-relative operator (subtracting the element's corner displacement before applying the element matrix, which is exact because the element matrix ignores rigid translation) brought this to 0.3-0.6 %. This mechanism is about cancellation in the displacement differences inside each element, which is related to but not the same as the absolute-coordinate problem named in the pitfalls above.

**Large-scale voxel solving, published examples:**

- Aage et al. 2017 (above): wing at giga-voxel resolution; solver details unverified. Results are published as the DTU dataset TopWingData ([data.dtu.dk](https://data.dtu.dk/articles/dataset/TopWingData/12581615/1)).
- Wu, Dick and Westermann, "A System for High-Resolution Topology Optimization", IEEE TVCG 22(3) (2016) 1195-1208 (volume and pages unverified): a GPU solver that handles models with several millions of elements ([TU Delft project page](https://homepage.tudelft.nl/z0s1z/projects/2016-GPU-topopt.html), snippet). That it is geometric multigrid-preconditioned CG on a single GPU is unverified.
- Liu et al. 2018 (above): over one billion voxels on CPU.
- Multi-GPU voxel topology optimisation follow-on work at TU Delft (Delissen) ([TU Delft DCSE page](https://homepage.tudelft.nl/y95n9/project_DCSE.html), snippet; no numbers).

**Solver libraries and their licences** (licence files or GitHub metadata, read 2026-10-28):

| Library | Licence | Version (date) | GPU / notes | Source |
|---|---|---|---|---|
| PETSc | BSD-style (BSD-2-Clause per its docs is unverified) | releases from its own site | CUDA/HIP backends (not checked) | [petsc/petsc LICENSE](https://github.com/petsc/petsc/blob/main/LICENSE) |
| hypre | Apache-2.0 OR MIT (relicensed from LGPL-2.1 with contributor consent) | v3.2.0 (2026-08-24) | BoomerAMG with CUDA/HIP | [hypre COPYRIGHT](https://github.com/hypre-space/hypre/blob/master/COPYRIGHT) |
| NVIDIA AmgX | BSD-3-Clause | v2.5.0 (2025-12-21) | CUDA only (unverified) | [NVIDIA/AMGX](https://github.com/NVIDIA/AMGX) |
| NVIDIA Warp, incl. warp.fem | Apache-2.0 since 2025-03-07; NVIDIA Source Code License from 2022-03-15 until then | v1.18.0 (2026-10-05) | CUDA; first Apache-2.0 release number unverified | [NVIDIA/warp LICENSE.md](https://github.com/NVIDIA/warp/blob/main/LICENSE.md); [history](https://github.com/NVIDIA/warp/commits/main/LICENSE.md) |
| Ginkgo | BSD-3-Clause | v1.11.0 (2025-12-15) | GPU AMG and Krylov | [ginkgo-project/ginkgo](https://github.com/ginkgo-project/ginkgo) |
| AMGCL | MIT | 1.5.0 (2026-08-03) | Backends incl. VexCL (MIT); CUDA/ViennaCL backends unverified | [ddemidov/amgcl](https://github.com/ddemidov/amgcl); [ddemidov/vexcl](https://github.com/ddemidov/vexcl) |
| MFEM | BSD-3-Clause | v4.10 (2026-09-01) | Partial assembly / matrix-free on CUDA/HIP (unverified) | [mfem/mfem](https://github.com/mfem/mfem) |
| libCEED | BSD-2-Clause | v1.0.1 (2026-10-11) | Matrix-free element operators on CPU, CUDA, HIP, SYCL | [CEED/libCEED](https://github.com/CEED/libCEED); JOSS 6(63) 2945, 2021 (unverified) |
| deal.II | Apache-2.0 with LLVM exception OR LGPL-2.1-or-later | not recorded | Matrix-free multigrid | [deal.II LICENSE.md](https://github.com/dealii/dealii/blob/master/LICENSE.md) |
| Trilinos | Per package; default BSD-3-Clause | 17.2.1 (2026-08-31) | Check each package | [Trilinos LICENSE](https://github.com/trilinos/Trilinos/blob/develop/LICENSE) |
| Kokkos | Apache-2.0 with LLVM exception (older versions BSD-3-Clause, unverified) | 5.2.2 (2026-09-10) | Performance portability layer | [kokkos/kokkos LICENSE](https://github.com/kokkos/kokkos/blob/develop/LICENSE) |
| MAGMA | BSD-3-Clause | v2.10.0 (2026-03-02) | Dense GPU linear algebra | [icl-utk-edu/magma](https://github.com/icl-utk-edu/magma) |
| ViennaCL | MIT-style | last push 2021-11-22 (inactive) | | [viennacl-dev LICENSE](https://github.com/viennacl/viennacl-dev/blob/master/LICENSE) |
| NVIDIA cuSPARSE / cuDSS | Closed source under NVIDIA licence agreements (unverified) | | | not fetched |
| faer (Rust) | MIT | 0.24.4 (2026-07-01) | CPU dense and sparse | [faer-rs](https://github.com/sarah-quinones/faer-rs) |
| nalgebra / nalgebra-sparse (Rust) | Apache-2.0 (earlier BSD-3-Clause, unverified) | nalgebra-sparse 0.12.0 | CPU | [dimforge/nalgebra](https://github.com/dimforge/nalgebra) |
| russell, incl. russell_sparse (Rust) | MIT | v5.0.0 (2026-10-28) | Pure-Rust sparse direct solver by default; optional UMFPACK (GPL-2.0-or-later, unverified) and MUMPS (CeCILL-C, unverified) features change the licence picture | [cpmech/russell](https://github.com/cpmech/russell) |
| wgpu (Rust) | MIT OR Apache-2.0 | v30.0.1 (2026-08-22) | WebGPU implementation | [gfx-rs/wgpu](https://github.com/gfx-rs/wgpu) |
| burn / cubecl (Rust) | MIT OR Apache-2.0 | burn v0.22.1 (2026-10-20); cubecl v0.11.3 (2026-10-22) | GPU kernel language with wgpu, CUDA, HIP backends | [tracel-ai/burn](https://github.com/tracel-ai/burn); [tracel-ai/cubecl](https://github.com/tracel-ai/cubecl) |
| rust-gpu | MIT OR Apache-2.0 | v0.11.0 (2026-10-13) | Rust to SPIR-V | [Rust-GPU/rust-gpu](https://github.com/Rust-GPU/rust-gpu) |
| fenris (Rust FEM) | MIT OR Apache-2.0 | 0.0.33, last push 2023-09-25 | README: not recommended for general use | [fenris](https://github.com/InteractiveComputerGraphics/fenris) |
| gemlab, pmsim (Rust) | MIT | gemlab 4.0.1 (2026-10-28); pmsim 0.3.0 (2023-10-15) | Experimental FE | [gemlab](https://github.com/cpmech/gemlab); [pmsim](https://github.com/cpmech/pmsim) |
| finiteelement (Rust) | MIT OR Apache-2.0 | 0.1.0 | | [licenses.dev](https://licenses.dev/cargo/finiteelement/0.1.0) |

Inference (from the notes): the permissive GPU AMG libraries (AmgX, hypre, Ginkgo, AMGCL) all target CUDA, HIP, OpenCL or CPU; none targets WebGPU or WGSL. Dedicated Rust Krylov-solver crates were not surveyed.

**WebGPU, WGSL and WebAssembly constraints**

- WebGPU is a W3C Candidate Recommendation Draft dated 2026-09-15; WGSL a Candidate Recommendation Draft dated 2026-10-26 ([W3C WebGPU](https://www.w3.org/TR/webgpu/); [W3C WGSL](https://www.w3.org/TR/WGSL/); both read 2026-10-28).
- **No 64-bit float.** WGSL's concrete scalar types are bool, i32, u32, f32 and, with `enable f16;` and the `shader-f16` device feature, f16. There is no f64; AbstractFloat is binary64 internally but only for constant expressions ([W3C WGSL](https://www.w3.org/TR/WGSL/)).
- **No float atomics.** atomic<T> requires T to be u32 or i32, in workgroup or read-write storage memory; an `atomic<vec2<u32>>` min/max extension exists. `atomicCompareExchangeWeak` allows a compare-and-swap loop to emulate float addition on bit-cast integers ([W3C WGSL](https://www.w3.org/TR/WGSL/)). Inference (from the notes): this favours gather-style node-centric matrix-free products or element colouring (8 colours for a structured hex grid) over element scatter-add; the author's spike used the gather approach.
- **Default limits** ([W3C WebGPU limits table](https://www.w3.org/TR/webgpu/#limits)):

| Limit | Default |
|---|---|
| maxStorageBufferBindingSize | 134,217,728 B (128 MiB) |
| maxBufferSize | 268,435,456 B (256 MiB) |
| maxComputeWorkgroupStorageSize | 16,384 B (16 KiB) |
| maxComputeInvocationsPerWorkgroup | 256 (128 in compatibility mode) |
| maxComputeWorkgroupSizeX / Y / Z | 256 / 256 / 64 |
| maxComputeWorkgroupsPerDimension | 65,535 |
| minStorageBufferOffsetAlignment | 256 B |
| maxUniformBufferBindingSize | 65,536 B |
| maxStorageBuffersPerShaderStage | 8 |
| maxBindGroups | 4 |

  Adapters may expose higher limits that the page must request at device creation; actual per-GPU values were not found (unverified). Inference (arithmetic from the notes): 128 MiB holds about 33.5 million float32 values, so one displacement-sized vector for a 3-DOF-per-node voxel model fits about 11 million nodes per binding; 16 KiB of workgroup memory is 4,096 float32 values, enough for one 24 x 24 element matrix (576 values).
- **Optional features** include `shader-f16`, `subgroups`, `subgroup-size-control`, `timestamp-query` and `atomic-vec2u-min-max`; with `subgroups`, adapter info reports the subgroup size range (defaults 4 and 128 otherwise) ([W3C WebGPU](https://www.w3.org/TR/webgpu/)). Per-browser shipping status of subgroups was not confirmed.
- **GPU choice**: `powerPreference` ("low-power" or "high-performance") is only a hint that may influence adapter choice on multi-GPU systems ([W3C WebGPU](https://www.w3.org/TR/webgpu/)). Personal experience: Chrome on a hybrid laptop returned the integrated GPU despite "high-performance".
- **Watchdog**: the user agent may lose the device at any time and may use a watchdog so GPU work cannot hang the GPU for more than a few seconds ([W3C WebGPU](https://www.w3.org/TR/webgpu/)). Windows TDR defaults to 2 s (Microsoft "TDR registry keys", unverified). Inference: splitting each solve into many short dispatches is the usual pattern; the author's spike submitted 25 iterations per command buffer for this reason.
- **Browser support** (secondary sources): Safari 26 (September 2025) added WebGPU, and by November 2025 it was in all major browsers; Chrome on Linux added Intel GPUs in Chrome 144 and NVIDIA in Chrome 147; Firefox shipped on Windows in Firefox 141 (July 2025) and on Apple-silicon macOS in 145/147; as of August 2026 Firefox on Linux and Android was pre-release only ([Wikipedia: WebGPU](https://en.wikipedia.org/wiki/WebGPU); [Khronos SIGGRAPH 2026 listing](https://www.khronos.org/developers/linkto/webgl-and-webgpu-sigg26); [web.dev](https://web.dev/blog/webgpu-supported-major-browsers)). Snapshots disagree on Chrome version numbers; Chrome desktop first shipped WebGPU in version 113 in 2023 (unverified).
- **WebAssembly**: wasm32 linear memory is limited to 4 GiB by its 32-bit addresses (unverified this session). Memory64 shipped in Firefox 134 and Chrome 133, and can be 10 % to over 100 % slower than 32-bit wasm depending on workload ([SpiderMonkey blog, 2025-01-15](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html)). Safari does not support Memory64 up to the 26.5 preview ([caniuse](https://caniuse.com/wf-wasm-memory64); [WebKit bug 300538](https://bugs.webkit.org/show_bug.cgi?id=300538)). A 16 GiB browser cap for Memory64 is reported only by secondary sources (unverified). Wasm threads need cross-origin isolation (COOP and COEP headers) (unverified; MDN is the source to cite). SIMD128 shipped in all major browsers around 2021-2023 (unverified).
- **Published browser FEA**: no peer-reviewed paper on a WebGPU FEM or CG solver was found. Two small GitHub projects exist: RomanShushakov/fea_app (WebGPU block-Jacobi PCG with a Rust/wasm side; says it is not production-ready; no licence detected, so default copyright applies) and andeplane/fem-lab (MIT, Rust core plus WebGPU, pushed 2026-10-19) ([fea_app](https://github.com/RomanShushakov/fea_app); [fem-lab](https://github.com/andeplane/fem-lab)). The author's spike is the only WebGPU-against-native solver comparison in these notes.

### Dynamics

- **Modal analysis** (Bathe 2014 ch. 10-11; Craig and Kurdila, *Fundamentals of Structural Dynamics*, 2nd ed., 2006): solve Kφ = ω²Mφ, f = ω/2π (Hz), modes normalised so φᵀMφ = 1, by Lanczos or subspace iteration with shift-invert. A free (unsupported) model gives 6 zero-frequency rigid-body modes, which makes a good model check; near-zero values such as 1e-3 Hz are acceptable. Consistent mass gives upper-bound frequencies; lumped mass often lower.
- **Effective mass** (Craig and Kurdila 2006, chapter unverified): participation factor Γ_i = φ_iᵀ M r for direction r; effective mass m_eff,i = Γ_i². The sum over all modes equals the total mass. The usual rule is to include modes until cumulative effective mass reaches at least 90 % per excitation direction, from seismic codes such as ASCE 7-16 §12.9.1 (clause and current wording unverified).
- **Damping** (Chopra, *Dynamics of Structures*, 5th ed., 2017, ch. 11): Rayleigh damping C = αM + βK gives ζ(ω) = α/(2ω) + βω/2. Typical values: welded steel about 2 %, bolted structures 2-5 %, concrete about 5 % (order of magnitude; unverified sources). Own calculation: anchoring 2 % at 10 Hz and 100 Hz gives α = 2.285 s⁻¹ and β = 5.79e-5 s, and only 1.27 % at 50 Hz; outside the anchors damping grows quickly, so high modes are over-damped.
- **Harmonic analysis** (Chopra 2017 ch. 3): steady response to F₀ sin ωt; at resonance a single DOF amplifies by Q = 1/(2ζ), 25 at ζ = 2 %. The answer is only as good as the damping input.
- **Transient**: modal superposition or direct integration; a time step about 1/20 of the period of the highest mode of interest is a rule of thumb (unverified).
- **Response spectrum** (Chopra 2017 ch. 13): peak modal responses from a design spectrum, combined by SRSS or CQC (CQC for closely spaced modes). Signs are lost; the result is a conservative envelope.
- **Random vibration** (Wirsching, Paez and Ortiz, *Random Vibrations*, 1995/2006): input acceleration PSD in g²/Hz; response PSD = |H(f)|² x input; RMS = √(area). Results are 1σ; 3σ is commonly used for strength and Steinberg's three-band method for fatigue (unverified).
- **Miles' equation**: G_rms = √((π/2)·f_n·Q·PSD(f_n)), derived by Miles (1954) for a lightly damped single-DOF system under flat white-noise base excitation and technically valid only for that idealisation ([NASA GSFC FEMCI poster, Simmons 2001](https://femci.gsfc.nasa.gov/workshop/2001/posters/simmons/Simmons_MilesEquation.pdf), summary). A Shuttle payload paper notes it often overestimates random load factors ([NTRS 19900015329](https://ntrs.nasa.gov/citations/19900015329), summary). Own calculation: f_n = 200 Hz, Q = 10, PSD = 0.04 g²/Hz gives 11.2 g (1σ), 33.6 g (3σ); for a 0.1 kg (1e-4 t) part the 3σ inertial load is about 33 N.
- Inference (from the notes): modal analysis needs only K and M and is the natural next analysis type after linear static; harmonic, random and response-spectrum results depend heavily on assumed damping.

### Buckling

- **Linear (eigenvalue) buckling** (Cook 2002 ch. 18; Bathe 2014 ch. 6; chapters unverified): solve the reference load case, build the geometric stiffness K_σ from its stresses, and solve (K + λK_σ)φ = 0. The buckling load is λ₁ times the reference load. It assumes perfect geometry, a linear pre-buckling state and elastic material. It is unconservative because real imperfections lower the load (dramatically for shells with unstable post-buckling paths), plasticity before buckling is ignored for stocky members, and pre-buckling nonlinearity is ignored. A negative eigenvalue means the load would have to reverse.
- **Own calculation, Euler column**: pinned-pinned, L = 500 mm, solid round d = 10 mm, steel: I = 490.9 mm⁴, P_cr = π²EI/L² = 4 070 N (51.8 MPa, well below yield). Once P_cr/A exceeds about half of yield, inelastic buckling (Johnson parabola) governs and linear buckling overestimates the load (Shigley 10th ed. ch. 4, unverified).
- **Nonlinear buckling with imperfections** (Crisfield 1991): seed the geometry with an imperfection (scaled eigenmodes, measured shapes or perturbation loads) and run a geometrically and materially nonlinear analysis with arc-length to find the limit load. Results depend on imperfection shape and amplitude, which should come from manufacturing tolerances.
- **Knock-down factors**:
  - NASA SP-8007, *Buckling of Thin-Walled Circular Cylinders* (1965, revised 1968): factors built from 1930s-1960s experiments, with few if any composite shells tested ([NASA NESC Technical Bulletin 16-01, PDF dated 2024-01](https://ntrs.nasa.gov/api/citations/20240000391/downloads/TB%2016%2001%20Buckling%20Knockdown%20Factors.pdf), read).
  - Axial-compression form for unstiffened isotropic cylinders: γ = 1 - 0.901(1 - e^(-φ)), φ = (1/16)√(R/t). The 0.901 coefficient is confirmed in a NASA-hosted paper ([NTRS 20120008172](https://ntrs.nasa.gov/api/citations/20120008172/downloads/20120008172.pdf), snippet); the φ definition is from memory (unverified). For cylinders with closely spaced, moderately large stiffeners SP-8007 recommends 0.75 under uniform compression and bending (same paper, snippet).
  - Own calculation with the unverified φ: aluminium cylinder, E = 70 000 MPa, ν = 0.3, R/t = 200: classical σ_cl = 212 MPa, γ = 0.471, design buckling stress about 100 MPa, less than half the linear eigenvalue value.
  - NESC TB 16-01: several NASA studies used a universal 0.65 factor for composite cylinders; the bulletin says its origin is unclear, it may be unconservative, and it should not be used universally without other rationale. SP-8007 values for many sandwich composites are lower than 0.65, though nonlinear FE suggests those values are conservative.
  - NASA/SP-8007-2020/REV 2 (Hilburger, NASA Langley), published 2020-12-01 (PDF dated 1-2023), NTRS 20205011530: updates SP-8007 for current materials and computational tools, based on the NESC Shell Buckling Knockdown Factor assessment; a guideline, not a requirement; the abstract gives no numeric factors ([NTRS](https://ntrs.nasa.gov/citations/20205011530); PDF "to read"). Secondary literature says the newer analysis-based factors are higher (less conservative) than 1968 values, e.g. Wagner et al. 2017, Composite Structures (unverified).
- Inference (from the notes): a linear buckling load factor for thin shells is not a safe load by itself; it needs a knock-down factor or a nonlinear analysis.

### Fatigue

- **Stress-life (S-N), Basquin** (Shigley 10th ed. ch. 6; Dowling, *Mechanical Behavior of Materials*, 4th ed., 2013, ch. 9-10, 14; chapters unverified): σ_a = σ'_f (2N_f)^b with b about -0.05 to -0.12. Steels: endurance limit S'e ≈ 0.5 S_ut for S_ut ≤ 1 400 MPa and 700 MPa above (wording unverified). Aluminium has no true endurance limit; a value at 5e8 cycles is quoted. Valid mainly for high-cycle, mostly elastic loading.
- **Strain-life (Coffin-Manson plus Basquin)** (Dowling 2013 ch. 14): ε_a = (σ'_f/E)(2N_f)^b + ε'_f(2N_f)^c, c ≈ -0.5 to -0.7. Used for low-cycle fatigue and notch plasticity, with Neuber's rule (σε = (Kt S)²/E) or Glinka to get local strain from elastic FE stress.
- **Mean-stress corrections** (Shigley ch. 6; Dowling ch. 9):
  - Goodman σ_a/S_e + σ_m/S_ut = 1/n; Gerber nσ_a/S_e + (nσ_m/S_ut)² = 1; Soderberg σ_a/S_e + σ_m/S_y = 1/n; Morrow replaces σ'_f with σ'_f - σ_m; Smith-Watson-Topper σ_ar = √(σ_max σ_a).
  - Goodman is conservative for ductile steels, Gerber fits test data better, Soderberg is very conservative; Dowling favours SWT or Walker for general use (unverified).
  - Own calculation (S_ut = 600 MPa, S_y = 450 MPa, corrected S_e = 250 MPa, σ_m = 100 MPa, σ_a = 150 MPa): Goodman n = 1.30, Gerber 1.56, Soderberg 1.22, SWT about 1.29. The choice of rule alone moves n by about 25 %.
- **Rainflow counting** (ASTM E1049-85, reapproved 2017, *Standard Practices for Cycle Counting in Fatigue Analysis*; paywalled, "to read"; edition year unverified): reduces a variable-amplitude history to closed cycles (range, mean) plus residual half-cycles; the standard also defines level-crossing, peak and range-pair counting.
- **Miner's rule** (Dowling ch. 9; Schijve, *Fatigue of Structures and Materials*, 2nd ed., 2009): D = Σ n_i/N_i, failure at D = 1. Own calculation: 1e5 cycles at N = 1e6 plus 2e4 cycles at N = 1e5 gives D = 0.3, life about 3.3 block repetitions. Test damage sums at failure range from about 0.1 to 10; some guidelines (FKM, IIW) use D = 0.5 or 0.2-0.3 for spectrum loading (unverified). Miner ignores sequence effects and damage below the endurance limit, so the S-N curve is often extended with a shallower slope (Haibach).
- **Multiaxial fatigue** (Socie and Marquis, *Multiaxial Fatigue*, SAE 2000; Findley 1959; Dang Van et al. 1989; citations unverified): proportional loading can use an equivalent stress (signed von Mises or maximum principal); non-proportional loading needs critical-plane methods (Findley τ_a + kσ_n,max = f; Brown-Miller and Fatemi-Socie for strain); Dang Van gives an infinite-life criterion τ(t) + a·p(t) ≤ b.
- **Weld fatigue**:
  - IIW FAT class = stress range Δσ in MPa at 2e6 cycles, slope m = 3 for normal stress; mean stress is largely neglected for as-welded joints because residual stresses are near yield (Hobbacher IIW-2259-15, 2016, "to read"; clause unverified). Own calculation: a FAT 90 detail at Δσ = 60 MPa gives N = 2e6 x (90/60)³ = 6.75e6 cycles.
  - BS 7608:2014+A1:2015 uses detail classes (B, C, D, E, F, F2, G, W1, S) with design curves at mean minus 2 standard deviations (unverified) ([BSI](https://knowledge.bsigroup.com/products/guide-to-fatigue-design-and-assessment-of-steel-products); paywalled).
  - EN 1993-1-9 (2005) uses detail categories Δσ_C = 36-160 MPa at 2e6 cycles, m = 3 down to a constant-amplitude limit at 5e6, then m = 5 to a cut-off at 1e8 (from memory, unverified).
  - The three standards differ in thickness correction and knee points; the values look similar but are not interchangeable.
- **Marin factors** (Shigley 10th ed. 2015 ch. 6; constants unverified): S_e = k_a k_b k_c k_d k_e k_f S'_e (surface, size, load type, temperature, reliability, miscellaneous). Own calculation: machined surface k_a = 4.51 x 600^-0.265 = 0.83; rotating round bar d = 20 mm k_b = 1.24 x 20^-0.107 = 0.90; k_c = 1 (bending); k_e = 0.814 (99 % reliability); S_e = 182 MPa, about 60 % of the polished-specimen value.
- Inference (from the notes): a fatigue factor of safety computed from a single linear static load case silently assumes one constant-amplitude cycle (0 to load, or ± load), so the R-ratio and mean-stress rule it uses are part of its meaning.

### Reading results

- **Stress components and principal stresses** (Cook 2002 ch. 1): six components σ_xx, σ_yy, σ_zz, τ_xy, τ_yz, τ_zx; principal stresses σ1 ≥ σ2 ≥ σ3 are the eigenvalues of the stress tensor. Signs matter: compressive σ3 dominates contact and bearing.
- **Von Mises and Tresca**: σ_vm = √(½[(σ1-σ2)² + (σ2-σ3)² + (σ3-σ1)²]), always positive and blind to hydrostatic pressure; Tresca σ_T = σ1 - σ3. For pure shear τ, σ_vm = √3 τ and σ_T = 2τ, so Tresca is up to about 15 % more conservative (Shigley ch. 5). Own example: pure shear 100 MPa gives σ_vm = 173 MPa and σ_T = 200 MPa.
- **Averaged and unaveraged stress** (Cook 2002 ch. 6, 9, unverified): each element extrapolates integration-point stress to its nodes, and neighbours disagree at shared nodes. Averaging gives smooth contours but can underestimate peaks and blur real jumps at material interfaces or thickness changes. Large differences between averaged and unaveraged values indicate a mesh that is too coarse; this is the basis of ZZ error estimation. Averaging should stay within one material or part; von Mises should be computed from averaged components rather than averaged itself (program practice varies, unverified).
- **Stress linearisation** (ASME BPVC Section VIII, Division 2, Part 5 and Annex 5-A, design by analysis; paywalled, "to read"; method from public summaries, clause numbers unverified): along a stress classification line through the wall thickness t, each component is split into membrane σ_m = (1/t)∫σ dx, bending σ_b = (6/t²)∫σ(t/2 - x) dx and peak (the remainder). Elastic limits: P_m ≤ S; P_L ≤ 1.5S; P_L + P_b ≤ 1.5S; P_L + P_b + Q ≤ S_PS, typically about 3S. Peak stress goes only into fatigue. Results depend on where the line is placed; it should be normal to the mid-surface and away from singularities. Own calculation: a linear distribution from 150 MPa to 50 MPa through t = 10 mm gives membrane 100 MPa, bending ±50 MPa, peak 0.
- **Deflection limits**: span/360 for floor live load is a commonly quoted building-code value (for example IBC Table 1604.3; edition and clause unverified). Machine and optical structures set their own limits. Deflection limits are serviceability checks, separate from strength.
- **Factors of safety**:
  - Against yield: n = σ_y / σ_vm,max at the converged peak away from singularities.
  - Against buckling: λ₁ x knock-down factor, often with an extra design factor.
  - Against fatigue: stress-based (Goodman and others) or life-based (N_predicted/N_required). Own calculation: at S-N slope m = 3 a stress factor of 1.26 equals a life factor of 2 (1.26³ = 2.0).
  - Code values vary (aerospace ultimate factor 1.5 per 14 CFR 25.303, clause unverified; machine design often 1.5-4).
  - Every factor must state which strength (minimum or typical) and which stress (peak, linearised, hot-spot) it uses.
  - Factor of safety against margin of safety: in an Eng-Tips thread a poster computed a "safety factor" of 0.42 (207 MPa yield over 494 MPa peak von Mises), and replies pointed out that factor of safety and margin of safety (factor minus 1, where positive is acceptable) are used differently between industries (opinion of forum members; [Eng-Tips 431051](https://www.eng-tips.com/viewthread.cfm?qid=431051)).
- Inference (from the notes): an averaged von Mises contour plot with a factor of safety is the minimum output of CAD-embedded tools; without a mesh-convergence indicator and a warning at singular points, the maximum value is the least reliable number shown.

### Verification and validation

Covered in depth in the Accuracy section: definitions (verification, validation, code verification, solution verification), analytic and manufactured solutions, benchmarks, discretisation error estimates, comparison with physical tests (strain gauges, digital image correlation, modal tests) and uncertainty.

### Reporting and trust

Covered in the Accuracy section ("How results should be reported" and "How programs tell users how far to trust a result"): NASA-STD-7009B reporting requirements, sanity checks, warnings, and credibility frameworks (NASA-STD-7009B, ASME V&V 10). Two sanity checks named in the issue are standard theory: reactions must balance the applied load, and an unsupported part must show six near-zero frequencies in modal analysis (Bathe 2014 ch. 10-11; see Dynamics). No public source in the notes treats reaction balance as a standard hand-off item (gap).

## Accuracy

Priority one of the issue. This section covers how FEA results are checked against reality, how large errors usually are, which benchmark values are safe to use as reference values, and how programs tell users how far to trust a result.

### Verification and validation: definitions and frameworks

All frameworks found agree on two questions. **Verification** asks whether the equations are solved correctly (mathematics and software). **Validation** asks whether they are the right equations for the intended use (physics, judged against experiments).

- **NASA-STD-7009B**, *Standard for Models and Simulations*, approved 2024-03-05, free ([PDF](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf); read in full):
  - Sec. 3.2 defines validation as determining how accurately a model represents the real world for its intended uses; verification as determining how far a model complies with its conceptual and mathematical specification; and credibility as the quality that earns belief or trust in results.
  - Sec. 4.2.3 names two kinds of verification: implementation (code) verification, that the software contains everything in its design and nothing more; and solution verification, that it runs without errors and meets its accuracy goals, done each time the model is used.
  - App. E.3.3: code verification uses regression and unit tests, ideally end to end, and must be repeated after changes to compilers, libraries, operating system or hardware. Solution verification identifies numerical errors (discretisation, iterative tolerances) and human input errors; one named method is echoing all inputs, including mouse selections, to a log for comparison with intent.
  - Revision B splits credibility into an **M&S Capability Assessment** (factors: data pedigree, verification, validation, development technical review, development process and product management; App. E.3) and an **M&S Results Assessment** (use assessment, input pedigree, uncertainty characterisation, results robustness, use and analysis technical review, use process and product management; App. E.4, Table 13). Each factor is scored 0 (insufficient evidence) to 4, as a step function with no partial credit (App. E.4.1). The 2008 original had eight factors, per a secondary source ([validas.de glossary](https://www.validas.de/resources/glossary/nasa-std-7009b)).
  - Verification levels (Table 8, paraphrased): level 4, reliable practices covering all components and couplings end to end, with all model errors meeting requirements; level 3, rigorous practices and all important errors meet requirements; level 2, documented practices and most important errors meet requirements; level 1, informal verification with some documentation; level 0, insufficient evidence.
  - Validation levels (Table 9): level 4 needs favourable comparison with measurements on the real system in its operating environment, spanning its whole operating domain, for all response quantities; level 3 a representative environment covering the domain significantly and all important quantities. No level above 1 is allowed without prior conceptual validation. "Favourable comparison" needs at least some overlap between the uncertainty intervals of model and referent.
- **ASME V&V 10-2019 (R2025)**, *Standard for Verification and Validation in Computational Solid Mechanics* ([ASME](https://www.asme.org/codes-standards/find-codes-standards/standard-for-verification-and-validation-in-computational-solid-mechanics)): paywalled, "to read". Its commonly quoted definitions match those above in substance (wording from memory, unverified).
- **ASME V&V 10.1-2012 (R2022)**, *An Illustration of the Concepts of V&V in Computational Solid Mechanics* ([ASME](https://www.asme.org/codes-standards/find-codes-standards/an-illustration-of-the-concepts-of-verification-and-validation-in-computational-solid-mechanics)): understood to work a beam-type example through code verification, solution verification and validation against simulated experiments (unverified; "to read").
- **ASME V&V 20-2009** and Celik et al., J. Fluids Eng. 130 (2008) 078001: the canonical GCI procedure (not re-read; "to read").
- **NAFEMS ESQMS:01 (2020)**, *Engineering Simulation Quality Management Standard*, replacing QSS:2015 ([NAFEMS](https://www.nafems.org/publications/resource_center/esqms-01/)): paywalled; contents not accessed.
- **Oberkampf and Roy**, *Verification and Validation in Scientific Computing*, Cambridge University Press 2010 ([doi](https://doi.org/10.1017/CBO9780511760396)): standard textbook on order-of-accuracy testing, the method of manufactured solutions, solution verification and validation metrics. Not opened; chapter contents from memory (unverified).
- **Szabó and Babuška**, *Finite Element Analysis: Method, Verification and Validation*, 2nd ed., Wiley 2021 ([Wiley](https://www.wiley.com/en-us/Finite+Element+Analysis%3A+Method%2C+Verification+and+Validation%2C+2nd+Edition-p-9781119426424)): cited for h/p theory; not opened ("to read").
- **Discretisation error estimates**: Richardson extrapolation, GCI and the ZZ estimator are described under Fundamentals, Meshing and convergence.
- **Method of manufactured solutions (MMS)**: choose any smooth displacement field, derive the body force f = -∇·σ(u) symbolically, impose u on the boundary, and check that the error falls at the theoretical rate: O(h^(k+1)) in the L2 displacement norm and O(h^k) in the energy norm for degree-k elements (standard a-priori rates; Oberkampf and Roy 2010, chapter unverified). It verifies a code without any reference number.
- Inference (from the notes): the 7009B split maps onto two kinds of trust evidence. Capability (has this code been verified on benchmarks?) belongs to a software release. Results (input pedigree, uncertainty, robustness) belongs to each analysis. Code verification can be automated against the benchmark set below; solution verification needs two or three meshes per analysis.

### How large errors usually are

**Discretisation and element errors** (all numbers from vendor documentation are **vendor verification results** for that program's elements; they illustrate size, they are not reference values):

| Case | Error | Source |
|---|---|---|
| Linear tets, bar in bending | 10-70 % in displacement and stress; linear hexes, quadratic hexes and quadratic tets acceptable on coarse meshes | Benzley et al. 1995, via [arXiv 0911.3884](https://arxiv.org/pdf/0911.3884) (secondary) |
| Fully integrated first-order elements, cantilever, 8 x 24 mesh | About 56 % of theoretical tip deflection; quadratic 0.994-1.000 | [Abaqus "Full integration", 2017](https://abaqus-docs.mit.edu/2017/English/SIMACAEGSARefMap/simagsa-c-ctmfull.htm) (vendor documentation) |
| NAFEMS LE10, target σyy(D) = -5.38 MPa | Abaqus/Standard results from about -5.08 to -7.93 MPa across element types and meshes; fine C3D20 about +4.8 %, C3D10HS about +2.4 % | [Abaqus Benchmarks LE10](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le10.htm) (vendor verification result) |
| NAFEMS LE10, linear tet (Solid4), fine | 2.41 MPa magnitude, about 55 % error | [FunctionBay RecurDyn Validation_NAFEMS.pdf](https://functionbay.com/documentation/onlinehelp/Documents/Validation/Validation_NAFEMS.pdf) (vendor verification result; snippet) |
| NAFEMS LE1, target 92.7 MPa | Hex8 coarse 63.15 MPa (about -32 %), Hex20 fine 91.01 MPa, Tria6 fine 96.64 MPa | [Altair OS-V 0010](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le1_r.htm) (vendor verification result) |
| NAFEMS LE11, target -105 MPa | Abaqus C3D20 -96.71 MPa coarse (-7.9 %), -103.26 MPa fine (-1.7 %); OptiStruct Tetra10 -91.97 coarse, -98.68 fine | [Abaqus LE11](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le11.htm); [Altair OS-V 0070](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le11_r.htm) (vendor verification results) |
| MacNeal-Harder straight cantilever, hex8, trapezoidal mesh | 0.047 and 0.030 of reference (in-plane, transverse) against 0.902 and 0.950 for hex20 | [Altair OptiStruct](https://help.altair.com/hwsolvers/os/topics/solvers/os/straight_cantilever_beam_verification_r.htm) (vendor verification result) |
| Shell bending, stripe pattern | Dimensionless energy error 0.3542 (linear tet) against 0.0596 (quadratic tet) at 0.6 mm; 0.0483 against 0.0009 at 0.15 mm | [arXiv 2305.13841](https://arxiv.org/pdf/2305.13841) (snippet; metric units not confirmed) |
| Welded tube joint, body-fitted tet10 at default mesh | 41 % off a converged reference of about 71 MPa; refined mesh 24 % off | [Altair blog](https://altair.com/blog/articles/Comparing-Altair-SimSolid-with-a-FEA-Benchmark) (vendor claim, about a competitor's program) |
| Thin wall, voxel hex8 against hex8i, 2 voxels through 2 mm | -12.6 % against -0.74 % tip deflection | Personal experience |
| Float32 Jacobi-PCG, plain operator, 2 mm wall | -21 % (4 voxels), -51 % (8 voxels) while reporting convergence | Personal experience |

Inference (from the notes): coarse linear tets in bending err by tens of percent; fine quadratic elements reach a few percent on the same problems. Element order matters more than modest refinement. Discretisation error on a well-posed linear elastic benchmark can be driven below 1-2 %.

**Modelling and validation errors.** Real-world error is dominated by modelling and input choices (supports, contact, material scatter, the analyst), not by discretisation:

- **Sandia Fracture Challenge 1 (2012)**: 13 teams from academia, industry and labs predicted ductile tearing of a steel specimen blind, with methods from simple engineering calculations to multiscale simulation. The authors report a striking lack of consistency between groups; per-team results are in the paper's appendix. Boyce et al., Int. J. Fract. (2014), doi:10.1007/s10704-013-9904-6 ([MIT DSpace, open access](https://dspace.mit.edu/handle/1721.1/110644)).
- **Sandia Fracture Challenge 4** (puncture of an aluminium structure): critical-velocity predictions varied widely but were of the right order of magnitude, and all teams underpredicted the extent of damage ([ICF15 keynote abstract](https://icf15.gatech.edu/sessions/symp01-m1-1)).
- Inference (from the notes): validation scatter, especially in fracture, is an order of magnitude larger than discretisation error on linear benchmarks; linear static stress is the most verifiable regime.

**Comparison with physical tests.**

- **Modal test correlation criteria**:
  - NASA Glenn base-shake test report NASA/TM-2002-211692: goals of cross-orthogonality above 0.9 on the diagonal and below 0.1 off it; fundamental frequencies within ±5 % in each axis and higher modes within ±10 % ([NTRS 20020062759](https://ntrs.nasa.gov/api/citations/20020062759/downloads/20020062759.pdf), summary).
  - A NASA presentation citing the AFFTC Structures Flight Test Handbook: primary modes within 5 % (NASA standard) or 3 % (MIL standard), secondary modes within 10 % ([NTRS 20120014454](https://ntrs.nasa.gov/api/citations/20120014454/downloads/20120014454.pdf) or [20140010282](https://ntrs.nasa.gov/api/citations/20140010282/downloads/20140010282.pdf); which one is unverified).
  - Practitioners commonly read MAC above 0.9 as well correlated ([SimuTech](https://simutechgroup.com/?p=810); vendor blog, opinion). Simcenter 3D defaults to a MAC pairing threshold of 0.7 ([Maya HTT blog](https://www.mayahtt.com/blog/correlating-simulation-modal-test-results-simcenter-3d/); vendor partner). A launcher case study treated MAC above 0.75 as correlated; about 10 of 17 paired modes were within 5 % in frequency ([SEM proceedings](https://sem.elibrary.riverpublishers.com/ebook/9788770049337/166/); snippet).
- **Strain gauges and digital image correlation (DIC)**: no primary numbers were found for typical FEA-against-gauge or FEA-against-DIC agreement (gap; see Open questions).
- **Analyst-to-analyst scatter**: NAFEMS has run analyst round robins, but no data was retrieved (gap).

**Sensitivity to inputs the user has to guess.**

- Material values: typical against minimum yield (for example 300 MPa against 235 MPa for one steel grade, own illustration) changes a factor of safety by about 28 %. Scatter figures (1-5 % for modulus, 5-10 % for yield, factor 10 in fatigue life) are unverified.
- Mean-stress rule alone moves a fatigue factor of safety by about 25 % (own calculation, Fundamentals, Fatigue).
- Damping: harmonic peak response scales with 1/(2ζ); Rayleigh damping anchored at two frequencies is 37 % low midway (1.27 % against 2 %, own calculation).
- Buckling: knock-down factors of 0.47 (own calculation, R/t = 200) to 0.75 (stiffened cylinders) separate linear eigenvalue loads from design loads.
- Supports: fixed faces against realistic joints change both peak stress (singular edges) and stiffness (Fundamentals, Supports and loads).
- Quantified sensitivity to friction and contact assumptions was not found (gap).

### Benchmark set with reference values

Two kinds of reference value are usable as test fixtures without depending on any commercial program's output:

- **Class A, closed-form solutions.** Computable at any parameters from formulas in standard textbooks. No licensing question. The numbers below were computed in the notes from the formulas (own calculation); the formulas are standard in Timoshenko-school texts, but page numbers were not checked.
- **Class B, published benchmark targets.** The NAFEMS booklet (*The Standard NAFEMS Benchmarks*, TNSB Rev. 3, 1990, paid; [NAFEMS P18](https://www.nafems.org/publications/resource_center/p18/)) and MacNeal-Harder 1985 are paywalled, but their target values are widely reproduced in public documents. Numerical facts and formulas are not protected by copyright; the booklet's figures, tables and text are. Values can be used with citation and geometry redrawn, without copying tables or figures. This is the general principle (for example Feist v. Rural, US 1991), not legal advice; EU database rights could apply to wholesale extraction of a compiled set (unverified legal point).

Confirmation status: "confirmed x2" or "x3" means the target appears in that many independent public documents; vendor documents count only as evidence of what the target is, never for their computed results.

Common data for Class A unless stated: steel E = 210 000 MPa, ν = 0.3, G = 80 769 MPa, ρ = 7.85e-9 t/mm³, α = 12e-6 /K.

| # | Problem | Quantity | Reference value | Formula and source | Status |
|---|---|---|---|---|---|
| A1 | Cantilever, end load; L = 1000 mm, b = 20 mm, h = 50 mm, F = 1000 N along h | Tip deflection (bending) | 7.619 mm | δ_b = FL³/(3EI), I = 208 333 mm⁴; Timoshenko and Gere, *Mechanics of Materials* | Computed from standard formula (page unverified) |
| A1 | same | Shear contribution | 0.0149 mm (κ = 5/6); 0.0146 mm (Cowper κ = 0.8497) | δ_s = FL/(κGA); Cowper, J. Appl. Mech. 33 (1966) 335-340 | Computed (page unverified) |
| A1 | same | Root bending stress | 120.0 MPa; 60 MPa at mid-span | σ = FLc/I. A fully clamped 3D root is singular at its corners; compare tip deflection or mid-span stress | Computed |
| A1b | Cantilever, L = 100 mm, 10 x 10 mm, F = 100 N | Tip deflection; root stress | 0.1905 mm (+0.0015 mm shear); 60.0 MPa | as A1 | Computed |
| A2 | Lamé thick cylinder, internal pressure, open ends; a = 50 mm, b = 100 mm, p = 100 MPa | Hoop stress at bore; radial stress at bore; hoop stress at outside | 166.67 MPa; -100 MPa; 66.67 MPa | σ_θ(r) = p a²(b² + r²)/(r²(b² - a²)); Timoshenko and Goodier 1970 | Computed (page unverified) |
| A3 | Circular tube torsion; r_o = 25 mm, r_i = 20 mm, T = 1e6 N·mm | J; maximum shear stress; twist rate | 362 265 mm⁴; 69.01 MPa; 3.418e-5 rad/mm | τ = Tr/J, J = π(r_o⁴ - r_i⁴)/2, θ' = T/(GJ); exact for circular sections | Computed |
| A4 | Kirsch: circular hole in an infinite plate, uniaxial σ∞ | Hoop stress at the hole edge, 90° to the load; at the poles | 3σ∞ (Kt = 3); -σ∞ | Kirsch 1898, in Timoshenko and Goodier. Plate width at least about 10x the hole diameter for the infinite limit (rule of thumb, unverified); finite width from Peterson's charts | Classical; confirmed in fundamentals and accuracy notes |
| A5 | Simply supported square plate, uniform load (Kirchhoff); a = 1000 mm, t = 10 mm, q = 0.01 MPa | Centre deflection; maximum bending stress | 2.111 mm; 28.74 MPa | w = α q a⁴/D, M = β q a², α = 0.00406, β = 0.0479 (ν = 0.3), D = 1.923e7 N·mm; Timoshenko and Woinowsky-Krieger 1959 | **Coefficients unverified** (from memory) |
| A6 | Euler column, pinned-pinned; 20 x 50 mm, weak axis I = 33 333 mm⁴, L = 1000 mm | Buckling load | 69 087 N (69.1 MPa, below yield) | P_cr = π²EI/(KL)², K = 1; Timoshenko and Gere, *Theory of Elastic Stability* | Computed |
| A6b | Euler column, pinned-pinned; round d = 10 mm, L = 500 mm | Buckling load | 4 070 N (51.8 MPa) | as A6 | Computed |
| A7 | Cantilever natural frequencies (Euler-Bernoulli), beam of A1 in steel | f₁; f₂ | 41.78 Hz; 261.80 Hz | f_n = (λ_n²/2π)√(EI/(ρAL⁴)), λ₁ = 1.875104, λ₂ = 4.694091; Blevins, *Formulas for Natural Frequency and Mode Shape*, 1979 (table number unverified) | Computed |
| A8 | Fully restrained bar, ΔT = +100 K | Axial stress | -252 MPa | σ = -EαΔT | Computed |
| A9 | Hertz contact, steel sphere on steel flat; R = 10 mm, F = 100 N | Contact radius; peak pressure; approach | 0.1866 mm; 1371 MPa; 0.00348 mm | E* = 115 385 MPa, a = (3FR/(4E*))^(1/3), p₀ = 3F/(2πa²), δ = a²/R; Johnson, *Contact Mechanics*, 1985, ch. 4 | Computed; a nonlinear (contact) fixture outside linear static |
| A10 | Method of manufactured solutions | Observed convergence rate | O(h^(k+1)) L2 displacement, O(h^k) energy, degree-k elements | Oberkampf and Roy 2010 (chapter unverified) | Standard theory |
| B1 | NAFEMS LE1, elliptic membrane, plane stress; quarter model; 10 MPa outward pressure on the outer edge; E = 210 GPa, ν = 0.3; point D = (2000, 0) mm. Ellipses (x/2000)² + (y/1000)² = 1 and (x/3250)² + (y/2750)² = 1 mm (dimensions unverified) | σyy at D | 92.7 MPa | [Altair OS-V 0010](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le1_r.htm); [COMSOL 6.4](https://doc.comsol.com/6.4/doc/com.comsol.help.models.sme.elliptic_membrane/elliptic_membrane.html); [FeenoX docs](https://www.seamplex.com/feenox/examples/mechanical.pdf) | **Confirmed x2+** |
| B2 | NAFEMS LE10, thick plate on the LE1 plan, 600 mm thick (unverified), 1 MPa on the top face | σyy at D (top surface) | -5.38 MPa (compressive; some documents print the magnitude only) | [Abaqus LE10](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le10.htm); [Altair OS-V 0060](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le10_r.htm); [COMSOL thick plate](https://doc.comsol.com/6.1/doc/com.comsol.help.models.sme.thick_plate/models.sme.thick_plate.pdf) | **Confirmed x3** |
| B3 | NAFEMS LE11, solid cylinder, taper and sphere under temperature T = √(x² + y²) + z (°C, coordinates in m); E = 210 GPa, ν = 0.3, α = 2.3e-4 /°C | σzz at A | -105 MPa | [Abaqus LE11](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le11.htm); [Altair OS-V 0070](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le11_r.htm); FeenoX reports -105.04 MPa from its own run ([FeenoX](https://www.seamplex.com/feenox/examples/mechanical.html)) | **Confirmed x2** |
| B4 | NAFEMS FV32, tapered cantilever membrane, free vibration | f₁ | 44.623 Hz | none found | **Unverified** |
| B5 | Scordelis-Lo roof (MacNeal-Harder): cylindrical shell L = 50, R = 25, 80° arc, t = 0.25, E = 4.32e8, ν = 0, self-weight 90 per unit area, rigid diaphragm ends (original units ft and lb/ft², consistency unverified) | Vertical displacement at the midside of the free edge | 0.3024 ft (about 92.2 mm if read as ft) | [Schöllhammer and Fries, arXiv 1805.11978 (2018) sec. 5.2](https://arxiv.org/pdf/1805.11978); [Altair OS-V 0730](https://help.altair.com/hwsolvers/os/topics/solvers/os/scordelis_lo_roof_verification_r.htm) | **Confirmed x2.** COMSOL quotes 0.3086 as MacNeal-Harder's theoretical value and 0.302 as the usual converged target ([COMSOL 5.6](https://doc.comsol.com/5.6/doc/com.comsol.help.models.sme.scordelis_lo_roof/scordelis_lo_roof.html)); 0.3024 is the more widely confirmed target |
| B6 | Pinched cylinder with rigid diaphragm ends: L = 600, R = 300, t = 3, E = 3e6, ν = 0.3, two opposite unit point loads at mid-length (consistent units, nominally in and lb) | Radial displacement under the load | 1.8248e-5 in | [arXiv 1805.11978 sec. 5.3](https://arxiv.org/pdf/1805.11978) (1.82488e-5); [SOFiSTiK BE41](https://docs.sofistik.com/2024/en/verification/_static/verification/pdf/be41.pdf); [Abaqus pinched cylinder](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-pinchcyl.htm) (0.1825e-4, Lindberg series solution) | **Confirmed x3** |
| B7 | Pinched hemisphere with 18° hole: R = 10, t = 0.04, E = 6.825e7, ν = 0.3, ±2 point loads at the equator | Radial displacement | 0.094 in (MacNeal-Harder) / 0.0924 in (Belytschko) | none found | **Unverified** |
| B8 | MacNeal-Harder twisted beam: 90° pre-twist, L = 12, w = 1.1, t = 0.32 | Tip displacement, in-plane / out-of-plane load | 0.005424 in / 0.001754 in | none found | **Unverified** |
| B9 | Cook's membrane, linear plane stress: corners (0,0), (48,44), (48,60), (0,44); left edge clamped; shear load F = 1 on the right edge; E = 1, ν = 1/3 | Vertical displacement of the top-right corner | 23.96 (consistent units) | Geometry confirmed in [arXiv 1807.03106](https://arxiv.org/pdf/1807.03106) (snippet); 23.91 seen once as a coarse-mesh value ([arXiv 1706.07794](https://arxiv.org/pdf/1706.07794)) | **Target unverified** |
| B10 | MacNeal-Harder straight cantilever and curved beam (distortion tests) | Tip displacement | 0.1081 (in-plane) and 0.4321 (transverse), original units, for the straight cantilever | Quoted on [Altair OptiStruct help](https://help.altair.com/hwsolvers/os/topics/solvers/os/straight_cantilever_beam_verification_r.htm) | Single vendor source; **unverified** as a target |

Notes on using these:

- Point-value targets at D in LE1 and LE10 depend on stress extrapolation and nodal averaging; Abaqus notes C3D10 does better on the coarse LE10 mesh because four elements meet at D ([Abaqus LE10](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le10.htm)). A fixture is only meaningful with its tolerance and its stress-recovery method stated.
- Inference (from the notes): the most defensible fixtures are the Class A cases plus LE1, LE10, LE11, Scordelis-Lo (0.3024, noting the 0.3086 debate) and the pinched cylinder.
- The author's spike used closed-form references of the same kind (cantilever 0.2016 mm and 27 MPa; thin cantilever 0.3911 mm; tube twist 0.01953 deg and mean shear 7.136 MPa; Lamé bore growth 0.02752 mm and mean hoop stress 79.7 MPa), with parameters in its own benchmark file (personal experience; not all parameters are restated here).

**Open benchmark sets and their documentation** (documentation only; code not opened):

- **CoFEA**: open benchmark documentation comparing CalculiX, code_aster and Elmer, including LE10 (001-thick-plate) and Cook's membrane (002), with linear and quadratic tets and hexes at ν = 0.33 and 0.49 ([CoFEA docs](https://cofea.readthedocs.io/en/docs-dev/benchmarks/002-cook-membrane/index.html)). Target values and documentation licence were not shown on the page read (gap).
- **FeenoX** documentation runs LE1, LE10 and LE11 and reports its own results ([FeenoX](https://www.seamplex.com/feenox/examples/mechanical.html)). FeenoX code is GPLv3 (unverified); only docs were used.
- **code_aster V-manuals** (validation) and R-manuals are public PDFs; documentation licence believed GNU FDL (unverified); code is GPL and was not opened.
- **ESRD** publishes NAFEMS linear benchmark results for StressCheck ([ESRD, 2020-01](https://www.esrd.com/download/nafems-linear-benchmarks-jan-2020-pdf/)) (vendor).
- MYSTRAN, Elmer, deal.II, MFEM and FEBio verification documents were not retrieved (gap).

### Issue-listed accuracy sources: what was found

| Source in the issue | Status in this research |
|---|---|
| The Standard NAFEMS Benchmarks (P18, 1990) | Paid, not read. Targets LE1, LE10, LE11 confirmed through public documents; FV32 unverified; LE1/LE10 geometry details unverified. |
| Selected Benchmarks for Forced Vibration (R0016, 1989) | Paid, not read. Only seen as four R0016 cases (13H/13P/13T/13R) in SimSolid's NAFEMS code-verification list. |
| Benchmark Tests for Contact, Gapping and Sliding (R0081, 2001) | Paid, not read; not covered in the notes. |
| Understanding Non-linear FEA Through Illustrative Benchmarks (R0080, 2001) | Paid, not read; not covered in the notes. |
| NAFEMS Code Verification index | Read: lists OptiStruct 2022.2, SimSolid 2022.3, EPILYSIS v24.1.0 (BETA CAE), PERMAS 19.10.008 (INTES), MSC Marc 2021.1 and MSC Nastran 2021.1; the page states verification was performed by the code vendors and encourages users to check independently ([NAFEMS](https://www.nafems.org/publications/code-verification/)). |
| MacNeal and Harder 1985 | Paid; scanned copy not readable. Problem list and some targets through secondary sources. |
| Taylor, Simo, Zienkiewicz and Chan 1986 (patch test) | Abstract read via UTAS record. |
| Zienkiewicz and Zhu 1987 (error estimator) | Not read; described through secondary sources. |
| ASME V&V 10-2019 (R2025), V&V 10.1-2012 (R2022) | Paid, not read. |
| NASA-STD-7009B (2024) | Read in full. |
| NAFEMS ESQMS:01 (2020) | Paid, not read. |
| BS 7608:2014+A1:2015 | Paid, not read; detail classes from memory (unverified). |
| IIW Recommendations, 3rd ed. (Hobbacher and Baumgartner 2024) | Paid, not read; 2nd ed. (IIW-2259-15, 2016) also "to read"; hot-spot and notch values from memory and snippets. |
| EN 1993-1-9 | Paid, not read; detail categories from memory (unverified). |
| ASME BPVC VIII-2 Part 5 | Paid, not read; linearisation method from public summaries. |
| Roark's Formulas for Stress and Strain, 9th ed. (2020) | Not read; only seen as one source of SOLIDWORKS verification problems. |
| Cook et al. 4th ed.; Zienkiewicz et al. 8th ed. (2024); Bathe 2nd ed.; Belytschko et al. 2nd ed. | Cited for standard theory; not opened (chapters unverified). The notes cite Zienkiewicz's 7th ed. (2013). |
| Szabó and Babuška 2nd ed. (2021) | Cited for h/p theory; not opened. |
| Oberkampf and Roy 2010 | Not opened. |

### How programs tell users how far to trust a result, and where they fail

- **SOLIDWORKS Simulation** (vendor documentation): h-adaptive refinement driven by a strain-energy-norm error; the help states the target accuracy relates to the energy norm, not to stress accuracy, though good convergence usually indicates good stresses ([SOLIDWORKS 2022 help, Adaptive](https://help.solidworks.com/2022/english/SolidWorks/cworks/IDC_HELP_PRESTATIC_P_ADAPTIVE.htm)). An accuracy-bias slider (local or global) is offered, with global recommended for models with singularities such as sharp corners or point loads ([SOLIDWORKS 2015 help](https://help.solidworks.com/2015/English/SOLIDWORKS/Cworks/IDC_HELP_PRESTATIC_P_ADAPTIVE.htm)). The API allows a target accuracy of 0.80-0.99 ([SOLIDWORKS API 2017](https://help.solidworks.com/2017/English/api/swsimulationapi/SolidWorks.Interop.cosworks~SolidWorks.Interop.cosworks.ICWStaticStudyOptions~HAdaptiveTargetAccuracy.html)); a reseller says the default is 98 %, about 2 % energy-norm error ([GoEngineer](https://www.goengineer.com/en-us/blog/solidworks-simulation-solution-adaptive-mesh-refinement); secondary). A "Stress Hot Spot Diagnostics" tool flags high-gradient elements ([SOLIDWORKS tech blog, 2018-07](https://blogs.solidworks.com/tech/2018/07/what-is-a-stress-singularity-in-solidworks-simulation.html)).
- **Creo Simulate**: multi-pass adaptive p-refinement raises the polynomial order of element edges each pass (default range 1 to 6) until the last two passes differ by less than the user's percent (default 10 %, PTC advises 1-25 %); convergence quantities are selectable (local displacement and strain energy, RMS stress, or maximum principal stress); a non-converged run may be inaccurate, typically because of singularities or distorted elements ([PTC Help, Percent Convergence, r10](https://support.ptc.com/help/creo/creo_pma/r10.0/usascii/simulate/simulate/stat_convper.html); [convergence quantity, r9](https://support.ptc.com/help/creo/creo_pma/r9.0/korean/simulate/simulate/stat_convqty.html); [MPA, Creo 13](https://support.ptc.com/help/creo/creo_pma/r13/italian/simulate/simulate/stat_multiadap.html); [KB CS34780](https://www.ptc.com/en/support/article/CS34780)).
- **Inventor Stress Analysis**: p-refinement in the first 2-3 iterations, then optional h-refinement controlled by an "h refinement threshold" ([Autodesk Support](https://knowledge.autodesk.com/support/inventor-products/learn-explore/caas/sfdcarticles/sfdcarticles/h-refinement-threshold-s.html); [Inventor 2014 help](https://help.autodesk.com/cloudhelp/2014/ENU/Inventor/files/GUID-11F5A03D-8ED7-4330-8D87-D435756B5ED4.htm)). **Inventor Nastran**: up to 5 h-refinements by default with a percent stop criterion on von Mises stress ([Inventor Nastran 2026 help](https://help.autodesk.com/cloudhelp/2026/ENU/NINCAD-UsersGuide/files/GUID-834A66B2-3777-481D-BE28-A741A60C6F17.htm)).
- **Ansys Mechanical**: adaptive convergence on a percent change of a chosen result, default 20 %; an "Error (Structural)" result gives an energy-norm error estimate per element ([Ansys Help 2024 R2, Convergence](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/wb_sim/ds_Convergence.html); [Error (Structural)](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/wb_sim/ds_Error_Structural.html)).
- **Abaqus**: adaptive remeshing driven by error indicators, whose target should fall steadily ([Abaqus 2016 USB 12.3.1, mirror](https://ceae-server.colorado.edu/v2016/books/usb/pt04ch12s03abo15.html)).
- **COMSOL**: an "Adapt" operation refines from solution error information ([COMSOL 6.4](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_mesh.24.41.html)).
- **Onshape**: says analysis is adaptive and refines in the background, with no criterion or number published ([Onshape](https://www.onshape.com/en/features/simulation)).
- **SimSolid**: adaptive solution passes on its meshless method (detail unverified) ([Altair/Siemens resource](https://altair.com/resource/nafems-simsolid-benchmark)).
- **Simcenter 3D test correlation**: reports MAC and percent frequency error per mode pair, default pairing threshold MAC 0.7 ([Maya HTT](https://www.mayahtt.com/blog/correlating-simulation-modal-test-results-simcenter-3d/)).
- **Ansys SimAI** (ML surrogate): a confidence score equal to the normalised distance to the closest training sample; High/Low threshold 0.66 (user guide) or 2/3 at the 95th percentile (SimAI Pro docs). The documentation states it is not correlated with error and must not be the only validation metric; a Model Evaluation Report shows parity plots and error on held-out test data ([SimAI UG](https://ansyshelp.ansys.com/public/Views/Secured/SimAI/v000/en/SimAI_ug/SimAI_ug/C_UG_SAI_confidence_score.html); [SimAI Pro docs](https://simai-pro.docs.ansys.com/version/stable/user_guide/prediction/step_postprocessing.html)).
- Not retrieved: Fusion mesh-convergence documentation, Simcenter error-estimate documentation, SimScale and Onshape singularity warnings (gap).
- Inference (from the notes): an energy or displacement criterion can be met while the peak stress at a re-entrant corner grows without bound. Both SOLIDWORKS ("not the stress accuracy") and Creo (maximum principal stress as a selectable quantity) implicitly acknowledge this. Only p-adaptive (Creo) and h-adaptive (Inventor, Ansys) tools show a numerical stopping criterion; none of the CAD tools found reports an error bound in MPa.

### How results should be reported

NASA-STD-7009B sec. 4.3.8 is the clearest free, citable reporting requirement ([NASA-STD-7009B](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf)):

- Decision makers need (1) the best estimate, (2) a statement of uncertainty, (3) the capability and results credibility assessments, (4) explicit caveats for use outside assumptions or limits, and (5) the risks of accepting the results.
- [M&S 32]: explicit warnings, with at least a qualitative impact estimate, for unachieved acceptance criteria, violated assumptions, violated limits, execution warnings and errors, unfavourable appropriateness outcomes, setup and use issues, waivers and outstanding defects. Where evidence is absent, a warning is to be given (sec. 4.3.8.1).
- [M&S 33]: one of a quantitative uncertainty estimate, a qualitative one (small, medium or large, with justification), or a clear statement that none is available; the rationale notes that results without an uncertainty estimate may differ vastly from those shown (sec. 4.3.8.2).
- [M&S 34]: describe how the uncertainty was estimated. [M&S 35] and [M&S 50]: report capability and results assessment levels and gaps to thresholds. [M&S 36]: technical review findings. [M&S 37]: qualifications of developers and analysts (secs. 4.3.8.3-4.3.8.7).
- ASME V&V 10's uncertainty and validation-metric reporting guidance and NAFEMS reporting guidance were not read (paywalled).
- Analysts writing about designer-run FEA add, as opinion: results must be shown not to depend significantly on the mesh before use (Kurowski, [Machine Design](https://www.machinedesign.com/archive/article/21817360/more-errors-that-mar-fea-results)); and new users tend to stop at the whole-model peak stress and colour plots rather than numbers that show what the solver did (R. P. Johnson, [Fluxus Engineering](https://fluxus-engineering.com/ecittt_johnson.htm), undated).

## Programs

Public documentation, vendor pages, forum threads and licence files only; no program was run. Every vendor number is a **vendor claim** or **vendor verification result** and describes that program only. "(unverified)" marks items from prior knowledge or secondary sources.

### Corporate status as of October 2026

- Siemens completed its acquisition of Altair Engineering on 2025-03-26 for an enterprise value of about USD 10 billion ([Digital Engineering 24/7, 2025-03](https://www.digitalengineering247.com/article/siemens-completes-acquisition-of-altair/news); [Machine Design, 2025-03](https://machinedesign.com/automation-iiot/news/55277904/siemens-siemens-completes-10-billion-acquisition-of-altair-engineering); [NAFEMS news](https://www.nafems.org/about-us/media/news/industrynews1003/siemens-completes-10-billion-acquisition-of-altair-engineering/)). Altair products now appear as Simcenter OptiStruct, Simcenter Inspire 2026.1 and Simcenter PhysicsAI ([Siemens OptiStruct page](https://www.siemens.com/ko-kr/products/simcenter/mechanical-simulation/optistruct/); [Inspire 2026.1 blog](https://blogs.sw.siemens.com/simcenter/whats-new-in-simcenter-inspire-2026-1/); [Simcenter summer 2026 press](https://news.siemens.com/fr-ca/siemens-simcenter-summer-2026/)). Old altair.com blog URLs redirect to the Siemens Simcenter blog (observed 2026-10). Whether SimSolid is now named "Simcenter SimSolid" is unverified; a Siemens release says SimSolid runs inside Designcenter directly on geometry without a mesh ([HPCwire reprint, 2026](https://www.hpcwire.com/off-the-wire/siemens-accelerates-engineering-simulation-with-a-unified-ai-powered-simcenter-portfolio/)).
- Ansys was acquired by Synopsys, with the deal closing in 2025-07 (unverified). Ansys help remains at ansyshelp.ansys.com.
- NVIDIA Modulus was renamed NVIDIA PhysicsNeMo, Apache-2.0 ([NVIDIA developer page](https://developer.nvidia.com/modulus); licence metadata read 2026-10-28); the rename year 2025 comes from a third-party list (unverified).

### Built into CAD products

**Autodesk Inventor: Stress Analysis (built in)**

- Does: linear static and modal analysis of solids.
- Convergence: p-refinement in the first 2-3 iterations, then optional h-refinement cycles where convergence is poor, controlled by an "h refinement threshold" ([Autodesk Support](https://knowledge.autodesk.com/support/inventor-products/learn-explore/caas/sfdcarticles/sfdcarticles/h-refinement-threshold-s.html); [Inventor 2014 help, Set Convergence](https://help.autodesk.com/cloudhelp/2014/ENU/Inventor/files/GUID-11F5A03D-8ED7-4330-8D87-D435756B5ED4.htm)).
- Users praise / complain: forum advice is to check the convergence plot and reaction forces; one user reports stress rising indefinitely with refinement, the singularity symptom ([Autodesk Inventor forum](https://forums.autodesk.com/t5/inventor-forum/stress-analysis-convergence/td-p/5030224); anecdotal). A forum reply says sharp-corner singularities matter less for ductile materials and more for brittle materials and fatigue ([Autodesk forum](https://forums.autodesk.com/t5/inventor-forum/fea-mesh-settings/m-p/9656903); opinion).
- Verification material: none found.

**Autodesk Inventor Nastran**

- Does: an add-in using the Autodesk Nastran solver. Analysis list (linear and nonlinear static, modal, buckling, heat transfer, dynamic response, fatigue, impact) from prior knowledge (unverified).
- Convergence: maximum number of h-refinements (default 5), a percent stop criterion on the change between refinements, converged quantity von Mises stress ([Inventor Nastran 2026 User's Guide](https://help.autodesk.com/cloudhelp/2026/ENU/NINCAD-UsersGuide/files/GUID-834A66B2-3777-481D-BE28-A741A60C6F17.htm)).
- Verification material: not found.

**Autodesk Fusion: Simulation**

- Does: linear static stress in the base subscription. Modal, thermal, thermal stress and shape optimisation are "Basic" (3 Flex tokens per solve); buckling, event simulation, nonlinear static, injection moulding and electronics cooling are "Advanced" (6 tokens), or covered by the Simulation Extension subscription ([Autodesk Flex rate sheet](https://autodesk.com/flexratesheet-ppr); [Fusion blog](https://www.autodesk.com/products/fusion-360/blog/fusion-360-simulation-extension/)). Solver: Autodesk Nastran (unverified).
- Compute location: Autodesk announced in 2022-08 that local solving of linear static, modal, thermal and thermal stress would end with the September 2022 update ([Fusion blog, 2022-08](https://autodesk.com/products/fusion-360/blog/?p=34470)); a support article says that from 2022-09-06 local solving is no longer an option ([Autodesk support](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Updates-to-the-Fusion-360-Simulation-Extension.html), snippet; page returned 403). A reseller-hosted Autodesk comparison matrix from 2023-01 says some study types can be solved locally after installing Autodesk Nastran solvers, without tokens ([Procad copy](https://www.procad.pl/wp-content/uploads/2023/01/fusion360-simulation-extension-comparison-matrix-en.pdf)). The two sources conflict; the 2023 matrix is newer, but the current 2026 status is unverified. The older (around 2019) "Linear Static = 5 cloud credits" rate is obsolete ([CADstudio FAQ](https://cadstudio.cz/dl/fusion-360-faq-cloud-credit-offerings-en.pdf)).
- Education: a moderator said unlimited cloud credits but at most 16 credits per job under the older credit system ([Autodesk forum](https://forums.autodesk.com/t5/fusion-support-forum/educational-account-access-simulations/m-p/13018990); date not captured, current status unverified).
- Users complain: see Complaints and requests, theme C (cloud-only solving, credits charged on failed solves, per-job caps).
- Convergence display and verification material: not found.
- Inference (from the notes): Fusion is the only mainstream CAD tool found that meters simulation per solve.

**SOLIDWORKS Simulation**

- Does: Standard, Professional and Premium tiers; static, then frequency, buckling, thermal, drop test and nonlinear depending on tier. Solvers FFEPlus (iterative) and direct sparse; draft (linear) and high-quality (quadratic) tets, shells and beams (unverified, prior knowledge).
- Trust aids: h-adaptive energy-norm target with an accuracy-bias slider; Stress Hot Spot Diagnostics for singularities (see Accuracy).
- Verification material: in-product Verification Problems checked against analytical solutions from Timoshenko's *Theory of Plates and Shells* and Roark's Formulas (static, thermal, frequency, nonlinear, drop test, buckling) plus NAFEMS benchmark sets (linear static, nonlinear, thermal, frequency, forced vibration, composites), flagged by tier ([SOLIDWORKS blog, 2013-06](https://blogs.solidworks.com/solidworksblog/2013/06/simulation-tip-solidworks-simulation-verification-problems.html); [Solid Solutions blog, 2017-09](https://solidsolutions.co.uk/Blog/2017/09/So-how-accurate-is-SOLIDWORKS-Simulation)). Count not found (the 2024 help page did not render; a knowledge-base article is login-gated).
- Users complain: maximum stress keeps rising with refinement ([3DSwym forum](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/simulation-meshing-stress-error_eNr7avHjSjizfZNkTXuq7w); [old forum thread 40580](https://forum.solidworks.com/thread/40580)). A reseller explains the hot-spot diagnostic: a singularity keeps rising with refinement, a real concentration converges ([Javelin, 2018-01](https://www.javelin-tech.com/blog/2018/01/solidworks-simulation-stress-singularity-diagnostic/)).

**Onshape Simulation**

- Does: linear static and modal analysis of parts and full assemblies, with mates translated into simulation kinematics; runs in any web browser; "does not require defeaturing or meshing" (vendor). Powered by TrueSOLID, proprietary technology PTC acquired with Frustum Inc. in 2018-11 ([Onshape Simulation page](https://www.onshape.com/en/features/simulation)). Modal analysis is linear, undamped, one modal simulation per assembly ([Onshape Help](https://cad.onshape.com/help/Content/Assembly/modal_simulation.htm)). Launched 2022-10 for Enterprise, with Professional to follow ([Digital Engineering 24/7, 2022-10](https://www.digitalengineering247.com/article/ptc-offers-cloud-native-simulation-in-onshape)).
- Correction to a common assumption: no evidence was found that Onshape Simulation is built on Ansys technology; the PTC-Ansys products are Creo Simulation Live and Creo Ansys Simulation ([PR Newswire, 2020-11](https://www.prnewswire.co.uk/news-releases/ptc-and-ansys-deliver-latest-cad-market-innovation-with-creo-ansys-simulation-806401036)).
- Trust aids: "adaptive" background refinement, no criterion or error metric published.
- Users praise: one user says a consultant's Ansys result matched Onshape once loading was set up correctly ([Onshape forum 104956](https://forum.onshape.com/discussion/comment/104956)). Users complain or ask: local von Mises much higher than SimSolid on a ~12 m assembly while overall deflection matched (SimScale agreed with SimSolid) ([Onshape forum 84327](https://forum.onshape.com/discussion/comment/84327); attribution unverified); contact definition and welds in assemblies; solve time with no-penetration contact (see Complaints, theme D).
- Verification material: none found.

**Solid Edge Simulation**

- Does: linear static, modal, buckling and thermal, with Premium adding more, based on Femap and Simcenter Nastran technology (unverified; no page fetched). Verification material: not found. Users: no threads in the notes.

**Creo Simulate, Creo Simulation Live and Creo Ansys Simulation**

- *Creo Simulate* (formerly Pro/MECHANICA): p-version elements; convergence methods Quick Check, Single-Pass Adaptive and Multi-Pass Adaptive; polynomial order 1-6 by default; percent convergence default 10 %, advised 1-25 % (see Accuracy) ([PTC Help, Creo 13](https://support.ptc.com/help/creo/creo_pma/r13/usascii/simulate/simulate/specifying_p_ord_mpaa.html)). Analysis list (static, modal, buckling, thermal, fatigue) unverified.
- *Creo Simulation Live*: natively integrated structural, modal and thermal analysis from Ansys Discovery Live technology ([NVIDIA blog, around 2018](https://blogs.nvidia.com/?p=42054)). A live-in-CAD tool (below).
- *Creo Ansys Simulation*: Ansys meshing and solver inside Creo, launched 2020-11 ([PR Newswire](https://www.prnewswire.co.uk/news-releases/ptc-and-ansys-deliver-latest-cad-market-innovation-with-creo-ansys-simulation-806401036)).
- Both Ansys-based products moved to the Ansys 23R2 solver (release notes 2024-05) and then 24R2 (2025-02); PTC claims improved contact and accuracy (vendor claim) ([PTC Help, solver upgrade](https://support.ptc.com/help/creo/creo_plus/usascii/whats_new/creo_ansys_sim_live_solver_upgrade.html); [Ansys solver update](https://support.ptc.com/help/creo/creo_plus_early_visibility/usascii/whats_new/ansys_simulation_solver_update.html)).
- Verification material: a verification guide ships modal, static structural and thermal models compared with calculated results, Creo Simulate, Discovery Explore (for Simulation Live) and Discovery Refine (for Ansys Simulation), run on a Quadro RTX4000 8 GB; no percentage differences on the public page ([PTC Help, Creo 12](https://support.ptc.com/help/creo/creo_pma/r12/usascii/simulate/simulation_live/verification_models_sim_live.html)).

**Simcenter 3D (with NX)**

- Siemens pre- and post-processing on NX with Simcenter Nastran (linear and nonlinear statics, normal modes, buckling, dynamics), Samcef and others (unverified; no page fetched). Test correlation reports MAC and frequency error per mode pair, default MAC pairing threshold 0.7 ([Maya HTT](https://www.mayahtt.com/blog/correlating-simulation-modal-test-results-simcenter-3d/)).

### Standalone and cloud

**Ansys Mechanical (and MAPDL)**

- Does: full linear, nonlinear, dynamic and thermal analysis with h and p elements.
- Trust aids: adaptive convergence on a percent change (default 20 %); "Error (Structural)" energy-norm estimate per element (see Accuracy).
- Verification material: the MAPDL Verification Manual covers "most element types and major solution capabilities" and is described as a small subset of the internal QA library; a separate chapter reproduces NAFEMS benchmarks (LSB2, P09 free vibration, R-series) ([Ansys VM 2024 R2](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_CH1_3.html); [NAFEMS chapter](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_CH4_1.html)). Total count about 300 cases from prior knowledge (unverified).

**Ansys LS-DYNA**

- Explicit (and implicit) nonlinear dynamics for crash and impact (unverified; not fetched). No further material in the notes.

**Abaqus (SIMULIA, Dassault Systèmes)**

- Abaqus/Standard (implicit) and Abaqus/Explicit; adaptive remeshing driven by error indicators ([Abaqus 2016 USB 12.3.1](https://ceae-server.colorado.edu/v2016/books/usb/pt04ch12s03abo15.html)). Its Benchmarks Guide publishes NAFEMS LE10, LE11 and pinched-cylinder results (vendor verification results; see Accuracy). The Benchmarks and Verification Guide indexes were not fetched.

**MSC Nastran (Hexagon), Simcenter Nastran with Simcenter Femap, Autodesk Nastran**

- MSC Nastran 2021.1 and MSC Marc 2021.1 have vendor-performed entries in the NAFEMS Code Verification series ([NAFEMS](https://www.nafems.org/publications/code-verification/)).
- Simcenter Nastran with Femap (Windows pre- and post-processor): unverified; not fetched.
- Autodesk Nastran: the standalone solver behind Inventor Nastran and Fusion local solving ([Procad matrix, 2023-01](https://www.procad.pl/wp-content/uploads/2023/01/fusion360-simulation-extension-comparison-matrix-en.pdf)).
- Remote-load elements RBE2 and RBE3 are Nastran names (see Fundamentals, Supports and loads).

**Simcenter OptiStruct (formerly Altair OptiStruct)**

- Structural solver positioned for lightweighting and topology and shape optimisation (vendor positioning) ([Siemens OptiStruct page](https://www.siemens.com/ru-ru/products/simcenter/mechanical-simulation/optistruct/)). Version 2022.2 in the NAFEMS Code Verification series. Its public help publishes MacNeal-Harder and NAFEMS LE1, LE10, LE11 and Scordelis-Lo results (vendor verification results; see Fundamentals and Accuracy). Fatigue: default equivalent stress is absolute maximum principal ([Altair OptiStruct help, S-N method](https://help.altair.com/hwsolvers/os/topics/solvers/os/fatigue_fpm_sn_stress_life_method_r.htm)).

**COMSOL Multiphysics, Structural Mechanics Module**

- Full structural analysis with user-chosen element order; an Adapt operation refines from error information ([COMSOL 6.4](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_mesh.24.41.html)). Its Application Library publishes LE1, LE10 and Scordelis-Lo models with their targets. Licences perpetual or annual, node-locked or floating, prices on request (unverified).

**fe-safe (Dassault/SIMULIA) and nCode DesignLife (HBK) for fatigue**

- fe-safe: a fatigue post-processor reading FE stresses, an Abaqus/CAE add-on with direct interfaces to leading FE suites; contour plots of damage, life and factor of safety ([fe-safe User Guide, Abaqus 2024 docs, VT mirror](https://docs.software.vt.edu/abaqusv2024/English/FesafeUserPdf/FesafeUser.pdf)). It accepts FE stress sequences, modal superposition and rainflow matrices as loading (vendor brochure, [Beacon India](https://www.beacon-india.com/wp-content/themes/beaconindia/pdf/fe-safe-brochure.pdf)).
- nCode DesignLife: reads results from Ansys, Nastran, Abaqus, OptiStruct and LS-DYNA; latest noted release 2026.1; also embedded in Ansys Mechanical; builds the fatigue process from "glyphs" ([HBK](https://www.hbkworld.com/en/products/software/durability/designlife-cae-fatigue-analysis); [Ansys Help 2025 R1](https://ansyshelp.ansys.com/public/views/secured/corp/v251/en/ans_tec/tecfrettwear_postnCode.html); [HBK webinar](https://hbkworld.com/en/knowledge/resource-center/recorded-webinars/performing-fe-based-fatigue-analysis-with-ncode)). Pricing not public.

**SimScale (cloud, browser)**

- Free Community plan for non-commercial use with all projects public; an earlier plan gave 3,000 core-hours per year and 500 GB storage; the newer page says free for testing and learning with limited simulations and analysis types (static, frequency, heat transfer, thermomechanical, harmonic, dynamic); paid plans on quote; optional Nonlinear Mechanical (Marc) add-on ([SimScale pricing](https://simscale.com/product/pricing/); [forum, plans](https://www.simscale.com/forum/t/simscale-plans-pricing/27827); [forum, 2026-06](https://www.simscale.com/forum/t/simscale-opens-simerics-mp-mesher-and-simerics-mp-solver-to-its-entire-community-free-to-try-for-non-commercial-use/101137.md)).
- No eigenvalue buckling module, per a support reply ([SimScale forum](https://www.simscale.com/forum/t/eigenvalue-based-buckling-analysis/85429)). Structural solvers based on code_aster or CalculiX (unverified).
- SimScale's blog calls mesh convergence one of the most overlooked issues for accuracy ([SimScale blog](https://www.simscale.com/blog/convergence-finite-element-analysis/); vendor opinion).

### Live-in-CAD competitors

These tools give results within seconds while the user edits geometry, by avoiding a body-fitted mesh or by running on the GPU.

**Ansys Discovery (Explore and Refine)**

- Explore mode voxelises geometry and runs real-time CUDA GPU solvers, which per Ansys removes mesh generation; Refine mode uses the meshed Mechanical and Fluent solvers for higher fidelity ([Ansys FAQ](https://innovationspace.ansys.com/knowledge/forums/topic/what-simulation-technology-does-ansys-discovery-use-in-explore-mode/); [Ansys forum, Explore vs Refine](https://innovationspace.ansys.com/forum/forums/topic/explore-mode-vs-refine-mode)). Explore uses simplified rigid approximations for supports and joints ([Ansys forum reply](https://innovationspace.ansys.com/forum/forums/reply/372416/)). Case size is limited by GPU memory; a 2018 source gave at least 4 GB with 8 GB recommended (likely outdated) ([NVIDIA blog](https://blogs.nvidia.com/?p=42054)).
- Ansys teaches validating Explore results with Refine ([Ansys course](https://innovationspace.ansys.com/courses/courses/conjugate-heat-transfer/lessons/validation-in-refine-mode-lesson-5/)). 2024 R1 claims up to 10x better accuracy for thin features with less GPU memory (vendor claim; [Ansys webinar](https://www.ansys.com/webinars/ansys-2024-r1-ansys-discovery-whats-new); [ESSS](https://www.esss.com/en/ansys-simulation-software/ansys-discovery/)).
- Published accuracy: see the mesh-avoiding table in Fundamentals (thermal 2.7 % vendor partner; user anecdotes of 80 % higher stress in 2020 and very different fluid results). No peer-reviewed independent structural accuracy study found.

**SimSolid (Altair, now Siemens)**

- Meshless "external approximations" (Apanovitch); works on full assemblies without defeaturing or meshing; adaptive solution passes ([Altair product intro](https://2021.help.altair.com/2021/ss/topics/simsolid/get%20started/product_intro_r.htm)). Analyses: static, modal, thermal and some nonlinear (from the NAFEMS benchmark list).
- Verification: vendor-performed NAFEMS code-verification manual for version 2022.3 with 21 benchmarks; a NAFEMS-authored *Benchmark* magazine article (Symington, 2020-01) with 8 benchmarks against mesh-converged FEA; vendor-hosted third-party and vendor blog comparisons (see the mesh-avoiding table).
- Users: an Onshape forum user notes polarised opinions about meshless accuracy ([Onshape forum 104982](https://forum.onshape.com/discussion/comment/104982)); an Eng-Tips thread points to the NAFEMS article and says results depend on settings ([Eng-Tips 466382](https://www.eng-tips.com/viewthread.cfm?qid=466382)); an Altair community thread on benchmarks ([Altair community 12193](https://community.altair.com/discussion/12193/simsolid-benchmarks-and-validation)). Trade press headline: "faster than FEA, just as accurate" ([engineering.com](https://www.engineering.com/simsolid-faster-than-fea-just-as-accurate-whats-not-to-like/); date not captured).

**Creo Simulation Live**

- Discovery-derived GPU structural, modal and thermal analysis inside Creo (see above). Only vendor release-note accuracy claims exist; no independent study found.

### ML surrogates

| Product | What it is | Data needs | Published accuracy | Trust signal | Licence |
|---|---|---|---|---|---|
| NVIDIA PhysicsNeMo (formerly Modulus) | Open-source PyTorch framework for physics AI: physics-informed neural networks, neural operators, graph neural networks | Per user model | None at product level; per user model | Whatever the user builds | Apache-2.0 ([NVIDIA](https://developer.nvidia.com/modulus); [GitHub](https://github.com/NVIDIA/modulus)) |
| Ansys SimAI | Cloud SaaS field prediction by deep learning | Typically 30-100 simulation results (vendor) | Predictions "within a few percentage points" of simulation when training data is sufficient and diverse (vendor claim relayed by [Machine Design](https://machinedesign.com/cad-cam-software/article/55304730/ml-enhanced-computer-aided-engineering-in-the-cloud)) | Distance-based confidence score (threshold 0.66 or 2/3), which Ansys says is not correlated with error; a Model Evaluation Report with parity plots on held-out tests; retraining offered for designs far from training data | Commercial ([Ansys SimAI](https://ansys.com/products/simai)) |
| Simcenter PhysicsAI (formerly Altair physicsAI) | Geometric deep learning; Inspire 2026.1 trains from OptiStruct and SimSolid results and predicts on new geometry without a solve | Previous results | "Up to 1000x" faster than a solver (vendor claim); no accuracy percentage found | None found | Commercial ([Siemens blog](https://blogs.sw.siemens.com/simcenter/whats-new-in-simcenter-inspire-2026-1/)) |
| Neural Concept | CAD-native surrogates trained on customer simulation and test data; integrations with NX, CATIA, SOLIDWORKS; Siemens collaboration 2024-06 | Customer data | None found | None found | Commercial ([Neural Concept](https://neuralconcept.com/post/neural-concept-collaborates-with-siemens-to-enable-oems-to-make-faster-decisions-with-rapid-results-prediction); [Siemens](https://news.siemens.com/es-es/neural-concept-simcenter/)) |
| Monolith AI | Test-data-driven ML; Siemens Energy steam-turbine case study | Test data | None on the page | None found | Commercial ([Monolith](https://www.monolithai.com/case-studies/monolith-siemens-energy-integration)); marginal relevance to FEA |

- Inference (from the notes): all surrogates need a training set of solver results on similar geometry; out-of-distribution handling is detection (distance to training data) plus retraining, not a guaranteed error bound. No independent benchmark of any commercial structural surrogate was found.
- SolidCraft context: [#3239](https://github.com/tangency-labs/solidcraft/issues/3239) mentions generating data for AI training as one goal of a simulation workspace.

### Open source

Licences checked against licence files or GitHub metadata on 2026-10-28 unless marked. No copyleft source code was opened.

| Program | Licence | What it does | Notes |
|---|---|---|---|
| CalculiX | GPL-2.0 (copyleft) | Static, modal, buckling, nonlinear, thermal; Abaqus-like elements (unverified) | Licence from [OSArch wiki](https://wiki.osarch.org/calculix/) (secondary; calculix.de not fetched) |
| code_aster | GPL (GPL-3.0 currently, unverified) (copyleft) | Very broad; EDF validation tests (unverified) | Released by EDF as free software in 2001-10 ([FSFE list](https://lists.fsfe.org/pipermail/discussion/2001-October/001935.html)) |
| Elmer FEM | GPL-2.0-or-later at top level (copyleft); ElmerSolver library under LGPL-2.1 per the issue, not stated in the top-level file (unverified) | Multiphysics | [Elmer LICENSE.md](https://github.com/ElmerCSC/elmerfem/blob/devel/LICENSE.md) |
| FEniCSx / DOLFINx | LGPL-3.0 (copyleft) | Library for user-defined PDEs, arbitrary order | [FEniCS/dolfinx](https://github.com/FEniCS/dolfinx) |
| FreeCAD FEM workbench | LGPL-2.1 (copyleft) | GUI front end for CalculiX, Elmer and others (Z88 unverified) | [FreeCAD/FreeCAD](https://github.com/FreeCAD/FreeCAD) |
| Gmsh, Netgen, TetGen | GPL-2.0-or-later with exception, LGPL-2.1, AGPL-3.0 (copyleft) | Meshers | See Fundamentals, Meshing |
| deal.II | Apache-2.0 with LLVM exception OR LGPL-2.1-or-later (permissive option); some bundled, example and test files differ | Library; adaptive hp, matrix-free multigrid | [deal.II LICENSE.md](https://github.com/dealii/dealii/blob/master/LICENSE.md) |
| MFEM | BSD-3-Clause (permissive) | Library; high-order, GPU partial assembly | [mfem/mfem](https://github.com/mfem/mfem) |
| MYSTRAN | MIT (permissive) | Nastran-like linear static, modal, buckling (analysis list unverified) | [dr-bill-c/MYSTRAN](https://github.com/dr-bill-c/MYSTRAN) |
| FEBio | MIT from v2.9; older versions under a non-commercial licence | Nonlinear biomechanics | [FEBio](https://github.com/febiosoftware/FEBio); [Wikipedia](https://en.wikipedia.org/wiki/FEBio) |
| Kratos Multiphysics | Core under a 4-clause BSD with an advertising clause; applications may carry their own | Multiphysics | [Kratos license.txt](https://github.com/KratosMultiphysics/Kratos/blob/master/kratos/license.txt). Inference: the advertising clause is unusual to absorb into an MIT/Apache project |
| MOOSE, libMesh | LGPL-2.1 (copyleft) | Multiphysics framework, FE library | [idaholab/moose](https://github.com/idaholab/moose); [libMesh](https://github.com/libMesh/libmesh) |
| Rust: fenris; russell, gemlab, pmsim; finiteelement | MIT OR Apache-2.0; MIT; MIT OR Apache-2.0 | Experimental FE crates; fenris README discourages production use | See Fundamentals, Solvers |

Inference (from the notes): for an MIT OR Apache-2.0 Rust project, the licence-compatible reference codes in this list are MFEM, deal.II (Apache side), FEBio, MYSTRAN, fenris, russell, gemlab, pmsim and PhysicsNeMo; Kratos needs care because of its advertising clause.

### NAFEMS Code Verification series and other verification manuals

- NAFEMS hosts vendor-performed verification results for six codes as of 2026-10 (see Accuracy). The SimSolid 2022.3 entry lists 21 benchmarks with percentages only in the downloadable manual ([NAFEMS](https://www.nafems.org/publications/code-verification/simsolid-code-verification/)).
- Inference (from the notes): NAFEMS LE1, LE10 and similar are the common cross-vendor targets, but programs can only be compared through each vendor's self-reported numbers.

### Comparison table

Cells marked (u) are unverified. Citations are in the program entries above.

| Program | Category | Main structural analyses | Element / method | Convergence or error shown to the user | Compute / platform | Licence / price model | Public verification material |
|---|---|---|---|---|---|---|---|
| Inventor Stress Analysis | CAD-embedded | Linear static, modal | Tets; p then h refinement | h/p settings, convergence plot | Local desktop | In Inventor subscription (u) | None found |
| Inventor Nastran | CAD-embedded | Static, modal, buckling, nonlinear, dynamics, fatigue (u) | Autodesk Nastran elements | h-refinement, % stop criterion on von Mises | Local | Autodesk subscription (u) | Not found |
| Fusion Simulation | CAD-embedded, cloud | Linear static (base); modal, thermal, buckling, nonlinear, event (tokens or extension) | Autodesk Nastran (u) | Not found | Cloud solve; local status conflicting | Subscription plus 0/3/6 tokens per study, or Simulation Extension | Not found |
| SOLIDWORKS Simulation | CAD-embedded | Static; frequency, buckling, thermal, drop, nonlinear by tier | Linear and quadratic tets, shells, beams (u) | Energy-norm h-adaptive; hot-spot diagnostics | Local | Standard / Professional / Premium | In-product verification problems and NAFEMS sets |
| Onshape Simulation | CAD-embedded, browser | Linear static, modal | Proprietary TrueSOLID, no user mesh | "Adaptive", no number | Cloud and browser | Professional / Enterprise plans (u for current) | None found |
| Solid Edge Simulation | CAD-embedded | Static, modal, buckling, thermal (u) | Simcenter Nastran-based (u) | (u) | Local | Tiers (u) | Not found |
| Creo Simulate | CAD-embedded | Static, modal, buckling, thermal, fatigue (u) | p-elements, order 1-6 | Multi-pass % convergence (1-25 %) | Local | Creo add-on (u) | Not found |
| Creo Simulation Live | Live-in-CAD | Static, modal, thermal | Ansys Discovery GPU technology | None | Local GPU | Creo add-on (u) | PTC verification guide (no % public) |
| Creo Ansys Simulation | CAD-embedded | Static, modal, thermal (u) | Ansys solver (24R2) | (u) | Local | Creo add-on (u) | PTC verification guide |
| Simcenter 3D / NX | CAE pre/post plus solver | Nastran range (u) | Simcenter Nastran | (u); MAC test correlation | Local / HPC | Siemens licence (u) | Not found |
| Ansys Mechanical | Standalone | Full linear, nonlinear, dynamic, thermal | h and p elements | Adaptive % (20 % default), Error (Structural) | Local / HPC / cloud | Commercial (u) | MAPDL Verification Manual with NAFEMS chapter |
| Ansys Discovery | Live-in-CAD | Explore (GPU voxel) and Refine (Ansys solver) | Voxel against FE | None in Explore | Local GPU | Subscription (u) | Not found |
| Ansys LS-DYNA | Standalone | Explicit and implicit nonlinear dynamics | (u) | (u) | Local / HPC | Commercial (u) | Not checked |
| Abaqus | Standalone | Standard and Explicit, nonlinear | Full library | Error indicators, adaptive remeshing | Local / HPC | Commercial (u) | Benchmarks Guide (not fetched in full) |
| MSC Nastran / Marc | Standalone | Linear and nonlinear | Nastran library | (u) | Local / HPC | Commercial (u) | NAFEMS Code Verification (vendor) |
| Simcenter Nastran with Femap | Standalone | Nastran range | Nastran library | (u) | Local Windows | Commercial (u) | Not found |
| Autodesk Nastran | Standalone solver | Nastran range (u) | Nastran library | (u) | Local | Autodesk (u) | Not found |
| Simcenter OptiStruct | Standalone | Linear, nonlinear, optimisation | Nastran-style | (u) | Local / HPC | Siemens (u) | NAFEMS Code Verification 2022.2 (vendor); public help results |
| SimSolid | Meshless, near-live | Static, modal, thermal, some nonlinear | External approximations | Adaptive passes | Local | Siemens (u) | NAFEMS Code Verification 2022.3 (21 benchmarks, vendor); NAFEMS article 2020 |
| COMSOL Structural Mechanics | Standalone multiphysics | Full | FE, user order | Adapt from error | Local | Commercial | Application Library models |
| fe-safe / nCode DesignLife | Fatigue post-processors | Fatigue from FE stress | n/a | n/a | Local | Commercial, price not public | Not found |
| SimScale | Cloud, browser | Static, frequency, thermal, dynamic, harmonic; Marc add-on; no linear buckling | (u) | (u) | Cloud / browser | Free Community (public, non-commercial); paid on quote | Not found |
| Ansys SimAI | ML surrogate SaaS | Field prediction | Deep learning | Distance-based confidence score (not an error) | Cloud | Commercial | Model Evaluation Report per model |
| NVIDIA PhysicsNeMo | ML framework | User-built | PINN, neural operators, GNN | User-built | Local GPU | Apache-2.0 | n/a |
| Simcenter PhysicsAI | ML surrogate | Field prediction | Geometric deep learning | None found | Local, in Inspire | Siemens | None found |
| Neural Concept / Monolith | ML surrogate | Prediction | Deep learning | None found | Cloud / on-premise (u) | Commercial | None found |
| CalculiX | Open source | Static, modal, buckling, nonlinear, thermal (u) | Abaqus-like (u) | n/a | Local | GPL-2.0 | (u) |
| code_aster | Open source | Very broad | n/a | (u) | Local | GPL (v3 u) | EDF validation manuals (u) |
| Elmer | Open source | Multiphysics | n/a | n/a | Local | GPL-2.0-or-later (solver library LGPL u) | n/a |
| FEniCSx | Open-source library | User-defined PDEs | Arbitrary order | User-built | Local | LGPL-3.0 | n/a |
| FreeCAD FEM | Open-source GUI | Wraps CalculiX, Elmer and others | Via solvers | n/a | Local | LGPL-2.1 | n/a |
| deal.II / MFEM / libMesh / MOOSE | Libraries | User-built, adaptive hp | Arbitrary order | Built-in a-posteriori estimators (u) | Local / HPC | Apache-2.0+LLVM or LGPL / BSD-3 / LGPL-2.1 / LGPL-2.1 | n/a |
| FEBio | Open source | Nonlinear biomechanics | n/a | n/a | Local | MIT | n/a |
| Kratos | Open source | Multiphysics | n/a | n/a | Local | BSD-4 (core) | n/a |
| MYSTRAN | Open source | Nastran-like linear static, modal, buckling (u) | Nastran cards | n/a | Local | MIT | n/a |
| Rust crates (fenris, russell, gemlab, pmsim) | Experimental | Experimental FE | n/a | n/a | Local | MIT OR Apache-2.0 / MIT | n/a |

## Complaints and requests

**Coverage warning.** Reddit could not be fetched, and Autodesk forum and support pages returned HTTP 403, so almost no vote, kudos or reply counts could be recorded. Counts below come only from GitHub (read through its API) and from search snippets. The ordering of themes is therefore a judgement from how often each theme recurred across sources, not from vote totals (inference). Each item is labelled fact, request or opinion. Access date 2026-10-28 unless stated.

### Theme A: the export round trip and no parametric re-run

Most recurrent in SolidCraft's own tracker.

| Item | What it says | Backing | Source |
|---|---|---|---|
| Request: linear static FEA for parts | Every design iteration means exporting STEP, checking in another program, editing and re-exporting. Asks for single-body linear static with library material, fixed faces, loads, von Mises, displacement, factor of safety. Triage confirmed single-body static as the first step. | Opened 2026-10-26, closed the same day; 2 comments, 0 reactions | [solidcraft#6971](https://github.com/tangency-labs/solidcraft/issues/6971) |
| Request: FieldCraft as a simulation branch | Seamless CAD-FEA interaction so a design change does not mean jumping to the separate FieldCraft tool; automated FEA-driven design variants; data generation for AI training; FieldCraft would become a Simulation workspace while staying standalone. | Opened 2026-10-19, open; 2 comments, 0 reactions | [solidcraft#3239](https://github.com/tangency-labs/solidcraft/issues/3239) |
| Request: names on faces and bodies in STEP | Write face and body names into STEP (the ADVANCED_FACE name string) so most FEA tools can re-attach loads and supports by name after export. | 2026-10-18; 0 comments per API | [solidcraft discussion #2381](https://github.com/tangency-labs/solidcraft/discussions/2381) |
| Fact: tiny defects break the export path | A Boolean retry left a step of about 1e-4 mm; STL had 19 open and 70 non-manifold edges, 3MF 41 open and 35 non-manifold; FieldCraft 0.7.0 refused the face-tagged 3MF (76 defects). | 2026-10-18, open; 1 comment | [solidcraft#2356](https://github.com/tangency-labs/solidcraft/issues/2356) |
| Fact: face-tagged 3MF export merged | Each triangle carries the index of its B-rep face in a SolidCraft XML namespace that plain readers ignore; coordinates in shortest round-trip f64 form. A route for passing face identity to a mesher. | Merged 2026-10-13 | [solidcraft#834](https://github.com/tangency-labs/solidcraft/pull/834) |
| Request: generative design / topology optimisation | Opened the same day as #6971. | 2026-10-26, open; 2 comments | [solidcraft#6972](https://github.com/tangency-labs/solidcraft/issues/6972) |
| Fact (context): multi-CAD | Tech-Clarity (Michelle Boucher, announced 2016-08-18, more than 160 manufacturers): 84 % of companies use two or more CAD tools; top performers were 89 % more likely to rate working with multi-CAD data as important. | Survey | [Siemens Simcenter blog, 2016-08-18](https://blogs.sw.siemens.com/simcenter/announcing-new-research-on-fea-simulation-bottlenecks/) |
| Opinion: Salome as a pipeline tool | In a thread on Fusion personal-use changes, one commenter recommended Salome. | HN thread, 2020-09 | [HN 24494653](https://news.ycombinator.com/item?id=24494653) |

Inference (from the notes): the supporting requests (#2381, #834, and the materials items under theme E) are all about keeping the analysis set-up attached to the CAD model across changes.

### Theme B: results that are misread

Most stressed by experienced analysts writing about designer-run FEA.

| Item | What it says | Kind | Source |
|---|---|---|---|
| Stress keeps rising with refinement | Users report maximum stress growing with every mesh refinement (singularity). | Complaint, several threads | [3DSwym SOLIDWORKS forum](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/simulation-meshing-stress-error_eNr7avHjSjizfZNkTXuq7w); [SOLIDWORKS forum 40580](https://forum.solidworks.com/thread/40580); [Autodesk Inventor forum](https://forums.autodesk.com/t5/inventor-forum/stress-analysis-convergence/td-p/5030224); [PhysicsForums](https://www.physicsforums.com/threads/mesh-changing-resulted-in-stress-change.512305/post-3397026) |
| Singularity diagnostic added | A singularity rises with refinement while a real concentration converges; SOLIDWORKS 2018 added a diagnostic. | Reseller guidance | [Javelin, 2018-01](https://www.javelin-tech.com/blog/2018/01/solidworks-simulation-stress-singularity-diagnostic/) |
| Peak at a fixture edge | A peak at the end of a fixture turned out on refinement to be a singularity, not the real concentration in a fillet. | Article | [engineering.com](https://www.engineering.com/?p=125052) (undated) |
| Factor of safety ambiguity | A poster computed a "safety factor" of 0.42 (207 MPa yield, 494 MPa von Mises); replies noted factor and margin of safety are used differently between industries. | Opinion of forum members | [Eng-Tips 431051](https://www.eng-tips.com/viewthread.cfm?qid=431051) (reply count not retrieved) |
| Over-design from stacked factors | A colleague applied a 3:1 yield factor on top of FEA and grossly oversized a part; a reply argues FEA should let parts get lighter without dropping safety factors. | Opinion | [Eng-Tips 153636](https://www.eng-tips.com/viewthread.cfm?qid=153636) |
| Colour plots instead of numbers | New users stop at whole-model peak stress and colour plots rather than numbers showing what the solver did. | Opinion of an experienced analyst | [R. P. Johnson, Fluxus Engineering](https://fluxus-engineering.com/ecittt_johnson.htm) (undated) |
| Designers lack the background | CAD designers usually lack the mechanics education to understand FEA and may not spot wrong results. | Opinion, educational literature | [ASEE PEER 532](https://peer.asee.org/532) |
| Convergence overlooked | Mesh convergence is one of the most overlooked issues; a run that completes with a plausible result is often treated as enough. | Vendor and training blogs, opinion | [SimScale blog](https://www.simscale.com/blog/convergence-finite-element-analysis/); [CAE University](https://caeuniversity.com/mesh-convergence-modern/) |
| Mesh independence first | Results must be shown not to depend significantly on the mesh, usually needing several iterations. | Analyst opinion | [Kurowski, Machine Design](https://www.machinedesign.com/archive/article/21817360/more-errors-that-mar-fea-results) |
| Ductile against brittle | Sharp-corner singularities matter less for ductile materials and more for brittle materials and fatigue. | Opinion | [Autodesk forum](https://forums.autodesk.com/t5/inventor-forum/fea-mesh-settings/m-p/9656903) |
| Democratisation limits | Many tools still need deep knowledge; part-time users need more support; weak simulation governance limits trust in non-expert results. | NAFEMS ASSESS, via trade press | [Digital Engineering 24/7](https://www.digitalengineering247.com/article/the-mission-to-democratize-simulation-at-turning-point) |

Inference (from the notes): the requests this theme implies are guidance on trust (convergence evidence, singularity flags, clear factor-of-safety wording) rather than more solver features.

### Theme C: cost, cloud and licence access

Most visible in Fusion.

| Item | What it says | Backing | Source |
|---|---|---|---|
| Fact: Fusion cloud-only solving from 2022-09-06 | Local simulation solving no longer an option. | Autodesk support article (snippet; 403) | [Autodesk support](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Updates-to-the-Fusion-360-Simulation-Extension.html); [local simulation article](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-perform-a-local-simulation-in-Fusion-360.html) |
| Complaint: cloud-only announcement | Many users objected that local solve had been part of the basic package for years; one says about USD 300 of credits for a few tests is not acceptable; another claims about USD 1,600 per year for the extension (unverified). | Thread 2022-08; counts not retrievable | [Autodesk forum 11342929](https://forums.autodesk.com/t5/fusion-support-forum/fusion-360-cloud-solving-will-be-the-only-option-available-for/td-p/11342929) |
| Request: petition to bring back local simulation | Solves that took seconds now take minutes. | Counts not retrievable | [Autodesk forum 12624726](https://forums.autodesk.com/t5/fusion-support-forum/petition-bring-back-local-simulation/m-p/12624726) |
| Complaint: credits charged on failure | "Failed to schedule cloud solve" on a buckling study consumed 30 credits over two attempts; the user argued credits should not be charged when the cloud was unavailable. | Counts not retrievable | [Autodesk forum 10263646](https://forums.autodesk.com/t5/fusion-support-forum/error-failed-to-schedule-cloud-solve-buckling-simulation/m-p/10263646) |
| Complaint: per-job credit caps for students | A student hit a 16-credit per-request cap (exceeded by 5); another saw 16 credits while the account said unlimited. | Snippets | [Autodesk forum 7793038](https://forums.autodesk.com/t5/fusion-support-forum/increase-cloud-credit-threshold/m-p/7793038/highlight/true); [Autodesk forum 10309287](https://forums.autodesk.com/t5/fusion-support-forum/fusion-360-cloud-credits/m-p/10309287) |
| Complaint: progress display | A cloud simulation looked stuck for over 2 h; staff explained the percentage is per stage, not overall. | Snippet | [Autodesk forum 11179553](https://forums.autodesk.com/t5/fusion-support/cloud-simulation-stuck/m-p/11179553) |
| Opinion: local solve as an option | For generative design, offering local solving as an option makes the most sense. | Snippet | [Autodesk forum 8343494](https://forums.autodesk.com/t5/fusion-design-validate-document/generative-design-solve-locally/td-p/8343494) |
| Complaint: personal tier | Simulation no longer available on Fusion's personal tier (2020). | HN comment, opinion | [HN 24494653](https://news.ycombinator.com/item?id=24494653) |
| Fact: SimScale free tier is public | The free Community plan is for non-commercial use with all projects public. | Vendor page | [SimScale pricing](https://simscale.com/product/pricing/) |

Inference (from the notes): pricing and compute-location changes generate more forum heat than solver accuracy for hobbyist-tier tools.

### Theme D: assemblies, contact, welds and agreement between tools

| Item | What it says | Kind | Source |
|---|---|---|---|
| Contact should be automatic | A user asked how contact between solids of different materials is defined; a moderator said it should be automatic. | Request / opinion | [Onshape forum 5133](https://forum.onshape.com/discussion/comment/5133) (date not retrieved) |
| Tools disagree locally | On a ~12 m assembly, Onshape's local von Mises was much higher than SimSolid's while overall deflection matched; SimScale agreed with SimSolid. | User report | [Onshape forum 84327](https://forum.onshape.com/discussion/comment/84327) (attribution unverified) |
| Welds in assemblies | Users asked how FEA treats welded parts when welds cannot be shown in an assembly. | Question | [Onshape forum 43710](https://forum.onshape.com/discussion/comment/43710) (attribution unverified) |
| Contact slows solves | No-penetration contact between a large lid and body drove up solve time. | User report | [Onshape forum 85552](https://forum.onshape.com/discussion/comment/85552/) (attribution unverified) |
| Demand for access | A user asked when simulation would reach Onshape Professional users (2022). | Request | [Onshape forum 19282, p3](https://forum.onshape.com/discussion/19282/improvements-to-onshape-october-10th-2022/p3) |
| Missing analysis type | SimScale has no eigenvalue buckling module. | Support reply | [SimScale forum](https://www.simscale.com/forum/t/eigenvalue-based-buckling-analysis/85429) |
| Fast tools disagree with flagship tools | Discovery Explore and Refine give very different results in some user cases. | User reports, anecdotal | [Ansys forum](https://innovationspace.ansys.com/forum/forums/topic/very-different-results-in-explore-and-refine-mode) |
| Meshless scepticism | Polarised opinions about whether meshless results are accurate. | Opinion | [Onshape forum 104982](https://forum.onshape.com/discussion/comment/104982); [Eng-Tips 466382](https://www.eng-tips.com/viewthread.cfm?qid=466382) |

### Theme E: engineering material data attached to the model (SolidCraft)

| Item | What it says | Backing | Source |
|---|---|---|---|
| Request: materials library | A materials library for accurate weights and for use in FEA. | 2026-10-13, open; 4 comments, 0 reactions | [solidcraft#785](https://github.com/tangency-labs/solidcraft/issues/785) |
| Fact: materials roadmap | A texture is not certified material data and density alone does not make a material ready for FEA. | 2026-10-13, open; 17 comments | [solidcraft#922](https://github.com/tangency-labs/solidcraft/issues/922) |
| Fact: physical material cards | Typed SI fields (density; isotropic E/ν or orthotropic E/G/ν; tensile, compressive, yield and shear strengths; thermal properties) with source and provenance records. | Closed 2026-10-14; 2 comments | [solidcraft#923](https://github.com/tangency-labs/solidcraft/issues/923) |
| Request: engineering-card inspector | A readable inspector so a visual swatch is not mistaken for engineering data. | 2026-10-14, open; 3 comments | [solidcraft#1094](https://github.com/tangency-labs/solidcraft/issues/1094) |

### Theme F: time lost to geometry preparation and meshing

See Fundamentals, "Volume meshing of CAD geometry" for the survey figures (25-38 % vendor figures against 70-80 % older Sandia-related figures) and [#2356](https://github.com/tangency-labs/solidcraft/issues/2356) as a concrete local example.

### What could not be established

- No vote, kudos or reply counts for Reddit (blocked), Autodesk forums and Ideas (403), Onshape, the SOLIDWORKS forum, PTC Creo ideas, the FreeCAD FEM forum or the SimScale forum.
- No Fusion or Inventor Ideas pages with vote counts were found for local solve, parametric re-run, report generation or bolted-joint checks; whether such ideas exist is unverified.
- No sourced evidence was found for unit confusion, bad default supports or poor report output as specific complaints; they may be common but are unverified.

## What users need

### Typical workflows

**Designer, CAD-embedded linear static** (SOLIDWORKS Simulation as described by resellers and tutorials: [Javelin, 2024-01](https://www.javelin-tech.com/blog/2024/01/basic-setup-steps-for-an-fea-static-simulation-in-solidworks/); [CATI](https://cati.com/?p=127493); [GrabCAD tutorial](https://grabcad.com/tutorials/how-to-do-your-first-static-simulation-in-solidworks); [Javelin, mesh refinement](https://www.javelin-tech.com/blog/?p=69113)):

1. Enable the simulation add-in and create a static study.
2. Assign a material to each body.
3. Add supports that remove the rigid-body degrees of freedom.
4. Apply loads: forces, pressures and so on.
5. Generate the mesh. Solution precision depends on mesh density; local mesh controls override the global size.
6. Run, singly or as a batch.
7. Review stress, displacement, strain and factor of safety.
8. Publish a report, usually as a late step.

**The verification step analysts urge designers to add** ([Javelin, 2018](https://www.javelin-tech.com/blog/2018/01/solidworks-simulation-stress-singularity-diagnostic/); [PhysicsForums](https://www.physicsforums.com/threads/mesh-changing-resulted-in-stress-change.512305/post-3397026); Kurowski, [Machine Design](https://www.machinedesign.com/archive/article/21817360/more-errors-that-mar-fea-results)): refine the mesh until the peak stress stops changing; if it keeps rising, it is a singularity at a sharp re-entrant corner or support edge, so model the real radius or read stress away from it.

**The SolidCraft requester's workflow today** ([#6971](https://github.com/tangency-labs/solidcraft/issues/6971)): design in SolidCraft, export STEP, check in another program, edit in SolidCraft, re-export, repeat on every change. The request is that the check stays in the CAD model and re-runs with it.

**Fatigue workflow** (post-processing of FE stress; [Altair OptiStruct help, S-N method](https://help.altair.com/hwsolvers/os/topics/solvers/os/fatigue_fpm_sn_stress_life_method_r.htm), vendor documentation; [Technia on fe-safe](https://blog.technia.com/en/simulation/fatigue-analysis-with-fe-safe); [HBK nCode webinar](https://hbkworld.com/en/knowledge/resource-center/recorded-webinars/performing-fe-based-fatigue-analysis-with-ncode); a community Abaqus fatigue guide, not official, [openskillindex](https://openskillindex.com/skills/majiayu000-claude-skill-registry-abaqus-fatigue-analysis)):

1. Obtain a converged static or dynamic FE solution.
2. Gather S-N (or strain-life) material data and stress output at critical locations.
3. Choose stress-life for high-cycle and strain-life for low-cycle fatigue.
4. Reduce the multiaxial stress at each point and time step to an equivalent uniaxial value (OptiStruct default: absolute maximum principal; signed von Mises is often used for ductile materials).
5. Count cycles by rainflow and accumulate damage by Miner's rule.
6. Output contours of life or damage and the critical locations.

**Analyst workflow with a standalone solver, and modal workflow**: not sourced in the notes. The brief's outline was pre-processor, solver input deck (Nastran .bdf, Abaqus .inp, Ansys .cdb, CalculiX .inp), results file (.op2, .odb, .rst, .frd), post-processor, with neutral formats VTK/VTU, Exodus II, UNV and MED; this list is unverified and should be confirmed from each program's user documentation. The modal workflow (free against supported modes, mass participation, comparing the first natural frequency in Hz with the excitation frequency) is described in theory under Fundamentals, Dynamics, but no workflow source was found.

### Inputs users prepare

| Input | Needed for | Notes and sources |
|---|---|---|
| Analysis-suitable geometry | All | Watertight solid; defeatured where needed; face identity kept for loads and supports ([#2381](https://github.com/tangency-labs/solidcraft/discussions/2381), [#834](https://github.com/tangency-labs/solidcraft/pull/834)). |
| Material: E, ν | Linear static | Plus density for gravity and modes; yield and ultimate tensile strength for a factor of safety; typical or minimum must be known (Fundamentals, Materials). |
| Material: orthotropic constants | Composites | 9 constants and per-element axes. |
| Material: stress-strain curve, hyperelastic constants, Prony series | Nonlinear | True stress against true plastic strain; several deformation modes for rubber. |
| Material: S-N or strain-life data, surface finish, size, reliability | Fatigue | Marin factors and mean-stress rule. |
| Supports | All | Fixed faces, pinned holes, symmetry; enough to remove 6 rigid-body modes without over-restraining. |
| Loads | All | Face force, pressure, gravity, remote force (with kinematic or distributing coupling), bolt preload, thermal loads. #6971 lists fixed faces, pinned holes, face force, pressure, gravity and remote force. |
| Mesh controls | All | Global size, local refinement at features of interest. |
| Damping, load spectra or histories | Dynamics, fatigue | Damping is an input, not a result. |
| Imperfection shape and amplitude, or knock-down factor | Buckling | From manufacturing tolerances or guidelines such as SP-8007. |
| Contact type and friction coefficient | Assemblies | Nonlinear. |

### Outputs and reports users hand on

- Designers typically hand on a report with stress and displacement plots and a factor of safety (inference from the workflow sources).
- Analysts are expected (Kurowski, Johnson) to add convergence evidence and numeric results, which embedded tools do not force (inference).
- Fatigue tools output life, damage and factor-of-safety contours and critical locations (fe-safe User Guide; OptiStruct help).
- NASA-STD-7009B lists what a decision-grade report contains: best estimate, uncertainty statement or explicit "none available", credibility levels, caveats and warnings, risks, and analyst qualifications (see Accuracy).
- Modal test correlation outputs MAC and percent frequency error per mode pair (Simcenter 3D).

### File formats involved

| Format | Role | Source |
|---|---|---|
| STEP (ADVANCED_FACE names) | CAD exchange; FEA tools pick up named faces | [#2381](https://github.com/tangency-labs/solidcraft/discussions/2381) |
| 3MF with B-rep face tags | Face-tagged triangle surface for a mesher | [#834](https://github.com/tangency-labs/solidcraft/pull/834) |
| STL, .off, .obj, .ply | Triangle surface input to permissive tet meshers (fTetWild, Quartet) | [fTetWild](https://github.com/wildmeshing/fTetWild) |
| .msh | fTetWild output | [fTetWild](https://github.com/wildmeshing/fTetWild) |
| Solver decks and results (.bdf, .inp, .cdb, .op2, .odb, .rst, .frd) and neutral formats (VTK/VTU, Exodus II, UNV, MED) | Analyst workflow | Unverified list from the research brief |
| FE result files read by fatigue tools | Ansys, Nastran, Abaqus, OptiStruct, LS-DYNA results into nCode | [HBK](https://www.hbkworld.com/en/products/software/durability/designlife-cae-fatigue-analysis) |

### Where time is lost

- Geometry preparation and meshing (Fundamentals, Volume meshing): 25-38 % in recent vendor figures, 70-80 % in older Sandia-related figures; neither is a robust measurement.
- Repeating the export-check-edit cycle on every design change ([#6971](https://github.com/tangency-labs/solidcraft/issues/6971)); no survey quantifies how common this is beyond the 84 % multi-CAD figure.
- Export defects that make a mesher refuse the geometry ([#2356](https://github.com/tangency-labs/solidcraft/issues/2356)).
- Waiting for cloud solves that used to take seconds locally (Fusion petition), and solves that fail after charging credits.
- Contact in assemblies driving up solve time (Onshape forum 85552).
- Re-running meshes to check convergence, which experienced analysts say is often skipped (theme B).

## Glossary

Each entry follows ISO 704 / ISO 10241-1 style: one plain sentence that could replace the term, then a note with context, related terms, an example and the other names programs use. Definitions contain no product names. Entries are alphabetical. SolidCraft's own glossary ([#1569](https://github.com/tangency-labs/solidcraft/issues/1569)) was not checked against these terms (see Open questions).

**A-basis value**: a strength value that at least 99 % of a material population exceeds, stated with 95 % confidence.
Note: a statistical lower bound used for design allowables, not a typical value. B-basis is the same idea at 90 %. Defined in MMPDS. Other names: A-allowable, B-allowable.

**adaptive refinement**: repeated automatic improvement of a mesh where an error estimate is largest, until a stopping criterion is met.
Note: either h-adaptive (smaller elements) or p-adaptive (higher polynomial order). Near a singularity it never stops without a minimum element size. Other names: adaptive mesh refinement, h-adaptivity, p-adaptivity, multi-pass adaptive, Adapt.

**advancing-front method**: a meshing method that creates elements layer by layer inward from the boundary surface.
Note: one of the two common cores of tetrahedral meshers, beside constrained Delaunay methods.

**algebraic multigrid (AMG)**: a multigrid method that builds its coarser levels from the matrix entries alone, without a geometric hierarchy.
Note: variants are smoothed aggregation and classical Ruge-Stüben. For elasticity, smoothed aggregation uses the rigid-body modes as its near-null space. Keeps iteration counts nearly constant as the mesh is refined. See also geometric multigrid, preconditioner.

**AMIPS energy**: a number that measures how far an element's shape departs from a regular element, equal to 3 for an ideal tetrahedron.
Note: used as the mesh-quality target in envelope-based tetrahedral meshing; fTetWild stops optimising below 10.

**analysis tier**: a group of analysis types that a program offers together at one level of capability or price.
Note: for example, linear static analysis in a base product and modal, buckling and nonlinear analysis at higher levels. The SolidCraft request #6971 describes a first tier of single-body linear static analysis.

**arc-length method**: a solution method for nonlinear equations that controls a combined size of the displacement and load increments, so that it can pass load maxima.
Note: needed for snap-through and post-buckling paths where controlling the load alone fails. Other names: Riks method, Crisfield method.

**averaged stress**: a stress value at a node formed by averaging the values that the elements sharing that node extrapolate to it.
Note: gives smooth contour plots but can hide peaks and real jumps at material interfaces. The opposite, unaveraged stress, shows each element's own value; a large difference between the two signals a mesh that is too coarse. Other names: nodal stress, smoothed stress; element stress for unaveraged.

**B-rep (boundary representation)**: a description of a solid by its bounding faces, edges and vertices together with their surfaces and curves.
Note: the form in which CAD programs store solids and STEP files exchange them. Other names: BREP, CAD body, STEP solid.

**BDDC and FETI-DP**: preconditioners that split the model into non-overlapping subdomains, solve each subdomain directly and couple them through a small problem on the subdomain interfaces.
Note: forms of domain decomposition with a condition number that grows only logarithmically with subdomain size. Need local direct solves, which map poorly to compute shaders.

**beam element**: an element that represents a slender member by its axis and cross-section properties instead of its full volume.
Note: valid when the cross-section is much smaller than the length; Euler-Bernoulli theory ignores shear deformation, Timoshenko theory includes it.

**blind round robin**: an exercise in which several independent teams predict the same experiment without seeing its results.
Note: the Sandia Fracture Challenges are examples; they measure the scatter between analysts, not just between codes.

**body-fitted mesh**: a mesh whose element faces lie on the boundary of the body.
Note: the classical FEA mesh, made for example by tetrahedral meshers. Opposite of the background grid used by embedded-domain methods and voxel FEM.

**bolt preload**: the axial force put into a bolt when it is tightened, before service loads act.
Note: modelled as an initial strain or force in the bolt shank, applied in a first step and then held; needs contact between clamped parts. Other names: pretension.

**boundary recovery**: the meshing step that restores input edges and faces that are missing from an unconstrained Delaunay mesh.
Note: may need Steiner points; a known source of failures in constrained Delaunay meshers.

**buckling load factor**: the number by which a reference load must be multiplied to reach the load at which the structure loses stability.
Note: the lowest eigenvalue of a linear buckling analysis. Above 1 means the reference load is below the buckling load in theory; imperfections can lower the real value greatly. Other names: load multiplier, eigenvalue, critical load factor.

**Chebyshev smoother**: a fixed polynomial in the stiffness matrix that damps high-frequency error using only matrix-vector products and the diagonal.
Note: needs no dot products, so no global reductions; a common smoother in matrix-free multigrid on GPUs.

**closed-form solution**: an exact or classical-theory formula for a result that can be evaluated without a numerical model.
Note: for example the cantilever tip deflection FL³/(3EI) or the Lamé hoop stress. Used as a reference value in verification. Other names: analytic solution, analytical solution, hand calculation.

**code verification**: verification of the software itself, by comparing its results with exact or manufactured solutions and checking the observed rate at which error falls.
Note: done once per software release. See also solution verification. Other names: implementation verification (NASA-STD-7009B).

**condition number**: the ratio of the largest to the smallest eigenvalue of a symmetric positive definite matrix.
Note: sets how many digits are lost in a solve (about log10 of it) and how many iterations conjugate gradients needs (about its square root). Grows with mesh refinement, element aspect ratio and stiffness contrast. Symbol κ.

**confidence score**: a number a surrogate model reports with each prediction to indicate how close the input is to its training data.
Note: in the product examined it is a normalised distance, and its vendor states it is not correlated with error. See out-of-distribution input.

**conjugate gradient method (CG)**: an iterative method for symmetric positive definite linear systems that reduces the energy norm of the error over a growing set of search directions.
Note: needs only matrix-vector products, vector updates and dot products, so it suits GPUs. See preconditioned conjugate gradient.

**constrained Delaunay tetrahedralization (CDT)**: a tetrahedral mesh that contains all given input faces and is as close to a Delaunay mesh as those faces allow.
Note: keeps the input boundary exactly, which matters for face loads and supports. May need Steiner points.

**contact**: an interface condition that stops two surfaces from passing through each other while letting them separate and, with friction, slide.
Note: nonlinear, because the contact area depends on the result. Enforced by the penalty method, Lagrange multipliers or augmented Lagrange. Other names: no penetration, frictional or frictionless contact, bonded contact (a linear special case).

**copyleft licence**: a software licence that requires derived works to be distributed under the same licence terms.
Note: GPL and AGPL are strong copyleft; LGPL is weak copyleft with its own conditions on reuse. SolidCraft's research rules forbid reading copyleft source code. Opposite of permissive licence.

**credibility**: the degree to which a decision maker can justifiably trust a simulation result.
Note: NASA-STD-7009B scores it with capability factors (for the software) and results factors (for each analysis), each from 0 to 4. See input pedigree, results robustness.

**creep**: slow continuing deformation of a material under constant stress, usually at high temperature.
Note: secondary creep is often modelled by Norton's power law. Makes stress redistribute from peaks over time.

**critical time step**: the largest time step for which explicit time integration stays stable.
Note: about the smallest element length divided by the wave speed; about 0.19 µs for a 1 mm steel element. Other names: stable time increment, Courant limit.

**cross-orthogonality**: a mass-weighted product of test and analysis mode shapes, used to check that they match.
Note: goals of above 0.9 on the diagonal and below 0.1 off it are used in NASA test correlation. Related to MAC, which ignores mass.

**curvilinear mesh**: a mesh whose element edges and faces are curved to follow the geometry.
Note: quadratic tetrahedra with mid-edge nodes moved onto CAD surfaces are an example; curving can make elements invalid, which is checked with the Jacobian determinant. Other names: high-order mesh, curved mesh.

**CutFEM**: an unfitted finite element method in which the body boundary cuts through background elements, stabilised so that results do not depend on how cells are cut.
Note: one of the embedded-domain methods; uses ghost penalty and Nitsche's method.

**damping ratio**: the ratio of a system's actual damping to the damping that would just stop it from oscillating.
Note: an input to dynamic analyses, not a result; about 2 % for welded steel (unverified typical value). Peak resonant amplification of a single degree of freedom is 1/(2 x damping ratio). Symbol ζ. Other names: critical damping ratio, modal damping.

**defeaturing**: removing small geometric details that do not matter for an analysis before meshing.
Note: for example small holes, fillets or logos. Research on estimating the error it causes exists for traction-free features. Other names: geometry clean-up, simplification.

**degree of freedom (DOF)**: one independent unknown of a model, such as one displacement component at one node.
Note: a solid node has 3 DOF; model size is usually quoted in DOF, for example 1.52 million free DOF.

**digital image correlation (DIC)**: an optical measurement of surface displacement and strain fields from images of a speckle pattern.
Note: one way to compare FEA with tests; no typical agreement figures were found.

**dihedral angle**: the angle between two faces of a tetrahedron along their shared edge.
Note: very small or very large dihedral angles indicate poor element quality; a minimum above 1° is one quality target.

**direct solver**: a solver that factorises the stiffness matrix exactly, for example as a product of triangular matrices, and then solves by substitution.
Note: robust, and extra load cases are cheap, but memory grows faster than model size in 3D because of fill-in. Other names: sparse direct solver, Cholesky or LDLᵀ factorisation.

**discretisation error**: the difference between the exact solution of the mathematical model and the finite element solution caused by finite element size and order.
Note: reduced by h- or p-refinement and estimated by Richardson extrapolation, the grid convergence index or recovery-based estimators. Does not include modelling errors such as wrong supports.

**distributing coupling**: a link that spreads a load at a reference point over a set of nodes by force and moment balance, without adding stiffness.
Note: lets the loaded face deform freely. Other names: RBE3, interpolation element, deformable remote load.

**effective mass**: the part of a structure's total mass that moves with one mode under excitation in one direction.
Note: summed over all modes it equals the total mass; modes are often included until the sum reaches 90 % per direction. Other names: modal effective mass, mass participation.

**effective notch stress**: the peak elastic stress at a weld toe or root modelled with a fictitious rounding radius.
Note: IIW uses a 1 mm radius for plates of at least about 5 mm and the FAT 225 class for steel. See hot-spot stress.

**element**: a small region of a model over which the displacement field is described by shape functions and nodal values.
Note: elements are joined at nodes to form the mesh. Types include solid, shell and beam elements, of linear or quadratic order. Other names: finite element, cell.

**element order**: the polynomial degree of an element's shape functions.
Note: linear (first-order) elements such as tet4 and hex8 have straight edges; quadratic (second-order) elements such as tet10 and hex20 can bend and are far less prone to locking. Other names: draft and high-quality elements; first- and second-order elements.

**embedded-domain method**: a discretisation that places the body in a simple background grid that does not follow its boundary and accounts for the boundary inside the cut cells.
Note: includes the finite cell method, CutFEM and the shifted boundary method. Other names: immersed boundary method, unfitted method, fictitious domain method.

**envelope**: the region within a set distance of an input surface inside which a mesher may place the mesh boundary.
Note: lets envelope-based meshers handle defective input robustly, at the cost of exact boundary conformity. Other names: ε-envelope.

**explicit time integration**: stepping a dynamic model forward in time from known quantities only, without solving a system of equations at each step.
Note: cheap per step but stable only below the critical time step; suits short events such as impact. Opposite of implicit time integration. Other names: central difference method.

**external approximations**: a Galerkin method whose approximating functions need not be continuous across subdomain boundaries, with continuity enforced weakly.
Note: the basis of one commercial meshless product. See meshless method.

**factor of safety**: the allowable value of a quantity divided by the value the analysis predicts for it.
Note: above 1 means margin; must state which strength (minimum or typical) and which stress (peak, linearised, hot-spot) it uses, and which failure mode (yield, buckling, fatigue). Other names: safety factor, FOS, reserve factor. Compare margin of safety.

**FAT class**: the stress range in MPa that a welded detail survives for 2 million cycles in its design S-N curve.
Note: used by IIW; for example FAT 90 at a 60 MPa range gives 6.75 million cycles at slope 3. Other names: detail category (EN 1993-1-9), detail class (BS 7608).

**fictitious domain**: an enlarged simple region containing the real body, on which a discretisation is defined.
Note: the starting point of the finite cell method and other embedded-domain methods.

**fill-in**: new non-zero entries that appear when a sparse matrix is factorised.
Note: reduced by reordering unknowns (nested dissection, minimum degree); the reason direct-solver memory grows faster than model size.

**finite cell method (FCM)**: an embedded-domain method that uses high-order shape functions on a simple grid of cells and integrates only over the part of each cell inside the body.
Note: proven to converge exponentially under p-refinement for smooth elasticity problems. Issues: small cut cells, costly integration, weakly imposed supports.

**float32**: the 32-bit IEEE binary floating-point format, with about 7 significant decimal digits.
Note: the only general floating-point type in WGSL. Rounding unit about 6e-8. Other names: single precision, f32.

**float64**: the 64-bit IEEE binary floating-point format, with about 16 significant decimal digits.
Note: the usual precision for FE solvers; not available in WGSL. Other names: double precision, f64.

**gather formulation**: a way to compute a matrix-vector product in which each node collects contributions from its neighbouring elements, instead of each element adding into shared nodes.
Note: avoids floating-point atomic operations, which WGSL lacks. Opposite of scatter-add.

**Gauss point**: a sampling point inside an element at which integrands are evaluated for numerical integration.
Note: stresses are most accurate there and are extrapolated to nodes for plotting. Other names: integration point, quadrature point.

**geometric multigrid**: a multigrid method that uses a hierarchy of successively coarser meshes of the same geometry.
Note: simple on structured grids such as voxels. See algebraic multigrid.

**geometric nonlinearity**: change in a structure's stiffness caused by large displacements or rotations.
Note: a linear analysis ignores it; a rigid rotation of 0.1 rad already gives about 1 050 MPa of false stress in steel under the small-strain assumption. Other names: large deformation, NLGEOM.

**geometric stiffness**: the change in stiffness caused by the stress already present in a structure.
Note: tension stiffens and compression softens; the basis of linear buckling analysis. Other names: stress stiffness, initial-stress stiffness.

**ghost penalty**: an added stabilising term near cut elements that keeps the system matrix well conditioned whatever the cut.
Note: a standard ingredient of CutFEM.

**grid convergence index (GCI)**: a band of discretisation uncertainty computed from the change between results on systematically refined meshes, multiplied by a safety factor.
Note: safety factor 1.25 with three or more meshes, 3.0 with two. Example: 100 MPa ± 3.75 %. Other names: mesh convergence index.

**h-refinement**: reducing element size while keeping polynomial order fixed, to reduce discretisation error.
Note: for smooth problems the energy error falls as h to the power p. Other names: mesh refinement.

**harmonic analysis**: computation of the steady response of a structure to loads that vary sinusoidally at given frequencies.
Note: depends strongly on the damping input. Other names: frequency response analysis.

**hex8**: an 8-node hexahedral element with trilinear shape functions.
Note: locks in bending when fully integrated and is sensitive to distortion. Other names: linear brick, C3D8, CHEXA, SOLID185.

**hex8i**: a hex8 element enriched with internal incompatible bending modes that are condensed out, leaving 24 DOF.
Note: name used in the author's spike for an incompatible-mode element on voxels. Other names: C3D8I, incompatible-mode brick, enhanced-strain brick.

**hex20**: a 20-node hexahedral element with quadratic serendipity shape functions.
Note: barely affected by distortion in the MacNeal-Harder cantilever tests. hex27 is the full quadratic version with face and centre nodes. Other names: quadratic brick, C3D20, CHEXA (20 nodes).

**hot-spot stress**: the surface stress at a weld toe obtained by extrapolating from reference points outside the notch zone.
Note: avoids the mesh-dependent stress right at the toe. Other names: structural stress, geometric stress.

**hourglass mode**: a deformation pattern of an element that produces no strain at its integration points and therefore meets no stiffness.
Note: appears with reduced integration as zig-zag patterns; controlled by artificial stiffness or full integration. Other names: zero-energy mode, spurious mode.

**hyperelastic material**: a material whose stress follows from a stored-energy function of the deformation, used for large elastic strains.
Note: rubber models such as neo-Hookean, Mooney-Rivlin and Ogden; nearly incompressible, so mixed elements are needed.

**imperfection**: a small deviation of a real structure's shape or loading from its ideal form.
Note: lowers buckling loads, sometimes dramatically for thin shells; seeded into nonlinear buckling models as scaled mode shapes or measured shapes.

**implicit time integration**: stepping a dynamic model forward in time by solving a system of equations at each step that involves the unknown future state.
Note: Newmark average acceleration is unconditionally stable for linear problems; suits static, modal and long dynamic analyses. Opposite of explicit time integration.

**incompatible-mode element**: an element with extra internal displacement modes that may be discontinuous between elements, added so that it can bend without locking.
Note: Wilson's 1973 version fails the patch test on distorted shapes; Taylor's 1976 fix passes it. Other names: enhanced assumed strain element, C3D8I. See hex8i.

**input pedigree**: the documented origin and quality of the data fed into a model.
Note: one of the results-credibility factors in NASA-STD-7009B; for example whether a yield value is a typical or a minimum value.

**isogeometric analysis (IGA)**: analysis that uses the spline basis functions of the CAD geometry as finite element shape functions.
Note: CAD gives trimmed surface splines, but solid analysis needs volumetric splines, so trimmed geometry needs embedded-domain treatment.

**isoparametric element**: an element whose geometry and displacement are both interpolated with the same shape functions from a reference shape.
Note: the standard form of solid elements; validity requires a positive Jacobian determinant everywhere.

**isosurface stuffing**: a meshing method that fills a signed distance field on a grid with a fixed pattern of well-shaped tetrahedra.
Note: robust on watertight input but approximates the boundary to the grid spacing.

**iterative refinement**: repeatedly computing the residual in a higher precision and solving for a correction in a lower precision.
Note: lets a fast low-precision solver reach high-precision accuracy; needs a high-precision residual, which WGSL cannot compute natively. Other names: defect correction, mixed-precision refinement.

**iterative solver**: a solver that improves an approximate solution step by step until the residual is small enough.
Note: memory grows about linearly with model size; speed depends on the condition number and the preconditioner. Examples: CG, PCG.

**Jacobi preconditioner**: a preconditioner formed from the reciprocals of the matrix diagonal.
Note: fully parallel and cheap, but iteration counts still grow as 1/h; measured as about 2x per halving of h in the author's spike. Other names: diagonal scaling.

**Jacobian determinant**: the local volume scale factor of the map from an element's reference shape to its real shape.
Note: must be positive everywhere; zero or negative means a folded or inverted element. Symbol det J.

**kinematic coupling**: a link that forces a set of nodes to move rigidly with one reference node.
Note: adds infinite stiffness to the attached face and overestimates stress at its edge. Other names: RBE2, rigid remote load, rigid spider.

**knock-down factor**: an empirical multiplier below 1 applied to a theoretical buckling load to account for imperfections.
Note: NASA SP-8007 gives values for thin cylinders, for example 0.75 for some stiffened cylinders; about 0.47 for an unstiffened cylinder with R/t = 200 using the unverified 1968 formula. Other names: KDF, knockdown factor.

**linear buckling analysis**: computation of the load multiplier at which a structure's stiffness plus its geometric stiffness becomes singular, assuming linear behaviour before buckling.
Note: unconservative for imperfection-sensitive shells and for stocky members that yield first. Other names: eigenvalue buckling, bifurcation buckling, structural buckling.

**linear static analysis**: computation of the displacements, strains and stresses of a structure under loads that do not change with time, assuming small deformation and linear elastic material.
Note: solves K u = f once; the scope of SolidCraft request #6971. Other names: static stress, linear static stress, static study.

**live-in-CAD simulation**: simulation that updates its results within seconds while the user edits geometry in the CAD program.
Note: achieved by avoiding a body-fitted mesh, running on the GPU or both; vendors position the results as trend-level. Other names: real-time simulation, explore mode, simulation live.

**load**: a prescribed force, pressure, acceleration or temperature applied to a model.
Note: surface loads are natural boundary conditions in the weak form. Types in #6971: face force, pressure, gravity, remote force. Other names: natural boundary condition, Neumann condition.

**MAC (modal assurance criterion)**: a number from 0 to 1 that measures how closely two mode shapes match.
Note: above 0.9 is commonly read as well correlated; a pairing threshold of 0.7 is one program default. Compare cross-orthogonality.

**margin of safety**: the factor of safety minus 1.
Note: positive means acceptable. Mixing it up with the factor of safety is a known source of confusion between industries.

**Marin factors**: multipliers that adjust a polished-specimen endurance limit for surface finish, size, load type, temperature, reliability and other effects.
Note: in one worked example they reduce the endurance limit to about 60 % of the specimen value.

**matrix-free operator application**: computing the product of the stiffness matrix with a vector from element data on the fly, without storing the assembled matrix.
Note: suits GPUs because it trades memory traffic for arithmetic; used in the author's spike. Other names: partial assembly, cell-based evaluation, element-by-element (EbE).

**mean-stress correction**: an adjustment of fatigue strength for a non-zero mean stress in the load cycle.
Note: Goodman, Gerber, Soderberg, Morrow and Smith-Watson-Topper rules; the choice alone moved a factor of safety by about 25 % in one worked example.

**Memory64**: a WebAssembly feature that allows memory addresses beyond the 4 GiB limit of 32-bit addresses.
Note: shipped in Chrome 133 and Firefox 134, not in Safari; can be 10 % to over 100 % slower than 32-bit.

**mesh**: the set of elements and nodes into which a model's geometry is divided.
Note: tetrahedral meshes are the usual automatic choice for CAD solids. See body-fitted mesh, voxel FEM.

**mesh convergence study**: repeating an analysis with progressively finer meshes until the result of interest no longer changes by a meaningful amount.
Note: typically two or three meshes with a constant refinement ratio; a peak that keeps rising signals a singularity. Other names: mesh sensitivity study, h-refinement study.

**mesh-avoiding method**: a discretisation that does not need a body-fitted volume mesh of the part.
Note: includes voxel FEM, embedded-domain methods, isogeometric analysis, meshless methods and walk on spheres. Other names: mesh-free, mesh-light.

**meshless method**: a discretisation that builds its approximation functions from scattered points or subdomains without a conforming element mesh.
Note: element-free Galerkin and reproducing-kernel methods still need a background integration grid. Other names: mesh-free method.

**method of manufactured solutions (MMS)**: choosing an arbitrary smooth solution, deriving the loads that produce it, and checking that a code recovers it at the expected rate of convergence.
Note: verifies a code without needing any published reference number.

**Miles' equation**: a formula for the root-mean-square acceleration response of a lightly damped single-degree-of-freedom system under flat random base excitation.
Note: valid only for that idealisation and reported to overestimate some random load factors.

**Miner's rule**: the assumption that fatigue damage fractions (cycles applied divided by cycles to failure) add up linearly to failure at a sum of 1.
Note: test sums at failure range from about 0.1 to 10. Other names: Palmgren-Miner rule, linear damage accumulation.

**modal analysis**: computation of the natural frequencies and mode shapes of an undamped structure from an eigenvalue problem.
Note: needs only the stiffness and mass matrices; an unsupported part gives six near-zero frequencies. Other names: frequency analysis, normal modes, natural frequency analysis.

**mode shape**: the pattern of relative displacement in which a structure vibrates at one natural frequency.
Note: compared between test and analysis by MAC. Other names: eigenvector, eigenmode.

**multiaxial fatigue**: fatigue under stress states with more than one non-zero stress component that may vary independently.
Note: proportional loading can use an equivalent stress; non-proportional loading needs critical-plane methods such as Findley.

**multigrid**: a solution method that removes error on a hierarchy of coarser and finer levels, giving iteration counts nearly independent of mesh size.
Note: used as a preconditioner for CG; see algebraic multigrid and geometric multigrid.

**natural frequency**: a frequency at which a structure vibrates freely once disturbed.
Note: in Hz; computed by modal analysis. Other names: eigenfrequency, resonant frequency.

**Newton-Raphson method**: an iterative method for nonlinear equations that solves a linearised problem with the tangent stiffness at each iteration.
Note: converges quadratically near the solution when the tangent is consistent. Modified Newton and quasi-Newton (BFGS) variants are cheaper per iteration.

**Nitsche's method**: a way to impose prescribed displacements weakly through added boundary terms in the weak form, instead of fixing nodal values.
Note: used by embedded-domain methods, where the boundary does not pass through nodes.

**nonlinear analysis**: analysis in which stiffness depends on the solution, because of large displacements, nonlinear material or contact.
Note: solved incrementally and iteratively; see geometric nonlinearity, plasticity, contact.

**notch sensitivity**: the degree to which a material's fatigue strength is reduced by the full theoretical stress concentration.
Note: the fatigue factor is 1 + q (Kt - 1), with q between 0 and 1; close to 1 for small radii in high-strength steel. Symbol q.

**observed order of accuracy**: the exponent relating the reduction in error to the reduction in element size, measured from a series of meshes.
Note: a negative or erratic value means the results are not in the asymptotic range, or that a singularity is present. Symbol p.

**orthotropic material**: a material with three mutually perpendicular planes of symmetry in its properties.
Note: has 9 independent elastic constants; material axes must be set per element. Transversely isotropic materials have 5.

**out-of-distribution input**: an input outside the range of a surrogate model's training samples, for which its accuracy is not supported by data.
Note: detected by distance-based confidence scores; handled by retraining, not by an error bound. Other names: low-confidence prediction.

**p-refinement**: raising the polynomial order of element shape functions on a fixed mesh, to reduce discretisation error.
Note: converges exponentially for smooth problems. Other names: p-version, multi-pass adaptive.

**patch test**: a check that any small assembly of possibly distorted elements reproduces a constant strain state exactly.
Note: with a stability check it is a condition for convergence (Taylor et al. 1986).

**penalty method**: enforcing a constraint, such as non-penetration in contact, with a stiff spring proportional to its violation.
Note: allows small penetration; too stiff a spring harms the condition number.

**permissive licence**: a software licence that allows reuse in other software under different licence terms, subject to keeping notices.
Note: for example MIT, Apache-2.0, BSD and ISC. Opposite of copyleft licence.

**piecewise-linear complex (PLC)**: a set of vertices, segments and flat polygons that meet only at shared parts and bound the region to be meshed.
Note: the valid input of constrained Delaunay meshers; only 4,408 of the 10,000 Thingi10k models are valid PLCs.

**plasticity**: permanent deformation of a material once stress exceeds its yield strength.
Note: modelled with a yield criterion (usually von Mises), a flow rule and hardening; input is true stress against true plastic strain.

**Poisson's ratio**: the negative ratio of lateral strain to axial strain in a uniaxially loaded elastic material.
Note: about 0.3 for metals; close to 0.5 for rubber, where it causes volumetric locking. Symbol ν.

**power spectral density (PSD)**: the mean-square value of a random signal per unit of frequency.
Note: random vibration inputs are given as acceleration PSD in g²/Hz.

**preconditioned conjugate gradient method (PCG)**: the conjugate gradient method applied together with a preconditioner to reduce the number of iterations.
Note: Jacobi-PCG and AMG-PCG are common; see preconditioner.

**preconditioner**: an approximate inverse of a matrix that is applied in each iteration of an iterative solver to speed its convergence.
Note: examples: Jacobi, incomplete Cholesky, algebraic multigrid.

**principal stress**: one of the three normal stresses on the planes where the shear stress is zero.
Note: the eigenvalues of the stress tensor, ordered σ1 ≥ σ2 ≥ σ3; maximum principal stress governs brittle fracture.

**radius-edge ratio**: the circumradius of a tetrahedron divided by its shortest edge length.
Note: a mesh-quality measure; slivers can have a good radius-edge ratio yet near-zero volume.

**rainflow counting**: a procedure that breaks a variable-amplitude load history into closed stress cycles with their ranges and means.
Note: standardised in ASTM E1049-85; its output feeds Miner's rule.

**random vibration analysis**: computation of the statistical response of a structure to a random excitation described by its power spectral density.
Note: results are 1σ root-mean-square values; 3σ is commonly used for strength.

**Rayleigh damping**: a damping matrix formed as a combination of the mass and stiffness matrices.
Note: matches a target damping ratio only at two chosen frequencies and is lower between them.

**re-entrant corner**: a sharp inward-pointing corner of a body, with an interior angle above 180°.
Note: the exact elastic stress there is infinite, so it is a singularity; real parts have a fillet radius there.

**reaction force**: the force that a support exerts on a model to hold it in place.
Note: the sum of reactions must balance the applied loads, a basic sanity check.

**reduced integration**: numerical integration with fewer Gauss points than needed to integrate an undistorted element's stiffness exactly.
Note: avoids locking but can allow hourglass modes.

**reference value**: a trusted value that a computed result is compared against.
Note: comes from a closed-form solution, a benchmark's own published target or an independent open-source run; never from a commercial program's output. Other names: target, referent (NASA-STD-7009B, which also counts test data), benchmark value.

**remote load**: a force or moment applied at a point away from the model and transferred to a face through kinematic or distributing coupling.
Note: one of the load types in SolidCraft request #6971. Other names: remote force, remote displacement.

**residual**: the out-of-balance force left when a trial solution is put into the equilibrium equations.
Note: iterative and nonlinear solvers stop when it is small enough; in float32 the computed residual can drift from the true one.

**response spectrum analysis**: estimation of peak dynamic response by combining the peak responses of individual modes read from a design spectrum.
Note: SRSS or CQC combination; signs are lost, so the result is an envelope.

**results robustness**: how sensitive a result is to changes in uncertain inputs and modelling choices.
Note: a results-credibility factor in NASA-STD-7009B.

**Richardson extrapolation**: estimating the result at zero element size from results on systematically refined meshes.
Note: also gives the observed order of accuracy; the basis of the grid convergence index.

**rigid-body mode**: a motion of the whole body that produces no strain.
Note: a free 3D body has six; supports must remove them or the stiffness matrix is singular. They appear as near-zero frequencies in modal analysis of an unsupported part.

**round trip**: exporting geometry to a separate analysis program and bringing changes back into the CAD model for each design iteration.
Note: the main workflow complaint in SolidCraft request #6971.

**S-N curve**: the relation between stress amplitude (or range) and the number of cycles to fatigue failure.
Note: Basquin's law in high-cycle fatigue; weld design curves are given per FAT class. Other names: Wöhler curve, stress-life curve.

**Saint-Venant's principle**: the principle that two statically equivalent load distributions produce stresses that differ only near the loaded region.
Note: in practice about one section depth away; stress there can be trusted even when the local peak cannot.

**shape function**: the function that gives the value of a field inside an element from its nodal values.
Note: each equals 1 at its own node and 0 at the others. Other names: basis function, interpolation function.

**shear locking**: spurious stiffness of low-order elements in bending, caused by shear strain that their straight edges create.
Note: measured at -12.6 % tip deflection for a plain voxel brick 2 cells through a 2 mm wall. Remedies: quadratic elements, incompatible modes, reduced integration. Other names: parasitic shear.

**shell element**: an element that represents a thin-walled region by its mid-surface and thickness.
Note: cannot report through-thickness stress; thin (Kirchhoff) and thick (Mindlin-Reissner) theories.

**shifted boundary method (SBM)**: an embedded-domain method that applies boundary conditions on a nearby boundary made of whole grid elements, corrected by a Taylor expansion to the true boundary.
Note: needs no cut-cell integration; a 2026 paper reports a sub-optimal rate with traction conditions on linear elements.

**singularity**: a point where linear elastic theory predicts infinite stress, so the computed peak grows without limit as the mesh is refined.
Note: caused by sharp re-entrant corners, crack tips, point loads and edges of fully fixed faces. Other names: stress singularity, stress hot spot.

**sliver**: a tetrahedron of nearly zero volume whose four vertices lie near a plane without any short edge.
Note: harms accuracy and conditioning; removed by sliver exudation or optimisation.

**small-strain assumption**: the assumption that strains and rotations are small enough to use the linear strain measure and the undeformed geometry.
Note: the basis of linear static analysis. Finite-strain analysis uses the Green-Lagrange strain instead. Other names: small-deformation theory, linear kinematics.

**solid element**: an element that represents a three-dimensional region of material.
Note: tetrahedra and hexahedra; needs several elements, or at least one quadratic layer, through thin walls. Other names: 3D element, continuum element, brick or tet.

**solution verification**: estimating the numerical error, mainly from element size and solver tolerances, of one particular analysis.
Note: done each time a model is used (NASA-STD-7009B). Other names: calculation verification.

**staircase error**: error caused by approximating a smooth boundary with the stepped boundary of grid cells.
Note: measured at 2-2.5 % on curved surfaces with 4-5 voxels through the wall in the author's spike.

**Steiner point**: a vertex added by a mesher that was not in the input.
Note: sometimes required to make a tetrahedral mesh exist at all.

**stiffness matrix**: the matrix that relates the nodal displacements of a model to the nodal forces needed to hold them.
Note: symmetric and sparse; positive definite once rigid-body motion is removed. Symbol K.

**storage buffer**: a region of GPU memory that a shader can read and write.
Note: limited by default to 128 MiB per binding in WebGPU.

**strain-life method**: a fatigue method that relates local strain amplitude to cycles to failure, including plastic strain.
Note: needed for low-cycle fatigue and notch plasticity; uses Neuber's rule to estimate local strain from elastic stress. Other names: ε-N method.

**stress concentration**: a local rise in stress at a geometric feature that converges to a finite value as the mesh is refined.
Note: distinguished from a singularity by convergence. Its size is the stress concentration factor.

**stress concentration factor**: the ratio of the peak elastic stress at a notch to the nominal stress.
Note: 3.0 for a small circular hole in a wide plate under tension. Symbol Kt.

**stress linearisation**: splitting a through-thickness stress distribution into a constant (membrane), a linear (bending) and a remaining (peak) part.
Note: used in pressure-vessel design by analysis; depends on where the line through the wall is placed. Other names: stress classification.

**strong form**: the differential equations of equilibrium, with boundary conditions, that must hold at every point of the body.
Note: needs second derivatives; the weak form relaxes this.

**subgroup**: a hardware-scheduled set of shader invocations within a workgroup that execute together.
Note: an optional WebGPU feature. Other names: warp, wavefront, SIMD group.

**sum factorisation**: evaluating tensor-product shape functions one coordinate direction at a time to reduce the work of a matrix-free product on hexahedral elements.
Note: large savings at high polynomial order, small for trilinear elements.

**superconvergent patch recovery (SPR)**: building a smoother stress field by local least-squares fits of element stresses at their most accurate sampling points.
Note: the improved form of the Zienkiewicz-Zhu estimator (1992). Other names: ZZ recovery.

**support**: a prescribed displacement, often zero, applied to part of a model's boundary.
Note: removes rigid-body modes; idealised supports add artificial stiffness and stress peaks at their edges. Mathematically an essential boundary condition. Other names: fixture, restraint, constraint, Dirichlet condition, SPC, fixed face, pin.

**surrogate model**: a data-trained function that approximates a solver's output for new inputs at low cost.
Note: needs a training set of solver results; gives no error bound. Other names: ML model, reduced-order model (in a broader sense), AI model.

**tangent stiffness**: the derivative of the internal forces with respect to the displacements at the current state.
Note: used by the Newton-Raphson method; includes material and geometric stiffness. Other names: Jacobian matrix.

**tet4**: a 4-node tetrahedral element with linear shape functions and constant strain.
Note: far too stiff in bending (10-70 % errors reported). Other names: linear tetrahedron, constant-strain tetrahedron, C3D4, CTETRA (4 nodes), draft element.

**tet10**: a 10-node tetrahedral element with quadratic shape functions and linearly varying strain.
Note: the usual automatic mesh element for CAD solids. Other names: quadratic tetrahedron, C3D10, CTETRA (10 nodes), SOLID187, TETRA10, high-quality element.

**Thingi10k**: a public dataset of 10,000 3D-printing surface models used to test mesh-processing robustness.
Note: only 4,408 of its models are valid piecewise-linear complexes; it contains no CAD B-reps.

**transient analysis**: computation of a structure's response over time to loads that vary in time.
Note: by modal superposition or direct time integration (implicit or explicit).

**translation-relative operator**: an element computation that subtracts one node's displacement from all of the element's nodal displacements before applying the element stiffness matrix.
Note: exact in theory because the element matrix ignores rigid translation, but it loses far fewer digits in float32. Term used in the author's spike, where it reduced float32 errors from up to -51 % to 0.3-0.6 %.

**Tresca stress**: the difference between the largest and smallest principal stresses, equal to twice the maximum shear stress.
Note: up to about 15 % more conservative than von Mises stress. Other names: stress intensity (ASME).

**validation**: comparing model predictions with measurements to judge how well the model represents the real system for its intended use.
Note: answers "are these the right equations?"; needs test data such as strain gauges, DIC or modal tests. Other names: correlation (modal testing).

**vendor verification result**: a result that a commercial program's vendor computed with its own program and published, for example in a verification manual.
Note: describes that program only and is never a reference value.

**verification**: checking that a computer model solves its chosen mathematical equations correctly.
Note: answers "are the equations solved right?"; split into code verification and solution verification.

**viscoelasticity**: material behaviour in which stress depends on the rate and history of strain as well as on its current value.
Note: modelled with Prony series and time-temperature shift factors; typical of polymers.

**volumetric locking**: spurious stiffness of low-order elements when the material is nearly incompressible.
Note: occurs as Poisson's ratio approaches 0.5 (rubber, plastic flow); remedies are mixed u/p, B-bar and selective integration.

**von Mises stress**: a single equivalent stress, based on distortion energy, that is compared with the uniaxial yield strength to predict yield of ductile materials.
Note: always positive and blind to hydrostatic pressure; pure shear of 100 MPa gives 173 MPa. Other names: equivalent stress, Seqv, Mises stress.

**voxel**: one cube of a regular three-dimensional grid.
Note: in voxel FEM each solid voxel becomes one hexahedral element.

**voxel FEM**: finite element analysis on a regular grid of identical cubes, keeping those that lie inside the body.
Note: no meshing failures and one shared element matrix, at the cost of staircase error at curved surfaces. Other names: structured-grid FEM, image-based FE, micro-FE (in bone research).

**walk on spheres (WoS)**: a Monte Carlo method that estimates the solution of a partial differential equation at one point by averaging boundary values reached by random walks that jump between the largest empty spheres.
Note: needs no mesh; established for scalar problems, with 3D linear elasticity not yet covered in the sources found.

**watchdog**: a mechanism that stops or resets GPU work that runs longer than a set time.
Note: WebGPU allows browsers to lose the device for this; the Windows version (TDR) is reported to default to 2 s (unverified). Other names: TDR (Timeout Detection and Recovery), device loss.

**watertight surface**: a triangle surface without gaps or holes, so that it separates inside from outside everywhere.
Note: required input for most permissive tetrahedral meshers.

**weak form**: an integral statement of equilibrium that must hold for every admissible virtual displacement field.
Note: needs only first derivatives, so C0 elements suffice; for linear elastic, conservative problems it is equivalent to minimising the total potential energy. Other names: principle of virtual work, variational form, Galerkin form.

**WebAssembly (wasm)**: a portable binary instruction format that web browsers can run.
Note: 32-bit wasm memory is limited to 4 GiB; threads need cross-origin isolation. SolidCraft uses it to run in the browser.

**WebGPU**: a web standard that gives web pages access to the GPU for graphics and general computation.
Note: W3C Candidate Recommendation Draft 2026-09-15; implemented in Rust by wgpu. Its shading language is WGSL.

**WGSL (WebGPU Shading Language)**: the language in which WebGPU shader programs are written.
Note: W3C Candidate Recommendation Draft 2026-10-26; no 64-bit float type and only integer atomic operations.

**workgroup**: a group of compute-shader invocations that share fast local memory and can synchronise with each other.
Note: WebGPU default limits are 256 invocations and 16 KiB of shared memory. Other names: thread block (CUDA), work-group (OpenCL).

**yield strength**: the stress at which a material starts to deform permanently.
Note: the basis of a factor of safety against yield; must be stated as typical or minimum. The ultimate tensile strength is the highest engineering stress before fracture. Other names: yield stress; tensile strength for ultimate.

**Young's modulus**: the ratio of stress to strain in the linear elastic range of a material under uniaxial load.
Note: about 210 000 MPa for steel and 70 000 MPa for aluminium. Symbol E. Other names: elastic modulus, modulus of elasticity.

**Zienkiewicz-Zhu error estimator**: an estimate of discretisation error formed by comparing raw element stresses with a smoothed stress field.
Note: 1987 original; improved by superconvergent patch recovery in 1992. Programs show it as an error estimate or structural error. Other names: ZZ estimator, recovery-based error estimator, energy-norm error.

## Open questions

What could not be confirmed, and where to look next.

### Paywalled or unread primary sources

1. **NAFEMS benchmark booklets**: *The Standard NAFEMS Benchmarks* (P18, TNSB Rev. 3, 1990), R0016 (forced vibration, 1989), R0081 (contact, 2001) and R0080 (nonlinear, 2001). Needed to confirm LE1 and LE10 geometry (ellipse semi-axes, 0.6 m thickness), the FV32 frequencies and the other LE/FV/T targets, and to cover contact and nonlinear benchmarks at all. Where: NAFEMS shop or a member library.
2. **MacNeal and Harder 1985** (Finite Elem. Anal. Des. 1:3-20): an OCR'd or library copy to confirm the hemisphere (0.094), twisted beam (0.005424 / 0.001754), straight-cantilever targets and the Scordelis-Lo 0.3024 against 0.3086 discussion, with units. Also Belytschko et al., CMAME 51 (1985) 221-258 ("obstacle course").
3. **Cook's membrane** converged target 23.96: Simo and Rifai (1990) or Pian and Sumihara (1984).
4. **ASME V&V 10-2019 (R2025)** exact definitions and uncertainty reporting; **V&V 10.1-2012** illustrative-problem numbers; **V&V 20-2009**. Where: ASME store or a university library.
5. **NAFEMS ESQMS:01 (2020)** contents and NAFEMS reporting guidance ("How to" booklets).
6. **Weld and pressure-vessel standards**: IIW recommendations (2nd ed. IIW-2259-15, 2016; 3rd ed. 2024) for hot-spot coefficients, effective-notch thickness limits, FAT tables and knee points; BS 7608:2014+A1:2015; EN 1993-1-9; ASME BPVC VIII-2 Part 5 and Annex 5-A for linearisation wording and limits.
7. **NASA/SP-8007-2020/REV 2** PDF (NTRS 20205011530) for revised knock-down factors, and the 1968 SP-8007 to confirm φ = (1/16)√(R/t).
8. **Textbook chapters**: every textbook chapter number in Fundamentals is unverified; check against Cook 4th ed., Zienkiewicz 7th or 8th ed., Bathe 2nd ed., Belytschko 2nd ed. Felippa's IFEM notes have no official mirror; MIT OpenCourseWare 2.092/2.093 (Bathe) is a free alternative. Shigley Marin constants against the 10th or 11th edition. Timoshenko and Woinowsky-Krieger plate coefficients (α = 0.00406, β = 0.0479).
9. **Roark's Formulas, 9th ed.**: not read; only seen as a source for SOLIDWORKS verification problems.
10. **Benzley et al. 1995** full text (Sandia International Meshing Roundtable archive) for the mesh densities behind the 10-70 % linear-tet error; **Kalbag 1992** and **Schneider et al. 2019** full texts to resolve the different snippet summaries.
11. **Roache 1994** and Celik et al. 2008 for the GCI procedure itself; **Zienkiewicz and Zhu 1987/1992** for the estimator.
12. **Hardwick 2005 / SAND2005-4647** full text (osti.gov) to confirm or refute the ">70 %" preprocessing figure; the original Blacker source for "80 %".

### Accuracy evidence still missing

13. Typical agreement between FEA and **strain-gauge or DIC measurements**, and **novice against expert analyst** error studies. Where: NAFEMS *Benchmark* magazine round robins; Int. J. Mech. Eng. Educ.
14. **Material scatter** with primary numbers (coefficient of variation of E, yield, fatigue strength) and Miner sums at failure. Where: MMPDS statistical chapters; Schütz; Eulitz and Kotte.
15. **Sensitivity to friction and contact assumptions**, quantified.
16. **Independent accuracy studies** of SimSolid (a Keysight 2023 talk, academic theses), Ansys Discovery Explore (a structural verification document) and Intact IMM (papers by Freytag, Shapiro and Tsukanov, University of Wisconsin). The full NAFEMS/Symington 2020 tables and the SimSolid 2022.3 NAFEMS manual percentages.
17. **Stress-at-boundary error tables** for the finite cell method (Parvizian, Düster and Rank 2007; Düster et al. 2008) and CutFEM (Burman et al. 2015, ghost penalty and Nitsche details).
18. **Stress error from envelope meshing** (fTetWild's ε-boundary) against exactly conforming meshes; no study found.
19. **Volume-meshing robustness on a STEP corpus** (for example the ABC dataset) instead of Thingi10k STL models.
20. **Float32 against float64 stress error** in thin-walled or slender FE models; no paper found. Göddeke et al. 2007 and Baboulin et al. 2009 are the next reads.
21. **3D linear elasticity walk-on-spheres** papers from 2023-2026.
22. **Trust displays** in Fusion, Onshape, SimScale and Simcenter (singularity warnings, reaction-force balance checks), and any study of how often users report peak stress at singularities.

### Programs and licences

23. Current **Fusion local-solve** status (Fusion 2026 help); current **Onshape plan tiers** with Simulation; SimSolid's current product name; the **Synopsys-Ansys** closing date.
24. Analysis lists, element libraries and verification manuals for **Solid Edge Simulation, Simcenter 3D, Simcenter Nastran/Femap, LS-DYNA and Abaqus**; total counts for the **Ansys Verification Manual, Abaqus Benchmarks Guide, SOLIDWORKS verification problems and Autodesk Nastran** verification manual.
25. **Licence checks still open**: MarcoAttene/CDT, Rust crates spade and "tetra"-named crates, SALOME SMESH, GMP, geogram's third-party folder, MPL-2.0 conditions for fTetWild, calculix.de and code-aster.org licence pages, Elmer's license_texts (is ElmerSolver LGPL?), documentation licences of code_aster, Elmer, MYSTRAN, CoFEA and FeenoX, cuDSS and cuSPARSE terms, the first Apache-2.0 Warp release, PETSc's exact BSD clause count.
26. **Rust Krylov-solver crates** were not surveyed.

### Browser and GPU platform

27. Per-browser **raised WebGPU limits** (for example maxStorageBufferBindingSize on desktop GPUs) and **subgroups** shipping status: chromestatus.com, webgpureport.org.
28. **WGSL section 15.7** floating-point rules (subnormal flushing, division accuracy).
29. **Windows TDR** default and per-browser watchdog behaviour (Microsoft Learn TDR registry keys; Chromium Dawn documentation); cross-origin isolation and SIMD128 status (MDN SharedArrayBuffer; webassembly.org/features).
30. Exact numbers for **Aage 2017** (voxels, DOF, cores, hours) and **Wu 2016** (elements, GPU, time per iteration), and **Liu 2018** run time and hardware; published **geometric multigrid against Jacobi iteration tables** for elasticity (Kronbichler and Kormann; deal.II step-37; MFEM ex2p).
31. A published **WebGPU against CUDA solver benchmark**; none found beyond the author's spike.

### Community evidence

32. **Vote, kudos and reply counts**, collected read-only in a normal browser: Autodesk Fusion Ideas ("local solve", "simulation report", "parametric study"), Inventor Ideas (stress analysis), SOLIDWORKS forum, PTC Creo ideas (Simulate, Simulation Live), Onshape Improvement Requests ("simulation", "modal", "contact"), FreeCAD FEM forum, SimScale forum, and Reddit r/fea, r/SolidWorks, r/Fusion360, r/onshape and r/AskEngineers. Reddit could not be fetched and Autodesk forums returned 403 during this research.
33. Sourced evidence for complaints about **unit confusion, bad default supports and poor report output**.
34. Sources for the **analyst workflow** (solver decks and result formats) and the **modal workflow**, from each program's user manual; the Enterfea (Łukasz Skotny) blog on designer-FEA pitfalls; NAFEMS, CIMdata and Lifecycle Insights survey reports (likely member-only).

### SolidCraft items not reviewed

35. [#934](https://github.com/tangency-labs/solidcraft/issues/934), listed by the requester, was not reviewed in the notes.
36. [#1569](https://github.com/tangency-labs/solidcraft/issues/1569), SolidCraft's own glossary, was not checked against this file's glossary; where it defines a term, the issue asks that its definition be used.
37. Why [#6971](https://github.com/tangency-labs/solidcraft/issues/6971) was closed on the day it was opened is not stated in its comments.

### Completeness check

Walking the issue's checklist honestly:

| Check | Status |
|---|---|
| Every section in the required order | Yes: About this research, Summary, Fundamentals, Accuracy, Programs, Complaints and requests, What users need, Glossary, Open questions, Sources. |
| Every fundamental in the issue | Covered: governing equations, elements, element problems, meshing and convergence, supports and loads, singularities and stress concentrations, materials, nonlinearity, solvers, dynamics, buckling, fatigue, reading results, verification and validation, reporting and trust. Thin spots: shell and beam validity thresholds are rules of thumb (unverified); weld fatigue values largely from memory; no workflow source for modal analysis; reaction-balance check not sourced as a hand-off item. |
| Every program in the issue | All listed programs have an entry. Thin spots: Solid Edge Simulation, Simcenter 3D, Simcenter Nastran/Femap and LS-DYNA have only unverified one-line descriptions; no user praise or complaints were found for Solid Edge, Simcenter 3D, LS-DYNA, Abaqus, MSC Nastran, OptiStruct, COMSOL, fe-safe or nCode. |
| Every accuracy source in the issue | Each is listed in Accuracy with its status. Read: NASA-STD-7009B (in full), NAFEMS Code Verification index, patch-test abstract. Not read (paywalled): all NAFEMS booklets, MacNeal-Harder, Zienkiewicz-Zhu, ASME V&V 10 and 10.1, ESQMS:01, BS 7608, IIW, EN 1993-1-9, ASME VIII-2, Roark, and all listed textbooks. R0080 and R0081 are not covered in the notes at all. |
| Emphases requested | Tiering (Fundamentals, first subsection; Summary 1); meshing bottleneck, mesher licences, robustness numbers and mesh-avoiding accuracy table with publisher (Fundamentals, Meshing; Summary 2-4); GPU and browser solvers, libraries and WebGPU/wasm limits (Fundamentals, Solvers; Summary 9); live-in-CAD competitors (Programs; Summary 10); ML surrogates (Programs; Summary 11); benchmark fixtures with confirmation status (Accuracy; Summary 8). |
| Every claim cited or marked (unverified) | Intended throughout. Textbook chapters are cited but marked unverified because the books were not opened. Some own-calculation worked examples rest on unverified constants (plate coefficients, the SP-8007 φ, Marin constants) and say so. |
| No copied text | Written in own words from the notes; quotations are single sentences or short phrases with sources. Benchmark targets are numerical facts cited to public documents; no tables or figures were copied from papers, books or standards. The vendor result tables (Altair MacNeal-Harder) are restated numbers with attribution; whether restating a vendor's own numeric results is acceptable to the project should be confirmed by a maintainer. |
| No copyleft source code | None read. Licences were checked from licence files, front pages or metadata. |
| No commercial software driven | None run, scripted or automated; no screenshots. |
| No private data | None. The personal spike used a part from the author's own project; its geometry is not published here, only aggregate results. |
| What is missing | Listed above under Open questions 1-37, most importantly: community vote counts, independent accuracy studies of mesh-avoiding commercial tools, strain-gauge/DIC agreement data, material scatter statistics, NAFEMS contact and nonlinear benchmarks, and a STEP-corpus meshing benchmark. |

## Sources

Grouped by kind. Web pages without their own date were accessed in October 2026 (most on 2026-10-28). "Read" means the primary text was read; "abstract" or "snippet" means only that was seen; "to read" means not read.

### SolidCraft repository (tangency-labs/solidcraft, read through the GitHub API, 2026-10-28)

- [#1620](https://github.com/tangency-labs/solidcraft/issues/1620) Research Request for Plugin: FEA (the issue this answers).
- [#6971](https://github.com/tangency-labs/solidcraft/issues/6971) Simulation: linear static stress analysis (FEA) for parts, 2026-10-26.
- [#6972](https://github.com/tangency-labs/solidcraft/issues/6972) Generative design / topology optimization, 2026-10-26.
- [#3239](https://github.com/tangency-labs/solidcraft/issues/3239) Add FieldCraft as simulation branch, 2026-10-19.
- [Discussion #2381](https://github.com/tangency-labs/solidcraft/discussions/2381) Adding names to entities, 2026-10-18.
- [#2356](https://github.com/tangency-labs/solidcraft/issues/2356) Boolean step and export defects, 2026-10-18.
- [PR #834](https://github.com/tangency-labs/solidcraft/pull/834) Export 3MF with B-rep face tags, merged 2026-10-13.
- [#785](https://github.com/tangency-labs/solidcraft/issues/785), [#922](https://github.com/tangency-labs/solidcraft/issues/922), [#923](https://github.com/tangency-labs/solidcraft/issues/923), [#1094](https://github.com/tangency-labs/solidcraft/issues/1094) materials, 2026-10-13/14.
- [#1221](https://github.com/tangency-labs/solidcraft/issues/1221) plugin system and [comment listing plugins](https://github.com/tangency-labs/solidcraft/issues/1221#issuecomment-6179150042); [#1569](https://github.com/tangency-labs/solidcraft/issues/1569) and [#934](https://github.com/tangency-labs/solidcraft/issues/934) (not reviewed).

### Personal experience (not public, not peer reviewed)

- Ruben Hekkens, voxel FEA spike: browser (WebGPU) against native (CUDA), README and results summary, ScriptCAD project, 2026-10-28.

### Standards and official guides

- NASA-STD-7009B, *Standard for Models and Simulations*, 2024-03-05. [PDF](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf). Read in full.
- ASME V&V 10-2019 (R2025), [ASME](https://www.asme.org/codes-standards/find-codes-standards/standard-for-verification-and-validation-in-computational-solid-mechanics). To read.
- ASME V&V 10.1-2012 (R2022), [ASME](https://www.asme.org/codes-standards/find-codes-standards/an-illustration-of-the-concepts-of-verification-and-validation-in-computational-solid-mechanics). To read.
- ASME V&V 20-2009. To read.
- NAFEMS ESQMS:01 (2020), [NAFEMS](https://www.nafems.org/publications/resource_center/esqms-01/). To read.
- BS 7608:2014+A1:2015, [BSI](https://knowledge.bsigroup.com/products/guide-to-fatigue-design-and-assessment-of-steel-products). To read.
- IIW, *Recommendations for Fatigue Design of Welded Joints and Components*: IIW-2259-15 (Hobbacher, 2nd ed., Springer 2016) and 3rd ed. (Hobbacher and Baumgartner 2024), [doi:10.1007/978-3-031-57667-6](https://doi.org/10.1007/978-3-031-57667-6). To read.
- EN 1993-1-9:2005, Eurocode 3 Part 1-9 Fatigue. To read.
- ASME BPVC Section VIII, Division 2, Part 5 and Annex 5-A. To read.
- ASTM E8/E8M, ASTM E111, ASTM E1049-85 (R2017). To read.
- MMPDS (successor to MIL-HDBK-5). To read.
- ASCE 7-16 §12.9.1. To read.
- IBC Table 1604.3; 14 CFR 25.303. Not read (clauses unverified).
- NASA SP-8007 (1965, rev. 1968). To read.
- NASA/SP-8007-2020/REV 2, Hilburger, 2020-12-01, [NTRS 20205011530](https://ntrs.nasa.gov/citations/20205011530). Abstract read.
- NASA NESC Technical Bulletin 16-01, *Buckling Knockdown Factors for Composite Cylinders*, PDF 2024-01, [NTRS](https://ntrs.nasa.gov/api/citations/20240000391/downloads/TB%2016%2001%20Buckling%20Knockdown%20Factors.pdf). Read.
- NASA/TM-2002-211692, [NTRS 20020062759](https://ntrs.nasa.gov/api/citations/20020062759/downloads/20020062759.pdf). Summary.
- NASA presentations citing the AFFTC handbook, [NTRS 20120014454](https://ntrs.nasa.gov/api/citations/20120014454/downloads/20120014454.pdf), [NTRS 20140010282](https://ntrs.nasa.gov/api/citations/20140010282/downloads/20140010282.pdf). Snippet.
- NASA-hosted paper on SP-8007 equations, [NTRS 20120008172](https://ntrs.nasa.gov/api/citations/20120008172/downloads/20120008172.pdf). Snippet.
- Shuttle payload random load factors, [NTRS 19900015329](https://ntrs.nasa.gov/citations/19900015329). Summary.
- Simmons 2001, NASA GSFC FEMCI poster on Miles' equation, [PDF](https://femci.gsfc.nasa.gov/workshop/2001/posters/simmons/Simmons_MilesEquation.pdf). Summary.
- Sandia SAND2005-4647, Hardwick, Clay, Boggs, Walsh, *DART system analysis*, 2005-08-01, [Sandia](https://sandia.gov/research/publications/details/dart-system-analysis-2005-08-01). Abstract.
- Sandia Cubit 15.7 manual, ITEM chapter, [Sandia](https://www.sandia.gov/files/cubit/15.7/help_manual/WebHelp/item/item.htm); [Cubit licensing](https://cubit.sandia.gov/licensing/).

### Specifications

- W3C, *WebGPU*, Candidate Recommendation Draft 2026-09-15, [w3.org/TR/webgpu](https://www.w3.org/TR/webgpu/). Read 2026-10-28.
- W3C, *WebGPU Shading Language*, Candidate Recommendation Draft 2026-10-26, [w3.org/TR/WGSL](https://www.w3.org/TR/WGSL/). Read 2026-10-28.

### Benchmark sets and verification material

- NAFEMS, *The Standard NAFEMS Benchmarks* (P18, 1990), [NAFEMS](https://www.nafems.org/publications/resource_center/p18/); R0016 (1989), [NAFEMS](https://www.nafems.org/publications/resource_center/r0016/); R0081 (2001), [NAFEMS](https://www.nafems.org/publications/resource_center/r0081/); R0080 (2001), [NAFEMS](https://www.nafems.org/publications/resource_center/r0080/). To read.
- NAFEMS Code Verification index, [NAFEMS](https://www.nafems.org/publications/code-verification/); SimSolid 2022.3 entry, [NAFEMS](https://www.nafems.org/publications/code-verification/simsolid-code-verification/). Read.
- NAFEMS UK 2020 abstract c_nov_20_uk_11, [NAFEMS](https://www.nafems.org/publications/resource_center/c_nov_20_uk_11).
- CoFEA documentation, [readthedocs](https://cofea.readthedocs.io/en/docs-dev/benchmarks/002-cook-membrane/index.html).
- FeenoX mechanical examples, [HTML](https://www.seamplex.com/feenox/examples/mechanical.html), [PDF](https://www.seamplex.com/feenox/examples/mechanical.pdf).
- code_aster R4.10.01 (mirror), [PDF](https://ericca.uqtr.ca/fr14.4/man_r/r4/r4.10.01.pdf). Snippet.
- ESRD NAFEMS linear benchmarks, 2020-01, [ESRD](https://www.esrd.com/download/nafems-linear-benchmarks-jan-2020-pdf/).
- cfd-verify documentation, [readthedocs](https://cfd-verify.readthedocs.io/en/stable/discretization_uncertainty.html).
- U. Iowa course PDF on Xing and Stern, [PDF](https://user.engineering.uiowa.edu/~me_160/CFD%20Labs/xing.pdf). Snippet.

### Textbooks (cited by chapter; not opened, chapters unverified)

- Cook, Malkus, Plesha, Witt, *Concepts and Applications of Finite Element Analysis*, 4th ed., Wiley 2001/2002, [Wiley](https://www.wiley.com/en-us/Concepts+and+Applications+of+Finite+Element+Analysis%2C+4th+Edition-p-9780471356059).
- Zienkiewicz, Taylor, Zhu, *The Finite Element Method: Its Basis and Fundamentals*, 7th ed., 2013; 8th ed. with Govindjee, 2024, [Elsevier](https://shop.elsevier.com/books/the-finite-element-method-its-basis-and-fundamentals/zienkiewicz/978-0-443-16044-8). Zienkiewicz, Taylor, Fox, *The FEM for Solid and Structural Mechanics*, 7th ed., 2014.
- Bathe, *Finite Element Procedures*, 2nd ed., 2014, [Open Library](https://openlibrary.org/isbn/9780979004957).
- Belytschko, Liu, Moran, Elkhodary, *Nonlinear Finite Elements for Continua and Structures*, 2nd ed., 2014, [Wiley](https://www.wiley.com/en-us/Nonlinear+Finite+Elements+for+Continua+and+Structures%2C+2nd+Edition-p-9781118632703).
- Szabó and Babuška, *Finite Element Analysis*, 1991; 2nd ed. *Method, Verification and Validation*, 2021, [Wiley](https://www.wiley.com/en-us/Finite+Element+Analysis%3A+Method%2C+Verification+and+Validation%2C+2nd+Edition-p-9781119426424).
- Oberkampf and Roy, *Verification and Validation in Scientific Computing*, CUP 2010, [doi](https://doi.org/10.1017/CBO9780511760396).
- Roache, *Verification and Validation in Computational Science and Engineering*, Hermosa 1998.
- Young, Budynas, Sadegh, *Roark's Formulas for Stress and Strain*, 9th ed., 2020, [Open Library](https://openlibrary.org/isbn/9781260453751).
- Hughes, *The Finite Element Method*, 1987 / Dover 2000. Crisfield, *Non-linear FEA of Solids and Structures*, Vol. 1, 1991. Wriggers, *Computational Contact Mechanics*, 2nd ed., 2006. Laursen, *Computational Contact and Impact Mechanics*, 2002. Simo and Hughes, *Computational Inelasticity*, 1998. de Souza Neto, Perić, Owen, *Computational Methods for Plasticity*, 2008. Holzapfel, *Nonlinear Solid Mechanics*, 2000. Ferry, *Viscoelastic Properties of Polymers*, 3rd ed., 1980. Penny and Marriott, *Design for Creep*, 2nd ed., 1995. Jones, *Mechanics of Composite Materials*, 2nd ed., 1999.
- Saad, *Iterative Methods for Sparse Linear Systems*, 2nd ed., SIAM 2003. George and Liu 1981. Davis, *Direct Methods for Sparse Linear Systems*, SIAM 2006. Greenbaum, *Iterative Methods for Solving Linear Systems*, SIAM 1997. Trottenberg, Oosterlee, Schüller, *Multigrid*, 2001. Shewchuk 1994, CG tutorial.
- Chopra, *Dynamics of Structures*, 5th ed., 2017. Craig and Kurdila, *Fundamentals of Structural Dynamics*, 2nd ed., 2006. Wirsching, Paez, Ortiz, *Random Vibrations*, 1995/2006. Blevins, *Formulas for Natural Frequency and Mode Shape*, 1979.
- Shigley's *Mechanical Engineering Design*, 10th ed., 2015. Dowling, *Mechanical Behavior of Materials*, 4th ed., 2013. Schijve, *Fatigue of Structures and Materials*, 2nd ed., 2009. Socie and Marquis, *Multiaxial Fatigue*, SAE 2000.
- Pilkey and Pilkey, *Peterson's Stress Concentration Factors*, 3rd ed., 2008. Timoshenko and Goodier, *Theory of Elasticity*, 3rd ed., 1970. Timoshenko and Woinowsky-Krieger, *Theory of Plates and Shells*, 2nd ed., 1959. Timoshenko and Gere, *Theory of Elastic Stability*, 1961, and *Mechanics of Materials*. Johnson, *Contact Mechanics*, 1985.
- Cheng, Dey, Shewchuk, *Delaunay Mesh Generation*, CRC 2012, [book page](https://people.eecs.berkeley.edu/~jrs/meshbook.html).
- Felippa, *Introduction to Finite Element Methods*, CU ASEN 5007 notes, Fall 2004 (mirror listing [Scribd](https://www.scribd.com/doc/53200407/Introduction-to-Finite-Element-Methods); [CU syllabus 2019](https://www.colorado.edu/aerospace/sites/default/files/attached-files/asen_5007_syllabus_fall_2019.pdf)).

### Research papers, theses and preprints

Elements, verification and error estimation:
- MacNeal and Harder, FEAD 1 (1985) 3-20, [doi](https://doi.org/10.1016/0168-874X(85)90003-4); scanned copy [PDF](https://x2go-cdm.ing.unimo.it/_shared/Irons_patch_test/macneal1985proposed.pdf). Not readable.
- Taylor, Simo, Zienkiewicz, Chan, IJNME 22 (1986) 39-62, [doi](https://doi.org/10.1002/nme.1620220105); [UTAS record](https://figshare.utas.edu.au/articles/journal_contribution/The_patch_test_-_a_condition_for_assessing_FEM_convergence/22944206). Abstract.
- Zienkiewicz and Zhu, IJNME 24 (1987) 337-357, [doi](https://doi.org/10.1002/nme.1620240206); IJNME 33 (1992) 1331-1382. To read.
- Benzley et al. 1995, Proc. 4th IMR, [BibSonomy](https://www.bibsonomy.org/bibtex/1186886d560f3171c13e0dc8b71bdb4ce). Abstract.
- Review citing Benzley, arXiv 0911.3884 (2009), [PDF](https://arxiv.org/pdf/0911.3884). Read.
- Kalbag 1992, [IBM listing](https://researchweb.draco.res.ibm.com/publications/a-performance-study-of-tetrahedral-and-hexahedral-elements-in-3-d-finite-element-structural-analysis). Snippet.
- Schneider et al. 2019, [PDF](https://web.uvic.ca/~teseo/profile/publications/tet-vs-hex/Schneider.2019.tet-vs-hex.pdf). Snippet.
- Wilson et al. 1973; Taylor, Beresford, Wilson 1976; Irons and Razzaque 1972; Flanagan and Belytschko 1981; Williams 1952; Riks 1979; Crisfield 1981; Roache 1994; Celik et al. 2008; Findley 1959; Dang Van et al. 1989; George 1973; Ogden 1972; Cowper 1966; Wagner et al. 2017. Bibliographic details from memory (unverified).
- arXiv 2103.14559 and 2309.05509 (GCI), [2103.14559](https://arxiv.org/pdf/2103.14559), [2309.05509](https://arxiv.org/pdf/2309.05509). Snippets.
- Schöllhammer and Fries, arXiv 1805.11978 (2018), [PDF](https://arxiv.org/pdf/1805.11978). Read secs. 5.2-5.3.
- Cook's membrane: [arXiv 1807.03106](https://arxiv.org/pdf/1807.03106), [arXiv 1706.07794](https://arxiv.org/pdf/1706.07794). Snippets.
- Shell bending with tets, [arXiv 2305.13841](https://arxiv.org/pdf/2305.13841). Snippet.
- Boyce et al., Sandia Fracture Challenge, Int. J. Fract. 2014, [MIT DSpace](https://dspace.mit.edu/handle/1721.1/110644). SFC4 keynote, [ICF15](https://icf15.gatech.edu/sessions/symp01-m1-1).
- SEM proceedings launcher modal correlation, [River Publishers](https://sem.elibrary.riverpublishers.com/ebook/9788770049337/166/). Snippet.

Welds:
- Hobbacher 2003, Paton Welding Journal, [link](https://patonpublishinghouse.com/eng/journals/tpwj/2003/10/17). Snippet.
- Pedersen et al., Int. J. Fatigue 2010, [PDF](https://vbn.aau.dk/ws/files/221973786/Pedersen_IJF2010.pdf). Snippet.
- Rohani Raftar et al. (LUT), [PDF](https://lutpub.lut.fi/bitstream/10024/162057/3/rohani_raftar_et_al_re-evaluation_of_weld_final_draft.pdf). Snippet.

Meshing:
- Hu, Zhou, Gao, Jacobson, Zorin, Panozzo, *Tetrahedral Meshing in the Wild*, ACM TOG 37(4), 2018, [PDF](https://www.cs.toronto.edu/~jacobson/images/tetrahedral-meshing-in-the-wild-siggraph-2018-compressed-hu-et-al.pdf). Read.
- Hu, Schneider, Wang, Zorin, Panozzo, *Fast Tetrahedral Meshing in the Wild*, ACM TOG 39(4), 2020, [arXiv 1908.03581](https://ar5iv.arxiv.org/html/1908.03581). Read.
- Diazzi, Panozzo, Vaxman, Attene, *Constrained Delaunay Tetrahedrization: A Robust and Practical Approach*, ACM TOG 2023, [PDF](https://cims.nyu.edu/gcl/papers/2023-CDT.pdf). Read.
- arXiv 2106.01326 (voxelization, TetGen subset), [PDF](https://arxiv.org/pdf/2106.01326). Snippet.
- Cheng, Dey, Edelsbrunner, Facello, Teng, *Sliver exudation*, J. ACM 47(5), 2000, [ISTA](https://research-explorer.ista.ac.at/record/4010); Edelsbrunner and Guoy, [PDF](https://people.eecs.berkeley.edu/%7Ejrs/meshpapers/EdelsbrunnerGuoy.pdf); [Illinois record](https://ideals.illinois.edu/items/82861).
- Johnen, Remacle, Geuzaine, [preprint](https://gmsh.info/doc/preprints/gmsh_curved2_preprint.pdf); Geuzaine et al., [preprint](https://people.montefiore.uliege.be/geuzaine/preprints/curvilinear_preprint.pdf); Toulorge et al., J. Comput. Phys. 254 (2013), [abstract](https://dial.uclouvain.be/pr/boreal/en/object/boreal%3A130557).
- Buffa, Chanon, Vázquez, analysis-aware defeaturing, M3AS 2022, [EPFL](https://infoscience.epfl.ch/entities/publication/37c143d3-fd63-4aeb-b9fc-6b06b34bdd08); adaptive version, arXiv 2212.05183, [mirror](https://deepai.org/publication/adaptive-analysis-aware-defeaturing); multi-feature and elasticity, [EPFL](https://infoscience.epfl.ch/items/0226100f-07c4-4991-967a-9cd7ecf5e613).
- TU Delft thesis (Blacker attribution), [repository](https://repository.tudelft.nl/file/File_87125b2e-8786-4531-8c12-81681972e24c?preview=1). SMiRT-20 paper, [NCSU](https://repository.lib.ncsu.edu/server/api/core/bitstreams/ef3d4985-b353-419b-bc83-5bd47187f0a4/content). Shepherd, 13th European LS-DYNA Conference 2021, [dynalook](https://www.dynalook.com/conferences/13th-european-ls-dyna-conference-2021/crash/shepherd_brigham_young_university.pdf/view).

Mesh-avoiding methods:
- Dauge, Düster, Rank, J. Sci. Comput. 2015, [page](https://perso.univ-rennes1.fr/monique.dauge/publis/DaDusRank.html); Schillinger and Ruess, review 2015, [doi](https://www.doi.org/10.1007/S11831-014-9115-Y); Parvizian, Düster, Rank 2007; Düster et al. 2008 (to read).
- Burman, Claus, Hansbo, Larson, Massing, CutFEM, IJNME 104(7) 2015, [UCL](https://discovery-pp.ucl.ac.uk/id/eprint/1471066).
- Main and Scovazzi, shifted boundary method, 2018, [Duke](https://scholars.duke.edu/publication/1916955); Gap-SBM thesis, [DukeSpace](https://dukespace.lib.duke.edu/items/94a1ee98-cd85-40ea-a7f6-64c1c97789fd/full); Atallah, Canuto, Scovazzi 2022, [PDF](https://iris.polito.it/retrieve/handle/11583/2973271/6c33bb53-8f21-4d96-bc7f-77f417699aa3/SBM_High-Order.pdf).
- Hughes, Cottrell, Bazilevs, IGA, CMAME 194 (2005), [Oden report](https://www.oden.utexas.edu/media/reports/2006/0604.pdf); [Hughes 2016 slides](https://www.ices.utexas.edu/~babuska/babuska_forum/slides/Tom_Hughes_Babuska_2016.pdf).
- Belytschko, Lu, Gu, EFG, IJNME 37 (1994); Liu, Jun, Zhang, RKPM, 1995 (to read).
- Aage, Andreassen, Lazarov, Sigmund, Nature 550 (2017), [RePEc](https://ideas.repec.org/a/nat/nature/v550y2017i7674d10.1038_nature23911.html); [TopWingData](https://data.dtu.dk/articles/dataset/TopWingData/12581615/1).
- Voxel finite cell with phase-field boundary conditions, [CRIS IUCC](https://cris.iucc.ac.il/en/publications/phase-field-boundary-conditions-for-the-voxel-finite-cell-method-/).
- Bone micro-FE, [arXiv 2512.24401](https://arxiv.org/pdf/2512.24401); [Lievers database](https://wbldb.lievers.net/10200880.html); voxel contact, [Univ. Iowa](https://iro.uiowa.edu/esploro/outputs/journalArticle/A-Voxel-based-Formulation-for-Contact-Finite/9984040564602771). Snippets.
- Walk on Stars, arXiv 2302.11815, [PDF](https://arxiv.org/pdf/2302.11815); [mcgp-resources](https://rohan-sawhney.github.io/mcgp-resources/); Sabelfeld, Shalimova, Levykin 2006, [TIB](https://oa.tib.eu/renate/handle/123456789/3156); arXiv 2608.07017, [PDF](https://arxiv.org/pdf/2608.07017).

Solvers and GPUs:
- Kronbichler and Kormann 2012 and 2019 (to read); arXiv 2205.08909, [abs](https://arxiv.org/abs/2205.08909).
- Carson and Higham, SIAM J. Sci. Comput. 40(2) 2018, [eprint 2629](https://eprints.maths.manchester.ac.uk/2629/); [eprint 2735](https://eprints.maths.manchester.ac.uk/2735/).
- Liu, Hu, Zhu, Matusik, Sifakis, ACM TOG 37(6) 2018, [SIGGRAPH archive](https://history.siggraph.org/?p=198051). Abstract.
- Wu, Dick, Westermann, IEEE TVCG 2016, [project page](https://homepage.tudelft.nl/z0s1z/projects/2016-GPU-topopt.html); TU Delft DCSE, [page](https://homepage.tudelft.nl/y95n9/project_DCSE.html). Snippets.
- Göddeke, Strzodka, Turek 2007; Vaněk, Mandel, Brezina 1996; Dohrmann 2003; Farhat and Roux 1991; Brown et al., libCEED, JOSS 2021 (to read).
- arXiv 1302.7193 (GPU matrix-free PCG), [PDF](https://arxiv.org/pdf/1302.7193).

Education and analyst opinion:
- ASEE PEER 532, [ASEE](https://peer.asee.org/532).
- R. P. Johnson, Fluxus Engineering, [page](https://fluxus-engineering.com/ecittt_johnson.htm).

### Program documentation and verification manuals (vendor)

- Autodesk: [Inventor Nastran 2026 Mesh Convergence](https://help.autodesk.com/cloudhelp/2026/ENU/NINCAD-UsersGuide/files/GUID-834A66B2-3777-481D-BE28-A741A60C6F17.htm); [h refinement threshold](https://knowledge.autodesk.com/support/inventor-products/learn-explore/caas/sfdcarticles/sfdcarticles/h-refinement-threshold-s.html); [Inventor 2014 Set Convergence](https://help.autodesk.com/cloudhelp/2014/ENU/Inventor/files/GUID-11F5A03D-8ED7-4330-8D87-D435756B5ED4.htm); [Flex rate sheet](https://autodesk.com/flexratesheet-ppr); support articles on [Fusion simulation updates](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Updates-to-the-Fusion-360-Simulation-Extension.html) and [local simulation](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-perform-a-local-simulation-in-Fusion-360.html); [Procad copy of comparison matrix, 2023-01](https://www.procad.pl/wp-content/uploads/2023/01/fusion360-simulation-extension-comparison-matrix-en.pdf); [CADstudio credit FAQ](https://cadstudio.cz/dl/fusion-360-faq-cloud-credit-offerings-en.pdf).
- Dassault Systèmes: SOLIDWORKS help [2022 Adaptive](https://help.solidworks.com/2022/english/SolidWorks/cworks/IDC_HELP_PRESTATIC_P_ADAPTIVE.htm), [2015 Adaptive](https://help.solidworks.com/2015/English/SOLIDWORKS/Cworks/IDC_HELP_PRESTATIC_P_ADAPTIVE.htm), [API 2017](https://help.solidworks.com/2017/English/api/swsimulationapi/SolidWorks.Interop.cosworks~SolidWorks.Interop.cosworks.ICWStaticStudyOptions~HAdaptiveTargetAccuracy.html); Abaqus 2017 docs [Full integration](https://abaqus-docs.mit.edu/2017/English/SIMACAEGSARefMap/simagsa-c-ctmfull.htm), [LE10](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le10.htm), [LE11](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le11.htm), [pinched cylinder](https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-pinchcyl.htm); [Abaqus 2016 USB 12.3.1](https://ceae-server.colorado.edu/v2016/books/usb/pt04ch12s03abo15.html); [fe-safe User Guide 2024](https://docs.software.vt.edu/abaqusv2024/English/FesafeUserPdf/FesafeUser.pdf).
- PTC: Creo help [Percent Convergence r10](https://support.ptc.com/help/creo/creo_pma/r10.0/usascii/simulate/simulate/stat_convper.html), [convergence quantity r9](https://support.ptc.com/help/creo/creo_pma/r9.0/korean/simulate/simulate/stat_convqty.html), [MPA Creo 13](https://support.ptc.com/help/creo/creo_pma/r13/italian/simulate/simulate/stat_multiadap.html), [polynomial order Creo 13](https://support.ptc.com/help/creo/creo_pma/r13/usascii/simulate/simulate/specifying_p_ord_mpaa.html), [verification guide Creo 12](https://support.ptc.com/help/creo/creo_pma/r12/usascii/simulate/simulation_live/verification_models_sim_live.html), [solver upgrade](https://support.ptc.com/help/creo/creo_plus/usascii/whats_new/creo_ansys_sim_live_solver_upgrade.html), [Ansys solver update](https://support.ptc.com/help/creo/creo_plus_early_visibility/usascii/whats_new/ansys_simulation_solver_update.html); [KB CS34780](https://www.ptc.com/en/support/article/CS34780); Onshape [Simulation page](https://www.onshape.com/en/features/simulation) and [Modal help](https://cad.onshape.com/help/Content/Assembly/modal_simulation.htm).
- Ansys: help 2024 R2 [Convergence](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/wb_sim/ds_Convergence.html), [Error (Structural)](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/wb_sim/ds_Error_Structural.html), [VM Program Verification](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_CH1_3.html), [VM NAFEMS](https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/ans_vm/Hlp_V_CH4_1.html); [nCode in Ansys 2025 R1](https://ansyshelp.ansys.com/public/views/secured/corp/v251/en/ans_tec/tecfrettwear_postnCode.html); SimAI [UG Confidence Score](https://ansyshelp.ansys.com/public/Views/Secured/SimAI/v000/en/SimAI_ug/SimAI_ug/C_UG_SAI_confidence_score.html), [SimAI Pro docs](https://simai-pro.docs.ansys.com/version/stable/user_guide/prediction/step_postprocessing.html); [Discovery Explore FAQ](https://innovationspace.ansys.com/knowledge/forums/topic/what-simulation-technology-does-ansys-discovery-use-in-explore-mode/); [validation course](https://innovationspace.ansys.com/courses/courses/conjugate-heat-transfer/lessons/validation-in-refine-mode-lesson-5/).
- Altair / Siemens: OptiStruct help [MacNeal-Harder cantilever](https://help.altair.com/hwsolvers/os/topics/solvers/os/straight_cantilever_beam_verification_r.htm), [solid patch test](https://help.altair.com/hwsolvers/os/topics/solvers/os/elements_macneal_harder_solid_patch_test_verification_r.htm), [LE1](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le1_r.htm), [LE10](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le10_r.htm), [LE11](https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le11_r.htm), [Scordelis-Lo](https://help.altair.com/hwsolvers/os/topics/solvers/os/scordelis_lo_roof_verification_r.htm), [S-N method](https://help.altair.com/hwsolvers/os/topics/solvers/os/fatigue_fpm_sn_stress_life_method_r.htm); [SimSolid product intro](https://2021.help.altair.com/2021/ss/topics/simsolid/get%20started/product_intro_r.htm).
- COMSOL: [6.4 Adapt](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_mesh.24.41.html), [elliptic membrane 6.4](https://doc.comsol.com/6.4/doc/com.comsol.help.models.sme.elliptic_membrane/elliptic_membrane.html), [thick plate 6.1](https://doc.comsol.com/6.1/doc/com.comsol.help.models.sme.thick_plate/models.sme.thick_plate.pdf), [Scordelis-Lo 5.6](https://doc.comsol.com/5.6/doc/com.comsol.help.models.sme.scordelis_lo_roof/scordelis_lo_roof.html).
- Others: [SOFiSTiK BE41, 2024](https://docs.sofistik.com/2024/en/verification/_static/verification/pdf/be41.pdf); [FunctionBay RecurDyn Validation_NAFEMS](https://functionbay.com/documentation/onlinehelp/Documents/Validation/Validation_NAFEMS.pdf); [HBK DesignLife](https://www.hbkworld.com/en/products/software/durability/designlife-cae-fatigue-analysis); [SimScale pricing](https://simscale.com/product/pricing/).

### Vendor marketing, blogs and press (vendor claims)

- Altair/Siemens: [SimSolid validation guide](https://web.altair.com/simsolid_validation_guide); [Is SimSolid accurate](https://altair.com/blog/articles/Is-SimSolid-Accurate-We-Dare-You-to-Find-Out!); [SimSolid FEA benchmark blog](https://altair.com/blog/articles/Comparing-Altair-SimSolid-with-a-FEA-Benchmark); [NAFEMS SimSolid benchmark resource](https://altair.com/resource/nafems-simsolid-benchmark); [CNH pilot](https://altairengineering.fr/resource/piloting-simsolid-for-fast-directional-feedback); [Siemens OptiStruct (ko-kr)](https://www.siemens.com/ko-kr/products/simcenter/mechanical-simulation/optistruct/), [(ru-ru)](https://www.siemens.com/ru-ru/products/simcenter/mechanical-simulation/optistruct/); [Inspire 2026.1 blog](https://blogs.sw.siemens.com/simcenter/whats-new-in-simcenter-inspire-2026-1/); [Simcenter summer 2026](https://news.siemens.com/fr-ca/siemens-simcenter-summer-2026/); [HPCwire reprint 2026](https://www.hpcwire.com/off-the-wire/siemens-accelerates-engineering-simulation-with-a-unified-ai-powered-simcenter-portfolio/); [Simcenter blog 2016-08-18](https://blogs.sw.siemens.com/simcenter/announcing-new-research-on-fea-simulation-bottlenecks/); [Siemens infographic](https://www.plm.automation.siemens.com/media/global/es/Siemens-PLM-Addressing-bottlenecks-in-the-simulation-process-infographic_tcm54-58950.pdf); [Siemens and Neural Concept](https://news.siemens.com/es-es/neural-concept-simcenter/).
- Ansys: [SimAI product](https://ansys.com/products/simai); [2024 R1 Discovery webinar](https://www.ansys.com/webinars/ansys-2024-r1-ansys-discovery-whats-new).
- Autodesk: [Fusion blog 2022-08](https://autodesk.com/products/fusion-360/blog/?p=34470); [Simulation Extension blog](https://www.autodesk.com/products/fusion-360/blog/fusion-360-simulation-extension/).
- PTC / Onshape: [PR Newswire 2020-11](https://www.prnewswire.co.uk/news-releases/ptc-and-ansys-deliver-latest-cad-market-innovation-with-creo-ansys-simulation-806401036).
- SOLIDWORKS: [blog 2013-06](https://blogs.solidworks.com/solidworksblog/2013/06/simulation-tip-solidworks-simulation-verification-problems.html); [tech blog 2018-07](https://blogs.solidworks.com/tech/2018/07/what-is-a-stress-singularity-in-solidworks-simulation.html).
- NVIDIA: [PhysicsNeMo/Modulus page](https://developer.nvidia.com/modulus); [blog around 2018](https://blogs.nvidia.com/?p=42054).
- Others: [Intact Solutions](https://intact-solutions.com/?p=7588); [Spatial blog 2026-04-21](https://blog.spatial.com/fem-preprocessing-is-the-bottleneck); [SimScale blog](https://www.simscale.com/blog/convergence-finite-element-analysis/); [Neural Concept](https://neuralconcept.com/post/neural-concept-collaborates-with-siemens-to-enable-oems-to-make-faster-decisions-with-rapid-results-prediction); [Monolith case study](https://www.monolithai.com/case-studies/monolith-siemens-energy-integration); [HBK webinar](https://hbkworld.com/en/knowledge/resource-center/recorded-webinars/performing-fe-based-fatigue-analysis-with-ncode); [fe-safe brochure](https://www.beacon-india.com/wp-content/themes/beaconindia/pdf/fe-safe-brochure.pdf).
- Resellers and partners: [DRD webinar](https://drd.com/discovery-webinar-2-6_27_24-empowering-design-engineers-with-faster-and-more-accurate-gpu-physics-solvers); SimuTech [2024 R1](https://simutechgroup.com/?p=13395) and [MAC blog](https://simutechgroup.com/?p=810); [ESSS](https://www.esss.com/en/ansys-simulation-software/ansys-discovery/); [Maya HTT](https://www.mayahtt.com/blog/correlating-simulation-modal-test-results-simcenter-3d/); [GoEngineer](https://www.goengineer.com/en-us/blog/solidworks-simulation-solution-adaptive-mesh-refinement); [Solid Solutions 2017-09](https://solidsolutions.co.uk/Blog/2017/09/So-how-accurate-is-SOLIDWORKS-Simulation); Javelin [2018-01](https://www.javelin-tech.com/blog/2018/01/solidworks-simulation-stress-singularity-diagnostic/), [2024-01](https://www.javelin-tech.com/blog/2024/01/basic-setup-steps-for-an-fea-static-simulation-in-solidworks/), [mesh refinement](https://www.javelin-tech.com/blog/?p=69113); [CATI](https://cati.com/?p=127493); [Hawk Ridge](https://hawkridgesys.com/blog/solidworks-simulation-achieving-convergence-of-results); [Technia](https://blog.technia.com/en/simulation/fatigue-analysis-with-fe-safe); [Symetri deck](https://www.symetri.us/media/jwzixymu/large-scale-assemblies-webinar.pdf); [Mecway forum](https://mecway.com/forum/discussion/comment/378).

### Trade press and independent articles

- Digital Engineering 24/7: [Siemens completes Altair, 2025-03](https://www.digitalengineering247.com/article/siemens-completes-acquisition-of-altair/news); [Onshape simulation, 2022-10](https://www.digitalengineering247.com/article/ptc-offers-cloud-native-simulation-in-onshape); [democratising simulation](https://www.digitalengineering247.com/article/the-mission-to-democratize-simulation-at-turning-point).
- Machine Design: [Siemens-Altair, 2025-03](https://machinedesign.com/automation-iiot/news/55277904/siemens-siemens-completes-10-billion-acquisition-of-altair-engineering); [ML-enhanced CAE](https://machinedesign.com/cad-cam-software/article/55304730/ml-enhanced-computer-aided-engineering-in-the-cloud); [Kurowski, errors that mar FEA results](https://www.machinedesign.com/archive/article/21817360/more-errors-that-mar-fea-results).
- [NAFEMS news, Siemens-Altair](https://www.nafems.org/about-us/media/news/industrynews1003/siemens-completes-10-billion-acquisition-of-altair-engineering/); [NAFEMS blog](https://www.nafems.org/blog/posts/simulation-driven-design/).
- engineering.com: [SimSolid article](https://www.engineering.com/simsolid-faster-than-fea-just-as-accurate-whats-not-to-like/); [singularity article](https://www.engineering.com/?p=125052).
- [CAE University](https://caeuniversity.com/mesh-convergence-modern/); [develop3d on Coreform Cubit](https://develop3d.com/simulation/coreform-acquires-cubit-cae-meshing-technology/).
- Secondary references: [Wikipedia, Patch test](https://en.wikipedia.org/wiki/Patch_test_(finite_elements)); [Wikipedia, WebGPU](https://en.wikipedia.org/wiki/WebGPU); [Wikipedia, FEBio](https://en.wikipedia.org/wiki/FEBio); [validas.de 7009B glossary](https://www.validas.de/resources/glossary/nasa-std-7009b); [OSArch wiki, CalculiX](https://wiki.osarch.org/calculix/); [FSFE list 2001-10](https://lists.fsfe.org/pipermail/discussion/2001-October/001935.html); [web.dev WebGPU](https://web.dev/blog/webgpu-supported-major-browsers); [Khronos SIGGRAPH 2026](https://www.khronos.org/developers/linkto/webgl-and-webgpu-sigg26); [SpiderMonkey blog 2025-01-15](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html); [caniuse Memory64](https://caniuse.com/wf-wasm-memory64); [WebKit bug 300538](https://bugs.webkit.org/show_bug.cgi?id=300538); [community Abaqus fatigue guide](https://openskillindex.com/skills/majiayu000-claude-skill-registry-abaqus-fatigue-analysis); [Blender devtalk](https://devtalk.blender.org/t/gsoc-2020-soft-body-sim-discussion-and-suggestions/13765); [awesome.ecosyste.ms TetWild listing](https://awesome.ecosyste.ms/projects/github.com%2Fyixin-hu%2Ftetwild).

### Licence files and repository front pages (read 2026-10, mostly 2026-10-28)

- Meshers: [gmsh.info](https://gmsh.info/); [NGSolve/netgen](https://github.com/NGSolve/netgen); [TetGen FAQ](https://wias-berlin.de/software/tetgen/1.5/FAQ-license.html) and [page](https://wias-berlin.de/software/tetgen/); [CGAL packages](https://doc.cgal.org/latest/Manual/packages.html); [pygalmesh](https://github.com/meshpro/pygalmesh); [fTetWild](https://github.com/wildmeshing/fTetWild); [pytetwild](https://pypi.org/project/pytetwild); [geogram](https://github.com/BrunoLevy/geogram); [Mmg](https://github.com/MmgTools/mmg); [Quartet](https://github.com/crawforddoran/quartet); [MeshPy LICENSE (Triangle)](https://gitlab.tiker.net/inducer/meshpy/-/raw/main/LICENSE); [Triangle.NET](https://github.com/wo80/Triangle.NET).
- Solvers and GPU: [PETSc](https://github.com/petsc/petsc/blob/main/LICENSE); [hypre](https://github.com/hypre-space/hypre/blob/master/COPYRIGHT); [AmgX](https://github.com/NVIDIA/AMGX); [Warp](https://github.com/NVIDIA/warp/blob/main/LICENSE.md) and [history](https://github.com/NVIDIA/warp/commits/main/LICENSE.md); [Ginkgo](https://github.com/ginkgo-project/ginkgo); [MFEM](https://github.com/mfem/mfem); [libCEED](https://github.com/CEED/libCEED); [Trilinos](https://github.com/trilinos/Trilinos/blob/develop/LICENSE); [AMGCL](https://github.com/ddemidov/amgcl); [VexCL](https://github.com/ddemidov/vexcl); [MAGMA](https://github.com/icl-utk-edu/magma); [ViennaCL](https://github.com/viennacl/viennacl-dev/blob/master/LICENSE); [Kokkos](https://github.com/kokkos/kokkos/blob/develop/LICENSE).
- Rust: [faer](https://github.com/sarah-quinones/faer-rs); [nalgebra](https://github.com/dimforge/nalgebra); [russell](https://github.com/cpmech/russell); [gemlab](https://github.com/cpmech/gemlab); [pmsim](https://github.com/cpmech/pmsim); [wgpu](https://github.com/gfx-rs/wgpu); [burn](https://github.com/tracel-ai/burn); [cubecl](https://github.com/tracel-ai/cubecl); [rust-gpu](https://github.com/Rust-GPU/rust-gpu); [fenris](https://github.com/InteractiveComputerGraphics/fenris) and [docs.rs](https://docs.rs/crate/fenris/latest); [finiteelement](https://licenses.dev/cargo/finiteelement/0.1.0).
- FE programs: [FEBio](https://github.com/febiosoftware/FEBio); Kratos [license.txt](https://github.com/KratosMultiphysics/Kratos/blob/master/license.txt) and [kratos/license.txt](https://github.com/KratosMultiphysics/Kratos/blob/master/kratos/license.txt); [deal.II](https://github.com/dealii/dealii/blob/master/LICENSE.md); [MOOSE](https://github.com/idaholab/moose); [libMesh](https://github.com/libMesh/libmesh); [DOLFINx](https://github.com/FEniCS/dolfinx); [FreeCAD](https://github.com/FreeCAD/FreeCAD); [Elmer](https://github.com/ElmerCSC/elmerfem/blob/devel/LICENSE.md); [MYSTRAN](https://github.com/dr-bill-c/MYSTRAN); [PhysicsNeMo/Modulus](https://github.com/NVIDIA/modulus).
- Browser FEA projects: [RomanShushakov/fea_app](https://github.com/RomanShushakov/fea_app) (no licence); [andeplane/fem-lab](https://github.com/andeplane/fem-lab) (MIT).

### Community spaces (read only; counts mostly not retrievable)

- Autodesk forums: [Fusion cloud-only thread 11342929](https://forums.autodesk.com/t5/fusion-support-forum/fusion-360-cloud-solving-will-be-the-only-option-available-for/td-p/11342929); [petition 12624726](https://forums.autodesk.com/t5/fusion-support-forum/petition-bring-back-local-simulation/m-p/12624726); [buckling credits 10263646](https://forums.autodesk.com/t5/fusion-support-forum/error-failed-to-schedule-cloud-solve-buckling-simulation/m-p/10263646); [education 13018990](https://forums.autodesk.com/t5/fusion-support-forum/educational-account-access-simulations/m-p/13018990); [credit cap 7793038](https://forums.autodesk.com/t5/fusion-support-forum/increase-cloud-credit-threshold/m-p/7793038/highlight/true); [credits 10309287](https://forums.autodesk.com/t5/fusion-support-forum/fusion-360-cloud-credits/m-p/10309287); [stuck 11179553](https://forums.autodesk.com/t5/fusion-support/cloud-simulation-stuck/m-p/11179553); [generative local 8343494](https://forums.autodesk.com/t5/fusion-design-validate-document/generative-design-solve-locally/td-p/8343494); [Inventor convergence 5030224](https://forums.autodesk.com/t5/inventor-forum/stress-analysis-convergence/td-p/5030224); [Inventor mesh settings 9656903](https://forums.autodesk.com/t5/inventor-forum/fea-mesh-settings/m-p/9656903).
- SOLIDWORKS: [3DSwym forum](https://3dswym.3dexperience.3ds.com/question/solidworks-user-forum/simulation-meshing-stress-error_eNr7avHjSjizfZNkTXuq7w); [forum thread 40580](https://forum.solidworks.com/thread/40580).
- Onshape forum: [104956](https://forum.onshape.com/discussion/comment/104956), [104982](https://forum.onshape.com/discussion/comment/104982), [30325](https://forum.onshape.com/discussion/30325/why-choose-onshape-simulation-for-structural-analysis), [5133](https://forum.onshape.com/discussion/comment/5133), [84327](https://forum.onshape.com/discussion/comment/84327), [43710](https://forum.onshape.com/discussion/comment/43710), [85552](https://forum.onshape.com/discussion/comment/85552/), [19282 p3](https://forum.onshape.com/discussion/19282/improvements-to-onshape-october-10th-2022/p3).
- Ansys forum: [Explore vs Refine](https://innovationspace.ansys.com/forum/forums/topic/explore-mode-vs-refine-mode); [reply 372416](https://innovationspace.ansys.com/forum/forums/reply/372416/); [very different results](https://innovationspace.ansys.com/forum/forums/topic/very-different-results-in-explore-and-refine-mode); [?p=372062](https://innovationspace.ansys.com/forum/?p=372062); [Discovery Live stresses](https://innovationspace.ansys.com/knowledge/?p=159582).
- Eng-Tips: [431051](https://www.eng-tips.com/viewthread.cfm?qid=431051); [153636](https://www.eng-tips.com/viewthread.cfm?qid=153636); [466382](https://www.eng-tips.com/viewthread.cfm?qid=466382).
- Others: [Altair community 12193](https://community.altair.com/discussion/12193/simsolid-benchmarks-and-validation); SimScale forum [buckling](https://www.simscale.com/forum/t/eigenvalue-based-buckling-analysis/85429), [plans](https://www.simscale.com/forum/t/simscale-plans-pricing/27827), [2026-06 announcement](https://www.simscale.com/forum/t/simscale-opens-simerics-mp-mesher-and-simerics-mp-solver-to-its-entire-community-free-to-try-for-non-commercial-use/101137.md); [PhysicsForums](https://www.physicsforums.com/threads/mesh-changing-resulted-in-stress-change.512305/post-3397026); [Hacker News 24494653](https://news.ycombinator.com/item?id=24494653); [GrabCAD tutorial](https://grabcad.com/tutorials/how-to-do-your-first-static-simulation-in-solidworks).
