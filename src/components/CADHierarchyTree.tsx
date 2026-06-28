// ============================================================
// ToubkalCAD – CADHierarchyTree.tsx
// Scene model tree with inline rename, visibility, lock,
// duplicate, and delete (inline confirmation — no browser dialog).
// ============================================================

import React, { useState, useRef, useEffect } from 'react';
import { useCADStore, CADNode, NodeType, canReparent } from '../store/cadStore';
import { show3DOpPanel } from './Op3DPanel';
import type { Op3DType } from './Op3DPanel';
import { editPrimitive, primitiveKind } from '../utils/editPrimitive';

// The node currently being dragged in the tree. Kept out-of-band (HTML5 DnD only
// exposes dataTransfer payloads on drop, not during dragover) so we can compute
// drop validity for the live highlight. Cleared on dragend/drop.
let draggedNodeId: string | null = null;

// Node types that MAY be re-editable via Op3DPanel (confirmed by node.params?.opType)
// Note: fillet/chamfer produce 'compound' nodes, so 'compound' is included.
const REEDITABLE = new Set<NodeType>(['extrusion', 'revolve', 'loft', 'sweep', 'compound']);

// 3D solids eligible for the right-click context menu (fillet/chamfer + re-edit)
const SOLID_TYPES = new Set<NodeType>([
  'box', 'cylinder', 'sphere', 'extrusion', 'revolve', 'sweep', 'loft', 'boolean_operation', 'compound',
  'mirror', 'pattern',
]);

const NODE_ICONS: Record<NodeType, string> = {
  assembly:          '▤',
  component:         '◰',
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
  surface_extrude:   '▭',
  surface_patch:     '▭',
  surface_stitch:    '⧉',
  surface_thicken:   '⬚',
  surface_trim:      '▭',
  surface_extend:    '▭',
  surface_blend:     '⌒',
  surface_solidify:  '◆',
  mirror:            '◫',
  pattern:           '▦',
  datum_plane:       '▱',
  datum_axis:        '⟋',
  datum_point:       '•',
};

