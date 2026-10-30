"""Document variables and parameter expressions.

A document may carry `variables: [{"name": "tf", "value": "3"}, ...]`; each value is
a number or an expression over the variables above it. Any numeric feature parameter
may then be an expression string ("40 - tf"), and so may each coordinate of a
polyline ("50 - bf/2, 0; ..."). Everything is resolved to plain numbers before the
history is compiled, so the kernel only ever sees numbers.

The grammar is deliberately small (arithmetic, a few functions) and mirrored by
web/expr.js, which the UI uses to validate and preview values.
"""

from __future__ import annotations

import ast
import math
import operator
import re

FUNCS = {"sqrt": math.sqrt, "sin": lambda d: math.sin(math.radians(d)), "cos": lambda d: math.cos(math.radians(d)),
         "tan": lambda d: math.tan(math.radians(d)), "abs": abs, "min": min, "max": max,
         "round": round, "floor": math.floor, "ceil": math.ceil}
CONSTS = {"pi": math.pi}
_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.Mod: operator.mod}
NAME = re.compile(r"^[A-Za-z_]\w*$")

# Feature parameters that hold numbers (see web/features.js); every other string
# parameter (plane, profile, body ids, ...) is passed through untouched.
NUMERIC = {"x", "y", "z", "l", "w", "h", "r", "r1", "r2", "R", "cx", "cy", "sides", "dist", "offset", "angle",
           "radius", "thickness", "distance", "tx", "ty", "tz", "scale", "px", "py", "pz", "count",
           "dx", "dy", "dz", "index"}


def evaluate(text, env):
    """Value of a number or an expression string over the names in `env`."""
    if isinstance(text, bool):
        raise ValueError("expected a number")
    if isinstance(text, (int, float)):
        return float(text)
    src = str(text).strip().replace("^", "**")
    if not src:
        raise ValueError("empty value")
    try:
        tree = ast.parse(src, mode="eval")
    except SyntaxError:
        raise ValueError(f"cannot read '{text}'") from None

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return float(n.value)
        if isinstance(n, ast.Name):
            if n.id in env:
                return env[n.id]
            if n.id in CONSTS:
                return CONSTS[n.id]
            raise ValueError(f"unknown variable '{n.id}'")
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
            v = ev(n.operand)
            return -v if isinstance(n.op, ast.USub) else v
        if isinstance(n, ast.BinOp) and type(n.op) in _BIN:
            try:
                return float(_BIN[type(n.op)](ev(n.left), ev(n.right)))
            except ZeroDivisionError:
                raise ValueError(f"division by zero in '{text}'") from None
        if (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in FUNCS
                and not n.keywords and n.args):
            return float(FUNCS[n.func.id](*[ev(a) for a in n.args]))
        raise ValueError(f"cannot read '{text}'")

    v = ev(tree)
    if not math.isfinite(v):
        raise ValueError(f"'{text}' is not a finite number")
    return v


def variables(doc):
    """{name: value} for the document's variables, each over the ones above it."""
    env = {}
    for var in doc.get("variables") or []:
        name = str(var.get("name", "")).strip()
        if not NAME.match(name) or name in FUNCS or name in CONSTS:
            raise ValueError(f"'{name}' is not a usable variable name")
        if name in env:
            raise ValueError(f"variable '{name}' is defined twice")
        try:
            env[name] = evaluate(var.get("value", 0), env)
        except ValueError as e:
            raise ValueError(f"variable '{name}': {e}") from None
    return env


def _split_top(text, sep):
    """Split on `sep` outside parentheses, so min(a, b) stays one coordinate."""
    out, depth, cur = [], 0, ""
    for c in text:
        depth += (c == "(") - (c == ")")
        if c == sep and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += c
    return out + [cur]


def resolve_points(text, env):
    """'0,0; 40-tf, 3; ...' -> '0,0; 37,3; ...' (polylines without commas keep 'x y' pairs)."""
    pts = []
    for chunk in re.split(r"[;\n]+", str(text)):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = _split_top(chunk, ",") if "," in chunk else chunk.split()
        pts.append(", ".join(repr(round(evaluate(p, env), 9)) for p in parts if p.strip()))
    return "; ".join(pts)


def resolve_params(params, env):
    """Copy of a feature's params with every expression replaced by its value."""
    out = dict(params)
    for k, v in params.items():
        if k in NUMERIC and isinstance(v, str):
            out[k] = evaluate(v, env)
        elif k == "points" and isinstance(v, str):
            out[k] = resolve_points(v, env)
    return out
