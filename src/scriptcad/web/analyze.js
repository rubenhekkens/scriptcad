// Analyze mode: linear-elastic stress on one or more bodies, solved on the user's GPU in the browser.
//
// The server voxelizes the body and maps the picked faces to supports and loads
// (/api/analyze); the browser solves with WebGPU multigrid (fea/multigrid.js) and sends
// the displacements back (/api/analyze/result) for von Mises on the viewer mesh.
// The setup lives in doc.analysis, so it is saved with the project and survives regens:
// faces are stored as 3D reference points and re-resolved on the current geometry.
// Each body keeps its own supports and load faces; material, resolution and the load itself
// are shared, so several designs can be compared under identical conditions.

import { fieldColor } from './viewer.js';
import { createExplore } from './explore.js';
import { createCarve } from './carve.js';

// not in the stress colour ramp (blue -> teal -> yellow -> red), so they read on top of results
const MARK = { fixed: 0x2fe06b, load: 0xff4fd8 };
// underused-material view: material that carries little stress, on neutral grey
const WASTE = [0.98, 0.66, 0.1], WORK = [0.72, 0.74, 0.78];
const wasteColor = t => {                     // t = stress / threshold; soft edge over 0.8..1
  const f = Math.min(Math.max((t - 0.8) / 0.2, 0), 1);
  return WASTE.map((v, k) => v + (WORK[k] - v) * f);
};
const hex = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
const DEFAULT_SETUP = () => ({
  body: null, material: 'aluminium', quality: 'normal', live: true,
  load: { type: 'force', vector: [0, 0, -1000], pressure: 1, torque: 10, axis: 'Z' },
  bodies: {},                       // body id -> { fixed: [points], loads: [points] }
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 3) => x == null ? '—' : (+x.toPrecision(d)).toLocaleString(undefined, { maximumFractionDigits: 6 });

/** Squared distance from point p to the triangle stored at P[o..o+8] (Ericson, RTCD 5.1.5). */
function pointTriangleDist2(p, P, o) {
  const a = [P[o], P[o + 1], P[o + 2]], b = [P[o + 3], P[o + 4], P[o + 5]], c = [P[o + 6], P[o + 7], P[o + 8]];
  const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) q = b;
    else if (d6 >= 0 && d5 <= d6) q = c;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); q = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
    } else {
      const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
    }
  }
  const d = sub(p, q);
  return dot(d, d);
}

/** Result blob from /api/analyze/result (layout in fea/analyze.py result_blob). */
function parseField(buf) {
  const n = new Uint32Array(buf, 0, 1)[0];
  let o = 4;
  const f32 = len => { const a = new Float32Array(buf, o, len); o += 4 * len; return a; };
  const positions = f32(3 * n), normals = f32(3 * n), vonMises = f32(n), displacement = f32(3 * n);
  const triFace = new Int32Array(buf, o, n / 3);
  return { positions, normals, vonMises, displacement, triFace };
}

