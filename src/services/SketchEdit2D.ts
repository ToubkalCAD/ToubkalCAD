// ============================================================
// ToubkalCAD – SketchEdit2D.ts
//
// Track S1 — Trim / Extend / Break(Split) for 2D sketch curves.
//
// Pure 2D math in the sketch's local (u,v) plane. Operates on LINE entities
// (the target being edited); cutters/boundaries may be lines or circles. This
// mirrors the Phase-8 constraint scope (lines + circles carry `sketchGeom`),
// and keeps everything analytic — no OCC sectioning needed for the 2D case.
//
// Conventions: a line is parameterised P(t) = a + t·(b − a), t∈[0,1].
// ============================================================

export type Pt = [number, number];
export type Entity2D =
  | { kind: 'line';   a: Pt; b: Pt }
  | { kind: 'circle'; c: Pt; r: number }
  | { kind: 'arc';    c: Pt; r: number; a1: number; a2: number }
  | { kind: 'polyline'; pts: Pt[] };   // tessellated curve cutter (ellipse/spline/bezier)
export interface Line2D { a: Pt; b: Pt }
export interface Circle2D { c: Pt; r: number }
/** Arc parameterised CCW from a1 to a2 (a2 > a1, span < 2π). */
export interface Arc2D { c: Pt; r: number; a1: number; a2: number }

const EPS       = 1e-9;   // geometric zero
const PARAM_EPS = 1e-4;   // param-space tolerance (endpoint / dedupe)
const TWO_PI    = 2 * Math.PI;
const norm2pi   = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;
/** Raw signed angle of p about centre c (atan2, in (−π, π]). */
const angleOf   = (c: Pt, p: Pt): number => Math.atan2(p[1] - c[1], p[0] - c[0]);

const sub  = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]];
const add  = (p: Pt, q: Pt): Pt => [p[0] + q[0], p[1] + q[1]];
const scale = (p: Pt, s: number): Pt => [p[0] * s, p[1] * s];
const cross = (p: Pt, q: Pt): number => p[0] * q[1] - p[1] * q[0];
const dot   = (p: Pt, q: Pt): number => p[0] * q[0] + p[1] * q[1];

export const lineLength = (L: Line2D): number => Math.hypot(L.b[0] - L.a[0], L.b[1] - L.a[1]);
export const pointAt   = (L: Line2D, t: number): Pt => add(L.a, scale(sub(L.b, L.a), t));

/** Param t (on the infinite line) of the foot of perpendicular from p. */
export function paramOnLine(L: Line2D, p: Pt): number {
  const d = sub(L.b, L.a);
  const len2 = dot(d, d);
  if (len2 < EPS) return 0;
  return dot(sub(p, L.a), d) / len2;
}

// ── Raw intersections (infinite target line × cutter) ────────────────────────
// Returns t on the (infinite) target line; the cutter side is range-restricted
// (line cutter: s∈[0,1]; circle: implicit). Used by both bounded ops (filtered
// to t∈(0,1)) and Extend (which wants t outside [0,1]).

function tLineLineInfinite(L: Line2D, M: Line2D): number | null {
  const r = sub(L.b, L.a);
  const q = sub(M.b, M.a);
  const denom = cross(r, q);
  if (Math.abs(denom) < EPS) return null;          // parallel
  const ac = sub(M.a, L.a);
  const t = cross(ac, q) / denom;
  const s = cross(ac, r) / denom;
  if (s < -PARAM_EPS || s > 1 + PARAM_EPS) return null; // off the cutter segment
  return t;
}

