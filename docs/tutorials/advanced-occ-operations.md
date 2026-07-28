# Creating a Lofted Transition

Use offset datum planes and multiple sketches to create a smooth OpenCascade
loft through controlled profiles.

| | |
| --- | --- |
| **Difficulty level** | Advanced |
| **Estimated completion time** | 50 minutes |
| **Required tools** | ToubkalCAD; datum planes, Sketch, Circle, Ellipse, and Loft |

## Learning objectives

- Build profiles on separated datum planes.
- Order compatible profiles for a loft.
- Choose solid/shell and smooth/ruled loft behavior.

## Final expected result

A solid transition that changes from a circle through an ellipse to a smaller
circle.

## Steps

1. Create an origin datum plane on XY if one is not already present.
2. Create two offset datum planes parallel to XY at `40 mm` and `80 mm`.
3. Create a sketch on the first plane and draw a `50 mm` diameter circle centered
   on the origin.
4. Quit the sketch and name it `Loft Profile 1`.
5. Create a sketch on the `40 mm` plane and draw a centered ellipse with
   approximately `35 mm` and `22 mm` principal dimensions.
6. Quit and name it `Loft Profile 2`.
7. Create a sketch on the `80 mm` plane and draw a centered `20 mm` diameter
   circle.
8. Quit and name it `Loft Profile 3`.
9. In the model tree, select the three profiles in spatial order using
   <kbd>Ctrl</kbd> or <kbd>Command</kbd>.
10. Choose **Model → Loft**.
11. Set **Type → Solid** and **Surface → Smooth**.
12. Inspect the preview for twisting, then apply.
13. Re-edit the loft and compare **Ruled** to **Smooth**; keep the intended result.
14. Save and inspect the final shape with Analysis or Measure.

## Tips

- Keep profile centers aligned for the first loft exercise.
- Use a consistent profile direction and selection order.
- A Sweep is also available: select the profile first and the spine second, then
  choose **Model → Sweep**.

## Common mistakes

- **Selecting profiles out of order:** select from one end to the other.
- **Using open profiles for a solid loft:** use closed loops.
- **Introducing too many detailed sections:** start with simple analytic curves.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Reference geometry guide](/user-guide/reference-geometry/)
- [Current limitations](/reference/current-limitations)

## Summary

You created a multi-section solid loft on stable datum planes and learned the
selection-order and profile-simplicity practices OpenCascade operations require.
