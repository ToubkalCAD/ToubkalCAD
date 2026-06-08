// ============================================================
// ToubkalCAD – OccExtrusionService.ts
// Wire (3D, on any plane) → Face → Solid via BRepPrimAPI_MakePrism.
// Extrusion direction = workplane normal (retrieved from node params).
//
// End conditions (CATIA "Pad" First/Second Limit, single-prism approach):
//   • blind     — extrude `height` along the (optionally reversed) normal.
//   • symmetric — centred on the sketch plane: shift the face back by
//                 height/2, then extrude the full `height`. One prism, no
//                 boolean seam (more robust than extrude-twice + fuse).
//   • twoSided  — asymmetric two-way: shift back by `height2`, extrude
//                 `height + height2`.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export type ExtrudeEnd = 'blind' | 'symmetric' | 'twoSided';

export interface ExtrudeOptions {
  /** First-limit distance along the (optionally reversed) direction. > 0. */
  height:     number;
  /** End condition. Default 'blind'. */
  end?:       ExtrudeEnd;
  /** Second-limit distance for 'twoSided' (back side). > 0 when used. */
  height2?:   number;
  /** Flip the extrusion to the opposite side of the sketch plane. */
  reverse?:   boolean;
  /** Unit normal of the sketch plane. Defaults to [0,1,0] (Y-up). */
  direction?: [number, number, number];
  /** Draft angle in DEGREES (E4). Tapers the lateral walls about the neutral
   *  (sketch) plane; 0 = straight walls. Positive narrows toward the pull dir. */
  draftAngle?:   number;
  /** A point on the sketch plane = neutral plane for draft. Default origin. */
  neutralPoint?: [number, number, number];
  /** Wall thickness in mm (E3). > 0 hollows the prism into an open tube of this
   *  wall thickness (both caps removed). 0 = solid. */
  thickness?:    number;
}

export class OccExtrusionService {
  /**
   * Extrude a closed planar 3D wire into a solid with CATIA-style end
   * conditions. Returns a TopoDS_Solid owned by the caller (register it in
   * CADGeometryRegistry).
   */
  static extrude(oc: any, wire: any, opts: ExtrudeOptions): any {
    const {
      height,
      end          = 'blind',
      height2      = 0,
      reverse      = false,
      direction    = [0, 1, 0],
      draftAngle   = 0,
      neutralPoint = [0, 0, 0],
      thickness    = 0,
    } = opts;

    if (height <= 0) throw new Error('Extrusion height must be > 0');

    // Normalise direction (and flip if reversed).
    let [dx, dy, dz] = direction;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) throw new Error('Extrusion direction is zero-length');
    dx /= len; dy /= len; dz /= len;
    if (reverse) { dx = -dx; dy = -dy; dz = -dz; }

    // Resolve back-offset + total length from the end condition.
    let back  = 0;          // distance to shift the face backwards before sweeping
    let total = height;     // full sweep length
    if (end === 'symmetric') {
      back  = height / 2;
      total = height;
    } else if (end === 'twoSided') {
      if (height2 <= 0) throw new Error('Second limit (height2) must be > 0');
      back  = height2;
      total = height + height2;
    }

    const scope = new WasmScope();
    try {
      // Build face from the closed planar wire.
      const faceMaker = scope.keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
      if (!faceMaker.IsDone()) {
        throw new Error(
          'Extrusion: face creation failed — wire must be closed and planar. ' +
          'Only Circle, Rectangle, Ellipse, Polygon and Rounded-Rectangle can be extruded.',
        );
      }
      let face = faceMaker.Shape();

      // Shift the face backwards for symmetric / two-sided sweeps.
      if (back > 1e-9) {
        const trsf = scope.keep(new oc.gp_Trsf_1());
        const tv   = scope.keep(new oc.gp_Vec_4(-dx * back, -dy * back, -dz * back));
        trsf.SetTranslation_1(tv);
        const mover = scope.keep(new oc.BRepBuilderAPI_Transform_2(face, trsf, true));
        if (!mover.IsDone()) throw new Error('Extrusion: face offset failed');
        face = mover.Shape();
      }

      const vec   = scope.keep(new oc.gp_Vec_4(dx * total, dy * total, dz * total));
      const prism = scope.keep(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true));
      if (!prism.IsDone()) throw new Error('Extrusion: prism computation failed');
      let solid = prism.Shape();

