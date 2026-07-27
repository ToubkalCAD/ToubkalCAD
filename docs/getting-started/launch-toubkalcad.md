# Launch ToubkalCAD

Open the [live ToubkalCAD application](https://toubkal-cad.vercel.app).

## Startup sequence

1. The application shell appears.
2. ToubkalCAD downloads and initializes OpenCascade WebAssembly.
3. The status indicator changes when the geometry kernel is ready.
4. Create a blank document or choose an onboarding example.

Do not start a modeling command while OpenCascade is still loading. If startup
does not complete, see [Startup and WebAssembly](/troubleshooting/startup-and-wasm).

## Your work and the browser

Modeling is performed locally in the browser. Use **File → Save Project**
regularly to keep a copy of your document on your computer. Opening a project
replaces the current workspace, so save first if you need the existing model.

## Next step

Read the [Interface Overview](./interface-overview), then create a simple box in
[Create Your First Model](./first-model).
