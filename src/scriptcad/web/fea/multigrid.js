// Browser voxel FEA: geometric-multigrid-preconditioned flexible CG (MG-PCG) in WebGPU.
//
// Step for step the algorithm of scriptcad/fea/multigrid.py (NVIDIA Warp); see that file
// for the reasoning. In short:
//   hierarchy   2x coarsening, coarse E = volume average of the 8 children (or majority vote),
//               KE rescaled by the coarse h, coarse DOF held if a held fine DOF lies in its
//               stencil; stop at <= coarseDofs free DOF or when connectivity would be lost
//   transfer    trilinear prolongation (zero on held fine DOFs), restriction = its transpose
//   smoother    nu Chebyshev (or damped Jacobi) steps d = c1 d + c2 D^-1 r, x += d, r -= K d,
//               spectral bound lambda_max(diag(KE)^-1 KE)
//   coarsest    coarseIters Jacobi-PCG iterations, no readback
//   outer       flexible CG (beta = z.(r - r_old) / rz_old), translation-relative K p everywhere
// Every outer iteration is one fixed list of dispatches, recorded once and re-encoded.

import { parse } from './solver.js';

const WG = 64;          // node-parallel kernels
const RW = 256;         // reductions and DOF-parallel kernels
const CHUNK = 8;

