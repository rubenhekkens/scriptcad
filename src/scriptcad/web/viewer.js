// Three.js viewport: shaded BRep tessellations, exact BRep edges, picking of
// bodies / faces / edges / surface points, section plane and an axis gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const COL = {
  hover: 0x5cb8ff,
  select: 0xff9a2e,
  edge: 0x10141a,
  cap: 0xd2563a,
};

// perceptual blue -> teal -> yellow -> red ramp for result fields (t in 0..1, clipped)
const RAMP = [[0, [0.17, 0.27, 0.6]], [0.35, [0.1, 0.62, 0.66]], [0.65, [0.96, 0.82, 0.25]],
              [0.85, [0.95, 0.45, 0.15]], [1, [0.8, 0.08, 0.12]]];
export function fieldColor(t) {
  t = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) {
    const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], f = (t - a) / (b - a);
    return ca.map((v, k) => v + (cb[k] - v) * f);
  }
  return RAMP[RAMP.length - 1][1];
}

export class Viewer {
  constructor(host, gizmoCanvas) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1e6);
    this.camera.position.set(80, -110, 80);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.zoomToCursor = true;

    this.scene.add(new THREE.HemisphereLight(0xeef3ff, 0x40362e, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, -0.8, 1.2);
    this.camera.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-1, 0.4, -0.3);
    this.camera.add(fill);
    this.scene.add(this.camera);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);
    this.grid = null;
    this.size = 100;
    this._makeGrid(200);

    this.bodies = new Map();
    this.mode = 'body';
    this.display = { edges: true, wire: false, xray: false };
    this.section = { on: false, axis: 'z', t: 0.5, flip: false };
    this.clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e9);
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.hover = null;
    this.selection = [];
    this.measure = [];
    this.marks = [];          // [{ bodyId, index, color }] face overlays (analysis supports/loads)
    this.onPick = () => {};
    this.onHover = () => {};
    this._lineMats = new Set();

    this._initGizmo(gizmoCanvas);
    this._bindPointer();
    new ResizeObserver(() => this._resize()).observe(host);
    this._resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this._updateClipRange();
      this._render();
    };
    loop();
  }

  // ---- scene content ------------------------------------------------------

  setBodies(list, { colors = {}, hidden = new Set(), refit = false } = {}) {
    for (const b of this.bodies.values()) this._disposeBody(b);
    this.bodies.clear();
    for (const data of list) {
      const color = new THREE.Color(colors[data.id] || data.color || '#9aa7b8');
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mat = new THREE.MeshStandardMaterial({
        color, metalness: 0.08, roughness: 0.55, side: THREE.FrontSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        clippingPlanes: [this.clip],
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.bodyId = data.id;
      // back faces, seen only through the section plane, act as the cut cap
      const cap = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COL.cap, side: THREE.BackSide, clippingPlanes: [this.clip] }));
      cap.visible = false;

      // exact BRep edges: polylines -> segments, remembering the edge index
      const seg = [];
      const segEdge = [];
      let o = 0;
      data.edgeCounts.forEach((n, ei) => {
        for (let k = 0; k < n - 1; k++) {
          const a = (o + k) * 3, b = (o + k + 1) * 3;
          const P = data.edgePositions;
          seg.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]);
          segEdge.push(ei);
        }
        o += n;
      });
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: COL.edge, clippingPlanes: [this.clip] }));

      const group = new THREE.Group();
      group.add(mesh, cap, edges);
      group.visible = !hidden.has(data.id);
      this.root.add(group);

      const faceTris = new Map();
      data.triFace.forEach((fi, t) => {
        if (!faceTris.has(fi)) faceTris.set(fi, []);
        faceTris.get(fi).push(t);
      });
      this.bodies.set(data.id, { data, group, mesh, cap, edges, seg: new Float32Array(seg), segEdge, faceTris, color });
    }
    this._applyDisplay();
    this.hover = null;
    this.selection = this.selection.filter(s => this.bodies.has(s.bodyId));
    this._refreshHighlights();
    if (refit) this.fit();
    else this._updateGrid();
  }

  setHidden(hidden) {
    for (const [id, b] of this.bodies) b.group.visible = !hidden.has(id);
  }

  setColor(id, hex) {
    const b = this.bodies.get(id);
    if (b) { b.color.set(hex); b.mesh.material.color.set(hex); this._refreshHighlights(); }
  }

  setDisplay(patch) {
    Object.assign(this.display, patch);
    this._applyDisplay();
  }

  _applyDisplay() {
    const { edges, wire, xray } = this.display;
    for (const b of this.bodies.values()) {
      const m = b.mesh.material;
      b.mesh.visible = !wire;
      m.transparent = xray;
      m.opacity = xray ? 0.28 : 1;
      m.depthWrite = !xray;
      m.needsUpdate = true;
      b.edges.visible = edges || wire;
      b.edges.material.color.set(wire || xray ? 0x9fb4cc : COL.edge);
      b.cap.visible = this.section.on && !wire && !xray;
    }
  }

  setSection(patch) {
    Object.assign(this.section, patch);
    this._updateClip();
    this._applyDisplay();
  }

  _updateClip() {
    const s = this.section;
    if (!s.on) { this.clip.set(new THREE.Vector3(0, 0, -1), 1e9); return; }
    const box = this.sceneBox();
    const i = { x: 0, y: 1, z: 2 }[s.axis];
    const lo = box.min.getComponent(i), hi = box.max.getComponent(i);
    const pos = lo + (hi - lo) * s.t;
    const n = new THREE.Vector3(); n.setComponent(i, s.flip ? 1 : -1);
    this.clip.set(n, s.flip ? -pos : pos);
  }

  sceneBox() {
    const box = new THREE.Box3();
    for (const b of this.bodies.values()) if (b.group.visible) box.union(b.mesh.geometry.boundingBox);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 30));
    return box;
  }

  // ---- camera ---------------------------------------------------------------

  fit(dir) {
    const box = this.sceneBox();
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const d = dir ? dir.clone().normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.08;
    this._animateTo(c.clone().add(d.multiplyScalar(dist)), c, dir && Math.abs(dir.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
    this.size = r * 2;
    this._updateGrid();
  }

  view(name) {
    const dirs = {
      iso: [1, -1, 0.8], top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0],
      back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0],
    };
    this.fit(new THREE.Vector3(...dirs[name]));
  }

  _animateTo(pos, target, up) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone(), u0 = this.camera.up.clone();
    const start = performance.now();
    const step = now => {
      const k = Math.min((now - start) / 320, 1);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(p0, pos, e);
      this.controls.target.lerpVectors(t0, target, e);
      this.camera.up.lerpVectors(u0, up, e).normalize();
      this.camera.lookAt(this.controls.target);
      if (k < 1) requestAnimationFrame(step);
      else this.camera.up.set(0, 0, 1);
    };
    requestAnimationFrame(step);
  }

  _makeGrid(size) {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); }
    const step = Math.pow(10, Math.floor(Math.log10(size / 10)));
    const n = Math.ceil(size / step);
    this.grid = new THREE.GridHelper(n * step, n, 0x5b6472, 0x343b45);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.grid.material.depthWrite = false;
    this.gridStep = step;
    this.scene.add(this.grid);
  }

  _updateGrid() {
    const box = this.sceneBox();
    const s = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 20) * 2.2;
    const step = Math.pow(10, Math.floor(Math.log10(s / 10)));
    if (step !== this.gridStep || Math.abs(this.grid.geometry.parameters?.size - s) > s) this._makeGrid(s);
    const z = Math.min(box.min.z, 0);
    this.grid.position.set(0, 0, z - 1e-3 * this.size);
  }

  // ---- picking ----------------------------------------------------------------

  setMode(mode) {
    this.mode = mode;
    this.hover = null;
    this._refreshHighlights();
  }

  setSelection(sel) {
    this.selection = sel;
    this._refreshHighlights();
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', e => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      down = null;
      if (moved) return;
      const hit = this.pick(e);
      this.onPick(hit, e);
    });
    let pending = null;
    el.addEventListener('pointermove', e => {
      if (e.buttons) return;
      pending = e;
      requestAnimationFrame(() => {
        if (!pending) return;
        const hit = this.pick(pending);
        pending = null;
        const key = h => h ? `${h.bodyId}:${h.kind}:${h.index}` : '';
        if (key(hit) !== key(this.hover)) {
          this.hover = hit;
          this._refreshHighlights();
          this.onHover(hit);
        } else if (hit && hit.kind === 'point') {
          this.hover = hit;
          this.onHover(hit);
        }
      });
    });
    el.addEventListener('pointerleave', () => { this.hover = null; this._refreshHighlights(); this.onHover(null); });
  }

  _ray(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    return { px: e.clientX - r.left, py: e.clientY - r.top, w: r.width, h: r.height };
  }

  _meshHit() {
    const meshes = [...this.bodies.values()].filter(b => b.group.visible && b.mesh.visible).map(b => b.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false).filter(h => !this.section.on || this.clip.distanceToPoint(h.point) >= -1e-6);
    return hits[0] || null;
  }

  pick(e) {
    const scr = this._ray(e);
    const hit = this._meshHit();
    if (this.mode === 'edge' || (this.mode === 'body' && !hit)) {
      const eh = this._edgeHit(scr);
      if (eh) return this.mode === 'body' ? { bodyId: eh.bodyId, kind: 'body', index: 0, point: eh.point } : eh;
    }
    if (!hit) return null;
    const bodyId = hit.object.userData.bodyId;
    const b = this.bodies.get(bodyId);
    const triFace = b.displayTriFace ?? b.data.triFace;
    if (this.mode === 'face') return { bodyId, kind: 'face', index: triFace[hit.faceIndex], point: hit.point.toArray() };
    if (this.mode === 'point') return { bodyId, kind: 'point', index: 0, point: hit.point.toArray(), normal: hit.face?.normal?.toArray() };
    if (this.mode === 'edge') return null;
    return { bodyId, kind: 'body', index: 0, point: hit.point.toArray() };
  }

  _edgeHit(scr) {
    const tol = 7;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
    const cands = [];
    for (const [bodyId, body] of this.bodies) {
      if (!body.group.visible || !body.edges.visible && this.mode !== 'edge') continue;
      const S = body.seg;
      for (let i = 0; i < body.segEdge.length; i++) {
        a.fromArray(S, i * 6); b.fromArray(S, i * 6 + 3);
        if (this.section.on && this.clip.distanceToPoint(a) < 0 && this.clip.distanceToPoint(b) < 0) continue;
        pa.copy(a).project(this.camera); pb.copy(b).project(this.camera);
        if (pa.z > 1 && pb.z > 1) continue;
        const ax = (pa.x + 1) / 2 * scr.w, ay = (1 - pa.y) / 2 * scr.h;
        const bx = (pb.x + 1) / 2 * scr.w, by = (1 - pb.y) / 2 * scr.h;
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        let t = L > 0 ? ((scr.px - ax) * dx + (scr.py - ay) * dy) / L : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(ax + dx * t - scr.px, ay + dy * t - scr.py);
        if (d < tol) cands.push({ d, bodyId, edge: body.segEdge[i], p: a.clone().lerp(b, t) });
      }
    }
    cands.sort((x, y) => x.d - y.d);
    const cam = this.camera.position;
    for (const c of cands.slice(0, 6)) {
      // occlusion: is there a surface clearly in front of the edge point?
      const dist = cam.distanceTo(c.p);
      const ray = new THREE.Raycaster(cam.clone(), c.p.clone().sub(cam).normalize(), 0, dist);
      const meshes = [...this.bodies.values()].filter(x => x.group.visible && x.mesh.visible && !this.display.xray).map(x => x.mesh);
      const block = ray.intersectObjects(meshes, false).find(h => !this.section.on || this.clip.distanceToPoint(h.point) >= 0);
      if (block && block.distance < dist - Math.max(dist * 2e-3, 1e-4)) continue;
      return { bodyId: c.bodyId, kind: 'edge', index: c.edge, point: c.p.toArray() };
    }
    return null;
  }

  // ---- highlights -------------------------------------------------------------

  _refreshHighlights() {
    for (const o of [...this.overlay.children]) {
      this.overlay.remove(o);
      o.geometry?.dispose();
      if (o.material && !o.userData.keepMat) o.material.dispose();
    }
    this._lineMats.clear();
    for (const b of this.bodies.values()) b.mesh.material.emissive.set(0x000000);

    const draw = (s, color, isHover) => {
      const b = this.bodies.get(s.bodyId);
      if (!b || !b.group.visible) return;
      if (s.kind === 'body') {
        if (isHover) b.mesh.material.emissive.set(color).multiplyScalar(0.18);
        else b.mesh.material.emissive.set(color).multiplyScalar(0.32);
        this._edgeOverlay(b, null, color, isHover ? 1.5 : 2);
      } else if (s.kind === 'face') {
        const tris = b.faceTris.get(s.index) || [];
        const P = b.data.positions;
        const pos = new Float32Array(tris.length * 9);
        tris.forEach((t, i) => pos.set(P.slice(t * 9, t * 9 + 9), i * 9));
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const m = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: s.opacity ?? (isHover ? 0.35 : 0.55), depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: [this.clip],
          side: THREE.DoubleSide,
        });
        this.overlay.add(new THREE.Mesh(g, m));
        if (s.outline) this._faceOutline(b, tris, color);
      } else if (s.kind === 'edge') {
        this._edgeOverlay(b, s.index, color, isHover ? 3 : 4);
      }
    };
    // marks (analysis supports and loads) get a solid fill and a thick outline, so they
    // stay readable on top of a coloured result field
    for (const m of this.marks) draw({ bodyId: m.bodyId, kind: 'face', index: m.index, opacity: m.opacity ?? 0.8, outline: true }, m.color, false);
    for (const s of this.selection) draw(s, COL.select, false);
    if (this.hover && this.hover.kind !== 'point') {
      const dup = this.selection.some(s => s.bodyId === this.hover.bodyId && s.kind === this.hover.kind && s.index === this.hover.index);
      if (!dup) draw(this.hover, COL.hover, true);
    }
    this._drawMeasure();
  }

  _edgeOverlay(b, edgeIndex, color, width) {
    const pts = [];
    for (let i = 0; i < b.segEdge.length; i++) {
      if (edgeIndex === null || b.segEdge[i] === edgeIndex) for (let k = 0; k < 6; k++) pts.push(b.seg[i * 6 + k]);
    }
    if (!pts.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(pts);
    const m = new LineMaterial({ color, linewidth: width, depthTest: edgeIndex !== null ? false : true, clippingPlanes: [this.clip] });
    m.resolution.set(this.host.clientWidth, this.host.clientHeight);
    this._lineMats.add(m);
    const l = new LineSegments2(g, m);
    l.renderOrder = 5;
    this.overlay.add(l);
  }

  /** Thick outline of a face: the edges of its triangles that no other of its triangles shares. */
  _faceOutline(b, tris, color) {
    const P = b.data.positions;
    const key = (o) => `${P[o].toFixed(4)},${P[o + 1].toFixed(4)},${P[o + 2].toFixed(4)}`;
    const count = new Map();
    const segs = [];
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const oa = t * 9 + 3 * e, ob = t * 9 + 3 * ((e + 1) % 3);
        const ka = key(oa), kb = key(ob);
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        count.set(k, (count.get(k) || 0) + 1);
        segs.push([k, oa, ob]);
      }
    }
    const pts = [];
    for (const [k, oa, ob] of segs) {
      if (count.get(k) !== 1) continue;
      pts.push(P[oa], P[oa + 1], P[oa + 2], P[ob], P[ob + 1], P[ob + 2]);
    }
    if (!pts.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(pts);
    const m = new LineMaterial({ color, linewidth: 3.5, clippingPlanes: [this.clip] });
    m.resolution.set(this.host.clientWidth, this.host.clientHeight);
    this._lineMats.add(m);
    const l = new LineSegments2(g, m);
    l.renderOrder = 6;
    this.overlay.add(l);
  }

  setMarks(marks) {
    this.marks = marks;
    this._refreshHighlights();
  }

  // ---- result fields (analysis) -------------------------------------------------

  /**
   * Colour a body by a per-corner scalar (same order as its positions) and keep the
   * per-corner displacement for the deformed view. cap: value mapped to the top colour;
   * color: maps value / cap to [r, g, b] (default: the stress ramp).
   */
  setField(id, values, cap, displacement = null, mesh = null, color = fieldColor) {
    const b = this.bodies.get(id);
    if (!b) return false;
    if (mesh) {
      // a result comes on its own, finer copy of the body's mesh (a flat CAD face is only
      // two triangles, far too coarse to show a stress field); keep the CAD mesh to restore
      b.cadGeometry ??= b.mesh.geometry;
      const fine = new THREE.BufferGeometry();
      // a copy: the deformed view writes into this array, and the result must stay undeformed
      fine.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
      fine.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      fine.computeBoundingSphere();
      fine.computeBoundingBox();
      if (b.mesh.geometry !== b.cadGeometry) b.mesh.geometry.dispose();
      b.mesh.geometry = fine;
      b.displayTriFace = mesh.triFace;
      b.basePositions = null;
    }
    const g = b.mesh.geometry;
    const n = values.length;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set(color(values[i] / cap), 3 * i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    b.mesh.material.vertexColors = true;
    b.mesh.material.color.set(0xffffff);
    b.mesh.material.needsUpdate = true;
    b.basePositions ??= g.getAttribute('position').array.slice();
    b.displacement = displacement;
    this.setDeformation(this.deformScale || 0);
    return true;
  }

  /** Show displacements scaled by `scale` on every body that has a field (0 = undeformed). */
  setDeformation(scale) {
    this.deformScale = scale;
    for (const b of this.bodies.values()) {
      if (!b.basePositions) continue;
      const pos = b.mesh.geometry.getAttribute('position');
      const base = b.basePositions, d = b.displacement;
      for (let i = 0; i < base.length; i++) pos.array[i] = base[i] + (d && scale ? scale * d[i] : 0);
      pos.needsUpdate = true;
      b.mesh.geometry.computeBoundingSphere();
      b.edges.visible = !scale && (this.display.edges || this.display.wire);
    }
  }

  clearField() {
    for (const b of this.bodies.values()) {
      if (b.cadGeometry) {
        b.mesh.geometry.dispose();
        b.mesh.geometry = b.cadGeometry;
        b.cadGeometry = null;
        b.displayTriFace = null;
      } else if (b.basePositions) {
        const g = b.mesh.geometry;
        g.getAttribute('position').array.set(b.basePositions);
        g.getAttribute('position').needsUpdate = true;
        g.deleteAttribute('color');
        g.computeBoundingSphere();
      }
      if (!b.basePositions) continue;
      b.mesh.material.vertexColors = false;
      b.mesh.material.color.copy(b.color);
      b.mesh.material.needsUpdate = true;
      b.basePositions = null;
      b.displacement = null;
    }
    this._applyDisplay();
  }

  setMeasure(points) {
    this.measure = points;
    this._refreshHighlights();
  }

  _drawMeasure() {
    if (!this.measure.length) return;
    const r = Math.max(this.size, 1) * 0.006;
    for (const p of this.measure) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false }));
      m.position.fromArray(p);
      m.renderOrder = 6;
      this.overlay.add(m);
    }
    if (this.measure.length === 2) {
      const g = new LineSegmentsGeometry();
      g.setPositions([...this.measure[0], ...this.measure[1]]);
      const m = new LineMaterial({ color: 0xffd23f, linewidth: 2, depthTest: false, dashed: false });
      m.resolution.set(this.host.clientWidth, this.host.clientHeight);
      this._lineMats.add(m);
      const l = new LineSegments2(g, m);
      l.renderOrder = 6;
      this.overlay.add(l);
    }
  }

  /** Screen position (CSS px, relative to host) of a world point. */
  toScreen(p) {
    const v = new THREE.Vector3(...p).project(this.camera);
    return { x: (v.x + 1) / 2 * this.host.clientWidth, y: (1 - v.y) / 2 * this.host.clientHeight, behind: v.z > 1 };
  }

  // ---- gizmo ------------------------------------------------------------------

  _initGizmo(canvas) {
    this.gz = { canvas, renderer: new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }) };
    this.gz.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gz.scene = new THREE.Scene();
    this.gz.camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    this.gz.camera.position.set(0, 0, 5);
    this.gz.camera.up.set(0, 1, 0);
    this.gz.camera.lookAt(0, 0, 0);
    this.gz.group = new THREE.Group();
    this.gz.scene.add(this.gz.group);
    const axes = [['X', 0xe5534b, [1, 0, 0]], ['Y', 0x57ab5a, [0, 1, 0]], ['Z', 0x539bf5, [0, 0, 1]]];
    for (const [label, color, d] of axes) {
      const dir = new THREE.Vector3(...d);
      const g = new LineSegmentsGeometry();
      g.setPositions([0, 0, 0, ...dir.clone().multiplyScalar(0.95).toArray()]);
      const m = new LineMaterial({ color, linewidth: 3 });
      m.resolution.set(96, 96);
      this.gz.group.add(new LineSegments2(g, m));
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
      ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0d1117'; ctx.font = 'bold 34px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 32, 34);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      s.position.copy(dir.multiplyScalar(1.18));
      s.scale.setScalar(0.5);
      this.gz.group.add(s);
    }
    canvas.addEventListener('click', e => {
      // click an axis label to look along it
      const r = canvas.getBoundingClientRect();
      const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(v, this.gz.camera);
      const hit = rc.intersectObjects(this.gz.group.children.filter(o => o.isSprite))[0];
      if (!hit) return;
      const p = hit.object.position;
      this.fit(new THREE.Vector3(Math.sign(Math.round(p.x)), Math.sign(Math.round(p.y)), Math.sign(Math.round(p.z))));
    });
  }

  _updateClipRange() {
    // keep depth precision proportional to the orbit distance
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(d / 500, 1e-4), far = d * 50 + this.size * 4;
    if (Math.abs(near - this.camera.near) > near * 0.05 || Math.abs(far - this.camera.far) > far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  _render() {
    this.renderer.render(this.scene, this.camera);
    if (this.gz) {
      this.gz.group.quaternion.copy(this.camera.quaternion).invert();
      this.gz.renderer.render(this.gz.scene, this.gz.camera);
    }
  }

  _resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const m of this._lineMats) m.resolution.set(w, h);
    const c = this.gz.canvas;
    this.gz.renderer.setSize(c.clientWidth, c.clientHeight, false);
  }

  _disposeBody(b) {
    this.root.remove(b.group);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    b.cap.material.dispose();
    b.edges.geometry.dispose();
    b.edges.material.dispose();
  }

  screenshot() {
    this._render();
    return this.renderer.domElement.toDataURL('image/png');
  }
}
