// B1 pile table (pallet lift platform): conventional welded frame vs topology optimisation.
//
// Run in the ScriptCAD page with File > Load B1 pile table example open (paste into the
// devtools console, or a page-script runner). Everything uses the app's own GPU solver and
// optimiser (fea/solver.js, fea/topo.js) on ONE voxel grid of the 1300 x 1100 x 120 mm
// envelope, so every design sees exactly the same supports, loads and discretisation.
//
// Load cases (forces on the top-surface nodes, re-weighted from the server's top-face load):
//   LC1  full B1 pile: 13 kN over the 1200 x 1000 pallet footprint  (design load)
//   LC2  short B2 pile: 5.7 kN over 720 x 520 mm at the pallet's front edge (robustness)
// Designs:
//   solid     the full envelope (upper bound on stiffness, 1.35 t of steel)
//   frame     ladder frame of hollow 80 x 120 tubes (3 longitudinal, 4 cross) under a 13 mm plate
//   E1        carved for LC1 to the frame's mass
//   E2        carved for LC1 to the lightest design no softer than the frame
// Results land in window.__px.results; progress in window.__px.log.

const { parse, VoxelSolver } = await import('/fea/solver.js');
const T = await import('/fea/topo.js');
const { fieldColor } = await import('/viewer.js');

const S = window.scriptcad.S, viewer = window.scriptcad.viewer;
const an = S.doc.analysis, bs = an.bodies.deck;
const X = window.__px = { log: [], results: {}, designs: {} };
const t0 = performance.now();
const say = m => X.log.push(`${((performance.now() - t0) / 1000).toFixed(0)} s: ${m}`);

const PALLET = [50, 1250, 50, 1050], B2 = [290, 1010, 50, 570];   // x0, x1, y0, y1 (mm)
const LC1_N = 13000, LC2_N = 5700, STEEL = 7.85e-3;               // N, N, g/mm3

