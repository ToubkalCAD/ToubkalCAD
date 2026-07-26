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
import { importCompiledModule, prepareCommonJsOutput } from './import-compiled-cjs.mjs';

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
prepareCommonJsOutput(OUT);
const { EVALUATORS, evaluateDatum } = await importCompiledModule(OUT, 'services/FeatureEvaluators.js');
const { captureFaceAtPoint, lineSigFromPoints, vertexSigFromPoint } = await importCompiledModule(OUT, 'services/StableRef.js');

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

// ─── 6 — ANGLE datum: re-derives the hinge face + edge (step 4, this change) ──
// Plane at 30° hinged about the +X face's bottom edge (along Y at z=0). Captured
// signatures (face + edge) let the datum follow the body; reject → baked fallback.
console.log('\n6 — angle datum re-derives the hinge face/edge from signatures');
const ANGLE = 30;
const faceSig10 = captureFaceAtPoint(oc, box10, [10, 5, 5]);          // +X face on box10
const hingeSig  = lineSigFromPoints([[10, 0, 0], [10, 10, 0]]);       // bottom edge of that face (mid [10,5,0], dir +Y)
const placeholder = { label: '—', origin: [0, 0, 0], normal: [1, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };
const angleParams = (workplane, refOverride = {}) => ({ datum: 'plane', method: 'angle', workplane,
  refs: [{ kind: 'face', nodeId: 'box', angle: ANGLE, sel: faceSig10, edgeSel: hingeSig, ...refOverride }] });

// 6a — re-derivation actually runs (normal rotated 30° off +X, not the placeholder).
const a10 = evaluateDatum(oc, 'datum_plane', faceInput(box10), angleParams(placeholder));
const baked = a10 && a10.kind === 'plane' ? a10.workplane : null;
ok('re-derives the angled plane (|nx| ≈ cos30°, not the placeholder nx=1)',
  baked && close(Math.abs(baked.normal[0]), Math.cos((ANGLE * Math.PI) / 180), 0.02),
  baked ? `nx=${baked.normal[0].toFixed(3)}` : 'null');

// 6b — the win: the angled datum FOLLOWS the face+edge when the body widens 10→11.
const a11 = evaluateDatum(oc, 'datum_plane', faceInput(box11), angleParams(baked ?? placeholder));
ok('body 10→11 → hinge/anchor shift +1 in x (datum followed the face)',
  baked && a11 && a11.kind === 'plane' && close(a11.workplane.origin[0] - baked.origin[0], 1),
  baked && a11 && a11.kind === 'plane' ? `Δx=${(a11.workplane.origin[0] - baked.origin[0]).toFixed(2)}` : '—');

// 6c — reject → baked fallback (body jumps 10→20, signatures resolve too far).
const a20 = evaluateDatum(oc, 'datum_plane', faceInput(box20), angleParams(baked ?? placeholder));
ok('unresolvable hinge → falls back to baked angled frame, no crash',
  baked && a20 && a20.kind === 'plane' && close(a20.workplane.origin[0], baked.origin[0]),
  baked && a20 && a20.kind === 'plane' ? `x=${a20.workplane.origin[0].toFixed(2)} (baked)` : '—');

// 6d — legacy angle datum (no signatures) → baked passthrough.
const aL = evaluateDatum(oc, 'datum_plane', faceInput(box10),
  { datum: 'plane', method: 'angle', workplane: baked ?? placeholder, refs: [{ kind: 'face', nodeId: 'box', angle: ANGLE }] });
ok('no sel/edgeSel → passthrough baked frame',
  baked && aL && aL.kind === 'plane' && close(aL.workplane.origin[0], baked.origin[0]),
  baked && aL && aL.kind === 'plane' ? `x=${aL.workplane.origin[0].toFixed(2)}` : '—');

// ─── 7 — TANGENT datum: re-derives the cylinder axis + radius (step 4) ────────
// Tangent plane at the +X side of a Z-cylinder (r=5,h=15): origin (5,0,7.5), n=+X.
// Captured cylinder FaceSig + hit point → follows a radius change; rejects on a big one.
console.log('\n7 — tangent datum follows the cylinder radius via signatures');
const cyl = (r) => EVALUATORS.cylinder(oc, [], { r, h: 15 });   // axis +Z through origin, side at radius r
const cyl5 = cyl(5);
const hitPt = [5, 0, 7.5];                                      // +X surface point, mid-height
const cylSig = captureFaceAtPoint(oc, cyl5, hitPt);            // the cylindrical side face
const tanParams = (workplane, refOverride = {}) => ({ datum: 'plane', method: 'tangent', workplane,
  refs: [{ kind: 'cylinder', nodeId: 'cyl', sel: cylSig, point: hitPt, ...refOverride }] });
const bodyInput = (id, shape) => [{ id, role: 'src', shape, meta: {} }];

const t5 = evaluateDatum(oc, 'datum_plane', bodyInput('cyl', cyl5), tanParams(placeholder));
const tanBaked = t5 && t5.kind === 'plane' ? t5.workplane : null;
ok('re-derives the tangent plane (origin x≈5, normal≈+X)',
  tanBaked && close(tanBaked.origin[0], 5) && close(Math.abs(tanBaked.normal[0]), 1, 0.01),
  tanBaked ? `o=[${tanBaked.origin.map((n) => n.toFixed(1))}] nx=${tanBaked.normal[0].toFixed(2)}` : 'null');

const t6 = evaluateDatum(oc, 'datum_plane', bodyInput('cyl', cyl(6)), tanParams(tanBaked ?? placeholder));
ok('cylinder r 5→6 → tangent origin x follows to ≈6 (baked would be 5)',
  t6 && t6.kind === 'plane' && close(t6.workplane.origin[0], 6),
  t6 && t6.kind === 'plane' ? `x=${t6.workplane.origin[0].toFixed(2)}` : '—');

const t10 = evaluateDatum(oc, 'datum_plane', bodyInput('cyl', cyl(10)), tanParams(tanBaked ?? placeholder));
ok('cylinder r 5→10 → signature rejects → baked tangent fallback (x≈5)',
  tanBaked && t10 && t10.kind === 'plane' && close(t10.workplane.origin[0], tanBaked.origin[0]),
  t10 && t10.kind === 'plane' ? `x=${t10.workplane.origin[0].toFixed(2)} (baked)` : '—');

// ─── 8 — THREE-POINT datum: re-resolves picked vertices (step 4, this change) ─
// Plane through 3 corners of the +X face of box w (all x=w) → the x=w plane.
console.log('\n8 — 3-point datum re-resolves its picked vertices on the live body');
const corners = [[10, 0, 0], [10, 10, 0], [10, 10, 10]];       // three box10 vertices, all x=10
const tpParams = (workplane, withSig = true) => ({ datum: 'plane', method: 'threePoint', workplane,
  refs: corners.map((c) => ({ kind: 'point', pos: c, nodeId: 'box', ...(withSig ? { sel: vertexSigFromPoint(c) } : {}) })) });
const tpBaked = { label: '3pt', origin: [10, 0, 0], normal: [1, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };

const p10 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box10), tpParams(tpBaked));
ok('re-resolves the 3 vertices on box10 → plane origin x≈10',
  p10 && p10.kind === 'plane' && close(p10.workplane.origin[0], 10), p10 && p10.kind === 'plane' ? `x=${p10.workplane.origin[0].toFixed(2)}` : '—');

