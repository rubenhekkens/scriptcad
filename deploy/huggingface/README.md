---
title: ScriptCAD
emoji: 🪑
colorFrom: gray
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
short_description: CAD in the browser that carves parts to their stiffest shape
---

# ScriptCAD: online demo

Parametric CAD in the browser on NVIDIA's open-source SMLib kernel (USD BRep), with stress
analysis and **Carve**: it removes the material that does the least work until the shape with
the most stiffness for its weight is left.

The demo opens with the Bone-inspired lounge chair. Press **Run all**, then **Carve** under
*Remove unused material*. Every step is a real stress solve on your own GPU, in your browser.

- **Browser:** a recent Chrome or Edge on a computer (it needs WebGPU). A dedicated GPU is
  fastest; the chair at Fine resolution takes about 5 minutes on an RTX 5070.
- **Online limits:** the Script tab and voice commands are off, and the server is shared, so
  it can be slower when busy. For everything, install it on your own computer:
  [github.com/rubenhekkens/scriptcad](https://github.com/rubenhekkens/scriptcad).

Source and documentation: [GitHub](https://github.com/rubenhekkens/scriptcad). Apache-2.0.
