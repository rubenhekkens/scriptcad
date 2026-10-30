// Runs web/fea/topo.js on a problem blob with a small CPU solver (Jacobi-PCG) instead of the
// GPU, and prints the numbers test_topo.py checks. Usage: node topo_check.mjs <blob> <web dir url>
import { readFileSync } from 'node:fs';

const [blobPath, web] = process.argv.slice(2);
const { parse } = await import(new URL('fea/solver.js', web));
const T = await import(new URL('fea/topo.js', web));

const file = readFileSync(blobPath);
const fresh = () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const blob = fresh();
const P = parse(blob);

/** Enclosed volume of an indexed triangle mesh (divergence theorem). */
function volume({ positions: p, index }) {
  let v = 0;
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [3 * index[t], 3 * index[t + 1], 3 * index[t + 2]];
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
       + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function applyK(P, x, out) {
  const { nx, ny, nz, ke, emod, fixed } = P;
  out.fill(0);
  const ue = new Float64Array(24), dofs = new Int32Array(24);
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    const E = emod[e];
    if (!E) continue;
    for (let a = 0; a < 8; a++) {
      const n = (i + (a & 1)) + (nx + 1) * ((j + ((a >> 1) & 1)) + (ny + 1) * (k + ((a >> 2) & 1)));
      for (let c = 0; c < 3; c++) { dofs[3 * a + c] = 3 * n + c; ue[3 * a + c] = fixed[3 * n + c] ? 0 : x[3 * n + c]; }
    }
    for (let r = 0; r < 24; r++) {
      if (fixed[dofs[r]]) continue;
      let t = 0;
      for (let c = 0; c < 24; c++) t += ke[24 * r + c] * ue[c];
      out[dofs[r]] += E * t;
    }
  }
}

function solve(P) {
  const n = P.ndof, f = new Float64Array(n), d = new Float64Array(n);
  const { nx, ny, nz, ke, emod } = P;
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    if (!emod[e]) continue;
    for (let a = 0; a < 8; a++) {
      const m = (i + (a & 1)) + (nx + 1) * ((j + ((a >> 1) & 1)) + (ny + 1) * (k + ((a >> 2) & 1)));
      for (let c = 0; c < 3; c++) d[3 * m + c] += emod[e] * ke[(3 * a + c) * 25];
    }
  }
  for (let i = 0; i < n; i++) if (!P.fixed[i] && d[i] > 0) f[i] = P.force[i];
  const x = new Float64Array(n), r = f.slice(), z = new Float64Array(n), q = new Float64Array(n);
  const prec = () => { for (let i = 0; i < n; i++) z[i] = !P.fixed[i] && d[i] > 0 ? r[i] / d[i] : 0; };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
  prec();
  const p = z.slice();
  let rz = dot(r, z);
  const fn = Math.sqrt(dot(f, f));
  for (let it = 0; it < 20000 && Math.sqrt(dot(r, r)) > 1e-9 * fn; it++) {
    applyK(P, p, q);
    const al = rz / dot(p, q);
    for (let i = 0; i < n; i++) { x[i] += al * p[i]; r[i] -= al * q[i]; }
    prec();
    const rz2 = dot(r, z);
    for (let i = 0; i < n; i++) p[i] = z[i] + (rz2 / rz) * p[i];
    rz = rz2;
  }
  return { u: Float32Array.from(x) };
}

const S0 = T.prepare(P);
const full = solve(P);
const r0 = T.response(P, full.u);
const energySum = T.strainEnergy(P, full.u).reduce((a, b) => a + b, 0);
const box = T.surface(P);
const design = Uint8Array.from(P.emod, e => e > 0 ? 1 : 0);
const boxSmooth = T.smoothSurface(P, T.strainEnergy(P, full.u), design);

// baseline at the same volume: the top half of the beam (the load sits on top)
const E0 = new Float32Array(P.emod), fixed0 = new Uint32Array(P.fixed);
for (let e = 0; e < P.emod.length; e++) if (((e / (P.nx * P.ny)) | 0) < P.nz / 2) P.emod[e] = 0;
for (let i = 0; i < P.fixed.length; i++) P.fixed[i] = fixed0[i];
for (let n = 0; n < P.nn; n++) {
  const I = n % (P.nx + 1), K = (n / ((P.nx + 1) * (P.ny + 1))) | 0;
  if (K < P.nz / 2) P.fixed[3 * n] = P.fixed[3 * n + 1] = P.fixed[3 * n + 2] = 1;
}
const half = T.response(P, solve(P).u);
P.emod.set(E0); P.fixed.set(fixed0);

let steps = 0;
const res = await T.optimize(blob, P, () => solve(P), { target: 0.5, er: 0.05, rmin: 1.5, onStep: () => { steps++; } });
const pieces = T.removeIslands(P, S0.held);
let keptAll = true;
for (let e = 0; e < P.emod.length; e++) if (S0.keep[e] && !P.emod[e]) keptAll = false;
const stl = T.stl(box.positions);
let solidCount = 0;
for (let e = 0; e < P.emod.length; e++) solidCount += P.emod[e] > 0;
const carvedSmooth = T.smoothSurface(P, res.energy, design);

// with a deflection limit: the lightest design within it, and the step after it went over
const P2 = parse(fresh()), limit = 1.5 * r0.dmax;
const seen = [];
const lim = await T.optimize(null, P2, () => solve(P2), { target: 0.2, er: 0.05, rmin: 1.5, maxDefl: limit,
                                                          onStep: s => { seen.push(s.dmax); } });

console.log(JSON.stringify({
  compliance0: r0.compliance, energySum, boxTriangles: box.positions.length / 9, stlBytes: stl.byteLength,
  halfCompliance: half.compliance, optCompliance: res.compliance, fraction: res.fraction, steps, done: res.done,
  islandsLeft: pieces, keptAll, nKeep: S0.nKeep, nDesign: S0.nDesign,
  boxVolume: volume(boxSmooth), voxelVolume: solidCount * P.h ** 3, carvedVolume: volume(carvedSmooth),
  limit, limStop: lim.stop, limDmax: lim.dmax, limFraction: lim.fraction, lastSeen: seen.at(-1),
}));
