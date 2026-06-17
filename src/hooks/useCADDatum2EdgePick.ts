// ============================================================
// ToubkalCAD – useCADDatum2EdgePick.ts
//
// Track D, D6 — "Plane through 2 Edges" (coplanar edges).
//
// Active only while interactionMode === 'DATUM_2EDGE_PICK'. Every edge becomes a
// pickable line. The user clicks two; the first locks amber. On the second we
// build the plane through three of the edges' endpoints (OccDatumService.
// planeThrough2Edges). Skew (non-coplanar) edges still build a plane through the
// first edge + one endpoint of the second. Esc cancels.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccEdgeService } from '../services/OccEdgeService';
import { OccDatumService } from '../services/OccDatumService';
import { captureEdge } from '../services/StableRef';
import { getPlacedShape } from '../utils/placedShape';

const EDGE_IDLE   = 0x66ccff;
const EDGE_HOVER  = 0xffe000;
const EDGE_PICKED = 0xf0a30a;
const CLICK_SLOP_PX = 5;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADDatum2EdgePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const linesRef    = useRef<THREE.Line[]>([]);
  const hoverRef    = useRef<THREE.Line | null>(null);
  const firstRef    = useRef<THREE.Line | null>(null);
  const threshRef   = useRef<number>(0.6);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const dispose = () => {
      for (const l of linesRef.current) { scene.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
      linesRef.current = [];
      hoverRef.current = null;
      firstRef.current = null;
    };
    dispose();
    if (mode !== 'DATUM_2EDGE_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        for (const e of OccEdgeService.extractEdges(window.oc, placed)) {
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(e.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))),
            new THREE.LineBasicMaterial({ color: EDGE_IDLE, depthTest: false, transparent: true, opacity: 0.9 }),
          );
          line.renderOrder = 999;
          line.userData = { points: e.points, sourceId: id, edgeIndex: e.index };
          scene.add(line);
          linesRef.current.push(line);
          for (const p of e.points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
        }
      } catch { /* skip */ } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    threshRef.current = isFinite(diag) && diag > 0 ? Math.max(diag * 0.02, 0.3) : 0.6;
    st.log(linesRef.current.length ? 'Pick the first edge (1 / 2).' : 'No edges available.', linesRef.current.length ? 'info' : 'warn');
    return dispose;
  }, [mode, sceneRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearHover = () => {
      const l = hoverRef.current;
      if (l && l !== firstRef.current) (l.material as THREE.LineBasicMaterial).color.setHex(EDGE_IDLE);
      hoverRef.current = null;
    };
    if (mode !== 'DATUM_2EDGE_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    const pick = (e: MouseEvent): THREE.Line | null => {
      const camera = cameraRef.current; if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: threshRef.current };
      const hits = raycaster.intersectObjects(linesRef.current, false);
      return hits.length ? (hits[0].object as THREE.Line) : null;
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_2EDGE_PICK') return;
      const l = pick(e);
      if (l !== hoverRef.current) {
        clearHover();
        if (l && l !== firstRef.current) { (l.material as THREE.LineBasicMaterial).color.setHex(EDGE_HOVER); hoverRef.current = l; }
      }
      container.style.cursor = l ? 'pointer' : 'default';
    };
    const onDown = (e: MouseEvent) => { if (e.button !== 0) return; downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true; };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const l = pick(e);
      if (!l || l === firstRef.current) return;
      e.stopPropagation();
      if (!firstRef.current) {
        firstRef.current = l;
        (l.material as THREE.LineBasicMaterial).color.setHex(EDGE_PICKED);
        hoverRef.current = null;
        useCADStore.getState().log('Pick the second edge (2 / 2).', 'info');
        return;
      }
      const ptsA = firstRef.current.userData.points as [number, number, number][];
      const ptsB = l.userData.points as [number, number, number][];
      const srcA = firstRef.current.userData.sourceId as string | undefined;
      const srcB = l.userData.sourceId as string | undefined;
      const idxA = firstRef.current.userData.edgeIndex as number | undefined;
      const idxB = l.userData.edgeIndex as number | undefined;
      clearHover();
      container.style.cursor = 'default';
      const st = useCADStore.getState();
      st.setInteractionMode('SELECT');
      const wp = OccDatumService.planeThrough2Edges(window.oc, ptsA, ptsB);
      if (!wp) { st.log('Those edges do not define a plane (collinear).', 'warn'); return; }
      // Step 4 — capture an EdgeSig per edge (against its own placed body) so
      // evaluateDatum re-samples both on the live bodies and the plane FOLLOWS edits;
      // either edge rejecting → baked `wp` fallback. refs order = A then B.
      const reg = CADGeometryRegistry.getInstance();
      const capEdge = (sid?: string, idx?: number) => {
        if (!sid || idx == null) return null;
        const placed = getPlacedShape(sid);
        const sig = placed ? captureEdge(window.oc, placed, idx) : null;
        if (placed && placed !== reg.getShape(sid)) { try { placed.delete(); } catch {} }
        return sig;
      };
      const refs = [];
      if (srcA) refs.push({ kind: 'edge', nodeId: srcA, sel: capEdge(srcA, idxA) ?? undefined });
      if (srcB) refs.push({ kind: 'edge', nodeId: srcB, sel: capEdge(srcB, idxB) ?? undefined });
      st.createDatumPlane(wp, 'twoEdges', refs);
      st.log('Plane through 2 edges created.', 'success');
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