const p11 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box11), tpParams(tpBaked));
ok('body 10→11 → the 3 corners follow → plane origin x≈11 (baked would be 10)',
  p11 && p11.kind === 'plane' && close(p11.workplane.origin[0], 11), p11 && p11.kind === 'plane' ? `x=${p11.workplane.origin[0].toFixed(2)}` : '—');

const p20 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box20), tpParams(tpBaked));
ok('body 10→20 → vertices reject → all-or-nothing → baked plane (x≈10)',
  p20 && p20.kind === 'plane' && close(p20.workplane.origin[0], 10), p20 && p20.kind === 'plane' ? `x=${p20.workplane.origin[0].toFixed(2)} (baked)` : '—');

const pL = evaluateDatum(oc, 'datum_plane', bodyInput('box', box10), tpParams(tpBaked, false));
ok('legacy 3-point (no vertex sigs) → passthrough baked frame (x≈10)',
  pL && pL.kind === 'plane' && close(pL.workplane.origin[0], 10), pL && pL.kind === 'plane' ? `x=${pL.workplane.origin[0].toFixed(2)}` : '—');

// ─── 9 — NORMAL-TO-CURVE datum: re-samples the edge at its fraction (step 4) ──
// Plane normal to the box's +X/-Y vertical-ish edge (along Y at x=10,z=0) at 50%
// → origin at the edge midpoint (10,5,0). EdgeSig + fraction follow the edge.
console.log('\n9 — normal-to-curve datum re-samples its edge on the live body');
const ncSig = lineSigFromPoints([[10, 0, 0], [10, 10, 0]]);    // box edge along +Y at x=10,z=0
const ncBaked = { label: 'N2C', origin: [10, 5, 0], normal: [0, 1, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] };
const ncParams = (withSig = true) => ({ datum: 'plane', method: 'normalToCurve', workplane: ncBaked,
  refs: [{ kind: 'edge', nodeId: 'box', fraction: 0.5, ...(withSig ? { sel: ncSig } : {}) }] });
