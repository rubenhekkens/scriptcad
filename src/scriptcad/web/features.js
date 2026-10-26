// Feature definitions: parameter schema, defaults and labels for every
// operation in the history. The server compiles these into usd_brep calls
// (scriptcad/kernel.py: feature_code) - keep the parameter keys in sync.

const XYZ = (z = 0) => [
  { k: 'x', label: 'X', type: 'num', def: 0 },
  { k: 'y', label: 'Y', type: 'num', def: 0 },
  { k: 'z', label: 'Z', type: 'num', def: z },
];

const PLANE = { k: 'plane', label: 'Sketch plane', type: 'sel', def: 'XY', opts: [['XY', 'XY (top)'], ['XZ', 'XZ (front)'], ['YZ', 'YZ (right)']] };

const PROFILE = [
  { k: 'profile', label: 'Profile', type: 'sel', def: 'rect', opts: [['rect', 'Rectangle'], ['circle', 'Circle'], ['polygon', 'Regular polygon'], ['polyline', 'Polyline']] },
  { k: 'cx', label: 'Center U', type: 'num', def: 0, when: p => p.profile !== 'polyline' },
  { k: 'cy', label: 'Center V', type: 'num', def: 0, when: p => p.profile !== 'polyline' },
  { k: 'w', label: 'Width', type: 'num', def: 20, min: 0, when: p => p.profile === 'rect' },
  { k: 'h', label: 'Height', type: 'num', def: 10, min: 0, when: p => p.profile === 'rect' },
  { k: 'r', label: 'Radius', type: 'num', def: 8, min: 0, when: p => p.profile === 'circle' || p.profile === 'polygon' },
  { k: 'sides', label: 'Sides', type: 'num', def: 6, step: 1, min: 3, when: p => p.profile === 'polygon' },
  { k: 'points', label: 'Points (u, v; …)', type: 'text', def: '0,0; 20,0; 20,5; 8,5; 8,15; 0,15', when: p => p.profile === 'polyline' },
];

