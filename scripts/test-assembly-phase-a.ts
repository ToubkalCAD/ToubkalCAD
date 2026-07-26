import assert from 'node:assert/strict';
import * as THREE from 'three';
import { useCADStore } from '../src/store/cadStore';
import { ProjectFileService, TKCAD_VERSION } from '../src/services/ProjectFileService';
import { componentTransformToMatrix, matrixToComponentTransform, normalizeComponentTransform } from '../src/assembly/transforms';
import { isAssemblyComponentData, isAssemblyDocumentData } from '../src/assembly/types';

// Store events are browser-only side effects; Phase A model tests need only a
// harmless EventTarget-compatible window.
if (!('window' in globalThis)) {
  Object.assign(globalThis, { window: new EventTarget() });
}

const state = () => useCADStore.getState();
state().newProject();

const assemblyId = state().createAssembly('Bearing Support');
const baseId = state().createComponent('Base Plate');
const shaftId = state().createComponent('Shaft');
const bearingId = state().createComponent('Bearing');

const baseInstance = state().insertPartInstance(assemblyId, baseId);
const shaftInstance = state().insertPartInstance(assemblyId, shaftId);
const bearingA = state().insertPartInstance(assemblyId, bearingId, 'Bearing:1');
const bearingB = state().insertPartInstance(assemblyId, bearingId, 'Bearing:2');
assert.ok(baseInstance && shaftInstance && bearingA && bearingB);

const assemblyData = state().nodes[assemblyId].params?.assembly;
assert.ok(isAssemblyDocumentData(assemblyData));
assert.deepEqual(assemblyData.componentIds, [baseInstance, shaftInstance, bearingA, bearingB]);

const baseData = state().nodes[baseInstance].params?.assemblyComponent;
assert.ok(isAssemblyComponentData(baseData));
assert.equal(baseData.fixed, true, 'first inserted component is auto-fixed');
assert.equal(state().nodes[shaftInstance].params?.assemblyComponent.fixed, false);

const duplicate = state().duplicateAssemblyComponent(bearingA);
assert.ok(duplicate);
assert.equal(state().nodes[assemblyId].params?.assembly.componentIds.length, 5);
state().undo();
assert.equal(state().nodes[assemblyId].params?.assembly.componentIds.length, 4, 'duplicate is one undo step');

state().reparentNode(bearingA, shaftInstance);
assert.equal(state().nodes[bearingA].parentId, shaftInstance);
assert.equal(state().nodes[bearingA].params?.assemblyComponent.parentComponentId, shaftInstance);
state().reparentNode(bearingA, assemblyId);
assert.equal(state().nodes[bearingA].params?.assemblyComponent.parentComponentId, undefined);

state().updateTransform(shaftInstance, [0, 0, 35], [0, Math.PI / 2, 0], [1, 1, 1]);
assert.deepEqual(state().nodes[shaftInstance].transform.position, [0, 0, 35]);
state().undo();
assert.deepEqual(state().nodes[shaftInstance].transform.position, [0, 0, 0]);
state().redo();
assert.deepEqual(state().nodes[shaftInstance].transform.position, [0, 0, 35]);

state().setAssemblyComponentSuppressed(bearingB, true);
assert.equal(state().nodes[bearingB].params?.assemblyComponent.suppressed, true);
state().setAssemblyComponentFixed(shaftInstance, true);
assert.equal(state().nodes[shaftInstance].locked, true);
state().setAssemblyComponentFixed(shaftInstance, false);

state().copyComponentTransform(shaftInstance);
state().pasteComponentTransform(bearingA);
assert.deepEqual(state().nodes[bearingA].transform.position, [0, 0, 35]);
state().resetComponentTransform(bearingA);
assert.deepEqual(state().nodes[bearingA].transform.position, [0, 0, 0]);

const transform = normalizeComponentTransform({
  position: [10, -4, 8],
  rotation: [0.2, -0.3, 1.1],
  scale: [1, 1, 1],
});
const roundTrip = matrixToComponentTransform(componentTransformToMatrix(transform));
assert.ok(new THREE.Vector3(...roundTrip.position).distanceTo(new THREE.Vector3(...transform.position)) < 1e-9);
assert.ok(Math.abs(roundTrip.rotation[2] - transform.rotation[2]) < 1e-9);

const document = ProjectFileService.build(state().nodes, state().rootIds, 'Bearing Support');
assert.equal(document.version, TKCAD_VERSION);
const loaded = ProjectFileService.parse(JSON.stringify(document));
const loadedAssembly = loaded.nodes[assemblyId].params?.assembly;
assert.ok(isAssemblyDocumentData(loadedAssembly));
assert.equal(loadedAssembly.componentIds.length, 4);
assert.ok(isAssemblyComponentData(loaded.nodes[bearingA].params?.assemblyComponent));

const constraintId = crypto.randomUUID();
state().setNodeParams(assemblyId, {
  assembly: {
    ...state().nodes[assemblyId].params?.assembly,
    constraintIds: [constraintId],
    constraints: {
      [constraintId]: {
        id: constraintId,
        assemblyId,
        type: 'concentric',
        referenceA: { componentId: bearingA, partId: bearingId, subshapeType: 'axis' },
        referenceB: { componentId: bearingB, partId: bearingId, subshapeType: 'axis' },
        enabled: true,
        status: 'unsolved',
      },
    },
  },
});
state().deleteNode(bearingB);
assert.equal(state().nodes[assemblyId].params?.assembly.constraintIds.length, 0, 'deleting an instance removes referencing constraints');
state().undo();
assert.equal(state().nodes[assemblyId].params?.assembly.constraintIds.length, 1);

state().deleteNode(bearingId);
assert.equal(state().nodes[bearingA].params?.assemblyComponent.missingPart, true);
assert.equal(state().nodes[bearingB].params?.assemblyComponent.missingPart, true);
state().undo();
assert.equal(state().nodes[bearingA].params?.assemblyComponent.missingPart, false);

console.log('✓ Phase A assembly model, transforms, history, missing refs, and save/load');
