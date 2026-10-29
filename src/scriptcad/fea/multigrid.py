"""Geometric multigrid preconditioner for the voxel solver (MG-PCG), NVIDIA Warp backend.

The algorithm is the one in web/fea/multigrid.js (WebGPU), step for step:

* **Hierarchy.** Each level halves the voxel grid (2x2x2 children -> 1 coarse voxel, odd
  sizes padded with void). Coarse E from the children: ``"average"`` (volume average,
  void counts as 0, so a thin wall survives as a soft, thicker wall) or ``"majority"``
  (solid if >= 4 of 8 children are, with their mean E; thin walls can vanish). The coarse
  operator is *rediscretised*: the same KE scaled by the coarse h, not a Galerkin product.
  A coarse DOF is held if any active, held fine DOF of the same component lies in the
  support of its prolongation stencil, plus every DOF of a node no coarse voxel touches.
  Coarsening stops when the coarse level has <= ``coarse_dofs`` free DOFs, or when it
  would lose connectivity (more face-connected solid pieces, or a piece with no support).
* **Transfer.** Trilinear prolongation (fine node = weighted mean of its <= 8 coarse
  neighbours), zeroed on held fine DOFs; restriction is its exact transpose.
* **Smoother.** ``nu`` pre and ``nu`` post steps of Chebyshev (default) or damped
  Jacobi, both in the form d = c1 d + c2 D^-1 r, x += d, r -= K d with host-side
  coefficients. The spectral bound comes for free: lambda_max(D^-1 K) <=
  lambda_max(diag(KE)^-1 KE), one constant for the whole hierarchy (E and h cancel).
* **Coarsest level.** ``coarse_iters`` Jacobi-PCG iterations from zero, no readback.
* **Outer solver.** Flexible PCG (Polak-Ribiere beta), because a fixed number of inner CG
  iterations is not a linear operator. Translation-relative K p on every level.

On CUDA one whole outer iteration (K p, dots, the full V-cycle with its inner CG) is
captured once as a CUDA graph and replayed, so the hundreds of small coarse-level
launches cost almost nothing on the host.
"""

# no `from __future__ import annotations`: Warp evaluates kernel annotations itself

import time

import numpy as np
import warp as wp

from .grid import Problem

wp.config.quiet = True
_KERNELS = {}


# --------------------------------------------------------------------------- #
# hierarchy (host, NumPy)
# --------------------------------------------------------------------------- #

def coarsen(prob, rule="average"):
    """The next-coarser Problem: 2x voxel, coarse E by `rule`, supports by stencil overlap."""
    nx, ny, nz = prob.shape
    cx, cy, cz = (nx + 1) // 2, (ny + 1) // 2, (nz + 1) // 2
    e = np.zeros((2 * cz, 2 * cy, 2 * cx))
    e[:nz, :ny, :nx] = prob.emod.reshape(nz, ny, nx)
    blk = e.reshape(cz, 2, cy, 2, cx, 2)
    if rule == "average":
        ec = blk.sum(axis=(1, 3, 5)) / 8
    elif rule == "majority":
        n = (blk > 0).sum(axis=(1, 3, 5))
        ec = np.where(n >= 4, blk.sum(axis=(1, 3, 5)) / np.maximum(n, 1), 0.0)
    else:
        raise ValueError(f"unknown coarsening rule {rule!r}")
    held = (prob.fixed.reshape(-1, 3) == 1) & prob.active_nodes()[:, None]
    pad = np.zeros((2 * cz + 3, 2 * cy + 3, 2 * cx + 3, 3), dtype=bool)
    pad[1:nz + 2, 1:ny + 2, 1:nx + 2] = held.reshape(nz + 1, ny + 1, nx + 1, 3)
    fc = np.zeros((cz + 1, cy + 1, cx + 1, 3), dtype=bool)
    for dk in range(3):
        for dj in range(3):
            for di in range(3):
                fc |= pad[dk:dk + 2 * cz + 1:2, dj:dj + 2 * cy + 1:2, di:di + 2 * cx + 1:2]
    return Problem((cx, cy, cz), 2 * prob.h, prob.origin, ec.ravel(), prob.nu, prob.formulation,
                   fixed=fc.ravel().astype(np.uint8), name=f"{prob.name}/2")


