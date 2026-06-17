// ============================================================
// ToubkalCAD – HistoryUndo.selftest.ts   (Phase 1 step 5 validation)
//
// In-browser smoke test of the delta history + shape lifetime against the LIVE
// store, registry, recompute bridge and kernel. Run from the console:
//
//     stepFiveVerify()
//
// Unlike the mock-host self-tests, this drives the REAL pipeline (registerShape +
// addNode + deleteNode + undo/redo), so it proves the integration: a regenerable
// node's shape is FREED on delete and REGENERATED on undo; a non-regenerable
// (imported-style) node's shape is RETAINED; and the delta history round-trips a
// node's metadata. It creates throwaway `__verify_*` nodes and deletes them again
// — your real scene is untouched, but a few undo entries remain (reload to clear).
// ============================================================

import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from './CADGeometryRegistry';
import { OccPrimitivesService } from './OccPrimitivesService';

interface Row { check: string; pass: boolean; detail: string }

function volume(oc: any, shape: any): number {
  try {
    const p = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, p, false, false, false);
    const v = p.Mass(); p.delete(); return v;
  } catch { return NaN; }
}
const near = (a: number, b: number, tol = 0.03) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < tol;

/** Add a node through the real pipeline: register its OCC shape, then addNode. */
function addReal(id: string, type: string, shape: any, params: Record<string, any>): void {
  CADGeometryRegistry.getInstance().registerShape(id, shape);
  useCADStore.getState().addNode({
    id, name: id, type: type as any, visible: true, locked: false, parentId: null, notes: '',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {}, params,
  } as any);
}

export function runStepFiveVerify(oc: any): Row[] {
  const rows: Row[] = [];
  const ok = (check: string, pass: boolean, detail = '') => rows.push({ check, pass, detail });
  const reg = CADGeometryRegistry.getInstance();
  const store = () => useCADStore.getState();
  const has = (id: string) => reg.getShape(id) !== undefined;

  const B = '__verify_box', I = '__verify_imported', C = '__verify_delta';

  // ── A — regenerable: free on delete, regenerate on undo, free again on redo ──
  addReal(B, 'box', OccPrimitivesService.createBox(oc, 10, 10, 10), { w: 10, h: 10, d: 10 });
  ok('A1 regenerable box registered', has(B));

  store().deleteNode(B);
  ok('A2 delete FREES the box shape', !has(B), `getShape=${reg.getShape(B)}`);

  store().undo();   // undoes the delete → box restored → cad-regenerate rebuilds it
  ok('A3 undo REGENERATES the box shape', has(B));
  ok('A4 regenerated box has correct volume (~1000)', near(volume(oc, reg.getShape(B)), 1000), `vol=${volume(oc, reg.getShape(B)).toFixed(0)}`);

  store().redo();   // redoes the delete → box removed → freed again
  ok('A5 redo FREES the box shape again', !has(B));

  // ── B — non-regenerable (imported-style): retained on delete ────────────────
  // A `compound` node with no blend/torus/cone/source params classifies as op
  // 'imported' (no recipe) → canRegenerate=false → the shape is retained.
  addReal(I, 'compound', OccPrimitivesService.createBox(oc, 5, 5, 5), {});
  ok('B1 imported-style node registered', has(I));

  store().deleteNode(I);
  ok('B2 delete RETAINS the non-regenerable shape', has(I), 'no recipe → kept for undo');

  store().undo();   // bring it back (shape was retained, so still present)
  ok('B3 undo restores it (shape was retained)', has(I));

  // ── C — delta history round-trips a node's metadata ─────────────────────────
  addReal(C, 'box', OccPrimitivesService.createBox(oc, 7, 7, 7), { w: 7, h: 7, d: 7 });
  const beforeName = store().nodes[C]?.name;
  store().deleteNode(C);
  ok('C1 node removed from the scene graph', !store().nodes[C]);
  store().undo();
  ok('C2 undo restores the node + its params (w=7)', store().nodes[C]?.params?.w === 7 && store().nodes[C]?.name === beforeName, `w=${store().nodes[C]?.params?.w}`);
  store().redo();
  ok('C3 redo removes it again', !store().nodes[C]);

  // ── cleanup: leave no throwaway nodes in the scene ──────────────────────────
  for (const id of [B, I, C]) if (store().nodes[id]) store().deleteNode(id);
  ok('cleanup: throwaway nodes removed from scene', ![B, I, C].some((id) => store().nodes[id]));

  return rows;
}

// ─── console entry point ──────────────────────────────────────────────────────
(globalThis as any).stepFiveVerify = function stepFiveVerify() {
  const oc = (globalThis as any).oc;
  if (!oc) { console.warn('[StepFive] kernel not ready (window.oc missing)'); return []; }
  const rows = runStepFiveVerify(oc);
  // eslint-disable-next-line no-console
  console.table(rows);
  const passed = rows.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`[StepFive] ${passed}/${rows.length} checks passed${passed === rows.length ? ' ✓' : ' ✗'}`);
  return rows;
};
