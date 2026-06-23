// ============================================================
// ToubkalCAD – sketchEntity.ts
//
// Materialise a single sketchGeom (line/circle/arc/polyline) as a new
// sketch_wire node: builds the OCC wire, registers it, adds the tree node with
// its sketchGeom (so it stays fully editable — trim, region, constraints) and
// dispatches the viewport visual. Used by the 2D Mirror / Array tools.
// ============================================================

import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccSketchService, fromLocal2D } from '../services/OccSketchService';

const NAME: Record<string, string> = { line: 'Line', circle: 'Circle', arc: 'Arc', polyline: 'Curve' };

/** Sampled world-space polyline for the viewport visual of an entity. */
function sampleEntity(geom: any, wp: Workplane): number[][] {
  const out: number[][] = [];
  const push = (u: number, v: number) => { const p = fromLocal2D(u, v, wp); out.push([p.x, p.y, p.z]); };
  if (geom.kind === 'line') { push(geom.a[0], geom.a[1]); push(geom.b[0], geom.b[1]); }
  else if (geom.kind === 'polyline') geom.pts.forEach((p: number[]) => push(p[0], p[1]));
  else if (geom.kind === 'circle') {
    for (let i = 0; i <= 72; i++) { const a = (2 * Math.PI * i) / 72; push(geom.c[0] + geom.r * Math.cos(a), geom.c[1] + geom.r * Math.sin(a)); }
  } else if (geom.kind === 'arc') {
    const S = 48; for (let i = 0; i <= S; i++) { const a = geom.a1 + ((geom.a2 - geom.a1) * i) / S; push(geom.c[0] + geom.r * Math.cos(a), geom.c[1] + geom.r * Math.sin(a)); }
  }
  return out;
}

/** Create a new sketch_wire node for `geom` under `parentId`. Returns its id (or null on failure). */
/**
 * `opts.construction` marks the entity as a REFERENCE/construction curve: it's
 * persisted with `params.construction = true`, rendered dashed + dimmed, kept out
 * of profile/region detection (so it never becomes part of an extrude/loft), and
 * — for solver-representable kinds (line/circle/arc) — frozen in PlaneGCS so you
 * can snap/dimension relative to it (see SketchSolveBridge.constructionFixedConstraints).
 */
export function createSketchEntityNode(
  geom: any, wp: Workplane, parentId: string | null,
  opts?: { construction?: boolean },
): string | null {
  const oc = window.oc;
  if (!oc || !geom) return null;
  const construction = !!opts?.construction;
  const wire = OccSketchService.buildEntityWire(oc, geom, wp);
  const id = crypto.randomUUID();
  CADGeometryRegistry.getInstance().registerShape(id, wire);
  const baseName = geom.ellipse ? 'Ellipse' : (NAME[geom.kind] ?? 'Curve');
  useCADStore.getState().addNode({
    id, name: `${construction ? 'Ref ' : ''}${baseName}`, type: 'sketch_wire',
    visible: true, locked: false, parentId, notes: '',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material:  { color: construction ? 0x8a93a3 : 0x003388, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
    params: { workplane: wp, sketchGeom: geom, ...(construction ? { construction: true } : {}) },
  });
  window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', { detail: { id, pts: sampleEntity(geom, wp), construction } }));
  return id;
}
