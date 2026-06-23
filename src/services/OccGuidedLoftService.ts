// ============================================================
// ToubkalCAD – OccGuidedLoftService.ts
//
// Guided loft between TWO profile wires constrained by 1–2 guide curves.
//
// IMPORTANT — OCCT reality check:
//   BRepOffsetAPI_ThruSections (our plain Loft) has NO guide-curve input. The
//   guide-capable algorithm is BRepOffsetAPI_MakePipeShell, which sweeps one or
//   more profiles along a SPINE (the trajectory) with an optional AUXILIARY
//   spine (a second rail). So a 2-profile guided loft can be constrained by at
//   most 2 rails: spine + auxiliary. 3+ guides would require building a GeomFill
//   B-spline skin surface by hand — out of scope here; see the note at the end.
//
//   Add(profile, WithContact=true, WithCorrection=true) is OCCT's own mechanism
//   for forcing each profile to TOUCH the spine exactly and re-orient onto it —
//   this is what prevents the "profile off the path ⇒ inverted/!IsDone" failure,
//   complementing the endpoint projection in OccGuideCurveService.
//
// Verified OCCT 7.8 API (opencascade.full.d.ts):
//   new BRepOffsetAPI_MakePipeShell(Spine: TopoDS_Wire)
//   .SetMode_5(AuxiliarySpine, CurvilinearEquivalence, KeepContact)
//   .Add_1(Profile, WithContact, WithCorrection)
//   .SetTransitionMode(BRepBuilderAPI_TransitionMode)
//   .Build(Message_ProgressRange) / .IsDone() / .MakeSolid() / .Shape()
// ============================================================

import { WasmScope } from '../utils/WasmScope';
import { OccLoftService } from './OccLoftService';
import { OccGuideCurveService, Vec3 } from './OccGuideCurveService';

export class OccGuidedLoftService {

  /**
   * Guided loft from `profileA` to `profileB` following guide curve(s), given as
   * their Bezier control POLES (not wires — we need the poles to re-centre them).
   *
   * @param guidePolesArr  1 or 2 guides, each an array of ≥2 world-space poles.
   * @param makeSolid      true → capped solid, false → open shell.
   *
   * The trick that makes the loft actually FOLLOW the guide: the user draws each
   * guide rim→rim (its endpoints snap to points ON the profiles), but a sweep
   * trajectory must be CENTRED or the loft tips over / ignores the guide. So we
   * re-centre each guide — shift its deviation-from-its-own-chord onto the line
   * between the two profile centroids — and sweep the sections along that bowed,
   * centred spine. The loft then bends/bulges toward the guide. A second guide
   * becomes a NoContact auxiliary rail. Verified in scripts/test-guided-loft.mjs:
   * a strongly bowed guide pulls the loft centroid markedly toward the bow.
   *
   * Throws a readable message if no plan builds; the caller may fall back to a
   * plain (unguided) loft.
   */
  static guidedLoft(
    oc: any, profileA: any, profileB: any, guidePolesArr: Vec3[][], makeSolid = true,
  ): any {
    const guides = (guidePolesArr ?? []).filter((p) => Array.isArray(p) && p.length >= 2);
    if (!guides.length) throw new Error('Guided loft needs a guide curve with ≥2 points.');

    const c1 = OccGuidedLoftService.centroid(oc, profileA);
    const c2 = OccGuidedLoftService.centroid(oc, profileB);

    // [WithContact, WithCorrection] plans. Profiles are real sketches already
    // positioned in 3D, so prefer contact=false. CORRECTION=FALSE is primary: the
    // section's CENTRE still tracks the bowed spine (so the loft follows the
    // guide), but the section is NOT rotated to the spine frame — rotation twists
    // the circle's seam between the two profiles and creates the crease/fold the
    // user saw. correction=false still follows strongly (verified: centroid pulled
    // 11.7 vs straight 4.0 in test-guided-loft.mjs) with a cleaner, untwisted
    // surface. Each plan is isolated so a kernel exception drops to the next.
    const plans: [boolean, boolean][] = [[false, false], [false, true], [true, false], [true, true]];
    let lastErr = '';

    const scope = new WasmScope();
    try {
      // Seam-align: if both profiles are plain circles, rebuild them with a COMMON
      // reference X so their seam (0°) vertices point the same way in 3D. Each
      // circle is otherwise built at its own workplane's U-axis, so on different
      // planes the seams diverge and MakePipeShell twists the skin to connect
      // them (the crease/fold). Aligning the seams removes that rotation. Non-
      // circular profiles are left untouched (fall through to the raw wires).
      const cpA = OccGuidedLoftService.circleParams(oc, profileA);
      const cpB = OccGuidedLoftService.circleParams(oc, profileB);
      let pA = profileA, pB = profileB;
      if (cpA && cpB) {
        const ref = OccGuidedLoftService.commonSeamRef(cpA.normal, cpB.normal);
        pA = scope.keep(OccGuidedLoftService.circleWithSeam(oc, cpA, ref));
        pB = scope.keep(OccGuidedLoftService.circleWithSeam(oc, cpB, ref));
      }

      const spine = scope.keep(OccGuidedLoftService.recenteredSpine(oc, guides[0], c1, c2));
      const aux   = guides[1] ? scope.keep(OccGuidedLoftService.recenteredSpine(oc, guides[1], c1, c2)) : null;

      for (const [withContact, withCorrection] of plans) {
        try {
          const shape = OccGuidedLoftService.tryPipe(
            oc, spine, aux, pA, pB, withContact, withCorrection, makeSolid);
          if (shape) return shape;
          lastErr = 'IsDone=false';
        } catch (e: any) {
          lastErr = e?.message ?? String(e);   // kernel throw → next plan
        }
      }
    } finally {
      scope.free();
    }

    throw new Error(`MakePipeShell could not build the guided shell in any mode (${lastErr}).`);
  }

