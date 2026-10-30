// Carve the chaise longue (File > Load chaise longue example) with a body-weight distribution.
// The app spreads a load over the load faces by area; a reclining person presses mostly with
// the pelvis. This harness re-weights the top-surface forces by region along the length
// (y, from the foot end) and runs the app's optimiser on the GPU. Paste into the page console.
//   foot end to calves  y <  450   10%       pelvis           850-1080   40%
//   thighs              450-850   15%        lower back      1080-1300   20%
//   upper back + head   y >= 1300  15%       total 1200 N (80 kg person x 1.5 for sitting down)
const { parse, VoxelSolver } = await import('/fea/solver.js');
const T = await import('/fea/topo.js');
const { fieldColor } = await import('/viewer.js');
const S = window.scriptcad.S, viewer = window.scriptcad.viewer;
const an = S.doc.analysis, bs = an.bodies.env;
const X = window.__cx = { log: [] };
const t0 = performance.now();
const say = m => X.log.push(`${((performance.now() - t0) / 1000).toFixed(0)} s: ${m}`);
const REGIONS = [[0, 450, 0.10], [450, 850, 0.15], [850, 1080, 0.40], [1080, 1300, 0.20], [1300, 1e9, 0.15]];
const TOTAL = 1200, KEEP = 0.10, MEMBER = 2.5;     // share of the volume; the app's Fine member

const setup = { body: 'env', material: an.material, quality: 'fine', fixed: bs.fixed, load: { ...an.load, faces: bs.loads } };
const resp = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc: S.doc, setup }) });
if (!resp.ok) throw new Error((await resp.json()).detail);
const meta = JSON.parse(resp.headers.get('X-Meta'));
const blob = await resp.arrayBuffer();
const P = parse(blob);
const solver = await VoxelSolver.create();
const NX = P.nx + 1, NY = P.ny + 1;
const nodeY = n => P.origin[1] + P.h * (((n / NX) | 0) % NY);

// body-weight distribution: within a region the server's area weighting is kept
const F = P.force, sums = REGIONS.map(() => 0);
const region = y => REGIONS.findIndex(([a, b]) => y >= a && y < b);
for (let n = 0; n < P.nn; n++) if (F[3 * n + 2]) sums[region(nodeY(n))] += F[3 * n + 2];
for (let n = 0; n < P.nn; n++) if (F[3 * n + 2]) { const r = region(nodeY(n)); F[3 * n + 2] *= -REGIONS[r][2] * TOTAL / sums[r]; }
say(`grid ${P.nx} x ${P.ny} x ${P.nz}, h ${P.h.toFixed(1)} mm, ${meta.free_dofs.toLocaleString()} unknowns, region loads ${sums.map((s, i) => REGIONS[i][2] * TOTAL + ' N').join(' / ')}`);

const design = Uint8Array.from(P.emod, e => e > 0 ? 1 : 0);
const rmin = MEMBER * Math.cbrt(meta.cad_volume / 200000) / P.h;
X.done = (async () => {
  const res = await T.optimize(blob, P, b => solver.solveMG(b, { tol: 1e-6 }), {
    target: KEEP, rmin, maxIter: 160,
    onStep: s => { X.last = s; if (s.iter % 10 === 0) say(`step ${s.iter}: ${(s.fraction * 100).toFixed(1)}%, ${(s.dmax * 1000).toFixed(0)} µm`); } });
  X.res = { stop: res.stop, fraction: res.fraction, dmax_mm: res.dmax, target: res.target, minShare: res.minShare,
            mass_kg: res.fraction * meta.mass_g / 1000, solid_mass_kg: meta.mass_g / 1000, member_mm: rmin * P.h, h_mm: P.h };
  // smoothed, coloured by how hard the material works
  const m = T.smoothSurface(P, res.energy, design);
  const vals = [];
  for (let e = 0; e < res.energy.length; e += 7) if (P.emod[e]) vals.push(res.energy[e]);
  vals.sort((a, b) => a - b);
  const ref = vals[Math.floor(0.99 * (vals.length - 1))] || 1;
  const colors = new Float32Array(m.positions.length);
  for (let v = 0; v < m.vertexValue.length; v++) colors.set(fieldColor(Math.min(Math.sqrt(Math.max(m.vertexValue[v], 0) / ref), 1)), 3 * v);
  X.mesh = { positions: m.positions, normals: m.normals, colors, index: m.index };
  viewer.setVoxelPreview('env', X.mesh);
  say('done');
})();
'started';
