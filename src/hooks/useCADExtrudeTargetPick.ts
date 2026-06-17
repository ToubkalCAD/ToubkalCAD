// ============================================================
// ToubkalCAD – useCADExtrudeTargetPick.ts
//
// E2 / E5 — Pad / Pocket / Up-to-Face target picking. Active only while
// interactionMode === 'EXTRUDE_TARGET_PICK'. The user clicks one existing
// solid (and, for Up-to-Face, one specific FACE of it) to become the limit /
// boolean target of the in-progress extrusion:
//   • Pad         → fuse(target, prism)
//   • Pocket      → cut (target, prism)
//   • Up-to-Face  → trim the prism at the clicked face's surface
//
// Face selection rides the REAL solid mesh via FacePicker: hovering highlights
// exactly the face under the cursor (planar OR curved) using the per-face draw
// groups OccConverter stamps into the geometry — no per-face overlay clones.
// A click records the solid id + the exact world-space hit point (which
// identifies the face for OccExtrusionService.extrudeUpToFace). A mesh without
// face groups falls back to whole-body highlight so Pad/Pocket stays general.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { FacePicker, FaceHit } from '../services/FacePicker';

const EMISSIVE_HOVER = 0x118844; // whole-solid fallback highlight (green emissive)
const CLICK_SLOP_PX  = 5;

// Node types that are NOT valid boolean / limit targets.
const NON_SOLID = new Set(['sketch', 'sketch_wire']);

export function useCADExtrudeTargetPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const litRef          = useRef<THREE.MeshStandardMaterial | null>(null); // solid fallback hover
  const hoverHlRef      = useRef<THREE.Mesh | null>(null);                  // per-face hover highlight
  const hoverKeyRef     = useRef<string | null>(null);

  /** Is this node id a valid boolean / limit target? */
  const isTargetable = (id: string | undefined): id is string => {
    if (!id) return false;
    const st = useCADStore.getState();
    const node = st.nodes[id];
    if (!node || NON_SOLID.has(node.type)) return false;
    // Don't let an in-progress edited operation cut/fuse/trim against itself.
    if (st.op3DPanelReq?.editNodeId === id) return false;
    return true;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearSolidHover = () => {
      const m = litRef.current;
      if (m) { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
      litRef.current = null;
    };
    const clearFaceHover = () => {
      const scene = sceneRef.current;
      if (hoverHlRef.current && scene) {
        scene.remove(hoverHlRef.current);
        hoverHlRef.current.geometry.dispose();
        (hoverHlRef.current.material as THREE.Material).dispose();
      }
      hoverHlRef.current = null;
      hoverKeyRef.current = null;
    };

    if (interactionMode !== 'EXTRUDE_TARGET_PICK') { clearSolidHover(); clearFaceHover(); return; }

    interface Pick { id: string; point: THREE.Vector3; mesh: THREE.Mesh; faceHit: FaceHit | null; }

    const pick = (e: MouseEvent): Pick | null => {
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
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && isTargetable(c.userData?.cadNodeId),
      );
      const hits = raycaster.intersectObjects(meshes, false);
      for (const h of hits) {
        const fh = FacePicker.resolveHit(h);
        if (fh) return { id: fh.nodeId, point: h.point.clone(), mesh: fh.mesh, faceHit: fh };
        // Mesh predates face groups → whole-body fallback (still precise enough for Pad/Pocket).
        const id = (h.object as THREE.Mesh).userData?.cadNodeId as string | undefined;
        if (isTargetable(id)) return { id, point: h.point.clone(), mesh: h.object as THREE.Mesh, faceHit: null };
      }
      return null;
    };

    const setFaceHover = (hit: FaceHit) => {
      const scene = sceneRef.current;
      if (!scene) return;
      const key = `${hit.nodeId}#${hit.faceIndex}`;
      if (key === hoverKeyRef.current) return;
      clearFaceHover();
      hoverKeyRef.current = key;
      const hl = FacePicker.makeHighlight(hit.mesh, hit.group, { opacity: 0.4 });
      scene.add(hl);
      hoverHlRef.current = hl;
    };

    const onMove = (e: MouseEvent) => {
      const r = pick(e);
      if (!r) { clearFaceHover(); clearSolidHover(); container.style.cursor = 'default'; return; }
      if (r.faceHit) {
        clearSolidHover();
        setFaceHover(r.faceHit);
      } else {
        clearFaceHover();
        const mat = r.mesh.material instanceof THREE.MeshStandardMaterial ? r.mesh.material : null;
        if (mat !== litRef.current) {
          clearSolidHover();
          if (mat) { mat.emissive.setHex(EMISSIVE_HOVER); mat.emissiveIntensity = 0.5; litRef.current = mat; }
        }
      }
      container.style.cursor = 'pointer';
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const r = pick(e);
      if (r?.id) {
        e.stopPropagation();
        clearFaceHover(); clearSolidHover();
        container.style.cursor = 'default';
        // World-space hit point identifies the exact face (Up-to-Face); Pad/Pocket ignores it.
        useCADStore.getState().setOp3DTargetPick(r.id, [r.point.x, r.point.y, r.point.z]);
      }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      clearSolidHover(); clearFaceHover();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [interactionMode, containerRef, sceneRef, cameraRef]);
}
