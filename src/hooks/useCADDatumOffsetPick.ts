// ============================================================
// ToubkalCAD – useCADDatumOffsetPick.ts
//
// Track D, D2 — "Offset Plane" (pick a reference, then offset it).
//
// Active only while interactionMode === 'DATUM_OFFSET_PICK'. The user clicks a
// reference to offset from:
//   • a PLANAR face of any solid  (picked on the REAL mesh via FacePicker), or
//   • an existing datum plane     (the persistent amber faces, like D9).
// On click we capture that reference's Workplane, drop back to SELECT, ask for a
// signed distance (ParameterModal), and create a new datum plane parallel to the
// reference, shifted `distance` along its normal. Negative distance flips sides.
//
// Pure data — no OCC math here: the offset workplane is origin + normal·d, same
// axes. The source id + distance are stored in the datum's `refs` for future
// associativity (D13).
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService } from '../services/OccFaceService';
import { FacePicker } from '../services/FacePicker';
import { captureFace } from '../services/StableRef';
import { getPlacedShape } from '../utils/placedShape';
import { showParamModal } from '../components/ParameterModal';

const DATUM_OPACITY  = 0.16;   // resting opacity of the persistent amber datum face
const CLICK_SLOP_PX  = 5;

interface RefMeta { workplane: Workplane; sourceId: string; kind: 'face' | 'datum'; faceRef?: any; }

/** World-space workplane of one solid face (null if curved) PLUS a stable
 *  signature of that face — captured against the same placed shape, so the
 *  offset datum can re-derive its base frame on recompute (step 4). */
function facePlaneAndSig(nodeId: string, faceIndex: number): { wp: Workplane; sig: any } | null {
  const reg    = CADGeometryRegistry.getInstance();
  const placed = getPlacedShape(nodeId);
  if (!placed) return null;
  try {
    const p = OccFaceService.planeFromFaceIndex(window.oc, placed, faceIndex);
    if (!p) return null;
    const sig = captureFace(window.oc, placed, faceIndex);
    return { wp: { label: 'Face', origin: p.origin, normal: p.normal, uAxis: p.uAxis, vAxis: p.vAxis }, sig };
  } finally {
    if (placed !== reg.getShape(nodeId)) { try { placed.delete(); } catch {} }
  }
}

export function useCADDatumOffsetPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const hoverHlRef    = useRef<THREE.Mesh | null>(null);                 // solid-face hover highlight
  const hoverKeyRef   = useRef<string | null>(null);
  const datumHoverRef = useRef<THREE.MeshBasicMaterial | null>(null);    // tinted persistent datum mat

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearFaceHover = () => {
      const scene = sceneRef.current;
      if (hoverHlRef.current && scene) {
        scene.remove(hoverHlRef.current);
        hoverHlRef.current.geometry.dispose();
        (hoverHlRef.current.material as THREE.Material).dispose();
      }
      hoverHlRef.current = null; hoverKeyRef.current = null;
    };
    const clearDatumHover = () => {
      if (datumHoverRef.current) { datumHoverRef.current.opacity = DATUM_OPACITY; datumHoverRef.current = null; }
    };
    const clearHover = () => { clearFaceHover(); clearDatumHover(); };

    if (mode !== 'DATUM_OFFSET_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    useCADStore.getState().log('Pick a planar face or datum to offset from.', 'info');

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
      if (useCADStore.getState().interactionMode !== 'DATUM_OFFSET_PICK') return;
      const res = cast(e);
      if (!res) { clearHover(); container.style.cursor = 'default'; return; }
      if (res.kind === 'face') {
        clearDatumHover();
        const key = `${res.hit.nodeId}#${res.hit.faceIndex}`;
        if (key !== hoverKeyRef.current) {
          clearFaceHover();
          hoverKeyRef.current = key;
          const scene = sceneRef.current!;
          const hl = FacePicker.makeHighlight(res.hit.mesh, res.hit.group);
          scene.add(hl); hoverHlRef.current = hl;
        }
      } else {
        clearFaceHover();
        const mat = res.mesh.material as THREE.MeshBasicMaterial;
        if (mat !== datumHoverRef.current) { clearDatumHover(); mat.opacity = 0.4; datumHoverRef.current = mat; }
      }
      container.style.cursor = 'pointer';
    };

    const createOffset = async (ref: RefMeta) => {
      const sourceName = useCADStore.getState().nodes[ref.sourceId]?.name ?? 'reference';
      const v = await showParamModal(`Offset Plane (from ${sourceName})`, [
        { key: 'd', label: 'Distance', default: 20, min: -100000, max: 100000, unit: 'mm' },
      ]);
      if (!v) return;                                  // cancelled
      const d  = v.d ?? 0;
      const wp = ref.workplane;
      const origin: [number, number, number] = [
        wp.origin[0] + wp.normal[0] * d,
        wp.origin[1] + wp.normal[1] * d,
        wp.origin[2] + wp.normal[2] * d,
      ];
      const offsetWp: Workplane = { label: 'Offset', origin, normal: wp.normal, uAxis: wp.uAxis, vAxis: wp.vAxis };
      const st = useCADStore.getState();
      // `sel` carries the face signature so the datum re-derives its base frame on
      // recompute; `distance` is the (now graph-carried) offset value.
      st.createDatumPlane(offsetWp, 'offset', [{ kind: ref.kind, nodeId: ref.sourceId, distance: d, sel: ref.faceRef }]);
      st.log(`Offset plane: ${d} mm from ${sourceName}.`, 'success');
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
      e.stopPropagation();
      const st = useCADStore.getState();

      let ref: RefMeta | null = null;
      if (res.kind === 'face') {
        const fp = facePlaneAndSig(res.hit.nodeId, res.hit.faceIndex);
        if (!fp) { st.log('That face is not planar — pick a flat face.', 'warn'); return; }
        ref = { workplane: fp.wp, sourceId: res.hit.nodeId, kind: 'face', faceRef: fp.sig };
      } else {
        const wp = st.nodes[res.nodeId]?.params?.workplane as Workplane | undefined;
        if (wp) ref = { workplane: wp, sourceId: res.nodeId, kind: 'datum' };
      }

      clearHover();
      container.style.cursor = 'default';
      st.setInteractionMode('SELECT');   // exit pick
      if (ref) void createOffset(ref);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearHover(); useCADStore.getState().setInteractionMode('SELECT'); }
    };

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
