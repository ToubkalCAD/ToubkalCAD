// ============================================================
// ToubkalCAD – dimensionLayout.ts
//
// Pure 2D (workplane-local) layout for persistent dimension annotations. NO THREE,
// NO React — the same way sketchDraftDims.ts factors the live-draft geometry — so
// the math is testable in isolation and the THREE consumer (DimensionRenderer)
// stays a thin mapper from local-2D → world.
//
// Given a dimension's type, its constraint operands, the live solved geometry
// (EntityGeom[] straight from the solver/registry) and the user's drag `offset`,
// `layoutDimension` returns the extension lines, dimension line, arrowhead wings,
// label anchor and formatted text. Everything is recomputed from live geometry on
// every solve, so dimensions track the sketch as PlaneGCS moves it.
//
// Covered: DISTANCE point↔point (linear/aligned), DISTANCE point↔line, DISTANCE
// line↔line (normalised to point↔line), ANGLE line∠line, plus LENGTH and RADIUS.
// ============================================================

import type { EntityGeom } from './SketchConstraintSolver';
import type { SketchRef, DimensionType } from '../store/cadStore';

export type Pt = { x: number; y: number };
export type Seg = [Pt, Pt];

export interface DimLayout {
  witness:    Seg[];   // thin extension lines from the feature to the dimension line
  dim:        Seg[];    // the dimension line (a sampled polyline for ANGLE arcs)
  arrows:     Seg[];    // arrowhead wing segments
  labelLocal: Pt;       // where the value label sits
  anchor:     Pt;       // natural anchor the `offset` is measured from (for drag math)
  value:      number;   // measured magnitude (mm or degrees)
  text:       string;   // formatted label
}

// ── vector helpers ──────────────────────────────────────────────────────────────
const sub  = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add  = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul  = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot  = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len  = (a: Pt) => Math.hypot(a.x, a.y);
const mid  = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const norm = (a: Pt): Pt => { const L = len(a); return L < 1e-9 ? { x: 1, y: 0 } : { x: a.x / L, y: a.y / L }; };
const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });

/** Two arrowhead wing segments at `tip`, opening back along −`into`. */
function arrow(tip: Pt, into: Pt, size: number): Seg[] {
  const back = mul(into, -1);
  const rot = (v: Pt, a: number): Pt => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
  return [
    [tip, add(tip, mul(rot(back, 0.42), size))],
    [tip, add(tip, mul(rot(back, -0.42), size))],
  ];
}

// ── geometry resolvers (live solved EntityGeom → local-2D) ───────────────────────
const find = (geoms: EntityGeom[], id: string) => geoms.find((g) => g.id === id);

/** Resolve a SketchRef (entity or point) to its representative local-2D point. */
function resolvePoint(ref: SketchRef, geoms: EntityGeom[]): Pt | null {
  const g = find(geoms, ref.id);
  if (!g) return null;
  if (g.kind === 'line')    return ref.pt === 'b' ? { x: g.b[0], y: g.b[1] } : { x: g.a[0], y: g.a[1] };
  if (g.kind === 'circle' || g.kind === 'ellipse') return { x: g.c[0], y: g.c[1] };
  if (g.kind === 'arc') {
    if (ref.pt === 'a' || ref.pt === 'b') {
      const ang = ref.pt === 'a' ? g.a1 : g.a2;
      return { x: g.c[0] + g.r * Math.cos(ang), y: g.c[1] + g.r * Math.sin(ang) };
    }
    return { x: g.c[0], y: g.c[1] };
  }
  return null;
}

/** Resolve an entity ref to a line segment {a,b}, or null if it isn't a line. */
function resolveLine(ref: SketchRef, geoms: EntityGeom[]): { a: Pt; b: Pt } | null {
  const g = find(geoms, ref.id);
  return g?.kind === 'line' ? { a: { x: g.a[0], y: g.a[1] }, b: { x: g.b[0], y: g.b[1] } } : null;
}

const isLineEntity = (ref: SketchRef, geoms: EntityGeom[]) =>
  ref.kind === 'entity' && find(geoms, ref.id)?.kind === 'line';

