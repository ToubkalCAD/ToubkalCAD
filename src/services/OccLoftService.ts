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
   *
   * Robustness: BRepOffsetAPI_ThruSections can fail on certain profile
   * combinations not by returning IsDone=false but by throwing a kernel
   * exception (surfaced to JS as a raw number / "null function" RuntimeError) —
   * the "Loft failed: null function" / "Loft failed: <number>" the user hit with
   * three sections. So if the requested mode throws or doesn't finish, we retry
   * in progressively safer modes before giving up.
   *
   * PERF: the kernel runs on the main thread, so this must stay cheap — the
   * happy path is a SINGLE build that returns immediately (no validity analysis;
   * BRepCheck_Analyzer on a smooth B-spline loft costs seconds and froze the UI).
   * The fallbacks only run when the primary attempt actually fails. We also do
   * NOT call SetSmoothing(true): `ruled=false` already yields smooth B-spline
   * faces, and the extra smoothing approximation pass cost ~20× the build time
   * (2700ms vs 140ms for a 3-section circle/ellipse loft) — that was the >45s
   * freeze / unresponsive panel, not just the BRepCheck above.
   */
  static loftProfiles(
    oc:       any,
    profiles: any[],
    isSolid   = true,
    ruled     = false,
  ): any {
    if (profiles.length < 2)
      throw new Error('Loft requires at least 2 profiles.');

    // CheckCompatibility(true) reconciles sections with DIFFERENT edge counts
    // (e.g. 4-edge rectangle → 1-edge circle): OCCT splits edges so every
    // section has the same count, then aligns seam + winding to kill the N→M
    // twist (verified in scripts/test-loft-twist.mjs). But when every section
    // ALREADY shares an edge count — the common circle/ellipse case — that pass
    // is unnecessary and in some OCC builds destabilises the B-spline blend
    // enough to trap. So enable it only when the counts actually differ.
    const counts = profiles.map((w) => OccLoftService.edgeCount(oc, w));
    const mixed  = counts.some((c) => c !== counts[0]);

    // Requested mode first, then a ruled fallback (flat sections — far more
    // tolerant). The fallback runs ONLY if the primary throws / doesn't finish.
    const plans = ruled ? [true] : [false, true];

    for (const planRuled of plans) {
      try {
        const shape = OccLoftService.buildOnce(oc, profiles, isSolid, planRuled, mixed);
        if (shape) return shape;
      } catch {
        // kernel exception — drop to the safer ruled plan
      }
    }

    throw new Error(
      'Loft failed: these profiles could not be blended into a valid solid. ' +
      'Try reordering or removing a profile, or switch to Ruled mode.'
    );
  }

  /** One ThruSections attempt. Returns the shape, or null if !IsDone. */
  private static buildOnce(
    oc: any, profiles: any[], isSolid: boolean, ruled: boolean, mixed: boolean,
  ): any {
    const scope = new WasmScope();
    try {
      // ruled=false already gives smooth B-spline faces; SetSmoothing(true) is an
      // extra (very expensive) approximation pass we intentionally skip — see the
      // PERF note on loftProfiles.
      const loft = scope.keep(new oc.BRepOffsetAPI_ThruSections(isSolid, ruled, 1e-6));
      if (mixed) loft.CheckCompatibility(true);
      for (const wire of profiles) loft.AddWire(wire);
      const prog = scope.keep(new oc.Message_ProgressRange_1());
      loft.Build(prog);
      if (!loft.IsDone()) return null;
      return loft.Shape();   // shares the (ref-counted) TShape handle — survives scope.free()
    } finally {
      scope.free();
    }
  }

  /** Number of TopoDS_Edge in a wire (used to decide CheckCompatibility). */
  private static edgeCount(oc: any, wire: any): number {
    let n = 0;
    const exp = new oc.TopExp_Explorer_2(
      wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (exp.More()) { n++; exp.Next(); }
    try { exp.delete(); } catch { /* noop */ }
    return n;
  }
}
