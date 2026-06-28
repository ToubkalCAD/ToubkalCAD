// ============================================================
// ToubkalCAD – scripts/test-surface-blend.mjs
//
// Headless geometry test for Surface Modeling Phase 2: BLEND.
// Mirrors OccSurfaceService.blend — a tangent (G1) bridge between two surface bodies:
// auto-find the nearest free boundary edge of each, join their endpoints with two
// connector edges, and BRepOffsetAPI_MakeFilling the 4-sided loop with G1 continuity
// to each support face. Also exercises the free-edge ancestor map + IsSame face lookup.
//
//   • Coplanar sheets with a 5mm gap → flat bridge, area ≈ 50 (5 gap × 10 width).
//   • Non-coplanar (B lifted z=8) → curved tangent bridge, area > flat (≈ 94).
//
// Run:  node scripts/test-surface-blend.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const E = oc.TopAbs_ShapeEnum;
const tn = (s) => { const t = s.ShapeType(); return t === E.TopAbs_FACE ? 'FACE' : t === E.TopAbs_SHELL ? 'SHELL' : t === E.TopAbs_SOLID ? 'SOLID' : 'OTHER'; };
const area = (s) => { const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(s, g, false, false); return g.Mass(); };

function sheet(x0, x1, y0, y1, z) {
  const pl = new oc.gp_Pln_3(new oc.gp_Pnt_3(0, 0, z), new oc.gp_Dir_4(0, 0, 1));
  return new oc.BRepBuilderAPI_MakeFace_9(pl, x0, x1, y0, y1).Face();
}
function freeBoundaryEdges(shape) {
  const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(shape, E.TopAbs_EDGE, E.TopAbs_FACE, map);
  const out = [];
  for (let i = 1; i <= map.Extent(); i++) if (map.FindFromIndex(i).Extent() === 1) out.push(oc.TopoDS.Edge_1(map.FindKey(i)));
  return out;
}
function faceContainingEdge(shape, edge) {
  const fexp = new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE);
  for (; fexp.More(); fexp.Next()) {
    const face = oc.TopoDS.Face_1(fexp.Current());
    const eexp = new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE);
    for (; eexp.More(); eexp.Next()) if (edge.IsSame(eexp.Current())) return face;
  }
  return null;
}
const mid = (e) => { const c = new oc.BRepAdaptor_Curve_2(e); const p = c.Value((c.FirstParameter() + c.LastParameter()) / 2); return [p.X(), p.Y(), p.Z()]; };
const ends = (e) => { const c = new oc.BRepAdaptor_Curve_2(e); const a = c.Value(c.FirstParameter()), b = c.Value(c.LastParameter()); return [[a.X(), a.Y(), a.Z()], [b.X(), b.Y(), b.Z()]]; };
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const lineEdge = (a, b) => new oc.BRepBuilderAPI_MakeEdge_3(new oc.gp_Pnt_3(...a), new oc.gp_Pnt_3(...b)).Edge();

// edge ordinal resolver (same de-dup TopExp/IndexedMap order as the picker)
function edgeByOrdinal(shape, ord) {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  const exp = new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) map.Add(exp.Current());
  if (ord < 0 || ord >= map.Extent()) return null;
  return oc.TopoDS.Edge_1(map.FindKey(ord + 1));
}
// ordinal of a given edge within the shape's edge map (for the test's cross-check)
function ordinalOf(shape, edge) {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  const exp = new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) map.Add(exp.Current());
  for (let i = 1; i <= map.Extent(); i++) if (edge.IsSame(map.FindKey(i))) return i - 1;
  return -1;
}

function blend(A, B, ordA, ordB) {
  let edgeA, edgeB, best = Infinity;
  if (typeof ordA === 'number' && typeof ordB === 'number') {
    edgeA = edgeByOrdinal(A, ordA); edgeB = edgeByOrdinal(B, ordB);
  } else {
    const eA = freeBoundaryEdges(A), eB = freeBoundaryEdges(B);
    for (const a of eA) for (const b of eB) { const d = Math.sqrt(d2(mid(a), mid(b))); if (d < best) { best = d; edgeA = a; edgeB = b; } }
  }
  const faceA = faceContainingEdge(A, edgeA), faceB = faceContainingEdge(B, edgeB);
  if (!faceA || !faceB) throw new Error('no support face');
  const [a0, a1] = ends(edgeA), [b0, b1] = ends(edgeB);
  const [c0, c1] = d2(a0, b0) <= d2(a0, b1) ? [b0, b1] : [b1, b0];
  const f = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
  f.Add_2(edgeA, faceA, oc.GeomAbs_Shape.GeomAbs_G1, true);
  f.Add_2(edgeB, faceB, oc.GeomAbs_Shape.GeomAbs_G1, true);
  f.Add_1(lineEdge(a0, c0), oc.GeomAbs_Shape.GeomAbs_C0, true);
  f.Add_1(lineEdge(a1, c1), oc.GeomAbs_Shape.GeomAbs_C0, true);
  f.Build(new oc.Message_ProgressRange_1());
  if (!f.IsDone()) throw new Error('fill failed');
  return { nFreeA: freeBoundaryEdges(A).length, gap: best, edgeA, edgeB, face: oc.TopoDS.Face_1(f.Shape()) };
}

console.log('Blend — coplanar sheets, 5mm gap (flat bridge):');
{
  const A = sheet(0, 10, 0, 10, 0), B = sheet(15, 25, 0, 10, 0);
  const r = blend(A, B);
  check('found 4 free boundary edges on a single-face sheet', r.nFreeA === 4, `nFreeA=${r.nFreeA}`);
  check('nearest edge gap ≈ 5', Math.abs(r.gap - 5) < 0.01, `gap=${r.gap.toFixed(2)}`);
  check('bridge is a FACE', tn(r.face) === 'FACE', `got ${tn(r.face)}`);
  check('flat bridge area ≈ 50', Math.abs(area(r.face) - 50) < 1, `area=${area(r.face).toFixed(2)}`);
}
console.log('Blend — non-coplanar (B lifted to z=8), tangent curved bridge:');
{
  const A = sheet(0, 10, 0, 10, 0), B = sheet(15, 25, 0, 10, 8);
  const r = blend(A, B);
  check('bridge is a FACE', tn(r.face) === 'FACE', `got ${tn(r.face)}`);
  check('curved tangent bridge area > flat 50', area(r.face) > 60, `area=${area(r.face).toFixed(2)}`);
}

console.log('Blend — EXPLICIT edge ordinals resolve to the same edges as auto:');
{
  const A = sheet(0, 10, 0, 10, 0), B = sheet(15, 25, 0, 10, 0);
  const auto = blend(A, B);                                   // discover which edges auto chose
  const oa = ordinalOf(A, auto.edgeA), ob = ordinalOf(B, auto.edgeB);
  check('auto-picked edges have valid ordinals', oa >= 0 && ob >= 0, `ordA=${oa} ordB=${ob}`);
  const explicit = blend(A, B, oa, ob);                      // pass those ordinals explicitly
  check('explicit-ordinal blend == auto area (50)', Math.abs(area(explicit.face) - 50) < 1, `area=${area(explicit.face).toFixed(2)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
