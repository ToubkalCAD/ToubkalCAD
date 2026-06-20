// ============================================================
// ToubkalCAD – solver/LegacySolverAdapter.ts
//
// Adapts the existing pure-TS Levenberg–Marquardt solver (SketchConstraintSolver)
// to ISketchSolver. Behaviour is byte-identical to calling solveConstraints
// directly — its signature already matches solve() exactly — so installing this
// adapter is a zero-risk refactor that only introduces the seam.
//
// It is also the reference oracle for validating new adapters (e.g. SolveSpace):
// run both over the same sketches and assert their solved geometry agrees.
// ============================================================

import type { ISketchSolver } from './ISketchSolver';
import { solveConstraints } from '../SketchConstraintSolver';

export class LegacySolverAdapter implements ISketchSolver {
  readonly id = 'legacy-lm';

  async init(): Promise<void> {
    /* pure TS — nothing to load */
  }

  solve = solveConstraints; // identical signature: (geoms, constraints, dragPin?) => SolveResult
}
