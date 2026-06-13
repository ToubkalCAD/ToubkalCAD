// ============================================================
// ToubkalCAD – scripts/test-stableref-face.mjs   (Phase 1 step 4 — face refs)
//
// Headless proof for the up-to-face stable reference. Two things this covers:
//   1. A REPLAY BUG FIX: the FeatureGraph adapter used to drop `targetFacePoint`
//      (it only copied opParams), so an up-to-face extrude lost its limit on
//      recompute. The adapter now carries targetFacePoint + targetFaceRef.
//   2. The stable face signature: `captureFaceAtPoint` records the picked target
//      face (surface kind + centroid + area + normal); `resolveTargetFacePoint`
//      re-resolves it on the live base and returns that face's current centroid,
//      so the limit tracks the face — robust to an upstream edit that renumbers
//      faces — and falls back to the stored world point when it can't resolve.
//
// Compiles the real FeatureEvaluators (+ StableRef) to CJS, drives the kernel.
// Run:  node scripts/test-stableref-face.mjs   (from repo root)
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import initOpenCascade from 'opencascade.js/dist/node.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, '.tk-stableref-face-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

console.log('compiling FeatureEvaluators + StableRef → CJS …');
execSync(
  `npx tsc "${ROOT}/src/services/FeatureEvaluators.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { stdio: 'inherit' },
);
const { EVALUATORS, resolveTargetFacePoint } = await import(`${OUT}/services/FeatureEvaluators.js`);
const { captureFace, captureFaceAtPoint, resolveFace } = await import(`${OUT}/services/StableRef.js`);

const oc = await initOpenCascade();

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const vec = (a) => `[${a.map((n) => n.toFixed(1)).join(',')}]`;
const close = (a, b, t = 0.3) => Math.abs(a - b) < t;
const v3close = (a, b, t = 0.3) => a && b && Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]) < t;
function volume(s) { const p = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(s, p, false, false, false); const v = p.Mass(); p.delete(); return v; }
function faceCount(shape) { const e = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); let n = 0; while (e.More()) { n++; e.Next(); } e.delete(); return n; }
// 0-based ordinal of the face nearest a point (to show the ordinal actually shifts)
function faceOrdinalAt(shape, pt) {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) { map.Add(exp.Current()); exp.Next(); } exp.delete();
  const v = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt_3(pt[0], pt[1], pt[2])).Vertex();
  let best = -1, bestD = Infinity;
  for (let i = 1; i <= map.Extent(); i++) {
    const dss = new oc.BRepExtrema_DistShapeShape_1(); dss.LoadS1(v); dss.LoadS2(oc.TopoDS.Face_1(map.FindKey(i)));
    dss.Perform(new oc.Message_ProgressRange_1());
    if (dss.IsDone() && dss.Value() < bestD) { bestD = dss.Value(); best = i - 1; }
  }
  map.delete(); return best;
}

const XY = { workplane: { origin: [0, 0, 0], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] } };
const disk = (cx, cy, r) => {
  const loc = new oc.gp_Pnt_3(cx, cy, 0), dir = new oc.gp_Dir_4(0, 0, 1), ax = new oc.gp_Ax2_3(loc, dir);
  const circ = new oc.gp_Circ_2(ax, r), me = new oc.BRepBuilderAPI_MakeEdge_8(circ), edge = me.Edge();
  const mw = new oc.BRepBuilderAPI_MakeWire_2(edge), wire = mw.Wire();
  return { id: 'prof', role: 'profile', shape: wire, meta: XY };
};

// base box [0,0,0]..[10,10,10]; same box with a boss fused on the +X SIDE (top
// face z=10 is geometrically unchanged but every face ordinal is renumbered).
const box   = EVALUATORS.box(oc, [], { w: 10, h: 10, d: 10 });
const boss  = new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(10, 3, 3), 3, 4, 4).Shape();
const fused = EVALUATORS.boolean(oc, [{ role: 'base', shape: box }, { role: 'tool', shape: boss }], { boolOp: 'FUSE' });
const TOP = [5, 5, 10];   // a point on the box's top face

// ─── 1 — captureFaceAtPoint round-trip ────────────────────────────────────────
console.log('\n1 — captureFaceAtPoint + resolve on the same box');
const topSig = captureFaceAtPoint(oc, box, TOP);
ok('captured the top face (plane, area≈100, normal +Z)',
  topSig && topSig.surf === 'plane' && close(topSig.area, 100, 1) && close(Math.abs(topSig.axis?.[2] ?? 0), 1, 0.01),
  topSig ? `centroid=${vec(topSig.centroid)} area=${topSig.area.toFixed(0)} n=${vec(topSig.axis)}` : 'null');
const rr = resolveFace(oc, box, topSig);
ok('resolves to itself on the same box', !rr.rejected && v3close(captureFace(oc, box, rr.index)?.centroid, topSig.centroid),
  `idx=${rr.index} score=${rr.score.toFixed(3)}`);

// ─── 2 — face survives a renumbering fuse ─────────────────────────────────────
console.log('\n2 — top-face signature follows across a +X boss fuse (renumber)');
const ordBox = faceOrdinalAt(box, TOP), ordFused = faceOrdinalAt(fused, TOP);
const rf = resolveFace(oc, fused, topSig);
const resolvedSig = rf.index >= 0 ? captureFace(oc, fused, rf.index) : null;
ok('resolves on the fused body (not rejected)', !rf.rejected, `idx=${rf.index} score=${rf.score.toFixed(3)} runnerUp=${rf.runnerUp.toFixed(3)}`);
ok('resolved face is the SAME top face', resolvedSig && v3close(resolvedSig.centroid, TOP) && close(resolvedSig.area, 100, 1),
  resolvedSig ? `centroid=${vec(resolvedSig.centroid)} area=${resolvedSig.area.toFixed(0)}` : 'none');
console.log(`  → top-face ordinal: ${ordBox} on box vs ${ordFused} on fused ${ordBox !== ordFused ? '(renumbered)' : '(stable here)'}; box faces ${faceCount(box)} → fused ${faceCount(fused)}`);

// ─── 3 — up-to-face REPLAYS correctly through the evaluator (the bug fix) ──────
console.log('\n3 — up-to-face extrude via faceRef (adapter now carries it)');
const upParams = { endMode: 3, targetFaceRef: topSig, targetFacePoint: TOP };
const hp = resolveTargetFacePoint(oc, box, upParams);
ok('resolveTargetFacePoint returns the live top-face centroid', v3close(hp, TOP), `→ ${vec(hp)}`);
const upSolid = EVALUATORS.extrude(oc, [disk(5, 5, 2), { id: 'box', role: 'base', shape: box }], upParams);
ok('extrude up-to-top-face → cylinder z[0,10] (~126)', close(volume(upSolid), Math.PI * 4 * 10, 2), `vol=${volume(upSolid).toFixed(1)}`);

// ─── 4 — limit follows the face on the renumbered base ────────────────────────
console.log('\n4 — same up-to-face on the renumbered (fused) base');
const upFused = EVALUATORS.extrude(oc, [disk(5, 5, 2), { id: 'box', role: 'base', shape: fused }], upParams);
ok('still terminates at z=10 (~126) despite the renumber', close(volume(upFused), Math.PI * 4 * 10, 2), `vol=${volume(upFused).toFixed(1)}`);

// ─── 5 — fallback to the stored point when there's no ref (legacy) ────────────
console.log('\n5 — legacy fallback (no faceRef → stored targetFacePoint)');
const fb = resolveTargetFacePoint(oc, box, { endMode: 3, targetFacePoint: TOP });
ok('returns the stored world point', v3close(fb, TOP), `→ ${vec(fb)}`);
const upLegacy = EVALUATORS.extrude(oc, [disk(5, 5, 2), { id: 'box', role: 'base', shape: box }], { endMode: 3, targetFacePoint: TOP });
ok('legacy up-to-face (point only) still works (~126)', close(volume(upLegacy), Math.PI * 4 * 10, 2), `vol=${volume(upLegacy).toFixed(1)}`);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
