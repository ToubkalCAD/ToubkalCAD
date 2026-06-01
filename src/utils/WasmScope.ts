/**
 * Gestionnaire de portée pour les objets temporaires WebAssembly.
 * Garantit la libération mémoire même en cas d'exception.
 * 
 * Utilisation :
 *   const scope = new WasmScope();
 *   const vec = scope.keep(new oc.gp_Vec_4(0,0,1));
 *   // ... calculs ...
 *   scope.free(); // libère tous les temporaires
 */
export class WasmScope {
  private anchorObjects: any[] = [];

  public keep<T>(obj: T): T {
    if (obj && typeof (obj as any).delete === 'function') {
      this.anchorObjects.push(obj);
    }
    return obj;
  }

  public free(): void {
    for (const obj of this.anchorObjects) {
      try {
        obj.delete();
      } catch (e) {
        console.error('[WasmScope] Erreur lors de la libération :', e);
      }
    }
    this.anchorObjects = [];
  }
}

/** Helper fonctionnel : wraps une fonction dans un scope automatique */
export function withWasmScope<T>(callback: (scope: WasmScope) => T): T {
  const scope = new WasmScope();
  try {
    return callback(scope);
  } catch (error) {
    throw error;
  } finally {
    scope.free();
  }
}
