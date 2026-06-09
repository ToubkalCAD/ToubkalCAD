# ToubkalCAD — Reference Geometry (Datum) Roadmap

> Drafted 2026-06-09. Goal: replace the raw "origin + normal vector" custom-plane
> UX with **option-based** reference geometry (planes / axes / points) that live in
> the tree as first-class features — like Fusion 360 / SolidWorks / CATIA — and look
> the part. Reference: Fusion's **Construct** menu (Offset, At Angle, Tangent,
> Midplane, Through 2 Edges, Through 3 Points, …) + OpenCASCADE's `gp_`/`gce_` packages.

## Where we are (gap analysis)

- `Workplane = {label, origin, normal, uAxis, vAxis}` (`cadStore.ts`) already carries
  everything a reference plane needs. `STANDARD_WORKPLANES` = XY/YZ/ZX at the origin.
- `PlaneSelector.tsx` has a **Standard** tab (XY/YZ/ZX) and a **Custom** tab that asks
  for raw origin + normal numbers (`buildBasis` derives u/v). This is the "inhabitual"
  UX to replace.
- **Planes are not entities.** `confirm()` calls `startSketchSession(wp)` immediately —
  a plane only exists for the duration of the sketch it spawns. There is no `Plane 1`
  node in the tree.
- The on-plane visual is a **transient** helper (Viewport3D ~L156–220): a blue 0.06-
  opacity fill + `GridHelper` + normal arrow, shown only inside a sketch context, torn
  down on exit. No persistent, Fusion-style datum.
- `NodeType` has no `datum_plane` / `datum_axis` / `datum_point`.
- Sketch-on-face (S2, `useCADSketchFacePick`) already derives a `Workplane` from a
  face's `gp_Pln` and starts a session — **this is exactly the pattern to reuse** for
  "sketch on a datum plane."

## The core UX shift (the user's main ask)

Decouple **create** from **sketch**. A datum plane is created via a Construct command,
appears in the tree as `Plane 1` / `Plane 2`, and renders persistently. You sketch on it
*later* (right-click → Create Sketch, or select + Sketch), exactly like Fusion/SW — where
"separating model geometry from reference geometry is a fundamental concept." Origin
planes (XY/YZ/ZX) become default datum nodes you can show/hide.

## Data model

Add to `NodeType`: `'datum_plane' | 'datum_axis' | 'datum_point'`. Datum nodes carry no
solid in `CADGeometryRegistry`; their geometry is light and lives in `params`:

```ts
// datum_plane
params: {
  datum: 'plane',
  workplane: Workplane,                 // origin/normal/uAxis/vAxis (drives sketch + render)
  method: 'origin' | 'offset' | 'angle' | 'threePoint' | 'midplane'
        | 'twoEdges' | 'tangent' | 'alongPath' | 'normalToCurve',
  refs: DatumRef[],                     // referenced node/face/edge/point ids + a scalar (dist/angle)
}
// datum_axis  → params.axis = {origin, dir}, method, refs
// datum_point → params.point = [x,y,z],       method, refs
```

`refs` is what makes datums **associative** later (Track P1): on a parent edit, re-run
the `method` against `refs` to recompute `workplane`. Until P1 lands, datums are static
snapshots (recomputed only on explicit edit) — acceptable v1.

## Visual spec (Fusion-style, verified against our renderer)

A persistent `THREE.Group` per datum-plane node, keyed by `userData.cadNodeId` (same
convention as solids), built from the plane's `gp_Ax3` (Position → Location/Direction/
XDirection/YDirection → orientation matrix):

- **Face**: `PlaneGeometry`, `MeshBasicMaterial` amber `#f0a30a`, opacity ~0.22,
  `side: DoubleSide`, **`depthWrite:false`** (critical — stops the translucent plane
  from clipping solids behind it; we already use this trick for the workplane fill and
  S2 face overlays, so it's proven here).
- **Border**: `EdgesGeometry` + `LineBasicMaterial` darker amber `#d47a00`, opacity 0.8.
- **Dynamic size**: from the model's bounding box (so it's never absurdly small/large);
  recompute on add/remove. (Bnd_Box throws under our Node test harness but works in the
  browser — fine here, this is browser-only render code.)
