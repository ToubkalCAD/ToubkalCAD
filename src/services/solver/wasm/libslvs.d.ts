// ============================================================
// ToubkalCAD – libslvs.d.ts
//
// Hand-written types for the Emscripten-generated glue module (libslvs.mjs),
// produced by native/slvs/build.sh from slvs_shim.cpp. The .mjs/.wasm are build
// artifacts (gitignored); this .d.ts lets `tsc` typecheck the loader + the
// future SolveSpaceSolverAdapter BEFORE the artifact is built. At runtime the
// bundler resolves the real ./libslvs.mjs.
//
// Keep in lockstep with the Embind bindings at the bottom of slvs_shim.cpp.
// ============================================================

/** Handle bundle for an added entity (see slvs_shim.cpp EntityRef). */
export interface EntityRef {
  /** entity handle */
  h: number;
  /** point: u-param · circle: radius-param */
  p0: number;
  /** point: v-param · circle: distance-entity */
  p1: number;
  /** circle: centre-point entity */
  p2: number;
  p3: number;
}

export interface SolveOutcome {
  /** one of SlvsModule.SLVS_RESULT_* */
  result: number;
  /** remaining degrees of freedom (-1 if not computed) */
  dof: number;
}

/** The C++ SketchSystem class, surfaced through Embind. One per solve (or per
 *  drag session); call delete() to free its WASM heap. */
export interface SketchSystem {
  /** handle of the canonical fixed workplane (rarely needed by callers). */
  workplane(): number;

  /** 2D point in the canonical workplane. `fixed` → group 1 (not solved). */
  addPoint2d(u: number, v: number, fixed: boolean): EntityRef;
  /** line segment between two existing point entities. */
  addLine(ptA: number, ptB: number, fixed: boolean): EntityRef;
  /** circle from a centre point entity + a radius value. */
  addCircle(centerPt: number, radius: number, fixed: boolean): EntityRef;
  /** arc from centre/start/end point entities. */
  addArc(centerPt: number, startPt: number, endPt: number, fixed: boolean): EntityRef;

  /**
   * Add one constraint. `type` is a SLVS_C_* int (see SlvsConstraintType in
   * slvsConstants.ts). Fill the fields the type needs, pass 0 for the rest.
   */
  addConstraint(
    type: number, valA: number,
    ptA: number, ptB: number,
    entityA: number, entityB: number,
    entityC: number, entityD: number,
    other: number, other2: number,
  ): number;

  /** Bias the solver to keep these two params near their seeded value (drag). */
  setDragged(pu: number, pv: number): void;
  clearDragged(): void;

  /** Solve the given group (2 = active geometry). */
  solve(activeGroup: number): SolveOutcome;
  /** Read a solved param value by handle. */
  getParamValue(hParam: number): number;

  /** Free the underlying C++ object / WASM heap. */
  delete(): void;
}

export interface SlvsModule {
  SketchSystem: { new (): SketchSystem };
  readonly SLVS_RESULT_OKAY: number;
  readonly SLVS_RESULT_INCONSISTENT: number;
  readonly SLVS_RESULT_DIDNT_CONVERGE: number;
  readonly SLVS_RESULT_TOO_MANY_UNKNOWNS: number;
}

export interface SlvsModuleOptions {
  locateFile?: (path: string, prefix: string) => string;
  [k: string]: unknown;
}

/** Emscripten factory (EXPORT_NAME=createSlvsModule, MODULARIZE + EXPORT_ES6). */
export default function createSlvsModule(opts?: SlvsModuleOptions): Promise<SlvsModule>;
