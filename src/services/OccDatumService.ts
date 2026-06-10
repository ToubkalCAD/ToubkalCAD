// ============================================================
// ToubkalCAD – OccDatumService.ts
//
// Track D — construction-geometry (datum) builders that need OCC.
// Pure geometry → returns a Workplane (origin/normal/uAxis/vAxis); the caller
// persists it via store.createDatumPlane (datums carry no registry solid).
//
//   • extractVertices   — world-space corner points of a shape (for D4 picking)
//   • planeFrom3Points  — gce_MakePln(P1,P2,P3) → Workplane (D4)
// ============================================================

import { WasmScope } from '../utils/WasmScope';
import { OccFaceService } from './OccFaceService';
import { OccEdgeService } from './OccEdgeService';
import type { Workplane } from '../store/cadStore';

export interface StraightEdge {
  points: [number, number, number][];   // world-space polyline (for the pickable line)
  origin: [number, number, number];     // a point on the line (the first endpoint)
  dir:    [number, number, number];     // unit direction
}

export class OccDatumService {
  /** Unique vertices of `shape` in world coords (deduped within tolerance). */
  static extractVertices(oc: any, shape: any, tol = 1e-5): [number, number, number][] {
    const out: [number, number, number][] = [];
    const exp = new oc.TopExp_Explorer_2(
      shape, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (exp.More()) {
      const v = oc.TopoDS.Vertex_1(exp.Current());
      const p = oc.BRep_Tool.Pnt(v);
      const pt: [number, number, number] = [p.X(), p.Y(), p.Z()];
      p.delete();
      if (!out.some((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1], q[2] - pt[2]) < tol)) out.push(pt);
      exp.Next();
    }
    exp.delete();
    return out;
  }

  /** Build a Workplane from a point + plane normal (clean axes via gce_MakePln_2). */
  private static planeFromPointNormal(
    oc: any, origin: [number, number, number], normal: [number, number, number],
  ): Workplane | null {
    const len = Math.hypot(normal[0], normal[1], normal[2]);
    if (len < 1e-9) return null;
    const scope = new WasmScope();
    try {
      const p   = scope.keep(new oc.gp_Pnt_3(origin[0], origin[1], origin[2]));
      const d   = scope.keep(new oc.gp_Dir_4(normal[0] / len, normal[1] / len, normal[2] / len));
      const mk  = scope.keep(new oc.gce_MakePln_2(p, d));
      if (!mk.IsDone()) return null;
      const pln = scope.keep(mk.Value());
      const ax3 = scope.keep(pln.Position());
      const loc = scope.keep(ax3.Location());
      const nrm = scope.keep(ax3.Direction());
      const xd  = scope.keep(ax3.XDirection());
      const yd  = scope.keep(ax3.YDirection());
      return {
        label:  'Datum',
        origin: [loc.X(), loc.Y(), loc.Z()],
        normal: [nrm.X(), nrm.Y(), nrm.Z()],
        uAxis:  [xd.X(),  xd.Y(),  xd.Z()],
        vAxis:  [yd.X(),  yd.Y(),  yd.Z()],
      };
    } catch {
      return null;
    } finally {
      scope.free();
    }
  }

  /**
   * D6 — Tangent plane to a CYLINDRICAL face at a clicked point: the plane that
   * touches the cylinder along its surface, with normal = the radial direction
   * from the axis to the point. (origin/axisPoint/axisDir/hitPoint world-space.)
   */
  static tangentPlaneToCylinder(
    oc: any,
    hitPoint:  [number, number, number],
    axisPoint: [number, number, number],
    axisDir:   [number, number, number],
  ): Workplane | null {
    const ax = [hitPoint[0] - axisPoint[0], hitPoint[1] - axisPoint[1], hitPoint[2] - axisPoint[2]];
    const t  = ax[0] * axisDir[0] + ax[1] * axisDir[1] + ax[2] * axisDir[2];
    const radial: [number, number, number] = [ax[0] - t * axisDir[0], ax[1] - t * axisDir[1], ax[2] - t * axisDir[2]];
    const wp = this.planeFromPointNormal(oc, hitPoint, radial);
    return wp ? { ...wp, label: 'Tangent' } : null;
  }

