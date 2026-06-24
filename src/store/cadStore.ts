// ============================================================
// ToubkalCAD – cadStore.ts
// Global application state: scene graph, selection, history,
// materials, measurements, logs, interaction modes.
// ============================================================

import { create } from 'zustand';
import { computeDatumUpdates } from '../utils/recomputeDatums';
import { NodeDelta, diffNodes, applyDeltas } from './historyDelta';
import { ProjectFileService } from '../services/ProjectFileService';

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
  // ── Structural tree (assembly side) — carry NO geometry, only containment ──
  | 'assembly'    // organic container: holds components or sub-assemblies
  | 'component'   // a Part: one solid body + the boundary of a local feature tree
  // ── Feature tree (per-component timeline) ──
  | 'box' | 'cylinder' | 'sphere'
  | 'extrusion' | 'boolean_operation' | 'compound'
  | 'sketch' | 'sketch_wire'
  | 'revolve' | 'sweep' | 'loft'
  | 'mirror' | 'pattern'
  // Reference geometry (Track D) — carry no OCC solid; render from params.
  | 'datum_plane' | 'datum_axis' | 'datum_point';

// ─── Dual-tree node taxonomy ───────────────────────────────────────────────────
// The scene graph is two trees joined at the root: a STRUCTURAL tree (assemblies
// → components) and, inside each component, a FEATURE timeline (sketches + 3D
// operations + datum references). 3D operations reference their profile sketches
// by id (`params.targetWireIds`) rather than owning them as children, so one
// sketch can feed many features (Extrusion 1 + Extrusion 2 → same Sketch).

/** Containers in the structural tree. */
export const STRUCTURAL_TYPES = new Set<NodeType>(['assembly', 'component']);
/** Reference geometry — allowed inside a component alongside features. */
export const DATUM_TYPES = new Set<NodeType>(['datum_plane', 'datum_axis', 'datum_point']);
/** Feature-timeline nodes: geometry features that live directly under a component.
 *  (sketch_wire is excluded — it is a child of its `sketch`, not of the component.) */
export const FEATURE_TYPES = new Set<NodeType>([
  'box', 'cylinder', 'sphere', 'extrusion', 'boolean_operation', 'compound',
  'sketch', 'revolve', 'sweep', 'loft', 'mirror', 'pattern',
]);

export const isStructural = (t: NodeType): boolean => STRUCTURAL_TYPES.has(t);
export const isDatum      = (t: NodeType): boolean => DATUM_TYPES.has(t);
export const isFeature    = (t: NodeType): boolean => FEATURE_TYPES.has(t);

/**
 * The single containment rule for the dual tree. `parentType === null` means the
 * scene root. Strict mode: only structural containers may sit at the root; a
 * component holds features + datums; an assembly holds assemblies/components; a
 * sketch holds its wires. Everything else is a leaf.
 */
export function canContain(parentType: NodeType | null, childType: NodeType): boolean {
  if (parentType === null)        return isStructural(childType);              // root: structural only
  if (parentType === 'assembly')  return childType === 'assembly' || childType === 'component';
  if (parentType === 'component') return isFeature(childType) || isDatum(childType);
  if (parentType === 'sketch')    return childType === 'sketch_wire';
  return false;                                                               // features/datums are leaves
}

/**
 * Validate a reparent under the dual-tree rules. Returns a human reason string if
 * the move is rejected, or null if allowed. Shared by `reparentNode` (the commit)
 * and the tree's drag-and-drop highlight so the rule lives in exactly one place.
 */
export function canReparent(
  nodes: Record<string, CADNode>, nodeId: string, newParentId: string | null,
): string | null {
  const node = nodes[nodeId];
  if (!node) return 'node no longer exists';
  if (node.parentId === newParentId) return null;                            // no-op move
  if (newParentId && !nodes[newParentId]) return 'drop target no longer exists';
  const newParentType = newParentId ? nodes[newParentId].type : null;
  if (!canContain(newParentType, node.type)) {
    return `Can't place a ${node.type} ${newParentType ? `inside a ${newParentType}` : 'at the root'}`;
  }
  // A feature/datum already inside a component can't be re-homed onto another
  // part's timeline — that would orphan its profile references.
  if ((isFeature(node.type) || isDatum(node.type)) && node.parentId && nodes[node.parentId]?.type === 'component') {
    return `"${node.name}" is a feature of its component — it can't move to another`;
  }
  // No cycles: can't drop a container into its own descendant.
  for (let p: string | null = newParentId; p; p = nodes[p]?.parentId ?? null) {
    if (p === nodeId) return 'Cannot move a node into its own descendant';
  }
  return null;
}

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
  | 'DIMENSION'     // Smart Dimension — click entities to add a driving dimension + its annotation
  | 'FACE_SKETCH'    // picking a planar face to start a sketch on it (S2)
  | 'EDIT_TRIM'      // S1 — trim a sketch line at its intersections
  | 'EDIT_EXTEND'    // S1 — extend a sketch line to the nearest boundary
  | 'EDIT_SPLIT'     // S1 — break a sketch line at its intersections
  | 'EDIT_POWER_TRIM' // power-trim — drag a stroke; every crossed curve is trimmed at the crossing
  | 'EDIT_FILLET'    // S1 — round a sketch corner (pick the vertex where two lines meet)
  | 'EDIT_CHAMFER'   // S1 — bevel a sketch corner (equal-distance, pick the vertex)
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
  | 'INTERSECT_PICK' // pick a body → section it with the active sketch plane into curves (D12)
  | 'GUIDE_PROFILE_PICK' // Advanced Loft: pick the 2 profile wires the guide(s) bridge
  | 'GUIDE_DRAW';        // Advanced Loft: snap+click 2 endpoints, then sculpt the 3D guide

export type BooleanOp = 'CUT' | 'FUSE' | 'COMMON';

// ─── Advanced Loft guide-curve authoring ──────────────────────────────────────
export interface GuidePoint { x: number; y: number; z: number }

/**
 * A guide curve mid-authoring. `points` are the Bezier control poles in world
 * space: points[0]/points[last] are the snapped endpoints (locked to a profile),
 * the interior poles are the handles the Tweakpane X/Y/Z sliders sculpt.
 */
export interface GuideDraft {
  points:      GuidePoint[];      // 2 → straight, 3 → quadratic, 4 → cubic
  startWireId: string | null;     // profile wire the first endpoint is locked to
  endWireId:   string | null;     // profile wire the last  endpoint is locked to
  /** How many endpoints have been clicked/locked so far (0,1,2). */
  lockedCount: number;
}

// ─── Parametric 2D constraints (Phase 8) ──────────────────────────────────────

