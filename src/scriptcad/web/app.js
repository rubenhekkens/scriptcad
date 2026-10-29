import { Viewer } from './viewer.js';
import { FEATURES, CREATES, defaults, visibleFields, liveBodiesBefore, nextName, icon, featureIcon } from './features.js';
import { createAnalyze } from './analyze.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => 'f' + Math.random().toString(36).slice(2, 8);
const PALETTE = ['#9aa7b8', '#7fa7d9', '#d9a066', '#8fc79a', '#c48fd6', '#d6c26e', '#6fc3c9', '#d98a8a'];
const fmt = (x, d = 3) => x == null ? '—' : Math.abs(x) >= 1e5 ? x.toExponential(3) : (+x.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });

const DEFAULT_SCRIPT = `# ScriptCAD script - plain Python on NVIDIA's USD BRep kernel.
#   sm      -> the usd_brep module (all SMLib operations)
#   show(brep, name) puts a body in the viewport
# Ctrl+Enter runs. Type "sm." for completions.
import math

# A flanged hub: revolve a profile, then drill a bolt circle.
profile = polyline([(6, 0), (30, 0), (30, 6), (12, 6), (12, 24), (6, 24)])
hub = sm.rotational_sweep(profile, (0, 0, 0), (0, 1, 0), 360)
sm.rotate(hub, (0, 0, 0), (1, 0, 0), 90)   # sketch Y -> world Z

for i in range(6):
    a = math.radians(i * 60)
    hole = sm.create_cylinder((21 * math.cos(a), 21 * math.sin(a), -1), 2.6, 8)
    hub = sm.boolean_difference(hub, hole)

print("volume  %.1f mm^3" % hub.volume())
print("faces   %d" % hub.face_count())
show(hub, "Hub")
`;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const S = {
  doc: { name: 'Untitled part', features: [] },
  script: DEFAULT_SCRIPT,
  mode: 'model',
  editing: null,          // { id, isNew, before }
  treeSel: null,          // feature id highlighted in the tree
  status: {},             // per-feature kernel status
  bodies: { model: [], script: [] },
  colors: {},
  hidden: new Set(),
  selection: [],          // [{ bodyId, kind, index, point }]
  pick: null,             // { key, kind: 'edges'|'faces' } while picking refs
  measuring: false,
  measure: [],
  density: 7.85,
  undo: [],
  redo: [],
  names: null,
};

const viewer = new Viewer($('#viewport'), $('#gizmo'));
window.scriptcad = { S, viewer };  // handy from the devtools console

// Analyze mode lives in analyze.js; these are the only hooks it needs from the app
const analysis = createAnalyze({
  S, viewer,
  toast: (m, e) => toast(m, e),
  bodies: () => S.bodies.model,
  bodyLabel: id => bodyLabel(id),
  refOf: hit => refOf(hit),
  onChange: () => { persist(); renderRibbonState(); renderProps(); },
});
window.scriptcad.analysis = analysis;
analysis.bind($('#props'));

// ---------------------------------------------------------------------------
// kernel calls
// ---------------------------------------------------------------------------

async function api(path, body, raw = false) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return raw ? r : r.json();
}

let regenSeq = 0, regenTimer = null, firstFit = true;

function scheduleRegen(delay = 120) {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regen, delay);
}

/** Document as the kernel should see it right now (rolled back while picking). */
function kernelDoc() {
  const feats = S.doc.features;
  if (S.pick && S.editing) {
    const i = feats.findIndex(f => f.id === S.editing.id);
    return { ...S.doc, features: feats.slice(0, i) };
  }
  return S.doc;
}

async function regen() {
  const seq = ++regenSeq;
  const doc = kernelDoc();
  $('#busy').hidden = false;
  try {
    const t0 = performance.now();
    const res = await api('/api/regen', { doc, quality: 'normal' });
    if (seq !== regenSeq) return;
    // while rolled back, keep the status of features beyond the rollback point
    S.status = S.pick ? { ...S.status, ...res.status } : res.status;
    S.bodies.model = res.bodies;
    assignColors(res.bodies);
    if (S.mode === 'model') { showBodies(res.bodies); analysis.afterRegen(); }
    const errs = Object.values(res.status).filter(s => s.state === 'error').length;
    setKernel(errs ? 'warn' : 'ok', `${S.pick ? 'Rolled back for picking · ' : ''}Regenerated ${doc.features.length} feature${doc.features.length === 1 ? '' : 's'} in ${Math.round(performance.now() - t0)} ms${errs ? ` · ${errs} error${errs > 1 ? 's' : ''}` : ''}`);
    renderTree();
    renderProps();
    renderInfo();
  } catch (e) {
    if (seq !== regenSeq) return;
    setKernel('bad', e.message);
    toast(e.message, true);
  } finally {
    if (seq === regenSeq) $('#busy').hidden = true;
  }
}

function assignColors(bodies) {
  let i = Object.keys(S.colors).length;
  for (const b of bodies) if (!S.colors[b.id]) S.colors[b.id] = b.color || PALETTE[i++ % PALETTE.length];
}

function showBodies(bodies) {
  viewer.setBodies(bodies, { colors: S.colors, hidden: S.hidden, refit: firstFit && bodies.length > 0 });
  if (bodies.length) firstFit = false;
  $('#emptyHint').hidden = bodies.length > 0 || (S.mode === 'model' && S.doc.features.length > 0) || S.mode === 'script';
  syncSelectionToViewer();
  renderBodies();
}

function setKernel(state, text) {
  $('#kDot').className = 'dot ' + (state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : '');
  $('#kStatus').textContent = text;
}

// ---------------------------------------------------------------------------
// document edits + undo
// ---------------------------------------------------------------------------

const snap = () => JSON.stringify(S.doc);

