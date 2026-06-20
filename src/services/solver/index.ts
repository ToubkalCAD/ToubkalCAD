// ============================================================
// ToubkalCAD – solver/index.ts
//
// The solver registry: the single place that decides WHICH ISketchSolver is
// live. Call sites use only getSolver(); they never name a concrete solver.
//
// To switch solvers (once a SolveSpaceSolverAdapter exists), call
//   await installSolver(new SolveSpaceSolverAdapter());
// from app startup (src/index.tsx) — ideally behind a flag so falling back to
// the legacy solver is just "don't call installSolver".
// ============================================================

import type { ISketchSolver, ISolveSession } from './ISketchSolver';
import { LegacySolverAdapter } from './LegacySolverAdapter';

let active: ISketchSolver = new LegacySolverAdapter();

/** The currently-installed solver. The only solver accessor call sites use. */
export const getSolver = (): ISketchSolver => active;

/** Swap the live solver. Awaits init() before making it active. */
export async function installSolver(solver: ISketchSolver): Promise<void> {
  await solver.init();
  active = solver;
}

export type { ISketchSolver, ISolveSession };
export { LegacySolverAdapter };
export { SolveSpaceSolverAdapter } from './SolveSpaceSolverAdapter';
