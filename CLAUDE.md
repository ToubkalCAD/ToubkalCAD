# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ToubkalCAD — a browser-based 3D parametric CAD application. The geometry kernel is
OpenCascade (OCCT 7.8) compiled to WebAssembly via `opencascade.js@beta`; rendering is
Three.js (r170); UI is React 18 + Zustand; layout is Dockview; bundler is Rspack 2.x.

Note: the project was renamed from **AtlasCAD** → **ToubkalCAD**. `package.json` still
reads `"name": "atlascad"` and many source-file header comments say "AtlasCAD" — same
codebase, don't treat the two names as different projects. (`projects/AtlasCAD` and
`projects/TunaCAD` are separate sibling repos.)

## Commands

```bash
npm run dev      # rspack serve on http://localhost:8080 (HMR)
npm run build    # tsc --noEmit (typecheck) THEN rspack build → dist/
npm run preview  # production-mode serve
npm run clean    # rimraf dist
npx tsc --noEmit # typecheck only (fast feedback without bundling)
```

There is **no test runner and no linter configured** in this project — `tsc --noEmit`
is the only automated check. Deployment is Netlify (`netlify.toml`, publishes `dist/`).

## Cross-origin isolation is mandatory

OpenCascade.js needs `SharedArrayBuffer`, which requires COOP+COEP headers:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

These are set in `rspack.config.ts` (`devServer.headers`) and `netlify.toml`. Without
them the kernel fails at startup with a cryptic error. The error screen in
`src/index.tsx` already special-cases this failure mode.

WASM is served as a hashed URL via `file-loader` (`type: 'javascript/auto'`), **not**
Rspack's native `experiments.asyncWebAssembly` — OCC fetches its own `.wasm`. Do not
"fix" this by enabling `asyncWebAssembly`. The ~48 MB `.wasm` is content-hashed and
cached `immutable`; a normal reload (F5) reuses it, a hard reload (Ctrl+Shift+R) re-downloads.

## Architecture

### The kernel lives on the main thread

`src/index.tsx` calls `initOpenCascade()` once at startup and assigns the kernel to
**`window.oc`** (typed in `src/types/index.ts`). Every `Occ*Service` takes `oc` as its
first argument; call sites pull it from `window.oc`. `window` also holds the live
Three.js scene/camera/controls (`window.cadScene`, `cadCamera`, `cadControls`) so panels
can reach the viewport imperatively.

`src/workers/cad.worker.ts` + `CADWorkerClient` are a **separate, partial** worker path
that re-inits its own OCC and only implements a handful of ops (box/cylinder/sphere,
boolean, extrude, STEP import). The real feature set runs through the main-thread
services. Don't assume an operation goes through the worker — most don't.

### The create-an-object pipeline (the core pattern)

Adding any solid/sketch follows this flow — replicate it for new operations:

1. An `Occ*Service` builds a `TopoDS_Shape` from `window.oc` (e.g. `Ribbon.tsx`,
   `Op3DPanel.tsx`, `BooleanActionPanel.tsx`).
2. `CADGeometryRegistry.getInstance().registerShape(id, shape)` — the registry
   (singleton) **owns the WASM heap lifetime** of every shape.
3. `useCADStore.addNode({ id, ... })` — adds a `CADNode` to the Zustand scene graph.
4. `window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }))`.
5. `Viewport3D` listens for `cad-add-mesh`, gets the shape from the registry, builds a
   Three.js mesh via `ThreeMeshCache` (which tessellates through `OccConverter`), and
   adds it to the scene.

**OCC shapes are NOT stored in Zustand** — only lightweight `CADNode` metadata is. The
registry subscribes to the store and auto-`.delete()`s a shape's WASM memory when its
node is removed. Keep these two concerns separate: store = scene-graph metadata + UI
state; registry = native geometry.

### Communication bus: CustomEvents

