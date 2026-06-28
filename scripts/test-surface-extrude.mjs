// ============================================================
// ToubkalCAD – scripts/test-surface-extrude.mjs
//
// Headless geometry test for the SURFACE extrude (Surface Modeling, Milestone 0).
// Mirrors the exact OCC sequence in OccExtrusionService.extrudeSurface: prism a
// WIRE directly (no MakeFace cap) so the result is a zero-thickness sheet.
//
// Asserts, for a closed rectangular profile:
//   • the result is a TopoDS_SHELL (open tube), NOT a SOLID
//   • it has surface area > 0 and (being open) effectively zero enclosed volume
// And for an open (single-edge) profile:
//   • the result is a TopoDS_FACE (single sheet)
//
// Run:  node scripts/test-surface-extrude.mjs        (from the project root)
// Exits non-zero if any assertion fails.
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};

const P = (x, y, z) => new oc.gp_Pnt_3(x, y, z);

function rectWire(w, h) {                       // closed rectangle on the XY plane
  const mk = new oc.BRepBuilderAPI_MakePolygon_1();
  mk.Add_1(P(0, 0, 0)); mk.Add_1(P(w, 0, 0)); mk.Add_1(P(w, h, 0)); mk.Add_1(P(0, h, 0));
  mk.Close();
  return mk.Wire();
}
function edgeWire(w) {                           // single open edge along +X
  const e = new oc.BRepBuilderAPI_MakeEdge_3(P(0, 0, 0), P(w, 0, 0));
  return e.Edge();
}

// The extrudeSurface core: prism the profile directly along +Z by `dist`.
function extrudeSurface(profile, dist) {
  const vec   = new oc.gp_Vec_4(0, 0, dist);
  const prism = new oc.BRepPrimAPI_MakePrism_1(profile, vec, false, true);
  if (!prism.IsDone()) throw new Error('prism failed');
  return prism.Shape();
}

const ENUM = oc.TopAbs_ShapeEnum;
const typeName = (s) => {
  const t = s.ShapeType();
  return t === ENUM.TopAbs_SOLID ? 'SOLID' : t === ENUM.TopAbs_SHELL ? 'SHELL'
    : t === ENUM.TopAbs_FACE ? 'FACE' : t === ENUM.TopAbs_COMPOUND ? 'COMPOUND' : 'OTHER';
};
function area(s)   { const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(s, g, false, false); return g.Mass(); }
function faceCount(s) {
  const exp = new oc.TopExp_Explorer_2(s, ENUM.TopAbs_FACE, ENUM.TopAbs_SHAPE);
  let n = 0; for (; exp.More(); exp.Next()) n++; return n;
}

console.log('Surface extrude — closed rectangular profile (40×30, dist 20):');
{
  const shape = extrudeSurface(rectWire(40, 30), 20);
  const tn = typeName(shape), a = area(shape), nf = faceCount(shape);
  check('result is a SHELL (not a SOLID)', tn === 'SHELL', `got ${tn}`);
  check('surface area ≈ perimeter×dist = 2800', Math.abs(a - 2800) < 1, `area=${a.toFixed(1)}`);
  check('no end caps (4 wall faces, not 6)', nf === 4, `faces=${nf}`);
}

console.log('Surface extrude — open single-edge profile (len 40, dist 20):');
{
  const shape = extrudeSurface(edgeWire(40), 20);
  const tn = typeName(shape), a = area(shape);
  check('result is a FACE (single sheet)', tn === 'FACE', `got ${tn}`);
  check('surface area ≈ 40×20 = 800', Math.abs(a - 800) < 1, `area=${a.toFixed(1)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
