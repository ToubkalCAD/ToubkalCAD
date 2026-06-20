// ============================================================
// ToubkalCAD – SketchSolveBridge.ts
//
// Phase 8 – the bridge between the parametric 2D solver and the store/registry.
//
//   collectSolverGeoms — read a sketch's Line/Circle/Arc children into the
//                        EntityGeom list the solver understands.
//   rebuildSketchEntity — write a solved EntityGeom back: rebuild its OCC wire,
//                        update its sketchGeom param, and swap the viewport line.
//
// Shared by the constraint panel (apply / re-solve) and the live-drag hook so
// both move geometry through exactly the same path.
// ============================================================

import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from './CADGeometryRegistry';
import { OccSketchService, workplaneBasis, fromLocal2D } from './OccSketchService';
import type { EntityGeom } from './SketchConstraintSolver';

const reg = CADGeometryRegistry.getInstance();

/** Line/Circle/Arc children of a sketch as solver entities (other kinds skipped). */
export function collectSolverGeoms(sketchId: string): EntityGeom[] {
  const st = useCADStore.getState();
  const out: EntityGeom[] = [];
  for (const id of st.nodes[sketchId]?.children ?? []) {
    const g = st.nodes[id]?.params?.sketchGeom;
    if (!g) continue;
    if (g.kind === 'line')   out.push({ id, kind: 'line',   a: [g.a[0], g.a[1]], b: [g.b[0], g.b[1]] });
    if (g.kind === 'circle') out.push({ id, kind: 'circle', c: [g.c[0], g.c[1]], r: g.r });
    if (g.kind === 'arc')    out.push({ id, kind: 'arc',    c: [g.c[0], g.c[1]], r: g.r, a1: g.a1, a2: g.a2 });
  }
  return out;
}

/** A change key for a solved geom — only c/r/endpoints matter (a1/a2 are static). */
export const geomKey = (g: EntityGeom): string =>
  g.kind === 'line' ? `${g.a[0]},${g.a[1]},${g.b[0]},${g.b[1]}` : `${g.c[0]},${g.c[1]},${g.r}`;

function sampleCircle(center: THREE.Vector3, r: number, wp: Workplane, segs = 72): number[][] {
  const { uAxis, vAxis } = workplaneBasis(wp);
  return Array.from({ length: segs + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / segs;
    const p = center.clone().addScaledVector(uAxis, r * Math.cos(a)).addScaledVector(vAxis, r * Math.sin(a));
    return [p.x, p.y, p.z];
  });
}

function sampleArc(center: THREE.Vector3, r: number, a1: number, a2: number, wp: Workplane, segs = 48): number[][] {
  const { uAxis, vAxis } = workplaneBasis(wp);
  return Array.from({ length: segs + 1 }, (_, i) => {
    const a = a1 + ((a2 - a1) * i) / segs;
    const p = center.clone().addScaledVector(uAxis, r * Math.cos(a)).addScaledVector(vAxis, r * Math.sin(a));
    return [p.x, p.y, p.z];
  });
}

/**
 * Apply a solved geom to its node: rebuild the OCC wire, persist the new
 * sketchGeom, and tell the viewport to swap the polyline. No-op if the node or
 * kernel is missing.
 */
export function rebuildSketchEntity(id: string, g: EntityGeom): void {
  const st = useCADStore.getState();
  const wp = st.nodes[id]?.params?.workplane as Workplane | undefined;
  if (!wp || !window.oc) return;
  const oc = window.oc;
  let wire: any; let pts: number[][];
  if (g.kind === 'line') {
    const a3 = fromLocal2D(g.a[0], g.a[1], wp);
    const b3 = fromLocal2D(g.b[0], g.b[1], wp);
    wire = OccSketchService.createClosedWireFromEdges(oc, [OccSketchService.createLineEdge(oc, a3, b3)]);
    pts  = [[a3.x, a3.y, a3.z], [b3.x, b3.y, b3.z]];
  } else if (g.kind === 'arc') {
    const c3    = fromLocal2D(g.c[0], g.c[1], wp);
    const start = fromLocal2D(g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1), wp);
    const end   = fromLocal2D(g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2), wp);
    wire = OccSketchService.createClosedWireFromEdges(oc, [OccSketchService.createArcEdge(oc, c3, start, end, wp)]);
    pts  = sampleArc(c3, g.r, g.a1, g.a2, wp);
  } else {
    const c3  = fromLocal2D(g.c[0], g.c[1], wp);
    const rim = fromLocal2D(g.c[0] + g.r, g.c[1], wp);
    wire = OccSketchService.createCircleWire(oc, c3, rim, wp);
    pts  = sampleCircle(c3, g.r, wp);
  }
  reg.registerShape(id, wire);
  st.setNodeParams(id, { sketchGeom: g });
  window.dispatchEvent(new CustomEvent('cad-sketch-replace-visual', { detail: { id, pts } }));
}
