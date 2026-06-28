// ============================================================
// ToubkalCAD – OccSurfaceService.ts
// Surface Modeling — Phase 1 PATCH (boundary / fill surface).
//
// Patch fills a single closed boundary loop with a zero-thickness sheet:
//   • Planar loop  → BRepBuilderAPI_MakeFace_15(wire, onlyPlane=true) — the exact,
//     cheap path (same face builder the solid extrude caps with). Always bound by
//     the boundary, no approximation.
//   • Non-planar loop → BRepOffsetAPI_MakeFilling: each boundary edge is added as a
//     G0 boundary constraint and the kernel minimises a plate energy to span them.
//
// Returns a TopoDS_Face owned by the caller (register it in CADGeometryRegistry,
// tag the node bodyType:'surface'). Patch has NO solid analog, so it gets its own
// node type `surface_patch` / FeatureOp `patch` (unlike loft, which reuses 'loft').
// ============================================================

import { WasmScope } from '../utils/WasmScope';

// BRepOffsetAPI_MakeFilling has a single (all-defaulted in C++) constructor; the JS
// binding does NOT apply the C++ defaults, so we pass OCC's documented default tuning.
const FILL_DEFAULTS = {
  Degree: 3, NbPtsOnCur: 15, NbIter: 2, Anisotropie: false,
  Tol2d: 1e-5, Tol3d: 1e-4, TolAng: 1e-2, TolCurv: 0.1,
  MaxDeg: 8, MaxSegments: 9,
} as const;

export class OccSurfaceService {
  /**
   * Fill a single closed boundary wire with a surface patch (TopoDS_Face).
   * Planar loops take the exact MakeFace path; non-planar loops are spanned with
   * BRepOffsetAPI_MakeFilling. Throws when the wire isn't closed or the fill fails.
   */
  static patch(oc: any, wire: any): any {
    const scope = new WasmScope();
    try {
      // Planar path first: MakeFace_15(wire, onlyPlane=true) only succeeds when the
      // boundary actually lies on a plane, so IsDone() doubles as the planarity test.
      const planar = scope.keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
      if (planar.IsDone()) {
        return planar.Face();
      }
      // Non-planar: span the boundary edges with a filling surface.
      return OccSurfaceService.fillNonPlanar(oc, wire, scope);
    } finally {
      scope.free();
    }
  }

