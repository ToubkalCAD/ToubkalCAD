// ============================================================
// ToubkalCAD – OccAxisService.ts
//
// Extracts each CYLINDRICAL face of a solid as:
//   • a world-space triangle soup (for a transparent pickable overlay mesh)
//   • its axis (a point on the axis + unit direction) and radius
//
// Used by the Concentric assembly constraint (peg-in-hole): align the axes of
// two cylindrical faces. Mirrors OccFaceService's plane test/triangulation, but
// keeps GeomAbs_Cylinder faces and reads the axis from gp_Cylinder.
// Extract from a PLACED shape so the axis/soup are in world space.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export interface CylFace {
  index:     number;
  positions: number[];                     // flat [x,y,z, …] triangle soup (world)
  axisPoint: [number, number, number];     // a point on the axis (world)
  axisDir:   [number, number, number];     // unit axis direction (world)
  radius:    number;
}

export class OccAxisService {
  static extractCylindricalFaces(oc: any, shape: any, deflection = 0.1): CylFace[] {
    const out: CylFace[] = [];

    const incMesh = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, false);
    if (typeof incMesh.Perform === 'function') incMesh.Perform(new oc.Message_ProgressRange_1());

    const faceMap = new oc.TopTools_IndexedMapOfShape_1();
    const exp = new oc.TopExp_Explorer_2(
      shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (exp.More()) { faceMap.Add(exp.Current()); exp.Next(); }
    exp.delete();

    try {
      const count = faceMap.Extent();
      for (let i = 1; i <= count; i++) {
        const scope = new WasmScope();
        try {
          const face = oc.TopoDS.Face_1(faceMap.FindKey(i));
          const surfH = scope.keep(oc.BRep_Tool.Surface_2(face));
          if (surfH.IsNull()) continue;
          const adaptor = scope.keep(new oc.GeomAdaptor_Surface_2(surfH));
          if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) continue;

          const cyl  = scope.keep(adaptor.Cylinder());
          const ax   = scope.keep(cyl.Axis());
          const loc  = scope.keep(ax.Location());
          const dir  = scope.keep(ax.Direction());
          const axisPoint: [number,number,number] = [loc.X(), loc.Y(), loc.Z()];
          const axisDir:   [number,number,number] = [dir.X(), dir.Y(), dir.Z()];
          const radius = cyl.Radius();

          // Triangulation → world soup (location baked since shape is placed).
          const location = scope.keep(new oc.TopLoc_Location_1());
          const polyH    = oc.BRep_Tool.Triangulation(face, location, 0);
          if (polyH.IsNull()) continue;
          const poly  = polyH.get();
          const trsf  = scope.keep(location.Transformation());
          const isId  = location.IsIdentity();
          const nbT   = poly.NbTriangles();

          const positions: number[] = [];
          for (let t = 1; t <= nbT; t++) {
            const tri = poly.Triangle(t);
            const a = tri.Value(1), b = tri.Value(2), c = tri.Value(3);
            tri.delete();
            for (const idx of [a, b, c]) {
              const node = poly.Node(idx);
              let px = node.X(), py = node.Y(), pz = node.Z();
              if (!isId) { const p = node.Transformed(trsf); px = p.X(); py = p.Y(); pz = p.Z(); p.delete(); }
              node.delete();
              positions.push(px, py, pz);
            }
          }
          if (positions.length < 9) continue;

          out.push({ index: i - 1, positions, axisPoint, axisDir, radius });
        } catch {
          /* skip unusable faces */
        } finally {
          scope.free();
        }
      }
    } finally {
      faceMap.delete();
      incMesh.delete();
    }
    return out;
  }
}
