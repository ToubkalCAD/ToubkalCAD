// ============================================================
// ToubkalCAD – SurfaceBlendPanel.tsx
//
// Phase 2 (Surface Modeling) – tangent (G1) bridge between two surface bodies with
// an OPTIONAL explicit edge pair. Store-driven (surfaceBlendReq):
//   • opened via useCADStore.openSurfaceBlend(aId, bId)
//   • edge picking handled by useCADSurfaceBlendEdge (SURFACE_BLEND_EDGE mode)
//   • this panel = the two pick slots (A/B) + Apply/Cancel
//
// Both slots default to "Auto (nearest)"; picking one boundary edge on each body
// pins the bridge to that pair (needed when bodies have several facing boundaries).
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCADStore, SURFACE_MATERIAL } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccSurfaceService }   from '../services/OccSurfaceService';
import { useDragPanel }        from '../hooks/useDragPanel';

const reg = CADGeometryRegistry.getInstance();

/** Open the surface-blend panel for two surface bodies. */
export function showSurfaceBlendPanel(aId: string, bId: string): void {
  useCADStore.getState().openSurfaceBlend(aId, bId);
}

function nextIdx(): number {
  return Object.values(useCADStore.getState().nodes).filter((n) => n.type === 'surface_blend').length + 1;
}

const ACCENT = '#e0a32e';

export const SurfaceBlendPanel: React.FC = () => {
  const req       = useCADStore((s) => s.surfaceBlendReq);
  const pick      = useCADStore((s) => s.surfaceBlendPick);
  const setPick   = useCADStore((s) => s.setSurfaceBlendPick);
  const closePanel = useCADStore((s) => s.closeSurfaceBlend);
  const nodes     = useCADStore((s) => s.nodes);

  const [applyErr, setApplyErr] = useState<string | null>(null);
  const { pos, onHandleMouseDown } = useDragPanel(window.innerWidth - 340, 120);

  const doApplyRef  = useRef<() => void>(() => {});
  const doCancelRef = useRef<() => void>(() => {});

  // Enter = Apply · Esc = Cancel
  useEffect(() => {
    if (!req) return;
    let armed = false;
    const t = setTimeout(() => { armed = true; }, 300);
    const h = (e: KeyboardEvent) => {
      if (!armed) return;
      if (e.key === 'Escape')     { e.preventDefault(); doCancelRef.current(); }
      else if (e.key === 'Enter') { e.preventDefault(); doApplyRef.current(); }
    };
    window.addEventListener('keydown', h, true);
    return () => { clearTimeout(t); window.removeEventListener('keydown', h, true); };
  }, [req]);

  if (!req) return null;

  const aName = nodes[req.aId]?.name ?? req.aId.slice(0, 6);
  const bName = nodes[req.bId]?.name ?? req.bId.slice(0, 6);

  const doCancel = () => closePanel();

  const doApply = () => {
    const store = useCADStore.getState();
    if (!window.oc) { setApplyErr('OCC kernel not ready.'); return; }
    const a = reg.getShape(req.aId);
    const b = reg.getShape(req.bId);
    if (!a || !b) { setApplyErr('A source body is missing — re-select.'); return; }

    // Explicit only when BOTH edges are picked; otherwise auto-nearest.
    const ordA = pick.a != null && pick.b != null ? pick.a : null;
    const ordB = pick.a != null && pick.b != null ? pick.b : null;

    store.setProcessing(true, 'Blending…');
    try {
      const result = OccSurfaceService.blend(window.oc, a, b, ordA, ordB);
      const id   = crypto.randomUUID();
      const name = `Surface Blend${nextIdx()}`;
      reg.registerShape(id, result);
      store.addNode({
        id, name, type: 'surface_blend', visible: true, locked: false, parentId: null, notes: '',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material:  { ...SURFACE_MATERIAL },
        bodyType:  'surface',
        params: { opType: 'surfaceBlend', sourceIds: [req.aId, req.bId], opParams: { edgeA: ordA, edgeB: ordB } },
      });
      window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
      store.log(`${name} created ✓`, 'success');
      store.setProcessing(false);
      closePanel();
    } catch (e: any) {
      store.setProcessing(false);
      const msg = e?.message ?? String(e);
      store.log(`Blend FAILED: ${msg}`, 'error');
      setApplyErr(msg);
    }
  };

  doApplyRef.current  = doApply;
  doCancelRef.current = doCancel;

  const onlyOnePicked = (pick.a != null) !== (pick.b != null);

  const slot = (which: 'a' | 'b', label: string, bodyName: string, color: string) => {
    const val = pick[which];
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--surface-3)', borderRadius: 'var(--radius-sm)',
        border: `1px solid ${val != null ? color : 'var(--border)'}`, padding: '6px 10px',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 11, color, fontWeight: 700 }}>{label}: {bodyName}</span>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
            {val != null ? `edge #${val}` : 'Auto (nearest)'}
          </span>
        </div>
        <button onClick={() => setPick(which, null)} disabled={val == null}
          style={{ ...miniBtn, opacity: val == null ? 0.4 : 1 }}>Auto</button>
      </div>
    );
  };

  return createPortal(
    <div style={{
      position: 'fixed', top: pos.y, left: pos.x, zIndex: 9000, width: 300,
      background: 'var(--surface-2)', border: `1px solid ${ACCENT}`,
      borderRadius: 'var(--radius-md)', boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
      overflow: 'hidden', userSelect: 'none',
    }}>
      <div onMouseDown={onHandleMouseDown} style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)', cursor: 'move',
        background: 'var(--surface-1)', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 15 }}>⌒</span>
        <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)' }}>Surface Blend</span>
        <span style={{ marginLeft: 'auto', fontSize: 8, color: ACCENT, background: 'var(--surface-3)', borderRadius: 3, padding: '2px 6px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
          Tangent G1
        </span>
      </div>

      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Click one boundary edge on each body in the viewport, or leave both on Auto to
          bridge the nearest facing edges.
        </div>
        {slot('a', 'Edge A', aName, '#66ccff')}
        {slot('b', 'Edge B', bName, '#ff9bd0')}
        {onlyOnePicked && (
          <div style={{ fontSize: 10, color: '#d9a441', fontStyle: 'italic' }}>
            Pick an edge on both bodies to pin the pair — otherwise Auto is used.
          </div>
        )}
      </div>

      {applyErr && (
        <div style={{
          margin: '0 14px 8px', padding: '6px 10px',
          background: 'rgba(220,50,50,0.12)', border: '1px solid rgba(220,50,50,0.4)',
          borderRadius: 'var(--radius-sm)', fontSize: 10, color: '#ff7070', lineHeight: 1.5,
        }}>⚠ {applyErr}</div>
      )}

      <div style={{ padding: '8px 14px 10px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginRight: 'auto' }}>⏎ Apply · Esc Cancel</span>
        <button onClick={doCancel} style={{ padding: '4px 14px', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 11 }}>Cancel</button>
        <button onClick={doApply} style={{ padding: '4px 16px', background: ACCENT, border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Apply</button>
      </div>
    </div>,
    document.body,
  );
};

const miniBtn: React.CSSProperties = {
  padding: '2px 8px', background: 'var(--surface-1)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 10,
};