React/store ↔ imperative Three.js viewport communicate through `window` CustomEvents
(declarative React can't directly drive the retained-mode scene). The catalog includes
`cad-add-mesh`, `cad-update-mesh`, `cad-remove-mesh`, `cad-duplicate-mesh`,
`cad-apply-transform`, `cad-material-changed`, `cad-visibility-changed`,
`cad-frame-selection`, `cad-view-preset`, and the `cad-sketch-*` family. `Viewport3D`
is the primary subscriber. When adding viewport behavior, prefer extending this bus over
threading refs through the component tree.

### State: `src/store/cadStore.ts` (single Zustand store, ~870 lines)

Holds the scene graph (`nodes` map + `rootIds`), selection, `interactionMode`
(a large discriminated mode enum — SELECT, the `SKETCH_*` tools, `EDIT_TRIM/EXTEND/SPLIT`,
`ASSEMBLY_*`, `BOOLEAN_PICK`, `CONSTRAIN`, etc.), active workplane, sketch session, undo/redo
history, materials, measurements, and logs. Interaction modes are how the app routes pointer
events to the right tool — the `useCAD*` hooks each activate for specific modes.

### Layers

- `services/Occ*Service.ts` — stateless OCC algorithm wrappers (primitives, boolean,
  extrusion, revolution, loft, sweep, fillet, transform/mirror/pattern, sketch, face,
  edge, measure, STEP/IGES exchange). Each returns a `TopoDS_Shape` to be registered.
- `services/` non-Occ — `CADGeometryRegistry`, `ThreeMeshCache`, `OccConverter`
  (shape→Three.js geometry tessellation), `CADWorkerClient`, `CADCameraService`,
  `CADPersistenceService`, `SketchConstraintSolver` (Levenberg-Marquardt 2D solver),
  `SketchEdit2D`/`SketchTransform2D`/`SketchRegions` (pure 2D analytic geometry).
- `hooks/useCAD*.ts` — pointer/raycast interaction handlers, one per tool family
  (sketch tool, sketch edit, face pick, edge select, boolean pick, constraint pick,
  assembly mate/concentric, gizmo hotkeys). Each is gated on `interactionMode`.
- `components/` — `CADLayout` (Dockview shell), `Viewport3D` (the imperative Three.js
  canvas + event bus subscriber), `Ribbon` (data-driven command registry — every toolbar
  handler is a `commands` map entry keyed by id), action panels, tree, properties.
- `utils/WasmScope.ts` — RAII-style lifetime guard for **temporary** WASM objects.

### WASM memory management

Every OCC object has a `.delete()`. Two disciplines coexist:
- **Persistent** result shapes → handed to `CADGeometryRegistry`, freed when the node is removed.
- **Temporary** builders/vecs/etc. → wrap in `WasmScope`: `const s = new WasmScope();
  s.keep(new oc.Foo()); ... s.free()`, or `withWasmScope(s => {...})`. The roadmap warns
  against blanket "track-all-then-purge" patterns — they free shapes you still need.

## Working with the OpenCascade API

OCC bindings are heavily overloaded with numeric suffixes (`_1`, `_2`, `_3`, `_4`) that
pick a specific C++ constructor/overload — choosing the wrong one is a common bug (e.g.
`BRepPrimAPI_MakeCylinder_1(R,H)` vs `_2(axes,R,H)`). Verify signatures against the
generated typings before using an unfamiliar class:

```
node_modules/opencascade.js/dist/opencascade.full.d.ts   # ~180k lines; grep/awk for the class
```

`docs/ROADMAP.md` records verified OCCT-7.8 API corrections (real helix construction,
`BRepOffsetAPI_NormalProjection`, the 7.8 tessellator `triangulation.Node(i)/.Triangle(i)`,
why `compound.Located(...)` is not a deep copy, etc.) and the feature backlog with which
tracks are done. Read it before implementing a new geometry feature — it also explains why
pasted "blueprint" hooks assuming a `useCadStore` with shapes-in-state must be re-homed
onto this registry + service + CustomEvent pattern.