function commit(before) {
  if (before !== snap()) {
    S.undo.push(before);
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  persist();
  renderTopbar();
}

function undo() {
  if (S.editing) cancelEdit();
  if (!S.undo.length) return;
  S.redo.push(snap());
  S.doc = JSON.parse(S.undo.pop());
  afterDocSwap();
}
function redo() {
  if (S.editing) finishEdit();
  if (!S.redo.length) return;
  S.undo.push(snap());
  S.doc = JSON.parse(S.redo.pop());
  afterDocSwap();
}
function afterDocSwap() {
  $('#docName').value = S.doc.name;
  S.selection = [];
  persist();
  renderAll();
  scheduleRegen(0);
}

function feature(id) { return S.doc.features.find(f => f.id === id); }

function addFeature(type, preset = {}) {
  if (S.editing) finishEdit();
  const before = snap();
  const f = { id: uid(), type, name: nextName(S.doc.features, type), params: { ...defaults(type), ...preset } };
  // pre-fill body inputs from the current selection, else the most recent bodies
  const live = liveBodiesBefore(S.doc.features, S.doc.features.length);
  const selBodies = [...new Set(S.selection.map(s => s.bodyId))].filter(b => live.includes(b));
  const bodyFields = FEATURES[type].fields.filter(x => x.type === 'body');
  const pool = [...selBodies, ...live.slice().reverse().filter(b => !selBodies.includes(b))];
  bodyFields.forEach((fd, i) => { if (!f.params[fd.k] && pool[i]) f.params[fd.k] = pool[i]; });
  if (type === 'boolean' && f.params.target && f.params.tool && !selBodies.length) {
    // without a selection, use the older body as target and the newest as tool
    [f.params.target, f.params.tool] = [pool[1], pool[0]];
  }
  const edges = S.selection.filter(s => s.kind === 'edge' && s.bodyId === f.params.target);
  if ((type === 'fillet') && edges.length) f.params.edges = edges.map(s => refOf(s));
  const faces = S.selection.filter(s => s.kind === 'face' && s.bodyId === f.params.target);
  if (type === 'shell' && faces.length) f.params.faces = faces.map(s => refOf(s));
  S.doc.features.push(f);
  S.editing = { id: f.id, isNew: true, before };
  S.treeSel = f.id;
  S.selection = [];
  S.pick = null;
  renderAll();
  // fillet/shell with nothing picked: start in pick mode straight away
  if (type === 'fillet' && !f.params.edges.length) startPick('edges');
  else if (type === 'shell' && !f.params.faces.length) startPick('faces');
  else scheduleRegen(0);
}

function editFeature(id) {
  if (S.editing?.id === id) return;
  if (S.editing) finishEdit();
  S.editing = { id, isNew: false, before: snap() };
  S.treeSel = id;
  renderAll();
}

function finishEdit() {
  if (!S.editing) return;
  const { before } = S.editing;
  const wasPicking = !!S.pick;
  S.editing = null;
  S.pick = null;
  commit(before);
  renderAll();
  if (wasPicking) scheduleRegen(0);
}

function cancelEdit() {
  if (!S.editing) return;
  S.doc = JSON.parse(S.editing.before);
  S.editing = null;
  S.pick = null;
  renderAll();
  scheduleRegen(0);
}

function deleteFeature(id) {
  const before = S.editing?.id === id ? S.editing.before : snap();
  if (S.editing?.id === id) S.editing = null;
  else if (S.editing) finishEdit();
  S.pick = null;
  S.doc.features = S.doc.features.filter(f => f.id !== id);
  if (S.treeSel === id) S.treeSel = null;
  commit(before);
  renderAll();
  scheduleRegen(0);
}

function moveFeature(id, d) {
  if (S.editing) finishEdit();
  const before = snap();
  const a = S.doc.features, i = a.findIndex(f => f.id === id), j = i + d;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  commit(before);
  renderTree();
  scheduleRegen(0);
}

function toggleSuppress(id) {
  if (S.editing && S.editing.id !== id) finishEdit();
  const before = snap();
  const f = feature(id);
  f.suppressed = !f.suppressed;
  if (!S.editing) commit(before);
  renderTree();
  scheduleRegen(0);
}

function setParam(f, k, v) {
  f.params[k] = v;
  scheduleRegen();
}

// ---------------------------------------------------------------------------
// picking references (edges / faces) for the feature being edited
// ---------------------------------------------------------------------------

function refOf(sel) {
  const b = S.bodies.model.find(x => x.id === sel.bodyId);
  const list = sel.kind === 'edge' ? b?.edges : b?.faces;
  return list?.[sel.index]?.ref || sel.point;
}

function startPick(kind) {
  S.pick = { kind };
  viewer.setMode(kind === 'edges' ? 'edge' : 'face');
  setSelButtons(kind === 'edges' ? 'edge' : 'face');
  renderProps();
  scheduleRegen(0);
}

function stopPick() {
  if (!S.pick) return;
  S.pick = null;
  renderProps();
  scheduleRegen(0);
}

function refsToSelection(f) {
  if (!S.pick || !f) return [];
  const b = S.bodies.model.find(x => x.id === f.params.target);
  if (!b) return [];
  const key = S.pick.kind;
  const list = key === 'edges' ? b.edges : b.faces;
  const out = [];
  for (const r of f.params[key] || []) {
    let best = -1, bd = Infinity;
    list.forEach((e, i) => { const d = Math.hypot(e.ref[0] - r[0], e.ref[1] - r[1], e.ref[2] - r[2]); if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && bd < 1e-3 * Math.max(1, diag(b))) out.push({ bodyId: b.id, kind: key === 'edges' ? 'edge' : 'face', index: best });
  }
  return out;
}

function diag(b) {
  const [lo, hi] = b.props.bbox;
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

function onPickRef(hit) {
  const f = feature(S.editing.id);
  const key = S.pick.kind;
  const want = key === 'edges' ? 'edge' : 'face';
  if (!hit || hit.kind !== want) return;
  if (!f.params.target || f.params.target !== hit.bodyId) {
    if (f.params[key]?.length && f.params.target && f.params.target !== hit.bodyId) {
      toast(`All ${key} must be on one body - cleared the previous picks.`);
    }
    f.params.target = hit.bodyId;
    f.params[key] = [];
  }
  const ref = refOf(hit);
  const list = f.params[key];
  const i = refsToSelection(f).findIndex(s => s.index === hit.index);
  if (i >= 0) list.splice(i, 1);
  else list.push(ref);
  renderProps();
  syncSelectionToViewer();
}

// ---------------------------------------------------------------------------
// viewport interaction
// ---------------------------------------------------------------------------

viewer.onPick = (hit, e) => {
  if (S.measuring) return onMeasure(hit);
  if (analysis.picking() && !S.editing) return analysis.onPick(hit);
  if (S.pick && S.editing) return onPickRef(hit);
  if (!hit) { S.selection = []; }
  else {
    const same = s => s.bodyId === hit.bodyId && s.kind === hit.kind && s.index === hit.index;
    const exists = S.selection.some(same);
    if (e.shiftKey || e.ctrlKey || e.metaKey) S.selection = exists ? S.selection.filter(s => !same(s)) : [...S.selection, hit];
    else S.selection = exists && S.selection.length === 1 ? [] : [hit];
  }
  syncSelectionToViewer();
  renderBodies();
  renderInfo();
};

viewer.onHover = hit => {
  const el = $('#hoverInfo');
  if (!hit) { el.textContent = ''; return; }
  const b = currentBodies().find(x => x.id === hit.bodyId);
  const name = b?.name || hit.bodyId;
  if (hit.kind === 'face') el.textContent = `${name} · face ${hit.index} · ${fmt(b?.faces[hit.index]?.area)} mm²`;
  else if (hit.kind === 'edge') el.textContent = `${name} · edge ${hit.index} · ${fmt(b?.edges[hit.index]?.length)} mm`;
  else if (hit.kind === 'point') el.textContent = `${name} · (${hit.point.map(v => fmt(v, 2)).join(', ')})`;
  else el.textContent = name;
};

function currentBodies() { return S.bodies[S.mode]; }

function syncSelectionToViewer() {
  if (S.pick && S.editing) viewer.setSelection(refsToSelection(feature(S.editing.id)));
  else viewer.setSelection(S.selection.filter(s => currentBodies().some(b => b.id === s.bodyId)));
}

function setSelButtons(mode) {
  $$('#selMode button').forEach(b => b.classList.toggle('on', b.dataset.sel === mode));
}

$('#selMode').addEventListener('click', e => {
  const m = e.target.dataset.sel;
  if (!m) return;
  if (S.measuring) toggleMeasure(false);
  setSelButtons(m);
  viewer.setMode(m);
  S.selection = S.selection.filter(s => s.kind === m);
  syncSelectionToViewer();
  renderInfo();
});

$('#dispMode').addEventListener('click', e => {
  const m = e.target.dataset.disp;
  if (!m) return;
  $$('#dispMode button').forEach(b => b.classList.toggle('on', b === e.target));
  viewer.setDisplay({ edges: m === 'shaded-edges' || m === 'xray', wire: m === 'wire', xray: m === 'xray' });
});

$('.views').addEventListener('click', e => {
  const v = e.target.dataset.view;
  if (v === 'fit') viewer.fit(); else if (v) viewer.view(v);
});

// measure: two surface points -> distance
function toggleMeasure(on = !S.measuring) {
  S.measuring = on;
  S.measure = [];
  viewer.setMeasure([]);
  viewer.setMode(on ? 'point' : ($('#selMode .on')?.dataset.sel || 'body'));
  $('#measureLabel').hidden = true;
  renderRibbonState();
  renderInfo();
}

function onMeasure(hit) {
  if (!hit) return;
  if (S.measure.length >= 2) S.measure = [];
  S.measure.push(hit.point);
  viewer.setMeasure(S.measure);
  renderInfo();
}

function placeMeasureLabel() {
  const el = $('#measureLabel');
  if (S.measuring && S.measure.length === 2) {
    const [a, b] = S.measure;
    const m = a.map((v, i) => (v + b[i]) / 2);
    const p = viewer.toScreen(m);
    el.hidden = p.behind;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.textContent = fmt(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])) + ' mm';
  } else el.hidden = true;
  requestAnimationFrame(placeMeasureLabel);
}
placeMeasureLabel();

// section plane
function toggleSection(on = !viewer.section.on) {
  viewer.setSection({ on });
  $('#sectionCtl').hidden = !on;
  renderRibbonState();
}
$('#secAxis').addEventListener('click', e => {
  const ax = e.target.dataset.ax;
  if (!ax) return;
  $$('#secAxis button').forEach(b => b.classList.toggle('on', b === e.target));
  viewer.setSection({ axis: ax });
});
$('#secT').addEventListener('input', e => viewer.setSection({ t: +e.target.value }));
$('#secFlip').addEventListener('click', () => viewer.setSection({ flip: !viewer.section.flip }));
$('#secClose').addEventListener('click', () => toggleSection(false));

// ---------------------------------------------------------------------------
// rendering: ribbon, tree, bodies, properties, inspect
// ---------------------------------------------------------------------------

const RIBBON = [
  ['Sketch', [['extrude', 'Extrude'], ['revolve', 'Revolve']]],
  ['Primitives', [['box', 'Box'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere'], ['cone', 'Cone'], ['torus', 'Torus'], ['pyramid', 'Pyramid']]],
  ['Combine', [['union', 'Union', 'boolean', { op: 'union' }], ['difference', 'Subtract', 'boolean', { op: 'difference' }], ['intersection', 'Intersect', 'boolean', { op: 'intersection' }]]],
  ['Modify', [['fillet', 'Fillet', 'fillet', { kind: 'fillet' }], ['chamfer', 'Chamfer', 'fillet', { kind: 'chamfer' }], ['shell', 'Shell'], ['offset', 'Offset']]],
  ['Transform', [['move', 'Move'], ['copy', 'Copy'], ['pattern', 'Pattern']]],
  ['Inspect', [['measure', 'Measure', '@measure'], ['section', 'Section', '@section']]],
  ['Simulate', [['analyze', 'Analyze', '@analyze']]],
];

function renderRibbon() {
  $('#ribbon').innerHTML = RIBBON.map(([g, items]) => `
    <div class="rgroup"><div class="items">${items.map(([ic, label, type, preset]) =>
      `<button class="rbtn" data-type="${type || ic}" data-preset='${preset ? JSON.stringify(preset) : ''}' data-ic="${ic}" title="${label}">${icon(ic, 22)}<span>${label}</span></button>`).join('')}
    </div><div class="glabel">${g}</div></div>`).join('');
}

function renderRibbonState() {
  $$('.rbtn').forEach(b => {
    if (b.dataset.type === '@measure') b.classList.toggle('on', S.measuring);
    if (b.dataset.type === '@section') b.classList.toggle('on', viewer.section.on);
    if (b.dataset.type === '@analyze') b.classList.toggle('on', analysis.isOn());
  });
}

$('#ribbon').addEventListener('click', e => {
  const b = e.target.closest('.rbtn');
  if (!b) return;
  const t = b.dataset.type;
  if (t === '@measure') return toggleMeasure();
  if (t === '@section') return toggleSection();
  if (t === '@analyze') { if (S.measuring) toggleMeasure(false); return analysis.toggle(); }
  if (S.measuring) toggleMeasure(false);
  const preset = b.dataset.preset ? JSON.parse(b.dataset.preset) : {};
  const needsBodies = FEATURES[t].fields.filter(f => f.type === 'body').length;
  const live = liveBodiesBefore(S.doc.features, S.doc.features.length);
  if (needsBodies && live.length < needsBodies) {
    return toast(needsBodies === 2 ? 'A boolean needs two bodies - create another body first.' : 'Create a body first.', true);
  }
  addFeature(t, preset);
});

const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a10.6 10.6 0 0 0 5.4-1.4"/></svg>';
const UP = '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

function renderTree() {
  const feats = S.doc.features;
  $('#featCount').textContent = feats.length ? feats.length : '';
  const rollIdx = S.pick && S.editing ? feats.findIndex(f => f.id === S.editing.id) : -1;
  $('#tree').innerHTML = feats.map((f, i) => {
    const st = S.status[f.id];
    const state = f.suppressed ? 'suppressed' : (st?.state || 'pending');
    const cls = [S.treeSel === f.id && 'on', S.editing?.id === f.id && 'editing', f.suppressed && 'suppressed'].filter(Boolean).join(' ');
    const rolled = rollIdx >= 0 && i >= rollIdx;
    return `<li data-id="${f.id}" class="${cls}" style="${rolled && i > rollIdx ? 'opacity:.4' : ''}" title="${esc(FEATURES[f.type].label)}">
      ${featureIcon(f)}<span class="nm">${esc(f.name)}</span>
      <span class="acts">
        <button data-a="up" title="Move up">${UP}</button><button data-a="down" title="Move down">${DOWN}</button>
        <button data-a="sup" title="${f.suppressed ? 'Unsuppress' : 'Suppress'}">${f.suppressed ? EYE_OFF : EYE}</button>
        <button data-a="del" title="Delete">${TRASH}</button>
      </span>
      <span class="st ${state}" title="${state}"></span></li>
      ${state === 'error' && st?.error ? `<li class="err-msg">${esc(st.error)}</li>` : ''}`;
  }).join('') + (feats.length ? '' : '<div class="end">No features yet.</div>');
}

$('#tree').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  const a = e.target.closest('button')?.dataset.a;
  if (a === 'up') return moveFeature(id, -1);
  if (a === 'down') return moveFeature(id, 1);
  if (a === 'sup') return toggleSuppress(id);
  if (a === 'del') return deleteFeature(id);
  editFeature(id);
});

function renderBodies() {
  const list = currentBodies();
  const selected = new Set(S.selection.map(s => s.bodyId));
  $('#bodyList').innerHTML = list.length ? list.map(b => `
    <li data-id="${b.id}" class="${selected.has(b.id) ? 'on' : ''}">
      <input type="color" value="${S.colors[b.id] || '#9aa7b8'}" title="Body color">
      <span class="nm">${esc(b.name)}</span>
      <span class="muted">${b.props.manifold ? '' : 'sheet'}</span>
      <button class="eye" title="Show/hide">${S.hidden.has(b.id) ? EYE_OFF : EYE}</button>
    </li>`).join('') : '<div class="empty-b">No bodies.</div>';
}

$('#bodyList').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (!li || e.target.type === 'color') return;
  const id = li.dataset.id;
  if (e.target.closest('.eye')) {
    S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id);
    viewer.setHidden(S.hidden);
    return renderBodies();
  }
  S.selection = [{ bodyId: id, kind: 'body', index: 0 }];
  setSelButtons('body'); viewer.setMode('body');
  syncSelectionToViewer(); renderBodies(); renderInfo();
});
$('#bodyList').addEventListener('input', e => {
  if (e.target.type !== 'color') return;
  const id = e.target.closest('li').dataset.id;
  S.colors[id] = e.target.value;
  viewer.setColor(id, e.target.value);
  persist();
});

