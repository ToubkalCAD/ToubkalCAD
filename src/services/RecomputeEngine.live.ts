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
import { fromLocal2D } from './OccSketchService';
import { toRegionEntity, findRegions, RegionEntity } from './SketchRegions';
import { buildSketchProfileWire, healOpProfileTargets } from '../utils/sketchProfile';
import { useCADStore, Workplane } from '../store/cadStore';

/** World-space display polyline for a sketch wire's local-2D `sketchGeom`, placed
 *  through `wp`. Sketch wires render as imperative THREE.Line objects that ignore
 *  cad-update-mesh, so after a recompute moves the wire (e.g. its sketch followed a
 *  face) we re-place its outline and swap the line via cad-sketch-replace-visual —
 *  the same event the constraint solver uses. Returns null for shapes we don't
 *  re-derive here (region wires carry no sketchGeom). */
function sketchWireWorldPoints(geom: any, wp: Workplane | undefined): number[][] | null {
  if (!geom || !wp) return null;
  const P = (u: number, v: number): number[] => { const p = fromLocal2D(u, v, wp); return [p.x, p.y, p.z]; };
  const arc = (c: number[], r: number, a1: number, a2: number, n: number) =>
    Array.from({ length: n + 1 }, (_, i) => { const t = a1 + (a2 - a1) * (i / n); return P(c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)); });
  switch (geom.kind) {
    case 'line':     return [P(geom.a[0], geom.a[1]), P(geom.b[0], geom.b[1])];
    case 'polyline': return Array.isArray(geom.pts) ? geom.pts.map((q: number[]) => P(q[0], q[1])) : null;
    case 'circle':   return arc(geom.c, geom.r, 0, 2 * Math.PI, 64);
    case 'arc':      return arc(geom.c, geom.r, geom.a1, geom.a2, 48);
    default:         return null;
  }
}

/** World-space loop for a REGION wire, placed through `wp`. A region carries no
 *  sketchGeom — it's re-traced from its member entity wires (params.memberIds),
 *  the same detection the sketchWire evaluator runs — so the loop follows whatever
 *  frame the region was rebuilt on. Returns null if it can't be re-detected. */
function regionLoopWorldPoints(
  memberIds: string[] | undefined, nodes: Record<string, any>, wp: Workplane | undefined,
): number[][] | null {
  if (!wp || !Array.isArray(memberIds) || !memberIds.length) return null;
  const ents = memberIds
    .map((id) => toRegionEntity(id, nodes[id]?.params?.sketchGeom))
    .filter((e): e is RegionEntity => !!e);
  const regions = findRegions(ents);
  if (!regions.length) return null;
  const rg = regions.reduce((a, b) => (b.area > a.area ? b : a));   // largest, matching the evaluator
  return rg.loop.map(([u, v]) => { const p = fromLocal2D(u, v, wp); return [p.x, p.y, p.z]; });
}

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
    profileWire: (id) => buildSketchProfileWire(window.oc, id) ?? undefined,
    onChanged: (id) => {
      // Sketch wires render as imperative THREE.Line objects (not ThreeMeshCache
      // solids), so re-tessellation via cad-update-mesh wouldn't touch them. When a
      // recompute rebuilds one — e.g. a sketch-on-face followed its moved face — swap
      // its line: re-place the local-2D outline through the parent container's
      // (freshly re-derived) workplane and fire cad-sketch-replace-visual.
      const node = useCADStore.getState().nodes[id];
      if (node?.type === 'sketch_wire') {
        const st = useCADStore.getState();
        const wp = ((node.parentId ? st.nodes[node.parentId]?.params?.workplane : undefined)
          ?? node.params?.workplane) as Workplane | undefined;
        // Entity wire → re-place its sketchGeom; region wire → re-trace its loop.
        const pts = sketchWireWorldPoints(node.params?.sketchGeom, wp)
          ?? regionLoopWorldPoints(node.params?.memberIds, st.nodes, wp);
        if (pts) { window.dispatchEvent(new CustomEvent('cad-sketch-replace-visual', { detail: { id, pts } })); return; }
      }
      // Already-meshed → re-tessellate in place (update); never meshed → add. onAdd
      // skips sketch wires/containers, so emitting 'add' for those is a safe no-op.
      emit(ThreeMeshCache.getInstance().hasMesh(id) ? 'update' : 'add', id);
    },
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

/**
 * Rebuild only the nodes whose OCC shape is MISSING from the registry, leaving
 * every node that still has a live shape untouched. This is the step-5 undo bridge:
 * a regenerable node's shape is freed on delete, so when undo brings the node back
 * its shape must be rebuilt from the recipe before the viewport meshes it.
 *
 * An EMPTY dirty set gives exactly this: the engine treats every node WITH a shape
 * as cached (skipped) and (re)evaluates only those without one — in topo order, so
 * a restored chain (e.g. box + its fillet) rebuilds bottom-up. Non-regenerable
 * nodes (imported / mirror / pattern) keep their retained shape → stay cached.
 */
export function regenerateMissing(): RecomputeReport {
  const graph = buildFeatureGraph(useCADStore.getState().nodes);
  return recompute(liveHost(), graph, { dirty: new Set<string>() });
}

let bridgeInstalled = false;
/** Install the `cad-regenerate` listener (fired by the store's undo/redo). Runs
 *  regenerateMissing SYNCHRONOUSLY — CustomEvent dispatch is synchronous, so by the
 *  time the store's following cad-add-mesh fires the rebuilt shape is registered.
 *  Idempotent; call once at startup. */
export function installRecomputeBridge(): void {
  if (bridgeInstalled || typeof window === 'undefined') return;
  bridgeInstalled = true;
  window.addEventListener('cad-regenerate', () => {
    try { regenerateMissing(); } catch { /* engine already isolates per-feature errors */ }
  });
  // Sketch edited & exited → rebuild everything downstream of that sketch (loft /
  // extrude / revolve bound to it re-derive their profile from the new shape).
  window.addEventListener('cad-sketch-committed', (e) => {
    const id = (e as CustomEvent).detail?.sketchId as string | undefined;
    if (!id) return;
    try {
      // First self-heal any op that consumed this sketch (adopted it as a child):
      // an op still holding a stale entity-wire target rebinds to the sketch, which
      // makes it a live descendant so the propagation below actually reaches it.
      const st = useCADStore.getState();
      for (const n of Object.values(st.nodes)) {
        if (n.params?.opType && (n.children ?? []).includes(id)) healOpProfileTargets(n.id);
      }
      propagateFromStore(id);
    } catch { /* engine isolates per-feature errors */ }
  });
}
