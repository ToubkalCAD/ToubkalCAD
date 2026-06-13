# Parametric Feature Tree & Recompute Engine — Design (Phase 1)

Status: **design / not yet implemented**. This is the Phase 1 build from the
hardening roadmap. Read `docs/ROADMAP.md` and `CLAUDE.md` first.

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

1. **Define `Feature`/`FeatureRef`/`StableRef` types + a `FeatureGraph` store slice**
   that mirrors the existing nodes (one feature per geometry node). No behavior change
   yet — just record inputs explicitly (derive from today's params via an adapter).
2. **Build `EVALUATORS`** by extracting each panel's "apply" body into a pure
   `(oc, inputs, params) → shape`. Panels call the evaluator; output identical to now.
3. **`RecomputeEngine.recompute(graph, dirty)`** with topo sort + dirty propagation.
   Wire param-edits through it. Now upstream edits propagate downstream — the first
   visible win.
4. **`StableRef` (signature resolver)** for faces/edges; migrate blend/boolean/sketch-
   on-face refs off raw indices. Captured at pick time via `FacePicker`.
5. **Switch undo/redo to graph deltas**; drop the shape-retention GC hack.
6. **Timeline UI** (`rollbackId` + bottom bar). Pure payoff once 1–5 exist.
7. **Persistence** serializes the graph; **parallel recompute** as a later optimization.

Each step ships independently and leaves the app working. Steps 1–3 deliver
edit-propagation; 6 delivers the timeline.