const NODE_COLORS: Record<NodeType, string> = {
  assembly:          '#9aa0a6',
  component:         '#6e7681',
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
  surface_extrude:   '#e0a32e',
  surface_patch:     '#e0a32e',
  surface_stitch:    '#4aa58a',
  surface_thicken:   '#5fa9d6',
  surface_trim:      '#e0a32e',
  surface_extend:    '#e0a32e',
  surface_blend:     '#e0a32e',
  surface_solidify:  '#6a9a3a',
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
  const moveNode           = useCADStore((s) => s.moveNode);

  const [isEditing,  setIsEditing]  = useState(false);
  const [editValue,  setEditValue]  = useState('');
  const [collapsed,  setCollapsed]  = useState(false);
  // Drop feedback: 'into' = drop as child (outline), 'before'/'after' = insertion
  // line above/below this row for reordering among siblings. ok = passes validation.
  const [dropMode,   setDropMode]   = useState<{ pos: 'into' | 'before' | 'after'; ok: boolean } | null>(null);
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
  // Surface bodies read consistently regardless of the op that made them (e.g. a
  // surface loft uses the 'loft' type): amber + a sheet glyph, matching the viewport.
  const isSurface    = node.bodyType === 'surface';
  const color        = isSurface ? '#e0a32e' : (NODE_COLORS[node.type] ?? 'var(--text-dim)');
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

  // ── Drag-and-drop reparenting (wired to the validated reparentNode) ──────────
  const onDragStart = (e: React.DragEvent) => {
    if (isEditing) { e.preventDefault(); return; }
    draggedNodeId = nodeId;
    e.dataTransfer.setData('text/plain', nodeId);
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  };
  const onDragEnd = () => { draggedNodeId = null; setDropMode(null); };

  // Resolve where a drag over this row would land, from the cursor's vertical
  // position. Can this row accept the dragged node as a CHILD? Only then is the
  // middle band an "into" drop; the top/bottom edges always mean reorder (insert
  // before/after this row, i.e. as a sibling under THIS row's parent).
  const computeDrop = (e: React.DragEvent, src: string | null): { pos: 'into' | 'before' | 'after'; ok: boolean } | null => {
    if (!src || src === nodeId) return null;
    const ns = useCADStore.getState().nodes;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / Math.max(1, rect.height);
    const canInto = canReparent(ns, src, nodeId) === null;
    const pos = canInto && rel > 0.3 && rel < 0.7 ? 'into' : rel < 0.5 ? 'before' : 'after';
    const ok = pos === 'into' ? canInto : canReparent(ns, src, node.parentId) === null;
    return { pos, ok };
  };

  const onDragOver = (e: React.DragEvent) => {
    const d = computeDrop(e, draggedNodeId);
    if (!d) return;
    e.preventDefault();                       // required so onDrop fires
    e.stopPropagation();
    e.dataTransfer.dropEffect = d.ok ? 'move' : 'none';
    setDropMode(d);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;  // moving within the row
    setDropMode(null);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const src = draggedNodeId ?? e.dataTransfer.getData('text/plain');
    const d = computeDrop(e, src);             // recompute from the drop point (not stale state)
    setDropMode(null);
    draggedNodeId = null;
    if (!src || !d) return;
    if (d.pos === 'into') {
      moveNode(src, nodeId, null);                              // append as last child
    } else {
      const st = useCADStore.getState();
      const siblings = node.parentId ? (st.nodes[node.parentId]?.children ?? []) : st.rootIds;
      const idx = siblings.indexOf(nodeId);
      const beforeId = d.pos === 'before' ? nodeId : (siblings[idx + 1] ?? null);
      moveNode(src, node.parentId, beforeId);                   // logs reason if rejected
    }
  };

  return (
    <div>
      <div
        draggable={!isEditing}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
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
          } else if (primitiveKind(node)) {
            // Re-edit a primitive's dimensions → rebuilds it + propagates downstream
            e.stopPropagation();
            void editPrimitive(nodeId);
          } else {
            setIsEditing(true);
          }
        }}
        onContextMenu={(e) => {
          // Every node gets a menu — at minimum the universal Delete; sketches,
          // solids, ops, datums and containers add their type-specific actions.
          e.preventDefault();
          e.stopPropagation();
          // Preserve an existing multi-selection when right-clicking one of its
          // members (so e.g. Loft across selected sketches is offered); only
          // collapse to this node when it wasn't already selected.
          if (!selectedIds.includes(nodeId)) setSelectedIds([nodeId]);
          openContextMenu(nodeId, e.clientX, e.clientY);
        }}
        title={
          REEDITABLE.has(node.type) && node.params?.opType
            ? 'Double-click to re-edit this operation'
            : node.type === 'sketch'
            ? 'Double-click to resume · Right-click for 3D ops'
            : primitiveKind(node)
            ? 'Double-click to edit dimensions'
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
          // Drop feedback: 'into' = outline + tint; 'before'/'after' = a 2px
          // insertion line at the top/bottom edge (inset shadow → no layout shift).
          // Green = valid, red = rejected.
          ...(dropMode && (dropMode.pos === 'into'
            ? {
                outline: `1.5px solid ${dropMode.ok ? '#2f9e54' : '#c2453f'}`,
                outlineOffset: '-1.5px',
                background: dropMode.ok ? 'rgba(47,158,84,0.14)' : 'rgba(194,69,63,0.12)',
              }
            : {
                boxShadow: `inset 0 ${dropMode.pos === 'before' ? 2 : -2}px 0 0 ${dropMode.ok ? '#2f9e54' : '#c2453f'}`,
              })),
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
          {isSurface ? '▭' : (NODE_ICONS[node.type] ?? '▪')}
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
  const reparentNode = useCADStore((s) => s.reparentNode);
  const count   = Object.keys(nodes).length;
  const [rootHint, setRootHint] = useState<boolean>(false);

  // Empty-space drop → move to root (only structural nodes pass reparent validation).
  const onRootDragOver = (e: React.DragEvent) => {
    if (!draggedNodeId) return;
    e.preventDefault();
    const ok = canReparent(useCADStore.getState().nodes, draggedNodeId, null) === null;
    e.dataTransfer.dropEffect = ok ? 'move' : 'none';
    setRootHint(ok);
  };
  const onRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const src = draggedNodeId ?? e.dataTransfer.getData('text/plain');
    draggedNodeId = null;
    setRootHint(false);
    if (src) reparentNode(src, null);
  };

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

      {/* Scrollable tree (also the empty-space drop zone → move to root) */}
      <div
        style={{
          flex: 1, overflowY: 'auto', padding: '2px 0',
          outline: rootHint ? '1.5px dashed #2f9e54' : 'none', outlineOffset: '-3px',
        }}
        onDragOver={onRootDragOver}
        onDragLeave={() => setRootHint(false)}
        onDrop={onRootDrop}
      >
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
