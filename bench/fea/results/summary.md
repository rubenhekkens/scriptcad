# Voxel FEA: browser vs native

## cantilever, h = 1.0 mm, hex8i (36,300 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | tip deflection | bending stress, mid-span top layer |
|---|---:|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.2016 mm | 27 MPa |
| CPU, float64, AMG-CG (reference) | 15 | 1.30 | 86.61 | 4.5e-11 | 0.2 (-0.76%) | 27 (-0.00%) |
| RTX 5070 CUDA, float64, Jacobi-PCG | 600 | 0.09 | 0.15 | 6.1e-11 | 0.2 (-0.76%) | 27 (+0.00%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 1,175 | 0.14 | 0.12 | 4.2e-02 | 0.1919 (-4.79%) | 26.12 (-3.27%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 1,175 | 0.14 | 0.12 | 4.8e-04 | 0.1999 (-0.80%) | 26.99 (-0.04%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 1,175 | 0.22 | 0.19 | 4.8e-04 | 0.1999 (-0.80%) | 26.99 (-0.04%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 1,175 | 0.21 | 0.18 | 4.8e-04 | 0.1999 (-0.80%) | 26.99 (-0.03%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 35 | 0.18 | 5.24 | 6.9e-11 | 0.2 (-0.76%) | 27 (+0.00%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 25 | 0.07 | 2.74 | 4.7e-04 | 0.1999 (-0.80%) | 26.99 (-0.03%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 25 | 0.17 | 6.68 | 4.9e-04 | 0.1999 (-0.80%) | 26.99 (-0.04%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 25 | 0.24 | 9.54 | 4.7e-04 | 0.1999 (-0.80%) | 26.99 (-0.04%) |

## thin_cantilever, h = 1.0 mm, hex8 (2,250 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | tip deflection |
|---|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.3911 mm |
| CPU, float64, AMG-CG (reference) | 500 | — | — | 6e+10 | did not converge |
| RTX 5070 CUDA, float64, Jacobi-PCG | 675 | 0.06 | 0.09 | 3.8e-11 | 0.3419 (-12.57%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 1,750 | 0.24 | 0.14 | 4.6e-02 | 0.3572 (-8.68%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 1,700 | 0.13 | 0.08 | 1.0e-03 | 0.3423 (-12.49%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 1,700 | 0.26 | 0.15 | 1.0e-03 | 0.3423 (-12.48%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 1,650 | 0.26 | 0.16 | 9.9e-04 | 0.3423 (-12.49%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 45 | 0.18 | 3.91 | 2.7e-13 | 0.3419 (-12.57%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 30 | 0.07 | 2.24 | 8.9e-04 | 0.3422 (-12.50%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 30 | 0.17 | 5.61 | 9.4e-04 | 0.3423 (-12.49%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 30 | 0.24 | 7.94 | 1.1e-03 | 0.3423 (-12.48%) |

## thin_cantilever, h = 1.0 mm, hex8i (2,250 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | tip deflection |
|---|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.3911 mm |
| CPU, float64, AMG-CG (reference) | 20 | 0.05 | 2.69 | 4.5e-11 | 0.3882 (-0.74%) |
| RTX 5070 CUDA, float64, Jacobi-PCG | 725 | 0.07 | 0.10 | 4.6e-11 | 0.3882 (-0.74%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 1,600 | 0.12 | 0.07 | 6.5e-02 | 0.3637 (-7.01%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 1,575 | 0.13 | 0.08 | 1.5e-03 | 0.3876 (-0.89%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 1,725 | 0.30 | 0.18 | 1.5e-03 | 0.3876 (-0.89%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 1,825 | 0.28 | 0.15 | 1.5e-03 | 0.3876 (-0.89%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 60 | 0.24 | 4.01 | 3.7e-13 | 0.3882 (-0.74%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 40 | 0.09 | 2.22 | 1.3e-03 | 0.3877 (-0.87%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 40 | 0.23 | 5.64 | 1.4e-03 | 0.3877 (-0.88%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 45 | 0.33 | 7.23 | 1.5e-03 | 0.3876 (-0.89%) |

## thin_cantilever, h = 0.5 mm, hex8 (13,500 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | tip deflection |
|---|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.3911 mm |
| CPU, float64, AMG-CG (reference) | 16 | 0.95 | 59.36 | 1.1e-10 | 0.3759 (-3.90%) |
| RTX 5070 CUDA, float64, Jacobi-PCG | 1,325 | 0.14 | 0.10 | 1.6e-10 | 0.3759 (-3.90%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 3,525 | 0.32 | 0.09 | 2.4e-01 | 0.4642 (+18.69%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 3,575 | 0.31 | 0.09 | 2.2e-03 | 0.3767 (-3.70%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 3,475 | 0.58 | 0.17 | 2.2e-03 | 0.3767 (-3.70%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 3,500 | 0.55 | 0.16 | 2.2e-03 | 0.3767 (-3.70%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 45 | 0.20 | 4.44 | 1.2e-13 | 0.3759 (-3.90%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 35 | 0.09 | 2.54 | 2.2e-03 | 0.3767 (-3.70%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 35 | 0.17 | 4.89 | 2.1e-03 | 0.3766 (-3.70%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 35 | 0.27 | 7.79 | 2.1e-03 | 0.3766 (-3.70%) |

## thin_cantilever, h = 0.5 mm, hex8i (13,500 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | tip deflection |
|---|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.3911 mm |
| CPU, float64, AMG-CG (reference) | 16 | 1.07 | 67.11 | 1.5e-10 | 0.3887 (-0.62%) |
| RTX 5070 CUDA, float64, Jacobi-PCG | 1,350 | 0.14 | 0.10 | 3.6e-13 | 0.3887 (-0.62%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 3,400 | 0.30 | 0.09 | 2.1e-01 | 0.3084 (-21.14%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 3,550 | 0.32 | 0.09 | 2.9e-03 | 0.3876 (-0.91%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 3,525 | 1.38 | 0.39 | 2.9e-03 | 0.3876 (-0.91%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 3,525 | 0.55 | 0.15 | 2.9e-03 | 0.3876 (-0.91%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 60 | 0.27 | 4.56 | 1.9e-10 | 0.3887 (-0.62%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 40 | 0.11 | 2.80 | 3.0e-03 | 0.3875 (-0.91%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 45 | 0.24 | 5.33 | 3.0e-03 | 0.3875 (-0.91%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 45 | 0.37 | 8.22 | 2.8e-03 | 0.3876 (-0.89%) |

## thin_cantilever, h = 0.25 mm, hex8i (91,800 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | tip deflection |
|---|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.3911 mm |
| CPU, float64, AMG-CG (reference) | 23 | 4.04 | 175.49 | 2.4e-10 | 0.3889 (-0.56%) |
| RTX 5070 CUDA, float64, Jacobi-PCG | 2,800 | 0.65 | 0.23 | 7.7e-10 | 0.3889 (-0.56%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 6,600 | 0.63 | 0.10 | 5.2e-01 | 0.1928 (-50.69%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 7,175 | 0.74 | 0.10 | 5.8e-03 | 0.3867 (-1.12%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 7,125 | 1.39 | 0.19 | 5.8e-03 | 0.3867 (-1.12%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 6,925 | 2.49 | 0.36 | 5.8e-03 | 0.3867 (-1.12%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 60 | 0.32 | 5.25 | 9.8e-13 | 0.3889 (-0.56%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 45 | 0.12 | 2.65 | 5.8e-03 | 0.3867 (-1.12%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 45 | 0.29 | 6.45 | 5.9e-03 | 0.3867 (-1.13%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 45 | 0.39 | 8.74 | 5.9e-03 | 0.3867 (-1.13%) |

## tube_torsion, h = 0.5 mm, hex8i (669,600 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | twist at mid-length | shear stress at mid-length (mean) |
|---|---:|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.01953 deg | 7.136 MPa |
| RTX 5070 CUDA, float64, Jacobi-PCG | 1,375 | 7.97 | 5.79 | 1.2e-12 | 0.02002 (+2.49%) | 7.097 (-0.54%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 1,250 | 2.28 | 1.82 | 7.1e-04 | 0.02 (+2.41%) | 7.092 (-0.61%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 1,500 | 2.78 | 1.85 | 3.0e-05 | 0.02002 (+2.49%) | 7.097 (-0.54%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 1,275 | 1.29 | 1.01 | 3.1e-05 | 0.02002 (+2.49%) | 7.097 (-0.54%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 1,275 | 9.28 | 7.28 | 3.1e-05 | 0.02002 (+2.49%) | 7.097 (-0.54%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 80 | 2.81 | 35.14 | 4.5e-12 | 0.02002 (+2.49%) | 7.097 (-0.54%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 55 | 0.63 | 11.54 | 3.2e-05 | 0.02002 (+2.49%) | 7.097 (-0.54%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 55 | 0.56 | 10.24 | 3.2e-05 | 0.02002 (+2.49%) | 7.097 (-0.54%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 55 | 2.79 | 50.79 | 3.2e-05 | 0.02002 (+2.49%) | 7.097 (-0.54%) |

## lame_ring, h = 0.5 mm, hex8i (388,108 free DOF)

| Backend | Iterations | Solve s | ms/iter | Error vs float64 | radial growth of the bore | hoop stress, wall interior (mean) |
|---|---:|---:|---:|---:|---:|---:|
| *Analytic reference* | | | | | 0.02752 mm | 79.7 MPa |
| CPU, float64, AMG-CG (reference) | 23 | 20.40 | 887.00 | 4.2e-12 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| RTX 5070 CUDA, float64, Jacobi-PCG | 675 | 1.47 | 2.18 | 4.5e-13 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, plain K p | 525 | 0.30 | 0.57 | 9.5e-05 | 0.02806 (+1.94%) | 81.61 (+2.41%) |
| RTX 5070 CUDA, float32, Jacobi-PCG, relative K p | 525 | 0.36 | 0.68 | 7.6e-07 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| Browser WebGPU (Chrome 156, RTX 5070), float32, relative K p | 525 | 0.36 | 0.68 | 8.2e-07 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, relative K p | 525 | 1.47 | 2.80 | 7.6e-07 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| RTX 5070 CUDA, float64, **multigrid** MG-PCG | 45 | 0.73 | 16.31 | 8.6e-13 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| RTX 5070 CUDA, float32, **multigrid** MG-PCG, relative K p | 30 | 0.17 | 5.66 | 5.1e-07 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| Browser WebGPU (Chrome, RTX 5070), float32, **multigrid** MG-PCG | 30 | 0.22 | 7.29 | 5.3e-07 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
| Browser WebGPU (Intel Xe-LPG iGPU), float32, **multigrid** MG-PCG | 30 | 0.70 | 23.33 | 5.3e-07 | 0.02806 (+1.95%) | 81.62 (+2.42%) |
