// ============================================================
// ToubkalCAD – RecomputeEngine.ts   (Phase 1, build-order step 3)
//
// The dependency-graph replay engine. Walks the FeatureGraph in topological
// order, resolves each feature's inputs to live (placed) shapes, runs its pure
// EVALUATOR, registers the result, and notifies the viewport. This is what turns
// the static recipe (steps 1–2) into a parametric model: edit an upstream
// feature and everything downstream rebuilds. See docs/PARAMETRIC.md §4.
//
// Design split (mirrors the rest of Phase 1):
//   • `recompute(host, graph, opts)` — the PURE engine. It owns no React state,
//     no registry, no CustomEvents. Everything side-effecting is injected via a
//     `RecomputeHost`, so the whole engine is exercisable headlessly with a Map-
//     backed mock host + the real kernel (scripts/test-recompute.mjs).
//   • `liveHost()` — the production host wired to CADGeometryRegistry, the store
//     (placement + meta), and the cad-*-mesh event bus.
//   • `recomputeFromStore(editedId?)` — the one call sites use: build the graph
//     from the store, compute the dirty set, replay.
//
// What it does (per docs/PARAMETRIC.md §4):
//   - topo order, upstream → downstream (from FeatureGraph.order)
//   - dirty propagation: only the edited feature + its descendants recompute;
//     clean features reuse their cached shape (cheap drags on big models)
//   - rollback: evaluate up to & including `rollbackId`, free everything after
//     (the timeline needle — payoff lands in step 6, the engine supports it now)
//   - errors are caught per-feature: mark `feature.error`, keep the last-good
//     shape so downstream still has an input, and KEEP GOING
//   - datums produce a reference FRAME (not a shape); the frame is threaded to
//     downstream features within the pass via a meta override and (live) written
//     back to the node so the viewport + persistence see it
// ============================================================

import type { FeatureGraph, Feature, FeatureRef, FeatureOp } from './FeatureGraph';
import {
  EVALUATORS, evaluateDatum, evaluateSketchFrame, ResolvedInput, DatumFrame,
} from './FeatureEvaluators';

// ─── Host: the injected boundary to registry / store / viewport ───────────────

export interface RecomputeHost {
  /** The OpenCascade kernel. */
  oc: any;
  /** Current output shape for a feature (origin pose), or undefined. */
  getShape(id: string): any | undefined;
  /** Register/replace a feature's output shape (host frees the previous one). */
  setShape(id: string, shape: any): void;
  /** Free + forget a feature's shape (suppress / rollback past it). */
  freeShape(id: string): void;
  /** Bake the node's placement into `shape`. MUST return the SAME reference for
   *  an identity placement (so the engine knows not to free a registry shape),
   *  and a NEW shape otherwise (which the engine frees after the evaluator runs). */
  place(id: string, shape: any): any;
  /** Static, non-geometry metadata an evaluator needs — the node's `params`
   *  (workplane / sketchGeom / point). Datum frames recomputed this pass override it. */
  meta(id: string): Record<string, any> | undefined;
  /** Build a SKETCH container's current profile wire (largest closed region) from
   *  its live entities — a fresh temporary the engine frees after the evaluator
   *  runs. Lets a feature bind to a sketch and re-derive its profile each recompute
   *  (survives entity move/resize/delete/replace). Undefined → can't resolve. */
  profileWire?(sketchId: string): any | undefined;
  /** A feature's shape was (re)computed → viewport should add or update it. */
  onChanged?(id: string): void;
  /** A feature's shape was freed (suppress / rollback) → viewport should remove it. */
  onRemoved?(id: string): void;
  /** A datum's reference frame was recomputed → persist it (live host writes the
   *  node params so the viewport + downstream meta + save see the new frame). */
  onFrame?(id: string, frame: DatumFrame): void;
}

