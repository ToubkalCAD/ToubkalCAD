// ============================================================
// ToubkalCAD – useCADAssemblyMate.ts
//
// One-shot assembly mate (Coincident, planar faces). Active while
// interactionMode === 'ASSEMBLY_MATE' or 'ASSEMBLY_ALIGN'.
//
// Face picking rides the REAL solid meshes via FacePicker — no per-face overlay
// clones, and the planes are read from the PLACED shape so they sit where the
// solid is actually drawn. Two-step pick:
//   1) click a reference face (stays highlighted) — the part that won't move,
//   2) click a face on ANOTHER solid — that solid snaps so the two faces are
//      coplanar & touching (normals opposed, centroids aligned).
// The mode stays active so you can keep mating. Pick another tool to leave.
// Only PLANAR faces qualify; clicking a curved face is rejected with a hint.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { getPlacedShape } from '../utils/placedShape';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService } from '../services/OccFaceService';
import { FacePicker, FaceHit } from '../services/FacePicker';
import { computeMateTransform } from '../services/AssemblyMate';

const COLOR_HOVER = 0x00e0a0;
const COLOR_REF   = 0xff8800;   // chosen reference face
const CLICK_SLOP_PX = 5;
const FACE_MODES = new Set(['ASSEMBLY_MATE', 'ASSEMBLY_ALIGN']);

// Offset (mm) for ASSEMBLY_ALIGN, set by the ribbon before entering the mode.
let alignOffset = 0;
export const setAlignOffset = (v: number) => { alignOffset = v; };

interface FacePlane {
  nodeId: string; faceIndex: number;
  origin: [number,number,number]; normal: [number,number,number];
  uAxis: [number,number,number]; vAxis: [number,number,number];
}

/** World-space plane of one face, read from the placed shape (null if curved). */
function facePlane(nodeId: string, faceIndex: number): FacePlane | null {
  const reg    = CADGeometryRegistry.getInstance();
  const placed = getPlacedShape(nodeId);
  if (!placed) return null;
  try {
    const p = OccFaceService.planeFromFaceIndex(window.oc, placed, faceIndex);
    return p ? { nodeId, faceIndex, ...p } : null;
  } finally {
    if (placed !== reg.getShape(nodeId)) { try { placed.delete(); } catch {} }
  }
}

export function useCADAssemblyMate(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const hoverHlRef  = useRef<THREE.Mesh | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const refHlRef    = useRef<THREE.Mesh | null>(null);
  const refDataRef  = useRef<FacePlane | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = () => sceneRef.current;

    const disposeMesh = (m: THREE.Mesh | null) => {
      const s = scene();
      if (m && s) { s.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    };
    const clearHover = () => {
      if (hoverHlRef.current) disposeMesh(hoverHlRef.current);
      hoverHlRef.current = null; hoverKeyRef.current = null;
    };
    const clearRef = () => {
      if (refHlRef.current) disposeMesh(refHlRef.current);
      refHlRef.current = null; refDataRef.current = null;
    };

    if (!FACE_MODES.has(mode)) { clearHover(); clearRef(); container.style.cursor = 'default'; return; }

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const downPos = { x: 0, y: 0, active: false };

    const cast = (e: MouseEvent): FaceHit | null => {
      const camera = cameraRef.current;
      const s = scene();
      if (!camera || !s) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return FacePicker.raycast(raycaster, s);
    };

    const setHover = (hit: FaceHit | null) => {
      const s = scene();
      const ref = refDataRef.current;
      // Don't draw a hover over the locked reference face.
      const isRef = hit && ref && hit.nodeId === ref.nodeId && hit.faceIndex === ref.faceIndex;
      const key = hit && !isRef ? `${hit.nodeId}#${hit.faceIndex}` : null;
      if (key === hoverKeyRef.current) { container.style.cursor = hit ? 'pointer' : 'default'; return; }
      clearHover();
      hoverKeyRef.current = key;
      if (hit && !isRef && s) {
        const hl = FacePicker.makeHighlight(hit.mesh, hit.group, { color: COLOR_HOVER });
        s.add(hl); hoverHlRef.current = hl;
      }
      container.style.cursor = hit ? 'pointer' : 'default';
    };

    const onMove = (e: MouseEvent) => {
      if (!FACE_MODES.has(useCADStore.getState().interactionMode)) return;
      setHover(cast(e));
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !FACE_MODES.has(useCADStore.getState().interactionMode)) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (!FACE_MODES.has(useCADStore.getState().interactionMode)) return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const hit = cast(e);
      if (!hit) return;
      e.stopPropagation();
      const st = useCADStore.getState();

      const plane = facePlane(hit.nodeId, hit.faceIndex);
      if (!plane) { st.log('That face is not planar — pick a flat face.', 'warn'); return; }

      // Step 1 — set the reference face.
      if (!refDataRef.current) {
        refDataRef.current = plane;
        clearHover();
        const s = scene();
        if (s) { const hl = FacePicker.makeHighlight(hit.mesh, hit.group, { color: COLOR_REF }); s.add(hl); refHlRef.current = hl; }
        st.log(`Reference set on ${st.nodes[plane.nodeId]?.name ?? 'solid'}. Now pick a face on the part to move.`, 'info');
        return;
      }

      // Step 2 — mate the second face's solid onto the reference.
      const ref = refDataRef.current;
      if (plane.nodeId === ref.nodeId) { st.log('Pick a face on a different solid to move.', 'warn'); return; }
      const movNode = st.nodes[plane.nodeId];
      if (!movNode) return;

      const align = st.interactionMode === 'ASSEMBLY_ALIGN';
      // Both keep the faces FACING each other (opposed normals); Align just adds
      // a gap so the parts end up parallel `offset` mm apart instead of touching.
      const t = computeMateTransform(
        { origin: ref.origin,   normal: ref.normal,   uAxis: ref.uAxis },
        { origin: plane.origin, normal: plane.normal, uAxis: plane.uAxis },
        movNode.transform,
        { opposed: true, offset: align ? alignOffset : 0 },
      );
      st.updateTransform(plane.nodeId, t.position, t.rotation, t.scale);
      window.dispatchEvent(new CustomEvent('cad-apply-transform', {
        detail: { id: plane.nodeId, position: t.position, rotation: t.rotation },
      }));
      st.log(`${align ? 'Aligned' : 'Mated'} ${movNode.name} to ${st.nodes[ref.nodeId]?.name ?? 'reference'}.`, 'success');

      clearHover(); clearRef();   // ready for the next mate
    };

    // If a pending reference's solid is deleted, drop the stale highlight.
    const unsub = useCADStore.subscribe((curr, prev) => {
      if (curr.nodes === prev.nodes) return;
      const ref = refDataRef.current;
      if (ref && !curr.nodes[ref.nodeId]) clearRef();
      clearHover();   // a transform/visibility change may have moved the hovered face
    });

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      clearHover(); clearRef();
      unsub();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
