# Editing an Existing Feature

Reopen a feature from the model tree, change a parameter, and update dependent
geometry.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 12 minutes |
| **Required tools** | ToubkalCAD; completed [simple sketch part](./sketch-to-part) |

## Learning objectives

- Re-edit an extrusion from the model tree.
- Resume and change a source sketch.
- Observe parametric recomputation and recover with undo.

## Final expected result

The simple plate updated from `8 mm` to `12 mm` thick, with its source sketch
still editable.

## Steps

1. Open the simple sketch part project.
2. Double-click the extrusion node in the model tree. Alternatively, right-click
   it and choose **Re-edit**.
3. Change **Limit 1** from `8 mm` to `12 mm`.
4. Check the live preview and click **Update**.
5. Select the result and inspect it in isometric view.
6. In the model tree, double-click the source sketch to resume it.
7. Open **Constraints** or edit an existing dimension annotation.
8. Change one safe driving dimension, such as the plate width from `60 mm` to
   `70 mm`, and confirm that the solver reports a valid state.
9. Click **Quit Sketch**. The dependent extrusion recomputes.
10. If the result is not intended, press <kbd>Ctrl</kbd>+<kbd>Z</kbd>; otherwise
    save a new project version.

## Tips

- Save before changing an upstream feature with many dependents.
- Double-clicking a primitive edits its dimensions; double-clicking a sketch
  resumes it; double-clicking a 3D operation reopens its feature panel.
- Change one parameter at a time when diagnosing recompute failures.

## Common mistakes

- **Renaming instead of editing:** operation nodes reserve double-click for
  re-editing; ordinary non-operation nodes use it for rename.
- **Creating a second feature:** use **Update**, not a new Extrude command.
- **Making a profile invalid:** keep the sketch closed and avoid conflicting
  constraints.

## Related documentation

- [Part modeling guide](/user-guide/part-modeling/)
- [Selection and model tree](/user-guide/selection-and-model-tree)
- [Parametric modeling workflow](./parametric-modeling)

## Summary

You updated both a feature parameter and its upstream sketch, then allowed
ToubkalCAD to recompute the result.
