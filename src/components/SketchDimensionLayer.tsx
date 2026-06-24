// ============================================================
// ToubkalCAD – SketchDimensionLayer.tsx
//
// The imperative manager that keeps a THREE DimensionRenderer in sync with each
// dimension annotation on the active sketch. It is the bridge between the store
// (declarative annotation records + driving constraints) and the retained-mode
// scene:
//
//   • builds/updates/disposes one DimensionRenderer per annotation,
//   • re-lays-out every dimension from LIVE solved geometry on each store change
//     (so dragging a line moves its dimension line, arrows and value in real time),
//   • routes label double-click edits back through applySketchConstraints (→ PlaneGCS
//     → store → re-layout), so the sidebar value and the canvas value stay in lock-step,
//   • lets the user grab-and-drag a dimension to reposition it — by its CSS2D text
//     (DOM pointer events) OR by raycasting the dimension LINE itself; a small
//     hover→grab→grabbing state machine drives the cursor and re-projects the pointer
//     onto the sketch plane to persist the new offset,
//   • cross-highlights with the constraint panel via store.hoveredConstraintId,
//   • honours the global show/hide declutter toggle.
//
// Text is rendered with CSS2DRenderer (set up in Viewport3D); this component only
// adds CSS2DObjects to the scene — CSS2DRenderer reprojects them every frame.
// ============================================================

import { useEffect } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { DimensionAnnotation, SketchConstraint, Workplane } from '../store/cadStore';
import { fromLocal2D, toLocal2D, workplaneBasis } from '../services/OccSketchService';
import { collectSolverGeoms } from '../services/SketchSolveBridge';
import { datumGeoms } from '../services/SketchDatums';
import { layoutDimension, dimensionAnchor } from '../services/dimensionLayout';
import { defaultDimensionOffset, makeAnnotation } from '../services/dimensionFactory';
import { DimensionRenderer } from '../services/DimensionRenderer';
import { applySketchConstraints } from '../services/SketchSolve';

const DIM_TYPES = new Set(['LENGTH', 'RADIUS', 'DISTANCE', 'ANGLE', 'DISTANCE_X', 'DISTANCE_Y']);

/** World units per screen pixel at the workplane (for screen-constant arrowheads). */
function worldPerPixel(cam: THREE.Camera, wp: Workplane, viewportH: number): number {
  if ((cam as any).isOrthographicCamera) {
    const oc = cam as THREE.OrthographicCamera;
    return (oc.top - oc.bottom) / oc.zoom / (viewportH || 1);
  }
  const pc = cam as THREE.PerspectiveCamera;
  const o = new THREE.Vector3(...wp.origin);
  return (2 * pc.position.distanceTo(o) * Math.tan((pc.fov * Math.PI / 180) / 2)) / (viewportH || 1);
}

