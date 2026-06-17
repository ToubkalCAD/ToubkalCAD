// ============================================================
// ToubkalCAD – scripts/test-loft-twist.mjs
//
// Reproduces the rectangle→circle loft TWIST bug (4-vertex profile to a
// 1-edge circle) and measures which OCC settings fix it. Headless, no browser.
//
// The twist/bowtie comes from two uncontrolled wire properties that
// BRepOffsetAPI_ThruSections is sensitive to:
//   1. winding direction  (CW vs CCW about the loft axis) → hourglass pinch
//   2. seam / start-vertex angular position                → diagonal twist
//   3. CheckCompatibility(false) assumes wires ALREADY align edge-for-edge;
//      with 4 edges vs 1 that's false, so OCC maps them arbitrarily.
//
// A CORRECT solid loft from a 10×10 square to an r≈5.64 circle (same area)
// over height 10 has volume ≈ (A_sq+A_ci)/2 * H but bounded well above zero
// and is a single valid solid. A twisted/pinched loft self-intersects → the
// volume collapses far below the section-prism band and/or BRepCheck fails.
//
// Run:  node scripts/test-loft-twist.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  (${detail})` : ''}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  (${detail})` : ''}`); }
}

function measure(solid) {
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(solid, p, true, false, false);
  const r = { vol: p.Mass() };
  p.delete();
  return r;
}
function countSolids(shape) {
  let n = 0;
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) { n++; exp.Next(); }
  return n;
}
function isValid(shape) {
  const a = new oc.BRepCheck_Analyzer(shape, true, false);
  const v = a.IsValid_2();
  a.delete();
  return v;
}

// ── square wire (4 edges) on plane z=z0; reversed=true winds the other way ──
function squareWire(half, z0 = 0, reversed = false) {
  let pts = [
    [-half, -half], [half, -half], [half, half], [-half, half],
  ];
  if (reversed) pts = [pts[0], ...pts.slice(1).reverse()]; // flip winding, keep start
  const v = pts.map(([x, y]) => new oc.gp_Pnt_3(x, y, z0));
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const me = new oc.BRepBuilderAPI_MakeEdge_3(v[i], v[(i + 1) % 4]);
    edges.push(me.Edge()); me.delete();
  }
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  for (const e of edges) wm.Add_1(e);
  const w = wm.Wire();
  v.forEach((p) => p.delete()); wm.delete();
  return w;
}

// ── full circle wire (1 edge) on plane z=z0; startAngle rotates the seam ──
function circleWire(radius, z0 = 0, startAngle = 0) {
  const o = new oc.gp_Pnt_3(0, 0, z0);
  const n = new oc.gp_Dir_4(0, 0, 1);
  const x = new oc.gp_Dir_4(Math.cos(startAngle), Math.sin(startAngle), 0);
  const ax2 = new oc.gp_Ax2_2(o, n, x);
  const circ = new oc.gp_Circ_2(ax2, radius);
  const mk = new oc.BRepBuilderAPI_MakeEdge_8(circ);
  const edge = mk.Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  wm.Add_1(edge);
  const w = wm.Wire();
  o.delete(); n.delete(); x.delete(); ax2.delete(); circ.delete(); mk.delete(); wm.delete();
  return w;
}

function loft(profiles, { isSolid = true, ruled = false, smoothing = true, checkCompat = false } = {}) {
  const l = new oc.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6);
  if (smoothing && !ruled) l.SetSmoothing(true);
  l.CheckCompatibility(checkCompat);
  for (const w of profiles) l.AddWire(w);
  l.Build(new oc.Message_ProgressRange_1());
  if (!l.IsDone()) return null;
  return l.Shape();
}

const HALF = 5;                 // 10×10 square → area 100
const R = Math.sqrt(100 / Math.PI); // circle of equal area ≈ 5.64
const H = 10;
const A = 100;                   // both sections ~equal area
const prism = A * H;             // ≈ 1000 reference volume band center

