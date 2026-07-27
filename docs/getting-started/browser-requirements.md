# Browser Requirements

ToubkalCAD performs CAD geometry operations locally in your browser. A modern
browser and a device with WebAssembly and WebGL support are required.

## Required capabilities

- WebAssembly
- WebGL hardware acceleration
- `SharedArrayBuffer`
- A cross-origin-isolated page
- JavaScript enabled

The hosted application supplies the required `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers. If you self-host ToubkalCAD, those
headers are mandatory.

## Recommended environment

Use a current desktop release of Chrome, Edge, Firefox, or Safari. A mouse with
a wheel or a trackpad makes viewport navigation easier. Larger models benefit
from more memory and a dedicated GPU.

The first visit downloads the OpenCascade WebAssembly runtime, which is roughly
48 MB before browser caching. Startup can therefore take longer on a slow
connection; later visits are usually faster.

## Before reporting a startup issue

1. Reload the page without browser extensions.
2. Confirm hardware acceleration is enabled.
3. Clear the site's stored data and retry.
4. Open the browser console and note any WebAssembly, CORS, or isolation errors.

See [Startup and WebAssembly](/troubleshooting/startup-and-wasm) for targeted fixes.
