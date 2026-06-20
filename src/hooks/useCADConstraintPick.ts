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
import type { SketchRef, SketchConstraint, Workplane } from '../store/cadStore';
import { fromLocal2D, toLocal2D } from '../services/OccSketchService';
import { getSolver } from '../services/solver';
import { DATUM_UAXIS, DATUM_VAXIS, ORIGIN_REF, datumGeoms, datumFixedConstraints, isDatumId } from '../services/SketchDatums';
import { collectSolverGeoms, rebuildSketchEntity, geomKey } from '../services/SketchSolveBridge';
import { propagateFromStore } from '../services/RecomputeEngine.live';

const COLOR_COMMIT = 0x003388;
const COLOR_PICK   = 0xff8800;
const STATUS_COLOR = { under: 0x0a6bd6, full: 0x16a06a, over: 0xcc3a3a, conflict: 0xd98a26 } as const;
const LINE_THRESHOLD = 0.6;
const POINT_PX = 10;
const AXIS_PX  = 7;    // screen proximity for picking a (background) datum axis
const CLICK_SLOP_PX = 5;

interface PointCand { ref: SketchRef; world: THREE.Vector3 }

/** Distance from point (px,py) to the segment (ax,ay)-(bx,by), in screen px. */
function ptToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function useCADConstraintPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
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

  // Workplane of the active sketch (datums live in it).
  const sketchWP = (): Workplane | null => {
    const st = useCADStore.getState();
    const sid = st.constraintReq?.sketchId;
    if (!sid) return null;
    for (const id of st.nodes[sid]?.children ?? []) {
      const wp = st.nodes[id]?.params?.workplane as Workplane | undefined;
      if (wp) return wp;
    }
    return st.activeWorkplane ?? null;
  };

  // The two infinite datum axes as screen-pickable segments (entity refs).
  const axisCands = (): { ref: SketchRef; a: THREE.Vector3; b: THREE.Vector3 }[] => {
    const wp = sketchWP();
    if (!wp) return [];
    return [
      { ref: { kind: 'entity', id: DATUM_UAXIS }, a: fromLocal2D(-1e4, 0, wp), b: fromLocal2D(1e4, 0, wp) },
      { ref: { kind: 'entity', id: DATUM_VAXIS }, a: fromLocal2D(0, -1e4, wp), b: fromLocal2D(0, 1e4, wp) },
    ];
  };

  // Candidate points (line endpoints, circle/arc centers/endpoints, origin).
  const pointCands = (): PointCand[] => {
    const st = useCADStore.getState();
    const out: PointCand[] = [];
    const wp = sketchWP();
    if (wp) out.push({ ref: ORIGIN_REF, world: fromLocal2D(0, 0, wp) });
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
      } else if (g.kind === 'arc') {
        // Centre + both endpoints — all three are solver-pickable (the endpoints are
        // derived from the arc's [cx,cy,r] + static sweep, so Coincident chains an
        // arc to neighbouring lines/arcs; the centre drives Concentric/Distance).
        out.push({ ref: { kind: 'point', id, pt: 'c' }, world: fromLocal2D(g.c[0], g.c[1], wp) });
        out.push({ ref: { kind: 'point', id, pt: 'a' }, world: fromLocal2D(g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1), wp) });
        out.push({ ref: { kind: 'point', id, pt: 'b' }, world: fromLocal2D(g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2), wp) });
      }
    }
    return out;
  };

  // Draggable points = those backed by a direct solver variable (line endpoints,
  // circle/arc centres). The origin is fixed and arc endpoints are derived, so
  // they are pickable for constraints but not directly draggable.
  const dragCands = (): PointCand[] => {
    const st = useCADStore.getState();
    const out: PointCand[] = [];
    for (const id of pickableIds()) {
      const g = st.nodes[id]?.params?.sketchGeom;
      const wp = st.nodes[id]?.params?.workplane as Workplane | undefined;
      if (!g || !wp) continue;
      if (g.kind === 'line') {
        out.push({ ref: { kind: 'point', id, pt: 'a' }, world: fromLocal2D(g.a[0], g.a[1], wp) });
        out.push({ ref: { kind: 'point', id, pt: 'b' }, world: fromLocal2D(g.b[0], g.b[1], wp) });
      } else if (g.kind === 'circle' || g.kind === 'arc') {
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

      // 2) A wire body (real entity).
      const avail = pickableIds();
      if (avail.size) {
        ndc.set((mx / rect.width) * 2 - 1, -(my / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const lines = scene.children.filter((c) => c instanceof THREE.Line && avail.has(c.userData?.cadNodeId));
        const hits = raycaster.intersectObjects(lines, false);
        if (hits.length) return { kind: 'entity', id: hits[0].object.userData.cadNodeId as string };
      }

      // 3) A datum axis (background reference — lowest priority).
      const toScreen = (p: THREE.Vector3) => {
        const v = p.clone().project(camera);
        return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height, behind: v.z > 1 };
      };
      let bestAxis: { ref: SketchRef; d: number } | null = null;
      for (const ax of axisCands()) {
        const sa = toScreen(ax.a), sb = toScreen(ax.b);
        if (sa.behind || sb.behind) continue;
        const d = ptToSegment(mx, my, sa.x, sa.y, sb.x, sb.y);
        if (d < AXIS_PX && (!bestAxis || d < bestAxis.d)) bestAxis = { ref: ax.ref, d };
      }
      return bestAxis?.ref ?? null;
    };

    // ── Live drag: drag a draggable point and re-solve every frame ─────────────
    const drag: {
      ref: SketchRef | null; active: boolean; raf: number;
      local: { x: number; y: number } | null; orbitWas?: boolean; changed: Set<string>;
    } = { ref: null, active: false, raf: 0, local: null, changed: new Set() };

    const nearestDragPoint = (e: MouseEvent): SketchRef | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let best: { ref: SketchRef; d: number } | null = null;
      for (const cand of dragCands()) {
        const v = cand.world.clone().project(camera);
        if (v.z > 1) continue;
        const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - mx, sy - my);
        if (d < POINT_PX && (!best || d < best.d)) best = { ref: cand.ref, d };
      }
      return best?.ref ?? null;
    };

    // Mouse → sketch-plane local 2D (u,v).
    const mouseLocal = (e: MouseEvent): { x: number; y: number } | null => {
      const camera = cameraRef.current; const wp = sketchWP();
      if (!camera || !wp) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const n = new THREE.Vector3(...wp.normal).normalize();
      const o = new THREE.Vector3(...wp.origin);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(new THREE.Plane(n, -n.dot(o)), hit)) return null;
      const loc = toLocal2D(hit, wp);
      return { x: loc.u, y: loc.v };
    };

    // Re-solve with the dragged point softly pinned to the cursor (the pin yields
    // to real constraints, so a constrained point only slides within its
    // manifold); rebuild every wire that moved.
    const liveSolve = (dragRef: SketchRef, local: { x: number; y: number }): string[] => {
      const st = useCADStore.getState();
      const sid = st.constraintReq?.sketchId;
      if (!sid) return [];
      const real = collectSolverGeoms(sid);
      if (!real.length) return [];
      const persisted: SketchConstraint[] = ((st.nodes[sid]?.params?.constraints as any[]) ?? []).map((c) =>
        c.refs ? c : { id: c.id, type: c.type, value: c.value, refs: (c.entityIds ?? []).map((id: string) => ({ kind: 'entity', id })) });
      const cons: SketchConstraint[] = [...persisted, ...datumFixedConstraints()];
      const beforeKey = new Map(real.map((g) => [g.id, geomKey(g)]));
      const res = getSolver().solve([...real, ...datumGeoms()], cons, { ref: dragRef, target: [local.x, local.y] });
      const changed: string[] = [];
      for (const g of Object.values(res.geoms)) {
        if (isDatumId(g.id)) continue;
        if (beforeKey.get(g.id) !== geomKey(g)) { rebuildSketchEntity(g.id, g); changed.push(g.id); }
      }
      return changed;
    };

    const solveStep = () => {
      drag.raf = 0;
      if (!drag.ref || !drag.local) return;
      for (const id of liveSolve(drag.ref, drag.local)) drag.changed.add(id);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useCADStore.getState().interactionMode !== 'CONSTRAIN') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
      drag.ref = nearestDragPoint(e); drag.active = false; drag.local = null; drag.changed.clear();
      if (drag.ref) {
        // Suppress orbit/pan so the drag moves geometry, not the camera.
        const orbit = window.cadControls as { enabled: boolean } | null;
        if (orbit) { drag.orbitWas = orbit.enabled; orbit.enabled = false; }
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!downPos.active || !drag.ref) return;
      if (useCADStore.getState().interactionMode !== 'CONSTRAIN') return;
      if (!drag.active && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) <= CLICK_SLOP_PX) return;
      drag.active = true;
      e.stopPropagation();
      const local = mouseLocal(e);
      if (!local) return;
      drag.local = local;
      if (!drag.raf) drag.raf = requestAnimationFrame(solveStep);
    };

    const endDrag = () => {
      const orbit = window.cadControls as { enabled: boolean } | null;
      if (orbit && drag.orbitWas !== undefined) orbit.enabled = drag.orbitWas;
      drag.orbitWas = undefined;
      if (drag.raf) { cancelAnimationFrame(drag.raf); drag.raf = 0; }
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const wasDrag = drag.active;
      const dragRef = drag.ref;
      endDrag();
      drag.ref = null; drag.active = false;

      if (wasDrag && dragRef) {
        // Final solve at the release point, then recompute dependents once.
        const local = mouseLocal(e) ?? drag.local;
        if (local) for (const id of liveSolve(dragRef, local)) drag.changed.add(id);
        drag.local = null;
        if (drag.changed.size) propagateFromStore([...drag.changed]);
        drag.changed.clear();
        downPos.active = false;
        e.stopPropagation();
        return;
      }
      drag.local = null;
      if (!downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'CONSTRAIN') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const ref = pick(e);
      if (ref) { e.stopPropagation(); useCADStore.getState().toggleConstraintRef(ref); }
    };

    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mousemove', onMove, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      endDrag();
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mousemove', onMove, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [containerRef, sceneRef, cameraRef]);
}