/** Foot of the perpendicular from `p` onto the infinite line carrying segment a→b. */
function footOnLine(p: Pt, a: Pt, b: Pt): { foot: Pt; dist: number; n: Pt; dir: Pt } {
  const dir = norm(sub(b, a));
  const t = dot(sub(p, a), dir);
  const foot = add(a, mul(dir, t));
  const off = sub(p, foot);
  const dist = len(off);
  const n = dist < 1e-9 ? perp(dir) : norm(off);
  return { foot, dist, n, dir };
}

/** Intersection of the two infinite lines, or null if parallel. */
function lineIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1 = sub(a2, a1), d2 = sub(b2, b1);
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2.y - (b1.y - a1.y) * d2.x) / den;
  return add(a1, mul(d1, t));
}

const fmt = (type: DimensionType, v: number) =>
  type === 'ANGLE' ? `${v.toFixed(1)}°`
  : type === 'RADIUS' ? `R${v.toFixed(2)}`
  : v.toFixed(2);

// ── per-type layout ──────────────────────────────────────────────────────────────

/**
 * Linear dimension between two points, with STRICTLY ORTHOGONAL layout.
 *
 * The dimension line runs parallel to the measured segment a→b; the extension
 * (witness) lines run along its perpendicular. The free drag `offset` is projected
 * onto that perpendicular ONLY — the parallel component (sideways drag) is discarded
 * — so the witness lines can never skew and the dimension line can never slide along
 * the feature. All of this is computed in the plane's LOCAL (u,v) coordinates, so it
 * generalises to every workplane/datum automatically (fromLocal2D maps the local
 * axes onto that plane's own world axes):
 *   • horizontal segment (constant v) → witness along ±v (constant u), dim line constant v
 *   • vertical   segment (constant u) → witness along ±u (constant v), dim line constant u
 * On the ZX plane that is exactly "extension lines change only on Z / X match" for a
 * width, and the mirror for a height — with no diagonal skew.
 */
function linearBetween(type: DimensionType, a: Pt, b: Pt, offset: Pt, scale: number, displayValue?: number): DimLayout {
  const ar = 9 * scale, extOver = 4 * scale;
  const anchor = mid(a, b);
  const value = len(sub(b, a));

  const d = norm(sub(b, a));                 // dimension-line direction (along the segment)
  const w = perp(d);                          // witness direction (its perpendicular, unit)
  let o = dot(offset, w);                     // signed perpendicular standoff (parallel part dropped)
  if (Math.abs(o) < 1e-6) o = len(offset) || (30 * scale);   // degenerate drag → still clear the feature
  const s = o < 0 ? -1 : 1;
  const wo  = mul(w, o);                       // displacement from the feature to the dim line
  const end = mul(w, o + s * extOver);         // witness end: just past the dim line, same side

  // Endpoints sit on the perpendicular through each feature point → A shares a's
  // off-axis coordinate exactly, B shares b's. No sideways shift.
  const A = add(a, wo), B = add(b, wo);
  return {
    witness: [[a, add(a, end)], [b, add(b, end)]],   // strictly along the perpendicular
    dim:     [[A, B]],                                // strictly parallel to the segment
    arrows:  [...arrow(A, d, ar), ...arrow(B, mul(d, -1), ar)],
    labelLocal: mid(A, B),
    anchor,
    value,
    text: fmt(type, displayValue ?? value),
  };
}

/** Perpendicular dimension from a point to a line. */
function pointToLine(p: Pt, a: Pt, b: Pt, offset: Pt, scale: number, displayValue?: number): DimLayout {
  const ar = 9 * scale;
  const { foot, dist, dir } = footOnLine(p, a, b);
  const anchor = mid(foot, p);
  const slide = dot(offset, dir);           // only the along-line component slides the dim line
  const t = mul(dir, slide);
  const A = add(foot, t);                    // on the line
  const B = add(p, t);                       // at the point
  const segDir = norm(sub(B, A));
  return {
    witness: [[foot, A], [p, B]],
    dim:     [[A, B]],
    arrows:  [...arrow(A, segDir, ar), ...arrow(B, mul(segDir, -1), ar)],
    labelLocal: mid(A, B),
    anchor,
    value: dist,
    text: fmt('DISTANCE', displayValue ?? dist),
  };
}