function bodyLabel(id) {
  const f = feature(id);
  return f ? f.name : id;
}

function renderProps() {
  const host = $('#props');
  const f = S.editing && feature(S.editing.id);
  if (!f && analysis.isOn()) {
    $('#propTitle').textContent = 'Analyze';
    analysis.render();
    return;
  }
  if (!f) {
    $('#propTitle').textContent = 'Properties';
    host.innerHTML = `<div class="empty-p">Add a feature from the toolbar, or click one in the history to edit it.<br><br>
      Tip: select edges (Edge filter) before pressing <b>Fillet</b>, or two bodies before a boolean, to pre-fill it.</div>`;
    return;
  }
  const def = FEATURES[f.type];
  $('#propTitle').textContent = (S.editing.isNew ? 'New ' : 'Edit ') + def.label;
  const idx = S.doc.features.indexOf(f);
  const live = liveBodiesBefore(S.doc.features, idx);
  const st = S.status[f.id];
  const rows = visibleFields(f.type, f.params).map(fd => {
    const v = f.params[fd.k];
    const id = 'p_' + fd.k;
    switch (fd.type) {
      case 'num':
        return `<div class="field"><label for="${id}">${fd.label}</label><input id="${id}" data-k="${fd.k}" data-t="num" type="number" step="${fd.step || 'any'}" value="${v ?? ''}"></div>`;
      case 'sel':
        return `<div class="field"><label for="${id}">${fd.label}</label><select id="${id}" data-k="${fd.k}">${fd.opts.map(([ov, ol]) => `<option value="${ov}" ${ov === v ? 'selected' : ''}>${ol}</option>`).join('')}</select></div>`;
      case 'bool':
        return `<div class="field check"><label for="${id}">${fd.label}</label><input id="${id}" data-k="${fd.k}" data-t="bool" type="checkbox" ${v ? 'checked' : ''}></div>`;
      case 'text':
        return `<div class="field wide"><label for="${id}">${fd.label}</label><textarea id="${id}" data-k="${fd.k}" spellcheck="false">${esc(v ?? '')}</textarea></div>`;
      case 'info':
        return `<div class="field"><label>${fd.label}</label><span>${esc(v ?? '—')}</span></div>`;
      case 'body': {
        const opts = live.includes(v) || !v ? live : [v, ...live];
        return `<div class="field"><label for="${id}">${fd.label}</label><select id="${id}" data-k="${fd.k}">
          <option value="">— choose —</option>${opts.map(b => `<option value="${b}" ${b === v ? 'selected' : ''}>${esc(bodyLabel(b))}</option>`).join('')}</select></div>`;
      }
      case 'edges': case 'faces': {
        const n = (v || []).length;
        const active = S.pick?.kind === fd.type;
        const noun = fd.type === 'edges' ? 'edge' : 'face';
        return `<div class="field"><label>${fd.label}</label><div class="pick ${active ? 'active' : ''}" data-pick="${fd.type}">
          <span class="cnt">${active ? `Picking… ${n} ${noun}${n === 1 ? '' : 's'}` : n ? `${n} ${noun}${n === 1 ? '' : 's'}` : `All / none`}</span>
          ${n ? `<button data-clear="${fd.k}">Clear</button>` : ''}
          <button data-pickbtn="${fd.type}">${active ? 'Done' : 'Pick'}</button></div></div>`;
      }
    }
    return '';
  }).join('');
  host.innerHTML = `
    <input class="nameedit" id="featName" value="${esc(f.name)}" spellcheck="false" aria-label="Feature name">
    ${def.hint ? `<div class="hint">${def.hint}</div>` : ''}
    ${S.pick ? `<div class="hint" style="color:var(--sel)">Model rolled back to before this feature. Click ${S.pick.kind} to toggle them, then press Done.</div>` : ''}
    ${rows}
    ${st?.state === 'error' ? `<div class="feat-err">${esc(st.error)}</div>` : ''}
    <div class="prop-actions">
      <button class="btn" id="btnCancel">Cancel</button>
      <button class="btn primary" id="btnOk">${S.editing.isNew ? 'Create' : 'OK'}</button>
    </div>
    ${st?.code ? `<details class="code"><summary>usd_brep code</summary><pre>${esc(st.code)}</pre></details>` : ''}`;
}

