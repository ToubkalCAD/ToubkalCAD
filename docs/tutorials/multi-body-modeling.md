# Multi-Body Modeling

Manage several independent solids, position them, and combine only the bodies
that belong in the final result.

| | |
| --- | --- |
| **Difficulty level** | Advanced |
| **Estimated completion time** | 40 minutes |
| **Required tools** | ToubkalCAD; primitives, Transform controls, Components, and Booleans |

## Learning objectives

- Keep design bodies separate while positioning them.
- Organize related solids in a component.
- Combine bodies deliberately with Boolean operations.

## Final expected result

A component containing a unioned base-and-boss body plus an independent cutting
tool retained in the project history.

## Steps

1. Create a component and rename it `Multi-body Part`; set it as active.
2. Create a `70 × 50 × 8 mm` box named `Base Body`.
3. Create a cylinder with radius `12 mm` and height `20 mm` named `Boss Body`.
4. Use Transform properties or the gizmo to place the boss so it overlaps the
   center of the base.
5. Save while the bodies are still independent.
6. Choose **Modify → Boolean → Union**.
7. Pick the base as **BASE** and the boss as **TOOLS**, then apply.
8. Create a second cylinder with radius `5 mm` and height `30 mm`.
9. Align it through the center of the boss and rename it `Bore Tool`.
10. Choose **Modify → Boolean → Subtract**, use the union result as base and the
    bore as tool, then apply.
11. Hide source/tool nodes that obscure the final result but retain them in the
    tree for design clarity.
12. Collapse the component and save a new project version.

## Tips

- Treat temporary solids as named design tools, not disposable clutter.
- Save before collapsing several bodies into a Boolean result.
- Use the tree for selecting coincident or internal bodies.

## Common mistakes

- **Unioning non-overlapping bodies:** confirm a real volume overlap.
- **Cutting the wrong result:** use the latest valid solid as the Boolean base.
- **Flattening organization:** keep all related nodes in the active component.

## Related documentation

- [Organizing the model tree](./model-tree-organization)
- [Using Boolean operations](./boolean-operations)
- [Complex Boolean workflows](./complex-booleans)

## Summary

You maintained independent design bodies, organized them, and combined them only
when the final solid relationship was defined.
