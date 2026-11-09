// VR mode (WebXR): stand next to the model and push on it.
//
// The viewer's `world` group (model space: mm, Z up) is scaled to metres and turned upright,
// so the model stands on a table or your floor about 0.9 m in front of you (small parts
// enlarged). A switch in front of the table picks what a pinch on the part does: PUSH (hold:
// Push to load, push.js, straight into the surface, the trigger depth setting the force up to
// the panel's Max force) or PULL (move your hand: the face follows its variable, pull.js).
// Each controller or hand casts a ray in the mode's colour, with a cursor on the part showing
// the mode; hands are drawn as their tracked joints. A pinch beside the part, or a
// controller's grip button, picks the model up. A floating panel shows force, deflection and
// stress, and while pulling the value and what it does to mass, deflection and stress.

import * as THREE from 'three';
import { describe } from './pull.js';

export function createVR({ viewer, analysis, button, toast }) {
  const xr = viewer.renderer.xr;
  xr.enabled = true;
  xr.setReferenceSpaceType('local-floor');
  const ray = new THREE.Raycaster();
  let session = null, floor = null, table = null, label = null, panel = null, hint = '', zoom = 1;
  // what a pinch on the part does; each mode has its colour (the desktop's arrows: yellow push, blue pull)
  let mode = 'push';
  const MODES = { push: { color: 0xffd23f, css: '#ffd23f' }, pull: { color: 0x9fd2ff, css: '#9fd2ff' }, tap: { color: 0xc58bff, css: '#c58bff' }, auto: { color: 0x5ad17a, css: '#5ad17a' },
                  ask: { color: 0xe6edf3, css: '#e6edf3' } };

  // ---- availability -------------------------------------------------------------
  (async () => {
    const ok = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    button.disabled = !ok;
    button.title = ok ? 'View the model at full size in VR; the trigger pushes on it' :
      'No VR headset found. Open ScriptCAD in a headset browser (Quest), or in Chrome with a PC headset connected.';
  })();

  // ---- hands: a ball on each tracked joint (the browser draws none in VR) ----------------
  // the thumb and index tips light up in the mode's colour while they pinch
  const hands = [0, 1].map(i => { const h = xr.getHand(i); viewer.scene.add(h); return h; });
  const ball = new THREE.SphereGeometry(1, 12, 8);
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9d3df, roughness: 0.55, transparent: true, opacity: 0.9 });
  const tips = Object.fromEntries(Object.entries(MODES).map(([k, m]) => [k, {
    off: new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.5 }),
    on: new THREE.MeshStandardMaterial({ color: m.color, emissive: m.color, emissiveIntensity: 0.8 }) }]));
  function handsFrame() {
    hands.forEach((h, i) => {
      for (const [name, j] of Object.entries(h.joints)) {
        let b = j.userData.ball;
        if (!b) { b = j.userData.ball = new THREE.Mesh(ball, skin); j.add(b); }
        b.scale.setScalar(j.jointRadius || 0.008);
        b.material = name === 'index-finger-tip' || name === 'thumb-tip' ? tips[mode][controllers[i].userData.down ? 'on' : 'off'] : skin;
      }
    });
  }

  // ---- a cursor where the ray meets the part: an arrow into it (push) or out and in (pull)
  function makeCursor() {
    const mat = () => new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, side: THREE.DoubleSide });
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 32).rotateX(-Math.PI / 2), mat());
    const cone = new THREE.ConeGeometry(0.4, 0.9, 16);                // tip +Y
    // a piece at height y along the normal, turned tip-down if `down`
    const at = (geo, m, y, down = false) => { const o = new THREE.Mesh(geo, m); o.position.y = y; if (down) o.rotation.x = Math.PI; return o; };
    const shaft = h => new THREE.CylinderGeometry(0.12, 0.12, h);
    const push = new THREE.Group(), pull = new THREE.Group(), m = mat(), m2 = mat();
    push.add(at(cone, m, 0.55, true), at(shaft(1.2), m, 1.6));
    pull.add(at(cone, m2, 2.05), at(cone, m2, 0.55, true), at(shaft(0.8), m2, 1.3));
    g.add(ring, push, pull);
    g.traverse(o => { o.renderOrder = 22; });
    g.scale.setScalar(0.012);
    g.visible = false;
    g.userData = { ring, push, pull, mats: [ring.material, m, m2] };
    return g;
  }
  const UP = new THREE.Vector3(0, 1, 0);
  function showCursor(cursor, hit) {
    cursor.visible = !!hit;
    if (!hit) return;
    const n = new THREE.Vector3(...hit.normal).transformDirection(viewer.world.matrixWorld);
    cursor.position.copy(viewer.world.localToWorld(new THREE.Vector3(...hit.point))).addScaledVector(n, 0.002);
    cursor.quaternion.setFromUnitVectors(UP, n);
    const { push, pull, mats } = cursor.userData;
    const ok = mode === 'push' ? analysis.push.canPush(hit.bodyId) : mode === 'tap' ? analysis.isOn() : analysis.pull.available();
    push.visible = mode !== 'pull';                                  // push and tap: an arrow into the surface
    pull.visible = mode === 'pull';
    for (const m of mats) m.color.set(ok ? MODES[mode].color : 0x6b7685);
  }

  // ---- the mode switch: two buttons on a tilted panel in front of the table ------------
  let panelHover = -1;
  function makePanel() {
    const canvas = document.createElement('canvas');
    canvas.width = 2548; canvas.height = 320;
    const tex = new THREE.CanvasTexture(canvas);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.125), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    m.userData = { canvas, tex };
    return m;
  }
  function drawPanel() {
    if (!panel) return;
    const { canvas, tex } = panel.userData, g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(13,17,23,0.88)';
    g.beginPath(); g.roundRect(0, 0, 2548, 320, 36); g.fill();
    const buttons = [
      ['push', 'PUSH', 'pinch and hold: load it', analysis.isOn() ? null : 'turn on Analyze first'],
      ['pull', 'PULL', 'pinch and move: resize it', analysis.pull.available() ? null : 'no variables to follow'],
      ['tap', 'TAP', 'pinch: hear it ring', analysis.isOn() ? null : 'turn on Analyze first'],
      ['auto', 'AUTO', analysis.rebalancing() ? 'pinch to stop' : 'stiffer at the same mass', analysis.pull.available() && analysis.isOn() ? null : 'needs variables and Analyze'],
      ['ask', 'VOICE', analysis.voice.recording() ? 'listening… let go' : 'hold, say a command', null],
    ];
    buttons.forEach(([k, title, how, off], i) => {
      const x = 24 + i * 500, on = k === 'auto' ? analysis.rebalancing() : k === 'ask' ? analysis.voice.recording() : mode === k, css = MODES[k].css;
      g.beginPath(); g.roundRect(x, 24, 476, 272, 26);
      if (on) { g.fillStyle = css; g.fill(); }
      g.lineWidth = panelHover === i ? 10 : 4;
      g.strokeStyle = on ? css : panelHover === i ? '#e6edf3' : 'rgba(159,180,204,0.5)';
      g.stroke();
      g.textAlign = 'center';
      g.fillStyle = on ? '#0d1117' : '#e6edf3';
      g.font = '700 104px system-ui, sans-serif';
      g.fillText(title, x + 238, 150);
      g.font = '500 40px system-ui, sans-serif';
      g.fillStyle = on ? 'rgba(13,17,23,0.8)' : '#9fb4cc';
      g.fillText(off ?? how, x + 238, 230);
    });
    tex.needsUpdate = true;
  }
  function setMode(k) {
    if (k === mode) return;
    mode = k;
    analysis.hints.show(mode === 'pull');                            // the arrows: where to pull
    for (const c of controllers) c.userData.line.material.color.set(MODES[mode].color);
    drawPanel();
    idle();
  }

  // ---- controllers: a ray each, trigger = push, grip (or a press beside the part) = move the model
  const controllers = [0, 1].map(i => {
    const c = xr.getController(i);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
                                new THREE.LineBasicMaterial({ color: MODES.push.color }));
    line.scale.z = 3;
    c.add(line);
    const cursor = makeCursor();
    viewer.scene.add(cursor);
    c.userData = { line, cursor, source: null, pushing: false };
    c.addEventListener('connected', e => { c.userData.source = e.data; });
    c.addEventListener('disconnected', () => { c.userData.source = null; c.userData.selecting = false; });
    // a pinch arrives as a gamepad button in the Quest browser, but some runtimes (Chrome over
    // Link) may only send select events for hands: take whichever comes
    c.addEventListener('selectstart', () => { c.userData.selecting = true; });
    c.addEventListener('selectend', () => { c.userData.selecting = false; });
    c.addEventListener('squeezestart', () => { if (!c.userData.pushing && viewer.world.parent === viewer.scene) c.attach(viewer.world); });
    c.addEventListener('squeezeend', () => { if (viewer.world.parent === c) viewer.scene.attach(viewer.world); });
    viewer.scene.add(c);
    return c;
  });

  // ---- a floating text panel: two lines, or while pulling the change it makes --------------
  // One canvas, 1024 x 512: the two lines sit in its lower part, just above the model.
  function makeLabel() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 512;
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.scale.set(0.8, 0.4, 1);
    sprite.renderOrder = 20;
    sprite.userData = { canvas, tex };
    return sprite;
  }
  // a line at its size, or smaller if it would run past `w`
  function text(g, t = '', x, y, px, weight, color, w = 952, align = 'left') {
    g.font = `${weight} ${px}px system-ui, sans-serif`;
    const fit = Math.min(px, px * w / Math.max(g.measureText(t).width, 1));
    g.font = `${weight} ${fit}px system-ui, sans-serif`;
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(t, x, y);
  }
  function panelBg(top) {
    const { canvas } = label.userData, g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(13,17,23,0.85)';
    g.beginPath(); g.roundRect(0, top, canvas.width, canvas.height - top, 28); g.fill();
    return g;
  }
  function say(lines) {
    if (!label) return;
    const g = panelBg(320);
    text(g, lines[0], 36, 400, 52, 600, '#e6edf3');
    text(g, lines[1], 36, 470, 40, 400, '#9fb4cc');
    label.userData.tex.needsUpdate = true;
  }
  // While pulling: the value before and after, then mass, deflection and stress as bars
  // (before thin and grey, after in green where it is better and orange where worse).
  function compare(st) {
    if (!label) return;
    if (st.phase !== 'ready' || st.error) return say(describe(st));
    const g = panelBg(0), r = st.result, b = st.base;
    text(g, `${st.name}  ${fmt(st.value - st.delta, 6)} → ${fmt(st.value, 6)}`, 36, 84, 64, 700, MODES.pull.css, 640);
    text(g, `face ${st.move >= 0 ? '+' : '−'}${fmt(Math.abs(st.move))} mm`, 988, 84, 40, 500, '#e6edf3', 300, 'right');
    text(g, 'let go to keep it · move back to where you started to change nothing', 36, 134, 30, 400, '#9fb4cc');
    const rows = [['Mass', x => x.meta.mass_g, 'g'], ['Deflection', x => x.stats.max_displacement * 1000, 'µm'], ['Stress', x => x.stats.p99, 'MPa']];
    rows.forEach(([name, get, unit], i) => {
      const y = 214 + i * 96, v0 = b && get(b), v = r && get(r), X = 250, W = 420;
      text(g, name, 36, y + 20, 40, 500, '#e6edf3', 200);
      const top = Math.max(v0 || 0, v || 0) || 1;
      if (v0 != null) { g.fillStyle = 'rgba(159,180,204,0.45)'; g.fillRect(X, y - 18, W * v0 / top, 12); }
      if (v == null) return text(g, st.solveError ? 'no stress' : st.canSolve ? 'solving…' : '—', X + W + 24, y + 20, 38, 500, '#9fb4cc', 290);
      // more mass is worse; less deflection and stress are better
      const worse = v0 == null || Math.abs(v / v0 - 1) < 0.005 ? null : i === 0 ? v > v0 : v < v0 ? false : true;
      const css = worse == null ? '#e6edf3' : worse ? '#ff9f5a' : '#5ad17a';
      g.fillStyle = css; g.fillRect(X, y, W * v / top, 24);
      const pc = v0 ? ` ${v >= v0 ? '+' : '−'}${fmt(Math.abs(v / v0 - 1) * 100, 2)}%` : '';
      text(g, `${fmt(v)} ${unit}${pc}`, X + W + 24, y + 22, 40, 600, css, 290);
    });
    text(g, 'outline: the shape before · colours: stress on the scale when grabbed', 36, 492, 28, 400, '#7d8fa3');
    label.userData.tex.needsUpdate = true;
  }
  function idle() {
    if (!session) return;
    if (mode === 'push') return say(['PUSH · pinch the part and hold to load it', hint]);
    if (mode === 'tap') return say(['TAP · pinch the part to hear how it rings', 'the first tap on a part works out its tones: some seconds']);
    // the best move of all the arrows, if they are worked out
    const best = [...analysis.hints.list().values()].flat().sort((a, b) => b.ratio - a.ratio)[0];
    say(['PULL · pinch a face and move your hand to resize it',
         best ? `green arrows: most stiffness per gram · best: ${best.name} (${fmt(best.ratio, 2)}× per gram)` : hint]);
  }
  // TAP: progress while the tones are worked out, then what the tap sounded
  const khz = x => x >= 1000 ? `${fmt(x / 1000, 3)} kHz` : `${fmt(x, 3)} Hz`;
  analysis.ring.hooks.onStatus = st => { if (session && st.phase === 'modes') say(['Finding how it rings…', `${Math.round(100 * st.fraction)}%`]); };
  analysis.ring.hooks.onTap = (id, r) => {
    if (!session) return;
    say([`Rings at ${khz(r.modes[r.loudest].hz)} here (shown slowed down)`, `its tones: ${r.modes.map(m => khz(m.hz)).join(' · ')}`]);
  };

  // VOICE: hold the button and say a command; let go and Whisper (on the PC) writes it down
  async function startAsking(u) {
    u.asking = true;
    u.open = 0;
    try { await analysis.voice.listen(); } catch (e) { u.asking = false; return say(['Cannot listen', e.message]); }
    if (!u.asking) return finishAsking();                           // let go before the microphone opened
    drawPanel();
    say(['Listening… let go when done', '“set H to 50”, “increase slab T by 2”, “rebalance”, “undo”']);
  }
  async function finishAsking() {
    if (!analysis.voice.recording()) return;
    say(['Writing it down…', 'Whisper, on the PC']);
    const r = await analysis.voice.heard();
    drawPanel();
    if (!session || !r) return;
    if (r.done) say([`“${r.heard}”`, r.done]);
    else say([r.heard ? `“${r.heard}”` : 'Nothing heard', r.error || 'hold VOICE while you talk']);
  }
  analysis.voice.hooks.onMode = m => { if (session) setMode(m); };

  // AUTO: the rebalancing rounds as they come, then what they came to
  analysis.pull.hooks.onRebalance = log => {
    drawPanel();
    if (!session) return;
    if (log) return say(['AUTO · moving material to where it works hardest', log[log.length - 1] ?? 'finding where…']);
    idle();
  };
  analysis.pull.hooks.onHints = () => { if (session && !analysis.pull.active() && !analysis.push.active()) idle(); };

  // ---- a ring at the pinch that fills while a new spot's first answer is solved -----------
  // It fills with the solver's real progress and counts down the seconds left, estimated
  // from the progress so far (or, before there is any, from the last wait). When the part
  // starts to bend it pops and fades.
  let ring = null, lastWait = null, lastTail = null;
  function makeRing() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.renderOrder = 21;
    sprite.visible = false;
    sprite.userData = { canvas, tex };
    return sprite;
  }
  function ringStart(point) {
    Object.assign(ring.userData, { point, t0: performance.now(), target: 0, shown: 0, done: 0, left: null, tSolve: 0, f0: 0, t90: 0 });
    ring.material.opacity = 1;
    ring.visible = true;
  }
  function ringFrame(now, dt) {
    const r = ring?.userData;
    if (!ring?.visible) return;
    // over the pinch point, 3 cm towards your eyes, at a constant 9 cm
    const p = viewer.world.localToWorld(new THREE.Vector3(...r.point));
    const eye = xr.getCamera().getWorldPosition(new THREE.Vector3());
    ring.position.copy(p).add(eye.sub(p).normalize().multiplyScalar(0.03));
    if (r.done) {                                                    // pop: grow and fade out in 0.25 s
      const k = Math.min(1, (now - r.done) / 250);
      ring.scale.setScalar(0.09 * (1 + 0.5 * k));
      ring.material.opacity = 1 - k;
      if (k >= 1) ring.visible = false;
      return;
    }
    ring.scale.setScalar(0.09);
    // Seconds left: once the solver converges, from its own pace since it started converging
    // (its set-up pause excluded) plus the stress step; before that, from the last wait (every
    // spot on a part takes about as long). The count only goes down, and the ring fills as
    // elapsed / (elapsed + left), so the two always agree.
    const elapsed = (now - r.t0) / 1000;
    const tail = lastTail ?? 0.2;
    const paced = r.tSolve && r.target - r.f0 >= 0.2;                // enough convergence seen to time it
    const est = paced ? (now - r.tSolve) / 1000 * (0.9 - Math.min(r.target, 0.9)) / (r.target - r.f0) + (r.t90 ? Math.max(0, tail - (now - r.t90) / 1000) : tail)
              : lastWait ? lastWait - elapsed : null;
    if (est != null) r.left = Math.max(0.1, r.left == null ? est : Math.min(r.left - dt, est));
    const left = r.left ?? null;
    const fill = left == null ? r.target : Math.max(r.target, elapsed / (elapsed + left));
    r.shown = Math.max(r.shown, r.shown + (fill - r.shown) * Math.min(1, dt * 12));   // glide, never back
    const g = r.canvas.getContext('2d'), c = 128, R = 92, top = -Math.PI / 2;
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(13,17,23,0.78)';
    g.beginPath(); g.arc(c, c, 124, 0, 2 * Math.PI); g.fill();
    g.lineWidth = 20; g.lineCap = 'round';
    g.strokeStyle = 'rgba(159,180,204,0.22)';
    g.beginPath(); g.arc(c, c, R, 0, 2 * Math.PI); g.stroke();
    g.strokeStyle = '#9fd2ff';
    g.beginPath(); g.arc(c, c, R, top, top + 2 * Math.PI * Math.max(0.02, r.shown)); g.stroke();
    // a bead circling the unfilled part: the solver is working even when the fill pauses
    const a = top + 2 * Math.PI * (r.shown + (1 - r.shown) * ((now / 900) % 1));
    g.fillStyle = 'rgba(159,210,255,0.55)';
    g.beginPath(); g.arc(c + R * Math.cos(a), c + R * Math.sin(a), 7, 0, 2 * Math.PI); g.fill();
    g.textAlign = 'center';
    g.fillStyle = '#e6edf3';
    g.font = '600 64px system-ui, sans-serif';
    g.fillText(left == null ? '…' : `${left.toFixed(1)} s`, c, c + 14);
    g.fillStyle = '#9fb4cc';
    g.font = '28px system-ui, sans-serif';
    g.fillText(r.target < 0.9 ? 'solving' : 'stresses', c, c + 56);
    r.tex.needsUpdate = true;
  }

  const fmt = (x, d = 3) => (+x.toPrecision(d)).toLocaleString();
  analysis.push.hooks.onProgress = p => {
    const r = ring?.userData;
    if (!ring?.visible || r.done) return;
    const now = performance.now();
    if (p.fraction > 0.1 && !r.tSolve) { r.tSolve = now; r.f0 = p.fraction; }   // set-up done: converging from here
    if (p.fraction >= 0.9 && !r.t90) r.t90 = now;                     // only the stresses left
    r.target = Math.max(r.target, p.fraction);
  };
  analysis.push.hooks.onUpdate = u => {
    if (!session) return;
    if (ring?.visible && !ring.userData.done) {
      const r = ring.userData;
      r.done = performance.now();
      lastWait = (r.done - r.t0) / 1000;
      if (r.t90) lastTail = (r.done - r.t90) / 1000;
    }
    if (u.error) return say(['Push', u.error]);
    say([`${fmt(u.force)} N`, `deflection ${fmt(u.stats.max_displacement * 1000)} µm · stress ${fmt(u.stats.p99)} MPa`]);
  };
  analysis.push.hooks.onEnd = () => {
    if (ring) ring.visible = false;
    if (!analysis.pull.active()) idle();
  };
  analysis.pull.hooks.onStatus = st => { if (session) compare(st); };
  // after letting go: what the kept value comes to, now or once Analyze has solved it
  let kept = null;
  const stats = r => `${fmt(r.meta.mass_g)} g · deflection ${fmt(r.stats.max_displacement * 1000)} µm · stress ${fmt(r.stats.p99)} MPa`;
  analysis.pull.hooks.onEnd = (values, res) => {
    kept = null;
    if (!session) return;
    if (!values) return idle();
    const head = `Kept ${Object.entries(values).map(([k, v]) => `${k} = ${fmt(v, 6)}`).join(', ')}`;
    if (res) return say([head, `${stats(res)} · Ctrl+Z on the desktop undoes it`]);
    kept = { head };
    say([head, 'solving its stress… the colours update when it is done']);
  };
  analysis.pull.hooks.onResult = (id, r) => {
    if (!session || !kept || analysis.push.active() || analysis.pull.active()) return;
    say([kept.head, `${stats(r)} · Ctrl+Z on the desktop undoes it`]);
    kept = null;
  };

  // ---- placement: model space (mm, Z up) -> the room (m, Y up), standing on the floor ----
  function place() {
    const box = viewer.sceneBox(), c = box.getCenter(new THREE.Vector3());
    const real = box.getSize(new THREE.Vector3()).multiplyScalar(0.001), big = Math.max(real.x, real.y, real.z);
    // small parts are hard to read at full size: blow them up to about 80 cm, by a whole factor
    zoom = big < 0.5 ? Math.max(1, Math.round(0.8 / big)) : 1;
    const s = 0.001 * zoom, size = real.multiplyScalar(zoom);
    const depth = size.y, dist = 0.9 + depth / 2;
    // parts under 60 cm (at full size) stand on a table at hand height, larger ones (a chair) on the floor
    const lift = big < 0.6 ? 0.85 : 0;
    viewer.world.scale.setScalar(s);
    viewer.world.rotation.set(-Math.PI / 2, 0, 0);                // model Z -> room up, model Y -> away from you
    viewer.world.position.set(-c.x * s, lift - box.min.z * s, c.y * s - dist);
    if (lift) {
      table = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.6, size.x + 0.2), 0.04, Math.max(0.5, depth + 0.2)),
                             new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.8 }));
      table.position.set(0, lift - 0.021, -dist);                    // 1 mm below the part, or the two faces flicker
      viewer.scene.add(table);
    }
    label.position.set(0, lift + size.z + 0.3, -dist);
    // the mode switch just in front of the table's near edge, tilted up to you, within reach
    panel.position.set(0, (lift || 0.9) + 0.05, -dist + Math.max(0.25, depth / 2 + 0.1) + 0.08);
    panel.rotation.set(-0.95, 0, 0);
  }
  function unplace() {
    if (viewer.world.parent !== viewer.scene) viewer.scene.attach(viewer.world);
    viewer.world.position.set(0, 0, 0);
    viewer.world.rotation.set(0, 0, 0);
    viewer.world.scale.setScalar(1);
  }

  // ---- every frame while in VR: triggers start, ramp and end a push --------------------
  // the force follows the trigger (or a pinch, which is all or nothing) at most this fast, so
  // you see the part bend as you press rather than jump to its end shape
  const RAMP = 1.2;                                                  // seconds from zero to Max force
  let frame = 0, lastT = performance.now();
  viewer.onFrame = () => {
    if (!xr.isPresenting) return;
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    frame++;
    ringFrame(now, dt);
    handsFrame();
    let hovered = -1;
    controllers.forEach((c, i) => {
      const u = c.userData;
      if (!u.source) return;
      const trig = Math.max(u.source.gamepad?.buttons[0]?.value ?? 0, u.selecting ? 1 : 0), F = analysis.push.maxForce();
      const pressed = trig > 0.08 && !u.down;                        // this frame's new press (or pinch)
      u.down = trig > 0.08 || (u.down && trig >= 0.03);
      ray.setFromXRController(c);
      // a tracked pinch can drop out for a frame or two: a press ends only after 0.2 s open
      const opened = () => { u.open = trig < 0.03 ? (u.open || now) : 0; return u.open && now - u.open > 200; };
      if (u.asking) {                                                // holding ASK: listening until let go
        if (opened()) { u.asking = false; finishAsking(); }
        return;
      }
      if (u.pushing) {
        if (opened()) { analysis.push.stop(); u.pushing = false; return; }
        if (!u.open) u.force = Math.min(trig * F, u.force + F * dt / RAMP);
        analysis.push.update(u.force);
        return;
      }
      if (u.pulling) {
        if (opened()) { u.pulling = false; analysis.pull.release(); return; }
        // the hand's travel along the face's normal, in the model's millimetres
        const n = new THREE.Vector3(...u.grab.hit.normal).transformDirection(viewer.world.matrixWorld);
        const metres = c.position.clone().sub(u.grab.from).dot(n);
        analysis.pull.drag(metres / viewer.world.getWorldScale(new THREE.Vector3()).x);
        return;
      }
      if (u.holding) {                                               // a press in the air carries the model
        if (opened()) { u.holding = false; if (viewer.world.parent === c) viewer.scene.attach(viewer.world); }
        return;
      }
      // the mode switch first: one flat panel is cheap to cast against every frame
      const onPanel = panel && ray.intersectObject(panel, false)[0];
      if (onPanel) {
        hovered = Math.min(4, Math.floor(onPanel.uv.x * 5));
        u.line.scale.z = onPanel.distance;
        u.cursor.visible = false;
        if (pressed && hovered === 4) { startAsking(u); return; }
        if (pressed && hovered === 3) { if (analysis.isOn() && analysis.pull.available()) { setMode('pull'); analysis.rebalance(); drawPanel(); } }
        else if (pressed) setMode(['push', 'pull', 'tap'][hovered]);
        return;
      }
      // casting against the fine result meshes is the costly part of a frame: each hand every third frame
      if ((frame + i) % 3 && !pressed) return;
      const hit = viewer.hitRay(ray);
      u.line.scale.z = hit ? ray.ray.origin.distanceTo(viewer.world.localToWorld(new THREE.Vector3(...hit.point))) : 3;
      showCursor(u.cursor, hit);
      // hands have no grip button: a pinch on the part pushes or pulls it, a pinch beside it picks it up
      if (pressed && !hit && viewer.world.parent === viewer.scene) { u.holding = true; u.cursor.visible = false; u.open = 0; c.attach(viewer.world); return; }
      if (pressed && hit && !analysis.push.active() && !analysis.pull.active() && !analysis.rebalancing()) {
        u.grab = { hit, from: c.position.clone() };
        u.open = 0;
        u.cursor.visible = false;
        if (mode === 'tap') {
          if (!analysis.isOn()) return say(['Nothing to tap yet', 'turn on Analyze']);
          if (!analysis.ring.modes(hit.bodyId)) say(['Finding how it rings…', 'a few seconds, once per part']);
          analysis.ring.tap(hit.bodyId, hit.point, hit.normal);
          return;
        }
        if (mode === 'pull') {
          if (!analysis.pull.available()) return say(['Nothing to pull: no variables', 'give a size a variable in the Variables panel']);
          u.pulling = true;
          // a step per 2 cm of hand travel at the least, solved once the hand has rested on it
          // 0.6 s; no solving ahead, which would hold up the step the hand stops at
          const scale = viewer.world.getWorldScale(new THREE.Vector3()).x;
          return analysis.pull.grab(hit.bodyId, hit.point, hit.normal, { minDrag: 0.02 / scale, settle: 600, prefetch: false });
        }
        if (!analysis.push.canPush(hit.bodyId)) return say(['Nothing to push on yet', analysis.isOn() ? 'wait for the analysis, or switch to PULL' : 'turn on Analyze, or switch to PULL']);
        u.pushing = true;
        u.force = 0.1 * F;
        say(['Pushing…', 'hold still until the ring is full']);
        ringStart(hit.point);
        // straight into the surface, like the desktop: one solve, then only the force changes
        analysis.push.start(hit.bodyId, hit.point, hit.normal.map(v => -v), u.force);
      }
    });
    if (hovered !== panelHover) { panelHover = hovered; drawPanel(); }   // the button a ray points at, lit
  };

  // ---- enter / leave ---------------------------------------------------------------
  async function enter() {
    if (session) return session.end();
    analysis.ring.unlock();                                          // sound may only start from a click
    analysis.voice.warmUp();                                         // Whisper loads while you look around
    try {
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    } catch (e) { session = null; return toast(`Could not start VR: ${e.message}`, true); }
    viewer.setSection({ on: false });                               // the section plane works in screen space
    viewer.grid.visible = false;
    floor = new THREE.Mesh(new THREE.CircleGeometry(2.5, 64).rotateX(-Math.PI / 2),
                           new THREE.MeshStandardMaterial({ color: 0x1b222c, roughness: 0.95 }));
    viewer.scene.add(floor);
    label = makeLabel();
    ring = makeRing();
    panel = makePanel();
    viewer.scene.add(label, ring, panel);
    place();
    hint = `${zoom > 1 ? `shown ${zoom}× full size · ` : ''}switch PUSH / PULL on the panel in front · pinch beside the part to move it`;
    if (!analysis.isOn() && analysis.pull.available()) mode = 'pull';
    analysis.hints.show(mode === 'pull');
    for (const c of controllers) c.userData.line.material.color.set(MODES[mode].color);
    drawPanel();
    idle();
    session.addEventListener('end', () => {
      analysis.push.stop();
      analysis.pull.cancel();
      analysis.hints.show(false);
      for (const c of controllers) {
        Object.assign(c.userData, { pushing: false, pulling: false, holding: false, asking: false, down: false, selecting: false });
        c.userData.cursor.visible = false;
      }
      unplace();
      viewer.grid.visible = true;
      viewer.scene.remove(floor, label, ring, panel);
      panel.geometry.dispose();
      floor.geometry.dispose(); floor.material.dispose();
      if (table) { viewer.scene.remove(table); table.geometry.dispose(); table.material.dispose(); table = null; }
      for (const s of [label, ring, panel]) { s.material.map.dispose(); s.material.dispose(); }
      floor = label = ring = panel = session = null;
      button.textContent = 'VR';
    });
    await xr.setSession(session);
    button.textContent = 'Exit VR';
  }

  button.addEventListener('click', enter);
  return { enter, place, isPresenting: () => !!session };
}
