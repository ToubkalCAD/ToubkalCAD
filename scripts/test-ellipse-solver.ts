// Headless PlaneGCS + canApply checks for the ellipse EntityGeom kind.
//   1. FIXED reference ellipse stays put through a solve; its centre is referenceable.
//   2. Tool-drawn (free) ellipse is RIGID: a placement constraint (Concentric)
//      translates it without reshaping.
//   3. canApply gates ellipse operands: Concentric/Coincident/Distance/Fixed yes;
//      Radius/Equal/Tangent no.
// Run: npx tsx scripts/test-ellipse-solver.ts
import { PlaneGCSSolverAdapter } from '../src/services/solver/PlaneGCSSolverAdapter';
import { canApply, type EntityGeom } from '../src/services/SketchConstraintSolver';
import type { SketchConstraint, SketchRef } from '../src/store/cadStore';

const near = (a: number, b: number, t = 1e-2) => Math.abs(a - b) <= t;
let pass = true;
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); pass &&= ok; };

const pg = new PlaneGCSSolverAdapter();
await pg.init();
const ROT = Math.PI / 6;

// ── 1. FIXED reference ellipse ─────────────────────────────────────────────────
{
  const ellipse: EntityGeom = { id: 'E', kind: 'ellipse', c: [0, 0], rx: 10, ry: 5, rot: ROT };
  const line:    EntityGeom = { id: 'L', kind: 'line', a: [20, 20], b: [30, 30] };
  const cons: SketchConstraint[] = [
    { id: 'fixE', type: 'FIXED', refs: [{ kind: 'entity', id: 'E' }] },
    { id: 'co', type: 'COINCIDENT', refs: [{ kind: 'point', id: 'L', pt: 'a' }, { kind: 'entity', id: 'E' }] },
  ];
  const r = pg.solve([ellipse, line], cons);
  const E = r.geoms['E'] as Extract<EntityGeom, { kind: 'ellipse' }>;
  const L = r.geoms['L'] as Extract<EntityGeom, { kind: 'line' }>;
  check('fixed ellipse frozen', E.kind === 'ellipse' && near(E.c[0], 0) && near(E.c[1], 0) && near(E.rx, 10) && near(E.ry, 5) && near(E.rot, ROT));
  check('fixed ellipse centre referenceable', near(L.a[0], 0) && near(L.a[1], 0));
}

// ── 2. Tool-drawn ellipse is RIGID under Concentric ─────────────────────────────
{
  const ellipse: EntityGeom = { id: 'E', kind: 'ellipse', c: [3, 4], rx: 10, ry: 5, rot: ROT };
  const circle:  EntityGeom = { id: 'C', kind: 'circle', c: [12, 9], r: 3 };
  const cons: SketchConstraint[] = [
    { id: 'fixC', type: 'FIXED', refs: [{ kind: 'entity', id: 'C' }] },
    { id: 'conc', type: 'CONCENTRIC', refs: [{ kind: 'entity', id: 'E' }, { kind: 'entity', id: 'C' }] },
  ];
  const r = pg.solve([ellipse, circle], cons);
  const E = r.geoms['E'] as Extract<EntityGeom, { kind: 'ellipse' }>;
  check('tool-drawn ellipse translated to circle centre', near(E.c[0], 12) && near(E.c[1], 9));
  check('tool-drawn ellipse shape preserved (rigid)', near(E.rx, 10) && near(E.ry, 5) && near(E.rot, ROT));
}

// ── 3. canApply operand gating ──────────────────────────────────────────────────
{
  const geoms: EntityGeom[] = [
    { id: 'E', kind: 'ellipse', c: [0, 0], rx: 10, ry: 5, rot: 0 },
    { id: 'C', kind: 'circle', c: [5, 5], r: 3 },
  ];
  const eEnt: SketchRef = { kind: 'entity', id: 'E' };
  const cEnt: SketchRef = { kind: 'entity', id: 'C' };
  const eCtr: SketchRef = { kind: 'point', id: 'E', pt: 'c' };
  const cCtr: SketchRef = { kind: 'point', id: 'C', pt: 'c' };
  check('Concentric(ellipse,circle) allowed', canApply('CONCENTRIC', [eEnt, cEnt], geoms));
  check('Coincident(ellipseCtr,circleCtr) allowed', canApply('COINCIDENT', [eCtr, cCtr], geoms));
  check('Distance(ellipseCtr,circleCtr) allowed', canApply('DISTANCE', [eCtr, cCtr], geoms));
  check('Fixed(ellipse) allowed', canApply('FIXED', [eEnt], geoms));
  check('Radius(ellipse) BLOCKED', !canApply('RADIUS', [eEnt], geoms));
  check('Equal(ellipse,circle) BLOCKED', !canApply('EQUAL', [eEnt, cEnt], geoms));
  check('Tangent(ellipse,circle) BLOCKED', !canApply('TANGENT', [eEnt, cEnt], geoms));
}

console.log(pass ? '\nOVERALL: PASS ✓' : '\nOVERALL: FAIL ✗');
process.exit(pass ? 0 : 1);