// one uniform layout for every kernel (u32 x 16); c1, c2 are f32 bit patterns
const SHADER = /* wgsl */ `
struct Lv { nx: u32, ny: u32, nz: u32, nn: u32, ndof: u32, gx: u32, nparts: u32, slot: u32,
            sub: u32, nxc: u32, nyc: u32, assign: u32, c1: u32, c2: u32, p0: u32, p1: u32 };
@group(0) @binding(0) var<uniform> L: Lv;

fn node_id(gid: vec3u) -> u32 { return gid.x + gid.y * L.gx * ${WG}u; }
fn dof_id(gid: vec3u) -> u32 { return gid.x + gid.y * L.gx * ${RW}u; }

// ---- out = K p (sub = 0) or out - K p (sub = 1), translation-relative -------------
@group(1) @binding(0) var<storage, read> ke: array<f32>;
@group(1) @binding(1) var<storage, read> emod: array<f32>;
@group(1) @binding(2) var<storage, read> fixed: array<u32>;
@group(1) @binding(3) var<storage, read> pin: array<f32>;
@group(1) @binding(4) var<storage, read_write> kout: array<f32>;
var<workgroup> kes: array<f32, 576>;

@compute @workgroup_size(${WG})
fn apply(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  for (var t = li; t < 576u; t += ${WG}u) { kes[t] = ke[t]; }
  workgroupBarrier();
  let n = node_id(gid);
  if (n >= L.nn) { return; }
  let nnx = L.nx + 1u;
  let nny = L.ny + 1u;
  let I = i32(n % nnx);
  let J = i32((n / nnx) % nny);
  let K = i32(n / (nnx * nny));
  var acc = vec3f(0.0);
  for (var a = 0u; a < 8u; a++) {
    let ei = I - i32(a & 1u);
    let ej = J - i32((a >> 1u) & 1u);
    let ek = K - i32((a >> 2u) & 1u);
    if (ei < 0 || ej < 0 || ek < 0 || ei >= i32(L.nx) || ej >= i32(L.ny) || ek >= i32(L.nz)) { continue; }
    let e = emod[u32(ei) + L.nx * (u32(ej) + L.ny * u32(ek))];
    if (e == 0.0) { continue; }
    let m0 = u32(ei) + nnx * (u32(ej) + nny * u32(ek));
    let p0 = vec3f(pin[3u * m0], pin[3u * m0 + 1u], pin[3u * m0 + 2u]);
    var s = vec3f(0.0);
    for (var b = 0u; b < 8u; b++) {
      let m = (u32(ei) + (b & 1u)) + nnx * ((u32(ej) + ((b >> 1u) & 1u)) + nny * (u32(ek) + ((b >> 2u) & 1u)));
      let pv = vec3f(pin[3u * m], pin[3u * m + 1u], pin[3u * m + 2u]) - p0;
      let r0 = (3u * a) * 24u + 3u * b;
      s += vec3f(dot(vec3f(kes[r0], kes[r0 + 1u], kes[r0 + 2u]), pv),
                 dot(vec3f(kes[r0 + 24u], kes[r0 + 25u], kes[r0 + 26u]), pv),
                 dot(vec3f(kes[r0 + 48u], kes[r0 + 49u], kes[r0 + 50u]), pv));
    }
    acc += e * s;
  }
  var v = acc;
  if (L.sub != 0u) { v = vec3f(kout[3u * n], kout[3u * n + 1u], kout[3u * n + 2u]) - acc; }
  kout[3u * n]      = select(v.x, 0.0, fixed[3u * n] != 0u);
  kout[3u * n + 1u] = select(v.y, 0.0, fixed[3u * n + 1u] != 0u);
  kout[3u * n + 2u] = select(v.z, 0.0, fixed[3u * n + 2u] != 0u);
}

// ---- smoother: d = c1 d + c2 D^-1 r; x = d or x += d -------------------------------
@group(1) @binding(0) var<storage, read_write> sm_d: array<f32>;
@group(1) @binding(1) var<storage, read_write> sm_x: array<f32>;
@group(1) @binding(2) var<storage, read> sm_r: array<f32>;
@group(1) @binding(3) var<storage, read> sm_dinv: array<f32>;
@group(1) @binding(4) var<storage, read_write> sm_rw: array<f32>;

@compute @workgroup_size(${RW})
fn smoothk(@builtin(global_invocation_id) gid: vec3u) {
  let i = dof_id(gid);
  if (i >= L.ndof) { return; }
  let c1 = bitcast<f32>(L.c1);
  var di = bitcast<f32>(L.c2) * sm_dinv[i] * sm_rw[i];
  if (c1 != 0.0) { di += c1 * sm_d[i]; }
  sm_d[i] = di;
  sm_x[i] = select(sm_x[i] + di, di, L.assign != 0u);
}

// first pre-smoothing step from x = 0: d = c2 D^-1 b; x = d; r = b (then r -= K d)
@compute @workgroup_size(${RW})
fn smooth0(@builtin(global_invocation_id) gid: vec3u) {
  let i = dof_id(gid);
  if (i >= L.ndof) { return; }
  let bi = sm_r[i];
  let di = bitcast<f32>(L.c2) * sm_dinv[i] * bi;
  sm_d[i] = di;
  sm_x[i] = di;
  sm_rw[i] = bi;
}

// ---- restriction (P^T): coarse node gathers its 3x3x3 fine stencil -----------------
@group(1) @binding(0) var<storage, read> rs_f: array<f32>;
@group(1) @binding(1) var<storage, read_write> rs_c: array<f32>;
@group(1) @binding(2) var<storage, read> rs_fixed: array<u32>;

@compute @workgroup_size(${WG})
fn restrict_r(@builtin(global_invocation_id) gid: vec3u) {
  let N = node_id(gid);
  if (N >= L.nn) { return; }
  let I = i32(N % (L.nxc + 1u));
  let J = i32((N / (L.nxc + 1u)) % (L.nyc + 1u));
  let K = i32(N / ((L.nxc + 1u) * (L.nyc + 1u)));
  var s = vec3f(0.0);
  for (var dk = 0; dk < 3; dk++) {
    let k = 2 * K + dk - 1;
    if (k < 0 || k > i32(L.nz)) { continue; }
    let wk = select(0.5, 1.0, dk == 1);
    for (var dj = 0; dj < 3; dj++) {
      let j = 2 * J + dj - 1;
      if (j < 0 || j > i32(L.ny)) { continue; }
      let wj = select(0.5 * wk, wk, dj == 1);
      for (var di = 0; di < 3; di++) {
        let i = 2 * I + di - 1;
        if (i < 0 || i > i32(L.nx)) { continue; }
        let w = select(0.5 * wj, wj, di == 1);
        let m = u32(i) + (L.nx + 1u) * (u32(j) + (L.ny + 1u) * u32(k));
        s += w * vec3f(rs_f[3u * m], rs_f[3u * m + 1u], rs_f[3u * m + 2u]);
      }
    }
  }
  rs_c[3u * N]      = select(s.x, 0.0, rs_fixed[3u * N] != 0u);
  rs_c[3u * N + 1u] = select(s.y, 0.0, rs_fixed[3u * N + 1u] != 0u);
  rs_c[3u * N + 2u] = select(s.z, 0.0, rs_fixed[3u * N + 2u] != 0u);
}

// ---- prolongation: e = P xc (zero on held fine DOFs); x += e ------------------------
@group(1) @binding(0) var<storage, read> pr_c: array<f32>;
@group(1) @binding(1) var<storage, read_write> pr_e: array<f32>;
@group(1) @binding(2) var<storage, read_write> pr_x: array<f32>;
@group(1) @binding(3) var<storage, read> pr_fixed: array<u32>;

@compute @workgroup_size(${WG})
fn prolong(@builtin(global_invocation_id) gid: vec3u) {
  let n = node_id(gid);
  if (n >= L.nn) { return; }
  let I = n % (L.nx + 1u);
  let J = (n / (L.nx + 1u)) % (L.ny + 1u);
  let K = n / ((L.nx + 1u) * (L.ny + 1u));
  let odd = vec3u(I & 1u, J & 1u, K & 1u);
  let w = select(1.0, 0.5, odd.x == 1u) * select(1.0, 0.5, odd.y == 1u) * select(1.0, 0.5, odd.z == 1u);
  var s = vec3f(0.0);
  for (var c = 0u; c < 8u; c++) {
    let o = vec3u(c & 1u, (c >> 1u) & 1u, (c >> 2u) & 1u);
    // an even fine index sits on a coarse node: weight 1, no second neighbour
    if ((o.x == 1u && odd.x == 0u) || (o.y == 1u && odd.y == 0u) || (o.z == 1u && odd.z == 0u)) { continue; }
    let m = (I / 2u + o.x) + (L.nxc + 1u) * ((J / 2u + o.y) + (L.nyc + 1u) * (K / 2u + o.z));
    s += w * vec3f(pr_c[3u * m], pr_c[3u * m + 1u], pr_c[3u * m + 2u]);
  }
  let e = vec3f(select(s.x, 0.0, pr_fixed[3u * n] != 0u), select(s.y, 0.0, pr_fixed[3u * n + 1u] != 0u),
                select(s.z, 0.0, pr_fixed[3u * n + 2u] != 0u));
  pr_e[3u * n] = e.x; pr_e[3u * n + 1u] = e.y; pr_e[3u * n + 2u] = e.z;
  pr_x[3u * n] += e.x; pr_x[3u * n + 1u] += e.y; pr_x[3u * n + 2u] += e.z;
}

// ---- dot products (two passes; pass 2 overwrites sc[slot]) ---------------------------
@group(1) @binding(0) var<storage, read> da: array<f32>;
@group(1) @binding(1) var<storage, read> db: array<f32>;
@group(1) @binding(2) var<storage, read_write> parts: array<f32>;
@group(1) @binding(3) var<storage, read_write> dsc: array<f32>;
var<workgroup> red: array<f32, ${RW}>;

@compute @workgroup_size(${RW})
fn dot1(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let w = wid.x + wid.y * L.gx;
  let base = w * ${RW * CHUNK}u;
  var s = 0.0;
  for (var k = 0u; k < ${CHUNK}u; k++) {
    let i = base + k * ${RW}u + li;
    if (i < L.ndof) { s += da[i] * db[i]; }
  }
  red[li] = s;
  workgroupBarrier();
  for (var o = ${RW / 2}u; o > 0u; o >>= 1u) {
    if (li < o) { red[li] += red[li + o]; }
    workgroupBarrier();
  }
  if (li == 0u) { parts[w] = red[0]; }
}

@compute @workgroup_size(${RW})
fn dot2(@builtin(local_invocation_index) li: u32) {
  var s = 0.0;
  for (var i = li; i < L.nparts; i += ${RW}u) { s += parts[i]; }
  red[li] = s;
  workgroupBarrier();
  for (var o = ${RW / 2}u; o > 0u; o >>= 1u) {
    if (li < o) { red[li] += red[li + o]; }
    workgroupBarrier();
  }
  if (li == 0u) { dsc[L.slot] = red[0]; }
}

// ---- coarsest level: Jacobi-PCG (sc: rz, pAp, rz_new) --------------------------------
@group(1) @binding(0) var<storage, read> cg_b: array<f32>;
@group(1) @binding(1) var<storage, read_write> cg_x: array<f32>;
@group(1) @binding(2) var<storage, read_write> cg_r: array<f32>;
@group(1) @binding(3) var<storage, read_write> cg_z: array<f32>;
@group(1) @binding(4) var<storage, read_write> cg_p: array<f32>;
@group(1) @binding(5) var<storage, read> cg_dinv: array<f32>;
@group(1) @binding(6) var<storage, read> cg_ap: array<f32>;
@group(1) @binding(7) var<storage, read_write> cg_sc: array<f32>;

@compute @workgroup_size(${RW})
fn cg_init(@builtin(global_invocation_id) gid: vec3u) {
  let i = dof_id(gid);
  if (i >= L.ndof) { return; }
  let bi = cg_b[i];
  cg_x[i] = 0.0;
  cg_r[i] = bi;
  let zi = cg_dinv[i] * bi;
  cg_z[i] = zi;
  cg_p[i] = zi;
}

@compute @workgroup_size(${RW})
fn cg_xr(@builtin(global_invocation_id) gid: vec3u) {
  let i = dof_id(gid);
  if (i >= L.ndof) { return; }
  let alpha = select(0.0, cg_sc[0] / cg_sc[1], cg_sc[1] > 0.0);
  cg_x[i] += alpha * cg_p[i];
  let ri = cg_r[i] - alpha * cg_ap[i];
  cg_r[i] = ri;
  cg_z[i] = cg_dinv[i] * ri;
}

@compute @workgroup_size(${RW})
fn cg_pupd(@builtin(global_invocation_id) gid: vec3u) {
  let i = dof_id(gid);
  if (i >= L.ndof) { return; }
  let beta = select(0.0, cg_sc[2] / cg_sc[0], cg_sc[0] > 0.0);
  cg_p[i] = cg_z[i] + beta * cg_p[i];
}

@compute @workgroup_size(1)
fn roll() { if (L.ndof > 0u) { cg_sc[0] = cg_sc[2]; } }

// ---- outer flexible CG (sc: rz, pAp, rz_new, rr, r_old.z) -----------------------------
@group(1) @binding(0) var<storage, read_write> f_u: array<f32>;
@group(1) @binding(1) var<storage, read_write> f_r: array<f32>;
@group(1) @binding(2) var<storage, read_write> f_rold: array<f32>;
@group(1) @binding(3) var<storage, read_write> f_p: array<f32>;
@group(1) @binding(4) var<storage, read> f_ap: array<f32>;
@group(1) @binding(5) var<storage, read> f_z: array<f32>;
@group(1) @binding(6) var<storage, read_write> f_sc: array<f32>;

@compute @workgroup_size(${RW})
fn fcg_ur(@builtin(global_invocation_id) gid: vec3u) {
  let i = dof_id(gid);
  if (i >= L.ndof) { return; }
  let alpha = select(0.0, f_sc[0] / f_sc[1], f_sc[1] > 0.0);
  f_u[i] += alpha * f_p[i];
  let ri = f_r[i];
  f_rold[i] = ri;
  f_r[i] = ri - alpha * f_ap[i];
}

@compute @workgroup_size(${RW})
fn fcg_p(@builtin(global_invocation_id) gid: vec3u) {
  let i = dof_id(gid);
  if (i >= L.ndof) { return; }
  let beta = select(0.0, (f_sc[2] - f_sc[4]) / f_sc[0], f_sc[0] > 0.0);
  f_p[i] = f_z[i] + beta * f_p[i];
}
`;

