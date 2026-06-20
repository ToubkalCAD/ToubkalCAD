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
import { fromLocal2D, toLocal2D } from '../services/OccSketchService';
import { DATUM_UAXIS, DATUM_VAXIS, ORIGIN_REF } from '../services/SketchDatums';

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

  // The sketch that drag/pick operates on: the constraint panel's sketch in
  // CONSTRAIN mode, else the open sketch session in SELECT mode (free-drag while
  // editing a sketch). Null in every other context → drag/pick are inert.
  const activeSketchId = (): string | null => {
    const st = useCADStore.getState();
    if (st.interactionMode === 'CONSTRAIN') return st.constraintReq?.sketchId ?? null;
    if (st.interactionMode === 'SELECT')    return st.sketchSession?.id ?? null;
    return null;
  };
  const isDragMode = (): boolean => activeSketchId() !== null;

  const pickableIds = (): Set<string> => {
    const st = useCADStore.getState();
    const sketchId = activeSketchId();
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
    const sid = activeSketchId();
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

  // Draggable points. Line endpoints + circle/arc centres map to direct solver
  // coordinate variables. Arc ENDPOINTS map instead to the arc's parametric sweep
  // angles (a1/a2) — the drag engine handles them in "arc-angle" mode (mouse →
  // atan2 about the centre), so they are draggable even though they aren't raw
  // coordinate variables.
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
      } else if (g.kind === 'circle') {
        out.push({ ref: { kind: 'point', id, pt: 'c' }, world: fromLocal2D(g.c[0], g.c[1], wp) });
      } else if (g.kind === 'arc') {
        out.push({ ref: { kind: 'point', id, pt: 'c' }, world: fromLocal2D(g.c[0], g.c[1], wp) });
        out.push({ ref: { kind: 'point', id, pt: 'a' }, world: fromLocal2D(g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1), wp) });
        out.push({ ref: { kind: 'point', id, pt: 'b' }, world: fromLocal2D(g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2), wp) });
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

    // ── Live drag (soft constraint) ────────────────────────────────────────────
    // The pointer math (pick + plane projection) lives here; the solve/sync/seed
    // loop lives in the store's start/update/stopDragging actions (→ the injected
    // SketchDragController). This hook only feeds the store sketch-local cursor
    // coordinates each frame.
    const drag: {
      origin: SketchRef | null; grabLocal: [number, number] | null;
      active: boolean; raf: number; local: { x: number; y: number } | null; orbitWas?: boolean;
    } = { origin: null, grabLocal: null, active: false, raf: 0, local: null };

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

    // Nearest draggable control point within POINT_PX (line endpoint / centre).
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

    // What a press would grab: a control point (preferred) else an entity body —
    // so the user can grab anywhere on a line/circle/arc to drag the whole shape.
    const grabTarget = (e: MouseEvent): { origin: SketchRef; grabLocal: [number, number] } | null => {
      const local = mouseLocal(e);
      if (!local) return null;
      const pt = nearestDragPoint(e);
      if (pt) return { origin: pt, grabLocal: [local.x, local.y] };
      const camera = cameraRef.current, scene = sceneRef.current;
      const avail = pickableIds();
      if (camera && scene && avail.size) {
        const rect = container.getBoundingClientRect();
        ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const lines = scene.children.filter((c) => c instanceof THREE.Line && avail.has(c.userData?.cadNodeId));
        const hits = raycaster.intersectObjects(lines, false);
        if (hits.length) return { origin: { kind: 'entity', id: hits[0].object.userData.cadNodeId as string }, grabLocal: [local.x, local.y] };
      }
      return null;
    };

    const solveStep = () => {
      drag.raf = 0;
      if (!drag.active || !drag.local) return;
      useCADStore.getState().updateDragging([drag.local.x, drag.local.y]);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!isDragMode()) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
      const t = grabTarget(e);
      drag.origin = t?.origin ?? null; drag.grabLocal = t?.grabLocal ?? null;
      drag.active = false; drag.local = null;
      if (drag.origin) {
        // Suppress orbit/pan so the drag moves geometry, not the camera.
        const orbit = window.cadControls as { enabled: boolean } | null;
        if (orbit) { drag.orbitWas = orbit.enabled; orbit.enabled = false; }
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!downPos.active || !drag.origin) return;
      if (!isDragMode()) return;
      if (!drag.active && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) <= CLICK_SLOP_PX) return;
      if (!drag.active) {
        drag.active = true;
        useCADStore.getState().startDragging(drag.origin, drag.grabLocal ?? [0, 0]);
      }
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
      endDrag();
      drag.origin = null; drag.grabLocal = null; drag.active = false;

      if (wasDrag) {
        // Final frame at the release point, then release the pin + recompute once.
        const local = mouseLocal(e) ?? drag.local;
        if (local) useCADStore.getState().updateDragging([local.x, local.y]);
        useCADStore.getState().stopDragging();
        drag.local = null;
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
