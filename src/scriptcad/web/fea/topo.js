// Voxel topology optimisation: remove the material that does no work, keep what carries load.
//
// BESO (bi-directional evolutionary structural optimisation, Huang & Xie 2007/2010), hard-kill:
// every iteration solves the current voxel design on the GPU, scores each voxel by the strain
// energy it stores (how hard it works), smooths the scores over a few voxels (mesh-independent,
// no checkerboards), averages with the previous iteration (stability), and keeps the
// best-scoring voxels so the solid share drops by `er` per step until it reaches the target.
// Voids next to busy material score high through the smoothing, so material can come back.
// Only voxels of the original body can be solid (same envelope), and voxels at supports and
// loads always stay. Pieces that lose their connection to a support are removed.
//
// Everything here works on a parsed problem blob (fea/solver.js parse): emod and fixed are
// views into the blob, so changing them changes the problem the next solve sees.

/** Element energies u_e^T (E_e KE) u_e for every voxel (0 for void). */
export function strainEnergy(P, u) {
  const { nx, ny, nz, ke, emod } = P;
  const out = new Float32Array(nx * ny * nz);
  const ue = new Float64Array(24);
  const nxn = nx + 1, nxyn = (nx + 1) * (ny + 1);
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    const E = emod[e];
    if (!E) continue;
    for (let a = 0; a < 8; a++) {
      const n = (i + (a & 1)) + nxn * (j + ((a >> 1) & 1)) + nxyn * (k + ((a >> 2) & 1));
      ue[3 * a] = u[3 * n]; ue[3 * a + 1] = u[3 * n + 1]; ue[3 * a + 2] = u[3 * n + 2];
    }
    let s = 0;
    for (let r = 0; r < 24; r++) {
      let t = 0;
      const row = 24 * r;
      for (let c = 0; c < 24; c++) t += ke[row + c] * ue[c];
      s += ue[r] * t;
    }
    out[e] = E * s;
  }
  return out;
}

/** 1-D tent filter (weights rmin - |d|) along one axis of a voxel field, in place into `out`. */
function tent(P, src, out, axis, rmin) {
  const { nx, ny, nz } = P;
  const r = Math.ceil(rmin) - 1, stride = [1, nx, nx * ny][axis], len = [nx, ny, nz][axis];
  const w = Array.from({ length: 2 * r + 1 }, (_, t) => rmin - Math.abs(t - r));
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    const p = [i, j, k][axis];
    let s = 0;
    for (let t = -r; t <= r; t++) if (p + t >= 0 && p + t < len) s += w[t + r] * src[e + t * stride];
    out[e] = s;
  }
}

/**
 * Average of `alpha` over the design domain with a separable tent kernel of radius rmin
 * voxels (voids count as 0): filter(alpha * design) / filter(design). Three 1-D passes, so a
 * large radius (thick members) costs little.
 */
export function smooth(P, alpha, design, rmin) {
  const n = alpha.length;
  let a = new Float32Array(n), m = new Float32Array(n), t = new Float32Array(n);
  for (let e = 0; e < n; e++) if (design[e]) { a[e] = alpha[e]; m[e] = 1; }
  for (let axis = 0; axis < 3; axis++) {
    tent(P, a, t, axis, rmin); [a, t] = [t, a];
    tent(P, m, t, axis, rmin); [m, t] = [t, m];
  }
  for (let e = 0; e < n; e++) a[e] = design[e] && m[e] ? a[e] / m[e] : 0;
  return a;
}

const corner = (P, i, j, k, a) => (i + (a & 1)) + (P.nx + 1) * ((j + ((a >> 1) & 1)) + (P.ny + 1) * (k + ((a >> 2) & 1)));

/** Solid voxels face-connected to a held node; everything else is cut loose. Returns count removed. */
export function removeIslands(P, held) {
  const { nx, ny, nz, emod } = P;
  const nv = nx * ny * nz, seen = new Uint8Array(nv), stack = new Int32Array(nv);
  let top = 0;
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    if (!emod[e]) continue;
    for (let a = 0; a < 8; a++) if (held[corner(P, i, j, k, a)]) { seen[e] = 1; stack[top++] = e; break; }
  }
  while (top) {
    const e = stack[--top];
    const i = e % nx, j = ((e / nx) | 0) % ny, k = (e / (nx * ny)) | 0;
    const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1,
                k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
    for (const f of nb) if (f >= 0 && emod[f] && !seen[f]) { seen[f] = 1; stack[top++] = f; }
  }
  let removed = 0;
  for (let e = 0; e < nv; e++) if (emod[e] && !seen[e]) { emod[e] = 0; removed++; }
  return removed;
}

