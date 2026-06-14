# Parametric Feature Tree & Recompute Engine — Design (Phase 1)

Status: **steps 1–3 shipped, step 4 underway** (see §10). The feature graph, the
evaluator registry, and the recompute engine (topo replay + dirty propagation +
rollback + per-feature error isolation) exist, are validated headlessly, and are
wired into the param-edit call sites. Step 4 (StableRef) has migrated the
fillet/chamfer **edge** selection, the extrude **up-to-face** target, the
**datum offset-from-face** frame, and **sketch-on-face** workplanes onto geometric
signatures (so each re-derives and follows its face on recompute; also fixed
up-to-face + datum-offset replay bugs). Remaining for step 4: datum angle/tangent
and 3-point face/vertex refs. Still to do: finish 4, graph-delta undo (5), timeline
UI (6), persistence (7). Read `docs/ROADMAP.md` and `CLAUDE.md` first.

## 1. Why

The app today creates a shape **once** and stores it. There is no way to:

- **Roll history back/forward** to an arbitrary point (the Fusion-style timeline needle).
- **Edit an upstream feature and have everything downstream rebuild** (change a
  sketch → the extrude, the fillet on it, and the boolean that consumed it all update).
- **Reload a saved model** by re-evaluating it (persistence currently has to store
  tessellated meshes or re-run ad-hoc).
- **Free + regenerate** OCC shapes on demand (today we *retain* deleted shapes for
  undo because we cannot rebuild them — see the `shape-lifetime` note).

All four fall out of one abstraction: store a **recipe** (op + inputs + params),
not the resulting shape, and **replay** it through a dependency graph.

## 2. What already exists (build on this, don't replace it)

The seeds are already here — they're just scattered and only ever run *once*:

| Concern | Today |
|---|---|
| Per-op recipe | `node.params` already holds it: `{opType, targetWireIds, opParams}` (Op3DPanel), `{boolOp, baseId, toolIds}` (boolean), `{blendOp, sourceId, edgeIndices}` (blend), sketch `{workplane, constraints, sketchGeom}` |
| Single-op evaluator | `computeShape(op, inputs, params) → TopoDS_Shape` in `Op3DPanel.tsx` covers extrude/revolve/loft/sweep/fillet/chamfer |
| "Re-run one op" | the `editNodeId` path + `createAndEditOp` already re-execute an op and `setNodeParams` |
| Input references | by node id, in params (`baseId`, `toolIds`, `sourceId`, `targetWireIds`) |
| Input placement | `getPlacedShape(id)` bakes the gizmo transform deterministically |
| Consumed-input nesting | `adoptSketchSources` re-parents sketches under the op |
| Shape ownership | `CADGeometryRegistry` (id → TopoDS_Shape), freed by reachability GC |

**What's missing:** a *uniform* recipe shape, a real **DAG**, **topological recompute
with dirty-propagation**, **deterministic full rebuild**, and **stable references**
(selections that survive upstream edits).

## 3. Core model

### 3.1 Feature record

A `Feature` is the normalized recipe. It does **not** replace `CADNode` — it lives
on it (one feature per geometry-producing node). Sketches, datums, primitives, and
ops are all features; the difference is just their `op` and inputs.

```ts
interface Feature {
  id:     string;            // === CADNode.id
  op:     FeatureOp;         // 'box' | 'extrude' | 'boolean' | 'fillet' | 'sketch' | 'datumPlane' | …
  inputs: FeatureRef[];      // upstream features this consumes (the DAG edges)
  params: Record<string, number | string | boolean | number[]>;  // numeric/enum knobs only
  // Outputs, NOT persisted — recomputed:
  //   the resulting TopoDS_Shape lives in CADGeometryRegistry under this id.
  suppressed?: boolean;      // feature is skipped during recompute (kept in tree)
  error?:      string | null;// last recompute failure, surfaced in the tree
}

interface FeatureRef {
  id:   string;              // upstream feature id
  role?: string;            // 'profile' | 'base' | 'tool' | 'axis' | 'plane' …
  sel?:  StableRef;          // OPTIONAL sub-entity selection (a face/edge) — see §6
}
```

Params are **values only** (mm, degrees, enums). Anything that points at geometry is
an `input` (a graph edge), never a raw id buried in params. This is the single most
important rule: **the graph is explicit, derivable from `inputs` alone.**

### 3.2 The graph

`inputs[].id` are the edges. The graph is the set of all features + these edges.
It must stay a **DAG** (reject edits that would create a cycle). Build order is a
**topological sort**; nodes with no path between them are independent and may
evaluate in any order (and eventually in parallel — see §8).

### 3.3 Evaluator registry

