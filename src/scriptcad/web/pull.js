// Grab a face and pull: drag a face of a part, and the variable that drives it follows.
//
// On grab, each numeric document variable is nudged once and the model rebuilt (tens of ms
// each); the variable that moves the grabbed point furthest along the face's normal drives
// the face, at that many mm per unit. The drag is then a value of that variable, in round
// steps of about 5% of it. Every step is rebuilt as soon as the drag reaches it (grey), and
// solved in the background (a few seconds each), the step under the hand first and then one
// ahead; solved steps are kept, so going back is instant. A solved step shows its stress on the colour
// scale the design had when grabbed, so colours compare honestly. Letting go writes the
// value into the variable (one undo step) and hands the solved result to Analyze, so
// nothing is solved twice. Used by the desktop Pull tool and by VR hands.

import * as THREE from 'three';
import { variables } from './expr.js';
import { parse } from './fea/solver.js';
import { transfer } from './fea/multigrid.js';

const GREY = [0.62, 0.65, 0.7];
const TOL = 1e-5;

/** The largest of 1, 2, 5 x 10^k not above x: values a person would type. */
export function niceStep(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x)), m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

/**
 * How far faces moved in `body` (a regen body: flat positions, 9 per triangle): returns
 * shift(point, normal), for the face through `point` with outward `normal`, the nearest hit
 * on a parallel face along the normal line within `reach` (null if none). dispose() when done.
 */
export function shifter(body, reach) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(body.positions), 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const ray = new THREE.Raycaster();
  const shift = (point, normal) => {
    const n = new THREE.Vector3(...normal).normalize();
    ray.set(new THREE.Vector3(...point).addScaledVector(n, reach), n.clone().negate());
    ray.far = 2 * reach;
    let best = null;
    for (const h of ray.intersectObject(mesh, false)) {
      if (Math.abs(h.face.normal.dot(n)) < 0.9) continue;        // only faces parallel to this one
      const d = reach - h.distance;
      if (best == null || Math.abs(d) < Math.abs(best)) best = d;
    }
    return best;
  };
  shift.dispose = () => { g.dispose(); mesh.material.dispose(); };
  return shift;
}

/** How far the face through `point` with outward `normal` moved in `body`. */
export function faceShift(body, point, normal, reach) {
  const shift = shifter(body, reach), d = shift(point, normal);
  shift.dispose();
  return d;
}

