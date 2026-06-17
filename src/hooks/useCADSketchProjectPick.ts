// ============================================================
// ToubkalCAD – useCADSketchProjectPick.ts
//
// Track D, D11 — "Project / Include" onto the active sketch.
//
// Active only while interactionMode === 'PROJECT_PICK' (during a sketch
// session). Every edge of every solid becomes a pickable line; clicking one
// orthographically projects it onto the active sketch plane (each sampled point
// → local u,v) and adds it as a polyline sketch_wire entity. Stays in the mode so
// several edges can be projected; Esc finishes.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccEdgeService } from '../services/OccEdgeService';
import { toLocal2D } from '../services/OccSketchService';
import { createSketchEntityNode } from '../utils/sketchEntity';
import { getPlacedShape } from '../utils/placedShape';

const EDGE_IDLE  = 0x66ccff;
const EDGE_HOVER = 0xffe000;
const CLICK_SLOP_PX = 5;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

export function useCADSketchProjectPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const linesRef  = useRef<THREE.Line[]>([]);
  const hoverRef  = useRef<THREE.Line | null>(null);
  const threshRef = useRef<number>(0.6);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const dispose = () => {
      for (const l of linesRef.current) { scene.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
      linesRef.current = [];
      hoverRef.current = null;
    };
    dispose();
    if (mode !== 'PROJECT_PICK' || !window.oc) return;
    if (!useCADStore.getState().sketchSession) return;

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
          line.userData = { points: e.points };
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
    st.log(linesRef.current.length ? 'Click edges to project onto the sketch (Esc to finish).' : 'No edges to project.', linesRef.current.length ? 'info' : 'warn');
    return dispose;
  }, [mode, sceneRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearHover = () => {
      if (hoverRef.current) (hoverRef.current.material as THREE.LineBasicMaterial).color.setHex(EDGE_IDLE);
      hoverRef.current = null;
    };
    if (mode !== 'PROJECT_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    const pick = (e: MouseEvent): THREE.Line | null => {
      const camera = cameraRef.current; if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: threshRef.current };
      const hits = raycaster.intersectObjects(linesRef.current, false);
      return hits.length ? (hits[0].object as THREE.Line) : null;
    };

    const project = (points: [number, number, number][]) => {
      const session = useCADStore.getState().sketchSession;
      if (!session) return;
      const wp = session.plane;
      const pts = points.map((p) => { const l = toLocal2D(new THREE.Vector3(p[0], p[1], p[2]), wp); return [l.u, l.v]; });
      if (pts.length < 2) return;
      createSketchEntityNode({ kind: 'polyline', pts }, wp, session.id);
      useCADStore.getState().log('Edge projected onto the sketch.', 'success');
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'PROJECT_PICK') return;
      const l = pick(e);
      if (l !== hoverRef.current) { clearHover(); if (l) { (l.material as THREE.LineBasicMaterial).color.setHex(EDGE_HOVER); hoverRef.current = l; } }
      container.style.cursor = l ? 'pointer' : 'default';
    };
    const onDown = (e: MouseEvent) => { if (e.button !== 0) return; downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true; };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const l = pick(e);
      if (!l) return;
      e.stopPropagation();
      project(l.userData.points as [number, number, number][]);
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
