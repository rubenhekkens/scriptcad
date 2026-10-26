"""STEP export needs OpenCASCADE (`scriptcad[step]`); the round trip also needs
the converters, which are downloaded on first use - set SCRIPTCAD_TEST_STEP_TOOLS=1
(or have them installed) to run it."""

import json
import math
import os
from importlib.resources import files

import pytest

from scriptcad import kernel, occt_tools, step_io

pytestmark = pytest.mark.skipif(not step_io.ocp_available(), reason='needs OpenCASCADE: pip install "scriptcad[step]"')

needs_tools = pytest.mark.skipif(
    not (occt_tools.installed() or os.environ.get("SCRIPTCAD_TEST_STEP_TOOLS")),
    reason="STEP converters not installed (scriptcad --install-step-tools)")

SHAPES = {
    "box": ("sm.create_box((0,0,0),20,10,5)", 1000.0),
    "cylinder": ("sm.create_cylinder((0,0,0),5,10)", math.pi * 25 * 10),
    "sphere": ("sm.create_sphere((0,0,0),7)", 4 / 3 * math.pi * 343),
    "cone": ("sm.create_cone((0,0,0),6,0,10)", math.pi * 36 * 10 / 3),
    "torus": ("sm.create_torus((0,0,0),10,3)", 2 * math.pi ** 2 * 10 * 9),
    "fillet_box": ("sm.circular_fillet(sm.create_box((0,0,0),20,20,20),3)", None),
}


def _example():
    return json.loads((files("scriptcad") / "web" / "example.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", SHAPES)
def test_export_is_valid_solid(tmp_path, name):
    expr, exact = SHAPES[name]
    out = kernel.export_usd_bodies(str(tmp_path), code=f"show({expr})")
    [report] = step_io.usd_to_step(out["paths"], tmp_path / "out.step")
    assert report["valid"] and report["solids"] == 1
    target = exact if exact is not None else out["volumes"][0]
    assert report["volume"] == pytest.approx(target, rel=1e-4)
    assert (tmp_path / "out.step").read_text(errors="ignore").startswith("ISO-10303-21")


def test_export_example_bracket(tmp_path):
    out = kernel.export_usd_bodies(str(tmp_path), doc=_example())
    [report] = step_io.usd_to_step(out["paths"], tmp_path / "bracket.step")
    assert report["valid"] and report["solids"] == 1
    assert report["volume"] == pytest.approx(38449.6, rel=1e-4)


@needs_tools
@pytest.mark.parametrize("name", ["box", "cone", "torus", "bracket"])
def test_round_trip(tmp_path, name):
    if name == "bracket":
        out = kernel.export_usd_bodies(str(tmp_path), doc=_example())
        target = 38449.6
    else:
        expr, exact = SHAPES[name]
        out = kernel.export_usd_bodies(str(tmp_path), code=f"show({expr})")
        target = exact
    step_io.usd_to_step(out["paths"], tmp_path / "rt.step")
    parts, failed = step_io.step_to_usd(tmp_path / "rt.step", tmp_path / "in", kernel.inspect_usd)
    assert not failed and len(parts) == 1
    import usd_brep as sm
    [body] = sm.usd.import_breps(parts[0]["path"])
    assert body.is_manifold_solid()
    assert body.volume(1e-7) == pytest.approx(target, rel=1e-4)
