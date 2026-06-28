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
import { resolveEdge, resolveFace, resolveVertex, captureFace, captureEdge, captureVertex,
  type StableRef, type EdgeSig, type FaceSig } from './StableRef';
import { OccPrimitivesService } from './OccPrimitivesService';
import { OccRevolutionService } from './OccRevolutionService';
import { OccLoftService }       from './OccLoftService';
import { OccSweepService }      from './OccSweepService';
import { OccBooleanService }    from './OccBooleanService';
import { OccFilletService }     from './OccFilletService';
import { OccThickSolidService } from './OccThickSolidService';
import { OccExtrusionService }  from './OccExtrusionService';
import { OccSurfaceService }    from './OccSurfaceService';
import { OccSketchService }     from './OccSketchService';
import { OccDatumService }      from './OccDatumService';
import { OccFaceService }       from './OccFaceService';
import { OccEdgeService }       from './OccEdgeService';
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

  // Revolve — one profile wire, axis index + angle. With surface=1 the wire is
  // revolved directly into a zero-thickness shell (no capped face) — same flag-on-
  // shared-type convention as surface loft (bodyType:'surface' is set on the node).
  revolve: (oc, inputs, p) => {
    const prof = firstRole(inputs, 'profile') ?? inputs[0];
    if (!prof) throw new Error('revolve: no profile input');
    const axis = AXIS_VEC[clampIdx(num(p, 'axis', 1), 2)];
    const angle = num(p, 'angle', 360);
    return num(p, 'surface', 0) >= 0.5
      ? OccRevolutionService.revolveSurface(oc, prof.shape, [0, 0, 0], axis, angle)
      : OccRevolutionService.revolveProfile(oc, prof.shape, [0, 0, 0], axis, angle);
  },

  // Loft — ≥2 profile wires (order preserved), solid/ruled flags.
  loft: (oc, inputs, p) => {
    const profiles = byRole(inputs, 'profile');
    const wires = (profiles.length ? profiles : inputs).map((i) => i.shape);
    if (wires.length < 2) throw new Error('loft: needs ≥2 profiles');
    return OccLoftService.loftProfiles(oc, wires, num(p, 'solid', 1) >= 0.5, num(p, 'ruled', 0) >= 0.5);
  },

  // Surface extrude — one profile wire swept into a zero-thickness sheet (shell for
  // a closed profile, face for an open one). No caps. Direction + limits ride in
  // params (dir = the sketch-plane normal, captured at create so recompute replays
  // it deterministically). bodyType:'surface' is set on the node, not here.
  surfaceExtrude: (oc, inputs, p) => {
    const prof = firstRole(inputs, 'profile') ?? inputs[0];
    if (!prof) throw new Error('surfaceExtrude: no profile input');
    const dir = Array.isArray(p.dir) && p.dir.length === 3 ? p.dir as V3 : [0, 1, 0] as V3;
    const end = (['blind', 'symmetric', 'twoSided'] as const)[clampIdx(num(p, 'endMode', 0), 2)];
    return OccExtrusionService.extrudeSurface(oc, prof.shape, {
      height:    num(p, 'h', 20),
      end,
      height2:   num(p, 'h2', 10),
      reverse:   num(p, 'reverse', 0) >= 0.5,
      direction: dir,
    });
  },

  // Surface patch — fill ONE closed boundary loop with a zero-thickness sheet
  // (TopoDS_Face): planar loop → exact MakeFace, non-planar → MakeFilling. No knobs
  // beyond the profile; bodyType:'surface' is set on the node, not here.
  patch: (oc, inputs, _p) => {
    const prof = firstRole(inputs, 'profile') ?? inputs[0];
    if (!prof) throw new Error('patch: no profile input');
    return OccSurfaceService.patch(oc, prof.shape);
  },

  // Stitch — sew ≥2 surface bodies into a shell; solid=1 promotes a closed shell to
  // a solid. Result type (shell vs solid) is carried by the node's bodyType.
  stitch: (oc, inputs, p) => {
    const srcs = byRole(inputs, 'source');
    const shapes = (srcs.length ? srcs : inputs).map((i) => i.shape);
    if (shapes.length < 2) throw new Error('stitch: needs ≥2 surfaces');
    return OccSurfaceService.stitch(oc, shapes, num(p, 'solid', 1) >= 0.5);
  },

  // Thicken — offset one surface body into a solid; reverse=1 offsets the other side.
  thicken: (oc, inputs, p) => {
    const src = firstRole(inputs, 'base') ?? inputs[0];
    if (!src) throw new Error('thicken: no source surface');
    const t = num(p, 'thickness', 2);
    return OccSurfaceService.thicken(oc, src.shape, num(p, 'reverse', 0) >= 0.5 ? -t : t);
  },

  // Surface trim — cut a surface body (base) with a tool body (tool); keepInside=1
  // keeps the portion inside the tool (Common), else outside (Cut).
  surfaceTrim: (oc, inputs, p) => {
    const target = firstRole(inputs, 'base') ?? inputs[0];
    const tool   = firstRole(inputs, 'tool');
    if (!target) throw new Error('surfaceTrim: no target surface');
    if (!tool)   throw new Error('surfaceTrim: no trimming tool');
    return OccSurfaceService.trim(oc, target.shape, tool.shape, num(p, 'keepInside', 0) >= 0.5);
  },

  // Surface extend — grow a surface body's UV bounds by `distance`.
  surfaceExtend: (oc, inputs, p) => {
    const src = firstRole(inputs, 'base') ?? inputs[0];
    if (!src) throw new Error('surfaceExtend: no source surface');
    return OccSurfaceService.extend(oc, src.shape, num(p, 'distance', 5));
  },

  // Surface blend — tangent (G1) bridge between the two source surface bodies.
  // Optional explicit boundary-edge ordinals (edgeA/edgeB) pick the bridged pair;
  // null/absent ⇒ auto-nearest.
  surfaceBlend: (oc, inputs, p) => {
    const srcs = byRole(inputs, 'source');
    const shapes = (srcs.length ? srcs : inputs).map((i) => i.shape);
    if (shapes.length < 2) throw new Error('surfaceBlend: needs 2 surfaces');
    const ordA = typeof p.edgeA === 'number' ? p.edgeA : null;
    const ordB = typeof p.edgeB === 'number' ? p.edgeB : null;
    return OccSurfaceService.blend(oc, shapes[0], shapes[1], ordA, ordB);
  },

  // Solidify — cap a surface body's open boundaries + sew into a solid.
  solidify: (oc, inputs, _p) => {
    const src = firstRole(inputs, 'base') ?? inputs[0];
    if (!src) throw new Error('solidify: no source surface');
    return OccSurfaceService.solidify(oc, src.shape);
  },

  // Sweep — profile then spine (convention: index 0 = profile, spineIndex = spine).
  // surface=1 pipes the wire directly into a zero-thickness shell (no capped face);
  // the solid path caps the profile so the pipe encloses a solid.
  sweep: (oc, inputs, p) => {
    const ordered = byRole(inputs, 'profile');
    const list = ordered.length >= 2 ? ordered : inputs;
    const profile = list[0]?.shape;
    const spine   = list[clampIdx(num(p, 'spineIndex', 1), list.length - 1)]?.shape;
    if (!profile || !spine) throw new Error('sweep: needs a profile and a spine');
    return num(p, 'surface', 0) >= 0.5
      ? OccSweepService.sweepSurface(oc, profile, spine)
      : OccSweepService.sweepProfile(oc, profile, spine);
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

  // Shell / hollow — one base solid + open-face selection (faceRefs stable
  // signatures, faceIndices positional fallback) + a signed wall thickness.
  shell: (oc, inputs, p) => {
    const base = firstRole(inputs, 'base') ?? inputs[0];
    if (!base) throw new Error('shell: no source input');
    const faces = resolveShellFaces(oc, base.shape, p);
    if (!faces.length) throw new Error('shell: no open faces selected');
    const thickness = num(p, 'shellThickness', -2);
    return OccThickSolidService.createThickSolid(oc, base.shape, faces, thickness);
  },

  // Sketch wire — the leaf the whole graph hangs off. Two shapes:
  //   • entity wire: params.sketchGeom (line/circle/arc/polyline) → rebuild directly.
  //   • region wire: params.region — a closed profile traced from the sibling
  //     ENTITY inputs (role 'entity', each carrying meta.sketchGeom). The engine
  //     supplies the siblings; we re-detect the region so a moved entity reshapes it.
  sketchWire: (oc, inputs, p) => {
    // The parent 'sketch' container is a FRAME PRODUCER (step 4): when it sits on a
    // solid face it re-derives its workplane each recompute and the engine threads
    // the fresh frame in as a 'frame' input. Prefer it over the baked p.workplane so
    // the wire FOLLOWS the face; fall back to the baked frame (plane / legacy sketch).
    const wp = (firstRole(inputs, 'frame')?.meta?.workplane ?? p.workplane) as Workplane | undefined;
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
    // Keep id↔wire aligned (no filter-drop on shape until paired) so a region
    // selection persisted by outer-wire id can be mapped back to its shape.
    const profileInputs = (profiles.length ? profiles : inputs.filter((i) => !i.role || i.role === 'profile')).filter((i) => i.shape);
    const wires   = profileInputs.map((i) => i.shape);
    const wireIds = profileInputs.map((i) => i.id);
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
      const hitPoint = resolveTargetFacePoint(oc, base.shape, p);
      solid = OccExtrusionService.extrudeUpToFace(oc, wires, upTo, base.shape, hitPoint);
    } else if (endMode === 6) {                            // up-to-plane (datum)
      const pwp = firstRole(inputs, 'plane')?.meta?.workplane;
      if (!pwp) throw new Error('extrude up-to-plane: needs a datum plane input');
      solid = OccExtrusionService.extrudeUpToPlane(oc, wires, upTo, pwp.origin, pwp.normal);
    } else if (endMode === 4 || endMode === 5) {           // up-to-next / up-to-last
      const bodies = byRole(inputs, 'context').map((i) => i.shape);
      if (!bodies.length) throw new Error('extrude up-to-next/last: needs context bodies (engine-supplied)');
      solid = endMode === 4
        ? OccExtrusionService.extrudeUpToNext(oc, wires, upTo, bodies)
        : OccExtrusionService.extrudeUpToLast(oc, wires, upTo, bodies);
    } else {                                               // blind / symmetric / twoSided
      const extrudeOpts = {
        height:       num(p, 'h', 20),
        end:          EXTRUDE_END[endMode] ?? 'blind',
        height2:      num(p, 'h2', 10),
        reverse,
        direction,
        draftAngle:   num(p, 'draft', 0),
        neutralPoint,
        thickness:    num(p, 'thick', 0),
      };
      // A Profile-picker selection (region outer-wire ids) extrudes EXACTLY those
      // regions (ring vs inner disk); without one, every region by even/odd nesting.
      const regionOuters = p.selectedRegionOuterIds as string[] | undefined;
      solid = regionOuters?.length
        ? OccExtrusionService.extrudeSelectedRegions(oc, wires, wireIds, regionOuters, extrudeOpts)
        : OccExtrusionService.extrudeProfiles(oc, wires, extrudeOpts);
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
  const edges = resolveBlendEdges(oc, base.shape, p);
  if (!edges.length) throw new Error(`${kind}: no edges selected`);
  const value = num(p, 'blendValue', 1);
  return kind === 'fillet'
    ? OccFilletService.filletEdges(oc, base.shape, edges, value)
    : OccFilletService.chamferEdges(oc, base.shape, edges, value);
}

/**
 * Map a shell's stored open-face selection onto face ordinals of the CURRENT
 * base. Mirrors resolveBlendEdges: prefer the stable FaceSig captured at pick
 * time (survives an upstream edit that renumbers faces), fall back to the stored
 * raw ordinal, drop a face only if neither resolves. Legacy nodes with no
 * `faceRefs` use the raw indices unchanged.
 */
export function resolveShellFaces(oc: any, baseShape: any, p: Record<string, any>): number[] {
  const raw: number[] = Array.isArray(p.faceIndices) ? p.faceIndices : [];
  const refs: any[]   = Array.isArray(p.faceRefs) ? p.faceRefs : [];
  if (!refs.length) return raw;                                   // legacy node — unchanged

  const out: number[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (ref && ref.kind === 'face') {
      const r = resolveFace(oc, baseShape, ref);
      if (!r.rejected && r.index >= 0) { out.push(r.index); continue; }
    }
    if (typeof raw[i] === 'number') out.push(raw[i]);             // fall back to stored ordinal
  }
  if (!out.length) throw new Error('shell: no open-face reference resolved on the updated body — re-select the faces');
  return [...new Set(out)];                                       // dedupe
}

/**
 * Map a blend's stored edge selection onto edge ordinals of the CURRENT base.
 *
 * Phase 1a stable references (docs/PARAMETRIC.md §6): `params.edgeRefs` holds a
 * geometric SIGNATURE per selected edge (captured at pick time), parallel to the
 * legacy positional `params.edgeIndices`. We resolve each signature against the
 * live base shape so a selection survives an upstream edit that RENUMBERS edges
 * (the index-shuffle case the raw ordinals get wrong). Resolution policy:
 *   • signature resolves confidently      → use the resolved ordinal (the win)
 *   • signature rejects (geometry moved /  → fall back to the stored raw ordinal
 *     ambiguous) but a raw index exists       (no regression vs. the legacy path)
 *   • neither                              → drop that edge
 * Throws only if NOTHING resolves (→ the feature errors instead of filleting an
 * empty set). Legacy nodes with no `edgeRefs` use the raw indices unchanged.
 */
export function resolveBlendEdges(oc: any, baseShape: any, p: Record<string, any>): number[] {
  const raw: number[] = Array.isArray(p.edgeIndices) ? p.edgeIndices : [];
  const refs: any[]   = Array.isArray(p.edgeRefs) ? p.edgeRefs : [];
  if (!refs.length) return raw;                                   // legacy node — unchanged

  const out: number[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (ref && ref.kind === 'edge') {
      const r = resolveEdge(oc, baseShape, ref);
      if (!r.rejected && r.index >= 0) { out.push(r.index); continue; }
    }
    if (typeof raw[i] === 'number') out.push(raw[i]);             // fall back to stored ordinal
  }
  if (!out.length) throw new Error('blend: no edge reference resolved on the updated body — re-select the edges');
  return [...new Set(out)];                                       // dedupe
}

/**
 * The hit point that selects the up-to-face target face on the CURRENT base.
 *
 * Stable-ref path (step 4): `params.targetFaceRef` is a FaceSig captured at pick
 * time. We resolve it against the live base and return that face's current
 * centroid, so the limit follows the target face across an upstream edit that
 * renumbers or moves it. On reject (or legacy nodes with no ref) we fall back to
 * the stored raw world point `params.targetFacePoint` — unchanged behaviour.
 */
export function resolveTargetFacePoint(
  oc: any, baseShape: any, p: Record<string, any>,
): [number, number, number] | undefined {
  const ref = p.targetFaceRef;
  if (ref && ref.kind === 'face') {
    const r = resolveFace(oc, baseShape, ref);
    if (!r.rejected && r.index >= 0) {
      const cur = captureFace(oc, baseShape, r.index);
      if (cur) return cur.centroid;
    }
  }
  return p.targetFacePoint;                                       // fallback (legacy / unresolved)
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
// from params. `evaluateDatum` re-derives that frame for the methods determined
// by their input frames + a scalar (offset / midplane) and, via StableRef
// signatures (step 4), the face/edge/vertex-resolved methods — all re-derived
// against the live body: `angle` (hinge face + edge), `tangent` (cylinder axis +
// radius), `threePoint` (each picked vertex), `normalToCurve` (edge re-sampled at
// its arc-length fraction), `twoEdges` (both edges re-sampled). datum_axis
// (edge / cylinder) and datum_point (vertex / edge-midpoint) likewise re-derive
// their axis/point from the captured signature. On any reject the branch falls
// through to the baked frame (`p.workplane` / `p.axis` / `p.point`). Body moves
// are handled rigidly by recomputeDatums.computeDatumUpdates (D13).

export type DatumFrame =
  | { kind: 'plane'; workplane: Workplane }
  | { kind: 'axis';  axis: { origin: V3; dir: V3 } }
  | { kind: 'point'; point: V3 };

/** Re-derive a planar face's workplane on `bodyShape` by resolving the captured
 *  face signature (step 4). Returns null if the face can't be confidently found
 *  (→ caller falls back to the baked frame) or isn't planar. */
function deriveFaceWorkplane(oc: any, bodyShape: any, faceSig: StableRef): Workplane | null {
  const r = resolveFace(oc, bodyShape, faceSig as any);
  if (r.rejected || r.index < 0) return null;
  const pl = OccFaceService.planeFromFaceIndex(oc, bodyShape, r.index);
  return pl ? { label: 'Face', origin: pl.origin, normal: pl.normal, uAxis: pl.uAxis, vAxis: pl.vAxis } : null;
}

/** Re-derive a hinge axis (a point on the line + its direction) on `bodyShape` by
 *  resolving the captured edge signature (step 4). Re-captures the resolved edge so
 *  the returned point/dir are the edge's CURRENT geometry — `mid` is a point on the
 *  line, which is all `planeAtAngle` needs. Null if the edge can't be confidently
 *  resolved or isn't a line. */
function resolveEdgeAxis(oc: any, bodyShape: any, edgeSig: EdgeSig): { point: V3; dir: V3 } | null {
  const r = resolveEdge(oc, bodyShape, edgeSig);
  if (r.rejected || r.index < 0) return null;
  const cur = captureEdge(oc, bodyShape, r.index);
  return cur?.axis ? { point: cur.mid, dir: cur.axis } : null;
}

/** Re-derive a cylindrical face's axis + radius on `bodyShape` by resolving the
 *  captured face signature (step 4, tangent datum). `axisPoint` is the resolved
 *  face's centroid — on the axis for a full cylinder — which is all
 *  `tangentPlaneToCylinder` needs (any point on the axis). The axis sign is
 *  aligned to the captured signature so radial reconstruction stays consistent.
 *  Null if the face can't be confidently resolved or isn't a cylinder. */
function resolveCylinderAxis(oc: any, bodyShape: any, sig: FaceSig): { axisPoint: V3; axisDir: V3; radius: number } | null {
  const r = resolveFace(oc, bodyShape, sig);
  if (r.rejected || r.index < 0) return null;
  const cur = captureFace(oc, bodyShape, r.index);
  if (!cur || cur.surf !== 'cylinder' || !cur.axis || cur.radius == null) return null;
  let dir = cur.axis;
  if (sig.axis && (dir[0] * sig.axis[0] + dir[1] * sig.axis[1] + dir[2] * sig.axis[2]) < 0) dir = [-dir[0], -dir[1], -dir[2]];
  return { axisPoint: cur.centroid, axisDir: dir, radius: cur.radius };
}

/** Re-sample a captured edge's polyline on `bodyShape` (step 4, curve-normal /
 *  two-edges datums). `resolveEdge`'s ordinal indexes the same deduped EDGE map
 *  `OccEdgeService.extractEdges` builds, so the resolved index maps straight back
 *  to the live edge's points. Null if the edge can't be confidently resolved. */
function resolveEdgePolyline(oc: any, bodyShape: any, sig: EdgeSig): V3[] | null {
  const r = resolveEdge(oc, bodyShape, sig);
  if (r.rejected || r.index < 0) return null;
  const e = OccEdgeService.extractEdges(oc, bodyShape).find((x: any) => x.index === r.index);
  return e ? (e.points as V3[]) : null;
}

export function evaluateDatum(
  oc: any, datumType: string, inputs: ResolvedInput[], params: Record<string, any>,
): DatumFrame | null {
  const p = params ?? {};
  if (datumType === 'datum_plane') {
    const m = p.method;
    if (m === 'offset') {
      const r0 = p.refs?.[0];
      const dist = Number(r0?.distance ?? p.distance ?? 0);
      // Base frame to offset from. A DATUM source already follows via its
      // meta.workplane. A FACE source has no workplane in meta — re-derive it by
      // resolving the captured face signature against the live body (step 4), so
      // the offset datum tracks the face instead of using its baked-at-creation
      // frame. On reject (face moved too far / gone) → fall through to passthrough.
      let base = inputs[0]?.meta?.workplane as Workplane | undefined;
      if (!base && r0?.sel?.kind === 'face') {
        const src = inputs.find((i) => i.id === r0.nodeId) ?? inputs[0];
        if (src?.shape) base = deriveFaceWorkplane(oc, src.shape, r0.sel) ?? undefined;
      }
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
    } else if (m === 'threePoint') {
      const refs = (p.refs as any[]) ?? [];
      const sigRefs = refs.filter((r) => r?.sel?.kind === 'vertex');
      if (sigRefs.length >= 3) {
        // Vertex-signature path (step 4): re-resolve every picked vertex on its
        // live source body so the plane FOLLOWS edits. All-or-nothing — if any
        // vertex can't resolve, fall through to the baked workplane (a mix of
        // live + stale corners would build a wrong plane).
        const pts: V3[] = [];
        let ok = true;
        for (const r of refs) {
          const src = inputs.find((x) => x.id === r?.nodeId);
          let pt: V3 | undefined;
          if (r?.sel?.kind === 'vertex' && src?.shape) {
            const rr = resolveVertex(oc, src.shape, r.sel);
            if (!rr.rejected && rr.index >= 0) { const cur = captureVertex(oc, src.shape, rr.index); if (cur) pt = cur.pos; }
          }
          if (!pt) { ok = false; break; }
          pts.push(pt);
        }
        if (ok && pts.length >= 3) { const wp = OccDatumService.planeFrom3Points(oc, pts[0], pts[1], pts[2]); if (wp) return { kind: 'plane', workplane: wp }; }
      } else {
        // Legacy / datum-point sources expose their frame point via meta.point.
        const pts = inputs.map((i) => i.meta?.point as V3 | undefined).filter((x): x is V3 => !!x);
        if (pts.length >= 3) { const wp = OccDatumService.planeFrom3Points(oc, pts[0], pts[1], pts[2]); if (wp) return { kind: 'plane', workplane: wp }; }
      }
    } else if (m === 'tangent') {
      // Re-derive the cylinder's live axis + radius and rebuild the tangent plane
      // at the same angular position (the captured hit's radial direction). Follows
      // translation + radius change; rotation about the cylinder's own axis is the
      // §6 Phase 1a limit. Reject (or legacy node) → baked `p.workplane`.
      const r0 = p.refs?.[0];
      const hit = r0?.point as V3 | undefined;
      if (r0?.sel?.kind === 'face' && r0.sel.surf === 'cylinder' && Array.isArray(hit)) {
        const src = inputs.find((i) => i.id === r0.nodeId) ?? inputs[0];
        const live = src?.shape ? resolveCylinderAxis(oc, src.shape, r0.sel) : null;
        if (live) {
          const c0 = r0.sel.centroid, d0 = r0.sel.axis ?? [0, 0, 1];
          const rel = [hit[0] - c0[0], hit[1] - c0[1], hit[2] - c0[2]];
          const t = rel[0] * d0[0] + rel[1] * d0[1] + rel[2] * d0[2];
          let rh = [rel[0] - t * d0[0], rel[1] - t * d0[1], rel[2] - t * d0[2]];
          const rl = Math.hypot(rh[0], rh[1], rh[2]);
          if (rl > 1e-9) {
            rh = [rh[0] / rl, rh[1] / rl, rh[2] / rl];
            const np: V3 = [live.axisPoint[0] + live.radius * rh[0], live.axisPoint[1] + live.radius * rh[1], live.axisPoint[2] + live.radius * rh[2]];
            const wp = OccDatumService.tangentPlaneToCylinder(oc, np, live.axisPoint, live.axisDir);
            if (wp) return { kind: 'plane', workplane: wp };
          }
        }
      }
    } else if (m === 'normalToCurve') {
      // Re-sample the captured edge on the live body and rebuild the plane normal
      // to it at the stored arc-length fraction → follows the edge. Reject (or a
      // legacy node with no signature) → baked `p.workplane`.
      const r0 = p.refs?.[0];
      const f = Number(r0?.fraction ?? p.fraction ?? 0.5);
      if (r0?.sel?.kind === 'edge') {
        const src = inputs.find((i) => i.id === r0.nodeId) ?? inputs[0];
        const pts = src?.shape ? resolveEdgePolyline(oc, src.shape, r0.sel) : null;
        if (pts) { const wp = OccDatumService.planeNormalToPath(oc, pts, f); if (wp) return { kind: 'plane', workplane: wp }; }
      }
    } else if (m === 'twoEdges') {
      // Re-sample both captured edges on their live bodies and rebuild the plane
      // through their endpoints → follows edits. Either edge rejecting (or a legacy
      // node) → baked `p.workplane`. refs[0]=A, refs[1]=B (planeThrough2Edges order).
      const refs = (p.refs as any[]) ?? [];
      const a = refs[0], b = refs[1];
      if (a?.sel?.kind === 'edge' && b?.sel?.kind === 'edge') {
        const srcA = inputs.find((i) => i.id === a.nodeId);
        const srcB = inputs.find((i) => i.id === b.nodeId);
        const ptsA = srcA?.shape ? resolveEdgePolyline(oc, srcA.shape, a.sel) : null;
        const ptsB = srcB?.shape ? resolveEdgePolyline(oc, srcB.shape, b.sel) : null;
        if (ptsA && ptsB) { const wp = OccDatumService.planeThrough2Edges(oc, ptsA, ptsB); if (wp) return { kind: 'plane', workplane: wp }; }
      }
    } else if (m === 'angle') {
      // Re-derive the angled plane from signatures so it FOLLOWS the source body:
      // resolve the hinge FACE → its current plane, resolve the hinge EDGE → its
      // current axis, then re-rotate (OccDatumService.planeAtAngle). The angle is
      // stored on the ref. Either signature rejecting (or a legacy node with no
      // signatures) → fall through to the baked `p.workplane`.
      const r0 = p.refs?.[0];
      const angle = Number(r0?.angle ?? p.angle ?? 0);
      if (r0?.sel?.kind === 'face' && r0?.edgeSel?.kind === 'edge') {
        const src = inputs.find((i) => i.id === r0.nodeId) ?? inputs[0];
        if (src?.shape) {
          const faceWp = deriveFaceWorkplane(oc, src.shape, r0.sel);
          const hinge  = resolveEdgeAxis(oc, src.shape, r0.edgeSel);
          if (faceWp && hinge) {
            const wp = OccDatumService.planeAtAngle(oc, faceWp.origin, faceWp.normal, hinge.point, hinge.dir, angle);
            if (wp) return { kind: 'plane', workplane: wp };
          }
        }
      }
    }
    if (p.workplane) return { kind: 'plane', workplane: p.workplane };   // pass-through
  }
  if (datumType === 'datum_axis') {
    // Re-derive the axis from the captured edge / cylindrical face on the live
    // body so it FOLLOWS edits; reject (or legacy node with no sig) → baked `axis`.
    const r0 = p.refs?.[0];
    const src = r0?.sel ? (inputs.find((i) => i.id === r0.nodeId) ?? inputs[0]) : undefined;
    if (src?.shape) {
      if (p.method === 'edge' && r0.sel.kind === 'edge') {
        const h = resolveEdgeAxis(oc, src.shape, r0.sel);
        if (h) return { kind: 'axis', axis: { origin: h.point, dir: h.dir } };
      } else if (p.method === 'cylinder' && r0.sel.kind === 'face') {
        const live = resolveCylinderAxis(oc, src.shape, r0.sel);
        if (live) return { kind: 'axis', axis: { origin: live.axisPoint, dir: live.axisDir } };
      }
    }
    if (p.axis) return { kind: 'axis', axis: p.axis };
  }
  if (datumType === 'datum_point') {
    // Re-derive the point from the captured vertex / edge-midpoint on the live
    // body so it FOLLOWS edits; reject (or legacy node with no sig) → baked `point`.
    const r0 = p.refs?.[0];
    const src = r0?.sel ? (inputs.find((i) => i.id === r0.nodeId) ?? inputs[0]) : undefined;
    if (src?.shape) {
      if (p.method === 'vertex' && r0.sel.kind === 'vertex') {
        const rr = resolveVertex(oc, src.shape, r0.sel);
        if (!rr.rejected && rr.index >= 0) { const cur = captureVertex(oc, src.shape, rr.index); if (cur) return { kind: 'point', point: cur.pos }; }
      } else if (p.method === 'edgeMid' && r0.sel.kind === 'edge') {
        const pts = resolveEdgePolyline(oc, src.shape, r0.sel);
        if (pts && pts.length) return { kind: 'point', point: pts[Math.floor(pts.length / 2)] };
      }
    }
    if (p.point) return { kind: 'point', point: p.point };
  }
  return null;
}

/** A sketch created on a solid FACE is a FRAME PRODUCER (step 4), like a datum:
 *  re-derive its workplane from the captured face signature against the live
 *  source body so the sketch — and everything built on it — FOLLOWS the face
 *  instead of using the frame baked at creation. `params.sourceFaceRef =
 *  { nodeId, sel }` carries the FaceSig; `inputs` holds the resolved source body
 *  (role 'source'). Rejects (face moved too far / gone) or a plane/legacy sketch
 *  with no signature → fall back to the baked `params.workplane`. Returns null
 *  only when there is no frame at all (caller leaves the wires on their baked wp). */
export function evaluateSketchFrame(
  oc: any, inputs: ResolvedInput[], params: Record<string, any>,
): DatumFrame | null {
  const p = params ?? {};
  const ref = p.sourceFaceRef as { nodeId?: string; sel?: StableRef } | undefined;
  if (ref?.sel?.kind === 'face') {
    const src = inputs.find((i) => i.id === ref.nodeId) ?? firstRole(inputs, 'source') ?? inputs[0];
    if (src?.shape) {
      const wp = deriveFaceWorkplane(oc, src.shape, ref.sel);
      if (wp) return { kind: 'plane', workplane: { ...wp, label: (p.workplane as Workplane | undefined)?.label ?? 'Face' } };
    }
  }
  if (p.workplane) return { kind: 'plane', workplane: p.workplane as Workplane };   // baked fallback
  return null;
}
