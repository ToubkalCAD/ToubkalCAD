// ============================================================
// ToubkalCAD – cadStore.ts
// Global application state: scene graph, selection, history,
// materials, measurements, logs, interaction modes.
// ============================================================

import { create } from 'zustand';

// ─── Public types ─────────────────────────────────────────────────────────────

export type NodeType =
  | 'box' | 'cylinder' | 'sphere'
  | 'extrusion' | 'boolean_operation' | 'compound'
  | 'sketch_wire'
  | 'revolve' | 'sweep' | 'loft';

// ─── Workplane ────────────────────────────────────────────────────────────────

export interface Workplane {
  label:  string;                       // 'XY' | 'YZ' | 'ZX' | 'Custom'
  origin: [number, number, number];     // world-space origin
  normal: [number, number, number];     // unit outward normal
  uAxis:  [number, number, number];     // first tangent (unit)
  vAxis:  [number, number, number];     // second tangent (unit)
}

export const STANDARD_WORKPLANES: Record<string, Workplane> = {
  XY: { label:'XY', origin:[0,0,0], normal:[0,0,1], uAxis:[1,0,0], vAxis:[0,1,0] },
  YZ: { label:'YZ', origin:[0,0,0], normal:[1,0,0], uAxis:[0,1,0], vAxis:[0,0,1] },
  ZX: { label:'ZX', origin:[0,0,0], normal:[0,1,0], uAxis:[1,0,0], vAxis:[0,0,1] },
};

export const DEFAULT_WORKPLANE: Workplane = STANDARD_WORKPLANES.ZX;

export type InteractionMode =
  | 'SELECT'
  | 'SKETCH_LINE'
  | 'SKETCH_CIRCLE'
  | 'SKETCH_RECTANGLE'
  | 'SKETCH_ARC'
  | 'SKETCH_ARC_3P'
  | 'SKETCH_ELLIPSE'
  | 'SKETCH_BEZIER'
  | 'SKETCH_SPLINE'
  | 'SKETCH_ROUNDED_RECT'
  | 'SKETCH_POLYGON'
  | 'MEASURE_DISTANCE';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface CADMaterial {
  color:       number;    // hex e.g. 0x5588cc
  roughness:   number;    // 0–1
  metalness:   number;    // 0–1
  wireframe:   boolean;
  opacity:     number;    // 0–1
  transparent: boolean;
}

export interface CADNode {
  id:       string;
  name:     string;
  type:     NodeType;
  visible:  boolean;
  locked:   boolean;
  parentId: string | null;
  children: string[];
  transform: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale:    [number, number, number];
  };
  material: CADMaterial;
  notes:    string;
  /** Type-specific metadata — sketch_wire nodes store their workplane here. */
  params?: Record<string, any>;
}

export interface CADMeasurement {
  id:     string;
  label:  string;
  type:   'distance' | 'angle' | 'area';
  pointA: [number, number, number];
  pointB: [number, number, number];
  value:  number;
}

export interface LogEntry {
  id:        string;
  timestamp: number;
  level:     'info' | 'warn' | 'error' | 'success';
  message:   string;
}

interface CADAction {
  type:        'ADD' | 'DELETE' | 'TRANSFORM' | 'RENAME' | 'MATERIAL';
  description: string;
  nodesBefore: CADNode[];
  nodesAfter:  CADNode[];
}

// ─── Full state interface ─────────────────────────────────────────────────────

interface CADState {
  nodes:    Record<string, CADNode>;
  rootIds:  string[];

  selectedIds: string[];

  past:   CADAction[];
  future: CADAction[];

  interactionMode: InteractionMode;
  gizmoMode:       GizmoMode;

  measurements: CADMeasurement[];

  logs: LogEntry[];

  isProcessing:    boolean;
  processingLabel: string;

  snapEnabled: boolean;
  snapStep:    number;

  sketchPolygonSides: number;

  activeWorkplane:    Workplane;
  planeSelectorOpen:  boolean;
  pendingSketchMode:  InteractionMode | null;

  // ── Actions ────────────────────────────────────────────────────────────────

