// ============================================================
// ToubkalCAD – TreeContextMenu.tsx
//
// Right-click context menu for the model tree.
// Handles three node families:
//   sketch        → Resume Sketch + 3D operations on child wires
//   sketch_wire   → 3D operations on this wire
//   3D op nodes   → Re-edit the operation (Extrude/Revolve/…)
// ============================================================

import React, { useEffect, useRef } from 'react';
import { useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS } from '../store/cadStore';
import type { NodeType, Workplane } from '../store/cadStore';
import { show3DOpPanel } from './Op3DPanel';
import type { Op3DType } from './Op3DPanel';
import { showParamModal }        from './ParameterModal';
import { CADGeometryRegistry }   from '../services/CADGeometryRegistry';
import { OccExtrusionService }   from '../services/OccExtrusionService';
import { OccRevolutionService }  from '../services/OccRevolutionService';
import { OccLoftService }        from '../services/OccLoftService';

declare global { interface Window { oc: any } }

function createShape(id: string, name: string, type: NodeType, shape: any) {
  CADGeometryRegistry.getInstance().registerShape(id, shape);
  useCADStore.getState().addNode({
    id, name, type, visible: true, locked: false, parentId: null, notes: '',
    transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS[type] ?? 0x5588cc },
  });
  window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
  useCADStore.getState().log(`${name} created.`, 'success');
}

// Node types whose right-click triggers re-edit
const REEDITABLE_OP = new Set<NodeType>(['extrusion', 'revolve', 'loft', 'sweep', 'compound']);

// ─── Context menu ─────────────────────────────────────────────────────────────

