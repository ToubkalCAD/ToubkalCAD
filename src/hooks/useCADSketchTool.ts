// ============================================================
// ToubkalCAD – useCADSketchTool.ts  (v4 — any-plane sketching)
//
// All clicks are projected onto the active workplane (stored in
// Zustand).  Geometry is created in 3D world space directly via
// OccSketchService (3D APIs) — no 2D-to-3D transforms required.
//
// Three.js preview lines are positioned in world space too,
// so they are always on the chosen plane regardless of orientation.
// ============================================================

import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { Workplane } from '../store/cadStore';
import { OccSketchService, workplaneBasis, toLocal2D, fromLocal2D } from '../services/OccSketchService';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';

// ─── Constants ────────────────────────────────────────────────────────────────
const COLOR_RUBBER  = 0x0077cc;
const COLOR_COMMIT  = 0x003388;

// ─── Curve-sampling for preview ───────────────────────────────────────────────

function mkLine(pts: THREE.Vector3[], color: number): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
}

/** Sample a circle on any plane (in world space). */
function sampleCircle3D(center: THREE.Vector3, rim: THREE.Vector3, wp: Workplane, segs = 72): THREE.Vector3[] {
  const r   = center.distanceTo(rim);
  const { uAxis, vAxis } = workplaneBasis(wp);
  return Array.from({ length: segs+1 }, (_, i) => {
    const a = (2*Math.PI*i)/segs;
    return center.clone().addScaledVector(uAxis, r*Math.cos(a)).addScaledVector(vAxis, r*Math.sin(a));
  });
}

/** Sample an arc on any plane from start to end (passing through a mid direction). */
function sampleArc3D(
  center: THREE.Vector3, startPt: THREE.Vector3, endPt: THREE.Vector3,
  wp: Workplane, segs = 48,
): THREE.Vector3[] {
  const { uAxis, vAxis } = workplaneBasis(wp);
  const r   = center.distanceTo(startPt);
  const lc  = toLocal2D(center, wp);
  const ls  = toLocal2D(startPt, wp);
  const le  = toLocal2D(endPt, wp);
  const a1  = Math.atan2(ls.v - lc.v, ls.u - lc.u);
  let   a2  = Math.atan2(le.v - lc.v, le.u - lc.u);
  if (a2 < a1) a2 += 2*Math.PI;
  return Array.from({ length: segs+1 }, (_, i) => {
    const a = a1 + ((a2 - a1) * i) / segs;
    return center.clone().addScaledVector(uAxis, r*Math.cos(a)).addScaledVector(vAxis, r*Math.sin(a));
  });
}

function sampleArc3PPreview(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, wp: Workplane): THREE.Vector3[] | null {
  const lp1 = toLocal2D(p1, wp); const lp2 = toLocal2D(p2, wp); const lp3 = toLocal2D(p3, wp);
  const D = 2*(lp1.u*(lp2.v-lp3.v)+lp2.u*(lp3.v-lp1.v)+lp3.u*(lp1.v-lp2.v));
  if (Math.abs(D) < 1e-10) return null;
  const ux = ((lp1.u*lp1.u+lp1.v*lp1.v)*(lp2.v-lp3.v)+(lp2.u*lp2.u+lp2.v*lp2.v)*(lp3.v-lp1.v)+(lp3.u*lp3.u+lp3.v*lp3.v)*(lp1.v-lp2.v)) / D;
  const uy = ((lp1.u*lp1.u+lp1.v*lp1.v)*(lp3.u-lp2.u)+(lp2.u*lp2.u+lp2.v*lp2.v)*(lp1.u-lp3.u)+(lp3.u*lp3.u+lp3.v*lp3.v)*(lp2.u-lp1.u)) / D;
  const r   = Math.hypot(lp1.u-ux, lp1.v-uy);
  const center = fromLocal2D(ux, uy, wp);
  return sampleArc3D(center, p1, p3, wp);
}

function sampleEllipse3D(
  center: THREE.Vector3, majorEnd: THREE.Vector3, minorEnd: THREE.Vector3,
  wp: Workplane, segs = 72,
): THREE.Vector3[] {
  const lc = toLocal2D(center, wp);
  const lm = toLocal2D(majorEnd, wp);
  const ln = toLocal2D(minorEnd, wp);
  let   major = Math.hypot(lm.u-lc.u, lm.v-lc.v);
  let   minor = Math.hypot(ln.u-lc.u, ln.v-lc.v);
  if (major < minor) { [major, minor] = [minor, major]; }
  const { uAxis, vAxis } = workplaneBasis(wp);
  return Array.from({ length: segs+1 }, (_, i) => {
    const a = (2*Math.PI*i)/segs;
    return center.clone().addScaledVector(uAxis, major*Math.cos(a)).addScaledVector(vAxis, minor*Math.sin(a));
  });
}

