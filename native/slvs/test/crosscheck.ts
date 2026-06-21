// ============================================================
// ToubkalCAD – solver cross-check harness (headless)
//
// Runs a battery of sketch cases through BOTH solvers behind the ISketchSolver
// seam and validates each result with an INDEPENDENT geometric checker (it
// trusts neither solver's self-reported residual). For gauge-fixed cases
// (pinned to the origin datum) it also asserts the two solvers AGREE on coords.
//
//   Legacy LM   : always available (pure TS, type-only imports).
//   SolveSpace  : loaded via guarded dynamic import; SKIPPED (not failed) until
//                 native/slvs/build.sh has produced wasm/libslvs.mjs.
//
// Run:  npx tsx native/slvs/test/crosscheck.ts      (or: npm run test:solver)
// Exit: non-zero if any solver that ran fails a case.
// ============================================================

import { solveConstraints } from '../../../src/services/SketchConstraintSolver';
import type { EntityGeom } from '../../../src/services/SketchConstraintSolver';
import { datumGeoms, datumFixedConstraints, isDatumId, ORIGIN_REF } from '../../../src/services/SketchDatums';
import type { ISketchSolver } from '../../../src/services/solver/ISketchSolver';
import type { SketchConstraint, SketchRef } from '../../../src/store/cadStore';

// ─── test battery ──────────────────────────────────────────────────────────────

interface Case {
  name: string;
  geoms: EntityGeom[];
  constraints: SketchConstraint[];
  drag?: { ref: SketchRef; target: [number, number] };
  /** pinned to a datum ⇒ unique solution ⇒ the two solvers must agree on coords. */
  compareCoords?: boolean;
}

const C = (type: SketchConstraint['type'], refs: SketchRef[], value?: number): SketchConstraint =>
  ({ id: `${type}-${refs.map((r) => r.id + (r.pt ?? '')).join('-')}`, type, refs, value });
const E  = (id: string): SketchRef => ({ kind: 'entity', id });
const PT = (id: string, pt: 'a' | 'b' | 'c'): SketchRef => ({ kind: 'point', id, pt });

