# Current Limitations

ToubkalCAD is under active development. The following constraints are important
when evaluating or using it.

## Project maturity

- Workflows and project data can change between releases.
- Feature coverage and edge-case handling are not yet comparable to mature
  desktop CAD systems.
- Some advanced operations accept geometry that the OpenCascade kernel later
  rejects; error reporting continues to improve.

## Performance

OpenCascade geometry operations run in WebAssembly on the main browser thread.
Complex Boolean operations, dense meshes, and large assemblies can temporarily
make the interface unresponsive.

## Parametric behavior

Downstream features depend on upstream geometry. Large topology changes can
invalidate face or edge references, particularly when a model relies heavily on
generated topology instead of datum geometry.

## Sketch solving

The built-in sketch constraint workflow is evolving. Optional SolveSpace-based
functionality is not part of the default build.

## Safe evaluation practices

- Save frequent project copies.
- Keep important exchange exports.
- Validate critical measurements in another tool.
- Report reproducible failures with a small project and clear steps.