  /**
   * D6 — Plane normal to a path at a fraction `f` ∈ [0,1] of its arc length: the
   * plane perpendicular to the curve there (origin = the point on the curve,
   * normal = the local tangent). Polyline-based (good for any sampled edge).
   */
  static planeNormalToPath(oc: any, points: [number, number, number][], f: number): Workplane | null {
    if (points.length < 2) return null;
    const seg: number[] = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      seg.push(total);
    }
    if (total < 1e-9) return null;
    const target = Math.max(0, Math.min(1, f)) * total;
    let i = 1;
    while (i < seg.length && seg[i] < target) i++;
    const a = points[i - 1], b = points[i];
    const segLen = seg[i] - seg[i - 1] || 1e-9;
    const lt = (target - seg[i - 1]) / segLen;
    const origin: [number, number, number] = [a[0] + (b[0] - a[0]) * lt, a[1] + (b[1] - a[1]) * lt, a[2] + (b[2] - a[2]) * lt];
    const tangent: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const wp = this.planeFromPointNormal(oc, origin, tangent);
    return wp ? { ...wp, label: 'Normal-to-Curve' } : null;
  }

  /**
   * D6 — Plane through two edges (must be coplanar): builds it from three of the
   * edges' endpoints. Returns null if every triple is collinear.
   */
  static planeThrough2Edges(
    oc: any, ptsA: [number, number, number][], ptsB: [number, number, number][],
  ): Workplane | null {
    const a0 = ptsA[0], a1 = ptsA[ptsA.length - 1];
    const b0 = ptsB[0], b1 = ptsB[ptsB.length - 1];
    const wp = this.planeFrom3Points(oc, a0, a1, b0) ?? this.planeFrom3Points(oc, a0, a1, b1);
    return wp ? { ...wp, label: '2-Edge' } : null;
  }

  /**
   * Midplane between two planar faces/planes (each given by a point + normal) →
   * Workplane, or null if degenerate. Normals are aligned first (flip N2 if it
   * opposes N1, so the two outward normals of a slab don't cancel), averaged for
   * the midplane normal, and the plane is anchored at the midpoint of the two
   * origins. Exact for parallel faces; the angle bisector for non-parallel ones.
   */
  static midplane(
    oc: any,
    o1: [number, number, number], n1: [number, number, number],
    o2: [number, number, number], n2: [number, number, number],
  ): Workplane | null {
    let [bx, by, bz] = n2;
    if (n1[0] * bx + n1[1] * by + n1[2] * bz < 0) { bx = -bx; by = -by; bz = -bz; }
    let ax = n1[0] + bx, ay = n1[1] + by, az = n1[2] + bz;
    const len = Math.hypot(ax, ay, az);
    if (len < 1e-9) return null;                    // exactly anti-parallel (can't happen post-align)
    ax /= len; ay /= len; az /= len;
    const mid: [number, number, number] = [(o1[0] + o2[0]) / 2, (o1[1] + o2[1]) / 2, (o1[2] + o2[2]) / 2];

    const scope = new WasmScope();
    try {
      const p   = scope.keep(new oc.gp_Pnt_3(mid[0], mid[1], mid[2]));
      const d   = scope.keep(new oc.gp_Dir_4(ax, ay, az));
      const mk  = scope.keep(new oc.gce_MakePln_2(p, d));
      if (!mk.IsDone()) return null;
      const pln = scope.keep(mk.Value());
      const ax3 = scope.keep(pln.Position());
      const loc = scope.keep(ax3.Location());
      const nrm = scope.keep(ax3.Direction());
      const xd  = scope.keep(ax3.XDirection());
      const yd  = scope.keep(ax3.YDirection());
      return {
        label:  'Midplane',
        origin: [loc.X(), loc.Y(), loc.Z()],
        normal: [nrm.X(), nrm.Y(), nrm.Z()],
        uAxis:  [xd.X(),  xd.Y(),  xd.Z()],
        vAxis:  [yd.X(),  yd.Y(),  yd.Z()],
      };
    } catch {
      return null;
    } finally {
      scope.free();
    }
  }

  /**
   * The straight boundary edges of one face (by its OccFaceService face index),
   * each with a pickable polyline and its line axis. Curved edges are skipped —
   * a "plane at angle" hinges about a straight edge. World-space (pass a placed
   * shape). Same face indexing as OccFaceService.extractPlanarFaces.
   */
  static faceStraightEdges(oc: any, shape: any, faceIndex: number): StraightEdge[] {
    const faceMap = OccFaceService.buildFaceMap(oc, shape);
    try {
      if (faceIndex < 0 || faceIndex >= faceMap.Extent()) return [];
      const face = oc.TopoDS.Face_1(faceMap.FindKey(faceIndex + 1));
      return this.straightEdges(oc, face);
    } finally {
      faceMap.delete();
    }
  }

  /**
   * D12 — Intersect: section a solid with a plane (origin + normal) and return
   * the resulting curves as world-space polylines (each an array of points).
   * Empty if the plane misses the body. `BRepAlgoAPI_Section_5(shape, gp_Pln)`.
   */
  static sectionPolylines(
    oc: any, shape: any,
    planeOrigin: [number, number, number], planeNormal: [number, number, number],
  ): [number, number, number][][] {
    const scope = new WasmScope();
    try {
      const p   = scope.keep(new oc.gp_Pnt_3(planeOrigin[0], planeOrigin[1], planeOrigin[2]));
      const d   = scope.keep(new oc.gp_Dir_4(planeNormal[0], planeNormal[1], planeNormal[2]));
      const pln = scope.keep(new oc.gp_Pln_3(p, d));
      const sec = scope.keep(new oc.BRepAlgoAPI_Section_5(shape, pln, true));
      if (!sec.IsDone()) return [];
      return OccEdgeService.extractEdges(oc, sec.Shape()).map((e) => e.points);
    } catch {
      return [];
    } finally {
      scope.free();
    }
  }

  /** Every straight edge of a shape (curved edges filtered out), each with its
   *  pickable polyline + line axis. World-space (pass a placed shape). Used by
   *  D7 (datum axis from an edge) and D3 (face hinge edges, via faceStraightEdges). */
  static straightEdges(oc: any, shape: any): StraightEdge[] {
    const out: StraightEdge[] = [];
    for (const e of OccEdgeService.extractEdges(oc, shape)) {
      const pts = e.points;
      const a = pts[0], b = pts[pts.length - 1];
      let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-7) continue;
      dx /= len; dy /= len; dz /= len;
      let maxDev = 0;                                   // perpendicular deviation from the chord
      for (const p of pts) {
        const wx = p[0] - a[0], wy = p[1] - a[1], wz = p[2] - a[2];
        const t  = wx * dx + wy * dy + wz * dz;
        maxDev = Math.max(maxDev, Math.hypot(wx - t * dx, wy - t * dy, wz - t * dz));
      }
      if (maxDev > Math.max(1e-4, len * 1e-3)) continue; // curved → not a straight axis
      out.push({ points: pts, origin: a, dir: [dx, dy, dz] });
    }
    return out;
  }

  /**
   * Rotate a reference plane (origin + normal) about an axis (a face edge) by
   * `angleDeg` → Workplane, or null on failure. The rotated plane still passes
   * through the axis, so when the axis is an edge of the face it acts as a hinge.
   */
  static planeAtAngle(
    oc: any,
    refOrigin: [number, number, number], refNormal: [number, number, number],
    axisPoint: [number, number, number], axisDir:  [number, number, number],
    angleDeg: number,
  ): Workplane | null {
    const scope = new WasmScope();
    try {
      const p   = scope.keep(new oc.gp_Pnt_3(refOrigin[0], refOrigin[1], refOrigin[2]));
      const d   = scope.keep(new oc.gp_Dir_4(refNormal[0], refNormal[1], refNormal[2]));
      const mk  = scope.keep(new oc.gce_MakePln_2(p, d));
      if (!mk.IsDone()) return null;
      const pln = scope.keep(mk.Value());
      const ap  = scope.keep(new oc.gp_Pnt_3(axisPoint[0], axisPoint[1], axisPoint[2]));
      const ad  = scope.keep(new oc.gp_Dir_4(axisDir[0], axisDir[1], axisDir[2]));
      const ax1 = scope.keep(new oc.gp_Ax1_2(ap, ad));
      const rot = scope.keep(pln.Rotated(ax1, (angleDeg * Math.PI) / 180));   // gp_Pln
      const ax3 = scope.keep(rot.Position());
      const loc = scope.keep(ax3.Location());
      const nrm = scope.keep(ax3.Direction());
      const xd  = scope.keep(ax3.XDirection());
      const yd  = scope.keep(ax3.YDirection());
      return {
        label:  'At Angle',
        origin: [loc.X(), loc.Y(), loc.Z()],
        normal: [nrm.X(), nrm.Y(), nrm.Z()],
        uAxis:  [xd.X(),  xd.Y(),  xd.Z()],
        vAxis:  [yd.X(),  yd.Y(),  yd.Z()],
      };
    } catch {
      return null;
    } finally {
      scope.free();
    }
  }

  /**
   * Plane through three points → Workplane, or null if the points are
   * (near-)collinear. origin/u/v/normal come straight from the resulting
   * gp_Pln's gp_Ax3 (location at P1, X toward P2, normal = P1P2 × P1P3).
   */
  static planeFrom3Points(
    oc: any,
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
  ): Workplane | null {
    const scope = new WasmScope();
    try {
      const g1 = scope.keep(new oc.gp_Pnt_3(p1[0], p1[1], p1[2]));
      const g2 = scope.keep(new oc.gp_Pnt_3(p2[0], p2[1], p2[2]));
      const g3 = scope.keep(new oc.gp_Pnt_3(p3[0], p3[1], p3[2]));
      const mk = scope.keep(new oc.gce_MakePln_6(g1, g2, g3));
      if (!mk.IsDone()) return null;                 // collinear → no plane
      const pln = scope.keep(mk.Value());
      const ax3 = scope.keep(pln.Position());
      const loc = scope.keep(ax3.Location());
      const nrm = scope.keep(ax3.Direction());
      const xd  = scope.keep(ax3.XDirection());
      const yd  = scope.keep(ax3.YDirection());
      return {
        label:  '3-Point',
        origin: [loc.X(), loc.Y(), loc.Z()],
        normal: [nrm.X(), nrm.Y(), nrm.Z()],
        uAxis:  [xd.X(),  xd.Y(),  xd.Z()],
        vAxis:  [yd.X(),  yd.Y(),  yd.Z()],
      };
    } catch {
      return null;
    } finally {
      scope.free();
    }
  }
}
