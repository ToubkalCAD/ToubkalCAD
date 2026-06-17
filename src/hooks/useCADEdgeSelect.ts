// ============================================================
// ToubkalCAD – useCADEdgeSelect.ts
//
// Phase 6 – per-edge fillet/chamfer edge picking.
//
// Active only while interactionMode === 'BLEND_EDGE' (driven by the
// store's blendReq). Renders one THREE.Line per shape edge on top of
// the solid (depthTest off), handles hover + click-to-toggle, and
// recolours from the store's selectedEdgeIndices.
//
// Click-vs-drag: a left press that releases within a few pixels is a
// pick; a larger movement is an OrbitControls rotation and is ignored.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { OccEdgeService } from '../services/OccEdgeService';
import { getPlacedShape } from '../utils/placedShape';

const COLOR_EDGE     = 0x66ccff; // idle
const COLOR_HOVER    = 0xffe000; // hovered
const COLOR_SELECTED = 0xff8800; // picked
const LINE_THRESHOLD = 0.6;      // world-space pick tolerance
const CLICK_SLOP_PX  = 5;        // max movement that still counts as a click

export function useCADEdgeSelect(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const blendReq            = useCADStore((s) => s.blendReq);
  const selectedEdgeIndices = useCADStore((s) => s.selectedEdgeIndices);

  // index → line, plus the currently hovered index
  const linesRef   = useRef<Map<number, THREE.Line>>(new Map());
  const hoverRef   = useRef<number>(-1);

  // ─── Build / tear down edge lines when the blend target changes ──────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const disposeLines = () => {
      for (const line of linesRef.current.values()) {
        scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      linesRef.current.clear();
      hoverRef.current = -1;
    };

    disposeLines();

    if (!blendReq || !window.oc) return;
    // Bake the node's placement so the pickable edge lines land on the moved
    // body — and so these indices match the fillet/chamfer application, which
    // bakes the same placement (deterministic → identical topology order).
    const shape = getPlacedShape(blendReq.targetId);
    if (!shape) {
      useCADStore.getState().log('Blend: target shape not found in registry.', 'error');
      return;
    }

    try {
      const edges = OccEdgeService.extractEdges(window.oc, shape);
      for (const e of edges) {
        const geo = new THREE.BufferGeometry().setFromPoints(
          e.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
        );
        const mat = new THREE.LineBasicMaterial({
          color: COLOR_EDGE, depthTest: false, transparent: true, opacity: 0.95,
        });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 999;
        line.userData = { isBlendEdge: true, edgeIndex: e.index };
        scene.add(line);
        linesRef.current.set(e.index, line);
      }
      useCADStore.getState().log(`Blend: ${edges.length} edges — click to select, then set radius.`, 'info');
    } catch (err: any) {
      useCADStore.getState().log(`Blend edge extraction failed: ${err?.message ?? err}`, 'error');
    }

    return disposeLines;
  }, [blendReq, sceneRef]);

  // ─── Recolour lines whenever the selection changes ──────────────────────────
  useEffect(() => {
    const sel = new Set(selectedEdgeIndices);
    for (const [idx, line] of linesRef.current) {
      const mat = line.material as THREE.LineBasicMaterial;
      mat.color.setHex(idx === hoverRef.current ? COLOR_HOVER : sel.has(idx) ? COLOR_SELECTED : COLOR_EDGE);
    }
  }, [selectedEdgeIndices]);

  // ─── Hover + click-to-toggle ────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const pickIndex = (e: MouseEvent): number => {
      const camera = cameraRef.current;
      if (!camera) return -1;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  *  2 - 1,
        -((e.clientY - rect.top)  / rect.height) *  2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: LINE_THRESHOLD };
      const lines = [...linesRef.current.values()];
      const hits  = raycaster.intersectObjects(lines, false);
      if (!hits.length) return -1;
      return (hits[0].object.userData.edgeIndex as number) ?? -1;
    };

    const recolour = () => {
      const sel = new Set(useCADStore.getState().selectedEdgeIndices);
      for (const [idx, line] of linesRef.current) {
        const mat = line.material as THREE.LineBasicMaterial;
        mat.color.setHex(idx === hoverRef.current ? COLOR_HOVER : sel.has(idx) ? COLOR_SELECTED : COLOR_EDGE);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'BLEND_EDGE') return;
      const idx = pickIndex(e);
      if (idx !== hoverRef.current) {
        hoverRef.current = idx;
        container.style.cursor = idx >= 0 ? 'pointer' : 'default';
        recolour();
      }
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useCADStore.getState().interactionMode !== 'BLEND_EDGE') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'BLEND_EDGE') return;
      // Drag (orbit) → ignore; only a near-stationary release is a pick
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const idx = pickIndex(e);
      if (idx >= 0) {
        e.stopPropagation();
        useCADStore.getState().toggleEdgeIndex(idx);
      }
    };

    // capture:true on down/up so object-selection handlers don't also fire
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [containerRef, cameraRef]);
}
