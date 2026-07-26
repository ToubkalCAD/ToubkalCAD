// ============================================================
// ToubkalCAD – scripts/test-stableref-blend.mjs   (Phase 1 step 4 validation)
//
// Headless proof that the fillet/chamfer edge selection survives upstream edits
// once migrated off raw positional ordinals to StableRef geometric signatures.
// Compiles the real FeatureEvaluators (+ StableRef) to CJS and drives them
// against the kernel — no copy of the logic.
//
// The headline: an upstream change that RENUMBERS edges (here, fusing a boss
// onto a cube) shifts a bottom edge's ordinal, so the legacy raw index would
// grab the WRONG edge — but the signature re-resolves to the same geometric
// edge. Plus: identity round-trip, raw-index fallback when a signature can't be
// resolved, hard-error when nothing resolves, and legacy (no-refs) passthrough.
//
// Run:  node scripts/test-stableref-blend.mjs   (from repo root)
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { importCompiledModule, prepareCommonJsOutput } from './import-compiled-cjs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, '.tk-stableref-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

console.log('compiling FeatureEvaluators + StableRef → CJS …');
execSync(
  `npx tsc "${ROOT}/src/services/FeatureEvaluators.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { stdio: 'inherit' },
);
prepareCommonJsOutput(OUT);
const { EVALUATORS, resolveBlendEdges } = await importCompiledModule(OUT, 'services/FeatureEvaluators.js');
const { captureEdge, captureEdges, resolveEdge } = await importCompiledModule(OUT, 'services/StableRef.js');

const oc = await initOpenCascade();

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const vec = (a) => `[${a.map((n) => n.toFixed(1)).join(',')}]`;
function faceCount(shape) {
  const e = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0; while (e.More()) { n++; e.Next(); } e.delete(); return n;
}
function edgeCount(shape) {
  const m = new oc.TopTools_IndexedMapOfShape_1();
  const e = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (e.More()) { m.Add(e.Current()); e.Next(); }
  const n = m.Extent(); e.delete(); m.delete(); return n;
}
// find the edge ordinal whose signature satisfies `pred`
function findEdge(shape, pred) {
  for (let i = 0; i < edgeCount(shape); i++) { const s = captureEdge(oc, shape, i); if (s && pred(s)) return { i, s }; }
  return { i: -1, s: null };
}
const close = (a, b, t = 0.2) => Math.abs(a - b) < t;
const v3close = (a, b, t = 0.3) => a && b && Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]) < t;

// ─── Shapes: a unit-ish cube, and the cube with a boss fused on top ───────────
const cube = EVALUATORS.box(oc, [], { w: 10, h: 10, d: 10 });        // corner [0,0,0]..[10,10,10]
const boss = new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(3, 3, 10), 4, 4, 3).Shape();  // sits on top face
const fused = EVALUATORS.boolean(oc, [{ role: 'base', shape: cube }, { role: 'tool', shape: boss }], { boolOp: 'FUSE' });

console.log(`\ncube edges=${edgeCount(cube)}  fused edges=${edgeCount(fused)}  (fuse renumbers the edge map)`);

// ─── 1 — identity round-trip: capture then resolve on the SAME shape ──────────
console.log('\n1 — identity round-trip (capture → resolve on same shape)');
let identOk = true, identDetail = '';
for (const idx of [0, 3, 7, 11]) {
  const sig = captureEdge(oc, cube, idx);
  const r = resolveEdge(oc, cube, sig);
  if (r.rejected || r.index !== idx) { identOk = false; identDetail += `e${idx}→${r.index}(rej=${r.rejected}); `; }
}
ok('every cube edge resolves to itself', identOk, identDetail || 'all 0/3/7/11 round-trip');

// ─── 2 — the core win: signature follows an edge across a renumbering ─────────
console.log('\n2 — index-shuffle robustness (bottom edge survives a top boss fuse)');
// the bottom front edge: a line, mid ≈ [5,0,0], dir ≈ ±X
const target = findEdge(cube, (s) => s.curve === 'line' && v3close(s.mid, [5, 0, 0]) && Math.abs(s.axis?.[0] ?? 0) > 0.99);
ok('found bottom-front edge on cube', target.i >= 0, `index k=${target.i}, mid=${target.s ? vec(target.s.mid) : '—'}`);

const r = resolveEdge(oc, fused, target.s);                 // resolve the cube sig against the FUSED body
ok('signature resolves on the fused body (not rejected)', !r.rejected, `k'=${r.index} score=${r.score.toFixed(3)} runnerUp=${r.runnerUp.toFixed(3)}`);
const resolvedSig = r.index >= 0 ? captureEdge(oc, fused, r.index) : null;
ok('resolved edge is the SAME geometric edge',
  resolvedSig && v3close(resolvedSig.mid, target.s.mid) && close(resolvedSig.length, target.s.length),
  resolvedSig ? `mid ${vec(target.s.mid)}→${vec(resolvedSig.mid)}, len ${target.s.length.toFixed(1)}→${resolvedSig.length.toFixed(1)}` : 'no resolve');
console.log(`  → ordinal shifted by the fuse: k=${target.i} on cube vs k'=${r.index} on fused ${target.i !== r.index ? '(raw index WOULD have grabbed the wrong edge)' : '(ordinal happened to be stable here)'}`);

// ─── 3 — resolveBlendEdges + evaluator end-to-end on the renumbered body ──────
console.log('\n3 — resolveBlendEdges + fillet on the renumbered body');
const params = { blendOp: 'fillet', edgeRefs: [target.s], edgeIndices: [target.i], blendValue: 1 };
const idxs = resolveBlendEdges(oc, fused, params);
ok('resolveBlendEdges picks the signature ordinal, not the stale raw one', idxs.length === 1 && idxs[0] === r.index, `→ [${idxs.join(',')}] (raw was ${target.i})`);
const filleted = EVALUATORS.fillet(oc, [{ role: 'base', shape: fused }], params);
ok('fillet on resolved edge succeeds (face count grows)', faceCount(filleted) > faceCount(fused), `faces ${faceCount(fused)}→${faceCount(filleted)}`);

// ─── 4 — raw-index fallback when a signature can't be resolved ────────────────
console.log('\n4 — raw-index fallback (unresolvable signature → stored ordinal)');
const bogus = { kind: 'edge', curve: 'line', mid: [1000, 1000, 1000], length: 10, axis: [1, 0, 0] };
const fb = resolveBlendEdges(oc, cube, { edgeRefs: [bogus], edgeIndices: [2] });
ok('bogus ref falls back to raw index', fb.length === 1 && fb[0] === 2, `→ [${fb.join(',')}]`);

// ─── 5 — hard error when nothing resolves and no fallback exists ──────────────
console.log('\n5 — hard error (no resolve, no fallback)');
let threw = false;
try { resolveBlendEdges(oc, cube, { edgeRefs: [bogus], edgeIndices: [] }); } catch { threw = true; }
ok('unresolvable ref with no raw fallback throws', threw, threw ? 'threw as expected' : 'did NOT throw');

// ─── 6 — legacy passthrough (no edgeRefs → raw indices unchanged) ─────────────
console.log('\n6 — legacy passthrough (no edgeRefs)');
const legacy = resolveBlendEdges(oc, cube, { edgeIndices: [0, 3, 5] });
ok('legacy node uses raw indices unchanged', JSON.stringify(legacy) === JSON.stringify([0, 3, 5]), `→ [${legacy.join(',')}]`);
const legacyFillet = EVALUATORS.fillet(oc, [{ role: 'base', shape: cube }], { blendOp: 'fillet', edgeIndices: [0], blendValue: 1 });
ok('legacy fillet (indices only) still works', faceCount(legacyFillet) > 6, `faces=${faceCount(legacyFillet)}`);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
