// ============================================================
// ToubkalCAD – SketchConstraintSolver.ts
//
// Phase 8 – Parametric 2D constraint solver (extended set).
//
// A pure-TypeScript variational solver operating on a parametric
// model of sketch entities in workplane-local 2D (u, v) coordinates:
//
//   line   → two endpoints  a, b
//   circle → center c + radius r
//
// Constraints reference whole entities OR individual points
// (line endpoints, circle centers). Each contributes one or more
// residual equations f(x)=0. ‖R‖² is minimised with a damped
// Gauss-Newton (Levenberg-Marquardt) iteration. Under-determined
// DoF are pinned by a small soft-anchor term so geometry moves the
// minimum needed (predictable, drag-free behaviour).
//
// Constraint families
//   Geometric:   Horizontal, Vertical, Parallel, Perpendicular,
//                Collinear, Tangent, Concentric, Equal, Coincident,
//                Symmetry, Fixed
//   Dimensional: Length, Radius, Distance, Angle (driving values)
//
// No OpenCascade / Three.js dependency — trivially testable.
// ============================================================

import type { SketchConstraint, SketchConstraintType, SketchRef } from '../store/cadStore';

// ─── Parametric entity geometry (local 2D, stored on sketch_wire params) ──────

export type EntityGeom =
  | { id: string; kind: 'line';   a: [number, number]; b: [number, number] }
  | { id: string; kind: 'circle'; c: [number, number]; r: number };

