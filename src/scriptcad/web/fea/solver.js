// Browser voxel FEA: matrix-free Jacobi-PCG in WebGPU (WGSL, float32, translation-relative K p).
//
// Same algorithm and data layout as scriptcad/fea/cuda.py (NVIDIA Warp) and
// scriptcad/fea/cpu.py, so the three can be compared value by value:
//   node n gathers K u from the up-to-8 voxels around it (no atomics, no matrix),
//   CG scalars stay on the GPU, the residual is read back every `checkEvery` steps.
// WGSL has no float atomics, so dot products are a two-pass workgroup reduction.

import { solveMG } from './multigrid.js';

const WG = 64;          // apply kernel workgroup size
const RW = 256;         // reduction / elementwise workgroup size
const CHUNK = 8;        // elements per thread in the first reduction pass

const SHADER = /* wgsl */ `
struct Grid { nx: u32, ny: u32, nz: u32, nn: u32, ndof: u32, gx: u32, nparts: u32, slot: u32 };
@group(0) @binding(0) var<uniform> G: Grid;

// ---- K p ---------------------------------------------------------------------
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
  let n = gid.x + gid.y * G.gx * ${WG}u;
  if (n >= G.nn) { return; }
  let nnx = G.nx + 1u;
  let nny = G.ny + 1u;
  let I = i32(n % nnx);
  let J = i32((n / nnx) % nny);
  let K = i32(n / (nnx * nny));
  var acc = vec3f(0.0);
  for (var a = 0u; a < 8u; a++) {
    let ei = I - i32(a & 1u);
    let ej = J - i32((a >> 1u) & 1u);
    let ek = K - i32((a >> 2u) & 1u);
    if (ei < 0 || ej < 0 || ek < 0 || ei >= i32(G.nx) || ej >= i32(G.ny) || ek >= i32(G.nz)) { continue; }
    let e = emod[u32(ei) + G.nx * (u32(ej) + G.ny * u32(ek))];
    if (e == 0.0) { continue; }
    // KE annihilates rigid translation, so K(p - p0) = K p exactly; in float32 the
    // differences cancel far less (thin walls: 21% -> 0.3% error, see bench/fea).
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
  kout[3u * n]      = select(acc.x, 0.0, fixed[3u * n] != 0u);
  kout[3u * n + 1u] = select(acc.y, 0.0, fixed[3u * n + 1u] != 0u);
  kout[3u * n + 2u] = select(acc.z, 0.0, fixed[3u * n + 2u] != 0u);
}

// ---- dot products: pass 1 per workgroup, pass 2 single workgroup ----------------
@group(1) @binding(0) var<storage, read> da: array<f32>;
@group(1) @binding(1) var<storage, read> db: array<f32>;
@group(1) @binding(2) var<storage, read_write> parts: array<f32>;
@group(1) @binding(3) var<storage, read_write> sc: array<f32>;
var<workgroup> red: array<f32, ${RW}>;

@compute @workgroup_size(${RW})
fn dot1(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let w = wid.x + wid.y * G.gx;
  let base = w * ${RW * CHUNK}u;
  var s = 0.0;
  for (var k = 0u; k < ${CHUNK}u; k++) {
    let i = base + k * ${RW}u + li;
    if (i < G.ndof) { s += da[i] * db[i]; }
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
  for (var i = li; i < G.nparts; i += ${RW}u) { s += parts[i]; }
  red[li] = s;
  workgroupBarrier();
  for (var o = ${RW / 2}u; o > 0u; o >>= 1u) {
    if (li < o) { red[li] += red[li + o]; }
    workgroupBarrier();
  }
  if (li == 0u) { sc[G.slot] = red[0]; }
}

// ---- CG vector updates -----------------------------------------------------------
@group(1) @binding(0) var<storage, read_write> u: array<f32>;
@group(1) @binding(1) var<storage, read_write> r: array<f32>;
@group(1) @binding(2) var<storage, read_write> p: array<f32>;
@group(1) @binding(3) var<storage, read> ap: array<f32>;
@group(1) @binding(4) var<storage, read> dinv: array<f32>;
@group(1) @binding(5) var<storage, read_write> z: array<f32>;
@group(1) @binding(6) var<storage, read_write> scu: array<f32>;

@compute @workgroup_size(${RW})
fn update_ur(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * G.gx * ${RW}u;
  if (i >= G.ndof) { return; }
  let alpha = scu[0] / scu[1];
  u[i] = u[i] + alpha * p[i];
  let ri = r[i] - alpha * ap[i];
  r[i] = ri;
  z[i] = dinv[i] * ri;
}

@compute @workgroup_size(${RW})
fn update_p(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * G.gx * ${RW}u;
  if (i >= G.ndof) { return; }
  let beta = scu[2] / scu[0];
  p[i] = z[i] + beta * p[i];
}

@compute @workgroup_size(1)
fn roll() { if (G.ndof > 0u) { scu[0] = scu[2]; } }
`;

