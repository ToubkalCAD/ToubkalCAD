// ============================================================
// ToubkalCAD – scripts/test-surface-patch.mjs
//
// Headless geometry test for SURFACE patch (Surface Modeling, Phase 1). Mirrors
// OccSurfaceService.patch: fill ONE closed boundary loop into a zero-thickness
// TopoDS_Face — planar loops via BRepBuilderAPI_MakeFace_15(wire, onlyPlane=true),
// non-planar loops via BRepOffsetAPI_MakeFilling (G0 boundary constraints).
//
// Asserts:
//   • Planar 10×10 square loop → a FACE, area ≈ 100, 0 enclosed solids.
//   • Non-planar closed quad (one corner lifted in Z) → a FACE, area > 0.
//
// Run:  node scripts/test-surface-patch.mjs
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

// Closed wire through an ordered point loop (straight edges, last → first).
function polyWire(pts) {
  const mk = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const e = new oc.BRepBuilderAPI_MakeEdge_3(
      new oc.gp_Pnt_3(a[0], a[1], a[2]), new oc.gp_Pnt_3(b[0], b[1], b[2]),
    ).Edge();
    mk.Add_1(e);
  }
  return mk.Wire();
}

// Mirror of OccSurfaceService.patch: planar MakeFace first, else MakeFilling.
function patch(wire) {
  const planar = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  if (planar.IsDone()) return planar.Face();
  const fill = new oc.BRepOffsetAPI_MakeFilling(
    3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9,
  );
  const exp = new oc.TopExp_Explorer_2(wire, ENUM.TopAbs_EDGE, ENUM.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) fill.Add_1(oc.TopoDS.Edge_1(exp.Current()), oc.GeomAbs_Shape.GeomAbs_C0, true);
  fill.Build(new oc.Message_ProgressRange_1());
  if (!fill.IsDone()) throw new Error('MakeFilling failed');
  return oc.TopoDS.Face_1(fill.Shape());   // MakeFilling has no .Face(); .Shape() is the filled face
}

console.log('Surface patch — planar 10×10 square loop:');
{
  const wire = polyWire([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]);
  const face = patch(wire);
  const tn = typeName(face);
  check('result is a FACE', tn === 'FACE', `got ${tn}`);
  check('area ≈ 100', Math.abs(area(face) - 100) < 1e-3, `area=${area(face).toFixed(3)}`);
  check('contains 0 enclosed solids', count(face, ENUM.TopAbs_SOLID) === 0, `solids=${count(face, ENUM.TopAbs_SOLID)}`);
}

console.log('Surface patch — non-planar quad (one corner lifted in Z):');
{
  const wire = polyWire([[0, 0, 0], [10, 0, 0], [10, 10, 5], [0, 10, 0]]);
  const face = patch(wire);
  const tn = typeName(face);
  check('result is a FACE', tn === 'FACE', `got ${tn}`);
  check('surface area > 0', area(face) > 1, `area=${area(face).toFixed(3)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