function tLineCircleInfinite(L: Line2D, C: { c: Pt; r: number }): number[] {
  const d = sub(L.b, L.a);
  const f = sub(L.a, C.c);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const Cc = dot(f, f) - C.r * C.r;
  const disc = B * B - 4 * A * Cc;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const out = [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return Math.abs(disc) < EPS ? [out[0]] : out;
}

function rawParams(target: Line2D, cutters: Entity2D[]): number[] {
  const ts: number[] = [];
  for (const e of cutters) {
    if (e.kind === 'line') {
      const t = tLineLineInfinite(target, { a: e.a, b: e.b });
      if (t !== null) ts.push(t);
    } else if (e.kind === 'circle') {
      ts.push(...tLineCircleInfinite(target, e));
    } else if (e.kind === 'arc') { // circle crossings restricted to the arc's angular span
      const span = e.a2 - e.a1;
      for (const t of tLineCircleInfinite(target, { c: e.c, r: e.r })) {
        const rel = norm2pi(angleOf(e.c, pointAt(target, t)) - e.a1);
        if (rel > -PARAM_EPS && rel < span + PARAM_EPS) ts.push(t);
      }
    } else { // polyline cutter — test each chord segment
      for (let i = 0; i < e.pts.length - 1; i++) {
        const t = tLineLineInfinite(target, { a: e.pts[i], b: e.pts[i + 1] });
        if (t !== null) ts.push(t);
      }
    }
  }
  return ts;
}

/** Sorted, de-duplicated cut params that lie strictly inside the target (0,1). */
export function lineCutParams(target: Line2D, cutters: Entity2D[]): number[] {
  const inside = rawParams(target, cutters)
    .filter((t) => t > PARAM_EPS && t < 1 - PARAM_EPS)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of inside) if (!out.length || t - out[out.length - 1] > PARAM_EPS) out.push(t);
  return out;
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Break the line at every interior intersection → ≥1 sub-segments. */
export function splitLine(target: Line2D, cutters: Entity2D[]): Line2D[] {
  const ts = lineCutParams(target, cutters);
  if (!ts.length) return [target];
  const bounds = [0, ...ts, 1];
  const segs: Line2D[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = { a: pointAt(target, bounds[i]), b: pointAt(target, bounds[i + 1]) };
    if (lineLength(seg) > PARAM_EPS) segs.push(seg);
  }
  return segs;
}

/**
 * Trim: remove the portion of the line containing the click, bounded by the
 * nearest intersections on each side (or the line ends). Returns the surviving
 * segment(s) — 0 (whole line removed), 1, or 2.
 */
export function trimLine(target: Line2D, cutters: Entity2D[], clickT: number): Line2D[] {
  const ts = lineCutParams(target, cutters);
  const bounds = [0, ...ts, 1];
  const ct = Math.max(0, Math.min(1, clickT));
  // Find the [lo,hi] bracket that contains the click.
  let lo = 0, hi = 1;
  for (let i = 0; i < bounds.length - 1; i++) {
    if (ct >= bounds[i] - PARAM_EPS && ct <= bounds[i + 1] + PARAM_EPS) { lo = bounds[i]; hi = bounds[i + 1]; break; }
  }
  const survivors: Line2D[] = [];
  const left  = { a: pointAt(target, 0),  b: pointAt(target, lo) };
  const right = { a: pointAt(target, hi), b: pointAt(target, 1)  };
  if (lo > PARAM_EPS && lineLength(left) > PARAM_EPS)        survivors.push(left);
  if (hi < 1 - PARAM_EPS && lineLength(right) > PARAM_EPS)   survivors.push(right);
  return survivors;
}

/**
 * Extend the chosen endpoint of the line out to the nearest boundary it would
 * meet (a cutter line's segment or a circle). Returns the lengthened line, or
 * null when there is nothing ahead to meet.
 */
export function extendLine(target: Line2D, cutters: Entity2D[], end: 'a' | 'b'): Line2D | null {
  const ts = rawParams(target, cutters);
  if (end === 'b') {
    const ahead = ts.filter((t) => t > 1 + PARAM_EPS).sort((a, b) => a - b);
    if (!ahead.length) return null;
    return { a: target.a, b: pointAt(target, ahead[0]) };
  } else {
    const ahead = ts.filter((t) => t < -PARAM_EPS).sort((a, b) => b - a); // closest to 0 first
    if (!ahead.length) return null;
    return { a: pointAt(target, ahead[0]), b: target.b };
  }
}

// ── Circle/arc cutters → intersection points ──────────────────────────────────
// Geometry for circle & arc TARGETS: we work in angle space about the target's
// centre. First gather the 2D points where each cutter meets the target's circle
// (of radius R about C), respecting the cutter's own finite extent.

/** Points on the segment a→b that lie on the circle (C,R); s∈[0,1]. */
function circleSegPoints(C: Pt, R: number, a: Pt, b: Pt): Pt[] {
  const d = sub(b, a);
  const f = sub(a, C);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const Cc = dot(f, f) - R * R;
  const disc = B * B - 4 * A * Cc;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const ss = Math.abs(disc) < EPS ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ss.filter((s) => s > -PARAM_EPS && s < 1 + PARAM_EPS).map((s) => add(a, scale(d, s)));
}

/** Intersection points of two circles (0, 1 tangent, or 2). */
function circleCirclePoints(C1: Pt, R1: number, C2: Pt, R2: number): Pt[] {
  const dx = C2[0] - C1[0], dy = C2[1] - C1[1];
  const d = Math.hypot(dx, dy);
  if (d < EPS) return [];                                  // concentric
  if (d > R1 + R2 + EPS || d < Math.abs(R1 - R2) - EPS) return []; // disjoint / nested
  const aa = (R1 * R1 - R2 * R2 + d * d) / (2 * d);
  const h2 = R1 * R1 - aa * aa;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const ex = dx / d, ey = dy / d;
  const px = C1[0] + aa * ex, py = C1[1] + aa * ey;
  if (h < EPS) return [[px, py]];                          // tangent
  return [[px - h * ey, py + h * ex], [px + h * ey, py - h * ex]];
}

/** All points where the cutters meet the circle (C,R), honouring cutter extents. */
function cutterPointsOnCircle(C: Pt, R: number, cutters: Entity2D[]): Pt[] {
  const pts: Pt[] = [];
  for (const e of cutters) {
    if (e.kind === 'line') {
      pts.push(...circleSegPoints(C, R, e.a, e.b));
    } else if (e.kind === 'circle') {
      pts.push(...circleCirclePoints(C, R, e.c, e.r));
    } else if (e.kind === 'arc') { // keep crossings inside the cutter's angular span
      const span = e.a2 - e.a1;
      for (const p of circleCirclePoints(C, R, e.c, e.r)) {
        const rel = norm2pi(angleOf(e.c, p) - e.a1);
        if (rel > -PARAM_EPS && rel < span + PARAM_EPS) pts.push(p);
      }
    } else { // polyline cutter — crossings of each chord segment with the circle
      for (let i = 0; i < e.pts.length - 1; i++) pts.push(...circleSegPoints(C, R, e.pts[i], e.pts[i + 1]));
    }
  }
  return pts;
}

/** Sorted, de-duplicated cut angles on the full circle about C, in [0, 2π). */
export function circleCutAngles(C: Pt, R: number, cutters: Entity2D[]): number[] {
  const angs = cutterPointsOnCircle(C, R, cutters)
    .map((p) => norm2pi(angleOf(C, p)))
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const a of angs) if (!out.length || a - out[out.length - 1] > PARAM_EPS) out.push(a);
  // collapse a wrap-around duplicate (last ≈ first + 2π)
  if (out.length >= 2 && out[0] + TWO_PI - out[out.length - 1] < PARAM_EPS) out.pop();
  return out;
}

