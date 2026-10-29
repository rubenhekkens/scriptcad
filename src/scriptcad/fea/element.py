"""Element stiffness for a voxel (unit cube) in linear elasticity.

Every solid voxel is the same cube, so one 24x24 matrix serves the whole grid:
the stiffness of voxel e is E_e * h * KE, with KE computed here for E = 1 and
h = 1 (3D elasticity stiffness scales with E times length). That constant
matrix is what makes a matrix-free solver cheap: nothing is assembled.

Two formulations:

* ``"hex8"``: the standard trilinear brick with full 2x2x2 Gauss integration.
  It is too stiff in bending when only a few voxels span a wall
  ("shear locking"), which is exactly the thin-wall case of a shell part.
* ``"hex8i"``: the same brick enriched with Wilson's nine incompatible bubble
  modes (1 - xi^2 etc. per displacement component), statically condensed back
  to 24 DOFs. On undistorted cubes it passes the patch test and removes most of
  the bending stiffness error at a cost of zero at solve time: it is just a
  different constant matrix.

Node a of a voxel sits at local corner (di, dj, dk) with a = di + 2 dj + 4 dk;
DOF 3a + c is displacement component c of that node.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

CORNERS = np.array([[a & 1, (a >> 1) & 1, (a >> 2) & 1] for a in range(8)], dtype=np.int64)
_SIGN = 2 * CORNERS - 1          # natural-coordinate sign of each corner
_GAUSS = np.array([-1.0, 1.0]) / np.sqrt(3.0)


def constitutive(nu: float) -> np.ndarray:
    """Isotropic D for E = 1, Voigt order (xx, yy, zz, yz, xz, xy), engineering shear."""
    lam = nu / ((1 + nu) * (1 - 2 * nu))
    mu = 1 / (2 * (1 + nu))
    d = np.zeros((6, 6))
    d[:3, :3] = lam
    d[[0, 1, 2], [0, 1, 2]] += 2 * mu
    d[[3, 4, 5], [3, 4, 5]] = mu
    return d


def _strain_rows(grads: np.ndarray) -> np.ndarray:
    """B matrix (6 x 3n) from shape-function gradients (n x 3) in physical coords."""
    n = len(grads)
    b = np.zeros((6, 3 * n))
    for a, (gx, gy, gz) in enumerate(grads):
        c = 3 * a
        b[0, c] = gx
        b[1, c + 1] = gy
        b[2, c + 2] = gz
        b[3, c + 1], b[3, c + 2] = gz, gy
        b[4, c], b[4, c + 2] = gz, gx
        b[5, c], b[5, c + 1] = gy, gx
    return b


def _nodal_grads(xi: np.ndarray) -> np.ndarray:
    """dN_a/dx for the unit cube (dx/dxi = 1/2, so d/dx = 2 d/dxi)."""
    g = np.empty((8, 3))
    for a in range(8):
        s = _SIGN[a]
        f = 1 + s * xi                       # (1 + s_i xi_i) per axis
        g[a, 0] = s[0] * f[1] * f[2] / 8
        g[a, 1] = f[0] * s[1] * f[2] / 8
        g[a, 2] = f[0] * f[1] * s[2] / 8
    return 2 * g


def _bubble_grads(xi: np.ndarray) -> np.ndarray:
    """d/dx of Wilson's modes 1 - xi^2, 1 - eta^2, 1 - zeta^2."""
    return 2 * np.diag(-2 * xi)


@lru_cache(maxsize=8)
def stiffness(nu: float, formulation: str = "hex8i") -> np.ndarray:
    """24x24 element stiffness of a unit cube with E = 1."""
    d = constitutive(nu)
    det_j = 0.125                            # (h/2)^3 with h = 1
    kuu = np.zeros((24, 24))
    kua = np.zeros((24, 9))
    kaa = np.zeros((9, 9))
    for x in _GAUSS:
        for y in _GAUSS:
            for z in _GAUSS:
                xi = np.array([x, y, z])
                bu = _strain_rows(_nodal_grads(xi))
                kuu += bu.T @ d @ bu * det_j
                if formulation == "hex8i":
                    ba = _strain_rows(_bubble_grads(xi))
                    kua += bu.T @ d @ ba * det_j
                    kaa += ba.T @ d @ ba * det_j
    if formulation == "hex8":
        k = kuu
    elif formulation == "hex8i":
        k = kuu - kua @ np.linalg.solve(kaa, kua.T)
    else:
        raise ValueError(f"unknown formulation {formulation!r}")
    return 0.5 * (k + k.T)


@lru_cache(maxsize=8)
def center_strain_operator() -> np.ndarray:
    """B at the voxel centre for h = 1 (6 x 24). Bubble gradients vanish there."""
    return _strain_rows(_nodal_grads(np.zeros(3)))


def von_mises(s: np.ndarray) -> np.ndarray:
    """Von Mises stress from Voigt stresses (..., 6)."""
    xx, yy, zz, yz, xz, xy = np.moveaxis(s, -1, 0)
    return np.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (yz ** 2 + xz ** 2 + xy ** 2))