$('#props').addEventListener('input', e => {
  const f = S.editing && feature(S.editing.id);
  if (!f) return;
  if (e.target.id === 'featName') { f.name = e.target.value; renderTree(); return; }
  const k = e.target.dataset.k;
  if (!k) return;
  const fd = FEATURES[f.type].fields.find(x => x.k === k);
  let v = e.target.value;
  if (e.target.dataset.t === 'num') {
    if (v === '' || !isFinite(+v)) { e.target.classList.add('bad'); return; }
    v = +v;
    if (fd.min !== undefined && v < fd.min) { e.target.classList.add('bad'); return; }
    e.target.classList.remove('bad');
  }
  if (e.target.dataset.t === 'bool') v = e.target.checked;
  const prevVisible = visibleFields(f.type, f.params).map(x => x.k).join();
  if (fd.type === 'body' && k === 'target' && v !== f.params.target) {
    if (f.params.edges) f.params.edges = [];
    if (f.params.faces) f.params.faces = [];
  }
  setParam(f, k, v);
  if (visibleFields(f.type, f.params).map(x => x.k).join() !== prevVisible || e.target.tagName === 'SELECT') renderProps();
});

$('#props').addEventListener('click', e => {
  const f = S.editing && feature(S.editing.id);
  if (!f) return;
  if (e.target.id === 'btnOk') return finishEdit();
  if (e.target.id === 'btnCancel') return S.editing.isNew ? deleteFeature(f.id) : cancelEdit();
  const clear = e.target.dataset.clear;
  if (clear) { f.params[clear] = []; renderProps(); syncSelectionToViewer(); if (!S.pick) scheduleRegen(); return; }
  const pb = e.target.closest('[data-pickbtn],[data-pick]');
  if (pb) {
    const kind = pb.dataset.pickbtn || pb.dataset.pick;
    if (S.pick?.kind === kind) { if (e.target.dataset.pickbtn) stopPick(); }
    else startPick(kind);
  }
});

