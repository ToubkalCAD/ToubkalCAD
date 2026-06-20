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

import type { SlvsModule } from './libslvs';

type SlvsFactory = (opts?: Record<string, unknown>) => Promise<SlvsModule>;

let modPromise: Promise<SlvsModule> | null = null;

/**
 * Idempotent: the WASM module is instantiated once and shared.
 *
 * The glue (libslvs.mjs) is built separately by native/slvs/build.sh — it sits
 * in this dir for the Node cross-check harness, and CopyRspackPlugin drops it
 * next to the browser bundle. The `webpackIgnore` magic comment makes rspack
 * resolve it at RUNTIME only, so the app still builds when the artifact is
 * absent (the import simply rejects → SolveSpace stays uninstalled → legacy
 * solver remains active). Rejects if libslvs.mjs hasn't been deployed.
 */
export function loadSlvs(): Promise<SlvsModule> {
  if (!modPromise) {
    // @ts-ignore runtime-only artifact (no static module/types at build time)
    modPromise = import(/* webpackIgnore: true */ './libslvs.mjs')
      .then((m: { default: SlvsFactory }) => m.default());
  }
  return modPromise;
}

export type { SlvsModule, SketchSystem, EntityRef, SolveOutcome } from './libslvs';