      // Pipeline: prism → draft → thick. (Boolean Pad/Pocket happens in the caller.)
      if (Math.abs(draftAngle) > 1e-6) {
        solid = OccExtrusionService.applyDraft(oc, solid, draftAngle, [dx, dy, dz], neutralPoint);
      }
      if (thickness > 1e-6) {
        solid = OccExtrusionService.applyThickWall(oc, solid, thickness, [dx, dy, dz]);
      }
      return solid;
    } finally {
      scope.free();
    }
  }

  /**
   * Hollow a prism into an open thin-walled tube of the given wall thickness
   * (CATIA "Thick" on a closed profile). Both cap faces (normal ∥ pull dir) are
   * removed, leaving the side walls offset inward by `thickness`.
   * Uses BRepOffsetAPI_MakeThickSolid (also the foundation for M1 Shell).
   */
  private static applyThickWall(
    oc:        any,
    solid:     any,
    thickness: number,
    pullDir:   [number, number, number],
  ): any {
    const [px, py, pz] = pullDir;
    const scope = new WasmScope();
    try {
      // Collect the cap faces (planar, normal ∥ pull direction) to open.
      const caps = scope.keep(new oc.TopTools_ListOfShape_1());
      const exp  = scope.keep(new oc.TopExp_Explorer_2(
        solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      ));
      while (exp.More()) {
        const fscope = new WasmScope();
        try {
          const face  = oc.TopoDS.Face_1(exp.Current());
          const surfH = fscope.keep(oc.BRep_Tool.Surface_2(face));
          if (!surfH.IsNull()) {
            const adaptor = fscope.keep(new oc.GeomAdaptor_Surface_2(surfH));
            if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
              const nDir = fscope.keep(fscope.keep(adaptor.Plane()).Axis()).Direction();
              const dot  = Math.abs(nDir.X() * px + nDir.Y() * py + nDir.Z() * pz);
              if (dot > 0.5) caps.Append_1(face);  // cap → remove (list keeps its own ref)
            }
          }
        } finally { fscope.free(); }
        exp.Next();
      }
      if (caps.Extent() === 0) throw new Error('Thick: no cap face found to open the wall.');

      const mts = scope.keep(new oc.BRepOffsetAPI_MakeThickSolid());
      mts.MakeThickSolidByJoin(
        solid, caps, -Math.abs(thickness), 1e-3,
        oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
        oc.GeomAbs_JoinType.GeomAbs_Intersection, false,
        new oc.Message_ProgressRange_1(),
      );
      mts.Build(new oc.Message_ProgressRange_1());
      if (!mts.IsDone()) throw new Error('Thick: wall failed — thickness too large for the profile?');
      return mts.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * Taper a prism's lateral (side) walls by `angleDeg` about the neutral plane
   * (the sketch plane = neutralPoint + pullDir). Only planar side faces are
   * drafted — caps (normal ∥ pullDir) are skipped, and curved walls (cylinders
   * from circular profiles) are left straight in this pass.
   * Returns the drafted solid, or the input unchanged if no face was draftable.
   */
  private static applyDraft(
    oc:           any,
    solid:        any,
    angleDeg:     number,
    pullDir:      [number, number, number],
    neutralPoint: [number, number, number],
  ): any {
    const angle = (angleDeg * Math.PI) / 180;
    const scope = new WasmScope();
    try {
      const [px, py, pz] = pullDir;
      const dir = scope.keep(new oc.gp_Dir_4(px, py, pz));
      const pnt = scope.keep(new oc.gp_Pnt_3(neutralPoint[0], neutralPoint[1], neutralPoint[2]));
      const neutral = scope.keep(new oc.gp_Pln_3(pnt, dir));

      const draft = scope.keep(new oc.BRepOffsetAPI_DraftAngle_2(solid));

      // Collect planar lateral faces (normal ⟂ pull direction) and add draft.
      const exp = scope.keep(new oc.TopExp_Explorer_2(
        solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      ));
      let added = 0;
      while (exp.More()) {
        const fscope = new WasmScope();
        try {
          const face  = oc.TopoDS.Face_1(exp.Current());
          const surfH = fscope.keep(oc.BRep_Tool.Surface_2(face));
          if (!surfH.IsNull()) {
            const adaptor = fscope.keep(new oc.GeomAdaptor_Surface_2(surfH));
            if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
              const pln  = fscope.keep(adaptor.Plane());
              const nDir = fscope.keep(fscope.keep(pln.Axis()).Direction());
              const dot  = Math.abs(nDir.X() * px + nDir.Y() * py + nDir.Z() * pz);
              if (dot < 0.5) {                       // side wall, not a cap
                draft.Add(face, dir, angle, neutral, true);
                if (draft.AddDone()) added++;
              }
            }
          }
        } finally { fscope.free(); }
        exp.Next();
      }

      if (added === 0) return solid;                 // nothing draftable → no-op

      draft.Build(new oc.Message_ProgressRange_1());
      if (!draft.IsDone()) throw new Error('Draft: build failed (angle too steep for the geometry?)');
      return draft.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * Backwards-compatible blind extrusion.
   * @param direction  Unit normal of the sketch plane (extrusion axis).
   */
  static extrudeWireToSolid(
    oc:        any,
    wire:      any,
    height:    number,
    direction: [number, number, number] = [0, 1, 0],
  ): any {
    return OccExtrusionService.extrude(oc, wire, { height, direction });
  }

  /** Backwards-compat alias used by CADToolbar. */
  static extrudeWire(
    oc:        any,
    wire:      any,
    distance:  number,
    direction: [number, number, number] = [0, 1, 0],
  ): any {
    return OccExtrusionService.extrude(oc, wire, { height: distance, direction });
  }
}