const closeV = (v, t, tol = 0.25) => v && close(v[0], t[0], tol) && close(v[1], t[1], tol) && close(v[2], t[2], tol);

const n10 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box10), ncParams());
ok('re-samples edge on box10 → origin at midpoint (10,5,0)',
  n10 && n10.kind === 'plane' && closeV(n10.workplane.origin, [10, 5, 0]), n10 && n10.kind === 'plane' ? `o=[${n10.workplane.origin.map((n) => n.toFixed(1))}]` : '—');

const n11 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box11), ncParams());
ok('body 10→11 → edge follows → origin x≈11 (baked would be 10)',
  n11 && n11.kind === 'plane' && close(n11.workplane.origin[0], 11), n11 && n11.kind === 'plane' ? `x=${n11.workplane.origin[0].toFixed(2)}` : '—');

const n20 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box20), ncParams());
ok('body 10→20 → edge rejects → baked frame (x≈10)',
  n20 && n20.kind === 'plane' && close(n20.workplane.origin[0], 10), n20 && n20.kind === 'plane' ? `x=${n20.workplane.origin[0].toFixed(2)} (baked)` : '—');

const nL = evaluateDatum(oc, 'datum_plane', bodyInput('box', box10), ncParams(false));
ok('legacy normal-to-curve (no sig) → passthrough baked frame (x≈10)',
  nL && nL.kind === 'plane' && close(nL.workplane.origin[0], 10), nL && nL.kind === 'plane' ? `x=${nL.workplane.origin[0].toFixed(2)}` : '—');

// ─── 10 — TWO-EDGES datum: re-samples both edges on their live bodies (step 4) ─
// Two edges meeting at corner (10,0,0): one along +Y, one along +Z → the x=10 plane.
console.log('\n10 — two-edges datum re-samples both edges on the live body');
const e2SigA = lineSigFromPoints([[10, 0, 0], [10, 10, 0]]);   // along +Y
const e2SigB = lineSigFromPoints([[10, 0, 0], [10, 0, 10]]);   // along +Z
const e2Baked = { label: '2E', origin: [10, 0, 0], normal: [1, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };
const e2Params = (withSig = true) => ({ datum: 'plane', method: 'twoEdges', workplane: e2Baked,
  refs: [
    { kind: 'edge', nodeId: 'box', ...(withSig ? { sel: e2SigA } : {}) },
    { kind: 'edge', nodeId: 'box', ...(withSig ? { sel: e2SigB } : {}) },
  ] });

const e10 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box10), e2Params());
ok('re-builds the x=10 plane from both edges on box10 (origin x≈10, n≈±X)',
  e10 && e10.kind === 'plane' && close(e10.workplane.origin[0], 10) && close(Math.abs(e10.workplane.normal[0]), 1, 0.01),
  e10 && e10.kind === 'plane' ? `x=${e10.workplane.origin[0].toFixed(2)} nx=${e10.workplane.normal[0].toFixed(2)}` : '—');

