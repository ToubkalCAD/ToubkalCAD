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
import type { Workplane, SketchConstraint } from '../store/cadStore';
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
    // An ellipse — tool-drawn or a tilted circle's projection — is stored as a
    // sampled polyline + analytic descriptor; feed the analytic form so the solver
    // models it. A construction ellipse is FIXED (constructionFixedConstraints); a
    // tool-drawn one is fed as a RIGID body (PlaneGCSSolverAdapter locks its
    // centre→focus1 vector) so placement constraints translate it without reshaping.
    if (g.kind === 'polyline' && g.ellipse && Array.isArray(g.ellipse.c))
      out.push({ id, kind: 'ellipse', c: [g.ellipse.c[0], g.ellipse.c[1]], rx: g.ellipse.rx, ry: g.ellipse.ry, rot: g.ellipse.rot ?? 0 });
  }
  return out;
}

/**
 * A sketch's persisted constraints in the solver's SketchConstraint shape.
 * Tolerates the legacy `{ entityIds: [...] }` form by lifting it to `refs`.
 * Datum-fixed constraints are NOT included — callers append
 * `datumFixedConstraints()` so the datum axes/origin stay pinned during a solve.
 */
export function collectSketchConstraints(sketchId: string): SketchConstraint[] {
  const raw = (useCADStore.getState().nodes[sketchId]?.params?.constraints as any[]) ?? [];
  return raw.map((c) =>
    c.refs ? c : {
      id: c.id, type: c.type, value: c.value,
      refs: (c.entityIds ?? []).map((id: string) => ({ kind: 'entity', id })),
    });
}

/**
 * FIXED constraints pinning every construction (reference) entity in the sketch,
 * so the solver treats projected references as immovable snap / dimension targets
 * (3e). Only solver-representable kinds (line / circle / arc) are emitted —
 * construction polylines are visual-only and aren't fed to the solver. Append
 * alongside datumFixedConstraints() at every solve site.
 */
export function constructionFixedConstraints(sketchId: string): SketchConstraint[] {
  const st = useCADStore.getState();
  const out: SketchConstraint[] = [];
  for (const id of st.nodes[sketchId]?.children ?? []) {
    const n = st.nodes[id];
    const g = n?.params?.sketchGeom;
    if (!n?.params?.construction || !g) continue;
    const solvable = g.kind === 'line' || g.kind === 'circle' || g.kind === 'arc'
      || (g.kind === 'polyline' && g.ellipse);   // an ellipse reference is solver-fed too
    if (solvable)
      out.push({ id: `__fix_constr_${id}__`, type: 'FIXED', refs: [{ kind: 'entity', id }] });
  }
  return out;
}

/** A change key for a solved geom. Arcs include a1/a2 because dragging an arc
 *  ENDPOINT changes only its sweep angles (centre/radius held by constraints) —
 *  omitting them would make an angle-only drag look "unchanged" and skip rebuild. */
export const geomKey = (g: EntityGeom): string =>
  g.kind === 'line'    ? `${g.a[0]},${g.a[1]},${g.b[0]},${g.b[1]}`
  : g.kind === 'arc'   ? `${g.c[0]},${g.c[1]},${g.r},${g.a1},${g.a2}`
  : g.kind === 'ellipse' ? `${g.c[0]},${g.c[1]},${g.rx},${g.ry},${g.rot}`
  :                      `${g.c[0]},${g.c[1]},${g.r}`;

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

  // Ellipse is stored as a sampled polyline + analytic descriptor (not a raw
  // EntityGeom kind), so it rebuilds + persists differently from line/circle/arc.
  if (g.kind === 'ellipse') {
    const pts2d: number[][] = [];
    const ptsW:  number[][] = [];
    const cosR = Math.cos(g.rot), sinR = Math.sin(g.rot);
    const S = 72;
    for (let i = 0; i <= S; i++) {
      const t = (2 * Math.PI * i) / S;
      // c + rx·cosθ·majorDir + ry·sinθ·minorDir, in workplane-local (u,v).
      const u = g.c[0] + g.rx * Math.cos(t) * cosR - g.ry * Math.sin(t) * sinR;
      const v = g.c[1] + g.rx * Math.cos(t) * sinR + g.ry * Math.sin(t) * cosR;
      pts2d.push([u, v]);
      const p = fromLocal2D(u, v, wp); ptsW.push([p.x, p.y, p.z]);
    }
    const wire = OccSketchService.createRotatedEllipseWire(oc, fromLocal2D(g.c[0], g.c[1], wp), g.rx, g.ry, g.rot, wp);
    reg.registerShape(id, wire);
    const keepConstruction = st.nodes[id]?.params?.construction ? { construction: true } : {};
    st.setNodeParams(id, { sketchGeom: { kind: 'polyline', pts: pts2d, ellipse: { c: g.c, rx: g.rx, ry: g.ry, rot: g.rot } }, ...keepConstruction });
    window.dispatchEvent(new CustomEvent('cad-sketch-replace-visual', { detail: { id, pts: ptsW } }));
    return;
  }

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
