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
/** Axis-aligned ellipse (sketch-local frame): P(t)=(cu+rx·cos t, cv+ry·sin t). */
export interface Ellipse2D { c: Pt; rx: number; ry: number }
/** Ellipse arc, parameterised by ECCENTRIC angle t (a2 > a1). */
export interface EllipseArc2D { c: Pt; rx: number; ry: number; a1: number; a2: number }

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

/**
 * Recover an axis-aligned ellipse (sketch-local) from a closed polyline's points.
 * Returns {c,rx,ry} when the points actually lie on the implied ellipse (the
 * ellipse tool emits a 72-point sample, major along uAxis), else null. Lets the
 * trim editor treat a polyline ellipse analytically; freeform polylines fail the
 * residual check and stay segment-based.
 */
export function fitAxisAlignedEllipse(pts: Pt[]): { c: Pt; rx: number; ry: number } | null {
  if (!Array.isArray(pts) || pts.length < 8) return null;
  let minu = Infinity, maxu = -Infinity, minv = Infinity, maxv = -Infinity;
  for (const p of pts) {
    if (!p || p.length < 2) return null;
    if (p[0] < minu) minu = p[0]; if (p[0] > maxu) maxu = p[0];
    if (p[1] < minv) minv = p[1]; if (p[1] > maxv) maxv = p[1];
  }
  const cu = (minu + maxu) / 2, cv = (minv + maxv) / 2;
  const rx = (maxu - minu) / 2, ry = (maxv - minv) / 2;
  if (rx < 1e-6 || ry < 1e-6) return null;
  let maxDev = 0;
  for (const p of pts) {
    const du = (p[0] - cu) / rx, dv = (p[1] - cv) / ry;
    maxDev = Math.max(maxDev, Math.abs(du * du + dv * dv - 1));
  }
  return maxDev <= 0.02 ? { c: [cu, cv], rx, ry } : null;
}

// ── Ellipse / ellipse-arc target ops ──────────────────────────────────────────
// Mirrors the circle/arc ops but in ECCENTRIC-ANGLE space of an axis-aligned
// ellipse, so trimming/splitting an ellipse yields ellipse ARCS instead of
// exploding it into the 72 line segments of its polyline approximation.

/** Eccentric angle of point p on the ellipse (c,rx,ry). */
const ellipseParam = (c: Pt, rx: number, ry: number, p: Pt): number =>
  Math.atan2((p[1] - c[1]) / ry, (p[0] - c[0]) / rx);

/** Crossings of segment a→b with the ellipse — map to the unit circle and solve. */
function segEllipsePoints(c: Pt, rx: number, ry: number, a: Pt, b: Pt): Pt[] {
  const ax = (a[0] - c[0]) / rx, ay = (a[1] - c[1]) / ry;
  const bx = (b[0] - c[0]) / rx, by = (b[1] - c[1]) / ry;
  const dx = bx - ax, dy = by - ay;
  const A = dx * dx + dy * dy;
  if (A < EPS) return [];
  const B = 2 * (ax * dx + ay * dy);
  const C = ax * ax + ay * ay - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sd = Math.sqrt(disc);
  const out: Pt[] = [];
  for (const s of [(-B - sd) / (2 * A), (-B + sd) / (2 * A)]) {
    if (s >= -PARAM_EPS && s <= 1 + PARAM_EPS) out.push([c[0] + rx * (ax + s * dx), c[1] + ry * (ay + s * dy)]);
  }
  return out;
}

/** A cutter's drawn extent as straight chords (curves are sampled). */
function cutterSegments(e: Entity2D): [Pt, Pt][] {
  if (e.kind === 'line') return [[e.a, e.b]];
  if (e.kind === 'polyline') {
    const segs: [Pt, Pt][] = [];
    for (let i = 0; i < e.pts.length - 1; i++) segs.push([e.pts[i], e.pts[i + 1]]);
    return segs;
  }
  const a1 = e.kind === 'arc' ? e.a1 : 0;
  const a2 = e.kind === 'arc' ? e.a2 : TWO_PI;
  const N = 64;
  const cp = (a: number): Pt => [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)];
  const segs: [Pt, Pt][] = [];
  for (let i = 0; i < N; i++) segs.push([cp(a1 + ((a2 - a1) * i) / N), cp(a1 + ((a2 - a1) * (i + 1)) / N)]);
  return segs;
}

