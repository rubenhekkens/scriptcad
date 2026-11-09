"""Whisper, as a helper process: speech.py starts this with a Python that has faster-whisper
(which ScriptCAD's own environment need not have), and it keeps the model loaded. One JSON
request per line on stdin, {"audio": path, "prompt": words to expect}; one JSON answer per
line on stdout, {"text": ...} or {"error": ...}. The first line out says it is ready.

Imports nothing from ScriptCAD: it runs in another interpreter.
"""

import glob
import json
import os
import sys


def cuda_dlls():
    """On Windows, let CTranslate2 find CUDA libraries installed as pip packages
    (nvidia-cublas-cu12 and the like put their DLLs in site-packages/nvidia/*/bin, a folder
    Windows does not search)."""
    if os.name != "nt":
        return
    import site
    for root in site.getsitepackages() + [site.getusersitepackages()]:
        for bin_dir in sorted(glob.glob(os.path.join(root, "nvidia", "*", "bin"))):
            os.add_dll_directory(bin_dir)
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def load(name, device):
    from faster_whisper import WhisperModel
    return WhisperModel(name, device=device, compute_type="float16" if device == "cuda" else "int8")


def decode(path):
    """The recording as 16 kHz mono float samples. Done here rather than by faster-whisper,
    whose decoder passes an argument newer PyAV releases no longer take."""
    import av
    import numpy as np
    out = []
    with av.open(path) as f:
        rs = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in f.decode(audio=0):
            for r in rs.resample(frame):
                out.append(r.to_ndarray().reshape(-1))
        for r in rs.resample(None):
            out.append(r.to_ndarray().reshape(-1))
    return (np.concatenate(out) if out else np.zeros(0, np.int16)).astype(np.float32) / 32768.0


def transcribe(model, req):
    segments, _ = model.transcribe(decode(req["audio"]), beam_size=req.get("beam", 5), initial_prompt=req.get("prompt") or None,
                                   vad_filter=True, condition_on_previous_text=False)
    return " ".join(s.text.strip() for s in segments).strip()


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "base.en"
    # the GPU if CUDA works here, else the CPU (on the CPU base.en takes about 0.9 s for a command, small.en 2.7 s)
    try:
        device, model = "cuda", load(name, "cuda")
    except Exception:
        device, model = "cpu", load(name, "cpu")
    print(json.dumps({"ready": True, "model": name, "device": device}), flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
            try:
                text = transcribe(model, req)
            except Exception:
                if device != "cuda":
                    raise
                # a CUDA library (cuBLAS, cuDNN) that is only missed at the first transcription
                device, model = "cpu", load(name, "cpu")
                text = transcribe(model, req)
            print(json.dumps({"text": text, "device": device}), flush=True)
        except Exception as e:
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")     # use the model already on disk; never download one
    cuda_dlls()
    main()
