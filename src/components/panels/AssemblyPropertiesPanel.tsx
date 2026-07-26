import React from 'react';
import { useCADStore } from '../../store/cadStore';
import { isAssemblyComponentData, isAssemblyDocumentData } from '../../assembly/types';
import { showAssemblyInsertPartDialog, showAssemblyReplacePartDialog } from '../AssemblyInsertPartDialog';

const buttonStyle: React.CSSProperties = {
  padding: '6px 8px', fontSize: 10, color: 'var(--text-primary)',
  background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 4,
};
const sectionStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)', paddingTop: 10, display: 'grid', gap: 7,
};

export const AssemblyPropertiesPanel: React.FC = () => {
  const nodes = useCADStore((state) => state.nodes);
  const selectedId = useCADStore((state) => state.selectedIds[0]);
  const interference = useCADStore((state) => state.assemblyInterferenceReport);
  const interferenceProgress = useCADStore((state) => state.assemblyInterferenceProgress);
  const bom = useCADStore((state) => state.assemblyBom);
  const node = selectedId ? nodes[selectedId] : undefined;

  if (!node || (node.type !== 'assembly' && node.type !== 'assembly_component')) {
    return <div style={{ padding: 14, fontSize: 11, color: 'var(--text-muted)' }}>Select an assembly or placed component.</div>;
  }

  if (node.type === 'assembly') {
    const data = node.params?.assembly;
    if (!isAssemblyDocumentData(data)) return null;
    const visible = data.componentIds.filter((id) => nodes[id]?.visible).length;
    const suppressed = data.componentIds.filter((id) => {
      const value = nodes[id]?.params?.assemblyComponent;
      return isAssemblyComponentData(value) && value.suppressed;
    }).length;
    const statusCounts = Object.values(data.constraints).reduce<Record<string, number>>((counts, constraint) => {
      counts[constraint.status] = (counts[constraint.status] ?? 0) + 1;
      return counts;
    }, {});
    const active = data.activeComponentId ? nodes[data.activeComponentId] : undefined;
    const hasProblems = Object.values(data.constraints).some((constraint) =>
      constraint.status === 'conflicting' || constraint.status === 'missing-reference');
    return (
      <div style={{ padding: 12, display: 'grid', gap: 12, fontSize: 11 }}>
        <section>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{node.name}</div>
          <div>{data.componentIds.length} components · {visible} visible · {suppressed} suppressed</div>
          <div>{data.constraintIds.length} constraints</div>
          <div>Status: {hasProblems ? 'Needs attention' : 'Ready'}</div>
          <div>Active: {active?.name ?? 'None'}</div>
          {Object.entries(statusCounts).map(([status, count]) => <div key={status}>{status}: {count}</div>)}
        </section>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={data.autoFixFirstComponent}
            onChange={(event) => useCADStore.getState().setAssemblyAutoFixFirst(node.id, event.target.checked)} />
          Auto-fix first component
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <button style={buttonStyle} onClick={() => showAssemblyInsertPartDialog(node.id)}>Insert Part…</button>
          <button style={buttonStyle} onClick={() => useCADStore.getState().solveAssemblyConstraints(node.id)}>Rebuild</button>
          <button style={buttonStyle} onClick={() => window.dispatchEvent(
            new CustomEvent('cad-properties-tab', { detail: { tab: 'constraints' } }),
          )}>Constraints</button>
        </div>

        <section style={sectionStyle}>
          <div style={{ fontWeight: 700 }}>Exploded View</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={data.exploded.enabled}
              onChange={(event) => useCADStore.getState().setAssemblyExplodedEnabled(node.id, event.target.checked)} />
            Show exploded
          </label>
          <label>
            Explosion {(data.exploded.factor * 100).toFixed(0)}%
            <input aria-label="Explosion factor" type="range" min={0} max={1} step={0.05}
              value={data.exploded.factor}
              onChange={(event) => useCADStore.getState().setAssemblyExplosionFactor(node.id, Number(event.target.value))}
              style={{ width: '100%' }} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button style={buttonStyle} onClick={() => useCADStore.getState().generateAssemblyExplosion(node.id)}>Auto Explode</button>
            <button style={buttonStyle} onClick={() => useCADStore.getState().resetAssemblyExplosion(node.id)}>Reset</button>
          </div>
        </section>

        <section style={sectionStyle}>
          <div style={{ fontWeight: 700 }}>Interference</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button style={buttonStyle} disabled={interferenceProgress !== null}
              onClick={() => void useCADStore.getState().runAssemblyInterferenceCheck(node.id)}>Check All</button>
            <button style={buttonStyle} disabled={interferenceProgress !== null}
              onClick={() => void useCADStore.getState().runAssemblyInterferenceCheck(node.id, true)}>Check Selected</button>
          </div>
          {interferenceProgress !== null && <div>Checking… {(interferenceProgress * 100).toFixed(0)}%</div>}
          {interference?.assemblyId === node.id && (
            <details open={interference.pairs.length > 0}>
              <summary>{interference.pairs.length} contact pair(s) from {interference.candidatePairCount} candidates</summary>
              {interference.pairs.map((pair) => (
                <button key={`${pair.componentAId}:${pair.componentBId}`} style={{ ...buttonStyle, width: '100%', marginTop: 4 }}
                  onClick={() => useCADStore.getState().setSelectedIds([pair.componentAId, pair.componentBId])}>
                  {nodes[pair.componentAId]?.name} / {nodes[pair.componentBId]?.name}
                  {' · '}{pair.kind}{pair.overlapVolume > 0 ? ` · ${pair.overlapVolume.toFixed(3)} mm³` : ''}
                </button>
              ))}
              <button style={{ ...buttonStyle, width: '100%', marginTop: 5 }}
                onClick={() => useCADStore.getState().clearAssemblyInterference()}>Clear Highlights</button>
            </details>
          )}
        </section>

        <section style={sectionStyle}>
          <div style={{ fontWeight: 700 }}>Bill of Materials</div>
          <button style={buttonStyle} onClick={() => useCADStore.getState().generateAssemblyBom(node.id)}>Generate BOM</button>
          {bom?.assemblyId === node.id && bom.entries.map((entry) => (
            <div key={entry.partId} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 5 }}>
              <span>{entry.partNumber} · {entry.partName}</span>
              <span>×{entry.quantity}{entry.suppressedQuantity ? ` (${entry.suppressedQuantity} suppressed)` : ''}</span>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button style={buttonStyle} onClick={() => useCADStore.getState().exportAssemblyBom(node.id, 'csv')}>Export CSV</button>
            <button style={buttonStyle} onClick={() => useCADStore.getState().exportAssemblyBom(node.id, 'json')}>Export JSON</button>
          </div>
        </section>

        <section style={sectionStyle}>
          <div style={{ fontWeight: 700 }}>Assembly Output</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button style={buttonStyle} onClick={() => useCADStore.getState().createAssemblyCompound(node.id)}>Create Compound</button>
            <button style={buttonStyle} onClick={() => useCADStore.getState().exportAssemblySTEP(node.id)}>Export STEP</button>
          </div>
        </section>
      </div>
    );
  }

  const data = node.params?.assemblyComponent;
  if (!isAssemblyComponentData(data)) return null;
  const part = nodes[data.partId];
  const assemblyData = nodes[data.assemblyId]?.params?.assembly;
  const explodedOffset: [number, number, number] = isAssemblyDocumentData(assemblyData)
    ? assemblyData.exploded.transforms[node.id]?.offset ?? [0, 0, 0]
    : [0, 0, 0];
  const setExplodedAxis = (axis: number, value: number) => {
    const next = [...explodedOffset] as [number, number, number];
    next[axis] = Number.isFinite(value) ? value : 0;
    useCADStore.getState().setAssemblyComponentExplodedOffset(node.id, next);
  };
  return (
    <div style={{ padding: 12, display: 'grid', gap: 10, fontSize: 11 }}>
      <div style={{ fontWeight: 700 }}>{node.name}</div>
      <div>Part: {part?.name ?? 'Missing definition'}</div>
      <div>Instance ID: <code>{data.instanceId.slice(0, 8)}</code></div>
      <label><input type="checkbox" checked={data.fixed}
        onChange={(event) => useCADStore.getState().setAssemblyComponentFixed(node.id, event.target.checked)} /> Fixed</label>
      <label><input type="checkbox" checked={data.suppressed}
        onChange={(event) => useCADStore.getState().setAssemblyComponentSuppressed(node.id, event.target.checked)} /> Suppressed</label>
      <label><input type="checkbox" checked={node.visible}
        onChange={() => useCADStore.getState().toggleVisibility(node.id)} /> Visible</label>
      {data.missingPart && <div style={{ color: '#d34b4b' }}>Referenced part definition is missing.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <button style={buttonStyle} onClick={() => useCADStore.getState().activateAssemblyComponent(node.id)}>Activate</button>
        <button style={buttonStyle} onClick={() => useCADStore.getState().isolateAssemblyComponent(node.id)}>Isolate</button>
        <button style={buttonStyle} onClick={() => useCADStore.getState().copyComponentTransform(node.id)}>Copy Transform</button>
        <button style={buttonStyle} onClick={() => useCADStore.getState().pasteComponentTransform(node.id)}>Paste Transform</button>
        <button style={buttonStyle} onClick={() => useCADStore.getState().resetComponentTransform(node.id)}>Align Origin</button>
        <button style={buttonStyle} onClick={() => showAssemblyReplacePartDialog(data.assemblyId, node.id)}>Replace…</button>
      </div>
      <section style={sectionStyle}>
        <div style={{ fontWeight: 700 }}>Manual Exploded Offset (mm)</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
          {(['X', 'Y', 'Z'] as const).map((label, axis) => (
            <label key={label}>{label}
              <input aria-label={`Exploded offset ${label}`} type="number" value={explodedOffset[axis]}
                onChange={(event) => setExplodedAxis(axis, Number(event.target.value))}
                style={{ width: '100%', boxSizing: 'border-box' }} />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
};
