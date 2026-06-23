// ============================================================
// ToubkalCAD – OccEdgeService.ts
//
// Per-edge tooling for Phase 6 (per-edge fillet / chamfer).
//
// The whole feature hinges on ONE invariant: a stable, repeatable
// 0-based index for every edge of a shape. Both the pickable edge
// lines (this service) and the fillet/chamfer builders
// (OccFilletService) derive that index from the SAME construction:
//
//   TopExp_Explorer(EDGE)  →  TopTools_IndexedMapOfShape.Add()
//
// TopExp_Explorer visits edges in a deterministic order for a given
// shape, and IndexedMap.Add() de-duplicates shared edges while
// preserving first-seen order. As long as both call sites use this
// exact loop on the same shape, index i means the same edge.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

/** Analytic classification of an edge's underlying 3D curve. `other` covers
 *  ellipses / b-splines / etc. that aren't a single sketch primitive. */
export type EdgeCurve =
  | { type: 'line' }
  | { type: 'circle'; center: [number, number, number]; radius: number; normal: [number, number, number]; closed: boolean }
  | { type: 'other' };

export interface ExtractedEdge {
  index:  number;                          // stable 0-based edge index
  points: [number, number, number][];      // world-space polyline
  curve?: EdgeCurve;                        // analytic type (for clean projection)
}

export class OccEdgeService {
  /** Number of samples per edge for the pickable polyline. */
  static readonly EDGE_SEGMENTS = 32;

  /**
   * Build the canonical de-duplicated indexed map of all edges.
   * Caller owns the returned map and MUST call `.delete()` on it.
   */
  static buildEdgeMap(oc: any, shape: any): any {
    const edgeMap = new oc.TopTools_IndexedMapOfShape_1();
    const exp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (exp.More()) {
      edgeMap.Add(exp.Current()); // Add() de-duplicates by shape identity
      exp.Next();
    }
    exp.delete();
    return edgeMap;
  }

  /**
   * Discretise every edge of a shape into a world-space polyline.
   * Degenerate edges (e.g. cone apex seams) are skipped silently.
   */
  static extractEdges(oc: any, shape: any): ExtractedEdge[] {
    const result: ExtractedEdge[] = [];
    const edgeMap = this.buildEdgeMap(oc, shape);
    try {
      const count = edgeMap.Extent();
      for (let i = 1; i <= count; i++) {
        const scope = new WasmScope();
        try {
          const edge  = oc.TopoDS.Edge_1(edgeMap.FindKey(i));
          const curve = scope.keep(new oc.BRepAdaptor_Curve_2(edge));
          const u0    = curve.FirstParameter();
          const u1    = curve.LastParameter();
          if (!isFinite(u0) || !isFinite(u1) || u1 <= u0) continue;

          const segs = this.EDGE_SEGMENTS;
          const pts: [number, number, number][] = [];
          for (let j = 0; j <= segs; j++) {
            const u = u0 + (u1 - u0) * (j / segs);
            const p = curve.Value(u);          // gp_Pnt (by value → delete)
            pts.push([p.X(), p.Y(), p.Z()]);
            p.delete();
          }

          // Analytic classification — lets a projected edge become a real sketch
          // line/circle/arc the solver can freeze + dimension, not a sampled polyline.
          let curveInfo: EdgeCurve = { type: 'other' };
          const ctype = curve.GetType();
          if (ctype === oc.GeomAbs_CurveType.GeomAbs_Line) {
            curveInfo = { type: 'line' };
          } else if (ctype === oc.GeomAbs_CurveType.GeomAbs_Circle) {
            const circ = scope.keep(curve.Circle());
            const ctr  = scope.keep(circ.Location());
            const nrm  = scope.keep(scope.keep(circ.Axis()).Direction());
            curveInfo = {
              type:   'circle',
              center: [ctr.X(), ctr.Y(), ctr.Z()],
              radius: circ.Radius(),
              normal: [nrm.X(), nrm.Y(), nrm.Z()],
              closed: Math.abs((u1 - u0) - 2 * Math.PI) < 1e-6,
            };
          }

          if (pts.length >= 2) result.push({ index: i - 1, points: pts, curve: curveInfo });
        } catch {
          /* skip edge without a usable 3D curve */
        } finally {
          scope.free();
        }
      }
    } finally {
      edgeMap.delete();
    }
    return result;
  }

  /** Total number of (de-duplicated) edges in a shape. */
  static edgeCount(oc: any, shape: any): number {
    const edgeMap = this.buildEdgeMap(oc, shape);
    try { return edgeMap.Extent(); }
    finally { edgeMap.delete(); }
  }
}