/** Crossing points of all cutters with the ellipse (c,rx,ry). */
function cutterPointsOnEllipse(c: Pt, rx: number, ry: number, cutters: Entity2D[]): Pt[] {
  const pts: Pt[] = [];
  for (const e of cutters) for (const [a, b] of cutterSegments(e)) pts.push(...segEllipsePoints(c, rx, ry, a, b));
  return pts;
}

/** Sorted, de-duplicated eccentric cut angles on the full ellipse, in [0,2π). */
export function ellipseCutAngles(c: Pt, rx: number, ry: number, cutters: Entity2D[]): number[] {
  const raw = cutterPointsOnEllipse(c, rx, ry, cutters).map((p) => norm2pi(ellipseParam(c, rx, ry, p))).sort((a, b) => a - b);
  const out: number[] = [];
  for (const a of raw) if (!out.length || a - out[out.length - 1] > PARAM_EPS) out.push(a);
  if (out.length >= 2 && TWO_PI - out[out.length - 1] + out[0] < PARAM_EPS) out.pop();
  return out;
}

/** Break the ellipse at every cut → ellipse arcs (needs ≥2 cuts, else []). */
export function splitEllipse(e: Ellipse2D, cutters: Entity2D[]): EllipseArc2D[] {
  const angs = ellipseCutAngles(e.c, e.rx, e.ry, cutters);
  if (angs.length < 2) return [];
  const arcs: EllipseArc2D[] = [];
  for (let i = 0; i < angs.length; i++) {
    const a1 = angs[i], a2 = i + 1 < angs.length ? angs[i + 1] : angs[0] + TWO_PI;
    if (a2 - a1 > PARAM_EPS) arcs.push({ c: e.c, rx: e.rx, ry: e.ry, a1, a2 });
  }
  return arcs;
}

/** Trim an ellipse: drop the eccentric span containing the click, keep the rest as one arc. */
export function trimEllipse(e: Ellipse2D, cutters: Entity2D[], clickParam: number): EllipseArc2D[] | null {
  const angs = ellipseCutAngles(e.c, e.rx, e.ry, cutters);
  if (angs.length < 2) return null;
  const ca = norm2pi(clickParam);
  let lo = angs[angs.length - 1], hi = angs[0] + TWO_PI;        // default: wrap gap
  for (let i = 0; i < angs.length - 1; i++) {
    if (ca >= angs[i] - PARAM_EPS && ca <= angs[i + 1] + PARAM_EPS) { lo = angs[i]; hi = angs[i + 1]; break; }
  }
  let a1 = hi, a2 = lo + TWO_PI;                                 // survivor = complement
  while (a1 >= TWO_PI) { a1 -= TWO_PI; a2 -= TWO_PI; }
  return [{ c: e.c, rx: e.rx, ry: e.ry, a1, a2 }];
}

/** Interior cut angles of an ellipse arc (eccentric, absolute, sorted). */
function ellipseArcCutAngles(arc: EllipseArc2D, cutters: Entity2D[]): number[] {
  const span = arc.a2 - arc.a1;
  const abs = cutterPointsOnEllipse(arc.c, arc.rx, arc.ry, cutters)
    .map((p) => arc.a1 + norm2pi(ellipseParam(arc.c, arc.rx, arc.ry, p) - arc.a1))
    .filter((a) => a - arc.a1 > PARAM_EPS && a < arc.a2 - PARAM_EPS && a - arc.a1 < span)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const a of abs) if (!out.length || a - out[out.length - 1] > PARAM_EPS) out.push(a);
  return out;
}

