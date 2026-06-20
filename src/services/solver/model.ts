// ============================================================
// ToubkalCAD – solver/model.ts
//
// Neutral domain types shared across the sketch-solver seam. These describe
// ToubkalCAD's 2D sketch model — NOT any solver's internals — so they outlive
// whichever solver implementation is installed (legacy LM, SolveSpace, …).
//
// They currently live in SketchConstraintSolver.ts (the legacy math). We
// re-export them from here so the new solver layer, the bridge, and the call
// sites can depend on a solver-agnostic path. When the legacy solver is
// eventually deleted, MOVE the definitions here and flip the re-export
// direction — no call site changes.
// ============================================================

export type { EntityGeom, SolveResult, DragPin } from '../SketchConstraintSolver';
