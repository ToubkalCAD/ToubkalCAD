// ============================================================
// ToubkalCAD – FeatureEvaluators.ts   (Phase 1, build-order step 2)
//
// One PURE evaluator per FeatureOp: (oc, inputs, params) → TopoDS_Shape. These
// generalize the per-op "apply" logic that today lives inline in panels /
// Ribbon / computeShape, by delegating to the existing stateless Occ*Services.
//
// Evaluators are deliberately pure: NO store, NO CADGeometryRegistry, NO
// CustomEvents. They take already-resolved input shapes and value params, and
// return a new shape. The recompute engine (step 3) owns resolving inputs to
// placed shapes, registering the result, and emitting mesh events.
//
// This file covers the SERVICE-WRAPPED ops (primitives, revolve, loft, sweep,
// boolean, fillet, chamfer). extrude (the many-knob op via computeShape),
// sketch/sketchWire (2D recipe), and datums (no solid) come later.
// ============================================================

import type { FeatureOp } from './FeatureGraph';
import type { StableRef } from './StableRef';
import { OccPrimitivesService } from './OccPrimitivesService';
import { OccRevolutionService } from './OccRevolutionService';
import { OccLoftService }       from './OccLoftService';
import { OccSweepService }      from './OccSweepService';
import { OccBooleanService }    from './OccBooleanService';
import { OccFilletService }     from './OccFilletService';
import { OccExtrusionService }  from './OccExtrusionService';
import { OccSketchService }     from './OccSketchService';
import { OccDatumService }      from './OccDatumService';
import { toRegionEntity, findRegions, RegionEntity } from './SketchRegions';
import type { Workplane } from '../store/cadStore';

type V3 = [number, number, number];

/** An input edge resolved to a live shape. The engine decides placed vs local;
 *  evaluators just consume `.shape`. */
export interface ResolvedInput {
  id:    string;
  role?: string;     // 'profile' | 'base' | 'tool' | 'source' | 'plane' | 'context'
  shape: any;        // TopoDS_Shape
  ref?:  StableRef;  // resolved sub-entity (face/edge), populated in step 4
  /** Source-feature metadata the evaluator needs but isn't geometry — e.g. a
   *  profile/datum `workplane` ({origin, normal}). The engine fills this in from
   *  the upstream node's params. */
  meta?: Record<string, any>;
}

const EXTRUDE_END = ['blind', 'symmetric', 'twoSided'] as const;

export type Evaluator = (oc: any, inputs: ResolvedInput[], params: Record<string, any>) => any;

