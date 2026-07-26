import React, { useEffect, useMemo, useState } from 'react';
import { AssemblyReferenceService } from '../../assembly/AssemblyReferenceService';
import {
  isAssemblyComponentData,
  isAssemblyDocumentData,
  type AssemblyConstraintType,
  type AssemblyReference,
} from '../../assembly/types';
import { useCADStore } from '../../store/cadStore';

const CONSTRAINT_TYPES: Array<{ type: AssemblyConstraintType; label: string }> = [
  { type: 'coincident', label: 'Coincident' },
  { type: 'concentric', label: 'Concentric' },
  { type: 'parallel', label: 'Parallel' },
  { type: 'perpendicular', label: 'Perpendicular' },
  { type: 'distance', label: 'Distance' },
  { type: 'angle', label: 'Angle' },
];

const REFERENCE_TYPES: Array<{ type: AssemblyReference['subshapeType']; label: string }> = [
  { type: 'face', label: 'Face' },
  { type: 'edge', label: 'Edge' },
  { type: 'vertex', label: 'Vertex' },
  { type: 'axis', label: 'Standard Axis' },
  { type: 'plane', label: 'Standard Plane' },
  { type: 'origin', label: 'Part Origin' },
];

const buttonStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--surface-3)',
  color: 'var(--text-primary)',
  fontSize: 10,
  cursor: 'pointer',
};

const fieldStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 6px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--surface-2)',
  color: 'var(--text-primary)',
  fontSize: 10,
};

