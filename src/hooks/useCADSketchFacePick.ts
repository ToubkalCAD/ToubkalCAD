// ============================================================
// ToubkalCAD – useCADSketchFacePick.ts
//
// Track S2 — "sketch on a face".
//
// Active only while interactionMode === 'FACE_SKETCH'. Raycasts directly
// against the REAL solid meshes and resolves the hit to an OCC face via the
// per-face draw groups OccConverter stamps into geometry.userData.faceGroups
// (see FacePicker). Hovering highlights the exact face under the cursor —
// planar OR curved; clicking a PLANAR face derives its workplane and starts a
// sketch session on it. Clicking a curved face is rejected with a hint.
//
// This replaces the old approach of cloning one transparent overlay mesh per
// planar face: no duplicate tessellation, and curved faces now highlight too.
//
// Click-vs-drag: a press that releases within a few pixels is a pick; a larger
// movement is an OrbitControls rotation and is ignored.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService } from '../services/OccFaceService';
import { FacePicker, FaceHit } from '../services/FacePicker';

const COLOR_HOVER   = 0x00e0a0;
const CLICK_SLOP_PX = 5;

export function useCADSketchFacePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);

  const highlightRef = useRef<THREE.Mesh | null>(null);
  const lastKeyRef   = useRef<string | null>(null);

  // ─── Enter / leave FACE_SKETCH ───────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const clearHighlight = () => {
      if (highlightRef.current) {
        scene.remove(highlightRef.current);
        highlightRef.current.geometry.dispose();
        (highlightRef.current.material as THREE.Material).dispose();
        highlightRef.current = null;
      }
      lastKeyRef.current = null;
    };

    clearHighlight();
    if (mode !== 'FACE_SKETCH' || !window.oc) return clearHighlight;

    const hasSolids = FacePicker.pickableMeshes(scene).length > 0;
    useCADStore.getState().log(
      hasSolids
        ? 'Pick a planar face to sketch on (hover to preview).'
        : 'No solids in the scene — create one first.',
      hasSolids ? 'info' : 'warn',
    );

    return clearHighlight;
  }, [mode, sceneRef]);

  // ─── Hover highlight + click-to-start ────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const castFace = (e: MouseEvent): FaceHit | null => {
      const camera = cameraRef.current;
      const scene  = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      return FacePicker.raycast(raycaster, scene);
    };

    const setHighlight = (hit: FaceHit | null) => {
      const scene = sceneRef.current;
      if (!scene) return;
      const key = hit ? `${hit.nodeId}#${hit.faceIndex}` : null;
      if (key === lastKeyRef.current) return;   // same face — nothing to rebuild
      lastKeyRef.current = key;

      if (highlightRef.current) {
        scene.remove(highlightRef.current);
        highlightRef.current.geometry.dispose();
        (highlightRef.current.material as THREE.Material).dispose();
        highlightRef.current = null;
      }

      if (hit) {
        const geo = FacePicker.faceHighlightGeometry(hit.mesh, hit.group);
        const mat = new THREE.MeshBasicMaterial({
          color: COLOR_HOVER, transparent: true, opacity: 0.32,
          side: THREE.DoubleSide, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 999;
        mesh.matrixAutoUpdate = false;   // geometry is already baked in world space
        highlightRef.current = mesh;
        scene.add(mesh);
      }
      container.style.cursor = hit ? 'pointer' : 'default';
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'FACE_SKETCH') return;
      setHighlight(castFace(e));
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useCADStore.getState().interactionMode !== 'FACE_SKETCH') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'FACE_SKETCH') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;

      const hit = castFace(e);
      if (!hit) return;
      e.stopPropagation();

      const st    = useCADStore.getState();
      const shape = CADGeometryRegistry.getInstance().getShape(hit.nodeId);
      if (!shape) return;

      const plane = OccFaceService.planeFromFaceIndex(window.oc, shape, hit.faceIndex);
      if (!plane) {
        st.log('That face is not planar — pick a flat face to sketch on.', 'warn');
        return;
      }

      const wp: Workplane = {
        label: 'Face', origin: plane.origin, normal: plane.normal, uAxis: plane.uAxis, vAxis: plane.vAxis,
      };
      st.startSketchSession(wp);          // sets activeWorkplane + sketchSession (camera follows)
      st.setInteractionMode('SELECT');    // no tool pre-selected — user picks a 2D shape
      st.log(`Sketching on a face of ${st.nodes[hit.nodeId]?.name ?? 'solid'} — pick a 2D tool to draw.`, 'success');
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [containerRef, cameraRef, sceneRef]);
}
