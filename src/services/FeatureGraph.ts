// ============================================================
// ToubkalCAD – FeatureGraph.ts   (Phase 1, build-order step 1)
//
// The normalized parametric model: one Feature per geometry-producing CADNode,
// with EXPLICIT inputs (the DAG edges) derived from today's scattered node.params
// via an adapter. This is READ-ONLY over the existing store — it builds nothing,
// mutates nothing, changes no behavior. It's the substrate the recompute engine
// (step 3) will consume. See docs/PARAMETRIC.md.
//
// Crucial design rule: anything that points at geometry is an INPUT (a graph
// edge), never a raw id buried in params — so the graph is derivable from
// `inputs` alone. `params` holds value-only knobs.
//
// `complete` flags whether a node's recipe was fully recoverable. It's false for
// creation paths that don't yet persist a recipe (primitives / mirror / pattern /
// Ribbon-built revolve+loft go through Ribbon.create(), which stores no params).
// That gap is real and must be closed (param capture) before those features can
// be replayed — surfacing it is the point of this step.
// ============================================================

import type { CADNode, NodeType } from '../store/cadStore';
import type { StableRef } from './StableRef';

export type FeatureOp =
  | 'box' | 'cylinder' | 'sphere' | 'torus' | 'cone'
  | 'sketch' | 'sketchWire'
  | 'extrude' | 'revolve' | 'loft' | 'sweep'
  | 'surfaceExtrude' | 'patch' | 'stitch' | 'thicken' | 'surfaceTrim' | 'surfaceExtend' | 'surfaceBlend' | 'solidify'
  | 'boolean' | 'fillet' | 'chamfer' | 'shell'
  | 'mirror' | 'pattern'
  | 'datumPlane' | 'datumAxis' | 'datumPoint'
  | 'imported' | 'unknown';

export interface FeatureRef {
  /** Upstream feature id (a DAG edge). */
  id:    string;
  /** What this input plays: 'profile' | 'base' | 'tool' | 'plane' | 'ref' | 'bind'. */
  role?: string;
  /** Optional sub-entity selection (a face/edge). Populated in step 4 — for now
   *  legacy positional selections (edgeIndices, facePoint) stay in `params`. */
  sel?:  StableRef;
}

export interface Feature {
  id:      string;
  op:      FeatureOp;
  inputs:  FeatureRef[];
  params:  Record<string, any>;
  /** Recipe fully recoverable from the node? false → needs param capture (see header). */
  complete: boolean;
  /** Feature is skipped during recompute (kept in the tree). */
  suppressed?: boolean;
  /** Last recompute failure (set by RecomputeEngine), surfaced in the tree. null = ok. */
  error?:  string | null;
  /** Human note on why incomplete / what's missing. */
  note?:   string;
}

export interface FeatureGraph {
  features: Record<string, Feature>;
  /** Topological order, upstream → downstream. Excludes nodes stuck in cycles. */
  order:    string[];
  /** Features with no (resolvable) inputs. */
  roots:    string[];
  /** Any cycle members found (should be empty for a valid DAG). */
  cycles:   string[];
}

// ─── Adapter: CADNode → Feature ───────────────────────────────────────────────

const NTYPE_TO_OP: Partial<Record<NodeType, FeatureOp>> = {
  box: 'box', cylinder: 'cylinder', sphere: 'sphere',
  sketch: 'sketch', sketch_wire: 'sketchWire',
  extrusion: 'extrude', revolve: 'revolve', loft: 'loft', sweep: 'sweep',
  surface_extrude: 'surfaceExtrude', surface_patch: 'patch',
  surface_stitch: 'stitch', surface_thicken: 'thicken', surface_trim: 'surfaceTrim',
  surface_extend: 'surfaceExtend', surface_blend: 'surfaceBlend', surface_solidify: 'solidify',
  boolean_operation: 'boolean',
  mirror: 'mirror', pattern: 'pattern',
  datum_plane: 'datumPlane', datum_axis: 'datumAxis', datum_point: 'datumPoint',
  // 'compound' is fillet OR chamfer — disambiguated below via params.blendOp.
};