const cases: Case[] = [
  {
    name: 'horizontal + length',
    geoms: [{ id: 'L', kind: 'line', a: [0, 0], b: [40, 7] }],
    constraints: [C('HORIZONTAL', [E('L')]), C('LENGTH', [E('L')], 50)],
  },
  {
    name: 'perpendicular corner with lengths',
    geoms: [
      { id: 'L1', kind: 'line', a: [0, 0], b: [30, 3] },
      { id: 'L2', kind: 'line', a: [30, 3], b: [27, 18] },
    ],
    constraints: [
      C('COINCIDENT', [PT('L1', 'b'), PT('L2', 'a')]),
      C('PERPENDICULAR', [E('L1'), E('L2')]),
      C('HORIZONTAL', [E('L1')]),
      C('LENGTH', [E('L1')], 30),
      C('LENGTH', [E('L2')], 20),
    ],
  },
  {
    name: 'parallel lines',
    geoms: [
      { id: 'L1', kind: 'line', a: [0, 0], b: [20, 4] },
      { id: 'L2', kind: 'line', a: [0, 10], b: [22, 9] },
    ],
    constraints: [C('PARALLEL', [E('L1'), E('L2')])],
  },
  {
    name: 'point-point distance',
    geoms: [
      { id: 'L1', kind: 'line', a: [0, 0], b: [5, 0] },
      { id: 'L2', kind: 'line', a: [18, 4], b: [25, 4] },
    ],
    constraints: [C('DISTANCE', [PT('L1', 'a'), PT('L2', 'a')], 25)],
  },
  {
    name: 'concentric + radius',
    geoms: [
      { id: 'C1', kind: 'circle', c: [10, 10], r: 4 },
      { id: 'C2', kind: 'circle', c: [13, 8], r: 9 },
    ],
    constraints: [C('CONCENTRIC', [E('C1'), E('C2')]), C('RADIUS', [E('C1')], 5)],
  },
  {
    name: 'equal length lines',
    geoms: [
      { id: 'L1', kind: 'line', a: [0, 0], b: [20, 0] },
      { id: 'L2', kind: 'line', a: [0, 10], b: [14, 10] },
    ],
    constraints: [C('LENGTH', [E('L1')], 20), C('EQUAL', [E('L1'), E('L2')])],
  },
  {
    name: 'equal radius circles',
    geoms: [
      { id: 'C1', kind: 'circle', c: [0, 0], r: 5 },
      { id: 'C2', kind: 'circle', c: [20, 0], r: 9 },
    ],
    constraints: [C('RADIUS', [E('C1')], 5), C('EQUAL', [E('C1'), E('C2')])],
  },
  {
    name: 'angle 60° between lines',
    geoms: [
      { id: 'L1', kind: 'line', a: [0, 0], b: [20, 0] },
      { id: 'L2', kind: 'line', a: [0, 0], b: [10, 10] },
    ],
    constraints: [
      C('COINCIDENT', [PT('L1', 'a'), PT('L2', 'a')]),
      C('HORIZONTAL', [E('L1')]),
      C('ANGLE', [E('L1'), E('L2')], 60),
    ],
  },
  {
    name: 'collinear lines',
    geoms: [
      { id: 'L1', kind: 'line', a: [0, 0], b: [20, 0] },
      { id: 'L2', kind: 'line', a: [30, 5], b: [50, 8] },
    ],
    constraints: [C('HORIZONTAL', [E('L1')]), C('COLLINEAR', [E('L1'), E('L2')])],
  },
  {
    name: 'symmetry about vertical axis',
    geoms: [
      { id: 'AX', kind: 'line', a: [0, 0], b: [0, 20] },
      { id: 'L1', kind: 'line', a: [5, 5], b: [9, 5] },
      { id: 'L2', kind: 'line', a: [-7, 9], b: [-11, 9] },
    ],
    constraints: [C('VERTICAL', [E('AX')]), C('SYMMETRY', [PT('L1', 'a'), PT('L2', 'a'), E('AX')])],
  },
  {
    name: 'line tangent to circle',
    geoms: [
      { id: 'C', kind: 'circle', c: [20, 20], r: 6 },
      { id: 'L', kind: 'line', a: [0, 0], b: [40, 0] },
    ],
    constraints: [C('RADIUS', [E('C')], 6), C('HORIZONTAL', [E('L')]), C('TANGENT', [E('L'), E('C')])],
  },
  {
    name: 'line tangent to arc',
    geoms: [
      { id: 'A', kind: 'arc', c: [15, 14], r: 5, a1: 0, a2: Math.PI },
      { id: 'L', kind: 'line', a: [0, 0], b: [40, 0] },
    ],
    constraints: [C('HORIZONTAL', [E('L')]), C('TANGENT', [E('L'), E('A')])],
  },
  {
    name: 'circle tangent circle (external)',
    geoms: [
      { id: 'C1', kind: 'circle', c: [0, 0], r: 5 },
      { id: 'C2', kind: 'circle', c: [20, 0], r: 8 },
    ],
    constraints: [C('RADIUS', [E('C1')], 5), C('RADIUS', [E('C2')], 8), C('TANGENT', [E('C1'), E('C2')])],
  },
  {
    name: 'circle tangent circle (internal)',
    geoms: [
      { id: 'C1', kind: 'circle', c: [0, 0], r: 10 },
      { id: 'C2', kind: 'circle', c: [3, 0], r: 4 },
    ],
    constraints: [C('RADIUS', [E('C1')], 10), C('RADIUS', [E('C2')], 4), C('TANGENT', [E('C1'), E('C2')])],
  },
  {
    name: 'drag pinned line (origin + length 50)',
    geoms: [{ id: 'L', kind: 'line', a: [0, 0], b: [10, 0] }],
    constraints: [C('COINCIDENT', [PT('L', 'a'), ORIGIN_REF]), C('LENGTH', [E('L')], 50)],
    drag: { ref: PT('L', 'b'), target: [40, 30] },   // |(40,30)| = 50 ⇒ b should land ≈ (40,30)
    compareCoords: true,
  },
];