  addNode:            (node: Omit<CADNode, 'children'>) => void;
  deleteNode:         (id: string) => void;
  duplicateNode:      (id: string) => string;
  renameNode:         (id: string, name: string) => void;
  /** Commit a transform — pushes to undo history. Use for drag-end / panel edits. */
  updateTransform:    (id: string, position: [number,number,number], rotation: [number,number,number], scale?: [number,number,number]) => void;
  /** Live update during drag — does NOT push to undo history. */
  setTransformLive:   (id: string, position: [number,number,number], rotation: [number,number,number]) => void;
  updateMaterial:     (id: string, material: Partial<CADMaterial>) => void;
  toggleVisibility:   (id: string) => void;
  toggleLock:         (id: string) => void;

  setSelectedIds:        (ids: string[]) => void;
  setInteractionMode:    (mode: InteractionMode) => void;
  setGizmoMode:          (mode: GizmoMode) => void;
  setSketchPolygonSides: (n: number) => void;
  setActiveWorkplane:    (wp: Workplane) => void;
  openPlaneSelector:     (pendingMode: InteractionMode) => void;
  closePlaneSelector:    () => void;

  addMeasurement:    (m: Omit<CADMeasurement, 'id'>) => void;
  removeMeasurement: (id: string) => void;
  clearMeasurements: () => void;

  log:       (msg: string, level?: LogEntry['level']) => void;
  clearLogs: () => void;

  setProcessing: (active: boolean, label?: string) => void;

  setSnapEnabled: (v: boolean)  => void;
  setSnapStep:    (v: number)   => void;