/** Hold the DOFs of nodes no solid voxel touches, release them when material returns. */
export function syncFixed(P, fixed0) {
  const { nx, ny, nz, emod, fixed } = P;
  const act = new Uint8Array((nx + 1) * (ny + 1) * (nz + 1));
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++)
    if (emod[e]) for (let a = 0; a < 8; a++) act[corner(P, i, j, k, a)] = 1;
  for (let n = 0; n < act.length; n++) for (let c = 0; c < 3; c++) fixed[3 * n + c] = act[n] ? fixed0[3 * n + c] : 1;
  return act;
}

/**
 * Setup for a parsed blob: the design domain (the original solid), the voxels that must stay
 * (touching a support or a loaded node, plus `keepLayers` around them) and the held nodes.
 */
export function prepare(P, { keepLayers = 1 } = {}) {
  const { nx, ny, nz, emod, fixed, force } = P;
  const nv = nx * ny * nz;
  const design = new Uint8Array(nv), keep = new Uint8Array(nv);
  const E0 = new Float32Array(emod);
  const fixed0 = new Uint32Array(fixed);
  const act = syncFixed(P, fixed0);          // the blob's own rule, so a no-op here
  const held = new Uint8Array(act.length);
  for (let n = 0; n < act.length; n++) if (act[n] && (fixed0[3 * n] || fixed0[3 * n + 1] || fixed0[3 * n + 2])) held[n] = 1;
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    if (!emod[e]) continue;
    design[e] = 1;
    for (let a = 0; a < 8; a++) {
      const n = corner(P, i, j, k, a);
      if (held[n] || force[3 * n] || force[3 * n + 1] || force[3 * n + 2]) { keep[e] = 1; break; }
    }
  }
  for (let layer = 0; layer < keepLayers; layer++) {
    const grow = keep.slice();
    for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
      if (!keep[e]) continue;
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const a = i + di, b = j + dj, c = k + dk;
        if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
        const f = a + nx * (b + ny * c);
        if (design[f]) grow[f] = 1;
      }
    }
    keep.set(grow);
  }
  let nDesign = 0, nKeep = 0;
  for (let e = 0; e < nv; e++) { nDesign += design[e]; nKeep += keep[e]; }
  return { design, keep, E0, fixed0, held, nDesign, nKeep };
}

/**
 * Keep the `count` best voxels: every keep voxel, then the design voxels with the highest
 * score. Writes emod (E0 or 0). Returns [added, removed] against the previous design.
 */
export function select(P, S, score, count) {
  const { emod } = P;
  const idx = [];
  for (let e = 0; e < emod.length; e++) if (S.design[e] && !S.keep[e]) idx.push(e);
  idx.sort((a, b) => score[b] - score[a]);
  const n = Math.max(0, count - S.nKeep);
  let added = 0, removed = 0;
  for (let r = 0; r < idx.length; r++) {
    const e = idx[r], on = r < n;
    if (on && !emod[e]) added++;
    if (!on && emod[e]) removed++;
    emod[e] = on ? S.E0[e] : 0;
  }
  for (let e = 0; e < emod.length; e++) if (S.keep[e]) emod[e] = S.E0[e];
  return [added, removed];
}

/** Compliance f.u and the largest nodal displacement over the solid. */
export function response(P, u) {
  let c = 0, dmax = 0;
  for (let n = 0; n < P.nn; n++) {
    if (P.fixed[3 * n] && P.fixed[3 * n + 1] && P.fixed[3 * n + 2]) continue;
    for (let k = 0; k < 3; k++) if (!P.fixed[3 * n + k]) c += P.force[3 * n + k] * u[3 * n + k];
    dmax = Math.max(dmax, Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]));
  }
  return { compliance: c, dmax };
}

/**
 * Outer faces of the solid voxels as flat-shaded triangles in world coordinates, with the
 * voxel each face belongs to (for colouring).
 */
export function surface(P) {
  const { nx, ny, nz, emod, h, origin } = P;
  const solid = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && emod[i + nx * (j + ny * k)] > 0;
  // per direction: neighbour offset, normal, and the 4 corners of that face (unit cube, CCW from outside)
  const F = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]], [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]], [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]], [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  let nf = 0;
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    if (!emod[e]) continue;
    for (const [[di, dj, dk]] of F) if (!solid(i + di, j + dj, k + dk)) nf++;
  }
  const pos = new Float32Array(nf * 18), nrm = new Float32Array(nf * 18), vox = new Int32Array(nf * 2);
  let f = 0;
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    if (!emod[e]) continue;
    for (const [d, q] of F) {
      if (solid(i + d[0], j + d[1], k + d[2])) continue;
      [0, 1, 2, 0, 2, 3].forEach((c, v) => {
        const o = 18 * f + 3 * v;
        pos[o] = origin[0] + h * (i + q[c][0]); pos[o + 1] = origin[1] + h * (j + q[c][1]); pos[o + 2] = origin[2] + h * (k + q[c][2]);
        nrm[o] = d[0]; nrm[o + 1] = d[1]; nrm[o + 2] = d[2];
      });
      vox[2 * f] = vox[2 * f + 1] = e;
      f++;
    }
  }
  return { positions: pos, normals: nrm, triVoxel: vox };
}

