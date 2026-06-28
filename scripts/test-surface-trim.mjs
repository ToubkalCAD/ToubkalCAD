// ============================================================
// ToubkalCAD – scripts/test-surface-trim.mjs
//
// Headless geometry test for Surface Modeling Phase 2: TRIM.
// Mirrors OccSurfaceService.trim — cut a surface body with a tool body, keeping the
// portion OUTSIDE (BRepAlgoAPI_Cut) or INSIDE (BRepAlgoAPI_Common) the tool.
//
//   target = a 10×10 planar sheet (z=0); tool = a box solid covering x∈[5,17].
//   • keepInside=false (Cut)    → outside half, area ≈ 50, 0 solids (still a surface)
//   • keepInside=true  (Common) → inside half,  area ≈ 50, 0 solids
//
// Run:  node scripts/test-surface-trim.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};

const E = oc.TopAbs_ShapeEnum;
const count = (s, k) => { const e = new oc.TopExp_Explorer_2(s, k, E.TopAbs_SHAPE); let n = 0; for (; e.More(); e.Next()) n++; return n; };
const area  = (s) => { const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(s, g, false, false); return g.Mass(); };

function planarSheet(L) {
  const pl = new oc.gp_Pln_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));
  return new oc.BRepBuilderAPI_MakeFace_9(pl, 0, L, 0, L).Face();
}
// mirror of OccSurfaceService.trim
function trim(target, tool, keepInside) {
  const op = keepInside
    ? new oc.BRepAlgoAPI_Common_3(target, tool, new oc.Message_ProgressRange_1())
    : new oc.BRepAlgoAPI_Cut_3(target, tool, new oc.Message_ProgressRange_1());
  op.Build(new oc.Message_ProgressRange_1());
  if (!op.IsDone()) throw new Error('trim failed');
  return op.Shape();
}

const sheet = planarSheet(10);                                                  // area 100
const tool  = new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(5, -1, -1), 12, 12, 2).Shape(); // x∈[5,17]

console.log('Trim — keep OUTSIDE tool (Cut):');
{
  const s = trim(sheet, tool, false);
  check('surface area ≈ 50 (half kept)', Math.abs(area(s) - 50) < 1, `area=${area(s).toFixed(2)}`);
  check('still a surface (0 enclosed solids)', count(s, E.TopAbs_SOLID) === 0, `solids=${count(s, E.TopAbs_SOLID)}`);
  check('has at least one face', count(s, E.TopAbs_FACE) >= 1, `faces=${count(s, E.TopAbs_FACE)}`);
}
console.log('Trim — keep INSIDE tool (Common):');
{
  const s = trim(sheet, tool, true);
  check('surface area ≈ 50 (other half)', Math.abs(area(s) - 50) < 1, `area=${area(s).toFixed(2)}`);
  check('still a surface (0 enclosed solids)', count(s, E.TopAbs_SOLID) === 0, `solids=${count(s, E.TopAbs_SOLID)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
