// ============================================================
// ToubkalCAD – useCADSketchTransformPick.ts
//
// Interactive reference picking for the 2D sketch Transform tools:
//   • MIRROR_AXIS_PICK   — click 2 points → the mirror line
//   • ARRAY_CENTER_PICK  — click 1 point  → the circular-array centre
//
// Points are picked on the source sketch's plane (ray→plane), snapping to the
// entities' endpoints/centres within a few pixels. A marker shows the picked
// point; for mirror a rubber line previews the axis after the first click.
// The selection + array params are handed in via beginSketchMirror/Circular.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { toLocal2D, fromLocal2D } from '../services/OccSketchService';
import { transformGeom, reflector, rotator, Pt } from '../services/SketchTransform2D';
import { createSketchEntityNode } from '../utils/sketchEntity';

interface SK { sketchId: string | null; wp: any; entities: { id: string; geom: any }[]; }
type Pending = { kind: 'mirror'; sk: SK } | { kind: 'circular'; sk: SK; count: number; angle: number };

let pending: Pending | null = null;
export function beginSketchMirror(sk: SK) { pending = { kind: 'mirror', sk }; useCADStore.getState().setInteractionMode('MIRROR_AXIS_PICK'); }
export function beginSketchCircular(sk: SK, count: number, angle: number) { pending = { kind: 'circular', sk, count, angle }; useCADStore.getState().setInteractionMode('ARRAY_CENTER_PICK'); }

const SNAP_PX = 10;
const CLICK_SLOP_PX = 5;
const COLOR_MARK = 0x00e0a0;
const COLOR_AXIS = 0xff8800;

/** Candidate snap points (local 2D) from a sketch's entities. */
function snapPoints(entities: { geom: any }[]): Pt[] {
  const pts: Pt[] = [];
  for (const { geom } of entities) {
    if (geom.kind === 'line') { pts.push(geom.a, geom.b); }
    else if (geom.kind === 'circle') { pts.push(geom.c); }
    else if (geom.kind === 'arc') {
      pts.push(geom.c,
        [geom.c[0] + geom.r * Math.cos(geom.a1), geom.c[1] + geom.r * Math.sin(geom.a1)],
        [geom.c[0] + geom.r * Math.cos(geom.a2), geom.c[1] + geom.r * Math.sin(geom.a2)]);
    } else if (geom.kind === 'polyline' && geom.pts.length) {
      pts.push(geom.pts[0], geom.pts[geom.pts.length - 1]);
    }
  }
  return pts;
}

