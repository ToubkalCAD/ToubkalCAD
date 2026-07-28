# Creating a Rectangle with Exact Dimensions

Use ToubkalCAD's live sketch dimension fields to create a precise rectangle at
placement time.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 12 minutes |
| **Required tools** | ToubkalCAD; keyboard and pointing device |

## Learning objectives

- Enter exact width and height while drawing.
- Understand the rectangle's automatic horizontal, vertical, and coincident
  relationships.
- Verify the profile before using it downstream.

## Final expected result

An XY-plane rectangle measuring `60 mm × 40 mm`.

## Steps

1. Start a new project and choose **Sketch → Create Sketch → XY Plane**.
2. Choose **Rect**.
3. Click once to place the first corner near the sketch origin.
4. Move the pointer into the opposite quadrant. The live **W** and **H** fields
   appear and the first field is selected automatically.
5. Type `60` for the width.
6. Press <kbd>Tab</kbd>, type `40` for the height, then press <kbd>Enter</kbd>.
7. Inspect the four generated line entities. ToubkalCAD adds horizontal,
   vertical, and corner-coincident relationships for the rectangle.
8. If dimensions are hidden, click **Show Dims**.
9. Click **Quit Sketch**.
10. Save the project as `exact-rectangle`.

## Tips

- The selected live field accepts typing immediately; you do not need to click it.
- Enter positive magnitudes and control direction with the pointer quadrant.
- Press <kbd>Esc</kbd> to step back if the first corner is misplaced.

## Common mistakes

- **Clicking a second corner before typing:** this accepts the approximate cursor
  dimensions.
- **Using Smart Dimension after creating conflicting values:** edit or remove an
  existing driving dimension instead of duplicating it.
- **Entering zero:** a rectangle needs non-zero width and height.

## Related documentation

- [Sketching guide](/user-guide/sketching/)
- [Creating a circle and applying dimensions](./dimensioned-circle)
- [Constraint-driven sketch design](./constraint-driven-sketch)

## Summary

You used the live dimension overlay to place a precise `60 mm × 40 mm`
rectangle with automatic geometric relationships.
