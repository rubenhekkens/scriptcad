# STEP benchmark summary (2026-10-28)

usd-brep 1.0.1, converters usdbrep-1.0.0, cadquery-ocp 8.0.1.1.0, Python 3.12.10, Windows AMD64. Per-file budget 300s. Volume tolerance 0.001 (relative).

Part-level rates count only parts of files that finished (no timeout or crash); parts beyond the first 25 of a file are not run through the kernel stages.

## abc

| stage | pass |
|---|---|
| files | 200 |
| OpenCASCADE reads file | 200/200 (100%) |
| files finished within budget | 191/200 (96%) |
| &nbsp;&nbsp;timed out / crashed | 8 / 1 (161 parts) |
| **files whose every part passes every stage** | **158/200 (79%)** |
| solid parts in finished files | 517 (+34 shell-only parts, +654 beyond the 25-part cap) |
| parts OpenCASCADE-valid | 516/517 (100%) |
| &nbsp;&nbsp;OCCT plain vs NURBS-converted volume integral differ by > 0.001 | 12 |
| converted to kernel (any route) | 516/517 (100%) |
| &nbsp;&nbsp;exact route / NURBS fallback | 507 / 9 |
| kernel: manifold solid | 516/517 (100%) |
| kernel: volume() within 0.001 of OpenCASCADE | 487/517 (94%) |
| kernel: tessellation volume within 1e-2 (diagnostic) | 484/516 (94%) |
| boolean: succeeds, manifold result | 495/516 (96%) |
| boolean: volume within 0.001 of OpenCASCADE cut | 466/516 (90%) |
| export: valid STEP solid | 507/516 (98%) |
| export: valid and volume within 0.001 | 492/516 (95%) |
| NVIDIA usd_to_occt: BRepCheck-valid (diagnostic) | 96/516 (19%) |
| NVIDIA usd_to_occt: BRepCheck crashes (diagnostic) | 20/516 (4%) |
| **parts passing every stage** | **471/517 (91%)** |

Kernel volume() vs OpenCASCADE (manifold parts):

| relative error | parts |
|---|---|
| [0, 1e-09) | 162 |
| [1e-09, 1e-06) | 241 |
| [1e-06, 0.0001) | 65 |
| [0.0001, 0.001) | 19 |
| [0.001, 0.01) | 5 |
| [0.01, inf) | 22 |

median 1.72e-08, p90 5.34e-05, max 4.06e+00

Wall time of finished files: median 6.3s, p90 37.0s, max 199.1s

| failure (first failing stage) | parts | example |
|---|---|---|
| file timeout during occt_to_usd | 160 | 00000000_290a9120f9f249a7a05cfe9c_step_000.step part 0 |
| input is a shell, not a solid (solid checks do not apply) | 32 | 00002150_4e2f76df96024d4894ad908f_step_000.step part 0 (exact) |
| kernel: volume() and tessellation differ from OpenCASCADE | 22 | 00000100_5ed74bccca6f4e89829bcb5e_step_000.step part 4 (exact) |
| kernel: volume() differs from OpenCASCADE, tessellation agrees | 7 | 00000950_15e59113d9e3449397e50508_step_000.step part 4 (exact) |
| boolean: volume differs from OpenCASCADE cut | 6 | 00000100_5ed74bccca6f4e89829bcb5e_step_000.step part 0 (nurbs) |
| boolean: result not manifold | 5 | 00000150_a951550b8a1043a68423c541_step_000.step part 7 (exact) |
| boolean: SmApiBooleanDifference failed: SM_ERR (N) at SmPyBooleans.cpp:N | 2 | 00004100_682d0d68eb404db58e39f511_step_013.step part 2 (exact) |
| export: OpenCASCADE BRepCheck invalid | 2 | 00004500_b35a02085832408da54244bd_step_000.step part 4 (exact) |
| convert: occt_to_usd failed: ERROR: topology resolve failed: face has no loops | 2 | 00009600_54473bbc37f74f2da23fa29f_step_000.step part 1 |
| convert: occt_to_usd failed: ERROR: staging failed: face N: multi-turn analytic U trim requires topology splitting | 1 | 00000450_705164f932024db5834f09a3_step_000.step part 1 |
| export: volume differs | 1 | 00006600_2516c959a43348f89c02cae9_step_000.step part 0 (exact) |
| file crash during boolean | 1 | 00009450_da3514d54f2642469a70d9ad_step_019.step part 0 (nurbs) |

