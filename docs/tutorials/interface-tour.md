# Introduction to the ToubkalCAD Interface

Learn where modeling commands, project objects, properties, and status messages
appear before creating geometry.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 10 minutes |
| **Required tools** | ToubkalCAD in a supported desktop browser; mouse or trackpad |

## Learning objectives

- Identify the application menu, ribbon, model tree, viewport, properties panel,
  and status area.
- Understand how selection connects the viewport, tree, and properties.
- Find commands without starting an unintended operation.

## Final expected result

An unchanged blank project and the ability to locate every major interface area.

## Steps

1. [Open ToubkalCAD](https://toubkal-cad.vercel.app) and wait for the OpenCascade
   status to report that the geometry kernel is ready.
2. Locate the **File**, **Edit**, **View**, and **Help** menus at the top. These
   contain project commands, undo/redo, camera presets, and help.
3. Inspect the ribbon tabs: **Sketch**, **Model**, **Surface**, **Modify**, and
   **Tools**. Select each tab without clicking a command.
4. Locate the model tree. It is initially empty and will later show sketches,
   solids, operations, components, and assemblies.
5. Move the pointer over the central 3D viewport. Note the origin axes, adaptive
   grid, and view cube.
6. Locate the properties panel. Its available tabs change with the selected
   object and include Transform, Material, Analysis, Measure, and other
   context-sensitive controls.
7. Locate the status bar and command messages. Watch these areas whenever a tool
   expects a selection or reports an error.
8. Open **Model**, expand **Primitives**, and then click outside the menu. This
   demonstrates how grouped commands are presented without creating geometry.

## Tips

- Hover over ribbon icons to read their tooltips.
- If a command appears disabled, check whether OpenCascade is ready and whether
  the required object type is selected.
- Press <kbd>Esc</kbd> to cancel a temporary interaction.

## Common mistakes

- **Clicking tools while the kernel is loading:** wait for the ready status.
- **Looking only in the viewport:** hidden or overlapping objects are easier to
  select in the model tree.
- **Ignoring command messages:** many tools state the next required pick there.

## Related documentation

- [Interface overview](/getting-started/interface-overview)
- [Selection and model tree](/user-guide/selection-and-model-tree)
- [Keyboard shortcuts](/reference/keyboard-shortcuts)

## Summary

You identified the six main working areas and learned the selection-first pattern
used throughout ToubkalCAD.
