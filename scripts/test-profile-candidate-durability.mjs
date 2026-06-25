// ============================================================
// ToubkalCAD – scripts/test-profile-candidate-durability.mjs
//
// Proves a profile-picked extrude's CANDIDATE profiles survive a save/load.
// A load is a full recompute from an EMPTY registry (cad-rebuild-all →
// regenerateMissing); this drives the REAL RecomputeEngine the same way over a
// synthetic scene that mirrors what the picker persists:
//
//   sketch 'sk'
//     ├─ 8 line entities  → two separate 10×10 squares (A: L1-4, B: L5-8)
//     ├─ region R1 (memberIds L1-4)   ← SELECTED  (in extrude.targetWireIds)
//     ├─ region R2 (memberIds L5-8)   ← DESELECTED (only in profileCandidateIds)
//     └─ extrude ext1 (targetWireIds:[R1], profileCandidateIds:[R1,R2])
//
// The headline assertion: after a from-empty rebuild, R2's OCC wire shape EXISTS
// — so re-opening the extrude can still offer it as a re-addable profile.
//
// Run:  node scripts/test-profile-candidate-durability.mjs   (from repo root)
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import initOpenCascade from 'opencascade.js/dist/node.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, '.tk-candidate-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

console.log('compiling RecomputeEngine + deps → CJS …');
execSync(
  `npx tsc "${ROOT}/src/services/RecomputeEngine.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { stdio: 'inherit' },
);
// The repo root is "type":"module", so .js in OUT would be read as ESM and the
// CJS `exports` would be undefined. A local package.json marks the build CJS.
writeFileSync(path.join(OUT, 'package.json'), '{"type":"commonjs"}');
const { recompute }       = await import(`${OUT}/services/RecomputeEngine.js`);
const { buildFeatureGraph } = await import(`${OUT}/services/FeatureGraph.js`);

const oc = await initOpenCascade();

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const near = (a, b, tol = 0.03) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < tol;
function volume(shape) {
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, p, false, false, false);
  const v = p.Mass(); p.delete(); return v;
}

function mockHost(nodes) {
  const shapes = new Map();
  return {
    oc,
    getShape: (id) => shapes.get(id),
    setShape: (id, s) => { const old = shapes.get(id); if (old && old !== s) { try { old.delete(); } catch {} } shapes.set(id, s); },
    freeShape: (id) => { const s = shapes.get(id); if (s) { try { s.delete(); } catch {} } shapes.delete(id); },
    place: (_id, shape) => shape,
    meta: (id) => nodes[id]?.params,
    onChanged: () => {}, onRemoved: () => {}, onFrame: () => {},
    _shapes: shapes,
  };
}

const XY = { label: 'P', origin: [0, 0, 0], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
const n  = (id, type, params, parentId = null) => ({ id, type, parentId, params, transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });
const line = (id, a, b) => n(id, 'sketch_wire', { workplane: XY, sketchGeom: { kind: 'line', a, b } }, 'sk');
const region = (id, members) => n(id, 'sketch_wire', { workplane: XY, region: true, memberIds: members }, 'sk');

function scene() {
  return {
    sk: n('sk', 'sketch', { workplane: XY }),
    // square A (selected profile R1)
    L1: line('L1', [0, 0], [10, 0]),  L2: line('L2', [10, 0], [10, 10]),
    L3: line('L3', [10, 10], [0, 10]), L4: line('L4', [0, 10], [0, 0]),
    // square B (DESELECTED candidate profile R2)
    L5: line('L5', [20, 0], [30, 0]),  L6: line('L6', [30, 0], [30, 10]),
    L7: line('L7', [30, 10], [20, 10]), L8: line('L8', [20, 10], [20, 0]),
    R1: region('R1', ['L1', 'L2', 'L3', 'L4']),
    R2: region('R2', ['L5', 'L6', 'L7', 'L8']),
    // extrude consumes only R1, but remembers BOTH as candidates
    ext1: n('ext1', 'extrusion', { opType: 'extrude', targetWireIds: ['R1'], profileCandidateIds: ['R1', 'R2'], opParams: { h: 10, endMode: 0 } }),
  };
}

console.log('\nLoad = full recompute from an EMPTY registry (cad-rebuild-all):');
const nodes = scene();
const graph = buildFeatureGraph(nodes);
const host  = mockHost(nodes);
recompute(host, graph, {});                 // dirty omitted → build the whole graph

ok('R1 (selected) wire rebuilt',        !!host._shapes.get('R1'));
ok('R2 (DESELECTED candidate) rebuilt', !!host._shapes.get('R2'), 'durable across load');
ok('ext1 = one 10×10×10 block (~1000)', near(volume(host._shapes.get('ext1')), 1000), `vol=${volume(host._shapes.get('ext1')).toFixed(0)}`);

// The whole point: R2 has a live shape, so the picker can re-offer it.
ok('candidate R2 resolvable as a profile wire', (() => {
  const w = host._shapes.get('R2');
  if (!w) return false;
  const fm = new oc.BRepBuilderAPI_MakeFace_15(w, true);
  const okFace = fm.IsDone(); fm.delete();
  return okFace;
})());

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
