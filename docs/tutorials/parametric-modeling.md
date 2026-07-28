# Building a Parametric Feature Chain

Create a model whose base size, thickness, hole, and edge treatment can be
changed through an ordered dependency chain.

| | |
| --- | --- |
| **Difficulty level** | Advanced |
| **Estimated completion time** | 45 minutes |
| **Required tools** | ToubkalCAD; Sketch constraints, Extrude, Pocket, and Fillet |

## Learning objectives

- Plan upstream and downstream feature dependencies.
- Re-edit sketches and 3D operations without rebuilding the model.
- Diagnose the first invalid feature after a design change.

## Final expected result

A parameter-driven plate with a pocket and fillet that survives a controlled
base-width and thickness change.

## Steps

1. Create a base sketch from four lines on the XY plane.
2. Apply horizontal, vertical, and coincident constraints to keep it rectangular.
3. Add driving width and height dimensions of `100 mm` and `60 mm`.
4. Anchor one corner to the origin and confirm the solver is not conflicting.
5. Quit the sketch and extrude it `10 mm` as a new solid.
6. Create a second sketch on the top face with a centered `40 × 20 mm` rectangle.
7. Pocket the second profile `5 mm` into the plate.
8. Add a `2 mm` fillet to selected outer edges only.
9. Save a baseline project version.
10. Re-edit the base sketch and change the width to `120 mm`; quit the sketch and
    inspect the recomputed chain.
11. Re-edit the base extrusion and change its thickness to `12 mm`.
12. Confirm that the pocket remains inside the body and the fillet still has
    valid edges.
13. If a feature fails, undo, reduce the topology change, and inspect the first
    downstream feature whose reference no longer resolves.
14. Save the revised project under a new versioned name.

## Tips

- Put design-driving dimensions in early sketches.
- Add cosmetic blends last because their edge references are more sensitive to
  topology changes.
- Use stable datum planes instead of late-generated faces when practical.

## Common mistakes

- **Changing many parameters at once:** isolate one change before diagnosing.
- **Editing the final mesh instead of its source:** re-edit the relevant tree node.
- **Ignoring the first failure:** later errors are often consequences of one
  broken upstream reference.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Reference geometry guide](/user-guide/reference-geometry/)
- [Architecture overview](/developer/architecture-overview)
- [Current limitations](/reference/current-limitations)

## Summary

You built and tested an editable feature chain, applied changes at their proper
source, and used feature order to reason about recomputation.
