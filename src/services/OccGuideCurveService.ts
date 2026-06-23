// ============================================================
// ToubkalCAD – OccGuideCurveService.ts
//
// Turns the 3D control points sculpted in three.js into an exact OCC guide:
// a Geom_BezierCurve → TopoDS_Edge → TopoDS_Wire, with both ENDPOINTS snapped
// precisely onto their owning profile wires.
//
// Why the endpoint projection matters: BRepOffsetAPI_MakePipeShell rejects (or
// silently inverts) a sweep when a profile does not lie on the spine. The snap
// engine gives a point that is visually on the wire but only to ~screen
// precision; here we re-project it onto the real TopoDS geometry with
// BRepExtrema_DistShapeShape so the guide endpoint is mathematically ON the
// profile (sub-tolerance), which is what keeps the lofted shell topology valid.
//
// Verified OCCT 7.8 API (opencascade.full.d.ts):
//   Geom_BezierCurve_1(TColgp_Array1OfPnt)            – curve from poles
//   TColgp_Array1OfPnt_2(lower, upper)  + SetValue    – 1-indexed pole array
//   Handle_Geom_Curve_2(Geom_Curve)                   – up-cast to curve handle
//   BRepBuilderAPI_MakeEdge_24(Handle_Geom_Curve)     – edge from curve
//   BRepBuilderAPI_MakeWire_2(TopoDS_Edge)            – wire from one edge
//   BRepExtrema_DistShapeShape_2(S1, S2) .Value()/.PointOnShape2(n)
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export interface Vec3 { x: number; y: number; z: number }

export class OccGuideCurveService {

  /**
   * Project `p` onto `wire`, returning the exact closest point ON the wire.
   * Falls back to the input point if the extrema solver finds no solution.
   */
  static projectPointOntoWire(oc: any, wire: any, p: Vec3): Vec3 {
    const scope = new WasmScope();
    try {
      const pnt    = scope.keep(new oc.gp_Pnt_3(p.x, p.y, p.z));
      const vertex = scope.keep(new oc.BRepBuilderAPI_MakeVertex(pnt)).Vertex();
      const dss    = scope.keep(new oc.BRepExtrema_DistShapeShape_2(vertex, wire));
      if (!dss.IsDone() || dss.NbSolution() < 1) return { ...p };
      const onWire = dss.PointOnShape2(1);    // gp_Pnt on the wire (shape 2)
      return { x: onWire.X(), y: onWire.Y(), z: onWire.Z() };
    } catch {
      return { ...p };                         // never let projection abort a build
    } finally {
      scope.free();
    }
  }

  /**
   * Build an exact guide wire from ordered control points.
   *
   * @param points       3..4 control points (Bezier poles). 3 → quadratic,
   *                     4 → cubic. Endpoints are poles[0] and poles[last].
   * @param startWire    profile wire the FIRST endpoint must lie on (optional).
   * @param endWire      profile wire the LAST  endpoint must lie on (optional).
   *
   * Returns a registered-elsewhere TopoDS_Wire (the caller owns its lifetime via
   * CADGeometryRegistry). Temporaries are freed here.
   */
  static buildGuideWire(
    oc: any, points: Vec3[], startWire?: any, endWire?: any,
  ): any {
    if (points.length < 2) throw new Error('A guide needs at least 2 points.');

    // 1. Lock the endpoints onto their profiles (mathematical G0 contact).
    const poles = points.map((p) => ({ ...p }));
    if (startWire) poles[0]              = OccGuideCurveService.projectPointOntoWire(oc, startWire, poles[0]);
    if (endWire)   poles[poles.length-1] = OccGuideCurveService.projectPointOntoWire(oc, endWire, poles[poles.length-1]);

    // 2. Pole array (TColgp_Array1OfPnt is 1-indexed). The Bezier copies the
    //    poles internally, so the array is a true temporary and is freed below.
    const arr = new oc.TColgp_Array1OfPnt_2(1, poles.length);
    poles.forEach((p, i) => {
      const gp = new oc.gp_Pnt_3(p.x, p.y, p.z);
      arr.SetValue(i + 1, gp);
      try { gp.delete(); } catch { /* noop */ }   // gp_Pnt copied by value
    });

    // 3. Bezier curve → edge → wire.
    //
    // CRITICAL — do NOT .delete() the curve or its Handle. The edge references the
    // Geom_BezierCurve through an OCC Handle; Embind's .delete() destroys the C++
    // object immediately, IGNORING the Handle ref-count, which leaves the edge's
    // geometry dangling. Downstream that surfaces as a WASM use-after-free —
    // "table index is out of bounds" / "null function" — when MakePipeShell (or
    // any consumer) evaluates the curve. OCC's own Handle frees the curve when the
    // edge/TShape is released, so just don't touch it here. Only the array and the
    // edge BUILDER are true temporaries safe to free.
    const bezier = new oc.Geom_BezierCurve_1(arr);
    const handle = new oc.Handle_Geom_Curve_2(bezier);
    const mkEdge = new oc.BRepBuilderAPI_MakeEdge_24(handle);
    const edge   = mkEdge.Edge();
    const wire   = new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
    try { arr.delete(); mkEdge.delete(); } catch { /* noop */ }
    return wire;
  }

  /**
   * Sample the guide Bezier into world points for three.js preview rendering.
   * (A Bezier is C∞, so a modest segment count looks smooth.)
   */
  static sampleBezier(points: Vec3[], segments = 48): Vec3[] {
    if (points.length < 2) return points.slice();
    const out: Vec3[] = [];
    const n = points.length - 1;                 // degree
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      out.push(OccGuideCurveService.deCasteljau(points, t, n));
    }
    return out;
  }

  /** Evaluate a degree-n Bezier at t via de Casteljau (numerically stable). */
  private static deCasteljau(poles: Vec3[], t: number, n: number): Vec3 {
    const pts = poles.map((p) => ({ ...p }));
    for (let r = 1; r <= n; r++) {
      for (let i = 0; i <= n - r; i++) {
        pts[i] = {
          x: (1 - t) * pts[i].x + t * pts[i + 1].x,
          y: (1 - t) * pts[i].y + t * pts[i + 1].y,
          z: (1 - t) * pts[i].z + t * pts[i + 1].z,
        };
      }
    }
    return pts[0];
  }
}
