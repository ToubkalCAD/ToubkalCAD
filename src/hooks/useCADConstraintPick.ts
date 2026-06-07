// ============================================================
// ToubkalCAD – useCADConstraintPick.ts
//
// Phase 8 – pick sketch entities AND points for constraints.
//
// Active only while interactionMode === 'CONSTRAIN'. A left click:
//   • near an entity's point (line endpoint / circle center) → that
//     point operand is toggled in constraintSel
//   • otherwise on a wire body → that entity operand is toggled
//
// Only children of the active sketch carrying `sketchGeom` are
// pickable. Wires are recoloured to reflect the sketch's constraint
// status (under=blue · full=green · over=red); picked entities turn
// orange. Picked points are drawn by SketchDimensions.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { SketchRef, Workplane } from '../store/cadStore';
import { fromLocal2D } from '../services/OccSketchService';

const COLOR_COMMIT = 0x003388;
const COLOR_PICK   = 0xff8800;
const STATUS_COLOR = { under: 0x0a6bd6, full: 0x16a06a, over: 0xcc3a3a } as const;
const LINE_THRESHOLD = 0.6;
const POINT_PX = 10;
const CLICK_SLOP_PX = 5;

interface PointCand { ref: SketchRef; world: THREE.Vector3 }

export function useCADConstraintPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const constraintReq = useCADStore((s) => s.constraintReq);
  const sel           = useCADStore((s) => s.constraintSel);
  const status        = useCADStore((s) => s.constraintStatus);
  const litRef        = useRef<Set<string>>(new Set());

  const pickableIds = (): Set<string> => {
    const st = useCADStore.getState();
    const sketchId = st.constraintReq?.sketchId;
    if (!sketchId) return new Set();
    const ids = new Set<string>();
    for (const id of st.nodes[sketchId]?.children ?? []) {
      const n = st.nodes[id];
      if (n?.type === 'sketch_wire' && n.params?.sketchGeom) ids.add(id);
    }
    return ids;
  };

  // Candidate points (line endpoints, circle centers) of all pickable entities.
  const pointCands = (): PointCand[] => {
    const st = useCADStore.getState();
    const out: PointCand[] = [];
    for (const id of pickableIds()) {
      const n = st.nodes[id];
      const g = n?.params?.sketchGeom;
      const wp = n?.params?.workplane as Workplane | undefined;
      if (!g || !wp) continue;
      if (g.kind === 'line') {
        out.push({ ref: { kind: 'point', id, pt: 'a' }, world: fromLocal2D(g.a[0], g.a[1], wp) });
        out.push({ ref: { kind: 'point', id, pt: 'b' }, world: fromLocal2D(g.b[0], g.b[1], wp) });
      } else if (g.kind === 'circle') {
        out.push({ ref: { kind: 'point', id, pt: 'c' }, world: fromLocal2D(g.c[0], g.c[1], wp) });
      }
    }
    return out;
  };

  // ─── Recolour wires by status + entity selection ─────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const restore = () => {
      for (const obj of scene.children) {
        if (obj instanceof THREE.Line && litRef.current.has(obj.userData?.cadNodeId)
            && obj.material instanceof THREE.LineBasicMaterial) {
          obj.material.color.setHex(COLOR_COMMIT);
        }
      }
      litRef.current.clear();
    };

    restore();
    if (!constraintReq) return;

    const avail = pickableIds();
    const pickedEntities = new Set(sel.filter((r) => r.kind === 'entity').map((r) => r.id));
    const baseHex = status ? STATUS_COLOR[status.state] : STATUS_COLOR.under;
    for (const obj of scene.children) {
      if (!(obj instanceof THREE.Line)) continue;
      const id = obj.userData?.cadNodeId as string | undefined;
      if (!id || !avail.has(id) || !(obj.material instanceof THREE.LineBasicMaterial)) continue;
      obj.material.color.setHex(pickedEntities.has(id) ? COLOR_PICK : baseHex);
      litRef.current.add(id);
    }
    return restore;
  }, [constraintReq, sel, status, sceneRef]);

  // ─── Click-to-pick (point preferred, else entity) ────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: LINE_THRESHOLD };
    const ndc     = new THREE.Vector2();
    const downPos = { x: 0, y: 0, active: false };

    const pick = (e: MouseEvent): SketchRef | null => {
      const camera = cameraRef.current;
      const scene  = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      // 1) Nearest candidate point within POINT_PX.
      let best: { ref: SketchRef; d: number } | null = null;
      for (const cand of pointCands()) {
        const v = cand.world.clone().project(camera);
        if (v.z > 1) continue;
        const sx = (v.x * 0.5 + 0.5) * rect.width;
        const sy = (-v.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - mx, sy - my);
        if (d < POINT_PX && (!best || d < best.d)) best = { ref: cand.ref, d };
      }
      if (best) return best.ref;

      // 2) Fall back to a wire body.
      const avail = pickableIds();
      if (!avail.size) return null;
      ndc.set((mx / rect.width) * 2 - 1, -(my / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const lines = scene.children.filter((c) => c instanceof THREE.Line && avail.has(c.userData?.cadNodeId));
      const hits = raycaster.intersectObjects(lines, false);
      return hits.length ? { kind: 'entity', id: hits[0].object.userData.cadNodeId as string } : null;
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useCADStore.getState().interactionMode !== 'CONSTRAIN') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'CONSTRAIN') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const ref = pick(e);
      if (ref) { e.stopPropagation(); useCADStore.getState().toggleConstraintRef(ref); }
    };

    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [containerRef, sceneRef, cameraRef]);
}
