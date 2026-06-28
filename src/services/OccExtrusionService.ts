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
import { buildNestedFaces, classifyAllRegions } from './ProfileNesting';

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
    const scope = new WasmScope();
    try {
      // Build face from the closed planar wire (single boundary, no holes).
      const faceMaker = scope.keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
      if (!faceMaker.IsDone()) {
        throw new Error(
          'Extrusion: face creation failed — wire must be closed and planar. ' +
          'Only Circle, Rectangle, Ellipse, Polygon and Rounded-Rectangle can be extruded.',
        );
      }
      return OccExtrusionService.extrudeFromFace(oc, faceMaker.Face(), opts);
    } finally {
      scope.free();
    }
  }

  /**
   * Extrude an already-built planar FACE (which may carry inner hole wires) into
   * a solid with the same CATIA-style end conditions / draft / thickness as
   * `extrude`. This is the shared core: `extrude` feeds it a single-wire face,
   * `extrudeProfiles` feeds it nested faces-with-holes (ProfileNesting). The face
   * is referenced, not consumed — the caller owns it.
   */
  static extrudeFromFace(oc: any, faceIn: any, opts: ExtrudeOptions): any {
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
      let face = faceIn;

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
   * SURFACE extrude (zero-thickness): prism the WIRE directly instead of a face,
   * so the result is a TopoDS_Shell (closed profile → open tube, no end caps) or a
   * TopoDS_Face (open profile → single sheet). This is the core distinction from
   * the solid `extrude`, which first caps the wire with BRepBuilderAPI_MakeFace.
   * Same blind / symmetric / two-sided limits. Register the result with
   * bodyType:'surface'. No draft / thickness (those are solid-only).
   */
  static extrudeSurface(oc: any, wire: any, opts: ExtrudeOptions): any {
    const { height, end = 'blind', height2 = 0, reverse = false, direction = [0, 1, 0] } = opts;
    if (height <= 0) throw new Error('Surface extrude height must be > 0');

    let [dx, dy, dz] = direction;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) throw new Error('Surface extrude direction is zero-length');
    dx /= len; dy /= len; dz /= len;
    if (reverse) { dx = -dx; dy = -dy; dz = -dz; }

    let back = 0, total = height;
    if (end === 'symmetric')     { back = height / 2; total = height; }
    else if (end === 'twoSided') {
      if (height2 <= 0) throw new Error('Second limit (height2) must be > 0');
      back = height2; total = height + height2;
    }

    const scope = new WasmScope();
    try {
      let prof = wire;
      if (back > 1e-9) {                                   // shift the profile back for symmetric / two-sided
        const trsf = scope.keep(new oc.gp_Trsf_1());
        const tv   = scope.keep(new oc.gp_Vec_4(-dx * back, -dy * back, -dz * back));
        trsf.SetTranslation_1(tv);
        const mover = scope.keep(new oc.BRepBuilderAPI_Transform_2(prof, trsf, true));
        if (!mover.IsDone()) throw new Error('Surface extrude: profile offset failed');
        prof = mover.Shape();
      }
      const vec   = scope.keep(new oc.gp_Vec_4(dx * total, dy * total, dz * total));
      const prism = scope.keep(new oc.BRepPrimAPI_MakePrism_1(prof, vec, false, true));
      if (!prism.IsDone()) throw new Error('Surface extrude: prism computation failed');
      return prism.Shape();
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

  /** Min/max signed projection of a shape's vertices onto `dir` from `base`. */
  private static projRange(
    oc:   any,
    shape: any,
    base: [number, number, number],
    dir:  [number, number, number],
  ): { min: number; max: number } {
    let min = Infinity, max = -Infinity;
    const exp = new oc.TopExp_Explorer_2(
      shape, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (exp.More()) {
      const v = oc.TopoDS.Vertex_1(exp.Current());
      const p = oc.BRep_Tool.Pnt(v);
      const proj = (p.X() - base[0]) * dir[0] + (p.Y() - base[1]) * dir[1] + (p.Z() - base[2]) * dir[2];
      p.delete();
      if (proj < min) min = proj;
      if (proj > max) max = proj;
      exp.Next();
    }
    exp.delete();
    return { min, max };
  }

  /**
   * Extrude a profile up to ONE specific face of a target solid (CATIA / Fusion
   * "Up to Face"). The profile is over-extruded past the target, then trimmed at
   * the *infinite extension of the selected face's surface* — so the result
   * terminates exactly on that surface (planar or curved), regardless of the
   * other faces of the body.
   *
   * `hitPoint` is the world-space point the user clicked on the solid; the face
   * whose surface passes through it is the trimming face. When omitted (legacy
   * nodes saved before face-picking), it falls back to cutting the whole target
   * — i.e. stop at the body's first surface.
   *
   * Half-space trim: BRepPrimAPI_MakeHalfSpace turns the (extended) face surface
   * into a semi-infinite solid; cutting the prism with it removes everything past
   * the face, leaving the base-touching piece. The half-space's material side is
   * convention-dependent, so we try a reference point on each side of the surface
   * and keep whichever cut yields a valid base solid.
   */
  static extrudeUpToFace(
    oc:       any,
    wires:    any[],
    opts:     { direction?: [number, number, number]; reverse?: boolean; neutralPoint?: [number, number, number] },
    target:   any,
    hitPoint?: [number, number, number],
  ): any {
    const { direction = [0, 1, 0], reverse = false, neutralPoint = [0, 0, 0] } = opts;
    const [dx, dy, dz] = OccExtrusionService.normDir(direction, reverse);
    const dir: [number, number, number] = [dx, dy, dz];

    // How far the target reaches along the axis from the sketch plane.
    const tr = OccExtrusionService.projRange(oc, target, neutralPoint, dir);
    if (tr.max <= 1e-6) {
      throw new Error('Up-to-Face: the target solid is not ahead of the sketch plane.');
    }
    const over = tr.max + 10; // extrude comfortably past the far side, then trim

    const scope = new WasmScope();
    try {
      // Profile basis = faces-with-holes from every coplanar wire (nested profiles).
      const basis = OccExtrusionService.buildProfileShape(oc, wires, scope);
      const vec   = scope.keep(new oc.gp_Vec_4(dx * over, dy * over, dz * over));
      const prism = scope.keep(new oc.BRepPrimAPI_MakePrism_1(basis, vec, false, true));
      if (!prism.IsDone()) throw new Error('Up-to-Face: over-extrude failed.');
      const overShape = prism.Shape();

      // Resolve the specific clicked face (kept alive by `faceMap` in `scope`).
      const faceMap = hitPoint ? scope.keep(new oc.TopTools_IndexedMapOfShape_1()) : null;
      let targetFace: any = null;
      if (faceMap && hitPoint) {
        const fexp = scope.keep(new oc.TopExp_Explorer_2(
          target, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
        ));
        while (fexp.More()) { faceMap.Add(fexp.Current()); fexp.Next(); }
        const idx = OccExtrusionService.nearestFaceIndex(oc, faceMap, hitPoint);
        if (idx >= 1) targetFace = oc.TopoDS.Face_1(faceMap.FindKey(idx));
      }

      // ── True Up-to-Face: terminate the prism exactly on the selected face ─────
      if (targetFace) {
        const planeN = OccExtrusionService.planarFaceNormal(oc, targetFace);

        // Fast exact path: a planar face perpendicular to the extrusion axis is
        // reached at a single distance — blind-extrude straight to it. No boolean,
        // so it can't fail when the profile is offset / doesn't overlap the body
        // (this is the common "up to the box's far face" case).
        if (planeN && Math.abs(planeN[0] * dx + planeN[1] * dy + planeN[2] * dz) > 0.999) {
          const dist = (hitPoint![0] - neutralPoint[0]) * dx
                     + (hitPoint![1] - neutralPoint[1]) * dy
                     + (hitPoint![2] - neutralPoint[2]) * dz;
          if (dist <= 1e-6) throw new Error('Up-to-Face: the selected face is not ahead of the sketch plane.');
          const vec2 = scope.keep(new oc.gp_Vec_4(dx * dist, dy * dist, dz * dist));
          const pr2  = scope.keep(new oc.BRepPrimAPI_MakePrism_1(basis, vec2, false, true));
          if (!pr2.IsDone()) throw new Error('Up-to-Face: extrude to face failed.');
          return pr2.Shape();
        }

        // General path (tilted planar OR curved — cylinder/sphere/cone): cut the
        // over-extrude with a half-space bounded by the face's (extended) surface,
        // keeping the base-touching piece. The reference point is offset along the
        // SURFACE NORMAL AT THE HIT POINT, not the extrusion axis — for a curved
        // surface two axis-offset points can land on the SAME side (both outside a
        // cylinder), collapsing the two attempts; a normal offset always straddles
        // the surface locally. `sBase = -sign(dir·N)` puts the first reference point
        // on the side the prism comes FROM, so the kept piece is the base.
        const N = planeN ?? OccExtrusionService.surfaceNormalAt(oc, targetFace, hitPoint!);
        const refOffsets: Array<[number, number, number]> = [];
        if (N) {
          const k = 0.5;                                   // small: stay local to the surface
          const sBase = (N[0] * dx + N[1] * dy + N[2] * dz) >= 0 ? -1 : 1;
          refOffsets.push([ N[0] * sBase * k,  N[1] * sBase * k,  N[2] * sBase * k]); // base side → keep base
          refOffsets.push([-N[0] * sBase * k, -N[1] * sBase * k, -N[2] * sBase * k]); // fallback
        } else {
          refOffsets.push([-dx * over, -dy * over, -dz * over]);
          refOffsets.push([ dx * over,  dy * over,  dz * over]);
        }
        for (const off of refOffsets) {
          const s2 = new WasmScope();
          try {
            const ref = s2.keep(new oc.gp_Pnt_3(
              hitPoint![0] + off[0], hitPoint![1] + off[1], hitPoint![2] + off[2],
            ));
            const hs  = s2.keep(new oc.BRepPrimAPI_MakeHalfSpace_1(targetFace, ref));
            const cut = s2.keep(new oc.BRepAlgoAPI_Cut_3(overShape, hs.Solid(), new oc.Message_ProgressRange_1()));
            cut.Build(new oc.Message_ProgressRange_1());
            if (cut.IsDone()) {
              const base = OccExtrusionService.pickBaseSolid(oc, cut.Shape(), neutralPoint, dir, over);
              if (base) return base;
            }
          } catch { /* try the other side */ } finally { s2.free(); }
        }
        throw new Error('Up-to-Face: the profile does not reach the selected face.');
      }

      // ── Fallback (no clicked point): trim against the whole target body ──────
      const cut = scope.keep(new oc.BRepAlgoAPI_Cut_3(overShape, target, new oc.Message_ProgressRange_1()));
      cut.Build(new oc.Message_ProgressRange_1());
      if (!cut.IsDone()) throw new Error('Up-to-Face: trim (cut) failed.');
      return OccExtrusionService.keepBaseSolid(oc, cut.Shape(), neutralPoint, dir, over);
    } finally {
      scope.free();
    }
  }

  /**
   * Extrude a profile up to an (infinite) datum plane given by point + normal
   * (CATIA "Up to Plane"). A plane perpendicular to the extrusion axis → exact
   * blind extrude to the distance; a tilted plane → over-extrude past it and trim
   * with a half-space along the plane (slanted cap). Errors if the plane is behind
   * the sketch or parallel to the extrusion direction.
   */
  static extrudeUpToPlane(
    oc:   any,
    wires: any[],
    opts: { direction?: [number, number, number]; reverse?: boolean; neutralPoint?: [number, number, number] },
    planeOrigin: [number, number, number],
    planeNormal: [number, number, number],
  ): any {
    const { direction = [0, 1, 0], reverse = false, neutralPoint = [0, 0, 0] } = opts;
    const [dx, dy, dz] = OccExtrusionService.normDir(direction, reverse);
    const dir: [number, number, number] = [dx, dy, dz];

    let [nx, ny, nz] = planeNormal;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) throw new Error('Up-to-Plane: invalid plane normal.');
    nx /= nl; ny /= nl; nz /= nl;
    const dN = dx * nx + dy * ny + dz * nz;
    if (Math.abs(dN) < 1e-6) throw new Error('Up-to-Plane: the plane is parallel to the extrusion direction.');

    const scope = new WasmScope();
    try {
      // How far each point of the profile must travel along `dir` to reach the
      // plane:  t = (planeOrigin − Q)·N / (dir·N).  Sample the EDGES (not just
      // vertices — a circle wire has almost none) so the full extent is captured.
      let tMax = -Infinity, tMin = Infinity;
      const accumT = (px: number, py: number, pz: number) => {
        const t = ((planeOrigin[0] - px) * nx + (planeOrigin[1] - py) * ny + (planeOrigin[2] - pz) * nz) / dN;
        tMax = Math.max(tMax, t); tMin = Math.min(tMin, t);
      };
      for (const wire of wires) {
        const eexp = scope.keep(new oc.TopExp_Explorer_2(
          wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
        ));
        while (eexp.More()) {
          const es = new WasmScope();
          try {
            const edge  = oc.TopoDS.Edge_1(eexp.Current());
            const curve = es.keep(new oc.BRepAdaptor_Curve_2(edge));
            const u0 = curve.FirstParameter(), u1 = curve.LastParameter();
            if (isFinite(u0) && isFinite(u1) && u1 > u0) {
              const S = 24;
              for (let j = 0; j <= S; j++) {
                const p = curve.Value(u0 + (u1 - u0) * (j / S));
                accumT(p.X(), p.Y(), p.Z());
                p.delete();
              }
            }
          } catch { /* skip unsamplable edge */ } finally { es.free(); }
          eexp.Next();
        }
      }
      if (!isFinite(tMax) || tMax <= 1e-6) throw new Error('Up-to-Plane: the plane is not ahead of the sketch on the extrusion side.');

      // Profile basis = faces-with-holes from every coplanar wire (nested profiles).
      const basis = OccExtrusionService.buildProfileShape(oc, wires, scope);

      // Plane ⟂ extrusion axis → uniform distance, exact blind extrude.
      if (Math.abs(dN) > 0.999) {
        const vec = scope.keep(new oc.gp_Vec_4(dx * tMax, dy * tMax, dz * tMax));
        const pr  = scope.keep(new oc.BRepPrimAPI_MakePrism_1(basis, vec, false, true));
        if (!pr.IsDone()) throw new Error('Up-to-Plane: extrude failed.');
        return pr.Shape();
      }

      // Tilted plane → over-extrude then trim at the plane with a half-space.
      const over = tMax + 1;
      const vec   = scope.keep(new oc.gp_Vec_4(dx * over, dy * over, dz * over));
      const prism = scope.keep(new oc.BRepPrimAPI_MakePrism_1(basis, vec, false, true));
      if (!prism.IsDone()) throw new Error('Up-to-Plane: over-extrude failed.');
      const overShape = prism.Shape();

      // Bounded planar face (large enough to span the prism's footprint on the plane).
      const span = (over + Math.abs(Math.min(tMin, 0))) * 2 + 100;
      const pnt  = scope.keep(new oc.gp_Pnt_3(planeOrigin[0], planeOrigin[1], planeOrigin[2]));
      const ndir = scope.keep(new oc.gp_Dir_4(nx, ny, nz));
      const pln  = scope.keep(new oc.gp_Pln_3(pnt, ndir));
      const fmk  = scope.keep(new oc.BRepBuilderAPI_MakeFace_9(pln, -span, span, -span, span));
      if (!fmk.IsDone()) throw new Error('Up-to-Plane: plane face build failed.');
      const planeFace = fmk.Face();

      const sBase = dN >= 0 ? -1 : 1;        // base side = opposite the travel direction
      for (const s of [sBase, -sBase]) {
        const s2 = new WasmScope();
        try {
          const ref = s2.keep(new oc.gp_Pnt_3(planeOrigin[0] + nx * s * 0.5, planeOrigin[1] + ny * s * 0.5, planeOrigin[2] + nz * s * 0.5));
          const hs  = s2.keep(new oc.BRepPrimAPI_MakeHalfSpace_1(planeFace, ref));
          const cut = s2.keep(new oc.BRepAlgoAPI_Cut_3(overShape, hs.Solid(), new oc.Message_ProgressRange_1()));
          cut.Build(new oc.Message_ProgressRange_1());
          if (cut.IsDone()) {
            const base = OccExtrusionService.pickBaseSolid(oc, cut.Shape(), neutralPoint, dir, over);
            if (base) return base;
          }
        } catch { /* try the other side */ } finally { s2.free(); }
      }
      throw new Error('Up-to-Plane: the profile does not reach the plane.');
    } finally {
      scope.free();
    }
  }

  /** Index (1-based, into `faceMap`) of the face whose surface lies closest to
   *  `point` — i.e. the face the user clicked. Returns -1 if none measurable. */
  private static nearestFaceIndex(
    oc: any, faceMap: any, point: [number, number, number],
  ): number {
    const vScope = new WasmScope();
    let best = -1, bestD = Infinity;
    try {
      const pnt = vScope.keep(new oc.gp_Pnt_3(point[0], point[1], point[2]));
      const vtx = vScope.keep(new oc.BRepBuilderAPI_MakeVertex(pnt)).Vertex();
      const count = faceMap.Extent();
      for (let i = 1; i <= count; i++) {
        const s = new WasmScope();
        try {
          const face = oc.TopoDS.Face_1(faceMap.FindKey(i));
          const dss  = s.keep(new oc.BRepExtrema_DistShapeShape_1());
          dss.LoadS1(vtx); dss.LoadS2(face);
          dss.Perform(new oc.Message_ProgressRange_1());
          if (dss.IsDone()) {
            const d = dss.Value();
            if (d < bestD) { bestD = d; best = i; }
          }
        } catch { /* skip unmeasurable face */ } finally { s.free(); }
      }
    } finally { vScope.free(); }
    return best;
  }

  /** Geometric unit normal of a planar face, or null if the face isn't planar. */
  private static planarFaceNormal(oc: any, face: any): [number, number, number] | null {
    const scope = new WasmScope();
    try {
      const surfH = scope.keep(oc.BRep_Tool.Surface_2(face));
      if (surfH.IsNull()) return null;
      const adaptor = scope.keep(new oc.GeomAdaptor_Surface_2(surfH));
      if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
      const pln  = scope.keep(adaptor.Plane());
      const ax   = scope.keep(pln.Axis());
      const dir  = scope.keep(ax.Direction());
      return [dir.X(), dir.Y(), dir.Z()];
    } catch {
      return null;
    } finally {
      scope.free();
    }
  }

  /** Unit surface normal of `face` at (the projection of) `point` — works for any
   *  surface type (plane, cylinder, sphere, cone, …). Null if the projection or
   *  the normal is undefined. */
  private static surfaceNormalAt(
    oc: any, face: any, point: [number, number, number],
  ): [number, number, number] | null {
    const scope = new WasmScope();
    try {
      const surfH = scope.keep(oc.BRep_Tool.Surface_2(face));
      if (surfH.IsNull()) return null;
      const p     = scope.keep(new oc.gp_Pnt_3(point[0], point[1], point[2]));
      const sas   = scope.keep(new oc.ShapeAnalysis_Surface(surfH));
      const uv    = scope.keep(sas.ValueOfUV(p, 1e-6));                 // gp_Pnt2d (U,V)
      const props = scope.keep(new oc.GeomLProp_SLProps_1(surfH, uv.X(), uv.Y(), 1, 1e-6));
      if (!props.IsNormalDefined()) return null;
      const n = scope.keep(props.Normal());                            // gp_Dir
      return [n.X(), n.Y(), n.Z()];
    } catch {
      return null;
    } finally {
      scope.free();
    }
  }

  /**
   * Extrude several coplanar closed profiles, automatically resolving NESTED
   * profiles into faces-with-holes (ProfileNesting). A circle inside a rectangle
   * becomes one block WITH A HOLE; four circles → four holes; a profile nested
   * inside a hole becomes a solid island again — all by even/odd containment
   * depth, to any level. Disjoint outer regions (e.g. two separate rectangles)
   * are grouped into one compound so the whole sketch is a single feature.
   */
  static extrudeProfiles(oc: any, wires: any[], opts: ExtrudeOptions): any {
    if (!wires.length) throw new Error('Multi-extrude: no profiles.');

    const faceScope = new WasmScope();
    try {
      const faces = buildNestedFaces(oc, wires, faceScope);
      if (!faces.length) {
        throw new Error('Extrusion: no closed planar profile found in the sketch.');
      }
      if (faces.length === 1) return OccExtrusionService.extrudeFromFace(oc, faces[0], opts);

      const builder  = new oc.BRep_Builder();
      const compound = new oc.TopoDS_Compound();   // returned → not freed here
      builder.MakeCompound(compound);
      for (const f of faces) {
        const solid = OccExtrusionService.extrudeFromFace(oc, f, opts);
        builder.Add(compound, solid);
      }
      return compound;
    } finally {
      faceScope.free();
    }
  }

  /**
   * Extrude only the profiles the user PICKED (Profile picker). Every wire is
   * classified into its minimal region (`classifyAllRegions`); only the regions
   * whose OUTER wire id is in `selectedOuterIds` are prismed (each as its own
   * face-with-holes), then compounded. This is region-precise: picking the ring
   * extrudes the ring, picking the inner disk extrudes the disk, picking both
   * extrudes the two adjacent solids — no even/odd guesswork.
   *
   * `wireIds[i]` must name the source wire of `wires[i]` (same order); the
   * selection refers to those ids so it survives save/reload and re-edit.
   */
  static extrudeSelectedRegions(
    oc: any, wires: any[], wireIds: string[], selectedOuterIds: string[], opts: ExtrudeOptions,
  ): any {
    if (!wires.length) throw new Error('Multi-extrude: no profiles.');
    const sel = new Set(selectedOuterIds);

    const faceScope = new WasmScope();
    try {
      const faces = classifyAllRegions(oc, wires, faceScope)
        .filter((r) => sel.has(wireIds[r.outerIndex]))
        .map((r) => r.outer);
      if (!faces.length) throw new Error('Extrusion: none of the selected profiles resolved to a region.');
      if (faces.length === 1) return OccExtrusionService.extrudeFromFace(oc, faces[0], opts);

      const builder  = new oc.BRep_Builder();
      const compound = new oc.TopoDS_Compound();   // returned → not freed here
      builder.MakeCompound(compound);
      for (const f of faces) builder.Add(compound, OccExtrusionService.extrudeFromFace(oc, f, opts));
      return compound;
    } finally {
      faceScope.free();
    }
  }

  /**
   * Basis shape for the up-to-* sweeps: the sketch's coplanar profile wires
   * resolved to faces WITH HOLES (ProfileNesting). One nested profile → that
   * face; several disjoint outers → a compound of faces (each prisms / trims
   * independently). The faces are allocated in `scope` (freed by the caller).
   */
  private static buildProfileShape(oc: any, wires: any[], scope: WasmScope): any {
    const faces = buildNestedFaces(oc, wires, scope);
    if (!faces.length) throw new Error('Up-to: no closed planar profile in the sketch.');
    if (faces.length === 1) return faces[0];
    const builder  = scope.keep(new oc.BRep_Builder());
    const compound = scope.keep(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    for (const f of faces) builder.Add(compound, f);
    return compound;
  }

  /** Normalised, optionally-reversed extrusion axis. */
  private static normDir(direction: [number, number, number], reverse: boolean): [number, number, number] {
    let [dx, dy, dz] = direction;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) throw new Error('Extrusion direction is zero-length');
    dx /= len; dy /= len; dz /= len;
    return reverse ? [-dx, -dy, -dz] : [dx, dy, dz];
  }

  /**
   * Extrude up to the NEAREST body in the path (CATIA "Up to Next"). Over-
   * extrudes past every body, cuts them all out, and keeps the piece touching
   * the sketch plane — so it stops at the first surface encountered.
   */
  static extrudeUpToNext(
    oc:   any,
    wires: any[],
    opts: { direction?: [number, number, number]; reverse?: boolean; neutralPoint?: [number, number, number] },
    bodies: any[],
  ): any {
    const { direction = [0, 1, 0], reverse = false, neutralPoint = [0, 0, 0] } = opts;
    const [dx, dy, dz] = OccExtrusionService.normDir(direction, reverse);
    const dir: [number, number, number] = [dx, dy, dz];
    let over = 0;
    for (const b of bodies) over = Math.max(over, OccExtrusionService.projRange(oc, b, neutralPoint, dir).max);
    if (over <= 1e-6) throw new Error('Up-to-Next: no body ahead of the sketch plane.');
    over += 10;

    const scope = new WasmScope();
    try {
      const basis = OccExtrusionService.buildProfileShape(oc, wires, scope);  // faces-with-holes
      const vec   = scope.keep(new oc.gp_Vec_4(dx * over, dy * over, dz * over));
      const prism = scope.keep(new oc.BRepPrimAPI_MakePrism_1(basis, vec, false, true));
      if (!prism.IsDone()) throw new Error('Up-to-Next: over-extrude failed.');

      let cur = prism.Shape();
      for (const b of bodies) {
        const cut = scope.keep(new oc.BRepAlgoAPI_Cut_3(cur, b, new oc.Message_ProgressRange_1()));
        cut.Build(new oc.Message_ProgressRange_1());
        if (cut.IsDone()) cur = cut.Shape();
      }
      return OccExtrusionService.keepBaseSolid(oc, cur, neutralPoint, dir, over);
    } finally {
      scope.free();
    }
  }

  /**
   * Extrude up to the FURTHEST surface in the path (CATIA "Up to Last").
   * Intersects an over-extrude with every body (BRepAlgoAPI_Common) to find the
   * furthest exit, then blind-extrudes to that distance — filling gaps along the
   * way.
   */
  static extrudeUpToLast(
    oc:   any,
    wires: any[],
    opts: { direction?: [number, number, number]; reverse?: boolean; neutralPoint?: [number, number, number] },
    bodies: any[],
  ): any {
    const { direction = [0, 1, 0], reverse = false, neutralPoint = [0, 0, 0] } = opts;
    const [dx, dy, dz] = OccExtrusionService.normDir(direction, reverse);
    const dir: [number, number, number] = [dx, dy, dz];
    let over = 0;
    for (const b of bodies) over = Math.max(over, OccExtrusionService.projRange(oc, b, neutralPoint, dir).max);
    if (over <= 1e-6) throw new Error('Up-to-Last: no body ahead of the sketch plane.');
    over += 10;

    const scope = new WasmScope();
    try {
      const basis = OccExtrusionService.buildProfileShape(oc, wires, scope);  // faces-with-holes
      const vec   = scope.keep(new oc.gp_Vec_4(dx * over, dy * over, dz * over));
      const prism = scope.keep(new oc.BRepPrimAPI_MakePrism_1(basis, vec, false, true));
      if (!prism.IsDone()) throw new Error('Up-to-Last: over-extrude failed.');
      const overShape = prism.Shape();

      // Furthest exit projection across the bodies the prism actually intersects.
      let farMost = -Infinity;
      for (const b of bodies) {
        const common = scope.keep(new oc.BRepAlgoAPI_Common_3(overShape, b, new oc.Message_ProgressRange_1()));
        common.Build(new oc.Message_ProgressRange_1());
        if (!common.IsDone()) continue;
        const cs = common.Shape();
        const probe = new oc.TopExp_Explorer_2(cs, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        const hasSolid = probe.More(); probe.delete();
        if (!hasSolid) continue;
        farMost = Math.max(farMost, OccExtrusionService.projRange(oc, cs, neutralPoint, dir).max);
      }
      if (farMost <= 1e-6) throw new Error('Up-to-Last: the profile does not reach any body.');

      const vec2 = scope.keep(new oc.gp_Vec_4(dx * farMost, dy * farMost, dz * farMost));
      const out  = scope.keep(new oc.BRepPrimAPI_MakePrism_1(basis, vec2, false, true));
      if (!out.IsDone()) throw new Error('Up-to-Last: final extrude failed.');
      return out.Shape();
    } finally {
      scope.free();
    }
  }

  /** From a (possibly multi-solid) cut result, return the solid touching the
   *  sketch plane (min |projection| ≈ 0), or null if none qualifies / it spans
   *  the full over-extrude (the profile never reached the trim surface). */
  private static pickBaseSolid(
    oc: any, shape: any, base: [number, number, number], dir: [number, number, number], over: number,
  ): any | null {
    let best: any = null, bestKey = Infinity, bestMax = 0;
    const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (exp.More()) {
      const sol = oc.TopoDS.Solid_1(exp.Current());
      const pr  = OccExtrusionService.projRange(oc, sol, base, dir);
      const key = Math.abs(pr.min);
      if (key < bestKey) { bestKey = key; best = sol; bestMax = pr.max; }
      exp.Next();
    }
    exp.delete();
    if (!best || bestMax >= over - 1e-3) return null;
    return best;
  }

  /** Like pickBaseSolid but throws when nothing qualifies. Shared by the
   *  whole-body Up-to-Face fallback / Up-to-Next. */
  private static keepBaseSolid(
    oc: any, shape: any, base: [number, number, number], dir: [number, number, number], over: number,
  ): any {
    const sol = OccExtrusionService.pickBaseSolid(oc, shape, base, dir, over);
    if (!sol) throw new Error('Up-to: the profile does not reach the target.');
    return sol;
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
