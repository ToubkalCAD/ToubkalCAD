// ============================================================
// ToubkalCAD – OccSweepService.ts
// Pipe sweep: moves a closed profile along a spine wire.
//
// Verified constructors:
//   BRepOffsetAPI_MakePipe_1(Spine: TopoDS_Wire, Profile: TopoDS_Shape)
//   Message_ProgressRange_1()
//
// Notes:
//   • The spine must be G1-continuous (smooth joins between edges).
//     An open poly-line spine will work but may produce kinks.
//   • Profile must be a closed wire or face placed at or near the
//     start of the spine; OCC auto-positions it.
//   • For advanced sweeps (scaling, twist) use BRepOffsetAPI_MakePipe_2
//     with GeomFill_Trihedron modes — marked as future enhancement.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export class OccSweepService {

  /**
   * Sweep a 2-D profile along a 3-D spine wire into a SOLID.
   *
   * BRepOffsetAPI_MakePipe yields a solid only when fed a FACE — sweeping a bare
   * wire gives a hollow shell. So a closed planar profile wire is first capped into
   * a face (BRepBuilderAPI_MakeFace_15) before piping; an open / non-planar wire
   * that can't be faced falls back to sweeping the wire directly (an open surface).
   *
   * @param profile  Closed TopoDS_Wire (or face) cross-section.
   * @param spine    TopoDS_Wire path (open or closed).
   * @returns        TopoDS_Solid for a closed profile, else a TopoDS_Shell.
   */
  static sweepProfile(oc: any, profile: any, spine: any): any {
    const scope = new WasmScope();
    try {
      // Cap a closed planar wire into a face so the pipe encloses a solid.
      let section = profile;
      if (profile.ShapeType && profile.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) {
        const fm = scope.keep(new oc.BRepBuilderAPI_MakeFace_15(profile, true));
        if (fm.IsDone()) section = fm.Face();      // closed planar → solid sweep
      }
      return OccSweepService.pipe(oc, section, spine, scope);
    } finally {
      scope.free();
    }
  }

  /**
   * SURFACE sweep (zero-thickness): pipe the profile WIRE directly (never capped
   * into a face), so the result is a TopoDS_Shell — an open tube of constant cross
   * section with no end caps. This is the core distinction from the solid
   * `sweepProfile`. Register the result with bodyType:'surface'.
   */
  static sweepSurface(oc: any, profile: any, spine: any): any {
    const scope = new WasmScope();
    try {
      return OccSweepService.pipe(oc, profile, spine, scope);
    } finally {
      scope.free();
    }
  }

  /** Shared BRepOffsetAPI_MakePipe(spine, section) build; section is a wire (shell)
   *  or a face (solid). Result is allocated outside `scope`. */
  private static pipe(oc: any, section: any, spine: any, scope: WasmScope): any {
    // BRepOffsetAPI_MakePipe_1(Spine, Profile) — spine is FIRST argument
    const pipe = scope.keep(new oc.BRepOffsetAPI_MakePipe_1(spine, section));
    pipe.Build(scope.keep(new oc.Message_ProgressRange_1()));
    if (!pipe.IsDone())
      throw new Error(
        'Sweep failed. Ensure the spine is G1-continuous and the profile ' +
        'is a closed wire placed at the spine start.'
      );
    return pipe.Shape();
  }
}
