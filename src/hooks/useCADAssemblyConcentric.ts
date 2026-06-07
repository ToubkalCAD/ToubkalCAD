// ============================================================
// ToubkalCAD – useCADAssemblyConcentric.ts
//
// One-shot Concentric assembly constraint (peg-in-hole). Active while
// interactionMode === 'ASSEMBLY_CONCENTRIC'.
//
// Builds a transparent, raycastable overlay per CYLINDRICAL face of every
// visible solid (from the PLACED shape, so it sits where drawn). Two-step pick:
//   1) click a reference cylindrical face (stays highlighted),
//   2) click a cylindrical face on ANOTHER solid — that solid rotates/translates
//      so its axis becomes collinear with the reference axis (axial position kept).
// ============================================================

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { getPlacedShape } from '../utils/placedShape';
import { OccAxisService, CylFace } from '../services/OccAxisService';
import { computeConcentricTransform } from '../services/AssemblyMate';

const COLOR_IDLE = 0x2a7fd4;
const COLOR_HOVER = 0x00e0a0;
const COLOR_REF  = 0xff8800;
const CLICK_SLOP_PX = 5;

interface CylMeta extends CylFace { nodeId: string; }

export function useCADAssemblyConcentric(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const meshesRef  = useRef<THREE.Mesh[]>([]);
  const hoverRef   = useRef<THREE.Mesh | null>(null);
  const refFaceRef = useRef<CylMeta | null>(null);
  const refMeshRef = useRef<THREE.Mesh | null>(null);
  const [rebuild, setRebuild] = useState(0);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const dispose = () => {
      for (const m of meshesRef.current) { scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      meshesRef.current = []; hoverRef.current = null; refMeshRef.current = null;
    };
    dispose();
    if (mode !== 'ASSEMBLY_CONCENTRIC' || !window.oc) return;

    const st = useCADStore.getState();
    let solids = 0, total = 0;
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible) continue;
      if (node.type === 'sketch' || node.type === 'sketch_wire') continue;
      const shape = getPlacedShape(id);
      if (!shape) continue;
      solids++;
      try {
        for (const f of OccAxisService.extractCylindricalFaces(window.oc, shape)) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({ color: COLOR_IDLE, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 998;
          mesh.userData = { isCylFace: true, face: { ...f, nodeId: id } as CylMeta };
          scene.add(mesh); meshesRef.current.push(mesh);
          const r = refFaceRef.current;
          if (r && r.nodeId === id && r.index === f.index) { mat.color.setHex(COLOR_REF); mat.opacity = 0.34; refMeshRef.current = mesh; }
          total++;
        }
      } catch { /* skip */ }
    }
    if (solids < 2) useCADStore.getState().log('Concentric needs at least two solids.', 'warn');
    else if (!total) useCADStore.getState().log('No cylindrical faces found (need round holes/pegs).', 'warn');
    else if (!refFaceRef.current) useCADStore.getState().log(`Concentric: pick a reference cylindrical face (${total} available).`, 'info');

    return dispose;
  }, [mode, sceneRef, rebuild]);

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
      if (prev && prev !== refMeshRef.current) { const pm = prev.material as THREE.MeshBasicMaterial; pm.color.setHex(COLOR_IDLE); pm.opacity = 0.14; }
      hoverRef.current = m;
      if (m && m !== refMeshRef.current) { const mm = m.material as THREE.MeshBasicMaterial; mm.color.setHex(COLOR_HOVER); mm.opacity = 0.34; }
      container.style.cursor = m ? 'pointer' : 'default';
    };

    const onMove = (e: MouseEvent) => { if (useCADStore.getState().interactionMode !== 'ASSEMBLY_CONCENTRIC') return; setHover(pick(e)); };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || useCADStore.getState().interactionMode !== 'ASSEMBLY_CONCENTRIC') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'ASSEMBLY_CONCENTRIC') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const m = pick(e); if (!m) return;
      e.stopPropagation();
      const f = m.userData.face as CylMeta;
      const st = useCADStore.getState();

      if (!refFaceRef.current) {
        refFaceRef.current = f; refMeshRef.current = m;
        const mat = m.material as THREE.MeshBasicMaterial; mat.color.setHex(COLOR_REF); mat.opacity = 0.34;
        hoverRef.current = null;
        st.log(`Reference axis set on ${st.nodes[f.nodeId]?.name ?? 'solid'}. Now pick a cylinder on the part to move.`, 'info');
        return;
      }
      const ref = refFaceRef.current;
      if (f.nodeId === ref.nodeId) { st.log('Pick a cylindrical face on a different solid.', 'warn'); return; }
      const movNode = st.nodes[f.nodeId];
      if (!movNode) return;

      const t = computeConcentricTransform(
        { point: ref.axisPoint, dir: ref.axisDir },
        { point: f.axisPoint,   dir: f.axisDir },
        movNode.transform,
      );
      st.updateTransform(f.nodeId, t.position, t.rotation, t.scale);
      window.dispatchEvent(new CustomEvent('cad-apply-transform', { detail: { id: f.nodeId, position: t.position, rotation: t.rotation } }));
      st.log(`Made ${movNode.name} concentric with ${st.nodes[ref.nodeId]?.name ?? 'reference'}.`, 'success');

      refFaceRef.current = null; refMeshRef.current = null; hoverRef.current = null;
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

  useEffect(() => {
    if (mode !== 'ASSEMBLY_CONCENTRIC') { refFaceRef.current = null; refMeshRef.current = null; }
  }, [mode]);

  // Rebuild overlays on solid add/remove/hide so deleted bodies don't leave
  // orphaned cylinder overlays floating in the viewport.
  useEffect(() => {
    const unsub = useCADStore.subscribe((curr, prev) => {
      if (curr.nodes === prev.nodes) return;
      if (useCADStore.getState().interactionMode !== 'ASSEMBLY_CONCENTRIC') return;
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
