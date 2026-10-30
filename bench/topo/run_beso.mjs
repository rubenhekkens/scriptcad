// Runs web/fea/topo.js (the optimiser the app uses) on a problem blob, with every solve done
// by the Python process that started this one (float64 PyAMG). Protocol over stdio:
//   to Python (stdout):  'S' + emod (f32 x nvox) + fixed (u32 x 3 nn)   -> solve this design
//                        'D' + u32 length + JSON + emod (f32 x nvox)      -> done, final design
//   from Python (stdin): u (f32 x 3 nn)
// usage: node run_beso.mjs <blob> <web dir url> <options JSON>
import { readFileSync } from 'node:fs';

const [blobPath, web, opts] = process.argv.slice(2);
const { parse } = await import(new URL('fea/solver.js', web));
const T = await import(new URL('fea/topo.js', web));
const file = readFileSync(blobPath);
const blob = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const P = parse(blob);

// exact-length reads from stdin
let pending = [], have = 0, want = 0, wake = null;
process.stdin.on('data', d => { pending.push(d); have += d.length; if (wake && have >= want) wake(); });
async function read(n) {
  if (have < n) { want = n; await new Promise(r => { wake = r; }); wake = null; }
  const all = Buffer.concat(pending), out = all.subarray(0, n);
  pending = [all.subarray(n)]; have -= n;
  return out;
}
const write = parts => new Promise(r => process.stdout.write(Buffer.concat(parts), r));
const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

async function solve() {
  await write([Buffer.from('S'), bytes(P.emod), bytes(P.fixed)]);
  const b = await read(4 * P.ndof);
  return { u: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) };
}

const steps = [];
const t0 = performance.now();
const res = await T.optimize(blob, P, solve, { ...JSON.parse(opts), onStep: s => { steps.push({ fraction: s.fraction, compliance: s.compliance, dmax: s.dmax }); } });
const info = Buffer.from(JSON.stringify({ stop: res.stop, fraction: res.fraction, compliance: res.compliance, dmax: res.dmax,
                                          steps, seconds: (performance.now() - t0) / 1000 }));
const len = Buffer.alloc(4); len.writeUInt32LE(info.length);
await write([Buffer.from('D'), len, info, bytes(P.emod)]);
process.exit(0);
