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


def test_bad_reference_reports_on_feature():
    doc = {"features": [
        {"id": "a", "type": "box", "params": {"x": 0, "y": 0, "z": 0, "l": 1, "w": 1, "h": 1}},
        {"id": "b", "type": "boolean", "params": {"op": "union", "target": "a", "tool": "missing"}},
    ]}
    res = kernel.regen(doc)
    assert res["status"]["a"]["state"] == "ok"
    assert res["status"]["b"]["state"] == "error"
    assert len(res["bodies"]) == 1