export type SketchConstraintType =
  // Geometric
  | 'HORIZONTAL' | 'VERTICAL' | 'PARALLEL' | 'PERPENDICULAR'
  | 'COLLINEAR'  | 'TANGENT'  | 'CONCENTRIC' | 'EQUAL'
  | 'COINCIDENT' | 'SYMMETRY' | 'FIXED'
  // Dimensional (driving)
  | 'LENGTH' | 'RADIUS' | 'DISTANCE' | 'ANGLE'
  // Directional point↔point distance: ΔX (horizontal) / ΔY (vertical), in sketch-
  // plane local coords. Created by Smart Dimension based on cursor direction.
  | 'DISTANCE_X' | 'DISTANCE_Y';

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

// ─── Dimension annotations (Phase 8 — visual driving-dimension overlay) ─────────
//
// A dimension annotation is the *visual* face of a dimensional SketchConstraint
// (LENGTH / RADIUS / DISTANCE / ANGLE): extension lines, a dimension line with
// arrowheads, and an editable value label, drawn on the sketch plane in 3D.
//
// IMPORTANT — single source of truth: the annotation does NOT own the numeric
// value. The owning `SketchConstraint.value` is authoritative; the renderer reads
// it live (post-solve) via the constraint id. The annotation persists only the
// *presentation*: where the user dragged the dimension line (`offset`, in
// workplane-local units, measured from the dimension's natural anchor) and a
// per-dimension hide flag. This mirrors how `params.constraints` already work and
// avoids the value-drift that a denormalised copy would invite.
//
// Annotations live on the sketch container node at `params.dimensions`.
export type DimensionType = 'LENGTH' | 'RADIUS' | 'DISTANCE' | 'ANGLE' | 'DISTANCE_X' | 'DISTANCE_Y';

export interface DimensionAnnotation {
  id:           string;
  /** The driving SketchConstraint this dimension visualises (value + refs live there). */
  constraintId: string;
  type:         DimensionType;
  /** Mirror of the constraint operands — kept so the renderer can resolve geometry
   *  without re-reading the constraint list (it still reads `value` from the constraint). */
  refs:         SketchRef[];
  /** Workplane-local placement of the dimension line/label, relative to the
   *  dimension's natural anchor (segment midpoint / line foot / angle vertex /
   *  circle centre). Lets the user drag the dimension clear of the geometry. */
  offset:       { u: number; v: number };
  /** Per-dimension hide, independent of the global `dimensionsVisible` toggle. */
  hidden?:      boolean;
}

// ─── Live sketch dragging (soft-constraint) ────────────────────────────────────
// The store owns only the drag STATE + the start/update/stop actions; the actual
// soft-constraint solve loop lives behind this engine seam (SketchDragController),
// installed once at startup via installDragEngine() — so the store never imports
// the solver/OCC layer (it stays scene-graph metadata + UI state).

export interface SketchDragState {
  /** What the user grabbed — a point operand or an entity body to translate. */
  entity: SketchRef;
  /** Latest cursor position in sketch-plane local 2D (u,v), or null pre-move. */
  mouse: [number, number] | null;
}

export interface SketchDragEngine {
  /** Begin a drag: resolve the pinned point + grab offset from the grabbed ref. */
  begin(sketchId: string, origin: SketchRef, grabLocal: [number, number]): void;
  /** One drag frame: re-solve with the cursor as a soft pin and sync geometry. */
  frame(local: [number, number]): void;
  /** End the drag: run the downstream recompute once. */
  end(): void;
}

// Module-scoped engine slot — injected at startup, kept off the reactive state.
let dragEngine: SketchDragEngine | null = null;
// Deep snapshot of the nodes taken at drag start, so stopDragging can push ONE
// undo step spanning the whole drag (the per-frame solves don't touch history).
let dragSnapshot: CADNode[] | null = null;
/** Install the live-drag engine (called once at app startup, after the kernel
 *  + registry are ready). Mirrors installSolver()'s injection pattern. */