## nist

| stage | pass |
|---|---|
| files | 33 |
| OpenCASCADE reads file | 33/33 (100%) |
| files finished within budget | 32/33 (97%) |
| &nbsp;&nbsp;timed out / crashed | 1 / 0 (273 parts) |
| **files whose every part passes every stage** | **27/33 (82%)** |
| solid parts in finished files | 32 (+0 shell-only parts, +0 beyond the 25-part cap) |
| parts OpenCASCADE-valid | 32/32 (100%) |
| &nbsp;&nbsp;OCCT plain vs NURBS-converted volume integral differ by > 0.001 | 0 |
| converted to kernel (any route) | 32/32 (100%) |
| &nbsp;&nbsp;exact route / NURBS fallback | 26 / 6 |
| kernel: manifold solid | 32/32 (100%) |
| kernel: volume() within 0.001 of OpenCASCADE | 27/32 (84%) |
| kernel: tessellation volume within 1e-2 (diagnostic) | 30/32 (94%) |
| boolean: succeeds, manifold result | 32/32 (100%) |
| boolean: volume within 0.001 of OpenCASCADE cut | 31/32 (97%) |
| export: valid STEP solid | 32/32 (100%) |
| export: valid and volume within 0.001 | 31/32 (97%) |
| NVIDIA usd_to_occt: BRepCheck-valid (diagnostic) | 1/32 (3%) |
| NVIDIA usd_to_occt: BRepCheck crashes (diagnostic) | 1/32 (3%) |
| **parts passing every stage** | **27/32 (84%)** |

Kernel volume() vs OpenCASCADE (manifold parts):

| relative error | parts |
|---|---|
| [0, 1e-09) | 2 |
| [1e-09, 1e-06) | 20 |
| [1e-06, 0.0001) | 5 |
| [0.0001, 0.001) | 0 |
| [0.001, 0.01) | 2 |
| [0.01, inf) | 3 |

median 3.59e-07, p90 4.64e-03, max 3.36e+01

Wall time of finished files: median 7.4s, p90 17.6s, max 26.7s

| failure (first failing stage) | parts | example |
|---|---|---|
| file timeout during occt_to_usd | 273 | nist_ftc_08_asme1_ap242-e1-tg.stp part 0 |
| kernel: volume() differs from OpenCASCADE, tessellation agrees | 3 | nist_ctc_04_asme1_ap242-e1.stp part 0 (nurbs) |
| kernel: volume() and tessellation differ from OpenCASCADE | 2 | nist_ctc_02_asme1_ap203.stp part 0 (exact) |

## ALL

| stage | pass |
|---|---|
| files | 233 |
| OpenCASCADE reads file | 233/233 (100%) |
| files finished within budget | 223/233 (96%) |
| &nbsp;&nbsp;timed out / crashed | 9 / 1 (434 parts) |
| **files whose every part passes every stage** | **185/233 (79%)** |
| solid parts in finished files | 549 (+34 shell-only parts, +654 beyond the 25-part cap) |
| parts OpenCASCADE-valid | 548/549 (100%) |
| &nbsp;&nbsp;OCCT plain vs NURBS-converted volume integral differ by > 0.001 | 12 |
| converted to kernel (any route) | 548/549 (100%) |
| &nbsp;&nbsp;exact route / NURBS fallback | 533 / 15 |
| kernel: manifold solid | 548/549 (100%) |
| kernel: volume() within 0.001 of OpenCASCADE | 514/549 (94%) |
| kernel: tessellation volume within 1e-2 (diagnostic) | 514/548 (94%) |
| boolean: succeeds, manifold result | 527/548 (96%) |
| boolean: volume within 0.001 of OpenCASCADE cut | 497/548 (91%) |
| export: valid STEP solid | 539/548 (98%) |
| export: valid and volume within 0.001 | 523/548 (95%) |
| NVIDIA usd_to_occt: BRepCheck-valid (diagnostic) | 97/548 (18%) |
| NVIDIA usd_to_occt: BRepCheck crashes (diagnostic) | 21/548 (4%) |
| **parts passing every stage** | **498/549 (91%)** |