export const FEATURES = {
  box: { label: 'Box', group: 'Primitives', fields: [...XYZ(), { k: 'l', label: 'Length (X)', type: 'num', def: 20, min: 0 }, { k: 'w', label: 'Width (Y)', type: 'num', def: 20, min: 0 }, { k: 'h', label: 'Height (Z)', type: 'num', def: 20, min: 0 }], hint: 'Origin is the minimum corner.' },
  cylinder: { label: 'Cylinder', group: 'Primitives', fields: [...XYZ(), { k: 'r', label: 'Radius', type: 'num', def: 10, min: 0 }, { k: 'h', label: 'Height', type: 'num', def: 20, min: 0 }], hint: 'Origin is the center of the base; axis is +Z.' },
  sphere: { label: 'Sphere', group: 'Primitives', fields: [...XYZ(), { k: 'r', label: 'Radius', type: 'num', def: 10, min: 0 }] },
  cone: { label: 'Cone', group: 'Primitives', fields: [...XYZ(), { k: 'r1', label: 'Base radius', type: 'num', def: 10, min: 0 }, { k: 'r2', label: 'Top radius', type: 'num', def: 0, min: 0 }, { k: 'h', label: 'Height', type: 'num', def: 20, min: 0 }], hint: 'Top radius > 0 gives a frustum.' },
  torus: { label: 'Torus', group: 'Primitives', fields: [...XYZ(), { k: 'R', label: 'Major radius', type: 'num', def: 15, min: 0 }, { k: 'r', label: 'Minor radius', type: 'num', def: 4, min: 0 }] },
  pyramid: { label: 'Pyramid', group: 'Primitives', fields: [...XYZ(), { k: 'l', label: 'Base size', type: 'num', def: 20, min: 0 }, { k: 'h', label: 'Height', type: 'num', def: 20, min: 0 }] },

  extrude: { label: 'Extrude', group: 'Sketch', fields: [PLANE, ...PROFILE, { k: 'dist', label: 'Distance', type: 'num', def: 10 }, { k: 'offset', label: 'Plane offset', type: 'num', def: 0 }], hint: 'Profile is drawn in plane coordinates (U, V) and swept along the plane normal.' },
  revolve: { label: 'Revolve', group: 'Sketch', fields: [PLANE, ...PROFILE.map(f => f.k === 'cx' ? { ...f, def: 15 } : f), { k: 'axis', label: 'Axis (in sketch)', type: 'sel', def: 'Y', opts: [['Y', 'V axis'], ['X', 'U axis']] }, { k: 'angle', label: 'Angle °', type: 'num', def: 360 }], hint: 'Keep the profile on one side of the axis.' },

  boolean: { label: 'Boolean', group: 'Combine', fields: [
    { k: 'op', label: 'Operation', type: 'sel', def: 'union', opts: [['union', 'Union'], ['difference', 'Subtract'], ['intersection', 'Intersect']] },
    { k: 'target', label: 'Target body', type: 'body' },
    { k: 'tool', label: 'Tool body', type: 'body' },
    { k: 'keep_tool', label: 'Keep tool body', type: 'bool', def: false },
  ] },

  fillet: { label: 'Fillet', group: 'Modify', fields: [
    { k: 'kind', label: 'Type', type: 'sel', def: 'fillet', opts: [['fillet', 'Round (circular)'], ['blend', 'Blend (G2)'], ['chamfer', 'Chamfer']] },
    { k: 'target', label: 'Body', type: 'body' },
    { k: 'edges', label: 'Edges', type: 'edges', def: [] },
    { k: 'radius', label: 'Radius', type: 'num', def: 2, min: 0 },
  ], hint: 'Pick edges in the viewport. With no edges picked, every edge is treated.' },
  shell: { label: 'Shell', group: 'Modify', fields: [
    { k: 'target', label: 'Body', type: 'body' },
    { k: 'faces', label: 'Open faces', type: 'faces', def: [] },
    { k: 'thickness', label: 'Wall thickness', type: 'num', def: 1.5, min: 0 },
  ], hint: 'Pick the faces to remove. With none picked the result is a closed hollow.' },
  offset: { label: 'Offset', group: 'Modify', fields: [
    { k: 'target', label: 'Body', type: 'body' },
    { k: 'distance', label: 'Distance', type: 'num', def: 1 },
  ], hint: 'Positive grows the body, negative shrinks it.' },

  move: { label: 'Move', group: 'Transform', fields: [
    { k: 'target', label: 'Body', type: 'body' },
    { k: 'tx', label: 'ΔX', type: 'num', def: 0 }, { k: 'ty', label: 'ΔY', type: 'num', def: 0 }, { k: 'tz', label: 'ΔZ', type: 'num', def: 0 },
    { k: 'axis', label: 'Rotate about', type: 'sel', def: 'Z', opts: [['X', 'X axis'], ['Y', 'Y axis'], ['Z', 'Z axis']] },
    { k: 'angle', label: 'Angle °', type: 'num', def: 0 },
    { k: 'scale', label: 'Scale', type: 'num', def: 1, min: 0 },
    { k: 'px', label: 'Pivot X', type: 'num', def: 0 }, { k: 'py', label: 'Pivot Y', type: 'num', def: 0 }, { k: 'pz', label: 'Pivot Z', type: 'num', def: 0 },
  ], hint: 'Rotation and scale happen about the pivot, then the body is translated.' },
  copy: { label: 'Copy', group: 'Transform', fields: [
    { k: 'target', label: 'Body', type: 'body' },
    { k: 'tx', label: 'ΔX', type: 'num', def: 30 }, { k: 'ty', label: 'ΔY', type: 'num', def: 0 }, { k: 'tz', label: 'ΔZ', type: 'num', def: 0 },
  ] },
  pattern: { label: 'Pattern', group: 'Transform', fields: [
    { k: 'target', label: 'Body', type: 'body' },
    { k: 'mode', label: 'Mode', type: 'sel', def: 'linear', opts: [['linear', 'Linear'], ['polar', 'Circular']] },
    { k: 'count', label: 'Count', type: 'num', def: 4, step: 1, min: 2 },
    { k: 'dx', label: 'Step X', type: 'num', def: 25, when: p => p.mode !== 'polar' },
    { k: 'dy', label: 'Step Y', type: 'num', def: 0, when: p => p.mode !== 'polar' },
    { k: 'dz', label: 'Step Z', type: 'num', def: 0, when: p => p.mode !== 'polar' },
    { k: 'axis', label: 'Axis', type: 'sel', def: 'Z', opts: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], when: p => p.mode === 'polar' },
    { k: 'angle', label: 'Total angle °', type: 'num', def: 360, when: p => p.mode === 'polar' },
    { k: 'px', label: 'Center X', type: 'num', def: 0, when: p => p.mode === 'polar' },
    { k: 'py', label: 'Center Y', type: 'num', def: 0, when: p => p.mode === 'polar' },
    { k: 'pz', label: 'Center Z', type: 'num', def: 0, when: p => p.mode === 'polar' },
  ], hint: 'Copies are unioned into the body, so they should touch or overlap.' },

  import: { label: 'USD import', group: 'File', fields: [
    { k: 'file_name', label: 'File', type: 'info' },
    { k: 'index', label: 'BRep index', type: 'num', def: 0, step: 1, min: 0 },
  ] },
};