// ─── input / param helpers ────────────────────────────────────────────────────
const byRole   = (inputs: ResolvedInput[], role: string) => inputs.filter((i) => i.role === role);
const firstRole = (inputs: ResolvedInput[], role: string) => byRole(inputs, role)[0];
const num = (p: Record<string, any>, key: string, dflt: number) => (typeof p[key] === 'number' ? p[key] : dflt);
const clampIdx = (n: number, hi: number) => Math.max(0, Math.min(hi, Math.round(n)));
const AXIS_VEC: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// ─── The registry ─────────────────────────────────────────────────────────────
export const EVALUATORS: Partial<Record<FeatureOp, Evaluator>> = {
  // Primitives — no inputs, dims from params.
  box:      (oc, _in, p) => OccPrimitivesService.createBox(oc, num(p, 'w', 10), num(p, 'h', 10), num(p, 'd', 10)),
  cylinder: (oc, _in, p) => OccPrimitivesService.createCylinder(oc, num(p, 'r', 5), num(p, 'h', 15)),
  sphere:   (oc, _in, p) => OccPrimitivesService.createSphere(oc, num(p, 'r', 7)),
  torus:    (oc, _in, p) => OccRevolutionService.createTorus(oc, num(p, 'R', 15), num(p, 'r', 3)),
  cone:     (oc, _in, p) => OccRevolutionService.createCone(oc, num(p, 'r1', 8), num(p, 'r2', 0), num(p, 'h', 15)),

  // Revolve — one profile wire, axis index + angle.
  revolve: (oc, inputs, p) => {
    const prof = firstRole(inputs, 'profile') ?? inputs[0];
    if (!prof) throw new Error('revolve: no profile input');
    const axis = AXIS_VEC[clampIdx(num(p, 'axis', 1), 2)];
    return OccRevolutionService.revolveProfile(oc, prof.shape, [0, 0, 0], axis, num(p, 'angle', 360));
  },

  // Loft — ≥2 profile wires (order preserved), solid/ruled flags.
  loft: (oc, inputs, p) => {
    const profiles = byRole(inputs, 'profile');
    const wires = (profiles.length ? profiles : inputs).map((i) => i.shape);
    if (wires.length < 2) throw new Error('loft: needs ≥2 profiles');
    return OccLoftService.loftProfiles(oc, wires, num(p, 'solid', 1) >= 0.5, num(p, 'ruled', 0) >= 0.5);
  },

  // Sweep — profile then spine (convention: index 0 = profile, spineIndex = spine).
  sweep: (oc, inputs, p) => {
    const ordered = byRole(inputs, 'profile');
    const list = ordered.length >= 2 ? ordered : inputs;
    const profile = list[0]?.shape;
    const spine   = list[clampIdx(num(p, 'spineIndex', 1), list.length - 1)]?.shape;
    if (!profile || !spine) throw new Error('sweep: needs a profile and a spine');
    return OccSweepService.sweepProfile(oc, profile, spine);
  },

  // Boolean — fold each tool onto the base (matches the panel's computeBoolean),
  // freeing intermediates; inputs (base/tools) are owned by the engine, not freed.
  boolean: (oc, inputs, p) => {
    const base  = firstRole(inputs, 'base') ?? inputs[0];
    const tools = byRole(inputs, 'tool');
    if (!base) throw new Error('boolean: no base input');
    if (!tools.length) throw new Error('boolean: no tool inputs');
    const opn = String(p.boolOp ?? 'CUT').toUpperCase();
    let result = base.shape;
    for (const t of tools) {
      const next =
        opn === 'FUSE'   ? OccBooleanService.fuse(oc, result, t.shape) :
        opn === 'COMMON' ? OccBooleanService.intersect(oc, result, t.shape) :
                           OccBooleanService.subtract(oc, result, t.shape);
      if (result !== base.shape) { try { result.delete(); } catch { /* already freed */ } }  // drop intermediate
      result = next;
    }
    return result;
  },

  // Fillet / chamfer — one base solid + legacy positional edgeIndices (migrates
  // to StableRef sub-entity selections in step 4) + a radius/distance.
  fillet:  (oc, inputs, p) => blend(oc, inputs, p, 'fillet'),
  chamfer: (oc, inputs, p) => blend(oc, inputs, p, 'chamfer'),

  // Sketch wire — the leaf the whole graph hangs off. Two shapes:
  //   • entity wire: params.sketchGeom (line/circle/arc/polyline) → rebuild directly.
  //   • region wire: params.region — a closed profile traced from the sibling
  //     ENTITY inputs (role 'entity', each carrying meta.sketchGeom). The engine
  //     supplies the siblings; we re-detect the region so a moved entity reshapes it.
  sketchWire: (oc, inputs, p) => {
    const wp = p.workplane as Workplane | undefined;
    if (!wp) throw new Error('sketchWire: no workplane');
    if (p.sketchGeom) return OccSketchService.buildEntityWire(oc, p.sketchGeom, wp);
    if (p.region) {
      const geomById = new Map<string, any>(inputs.map((i) => [i.id, i.meta?.sketchGeom]));
      const ents = inputs.map((i) => toRegionEntity(i.id, geomById.get(i.id))).filter((e): e is RegionEntity => !!e);
      const regions = findRegions(ents);
      if (!regions.length) throw new Error('sketchWire region: entities enclose no region');
      const rg = regions.reduce((a, b) => (b.area > a.area ? b : a));   // largest
      return OccSketchService.buildRegionProfileWire(oc, rg, (id) => geomById.get(id), wp).wire;
    }
    throw new Error('sketchWire: neither sketchGeom nor region');
  },
  // The 'sketch' CONTAINER produces no geometry (it groups entities + holds the
  // workplane/constraints) — intentionally no evaluator; the engine skips it.

  // Extrude — the many-knob op. Mirrors Op3DPanel.computeShape:
  //   endMode 0/1/2 = blind/symmetric/twoSided (+ draft + thickness, E7 multi-region)
  //   3 = up-to-face · 6 = up-to-plane · 4/5 = up-to-next/last
  //   op 1/2 = pad(fuse)/pocket(cut) against the 'base' solid input
  // Direction + neutral point come from the PROFILE's workplane (inputs[].meta),
  // which the engine supplies; defaults to Y-up / origin if absent.
  extrude: (oc, inputs, p) => {
    const profiles = byRole(inputs, 'profile');
    const wires = (profiles.length ? profiles : inputs.filter((i) => !i.role || i.role === 'profile')).map((i) => i.shape).filter(Boolean);
    if (!wires.length) throw new Error('extrude: no profile input');

    const wp = (profiles[0] ?? inputs[0])?.meta?.workplane;
    const direction: [number, number, number]    = wp?.normal ?? [0, 1, 0];
    const neutralPoint: [number, number, number] = wp?.origin ?? [0, 0, 0];
    const reverse = num(p, 'reverse', 0) >= 0.5;
    const endMode = clampIdx(num(p, 'endMode', 0), 6);
    const upTo = { direction, reverse, neutralPoint };

    let solid: any;
    if (endMode === 3) {                                   // up-to-face
      const base = firstRole(inputs, 'base');
      if (!base) throw new Error('extrude up-to-face: needs a base solid input');
      solid = OccExtrusionService.extrudeUpToFace(oc, wires[0], upTo, base.shape, p.targetFacePoint);
    } else if (endMode === 6) {                            // up-to-plane (datum)
      const pwp = firstRole(inputs, 'plane')?.meta?.workplane;
      if (!pwp) throw new Error('extrude up-to-plane: needs a datum plane input');
      solid = OccExtrusionService.extrudeUpToPlane(oc, wires[0], upTo, pwp.origin, pwp.normal);
    } else if (endMode === 4 || endMode === 5) {           // up-to-next / up-to-last
      const bodies = byRole(inputs, 'context').map((i) => i.shape);
      if (!bodies.length) throw new Error('extrude up-to-next/last: needs context bodies (engine-supplied)');
      solid = endMode === 4
        ? OccExtrusionService.extrudeUpToNext(oc, wires[0], upTo, bodies)
        : OccExtrusionService.extrudeUpToLast(oc, wires[0], upTo, bodies);
    } else {                                               // blind / symmetric / twoSided
      solid = OccExtrusionService.extrudeProfiles(oc, wires, {
        height:       num(p, 'h', 20),
        end:          EXTRUDE_END[endMode] ?? 'blind',
        height2:      num(p, 'h2', 10),
        reverse,
        direction,
        draftAngle:   num(p, 'draft', 0),
        neutralPoint,
        thickness:    num(p, 'thick', 0),
      });
    }

    // Pad (fuse) / Pocket (cut) against the picked base solid.
    const boolOp = Math.round(num(p, 'op', 0));
    if (boolOp === 1 || boolOp === 2) {
      const base = firstRole(inputs, 'base');
      if (!base) throw new Error('extrude pad/pocket: needs a base solid input');
      const merged = boolOp === 1
        ? OccBooleanService.fuse(oc, base.shape, solid)
        : OccBooleanService.subtract(oc, base.shape, solid);
      try { solid.delete(); } catch { /* freed */ }   // drop the intermediate prism
      solid = merged;
    }
    return solid;
  },
};

