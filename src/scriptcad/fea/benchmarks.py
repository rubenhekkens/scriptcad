"""Analytic benchmark cases for the voxel solvers.

Each case builds a Problem for a voxel size h and element formulation, and
returns ``measure(u) -> {quantity: (fea_value, reference_value, unit)}``.
The references are closed-form (textbook) solutions, not other software's output.

* cantilever      square beam, tip load: Euler-Bernoulli + Timoshenko shear
* thin_cantilever 2 mm thick strip: the shear-locking test for shell-like walls
* tube_torsion    thin-walled tube under 62 N.m: Saint-Venant torsion of a
                  hollow circular shaft (a thin-walled cast housing barrel)
* lame_ring       thick ring under internal pressure: Lame (open ends), the
                  ring-gear press-fit load on a housing seat
"""

from __future__ import annotations

import math

import numpy as np

from .grid import Problem

STEEL = (200_000.0, 0.30)
ALU = (71_000.0, 0.33)          # die-cast aluminium, ADC12/A380


def _box_problem(lengths, h, mat, formulation, name):
    shape = tuple(int(round(l / h)) for l in lengths)
    emod = np.full(int(np.prod(shape)), mat[0])
    return Problem(shape, h, np.zeros(3), emod, mat[1], formulation, name=name)


def _face_grid(u_range, v_range, n_u, n_v):
    us = np.linspace(*u_range, n_u + 1)
    vs = np.linspace(*v_range, n_v + 1)
    uc, vc = (us[:-1] + us[1:]) / 2, (vs[:-1] + vs[1:]) / 2
    U, V = np.meshgrid(uc, vc, indexing="ij")
    return U.ravel(), V.ravel()


# --------------------------------------------------------------------------- #

def cantilever(h=1.0, formulation="hex8i", L=100.0, b=10.0, t=10.0, P=100.0):
    E, nu = STEEL
    p = _box_problem((L, b, t), h, STEEL, formulation, "cantilever")
    p.fix_where(lambda x: x[:, 0] < 1e-9)
    y, z = _face_grid((0, b), (0, t), 40, 40)
    pts = np.stack([np.full_like(y, L), y, z], 1)
    p.add_point_forces(pts, np.tile([0, 0, -P / len(y)], (len(y), 1)))

    I = b * t ** 3 / 12
    G = E / (2 * (1 + nu))
    ref_tip = P * L ** 3 / (3 * E * I) + P * L / (5 / 6 * G * b * t)

    def measure(u):
        xyz = p.node_xyz()
        tip = np.abs(xyz[:, 0] - L) < 1e-9
        s = p.stresses(u)
        c = p.voxel_centers()
        mid = np.abs(c[:, 0] - L / 2) < h * 0.51
        # bending stress at the outermost voxel layer, against M (z - t/2) / I at that height
        top = mid & (np.abs(c[:, 2] - (t - h / 2)) < 1e-6)
        M = P * (L - c[top, 0])
        ref_s = M * (c[top, 2] - t / 2) / I
        return {
            "tip deflection": (float(-u[3 * np.flatnonzero(tip) + 2].mean()), ref_tip, "mm"),
            "bending stress, mid-span top layer": (float(s[top, 0].mean()), float(ref_s.mean()), "MPa"),
        }
    return p, measure


def thin_cantilever(h=0.5, formulation="hex8i", L=50.0, b=4.0, t=2.0, P=5.0):
    """A 2 mm wall (a cast housing wall) in bending with t/h voxels through it.

    b = 2 t keeps it a beam (no plate stiffening), so Euler-Bernoulli plus shear is the
    reference and any extra stiffness is the element's (locking), not the reference's.
    """
    E, nu = STEEL
    p = _box_problem((L, b, t), h, STEEL, formulation, "thin_cantilever")
    p.fix_where(lambda x: x[:, 0] < 1e-9)
    y, z = _face_grid((0, b), (0, t), 16, 8)
    pts = np.stack([np.full_like(y, L), y, z], 1)
    p.add_point_forces(pts, np.tile([0, 0, -P / len(y)], (len(y), 1)))
    I = b * t ** 3 / 12
    G = E / (2 * (1 + nu))
    ref_beam = P * L ** 3 / (3 * E * I) + P * L / (5 / 6 * G * b * t)

    def measure(u):
        tip = np.abs(p.node_xyz()[:, 0] - L) < 1e-9
        return {"tip deflection": (float(-u[3 * np.flatnonzero(tip) + 2].mean()), ref_beam, "mm")}
    return p, measure


