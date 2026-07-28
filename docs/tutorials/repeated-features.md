# Creating Repeated Features

Use a linear pattern to repeat a cutting tool, then subtract the pattern from a
plate.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 30 minutes |
| **Required tools** | ToubkalCAD; primitives, Transform pattern, and Boolean Subtract |

## Learning objectives

- Create a 3D linear pattern along a chosen global axis.
- Understand count and spacing semantics.
- Use a patterned compound as a Boolean tool.

## Final expected result

A plate with four equally spaced circular holes.

## Steps

1. Create an `100 × 40 × 6 mm` box and rename it `Pattern Plate`.
2. Create a cylinder with radius `3 mm` and height `10 mm`.
3. Move the cylinder so it crosses the plate and its axis is aligned with Z.
4. Position its center `20 mm` from one end and centered across the plate width.
5. Select the cylinder.
6. Open **Model → Transform → Lin Array**.
7. Enter `0` for **Axis** (X), `20 mm` for **Spacing**, and `4` for **Count
   (incl. original)**.
8. Apply the pattern and inspect all four cylinders.
9. Choose **Modify → Boolean → Subtract**.
10. Pick `Pattern Plate` as the base and the linear-pattern result as the tool.
11. Apply the Boolean and inspect the underside to confirm four through-holes.
12. Save the project.

## Tips

- Axis values are `0=X`, `1=Y`, and `2=Z`.
- Count includes the original instance.
- Circular patterns use a global-axis rotation around the origin; position source
  geometry accordingly before patterning.

## Common mistakes

- **Using count as number of copies:** `4` means four total instances.
- **Pattern runs in the wrong direction:** choose the correct axis before applying.
- **Cut fails:** ensure every patterned cylinder crosses the plate.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Using Boolean operations](./boolean-operations)
- [Performance optimization](./performance-large-models)

## Summary

You created a four-instance solid pattern and used it as one organized cutting
tool.
