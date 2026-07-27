# Startup and WebAssembly

## OpenCascade never becomes ready

1. Wait for the initial WebAssembly download to finish.
2. Reload the application.
3. Try a private window with extensions disabled.
4. Confirm JavaScript and hardware acceleration are enabled.
5. Clear stored data for the site and retry.

## SharedArrayBuffer or cross-origin isolation error

The page must be served with these headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The official deployment configures them. Self-hosted deployments must do the
same, and all embedded resources must be compatible with cross-origin isolation.

## Blank or corrupted viewport

Update the browser and graphics driver, ensure hardware acceleration is active,
and test with browser extensions disabled. If the interface loads but geometry
does not, include WebGL and console errors in the issue report.

## A modeling command fails

Confirm OpenCascade is ready, the expected object type is selected, profiles are
closed where required, and the requested dimensions produce valid geometry.
Try a smaller fillet, chamfer, shell thickness, or Boolean input.
