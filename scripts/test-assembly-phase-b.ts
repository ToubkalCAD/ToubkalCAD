import assert from 'node:assert/strict';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { AssemblyReferenceService } from '../src/assembly/AssemblyReferenceService';
import { isAssemblyComponentData } from '../src/assembly/types';
import { CADGeometryRegistry } from '../src/services/CADGeometryRegistry';
import { OccBooleanService } from '../src/services/OccBooleanService';
import { captureEdge, captureFace } from '../src/services/StableRef';
import { ProjectFileService } from '../src/services/ProjectFileService';
import { DEFAULT_MATERIAL, useCADStore } from '../src/store/cadStore';

const oc: any = await initOpenCascade();
if (!('window' in globalThis)) Object.assign(globalThis, { window: new EventTarget() });
(globalThis as any).window.oc = oc;

const state = () => useCADStore.getState();
state().newProject();

const assemblyId = state().createAssembly('Reference Test');
const partId = state().createComponent('Reference Part');
const sourceNodeId = crypto.randomUUID();
state().addNode({
  id: sourceNodeId,
  name: 'Reference Box',
  type: 'box',
  visible: true,
  locked: false,
  parentId: partId,
  notes: '',
  transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  material: { ...DEFAULT_MATERIAL },
  params: { w: 10, h: 10, d: 10 },
});

const boxMaker = new oc.BRepPrimAPI_MakeBox_2(10, 10, 10);
const box = boxMaker.Shape();
boxMaker.delete();
CADGeometryRegistry.getInstance().registerShape(sourceNodeId, box);

const componentId = state().insertPartInstance(assemblyId, partId)!;
const componentId2 = state().insertPartInstance(assemblyId, partId)!;
assert.ok(isAssemblyComponentData(state().nodes[componentId].params?.assemblyComponent));
state().setAssemblyComponentFixed(componentId, false);
state().updateTransform(componentId, [100, 0, 0], [0, 0, Math.PI / 2], [1, 1, 1]);
state().setAssemblyComponentFixed(componentId2, false);
state().updateTransform(componentId2, [0, 80, 0], [0, 0, 0], [1, 1, 1]);

let topFaceIndex = -1;
for (let index = 0; index < 6; index++) {
  const signature = captureFace(oc, box, index);
  if (signature?.surf === 'plane' && Math.abs(signature.centroid[2] - 10) < 1e-6) topFaceIndex = index;
}
assert.ok(topFaceIndex >= 0);

const face = AssemblyReferenceService.captureFace(oc, state().nodes, componentId, sourceNodeId, topFaceIndex);
assert.equal(face.componentId, componentId);
assert.equal(face.partId, partId);
assert.equal(face.sourceNodeId, sourceNodeId);
assert.equal(face.stableRef?.kind, 'face');
assert.deepEqual(face.localPoint?.map((value) => Math.round(value)), [7, 5, 10]);
assert.deepEqual(face.worldPoint?.map((value) => Math.round(value)), [95, 7, 10]);
assert.deepEqual(face.worldDirection?.map((value) => Math.round(value)), [0, 0, 1]);

const edge = AssemblyReferenceService.captureEdge(oc, state().nodes, componentId, sourceNodeId, 0);
assert.equal(edge.stableRef?.kind, 'edge');
assert.ok(edge.localDirection && edge.worldDirection);

const vertex = AssemblyReferenceService.captureVertex(oc, state().nodes, componentId, sourceNodeId, 0);
assert.equal(vertex.stableRef?.kind, 'vertex');
assert.ok(vertex.localPoint && vertex.worldPoint);

