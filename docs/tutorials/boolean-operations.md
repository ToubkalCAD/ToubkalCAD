# Using Boolean Operations

Combine overlapping primitives with Union, Subtract, and Intersect.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 25 minutes |
| **Required tools** | ToubkalCAD; Box and Cylinder primitives; Boolean tools |

## Learning objectives

- Distinguish base and tool bodies.
- Apply Union, Subtract, and Intersect.
- Re-edit a Boolean result from the model tree.

## Final expected result

A box with a cylindrical through-hole, plus familiarity with all three Boolean
result types.

## Steps

1. Create a `50 × 40 × 20 mm` box and rename it `Base`.
2. Create a cylinder with radius `8 mm` and height `30 mm`.
3. Select the cylinder and use the Transform properties or gizmo to place it so
   it crosses the box completely.
4. Select **Modify → Boolean → Intersect**.
5. In the Boolean panel, click the box as **BASE**, then the cylinder as **TOOLS**.
6. Inspect the overlap preview, then click **Cancel** to preserve the inputs.
7. Start **Union**, pick the same base and tool, inspect the combined preview, and
   cancel again.
8. Start **Subtract**, pick the box as base and the cylinder as tool.
9. Confirm that the preview shows a hole and click **Apply**.
10. Double-click the Boolean result, switch temporarily among Union, Subtract,
    and Intersect, then return to **Subtract** and click **Update**.
11. Inspect the complete hole from both ends and save.

## Tips

- Think of the formula as `result = base operation tool`.
- Pick bodies from the model tree when one is hidden inside another.
- Ensure subtracting tools extend beyond the base on both sides.

## Common mistakes

- **Reversing base and tool:** subtraction is order-dependent.
- **Bodies do not overlap:** transform the tool until a visible intersection exists.
- **Selecting a sketch or surface:** solid Booleans require shape-bearing solids.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Complex Boolean workflows](./complex-booleans)
- [Selection and model tree](/user-guide/selection-and-model-tree)

## Summary

You compared all Boolean modes and created a subtractive feature with explicit
base/tool selection.
