// ============================================================
// ToubkalCAD – StableRef.selftest.ts   (Phase 1 §6 de-risk harness)
//
// Builds known solids, applies edits that SHIFT face/edge indices (the failure
// mode positional refs suffer), and checks whether a geometric-signature
// StableRef still resolves to the same entity. There is no test runner in this
// project, so this self-registers on `window` — run it from the browser console
// once the kernel is up:
//
//     await stableRefSelfTest()        // or: stableRefSelfTest()
//
// It returns a report array and console.tables it. Each row shows pass/fail plus
// the match score and the runner-up margin, so we can SEE how much headroom each
// case has (the point of a de-risk: measure, don't just assert).
// ============================================================

import {
  captureFace, captureEdge, resolveFace, resolveEdge,
  FaceSig, EdgeSig, StableRef,
} from './StableRef';

interface Row { scenario: string; pass: boolean; score: number; runnerUp: number; detail: string; }

// ─── OCC builders ─────────────────────────────────────────────────────────────
function box(oc: any, x: number, y: number, z: number, dx: number, dy: number, dz: number): any {
  const p = new oc.gp_Pnt_3(x, y, z);
  const mk = new oc.BRepPrimAPI_MakeBox_3(p, dx, dy, dz);
  const sh = mk.Shape();
  mk.delete(); p.delete();
  return sh;
}
function cylinder(oc: any, ox: number, oy: number, oz: number, dirZ: number, r: number, h: number): any {
  const loc = new oc.gp_Pnt_3(ox, oy, oz);
  const dir = new oc.gp_Dir_4(0, 0, dirZ);
  const ax  = new oc.gp_Ax2_3(loc, dir);
  const mk  = new oc.BRepPrimAPI_MakeCylinder_3(ax, r, h);
  const sh  = mk.Shape();
  mk.delete(); ax.delete(); dir.delete(); loc.delete();
  return sh;
}
function cut(oc: any, a: any, b: any): any {
  const algo = new oc.BRepAlgoAPI_Cut_3(a, b, new oc.Message_ProgressRange_1());
  const sh = algo.Shape();
  algo.delete();
  return sh;
}
function sphere(oc: any, r: number): any {
  const mk = new oc.BRepPrimAPI_MakeSphere_1(r);
  const sh = mk.Shape();
  mk.delete();
  return sh;
}
function circleWire(oc: any, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, r: number): any {
  const loc = new oc.gp_Pnt_3(cx, cy, cz);
  const dir = new oc.gp_Dir_4(nx, ny, nz);
  const ax  = new oc.gp_Ax2_3(loc, dir);
  const circ = new oc.gp_Circ_2(ax, r);
  const me = new oc.BRepBuilderAPI_MakeEdge_8(circ);
  const edge = me.Edge();
  const mw = new oc.BRepBuilderAPI_MakeWire_2(edge);
  const wire = mw.Wire();
  me.delete(); mw.delete(); circ.delete(); ax.delete(); dir.delete(); loc.delete();
  return wire;
}
function lineWire(oc: any, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): any {
  const p1 = new oc.gp_Pnt_3(x1, y1, z1);
  const p2 = new oc.gp_Pnt_3(x2, y2, z2);
  const me = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2);
  const edge = me.Edge();
  const mw = new oc.BRepBuilderAPI_MakeWire_2(edge);
  const wire = mw.Wire();
  me.delete(); mw.delete(); p1.delete(); p2.delete();
  return wire;
}
function fillet(oc: any, shape: any, edgeIndices: number[], r: number): any {
  const mk  = new oc.BRepFilletAPI_MakeFillet(shape, 0);
  const map = new oc.TopTools_IndexedMapOfShape_1();
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) { map.Add(exp.Current()); exp.Next(); }
  exp.delete();
  for (const idx of edgeIndices) mk.Add_2(r, oc.TopoDS.Edge_1(map.FindKey(idx + 1)));
  map.delete();
  mk.Build(new oc.Message_ProgressRange_1());
  if (!mk.IsDone()) { mk.delete(); throw new Error('fillet not done'); }
  const sh = mk.Shape(); mk.delete(); return sh;
}
function loft(oc: any, wires: any[], isSolid: boolean): any {
  const lo = new oc.BRepOffsetAPI_ThruSections(isSolid, false, 1e-6);
  for (const w of wires) lo.AddWire(w);
  lo.Build(new oc.Message_ProgressRange_1());
  const sh = lo.Shape(); lo.delete(); return sh;
}
function pipe(oc: any, spine: any, profile: any): any {
  const p = new oc.BRepOffsetAPI_MakePipe_1(spine, profile);
  p.Build(new oc.Message_ProgressRange_1());
  const sh = p.Shape(); p.delete(); return sh;
}

