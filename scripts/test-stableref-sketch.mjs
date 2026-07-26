// ============================================================
// ToubkalCAD – scripts/test-stableref-sketch.mjs   (Phase 1 step 4 — sketch-on-face)
//
// TEST-FIRST harness. It pins the contract for making a sketch created on a solid
// FACE a FRAME PRODUCER (like a datum), so the sketch — and everything extruded
// from it — FOLLOWS the face when the underlying body changes, instead of staying
// at the workplane baked at creation. This drives behaviour that does NOT exist
// yet; until it's implemented the relevant assertions are expected to fail RED.
//
// The two contracts under test (see docs/PARAMETRIC.md §10.4):
//   1. evaluateSketchFrame(oc, inputs, params) → DatumFrame | null
//      • re-derives the sketch's workplane from a StableRef FaceSig
//        (params.sourceFaceRef = { nodeId, sel }) against the live source body;
//      • falls back to the baked params.workplane on reject / no signature.
//   2. EVALUATORS.sketchWire prefers a frame THREADED through its inputs
//      (firstRole(inputs,'frame').meta.workplane) over its own baked p.workplane,
//      so a wire's local-2D sketchGeom is placed on the re-derived frame.
//
// Compiles the real FeatureEvaluators (+ StableRef) to CJS, drives the kernel.
// Run:  node scripts/test-stableref-sketch.mjs   (from repo root)
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { importCompiledModule, prepareCommonJsOutput } from './import-compiled-cjs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, '.tk-stableref-sketch-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

