// ============================================================
// ToubkalCAD – scripts/test-recompute.mjs
//
// Headless validation of the RecomputeEngine (Phase 1 step 3) against the REAL
// OpenCascade kernel. Unlike test-extrude.mjs (which re-implements OCC calls
// inline), this compiles the actual engine + FeatureGraph + FeatureEvaluators to
// CJS and drives them through a Map-backed mock RecomputeHost — so it exercises
// the shipping code, not a copy.
//
// What it proves:
//   • full recompute builds every shape-producing feature in topo order
//   • EDIT-PROPAGATION — change an upstream sketch radius and ONLY it + its
//     descendants rebuild; the downstream extrude volume tracks it (the headline)
//   • incremental dirty skip — an independent feature keeps its cached shape
//     (same object identity, not recomputed)
//   • datum frames thread to a downstream up-to-plane extrude, and propagate
//   • per-feature error isolation — a bad op marks error + keeps going
//   • rollback frees the tail (the timeline needle)
//
// Run:  node scripts/test-recompute.mjs   (compiles, then runs; from repo root)
// Exits non-zero if any assertion fails.
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import initOpenCascade from 'opencascade.js/dist/node.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Compile INSIDE the repo so the compiled CJS resolves 'three' up the
// node_modules tree (a /tmp outDir can't). This repo tracks node_modules and has
// no .gitignore, so the build dir is removed on exit (see cleanup() below).
const OUT  = path.join(ROOT, '.tk-recompute-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

// ─── Compile the engine + its dependency tree to CommonJS ─────────────────────
console.log('compiling RecomputeEngine + deps → CJS …');
execSync(
  `npx tsc "${ROOT}/src/services/RecomputeEngine.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { stdio: 'inherit' },
);
const { recompute }                  = await import(`${OUT}/services/RecomputeEngine.js`);
const { buildFeatureGraph, dirtySet } = await import(`${OUT}/services/FeatureGraph.js`);

const oc = await initOpenCascade();

// ─── Assert harness ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const near = (a, b, tol = 0.03) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < tol;
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
}
function volume(shape) {
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, p, false, false, false);
  const v = p.Mass(); p.delete(); return v;
}

// ─── Map-backed mock host (place = identity; meta = node.params) ───────────────
function mockHost(nodes) {
  const shapes = new Map();
  const changed = [], removed = [], frames = [];
  return {
    oc,
    getShape: (id) => shapes.get(id),
    setShape: (id, s) => { const old = shapes.get(id); if (old && old !== s) { try { old.delete(); } catch {} } shapes.set(id, s); },
    freeShape: (id) => { const s = shapes.get(id); if (s) { try { s.delete(); } catch {} } shapes.delete(id); },
    place: (_id, shape) => shape,               // synthetic nodes have no placement
    meta: (id) => nodes[id]?.params,
    onChanged: (id) => changed.push(id),
    onRemoved: (id) => removed.push(id),
    onFrame: (id, fr) => frames.push({ id, fr }),
    _shapes: shapes, _changed: changed, _removed: removed, _frames: frames,
  };
}

// ─── Synthetic scene (only id/type/params — what the adapter reads) ───────────
const XY = (z = 0) => ({ label: 'P', origin: [0, 0, z], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] });
const n = (id, type, params) => ({ id, type, params, transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });

function scene() {
  return {
    // sketch → extrude chain (the propagation subject)
    wire1: n('wire1', 'sketch_wire', { workplane: XY(), sketchGeom: { kind: 'circle', c: [0, 0], r: 5 } }),
    ext1:  n('ext1',  'extrusion',   { opType: 'extrude', targetWireIds: ['wire1'], opParams: { h: 10, endMode: 0 } }),
    // an independent body (cache-skip subject)
    solo:  n('solo',  'box',         { w: 10, h: 10, d: 10 }),
    // datum midplane → up-to-plane extrude (frame threading subject)
    pA:    n('pA',    'datum_plane',  { workplane: XY(0) }),
    pB:    n('pB',    'datum_plane',  { workplane: XY(20) }),
    dpm:   n('dpm',   'datum_plane',  { method: 'midplane', refs: [{ nodeId: 'pA', kind: 'face' }, { nodeId: 'pB', kind: 'face' }] }),
    wire2: n('wire2', 'sketch_wire', { workplane: XY(), sketchGeom: { kind: 'circle', c: [0, 0], r: 5 } }),
    ext2:  n('ext2',  'extrusion',   { opType: 'extrude', targetWireIds: ['wire2'], targetDatumId: 'dpm', opParams: { endMode: 6 } }),
    // a deliberately broken op (error-isolation subject): CUT with no tool
    bad1:  n('bad1',  'boolean_operation', { boolOp: 'CUT', baseId: 'solo', toolIds: [] }),
  };
}

const CYL = (r, h) => Math.PI * r * r * h;

// ─── Pass 1 — full recompute ──────────────────────────────────────────────────
console.log('\n1 — full recompute (whole graph, no dirty set)');
const nodes = scene();
let graph = buildFeatureGraph(nodes);
const host = mockHost(nodes);
let rep = recompute(host, graph, {});

ok('topo order: wire1 before ext1', graph.order.indexOf('wire1') < graph.order.indexOf('ext1'), graph.order.join('→'));
ok('ext1 = cylinder r5×h10 (~785)', near(volume(host._shapes.get('ext1')), CYL(5, 10)), `vol=${volume(host._shapes.get('ext1')).toFixed(0)}`);
ok('solo box built (~1000)',        near(volume(host._shapes.get('solo')), 1000), `vol=${volume(host._shapes.get('solo')).toFixed(0)}`);
ok('dpm midplane frame computed',   host._frames.some((f) => f.id === 'dpm' && Math.abs(f.fr.workplane.origin[2] - 10) < 1e-6), JSON.stringify(host._frames.find((f) => f.id === 'dpm')?.fr?.workplane?.origin));
ok('ext2 up-to-plane z=10 (~785)',  near(volume(host._shapes.get('ext2')), CYL(5, 10)), `vol=${volume(host._shapes.get('ext2')).toFixed(0)}`);
ok('bad1 (CUT, no tool) → error',   rep.results.find((r) => r.id === 'bad1')?.status === 'error', rep.errors.bad1 ?? '');
ok('bad1 error did not stop the pass', rep.ok >= 5 && rep.errored === 1, `ok=${rep.ok} errored=${rep.errored}`);

// ─── Pass 2 — edit upstream sketch radius → downstream rebuilds, peers cached ──
console.log('\n2 — edit wire1 radius 5→8 (dirty propagation + cache skip)');
const ext1Before = host._shapes.get('ext1');
const soloBefore = host._shapes.get('solo');
const ext2Before = host._shapes.get('ext2');
nodes.wire1.params.sketchGeom.r = 8;
graph = buildFeatureGraph(nodes);
const dirty1 = dirtySet(graph, 'wire1');
rep = recompute(host, graph, { dirty: dirty1 });

ok('dirty set = {wire1, ext1}', dirty1.has('wire1') && dirty1.has('ext1') && !dirty1.has('solo') && !dirty1.has('ext2'), [...dirty1].join(','));
ok('ext1 tracks radius → ~2011 (r8)', near(volume(host._shapes.get('ext1')), CYL(8, 10)), `vol=${volume(host._shapes.get('ext1')).toFixed(0)}`);
ok('ext1 shape was replaced',      host._shapes.get('ext1') !== ext1Before);
ok('solo NOT recomputed (same ref)', host._shapes.get('solo') === soloBefore, rep.results.find((r) => r.id === 'solo')?.status);
ok('ext2 NOT recomputed (same ref)', host._shapes.get('ext2') === ext2Before, rep.results.find((r) => r.id === 'ext2')?.status);
ok('reused count = clean features', rep.reused >= 4, `reused=${rep.reused}`);

// ─── Pass 3 — move upstream datum → midplane + up-to-plane extrude follow ──────
console.log('\n3 — move pB z20→z30 (datum frame propagation)');
nodes.pB.params.workplane = XY(30);
graph = buildFeatureGraph(nodes);
const dirty2 = dirtySet(graph, 'pB');
rep = recompute(host, graph, { dirty: dirty2 });

ok('dirty set ⊇ {pB, dpm, ext2}', ['pB', 'dpm', 'ext2'].every((id) => dirty2.has(id)), [...dirty2].join(','));
ok('dpm midplane → z15', host._frames.some((f) => f.id === 'dpm' && Math.abs(f.fr.workplane.origin[2] - 15) < 1e-6), JSON.stringify(host._frames.filter((f) => f.id === 'dpm').pop()?.fr?.workplane?.origin));
ok('ext2 follows datum → z[0,15] (~1178)', near(volume(host._shapes.get('ext2')), CYL(5, 15)), `vol=${volume(host._shapes.get('ext2')).toFixed(0)}`);

// ─── Pass 4 — rollback past the needle frees the tail ─────────────────────────
console.log('\n4 — rollback to wire1 (timeline needle frees the tail)');
graph = buildFeatureGraph(nodes);
const host2 = mockHost(nodes);
recompute(host2, graph, {});                       // full build first
ok('ext1 alive before rollback', !!host2._shapes.get('ext1'));
rep = recompute(host2, graph, { rollbackId: 'wire1' });
ok('ext1 freed after rollback',  !host2._shapes.get('ext1'));
ok('ext1 emitted onRemoved',     host2._removed.includes('ext1'), host2._removed.join(','));
ok('wire1 (the needle) survives', !!host2._shapes.get('wire1'), 'profile wire still registered');
ok('rolledBack status reported', rep.results.some((r) => r.status === 'rolledBack'), '');

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
