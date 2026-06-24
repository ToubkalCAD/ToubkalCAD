// ============================================================
// ToubkalCAD – useCADSmartDimension.ts
//
// The "Smart Dimension" tool (interactionMode === 'DIMENSION'). Click sketch
// entities/points; the tool deduces intent (dimensionFactory.inferDimensionType):
//
//   1 line → length · 1 circle/arc → radius · 2 points → distance ·
//   point+line → perpendicular distance · 2 parallel lines → distance ·
//   2 intersecting lines → angle
//
// A temporary dimension preview follows the cursor; the next click on empty space
// PLACES it: the click point becomes the label offset, a driving SketchConstraint
// is created and solved (PlaneGCS, via applySketchConstraints), and a
// DimensionAnnotation is persisted so SketchDimensionLayer renders it.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { SketchRef, Workplane } from '../store/cadStore';
import { fromLocal2D, toLocal2D, workplaneBasis } from '../services/OccSketchService';
import { collectSolverGeoms } from '../services/SketchSolveBridge';
import { datumGeoms, ORIGIN_REF } from '../services/SketchDatums';
import { layoutDimension } from '../services/dimensionLayout';
import { buildDimensionConstraint, inferDimensionType, makeAnnotation, dimensionAnchor } from '../services/dimensionFactory';
import { applySketchConstraints } from '../services/SketchSolve';

const POINT_PX = 10;
const LINE_THRESHOLD = 0.6;
const PICK_COLOR = 0xff8800;
const PREVIEW_COLOR = 0x1d9e74;

interface PointCand { ref: SketchRef; world: THREE.Vector3 }

