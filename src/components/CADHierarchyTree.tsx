// ============================================================
// ToubkalCAD – CADHierarchyTree.tsx
// Scene model tree with inline rename, visibility, lock,
// duplicate, and delete (inline confirmation — no browser dialog).
// ============================================================

import React, { useState, useRef, useEffect } from 'react';
import { useCADStore, CADNode, NodeType } from '../store/cadStore';
import { show3DOpPanel } from './Op3DPanel';
import type { Op3DType } from './Op3DPanel';

// Node types that MAY be re-editable via Op3DPanel (confirmed by node.params?.opType)
// Note: fillet/chamfer produce 'compound' nodes, so 'compound' is included.
const REEDITABLE = new Set<NodeType>(['extrusion', 'revolve', 'loft', 'sweep', 'compound']);

// 3D solids eligible for the right-click context menu (fillet/chamfer + re-edit)
const SOLID_TYPES = new Set<NodeType>([
  'box', 'cylinder', 'sphere', 'extrusion', 'revolve', 'sweep', 'loft', 'boolean_operation', 'compound',
  'mirror', 'pattern',
]);

const NODE_ICONS: Record<NodeType, string> = {
  box:               '◻',
  cylinder:          '⬡',
  sphere:            '●',
  extrusion:         '↑',
  boolean_operation: '⊕',
  compound:          '◈',
  sketch:            '✦',
  sketch_wire:       '╱',
  revolve:           '↻',
  sweep:             '⟿',
  loft:              '⊿',
  mirror:            '◫',
  pattern:           '▦',
  datum_plane:       '▱',
  datum_axis:        '⟋',
  datum_point:       '•',
};

const NODE_COLORS: Record<NodeType, string> = {
  box:               '#5588cc',
  cylinder:          '#44aa66',
  sphere:            '#cc6644',
  extrusion:         '#aa44cc',
  boolean_operation: '#ccaa22',
  compound:          '#888888',
  sketch:            '#ff9900',
  sketch_wire:       '#ffcc00',
  revolve:           '#cc4488',
  sweep:             '#44bbcc',
  loft:              '#cc8844',
  mirror:            '#4488cc',
  pattern:           '#8844cc',
  datum_plane:       '#f0a30a',
  datum_axis:        '#f0a30a',
  datum_point:       '#f0a30a',
};

// ─── Icon button ──────────────────────────────────────────────────────────────
const IconBtn: React.FC<{
  onClick:  (e: React.MouseEvent) => void;
  title?:   string;
  color?:   string;
  children: React.ReactNode;
}> = ({ onClick, title, color = 'var(--text-muted)', children }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      background: 'none', border: 'none', color, cursor: 'pointer',
      padding: '0 3px', fontSize: '11px', lineHeight: 1, opacity: 0.75,
      transition: 'opacity 0.1s',
    }}
    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.75'; }}
  >
    {children}
  </button>
);

