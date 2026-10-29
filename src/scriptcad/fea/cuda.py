"""Native GPU solver: matrix-free Jacobi-PCG in NVIDIA Warp (CUDA), float32 or float64.

The operator is the same node-gather as the WGSL shader in web/fea/solver.js: one
thread per node, summing contributions from the up-to-8 voxels around it, so no
atomics and no assembled matrix. Scalars (alpha, beta, r.z) stay on the GPU; the
host only reads the residual every `check_every` iterations, as the browser does.
"""

# no `from __future__ import annotations`: Warp evaluates kernel annotations itself

import time

import numpy as np
import warp as wp

wp.config.quiet = True
_KERNELS = {}


def _kernels(dtype):
    if dtype in _KERNELS:
        return _KERNELS[dtype]
    F = dtype

    @wp.kernel(module="unique")
    def apply_k(u: wp.array(dtype=F), emod: wp.array(dtype=F), ke: wp.array(dtype=F),
                fixed: wp.array(dtype=wp.uint8), out: wp.array(dtype=F), nx: int, ny: int, nz: int, rel: int):
        n = wp.tid()
        nnx = nx + 1
        nny = ny + 1
        I = n % nnx
        J = (n // nnx) % nny
        K = n // (nnx * nny)
        ax = F(0.0)
        ay = F(0.0)
        az = F(0.0)
        for a in range(8):
            di = a & 1
            dj = (a >> 1) & 1
            dk = (a >> 2) & 1
            ei = I - di
            ej = J - dj
            ek = K - dk
            if ei >= 0 and ej >= 0 and ek >= 0 and ei < nx and ej < ny and ek < nz:
                e = emod[ei + nx * (ej + ny * ek)]
                if e != F(0.0):
                    m0 = ei + nnx * (ej + nny * ek)
                    bx = F(0.0)
                    by = F(0.0)
                    bz = F(0.0)
                    if rel != 0:
                        # KE annihilates rigid translation, so K(u - u0) = K u exactly,
                        # but the small differences cancel far less in float32
                        bx = u[3 * m0]
                        by = u[3 * m0 + 1]
                        bz = u[3 * m0 + 2]
                    sx = F(0.0)
                    sy = F(0.0)
                    sz = F(0.0)
                    for b in range(8):
                        m = (ei + (b & 1)) + nnx * ((ej + ((b >> 1) & 1)) + nny * (ek + ((b >> 2) & 1)))
                        px = u[3 * m] - bx
                        py = u[3 * m + 1] - by
                        pz = u[3 * m + 2] - bz
                        r0 = (3 * a) * 24 + 3 * b
                        sx += ke[r0] * px + ke[r0 + 1] * py + ke[r0 + 2] * pz
                        sy += ke[r0 + 24] * px + ke[r0 + 25] * py + ke[r0 + 26] * pz
                        sz += ke[r0 + 48] * px + ke[r0 + 49] * py + ke[r0 + 50] * pz
                    ax += e * sx
                    ay += e * sy
                    az += e * sz
        out[3 * n] = wp.where(fixed[3 * n] == wp.uint8(0), ax, F(0.0))
        out[3 * n + 1] = wp.where(fixed[3 * n + 1] == wp.uint8(0), ay, F(0.0))
        out[3 * n + 2] = wp.where(fixed[3 * n + 2] == wp.uint8(0), az, F(0.0))

    CHUNK = 64

    @wp.kernel(module="unique")
    def dot(a: wp.array(dtype=F), b: wp.array(dtype=F), out: wp.array(dtype=F), slot: int, n: int):
        t = wp.tid()
        s = F(0.0)
        for k in range(CHUNK):
            i = t * CHUNK + k
            if i < n:
                s += a[i] * b[i]
        wp.atomic_add(out, slot, s)

    @wp.kernel(module="unique")
    def update_ur(u: wp.array(dtype=F), r: wp.array(dtype=F), p: wp.array(dtype=F), ap: wp.array(dtype=F),
                  dinv: wp.array(dtype=F), z: wp.array(dtype=F), sc: wp.array(dtype=F)):
        i = wp.tid()
        alpha = sc[0] / sc[1]              # rz / pAp
        u[i] = u[i] + alpha * p[i]
        ri = r[i] - alpha * ap[i]
        r[i] = ri
        z[i] = dinv[i] * ri

    @wp.kernel(module="unique")
    def update_p(p: wp.array(dtype=F), z: wp.array(dtype=F), sc: wp.array(dtype=F)):
        i = wp.tid()
        beta = sc[2] / sc[0]               # rz_new / rz
        p[i] = z[i] + beta * p[i]

    @wp.kernel(module="unique")
    def roll(sc: wp.array(dtype=F)):
        sc[0] = sc[2]                       # rz <- rz_new
        sc[1] = F(0.0)
        sc[2] = F(0.0)
        sc[3] = F(0.0)

    _KERNELS[dtype] = (apply_k, dot, update_ur, update_p, roll, CHUNK)
    return _KERNELS[dtype]


def pcg(prob, tol=1e-6, max_iter=20000, dtype="float32", check_every=25, device="cuda:0", rhs=None, rel=False):
    """Solve K u = f (or K u = rhs) on the GPU. Returns (u float64 numpy, info)."""
    from .cpu import diagonal
    wp.init()
    F = wp.float32 if dtype == "float32" else wp.float64
    npf = np.float32 if dtype == "float32" else np.float64
    apply_k, dot, update_ur, update_p, roll, chunk = _kernels(F)
    n = prob.n_dofs
    nn = prob.n_nodes
    nx, ny, nz = prob.shape
    free = prob.fixed == 0
    d = diagonal(prob)
    dinv_h = np.where(free, 1.0 / np.where(free, d, 1.0), 0.0).astype(npf)
    f_h = np.where(free, prob.force if rhs is None else rhs, 0.0).astype(npf)

    # compile/load outside the timed region (first build of apply_k takes ~1-2 min, then cached)
    t_c = time.perf_counter()
    for k in (apply_k, dot, update_ur, update_p, roll):
        wp.load_module(k.module, device=device)
    compile_s = time.perf_counter() - t_c

    t_up = time.perf_counter()
    emod = wp.array(prob.emod.astype(npf), dtype=F, device=device)
    ke = wp.array(prob.ke().ravel().astype(npf), dtype=F, device=device)
    fixed = wp.array(prob.fixed.astype(np.uint8), dtype=wp.uint8, device=device)
    dinv = wp.array(dinv_h, dtype=F, device=device)
    u = wp.zeros(n, dtype=F, device=device)
    r = wp.array(f_h, dtype=F, device=device)
    z = wp.array(dinv_h * f_h, dtype=F, device=device)
    p = wp.array(dinv_h * f_h, dtype=F, device=device)
    ap = wp.zeros(n, dtype=F, device=device)
    sc = wp.zeros(4, dtype=F, device=device)          # rz, pAp, rz_new, rr
    nd = (n + chunk - 1) // chunk
    wp.launch(dot, nd, [r, z, sc, 0, n], device=device)
    fnorm = float(np.linalg.norm(f_h.astype(np.float64)))
    wp.synchronize_device(device)
    t0 = time.perf_counter()

    it, res, hist = 0, 1.0, []
    while it < max_iter:
        wp.launch(apply_k, nn, [p, emod, ke, fixed, ap, nx, ny, nz, int(rel)], device=device)
        wp.launch(dot, nd, [p, ap, sc, 1, n], device=device)
        wp.launch(update_ur, n, [u, r, p, ap, dinv, z, sc], device=device)
        wp.launch(dot, nd, [r, z, sc, 2, n], device=device)
        it += 1
        if it % check_every == 0:
            wp.launch(dot, nd, [r, r, sc, 3, n], device=device)
            res = float(np.sqrt(max(sc.numpy()[3], 0.0))) / fnorm
            hist.append((it, res))
            if res < tol:
                break
        wp.launch(update_p, n, [p, z, sc], device=device)
        wp.launch(roll, 1, [sc], device=device)
    wp.synchronize_device(device)
    t1 = time.perf_counter()
    u_h = u.numpy().astype(np.float64)
    return u_h, {"iterations": it, "rel_residual": res, "seconds": t1 - t0, "upload_seconds": t0 - t_up, "compile_seconds": compile_s,
                 "ms_per_iteration": 1000 * (t1 - t0) / max(it, 1), "history": hist,
                 "backend": f"cuda-warp-{dtype}{'-rel' if rel else ''}", "device": wp.get_device(device).name}


def apply_k_gpu(prob, u, dtype="float32", device="cuda:0", rel=False):
    """K u with the GPU operator in the given precision (fixed DOFs zeroed)."""
    F = wp.float32 if dtype == "float32" else wp.float64
    npf = np.float32 if dtype == "float32" else np.float64
    apply_k = _kernels(F)[0]
    out = wp.zeros(prob.n_dofs, dtype=F, device=device)
    wp.launch(apply_k, prob.n_nodes, [wp.array(u.astype(npf), dtype=F, device=device),
              wp.array(prob.emod.astype(npf), dtype=F, device=device),
              wp.array(prob.ke().ravel().astype(npf), dtype=F, device=device),
              wp.array(prob.fixed.astype(np.uint8), dtype=wp.uint8, device=device), out, *prob.shape, int(rel)],
              device=device)
    return out.numpy().astype(np.float64)


def refined(prob, outer="float64", tol=1e-7, inner_tol=1e-3, max_outer=30, device="cuda:0", rel=False):
    """Mixed-precision iterative refinement: float32 PCG corrections, true residual in `outer`.

    outer="float64": the residual f - K u is formed in double (what a native code can do).
    outer="float32": formed with the float32 GPU operator and float32 u (all a browser has).
    """
    t0 = time.perf_counter()
    free = prob.fixed == 0
    f = np.where(free, prob.force, 0.0)
    fn = np.linalg.norm(f)
    u = np.zeros(prob.n_dofs, dtype=np.float32 if outer == "float32" else np.float64)
    total_it, hist = 0, []
    for k in range(max_outer):
        if outer == "float64":
            from .cpu import apply_k
            ku = apply_k(prob, u)
        else:
            ku = apply_k_gpu(prob, u.astype(np.float32), "float32", device, rel=rel)
        r = np.where(free, f - ku, 0.0)
        res = float(np.linalg.norm(r) / fn)
        hist.append((total_it, res))
        if res < tol:
            break
        d, info = pcg(prob, tol=inner_tol, dtype="float32", device=device, rhs=r, rel=rel)
        total_it += info["iterations"]
        u = (u + d).astype(u.dtype)
    return np.asarray(u, dtype=np.float64), {"iterations": total_it, "outer": k + 1, "rel_residual": res,
                                              "seconds": time.perf_counter() - t0, "history": hist,
                                              "backend": f"cuda-warp-float32-refined-{outer}{'-rel' if rel else ''}"}
