// ============================================================
// ToubkalCAD – useCADDatumTangentPick.ts
//
// Track D, D6 — "Tangent Plane" (tangent to a cylindrical face at a point).
//
// Active only while interactionMode === 'DATUM_TANGENT_PICK'. Cylindrical faces
// get a transparent overlay; clicking one builds the plane tangent to the
// cylinder at the hit point (normal = radial direction from the axis). Esc cancels.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccAxisService } from '../services/OccAxisService';
import { OccDatumService } from '../services/OccDatumService';
import { getPlacedShape } from '../utils/placedShape';

const FACE_IDLE  = 0x2a7fd4;
const FACE_HOVER = 0x00e0a0;
const CLICK_SLOP_PX = 5;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADDatumTangentPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const meshesRef = useRef<THREE.Mesh[]>([]);
  const hoverRef  = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const dispose = () => {
      for (const m of meshesRef.current) { scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      meshesRef.current = [];
      hoverRef.current = null;
    };
    dispose();
    if (mode !== 'DATUM_TANGENT_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        for (const cf of OccAxisService.extractCylindricalFaces(window.oc, placed)) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(cf.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({ color: FACE_IDLE, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 998;
          mesh.userData = { cyl: { axisPoint: cf.axisPoint, axisDir: cf.axisDir }, sourceId: id };
          scene.add(mesh);
          meshesRef.current.push(mesh);
        }
      } catch { /* skip */ } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
    st.log(meshesRef.current.length ? 'Click a point on a cylindrical face for a tangent plane.' : 'No cylindrical faces to be tangent to.', meshesRef.current.length ? 'info' : 'warn');
    return dispose;
  }, [mode, sceneRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearHover = () => {
      if (hoverRef.current) { const mt = hoverRef.current.material as THREE.MeshBasicMaterial; mt.color.setHex(FACE_IDLE); mt.opacity = 0.14; }
      hoverRef.current = null;
    };
    if (mode !== 'DATUM_TANGENT_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    const hit = (e: MouseEvent): THREE.Intersection | null => {
      const camera = cameraRef.current; if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(meshesRef.current, false);
      return hits.length ? hits[0] : null;
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_TANGENT_PICK') return;
      const h = hit(e);
      const m = (h?.object as THREE.Mesh) ?? null;
      if (m !== hoverRef.current) {
        clearHover();
        if (m) { const mt = m.material as THREE.MeshBasicMaterial; mt.color.setHex(FACE_HOVER); mt.opacity = 0.34; hoverRef.current = m; }
      }
      container.style.cursor = m ? 'pointer' : 'default';
    };
    const onDown = (e: MouseEvent) => { if (e.button !== 0) return; downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true; };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const h = hit(e);
      if (!h) return;
      e.stopPropagation();
      const mesh = h.object as THREE.Mesh;
      const cyl = mesh.userData.cyl as { axisPoint: [number,number,number]; axisDir: [number,number,number] };
      const sourceId = mesh.userData.sourceId as string | undefined;
      const p: [number, number, number] = [h.point.x, h.point.y, h.point.z];
      clearHover();
      container.style.cursor = 'default';
      const st = useCADStore.getState();
      st.setInteractionMode('SELECT');
      const wp = OccDatumService.tangentPlaneToCylinder(window.oc, p, cyl.axisPoint, cyl.axisDir);
      if (!wp) { st.log('Could not build a tangent plane there.', 'warn'); return; }
      st.createDatumPlane(wp, 'tangent', sourceId ? [{ kind: 'cylinder', nodeId: sourceId }] : []);
      st.log('Tangent plane created.', 'success');
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { clearHover(); useCADStore.getState().setInteractionMode('SELECT'); } };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      clearHover(); container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
