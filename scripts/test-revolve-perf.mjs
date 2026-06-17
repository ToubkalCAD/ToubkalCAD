// ============================================================
// ToubkalCAD – scripts/test-revolve-perf.mjs
//
// Finds where the slow revolve time goes: the OCC MakeRevol build, or the
// BRepMesh tessellation (and how it scales with the absolute deflection used in
// OccConverter — 0.1). Mirrors revolveProfile + shapeToThreeGeometry.
//
// Run:  node scripts/test-revolve-perf.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

const now = () => Number(process.hrtime.bigint() / 1000000n); // ms

// Circle wire of `r` centered at (cx,0) on the XZ plane (so the Y axis is the
// revolution axis and `cx` is the profile's distance from it).
function circleFace(r, cx) {
  const o = new oc.gp_Pnt_3(cx, 0, 0);
  const n = new oc.gp_Dir_4(0, 1, 0);            // plane normal = Y (revolve axis)
  const x = new oc.gp_Dir_4(1, 0, 0);
  const ax2 = new oc.gp_Ax2_2(o, n, x);
  const circ = new oc.gp_Circ_2(ax2, r);
  const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1(); wm.Add_1(edge);
  const fm = new oc.BRepBuilderAPI_MakeFace_15(wm.Wire(), true);
  return fm.Face();
}

function revolve(face) {
  const origin = new oc.gp_Pnt_3(0, 0, 0);
  const dir = new oc.gp_Dir_4(0, 1, 0);          // Y axis
  const axis = new oc.gp_Ax1_2(origin, dir);
  const mk = new oc.BRepPrimAPI_MakeRevol_2(face, axis, false);
  mk.Build(new oc.Message_ProgressRange_1());
  if (!mk.IsDone()) throw new Error('revol failed');
  return mk.Shape();
}

function tessellate(shape, deflection) {
  const t0 = now();
  const m = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, false);
  m.Perform(new oc.Message_ProgressRange_1());
  // Count triangles to gauge cost.
  let tris = 0;
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const loc = new oc.TopLoc_Location_1();
    const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (!tri.IsNull()) tris += tri.get().NbTriangles();
    exp.Next();
  }
  return { ms: now() - t0, tris };
}

// Scenario: a circle of radius ~8 whose plane sits `cx` from the Y axis. The
// user's case is a big profile (r≈30) far from the world axis → large curved
// surfaces of revolution.
console.log('\nprofile        | revol build | tess@0.1 (current)  | tess@scaled (fix)');
console.log('---------------|-------------|---------------------|--------------------');
for (const [label, r, cx] of [
  ['r=8  off=20 ', 8, 20],
  ['r=8  off=40 ', 8, 40],
  ['r=30 off=35 ', 30, 35],   // approximates Circle-r30.9 on a box face
]) {
  const tb = now();
  const sol = revolve(circleFace(r, cx));
  const buildMs = now() - tb;
  // Bounding-box diagonal → size-scaled deflection (the proposed fix).
  const bb = new oc.Bnd_Box_1();
  oc.BRepBndLib.Add(sol, bb, false);
  const cmin = bb.CornerMin(), cmax = bb.CornerMax();
  const diag = Math.hypot(cmax.X() - cmin.X(), cmax.Y() - cmin.Y(), cmax.Z() - cmin.Z());
  const scaled = Math.max(0.1, diag * 0.008);   // matches OccConverter
  // Fresh shape per deflection so neither reuses the other's cached triangulation.
  const fine = tessellate(revolve(circleFace(r, cx)), 0.1);
  const coarse = tessellate(revolve(circleFace(r, cx)), scaled);
  console.log(`  · diag=${diag.toFixed(0)} → scaled deflection=${scaled.toFixed(2)}`);
  console.log(
    `${label}  |  ${String(buildMs).padStart(5)} ms  |  ${String(fine.ms).padStart(6)} ms ${String(fine.tris).padStart(7)} tri |  ${String(coarse.ms).padStart(6)} ms ${String(coarse.tris).padStart(7)} tri`
  );
}
console.log('\n(If tess@0.1 ≫ tess@1.0, the absolute deflection on large curved');
console.log(' surfaces is the cost — a relative/scaled deflection fixes it.)');