// --------------------------------------------------------------------------- hierarchy (host)

function activeNodes(P) {
  const { nx, ny, nz } = P;
  const act = new Uint8Array((nx + 1) * (ny + 1) * (nz + 1));
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!P.emod[i + nx * (j + ny * k)]) continue;
    for (let a = 0; a < 8; a++) act[(i + (a & 1)) + (nx + 1) * ((j + ((a >> 1) & 1)) + (ny + 1) * (k + ((a >> 2) & 1)))] = 1;
  }
  return act;
}

/** Next-coarser level: same rules as multigrid.coarsen in Python. */
export function coarsen(P, rule = 'average') {
  const { nx, ny, nz } = P;
  const cx = (nx + 1) >> 1, cy = (ny + 1) >> 1, cz = (nz + 1) >> 1;
  const emod = new Float32Array(cx * cy * cz);
  for (let K = 0; K < cz; K++) for (let J = 0; J < cy; J++) for (let I = 0; I < cx; I++) {
    let s = 0, n = 0;
    for (let c = 0; c < 8; c++) {
      const i = 2 * I + (c & 1), j = 2 * J + ((c >> 1) & 1), k = 2 * K + ((c >> 2) & 1);
      if (i >= nx || j >= ny || k >= nz) continue;
      const e = P.emod[i + nx * (j + ny * k)];
      if (e > 0) { s += e; n++; }
    }
    emod[I + cx * (J + cy * K)] = rule === 'majority' ? (n >= 4 ? s / n : 0) : s / 8;
  }
  const act = P.active ?? activeNodes(P);
  const C = { nx: cx, ny: cy, nz: cz, nn: (cx + 1) * (cy + 1) * (cz + 1), h: 2 * P.h, emod };
  C.ndof = 3 * C.nn;
  C.active = activeNodes(C);
  const fixed = new Uint32Array(C.ndof);
  const fnx = nx + 1, fny = ny + 1;
  for (let K = 0; K <= cz; K++) for (let J = 0; J <= cy; J++) for (let I = 0; I <= cx; I++) {
    const N = I + (cx + 1) * (J + (cy + 1) * K);
    if (!C.active[N]) { fixed[3 * N] = fixed[3 * N + 1] = fixed[3 * N + 2] = 1; continue; }
    for (let dk = -1; dk <= 1; dk++) {
      const k = 2 * K + dk;
      if (k < 0 || k > nz) continue;
      for (let dj = -1; dj <= 1; dj++) {
        const j = 2 * J + dj;
        if (j < 0 || j > ny) continue;
        for (let di = -1; di <= 1; di++) {
          const i = 2 * I + di;
          if (i < 0 || i > nx) continue;
          const m = i + fnx * (j + fny * k);
          if (!act[m]) continue;
          for (let c = 0; c < 3; c++) if (P.fixed[3 * m + c]) fixed[3 * N + c] = 1;
        }
      }
    }
  }
  C.fixed = fixed;
  return C;
}

