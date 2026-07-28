# Creating a Circle and Applying Dimensions

Create a circle, give it an exact diameter, and control its center relative to
the sketch origin.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 15 minutes |
| **Required tools** | ToubkalCAD; keyboard and pointing device |

## Learning objectives

- Create a circle with an exact initial diameter.
- Use **Smart Dimension** on a sketch entity.
- Position a circle center with horizontal and vertical distances.

## Final expected result

A circle with a `20 mm` diameter whose center is located predictably from the
sketch origin.

## Steps

1. Create a new XY-plane sketch.
2. Choose **Circle** and click to place its center away from the origin.
3. Move the pointer outward. In the live **Ø** field, type `20` and press
   <kbd>Enter</kbd>.
4. Choose **Dimension**.
5. Click the circle, move the pointer away, and click empty sketch space to place
   the radial dimension annotation.
6. Edit the displayed value only if it is not already a `10 mm` radius.
7. With **Dimension** active, click the circle center and then the sketch origin.
8. Move mostly horizontally and click empty space to place a horizontal distance;
   set it to `30 mm`.
9. Repeat the center-to-origin selection, move mostly vertically, place the
   vertical distance, and set it to `20 mm`.
10. Open **Constraints** and confirm there is no conflict or over-constrained
    warning.
11. Close the panel and click **Quit Sketch**.

## Tips

- ToubkalCAD displays circle size as diameter while drawing, but the constraint
  solver stores a radius dimension.
- Pointer direction helps Smart Dimension choose horizontal or vertical distance.
- Place annotations away from the profile to keep the sketch readable.

## Common mistakes

- **Selecting the curve instead of its center:** zoom in until the center point is
  easy to pick.
- **Adding both radius and diameter-like controls:** keep one driving size value.
- **Fixing the circle before positioning it:** Fixed plus location dimensions can
  over-constrain the sketch.

## Related documentation

- [Sketching guide](/user-guide/sketching/)
- [Exact rectangle tutorial](./exact-rectangle)
- [Constraint-driven sketch design](./constraint-driven-sketch)

## Summary

You created a precisely sized circle and used driving dimensions to control its
location relative to the origin.