  /**
   * BLEND (Phase 2): build a tangent (G1) bridge surface between two surface bodies.
   * Two straight connector edges join the bridged edges' endpoints, and
   * BRepOffsetAPI_MakeFilling fills the 4-sided loop with G1 continuity to each support
   * face (Add_2(edge, face, G1)) — so the bridge meets both surfaces tangentially.
   *
   * Edge selection: pass explicit boundary-edge ORDINALS (`ordA`/`ordB`, the same
   * TopExp/IndexedMap ordinals the edge picker uses) to bridge a chosen pair — needed
   * when the bodies have several facing boundaries. Omit them (or pass null) and the
   * nearest free-boundary-edge pair is found automatically (the pick-free default).
   * Returns a TopoDS_Face (register with bodyType:'surface').
   */
  static blend(oc: any, bodyA: any, bodyB: any, ordA?: number | null, ordB?: number | null): any {
    if (!bodyA || bodyA.IsNull?.() || !bodyB || bodyB.IsNull?.()) throw new Error('Blend: select two surface bodies.');
    const scope = new WasmScope();
    try {
      let edgeA: any, edgeB: any;
      if (typeof ordA === 'number' && typeof ordB === 'number') {
        // Explicit picks — resolve each ordinal to its boundary edge.
        edgeA = OccSurfaceService.edgeByOrdinal(oc, bodyA, ordA, scope);
        edgeB = OccSurfaceService.edgeByOrdinal(oc, bodyB, ordB, scope);
        if (!edgeA || !edgeB) throw new Error('Blend: the picked edges could not be resolved.');
      } else {
        // Auto: nearest facing free-boundary-edge pair (by edge-midpoint distance).
        const edgesA = OccSurfaceService.freeBoundaryEdges(oc, bodyA, scope);
        const edgesB = OccSurfaceService.freeBoundaryEdges(oc, bodyB, scope);
        if (!edgesA.length || !edgesB.length) throw new Error('Blend: a body has no open boundary edge to bridge.');
        let best = Infinity;
        for (const a of edgesA) for (const b of edgesB) {
          const d = OccSurfaceService.edgeMidDistance(oc, a, b, scope);
          if (d < best) { best = d; edgeA = a; edgeB = b; }
        }
        if (!edgeA || !edgeB) throw new Error('Blend: could not find a boundary-edge pair.');
      }

      const faceA = OccSurfaceService.faceContainingEdge(oc, bodyA, edgeA, scope);
      const faceB = OccSurfaceService.faceContainingEdge(oc, bodyB, edgeB, scope);
      if (!faceA || !faceB) throw new Error('Blend: could not resolve the support faces.');

      // Connector edges join matching endpoints (orient by proximity).
      const [a0, a1] = OccSurfaceService.edgeEndpoints(oc, edgeA, scope);
      const [b0, b1] = OccSurfaceService.edgeEndpoints(oc, edgeB, scope);
      const straight = (a0[0] - b0[0]) ** 2 + (a0[1] - b0[1]) ** 2 + (a0[2] - b0[2]) ** 2;
      const crossed  = (a0[0] - b1[0]) ** 2 + (a0[1] - b1[1]) ** 2 + (a0[2] - b1[2]) ** 2;
      const [c0, c1] = straight <= crossed ? [b0, b1] : [b1, b0];
      const conn1 = scope.keep(OccSurfaceService.lineEdge(oc, a0, c0));
      const conn2 = scope.keep(OccSurfaceService.lineEdge(oc, a1, c1));

      const d = FILL_DEFAULTS;
      const fill = scope.keep(new oc.BRepOffsetAPI_MakeFilling(
        d.Degree, d.NbPtsOnCur, d.NbIter, d.Anisotropie,
        d.Tol2d, d.Tol3d, d.TolAng, d.TolCurv, d.MaxDeg, d.MaxSegments));
      fill.Add_2(edgeA, faceA, oc.GeomAbs_Shape.GeomAbs_G1, true);   // tangent to A
      fill.Add_2(edgeB, faceB, oc.GeomAbs_Shape.GeomAbs_G1, true);   // tangent to B
      fill.Add_1(conn1, oc.GeomAbs_Shape.GeomAbs_C0, true);
      fill.Add_1(conn2, oc.GeomAbs_Shape.GeomAbs_C0, true);
      fill.Build(new oc.Message_ProgressRange_1());
      if (!fill.IsDone()) throw new Error('Blend: surface filling failed — are the boundaries facing each other?');
      return oc.TopoDS.Face_1(fill.Shape());
    } finally {
      scope.free();
    }
  }

