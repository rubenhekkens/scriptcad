"""Voxel topology optimisation (web/fea/topo.js), run in Node with a CPU solver in place of the GPU."""

import json
import shutil
import subprocess
from importlib.resources import files
from pathlib import Path

import numpy as np
import pytest

from scriptcad.fea.grid import Problem

pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="needs Node.js")


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    # a 40 x 4 x 10 mm steel beam, clamped at both ends, 1 kN down on the middle of its top
    nx, ny, nz = 40, 4, 10
    p = Problem((nx, ny, nz), 1.0, np.zeros(3), np.full(nx * ny * nz, 210_000.0), 0.3)
    p.fix_where(lambda xyz: (xyz[:, 0] <= 0) | (xyz[:, 0] >= nx))
    pts = np.array([[x, y, nz - 0.01] for x in np.linspace(18.5, 21.5, 4) for y in np.linspace(0.5, 3.5, 4)])
    p.add_point_forces(pts, np.tile([0.0, 0.0, -1000.0 / len(pts)], (len(pts), 1)))
    blob = tmp_path_factory.mktemp("topo") / "beam.vxf"
    blob.write_bytes(p.to_bytes())
    web = Path(str(files("scriptcad") / "web")).resolve().as_uri() + "/"
    out = subprocess.run(["node", str(Path(__file__).with_name("topo_check.mjs")), str(blob), web],
                         capture_output=True, text=True, timeout=600)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_strain_energy_and_surface(run):
    # the voxel energies add up to the work done by the load: sum u_e K_e u_e = u K u = f.u
    assert run["energySum"] == pytest.approx(run["compliance0"], rel=1e-4)
    # a full box has 2(40x4 + 40x10 + 4x10) outer voxel faces, two triangles each
    assert run["boxTriangles"] == 2 * 2 * (40 * 4 + 40 * 10 + 4 * 10)
    assert run["stlBytes"] == 84 + 50 * run["boxTriangles"]


def test_half_the_material_keeps_most_of_the_stiffness(run):
    assert run["done"] and run["fraction"] == pytest.approx(0.5, abs=0.01)
    assert run["keptAll"] and run["islandsLeft"] == 0      # supports and load stay, one connected piece
    # compliance (f.u, inverse stiffness): half the material, more than twice as stiff as the
    # obvious way to halve it, a beam half as deep (measured: 2.25x and 5.1x the full beam)
    assert run["optCompliance"] < 2.5 * run["compliance0"]
    assert run["optCompliance"] < 0.5 * run["halfCompliance"]


def test_deflection_limit_keeps_the_lightest_design_within_it(run):
    assert run["limStop"] == "deflection limit"
    assert run["limDmax"] <= run["limit"] < run["lastSeen"]       # kept within, the next step went over
    assert run["limFraction"] < 1


def test_smooth_surface(run):
    # the full beam is all envelope: its faces stay flat and its edges sharp, so it stays a 40 x 4 x 10 box
    assert run["boxVolume"] == pytest.approx(40 * 4 * 10, rel=1e-6)
    # smoothing the carved design rounds the stair steps but keeps its volume
    assert run["carvedVolume"] == pytest.approx(run["voxelVolume"], rel=0.05)
