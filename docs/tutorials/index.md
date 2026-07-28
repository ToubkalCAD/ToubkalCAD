# Tutorials

These task-based tutorials teach complete ToubkalCAD workflows using features
available in the current application. Start with the beginner path, then move to
multi-feature parts and supported advanced workflows.

::: tip Before you begin
Use a supported desktop browser, wait for OpenCascade to finish loading, and save
a new project version before major modeling changes.
:::

## Beginner

Build confidence with the workspace, sketches, basic solids, and project files.

1. [Introduction to the ToubkalCAD Interface](./interface-tour) — locate the
   commands, tree, viewport, properties, and status areas.
2. [Navigating the 3D Viewport](./viewport-navigation) — orbit, pan, zoom, frame,
   and use precise camera views.
3. [Creating a New Project](./new-project) — start cleanly, name an object, and
   establish a first save point.
4. [Creating a Basic 2D Sketch](./basic-2d-sketch) — draw and close a line-based
   profile.
5. [Creating a Rectangle with Exact Dimensions](./exact-rectangle) — enter width
   and height during placement.
6. [Creating a Circle and Applying Dimensions](./dimensioned-circle) — control
   size and position.
7. [Creating a Simple 3D Part from a Sketch](./sketch-to-part) — extrude a
   profile into a solid.
8. [Editing an Existing Feature](./edit-feature) — update a feature and its
   source sketch.
9. [Saving and Exporting a Model](./save-and-export) — preserve the editable
   project and export STEP geometry.

## Intermediate

Combine tools into practical part-modeling workflows.

1. [Creating a Mechanical Bracket](./mounting-bracket) — build an L-bracket with
   additive, subtractive, and finishing features.
2. [Creating a Plate with Holes](./plate-with-holes) — cut multiple dimensioned
   profiles through a plate.
3. [Creating a Hollow Enclosure](./hollow-enclosure) — remove a face and create
   uniform walls.
4. [Using Boolean Operations](./boolean-operations) — compare Union, Subtract,
   and Intersect.
5. [Creating Repeated Features](./repeated-features) — pattern a tool and create
   repeated holes.
6. [Importing and Modifying an Existing Model](./import-and-modify) — work with
   STEP or IGES geometry without assuming feature history.
7. [Organizing Objects in the Model Tree](./model-tree-organization) — name,
   group, reorder, hide, and lock objects.
8. [Working with Multiple Sketches](./multiple-sketches) — coordinate base and
   downstream feature profiles.

## Advanced

These tutorials cover only advanced capabilities implemented in the current
ToubkalCAD build.

1. [Building a Parametric Feature Chain](./parametric-modeling) — manage design
   intent and downstream recomputation.
2. [Constraint-Driven Sketch Design](./constraint-driven-sketch) — fully control
   a profile with solver-supported relationships.
3. [Multi-Body Modeling](./multi-body-modeling) — organize and combine
   independent solids.
4. [Complex Boolean Workflows](./complex-booleans) — stage additive and
   subtractive operations for reliability.
5. [Creating a Lofted Transition](./advanced-occ-operations) — use datum planes
   and multiple profiles in an OpenCascade loft.
6. [Optimizing Performance for Large Models](./performance-large-models) —
   simplify and stage expensive operations.
7. [Preparing STEP Geometry for Manufacturing](./step-manufacturing) — inspect,
   export, and independently validate a final solid.

## What is intentionally not covered

Tutorials do not claim support for tools that are not in the application.
Examples include native STL export and reconstruction of editable feature
history from imported STEP or IGES files. See
[Current Limitations](/reference/current-limitations) for important boundaries.
