// ============================================================
// AtlasCAD – useCADGizmoHotkeys.ts  (v2 – final corrigé)
// Raccourcis clavier CAO. Correction v2 :
//   • Lecture d'état via getState() (pas de closure stale)
//   • Touches numpad déléguées à CADLayout (ce hook = gizmo only)
//   • Escape nettoie aussi le mode sketch
// ============================================================

import { useEffect } from 'react';
import { useCADStore } from '../store/cadStore';

export interface UseCADGizmoHotkeysOptions {
  onGizmoModeChange?: (mode: 'translate' | 'rotate' | 'scale') => void;
  onFrameSelection?:  () => void;
}

export function useCADGizmoHotkeys(options: UseCADGizmoHotkeysOptions = {}) {
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      // Ignorer si focus dans un champ texte
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const ctrl  = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const key   = e.key.toLowerCase();
      const store = useCADStore.getState();

      // ── Modes Gizmo ───────────────────────────────────────────────────────
      if (!ctrl && key === 'w') {
        e.preventDefault();
        store.setGizmoMode('translate');
        options.onGizmoModeChange?.('translate');
        store.log('Mode gizmo : Translation (W)', 'info');
        return;
      }
      if (!ctrl && key === 'e') {
        e.preventDefault();
        store.setGizmoMode('rotate');
        options.onGizmoModeChange?.('rotate');
        store.log('Mode gizmo : Rotation (E)', 'info');
        return;
      }
      if (!ctrl && key === 'r') {
        e.preventDefault();
        store.setGizmoMode('scale');
        options.onGizmoModeChange?.('scale');
        store.log('Mode gizmo : Échelle (R)', 'info');
        return;
      }

      // ── Escape : désélectionner + revenir en SELECT ────────────────────
      if (e.key === 'Escape') {
        store.setSelectedIds([]);
        store.setInteractionMode('SELECT');
        return;
      }

      // ── Suppr / Backspace : supprimer la sélection ─────────────────────
      if ((e.key === 'Delete' || e.key === 'Backspace') && !ctrl) {
        const ids = store.selectedIds;
        if (!ids.length) return;
        e.preventDefault();
        // deleteNode dispatches cad-remove-mesh for the node AND all children
        ids.forEach((id) => store.deleteNode(id));
        return;
      }

      // ── Undo / Redo ────────────────────────────────────────────────────
      if (ctrl && !shift && key === 'z') { e.preventDefault(); store.undo(); return; }
      if (ctrl && (key === 'y' || (shift && key === 'z'))) { e.preventDefault(); store.redo(); return; }

      // ── Dupliquer ─────────────────────────────────────────────────────
      if (ctrl && key === 'd') {
        e.preventDefault();
        const ids = store.selectedIds;
        if (!ids.length) return;
        const newIds = ids.map((id) => {
          const newId = store.duplicateNode(id);
          window.dispatchEvent(new CustomEvent('cad-duplicate-mesh', { detail: { sourceId: id, newId } }));
          return newId;
        });
        store.setSelectedIds(newIds);
        return;
      }

      // ── Sélectionner tout ─────────────────────────────────────────────
      if (ctrl && key === 'a') {
        e.preventDefault();
        store.setSelectedIds(Object.keys(store.nodes));
        return;
      }

      // ── Frame Selection (F) · Fit All (Shift+F) ───────────────────────
      if (!ctrl && key === 'f') {
        e.preventDefault();
        if (shift) window.dispatchEvent(new CustomEvent('cad-frame-all'));
        else       options.onFrameSelection?.();
        return;
      }

      // ── Masquer / Afficher (H) ────────────────────────────────────────
      if (!ctrl && key === 'h') {
        e.preventDefault();
        store.selectedIds.forEach((id) => store.toggleVisibility(id));
        return;
      }
    };

    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [options.onGizmoModeChange, options.onFrameSelection]);
}