  /**
   * Re-centre a guide's bow onto the centroid path, returning a Bezier spine wire.
   * recentred(t) = guide(t) − chord(t) + centroidLine(t), so the guide's deviation
   * from its own rim→rim chord is preserved but applied to the centre line.
   */
  private static recenteredSpine(oc: any, poles: Vec3[], c1: Vec3, c2: Vec3): any {
    const g0 = poles[0], gN = poles[poles.length - 1];
    const n = poles.length - 1;
    const rp: Vec3[] = poles.map((g, i) => {
      const t = n > 0 ? i / n : 0;
      return {
        x: g.x - (g0.x + (gN.x - g0.x) * t) + (c1.x + (c2.x - c1.x) * t),
        y: g.y - (g0.y + (gN.y - g0.y) * t) + (c1.y + (c2.y - c1.y) * t),
        z: g.z - (g0.z + (gN.z - g0.z) * t) + (c1.z + (c2.z - c1.z) * t),
      };
    });
    // Bezier wire through the re-centred poles (no endpoint projection here — the
    // spine is internal). buildGuideWire keeps the curve alive (see its note).
    return OccGuideCurveService.buildGuideWire(oc, rp);
  }

  // ── Seam alignment for circular profiles ─────────────────────────────────────

  /** Circle params if `wire` is a single full-circle edge, else null. */
  private static circleParams(
    oc: any, wire: any,
  ): { center: Vec3; normal: Vec3; radius: number } | null {
    let edge: any = null, count = 0;
    const exp = new oc.TopExp_Explorer_2(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (exp.More()) { if (count === 0) edge = oc.TopoDS.Edge_1(exp.Current()); count++; exp.Next(); }
    try { exp.delete(); } catch { /* noop */ }
    if (count !== 1 || !edge) return null;          // only a lone circular edge
    try {
      const ad = new oc.BRepAdaptor_Curve_2(edge);
      const isCircle = ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle;
      if (!isCircle) { try { ad.delete(); } catch { /* noop */ } return null; }
      const c = ad.Circle();
      const loc = c.Location(), ax = c.Axis().Direction(), r = c.Radius();
      const out = {
        center: { x: loc.X(), y: loc.Y(), z: loc.Z() },
        normal: { x: ax.X(),  y: ax.Y(),  z: ax.Z() },
        radius: r,
      };
      try { ad.delete(); } catch { /* noop */ }
      return out;
    } catch { return null; }
  }

  /** Rebuild a circle with its seam X-axis = `ref` projected onto the circle plane. */
  private static circleWithSeam(
    oc: any, p: { center: Vec3; normal: Vec3; radius: number }, ref: Vec3,
  ): any {
    const n = OccGuidedLoftService.normalize(p.normal);
    const d = ref.x * n.x + ref.y * n.y + ref.z * n.z;
    let x = OccGuidedLoftService.normalize({ x: ref.x - n.x * d, y: ref.y - n.y * d, z: ref.z - n.z * d });
    if (!Number.isFinite(x.x)) x = { x: 1, y: 0, z: 0 };
    const o  = new oc.gp_Pnt_3(p.center.x, p.center.y, p.center.z);
    const nd = new oc.gp_Dir_4(n.x, n.y, n.z);
    const xd = new oc.gp_Dir_4(x.x, x.y, x.z);
    const ax2  = new oc.gp_Ax2_2(o, nd, xd);
    const circ = new oc.gp_Circ_2(ax2, p.radius);
    const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
    const wm   = new oc.BRepBuilderAPI_MakeWire_1(); wm.Add_1(edge);
    const wire = wm.Wire();
    try { o.delete(); nd.delete(); xd.delete(); ax2.delete(); circ.delete(); wm.delete(); } catch { /* noop */ }
    return wire;
  }

  /** A world axis least parallel to BOTH normals → a stable shared seam reference. */
  private static commonSeamRef(n1: Vec3, n2: Vec3): Vec3 {
    const axes: Vec3[] = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
    const a1 = OccGuidedLoftService.normalize(n1), a2 = OccGuidedLoftService.normalize(n2);
    let best = axes[0], bestScore = Infinity;
    for (const a of axes) {
      const score = Math.max(
        Math.abs(a.x * a1.x + a.y * a1.y + a.z * a1.z),
        Math.abs(a.x * a2.x + a.y * a2.y + a.z * a2.z),
      );
      if (score < bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  private static normalize(v: Vec3): Vec3 {
    const m = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / m, y: v.y / m, z: v.z / m };
  }

  /** Centre of mass of a wire (linear properties). */
  private static centroid(oc: any, wire: any): { x: number; y: number; z: number } {
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.LinearProperties(wire, props, false, false);
    const c = props.CentreOfMass();
    const r = { x: c.X(), y: c.Y(), z: c.Z() };
    try { props.delete(); } catch { /* noop */ }
    return r;
  }

  // ── ThruSections route (robust; for circular/elliptical profiles) ────────────

  /**
   * Guided loft by placing interpolated cross-sections ON the re-centred guide and
   * blending them with BRepOffsetAPI_ThruSections (which auto-aligns seams, so no
   * MakePipeShell twist). Returns a shape, or null if the profiles aren't both
   * plain circles (caller falls back to the sweep route).
   *
   * ThruSections in SMOOTH mode can oscillate/explode with many sections on a
   * tight bow (verified: area ballooned 1000× at N=8). So we try smooth with FEW
   * sections first — gated on a sanity check (area must stay within 5× the plain
   * loft) — then fall back to RULED mode, which is unconditionally stable (area
   * flat across N=2..12 in scripts/test-guided-loft.mjs).
   */
  static guidedLoftThruSections(
    oc: any, profileA: any, profileB: any, guidePolesArr: Vec3[][], makeSolid: boolean,
  ): any {
    const cpA = OccGuidedLoftService.circleParams(oc, profileA);
    const cpB = OccGuidedLoftService.circleParams(oc, profileB);
    if (!cpA || !cpB) return null;                       // not both circles
    const guide = (guidePolesArr ?? []).find((p) => Array.isArray(p) && p.length >= 2);
    if (!guide) return null;

    const ref = OccGuidedLoftService.commonSeamRef(cpA.normal, cpB.normal);
    const rp  = OccGuidedLoftService.recenterPoles(guide, cpA.center, cpB.center);

    // Reference area: a plain loft of the two aligned end circles.
    let refArea = 0;
    {
      const s = new WasmScope();
      try {
        const ends = [
          s.keep(OccGuidedLoftService.circleWithSeam(oc, cpA, ref)),
          s.keep(OccGuidedLoftService.circleWithSeam(oc, cpB, ref)),
        ];
        const shape = OccGuidedLoftService.thruSections(oc, ends, makeSolid, false);
        if (shape) { refArea = OccGuidedLoftService.surfaceArea(oc, shape); try { shape.delete(); } catch { /* noop */ } }
      } catch { /* refArea stays 0 → no sanity cap */ } finally { s.free(); }
    }
    const maxArea = refArea > 0 ? refArea * 5 : Infinity;

    // [ruled, sections] attempts: smooth-few (best look) → ruled (stable).
    const attempts: [boolean, number][] = [[false, 5], [false, 4], [true, 14], [true, 8]];
    for (const [ruled, n] of attempts) {
      const s = new WasmScope();
      try {
        const wires: any[] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const center = OccGuidedLoftService.bezierAt(rp, t);
          const normal = OccGuidedLoftService.normalize({
            x: cpA.normal.x + (cpB.normal.x - cpA.normal.x) * t,
            y: cpA.normal.y + (cpB.normal.y - cpA.normal.y) * t,
            z: cpA.normal.z + (cpB.normal.z - cpA.normal.z) * t,
          });
          const radius = cpA.radius + (cpB.radius - cpA.radius) * t;
          wires.push(s.keep(OccGuidedLoftService.circleWithSeam(oc, { center, normal, radius }, ref)));
        }
        const shape = OccGuidedLoftService.thruSections(oc, wires, makeSolid, ruled);
        if (shape) {
          const area = OccGuidedLoftService.surfaceArea(oc, shape);
          if (Number.isFinite(area) && area > 0 && area <= maxArea) return shape;   // sane → done
          try { shape.delete(); } catch { /* noop */ }   // blown up → next attempt
        }
      } catch { /* next attempt */ } finally { s.free(); }
    }
    return null;
  }

  /** Re-centred guide poles (same shift as recenteredSpine, returned as points). */
  private static recenterPoles(poles: Vec3[], c1: Vec3, c2: Vec3): Vec3[] {
    const g0 = poles[0], gN = poles[poles.length - 1];
    const n = poles.length - 1;
    return poles.map((g, i) => {
      const t = n > 0 ? i / n : 0;
      return {
        x: g.x - (g0.x + (gN.x - g0.x) * t) + (c1.x + (c2.x - c1.x) * t),
        y: g.y - (g0.y + (gN.y - g0.y) * t) + (c1.y + (c2.y - c1.y) * t),
        z: g.z - (g0.z + (gN.z - g0.z) * t) + (c1.z + (c2.z - c1.z) * t),
      };
    });
  }

  /** Evaluate a Bezier (de Casteljau) at t over control points `poles`. */
  private static bezierAt(poles: Vec3[], t: number): Vec3 {
    const p = poles.map((q) => ({ ...q }));
    for (let r = 1; r < poles.length; r++)
      for (let i = 0; i < poles.length - r; i++)
        p[i] = {
          x: (1 - t) * p[i].x + t * p[i + 1].x,
          y: (1 - t) * p[i].y + t * p[i + 1].y,
          z: (1 - t) * p[i].z + t * p[i + 1].z,
        };
    return p[0];
  }

  /** ThruSections through ordered closed wires. Returns shape or null. */
  private static thruSections(oc: any, wires: any[], isSolid: boolean, ruled: boolean): any {
    const scope = new WasmScope();
    try {
      const t = scope.keep(new oc.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6));
      t.CheckCompatibility(true);
      for (const w of wires) t.AddWire(w);
      t.Build(scope.keep(new oc.Message_ProgressRange_1()));
      if (!t.IsDone()) return null;
      return t.Shape();
    } finally { scope.free(); }
  }

  /** Surface area of a shape (fast sanity metric — NOT BRepCheck, which is slow). */
  private static surfaceArea(oc: any, shape: any): number {
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(shape, props, false, false);
    const a = props.Mass();
    try { props.delete(); } catch { /* noop */ }
    return a;
  }

  /** One MakePipeShell attempt with a specific contact/correction combo. */
  private static tryPipe(
    oc: any, spine: any, aux: any, profileA: any, profileB: any,
    withContact: boolean, withCorrection: boolean, makeSolid: boolean,
  ): any {
    const scope = new WasmScope();
    try {
      const mps = scope.keep(new oc.BRepOffsetAPI_MakePipeShell(spine));

      // Second guide → auxiliary spine (2nd rail). CurvilinearEquivalence=true
      // keeps the rails in arc-length sync; NoContact = it's a free 3D rail.
      if (aux) mps.SetMode_5(aux, true, oc.BRepFill_TypeOfContact.BRepFill_NoContact);

      mps.Add_1(profileA, withContact, withCorrection);
      mps.Add_1(profileB, withContact, withCorrection);

      // "Transformed" gives the cleanest blend for smooth spines. Wrapped in try
      // in case the enum member name differs across builds.
      try {
        mps.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed);
      } catch { /* keep default transition */ }

      if (!mps.IsReady()) return null;
      mps.Build(scope.keep(new oc.Message_ProgressRange_1()));
      if (!mps.IsDone()) return null;
      if (makeSolid) { try { mps.MakeSolid(); } catch { /* keep open shell */ } }
      return mps.Shape();    // ref-counted TShape survives scope.free()
    } finally {
      scope.free();
    }
  }

