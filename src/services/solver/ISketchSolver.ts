// ============================================================
// ToubkalCAD – solver/ISketchSolver.ts
//
// The single seam between ToubkalCAD's sketch layer and any geometric
// constraint solver. Implementations translate EntityGeom/SketchConstraint
// into their native model, solve, and read coordinates back into EntityGeom.
//
// Nothing solver-specific ever crosses this boundary: everything the solver
// needs is in the arguments, everything the app needs is in SolveResult.
// Downstream (SketchSolveBridge, ConstraintPanel, useCADConstraintPick) speaks
// only EntityGeom / SketchConstraint / SolveResult, so the solver behind this
// interface can be swapped with zero changes there.
// ============================================================

import type { EntityGeom, DragPin, SolveResult } from './model';
import type { SketchConstraint, SketchRef } from '../../store/cadStore';

export interface ISketchSolver {
  /** Stable identifier (telemetry / debugging / A-B switch). */
  readonly id: string;

  /** Load/warm up (e.g. WASM). No-op for the pure-TS solvers. Idempotent. */
  init(): Promise<void>;

  /**
   * One-shot solve. MUST be synchronous — it is called once per animation
   * frame during a live drag, so it cannot return a Promise.
   *
   * @param dragPin optional live-drag objective: bias one point toward a cursor.
   * @returns solved geometry keyed by entity id, plus convergence info.
   */
  solve(
    geoms: EntityGeom[],
    constraints: SketchConstraint[],
    dragPin?: DragPin,
  ): SolveResult;

  /**
   * OPTIONAL drag fast-path. When present, the drag hook builds the system once
   * on pointer-down and only pushes the cursor each frame — avoids rebuilding
   * the whole constraint system ~60×/s. Solvers that don't implement it fall
   * back to repeated solve() calls with a dragPin.
   */
  beginSession?(geoms: EntityGeom[], constraints: SketchConstraint[]): ISolveSession;
}

export interface ISolveSession {
  /** Re-solve with the dragged point biased to `target`. */
  drag(ref: SketchRef, target: [number, number]): SolveResult;
  /** Release any retained native/system state. */
  dispose(): void;
}