One pure function per op, keyed by `op`. This generalizes today's `computeShape`:

```ts
type Evaluator = (oc, inputs: ResolvedInput[], params) => TopoDS_Shape;
const EVALUATORS: Record<FeatureOp, Evaluator>;

interface ResolvedInput {
  id:    string;
  shape: TopoDS_Shape;       // the upstream feature's CURRENT output (placed)
  ref?:  StableRef;          // resolved sub-entity, if the edge selected one
}
```

Evaluators are thin wrappers over the existing `Occ*Service`s. Migration = move the
body of each panel's "apply" into its evaluator; the panel becomes a params editor.

## 4. The recompute engine

A new `services/RecomputeEngine.ts` (pure, main-thread, owns no React state).

```
recompute(graph, dirtySet?):
  order = topoSort(graph)                       // upstream → downstream
  rollbackAt = graph.rollbackId                 // timeline needle (§7); default = end
  for f in order up to rollbackAt:
    if f.suppressed: free(f.id); continue
    if dirtySet && f.id ∉ dirtySet && cached(f.id): continue   // incremental
    try:
      inputs = f.inputs.map(resolve)            // get upstream shapes + sub-entity refs
      shape  = EVALUATORS[f.op](oc, inputs, f.params)
      registry.registerShape(f.id, shape)       // replaces + frees the old shape
      f.error = null
      emit 'cad-update-mesh' (or add/remove)    // reuse the existing event bus
    catch e:
      f.error = e.message                       // mark errored, keep going
      freezeOldShape(f.id)                       // keep last-good so downstream still has input
  for f after rollbackAt: free(f.id) + 'cad-remove-mesh'
```

### 4.1 Dirty propagation

Editing feature F marks F dirty; the dirty set is **F plus all its transitive
descendants** in the DAG. Only those recompute; the rest reuse cached shapes.
This is what makes "drag a dimension" cheap even in a big model.

```
markDirty(F) = { F } ∪ descendants(F)
```

### 4.2 Where it hooks in

- **Edit a param** (panel slider / dimension): `setFeatureParams(id, …)` → `recompute(graph, markDirty(id))`.
- **Move a body** (gizmo): a transform is a param of an implicit placement; marks the
  body + descendants dirty. (Replaces today's `getPlacedShape`-at-apply with placement
  as a recomputed input.)
- **Delete**: remove the feature; its descendants become errored (missing input) or are
  deleted too (cascade choice — see §9).
- **Undo/redo**: history stores **feature-graph deltas**, not node snapshots. Undo =
  apply inverse delta + `recompute`. This *subsumes* the current full-node-array history
  and removes the reachability-GC hack: shapes can be freed because they regenerate.

## 5. Timeline (the payoff)

`graph.rollbackId` = the feature the needle sits at. Recompute evaluates the topo
order **up to and including** that feature, frees everything after. Dragging the
needle is just moving `rollbackId` and recomputing (cheap, since only the tail
changes). "Insert a feature in the middle" = set `rollbackId`, add the feature, the
rest rebuild on top. The bottom timeline bar renders the topo order left→right; the
tree (already present) renders the same graph hierarchically.

## 6. The hard problem: stable references (topological naming)

Today selections are **positional indices**: `edgeIndices: number[]`, `faceIndex`,
and the `TopExp_Explorer` ordinal that `FacePicker` + the `face-index-invariant`
rely on. These indices **change when an upstream feature changes** (add a hole →
every later face index shifts), so a fillet "on edge 7" silently moves to the wrong
edge after an upstream edit. This is the classic CAD "persistent naming" problem and
is the single biggest risk in Phase 1.

Pragmatic, staged approach (do **not** try to solve it perfectly first):

1. **Phase 1a — geometric signature refs.** Store a `StableRef` as a geometric
   fingerprint, not an index: for a face `{kind:'face', point:[x,y,z], normal, area}`;
   for an edge `{kind:'edge', mid:[x,y,z], dir, length}`. On recompute, resolve by
   nearest-matching candidate within tolerance (re-explore, score each face/edge,
   pick best). Robust to index shuffles and small param changes; degrades gracefully.
2. **Phase 1b — carry OCC history.** `BRepAlgoAPI`/`BRepBuilderAPI` expose
   `.Generated()` / `.Modified()` / `.IsDeleted()`. Track which output faces descend
   from which input faces across an op, so a reference threads through the operation
   instead of being re-matched blind. More work; add where 1a mis-resolves.
3. Always surface a ref that fails to resolve as a recompute `error` on the feature
   (never silently bind to the wrong entity).

