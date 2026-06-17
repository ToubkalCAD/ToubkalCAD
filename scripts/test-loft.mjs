// ============================================================
// ToubkalCAD – scripts/test-loft.mjs
//
// Headless geometry test for the Loft tool. Runs the OpenCascade kernel in
// Node (no browser) and lofts two (and three) closed profiles on parallel
// planes — the exact scenario from the UI bug report: a circle on one box
// face and an ellipse on the parallel face.
//
// The loft() / circleWire() / ellipseWire() helpers mirror the OCC call
// sequences in:
//   • src/services/OccLoftService.ts      (loftProfiles)
//   • src/services/OccSketchService.ts    (createCircleWire / createEllipseWire)
// so this validates the geometry core the Ribbon/right-click Loft drives. The
// React selection→enable wiring is covered by tsc + the build; verify that
// interactively.
//
// Run:  node scripts/test-loft.mjs
// Exits non-zero if any assertion fails.
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';

const oc = await initOpenCascade();

// ─── Tiny assert harness ──────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  (${detail})` : ''}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  (${detail})` : ''}`); }
}

// ─── OCC helpers ──────────────────────────────────────────────────────────────

/** Volume + centroid Z of a solid (exact geometry, not tessellated). */
function measure(solid) {
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(solid, p, true, false, false);
  const c = p.CentreOfMass();
  const r = { vol: p.Mass(), cz: c.Z() };
  c.delete(); p.delete();
  return r;
}

function countSolids(shape) {
  let n = 0;
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) { n++; exp.Next(); }
  return n;
}

/** Mirror of OccSketchService.createCircleWire — full circle on plane z=z0, normal +Z. */
function circleWire(radius, z0 = 0) {
  const o = new oc.gp_Pnt_3(0, 0, z0);
  const n = new oc.gp_Dir_4(0, 0, 1);
  const x = new oc.gp_Dir_4(1, 0, 0);
  const ax2 = new oc.gp_Ax2_2(o, n, x);
  const circ = new oc.gp_Circ_2(ax2, radius);
  const mk = new oc.BRepBuilderAPI_MakeEdge_8(circ);
  if (!mk.IsDone()) throw new Error('circle edge failed');
  const edge = mk.Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  wm.Add_1(edge);
  const w = wm.Wire();
  o.delete(); n.delete(); x.delete(); ax2.delete(); circ.delete(); mk.delete(); wm.delete();
  return w;
}

/** Mirror of OccSketchService.createEllipseWire — full ellipse on plane z=z0, normal +Z. */
function ellipseWire(major, minor, z0 = 0) {
  const o = new oc.gp_Pnt_3(0, 0, z0);
  const n = new oc.gp_Dir_4(0, 0, 1);
  const x = new oc.gp_Dir_4(1, 0, 0);
  const ax2 = new oc.gp_Ax2_2(o, n, x);
  const elips = new oc.gp_Elips_2(ax2, major, minor); // major ≥ minor required
  const mk = new oc.BRepBuilderAPI_MakeEdge_12(elips);
  if (!mk.IsDone()) throw new Error('ellipse edge failed');
  const edge = mk.Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  wm.Add_1(edge);
  const w = wm.Wire();
  o.delete(); n.delete(); x.delete(); ax2.delete(); elips.delete(); mk.delete(); wm.delete();
  return w;
}

/** Mirror of OccLoftService.loftProfiles. */
function loft(profiles, isSolid = true, ruled = false) {
  if (profiles.length < 2) throw new Error('Loft requires at least 2 profiles.');
  const l = new oc.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6);
  if (!ruled) l.SetSmoothing(true);
  l.CheckCompatibility(true); // reconcile differing edge counts + seam/winding (see OccLoftService)
  for (const w of profiles) l.AddWire(w);
  l.Build(new oc.Message_ProgressRange_1());
  if (!l.IsDone()) throw new Error('Loft build not done');
  return l.Shape();
}

// ─── Reference areas (π·r² / π·a·b) ───────────────────────────────────────────
const PI = Math.PI;
const Acircle  = PI * 8.1 * 8.1;   // ≈ 206.12
const Aellipse = PI * 8 * 4;       // ≈ 100.53
const H = 10;                       // plane separation

// ─── L1 — two parallel profiles (the reported scenario) ───────────────────────
// Circle r=8.1 at z=0  →  ellipse 8×4 at z=10. Smooth solid loft.
console.log('\nL1 — loft circle(r=8.1) → ellipse(8×4), parallel planes Δz=10');
{
  const shape = loft([circleWire(8.1, 0), ellipseWire(8, 4, H)], true, false);
  const solids = countSolids(shape);
  const m = measure(shape);
  // Bounds: volume must sit between the smaller and larger cross-section prisms.
  const lo = Aellipse * H, hi = Acircle * H;
  ok('build produced exactly one solid', solids === 1, `solids=${solids}`);
  ok('volume is positive & between section prisms',
     m.vol > lo * 0.85 && m.vol < hi * 1.15,
     `vol=${m.vol.toFixed(1)} in (${(lo).toFixed(0)}..${(hi).toFixed(0)})`);
  ok('centroid Z inside the loft span (0,10)', m.cz > 0 && m.cz < H, `cz=${m.cz.toFixed(2)}`);
  ok('centroid biased toward the larger (bottom) section', m.cz < H / 2, `cz=${m.cz.toFixed(2)} < 5`);
}

// ─── L2 — ruled vs smooth both valid ──────────────────────────────────────────
console.log('\nL2 — ruled and smooth variants both build a solid');
{
  const ruled  = loft([circleWire(8.1, 0), ellipseWire(8, 4, H)], true, true);
  const smooth = loft([circleWire(8.1, 0), ellipseWire(8, 4, H)], true, false);
  const mr = measure(ruled), ms = measure(smooth);
  ok('ruled  → one solid, vol>0', countSolids(ruled) === 1 && mr.vol > 0, `vol=${mr.vol.toFixed(1)}`);
  ok('smooth → one solid, vol>0', countSolids(smooth) === 1 && ms.vol > 0, `vol=${ms.vol.toFixed(1)}`);
}

// ─── L3 — shell (open) variant ────────────────────────────────────────────────
console.log('\nL3 — shell loft (isSolid=false) has no enclosed volume');
{
  const shell = loft([circleWire(8.1, 0), ellipseWire(8, 4, H)], false, false);
  // A shell has open ends → VolumeProperties ≈ 0; the key invariant is it builds.
  ok('shell builds (0 solids — open surface)', countSolids(shell) === 0, `solids=${countSolids(shell)}`);
}

// ─── L4 — three profiles ("or more") ──────────────────────────────────────────
// circle r=8.1 (z=0) → ellipse 8×4 (z=10) → circle r=3 (z=20).
console.log('\nL4 — three stacked profiles');
{
  const shape = loft([circleWire(8.1, 0), ellipseWire(8, 4, 10), circleWire(3, 20)], true, false);
  const m = measure(shape);
  ok('three profiles → one solid', countSolids(shape) === 1, `solids=${countSolids(shape)}`);
  ok('volume positive, centroid in (0,20)', m.vol > 0 && m.cz > 0 && m.cz < 20,
     `vol=${m.vol.toFixed(1)} cz=${m.cz.toFixed(2)}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed ? 1 : 0);