/**
 * The voxel surface as a smooth, welded mesh: faces share the grid corners they meet at, then
 * Taubin smoothing (alternating shrink and inflate steps, so the volume holds) rounds off the
 * stair steps. A vertex on a face of the original body (`design`, the envelope) only slides
 * within that face's plane, so flat faces of the envelope stay flat and its edges sharp. Each vertex also gets the mean of `value` over the
 * solid voxels around it (for colouring). Returns { positions, normals, index, vertexValue }.
 */
export function smoothSurface(P, value, design, { iters = 10, lambda = 0.5, mu = -0.53 } = {}) {
  const { nx, ny, nz, emod, h, origin } = P;
  const solid = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && emod[i + nx * (j + ny * k)] > 0;
  const F = [
    [[1, 0, 0], [1, 3, 7, 5]], [[-1, 0, 0], [0, 4, 6, 2]], [[0, 1, 0], [2, 6, 7, 3]],
    [[0, -1, 0], [0, 1, 5, 4]], [[0, 0, 1], [4, 5, 7, 6]], [[0, 0, -1], [0, 2, 3, 1]],
  ];   // corner a = (a&1, a>>1&1, a>>2&1), counter-clockwise seen from outside
  const vid = new Int32Array((nx + 1) * (ny + 1) * (nz + 1)).fill(-1);
  const nodes = [], quads = [], quadVox = [], quadPin = [];   // quadPin: axis held, or -1
  for (let k = 0, e = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, e++) {
    if (!emod[e]) continue;
    for (const [d, q] of F) {
      if (solid(i + d[0], j + d[1], k + d[2])) continue;
      for (const a of q) {
        const n = corner(P, i, j, k, a);
        if (vid[n] < 0) { vid[n] = nodes.length; nodes.push(n); }
        quads.push(vid[n]);
      }
      quadVox.push(e);
      const a = i + d[0], b = j + d[1], c = k + d[2];
      const outside = a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz || !design[a + nx * (b + ny * c)];
      quadPin.push(outside ? (d[0] ? 0 : d[1] ? 1 : 2) : -1);
    }
  }
  const nv = nodes.length, nq = quadVox.length;
  const pos = new Float32Array(3 * nv), free = new Uint8Array(3 * nv), val = new Float32Array(nv), cnt = new Float32Array(nv);
  const NX = nx + 1, NY = ny + 1;
  nodes.forEach((n, v) => {
    const I = n % NX, J = ((n / NX) | 0) % NY, K = (n / (NX * NY)) | 0;
    [I, J, K].forEach((c, a) => { pos[3 * v + a] = origin[a] + h * c; free[3 * v + a] = 1; });
  });
  for (let q = 0; q < nq; q++) if (quadPin[q] >= 0) for (let c = 0; c < 4; c++) free[3 * quads[4 * q + c] + quadPin[q]] = 0;
  for (let q = 0; q < nq; q++) for (let c = 0; c < 4; c++) { val[quads[4 * q + c]] += value[quadVox[q]]; cnt[quads[4 * q + c]]++; }
  for (let v = 0; v < nv; v++) val[v] /= cnt[v] || 1;
  // umbrella Laplacian over the quad edges (each edge seen from both of its quads: uniform weight)
  const sum = new Float32Array(3 * nv), deg = new Float32Array(nv);
  const relax = f => {
    sum.fill(0); deg.fill(0);
    for (let q = 0; q < nq; q++) for (let c = 0; c < 4; c++) {
      const a = quads[4 * q + c], b = quads[4 * q + ((c + 1) & 3)];
      for (let x = 0; x < 3; x++) { sum[3 * a + x] += pos[3 * b + x]; sum[3 * b + x] += pos[3 * a + x]; }
      deg[a]++; deg[b]++;
    }
    for (let v = 0; v < nv; v++) for (let x = 0; x < 3; x++)
      if (free[3 * v + x]) pos[3 * v + x] += f * (sum[3 * v + x] / deg[v] - pos[3 * v + x]);
  };
  for (let it = 0; it < iters; it++) { relax(lambda); relax(mu); }
  const index = new Uint32Array(6 * nq);
  for (let q = 0; q < nq; q++) {
    const [a, b, c, d] = quads.slice(4 * q, 4 * q + 4);
    index.set([a, b, c, a, c, d], 6 * q);
  }
  const normals = new Float32Array(3 * nv);
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    const u = [0, 1, 2].map(x => pos[3 * b + x] - pos[3 * a + x]), w = [0, 1, 2].map(x => pos[3 * c + x] - pos[3 * a + x]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const v of [a, b, c]) for (let x = 0; x < 3; x++) normals[3 * v + x] += n[x];
  }
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]) || 1;
    for (let x = 0; x < 3; x++) normals[3 * v + x] /= l;
  }
  return { positions: pos, normals, index, vertexValue: val };
}