function renderInfo() {
  const host = $('#info');
  const bodies = currentBodies();
  if (S.measuring) {
    const [a, b] = S.measure;
    host.innerHTML = `<h4>Measure distance</h4>${!a ? '<div class="muted">Click a point on the model.</div>' : !b ? '<div class="muted">Click a second point.</div>' : `
      <dl><dt>Distance</dt><dd>${fmt(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))}</dd>
      <dt>ΔX</dt><dd>${fmt(b[0] - a[0])}</dd><dt>ΔY</dt><dd>${fmt(b[1] - a[1])}</dd><dt>ΔZ</dt><dd>${fmt(b[2] - a[2])}</dd></dl>`}`;
    return;
  }
  const sel = S.selection.filter(s => bodies.some(b => b.id === s.bodyId));
  const bodyById = id => bodies.find(b => b.id === id);
  if (!sel.length) {
    if (!bodies.length) { host.innerHTML = '<div class="muted">Nothing to inspect yet.</div>'; return; }
    const tv = bodies.reduce((s, b) => s + (b.props.volume || 0), 0);
    const ta = bodies.reduce((s, b) => s + (b.props.area || 0), 0);
    host.innerHTML = `<h4>Model</h4><dl><dt>Bodies</dt><dd>${bodies.length}</dd><dt>Volume</dt><dd>${fmt(tv, 2)} mm³</dd><dt>Surface area</dt><dd>${fmt(ta, 2)} mm²</dd>
      <dt>Mass</dt><dd>${fmt(tv * S.density / 1000, 2)} g</dd></dl>${densityInput()}<div class="muted" style="margin-top:10px">Select a body, face or edge for details.</div>`;
    return;
  }
  if (sel.length === 1 && sel[0].kind === 'body') {
    const b = bodyById(sel[0].bodyId), p = b.props;
    const [lo, hi] = p.bbox;
    host.innerHTML = `<h4>${esc(b.name)} <span class="tag ${p.manifold ? 'ok' : 'bad'}">${p.manifold ? 'closed solid' : 'open / sheet'}</span></h4>
      <dl><dt>Volume</dt><dd>${fmt(p.volume, 2)} mm³</dd><dt>Surface area</dt><dd>${fmt(p.area, 2)} mm²</dd>
      <dt>Mass</dt><dd>${p.volume ? fmt(p.volume * S.density / 1000, 2) + ' g' : '—'}</dd>
      <dt>Size X × Y × Z</dt><dd>${fmt(hi[0] - lo[0], 2)} × ${fmt(hi[1] - lo[1], 2)} × ${fmt(hi[2] - lo[2], 2)}</dd>
      <dt>Min</dt><dd>${lo.map(v => fmt(v, 2)).join(', ')}</dd><dt>Max</dt><dd>${hi.map(v => fmt(v, 2)).join(', ')}</dd>
      <dt>Faces / edges / verts</dt><dd>${p.faces} / ${p.edges} / ${p.vertices}</dd>
      <dt>Triangles</dt><dd>${b.triFace.length.toLocaleString()}</dd></dl>${densityInput()}
      ${b.warnings?.length ? `<div class="feat-err">${b.warnings.map(esc).join('<br>')}</div>` : ''}`;
    return;
  }
  const faces = sel.filter(s => s.kind === 'face'), edges = sel.filter(s => s.kind === 'edge');
  let h = '';
  if (faces.length) {
    const areas = faces.map(s => bodyById(s.bodyId).faces[s.index]?.area || 0);
    h += `<h4>${faces.length === 1 ? `Face ${faces[0].index}` : `${faces.length} faces`}</h4><dl><dt>Area</dt><dd>${fmt(areas.reduce((a, b) => a + b, 0), 3)} mm²</dd>
      ${faces.length === 1 ? `<dt>Body</dt><dd>${esc(bodyById(faces[0].bodyId).name)}</dd><dt>Point</dt><dd>${bodyById(faces[0].bodyId).faces[faces[0].index].ref.map(v => fmt(v, 2)).join(', ')}</dd>` : ''}</dl>`;
  }
  if (edges.length) {
    const lens = edges.map(s => bodyById(s.bodyId).edges[s.index]?.length || 0);
    h += `<h4 style="margin-top:8px">${edges.length === 1 ? `Edge ${edges[0].index}` : `${edges.length} edges`}</h4><dl><dt>Length</dt><dd>${fmt(lens.reduce((a, b) => a + b, 0), 3)} mm</dd>
      ${edges.length === 1 ? `<dt>Body</dt><dd>${esc(bodyById(edges[0].bodyId).name)}</dd><dt>Midpoint</dt><dd>${bodyById(edges[0].bodyId).edges[edges[0].index].ref.map(v => fmt(v, 2)).join(', ')}</dd>` : ''}</dl>
      <div class="muted" style="margin-top:8px">Press <b>Fillet</b> or <b>Chamfer</b> to round these.</div>`;
  }
  const bs = sel.filter(s => s.kind === 'body');
  if (bs.length > 1) {
    h += `<h4>${bs.length} bodies</h4><dl><dt>Total volume</dt><dd>${fmt(bs.reduce((s, x) => s + (bodyById(x.bodyId).props.volume || 0), 0), 2)} mm³</dd></dl>
      <div class="muted" style="margin-top:8px">Press a <b>Combine</b> tool: the first selected body is the target.</div>`;
  }
  host.innerHTML = h;
}

