I've written up research for this request: `fea-research-rubenhekkens.md` (attached / linked). It's shared under MIT OR Apache-2.0, and it follows the issue's section layout and house rules. Every claim is cited or marked "(unverified)". I didn't read any copyleft source code or drive any commercial software.

It covers all the fundamentals, accuracy sources and programs listed above. These parts get the most detail:

- **Tiers:** single-body linear static first (as in #6971), then everything else.
- **Volume meshing as the bottleneck:** mesher licences, robustness numbers on Thingi10k, and how accurate mesh-avoiding methods are (voxel FEM, finite cell / immersed boundary, meshless), with a note on who published each number.
- **Solvers that suit GPUs and browsers:** matrix-free, multigrid, PCG and mixed precision, library licences, and the WebGPU/WGSL and wasm limits.
- **Live-in-CAD tools and ML surrogates,** and how far their results can be trusted.
- **A benchmark set with analytic or published reference values** that could serve as test fixtures.

The About section includes a short personal spike: a voxel solver running in WebGPU in the browser, measured against closed-form results.

Gaps are listed under Open questions. The biggest are community vote counts and the paywalled NAFEMS and ASME material. Corrections are welcome.
