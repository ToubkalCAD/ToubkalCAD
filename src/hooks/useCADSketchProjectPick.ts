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
import { OccEdgeService, EdgeCurve } from '../services/OccEdgeService';
import { toLocal2D, workplaneBasis } from '../services/OccSketchService';
import type { Workplane } from '../store/cadStore';
import { createSketchEntityNode } from '../utils/sketchEntity';
import { getPlacedShape } from '../utils/placedShape';

const EDGE_IDLE  = 0x66ccff;
const EDGE_HOVER = 0xffe000;
const CLICK_SLOP_PX = 5;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

/** Are the 2D points (within tolerance) collinear → representable as a single line?
 *  A straight projected edge becomes a real LINE the solver can freeze/dimension;
 *  a curved one stays a polyline (visual reference only). */
function collinear2D(pts: [number, number][]): boolean {
  if (pts.length <= 2) return true;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  const ux = dx / len, uy = dy / len;
  let maxPerp = 0;
  for (const [px, py] of pts) {
    const perp = Math.abs((px - ax) * uy - (py - ay) * ux);
    if (perp > maxPerp) maxPerp = perp;
  }
  return maxPerp <= Math.max(1e-3, len * 0.01);   // within ~1% of the chord
}

/** Is the edge's circle plane parallel (or anti-parallel) to the sketch plane?
 *  Only then does an orthographic projection stay a true circle/arc of the same
 *  radius — a tilted circle projects to an ellipse (→ polyline fallback). */
function circleParallel(curveNormal: [number, number, number], wp: Workplane): boolean {
  const a = new THREE.Vector3(...curveNormal).normalize();
  const b = new THREE.Vector3(...wp.normal).normalize();
  return Math.abs(a.dot(b)) > 0.999;
}

/** Angle of (p − c) in the sketch's (u,v) basis — matches sampleEntity's cos→u,sin→v. */
const angleOf = (p: [number, number], c: [number, number]) => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** Order an arc's end angle so a linear a1→a2 sweep passes through the sampled
 *  midpoint angle (handles both CW and CCW edges regardless of plane orientation). */
function arcEndAngle(a1: number, aMid: number, a2: number): number {
  const TAU = Math.PI * 2;
  const norm = (x: number) => { let y = x; while (y < a1) y += TAU; while (y >= a1 + TAU) y -= TAU; return y; };
  const aMidN = norm(aMid), a2N = norm(a2);
  return aMidN <= a2N ? a2N : a2N - TAU;   // CCW if mid precedes end, else sweep the other way
}

/** Orthographic image of a circle onto the sketch plane. A circle parallel to the
 *  plane stays a circle (handled elsewhere); a TILTED one images to an ellipse.
 *  Returns its 2D {center, rx, ry, rot} via the conjugate-semi-diameter form, or
 *  null when it degenerates (edge-on → a line segment). */
function projectedEllipse(
  curve: Extract<EdgeCurve, { type: 'circle' }>, wp: Workplane,
): { c: [number, number]; rx: number; ry: number; rot: number } | null {
  const n = new THREE.Vector3(...curve.normal).normalize();
  const { uAxis, vAxis } = workplaneBasis(wp);
  // Any orthonormal basis (e1,e2) of the circle's plane parameterises the same circle.
  const helper = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const e1 = new THREE.Vector3().crossVectors(helper, n).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();
  const r = curve.radius;
  // 2D images of the two semi-diameters r·e1, r·e2 (columns of the 2×2 map M).
  const a = r * e1.dot(uAxis), c = r * e1.dot(vAxis);
  const b = r * e2.dot(uAxis), d = r * e2.dot(vAxis);
  // Ellipse axes/orientation = singular values + LEFT singular vectors of M, i.e.
  // eigen-decomposition of M·Mᵀ (row-based) — the orientation in OUTPUT (u,v) space.
  // (Mᵀ·M would give the same radii but the angle in parameter space — wrong axis.)
  const A = a * a + b * b, B = c * c + d * d, C = a * c + b * d;
  const disc = Math.hypot(A - B, 2 * C);              // √((A−B)² + 4C²)
  const rx = Math.sqrt(Math.max((A + B + disc) / 2, 0));
  const ry = Math.sqrt(Math.max((A + B - disc) / 2, 0));
  if (ry < 1e-3) return null;                         // edge-on → not an ellipse
  const rot = 0.5 * Math.atan2(2 * C, A - B);         // major-axis angle in the (u,v) plane
  const cc = toLocal2D(new THREE.Vector3(...curve.center), wp);
  return { c: [cc.u, cc.v], rx, ry, rot };
}

