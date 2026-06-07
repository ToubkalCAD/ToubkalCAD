// ============================================================
// ToubkalCAD – useCADAssemblyMate.ts
//
// One-shot assembly mate (Coincident, planar faces). Active while
// interactionMode === 'ASSEMBLY_MATE'.
//
// For every visible solid it builds a transparent, raycastable overlay mesh per
// planar face — extracted from the PLACED shape so the overlay sits where the
// solid is actually drawn. Two-step pick:
//   1) click a reference face (stays highlighted) — the part that won't move,
//   2) click a face on ANOTHER solid — that solid snaps so the two faces are
//      coplanar & touching (normals opposed, centroids aligned).
// After a mate the moved solid's overlays are rebuilt; the mode stays active so
// you can keep mating. Pick another tool to leave.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { getPlacedShape } from '../utils/placedShape';
import { OccFaceService, PlanarFace } from '../services/OccFaceService';
import { computeMateTransform } from '../services/AssemblyMate';

const COLOR_IDLE = 0x2a7fd4;
const COLOR_HOVER = 0x00e0a0;
const COLOR_REF  = 0xff8800;   // chosen reference face
const CLICK_SLOP_PX = 5;
const FACE_MODES = new Set(['ASSEMBLY_MATE', 'ASSEMBLY_ALIGN']);

// Offset (mm) for ASSEMBLY_ALIGN, set by the ribbon before entering the mode.
let alignOffset = 0;
export const setAlignOffset = (v: number) => { alignOffset = v; };

interface FaceMeta extends PlanarFace { nodeId: string; }