function densityInput() {
  return `<label class="density">Density <input type="number" id="density" step="0.01" min="0" value="${S.density}"> g/cm³</label>`;
}
$('#info').addEventListener('input', e => {
  if (e.target.id === 'density' && +e.target.value >= 0) {
    S.density = +e.target.value;
    persist();
    const pos = e.target.selectionStart;
    renderInfo();
    const d = $('#density'); d.focus(); try { d.setSelectionRange(pos, pos); } catch {}
  }
});

function renderTopbar() {
  $('#btnUndo').disabled = !S.undo.length;
  $('#btnRedo').disabled = !S.redo.length;
}

function renderAll() {
  renderTree();
  renderProps();
  renderBodies();
  renderInfo();
  renderTopbar();
  syncSelectionToViewer();
  $('#emptyHint').hidden = S.mode === 'script' || S.doc.features.length > 0;
}

// ---------------------------------------------------------------------------
// script mode
// ---------------------------------------------------------------------------

let cm = null;
function initEditor() {
  cm = CodeMirror($('#editor'), {
    value: S.script, mode: 'python', lineNumbers: true, indentUnit: 4, tabSize: 4,
    matchBrackets: true, extraKeys: {
      'Ctrl-Enter': runScript, 'Cmd-Enter': runScript,
      Tab: c => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('    '),
      'Ctrl-Space': c => c.showHint({ hint: hintSm, completeSingle: false }),
    },
  });
  cm.on('change', () => { S.script = cm.getValue(); persistSoon(); });
  cm.on('inputRead', (c, ch) => { if (ch.text[0] === '.' || /\w/.test(ch.text[0])) maybeHint(c); });
}