export interface RecomputeOptions {
  /** Incremental: only (re)compute these ids; clean+cached features are reused.
   *  Omit to force a full rebuild of the whole graph. */
  dirty?: Set<string>;
  /** Timeline needle: evaluate the topo order up to & including this feature,
   *  free everything after it. Omit / null → evaluate the whole graph. */
  rollbackId?: string | null;
}

export type FeatureStatus =
  | 'ok'          // evaluated, shape registered
  | 'frame'       // datum frame recomputed (no shape)
  | 'cached'      // clean + cached → reused, not recomputed
  | 'suppressed'  // feature.suppressed → freed, skipped
  | 'rolledBack'  // past the rollback needle → freed
  | 'noEvaluator' // sketch container / imported / unmapped → nothing to do
  | 'error';      // evaluator threw → last-good shape kept

export interface FeatureResult {
  id: string;
  op: FeatureOp;
  status: FeatureStatus;
  error?: string;
}

export interface RecomputeReport {
  results: FeatureResult[];
  order:   string[];
  ok:        number;
  errored:   number;
  reused:    number;
  errors:    Record<string, string>;   // id → message (also written onto feature.error)
  cycles:    string[];
}

const DATUM_OPS: FeatureOp[] = ['datumPlane', 'datumAxis', 'datumPoint'];
const DATUM_NODE_TYPE: Record<string, string> = {
  datumPlane: 'datum_plane', datumAxis: 'datum_axis', datumPoint: 'datum_point',
};
// Ops with no shape AND no frame — the engine has nothing to (re)build for them.
const INERT_OPS: FeatureOp[] = ['sketch', 'imported', 'unknown'];

// A 'sketch' container is normally inert, but when it was created ON A FACE it
// carries a sourceFaceRef and acts as a FRAME PRODUCER (like a datum): re-derive
// its workplane and thread it to the child wires so the sketch follows the face.
const isSketchFrame = (f: Feature): boolean =>
  f.op === 'sketch' && !!(f.params as any)?.sourceFaceRef;

// ─── The pure engine ──────────────────────────────────────────────────────────