// ─── find a face/edge ordinal matching a predicate ────────────────────────────
function countSub(oc: any, shape: any, enumType: any): number {
  const exp = new oc.TopExp_Explorer_2(shape, enumType, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0; while (exp.More()) { n++; exp.Next(); } exp.delete();
  return n;
}
function findFace(oc: any, shape: any, pred: (s: FaceSig) => boolean): { index: number; sig: FaceSig } | null {
  const n = countSub(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
  for (let i = 0; i < n; i++) { const s = captureFace(oc, shape, i); if (s && pred(s)) return { index: i, sig: s }; }
  return null;
}
function findEdge(oc: any, shape: any, pred: (s: EdgeSig) => boolean): { index: number; sig: EdgeSig } | null {
  const n = countSub(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
  for (let i = 0; i < n; i++) { const s = captureEdge(oc, shape, i); if (s && pred(s)) return { index: i, sig: s }; }
  return null;
}

const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

// ─── The suite ────────────────────────────────────────────────────────────────
export function runStableRefSelfTest(oc: any): Row[] {
  const rows: Row[] = [];
  const tmp: any[] = [];
  const keep = (s: any) => { tmp.push(s); return s; };
  const row = (scenario: string, pass: boolean, r: { score: number; runnerUp: number }, detail: string) =>
    rows.push({ scenario, pass, score: +r.score.toFixed(3), runnerUp: +r.runnerUp.toFixed(3), detail });

  try {
    // Reference solid: 40 × 30 × 20 box at origin.
    const B  = keep(box(oc, 0, 0, 0, 40, 30, 20));
    // Edit 1 — blind hole from the bottom (z 0→9): top face untouched, indices shift.
    const B2 = keep(cut(oc, B, keep(cylinder(oc, 20, 15, -1, 1, 5, 10))));
    // Edit 2 — clip the top-face's far corner (removes x35..40,y25..30,z15..20):
    //          the referenced top face itself changes (area & centroid drift).
    const B3 = keep(cut(oc, B, keep(box(oc, 35, 25, 15, 10, 10, 10))));

    const topPred  = (s: FaceSig) => s.surf === 'plane' && !!s.axis && s.axis[2] > 0.9;
    const plusXPred = (s: FaceSig) => s.surf === 'plane' && !!s.axis && s.axis[0] > 0.9;
    const minusXPred = (s: FaceSig) => s.surf === 'plane' && !!s.axis && s.axis[0] < -0.9;

    // S1 — face survives an UNRELATED edit (the core win).
    {
      const ref = findFace(oc, B, topPred);
      const res = ref ? resolveFace(oc, B2, ref.sig) : null;
      const got = res && !res.rejected ? captureFace(oc, B2, res.index) : null;
      const ok = !!got && near(got.centroid[2], 20) && got.axis![2] > 0.9 && !res!.rejected;
      row('S1 face survives unrelated blind-hole cut', ok, res ?? { score: NaN, runnerUp: NaN },
        ok ? `resolved to +Z face @ z=${got!.centroid[2].toFixed(1)}` : `ref=${!!ref} rejected=${res?.rejected} reason=${res?.reason ?? '-'}`);
    }

    // S2 — edge survives an unrelated edit.
    {
      const ref = findEdge(oc, B, (s) => s.curve === 'line' && near(s.mid[0], 40, 0.5) && near(s.mid[2], 20, 0.5) && s.length > 25);
      const res = ref ? resolveEdge(oc, B2, ref.sig) : null;
      const got = res && !res.rejected ? captureEdge(oc, B2, res.index) : null;
      const ok = !!got && near(got.mid[0], 40, 0.5) && near(got.mid[2], 20, 0.5) && !res!.rejected;
      row('S2 edge survives unrelated blind-hole cut', ok, res ?? { score: NaN, runnerUp: NaN },
        ok ? `resolved to top +X edge @ (${got!.mid.map((n) => n.toFixed(0)).join(',')})` : `ref=${!!ref} rejected=${res?.rejected} reason=${res?.reason ?? '-'}`);
    }

    // S3 — FAIL-SAFE: resolving against an unrelated shape must REJECT, not mis-bind.
    {
      const ref = findFace(oc, B, topPred);
      const S   = keep(sphere(oc, 10));
      const res = ref ? resolveFace(oc, S, ref.sig) : null;
      const ok  = !!res && res.rejected;
      row('S3 fail-safe reject on a foreign shape (sphere)', ok, res ?? { score: NaN, runnerUp: NaN },
        ok ? `correctly rejected (reason: ${res!.reason})` : `WRONGLY ACCEPTED idx=${res?.index}`);
    }

    // S4 — symmetric disambiguation: +X must not resolve to the identical-area −X face.
    {
      const refP = findFace(oc, B, plusXPred);
      const refM = findFace(oc, B, minusXPred);
      const rP = refP ? resolveFace(oc, B2, refP.sig) : null;
      const rM = refM ? resolveFace(oc, B2, refM.sig) : null;
      const gP = rP && !rP.rejected ? captureFace(oc, B2, rP.index) : null;
      const gM = rM && !rM.rejected ? captureFace(oc, B2, rM.index) : null;
      const ok = !!gP && !!gM && near(gP.centroid[0], 40) && near(gM.centroid[0], 0);
      row('S4 symmetric +X/−X faces stay distinct', ok, rP ?? { score: NaN, runnerUp: NaN },
        ok ? `+X→x=${gP!.centroid[0].toFixed(0)}, −X→x=${gM!.centroid[0].toFixed(0)}` : `+X idx=${rP?.index} −X idx=${rM?.index}`);
    }

    // S5 — HARD CASE (measurement): the referenced face itself is modified.
    {
      const ref = findFace(oc, B, topPred);          // area 1200, centroid (20,15,20)
      const res = ref ? resolveFace(oc, B3, ref.sig) : null;
      const got = res && !res.rejected ? captureFace(oc, B3, res.index) : null;
      const ok = !!got && got.axis![2] > 0.9 && near(got.centroid[2], 20);   // still the top face
      row('S5 referenced face modified (corner clipped)', ok, res ?? { score: NaN, runnerUp: NaN },
        got ? `resolved top face now area=${got.area.toFixed(0)} (was 1200); rejected=${res!.rejected}` : `rejected=${res?.rejected} reason=${res?.reason ?? '-'}`);
    }

    // ── Curved / generated-face cases (fillet / loft / sweep) ────────────────
    // Each is isolated so one failed OCC op doesn't abort the rest.
    const scn = (name: string, fn: () => void) => {
      try { fn(); } catch (e: any) { rows.push({ scenario: name, pass: false, score: NaN, runnerUp: NaN, detail: `threw: ${e?.message ?? e}` }); }
    };
    const vertEdge  = (s: EdgeSig) => s.curve === 'line' && !!s.axis && Math.abs(s.axis[2]) > 0.9 && s.mid[0] < 0.5 && s.mid[1] < 0.5;
    const topXEdge  = (s: EdgeSig) => s.curve === 'line' && near(s.mid[0], 40, 0.5) && near(s.mid[2], 20, 0.5) && s.length > 25;

    // S6 — an edge far from a fillet survives that fillet (the real "edit upstream" case).
    scn('S6 edge survives an unrelated fillet', () => {
      const refE = findEdge(oc, B, topXEdge);
      const vert = findEdge(oc, B, vertEdge);
      if (!refE || !vert) throw new Error('edge predicate failed');
      const Bf  = keep(fillet(oc, B, [vert.index], 4));      // round a far vertical corner
      const res = resolveEdge(oc, Bf, refE.sig);
      const got = !res.rejected ? captureEdge(oc, Bf, res.index) : null;
      const ok  = !!got && near(got.mid[0], 40, 0.5) && near(got.mid[2], 20, 0.5);
      row('S6 edge survives an unrelated fillet', ok, res, ok ? `+X top edge held @ (${got!.mid.map((n) => n.toFixed(0)).join(',')})` : `rejected=${res.rejected} ${res.reason ?? ''}`);
    });

    // S7 — reference the fillet's GENERATED cylinder face; it must survive an
    //      unrelated cut AND not be confused with the hole's cylinder (diff radius).
    scn('S7 fillet-generated cylinder survives a cut (radius-discriminated)', () => {
      const vert = findEdge(oc, B, vertEdge);
      if (!vert) throw new Error('no vertical edge');
      const Bf = keep(fillet(oc, B, [vert.index], 4));
      const refF = findFace(oc, Bf, (s) => s.surf === 'cylinder' && s.radius != null && Math.abs(s.radius - 4) < 0.5);
      if (!refF) throw new Error('no R4 fillet cylinder');
      const Bf2 = keep(cut(oc, Bf, keep(cylinder(oc, 30, 20, -1, 1, 5, 10))));   // R5 hole, far away
      const res = resolveFace(oc, Bf2, refF.sig);
      const got = !res.rejected ? captureFace(oc, Bf2, res.index) : null;
      const ok  = !!got && got.surf === 'cylinder' && got.radius != null && Math.abs(got.radius - 4) < 0.5;
      row('S7 fillet-generated cylinder survives a cut (radius-discriminated)', ok, res, ok ? `held R4 fillet cyl (not the R5 hole)` : `rejected=${res.rejected} ${res.reason ?? ''}`);
    });

    // S8 — face ADJACENT to a filleted edge (its area shrinks): drift measurement.
    scn('S8 face adjacent to a fillet (drift)', () => {
      const refF = findFace(oc, B, (s) => s.surf === 'plane' && !!s.axis && s.axis[2] > 0.9);   // top face, 1200
      const topE = findEdge(oc, B, topXEdge);
      if (!refF || !topE) throw new Error('predicate failed');
      const Bf  = keep(fillet(oc, B, [topE.index], 3));     // rounds the top edge → eats the top face
      const res = resolveFace(oc, Bf, refF.sig);
      const got = !res.rejected ? captureFace(oc, Bf, res.index) : null;
      const ok  = !!got && got.axis![2] > 0.9 && near(got.centroid[2], 20);
      row('S8 face adjacent to a fillet (drift)', ok, res, got ? `top face area ${got.area.toFixed(0)} (was 1200); rejected=${res.rejected}` : `rejected=${res.rejected} ${res.reason ?? ''}`);
    });

    // S9 — LOFT top cap survives an upstream profile edit (change the bottom circle).
    scn('S9 loft top cap survives upstream profile edit', () => {
      const botC = keep(circleWire(oc, 0, 0, 0,  0, 0, 1, 10));
      const topC = keep(circleWire(oc, 0, 0, 40, 0, 0, 1, 6));
      const L1   = keep(loft(oc, [botC, topC], true));
      const refF = findFace(oc, L1, (s) => s.surf === 'plane' && !!s.axis && s.axis[2] > 0.9 && near(s.centroid[2], 40, 1));
      if (!refF) throw new Error('no top cap');
      const botC2 = keep(circleWire(oc, 0, 0, 0, 0, 0, 1, 8));    // bottom R10 → R8
      const L2    = keep(loft(oc, [botC2, topC], true));
      const res = resolveFace(oc, L2, refF.sig);
      const got = !res.rejected ? captureFace(oc, L2, res.index) : null;
      const ok  = !!got && got.surf === 'plane' && got.axis![2] > 0.9 && near(got.centroid[2], 40, 1);
      row('S9 loft top cap survives upstream profile edit', ok, res, ok ? `top cap held @ z=${got!.centroid[2].toFixed(0)} area=${got!.area.toFixed(0)}` : `rejected=${res.rejected} ${res.reason ?? ''}`);
    });

    // S10a — SWEEP: a curved generated face has a well-defined, repeatable signature.
    scn('S10a sweep side-cylinder signature round-trips', () => {
      const prof = keep(circleWire(oc, 0, 0, 0, 0, 0, 1, 5));
      const sp1  = keep(lineWire(oc, 0, 0, 0, 0, 0, 30));
      const P1   = keep(pipe(oc, sp1, prof));
      const refF = findFace(oc, P1, (s) => s.surf === 'cylinder' && s.radius != null && Math.abs(s.radius - 5) < 0.5);
      if (!refF) throw new Error('no side cylinder');
      const res = resolveFace(oc, P1, refF.sig);              // resolve against the SAME shape
      const ok  = !res.rejected && res.score < 1e-6;
      row('S10a sweep side-cylinder signature round-trips', ok, res, ok ? `side cyl R5 resolves on self (score 0)` : `rejected=${res.rejected} score=${res.score}`);
    });

    // S10b — SWEEP under a big modification of the referenced face itself (longer
    //        spine): expected to REJECT, documenting where §6 Phase-1b (OCC
    //        Generated()/Modified() history) becomes necessary. "Pass" = never mis-binds.
    scn('S10b sweep side-cylinder under spine growth (known limit)', () => {
      const prof = keep(circleWire(oc, 0, 0, 0, 0, 0, 1, 5));
      const P1 = keep(pipe(oc, keep(lineWire(oc, 0, 0, 0, 0, 0, 30)), prof));
      const P2 = keep(pipe(oc, keep(lineWire(oc, 0, 0, 0, 0, 0, 50)), prof));
      const refF = findFace(oc, P1, (s) => s.surf === 'cylinder' && s.radius != null && Math.abs(s.radius - 5) < 0.5);
      if (!refF) throw new Error('no side cylinder');
      const res = resolveFace(oc, P2, refF.sig);
      const got = !res.rejected ? captureFace(oc, P2, res.index) : null;
      const ok  = res.rejected || (got != null && got.surf === 'cylinder');   // never bind to a wrong-kind face
      row('S10b sweep side-cylinder under spine growth (known limit)', ok, res,
        res.rejected ? `rejected — needs §6 Phase-1b history (score=${res.score.toFixed(2)})` : `resolved side cyl @ z=${got!.centroid[2].toFixed(0)}`);
    });
  } catch (e: any) {
    rows.push({ scenario: 'HARNESS ERROR', pass: false, score: NaN, runnerUp: NaN, detail: e?.message ?? String(e) });
  } finally {
    for (const s of tmp) { try { s.delete(); } catch {} }
  }

  return rows;
}

// ─── console entry point ──────────────────────────────────────────────────────
(globalThis as any).stableRefSelfTest = function stableRefSelfTest() {
  const oc = (globalThis as any).oc;
  if (!oc) { console.warn('[StableRef] kernel not ready (window.oc missing)'); return []; }
  const rows = runStableRefSelfTest(oc);
  const passed = rows.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.log(`[StableRef] ${passed}/${rows.length} scenarios passed`);
  return rows;
};