  /**
   * Convenience: try the guided pipe-shell first; on ANY failure fall back to a
   * plain ThruSections loft so the user still gets a shape (just unguided).
   * Returns { shape, guided } so the caller can warn when the guide was dropped.
   */
  static guidedLoftWithFallback(
    oc: any, profileA: any, profileB: any, guidePolesArr: Vec3[][], makeSolid = true,
  ): { shape: any; guided: boolean; reason?: string } {
    // 1. ThruSections route — clean (auto seam-align, no twist) for circular
    //    profiles. The preferred path; returns null if not applicable.
    try {
      const s = OccGuidedLoftService.guidedLoftThruSections(oc, profileA, profileB, guidePolesArr, makeSolid);
      if (s) return { shape: s, guided: true };
    } catch { /* fall through to the sweep route */ }

    // 2. MakePipeShell (re-centred spine, seam-aligned) — general fallback.
    let reason = '';
    try {
      return { shape: OccGuidedLoftService.guidedLoft(oc, profileA, profileB, guidePolesArr, makeSolid), guided: true };
    } catch (e: any) {
      reason = e?.message ?? String(e);
    }

    // 3. Plain unguided loft — last resort so the user still gets a shape.
    return {
      shape:  OccLoftService.loftProfiles(oc, [profileA, profileB], makeSolid, false),
      guided: false,
      reason,
    };
  }

  // ── Extending past 2 guides ────────────────────────────────────────────────
  // MakePipeShell caps at spine + 1 auxiliary rail. For N>2 guides you would:
  //   1. Build a Geom_BSplineCurve for each guide + each profile section,
  //   2. Feed them to GeomFill_BSplineCurves / BRepFill_Filling to skin a face
  //      per panel between adjacent guide rails, then sew the faces (BRepBuilder
  //      _Sewing) into a shell and BRepBuilderAPI_MakeSolid. That is a separate
  //      service; this one deliberately covers the robust 1–2 rail case.
}
