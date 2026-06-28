// ============================================================
// ToubkalCAD – scripts/test-surface-revsweep.mjs
//
// Headless geometry test for SURFACE revolve + sweep (Surface Modeling).
//   • Surface revolve: BRepPrimAPI_MakeRevol on the WIRE directly (no capped face)
//     → an open SHELL of revolution, 0 enclosed solids. Control: revolving a FACE
//     gives a SOLID (proves the wire-vs-face flag is what differs).
//   • Surface sweep: BRepOffsetAPI_MakePipe on the WIRE profile → an open SHELL tube.
//     Control: capping the profile into a FACE first → a SOLID (the solid-sweep fix).
//
// Run:  node scripts/test-surface-revsweep.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};

const ENUM = oc.TopAbs_ShapeEnum;
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

// closed circle wire centred at (cx,0,0) in the XY plane
function circleWire(cx, r) {
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(cx, 0, 0), new oc.gp_Dir_4(0, 0, 1));
  const circ = new oc.gp_Circ_2(ax, r);
  const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
}
const faceOf = (wire) => new oc.BRepBuilderAPI_MakeFace_15(wire, true).Face();

// mirror of OccRevolutionService.revolveSurface (wire, no face cap)
function revolveSurface(wire, angleDeg) {
  const axis = new oc.gp_Ax1_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 1, 0));
  const mk = Math.abs(angleDeg - 360) < 1e-4
    ? new oc.BRepPrimAPI_MakeRevol_2(wire, axis, false)
    : new oc.BRepPrimAPI_MakeRevol_1(wire, axis, angleDeg * Math.PI / 180, false);
  mk.Build(new oc.Message_ProgressRange_1());
  if (!mk.IsDone()) throw new Error('revolve failed');
  return mk.Shape();
}
function lineSpine() {
  const e = new oc.BRepBuilderAPI_MakeEdge_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Pnt_3(0, 30, 0)).Edge();
  return new oc.BRepBuilderAPI_MakeWire_2(e).Wire();
}
function sweep(section, spine) {
  const pipe = new oc.BRepOffsetAPI_MakePipe_1(spine, section);
  pipe.Build(new oc.Message_ProgressRange_1());
  if (!pipe.IsDone()) throw new Error('sweep failed');
  return pipe.Shape();
}

console.log('Surface revolve — circle wire @x=20, 360° about Y:');
{
  const s = revolveSurface(circleWire(20, 5), 360);
  check('result is a SHELL (not a SOLID)', typeName(s) === 'SHELL', `got ${typeName(s)}`);
  check('contains 0 enclosed solids', count(s, ENUM.TopAbs_SOLID) === 0, `solids=${count(s, ENUM.TopAbs_SOLID)}`);
  check('surface area > 0', area(s) > 1, `area=${area(s).toFixed(1)}`);
}
console.log('Control — revolve the same profile as a FACE → SOLID:');
{
  const s = revolveSurface(faceOf(circleWire(20, 5)), 360);
  check('result is a SOLID', typeName(s) === 'SOLID', `got ${typeName(s)}`);
}

console.log('Surface sweep — circle wire profile along a line spine:');
{
  const s = sweep(circleWire(0, 3), lineSpine());
  check('result is a SHELL (not a SOLID)', typeName(s) === 'SHELL', `got ${typeName(s)}`);
  check('contains 0 enclosed solids', count(s, ENUM.TopAbs_SOLID) === 0, `solids=${count(s, ENUM.TopAbs_SOLID)}`);
  check('surface area > 0', area(s) > 1, `area=${area(s).toFixed(1)}`);
}
console.log('Control — sweep the capped FACE profile → SOLID (the solid-sweep fix):');
{
  const s = sweep(faceOf(circleWire(0, 3)), lineSpine());
  check('result is a SOLID', typeName(s) === 'SOLID', `got ${typeName(s)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
