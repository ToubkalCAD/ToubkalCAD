// ============================================================
// ToubkalCAD – scripts/test-region-backfill.mjs   (load-time migration)
//
// Pins backfillRegionMembers: legacy region wires (saved before memberIds was
// persisted) get their member entity ids re-derived on load so the recompute
// engine can rebuild + follow them. Pure 2D — no kernel; compiles the real util
// (+ SketchRegions) to CJS and drives it with a synthetic nodes map.
//
// Run:  node scripts/test-region-backfill.mjs   (from repo root)
// ============================================================

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { importCompiledModule, prepareCommonJsOutput } from './import-compiled-cjs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, '.tk-region-backfill-build');
const cleanup = () => { try { rmSync(OUT, { recursive: true, force: true }); } catch {} };
const done = (code) => { cleanup(); process.exit(code); };

console.log('compiling backfillRegionMembers → CJS …');
execSync(
  `npx tsc "${ROOT}/src/utils/backfillRegionMembers.ts" --outDir "${OUT}" ` +
  `--rootDir "${ROOT}/src" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { stdio: 'inherit' },
);
prepareCommonJsOutput(OUT);
const { backfillRegionMembers } = await importCompiledModule(OUT, 'utils/backfillRegionMembers.js');

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  ${detail}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`); }
};

// A sketch container + 4 line entity wires forming a closed 10×10 square (area 100),
// plus a LEGACY region wire (region+regionArea, NO memberIds).
const line = (id, a, b) => [id, { id, type: 'sketch_wire', parentId: 'sk', params: { workplane: {}, sketchGeom: { kind: 'line', a, b } } }];
const baseNodes = () => Object.fromEntries([
  ['sk', { id: 'sk', type: 'sketch', parentId: null, params: { workplane: {} } }],
  line('L1', [0, 0], [10, 0]),
  line('L2', [10, 0], [10, 10]),
  line('L3', [10, 10], [0, 10]),
  line('L4', [0, 10], [0, 0]),
  ['R', { id: 'R', type: 'sketch_wire', parentId: 'sk', params: { workplane: {}, region: true, regionArea: 100 } }],
]);

// ─── 1 — legacy region wire gets its 4 member ids back ────────────────────────
console.log('\n1 — re-derives memberIds for a legacy region (square of 4 lines)');
const out1 = backfillRegionMembers(baseNodes());
const ids1 = out1.R.params.memberIds;
ok('region wire now has 4 memberIds', Array.isArray(ids1) && ids1.length === 4, `ids=${JSON.stringify(ids1)}`);
ok('memberIds are exactly the 4 line wires',
  Array.isArray(ids1) && ['L1', 'L2', 'L3', 'L4'].every((l) => ids1.includes(l)), JSON.stringify(ids1?.slice().sort()));

// ─── 2 — idempotent: a region that already has memberIds is untouched ─────────
console.log('\n2 — idempotent (existing memberIds left as-is, same object)');
const pre = baseNodes(); pre.R.params.memberIds = ['X'];
const out2 = backfillRegionMembers(pre);
ok('keeps existing memberIds (no overwrite)', JSON.stringify(out2.R.params.memberIds) === '["X"]', JSON.stringify(out2.R.params.memberIds));
ok('returns the SAME map when nothing changed', out2 === pre, out2 === pre ? 'same ref' : 'new ref');

// ─── 3 — graceful: region whose siblings enclose nothing → left unchanged ─────
console.log('\n3 — no traceable region → left unchanged (no memberIds, no crash)');
const open = baseNodes(); delete open.L4;   // square no longer closes
const out3 = backfillRegionMembers(open);
ok('unmatched region keeps no memberIds', out3.R.params.memberIds === undefined, `memberIds=${JSON.stringify(out3.R.params.memberIds)}`);

// ─── 4 — entity wires + container are untouched ───────────────────────────────
console.log('\n4 — non-region nodes pass through unchanged');
ok('entity wire L1 unchanged', out1.L1.params.sketchGeom?.kind === 'line' && out1.L1.params.memberIds === undefined);
ok('sketch container unchanged', out1.sk.type === 'sketch' && out1.sk.params.memberIds === undefined);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
done(failed ? 1 : 0);