function blend(oc: any, inputs: ResolvedInput[], p: Record<string, any>, kind: 'fillet' | 'chamfer'): any {
  const base = firstRole(inputs, 'base') ?? inputs[0];
  if (!base) throw new Error(`${kind}: no source input`);
  const edges: number[] = Array.isArray(p.edgeIndices) ? p.edgeIndices : [];
  if (!edges.length) throw new Error(`${kind}: no edges selected`);
  const value = num(p, 'blendValue', 1);
  return kind === 'fillet'
    ? OccFilletService.filletEdges(oc, base.shape, edges, value)
    : OccFilletService.chamferEdges(oc, base.shape, edges, value);
}

/** Evaluate one feature. Throws if the op has no evaluator yet (sketch container / datum). */
export function evaluate(oc: any, op: FeatureOp, inputs: ResolvedInput[], params: Record<string, any>): any {
  const ev = EVALUATORS[op];
  if (!ev) throw new Error(`no evaluator for op '${op}'`);
  return ev(oc, inputs, params);
}

/** Ops that currently have a shape-producing evaluator. */
export const HAS_EVALUATOR = (op: FeatureOp): boolean => !!EVALUATORS[op];

// ─── Datums: frame producers (NOT shapes) ─────────────────────────────────────
// Datums carry no OCC solid; they yield a reference frame the viewport renders
// from params. `evaluateDatum` re-derives that frame for the methods that are
// cleanly determined by their input frames + a scalar (offset / midplane /
// 3-point), so the datum follows when those inputs change. Methods that need
// positional face/edge/vertex resolution (angle / tangent / curve-normal / …)
// pass the STORED frame through unchanged for now — correct while inputs are
// stable; full re-derivation arrives with StableRef integration (step 4). Body
// moves are already handled rigidly by recomputeDatums.computeDatumUpdates (D13).

