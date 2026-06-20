#!/usr/bin/env bash
# ============================================================
# Build libslvs (SolveSpace's geometric constraint solver) + the ToubkalCAD
# Embind shim into a WebAssembly module consumed by src/services/solver/wasm/.
#
# Prereqs:
#   - Emscripten SDK installed & activated  (`emcc` on PATH; `source emsdk_env.sh`)
#   - git
#
# Usage:
#   ./build.sh                 # clone pinned SolveSpace, build to src/.../wasm/
#   SOLVESPACE_TAG=v3.1 ./build.sh
#
# Output (gitignored): src/services/solver/wasm/libslvs.mjs + libslvs.wasm
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SS_TAG="${SOLVESPACE_TAG:-v3.1}"
SS_DIR="$HERE/third_party/solvespace"
OUT="$HERE/../../src/services/solver/wasm"

if ! command -v emcc >/dev/null 2>&1; then
  echo "ERROR: emcc not found. Install the Emscripten SDK and run 'source <emsdk>/emsdk_env.sh'." >&2
  exit 1
fi

# 1. Fetch SolveSpace (shallow) + the Eigen submodule that the solver needs.
if [ ! -d "$SS_DIR/.git" ]; then
  echo ">> cloning SolveSpace @ $SS_TAG"
  git clone --depth 1 --branch "$SS_TAG" https://github.com/solvespace/solvespace.git "$SS_DIR"
fi
echo ">> fetching Eigen submodule (solver dependency)"
git -C "$SS_DIR" submodule update --init --depth 1 extlib/eigen >/dev/null 2>&1 || \
  echo "   (warn) could not init extlib/eigen — adjust EIGEN_INC below if the build fails"

SRC="$SS_DIR/src"
INC="$SS_DIR/include"
EIGEN_INC="$SS_DIR/extlib/eigen"

# 2. The libslvs translation units. This list mirrors SolveSpace's `slvs` CMake
#    target (built with -DLIBRARY). If a SolveSpace version changes it, sync here.
LIBSLVS_SOURCES=(
  "$SRC/util.cpp"
  "$SRC/entity.cpp"
  "$SRC/expr.cpp"
  "$SRC/constrainteq.cpp"
  "$SRC/system.cpp"
  "$SRC/lib.cpp"
)

mkdir -p "$OUT"

echo ">> compiling shim + libslvs → $OUT/libslvs.mjs"
emcc \
  -std=c++17 -O3 -DLIBRARY \
  -I"$INC" -I"$SRC" -I"$EIGEN_INC" \
  "$HERE/slvs_shim.cpp" "${LIBSLVS_SOURCES[@]}" \
  -lembind \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createSlvsModule \
  -s ENVIRONMENT=web,worker \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s SINGLE_FILE=0 \
  -o "$OUT/libslvs.mjs"

echo ">> done. Artifacts:"
ls -la "$OUT"/libslvs.* 2>/dev/null || true
echo ">> smoke test:  node $HERE/test/smoke.mjs"
