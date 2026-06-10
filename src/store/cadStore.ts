// ============================================================
// ToubkalCAD – cadStore.ts
// Global application state: scene graph, selection, history,
// materials, measurements, logs, interaction modes.
// ============================================================

import { create } from 'zustand';
import { computeDatumUpdates } from '../utils/recomputeDatums';

// D13 — capture the body a datum is derived from (first ref pointing to a solid),
// so a later move of that body can rigidly recompute the datum. Datum-sourced
// refs (datum→datum) are skipped (deferred to P1).
function findDatumBind(nodes: Record<string, any>, refs: any[]): { id: string; transform: any } | undefined {
  const r = (refs || []).find(
    (x) => x && x.nodeId && nodes[x.nodeId] && !String(nodes[x.nodeId].type).startsWith('datum_'),
  );
  if (!r) return undefined;
  const t = nodes[r.nodeId].transform;
  return { id: r.nodeId, transform: { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] } };
}

// ─── Public types ─────────────────────────────────────────────────────────────

export type NodeType =
  | 'box' | 'cylinder' | 'sphere'
  | 'extrusion' | 'boolean_operation' | 'compound'
  | 'sketch' | 'sketch_wire'
  | 'revolve' | 'sweep' | 'loft'
  | 'mirror' | 'pattern'
  // Reference geometry (Track D) — carry no OCC solid; render from params.
  | 'datum_plane' | 'datum_axis' | 'datum_point';

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
  | 'MEASURE_DISTANCE'
  | 'BLEND_EDGE'
  | 'BOOLEAN_PICK'
  | 'CONSTRAIN'
  | 'FACE_SKETCH'    // picking a planar face to start a sketch on it (S2)
  | 'EDIT_TRIM'      // S1 — trim a sketch line at its intersections
  | 'EDIT_EXTEND'    // S1 — extend a sketch line to the nearest boundary
  | 'EDIT_SPLIT'     // S1 — break a sketch line at its intersections
  | 'EDIT_POWER_TRIM' // power-trim — drag a stroke; every crossed curve is trimmed at the crossing
  | 'ASSEMBLY_MATE'   // pick a reference face then a face on another solid → mate them (one-shot)
  | 'ASSEMBLY_ALIGN'  // like mate but faces parallel (same direction) with an offset
  | 'ASSEMBLY_CONCENTRIC' // pick two cylindrical faces → align their axes (peg-in-hole)
  | 'MIRROR_AXIS_PICK'    // pick 2 points on the sketch plane → mirror line for a 2D sketch mirror
  | 'ARRAY_CENTER_PICK'   // pick 1 point on the sketch plane → centre for a 2D circular array
  | 'EXTRUDE_TARGET_PICK' // pick an existing solid as the Pad/Pocket boolean target (one-shot)
  | 'DATUM_SKETCH'        // pick a datum plane in the viewport → start a sketch on it (D9)
  | 'DATUM_OFFSET_PICK'   // pick a planar face / datum → offset it by a distance into a new datum plane (D2)
  | 'DATUM_3POINT_PICK'   // pick 3 vertices → plane through them (D4)
  | 'DATUM_MIDPLANE_PICK' // pick 2 planar faces / datums → plane midway between them (D5)
  | 'DATUM_ANGLE_PICK'    // pick a planar face then one of its edges → plane at an angle about that edge (D3)
  | 'DATUM_AXIS_PICK'     // pick a straight edge or a cylindrical face → datum axis along it (D7)
  | 'DATUM_POINT_PICK'    // pick a vertex or an edge (→ its midpoint) → datum point (D8)
  | 'DATUM_TANGENT_PICK'  // pick a point on a cylindrical face → tangent plane there (D6)
  | 'DATUM_CURVE_NORMAL_PICK' // pick an edge → plane perpendicular to it at a position (D6)
  | 'DATUM_2EDGE_PICK'    // pick 2 coplanar edges → plane through them (D6)
  | 'PROJECT_PICK'   // pick edges of bodies → project them onto the active sketch (D11)
  | 'INTERSECT_PICK'; // pick a body → section it with the active sketch plane into curves (D12)

export type BooleanOp = 'CUT' | 'FUSE' | 'COMMON';

// ─── Parametric 2D constraints (Phase 8) ──────────────────────────────────────