/** Turn a picked edge into the best 2D sketch geometry for a REFERENCE projection:
 *  a clean circle/arc when the edge is circular and coplanar-parallel; an ellipse
 *  when a full circle is tilted; a line when collinear; otherwise a sampled polyline.
 *  The polyline carries the sampled points (correct dashed visual) plus an analytic
 *  `ellipse` descriptor so buildEntityWire rebuilds it as one clean gp_Elips edge. */
function referenceGeom(curve: EdgeCurve | undefined, pts2d: [number, number][], wp: Workplane): any {
  if (curve?.type === 'circle') {
    if (circleParallel(curve.normal, wp)) {
      const c2 = toLocal2D(new THREE.Vector3(...curve.center), wp);
      const cc: [number, number] = [c2.u, c2.v];
      if (curve.closed) return { kind: 'circle', c: cc, r: curve.radius };
      const a1   = angleOf(pts2d[0], cc);
      const aMid = angleOf(pts2d[Math.floor(pts2d.length / 2)], cc);
      const a2   = arcEndAngle(a1, aMid, angleOf(pts2d[pts2d.length - 1], cc));
      return { kind: 'arc', c: cc, r: curve.radius, a1, a2 };
    }
    // Tilted full circle → ellipse. (A tilted ARC stays polyline — arc-of-ellipse
    // parameter mapping is out of scope.)
    if (curve.closed) {
      const ell = projectedEllipse(curve, wp);
      if (ell) return { kind: 'polyline', pts: pts2d, ellipse: ell };
    }
  }
  if (collinear2D(pts2d)) return { kind: 'line', a: pts2d[0], b: pts2d[pts2d.length - 1] };
  return { kind: 'polyline', pts: pts2d };
}

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
          line.userData = { points: e.points, curve: e.curve };
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

    const project = (ud: { points: [number, number, number][]; curve?: EdgeCurve }) => {
      const st = useCADStore.getState();
      const session = st.sketchSession;
      if (!session) return;
      const wp = session.plane;
      const pts = ud.points.map((p) => { const l = toLocal2D(new THREE.Vector3(p[0], p[1], p[2]), wp); return [l.u, l.v] as [number, number]; });
      if (pts.length < 2) return;

      if (st.projectAsConstruction) {
        // Reference / construction projection (the professional default): a circular
        // edge coplanar-parallel to the sketch becomes a real CIRCLE/ARC, a straight
        // edge a LINE — both solver-freezable + dimensionable; anything else (tilted
        // circle, spline) stays a polyline visual reference. Either way it's excluded
        // from profile/region detection so it never becomes part of an extrude/loft.
        const geom = referenceGeom(ud.curve, pts, wp);
        const label = geom.kind === 'polyline' ? (geom.ellipse ? 'ellipse' : 'curve') : geom.kind;
        createSketchEntityNode(geom, wp, session.id, { construction: true });
        st.log(`Edge projected as reference ${label}.`, 'success');
      } else {
        // Plain projection: a normal profile polyline (participates in regions/extrude).
        createSketchEntityNode({ kind: 'polyline', pts }, wp, session.id);
        st.log('Edge projected onto the sketch.', 'success');
      }
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
      project(l.userData as { points: [number, number, number][]; curve?: EdgeCurve });
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
