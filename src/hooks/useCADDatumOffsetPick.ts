// ============================================================
// ToubkalCAD – useCADDatumOffsetPick.ts
//
// Track D, D2 — "Offset Plane" (pick a reference, then offset it).
//
// Active only while interactionMode === 'DATUM_OFFSET_PICK'. The user clicks a
// reference to offset from:
//   • a PLANAR face of any solid  (transparent overlay per face, like S2), or
//   • an existing datum plane     (the persistent amber faces, like D9).
// On click we capture that reference's Workplane, drop back to SELECT, ask for a
// signed distance (ParameterModal), and create a new datum plane parallel to the
// reference, shifted `distance` along its normal. Negative distance flips sides.
//
// Pure data — no OCC: the offset workplane is origin + normal·d, same axes. The
// source id + distance are stored in the datum's `refs` for future associativity
// (D13). Mirrors useCADSketchFacePick / useCADDatumSketchPick.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService } from '../services/OccFaceService';
import { getPlacedShape } from '../utils/placedShape';
import { showParamModal } from '../components/ParameterModal';

const COLOR_IDLE     = 0x2a7fd4;
const COLOR_HOVER    = 0x00e0a0;
const DATUM_OPACITY  = 0.16;   // resting opacity of the persistent amber datum face
const CLICK_SLOP_PX  = 5;

interface RefMeta { workplane: Workplane; sourceId: string; kind: 'face' | 'datum'; }

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADDatumOffsetPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const overlaysRef   = useRef<THREE.Mesh[]>([]);                  // per-planar-face overlays
  const faceHoverRef  = useRef<THREE.Mesh | null>(null);
  const datumHoverRef = useRef<THREE.MeshBasicMaterial | null>(null);

  // ─── Build / tear down planar-face overlays ──────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const m of overlaysRef.current) {
        scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      overlaysRef.current = [];
      faceHoverRef.current = null;
    };

    dispose();
    if (mode !== 'DATUM_OFFSET_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        const faces = OccFaceService.extractPlanarFaces(window.oc, placed);
        for (const f of faces) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({
            color: COLOR_IDLE, transparent: true, opacity: 0.12,
            side: THREE.DoubleSide, depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 998;
          const wp: Workplane = { label: 'Face', origin: f.origin, normal: f.normal, uAxis: f.uAxis, vAxis: f.vAxis };
          mesh.userData = { datumOffsetRef: { workplane: wp, sourceId: id, kind: 'face' } as RefMeta };
          scene.add(mesh);
          overlaysRef.current.push(mesh);
        }
      } catch {
        /* solid without usable planar faces — datum planes are still pickable */
      } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
  }, [mode, sceneRef]);

  // ─── Hover + click ───────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearHover = () => {
      if (faceHoverRef.current) {
        const mat = faceHoverRef.current.material as THREE.MeshBasicMaterial;
        mat.color.setHex(COLOR_IDLE); mat.opacity = 0.12;
      }
      faceHoverRef.current = null;
      if (datumHoverRef.current) { datumHoverRef.current.opacity = DATUM_OPACITY; datumHoverRef.current = null; }
    };

    if (mode !== 'DATUM_OFFSET_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    // The persistent amber datum faces (tagged in Viewport3D) are also pickable.
    const datumFaces = (): THREE.Mesh[] => {
      const scene = sceneRef.current;
      if (!scene) return [];
      const out: THREE.Mesh[] = [];
      scene.traverse((o) => { if (o instanceof THREE.Mesh && o.userData?.datumNodeId) out.push(o); });
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
      const hits = raycaster.intersectObjects([...overlaysRef.current, ...datumFaces()], false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };

    const setHover = (m: THREE.Mesh | null) => {
      clearHover();
      if (!m) { container.style.cursor = 'default'; return; }
      const mat = m.material as THREE.MeshBasicMaterial;
      if (m.userData?.datumOffsetRef) { mat.color.setHex(COLOR_HOVER); mat.opacity = 0.32; faceHoverRef.current = m; }
      else if (m.userData?.datumNodeId) { mat.opacity = 0.4; datumHoverRef.current = mat; }
      container.style.cursor = 'pointer';
    };

    const resolveRef = (m: THREE.Mesh): RefMeta | null => {
      if (m.userData?.datumOffsetRef) return m.userData.datumOffsetRef as RefMeta;
      const did = m.userData?.datumNodeId as string | undefined;
      if (did) {
        const wp = useCADStore.getState().nodes[did]?.params?.workplane as Workplane | undefined;
        if (wp) return { workplane: wp, sourceId: did, kind: 'datum' };
      }
      return null;
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
      st.createDatumPlane(offsetWp, 'offset', [{ kind: ref.kind, nodeId: ref.sourceId, distance: d }]);
      st.log(`Offset plane: ${d} mm from ${sourceName}.`, 'success');
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_OFFSET_PICK') return;
      setHover(pick(e));
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const m = pick(e);
      if (!m) return;
      e.stopPropagation();
      const ref = resolveRef(m);
      clearHover();
      container.style.cursor = 'default';
      useCADStore.getState().setInteractionMode('SELECT');  // exit pick (overlays dispose)
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
