// Tap to hear it: a tap on a part plays its natural frequencies and shows it vibrating.
//
// The modes (modes.js) are worked out once per body and design, on a Draft voxel model (a
// few seconds), and kept until the body or its supports change. A tap then sounds each mode
// as a decaying sine at its real pitch, as loud as the tapped point moves in that mode
// (steel parts this size ring in the kHz), and shows the loudest one swinging, slowed to a
// pace you can see, on its own (Draft) display mesh.

import { naturalModes } from './modes.js';
import { parse } from './fea/solver.js';

const SHOW_HZ = 1.6;          // the shown swing, whatever the real pitch
const DECAY = 1.4;            // seconds for the shown swing (and the first mode's sound) to die to 1/e

export function createRing({ viewer, buildCase, gpuSolver, parseField, gate, doc, keyOf, sizeOf, onStatus, restore }) {
  const cache = new Map();    // body id -> { key, modes: [{ hz, shape, field }], P }
  let audio = null, anim = null, working = null, capture = null;   // capture: the sound as a MediaStream, to record

  /** An AudioContext may only start from a click or pinch: call this from one. */
  function unlock() {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    capture ??= audio.createMediaStreamDestination();
    if (audio.state === 'suspended') audio.resume();
  }

  async function modesOf(id) {
    const key = keyOf(id), hit = cache.get(id);
    if (hit?.key === key) return hit;
    if (working?.id === id) return working.promise;
    const token = gate.start();
    const promise = (async () => {
      try {
        const solver = await gpuSolver();
        onStatus({ id, phase: 'modes', fraction: 0 });
        const { caseId, meta, blob } = await buildCase(doc(), id, undefined, null, 'draft');
        // loose solves are enough: the Rayleigh-Ritz step settles the frequencies to 0.1%
        const modes = await naturalModes({ blob, meta, count: 4,
          solve: async (b, x0) => (await solver.solveMG(b, { tol: 1e-2, x0, checkEvery: viewer.renderer.xr.isPresenting ? 1 : 2 })).u,
          onProgress: f => onStatus({ id, phase: 'modes', fraction: 0.9 * f }), alive: () => gate.alive(token) });
        if (!modes) return null;
        // each shape at the display mesh's points (the server's result, fed a mode for u)
        for (const m of modes) {
          const rr = await fetch(`/api/analyze/result?id=${caseId}`, { method: 'POST', body: m.shape });
          if (!rr.ok) throw new Error((await rr.json().catch(() => ({}))).detail || rr.statusText);
          const f = parseField(await rr.arrayBuffer());
          let big = 0;
          const mag = new Float32Array(f.displacement.length / 3);
          for (let i = 0; i < mag.length; i++) { mag[i] = Math.hypot(f.displacement[3 * i], f.displacement[3 * i + 1], f.displacement[3 * i + 2]); big = Math.max(big, mag[i]); }
          m.field = { mag, big, displacement: f.displacement, mesh: { positions: f.positions, normals: f.normals, triFace: f.triFace } };
        }
        const entry = { key, modes, P: parse(blob) };
        cache.set(id, entry);
        onStatus({ id, phase: 'ready', modes });
        return entry;
      } finally {
        gate.end(token);
        working = null;
      }
    })();
    working = { id, promise };
    return promise;
  }

  /** How much the node of P nearest `point` moves in a mode, along `dir` (or in all directions). */
  function at(P, shape, point, dir) {
    const I = Math.round((point[0] - P.origin[0]) / P.h), J = Math.round((point[1] - P.origin[1]) / P.h), K = Math.round((point[2] - P.origin[2]) / P.h);
    let best = 0;
    for (let k = K - 1; k <= K + 1; k++) for (let j = J - 1; j <= J + 1; j++) for (let i = I - 1; i <= I + 1; i++) {
      if (i < 0 || j < 0 || k < 0 || i > P.nx || j > P.ny || k > P.nz) continue;
      const n = 3 * (i + (P.nx + 1) * (j + (P.ny + 1) * k)), u = [shape[n], shape[n + 1], shape[n + 2]];
      const v = dir ? Math.abs(u[0] * dir[0] + u[1] * dir[1] + u[2] * dir[2]) : Math.hypot(...u);
      best = Math.max(best, v);
    }
    return best;
  }

  function sound(modes, amps) {
    if (!audio) return;
    const t0 = audio.currentTime + 0.01, out = audio.createGain();
    out.gain.value = 0.35;
    out.connect(audio.destination);
    out.connect(capture);
    // the knock of the tap itself: a few ms of noise
    const click = audio.createBufferSource(), nb = audio.createBuffer(1, Math.round(audio.sampleRate * 0.006), audio.sampleRate);
    const ch = nb.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
    click.buffer = nb;
    const cg = audio.createGain(); cg.gain.value = 0.25;
    click.connect(cg).connect(out);
    click.start(t0);
    modes.forEach((m, i) => {
      if (!(m.hz > 20 && m.hz < 16000) || amps[i] < 0.02) return;
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = m.hz;
      // higher modes die away faster
      const tau = DECAY * Math.sqrt(modes[0].hz / m.hz);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(amps[i], t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(1e-4, t0 + 6 * tau);
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + 6 * tau + 0.05);
    });
  }

  function show(id, m) {
    stopShow();
    const f = m.field, size = sizeOf(id);
    viewer.setField(id, f.mag, f.big || 1, f.displacement, f.mesh);
    const t0 = performance.now(), amp = 0.06 * size;
    anim = () => {
      const t = (performance.now() - t0) / 1000;
      const s = amp * Math.exp(-t / DECAY) * Math.sin(2 * Math.PI * SHOW_HZ * t);
      viewer.setDeformation(s, new Set([id]));
      if (t > 5 * DECAY) stopShow(true);
    };
    viewer.tickers.add(anim);
  }
  function stopShow(done = false) {
    if (!anim) return;
    viewer.tickers.delete(anim);
    anim = null;
    if (done) restore();
  }

  return {
    unlock,
    modesOf,
    cached: id => cache.get(id)?.key === keyOf(id) ? cache.get(id).modes : null,
    busy: () => !!working,
    /** Tap body `id` at `point` (mm) on a face with outward `normal`. */
    async tap(id, point, normal) {
      unlock();
      const entry = await modesOf(id);
      if (!entry) return null;
      const into = normal.map(x => -x);
      const raw = entry.modes.map(m => at(entry.P, m.shape, point, into));
      const top = Math.max(...raw, 1e-9);
      const amps = raw.map(a => a / top);
      sound(entry.modes, amps);
      const loudest = amps.indexOf(1);
      show(id, entry.modes[loudest]);
      return { modes: entry.modes, amps, loudest };
    },
    stop() { stopShow(true); },
    /** The taps' sound as a MediaStream (for a screen recording), once unlock() has run. */
    stream: () => capture?.stream ?? null,
    forget(id) { cache.delete(id); },
  };
}
