// ============================================================
// ToubkalCAD – scripts/test-surface-extend.mjs
//
// Headless geometry test for Surface Modeling Phase 2: EXTEND.
// Mirrors OccSurfaceService.extend / extendFace — grow a face's UV bounds via
// BRepAdaptor_Surface (UVBounds_1 can't return double& out-params) + MakeFace_14,
// skipping PERIODIC directions (a cylinder's angular U must not wrap further).
//
//   • Planar 10×10 sheet, extend 3 → 16×16 face, area 256 (both U,V grow).
//   • Cylindrical shell (r=5, h=12), extend 3 → height 18 only (U periodic, fixed),
//     area = 2π·5·18 ≈ 565.5 (NOT wrapped/duplicated in U).
//
// Run:  node scripts/test-surface-extend.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const E = oc.TopAbs_ShapeEnum;
const area  = (s) => { const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(s, g, false, false); return g.Mass(); };
const count = (s, k) => { const e = new oc.TopExp_Explorer_2(s, k, E.TopAbs_SHAPE); let n = 0; for (; e.More(); e.Next()) n++; return n; };

// mirror of OccSurfaceService.extendFace (mm-accurate, period-aware)
function spansFullPeriod(ad, span, uDir) {
  try { const p = uDir ? ad.UPeriod() : ad.VPeriod(); return p > 0 && span >= p - 1e-6; } catch { return true; }
}
function extendFace(face, d) {
  const surf = oc.BRep_Tool.Surface_2(face);
  const ad = new oc.BRepAdaptor_Surface_2(face, true);
  const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter();
  const v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  const P = new oc.gp_Pnt_3(0, 0, 0), dU = new oc.gp_Vec_4(0, 0, 0), dV = new oc.gp_Vec_4(0, 0, 0);
  ad.D1(um, vm, P, dU, dV);
  const su = dU.Magnitude(), sv = dV.Magnitude();
  const fullU = ad.IsUPeriodic() && spansFullPeriod(ad, u1 - u0, true);
  const fullV = ad.IsVPeriodic() && spansFullPeriod(ad, v1 - v0, false);
  const du = fullU ? 0 : d / Math.max(su, 1e-9);
  const dv = fullV ? 0 : d / Math.max(sv, 1e-9);
  const mk = new oc.BRepBuilderAPI_MakeFace_14(surf, u0 - du, u1 + du, v0 - dv, v1 + dv, 1e-6);
  mk.Build(new oc.Message_ProgressRange_1());
  if (!mk.IsDone()) throw new Error('extend failed');
  return { face: mk.Face(), du, dv, fullU, fullV };
}
function partialCyl(angleDeg) {
  const e = new oc.BRepBuilderAPI_MakeEdge_3(new oc.gp_Pnt_3(5, 0, 0), new oc.gp_Pnt_3(5, 0, 12)).Edge();
  const ax = new oc.gp_Ax1_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));
  const mk = new oc.BRepPrimAPI_MakeRevol_1(e, ax, angleDeg * Math.PI / 180, false);
  mk.Build(new oc.Message_ProgressRange_1());
  const exp = new oc.TopExp_Explorer_2(mk.Shape(), E.TopAbs_FACE, E.TopAbs_SHAPE);
  return oc.TopoDS.Face_1(exp.Current());
}

console.log('Extend — planar 10×10 sheet by 3 (both directions grow):');
{
  const pl = new oc.gp_Pln_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));
  const sheet = new oc.BRepBuilderAPI_MakeFace_9(pl, 0, 10, 0, 10).Face();
  const { face, du, dv } = extendFace(sheet, 3);
  check('both U,V extended (not periodic)', du === 3 && dv === 3, `du=${du} dv=${dv}`);
  check('area grows 100 → 256', Math.abs(area(face) - 256) < 1e-2, `area=${area(face).toFixed(2)}`);
  check('still a single FACE', count(face, E.TopAbs_FACE) === 1, `faces=${count(face, E.TopAbs_FACE)}`);
}

console.log('Extend — cylindrical shell (r=5, h=12) by 3 (U periodic → height only):');
{
  // surface-extrude a circle wire (no cap) → cylindrical SHELL, one face
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));
  const circ = new oc.gp_Circ_2(ax, 5);
  const wire = new oc.BRepBuilderAPI_MakeWire_2(new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge()).Wire();
  const prism = new oc.BRepPrimAPI_MakePrism_1(wire, new oc.gp_Vec_4(0, 0, 12), false, true);
  prism.Build(new oc.Message_ProgressRange_1());
  // the shell's single cylindrical face
  const e = new oc.TopExp_Explorer_2(prism.Shape(), E.TopAbs_FACE, E.TopAbs_SHAPE);
  const cyl = oc.TopoDS.Face_1(e.Current());
  const a0 = area(cyl);
  const { face, du, dv } = extendFace(cyl, 3);
  check('U periodic left untouched, V (height) extended', du === 0 && dv === 3, `du=${du} dv=${dv}`);
  check('area grows 2π·5·12 → 2π·5·18', Math.abs(area(face) - 2 * Math.PI * 5 * 18) < 1, `before=${a0.toFixed(1)} after=${area(face).toFixed(1)} (~${(2*Math.PI*5*18).toFixed(1)})`);
}

console.log('Extend — PARTIAL quarter-cylinder (r=5, h=12) by 3, mm-accurate:');
{
  // arc length grows by 2·3=6, height by 2·3=6 → (5·π/2 + 6) × (12 + 6)
  const face = partialCyl(90);
  const { face: out, du, dv, fullU } = extendFace(face, 3);
  check('partial arc IS extended (not skipped despite periodic U)', !fullU && du > 0, `du=${du.toFixed(4)} dv=${dv.toFixed(3)} fullU=${fullU}`);
  check('du = d / radius (mm-accurate, not raw param)', Math.abs(du - 3 / 5) < 1e-6, `du=${du.toFixed(4)} (expect 0.6)`);
  const expect = (5 * Math.PI / 2 + 6) * 18;
  check('area matches arc-length expectation', Math.abs(area(out) - expect) < 1, `area=${area(out).toFixed(2)} (~${expect.toFixed(2)})`);
}
console.log('Extend — FULL cylinder still NOT wrapped (period guard):');
{
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));
  const wire = new oc.BRepBuilderAPI_MakeWire_2(new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, 5)).Edge()).Wire();
  const prism = new oc.BRepPrimAPI_MakePrism_1(wire, new oc.gp_Vec_4(0, 0, 12), false, true);
  prism.Build(new oc.Message_ProgressRange_1());
  const e = new oc.TopExp_Explorer_2(prism.Shape(), E.TopAbs_FACE, E.TopAbs_SHAPE);
  const { du, dv, fullU } = extendFace(oc.TopoDS.Face_1(e.Current()), 3);
  check('full cylinder U left untouched (fullU), height grows', fullU && du === 0 && Math.abs(dv - 3) < 1e-6, `du=${du} dv=${dv.toFixed(3)} fullU=${fullU}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
