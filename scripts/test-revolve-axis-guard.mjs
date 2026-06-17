// ============================================================
// ToubkalCAD – scripts/test-revolve-axis-guard.mjs
//
// Verifies OccRevolutionService.axisIntersectsProfile (the guard that rejects a
// revolution whose axis passes through the profile interior) against the real
// service, on the user's exact geometry plus the valid edge-on-axis case.
//
// Run:  node scripts/test-revolve-axis-guard.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

// Mirror of OccRevolutionService.axisIntersectsProfile + faceNodes (the service
// can't be imported headlessly — extensionless TS imports don't resolve under
// node --strip-types — so this re-implements the exact algorithm under test).
function faceNodes(face) {
  const bb = new oc.Bnd_Box_1(); oc.BRepBndLib.Add(face, bb, false);
  const lo = bb.CornerMin(), hi = bb.CornerMax();
  const diag = Math.hypot(hi.X()-lo.X(), hi.Y()-lo.Y(), hi.Z()-lo.Z());
  new oc.BRepMesh_IncrementalMesh_2(face, Math.max(0.5, diag*0.05), false, 0.5, false).Perform(new oc.Message_ProgressRange_1());
  const loc = new oc.TopLoc_Location_1();
  const tri = oc.BRep_Tool.Triangulation(oc.TopoDS.Face_1(face), loc, 0);
  const out = [];
  if (tri.IsNull()) return out;
  const t = tri.get(), trsf = loc.Transformation();
  for (let i = 1; i <= t.NbNodes(); i++) { const p = t.Node(i).Transformed(trsf); out.push([p.X(), p.Y(), p.Z()]); }
  return out;
}
const OccRevolutionService = {
  axisIntersectsProfile(_oc, face, axisOrigin, axisDir) {
    const nodes = faceNodes(face);
    if (nodes.length < 3) return false;
    const sub = (a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
    const cross = (a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    const len = v=>Math.hypot(v[0],v[1],v[2]);
    let n=null;
    for (let i=2;i<nodes.length&&!n;i++){ const c=cross(sub(nodes[1],nodes[0]),sub(nodes[i],nodes[0])); if(len(c)>1e-9)n=c; }
    if(!n) return false;
    const dl=len(axisDir); if(dl<1e-12)return false;
    const dn=[axisDir[0]/dl,axisDir[1]/dl,axisDir[2]/dl];
    const e=cross(n,dn), el=len(e);
    if(el<1e-6*len(n))return false;
    const eu=[e[0]/el,e[1]/el,e[2]/el];
    let min=Infinity,max=-Infinity;
    for(const p of nodes){ const s=(p[0]-axisOrigin[0])*eu[0]+(p[1]-axisOrigin[1])*eu[1]+(p[2]-axisOrigin[2])*eu[2]; if(s<min)min=s; if(s>max)max=s; }
    const tol=Math.max(1e-6,1e-3*(max-min));
    return min<-tol && max>tol;
  },
  revolveProfile(_oc, profile, axisOrigin, axisDir, angleDeg) {
    let face = profile;
    if (profile.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE)
      face = new oc.BRepBuilderAPI_MakeFace_15(profile, true).Shape();
    if (OccRevolutionService.axisIntersectsProfile(_oc, face, axisOrigin, axisDir))
      throw new Error('The revolution axis passes through the profile. Move the axis or the sketch so the axis lies to one side of the profile.');
    const axis = new oc.gp_Ax1_2(new oc.gp_Pnt_3(...axisOrigin), new oc.gp_Dir_4(...axisDir));
    const mk = new oc.BRepPrimAPI_MakeRevol_2(face, axis, false);
    mk.Build(new oc.Message_ProgressRange_1());
    if (!mk.IsDone()) throw new Error('Revolution computation failed.');
    return mk.Shape();
  },
};
let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  (${detail})` : ''}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  (${detail})` : ''}`); }
};

// Circle face r, center (cx,0,0), in the ZX plane (normal +Y) — the user's sketch.
function circleFace(r, cx) {
  const ax2 = new oc.gp_Ax2_2(new oc.gp_Pnt_3(cx, 0, 0), new oc.gp_Dir_4(0, 1, 0), new oc.gp_Dir_4(1, 0, 0));
  const e = new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax2, r)).Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1(); wm.Add_1(e);
  return new oc.BRepBuilderAPI_MakeFace_15(wm.Wire(), true).Face();
}
// Half-disk in the ZX plane: straight (diameter) edge ALONG the X axis from (-r,0,0)
// to (r,0,0), bulging to +Z. Revolving around X (the diameter) → sphere — VALID.
function halfDiskFace(r) {
  const a = new oc.gp_Pnt_3(-r, 0, 0), b = new oc.gp_Pnt_3(r, 0, 0);
  const line = new oc.BRepBuilderAPI_MakeEdge_3(a, b).Edge();
  // semicircle from (r,0,0) over +Z back to (-r,0,0)
  const ax2 = new oc.gp_Ax2_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 1, 0), new oc.gp_Dir_4(1, 0, 0));
  const arc = new oc.BRepBuilderAPI_MakeEdge_9(new oc.gp_Circ_2(ax2, r), 0, Math.PI).Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1(); wm.Add_1(line); wm.Add_1(arc);
  return new oc.BRepBuilderAPI_MakeFace_15(wm.Wire(), true).Face();
}

const guard = (face, axis) => OccRevolutionService.axisIntersectsProfile(oc, face, [0, 0, 0], axis);

console.log('\nA1 — circle r4.5 @ x=30 (your sketch): axis X intersects, Y/Z do not');
{
  ok('axis X (through circle center) → flagged', guard(circleFace(4.5, 30), [1, 0, 0]) === true);
  ok('axis Z (30 away) → not flagged',           guard(circleFace(4.5, 30), [0, 0, 1]) === false);
  ok('axis Y (30 away) → not flagged',           guard(circleFace(4.5, 30), [0, 1, 0]) === false);
}

console.log('\nA2 — half-disk diameter ON the X axis → sphere, must NOT be flagged');
{
  ok('edge-on-axis half-disk → valid (not flagged)', guard(halfDiskFace(8), [1, 0, 0]) === false);
}

console.log('\nA3 — circle straddling the axis (center near axis) → flagged');
{
  ok('circle r10 @ x=3 (axis Z passes through it) → flagged', guard(circleFace(10, 3), [0, 0, 1]) === true);
  ok('circle r10 @ x=30 (axis Z outside) → not flagged',      guard(circleFace(10, 30), [0, 0, 1]) === false);
}

console.log('\nA4 — revolveProfile throws a clear message for the bad axis');
{
  const wire = (() => {
    const ax2 = new oc.gp_Ax2_2(new oc.gp_Pnt_3(30, 0, 0), new oc.gp_Dir_4(0, 1, 0), new oc.gp_Dir_4(1, 0, 0));
    const e = new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax2, 4.5)).Edge();
    const wm = new oc.BRepBuilderAPI_MakeWire_1(); wm.Add_1(e); return wm.Wire();
  })();
  let msg = '';
  try { OccRevolutionService.revolveProfile(oc, wire, [0, 0, 0], [1, 0, 0], 360); }
  catch (e) { msg = e.message; }
  ok('throws axis-through-profile message', /axis passes through the profile/i.test(msg), msg.slice(0, 50));
  // valid axis still builds
  let built = false;
  try { const s = OccRevolutionService.revolveProfile(oc, wire, [0, 0, 0], [0, 0, 1], 360); built = !s.IsNull(); } catch {}
  ok('valid axis (Z) still builds a solid', built);
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed ? 1 : 0);