- **Grid child** (`name:"sketchGrid"`, hidden by default): shown **only** in sketch mode
  AND when viewing the plane near-normal — per-frame `|cameraDir · planeNormal| > 0.995`
  fade-in (the dot-product trick). Fold this into the existing render loop / the
  workplane-grid effect rather than a new RAF.
- Selected/hover states tint the border (reuse the emissive/hover patterns from the
  pick hooks).

This replaces the transient blue grid: the **active** sketch plane just highlights its
datum (brighter border + grid); non-active datums render dimmer.

## OCC construction cheat-sheet (all classes verified present in our `opencascade.js` build)

Every method ends the same way: build a `gp_Pln` → `pln.Position()` → `gp_Ax3` →
`Workplane {origin=Location, normal=Direction, uAxis=XDirection, vAxis=YDirection}`.
(For OCC ops that need topology — Project/Section/sketch-on — wrap as `Geom_Plane` →
`BRepBuilderAPI_MakeFace` bounded face.)

| Fusion feature | OCC in our build | Notes |
|---|---|---|
| Offset Plane | `pln.Translated_1(gp_Vec(normal·d))` **or** `gce_MakePln_*(pln, dist)` | pick face/datum + distance |
| Plane at Angle | `pln.Rotated(gp_Ax1(edge), angleRad)` | pick edge/axis + face + angle |
| Through 3 Points | `gce_MakePln(P1,P2,P3)` (one of `gce_MakePln_1..8`) | pick 3 vertices/points; reject collinear |
| Midplane | average two planes' Ax3 → `gp_Pln_3(midPnt, avgDir)` | pick 2 planar faces |
| Through 2 Edges | extract 3 coplanar vertices → 3-point path | pick 2 linear edges |
| Tangent (to cylinder/face) | `GeomLProp_SLProps` face normal at a UV → `gp_Pln` | pick curved face (+ point) |
| Along Path / Normal to Curve | `GeomLProp_CLProps` curve tangent → plane normal | pick curve + distance/% |
| Datum **Axis** | `gp_Ax1` (2 pts / edge / cylinder axis / plane∩plane via `BRepAlgoAPI_Section`) | render as long line, `MakeEdge` for topology |
| Datum **Point** | `gp_Pnt` (coords / vertex / edge-mid / intersection); `BRepBuilderAPI_MakeVertex` | small marker mesh |

`gp_Pln` exposes `Position()→gp_Ax3`, `Rotated`, `Translated_1/2`, `Axis()`; `gp_Ax3`
exposes `Location/Direction/XDirection/YDirection`. Confirmed at
`node_modules/opencascade.js/dist/opencascade.full.d.ts` (`gce_MakePln_1..8`,
`GeomLProp_SLProps`, `BRepProj_Projection`, `BRepAlgoAPI_Section`,
`BRepBuilderAPI_MakeVertex` all present). As with the extrusion work, **verify the exact
numbered overload** before each use.

---

## Track D — Reference Geometry (dependency-ordered)

### Foundation
- **D0 — Datum node model + persistent Fusion-style rendering.** Add the three
  `datum_*` NodeTypes; render `datum_plane` as the amber bounded plane group above,
  keyed by node id, synced to the `nodes` map (new render effect in Viewport3D, sibling
  to the mesh path). Tree shows `Plane 1` with a plane icon; show/hide + delete work.
  Grid-only-in-sketch-mode dot-product gate. **Keystone — unblocks everything and
  delivers the look + the create/sketch decoupling.** Effort: L.

### Create → tree → sketch loop
- **D1 — Origin datum planes.** Seed XY/YZ/ZX as datum nodes (hidden by default, like
  Fusion). Validates the model end-to-end. Effort: S.
- **D9 — Sketch on a datum plane.** Reuse the `useCADSketchFacePick` pattern: select a
  datum (or click it in the viewport) → `startSketchSession(node.params.workplane)`.
  Right-click tree → "Create Sketch." This is the payoff of decoupling. Effort: M.