function maybeHint(c) {
  const cur = c.getCursor();
  const line = c.getLine(cur.line).slice(0, cur.ch);
  if (/\b(sm|usd_brep)(\.\w+)?\.\w*$/.test(line)) c.showHint({ hint: hintSm, completeSingle: false });
}

function hintSm(c) {
  if (!S.names) return null;
  const cur = c.getCursor();
  const line = c.getLine(cur.line).slice(0, cur.ch);
  const m = line.match(/\b(?:sm|usd_brep)\.(?:(\w+)\.)?(\w*)$/);
  if (!m) return null;
  const pool = m[1] ? (S.names.subs[m[1]] || []) : S.names.top;
  const word = m[2];
  const list = pool.filter(n => n.toLowerCase().startsWith(word.toLowerCase())).slice(0, 60)
    .map(n => ({ text: n, displayText: !m[1] && S.names.sigs[n] ? S.names.sigs[n].replace(/usd_brep\._omni_solid\./g, '').slice(0, 110) : n }));
  return { list, from: CodeMirror.Pos(cur.line, cur.ch - word.length), to: cur };
}

let errMark = null;
async function runScript() {
  if (errMark !== null) { cm.removeLineClass(errMark, 'background', 'cm-errline'); errMark = null; }
  const con = $('#console');
  $('#busy').hidden = false;
  const t0 = performance.now();
  try {
    const res = await api('/api/script', { code: cm.getValue(), quality: 'normal' });
    const ms = Math.round(performance.now() - t0);
    S.bodies.script = res.bodies;
    for (const b of res.bodies) S.colors[b.id] = b.color || S.colors[b.id] || PALETTE[(+b.id.slice(1) + 1) % PALETTE.length];
    if (S.mode === 'script') { const refit = !viewer.bodies.size; showBodies(res.bodies); if (refit) viewer.fit(); }
    let out = res.stdout ? esc(res.stdout) : '';
    if (res.error) {
      out += `<span class="err">${esc(res.error.message)}${res.error.line ? ` (line ${res.error.line})` : ''}</span>\n`;
      if (res.error.line) { errMark = res.error.line - 1; cm.addLineClass(errMark, 'background', 'cm-errline'); }
      setKernel('warn', 'Script failed');
    } else setKernel('ok', `Script ran in ${ms} ms · ${res.bodies.length} bod${res.bodies.length === 1 ? 'y' : 'ies'}`);
    out += `<span class="${res.error ? 'err' : 'ok'}">— ${res.error ? 'stopped' : 'done'} in ${ms} ms, ${res.bodies.length} bod${res.bodies.length === 1 ? 'y' : 'ies'} shown</span>\n`;
    con.innerHTML += out;
    con.scrollTop = con.scrollHeight;
    renderInfo();
  } catch (e) {
    con.innerHTML += `<span class="err">${esc(e.message)}</span>\n`;
    setKernel('bad', e.message);
  } finally { $('#busy').hidden = true; }
}

$('#btnRun').addEventListener('click', runScript);
$('#btnClearOut').addEventListener('click', () => { $('#console').innerHTML = ''; });
$('#btnFromHistory').addEventListener('click', async () => {
  if (!S.doc.features.length) return toast('The feature history is empty.');
  try {
    const { code } = await api('/api/codegen', { doc: S.doc });
    if (cm.getValue().trim() && cm.getValue() !== S.lastGenerated && !confirm('Replace the current script with code generated from the feature history?')) return;
    S.lastGenerated = code;
    cm.setValue(code);
    await runScript();
    viewer.fit();
  } catch (e) { toast(e.message, true); }
});

function setMode(mode) {
  if (mode === S.mode) return;
  if (S.editing) finishEdit();
  if (S.measuring) toggleMeasure(false);
  if (analysis.isOn()) analysis.toggle(false);
  S.mode = mode;
  document.body.classList.toggle('script-mode', mode === 'script');
  $$('.modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#treePanel').hidden = mode === 'script';
  $('#scriptPanel').hidden = mode !== 'script';
  if (mode === 'script') {
    if (!cm) initEditor();
    setTimeout(() => cm.refresh(), 0);
    if (!S.bodies.script.length) runScript();
  }
  S.selection = [];
  showBodies(currentBodies());
  viewer.fit();
  renderAll();
  persist();
}
$$('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------------------------------------------------------------------------
// files: save / open / import / export
// ---------------------------------------------------------------------------

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportAs(format) {
  const name = (S.doc.name || 'model').trim();
  try {
    setKernel('warn', 'Exporting…');
    const r = await api('/api/export', { format, doc: S.doc, code: cm?.getValue() ?? S.script, mode: S.mode, name }, true);
    const cd = r.headers.get('content-disposition') || '';
    const fname = decodeURIComponent((cd.match(/filename\*?=(?:utf-8'')?"?([^";]+)/i) || [])[1] || `${name}.usda`);
    download(await r.blob(), fname);
    setKernel('ok', `Exported ${fname}`);
  } catch (e) { setKernel('bad', e.message); toast(e.message, true); }
}