/**
 * Directional (orthogonal) dimension between two points: measures ONLY the local
 * axis delta — ΔX (axis='x') or ΔY (axis='y') — regardless of the points' true
 * separation. The dimension line is axis-aligned and the witness lines drop along
 * the OTHER axis from each point to it. The relevant offset component positions the
 * dimension line (vertical standoff for ΔX, horizontal for ΔY). Everything is in the
 * plane's local (u=x, v=y) coords, so it stays correct on any workplane/datum.
 */
function axisDim(axis: 'x' | 'y', p1: Pt, p2: Pt, offset: Pt, scale: number, displayValue?: number): DimLayout {
  const ar = 9 * scale, over = 4 * scale;
  const anchor = mid(p1, p2);
  if (axis === 'x') {
    const raw = offset.y;                                   // vertical standoff (local v)
    const o = Math.abs(raw) < 1e-6 ? 30 * scale : raw;
    const dimV = anchor.y + o, s = o < 0 ? -1 : 1;
    const A = { x: p1.x, y: dimV }, B = { x: p2.x, y: dimV };
    const d = norm(sub(B, A));
    return {
      witness: [[p1, { x: p1.x, y: dimV + s * over }], [p2, { x: p2.x, y: dimV + s * over }]],
      dim:     [[A, B]],
      arrows:  [...arrow(A, d, ar), ...arrow(B, mul(d, -1), ar)],
      labelLocal: mid(A, B),
      anchor,
      value: Math.abs(p2.x - p1.x),
      text: fmt('DISTANCE', displayValue ?? Math.abs(p2.x - p1.x)),
    };
  }
  const raw = offset.x;                                     // horizontal standoff (local u)
  const o = Math.abs(raw) < 1e-6 ? 30 * scale : raw;
  const dimU = anchor.x + o, s = o < 0 ? -1 : 1;
  const A = { x: dimU, y: p1.y }, B = { x: dimU, y: p2.y };
  const d = norm(sub(B, A));
  return {
    witness: [[p1, { x: dimU + s * over, y: p1.y }], [p2, { x: dimU + s * over, y: p2.y }]],
    dim:     [[A, B]],
    arrows:  [...arrow(A, d, ar), ...arrow(B, mul(d, -1), ar)],
    labelLocal: mid(A, B),
    anchor,
    value: Math.abs(p2.y - p1.y),
    text: fmt('DISTANCE', displayValue ?? Math.abs(p2.y - p1.y)),
  };
}

/** Radial leader from a circle/arc centre to its rim. */
function radial(c: Pt, r: number, offset: Pt, scale: number, displayValue?: number): DimLayout {
  const ar = 9 * scale;
  const d = norm(offset || { x: 1, y: 0 });
  const rim = add(c, mul(d, r));
  return {
    witness: [],
    dim:     [[c, rim]],
    arrows:  [...arrow(rim, d, ar)],
    labelLocal: add(rim, mul(d, 6 * scale)),
    anchor: c,
    value: r,
    text: fmt('RADIUS', displayValue ?? r),
  };
}

/** Angular dimension between two lines: an arc at radius |offset| around their vertex. */
function angular(la: { a: Pt; b: Pt }, lb: { a: Pt; b: Pt }, offset: Pt, scale: number, displayValue?: number): DimLayout | null {
  const v = lineIntersect(la.a, la.b, lb.a, lb.b);
  if (!v) return null;                       // parallel → no angle
  const ar = 9 * scale;
  // unit directions of each line pointing AWAY from the vertex
  const dirAway = (l: { a: Pt; b: Pt }) => {
    const da = norm(sub(l.a, v)), db = norm(sub(l.b, v));
    return len(sub(l.a, v)) >= len(sub(l.b, v)) ? da : db;
  };
  const d1 = dirAway(la), d2 = dirAway(lb);
  let a1 = Math.atan2(d1.y, d1.x), a2 = Math.atan2(d2.y, d2.x);
  let sweep = a2 - a1;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  const value = Math.abs(sweep) * 180 / Math.PI;
  const R = Math.max(len(offset), 8 * scale);
  // sample the arc as short segments for the dimension line
  const dim: Seg[] = [];
  const SEG = 24;
  let prev: Pt | null = null;
  for (let i = 0; i <= SEG; i++) {
    const ang = a1 + sweep * (i / SEG);
    const pt = add(v, { x: R * Math.cos(ang), y: R * Math.sin(ang) });
    if (prev) dim.push([prev, pt]);
    prev = pt;
  }
  const end1 = add(v, { x: R * Math.cos(a1), y: R * Math.sin(a1) });
  const end2 = add(v, { x: R * Math.cos(a2), y: R * Math.sin(a2) });
  // arrow tangents at the arc ends (perpendicular to the radius, along the sweep)
  const tan1 = perp(norm(sub(end1, v)));
  const tan2 = perp(norm(sub(end2, v)));
  const s = Math.sign(sweep) || 1;
  const midAng = a1 + sweep / 2;
  return {
    witness: [[v, end1], [v, end2]],
    dim,
    arrows:  [...arrow(end1, mul(tan1, s), ar), ...arrow(end2, mul(tan2, -s), ar)],
    labelLocal: add(v, { x: (R + 6 * scale) * Math.cos(midAng), y: (R + 6 * scale) * Math.sin(midAng) }),
    anchor: v,
    value,
    text: fmt('ANGLE', displayValue ?? value),
  };
}

