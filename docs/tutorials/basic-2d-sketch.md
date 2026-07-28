# Creating a Basic 2D Sketch

Create a sketch on the XY plane and draw a closed profile from connected lines.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 15 minutes |
| **Required tools** | ToubkalCAD; mouse or trackpad |

## Learning objectives

- Start and quit a sketch session.
- Draw connected line entities on a workplane.
- Recognize why a closed profile is required for a solid extrusion.

## Final expected result

A closed four-line profile stored inside an XY-plane sketch container.

## Steps

1. Create a new project and open the **Sketch** ribbon tab.
2. Choose **Create Sketch**.
3. Select **XY Plane** in the plane selector and confirm.
4. Choose **Line**.
5. Click near the lower-left of the origin to place the first endpoint.
6. Move horizontally and click to place the second endpoint.
7. Choose **Line** again and draw the right edge from the previous endpoint.
8. Repeat for the top and left edges, snapping the final endpoint to the first.
9. Inspect the model tree. The four lines should be children of one sketch.
10. Click **Quit Sketch** in the persistent ribbon area.
11. Expand the sketch container in the model tree and verify that its line
    entities remain available.

## Tips

- Zoom in before closing the final corner so endpoint snapping is easier.
- A rectangle is faster for rectangular geometry; separate lines are useful here
  for learning entity and constraint behavior.
- Use **Region** if you need ToubkalCAD to detect closed loops from linework.

## Common mistakes

- **Leaving a small gap:** zoom into each corner and make endpoints coincident.
- **Creating separate sketches:** keep the current sketch active until the
  complete profile is drawn.
- **Trying to extrude while still sketching:** click **Quit Sketch** first.

## Related documentation

- [Sketching guide](/user-guide/sketching/)
- [Creating a simple part from a sketch](./sketch-to-part)
- [Constraint-driven sketch design](./constraint-driven-sketch)

## Summary

You created a workplane-based sketch, built a closed profile from individual
entities, and finished the sketch cleanly.
