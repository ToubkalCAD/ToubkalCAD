// ============================================================
// ToubkalCAD – scripts/test-surface-solidify.mjs
//
// Headless geometry test for the Surface→Solid SOLIDIFY (cap/close) convenience.
// Mirrors OccSurfaceService.solidify — cap every closed free-boundary loop with a
// patch face (ShapeAnalysis_FreeBounds.GetClosedWires → BRepBuilderAPI_MakeFace),
// sew surface+caps into a watertight shell, MakeSolid, orient outward.
//
//   open cylindrical tube (r=5, h=12, no caps) → SOLID, +volume π·25·12 ≈ 942.5,
//   3 faces (wall + 2 disks), positive (outward-oriented) volume.
//
// Run:  node scripts/test-surface-solidify.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const E = oc.TopAbs_ShapeEnum;
const tn = (s) => { const t = s.ShapeType(); return t === E.TopAbs_SOLID ? 'SOLID' : t === E.TopAbs_SHELL ? 'SHELL' : t === E.TopAbs_FACE ? 'FACE' : 'OTHER'; };
const count = (s, k) => { const e = new oc.TopExp_Explorer_2(s, k, E.TopAbs_SHAPE); let n = 0; for (; e.More(); e.Next()) n++; return n; };
const vol = (s) => { const g = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(s, g, true, false, false); return g.Mass(); };

function patch(w) { const mk = new oc.BRepBuilderAPI_MakeFace_15(w, true); if (!mk.IsDone()) throw new Error('patch'); return mk.Face(); }
function solidify(surface) {
  const fb = new oc.ShapeAnalysis_FreeBounds_2(surface, 1e-6, false, false);
  const closed = fb.GetClosedWires();
  const caps = [];
  const w = new oc.TopExp_Explorer_2(closed, E.TopAbs_WIRE, E.TopAbs_SHAPE);
  for (; w.More(); w.Next()) caps.push(patch(oc.TopoDS.Wire_1(w.Current())));
  const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  sew.Add(surface); for (const c of caps) sew.Add(c);
  sew.Perform(new oc.Message_ProgressRange_1());
  const sewn = sew.SewedShape();
  if (sewn.ShapeType() !== E.TopAbs_SHELL || !oc.BRep_Tool.IsClosed_1(sewn)) throw new Error('not watertight');
  const mk = new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(sewn));
  mk.Build(new oc.Message_ProgressRange_1());
  const solid = mk.Solid();
  oc.BRepLib.OrientClosedSolid(solid);
  return { solid, nCaps: caps.length };
}

// open tube: surface-extrude a circle wire (no caps)
const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));
const wire = new oc.BRepBuilderAPI_MakeWire_2(new oc.BRepBuilderAPI_MakeEdge_8(new oc.gp_Circ_2(ax, 5)).Edge()).Wire();
const prism = new oc.BRepPrimAPI_MakePrism_1(wire, new oc.gp_Vec_4(0, 0, 12), false, true);
prism.Build(new oc.Message_ProgressRange_1());
const tube = prism.Shape();

console.log('Solidify — open cylindrical tube (r=5, h=12) → capped solid:');
{
  check('input is an open SHELL', tn(tube) === 'SHELL' && count(tube, E.TopAbs_SOLID) === 0, `type=${tn(tube)}`);
  const { solid, nCaps } = solidify(tube);
  check('capped 2 open boundary loops', nCaps === 2, `nCaps=${nCaps}`);
  check('result is a SOLID', tn(solid) === 'SOLID', `got ${tn(solid)}`);
  check('has 3 faces (wall + 2 disks)', count(solid, E.TopAbs_FACE) === 3, `faces=${count(solid, E.TopAbs_FACE)}`);
  check('positive (outward) volume ≈ π·25·12', Math.abs(vol(solid) - Math.PI * 25 * 12) < 1, `vol=${vol(solid).toFixed(1)} (~${(Math.PI * 25 * 12).toFixed(1)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
