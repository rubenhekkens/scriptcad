// Carve: remove the material a body does not use, voxel by voxel, and show the result.
//
// The body's voxel model (same supports, load, material and resolution as the analysis) is
// optimised in the browser by fea/topo.js: every step solves on the GPU and drops the voxels
// that work least, down to a share of the material or, with a deflection limit, to the
// lightest design that stays within it. The viewport shows the design after every step,
// smoothed and coloured by how hard the material works, with the original body as a ghost.
// The result is a mesh (STL download), not a feature tree: it shows where material belongs,
// for redrawing the part or printing it.

import { parse } from './fea/solver.js';
import { optimize, surface, smoothSurface, unindex, stl } from './fea/topo.js';
import { fieldColor } from './viewer.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 3) => x == null ? '—' : (+x.toPrecision(d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
// thinnest member (smoothing radius), in voxels at Normal resolution. Converted to mm for the
// body, so draft, normal and fine carve the same design, only resolved more or less finely
const DETAIL = { fine: [2.5, 'Fine'], medium: [4, 'Medium'], coarse: [6, 'Coarse'] };
const NORMAL_VOXELS = 200_000;                       // fea/analyze.py QUALITY_VOXELS['normal']
const memberMm = (detail, volume) => DETAIL[detail][0] * Math.cbrt(volume / NORMAL_VOXELS);

/** 99th percentile of the solid voxels' energies (from a sample), the top of the colour scale. */
function energyRef(P, energy) {
  const vals = [];
  for (let e = 0; e < energy.length; e += 7) if (P.emod[e]) vals.push(energy[e]);
  vals.sort((a, b) => a - b);
  return vals[Math.floor(0.99 * (vals.length - 1))] || 1;
}
// sqrt: energy goes with stress squared, so this reads roughly as stress over its 99th percentile
const tint = (v, ref) => fieldColor(Math.min(Math.sqrt(Math.max(v, 0) / ref), 1));

/** The current design as a mesh for the viewer: smoothed (default) or the raw voxels. */
function designMesh(P, energy, design, smooth) {
  const ref = energyRef(P, energy);
  if (smooth) {
    const m = smoothSurface(P, energy, design);
    const colors = new Float32Array(m.positions.length);
    for (let v = 0; v < m.vertexValue.length; v++) colors.set(tint(m.vertexValue[v], ref), 3 * v);
    return { positions: m.positions, normals: m.normals, colors, index: m.index };
  }
  const s = surface(P);
  const colors = new Float32Array(s.positions.length);
  for (let t = 0; t < s.triVoxel.length; t++) {
    const c = tint(energy[s.triVoxel[t]], ref);
    for (let v = 0; v < 3; v++) colors.set(c, 9 * t + 3 * v);
  }
  return { positions: s.positions, normals: s.normals, colors };
}

