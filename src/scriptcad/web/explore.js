// Explore: solve many variants of a design and show the mass / deflection trade-off.
//
// The user picks document variables to vary (each over a range) and optional limits on
// deflection and stress. Variants are spread over the ranges with a Latin hypercube, each
// one is rebuilt by the kernel and solved on the GPU exactly like a normal analysis (only
// the statistics come back), and the results are plotted. Clicking a point writes its
// values into the variables, so the chosen design is the user's own feature tree.
// Limits use the 99th-percentile stress, never the peak: the peak at supports and loads
// is singular and keeps rising as voxels get finer, so an optimiser chasing it chases noise.

import { variables } from './expr.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 3) => x == null ? '—' : (+x.toPrecision(d)).toLocaleString(undefined, { maximumFractionDigits: 6 });

/** Seeded generator, so the same setup samples the same variants. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n points over the ranges, one per stratum of every variable (Latin hypercube). */
export function latinHypercube(ranges, n, seed = 1) {
  const rand = rng(seed);
  const cols = ranges.map(([lo, hi]) => {
    const perm = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    const step = hi - lo >= 2 ? 0.1 : 0.01;            // values a person would type
    return perm.map(k => Math.round((lo + (k + rand()) / n * (hi - lo)) / step) * step);
  });
  return [...Array(n).keys()].map(i => cols.map(c => +c[i].toFixed(4)));
}

/** Indices of the points no other point beats on both mass and deflection, lightest first. */
export function paretoFront(points) {
  const idx = points.map((_, i) => i).sort((a, b) => points[a].mass - points[b].mass || points[a].defl - points[b].defl);
  const front = [];
  let best = Infinity;
  for (const i of idx) if (points[i].defl < best) { front.push(i); best = points[i].defl; }
  return front;
}

