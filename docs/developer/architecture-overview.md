# Architecture Overview

ToubkalCAD combines a React interface, lightweight state stores, OpenCascade
WebAssembly geometry, and Three.js rendering.

## Geometry flow

```text
User command
  → feature or scene state
  → OpenCascade shape
  → persistent geometry registry
  → tessellated Three.js mesh
  → viewport
```

## Major systems

### Application state

Zustand stores maintain the lightweight scene graph, current selection, active
commands, document structure, and UI state. Stores should keep serializable
application data rather than long-lived WebAssembly wrapper objects.

### OpenCascade runtime

The OpenCascade module is initialized once and exposed to the application
runtime. CAD operations must wait for initialization to finish.

### Geometry ownership

`CADGeometryRegistry` owns persistent OpenCascade shapes. This explicit
ownership is important because WebAssembly wrapper objects require deliberate
lifetime management.

Temporary OpenCascade values belong in a `WasmScope` so they are released after
an operation. Do not dispose persistent shapes that have been transferred to
the registry.

### Rendering

OpenCascade shapes are tessellated into Three.js geometry. `ThreeMeshCache`
avoids rebuilding meshes unnecessarily and keeps rendering concerns separate
from CAD shape ownership.

### Feature graph

Parametric features record dependencies and recompute in graph order. Stable
references attempt to reconnect features to faces and edges after upstream
changes, but large topology changes can still invalidate references.

### UI communication

React components and modeling subsystems communicate through state stores and a
`CustomEvent` command bus. New commands should follow the established command
and ownership patterns rather than introducing a parallel communication path.

## Runtime headers

OpenCascade requires `SharedArrayBuffer`, so development and production servers
must provide:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Verification

Run lint, production build, and the self-test suite before merging architectural
changes. Geometry ownership and recompute changes deserve targeted tests because
their failures can appear far from the source.