function samplePolygon3D(center: THREE.Vector3, rim: THREE.Vector3, sides: number, wp: Workplane): THREE.Vector3[] {
  const lc = toLocal2D(center, wp); const lr = toLocal2D(rim, wp);
  const r  = Math.hypot(lr.u-lc.u, lr.v-lc.v);
  const { uAxis, vAxis } = workplaneBasis(wp);
  const pts = Array.from({ length: sides+1 }, (_, i) => {
    const a = (2*Math.PI*i)/sides;
    return center.clone().addScaledVector(uAxis, r*Math.cos(a)).addScaledVector(vAxis, r*Math.sin(a));
  });
  pts[sides] = pts[0].clone();
  return pts;
}

function sampleRect3D(c1: THREE.Vector3, c2: THREE.Vector3, wp: Workplane): THREE.Vector3[] {
  const l1 = toLocal2D(c1, wp); const l2 = toLocal2D(c2, wp);
  return [
    fromLocal2D(l1.u, l1.v, wp), fromLocal2D(l2.u, l1.v, wp),
    fromLocal2D(l2.u, l2.v, wp), fromLocal2D(l1.u, l2.v, wp),
    fromLocal2D(l1.u, l1.v, wp),
  ];
}

function sampleBezier3D(pts: THREE.Vector3[], segs = 60): THREE.Vector3[] {
  return Array.from({ length: segs+1 }, (_, k) => {
    const t = k/segs;
    let p = pts.map(v => v.clone());
    for (let r = 1; r < pts.length; r++)
      p = p.slice(0,-1).map((v,i) => v.clone().lerp(p[i+1], t));
    return p[0];
  });
}

