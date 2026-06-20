// ============================================================
// ToubkalCAD – SketchDatums.ts
//
// Phase 8 – virtual reference datums for the 2D constraint solver.
//
// Every sketch carries an implicit Origin (0,0) and two infinite axes (U, V)
// in its local plane. They are NOT real sketch entities — no node, no OCC wire,
// no degrees of freedom — but they ARE selectable so geometry can be pinned to
// them (Coincident-to-origin, Distance-to-axis, Angle-to-axis, …).
//
// They reach the solver as two FIXED `line` geoms injected only at solve time
// (see ConstraintPanel.solveAndApply). The Origin is exposed as the U axis's
// 'a' endpoint, which sits at (0,0). Because they are FIXED they contribute
// equal vars and pinned vars → net zero DoF, so they never appear in the
// real-entity DoF accounting.
// ============================================================

import type { EntityGeom } from './SketchConstraintSolver';
import type { SketchConstraint, SketchRef } from '../store/cadStore';

export const DATUM_UAXIS = '__datum_uaxis__';
export const DATUM_VAXIS = '__datum_vaxis__';

// Long but finite: perpendicular-distance residuals normalise by direction, so
// length is irrelevant to the solver; this only bounds the axis as a segment.
const AXIS_LEN = 1e4;

export const isDatumId = (id: string): boolean => id === DATUM_UAXIS || id === DATUM_VAXIS;

/** The canonical Origin operand — the U axis's start endpoint, pinned at (0,0). */
export const ORIGIN_REF: SketchRef = { kind: 'point', id: DATUM_UAXIS, pt: 'a' };

/** Fixed reference axis lines through the origin, in local 2D. */
export function datumGeoms(): EntityGeom[] {
  return [
    { id: DATUM_UAXIS, kind: 'line', a: [0, 0], b: [AXIS_LEN, 0] },
    { id: DATUM_VAXIS, kind: 'line', a: [0, 0], b: [0, AXIS_LEN] },
  ];
}

/** FIXED constraints pinning the datum axes — appended to the solver's list. */
export function datumFixedConstraints(): SketchConstraint[] {
  return [
    { id: '__fix_uaxis__', type: 'FIXED', refs: [{ kind: 'entity', id: DATUM_UAXIS }] },
    { id: '__fix_vaxis__', type: 'FIXED', refs: [{ kind: 'entity', id: DATUM_VAXIS }] },
  ];
}

/** Human label for a datum ref (used in the panel's applied-constraint list). */
export function datumLabel(ref: SketchRef): string | null {
  if (ref.id === DATUM_UAXIS) return ref.kind === 'point' && ref.pt === 'a' ? 'Origin' : 'U axis';
  if (ref.id === DATUM_VAXIS) return 'V axis';
  return null;
}