  /** Resolve a 0-based edge ordinal to its TopoDS_Edge using the SAME de-duplicated
   *  TopExp/IndexedMap order the edge picker (OccEdgeService) exposes — so a picked
   *  ordinal maps to the same edge on recompute. */
  private static edgeByOrdinal(oc: any, shape: any, ord: number, scope: WasmScope): any {
    const map = scope.keep(new oc.TopTools_IndexedMapOfShape_1());
    const exp = scope.keep(new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    while (exp.More()) { map.Add(exp.Current()); exp.Next(); }
    if (ord < 0 || ord >= map.Extent()) return null;
    return scope.keep(oc.TopoDS.Edge_1(map.FindKey(ord + 1)));
  }

  /** Free (boundary) edges of a shape — edges adjacent to exactly one face. For a
   *  single-face sheet every edge qualifies. Allocated in `scope`. */
  private static freeBoundaryEdges(oc: any, shape: any, scope: WasmScope): any[] {
    const map = scope.keep(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
    const out: any[] = [];
    const n = map.Extent();
    for (let i = 1; i <= n; i++) {
      if (map.FindFromIndex(i).Extent() === 1) out.push(scope.keep(oc.TopoDS.Edge_1(map.FindKey(i))));
    }
    return out;
  }

  /** The face of `shape` that contains `edge` (TopoDS.IsSame), or null. */
  private static faceContainingEdge(oc: any, shape: any, edge: any, scope: WasmScope): any {
    const fexp = scope.keep(new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    while (fexp.More()) {
      const face = oc.TopoDS.Face_1(fexp.Current());
      const eexp = new oc.TopExp_Explorer_2(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      let found = false;
      while (eexp.More()) { if (edge.IsSame(eexp.Current())) { found = true; break; } eexp.Next(); }
      eexp.delete();
      if (found) return scope.keep(face);
      fexp.Next();
    }
    return null;
  }

  /** Distance between the midpoints of two edges. */
  private static edgeMidDistance(oc: any, e1: any, e2: any, scope: WasmScope): number {
    const m1 = OccSurfaceService.edgeMid(oc, e1, scope);
    const m2 = OccSurfaceService.edgeMid(oc, e2, scope);
    return Math.hypot(m1[0] - m2[0], m1[1] - m2[1], m1[2] - m2[2]);
  }

  private static edgeMid(oc: any, edge: any, scope: WasmScope): [number, number, number] {
    const c = scope.keep(new oc.BRepAdaptor_Curve_2(edge));
    const p = c.Value((c.FirstParameter() + c.LastParameter()) / 2);
    return [p.X(), p.Y(), p.Z()];
  }

  /** The two endpoints of an edge (first/last curve parameter). */
  private static edgeEndpoints(oc: any, edge: any, scope: WasmScope): [number, number, number][] {
    const c = scope.keep(new oc.BRepAdaptor_Curve_2(edge));
    const p0 = c.Value(c.FirstParameter()), p1 = c.Value(c.LastParameter());
    return [[p0.X(), p0.Y(), p0.Z()], [p1.X(), p1.Y(), p1.Z()]];
  }

  private static lineEdge(oc: any, a: number[], b: number[]): any {
    return new oc.BRepBuilderAPI_MakeEdge_3(new oc.gp_Pnt_3(a[0], a[1], a[2]), new oc.gp_Pnt_3(b[0], b[1], b[2])).Edge();
  }

  /**
   * SOLIDIFY (Surface→Solid cap/close convenience): cap every open boundary loop of a
   * surface body with a patch face, sew the surface + caps into a watertight shell, and
   * promote it to a TopoDS_Solid (oriented outward). Turns an open tube/sheet-set into a
   * solid in one step — unlike Stitch (which only sews EXISTING surfaces) or Thicken
   * (which offsets a wall). Throws if the result isn't watertight (some boundary couldn't
   * be capped). Register with bodyType:'solid'.
   */
  static solidify(oc: any, surface: any): any {
    if (!surface || surface.IsNull?.()) throw new Error('Solidify: the source surface is null.');
    const scope = new WasmScope();
    try {
      // Closed free-boundary loops → one patch cap each.
      const fb = scope.keep(new oc.ShapeAnalysis_FreeBounds_2(surface, 1e-6, false, false));
      const closed = scope.keep(fb.GetClosedWires());
      const caps: any[] = [];
      const wexp = scope.keep(new oc.TopExp_Explorer_2(closed, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      while (wexp.More()) {
        caps.push(OccSurfaceService.patch(oc, oc.TopoDS.Wire_1(wexp.Current())));   // planar→MakeFace, else MakeFilling
        wexp.Next();
      }
      if (!caps.length) throw new Error('Solidify: no open boundary to cap — is the surface already closed? (use Stitch).');

      // Sew the original surface with the caps → closed shell.
      const sew = scope.keep(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
      sew.Add(surface);
      for (const c of caps) sew.Add(c);
      sew.Perform(scope.keep(new oc.Message_ProgressRange_1()));
      const sewn = sew.SewedShape();
      if (sewn.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL || !oc.BRep_Tool.IsClosed_1(sewn)) {
        throw new Error('Solidify: capping did not produce a watertight shell.');
      }
      const mk = scope.keep(new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(sewn)));
      mk.Build(scope.keep(new oc.Message_ProgressRange_1()));
      if (!mk.IsDone()) throw new Error('Solidify: solid construction failed.');
      const solid = mk.Solid();
      oc.BRepLib.OrientClosedSolid(solid);   // flip inside-out shells so the volume is positive
      return solid;
    } finally {
      scope.free();
    }
  }

  /** Span a non-planar closed wire by adding each edge as a G0 boundary constraint
   *  to BRepOffsetAPI_MakeFilling. The returned face is allocated outside `scope`. */
  private static fillNonPlanar(oc: any, wire: any, scope: WasmScope): any {
    const d = FILL_DEFAULTS;
    const fill = scope.keep(new oc.BRepOffsetAPI_MakeFilling(
      d.Degree, d.NbPtsOnCur, d.NbIter, d.Anisotropie,
      d.Tol2d, d.Tol3d, d.TolAng, d.TolCurv, d.MaxDeg, d.MaxSegments,
    ));

    let added = 0;
    const exp = scope.keep(new oc.TopExp_Explorer_2(
      wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    ));
    while (exp.More()) {
      const edge = oc.TopoDS.Edge_1(exp.Current());
      fill.Add_1(edge, oc.GeomAbs_Shape.GeomAbs_C0, true);   // boundary constraint
      added++;
      exp.Next();
    }
    if (added === 0) throw new Error('Patch: boundary wire has no edges.');

    fill.Build(new oc.Message_ProgressRange_1());
    if (!fill.IsDone()) throw new Error('Patch: surface filling failed — is the boundary closed?');
    // MakeFilling inherits .Shape() (the filled TopoDS_Face); it has no .Face().
    return oc.TopoDS.Face_1(fill.Shape());
  }

  /**
   * STITCH (Phase 3): sew ≥2 surface bodies (faces / shells) sharing coincident
   * boundary edges into a single connected shell with BRepBuilderAPI_Sewing. When
   * `tryMakeSolid` and the sewn result is a CLOSED shell (watertight), it is promoted
   * to a TopoDS_Solid — the surface-to-solid bridge (Fusion's "Stitch → solid").
   *
   * Returns a SOLID when the inputs close up (register with bodyType:'solid'), else
   * the open shell / compound (bodyType:'surface'). The caller inspects ShapeType()
   * to set bodyType. `BRep_Tool.IsClosed_1` is the watertight test — it is only
   * meaningful on a SHELL (ShapeAnalysis_Shell.HasFreeEdges lies on compounds).
   */
  static stitch(oc: any, shapes: any[], tryMakeSolid = true, tolerance = 1e-6): any {
    if (!shapes || shapes.length < 2) throw new Error('Stitch: select at least 2 surfaces.');
    const scope = new WasmScope();
    try {
      const sew = scope.keep(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
      for (const s of shapes) sew.Add(s);
      sew.Perform(scope.keep(new oc.Message_ProgressRange_1()));
      const sewn = sew.SewedShape();

      const isShell  = sewn.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL;
      if (tryMakeSolid && isShell && oc.BRep_Tool.IsClosed_1(sewn)) {
        const mk = scope.keep(new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(sewn)));
        mk.Build(scope.keep(new oc.Message_ProgressRange_1()));
        if (mk.IsDone()) { try { sewn.delete(); } catch { /*noop*/ } return mk.Shape(); }
      }
      return sewn;   // open shell / compound / single face — stays a surface body
    } finally {
      scope.free();
    }
  }

  /**
   * TRIM (Phase 2): cut a surface body (face / shell) with a tool body, keeping the
   * portion OUTSIDE the tool (`keepInside=false` → BRepAlgoAPI_Cut) or INSIDE it
   * (`keepInside=true` → BRepAlgoAPI_Common). Pick-free: the keep side is the boolean,
   * not a clicked fragment. The tool is best a solid (a watertight region defines a
   * clean inside/outside); a surface tool also works where it fully crosses the target.
   *
   * Returns the trimmed surface (a face/shell, or a compound of them when the cut
   * yields several pieces — the renderer/measure/STEP paths all handle compounds).
   * Stays a surface body (register with bodyType:'surface').
   */
  static trim(oc: any, target: any, tool: any, keepInside = false): any {
    if (!target || target.IsNull?.()) throw new Error('Trim: the target surface is null.');
    if (!tool   || tool.IsNull?.())   throw new Error('Trim: the trimming tool is null.');
    const scope = new WasmScope();
    try {
      const op = keepInside
        ? scope.keep(new oc.BRepAlgoAPI_Common_3(target, tool, new oc.Message_ProgressRange_1()))
        : scope.keep(new oc.BRepAlgoAPI_Cut_3(target, tool, new oc.Message_ProgressRange_1()));
      op.Build(new oc.Message_ProgressRange_1());
      if (!op.IsDone()) throw new Error('Trim failed — does the tool actually cross the surface?');
      const result = op.Shape();
      // An empty result (no faces) means the keep side selected nothing.
      const probe = scope.keep(new oc.TopExp_Explorer_2(result, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      if (!probe.More()) throw new Error('Trim removed the whole surface — flip "keep inside/outside" or check the tool.');
      return result;
    } finally {
      scope.free();
    }
  }

  /**
   * EXTEND (Phase 2): grow a surface body outward by enlarging the parametric (UV)
   * bounds of each of its faces, then rebuilding the face on the wider patch
   * (BRepBuilderAPI_MakeFace_14). The current bounds come from BRepAdaptor_Surface
   * (BRepTools.UVBounds / ShapeAnalysis.GetFaceUVBounds can't return double& out-params
   * through the JS binding — they throw).
   *
   * The `distance` is MILLIMETRES, converted to a parameter delta per direction by the
   * local parametric speed |∂S/∂U|,|∂S/∂V| (adaptor.D1) — so it is mm-accurate for
   * curved surfaces (a cylinder/cone arc grows by the right amount), not just planar/
   * ruled ones. A direction is left untouched only when it is periodic AND the face
   * already spans the FULL period (a closed/wrapped cylinder won't over-wrap) — a
   * PARTIAL arc still extends.
   *
   * Single-face sheet → the extended face; multi-face shell → a compound of extended
   * faces (each grown independently). Stays a surface body (bodyType:'surface').
   */
  static extend(oc: any, surface: any, distance: number): any {
    if (!surface || surface.IsNull?.()) throw new Error('Extend: the source surface is null.');
    if (!(distance > 0)) throw new Error('Extend: distance must be > 0.');
    const scope = new WasmScope();
    try {
      const grown: any[] = [];
      const exp = scope.keep(new oc.TopExp_Explorer_2(
        surface, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      while (exp.More()) {
        const f = oc.TopoDS.Face_1(exp.Current());
        grown.push(OccSurfaceService.extendFace(oc, f, distance));
        exp.Next();
      }
      if (!grown.length) throw new Error('Extend: no face found on the surface body.');
      if (grown.length === 1) return grown[0];
      const builder  = new oc.BRep_Builder();
      const compound = new oc.TopoDS_Compound();   // returned → not freed here
      builder.MakeCompound(compound);
      for (const g of grown) builder.Add(compound, g);
      return compound;
    } finally {
      scope.free();
    }
  }

  /** Rebuild one face on UV bounds enlarged by `d` MILLIMETRES (parameter delta scaled
   *  by local parametric speed; fully-wrapped periodic directions are left alone). */
  private static extendFace(oc: any, face: any, d: number): any {
    const scope = new WasmScope();
    try {
      const surf = scope.keep(oc.BRep_Tool.Surface_2(face));
      if (surf.IsNull()) throw new Error('Extend: face has no analytic surface.');
      const ad = scope.keep(new oc.BRepAdaptor_Surface_2(face, true));
      const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter();
      const v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();

      // Local parametric speed at the patch centre → convert mm to a parameter delta.
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      const P   = scope.keep(new oc.gp_Pnt_3(0, 0, 0));
      const dU  = scope.keep(new oc.gp_Vec_4(0, 0, 0));
      const dV  = scope.keep(new oc.gp_Vec_4(0, 0, 0));
      ad.D1(um, vm, P, dU, dV);
      const speedU = dU.Magnitude(), speedV = dV.Magnitude();

      const fullU = ad.IsUPeriodic() && OccSurfaceService.spansFullPeriod(ad, u1 - u0, true);
      const fullV = ad.IsVPeriodic() && OccSurfaceService.spansFullPeriod(ad, v1 - v0, false);
      const du = fullU ? 0 : d / Math.max(speedU, 1e-9);
      const dv = fullV ? 0 : d / Math.max(speedV, 1e-9);
      if (du === 0 && dv === 0) throw new Error('Extend: the surface is closed in both directions — nothing to extend.');

      const mk = scope.keep(new oc.BRepBuilderAPI_MakeFace_14(surf, u0 - du, u1 + du, v0 - dv, v1 + dv, 1e-6));
      mk.Build(new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) throw new Error('Extend: face rebuild failed (distance too large for the surface?).');
      return mk.Face();
    } finally {
      scope.free();
    }
  }

  /** True when a periodic direction's span already covers its full period (a closed
   *  wrap — e.g. a complete cylinder) and so must not be extended further. */
  private static spansFullPeriod(ad: any, span: number, uDir: boolean): boolean {
    try {
      const period = uDir ? ad.UPeriod() : ad.VPeriod();
      return period > 0 && span >= period - 1e-6;
    } catch {
      return true;  // can't read the period → treat as closed (safe: don't over-wrap)
    }
  }

  /**
   * THICKEN (Phase 3): offset a surface body (face / shell) by `thickness` mm into a
   * watertight TopoDS_Solid via BRepOffsetAPI_MakeThickSolid::MakeThickSolidBySimple.
   * Negative thickness offsets to the other side of the sheet. Always yields a solid
   * (register with bodyType:'solid'). Throws on a degenerate offset (thickness larger
   * than the surface's smallest radius of curvature).
   */
  static thicken(oc: any, surface: any, thickness: number): any {
    if (!surface || surface.IsNull?.()) throw new Error('Thicken: the source surface is null.');
    if (Math.abs(thickness) < 1e-9) throw new Error('Thicken: thickness cannot be zero.');
    const scope = new WasmScope();
    try {
      const mt = scope.keep(new oc.BRepOffsetAPI_MakeThickSolid());
      mt.MakeThickSolidBySimple(surface, thickness);
      mt.Build(scope.keep(new oc.Message_ProgressRange_1()));
      if (!mt.IsDone()) throw new Error('Thicken failed — reduce the thickness or check the surface for self-intersections.');
      return mt.Shape();
    } finally {
      scope.free();
    }
  }
}
