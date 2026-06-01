// ============================================================
// ToubkalCAD – OccLoftService.ts
// Loft (ThruSections): creates a solid by blending multiple
// cross-sectional wires ordered along the loft direction.
//
// Verified constructor:
//   BRepOffsetAPI_ThruSections(isSolid, ruled, pres3d)
//     isSolid  – true = solid, false = shell
//     ruled    – true = ruled (flat) surfaces, false = smooth B-splines
//     pres3d   – 3-D precision tolerance
//   .AddWire(TopoDS_Wire)
//   .CheckCompatibility(bool)
//   .SetSmoothing(bool)
//   .Build(Message_ProgressRange)
//   .Shape() (inherited from BRepBuilderAPI_MakeShape)
//
// Requirements:
//   • All wires must be closed.
//   • Wires should have the same number of edges for best results.
//   • Minimum 2 profiles required.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export class OccLoftService {

  /**
   * Loft through a series of ordered closed wire sections.
   * @param profiles   Array of TopoDS_Wire (ordered along the loft axis, ≥ 2).
   * @param isSolid    true = closed solid with end caps, false = open shell.
   * @param ruled      true = flat (ruled) surfaces, false = smooth B-splines.
   */
  static loftProfiles(
    oc:       any,
    profiles: any[],
    isSolid   = true,
    ruled     = false,
  ): any {
    if (profiles.length < 2)
      throw new Error('Loft requires at least 2 profiles.');

    const scope = new WasmScope();
    try {
      // Direct constructor — no _1/_2 variants
      const loft = scope.keep(new oc.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6));

      // Smooth B-spline blending when ruled=false
      if (!ruled) loft.SetSmoothing(true);

      // Relax compatibility check to allow sections with different edge counts
      loft.CheckCompatibility(false);

      for (const wire of profiles) loft.AddWire(wire);

      const prog = scope.keep(new oc.Message_ProgressRange_1());
      loft.Build(prog);

      if (!loft.IsDone())
        throw new Error(
          'Loft failed. Check that all profiles are closed wires with ' +
          'compatible topology. Try enabling "ruled" mode for simpler geometry.'
        );

      return loft.Shape();
    } finally {
      scope.free();
    }
  }
}
