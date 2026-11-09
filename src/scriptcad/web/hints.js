// Where to pull: for each variable of a solved body, how much its deflection and mass change
// per step of it, from the one solve the body already has (no solve per variable).
//
// Adding material where the strain energy density sigma:eps is high stiffens a part most:
// to first order the compliance C = f.u (the work of the load, which deflection follows)
// drops by sigma:eps x the volume added, and rises by it for volume removed (the shape
// derivative of compliance). Each variable is nudged once and the model rebuilt; the server
// compares the new shape with the solved one voxel by voxel and sums that. A variable that
// buys much stiffness per gram is worth adding to, one that buys little is worth trimming.

import { niceStep, regen } from './pull.js';

async function shapeChange(caseId, positions) {
  const r = await fetch(`/api/analyze/shape?id=${caseId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                           body: JSON.stringify({ positions: Array.from(positions) }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

/**
 * Hints for the bodies of `doc`: `targets` maps a body id to { body (regen), result (its
 * analysis result) }. Per body, per numeric variable that changes it: { name, value, step
 * (the nudge, signed so that it adds material), defl, mass (relative changes per step),
 * ratio (deflection saved per mass added, both relative), spots: [{ at, dir }] (where it
 * grows, which way) }, best ratio first. One rebuild per variable serves every body.
 */
export async function pullHints({ doc, targets, onProgress = () => {} }) {
  const out = new Map([...targets.keys()].map(id => [id, []]));
  const vars = (doc.variables || []).filter(v => typeof v.value === 'number');
  for (const [i, v] of vars.entries()) {
    onProgress(i, vars.length, v.name);
    // a nudge of about 5%, but of at least a voxel or so, or the voxels would not see it
    const h = Math.max(...[...targets.values()].map(t => t.result.meta.h || 0));
    let todo = [...targets.keys()];
    for (const sign of [1, -1]) {
      const step = sign * niceStep(Math.max(Math.abs(v.value) * 0.05, 1.5 * h));
      const vdoc = { ...doc, variables: doc.variables.map(x => x === v ? { ...x, value: +(v.value + step).toFixed(6) } : x) };
      let bodies;
      try { bodies = await regen(vdoc); } catch { continue; }
      const shrinks = [];
      for (const id of todo) {
        const { body, result } = targets.get(id);
        const nb = bodies.find(b => b.id === id), V = body.props.volume;
        if (!nb || Math.abs(nb.props.volume - V) < 1e-9 * V) continue;   // this variable leaves the body alone
        let sc;
        try { sc = await shapeChange(result.case.caseId, nb.positions); } catch { continue; }
        if (!sc.grow) { shrinks.push(id); continue; }                    // only shrinks this way: try the other
        const defl = sc.d_compliance / sc.compliance, mass = (nb.props.volume - V) / V;
        if (!(mass > 0)) { shrinks.push(id); continue; }                 // lighter this way: the other way adds
        out.get(id).push({ name: v.name, value: v.value, step, defl, mass, ratio: -defl / mass, spots: sc.grow });
      }
      if (!(todo = shrinks).length) break;
    }
  }
  for (const list of out.values()) list.sort((a, b) => b.ratio - a.ratio);
  return out;
}