export interface SolveResult {
  geoms:      Record<string, EntityGeom>;
  converged:  boolean;
  residual:   number;
  iterations: number;
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

const MAX_ITERS = 140;
const TOL       = 1e-9;
const ANCHOR_W  = 0.02;    // soft-anchor weight — regularises null-space (minimal move)
const FD_EPS    = 1e-6;
const LAMBDA_0  = 1e-3;
// Constraint-residual threshold for "satisfied". Lenient enough for the
// dimensionless angular residuals (normalised dot/cross ~ sin/cos of a
// fraction of a degree); dimensional (mm) residuals solve far tighter.
const CONVERGED = 2.5e-2;

// ─── Variable layout ──────────────────────────────────────────────────────────
//   line   → [a.u, a.v, b.u, b.v]
//   circle → [c.u, c.v, r]

interface VarBlock { kind: 'line' | 'circle'; base: number }

function buildLayout(geoms: EntityGeom[]) {
  const blocks = new Map<string, VarBlock>();
  const x: number[] = [];
  for (const g of geoms) {
    const base = x.length;
    if (g.kind === 'line') { x.push(g.a[0], g.a[1], g.b[0], g.b[1]); blocks.set(g.id, { kind: 'line', base }); }
    else                   { x.push(g.c[0], g.c[1], g.r);            blocks.set(g.id, { kind: 'circle', base }); }
  }
  return { blocks, x };
}

// ─── Reference resolution ─────────────────────────────────────────────────────

/** Variable indices [uIdx, vIdx] of a point operand (or null if invalid). */
function pointIdx(ref: SketchRef, blocks: Map<string, VarBlock>): [number, number] | null {
  const blk = blocks.get(ref.id);
  if (!blk) return null;
  if (ref.pt === 'a' && blk.kind === 'line')   return [blk.base + 0, blk.base + 1];
  if (ref.pt === 'b' && blk.kind === 'line')   return [blk.base + 2, blk.base + 3];
  if (ref.pt === 'c' && blk.kind === 'circle') return [blk.base + 0, blk.base + 1];
  return null;
}

interface LineCoords { ax: number; ay: number; bx: number; by: number }
function lineCoords(x: number[], blocks: Map<string, VarBlock>, id: string): LineCoords | null {
  const blk = blocks.get(id);
  if (blk?.kind !== 'line') return null;
  return { ax: x[blk.base], ay: x[blk.base + 1], bx: x[blk.base + 2], by: x[blk.base + 3] };
}

interface CircleCoords { cx: number; cy: number; r: number }
function circleCoords(x: number[], blocks: Map<string, VarBlock>, id: string): CircleCoords | null {
  const blk = blocks.get(id);
  if (blk?.kind !== 'circle') return null;
  return { cx: x[blk.base], cy: x[blk.base + 1], r: x[blk.base + 2] };
}

/** Signed perpendicular distance of point P to the infinite line through A,B. */
function perpDist(px: number, py: number, L: LineCoords): number {
  const dx = L.bx - L.ax, dy = L.by - L.ay;
  const n = Math.hypot(dx, dy) || 1;
  return ((px - L.ax) * -dy + (py - L.ay) * dx) / n;
}

const DEG = Math.PI / 180;

// ─── Residual assembly ────────────────────────────────────────────────────────

function residuals(
  x: number[], x0: number[], fixed: boolean[],
  blocks: Map<string, VarBlock>, constraints: SketchConstraint[],
  withAnchor = true,
): number[] {
  const R: number[] = [];
  const P = (ref: SketchRef): [number, number] | null => {
    const idx = pointIdx(ref, blocks);
    return idx ? [x[idx[0]], x[idx[1]]] : null;
  };

  for (const c of constraints) {
    const e0 = c.refs[0]?.id, e1 = c.refs[1]?.id, e2 = c.refs[2]?.id;
    switch (c.type) {
      case 'HORIZONTAL': { const L = lineCoords(x, blocks, e0); if (L) R.push(L.ay - L.by); break; }
      case 'VERTICAL':   { const L = lineCoords(x, blocks, e0); if (L) R.push(L.ax - L.bx); break; }
      case 'LENGTH': {
        const L = lineCoords(x, blocks, e0);
        if (L && c.value != null) R.push(Math.hypot(L.bx - L.ax, L.by - L.ay) - c.value);
        break;
      }
      case 'RADIUS': {
        const C = circleCoords(x, blocks, e0);
        if (C && c.value != null) R.push(C.r - c.value);
        break;
      }
      case 'PARALLEL': case 'PERPENDICULAR': {
        const L1 = lineCoords(x, blocks, e0), L2 = lineCoords(x, blocks, e1);
        if (L1 && L2) {
          const u1 = L1.bx - L1.ax, v1 = L1.by - L1.ay;
          const u2 = L2.bx - L2.ax, v2 = L2.by - L2.ay;
          const n1 = Math.hypot(u1, v1) || 1, n2 = Math.hypot(u2, v2) || 1;
          R.push(c.type === 'PARALLEL'
            ? (u1 * v2 - v1 * u2) / (n1 * n2)     // cross → 0
            : (u1 * u2 + v1 * v2) / (n1 * n2));   // dot   → 0
        }
        break;
      }
      case 'COLLINEAR': {
        const L1 = lineCoords(x, blocks, e0), L2 = lineCoords(x, blocks, e1);
        if (L1 && L2) { R.push(perpDist(L2.ax, L2.ay, L1)); R.push(perpDist(L2.bx, L2.by, L1)); }
        break;
      }
      case 'EQUAL': {
        const L1 = lineCoords(x, blocks, e0), L2 = lineCoords(x, blocks, e1);
        if (L1 && L2) { R.push(Math.hypot(L1.bx - L1.ax, L1.by - L1.ay) - Math.hypot(L2.bx - L2.ax, L2.by - L2.ay)); break; }
        const C1 = circleCoords(x, blocks, e0), C2 = circleCoords(x, blocks, e1);
        if (C1 && C2) R.push(C1.r - C2.r);
        break;
      }
      case 'CONCENTRIC': {
        const C1 = circleCoords(x, blocks, e0), C2 = circleCoords(x, blocks, e1);
        if (C1 && C2) { R.push(C1.cx - C2.cx); R.push(C1.cy - C2.cy); }
        break;
      }
      case 'TANGENT': {
        const La = lineCoords(x, blocks, e0), Lb = lineCoords(x, blocks, e1);
        const Ca = circleCoords(x, blocks, e0), Cb = circleCoords(x, blocks, e1);
        if ((La && Cb) || (Lb && Ca)) {
          const L = (La ?? Lb)!, C = (Cb ?? Ca)!;
          R.push(Math.abs(perpDist(C.cx, C.cy, L)) - C.r);          // line ↔ circle
        } else if (Ca && Cb) {
          const d = Math.hypot(Ca.cx - Cb.cx, Ca.cy - Cb.cy);
          const ext = Math.abs(d - (Ca.r + Cb.r));
          const int = Math.abs(d - Math.abs(Ca.r - Cb.r));
          R.push(ext <= int ? d - (Ca.r + Cb.r) : d - Math.abs(Ca.r - Cb.r)); // choose nearer mode
        }
        break;
      }
      case 'COINCIDENT': {
        const p1 = P(c.refs[0]), p2 = P(c.refs[1]);
        if (p1 && p2) { R.push(p1[0] - p2[0]); R.push(p1[1] - p2[1]); }
        break;
      }
      case 'DISTANCE': {
        if (c.value == null) break;
        const p1 = P(c.refs[0]), p2 = P(c.refs[1]);
        if (p1 && p2) { R.push(Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) - c.value); break; }
        // point ↔ line
        const pl = P(c.refs[0]) ?? P(c.refs[1]);
        const lineId = lineCoords(x, blocks, e1) ? e1 : e0;
        const L = lineCoords(x, blocks, lineId);
        if (pl && L) R.push(Math.abs(perpDist(pl[0], pl[1], L)) - c.value);
        break;
      }
      case 'ANGLE': {
        const L1 = lineCoords(x, blocks, e0), L2 = lineCoords(x, blocks, e1);
        if (L1 && L2 && c.value != null) {
          const u1 = L1.bx - L1.ax, v1 = L1.by - L1.ay;
          const u2 = L2.bx - L2.ax, v2 = L2.by - L2.ay;
          const ang = Math.atan2(u1 * v2 - v1 * u2, u1 * u2 + v1 * v2); // signed [-π,π]
          let diff = ang - c.value * DEG;
          while (diff >  Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          R.push(diff);
        }
        break;
      }
      case 'SYMMETRY': {
        const p1 = P(c.refs[0]), p2 = P(c.refs[1]);
        const axis = lineCoords(x, blocks, e2);
        if (p1 && p2 && axis) {
          const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
          R.push(perpDist(mx, my, axis));                              // midpoint on axis
          const dx = axis.bx - axis.ax, dy = axis.by - axis.ay;
          const n = Math.hypot(dx, dy) || 1;
          R.push(((p1[0] - p2[0]) * dx + (p1[1] - p2[1]) * dy) / n);   // p1−p2 ⟂ axis
        }
        break;
      }
      case 'FIXED': break; // pinned via fixed[]
    }
  }

  // Soft anchor → minimal-move solution (excluded when measuring constraint error).
  if (withAnchor) for (let i = 0; i < x.length; i++) if (!fixed[i]) R.push(ANCHOR_W * (x[i] - x0[i]));
  return R;
}

// ─── Dense linear solve (Gaussian elimination, partial pivoting) ──────────────

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let cc = col; cc <= n; cc++) M[col][cc] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f !== 0) for (let cc = col; cc <= n; cc++) M[r][cc] -= f * M[col][cc];
    }
  }
  return M.map((row) => row[n]);
}

