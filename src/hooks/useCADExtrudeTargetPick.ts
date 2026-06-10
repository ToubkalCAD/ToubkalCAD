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
// To make face selection precise (instead of "the whole box lights up"), every
// face (planar OR curved) of each targetable solid gets a transparent,
// raycastable overlay. Hovering highlights just that face; a click records the
// solid id + the exact world-space hit point (which identifies the face for
// OccExtrusionService.extrudeUpToFace). Solids whose faces can't be tessellated
// fall back to whole-body picking so Pad/Pocket still works on any shape.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { OccFaceService } from '../services/OccFaceService';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { getPlacedShape } from '../utils/placedShape';

const EMISSIVE_HOVER = 0x118844; // whole-solid fallback highlight (green emissive)
const FACE_HOVER     = 0x00e0a0; // per-face overlay highlight (green)
const CLICK_SLOP_PX  = 5;

// Node types that are NOT valid boolean / limit targets.
const NON_SOLID = new Set(['sketch', 'sketch_wire']);

export function useCADExtrudeTargetPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const litRef       = useRef<THREE.MeshStandardMaterial | null>(null); // solid fallback hover
  const faceMeshesRef = useRef<THREE.Mesh[]>([]);                       // per-face overlays
  const faceHoverRef  = useRef<THREE.Mesh | null>(null);

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

  // ─── Build / tear down per-face overlays ─────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const m of faceMeshesRef.current) {
        scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      faceMeshesRef.current = [];
      faceHoverRef.current = null;
    };

    dispose();
    if (interactionMode !== 'EXTRUDE_TARGET_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || !isTargetable(id)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        const faces = OccFaceService.extractFaceMeshes(window.oc, placed);
        for (const f of faces) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({
            color: FACE_HOVER, transparent: true, opacity: 0, // idle = invisible, raycastable
            side: THREE.DoubleSide, depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 999;
          mesh.userData = { cadNodeId: id, faceOverlay: true };
          scene.add(mesh);
          faceMeshesRef.current.push(mesh);
        }
      } catch {
        /* solid without usable planar faces — whole-body fallback still works */
      } finally {
        // getPlacedShape returns a fresh transformed shape for moved bodies; free it.
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
  }, [interactionMode, sceneRef]);

  // ─── Hover + click ───────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearSolidHover = () => {
      const m = litRef.current;
      if (m) { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
      litRef.current = null;
    };
    const clearFaceHover = () => {
      const m = faceHoverRef.current;
      if (m) (m.material as THREE.MeshBasicMaterial).opacity = 0;
      faceHoverRef.current = null;
    };

    if (interactionMode !== 'EXTRUDE_TARGET_PICK') { clearSolidHover(); clearFaceHover(); return; }

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    interface Pick { id: string; point: THREE.Vector3; mesh: THREE.Mesh; isFace: boolean; }

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

      // Per-face overlays take priority (precise selection).
      const fHits = raycaster.intersectObjects(faceMeshesRef.current, false);
      if (fHits.length) {
        const m = fHits[0].object as THREE.Mesh;
        return { id: m.userData.cadNodeId as string, point: fHits[0].point, mesh: m, isFace: true };
      }

      // Fallback: whole-solid pick (covers non-planar faces, keeps Pad/Pocket general).
      const meshes = scene.children.filter(
        (c): c is THREE.Mesh =>
          c instanceof THREE.Mesh && isTargetable(c.userData?.cadNodeId),
      );
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length) {
        const m = hits[0].object as THREE.Mesh;
        return { id: m.userData.cadNodeId as string, point: hits[0].point, mesh: m, isFace: false };
      }
      return null;
    };

    const onMove = (e: MouseEvent) => {
      const r = pick(e);
      if (!r) { clearFaceHover(); clearSolidHover(); container.style.cursor = 'default'; return; }
      if (r.isFace) {
        clearSolidHover();
        if (faceHoverRef.current !== r.mesh) {
          clearFaceHover();
          (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.4;
          faceHoverRef.current = r.mesh;
        }
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