/** The bodies of `doc`, rebuilt by the server; throws if any feature fails. */
export async function regen(doc) {
  const r = await fetch('/api/regen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc, quality: 'normal' }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  const res = await r.json();
  if (Object.values(res.status || {}).some(x => x.state === 'error')) throw new Error('the model cannot be built with this value');
  return res.bodies;
}

const fmt = (x, d = 3) => (+(+x).toPrecision(d)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const pct = (x, x0) => x0 ? ` (${x >= x0 ? '+' : '−'}${fmt(Math.abs(x / x0 - 1) * 100, 2)}%)` : '';

/** Two lines describing a pull status: the value, then what it does to the part. */
export function describe(st) {
  if (st.phase === 'probing') return ['Finding what drives this face…', 'nudging each variable once'];
  if (st.phase === 'finishing') return [`${st.name} = ${fmt(st.value, 6)}`, 'finishing its stress solve…'];
  if (st.phase === 'none') return ['No variable moves this face', 'give its size a variable (Variables panel) to pull it'];
  const head = `${st.name} = ${fmt(st.value, 6)} (${st.delta >= 0 ? '+' : '−'}${fmt(Math.abs(st.delta), 6)}) · face ${st.move >= 0 ? '+' : '−'}${fmt(Math.abs(st.move))} mm`;
  if (st.error) return [head, `can't be built: ${st.error}`];
  const r = st.result, b = st.base;
  if (!r) return [head, st.solveError ? `no stress: ${st.solveError}` : st.canSolve ? 'solving…' : 'set up supports and loads to see stress'];
  return [head, `${fmt(r.meta.mass_g)} g${pct(r.meta.mass_g, b?.meta.mass_g)} · ${fmt(r.stats.max_displacement * 1000)} µm${pct(r.stats.max_displacement, b?.stats.max_displacement)}` +
                ` · ${fmt(r.stats.p99)} MPa${pct(r.stats.p99, b?.stats.p99)}`];
}

export function createPull({ S, viewer, buildCase, gpuSolver, parseField, gate, capValue, current, canSolve, movedRefs, commit, onStatus }) {
  let s = null;            // the grab: { id, point, normal, name, v0, rate, step, k, cache, token, ... }

  const numericVars = () => (S.doc.variables || []).filter(v => typeof v.value === 'number');
  const docWith = (name, value) => {
    const doc = { ...S.doc, variables: S.doc.variables.map(v => v.name === name ? { ...v, value } : v) };
    variables(doc);                                               // throws on a broken expression
    return doc;
  };
  const value = (k, g = s) => +(g.v0 + k * g.step).toFixed(6);
  const entry = k => { if (!s.cache.has(k)) s.cache.set(k, {}); return s.cache.get(k); };

  function status() {
    if (!s) return;
    if (s.phase !== 'ready') return onStatus({ phase: s.phase, id: s.id });
    const e = entry(s.k), r0 = s.base;
    onStatus({ phase: 'ready', id: s.id, name: s.name, value: value(s.k), delta: value(s.k) - s.v0, move: s.k * s.step * s.rate,
               result: e.res ?? null, base: r0, error: e.error ?? null, solveError: e.solveError ?? null, canSolve: canSolve(s.id) });
  }

  /** Show step k: solved in colour, else rebuilt in grey; with an arrow from where the face was. */
  function show() {
    const e = entry(s.k), id = s.id;
    if (e.res) viewer.setField(id, e.res.values, s.cap, null, e.res.mesh);
    else if (e.mesh) viewer.setField(id, new Float32Array(e.mesh.positions.length / 3), 1, null, e.mesh, () => GREY);
    viewer.hideEdges(id);
    const move = s.k * s.step * s.rate;
    const tip = s.point.map((x, i) => x + s.normal[i] * move);
    viewer.setArrow(Math.abs(move) > 1e-9 ? tip : null, s.normal.map(x => x * Math.sign(move)), Math.abs(move), 0x9fd2ff);
    viewer.setGhost(s.k ? entry(0).mesh.positions : null);       // the shape as grabbed, outlined
    status();
  }

  async function solveStep(k, g) {
    const e = g.cache.get(k), doc = docWith(g.name, value(k, g));
    const solver = await gpuSolver();
    // the support and load points move with their faces, or they would no longer lie on the part
    // at the voxel size of the design as grabbed (or of the first variant solved), so the
    // variants differ by their design only
    const { caseId, meta, blob } = await buildCase(doc, g.id, movedRefs(g.id, e.body), g.h);
    g.h ??= meta.h;
    // starting from the last step solved (or the design as grabbed), a few % away; in VR one
    // iteration per GPU submission, so the headset's frames render in between; stopped once
    // the drag has left this step (and is not just passing back through it)
    const from = g.warm ?? (g.base?.u && { P: parse(g.base.case.blob), u: g.base.u });
    const x0 = from ? transfer(from.P, from.u, parse(blob)) : null;
    const sol = await solver.solveMG(blob, { tol: TOL, checkEvery: viewer.renderer.xr.isPresenting ? 1 : 4, signal: e.abort.signal, x0 });
    g.warm = { P: parse(blob), u: sol.u };
    const rr = await fetch(`/api/analyze/result?id=${caseId}`, { method: 'POST', body: sol.u });
    if (!rr.ok) throw new Error((await rr.json().catch(() => ({}))).detail || rr.statusText);
    const stats = JSON.parse(rr.headers.get('X-Stats') || '{}');
    const field = parseField(await rr.arrayBuffer());
    e.res = { meta, stats, values: field.vonMises, displacement: field.displacement,
              case: { caseId, blob, meta }, mesh: { positions: field.positions, normals: field.normals, triFace: field.triFace },
              solve: { ms: sol.setupMs + sol.solveMs, setupMs: sol.setupMs, iterations: sol.iterations }, cad: e.body.positions, u: sol.u };
  }

  // Two queues, so the shape follows the drag while a variant solves: rebuilds (tens of ms)
  // and solves (seconds: the server's voxel model alone is ~1.5 s at Normal). Each takes the
  // step under the hand, then one step ahead in the drag's direction; nothing before a drag.
  const lanes = { geo: false, sol: false };
  let solving = null;                                            // the step being solved: { k, e }
  const ahead = () => { const dir = Math.sign(s.k - s.prevK) || 1; return (s.prefetch ? [s.k, s.k + dir] : [s.k]).filter(k => !(s.v0 > 0 && value(k) <= 0)); };
  function pump() { lane('geo'); lane('sol'); }
  async function lane(name) {
    if (lanes[name]) return;
    lanes[name] = true;
    try {
      while (s?.phase === 'ready' && s.prevK != null) {
        const me = s;
        // a solve takes seconds: not for steps the drag only passes through
        if (name === 'sol') {
          const wait = s.settle - (performance.now() - s.dragged);
          if (wait > 0) { await new Promise(r => setTimeout(r, wait)); continue; }
        }
        const k = name === 'geo' ? ahead().find(k => !entry(k).body && !entry(k).error)
                                 : canSolve(s.id) ? ahead().find(k => entry(k).body && !entry(k).res && !entry(k).solveError) : null;
        if (k == null) break;
        const e = entry(k);
        try {
          // `me`, not `s`, after an await: the hand may have let go meanwhile
          if (name === 'geo') {
            const b = (await regen(docWith(me.name, value(k, me)))).find(x => x.id === me.id);
            if (!b) throw new Error('the part disappears with this value');
            e.body = b;
            e.mesh = { positions: Float32Array.from(b.positions), normals: Float32Array.from(b.normals), triFace: b.triFace };
            lane('sol');                                            // a new shape to solve
          } else {
            e.abort = new AbortController();
            solving = { k, e };
            await solveStep(k, me).finally(() => { solving = null; });
          }
        } catch (err) {
          if (err.name === 'AbortError') continue;                  // left behind: solved again if the drag comes back
          if (name === 'geo') e.error = err.message; else e.solveError = err.message;
        }
        if (s !== me) break;                                        // let go meanwhile
        if (k === s.k) show();
      }
    } finally { lanes[name] = false; }
  }

  return {
    /**
     * Grab body `id` at `point` (mm) on the face with outward unit `normal`. minDrag: the
     * least drag (mm) per step, so a hand's tremor stays within one (VR: the face then moves
     * less than the hand); settle: how long (ms) the drag rests on a step before it is solved;
     * prefetch: also solve the next step ahead (not on a slow GPU, where it holds up the step
     * the drag stops at).
     */
    async grab(id, point, normal, { minDrag = 0, settle = 200, prefetch = true } = {}) {
      if (s) this.cancel();
      const token = gate.start();                                  // Explore, Carve and live runs wait
      s = { id, point, normal, phase: 'probing', token, cap: capValue(), base: current(id), cache: new Map(), settle, minDrag, prefetch };
      s.h = s.base?.meta.h ?? null;
      viewer.setMarks([]);
      status();
      const me = s;
      const size = (() => { const b = S.bodies.model.find(x => x.id === id), [lo, hi] = b.props.bbox; return Math.hypot(...hi.map((h, i) => h - lo[i])); })();
      let best = null;
      for (const v of numericVars()) {
        const step = niceStep(Math.abs(v.value) * 0.05 || 1);
        try {
          const b = (await regen(docWith(v.name, +(v.value + step).toFixed(6)))).find(x => x.id === id);
          const shift = b && faceShift(b, point, normal, size);
          if (shift != null && Math.abs(shift) > 1e-6 * size && (!best || Math.abs(shift / step) > Math.abs(best.rate)))
            best = { name: v.name, v0: v.value, step, rate: shift / step, body: b };
        } catch {}
        if (s !== me) return;
      }
      if (!best) { s.phase = 'none'; status(); if (s.releasing) this.release(); return; }
      Object.assign(s, { name: best.name, v0: best.v0, step: best.step, rate: best.rate, k: 0, phase: 'ready' });
      const cur = S.bodies.model.find(x => x.id === id);
      Object.assign(entry(0), { body: cur, mesh: { positions: Float32Array.from(cur.positions), normals: Float32Array.from(cur.normals), triFace: cur.triFace } });
      if (s.base) entry(0).res = s.base;
      entry(1).body = best.body;                                   // the probe built step 1 already
      entry(1).mesh = { positions: Float32Array.from(best.body.positions), normals: Float32Array.from(best.body.normals), triFace: best.body.triFace };
      show();
      pump();
      // a quick hand moves (and may let go) while the variable is still being found
      if (s.pendingMm != null) this.drag(s.pendingMm);
      if (s.releasing) this.release();
    },
    /** The face has been dragged `mm` along its normal (outward positive). */
    drag(mm) {
      if (s?.phase === 'probing') { s.pendingMm = mm; return; }
      if (s?.phase !== 'ready') return;
      // a step changes only well past its middle, so a drag resting near one stays put
      const x = mm / (Math.sign(s.rate) * Math.max(Math.abs(s.rate * s.step), s.minDrag));
      if (Math.abs(x - s.k) < 0.75) return;
      let k = Math.round(x);
      while (s.v0 > 0 && value(k) <= 0) k++;                        // a size stays positive
      if (k === s.k) return;
      s.prevK = s.k;
      s.k = k;
      s.dragged = performance.now();
      if (solving && solving.k !== k && !(s.prefetch && solving.k === k + Math.sign(k - s.prevK))) solving.e.abort.abort();
      show();
      pump();
    },
    /** Let go: keep the value (one undo step), or nothing if it did not move. */
    async release() {
      if (!s) return;
      const g = s;
      if (g.phase === 'probing') { g.releasing = true; return; }   // grab() lets go once it knows the variable
      s = null;
      viewer.setArrow(null);
      viewer.setGhost(null);
      const e = g.phase === 'ready' && g.k !== 0 ? g.cache.get(g.k) ?? {} : null, v = e && value(g.k, g);
      if (e && !e.body && !e.error) {                                // let go before this step was rebuilt
        try { e.body = (await regen(docWith(g.name, v))).find(x => x.id === g.id); } catch (err) { e.error = err.message; }
      }
      // a solve still running finishes first (one at a time on the GPU); then this step's is
      // solved here if it is still missing, and handed to Analyze with the value
      if (solving && solving.k !== g.k) solving.e.abort.abort();     // a step the hand left: not needed
      const finish = e?.body && !e.error && !e.res && !e.solveError && canSolve(g.id);
      if (finish || lanes.sol) onStatus({ phase: 'finishing', id: g.id, name: g.name, value: v });
      while (lanes.sol) await new Promise(r => setTimeout(r, 50));
      if (finish && !e.res && !e.solveError) {
        e.abort = new AbortController();
        try { await solveStep(g.k, g); } catch (err) { e.solveError = err.message; }
      }
      const keep = e?.body && !e.error;
      commit(keep ? { [g.name]: v } : null, g.id, keep ? e.res ?? null : null, g.token, keep ? e.body : null);
    },
    cancel() { if (!s) return; const g = s; s = null; solving?.e.abort.abort(); viewer.setArrow(null); viewer.setGhost(null); commit(null, g.id, null, g.token); },
    active: () => !!s,
    /** Whether the document has a numeric variable a face could follow. */
    available: () => numericVars().length > 0,
  };
}