const refOf = (id: any, role: string): FeatureRef | null =>
  typeof id === 'string' && id ? { id, role } : null;

/** Derive a normalized Feature from one CADNode (no geometry, pure metadata). */
export function nodeToFeature(node: CADNode): Feature {
  const p = node.params ?? {};
  const inputs: FeatureRef[] = [];
  let op: FeatureOp = NTYPE_TO_OP[node.type] ?? 'unknown';
  let params: Record<string, any> = {};
  let complete = true;
  let note: string | undefined;

  switch (node.type) {
    case 'box': case 'cylinder': case 'sphere': {
      // Primitives carry no inputs; their dimensions now ride in params.
      params = { ...p };
      if (!hasAny(p, ['w', 'h', 'd', 'r', 'radius', 'height'])) { complete = false; note = 'no stored dimensions'; }
      break;
    }

    case 'sketch':
      params = pick(p, ['workplane', 'sourceFaceRef']);
      // A sketch created ON A FACE follows it (step 4): the source body becomes an
      // input and `sourceFaceRef` carries the FaceSig the engine re-derives the
      // frame from. A plane/datum sketch has neither → stays inert (no frame).
      if (p.sourceFaceRef?.nodeId) push(inputs, refOf(p.sourceFaceRef.nodeId, 'source'));
      complete = !!p.workplane;
      break;

    case 'sketch_wire':
      params = pick(p, ['workplane', 'sketchGeom', 'region', 'regionArea', 'constraints', 'memberIds']);
      // Depend on the parent sketch CONTAINER as a 'frame' input (step 4): the
      // engine orders it first and threads its workplane — re-derived when the
      // sketch is on a face, the baked one otherwise — into this wire's meta.
      push(inputs, refOf(node.parentId, 'frame'));
      // Entity wire = sketchGeom (no further inputs). Region wire = a profile traced
      // from its member entities → those are inputs (the DAG edge so a moved entity
      // reshapes the region).
      if (p.region) for (const mid of (p.memberIds as string[] | undefined) ?? []) push(inputs, refOf(mid, 'entity'));
      complete = !!p.sketchGeom || (!!p.region && Array.isArray(p.memberIds) && p.memberIds.length > 0);
      if (!complete) note = p.region ? 'region wire has no member entities' : 'no 2D recipe (sketchGeom/region)';
      break;

    case 'extrusion': case 'revolve': case 'loft': case 'sweep': case 'surface_extrude': case 'surface_patch': {
      if (p.opType || p.targetWireIds) {
        // Op3DPanel path — full recipe.
        op = (p.opType as FeatureOp) ?? op;
        for (const w of (p.targetWireIds as string[] | undefined) ?? []) push(inputs, refOf(w, 'profile'));
        push(inputs, refOf(p.targetSolidId, 'base'));     // pad/pocket boolean target (E2/E5)
        push(inputs, refOf(p.targetDatumId, 'plane'));    // up-to-datum limit
        // opParams hold the value knobs; the up-to-face target selection lives in
        // top-level node params — carry it through so the op replays (targetFaceRef
        // is the step-4 stable signature, targetFacePoint the positional fallback).
        params = { ...(p.opParams ?? {}), targetFacePoint: p.targetFacePoint, targetFaceRef: p.targetFaceRef };
        complete = inputs.some((i) => i.role === 'profile');
        if (!complete) note = 'no profile input';
      } else {
        // Ribbon.create path (e.g. revolve/loft) — recipe not persisted.
        params = { ...p };
        complete = false;
        note = 'created without a persisted recipe (Ribbon.create)';
      }
      break;
    }

    case 'surface_stitch':
      // Sew ≥2 existing surface bodies → shell (solid if closed). Inputs are body
      // ids (role 'source'), like boolean's base/tool but symmetric.
      op = 'stitch';
      for (const s of (p.sourceIds as string[] | undefined) ?? []) push(inputs, refOf(s, 'source'));
      params = { ...(p.opParams ?? {}) };
      complete = Array.isArray(p.sourceIds) && p.sourceIds.length >= 2;
      if (!complete) note = 'stitch needs ≥2 source bodies';
      break;

    case 'surface_thicken':
      // Offset one surface body → solid.
      op = 'thicken';
      push(inputs, refOf(p.sourceId, 'base'));
      params = { ...(p.opParams ?? {}) };
      complete = !!p.sourceId;
      if (!complete) note = 'missing source body';
      break;

    case 'surface_trim':
      // Trim a surface body (base) by a tool body (tool); keepInside in opParams.
      op = 'surfaceTrim';
      push(inputs, refOf(p.sourceId, 'base'));
      push(inputs, refOf(p.toolId, 'tool'));
      params = { ...(p.opParams ?? {}) };
      complete = !!p.sourceId && !!p.toolId;
      if (!complete) note = 'trim needs a surface and a tool body';
      break;

    case 'surface_extend':
      // Grow one surface body's UV bounds; distance in opParams.
      op = 'surfaceExtend';
      push(inputs, refOf(p.sourceId, 'base'));
      params = { ...(p.opParams ?? {}) };
      complete = !!p.sourceId;
      if (!complete) note = 'missing source body';
      break;

    case 'surface_blend':
      // Tangent bridge between two surface bodies (symmetric — both 'source').
      op = 'surfaceBlend';
      for (const s of (p.sourceIds as string[] | undefined) ?? []) push(inputs, refOf(s, 'source'));
      params = { ...(p.opParams ?? {}) };
      complete = Array.isArray(p.sourceIds) && p.sourceIds.length >= 2;
      if (!complete) note = 'blend needs 2 source bodies';
      break;

    case 'surface_solidify':
      // Cap + sew one surface body into a solid.
      op = 'solidify';
      push(inputs, refOf(p.sourceId, 'base'));
      params = { ...(p.opParams ?? {}) };
      complete = !!p.sourceId;
      if (!complete) note = 'missing source body';
      break;

    case 'boolean_operation':
      op = 'boolean';
      push(inputs, refOf(p.baseId, 'base'));
      for (const t of (p.toolIds as string[] | undefined) ?? []) push(inputs, refOf(t, 'tool'));
      params = pick(p, ['boolOp']);
      complete = !!p.baseId && Array.isArray(p.toolIds) && p.toolIds.length > 0;
      if (!complete) note = 'missing base/tool inputs';
      break;

    case 'compound': {
      // 'compound' is overloaded: shell, fillet/chamfer, torus/cone primitives, or import.
      if (p.shellOp) {
        op = 'shell';
        push(inputs, refOf(p.sourceId, 'base'));
        // faceRefs: stable face signatures (step 4); faceIndices: positional fallback.
        params = pick(p, ['faceIndices', 'faceRefs', 'shellThickness', 'shellOp']);
        complete = !!p.sourceId;
        if (!complete) note = 'missing source input';
      } else if (p.blendOp || p.sourceId) {
        op = (p.blendOp as FeatureOp) === 'chamfer' ? 'chamfer' : 'fillet';
        push(inputs, refOf(p.sourceId, 'base'));
        // edgeRefs: Phase 1a stable signatures (step 4); edgeIndices: legacy
        // positional fallback. The evaluator prefers refs, falls back to indices.
        params = pick(p, ['edgeIndices', 'edgeRefs', 'blendValue', 'blendOp']);
        complete = !!p.sourceId;
        if (!complete) note = 'missing source input';
      } else if (p.featureOp === 'torus' || p.featureOp === 'cone') {
        op = p.featureOp;
        params = { ...p };
        complete = true;
      } else {
        op = 'imported';   // STEP/IGES import — geometry has no parametric recipe
        params = { ...p };
        complete = false;
        note = 'imported geometry — no parametric recipe';
      }
      break;
    }

    case 'mirror':
      push(inputs, refOf(p.sourceId, 'source'));
      params = pick(p, ['plane']);
      complete = !!p.sourceId;
      if (!complete) note = 'missing source input';
      break;

    case 'pattern':
      push(inputs, refOf(p.sourceId, 'source'));
      params = pick(p, ['mode', 'axis', 'spacing', 'angle', 'count']);
      complete = !!p.sourceId;
      if (!complete) note = 'missing source input';
      break;

    case 'datum_plane': case 'datum_axis': case 'datum_point': {
      for (const r of (p.refs as any[] | undefined) ?? []) push(inputs, refOf(r?.nodeId, r?.kind ?? 'ref'));
      push(inputs, refOf(p.bind?.id, 'bind'));            // D13 rigid follow
      // Carry `refs` so the datum recipe replays: refs[].distance is the offset
      // value (was being DROPPED → offset replayed as 0) and refs[].sel is the
      // step-4 face signature evaluateDatum resolves to re-derive the base frame.
      params = pick(p, ['workplane', 'axis', 'point', 'method', 'datum', 'refs']);
      complete = !!(p.workplane || p.axis || p.point);
      break;
    }

    default:
      params = { ...p };
      complete = false;
      note = `unmapped node type '${node.type}'`;
  }

  return { id: node.id, op, inputs, params, complete, note };
}

