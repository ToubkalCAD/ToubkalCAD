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
