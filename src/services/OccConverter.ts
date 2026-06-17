import * as THREE from 'three';

/**
 * ToubkalCAD – OccConverter  (opencascade.js@beta / OCC 7.8 API)
 *
 * Produces an INDEXED BufferGeometry with real surface normals and one draw
 * group per OCC face. Three properties that the old per-triangle flattener
 * could not give:
 *
 *   1. Smooth shading on curved faces (cylinders/spheres/fillets) — normals
 *      come from OCC (`Poly_Triangulation.Normal`), not from averaging raw
 *      triangle facets.
 *   2. Crisp hard edges at face boundaries — each face keeps its OWN index
 *      range (vertices are shared only *within* a face, never across faces),
 *      so a cylinder's side stays smooth while its top rim stays sharp. A
 *      globally-merged mesh + computeVertexNormals would wrongly smooth the rim.
 *   3. Face picking — `geometry.userData.faceGroups` maps each draw group to
 *      the 0-based index of its `TopoDS_Face` in the shape's `TopExp_Explorer`
 *      face order, so a raycast hit can be resolved back to a native face by
 *      re-exploring the shape (no WASM handles are retained here).
 *
 * Call chain (verified against opencascade.full.d.ts):
 *   BRep_Tool.Triangulation(face, loc, 0)   → Handle_Poly_Triangulation
 *   handle.get()                             → Poly_Triangulation   ← dereference
 *   poly.ComputeNormals()                    → fills per-node normals if absent
 *   poly.Node(i) / .Normal_1(i)              → gp_Pnt / gp_Dir      (need .delete())
 *   poly.Triangle(i).Value(1..3)             → 1-based node indices
 *   location.Transformation()                → gp_Trsf              (needs .delete())
 *
 * Node/normal indices in a Poly_Triangulation are 1-based.
 */

export interface OccFaceGroup {
  /** Start offset into the index buffer (in index entries, = triangle*3). */
  start: number;
  /** Number of index entries this face contributes. */
  count: number;
  /** 0-based position of this face in the shape's TopExp_Explorer face order. */
  face: number;
}

export class OccConverter {
  static shapeToThreeGeometry(
    oc: any,
    shape: any,
    deflection = 0.1,
  ): THREE.BufferGeometry {
    // ── Triangulate ──────────────────────────────────────────────────────────
    // Scale the chord deflection to the shape's overall size so large CURVED
    // solids (e.g. a full 360° revolve of a profile far from its axis) don't get
    // an absurdly fine — and very slow — mesh. The passed `deflection` stays a
    // FLOOR, so small parts keep their fine absolute tolerance and planar shapes
    // (extrudes) are unaffected (few triangles at any deflection). Measured: a
    // r≈30 revolve drops ~4.3 s → ~0.8 s of tessellation (scripts/test-revolve-perf).
    let effDefl = deflection;
    try {
      const bb = new oc.Bnd_Box_1();
      oc.BRepBndLib.Add(shape, bb, false);
      if (!bb.IsVoid()) {
        const lo = bb.CornerMin(), hi = bb.CornerMax();
        const diag = Math.hypot(hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z());
        lo.delete(); hi.delete();
        effDefl = Math.max(deflection, diag * 0.008);   // ≈0.8 % chord error, size-relative
      }
      bb.delete();
    } catch { /* bbox unavailable → fall back to the passed absolute deflection */ }

    const incMesh = new oc.BRepMesh_IncrementalMesh_2(shape, effDefl, false, 0.5, false);
    if (typeof incMesh.Perform === 'function') {
      incMesh.Perform(new oc.Message_ProgressRange_1());
    }

    const positions: number[]      = [];
    const normals:   number[]      = [];
    const indices:   number[]      = [];
    const faceGroups: OccFaceGroup[] = [];
    let   normalsMissing = false;   // any face lacked OCC normals → recompute all

    const exp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );

    let faceIndex = 0;   // explorer position, counts EVERY face (even untriangulated)
    while (exp.More()) {
      const face     = oc.TopoDS.Face_1(exp.Current());
      const location = new oc.TopLoc_Location_1();
      const polyHandle = oc.BRep_Tool.Triangulation(face, location, 0);

      if (!polyHandle.IsNull()) {
        const poly     = polyHandle.get();          // Poly_Triangulation (raw ptr)
        const trsf     = location.Transformation(); // gp_Trsf (by value)
        const isId     = location.IsIdentity();
        const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;

        // OCC computes smooth per-node normals from the surface; only if absent.
        if (!poly.HasNormals()) poly.ComputeNormals();
        const hasNormals = poly.HasNormals();
        if (!hasNormals) normalsMissing = true;

        const nbNodes    = poly.NbNodes();
        const nbT        = poly.NbTriangles();
        const base       = positions.length / 3;    // index offset for this face's nodes
        const groupStart = indices.length;

        // ── Nodes: positions + normals (1-based) ──────────────────────────────
        for (let i = 1; i <= nbNodes; i++) {
          const node = poly.Node(i);
          if (isId) {
            positions.push(node.X(), node.Y(), node.Z());
            node.delete();
          } else {
            const pt = node.Transformed(trsf);
            node.delete();
            positions.push(pt.X(), pt.Y(), pt.Z());
            pt.delete();
          }

          if (hasNormals) {
            const dir = poly.Normal_1(i);             // gp_Dir (by value)
            let nx: number, ny: number, nz: number;
            if (isId) {
              nx = dir.X(); ny = dir.Y(); nz = dir.Z();
              dir.delete();
            } else {
              const td = dir.Transformed(trsf);       // rotate normal into world
              dir.delete();
              nx = td.X(); ny = td.Y(); nz = td.Z();
              td.delete();
            }
            // A REVERSED face's outward normal is the negated surface normal.
            if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
            normals.push(nx, ny, nz);
          } else {
            normals.push(0, 0, 0);                    // placeholder; recomputed below
          }
        }

        // ── Triangles: index entries (1-based node refs) ──────────────────────
        for (let i = 1; i <= nbT; i++) {
          const tri = poly.Triangle(i);
          let a = tri.Value(1), b = tri.Value(2), c = tri.Value(3);
          tri.delete();
          if (reversed) { const t = a; a = b; b = t; }  // keep CCW winding
          indices.push(base + a - 1, base + b - 1, base + c - 1);
        }

        faceGroups.push({ start: groupStart, count: indices.length - groupStart, face: faceIndex });
        trsf.delete();
      }

      location.delete();
      faceIndex++;
      exp.Next();
    }

    exp.delete();
    incMesh.delete();

    const geo = new THREE.BufferGeometry();
    if (positions.length === 0) return geo;

    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
    geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));

    // Per-face draw groups + the face-order map for picking (single material slot 0).
    for (const g of faceGroups) geo.addGroup(g.start, g.count, 0);
    geo.userData.faceGroups = faceGroups;
    geo.userData.faceCount  = faceIndex;

    // Rare fallback: some face had no OCC normals. Recomputing on THIS indexed
    // geometry is still boundary-correct because no vertex is shared across faces.
    if (normalsMissing) geo.computeVertexNormals();

    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}