def connectivity(prob):
    """(face-connected solid pieces, pieces touching no held DOF, solid volume mm^3)."""
    from scipy import ndimage
    nx, ny, nz = prob.shape
    solid = prob.emod > 0
    lab, n = ndimage.label(solid.reshape(nz, ny, nx))
    lab = lab.ravel()
    held = (prob.fixed.reshape(-1, 3) == 1).any(1) & prob.active_nodes()
    touch = held[prob.element_nodes()].any(1) & solid
    anchored = np.bincount(lab[touch], minlength=n + 1)[1:] > 0
    vol = float(prob.emod.sum() / max(prob.emod.max(), 1e-300)) * prob.h ** 3 if solid.any() else 0.0
    return int(n), int((~anchored).sum()), vol


def hierarchy(prob, rule="average", coarse_dofs=200, max_levels=12):
    """Levels [fine, ..., coarsest] and a per-level description."""
    levels = [prob]
    pieces, floating, vol = connectivity(prob)
    desc = [{"shape": list(prob.shape), "h": prob.h, "free_dofs": int((prob.fixed == 0).sum()),
             "pieces": pieces, "floating": floating, "stiff_volume": vol}]
    stop = "max_levels"
    while len(levels) < max_levels:
        p = levels[-1]
        if desc[-1]["free_dofs"] <= coarse_dofs:
            stop = "small enough"
            break
        if min(p.shape) < 2 and max(p.shape) < 2:
            stop = "single voxel"
            break
        c = coarsen(p, rule)
        pc, fc, vc = connectivity(c)
        if pc > pieces or fc > floating:
            stop = f"connectivity lost at h={c.h:g} ({pc} pieces, {fc} floating)"
            break
        levels.append(c)
        desc.append({"shape": list(c.shape), "h": c.h, "free_dofs": int((c.fixed == 0).sum()),
                     "pieces": pc, "floating": fc, "stiff_volume": vc})
    return levels, desc, stop


def spectral_bound(prob):
    """lambda_max(diag(KE)^-1 KE): an upper bound on lambda_max(D^-1 K) on every level."""
    ke = prob.ke()
    s = 1 / np.sqrt(np.diag(ke))
    return float(np.linalg.eigvalsh(ke * s[:, None] * s[None, :]).max())


def smoother_coefficients(lmax, nu=2, smoother="chebyshev", ratio=8.0, omega=None):
    """[(c1, c2)] per step of d = c1 d + c2 D^-1 r; x += d; r -= K d."""
    if smoother == "jacobi":
        w = (omega if omega is not None else 2.0 / (1 + 1 / ratio)) / lmax
        return [(0.0, w)] * nu
    if smoother != "chebyshev":
        raise ValueError(f"unknown smoother {smoother!r}")
    lmin = lmax / ratio
    theta, delta = (lmax + lmin) / 2, (lmax - lmin) / 2
    sigma = theta / delta
    rho = 1 / sigma
    out = [(0.0, 1 / theta)]
    for _ in range(nu - 1):
        rho_new = 1 / (2 * sigma - rho)
        out.append((rho_new * rho, 2 * rho_new / delta))
        rho = rho_new
    return out


# --------------------------------------------------------------------------- #
# kernels
# --------------------------------------------------------------------------- #

