import { useCADStore } from '../store/cadStore';

/**
 * Centralized registry for OpenCascade shapes.
 * Manages WASM heap lifetime: every registered shape must eventually be
 * .delete()'d. The store subscription does that automatically.
 *
 * Lifetime rule (NOT "free as soon as the node leaves the scene"): a shape is
 * freed only once its id is unreachable from BOTH the current scene AND the
 * entire undo/redo history. This is what lets `undo` after a delete rebuild the
 * mesh — the node comes back and its OCC shape is still alive. A deleted shape
 * is finally freed when its delete action ages out of the HISTORY_LIMIT window.
 *
 * Perf: the subscription only does the (history-scanning) GC when a node id has
 * actually disappeared from `nodes`. Pure transform/selection/log updates — and
 * gizmo live-drag, which rewrites `nodes` every frame — take the cheap path.
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

      // GC: an id is still needed if it's in the scene OR reachable by undo/redo
      // (present in any retained history action's before/after snapshot).
      const reachable = new Set<string>();
      for (const id in state.nodes) reachable.add(id);
      const scan = (actions: Array<{ nodesBefore: { id: string }[]; nodesAfter: { id: string }[] }>) => {
        for (const a of actions) {
          for (const n of a.nodesBefore) reachable.add(n.id);
          for (const n of a.nodesAfter)  reachable.add(n.id);
        }
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
