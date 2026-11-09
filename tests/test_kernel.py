import json
from importlib.resources import files

import pytest

from scriptcad import kernel


@pytest.fixture(scope="module")
def example():
    return json.loads((files("scriptcad") / "web" / "example.json").read_text(encoding="utf-8"))


def test_example_regenerates(example):
    res = kernel.regen(example)

    failed = {fid: s.get("error") for fid, s in res["status"].items() if s["state"] != "ok"}
    assert not failed, failed

    assert len(res["bodies"]) == 1
    props = res["bodies"][0]["props"]
    assert props["manifold"]
    assert props["volume"] == pytest.approx(38449.6, rel=1e-3)


def test_history_script_matches_model(example):
    code = kernel.history_to_script(example)
    res = kernel.run_script(code)
    assert res["error"] is None
    assert len(res["bodies"]) == 1
    assert res["bodies"][0]["props"]["volume"] == pytest.approx(38449.6, rel=1e-3)


def test_variables_drive_the_model():
    doc = {"variables": [{"name": "L", "value": 30}, {"name": "t", "value": "L / 10"}],
           "features": [{"id": "a", "type": "box", "params": {"x": 0, "y": 0, "z": 0, "l": "L", "w": "2*t", "h": 5}},
                        {"id": "b", "type": "extrude", "params": {"plane": "XY", "profile": "polyline", "dist": "t",
                         "offset": 0, "points": "0, 0; L, 0; L/2, t"}},
                        {"id": "c", "type": "box", "params": {"x": 0, "y": 0, "z": 0, "l": "nope", "w": 1, "h": 1}}]}
    res = kernel.regen(doc)
    vol = {b["id"]: b["props"]["volume"] for b in res["bodies"]}
    assert vol["a"] == pytest.approx(30 * 6 * 5, rel=1e-6)
    assert vol["b"] == pytest.approx(30 * 3 / 2 * 3, rel=1e-6)
    assert res["status"]["c"]["state"] == "error" and "nope" in res["status"]["c"]["error"]
    code = kernel.history_to_script(doc)
    assert "# Variables: L = 30, t = 3" in code


def test_bad_reference_reports_on_feature():
    doc = {"features": [
        {"id": "a", "type": "box", "params": {"x": 0, "y": 0, "z": 0, "l": 1, "w": 1, "h": 1}},
        {"id": "b", "type": "boolean", "params": {"op": "union", "target": "a", "tool": "missing"}},
    ]}
    res = kernel.regen(doc)
    assert res["status"]["a"]["state"] == "ok"
    assert res["status"]["b"]["state"] == "error"
    assert len(res["bodies"]) == 1
