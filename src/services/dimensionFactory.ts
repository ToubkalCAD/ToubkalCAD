// ============================================================
// ToubkalCAD – dimensionFactory.ts
//
// Builds a driving dimensional SketchConstraint (+ its visual DimensionAnnotation)
// from a viewport selection. Shared by ConstraintPanel (button-driven) and the
// Smart Dimension tool (click-driven) so the "deduce intent → seed value →
// normalise refs" logic lives in exactly one place.
//
// Intent rules (Fusion-style Smart Dimension):
//   1 line                         → LENGTH
//   1 circle / arc                 → RADIUS
//   2 points                       → DISTANCE (aligned)
//   point + line                   → DISTANCE (perpendicular)
//   2 parallel lines               → DISTANCE (normalised to point↔line)
//   2 intersecting lines           → ANGLE
// ============================================================

import type { SketchRef, SketchConstraint, DimensionType, DimensionAnnotation } from '../store/cadStore';
import type { EntityGeom } from './SketchConstraintSolver';
import { isDatumId } from './SketchDatums';
import { dimensionAnchor } from './dimensionLayout';

const find = (geoms: EntityGeom[], id: string) => geoms.find((g) => g.id === id);
const isLine = (r: SketchRef, geoms: EntityGeom[]) => r.kind === 'entity' && find(geoms, r.id)?.kind === 'line';

function resolvePoint(r: SketchRef, geoms: EntityGeom[]): [number, number] | null {
  const g = find(geoms, r.id);
  if (!g) return null;
  if (g.kind === 'line')   return r.pt === 'b' ? g.b : g.a;
  if (g.kind === 'circle' || g.kind === 'ellipse') return g.c;
  if (g.kind === 'arc') {
    if (r.pt === 'a' || r.pt === 'b') { const a = r.pt === 'a' ? g.a1 : g.a2; return [g.c[0] + g.r * Math.cos(a), g.c[1] + g.r * Math.sin(a)]; }
    return g.c;
  }
  return null;
}

function perpDistToLine(p: [number, number], line: EntityGeom): number {
  if (line.kind !== 'line') return 0;
  const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1];
  const n = Math.hypot(dx, dy) || 1;
  return Math.abs((p[0] - line.a[0]) * -dy + (p[1] - line.a[1]) * dx) / n;
}

const dirOf = (g: EntityGeom): [number, number] | null =>
  g.kind === 'line' ? [g.b[0] - g.a[0], g.b[1] - g.a[1]] : null;

const angleBetween = (u: [number, number], v: [number, number]) =>
  Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]));

/** Two lines are "parallel" (→ DISTANCE) vs "intersecting" (→ ANGLE). */
function twoLineIntent(a: EntityGeom, b: EntityGeom): 'DISTANCE' | 'ANGLE' {
  const da = dirOf(a), db = dirOf(b);
  if (!da || !db) return 'DISTANCE';
  const ang = angleBetween(da, db);
  const dev = Math.min(ang, Math.PI - ang);   // 0 = parallel, π/2 = perpendicular
  return dev < 0.087 ? 'DISTANCE' : 'ANGLE';  // < ~5° apart → parallel
}

/** Deduce the dimension type a selection should produce, or null if it can't. */
export function inferDimensionType(sel: SketchRef[], geoms: EntityGeom[]): DimensionType | null {
  if (sel.length === 1) {
    const g = find(geoms, sel[0].id);
    if (!g) return null;
    if (sel[0].kind === 'entity' && g.kind === 'line') return 'LENGTH';
    if (g.kind === 'circle' || g.kind === 'arc') return 'RADIUS';
    return null;
  }
  if (sel.length === 2) {
    const ga = find(geoms, sel[0].id), gb = find(geoms, sel[1].id);
    if (!ga || !gb) return null;
    const aLine = isLine(sel[0], geoms), bLine = isLine(sel[1], geoms);
    if (aLine && bLine) return twoLineIntent(ga, gb);
    return 'DISTANCE';   // point↔point or point↔line
  }
  return null;
}

/** DISTANCE between two lines → point↔line (the form both solvers support). */
function normalizeDistanceRefs(sel: SketchRef[], geoms: EntityGeom[]): SketchRef[] {
  if (sel.length !== 2 || !isLine(sel[0], geoms) || !isLine(sel[1], geoms)) return sel.map((r) => ({ ...r }));
  const ptIdx = isDatumId(sel[0].id) ? 1 : 0;     // never take the point from a datum axis
  const lineIdx = ptIdx === 0 ? 1 : 0;
  return [{ kind: 'point', id: sel[ptIdx].id, pt: 'a' }, { kind: 'entity', id: sel[lineIdx].id }];
}

function seedValue(type: DimensionType, refs: SketchRef[], geoms: EntityGeom[]): number | undefined {
  if (type === 'DISTANCE_X' || type === 'DISTANCE_Y') {
    const p0 = refs[0] && resolvePoint(refs[0], geoms), p1 = refs[1] && resolvePoint(refs[1], geoms);
    if (!p0 || !p1) return 10;
    return Math.abs(type === 'DISTANCE_X' ? p1[0] - p0[0] : p1[1] - p0[1]);
  }
  if (type === 'LENGTH') {
    const g = find(geoms, refs[0].id);
    return g?.kind === 'line' ? Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) : undefined;
  }
  if (type === 'RADIUS') {
    const g = find(geoms, refs[0].id);
    return (g?.kind === 'circle' || g?.kind === 'arc') ? g.r : undefined;
  }
  if (type === 'ANGLE') {
    const a = find(geoms, refs[0].id), b = find(geoms, refs[1].id);
    const da = a && dirOf(a), db = b && dirOf(b);
    return da && db ? angleBetween(da, db) * 180 / Math.PI : 90;
  }
  // DISTANCE — perpendicular for point↔line, Euclidean for point↔point.
  const [a, b] = refs;
  const ga = find(geoms, a?.id), gb = find(geoms, b?.id);
  const aLine = a?.kind === 'entity' && ga?.kind === 'line';
  const bLine = b?.kind === 'entity' && gb?.kind === 'line';
  if (bLine && !aLine) { const p = resolvePoint(a, geoms); return p ? perpDistToLine(p, gb!) : 10; }
  if (aLine && !bLine) { const p = resolvePoint(b, geoms); return p ? perpDistToLine(p, ga!) : 10; }
  const p1 = resolvePoint(a, geoms), p2 = resolvePoint(b, geoms);
  return p1 && p2 ? Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) : 10;
}

