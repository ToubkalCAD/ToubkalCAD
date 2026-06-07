// ============================================================
// ToubkalCAD – OccFaceService.ts
//
// Track S2 — "sketch on a face". Extracts each PLANAR face of a solid as:
//   • a world-space triangle soup (for a transparent pickable overlay mesh)
//   • a derived workplane (origin = face centroid, axes from the face's gp_Pln)
//
// Non-planar faces (cylinders, spheres, …) are skipped — you can only start a
// flat sketch on a flat face. Triangulation/dereference follows the exact call
// chain documented in OccConverter (OCC 7.7+ API).
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export interface PlanarFace {
  index:     number;                       // stable map order index
  positions: number[];                     // flat [x,y,z, …] triangle soup (world)
  origin:    [number, number, number];     // face centroid (on the plane)
  normal:    [number, number, number];     // outward unit normal (orientation-aware)
  uAxis:     [number, number, number];     // plane local X (unit)
  vAxis:     [number, number, number];     // plane local Y (unit)
}

export class OccFaceService {
  /** Canonical de-duplicated indexed map of all faces. Caller must `.delete()`. */
  static buildFaceMap(oc: any, shape: any): any {
    const faceMap = new oc.TopTools_IndexedMapOfShape_1();
    const exp = new oc.TopExp_Explorer_2(
      shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (exp.More()) { faceMap.Add(exp.Current()); exp.Next(); }
    exp.delete();
    return faceMap;
  }

  /** All planar faces of `shape`, with triangulation + derived workplane. */
  static extractPlanarFaces(oc: any, shape: any, deflection = 0.1): PlanarFace[] {
    const out: PlanarFace[] = [];

    // Tessellate once so BRep_Tool.Triangulation has data per face.
    const incMesh = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, false);
    if (typeof incMesh.Perform === 'function') incMesh.Perform(new oc.Message_ProgressRange_1());

    const faceMap = this.buildFaceMap(oc, shape);
    try {
      const count = faceMap.Extent();
      for (let i = 1; i <= count; i++) {
        const scope = new WasmScope();
        try {
          const face = oc.TopoDS.Face_1(faceMap.FindKey(i));

          // ── Plane test ──────────────────────────────────────────────────────
          const surfH = scope.keep(oc.BRep_Tool.Surface_2(face));
          if (surfH.IsNull()) continue;
          const adaptor = scope.keep(new oc.GeomAdaptor_Surface_2(surfH));
          if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;

          const pln    = scope.keep(adaptor.Plane());
          const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
          const nAx  = scope.keep(pln.Axis());
          const nDir = scope.keep(nAx.Direction());
          let n: [number,number,number] = [nDir.X(), nDir.Y(), nDir.Z()];
          if (reversed) n = [-n[0], -n[1], -n[2]];
          const xAx  = scope.keep(pln.XAxis());
          const yAx  = scope.keep(pln.YAxis());
          const xDir = scope.keep(xAx.Direction());
          const yDir = scope.keep(yAx.Direction());
          const uAxis: [number,number,number] = [xDir.X(), xDir.Y(), xDir.Z()];
          const vAxis: [number,number,number] = [yDir.X(), yDir.Y(), yDir.Z()];

          // ── Triangulation → world-space soup + centroid ─────────────────────
          const location = scope.keep(new oc.TopLoc_Location_1());
          const polyH    = oc.BRep_Tool.Triangulation(face, location, 0);
          if (polyH.IsNull()) continue;
          const poly  = polyH.get();
          const trsf  = scope.keep(location.Transformation());
          const isId  = location.IsIdentity();
          const nbT   = poly.NbTriangles();

          const positions: number[] = [];
          let cx = 0, cy = 0, cz = 0, nPts = 0;
          for (let t = 1; t <= nbT; t++) {
            const tri = poly.Triangle(t);
            let a = tri.Value(1), b = tri.Value(2), c = tri.Value(3);
            tri.delete();
            if (reversed) { const tmp = a; a = b; b = tmp; }
            for (const idx of [a, b, c]) {
              const node = poly.Node(idx);
              let px = node.X(), py = node.Y(), pz = node.Z();
              if (!isId) { const p = node.Transformed(trsf); px = p.X(); py = p.Y(); pz = p.Z(); p.delete(); }
              node.delete();
              positions.push(px, py, pz);
              cx += px; cy += py; cz += pz; nPts++;
            }
          }
          if (positions.length < 9 || nPts === 0) continue;

          out.push({
            index: i - 1,
            positions,
            origin: [cx / nPts, cy / nPts, cz / nPts],
            normal: n, uAxis, vAxis,
          });
        } catch {
          /* skip faces without usable surface/triangulation */
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