export function installDragEngine(engine: SketchDragEngine): void { dragEngine = engine; }

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
  /**
   * Type-specific metadata. Notable contracts:
   *  • sketch_wire → `workplane`, `sketchGeom`.
   *  • assembly / component → none (pure structural containers, no geometry).
   *  • 3D operations (extrusion/revolve/sweep/loft) → `targetWireIds: string[]`,
   *    the id-reference to the profile sketch(es). This is the "profile source"
   *    link: it lives in params (NOT parent/child), so several operations can
   *    reference the SAME sketch without it being structurally swallowed, and the
   *    recompute graph derives the profile DAG edge from it (see FeatureGraph).
   */
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
  type:        'ADD' | 'DELETE' | 'TRANSFORM' | 'RENAME' | 'MATERIAL' | 'STRUCTURE';
  description: string;
  deltas:      NodeDelta[];   // only the nodes this action changed (not a full snapshot)
  // Exact root-order snapshots. rootIds order isn't a per-node field, so it can't
  // ride in `deltas` — without these, undo/redo would have to DERIVE root order
  // (losing reorders). Every action records both so any undo restores the precise
  // order, not just node parentage.
  rootBefore:  string[];
  rootAfter:   string[];
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

  // ─── Advanced Loft: guide-curve authoring ───────────────────────────────
  /** Profile wire node ids the guide(s) bridge (exactly 2 when ready). */
  guideProfiles: string[];
  /** Guide currently being drawn/sculpted; null when none in progress. */
  guideDraft: GuideDraft | null;
  /** Live snap target under the cursor in GUIDE_DRAW mode (world coords) or null. */
  guideSnap: GuidePoint | null;
  /** Node ids of completed guide wires (registered shapes live in the registry). */
  guideIds: string[];
  /** The guide whose Bezier control points the slider edits, or null. */
  selectedGuideId: string | null;
  /** True while the floating Advanced-Loft dialog is open. */
  advancedLoftOpen: boolean;

  measurements: CADMeasurement[];

  logs: LogEntry[];

  isProcessing:    boolean;
  processingLabel: string;

  snapEnabled: boolean;
  snapStep:    number;

  sketchPolygonSides: number;
  /** When true, the Project/Include tool adds projected edges as REFERENCE
   *  (construction) geometry instead of normal profile polylines. */
  projectAsConstruction: boolean;

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
  /** The component new features are placed under (the "active part"). */
  activeComponentId:  string | null;
  /** Set the active component (features added next land here). null → next feature
   *  auto-creates/reuses a default component. */
  setActiveComponent: (id: string | null) => void;
  /** Create an empty component (a Part). Optionally nest under an assembly.
   *  Becomes the active component. Returns its id. */
  createComponent:    (name?: string, parentId?: string | null) => string;
  /** Create an empty assembly container (root, or nested under another assembly). */
  createAssembly:     (name?: string, parentId?: string | null) => string;
  /** Apply a loaded scene and migrate it to the dual-tree shape (wrap stray
   *  features into a component, un-nest adopted sketches). Used by project load. */
  loadScene:          (nodes: Record<string, CADNode>, rootIds: string[]) => void;
  /** Clear the scene to an empty document (wipes nodes, history, selection) and
   *  resets the viewport. */
  newProject:         () => void;
  /** Serialize the current scene to a downloadable `.tkcad` file. */
  saveProject:        (name?: string) => Promise<void>;
  /** Validate + load a `.tkcad` JSON string: wipe the viewport, replace the
   *  scene, then rebuild geometry from the parametric tree. */
  loadProject:        (jsonString: string) => void;
  /** Reorganize the current scene into the strict dual tree in place. Idempotent. */
  migrateToComponentTree: () => void;
  /** Add several nodes (e.g. a decomposed rectangle's edges) + optional auto-
   *  constraints on a sketch container, as ONE undo step. */
  addSketchEntities:  (nodeList: Omit<CADNode, 'children'>[], sketchId: string | null, autoConstraints?: SketchConstraint[], label?: string) => void;
  /** Commit a sketch corner fillet/chamfer as ONE undoable action: in-place geom
   *  edits (shortened lines), added nodes (the arc/bevel connector), removed nodes
   *  (an exploded polyline) and the sketch's full new constraint list — all in a
   *  single history entry. The caller updates the OCC registry + wire visuals
   *  imperatively; undo/redo rebuild them from restored sketchGeom. */
  applySketchCornerEdit: (opts: {
    description: string; sketchId: string;
    geomUpdates?: { id: string; sketchGeom: any }[];
    addNodes?: Omit<CADNode, 'children'>[];
    removeIds?: string[];
    constraints: SketchConstraint[];
  }) => void;
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

  // ─── Advanced Loft guide-curve actions ──────────────────────────────────
  /** Enter profile-pick mode and reset any prior guide selection. */
  startGuideProfilePick: () => void;
  /** Toggle a profile wire into/out of the (max 2) guide-profile selection. */
  toggleGuideProfile:    (wireId: string) => void;
  /** Enter draw mode (requires 2 profiles picked). */
  startGuideDraw:        () => void;
  /** Live snap target under the cursor (or null) while drawing. */
  setGuideSnap:          (p: GuidePoint | null) => void;
  /** Lock the next endpoint at `p` onto `wireId`; on the 2nd lock, seed handles. */
  lockGuideEndpoint:     (p: GuidePoint, wireId: string | null) => void;
  /** Move an interior Bezier control pole (index 1..len-2) — the slider hook. */
  setGuideControlPoint:  (index: number, p: GuidePoint) => void;
  /** Register a finished guide wire node id and clear the draft. */
  commitGuide:           (guideId: string) => void;
  /** Abort the in-progress draft (Esc). */
  cancelGuideDraw:       () => void;
  /** Select a completed guide for control-point editing (or null). */
  selectGuide:           (guideId: string | null) => void;
  /** Forget a completed guide (its node/shape removal is handled by removeNode). */
  removeGuide:           (guideId: string) => void;
  /** Open the floating Advanced-Loft dialog and enter profile-pick mode. */
  openAdvancedLoft:      () => void;
  /** Close the dialog and reset the in-progress guide selection so it doesn't
   *  leak into viewport interactions. */
  closeAdvancedLoft:     () => void;
  setActiveWorkplane:    (wp: Workplane) => void;
  openPlaneSelector:     (pendingMode: InteractionMode) => void;
  closePlaneSelector:    () => void;
  /** Create the parent Sketch node, set activeWorkplane, and open the session.
   *  `sourceFace` (sketch-on-face): the body node id + a StableRef FaceSig of the
   *  picked face, so the sketch follows that face on recompute (step 4). */
  startSketchSession:    (plane: Workplane, sourceFace?: { nodeId: string; sel: unknown }) => void;
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
  /** Move a node to a specific position among a parent's children (or root):
   *  insert it BEFORE `beforeId`, or append when `beforeId` is null. Same
   *  containment validation as reparentNode (a feature stays in its component, so
   *  this reorders its timeline; cross-container moves are gated). */
  moveNode: (nodeId: string, newParentId: string | null, beforeId: string | null) => void;
  /** Merge extra key/value pairs into a node's params without touching other fields. */
  setNodeParams: (nodeId: string, params: Record<string, any>) => void;

  /** Right-click context menu on tree sketch nodes. */
  treeContextMenu: { nodeId: string; x: number; y: number } | null;
  openTreeContextMenu:  (nodeId: string, x: number, y: number) => void;
  closeTreeContextMenu: () => void;

  /** Op3D panel request — non-null while the panel is open. */
  op3DPanelReq: { op: string; targetIds: string[]; editNodeId?: string; ephemeral?: boolean } | null;
  openOp3DPanel:  (op: string, targetIds: string[], editNodeId?: string, ephemeral?: boolean) => void;
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
  constraintStatus: { dof: number; state: 'under' | 'full' | 'over' | 'conflict'; residual: number } | null;
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

  // ── Dimension annotations (visual driving-dimensions) ─────────────────────────
  /** Global show/hide for every dimension annotation (declutter toggle). */
  dimensionsVisible: boolean;
  /** Constraint id currently hovered (in the panel OR on the canvas) → cross-highlight. */
  hoveredConstraintId: string | null;
  setDimensionsVisible:   (v: boolean) => void;
  toggleDimensionsVisible: () => void;
  setHoveredConstraint:   (id: string | null) => void;
  /** Add or replace a dimension annotation on a sketch (by id). */
  upsertDimension:        (sketchId: string, dim: DimensionAnnotation) => void;
  /** Drag-reposition a dimension's label/line (workplane-local offset). */
  setDimensionOffset:     (sketchId: string, dimId: string, offset: { u: number; v: number }) => void;
  /** Remove a dimension annotation (does NOT remove its driving constraint). */
  removeDimension:        (sketchId: string, dimId: string) => void;

  /** Live sketch-drag state — non-null only while a point/entity is being dragged. */
  dragState: SketchDragState | null;
  /** Begin dragging `origin` (a point operand or entity body); `grabLocal` is the
   *  pointer's sketch-local 2D position at grab time. Pins the cursor as a soft
   *  solver objective via the installed drag engine. */
  startDragging:  (origin: SketchRef, grabLocal: [number, number]) => void;
  /** Push the latest cursor position (sketch-local 2D) and re-solve one frame. */
  updateDragging: (local: [number, number]) => void;
  /** Finish the drag (release the pin, recompute dependents). */
  stopDragging:   () => void;

  addMeasurement:    (m: Omit<CADMeasurement, 'id'>) => void;
  removeMeasurement: (id: string) => void;
  clearMeasurements: () => void;

  log:       (msg: string, level?: LogEntry['level']) => void;
  clearLogs: () => void;

  setProcessing: (active: boolean, label?: string) => void;

  setSnapEnabled: (v: boolean)  => void;
  setSnapStep:    (v: number)   => void;
  setProjectAsConstruction: (v: boolean) => void;

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
  assembly:          0x9aa0a6,   // neutral grey — structural containers
  component:         0x6e7681,
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

/** Cap on retained undo steps. Bounds the JS history arrays. A REGENERABLE node's
 *  OCC shape is freed immediately on delete (the recompute engine rebuilds it from
 *  its recipe on undo); only NON-regenerable shapes (imported / mirror / pattern)
 *  are retained while a delta referencing them stays in this window, then freed as
 *  the action ages out — see CADGeometryRegistry's reachability GC. */
