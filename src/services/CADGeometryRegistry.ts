import { useCADStore } from '../store/cadStore';

/**
 * Centralized registry for OpenCascade shapes.
 * Manages WASM heap lifetime: every registered shape must eventually
 * be .delete()'d. The store subscription does that automatically when
 * a node is removed.
 *
 * Optimization: the subscription caches the previous node set and only
 * runs the deletion loop when the nodes object reference changes
 * (i.e. on ADD/DELETE actions — not on selection, logs, snap, etc.).
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
      // Only process when the nodes map itself changes (not on every state update)
      if (state.nodes === prevNodes) return;

      const curr = state.nodes;
      for (const id in prevNodes) {
        if (!curr[id]) {
          this.deleteShape(id);
        }
      }
      prevNodes = curr;
    });
  }
}
