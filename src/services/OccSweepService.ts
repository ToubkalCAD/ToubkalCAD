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
   * Sweep a 2-D profile along a 3-D spine wire.
   * @param profile  Closed TopoDS_Wire (cross-section).
   * @param spine    TopoDS_Wire path (open or closed).
   * @returns        TopoDS_Shape (solid or shell depending on profile closure).
   */
  static sweepProfile(oc: any, profile: any, spine: any): any {
    const scope = new WasmScope();
    try {
      // BRepOffsetAPI_MakePipe_1(Spine, Profile) — spine is FIRST argument
      const pipe = scope.keep(new oc.BRepOffsetAPI_MakePipe_1(spine, profile));
      const prog = scope.keep(new oc.Message_ProgressRange_1());
      pipe.Build(prog);
      if (!pipe.IsDone())
        throw new Error(
          'Sweep failed. Ensure the spine is G1-continuous and the profile ' +
          'is a closed wire placed at the spine start.'
        );
      return pipe.Shape();
    } finally {
      scope.free();
    }
  }
}