function sampleCatmullRom3D(pts: THREE.Vector3[], segs = 60): THREE.Vector3[] {
  if (pts.length < 2) return pts;
  const result: THREE.Vector3[] = [];
  const n = pts.length;
  for (let seg = 0; seg < n-1; seg++) {
    const p0=pts[Math.max(0,seg-1)], p1=pts[seg], p2=pts[Math.min(n-1,seg+1)], p3=pts[Math.min(n-1,seg+2)];
    for (let k=0; k<=segs; k++) {
      const t=k/segs, t2=t*t, t3=t2*t;
      result.push(new THREE.Vector3(
        0.5*((-t3+2*t2-t)*p0.x+(3*t3-5*t2+2)*p1.x+(-3*t3+4*t2+t)*p2.x+(t3-t2)*p3.x),
        0.5*((-t3+2*t2-t)*p0.y+(3*t3-5*t2+2)*p1.y+(-3*t3+4*t2+t)*p2.y+(t3-t2)*p3.y),
        0.5*((-t3+2*t2-t)*p0.z+(3*t3-5*t2+2)*p1.z+(-3*t3+4*t2+t)*p2.z+(t3-t2)*p3.z),
      ));
    }
  }
  return result;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCADSketchTool(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const interactionMode    = useCADStore((s) => s.interactionMode);
  const activeWorkplane    = useCADStore((s) => s.activeWorkplane);
  const sketchPolygonSides = useCADStore((s) => s.sketchPolygonSides);

  const clicksRef      = useRef<THREE.Vector3[]>([]);
  const previewRef     = useRef<THREE.Line | null>(null);
  const committedRef   = useRef<THREE.Line[]>([]);
  const wireVisualsRef = useRef<Map<string, THREE.Line[]>>(new Map());

  // ─── Project mouse onto the active workplane ────────────────────────────────

  const project = useCallback((e: MouseEvent, wp: Workplane): THREE.Vector3 | null => {
    const container = containerRef.current;
    const camera    = cameraRef.current;
    if (!container || !camera) return null;

    const rect = container.getBoundingClientRect();
    const ndc  = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  *  2 - 1,
      ((e.clientY - rect.top)  / rect.height) * -2 + 1,
    );
    const ray  = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);

    // Build Three.js plane from workplane definition
    const n    = new THREE.Vector3(...wp.normal).normalize();
    const o    = new THREE.Vector3(...wp.origin);
    const d    = -n.dot(o);  // plane constant: n·x + d = 0
    const pl   = new THREE.Plane(n, d);
    const hit  = new THREE.Vector3();
    if (!ray.ray.intersectPlane(pl, hit)) return null;

    // Optional snap
    const { snapEnabled, snapStep } = useCADStore.getState();
    if (snapEnabled) {
      const lc  = toLocal2D(hit, wp);
      const su  = Math.round(lc.u / snapStep) * snapStep;
      const sv  = Math.round(lc.v / snapStep) * snapStep;
      return fromLocal2D(su, sv, wp);
    }
    return hit;
  }, [containerRef, cameraRef]);

  // ─── Preview helpers ─────────────────────────────────────────────────────────

  const clearPreview = useCallback(() => {
    const s = sceneRef.current;
    if (s && previewRef.current) {
      s.remove(previewRef.current);
      previewRef.current.geometry.dispose();
      (previewRef.current.material as THREE.Material).dispose();
    }
    previewRef.current = null;
  }, [sceneRef]);

  const setPreview = useCallback((pts: THREE.Vector3[], color = COLOR_RUBBER) => {
    const s = sceneRef.current;
    if (!s || pts.length < 2) { clearPreview(); return; }
    clearPreview();
    previewRef.current = mkLine(pts, color);
    s.add(previewRef.current);
  }, [sceneRef, clearPreview]);

  const addCommitted = useCallback((pts: THREE.Vector3[]) => {
    const s = sceneRef.current;
    if (!s || pts.length < 2) return;
    const l = mkLine(pts, COLOR_COMMIT);
    s.add(l); committedRef.current.push(l);
  }, [sceneRef]);

  const cancelAll = useCallback(() => {
    clearPreview();
    const s = sceneRef.current;
    if (s) committedRef.current.forEach((l) => {
      s.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose();
    });
    committedRef.current = [];
    clicksRef.current    = [];
  }, [sceneRef, clearPreview]);

  // ─── Register finalized sketch ───────────────────────────────────────────────

  const registerWire = useCallback((oc: any, wire: any, shapeLabel: string, wp: Workplane) => {
    const id = crypto.randomUUID();
    CADGeometryRegistry.getInstance().registerShape(id, wire);

    const lines = [...committedRef.current];
    lines.forEach((l) => { l.userData.cadNodeId = id; });
    wireVisualsRef.current.set(id, lines);
    committedRef.current = [];
    clearPreview();
    clicksRef.current = [];

    useCADStore.getState().addNode({
      id, name: shapeLabel, type: 'sketch_wire',
      visible: true, locked: false, parentId: null, notes: '',
      transform: { position:[0,0,0], rotation:[0,0,0], scale:[1,1,1] },
      material:  { color:0x003388, roughness:0.5, metalness:0, wireframe:true, opacity:1, transparent:false },
      params: { workplane: wp },
    });
    useCADStore.getState().setSelectedIds([id]);
    useCADStore.getState().log(`Sketch "${shapeLabel}" on ${wp.label} plane. Click Extrude to create solid.`, 'success');
    useCADStore.getState().setInteractionMode('SELECT');
  }, [clearPreview]);

  // ─── Cleanup wires when nodes are deleted ────────────────────────────────────

  useEffect(() => {
    const unsub = useCADStore.subscribe((curr, prev) => {
      if (curr.nodes === prev.nodes) return;
      for (const [id, lines] of wireVisualsRef.current) {
        if (!curr.nodes[id]) {
          const s = sceneRef.current;
          if (s) lines.forEach((l) => {
            s.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose();
          });
          wireVisualsRef.current.delete(id);
        }
      }
    });
    return unsub;
  }, [sceneRef]);

  useEffect(() => {
    const unsub = useCADStore.subscribe((curr, prev) => {
      if (curr.nodes === prev.nodes) return;
      for (const [id, lines] of wireVisualsRef.current) {
        const node = curr.nodes[id];
        if (node) lines.forEach((l) => { l.visible = node.visible; });
      }
    });
    return unsub;
  }, []);

  // ─── Main event loop ─────────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const getWP = () => useCADStore.getState().activeWorkplane;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const mode = useCADStore.getState().interactionMode;
      if (!mode.startsWith('SKETCH_')) return;
      e.stopPropagation();

      const wp = getWP();
      const pt = project(e, wp);
      if (!pt) return;
      const oc = window.oc;
      if (!oc) { useCADStore.getState().log('OCC kernel not ready.', 'error'); return; }

      const clicks = clicksRef.current;
      clicks.push(pt.clone());

      try {
        switch (mode) {

          case 'SKETCH_LINE': {
            if (clicks.length === 2) {
              const [a, b] = clicks;
              const edge = OccSketchService.createLineEdge(oc, a, b);
              const wire = OccSketchService.createClosedWireFromEdges(oc, [edge]);
              addCommitted([a.clone(), b.clone()]);
              registerWire(oc, wire, `Line`, wp);
            }
            break;
          }

          case 'SKETCH_CIRCLE': {
            if (clicks.length === 2) {
              const [c, rim] = clicks;
              const r = c.distanceTo(rim);
              if (r < 0.01) { clicks.pop(); break; }
              const wire = OccSketchService.createCircleWire(oc, c, rim, wp);
              addCommitted(sampleCircle3D(c, rim, wp));
              registerWire(oc, wire, `Circle-r${r.toFixed(1)}`, wp);
            }
            break;
          }

          case 'SKETCH_RECTANGLE': {
            if (clicks.length === 2) {
              const [c1, c2] = clicks;
              const wire = OccSketchService.createRectangleWire(oc, c1, c2, wp);
              addCommitted(sampleRect3D(c1, c2, wp));
              registerWire(oc, wire, `Rectangle`, wp);
            }
            break;
          }

          case 'SKETCH_ARC': {
            // 3 clicks: center → start → end
            if (clicks.length === 3) {
              const [center, startPt, endPt] = clicks;
              const edge = OccSketchService.createArcEdge(oc, center, startPt, endPt, wp);
              const wire = OccSketchService.createClosedWireFromEdges(oc, [edge]);
              addCommitted(sampleArc3D(center, startPt, endPt, wp));
              registerWire(oc, wire, `Arc`, wp);
            }
            break;
          }

          case 'SKETCH_ARC_3P': {
            if (clicks.length === 3) {
              const [p1, p2, p3] = clicks;
              const edge = OccSketchService.createArcByThreePoints(oc, p1, p2, p3, wp);
              const wire = OccSketchService.createClosedWireFromEdges(oc, [edge]);
              const preview = sampleArc3PPreview(p1, p2, p3, wp);
              addCommitted(preview ?? [p1.clone(), p2.clone(), p3.clone()]);
              registerWire(oc, wire, `Arc-3P`, wp);
            }
            break;
          }

          case 'SKETCH_ELLIPSE': {
            if (clicks.length === 3) {
              const [c, majPt, minPt] = clicks;
              const wire = OccSketchService.createEllipseWire(oc, c, majPt, minPt, wp);
              addCommitted(sampleEllipse3D(c, majPt, minPt, wp));
              registerWire(oc, wire, `Ellipse`, wp);
            }
            break;
          }

          case 'SKETCH_POLYGON': {
            if (clicks.length === 2) {
              const [c, rim] = clicks;
              const sides = useCADStore.getState().sketchPolygonSides;
              const wire  = OccSketchService.createPolygonWire(oc, c, rim, sides, wp);
              addCommitted(samplePolygon3D(c, rim, sides, wp));
              registerWire(oc, wire, `Polygon-${sides}`, wp);
            }
            break;
          }

          case 'SKETCH_ROUNDED_RECT': {
            if (clicks.length === 3) {
              const [c1, c2, rPt] = clicks;
              const l1 = toLocal2D(c1, wp); const l2 = toLocal2D(c2, wp);
              const cx = Math.min(l1.u,l2.u); const cy = Math.min(l1.v,l2.v);
              const r  = Math.max(0.1, Math.min(
                c1.distanceTo(new THREE.Vector3(...wp.origin).add(
                  new THREE.Vector3(...wp.uAxis).multiplyScalar(cx)
                )), Math.min(Math.abs(l2.u-l1.u), Math.abs(l2.v-l1.v))/2 - 0.001,
              ));
              const cornerRadius = Math.max(0.1,
                Math.min(rPt.distanceTo(c1), Math.min(Math.abs(l2.u-l1.u), Math.abs(l2.v-l1.v))/2 - 0.001));
              const wire = OccSketchService.createRoundedRectangleWire(oc, c1, c2, cornerRadius, wp);
              addCommitted(sampleRect3D(c1, c2, wp));
              registerWire(oc, wire, `RndRect-r${cornerRadius.toFixed(1)}`, wp);
            }
            break;
          }

          case 'SKETCH_BEZIER':
          case 'SKETCH_SPLINE':
            // Accumulate; finish on Enter / double-click
            break;

          default: break;
        }
      } catch (err: any) {
        useCADStore.getState().log(`Sketch error: ${err.message}`, 'error');
        cancelAll();
      }
    };

    const onDblClick = (e: MouseEvent) => {
      const mode = useCADStore.getState().interactionMode;
      if (mode !== 'SKETCH_BEZIER' && mode !== 'SKETCH_SPLINE') return;
      e.stopPropagation();
      finishCurve(mode);
    };

    const finishCurve = (mode: string) => {
      const oc = window.oc; const wp = getWP(); const clicks = clicksRef.current;
      if (!oc || clicks.length < 2) { useCADStore.getState().log('Need ≥ 2 points', 'warn'); return; }
      try {
        if (mode === 'SKETCH_BEZIER') {
          const wire = OccSketchService.createBezierWire(oc, clicks);
          addCommitted(sampleBezier3D(clicks));
          registerWire(oc, wire, `Bezier-${clicks.length}pts`, wp);
        } else {
          const wire = OccSketchService.createSplineWire(oc, clicks, wp);
          addCommitted(sampleCatmullRom3D(clicks));
          registerWire(oc, wire, `Spline-${clicks.length}pts`, wp);
        }
      } catch (err: any) {
        useCADStore.getState().log(`Curve error: ${err.message}`, 'error');
        cancelAll();
      }
    };

    const onMove = (e: MouseEvent) => {
      const mode = useCADStore.getState().interactionMode;
      if (!mode.startsWith('SKETCH_')) { clearPreview(); return; }
      const wp = getWP();
      const pt = project(e, wp);
      if (!pt) return;
      const clicks = clicksRef.current;

      switch (mode) {
        case 'SKETCH_LINE':
          if (clicks.length === 1) setPreview([clicks[0].clone(), pt.clone()]);
          break;
        case 'SKETCH_CIRCLE':
          if (clicks.length === 1 && clicks[0].distanceTo(pt) > 0.01)
            setPreview(sampleCircle3D(clicks[0], pt, wp));
          break;
        case 'SKETCH_RECTANGLE':
          if (clicks.length === 1) setPreview(sampleRect3D(clicks[0], pt, wp));
          break;
        case 'SKETCH_ARC':
          if (clicks.length === 1 && clicks[0].distanceTo(pt) > 0.01)
            setPreview(sampleCircle3D(clicks[0], pt, wp), 0x4488ff);
          else if (clicks.length === 2 && clicks[0].distanceTo(clicks[1]) > 0.01)
            setPreview(sampleArc3D(clicks[0], clicks[1], pt, wp));
          break;
        case 'SKETCH_ARC_3P':
          if (clicks.length === 1) setPreview([clicks[0].clone(), pt.clone()]);
          else if (clicks.length === 2) {
            const preview = sampleArc3PPreview(clicks[0], clicks[1], pt, wp);
            setPreview(preview ?? [clicks[0].clone(), pt.clone()]);
          }
          break;
        case 'SKETCH_ELLIPSE':
          if (clicks.length === 1 && clicks[0].distanceTo(pt) > 0.01)
            setPreview(sampleCircle3D(clicks[0], pt, wp));
          else if (clicks.length === 2)
            setPreview(sampleEllipse3D(clicks[0], clicks[1], pt, wp));
          break;
        case 'SKETCH_POLYGON':
          if (clicks.length === 1 && clicks[0].distanceTo(pt) > 0.01)
            setPreview(samplePolygon3D(clicks[0], pt, useCADStore.getState().sketchPolygonSides, wp));
          break;
        case 'SKETCH_ROUNDED_RECT':
          if (clicks.length === 1) setPreview(sampleRect3D(clicks[0], pt, wp));
          else if (clicks.length === 2)
            setPreview([clicks[0].clone(), pt.clone()], 0xff8800);
          break;
        case 'SKETCH_BEZIER':
          if (clicks.length >= 1) setPreview(sampleBezier3D([...clicks, pt]));
          break;
        case 'SKETCH_SPLINE':
          if (clicks.length >= 1) setPreview(sampleCatmullRom3D([...clicks, pt]));
          break;
        default: break;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const mode = useCADStore.getState().interactionMode;
      if (!mode.startsWith('SKETCH_')) return;
      if (e.key === 'Escape') {
        cancelAll();
        useCADStore.getState().log('Sketch cancelled.', 'warn');
        useCADStore.getState().setInteractionMode('SELECT');
      } else if (e.key === 'Enter') {
        if (mode === 'SKETCH_BEZIER' || mode === 'SKETCH_SPLINE') finishCurve(mode);
      }
    };

    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('dblclick',  onDblClick, true);
    container.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('dblclick',  onDblClick, true);
      container.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
      clearPreview();
    };
  }, [interactionMode, activeWorkplane, sketchPolygonSides,
      project, setPreview, clearPreview, addCommitted, cancelAll, registerWire]);
}