const HISTORY_LIMIT = 100;

/** Append an action to `past`, trimming the oldest entries past HISTORY_LIMIT.
 *  Only new actions (which also clear `future`) grow the stack — undo/redo just
 *  shuffle between past/future, so capping here bounds the total. */
function pushPast(past: CADAction[], action: CADAction): CADAction[] {
  const next = [...past, action];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** Build a delta-based action from two full node snapshots (the push sites already
 *  have these on hand; the diff keeps only what changed). `rootBefore`/`rootAfter`
 *  capture the exact root order on each side so undo/redo restore it verbatim. */
function makeAction(
  type: CADAction['type'], description: string, before: CADNode[], after: CADNode[],
  rootBefore: string[], rootAfter: string[],
): CADAction {
  return { type, description, deltas: diffNodes(before, after), rootBefore: [...rootBefore], rootAfter: [...rootAfter] };
}

/** Restore the root list for an undo/redo: take the snapshot's order but reconcile
 *  it against the actual parentless nodes (so it's always exactly the root set,
 *  ordered as recorded, with any stragglers appended). */
function reconcileRoots(stored: string[], nodes: Record<string, CADNode>): string[] {
  const derived = Object.values(nodes).filter((n) => !n.parentId).map((n) => n.id);
  const rootSet = new Set(derived);
  const ordered = stored.filter((id) => rootSet.has(id));
  for (const id of derived) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** After an undo/redo, push each restored node's transform back onto its mesh so
 *  the viewport matches the metadata. Nodes with no mesh (sketches) are no-ops in
 *  the Viewport handler. Must run AFTER the cad-add-mesh events so re-added
 *  meshes already exist in the scene. */
function syncTransforms(nodes: Record<string, CADNode>): void {
  for (const id in nodes) {
    const t = nodes[id].transform;
    window.dispatchEvent(new CustomEvent('cad-apply-transform', {
      detail: { id, position: t.position, rotation: t.rotation },
    }));
  }
}

/** Re-sync the viewport after an undo/redo restored `nodes`. A re-added node's
 *  shape may have been freed on delete (regenerable nodes are freed immediately
 *  now, not retained through history) — so before meshing, fire `cad-regenerate`,
 *  which the recompute bridge handles SYNCHRONOUSLY (rebuilding any missing shape
 *  from its recipe into the registry) so the subsequent cad-add-mesh finds it. */
function syncScene(added: string[], removed: string[], restoredNodes: Record<string, CADNode>): void {
  removed.forEach((id) => window.dispatchEvent(new CustomEvent('cad-remove-mesh', { detail: { id } })));
  if (added.length) window.dispatchEvent(new CustomEvent('cad-regenerate'));
  added.forEach((id) => window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } })));
  // Re-meshed nodes rebuild at their LOCAL pose, and a plain transform-undo moves
  // no mesh on its own — push every restored node's transform back onto its mesh.
  syncTransforms(restoredNodes);
}

/** sketch_wire ids whose `sketchGeom` differs between two node maps. A plain
 *  param-restore (undo/redo of a drag) adds/removes nothing, so syncScene won't
 *  touch these wires — we rebuild their OCC shape + outline + dependents via
 *  `cad-sketch-rebuild` (handled by the recompute bridge). */
function sketchWiresWithChangedGeom(before: Record<string, CADNode>, after: Record<string, CADNode>): string[] {
  const out: string[] = [];
  for (const id in after) {
    if (after[id].type !== 'sketch_wire') continue;
    const a = JSON.stringify(after[id].params?.sketchGeom);
    const b = JSON.stringify(before[id]?.params?.sketchGeom);
    if (a !== b) out.push(id);
  }
  return out;
}

const IDENTITY_TRANSFORM = () =>
  ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as CADNode['transform']);

/** Build a structural container node (assembly/component) — no geometry. */
function makeContainer(type: 'assembly' | 'component', name: string, parentId: string | null): CADNode {
  return {
    id: makeId(), name, type, visible: true, locked: false, parentId, children: [], notes: '',
    transform: IDENTITY_TRANSFORM(),
    material: normalizeMaterial({ color: NODE_TYPE_COLORS[type] }),
    params: {},
  };
}

/**
 * Resolve the component features should land in, creating a default one if needed.
 * Pure: returns a possibly-extended nodes map. Prefers the active component, then
 * any existing component, else mints "Part N" at the root.
 */
function ensureComponentIn(
  nodes: Record<string, CADNode>, rootIds: string[], activeId: string | null,
): { nodes: Record<string, CADNode>; rootIds: string[]; componentId: string; created: boolean } {
  if (activeId && nodes[activeId]?.type === 'component') {
    return { nodes, rootIds, componentId: activeId, created: false };
  }
  const existing = Object.values(nodes).find((n) => n.type === 'component');
  if (existing) return { nodes, rootIds, componentId: existing.id, created: false };
  const count = Object.values(nodes).filter((n) => n.type === 'component').length + 1;
  const comp = makeContainer('component', `Part ${count}`, null);
  return {
    nodes: { ...nodes, [comp.id]: comp }, rootIds: [...rootIds, comp.id],
    componentId: comp.id, created: true,
  };
}

/** Build the set() payload for a tree-structure change (reparent / reorder),
 *  recording ONE undoable STRUCTURE action. Pushes history when the node deltas
 *  changed OR the root order changed (a pure root reorder has no node delta but
 *  must still be undoable — its order rides in rootBefore/rootAfter). */
function commitStructure(
  before: CADNode[], updated: Record<string, CADNode>,
  rootBefore: string[], rootAfter: string[], description: string, past: CADAction[],
): Partial<CADState> {
  const action = makeAction('STRUCTURE', description, before, Object.values(updated), rootBefore, rootAfter);
  const changed = action.deltas.length > 0 || rootBefore.join() !== rootAfter.join();
  return changed
    ? { nodes: updated, rootIds: rootAfter, past: pushPast(past, action), future: [] }
    : { nodes: updated, rootIds: rootAfter };
}

/** Detach `nodeId` from its current parent's children (or rootIds). Mutates the
 *  passed map by replacing the parent entry; returns the new rootIds. */