/** [face-connected solid pieces, pieces touching no held DOF]. */
export function connectivity(P) {
  const { nx, ny, nz } = P;
  const nv = nx * ny * nz;
  const lab = new Int32Array(nv);
  const stack = new Int32Array(nv);
  const act = P.active ?? activeNodes(P);
  let pieces = 0, floating = 0;
  const held = n => act[n] && (P.fixed[3 * n] || P.fixed[3 * n + 1] || P.fixed[3 * n + 2]);
  for (let s = 0; s < nv; s++) {
    if (!P.emod[s] || lab[s]) continue;
    pieces++;
    let top = 0, anchored = false;
    stack[top++] = s; lab[s] = pieces;
    while (top) {
      const e = stack[--top];
      const i = e % nx, j = ((e / nx) | 0) % ny, k = (e / (nx * ny)) | 0;
      if (!anchored) for (let a = 0; a < 8; a++) {
        if (held((i + (a & 1)) + (nx + 1) * ((j + ((a >> 1) & 1)) + (ny + 1) * (k + ((a >> 2) & 1))))) { anchored = true; break; }
      }
      const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1,
                  k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
      for (const f of nb) if (f >= 0 && P.emod[f] && !lab[f]) { lab[f] = pieces; stack[top++] = f; }
    }
    if (!anchored) floating++;
  }
  return [pieces, floating];
}

