// ============================================================
// ToubkalCAD – useCADSketchIntersectPick.ts
//
// Track D, D12 — "Intersect" a body with the active sketch plane.
//
// Active only while interactionMode === 'INTERSECT_PICK' (during a sketch
// session). Click a solid: it is sectioned by the active sketch plane
// (OccDatumService.sectionPolylines) and every resulting curve is added to the
// sketch as a polyline sketch_wire entity. Stays in the mode; Esc finishes.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { OccDatumService } from '../services/OccDatumService';
import { toLocal2D } from '../services/OccSketchService';
import { createSketchEntityNode } from '../utils/sketchEntity';
import { getPlacedShape } from '../utils/placedShape';

const EMISSIVE_HOVER = 0x118844;
const CLICK_SLOP_PX  = 5;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADSketchIntersectPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const litRef = useRef<THREE.MeshStandardMaterial | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearHover = () => {
      const m = litRef.current;
      if (m) { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
      litRef.current = null;
    };
    if (mode !== 'INTERSECT_PICK') { clearHover(); return; }

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const pickMesh = (e: MouseEvent): THREE.Mesh | null => {
      const camera = cameraRef.current;
      const scene  = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const meshes = scene.children.filter((c): c is THREE.Mesh => {
        if (!(c instanceof THREE.Mesh)) return false;
        const id = c.userData?.cadNodeId as string | undefined;
        if (!id) return false;
        const node = useCADStore.getState().nodes[id];
        return !!node && !NON_SOLID.has(node.type);
      });
      const hits = raycaster.intersectObjects(meshes, false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };

    const intersectBody = (id: string) => {
      const st = useCADStore.getState();
      const session = st.sketchSession;
      if (!session) return;
      const shape = getPlacedShape(id);
      if (!shape) return;
      const wp = session.plane;
      const polys = OccDatumService.sectionPolylines(window.oc, shape, wp.origin, wp.normal);
      let added = 0;
      for (const poly of polys) {
        const pts = poly.map((p) => { const l = toLocal2D(new THREE.Vector3(p[0], p[1], p[2]), wp); return [l.u, l.v]; });
        if (pts.length >= 2 && createSketchEntityNode({ kind: 'polyline', pts }, wp, session.id)) added++;
      }
      st.log(added ? `Intersection added ${added} curve${added > 1 ? 's' : ''} to the sketch.` : 'The sketch plane does not cut that body.', added ? 'success' : 'warn');
    };

    const onMove = (e: MouseEvent) => {
      const mesh = pickMesh(e);
      const mat  = mesh && mesh.material instanceof THREE.MeshStandardMaterial ? mesh.material : null;
      if (mat === litRef.current) return;
      clearHover();
      if (mat) { mat.emissive.setHex(EMISSIVE_HOVER); mat.emissiveIntensity = 0.5; litRef.current = mat; }
      container.style.cursor = mesh ? 'pointer' : 'default';
    };
    const onDown = (e: MouseEvent) => { if (e.button !== 0) return; downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true; };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const mesh = pickMesh(e);
      const id   = mesh?.userData?.cadNodeId as string | undefined;
      if (!id) return;
      e.stopPropagation();
      clearHover();
      container.style.cursor = 'default';
      intersectBody(id);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { clearHover(); useCADStore.getState().setInteractionMode('SELECT'); } };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      clearHover();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
