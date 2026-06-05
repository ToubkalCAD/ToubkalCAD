// ============================================================
// ToubkalCAD – OccSketchService.ts  (v3 — full 3D)
//
// All sketch geometry is created in 3D world space using
// gp_Pnt / BRepBuilderAPI_MakeEdge (not the 2d variants).
// Caller passes global THREE.Vector3 click coordinates that
// already lie on the chosen workplane.  No coordinate-plane
// transformation is needed: the wire is in world space from
// the start, and extrusion direction = workplane normal.
//
// Verified constructor indices (opencascade.full.d.ts):
//   gp_Pnt_3(x, y, z)
//   gp_Dir_4(x, y, z)
//   gp_Ax2_2(P, N, Vx)           origin + normal + X-axis
//   gp_Ax2_3(P, V)               origin + normal, auto X-axis
//   gp_Circ_2(A2, R)
//   gp_Elips_2(A2, major, minor)
//   BRepBuilderAPI_MakeEdge_3(P1, P2)          3-D line
//   BRepBuilderAPI_MakeEdge_8(gp_Circ)         full circle
//   BRepBuilderAPI_MakeEdge_9(gp_Circ, a1, a2) arc by angles
//   BRepBuilderAPI_MakeEdge_10(gp_Circ, P1, P2)arc by points
//   BRepBuilderAPI_MakeEdge_12(gp_Elips)       full ellipse
//   BRepBuilderAPI_MakeEdge_13(gp_Elips,a1,a2) ellipse arc
//   BRepBuilderAPI_MakeEdge_24(Handle_Geom_Curve) from curve
//   Handle_Geom_Curve_2(Geom_Curve*)
//   Geom_BezierCurve_1(TColgp_Array1OfPnt)
//   TColgp_Array1OfPnt_2(lower, upper)
//   BRepBuilderAPI_MakeFace_15(Wire, OnlyPlane)
//   gp_Vec_4(x, y, z)
//   BRepPrimAPI_MakePrism_1(Shape, Vec, Copy, Canonize)
// ============================================================

import * as THREE from 'three';
import type { Workplane } from '../store/cadStore';

type V3 = THREE.Vector3;

// ─── Low-level helpers ────────────────────────────────────────────────────────

function pnt(oc: any, p: V3): any { return new oc.gp_Pnt_3(p.x, p.y, p.z); }
function dir(oc: any, v: THREE.Vector3): any { return new oc.gp_Dir_4(v.x, v.y, v.z); }

/** Build a gp_Ax2 with explicit X axis (for angle-sensitive shapes). */
function ax2WithX(oc: any, origin: V3, normal: V3, xAxis: V3): any {
  const o = pnt(oc, origin); const n = dir(oc, normal); const x = dir(oc, xAxis);
  const a = new oc.gp_Ax2_2(o, n, x);
  o.delete(); n.delete(); x.delete();
  return a;
}

/** Build a gp_Ax2 with auto-computed X axis. */
function ax2Auto(oc: any, origin: V3, normal: V3): any {
  const o = pnt(oc, origin); const n = dir(oc, normal);
  const a = new oc.gp_Ax2_3(o, n);
  o.delete(); n.delete();
  return a;
}

/** Convert gp_Pnt → gp_Pnt and return a BRepBuilderAPI_MakeEdge_3 edge. */
function lineEdge(oc: any, p1: V3, p2: V3): any {
  const a = pnt(oc, p1); const b = pnt(oc, p2);
  const m = new oc.BRepBuilderAPI_MakeEdge_3(a, b);
  a.delete(); b.delete();
  if (!m.IsDone()) { m.delete(); throw new Error('Line edge failed'); }
  const e = m.Edge(); m.delete(); return e;
}

/** Assemble edges into a wire. */
function makeWire(oc: any, edges: any[]): any {
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  for (const e of edges) wm.Add_1(e);
  if (!wm.IsDone()) { wm.delete(); throw new Error('Wire assembly failed'); }
  const w = wm.Wire(); wm.delete(); return w;
}

