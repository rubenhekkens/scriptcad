"""Speech to text with Whisper on this computer (faster-whisper), for spoken commands.

faster-whisper may live in another Python than ScriptCAD's own, so it runs as a helper
process (whisper_worker.py) with whichever interpreter has it: SCRIPTCAD_WHISPER_PYTHON if
set, else this one, else any the Windows launcher (py) lists. It starts on the first request
and keeps the model loaded: SCRIPTCAD_WHISPER_MODEL, else the best English one in the Hugging
Face cache (small.en, then base.en). Nothing is downloaded.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

PREFERRED = ["small.en", "base.en", "tiny.en"]                   # better first


def pick_model() -> str:
    """SCRIPTCAD_WHISPER_MODEL, else the best of PREFERRED already in the Hugging Face cache."""
    if os.environ.get("SCRIPTCAD_WHISPER_MODEL"):
        return os.environ["SCRIPTCAD_WHISPER_MODEL"]
    hub = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub")
    return next((m for m in PREFERRED if any((hub / f"models--Systran--faster-whisper-{m}" / "snapshots").glob("*/model.bin"))), "base.en")
WORKER = Path(__file__).with_name("whisper_worker.py")


class SpeechError(Exception):
    pass


def _has_whisper(python: str) -> bool:
    try:
        return subprocess.run([python, "-c", "import faster_whisper"], capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def find_python() -> str | None:
    """An interpreter that can import faster_whisper, or None."""
    if os.environ.get("SCRIPTCAD_WHISPER_PYTHON"):
        return os.environ["SCRIPTCAD_WHISPER_PYTHON"]
    candidates = [sys.executable]
    if shutil.which("py"):
        try:
            out = subprocess.run(["py", "-0p"], capture_output=True, text=True, timeout=30).stdout
            candidates += [line.split()[-1] for line in out.splitlines() if line.strip().lower().endswith(".exe")]
        except (OSError, subprocess.TimeoutExpired):
            pass
    return next((p for p in candidates if _has_whisper(p)), None)


class _Worker:
    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None
        self.info = None

    def _start(self):
        python = find_python()
        if not python:
            raise SpeechError("no Python with faster-whisper found: pip install faster-whisper, "
                              "or point SCRIPTCAD_WHISPER_PYTHON at the python.exe that has it")
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        model = pick_model()
        self.proc = subprocess.Popen([python, "-u", str(WORKER), model], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, encoding="utf-8", env=env)
        line = self.proc.stdout.readline()
        if not line:
            self.proc = None
            raise SpeechError(f"Whisper did not start: is the {model} model downloaded (in the Hugging Face cache)?")
        self.info = {**json.loads(line), "python": python}

    def transcribe(self, path: str, prompt: str) -> dict:
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            self.proc.stdin.write(json.dumps({"audio": path, "prompt": prompt}) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
            if not line:
                self.proc = None
                raise SpeechError("Whisper stopped while transcribing")
            out = json.loads(line)
            if "error" in out:
                raise SpeechError(out["error"])
            return {"text": out["text"], "device": out.get("device"), "model": self.info["model"]}


_worker = _Worker()


def warm():
    """Start the helper and load the model now, if it is not running yet."""
    with _worker.lock:
        if _worker.proc is None or _worker.proc.poll() is not None:
            try:
                _worker._start()
            except SpeechError:
                pass                                 # reported on the first transcription instead


def transcribe(audio: bytes, suffix: str = ".webm", prompt: str = "") -> dict:
    """What was said in a recording (any format FFmpeg reads: WebM/Opus from a browser)."""
    if not audio:
        raise SpeechError("the recording is empty")
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="scriptcad_voice_")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(audio)
        return _worker.transcribe(path, prompt)
    finally:
        os.unlink(path)
