// ============================================================
// ToubkalCAD – useCADDatumSketchPick.ts
//
// Track D, D9 — "sketch on a datum plane" (viewport pick).
//
// Active only while interactionMode === 'DATUM_SKETCH'. Raycasts the persistent
// amber datum-plane faces (tagged userData.datumNodeId); hovering brightens the
// plane, clicking derives its workplane and starts a sketch session on it, then
// drops into the Line tool — mirroring useCADSketchFacePick (sketch-on-face).
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';

const CLICK_SLOP_PX = 5;

export function useCADDatumSketchPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const litRef = useRef<THREE.MeshBasicMaterial | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearHover = () => {
      const m = litRef.current;
      if (m) m.opacity = 0.16;
      litRef.current = null;
    };
    if (mode !== 'DATUM_SKETCH') { clearHover(); return; }

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const datumFaces = (): THREE.Mesh[] => {
      const scene = sceneRef.current;
      if (!scene) return [];
      const out: THREE.Mesh[] = [];
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData?.datumNodeId) out.push(o);
      });
      return out;
    };

    const pick = (e: MouseEvent): THREE.Mesh | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(datumFaces(), false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };

    const onMove = (e: MouseEvent) => {
      const mesh = pick(e);
      const mat  = mesh && mesh.material instanceof THREE.MeshBasicMaterial ? mesh.material : null;
      if (mat === litRef.current) return;
      clearHover();
      if (mat) { mat.opacity = 0.4; litRef.current = mat; }
      container.style.cursor = mesh ? 'pointer' : 'default';
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const mesh = pick(e);
      const id   = mesh?.userData?.datumNodeId as string | undefined;
      if (!id) return;
      e.stopPropagation();
      clearHover();
      container.style.cursor = 'default';
      const st = useCADStore.getState();
      const wp = st.nodes[id]?.params?.workplane as Workplane | undefined;
      if (!wp) { st.log('Datum plane has no workplane.', 'error'); return; }
      st.startSketchSession(wp);
      st.setInteractionMode('SELECT');      // no tool pre-selected — user picks a 2D shape
      st.log(`Sketching on ${st.nodes[id]?.name ?? 'datum plane'} — pick a 2D tool to draw.`, 'success');
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
  }, [mode, containerRef, sceneRef, cameraRef]);
}
