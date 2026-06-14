// ============================================================
// ToubkalCAD – scripts/test-stableref-datum.mjs   (Phase 1 step 4 — datum faces)
//
// Headless proof that an OFFSET datum plane created from a solid FACE re-derives
// its base frame from that face on recompute (instead of using the frame baked at
// creation), via a StableRef face signature. Covers:
//   • a replay BUG FIX — the FeatureGraph adapter dropped the datum's `refs`, so
//     the offset DISTANCE replayed as 0; it now carries refs (distance + sig).
//   • re-derivation that FOLLOWS a (small) parametric move of the source face,
//     where the baked frame would be stale.
//   • graceful fallback to the baked frame when the signature can't resolve
//     (face moved too far — the §6 Phase 1a limit) or there's no signature.
//
// Compiles the real FeatureEvaluators (+ StableRef) to CJS, drives the kernel.
// Run:  node scripts/test-stableref-datum.mjs   (from repo root)
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import initOpenCascade from 'opencascade.js/dist/node.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, '.tk-stableref-datum-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

console.log('compiling FeatureEvaluators + StableRef → CJS …');
execSync(
  `npx tsc "${ROOT}/src/services/FeatureEvaluators.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { stdio: 'inherit' },
);
const { EVALUATORS, evaluateDatum } = await import(`${OUT}/services/FeatureEvaluators.js`);
const { captureFaceAtPoint } = await import(`${OUT}/services/StableRef.js`);

const oc = await initOpenCascade();

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const close = (a, b, t = 0.25) => Math.abs(a - b) < t;
const boxW = (w) => EVALUATORS.box(oc, [], { w, h: 10, d: 10 });   // [0..w]x[0..10]x[0..10], +X face at x=w

// Source: box w=10, +X face at x=10. Offset +5 along +X → datum plane at x=15.
const box10 = boxW(10);
const faceSig = captureFaceAtPoint(oc, box10, [10, 5, 5]);          // the +X face
ok('captured +X source face (plane, +X normal)',
  faceSig && faceSig.surf === 'plane' && close(Math.abs(faceSig.axis?.[0] ?? 0), 1, 0.01),
  faceSig ? `centroid=[${faceSig.centroid.map((n) => n.toFixed(0))}] n=[${faceSig.axis.map((n) => n.toFixed(0))}]` : 'null');

const DIST = 5;
const bakedWp = { label: 'Offset', origin: [15, 5, 5], normal: [1, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };
// The datum feature: refs carry distance + the face signature; `workplane` is the
// baked frame used as the fallback. The body is the resolved input shape.
const datumParams = (extraRef = {}) => ({ datum: 'plane', method: 'offset', workplane: bakedWp,
  refs: [{ kind: 'face', nodeId: 'box', distance: DIST, ...extraRef }] });
const faceInput = (shape) => [{ id: 'box', role: 'face', shape, meta: {} }];   // body, no workplane in meta
const planeX = (frame) => (frame && frame.kind === 'plane' ? frame.workplane.origin[0] : NaN);

// ─── 1 — replay correctness: distance applied (was dropped → 0) ───────────────
console.log('\n1 — offset distance is honoured on replay (adapter now carries refs)');
const f0 = evaluateDatum(oc, 'datum_plane', faceInput(box10), datumParams({ sel: faceSig }));
ok('re-derives +X face + 5 → plane at x=15 (not x=10, not 0)', close(planeX(f0), 15), `x=${planeX(f0).toFixed(2)}`);

// ─── 2 — the win: datum FOLLOWS a small parametric move of the source face ────
console.log('\n2 — datum follows the source face when the body widens 10→11');
const box11 = boxW(11);   // +X face now at x=11
const f1 = evaluateDatum(oc, 'datum_plane', faceInput(box11), datumParams({ sel: faceSig }));
ok('re-derives the moved +X face (x=11) + 5 → x=16 (baked would be 15)', close(planeX(f1), 16),
  `x=${planeX(f1).toFixed(2)} — followed the face`);

// ─── 3 — graceful fallback when the face moved too far to resolve (§6 limit) ──
console.log('\n3 — fallback to baked frame when the signature rejects (body 10→20)');
const box20 = boxW(20);   // +X face jumps to x=20 — sig rejects (absolute-position Phase 1a limit)
const f2 = evaluateDatum(oc, 'datum_plane', faceInput(box20), datumParams({ sel: faceSig }));
ok('unresolvable face → falls back to baked frame (x=15), no crash', close(planeX(f2), 15),
  `x=${planeX(f2).toFixed(2)} (baked passthrough)`);

// ─── 4 — legacy: no signature → baked passthrough ─────────────────────────────
console.log('\n4 — legacy datum (no face signature) uses the baked frame');
const f3 = evaluateDatum(oc, 'datum_plane', faceInput(box10), datumParams());   // no sel
ok('no sel → passthrough baked frame (x=15)', close(planeX(f3), 15), `x=${planeX(f3).toFixed(2)}`);

// ─── 5 — datum-source offset still follows (regression: meta.workplane path) ──
console.log('\n5 — offset from a DATUM source still follows via meta.workplane');
const srcWp = { label: 'XY', origin: [0, 0, 7], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
const f4 = evaluateDatum(oc, 'datum_plane',
  [{ id: 'd', role: 'datum', shape: null, meta: { workplane: srcWp } }],
  { datum: 'plane', method: 'offset', workplane: bakedWp, refs: [{ kind: 'datum', nodeId: 'd', distance: 4 }] });
ok('datum source z=7 + 4 → plane z=11', f4 && close(f4.workplane.origin[2], 11), `z=${f4 ? f4.workplane.origin[2].toFixed(2) : '—'}`);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
