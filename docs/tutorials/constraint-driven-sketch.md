# Constraint-Driven Sketch Design

Build a fully controlled rectangular profile from individual line entities and
driving constraints.

| | |
| --- | --- |
| **Difficulty level** | Advanced |
| **Estimated completion time** | 40 minutes |
| **Required tools** | ToubkalCAD; Line, Smart Dimension, and Constraints panel |

## Learning objectives

- Combine geometric and dimensional constraints.
- Read degrees-of-freedom and conflict feedback.
- Avoid duplicate and contradictory relationships.

## Final expected result

A fully constrained `80 × 50 mm` four-line rectangle anchored at the origin.

## Steps

1. Create an XY-plane sketch and draw four approximate connected lines.
2. Open **Constraints**.
3. Select each horizontal edge and apply **Horizontal**.
4. Select each vertical edge and apply **Vertical**.
5. At every corner, select the two meeting endpoints and apply **Coincident** if
   the relationship was not created automatically.
6. Select the lower-left endpoint and the sketch origin, then apply **Coincident**
   to anchor the profile.
7. Choose **Dimension**, select the bottom line, place its annotation, and set
   **Length** to `80 mm`.
8. Dimension one vertical line to `50 mm`.
9. Return to the Constraints panel and inspect the degrees-of-freedom state.
10. If degrees of freedom remain, select opposite lines and apply **Parallel** or
    **Equal** only when the relationship expresses real design intent.
11. Deliberately attempt to add a duplicate horizontal constraint and observe
    that ToubkalCAD blocks or reports the redundant relationship.
12. Remove any experimental redundant constraint and confirm a valid solved state.
13. Quit the sketch and save it as a reusable constrained profile.

## Tips

- Geometric constraints define relationships; dimensions define values.
- Anchor the profile only after its internal relationships are stable.
- Use the smallest constraint set that completely expresses the design.

## Common mistakes

- **Using Fixed too early:** it can hide missing design intent and conflict with
  later dimensions.
- **Dimensioning both opposite equal edges:** one size plus equality is clearer.
- **Selecting whole lines when endpoints are required:** zoom in and pick the
  endpoint markers.

## Related documentation

- [Sketching guide](/user-guide/sketching/)
- [Part modeling guide](/user-guide/part-modeling/)
- [Exact rectangle tutorial](./exact-rectangle)

## Summary

You controlled a sketch with purposeful relationships and dimensions while using
solver feedback to avoid over-constraint.
