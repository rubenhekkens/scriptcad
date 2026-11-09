// Push to load: press on a part and feel it respond.
//
// The voxel model of the body's last analysis is reused: its forces are replaced by a patch
// of force where you press (spread over the surface nodes within a palm-sized radius,
// weighted towards the centre), the GPU solves, and the server turns the displacements into
// stresses on the display mesh. While the press lasts, this repeats as fast as it can with
// the latest force, so stress and deformed shape follow the press; letting go restores the
// body's own load case. Used by the desktop Push tool and by VR controllers.

import { parse } from './fea/solver.js';

const TOL = 1e-3;          // 1e-3 is a third fewer iterations than 1e-5 and moves the slab's deflection by 0.1%

/**
 * onProgress({ id, point, fraction }) reports the wait for a press's first answer: 0.1 once
 * the solve starts, then by the solver's convergence (multigrid shrinks the residual by a
 * steady factor per iteration, so log(residual) / log(tolerance) runs about evenly with
 * time) up to 0.9, when only the stresses are left.
 */
export function createPush({ result, gpuSolver, buildCase, doc, parseField, onUpdate, onEnd, onProgress }) {
  let press = null;        // { id, point (mm), dir (unit, into the part), force (N) }
  let running = false;

  /** The body's voxel model, rebuilt if the server has forgotten it. */
  async function model(id, rebuild = false) {
    const r = result(id);
    if (!r) return null;
    if (!r.push || rebuild) {
      const c = !rebuild && r.case ? r.case : await buildCase(doc(), id);
      r.case = { caseId: c.caseId, blob: c.blob, meta: c.meta ?? r.case?.meta };
      const P = parse(c.blob);
      r.push = { ...r.case, P, F0: new Float32Array(P.force) };
    }
    return r.push;
  }

  /** Nodal forces: `force` newtons along `dir`, on the surface nodes near `point`. */
  function patchForces(P, point, dir, force, radius) {
    const { nx, ny, nz, h, origin, emod } = P;
    const F = new Float32Array(P.force.length);
    const solid = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && emod[i + nx * (j + ny * k)] > 0;
    for (let tries = 0; tries < 4; tries++, radius *= 2) {
      const lo = [0, 1, 2].map(a => Math.max(0, Math.floor((point[a] - radius - origin[a]) / h)));
      const hi = [0, 1, 2].map(a => Math.min([nx, ny, nz][a], Math.ceil((point[a] + radius - origin[a]) / h)));
      const nodes = [], weights = [];
      for (let K = lo[2]; K <= hi[2]; K++) for (let J = lo[1]; J <= hi[1]; J++) for (let I = lo[0]; I <= hi[0]; I++) {
        let n = 0;
        for (let a = 0; a < 8; a++) n += solid(I - (a & 1), J - ((a >> 1) & 1), K - ((a >> 2) & 1));
        if (n === 0 || n === 8) continue;                    // not on the surface
        const d = Math.hypot(origin[0] + h * I - point[0], origin[1] + h * J - point[1], origin[2] + h * K - point[2]);
        if (d > radius) continue;
        nodes.push(I + (nx + 1) * (J + (ny + 1) * K));
        weights.push(1 - d / radius + 0.05);
      }
      if (!nodes.length) continue;
      const total = weights.reduce((a, b) => a + b, 0);
      nodes.forEach((n, k) => { for (let c = 0; c < 3; c++) F[3 * n + c] = force * dir[c] * weights[k] / total; });
      return { F, nodes: nodes.length, radius };
    }
    return null;
  }

  // The response is linear in the force, and a press stays at one point: solve once for a unit
  // force along each axis the press direction uses (one axis for a straight press, at most
  // three), and every later update is a weighted sum of those - only the stresses go to the server.
  let basis = null;        // { key, patch, u: [ux, uy, uz] } for the current press point

  async function loop() {
    if (running) return;
    running = true;
    try {
      const solver = await gpuSolver();
      let shown = null;                                                       // the force and direction on screen
      while (press) {
        const p = { ...press };
        let m = await model(p.id);
        if (!m) break;
        const { P } = m;
        const key = `${p.id}|${m.caseId}|${p.point.join()}`;
        if (basis?.key !== key) {
          const size = Math.hypot(P.nx, P.ny, P.nz) * P.h;
          const radius = Math.max(2.5 * P.h, Math.min(40, 0.08 * size));     // a palm, or less on small parts
          const patch = patchForces(P, p.point, [1, 0, 0], 1, radius);
          if (!patch) { onUpdate({ ...p, error: 'nothing to push on here' }); break; }
          basis = { key, patch, w: patch.F.filter((_, i) => i % 3 === 0), u: [] };   // node weights, summing to 1
          shown = null;
        }
        // an oblique press solved exactly for its direction just scales while that direction holds
        const exact = basis.exact?.dir === p.dir.join() ? basis.exact.u : null;
        const need = exact ? [] : [0, 1, 2].filter(c => Math.abs(p.dir[c]) > 1e-3 && !basis.u[c]);
        if (!need.length && shown && shown.force === p.force && shown.dir.join() === p.dir.join()) {
          await new Promise(r => setTimeout(r, 30));                          // nothing changed: wait for the next input
          continue;
        }
        const t0 = performance.now();
        const progress = f => { if (!shown) onProgress?.({ id: p.id, point: p.point, fraction: f }); };
        const solveFor = async dir => {
          const F = P.force.fill(0), w = basis.w;
          for (let n = 0; n < w.length; n++) if (w[n]) for (let c = 0; c < 3; c++) F[3 * n + c] = w[n] * dir[c];
          progress(0.1);
          // one iteration per GPU submission, so frames (in VR, the headset's) can render in between
          const sol = await solver.solveMG(m.blob, { tol: TOL, checkEvery: 1,
            onProgress: (it, rel) => progress(0.1 + 0.8 * Math.min(1, Math.max(0, Math.log(rel) / Math.log(TOL)))) });
          progress(0.9);
          return sol;
        };
        let u, sol = null;
        const scaled = (v, s) => { const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = s * v[i]; return o; };
        if (exact) u = scaled(exact, p.force);
        else if (need.length > 1 && !shown) {
          // an oblique first press: one solve along its own direction (the axes follow only if it turns)
          sol = await solveFor(p.dir);
          basis.exact = { dir: p.dir.join(), u: sol.u };
          u = scaled(sol.u, p.force);
        } else {
          if (need.length) { sol = await solveFor([0, 1, 2].map(c => +(c === need[0]))); basis.u[need[0]] = sol.u; }
          if (need.length > 1) continue;                                      // another axis to go before it adds up
        }
        if (!u) {
          u = new Float32Array(P.ndof);
          for (let c = 0; c < 3; c++) {
            const s = p.force * p.dir[c], uc = basis.u[c];
            if (Math.abs(p.dir[c]) > 1e-3) for (let i = 0; i < u.length; i++) u[i] += s * uc[i];
          }
        }
        const t1 = performance.now();
        const patch = { nodes: basis.patch.nodes, radius: basis.patch.radius };
        // the display mesh of a case never changes: fetch it once, then only the values
        let rr = await fetch(`/api/analyze/result?id=${m.caseId}${m.mesh ? '&values=true' : ''}`, { method: 'POST', body: u });
        if (rr.status === 410) { await model(p.id, true); continue; }          // the server forgot the case
        if (!rr.ok) throw new Error((await rr.json().catch(() => ({}))).detail || rr.statusText);
        const stats = JSON.parse(rr.headers.get('X-Stats') || '{}');
        const buf = await rr.arrayBuffer();
        let field;
        if (m.mesh) {
          const n = new Uint32Array(buf, 0, 1)[0];
          field = { ...m.mesh, vonMises: new Float32Array(buf, 4, n), displacement: new Float32Array(buf, 4 + 4 * n, 3 * n) };
        } else {
          field = parseField(buf);
          m.mesh = { positions: field.positions, normals: field.normals, triFace: field.triFace };
        }
        if (!press || press.id !== p.id) break;                                 // released meanwhile
        const t2 = performance.now();
        onUpdate({ ...p, stats, field, ms: t2 - t0, patch, solved: !!sol,
                   timing: { setup: sol?.setupMs ?? 0, solve: sol?.solveMs ?? 0, gpuTotal: t1 - t0, stresses: t2 - t1 } });
        shown = p;
      }
    } catch (e) {
      onUpdate({ ...(press || {}), error: e.message });
    } finally {
      running = false;
      if (!press) onEnd();
    }
  }

  return {
    /** Start pressing body `id` at `point` (mm) along unit `dir` with `force` newtons. */
    start(id, point, dir, force) { press = { id, point, dir, force }; loop(); },
    /** Change the force (or direction) of the current press. */
    update(force, dir) { if (press) { press.force = force; if (dir) press.dir = dir; } },
    stop() { const was = !!press; press = null; if (was && !running) onEnd(); },
    active: () => !!press,
  };
}
