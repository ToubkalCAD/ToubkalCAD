# Creating a Mechanical Bracket

Build an L-shaped mounting bracket from two controlled extrusions, add a hole,
and finish selected edges.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 35 minutes |
| **Required tools** | ToubkalCAD; sketch, Extrude, Pocket, and Fillet tools |

## Learning objectives

- Build features on a datum plane and a planar face.
- Add material with **Pad** and remove it with **Pocket**.
- Apply a conservative finishing feature after the main geometry.

## Final expected result

An L-bracket with a `70 × 50 × 8 mm` base, a `50 × 40 × 8 mm` upright, and a
`10 mm` diameter mounting hole.

## Steps

1. Create an XY-plane sketch and draw a `70 × 50 mm` rectangle.
2. Quit the sketch, select it, and extrude `8 mm` with **Result → New**.
3. Rename the feature `Bracket Base`.
4. Choose **Sketch → Sketch Plane → On Face**, then select a narrow side face of
   the base.
5. Draw a `50 × 40 mm` rectangle positioned so its lower edge meets the base.
6. Quit the sketch and extrude it `8 mm` with **Result → Pad**.
7. Use **Pick target** in the Extrude panel and select `Bracket Base`, then apply.
8. Start another sketch on the upright's broad face.
9. Draw a circle, enter `10 mm` in the live diameter field, and position its
   center with dimensions.
10. Quit the sketch and extrude the circle with **Result → Pocket**.
11. Pick the bracket as the target and use a length that passes fully through the
    upright, reversing direction if the preview points outward.
12. Select the final bracket, choose **Modify → Fillet**, select only the inside
    joining edge, start with a `2 mm` radius, and apply.
13. Inspect all sides, save the project, and export the final result to STEP.

## Tips

- Create structural features before fillets and chamfers.
- Use **Pad** and **Pocket** to preserve the explicit target relationship.
- If face-based references become unstable during redesign, rebuild the upright
  from a stable datum plane.

## Common mistakes

- **Pad or Pocket has no target:** activate **Pick target** and select the solid.
- **Hole does not pass through:** increase the blind length or reverse it.
- **Fillet fails:** reduce the radius or select fewer edges.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Working with multiple sketches](./multiple-sketches)
- [Editing an existing feature](./edit-feature)

## Summary

You created a production-style bracket by adding and removing material in a
deliberate feature order, then added a final edge treatment.
