// ============================================================
// ToubkalCAD – FeatureGraph.selftest.ts   (Phase 1 step 1 validation)
//
// Pure-JS validation of the params→Feature adapter + graph algorithms — needs NO
// OCC kernel (synthetic node metadata only). Self-registers on window:
//
//     featureGraphSelfTest()
//
// Also runnable headlessly: compile to CJS and `require(...).runFeatureGraphSelfTest()`.
// ============================================================

import { buildFeatureGraph, dirtySet, descendants } from './FeatureGraph';

interface Row { check: string; pass: boolean; detail: string }

// A representative synthetic scene (only the fields the adapter reads: id/type/params).
function scene(): Record<string, any> {
  const n = (id: string, type: string, params: any = {}) => ({ id, type, params, visible: true });
  // Insertion order intentionally NOT topological, to prove the sort works.
  return {
    bool1:  n('bool1',  'boolean_operation', { boolOp: 'CUT', baseId: 'box1', toolIds: ['ext1'] }),
    fillet1:n('fillet1','compound',          { blendOp: 'fillet', sourceId: 'ext1', edgeIndices: [2, 5], blendValue: 1 }),
    ext1:   n('ext1',   'extrusion',         { opType: 'extrude', targetWireIds: ['wire1'], opParams: { h: 20 } }),
    wire1:  n('wire1',  'sketch_wire',       { workplane: {}, sketchGeom: { kind: 'circle' } }),
    sketch1:n('sketch1','sketch',            { workplane: {} }),
    box1:   n('box1',   'box',               {}),                                   // legacy: no dims → incomplete
    datum1: n('datum1', 'datum_plane',       { workplane: {}, method: 'offset', refs: [{ nodeId: 'box1', kind: 'face' }] }),
    mir1:   n('mir1',   'mirror',            {}),                                   // legacy: no source → incomplete
    dang1:  n('dang1',  'boolean_operation', { boolOp: 'FUSE', baseId: 'ghost', toolIds: ['box1'] }), // dangling base
    // Closed-gap cases (recipe now persisted by Ribbon.create):
    box2:   n('box2',   'box',               { w: 10, h: 10, d: 10 }),
    torus1: n('torus1', 'compound',          { featureOp: 'torus', R: 15, r: 3 }),
    cone1:  n('cone1',  'compound',          { featureOp: 'cone', r1: 8, r2: 0, h: 15 }),
    imp1:   n('imp1',   'compound',          {}),                                   // STEP import: no recipe
    mir2:   n('mir2',   'mirror',            { sourceId: 'box2', plane: 'XY' }),
    pat1:   n('pat1',   'pattern',           { sourceId: 'ext1', mode: 'linear', axis: 0, spacing: 10, count: 3 }),
    rev1:   n('rev1',   'revolve',           { opType: 'revolve', targetWireIds: ['wire1'], opParams: { axis: 1, angle: 360 } }),
    // Region wire now captures its member entities as inputs:
    le1:    n('le1',    'sketch_wire',       { workplane: {}, sketchGeom: { kind: 'line' } }),
    le2:    n('le2',    'sketch_wire',       { workplane: {}, sketchGeom: { kind: 'line' } }),
    reg1:   n('reg1',   'sketch_wire',       { workplane: {}, region: true, memberIds: ['le1', 'le2'] }),
  };
}

