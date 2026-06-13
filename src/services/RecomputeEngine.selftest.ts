// ============================================================
// ToubkalCAD – RecomputeEngine.selftest.ts   (Phase 1 step 3 validation)
//
// In-browser smoke test of the recompute engine against the live kernel, run
// from the console:
//
//     recomputeSelfTest()
//
// It drives the PURE `recompute(host, graph, opts)` core through a Map-backed
// mock host (place = identity, meta = node.params) — the same shape the headless
// scripts/test-recompute.mjs uses — so it needs only window.oc, not the store or
// viewport. For the full, exhaustive geometry assertions run `npm run
// test:recompute` headlessly; this is the quick browser parity check.
// ============================================================

import { recompute, RecomputeHost } from './RecomputeEngine';
import { buildFeatureGraph, dirtySet } from './FeatureGraph';

interface Row { check: string; pass: boolean; detail: string }

const XY = (z = 0) => ({ label: 'P', origin: [0, 0, z], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] });
const node = (id: string, type: string, params: any) =>
  ({ id, type, params, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });

function volume(oc: any, shape: any): number {
  const p = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, p, false, false, false);
  const v = p.Mass(); p.delete(); return v;
}
const near = (a: number, b: number, tol = 0.03) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < tol;

function mockHost(oc: any, nodes: Record<string, any>) {
  const shapes = new Map<string, any>();
  const removed: string[] = [];
  const host: RecomputeHost & { _shapes: Map<string, any>; _removed: string[] } = {
    oc,
    getShape: (id) => shapes.get(id),
    setShape: (id, s) => { const old = shapes.get(id); if (old && old !== s) { try { old.delete(); } catch {} } shapes.set(id, s); },
    freeShape: (id) => { const s = shapes.get(id); if (s) { try { s.delete(); } catch {} } shapes.delete(id); },
    place: (_id, shape) => shape,
    meta: (id) => nodes[id]?.params,
    onChanged: () => {},
    onRemoved: (id) => removed.push(id),
    onFrame: () => {},
    _shapes: shapes,
    _removed: removed,
  };
  return host;
}

export function runRecomputeSelfTest(oc: any): Row[] {
  const rows: Row[] = [];
  const ok = (check: string, pass: boolean, detail = '') => rows.push({ check, pass, detail });
  const CYL = (r: number, h: number) => Math.PI * r * r * h;

  // sketch → extrude chain + an independent body + a broken op.
  const nodes: Record<string, any> = {
    wire1: node('wire1', 'sketch_wire', { workplane: XY(), sketchGeom: { kind: 'circle', c: [0, 0], r: 5 } }),
    ext1:  node('ext1',  'extrusion',   { opType: 'extrude', targetWireIds: ['wire1'], opParams: { h: 10, endMode: 0 } }),
    solo:  node('solo',  'box',         { w: 10, h: 10, d: 10 }),
    bad1:  node('bad1',  'boolean_operation', { boolOp: 'CUT', baseId: 'solo', toolIds: [] }),
  };

  // 1 — full build
  let graph = buildFeatureGraph(nodes);
  const host = mockHost(oc, nodes);
  let rep = recompute(host, graph, {});
  ok('full: ext1 = cyl r5×h10 (~785)', near(volume(oc, host._shapes.get('ext1')), CYL(5, 10)), `vol=${volume(oc, host._shapes.get('ext1')).toFixed(0)}`);
  ok('full: bad op isolated as error', rep.results.find((r) => r.id === 'bad1')?.status === 'error' && rep.errored === 1, rep.errors.bad1 ?? '');

  // 2 — edit upstream radius → downstream rebuilds, peer stays cached
  const ext1Before = host._shapes.get('ext1');
  const soloBefore = host._shapes.get('solo');
  nodes.wire1.params.sketchGeom.r = 8;
  graph = buildFeatureGraph(nodes);
  rep = recompute(host, graph, { dirty: dirtySet(graph, 'wire1') });
  ok('edit: ext1 tracks r8 (~2011)', near(volume(oc, host._shapes.get('ext1')), CYL(8, 10)), `vol=${volume(oc, host._shapes.get('ext1')).toFixed(0)}`);
  ok('edit: ext1 shape replaced', host._shapes.get('ext1') !== ext1Before);
  ok('edit: solo cached (same ref)', host._shapes.get('solo') === soloBefore, rep.results.find((r) => r.id === 'solo')?.status ?? '');

  // 3 — rollback frees the tail
  graph = buildFeatureGraph(nodes);
  const host2 = mockHost(oc, nodes);
  recompute(host2, graph, {});
  recompute(host2, graph, { rollbackId: 'wire1' });
  ok('rollback: ext1 freed', !host2._shapes.get('ext1') && host2._removed.includes('ext1'), host2._removed.join(','));
  ok('rollback: wire1 needle survives', !!host2._shapes.get('wire1'));

  return rows;
}

// ─── console entry point ──────────────────────────────────────────────────────
(globalThis as any).recomputeSelfTest = function recomputeSelfTest() {
  const oc = (globalThis as any).oc;
  if (!oc) { console.warn('[Recompute] kernel not ready (window.oc missing)'); return []; }
  const rows = runRecomputeSelfTest(oc);
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.log(`[Recompute] ${rows.filter((r) => r.pass).length}/${rows.length} checks passed`);
  return rows;
};