/** Triangle soup (9 floats per triangle) of an indexed mesh, for stl(). */
export function unindex(positions, index) {
  const out = new Float32Array(3 * index.length);
  for (let t = 0; t < index.length; t++) out.set(positions.subarray(3 * index[t], 3 * index[t] + 3), 3 * t);
  return out;
}

/** Binary STL of a triangle soup (positions as from surface()). */
export function stl(positions, name = 'scriptcad') {
  const nt = positions.length / 9;
  const buf = new ArrayBuffer(84 + 50 * nt), dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode(name.slice(0, 80)));
  dv.setUint32(80, nt, true);
  for (let t = 0; t < nt; t++) {
    const o = 84 + 50 * t, p = 9 * t;
    const ax = positions[p + 3] - positions[p], ay = positions[p + 4] - positions[p + 1], az = positions[p + 5] - positions[p + 2];
    const bx = positions[p + 6] - positions[p], by = positions[p + 7] - positions[p + 1], bz = positions[p + 8] - positions[p + 2];
    const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx], l = Math.hypot(...n) || 1;
    for (let c = 0; c < 3; c++) dv.setFloat32(o + 4 * c, n[c] / l, true);
    for (let v = 0; v < 9; v++) dv.setFloat32(o + 12 + 4 * v, positions[p + v], true);
  }
  return buf;
}

/**
 * Run the optimisation. solve(blob) -> { u } solves the current design (GPU); onStep gets
 * { iter, fraction, compliance, dmax, energy, done } after every solve. alive() false stops early.
 * target: solid share of the original volume to end at; er: share removed per step;
 * rmin: smoothing radius in voxels (about the thinnest member); maxDefl (mm, optional): stop
 * at the lightest design whose largest displacement stays within it.
 */
export async function optimize(blob, P, solve, { target = 0.5, er = 0.03, rmin = 2.5, maxDefl = null, maxIter = 80,
                                                 onStep, alive = () => true } = {}) {
  const S = prepare(P);
  // supports and loads always keep their material: never aim below that (plus a little to carve)
  const minShare = S.nKeep / S.nDesign, asked = target;
  target = Math.max(target, Math.min(1, minShare + 0.02));
  const hist = [];
  let prev = null, frac = 1, best = null, stop = 'step limit';
  for (let iter = 0; iter < maxIter && alive(); iter++) {
    const { u } = await solve(blob);
    if (!alive()) break;
    const r = response(P, u);
    let solid = 0;
    for (let e = 0; e < P.emod.length; e++) solid += P.emod[e] > 0;
    frac = solid / S.nDesign;
    hist.push(r.compliance);
    const energy = strainEnergy(P, u);
    const over = maxDefl != null && r.dmax > maxDefl;
    if (over && !best) throw new Error(`the full body already deflects ${(r.dmax * 1000).toPrecision(3)} µm, more than the limit`);
    // converged: at the target and compliance steady over the last 10 solves (< 0.5% change)
    const k = hist.length;
    const settled = Math.abs(frac - target) < 0.005 && k >= 10 &&
      Math.abs(hist.slice(k - 5).reduce((a, b) => a + b) - hist.slice(k - 10, k - 5).reduce((a, b) => a + b)) /
        hist.slice(k - 5).reduce((a, b) => a + b) < 0.005;
    const step = { iter, fraction: frac, compliance: r.compliance, dmax: r.dmax, energy, done: settled || over, over };
    await onStep?.(step);
    if (over) { stop = 'deflection limit'; break; }       // keep the last design within the limit
    best = { emod: new Float32Array(P.emod), ...step };
    if (settled) { stop = 'target reached'; break; }
    // score = strain energy density (all voxels have the same volume), smoothed, averaged with the last
    let score = smooth(P, energy, S.design, rmin);
    if (prev) for (let e = 0; e < score.length; e++) score[e] = 0.5 * (score[e] + prev[e]);
    prev = score;
    const next = Math.max(target, frac * (1 - er));
    select(P, S, score, Math.round(next * S.nDesign));
    removeIslands(P, S.held);
    syncFixed(P, S.fixed0);
  }
  if (best) { P.emod.set(best.emod); syncFixed(P, S.fixed0); }
  return { ...best, stop, target, raised: target > asked, minShare, design: S.design, original: S.nDesign, history: hist };
}
