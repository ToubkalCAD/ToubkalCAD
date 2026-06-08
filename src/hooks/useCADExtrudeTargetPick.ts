// ============================================================
// ToubkalCAD – useCADExtrudeTargetPick.ts
//
// E2 — Pad / Pocket target picking. Active only while
// interactionMode === 'EXTRUDE_TARGET_PICK'. The user clicks one existing
// solid to become the boolean target of the in-progress extrusion:
//   • Pad    → fuse(target, prism)
//   • Pocket → cut (target, prism)
//
// Hover highlights the candidate solid (green emissive); a near-stationary
// left click selects it (one-shot) and returns to SELECT mode via the store.
// Sketches / sketch wires and the in-progress operation node are not pickable.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';

const EMISSIVE_HOVER = 0x118844; // candidate-under-cursor highlight (green)
const CLICK_SLOP_PX  = 5;

// Node types that are NOT valid boolean targets.
const NON_SOLID = new Set(['sketch', 'sketch_wire']);

export function useCADExtrudeTargetPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const litRef = useRef<THREE.MeshStandardMaterial | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearHover = () => {
      const m = litRef.current;
      if (m) { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
      litRef.current = null;
    };

    // Leaving the mode removes any lingering highlight.
    if (interactionMode !== 'EXTRUDE_TARGET_PICK') { clearHover(); return; }

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    /** Is this node id a valid boolean target? */
    const isTargetable = (id: string | undefined): id is string => {
      if (!id) return false;
      const st = useCADStore.getState();
      const node = st.nodes[id];
      if (!node || NON_SOLID.has(node.type)) return false;
      // Don't let an in-progress edited operation cut/fuse with itself.
      if (st.op3DPanelReq?.editNodeId === id) return false;
      return true;
    };

    const pickMesh = (e: MouseEvent): THREE.Mesh | null => {
      const camera = cameraRef.current;
      const scene  = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  *  2 - 1,
        -((e.clientY - rect.top)  / rect.height) *  2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const meshes = scene.children.filter(
        (c): c is THREE.Mesh =>
          c instanceof THREE.Mesh && isTargetable(c.userData?.cadNodeId),
      );
      const hits = raycaster.intersectObjects(meshes, false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };

    const onMove = (e: MouseEvent) => {
      const mesh = pickMesh(e);
      const mat  = mesh && mesh.material instanceof THREE.MeshStandardMaterial ? mesh.material : null;
      if (mat === litRef.current) return;
      clearHover();
      if (mat) {
        mat.emissive.setHex(EMISSIVE_HOVER);
        mat.emissiveIntensity = 0.5;
        litRef.current = mat;
      }
      container.style.cursor = mesh ? 'pointer' : 'default';
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const mesh = pickMesh(e);
      const id   = mesh?.userData?.cadNodeId as string | undefined;
      if (id) {
        e.stopPropagation();
        clearHover();
        container.style.cursor = 'default';
        useCADStore.getState().setOp3DTargetPick(id);
      }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      clearHover();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [interactionMode, containerRef, sceneRef, cameraRef]);
}