export function createAnalyze({ S, viewer, toast, bodies, bodyLabel, refOf, onChange, setVariables }) {
  let on = false;
  let pickTarget = null;           // 'fixed' | 'load' | null
  let solver = null, gpu = null, gpuError = null;
  let seq = 0, timer = null, busy = false, status = '';
  const results = new Map();       // body id -> { meta, stats, values, displacement, solve, stale, positions }
  let materials = null;
  let cap = 'p99', deform = 0;     // deformation drawn as this fraction of the part size (0 = off)
  let view = 'stress', idle = 0.2; // 'waste': shade material below idle x the body's 99th-percentile stress

  // ---- setup (with migration from the single-body format) --------------------------
  const setup = () => {
    S.doc.analysis ??= DEFAULT_SETUP();
    const a = S.doc.analysis;
    a.load ??= DEFAULT_SETUP().load;
    a.bodies ??= {};
    if (a.fixed || a.load.faces) {                       // projects saved before multi-body
      if (a.body) a.bodies[a.body] = { fixed: a.fixed || [], loads: a.load.faces || [] };
      delete a.fixed;
      delete a.load.faces;
    }
    return a;
  };
  const bodySetup = id => {
    const a = setup();
    return (a.bodies[id] ??= { fixed: [], loads: [] });
  };
  const solids = () => bodies().filter(b => b.props.manifold);
  const ready = id => {
    const b = setup().bodies[id];
    return !!(b && b.fixed.length && b.loads.length && solids().some(x => x.id === id));
  };
  const readyIds = () => solids().map(b => b.id).filter(ready);

  // ---- GPU -----------------------------------------------------------------------
  async function ensureSolver() {
    if (solver || gpuError) return solver;
    try {
      const { VoxelSolver } = await import('./fea/solver.js');
      solver = await VoxelSolver.create();
      const i = solver.adapter.info || {};
      gpu = { vendor: i.vendor || 'unknown', architecture: i.architecture || '', description: i.description || '' };
    } catch (e) {
      gpuError = e.message || String(e);
    }
    return solver;
  }
  const integrated = () => gpu && (gpu.vendor === 'intel' || /integrated|uhd|iris|xe-?lp/i.test(`${gpu.architecture} ${gpu.description}`));

  // ---- faces ----------------------------------------------------------------------
  // A stored face is any 3D point on it (like the kernel's faces_at): resolve it to the face
  // of the mesh triangle nearest to the point, so it survives edits that renumber faces.
  function faceOf(b, r) {
    const P = b.positions, F = b.triFace;
    let best = -1, bd = Infinity;
    for (let t = 0; t < F.length; t++) {
      const d = pointTriangleDist2(r, P, 9 * t);
      if (d < bd) { bd = d; best = F[t]; }
    }
    return best;
  }
  function faceIndices(bodyId, refs) {
    const b = bodies().find(x => x.id === bodyId);
    if (!b) return [];
    return [...new Set(refs.map(r => faceOf(b, r)).filter(i => i >= 0))];
  }

  function syncMarks() {
    // markers sit on the undeformed mesh, so hide them while the deformed shape is shown
    if (!on || (deform && fresh().length)) return viewer.setMarks([]);
    // over a result, a solid fill would hide the stress on exactly those faces: tint + outline
    const marks = [];
    for (const [id, b] of Object.entries(setup().bodies)) {
      const shown = results.has(id) && !results.get(id).stale;
      // the underused view is two colours only, so a tint would read as a third: outline only
      const opacity = shown ? (view === 'waste' ? 0 : 0.18) : 0.8;
      for (const index of faceIndices(id, b.fixed)) marks.push({ bodyId: id, index, color: MARK.fixed, opacity });
      for (const index of faceIndices(id, b.loads)) marks.push({ bodyId: id, index, color: MARK.load, opacity });
    }
    viewer.setMarks(marks);
  }

  function onPick(hit) {
    if (!hit || hit.kind !== 'face') return;
    const a = setup();
    a.body = hit.bodyId;                                 // clicking another body makes it the active one
    const bs = bodySetup(hit.bodyId);
    const b = bodies().find(x => x.id === hit.bodyId);
    const without = refs => refs.filter(r => faceOf(b, r) !== hit.index);
    const mine = pickTarget === 'fixed' ? bs.fixed : bs.loads;
    const picked = mine.some(r => faceOf(b, r) === hit.index);
    // clicking a picked face unpicks it; a face is either a support or a load, never both
    bs.fixed = without(bs.fixed);
    bs.loads = without(bs.loads);
    if (!picked) (pickTarget === 'fixed' ? bs.fixed : bs.loads).push(refOf(hit));
    results.delete(hit.bodyId);
    apply();
    changed([hit.bodyId]);
  }

  function startPick(target) {
    pickTarget = pickTarget === target ? null : target;
    viewer.setMode(pickTarget ? 'face' : 'body');
    onChange();
    render();
  }

  // ---- run -----------------------------------------------------------------------
  function schedule(ids, delay = 350) {
    clearTimeout(timer);
    timer = setTimeout(() => run(ids), delay);
  }

  async function gpuSolver() {
    await ensureSolver();
    if (!solver) throw new Error(`WebGPU is not available in this browser (${gpuError}). Use a recent Chrome or Edge.`);
    return solver;
  }

  /** The server's voxel model of one body of `doc`, with this setup's supports and load. */
  async function buildCase(doc, id) {
    const a = setup(), bs = a.bodies[id];
    const payload = { doc, setup: { body: id, material: a.material, quality: a.quality, fixed: bs.fixed,
                                    load: { ...a.load, faces: bs.loads } } };
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`${bodyLabel(id)}: ${(await r.json().catch(() => ({}))).detail || r.statusText}`);
    return { caseId: r.headers.get('X-Case-Id'), meta: JSON.parse(r.headers.get('X-Meta') || '{}'), blob: await r.arrayBuffer() };
  }

  /**
   * One body of `doc`: the server voxelizes it, the GPU solves, the server computes the
   * stresses. field=false returns the statistics only (Explore). say(text) reports progress.
   */
  async function solveOne(doc, id, field = true, say = () => {}) {
    await gpuSolver();
    say('building the voxel model…');
    const { caseId, meta, blob } = await buildCase(doc, id);
    say(`solving ${meta.free_dofs.toLocaleString()} unknowns on the GPU…`);
    const sol = await solver.solveMG(blob, { tol: 1e-6 });
    say('computing stresses…');
    const rr = await fetch(`/api/analyze/result?id=${caseId}${field ? '' : '&field=false'}`, { method: 'POST', body: sol.u });
    if (!rr.ok) throw new Error(`${bodyLabel(id)}: ${(await rr.json().catch(() => ({}))).detail || rr.statusText}`);
    const stats = JSON.parse(rr.headers.get('X-Stats') || '{}');
    return { meta, stats, sol, field: field ? parseField(await rr.arrayBuffer()) : null };
  }

  /** Solve the given bodies (default: every body that is set up), one after another. */
  async function run(ids = readyIds()) {
    ids = ids.filter(ready);
    if (!ids.length) { render(); return; }
    const my = ++seq;
    busy = true;
    try {
      for (const [k, id] of ids.entries()) {
        const tag = ids.length > 1 ? `${bodyLabel(id)} (${k + 1}/${ids.length}): ` : '';
        const { meta, stats, sol, field } = await solveOne(S.doc, id, true, s => { if (my === seq) { status = tag + s; render(); } });
        if (my !== seq) return;
        results.set(id, { meta, stats, values: field.vonMises, displacement: field.displacement,
                          mesh: { positions: field.positions, normals: field.normals, triFace: field.triFace },
                          solve: { ms: sol.setupMs + sol.solveMs, iterations: sol.iterations }, stale: false,
                          cadLength: bodies().find(x => x.id === id)?.positions.length });
        apply();
      }
      status = '';
    } catch (e) {
      if (my === seq) { toast(e.message, true); status = `Failed: ${e.message}`; }
    } finally {
      if (my === seq) { busy = false; render(); }
    }
  }

  // one colour scale and one deformation scale for every body, so designs compare directly
  function fresh() { return [...results.entries()].filter(([, r]) => !r.stale); }
  function capValue() {
    const rs = fresh().map(([, r]) => r.stats);
    if (!rs.length) return 1;
    const pick = s => ({ p99: s.p99, p999: s.p999, away: s.max_away ?? s.max, max: s.max }[cap] ?? s.p99);
    return Math.max(...rs.map(pick));
  }
  function autoScale() {
    let size = 0, dmax = 0;
    for (const [id, r] of fresh()) {
      const b = bodies().find(x => x.id === id);
      if (!b) continue;
      const [lo, hi] = b.props.bbox;
      size = Math.max(size, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
      dmax = Math.max(dmax, r.stats.max_displacement);
    }
    return dmax ? (deform || 0.05) * size / dmax : 0;    // largest displacement drawn as that fraction of the largest part
  }

  // Underused material: von Mises below `idle` x the body's own 99th percentile, so the
  // measure is how evenly a design loads its material, not how stressed it is overall
  // (a stiffer design has lower stresses everywhere). Volume fraction from voxel percentiles.
  const idleStress = r => idle * r.stats.p99;
  function underused(r) {
    const q = r.stats.vm_pct, s = idleStress(r);
    if (!q) return null;
    if (s <= q[0]) return 0;
    for (let i = 1; i < q.length; i++) if (s <= q[i]) return (i - 1 + (s - q[i - 1]) / ((q[i] - q[i - 1]) || 1)) / 100;
    return 1;
  }

  function apply() {
    if (!on) return;
    viewer.clearField();
    const c = capValue();
    for (const [id, r] of results) {
      const b = bodies().find(x => x.id === id);
      if (r.stale || !b || b.positions.length !== r.cadLength) { r.stale = true; continue; }
      if (view === 'waste') viewer.setField(id, r.values, idleStress(r), r.displacement, r.mesh, wasteColor);
      else viewer.setField(id, r.values, c, r.displacement, r.mesh);
    }
    viewer.setDeformation(deform ? autoScale() : 0);
    syncMarks();
    render();
  }

  function changed(ids) {
    syncMarks();
    onChange();
    render();
    if (setup().live) {
      const todo = (ids || readyIds()).filter(ready);
      if (todo.length) schedule(todo);
    }
  }

  // Explore and Carve share the GPU with Run: whichever starts last cancels the others. A
  // queued live run waits until they are done, then solves whatever is still missing.
  const gate = {
    start() { clearTimeout(timer); busy = true; status = ''; return ++seq; },
    alive: t => t === seq,
    end(t) {
      if (t !== seq) return;
      busy = false;
      const missing = readyIds().filter(id => !results.get(id) || results.get(id).stale);
      if (on && setup().live && missing.length) schedule(missing, 0);
    },
    cancel() { seq++; busy = false; },
    idle: () => !busy,
  };
  const explore = createExplore({
    S, setup, bodyLabel, setVariables, toast, gate, render: () => render(),
    solveStats: (doc, id) => solveOne(doc, id, false),
  });
  const carve = createCarve({ S, setup, gate, viewer, bodyLabel, buildCase, gpuSolver, toast, render: () => render() });

  // ---- panel ---------------------------------------------------------------------
  let host = null;
  function render() {
    // the panel is shared with the feature editor, which wins while a feature is open
    if (!host || !on || S.editing) return;
    const a = setup();
    const list = solids();
    const active = list.some(b => b.id === a.body) ? a.body : null;   // display only: the model may still be loading
    const bs = active ? bodySetup(active) : { fixed: [], loads: [] };
    const L = a.load;
    const mats = materials || { aluminium: 'Aluminium', steel: 'Steel' };
    const pick = (key, label, count, color) => `
      <div class="field"><label><span class="swatch" style="background:#${color.toString(16).padStart(6, '0')}"></span>${label}</label>
        <div class="pick ${pickTarget === key ? 'active' : ''}" data-apick="${key}">
          <span class="cnt">${pickTarget === key ? `Picking… ${count}` : count ? `${count} face${count === 1 ? '' : 's'}` : 'none'}</span>
          ${count ? `<button data-aclear="${key}">Clear</button>` : ''}
          <button data-apickbtn="${key}">${pickTarget === key ? 'Done' : 'Pick'}</button></div></div>`;
    const num = (k, label, v, unit) => `<div class="field"><label for="an_${k}">${label}</label>
      <div class="unit-in"><input id="an_${k}" data-ak="${k}" type="number" step="any" value="${v}"><span>${unit}</span></div></div>`;
    let loadRows = '';
    if (L.type === 'force') loadRows = num('fx', 'Force X', L.vector[0], 'N') + num('fy', 'Force Y', L.vector[1], 'N') + num('fz', 'Force Z', L.vector[2], 'N');
    if (L.type === 'pressure') loadRows = num('pressure', 'Pressure', L.pressure, 'MPa');
    if (L.type === 'torque') loadRows = num('torque', 'Torque', L.torque, 'N·m') +
      `<div class="field"><label for="an_axis">About axis</label><select id="an_axis" data-ak="axis">${['X', 'Y', 'Z'].map(x => `<option ${x === L.axis ? 'selected' : ''}>${x}</option>`).join('')}</select></div>`;

    const nReady = readyIds().length;
    const rows = fresh();
    const cv = capValue();
    let compare = '';
    if (rows.length) {
      const stiff = r => (r.stats.max_displacement ? 1 / r.stats.max_displacement : 0) / (r.meta.mass_g || 1);
      const vals = f => rows.map(([, r]) => f(r));
      const bMass = Math.min(...vals(r => r.meta.mass_g)), bDisp = Math.min(...vals(r => r.stats.max_displacement)),
            bP99 = Math.min(...vals(r => r.stats.p99)), bStiff = Math.max(...vals(stiff)), ref = Math.min(...vals(stiff)),
            bIdle = Math.min(...vals(r => underused(r) ?? 1));
      const td = (isBest, text, title = '') => `<td class="${isBest ? 'best' : ''}"${title ? ` title="${title}"` : ''}>${text}</td>`;
      const pct = Math.round(idle * 100);
      compare = `
        <table class="compare"><thead><tr><th>Design</th><th>Mass</th><th title="Largest displacement">Defl.</th><th title="Von Mises, 99th percentile">Stress</th><th title="Stiffness per gram, relative to the lowest">Stiff/g</th><th title="Share of the volume below ${pct}% of the design's own 99th-percentile stress">Idle</th></tr></thead><tbody>
        ${rows.map(([id, r]) => { const u = underused(r); return `<tr class="${id === a.body ? 'on' : ''}" data-abody="${id}"><td>${esc(bodyLabel(id))}</td>
          ${td(r.meta.mass_g === bMass, `${fmt(r.meta.mass_g)} g`)}
          ${td(r.stats.max_displacement === bDisp, `${fmt(r.stats.max_displacement * 1000)} µm`)}
          ${td(r.stats.p99 === bP99, `${fmt(r.stats.p99)}<small> MPa</small>`)}
          ${td(stiff(r) === bStiff, `${fmt(stiff(r) / ref, 2)}×`)}
          ${u == null ? '<td>—</td>' : td(u === bIdle, `${Math.round(u * 100)}%`, `${fmt(u * r.meta.mass_g, 2)} g underused`)}</tr>`; }).join('')}
        </tbody></table>
        <div class="muted small">Same material, load and type of supports for every design; best in each column highlighted.
          Defl. = largest deflection, Stress = 99th-percentile von Mises, Stiff/g = stiffness per gram relative to the lowest,
          Idle = share of the material carrying less than ${pct}% of the design's own 99th-percentile stress.</div>`;
    }
    const r = a.body && results.get(a.body);
    const detail = r && !r.stale ? `
      <dl>
        <dt>Von Mises, median</dt><dd>${fmt(r.stats.p50)} MPa</dd>
        <dt>Von Mises, 99th pct</dt><dd>${fmt(r.stats.p99)} MPa</dd>
        <dt>Max away from loads/supports</dt><dd>${fmt(r.stats.max_away)} MPa</dd>
        <dt title="Next to supports and load faces the peak is singular: it keeps rising as voxels get finer">Max at loads (not converged) ⓘ</dt><dd>${fmt(r.stats.max)} MPa</dd>
        <dt>Max displacement</dt><dd>${fmt(r.stats.max_displacement * 1000)} µm</dd>
        ${underused(r) == null ? '' : `<dt title="Below ${Math.round(idle * 100)}% of this body's 99th-percentile stress">Underused material</dt>
          <dd>${Math.round(underused(r) * 100)}% (${fmt(underused(r) * r.meta.mass_g, 2)} g)</dd>`}
      </dl>
      <div class="muted small">${esc(bodyLabel(a.body))}: ${r.meta.solid_voxels.toLocaleString()} voxels of ${r.meta.h} mm · ${r.meta.free_dofs.toLocaleString()} unknowns ·
        solved in ${fmt(r.solve.ms / 1000, 2)} s (${r.solve.iterations} multigrid iterations) · ${esc(r.meta.material)}, ${esc(r.meta.applied)}</div>` :
      ([...results.values()].some(x => x.stale) ? '<div class="hint">The model changed since the last run. Press Run.</div>' : '');
    const scale = view === 'waste' ? `
      <div class="legend waste"><span><i style="background:${hex(WASTE)}"></i>underused</span><span><i style="background:${hex(WORK)}"></i>working</span></div>
      <div class="field"><label for="an_idle">Underused below</label><select id="an_idle" data-aidle>
        ${[0.1, 0.2, 0.3].map(v => `<option value="${v}" ${v === idle ? 'selected' : ''}>${v * 100}% of the 99th-pct stress</option>`).join('')}</select></div>
      <div class="muted small">Shaded material carries little load in this load case: a candidate for removal, or for moving
        to where it would work (further from the middle of a bending section, for example). Each body is judged against
        its own stress level. Only the surface is shaded; the Idle column counts the whole volume.</div>` : `
      <div class="legend"><div class="bar" style="background:linear-gradient(90deg,${[0, .25, .5, .75, 1].map(t => hex(fieldColor(t))).join(',')})"></div>
        <div class="ticks"><span>0</span><span>${fmt(cv / 2)}</span><span>${fmt(cv)} MPa${cap === 'max' ? '' : '+'}</span></div></div>
      <div class="field"><label for="an_cap">Colour scale</label><select id="an_cap" data-acap>
        ${[['p99', 'to 99th percentile'], ['p999', 'to 99.9th percentile'], ['away', 'to max away from loads'], ['max', 'to absolute max']]
          .map(([v, l]) => `<option value="${v}" ${v === cap ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    const legend = rows.length ? `
      <div class="field"><label for="an_view">Show</label><select id="an_view" data-aview>
        ${[['stress', 'Stress'], ['waste', 'Underused material']].map(([v, l]) => `<option value="${v}" ${v === view ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${scale}
      <div class="field"><label for="an_def">Deformed shape</label><select id="an_def" data-adeform>
        ${[[0, 'Off'], [0.05, 'Exaggerated'], [0.15, 'Strongly exaggerated']].map(([v, l]) => `<option value="${v}" ${v === deform ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${deform ? `<div class="muted small">Displacements drawn ×${fmt(autoScale(), 2)}, the same for every body.</div>` : ''}` : '';

    const gpuLine = gpuError ? `<div class="feat-err">WebGPU unavailable: ${esc(gpuError)}</div>` :
      gpu ? `<div class="muted small">GPU: ${esc(gpu.vendor)} ${esc(gpu.architecture)}${integrated() ?
        ' <b class="warn">(integrated)</b></div><div class="hint">On a laptop with a discrete GPU, results are several times faster: set your browser to <b>High performance</b> in Windows Settings › System › Display › Graphics, then fully quit and reopen it.' : ''}</div>` : '';

    host.innerHTML = `
      <div class="hint">Linear-elastic stress, solved on your GPU in the browser. For comparing designs, not for sign-off.</div>
      <div class="field"><label for="an_body">Body</label><select id="an_body" data-ak="body"><option value="">— pick a face to choose —</option>
        ${list.map(b => `<option value="${b.id}" ${b.id === active ? 'selected' : ''}>${esc(bodyLabel(b.id))}${ready(b.id) ? ' ✓' : ''}</option>`).join('')}</select></div>
      ${pick('fixed', 'Fixed faces', bs.fixed.length, MARK.fixed)}
      ${pick('load', 'Load faces', bs.loads.length, MARK.load)}
      <div class="field"><label for="an_mat">Material</label><select id="an_mat" data-ak="material">
        ${Object.entries(mats).map(([k, l]) => `<option value="${k}" ${k === a.material ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label for="an_type">Load</label><select id="an_type" data-ak="type">
        ${[['force', 'Force (total)'], ['pressure', 'Pressure'], ['torque', 'Torque']].map(([v, l]) => `<option value="${v}" ${v === L.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${loadRows}
      <div class="field"><label for="an_q">Resolution</label><select id="an_q" data-ak="quality">
        ${[['draft', 'Draft (~60k voxels)'], ['normal', 'Normal (~200k)'], ['fine', 'Fine (~600k)']].map(([v, l]) => `<option value="${v}" ${v === a.quality ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <label class="check-row"><input type="checkbox" data-ak="live" ${a.live ? 'checked' : ''}> Re-run when the model changes</label>
      <div class="muted small">Material, load and resolution apply to every body; each body has its own fixed and load faces.</div>
      <div class="prop-actions">
        <button class="btn" id="anRun" ${active && ready(active) && !busy ? '' : 'disabled'}>Run this body</button>
        <button class="btn primary" id="anRunAll" ${nReady && !busy ? '' : 'disabled'}>${busy ? 'Running…' : `Run all (${nReady})`}</button></div>
      ${status ? `<div class="muted small an-status">${esc(status)}</div>` : ''}
      ${!nReady ? '<div class="muted small">Pick at least one fixed face and one load face on a body.</div>' : ''}
      ${compare}
      ${legend}
      ${detail}
      ${explore.html()}
      ${carve.html()}
      ${gpuLine}`;
  }

  function bind(el) {
    host = el;
    el.addEventListener('click', e => {
      if (!on || explore.onClick(e) || carve.onClick(e)) return;
      const a = setup();
      if (e.target.id === 'anRun') return run([a.body]);
      if (e.target.id === 'anRunAll') return run();
      const row = e.target.closest('[data-abody]');
      if (row) { a.body = row.dataset.abody; onChange(); return render(); }
      const clear = e.target.dataset.aclear;
      if (clear && a.body) {
        const bs = bodySetup(a.body);
        if (clear === 'fixed') bs.fixed = []; else bs.loads = [];
        results.delete(a.body);
        apply();
        return changed([]);
      }
      const pb = e.target.closest('[data-apickbtn],[data-apick]');
      if (pb) {
        const key = pb.dataset.apickbtn || pb.dataset.apick;
        if (pickTarget === key && !e.target.dataset.apickbtn) return;
        startPick(key);
      }
    });
    el.addEventListener('change', e => {
      if (!on) return;
      if (explore.onChange(e) || carve.onChange(e)) return onChange();
      const a = setup(), L = a.load, t = e.target, k = t.dataset.ak;
      if (t.dataset.acap !== undefined) { cap = t.value; return apply(); }
      if (t.dataset.aview !== undefined) { view = t.value; return apply(); }
      if (t.dataset.aidle !== undefined) { idle = +t.value; return apply(); }
      if (t.dataset.adeform !== undefined) { deform = +t.value; viewer.setDeformation(deform ? autoScale() : 0); syncMarks(); return render(); }
      if (!k) return;
      const v = t.type === 'number' ? +t.value : t.type === 'checkbox' ? t.checked : t.value;
      if (t.type === 'number' && !isFinite(v)) return;
      if (k === 'body') { a.body = v || null; onChange(); return render(); }
      if (k === 'live') { a.live = v; onChange(); return render(); }
      if (k === 'fx' || k === 'fy' || k === 'fz') L.vector['xyz'.indexOf(k[1])] = v;
      else if (k === 'type' || k === 'pressure' || k === 'torque' || k === 'axis') L[k] = v;
      else a[k] = v;
      // a shared setting changed: every result is out of date
      for (const r of results.values()) r.stale = true;
      apply();
      changed();
    });
  }

  async function loadMaterials() {
    try {
      const r = await (await fetch('/api/analyze/materials')).json();
      if (r.available) materials = r.materials;
      else gpuError ??= 'the server was installed without the simulation extra (scriptcad[sim])';
    } catch {}
  }

  return {
    bind,
    isOn: () => on,
    picking: () => on && !!pickTarget,
    onPick,
    render,
    stopPick() { if (pickTarget) startPick(pickTarget); },
    /** Forget results, e.g. when a different project is loaded. */
    reset() { results.clear(); explore.reset(); carve.reset(); seq++; busy = false; status = ''; if (on) { viewer.clearField(); syncMarks(); render(); } },
    async toggle(next = !on) {
      on = next;
      pickTarget = null;
      if (on) {
        setup();
        await loadMaterials();
        ensureSolver().then(() => render());
        syncMarks();
        if (fresh().length) apply(); else if (readyIds().length) schedule(readyIds(), 0);
      } else {
        clearTimeout(timer);
        carve.reset();
        seq++;
        busy = false;
        viewer.setMarks([]);
        viewer.clearField();
        viewer.setMode('body');
      }
      onChange();
      render();
    },
    afterRegen() {
      if (!on) return;
      // the viewer rebuilt the meshes; old fields may not match the new geometry
      for (const r of results.values()) r.stale = true;
      carve.reset();
      syncMarks();
      if (setup().live && readyIds().length) schedule(readyIds());
      else render();
    },
  };
}