export const SketchDimensionLayer: React.FC<{ containerRef: React.RefObject<HTMLDivElement | null> }> = ({ containerRef }) => {
  useEffect(() => {
    const renderers = new Map<string, DimensionRenderer>();
    const raycaster = new THREE.Raycaster();
    let scene: THREE.Scene | null = null;

    const constraintsOf = (sketchId: string): SketchConstraint[] => {
      const raw = (useCADStore.getState().nodes[sketchId]?.params?.constraints as any[]) ?? [];
      return raw.map((c) => (c.refs ? c : { id: c.id, type: c.type, value: c.value, refs: (c.entityIds ?? []).map((id: string) => ({ kind: 'entity', id })) }));
    };

    const sketchWorkplane = (sketchId: string): Workplane | null => {
      const nodes = useCADStore.getState().nodes;
      for (const id of nodes[sketchId]?.children ?? []) {
        const wp = nodes[id]?.params?.workplane as Workplane | undefined;
        if (wp) return wp;
      }
      return useCADStore.getState().activeWorkplane ?? null;
    };

    const activeSketchId = (): string | null => {
      const st = useCADStore.getState();
      return st.sketchSession?.id ?? st.constraintReq?.sketchId ?? null;
    };

    const disposeAll = () => { for (const r of renderers.values()) r.dispose(); renderers.clear(); };

    // Commit an inline-edited value → drive PlaneGCS through the shared solve path.
    const commitValue = (sketchId: string, constraintId: string, value: number) => {
      const next = constraintsOf(sketchId).map((c) => (c.id === constraintId ? { ...c, value } : c));
      applySketchConstraints(sketchId, next);
      window.cadRequestRender?.();
    };

    const annotationFor = (sketchId: string, constraintId: string): DimensionAnnotation | undefined => {
      const dims = (useCADStore.getState().nodes[sketchId]?.params?.dimensions as DimensionAnnotation[] | undefined) ?? [];
      return dims.find((d) => d.constraintId === constraintId);
    };

    // Drag a dimension's label: raycast the pointer onto the sketch plane → local-2D
    // → persist the offset from the dimension's natural anchor (creating the
    // annotation on first drag if the dimension only had a default placement).
    const dragTo = (sketchId: string, con: SketchConstraint, clientX: number, clientY: number) => {
      const cam = window.cadCamera as THREE.Camera | null;
      const container = containerRef.current;
      const wp = sketchWorkplane(sketchId);
      if (!cam || !container || !wp) return;
      const rect = container.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, cam);
      const { origin, normal } = workplaneBasis(wp);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, hit)) return;
      const local = toLocal2D(hit, wp);
      const geoms = [...collectSolverGeoms(sketchId), ...datumGeoms()];
      const anchor = dimensionAnchor(con.type as DimensionAnnotation['type'], con.refs, geoms);
      if (!anchor) return;
      const offset = { u: local.u - anchor.x, v: local.v - anchor.y };
      const existing = annotationFor(sketchId, con.id);
      if (existing) useCADStore.getState().setDimensionOffset(sketchId, existing.id, offset);
      else useCADStore.getState().upsertDimension(sketchId, makeAnnotation(con, offset));
      window.cadRequestRender?.();
    };

    const sync = () => {
      scene = (window.cadScene as THREE.Scene | null) ?? scene;
      const st = useCADStore.getState();
      const sketchId = activeSketchId();
      const cam = window.cadCamera as THREE.Camera | null;

      // No active sketch (or scene not ready) → tear everything down.
      if (!sketchId || !scene || !cam) { disposeAll(); return; }

      const wp = sketchWorkplane(sketchId);
      if (!wp) { disposeAll(); return; }

      // Source of truth = the sketch's DIMENSIONAL constraints. Annotations only
      // supply the persisted offset/hide; a constraint with no annotation yet falls
      // back to a default standoff (and gains one the first time it's dragged).
      const dimCons = constraintsOf(sketchId).filter((c) => DIM_TYPES.has(c.type));
      const annByCon = new Map(((st.nodes[sketchId]?.params?.dimensions as DimensionAnnotation[] | undefined) ?? []).map((d) => [d.constraintId, d]));
      const geoms = [...collectSolverGeoms(sketchId), ...datumGeoms()];
      const h = containerRef.current?.clientHeight ?? 0;
      const scale = worldPerPixel(cam, wp, h);
      const toWorld = (p: { x: number; y: number }) => fromLocal2D(p.x, p.y, wp);

      const live = new Set<string>();
      for (const con of dimCons) {
        const type = con.type as DimensionAnnotation['type'];
        const ann = annByCon.get(con.id);
        const offset = ann?.offset ?? defaultDimensionOffset(type, con.refs, geoms, 30 * scale);
        const layout = layoutDimension(type, con.refs, offset, geoms, scale, con.value);
        if (!layout) continue;                       // geometry not resolvable yet

        let r = renderers.get(con.id);
        if (!r) {
          r = new DimensionRenderer({
            onEditCommit: (v) => commitValue(sketchId, con.id, v),
            onHoverChange: (hovering) => useCADStore.getState().setHoveredConstraint(hovering ? con.id : null),
            onDrag: (cx, cy) => dragTo(sketchId, con, cx, cy),
          });
          scene.add(r.group);
          renderers.set(con.id, r);
        }
        r.update(layout, toWorld, type === 'ANGLE');
        r.setHighlight(st.hoveredConstraintId === con.id);
        r.setVisible(st.dimensionsVisible && !ann?.hidden);
        live.add(con.id);
      }

      // Drop renderers whose constraint is gone.
      for (const [id, r] of renderers) if (!live.has(id)) { r.dispose(); renderers.delete(id); }
      window.cadRequestRender?.();
    };

    // ─── Interactive grab-and-drag of the dimension LINE (raycast) ───────────────
    // The CSS2D text drags via its own DOM pointer events (DimensionRenderer); this
    // adds the SAME drag by grabbing the dimension line itself, which — being a
    // THREE.LineSegments — is hit-testable with a raycaster. A small state machine:
    //   idle → (hover a line) grab cursor → (pointerdown) grabbing + capture →
    //   (pointermove) live re-offset via dragTo → (pointerup) release.
    let dragId: string | null = null;     // constraint id being dragged (null = idle)
    let hoverId: string | null = null;    // constraint id under the cursor (for grab cursor + highlight)

    const setCursor = (c: string) => { const el = containerRef.current; if (el) el.style.cursor = c; };
    // Don't intercept the pointer while a sketch tool is actively drawing.
    const gateOK = () => !useCADStore.getState().interactionMode.startsWith('SKETCH_');

    /** Raycast the dimension lines under (clientX,clientY) → constraint id, or null. */
    const hitDimension = (clientX: number, clientY: number): string | null => {
      const cam = window.cadCamera as THREE.Camera | null;
      const container = containerRef.current;
      const sketchId = activeSketchId();
      if (!cam || !container || !sketchId || !scene || !useCADStore.getState().dimensionsVisible) return null;
      const wp = sketchWorkplane(sketchId);
      const rect = container.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, cam);
      // Thin lines need a screen-constant pick tolerance (≈6px) in world units.
      raycaster.params.Line = { threshold: (wp ? worldPerPixel(cam, wp, container.clientHeight) : 1) * 6 };
      const targets: THREE.Object3D[] = [];
      for (const [id, r] of renderers) if (r.group.visible) targets.push(r.pickTarget(id));
      const hits = raycaster.intersectObjects(targets, false);
      return hits.length ? (hits[0].object.userData.dimConstraintId as string) : null;
    };

    const onHoverMove = (e: PointerEvent) => {
      if (dragId || e.buttons || !gateOK()) return;   // dragging / orbiting / drawing → no hover
      const id = hitDimension(e.clientX, e.clientY);
      if (id === hoverId) return;
      hoverId = id;
      useCADStore.getState().setHoveredConstraint(id);   // cross-highlight the panel row too
      setCursor(id ? 'grab' : '');
      window.cadRequestRender?.();
    };

    // Capture phase so we run BEFORE OrbitControls (on the canvas) and the tool hooks:
    // if we grab a dimension we stop propagation; otherwise the event falls through.
    const onDownCapture = (e: PointerEvent) => {
      if (e.button !== 0 || !gateOK()) return;
      const id = hitDimension(e.clientX, e.clientY);
      if (!id) return;
      e.stopPropagation();
      e.preventDefault();
      dragId = id;
      setCursor('grabbing');
      if (window.cadControls) window.cadControls.enabled = false;   // belt-and-suspenders vs. orbit
      window.addEventListener('pointermove', onDragMove, true);
      window.addEventListener('pointerup', onDragUp, true);
    };

    const onDragMove = (e: PointerEvent) => {
      if (!dragId) return;
      const sketchId = activeSketchId();
      if (!sketchId) return;
      const con = constraintsOf(sketchId).find((c) => c.id === dragId);
      if (con) dragTo(sketchId, con, e.clientX, e.clientY);   // re-projects onto the plane + persists offset
    };

    const onDragUp = (e: PointerEvent) => {
      if (!dragId) return;
      dragId = null;
      if (window.cadControls) window.cadControls.enabled = true;
      window.removeEventListener('pointermove', onDragMove, true);
      window.removeEventListener('pointerup', onDragUp, true);
      const id = hitDimension(e.clientX, e.clientY);          // settle the cursor on release
      hoverId = id;
      useCADStore.getState().setHoveredConstraint(id);
      setCursor(id ? 'grab' : '');
    };

    const onLeave = () => { if (!dragId) { hoverId = null; setCursor(''); useCADStore.getState().setHoveredConstraint(null); } };

    const container = containerRef.current;
    container?.addEventListener('pointermove', onHoverMove);
    container?.addEventListener('pointerdown', onDownCapture, true);
    container?.addEventListener('pointerleave', onLeave);

    sync();
    const unsub = useCADStore.subscribe(sync);
    // Scene/camera may not exist on first mount — retry briefly until Viewport3D wires them.
    const retry = window.setInterval(() => { if (window.cadScene && window.cadCamera) { sync(); window.clearInterval(retry); } }, 120);
    window.setTimeout(() => window.clearInterval(retry), 4000);

    return () => {
      unsub(); window.clearInterval(retry); disposeAll();
      container?.removeEventListener('pointermove', onHoverMove);
      container?.removeEventListener('pointerdown', onDownCapture, true);
      container?.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointermove', onDragMove, true);
      window.removeEventListener('pointerup', onDragUp, true);
      if (window.cadControls) window.cadControls.enabled = true;
    };
  }, [containerRef]);

  return null;
};