// ─── independent geometric checker (trusts neither solver) ──────────────────────

// Sized to the legacy LM oracle's convergence precision (~0.1mm / few-mrad on
// these sketches) — it's the looser of the two solvers. Real violations
// (unsolved / over-constrained) sit orders of magnitude above this. SolveSpace
// solves far tighter, so it sits well under TOL too.
const TOL = 1e-1;   // mm for lengths/distances; radians for angular residuals
const DEG = Math.PI / 180;

function geomMap(solved: Record<string, EntityGeom>): Map<string, EntityGeom> {
  const m = new Map<string, EntityGeom>();
  for (const g of Object.values(solved)) m.set(g.id, g);
  return m;
}

function pointOf(ref: SketchRef, m: Map<string, EntityGeom>): [number, number] | null {
  if (ref.id === ORIGIN_REF.id && ref.pt === 'a') return [0, 0];   // datum origin
  const g = m.get(ref.id);
  if (!g) return null;
  if (g.kind === 'line') return ref.pt === 'b' ? g.b : g.a;
  if (g.kind === 'circle') return g.c;
  if (ref.pt === 'a') return [g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1)];
  if (ref.pt === 'b') return [g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2)];
  return g.c;
}
const dir = (g: EntityGeom): [number, number] | null =>
  g.kind === 'line' ? [g.b[0] - g.a[0], g.b[1] - g.a[1]] : null;
const norm = (d: [number, number]) => Math.hypot(d[0], d[1]) || 1;

type LineGeom = Extract<EntityGeom, { kind: 'line' }>;
/** Signed perpendicular distance of point p to the infinite line through L.a,L.b. */
function perpDist(p: [number, number], L: LineGeom): number {
  const dx = L.b[0] - L.a[0], dy = L.b[1] - L.a[1];
  const n = Math.hypot(dx, dy) || 1;
  return ((p[0] - L.a[0]) * -dy + (p[1] - L.a[1]) * dx) / n;
}