function saveProject() {
  if (S.editing) finishEdit();
  const data = { format: 'scriptcad/1', doc: S.doc, script: cm?.getValue() ?? S.script, colors: S.colors };
  download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${(S.doc.name || 'part').replace(/[^\w.-]+/g, '_')}.scad.json`);
}

function loadProject(data) {
  if (S.editing) S.editing = null;
  const before = snap();
  S.doc = data.doc || data;
  if (!Array.isArray(S.doc.features)) throw new Error('not a ScriptCAD project');
  S.colors = data.colors || {};
  if (data.script) { S.script = data.script; cm?.setValue(data.script); }
  S.undo.push(before);
  S.selection = [];
  firstFit = true;
  analysis.reset();
  afterDocSwap();
}

$('#fileOpen').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { loadProject(JSON.parse(await file.text())); toast(`Opened ${file.name}`); } catch (err) { toast('Could not open: ' + err.message, true); }
});

$('#fileUsd').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const isStep = /\.(step|stp)$/i.test(file.name);
    setKernel('warn', `Importing ${file.name}…`);
    $('#busy').hidden = false;
    // the first STEP import downloads the converters (~46 MB), so say so if it takes a while
    const slow = isStep && setTimeout(() => setKernel('warn', `Importing ${file.name}… (first STEP import downloads the converters, ~46 MB)`), 4000);
    const r = await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }).finally(() => { clearTimeout(slow); $('#busy').hidden = true; });
    const res = await r.json();
    if (!r.ok) throw new Error(res.detail);
    if (S.mode !== 'model') setMode('model');
    if (S.editing) finishEdit();
    const before = snap();
    for (const b of res.bodies) {
      S.doc.features.push({ id: uid(), type: 'import', name: b.name, params: { file: b.path, file_name: res.name, index: b.index } });
    }
    commit(before);
    firstFit = true;
    renderAll();
    scheduleRegen(0);
    const n = res.bodies.length;
    toast(`Imported ${n} bod${n === 1 ? 'y' : 'ies'} from ${res.name}` + (res.warnings.length ? ` - ${res.warnings.join('; ')}` : ''), res.warnings.length > 0);
  } catch (err) { setKernel('bad', err.message); toast(err.message, true); }
});

async function loadExample(file = 'example.json', { analyze = false } = {}) {
  const data = await (await fetch(file)).json();
  if (S.mode !== 'model') setMode('model');
  loadProject({ doc: data });
  // simulation examples open straight into Analyze, which runs every prepared body
  if (analyze && !analysis.isOn()) analysis.toggle(true);
}

function newPart() {
  if (S.doc.features.length && !confirm('Start a new part? (You can undo this.)')) return;
  loadProject({ doc: { name: 'Untitled part', features: [] } });
  viewer.setBodies([]);
}

const ACTIONS = {
  new: newPart, example: () => loadExample(), save: saveProject,
  'example-bridges': () => loadExample('examples/bridges.json', { analyze: true }),
  open: () => $('#fileOpen').click(), import: () => $('#fileUsd').click(),
  'exp-usd-brep': () => exportAs('usd-brep'), 'exp-usdc': () => exportAs('usdc'),
  'exp-usd-mesh': () => exportAs('usd-mesh'), 'exp-stl': () => exportAs('stl'),
  'exp-step': () => exportAs('step'),
  png: () => fetch(viewer.screenshot()).then(r => r.blob()).then(b => download(b, `${S.doc.name || 'view'}.png`)),
};

$('#btnFile').addEventListener('click', e => { e.stopPropagation(); $('#fileMenu').classList.toggle('open'); });
document.addEventListener('click', e => {
  if (!e.target.closest('.menu')) $('#fileMenu').classList.remove('open');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act && ACTIONS[act]) { $('#fileMenu').classList.remove('open'); ACTIONS[act](); }
});
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#docName').addEventListener('change', e => { const b = snap(); S.doc.name = e.target.value; commit(b); });

// ---------------------------------------------------------------------------
// keyboard, persistence, layout
// ---------------------------------------------------------------------------

document.addEventListener('keydown', e => {
  const typing = e.target.closest('input, textarea, select, .CodeMirror');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return saveProject(); }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); return ACTIONS.open(); }
  if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); return ACTIONS.import(); }
  if (typing) {
    if (e.key === 'Enter' && e.target.closest('.props') && e.target.tagName !== 'TEXTAREA') { e.target.blur(); finishEdit(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  if (e.key === 'Escape') {
    if (S.measuring) return toggleMeasure(false);
    if (analysis.picking()) return analysis.stopPick();
    if (S.pick) return stopPick();
    if (S.editing) return S.editing.isNew ? deleteFeature(S.editing.id) : cancelEdit();
    S.selection = []; syncSelectionToViewer(); renderInfo(); renderBodies();
    return;
  }
  if (e.key === 'Enter' && S.editing) return finishEdit();
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.mode === 'model' && (S.editing || S.treeSel)) return deleteFeature(S.editing?.id || S.treeSel);
  if (e.key === 'f' || e.key === 'F') return viewer.fit();
  if (['1', '2', '3'].includes(e.key)) {
    const m = ['body', 'face', 'edge'][+e.key - 1];
    $(`#selMode [data-sel=${m}]`).click();
  }
  if (e.key === 'm') toggleMeasure();
});

let persistTimer = null;
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 600); }
function persist() {
  try {
    localStorage.setItem('scriptcad', JSON.stringify({ doc: S.doc, script: cm?.getValue() ?? S.script, colors: S.colors, mode: S.mode, density: S.density }));
  } catch {}
}
function restore() {
  try {
    const d = JSON.parse(localStorage.getItem('scriptcad') || 'null');
    if (!d) return null;
    if (d.doc?.features) S.doc = d.doc;
    if (typeof d.script === 'string') S.script = d.script;
    S.colors = d.colors || {};
    if (d.density) S.density = d.density;
    return d;
  } catch { return null; }
}

// resizable left pane
(() => {
  const rz = $('#resizer');
  rz.addEventListener('pointerdown', e => {
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('drag');
    const move = ev => document.querySelector('.work').style.setProperty('--left', Math.max(200, Math.min(ev.clientX, window.innerWidth - 420)) + 'px');
    const up = () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); cm?.refresh(); };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up);
  });
})();

let toastTimer = null;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2600);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

renderRibbon();
const saved = restore();
$('#docName').value = S.doc.name;
renderAll();

(async () => {
  try {
    const info = await api('/api/info');
    $('#kernelTag').textContent = `USD BRep ${info.usd_brep} · SMLib`;
    setKernel('ok', 'Kernel ready');
    api('/api/names').then(n => { S.names = n; }).catch(() => {});
  } catch (e) {
    setKernel('bad', 'Kernel unavailable: ' + e.message);
    return;
  }
  if (saved?.mode === 'script') setMode('script');
  if (S.doc.features.length) scheduleRegen(0);
})();
