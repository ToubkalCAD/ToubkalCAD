import assert from 'node:assert/strict';
import { AssemblyReferenceService } from '../src/assembly/AssemblyReferenceService';
import { assemblyConstraintSolver } from '../src/assembly/AssemblyConstraintSolver';
import {
  isAssemblyDocumentData,
  type AssemblyConstraint,
  type AssemblyConstraintType,
  type AssemblyReference,
} from '../src/assembly/types';
import { ProjectFileService } from '../src/services/ProjectFileService';
import { useCADStore } from '../src/store/cadStore';

if (!('window' in globalThis)) Object.assign(globalThis, { window: new EventTarget() });
const state = () => useCADStore.getState();
const rounded = (value: number) => Math.round(value * 1e5) / 1e5;

function setup(count = 2) {
  state().newProject();
  const assemblyId = state().createAssembly('Phase C Assembly');
  const partId = state().createComponent('Reference Part');
  const componentIds = Array.from({ length: count }, (_, index) =>
    state().insertPartInstance(assemblyId, partId, `Instance ${index + 1}`)!);
  return { assemblyId, partId, componentIds };
}

function standard(
  componentId: string,
  type: 'origin' | 'axis' | 'plane',
  name: 'origin' | 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ',
): AssemblyReference {
  return AssemblyReferenceService.standard(state().nodes, componentId, type, name);
}

function addViaWorkflow(
  assemblyId: string,
  type: AssemblyConstraintType,
  referenceA: AssemblyReference,
  referenceB: AssemblyReference,
  values: { offset?: number; angle?: number; flipped?: boolean } = {},
): string {
  state().startAssemblyConstraint(assemblyId, type);
  state().startAssemblyConstraintReferencePick('A', referenceA.subshapeType);
  state().setPickedAssemblyReference(referenceA);
  state().startAssemblyConstraintReferencePick('B', referenceB.subshapeType);
  state().setPickedAssemblyReference(referenceB);
  state().updateAssemblyConstraintDraft({
    offset: values.offset ?? 0,
    angle: values.angle ?? Math.PI / 2,
    flipped: values.flipped ?? false,
  });
  const preview = state().previewAssemblyConstraint();
  assert.ok(preview, `${type} preview should run`);
  const id = state().confirmAssemblyConstraint();
  assert.ok(id, `${type} should be committed`);
  return id;
}

// Coincident planar references: preview is reversible and confirmation is one history command.
{
  const { assemblyId, componentIds: [base, moving] } = setup();
  state().updateTransform(moving, [20, 10, 30], [0, 0, 0], [1, 1, 1]);
  const beforeConstraintHistory = state().past.length;
  const a = standard(base, 'plane', 'XY');
  const b = standard(moving, 'plane', 'XY');
  state().startAssemblyConstraint(assemblyId, 'coincident');
  state().startAssemblyConstraintReferencePick('A', 'plane');
  state().setPickedAssemblyReference(a);
  state().startAssemblyConstraintReferencePick('B', 'plane');
  state().setPickedAssemblyReference(b);
  state().updateAssemblyConstraintDraft({ offset: 5 });
  assert.ok(state().previewAssemblyConstraint()?.success);
  assert.equal(rounded(state().nodes[moving].transform.position[2]), 5);
  state().cancelAssemblyConstraint();
  assert.equal(rounded(state().nodes[moving].transform.position[2]), 30, 'cancel restores pre-preview pose');

  const id = addViaWorkflow(assemblyId, 'coincident', a, b, { offset: 5 });
  const data = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(data));
  assert.equal(data.constraints[id].status, 'solved');
  assert.equal(rounded(state().nodes[moving].transform.position[2]), 5);
  assert.equal(state().past.length, beforeConstraintHistory + 1, 'constraint and solve are one undo step');
  state().undo();
  const undone = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(undone));
  assert.equal(undone.constraintIds.length, 0);
  assert.equal(rounded(state().nodes[moving].transform.position[2]), 30);
  state().redo();
  const redone = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(redone));
  assert.equal(redone.constraintIds.length, 1);
  assert.equal(rounded(state().nodes[moving].transform.position[2]), 5);

  state().editAssemblyConstraint(assemblyId, id, { offset: 7 });
  const edited = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(edited));
  assert.equal(edited.constraints[id].status, 'solved');
  assert.equal(rounded(state().nodes[moving].transform.position[2]), 7);
  state().editAssemblyConstraint(assemblyId, id, { enabled: false });
  const disabled = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(disabled));
  assert.equal(disabled.constraints[id].status, 'unsolved');
  state().deleteAssemblyConstraint(assemblyId, id);
  const deleted = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(deleted));
  assert.equal(deleted.constraintIds.length, 0);
  state().undo();
  const deleteUndone = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(deleteUndone));
  assert.equal(deleteUndone.constraintIds.length, 1);
}

// Concentric axes preserve axial position while removing radial offset.
{
  const { assemblyId, componentIds: [base, shaft] } = setup();
  state().updateTransform(shaft, [14, -8, 23], [0.2, 0.4, 0], [1, 1, 1]);
  const id = addViaWorkflow(
    assemblyId,
    'concentric',
    standard(base, 'axis', 'Z'),
    standard(shaft, 'axis', 'Z'),
  );
  const transform = state().nodes[shaft].transform;
  assert.equal(rounded(transform.position[0]), 0);
  assert.equal(rounded(transform.position[1]), 0);
  assert.equal(rounded(transform.position[2]), 23);
  const data = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(data));
  assert.equal(data.constraints[id].status, 'solved');
}

