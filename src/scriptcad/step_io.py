"""STEP import/export orchestration (runs in the server process).

    import:  .step --occt_bridge--> part_N.brep --occt_to_usd--> part_N.usda --kernel check-->
    export:  kernel bodies --usd export--> body_N.usda --occt_bridge--> .step

OpenCASCADE (the ``cadquery-ocp`` wheel, ``pip install scriptcad[step]``) and the
converters run in child processes; the kernel check runs in the kernel worker.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

from . import occt_tools

TIMEOUT = 600


class StepError(RuntimeError):
    pass


def ocp_available():
    return importlib.util.find_spec("OCP") is not None


def status():
    return {"ocp": ocp_available(), "converters": occt_tools.installed()}


def _require_ocp():
    if not ocp_available():
        raise StepError('STEP support needs OpenCASCADE: pip install "scriptcad[step]"')


def _bridge(*args):
    _require_ocp()
    proc = subprocess.run([sys.executable, "-I", "-m", "scriptcad.occt_bridge", *map(str, args)],
                          capture_output=True, text=True, timeout=TIMEOUT)
    for line in proc.stdout.splitlines():
        if line.startswith("@@RESULT@@"):
            out = json.loads(line[len("@@RESULT@@"):])
            if not out.get("ok"):
                raise StepError(out.get("error", "OpenCASCADE failed"))
            return out
    raise StepError(f"OpenCASCADE process failed (exit {proc.returncode}): {proc.stderr.strip()[-400:]}")


def _occt_to_usd(brep, usda):
    try:
        exe, env = occt_tools.tool("occt_to_usd")
    except occt_tools.ToolsUnavailable as e:
        raise StepError(str(e)) from e
    except OSError as e:
        raise StepError(f"could not download the STEP converters: {e}") from e
    proc = subprocess.run([exe, str(brep), str(usda)], capture_output=True, text=True, env=env, timeout=TIMEOUT)
    if proc.returncode != 0 or not Path(usda).exists():
        raise StepError(f"occt_to_usd failed: {(proc.stderr or proc.stdout).strip()[-400:]}")


def step_to_usd(step_path, out_dir, check):
    """Convert a STEP file into one kernel-readable .usda per solid.

    `check(usda_path)` must raise if the kernel can't load the file; parts it
    rejects are retried with all surfaces converted to NURBS.
    """
    out_dir = Path(out_dir)
    parts = _bridge("import", step_path, out_dir)["parts"]
    result, failed = [], []
    for i, part in enumerate(parts):
        brep = Path(part["brep"])
        usda = out_dir / f"part_{i}.usda"
        try:
            _occt_to_usd(brep, usda)
            check(str(usda))
            result.append({"path": str(usda), "volume": part["volume"], "exact": True})
            continue
        except Exception as first:  # noqa: BLE001 - retried below
            reason = str(first)
        try:
            nurbs = out_dir / f"part_{i}_nurbs.brep"
            _bridge("nurbs", brep, nurbs)
            usda = out_dir / f"part_{i}_nurbs.usda"
            _occt_to_usd(nurbs, usda)
            check(str(usda))
            result.append({"path": str(usda), "volume": part["volume"], "exact": False})
        except Exception as e:  # noqa: BLE001
            failed.append(f"part {i}: {e} (first attempt: {reason})")
    if not result:
        raise StepError("no part of the STEP file could be converted. " + "; ".join(failed))
    return result, failed


def usd_to_step(usd_files, out_step):
    return _bridge("export", out_step, *usd_files)["bodies"]
