# Creating a Plate with Holes

Create a rectangular plate and cut two precisely placed mounting holes with a
face-based sketch and Pocket extrusion.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 25 minutes |
| **Required tools** | ToubkalCAD; Sketch, Dimension, Extrude, and Pocket |

## Learning objectives

- Create a secondary sketch on a solid face.
- Dimension multiple circular profiles.
- Remove material from a selected target body.

## Final expected result

An `80 × 50 × 6 mm` plate with two `8 mm` diameter through-holes.

## Steps

1. Create an `80 × 50 mm` rectangle on the XY plane.
2. Quit the sketch and extrude it `6 mm` as a **New** solid.
3. Rename the result `Mounting Plate`.
4. Choose **Sketch → Sketch Plane → On Face** and select the top face.
5. Draw the first circle with an `8 mm` diameter.
6. Use **Dimension** to position its center `15 mm` from the nearest short edge
   and `25 mm` from a long edge.
7. Draw a second `8 mm` circle near the opposite end.
8. Dimension the second center symmetrically, or control the center-to-center
   spacing as `50 mm`.
9. Check the Constraints panel for conflicting dimensions, then quit the sketch.
10. Select the hole sketch and choose **Extrude**.
11. Select both circular profiles in **Profiles**.
12. Set **Result → Pocket**, set a blind length greater than `6 mm`, pick
    `Mounting Plate` as the target, and apply.
13. Inspect the underside to confirm both cuts pass completely through.

## Tips

- Place both holes in one sketch when they share the same design intent.
- Use profile picking when the sketch contains more than one closed loop.
- Keep the cut length slightly greater than the plate thickness for a robust
  through-cut.

## Common mistakes

- **Only one hole is cut:** select both profiles in the Extrude panel.
- **Pocket removes the wrong body:** clear and repick the intended target.
- **Dimensions conflict:** remove redundant location constraints.

## Related documentation

- [Sketching guide](/user-guide/sketching/)
- [Part modeling guide](/user-guide/part-modeling/)
- [Constraint-driven sketch design](./constraint-driven-sketch)

## Summary

You used a multi-profile face sketch and a Pocket operation to create two
controlled through-holes in a plate.