export function runFeatureGraphSelfTest(): Row[] {
  const rows: Row[] = [];
  const ok = (check: string, pass: boolean, detail = '') => rows.push({ check, pass, detail });
  const before = (order: string[], a: string, b: string) => order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b);

  const g = buildFeatureGraph(scene());
  const F = g.features;

  // 1 — op mapping
  ok('extrusion → op extrude', F.ext1.op === 'extrude', F.ext1.op);
  ok('compound+blendOp → op fillet', F.fillet1.op === 'fillet', F.fillet1.op);
  ok('boolean_operation → op boolean', F.bool1.op === 'boolean', F.bool1.op);

  // 2 — inputs derived from params (the DAG edges)
  ok('extrude profile input = wire1', F.ext1.inputs.some((i) => i.id === 'wire1' && i.role === 'profile'), JSON.stringify(F.ext1.inputs));
  ok('boolean inputs = box1(base)+ext1(tool)',
    F.bool1.inputs.some((i) => i.id === 'box1' && i.role === 'base') && F.bool1.inputs.some((i) => i.id === 'ext1' && i.role === 'tool'),
    JSON.stringify(F.bool1.inputs));
  ok('fillet base input = ext1', F.fillet1.inputs.some((i) => i.id === 'ext1' && i.role === 'base'), JSON.stringify(F.fillet1.inputs));
  ok('datum ref input = box1', F.datum1.inputs.some((i) => i.id === 'box1'), JSON.stringify(F.datum1.inputs));

  // 3 — completeness flags (the gaps we must surface)
  ok('box (no dims) flagged incomplete', F.box1.complete === false, F.box1.note ?? '');
  ok('mirror (no source) flagged incomplete', F.mir1.complete === false, F.mir1.note ?? '');
  ok('full extrude is complete', F.ext1.complete === true, F.ext1.note ?? '');
  ok('dangling input flagged incomplete', F.dang1.complete === false && /dangling/.test(F.dang1.note ?? ''), F.dang1.note ?? '');

  // 3b — closed-gap cases now resolve to complete recipes with correct ops/inputs
  ok('box+dims → complete', F.box2.complete === true && F.box2.op === 'box', `${F.box2.op} ${F.box2.complete}`);
  ok('torus (compound+featureOp) → op torus, complete', F.torus1.op === 'torus' && F.torus1.complete, `${F.torus1.op} ${F.torus1.complete}`);
  ok('cone (compound+featureOp) → op cone, complete', F.cone1.op === 'cone' && F.cone1.complete, F.cone1.op);
  ok('import compound → op imported, incomplete', F.imp1.op === 'imported' && F.imp1.complete === false, F.imp1.note ?? '');
  ok('mirror+source → input box2, complete', F.mir2.complete && F.mir2.inputs.some((i) => i.id === 'box2' && i.role === 'source'), JSON.stringify(F.mir2.inputs));
  ok('pattern+source → input ext1, complete', F.pat1.complete && F.pat1.inputs.some((i) => i.id === 'ext1' && i.role === 'source'), JSON.stringify(F.pat1.inputs));
  ok('Ribbon revolve recipe → op revolve, profile wire1, complete', F.rev1.op === 'revolve' && F.rev1.complete && F.rev1.inputs.some((i) => i.id === 'wire1'), JSON.stringify(F.rev1.inputs));
  ok('region wire → entity inputs le1/le2, complete', F.reg1.complete && ['le1', 'le2'].every((id) => F.reg1.inputs.some((i) => i.id === id && i.role === 'entity')), JSON.stringify(F.reg1.inputs));

  // 4 — topological order (upstream before downstream)
  ok('order: wire1 before ext1', before(g.order, 'wire1', 'ext1'), g.order.join('→'));
  ok('order: ext1 before fillet1', before(g.order, 'ext1', 'fillet1'), '');
  ok('order: box1 & ext1 before bool1', before(g.order, 'box1', 'bool1') && before(g.order, 'ext1', 'bool1'), '');
  ok('all (non-cycle) nodes ordered', g.order.length === Object.keys(F).length && g.cycles.length === 0, `order=${g.order.length} cycles=${g.cycles.length}`);

  // 5 — dirty propagation
  const d = dirtySet(g, 'wire1');
  ok('dirtySet(wire1) ⊇ {wire1,ext1,fillet1,bool1}', ['wire1', 'ext1', 'fillet1', 'bool1'].every((x) => d.has(x)), [...d].join(','));
  ok('descendants(ext1) = {fillet1,bool1}', (() => { const s = descendants(g, 'ext1'); return s.has('fillet1') && s.has('bool1') && !s.has('wire1'); })(), '');

  // 6 — cycle detection (synthetic a⇄b)
  const cyc = buildFeatureGraph({
    a: { id: 'a', type: 'boolean_operation', params: { boolOp: 'CUT', baseId: 'b', toolIds: [] }, visible: true },
    b: { id: 'b', type: 'boolean_operation', params: { boolOp: 'CUT', baseId: 'a', toolIds: [] }, visible: true },
  } as any);
  ok('cycle detected (a⇄b)', cyc.cycles.length === 2 && cyc.order.length === 0, `cycles=${cyc.cycles.join(',')}`);

  return rows;
}

// ─── console entry point ──────────────────────────────────────────────────────
(globalThis as any).featureGraphSelfTest = function featureGraphSelfTest() {
  const rows = runFeatureGraphSelfTest();
  const passed = rows.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.log(`[FeatureGraph] ${passed}/${rows.length} checks passed`);
  return rows;
};
