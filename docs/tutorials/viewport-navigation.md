# Navigating the 3D Viewport

Practice orbiting, panning, zooming, framing geometry, and switching to exact
camera orientations.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 10 minutes |
| **Required tools** | ToubkalCAD; three-button mouse recommended |

## Learning objectives

- Orbit, pan, and zoom without moving model geometry.
- Frame one object or fit the complete scene.
- Use orthographic presets for precise inspection.

## Final expected result

A box viewed from top, front, right, isometric, and perspective orientations.

## Steps

1. Start a blank project, open **Model → Primitives**, and choose **Box**.
2. Enter `40` for **Width X**, `30` for **Height Y**, and `20` for **Depth Z**,
   then create the box.
3. Drag with the left mouse button in empty viewport space to orbit around the
   box. Selection clicks should be short; a drag controls the camera.
4. Drag with the right mouse button to pan the view.
5. Scroll over the box to zoom toward the pointer. Scroll over empty space to
   zoom relative to the current view target.
6. Press <kbd>Shift</kbd>+<kbd>F</kbd> to fit all visible geometry.
7. Select the box and press <kbd>F</kbd> to frame only the selection.
8. Press <kbd>7</kbd>, <kbd>1</kbd>, and <kbd>3</kbd> to inspect the top, front,
   and right orthographic views.
9. Press <kbd>5</kbd> for an isometric view, then <kbd>0</kbd> for perspective.
10. Use the view cube to return to a named face or corner orientation.

## Tips

- Frame the selected object before inspecting a small feature.
- Use an orthographic preset before checking alignment.
- Sketch sessions automatically orient the camera normal to the sketch plane.

## Common mistakes

- **Moving the object instead of the camera:** avoid dragging transform-gizmo
  handles when practicing navigation.
- **Orbiting during a sketch:** rotation is intentionally restricted while a
  sketch session is active.
- **Losing the model:** press <kbd>Shift</kbd>+<kbd>F</kbd>.

## Related documentation

- [Viewport navigation guide](/user-guide/viewport-navigation)
- [Keyboard shortcuts](/reference/keyboard-shortcuts)
- [Interface overview](/getting-started/interface-overview)

## Summary

You can now move between free inspection and repeatable engineering views
without changing model geometry.
