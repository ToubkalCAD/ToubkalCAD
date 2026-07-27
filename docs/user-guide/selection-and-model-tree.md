# Selection and Model Tree

Most commands operate on the current selection. You can select geometry in the
viewport or select document objects in the model tree.

## Viewport selection

Click visible geometry to select it. Depending on the active command,
ToubkalCAD may expect a body, face, edge, vertex, sketch, or reference object.
Read the command prompt before selecting.

Hold the platform's modifier key when a command supports multiple selections.
Press <kbd>Esc</kbd> to cancel a tool or clear its temporary interaction state.

## Model tree

The model tree shows document structure and feature order. Use it to:

- select hidden or overlapping objects;
- understand which sketches feed later features;
- inspect parent-child relationships;
- return to an earlier feature or component.

Changing an upstream sketch or parameter can cause downstream features to
recompute. If a later feature becomes invalid, inspect the first failed
dependency rather than only the final result.

## Common selection commands

- <kbd>Ctrl</kbd>+<kbd>A</kbd> selects all applicable objects.
- <kbd>Delete</kbd> removes the current selection when deletion is allowed.
- <kbd>H</kbd> toggles visibility for the selected object.
- <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates supported objects.
