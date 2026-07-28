# Organizing Objects in the Model Tree

Rename, reorder, group, hide, and lock objects so a growing model remains
understandable.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 20 minutes |
| **Required tools** | ToubkalCAD; a project containing several objects |

## Learning objectives

- Rename and reorder model-tree nodes.
- Group features in a component.
- Control visibility, locking, and the active component.

## Final expected result

A component named `Bracket Part` containing clearly named source sketches and
features in logical order.

## Steps

1. Open a project containing at least one sketch and two solid operations.
2. Double-click an ordinary node name, enter a descriptive name such as
   `Base Sketch`, and press <kbd>Enter</kbd>.
3. Rename the main solid result and any cutting-tool nodes.
4. Open **Model → Structure → Component** to create a component.
5. Rename it `Bracket Part`.
6. Right-click the component and choose **Set as active** so new features land
   inside it.
7. Drag appropriate nodes into the component. Use the middle of the component row
   for an “into” drop.
8. Reorder sibling nodes by dragging near the top or bottom edge of a row.
9. Use the eye control to hide source or tool geometry that obscures the result.
10. Use the lock control on reference objects you do not want to move accidentally.
11. Collapse the component and confirm that the tree now communicates the model's
    structure at a glance.

## Tips

- Use nouns for sketches and results, such as `Mounting Holes` and `Final Bracket`.
- Keep upstream sources above downstream results.
- A rejected drag indicates that the proposed parent-child relationship is invalid.

## Common mistakes

- **Double-clicking an operation to rename:** operations use double-click for
  re-editing; rename other suitable nodes and use generated operation names when
  necessary.
- **Hiding the final result instead of a source:** check the selected row first.
- **Moving dependencies arbitrarily:** preserve a logical feature order.

## Related documentation

- [Selection and model tree](/user-guide/selection-and-model-tree)
- [Parametric modeling workflow](./parametric-modeling)
- [Multi-body modeling](./multi-body-modeling)

## Summary

You converted a flat list of objects into a named, ordered, and manageable
component structure.