/** Break an ellipse arc at every interior cut → sub-arcs (≥1). */
export function splitEllipseArc(arc: EllipseArc2D, cutters: Entity2D[]): EllipseArc2D[] {
  const cuts = ellipseArcCutAngles(arc, cutters);
  if (!cuts.length) return [arc];
  const bounds = [arc.a1, ...cuts, arc.a2];
  const out: EllipseArc2D[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > PARAM_EPS) out.push({ c: arc.c, rx: arc.rx, ry: arc.ry, a1: bounds[i], a2: bounds[i + 1] });
  }
  return out;
}

/** Trim an ellipse arc: drop the clicked sub-span bounded by nearest cuts / ends. */
export function trimEllipseArc(arc: EllipseArc2D, cutters: Entity2D[], clickParam: number): EllipseArc2D[] {
  const cuts = ellipseArcCutAngles(arc, cutters);
  const bounds = [arc.a1, ...cuts, arc.a2];
  const ca = arc.a1 + Math.max(0, Math.min(arc.a2 - arc.a1, norm2pi(clickParam - arc.a1)));
  let lo = arc.a1, hi = arc.a2;
  for (let i = 0; i < bounds.length - 1; i++) {
    if (ca >= bounds[i] - PARAM_EPS && ca <= bounds[i + 1] + PARAM_EPS) { lo = bounds[i]; hi = bounds[i + 1]; break; }
  }
  const out: EllipseArc2D[] = [];
  if (lo - arc.a1 > PARAM_EPS) out.push({ c: arc.c, rx: arc.rx, ry: arc.ry, a1: arc.a1, a2: lo });
  if (arc.a2 - hi > PARAM_EPS) out.push({ c: arc.c, rx: arc.rx, ry: arc.ry, a1: hi, a2: arc.a2 });
  return out;
}

/** Extend an ellipse arc end to the next cut ('a'=start back, 'b'=end forward). */
export function extendEllipseArc(arc: EllipseArc2D, cutters: Entity2D[], end: 'a' | 'b'): EllipseArc2D | null {
  const pts = cutterPointsOnEllipse(arc.c, arc.rx, arc.ry, cutters);
  if (end === 'b') {
    const ahead = pts.map((p) => arc.a2 + norm2pi(ellipseParam(arc.c, arc.rx, arc.ry, p) - arc.a2))
      .filter((a) => a - arc.a2 > PARAM_EPS && a - arc.a2 < TWO_PI - PARAM_EPS).sort((x, y) => x - y);
    if (!ahead.length) return null;
    return { c: arc.c, rx: arc.rx, ry: arc.ry, a1: arc.a1, a2: ahead[0] };
  }
  const ahead = pts.map((p) => arc.a1 - norm2pi(arc.a1 - ellipseParam(arc.c, arc.rx, arc.ry, p)))
    .filter((a) => arc.a1 - a > PARAM_EPS && arc.a1 - a < TWO_PI - PARAM_EPS).sort((x, y) => y - x);
  if (!ahead.length) return null;
  return { c: arc.c, rx: arc.rx, ry: arc.ry, a1: ahead[0], a2: arc.a2 };
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

// ─── Corner fillet / chamfer (two straight segments sharing a vertex) ──────────

const VERT_EPS = 1e-6;   // two endpoints closer than this share a corner

/** Unit vector p→q, or null if degenerate. */
const unit = (p: Pt, q: Pt): Pt | null => {
  const d = sub(q, p);
  const L = Math.hypot(d[0], d[1]);
  return L < EPS ? null : [d[0] / L, d[1] / L];
};

/**
 * Resolve the corner two line segments form: the shared vertex V, each
 * segment's far endpoint, the unit directions V→far, and the lengths.
 * Returns null if the segments don't share an endpoint (within VERT_EPS).
 */
function resolveCorner(l1: Line2D, l2: Line2D):
  | { V: Pt; far1: Pt; far2: Pt; d1: Pt; d2: Pt; len1: number; len2: number; theta: number }
  | null {
  const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= VERT_EPS;
  let V: Pt | null = null, far1: Pt | null = null, far2: Pt | null = null;
  if      (near(l1.a, l2.a)) { V = l1.a; far1 = l1.b; far2 = l2.b; }
  else if (near(l1.a, l2.b)) { V = l1.a; far1 = l1.b; far2 = l2.a; }
  else if (near(l1.b, l2.a)) { V = l1.b; far1 = l1.a; far2 = l2.b; }
  else if (near(l1.b, l2.b)) { V = l1.b; far1 = l1.a; far2 = l2.a; }
  if (!V || !far1 || !far2) return null;

  const d1 = unit(V, far1), d2 = unit(V, far2);
  if (!d1 || !d2) return null;
  const len1 = Math.hypot(far1[0] - V[0], far1[1] - V[1]);
  const len2 = Math.hypot(far2[0] - V[0], far2[1] - V[1]);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));   // included angle ∈ (0,π)
  return { V, far1, far2, d1, d2, len1, len2, theta };
}

