import assert from 'node:assert/strict';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { isAssemblyDocumentData } from '../src/assembly/types';
import { AssemblyBomService } from '../src/services/AssemblyBomService';
import { AssemblyBRepService } from '../src/services/AssemblyBRepService';
import { CADGeometryRegistry } from '../src/services/CADGeometryRegistry';
import { OccExchangeService } from '../src/services/OccExchangeService';
import { ProjectFileService } from '../src/services/ProjectFileService';
import { useCADStore } from '../src/store/cadStore';

const oc: any = await initOpenCascade();
if (!('window' in globalThis)) Object.assign(globalThis, { window: new EventTarget() });
(window as any).oc = oc;
const state = () => useCADStore.getState();

state().newProject();
const partId = state().createComponent('Phase D Block');
state().setNodeParams(partId, { partNumber: 'BLOCK-010', materialName: 'Steel', density: 0.00785 });
const bodyId = crypto.randomUUID();
const maker = new oc.BRepPrimAPI_MakeBox_2(10, 10, 10);
const body = maker.Shape();
CADGeometryRegistry.getInstance().registerShape(bodyId, body);
state().addNode({
  id: bodyId, name: '10 mm Block', type: 'box', visible: true, locked: false,
  parentId: partId, notes: '',
  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  material: { color: 0x777777, roughness: 0.4, metalness: 0.2, wireframe: false, opacity: 1, transparent: false },
  params: { width: 10, height: 10, depth: 10 },
});
maker.delete();

const assemblyId = state().createAssembly('Phase D Assembly');
const first = state().insertPartInstance(assemblyId, partId, 'Block 1')!;
const second = state().insertPartInstance(assemblyId, partId, 'Block 2')!;
const suppressed = state().insertPartInstance(assemblyId, partId, 'Block Spare')!;
state().setAssemblyComponentSuppressed(suppressed, true);

// BOM groups repeated part references and reports suppressed stock separately.
const bom = state().generateAssemblyBom(assemblyId);
assert.equal(bom.length, 1);
assert.equal(bom[0].partNumber, 'BLOCK-010');
assert.equal(bom[0].quantity, 3);
assert.equal(bom[0].suppressedQuantity, 1);
assert.equal(bom[0].material, 'Steel');
assert.ok((bom[0].unitMass ?? 0) > 7.8 && (bom[0].unitMass ?? 0) < 7.9);
assert.match(AssemblyBomService.toCSV(bom), /"BLOCK-010","Phase D Block","3","1","Steel"/);

// Overlapping instances collide; moving one beyond the broad-phase box clears it.
const diagnosticShape = AssemblyBRepService.buildComponentCompound(oc, state().nodes, first);
AssemblyBRepService.boundingBox(oc, diagnosticShape);
diagnosticShape.delete();
const overlap = await state().runAssemblyInterferenceCheck(assemblyId);
assert.ok(overlap, state().logs.slice(-3).map((entry) => entry.message).join(' | '));
assert.equal(overlap.pairs.length, 1);
assert.equal(overlap.pairs[0].kind, 'interference');
assert.ok(overlap.pairs[0].overlapVolume > 999);
state().updateTransform(second, [30, 0, 0], [0, 0, 0], [1, 1, 1]);
const separated = await state().runAssemblyInterferenceCheck(assemblyId);
assert.ok(separated);
assert.equal(separated.pairs.length, 0);
assert.deepEqual(separated.checkedComponentIds.sort(), [first, second].sort(), 'suppressed component is skipped');

// Explosion is presentation-only, saved in the assembly, and undoable.
const solvedTransforms = [first, second].map((id) => structuredClone(state().nodes[id].transform));
const historyBeforeExplosion = state().past.length;
state().generateAssemblyExplosion(assemblyId, 50);
let assemblyData = state().nodes[assemblyId].params?.assembly;
assert.ok(isAssemblyDocumentData(assemblyData));
assert.equal(assemblyData.exploded.enabled, true);
assert.equal(assemblyData.exploded.factor, 1);
assert.equal(Object.keys(assemblyData.exploded.transforms).length, 2);
assert.deepEqual([first, second].map((id) => state().nodes[id].transform), solvedTransforms);
assert.equal(state().past.length, historyBeforeExplosion + 1);
state().undo();
assemblyData = state().nodes[assemblyId].params?.assembly;
assert.ok(isAssemblyDocumentData(assemblyData));
assert.equal(assemblyData.exploded.enabled, false);
state().redo();
state().setAssemblyComponentExplodedOffset(second, [75, 5, 0]);
assemblyData = state().nodes[assemblyId].params?.assembly;
assert.ok(isAssemblyDocumentData(assemblyData));
assert.deepEqual(assemblyData.exploded.transforms[second].offset, [75, 5, 0]);

const saved = ProjectFileService.build(state().nodes, state().rootIds, 'Phase D Assembly');
const loaded = ProjectFileService.parse(JSON.stringify(saved));
const loadedAssembly = loaded.nodes[assemblyId].params?.assembly;
assert.ok(isAssemblyDocumentData(loadedAssembly));
assert.deepEqual(loadedAssembly.exploded.transforms[second].offset, [75, 5, 0]);

// Compound and STEP output use solved transforms, never exploded offsets.
const compound = AssemblyBRepService.buildAssemblyCompound(oc, state().nodes, assemblyId);
try {
  const box = AssemblyBRepService.boundingBox(oc, compound);
  assert.ok(box[0] < 0.001 && box[3] > 39.999, `unexpected assembly bounds: ${box.join(', ')}`);
  const step = OccExchangeService.exportSTEP(oc, compound);
  assert.ok(step.byteLength > 1000);
} finally {
  compound.delete();
}

console.log('✓ Phase D BOM, interference, exploded views, compound generation, export, persistence, and history');
