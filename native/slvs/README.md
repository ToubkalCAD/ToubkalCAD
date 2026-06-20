# libslvs WASM sub-project

SolveSpace's geometric constraint solver (`libslvs`) compiled to WebAssembly,
wrapped by a thin Embind shim, for use behind ToubkalCAD's `ISketchSolver` seam.

## What's here

| File | Role |
|------|------|
| `slvs_shim.cpp` | Embind C++ wrapper exposing the `SketchSystem` class to JS. All `Slvs_*` struct/array marshalling lives here. |
| `build.sh` | Clones pinned SolveSpace + Eigen, compiles the shim + libslvs with Emscripten. |
| `test/smoke.mjs` | Standalone Node test — solves a tiny system, no app/browser. |
| `third_party/` | SolveSpace clone (gitignored, fetched by `build.sh`). |

Build outputs land in **`src/services/solver/wasm/`** as `libslvs.mjs` + `libslvs.wasm` (gitignored). The TypeScript side (`loadSlvs.ts`, `libslvs.d.ts`, `slvsConstants.ts`) already lives there and typechecks against the hand-written `.d.ts` before the artifact exists.

## Build

```bash
# 1. install + activate Emscripten once:
#    git clone https://github.com/emscripten-core/emsdk && cd emsdk
#    ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
# 2. build:
cd native/slvs && ./build.sh
# 3. verify (independent of the app):
node native/slvs/test/smoke.mjs        # expect: result = 0 ... PASS ✅
```

## Architecture contract

- **Single canonical workplane** (XY through origin, identity orientation),
  created FIXED in the constructor. ToubkalCAD already works in workplane-local
  `(u,v)`; a real 3D placement is irrelevant to a 2D solve, so `(u,v)` params map
  straight onto `EntityGeom` local coords.
- **Groups:** `1` = fixed reference (workplane, datums, FIXED entities), `2` =
  free geometry. `solve(2)` moves only group 2. The `fixed` flag on each `add*`
  routes params to the right group — this is how `SketchDatums` + the `FIXED`
  constraint are expressed.
- **Drag:** `setDragged(pu, pv)` → libslvs keeps those params near their seeded
  value (native minimal-move; replaces the legacy soft-anchor).
- **Lifetime:** module loaded once (`loadSlvs()`); one `SketchSystem` per solve
  or per drag session; `.delete()` frees its WASM heap (same discipline as the
  OCC registry / `WasmScope`).

## Notes / gotchas

- **No SharedArrayBuffer needed** — libslvs is single-threaded. The existing
  COOP/COEP headers (required by OCC) cause no conflict. The `.wasm` is small
  (hundreds of KB vs OCC's 48 MB).
- The `LIBSLVS_SOURCES` list in `build.sh` mirrors SolveSpace's `slvs` CMake
  target (built with `-DLIBRARY`). If a SolveSpace version changes that target,
  sync the list. `system.cpp` needs **Eigen** (fetched as a submodule).
- `RADIUS → DIAMETER` (valA = 2·r), `COLLINEAR → PARALLEL + PT_ON_LINE`, and
  circle↔circle `TANGENT → CURVE_CURVE_TANGENT` are the only non-1:1 mappings
  the adapter must handle. See `slvsConstants.ts`.

## Status

Scaffold only — **not yet compiled here** (no Emscripten toolchain in this
environment). Run `build.sh` in an Emscripten-equipped environment, confirm the
smoke test passes, then implement `SolveSpaceSolverAdapter` against `loadSlvs()`.