export function createExplore({ S, setup, solveStats, gate, bodyLabel, setVariables, render, toast }) {
  let runs = null;          // { body, names, points: [{ vals, mass, defl, p99, error }], base }
  let progress = '';
  let token = null;

  const cfg = () => {
    const a = setup();
    a.explore ??= { vary: {}, limits: { defl: null, stress: null }, samples: 24 };
    return a.explore;
  };
  // only variables holding a plain number can be varied; derived ones (tf = bf / 4) follow
  const numericVars = () => (S.doc.variables || []).filter(v => typeof v.value === 'number');
  const range = v => {
    const e = cfg().vary[v.name];
    return e ? [e.lo, e.hi] : v.value ? [+(v.value * 0.5).toFixed(3), +(v.value * 1.5).toFixed(3)] : [0, 1];
  };
  const varied = () => numericVars().filter(v => cfg().vary[v.name]?.on);
  const meets = p => {
    const L = cfg().limits;
    return !p.error && (L.defl == null || p.defl * 1000 <= L.defl) && (L.stress == null || p.p99 <= L.stress);
  };

  async function start() {
    const body = setup().body;
    const vs = varied();
    if (!body || !vs.length) return;
    const names = vs.map(v => v.name);
    const ranges = vs.map(v => [range(v)[0], range(v)[1]]);
    if (ranges.some(([lo, hi]) => !(hi > lo))) return toast('Each range needs a maximum above its minimum.', true);
    const n = cfg().samples;
    const base = vs.map(v => v.value);
    const plan = [base, ...latinHypercube(ranges, n, 1)];
    runs = { body, names, points: [], base: 0 };
    const t = token = gate.start();
    const t0 = performance.now();
    try {
      for (let i = 0; i < plan.length; i++) {
        if (!gate.alive(t)) break;
        progress = `Variant ${i + 1} of ${plan.length}${i ? ` · about ${Math.ceil((performance.now() - t0) / i * (plan.length - i) / 1000)} s left` : ''}…`;
        render();
        const vals = plan[i];
        const doc = { ...S.doc, variables: (S.doc.variables || []).map(v => names.includes(v.name) ? { ...v, value: vals[names.indexOf(v.name)] } : v) };
        try {
          variables(doc);
          const { meta, stats } = await solveStats(doc, body);
          if (!gate.alive(t)) break;
          runs.points.push({ vals, mass: meta.mass_g, defl: stats.max_displacement, p99: stats.p99 });
        } catch (e) {
          if (!gate.alive(t)) break;
          runs.points.push({ vals, error: e.message });
        }
      }
      const failed = runs.points.filter(p => p.error).length;
      progress = `${runs.points.length - failed} variants solved in ${fmt((performance.now() - t0) / 1000, 2)} s` +
        (failed ? ` · ${failed} could not be built (for example a web wider than its flange)` : '');
    } finally {
      if (token === t) token = null;
      gate.end(t);
      render();
    }
  }

  function stop() { if (token) { gate.cancel(); token = null; progress = 'Stopped.'; render(); } }

  function chart() {
    const pts = runs.points.map((p, i) => ({ ...p, i })).filter(p => !p.error);
    if (!pts.length) return '';
    const L = cfg().limits;
    const W = 230, H = 170, m = { l: 34, r: 8, t: 8, b: 30 };   // about the panel's width, so text stays readable
    const xs = pts.map(p => p.mass), ys = pts.map(p => p.defl * 1000);
    const pad = (lo, hi) => { const d = (hi - lo) || hi || 1; return [lo - 0.06 * d, hi + 0.06 * d]; };
    const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
    const y0 = 0, y1 = 1.08 * Math.max(...ys, L.defl ?? 0);       // from zero, so heights compare honestly
    const X = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r), Y = v => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
    const ok = pts.filter(meets);
    const front = paretoFront(ok).map(k => ok[k]);
    const ticks = (lo, hi) => { const s = 10 ** Math.floor(Math.log10((hi - lo) / 3)), st = [1, 2, 5].map(k => k * s).find(k => (hi - lo) / k <= 5) || 10 * s;
      const out = []; for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) out.push(+v.toPrecision(6)); return out; };
    return `<svg class="explore-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Deflection against mass for each variant">
      ${ticks(x0, x1).map(v => `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}"/><text class="tick" x="${X(v)}" y="${H - m.b + 12}" text-anchor="middle">${fmt(v)}</text>`).join('')}
      ${ticks(y0, y1).map(v => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${m.l - 4}" y="${Y(v) + 3}" text-anchor="end">${fmt(v)}</text>`).join('')}
      <text class="axis" x="${(m.l + W - m.r) / 2}" y="${H - 3}" text-anchor="middle">Mass (g)</text>
      <text class="axis" x="10" y="${(m.t + H - m.b) / 2}" text-anchor="middle" transform="rotate(-90 10 ${(m.t + H - m.b) / 2})">Deflection (µm)</text>
      ${L.defl != null ? `<line class="limit" x1="${m.l}" x2="${W - m.r}" y1="${Y(L.defl)}" y2="${Y(L.defl)}"/><text class="limit-t" x="${W - m.r - 2}" y="${Y(L.defl) - 3}" text-anchor="end">limit</text>` : ''}
      ${front.length > 1 ? `<polyline class="front" points="${front.map(p => `${X(p.mass)},${Y(p.defl * 1000)}`).join(' ')}"/>` : ''}
      ${pts.map(p => `<circle class="pt ${meets(p) ? 'ok' : 'no'} ${front.includes(p) ? 'best' : ''} ${p.i === runs.base ? 'base' : ''}" data-xpt="${p.i}"
        cx="${X(p.mass)}" cy="${Y(p.defl * 1000)}" r="${p.i === runs.base ? 5 : 4}"><title>${tip(p)}</title></circle>`).join('')}
    </svg>`;
  }

  const tip = p => `${runs.names.map((n, k) => `${n} = ${fmt(p.vals[k])}`).join(', ')}\n${fmt(p.mass)} g · ${fmt(p.defl * 1000)} µm · ${fmt(p.p99)} MPa${p.i === runs.base ? '\n(current design)' : ''}${meets(p) ? '' : '\nmisses a limit'}\nClick to use these values`;

  function summary() {
    const ok = runs.points.map((p, i) => ({ ...p, i })).filter(meets);
    const base = runs.points[runs.base];
    if (!ok.length) return '<div class="hint">No variant meets the limits. Relax a limit or widen the ranges.</div>';
    const best = ok.reduce((a, b) => b.mass < a.mass ? b : a);
    const vs = base && !base.error && best.i !== runs.base ?` (${best.mass < base.mass ? '−' : '+'}${fmt(Math.abs(1 - best.mass / base.mass) * 100, 2)}% against the current design)` : '';
    return `<div class="explore-best"><div><b>Lightest that meets the limits:</b> ${fmt(best.mass)} g${vs}, ${fmt(best.defl * 1000)} µm, ${fmt(best.p99)} MPa<br>
      <span class="mono">${runs.names.map((n, k) => `${esc(n)} = ${fmt(best.vals[k])}`).join(' · ')}</span></div>
      ${best.i === runs.base ? '<span class="muted small">already the current design</span>' : `<button class="btn" data-xapply="${best.i}">Use it</button>`}</div>`;
  }

  function html() {
    const a = setup();
    const nums = numericVars();
    const head = '<div class="panel-h sub explore-h"><span>Explore variants</span></div>';
    if (!nums.length) return `${head}<div class="muted small">Add variables in the left panel and use them in the model's dimensions; Explore then solves variants of the design and plots mass against deflection.</div>`;
    if (!a.body) return `${head}<div class="muted small">Choose a body to explore.</div>`;
    const c = cfg(), L = c.limits;
    const nVar = varied().length;
    const shown = runs && runs.body === a.body;
    return `${head}
      <div class="muted small">Variants of <b>${esc(bodyLabel(a.body))}</b>, solved like the analysis above (same load, material and resolution).</div>
      <table class="explore-vars"><thead><tr><th></th><th>Variable</th><th>Min</th><th>Max</th><th>Now</th></tr></thead><tbody>
        ${nums.map(v => { const [lo, hi] = range(v); return `<tr><td><input type="checkbox" data-xon="${esc(v.name)}" ${c.vary[v.name]?.on ? 'checked' : ''} aria-label="Vary ${esc(v.name)}"></td>
          <td class="mono">${esc(v.name)}</td>
          <td><input type="number" step="any" data-xlo="${esc(v.name)}" value="${lo}" aria-label="${esc(v.name)} minimum"></td>
          <td><input type="number" step="any" data-xhi="${esc(v.name)}" value="${hi}" aria-label="${esc(v.name)} maximum"></td>
          <td class="muted">${fmt(v.value)}</td></tr>`; }).join('')}
      </tbody></table>
      <div class="field"><label for="ex_defl">Max deflection</label><div class="unit-in"><input id="ex_defl" type="number" step="any" min="0" data-xlimit="defl" value="${L.defl ?? ''}" placeholder="none"><span>µm</span></div></div>
      <div class="field"><label for="ex_stress" title="Von Mises, 99th percentile">Max stress (99th pct)</label><div class="unit-in"><input id="ex_stress" type="number" step="any" min="0" data-xlimit="stress" value="${L.stress ?? ''}" placeholder="none"><span>MPa</span></div></div>
      <div class="field"><label for="ex_n">Variants</label><select id="ex_n" data-xn>${[12, 24, 48].map(n => `<option value="${n}" ${n === c.samples ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="prop-actions">
        ${token ? '<button class="btn" id="exStop">Stop</button>' : `<button class="btn primary" id="exRun" ${nVar && gate.idle() ? '' : 'disabled'}>Explore ${c.samples} variants</button>`}
      </div>
      ${!nVar ? '<div class="muted small">Tick the variables to vary.</div>' : ''}
      ${progress && (token || shown) ? `<div class="muted small an-status">${esc(progress)}</div>` : ''}
      ${shown && runs.points.length ? `${chart()}
        <div class="legend explore-legend"><span><i class="ok"></i>meets the limits</span><span><i class="no"></i>misses one</span><span><i class="base"></i>current design</span><span><i class="line"></i>best trade-offs</span></div>
        ${token ? '' : summary()}
        <div class="muted small">Each dot is a variant: lower and further left is better. The line joins the variants no other variant beats on both mass and deflection. Click a dot to put its values in the variables.</div>` : ''}`;
  }

  function apply(i) {
    const p = runs?.points[i];
    if (!p || p.error || token) return;       // the rebuild would start a live run and cancel this one
    setVariables(Object.fromEntries(runs.names.map((n, k) => [n, p.vals[k]])));
    runs.base = i;
  }

  function onClick(e) {
    if (e.target.id === 'exRun') { start(); return true; }
    if (e.target.id === 'exStop') { stop(); return true; }
    const pt = e.target.closest('[data-xpt],[data-xapply]');
    if (pt) { apply(+(pt.dataset.xpt ?? pt.dataset.xapply)); return true; }
    return false;
  }

  function onChange(e) {
    const t = e.target, c = cfg(), d = t.dataset;
    const entry = name => (c.vary[name] ??= { on: false, ...(([lo, hi]) => ({ lo, hi }))(range(numericVars().find(v => v.name === name))) });
    if (d.xon !== undefined) entry(d.xon).on = t.checked;
    else if (d.xlo !== undefined || d.xhi !== undefined) {
      if (t.value === '' || !isFinite(+t.value)) return true;
      const en = entry(d.xlo ?? d.xhi);
      en[d.xlo !== undefined ? 'lo' : 'hi'] = +t.value;
    } else if (d.xlimit !== undefined) c.limits[d.xlimit] = t.value === '' || !(+t.value > 0) ? null : +t.value;
    else if (d.xn !== undefined) c.samples = +t.value;
    else return false;
    render();
    return true;
  }

  return { html, onClick, onChange, stop, reset() { runs = null; progress = ''; } };
}