export interface BuiltDimension {
  constraint: SketchConstraint;
  type: DimensionType;
}

/** True when both operands are POINTS (incl. circle/arc centres), never a line. */
function isPointPair(refs: SketchRef[], geoms: EntityGeom[]): boolean {
  return refs.length === 2 && !isLine(refs[0], geoms) && !isLine(refs[1], geoms)
    && !!resolvePoint(refs[0], geoms) && !!resolvePoint(refs[1], geoms);
}

/**
 * Directional dimensioning (the cursor decides the measurement axis). Given the two
 * points and the live cursor — all in sketch-plane LOCAL coords — pick:
 *   • ΔX (DISTANCE_X) when the cursor sits clearly ABOVE/BELOW the points,
 *   • ΔY (DISTANCE_Y) when it sits clearly to the LEFT/RIGHT,
 *   • aligned (DISTANCE) when it's in the diagonal band between those cones.
 * Implemented as ±30° cones around each axis of the cursor→midpoint vector.
 */
export function directionalDistanceMode(p1: { x: number; y: number }, p2: { x: number; y: number }, mouse: { x: number; y: number }): DimensionType {
  const mx = mouse.x - (p1.x + p2.x) / 2;
  const my = mouse.y - (p1.y + p2.y) / 2;
  const TAN60 = Math.tan(Math.PI / 3);                 // 1.732 → ±30° cone half-angle
  if (Math.abs(my) > Math.abs(mx) * TAN60) return 'DISTANCE_X';   // cursor above/below → measure ΔX
  if (Math.abs(mx) > Math.abs(my) * TAN60) return 'DISTANCE_Y';   // cursor left/right → measure ΔY
  return 'DISTANCE';                                              // diagonal → aligned (true distance)
}

/**
 * Build the driving constraint for a selection (refs normalised, value seeded).
 * When `mouse` (local 2D) is supplied and the selection is a pure point↔point pair,
 * the cursor direction promotes the aligned DISTANCE to a directional ΔX/ΔY one and
 * orders the refs so the driven value stays a positive magnitude.
 */
export function buildDimensionConstraint(sel: SketchRef[], geoms: EntityGeom[], mouse?: { x: number; y: number }): BuiltDimension | null {
  const base = inferDimensionType(sel, geoms);
  if (!base) return null;
  let type = base;
  let refs = base === 'DISTANCE' ? normalizeDistanceRefs(sel, geoms) : sel.map((r) => ({ ...r }));

  if (base === 'DISTANCE' && mouse && isPointPair(refs, geoms)) {
    const p0 = resolvePoint(refs[0], geoms)!, p1 = resolvePoint(refs[1], geoms)!;
    const mode = directionalDistanceMode({ x: p0[0], y: p0[1] }, { x: p1[0], y: p1[1] }, mouse);
    if (mode === 'DISTANCE_X') { type = 'DISTANCE_X'; if (p1[0] < p0[0]) refs = [refs[1], refs[0]]; }
    else if (mode === 'DISTANCE_Y') { type = 'DISTANCE_Y'; if (p1[1] < p0[1]) refs = [refs[1], refs[0]]; }
  }

  const value = seedValue(type, refs, geoms);
  return { constraint: { id: crypto.randomUUID(), type, refs, value }, type };
}

/** A default standoff offset so a freshly-created dimension clears its geometry. */
export function defaultDimensionOffset(type: DimensionType, refs: SketchRef[], geoms: EntityGeom[], standoff: number): { u: number; v: number } {
  if (type === 'DISTANCE_X') return { u: 0, v: standoff };   // horizontal dim line lifted up; vertical witnesses
  if (type === 'DISTANCE_Y') return { u: standoff, v: 0 };   // vertical dim line to the side; horizontal witnesses
  if (type === 'LENGTH' || (type === 'DISTANCE')) {
    // lift linear dims perpendicular to the measured direction
    const g0 = find(geoms, refs[0].id);
    let dir: [number, number] = [1, 0];
    if (g0?.kind === 'line') dir = [g0.b[0] - g0.a[0], g0.b[1] - g0.a[1]];
    else {
      const p0 = resolvePoint(refs[0], geoms), p1 = refs[1] && resolvePoint(refs[1], geoms);
      if (p0 && p1) dir = [p1[0] - p0[0], p1[1] - p0[1]];
    }
    const L = Math.hypot(dir[0], dir[1]) || 1;
    return { u: (-dir[1] / L) * standoff, v: (dir[0] / L) * standoff };
  }
  // RADIUS / ANGLE — a diagonal standoff reads cleanly
  const k = standoff * Math.SQRT1_2;
  return { u: k, v: k };
}

/** Compose the persisted annotation record for a built constraint. */
export function makeAnnotation(c: SketchConstraint, offset: { u: number; v: number }): DimensionAnnotation {
  return { id: crypto.randomUUID(), constraintId: c.id, type: c.type as DimensionType, refs: c.refs, offset };
}

export { dimensionAnchor };