  undo: () => void;
  redo: () => void;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_MATERIAL: CADMaterial = {
  color:       0x5588cc,
  roughness:   0.4,
  metalness:   0.3,
  wireframe:   false,
  opacity:     1.0,
  transparent: false,
};

export const NODE_TYPE_COLORS: Record<NodeType, number> = {
  box:               0x5588cc,
  cylinder:          0x44aa66,
  sphere:            0xcc6644,
  extrusion:         0xaa44cc,
  boolean_operation: 0xccaa22,
  compound:          0x888888,
  sketch_wire:       0xffcc00,
  revolve:           0xcc4488,
  sweep:             0x44bbcc,
  loft:              0xcc8844,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId() { return crypto.randomUUID(); }

function makeLog(msg: string, level: LogEntry['level'] = 'info'): LogEntry {
  return { id: makeId(), timestamp: Date.now(), level, message: msg };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useCADStore = create<CADState>((set, get) => ({
  nodes:           {},
  rootIds:         [],
  selectedIds:     [],
  past:            [],
  future:          [],
  interactionMode: 'SELECT',
  gizmoMode:       'translate',
  measurements:    [],
  logs:            [makeLog('ToubkalCAD ready — WASM kernel loaded.', 'success')],
  isProcessing:       false,
  processingLabel:    '',
  snapEnabled:        true,
  snapStep:           1.0,
  sketchPolygonSides: 5,
  activeWorkplane:    DEFAULT_WORKPLANE,
  planeSelectorOpen:  false,
  pendingSketchMode:  null,

  // ── Logging ────────────────────────────────────────────────────────────────
  log: (msg, level = 'info') =>
    set((s) => ({ logs: [...s.logs.slice(-199), makeLog(msg, level)] })),

  clearLogs: () => set({ logs: [] }),

  // ── Processing state ───────────────────────────────────────────────────────
  setProcessing: (active, label = '') =>
    set({ isProcessing: active, processingLabel: label }),

  // ── Modes ──────────────────────────────────────────────────────────────────
  setSelectedIds:        (ids)  => set({ selectedIds: ids }),
  setInteractionMode:    (mode) => set({ interactionMode: mode }),
  setGizmoMode:          (mode) => set({ gizmoMode: mode }),
  setSnapEnabled:        (v)    => set({ snapEnabled: v }),
  setSnapStep:           (v)    => set({ snapStep: v }),
  setSketchPolygonSides: (n)    => set({ sketchPolygonSides: n }),
  setActiveWorkplane:    (wp)   => set({ activeWorkplane: wp }),
  openPlaneSelector:     (mode) => set({ planeSelectorOpen: true, pendingSketchMode: mode }),
  closePlaneSelector:    ()     => set({ planeSelectorOpen: false, pendingSketchMode: null }),

  // ── Nodes ──────────────────────────────────────────────────────────────────

  addNode: (nodeData) => {
    const { nodes, rootIds } = get();
    const newNode: CADNode = { ...nodeData, children: [] };
    const updatedNodes = { ...nodes, [newNode.id]: newNode };
    const updatedRootIds = [...rootIds];

    if (newNode.parentId && updatedNodes[newNode.parentId]) {
      updatedNodes[newNode.parentId] = {
        ...updatedNodes[newNode.parentId],
        children: [...updatedNodes[newNode.parentId].children, newNode.id],
      };
    } else {
      updatedRootIds.push(newNode.id);
    }

    const action: CADAction = {
      type: 'ADD', description: `Add "${newNode.name}"`,
      nodesBefore: Object.values(nodes),
      nodesAfter:  Object.values(updatedNodes),
    };
    set({ nodes: updatedNodes, rootIds: updatedRootIds,
          past: [...get().past, action], future: [] });
    get().log(`Created: ${newNode.name} (${newNode.type})`, 'success');
  },

  deleteNode: (id) => {
    const { nodes, rootIds } = get();
    if (!nodes[id]) return;

    const nodesBefore  = Object.values(nodes);
    const updatedNodes = { ...nodes };
    const deletedIds:  string[] = [];

    const removeRecursive = (targetId: string) => {
      const node = updatedNodes[targetId];
      if (!node) return;
      node.children.forEach((cid) => removeRecursive(cid));
      deletedIds.push(targetId);
      delete updatedNodes[targetId];
    };

    const parentId    = nodes[id].parentId;
    const deletedName = nodes[id].name;
    removeRecursive(id);

    const updatedRootIds = rootIds.filter((r) => r !== id);
    if (parentId && updatedNodes[parentId]) {
      updatedNodes[parentId] = {
        ...updatedNodes[parentId],
        children: updatedNodes[parentId].children.filter((c) => c !== id),
      };
    }

    set({
      nodes: updatedNodes, rootIds: updatedRootIds,
      selectedIds: get().selectedIds.filter((s) => s !== id),
      past: [...get().past, {
        type: 'DELETE', description: `Delete "${deletedName}"`,
        nodesBefore, nodesAfter: Object.values(updatedNodes),
      }],
      future: [],
    });

    // Notify the viewport to remove all deleted Three.js objects
    deletedIds.forEach((did) =>
      window.dispatchEvent(new CustomEvent('cad-remove-mesh', { detail: { id: did } }))
    );

    get().log(`Deleted: ${deletedName}`, 'warn');
  },

  duplicateNode: (id) => {
    const { nodes } = get();
    const source = nodes[id];
    if (!source) return id;

    const newId   = makeId();
    const newNode: Omit<CADNode, 'children'> = {
      ...JSON.parse(JSON.stringify(source)),
      id:    newId,
      name:  `${source.name} (copy)`,
      transform: {
        ...source.transform,
        position: [
          source.transform.position[0] + 5,
          source.transform.position[1],
          source.transform.position[2] + 5,
        ] as [number, number, number],
      },
    };
    get().addNode(newNode);
    return newId;
  },

  renameNode: (id, name) => {
    const { nodes } = get();
    if (!nodes[id]) return;
    const nodesBefore  = Object.values(nodes);
    const updatedNodes = { ...nodes, [id]: { ...nodes[id], name } };
    set({
      nodes: updatedNodes,
      past: [...get().past, {
        type: 'RENAME', description: `Rename → "${name}"`,
        nodesBefore, nodesAfter: Object.values(updatedNodes),
      }],
      future: [],
    });
  },

  // Commits a final transform to undo history (drag-end, panel input)
  updateTransform: (id, position, rotation, scale) => {
    const { nodes } = get();
    if (!nodes[id]) return;
    const nodesBefore  = JSON.parse(JSON.stringify(Object.values(nodes)));
    const updatedNodes = {
      ...nodes,
      [id]: {
        ...nodes[id],
        transform: { position, rotation, scale: scale ?? nodes[id].transform.scale },
      },
    };
    set({
      nodes: updatedNodes,
      past:  [...get().past, {
        type: 'TRANSFORM', description: 'Transform',
        nodesBefore, nodesAfter: Object.values(updatedNodes),
      }],
      future: [],
    });
  },

  // Updates transform in real-time during drag — no undo entry
  setTransformLive: (id, position, rotation) => {
    const { nodes } = get();
    if (!nodes[id]) return;
    set({
      nodes: {
        ...nodes,
        [id]: {
          ...nodes[id],
          transform: { ...nodes[id].transform, position, rotation },
        },
      },
    });
  },

  updateMaterial: (id, partial) => {
    const { nodes } = get();
    if (!nodes[id]) return;
    const nodesBefore  = Object.values(nodes);
    const updatedNodes = {
      ...nodes,
      [id]: { ...nodes[id], material: { ...nodes[id].material, ...partial } },
    };
    set({
      nodes: updatedNodes,
      past:  [...get().past, {
        type: 'MATERIAL', description: 'Change material',
        nodesBefore, nodesAfter: Object.values(updatedNodes),
      }],
      future: [],
    });
    get().log(`Material updated: ${nodes[id].name}`, 'info');
  },

  toggleVisibility: (id) => {
    const { nodes } = get();
    if (!nodes[id]) return;
    const visible = !nodes[id].visible;
    set({ nodes: { ...nodes, [id]: { ...nodes[id], visible } } });
    window.dispatchEvent(new CustomEvent('cad-visibility-changed', { detail: { id, visible } }));
  },

  toggleLock: (id) => {
    const { nodes } = get();
    if (!nodes[id]) return;
    set({ nodes: { ...nodes, [id]: { ...nodes[id], locked: !nodes[id].locked } } });
  },

  // ── Measurements ───────────────────────────────────────────────────────────

  addMeasurement:    (m)  => set((s) => ({ measurements: [...s.measurements, { ...m, id: makeId() }] })),
  removeMeasurement: (id) => set((s) => ({ measurements: s.measurements.filter((m) => m.id !== id) })),
  clearMeasurements: ()   => set({ measurements: [] }),

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  undo: () => {
    const { past, future } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];

    const currentNodes = get().nodes;
    const restoredNodes: Record<string, CADNode> = {};
    prev.nodesBefore.forEach((n) => { restoredNodes[n.id] = n; });

    // Compute scene diff so the Viewport stays in sync
    const added   = Object.keys(restoredNodes).filter((id) => !currentNodes[id]);
    const removed = Object.keys(currentNodes).filter((id) => !restoredNodes[id]);

    set({
      nodes:       restoredNodes,
      rootIds:     prev.nodesBefore.filter((n) => !n.parentId).map((n) => n.id),
      selectedIds: [],
      past:        past.slice(0, -1),
      future:      [prev, ...future],
    });

    // Sync 3D scene (best-effort — OCC shapes that were deleted won't re-appear)
    removed.forEach((id) =>
      window.dispatchEvent(new CustomEvent('cad-remove-mesh', { detail: { id } }))
    );
    added.forEach((id) =>
      window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }))
    );

    get().log(`Undo: ${prev.description}`, 'info');
  },

  redo: () => {
    const { past, future } = get();
    if (future.length === 0) return;
    const next = future[0];

    const currentNodes = get().nodes;
    const restoredNodes: Record<string, CADNode> = {};
    next.nodesAfter.forEach((n) => { restoredNodes[n.id] = n; });

    const added   = Object.keys(restoredNodes).filter((id) => !currentNodes[id]);
    const removed = Object.keys(currentNodes).filter((id) => !restoredNodes[id]);

    set({
      nodes:       restoredNodes,
      rootIds:     next.nodesAfter.filter((n) => !n.parentId).map((n) => n.id),
      selectedIds: [],
      past:        [...past, next],
      future:      future.slice(1),
    });

    removed.forEach((id) =>
      window.dispatchEvent(new CustomEvent('cad-remove-mesh', { detail: { id } }))
    );
    added.forEach((id) =>
      window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }))
    );

    get().log(`Redo: ${next.description}`, 'info');
  },
}));
