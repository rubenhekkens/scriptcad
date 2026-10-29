"""Analyze mode, server side: body -> voxel problem -> stresses on the viewer mesh.

Solved here with the CPU float64 reference so the test needs no GPU; the browser
solves the same blob with WebGPU multigrid.
"""

import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("scipy")
pytest.importorskip("pyamg")

from scriptcad import kernel  # noqa: E402
from scriptcad.fea import analyze, cpu  # noqa: E402

EXAMPLE = json.loads((Path(__file__).parents[1] / "src/scriptcad/web/example.json").read_text())
HOLES = [[12.2, 9, 4], [74.2, 9, 4], [12.2, 41, 4], [74.2, 41, 4]]     # bolt-hole walls
BORE = [[48, 25, 15]]                                                  # bore wall


def _run(load, quality="draft", material="aluminium"):
    setup = {"body": "plate", "material": material, "quality": quality, "fixed": HOLES,
             "load": {"faces": BORE, **load}}
    geom = kernel.analysis_geometry(EXAMPLE, "plate", {"fixed": HOLES, "load": BORE})
    cid, blob, meta = analyze.build(geom, setup)
    p = analyze._cases[cid]["p"]
    u, _ = cpu.reference(p, tol=1e-10)
    return geom, p, u, meta, analyze.result(cid, u.astype(np.float32))


def test_picked_faces_resolve():
    geom = kernel.analysis_geometry(EXAMPLE, "plate", {"fixed": HOLES, "load": BORE})
    assert len(set(geom["groups"]["fixed"])) == 4
    assert len(geom["groups"]["load"]) == 1
    assert len(geom["triFace"]) * 9 == len(geom["positions"])


def test_force_is_reacted_by_the_supports():
    _, p, u, meta, res = _run({"type": "force", "vector": [0, 0, -2000]})
    # reactions at held DOFs balance the applied 2 kN exactly
    f = cpu.apply_k(p, u).reshape(-1, 3)
    held = p.fixed.reshape(-1, 3)[:, 2] == 1
    assert f[held, 2].sum() == pytest.approx(2000.0, rel=1e-6)
    # voxel model tracks the CAD volume
    assert meta["voxel_volume"] == pytest.approx(meta["cad_volume"], rel=0.05)
    s = res["stats"]
    assert 0 < s["p50"] < s["p99"] < s["max"]
    assert s["max_away"] <= s["max"]
    assert 0 < s["max_displacement"] < 0.1                                # mm


def test_result_is_shown_on_a_refined_copy_of_the_viewer_mesh():
    geom, p, u, _, res = _run({"type": "force", "vector": [0, 0, -2000]})
    n = len(res["positions"])
    assert len(res["vonMises"]) == n and len(res["displacement"]) == n and len(res["triFace"]) * 3 == n
    # refinement keeps the surface (same area) and only reuses the CAD face ids
    def area(flat):
        t = np.asarray(flat, dtype=float).reshape(-1, 3, 3)
        return 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum()
    assert area(res["positions"]) == pytest.approx(area(geom["positions"]), rel=1e-6)
    assert set(res["triFace"].tolist()) <= set(geom["triFace"])
    # no display edge longer than the refinement target (3 voxels), so the field is resolved
    t = res["positions"].reshape(-1, 3, 3)
    longest = np.linalg.norm(t - np.roll(t, 1, axis=1), axis=2).max()
    assert longest <= 3.0 * p.h * 1.0001 or len(res["triFace"]) >= 0.9 * analyze.MAX_DISPLAY_TRIANGLES
    # the sampled field reaches the solver's maximum displacement
    dmax = np.linalg.norm(res["displacement"], axis=1).max()
    assert dmax == pytest.approx(res["stats"]["max_displacement"], rel=0.05)


def test_result_blob_layout():
    *_, res = _run({"type": "force", "vector": [0, 0, -2000]})
    blob = analyze.result_blob(res)
    n = int(np.frombuffer(blob, "<u4", 1)[0])
    assert len(blob) == 4 + 4 * (3 * n + 3 * n + n + 3 * n + n // 3)


def test_torque_and_stiffer_material():
    _, p, u, _, alu = _run({"type": "torque", "torque": 20, "axis": "Z"})
    # applied moment about the bore axis equals the requested 20 N.m
    xyz = p.node_xyz() - np.array([40.0, 25.0, 0.0])
    m = np.cross(xyz, p.force.reshape(-1, 3))[:, 2].sum()
    assert m == pytest.approx(20_000.0, rel=0.02)
    _, _, _, _, steel = _run({"type": "torque", "torque": 20, "axis": "Z"}, material="steel")
    # same geometry and load: stiffer material, smaller displacement (linear in 1/E)
    ratio = alu["stats"]["max_displacement"] / steel["stats"]["max_displacement"]
    assert ratio == pytest.approx(210_000 / 70_000, rel=0.05)


def test_bad_setups_are_rejected():
    geom = kernel.analysis_geometry(EXAMPLE, "plate", {"fixed": [], "load": BORE})
    with pytest.raises(ValueError, match="fixed"):
        analyze.build(geom, {"body": "plate", "fixed": [], "load": {"faces": BORE, "type": "force"}})
    with pytest.raises(ValueError, match="does not exist"):
        kernel.analysis_geometry(EXAMPLE, "nope", {"fixed": HOLES, "load": BORE})
