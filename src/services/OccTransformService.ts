// ============================================================
// ToubkalCAD – OccTransformService.ts
//
// Track T — Mirror (T1) + Linear/Circular patterns (T2).
//
// Mirror:   gp_Trsf.SetMirror(gp_Ax2) + BRepBuilderAPI_Transform (copy).
// Patterns: a single TopoDS_Compound assembled with BRep_Builder — NOT a
//           loop of boolean fuses (which is O(N²) on topology). Each instance
//           is a copied transform of the source; the compound just groups
//           them, so creation is effectively instant.
//
// Memory: every intermediate (gp_*, builders) is freed via WasmScope. The
// returned shape (mirrored copy / compound) is owned by the caller and must
// be registered in CADGeometryRegistry — it is NOT freed here. TopoDS_Shape
// is a ref-counted handle, so freeing the builder after grabbing .Shape()
// is safe (same pattern as OccBooleanService).
// ============================================================

import * as THREE from 'three';
import { WasmScope } from '../utils/WasmScope';

export type PlaneLabel = 'XY' | 'YZ' | 'ZX';

export interface NodePlacement {
  position: [number, number, number];
  rotation: [number, number, number];   // euler radians (THREE 'XYZ')
  scale:    [number, number, number];
}

const isIdentityPlacement = (t: NodePlacement) =>
  t.position.every((v) => v === 0) &&
  t.rotation.every((v) => v === 0) &&
  t.scale.every((v) => v === 1);

/** Outward normal of each standard mirror plane (through the origin). */
const PLANE_NORMAL: Record<PlaneLabel, [number, number, number]> = {
  XY: [0, 0, 1],
  YZ: [1, 0, 0],
  ZX: [0, 1, 0],
};

export class OccTransformService {
  /**
   * Bake a node's Three.js placement (position/rotation/scale) into a COPY of
   * its OCC shape, so downstream operations act on the geometry where the user
   * actually sees it — not at the registry's original origin pose.
   *
   * The matrix is composed with THREE then pushed to gp_Trsf.SetValues. A
   * non-uniform scale makes the matrix non-orthogonal (gp_Trsf rejects it), so
   * we fall back to a rigid placement (scale forced to 1) in that case.
   */
  static placeShape(oc: any, shape: any, t: NodePlacement): any {
    if (isIdentityPlacement(t)) return shape;

    const pos  = new THREE.Vector3(t.position[0], t.position[1], t.position[2]);
    const quat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'XYZ'),
    );
    const m = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]));

    const scope = new WasmScope();
    try {
      const trsf = scope.keep(new oc.gp_Trsf_1());
      const setFrom = (e: THREE.Matrix4Tuple) =>
        trsf.SetValues(e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]);
      try {
        setFrom(m.elements);
      } catch {
        // Non-uniform scale → not a valid rigid+uniform transform; drop scale.
        m.compose(pos, quat, new THREE.Vector3(1, 1, 1));
        setFrom(m.elements);
      }
      const xf = scope.keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
      if (!xf.IsDone()) return shape;
      return xf.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * Mirror a shape across a standard plane through the origin.
   * Returns a mirrored COPY (the source is untouched).
   */
  static mirror(oc: any, shape: any, plane: PlaneLabel): any {
    const scope = new WasmScope();
    try {
      const [nx, ny, nz] = PLANE_NORMAL[plane];
      const origin = scope.keep(new oc.gp_Pnt_3(0, 0, 0));
      const normal = scope.keep(new oc.gp_Dir_4(nx, ny, nz));
      const ax2    = scope.keep(new oc.gp_Ax2_3(origin, normal));
      const trsf   = scope.keep(new oc.gp_Trsf_1());
      trsf.SetMirror_3(ax2);

      const xf = scope.keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
      if (!xf.IsDone()) throw new Error('Mirror transform failed.');
      return xf.Shape();
    } finally {
      scope.free();
    }
  }

  /**
   * Linear pattern: the `count - 1` COPIES of `shape`, spaced `spacing` apart
   * along `dir` (the source body is left in place by the caller, so the scene
   * shows `count` instances total). Returning copies-only — rather than a
   * compound that also contains the seed — keeps the source node independent:
   * deleting the pattern never strands the original. Returns a TopoDS_Compound.
   */
  static linearPattern(
    oc: any, shape: any,
    dir: [number, number, number], spacing: number, count: number,
  ): any {
    if (count < 2) throw new Error('Linear pattern needs a count of at least 2.');
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len < 1e-9) throw new Error('Pattern direction must be non-zero.');
    const ux = dir[0] / len, uy = dir[1] / len, uz = dir[2] / len;

    const scope   = new WasmScope();
    const builder = scope.keep(new oc.BRep_Builder());
    const compound = new oc.TopoDS_Compound();           // returned → not freed
    try {
      builder.MakeCompound(compound);
      for (let i = 1; i < count; i++) {
        const d   = spacing * i;
        const vec = scope.keep(new oc.gp_Vec_4(ux * d, uy * d, uz * d));
        const trsf = scope.keep(new oc.gp_Trsf_1());
        trsf.SetTranslation_1(vec);
        const xf = scope.keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
        if (xf.IsDone()) builder.Add(compound, scope.keep(xf.Shape()));
      }
      return compound;
    } catch (e) {
      compound.delete();
      throw e;
    } finally {
      scope.free();
    }
  }

  /**
   * Circular pattern: the `count - 1` COPIES of `shape`, each rotated by
   * `angleStepDeg` about the axis (origin + dir). Copies-only (see
   * linearPattern) — the source body stays independent. Returns a TopoDS_Compound.
   */
  static circularPattern(
    oc: any, shape: any,
    axisOrigin: [number, number, number],
    axisDir: [number, number, number],
    angleStepDeg: number, count: number,
  ): any {
    if (count < 2) throw new Error('Circular pattern needs a count of at least 2.');
    const len = Math.hypot(axisDir[0], axisDir[1], axisDir[2]);
    if (len < 1e-9) throw new Error('Pattern axis must be non-zero.');

    const scope   = new WasmScope();
    const builder = scope.keep(new oc.BRep_Builder());
    const compound = new oc.TopoDS_Compound();           // returned → not freed
    try {
      builder.MakeCompound(compound);

      const pnt = scope.keep(new oc.gp_Pnt_3(axisOrigin[0], axisOrigin[1], axisOrigin[2]));
      const dir = scope.keep(new oc.gp_Dir_4(axisDir[0] / len, axisDir[1] / len, axisDir[2] / len));
      const ax1 = scope.keep(new oc.gp_Ax1_2(pnt, dir));

      for (let i = 1; i < count; i++) {
        const ang  = (angleStepDeg * i * Math.PI) / 180;
        const trsf = scope.keep(new oc.gp_Trsf_1());
        trsf.SetRotation_1(ax1, ang);
        const xf = scope.keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
        if (xf.IsDone()) builder.Add(compound, scope.keep(xf.Shape()));
      }
      return compound;
    } catch (e) {
      compound.delete();
      throw e;
    } finally {
      scope.free();
    }
  }
}
