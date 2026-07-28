# Creating a Simple 3D Part from a Sketch

Turn a dimensioned rectangle into a solid plate with the Extrude feature.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 15 minutes |
| **Required tools** | ToubkalCAD |

## Learning objectives

- Select a sketch profile for extrusion.
- Set an exact extrusion limit.
- Distinguish a sketch, source geometry, and resulting feature in the tree.

## Final expected result

A `60 mm × 40 mm × 8 mm` rectangular solid.

## Steps

1. Complete the [exact rectangle tutorial](./exact-rectangle), or create a new
   `60 mm × 40 mm` rectangle on the XY plane.
2. Click **Quit Sketch**.
3. Select the sketch container in the model tree.
4. Open the **Model** tab and choose **Extrude**.
5. In **Profiles**, keep the rectangle profile selected.
6. Set **Limit** to **Blind**.
7. Set **Limit 1** to `8 mm`.
8. Leave **Reverse** off, **Draft** at `0°`, and **Wall** at `0 mm`.
9. Set **Result** to **New**.
10. Inspect the live preview, then click **Apply**.
11. Press <kbd>5</kbd> for isometric view and <kbd>F</kbd> to frame the selected
    result.
12. Save the project as `simple-sketch-part`.

## Tips

- Use **Reverse** if the preview grows in the wrong direction.
- A non-zero **Wall** creates a thin-walled extrusion; keep it at zero for this
  solid plate.
- Prefer simple base features before adding holes, fillets, or shells.

## Common mistakes

- **Extrude is disabled:** quit the sketch and select its container or profile.
- **No valid profile:** close all gaps or run **Sketch → Region**.
- **Choosing Pad without a target:** use **New** for the first solid.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Exact rectangle tutorial](./exact-rectangle)
- [Editing an existing feature](./edit-feature)

## Summary

You converted an exact 2D profile into a new solid using a controlled blind
extrusion.
