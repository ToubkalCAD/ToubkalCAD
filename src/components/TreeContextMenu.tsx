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
import { useCADStore } from '../store/cadStore';
import type { NodeType } from '../store/cadStore';
import { show3DOpPanel, createAndEditOp } from './Op3DPanel';
import type { Op3DType } from './Op3DPanel';
import { showBlendPanel }      from './BlendActionPanel';
import { editPrimitive, primitiveKind } from '../utils/editPrimitive';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { resolveProfileWire, resolveAllProfileWires, canResolveProfile, sketchRegionCount } from '../utils/sketchProfile';
import { isAssemblyComponentData } from '../assembly/types';
import { showAssemblyInsertPartDialog, showAssemblyReplacePartDialog } from './AssemblyInsertPartDialog';

// Node types whose right-click triggers re-edit
const REEDITABLE_OP = new Set<NodeType>(['extrusion', 'revolve', 'loft', 'sweep', 'compound']);

// Node types that are 3D solids — eligible for per-edge fillet/chamfer
const SOLID_TYPES = new Set<NodeType>([
  'box', 'cylinder', 'sphere', 'extrusion', 'revolve', 'sweep', 'loft', 'boolean_operation', 'compound',
]);

// ─── Context menu ─────────────────────────────────────────────────────────────

