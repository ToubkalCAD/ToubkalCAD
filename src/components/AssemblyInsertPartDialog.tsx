import React, { useEffect, useMemo, useState } from 'react';
import { useCADStore } from '../store/cadStore';
import { showPrompt } from './AppDialog';

const EVENT = 'cad-open-insert-part';

export function showAssemblyInsertPartDialog(assemblyId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { assemblyId, replaceId: null } }));
}

export function showAssemblyReplacePartDialog(assemblyId: string, replaceId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { assemblyId, replaceId } }));
}

export const AssemblyInsertPartDialog: React.FC = () => {
  const nodes = useCADStore((state) => state.nodes);
  const [assemblyId, setAssemblyId] = useState<string | null>(null);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const parts = useMemo(() => Object.values(nodes).filter((node) => node.type === 'component'), [nodes]);
  const [partId, setPartId] = useState('');

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ assemblyId: string; replaceId?: string | null }>).detail;
      const id = detail.assemblyId;
      setAssemblyId(id);
      setReplaceId(detail.replaceId ?? null);
      const first = Object.values(useCADStore.getState().nodes).find((node) => node.type === 'component');
      setPartId(first?.id ?? '');
    };
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);

  if (!assemblyId) return null;
  const assembly = nodes[assemblyId];
  if (!assembly) return null;
  const close = () => setAssemblyId(null);

  const createPart = async () => {
    const name = await showPrompt({
      title: 'Create Part in Assembly',
      label: 'Part name',
      defaultValue: `Part ${parts.length + 1}`,
    });
    if (!name) return;
    useCADStore.getState().createPartInAssembly(assemblyId, name);
    close();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9200, display: 'grid', placeItems: 'center',
      background: 'rgba(0,0,0,.42)',
    }} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label="Insert part" style={{
        width: 380, maxWidth: 'calc(100vw - 32px)', padding: 16,
        border: '1px solid var(--border)', borderRadius: 8,
        background: 'var(--surface-2)', boxShadow: '0 16px 48px rgba(0,0,0,.4)',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{replaceId ? 'Replace Component' : 'Insert Part'}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 14 }}>
          {replaceId ? 'Choose a replacement part definition.' : `Place a reusable part definition in ${assembly.name}.`}
        </div>
        <label style={{ display: 'grid', gap: 6, fontSize: 11 }}>
          Existing part
          <select value={partId} onChange={(event) => setPartId(event.target.value)} style={{
            padding: 8, color: 'var(--text-primary)', background: 'var(--surface-3)',
            border: '1px solid var(--border)', borderRadius: 4,
          }}>
            {parts.length === 0 && <option value="">No part definitions yet</option>}
            {parts.map((part) => <option key={part.id} value={part.id}>{part.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          {!replaceId && <button onClick={createPart}>Create New Part</button>}
          <button onClick={close}>Cancel</button>
          <button
            disabled={!partId}
            onClick={() => {
              if (replaceId) useCADStore.getState().replaceAssemblyComponent(replaceId, partId);
              else useCADStore.getState().insertPartInstance(assemblyId, partId);
              close();
            }}
          >
            {replaceId ? 'Replace' : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  );
};
