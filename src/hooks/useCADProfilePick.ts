// ============================================================
// ToubkalCAD – useCADProfilePick.ts
//
// Fusion-style PROFILE picker for the Extrude panel. Active only while
// interactionMode === 'PROFILE_PICK'. The panel computes the sketch's nested
// profiles (outer boundary with its holes subtracted) and hands their flat face
// geometries to the viewport via `profileFaceBus`; this hook draws one
// translucent, selectable overlay per profile on the sketch plane:
//   • hover  → the profile under the cursor brightens (a different colour),
//   • click  → toggles that profile in/out of the extrude selection (store).
//
// Selection lives in the store (`profilePickSelected`, plain indices) so the
// panel checkboxes and these overlays stay in sync — this hook only renders +
// reports clicks. The committed/preview meshes are hidden by the panel while
// picking, so the overlays read clearly against the sketch.
// ============================================================

import { useEffect } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { profileFaceBus } from '../utils/extrudeProfiles';

// Fill colours: [unselected, selected] — hover uses the brighter pair.
const COL_BASE  = [0x8893a0, 0x16a35a];
const COL_HOVER = [0x3fb079, 0x55e6a0];

export function useCADProfilePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const interactionMode = useCADStore((s) => s.interactionMode);

  useEffect(() => {
    if (interactionMode !== 'PROFILE_PICK') return;
    const container = containerRef.current;
    const scene     = sceneRef.current;
    if (!container || !scene) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };
    let hoverIdx    = -1;

    // ── Build one overlay mesh per profile face (world-space geometry) ──────────
    // Clone the bus geometry so this hook fully owns its meshes' lifetime — the
    // bus may dispose its originals on panel close regardless of our teardown.
    const meshes: THREE.Mesh[] = profileFaceBus.geometries.map((geo, i) => {
      const mat = new THREE.MeshBasicMaterial({
        color: COL_BASE[0], transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(geo.clone(), mat);
      mesh.renderOrder = 999;                       // draw atop the sketch/grid
      mesh.userData.profileIndex = i;
      scene.add(mesh);
      return mesh;
    });

    /** Recolour every overlay from the live selection + current hover. */
    const applyColors = () => {
      const sel = new Set(useCADStore.getState().profilePickSelected);
      meshes.forEach((m, i) => {
        const on    = sel.has(i);
        const hover = i === hoverIdx;
        const mat   = m.material as THREE.MeshBasicMaterial;
        mat.color.setHex((hover ? COL_HOVER : COL_BASE)[on ? 1 : 0]);
        mat.opacity = hover ? 0.5 : (on ? 0.34 : 0.16);
      });
      window.cadRequestRender?.();
    };
    applyColors();

    const pickIndex = (e: MouseEvent): number => {
      const camera = cameraRef.current;
      if (!camera) return -1;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  *  2 - 1,
        -((e.clientY - rect.top)  / rect.height) *  2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(meshes, false);
      return hits.length ? (hits[0].object.userData.profileIndex as number) : -1;
    };

    const onMove = (e: MouseEvent) => {
      const idx = pickIndex(e);
      container.style.cursor = idx >= 0 ? 'pointer' : 'default';
      if (idx !== hoverIdx) { hoverIdx = idx; applyColors(); }
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;  // drag, not a click
      const idx = pickIndex(e);
      if (idx >= 0) {
        e.stopPropagation();
        useCADStore.getState().toggleProfilePick(idx);    // store change → subscription recolours
      }
    };

    // Recolour when the selection changes from anywhere (panel checkboxes too).
    const unsub = useCADStore.subscribe((s, prev) => {
      if (s.profilePickSelected !== prev.profilePickSelected) applyColors();
    });

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      unsub();
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      container.style.cursor = 'default';
      for (const m of meshes) {
        scene.remove(m);
        m.geometry.dispose();                            // our own clone
        (m.material as THREE.Material).dispose();
      }
      window.cadRequestRender?.();
    };
  }, [interactionMode, containerRef, sceneRef, cameraRef]);
}