export function useCADSketchTransformPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const firstRef = useRef<Pt | null>(null);   // mirror: first clicked point

  useEffect(() => {
    if (mode === 'MIRROR_AXIS_PICK')
      useCADStore.getState().log('Mirror: click two points for the mirror line (snaps to sketch points; Esc to cancel).', 'info');
    else if (mode === 'ARRAY_CENTER_PICK')
      useCADStore.getState().log('Circular array: click the centre point (snaps to sketch points; Esc to cancel).', 'info');
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ACTIVE = new Set(['MIRROR_AXIS_PICK', 'ARRAY_CENTER_PICK']);

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const down = { x: 0, y: 0, active: false };
    let marker: THREE.Mesh | null = null;
    let rubber: THREE.Line | null = null;

    const clear = () => {
      const s = sceneRef.current;
      if (marker && s) { s.remove(marker); marker.geometry.dispose(); (marker.material as THREE.Material).dispose(); }
      if (rubber && s) { s.remove(rubber); rubber.geometry.dispose(); (rubber.material as THREE.Material).dispose(); }
      marker = null; rubber = null;
    };

    /** Mouse → point on the sketch plane (local 2D), snapped to nearby sketch points. */
    const pickPoint = (e: MouseEvent): { local: Pt; world: THREE.Vector3 } | null => {
      const camera = cameraRef.current;
      const sk = pending?.sk;
      if (!camera || !sk) return null;
      const rect = container.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      ndc.set((sx / rect.width) * 2 - 1, -(sy / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const wp = sk.wp;
      const n = new THREE.Vector3(...wp.normal).normalize();
      const o = new THREE.Vector3(...wp.origin);
      const pl = new THREE.Plane(n, -n.dot(o));
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(pl, hit)) return null;

      // Snap to the nearest candidate within SNAP_PX (screen space).
      let best: Pt | null = null, bestPx = SNAP_PX;
      for (const c of snapPoints(sk.entities)) {
        const w = fromLocal2D(c[0], c[1], wp).project(camera);
        const px = ((w.x + 1) / 2) * rect.width, py = ((1 - w.y) / 2) * rect.height;
        const d = Math.hypot(px - sx, py - sy);
        if (d < bestPx) { bestPx = d; best = c; }
      }
      if (best) return { local: best, world: fromLocal2D(best[0], best[1], wp) };
      const l = toLocal2D(hit, wp);
      return { local: [l.u, l.v], world: hit };
    };

    const showMarker = (w: THREE.Vector3) => {
      const s = sceneRef.current; if (!s) return;
      if (!marker) {
        marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.6, 12, 12),
          new THREE.MeshBasicMaterial({ color: COLOR_MARK, depthTest: false }),
        );
        marker.renderOrder = 999; s.add(marker);
      }
      marker.position.copy(w);
    };
    const showRubber = (a: THREE.Vector3, b: THREE.Vector3) => {
      const s = sceneRef.current; if (!s) return;
      if (rubber) { s.remove(rubber); rubber.geometry.dispose(); (rubber.material as THREE.Material).dispose(); }
      rubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: COLOR_AXIS, depthTest: false }));
      rubber.renderOrder = 999; s.add(rubber);
    };

    const onMove = (e: MouseEvent) => {
      if (!ACTIVE.has(useCADStore.getState().interactionMode)) return;
      const p = pickPoint(e); if (!p) return;
      showMarker(p.world);
      if (firstRef.current) showRubber(fromLocal2D(firstRef.current[0], firstRef.current[1], pending!.sk.wp), p.world);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !ACTIVE.has(useCADStore.getState().interactionMode)) return;
      down.x = e.clientX; down.y = e.clientY; down.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !down.active) return;
      down.active = false;
      const m = useCADStore.getState().interactionMode;
      if (!ACTIVE.has(m)) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
      const p = pickPoint(e); if (!p || !pending) return;
      e.stopPropagation();

      if (pending.kind === 'mirror') {
        if (!firstRef.current) { firstRef.current = p.local; return; }   // first axis point
        applyMirror(pending.sk, firstRef.current, p.local);
        firstRef.current = null; clear();
        useCADStore.getState().setInteractionMode('SELECT');
      } else {
        applyCircular(pending.sk, p.local, pending.count, pending.angle);
        clear();
        useCADStore.getState().setInteractionMode('SELECT');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ACTIVE.has(useCADStore.getState().interactionMode)) {
        firstRef.current = null; clear(); pending = null;
        useCADStore.getState().setInteractionMode('SELECT');
        useCADStore.getState().log('Transform pick cancelled.', 'info');
      }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
      clear();
    };
  }, [containerRef, sceneRef, cameraRef]);

  // Drop the half-finished mirror point when leaving the modes.
  useEffect(() => {
    if (mode !== 'MIRROR_AXIS_PICK') firstRef.current = null;
  }, [mode]);
}

// ─── Apply ───────────────────────────────────────────────────────────────────

function emit(sk: SK, makeF: () => any, reverses: boolean, acc: string[]) {
  const f = makeF();
  for (const e of sk.entities) {
    const g = transformGeom(e.geom, f, reverses);
    const id = g && createSketchEntityNode(g, sk.wp, sk.sketchId);
    if (id) acc.push(id);
  }
}

function applyMirror(sk: SK, p0: Pt, p1: Pt) {
  const dir: Pt = [p1[0] - p0[0], p1[1] - p0[1]];
  if (Math.hypot(dir[0], dir[1]) < 1e-6) { useCADStore.getState().log('Mirror line is too short.', 'warn'); return; }
  const ids: string[] = [];
  emit(sk, () => reflector(p0, dir), true, ids);
  useCADStore.getState().setSelectedIds(ids);
  useCADStore.getState().log(`Mirrored → ${ids.length} new sketch ${ids.length === 1 ? 'entity' : 'entities'}.`, 'success');
}

function applyCircular(sk: SK, center: Pt, count: number, angleStep: number) {
  const ids: string[] = [];
  for (let i = 1; i < count; i++) emit(sk, () => rotator(center, (angleStep * i * Math.PI) / 180), false, ids);
  useCADStore.getState().setSelectedIds(ids);
  useCADStore.getState().log(`Circular×${count} → ${ids.length} new sketch ${ids.length === 1 ? 'entity' : 'entities'}.`, 'success');
}
