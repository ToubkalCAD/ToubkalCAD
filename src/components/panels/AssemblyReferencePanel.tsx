import React, { useState } from 'react';
import { AssemblyReferenceService } from '../../assembly/AssemblyReferenceService';
import type { AssemblyReference } from '../../assembly/types';
import { useCADStore } from '../../store/cadStore';

const TYPES: Array<{ value: AssemblyReference['subshapeType']; label: string }> = [
  { value: 'face', label: 'Face' },
  { value: 'edge', label: 'Edge' },
  { value: 'vertex', label: 'Vertex' },
  { value: 'axis', label: 'Standard Axis' },
  { value: 'plane', label: 'Standard Plane' },
  { value: 'origin', label: 'Part Origin' },
];

const formatVec = (value?: [number, number, number]) =>
  value ? value.map((entry) => entry.toFixed(3)).join(', ') : '—';

export const AssemblyReferencePanel: React.FC = () => {
  const nodes = useCADStore((state) => state.nodes);
  const reference = useCADStore((state) => state.pickedAssemblyReference);
  const mode = useCADStore((state) => state.interactionMode);
  const [type, setType] = useState<AssemblyReference['subshapeType']>('face');
  const validation = reference ? AssemblyReferenceService.validate(nodes, reference) : null;

  const resolve = () => {
    if (!reference || !window.oc) return;
    const result = AssemblyReferenceService.resolve(window.oc, nodes, reference);
    if (result.valid) {
      useCADStore.getState().setPickedAssemblyReference(result.reference);
      useCADStore.getState().log(`Reference resolved${result.score != null ? ` (score ${result.score.toFixed(4)})` : ''}.`, 'success');
    } else {
      useCADStore.getState().log(`Reference resolution failed: ${result.reason ?? 'unknown reason'}`, 'error');
    }
  };

  return (
    <div style={{ padding: 12, display: 'grid', gap: 10, fontSize: 11 }}>
      <div style={{ fontWeight: 700 }}>Persistent Assembly Reference</div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Capture geometry on a placed component. The stored signature is resolved against the current part topology.
      </div>
      <label style={{ display: 'grid', gap: 5 }}>
        Reference type
        <select value={type} onChange={(event) => setType(event.target.value as AssemblyReference['subshapeType'])}>
          {TYPES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
      </label>
      {mode === 'ASSEMBLY_REFERENCE_PICK' ? (
        <button onClick={() => useCADStore.getState().cancelAssemblyReferencePick()}>Cancel Picking</button>
      ) : (
        <button onClick={() => useCADStore.getState().startAssemblyReferencePick(type)}>Pick {TYPES.find((entry) => entry.value === type)?.label}</button>
      )}
      {reference ? (
        <section style={{ display: 'grid', gap: 5, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 700 }}>{reference.referenceName}</div>
          <div style={{ color: validation?.valid ? '#45a868' : '#d34b4b' }}>
            {validation?.valid ? 'Reference valid' : validation?.reason}
          </div>
          <div>Component: <code>{reference.componentId.slice(0, 8)}</code></div>
          <div>Part: <code>{reference.partId.slice(0, 8)}</code></div>
          {reference.sourceNodeId && <div>Source: <code>{reference.sourceNodeId.slice(0, 8)}</code></div>}
          <div>Persistent kind: {reference.stableRef?.kind ?? 'standard datum'}</div>
          <div>Local point: {formatVec(reference.localPoint)}</div>
          <div>World point: {formatVec(reference.worldPoint)}</div>
          <div>World direction: {formatVec(reference.worldDirection)}</div>
          {reference.radius != null && <div>Radius: {reference.radius.toFixed(3)} mm</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 4 }}>
            <button onClick={resolve} disabled={!validation?.valid || !reference.stableRef}>Resolve Now</button>
            <button onClick={() => useCADStore.getState().clearPickedAssemblyReference()}>Clear</button>
          </div>
        </section>
      ) : (
        <div style={{ color: 'var(--text-muted)' }}>No reference captured.</div>
      )}
    </div>
  );
};
