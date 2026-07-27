# Part Modeling

Part modeling creates solids from primitives, sketches, and ordered features.

## Create base geometry

Use a primitive such as Box, Cylinder, Sphere, Torus, or Cone for a quick base
shape. For design-controlled parts, start with a constrained sketch.

## Shape features

- **Extrude** moves a profile along a straight direction.
- **Revolve** rotates a profile around an axis.
- **Sweep** carries a profile along a path.
- **Loft** transitions through multiple profiles.
- **Mirror** and linear or circular arrays repeat existing geometry.

## Modify solids

Fillet, chamfer, shell, and Boolean union, subtract, or intersect operations
modify existing bodies. Select the required faces, edges, or bodies before
starting the command.

## Model robustly

1. Use simple, fully controlled base sketches.
2. Add major shape features before cosmetic fillets and chamfers.
3. Prefer datum references when a stable reference is available.
4. Use conservative parameter values and increase them gradually.
5. Save before changing a feature with many downstream dependents.

If an operation fails, inspect profile closure, selected geometry, operation
direction, and whether the requested result is geometrically possible.