function freeDofs(P) { let n = 0; for (let i = 0; i < P.ndof; i++) if (!P.fixed[i]) n++; return n; }

export function hierarchy(P, { rule = 'average', coarseDofs = 200, maxLevels = 12 } = {}) {
  P.active ??= activeNodes(P);
  const levels = [P];
  let [pieces, floating] = connectivity(P);
  const desc = [{ shape: [P.nx, P.ny, P.nz], h: P.h, free_dofs: freeDofs(P), pieces, floating }];
  let stop = 'max_levels';
  while (levels.length < maxLevels) {
    const p = levels[levels.length - 1];
    if (desc[desc.length - 1].free_dofs <= coarseDofs) { stop = 'small enough'; break; }
    if (Math.max(p.nx, p.ny, p.nz) < 2) { stop = 'single voxel'; break; }
    const c = coarsen(p, rule);
    const [pc, fc] = connectivity(c);
    if (pc > pieces || fc > floating) { stop = `connectivity lost at h=${c.h} (${pc} pieces, ${fc} floating)`; break; }
    levels.push(c);
    desc.push({ shape: [c.nx, c.ny, c.nz], h: c.h, free_dofs: freeDofs(c), pieces: pc, floating: fc });
  }
  return { levels, desc, stop };
}

/** lambda_max(diag(KE)^-1 KE) by power iteration on the symmetric scaling (24x24). */
export function spectralBound(ke) {
  const s = Array.from({ length: 24 }, (_, i) => 1 / Math.sqrt(ke[25 * i]));
  let v = Array.from({ length: 24 }, (_, i) => 1 + 0.1 * i), lam = 0;
  for (let it = 0; it < 5000; it++) {
    const w = new Array(24).fill(0);
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) w[i] += s[i] * ke[24 * i + j] * s[j] * v[j];
    const nrm = Math.hypot(...w);
    lam = w.reduce((a, x, i) => a + x * v[i], 0) / v.reduce((a, x) => a + x * x, 0);
    v = w.map(x => x / nrm);
  }
  return lam;
}