const norm2 = (v: number[]) => Math.sqrt(v.reduce((s, e) => s + e * e, 0));

// ─── Public solve ─────────────────────────────────────────────────────────────

export function solveConstraints(geomsIn: EntityGeom[], constraints: SketchConstraint[]): SolveResult {
  const geoms: EntityGeom[] = geomsIn.map((g) =>
    g.kind === 'line'
      ? { id: g.id, kind: 'line', a: [...g.a], b: [...g.b] }
      : { id: g.id, kind: 'circle', c: [...g.c], r: g.r });

  const { blocks, x } = buildLayout(geoms);
  const x0 = [...x];
  const n  = x.length;

  const fixed = new Array(n).fill(false);
  for (const c of constraints) {
    if (c.type !== 'FIXED') continue;
    const blk = blocks.get(c.refs[0]?.id);
    if (!blk) continue;
    const span = blk.kind === 'line' ? 4 : 3;
    for (let i = 0; i < span; i++) fixed[blk.base + i] = true;
  }
  const freeIdx = Array.from({ length: n }, (_, i) => i).filter((i) => !fixed[i]);

  const evalR = (xv: number[]) => residuals(xv, x0, fixed, blocks, constraints);
  // Constraint-only error (no anchor) → drives the converged flag + status.
  const constraintErr = () => norm2(residuals(x, x0, fixed, blocks, constraints, false));

  let R = evalR(x);
  let cost = norm2(R);
  let lambda = LAMBDA_0;
  let iter = 0;
  const nf = freeIdx.length;

  if (nf === 0 || R.length === 0) {
    const ce = constraintErr();
    return { geoms: writeBack(geoms, blocks, x), converged: ce < CONVERGED, residual: ce, iterations: 0 };
  }

  for (; iter < MAX_ITERS; iter++) {
    if (cost < TOL) break;
    const m = R.length;

    const J: number[][] = Array.from({ length: m }, () => new Array(nf).fill(0));
    for (let j = 0; j < nf; j++) {
      const vi = freeIdx[j];
      const saved = x[vi];
      const h = FD_EPS * (Math.abs(saved) + 1);
      x[vi] = saved + h;
      const Rp = evalR(x);
      x[vi] = saved;
      for (let i = 0; i < m; i++) J[i][j] = (Rp[i] - R[i]) / h;
    }

    const JtJ: number[][] = Array.from({ length: nf }, () => new Array(nf).fill(0));
    const Jtr: number[] = new Array(nf).fill(0);
    for (let a = 0; a < nf; a++) {
      for (let b = 0; b < nf; b++) {
        let s = 0; for (let i = 0; i < m; i++) s += J[i][a] * J[i][b];
        JtJ[a][b] = s;
      }
      let s = 0; for (let i = 0; i < m; i++) s += J[i][a] * R[i];
      Jtr[a] = s;
    }

    let applied = false;
    for (let attempt = 0; attempt < 6 && !applied; attempt++) {
      const A = JtJ.map((row, i) => row.map((val, j) => (i === j ? val + lambda * (JtJ[i][i] + 1e-9) : val)));
      const delta = solveLinear(A, Jtr.map((v) => -v));
      if (!delta) { lambda *= 4; continue; }
      const trial = [...x];
      for (let j = 0; j < nf; j++) trial[freeIdx[j]] += delta[j];
      const Rt = evalR(trial);
      const ct = norm2(Rt);
      if (ct < cost) {
        for (let j = 0; j < nf; j++) x[freeIdx[j]] = trial[freeIdx[j]];
        R = Rt; cost = ct; lambda = Math.max(lambda * 0.5, 1e-9); applied = true;
      } else { lambda *= 4; }
    }
    if (!applied) break;
  }

  const ce = constraintErr();
  return { geoms: writeBack(geoms, blocks, x), converged: ce < CONVERGED, residual: ce, iterations: iter };
}

