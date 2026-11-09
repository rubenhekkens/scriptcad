// Natural frequencies and mode shapes: how a part rings when tapped.
//
// K phi = w^2 M phi, the lowest few, by subspace iteration: each round solves K Y = M X for a
// block of vectors with the static multigrid solver (its hierarchy is built once for the
// blob and reused; each solve starts from the last round's answer, so later rounds are
// cheap), then a Rayleigh-Ritz step on the block. Since K Y = M X, the projected stiffness
// is Y'MX and the projected mass Y'MY: no stiffness product is needed outside the solver.
// The mass is lumped: each voxel's (density x fill x h^3) shared over its 8 nodes.
//
// Units: N, mm, tonnes (E in MPa, density g/cm^3 = 1e-9 t/mm^3), so w^2 comes out in 1/s^2.

import { parse } from './fea/solver.js';

/** Eigenpairs of the symmetric n x n A (Float64Array, row major), by Jacobi rotations. */
function jacobi(A, n) {
  const a = Float64Array.from(A), V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p * n + k], aqk = a[q * n + k];
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k * n + p], vkq = V[k * n + q];
        V[k * n + p] = c * vkp - s * vkq; V[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors: V };
}

/** The generalized eigenpairs of small symmetric (Kp, Mp), Mp positive definite: ascending. */
function smallEigen(Kp, Mp, n) {
  // Mp = L L'; C = L^-1 Kp L^-T; then q = L^-T v
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = Mp[i * n + j];
    for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-300)) : s / L[j * n + j];
  }
  const solveL = b => { const x = new Float64Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k]; x[i] = s / L[i * n + i]; } return x; };
  const solveLT = b => { const x = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; } return x; };
  const Y = new Float64Array(n * n);                     // L^-1 Kp, by columns
  for (let j = 0; j < n; j++) { const col = solveL(Array.from({ length: n }, (_, i) => Kp[i * n + j])); for (let i = 0; i < n; i++) Y[i * n + j] = col[i]; }
  const C = new Float64Array(n * n);                     // (L^-1 (L^-1 Kp)')' = L^-1 Kp L^-T
  for (let i = 0; i < n; i++) { const row = solveL(Array.from({ length: n }, (_, j) => Y[i * n + j])); for (let j = 0; j < n; j++) C[j * n + i] = row[j]; }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) C[i * n + j] = C[j * n + i] = (C[i * n + j] + C[j * n + i]) / 2;
  const { values, vectors } = jacobi(C, n);
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  return order.map(([v, i]) => ({ value: v, q: solveLT(Array.from({ length: n }, (_, k) => vectors[k * n + i])) }));
}

/**
 * The `count` lowest natural modes of a problem blob (meta from the server: E, rho). solve(blob,
 * x0) solves the blob's current forces (Float32Array u). Returns [{ hz, shape (ndof, unit
 * max) }], lowest first. onProgress(fraction) as the rounds go.
 */
export async function naturalModes({ blob, meta, solve, count = 4, rounds = 10, onProgress = () => {}, alive = () => true }) {
  const P = parse(blob), n = P.ndof, p = count + 2;
  const rho = meta.rho * 1e-9;                         // t/mm^3
  // lumped mass per DOF, zero on held and empty DOFs
  const M = new Float64Array(n), NX = P.nx + 1, NY = P.ny + 1;
  for (let k = 0; k < P.nz; k++) for (let j = 0; j < P.ny; j++) for (let i = 0; i < P.nx; i++) {
    const e = P.emod[i + P.nx * (j + P.ny * k)];
    if (!e) continue;
    const m = rho * (e / meta.E) * P.h ** 3 / 8;
    for (let a = 0; a < 8; a++) {
      const node = (i + (a & 1)) + NX * ((j + ((a >> 1) & 1)) + NY * (k + ((a >> 2) & 1)));
      for (let c = 0; c < 3; c++) M[3 * node + c] += m;
    }
  }
  for (let i = 0; i < n; i++) if (P.fixed[i]) M[i] = 0;
  const free = []; for (let i = 0; i < n; i++) if (M[i] > 0) free.push(i);
  // a start: smooth random fields (low modes are smooth), one per vector
  let X = Array.from({ length: p }, (_, v) => {
    const x = new Float64Array(n);
    const f = [1 + v % 3, 1 + (v >> 1) % 3, 1 + v % 2], ph = [v * 1.3, v * 0.7, v * 2.1];
    for (const i of free) {
      const node = Math.floor(i / 3), I = node % NX, J = Math.floor(node / NX) % NY, K = Math.floor(node / (NX * NY));
      x[i] = Math.sin(f[0] * Math.PI * I / NX + ph[0] + (i % 3)) * Math.sin(f[1] * Math.PI * J / NY + ph[1]) * Math.sin(f[2] * Math.PI * K / (P.nz + 1) + ph[2]) + 0.1 * Math.random();
    }
    return x;
  });
  let Y = X.map(() => null), lambda = null;
  for (let round = 0; round < rounds; round++) {
    // Y = K^-1 M X, each from its last answer
    const MX = X.map(x => { const b = new Float64Array(n); for (const i of free) b[i] = M[i] * x[i]; return b; });
    for (let v = 0; v < p; v++) {
      if (!alive()) return null;
      P.force.set(MX[v]);
      const x0 = Y[v] && lambda ? Float32Array.from(X[v], x => x / lambda[v]) : null;
      Y[v] = Float64Array.from(await solve(blob, x0));
      onProgress((round * p + v + 1) / (rounds * p));
    }
    // Rayleigh-Ritz: Kp = Y'MX, Mp = Y'MY
    const Kp = new Float64Array(p * p), Mp = new Float64Array(p * p);
    for (let a = 0; a < p; a++) for (let b = a; b < p; b++) {
      let k = 0, m = 0;
      for (const i of free) { k += Y[a][i] * MX[b][i]; m += Y[a][i] * M[i] * Y[b][i]; }
      Kp[a * p + b] = Kp[b * p + a] = k; Mp[a * p + b] = Mp[b * p + a] = m;
    }
    const pairs = smallEigen(Kp, Mp, p);
    const prev = lambda;
    lambda = pairs.map(e => e.value);
    X = pairs.map(({ q }) => { const x = new Float64Array(n); for (let c = 0; c < p; c++) { const qc = q[c], y = Y[c]; for (const i of free) x[i] += qc * y[i]; } return x; });
    // the warm starts follow the rotation: Y_new ~ X_new / lambda
    Y = X.map(() => true);
    if (prev && lambda.slice(0, count).every((l, i) => Math.abs(l / prev[i] - 1) < 2e-3)) break;
  }
  P.force.fill(0);
  return lambda.slice(0, count).map((l, v) => {
    let big = 0;
    for (const i of free) big = Math.max(big, Math.abs(X[v][i]));
    return { hz: Math.sqrt(Math.max(l, 0)) / (2 * Math.PI), shape: Float32Array.from(X[v], x => x / (big || 1)) };
  });
}
