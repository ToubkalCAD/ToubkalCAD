// ============================================================
// ToubkalCAD – useCADDatumMidplanePick.ts
//
// Track D, D5 — "Midplane" (plane midway between two planar references).
//
// Active only while interactionMode === 'DATUM_MIDPLANE_PICK'. Same pickable set
// as the Offset tool (D2): a transparent overlay per PLANAR face of each solid,
// plus the persistent amber datum planes. The user clicks two of them; the first
// stays locked amber while the second is chosen. On the second pick we build the
// midplane (OccDatumService.midplane) and persist it as a datum. Esc cancels.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService } from '../services/OccFaceService';
import { OccDatumService } from '../services/OccDatumService';
import { getPlacedShape } from '../utils/placedShape';

const COLOR_IDLE     = 0x2a7fd4;
const COLOR_HOVER    = 0x00e0a0;
const COLOR_PICKED   = 0xf0a30a; // first reference locked in (amber)
const DATUM_OPACITY  = 0.16;
const CLICK_SLOP_PX  = 5;

interface RefMeta { workplane: Workplane; sourceId: string; kind: 'face' | 'datum'; }

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADDatumMidplanePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const overlaysRef   = useRef<THREE.Mesh[]>([]);
  const faceHoverRef  = useRef<THREE.Mesh | null>(null);
  const datumHoverRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const firstRef       = useRef<RefMeta | null>(null);
  const firstMeshRef   = useRef<THREE.Mesh | null>(null);
  const firstDatumMatRef = useRef<THREE.MeshBasicMaterial | null>(null); // shared datum mat to restore

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
      firstRef.current = null;
      firstMeshRef.current = null;
      // Restore a locked-in datum face's shared material (our overlays are disposed
      // above, but datum faces are persistent scene objects we only tinted).
      if (firstDatumMatRef.current) { firstDatumMatRef.current.opacity = DATUM_OPACITY; firstDatumMatRef.current = null; }
    };

    dispose();
    if (mode !== 'DATUM_MIDPLANE_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        for (const f of OccFaceService.extractPlanarFaces(window.oc, placed)) {
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
          mesh.userData = { datumMidRef: { workplane: wp, sourceId: id, kind: 'face' } as RefMeta };
          scene.add(mesh);
          overlaysRef.current.push(mesh);
        }
      } catch {
        /* solid without planar faces — datums are still pickable */
      } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
    st.log('Pick the first planar face or datum (1 / 2).', 'info');

    return dispose;
  }, [mode, sceneRef]);

  // ─── Hover + click ───────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearHover = () => {
      const m = faceHoverRef.current;
      if (m && m !== firstMeshRef.current) {
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.setHex(COLOR_IDLE); mat.opacity = 0.12;
      }
      faceHoverRef.current = null;
      if (datumHoverRef.current) { datumHoverRef.current.opacity = DATUM_OPACITY; datumHoverRef.current = null; }
    };

    if (mode !== 'DATUM_MIDPLANE_PICK') { clearHover(); container.style.cursor = 'default'; return; }

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
      if (!m || m === firstMeshRef.current) { container.style.cursor = m ? 'pointer' : 'default'; return; }
      const mat = m.material as THREE.MeshBasicMaterial;
      if (m.userData?.datumMidRef) { mat.color.setHex(COLOR_HOVER); mat.opacity = 0.32; faceHoverRef.current = m; }
      else if (m.userData?.datumNodeId) { mat.opacity = 0.4; datumHoverRef.current = mat; }
      container.style.cursor = 'pointer';
    };

    const resolveRef = (m: THREE.Mesh): RefMeta | null => {
      if (m.userData?.datumMidRef) return m.userData.datumMidRef as RefMeta;
      const did = m.userData?.datumNodeId as string | undefined;
      if (did) {
        const wp = useCADStore.getState().nodes[did]?.params?.workplane as Workplane | undefined;
        if (wp) return { workplane: wp, sourceId: did, kind: 'datum' };
      }
      return null;
    };

    const lockFirst = (m: THREE.Mesh) => {
      firstMeshRef.current = m;
      const mat = m.material as THREE.MeshBasicMaterial;
      if (m.userData?.datumMidRef) { mat.color.setHex(COLOR_PICKED); mat.opacity = 0.5; }
      else { mat.opacity = 0.45; firstDatumMatRef.current = mat; }   // datum face: brighten + remember to restore
    };

    const commit = (r1: RefMeta, r2: RefMeta) => {
      const st = useCADStore.getState();
      const wp = OccDatumService.midplane(
        window.oc, r1.workplane.origin, r1.workplane.normal, r2.workplane.origin, r2.workplane.normal,
      );
      st.setInteractionMode('SELECT');                 // exit (overlays dispose)
      if (!wp) { st.log('Could not build a midplane from those two faces.', 'warn'); return; }
      st.createDatumPlane(wp, 'midplane', [
        { kind: r1.kind, nodeId: r1.sourceId },
        { kind: r2.kind, nodeId: r2.sourceId },
      ]);
      st.log('Midplane created.', 'success');
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_MIDPLANE_PICK') return;
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
      if (!m || m === firstMeshRef.current) return;     // ignore re-click of the first
      const ref = resolveRef(m);
      if (!ref) return;
      e.stopPropagation();
      if (!firstRef.current) {
        firstRef.current = ref;
        faceHoverRef.current = null;
        datumHoverRef.current = null;
        lockFirst(m);
        useCADStore.getState().log('Pick the second planar face or datum (2 / 2).', 'info');
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
      clearHover();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
