// ============================================================
// ToubkalCAD – RecomputeEngine.live.ts   (Phase 1, step 3 — call-site wiring)
//
// The BROWSER-only half of the recompute engine: the live `RecomputeHost` wired
// to CADGeometryRegistry (shape ownership), the store (placement + meta + datum
// frame write-back), and the cad-*-mesh event bus (viewport). Kept separate from
// the pure `RecomputeEngine.ts` core so that core stays importable headlessly —
// these imports pull in THREE / Zustand / the registry.
//
// Call sites use the two entry points here:
//   • recomputeFromStore(editedId?) — rebuild the edited feature + everything
//     downstream (or the whole graph if no id). The general entry.
//   • propagateFromStore(editedIds)  — rebuild ONLY the descendants of the edited
//     feature(s). Used by panels that already rebuilt the edited node themselves
//     (Op3DPanel / Blend / Boolean re-edit, ConstraintPanel sketch edits): the
//     engine then propagates the change to fillets / booleans / pads on top of it.
//     This avoids re-evaluating the edited node through the generic evaluator
//     (whose context — e.g. up-to-next/last bodies — the panels handle specially).
// ============================================================

import { recompute, RecomputeHost, RecomputeReport } from './RecomputeEngine';
import { buildFeatureGraph, dirtySet, descendants } from './FeatureGraph';
import { CADGeometryRegistry } from './CADGeometryRegistry';
import { OccTransformService } from './OccTransformService';
import { ThreeMeshCache } from './ThreeMeshCache';
import { useCADStore } from '../store/cadStore';

/** The production host: registry + store placement/meta + cad-*-mesh bus. */
export function liveHost(): RecomputeHost {
  const reg = CADGeometryRegistry.getInstance();
  const emit = (kind: 'add' | 'update' | 'remove', id: string) =>
    window.dispatchEvent(new CustomEvent(`cad-${kind}-mesh`, { detail: { id } }));

  return {
    oc: window.oc,
    getShape: (id) => reg.getShape(id),
    setShape: (id, shape) => reg.registerShape(id, shape),
    freeShape: (id) => reg.deleteShape(id),
    place: (id, shape) => {
      const node = useCADStore.getState().nodes[id];
      if (!node) return shape;
      return OccTransformService.placeShape(window.oc, shape, node.transform);
    },
    meta: (id) => useCADStore.getState().nodes[id]?.params,
    // Already-meshed → re-tessellate in place (update); never meshed → add. onAdd
    // skips sketch wires/containers, so emitting 'add' for those is a safe no-op.
    onChanged: (id) => emit(ThreeMeshCache.getInstance().hasMesh(id) ? 'update' : 'add', id),
    onRemoved: (id) => emit('remove', id),
    onFrame: (id, frame) => {
      // Persist the recomputed datum frame so the viewport render + downstream
      // meta + save reflect it (no undo entry — setNodeParams is history-free).
      const st = useCADStore.getState();
      if (frame.kind === 'plane') st.setNodeParams(id, { workplane: frame.workplane });
      else if (frame.kind === 'axis') st.setNodeParams(id, { axis: frame.axis });
      else st.setNodeParams(id, { point: frame.point });
    },
  };
}

/**
 * Rebuild the edited feature + everything downstream of it (or the whole graph
 * if no id), reading the recipe from the live store. The general entry point.
 */
export function recomputeFromStore(
  editedId?: string, rollbackId?: string | null,
): RecomputeReport {
  const graph = buildFeatureGraph(useCADStore.getState().nodes);
  const dirty = editedId ? dirtySet(graph, editedId) : undefined;
  return recompute(liveHost(), graph, { dirty, rollbackId });
}

/**
 * Rebuild ONLY the descendants of the edited feature(s) — the edited nodes have
 * already been rebuilt by the caller (their panel). This is the propagation step:
 * a fillet/boolean/pad sitting on top of the edited feature picks up its new
 * geometry. No-op (and no kernel work) when nothing is downstream.
 */
export function propagateFromStore(editedIds: string | string[]): RecomputeReport {
  const ids = Array.isArray(editedIds) ? editedIds : [editedIds];
  const graph = buildFeatureGraph(useCADStore.getState().nodes);
  const dirty = new Set<string>();
  for (const id of ids) for (const d of descendants(graph, id)) dirty.add(d);
  if (dirty.size === 0) {
    return { results: [], order: graph.order, ok: 0, errored: 0, reused: 0, errors: {}, cycles: graph.cycles };
  }
  const rep = recompute(liveHost(), graph, { dirty });
  const st = useCADStore.getState();
  const failed = Object.keys(rep.errors);
  if (failed.length) {
    const names = failed.map((id) => st.nodes[id]?.name ?? id.slice(0, 6)).join(', ');
    st.log(`Recompute ▸ ${rep.ok} updated, ${failed.length} failed: ${names}`, 'error');
  } else if (rep.ok > 0) {
    st.log(`Recompute ▸ ${rep.ok} downstream feature(s) updated`, 'info');
  }
  return rep;
}
