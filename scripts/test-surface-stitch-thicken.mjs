// ============================================================
// ToubkalCAD – scripts/test-surface-stitch-thicken.mjs
//
// Headless geometry test for Surface Modeling Phase 3: STITCH + THICKEN.
// Mirrors OccSurfaceService.stitch / .thicken.
//   • Stitch the 6 faces of a box → a CLOSED shell → promoted to a SOLID.
//   • Stitch 5 faces (open shell) with makeSolid → stays a SHELL (not watertight).
//   • Thicken an open 5-face shell → a SOLID.
//   • Thicken a single planar FACE → a SOLID.
//
// Run:  node scripts/test-surface-stitch-thicken.mjs
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
function faces(s) {
  const out = []; const e = new oc.TopExp_Explorer_2(s, ENUM.TopAbs_FACE, ENUM.TopAbs_SHAPE);
  for (; e.More(); e.Next()) out.push(oc.TopoDS.Face_1(e.Current())); return out;
}

// mirror of OccSurfaceService.stitch
function stitch(shapes, tryMakeSolid) {
  const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  for (const s of shapes) sew.Add(s);
  sew.Perform(new oc.Message_ProgressRange_1());
  const sewn = sew.SewedShape();
  if (tryMakeSolid && sewn.ShapeType() === ENUM.TopAbs_SHELL && oc.BRep_Tool.IsClosed_1(sewn)) {
    const mk = new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(sewn));
    mk.Build(new oc.Message_ProgressRange_1());
    if (mk.IsDone()) return mk.Shape();
  }
  return sewn;
}
// mirror of OccSurfaceService.thicken
function thicken(surface, t) {
  const mt = new oc.BRepOffsetAPI_MakeThickSolid();
  mt.MakeThickSolidBySimple(surface, t);
  mt.Build(new oc.Message_ProgressRange_1());
  if (!mt.IsDone()) throw new Error('thicken failed');
  return mt.Shape();
}

const box = new oc.BRepPrimAPI_MakeBox_2(10, 10, 10).Shape();
const bf = faces(box);

console.log('Stitch — all 6 box faces (closed → solid):');
{
  const s = stitch(bf, true);
  check('result is a SOLID', typeName(s) === 'SOLID', `got ${typeName(s)}`);
  check('contains exactly 1 solid', count(s, ENUM.TopAbs_SOLID) === 1, `solids=${count(s, ENUM.TopAbs_SOLID)}`);
}
console.log('Stitch — 5 box faces (open shell, makeSolid on):');
{
  const s = stitch(bf.slice(0, 5), true);
  check('result is a SHELL (not watertight)', typeName(s) === 'SHELL', `got ${typeName(s)}`);
  check('contains 0 enclosed solids', count(s, ENUM.TopAbs_SOLID) === 0, `solids=${count(s, ENUM.TopAbs_SOLID)}`);
}
console.log('Thicken — open 5-face shell → solid:');
{
  const shell = stitch(bf.slice(0, 5), false);
  const s = thicken(shell, 2);
  check('result is a SOLID', typeName(s) === 'SOLID', `got ${typeName(s)}`);
  check('contains 1 solid', count(s, ENUM.TopAbs_SOLID) === 1, `solids=${count(s, ENUM.TopAbs_SOLID)}`);
}
console.log('Thicken — single planar face → solid:');
{
  const s = thicken(bf[0], 2);
  check('result is a SOLID', typeName(s) === 'SOLID', `got ${typeName(s)}`);
  check('has 6 faces (slab)', count(s, ENUM.TopAbs_FACE) === 6, `faces=${count(s, ENUM.TopAbs_FACE)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
