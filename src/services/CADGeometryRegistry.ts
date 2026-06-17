import { useCADStore } from '../store/cadStore';
import { nodeToFeature } from './FeatureGraph';

/** Feature ops the recompute engine can rebuild from a recipe (have EVALUATORS).
 *  A removed node of one of these types has its shape FREED immediately — undo
 *  regenerates it. Everything else with a shape (imported geometry, mirror,
 *  pattern — no evaluator) must be RETAINED while still reachable by undo. */
const REGENERABLE_OPS = new Set<string>([
  'box', 'cylinder', 'sphere', 'torus', 'cone',
  'revolve', 'loft', 'sweep', 'extrude', 'boolean', 'fillet', 'chamfer', 'sketchWire',
]);

/** Can the recompute engine rebuild this node's shape from its stored recipe?
 *  Conservative — a false negative only RETAINS a shape a little longer (freed when
 *  it ages out of history); a false positive would FREE a shape undo can't rebuild,
 *  leaving an invisible body. So we only free when regeneration is well-established:
 *   • the node maps to an evaluator op (REGENERABLE_OPS), and
 *   • the feature is `complete` — has a persisted recipe (excludes Ribbon.create
 *     revolve/loft/sweep, which never stored their inputs), and
 *   • it isn't an up-to-next / up-to-last extrude — those need sibling "context"
 *     bodies the feature graph doesn't wire (the panel supplies them); the generic
 *     evaluator would throw, so retain instead.
 *  Uses the same node→op classification the feature graph does (so the overloaded
 *  `compound` type — fillet/chamfer/torus/cone vs. import — resolves correctly). */
function canRegenerate(node: any): boolean {
  try {
    const f = nodeToFeature(node);
    if (!REGENERABLE_OPS.has(f.op) || !f.complete) return false;
    if (f.op === 'extrude') {
      const endMode = Math.round(Number(node.params?.opParams?.endMode ?? 0));
      if (endMode === 4 || endMode === 5) return false;   // up-to-next / up-to-last
    }
    return true;
  } catch { return false; }
}

/**
 * Centralized registry for OpenCascade shapes.
 * Manages WASM heap lifetime: every registered shape must eventually be
 * .delete()'d. The store subscription does that automatically.
 *
 * Lifetime rule (Phase 1 step 5): a REGENERABLE node's shape is freed the moment
 * its node leaves the scene — undo rebuilds it from its recipe via the recompute
 * engine (the `cad-regenerate` bridge). A NON-regenerable shape (imported / mirror
 * / pattern — no evaluator) has no recipe, so it is retained while still reachable
 * from the current scene OR a retained undo/redo delta, and freed once it ages out
 * of the HISTORY_LIMIT window.
 *
 * Perf: the subscription only runs the GC when a node id has actually disappeared
 * from `nodes`. Pure transform/selection/log updates — and gizmo live-drag, which
 * rewrites `nodes` every frame — take the cheap path.
 */
export class CADGeometryRegistry {
  private static instance: CADGeometryRegistry | null = null;
  private geometryMap = new Map<string, any>();

  private constructor() {
    this.setupStoreSubscription();
  }

  public static getInstance(): CADGeometryRegistry {
    if (!CADGeometryRegistry.instance) {
      CADGeometryRegistry.instance = new CADGeometryRegistry();
    }
    return CADGeometryRegistry.instance;
  }

  public registerShape(id: string, shape: any): void {
    if (this.geometryMap.has(id)) {
      this.deleteShape(id);
    }
    this.geometryMap.set(id, shape);
  }

  public getShape(id: string): any | undefined {
    return this.geometryMap.get(id);
  }

  public deleteShape(id: string): void {
    const shape = this.geometryMap.get(id);
    if (shape) {
      if (typeof shape.delete === 'function') {
        try { shape.delete(); } catch { /* shape already freed */ }
      }
      this.geometryMap.delete(id);
    }
  }

  private setupStoreSubscription(): void {
    let prevNodes = useCADStore.getState().nodes;

    useCADStore.subscribe((state) => {
      // Only react when the nodes map reference changes.
      if (state.nodes === prevNodes) return;
      const prev = prevNodes;
      prevNodes = state.nodes;

      // Cheap guard: a shape can only become freeable when its node leaves the
      // scene. If nothing was removed (add / live-drag / rename), skip the GC.
      let removed = false;
      for (const id in prev) { if (!state.nodes[id]) { removed = true; break; } }
      if (!removed) return;

      // 1 — a REGENERABLE node that just left the scene is freed NOW; undo rebuilds
      //     it from its recipe (no need to retain it through history).
      for (const id in prev) {
        if (!state.nodes[id] && this.geometryMap.has(id) && canRegenerate(prev[id])) {
          this.deleteShape(id);
        }
      }

      // 2 — sweep the remainder (non-regenerable retained shapes: imported / mirror
      //     / pattern): keep while reachable from the scene OR a retained delta,
      //     free once aged out of the HISTORY_LIMIT window. Also backstops step 1.
      const reachable = new Set<string>();
      for (const id in state.nodes) reachable.add(id);
      const scan = (actions: Array<{ deltas: { id: string }[] }>) => {
        for (const a of actions) for (const d of a.deltas) reachable.add(d.id);
      };
      scan(state.past as any);
      scan(state.future as any);

      const toFree: string[] = [];
      for (const id of this.geometryMap.keys()) {
        if (!reachable.has(id)) toFree.push(id);
      }
      for (const id of toFree) this.deleteShape(id);
    });
  }
}