const cylinderNodeId = crypto.randomUUID();
state().addNode({
  id: cylinderNodeId,
  name: 'Reference Cylinder',
  type: 'cylinder',
  visible: true,
  locked: false,
  parentId: partId,
  notes: '',
  transform: { position: [30, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  material: { ...DEFAULT_MATERIAL },
  params: { r: 4, h: 16 },
});
const cylinderMaker = new oc.BRepPrimAPI_MakeCylinder_1(4, 16);
const cylinderShape = cylinderMaker.Shape();
cylinderMaker.delete();
CADGeometryRegistry.getInstance().registerShape(cylinderNodeId, cylinderShape);

let cylinderFaceIndex = -1;
for (let index = 0; index < 3; index++) {
  if (captureFace(oc, cylinderShape, index)?.surf === 'cylinder') cylinderFaceIndex = index;
}
assert.ok(cylinderFaceIndex >= 0);
const cylinderFace = AssemblyReferenceService.captureFace(
  oc, state().nodes, componentId, cylinderNodeId, cylinderFaceIndex,
);
assert.equal(Math.round(cylinderFace.radius ?? 0), 4);
assert.deepEqual(cylinderFace.worldDirection?.map((value) => Math.round(value)), [0, 0, 1]);

let circularEdgeIndex = -1;
for (let index = 0; index < 3; index++) {
  if (captureEdge(oc, cylinderShape, index)?.curve === 'circle') circularEdgeIndex = index;
}
assert.ok(circularEdgeIndex >= 0);
const circularEdge = AssemblyReferenceService.captureEdge(
  oc, state().nodes, componentId2, cylinderNodeId, circularEdgeIndex,
);
assert.equal(Math.round(circularEdge.radius ?? 0), 4);
assert.ok(circularEdge.worldPoint && circularEdge.worldDirection);
assert.equal(AssemblyReferenceService.compatible('concentric', cylinderFace, circularEdge).valid, true);

const xAxis = AssemblyReferenceService.standard(state().nodes, componentId, 'axis', 'X');
assert.deepEqual(xAxis.worldDirection?.map((value) => Math.round(value)), [0, 1, 0]);
const xyPlane = AssemblyReferenceService.standard(state().nodes, componentId2, 'plane', 'XY');
assert.deepEqual(xyPlane.worldDirection?.map((value) => Math.round(value)), [0, 0, 1]);
const origin = AssemblyReferenceService.standard(state().nodes, componentId, 'origin', 'origin');
assert.deepEqual(origin.worldPoint?.map((value) => Math.round(value)), [100, 0, 0]);

assert.equal(AssemblyReferenceService.validate(state().nodes, face).valid, true);
assert.equal(AssemblyReferenceService.compatible('parallel', face, xyPlane).valid, true);
assert.equal(AssemblyReferenceService.compatible('concentric', face, xyPlane).valid, false);
assert.equal(AssemblyReferenceService.compatible('parallel', face, { ...xyPlane, componentId }).valid, false);

// The stable top-face signature survives a topology reorder caused by a side boss.
const bossMaker = new oc.BRepPrimAPI_MakeBox_3(new oc.gp_Pnt_3(10, 3, 3), 3, 4, 4);
const boss = bossMaker.Shape();
bossMaker.delete();
const fused = OccBooleanService.fuse(oc, box, boss);
boss.delete();
CADGeometryRegistry.getInstance().registerShape(sourceNodeId, fused);
const resolved = AssemblyReferenceService.resolve(oc, state().nodes, face);
assert.equal(resolved.valid, true, resolved.reason);
assert.equal(resolved.reference.stableRef, face.stableRef, 'original signature remains authoritative');
assert.deepEqual(resolved.reference.worldPoint?.map((value) => Math.round(value)), [95, 7, 10]);

state().setNodeParams(assemblyId, { referenceTest: resolved.reference });
const document = ProjectFileService.build(state().nodes, state().rootIds, 'Phase B References');
const loaded = ProjectFileService.parse(JSON.stringify(document));
assert.deepEqual(
  loaded.nodes[assemblyId].params.referenceTest.stableRef,
  JSON.parse(JSON.stringify(face.stableRef)),
);

state().deleteNode(sourceNodeId);
assert.equal(AssemblyReferenceService.validate(state().nodes, face).valid, false);

console.log('✓ Phase B component-aware capture, transforms, compatibility, resolution, and persistence');
