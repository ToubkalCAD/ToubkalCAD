# ToubkalCAD — Advanced Features & Ribbon UI Roadmap

> Drafted 2026-06-06. Reference app for the UI: **Chili3D** (xiangechen/chili3d) —
> same stack as us (TypeScript + OCCT 7.8 → WASM + Three.js), Office-style ribbon.

## Context: where we already are

Full 2D sketch suite, extrude/revolve/loft/sweep, primitives, booleans, per-edge
fillet/chamfer, 15 parametric 2D constraints (LM solver), STEP/IGES, undo/redo,
dark theme, SVG icon set. The toolbars (`CADToolbar`, `AdvancedToolbar`) are single
`flex` rows with `overflowX:auto` — every new feature lengthens the scroll. The
ribbon fixes this structurally.

### Architecture note (read before using any "blueprint" code)
Our app uses `CADGeometryRegistry` (singleton, owns OCC shapes), `ThreeMeshCache`,
CustomEvents (`cad-add-mesh`, …), `Occ*Service` modules, and `window.oc`. We do
**not** keep OCC shapes in Zustand. Any pasted hook that assumes a
`useCadStore` with `sceneTree`/`previewMeshData`/`addSolidEntity` must be
re-homed onto our registry + service + event pattern. Reuse algorithms, not plumbing.

### Blueprint API corrections (verified against OCCT 7.8)
- `GeomAPI_To3d` / `const 3dHelixCurve` → not real / illegal identifier. Real helix:
  2D line on `Geom_CylindricalSurface` → `BRepBuilderAPI_MakeEdge(curve2d, surface)`
  → `BRepLib::BuildCurves3d` → `BRepOffsetAPI_MakePipe`.
- `BRepVertic_MakePrism_1` → typo for `BRepPrimAPI_MakePrism`.
- `BRepAlgo_NormalProjection` → it's `BRepOffsetAPI_NormalProjection`.
- Tessellator `tri.Nodes()/.Triangles()` is pre-7.x → 7.8 uses `triangulation.Node(i)/.Triangle(i)`. Keep our existing working tessellator.
- `compound.Located(new TopLoc_Location())` is **not** a deep clone; use
  `BRepBuilderAPI_Copy` for true isolation. Prefer the registry lifetime model.
- The blanket "track all + purge in finally" pattern deletes shapes you still need.

---

## Part 1 — Customizable Ribbon (UI)

Data-driven ribbon: a config of `tabs → groups → commands`, where each command is
`{ id, icon, label, run, enabled }`. Once commands are config (not hardcoded JSX),
"customization like Office" is nearly free.

- **R1 — Command registry** ✅ *(done 2026-06-06)*: every toolbar handler is now a
  `commands` map entry keyed by id (`Ribbon.tsx`).
- **R2 — Ribbon shell** ✅ *(done 2026-06-06)*: tab strip (Sketch · Model · Modify ·
  Tools) + active-tab command row + persistent zone. Both flat toolbars deleted.
- **R3 — Contextual tabs**: auto-show/switch to a "Sketch" tab during a sketch session.
- **R4 — Quick Access Toolbar + Customize dialog**: pinnable favorites; show/hide &
  reorder commands; persist to localStorage.

Tab layout: **Sketch** · **Model** · **Modify** · **Tools** (+ persistent zone:
plane indicator, sketch-session badge, undo/redo).

---

## Part 2 — Advanced features (dependency-ordered tracks)

### Track S — Sketch & 2D editing
- **S1** ✅ *(done 2026-06-07)* Trim / Extend / Split for sketch **lines**.
  `SketchEdit2D.ts` (pure 2D analytic intersections, line×line + line×circle) +
  `useCADSketchEdit` hook (`EDIT_TRIM/EXTEND/SPLIT` modes, raycast sketch wires,
  delete-original + create-segment nodes). Ribbon: Sketch ▸ Modify ▸ Trim/Extend/Split.
  Scope: target must be a line; cutters may be lines or circles. Circle/arc/spline
  targets deferred (would need arc sketchGeom + OCC arc splitting).
- **S2** ✅ *(done 2026-06-07)* Sketch on a 3D face. `OccFaceService.extractPlanarFaces`
  (per-face triangle soup + gp_Pln → workplane) + `useCADSketchFacePick` hook
  (`FACE_SKETCH` mode, transparent face overlays, hover, click → `startSketchSession`).
  Ribbon: Sketch ▸ Datum ▸ "On Face".
- **S3** Project edges to sketch (`BRepOffsetAPI_NormalProjection`). Needs S2.

### Track T — Transforms & patterns
- **T1** ✅ *(done 2026-06-07)* Mirror (`OccTransformService.mirror`, `gp_Trsf`
  about `gp_Ax2`; XY/YZ/ZX). Ribbon: Model ▸ Transform ▸ Mirror.
- **T2** ✅ *(done 2026-06-07)* Linear & circular patterns (`OccTransformService`,
  compound via `BRep_Builder` — not boolean loops). Ribbon: Lin/Circ Array.
  Future: grid & mirror-pattern variants, face/plane-pick instead of axis index.

### Track M — 3D operations
- **M1** Shell / ThickSolid (`BRepOffsetAPI_MakeThickSolid`): pick faces + thickness.
- **M2** Offset shape (`BRepOffsetAPI_MakeOffsetShape`).
- **M3** Draft angle (`BRepOffsetAPI_DraftAngle`).
- **M4** Section / slice (`BRepAlgoAPI_Section` with `gp_Pln`).
- **M5** Variable-radius fillet (`BRepFilletAPI_MakeFillet.Add(r1, r2, edge)`).
- **M6** Helical sweep / thread (corrected API above).

### Track C — Topology converters (Chili3D ToFace/ToWire/ToShell/ToSolid)
- **C1** Wire→Face, Faces→Shell (sewing), Shell→Solid, with open-topology error handling.

### Track X — Interchange & selection
- **X1** Mesh export: STL / OBJ / glTF / 3MF.
- **X2** Multi-face selection (Ctrl) + surface-type filter (`GeomAdaptor_Surface.GetType()`).

### Track P — Parametric feature tree (deepest)
- **P1** Feature DAG + downstream recompute with persistent naming
  (`.Generated()`/`.Modified()`) so child features survive parent edits.
- **P2** 3D assembly constraints (Mate/Align/Concentric) — **still-pending Prompt-4**;
  separate subsystem (constrains solid transforms via OCC face/axis geometry).

---

## Recommended sequence
1. **R1 → R2** (ribbon) — kills scroll, makes every later feature a one-line config entry.
2. Quick wins into the ribbon: **T1 Mirror, T2 Patterns, C1 Converters, X1 Export**.
3. **S2 Sketch-on-face** + **M1 Shell** — elevates to real part modeling.
4. **R3 / R4** (contextual tabs + customization).
5. **P1 feature tree** last.
</content>
</invoke>
