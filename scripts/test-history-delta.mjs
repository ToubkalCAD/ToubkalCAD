// ============================================================
// ToubkalCAD – scripts/test-history-delta.mjs   (Phase 1 step 5 — delta undo/redo)
//
// Headless proof that the delta-based history round-trips: diffNodes derives a
// minimal change-set, applyDeltas replays it forward (redo) and backward (undo),
// and add / delete / modify all restore exactly. Compiles the pure historyDelta
// module to CJS (its CADNode import is type-only → no runtime deps).
// Run:  node scripts/test-history-delta.mjs
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, '.tk-history-delta-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

console.log('compiling historyDelta → CJS …');
execSync(
  `npx tsc "${ROOT}/src/store/historyDelta.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck`,
  { stdio: 'inherit' },
);
const { diffNodes, applyDeltas } = await import(`${OUT}/store/historyDelta.js`);

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};
const node = (id, extra = {}) => ({ id, name: id, parentId: null, children: [], params: {}, ...extra });
const ids = (m) => Object.keys(m).sort().join(',');
const mapOf = (arr) => Object.fromEntries(arr.map((n) => [n.id, n]));

const A = node('A'), B = node('B'), C = node('C');

// ─── 1 — ADD: before=[A], after=[A,B] ────────────────────────────────────────
console.log('\n1 — add B');
const addDelta = diffNodes([A], [A, B]);
ok('one delta, for B, before=null', addDelta.length === 1 && addDelta[0].id === 'B' && addDelta[0].before === null, `n=${addDelta.length}`);
const afterAdd = mapOf([A, B]);
ok('undo(add) removes B', ids(applyDeltas(afterAdd, addDelta, 'undo')) === 'A');
ok('redo(add) restores B', ids(applyDeltas(mapOf([A]), addDelta, 'redo')) === 'A,B');

// ─── 2 — DELETE: before=[A,B], after=[A] ─────────────────────────────────────
console.log('\n2 — delete B');
const delDelta = diffNodes([A, B], [A]);
ok('one delta, for B, after=null', delDelta.length === 1 && delDelta[0].id === 'B' && delDelta[0].after === null, `n=${delDelta.length}`);
ok('undo(delete) restores B', ids(applyDeltas(mapOf([A]), delDelta, 'undo')) === 'A,B');
ok('redo(delete) removes B', ids(applyDeltas(mapOf([A, B]), delDelta, 'redo')) === 'A');

// ─── 3 — MODIFY: a param change on B, A untouched ────────────────────────────
console.log('\n3 — modify B (A unchanged → excluded)');
const B2 = node('B', { params: { w: 20 } });
const modDelta = diffNodes([A, B], [A, B2]);
ok('only B in the change-set (A excluded)', modDelta.length === 1 && modDelta[0].id === 'B', `n=${modDelta.length}`);
const undone = applyDeltas(mapOf([A, B2]), modDelta, 'undo');
ok('undo(modify) restores B.params.w=undefined', undone.B.params.w === undefined, `w=${undone.B.params.w}`);
const redone = applyDeltas(mapOf([A, B]), modDelta, 'redo');
ok('redo(modify) reapplies B.params.w=20', redone.B.params.w === 20, `w=${redone.B.params.w}`);

// ─── 4 — round-trip a sequence: add C, then undo/redo lands back ──────────────
console.log('\n4 — full round-trip (state ∘ redo ∘ undo == state)');
const start = mapOf([A, B]);
const d = diffNodes([A, B], [A, B, C]);
const forward = applyDeltas(start, d, 'redo');
const back    = applyDeltas(forward, d, 'undo');
ok('redo then undo returns to the start map', ids(back) === ids(start) && ids(forward) === 'A,B,C', `${ids(forward)} → ${ids(back)}`);

// ─── 5 — identical snapshots → empty delta (no spurious history) ──────────────
console.log('\n5 — no-op diff');
ok('diff of identical snapshots is empty', diffNodes([A, B], [A, node('B')]).length === 0);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
