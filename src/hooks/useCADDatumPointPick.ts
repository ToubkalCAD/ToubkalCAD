// ============================================================
// ToubkalCAD – useCADDatumPointPick.ts
//
// Track D, D8 — "Datum Point".
//
// Active only while interactionMode === 'DATUM_POINT_PICK'. Two pickable kinds:
//   • every solid VERTEX → a marker (point exactly there);
//   • every EDGE → a pickable line (point at its midpoint).
// A single click creates a datum_point node. Esc cancels. Vertex markers mirror
// D4; edge lines mirror D7.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccDatumService } from '../services/OccDatumService';
import { OccEdgeService } from '../services/OccEdgeService';
import { getPlacedShape } from '../utils/placedShape';

const VERT_IDLE  = 0x2a7fd4;
const VERT_HOVER = 0x00e0a0;
const EDGE_IDLE  = 0x66ccff;
const EDGE_HOVER = 0xffe000;
const CLICK_SLOP_PX = 5;
const SAME_PT = 1e-4;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADDatumPointPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const markersRef   = useRef<THREE.Mesh[]>([]);
  const edgeLinesRef = useRef<THREE.Line[]>([]);
  const vertHoverRef = useRef<THREE.Mesh | null>(null);
  const edgeHoverRef = useRef<THREE.Line | null>(null);
  const threshRef    = useRef<number>(0.6);

  // ─── Build / tear down vertex markers + edge lines ───────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const m of markersRef.current)  { scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      for (const l of edgeLinesRef.current) { scene.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
      markersRef.current = [];
      edgeLinesRef.current = [];
      vertHoverRef.current = null;
      edgeHoverRef.current = null;
    };

    dispose();
    if (mode !== 'DATUM_POINT_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();

    const verts: [number, number, number][] = [];
    const vertSrc: string[] = [];
    const edges: { points: [number, number, number][]; sourceId: string }[] = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const bump = (p: [number, number, number]) => { for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); } };

    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        for (const p of OccDatumService.extractVertices(window.oc, placed)) {
          if (!verts.some((q) => Math.hypot(q[0]-p[0], q[1]-p[1], q[2]-p[2]) < SAME_PT)) { verts.push(p); vertSrc.push(id); bump(p); }
        }
        for (const e of OccEdgeService.extractEdges(window.oc, placed)) { edges.push({ points: e.points, sourceId: id }); for (const p of e.points) bump(p); }
      } catch {
        /* skip extraction failures */
      } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }

    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const r = isFinite(diag) && diag > 0 ? Math.max(diag * 0.012, 0.1) : 0.5;
    threshRef.current = isFinite(diag) && diag > 0 ? Math.max(diag * 0.02, 0.3) : 0.6;

    const geo = new THREE.SphereGeometry(r, 12, 12);
    verts.forEach((p, i) => {
      const mesh = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: VERT_IDLE, depthTest: false }));
      mesh.position.set(p[0], p[1], p[2]);
      mesh.renderOrder = 1000;
      mesh.userData = { datumPoint: p, sourceId: vertSrc[i] };
      scene.add(mesh);
      markersRef.current.push(mesh);
    });
    geo.dispose();

    for (const e of edges) {
      const mid = e.points[Math.floor(e.points.length / 2)];   // curve param midpoint sample
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(e.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))),
        new THREE.LineBasicMaterial({ color: EDGE_IDLE, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      line.renderOrder = 999;
      line.userData = { datumPoint: mid, sourceId: e.sourceId };
      scene.add(line);
      edgeLinesRef.current.push(line);
    }

    if (!verts.length && !edges.length) st.log('No vertices or edges to place a point on.', 'warn');
    else st.log('Pick a vertex, or an edge to place a point at its midpoint.', 'info');

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
      if (vertHoverRef.current) (vertHoverRef.current.material as THREE.MeshBasicMaterial).color.setHex(VERT_IDLE);
      vertHoverRef.current = null;
      if (edgeHoverRef.current) (edgeHoverRef.current.material as THREE.LineBasicMaterial).color.setHex(EDGE_IDLE);
      edgeHoverRef.current = null;
    };

    if (mode !== 'DATUM_POINT_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    const pick = (e: MouseEvent): THREE.Object3D | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: threshRef.current };
      // Vertices first so a marker on an edge endpoint wins over the edge line.
      const vHit = raycaster.intersectObjects(markersRef.current, false);
      if (vHit.length) return vHit[0].object;
      const eHit = raycaster.intersectObjects(edgeLinesRef.current, false);
      return eHit.length ? eHit[0].object : null;
    };

    const setHover = (o: THREE.Object3D | null) => {
      clearHover();
      if (!o) { container.style.cursor = 'default'; return; }
      if (o instanceof THREE.Mesh) { (o.material as THREE.MeshBasicMaterial).color.setHex(VERT_HOVER); vertHoverRef.current = o; }
      else if (o instanceof THREE.Line) { (o.material as THREE.LineBasicMaterial).color.setHex(EDGE_HOVER); edgeHoverRef.current = o; }
      container.style.cursor = 'pointer';
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_POINT_PICK') return;
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
      const o = pick(e);
      if (!o) return;
      e.stopPropagation();
      const p = o.userData.datumPoint as [number, number, number];
      const onEdge = o instanceof THREE.Line;
      const sourceId = o.userData.sourceId as string | undefined;
      clearHover();
      container.style.cursor = 'default';
      const st = useCADStore.getState();
      st.setInteractionMode('SELECT');                 // exit (disposes markers/lines)
      st.createDatumPoint(p, onEdge ? 'edgeMid' : 'vertex', sourceId ? [{ kind: onEdge ? 'edge' : 'vertex', nodeId: sourceId }] : []);
      st.log(`Datum point created at ${onEdge ? 'an edge midpoint' : 'a vertex'}.`, 'success');
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