`StableRef` replaces the raw indices in `FeatureRef.sel` and in blend/draft params.
The existing `FacePicker` hit already yields exactly the data a signature needs
(world point, the face group), so capture happens at pick time.

## 7. Shape lifetime, reconciled

With regeneration available, the `shape-lifetime` retention hack goes away:

- A feature's shape is owned by the registry under its id, replaced on each recompute.
- Deleting/suppressing/rolling-back-past a feature **frees** its shape immediately —
  undo regenerates it by replaying the recipe. No more "keep deleted shapes alive
  through history."
- The registry stays the WASM owner; the engine is the only writer of shapes.

## 8. Threading (later, optional)

Independent branches of the DAG can recompute in parallel. This is the *one* place a
worker genuinely helps (heavy booleans/tessellation off the main thread) — but only
once the engine exists and only for leaf-heavy ops. Not Phase 1. (The old blanket
worker was correctly deleted; this would be a targeted, engine-driven offload.)

## 9. Open decisions

- **Delete cascade:** delete a feature with dependents → cascade-delete the subtree,
  or leave dependents errored-but-present? Recommend: **errored-but-present** with a
  one-click "delete dependents too." Matches Fusion; avoids silent data loss.
- **History granularity:** graph-delta per edit vs. coalesce drags. Recommend coalesce
  (one undo step per gesture, like today's live-vs-commit split).
- **Migration of existing models:** in-memory only today (persistence is separate), so
  no on-disk migration needed yet — but `CADPersistenceService` should serialize the
  feature graph, not meshes, once this lands.
- **Backward field names:** keep reading legacy `params` keys (`baseId`, `toolIds`,
  `sourceId`, `targetWireIds`) via an adapter so existing flows don't break mid-migration.

## 10. Suggested implementation order (incremental, always-shippable)

The DAG can be introduced **without** a big-bang rewrite by wrapping what exists:

1. ✅ **Define `Feature`/`FeatureRef`/`StableRef` types + a `FeatureGraph` store slice**
   that mirrors the existing nodes (one feature per geometry node). No behavior change
   yet — just record inputs explicitly (derive from today's params via an adapter).
   → `services/FeatureGraph.ts` (+ `.selftest.ts`).
2. ✅ **Build `EVALUATORS`** by extracting each panel's "apply" body into a pure
   `(oc, inputs, params) → shape`. Panels call the evaluator; output identical to now.
   → `services/FeatureEvaluators.ts` (+ `.selftest.ts`).
3. ✅ **`RecomputeEngine.recompute(graph, dirty)`** with topo sort + dirty propagation,
   **wired into the param-edit call sites** — upstream edits now propagate downstream
   in the live app (the first visible win).
   - PURE core in `services/RecomputeEngine.ts`: `recompute(host, graph, opts)` — no
     store / registry / events, all injected via a `RecomputeHost`, so it's exercisable
     headlessly. Supports rollback (`rollbackId`, the timeline needle — payoff in step 6),
     datum FRAME threading, and per-feature error isolation (mark `feature.error`, keep
     the last-good shape, continue).
   - LIVE half in `services/RecomputeEngine.live.ts` (browser-only; static imports of the
     registry / store / `cad-*-mesh` bus): `liveHost()`, `recomputeFromStore(editedId?)`,
     and `propagateFromStore(editedIds)` — rebuild ONLY the descendants of the edited
     feature(s) (the edited node is rebuilt by its own panel, whose special context —
     up-to-next/last bodies etc. — the generic evaluator doesn't carry).
   - Call sites: the **re-edit** branch of `Op3DPanel` (extrude/revolve/loft/sweep),
     `BlendActionPanel` (fillet/chamfer), `BooleanActionPanel`, and `ConstraintPanel`'s
     sketch-solve all call `propagateFromStore(...)` after committing their params, so a
     fillet/boolean/pad stacked on an edited feature — or an op built on an edited
     sketch — rebuilds automatically. Add/update is chosen by `ThreeMeshCache.hasMesh`.
   - Validated by `npm run test:recompute` (compiles the real pure core to CJS, drives it
     through a mock host against the kernel: 21 assertions — propagation, cache-skip,
     datum follow, error isolation, rollback) and the in-browser `recomputeSelfTest()`.
   - **Still direct (not yet through the engine):** create paths (no descendants yet) and
     **gizmo body-moves** — automatic move-propagation needs placement modeled as a
     recomputed input (§4.2), a later change.
4. 🚧 **`StableRef` (signature resolver)** for faces/edges; migrate sub-entity refs off
   raw indices. **Done: fillet/chamfer edges.**
   - `StableRef.captureEdge/captureEdges` capture a geometric signature (curve kind +
     centre-of-mass + length + axis/radius) per picked edge in `BlendActionPanel.doApply`,
     against the same placed source the evaluator resolves against. Stored as
     `params.edgeRefs`, parallel to the legacy `params.edgeIndices`.
   - `FeatureEvaluators.resolveBlendEdges` maps the stored selection onto the CURRENT
     base's ordinals: signature resolves confidently → use it (survives edge RENUMBERING,
     the index-shuffle case raw ordinals get wrong); rejects → fall back to the stored raw
     ordinal (no regression vs. step 3); nothing resolves → throw (feature errors rather
     than fillet an empty set). Legacy nodes (no `edgeRefs`) use raw indices unchanged.
   - Validated by `npm run test:stableref` (10 assertions: identity round-trip; a bottom
     edge keeps its identity across a top-boss fuse that shifts its ordinal 8→4, so the
     signature picks 4 not the stale 8; raw-index fallback; hard-error; legacy passthrough).
   - **Also done: up-to-face.** `StableRef.captureFaceAtPoint` captures a FaceSig of the
     picked target face (nearest-face to the click, mirroring OccExtrusionService so it
     matches what the extrude terminates on) in `Op3DPanel`, stored as `params.targetFaceRef`.
     `FeatureEvaluators.resolveTargetFacePoint` re-resolves it on the live base and feeds
     the resolved face's current centroid to `extrudeUpToFace`; falls back to the stored
     `targetFacePoint` world point. This ALSO fixed a replay bug: the adapter dropped
     `targetFacePoint` (only copied opParams), so up-to-face lost its limit on recompute —
     it now carries targetFacePoint + targetFaceRef. Validated by `npm run test:stableref-face`
     (9 assertions: round-trip, top-face survives a renumbering fuse 5→2, replay correctness,
     limit-follows-on-renumbered-base, legacy point fallback).
   - **Also done: datum offset-from-face.** `useCADDatumOffsetPick` captures a FaceSig of the
     source face into the datum's `refs[].sel`. `evaluateDatum`'s offset path re-derives the
     base frame from that signature against the live body (`deriveFaceWorkplane` → resolveFace
     → `OccFaceService.planeFromFaceIndex`), so the offset plane FOLLOWS the face instead of
     using its baked-at-creation frame; rejects → falls back to the baked `workplane`. ALSO
     fixed a replay bug: the adapter dropped the datum's `refs`, so the offset DISTANCE
     replayed as 0 — it now carries `refs`. Validated by `npm run test:stableref-datum`
     (6 assertions: distance honoured; datum follows the +X face when the body widens 10→11
     → plane x=15→16; reject→baked fallback on a large move; legacy/datum-source paths).
   - **Also done: sketch-on-face.** A sketch created on a face is now a FRAME PRODUCER (like a
     datum). `useCADSketchFacePick` captures a FaceSig of the picked face into the container's
     `params.sourceFaceRef = { nodeId, sel }`. The graph adapter makes the source body an input
     of the `sketch` container (role `source`) and makes each `sketch_wire` depend on its parent
     container (role `frame`). The engine treats a sketch-with-`sourceFaceRef` like a datum:
     `FeatureEvaluators.evaluateSketchFrame` re-derives the workplane from the FaceSig against the
     live body (`deriveFaceWorkplane`), the frame is threaded into the child wires' meta, and
     `sketchWire` now prefers that threaded frame over its baked `params.workplane` — so the
     sketch (and everything extruded from it) FOLLOWS the face; rejects → baked fallback. The
     live host's `onFrame` writes the re-derived `workplane` back to the container. Validated by
     `npm run test:stableref-sketch` (7 assertions: capture; re-derive on face; follow d 10→11;
     reject→baked fallback; no-sig passthrough; wire placed on threaded frame; wire baked fallback).
   - **Remaining face-ref work: datum angle/tangent, 3-point-from-vertices.** Boolean base/tool
     are whole-body NODE refs by id — already stable, nothing to migrate.
   - Known limit (§6 Phase 1a): a signature is absolute-position based, so a reference on
     a feature that TRANSLATES far (e.g. a fillet on a face of a growing extrude) may
     reject and fall back rather than track — that's what OCC `Generated()`/`Modified()`
     history threading (Phase 1b) is for.
5. **Switch undo/redo to graph deltas**; drop the shape-retention GC hack.
6. **Timeline UI** (`rollbackId` + bottom bar). Pure payoff once 1–5 exist.
7. **Persistence** serializes the graph; **parallel recompute** as a later optimization.

Each step ships independently and leaves the app working. Steps 1–3 deliver
edit-propagation; 6 delivers the timeline.