// ─── Graph build + algorithms ─────────────────────────────────────────────────

/** Build the feature graph from the store's nodes map (read-only). */
export function buildFeatureGraph(nodes: Record<string, CADNode>): FeatureGraph {
  const features: Record<string, Feature> = {};
  const ids = Object.keys(nodes);   // insertion order → deterministic
  for (const id of ids) features[id] = nodeToFeature(nodes[id]);

  // Flag dangling inputs (point at a non-existent feature) and drop them from edges.
  for (const id of ids) {
    const f = features[id];
    const dangling = f.inputs.filter((i) => !features[i.id]);
    if (dangling.length) {
      f.complete = false;
      f.note = (f.note ? f.note + '; ' : '') + `dangling input(s): ${dangling.map((d) => d.id.slice(0, 6)).join(',')}`;
    }
  }

  const { order, cycles } = topoSort(features, ids);
  const roots = ids.filter((id) => resolvableInputs(features, id).length === 0);
  return { features, order, roots, cycles };
}

/** Inputs that point at an existing feature (edges that actually constrain order). */
function resolvableInputs(features: Record<string, Feature>, id: string): FeatureRef[] {
  return features[id].inputs.filter((i) => !!features[i.id]);
}

/** Kahn topological sort. Returns the order and any nodes trapped in cycles. */
export function topoSort(features: Record<string, Feature>, ids: string[]): { order: string[]; cycles: string[] } {
  const indeg: Record<string, number> = {};
  const adj:   Record<string, string[]> = {};
  for (const id of ids) { indeg[id] = 0; adj[id] = []; }
  for (const id of ids) {
    for (const inp of resolvableInputs(features, id)) {
      adj[inp.id].push(id);   // upstream → downstream
      indeg[id]++;
    }
  }
  const queue = ids.filter((id) => indeg[id] === 0);   // stable order
  const order: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj[u]) if (--indeg[v] === 0) queue.push(v);
  }
  const cycles = ids.filter((id) => indeg[id] > 0);    // never reached indeg 0
  return { order, cycles };
}

/** All features transitively downstream of `id` (the dirty set for a re-edit). */
export function descendants(graph: FeatureGraph, id: string): Set<string> {
  const adj: Record<string, string[]> = {};
  for (const fid of Object.keys(graph.features)) adj[fid] = [];
  for (const fid of Object.keys(graph.features)) {
    for (const inp of graph.features[fid].inputs) if (graph.features[inp.id]) adj[inp.id].push(fid);
  }
  const out = new Set<string>();
  const stack = [...(adj[id] ?? [])];
  while (stack.length) {
    const v = stack.pop()!;
    if (out.has(v)) continue;
    out.add(v);
    for (const w of adj[v]) stack.push(w);
  }
  return out;
}

/** dirty set = the edited feature + everything downstream. */
export function dirtySet(graph: FeatureGraph, id: string): Set<string> {
  const d = descendants(graph, id);
  d.add(id);
  return d;
}

// ─── small helpers ────────────────────────────────────────────────────────────
function push<T>(arr: T[], v: T | null): void { if (v) arr.push(v); }
function pick(o: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
function hasAny(o: Record<string, any>, keys: string[]): boolean {
  return keys.some((k) => o[k] !== undefined);
}
