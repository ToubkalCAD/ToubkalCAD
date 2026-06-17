// ============================================================
// ToubkalCAD – scripts/test-loft-sketch-binding.mjs
//
// Proves the parametric fix for "edit a sketch → loft doesn't regenerate
// (Shape not in WASM registry)". The loft now binds to the SKETCH containers,
// not the transient entity wires, so its dependency edges survive replacing an
// entity (rectangle → polygon-8). Tests the REAL FeatureGraph (Node strips the
// TS types) — no browser, no OCC needed; this is pure DAG logic.
//
// Run:  node scripts/test-loft-sketch-binding.mjs
// ============================================================

import { buildFeatureGraph, descendants, topoSort } from '../src/services/FeatureGraph.ts';

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  (${detail})` : ''}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  (${detail})` : ''}`); }
};

// Minimal CADNode factory (only the fields FeatureGraph reads).
const node = (id, type, parentId, params = {}) => ([id, {
  id, name: id, type, parentId, params,
  visible: true, locked: false, notes: '',
  children: [], transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
  material: {},
}]);

// Scene: box + two sketches on its faces, each with one closed entity, lofted.
// The loft binds to the SKETCH ids (the fix), not the entity ids.
function scene(rectOrPoly) {
  return Object.fromEntries([
    node('box', 'box', null, { w: 10, h: 10, d: 10 }),
    node('sk1', 'sketch', 'loft', { workplane: { origin:[0,0,0], normal:[0,0,1], label:'Z' }, sourceFaceRef: { nodeId: 'box', sel: {} } }),
    node(rectOrPoly, 'sketch_wire', 'sk1', { workplane: {}, sketchGeom: { kind: 'polyline', pts: [[0,0],[10,0],[10,10],[0,10]] } }),
    node('sk2', 'sketch', 'loft', { workplane: { origin:[0,0,10], normal:[0,0,1], label:'Z' }, sourceFaceRef: { nodeId: 'box', sel: {} } }),
    node('circ', 'sketch_wire', 'sk2', { workplane: {}, sketchGeom: { kind: 'circle', c: [5,5], r: 4 } }),
    node('loft', 'loft', null, { opType: 'loft', targetWireIds: ['sk1', 'sk2'], opParams: { solid: 1, ruled: 0 } }),
  ]);
}

console.log('\nG1 — loft binds to sketch containers (edges exist, acyclic, ordered)');
{
  const g = buildFeatureGraph(scene('rect'));
  const loft = g.features['loft'];
  const profiles = loft.inputs.filter((i) => i.role === 'profile').map((i) => i.id).sort();
  ok('loft has 2 profile inputs → the two sketches', JSON.stringify(profiles) === '["sk1","sk2"]', profiles.join(','));
  ok('loft marked complete (has profile inputs)', loft.complete === true);
  ok('no cycles (sketch reparented under loft does NOT loop)', g.cycles.length === 0, `cycles=${g.cycles.length}`);
  const { order } = topoSort(g.features, g.order);
  ok('topo order: box & sketches before loft',
     order.indexOf('box') < order.indexOf('sk1') && order.indexOf('sk1') < order.indexOf('loft') && order.indexOf('sk2') < order.indexOf('loft'));
  ok('editing sk1 dirties the loft (descendants include it)', descendants(g, 'sk1').has('loft'));
  ok('editing sk2 dirties the loft', descendants(g, 'sk2').has('loft'));
}

console.log('\nG2 — REPLACING the entity (rect → polygon-8) keeps the loft bound');
{
  // Old bug: loft.targetWireIds pointed at the rect ENTITY id; deleting it →
  // dangling input → loft is no longer a descendant of the sketch and its build
  // fails ("not in WASM registry"). With sketch binding the entity id never
  // appears in targetWireIds, so the dependency is unaffected by the swap.
  const g = buildFeatureGraph(scene('poly8'));      // entity id changed: 'rect' → 'poly8'
  const loft = g.features['loft'];
  const profiles = loft.inputs.filter((i) => i.role === 'profile').map((i) => i.id).sort();
  ok('loft STILL bound to both sketches after entity swap', JSON.stringify(profiles) === '["sk1","sk2"]', profiles.join(','));
  ok('no dangling profile input (targetWireIds never named the entity)',
     loft.inputs.every((i) => g.features[i.id]));
  ok('editing the sketch still dirties the loft', descendants(g, 'sk1').has('loft'));
}

console.log('\nG3 — counter-check: the OLD entity-id binding WOULD dangle on swap');
{
  // Simulate the pre-fix recipe: targetWireIds names the entity id directly.
  const nodes = scene('poly8');
  nodes['loft'].params.targetWireIds = ['rect', 'circ'];   // 'rect' no longer exists (now 'poly8')
  const g = buildFeatureGraph(nodes);
  const loft = g.features['loft'];
  // Dangling inputs stay in the list but are skipped in edge traversal — only
  // those pointing at a live feature actually constrain/propagate.
  const liveProfiles = loft.inputs.filter((i) => i.role === 'profile' && g.features[i.id]).map((i) => i.id);
  ok('old binding: only 1 LIVE profile (the rect entity edge dangled)',
     liveProfiles.length === 1 && liveProfiles[0] === 'circ', `live=[${liveProfiles}]`);
  ok('old binding: editing the sketch does NOT reach the loft (→ the bug)',
     !descendants(g, 'sk1').has('loft'));
}

// Single-sketch op (extrude / revolve) bound to a sketch container.
function opScene(opType, entityId) {
  return Object.fromEntries([
    node('box', 'box', null, { w: 10, h: 10, d: 10 }),
    node('sk1', 'sketch', 'op', { workplane: { origin:[0,0,0], normal:[0,0,1], label:'Z' }, sourceFaceRef: { nodeId: 'box', sel: {} } }),
    node(entityId, 'sketch_wire', 'sk1', { workplane: {}, sketchGeom: { kind: 'circle', c: [5,5], r: 4 } }),
    node('op', opType, null, { opType: opType === 'extrusion' ? 'extrude' : 'revolve', targetWireIds: ['sk1'], opParams: {} }),
  ]);
}

console.log('\nG4 — extrude & revolve bind to the sketch (survive entity swap)');
for (const [label, opType] of [['extrude', 'extrusion'], ['revolve', 'revolve']]) {
  const g1 = buildFeatureGraph(opScene(opType, 'circA'));
  const op1 = g1.features['op'];
  ok(`${label}: profile input is the sketch`, op1.inputs.some((i) => i.role === 'profile' && i.id === 'sk1'));
  ok(`${label}: complete + sketch dirties it`, op1.complete && descendants(g1, 'sk1').has('op'));
  // Replace the entity (circA → circB, e.g. circle → polygon): binding unaffected.
  const g2 = buildFeatureGraph(opScene(opType, 'circB'));
  ok(`${label}: still bound after entity swap`,
     g2.features['op'].inputs.some((i) => i.role === 'profile' && i.id === 'sk1') && descendants(g2, 'sk1').has('op'));
}

// ── healOpProfileTargets: pure re-implementation mirror ──────────────────────
// healOpProfileTargets() in sketchProfile.ts depends on the Zustand store, which
// isn't headless-friendly, so this mirrors its exact rules against a plain node
// map to lock the behaviour the image's broken Loft1 needs. (The real function is
// covered by tsc + in-app; this guards the algorithm.)
function healTargets(nodes, opId) {
  const op = nodes[opId];
  if (!op) return [];
  const stored = op.params?.targetWireIds ?? [];
  if (!stored.length) return stored;
  const parentOf = (id) => {
    const n = nodes[id];
    if (n?.type === 'sketch') return id;
    if (n?.type === 'sketch_wire' && n.parentId && nodes[n.parentId]?.type === 'sketch') return n.parentId;
    return null;
  };
  const parentCount = new Map(), covered = new Set();
  for (const t of stored) { const par = parentOf(t); if (par) { parentCount.set(par, (parentCount.get(par) ?? 0) + 1); covered.add(par); } }
  const pool = (op.children ?? []).filter((id) => nodes[id]?.type === 'sketch' && !covered.has(id));
  const healed = [];
  for (const t of stored) {
    const n = nodes[t];
    if (!n) { const r = pool.shift(); if (r) healed.push(r); continue; }
    if (n.type === 'sketch') { healed.push(t); continue; }
    if (n.type === 'sketch_wire') {
      const par = parentOf(t);
      if (par && parentCount.get(par) === 1) { healed.push(par); continue; }
      healed.push(t); continue;
    }
    healed.push(t);
  }
  return healed;
}

console.log('\nG5 — self-heal the image bug: loft with a DELETED wire target + a valid wire');
{
  // Loft1 created pre-binding: targets were [rect-wire, circle-wire]. User replaced
  // the rectangle (rectW deleted, polyW added); circle wire still live. The loft
  // adopted both sketch containers as children.
  const nodes = Object.fromEntries([
    node('box', 'box', null, {}),
    node('sk4', 'sketch', 'loft', { workplane: {} }),
    node('polyW', 'sketch_wire', 'sk4', { sketchGeom: { kind: 'polyline', pts: [[0,0],[1,0],[1,1]] } }), // replacement
    node('sk5', 'sketch', 'loft', { workplane: {} }),
    node('circW', 'sketch_wire', 'sk5', { sketchGeom: { kind: 'circle', c: [0,0], r: 1 } }),             // still live
    node('loft', 'loft', null, { opType: 'loft', targetWireIds: ['rectW', 'circW'] }),                   // rectW is GONE
  ]);
  nodes['loft'].children = ['sk4', 'sk5'];
  const healed = healTargets(nodes, 'loft');
  ok('missing rect-wire recovered → its sketch (sk4)', healed[0] === 'sk4', `[${healed}]`);
  ok('live circle-wire rebound → its sketch (sk5)', healed[1] === 'sk5', `[${healed}]`);
  ok('both targets now resolvable sketch containers', healed.every((id) => nodes[id]?.type === 'sketch'));

  // After healing, the rebuilt graph must bind the loft to both sketches.
  nodes['loft'].params.targetWireIds = healed;
  const g = buildFeatureGraph(nodes);
  const profiles = g.features['loft'].inputs.filter((i) => i.role === 'profile').map((i) => i.id).sort();
  ok('graph: loft bound to sk4 & sk5 after heal', JSON.stringify(profiles) === '["sk4","sk5"]', profiles.join(','));
  ok('graph: editing either sketch dirties the loft',
     descendants(g, 'sk4').has('loft') && descendants(g, 'sk5').has('loft'));
}

console.log('\nG6 — heal preserves multi-region extrude (does NOT collapse wires)');
{
  // Two region wires under ONE sketch (Multi-Pad) → both kept, not merged to sketch.
  const nodes = Object.fromEntries([
    node('sk', 'sketch', 'ext', { workplane: {} }),
    node('rA', 'sketch_wire', 'sk', { region: true, memberIds: [] }),
    node('rB', 'sketch_wire', 'sk', { region: true, memberIds: [] }),
    node('ext', 'extrusion', null, { opType: 'extrude', targetWireIds: ['rA', 'rB'] }),
  ]);
  nodes['ext'].children = ['sk'];
  const healed = healTargets(nodes, 'ext');
  ok('multi-region wires kept as-is (no collapse to the shared sketch)',
     JSON.stringify(healed) === '["rA","rB"]', `[${healed}]`);
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed ? 1 : 0);
