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

// NOTE: SolveSpaceSolverAdapter is deliberately NOT re-exported here. This
// barrel is in the app's import graph (ConstraintPanel/useCADConstraintPick →
// getSolver), and the adapter statically imports the WASM glue (./wasm/libslvs),
// which does not exist until native/slvs/build.sh has run — re-exporting it
// would break `npm run dev`/`build` with a "Can't resolve ./libslvs" error and
// would also pull the solver WASM into the main bundle.
//
// Once the WASM is built, wire it lazily so it stays in its own chunk, e.g.:
//   const { SolveSpaceSolverAdapter } = await import('./SolveSpaceSolverAdapter');
//   await installSolver(new SolveSpaceSolverAdapter());
