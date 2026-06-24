// ============================================================
// ToubkalCAD – SketchSolve.ts
//
// The single orchestration path for "apply a constraint set to a sketch and make
// the geometry follow". Extracted from ConstraintPanel so the panel, the Smart
// Dimension tool, and the inline value editor all drive PlaneGCS through exactly
// one code path (no duplicated solve/rebuild/propagate logic, no value drift).
//
//   applySketchConstraints(sketchId, next):
//     1. collect the sketch's solver geometry + datum/construction fixities,
//     2. solve with the active ISketchSolver (PlaneGCS),
//     3. rebuild every entity whose solved geometry changed (OCC wire + visual),
//     4. persist params.constraints, publish DoF status, propagate to dependents.
// ============================================================

import { useCADStore } from '../store/cadStore';
import type { SketchConstraint } from '../store/cadStore';
import { propagateFromStore } from './RecomputeEngine.live';
import { computeDoF } from './SketchConstraintSolver';
import { getSolver } from './solver';
import { datumGeoms, datumFixedConstraints, isDatumId } from './SketchDatums';
import { collectSolverGeoms, constructionFixedConstraints, rebuildSketchEntity, geomKey } from './SketchSolveBridge';

export interface SketchSolveResult {
  ok: boolean;
  converged: boolean;
  residual: number;
  rebuilt: number;
  changed: string[];
  dof: number;
  state: 'under' | 'full' | 'over' | 'conflict';
  message: string;
}

/**
 * Sketch entities the variational solver does not model (sampled polylines etc.)
 * still occupy real DoF — count them as free rigid bodies so a sketch holding only
 * a rectangle doesn't falsely report "fully constrained". (Ellipses ARE modelled.)
 */
function unsupportedDoF(sketchId: string): number {
  const st = useCADStore.getState();
  let dof = 0;
  for (const id of st.nodes[sketchId]?.children ?? []) {
    const g = st.nodes[id]?.params?.sketchGeom;
    if (g && g.kind !== 'line' && g.kind !== 'circle' && g.kind !== 'arc' && !(g.kind === 'polyline' && g.ellipse)) dof += 3;
  }
  return dof;
}

export function applySketchConstraints(sketchId: string, next: SketchConstraint[]): SketchSolveResult {
  const fail = (message: string): SketchSolveResult =>
    ({ ok: false, converged: false, residual: NaN, rebuilt: 0, changed: [], dof: 0, state: 'under', message });

  const before = collectSolverGeoms(sketchId);
  if (!before.length) return fail('No constrainable Line/Circle entities yet.');

  const beforeKey = new Map(before.map((g) => [g.id, geomKey(g)]));
  let res;
  try {
    res = getSolver().solve(
      [...before, ...datumGeoms()],
      [...next, ...datumFixedConstraints(), ...constructionFixedConstraints(sketchId)],
    );
  } catch (e: any) {
    return fail(`Solve failed: ${e?.message ?? e}`);
  }

  const changed: string[] = [];
  let rebuilt = 0;
  for (const g of Object.values(res.geoms)) {
    if (isDatumId(g.id)) continue;
    if (beforeKey.get(g.id) !== geomKey(g)) { rebuildSketchEntity(g.id, g); changed.push(g.id); rebuilt++; }
  }

  useCADStore.getState().setNodeParams(sketchId, { constraints: next });
  if (changed.length) propagateFromStore(changed);

  // DoF / status — over-constrained is structural (more equations than DoF), never
  // inferred from non-convergence (which is at worst a numerical conflict).
  const geoms = collectSolverGeoms(sketchId);
  const dof = computeDoF(geoms, next).dof + unsupportedDoF(sketchId);
  const state: SketchSolveResult['state'] =
    dof < 0 ? 'over' : !res.converged ? 'conflict' : dof > 0 ? 'under' : 'full';
  useCADStore.getState().setConstraintStatus({ dof, state, residual: res.residual });

  return {
    ok: true, converged: res.converged, residual: res.residual, rebuilt, changed, dof, state,
    message: res.converged ? `Solved · ${rebuilt} updated` : `⚠ Could not satisfy all — residual ${res.residual.toFixed(3)}`,
  };
}