const e11 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box11), e2Params());
ok('body 10→11 → both edges follow → plane origin x≈11 (baked would be 10)',
  e11 && e11.kind === 'plane' && close(e11.workplane.origin[0], 11), e11 && e11.kind === 'plane' ? `x=${e11.workplane.origin[0].toFixed(2)}` : '—');

const e20 = evaluateDatum(oc, 'datum_plane', bodyInput('box', box20), e2Params());
ok('body 10→20 → an edge rejects → baked frame (x≈10)',
  e20 && e20.kind === 'plane' && close(e20.workplane.origin[0], 10), e20 && e20.kind === 'plane' ? `x=${e20.workplane.origin[0].toFixed(2)} (baked)` : '—');

const eL = evaluateDatum(oc, 'datum_plane', bodyInput('box', box10), e2Params(false));
ok('legacy two-edges (no sigs) → passthrough baked frame (x≈10)',
  eL && eL.kind === 'plane' && close(eL.workplane.origin[0], 10), eL && eL.kind === 'plane' ? `x=${eL.workplane.origin[0].toFixed(2)}` : '—');

// ─── 11 — DATUM AXIS: re-derives from the edge / cylinder face (step 4) ───────
console.log('\n11 — datum_axis re-derives its axis from edge + cylinder signatures');
const axOrigin = (f) => (f && f.kind === 'axis' ? f.axis.origin : null);
const cylRH = (r, h) => EVALUATORS.cylinder(oc, [], { r, h });

// edge axis: the box's +Y edge at x=10,z=0 → origin = edge midpoint (10,5,0).
const axEdgeSig = lineSigFromPoints([[10, 0, 0], [10, 10, 0]]);
const axEdgeBaked = { origin: [10, 5, 0], dir: [0, 1, 0] };
const axEdgeParams = (withSig = true) => ({ datum: 'axis', method: 'edge', axis: axEdgeBaked,
  refs: [{ kind: 'edge', nodeId: 'box', ...(withSig ? { sel: axEdgeSig } : {}) }] });
const ax0 = evaluateDatum(oc, 'datum_axis', bodyInput('box', box10), axEdgeParams());
ok('edge axis re-derives on box10 → origin (10,5,0)', closeV(axOrigin(ax0), [10, 5, 0]), `o=[${axOrigin(ax0)?.map((n) => n.toFixed(1))}]`);
const ax1 = evaluateDatum(oc, 'datum_axis', bodyInput('box', box11), axEdgeParams());
ok('edge axis follows body 10→11 → origin x≈11', close(axOrigin(ax1)?.[0], 11), `x=${axOrigin(ax1)?.[0].toFixed(2)}`);
const ax2 = evaluateDatum(oc, 'datum_axis', bodyInput('box', box20), axEdgeParams());
ok('edge axis rejects on 10→20 → baked axis (x≈10)', close(axOrigin(ax2)?.[0], 10), `x=${axOrigin(ax2)?.[0].toFixed(2)} (baked)`);
const axL = evaluateDatum(oc, 'datum_axis', bodyInput('box', box10), axEdgeParams(false));
ok('legacy edge axis (no sig) → baked axis (x≈10)', close(axOrigin(axL)?.[0], 10), `x=${axOrigin(axL)?.[0].toFixed(2)}`);

