# Interface Overview

ToubkalCAD uses a desktop-style layout organized around the 3D viewport.

![ToubkalCAD workspace showing a mounting bracket](/images/toubkalcad-workspace.png)

## Main areas

### Application menu

The top menu contains project operations, undo and redo, selection commands,
camera presets, and help links.

### Ribbon

The ribbon groups modeling tools by task:

- **Sketch** creates 2D geometry, constraints, and dimensions.
- **Model** creates solids, features, reference geometry, and assemblies.
- **Surface** creates and modifies surface geometry.
- **Modify** applies fillets, chamfers, shells, and Boolean operations.
- **Tools** contains selection, measurement, view, import, and export tools.

### Model tree

The tree records document objects and their hierarchy. Select an item here when
geometry is difficult to select in the viewport, or when you want to inspect a
feature by name.

### 3D viewport

The viewport is the central modeling area. It shows solids, sketches, reference
geometry, selections, and the transform gizmo.

### Properties panel

The properties panel changes with the current selection. Its tabs cover areas
such as Transform, Assembly, References, Constraints, Material, Analysis,
Measure, and Snap.

### Status indicators

Watch the OpenCascade status during startup. The status bar and command prompts
also provide useful context while tools are active.

## A reliable working pattern

Select an object, choose a command, enter its parameters, then confirm the
operation. Press <kbd>Esc</kbd> when you need to cancel an active tool.