function detachFromParent(nodes: Record<string, CADNode>, rootIds: string[], nodeId: string): string[] {
  const pid = nodes[nodeId]?.parentId ?? null;
  if (pid && nodes[pid]) {
    nodes[pid] = { ...nodes[pid], children: nodes[pid].children.filter((c) => c !== nodeId) };
    return rootIds;
  }
  return rootIds.filter((r) => r !== nodeId);
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
  guideProfiles:   [],
  guideDraft:      null,
  guideSnap:       null,
  guideIds:        [],
  selectedGuideId: null,
  advancedLoftOpen: false,
  measurements:    [],
  logs:            [makeLog('ToubkalCAD ready — WASM kernel loaded.', 'success')],
  isProcessing:       false,
  processingLabel:    '',
  snapEnabled:        true,
  snapStep:           1.0,
  projectAsConstruction: true,   // reference projection is the professional default
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
  dimensionsVisible:   true,
  hoveredConstraintId: null,
  dragState:           null,
  activeComponentId:   null,

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

  // ─── Advanced Loft guide-curve actions ──────────────────────────────────
  startGuideProfilePick: () => set({
    interactionMode: 'GUIDE_PROFILE_PICK',
    guideProfiles: [], guideDraft: null, guideSnap: null, selectedGuideId: null,
  }),

  toggleGuideProfile: (wireId) => set((s) => {
    const has = s.guideProfiles.includes(wireId);
    if (has) return { guideProfiles: s.guideProfiles.filter((id) => id !== wireId) };
    // Keep at most 2 (FIFO): the guide bridges exactly two profiles.
    const next = [...s.guideProfiles, wireId].slice(-2);
    return { guideProfiles: next };
  }),

  startGuideDraw: () => set((s) => {
    if (s.guideProfiles.length < 2) {
      return { logs: [...s.logs, makeLog('Pick 2 profiles before drawing a guide.', 'warn')] };
    }
    return {
      interactionMode: 'GUIDE_DRAW',
      guideDraft: { points: [], startWireId: null, endWireId: null, lockedCount: 0 },
      guideSnap: null,
    };
  }),

  setGuideSnap: (p) => set({ guideSnap: p }),

  lockGuideEndpoint: (p, wireId) => set((s) => {
    const draft = s.guideDraft ?? { points: [], startWireId: null, endWireId: null, lockedCount: 0 };
    if (draft.lockedCount === 0) {
      return { guideDraft: { points: [p], startWireId: wireId, endWireId: null, lockedCount: 1 } };
    }
    if (draft.lockedCount === 1) {
      // Second endpoint locked → seed a cubic with 2 interior handles at 1/3, 2/3
      // along the chord so the user immediately has sliders to sculpt.
      const a = draft.points[0];
      const b = p;
      const lerp = (t: number): GuidePoint => ({
        x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
      });
      return {
        guideDraft: {
          points: [a, lerp(1 / 3), lerp(2 / 3), b],
          startWireId: draft.startWireId, endWireId: wireId, lockedCount: 2,
        },
      };
    }
    return {};   // already complete; ignore further clicks
  }),

  setGuideControlPoint: (index, p) => set((s) => {
    if (!s.guideDraft) return {};
    const pts = s.guideDraft.points.slice();
    // Endpoints stay locked to their profiles — only interior poles move.
    if (index <= 0 || index >= pts.length - 1) return {};
    pts[index] = p;
    return { guideDraft: { ...s.guideDraft, points: pts } };
  }),

  commitGuide: (guideId) => set((s) => ({
    guideIds: [...s.guideIds, guideId],
    selectedGuideId: guideId,
    guideDraft: null, guideSnap: null,
    interactionMode: 'SELECT',
  })),

  cancelGuideDraw: () => set({
    guideDraft: null, guideSnap: null, interactionMode: 'SELECT',
  }),

  selectGuide: (guideId) => set({ selectedGuideId: guideId }),

  removeGuide: (guideId) => set((s) => ({
    guideIds: s.guideIds.filter((id) => id !== guideId),
    selectedGuideId: s.selectedGuideId === guideId ? null : s.selectedGuideId,
  })),

  openAdvancedLoft: () => set({
    advancedLoftOpen: true,
    // Same fresh-start reset as startGuideProfilePick — the dialog opens ready
    // to pick the two profiles the guide(s) will bridge.
    // Fresh session: also clear guideIds so "Guides drawn" starts at 0 and a
    // prior run's rails can't bleed in. Committed guide wire NODES (and any loft
    // built from them) persist in the tree independently of this session array.
    interactionMode: 'GUIDE_PROFILE_PICK',
    guideProfiles: [], guideDraft: null, guideSnap: null, guideIds: [], selectedGuideId: null,
  }),

  closeAdvancedLoft: () => set((s) => ({
    advancedLoftOpen: false,
    // Reset the in-progress selection so a half-finished guide pick/draw can't
    // keep routing viewport clicks. guideIds is the session's rail array — the
    // committed guide wire NODES stay in the tree; we just forget the session
    // refs. Only drop out of a guide mode — don't stomp a mode the user may have
    // switched to elsewhere.
    guideProfiles: [], guideDraft: null, guideSnap: null, guideIds: [], selectedGuideId: null,
    interactionMode: (s.interactionMode === 'GUIDE_PROFILE_PICK' || s.interactionMode === 'GUIDE_DRAW')
      ? 'SELECT' : s.interactionMode,
  })),
  setProjectAsConstruction: (v) => set({ projectAsConstruction: v }),
  setSnapEnabled:        (v)    => set({ snapEnabled: v }),
  setSnapStep:           (v)    => set({ snapStep: v }),
  setSketchPolygonSides: (n)    => set({ sketchPolygonSides: n }),
  setActiveWorkplane:    (wp)   => set({ activeWorkplane: wp }),
  openPlaneSelector:     (mode) => set({ planeSelectorOpen: true, pendingSketchMode: mode }),
  closePlaneSelector:    ()     => set({ planeSelectorOpen: false, pendingSketchMode: null }),

  startSketchSession: (plane, sourceFace) => {
    const count = get().sketchSessionCount + 1;
    const name  = `Sketch ${count} [${plane.label}]`;
    const id    = crypto.randomUUID();
    // Create the parent container node (no OCC shape — no cad-add-mesh dispatch).
    // sourceFace, when sketching on a solid face, makes this container a frame
    // producer the recompute engine re-derives from (step 4); absent for plane sketches.
    get().addNode({
      id, name, type: 'sketch',
      visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { color: 0xff9900, roughness: 0.5, metalness: 0, wireframe: false, opacity: 1, transparent: false },
      params: sourceFace ? { workplane: plane, sourceFaceRef: sourceFace } : { workplane: plane },
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
    // Rebuild any feature bound to this sketch (loft / extrude / revolve) from its
    // now-current profile. The recompute bridge (RecomputeEngine.live) listens —
    // dispatched as an event to avoid a store→engine import cycle. No-op if nothing
    // downstream depends on the sketch.
    if (sketchSession) {
      window.dispatchEvent(new CustomEvent('cad-sketch-committed', { detail: { sketchId: sketchSession.id } }));
    }
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

  openOp3DPanel:  (op, targetIds, editNodeId, ephemeral) => set({ op3DPanelReq: { op, targetIds, editNodeId, ephemeral } }),
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

  // ── Dimension annotations ─────────────────────────────────────────────────────
  setDimensionsVisible:    (v) => set({ dimensionsVisible: v }),
  toggleDimensionsVisible: () => set((s) => ({ dimensionsVisible: !s.dimensionsVisible })),
  setHoveredConstraint:    (id) => set((s) => (s.hoveredConstraintId === id ? s : { hoveredConstraintId: id })),
  upsertDimension: (sketchId, dim) => {
    const node = get().nodes[sketchId];
    if (!node) return;
    const cur = (node.params?.dimensions as DimensionAnnotation[] | undefined) ?? [];
    const next = cur.some((d) => d.id === dim.id)
      ? cur.map((d) => (d.id === dim.id ? dim : d))
      : [...cur, dim];
    get().setNodeParams(sketchId, { dimensions: next });
  },
  setDimensionOffset: (sketchId, dimId, offset) => {
    const node = get().nodes[sketchId];
    if (!node) return;
    const cur = (node.params?.dimensions as DimensionAnnotation[] | undefined) ?? [];
    get().setNodeParams(sketchId, { dimensions: cur.map((d) => (d.id === dimId ? { ...d, offset } : d)) });
  },
  removeDimension: (sketchId, dimId) => {
    const node = get().nodes[sketchId];
    if (!node) return;
    const cur = (node.params?.dimensions as DimensionAnnotation[] | undefined) ?? [];
    get().setNodeParams(sketchId, { dimensions: cur.filter((d) => d.id !== dimId) });
  },

  // ── Live sketch dragging (soft-constraint) ───────────────────────────────────
  startDragging: (origin, grabLocal) => {
    const { constraintReq, sketchSession } = get();
    const sid = constraintReq?.sketchId ?? sketchSession?.id ?? null;
    if (!sid) return;
    // Snapshot up front so the whole drag collapses into one undo step.
    dragSnapshot = JSON.parse(JSON.stringify(Object.values(get().nodes)));
    dragEngine?.begin(sid, origin, grabLocal);
    set({ dragState: { entity: origin, mouse: grabLocal } });
  },
  updateDragging: (local) => {
    if (!get().dragState) return;
    // Re-solve this frame (soft pin → cursor) and sync geometry, then record the
    // cursor. The seed is implicit: the engine re-reads last frame's solved geom.
    dragEngine?.frame(local);
    set((s) => (s.dragState ? { dragState: { ...s.dragState, mouse: local } } : {}));
  },
  stopDragging: () => {
    if (!get().dragState) return;
    dragEngine?.end();                       // final recompute of dependents
    set({ dragState: null });
    // Push ONE history entry covering the net move (geom params + any recompute).
    if (dragSnapshot) {
      const action = makeAction('TRANSFORM', 'Drag sketch', dragSnapshot, Object.values(get().nodes), get().rootIds, get().rootIds);
      if (action.deltas.length) set({ past: pushPast(get().past, action), future: [] });
      dragSnapshot = null;
    }
  },

  reparentNode: (nodeId, newParentId) => {
    const { nodes, rootIds } = get();
    const node = nodes[nodeId];
    if (!node || node.parentId === newParentId) return;

    const reason = canReparent(nodes, nodeId, newParentId);
    if (reason) { get().log(reason, 'warn'); return; }

    const before = JSON.parse(JSON.stringify(Object.values(nodes)));
    const updated = { ...nodes };
    const newRootIds = detachFromParent(updated, rootIds, nodeId);
    updated[nodeId] = { ...node, parentId: newParentId };
    let finalRoots = newRootIds;
    if (newParentId) {
      updated[newParentId] = { ...updated[newParentId], children: [...updated[newParentId].children, nodeId] };
    } else {
      finalRoots = [...newRootIds, nodeId];
    }
    set(commitStructure(before, updated, rootIds, finalRoots, `Move "${node.name}"`, get().past));
  },

  moveNode: (nodeId, newParentId, beforeId) => {
    const { nodes, rootIds } = get();
    const node = nodes[nodeId];
    if (!node || beforeId === nodeId) return;
    const reason = canReparent(nodes, nodeId, newParentId);
    if (reason) { get().log(reason, 'warn'); return; }

    const before = JSON.parse(JSON.stringify(Object.values(nodes)));
    const updated = { ...nodes };
    // Detach first, THEN insert relative to beforeId (which is unaffected), so a
    // same-parent reorder is index-shift-safe.
    const detachedRoots = detachFromParent(updated, rootIds, nodeId);
    updated[nodeId] = { ...node, parentId: newParentId };
    let finalRoots = detachedRoots;
    if (newParentId) {
      const list = [...updated[newParentId].children];
      const at = beforeId ? list.indexOf(beforeId) : -1;
      at >= 0 ? list.splice(at, 0, nodeId) : list.push(nodeId);
      updated[newParentId] = { ...updated[newParentId], children: list };
    } else {
      finalRoots = [...detachedRoots];
      const at = beforeId ? finalRoots.indexOf(beforeId) : -1;
      at >= 0 ? finalRoots.splice(at, 0, nodeId) : finalRoots.push(nodeId);
    }
    set(commitStructure(before, updated, rootIds, finalRoots, `Reorder "${node.name}"`, get().past));
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

  // ── Nodes ──────────────────────────────────────────────────────────────────

  addNode: (nodeData) => {
    const { nodes, rootIds, activeComponentId } = get();
    let working: Record<string, CADNode> = { ...nodes };
    let workingRoots = [...rootIds];
    let nextActive = activeComponentId;

    const newNode: CADNode = { ...nodeData, children: [], material: normalizeMaterial(nodeData.material) };
    const t = newNode.type;
    let parentId = newNode.parentId ?? null;

    // ── Resolve a valid parent under the strict dual-tree rules ───────────────
    const requestedOk = parentId !== null && !!working[parentId] && canContain(working[parentId].type, t);
    if (!requestedOk) {
      if (isStructural(t)) {
        // assembly/component → keep a valid assembly parent, else root.
        parentId = parentId && working[parentId]?.type === 'assembly' ? parentId : null;
      } else if (isFeature(t) || isDatum(t)) {
        // Features + datums MUST live under a component — ensure one exists.
        const ensured = ensureComponentIn(working, workingRoots, activeComponentId);
        working = ensured.nodes; workingRoots = ensured.rootIds;
        parentId = ensured.componentId;
        nextActive = ensured.componentId;
      } else {
        // sketch_wire / other child nodes: honour the requested parent if real,
        // else fall back to root (legacy leaf behaviour).
        if (!(parentId && working[parentId])) parentId = null;
      }
    } else if (working[parentId!].type === 'component') {
      nextActive = parentId;            // dropped explicitly into a component → make it active
    }

    newNode.parentId = parentId;
    working[newNode.id] = newNode;
    if (parentId && working[parentId]) {
      working[parentId] = { ...working[parentId], children: [...working[parentId].children, newNode.id] };
    } else {
      workingRoots.push(newNode.id);
    }

    const action = makeAction('ADD', `Add "${newNode.name}"`, Object.values(nodes), Object.values(working), rootIds, workingRoots);
    set({ nodes: working, rootIds: workingRoots, activeComponentId: nextActive,
          past: pushPast(get().past, action), future: [] });
    get().log(`Created: ${newNode.name} (${newNode.type})`, 'success');
  },

  setActiveComponent: (id) => set({ activeComponentId: id && get().nodes[id]?.type === 'component' ? id : null }),

  createComponent: (name, parentId = null) => {
    const { nodes } = get();
    const count = Object.values(nodes).filter((n) => n.type === 'component').length + 1;
    const parent = parentId && nodes[parentId]?.type === 'assembly' ? parentId : null;
    const comp = makeContainer('component', name ?? `Part ${count}`, parent);
    get().addNode(comp);              // addNode routes structural nodes to root / assembly
    set({ activeComponentId: comp.id });
    return comp.id;
  },

  createAssembly: (name, parentId = null) => {
    const { nodes } = get();
    const count = Object.values(nodes).filter((n) => n.type === 'assembly').length + 1;
    const parent = parentId && nodes[parentId]?.type === 'assembly' ? parentId : null;
    const asm = makeContainer('assembly', name ?? `Assembly ${count}`, parent);
    get().addNode(asm);
    return asm.id;
  },

  loadScene: (nodes, rootIds) => {
    set({ nodes: { ...nodes }, rootIds: [...rootIds], selectedIds: [], activeComponentId: null, past: [], future: [] });
    get().migrateToComponentTree();
  },

  newProject: () => {
    // Wipe the viewport (meshes + sketch/datum visuals) BEFORE clearing the
    // store — the registry frees orphaned shapes via its store subscription.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cad-scene-reset'));
    set({ nodes: {}, rootIds: [], selectedIds: [], activeComponentId: null, past: [], future: [] });
    get().log('New project.', 'info');
  },

  saveProject: async (name) => {
    const { nodes, rootIds } = get();
    const doc = ProjectFileService.build(nodes, rootIds, name);
    const result = await ProjectFileService.save(doc);
    if (result === 'cancelled') {
      get().log('Save cancelled.', 'info');
    } else if (result === 'downloaded') {
      get().log(`Project downloaded as "${doc.name}.tkcad".`, 'success');
    } else {
      get().log(`Project saved as "${doc.name}.tkcad".`, 'success');
    }
  },

  loadProject: (jsonString) => {
    let doc;
    try {
      doc = ProjectFileService.parse(jsonString);
    } catch (err: any) {
      get().log(`Open failed: ${err?.message ?? err}`, 'error');
      return;
    }
    // Clear stale meshes first: a loaded scene uses the saved node ids, so the
    // old meshes would never receive a cad-remove-mesh on their own.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cad-scene-reset'));
    // loadScene replaces nodes/rootIds and clears past/future + selection.
    get().loadScene(doc.nodes, doc.rootIds);
    // Shapes aren't serialized — rebuild all geometry from the feature tree.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cad-rebuild-all'));
    get().log(`Opened "${doc.name}" — rebuilding geometry…`, 'success');
  },

  migrateToComponentTree: () => {
    const { nodes, rootIds } = get();
    // Misplaced = a feature/datum NOT directly under a component (root-level, or
    // nested under a 3D op via the old adoptSketchSources behaviour).
    const misplaced = Object.values(nodes).filter((n) => {
      if (!isFeature(n.type) && !isDatum(n.type)) return false;
      const parent = n.parentId ? nodes[n.parentId] : null;
      return !parent || parent.type !== 'component';
    });
    if (misplaced.length === 0) { set({ activeComponentId: Object.values(nodes).find((n) => n.type === 'component')?.id ?? null }); return; }

    const ensured = ensureComponentIn({ ...nodes }, [...rootIds], null);
    const working = ensured.nodes;
    let workingRoots = ensured.rootIds;
    for (const n of misplaced) {
      workingRoots = detachFromParent(working, workingRoots, n.id);
      working[n.id] = { ...working[n.id], parentId: ensured.componentId };
      working[ensured.componentId] = {
        ...working[ensured.componentId],
        children: [...working[ensured.componentId].children, n.id],
      };
    }
    set({ nodes: working, rootIds: workingRoots, activeComponentId: ensured.componentId });
    get().log(`Organized ${misplaced.length} feature(s) under "${working[ensured.componentId].name}".`, 'info');
  },

  addSketchEntities: (nodeList, sketchId, autoConstraints, label) => {
    if (!nodeList.length) return;
    const { nodes, rootIds } = get();
    const updated: Record<string, CADNode> = { ...nodes };
    for (const nd of nodeList) {
      updated[nd.id] = { ...nd, children: [], material: normalizeMaterial(nd.material) };
    }
    const updatedRootIds = [...rootIds];
    for (const nd of nodeList) {
      if (nd.parentId && updated[nd.parentId]) {
        updated[nd.parentId] = { ...updated[nd.parentId], children: [...updated[nd.parentId].children, nd.id] };
      } else {
        updatedRootIds.push(nd.id);
      }
    }
    // Append the auto-constraints (corner coincidences, edge H/V) to the sketch
    // container so the solver treats the decomposed shape as a real rectangle.
    if (sketchId && updated[sketchId] && autoConstraints?.length) {
      const existing = (updated[sketchId].params?.constraints as SketchConstraint[] | undefined) ?? [];
      updated[sketchId] = {
        ...updated[sketchId],
        params: { ...updated[sketchId].params, constraints: [...existing, ...autoConstraints] },
      };
    }
    const name = label ?? nodeList[0]?.name ?? 'entities';
    const action = makeAction('ADD', `Add "${name}"`, Object.values(nodes), Object.values(updated), rootIds, updatedRootIds);
    set({ nodes: updated, rootIds: updatedRootIds, past: pushPast(get().past, action), future: [] });
    get().log(`Created: ${name} (${nodeList.length} edges)`, 'success');
  },

  applySketchCornerEdit: ({ description, sketchId, geomUpdates = [], addNodes = [], removeIds = [], constraints }) => {
    const { nodes, rootIds } = get();
    const before = Object.values(nodes);
    const updated: Record<string, CADNode> = { ...nodes };

    // In-place geometry edits (shortened lines keep their id → their other
    // constraints survive; the diff still captures the geom change for undo).
    for (const u of geomUpdates) {
      if (updated[u.id]) updated[u.id] = { ...updated[u.id], params: { ...updated[u.id].params, sketchGeom: u.sketchGeom } };
    }
    // Remove nodes (e.g. the exploded polyline) and detach from their parent.
    for (const rid of removeIds) {
      const n = updated[rid];
      if (!n) continue;
      if (n.parentId && updated[n.parentId]) {
        updated[n.parentId] = { ...updated[n.parentId], children: updated[n.parentId].children.filter((c) => c !== rid) };
      }
      delete updated[rid];
    }
    // Add new nodes under their (sketch) parent.
    for (const nd of addNodes) updated[nd.id] = { ...nd, children: [], material: normalizeMaterial(nd.material) };
    for (const nd of addNodes) {
      if (nd.parentId && updated[nd.parentId]) {
        updated[nd.parentId] = { ...updated[nd.parentId], children: [...updated[nd.parentId].children, nd.id] };
      }
    }
    // Replace the sketch's constraint list wholesale.
    if (updated[sketchId]) {
      updated[sketchId] = { ...updated[sketchId], params: { ...updated[sketchId].params, constraints } };
    }

    const action = makeAction('ADD', description, before, Object.values(updated), rootIds, rootIds);
    set({ nodes: updated, past: pushPast(get().past, action), future: [] });
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
    const { nodes, rootIds, sketchSession } = get();
    if (!nodes[id]) return;

    const nodesBefore  = Object.values(nodes);
    const updatedNodes = { ...nodes };
    const deletedIds:  string[] = [];

    // Recursive subtree delete. With profiles referenced by id (params.targetWireIds)
    // rather than owned as children, a 3D operation has no sketch children — so
    // deleting an Extrusion/Revolve removes only the operation and leaves its
    // profile Sketch as a sibling in the component (reuse-safe). Deleting a
    // component/assembly walks its children, so every feature/sub-component goes
    // with it.
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

    // Cascading constraint cleanup: a deleted sketch entity must take its
    // constraints with it. Strip every constraint on a SURVIVING sketch
    // container that references any deleted node — otherwise dangling
    // constraints linger in params.constraints, pollute the panel, and falsely
    // over/under-constrain the system.
    const deletedSet = new Set(deletedIds);
    for (const nid of Object.keys(updatedNodes)) {
      const n = updatedNodes[nid];
      const cons = n.params?.constraints as SketchConstraint[] | undefined;
      if (!Array.isArray(cons) || cons.length === 0) continue;
      const kept = cons.filter((c) => {
        const refs = (c.refs ?? []) as SketchRef[];
        const legacy = ((c as any).entityIds ?? []) as string[];
        return !refs.some((r) => deletedSet.has(r.id)) && !legacy.some((e) => deletedSet.has(e));
      });
      if (kept.length !== cons.length) {
        updatedNodes[nid] = { ...n, params: { ...n.params, constraints: kept } };
      }
    }

    const updatedRootIds = rootIds.filter((r) => !deletedIds.includes(r));
    if (parentId && updatedNodes[parentId]) {
      updatedNodes[parentId] = {
        ...updatedNodes[parentId],
        children: updatedNodes[parentId].children.filter((c) => c !== id),
      };
    }

    // If the active sketch (or an ancestor of it) was just deleted, end the
    // sketch session — otherwise the app stays "in" a sketch that no longer
    // exists, blocking starting another sketch or extruding a different one.
    const activeSketchDeleted = !!sketchSession && deletedIds.includes(sketchSession.id);
    const activeComponentDeleted = !!get().activeComponentId && deletedIds.includes(get().activeComponentId!);

    set({
      nodes: updatedNodes, rootIds: updatedRootIds,
      selectedIds: get().selectedIds.filter((s) => s !== id),
      past: pushPast(get().past, makeAction('DELETE', `Delete "${deletedName}"`, nodesBefore, Object.values(updatedNodes), rootIds, updatedRootIds)),
      future: [],
      ...(activeSketchDeleted ? { sketchSession: null, interactionMode: 'SELECT' as InteractionMode } : {}),
      ...(activeComponentDeleted ? { activeComponentId: null } : {}),
    });

    if (activeSketchDeleted) {
      get().log(`Sketch "${sketchSession!.name}" was deleted — sketch mode ended.`, 'info');
    }

    // Notify the viewport to remove all deleted Three.js objects
    deletedIds.forEach((did) =>
      window.dispatchEvent(new CustomEvent('cad-remove-mesh', { detail: { id: did } }))
    );
    // Re-show restored input meshes
    restoredIds.forEach((rid) =>
      window.dispatchEvent(new CustomEvent('cad-visibility-changed', { detail: { id: rid, visible: true } }))
    );

    const notes = [
      restoredIds.length ? `restored ${restoredIds.length} input${restoredIds.length > 1 ? 's' : ''}` : '',
      deletedIds.length > 1 ? `removed ${deletedIds.length} node${deletedIds.length > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(', ');
    get().log(`Deleted: ${deletedName}${notes ? ` (${notes})` : ''}`, 'warn');
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
    const { nodes, rootIds } = get();
    if (!nodes[id]) return;
    const nodesBefore  = Object.values(nodes);
    const updatedNodes = { ...nodes, [id]: { ...nodes[id], name } };
    set({
      nodes: updatedNodes,
      past: pushPast(get().past, makeAction('RENAME', `Rename → "${name}"`, nodesBefore, Object.values(updatedNodes), rootIds, rootIds)),
      future: [],
    });
  },

  // Commits a final transform to undo history (drag-end, panel input)
  updateTransform: (id, position, rotation, scale) => {
    const { nodes, rootIds } = get();
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
      past:  pushPast(get().past, makeAction('TRANSFORM', 'Transform', nodesBefore, Object.values(updatedNodes), rootIds, rootIds)),
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
    const { nodes, rootIds } = get();
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
      past:  pushPast(get().past, makeAction('MATERIAL', 'Change material', nodesBefore, Object.values(updatedNodes), rootIds, rootIds)),
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
    const { past, future, nodes: currentNodes } = get();
    if (past.length === 0) return;
    const action = past[past.length - 1];

    const restoredNodes = applyDeltas(currentNodes, action.deltas, 'undo');
    // Scene diff so the Viewport stays in sync.
    const added   = Object.keys(restoredNodes).filter((id) => !currentNodes[id]);
    const removed = Object.keys(currentNodes).filter((id) => !restoredNodes[id]);

    set({
      nodes:       restoredNodes,
      rootIds:     reconcileRoots(action.rootBefore, restoredNodes),   // exact pre-action order
      selectedIds: [],
      past:        past.slice(0, -1),
      future:      [action, ...future],
    });

    syncScene(added, removed, restoredNodes);
    const reWires = sketchWiresWithChangedGeom(currentNodes, restoredNodes);
    if (reWires.length) window.dispatchEvent(new CustomEvent('cad-sketch-rebuild', { detail: { ids: reWires } }));
    get().log(`Undo: ${action.description}`, 'info');
  },

  redo: () => {
    const { past, future, nodes: currentNodes } = get();
    if (future.length === 0) return;
    const action = future[0];

    const restoredNodes = applyDeltas(currentNodes, action.deltas, 'redo');
    const added   = Object.keys(restoredNodes).filter((id) => !currentNodes[id]);
    const removed = Object.keys(currentNodes).filter((id) => !restoredNodes[id]);

    set({
      nodes:       restoredNodes,
      rootIds:     reconcileRoots(action.rootAfter, restoredNodes),    // exact post-action order
      selectedIds: [],
      past:        [...past, action],
      future:      future.slice(1),
    });

    syncScene(added, removed, restoredNodes);
    const reWires = sketchWiresWithChangedGeom(currentNodes, restoredNodes);
    if (reWires.length) window.dispatchEvent(new CustomEvent('cad-sketch-rebuild', { detail: { ids: reWires } }));
    get().log(`Redo: ${action.description}`, 'info');
  },
}));