export const TreeContextMenu: React.FC = () => {
  const menu         = useCADStore((s) => s.treeContextMenu);
  const nodes        = useCADStore((s) => s.nodes);
  const selectedIds  = useCADStore((s) => s.selectedIds);
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
  const isBlendResult     = node.type === 'compound' && !!node.params?.blendOp;
  const isBooleanResult   = node.type === 'boolean_operation' && !!node.params?.boolOp;
  const isOp3D            = !isBlendResult && REEDITABLE_OP.has(node.type) && !!node.params?.opType;
  const hasShape          = SOLID_TYPES.has(node.type) && !!CADGeometryRegistry.getInstance().getShape(menu.nodeId);
  const isSolid           = hasShape; // eligible for per-edge fillet/chamfer + boolean
  const isPrimitive       = !!primitiveKind(node); // box/cylinder/sphere/torus/cone → editable dims
  const isDatumPlane      = node.type === 'datum_plane';
  const isAssembly        = node.type === 'assembly';
  const isComponent       = node.type === 'component';
  const isAssemblyComponent = node.type === 'assembly_component';
  const assemblyComponent = node.params?.assemblyComponent;
  const isActiveComponent = isComponent && useCADStore.getState().activeComponentId === menu.nodeId;

  // Sketch wire IDs available for 3D operations (sketch container) or just this wire
  const wireIds: string[] = isSketchWire
    ? [menu.nodeId]
    : isSketchContainer
      ? node.children.filter((id) => nodes[id]?.type === 'sketch_wire')
      : [];

  // Every node renders at least the universal Delete action below, so we no longer
  // bail for "unrecognised" types — type-specific sections are simply omitted.

  const firstWireId = wireIds[0];

  // ── Position clamped to viewport ──────────────────────────────────────────────
  const mW = 210;
  // + the universal Delete row (~32px).
  const mH = 32 + (isSketchContainer ? 260 : (isAssembly || isComponent || isAssemblyComponent ? 220 : (isOp3D || isBlendResult || isBooleanResult ? 180 : 150)));
  const x  = menu.x + mW > window.innerWidth  ? menu.x - mW : menu.x;
  const y  = menu.y + mH > window.innerHeight ? menu.y - mH : menu.y;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  // Create solid immediately (appears in tree) then open panel in EDIT mode.
  const doExtrude = () => {
    closeMenu();
    if (isSketchContainer) {
      // One region → bind to the SKETCH so it re-derives on edit; several regions →
      // Multi-Pad: one region wire per enclosed region (kept as before).
      if (sketchRegionCount(menu.nodeId) > 1) {
        const ids = resolveAllProfileWires(menu.nodeId, wireIds);
        if (!ids.length) { useCADStore.getState().log('This sketch has no closed region to extrude.', 'warn'); return; }
        createAndEditOp('extrude', ids);
        return;
      }
      if (!canResolveProfile(window.oc, menu.nodeId)) { useCADStore.getState().log('This sketch has no closed region to extrude.', 'warn'); return; }
      createAndEditOp('extrude', [menu.nodeId]);
      return;
    }
    if (!firstWireId) return;
    createAndEditOp('extrude', [firstWireId]);
  };

  const doRevolve = () => {
    closeMenu();
    if (isSketchContainer) {
      if (!canResolveProfile(window.oc, menu.nodeId)) { useCADStore.getState().log('This sketch has no closed region to revolve.', 'warn'); return; }
      createAndEditOp('revolve', [menu.nodeId]);  // bind to the sketch (re-derive on edit)
      return;
    }
    if (!firstWireId) return;
    createAndEditOp('revolve', [firstWireId]);
  };

  const doLoft = () => {
    if (wireIds.length < 2) return;
    closeMenu();
    createAndEditOp('loft', wireIds);
  };

  // Loft across the CURRENT multi-selection — each selected sketch/sketch-wire is
  // one profile (a sketch container resolves to its profile wire). The right-
  // clicked node is folded in even if it wasn't part of the selection. This is
  // what lets the user loft two separate sketches (the common case).
  const loftSelOrder = selectedIds.includes(menu.nodeId)
    ? selectedIds
    : [...selectedIds, menu.nodeId];
  const loftProfileNodeIds = loftSelOrder.filter((id) => {
    const t = nodes[id]?.type;
    if (t === 'sketch_wire') return true;
    if (t === 'sketch') return Object.values(nodes).some(
      (n) => n.parentId === id && n.type === 'sketch_wire');
    return false;
  });
  const canLoftSelection = loftProfileNodeIds.length >= 2;

  const doLoftSelection = () => {
    closeMenu();
    const all = useCADStore.getState().nodes;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of loftProfileNodeIds) {
      const n = all[id];
      if (!n) continue;
      let wid: string | null = null;
      if (n.type === 'sketch_wire') {
        wid = id;
      } else if (n.type === 'sketch') {
        const childIds = Object.values(all)
          .filter((c) => c.parentId === id && c.type === 'sketch_wire')
          .map((c) => c.id);
        wid = resolveProfileWire(id, childIds);
      }
      if (wid && !seen.has(wid)) { seen.add(wid); out.push(wid); }
    }
    if (out.length < 2) { useCADStore.getState().log('Need ≥ 2 closed profiles to loft.', 'warn'); return; }
    createAndEditOp('loft', out);
  };
  const doReEdit  = () => {
    closeMenu();
    const opType  = node.params?.opType as Op3DType;
    const wIds    = node.params?.targetWireIds as string[] | undefined ?? [];
    show3DOpPanel(opType, wIds, menu.nodeId);
  };

  // Start a sketch on a datum plane (D9) — reuses startSketchSession.
  const doSketchOnDatum = () => {
    closeMenu();
    const wp = node.params?.workplane;
    if (!wp) { useCADStore.getState().log('Datum plane has no workplane.', 'error'); return; }
    const st = useCADStore.getState();
    if (st.sketchSession) { st.log('Quit the current sketch before starting a new one.', 'warn'); return; }
    st.startSketchSession(wp);
    st.setInteractionMode('SELECT');      // no tool pre-selected — user picks a 2D shape
    st.log(`Sketching on ${node.name} — pick a 2D tool to draw.`, 'success');
  };

  // Per-edge fillet / chamfer on a solid → opens BlendActionPanel
  const doEditPrimitive = () => { closeMenu(); void editPrimitive(menu.nodeId); };

  const doFilletEdges  = () => { closeMenu(); showBlendPanel(menu.nodeId, 'fillet'); };
  const doChamferEdges = () => { closeMenu(); showBlendPanel(menu.nodeId, 'chamfer'); };

  // Boolean with this solid as the base → opens BooleanActionPanel (pick tools next)
  const doBoolean = (op: 'CUT' | 'FUSE' | 'COMMON') => {
    closeMenu();
    useCADStore.getState().openBooleanPanel(op, undefined, menu.nodeId, []);
  };

  // Re-edit an existing boolean result (re-enters base/tool picking)
  const doReEditBoolean = () => {
    closeMenu();
    const boolOp = node.params?.boolOp as 'CUT' | 'FUSE' | 'COMMON';
    const base   = node.params?.baseId as string | undefined;
    const tools  = node.params?.toolIds as string[] | undefined ?? [];
    if (!base) { useCADStore.getState().log('Boolean inputs missing — cannot re-edit.', 'error'); return; }
    useCADStore.getState().openBooleanPanel(boolOp, menu.nodeId, base, tools);
  };

  // Re-edit an existing blend result (re-enters edge selection with stored edges)
  const doReEditBlend = () => {
    closeMenu();
    const blendOp = node.params?.blendOp as 'fillet' | 'chamfer';
    const sourceId = node.params?.sourceId as string | undefined;
    const edges    = node.params?.edgeIndices as number[] | undefined ?? [];
    if (!sourceId) { useCADStore.getState().log('Blend source missing — cannot re-edit.', 'error'); return; }
    useCADStore.getState().openBlendPanel(sourceId, blendOp, menu.nodeId, edges);
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

      {/* ── Blend result: Re-edit fillet/chamfer ──────────────────────────── */}
      {isBlendResult && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="✏️" label="Re-edit blend" accent="#cc6600" onClick={doReEditBlend} />
        </div>
      )}

      {/* ── Boolean result: Re-edit ───────────────────────────────────────── */}
      {isBooleanResult && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="✏️" label="Re-edit boolean" accent="#cc6600" onClick={doReEditBoolean} />
        </div>
      )}

      {/* ── Assembly: nest components / sub-assemblies ───────────────────────── */}
      {isAssembly && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="＋" label="Insert Part…" accent="#4f8fd8"
            onClick={() => { closeMenu(); showAssemblyInsertPartDialog(menu.nodeId); }} />
          <Item icon="◰" label="Create Part in Assembly" accent="#6e7681"
            onClick={() => {
              closeMenu();
              const created = useCADStore.getState().createPartInAssembly(menu.nodeId);
              if (created) useCADStore.getState().setSelectedIds([created.componentId]);
            }} />
          <Item icon="▤" label="New Sub-Assembly" accent="#9aa0a6"
            onClick={() => { closeMenu(); const id = useCADStore.getState().createAssembly(undefined, menu.nodeId); useCADStore.getState().setSelectedIds([id]); }} />
        </div>
      )}

      {isAssemblyComponent && isAssemblyComponentData(assemblyComponent) && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="◎" label="Activate" accent="#4f8fd8"
            onClick={() => { closeMenu(); useCADStore.getState().activateAssemblyComponent(menu.nodeId); }} />
          <Item icon="◉" label="Isolate" accent="#4f8fd8"
            onClick={() => { closeMenu(); useCADStore.getState().isolateAssemblyComponent(menu.nodeId); }} />
          <Item icon="⧉" label="Duplicate" accent="#4f8fd8"
            onClick={() => { closeMenu(); useCADStore.getState().duplicateAssemblyComponent(menu.nodeId); }} />
          <Item icon="↺" label="Replace…" accent="#4f8fd8"
            onClick={() => { closeMenu(); showAssemblyReplacePartDialog(assemblyComponent.assemblyId, menu.nodeId); }} />
          <Item icon="⊘" label={assemblyComponent.suppressed ? 'Unsuppress' : 'Suppress'} accent="#d28b26"
            onClick={() => { closeMenu(); useCADStore.getState().setAssemblyComponentSuppressed(menu.nodeId, !assemblyComponent.suppressed); }} />
          <Item icon="⌖" label={assemblyComponent.fixed ? 'Float' : 'Fix'} accent="#6e7681"
            onClick={() => { closeMenu(); useCADStore.getState().setAssemblyComponentFixed(menu.nodeId, !assemblyComponent.fixed); }} />
        </div>
      )}

      {/* ── Component: make it the target for new features ────────────────────── */}
      {isComponent && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="◎" label={isActiveComponent ? 'Active component ✓' : 'Set as active'} accent="#6e7681"
            onClick={() => { closeMenu(); useCADStore.getState().setActiveComponent(menu.nodeId); }} />
        </div>
      )}

      {/* ── Primitive: edit dimensions (rebuilds + propagates downstream) ──── */}
      {isPrimitive && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="✏️" label="Edit dimensions…" accent="#cc6600" onClick={doEditPrimitive} />
        </div>
      )}

      {/* ── Solid: per-edge Fillet / Chamfer + Boolean ────────────────────── */}
      {isSolid && (
        <>
          {(isOp3D || isBlendResult || isBooleanResult || isPrimitive) && <Sep />}
          <div style={{ padding: '2px 12px 3px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Modify Edges
          </div>
          <Item icon="⌒" label="Fillet edges…"  accent="#3399dd" onClick={doFilletEdges} />
          <Item icon="⌐" label="Chamfer edges…" accent="#cc7733" onClick={doChamferEdges} />
          <Sep />
          <div style={{ padding: '2px 12px 3px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Boolean (this = base)
          </div>
          <Item icon="⊕" label="Union with…"     accent="#339944" onClick={() => doBoolean('FUSE')} />
          <Item icon="⊖" label="Subtract tools…" accent="#993333" onClick={() => doBoolean('CUT')} />
          <Item icon="⊗" label="Intersect with…" accent="#997733" onClick={() => doBoolean('COMMON')} />
        </>
      )}

      {/* ── Sketch container: Resume + 3D ops ────────────────────────────── */}
      {isSketchContainer && (
        <>
          <div style={{ padding: '3px 0 1px' }}>
            <Item icon="✦" label="Resume Sketch" onClick={() => { closeMenu(); resumeSketch(menu.nodeId); }} />
            <Item icon="⟂" label="Edit constraints…" accent="#1d9e74"
              onClick={() => { closeMenu(); useCADStore.getState().openConstraintPanel(menu.nodeId); }} />
          </div>
          {wireIds.length > 0 && (
            <>
              <Sep />
              <div style={{ padding: '2px 12px 3px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                Create 3D Solid
              </div>
              <Item icon="↑" label="Extrude" sub={wireIds.length > 1 ? '1st wire' : undefined} onClick={doExtrude} />
              <Item icon="↻" label="Revolve" sub={wireIds.length > 1 ? '1st wire' : undefined} onClick={doRevolve} />
              {canLoftSelection
                ? <Item icon="⊿" label="Loft" sub={`${loftProfileNodeIds.length} profiles`} onClick={doLoftSelection} />
                : wireIds.length >= 2 && <Item icon="⊿" label="Loft" sub={`${wireIds.length} wires`} onClick={doLoft} />}
            </>
          )}
          {wireIds.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No wires yet — resume sketch to draw.
            </div>
          )}
        </>
      )}

      {/* ── Datum plane: Create Sketch (D9) ───────────────────────────────── */}
      {isDatumPlane && (
        <div style={{ padding: '3px 0 1px' }}>
          <Item icon="✦" label="Create Sketch" accent="#f0a30a" onClick={doSketchOnDatum} />
        </div>
      )}

      {/* ── Sketch wire: 3D ops ───────────────────────────────────────────── */}
      {isSketchWire && (
        <>
          <div style={{ padding: '2px 12px 3px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Create 3D Solid
          </div>
          <Item icon="↑" label="Extrude" onClick={doExtrude} />
          <Item icon="↻" label="Revolve" onClick={doRevolve} />
          {canLoftSelection && (
            <Item icon="⊿" label="Loft" sub={`${loftProfileNodeIds.length} profiles`} onClick={doLoftSelection} />
          )}
        </>
      )}

      {/* ── Delete (every node) — recursive for containers; undoable ───────────── */}
      <Sep />
      <Item icon="✕" label="Delete" accent="#c2453f"
        sub={node.children.length ? `+ ${node.children.length} inside` : undefined}
        onClick={() => { closeMenu(); useCADStore.getState().deleteNode(menu.nodeId); }} />
    </div>
  );
};

// ─── Icon / colour maps ───────────────────────────────────────────────────────

const NODE_ICON: Partial<Record<NodeType, string>> = {
  assembly: '▤', component: '◰', assembly_component: '◆',
  sketch: '✦', sketch_wire: '╱',
  extrusion: '↑', revolve: '↻', loft: '⊿', sweep: '⌇', compound: '◈',
  box: '◻', cylinder: '⬡', sphere: '●', boolean_operation: '⊕',
  datum_plane: '▱',
};

const NODE_COLOR: Partial<Record<NodeType, string>> = {
  assembly: '#9aa0a6', component: '#6e7681', assembly_component: '#4f8fd8',
  sketch: '#ff9900', sketch_wire: '#ffcc00',
  extrusion: '#aa44cc', revolve: '#cc4488', loft: '#cc8844', sweep: '#44bbcc', compound: '#888888',
  box: '#5588cc', cylinder: '#44aa66', sphere: '#cc6644', boolean_operation: '#ccaa22',
  datum_plane: '#f0a30a',
};
