# Reference Geometry

Reference geometry provides construction elements that other features can use
without adding material to the model.

## Available reference types

ToubkalCAD includes origin planes and tools for offset, three-point, midplane,
angle, tangent, and curve-normal planes, along with reference axes and points.

## When to use it

- Create sketches away from the origin.
- Define a stable axis for revolve or circular pattern features.
- Place symmetric geometry around a midplane.
- Build features at an angle.
- Reduce dependence on faces and edges likely to change.

Reference objects participate in the feature dependency graph. Give important
references meaningful names and create them before the features that consume
them.

For implementation-level design notes, see the repository's
[reference geometry document](https://github.com/ToubkalCAD/ToubkalCAD/blob/main/docs/REFERENCE-GEOMETRY.md).
