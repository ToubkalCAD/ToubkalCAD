// ============================================================
// ToubkalCAD – FeatureEvaluators.selftest.ts   (Phase 1 step 2 validation)
//
// Runs every service-wrapped evaluator against the real kernel and checks it
// produces valid geometry (known volumes for solids, face counts for shells).
// Self-registers window.evaluatorSelfTest(); also runnable headlessly via the
// node + dist/node.js recipe.
// ============================================================

import { EVALUATORS, ResolvedInput, evaluateDatum } from './FeatureEvaluators';
import { OccSketchService } from './OccSketchService';

interface Row { op: string; pass: boolean; detail: string }

// A full workplane (origin + frame) — sketches need uAxis/vAxis for fromLocal2D.
const WP = (origin: number[], normal: number[] = [0, 0, 1], u: number[] = [1, 0, 0], v: number[] = [0, 1, 0]) =>
  ({ label: 'P', origin, normal, uAxis: u, vAxis: v });

// ─── geometry probes ──────────────────────────────────────────────────────────
function volume(oc: any, shape: any): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
  const v = props.Mass(); props.delete(); return v;
}
function faceCount(oc: any, shape: any): number {
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0; while (exp.More()) { n++; exp.Next(); } exp.delete(); return n;
}
const approx = (a: number, b: number, tol = 0.05) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < tol;

// ─── profile/spine builders (planar circle wire, straight line wire) ──────────
function circleWire(oc: any, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, r: number): any {
  const loc = new oc.gp_Pnt_3(cx, cy, cz), dir = new oc.gp_Dir_4(nx, ny, nz), ax = new oc.gp_Ax2_3(loc, dir);
  const circ = new oc.gp_Circ_2(ax, r);
  const me = new oc.BRepBuilderAPI_MakeEdge_8(circ); const edge = me.Edge();
  const mw = new oc.BRepBuilderAPI_MakeWire_2(edge); const wire = mw.Wire();
  me.delete(); mw.delete(); circ.delete(); ax.delete(); dir.delete(); loc.delete();
  return wire;
}
function lineWire(oc: any, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): any {
  const p1 = new oc.gp_Pnt_3(x1, y1, z1), p2 = new oc.gp_Pnt_3(x2, y2, z2);
  const me = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2); const edge = me.Edge();
  const mw = new oc.BRepBuilderAPI_MakeWire_2(edge); const wire = mw.Wire();
  me.delete(); mw.delete(); p1.delete(); p2.delete();
  return wire;
}