export const TreeContextMenu: React.FC = () => {
  const menu         = useCADStore((s) => s.treeContextMenu);
  const nodes        = useCADStore((s) => s.nodes);
  const closeMenu    = useCADStore((s) => s.closeTreeContextMenu);
  const resumeSketch = useCADStore((s) => s.resumeSketchSession);
  const menuRef      = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!menu) return;
    const onOut = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    const t = setTimeout(() => document.addEventListener('mousedown', onOut), 80);
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onOut); document.removeEventListener('keydown', onKey); };
  }, [menu, closeMenu]);

  if (!menu) return null;

  const node    = nodes[menu.nodeId];
  if (!node) return null;

  // ── Classify the node ─────────────────────────────────────────────────────────

  const isSketchContainer = node.type === 'sketch';
  const isSketchWire      = node.type === 'sketch_wire';
  const isOp3D            = REEDITABLE_OP.has(node.type) && !!node.params?.opType;

  // Sketch wire IDs available for 3D operations (sketch container) or just this wire
  const wireIds: string[] = isSketchWire
    ? [menu.nodeId]
    : isSketchContainer
      ? node.children.filter((id) => nodes[id]?.type === 'sketch_wire')
      : [];

  // Nothing to show for unrecognised types
  if (!isSketchContainer && !isSketchWire && !isOp3D) return null;

  const firstWireId = wireIds[0];
  const reg = CADGeometryRegistry.getInstance();

  function getDir(wireId: string): [number, number, number] {
    const wp = useCADStore.getState().nodes[wireId]?.params?.workplane as Workplane | undefined;
    return wp?.normal ?? [0, 1, 0];
  }

  // ── Position clamped to viewport ──────────────────────────────────────────────
  const mW = 210;
  const mH = isSketchContainer ? 220 : isOp3D ? 100 : 140;
  const x  = menu.x + mW > window.innerWidth  ? menu.x - mW : menu.x;
  const y  = menu.y + mH > window.innerHeight ? menu.y - mH : menu.y;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const doExtrude = () => {
    if (!firstWireId || !window.oc) return;
    closeMenu();
    showParamModal('Extrude', [{ key: 'h', label: 'Height', default: 20, min: 0.01, unit: 'mm' }])
      .then(v => {
        if (!v) return;
        const wire = reg.getShape(firstWireId);
        if (!wire) { useCADStore.getState().log('Wire not found.', 'error'); return; }
        useCADStore.getState().setProcessing(true, 'Extruding…');
        try { createShape(crypto.randomUUID(), `Extrusion${v.h.toFixed(0)}mm`, 'extrusion', OccExtrusionService.extrudeWire(window.oc, wire, v.h, getDir(firstWireId))); }
        catch (e: any) { useCADStore.getState().log(e.message, 'error'); }
        finally { useCADStore.getState().setProcessing(false); }
      });
  };

  const doRevolve = () => {
    if (!firstWireId || !window.oc) return;
    closeMenu();
    showParamModal('Revolve', [
      { key: 'axis',  label: 'Axis (0=X 1=Y 2=Z)', default: 1, min: 0, max: 2, step: 1 },
      { key: 'angle', label: 'Angle', default: 360, min: 1, max: 360, unit: '°' },
    ]).then(v => {
      if (!v) return;
      const wire = reg.getShape(firstWireId);
      if (!wire) { useCADStore.getState().log('Wire not found.', 'error'); return; }
      const axes: [number,number,number][] = [[1,0,0],[0,1,0],[0,0,1]];
      const axLabels = ['X','Y','Z'];
      const idx = Math.round(Math.max(0, Math.min(2, v.axis)));
      useCADStore.getState().setProcessing(true, 'Revolving…');
      try { createShape(crypto.randomUUID(), `Revolve${v.angle.toFixed(0)}°/${axLabels[idx]}`, 'revolve', OccRevolutionService.revolveProfile(window.oc, wire, [0,0,0], axes[idx], v.angle)); }
      catch (e: any) { useCADStore.getState().log(e.message, 'error'); }
      finally { useCADStore.getState().setProcessing(false); }
    });
  };

  const doLoft = () => {
    if (wireIds.length < 2 || !window.oc) return;
    closeMenu();
    showParamModal('Loft', [{ key: 'solid', label: 'Solid (1) or Shell (0)', default: 1, min: 0, max: 1, step: 1 }])
      .then(v => {
        if (!v) return;
        const wires = wireIds.map(id => reg.getShape(id)).filter(Boolean);
        if (wires.length < 2) { useCADStore.getState().log('Wires not found.', 'error'); return; }
        useCADStore.getState().setProcessing(true, 'Lofting…');
        try { createShape(crypto.randomUUID(), `Loft(${wireIds.length})`, 'loft', OccLoftService.loftProfiles(window.oc, wires, v.solid >= 0.5, false)); }
        catch (e: any) { useCADStore.getState().log(e.message, 'error'); }
        finally { useCADStore.getState().setProcessing(false); }
      });
  };
  const doReEdit  = () => {
    closeMenu();
    const opType  = node.params?.opType as Op3DType;
    const wIds    = node.params?.targetWireIds as string[] | undefined ?? [];
    show3DOpPanel(opType, wIds, menu.nodeId);
  };

  // ── Item component ────────────────────────────────────────────────────────────

  const Item: React.FC<{
    icon: string; label: string; sub?: string;
    onClick: () => void; disabled?: boolean; accent?: string;
  }> = ({ icon, label, sub, onClick, disabled, accent }) => (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', textAlign: 'left',
        background: 'none', border: 'none',
        padding: '5px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        fontSize: 12, borderRadius: 3, opacity: disabled ? 0.45 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          (e.currentTarget as HTMLElement).style.background = accent ?? 'var(--accent)';
          (e.currentTarget as HTMLElement).style.color = '#fff';
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'none';
        (e.currentTarget as HTMLElement).style.color = disabled ? 'var(--text-muted)' : 'var(--text-primary)';
      }}
    >
      <span style={{ fontSize: 13, width: 16, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {sub && <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{sub}</span>}
    </button>
  );

  const Sep = () => <div style={{ height: 1, background: 'var(--border)', margin: '3px 0' }} />;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed', left: x, top: y, zIndex: 9001,
        width: mW,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
        padding: '4px 0', userSelect: 'none', overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '5px 12px 4px', borderBottom: '1px solid var(--border-soft)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: NODE_COLOR[node.type] ?? 'var(--accent)', letterSpacing: '0.4px' }}>
          {NODE_ICON[node.type] ?? '▪'} {node.name}
        </div>
        {isSketchContainer && wireIds.length > 0 && (
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>
            {wireIds.length} wire{wireIds.length !== 1 ? 's' : ''}
          </div>
        )}
        {isOp3D && (
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>
            Double-click also re-edits
          </div>
        )}
      </div>

      {/* ── 3D op node: Re-edit ───────────────────────────────────────────── */}
      {isOp3D && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="✏️" label="Re-edit" accent="#cc6600" onClick={doReEdit} />
        </div>
      )}

      {/* ── Sketch container: Resume + 3D ops ────────────────────────────── */}
      {isSketchContainer && (
        <>
          <div style={{ padding: '3px 0 1px' }}>
            <Item icon="✦" label="Resume Sketch" onClick={() => { closeMenu(); resumeSketch(menu.nodeId); }} />
          </div>
          {wireIds.length > 0 && (
            <>
              <Sep />
              <div style={{ padding: '2px 12px 3px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                Create 3D Solid
              </div>
              <Item icon="↑" label="Extrude" sub={wireIds.length > 1 ? '1st wire' : undefined} onClick={doExtrude} />
              <Item icon="↻" label="Revolve" sub={wireIds.length > 1 ? '1st wire' : undefined} onClick={doRevolve} />
              {wireIds.length >= 2 && <Item icon="⊿" label="Loft" sub={`${wireIds.length} wires`} onClick={doLoft} />}
            </>
          )}
          {wireIds.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No wires yet — resume sketch to draw.
            </div>
          )}
        </>
      )}

      {/* ── Sketch wire: 3D ops ───────────────────────────────────────────── */}
      {isSketchWire && (
        <>
          <div style={{ padding: '2px 12px 3px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Create 3D Solid
          </div>
          <Item icon="↑" label="Extrude" onClick={doExtrude} />
          <Item icon="↻" label="Revolve" onClick={doRevolve} />
        </>
      )}
    </div>
  );
};

// ─── Icon / colour maps ───────────────────────────────────────────────────────

const NODE_ICON: Partial<Record<NodeType, string>> = {
  sketch: '✦', sketch_wire: '╱',
  extrusion: '↑', revolve: '↻', loft: '⊿', sweep: '⌇', compound: '◈',
};

const NODE_COLOR: Partial<Record<NodeType, string>> = {
  sketch: '#ff9900', sketch_wire: '#ffcc00',
  extrusion: '#aa44cc', revolve: '#cc4488', loft: '#cc8844', sweep: '#44bbcc', compound: '#888888',
};