function title(type: string): string {
  return type.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

export const AssemblyConstraintPanel: React.FC = () => {
  const nodes = useCADStore((state) => state.nodes);
  const selectedId = useCADStore((state) => state.selectedIds[0]);
  const draft = useCADStore((state) => state.assemblyConstraintDraft);
  const selectedConstraint = useCADStore((state) => state.selectedAssemblyConstraint);
  const interactionMode = useCADStore((state) => state.interactionMode);
  const [referenceAType, setReferenceAType] = useState<AssemblyReference['subshapeType']>('face');
  const [referenceBType, setReferenceBType] = useState<AssemblyReference['subshapeType']>('face');
  const draftAssemblyId = draft?.assemblyId;
  const draftType = draft?.type;

  useEffect(() => {
    if (!draftAssemblyId || !draftType) return;
    const preferred: AssemblyReference['subshapeType'] = 'face';
    setReferenceAType(preferred);
    setReferenceBType(preferred);
  }, [draftAssemblyId, draftType]);

  const selectedNode = selectedId ? nodes[selectedId] : undefined;
  const selectedComponentData = selectedNode?.params?.assemblyComponent;
  const inferredAssemblyId = draft?.assemblyId
    ?? selectedConstraint?.assemblyId
    ?? (selectedNode?.type === 'assembly' ? selectedNode.id
      : isAssemblyComponentData(selectedComponentData) ? selectedComponentData.assemblyId : undefined);
  const assembly = inferredAssemblyId ? nodes[inferredAssemblyId] : undefined;
  const assemblyData = assembly?.params?.assembly;

  const compatibility = useMemo(() => {
    if (!draft?.referenceA || !draft.referenceB) return null;
    return AssemblyReferenceService.compatible(draft.type, draft.referenceA, draft.referenceB);
  }, [draft]);

  if (!assembly || !isAssemblyDocumentData(assemblyData)) {
    return (
      <div style={{ padding: 14, fontSize: 11, color: 'var(--text-muted)' }}>
        Select an assembly or a placed component to create and inspect constraints.
      </div>
    );
  }

  if (draft) {
    const picking = interactionMode === 'ASSEMBLY_REFERENCE_PICK';
    const canConfirm = !!draft.referenceA && !!draft.referenceB && compatibility?.valid !== false;
    const referenceRow = (
      side: 'A' | 'B',
      reference: AssemblyReference | undefined,
      typeValue: AssemblyReference['subshapeType'],
      setTypeValue: (value: AssemblyReference['subshapeType']) => void,
    ) => (
      <div style={{ display: 'grid', gap: 5, padding: 8, border: '1px solid var(--border)', borderRadius: 5 }}>
        <div style={{ fontWeight: 700 }}>Reference {side}</div>
        <select
          aria-label={`Reference ${side} type`}
          value={typeValue}
          onChange={(event) => setTypeValue(event.target.value as AssemblyReference['subshapeType'])}
          style={fieldStyle}
        >
          {REFERENCE_TYPES.map((entry) => <option key={entry.type} value={entry.type}>{entry.label}</option>)}
        </select>
        <button
          style={buttonStyle}
          disabled={picking}
          onClick={() => useCADStore.getState().startAssemblyConstraintReferencePick(side, typeValue)}
        >
          {reference ? `Replace ${side}` : `Pick ${side}`}
        </button>
        <div style={{ color: reference ? 'var(--text-primary)' : 'var(--text-muted)', overflowWrap: 'anywhere' }}>
          {reference?.referenceName ?? 'Not selected'}
        </div>
      </div>
    );

    return (
      <div key="constraint-draft" style={{ padding: 12, display: 'grid', gap: 10, fontSize: 11 }}>
        <div>
          <div style={{ fontWeight: 800 }}>New {title(draft.type)} Constraint</div>
          <div style={{ color: 'var(--text-muted)', marginTop: 3 }}>
            Pick the anchor reference first, then the reference on the component that should move.
          </div>
        </div>
        {referenceRow('A', draft.referenceA, referenceAType, setReferenceAType)}
        {referenceRow('B', draft.referenceB, referenceBType, setReferenceBType)}
        {picking && (
          <button style={buttonStyle} onClick={() => useCADStore.getState().cancelAssemblyReferencePick()}>
            Cancel Current Pick
          </button>
        )}
        {(draft.type === 'coincident' || draft.type === 'distance') && (
          <label>
            Offset (mm)
            <input
              aria-label="Constraint offset"
              type="number"
              step="0.1"
              value={draft.offset}
              onChange={(event) => useCADStore.getState().updateAssemblyConstraintDraft({
                offset: Number(event.target.value) || 0,
              })}
              style={fieldStyle}
            />
          </label>
        )}
        {draft.type === 'angle' && (
          <label>
            Angle (degrees)
            <input
              aria-label="Constraint angle"
              type="number"
              step="1"
              value={Math.round(draft.angle * 180 / Math.PI * 1000) / 1000}
              onChange={(event) => useCADStore.getState().updateAssemblyConstraintDraft({
                angle: (Number(event.target.value) || 0) * Math.PI / 180,
              })}
              style={fieldStyle}
            />
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input
            type="checkbox"
            checked={draft.flipped}
            onChange={(event) => useCADStore.getState().updateAssemblyConstraintDraft({ flipped: event.target.checked })}
          />
          Flip direction
        </label>
        {(draft.validationMessage || compatibility?.reason) && (
          <div style={{ color: '#d34b4b' }}>{draft.validationMessage ?? compatibility?.reason}</div>
        )}
        {draft.previewed && !draft.validationMessage && (
          <div style={{ color: '#2f9e54' }}>Preview solved successfully.</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          <button
            style={buttonStyle}
            disabled={!canConfirm || picking}
            onClick={() => useCADStore.getState().previewAssemblyConstraint()}
          >
            Preview
          </button>
          <button
            style={{ ...buttonStyle, background: 'var(--accent)', color: '#fff' }}
            disabled={!canConfirm || picking}
            onClick={() => useCADStore.getState().confirmAssemblyConstraint()}
          >
            Confirm
          </button>
          <button style={buttonStyle} onClick={() => useCADStore.getState().cancelAssemblyConstraint()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const selected = selectedConstraint?.assemblyId === assembly.id
    ? assemblyData.constraints[selectedConstraint.constraintId]
    : undefined;
  if (selected) {
    const hasOffset = selected.type === 'coincident' || selected.type === 'distance';
    const hasAngle = selected.type === 'angle';
    return (
      <div key="constraint-editor" style={{ padding: 12, display: 'grid', gap: 10, fontSize: 11 }}>
        <div>
          <div style={{ fontWeight: 800 }}>{title(selected.type)} Constraint</div>
          <div style={{
            color: selected.status === 'conflicting' || selected.status === 'missing-reference'
              ? '#d34b4b' : 'var(--text-muted)',
          }}>
            Status: {selected.status}
          </div>
          {selected.message && <div style={{ color: 'var(--text-muted)', marginTop: 3 }}>{selected.message}</div>}
        </div>
        <div>A: {selected.referenceA.referenceName ?? selected.referenceA.subshapeType}</div>
        <div>B: {selected.referenceB?.referenceName ?? selected.referenceB?.subshapeType ?? 'None'}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input
            type="checkbox"
            checked={selected.enabled}
            onChange={(event) => useCADStore.getState().editAssemblyConstraint(
              assembly.id, selected.id, { enabled: event.target.checked },
            )}
          />
          Enabled
        </label>
        {hasOffset && (
          <label>
            Offset (mm)
            <input
              type="number"
              defaultValue={selected.offset ?? 0}
              onBlur={(event) => useCADStore.getState().editAssemblyConstraint(
                assembly.id, selected.id, { offset: Number(event.target.value) || 0 },
              )}
              style={fieldStyle}
            />
          </label>
        )}
        {hasAngle && (
          <label>
            Angle (degrees)
            <input
              type="number"
              defaultValue={(selected.angle ?? 0) * 180 / Math.PI}
              onBlur={(event) => useCADStore.getState().editAssemblyConstraint(
                assembly.id, selected.id, { angle: (Number(event.target.value) || 0) * Math.PI / 180 },
              )}
              style={fieldStyle}
            />
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input
            type="checkbox"
            checked={!!selected.flipped}
            onChange={(event) => useCADStore.getState().editAssemblyConstraint(
              assembly.id, selected.id, { flipped: event.target.checked },
            )}
          />
          Flip direction
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <button style={buttonStyle} onClick={() => useCADStore.getState().solveAssemblyConstraints(assembly.id)}>
            Rebuild
          </button>
          <button
            style={{ ...buttonStyle, color: '#d34b4b' }}
            onClick={() => useCADStore.getState().deleteAssemblyConstraint(assembly.id, selected.id)}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div key="constraint-list" style={{ padding: 12, display: 'grid', gap: 10, fontSize: 11 }}>
      <div>
        <div style={{ fontWeight: 800 }}>{assembly.name} Constraints</div>
        <div style={{ color: 'var(--text-muted)' }}>{assemblyData.constraintIds.length} stored constraints</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {CONSTRAINT_TYPES.map((entry) => (
          <button
            key={entry.type}
            style={buttonStyle}
            disabled={assemblyData.componentIds.length < 2}
            onClick={() => useCADStore.getState().startAssemblyConstraint(assembly.id, entry.type)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {selectedNode?.type === 'assembly_component' && isAssemblyComponentData(selectedComponentData) && (
        <button
          style={buttonStyle}
          onClick={() => useCADStore.getState().setAssemblyComponentFixed(
            selectedNode.id, !selectedComponentData.fixed,
          )}
        >
          {selectedComponentData.fixed ? 'Unfix Component' : 'Fix Component'}
        </button>
      )}
      <button style={buttonStyle} onClick={() => useCADStore.getState().solveAssemblyConstraints(assembly.id)}>
        Rebuild Assembly
      </button>
      <div style={{ display: 'grid', gap: 5 }}>
        {assemblyData.constraintIds.map((constraintId) => {
          const constraint = assemblyData.constraints[constraintId];
          if (!constraint) return null;
          const warning = constraint.status === 'conflicting' || constraint.status === 'missing-reference';
          return (
            <button
              key={constraint.id}
              style={{ ...buttonStyle, textAlign: 'left', color: warning ? '#d34b4b' : 'var(--text-primary)' }}
              onClick={() => useCADStore.getState().selectAssemblyConstraint(assembly.id, constraint.id)}
            >
              {title(constraint.type)} · {constraint.status}
            </button>
          );
        })}
      </div>
    </div>
  );
};