export function useCADSmartDimension(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const picksRef = useRef<SketchRef[]>([]);
  const litRef   = useRef<Set<string>>(new Set());

  useEffect(() => {
    const container = containerRef.current;
    if (!container || interactionMode !== 'DIMENSION') { picksRef.current = []; return; }

    const sketchId = () => useCADStore.getState().sketchSession?.id ?? useCADStore.getState().constraintReq?.sketchId ?? null;

    const sketchWP = (): Workplane | null => {
      const st = useCADStore.getState();
      const sid = sketchId();
      if (!sid) return null;
      for (const id of st.nodes[sid]?.children ?? []) {
        const wp = st.nodes[id]?.params?.workplane as Workplane | undefined;
        if (wp) return wp;
      }
      return st.activeWorkplane ?? null;
    };

    const pickableIds = (): Set<string> => {
      const st = useCADStore.getState();
      const sid = sketchId();
      const ids = new Set<string>();
      if (!sid) return ids;
      for (const id of st.nodes[sid]?.children ?? []) {
        const n = st.nodes[id];
        if (n?.type === 'sketch_wire' && n.params?.sketchGeom) ids.add(id);
      }
      return ids;
    };

    const pointCands = (): PointCand[] => {
      const st = useCADStore.getState();
      const out: PointCand[] = [];
      const wp = sketchWP();
      if (wp) out.push({ ref: ORIGIN_REF, world: fromLocal2D(0, 0, wp) });
      for (const id of pickableIds()) {
        const n = st.nodes[id];
        const g = n?.params?.sketchGeom;
        const w = n?.params?.workplane as Workplane | undefined;
        if (!g || !w) continue;
        if (g.kind === 'line') {
          out.push({ ref: { kind: 'point', id, pt: 'a' }, world: fromLocal2D(g.a[0], g.a[1], w) });
          out.push({ ref: { kind: 'point', id, pt: 'b' }, world: fromLocal2D(g.b[0], g.b[1], w) });
        } else if (g.kind === 'circle') {
          out.push({ ref: { kind: 'point', id, pt: 'c' }, world: fromLocal2D(g.c[0], g.c[1], w) });
        } else if (g.kind === 'arc') {
          out.push({ ref: { kind: 'point', id, pt: 'c' }, world: fromLocal2D(g.c[0], g.c[1], w) });
          out.push({ ref: { kind: 'point', id, pt: 'a' }, world: fromLocal2D(g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1), w) });
          out.push({ ref: { kind: 'point', id, pt: 'b' }, world: fromLocal2D(g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2), w) });
        }
      }
      return out;
    };

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: LINE_THRESHOLD };
    const ndc = new THREE.Vector2();

    // Preview line group, rebuilt while a placement is pending.
    let preview: THREE.LineSegments | null = null;
    const clearPreview = () => { if (preview) { preview.removeFromParent(); preview.geometry.dispose(); (preview.material as THREE.Material).dispose(); preview = null; } };

    const mouseLocal = (e: MouseEvent): { u: number; v: number } | null => {
      const camera = cameraRef.current, wp = sketchWP();
      if (!camera || !wp) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const { origin, normal } = workplaneBasis(wp);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(plane, hit) ? toLocal2D(hit, wp) : null;
    };

    const pick = (e: MouseEvent): SketchRef | null => {
      const camera = cameraRef.current, scene = sceneRef.current;
      if (!camera || !scene) return null;
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      let best: { ref: SketchRef; d: number } | null = null;
      for (const cand of pointCands()) {
        const v = cand.world.clone().project(camera);
        if (v.z > 1) continue;
        const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
        const d = Math.hypot(sx - mx, sy - my);
        if (d < POINT_PX && (!best || d < best.d)) best = { ref: cand.ref, d };
      }
      if (best) return best.ref;

      const avail = pickableIds();
      if (avail.size) {
        ndc.set((mx / rect.width) * 2 - 1, -(my / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const lines = scene.children.filter((c) => c instanceof THREE.Line && avail.has(c.userData?.cadNodeId));
        const hits = raycaster.intersectObjects(lines, false);
        if (hits.length) return { kind: 'entity', id: hits[0].object.userData.cadNodeId as string };
      }
      return null;
    };

    // Recolour the currently-picked wires so the user sees what's selected.
    const recolour = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      for (const obj of scene.children) {
        if (obj instanceof THREE.Line && litRef.current.has(obj.userData?.cadNodeId) && obj.material instanceof THREE.LineBasicMaterial)
          obj.material.color.setHex(0x003388);
      }
      litRef.current.clear();
      const ids = new Set(picksRef.current.filter((r) => r.kind === 'entity').map((r) => r.id));
      for (const obj of scene.children) {
        if (!(obj instanceof THREE.Line)) continue;
        const id = obj.userData?.cadNodeId as string | undefined;
        if (id && ids.has(id) && obj.material instanceof THREE.LineBasicMaterial) { obj.material.color.setHex(PICK_COLOR); litRef.current.add(id); }
      }
      window.cadRequestRender?.();
    };

    const reset = () => { picksRef.current = []; clearPreview(); recolour(); };

    const place = (e: MouseEvent) => {
      const sid = sketchId(); const wp = sketchWP();
      const local = mouseLocal(e);
      if (!sid || !wp || !local) { reset(); return; }
      const geoms = [...collectSolverGeoms(sid), ...datumGeoms()];
      // Pass the cursor (local 2D) so a point↔point pick resolves to ΔX / ΔY / aligned.
      const built = buildDimensionConstraint(picksRef.current, geoms, { x: local.u, y: local.v });
      if (!built) { reset(); return; }
      const anchor = dimensionAnchor(built.type, built.constraint.refs, geoms);
      const offset = anchor ? { u: local.u - anchor.x, v: local.v - anchor.y } : { u: 0, v: 0 };

      const existing = (useCADStore.getState().nodes[sid]?.params?.constraints as any[]) ?? [];
      const next = [...existing.map((c) => (c.refs ? c : { id: c.id, type: c.type, value: c.value, refs: (c.entityIds ?? []).map((id: string) => ({ kind: 'entity', id })) })), built.constraint];
      const res = applySketchConstraints(sid, next);
      useCADStore.getState().upsertDimension(sid, makeAnnotation(built.constraint, offset));
      useCADStore.getState().log(`Dimension ${built.type} added — ${res.message}`, res.ok ? 'info' : 'warn');
      reset();
    };

    // Distinguish a genuine click from an orbit-rotate drag (which also fires 'click').
    const downAt = { x: 0, y: 0 };
    const onDown = (e: MouseEvent) => { downAt.x = e.clientX; downAt.y = e.clientY; };

    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest('[data-sketch-overlay], .cad-dim-label')) return;
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;   // was a drag, not a click
      const sid = sketchId();
      if (!sid) return;
      const geoms = [...collectSolverGeoms(sid), ...datumGeoms()];
      const hit = pick(e);

      if (hit) {
        const cur = picksRef.current;
        const already = cur.findIndex((r) => r.kind === hit.kind && r.id === hit.id && r.pt === hit.pt);
        if (already >= 0) { cur.splice(already, 1); recolour(); return; }   // toggle off
        if (cur.length === 0) { picksRef.current = [hit]; recolour(); return; }
        if (cur.length === 1) {
          // accept the 2nd pick only if it forms a valid two-operand dimension
          picksRef.current = inferDimensionType([cur[0], hit], geoms) ? [cur[0], hit] : [hit];
          recolour();
          return;
        }
        return;   // already have two operands — next empty click places
      }

      // empty click → placement (if the current selection is dimensionable)
      if (inferDimensionType(picksRef.current, geoms)) place(e);
      else reset();
    };

    const onMove = (e: MouseEvent) => {
      const sid = sketchId(); const wp = sketchWP();
      if (!sid || !wp || !picksRef.current.length) { clearPreview(); return; }
      const geoms = [...collectSolverGeoms(sid), ...datumGeoms()];
      const local = mouseLocal(e);
      if (!local) { clearPreview(); return; }
      // Build WITH the cursor so the preview reflects the live directional mode.
      const built = buildDimensionConstraint(picksRef.current, geoms, { x: local.u, y: local.v });
      if (!built) { clearPreview(); return; }
      const anchor = dimensionAnchor(built.type, built.constraint.refs, geoms);
      const offset = anchor ? { u: local.u - anchor.x, v: local.v - anchor.y } : { u: 0, v: 0 };
      const layout = layoutDimension(built.type, built.constraint.refs, offset, geoms, 1, built.constraint.value);
      if (!layout) { clearPreview(); return; }

      const segs = [...layout.witness, ...layout.dim, ...layout.arrows];
      const pos = new Float32Array(segs.length * 6);
      for (let i = 0; i < segs.length; i++) {
        const w0 = fromLocal2D(segs[i][0].x, segs[i][0].y, wp), w1 = fromLocal2D(segs[i][1].x, segs[i][1].y, wp);
        pos.set([w0.x, w0.y, w0.z, w1.x, w1.y, w1.z], i * 6);
      }
      const scene = sceneRef.current;
      if (!scene) return;
      if (!preview) {
        preview = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: PREVIEW_COLOR, depthTest: false, transparent: true, opacity: 0.7 }));
        preview.renderOrder = 998; preview.frustumCulled = false;
        scene.add(preview);
      }
      preview.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      preview.geometry.computeBoundingSphere();
      window.cadRequestRender?.();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (picksRef.current.length) { e.stopPropagation(); reset(); } }
    };

    container.addEventListener('mousedown', onDown);
    container.addEventListener('click', onClick);
    container.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey, true);
    return () => {
      container.removeEventListener('mousedown', onDown);
      container.removeEventListener('click', onClick);
      container.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey, true);
      reset();
    };
  }, [interactionMode, containerRef, sceneRef, cameraRef]);
}
