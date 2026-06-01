import * as THREE from 'three';

/**
 * ToubkalCAD – OccConverter  (opencascade.js@beta / OCC 7.7+ API)
 *
 * Correct call chain (verified against opencascade.full.d.ts):
 *   BRep_Tool.Triangulation(face, loc, 0)   → Handle_Poly_Triangulation
 *   handle.IsNull()                          → boolean
 *   handle.get()                             → Poly_Triangulation   ← dereference
 *   poly.NbTriangles()                       → int
 *   poly.Triangle(i)                         → Poly_Triangle        (needs .delete())
 *   poly.Node(i)                             → gp_Pnt               (needs .delete())
 *   node.Transformed(trsf)                   → gp_Pnt               (needs .delete())
 *   location.Transformation()                → gp_Trsf              (needs .delete())
 *
 * Objects NOT deleted: face (ref into explorer), poly (raw ptr from handle.get()),
 * polyHandle (BRep still holds the ref, deleting is safe but unnecessary here).
 */
export class OccConverter {
  static shapeToThreeGeometry(
    oc: any,
    shape: any,
    deflection = 0.1,
  ): THREE.BufferGeometry {
    // ── Triangulate ──────────────────────────────────────────────────────────
    const incMesh = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, false);
    // Some OCC 7.7+ builds need an explicit Perform() call
    if (typeof incMesh.Perform === 'function') {
      incMesh.Perform(new oc.Message_ProgressRange_1());
    }

    const vertices: number[] = [];

    const exp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );

    while (exp.More()) {
      const face     = oc.TopoDS.Face_1(exp.Current());
      const location = new oc.TopLoc_Location_1();

      // Returns Handle_Poly_Triangulation — must call .get() to access the data
      const polyHandle = oc.BRep_Tool.Triangulation(face, location, 0);

      if (!polyHandle.IsNull()) {
        const poly     = polyHandle.get();          // Poly_Triangulation (raw ptr)
        const trsf     = location.Transformation(); // gp_Trsf (by value, delete when done)
        const isId     = location.IsIdentity();
        const nbT      = poly.NbTriangles();
        const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;

        for (let i = 1; i <= nbT; i++) {
          const tri = poly.Triangle(i);
          let n1 = tri.Value(1);
          let n2 = tri.Value(2);
          let n3 = tri.Value(3);
          tri.delete();

          if (reversed) { const t = n1; n1 = n2; n2 = t; }

          // Extract each of the 3 triangle vertices
          for (const n of [n1, n2, n3]) {
            const node = poly.Node(n);   // gp_Pnt by value
            if (isId) {
              // Identity transform — use raw coordinates directly
              vertices.push(node.X(), node.Y(), node.Z());
              node.delete();
            } else {
              // Non-identity — transform into world space
              const pt = node.Transformed(trsf);
              node.delete();
              vertices.push(pt.X(), pt.Y(), pt.Z());
              pt.delete();
            }
          }
        }

        trsf.delete();
      }

      location.delete();
      exp.Next();
    }

    exp.delete();
    incMesh.delete();

    if (vertices.length === 0) return new THREE.BufferGeometry();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.computeVertexNormals();
    return geo;
  }
}
