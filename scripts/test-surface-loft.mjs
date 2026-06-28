// ============================================================
// ToubkalCAD – scripts/test-surface-loft.mjs
//
// Headless geometry test for SURFACE loft (Surface Modeling). Mirrors
// OccLoftService.loftProfiles run with isSolid=false (BRepOffsetAPI_ThruSections):
// skinning ≥2 profiles into an OPEN shell with no end caps.
//
// Asserts, for two stacked circles:
//   • isSolid=false → a TopoDS_SHELL with 0 enclosed solids and area > 0
//   • isSolid=true  → a TopoDS_SOLID (control, proves the flag is what differs)
//
// Run:  node scripts/test-surface-loft.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};

const ENUM = oc.TopAbs_ShapeEnum;
function circleWire(r, z) {
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, z), new oc.gp_Dir_4(0, 0, 1));
  const circ = new oc.gp_Circ_2(ax, r);
  const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
}
function loft(profiles, isSolid, ruled = false) {
  const ts = new oc.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6);
  if (!ruled) ts.SetSmoothing(true);
  ts.CheckCompatibility(true);
  for (const w of profiles) ts.AddWire(w);
  ts.Build(new oc.Message_ProgressRange_1());
  if (!ts.IsDone()) throw new Error('ThruSections failed');
  return ts.Shape();
}
const typeName = (s) => {
  const t = s.ShapeType();
  return t === ENUM.TopAbs_SOLID ? 'SOLID' : t === ENUM.TopAbs_SHELL ? 'SHELL'
    : t === ENUM.TopAbs_FACE ? 'FACE' : t === ENUM.TopAbs_COMPOUND ? 'COMPOUND' : 'OTHER';
};
function count(s, kind) {
  const exp = new oc.TopExp_Explorer_2(s, kind, ENUM.TopAbs_SHAPE);
  let n = 0; for (; exp.More(); exp.Next()) n++; return n;
}
function area(s) { const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(s, g, false, false); return g.Mass(); }

const profiles = [circleWire(8, 0), circleWire(5, 12)];

console.log('Surface loft — two stacked circles, isSolid=false:');
{
  const shape = loft(profiles, false);
  const tn = typeName(shape);
  check('result is a SHELL (not a SOLID)', tn === 'SHELL', `got ${tn}`);
  check('contains 0 enclosed solids', count(shape, ENUM.TopAbs_SOLID) === 0, `solids=${count(shape, ENUM.TopAbs_SOLID)}`);
  check('surface area > 0', area(shape) > 1, `area=${area(shape).toFixed(1)}`);
}

console.log('Control — same profiles, isSolid=true:');
{
  const shape = loft(profiles, true);
  const tn = typeName(shape);
  check('result is a SOLID', tn === 'SOLID', `got ${tn}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
