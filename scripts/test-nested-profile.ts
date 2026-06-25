// ============================================================
// ToubkalCAD – scripts/test-nested-profile.ts
//
// Headless geometry test for NESTED-PROFILE extrusion (circle-in-rectangle →
// block with a hole). Drives the REAL ProfileNesting.buildNestedFaces() against
// the OpenCascade kernel in Node, prisms the resulting faces, and asserts the
// solid volume equals (outer − holes) × height for:
//   1. one circle inside a rectangle      → 1 hole
//   2. four circles inside a rectangle    → 4 holes
//   3. small rectangle inside a circle inside a rectangle → solid island (depth 2)
//   4. two disjoint rectangles            → compound of 2 solids, no false hole
//
// Run:  npx tsx scripts/test-nested-profile.ts   (from the project root)
// Exits non-zero if any assertion fails.
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
import { WasmScope } from '../src/utils/WasmScope';
import { buildNestedFaces } from '../src/services/ProfileNesting';
import { OccExtrusionService } from '../src/services/OccExtrusionService';

const oc: any = await initOpenCascade();

let passed = 0, failed = 0;
const EPS = 1e-1;
function check(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) <= EPS + 1e-3 * Math.abs(want);
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  (vol=${got.toFixed(2)})`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  got ${got.toFixed(2)} want ${want.toFixed(2)}`); }
}

const H = 20;                                 // extrude height (along +Z)

// ─── Wire builders on the XY plane (normal +Z) ────────────────────────────────
function rectWire(cx: number, cy: number, w: number, h: number): any {
  const poly = new oc.BRepBuilderAPI_MakePolygon_1();
  const cs: [number, number][] = [
    [cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2],
  ];
  for (const [x, y] of cs) { const p = new oc.gp_Pnt_3(x, y, 0); poly.Add_1(p); p.delete(); }
  poly.Close();
  const wire = poly.Wire(); poly.delete();
  return wire;
}
function circleWire(cx: number, cy: number, r: number): any {
  const c   = new oc.gp_Pnt_3(cx, cy, 0);
  const dir = new oc.gp_Dir_4(0, 0, 1);
  const ax2 = new oc.gp_Ax2_3(c, dir);
  const cir = new oc.gp_Circ_2(ax2, r);
  const edge = new oc.BRepBuilderAPI_MakeEdge_8(cir).Edge();
  const wire = new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
  c.delete(); dir.delete(); ax2.delete(); cir.delete();
  return wire;
}

/** Prism every nested face, fuse into one compound, return total closed volume. */
function extrudeVolume(wires: any[]): { vol: number; solids: number } {
  const scope = new WasmScope();
  try {
    const faces = buildNestedFaces(oc, wires, scope);
    let vol = 0, solids = 0;
    for (const f of faces) {
      const vec = new oc.gp_Vec_4(0, 0, H);
      const prism = new oc.BRepPrimAPI_MakePrism_1(f, vec, false, true);
      const solid = prism.Shape();
      const props = new oc.GProp_GProps_1();
      oc.BRepGProp.VolumeProperties_1(solid, props, true, false, false);
      vol += props.Mass(); solids++;
      props.delete(); prism.delete(); vec.delete();
    }
    return { vol, solids };
  } finally {
    scope.free();
  }
}

const PI = Math.PI;

console.log('\nNested-profile extrusion (ProfileNesting.buildNestedFaces):');

// 1. circle in rectangle → 1 hole
{
  const wires = [rectWire(0, 0, 100, 80), circleWire(0, 0, 25)];
  const { vol, solids } = extrudeVolume(wires);
  check('rect 100×80 with 1 hole r25', vol, (100 * 80 - PI * 25 * 25) * H);
  check('  → single solid', solids, 1);
}

// 2. four circles in rectangle → 4 holes
{
  const wires = [
    rectWire(0, 0, 200, 200),
    circleWire(-50, -50, 15), circleWire(50, -50, 15),
    circleWire(-50, 50, 15),  circleWire(50, 50, 15),
  ];
  const { vol, solids } = extrudeVolume(wires);
  check('rect 200×200 with 4 holes r15', vol, (200 * 200 - 4 * PI * 15 * 15) * H);
  check('  → single solid', solids, 1);
}

// 3. small rect inside circle inside rect → island (depth-2 solid)
{
  const wires = [
    rectWire(0, 0, 200, 200),   // depth 0 outer
    circleWire(0, 0, 60),       // depth 1 hole
    rectWire(0, 0, 40, 40),     // depth 2 solid island
  ];
  const { vol, solids } = extrudeVolume(wires);
  check('rect ⊃ hole(circle r60) ⊃ island(40×40)', vol, (200 * 200 - PI * 60 * 60 + 40 * 40) * H);
  check('  → two solids (outer + island)', solids, 2);
}

// 4. two disjoint rectangles → two solids, no spurious hole
{
  const wires = [rectWire(-100, 0, 50, 50), rectWire(100, 0, 50, 50)];
  const { vol, solids } = extrudeVolume(wires);
  check('two disjoint rects', vol, 2 * 50 * 50 * H);
  check('  → two solids', solids, 2);
}

// ─── Up-to-* modes must also subtract holes (buildProfileShape) ───────────────
function solidVolume(solid: any): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(solid, props, true, false, false);
  const v = props.Mass(); props.delete();
  return v;
}

console.log('\nUp-to-* extrusion with a hole:');

// 5. Up-to-Plane (plane ⟂ axis at z=15) — holed profile → (rect − hole) × 15
{
  const wires = [rectWire(0, 0, 100, 80), circleWire(0, 0, 25)];
  const solid = OccExtrusionService.extrudeUpToPlane(
    oc, wires, { direction: [0, 0, 1], neutralPoint: [0, 0, 0] }, [0, 0, 15], [0, 0, 1],
  );
  check('up-to-plane keeps the hole', solidVolume(solid), (100 * 80 - PI * 25 * 25) * 15);
  solid.delete();
}

// 6. Up-to-Face (box bottom face at z=10, ⟂ axis) — holed profile → (rect − hole) × 10
{
  const wires = [rectWire(0, 0, 100, 80), circleWire(0, 0, 25)];
  const p1 = new oc.gp_Pnt_3(-100, -100, 10), p2 = new oc.gp_Pnt_3(100, 100, 30);
  const box = new oc.BRepPrimAPI_MakeBox_4(p1, p2).Solid();
  p1.delete(); p2.delete();
  const solid = OccExtrusionService.extrudeUpToFace(
    oc, wires, { direction: [0, 0, 1], neutralPoint: [0, 0, 0] }, box, [0, 0, 10],
  );
  check('up-to-face keeps the hole', solidVolume(solid), (100 * 80 - PI * 25 * 25) * 10);
  solid.delete(); box.delete();
}

console.log(`\n${failed === 0 ? '\x1b[32mALL PASS\x1b[0m' : '\x1b[31mFAILURES\x1b[0m'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
