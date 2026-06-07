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
  | { kind: 'circle'; c: Pt; r: number };
export interface Line2D { a: Pt; b: Pt }

const EPS       = 1e-9;   // geometric zero
const PARAM_EPS = 1e-4;   // param-space tolerance (endpoint / dedupe)

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
    } else {
      ts.push(...tLineCircleInfinite(target, e));
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
