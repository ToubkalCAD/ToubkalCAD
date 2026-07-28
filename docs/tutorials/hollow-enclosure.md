# Creating a Hollow Enclosure

Turn a solid box into an open-top enclosure with the Shell tool.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 20 minutes |
| **Required tools** | ToubkalCAD; Box primitive and Shell tool |

## Learning objectives

- Select removable faces for a shell operation.
- Choose inward or outward wall direction.
- Diagnose thickness values that OpenCascade cannot construct.

## Final expected result

An open-top `80 × 50 × 30 mm` enclosure with `2 mm` inward walls.

## Steps

1. Start a new project and create a box with **Width X** `80`, **Height Y** `50`,
   and **Depth Z** `30`.
2. Rename the box `Enclosure Blank`.
3. Press <kbd>5</kbd> for isometric view and frame the box.
4. Select the box, then choose **Modify → Shell**.
5. In the viewport, click the top face. The panel should report one open face.
6. Choose **Hollow inward** so the outer dimensions remain unchanged.
7. Enter `2 mm` for **Wall thickness**.
8. Inspect the live preview from several angles.
9. Click **Apply**.
10. Hide and show the source/result nodes as needed, then inspect the interior.
11. Save the project as `hollow-enclosure`.

## Tips

- Start with a small wall thickness and increase it gradually.
- Select more than one face when the design needs multiple openings.
- Shell the main form before adding small fillets or holes.

## Common mistakes

- **Selecting an edge instead of a face:** Shell expects faces to remove.
- **Thickness is too large:** reduce it below the smallest local feature size.
- **Using a surface body:** Shell requires an enclosed solid; thicken or solidify
  a surface first.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Current limitations](/reference/current-limitations)
- [Advanced OpenCascade operations](./advanced-occ-operations)

## Summary

You removed a face and offset the remaining faces inward to create a uniform
hollow enclosure.