function report(name, shape) {
  if (!shape) { ok(`${name}: builds`, false, 'IsDone=false'); return null; }
  const s = countSolids(shape), m = measure(shape), valid = isValid(shape);
  const pct = (m.vol / prism * 100).toFixed(0);
  console.log(`    ${name}: solids=${s} vol=${m.vol.toFixed(1)} (${pct}% of prism) valid=${valid}`);
  return { s, vol: m.vol, valid };
}

// Threshold: a clean loft keeps ~70-100% of the section prism volume.
// A twisted/bowtie loft collapses well below ~50%.
const clean = (r) => r && r.s === 1 && r.valid && r.vol > 0.6 * prism;

console.log('\nT1 — same winding, aligned seam (best case)');
{
  const r = report('current(compat=false)', loft([squareWire(HALF, 0), circleWire(R, H)]));
  ok('clean solid', clean(r));
}

console.log('\nT2 — circle seam rotated 45° (seam misalignment → twist)');
{
  const a = report('current(compat=false)', loft([squareWire(HALF, 0), circleWire(R, H, Math.PI / 4)]));
  const b = report('compat=TRUE         ', loft([squareWire(HALF, 0), circleWire(R, H, Math.PI / 4)], { checkCompat: true }));
  ok('current handles rotated seam', clean(a));
  ok('compat=true handles rotated seam', clean(b));
}

console.log('\nT3 — OPPOSITE winding (CW square vs CCW circle → hourglass pinch)');
{
  const a = report('current(compat=false)', loft([squareWire(HALF, 0, true), circleWire(R, H)]));
  const b = report('compat=TRUE         ', loft([squareWire(HALF, 0, true), circleWire(R, H)], { checkCompat: true }));
  ok('current handles opposite winding', clean(a));
  ok('compat=true handles opposite winding', clean(b));
}

console.log('\nT4 — opposite winding + rotated seam (worst case, both defects)');
{
  const a = report('current(compat=false)', loft([squareWire(HALF, 0, true), circleWire(R, H, Math.PI / 4)]));
  const b = report('compat=TRUE         ', loft([squareWire(HALF, 0, true), circleWire(R, H, Math.PI / 4)], { checkCompat: true }));
  ok('current handles worst case', clean(a));
  ok('compat=true handles worst case', clean(b));
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
console.log('(failures here are EXPECTED — they map which defects break the loft)');

// ── General-case sweep: arbitrary N-gon → M-gon / circle, compat=true ──
function ngonWire(n, radius, z0 = 0, phase = 0) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (2 * Math.PI * i) / n;
    v.push(new oc.gp_Pnt_3(radius * Math.cos(a), radius * Math.sin(a), z0));
  }
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < n; i++) {
    const me = new oc.BRepBuilderAPI_MakeEdge_3(v[i], v[(i + 1) % n]);
    wm.Add_1(me.Edge()); me.delete();
  }
  const w = wm.Wire();
  v.forEach((p) => p.delete()); wm.delete();
  return w;
}

console.log('\nT5 — GENERAL N→M with compat=TRUE (the real-world cases)');
const cases = [
  ['pentagon(5) → circle(1)',      [ngonWire(5, R, 0), circleWire(R, H)]],
  ['triangle(3) → octagon(8)',     [ngonWire(3, R, 0), ngonWire(8, R, H)]],
  ['12-gon → square(4) → circle',  [ngonWire(12, R, 0), squareWire(HALF, H), circleWire(R, 2 * H)]],
  ['hexagon phase-rotated → circle',[ngonWire(6, R, 0, 0.37), circleWire(R, H, 1.1)]],
];
for (const [name, profs] of cases) {
  const r = report(name, loft(profs, { checkCompat: true }));
  ok(name, r && r.s === 1 && r.valid && r.vol > 0);
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed (T1-T4 current-mode failures expected)\x1b[0m`);
