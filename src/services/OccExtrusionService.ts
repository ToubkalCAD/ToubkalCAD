// ============================================================
// ToubkalCAD – OccExtrusionService.ts
// Wire (3D, on any plane) → Face → Solid via BRepPrimAPI_MakePrism.
// Extrusion direction = workplane normal (retrieved from node params).
// ============================================================

export class OccExtrusionService {
  /**
   * Extrude a closed planar 3D wire into a solid.
   * @param direction  Unit normal of the sketch plane (extrusion axis).
   *                   Defaults to [0,1,0] (Y-up) for backwards compat.
   */
  static extrudeWireToSolid(
    oc:        any,
    wire:      any,
    height:    number,
    direction: [number, number, number] = [0, 1, 0],
  ): any {
    if (height <= 0) throw new Error('Extrusion height must be > 0');

    // Build face from closed planar wire
    const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      throw new Error('Extrusion: face creation failed — wire must be closed and planar. ' +
        'Only Circle, Rectangle, Ellipse, Polygon and Rounded-Rectangle can be extruded.');
    }
    const face = faceMaker.Shape();

    // Extrusion vector = direction * height
    const [dx, dy, dz] = direction;
    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (len < 1e-10) throw new Error('Extrusion direction is zero-length');
    const vec   = new oc.gp_Vec_4((dx/len)*height, (dy/len)*height, (dz/len)*height);
    const prism = new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true);

    if (!prism.IsDone()) {
      faceMaker.delete(); vec.delete(); prism.delete();
      throw new Error('Extrusion: prism computation failed');
    }
    const solid = prism.Shape();
    faceMaker.delete(); vec.delete(); prism.delete();
    return solid;
  }

  /** Backwards-compat alias used by CADToolbar. */
  static extrudeWire(
    oc:        any,
    wire:      any,
    distance:  number,
    direction: [number, number, number] = [0, 1, 0],
  ): any {
    return OccExtrusionService.extrudeWireToSolid(oc, wire, distance, direction);
  }
}