// ─── Single tree node ─────────────────────────────────────────────────────────
const TreeNode: React.FC<{ nodeId: string; depth: number }> = ({ nodeId, depth }) => {
  const node               = useCADStore((s) => s.nodes[nodeId]);
  const selectedIds        = useCADStore((s) => s.selectedIds);
  const sketchSession      = useCADStore((s) => s.sketchSession);
  const setSelectedIds     = useCADStore((s) => s.setSelectedIds);
  const deleteNode         = useCADStore((s) => s.deleteNode);
  const renameNode         = useCADStore((s) => s.renameNode);
  const duplicateNode      = useCADStore((s) => s.duplicateNode);
  const toggleVisibility   = useCADStore((s) => s.toggleVisibility);
  const toggleLock         = useCADStore((s) => s.toggleLock);
  const resumeSketch       = useCADStore((s) => s.resumeSketchSession);
  const openContextMenu    = useCADStore((s) => s.openTreeContextMenu);
  const interactionMode    = useCADStore((s) => s.interactionMode);
  const pickBooleanSolid   = useCADStore((s) => s.pickBooleanSolid);

  const [isEditing,  setIsEditing]  = useState(false);
  const [editValue,  setEditValue]  = useState('');
  const [collapsed,  setCollapsed]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditValue(node?.name ?? '');
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 20);
    }
  }, [isEditing]);

  if (!node) return null;

  const isSelected   = selectedIds.includes(nodeId);
  const isActiveSketch = node.type === 'sketch' && sketchSession?.id === nodeId;
  const color        = NODE_COLORS[node.type] ?? 'var(--text-dim)';
  const hasChildren  = node.children.length > 0;

  const handleClick = (e: React.MouseEvent) => {
    if (isEditing) return;
    // Boolean pick mode: route tree clicks to base/tool picking so solids that
    // are hidden behind / coincident with others (un-clickable in the viewport)
    // can still be chosen. First solid = base, subsequent = tools (toggle).
    if (interactionMode === 'BOOLEAN_PICK' && SOLID_TYPES.has(node.type)) {
      e.stopPropagation();
      pickBooleanSolid(nodeId);
      return;
    }
    if (node.type === 'sketch' && hasChildren) {
      // Single-click on sketch container toggles collapse
      if (!e.ctrlKey && !e.metaKey) {
        setCollapsed((c) => !c);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(isSelected
        ? selectedIds.filter((id) => id !== nodeId)
        : [...selectedIds, nodeId]
      );
    } else {
      setSelectedIds([nodeId]);
    }
  };

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== node.name) renameNode(nodeId, trimmed);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter')  commitRename();
    if (e.key === 'Escape') setIsEditing(false);
    e.stopPropagation();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode(nodeId); // store dispatches cad-remove-mesh for all deleted IDs
  };

  return (
    <div>
      <div
        onClick={handleClick}
        onDoubleClick={(e) => {
          const opType   = node.params?.opType as Op3DType | undefined;
          const wireIds  = node.params?.targetWireIds as string[] | undefined;
          const blendOp  = node.params?.blendOp as 'fillet' | 'chamfer' | undefined;
          const sourceId = node.params?.sourceId as string | undefined;
          const boolOp   = node.params?.boolOp as import('../store/cadStore').BooleanOp | undefined;
          if (blendOp && sourceId) {
            // Re-edit a fillet/chamfer with its stored edge selection
            e.stopPropagation();
            const edges = (node.params?.edgeIndices as number[] | undefined) ?? [];
            useCADStore.getState().openBlendPanel(sourceId, blendOp, nodeId, edges);
          } else if (boolOp && node.params?.baseId) {
            // Re-edit a boolean with its stored base/tools
            e.stopPropagation();
            useCADStore.getState().openBooleanPanel(boolOp, nodeId, node.params.baseId as string, (node.params?.toolIds as string[]) ?? []);
          } else if (REEDITABLE.has(node.type) && opType && wireIds?.length) {
            // Re-edit the 3D operation with the previously stored params
            e.stopPropagation();
            show3DOpPanel(opType, wireIds, nodeId);
          } else if (node.type === 'sketch') {
            e.stopPropagation();
            resumeSketch(nodeId);
          } else {
            setIsEditing(true);
          }
        }}
        onContextMenu={(e) => {
          // Sketches, wires, and any 3D solid (for fillet/chamfer + re-edit) get a menu.
          const isSolidType = SOLID_TYPES.has(node.type);
          const isContextable = node.type === 'sketch'
            || node.type === 'sketch_wire'
            || node.type === 'datum_plane'
            || isSolidType;
          if (isContextable) {
            e.preventDefault();
            e.stopPropagation();
            setSelectedIds([nodeId]);
            openContextMenu(nodeId, e.clientX, e.clientY);
          }
        }}
        title={
          REEDITABLE.has(node.type) && node.params?.opType
            ? 'Double-click to re-edit this operation'
            : node.type === 'sketch'
            ? 'Double-click to resume · Right-click for 3D ops'
            : 'Double-click to rename'
        }
        style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          padding: '3px 6px',
          paddingLeft: `${6 + depth * 14}px`,
          cursor: 'pointer',
          background: isActiveSketch
            ? 'rgba(255,153,0,0.12)'
            : isSelected ? 'var(--sel-bg)' : 'transparent',
          borderLeft: isActiveSketch
            ? '2px solid #ff9900'
            : isSelected ? `2px solid ${color}` : '2px solid transparent',
          borderRadius: '2px',
          userSelect: 'none',
          opacity: node.visible ? 1 : 0.4,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => { if (!isSelected && !isActiveSketch) (e.currentTarget as HTMLElement).style.background = 'var(--surface-3)'; }}
        onMouseLeave={(e) => { if (!isSelected && !isActiveSketch) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        {/* Collapse toggle for sketch containers */}
        {node.type === 'sketch' ? (
          <span style={{ fontSize: '8px', color: 'var(--text-muted)', flexShrink: 0, width: '10px' }}>
            {hasChildren ? (collapsed ? '▶' : '▼') : ''}
          </span>
        ) : null}

        {/* Type icon */}
        <span style={{ fontSize: '11px', color, flexShrink: 0 }}>
          {NODE_ICONS[node.type] ?? '▪'}
        </span>

        {/* Name / edit input */}
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1, fontSize: '11px',
              background: 'var(--surface-4)',
              color: 'var(--text-primary)',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-sm)',
              padding: '1px 5px', outline: 'none',
            }}
          />
        ) : (
          <span style={{
            flex: 1, fontSize: '11px', color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {node.name}
            {node.locked && (
              <span style={{ color: 'var(--text-muted)', marginLeft: '4px', fontSize: '9px' }}>🔒</span>
            )}
          </span>
        )}

        {/* Re-editable 3D op indicator */}
        {REEDITABLE.has(node.type) && node.params?.opType && (
          <span title="Double-click to re-edit" style={{
            fontSize: '9px', color: 'var(--accent)', opacity: 0.6, flexShrink: 0,
          }}>✎</span>
        )}

        {/* Active-session indicator pill */}
        {isActiveSketch && (
          <span style={{
            fontSize: '8px', color: '#ff9900', background: 'rgba(255,153,0,0.18)',
            border: '1px solid rgba(255,153,0,0.4)',
            borderRadius: '3px', padding: '0 4px', flexShrink: 0, whiteSpace: 'nowrap',
          }}>
            ACTIVE
          </span>
        )}

        {/* Action icons */}
        <div style={{ display: 'flex', gap: '1px', flexShrink: 0 }}>
          <IconBtn
            onClick={(e) => { e.stopPropagation(); toggleVisibility(nodeId); }}
            title={node.visible ? 'Hide' : 'Show'}
          >
            {node.visible ? '◉' : '○'}
          </IconBtn>
          <IconBtn
            onClick={(e) => { e.stopPropagation(); toggleLock(nodeId); }}
            title={node.locked ? 'Unlock' : 'Lock'}
          >
            {node.locked ? '🔒' : '🔓'}
          </IconBtn>
          <IconBtn
            onClick={(e) => {
              e.stopPropagation();
              const newId = duplicateNode(nodeId);
              window.dispatchEvent(new CustomEvent('cad-duplicate-mesh', { detail: { sourceId: nodeId, newId } }));
            }}
            title="Duplicate (Ctrl+D)"
          >
            ⧉
          </IconBtn>
          <IconBtn
            color="var(--text-muted)"
            onClick={handleDelete}
            title="Delete (Ctrl+Z to undo)"
          >
            ✕
          </IconBtn>
        </div>
      </div>

      {/* Children */}
      {!collapsed && node.children.map((cid) => (
        <TreeNode key={cid} nodeId={cid} depth={depth + 1} />
      ))}
    </div>
  );
};

// ─── Full tree ────────────────────────────────────────────────────────────────
export const CADHierarchyTree: React.FC = () => {
  const rootIds = useCADStore((s) => s.rootIds);
  const nodes   = useCADStore((s) => s.nodes);
  const count   = Object.keys(nodes).length;

  return (
    <div style={{
      width: '100%', height: '100%',
      background: 'var(--surface-1)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        padding: '5px 10px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{
          fontSize: '9px', color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.8px',
        }}>
          Model Tree
        </span>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          {count} object{count !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Scrollable tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0' }}>
        {rootIds.length === 0 ? (
          <div style={{
            padding: '20px 12px',
            color: 'var(--text-muted)',
            fontSize: '11px', fontStyle: 'italic', lineHeight: '1.7',
          }}>
            Scene is empty.<br />
            Create primitives via the toolbar<br />
            or import a STEP/IGES file.
          </div>
        ) : (
          rootIds.map((id) => <TreeNode key={id} nodeId={id} depth={0} />)
        )}
      </div>
    </div>
  );
};