/** Max constraint violation across a solved result (0 = perfectly satisfied). */
function maxViolation(solved: Record<string, EntityGeom>, constraints: SketchConstraint[]): number {
  const m = geomMap(solved);
  let worst = 0;
  const hit = (v: number) => { if (Math.abs(v) > worst) worst = Math.abs(v); };

  for (const c of constraints) {
    const g0 = m.get(c.refs[0]?.id), g1 = m.get(c.refs[1]?.id);
    switch (c.type) {
      case 'HORIZONTAL': if (g0?.kind === 'line') hit(g0.a[1] - g0.b[1]); break;
      case 'VERTICAL':   if (g0?.kind === 'line') hit(g0.a[0] - g0.b[0]); break;
      case 'LENGTH':     if (g0?.kind === 'line' && c.value != null) hit(Math.hypot(g0.b[0] - g0.a[0], g0.b[1] - g0.a[1]) - c.value); break;
      case 'RADIUS':     if ((g0?.kind === 'circle' || g0?.kind === 'arc') && c.value != null) hit(g0.r - c.value); break;
      case 'PARALLEL': case 'PERPENDICULAR': {
        if (g0 && g1) { const d0 = dir(g0), d1 = dir(g1); if (d0 && d1) {
          const n = norm(d0) * norm(d1);
          hit(c.type === 'PARALLEL' ? (d0[0] * d1[1] - d0[1] * d1[0]) / n : (d0[0] * d1[0] + d0[1] * d1[1]) / n);
        } } break;
      }
      case 'CONCENTRIC': if (g0 && g1 && g0.kind !== 'line' && g1.kind !== 'line') { hit(g0.c[0] - g1.c[0]); hit(g0.c[1] - g1.c[1]); } break;
      case 'COINCIDENT': case 'DISTANCE': {
        const p0 = pointOf(c.refs[0], m), p1 = pointOf(c.refs[1], m);
        if (p0 && p1) hit(Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) - (c.type === 'DISTANCE' ? (c.value ?? 0) : 0));
        break;
      }
      case 'TANGENT': {
        if (!g0 || !g1) break;
        const line = g0.kind === 'line' ? g0 : g1.kind === 'line' ? g1 : null;
        if (line) {
          const curve = line === g0 ? g1 : g0;            // the non-line operand
          if (curve.kind !== 'line') hit(Math.abs(perpDist(curve.c, line)) - curve.r);  // |centre→line| = r
        } else if (g0.kind !== 'line' && g1.kind !== 'line') {
          const d = Math.hypot(g0.c[0] - g1.c[0], g0.c[1] - g1.c[1]);
          const ext = Math.abs(d - (g0.r + g1.r));        // external tangency
          const int = Math.abs(d - Math.abs(g0.r - g1.r));// internal tangency
          hit(Math.min(ext, int));                        // satisfied if EITHER mode holds
        }
        break;
      }
      case 'EQUAL': {
        if (!g0 || !g1) break;
        if (g0.kind === 'line' && g1.kind === 'line')
          hit(Math.hypot(g0.b[0] - g0.a[0], g0.b[1] - g0.a[1]) - Math.hypot(g1.b[0] - g1.a[0], g1.b[1] - g1.a[1]));
        else if (g0.kind !== 'line' && g1.kind !== 'line')
          hit(g0.r - g1.r);
        break;
      }
      case 'ANGLE': {
        if (g0?.kind === 'line' && g1?.kind === 'line' && c.value != null) {
          const u1 = g0.b[0] - g0.a[0], v1 = g0.b[1] - g0.a[1];
          const u2 = g1.b[0] - g1.a[0], v2 = g1.b[1] - g1.a[1];
          let diff = Math.atan2(u1 * v2 - v1 * u2, u1 * u2 + v1 * v2) - c.value * DEG;  // signed
          while (diff >  Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          hit(diff);
        }
        break;
      }
      case 'COLLINEAR': {
        if (g0?.kind === 'line' && g1?.kind === 'line') { hit(perpDist(g1.a, g0)); hit(perpDist(g1.b, g0)); }
        break;
      }
      case 'SYMMETRY': {
        const p1 = pointOf(c.refs[0], m), p2 = pointOf(c.refs[1], m), axis = m.get(c.refs[2]?.id);
        if (p1 && p2 && axis?.kind === 'line') {
          const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
          hit(perpDist(mid, axis));                                            // midpoint on axis
          const d = dir(axis)!, n = norm(d);
          hit(((p1[0] - p2[0]) * d[0] + (p1[1] - p2[1]) * d[1]) / n);          // p1−p2 ⟂ axis
        }
        break;
      }
    }
  }
  return worst;
}

function coordDiff(a: Record<string, EntityGeom>, b: Record<string, EntityGeom>): number {
  let worst = 0;
  for (const g of Object.values(a)) {
    if (isDatumId(g.id)) continue;
    const h = b[g.id]; if (!h || g.kind !== h.kind) continue;
    if (g.kind === 'line' && h.kind === 'line')
      worst = Math.max(worst, Math.abs(g.a[0]-h.a[0]), Math.abs(g.a[1]-h.a[1]), Math.abs(g.b[0]-h.b[0]), Math.abs(g.b[1]-h.b[1]));
    else if (g.kind === 'circle' && h.kind === 'circle')
      worst = Math.max(worst, Math.abs(g.c[0]-h.c[0]), Math.abs(g.c[1]-h.c[1]), Math.abs(g.r-h.r));
  }
  return worst;
}