// ── Circle target ops ─────────────────────────────────────────────────────────

/** Break the circle at every cut angle → arcs. Needs ≥2 cuts (else []). */
export function splitCircle(circle: Circle2D, cutters: Entity2D[]): Arc2D[] {
  const angs = circleCutAngles(circle.c, circle.r, cutters);
  if (angs.length < 2) return [];
  const arcs: Arc2D[] = [];
  for (let i = 0; i < angs.length; i++) {
    const a1 = angs[i];
    const a2 = i + 1 < angs.length ? angs[i + 1] : angs[0] + TWO_PI;
    arcs.push({ c: circle.c, r: circle.r, a1, a2 });
  }
  return arcs;
}

/**
 * Trim a circle: remove the arc span containing the click angle, bounded by the
 * two nearest cut angles. The remainder survives as a single arc. Returns null
 * when there are fewer than 2 intersections (nothing to bound the cut).
 */
export function trimCircle(circle: Circle2D, cutters: Entity2D[], clickAngle: number): Arc2D[] | null {
  const angs = circleCutAngles(circle.c, circle.r, cutters);
  if (angs.length < 2) return null;
  const ca = norm2pi(clickAngle);
  // Locate the gap (cyclic) containing the click.
  let lo = angs[angs.length - 1], hi = angs[0] + TWO_PI;      // default: wrap gap
  for (let i = 0; i < angs.length - 1; i++) {
    if (ca >= angs[i] - PARAM_EPS && ca <= angs[i + 1] + PARAM_EPS) { lo = angs[i]; hi = angs[i + 1]; break; }
  }
  // Survivor = complement: CCW from hi back round to lo.
  let a1 = hi, a2 = lo + TWO_PI;
  while (a1 >= TWO_PI) { a1 -= TWO_PI; a2 -= TWO_PI; }
  return [{ c: circle.c, r: circle.r, a1, a2 }];
}