Kernel volume() vs OpenCASCADE (manifold parts):

| relative error | parts |
|---|---|
| [0, 1e-09) | 164 |
| [1e-09, 1e-06) | 261 |
| [1e-06, 0.0001) | 70 |
| [0.0001, 0.001) | 19 |
| [0.001, 0.01) | 7 |
| [0.01, inf) | 25 |

median 1.94e-08, p90 7.82e-05, max 3.36e+01

Wall time of finished files: median 6.7s, p90 31.5s, max 199.1s

| failure (first failing stage) | parts | example |
|---|---|---|
| file timeout during occt_to_usd | 433 | 00000000_290a9120f9f249a7a05cfe9c_step_000.step part 0 |
| input is a shell, not a solid (solid checks do not apply) | 32 | 00002150_4e2f76df96024d4894ad908f_step_000.step part 0 (exact) |
| kernel: volume() and tessellation differ from OpenCASCADE | 24 | 00000100_5ed74bccca6f4e89829bcb5e_step_000.step part 4 (exact) |
| kernel: volume() differs from OpenCASCADE, tessellation agrees | 10 | 00000950_15e59113d9e3449397e50508_step_000.step part 4 (exact) |
| boolean: volume differs from OpenCASCADE cut | 6 | 00000100_5ed74bccca6f4e89829bcb5e_step_000.step part 0 (nurbs) |
| boolean: result not manifold | 5 | 00000150_a951550b8a1043a68423c541_step_000.step part 7 (exact) |
| boolean: SmApiBooleanDifference failed: SM_ERR (N) at SmPyBooleans.cpp:N | 2 | 00004100_682d0d68eb404db58e39f511_step_013.step part 2 (exact) |
| export: OpenCASCADE BRepCheck invalid | 2 | 00004500_b35a02085832408da54244bd_step_000.step part 4 (exact) |
| convert: occt_to_usd failed: ERROR: topology resolve failed: face has no loops | 2 | 00009600_54473bbc37f74f2da23fa29f_step_000.step part 1 |
| convert: occt_to_usd failed: ERROR: staging failed: face N: multi-turn analytic U trim requires topology splitting | 1 | 00000450_705164f932024db5834f09a3_step_000.step part 1 |
| export: volume differs | 1 | 00006600_2516c959a43348f89c02cae9_step_000.step part 0 (exact) |
| file crash during boolean | 1 | 00009450_da3514d54f2642469a70d9ad_step_019.step part 0 (nurbs) |

## Timed-out files rerun with a longer budget

| file | parts | stopped at (first run) | rerun result | rerun time | parts passing |
|---|---|---|---|---|---|
| abc/00000000_290a9120f9f249a7a05cfe9c_step_000.step | 6 | occt_to_usd part 5 (exact) | ok | 32s | 6/6 |
| abc/00000050_80d90bfdd2e74e709956122a_step_000.step | 3 | occt_to_usd part 1 (exact) | ok | 17s | 3/3 |
| abc/00000700_d689e97ffd2a49c6a0a4e5b7_step_000.step | 2 | occt_to_usd part 1 (nurbs) | ok | 784s | 1/2 |
| abc/00003500_86be4eefc6eb459e9a9370bc_step_004.step | 9 | occt_to_usd part 6 (exact) | ok | 72s | 8/9 |
| abc/00003600_91c7ddd4bf4641c69db65d2b_step_000.step | 20 | occt_to_usd part 16 (exact) | ok | 73s | 20/20 |
| abc/00003650_382d89806fbb4e0f97d95116_step_000.step | 6 | occt_to_usd part 5 (exact) | ok | 283s | 2/6 |
| abc/00007400_d681bb73885e41b39c681d22_step_037.step | 87 | occt_to_usd part 44 (exact) | ok | 120s | 25/87 |
| abc/00009850_0045691f85ae44199c9d706a_step_000.step | 27 | occt_to_usd part 7 (exact) | ok | 138s | 25/27 |
| nist/nist_ftc_08_asme1_ap242-e1-tg.stp | 273 | occt_to_usd part 13 (exact) | timeout at occt_to_usd part 114 (nurbs) | 1801s | 0/273 |