// ─── run ─────────────────────────────────────────────────────────────────────

/** legacy via the same call shape the app uses (datums appended). */
function runLegacy(tc: Case): Record<string, EntityGeom> {
  const res = solveConstraints([...tc.geoms, ...datumGeoms()], [...tc.constraints, ...datumFixedConstraints()], tc.drag);
  return res.geoms;
}

async function loadSolveSpace(): Promise<ISketchSolver | null> {
  try {
    const mod = await import('../../../src/services/solver/SolveSpaceSolverAdapter');
    const ss = new mod.SolveSpaceSolverAdapter();
    await ss.init();
    return ss;
  } catch (e: any) {
    console.log(`\n⚠ SolveSpace adapter unavailable — cross-check SKIPPED.\n  (${e?.message ?? e})`);
    console.log('  Build it first:  cd native/slvs && ./build.sh\n');
    return null;
  }
}

async function loadPlaneGCS(): Promise<ISketchSolver | null> {
  try {
    const mod = await import('../../../src/services/solver/PlaneGCSSolverAdapter');
    // No wasmUrl in Node: the unbundled emscripten glue resolves its sibling
    // planegcs.wasm itself (the browser path passes a file-loader URL instead).
    const pg = new mod.PlaneGCSSolverAdapter();
    await pg.init();
    return pg;
  } catch (e: any) {
    console.log(`\n⚠ PlaneGCS adapter unavailable — cross-check SKIPPED.\n  (${e?.message ?? e})`);
    console.log('  Install it first:  npm i @salusoft89/planegcs\n');
    return null;
  }
}

const fmt = (v: number) => v.toExponential(2);

/** Run one adapter over a case, scoring its violation (and coord-agreement with
 *  the legacy oracle for gauge-fixed cases). Returns a display column + #failures. */
function runSolver(
  name: string,
  solver: ISketchSolver,
  tc: Case,
  legacy: Record<string, EntityGeom>,
): { col: string; fail: number } {
  const r = solver.solve([...tc.geoms, ...datumGeoms()], [...tc.constraints, ...datumFixedConstraints()], tc.drag);
  const viol = maxViolation(r.geoms, tc.constraints);
  const ok = viol <= TOL && r.converged;
  let fail = ok ? 0 : 1;
  let col = `${ok ? '✓' : '✗'} ${name} ${fmt(viol).padStart(8)} (conv=${r.converged})`;
  if (tc.compareCoords) {
    const diff = coordDiff(legacy, r.geoms);
    const agree = diff <= TOL;
    if (!agree) fail++;
    col += ` ${agree ? '≈' : '≠'} agree ${fmt(diff)}`;
  }
  return { col, fail };
}

async function main() {
  const ss = await loadSolveSpace();
  const pg = await loadPlaneGCS();
  let failures = 0;

  console.log(`\nsolver cross-check — ${cases.length} cases   (tol ${TOL})\n` + '─'.repeat(64));
  for (const tc of cases) {
    const legacy = runLegacy(tc);
    const lViol = maxViolation(legacy, tc.constraints);
    const lOk = lViol <= TOL;
    if (!lOk) failures++;

    let line = `${lOk ? '✓' : '✗'} legacy ${fmt(lViol).padStart(8)}`;
    if (ss) { const r = runSolver('solvespace', ss, tc, legacy); line += `   |   ${r.col}`; failures += r.fail; }
    if (pg) { const r = runSolver('planegcs',   pg, tc, legacy); line += `   |   ${r.col}`; failures += r.fail; }
    console.log(`${tc.name.padEnd(38)} ${line}`);
  }
  console.log('─'.repeat(64));

  if (!ss && !pg) { console.log('legacy-only run complete (no WASM solver available).'); process.exit(failures > 0 ? 1 : 0); }
  console.log(failures === 0 ? 'ALL PASS ✅' : `${failures} FAILURE(S) ❌`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
