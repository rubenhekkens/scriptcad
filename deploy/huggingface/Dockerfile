# ScriptCAD's online demo on Hugging Face Spaces (Docker SDK, CPU).
#
# The server does the geometry (NVIDIA's USD BRep kernel) and builds the voxel models; the stress
# solves and the carving run on each visitor's own GPU, in their browser (WebGPU). So a CPU Space
# is enough. SCRIPTCAD_PUBLIC=1 turns off everything that runs code or reads the server's files
# (the Script tab, script exports, imports of paths not uploaded here, voice, benchmarks).
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git libgomp1 libgl1 libglib2.0-0 libxrender1 libxext6 \
 && rm -rf /var/lib/apt/lists/*

# Spaces run the container as user 1000
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    SCRIPTCAD_PUBLIC=1 \
    SCRIPTCAD_HOST=0.0.0.0 \
    SCRIPTCAD_PORT=7860 \
    SCRIPTCAD_TIMEOUT=60

# The version to serve: a branch, tag or commit of the GitHub repository
ARG SCRIPTCAD_REF=main
RUN pip install --no-cache-dir --user "scriptcad[sim] @ git+https://github.com/rubenhekkens/scriptcad@${SCRIPTCAD_REF}"

EXPOSE 7860
CMD ["scriptcad", "--no-browser"]