export type SketchConstraintType =
  // Geometric
  | 'HORIZONTAL' | 'VERTICAL' | 'PARALLEL' | 'PERPENDICULAR'
  | 'COLLINEAR'  | 'TANGENT'  | 'CONCENTRIC' | 'EQUAL'
  | 'COINCIDENT' | 'SYMMETRY' | 'FIXED'
  // Dimensional (driving)
  | 'LENGTH' | 'RADIUS' | 'DISTANCE' | 'ANGLE';

/** A constraint operand: a whole entity (line/circle) or one of its points. */
export interface SketchRef {
  kind: 'entity' | 'point';
  /** sketch_wire node id. */
  id:   string;
  /** Which point — line endpoint 'a'/'b' or circle center 'c'. (point refs only) */
  pt?:  'a' | 'b' | 'c';
}

export interface SketchConstraint {
  id:    string;
  type:  SketchConstraintType;
  /** Ordered operands (entities and/or points). */
  refs:  SketchRef[];
  /** Driving dimension: LENGTH/RADIUS/DISTANCE in mm, ANGLE in degrees. */
  value?: number;
}

export const sketchRefEq = (a: SketchRef, b: SketchRef) =>
  a.kind === b.kind && a.id === b.id && a.pt === b.pt;

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

  /** Active sketch session — non-null while the user is inside a sketch session. */
  sketchSession: { id: string; name: string; plane: Workplane } | null;
  sketchSessionCount: number;

  /** Sketch input overlay state — number of clicks already registered in this tool interaction. */
  sketchInputStep: number;
  /** Local-2D coordinates (u, v) of each registered click, exposed to the overlay. */
  sketchPoints: { x: number; y: number }[];
  /** Current mouse position in local-2D plane coordinates, updated on every mousemove. */
  sketchPreviewPoint: { x: number; y: number } | null;

  // ── Actions ────────────────────────────────────────────────────────────────

  addNode:            (node: Omit<CADNode, 'children'>) => void;
  /** Create a reference (datum) plane node from a workplane. Returns its id. */
  createDatumPlane:   (wp: Workplane, method?: string, refs?: any[]) => string;
  /** Create a reference (datum) axis node from an origin + unit direction (D7). */
  createDatumAxis:    (axis: { origin: [number,number,number]; dir: [number,number,number] }, method?: string, refs?: any[]) => string;
  /** Create a reference (datum) point node at a world position (D8). */
  createDatumPoint:   (point: [number,number,number], method?: string, refs?: any[]) => string;
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
  /** Create the parent Sketch node, set activeWorkplane, and open the session. */
  startSketchSession:    (plane: Workplane) => void;
  /** Finalize the session and return to SELECT mode. */
  quitSketchSession:     () => void;

  setSketchInputStep:    (n: number) => void;
  setSketchPoints:       (pts: { x: number; y: number }[]) => void;
  setSketchPreviewPoint: (pt: { x: number; y: number } | null) => void;
  resetSketchInput:      () => void;

  /** Re-enter an existing sketch session without creating a new parent node. */
  resumeSketchSession:   (sketchId: string) => void;

  /** Move a node to a new parent (or to root if newParentId is null). */
  reparentNode: (nodeId: string, newParentId: string | null) => void;
  /** Merge extra key/value pairs into a node's params without touching other fields. */
  setNodeParams: (nodeId: string, params: Record<string, any>) => void;
  /** Re-parent the sketch(es) that a 3D operation consumed UNDER the operation node,
   *  giving e.g. Extrusion1 → Sketch1 → Circle1. Adopts the sketch container if the
   *  wire has one, otherwise the wire itself. */
  adoptSketchSources: (operationId: string, wireIds: string[]) => void;

  /** Right-click context menu on tree sketch nodes. */
  treeContextMenu: { nodeId: string; x: number; y: number } | null;
  openTreeContextMenu:  (nodeId: string, x: number, y: number) => void;
  closeTreeContextMenu: () => void;

  /** Op3D panel request — non-null while the panel is open. */
  op3DPanelReq: { op: string; targetIds: string[]; editNodeId?: string } | null;
  openOp3DPanel:  (op: string, targetIds: string[], editNodeId?: string) => void;
  closeOp3DPanel: () => void;
  /** One-shot result of EXTRUDE_TARGET_PICK: the solid id the user clicked
   *  while picking a Pad/Pocket boolean target. The Op3DPanel consumes and
   *  clears it. */
  op3DTargetPick: string | null;
  /** World-space point on the clicked solid (the exact spot the ray hit). Used
   *  by Up-to-Face to resolve WHICH face was clicked. Cleared with op3DTargetPick. */
  op3DTargetPickPoint: [number, number, number] | null;
  /** Begin picking a Pad/Pocket target (enters EXTRUDE_TARGET_PICK mode). */
  startOp3DTargetPick: () => void;
  /** Record the picked target solid (called by the pick hook) and exit.
   *  `point` is the world-space ray-hit on that solid (for Up-to-Face). */
  setOp3DTargetPick: (id: string | null, point?: [number, number, number] | null) => void;

  /** Per-edge blend (fillet/chamfer) request — non-null while the panel is open. */
  blendReq: { targetId: string; op: 'fillet' | 'chamfer'; editNodeId?: string } | null;
  /** Stable 0-based indices of edges the user has picked for the blend. */
  selectedEdgeIndices: number[];
  /** Open the per-edge blend panel and enter BLEND_EDGE interaction mode. */
  openBlendPanel:  (targetId: string, op: 'fillet' | 'chamfer', editNodeId?: string, preEdges?: number[]) => void;
  /** Close the blend panel and return to SELECT mode. */
  closeBlendPanel: () => void;
  /** Toggle a single edge index in/out of the selection. */
  toggleEdgeIndex: (i: number) => void;
  /** Replace the whole edge selection (used by Select-All / Clear). */
  setSelectedEdgeIndices: (idx: number[]) => void;

  /** Boolean op request — non-null while the guided boolean panel is open. */
  booleanReq: { op: BooleanOp; editNodeId?: string } | null;
  /** The base solid (the one kept / cut from). */
  booleanBaseId: string | null;
  /** Tool solids (added / subtracted / intersected with the base). */
  booleanToolIds: string[];
  openBooleanPanel:  (op: BooleanOp, editNodeId?: string, baseId?: string | null, toolIds?: string[]) => void;
  closeBooleanPanel: () => void;
  /** Viewport click handler: first pick = base, subsequent picks toggle tools. */
  pickBooleanSolid:  (id: string) => void;
  /** Reset base + tool selection (panel "Clear"). */
  clearBooleanPick:  () => void;

  /** Constraint editing session — non-null while the constraint panel is open. */
  constraintReq: { sketchId: string } | null;
  /** Entity/point operands currently picked in the viewport for a new constraint. */
  constraintSel: SketchRef[];
  /** Live solver status for the active sketch (degrees of freedom + state). */
  constraintStatus: { dof: number; state: 'under' | 'full' | 'over'; residual: number } | null;
  /** Open the constraint panel for a sketch container + enter CONSTRAIN mode. */
  openConstraintPanel:  (sketchId: string) => void;
  /** Close the constraint panel and return to SELECT mode. */
  closeConstraintPanel: () => void;
  /** Toggle an entity/point operand in/out of the pending constraint selection. */
  toggleConstraintRef:  (ref: SketchRef) => void;
  /** Clear the pending constraint selection. */
  clearConstraintSel:   () => void;
  /** Publish the latest solve status (drives DoF readout + colour-coding). */
  setConstraintStatus:  (s: CADState['constraintStatus']) => void;

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