/**
 * Build the local-2D layout for one dimension. `offset` is the user's drag vector
 * (local units) from the dimension's natural anchor; `scale` is world-units-per-
 * pixel so arrowheads stay screen-constant. `displayValue` (the driving constraint
 * value) overrides the measured text when supplied.
 */
export function layoutDimension(
  type: DimensionType,
  refs: SketchRef[],
  offset: { u: number; v: number },
  geoms: EntityGeom[],
  scale = 1,
  displayValue?: number,
): DimLayout | null {
  const off: Pt = { x: offset.u, y: offset.v };

  if (type === 'LENGTH') {
    const ln = refs[0] && resolveLine(refs[0], geoms);
    return ln ? linearBetween('LENGTH', ln.a, ln.b, off, scale, displayValue) : null;
  }

  if (type === 'RADIUS') {
    const g = refs[0] && find(geoms, refs[0].id);
    if (g && (g.kind === 'circle' || g.kind === 'arc')) return radial({ x: g.c[0], y: g.c[1] }, g.r, off, scale, displayValue);
    return null;
  }

  if (type === 'ANGLE') {
    const la = refs[0] && resolveLine(refs[0], geoms);
    const lb = refs[1] && resolveLine(refs[1], geoms);
    return la && lb ? angular(la, lb, off, scale, displayValue) : null;
  }

  if (type === 'DISTANCE_X' || type === 'DISTANCE_Y') {
    const p0 = refs[0] && resolvePoint(refs[0], geoms);
    const p1 = refs[1] && resolvePoint(refs[1], geoms);
    return p0 && p1 ? axisDim(type === 'DISTANCE_X' ? 'x' : 'y', p0, p1, off, scale, displayValue) : null;
  }

  // DISTANCE — normalise line↔line to point↔line; handle point↔point and point↔line.
  if (type === 'DISTANCE') {
    let [r0, r1] = refs;
    if (!r0 || !r1) return null;
    if (isLineEntity(r0, geoms) && isLineEntity(r1, geoms)) {
      // measure the START point of one line to the other infinite line
      r0 = { kind: 'point', id: r0.id, pt: 'a' };
      // r1 stays the line entity
    }
    const ln0 = isLineEntity(r0, geoms) ? resolveLine(r0, geoms) : null;
    const ln1 = isLineEntity(r1, geoms) ? resolveLine(r1, geoms) : null;
    if (ln1 && !ln0) { const p = resolvePoint(r0, geoms); return p ? pointToLine(p, ln1.a, ln1.b, off, scale, displayValue) : null; }
    if (ln0 && !ln1) { const p = resolvePoint(r1, geoms); return p ? pointToLine(p, ln0.a, ln0.b, off, scale, displayValue) : null; }
    const p0 = resolvePoint(r0, geoms), p1 = resolvePoint(r1, geoms);
    return p0 && p1 ? linearBetween('DISTANCE', p0, p1, off, scale, displayValue) : null;
  }

  return null;
}

/** The natural anchor for a dimension — used to seed/drag the `offset`. Mirrors the
 *  anchor each layout function reports, without building the full layout. */
export function dimensionAnchor(type: DimensionType, refs: SketchRef[], geoms: EntityGeom[]): Pt | null {
  const l = layoutDimension(type, refs, { u: 0, v: 0 }, geoms, 1);
  return l ? l.anchor : null;
}