export function runEvaluatorSelfTest(oc: any): Row[] {
  const rows: Row[] = [];
  const inp = (role: string, shape: any, meta?: Record<string, any>): ResolvedInput => ({ id: role, role, shape, meta });
  const XY = { workplane: { origin: [0, 0, 0], normal: [0, 0, 1] } };   // profile in XY → extrude +Z
  const run = (op: string, fn: () => void) => {
    try { fn(); } catch (e: any) { rows.push({ op, pass: false, detail: `threw: ${e?.message ?? e}` }); }
  };
  const ev = (op: keyof typeof EVALUATORS, inputs: ResolvedInput[], params: any) => EVALUATORS[op]!(oc, inputs, params);

  // Primitives — assert known volumes.
  run('box', () => { const v = volume(oc, ev('box', [], { w: 10, h: 10, d: 10 })); rows.push({ op: 'box', pass: approx(v, 1000), detail: `vol=${v.toFixed(0)} (~1000)` }); });
  run('cylinder', () => { const v = volume(oc, ev('cylinder', [], { r: 5, h: 10 })); rows.push({ op: 'cylinder', pass: approx(v, Math.PI * 25 * 10), detail: `vol=${v.toFixed(0)} (~785)` }); });
  run('sphere', () => { const v = volume(oc, ev('sphere', [], { r: 5 })); rows.push({ op: 'sphere', pass: approx(v, (4 / 3) * Math.PI * 125), detail: `vol=${v.toFixed(0)} (~524)` }); });
  run('torus', () => { const v = volume(oc, ev('torus', [], { R: 15, r: 3 })); rows.push({ op: 'torus', pass: approx(v, 2 * Math.PI * Math.PI * 15 * 9, 0.08), detail: `vol=${v.toFixed(0)} (~2664)` }); });
  run('cone', () => { const v = volume(oc, ev('cone', [], { r1: 8, r2: 0, h: 10 })); rows.push({ op: 'cone', pass: approx(v, (1 / 3) * Math.PI * 64 * 10), detail: `vol=${v.toFixed(0)} (~670)` }); });

  // Revolve — a circle (XY plane, centre x=15) about Y → torus R15/r3.
  run('revolve', () => {
    const prof = circleWire(oc, 15, 0, 0, 0, 0, 1, 3);
    const v = volume(oc, ev('revolve', [inp('profile', prof)], { axis: 1, angle: 360 }));
    rows.push({ op: 'revolve', pass: approx(v, 2 * Math.PI * Math.PI * 15 * 9, 0.08), detail: `vol=${v.toFixed(0)} (~2664 torus)` });
  });

  // Loft — two circles at z0/z20 → solid, positive volume.
  run('loft', () => {
    const w1 = circleWire(oc, 0, 0, 0, 0, 0, 1, 5), w2 = circleWire(oc, 0, 0, 20, 0, 0, 1, 3);
    const v = volume(oc, ev('loft', [inp('profile', w1), inp('profile', w2)], { solid: 1, ruled: 0 }));
    rows.push({ op: 'loft', pass: v > 100, detail: `vol=${v.toFixed(0)} (>0)` });
  });

  // Sweep — circle profile along a straight spine → shell with faces.
  run('sweep', () => {
    const prof = circleWire(oc, 0, 0, 0, 0, 0, 1, 3), spine = lineWire(oc, 0, 0, 0, 0, 0, 20);
    const nf = faceCount(oc, ev('sweep', [inp('profile', prof), inp('profile', spine)], { spineIndex: 1 }));
    rows.push({ op: 'sweep', pass: nf >= 1, detail: `faces=${nf} (≥1)` });
  });

  // Boolean — box(10) CUT box(5) at the corner → volume drops by ~125.
  run('boolean', () => {
    const base = ev('box', [], { w: 10, h: 10, d: 10 });
    const tool = ev('box', [], { w: 5, h: 5, d: 5 });
    const res  = ev('boolean', [inp('base', base), inp('tool', tool)], { boolOp: 'CUT' });
    const v = volume(oc, res);
    rows.push({ op: 'boolean CUT', pass: approx(v, 875, 0.02), detail: `vol=${v.toFixed(0)} (~875 = 1000−125)` });
  });

  // Fillet / chamfer — box(10), round/bevel one edge → face count grows past 6.
  run('fillet', () => {
    const nf = faceCount(oc, ev('fillet', [inp('base', ev('box', [], { w: 10, h: 10, d: 10 }))], { edgeIndices: [0], blendValue: 1 }));
    rows.push({ op: 'fillet', pass: nf > 6, detail: `faces=${nf} (>6)` });
  });
  run('chamfer', () => {
    const nf = faceCount(oc, ev('chamfer', [inp('base', ev('box', [], { w: 10, h: 10, d: 10 }))], { edgeIndices: [0], blendValue: 1 }));
    rows.push({ op: 'chamfer', pass: nf > 6, detail: `faces=${nf} (>6)` });
  });

  // ── Extrude (the many-knob op) — profile workplane via meta ──────────────────
  const disk = (cx: number, cy: number, r: number) => inp('profile', circleWire(oc, cx, cy, 0, 0, 0, 1, r), XY);

  // blind: circle r5 × h10 along +Z → cylinder ~785.
  run('extrude blind', () => {
    const v = volume(oc, ev('extrude', [disk(0, 0, 5)], { h: 10, endMode: 0 }));
    rows.push({ op: 'extrude blind', pass: approx(v, Math.PI * 25 * 10), detail: `vol=${v.toFixed(0)} (~785)` });
  });
  // twoSided: h10 + h2=5 → taller than blind.
  run('extrude twoSided', () => {
    const v = volume(oc, ev('extrude', [disk(0, 0, 5)], { h: 10, h2: 5, endMode: 2 }));
    rows.push({ op: 'extrude twoSided', pass: v > Math.PI * 25 * 10 * 1.2, detail: `vol=${v.toFixed(0)} (>785)` });
  });
  // up-to-plane: extrude to a datum plane at z=15 → cylinder ~1178.
  run('extrude up-to-plane', () => {
    const plane = inp('plane', null, { workplane: { origin: [0, 0, 15], normal: [0, 0, 1] } });
    const v = volume(oc, ev('extrude', [disk(0, 0, 5), plane], { endMode: 6 }));
    rows.push({ op: 'extrude up-to-plane', pass: approx(v, Math.PI * 25 * 15, 0.08), detail: `vol=${v.toFixed(0)} (~1178 to z=15)` });
  });
  // pad (op 1): box(10) ⊕ a corner prism → volume grows past the box.
  run('extrude pad', () => {
    const base = ev('box', [], { w: 10, h: 10, d: 10 });
    const v = volume(oc, ev('extrude', [disk(0, 0, 5), inp('base', base)], { h: 10, endMode: 0, op: 1 }));
    rows.push({ op: 'extrude pad', pass: v > 1000, detail: `vol=${v.toFixed(0)} (>1000 box)` });
  });
  // pocket (op 2): box(10) ⊖ an interior prism → volume drops below the box.
  run('extrude pocket', () => {
    const base = ev('box', [], { w: 10, h: 10, d: 10 });
    const v = volume(oc, ev('extrude', [disk(5, 5, 3), inp('base', base)], { h: 20, endMode: 0, op: 2 }));
    rows.push({ op: 'extrude pocket', pass: v > 0 && v < 1000, detail: `vol=${v.toFixed(0)} (<1000 box)` });
  });

  // ── Sketch wire (the leaf) ───────────────────────────────────────────────────
  // entity: a circle sketchGeom → a closed wire that makes a face.
  run('sketchWire circle', () => {
    const wire = ev('sketchWire', [], { workplane: WP([0, 0, 0]), sketchGeom: { kind: 'circle', c: [0, 0], r: 5 } });
    rows.push({ op: 'sketchWire circle', pass: OccSketchService.wireMakesFace(oc, wire), detail: `closed=${OccSketchService.wireMakesFace(oc, wire)}` });
  });
  // region: 4 line entities → a 10×10 square profile traced from siblings.
  run('sketchWire region', () => {
    const line = (a: number[], b: number[]) => ({ kind: 'line', a, b });
    const ents: ResolvedInput[] = [
      inp('entity', null, { sketchGeom: line([0, 0], [10, 0]) }),
      inp('entity', null, { sketchGeom: line([10, 0], [10, 10]) }),
      inp('entity', null, { sketchGeom: line([10, 10], [0, 10]) }),
      inp('entity', null, { sketchGeom: line([0, 10], [0, 0]) }),
    ].map((e, i) => ({ ...e, id: `e${i}` }));
    const wire = ev('sketchWire', ents, { workplane: WP([0, 0, 0]), region: true });
    const ok = OccSketchService.wireMakesFace(oc, wire);
    rows.push({ op: 'sketchWire region', pass: ok, detail: `square profile closed=${ok}` });
  });

  // ── Datum frame evaluators (produce frames, not shapes) ──────────────────────
  // offset: XY plane shifted +10 along Z → origin z=10.
  run('datum offset', () => {
    const f = evaluateDatum(oc, 'datum_plane', [inp('plane', null, { workplane: WP([0, 0, 0]) })], { method: 'offset', refs: [{ distance: 10 }] });
    const o = f && f.kind === 'plane' ? f.workplane.origin : [NaN, NaN, NaN];
    rows.push({ op: 'datum offset', pass: Math.abs((o[2] as number) - 10) < 1e-6, detail: `origin=[${o.map((n: any) => (+n).toFixed(0)).join(',')}]` });
  });
  // midplane: between z=0 and z=20 planes → origin z=10.
  run('datum midplane', () => {
    const f = evaluateDatum(oc, 'datum_plane', [inp('plane', null, { workplane: WP([0, 0, 0]) }), inp('plane', null, { workplane: WP([0, 0, 20]) })], { method: 'midplane' });
    const z = f && f.kind === 'plane' ? f.workplane.origin[2] : NaN;
    rows.push({ op: 'datum midplane', pass: Math.abs((z as number) - 10) < 1e-6, detail: `origin.z=${(+z).toFixed(1)} (~10)` });
  });
  // 3-point: (0,0,0),(10,0,0),(0,10,0) → plane normal ∥ Z.
  run('datum 3point', () => {
    const f = evaluateDatum(oc, 'datum_plane', [inp('p', null, { point: [0, 0, 0] }), inp('p', null, { point: [10, 0, 0] }), inp('p', null, { point: [0, 10, 0] })], { method: '3point' });
    const n = f && f.kind === 'plane' ? f.workplane.normal : [0, 0, 0];
    const dotZ = Math.abs(n[2]);
    rows.push({ op: 'datum 3point', pass: dotZ > 0.999, detail: `|normal·Z|=${dotZ.toFixed(3)}` });
  });

  return rows;
}

// ─── console entry point ──────────────────────────────────────────────────────
(globalThis as any).evaluatorSelfTest = function evaluatorSelfTest() {
  const oc = (globalThis as any).oc;
  if (!oc) { console.warn('[Evaluators] kernel not ready (window.oc missing)'); return []; }
  const rows = runEvaluatorSelfTest(oc);
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.log(`[Evaluators] ${rows.filter((r) => r.pass).length}/${rows.length} evaluators produced valid geometry`);
  return rows;
};