def tube_torsion(h=0.5, formulation="hex8i", ri=22.25, ro=24.75, L=60.0, T=62_000.0):
    """62 N.m through a tube of 23.5 mm mean radius and 2.5 mm wall."""
    E, nu = ALU
    n_xy = int(math.ceil(2 * ro / h)) + 2
    nz = int(round(L / h))
    lo = np.array([-(n_xy * h) / 2, -(n_xy * h) / 2, 0.0])
    shape = (n_xy, n_xy, nz)
    p0 = Problem(shape, h, lo, np.zeros(n_xy * n_xy * nz), nu, formulation)
    c = p0.voxel_centers()
    r = np.hypot(c[:, 0], c[:, 1])
    emod = np.where((r >= ri) & (r <= ro), E, 0.0)
    p = Problem(shape, h, lo, emod, nu, formulation, name="tube_torsion")
    p.fix_where(lambda x: x[:, 2] < 1e-9)
    # tangential traction on the end annulus, scaled so sum(r x f) = T exactly
    rr, th = _face_grid((ri, ro), (0, 2 * math.pi), 8, 720)
    dA = rr * (ro - ri) / 8 * (2 * math.pi / 720)
    pts = np.stack([rr * np.cos(th), rr * np.sin(th), np.full_like(rr, L)], 1)
    w = rr * dA
    mag = T * w / np.sum(rr * w)
    p.add_point_forces(pts, np.stack([-np.sin(th) * mag, np.cos(th) * mag, 0 * mag], 1))

    G = E / (2 * (1 + nu))
    J = math.pi / 2 * (ro ** 4 - ri ** 4)

    def measure(u):
        xyz = p.node_xyz()
        z0 = 0.5 * L
        sel = (np.abs(xyz[:, 2] - z0) < 0.51 * h) & p.active_nodes()
        x, y = xyz[sel, 0], xyz[sel, 1]
        ux, uy = u[3 * np.flatnonzero(sel)], u[3 * np.flatnonzero(sel) + 1]
        theta = np.mean((x * uy - y * ux) / (x * x + y * y))
        s = p.stresses(u)
        cc = p.voxel_centers()
        mid = (np.abs(cc[:, 2] - z0) < 0.51 * h) & (p.emod > 0)
        phi = np.arctan2(cc[mid, 1], cc[mid, 0])
        tau = -np.sin(phi) * s[mid, 4] + np.cos(phi) * s[mid, 3]     # tau_theta_z
        r_c = np.hypot(cc[mid, 0], cc[mid, 1])
        return {
            "twist at mid-length": (float(np.degrees(theta)), math.degrees(T * z0 / (G * J)), "deg"),
            "shear stress at mid-length (mean)": (float(tau.mean()), float((T * r_c / J).mean()), "MPa"),
        }
    return p, measure


def lame_ring(h=0.5, formulation="hex8i", ri=20.0, ro=25.0, L=20.0, pressure=20.0):
    """Internal pressure on a ring seat (press-fit load), open ends."""
    E, nu = ALU
    n_xy = int(math.ceil(2 * ro / h)) + 2
    nz = int(round(L / h))
    lo = np.array([-(n_xy * h) / 2, -(n_xy * h) / 2, 0.0])
    shape = (n_xy, n_xy, nz)
    p0 = Problem(shape, h, lo, np.zeros(n_xy * n_xy * nz), nu, formulation)
    c = p0.voxel_centers()
    r = np.hypot(c[:, 0], c[:, 1])
    emod = np.where((r >= ri) & (r <= ro), E, 0.0)
    p = Problem(shape, h, lo, emod, nu, formulation, name="lame_ring")
    # remove rigid motion only, using symmetry: uz at z = 0, ux on the y axis, uy on the x axis
    p.fix_where(lambda x: x[:, 2] < 1e-9, components=(2,))
    p.fix_where(lambda x: np.abs(x[:, 0]) < 0.51 * h, components=(0,))
    p.fix_where(lambda x: np.abs(x[:, 1]) < 0.51 * h, components=(1,))
    th, zz = _face_grid((0, 2 * math.pi), (0, L), 720, int(4 * L / h))
    dA = ri * (2 * math.pi / 720) * (L / int(4 * L / h))
    pts = np.stack([ri * np.cos(th), ri * np.sin(th), zz], 1)
    f = pressure * dA
    p.add_point_forces(pts, np.stack([np.cos(th) * f, np.sin(th) * f, 0 * th], 1))

    k = (ro ** 2 + ri ** 2) / (ro ** 2 - ri ** 2)
    ref_ur = ri * pressure / E * (k + nu)

    def measure(u):
        xyz = p.node_xyz()
        rn = np.hypot(xyz[:, 0], xyz[:, 1])
        act = p.active_nodes()
        mid = act & (np.abs(xyz[:, 2] - L / 2) < 0.51 * h)
        inner = mid & (rn < ri + 0.75 * h)
        n = np.flatnonzero(inner)
        ur = (xyz[n, 0] * u[3 * n] + xyz[n, 1] * u[3 * n + 1]) / rn[n]
        s = p.stresses(u)
        cc = p.voxel_centers()
        rc = np.hypot(cc[:, 0], cc[:, 1])
        band = (p.emod > 0) & (np.abs(cc[:, 2] - L / 2) < 0.51 * h) & (rc > ri + 1.5 * h) & (rc < ro - 1.5 * h)
        phi = np.arctan2(cc[band, 1], cc[band, 0])
        sx, sy, sxy = s[band, 0], s[band, 1], s[band, 5]
        hoop = sx * np.sin(phi) ** 2 + sy * np.cos(phi) ** 2 - 2 * sxy * np.sin(phi) * np.cos(phi)
        ref_hoop = pressure * ri ** 2 / (ro ** 2 - ri ** 2) * (1 + ro ** 2 / rc[band] ** 2)
        return {
            "radial growth of the bore": (float(ur.mean()), ref_ur, "mm"),
            "hoop stress, wall interior (mean)": (float(hoop.mean()), float(ref_hoop.mean()), "MPa"),
        }
    return p, measure


CASES = {"cantilever": cantilever, "thin_cantilever": thin_cantilever,
         "tube_torsion": tube_torsion, "lame_ring": lame_ring}

try:                                    # real-part cases kept outside the repository
    from .local_cases import CASES as _LOCAL
    CASES.update(_LOCAL)
except ImportError:
    pass