export function parse(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'VXF1') throw new Error('not a voxel problem blob');
  const [nx, ny, nz, nn, nsolid] = [4, 8, 12, 16, 20].map(o => dv.getUint32(o, true));
  const h = dv.getFloat32(28, true);
  const origin = [32, 36, 40].map(o => dv.getFloat32(o, true));
  let o = 44;
  const take = (Ctor, n) => { const a = new Ctor(buf, o, n); o += n * 4; return a; };
  const ke = take(Float32Array, 576);
  const emod = take(Float32Array, nx * ny * nz);
  const fixed = take(Uint32Array, 3 * nn);
  const force = take(Float32Array, 3 * nn);
  return { nx, ny, nz, nn, nsolid, h, origin, ke, emod, fixed, force, ndof: 3 * nn };
}

export async function gpuInfo() {
  if (!navigator.gpu) return null;
  const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description } : null;
}

export class VoxelSolver {
  static async create() {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const want = ['maxStorageBufferBindingSize', 'maxBufferSize'];
    const requiredLimits = Object.fromEntries(want.map(k => [k, adapter.limits[k]]));
    const device = await adapter.requestDevice({ requiredLimits });
    const s = new VoxelSolver();
    s.adapter = adapter;
    s.device = device;
    const module = device.createShaderModule({ code: SHADER });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter(m => m.type === 'error');
    if (errs.length) throw new Error('WGSL: ' + errs.map(m => `${m.lineNum}:${m.message}`).join('; '));
    s.pipes = {};
    for (const entry of ['apply', 'dot1', 'dot2', 'update_ur', 'update_p', 'roll']) {
      s.pipes[entry] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } });
    }
    return s;
  }

  _buf(data, usage = GPUBufferUsage.STORAGE) {
    const b = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.device.queue.writeBuffer(b, 0, data);
    return b;
  }

  _grid(count, wg) {
    const groups = Math.ceil(count / wg);
    const gx = Math.min(groups, 65535);
    return [gx, Math.ceil(groups / gx)];
  }

  _uniform(P, gx, nparts = 0, slot = 0) {
    return this._buf(new Uint32Array([P.nx, P.ny, P.nz, P.nn, P.ndof, gx, nparts, slot]), GPUBufferUsage.UNIFORM);
  }

  /** Same problem, multigrid-preconditioned flexible CG (multigrid.js); options there. */
  async solveMG(blob, opts = {}) { return solveMG(this, blob, opts); }

  /** Solve a problem blob from /api/fea/case. Returns { u: Float32Array, iterations, rel, ms, ... }. */
  async solve(blob, { tol = 1e-6, maxIter = 20000, checkEvery = 25, onProgress } = {}) {
    const d = this.device;
    const P = parse(blob);
    const t0 = performance.now();
    const dinvH = new Float32Array(P.ndof);
    const diag = new Float32Array(P.ndof);
    // Jacobi diagonal: sum over solid voxels of E * KE[a,a]
    const { nx, ny, nz } = P;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const e = P.emod[i + nx * (j + ny * k)];
      if (!e) continue;
      for (let a = 0; a < 8; a++) {
        const m = (i + (a & 1)) + (nx + 1) * ((j + ((a >> 1) & 1)) + (ny + 1) * (k + ((a >> 2) & 1)));
        for (let c = 0; c < 3; c++) diag[3 * m + c] += e * P.ke[(3 * a + c) * 25];
      }
    }
    const f = new Float32Array(P.ndof);
    let fn = 0;
    for (let i = 0; i < P.ndof; i++) {
      if (!P.fixed[i] && diag[i] > 0) { dinvH[i] = 1 / diag[i]; f[i] = P.force[i]; fn += f[i] * f[i]; }
    }
    fn = Math.sqrt(fn);
    const z0 = f.map((v, i) => v * dinvH[i]);

    const B = {
      ke: this._buf(P.ke), emod: this._buf(P.emod), fixed: this._buf(P.fixed), dinv: this._buf(dinvH),
      u: this._buf(new Float32Array(P.ndof)), r: this._buf(f), z: this._buf(z0), p: this._buf(z0),
      ap: this._buf(new Float32Array(P.ndof)), sc: this._buf(new Float32Array(4)),
    };
    const [agx, agy] = this._grid(P.nn, WG);
    const [egx, egy] = this._grid(P.ndof, RW);
    const [rgx, rgy] = this._grid(Math.ceil(P.ndof / CHUNK), RW);
    const nparts = rgx * rgy;
    B.parts = this._buf(new Float32Array(nparts));
    const read = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const bg = (pipe, group, entries) => d.createBindGroup({
      layout: this.pipes[pipe].getBindGroupLayout(group),
      // entries: [buffer, ...] for bindings 0..n-1, or {binding: buffer} for sparse ones
      entries: (Array.isArray(entries) ? entries.map((b, i) => [i, b]) : Object.entries(entries))
        .map(([i, b]) => ({ binding: +i, resource: { buffer: b } })),
    });
    const U = {
      apply: this._uniform(P, agx), elem: this._uniform(P, egx),
      dot: [0, 1, 2, 3].map(slot => this._uniform(P, rgx, nparts, slot)),
    };
    const G = {
      apply: [bg('apply', 0, [U.apply]), bg('apply', 1, [B.ke, B.emod, B.fixed, B.p, B.ap])],
      ur: [bg('update_ur', 0, [U.elem]), bg('update_ur', 1, [B.u, B.r, B.p, B.ap, B.dinv, B.z, B.sc])],
      up: [bg('update_p', 0, [U.elem]), bg('update_p', 1, { 2: B.p, 5: B.z, 6: B.sc })],
      roll: [bg('roll', 0, [U.elem]), bg('roll', 1, { 6: B.sc })],
    };
    const dotGroups = (a, b, slot) => ({
      p1: [bg('dot1', 0, [U.dot[slot]]), bg('dot1', 1, { 0: a, 1: b, 2: B.parts })],
      p2: [bg('dot2', 0, [U.dot[slot]]), bg('dot2', 1, { 2: B.parts, 3: B.sc })],
    });
    const D = { rz0: dotGroups(B.r, B.z, 0), pap: dotGroups(B.p, B.ap, 1), rz: dotGroups(B.r, B.z, 2), rr: dotGroups(B.r, B.r, 3) };

    const run = (pass, pipe, groups, x, y = 1) => {
      pass.setPipeline(this.pipes[pipe]);
      groups.forEach((g, i) => pass.setBindGroup(i, g));
      pass.dispatchWorkgroups(x, y);
    };
    const dot = (pass, g) => { run(pass, 'dot1', g.p1, rgx, rgy); run(pass, 'dot2', g.p2, 1); };

    let enc = d.createCommandEncoder();
    let pass = enc.beginComputePass();
    dot(pass, D.rz0);
    pass.end();
    d.queue.submit([enc.finish()]);
    await d.queue.onSubmittedWorkDone();
    const tSetup = performance.now();

    let it = 0, rel = 1;
    const hist = [];
    while (it < maxIter) {
      enc = d.createCommandEncoder();
      pass = enc.beginComputePass();
      const steps = Math.min(checkEvery, maxIter - it);
      for (let s = 0; s < steps; s++) {
        run(pass, 'apply', G.apply, agx, agy);
        dot(pass, D.pap);
        run(pass, 'update_ur', G.ur, egx, egy);
        dot(pass, D.rz);
        if (s < steps - 1) { run(pass, 'update_p', G.up, egx, egy); run(pass, 'roll', G.roll, 1); }
      }
      dot(pass, D.rr);
      pass.end();
      enc.copyBufferToBuffer(B.sc, 0, read, 0, 16);
      d.queue.submit([enc.finish()]);
      it += steps;
      await read.mapAsync(GPUMapMode.READ);
      const sc = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      rel = Math.sqrt(Math.max(sc[3], 0)) / fn;
      hist.push([it, rel]);
      onProgress?.(it, rel);
      if (!(rel >= tol)) break;        // also stops on NaN
      // finish the last step's p update, deferred so the check sees a consistent state
      enc = d.createCommandEncoder();
      pass = enc.beginComputePass();
      run(pass, 'update_p', G.up, egx, egy);
      run(pass, 'roll', G.roll, 1);
      pass.end();
      d.queue.submit([enc.finish()]);
    }
    const tSolve = performance.now();
    const out = d.createBuffer({ size: P.ndof * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(B.u, 0, out, 0, P.ndof * 4);
    d.queue.submit([enc.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const u = new Float32Array(out.getMappedRange().slice(0));
    out.unmap();
    for (const b of [...Object.values(B), ...Object.values(U).flat(), read, out]) b.destroy?.();
    return {
      u, iterations: it, rel, history: hist, ndof: P.ndof, nsolid: P.nsolid,
      setupMs: tSetup - t0, solveMs: tSolve - tSetup, msPerIteration: (tSolve - tSetup) / Math.max(it, 1),
    };
  }
}
