// ============================================================
// ToubkalCAD – useCADDatum3PointPick.ts
//
// Track D, D4 — "Plane through 3 Points".
//
// Active only while interactionMode === 'DATUM_3POINT_PICK'. Every vertex of
// every visible solid becomes a small raycastable marker. The user clicks three
// of them (markers turn amber as they're locked in); on the third, a plane is
// built through them (gce_MakePln, via OccDatumService) and persisted as a datum.
// Near-collinear triples are rejected. Esc cancels the in-progress selection.
//
// Marker pattern mirrors the measurement points; pick/hover mirrors the other
// datum pick hooks.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccDatumService } from '../services/OccDatumService';
import { getPlacedShape } from '../utils/placedShape';

const COLOR_IDLE     = 0x2a7fd4; // resting vertex marker (blue)
const COLOR_HOVER    = 0x00e0a0; // under cursor (green)
const COLOR_PICKED   = 0xf0a30a; // locked-in (amber, datum colour)
const CLICK_SLOP_PX  = 5;
const SAME_PT        = 1e-4;     // two picks closer than this = the same vertex

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADDatum3PointPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const markersRef   = useRef<THREE.Mesh[]>([]);
  const hoverRef     = useRef<THREE.Mesh | null>(null);
  const pickedRef    = useRef<[number, number, number][]>([]);
  const pickedSrcRef = useRef<string[]>([]);

  // ─── Build / tear down vertex markers ────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const m of markersRef.current) {
        scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      markersRef.current = [];
      hoverRef.current = null;
      pickedRef.current = [];
      pickedSrcRef.current = [];
    };

    dispose();
    if (mode !== 'DATUM_3POINT_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();

    // Gather de-duplicated world-space vertices across all visible solids.
    const pts: [number, number, number][] = [];
    const ptSrc: string[] = [];
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        for (const p of OccDatumService.extractVertices(window.oc, placed)) {
          if (!pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < SAME_PT)) { pts.push(p); ptSrc.push(id); }
        }
      } catch {
        /* skip solids that fail vertex extraction */
      } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
    if (pts.length === 0) return;

    // Marker size from the points' bounding-box diagonal (scale-independent).
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const r = Math.max(diag * 0.012, 0.1);

    const geo = new THREE.SphereGeometry(r, 12, 12);
    pts.forEach((p, i) => {
      const mesh = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: COLOR_IDLE, depthTest: false }));
      mesh.position.set(p[0], p[1], p[2]);
      mesh.renderOrder = 1000;
      mesh.userData = { datumVertex: p, picked: false, sourceId: ptSrc[i] };
      scene.add(mesh);
      markersRef.current.push(mesh);
    });
    geo.dispose();                          // markers hold independent clones
    st.log(`Pick 3 vertices to define a plane (0 / 3).`, 'info');

    return dispose;
  }, [mode, sceneRef]);

  // ─── Hover + click ───────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const baseColor = (m: THREE.Mesh) =>
      (m.userData.picked ? COLOR_PICKED : COLOR_IDLE);

    const clearHover = () => {
      const m = hoverRef.current;
      if (m) (m.material as THREE.MeshBasicMaterial).color.setHex(baseColor(m));
      hoverRef.current = null;
    };

    if (mode !== 'DATUM_3POINT_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    const pick = (e: MouseEvent): THREE.Mesh | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(markersRef.current, false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };

    const reset = () => {
      for (const m of markersRef.current) {
        m.userData.picked = false;
        (m.material as THREE.MeshBasicMaterial).color.setHex(COLOR_IDLE);
      }
      pickedRef.current = [];
      pickedSrcRef.current = [];
    };

    const commit = () => {
      const [a, b, c] = pickedRef.current;
      const wp = OccDatumService.planeFrom3Points(window.oc, a, b, c);
      const st = useCADStore.getState();
      if (!wp) { st.log('Those 3 points are collinear — pick a non-collinear set.', 'warn'); reset(); return; }
      st.createDatumPlane(wp, 'threePoint', pickedRef.current.map((p, i) => ({ kind: 'point', pos: p, nodeId: pickedSrcRef.current[i] })));
      st.log('Plane through 3 points created.', 'success');
      pickedRef.current = [];                 // dispose() runs on the mode change below
      st.setInteractionMode('SELECT');
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_3POINT_PICK') return;
      const m = pick(e);
      if (m === hoverRef.current) return;
      clearHover();
      if (m) {
        (m.material as THREE.MeshBasicMaterial).color.setHex(COLOR_HOVER);
        hoverRef.current = m;
      }
      container.style.cursor = m ? 'pointer' : 'default';
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
      const p = m.userData.datumVertex as [number, number, number];
      if (m.userData.picked) return;          // already locked in
      if (pickedRef.current.some((q) => Math.hypot(q[0]-p[0], q[1]-p[1], q[2]-p[2]) < SAME_PT)) return;
      m.userData.picked = true;
      (m.material as THREE.MeshBasicMaterial).color.setHex(COLOR_PICKED);
      hoverRef.current = null;
      pickedRef.current.push(p);
      pickedSrcRef.current.push(m.userData.sourceId as string);
      const n = pickedRef.current.length;
      if (n < 3) { useCADStore.getState().log(`Pick 3 vertices to define a plane (${n} / 3).`, 'info'); return; }
      commit();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearHover(); reset(); useCADStore.getState().setInteractionMode('SELECT'); }
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