export type DatumFrame =
  | { kind: 'plane'; workplane: Workplane }
  | { kind: 'axis';  axis: { origin: V3; dir: V3 } }
  | { kind: 'point'; point: V3 };

export function evaluateDatum(
  oc: any, datumType: string, inputs: ResolvedInput[], params: Record<string, any>,
): DatumFrame | null {
  const p = params ?? {};
  if (datumType === 'datum_plane') {
    const m = p.method;
    if (m === 'offset') {
      const base = inputs[0]?.meta?.workplane as Workplane | undefined;
      const dist = Number(p.refs?.[0]?.distance ?? p.distance ?? 0);
      if (base) {
        const o: V3 = [
          base.origin[0] + base.normal[0] * dist,
          base.origin[1] + base.normal[1] * dist,
          base.origin[2] + base.normal[2] * dist,
        ];
        return { kind: 'plane', workplane: { ...base, label: 'Offset', origin: o } };
      }
    } else if (m === 'midplane') {
      const a = inputs[0]?.meta?.workplane as Workplane | undefined;
      const b = inputs[1]?.meta?.workplane as Workplane | undefined;
      if (a && b) { const wp = OccDatumService.midplane(oc, a.origin, a.normal, b.origin, b.normal); if (wp) return { kind: 'plane', workplane: wp }; }
    } else if (m === '3point') {
      const pts = inputs.map((i) => i.meta?.point as V3 | undefined).filter((x): x is V3 => !!x);
      if (pts.length >= 3) { const wp = OccDatumService.planeFrom3Points(oc, pts[0], pts[1], pts[2]); if (wp) return { kind: 'plane', workplane: wp }; }
    }
    if (p.workplane) return { kind: 'plane', workplane: p.workplane };   // pass-through
  }
  if (datumType === 'datum_axis'  && p.axis)  return { kind: 'axis',  axis: p.axis };
  if (datumType === 'datum_point' && p.point) return { kind: 'point', point: p.point };
  return null;
}
