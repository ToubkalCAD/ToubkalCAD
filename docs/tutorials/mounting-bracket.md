# Model a Mounting Bracket

In this tutorial you will sketch a rectangular plate, extrude it, add a hole,
and soften selected edges.

## Before you begin

Complete [Create Your First Model](/getting-started/first-model). Save the
project after each major feature so you can recover from an invalid operation.

## 1. Sketch the base

1. Start a blank document.
2. Open the **Sketch** tab and choose **Create Sketch**.
3. Select the XY plane.
4. Draw a rectangle centered near the sketch origin.
5. Add horizontal and vertical dimensions for the plate size.
6. Constrain the rectangle so it no longer moves unexpectedly.
7. Finish the sketch.

## 2. Extrude the plate

1. Select the completed sketch in the model tree.
2. Open **Model** and choose **Extrude**.
3. Enter the plate thickness.
4. Confirm the feature.

## 3. Add a mounting hole

1. Create a new sketch on the plate's top face.
2. Draw a circle.
3. Dimension its diameter and its position relative to the plate edges.
4. Finish the sketch.
5. Extrude the circular profile through the plate using a subtractive operation.

If the cut fails, confirm the profile is closed and that its extrusion crosses
the complete plate.

## 4. Finish the edges

1. Select one or more outer edges.
2. Choose **Modify → Fillet** or **Chamfer**.
3. Enter a conservative radius or distance.
4. Confirm the feature.

Large values can make a feature geometrically impossible. Reduce the value if
the operation fails.

## 5. Inspect and save

Fit the model in view, rotate it to inspect the underside, and use the Measure
properties to check important dimensions. Save the project.

## What you learned

- Sketches define editable profiles.
- Dimensions and constraints capture design intent.
- Later features depend on earlier geometry.
- Modeling order and valid parameter ranges affect recomputation.