export function useCADAssemblyMate(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const meshesRef = useRef<THREE.Mesh[]>([]);
  const hoverRef  = useRef<THREE.Mesh | null>(null);
  const refFaceRef = useRef<FaceMeta | null>(null);
  const refMeshRef = useRef<THREE.Mesh | null>(null);
  const [rebuild, setRebuild] = useState(0);

  // ─── Build / tear down face overlays ─────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const m of meshesRef.current) {
        scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose();
      }
      meshesRef.current = [];
      hoverRef.current = null;
      refMeshRef.current = null;
    };

    dispose();
    if (!FACE_MODES.has(mode) || !window.oc) return;

    const st = useCADStore.getState();
    let solids = 0, faceTotal = 0;
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible) continue;
      if (node.type === 'sketch' || node.type === 'sketch_wire') continue;
      const shape = getPlacedShape(id);
      if (!shape) continue;
      solids++;
      try {
        for (const f of OccFaceService.extractPlanarFaces(window.oc, shape)) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({
            color: COLOR_IDLE, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 998;
          mesh.userData = { isMateFace: true, face: { ...f, nodeId: id } as FaceMeta };
          scene.add(mesh);
          meshesRef.current.push(mesh);
          // Re-highlight the still-pending reference face after a rebuild.
          const r = refFaceRef.current;
          if (r && r.nodeId === id && r.index === f.index) {
            mat.color.setHex(COLOR_REF); mat.opacity = 0.32; refMeshRef.current = mesh;
          }
          faceTotal++;
        }
      } catch { /* skip unusable faces */ }
    }

    const verb = mode === 'ASSEMBLY_ALIGN' ? 'Align' : 'Mate';
    if (solids < 2) useCADStore.getState().log(`Assembly ${verb.toLowerCase()} needs at least two solids.`, 'warn');
    else if (!refFaceRef.current) useCADStore.getState().log(`${verb}: pick a reference face (${faceTotal} available).`, 'info');

    return dispose;
  }, [mode, sceneRef, rebuild]);

  // ─── Hover + two-step pick ───────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const downPos = { x: 0, y: 0, active: false };

    const pick = (e: MouseEvent): THREE.Mesh | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(meshesRef.current, false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };

    const setHover = (m: THREE.Mesh | null) => {
      if (hoverRef.current === m) return;
      const prev = hoverRef.current;
      if (prev && prev !== refMeshRef.current) {
        const pm = prev.material as THREE.MeshBasicMaterial; pm.color.setHex(COLOR_IDLE); pm.opacity = 0.12;
      }
      hoverRef.current = m;
      if (m && m !== refMeshRef.current) {
        const mm = m.material as THREE.MeshBasicMaterial; mm.color.setHex(COLOR_HOVER); mm.opacity = 0.32;
      }
      container.style.cursor = m ? 'pointer' : 'default';
    };

    const onMove = (e: MouseEvent) => {
      if (!FACE_MODES.has(useCADStore.getState().interactionMode)) return;
      setHover(pick(e));
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
      const m = pick(e);
      if (!m) return;
      e.stopPropagation();
      const f = m.userData.face as FaceMeta;
      const st = useCADStore.getState();

      // Step 1 — set the reference face.
      if (!refFaceRef.current) {
        refFaceRef.current = f;
        refMeshRef.current = m;
        const mat = m.material as THREE.MeshBasicMaterial; mat.color.setHex(COLOR_REF); mat.opacity = 0.32;
        hoverRef.current = null;
        st.log(`Reference set on ${st.nodes[f.nodeId]?.name ?? 'solid'}. Now pick a face on the part to move.`, 'info');
        return;
      }

      // Step 2 — mate the second face's solid onto the reference.
      const ref = refFaceRef.current;
      if (f.nodeId === ref.nodeId) { st.log('Pick a face on a different solid to move.', 'warn'); return; }
      const movNode = st.nodes[f.nodeId];
      if (!movNode) return;

      const align = st.interactionMode === 'ASSEMBLY_ALIGN';
      // Both keep the faces FACING each other (opposed normals); Align just adds
      // a gap so the parts end up parallel `offset` mm apart instead of touching.
      const t = computeMateTransform(
        { origin: ref.origin, normal: ref.normal, uAxis: ref.uAxis },
        { origin: f.origin,   normal: f.normal,   uAxis: f.uAxis },
        movNode.transform,
        { opposed: true, offset: align ? alignOffset : 0 },
      );
      st.updateTransform(f.nodeId, t.position, t.rotation, t.scale);
      window.dispatchEvent(new CustomEvent('cad-apply-transform', {
        detail: { id: f.nodeId, position: t.position, rotation: t.rotation },
      }));
      st.log(`${align ? 'Aligned' : 'Mated'} ${movNode.name} to ${st.nodes[ref.nodeId]?.name ?? 'reference'}.`, 'success');

      // Reset for the next mate; rebuild overlays so moved faces are current.
      refFaceRef.current = null;
      refMeshRef.current = null;
      hoverRef.current = null;
      setRebuild((n) => n + 1);
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [containerRef, cameraRef]);

  // Clear the pending reference when leaving the face-mate modes.
  useEffect(() => {
    if (!FACE_MODES.has(mode)) { refFaceRef.current = null; refMeshRef.current = null; }
  }, [mode]);

  // Rebuild overlays when solids are added/removed/hidden so deleted bodies
  // don't leave orphaned face overlays floating in the viewport.
  useEffect(() => {
    const unsub = useCADStore.subscribe((curr, prev) => {
      if (curr.nodes === prev.nodes) return;
      if (!FACE_MODES.has(useCADStore.getState().interactionMode)) return;
      const a = Object.keys(curr.nodes), b = Object.keys(prev.nodes);
      const changed = a.length !== b.length
        || a.some((id) => !prev.nodes[id] || prev.nodes[id].visible !== curr.nodes[id].visible);
      if (!changed) return;
      if (refFaceRef.current && !curr.nodes[refFaceRef.current.nodeId]) {
        refFaceRef.current = null; refMeshRef.current = null;
      }
      setRebuild((n) => n + 1);
    });
    return unsub;
  }, []);
}