// Parallel, perpendicular, angle, and distance each solve to their target.
for (const type of ['parallel', 'perpendicular', 'angle'] as const) {
  const { assemblyId, componentIds: [base, moving] } = setup();
  state().updateTransform(moving, [10, 0, 0], [0.3, 0.4, 0.2], [1, 1, 1]);
  const id = addViaWorkflow(
    assemblyId,
    type,
    standard(base, 'axis', 'Z'),
    standard(moving, 'axis', 'Z'),
    type === 'angle' ? { angle: Math.PI / 3 } : {},
  );
  const data = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(data));
  assert.equal(data.constraints[id].status, 'solved', `${type} status`);
}

{
  const { assemblyId, componentIds: [base, moving] } = setup();
  state().updateTransform(moving, [10, 0, 0], [0, 0, 0], [1, 1, 1]);
  const id = addViaWorkflow(
    assemblyId,
    'distance',
    standard(base, 'origin', 'origin'),
    standard(moving, 'origin', 'origin'),
    { offset: 35 },
  );
  assert.equal(rounded(state().nodes[moving].transform.position[0]), 35);
  const data = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(data));
  assert.equal(data.constraints[id].status, 'solved');
}

// A grounded chain solves incrementally and survives save/reload.
{
  const { assemblyId, componentIds: [base, shaft, bearing] } = setup(3);
  state().updateTransform(shaft, [10, 4, 8], [0, 0, 0], [1, 1, 1]);
  state().updateTransform(bearing, [-7, 3, 18], [0, 0, 0], [1, 1, 1]);
  addViaWorkflow(assemblyId, 'concentric', standard(base, 'axis', 'Z'), standard(shaft, 'axis', 'Z'));
  addViaWorkflow(assemblyId, 'concentric', standard(shaft, 'axis', 'Z'), standard(bearing, 'axis', 'Z'));
  addViaWorkflow(
    assemblyId,
    'distance',
    standard(base, 'origin', 'origin'),
    standard(shaft, 'origin', 'origin'),
    { offset: 20 },
  );
  const rebuild = state().solveAssemblyConstraints(assemblyId);
  assert.equal(rebuild?.success, true);
  assert.deepEqual(rebuild?.underConstrainedComponentIds, []);
  assert.equal(rounded(state().nodes[shaft].transform.position[0]), 0);
  assert.equal(rounded(state().nodes[bearing].transform.position[0]), 0);

  const document = ProjectFileService.build(state().nodes, state().rootIds, 'Phase C Chain');
  const loaded = ProjectFileService.parse(JSON.stringify(document));
  const loadedData = loaded.nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(loadedData));
  assert.equal(loadedData.constraintIds.length, 3);
  assert.ok(loadedData.constraintIds.every((id) => loadedData.constraints[id].status === 'solved'));
}

// Two fixed components with an impossible distance report a conflict.
{
  const { assemblyId, componentIds: [a, b] } = setup();
  state().setAssemblyComponentFixed(b, true);
  state().updateTransform(b, [10, 0, 0], [0, 0, 0], [1, 1, 1]);
  const data = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(data));
  const id = crypto.randomUUID();
  const constraint: AssemblyConstraint = {
    id,
    assemblyId,
    type: 'distance',
    referenceA: standard(a, 'origin', 'origin'),
    referenceB: standard(b, 'origin', 'origin'),
    offset: 50,
    enabled: true,
    status: 'unsolved',
  };
  state().setNodeParams(assemblyId, {
    assembly: {
      ...data,
      constraintIds: [id],
      constraints: { [id]: constraint },
    },
  });
  const result = state().solveAssemblyConstraints(assemblyId);
  assert.equal(result?.success, false);
  assert.equal(result?.constraintStatuses[id], 'conflicting');
}

// Missing topology references fail safely without moving components.
{
  const { assemblyId, componentIds: [a, b] } = setup();
  const data = state().nodes[assemblyId].params?.assembly;
  assert.ok(isAssemblyDocumentData(data));
  const id = crypto.randomUUID();
  const missingReference = {
    ...standard(b, 'origin', 'origin'),
    sourceNodeId: 'deleted-feature',
  };
  const constraint: AssemblyConstraint = {
    id,
    assemblyId,
    type: 'distance',
    referenceA: standard(a, 'origin', 'origin'),
    referenceB: missingReference,
    offset: 10,
    enabled: true,
    status: 'unsolved',
  };
  const nodes = {
    ...state().nodes,
    [assemblyId]: {
      ...state().nodes[assemblyId],
      params: {
        ...state().nodes[assemblyId].params,
        assembly: { ...data, constraintIds: [id], constraints: { [id]: constraint } },
      },
    },
  };
  const result = assemblyConstraintSolver.solve(nodes, assemblyId);
  assert.equal(result.success, false);
  assert.equal(result.constraintStatuses[id], 'missing-reference');
}

console.log('✓ Phase C guided constraints, solving, chains, conflicts, persistence, and history');
