// ============================================================
// ToubkalCAD – loadSlvs.ts
//
// Loads the libslvs WASM module ONCE (mirrors how src/index.tsx loads the OCC
// kernel onto window.oc). The SolveSpaceSolverAdapter calls loadSlvs() from its
// init() and keeps the returned module for the app's lifetime; it creates a
// fresh SketchSystem per solve / drag session and delete()s it after.
//
// `./libslvs` resolves to libslvs.d.ts at typecheck time and to the built
// libslvs.mjs (native/slvs/build.sh output) at bundle time.
// ============================================================

import createSlvsModule, { SlvsModule } from './libslvs';

let modPromise: Promise<SlvsModule> | null = null;

/** Idempotent: the WASM module is instantiated once and shared. */
export function loadSlvs(): Promise<SlvsModule> {
  if (!modPromise) modPromise = createSlvsModule();
  return modPromise;
}

export type { SlvsModule, SketchSystem, EntityRef, SolveOutcome } from './libslvs';
