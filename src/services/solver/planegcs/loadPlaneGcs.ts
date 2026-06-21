// ============================================================
// ToubkalCAD – planegcs/loadPlaneGcs.ts
//
// Loads the PlaneGCS WASM module ONCE (mirrors loadSlvs / how index.tsx loads
// the OCC kernel). PlaneGCSSolverAdapter calls loadPlaneGcs() from its init()
// and keeps the returned module for the app's lifetime; it builds ONE
// GcsWrapper (a single reusable GcsSystem) and clear_data()s it before each
// solve — far cheaper than re-instantiating the ~1.5 MB WASM per frame.
//
// WASM resolution has two paths:
//   • Browser (rspack bundle): the emscripten glue resolves `planegcs.wasm`
//     against its own chunk URL, which won't exist next to the bundle — so the
//     caller passes a `wasmUrl` (a file-loader-emitted hashed URL, imported in
//     index.tsx) and we route it through `locateFile`.
//   • Node (the headless cross-check harness via tsx): the glue is NOT bundled,
//     so its default `new URL("planegcs.wasm", import.meta.url)` already points
//     next to the package's .wasm. Call with no wasmUrl → default resolution.
//
// This module never statically imports the .wasm, so it stays importable under
// both bundlers and plain Node.
// ============================================================

import { init_planegcs_module, type ModuleStatic } from '@salusoft89/planegcs';

let modPromise: Promise<ModuleStatic> | null = null;

/**
 * Idempotent: the WASM module is instantiated once and shared.
 *
 * @param wasmUrl explicit URL for the browser bundle (file-loader output). Omit
 *                in Node, where the glue resolves its sibling .wasm itself.
 */
export function loadPlaneGcs(wasmUrl?: string): Promise<ModuleStatic> {
  return (modPromise ??= init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined));
}

export type { ModuleStatic };