### Plane creation commands (each = a Construct entry + reference pick + OCC + a datum node)
- **D2 — Offset Plane** (`Translated`/`gce_MakePln`). Most-used; do first. Effort: M.
- **D4 — Plane through 3 Points** (`gce_MakePln(P1,P2,P3)`). Effort: M.
- **D5 — Midplane** (average two faces). Effort: M.
- **D3 — Plane at Angle** (`Rotated` about a picked edge). Effort: M.
- **D6 — Tangent / Through-2-Edges / Along-Path / Normal-to-Curve.** Advanced
  (`GeomLProp_SLProps`/`GeomLProp_CLProps`). Effort: L.

### Reference axes & points
- **D7 — Datum Axis** (`gp_Ax1`): 2 points · edge · cylinder axis · plane∩plane. Render
  as a line; used as the rotation axis for D3, pattern axes, hole centerlines. Effort: M.
- **D8 — Datum Point** (`gp_Pnt`): coords · vertex · edge-mid · intersection. Render as a
  marker; used for D4/hole centers. Effort: S–M.

### Projected / derived geometry (Fusion's Project/Include/Intersect)
- **D11 — Project / Include** edges/faces/points onto the active sketch
  (`BRepProj_Projection`, `GeomAPI_ProjectPointOnSurf`); associative. Effort: L.
- **D12 — Intersect** — sketch lines where the plane slices a body
  (`BRepAlgoAPI_Section`). Effort: M.

### Parametric
- **D13 — Associative recompute** (needs **P1** feature tree): re-run a datum's `method`
  over its `refs` when referenced geometry changes. Effort: L.

### Cleanup
- **D10 — Retire the raw point+vector Custom tab.** `PlaneSelector` becomes "pick an
  origin plane / existing datum"; all custom planes go through the D2–D6 Construct
  commands. Effort: S.

Effort: S ≈ ½ day · M ≈ 1–2 days · L ≈ 3+ days.

## Recommended sequence
1. **D0** — model + persistent amber rendering (the look + decoupling). Everything hangs
   off this.
2. **D1 + D9** — origin datums you can **sketch on later** = the full create→tree→sketch
   loop the user asked for, end to end.
3. **D2 Offset → D4 Three-Point → D5 Midplane → D3 Angle** — the high-value plane types,
   in rough usage order.
4. **D7 Axis + D8 Point** — references that D3/D4/holes/patterns build on.
5. **D6** advanced planes, **D11/D12** project/intersect.
6. **D10** retire the old custom UI; **D13** associativity once **P1** exists.

## Codebase reuse (don't reinvent)
- **`Workplane`** is already the plane payload — datum params just persist it.
- **`startSketchSession(wp)`** already starts a sketch from any `Workplane` (camera
  follows) — D9 is mostly wiring.
- **`useCADSketchFacePick`** is the reference for hover-pick-derive-a-plane; the new
  reference-pick interactions (pick face/edge/point/datum) clone its structure.
- **`getPlacedShape(id)`** bakes gizmo transforms — use it when a datum references a
  moved body (same fix applied to extrude Up-to-*).
- **`depthWrite:false`** translucent overlays are already used (workplane fill, S2 faces)
  — the amber datum reuses that exact recipe.
- Datum render path mirrors the **`cad-add-mesh`/Viewport3D** sync, but datums have no
  registry solid — they render straight from `params`.

## Sources
- [Fusion: Construction geometry](https://help.autodesk.com/view/fusion360/ENU/?contextId=SLD-CONSTRUCT-TOOLS) ·
  [Create an offset plane](https://help.autodesk.com/view/fusion360/ENU/?guid=SLD-CONSTRUCT-OFFSET-PLANE) ·
  [Create a sketch on a plane/face](https://productdesignonline.com/tips-and-tricks/how-to-create-a-new-sketch-on-a-plane-or-face-in-fusion-360/)
- [OCC `gp_Pln`](https://dev.opencascade.org/doc/refman/html/classgp___pln.html) ·
  [`gce_MakePln`](https://dev.opencascade.org/doc/occt-7.3.0/refman/html/classgce___make_pln.html) ·
  [`GC_MakePlane`](https://dev.opencascade.org/doc/occt-7.3.0/refman/html/class_g_c___make_plane.html) ·
  [`Geom_Plane`](https://dev.opencascade.org/doc/refman/html/class_geom___plane.html)
</content>