export function normalizeMaterial(material: Partial<CADMaterial>): CADMaterial {
  const color = Number.isFinite(material.color) ? (((material.color as number) & 0xffffff)) : DEFAULT_MATERIAL.color;
  const roughness = Number.isFinite(material.roughness)
    ? Math.min(1, Math.max(0, material.roughness as number))
    : DEFAULT_MATERIAL.roughness;
  const metalness = Number.isFinite(material.metalness)
    ? Math.min(1, Math.max(0, material.metalness as number))
    : DEFAULT_MATERIAL.metalness;
  const opacity = Number.isFinite(material.opacity)
    ? Math.min(1, Math.max(0, material.opacity as number))
    : DEFAULT_MATERIAL.opacity;

  return {
    color,
    roughness,
    metalness,
    opacity,
    transparent: typeof material.transparent === 'boolean' ? material.transparent : DEFAULT_MATERIAL.transparent,
    wireframe:   typeof material.wireframe   === 'boolean' ? material.wireframe   : DEFAULT_MATERIAL.wireframe,
  };
}

export const NODE_TYPE_COLORS: Record<NodeType, number> = {
  box:               0x5588cc,
  cylinder:          0x44aa66,
  sphere:            0xcc6644,
  extrusion:         0xaa44cc,
  boolean_operation: 0xccaa22,
  compound:          0x888888,
  sketch:            0xff9900,
  sketch_wire:       0xffcc00,
  revolve:           0xcc4488,
  sweep:             0x44bbcc,
  loft:              0xcc8844,
  mirror:            0x4488cc,
  pattern:           0x8844cc,
  datum_plane:       0xf0a30a,   // Fusion amber
  datum_axis:        0xf0a30a,
  datum_point:       0xf0a30a,
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
  sketchSession:      null,
  sketchSessionCount: 0,
  sketchInputStep:    0,
  sketchPoints:       [],
  sketchPreviewPoint: null,
  treeContextMenu:    null,
  op3DPanelReq:       null,
  op3DTargetPick:     null,
  op3DTargetPickPoint: null,
  blendReq:            null,
  selectedEdgeIndices: [],
  booleanReq:          null,
  booleanBaseId:       null,
  booleanToolIds:      [],
  constraintReq:       null,
  constraintSel:       [],
  constraintStatus:    null,

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

  startSketchSession: (plane) => {
    const count = get().sketchSessionCount + 1;
    const name  = `Sketch ${count} [${plane.label}]`;
    const id    = crypto.randomUUID();
    // Create the parent container node (no OCC shape — no cad-add-mesh dispatch)
    get().addNode({
      id, name, type: 'sketch',
      visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { color: 0xff9900, roughness: 0.5, metalness: 0, wireframe: false, opacity: 1, transparent: false },
      params: { workplane: plane },
    });
    set({ sketchSession: { id, name, plane }, sketchSessionCount: count, activeWorkplane: plane });
    get().log(`Sketch session "${name}" started.`, 'info');
    // Animate the camera to the workplane-normal view immediately (don't wait for a
    // tool to be picked). Viewport3D listens and stores the pre-sketch restore fn.
    window.dispatchEvent(new CustomEvent('cad-session-resumed', { detail: { plane } }));
  },

  quitSketchSession: () => {
    const { sketchSession } = get();
    if (sketchSession) get().log(`Sketch "${sketchSession.name}" complete — select it and click Extrude/Revolve.`, 'success');
    set({ sketchSession: null, interactionMode: 'SELECT' });
  },

  setSketchInputStep:    (n)   => set({ sketchInputStep: n }),
  setSketchPoints:       (pts) => set({ sketchPoints: pts }),
  setSketchPreviewPoint: (pt)  => set({ sketchPreviewPoint: pt }),
  resetSketchInput:      ()    => set({ sketchInputStep: 0, sketchPoints: [], sketchPreviewPoint: null }),

  resumeSketchSession: (sketchId) => {
    const { nodes, sketchSession } = get();
    if (sketchSession?.id === sketchId) return; // already active
    const node = nodes[sketchId];
    if (!node || node.type !== 'sketch') return;
    const plane = node.params?.workplane as Workplane | undefined;
    if (!plane) return;
    if (sketchSession) get().log(`Switched from "${sketchSession.name}".`, 'info');
    set({ sketchSession: { id: sketchId, name: node.name, plane }, activeWorkplane: plane, interactionMode: 'SELECT' });
    get().log(`Resumed "${node.name}" — pick a sketch tool to continue.`, 'info');
    // Signal viewport to animate camera to this plane
    window.dispatchEvent(new CustomEvent('cad-session-resumed', { detail: { plane } }));
  },

  openTreeContextMenu:  (nodeId, x, y) => set({ treeContextMenu: { nodeId, x, y } }),
  closeTreeContextMenu: ()             => set({ treeContextMenu: null }),

  openOp3DPanel:  (op, targetIds, editNodeId) => set({ op3DPanelReq: { op, targetIds, editNodeId } }),
  closeOp3DPanel: ()                          => set({ op3DPanelReq: null }),

  startOp3DTargetPick: () => set({ interactionMode: 'EXTRUDE_TARGET_PICK', op3DTargetPick: null, op3DTargetPickPoint: null }),
  setOp3DTargetPick:   (id, point = null) => set({ op3DTargetPick: id, op3DTargetPickPoint: point, interactionMode: 'SELECT' }),

  openBlendPanel: (targetId, op, editNodeId, preEdges) => set({
    blendReq: { targetId, op, editNodeId },
    selectedEdgeIndices: preEdges ? [...preEdges] : [],
    interactionMode: 'BLEND_EDGE',
    selectedIds: [targetId],
  }),
  closeBlendPanel: () => set({ blendReq: null, selectedEdgeIndices: [], interactionMode: 'SELECT' }),
  toggleEdgeIndex: (i) => set((s) => ({
    selectedEdgeIndices: s.selectedEdgeIndices.includes(i)
      ? s.selectedEdgeIndices.filter((x) => x !== i)
      : [...s.selectedEdgeIndices, i],
  })),
  setSelectedEdgeIndices: (idx) => set({ selectedEdgeIndices: [...idx] }),

  openBooleanPanel: (op, editNodeId, baseId, toolIds) => set({
    booleanReq: { op, editNodeId },
    booleanBaseId: baseId ?? null,
    booleanToolIds: toolIds ? [...toolIds] : [],
    interactionMode: 'BOOLEAN_PICK',
    selectedIds: [],
  }),
  closeBooleanPanel: () => set({
    booleanReq: null, booleanBaseId: null, booleanToolIds: [], interactionMode: 'SELECT',
  }),
  pickBooleanSolid: (id) => set((s) => {
    if (!s.booleanBaseId) return { booleanBaseId: id };       // first pick = base
    if (id === s.booleanBaseId) return {};                     // clicking the base: no-op
    return {
      booleanToolIds: s.booleanToolIds.includes(id)
        ? s.booleanToolIds.filter((t) => t !== id)            // toggle off
        : [...s.booleanToolIds, id],                          // add tool
    };
  }),
  clearBooleanPick: () => set({ booleanBaseId: null, booleanToolIds: [] }),

  openConstraintPanel: (sketchId) => {
    const node = get().nodes[sketchId];
    if (!node || node.type !== 'sketch') {
      get().log('Constraints require a sketch container.', 'warn');
      return;
    }
    set({
      constraintReq: { sketchId },
      constraintSel: [],
      constraintStatus: null,
      interactionMode: 'CONSTRAIN',
      selectedIds: [sketchId],
    });
    get().log(`Editing constraints on "${node.name}" — click sketch lines/circles (or their points) to pick.`, 'info');
  },
  closeConstraintPanel: () => set({ constraintReq: null, constraintSel: [], constraintStatus: null, interactionMode: 'SELECT' }),
  toggleConstraintRef: (ref) => set((s) => ({
    constraintSel: s.constraintSel.some((r) => sketchRefEq(r, ref))
      ? s.constraintSel.filter((r) => !sketchRefEq(r, ref))
      : [...s.constraintSel, ref],
  })),
  clearConstraintSel: () => set({ constraintSel: [] }),
  setConstraintStatus: (st) => set({ constraintStatus: st }),

  reparentNode: (nodeId, newParentId) => {
    const { nodes, rootIds } = get();
    const node = nodes[nodeId];
    if (!node || node.parentId === newParentId) return;

    const updated = { ...nodes };
    // Detach from old parent
    const oldParentId = node.parentId;
    if (oldParentId && updated[oldParentId]) {
      updated[oldParentId] = {
        ...updated[oldParentId],
        children: updated[oldParentId].children.filter((c) => c !== nodeId),
      };
    }
    // Update parentId
    updated[nodeId] = { ...node, parentId: newParentId };
    // Attach to new parent or rootIds
    let newRootIds = rootIds.filter((r) => r !== nodeId);
    if (newParentId && updated[newParentId]) {
      updated[newParentId] = {
        ...updated[newParentId],
        children: [...updated[newParentId].children, nodeId],
      };
    } else if (!newParentId) {
      newRootIds = [...newRootIds, nodeId];
    }
    set({ nodes: updated, rootIds: newRootIds });
  },

  setNodeParams: (nodeId, params) => {
    const { nodes } = get();
    if (!nodes[nodeId]) return;
    set({
      nodes: {
        ...nodes,
        [nodeId]: { ...nodes[nodeId], params: { ...nodes[nodeId].params, ...params } },
      },
    });
  },

  adoptSketchSources: (operationId, wireIds) => {
    const { nodes } = get();
    if (!nodes[operationId]) return;
    // Resolve each wire to the node we should re-parent: its sketch container if any.
    const toAdopt = new Set<string>();
    for (const wid of wireIds) {
      const wire = nodes[wid];
      if (!wire) continue;
      const parent = wire.parentId ? nodes[wire.parentId] : null;
      if (parent && parent.type === 'sketch') toAdopt.add(parent.id);
      else toAdopt.add(wid);
    }
    // Don't adopt the operation itself or create a cycle.
    toAdopt.delete(operationId);
    for (const id of toAdopt) {
      // Skip if already a descendant chain issue (operation can't be under its own source)
      if (nodes[id]?.children?.includes(operationId)) continue;
      get().reparentNode(id, operationId);
    }
  },

  // ── Nodes ──────────────────────────────────────────────────────────────────

  addNode: (nodeData) => {
    const { nodes, rootIds } = get();
    const newNode: CADNode = {
      ...nodeData,
      children: [],
      material: normalizeMaterial(nodeData.material),
    };
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

  createDatumPlane: (wp, method = 'custom', refs = []) => {
    const id = makeId();
    const count = Object.values(get().nodes).filter((n) => n.type === 'datum_plane').length + 1;
    const name  = wp.label && wp.label !== 'Custom' ? `Plane ${count} [${wp.label}]` : `Plane ${count}`;
    get().addNode({
      id, name, type: 'datum_plane',
      visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS.datum_plane },
      params: { datum: 'plane', workplane: wp, method, refs, bind: findDatumBind(get().nodes, refs) },
    });
    return id;
  },

  createDatumAxis: (axis, method = 'custom', refs = []) => {
    const id = makeId();
    const count = Object.values(get().nodes).filter((n) => n.type === 'datum_axis').length + 1;
    get().addNode({
      id, name: `Axis ${count}`, type: 'datum_axis',
      visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS.datum_axis },
      params: { datum: 'axis', axis, method, refs, bind: findDatumBind(get().nodes, refs) },
    });
    return id;
  },

  createDatumPoint: (point, method = 'custom', refs = []) => {
    const id = makeId();
    const count = Object.values(get().nodes).filter((n) => n.type === 'datum_point').length + 1;
    get().addNode({
      id, name: `Point ${count}`, type: 'datum_point',
      visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS.datum_point },
      params: { datum: 'point', point, method, refs, bind: findDatumBind(get().nodes, refs) },
    });
    return id;
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

    // Restore visibility of any input solids a deleted op had hidden (booleans
    // hide base+tools, fillet/chamfer hide the source). Without this, deleting
    // a result strands its inputs invisible-but-present in the tree.
    const restoreCandidates = new Set<string>();
    deletedIds.forEach((did) => {
      const p = nodes[did]?.params;
      if (!p) return;
      if (typeof p.baseId   === 'string') restoreCandidates.add(p.baseId);
      if (typeof p.sourceId === 'string') restoreCandidates.add(p.sourceId);
      if (Array.isArray(p.toolIds)) p.toolIds.forEach((t: any) => { if (typeof t === 'string') restoreCandidates.add(t); });
    });
    const restoredIds: string[] = [];
    restoreCandidates.forEach((rid) => {
      const n = updatedNodes[rid];                 // must still exist (not itself deleted)
      if (n && !n.visible) {
        updatedNodes[rid] = { ...n, visible: true };
        restoredIds.push(rid);
      }
    });

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
    // Re-show restored input meshes
    restoredIds.forEach((rid) =>
      window.dispatchEvent(new CustomEvent('cad-visibility-changed', { detail: { id: rid, visible: true } }))
    );

    get().log(
      restoredIds.length
        ? `Deleted: ${deletedName} (restored ${restoredIds.length} input${restoredIds.length > 1 ? 's' : ''})`
        : `Deleted: ${deletedName}`,
      'warn',
    );
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
    const updatedNodes: Record<string, any> = {
      ...nodes,
      [id]: {
        ...nodes[id],
        transform: { position, rotation, scale: scale ?? nodes[id].transform.scale },
      },
    };
    // D13 — datums derived from this body follow its move (same undo entry).
    const datumUpdates = computeDatumUpdates(updatedNodes, id);
    for (const did in datumUpdates) {
      updatedNodes[did] = { ...updatedNodes[did], params: datumUpdates[did] };
    }
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
      [id]: {
        ...nodes[id],
        material: normalizeMaterial({ ...nodes[id].material, ...partial }),
      },
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
