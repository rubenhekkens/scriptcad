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
import { createPush } from './push.js';
import { createPull, describe, faceShift, regen } from './pull.js';
import { pullHints } from './hints.js';
import { createRing } from './ring.js';
import { createRecorder, transcribe, command, warmUp } from './voice.js';
import { inflate, parse } from './fea/solver.js';
import { transfer } from './fea/multigrid.js';
import * as THREE from 'three';

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

export function createAnalyze({ S, viewer, toast, bodies, bodyLabel, refOf, onChange, setVariables, undo, redo }) {
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
  // a result holds while its body's geometry and its setup are what they were when solved
  const setupKey = id => { const a = setup(); return JSON.stringify([a.material, a.quality, a.load, a.bodies[id]]); };
  const sameMesh = (p, q) => !!p && !!q && p.length === q.length && p.every((x, i) => x === q[i]);

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
  // A pull moves faces, and with them the points that stand for supports and loads: move each
  // point along its face's normal by as much as that face moved in `body` (a variant's mesh).
  function movedRefs(id, body) {
    const b = bodies().find(x => x.id === id), bs = bodySetup(id), P = b.positions;
    const [lo, hi] = b.props.bbox, reach = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const move = r => {
      let best = 0, bd = Infinity;
      for (let t = 0; t < P.length / 9; t++) { const d = pointTriangleDist2(r, P, 9 * t); if (d < bd) { bd = d; best = t; } }
      const o = 9 * best, e1 = [0, 1, 2].map(i => P[o + 3 + i] - P[o + i]), e2 = [0, 1, 2].map(i => P[o + 6 + i] - P[o + i]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...n) || 1, nn = n.map(x => x / len);
      const shift = faceShift(body, r, nn, reach);
      return shift ? r.map((x, i) => +(x + nn[i] * shift).toFixed(6)) : r;
    };
    return { fixed: bs.fixed.map(move), loads: bs.loads.map(move) };
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

  /**
   * The server's voxel model of one body of `doc`, with this setup's supports and load (or
   * `bs`'s faces); h: a voxel size (mm) instead of the one the quality picks; quality: another
   * than the setup's.
   */
  async function buildCase(doc, id, bs = setup().bodies[id], h = null, quality = null) {
    const a = setup();
    const payload = { doc, setup: { body: id, material: a.material, quality: quality || a.quality, fixed: bs.fixed,
                                    load: { ...a.load, faces: bs.loads }, ...(h ? { h } : {}) } };
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`${bodyLabel(id)}: ${(await r.json().catch(() => ({}))).detail || r.statusText}`);
    return { caseId: r.headers.get('X-Case-Id'), meta: JSON.parse(r.headers.get('X-Meta') || '{}'), blob: inflate(await r.arrayBuffer()) };
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
    // a re-run after an edit starts from the body's last solution
    const last = results.get(id), P = parse(blob);
    const x0 = last?.u && last.case?.blob ? transfer(parse(last.case.blob), last.u, P) : null;
    const sol = await solver.solveMG(blob, { tol: 1e-6, x0 });
    say('computing stresses…');
    const rr = await fetch(`/api/analyze/result?id=${caseId}${field ? '' : '&field=false'}`, { method: 'POST', body: sol.u });
    if (!rr.ok) throw new Error(`${bodyLabel(id)}: ${(await rr.json().catch(() => ({}))).detail || rr.statusText}`);
    const stats = JSON.parse(rr.headers.get('X-Stats') || '{}');
    return { meta, stats, sol, caseId, blob, field: field ? parseField(await rr.arrayBuffer()) : null };
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
        const { meta, stats, sol, caseId, blob, field } = await solveOne(S.doc, id, true, s => { if (my === seq) { status = tag + s; render(); } });
        if (my !== seq) return;
        const cad = bodies().find(x => x.id === id)?.positions;
        results.set(id, { meta, stats, values: field.vonMises, displacement: field.displacement,
                          case: { caseId, blob, meta },                // reused by Push to load
                          mesh: { positions: field.positions, normals: field.normals, triFace: field.triFace },
                          solve: { ms: sol.setupMs + sol.solveMs, iterations: sol.iterations }, stale: false,
                          cadLength: cad?.length, cad, key: setupKey(id), u: sol.u });
        apply();
        pullHooks.onResult?.(id, results.get(id));     // VR says what a kept pull came to
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
    refreshHints();
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

  // ---- push to load: press on a part (mouse or VR controller) and watch it respond ----------
  let pushMode = false, pushView = null, pushText = '', pushMax = null;
  const canPush = id => { const r = results.get(id); return !!r && !r.stale && !busy; };
  const maxForce = () => pushMax ?? Math.round(Math.hypot(...setup().load.vector) || 1000);
  const setPushText = t => { pushText = t; const el = host?.querySelector('#pushStatus'); if (el) el.textContent = t; };
  const push = createPush({
    result: id => results.get(id), gpuSolver, buildCase, doc: () => S.doc, parseField,
    onUpdate(u) {
      if (u.error) return setPushText(u.error);
      const r = results.get(u.id), b = bodies().find(x => x.id === u.id);
      if (!r || !b) return;
      // fixed for the whole press: at the maximum force the part is drawn bent by 6% of its
      // size and the colour scale tops out at its 99th-percentile stress (linear, so both scale)
      if (!pushView || pushView.id !== u.id) {
        const k = maxForce() / Math.max(u.force, 1e-9), [lo, hi] = b.props.bbox;
        const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        pushView = { id: u.id, size, scale: 0.06 * size / Math.max(u.stats.max_displacement * k, 1e-12), cap: u.stats.p99 * k };
      }
      const f = u.field;
      // only the pushed body bends (the others keep their own results, undeformed); the scale
      // first, so setField deforms just this body (all of them is slow on a headset)
      if (viewer.deformScale !== pushView.scale || !viewer.deformOnly?.has(u.id)) viewer.setDeformation(pushView.scale, new Set([u.id]));
      viewer.setField(u.id, f.vonMises, pushView.cap, f.displacement, { positions: f.positions, normals: f.normals, triFace: f.triFace });
      viewer.setArrow(u.point, u.dir, 0.15 * pushView.size * (0.3 + 0.7 * u.force / maxForce()));
      setPushText(`${fmt(u.force)} N · deflection ${fmt(u.stats.max_displacement * 1000)} µm · stress ${fmt(u.stats.p99)} MPa (99th pct) · ${Math.round(u.ms)} ms per update`);
      hud([`${fmt(u.force)} N on ${esc(bodyLabel(u.id))}`, `deflection ${fmt(u.stats.max_displacement * 1000)} µm · stress ${fmt(u.stats.p99)} MPa · solved in ${Math.round(u.ms)} ms`], 3000);
      pushHooks.onUpdate?.(u);
    },
    onProgress(p) { setPushText(`Solving the first answer at this spot… ${Math.round(100 * p.fraction)}%`); pushHooks.onProgress?.(p); },
    onEnd() { pushView = null; viewer.setArrow(null); if (pushText.startsWith('Solving')) setPushText(''); apply(); pushHooks.onEnd?.(); },
  });
  const pushHooks = {};

  // ---- tap to hear it: natural frequencies, sounded and shown (ring.js) ------------------
  let ringMode = false, ringText = '';
  const ringHooks = {};
  const setRingText = t => { ringText = t; const el = host?.querySelector('#ringStatus'); if (el) el.textContent = t; };
  const hz = x => x >= 1000 ? `${fmt(x / 1000, 3)} kHz` : `${fmt(x, 3)} Hz`;
  const ring = createRing({
    viewer, buildCase, gpuSolver, parseField, gate, doc: () => S.doc,
    // a body's modes hold while its shape, supports and material do
    keyOf: id => { const b = bodies().find(x => x.id === id), p = b?.positions; let h = p?.length || 0; if (p) for (let i = 0; i < p.length; i += 97) h = (h * 31 + p[i] * 1000) % 1e9; return setupKey(id) + h; },
    sizeOf: id => { const b = bodies().find(x => x.id === id); if (!b) return 1; const [lo, hi] = b.props.bbox; return Math.hypot(...hi.map((v, i) => v - lo[i])); },
    onStatus(st) {
      if (st.phase === 'modes') setRingText(`Finding how ${bodyLabel(st.id)} rings… ${Math.round(100 * st.fraction)}%`);
      else setRingText(`${bodyLabel(st.id)} rings at ${st.modes.map(m => hz(m.hz)).join(', ')}`);
      ringHooks.onStatus?.(st);
    },
    restore: () => apply(),
  });
  async function tapAt(id, point, normal) {
    const r = await ring.tap(id, point, normal).catch(e => { setRingText(`Failed: ${e.message}`); return null; });
    if (!r) return null;
    setRingText(`${bodyLabel(id)}: ${r.modes.map((m, i) => `${hz(m.hz)}${i === r.loudest ? ' (loudest here, shown slowed down)' : ''}`).join(' · ')}`);
    hud([`${esc(bodyLabel(id))} rings at ${hz(r.modes[r.loudest].hz)}`, `its tones: ${r.modes.map(m => hz(m.hz)).join(' · ')} · shown slowed down`], 7000);
    ringHooks.onTap?.(id, r);
    return r;
  }
  {
    const el = viewer.renderer.domElement;
    el.addEventListener('pointerdown', e => {
      if (!on || !ringMode || e.button !== 0) return;
      const hit = viewer.hitAt(e);
      if (!hit) return;
      e.stopImmediatePropagation();
      ring.unlock();
      tapAt(hit.bodyId, hit.point, hit.normal);
    }, true);
  }
  function ringSection() {
    if (!fresh().length) return '';
    return `<div class="panel-h sub explore-h"><span>Tap to hear it</span></div>
      <div class="muted small">Click a part to tap it: you hear its natural frequencies (the first four, at their real pitch,
        each as loud as the spot you tapped moves in it) and see the loudest one swing, slowed down. The first tap on a part
        works them out (a Draft model, some seconds); they are kept until the part changes.</div>
      <div class="prop-actions"><button class="btn ${ringMode ? 'primary' : ''}" id="rgToggle">${ringMode ? 'Tap is on: click a part' : 'Tap'}</button></div>
      <div class="muted small an-status" id="ringStatus">${esc(ringText)}</div>`;
  }

  // desktop: hold the mouse on a part; the force grows to the maximum in 1.5 s
  {
    const el = viewer.renderer.domElement;
    el.addEventListener('pointerdown', e => {
      if (!on || !pushMode || e.button !== 0) return;
      const hit = viewer.hitAt(e);
      if (!hit || !canPush(hit.bodyId)) return;
      e.stopImmediatePropagation();              // keep the orbit controls out of it
      viewer.controls.enabled = false;
      try { el.setPointerCapture(e.pointerId); } catch {}   // keep the release even if the pointer leaves the canvas
      const t0 = performance.now(), F = maxForce();
      push.start(hit.bodyId, hit.point, hit.normal.map(v => -v), 0.1 * F);
      const ramp = () => { if (!push.active()) return; push.update(F * Math.min(1, 0.1 + (performance.now() - t0) / 1500)); requestAnimationFrame(ramp); };
      requestAnimationFrame(ramp);
    }, true);
    const release = () => { if (push.active()) { push.stop(); viewer.controls.enabled = true; } };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  }

  // ---- pull to shape: drag a face, the variable driving it follows (pull.js) -----------------
  let pullMode = false, pullText = '', pullSeed = null;
  const pullHooks = {};

  // ---- where to pull: an arrow per variable, from the solved results (hints.js) ----------
  // Worked out when Pull is on (on the desktop, or in VR) for the solved bodies; again only
  // when a result changes. Green: adding there buys the most stiffness per gram; orange: it
  // buys the least, so material there is the cheapest to trim.
  let hints = new Map(), hintsKey = '', hintsRun = 0, hintsText = '', hintsWanted = false;
  const GOOD = 1.5, POOR = 0.8;
  const hintColor = h => h.ratio >= GOOD ? 0x5ad17a : h.ratio < POOR ? 0xff9f5a : 0x9fb4cc;
  const hintLabel = h => `${h.name} ${h.ratio < POOR ? (h.step > 0 ? '−' : '+') : h.step > 0 ? '+' : '−'}: ${h.ratio < POOR ? 'trim' : 'add'} · ${fmt(h.ratio, 2)}× per gram`;
  function drawHints() {
    const show = on && (pullMode || hintsWanted) && !pull.active();
    if (!show) return viewer.setHints([]);
    const items = [];
    for (const [id, list] of hints) {
      const b = bodies().find(x => x.id === id);
      if (!b) continue;
      const [lo, hi] = b.props.bbox, len = 0.09 * Math.hypot(...hi.map((v, i) => v - lo[i]));
      const h0 = results.get(id)?.meta.h || 0;
      // each variable's arrow at its own spot along the part, so they do not stack up
      const [ax] = [0, 1, 2].map(i => [i, hi[i] - lo[i]]).sort((p, q) => q[1] - p[1])[0];
      list.forEach((h, i) => {
        const want = lo[ax] + (hi[ax] - lo[ax]) * (i + 1) / (list.length + 1);
        const { at, dir } = h.spots.reduce((a, b) => Math.abs(b.at[ax] - want) < Math.abs(a.at[ax] - want) ? b : a);
        h = { ...h, at, dir };
        const trim = h.ratio < POOR;
        // from the surface outwards to add; from outside onto the surface to trim
        const surf = h.at.map((x, i) => x + h.dir[i] * h0 / 2);
        const from = trim ? surf.map((x, i) => x + h.dir[i] * len) : surf;
        items.push({ from, dir: trim ? h.dir.map(x => -x) : h.dir, length: len, color: hintColor(h), label: hintLabel(h) });
      });
    }
    viewer.setHints(items);
  }
  async function refreshHints() {
    if (!(on && (pullMode || hintsWanted))) return drawHints();
    const targets = new Map(fresh().filter(([id]) => bodies().some(b => b.id === id))
      .map(([id, r]) => [id, { body: bodies().find(b => b.id === id), result: r }]));
    const key = [...targets].map(([id, t]) => `${id}:${t.result.case?.caseId}`).join('|') + JSON.stringify(S.doc.variables || []);
    if (key === hintsKey) return drawHints();
    hintsKey = key;
    const my = ++hintsRun;
    hints = new Map();
    drawHints();
    if (!targets.size) { hintsText = ''; return render(); }
    hintsText = 'Finding where to pull…';
    render();
    try {
      const out = await pullHints({ doc: S.doc, targets, onProgress: (i, n, name) => { if (my === hintsRun) setHintsText(`Finding where to pull… ${name} (${i + 1}/${n})`); } });
      if (my !== hintsRun) return;
      hints = out;
      hintsText = '';
    } catch (e) {
      if (my !== hintsRun) return;
      hintsText = `Hints failed: ${e.message}`;
      hintsKey = '';
    }
    drawHints();
    render();
    const best = [...hints].flatMap(([id, l]) => l.map(h => ({ ...h, id }))).sort((a, b) => b.ratio - a.ratio)[0];
    if (best && pullMode && !rebal && announceBest) { announceBest = false; hud([`Best move: ${esc(best.name)} on ${esc(bodyLabel(best.id))}`,
      `1% more mass there takes ${fmt(best.ratio, 2)}% off the deflection · follow the green arrows`], 8000); }
    pullHooks.onHints?.();
  }
  // ---- rebalance: move material from where it does least to where it does most ------------
  // Per round, per body: one step more of the best variable (most stiffness per gram) and as
  // many steps less of the worst as keep the mass about level, rebuilt and really solved; kept
  // if the part got stiffer, else undone and the body is done. Ends when the best and worst
  // buy about the same per gram, after 6 rounds, or when stopped.
  let rebal = null, lastLog = [];                  // { stop, log: [], body }
  const until = async (test, ms = 120000) => {
    for (const t0 = performance.now(); !test(); ) {
      if (performance.now() - t0 > ms || rebal?.stop) return false;
      await new Promise(r => setTimeout(r, 150));
    }
    return true;
  };
  async function rebalance(ids) {
    if (rebal) { rebal.stop = true; return; }
    const me = rebal = { stop: false, log: [] };
    const wanted = hintsWanted;
    hintsWanted = true;
    const say = t => { me.log.push(t); hud(['Rebalancing', esc(t)], 0); render(); pullHooks.onRebalance?.(me.log); };
    try {
      for (const id of ids) {
        const start = Object.fromEntries((S.doc.variables || []).map(v => [v.name, v.value]));
        for (let round = 1; round <= 6 && !me.stop; round++) {
          me.body = id;
          refreshHints();
          // this body's current result and its arrows
          if (!await until(() => results.get(id) && !results.get(id).stale && !busy && hintsKey && !hintsText && hints.has(id))) break;
          const list = hints.get(id), r0 = results.get(id);
          const best = list[0], worst = list[list.length - 1];
          if (list.length < 2 || best.ratio < 1.15 * worst.ratio) { say(`${bodyLabel(id)}: balanced`); break; }
          const n = Math.max(1, Math.round(best.mass / worst.mass));
          const vb = +(best.value + best.step).toFixed(6), vw = +(worst.value - n * worst.step).toFixed(6);
          // a size keeps its sign and at least 30% of what it started at
          if (Math.sign(vw) !== Math.sign(start[worst.name]) || Math.abs(vw) < 0.3 * Math.abs(start[worst.name])) { say(`${bodyLabel(id)}: ${worst.name} is as small as it may get`); break; }
          const values = { [best.name]: vb, [worst.name]: vw };
          const doc = { ...S.doc, variables: S.doc.variables.map(v => v.name in values ? { ...v, value: values[v.name] } : v) };
          let nb;
          try { nb = (await regen(doc)).find(b => b.id === id); } catch {}
          if (!nb) { say(`${bodyLabel(id)}: ${best.name} ${vb}, ${worst.name} ${vw} cannot be built`); break; }
          const before = { refs: JSON.parse(JSON.stringify(bodySetup(id))), values: { [best.name]: best.value, [worst.name]: worst.value } };
          setVariables(values, () => Object.assign(bodySetup(id), movedRefs(id, nb)));
          if (!await until(() => results.get(id) && results.get(id) !== r0 && !results.get(id).stale && !busy)) break;
          const r1 = results.get(id);
          const dd = r1.stats.max_displacement / r0.stats.max_displacement - 1, dm = r1.meta.mass_g / r0.meta.mass_g - 1;
          const what = `${best.name} ${fmt(best.value, 6)}→${fmt(vb, 6)}, ${worst.name} ${fmt(worst.value, 6)}→${fmt(vw, 6)}`;
          if (r1.stats.compliance >= 0.998 * r0.stats.compliance) {
            say(`${bodyLabel(id)}: ${what} did not help (${dd >= 0 ? '+' : '−'}${fmt(Math.abs(dd) * 100, 2)}% deflection): undone`);
            setVariables(before.values, () => Object.assign(bodySetup(id), before.refs));
            await until(() => results.get(id) && !results.get(id).stale && !busy);
            break;
          }
          say(`${bodyLabel(id)} ${round}: ${what} · deflection ${dd >= 0 ? '+' : '−'}${fmt(Math.abs(dd) * 100, 2)}%, mass ${dm >= 0 ? '+' : '−'}${fmt(Math.abs(dm) * 100, 2)}%`);
        }
      }
      if (me.stop) say('stopped');
    } finally {
      hintsWanted = wanted;
      if (rebal === me) { rebal = null; lastLog = me.log; hud(["Rebalanced", esc(me.log[me.log.length - 1] || "")], 8000); }
      render();
      drawHints();
      pullHooks.onRebalance?.(null);
    }
  }

  /** Set variables as one undo step, the support and load points moving with their faces. */
  async function setValues(values) {
    const doc = { ...S.doc, variables: S.doc.variables.map(v => v.name in values ? { ...v, value: values[v.name] } : v) };
    const next = await regen(doc);
    const moves = bodies().filter(b => setup().bodies[b.id]).map(b => [b.id, next.find(x => x.id === b.id)])
      .filter(([, nb]) => nb).map(([id, nb]) => [id, movedRefs(id, nb)]);
    setVariables(values, () => { for (const [id, refs] of moves) Object.assign(bodySetup(id), refs); });
  }
  // ---- voice: hold to talk, Whisper writes it down, the words become a command (voice.js) ------
  let voiceText = '';
  const voiceHooks = {};
  const setVoiceText = t => { voiceText = t; const el = host?.querySelector('#voiceStatus'); if (el) el.textContent = t; voiceHooks.onStatus?.(t); };
  const recorder = createRecorder();
  const allIds = () => fresh().map(([id]) => id).filter(id => bodies().some(b => b.id === id));
  /** Carry out a spoken command; returns what was done, or throws if the words are not one. */
  async function runCommand(text) {
    const names = (S.doc.variables || []).map(v => v.name);
    const parts = bodies().map(b => ({ id: b.id, name: bodyLabel(b.id) }));
    const c = command(text, names, Object.fromEntries((S.doc.variables || []).map(v => [v.name, v.value])), parts);
    if (!c) throw new Error(`not a command I know: “${text}”`);
    if (c.type === 'set') { await setValues(c.values); return `set ${Object.entries(c.values).map(([k, v]) => `${k} = ${fmt(v, 6)}`).join(', ')}`; }
    if (c.type === 'rebalance') { if (!rebal) rebalance(allIds()); return 'rebalancing'; }
    if (c.type === 'carve') {
      // the part named, or the one selected in the panel; it needs its supports and load
      const id = c.body ?? setup().body;
      if (!id || !ready(id)) throw new Error(`“${text}”: say which part to carve (one with supports and a load)`);
      setup().body = id;
      if (c.keep) carve.cfg().keep = Math.min(0.9, Math.max(0.05, c.keep));
      onChange();
      render();
      carve.start();
      return `carving ${bodyLabel(id)} down to ${Math.round(100 * carve.cfg().keep)}% of its material`;
    }
    if (c.type === 'stop') { if (rebal) rebal.stop = true; if (push.active()) push.stop(); return 'stopped'; }
    if (c.type === 'undo') { undo(); return 'undone'; }
    if (c.type === 'redo') { redo(); return 'redone'; }
    if (c.type === 'mode') {
      pushMode = c.mode === 'push'; pullMode = c.mode === 'pull'; ringMode = c.mode === 'tap';
      refreshHints(); render(); voiceHooks.onMode?.(c.mode);
      return `${c.mode} mode`;
    }
  }
  async function listen() { warmUp(); await recorder.start(); setVoiceText('Listening… let go when done.'); }
  /** Stop listening, transcribe and carry out; resolves to { heard, done } (done null if it failed). */
  async function heard() {
    const blob = await recorder.stop();
    if (!blob) return null;
    setVoiceText('Writing it down…');
    let text = '';
    try { text = await transcribe(blob, [...(S.doc.variables || []).map(v => v.name), ...bodies().map(b => bodyLabel(b.id).replace(/^[A-Z] · /, ''))]); }
    catch (e) { setVoiceText(`Whisper: ${e.message}`); return { heard: '', done: null, error: e.message }; }
    if (!text) { setVoiceText('Nothing heard.'); return { heard: '', done: null }; }
    try { const done = await runCommand(text); setVoiceText(`“${text}”: ${done}`); hud([`“${esc(text)}”`, esc(done)]); return { heard: text, done }; }
    catch (e) { setVoiceText(e.message); return { heard: text, done: null, error: e.message }; }
  }
  function voiceSection() {
    return `<div class="panel-h sub explore-h"><span>Voice</span></div>
      <div class="muted small">Hold the button and say a command: “set H to 50”, “increase slab T by 2”, “rebalance”,
        “carve the solid slab”, “carve the truss to 20 percent”, “push”, “pull”, “tap”, “undo”, “stop”. Whisper writes it down on this computer (nothing leaves it).</div>
      <div class="prop-actions"><button class="btn" id="voiceMic" title="Hold and talk">Hold to talk</button></div>
      <div class="muted small an-status" id="voiceStatus">${esc(voiceText)}</div>`;
  }

  // ---- in the viewport: a dock with the interactive tools, and a caption of what just happened ----
  // The same tools as the panel's sections, where the eye (and a screen recording) already is.
  let announceBest = false;                        // the best move is named once, when Pull is turned on
  function setTool(t) {
    announceBest = t === 'pull' && !pullMode;
    pushMode = t === 'push'; pullMode = t === 'pull'; ringMode = t === 'tap';
    if (t && pickTarget) startPick(pickTarget);
    if (ringMode) ring.unlock();
    setPushText(pushMode ? 'Press and hold on a part.' : '');
    pullText = pullMode ? 'Drag a face.' : '';
    setRingText(ringMode ? 'Click a part.' : '');
    hud(t === 'push' ? ['Push', 'press and hold on a part: it bends live under your hand']
      : t === 'pull' ? ['Pull', 'green arrows: where material buys the most stiffness per gram · drag a face']
      : t === 'tap' ? ['Tap', 'click a part to hear its natural frequencies'] : null);
    refreshHints();
    render();
  }
  let dock = null, hudEl = null, hudTimer = null, hudCarve = '';
  /** The caption: [line, smaller line] (html allowed: the callers build it), or null to hide; it fades after `ms`. */
  function hud(lines, ms = 6000) {
    if (!hudEl) return;
    clearTimeout(hudTimer);
    if (!lines) { hudEl.classList.remove('show'); return; }
    hudEl.innerHTML = `<div class="h1">${lines[0]}</div>${lines[1] ? `<div class="h2">${lines[1]}</div>` : ''}`;
    hudEl.classList.add('show');
    if (ms) hudTimer = setTimeout(() => hudEl.classList.remove('show'), ms);
  }
  const pctHtml = (x, lowerIsBetter = true) => {
    const good = lowerIsBetter ? x < 0 : x > 0;
    return `<span class="${Math.abs(x) < 0.005 ? '' : good ? 'good' : 'bad'}">${x >= 0 ? '+' : '−'}${fmt(Math.abs(x) * 100, 2)}%</span>`;
  };
  function makeDock() {
    const vp = viewer.renderer.domElement.parentElement;
    hudEl = Object.assign(document.createElement('div'), { className: 'an-hud' });
    dock = Object.assign(document.createElement('div'), { className: 'an-dock' });
    const b = (id, title, sub, c) => `<button data-dock="${id}" style="--c:${c}" title="${esc(sub)}">${title}<small>${sub}</small></button>`;
    dock.innerHTML = b('push', 'Push', 'press to load', '#ffd23f') + b('pull', 'Pull', 'drag a face', '#9fd2ff') + b('tap', 'Tap', 'hear it ring', '#c58bff')
      + '<span class="sep"></span>' + b('rebalance', 'Rebalance', 'stiffer, same mass', '#5ad17a') + b('carve', 'Carve', 'remove what idles', '#5ad17a')
      + '<span class="sep"></span>' + b('voice', 'Voice', 'hold and talk', '#e6edf3');
    vp.append(hudEl, dock);
    dock.addEventListener('click', e => {
      const k = e.target.closest('[data-dock]')?.dataset.dock;
      if (k === 'push' || k === 'pull' || k === 'tap') setTool((k === 'push' ? pushMode : k === 'pull' ? pullMode : ringMode) ? null : k);
      else if (k === 'rebalance') {
        if (rebal) { rebal.stop = true; return; }
        setTool('pull');
        hud(['Rebalancing', 'moving material from orange to green, at the same mass'], 0);
        rebalance(allIds());
      }
      else if (k === 'carve') {
        if (carve.busy()) return;
        const id = ready(setup().body) ? setup().body : allIds()[0];
        if (!id) return;
        setup().body = id;
        onChange();
        hud([`Carving ${esc(bodyLabel(id))}`, `down to ${Math.round(100 * carve.cfg().keep)}% of its material, removing what carries the least load`], 0);
        carve.start();
      }
    });
    // hold to talk, as the panel's button
    let held = false;
    dock.addEventListener('pointerdown', e => {
      if (e.target.closest('[data-dock]')?.dataset.dock !== 'voice') return;
      held = true;
      listen().then(() => { hud(['Listening…', 'let go when done'], 0); if (!held) heard(); }, err => hud(['Cannot listen', esc(err.message)]));
    });
    const letGo = () => { if (!held) return; held = false; if (recorder.recording()) heard(); };
    dock.addEventListener('pointerup', letGo);
    dock.addEventListener('pointerleave', letGo);
  }
  function updateDock() {
    if (!dock) makeDock();
    const show = on && fresh().length > 0;
    dock.style.display = show ? '' : 'none';
    if (!show) { hud(null); return; }
    const has = (S.doc.variables || []).length > 0;
    for (const el of dock.querySelectorAll('[data-dock]')) {
      const k = el.dataset.dock;
      el.classList.toggle('on', k === 'push' ? pushMode : k === 'pull' ? pullMode : k === 'tap' ? ringMode
        : k === 'rebalance' ? !!rebal : k === 'carve' ? carve.busy() : k === 'voice' ? recorder.recording() : false);
      if (k === 'rebalance' || k === 'pull') el.disabled = !has;
    }
    // Carve reports its steps through the panel; mirror them while it runs
    const cp = carve.progressText?.();
    if (carve.busy() && cp && cp !== hudCarve) { hudCarve = cp; hud(['Carving', esc(cp)], 0); }
    else if (!carve.busy() && hudCarve) { hudCarve = ''; hud(['Carved', esc(cp || 'done')]); }
  }

  const setHintsText = t => { hintsText = t; const el = host?.querySelector('#hintsStatus'); if (el) el.textContent = t; };
  function hintsHtml() {
    if (hintsText) return `<div class="muted small an-status" id="hintsStatus">${esc(hintsText)}</div>`;
    const rows = [...hints].filter(([, l]) => l.length).map(([id, list]) => `<div class="small"><b>${esc(bodyLabel(id))}</b></div>` +
      list.map(h => `<div class="small" style="color:#${hintColor(h).toString(16)}">${esc(h.name)} ${h.step > 0 ? '+' : '−'}${fmt(Math.abs(h.step))}:
        deflection ${h.defl <= 0 ? '−' : '+'}${fmt(Math.abs(h.defl) * 100, 2)}%, mass +${fmt(h.mass * 100, 2)}% · ${fmt(h.ratio, 2)}× per gram</div>`).join('')).join('');
    const log = (rebal?.log || lastLog).map(t => `<div class="small">${esc(t)}</div>`).join('');
    return rows || rebal ? `<div class="muted small">Where to pull: per step of each variable, from the current results (first-order,
      no extra solves). Green: the most stiffness per gram added; orange: the least, so the cheapest to trim.</div>${rows}
      <div class="prop-actions"><button class="btn ${rebal ? 'primary' : ''}" id="rbToggle">${rebal ? 'Stop rebalancing' : 'Rebalance'}</button></div>
      <div class="muted small">Rebalance moves material from orange to green in steps that keep the mass about level, solving each
        step, while that makes the parts stiffer.</div>${log}` : '';
  }
  const setPullText = t => { pullText = t; const el = host?.querySelector('#pullStatus'); if (el) el.textContent = t; };
  const pull = createPull({
    S, viewer, buildCase, gpuSolver, parseField, gate, capValue, canSolve: ready, movedRefs,
    current: id => { const r = results.get(id); return r && !r.stale ? r : null; },
    onStatus(st) {
      setPullText(describe(st).join(' · '));
      if (st.phase === 'ready' && !st.error) {
        const r = st.result, b = st.base;
        hud([`${esc(st.name)} ${fmt(st.value - st.delta, 6)} → ${fmt(st.value, 6)}`, r && b
          ? `deflection ${pctHtml(r.stats.max_displacement / b.stats.max_displacement - 1)} · stress ${pctHtml(r.stats.p99 / b.stats.p99 - 1)} · mass ${pctHtml(r.meta.mass_g / b.meta.mass_g - 1)}`
          : 'solving…'], 0);
      }
      pullHooks.onStatus?.(st);
    },
    commit(values, id, res, token, body) {
      gate.end(token);
      pullHooks.onEnd?.(values, res);
      if (!values) { setPullText(''); return apply(); }
      if (res) pullSeed = { id, res };             // afterRegen takes it over: no second solve
      const refs = movedRefs(id, body);
      // the value and the moved support and load points are one undo step
      setVariables(values, () => Object.assign(bodySetup(id), refs));
      setPullText(`Kept ${Object.entries(values).map(([k, v]) => `${k} = ${fmt(v, 6)}`).join(', ')} (undo with Ctrl+Z)`);
      hud([`Kept ${esc(Object.entries(values).map(([k, v]) => `${k} = ${fmt(v, 6)}`).join(', '))}`, 'Ctrl+Z undoes it']);
    },
  });

  // desktop: drag a face; the drag along the face's normal on screen is the pull
  {
    const el = viewer.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', e => {
      if (!on || !pullMode || e.button !== 0) return;
      const hit = viewer.hitAt(e);
      if (!hit) return;
      e.stopImmediatePropagation();
      viewer.controls.enabled = false;
      try { el.setPointerCapture(e.pointerId); } catch {}
      // the face's normal on screen: pixels per mm along it, or the screen's up if it faces you
      const rect = el.getBoundingClientRect(), cam = viewer.camera;
      const px = v => { const p = new THREE.Vector3(...v).project(cam); return [(p.x + 1) / 2 * rect.width, (1 - p.y) / 2 * rect.height]; };
      const p0 = px(hit.point), scr = d => { const p = px(hit.point.map((x, i) => x + d[i])); return [p[0] - p0[0], p[1] - p0[1]]; };
      const up = scr(new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).toArray());
      let axis = scr(hit.normal);
      if (Math.hypot(...axis) < 0.3 * Math.hypot(...up)) axis = up;   // the face looks at you: drag up to pull it out
      drag = { x: e.clientX, y: e.clientY, axis };
      pull.grab(hit.bodyId, hit.point, hit.normal);
      drawHints();                                 // the arrows step aside while a face is held
    }, true);
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      const [ax, ay] = drag.axis, d = [e.clientX - drag.x, e.clientY - drag.y];
      pull.drag((d[0] * ax + d[1] * ay) / (ax * ax + ay * ay));
    });
    const release = () => { if (!drag) return; drag = null; pull.release(); viewer.controls.enabled = true; };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  }

  function pushHtml() {
    if (!(S.doc.variables || []).length) return (pushSection() && `<div class="panel-h sub explore-h"><span>Push to load</span></div>${pushSection()}`) + ringSection() + voiceSection();
    return `<div class="panel-h sub explore-h"><span>Pull to shape</span></div>
      <div class="muted small">Drag a face of a part: the variable that drives it follows, in round steps. Each step is
        rebuilt at once (grey) and solved in the background (coloured, on the current colour scale). Let go to keep the
        value; Ctrl+Z undoes it. In VR, pinch a face and move your hand.</div>
      <div class="prop-actions"><button class="btn ${pullMode ? 'primary' : ''}" id="plToggle">${pullMode ? 'Pull is on: drag a face' : 'Pull'}</button></div>
      <div class="muted small an-status" id="pullStatus">${esc(pullText)}</div>
      ${pullMode ? hintsHtml() : ''}
      ${fresh().length ? `<div class="panel-h sub explore-h"><span>Push to load</span></div>` : ''}${pushSection()}${ringSection()}${voiceSection()}`;
  }

  function pushSection() {
    if (!fresh().length) return '';
    return `
      <div class="muted small">Press and hold on a part: the force grows to the maximum in 1.5 s while the part bends and
        colours live, pushing into the surface where you press. Let go and it springs back to its own load case.
        In VR, the trigger sets the force.</div>
      <div class="field"><label for="pu_max">Max force</label><div class="unit-in"><input id="pu_max" type="number" step="any" min="0" data-pumax value="${maxForce()}"><span>N</span></div></div>
      <div class="prop-actions"><button class="btn ${pushMode ? 'primary' : ''}" id="puToggle">${pushMode ? 'Push is on: press on a part' : 'Push'}</button></div>
      <div class="muted small an-status" id="pushStatus">${esc(pushText)}</div>`;
  }

  // ---- panel ---------------------------------------------------------------------
  let host = null;
  function render() {
    updateDock();
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
      ${pushHtml()}
      ${carve.html()}
      ${gpuLine}`;
  }

  function bind(el) {
    host = el;
    let held = false;                              // let go before the microphone opened: stop once it has
    el.addEventListener('pointerdown', e => {
      if (e.target.id !== 'voiceMic') return;
      held = true;
      listen().then(() => { if (!held) heard(); }, err => setVoiceText(err.message));
    });
    const letGo = e => { if (e.target.id !== 'voiceMic' || !held) return; held = false; if (recorder.recording()) heard(); };
    el.addEventListener('pointerup', letGo);
    el.addEventListener('pointerleave', letGo, true);
    el.addEventListener('click', e => {
      if (!on || explore.onClick(e) || carve.onClick(e)) return;
      if (e.target.id === 'rgToggle') return setTool(ringMode ? null : 'tap');
      if (e.target.id === 'puToggle') return setTool(pushMode ? null : 'push');
      if (e.target.id === 'rbToggle') return rebalance(fresh().map(([id]) => id).filter(id => bodies().some(b => b.id === id)));
      if (e.target.id === 'plToggle') return setTool(pullMode ? null : 'pull');
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
      if (e.target.dataset.pumax !== undefined) { if (+e.target.value > 0) pushMax = +e.target.value; return; }
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
    /** Push to load for VR: start(id, point, dir, force), update(force, dir), stop(); hooks.onUpdate/onEnd */
    push: { start: push.start, update: push.update, stop: push.stop, active: push.active, canPush, maxForce, hooks: pushHooks },
    /** Pull to shape for VR: grab(id, point, normal), drag(mm), release(), cancel(); hooks.onStatus/onEnd */
    pull: { grab: (...a) => { const r = pull.grab(...a); drawHints(); return r; }, drag: mm => pull.drag(mm), release: () => pull.release(), cancel: () => pull.cancel(), active: pull.active, available: pull.available, hooks: pullHooks },
    /** Pull's arrows for VR: show(on) whether Pull mode is on there; list(): body id -> hints. */
    hints: { show(v) { hintsWanted = v; refreshHints(); }, list: () => hints },
    /** Rebalance every solved body (again: stop); hooks.onRebalance(log) follows it, null at the end. */
    rebalance: () => rebalance(fresh().map(([id]) => id).filter(id => bodies().some(b => b.id === id))),
    rebalancing: () => !!rebal,
    /** Tap to hear it, for VR: tap(id, point, normal), unlock() (from a click or pinch), modes(id) once known. */
    ring: { tap: tapAt, unlock: () => ring.unlock(), modes: id => ring.cached(id), busy: () => ring.busy(), stream: () => ring.stream(), hooks: ringHooks },
    /** The viewport caption: hud([line, smaller line], ms) (a demo or recording can use it too). */
    hud,
    /** Spoken commands, for VR: listen() (from a pinch), heard() when let go -> { heard, done }. */
    voice: { listen, heard, run: runCommand, recording: () => recorder.recording(), warmUp, hooks: voiceHooks },
    /** A body's current (not stale) result, or null. */
    result: id => { const r = results.get(id); return r && !r.stale ? r : null; },
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
        viewer.setHints([]);
        viewer.setMode('body');
      }
      onChange();
      render();
    },
    afterRegen() {
      if (!on) return;
      carve.reset();
      // keep the results of bodies the edit did not change; the rest are out of date
      for (const [id, r] of results) {
        const b = bodies().find(x => x.id === id);
        if (!(b && r.key === setupKey(id) && sameMesh(b.positions, r.cad))) r.stale = true;
      }
      // a pulled face hands over the result it already solved for the value it left
      if (pullSeed) {
        const b = bodies().find(x => x.id === pullSeed.id);
        if (b && sameMesh(b.positions, pullSeed.res.cad))
          results.set(pullSeed.id, { ...pullSeed.res, stale: false, cadLength: b.positions.length, key: setupKey(pullSeed.id) });
        pullSeed = null;
      }
      apply();                                         // the viewer rebuilt the meshes: put the fields back
      const missing = readyIds().filter(id => !results.get(id) || results.get(id).stale);
      if (setup().live && missing.length) schedule(missing);
    },
  };
}
