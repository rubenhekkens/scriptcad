import json
import shutil
import subprocess
from importlib.resources import files
from pathlib import Path

import pytest

from scriptcad.params import evaluate, resolve_params, resolve_points, variables


def test_expressions():
    env = {"tf": 3.0, "bf": 20.0}
    assert evaluate(7, env) == 7.0
    assert evaluate("40 - tf", env) == 37.0
    assert evaluate("50 + bf/2", env) == 60.0
    assert evaluate("-tf^2", env) == -9.0
    assert evaluate("max(tf, 2*bf) + sqrt(16)", env) == 44.0
    assert evaluate("cos(60)", env) == pytest.approx(0.5)         # degrees, as everywhere else in CAD
    assert evaluate("2*pi", {}) == pytest.approx(6.283185307)


@pytest.mark.parametrize("text, msg", [
    ("tw + 1", "unknown variable 'tw'"), ("1/0", "division by zero"), ("", "empty"),
    ("__import__('os')", "cannot read"), ("tf.real", "cannot read"), ("1 +", "cannot read"),
])
def test_bad_expressions(text, msg):
    with pytest.raises(ValueError, match=msg):
        evaluate(text, {"tf": 3.0})


def test_variables_build_on_each_other():
    doc = {"variables": [{"name": "H", "value": 40}, {"name": "tf", "value": "H / 10"}]}
    assert variables(doc) == {"H": 40.0, "tf": 4.0}
    with pytest.raises(ValueError, match="'b'.*unknown variable 'c'"):
        variables({"variables": [{"name": "b", "value": "c"}, {"name": "c", "value": 1}]})
    with pytest.raises(ValueError, match="twice"):
        variables({"variables": [{"name": "a", "value": 1}, {"name": "a", "value": 2}]})
    with pytest.raises(ValueError, match="usable"):
        variables({"variables": [{"name": "2x", "value": 1}]})


def test_params_and_points():
    env = {"tf": 3.0, "bf": 20.0}
    p = resolve_params({"plane": "YZ", "target": "tf", "dist": "2*bf", "w": 5,
                        "points": "50-bf/2, 0; 50+bf/2, 0; max(tf, 1), tf"}, env)
    # body ids and enums are never expressions, even when they look like one
    assert p["plane"] == "YZ" and p["target"] == "tf"
    assert p["dist"] == 40.0 and p["w"] == 5
    assert p["points"] == "40.0, 0.0; 60.0, 0.0; 3.0, 3.0"
    assert resolve_points("0 0; 4 0; 4 2", {}) == "0.0, 0.0; 4.0, 0.0; 4.0, 2.0"   # space-separated still works


PARITY = ["7", "3.", ".5", "1e3", "40 - tf", "50 + bf/2", "-tf^2", "2**-1", "-2 ** 2", "7 % 3", "-7 % 3",
          "max(tf, 2*bf) + sqrt(16)", "min(1, 2, -3)", "cos(60)", "2*pi", "round(2.6) + floor(-1.5) + ceil(1.2)",
          "(bf - tf) / (tf + 1)", "tw", "1/0", "tf +", "foo(1)", "3 3", ""]


@pytest.mark.skipif(not shutil.which("node"), reason="needs Node.js")
def test_browser_evaluator_agrees():
    """web/expr.js previews what params.py will build: same values, same failures."""
    env = {"tf": 3.0, "bf": 20.0}
    url = Path(str(files("scriptcad") / "web" / "expr.js")).resolve().as_uri()
    script = (f"import {{ evaluate }} from {json.dumps(url)};"
              f"const out = {json.dumps(PARITY)}.map(t => {{ try {{ return evaluate(t, {json.dumps(env)}); }} catch {{ return null; }} }});"
              "console.log(JSON.stringify(out));")
    js = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True,
                                   check=True).stdout)

    def py(t):
        try:
            return evaluate(t, env)
        except ValueError:
            return None
    for text, a in zip(PARITY, js):
        b = py(text)
        assert (a is None) == (b is None), (text, a, b)
        if a is not None:
            assert a == pytest.approx(b), text