function writeBack(geoms: EntityGeom[], blocks: Map<string, VarBlock>, x: number[]): Record<string, EntityGeom> {
  const out: Record<string, EntityGeom> = {};
  for (const g of geoms) {
    const blk = blocks.get(g.id)!;
    if (g.kind === 'line') { g.a = [x[blk.base], x[blk.base + 1]]; g.b = [x[blk.base + 2], x[blk.base + 3]]; }
    else                   { g.c = [x[blk.base], x[blk.base + 1]]; g.r = Math.max(1e-4, x[blk.base + 2]); }
    out[g.id] = g;
  }
  return out;
}

// ─── Constraint metadata ──────────────────────────────────────────────────────
// operands: list of allowed operand-kinds per slot. 'line'|'circle'|'point'.
// Some constraints accept alternative operand sets → `alt`.

type Operand = 'line' | 'circle' | 'point';

interface ConstraintMeta {
  label:    string;
  glyph:    string;
  group:    'geometric' | 'dimensional';
  hasValue: boolean;
  /** allowed operand signatures (any one may match, in order) */
  sigs:     Operand[][];
  /** number of residual equations (for DoF accounting; FIXED handled separately) */
  eqs:      number;
}

export const CONSTRAINT_META: Record<SketchConstraintType, ConstraintMeta> = {
  HORIZONTAL:    { label: 'Horizontal',    glyph: '─', group: 'geometric',   hasValue: false, sigs: [['line']], eqs: 1 },
  VERTICAL:      { label: 'Vertical',      glyph: '│', group: 'geometric',   hasValue: false, sigs: [['line']], eqs: 1 },
  PARALLEL:      { label: 'Parallel',      glyph: '∥', group: 'geometric',   hasValue: false, sigs: [['line', 'line']], eqs: 1 },
  PERPENDICULAR: { label: 'Perpendicular', glyph: '⊥', group: 'geometric',   hasValue: false, sigs: [['line', 'line']], eqs: 1 },
  COLLINEAR:     { label: 'Collinear',     glyph: '⌒', group: 'geometric',   hasValue: false, sigs: [['line', 'line']], eqs: 2 },
  TANGENT:       { label: 'Tangent',       glyph: '◯', group: 'geometric',   hasValue: false, sigs: [['line', 'circle'], ['circle', 'line'], ['circle', 'circle']], eqs: 1 },
  CONCENTRIC:    { label: 'Concentric',    glyph: '⊙', group: 'geometric',   hasValue: false, sigs: [['circle', 'circle']], eqs: 2 },
  EQUAL:         { label: 'Equal',         glyph: '=', group: 'geometric',   hasValue: false, sigs: [['line', 'line'], ['circle', 'circle']], eqs: 1 },
  COINCIDENT:    { label: 'Coincident',    glyph: '⊕', group: 'geometric',   hasValue: false, sigs: [['point', 'point']], eqs: 2 },
  SYMMETRY:      { label: 'Symmetry',      glyph: '⋈', group: 'geometric',   hasValue: false, sigs: [['point', 'point', 'line']], eqs: 2 },
  FIXED:         { label: 'Fixed',         glyph: '⚓', group: 'geometric',   hasValue: false, sigs: [['line'], ['circle']], eqs: 0 },
  LENGTH:        { label: 'Length',        glyph: '↦', group: 'dimensional', hasValue: true,  sigs: [['line']], eqs: 1 },
  RADIUS:        { label: 'Radius',        glyph: 'R', group: 'dimensional', hasValue: true,  sigs: [['circle']], eqs: 1 },
  DISTANCE:      { label: 'Distance',      glyph: '↔', group: 'dimensional', hasValue: true,  sigs: [['point', 'point'], ['point', 'line'], ['line', 'point']], eqs: 1 },
  ANGLE:         { label: 'Angle',         glyph: '∠', group: 'dimensional', hasValue: true,  sigs: [['line', 'line']], eqs: 1 },
};

