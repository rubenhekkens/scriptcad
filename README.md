# ScriptCAD

A browser-based CAD interface on top of NVIDIA's open-source **USD BRep** kernel
(`usd-brep`, the SMLib NURBS solid modeler, Apache-2.0, released October 2026).

There are two ways to model, and both use the same viewport:

- **Model** is a parametric feature history: primitives, sketch extrude/revolve,
  booleans, fillet/chamfer on picked edges, shell with picked faces, offset,
  move/copy, linear and circular patterns, and USD BRep import. When you edit a
  feature, everything after it regenerates.
- **Script** is plain Python against the kernel (`sm` = `usd_brep`, `show(brep)`
  to display), with `sm.` autocompletion. **From history** turns the feature
  tree into the equivalent script. That works because the history is compiled
  to exactly that code.

Exports: exact BRep as OpenUSD (`.usda` / `.usdc`, `BrepArray` prims),
tessellated `UsdGeomMesh`, and STL.

## Install and run

ScriptCAD runs on **Windows (x86_64) and Linux (x86_64, aarch64)** with CPython
3.12, because those are the only builds of `usd-brep`. **macOS isn't supported.**

With [uv](https://docs.astral.sh/uv/) you don't need a Python 3.12 install first,
because uv fetches one:

```bash
uvx --python 3.12 scriptcad
```

Or with pip in a Python 3.12 environment:

```bash
pip install scriptcad
scriptcad
```

The browser opens at http://127.0.0.1:8765. Options: `--port 9000`, `--no-browser`.
To change the per-request kernel timeout (default 90 s), set `SCRIPTCAD_TIMEOUT`.
Imported USD files are copied to a per-user data folder: `%LOCALAPPDATA%\scriptcad\uploads`
on Windows, `~/.local/share/scriptcad/uploads` on Linux.

### From source

```bash
git clone <this repo>
cd scriptcad
uv sync          # creates .venv with Python 3.12 and the dev tools
uv run scriptcad
uv run pytest
```

## Using it

| | |
|---|---|
| Orbit / pan / zoom | left drag / right or middle drag / wheel |
| Selection filter | `1` body, `2` face, `3` edge (Shift/Ctrl-click to add) |
| Fit view | `F` |
| Measure | `M`, then click two points |
| Confirm / cancel a feature | `Enter` / `Esc` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Save / open project (`.scad.json`) | `Ctrl+S` / `Ctrl+O` |
| Run script | `Ctrl+Enter` |

To pre-fill a feature, select edges before you press **Fillet** or **Chamfer**,
or select two bodies before you press a **Combine** tool. While you pick edges
or faces for a feature, the model rolls back to the state just before that
feature.

## How it works

- `src/scriptcad/kernel.py` holds all the `usd_brep` calls. Each feature compiles to
  a Python snippet. Regeneration runs the snippets in order, then tessellates
  the bodies that remain, producing per-triangle face IDs, exact BRep edge
  polylines and mass properties. Edge and face picks are stored as 3D points
  and re-resolved with `find_edge`/`find_face`, so a reference still works
  after upstream edits as long as that geometry still exists.
- `src/scriptcad/server.py` is a FastAPI server. Kernel work runs in a separate
  worker process, which is restarted if it crashes or times out.
- `src/scriptcad/web/` holds the three.js viewport and the UI. There is no
  build step. three.js 0.169.0 and CodeMirror 5.65.16 are vendored in
  `web/vendor/` (both MIT, license files included), so the app works offline.

Scripts run as ordinary Python on your machine, so only run scripts you trust.
The server listens only on 127.0.0.1.

## License

Apache-2.0. See [LICENSE](LICENSE).
