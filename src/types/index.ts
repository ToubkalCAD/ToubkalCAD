// ============================================================
// AtlasCAD – src/types/index.ts
// Déclarations TypeScript globales centralisées.
// ============================================================

// ─── Augmentation window ──────────────────────────────────────────────────────
declare global {
  interface Window {
    /** Instance OpenCascade.js (WASM) chargée au démarrage */
    oc: any;
    /** Scène Three.js principale, exposée pour les panels */
    cadScene: any | null;
    /** Caméra principale Three.js */
    cadCamera: any | null;
    /** OrbitControls principal */
    cadControls: any | null;
    /** Request an on-demand viewport render (the loop renders only on change). */
    cadRequestRender?: () => void;
    /** CSS2DRenderer overlay for dimension annotation labels. */
    cadLabelRenderer?: any | null;
  }
}

export {};
