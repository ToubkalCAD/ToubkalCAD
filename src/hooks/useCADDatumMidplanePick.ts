// ============================================================
// ToubkalCAD – useCADDatumMidplanePick.ts
//
// Track D, D5 — "Midplane" (plane midway between two planar references).
//
// Active only while interactionMode === 'DATUM_MIDPLANE_PICK'. Pickable set:
// any PLANAR face of a solid (picked on the REAL mesh via FacePicker) plus the
// persistent amber datum planes. The user clicks two of them; the first stays
// locked amber while the second is chosen. On the second pick we build the
// midplane (OccDatumService.midplane) and persist it as a datum. Esc cancels.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService } from '../services/OccFaceService';
import { OccDatumService } from '../services/OccDatumService';
import { FacePicker } from '../services/FacePicker';
import { getPlacedShape } from '../utils/placedShape';

const COLOR_HOVER    = 0x00e0a0;
const COLOR_PICKED   = 0xf0a30a; // first reference locked in (amber)
const DATUM_OPACITY  = 0.16;
const CLICK_SLOP_PX  = 5;

interface RefMeta { workplane: Workplane; sourceId: string; kind: 'face' | 'datum'; key: string; }

/** World-space workplane of one solid face (null if curved). */
function facePlaneWp(nodeId: string, faceIndex: number): Workplane | null {
  const reg    = CADGeometryRegistry.getInstance();
  const placed = getPlacedShape(nodeId);
  if (!placed) return null;
  try {
    const p = OccFaceService.planeFromFaceIndex(window.oc, placed, faceIndex);
    return p ? { label: 'Face', origin: p.origin, normal: p.normal, uAxis: p.uAxis, vAxis: p.vAxis } : null;
  } finally {
    if (placed !== reg.getShape(nodeId)) { try { placed.delete(); } catch {} }
  }
}

export function useCADDatumMidplanePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const hoverHlRef    = useRef<THREE.Mesh | null>(null);
  const hoverKeyRef   = useRef<string | null>(null);
  const datumHoverRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const firstRef       = useRef<RefMeta | null>(null);
  const firstHlRef     = useRef<THREE.Mesh | null>(null);                 // locked solid-face highlight
  const firstDatumMatRef = useRef<THREE.MeshBasicMaterial | null>(null);  // locked datum mat to restore

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const disposeMesh = (m: THREE.Mesh | null) => {
      const s = sceneRef.current;
      if (m && s) { s.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    };
    const clearFaceHover = () => {
      if (hoverHlRef.current) disposeMesh(hoverHlRef.current);
      hoverHlRef.current = null; hoverKeyRef.current = null;
    };
    const clearDatumHover = () => {
      if (datumHoverRef.current) { datumHoverRef.current.opacity = DATUM_OPACITY; datumHoverRef.current = null; }
    };
    const clearHover = () => { clearFaceHover(); clearDatumHover(); };
    const clearFirst = () => {
      if (firstHlRef.current) disposeMesh(firstHlRef.current);
      firstHlRef.current = null;
      if (firstDatumMatRef.current) { firstDatumMatRef.current.opacity = DATUM_OPACITY; firstDatumMatRef.current = null; }
      firstRef.current = null;
    };

    if (mode !== 'DATUM_MIDPLANE_PICK') { clearHover(); clearFirst(); container.style.cursor = 'default'; return; }

    useCADStore.getState().log('Pick the first planar face or datum (1 / 2).', 'info');

    const cast = (e: MouseEvent) => {
      const camera = cameraRef.current;
      const scene  = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return FacePicker.raycastFacesAndDatums(raycaster, scene);
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_MIDPLANE_PICK') return;
      const res = cast(e);
      if (!res) { clearHover(); container.style.cursor = 'default'; return; }
      if (res.kind === 'face') {
        clearDatumHover();
        const key = `${res.hit.nodeId}#${res.hit.faceIndex}`;
        if (key === firstRef.current?.key) { clearFaceHover(); container.style.cursor = 'pointer'; return; }  // it's the locked one
        if (key !== hoverKeyRef.current) {
          clearFaceHover();
          hoverKeyRef.current = key;
          const hl = FacePicker.makeHighlight(res.hit.mesh, res.hit.group, { color: COLOR_HOVER });
          sceneRef.current!.add(hl); hoverHlRef.current = hl;
        }
      } else {
        clearFaceHover();
        const mat = res.mesh.material as THREE.MeshBasicMaterial;
        if (mat !== firstDatumMatRef.current && mat !== datumHoverRef.current) { clearDatumHover(); mat.opacity = 0.4; datumHoverRef.current = mat; }
      }
      container.style.cursor = 'pointer';
    };

    const commit = (r1: RefMeta, r2: RefMeta) => {
      const st = useCADStore.getState();
      const wp = OccDatumService.midplane(
        window.oc, r1.workplane.origin, r1.workplane.normal, r2.workplane.origin, r2.workplane.normal,
      );
      st.setInteractionMode('SELECT');                 // exit (highlights dispose)
      if (!wp) { st.log('Could not build a midplane from those two faces.', 'warn'); return; }
      st.createDatumPlane(wp, 'midplane', [
        { kind: r1.kind, nodeId: r1.sourceId },
        { kind: r2.kind, nodeId: r2.sourceId },
      ]);
      st.log('Midplane created.', 'success');
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const res = cast(e);
      if (!res) return;
      const st = useCADStore.getState();

      // Resolve the picked reference to a workplane.
      let ref: RefMeta | null = null;
      if (res.kind === 'face') {
        const key = `${res.hit.nodeId}#${res.hit.faceIndex}`;
        if (key === firstRef.current?.key) return;     // ignore re-click of the first
        const wp = facePlaneWp(res.hit.nodeId, res.hit.faceIndex);
        if (!wp) { st.log('That face is not planar — pick a flat face.', 'warn'); return; }
        ref = { workplane: wp, sourceId: res.hit.nodeId, kind: 'face', key };
      } else {
        const wp = st.nodes[res.nodeId]?.params?.workplane as Workplane | undefined;
        if (!wp) return;
        ref = { workplane: wp, sourceId: res.nodeId, kind: 'datum', key: `datum#${res.nodeId}` };
        if (ref.key === firstRef.current?.key) return;
      }
      e.stopPropagation();

      // First pick → lock it; second pick → commit.
      if (!firstRef.current) {
        firstRef.current = ref;
        clearHover();
        if (res.kind === 'face') {
          const hl = FacePicker.makeHighlight(res.hit.mesh, res.hit.group, { color: COLOR_PICKED, opacity: 0.5 });
          sceneRef.current!.add(hl); firstHlRef.current = hl;
        } else {
          const mat = res.mesh.material as THREE.MeshBasicMaterial;
          mat.opacity = 0.45; firstDatumMatRef.current = mat;
        }
        st.log('Pick the second planar face or datum (2 / 2).', 'info');
        return;
      }
      clearHover();
      container.style.cursor = 'default';
      commit(firstRef.current, ref);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearHover(); useCADStore.getState().setInteractionMode('SELECT'); }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      clearHover(); clearFirst();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
