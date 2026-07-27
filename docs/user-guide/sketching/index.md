# Sketching

Sketches create the two-dimensional profiles used by many solid and surface
features.

## Create a sketch

Choose **Create Sketch**, then select a base plane or suitable planar face. A
stable datum plane is usually a better long-term reference than a face created
late in the feature history.

## Geometry tools

The Sketch ribbon includes lines, circles, rectangles, arcs, ellipses, Bézier
curves, splines, rounded rectangles, and polygons. Editing tools include trim,
extend, split, power trim, sketch fillet, and sketch chamfer.

## Constraints and dimensions

Constraints express geometric relationships; dimensions define measurable
values. Use both to capture design intent and prevent profiles from moving
unexpectedly.

Typical workflow:

1. Draw approximate geometry.
2. Add relationships such as horizontal, vertical, coincident, or tangent.
3. Add the dimensions that control the design.
4. Verify that the profile is closed when a solid feature requires a region.
5. Finish the sketch and use it in a modeling feature.

Projected and intersection references can connect a sketch to existing
geometry. These links are powerful, but changes to their source geometry can
affect downstream recomputation.
