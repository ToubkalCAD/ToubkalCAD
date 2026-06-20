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
  | { id: string; kind: 'circle'; c: [number, number]; r: number }
  // Arc: parametric centre + radius, with FIXED sweep angles a1→a2 (CCW). Only
  // [cx,cy,r] are solver variables; the two endpoints are derived from them, so
  // an arc behaves like a circle for centre/radius constraints (Concentric,
  // Equal, Tangent, Radius) while still exposing pickable endpoints.
  | { id: string; kind: 'arc';    c: [number, number]; r: number; a1: number; a2: number };

export interface SolveResult {
  geoms:      Record<string, EntityGeom>;
  converged:  boolean;
  residual:   number;
  iterations: number;
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

const MAX_ITERS = 140;
const RESTARTS  = 4;       // perturbed retries when a non-drag solve stalls
const TOL       = 1e-9;
const ANCHOR_W  = 0.02;    // soft-anchor weight — regularises null-space (minimal move)
// Rigidity anchor: preserves each line's CURRENT length when no explicit
// LENGTH/DISTANCE drives it, so an unconstrained line rotates instead of
// collapsing onto its projection (the 25→17 "shrink" bug). Weight sits well
// above ANCHOR_W (so rotation beats coordinate-collapse) yet far below the
// unit-weighted hard constraints (so a real LENGTH/DISTANCE still wins).
const RIGID_W   = 0.10;
// Arc-tangent contact bias: when a line is made tangent to an ARC (not a full
// circle), the bare `|dist|=r` residual is satisfied by ANY tangent to the
// underlying circle — the contact can land on the part of the circle the arc
// doesn't cover, so the line floats off the visible arc. This soft term pulls
// the tangent foot onto the nearest point of the arc's actual sweep, so the
// line touches the arc the user clicked. Soft (steers the null-space) but above
// ANCHOR_W/RIGID_W so it reliably wins the placement freedom.
const TAN_ARC_W = 0.30;
const FD_EPS    = 1e-6;
const LAMBDA_0  = 1e-3;
// Constraint-residual threshold for "satisfied". Lenient enough for the
// dimensionless angular residuals (normalised dot/cross ~ sin/cos of a
// fraction of a degree); dimensional (mm) residuals solve far tighter.
const CONVERGED = 2.5e-2;
// Relative slice of the sketch's coordinate spread added to CONVERGED, so the
// "satisfied" threshold tracks sketch size (0.1% of extent ⇒ visually exact).
const REL_TOL   = 1e-3;

// ─── Variable layout ──────────────────────────────────────────────────────────
//   line        → [a.u, a.v, b.u, b.v]
//   circle/arc  → [c.u, c.v, r]   (arc additionally carries its static a1/a2)

interface VarBlock { kind: 'line' | 'circle' | 'arc'; base: number; a1?: number; a2?: number }

function buildLayout(geoms: EntityGeom[]) {
  const blocks = new Map<string, VarBlock>();
  const x: number[] = [];
  for (const g of geoms) {
    const base = x.length;
    if (g.kind === 'line')        { x.push(g.a[0], g.a[1], g.b[0], g.b[1]); blocks.set(g.id, { kind: 'line', base }); }
    else if (g.kind === 'arc')    { x.push(g.c[0], g.c[1], g.r);            blocks.set(g.id, { kind: 'arc', base, a1: g.a1, a2: g.a2 }); }
    else                          { x.push(g.c[0], g.c[1], g.r);            blocks.set(g.id, { kind: 'circle', base }); }
  }
  return { blocks, x };
}

// ─── Reference resolution ─────────────────────────────────────────────────────

/** Variable indices [uIdx, vIdx] of a point operand whose coords are themselves
 *  solver variables (line endpoints, circle/arc centre), or null otherwise. */
function pointIdx(ref: SketchRef, blocks: Map<string, VarBlock>): [number, number] | null {
  const blk = blocks.get(ref.id);
  if (!blk) return null;
  if (ref.pt === 'a' && blk.kind === 'line')                       return [blk.base + 0, blk.base + 1];
  if (ref.pt === 'b' && blk.kind === 'line')                       return [blk.base + 2, blk.base + 3];
  if (ref.pt === 'c' && (blk.kind === 'circle' || blk.kind === 'arc')) return [blk.base + 0, blk.base + 1];
  return null;
}

/** World coords of a point operand. Handles arc endpoints ('a'/'b'), which are
 *  derived from [cx,cy,r] + the static sweep angle rather than stored directly. */
function pointCoords(ref: SketchRef, x: number[], blocks: Map<string, VarBlock>): [number, number] | null {
  const idx = pointIdx(ref, blocks);
  if (idx) return [x[idx[0]], x[idx[1]]];
  const blk = blocks.get(ref.id);
  if (blk?.kind === 'arc' && (ref.pt === 'a' || ref.pt === 'b')) {
    const ang = ref.pt === 'a' ? blk.a1! : blk.a2!;
    return [x[blk.base] + x[blk.base + 2] * Math.cos(ang), x[blk.base + 1] + x[blk.base + 2] * Math.sin(ang)];
  }
  return null;
}

interface LineCoords { ax: number; ay: number; bx: number; by: number }
function lineCoords(x: number[], blocks: Map<string, VarBlock>, id: string): LineCoords | null {
  const blk = blocks.get(id);
  if (blk?.kind !== 'line') return null;
  return { ax: x[blk.base], ay: x[blk.base + 1], bx: x[blk.base + 2], by: x[blk.base + 3] };
}

interface CircleCoords { cx: number; cy: number; r: number }
/** Centre + radius of a circle OR an arc (both carry [cx,cy,r] in that order). */
function centerRadius(x: number[], blocks: Map<string, VarBlock>, id: string): CircleCoords | null {
  const blk = blocks.get(id);
  if (blk?.kind !== 'circle' && blk?.kind !== 'arc') return null;
  return { cx: x[blk.base], cy: x[blk.base + 1], r: x[blk.base + 2] };
}

/** Signed perpendicular distance of point P to the infinite line through A,B. */
function perpDist(px: number, py: number, L: LineCoords): number {
  const dx = L.bx - L.ax, dy = L.by - L.ay;
  const n = Math.hypot(dx, dy) || 1;
  return ((px - L.ax) * -dy + (py - L.ay) * dx) / n;
}

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** Nearest angle inside an arc's CCW sweep [a1 → a2] to the probe angle `th`.
 *  Returns `th` itself when it already lies within the sweep; otherwise snaps to
 *  whichever endpoint is angularly closer (handles wrap-around). */
function clampAngleToArc(th: number, a1: number, a2: number): number {
  let sweep = ((a2 - a1) % TWO_PI + TWO_PI) % TWO_PI;   // → (0, 2π]
  if (sweep === 0) sweep = TWO_PI;                       // full turn
  const delta = ((th - a1) % TWO_PI + TWO_PI) % TWO_PI;  // [0, 2π)
  if (delta <= sweep) return th;                         // inside the sweep
  return (delta - sweep) < (TWO_PI - delta) ? a1 + sweep : a1; // nearer end (≡ a2 / a1)
}

// ─── Residual assembly ────────────────────────────────────────────────────────

/** A live-drag objective: bias a point operand's rest position to the cursor. */
export interface DragPin { ref: SketchRef; target: [number, number] }

function residuals(
  x: number[], x0: number[], fixed: boolean[],
  blocks: Map<string, VarBlock>, constraints: SketchConstraint[],
  withAnchor = true, rigidLines?: Set<string>, rigidRadii?: Set<string>,
): number[] {
  const R: number[] = [];
  const P = (ref: SketchRef): [number, number] | null => pointCoords(ref, x, blocks);

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
        const C = centerRadius(x, blocks, e0);
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
        const C1 = centerRadius(x, blocks, e0), C2 = centerRadius(x, blocks, e1);
        if (C1 && C2) R.push(C1.r - C2.r);
        break;
      }
      case 'CONCENTRIC': {
        const C1 = centerRadius(x, blocks, e0), C2 = centerRadius(x, blocks, e1);
        if (C1 && C2) { R.push(C1.cx - C2.cx); R.push(C1.cy - C2.cy); }
        break;
      }
      case 'TANGENT': {
        const La = lineCoords(x, blocks, e0), Lb = lineCoords(x, blocks, e1);
        const Ca = centerRadius(x, blocks, e0), Cb = centerRadius(x, blocks, e1);
        if ((La && Cb) || (Lb && Ca)) {
          // Line ↔ circle OR arc: distance from centre to the line equals the
          // radius. Smooth and side-agnostic — it never drives r negative (the
          // earlier arc-side `sign()` variant collapsed the arc to r≈0).
          const L = (La ?? Lb)!, C = (Cb ?? Ca)!;
          const d = perpDist(C.cx, C.cy, L);
          // Smooth tangency residual (d²−r²)/(2r): zero at d=±r and ≈(|d|−r)
          // near either solution, but C¹-continuous through d=0 instead of the
          // |d|−r kink — which gave LM a bad local-minimum basin whenever the
          // line started crossing the centre (the "stalls at 0.04mm" cases).
          R.push((d * d - C.r * C.r) / (2 * C.r));
          // For an ARC operand the bare residual above is satisfied by a tangent
          // anywhere on the full circle — including the gap the arc doesn't span,
          // so the line drifts off the visible arc. Add a soft term steering the
          // tangent foot (centre projected onto the line) onto the arc's sweep,
          // toward the side the geometry already favours. Soft → excluded from
          // the constraint-error measure (gated by withAnchor).
          const arcBlk = blocks.get((La ? e1 : e0));
          if (withAnchor && arcBlk?.kind === 'arc') {
            const dx = L.bx - L.ax, dy = L.by - L.ay;
            const n = Math.hypot(dx, dy) || 1;
            const nx = -dy / n, ny = dx / n;             // unit line normal
            const fx = C.cx - d * nx, fy = C.cy - d * ny; // foot of perpendicular
            const th  = Math.atan2(fy - C.cy, fx - C.cx);
            const thC = clampAngleToArc(th, arcBlk.a1!, arcBlk.a2!);
            const tx = C.cx + C.r * Math.cos(thC), ty = C.cy + C.r * Math.sin(thC);
            R.push(TAN_ARC_W * (fx - tx));
            R.push(TAN_ARC_W * (fy - ty));
          }
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
  if (withAnchor) {
    for (let i = 0; i < x.length; i++) if (!fixed[i]) R.push(ANCHOR_W * (x[i] - x0[i]));
    // Rigidity: hold each free line's length at its drawn value unless an
    // explicit dimension drives it — lets the line rotate, not shrink.
    if (rigidLines) for (const [id, blk] of blocks) {
      if (blk.kind !== 'line' || !rigidLines.has(id)) continue;
      const b = blk.base;
      if (fixed[b] && fixed[b + 1] && fixed[b + 2] && fixed[b + 3]) continue;
      const len  = Math.hypot(x[b + 2]  - x[b],  x[b + 3]  - x[b + 1]);
      const len0 = Math.hypot(x0[b + 2] - x0[b], x0[b + 3] - x0[b + 1]);
      R.push(RIGID_W * (len - len0));
    }
    // Rigidity: hold each free circle/arc's radius at its drawn value unless an
    // explicit RADIUS/EQUAL drives it — so e.g. tangenting a line to an arc moves
    // the LINE to touch it rather than resizing the arc.
    if (rigidRadii) for (const [id, blk] of blocks) {
      if ((blk.kind !== 'circle' && blk.kind !== 'arc') || !rigidRadii.has(id)) continue;
      const ri = blk.base + 2;
      if (fixed[ri]) continue;
      R.push(RIGID_W * (x[ri] - x0[ri]));
    }
  }
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

export function solveConstraints(geomsIn: EntityGeom[], constraints: SketchConstraint[], dragPin?: DragPin): SolveResult {
  const geoms: EntityGeom[] = geomsIn.map((g) =>
    g.kind === 'line'  ? { id: g.id, kind: 'line', a: [...g.a], b: [...g.b] }
    : g.kind === 'arc' ? { id: g.id, kind: 'arc', c: [...g.c], r: g.r, a1: g.a1, a2: g.a2 }
    :                    { id: g.id, kind: 'circle', c: [...g.c], r: g.r });

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

  // Scale-aware convergence tolerance. The residuals of length-dimension
  // constraints (tangent, distance, coincident…) scale with the sketch, so a
  // fixed absolute threshold flags a tangent that's tens of microns off on a
  // 100mm sketch as "unsolved" — yet it's geometrically perfect. Use a relative
  // tolerance keyed to the free-coordinate spread (datum axes are FIXED, so they
  // never enter freeIdx and can't inflate it). Genuine conflicts sit orders of
  // magnitude above this, so real contradictions are still caught.
  let clo = Infinity, chi = -Infinity;
  for (const i of freeIdx) { if (x0[i] < clo) clo = x0[i]; if (x0[i] > chi) chi = x0[i]; }
  const spread  = chi > clo ? chi - clo : 0;
  const convTol = Math.max(CONVERGED, REL_TOL * spread);

  // Lines eligible for the rigidity anchor: every line EXCEPT those whose length
  // is already pinned by an explicit driver (LENGTH on the line, or DISTANCE
  // between its own two endpoints). Those must follow the user's number freely.
  const rigidLines = new Set<string>();
  for (const g of geoms) if (g.kind === 'line') rigidLines.add(g.id);
  for (const c of constraints) {
    if (c.type === 'LENGTH' && c.refs[0]) rigidLines.delete(c.refs[0].id);
    if (c.type === 'DISTANCE' && c.refs.length === 2
        && c.refs[0].kind === 'point' && c.refs[1].kind === 'point'
        && c.refs[0].id === c.refs[1].id) {
      rigidLines.delete(c.refs[0].id);
    }
  }

  // Circles/arcs whose radius should be held at its drawn value — every one
  // EXCEPT those a RADIUS or EQUAL constraint explicitly drives.
  const rigidRadii = new Set<string>();
  for (const g of geoms) if (g.kind === 'circle' || g.kind === 'arc') rigidRadii.add(g.id);
  for (const c of constraints) {
    if (c.type === 'RADIUS' && c.refs[0]) rigidRadii.delete(c.refs[0].id);
    if (c.type === 'EQUAL') for (const r of c.refs) rigidRadii.delete(r.id);
  }

  // Live drag: bias the dragged point's REST position (x0) — which the soft
  // anchor pulls toward — to the cursor, and seed its current value there. The
  // unit-weight hard constraints still dominate the tiny anchor, so a fully
  // constrained point only slides within its manifold to the nearest cursor
  // point, while a free point follows the cursor exactly. The dragged line is
  // also exempt from rigidity so it may change length to follow.
  if (dragPin) {
    rigidLines.delete(dragPin.ref.id);
    const idx = pointIdx(dragPin.ref, blocks);
    if (idx) for (let k = 0; k < 2; k++) {
      if (!fixed[idx[k]]) { x[idx[k]] = dragPin.target[k]; x0[idx[k]] = dragPin.target[k]; }
    }
  }

  const evalR = (xv: number[]) => residuals(xv, x0, fixed, blocks, constraints, true, rigidLines, rigidRadii);
  // Constraint-only error (no anchor / no drag pin) → drives the converged flag + status.
  const constraintErr = () => norm2(residuals(x, x0, fixed, blocks, constraints, false));

  const nf = freeIdx.length;
  if (nf === 0 || evalR(x).length === 0) {
    const ce = constraintErr();
    return { geoms: writeBack(geoms, blocks, x), converged: ce < convTol, residual: ce, iterations: 0 };
  }

  // One full Levenberg–Marquardt descent from the current xv, mutating it in
  // place. Returns the iteration count used.
  const iterate = (xv: number[]): number => {
    let R = evalR(xv);
    let cost = norm2(R);
    let lambda = LAMBDA_0;
    let it = 0;
    for (; it < MAX_ITERS; it++) {
      if (cost < TOL) break;
      const m = R.length;

      const J: number[][] = Array.from({ length: m }, () => new Array(nf).fill(0));
      for (let j = 0; j < nf; j++) {
        const vi = freeIdx[j];
        const saved = xv[vi];
        const h = FD_EPS * (Math.abs(saved) + 1);
        xv[vi] = saved + h;
        const Rp = evalR(xv);
        xv[vi] = saved;
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
        const trial = [...xv];
        for (let j = 0; j < nf; j++) trial[freeIdx[j]] += delta[j];
        const Rt = evalR(trial);
        const ct = norm2(Rt);
        if (ct < cost) {
          for (let j = 0; j < nf; j++) xv[freeIdx[j]] = trial[freeIdx[j]];
          R = Rt; cost = ct; lambda = Math.max(lambda * 0.5, 1e-9); applied = true;
        } else { lambda *= 4; }
      }
      if (!applied) break;
    }
    return it;
  };

  const errAt = (xv: number[]) => norm2(residuals(xv, x0, fixed, blocks, constraints, false));

  let iters = iterate(x);
  let bestErr = errAt(x);

  // Multi-restart: if a (non-drag) solve stalls above tolerance it may be wedged
  // in a shallow local minimum, NOT genuinely over-constrained. Retry from a few
  // deterministically-perturbed seeds around the best result and keep whichever
  // lands lowest. Deterministic (no Math.random) so identical inputs re-solve
  // identically — no jitter. Skipped while dragging (must stay cheap + stable).
  if (!dragPin && bestErr >= convTol) {
    let lo = Infinity, hi = -Infinity;
    for (const i of freeIdx) { if (x0[i] < lo) lo = x0[i]; if (x0[i] > hi) hi = x0[i]; }
    const spread = Math.max(hi - lo, 10) * 0.2;   // perturbation scale ~ sketch size
    let best = [...x];
    for (let rs = 0; rs < RESTARTS && bestErr >= convTol; rs++) {
      const xs = [...best];
      for (const i of freeIdx) {
        const s = Math.sin((i + 1) * 12.9898 + (rs + 1) * 78.233) * 43758.5453;
        xs[i] += ((s - Math.floor(s)) * 2 - 1) * spread;   // deterministic [-1,1]·spread
      }
      iters += iterate(xs);
      const e = errAt(xs);
      if (e < bestErr) { bestErr = e; best = [...xs]; }
    }
    for (let i = 0; i < n; i++) x[i] = best[i];
  }

  return { geoms: writeBack(geoms, blocks, x), converged: bestErr < convTol, residual: bestErr, iterations: iters };
}

function writeBack(geoms: EntityGeom[], blocks: Map<string, VarBlock>, x: number[]): Record<string, EntityGeom> {
  const out: Record<string, EntityGeom> = {};
  for (const g of geoms) {
    const blk = blocks.get(g.id)!;
    if (g.kind === 'line') { g.a = [x[blk.base], x[blk.base + 1]]; g.b = [x[blk.base + 2], x[blk.base + 3]]; }
    else                   { g.c = [x[blk.base], x[blk.base + 1]]; g.r = Math.max(1e-4, x[blk.base + 2]); } // circle + arc (a1/a2 preserved)
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

/** Operand-kind of a selected ref, given the entity geoms it points into. An arc
 *  is treated as a 'circle' operand: it has a centre + radius, so every circle
 *  constraint (Radius, Equal, Concentric, Tangent) applies to it unchanged. */
export function refOperand(ref: SketchRef, geoms: EntityGeom[]): Operand | null {
  if (ref.kind === 'point') return 'point';
  const g = geoms.find((e) => e.id === ref.id);
  if (!g) return null;
  return g.kind === 'arc' ? 'circle' : g.kind;
}

/** Does the current selection satisfy this constraint's operand signature? */
export function canApply(type: SketchConstraintType, refs: SketchRef[], geoms: EntityGeom[]): boolean {
  const meta = CONSTRAINT_META[type];
  const kinds = refs.map((r) => refOperand(r, geoms));
  if (kinds.some((k) => k === null)) return false;
  return meta.sigs.some((sig) => sig.length === kinds.length && sig.every((s, i) => s === kinds[i]));
}

// ─── Conflict pre-filtering (standard-CAD constraint gating) ──────────────────
// Mutually-exclusive geometric constraints on the SAME operand set. A line can't
// be both Horizontal and Vertical; two lines can't be both Parallel and
// Perpendicular. We reject these (and exact duplicates) up-front instead of
// letting the solver fail with an over-constrained residual.

const EXCLUSIVE: Partial<Record<SketchConstraintType, SketchConstraintType[]>> = {
  HORIZONTAL:    ['VERTICAL', 'ANGLE'],
  VERTICAL:      ['HORIZONTAL', 'ANGLE'],
  PARALLEL:      ['PERPENDICULAR', 'ANGLE'],
  PERPENDICULAR: ['PARALLEL', 'ANGLE'],
  ANGLE:         ['HORIZONTAL', 'VERTICAL', 'PARALLEL', 'PERPENDICULAR'],
};

const refsKey = (refs: SketchRef[]) =>
  refs.map((r) => `${r.id}:${r.pt ?? ''}`).sort().join('|');

/**
 * Reason this constraint type cannot be added to the current selection given the
 * already-applied constraints, or null if it's allowed. Drives UI disabling so
 * conflicting/redundant options are greyed out before they create an
 * over-constrained system. Operand-shape mismatches are handled by `canApply`.
 */
export function constraintBlocked(
  type: SketchConstraintType, sel: SketchRef[], constraints: SketchConstraint[],
): string | null {
  if (sel.length === 0) return null;
  const selKey = refsKey(sel);
  for (const c of constraints) {
    if (refsKey(c.refs) !== selKey) continue;
    if (c.type === type) return `${CONSTRAINT_META[type].label} already applied`;
    if (EXCLUSIVE[type]?.includes(c.type)) return `Conflicts with ${CONSTRAINT_META[c.type].label}`;
  }
  return null;
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
