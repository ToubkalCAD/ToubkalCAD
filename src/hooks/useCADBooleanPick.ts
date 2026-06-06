// ============================================================
// ToubkalCAD – useCADBooleanPick.ts
//
// Phase 7 – guided boolean (Union / Subtract / Intersect) solid picking.
//
// Active only while interactionMode === 'BOOLEAN_PICK'. The user clicks
// solids in the viewport: the first becomes the BASE (blue), subsequent
// clicks toggle TOOL solids (orange). Highlighting is done with emissive
// on each mesh's MeshStandardMaterial; cleared on exit.
//
// Click-vs-drag: a near-stationary left release is a pick; a larger move
// is an OrbitControls rotation and is ignored.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';

const EMISSIVE_BASE = 0x1144aa; // base solid highlight (blue)
const EMISSIVE_TOOL = 0xaa5511; // tool solid highlight (orange)
const CLICK_SLOP_PX = 5;

export function useCADBooleanPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const booleanReq    = useCADStore((s) => s.booleanReq);
  const booleanBaseId = useCADStore((s) => s.booleanBaseId);
  const booleanTools  = useCADStore((s) => s.booleanToolIds);

  const litRef = useRef<Set<string>>(new Set()); // ids we set emissive on

  // ─── Apply / clear emissive highlights from the current selection ────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const clearAll = () => {
      for (const obj of scene.children) {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial
            && litRef.current.has(obj.userData?.cadNodeId)) {
          obj.material.emissive.setHex(0x000000);
          obj.material.emissiveIntensity = 0;
        }
      }
      litRef.current.clear();
    };

    clearAll();
    if (!booleanReq) return;

    const toolSet = new Set(booleanTools);
    for (const obj of scene.children) {
      if (!(obj instanceof THREE.Mesh) || !(obj.material instanceof THREE.MeshStandardMaterial)) continue;
      const id = obj.userData?.cadNodeId as string | undefined;
      if (!id) continue;
      if (id === booleanBaseId) {
        obj.material.emissive.setHex(EMISSIVE_BASE);
        obj.material.emissiveIntensity = 0.5;
        litRef.current.add(id);
      } else if (toolSet.has(id)) {
        obj.material.emissive.setHex(EMISSIVE_TOOL);
        obj.material.emissiveIntensity = 0.5;
        litRef.current.add(id);
      }
    }
    return clearAll;
  }, [booleanReq, booleanBaseId, booleanTools, sceneRef]);

  // ─── Click-to-pick (with drag rejection) ─────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const pickId = (e: MouseEvent): string | null => {
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
        (c) => c instanceof THREE.Mesh && c.userData?.cadNodeId,
      );
      const hits = raycaster.intersectObjects(meshes, false);
      return hits.length ? (hits[0].object.userData.cadNodeId as string) : null;
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useCADStore.getState().interactionMode !== 'BOOLEAN_PICK') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'BOOLEAN_PICK') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const id = pickId(e);
      if (id) { e.stopPropagation(); useCADStore.getState().pickBooleanSolid(id); }
    };

    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [containerRef, sceneRef, cameraRef]);
}