def _kernels(dtype):
    if dtype in _KERNELS:
        return _KERNELS[dtype]
    F = dtype

    @wp.kernel(module="unique")
    def mg_apply(p: wp.array(dtype=F), emod: wp.array(dtype=F), ke: wp.array(dtype=F),
                 fixed: wp.array(dtype=wp.uint8), y: wp.array(dtype=F), out: wp.array(dtype=F),
                 nx: int, ny: int, nz: int, sub: int):
        # out = K p (sub = 0) or y - K p (sub = 1), translation-relative per voxel; out may alias y
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
            ei = I - (a & 1)
            ej = J - ((a >> 1) & 1)
            ek = K - ((a >> 2) & 1)
            if ei >= 0 and ej >= 0 and ek >= 0 and ei < nx and ej < ny and ek < nz:
                e = emod[ei + nx * (ej + ny * ek)]
                if e != F(0.0):
                    m0 = ei + nnx * (ej + nny * ek)
                    bx = p[3 * m0]
                    by = p[3 * m0 + 1]
                    bz = p[3 * m0 + 2]
                    sx = F(0.0)
                    sy = F(0.0)
                    sz = F(0.0)
                    for b in range(8):
                        m = (ei + (b & 1)) + nnx * ((ej + ((b >> 1) & 1)) + nny * (ek + ((b >> 2) & 1)))
                        px = p[3 * m] - bx
                        py = p[3 * m + 1] - by
                        pz = p[3 * m + 2] - bz
                        r0 = (3 * a) * 24 + 3 * b
                        sx += ke[r0] * px + ke[r0 + 1] * py + ke[r0 + 2] * pz
                        sy += ke[r0 + 24] * px + ke[r0 + 25] * py + ke[r0 + 26] * pz
                        sz += ke[r0 + 48] * px + ke[r0 + 49] * py + ke[r0 + 50] * pz
                    ax += e * sx
                    ay += e * sy
                    az += e * sz
        if sub != 0:
            ax = y[3 * n] - ax
            ay = y[3 * n + 1] - ay
            az = y[3 * n + 2] - az
        out[3 * n] = wp.where(fixed[3 * n] == wp.uint8(0), ax, F(0.0))
        out[3 * n + 1] = wp.where(fixed[3 * n + 1] == wp.uint8(0), ay, F(0.0))
        out[3 * n + 2] = wp.where(fixed[3 * n + 2] == wp.uint8(0), az, F(0.0))

    @wp.kernel(module="unique")
    def smooth(d: wp.array(dtype=F), x: wp.array(dtype=F), r: wp.array(dtype=F), dinv: wp.array(dtype=F),
               c1: F, c2: F, assign: int):
        i = wp.tid()
        di = c2 * dinv[i] * r[i]
        if c1 != F(0.0):
            di += c1 * d[i]
        d[i] = di
        if assign != 0:
            x[i] = di
        else:
            x[i] = x[i] + di

    @wp.kernel(module="unique")
    def restrict(rf: wp.array(dtype=F), bc: wp.array(dtype=F), fixed_c: wp.array(dtype=wp.uint8),
                 nxf: int, nyf: int, nzf: int, nxc: int, nyc: int):
        # coarse node gathers the fine residual over its 3x3x3 trilinear stencil (P^T)
        N = wp.tid()
        I = N % (nxc + 1)
        J = (N // (nxc + 1)) % (nyc + 1)
        K = N // ((nxc + 1) * (nyc + 1))
        sx = F(0.0)
        sy = F(0.0)
        sz = F(0.0)
        for dk in range(3):
            k = 2 * K + dk - 1
            if k >= 0 and k <= nzf:
                wk = wp.where(dk == 1, F(1.0), F(0.5))
                for dj in range(3):
                    j = 2 * J + dj - 1
                    if j >= 0 and j <= nyf:
                        wj = wp.where(dj == 1, wk, F(0.5) * wk)
                        for di in range(3):
                            i = 2 * I + di - 1
                            if i >= 0 and i <= nxf:
                                w = wp.where(di == 1, wj, F(0.5) * wj)
                                m = i + (nxf + 1) * (j + (nyf + 1) * k)
                                sx += w * rf[3 * m]
                                sy += w * rf[3 * m + 1]
                                sz += w * rf[3 * m + 2]
        bc[3 * N] = wp.where(fixed_c[3 * N] == wp.uint8(0), sx, F(0.0))
        bc[3 * N + 1] = wp.where(fixed_c[3 * N + 1] == wp.uint8(0), sy, F(0.0))
        bc[3 * N + 2] = wp.where(fixed_c[3 * N + 2] == wp.uint8(0), sz, F(0.0))

    @wp.kernel(module="unique")
    def prolong(xc: wp.array(dtype=F), e: wp.array(dtype=F), x: wp.array(dtype=F), fixed_f: wp.array(dtype=wp.uint8),
                nxf: int, nyf: int, nxc: int, nyc: int):
        # e = P xc (trilinear, zero on held fine DOFs); x += e
        n = wp.tid()
        I = n % (nxf + 1)
        J = (n // (nxf + 1)) % (nyf + 1)
        K = n // ((nxf + 1) * (nyf + 1))
        sx = F(0.0)
        sy = F(0.0)
        sz = F(0.0)
        for c in range(8):
            oi = c & 1
            oj = (c >> 1) & 1
            ok = (c >> 2) & 1
            # an even fine index sits on a coarse node (weight 1, no second neighbour)
            if (oi == 0 or (I & 1) == 1) and (oj == 0 or (J & 1) == 1) and (ok == 0 or (K & 1) == 1):
                w = wp.where((I & 1) == 1, F(0.5), F(1.0)) * wp.where((J & 1) == 1, F(0.5), F(1.0)) \
                    * wp.where((K & 1) == 1, F(0.5), F(1.0))
                m = (I // 2 + oi) + (nxc + 1) * ((J // 2 + oj) + (nyc + 1) * (K // 2 + ok))
                sx += w * xc[3 * m]
                sy += w * xc[3 * m + 1]
                sz += w * xc[3 * m + 2]
        ex = wp.where(fixed_f[3 * n] == wp.uint8(0), sx, F(0.0))
        ey = wp.where(fixed_f[3 * n + 1] == wp.uint8(0), sy, F(0.0))
        ez = wp.where(fixed_f[3 * n + 2] == wp.uint8(0), sz, F(0.0))
        e[3 * n] = ex
        e[3 * n + 1] = ey
        e[3 * n + 2] = ez
        x[3 * n] = x[3 * n] + ex
        x[3 * n + 1] = x[3 * n + 1] + ey
        x[3 * n + 2] = x[3 * n + 2] + ez

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
    def zero(sc: wp.array(dtype=F)):
        sc[wp.tid()] = F(0.0)

    @wp.kernel(module="unique")
    def roll(sc: wp.array(dtype=F)):
        sc[0] = sc[2]                       # rz <- rz_new, clear the accumulators
        for k in range(1, 8):
            sc[k] = F(0.0)

    # coarsest level: plain Jacobi-PCG, fixed iteration count (sc: rz, pAp, rz_new)
    @wp.kernel(module="unique")
    def cg_init(b: wp.array(dtype=F), x: wp.array(dtype=F), r: wp.array(dtype=F), z: wp.array(dtype=F),
                p: wp.array(dtype=F), dinv: wp.array(dtype=F)):
        i = wp.tid()
        x[i] = F(0.0)
        r[i] = b[i]
        zi = dinv[i] * b[i]
        z[i] = zi
        p[i] = zi

    @wp.kernel(module="unique")
    def cg_xr(x: wp.array(dtype=F), r: wp.array(dtype=F), p: wp.array(dtype=F), ap: wp.array(dtype=F),
              dinv: wp.array(dtype=F), z: wp.array(dtype=F), sc: wp.array(dtype=F)):
        i = wp.tid()
        alpha = wp.where(sc[1] > F(0.0), sc[0] / sc[1], F(0.0))
        x[i] = x[i] + alpha * p[i]
        ri = r[i] - alpha * ap[i]
        r[i] = ri
        z[i] = dinv[i] * ri

    @wp.kernel(module="unique")
    def cg_p(p: wp.array(dtype=F), z: wp.array(dtype=F), sc: wp.array(dtype=F)):
        i = wp.tid()
        beta = wp.where(sc[0] > F(0.0), sc[2] / sc[0], F(0.0))
        p[i] = z[i] + beta * p[i]

    # outer flexible PCG (sc: rz, pAp, rz_new, rr, r_old.z)
    @wp.kernel(module="unique")
    def fcg_ur(u: wp.array(dtype=F), r: wp.array(dtype=F), rold: wp.array(dtype=F), p: wp.array(dtype=F),
               ap: wp.array(dtype=F), sc: wp.array(dtype=F)):
        i = wp.tid()
        alpha = wp.where(sc[1] > F(0.0), sc[0] / sc[1], F(0.0))
        u[i] = u[i] + alpha * p[i]
        ri = r[i]
        rold[i] = ri
        r[i] = ri - alpha * ap[i]

    @wp.kernel(module="unique")
    def fcg_p(p: wp.array(dtype=F), z: wp.array(dtype=F), sc: wp.array(dtype=F)):
        i = wp.tid()
        beta = wp.where(sc[0] > F(0.0), (sc[2] - sc[4]) / sc[0], F(0.0))
        p[i] = z[i] + beta * p[i]

    k = dict(mg_apply=mg_apply, smooth=smooth, restrict=restrict, prolong=prolong, dot=dot, zero=zero, roll=roll,
             cg_init=cg_init, cg_xr=cg_xr, cg_p=cg_p, fcg_ur=fcg_ur, fcg_p=fcg_p, CHUNK=CHUNK)
    _KERNELS[dtype] = k
    return k


# --------------------------------------------------------------------------- #
# solver
# --------------------------------------------------------------------------- #

class _Level:
    def __init__(self, prob, F, npf, device):
        from .cpu import diagonal
        self.prob = prob
        self.shape = prob.shape
        self.nn = prob.n_nodes
        self.n = prob.n_dofs
        free = prob.fixed == 0
        d = diagonal(prob)
        self.dinv = wp.array(np.where(free, 1.0 / np.where(free & (d > 0), d, 1.0), 0.0).astype(npf), dtype=F, device=device)
        self.emod = wp.array(prob.emod.astype(npf), dtype=F, device=device)
        self.ke = wp.array(prob.ke().ravel().astype(npf), dtype=F, device=device)
        self.fixed = wp.array(prob.fixed.astype(np.uint8), dtype=wp.uint8, device=device)
        z = lambda: wp.zeros(self.n, dtype=F, device=device)
        self.x, self.r, self.b, self.d, self.e = z(), z(), z(), z(), z()


class MGPreconditioner:
    """z = M r by one V-cycle. Records launches only; replay inside a CUDA graph for speed."""

    def __init__(self, prob, dtype="float32", device="cuda:0", rule="average", nu=2, smoother="chebyshev",
                 ratio=8.0, omega=None, coarse_dofs=200, coarse_iters=100, max_levels=12):
        self.F = wp.float32 if dtype == "float32" else wp.float64
        npf = np.float32 if dtype == "float32" else np.float64
        self.K = _kernels(self.F)
        self.device = device
        probs, self.desc, self.stop = hierarchy(prob, rule, coarse_dofs, max_levels)
        self.levels = [_Level(p, self.F, npf, device) for p in probs]
        self.lmax = spectral_bound(prob)
        self.coef = smoother_coefficients(self.lmax, nu, smoother, ratio, omega)
        self.coarse_iters = coarse_iters
        self.sc = wp.zeros(8, dtype=self.F, device=device)
        self.settings = dict(rule=rule, nu=nu, smoother=smoother, ratio=ratio, omega=omega, coarse_dofs=coarse_dofs,
                             coarse_iters=coarse_iters, lmax_bound=self.lmax)

    def _launch(self, name, dim, args):
        wp.launch(self.K[name], dim, args, device=self.device)

    def _apply(self, L, p, y, out, sub):
        self._launch("mg_apply", L.nn, [p, L.emod, L.ke, L.fixed, y, out, *L.shape, sub])

    def _dot(self, a, b, slot, n):
        self._launch("dot", (n + self.K["CHUNK"] - 1) // self.K["CHUNK"], [a, b, self.sc, slot, n])

    def _coarse(self, L):
        # x, r, z = d, p = e, ap = b (b is consumed by cg_init)
        self._launch("cg_init", L.n, [L.b, L.x, L.r, L.d, L.e, L.dinv])
        self._launch("zero", 8, [self.sc])
        self._dot(L.r, L.d, 0, L.n)
        for _ in range(self.coarse_iters):
            self._apply(L, L.e, L.b, L.b, 0)
            self._dot(L.e, L.b, 1, L.n)
            self._launch("cg_xr", L.n, [L.x, L.r, L.e, L.b, L.dinv, L.d, self.sc])
            self._dot(L.r, L.d, 2, L.n)
            self._launch("cg_p", L.n, [L.e, L.d, self.sc])
            self._launch("roll", 1, [self.sc])

    def _cycle(self, l, b, x):
        L = self.levels[l]
        if l == len(self.levels) - 1:
            if b is not L.b:
                wp.copy(L.b, b)
            self._coarse(L)
            if x is not L.x:
                wp.copy(x, L.x)
            return
        C = self.levels[l + 1]
        for s, (c1, c2) in enumerate(self.coef):
            if s == 0:
                self._launch("smooth", L.n, [L.d, x, b, L.dinv, 0.0, c2, 1])
                self._apply(L, L.d, b, L.r, 1)
            else:
                self._launch("smooth", L.n, [L.d, x, L.r, L.dinv, c1, c2, 0])
                self._apply(L, L.d, L.r, L.r, 1)
        nxf, nyf, nzf = L.shape
        nxc, nyc, _ = C.shape
        self._launch("restrict", C.nn, [L.r, C.b, C.fixed, nxf, nyf, nzf, nxc, nyc])
        self._cycle(l + 1, C.b, C.x)
        self._launch("prolong", L.nn, [C.x, L.e, x, L.fixed, nxf, nyf, nxc, nyc])
        self._apply(L, L.e, L.r, L.r, 1)
        for s, (c1, c2) in enumerate(self.coef):
            self._launch("smooth", L.n, [L.d, x, L.r, L.dinv, c1 if s else 0.0, c2, 0])
            if s < len(self.coef) - 1:
                self._apply(L, L.d, L.r, L.r, 1)

    def __call__(self, r, z):
        """Record z = M r (r is left unchanged)."""
        self._cycle(0, r, z)


def pcg(prob, tol=1e-6, max_iter=2000, dtype="float32", check_every=5, device="cuda:0", rhs=None,
        graph=True, **mg):
    """MG-preconditioned flexible CG on the GPU. Returns (u float64 numpy, info)."""
    wp.init()
    F = wp.float32 if dtype == "float32" else wp.float64
    npf = np.float32 if dtype == "float32" else np.float64
    K = _kernels(F)
    t_c = time.perf_counter()
    for k in K.values():
        if not isinstance(k, int):
            wp.load_module(k.module, device=device)
    compile_s = time.perf_counter() - t_c

    t_up = time.perf_counter()
    M = MGPreconditioner(prob, dtype, device, **mg)
    L0 = M.levels[0]
    n, free = prob.n_dofs, prob.fixed == 0
    f_h = np.where(free, prob.force if rhs is None else rhs, 0.0).astype(npf)
    fnorm = float(np.linalg.norm(f_h.astype(np.float64)))
    u = wp.zeros(n, dtype=F, device=device)
    r = wp.array(f_h, dtype=F, device=device)
    rold, z, p, ap = (wp.zeros(n, dtype=F, device=device) for _ in range(4))
    sc = wp.zeros(8, dtype=F, device=device)               # rz, pAp, rz_new, rr, rold.z
    nd = (n + K["CHUNK"] - 1) // K["CHUNK"]

    def dot(a, b, slot):
        wp.launch(K["dot"], nd, [a, b, sc, slot, n], device=device)

    def step():
        wp.launch(K["mg_apply"], L0.nn, [p, L0.emod, L0.ke, L0.fixed, ap, ap, *L0.shape, 0], device=device)
        dot(p, ap, 1)
        wp.launch(K["fcg_ur"], n, [u, r, rold, p, ap, sc], device=device)
        M(r, z)
        dot(r, z, 2)
        dot(rold, z, 4)
        wp.launch(K["fcg_p"], n, [p, z, sc], device=device)
        wp.launch(K["roll"], 1, [sc], device=device)

    g = None
    if graph:
        # capture on scratch state, then reset: the capture itself executes nothing
        with wp.ScopedCapture(device=device) as cap:
            step()
        g = cap.graph
    wp.synchronize_device(device)
    t0 = time.perf_counter()
    M(r, z)
    wp.copy(p, z)
    dot(r, z, 0)
    it, res, hist = 0, 1.0, []
    while it < max_iter:
        if g is not None:
            wp.capture_launch(g)
        else:
            step()
        it += 1
        if it % check_every == 0 or it == max_iter:
            dot(r, r, 3)
            res = float(np.sqrt(max(float(sc.numpy()[3]), 0.0))) / fnorm
            hist.append((it, res))
            if not res >= tol:
                break
    wp.synchronize_device(device)
    t1 = time.perf_counter()
    u_h = u.numpy().astype(np.float64)
    return u_h, {"iterations": it, "rel_residual": res, "seconds": t1 - t0, "upload_seconds": t0 - t_up,
                 "compile_seconds": compile_s, "ms_per_iteration": 1000 * (t1 - t0) / max(it, 1), "history": hist,
                 "backend": f"cuda-warp-{dtype}-mg", "device": wp.get_device(device).name,
                 "levels": M.desc, "stop": M.stop, "settings": M.settings}
