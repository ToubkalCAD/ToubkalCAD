// ============================================================
// ToubkalCAD – useCADShellFacePick.ts
//
// Shell / hollow-solid OPEN-face picking. Active only while
// interactionMode === 'SHELL_FACE' (driven by the store's shellReq).
//
// The user clicks the faces that should be REMOVED (the mouth of a bottle,
// the rim of a bowl). Picking rides the REAL solid mesh via FacePicker —
// hovering highlights exactly the face under the cursor (planar OR curved)
// using the per-face draw groups OccConverter stamps into the geometry — and
// a click toggles that face's 0-based TopExp ordinal in the store's
// selectedFaceIndices. Selected faces keep a persistent red overlay so the
// user sees the full open-set; the hover highlight is a separate, brighter
// overlay. Both ordinals feed OccThickSolidService.createThickSolid verbatim.
//
// Click-vs-drag: a left press that releases within a few pixels is a pick; a
// larger movement is an OrbitControls rotation and is ignored.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { FacePicker, FaceHit } from '../services/FacePicker';

const COLOR_HOVER    = 0xffd000;  // face under the cursor
const COLOR_SELECTED = 0xff5533;  // face marked open (to be removed)
const CLICK_SLOP_PX  = 5;

export function useCADShellFacePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const interactionMode     = useCADStore((s) => s.interactionMode);
  const shellReq            = useCADStore((s) => s.shellReq);
  const selectedFaceIndices = useCADStore((s) => s.selectedFaceIndices);

  // faceIndex → persistent "selected" overlay mesh
  const selHlRef   = useRef<Map<number, THREE.Mesh>>(new Map());
  const hoverHlRef = useRef<THREE.Mesh | null>(null);
  const hoverKey   = useRef<string | null>(null);

  // ─── Recolour / rebuild persistent overlays when the selection changes ───────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const disposeSelected = () => {
      for (const m of selHlRef.current.values()) {
        scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      selHlRef.current.clear();
    };

    disposeSelected();
    if (!shellReq || interactionMode !== 'SHELL_FACE') { window.cadRequestRender?.(); return; }

    // The target solid's mesh carries the faceGroups we highlight against.
    const mesh = scene.children.find(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData?.cadNodeId === shellReq.targetId,
    );
    const groups = (mesh?.geometry as THREE.BufferGeometry | undefined)?.userData?.faceGroups as
      | { face: number; start: number; count: number }[]
      | undefined;
    if (!mesh || !groups) { window.cadRequestRender?.(); return; }

    for (const faceIndex of selectedFaceIndices) {
      const group = groups.find((g) => g.face === faceIndex);
      if (!group) continue;
      const hl = FacePicker.makeHighlight(mesh, group, { color: COLOR_SELECTED, opacity: 0.42 });
      scene.add(hl);
      selHlRef.current.set(faceIndex, hl);
    }
    window.cadRequestRender?.();

    return disposeSelected;
  }, [shellReq, interactionMode, selectedFaceIndices, sceneRef]);

  // ─── Hover + click-to-toggle ────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearHover = () => {
      const scene = sceneRef.current;
      if (hoverHlRef.current && scene) {
        scene.remove(hoverHlRef.current);
        hoverHlRef.current.geometry.dispose();
        (hoverHlRef.current.material as THREE.Material).dispose();
      }
      hoverHlRef.current = null;
      hoverKey.current   = null;
    };

    if (interactionMode !== 'SHELL_FACE') { clearHover(); return; }

    // Only faces of the shell's target solid are pickable.
    const pick = (e: MouseEvent): FaceHit | null => {
      const camera = cameraRef.current;
      const scene  = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  *  2 - 1,
        -((e.clientY - rect.top)  / rect.height) *  2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const targetId = useCADStore.getState().shellReq?.targetId;
      const meshes = scene.children.filter(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData?.cadNodeId === targetId,
      );
      const hits = raycaster.intersectObjects(meshes, false);
      for (const h of hits) {
        const fh = FacePicker.resolveHit(h);
        if (fh) return fh;
      }
      return null;
    };

    const setHover = (hit: FaceHit) => {
      const scene = sceneRef.current;
      if (!scene) return;
      const key = `${hit.nodeId}#${hit.faceIndex}`;
      if (key === hoverKey.current) return;
      clearHover();
      hoverKey.current = key;
      const hl = FacePicker.makeHighlight(hit.mesh, hit.group, { color: COLOR_HOVER, opacity: 0.5 });
      scene.add(hl);
      hoverHlRef.current = hl;
      window.cadRequestRender?.();
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'SHELL_FACE') return;
      const hit = pick(e);
      if (!hit) { clearHover(); container.style.cursor = 'default'; window.cadRequestRender?.(); return; }
      setHover(hit);
      container.style.cursor = 'pointer';
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useCADStore.getState().interactionMode !== 'SHELL_FACE') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'SHELL_FACE') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;  // drag = orbit
      const hit = pick(e);
      if (hit) {
        e.stopPropagation();
        useCADStore.getState().toggleFaceIndex(hit.faceIndex);
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
