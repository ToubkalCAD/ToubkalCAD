# Working with Multiple Sketches

Create a base feature and a second face-based sketch that controls a pocket.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 25 minutes |
| **Required tools** | ToubkalCAD; Sketch, On Face, Extrude, and Pocket |

## Learning objectives

- Distinguish independent sketch containers.
- Resume the correct sketch from the model tree.
- Build and update a downstream feature from a secondary sketch.

## Final expected result

A `60 × 40 × 10 mm` block with a centered `24 × 16 mm` rectangular pocket.

## Steps

1. Create `Sketch 1` on the XY plane and draw a `60 × 40 mm` rectangle.
2. Quit the sketch and extrude it `10 mm` as a new solid.
3. Rename the first sketch `Block Outline`.
4. Choose **Sketch → Sketch Plane → On Face** and pick the top face.
5. Draw a `24 × 16 mm` rectangle near the center.
6. Use dimensions or symmetry around the origin projection to control its position.
7. Quit the sketch and rename it `Pocket Profile`.
8. Select `Pocket Profile` and choose **Extrude**.
9. Set **Result → Pocket**, set the depth to `5 mm`, pick the block as target,
   and apply.
10. Double-click `Pocket Profile` in the tree to resume it.
11. Change its width from `24 mm` to `30 mm`, then click **Quit Sketch**.
12. Confirm that the pocket recomputes while the base outline remains unchanged.

## Tips

- Name sketches by purpose, not sequence.
- Only one sketch session can be active at a time.
- Use datum planes for long-lived references when face topology may change.

## Common mistakes

- **Editing the wrong sketch:** select by descriptive tree name.
- **Starting another sketch before quitting:** finish the active session first.
- **Pocket grows outward:** reverse the extrusion direction.

## Related documentation

- [Sketching guide](/user-guide/sketching/)
- [Reference geometry guide](/user-guide/reference-geometry/)
- [Editing an existing feature](./edit-feature)

## Summary

You coordinated two sketches with different roles and updated a downstream
pocket through its own source profile.
