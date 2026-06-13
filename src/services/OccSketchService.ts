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
    const params = OccSketchService.arcParams3P(p1, p2, p3, wp);
    if (!params) throw new Error('Arc-3P: points are collinear');
    const { c, r, a1, a2 } = params;
    const center3D = fromLocal2D(c[0], c[1], wp);
    const { normal, uAxis } = workplaneBasis(wp);
    const ax2   = ax2WithX(oc, center3D, normal, uAxis);
    const circ  = new oc.gp_Circ_2(ax2, r);
    const maker = new oc.BRepBuilderAPI_MakeEdge_9(circ, a1, a2);
    ax2.delete(); circ.delete();
    if (!maker.IsDone()) { maker.delete(); throw new Error('Arc-3P edge failed'); }
    const edge = maker.Edge(); maker.delete();
    return edge;
  }

  /**
   * Local-plane arc parameters for the 3-point arc (centre/radius + CCW a1→a2).
   * Shared by createArcByThreePoints (edge build) and the sketch tool (so the
   * committed node carries a `kind:'arc'` sketchGeom for trim/split/constraints).
   */
  static arcParams3P(
    p1: V3, p2: V3, p3: V3, wp: Workplane,
  ): { c: [number, number]; r: number; a1: number; a2: number } | null {
    const lp1 = toLocal2D(p1, wp); const lp2 = toLocal2D(p2, wp); const lp3 = toLocal2D(p3, wp);
    const cc  = circumcircle2D(lp1, lp2, lp3);
    if (!cc) return null;
    const { cu, cv, cr } = cc;

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

    if (midOnCCW) return { c: [cu, cv], r: cr, a1: a1n, a2: a1n + ccwSpan };
    // Midpoint is on the CW arc from a1 to a3 → draw CCW arc from a3 back to a1
    const cwSpan = n2(a1n - a3n);
    return { c: [cu, cv], r: cr, a1: a3n, a2: a3n + cwSpan };
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

  // ── Region profile (closed wire from a detected loop of members) ───────────
  // members: ordered loop of { id } referencing sketchGeom looked up via geomOf.
  // OCC connects the edges by shared endpoints, so per-member orientation is
  // handled by the wire builder; we just emit each member's edge(s).

  static createRegionWire(
    oc: any, members: { id: string }[], geomOf: (id: string) => any, wp: Workplane,
  ): any {
    const edges: any[] = [];
    for (const m of members) {
      const g = geomOf(m.id);
      if (!g) continue;
      if (g.kind === 'line') {
        edges.push(lineEdge(oc, fromLocal2D(g.a[0], g.a[1], wp), fromLocal2D(g.b[0], g.b[1], wp)));
      } else if (g.kind === 'arc') {
        const center = fromLocal2D(g.c[0], g.c[1], wp);
        const start  = fromLocal2D(g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1), wp);
        const end    = fromLocal2D(g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2), wp);
        edges.push(OccSketchService.createArcEdge(oc, center, start, end, wp));
      } else if (g.kind === 'circle') {
        // A circle is a self-contained region — return its wire directly.
        const rim = fromLocal2D(g.c[0] + g.r, g.c[1], wp);
        return OccSketchService.createCircleWire(oc, fromLocal2D(g.c[0], g.c[1], wp), rim, wp);
      } else if (g.kind === 'polyline' && Array.isArray(g.pts)) {
        const p3 = g.pts.map((p: number[]) => fromLocal2D(p[0], p[1], wp));
        for (let i = 0; i < p3.length - 1; i++) edges.push(lineEdge(oc, p3[i], p3[i + 1]));
      }
    }
    if (!edges.length) throw new Error('Region has no edges');
    return makeWire(oc, edges);
  }

  /**
   * Heal a wire built from independent edges: reorder into connection order,
   * snap near-coincident endpoints together (within `prec`) and close the loop.
   * Lets the exact line/arc edges form a valid closed wire even when the drawn
   * corners only met within the detector's tolerance — keeping curves smooth
   * instead of faceting them. Returns the healed wire.
   */
  static healWire(oc: any, wire: any, prec = 1e-2): any {
    const sfw = new oc.ShapeFix_Wire_1();
    sfw.Load_1(wire);
    sfw.SetPrecision(prec);
    sfw.FixReorder_1();        // edges into head-to-tail order
    sfw.FixConnected_1(prec);  // weld endpoints within prec
    sfw.FixClosed(prec);       // close last→first
    const out = sfw.Wire();
    sfw.delete();
    return out;
  }

  /**
   * Build the best closed wire for a detected region: single-member regions
   * (circle/ellipse) use exact geometry; multi-edge loops try exact edges +
   * healing (smooth arcs) and fall back to the gap-free faceted loop. Returns
   * the wire and whether the faceted fallback was used.
   */
  static buildRegionProfileWire(
    oc: any, region: { members: { id: string }[]; loop: number[][]; area?: number },
    geomOf: (id: string) => any, wp: Workplane,
  ): { wire: any; faceted: boolean } {
    if (region.members.length === 1) {
      return { wire: OccSketchService.createRegionWire(oc, region.members, geomOf, wp), faceted: false };
    }
    try {
      const exact  = OccSketchService.createRegionWire(oc, region.members, geomOf, wp);
      const healed = OccSketchService.healWire(oc, exact, 1e-2);
      // Accept the exact (smooth-arc) wire ONLY if the face it makes has the area
      // the detector measured for this region. A wire whose edges OCC connected
      // in a bad order can self-intersect: it still "makes a face", but OCC fills
      // only one lobe (e.g. the chord-bounded rectangle, dropping arc bumps),
      // which would extrude a partial profile. The area check rejects that and
      // falls back to the faceted loop, which is built from the correctly-traced
      // boundary and is always the full region.
      if (OccSketchService.wireFaceAreaOk(oc, healed, region.area)) return { wire: healed, faceted: false };
    } catch { /* fall through to facet */ }
    return { wire: OccSketchService.createRegionWireFromLoop(oc, region.loop, wp), faceted: true };
  }

  /** True if a planar face can be built from the wire (i.e. it's closed/planar). */
  static wireMakesFace(oc: any, wire: any): boolean {
    const fm = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    const ok = fm.IsDone();
    fm.delete();
    return ok;
  }

  /**
   * True if the wire makes a planar face whose area matches `expected` (the
   * detector's analytic region area) within tolerance. When `expected` is
   * unavailable, falls back to a plain makes-a-face check. Guards against
   * self-intersecting wires that fill only part of the intended profile.
   */
  static wireFaceAreaOk(oc: any, wire: any, expected?: number): boolean {
    const fm = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    if (!fm.IsDone()) { fm.delete(); return false; }
    if (expected === undefined || !(expected > 0)) { fm.delete(); return true; }
    const face  = fm.Face();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    const area = props.Mass();
    props.delete(); face.delete(); fm.delete();
    // Allow 5% slack (arc tessellation in the expected/analytic area, OCC rounding).
    return Math.abs(area - expected) <= 0.05 * expected + 1e-6;
  }

  /**
   * Build a closed region wire from a gap-free loop polygon (local-2D points,
   * as produced by SketchRegions.findRegions). Chaining consecutive points and
   * closing last→first guarantees a closed wire even when the source curves only
   * met within the detector's tolerance (sub-OCC-precision gaps that would make
   * an edge-by-edge wire fail to close). Curved members become faceted here.
   */
  static createRegionWireFromLoop(oc: any, loop: number[][], wp: Workplane): any {
    const p3: V3[] = [];
    for (const p of loop) {
      const v = fromLocal2D(p[0], p[1], wp);
      if (!p3.length || p3[p3.length - 1].distanceTo(v) > 1e-7) p3.push(v);
    }
    if (p3.length > 1 && p3[0].distanceTo(p3[p3.length - 1]) < 1e-7) p3.pop(); // drop closing dup
    if (p3.length < 3) throw new Error('Region loop too small to extrude');
    const edges: any[] = [];
    for (let i = 0; i < p3.length; i++) edges.push(lineEdge(oc, p3[i], p3[(i + 1) % p3.length]));
    return makeWire(oc, edges);
  }

  static buildClosedWire(oc: any, edges: any[]): any {
    return makeWire(oc, edges);
  }

  // ── Single sketch entity → wire (rebuild from sketchGeom) ──────────────────
  // Used by the 2D Mirror/Array tools to materialise a transformed entity.
  static buildEntityWire(oc: any, geom: any, wp: Workplane): any {
    if (geom.kind === 'line') {
      return makeWire(oc, [lineEdge(oc, fromLocal2D(geom.a[0], geom.a[1], wp), fromLocal2D(geom.b[0], geom.b[1], wp))]);
    }
    if (geom.kind === 'circle') {
      const center = fromLocal2D(geom.c[0], geom.c[1], wp);
      const rim    = fromLocal2D(geom.c[0] + geom.r, geom.c[1], wp);
      return OccSketchService.createCircleWire(oc, center, rim, wp);
    }
    if (geom.kind === 'arc') {
      const center = fromLocal2D(geom.c[0], geom.c[1], wp);
      const start  = fromLocal2D(geom.c[0] + geom.r * Math.cos(geom.a1), geom.c[1] + geom.r * Math.sin(geom.a1), wp);
      const end    = fromLocal2D(geom.c[0] + geom.r * Math.cos(geom.a2), geom.c[1] + geom.r * Math.sin(geom.a2), wp);
      return makeWire(oc, [OccSketchService.createArcEdge(oc, center, start, end, wp)]);
    }
    if (geom.kind === 'polyline') {
      const p3 = geom.pts.map((p: number[]) => fromLocal2D(p[0], p[1], wp));
      const edges: any[] = [];
      for (let i = 0; i < p3.length - 1; i++) edges.push(lineEdge(oc, p3[i], p3[i + 1]));
      return makeWire(oc, edges);
    }
    throw new Error(`Cannot build wire for sketch geom kind: ${geom.kind}`);
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