export function smootherCoefficients(lmax, nu = 2, smoother = 'chebyshev', ratio = 8, omega = null) {
  if (smoother === 'jacobi') return Array(nu).fill([0, (omega ?? 2 / (1 + 1 / ratio)) / lmax]);
  const lmin = lmax / ratio, theta = (lmax + lmin) / 2, delta = (lmax - lmin) / 2, sigma = theta / delta;
  let rho = 1 / sigma;
  const out = [[0, 1 / theta]];
  for (let s = 1; s < nu; s++) {
    const rn = 1 / (2 * sigma - rho);
    out.push([rn * rho, 2 * rn / delta]);
    rho = rn;
  }
  return out;
}

// --------------------------------------------------------------------------- solver

const PIPES = ['apply', 'smoothk', 'smooth0', 'restrict_r', 'prolong', 'dot1', 'dot2', 'cg_init', 'cg_xr', 'cg_pupd',
               'roll', 'fcg_ur', 'fcg_p'];

async function pipelines(device) {
  if (device.__mgPipes) return device.__mgPipes;
  const module = device.createShaderModule({ code: SHADER });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter(m => m.type === 'error');
  if (errs.length) throw new Error('WGSL (multigrid): ' + errs.map(m => `${m.lineNum}:${m.message}`).join('; '));
  const pipes = {};
  for (const e of PIPES) pipes[e] = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: e } });
  device.__mgPipes = pipes;
  return pipes;
}

