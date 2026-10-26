"""ScriptCAD HTTP server.

Serves the web UI and forwards geometry work to a single kernel worker
process. If the kernel crashes or a script runs too long, the worker is
replaced and the UI gets an error instead of a dead server.
"""

from __future__ import annotations

import argparse
import os
import re
import tempfile
import threading
import uuid
import webbrowser
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FutureTimeout
from concurrent.futures.process import BrokenProcessPool
from importlib.resources import files
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from platformdirs import user_data_path

WEB = Path(str(files("scriptcad") / "web"))
# Imported USD files are referenced by path from saved projects, so they live
# in a per-user folder rather than next to the (possibly read-only) package.
UPLOADS = user_data_path("scriptcad", appauthor=False) / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)
TIMEOUT = float(os.environ.get("SCRIPTCAD_TIMEOUT", "90"))


def _worker_init():
    # The bundled OpenUSD runtime prints a wall of harmless "No module named
    # 'pxr'" warnings on import; keep them out of the console.
    devnull = os.open(os.devnull, os.O_WRONLY)
    saved = os.dup(2)
    os.dup2(devnull, 2)
    try:
        import scriptcad.kernel  # noqa: F401
    finally:
        os.dup2(saved, 2)
        os.close(devnull)
        os.close(saved)


def _call(name, *args, **kwargs):
    from scriptcad import kernel
    return getattr(kernel, name)(*args, **kwargs)


class Worker:
    def __init__(self):
        self._lock = threading.Lock()
        self._pool = None

    def _ensure(self):
        if self._pool is None:
            self._pool = ProcessPoolExecutor(max_workers=1, initializer=_worker_init)
        return self._pool

    def _reset(self):
        pool, self._pool = self._pool, None
        if pool is not None:
            for p in list(getattr(pool, "_processes", {}).values()):
                try:
                    p.kill()
                except Exception:
                    pass
            pool.shutdown(wait=False, cancel_futures=True)

    def run(self, name, *args, timeout=TIMEOUT, **kwargs):
        with self._lock:
            fut = self._ensure().submit(_call, name, *args, **kwargs)
            try:
                return fut.result(timeout=timeout)
            except FutureTimeout:
                self._reset()
                raise HTTPException(504, f"kernel timed out after {timeout:.0f}s - the worker was restarted")
            except BrokenProcessPool:
                self._reset()
                raise HTTPException(500, "the geometry kernel crashed on this model - the worker was restarted")
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(400, f"{type(e).__name__}: {e}")


worker = Worker()
app = FastAPI(title="ScriptCAD")


@app.get("/api/info")
def info():
    return worker.run("warmup", timeout=120)


@app.get("/api/names")
def names():
    return worker.run("api_names")


@app.post("/api/regen")
def regen(payload: dict = Body(...)):
    return worker.run("regen", payload.get("doc", {}), payload.get("quality", "normal"))


@app.post("/api/script")
def script(payload: dict = Body(...)):
    return worker.run("run_script", payload.get("code", ""), payload.get("quality", "normal"))


@app.post("/api/codegen")
def codegen(payload: dict = Body(...)):
    return {"code": worker.run("history_to_script", payload.get("doc", {}))}


EXPORTS = {"usd-brep": (".usda", "model.brep.usda"), "usd-mesh": (".usda", "model.mesh.usda"),
           "usdc": (".usdc", "model.usdc"), "stl": (".stl", "model.stl")}


@app.post("/api/export")
def export(payload: dict = Body(...)):
    fmt = payload.get("format", "usd-brep")
    if fmt not in EXPORTS:
        raise HTTPException(400, f"unknown format {fmt}")
    suffix, default_name = EXPORTS[fmt]
    kfmt = "usd-brep" if fmt == "usdc" else fmt
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="scriptcad_")
    os.close(fd)
    if payload.get("mode") == "script":
        worker.run("export", path, kfmt, code=payload.get("code", ""))
    else:
        worker.run("export", path, kfmt, doc=payload.get("doc", {}))
    name = re.sub(r"[^\w.\-]+", "_", payload.get("name") or "model") + default_name[len("model"):]
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@app.post("/api/upload")
async def upload(request: Request, filename: str = "model.usda"):
    ext = Path(filename).suffix.lower()
    if ext not in {".usd", ".usda", ".usdc"}:
        raise HTTPException(400, "only .usd / .usda / .usdc files with BRep data can be imported")
    data = await request.body()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(413, "file too large")
    dest = UPLOADS / f"{uuid.uuid4().hex[:8]}_{re.sub(r'[^\w.-]+', '_', Path(filename).name)}"
    dest.write_bytes(data)
    try:
        summary = worker.run("inspect_usd", str(dest))
    except HTTPException as e:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"no editable BRep data in that file - ScriptCAD imports BrepArray prims, "
                                 f"not plain meshes ({e.detail})")
    if not summary["count"]:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "that USD file contains no BRep prims (only BrepArray data can be edited)")
    return {"path": str(dest), "name": Path(filename).name, **summary}


@app.exception_handler(HTTPException)
async def http_error(_request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


def main():
    import uvicorn

    parser = argparse.ArgumentParser(prog="scriptcad", description="CAD in the browser on NVIDIA's USD BRep kernel.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SCRIPTCAD_PORT", "8765")))
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    print(f"ScriptCAD running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