export function recompute(
  host: RecomputeHost, graph: FeatureGraph, opts: RecomputeOptions = {},
): RecomputeReport {
  const { oc } = host;
  const { dirty, rollbackId } = opts;
  const order = graph.order;

  const results: FeatureResult[] = [];
  const errors: Record<string, string> = {};
  let ok = 0, errored = 0, reused = 0;

  // Datum frames recomputed THIS pass. They override the stored node meta so a
  // downstream feature (extrude-up-to-plane, sketch-on-datum) consumes the fresh
  // frame even before it's been written back to the store.
  const frames = new Map<string, DatumFrame>();
  const metaOf = (id: string): Record<string, any> | undefined => {
    const fr = frames.get(id);
    const base = host.meta(id);
    if (!fr) return base;
    if (fr.kind === 'plane') return { ...base, workplane: fr.workplane };
    if (fr.kind === 'point') return { ...base, point: fr.point };
    return { ...base, axis: fr.axis };
  };

  // Rollback cut: index in topo order of the last feature to evaluate. Anything
  // after it is freed. An unknown rollbackId (or none) means evaluate everything.
  const cutIdx = rollbackId ? order.indexOf(rollbackId) : order.length - 1;
  const lastActive = cutIdx < 0 ? order.length - 1 : cutIdx;

  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const f = graph.features[id];

    // 1 — past the timeline needle → free, remove from viewport.
    if (i > lastActive) {
      host.freeShape(id); host.onRemoved?.(id);
      results.push({ id, op: f.op, status: 'rolledBack' });
      continue;
    }

    // 2 — suppressed → free, remove, keep in tree.
    if (f.suppressed) {
      host.freeShape(id); host.onRemoved?.(id);
      results.push({ id, op: f.op, status: 'suppressed' });
      continue;
    }

    const sketchFrame = isSketchFrame(f);

    // 3 — inert (sketch container / import / unmapped) → nothing to build. A
    // sketch-on-face container is the exception: it produces a frame (see below).
    if (INERT_OPS.includes(f.op) && !sketchFrame) {
      results.push({ id, op: f.op, status: 'noEvaluator' });
      continue;
    }

    const isDatum = DATUM_OPS.includes(f.op);

    // 4 — incremental skip: clean feature reuses its cached output. Datums and
    // sketch-on-face frames have no cached shape (their frame lives in stored
    // params), so a clean one is skipped without a shape check; clean solids must
    // still have a live shape.
    if (dirty && !dirty.has(id) && (isDatum || sketchFrame || host.getShape(id))) {
      results.push({ id, op: f.op, status: 'cached' });
      reused++;
      continue;
    }

    // 5 — resolve inputs to placed shapes (+ meta). Placed temporaries (non-
    // identity placements return a NEW shape) are freed after the evaluator runs.
    const temps: any[] = [];
    try {
      const inputs = resolveInputs(host, metaOf, graph, f, temps);

      if (isDatum || sketchFrame) {
        const frame = isDatum
          ? evaluateDatum(oc, DATUM_NODE_TYPE[f.op], inputs, f.params)
          : evaluateSketchFrame(oc, inputs, f.params);
        if (frame) {
          frames.set(id, frame);
          host.onFrame?.(id, frame);
          f.error = null;
          results.push({ id, op: f.op, status: 'frame' });
          ok++;
        } else {
          results.push({ id, op: f.op, status: 'noEvaluator' });
        }
      } else {
        const ev = EVALUATORS[f.op];
        if (!ev) { results.push({ id, op: f.op, status: 'noEvaluator' }); continue; }
        const shape = ev(oc, inputs, f.params);
        host.setShape(id, shape);
        host.onChanged?.(id);
        f.error = null;
        results.push({ id, op: f.op, status: 'ok' });
        ok++;
      }
    } catch (e: any) {
      // Keep the last-good shape (do NOT free) so downstream still has an input.
      const msg = e?.message ?? String(e);
      f.error = msg;
      errors[id] = msg;
      results.push({ id, op: f.op, status: 'error', error: msg });
      errored++;
    } finally {
      for (const t of temps) { try { t.delete(); } catch { /* already freed */ } }
    }
  }

  return { results, order, ok, errored, reused, errors, cycles: graph.cycles };
}

/** Resolve a feature's resolvable input edges to live, placed shapes + meta. */
function resolveInputs(
  host: RecomputeHost,
  metaOf: (id: string) => Record<string, any> | undefined,
  graph: FeatureGraph, f: Feature, temps: any[],
): ResolvedInput[] {
  const out: ResolvedInput[] = [];
  for (const ref of f.inputs) {
    const dep = graph.features[ref.id];
    if (!dep) continue;                           // dangling edge — drop (flagged at build)
    out.push(resolveOne(host, metaOf, ref, dep.op, temps));
  }
  return out;
}

function resolveOne(
  host: RecomputeHost,
  metaOf: (id: string) => Record<string, any> | undefined,
  ref: FeatureRef, depOp: FeatureOp, temps: any[],
): ResolvedInput {
  let shape = host.getShape(ref.id);
  if (shape) {
    const placed = host.place(ref.id, shape);   // identity → same ref; else a new temp
    if (placed && placed !== shape) temps.push(placed);
    shape = placed;
  } else if (depOp === 'sketch' && host.profileWire) {
    // The input is a SKETCH container (no shape of its own) — build its current
    // profile wire fresh from its live entities. A temporary the engine frees
    // after the evaluator runs, so the feature re-derives the profile each pass.
    const wire = host.profileWire(ref.id);
    if (wire) { temps.push(wire); shape = wire; }
  }
  return { id: ref.id, role: ref.role, shape, ref: ref.sel, meta: metaOf(ref.id) };
}

// The LIVE host (registry + store + cad-*-mesh bus) and the call-site entry
// points live in RecomputeEngine.live.ts — kept separate so this pure core stays
// importable headlessly (the live deps pull in THREE / Zustand / the registry).