/**
 * Round the corner two segments form with an arc of the given radius. Returns
 * the two shortened segments plus the tangent fillet arc, or null when the
 * radius can't fit (segments too short, or collinear/degenerate corner).
 */
export function filletCorner(l1: Line2D, l2: Line2D, radius: number):
  | { lines: [Line2D, Line2D]; arc: Arc2D } | null {
  if (radius <= EPS) return null;
  const c = resolveCorner(l1, l2);
  if (!c) return null;
  const { V, far1, far2, d1, d2, len1, len2, theta } = c;
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return null;   // collinear → no corner

  const half = theta / 2;
  const setback    = radius / Math.tan(half);   // V→tangent-point distance along each edge
  const centreDist = radius / Math.sin(half);   // V→arc-centre distance along the bisector
  if (setback > len1 - EPS || setback > len2 - EPS) return null;   // radius too large

  const T1: Pt = add(V, scale(d1, setback));
  const T2: Pt = add(V, scale(d2, setback));
  const bis = unit([0, 0], add(d1, d2));        // interior bisector direction
  if (!bis) return null;
  const C: Pt = add(V, scale(bis, centreDist));

  // Emit the arc CCW with a2 > a1 and span < π (the fillet is always the minor
  // arc: included angle = π−θ). createArcEdge re-derives a CCW arc from the
  // endpoints, so the start (point @ a1) must be whichever tangent point makes
  // the CCW sweep the short way — else OCC would draw the major arc.
  const angT1 = angleOf(C, T1), angT2 = angleOf(C, T2);
  const ccw = ((angT2 - angT1) % TWO_PI + TWO_PI) % TWO_PI;   // CCW span T1→T2
  const arc: Arc2D = ccw <= Math.PI
    ? { c: C, r: radius, a1: angT1, a2: angT1 + ccw }                 // start = T1
    : { c: C, r: radius, a1: angT2, a2: angT2 + (TWO_PI - ccw) };     // start = T2

  return { lines: [{ a: far1, b: T1 }, { a: T2, b: far2 }], arc };
}

/**
 * Equal-distance bevel of the corner two segments form. Returns the two
 * shortened segments plus the connecting chamfer line, or null when the
 * distance can't fit (segments too short, or collinear/degenerate corner).
 */
export function chamferCorner(l1: Line2D, l2: Line2D, dist: number):
  | { lines: [Line2D, Line2D]; chamfer: Line2D } | null {
  if (dist <= EPS) return null;
  const c = resolveCorner(l1, l2);
  if (!c) return null;
  const { V, far1, far2, d1, d2, len1, len2, theta } = c;
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return null;
  if (dist > len1 - EPS || dist > len2 - EPS) return null;   // distance too large

  const T1: Pt = add(V, scale(d1, dist));
  const T2: Pt = add(V, scale(d2, dist));
  return {
    lines:   [{ a: far1, b: T1 }, { a: T2, b: far2 }],
    chamfer: { a: T1, b: T2 },
  };
}