// ── Arc target ops ────────────────────────────────────────────────────────────

/** Cut angles strictly inside the arc span, as absolute angles, sorted. */
export function arcCutAngles(arc: Arc2D, cutters: Entity2D[]): number[] {
  const span = arc.a2 - arc.a1;
  const abs = cutterPointsOnCircle(arc.c, arc.r, cutters)
    .map((p) => arc.a1 + norm2pi(angleOf(arc.c, p) - arc.a1))
    .filter((a) => a - arc.a1 > PARAM_EPS && a < arc.a2 - PARAM_EPS && a - arc.a1 < span)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const a of abs) if (!out.length || a - out[out.length - 1] > PARAM_EPS) out.push(a);
  return out;
}

/** Break the arc at every interior cut → sub-arcs (≥1). */
export function splitArc(arc: Arc2D, cutters: Entity2D[]): Arc2D[] {
  const cuts = arcCutAngles(arc, cutters);
  if (!cuts.length) return [arc];
  const bounds = [arc.a1, ...cuts, arc.a2];
  const out: Arc2D[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > PARAM_EPS) out.push({ c: arc.c, r: arc.r, a1: bounds[i], a2: bounds[i + 1] });
  }
  return out;
}

/** Trim an arc: drop the clicked sub-span bounded by nearest cuts / arc ends. */
export function trimArc(arc: Arc2D, cutters: Entity2D[], clickAngle: number): Arc2D[] {
  const cuts = arcCutAngles(arc, cutters);
  const bounds = [arc.a1, ...cuts, arc.a2];
  const ca = arc.a1 + Math.max(0, Math.min(arc.a2 - arc.a1, norm2pi(clickAngle - arc.a1)));
  let lo = arc.a1, hi = arc.a2;
  for (let i = 0; i < bounds.length - 1; i++) {
    if (ca >= bounds[i] - PARAM_EPS && ca <= bounds[i + 1] + PARAM_EPS) { lo = bounds[i]; hi = bounds[i + 1]; break; }
  }
  const out: Arc2D[] = [];
  if (lo - arc.a1 > PARAM_EPS) out.push({ c: arc.c, r: arc.r, a1: arc.a1, a2: lo });
  if (arc.a2 - hi > PARAM_EPS) out.push({ c: arc.c, r: arc.r, a1: hi, a2: arc.a2 });
  return out;
}

/** Extend an arc end ('a'=start/a1 backwards CW, 'b'=end/a2 forwards CCW) to the next cut. */
export function extendArc(arc: Arc2D, cutters: Entity2D[], end: 'a' | 'b'): Arc2D | null {
  const pts = cutterPointsOnCircle(arc.c, arc.r, cutters);
  if (end === 'b') {
    const ahead = pts
      .map((p) => arc.a2 + norm2pi(angleOf(arc.c, p) - arc.a2))
      .filter((a) => a - arc.a2 > PARAM_EPS && a - arc.a2 < TWO_PI - PARAM_EPS)
      .sort((x, y) => x - y);
    if (!ahead.length) return null;
    return { c: arc.c, r: arc.r, a1: arc.a1, a2: ahead[0] };
  } else {
    const ahead = pts
      .map((p) => arc.a1 - norm2pi(arc.a1 - angleOf(arc.c, p)))
      .filter((a) => arc.a1 - a > PARAM_EPS && arc.a1 - a < TWO_PI - PARAM_EPS)
      .sort((x, y) => y - x);
    if (!ahead.length) return null;
    return { c: arc.c, r: arc.r, a1: ahead[0], a2: arc.a2 };
  }
}