// cylinder axis: reuse the section-7 cyl5 + its FaceSig → axis on +Z through (0,0,7.5).
const axCylBaked = { origin: [0, 0, 7.5], dir: [0, 0, 1] };
const axCylParams = { datum: 'axis', method: 'cylinder', axis: axCylBaked, refs: [{ kind: 'cylinder', nodeId: 'cyl', sel: cylSig }] };
const axc0 = evaluateDatum(oc, 'datum_axis', bodyInput('cyl', cyl5), axCylParams);
ok('cylinder axis re-derives → origin z≈7.5, |dir z|≈1',
  axOrigin(axc0) && close(axOrigin(axc0)[2], 7.5) && close(Math.abs(axc0.axis.dir[2]), 1, 0.01), axOrigin(axc0) ? `z=${axOrigin(axc0)[2].toFixed(2)}` : '—');
const axc1 = evaluateDatum(oc, 'datum_axis', bodyInput('cyl', cylRH(5, 17)), axCylParams);
ok('cylinder height 15→17 → axis anchor (centroid) follows z 7.5→8.5', close(axOrigin(axc1)?.[2], 8.5), `z=${axOrigin(axc1)?.[2].toFixed(2)}`);
const axc2 = evaluateDatum(oc, 'datum_axis', bodyInput('cyl', cylRH(5, 30)), axCylParams);
ok('cylinder height 15→30 → rejects → baked axis (z≈7.5)', close(axOrigin(axc2)?.[2], 7.5), `z=${axOrigin(axc2)?.[2].toFixed(2)} (baked)`);

// ─── 12 — DATUM POINT: re-derives from vertex / edge-midpoint (step 4) ────────
console.log('\n12 — datum_point re-derives its point from vertex + edge signatures');
const ptOf = (f) => (f && f.kind === 'point' ? f.point : null);

const ptVertSig = vertexSigFromPoint([10, 10, 10]);            // a box10 corner
const ptVertBaked = [10, 10, 10];
const ptVertParams = (withSig = true) => ({ datum: 'point', method: 'vertex', point: ptVertBaked,
  refs: [{ kind: 'vertex', nodeId: 'box', ...(withSig ? { sel: ptVertSig } : {}) }] });
const pv0 = evaluateDatum(oc, 'datum_point', bodyInput('box', box10), ptVertParams());
ok('vertex point re-derives on box10 → (10,10,10)', closeV(ptOf(pv0), [10, 10, 10]), `p=[${ptOf(pv0)?.map((n) => n.toFixed(1))}]`);
const pv1 = evaluateDatum(oc, 'datum_point', bodyInput('box', box11), ptVertParams());
ok('vertex point follows body 10→11 → x≈11', close(ptOf(pv1)?.[0], 11), `x=${ptOf(pv1)?.[0].toFixed(2)}`);
const pv2 = evaluateDatum(oc, 'datum_point', bodyInput('box', box20), ptVertParams());
ok('vertex point rejects on 10→20 → baked point (x≈10)', close(ptOf(pv2)?.[0], 10), `x=${ptOf(pv2)?.[0].toFixed(2)} (baked)`);
const pvL = evaluateDatum(oc, 'datum_point', bodyInput('box', box10), ptVertParams(false));
ok('legacy vertex point (no sig) → baked point (x≈10)', close(ptOf(pvL)?.[0], 10), `x=${ptOf(pvL)?.[0].toFixed(2)}`);

const ptEdgeSig = lineSigFromPoints([[10, 0, 0], [10, 10, 0]]);  // +Y edge → midpoint (10,5,0)
const ptEdgeParams = { datum: 'point', method: 'edgeMid', point: [10, 5, 0], refs: [{ kind: 'edge', nodeId: 'box', sel: ptEdgeSig }] };
const pe0 = evaluateDatum(oc, 'datum_point', bodyInput('box', box10), ptEdgeParams);
ok('edge-midpoint point re-derives on box10 → (10,5,0)', closeV(ptOf(pe0), [10, 5, 0], 0.5), `p=[${ptOf(pe0)?.map((n) => n.toFixed(1))}]`);
const pe1 = evaluateDatum(oc, 'datum_point', bodyInput('box', box11), ptEdgeParams);
ok('edge-midpoint point follows body 10→11 → x≈11', close(ptOf(pe1)?.[0], 11), `x=${ptOf(pe1)?.[0].toFixed(2)}`);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