// Feature types whose result is a new body (named after the feature).
export const CREATES = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'pyramid', 'extrude', 'revolve', 'copy', 'import']);

export function defaults(type) {
  const p = {};
  for (const f of FEATURES[type].fields) if ('def' in f) p[f.k] = structuredClone(f.def);
  return p;
}

export function visibleFields(type, params) {
  return FEATURES[type].fields.filter(f => !f.when || f.when(params));
}

/** Bodies alive just before feature `index` (mirrors kernel.compile_history). */
export function liveBodiesBefore(features, index) {
  const live = [];
  for (let i = 0; i < index && i < features.length; i++) {
    const f = features[i];
    if (f.suppressed) continue;
    if (f.type === 'boolean' && !f.params.keep_tool) {
      const j = live.indexOf(f.params.tool);
      if (j >= 0 && f.params.target && f.params.target !== f.params.tool) live.splice(j, 1);
    }
    if (CREATES.has(f.type)) live.push(f.id);
  }
  return live;
}

export function nextName(features, type) {
  const base = FEATURES[type].label.replace('USD import', 'Import');
  let n = 1;
  const names = new Set(features.map(f => f.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// Small line icons (24x24, stroke = currentColor)
export const ICONS = {
  box: '<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4M12 11v10"/>',
  cylinder: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  sphere: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="8.5" ry="3.2"/>',
  cone: '<path d="M12 3 5 18M12 3l7 15"/><ellipse cx="12" cy="18" rx="7" ry="2.6"/>',
  torus: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><path d="M8.5 11.5c2 1.6 5 1.6 7 0M9.5 12.6c1.6-1 3.4-1 5 0"/>',
  pyramid: '<path d="M12 3 3 17l9 4 9-4z"/><path d="M12 3v18"/>',
  extrude: '<path d="M5 15h10l4-4H9z"/><path d="M5 15V8l4-4h10v7M15 15V8m0 0 4-4M15 8H5"/>',
  revolve: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M15 6h3v12h-3"/><path d="M6.5 8.5A6 6 0 0 0 6 16"/><path d="m4.5 14 1.6 2.4L8.4 15"/>',
  union: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  difference: '<path d="M12 7.2A6 6 0 1 0 12 16.8a6 6 0 0 1 0-9.6z"/><circle cx="15" cy="12" r="6" stroke-dasharray="2 2"/>',
  intersection: '<circle cx="9" cy="12" r="6" stroke-dasharray="2 2"/><circle cx="15" cy="12" r="6" stroke-dasharray="2 2"/><path d="M12 7.2a6 6 0 0 1 0 9.6 6 6 0 0 1 0-9.6z" fill="currentColor" fill-opacity=".35"/>',
  fillet: '<path d="M4 20V10a6 6 0 0 1 6-6h10"/><path d="M4 4h4M4 4v4" opacity=".4"/>',
  chamfer: '<path d="M4 20V10l6-6h10"/><path d="M4 4h6M4 4v6" opacity=".4"/>',
  shell: '<path d="M4 8v11h16V8"/><path d="M7 8v8h10V8"/>',
  offset: '<rect x="7" y="7" width="10" height="10" rx="1"/><rect x="3.5" y="3.5" width="17" height="17" rx="3" stroke-dasharray="2 2"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  pattern: '<rect x="3" y="9" width="5" height="6" rx="1"/><rect x="10" y="9" width="5" height="6" rx="1"/><rect x="17" y="9" width="4" height="6" rx="1" opacity=".5"/>',
  import: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 17v3h16v-3"/>',
  boolean: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  measure: '<path d="m3 17 14-14 4 4L7 21z"/><path d="m7 13 2 2m1-5 2 2m1-5 2 2"/>',
  section: '<path d="M12 3 4 7v10l8 4 8-4V7z" opacity=".45"/><path d="M2 13h20" stroke-width="2"/>',
};

export function icon(name, size = 18) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.box}</svg>`;
}

export function featureIcon(f) {
  if (f.type === 'boolean') return icon(f.params.op || 'union');
  if (f.type === 'fillet') return icon(f.params.kind === 'chamfer' ? 'chamfer' : 'fillet');
  return icon(f.type);
}