export function createCarve({ S, setup, gate, viewer, bodyLabel, buildCase, gpuSolver, render, toast }) {
  let run = null;       // { body, meta, steps: [{ fraction, dmax }], final, P, design, energy }
  let token = null, progress = '';
  const cfg = () => {
    const c = setup().carve ??= {};
    c.keep ??= 0.3; c.defl ??= null; c.detail ??= 'medium'; c.smooth ??= true;
    return c;
  };

  function show() {
    if (!run?.energy) return;
    run.mesh = designMesh(run.P, run.energy, run.design, cfg().smooth);
    viewer.setVoxelPreview(run.body, run.mesh);
  }

  async function start() {
    const body = setup().body;
    if (!body) return;
    const c = cfg();
    const t = token = gate.start();
    run = null;
    viewer.setVoxelPreview(null);
    progress = 'Building the voxel model…';
    render();
    const t0 = performance.now();
    try {
      const solver = await gpuSolver();
      const { meta, blob } = await buildCase(S.doc, body);
      if (!gate.alive(t)) return;
      const P = parse(blob);
      const design = Uint8Array.from(P.emod, e => e > 0 ? 1 : 0);
      run = { body, meta, steps: [], final: null, P, design, energy: null };
      const res = await optimize(blob, P, b => solver.solveMG(b, { tol: 1e-6 }), {
        // 3% per step: down to 10% takes ~75 steps, plus a few to settle
        target: c.keep, rmin: memberMm(c.detail, meta.cad_volume) / meta.h, maxDefl: c.defl == null ? null : c.defl / 1000, maxIter: 160,
        alive: () => gate.alive(t),
        onStep: async s => {
          if (!gate.alive(t)) return;
          run.steps.push({ fraction: s.fraction, dmax: s.dmax, over: s.over });
          run.energy = s.energy;
          show();
          progress = `Step ${s.iter + 1} · ${Math.round(s.fraction * 100)}% of the material · ${fmt(s.dmax * 1000)} µm`;
          render();
          // let the viewport show this step; a hidden tab gets no frames, so do not wait for one
          await new Promise(r => { requestAnimationFrame(r); setTimeout(r, 100); });
        },
      });
      if (!gate.alive(t)) { progress = 'Stopped. The viewport shows the last solved design.'; return; }
      // the last solve may have gone over the deflection limit: show the design that is kept
      run.final = { fraction: res.fraction, dmax: res.dmax };
      run.energy = res.energy;
      show();
      const secs = fmt((performance.now() - t0) / 1000, 2);
      progress = res.stop === 'deflection limit'
        ? `Lightest design within ${fmt(c.defl)} µm: the next step went over the limit (${run.steps.length} solves, ${secs} s)`
        : res.stop === 'target reached' ? `Reached ${Math.round(res.target * 100)}% of the material and settled (${run.steps.length} solves, ${secs} s)`
        : `Stopped at the step limit (${run.steps.length} solves, ${secs} s)`;
      if (res.raised) progress += `. The material at supports and loads alone is ${Math.round(res.minShare * 100)}%, so it aimed for ${Math.round(res.target * 100)}% instead of ${Math.round(c.keep * 100)}%`;
    } catch (e) {
      progress = `Failed: ${e.message}`;
      toast(e.message, true);
    } finally {
      if (token === t) token = null;
      gate.end(t);
      render();
    }
  }

  function stop() { if (token) { gate.cancel(); token = null; render(); } }

  function clear() { stop(); run = null; progress = ''; viewer.setVoxelPreview(null); render(); }

  function downloadStl() {
    if (!run?.mesh) return;
    const f = run.final ?? run.steps.at(-1);
    const name = `${bodyLabel(run.body).replace(/[^\w.-]+/g, '_')}_carved_${Math.round(f.fraction * 100)}pct`;
    const tris = run.mesh.index ? unindex(run.mesh.positions, run.mesh.index) : run.mesh.positions;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([stl(tris, name)], { type: 'model/stl' }));
    a.download = `${name}.stl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function summary() {
    const s0 = run.steps[0], s = run.final;
    if (!s0 || !s) return '';
    const m0 = run.meta.mass_g, m = s.fraction * m0;
    const stiff = (st, mass) => 1 / st.dmax / mass;
    const row = (label, st, mass) => `<tr><td>${label}</td><td>${fmt(mass)} g</td><td>${fmt(st.dmax * 1000)} µm</td><td>${fmt(stiff(st, mass) / stiff(s0, m0), 2)}×</td></tr>`;
    return `<table class="compare"><thead><tr><th></th><th>Mass</th><th title="Largest displacement">Defl.</th><th title="Stiffness per gram, relative to the original">Stiff/g</th></tr></thead><tbody>
      ${row('Original', s0, m0)}${row(`Carved to ${Math.round(s.fraction * 100)}%`, s, m)}</tbody></table>`;
  }

  function html() {
    const a = setup();
    const head = '<div class="panel-h sub explore-h"><span>Remove unused material</span></div>';
    if (!a.body) return `${head}<div class="muted small">Choose a body to carve.</div>`;
    const c = cfg(), mine = run && run.body === a.body;
    const volume = S.bodies.model.find(b => b.id === a.body)?.props.volume;
    return `${head}
      <div class="muted small">Carves <b>${esc(bodyLabel(a.body))}</b> on its voxel grid: solve, drop the voxels that work least, solve
        again. Material at supports and loads stays, and nothing grows outside the original shape.</div>
      <div class="field"><label for="cv_keep">Keep at least</label><select id="cv_keep" data-cv="keep">
        ${[0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map(v => `<option value="${v}" ${v === c.keep ? 'selected' : ''}>${Math.round(v * 100)}% of the material</option>`).join('')}</select></div>
      <div class="field"><label for="cv_defl" title="Stop at the lightest design whose largest displacement stays within this">Max deflection</label>
        <div class="unit-in"><input id="cv_defl" type="number" step="any" min="0" data-cv="defl" value="${c.defl ?? ''}" placeholder="none"><span>µm</span></div></div>
      <div class="field"><label for="cv_detail" title="Smoothing radius: thicker members are easier to make and to redraw">Smallest member</label><select id="cv_detail" data-cv="detail">
        ${Object.entries(DETAIL).map(([k, [r, l]]) => `<option value="${k}" ${k === c.detail ? 'selected' : ''}>${l}${volume ? ` (~${fmt(memberMm(k, volume), 2)} mm)` : ''}</option>`).join('')}</select></div>
      <div class="prop-actions">
        ${token ? '<button class="btn" id="cvStop">Stop</button>' : `<button class="btn primary" id="cvRun" ${gate.idle() ? '' : 'disabled'}>Carve</button>`}
        ${mine && !token ? '<button class="btn" id="cvClear">Show original</button>' : ''}
      </div>
      ${progress && (token || mine) ? `<div class="muted small an-status">${esc(progress)}</div>` : ''}
      ${mine ? `${token ? '' : summary()}
        <div class="field"><label for="cv_smooth">Surface</label><select id="cv_smooth" data-cv="smooth">
          <option value="1" ${c.smooth ? 'selected' : ''}>Smooth</option><option value="0" ${c.smooth ? '' : 'selected'}>Voxels (as solved)</option></select></div>
        ${run.mesh && !token ? '<div class="prop-actions"><button class="btn" id="cvStl">Download STL</button></div>' : ''}
        <div class="muted small">Colour: how hard the material works (blue idle, red busiest). The ghost is the original body.
          Mass and deflection are of the voxel design; the smooth surface is for viewing and printing.
          The result is a mesh to redraw the part from or to 3D print, not editable features.</div>` : ''}`;
  }

  function onClick(e) {
    const id = e.target.id;
    if (id === 'cvRun') start();
    else if (id === 'cvStop') stop();
    else if (id === 'cvClear') clear();
    else if (id === 'cvStl') downloadStl();
    else return false;
    return true;
  }

  function onChange(e) {
    const k = e.target.dataset.cv, c = cfg();
    if (k === undefined) return false;
    const v = e.target.value;
    if (k === 'keep') c.keep = +v;
    else if (k === 'defl') c.defl = v === '' || !(+v > 0) ? null : +v;
    else if (k === 'detail') c.detail = v;
    else if (k === 'smooth') { c.smooth = v === '1'; show(); }
    render();
    return true;
  }

  // the model changed: the carved design belongs to the old geometry
  function reset() { stop(); run = null; progress = ''; viewer.setVoxelPreview(null); }

  return { html, onClick, onChange, reset, busy: () => !!token };
}