// ─── Workplane geometry helpers ───────────────────────────────────────────────

/** Get Three.js vectors for the workplane basis. */
export function workplaneBasis(wp: Workplane) {
  return {
    origin: new THREE.Vector3(...wp.origin),
    normal: new THREE.Vector3(...wp.normal).normalize(),
    uAxis:  new THREE.Vector3(...wp.uAxis).normalize(),
    vAxis:  new THREE.Vector3(...wp.vAxis).normalize(),
  };
}

/** Project a global point onto the workplane's local 2D coords (u, v). */
export function toLocal2D(pt: V3, wp: Workplane): { u: number; v: number } {
  const { origin, uAxis, vAxis } = workplaneBasis(wp);
  const rel = pt.clone().sub(origin);
  return { u: rel.dot(uAxis), v: rel.dot(vAxis) };
}

/** Reconstruct a global 3D point from local 2D coords. */
export function fromLocal2D(u: number, v: number, wp: Workplane): THREE.Vector3 {
  const { origin, uAxis, vAxis } = workplaneBasis(wp);
  return origin.clone().addScaledVector(uAxis, u).addScaledVector(vAxis, v);
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class OccSketchService {

  // ── Line ──────────────────────────────────────────────────────────────────

  static createLineEdge(oc: any, p1: V3, p2: V3): any {
    return lineEdge(oc, p1, p2);
  }

  // ── Circle (full, returned as wire) ───────────────────────────────────────

  static createCircleWire(oc: any, center: V3, rim: V3, wp: Workplane): any {
    const { normal, uAxis } = workplaneBasis(wp);
    const radius = center.distanceTo(rim);
    if (radius < 1e-6) throw new Error('Circle radius too small');
    const ax2   = ax2WithX(oc, center, normal, uAxis);
    const circ  = new oc.gp_Circ_2(ax2, radius);
    const maker = new oc.BRepBuilderAPI_MakeEdge_8(circ);
    ax2.delete(); circ.delete();
    if (!maker.IsDone()) { maker.delete(); throw new Error('Circle edge failed'); }
    const edge = maker.Edge(); maker.delete();
    return makeWire(oc, [edge]);
  }

  // ── Arc by center + start + end (3 clicks) ────────────────────────────────
  // The arc goes CCW from startPt to endPt (as the preview shows).
  // We use BRepBuilderAPI_MakeEdge_9 (angles) rather than _10 (points) because
  // endPt is a raw mouse click that is NOT guaranteed to lie on the circle,
  // causing _10 to fail with "Arc edge failed".

  static createArcEdge(oc: any, center: V3, startPt: V3, endPt: V3, wp: Workplane): any {
    const { normal, uAxis } = workplaneBasis(wp);
    const radius = center.distanceTo(startPt);
    if (radius < 1e-6) throw new Error('Arc radius too small');

    // Compute start and end angles in the workplane's local 2D frame
    const lc = toLocal2D(center, wp);
    const ls = toLocal2D(startPt, wp);
    const le = toLocal2D(endPt,   wp);
    const a1 = Math.atan2(ls.v - lc.v, ls.u - lc.u);
    let   a2 = Math.atan2(le.v - lc.v, le.u - lc.u);

    // Ensure CCW: a2 must be strictly greater than a1
    if (a2 <= a1) a2 += 2 * Math.PI;

    const ax2   = ax2WithX(oc, center, normal, uAxis);
    const circ  = new oc.gp_Circ_2(ax2, radius);
    const maker = new oc.BRepBuilderAPI_MakeEdge_9(circ, a1, a2);
    ax2.delete(); circ.delete();
    if (!maker.IsDone()) { maker.delete(); throw new Error('Arc edge failed'); }
    const edge = maker.Edge(); maker.delete();
    return edge;
  }

  // ── Arc through 3 points ──────────────────────────────────────────────────
  // Uses angles rather than _10 (point-on-circle) to avoid OCC tolerance failures.
  // The midpoint p2 determines which of the two arcs (CW / CCW from p1 to p3) to draw.

  static createArcByThreePoints(oc: any, p1: V3, p2: V3, p3: V3, wp: Workplane): any {
    const lp1 = toLocal2D(p1, wp); const lp2 = toLocal2D(p2, wp); const lp3 = toLocal2D(p3, wp);
    const cc  = circumcircle2D(lp1, lp2, lp3);
    if (!cc) throw new Error('Arc-3P: points are collinear');
    const { cu, cv, cr } = cc;
    const center3D = fromLocal2D(cu, cv, wp);
    const { normal, uAxis } = workplaneBasis(wp);

    // Angles of each point relative to the circumcircle centre
    const a1 = Math.atan2(lp1.v - cv, lp1.u - cu);
    const am = Math.atan2(lp2.v - cv, lp2.u - cu);
    const a3 = Math.atan2(lp3.v - cv, lp3.u - cu);

    // Normalize any angle to [0, 2π)
    const n2 = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const a1n = n2(a1), amn = n2(am), a3n = n2(a3);

    // Angular span CCW from a1n to a3n, and CCW from a1n to amn
    const ccwSpan  = n2(a3n - a1n);   // 0 if a1==a3 (degenerate)
    const ccwToMid = n2(amn - a1n);

    // Is the midpoint on the CCW arc from a1 to a3?
    const midOnCCW = ccwToMid > 1e-9 && ccwToMid < ccwSpan - 1e-9;

    let arcStart: number, arcEnd: number;
    if (midOnCCW) {
      arcStart = a1n;
      arcEnd   = a1n + ccwSpan;
    } else {
      // Midpoint is on the CW arc from a1 to a3 → draw CCW arc from a3 back to a1
      const cwSpan = n2(a1n - a3n);
      arcStart = a3n;
      arcEnd   = a3n + cwSpan;
    }

    const ax2   = ax2WithX(oc, center3D, normal, uAxis);
    const circ  = new oc.gp_Circ_2(ax2, cr);
    const maker = new oc.BRepBuilderAPI_MakeEdge_9(circ, arcStart, arcEnd);
    ax2.delete(); circ.delete();
    if (!maker.IsDone()) { maker.delete(); throw new Error('Arc-3P edge failed'); }
    const edge = maker.Edge(); maker.delete();
    return edge;
  }

  // ── Rectangle (closed wire) ───────────────────────────────────────────────

  static createRectangleWire(oc: any, c1: V3, c2: V3, wp: Workplane): any {
    const l1 = toLocal2D(c1, wp); const l2 = toLocal2D(c2, wp);
    const { u: u1, v: v1 } = l1; const { u: u2, v: v2 } = l2;
    const corners = [
      fromLocal2D(u1, v1, wp), fromLocal2D(u2, v1, wp),
      fromLocal2D(u2, v2, wp), fromLocal2D(u1, v2, wp),
    ];
    const edges = corners.map((c, i) => lineEdge(oc, c, corners[(i + 1) % 4]));
    return makeWire(oc, edges);
  }

  // ── Rounded rectangle ─────────────────────────────────────────────────────

  static createRoundedRectangleWire(
    oc: any, c1: V3, c2: V3, cornerRadius: number, wp: Workplane,
  ): any {
    const l1 = toLocal2D(c1, wp); const l2 = toLocal2D(c2, wp);
    let u1=l1.u, v1=l1.v, u2=l2.u, v2=l2.v;
    if (u1 > u2) { [u1, u2] = [u2, u1]; } if (v1 > v2) { [v1, v2] = [v2, v1]; }
    const r  = Math.min(cornerRadius, Math.min(u2-u1, v2-v1) / 2 - 1e-4);
    const { normal, uAxis } = workplaneBasis(wp);
    const PI = Math.PI;

    // 4 straight edges
    const edges: any[] = [];
    edges.push(lineEdge(oc, fromLocal2D(u1+r, v1, wp), fromLocal2D(u2-r, v1, wp)));
    edges.push(lineEdge(oc, fromLocal2D(u2, v1+r, wp), fromLocal2D(u2, v2-r, wp)));
    edges.push(lineEdge(oc, fromLocal2D(u2-r, v2, wp), fromLocal2D(u1+r, v2, wp)));
    edges.push(lineEdge(oc, fromLocal2D(u1, v2-r, wp), fromLocal2D(u1, v1+r, wp)));

    // 4 corner arcs
    const arcCorners: Array<{ cu: number; cv: number; a1: number; a2: number }> = [
      { cu: u2-r, cv: v1+r, a1: -PI/2, a2: 0 },
      { cu: u2-r, cv: v2-r, a1: 0,     a2: PI/2 },
      { cu: u1+r, cv: v2-r, a1: PI/2,  a2: PI },
      { cu: u1+r, cv: v1+r, a1: PI,    a2: 3*PI/2 },
    ];
    for (const { cu, cv, a1, a2 } of arcCorners) {
      const ctr = fromLocal2D(cu, cv, wp);
      const ax2 = ax2WithX(oc, ctr, normal, uAxis);
      const circ = new oc.gp_Circ_2(ax2, r);
      const mk   = new oc.BRepBuilderAPI_MakeEdge_9(circ, a1, a2);
      ax2.delete(); circ.delete();
      if (!mk.IsDone()) { mk.delete(); throw new Error('Corner arc failed'); }
      edges.push(mk.Edge()); mk.delete();
    }
    return makeWire(oc, edges);
  }

  // ── Regular polygon (closed wire) ─────────────────────────────────────────

  static createPolygonWire(oc: any, center: V3, rim: V3, sides: number, wp: Workplane): any {
    if (sides < 3) throw new Error('Polygon needs ≥ 3 sides');
    const lc = toLocal2D(center, wp); const lr = toLocal2D(rim, wp);
    const r  = Math.hypot(lr.u - lc.u, lr.v - lc.v);
    const pts = Array.from({ length: sides }, (_, i) => {
      const a = (2 * Math.PI * i) / sides;
      return fromLocal2D(lc.u + r*Math.cos(a), lc.v + r*Math.sin(a), wp);
    });
    const edges = pts.map((p, i) => lineEdge(oc, p, pts[(i+1) % sides]));
    return makeWire(oc, edges);
  }

  // ── Ellipse ───────────────────────────────────────────────────────────────

  static createEllipseWire(
    oc: any, center: V3, majorEnd: V3, minorEnd: V3, wp: Workplane,
    startRad?: number, endRad?: number,
  ): any {
    const { normal, uAxis } = workplaneBasis(wp);
    const lc = toLocal2D(center, wp);
    const lm = toLocal2D(majorEnd, wp);
    const ln = toLocal2D(minorEnd, wp);
    let major = Math.hypot(lm.u - lc.u, lm.v - lc.v);
    let minor = Math.hypot(ln.u - lc.u, ln.v - lc.v);
    if (major < 1e-6 || minor < 1e-6) throw new Error('Ellipse radii too small');
    if (major < minor) { [major, minor] = [minor, major]; }
    const ax2   = ax2WithX(oc, center, normal, uAxis);
    const elips = new oc.gp_Elips_2(ax2, major, minor);
    ax2.delete();
    let edge: any;
    if (startRad !== undefined && endRad !== undefined) {
      const mk = new oc.BRepBuilderAPI_MakeEdge_13(elips, startRad, endRad);
      if (!mk.IsDone()) { elips.delete(); mk.delete(); throw new Error('Ellipse arc failed'); }
      edge = mk.Edge(); mk.delete();
    } else {
      const mk = new oc.BRepBuilderAPI_MakeEdge_12(elips);
      if (!mk.IsDone()) { elips.delete(); mk.delete(); throw new Error('Full ellipse failed'); }
      edge = mk.Edge(); mk.delete();
    }
    elips.delete();
    return makeWire(oc, [edge]);
  }

  // ── Bezier (3D, De Casteljau control polygon) ─────────────────────────────

  static createBezierWire(oc: any, ctrlPts: V3[]): any {
    if (ctrlPts.length < 2) throw new Error('Bezier needs ≥ 2 control points');
    const n     = ctrlPts.length;
    const poles = new oc.TColgp_Array1OfPnt_2(1, n);
    const tmps: any[] = [];
    ctrlPts.forEach((p, i) => {
      const pp = pnt(oc, p); poles.SetValue(i+1, pp); tmps.push(pp);
    });
    const bezier = new oc.Geom_BezierCurve_1(poles);
    poles.delete(); tmps.forEach((p) => p.delete());
    const hCurve = new oc.Handle_Geom_Curve_2(bezier);
    const maker  = new oc.BRepBuilderAPI_MakeEdge_24(hCurve);
    if (!maker.IsDone()) { hCurve.delete(); maker.delete(); throw new Error('Bezier edge failed'); }
    const edge = maker.Edge(); hCurve.delete(); maker.delete();
    return makeWire(oc, [edge]);
  }

  // ── Spline (Catmull-Rom polyline approximation) ───────────────────────────

  static createSplineWire(oc: any, pts: V3[], wp: Workplane): any {
    if (pts.length < 2) throw new Error('Spline needs ≥ 2 points');
    const samples = catmullRom3D(pts, 64);
    const edges   = samples.slice(0, -1).map((p, i) => lineEdge(oc, p, samples[i+1]));
    return makeWire(oc, edges);
  }

  // ── Wire assembly ─────────────────────────────────────────────────────────

  static createClosedWireFromEdges(oc: any, edges: any[]): any {
    return makeWire(oc, edges);
  }

  static buildClosedWire(oc: any, edges: any[]): any {
    return makeWire(oc, edges);
  }

  // ── Removed: mapToXZPlane — not needed with 3D wire approach ─────────────
}

// ─── Pure JS helpers ──────────────────────────────────────────────────────────

function circumcircle2D(
  p1: { u: number; v: number },
  p2: { u: number; v: number },
  p3: { u: number; v: number },
): { cu: number; cv: number; cr: number } | null {
  const ax=p1.u, ay=p1.v, bx=p2.u, by=p2.v, cx=p3.u, cy=p3.v;
  const D = 2*(ax*(by-cy) + bx*(cy-ay) + cx*(ay-by));
  if (Math.abs(D) < 1e-10) return null;
  const ux = ((ax*ax+ay*ay)*(by-cy)+(bx*bx+by*by)*(cy-ay)+(cx*cx+cy*cy)*(ay-by)) / D;
  const uy = ((ax*ax+ay*ay)*(cx-bx)+(bx*bx+by*by)*(ax-cx)+(cx*cx+cy*cy)*(bx-ax)) / D;
  return { cu: ux, cv: uy, cr: Math.hypot(ax-ux, ay-uy) };
}

function catmullRom3D(pts: V3[], totalSamples: number): V3[] {
  const n = pts.length;
  const result: V3[] = [];
  const segsPerSpan = Math.max(2, Math.floor(totalSamples / (n-1)));
  for (let seg = 0; seg < n-1; seg++) {
    const p0 = pts[Math.max(0, seg-1)];
    const p1 = pts[seg];
    const p2 = pts[Math.min(n-1, seg+1)];
    const p3 = pts[Math.min(n-1, seg+2)];
    for (let k = 0; k <= (seg===n-2 ? segsPerSpan : segsPerSpan-1); k++) {
      const t=k/segsPerSpan, t2=t*t, t3=t2*t;
      const x=0.5*((-t3+2*t2-t)*p0.x+(3*t3-5*t2+2)*p1.x+(-3*t3+4*t2+t)*p2.x+(t3-t2)*p3.x);
      const y=0.5*((-t3+2*t2-t)*p0.y+(3*t3-5*t2+2)*p1.y+(-3*t3+4*t2+t)*p2.y+(t3-t2)*p3.y);
      const z=0.5*((-t3+2*t2-t)*p0.z+(3*t3-5*t2+2)*p1.z+(-3*t3+4*t2+t)*p2.z+(t3-t2)*p3.z);
      result.push(new THREE.Vector3(x, y, z));
    }
  }
  return result;
}