/** MG-PCG solve of a problem blob on `solver.device` (a VoxelSolver). */
export async function solveMG(solver, blob, { tol = 1e-6, maxIter = 2000, checkEvery = 5, onProgress, rule = 'average',
                                             nu = 2, smoother = 'chebyshev', ratio = 8, omega = null, coarseDofs = 200,
                                             coarseIters = 100, maxLevels = 12 } = {}) {
  const d = solver.device;
  const pipes = await pipelines(d);
  const P = parse(blob);
  const t0 = performance.now();
  const { levels: lv, desc, stop } = hierarchy(P, { rule, coarseDofs, maxLevels });
  const lmax = spectralBound(P.ke);
  const coef = smootherCoefficients(lmax, nu, smoother, ratio, omega);
  const owned = [];
  const buf = (data, usage = GPUBufferUsage.STORAGE) => {
    const b = d.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    d.queue.writeBuffer(b, 0, data);
    owned.push(b);
    return b;
  };
  const grid = (count, wg) => { const g = Math.ceil(count / wg), gx = Math.min(g, 65535); return [gx, Math.ceil(g / gx)]; };
  const f32bits = x => new Uint32Array(new Float32Array([x]).buffer)[0];
  const uni = (Q, o = {}) => buf(new Uint32Array([Q.nx, Q.ny, Q.nz, o.nn ?? Q.nn, o.ndof ?? Q.ndof, o.gx ?? 0, o.nparts ?? 0, o.slot ?? 0,
                                                  o.sub ?? 0, o.nxc ?? 0, o.nyc ?? 0, o.assign ?? 0, f32bits(o.c1 ?? 0), f32bits(o.c2 ?? 0), 0, 0]),
                                 GPUBufferUsage.UNIFORM);
  const bg = (pipe, entries) => d.createBindGroup({
    layout: pipes[pipe].getBindGroupLayout(1),
    entries: Object.entries(entries).map(([i, b]) => ({ binding: +i, resource: { buffer: b } })),
  });
  const ug = (pipe, u) => d.createBindGroup({ layout: pipes[pipe].getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: u } }] });

  // per-level data: KE scaled by the level's h, Jacobi diagonal, work vectors
  const L = lv.map((Q, l) => {
    const scale = 2 ** l;
    const ke = P.ke.map(v => v * scale);
    const diag = new Float64Array(Q.ndof);
    for (let k = 0; k < Q.nz; k++) for (let j = 0; j < Q.ny; j++) for (let i = 0; i < Q.nx; i++) {
      const e = Q.emod[i + Q.nx * (j + Q.ny * k)];
      if (!e) continue;
      for (let a = 0; a < 8; a++) {
        const m = (i + (a & 1)) + (Q.nx + 1) * ((j + ((a >> 1) & 1)) + (Q.ny + 1) * (k + ((a >> 2) & 1)));
        for (let c = 0; c < 3; c++) diag[3 * m + c] += e * ke[(3 * a + c) * 25];
      }
    }
    const dinv = new Float32Array(Q.ndof);
    for (let i = 0; i < Q.ndof; i++) if (!Q.fixed[i] && diag[i] > 0) dinv[i] = 1 / diag[i];
    const z = () => buf(new Float32Array(Q.ndof));
    return { Q, ke: buf(ke), emod: buf(Q.emod), fixed: buf(Q.fixed), dinv: buf(dinv), dinvH: dinv,
             x: z(), r: z(), b: z(), d: z(), e: z(), nodeGrid: grid(Q.nn, WG), dofGrid: grid(Q.ndof, RW),
             dotGrid: grid(Math.ceil(Q.ndof / CHUNK), RW) };
  });
  const L0 = L[0];
  const f = new Float32Array(P.ndof);
  let fn = 0;
  for (let i = 0; i < P.ndof; i++) if (!P.fixed[i] && L0.dinvH[i] > 0) { f[i] = P.force[i]; fn += f[i] * f[i]; }
  fn = Math.sqrt(fn);
  const z0 = () => buf(new Float32Array(P.ndof));
  const O = { u: z0(), r: buf(f), rold: z0(), z: z0(), p: z0(), ap: z0(), sc: buf(new Float32Array(8)) };
  const scc = buf(new Float32Array(8));
  const parts = buf(new Float32Array(L0.dotGrid[0] * L0.dotGrid[1]));

  // ---- record dispatches ------------------------------------------------------------
  const op = (pipe, u, g1, wg) => ({ pipe, g0: ug(pipe, u), g1: bg(pipe, g1), x: wg[0], y: wg[1] });
  const applyOp = (A, p, out, sub) =>
    op('apply', uni(A.Q, { gx: A.nodeGrid[0], sub }), { 0: A.ke, 1: A.emod, 2: A.fixed, 3: p, 4: out }, A.nodeGrid);
  const dotOps = (A, a, b, slot, sc) => {
    const u = uni(A.Q, { gx: A.dotGrid[0], nparts: A.dotGrid[0] * A.dotGrid[1], slot });
    return [op('dot1', u, { 0: a, 1: b, 2: parts }, A.dotGrid), op('dot2', u, { 2: parts, 3: sc }, [1, 1])];
  };
  const elem = (A, pipe, g1, o = {}) => op(pipe, uni(A.Q, { gx: A.dofGrid[0], ...o }), g1, A.dofGrid);

  function coarseOps(A, b, x) {
    // x, r, z = d, p = e, ap = A.b (b is consumed by cg_init; one level: A.b is scratch)
    const ap = A.b;
    const ops = [elem(A, 'cg_init', { 0: b, 1: x, 2: A.r, 3: A.d, 4: A.e, 5: A.dinv }), ...dotOps(A, A.r, A.d, 0, scc)];
    const it = [applyOp(A, A.e, ap, 0), ...dotOps(A, A.e, ap, 1, scc),
                elem(A, 'cg_xr', { 1: x, 2: A.r, 3: A.d, 4: A.e, 5: A.dinv, 6: ap, 7: scc }),
                ...dotOps(A, A.r, A.d, 2, scc), elem(A, 'cg_pupd', { 3: A.d, 4: A.e, 7: scc }),
                op('roll', uni(A.Q), { 7: scc }, [1, 1])];
    for (let k = 0; k < coarseIters; k++) ops.push(...it);
    return ops;
  }

  function cycleOps(l, b, x) {
    const A = L[l];
    if (l === L.length - 1) return coarseOps(A, b, x);
    const C = L[l + 1];
    const ops = [];
    coef.forEach(([c1, c2], s) => {
      if (s === 0) ops.push(elem(A, 'smooth0', { 0: A.d, 1: x, 2: b, 3: A.dinv, 4: A.r }, { c2 }));
      else ops.push(elem(A, 'smoothk', { 0: A.d, 1: x, 3: A.dinv, 4: A.r }, { c1, c2 }));
      ops.push(applyOp(A, A.d, A.r, 1));
    });
    ops.push(op('restrict_r', uni(A.Q, { nn: C.Q.nn, gx: C.nodeGrid[0], nxc: C.Q.nx, nyc: C.Q.ny }),
                { 0: A.r, 1: C.b, 2: C.fixed }, C.nodeGrid));
    ops.push(...cycleOps(l + 1, C.b, C.x));
    ops.push(op('prolong', uni(A.Q, { gx: A.nodeGrid[0], nxc: C.Q.nx, nyc: C.Q.ny }),
                { 0: C.x, 1: A.e, 2: x, 3: A.fixed }, A.nodeGrid));
    ops.push(applyOp(A, A.e, A.r, 1));
    coef.forEach(([c1, c2], s) => {
      ops.push(elem(A, 'smoothk', { 0: A.d, 1: x, 3: A.dinv, 4: A.r }, { c1: s ? c1 : 0, c2 }));
      if (s < coef.length - 1) ops.push(applyOp(A, A.d, A.r, 1));
    });
    return ops;
  }

  // single-level hierarchy: the coarse CG needs its own ap, so give it one
  if (L.length === 1) L0.b = buf(new Float32Array(P.ndof));
  const vcycle = cycleOps(0, O.r, O.z);
  const fo = (pipe, g1) => elem(L0, pipe, g1);
  const iteration = [
    applyOp(L0, O.p, O.ap, 0), ...dotOps(L0, O.p, O.ap, 1, O.sc),
    fo('fcg_ur', { 0: O.u, 1: O.r, 2: O.rold, 3: O.p, 4: O.ap, 6: O.sc }),
    ...vcycle,
    ...dotOps(L0, O.r, O.z, 2, O.sc), ...dotOps(L0, O.rold, O.z, 4, O.sc),
    fo('fcg_p', { 3: O.p, 5: O.z, 6: O.sc }),
    op('roll', uni(L0.Q), { 7: O.sc }, [1, 1]),
  ];
  const rrOps = dotOps(L0, O.r, O.r, 3, O.sc);
  const encode = (pass, ops) => {
    for (const o of ops) {
      pass.setPipeline(pipes[o.pipe]);
      pass.setBindGroup(0, o.g0);
      pass.setBindGroup(1, o.g1);
      pass.dispatchWorkgroups(o.x, o.y);
    }
  };
  const read = d.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  owned.push(read);
  await d.queue.onSubmittedWorkDone();
  const tSetup = performance.now();

  // z = M f, p = z, rz
  let enc = d.createCommandEncoder();
  let pass = enc.beginComputePass();
  encode(pass, vcycle);
  pass.end();
  enc.copyBufferToBuffer(O.z, 0, O.p, 0, P.ndof * 4);
  pass = enc.beginComputePass();
  encode(pass, dotOps(L0, O.r, O.z, 0, O.sc));
  pass.end();
  d.queue.submit([enc.finish()]);

  let it = 0, rel = 1;
  const hist = [];
  while (it < maxIter) {
    enc = d.createCommandEncoder();
    pass = enc.beginComputePass();
    const steps = Math.min(checkEvery, maxIter - it);
    for (let s = 0; s < steps; s++) encode(pass, iteration);
    encode(pass, rrOps);
    pass.end();
    enc.copyBufferToBuffer(O.sc, 0, read, 0, 32);
    d.queue.submit([enc.finish()]);
    it += steps;
    await read.mapAsync(GPUMapMode.READ);
    const sc = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    rel = Math.sqrt(Math.max(sc[3], 0)) / fn;
    hist.push([it, rel]);
    onProgress?.(it, rel);
    if (!(rel >= tol)) break;
  }
  const tSolve = performance.now();
  const out = d.createBuffer({ size: P.ndof * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  enc = d.createCommandEncoder();
  enc.copyBufferToBuffer(O.u, 0, out, 0, P.ndof * 4);
  d.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const u = new Float32Array(out.getMappedRange().slice(0));
  out.unmap();
  for (const b of [...owned, out]) b.destroy();
  return {
    u, iterations: it, rel, history: hist, ndof: P.ndof, nsolid: P.nsolid, method: 'mg',
    levels: desc, stop, settings: { rule, nu, smoother, ratio, omega, coarse_dofs: coarseDofs, coarse_iters: coarseIters, lmax_bound: lmax },
    dispatchesPerIteration: iteration.length,
    setupMs: tSetup - t0, solveMs: tSolve - tSetup, msPerIteration: (tSolve - tSetup) / Math.max(it, 1),
  };
}