console.log('compiling FeatureEvaluators + StableRef → CJS …');
execSync(
  `npx tsc "${ROOT}/src/services/FeatureEvaluators.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { stdio: 'inherit' },
);
prepareCommonJsOutput(OUT);
const evMod = await importCompiledModule(OUT, 'services/FeatureEvaluators.js');
const { EVALUATORS, evaluateSketchFrame } = evMod;
const { captureFaceAtPoint } = await importCompiledModule(OUT, 'services/StableRef.js');

const oc = await initOpenCascade();

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const close = (a, b, t = 0.25) => Math.abs(a - b) < t;

// Box spans [0..w]x[0..h]x[0..d]; the +Z TOP face is at z=d, centroid [w/2,h/2,d].
// We grow `d` to move the top face up, so a sketch-on-top-face should track it.
const boxD = (d) => EVALUATORS.box(oc, [], { w: 10, h: 10, d });

// Centre-of-mass Z of a wire shape (LinearProperties, as StableRef.edgeSig uses).
const wireZ = (shape) => {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.LinearProperties(shape, props, false, true);
  const com = props.CentreOfMass();
  const z = com.Z();
  com.delete(); props.delete();
  return z;
};
const frameZ = (frame) => (frame && frame.kind === 'plane' ? frame.workplane.origin[2] : NaN);

// ── Guard: the frame producer may not be implemented yet ──────────────────────
if (typeof evaluateSketchFrame !== 'function') {
  console.log('\n\x1b[33m⚠ evaluateSketchFrame is not exported yet — implement it per the');
  console.log('  scope in docs/PARAMETRIC.md §10.4. The assertions below define its contract.\x1b[0m');
}
const callFrame = (inputs, params) =>
  (typeof evaluateSketchFrame === 'function' ? evaluateSketchFrame(oc, inputs, params) : null);

// Source body + the captured top-face signature, against the SAME placed shape.
const box10 = boxD(10);                                   // top +Z face at z=10
const faceSig = captureFaceAtPoint(oc, box10, [5, 5, 10]);
ok('captured +Z top face (plane, +Z normal)',
  faceSig && faceSig.surf === 'plane' && close(Math.abs(faceSig.axis?.[2] ?? 0), 1, 0.01),
  faceSig ? `centroid=[${faceSig.centroid.map((n) => n.toFixed(0))}] n=[${faceSig.axis.map((n) => n.toFixed(0))}]` : 'null');

// The baked frame (what creation stored); the source-face signature lives in
// params.sourceFaceRef = { nodeId, sel }. inputs[0] is the live source body.
const bakedWp = { label: 'Face', origin: [5, 5, 10], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
const sketchParams = (extra = {}) => ({ workplane: bakedWp, ...extra });
const sourceInput = (shape) => [{ id: 'body', role: 'source', shape, meta: {} }];
const faceRef = { nodeId: 'body', sel: faceSig };

// ─── 1 — sketch frame re-derives the source face plane ────────────────────────
console.log('\n1 — evaluateSketchFrame re-derives the top-face plane (z=10)');
const f0 = callFrame(sourceInput(box10), sketchParams({ sourceFaceRef: faceRef }));
ok('frame on the +Z face at z=10', close(frameZ(f0), 10), `z=${frameZ(f0)?.toFixed?.(2) ?? f0}`);

// ─── 2 — the win: frame FOLLOWS the face when the body grows 10→11 ────────────
console.log('\n2 — sketch frame follows the top face when the body grows d 10→11');
const box11 = boxD(11);   // top face now at z=11
const f1 = callFrame(sourceInput(box11), sketchParams({ sourceFaceRef: faceRef }));
ok('re-derives the moved top face → z=11 (baked would be 10)', close(frameZ(f1), 11),
  `z=${frameZ(f1)?.toFixed?.(2) ?? f1} — followed the face`);

// ─── 3 — graceful fallback when the face moved too far (§6 Phase 1a limit) ────
console.log('\n3 — fallback to baked frame when the signature rejects (d 10→20)');
const box20 = boxD(20);   // top face jumps to z=20 — sig rejects (absolute-position limit)
const f2 = callFrame(sourceInput(box20), sketchParams({ sourceFaceRef: faceRef }));
ok('unresolvable face → falls back to baked frame (z=10), no crash', close(frameZ(f2), 10),
  `z=${frameZ(f2)?.toFixed?.(2) ?? f2} (baked passthrough)`);

// ─── 4 — legacy / plane sketch: no signature → baked passthrough ──────────────
console.log('\n4 — sketch with no face signature uses the baked frame (plane sketch / legacy)');
const f3 = callFrame(sourceInput(box10), sketchParams());   // no sourceFaceRef
ok('no sourceFaceRef → passthrough baked frame (z=10)', close(frameZ(f3), 10),
  `z=${frameZ(f3)?.toFixed?.(2) ?? f3}`);

// ─── 5 — end-to-end: sketchWire is placed on the THREADED frame, not the baked ─
// A circle defined in LOCAL 2D (centre 0,0 r=2) must sit on whatever frame the
// engine threads in via inputs[].meta.workplane (role 'frame'), so it follows the
// face. This pins the sketchWire change: prefer the threaded frame over p.workplane.
console.log('\n5 — sketchWire places its local-2D geom on the threaded frame (z=11), not baked (z=10)');
const circle = { kind: 'circle', c: [0, 0], r: 2 };
const rederived = (f1 && f1.kind === 'plane') ? f1.workplane : { ...bakedWp, origin: [5, 5, 11] };
const frameInput = (wp) => [{ id: 'sk', role: 'frame', shape: null, meta: { workplane: wp } }];
let w5 = NaN;
try { w5 = wireZ(EVALUATORS.sketchWire(oc, frameInput(rederived), sketchParams({ sketchGeom: circle }))); } catch (e) { w5 = `threw: ${e?.message ?? e}`; }
ok('wire centroid follows threaded frame → z=11 (baked p.workplane would be 10)', close(w5, 11),
  `z=${typeof w5 === 'number' ? w5.toFixed(2) : w5}`);

// ─── 6 — sketchWire legacy: no threaded frame → uses baked p.workplane ────────
console.log('\n6 — sketchWire with no threaded frame falls back to baked p.workplane (z=10)');
let w6 = NaN;
try { w6 = wireZ(EVALUATORS.sketchWire(oc, [], sketchParams({ sketchGeom: circle }))); } catch (e) { w6 = `threw: ${e?.message ?? e}`; }
ok('no frame input → baked workplane (z=10)', close(w6, 10),
  `z=${typeof w6 === 'number' ? w6.toFixed(2) : w6}`);

// ─── 7 — REGION wire follows the threaded frame too ───────────────────────────
// A region wire has no sketchGeom: it re-detects a profile from its member ENTITY
// inputs (each carrying meta.sketchGeom) and builds it on `wp`. Since the evaluator
// resolves `wp` once (threaded frame preferred), the region must follow the face
// just like an entity wire. A lone circle member is itself a closed region.
console.log('\n7 — REGION wire (from a member entity) follows the threaded frame (z=11)');
const memberEntity = (id, geom) => ({ id, role: 'entity', shape: null, meta: { sketchGeom: geom } });
const regionInputs = (wp) => [...frameInput(wp), memberEntity('e1', circle)];
let w7 = NaN;
try { w7 = wireZ(EVALUATORS.sketchWire(oc, regionInputs(rederived), sketchParams({ region: true }))); } catch (e) { w7 = `threw: ${e?.message ?? e}`; }
ok('region wire centroid follows threaded frame → z=11', close(w7, 11),
  `z=${typeof w7 === 'number' ? w7.toFixed(2) : w7}`);

// ─── 8 — REGION wire legacy: no threaded frame → baked p.workplane ────────────
console.log('\n8 — REGION wire with no threaded frame falls back to baked p.workplane (z=10)');
let w8 = NaN;
try { w8 = wireZ(EVALUATORS.sketchWire(oc, [memberEntity('e1', circle)], sketchParams({ region: true }))); } catch (e) { w8 = `threw: ${e?.message ?? e}`; }
ok('region wire no frame → baked workplane (z=10)', close(w8, 10),
  `z=${typeof w8 === 'number' ? w8.toFixed(2) : w8}`);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