export const GEOMETRIC_TYPES: SketchConstraintType[] = [
  'COINCIDENT', 'HORIZONTAL', 'VERTICAL', 'PERPENDICULAR', 'PARALLEL',
  'TANGENT', 'COLLINEAR', 'CONCENTRIC', 'EQUAL', 'SYMMETRY', 'FIXED',
];
export const DIMENSIONAL_TYPES: SketchConstraintType[] = ['LENGTH', 'RADIUS', 'DISTANCE', 'ANGLE'];

/** Operand-kind of a selected ref, given the entity geoms it points into. */
export function refOperand(ref: SketchRef, geoms: EntityGeom[]): Operand | null {
  if (ref.kind === 'point') return 'point';
  const g = geoms.find((e) => e.id === ref.id);
  return g ? g.kind : null;
}

/** Does the current selection satisfy this constraint's operand signature? */
export function canApply(type: SketchConstraintType, refs: SketchRef[], geoms: EntityGeom[]): boolean {
  const meta = CONSTRAINT_META[type];
  const kinds = refs.map((r) => refOperand(r, geoms));
  if (kinds.some((k) => k === null)) return false;
  return meta.sigs.some((sig) => sig.length === kinds.length && sig.every((s, i) => s === kinds[i]));
}

// ─── Degrees of freedom ───────────────────────────────────────────────────────

export interface DoFInfo { vars: number; eqs: number; fixed: number; dof: number }

export function computeDoF(geoms: EntityGeom[], constraints: SketchConstraint[]): DoFInfo {
  const vars = geoms.reduce((s, g) => s + (g.kind === 'line' ? 4 : 3), 0);
  const fixedEntities = new Set<string>();
  let eqs = 0;
  for (const c of constraints) {
    if (c.type === 'FIXED') { if (c.refs[0]) fixedEntities.add(c.refs[0].id); continue; }
    eqs += CONSTRAINT_META[c.type].eqs;
  }
  let fixed = 0;
  for (const id of fixedEntities) {
    const g = geoms.find((e) => e.id === id);
    if (g) fixed += g.kind === 'line' ? 4 : 3;
  }
  return { vars, eqs, fixed, dof: Math.max(-99, vars - fixed - eqs) };
}
