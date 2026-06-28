// ============================================================
// ToubkalCAD – useCADSurfaceBlendEdge.ts
//
// Phase 2 (Surface Modeling) – explicit edge picking for Surface Blend.
//
// Active only while interactionMode === 'SURFACE_BLEND_EDGE' (driven by the store's
// surfaceBlendReq). Renders one THREE.Line per edge of BOTH bridged bodies, tinted by
// body (A vs B), and lets the user pick exactly ONE boundary edge on each — those
// ordinals feed OccSurfaceService.blend(.., ordA, ordB). The ordinal is the same
// de-duplicated TopExp/IndexedMap index OccEdgeService.extractEdges exposes, so a pick
// resolves to the same edge on recompute.
//
// Modeled on useCADEdgeSelect (single-body fillet picker); the difference is two
// bodies + single-pick-per-body (radio) instead of multi-toggle on one body.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { OccEdgeService } from '../services/OccEdgeService';
import { getPlacedShape } from '../utils/placedShape';

const COLOR_A        = 0x66ccff; // body A edges (idle)
const COLOR_B        = 0xff9bd0; // body B edges (idle)
const COLOR_HOVER    = 0xffe000;
const COLOR_PICKED   = 0xff8800;
const LINE_THRESHOLD = 0.6;
const CLICK_SLOP_PX  = 5;

type Key = 'a' | 'b';

export function useCADSurfaceBlendEdge(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const surfaceBlendReq  = useCADStore((s) => s.surfaceBlendReq);
  const surfaceBlendPick = useCADStore((s) => s.surfaceBlendPick);

  // Each line carries { bodyKey, edgeIndex }. hoverRef tracks the hovered line.
  const linesRef = useRef<THREE.Line[]>([]);
  const hoverRef = useRef<THREE.Line | null>(null);

  // ─── Build / tear down edge lines when the request changes ──────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const line of linesRef.current) {
        scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      linesRef.current = [];
      hoverRef.current = null;
    };
    dispose();

    if (!surfaceBlendReq || !window.oc) return;
    const bodies: { key: Key; id: string; color: number }[] = [
      { key: 'a', id: surfaceBlendReq.aId, color: COLOR_A },
      { key: 'b', id: surfaceBlendReq.bId, color: COLOR_B },
    ];
    try {
      for (const body of bodies) {
        const shape = getPlacedShape(body.id);
        if (!shape) continue;
        for (const e of OccEdgeService.extractEdges(window.oc, shape)) {
          const geo = new THREE.BufferGeometry().setFromPoints(
            e.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
          const mat = new THREE.LineBasicMaterial({ color: body.color, depthTest: false, transparent: true, opacity: 0.95 });
          const line = new THREE.Line(geo, mat);
          line.renderOrder = 999;
          line.userData = { isSurfaceBlendEdge: true, bodyKey: body.key, edgeIndex: e.index, baseColor: body.color };
          scene.add(line);
          linesRef.current.push(line);
        }
      }
      useCADStore.getState().log('Blend: click one boundary edge on each surface (A=blue, B=pink), then Apply.', 'info');
    } catch (err: any) {
      useCADStore.getState().log(`Blend edge extraction failed: ${err?.message ?? err}`, 'error');
    }
    return dispose;
  }, [surfaceBlendReq, sceneRef]);

  // ─── Recolour from the current picks ────────────────────────────────────────
  useEffect(() => {
    for (const line of linesRef.current) {
      const { bodyKey, edgeIndex, baseColor } = line.userData as { bodyKey: Key; edgeIndex: number; baseColor: number };
      const picked = surfaceBlendPick[bodyKey] === edgeIndex;
      const mat = line.material as THREE.LineBasicMaterial;
      mat.color.setHex(line === hoverRef.current ? COLOR_HOVER : picked ? COLOR_PICKED : baseColor);
    }
  }, [surfaceBlendPick]);

  // ─── Hover + click-to-pick (one edge per body) ──────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const pick = (e: MouseEvent): THREE.Line | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: LINE_THRESHOLD };
      const hits = raycaster.intersectObjects(linesRef.current, false);
      return hits.length ? (hits[0].object as THREE.Line) : null;
    };

    const recolour = () => {
      const picks = useCADStore.getState().surfaceBlendPick;
      for (const line of linesRef.current) {
        const { bodyKey, edgeIndex, baseColor } = line.userData as { bodyKey: Key; edgeIndex: number; baseColor: number };
        const mat = line.material as THREE.LineBasicMaterial;
        mat.color.setHex(line === hoverRef.current ? COLOR_HOVER : picks[bodyKey] === edgeIndex ? COLOR_PICKED : baseColor);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'SURFACE_BLEND_EDGE') return;
      const line = pick(e);
      if (line !== hoverRef.current) {
        hoverRef.current = line;
        container.style.cursor = line ? 'pointer' : 'default';
        recolour();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || useCADStore.getState().interactionMode !== 'SURFACE_BLEND_EDGE') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'SURFACE_BLEND_EDGE') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const line = pick(e);
      if (line) {
        e.stopPropagation();
        const { bodyKey, edgeIndex } = line.userData as { bodyKey: Key; edgeIndex: number };
        const cur = useCADStore.getState().surfaceBlendPick[bodyKey];
        useCADStore.getState().setSurfaceBlendPick(bodyKey, cur === edgeIndex ? null : edgeIndex); // toggle off if re-clicked
      }
    };

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
