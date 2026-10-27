"""NVIDIA's OpenCASCADE <-> USD BRep converters (``occt_to_usd`` / ``usd_to_occt``).

They are not in the ``usd-brep`` wheel, so ScriptCAD downloads a prebuilt copy
on first use: Julia's BinaryBuilder build of NVIDIA's usd-brep v1.0.0 source
(``USDBrep_jll``) and its runtime dependencies, pinned by URL and sha256 and
unpacked into the per-user data folder.

Set ``SCRIPTCAD_OCCT_TOOLS`` to a folder containing ``occt_to_usd`` (for example
``_build/<platform>/release`` from a source build of usd-brep) to use your own
copy instead; ``OMNISOLID_PLUGIN_PATH`` must then point at its schema.
"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import sys
import tarfile
import tempfile
import threading
import urllib.request
from pathlib import Path

from platformdirs import user_data_path

VERSION = "usdbrep-1.0.0"
_BASE = "https://github.com/JuliaBinaryWrappers/{repo}.jl/releases/download/{tag}/{name}"

# (repo, tag, file name, sha256) per platform
PACKAGES = {
    ("Windows", "AMD64"): [
        ("USDBrep_jll", "USDBrep-v1.0.0%2B0", "USDBrep.v1.0.0.x86_64-w64-mingw32-cxx11.tar.gz",
         "29628349a6f79eb15ad11e3fa64ba44626337a7e462532501d492a72f9217ffe"),
        ("OpenUSD_jll", "OpenUSD-v25.11.0%2B0", "OpenUSD.v25.11.0.x86_64-w64-mingw32-cxx11.tar.gz",
         "a26bb50f669dcac6913f7d3af0ee156cc4f369b5846fce30d58c8075d6fa2ff1"),
        ("oneTBB_jll", "oneTBB-v2022.3.0%2B0", "oneTBB.v2022.3.0.x86_64-w64-mingw32-cxx11.tar.gz",
         "1d7b6e592032782e4cfff3a9a7beb0423b3f1828da43085691d8d26a3cdea234"),
        ("CompilerSupportLibraries_jll", "CompilerSupportLibraries-v1.3.2%2B0",
         "CompilerSupportLibraries.v1.3.2.x86_64-w64-mingw32-libgfortran5.tar.gz",
         "4e63f29fb207578145ad781a3a7cd0fcbc87505caac2514d82280f2ba96bee9b"),
    ],
    ("Linux", "x86_64"): [
        ("USDBrep_jll", "USDBrep-v1.0.0%2B0", "USDBrep.v1.0.0.x86_64-linux-gnu-cxx11.tar.gz",
         "d70b2f5c02aaa9ad6a296eafafa7a7cf546c9bf133761db5b751053a78ea63f0"),
        ("OpenUSD_jll", "OpenUSD-v25.11.0%2B0", "OpenUSD.v25.11.0.x86_64-linux-gnu-cxx11.tar.gz",
         "1d20fb21f4394b2beacdd0d7656b0d4d9826e1fa14d58f5369e1244e8d20f541"),
        ("oneTBB_jll", "oneTBB-v2022.3.0%2B0", "oneTBB.v2022.3.0.x86_64-linux-gnu-cxx11.tar.gz",
         "4acb276164a25236742f253a07132c15c2c705ad16aa71072bd990a433f89ab3"),
        ("CompilerSupportLibraries_jll", "CompilerSupportLibraries-v1.3.2%2B0",
         "CompilerSupportLibraries.v1.3.2.x86_64-linux-gnu-libgfortran5.tar.gz",
         "dcb4bf42e436ef6bd1e6b6a7ba7fb644bb8bf60034f68a394e0f23f1b3570f9f"),
    ],
}

_lock = threading.Lock()


class ToolsUnavailable(RuntimeError):
    pass


def _exe(name):
    return name + (".exe" if os.name == "nt" else "")


def install_dir():
    return user_data_path("scriptcad", appauthor=False) / "occt-tools" / VERSION


def _packages():
    key = (platform.system(), platform.machine())
    if key not in PACKAGES:
        raise ToolsUnavailable(
            f"no prebuilt STEP converters for {key[0]} {key[1]}; build usd-brep from source and set "
            "SCRIPTCAD_OCCT_TOOLS to the folder containing occt_to_usd")
    return PACKAGES[key]


def installed():
    if os.environ.get("SCRIPTCAD_OCCT_TOOLS"):
        return (Path(os.environ["SCRIPTCAD_OCCT_TOOLS"]) / _exe("occt_to_usd")).exists()
    return (install_dir() / ".complete").exists()


def install(progress=print):
    """Download, verify and unpack the converters. Safe to call repeatedly."""
    with _lock:
        dest = install_dir()
        if (dest / ".complete").exists():
            return dest
        pkgs = _packages()
        tmp = Path(tempfile.mkdtemp(prefix="scriptcad-occt-"))
        staging = dest.with_name(dest.name + ".partial")
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        try:
            for repo, tag, name, sha in pkgs:
                url = _BASE.format(repo=repo, tag=tag, name=name)
                progress(f"downloading {name}")
                path = tmp / name
                with urllib.request.urlopen(url, timeout=120) as r, open(path, "wb") as fh:
                    shutil.copyfileobj(r, fh)
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                if digest != sha:
                    raise ToolsUnavailable(f"checksum mismatch for {name}: got {digest}")
                with tarfile.open(path) as tf:
                    tf.extractall(staging, filter="data")
            (staging / ".complete").write_text(VERSION)
            shutil.rmtree(dest, ignore_errors=True)
            staging.rename(dest)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.rmtree(staging, ignore_errors=True)
        progress(f"STEP converters installed in {dest}")
        return dest


def environment():
    """(bin_dir, env) for running the converters; installs them if needed."""
    env = dict(os.environ)
    custom = os.environ.get("SCRIPTCAD_OCCT_TOOLS")
    if custom:
        bin_dir = Path(custom)
        if not (bin_dir / _exe("occt_to_usd")).exists():
            raise ToolsUnavailable(f"SCRIPTCAD_OCCT_TOOLS={custom} does not contain occt_to_usd")
        return bin_dir, env
    root = install(progress=lambda m: print(f"[scriptcad] {m}", file=sys.stderr))
    bin_dir = root / "bin"
    lib_dir = root / "lib"
    env["OMNISOLID_PLUGIN_PATH"] = str(root / "omniSolid" / "resources")
    env["PXR_PLUGINPATH_NAME"] = str(root / "plugin" / "usd")
    if os.name == "nt":
        env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    else:
        env["LD_LIBRARY_PATH"] = str(lib_dir) + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    return bin_dir, env


def tool(name):
    bin_dir, env = environment()
    return str(bin_dir / _exe(name)), env


if __name__ == "__main__":
    install()
