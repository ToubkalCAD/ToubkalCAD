// ============================================================
// ToubkalCAD – scripts/test-extrude.mjs
//
// Headless geometry test for the extrusion tool (E1 + E2).
// Runs the OpenCascade kernel in Node (no browser) and asserts volume +
// centroid invariants for every end condition and for Pad/Pocket booleans.
//
// The extrude() / fuse() / subtract() helpers below mirror the exact OCC call
// sequences in:
//   • src/services/OccExtrusionService.ts  (extrude — E1)
//   • src/services/OccBooleanService.ts     (fuse/subtract — E2)
// so this validates the geometry core the UI drives. The React / Three.js /
// picking layer is out of scope here — verify that interactively in-browser.
//
// Run:  node scripts/test-extrude.mjs        (from the project root)
//       npm run test:extrude
// Exits non-zero if any assertion fails.
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';

const oc = await initOpenCascade();

// ─── Tiny assert harness ──────────────────────────────────────────────────────
let passed = 0, failed = 0;
const EPS = 1e-2;
const near = (a, b) => Math.abs(a - b) <= EPS;

function check(label, got, want) {
  const ok = Object.keys(want).every((k) => near(got[k], want[k]));
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${(+v).toFixed(3)}`).join(' ');
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  (${fmt(got)})`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  got[${fmt(got)}] want[${fmt(want)}]`); }
}

// ─── OCC helpers ──────────────────────────────────────────────────────────────

/** Volume + centroid Z of a solid (exact geometry, not tessellated). */
function measure(solid) {
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(solid, p, true, false, false);
  const c = p.CentreOfMass();
  const r = { vol: p.Mass(), cz: c.Z() };
  c.delete(); p.delete();
  return r;
}

/** Closed square wire on a plane parallel to XY (normal +Z) at height z. */
function squareWire(size, z = 0, x0 = 0, y0 = 0) {
  const poly = new oc.BRepBuilderAPI_MakePolygon_1();
  for (const [x, y] of [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]]) {
    const pt = new oc.gp_Pnt_3(x, y, z);
    poly.Add_1(pt); pt.delete();
  }
  poly.Close();
  const w = poly.Wire();
  poly.delete();
  return w;
}

/** Mirror of OccExtrusionService.extrude (single-prism end conditions). */
function extrude(wire, { height, end = 'blind', height2 = 0, reverse = false, direction = [0, 0, 1] }) {
  let [dx, dy, dz] = direction;
  const len = Math.hypot(dx, dy, dz);
  dx /= len; dy /= len; dz /= len;
  if (reverse) { dx = -dx; dy = -dy; dz = -dz; }

  let back = 0, total = height;
  if (end === 'symmetric') { back = height / 2; total = height; }
  else if (end === 'twoSided') { back = height2; total = height + height2; }

  const fm = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  let face = fm.Shape();
  if (back > 1e-9) {
    const trsf = new oc.gp_Trsf_1();
    const tv = new oc.gp_Vec_4(-dx * back, -dy * back, -dz * back);
    trsf.SetTranslation_1(tv);
    face = new oc.BRepBuilderAPI_Transform_2(face, trsf, true).Shape();
    trsf.delete(); tv.delete();
  }
  const vec = new oc.gp_Vec_4(dx * total, dy * total, dz * total);
  const solid = new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true).Shape();
  vec.delete();
  return solid;
}

/** Mirror of OccExtrusionService.applyDraft (taper planar side walls). */
function applyDraft(solid, angleDeg, pullDir, neutralPoint = [0, 0, 0]) {
  const angle = (angleDeg * Math.PI) / 180;
  const [px, py, pz] = pullDir;
  const dir = new oc.gp_Dir_4(px, py, pz);
  const pnt = new oc.gp_Pnt_3(neutralPoint[0], neutralPoint[1], neutralPoint[2]);
  const neutral = new oc.gp_Pln_3(pnt, dir);
  const draft = new oc.BRepOffsetAPI_DraftAngle_2(solid);
  const exp = new oc.TopExp_Explorer_2(solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let added = 0;
  while (exp.More()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const surfH = oc.BRep_Tool.Surface_2(face);
    if (!surfH.IsNull()) {
      const ad = new oc.GeomAdaptor_Surface_2(surfH);
      if (ad.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        const nd = ad.Plane().Axis().Direction();
        if (Math.abs(nd.X() * px + nd.Y() * py + nd.Z() * pz) < 0.5) {
          draft.Add(face, dir, angle, neutral, true);
          if (draft.AddDone()) added++;
        }
      }
    }
    exp.Next();
  }
  if (added === 0) return solid;
  draft.Build(new oc.Message_ProgressRange_1());
  if (!draft.IsDone()) throw new Error('draft build failed');
  return draft.Shape();
}

/** Mirror of OccExtrusionService.applyThickWall (hollow prism → open tube). */
function applyThickWall(solid, thickness, pullDir) {
  const [px, py, pz] = pullDir;
  const caps = new oc.TopTools_ListOfShape_1();
  const exp = new oc.TopExp_Explorer_2(solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const surfH = oc.BRep_Tool.Surface_2(face);
    if (!surfH.IsNull()) {
      const ad = new oc.GeomAdaptor_Surface_2(surfH);
      if (ad.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        const nd = ad.Plane().Axis().Direction();
        if (Math.abs(nd.X() * px + nd.Y() * py + nd.Z() * pz) > 0.5) caps.Append_1(face);
      }
    }
    exp.Next();
  }
  const mts = new oc.BRepOffsetAPI_MakeThickSolid();
  mts.MakeThickSolidByJoin(solid, caps, -Math.abs(thickness), 1e-3,
    oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
    oc.GeomAbs_JoinType.GeomAbs_Intersection, false, new oc.Message_ProgressRange_1());
  mts.Build(new oc.Message_ProgressRange_1());
  if (!mts.IsDone()) throw new Error('thick build failed');
  return mts.Shape();
}

/** Mirror of OccBooleanService.fuse / .subtract. */
function fuse(a, b) {
  const op = new oc.BRepAlgoAPI_Fuse_3(a, b, new oc.Message_ProgressRange_1());
  op.Build(new oc.Message_ProgressRange_1());
  const s = op.Shape(); op.delete(); return s;
}
function subtract(a, b) {
  const op = new oc.BRepAlgoAPI_Cut_3(a, b, new oc.Message_ProgressRange_1());
  op.Build(new oc.Message_ProgressRange_1());
  const s = op.Shape(); op.delete(); return s;
}

/** Mirror of OccExtrusionService.projRange. */
function projRange(shape, base, dir) {
  let min = Infinity, max = -Infinity;
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex_1(exp.Current()));
    const proj = (p.X() - base[0]) * dir[0] + (p.Y() - base[1]) * dir[1] + (p.Z() - base[2]) * dir[2];
    if (proj < min) min = proj;
    if (proj > max) max = proj;
    exp.Next();
  }
  return { min, max };
}

/** Mirror of OccExtrusionService.extrudeUpToFace. */
function extrudeUpToFace(wire, dir, target, neutralPoint = [0, 0, 0]) {
  let [dx, dy, dz] = dir; const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
  const d = [dx, dy, dz];
  const over = projRange(target, neutralPoint, d).max + 10;
  const fm = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  const vec = new oc.gp_Vec_4(dx * over, dy * over, dz * over);
  const prism = new oc.BRepPrimAPI_MakePrism_1(fm.Shape(), vec, false, true).Shape();
  const cut = new oc.BRepAlgoAPI_Cut_3(prism, target, new oc.Message_ProgressRange_1());
  cut.Build(new oc.Message_ProgressRange_1());
  const trimmed = cut.Shape();
  let best = null, bestKey = Infinity;
  const exp = new oc.TopExp_Explorer_2(trimmed, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const sol = oc.TopoDS.Solid_1(exp.Current());
    const key = Math.abs(projRange(sol, neutralPoint, d).min);
    if (key < bestKey) { bestKey = key; best = sol; }
    exp.Next();
  }
  return best;
}

/** Mirror of OccExtrusionService.extrudeUpToNext (cut all bodies, keep base). */
function extrudeUpToNext(wire, dir, bodies, neutralPoint = [0, 0, 0]) {
  let [dx, dy, dz] = dir; const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len; const d = [dx, dy, dz];
  let over = 0; for (const b of bodies) over = Math.max(over, projRange(b, neutralPoint, d).max); over += 10;
  const fm = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  let cur = new oc.BRepPrimAPI_MakePrism_1(fm.Shape(), new oc.gp_Vec_4(dx * over, dy * over, dz * over), false, true).Shape();
  for (const b of bodies) {
    const cut = new oc.BRepAlgoAPI_Cut_3(cur, b, new oc.Message_ProgressRange_1());
    cut.Build(new oc.Message_ProgressRange_1());
    if (cut.IsDone()) cur = cut.Shape();
  }
  let best = null, bestKey = Infinity;
  const exp = new oc.TopExp_Explorer_2(cur, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const sol = oc.TopoDS.Solid_1(exp.Current());
    const key = Math.abs(projRange(sol, neutralPoint, d).min);
    if (key < bestKey) { bestKey = key; best = sol; }
    exp.Next();
  }
  return best;
}

/** Mirror of OccExtrusionService.extrudeUpToLast (Common → furthest, blind). */
function extrudeUpToLast(wire, dir, bodies, neutralPoint = [0, 0, 0]) {
  let [dx, dy, dz] = dir; const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len; const d = [dx, dy, dz];
  let over = 0; for (const b of bodies) over = Math.max(over, projRange(b, neutralPoint, d).max); over += 10;
  const overShape = new oc.BRepPrimAPI_MakePrism_1(new oc.BRepBuilderAPI_MakeFace_15(wire, true).Shape(),
    new oc.gp_Vec_4(dx * over, dy * over, dz * over), false, true).Shape();
  let farMost = -Infinity;
  for (const b of bodies) {
    const common = new oc.BRepAlgoAPI_Common_3(overShape, b, new oc.Message_ProgressRange_1());
    common.Build(new oc.Message_ProgressRange_1());
    if (!common.IsDone()) continue;
    const cs = common.Shape();
    if (!new oc.TopExp_Explorer_2(cs, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE).More()) continue;
    farMost = Math.max(farMost, projRange(cs, neutralPoint, d).max);
  }
  return new oc.BRepPrimAPI_MakePrism_1(new oc.BRepBuilderAPI_MakeFace_15(wire, true).Shape(),
    new oc.gp_Vec_4(dx * farMost, dy * farMost, dz * farMost), false, true).Shape();
}

/** Mirror of OccExtrusionService.extrudeProfiles. */
function extrudeProfiles(wires, height) {
  const builder = new oc.BRep_Builder();
  const compound = new oc.TopoDS_Compound();
  builder.MakeCompound(compound);
  for (const w of wires) builder.Add(compound, extrude(w, { height }));
  return compound;
}

// ─── E1 — End conditions + reverse ────────────────────────────────────────────
// 10×10 square on XY, extruded along +Z. Volume = 100·length; centroid Z = mid-span.
console.log('\nE1 — end conditions + reverse (10×10 profile)');

check('blind h=10            → box z[0,10]',
  measure(extrude(squareWire(10), { height: 10 })),
  { vol: 1000, cz: 5 });

check('reverse h=10          → box z[-10,0]',
  measure(extrude(squareWire(10), { height: 10, reverse: true })),
  { vol: 1000, cz: -5 });

check('symmetric h=10        → box z[-5,5]',
  measure(extrude(squareWire(10), { height: 10, end: 'symmetric' })),
  { vol: 1000, cz: 0 });

check('twoSided h=10 h2=4    → box z[-4,10]',
  measure(extrude(squareWire(10), { height: 10, end: 'twoSided', height2: 4 })),
  { vol: 1400, cz: 3 });

// ─── E2 — Pad (fuse) / Pocket (cut) ───────────────────────────────────────────
console.log('\nE2 — Pad / Pocket booleans');

// Target body: 10×10×10 block at z[0,10].
const target = extrude(squareWire(10), { height: 10 });
check('target body           → 10×10×10', measure(target), { vol: 1000, cz: 5 });

// Pocket: subtract a 4×4 column (centred, through the block) → 1000 − 160.
const pocketTool = extrude(squareWire(4, 0, 3, 3), { height: 10 });
const pocketed   = subtract(target, pocketTool);
check('pocket 4×4 through    → 1000 − 160 = 840', measure(pocketed), { vol: 840, cz: 5 });

// Pad: fuse a 10×10 block stacked on top (z[10,20]) → 2000, centroid rises to 15… union centroid = 10.
const padTool = extrude(squareWire(10, 10), { height: 10 });
const padded  = fuse(target, padTool);
check('pad block on top      → 1000 + 1000 = 2000', measure(padded), { vol: 2000, cz: 10 });

// ─── E4 — Draft (taper) ───────────────────────────────────────────────────────
// 10×10 blind prism h=10, then 10° draft on the 4 side walls → square frustum.
// Square pyramidal frustum: V = (h/3)(A1 + A2 + √(A1·A2)).
//   inward  top side 10−2·10·tan10° = 6.4735 → V ≈ 688.8
//   outward top side 10+2·10·tan10° = 13.527 → V ≈ 1394.1
console.log('\nE4 — draft / taper');
{
  const drafted = applyDraft(extrude(squareWire(10), { height: 10 }), 10, [0, 0, 1]);
  const m = measure(drafted);
  const t = Math.tan(10 * Math.PI / 180);
  const frustum = (top) => (10 / 3) * (100 + top * top + Math.sqrt(100 * top * top));
  const vIn = frustum(10 - 2 * 10 * t), vOut = frustum(10 + 2 * 10 * t);
  const okFrustum = Math.abs(m.vol - vIn) < 1 || Math.abs(m.vol - vOut) < 1;
  const sign = Math.abs(m.vol - vIn) < 1 ? 'inward' : (Math.abs(m.vol - vOut) < 1 ? 'outward' : '???');
  check(`10° draft → square frustum (${sign})`, { vol: m.vol, frustum: okFrustum ? 1 : 0 }, { frustum: 1 });
  console.log(`     vol=${m.vol.toFixed(2)}  (straight=1000, inward≈${vIn.toFixed(1)}, outward≈${vOut.toFixed(1)})`);
}

// ─── E3 — Thick (thin-wall) ───────────────────────────────────────────────────
// 10×10×10 prism, wall t=2, both caps removed → square tube.
// Wall volume = outer − cavity = 1000 − (10−2·2)²·10 = 1000 − 360 = 640.
console.log('\nE3 — thick / thin-wall');
{
  const tube = applyThickWall(extrude(squareWire(10), { height: 10 }), 2, [0, 0, 1]);
  check('wall t=2 (caps open)  → 1000 − 6×6×10 = 640', measure(tube), { vol: 640, cz: 5 });
}

// ─── E5 — Up to Face ──────────────────────────────────────────────────────────
// Target block z[20,30]; profile at z=0 extruded "up to face" → fills z[0,20].
console.log('\nE5 — up to face');
{
  const target = extrude(squareWire(10, 20), { height: 10 });   // block z[20,30]
  const up = extrudeUpToFace(squareWire(10), [0, 0, 1], target); // base piece z[0,20]
  check('up-to-face (block z[20,30]) → z[0,20] = 2000', measure(up), { vol: 2000, cz: 10 });
}

// ─── E6 — Up to Next / Up to Last ─────────────────────────────────────────────
// Two blocks: A z[20,30], B z[40,50]. Profile at z=0.
//   Next → stops at nearest face (z=20)  → z[0,20] = 2000
//   Last → reaches furthest face (z=50)  → z[0,50] = 5000
console.log('\nE6 — up to next / last');
{
  const A = extrude(squareWire(10, 20), { height: 10 });
  const B = extrude(squareWire(10, 40), { height: 10 });
  check('up-to-next (nearest z20) → z[0,20] = 2000', measure(extrudeUpToNext(squareWire(10), [0, 0, 1], [A, B])), { vol: 2000, cz: 10 });
  check('up-to-last (furthest z50) → z[0,50] = 5000', measure(extrudeUpToLast(squareWire(10), [0, 0, 1], [A, B])), { vol: 5000, cz: 25 });
}

// ─── E7 — Multi-profile (compound) ────────────────────────────────────────────
// Two disjoint squares (6² and 4²) extruded h=5 → one compound, volumes summed.
console.log('\nE7 — multi-profile');
{
  const comp = extrudeProfiles([squareWire(6, 0, 0, 0), squareWire(4, 0, 10, 0)], 5);
  check('two profiles → 6²·5 + 4²·5 = 260', measure(comp), { vol: 260 });
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed ? 1 : 0);
