// ============================================================
// Standalone smoke test for the libslvs WASM build — no app, no browser.
// Run after build.sh:   node native/slvs/test/smoke.mjs
//
// Validates the shim end-to-end on a tiny system:
//   point A fixed at origin; point B free; line A→B; B dragged toward (40,30)
//   with a PT_PT_DISTANCE = 50 constraint. Expect OKAY and |AB| ≈ 50.
// ============================================================

import createSlvsModule from '../../../src/services/solver/wasm/libslvs.mjs';

const PT_PT_DISTANCE = 100001;

const mod = await createSlvsModule();
const sys = new mod.SketchSystem();

const A = sys.addPoint2d(0, 0, /*fixed*/ true);    // pinned (group 1)
const B = sys.addPoint2d(10, 0, /*fixed*/ false);  // free   (group 2)
sys.addLine(A.h, B.h, false);

// distance A–B = 50
sys.addConstraint(PT_PT_DISTANCE, 50, A.h, B.h, 0, 0, 0, 0, 0, 0);

// drag B toward (40,30): seed + mark dragged so the solver honours direction
sys.setDragged(B.p0, B.p1);
sys.getParamValue(B.p0); // (no-op read; values set by solver)

const out = sys.solve(2);

const bx = sys.getParamValue(B.p0);
const by = sys.getParamValue(B.p1);
const dist = Math.hypot(bx, by);

console.log('result =', out.result, '(0 = OKAY)   dof =', out.dof);
console.log(`B = (${bx.toFixed(3)}, ${by.toFixed(3)})   |AB| = ${dist.toFixed(3)}  (expect ≈ 50)`);

sys.delete();

const ok = out.result === 0 && Math.abs(dist - 50) < 1e-3;
console.log(ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
