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
//   • Minimum 2 profiles required.
//   • Profiles may have DIFFERENT edge counts (e.g. rectangle → circle):
//     CheckCompatibility(true) reconciles them — see the note in loftProfiles.
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

      // CheckCompatibility(true) is what makes sections with DIFFERENT edge
      // counts loftable: OCCT splits edges so every section has the same count,
      // then recomputes each wire's seam origin + winding to minimise twist
      // (start-to-start, same orientation). This is the general N→M fix.
      //
      // Disabling it (the old code) tells OCCT "these wires already align
      // edge-for-edge" — true only for matched profiles (circle→ellipse, both
      // 1 edge). For a 4-edge rectangle → 1-edge circle it maps corners to the
      // circle arbitrarily, producing a self-intersecting, zero-volume,
      // BRepCheck-invalid solid (the reported bowtie). Verified headlessly in
      // scripts/test-loft-twist.mjs: false → invalid in every mismatch case;
      // true → one valid solid for pentagon/triangle/N-gon→circle, opposite
      // winding, and rotated seams alike.
      loft.CheckCompatibility(true);

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
