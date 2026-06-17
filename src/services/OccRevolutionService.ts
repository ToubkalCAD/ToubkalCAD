// ============================================================
// ToubkalCAD – OccRevolutionService.ts
// Revolution of a 2D profile around an axis + torus / cone helpers.
//
// Verified constructors:
//   gp_Pnt_3(x, y, z)
//   gp_Dir_4(x, y, z)
//   gp_Ax1_2(gp_Pnt, gp_Dir)
//   BRepPrimAPI_MakeRevol_1(Shape, gp_Ax1, angle, Copy)  – partial angle
//   BRepPrimAPI_MakeRevol_2(Shape, gp_Ax1, Copy)          – full 360°
//   BRepBuilderAPI_MakeFace_15(TopoDS_Wire, OnlyPlane)
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export class OccRevolutionService {

  // ─── Core revolution ─────────────────────────────────────────────────────────

  /**
   * Revolve a closed wire or face around an axis.
   * @param profile     TopoDS_Wire (closed) or TopoDS_Face
   * @param axisOrigin  3-D point on the revolution axis
   * @param axisDir     Direction of the axis (normalised internally)
   * @param angleDeg    Sweep angle in degrees (1–360)
   */
  static revolveProfile(
    oc:         any,
    profile:    any,
    axisOrigin: [number, number, number] = [0, 0, 0],
    axisDir:    [number, number, number] = [0, 1, 0],
    angleDeg:   number = 360,
  ): any {
    if (angleDeg <= 0 || angleDeg > 360)
      throw new Error('Revolution angle must be between 1° and 360°.');

    const scope = new WasmScope();
    try {
      // Wire → planar face if needed
      let face = profile;
      if (profile.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) {
        const fm = scope.keep(new oc.BRepBuilderAPI_MakeFace_15(profile, true));
        if (!fm.IsDone())
          throw new Error('Revolution: cannot build face from wire — is it closed and planar?');
        face = fm.Shape();
      }

      // Guard: an axis that passes THROUGH the profile makes a self-intersecting
      // (or failed) solid. Fail fast with a clear message instead of a long
      // degenerate build. (An axis that only touches the profile edge — e.g. a
      // half-disk → sphere — is valid and NOT flagged.)
      if (OccRevolutionService.axisIntersectsProfile(oc, face, axisOrigin, axisDir))
        throw new Error('The revolution axis passes through the profile. Move the axis or the sketch so the axis lies to one side of the profile.');

      const origin = scope.keep(new oc.gp_Pnt_3(...axisOrigin));
      const dir    = scope.keep(new oc.gp_Dir_4(...axisDir));
      const axis   = scope.keep(new oc.gp_Ax1_2(origin, dir));
      const prog   = scope.keep(new oc.Message_ProgressRange_1());

      let mkRev: any;
      if (Math.abs(angleDeg - 360) < 1e-4) {
        mkRev = scope.keep(new oc.BRepPrimAPI_MakeRevol_2(face, axis, false));
      } else {
        mkRev = scope.keep(new oc.BRepPrimAPI_MakeRevol_1(face, axis, angleDeg * (Math.PI / 180), false));
      }
      mkRev.Build(prog);
      if (!mkRev.IsDone()) throw new Error('Revolution computation failed.');
      return mkRev.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * True if the revolution axis passes through the interior of the (planar)
   * profile face — which would revolve into a self-intersecting / invalid solid.
   *
   * Method: sample the profile's triangulation nodes, project each onto the
   * in-plane direction perpendicular to the axis (e = faceNormal × axisDir), and
   * report a straddle (points on BOTH sides). A profile that merely touches the
   * axis along an edge stays on one side (min ≈ 0, not negative) → not flagged, so
   * the classic "revolve a half-disk around its diameter → sphere" still works.
   * Any failure to determine → returns false (let OCC try; IsDone catches the rest).
   */
  static axisIntersectsProfile(
    oc: any, face: any,
    axisOrigin: [number, number, number],
    axisDir:    [number, number, number],
  ): boolean {
    const s = new WasmScope();
    try {
      const nodes = OccRevolutionService.faceNodes(oc, face, s);
      if (nodes.length < 3) return false;

      // Face normal from the first non-degenerate triangle of nodes.
      const sub = (a: number[], b: number[]) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
      const cross = (a: number[], b: number[]) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
      let n: number[] | null = null;
      for (let i = 2; i < nodes.length && !n; i++) {
        const c = cross(sub(nodes[1], nodes[0]), sub(nodes[i], nodes[0]));
        if (len(c) > 1e-9) n = c;
      }
      if (!n) return false;

      const d = axisDir.slice();
      const dl = len(d); if (dl < 1e-12) return false;
      const dn: number[] = [d[0]/dl, d[1]/dl, d[2]/dl];
      const e = cross(n, dn);
      const el = len(e);
      if (el < 1e-6 * len(n)) return false;          // axis ⟂ profile plane → different case, skip
      const eu = [e[0]/el, e[1]/el, e[2]/el];

      let min = Infinity, max = -Infinity;
      for (const p of nodes) {
        const sVal = (p[0]-axisOrigin[0])*eu[0] + (p[1]-axisOrigin[1])*eu[1] + (p[2]-axisOrigin[2])*eu[2];
        if (sVal < min) min = sVal;
        if (sVal > max) max = sVal;
      }
      const tol = Math.max(1e-6, 1e-3 * (max - min));  // edge-touch (min≈0) is NOT a straddle
      return min < -tol && max > tol;
    } catch {
      return false;        // can't determine → let the build proceed
    } finally {
      s.free();
    }
  }

  /** Triangulation node world coordinates of a face (coarse mesh just for sampling). */
  private static faceNodes(oc: any, face: any, s: WasmScope): number[][] {
    const bb = s.keep(new oc.Bnd_Box_1());
    oc.BRepBndLib.Add(face, bb, false);
    const lo = bb.CornerMin(), hi = bb.CornerMax();
    const diag = Math.hypot(hi.X()-lo.X(), hi.Y()-lo.Y(), hi.Z()-lo.Z());
    s.keep(new oc.BRepMesh_IncrementalMesh_2(face, Math.max(0.5, diag * 0.05), false, 0.5, false))
      .Perform(s.keep(new oc.Message_ProgressRange_1()));
    const out: number[][] = [];
    const loc = s.keep(new oc.TopLoc_Location_1());
    const tri = oc.BRep_Tool.Triangulation(oc.TopoDS.Face_1(face), loc, 0);
    if (tri.IsNull()) return out;
    const t = tri.get();
    const trsf = loc.Transformation();
    const nb = t.NbNodes();
    for (let i = 1; i <= nb; i++) {
      const p = t.Node(i).Transformed(trsf);
      out.push([p.X(), p.Y(), p.Z()]);
    }
    return out;
  }

  /** Backwards-compat alias used by existing CADToolbar for torus/cone callers. */
  static revolve = OccRevolutionService.revolveProfile;

  // ─── Convenience primitives ───────────────────────────────────────────────────

  static createTorus(oc: any, majorRadius: number, tubeRadius: number): any {
    if (majorRadius <= tubeRadius)
      throw new Error('Major radius must be greater than tube radius.');
    const scope = new WasmScope();
    try {
      const mk = scope.keep(new oc.BRepPrimAPI_MakeTorus_1(majorRadius, tubeRadius));
      mk.Build(scope.keep(new oc.Message_ProgressRange_1()));
      if (!mk.IsDone()) throw new Error('Torus computation failed.');
      return mk.Shape();
    } finally {
      scope.free();
    }
  }

  static createCone(oc: any, r1: number, r2: number, h: number): any {
    if (h <= 0) throw new Error('Cone height must be > 0.');
    const scope = new WasmScope();
    try {
      const mk = scope.keep(new oc.BRepPrimAPI_MakeCone_1(r1, r2, h));
      mk.Build(scope.keep(new oc.Message_ProgressRange_1()));
      if (!mk.IsDone()) throw new Error('Cone computation failed.');
      return mk.Shape();
    } finally {
      scope.free();
    }
  }
}