const setup = { body: 'deck', material: 'steel', quality: 'fine', fixed: bs.fixed, load: { ...an.load, faces: bs.loads } };
const resp = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                           body: JSON.stringify({ doc: S.doc, setup }) });
if (!resp.ok) throw new Error((await resp.json()).detail);
const meta = JSON.parse(resp.headers.get('X-Meta'));
const blob = await resp.arrayBuffer();
const P = parse(blob);
const solver = await VoxelSolver.create();
const E0 = new Float32Array(P.emod), fixed0 = new Uint32Array(P.fixed), Ftop = new Float32Array(P.force);
const NX = P.nx + 1, NY = P.ny + 1;
const nodeXY = n => [P.origin[0] + P.h * (n % NX), P.origin[1] + P.h * (((n / NX) | 0) % NY)];
const inside = ([x, y], [x0, x1, y0, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
say(`grid ${P.nx} x ${P.ny} x ${P.nz}, h = ${P.h.toFixed(2)} mm, ${meta.free_dofs.toLocaleString()} unknowns`);

/** The top-face load restricted to a footprint, scaled to `total` newtons. */
function loadCase(box, total) {
  const F = new Float32Array(Ftop.length);
  let s = 0;
  for (let n = 0; n < P.nn; n++) if (Ftop[3 * n + 2] && inside(nodeXY(n), box)) { F[3 * n + 2] = Ftop[3 * n + 2]; s += Ftop[3 * n + 2]; }
  for (let n = 0; n < P.nn; n++) F[3 * n + 2] *= -total / s;
  return F;
}
const LC = { LC1: loadCase(PALLET, LC1_N), LC2: loadCase(B2, LC2_N) };

function mask(fn) {
  const m = new Uint8Array(E0.length);
  for (let k = 0, e = 0; k < P.nz; k++) for (let j = 0; j < P.ny; j++) for (let i = 0; i < P.nx; i++, e++)
    if (E0[e] && fn(P.origin[0] + P.h * (i + 0.5), P.origin[1] + P.h * (j + 0.5), P.origin[2] + P.h * (k + 0.5))) m[e] = 1;
  return m;
}
const count = m => m.reduce((a, b) => a + b, 0);
const solid = mask(() => true);
// hollow rectangular tubes (80 wide, full depth, walls one voxel ~ 6.6 mm) welded under the plate
const WALL = 7;
const tube = (v, a) => v >= a && v <= a + 80 && (v - a < WALL || a + 80 - v < WALL);
const inTube = (v, a) => v >= a && v <= a + 80;
const frame = mask((x, y, z) => {
  if (z < 0 || z > 120 - 13) return true;                                    // chain lugs, 13 mm deck plate
  const ys = [0, 510, 1020].filter(a => inTube(y, a)), xs = [0, 393, 827, 1220].filter(a => inTube(x, a));
  if (!ys.length && !xs.length) return false;
  if (z < WALL) return true;                                                 // bottom wall of every tube
  return ys.some(a => tube(y, a)) || xs.some(a => tube(x, a));               // side walls
});

function setDesign(m) {
  for (let e = 0; e < E0.length; e++) P.emod[e] = m[e] ? E0[e] : 0;
  T.syncFixed(P, fixed0);
}

/** Deflection, compliance and pile-top flatness (sag across the loaded top) of a design. */
async function evaluate(m, lc) {
  setDesign(m);
  P.force.set(LC[lc]);
  const { u, iterations } = await solver.solveMG(blob, { tol: 1e-6 });
  const r = T.response(P, u);
  let lo = Infinity, hi = -Infinity;
  for (let n = 0; n < P.nn; n++) if (LC[lc][3 * n + 2]) { lo = Math.min(lo, u[3 * n + 2]); hi = Math.max(hi, u[3 * n + 2]); }
  return { dmax_mm: r.dmax, compliance_Nmm: r.compliance, sag_mm: hi - lo, iterations, energy: lc === 'LC1' ? T.strainEnergy(P, u) : null };
}

async function record(name, m) {
  const res = { mass_kg: count(m) * P.h ** 3 * STEEL / 1000, share: count(m) / count(solid) };
  for (const lc of ['LC1', 'LC2']) {
    const { energy, ...r } = await evaluate(m, lc);
    res[lc] = r;
    if (energy) X.designs[name] = { mask: m, energy };
  }
  X.results[name] = res;
  say(`${name}: ${res.mass_kg.toFixed(1)} kg, LC1 ${(res.LC1.dmax_mm).toFixed(3)} mm, LC2 ${(res.LC2.dmax_mm).toFixed(3)} mm`);
}

async function carve(opts) {
  P.emod.set(E0); P.fixed.set(fixed0); P.force.set(LC.LC1);
  const rmin = 4 * Math.cbrt(meta.cad_volume / 200000) / P.h;          // the app's Medium member (~38 mm)
  let steps = 0;
  const res = await T.optimize(blob, P, b => solver.solveMG(b, { tol: 1e-6 }), {
    rmin, maxIter: 160, ...opts, onStep: s => { steps++; if (s.iter % 10 === 0) say(`  step ${s.iter}: ${(s.fraction * 100).toFixed(1)}%, ${s.dmax.toFixed(3)} mm`); } });
  return { m: Uint8Array.from(P.emod, e => e > 0 ? 1 : 0), stop: res.stop, steps };
}

X.done = (async () => {
  try {
    await record('solid', solid);
    await record('frame', frame);
    const share = count(frame) / count(solid);
    const e1 = await carve({ target: share });
    await record('E1_same_mass', e1.m);
    X.results.E1_same_mass.optimiser = { stop: e1.stop, steps: e1.steps };
    const e2 = await carve({ target: 0.03, maxDefl: X.results.frame.LC1.dmax_mm });
    await record('E2_same_stiffness', e2.m);
    X.results.E2_same_stiffness.optimiser = { stop: e2.stop, steps: e2.steps };
    X.meta = { h_mm: P.h, grid: [P.nx, P.ny, P.nz], unknowns: meta.free_dofs, seconds: (performance.now() - t0) / 1000 };
    say('done');
  } catch (e) { say('error ' + e.message); throw e; }
})();

/** Show a design in the viewer: smoothed surface coloured by LC1 strain energy. */
window.__pxShow = name => {
  const d = X.designs[name];
  setDesign(d.mask);
  const design = Uint8Array.from(E0, e => e > 0 ? 1 : 0);
  const m = T.smoothSurface(P, d.energy, design);
  const vals = [];
  for (let e = 0; e < d.energy.length; e += 7) if (d.mask[e]) vals.push(d.energy[e]);
  vals.sort((a, b) => a - b);
  const ref = vals[Math.floor(0.99 * (vals.length - 1))] || 1;
  const colors = new Float32Array(m.positions.length);
  for (let v = 0; v < m.vertexValue.length; v++) colors.set(fieldColor(Math.min(Math.sqrt(Math.max(m.vertexValue[v], 0) / ref), 1)), 3 * v);
  viewer.setVoxelPreview('deck', { positions: m.positions, normals: m.normals, colors, index: m.index });
};
'started';
