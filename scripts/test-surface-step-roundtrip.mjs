// ============================================================
// ToubkalCAD – scripts/test-surface-step-roundtrip.mjs
//
// Cross-cutting guard check: a zero-thickness SURFACE body survives a STEP
// round-trip. Mirrors OccExchangeService.exportSTEP/importFile with the same
// STEPControl_AsIs mode (which preserves shells/faces, not just solids).
//
//   surface extrude (open cylindrical SHELL) → write STEP → read STEP →
//   still a SHELL/FACE with the SAME surface area (within tolerance).
//
// Run:  node scripts/test-surface-step-roundtrip.mjs
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
const count = (s, k) => { const e = new oc.TopExp_Explorer_2(s, k, ENUM.TopAbs_SHAPE); let n = 0; for (; e.More(); e.Next()) n++; return n; };
const area  = (s) => { const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(s, g, false, false); return g.Mass(); };

// Build an open cylindrical SHELL the same way OccExtrusionService.extrudeSurface does:
// prism a closed circle WIRE (no face cap) → tube wall, no end caps.
function surfaceTube() {
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1));
  const circ = new oc.gp_Circ_2(ax, 5);
  const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  const wire = new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
  const vec  = new oc.gp_Vec_4(0, 0, 12);
  const prism = new oc.BRepPrimAPI_MakePrism_1(wire, vec, false, true);
  prism.Build(new oc.Message_ProgressRange_1());
  return prism.Shape();
}

function exportSTEP(shape) {
  const writer = new oc.STEPControl_Writer_1();
  writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange_1());
  writer.Write('rt.stp');
  return oc.FS.readFile('rt.stp', { encoding: 'binary' });
}
function importSTEP(bytes) {
  oc.FS.writeFile('in.stp', bytes);
  const reader = new oc.STEPControl_Reader_1();
  reader.ReadFile('in.stp');
  reader.TransferRoots(new oc.Message_ProgressRange_1());
  return reader.OneShape();
}

console.log('STEP round-trip — surface tube (open cylindrical shell):');
const original = surfaceTube();
const tn0 = typeName(original), a0 = area(original);
check('exported shape is a surface (SHELL/FACE, 0 solids)',
  (tn0 === 'SHELL' || tn0 === 'FACE') && count(original, ENUM.TopAbs_SOLID) === 0, `type=${tn0} area=${a0.toFixed(1)}`);

const bytes = exportSTEP(original);
check('STEP bytes written', bytes && bytes.length > 100, `bytes=${bytes?.length ?? 0}`);

const reimported = importSTEP(bytes);
const tn1 = typeName(reimported), a1 = area(reimported);
check('re-imported shape still a surface (no spurious solid)',
  count(reimported, ENUM.TopAbs_SOLID) === 0 && a1 > 1, `type=${tn1} solids=${count(reimported, ENUM.TopAbs_SOLID)}`);
check('surface area preserved through round-trip', Math.abs(a1 - a0) < 0.5, `before=${a0.toFixed(2)} after=${a1.toFixed(2)}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
