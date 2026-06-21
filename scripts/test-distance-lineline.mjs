// Headless verification of the line-to-line Distance fix (pure LM solver path).
//   1. canApply DISTANCE on two lines is now enabled.
//   2. A normalized point-to-line DISTANCE actually solves to the target gap.
//   3. constraintBlocked gates redundant Parallel on two H/V-locked lines.
// Run with: npx tsx scripts/test-distance-lineline.mjs
import {
  solveConstraints, canApply, constraintBlocked,
} from '../src/services/SketchConstraintSolver.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// Two horizontal, parallel segments: bottom y=0, top y=20.
const bottom = { id: 'L1', kind: 'line', a: [0, 0],  b: [40, 0]  };
const top    = { id: 'L2', kind: 'line', a: [5, 20], b: [55, 20] };
const geoms  = [bottom, top];

// 1 — UI gate: two lines now satisfy DISTANCE's operand signature.
ok('canApply(DISTANCE, [line, line]) === true',
   canApply('DISTANCE', [{ kind: 'entity', id: 'L1' }, { kind: 'entity', id: 'L2' }], geoms) === true);

// 2 — normalized point-to-line distance solves to the requested gap (35).
const cons = [
  { id: 'h1', type: 'HORIZONTAL', refs: [{ kind: 'entity', id: 'L1' }] },
  { id: 'h2', type: 'HORIZONTAL', refs: [{ kind: 'entity', id: 'L2' }] },
  // bind bottom.a to top's infinite line at distance 35
  { id: 'd1', type: 'DISTANCE',
    refs: [{ kind: 'point', id: 'L1', pt: 'a' }, { kind: 'entity', id: 'L2' }], value: 35 },
];
const res = solveConstraints(geoms, cons);
const nb = res.geoms.L1, nt = res.geoms.L2;
const gap = Math.abs(nt.a[1] - nb.a[1]);
const tiltB = Math.abs(nb.a[1] - nb.b[1]), tiltT = Math.abs(nt.a[1] - nt.b[1]);
console.log(`    bottom=${JSON.stringify(nb.a)}→${JSON.stringify(nb.b)} top=${JSON.stringify(nt.a)}→${JSON.stringify(nt.b)} gap=${gap.toFixed(4)}`);
ok('solver converged', res.converged, `(residual ${res.residual})`);
// LM solver converges to a tolerance (soft rigidity anchors vs the hard dimension),
// so accept a small numerical band rather than exact equality.
ok('perpendicular gap ≈ 35 (was 20)', Math.abs(gap - 35) < 0.05, `(got ${gap.toFixed(4)})`);
// ~3e-3 over a 40-unit line ≈ 0.004° — the LM solver's convergence band, not a tilt.
ok('lines stayed horizontal', tiltB < 1e-2 && tiltT < 1e-2, `(tilt ${tiltB.toExponential(1)}, ${tiltT.toExponential(1)})`);

// 3 — redundancy gate: Parallel on two already-horizontal lines is blocked.
const blockPar = constraintBlocked('PARALLEL',
  [{ kind: 'entity', id: 'L1' }, { kind: 'entity', id: 'L2' }],
  [cons[0], cons[1]]);
ok('Parallel on two H-locked lines is blocked', !!blockPar, `(got ${JSON.stringify(blockPar)})`);
ok('block reason mentions redundant', /redundant/i.test(blockPar ?? ''), `(got "${blockPar}")`);

// 3b — Perpendicular between an H line and a V line is likewise redundant.
const blockPerp = constraintBlocked('PERPENDICULAR',
  [{ kind: 'entity', id: 'L1' }, { kind: 'entity', id: 'L2' }],
  [{ id: 'h1', type: 'HORIZONTAL', refs: [{ kind: 'entity', id: 'L1' }] },
   { id: 'v2', type: 'VERTICAL',   refs: [{ kind: 'entity', id: 'L2' }] }]);
ok('Perpendicular on H+V lines is blocked as redundant', /redundant/i.test(blockPerp ?? ''), `(got "${blockPerp}")`);

// 3c — but Parallel on two FREE lines is still allowed (no over-gating).
const blockFree = constraintBlocked('PARALLEL',
  [{ kind: 'entity', id: 'L1' }, { kind: 'entity', id: 'L2' }], []);
ok('Parallel on two free lines stays allowed', blockFree === null, `(got ${JSON.stringify(blockFree)})`);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
