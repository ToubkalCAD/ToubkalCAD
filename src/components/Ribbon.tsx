// ============================================================
// ToubkalCAD – Ribbon.tsx
//
// R1 (command registry) + R2 (tabbed ribbon shell).
// Replaces the two flat overflow-scroll toolbars (CADToolbar +
// AdvancedToolbar) with an Office/Chili3D-style ribbon:
//   • a short tab strip (Sketch · Model · Modify · Tools)
//   • a command row showing only the active tab's groups
//   • a persistent right zone (plane indicator, sketch badge, undo/redo)
//
// Commands are data: { id, icon, label, run, enabled, active, accent }.
// Tabs reference command ids. This is the foundation for R3 (contextual
// tabs) and R4 (Quick Access Toolbar + Customize dialog).
// ============================================================

import React, { useState } from 'react';
import { useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS, InteractionMode, STANDARD_WORKPLANES, DATUM_TYPES } from '../store/cadStore';
import { Icon, IconName }            from './Icon';
import { showParamModal }           from './ParameterModal';
import { OccPrimitivesService }     from '../services/OccPrimitivesService';
import { OccExchangeService }       from '../services/OccExchangeService';
import { OccRevolutionService }     from '../services/OccRevolutionService';
import { OccLoftService }           from '../services/OccLoftService';
import { OccSweepService }          from '../services/OccSweepService';
import { OccSketchService, fromLocal2D } from '../services/OccSketchService';
import { findRegions, RegionEntity, toRegionEntity } from '../services/SketchRegions';
import { setAlignOffset } from '../hooks/useCADAssemblyMate';
import { resolveProfileWire, resolveAllProfileWires, profileShapeFor, canResolveProfile, sketchRegionCount } from '../utils/sketchProfile';
import { createAndEditOp } from './Op3DPanel';
import { createSketchEntityNode } from '../utils/sketchEntity';
import { transformGeom, translator } from '../services/SketchTransform2D';
import { beginSketchMirror, beginSketchCircular } from '../hooks/useCADSketchTransformPick';
import { OccTransformService, PlaneLabel } from '../services/OccTransformService';
import { CADGeometryRegistry }      from '../services/CADGeometryRegistry';
import { getPlacedShape }           from '../utils/placedShape';
import { showBlendPanel }           from './BlendActionPanel';
import { showBooleanPanel }         from './BooleanActionPanel';
import { showConstraintPanel }      from './ConstraintPanel';

declare global { interface Window { oc: any; } }

// ─── Command + tab model ─────────────────────────────────────────────────────

interface Command {
  id:       string;
  icon:     IconName;
  label:    string;
  run:      () => void;
  enabled?: boolean;   // default true
  active?:  boolean;
  accent?:  string;
  tooltip?: string;
}
interface RibbonGroup { label: string; ids: string[]; }
interface RibbonTab   { id: string; label: string; groups: RibbonGroup[]; }

// Declarative layout — each tab references command ids defined in the registry.
const RIBBON_TABS: RibbonTab[] = [
  { id: 'sketch', label: 'Sketch', groups: [
    { label: 'Basic',       ids: ['line', 'circle', 'rect', 'arc'] },
    { label: 'Curves',      ids: ['arc3p', 'ellipse', 'bezier', 'spline'] },
    { label: 'Advanced',    ids: ['roundrect', 'polygon'] },
    { label: 'Modify',      ids: ['trim', 'extend', 'split', 'powertrim', 'region'] },
    { label: 'Datum',       ids: ['sketch-face', 'sketch-datum'] },
    { label: 'Reference',   ids: ['sketch-project', 'sketch-intersect'] },
    { label: 'Constrain',   ids: ['constraints'] },
  ] },
  { id: 'model', label: 'Model', groups: [
    { label: 'Structure',   ids: ['component', 'assembly'] },
    { label: 'Primitives',  ids: ['box', 'cylinder', 'sphere', 'torus', 'cone'] },
    { label: 'From Sketch', ids: ['extrude', 'revolve', 'loft', 'sweep'] },
    { label: 'Transform',   ids: ['mirror', 'array-lin', 'array-circ'] },
    { label: 'Datum',       ids: ['datum-origin', 'datum-offset', 'datum-3point', 'datum-midplane', 'datum-angle', 'datum-axis', 'datum-point', 'datum-tangent', 'datum-curvenormal', 'datum-2edge'] },
    { label: 'Assembly',    ids: ['mate', 'align', 'concentric'] },
  ] },
  { id: 'modify', label: 'Modify', groups: [
    { label: 'Edges',       ids: ['fillet', 'chamfer'] },
    { label: 'Boolean',     ids: ['union', 'subtract', 'intersect'] },
  ] },
  { id: 'tools', label: 'Tools', groups: [
    { label: 'Interact',    ids: ['select', 'measure'] },
    { label: 'View',        ids: ['fit-all'] },
    { label: 'File',        ids: ['import', 'export'] },
  ] },
];

// ─── Button + chrome sub-components ───────────────────────────────────────────

const Sep = () => <div className="cad-sep" />;
const Grp: React.FC<{ label: string }> = ({ label }) => <span className="cad-grp">{label}</span>;

const tint       = (a: string) => (a.startsWith('#') ? a + '22' : 'var(--accent-soft)');
const tintBorder = (a: string) => (a.startsWith('#') ? a + '88' : 'var(--accent-line)');

const CmdBtn: React.FC<{ cmd: Command }> = ({ cmd }) => {
  const accent = cmd.accent ?? 'var(--accent)';
  return (
    <button
      className="cad-btn"
      data-active={cmd.active ? 'true' : 'false'}
      onClick={cmd.run}
      disabled={cmd.enabled === false}
      title={cmd.tooltip ?? cmd.label}
      style={cmd.active ? { background: tint(accent), color: accent, borderColor: tintBorder(accent) } : undefined}
    >
      <Icon name={cmd.icon} size={15} color={cmd.active ? accent : undefined} />
      <span>{cmd.label}</span>
    </button>
  );
};

// ─── Ribbon ───────────────────────────────────────────────────────────────────

export const Ribbon: React.FC = () => {
  const mode            = useCADStore((s) => s.interactionMode);
  const selIds          = useCADStore((s) => s.selectedIds);
  const nodes           = useCADStore((s) => s.nodes);
  const past            = useCADStore((s) => s.past);
  const future          = useCADStore((s) => s.future);
  const polygonSides    = useCADStore((s) => s.sketchPolygonSides);
  const activeWorkplane = useCADStore((s) => s.activeWorkplane);
  const openPlaneSel    = useCADStore((s) => s.openPlaneSelector);
  const setMode         = useCADStore((s) => s.setInteractionMode);
  const addNode         = useCADStore((s) => s.addNode);
  const setProc         = useCADStore((s) => s.setProcessing);
  const log             = useCADStore((s) => s.log);
  const sketchSession   = useCADStore((s) => s.sketchSession);
  const quitSketch      = useCADStore((s) => s.quitSketchSession);

  const [activeTab, setActiveTab] = useState<string>('sketch');

  const reg = CADGeometryRegistry.getInstance();

  // If already in a session: switch tool directly. Otherwise open plane selector.
  const startSketch = (sketchMode: InteractionMode) => {
    if (useCADStore.getState().sketchSession) setMode(sketchMode);
    else openPlaneSel(sketchMode);
  };

  // S2 — enter face-pick mode; clicking a planar face starts a sketch on it.
  const sketchOnFace = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch before starting a new one.', 'warn'); return; }
    if (!window.oc) { log('OCC kernel not initialized.', 'error'); return; }
    setMode('FACE_SKETCH');
  };

  // ─── Reference geometry (Track D) — datum planes are pure data, no OCC needed ──
  const datumOrigin = () => {
    const st = useCADStore.getState();
    // Only auto-frame when this is a fresh scene (no real geometry yet) — so the
    // origin planes are framed on first load, but creating them later beside an
    // existing model doesn't yank the camera.
    const wasEmpty = !Object.values(st.nodes).some((n) => !DATUM_TYPES.has(n.type));
    (['XY', 'YZ', 'ZX'] as const).forEach((k) => st.createDatumPlane(STANDARD_WORKPLANES[k], 'origin'));
    if (wasEmpty) {
      // Defer past React's commit so the datum visuals have synced into the
      // scene (they're built in a post-render effect) before we measure them.
      requestAnimationFrame(() => requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent('cad-frame-all'))));
    }
  };
  const sketchOnDatum = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch before starting a new one.', 'warn'); return; }
    const hasDatum = Object.values(useCADStore.getState().nodes).some((n) => n.type === 'datum_plane');
    if (!hasDatum) { log('No reference planes yet — create one first (Model ▸ Datum).', 'warn'); return; }
    setMode('DATUM_SKETCH');
  };
  // D2 — pick a planar face or datum plane in the viewport, then offset it by a
  // distance into a new datum plane (the pick + prompt live in useCADDatumOffsetPick).
  // D11 / D12 — Project & Intersect onto the ACTIVE sketch (logic in their hooks).
  const sketchProject = () => {
    if (!useCADStore.getState().sketchSession) { log('Start or open a sketch first.', 'warn'); return; }
    if (!hasAnySolid) { log('No solids to project from.', 'warn'); return; }
    log('Click edges to project onto the sketch (Esc to finish).', 'info');
    setMode('PROJECT_PICK');
  };
  const sketchIntersect = () => {
    if (!useCADStore.getState().sketchSession) { log('Start or open a sketch first.', 'warn'); return; }
    if (!hasAnySolid) { log('No solids to intersect.', 'warn'); return; }
    log('Click a body to intersect with the sketch plane.', 'info');
    setMode('INTERSECT_PICK');
  };
  const datumOffset = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    const ns = Object.values(useCADStore.getState().nodes);
    const hasSolid = ns.some((n) => !['sketch','sketch_wire','datum_plane','datum_axis','datum_point'].includes(n.type));
    const hasDatum = ns.some((n) => n.type === 'datum_plane');
    if (!hasSolid && !hasDatum) { log('Create a solid or origin planes first to offset from.', 'warn'); return; }
    log('Pick a planar face or a datum plane to offset from.', 'info');
    setMode('DATUM_OFFSET_PICK');
  };
  // D4 — pick 3 vertices in the viewport → plane through them (in useCADDatum3PointPick).
  const datum3Point = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    const hasSolid = Object.values(useCADStore.getState().nodes)
      .some((n) => !['sketch','sketch_wire','datum_plane','datum_axis','datum_point'].includes(n.type));
    if (!hasSolid) { log('Create a solid first — 3-point planes snap to its vertices.', 'warn'); return; }
    log('Pick 3 vertices to define a plane.', 'info');
    setMode('DATUM_3POINT_PICK');
  };
  // D5 — pick 2 planar faces / datums → plane midway between them (in useCADDatumMidplanePick).
  const datumMidplane = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    const ns = Object.values(useCADStore.getState().nodes);
    const hasSolid = ns.some((n) => !['sketch','sketch_wire','datum_plane','datum_axis','datum_point'].includes(n.type));
    const hasDatum = ns.some((n) => n.type === 'datum_plane');
    if (!hasSolid && !hasDatum) { log('Create a solid or origin planes first.', 'warn'); return; }
    log('Pick two planar faces or datums to find their midplane.', 'info');
    setMode('DATUM_MIDPLANE_PICK');
  };
  // D3 — pick a planar face, then one of its straight edges → plane tilted by an
  // angle about that edge (in useCADDatumAnglePick).
  const datumAngle = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    const hasSolid = Object.values(useCADStore.getState().nodes)
      .some((n) => !['sketch','sketch_wire','datum_plane','datum_axis','datum_point'].includes(n.type));
    if (!hasSolid) { log('Create a solid first — angled planes hinge about its edges.', 'warn'); return; }
    log('Pick a planar face, then an edge to hinge about.', 'info');
    setMode('DATUM_ANGLE_PICK');
  };
  // D7 — pick a straight edge or a cylindrical face → datum axis (in useCADDatumAxisPick).
  const datumAxis = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    const hasSolid = Object.values(useCADStore.getState().nodes)
      .some((n) => !['sketch','sketch_wire','datum_plane','datum_axis','datum_point'].includes(n.type));
    if (!hasSolid) { log('Create a solid first — axes snap to its edges / cylinders.', 'warn'); return; }
    log('Pick a straight edge or a cylindrical face for the axis.', 'info');
    setMode('DATUM_AXIS_PICK');
  };
  // D8 — pick a vertex or an edge (→ midpoint) → datum point (in useCADDatumPointPick).
  const datumPoint = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    const hasSolid = Object.values(useCADStore.getState().nodes)
      .some((n) => !['sketch','sketch_wire','datum_plane','datum_axis','datum_point'].includes(n.type));
    if (!hasSolid) { log('Create a solid first — points snap to its vertices / edges.', 'warn'); return; }
    log('Pick a vertex or an edge for the point.', 'info');
    setMode('DATUM_POINT_PICK');
  };
  // D6 — advanced planes. Each just enters a pick mode (logic in its hook).
  const hasSolidNow = () => Object.values(useCADStore.getState().nodes)
    .some((n) => !['sketch','sketch_wire','datum_plane','datum_axis','datum_point'].includes(n.type));
  const datumTangent = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    if (!hasSolidNow()) { log('Create a solid with a cylindrical face first.', 'warn'); return; }
    log('Click a point on a cylindrical face for a tangent plane.', 'info');
    setMode('DATUM_TANGENT_PICK');
  };
  const datumCurveNormal = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    if (!hasSolidNow()) { log('Create a solid first — pick one of its edges.', 'warn'); return; }
    log('Pick an edge to place a plane normal to it.', 'info');
    setMode('DATUM_CURVE_NORMAL_PICK');
  };
  const datum2Edge = () => {
    if (useCADStore.getState().sketchSession) { log('Quit the current sketch first.', 'warn'); return; }
    if (!hasSolidNow()) { log('Create a solid first — pick two of its edges.', 'warn'); return; }
    log('Pick two coplanar edges to define a plane.', 'info');
    setMode('DATUM_2EDGE_PICK');
  };

  // ─── Helpers (verbatim from CADToolbar) ─────────────────────────────────────
  // `params` is the feature RECIPE (op knobs + input ids) — persisted so the
  // parametric graph (FeatureGraph) can recover inputs and, later, replay the op.
  const create = (id: string, name: string, type: any, shape: any, params?: Record<string, any>) => {
    reg.registerShape(id, shape);
    addNode({
      id, name, type, visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS[type as keyof typeof NODE_TYPE_COLORS] ?? 0x5588cc },
      ...(params ? { params } : {}),
    });
    window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
    log(`${name} created.`, 'success');
  };

  const withOC = (fn: () => Promise<void> | void) => {
    if (!window.oc) { log('OCC kernel not initialized.', 'error'); return; }
    Promise.resolve().then(fn).catch((e: any) => { log(e.message, 'error'); });
  };

  // ─── Structure (assembly tree) ────────────────────────────────────────────────
  // Create a component/assembly and select it. A new component becomes active, so
  // the next sketch/primitive/op lands inside it. If an assembly is selected, the
  // new container nests under it.
  const mkComponent = () => {
    const st = useCADStore.getState();
    const sel = st.selectedIds[0];
    const parent = sel && st.nodes[sel]?.type === 'assembly' ? sel : null;
    const id = st.createComponent(undefined, parent);
    st.setSelectedIds([id]);
  };
  const mkAssembly = () => {
    const st = useCADStore.getState();
    const sel = st.selectedIds[0];
    const parent = sel && st.nodes[sel]?.type === 'assembly' ? sel : null;
    const id = st.createAssembly(undefined, parent);
    st.setSelectedIds([id]);
  };

  // ─── Primitives ─────────────────────────────────────────────────────────────
  const mkBox = () => withOC(async () => {
    const v = await showParamModal('Create Box', [
      { key: 'w', label: 'Width X',  default: 10, min: 0.01, unit: 'mm' },
      { key: 'h', label: 'Height Y', default: 10, min: 0.01, unit: 'mm' },
      { key: 'd', label: 'Depth Z',  default: 10, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Box ${v.w}×${v.h}×${v.d}`, 'box',
      OccPrimitivesService.createBox(window.oc, v.w, v.h, v.d), { w: v.w, h: v.h, d: v.d });
  });

  const mkCyl = () => withOC(async () => {
    const v = await showParamModal('Create Cylinder', [
      { key: 'r', label: 'Radius', default: 5,  min: 0.01, unit: 'mm' },
      { key: 'h', label: 'Height', default: 15, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Cylinder r${v.r}h${v.h}`, 'cylinder',
      OccPrimitivesService.createCylinder(window.oc, v.r, v.h), { r: v.r, h: v.h });
  });

  const mkSph = () => withOC(async () => {
    const v = await showParamModal('Create Sphere', [
      { key: 'r', label: 'Radius', default: 7, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Sphere r${v.r}`, 'sphere',
      OccPrimitivesService.createSphere(window.oc, v.r), { r: v.r });
  });

  const mkTorus = () => withOC(async () => {
    const v = await showParamModal('Create Torus', [
      { key: 'R', label: 'Major radius', default: 15, min: 0.01, unit: 'mm' },
      { key: 'r', label: 'Tube radius',  default: 3,  min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Torus R${v.R}r${v.r}`, 'compound',
      OccRevolutionService.createTorus(window.oc, v.R, v.r), { featureOp: 'torus', R: v.R, r: v.r });
  });

  const mkCone = () => withOC(async () => {
    const v = await showParamModal('Create Cone', [
      { key: 'r1', label: 'Base radius',  default: 8,  min: 0,    unit: 'mm' },
      { key: 'r2', label: 'Top radius',   default: 0,  min: 0,    unit: 'mm' },
      { key: 'h',  label: 'Height',       default: 15, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Cone r${v.r1}/r${v.r2}h${v.h}`, 'compound',
      OccRevolutionService.createCone(window.oc, v.r1, v.r2, v.h), { featureOp: 'cone', r1: v.r1, r2: v.r2, h: v.h });
  });

  // ─── Modifications (per-edge blend panel) ───────────────────────────────────
  const openBlend = (op: 'fillet' | 'chamfer') => {
    if (!selIds.length) { log('Select a solid first.', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (!node || node.type === 'sketch' || node.type === 'sketch_wire') {
      log('Select a 3D solid (not a sketch) to fillet/chamfer.', 'warn'); return;
    }
    if (!reg.getShape(selIds[0])) { log('Shape not found in registry.', 'error'); return; }
    showBlendPanel(selIds[0], op);
  };

  // ─── Boolean operations (guided panel) ──────────────────────────────────────
  const boolOp = (op: 'CUT' | 'FUSE' | 'COMMON') => {
    const solids = selIds.filter((id) => {
      const t = nodes[id]?.type;
      return t && t !== 'sketch' && t !== 'sketch_wire' && reg.getShape(id);
    });
    showBooleanPanel(op, solids[0] ?? null, solids.slice(1));
  };

  // ─── Constraints ────────────────────────────────────────────────────────────
  const constrainTargetId = (): string | null => {
    const session = useCADStore.getState().sketchSession;
    if (session) return session.id;
    const sel = nodes[selIds[0]];
    if (sel?.type === 'sketch') return sel.id;
    if (sel?.type === 'sketch_wire' && sel.parentId && nodes[sel.parentId]?.type === 'sketch') return sel.parentId;
    return null;
  };
  const openConstraints = () => {
    const id = constrainTargetId();
    if (!id) { log('Select a sketch (or be in a sketch session) to add constraints.', 'warn'); return; }
    showConstraintPanel(id);
  };

  // ─── Sketch editing (S1 — trim / extend / split) ─────────────────────────────
  // Needs an active sketch session so sibling entities are visible/pickable; if
  // a sketch is merely selected, resume it first.
  const startEdit = (m: InteractionMode) => {
    const st = useCADStore.getState();
    if (st.sketchSession) { setMode(m); return; }
    const id = constrainTargetId();
    if (!id) { log('Open or select a sketch to trim/extend/split its lines.', 'warn'); return; }
    st.resumeSketchSession(id);
    setMode(m);
  };

  // ─── Auto-region close — detect closed loops → extrudable profile(s) ──────────
  const closeRegions = () => {
    const sketchId = constrainTargetId();
    if (!sketchId) { log('Open or select a sketch to detect regions.', 'warn'); return; }
    withOC(() => {
      const st = useCADStore.getState();
      const ents = Object.values(st.nodes).filter(
        (n) => n.type === 'sketch_wire' && n.parentId === sketchId && n.params?.sketchGeom,
      );
      if (!ents.length) { log('This sketch has no editable curves.', 'warn'); return; }
      const wp = ents[0].params!.workplane;
      const regionEnts = ents
        .map((n) => toRegionEntity(n.id, n.params!.sketchGeom))
        .filter((e): e is RegionEntity => !!e);
      const regions = findRegions(regionEnts);
      if (!regions.length) { log('No closed regions found in this sketch.', 'warn'); return; }

      const geomOf = (id: string) => useCADStore.getState().nodes[id]?.params?.sketchGeom;
      const newIds: string[] = [];
      let faceted = 0;
      regions.forEach((rg, i) => {
        const built = OccSketchService.buildRegionProfileWire(window.oc, rg, geomOf, wp);
        const wire = built.wire;
        if (built.faceted) faceted++;
        const id = crypto.randomUUID();
        reg.registerShape(id, wire);
        addNode({
          id, name: `Region ${i + 1}`, type: 'sketch_wire',
          visible: true, locked: false, parentId: sketchId, notes: '',
          transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
          material:  { color: 0x00aa66, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
          // No sketchGeom: a Region is a finished closed profile, not an editable
          // entity — this keeps it out of trim/constraint/region-detection passes.
          // memberIds = the entity wires this region was traced from: the recompute
          // engine re-detects the region from them (DAG inputs) so it rebuilds when
          // a member moves or its sketch-on-face frame is re-derived.
          params: { workplane: wp, region: true, regionArea: rg.area, memberIds: rg.members.map((m) => m.id) },
        });
        window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', {
          detail: { id, pts: rg.loop.map((p) => { const v = fromLocal2D(p[0], p[1], wp); return [v.x, v.y, v.z]; }) },
        }));
        newIds.push(id);
      });
      st.setSelectedIds(newIds);
      const facetNote = faceted ? ` (${faceted} faceted — corners didn't meet exactly)` : '';
      log(`Found ${regions.length} region${regions.length === 1 ? '' : 's'}${facetNote} → select one and Extrude.`, 'success');
    });
  };

  // ─── Assembly: Align (parallel faces with offset) — ask offset, then pick ─────
  const alignParallel = () => {
    withOC(async () => {
      const v = await showParamModal('Align (Parallel)', [
        { key: 'offset', label: 'Offset', default: 0, unit: 'mm' },
      ]);
      if (!v) return;
      setAlignOffset(v.offset);
      setMode('ASSEMBLY_ALIGN');
    });
  };

  // Resolve the profile wire id for the selected sketch / sketch-wire (or null).
  // A sketch container of several open edges → its enclosed region is built.
  const profileWireFor = (): string | null => {
    const node = nodes[selIds[0]];
    if (node?.type === 'sketch_wire') return selIds[0];
    if (node?.type === 'sketch') {
      const childIds = Object.values(useCADStore.getState().nodes)
        .filter((n) => n.parentId === node.id && n.type === 'sketch_wire')
        .map((n) => n.id);
      return resolveProfileWire(node.id, childIds);
    }
    return null;
  };

  // Single-profile target for extrude/revolve: bind to the SKETCH container when
  // one is selected (so the op re-derives its profile from the sketch's current
  // shape every recompute — survives entity move/resize/delete/replace), or the
  // sketch_wire itself when a bare wire is picked. null = no resolvable profile.
  const profileTargetId = (): string | null => {
    const node = nodes[selIds[0]];
    if (node?.type === 'sketch_wire') {
      // Bind a selected wire leaf to its owning sketch so it re-derives on edit.
      const par = node.parentId && nodes[node.parentId]?.type === 'sketch' ? node.parentId : null;
      return par && canResolveProfile(window.oc, par) ? par : selIds[0];
    }
    if (node?.type === 'sketch') return canResolveProfile(window.oc, node.id) ? node.id : null;
    return null;
  };

  // ─── Extrusion ──────────────────────────────────────────────────────────────
  const extrude = () => {
    if (!selIds.length) { log('Select a sketch or sketch wire.', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (node?.type !== 'sketch_wire' && node?.type !== 'sketch') { log('Selected object must be a 2D sketch.', 'warn'); return; }
    withOC(() => {
      const node = nodes[selIds[0]];
      let wireIds: string[];
      if (node?.type === 'sketch') {
        // One region → bind to the SKETCH (re-derive on edit). Several regions →
        // Multi-Pad: extrude each as its own region wire (kept as before).
        if (sketchRegionCount(node.id) > 1) {
          const childIds = Object.values(useCADStore.getState().nodes)
            .filter((n) => n.parentId === node.id && n.type === 'sketch_wire')
            .map((n) => n.id);
          wireIds = resolveAllProfileWires(node.id, childIds);
        } else {
          wireIds = canResolveProfile(window.oc, node.id) ? [node.id] : [];
        }
      } else {
        const w = profileWireFor();
        wireIds = w ? [w] : [];
      }
      if (!wireIds.length) { log('This sketch has no closed region to extrude.', 'warn'); return; }
      // Open the full Pad/Pocket panel (end conditions, reverse, boolean target,
      // live preview) instead of a one-shot height prompt.
      createAndEditOp('extrude', wireIds);
    });
  };

  // ─── Revolve ────────────────────────────────────────────────────────────────
  const revolve = () => {
    if (!selIds.length) { log('Select a sketch or sketch wire.', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (node?.type !== 'sketch_wire' && node?.type !== 'sketch') { log('Selected object must be a 2D sketch.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Revolve', [
        { key: 'axis',  label: 'Axis (0=X 1=Y 2=Z)', default: 1, min: 0, max: 2, step: 1 },
        { key: 'angle', label: 'Angle', default: 360, min: 1, max: 360, unit: '°' },
      ]);
      if (!v) return;
      const targetId = profileTargetId();
      if (!targetId) { log('This sketch has no closed region to revolve.', 'warn'); return; }
      // Bind to the sketch (or wire); build the immediate shape from its current
      // profile and free the temp — the engine rebuilds it from targetWireIds.
      const prof = profileShapeFor(window.oc, targetId);
      if (!prof.shape) { log('Sketch wire not found.', 'error'); return; }
      const axisVecs: [number,number,number][] = [[1,0,0],[0,1,0],[0,0,1]];
      const axisLabels = ['X','Y','Z'];
      const idx = Math.round(Math.max(0, Math.min(2, v.axis)));
      setProc(true, 'Revolving…');
      try {
        const id = crypto.randomUUID();
        create(id, `Revolve${v.angle.toFixed(0)}°/${axisLabels[idx]}`, 'revolve',
          OccRevolutionService.revolveProfile(window.oc, prof.shape, [0,0,0], axisVecs[idx], v.angle),
          { opType: 'revolve', targetWireIds: [targetId], opParams: { axis: idx, angle: v.angle } });
      } finally {
        if (prof.temp && prof.shape) try { prof.shape.delete(); } catch { /*noop*/ }
        setProc(false);
      }
    });
  };

  // ─── Loft ───────────────────────────────────────────────────────────────────
  // Collect ordered loft profile wires from the selection. Accepts both
  // sketch-wire leaves AND sketch containers (resolved to their profile wire),
  // mirroring how Extrude/Revolve treat a selected sketch — so the user can pick
  // the "Sketch N [Face]" rows in the tree, not just the inner wire leaves.
  const loftProfileWireIds = (): string[] => {
    // How many selected wires belong to each parent sketch — a wire that's the
    // SOLE selection from its sketch binds to that sketch (re-derives on edit);
    // several wires from one sketch is an explicit multi-wire loft → keep the wires.
    const selWireParents = new Map<string, number>();
    for (const id of selIds) {
      const n = nodes[id];
      if (n?.type === 'sketch_wire' && n.parentId && nodes[n.parentId]?.type === 'sketch')
        selWireParents.set(n.parentId, (selWireParents.get(n.parentId) ?? 0) + 1);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of selIds) {
      const n = nodes[id];
      if (!n) continue;
      // Bind to the SKETCH container so the loft re-derives its profile from the
      // sketch's CURRENT shape every recompute (survives entity move/resize/
      // delete/replace). profileShapeFor() resolves either id to geometry.
      let wid: string | null = null;
      if (n.type === 'sketch') {
        if (canResolveProfile(window.oc, id)) wid = id;
      } else if (n.type === 'sketch_wire') {
        const par = n.parentId && nodes[n.parentId]?.type === 'sketch' ? n.parentId : null;
        wid = (par && selWireParents.get(par) === 1 && canResolveProfile(window.oc, par)) ? par : id;
      }
      if (wid && !seen.has(wid)) { seen.add(wid); out.push(wid); }
    }
    return out;
  };

  const loft = () => {
    if (loftProfileCount < 2) { log('Select ≥ 2 sketches or sketch wires (Ctrl+click) to loft.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Loft', [
        { key: 'solid', label: 'Solid (1) or Shell (0)', default: 1, min: 0, max: 1, step: 1 },
        { key: 'ruled', label: 'Ruled (1) or Smooth (0)', default: 0, min: 0, max: 1, step: 1 },
      ]);
      if (!v) return;
      const sketchIds = loftProfileWireIds();
      if (sketchIds.length < 2) { log('Need ≥ 2 closed profiles to loft.', 'warn'); return; }
      // Resolve each target (sketch container → its current profile wire, temp;
      // or a registered wire) to geometry. Free the temporaries we build here —
      // the recompute engine rebuilds them on its own from the bound sketch ids.
      const resolved = sketchIds.map((id) => profileShapeFor(window.oc, id));
      const wires = resolved.map((r) => r.shape).filter(Boolean);
      if (wires.length < 2) { resolved.forEach((r) => { if (r.temp && r.shape) try { r.shape.delete(); } catch { /*noop*/ } }); log('Could not retrieve all sketch shapes.', 'error'); return; }
      setProc(true, 'Lofting…');
      try {
        const id = crypto.randomUUID();
        create(id, `Loft(${sketchIds.length})`, 'loft',
          OccLoftService.loftProfiles(window.oc, wires, v.solid >= 0.5, v.ruled >= 0.5),
          { opType: 'loft', targetWireIds: [...sketchIds], opParams: { solid: v.solid >= 0.5 ? 1 : 0, ruled: v.ruled >= 0.5 ? 1 : 0 } });
      } finally {
        resolved.forEach((r) => { if (r.temp && r.shape) try { r.shape.delete(); } catch { /*noop*/ } });
        setProc(false);
      }
    });
  };

  // ─── Sweep ──────────────────────────────────────────────────────────────────
  const sweep = () => {
    const sketchIds = selIds.filter((id) => nodes[id]?.type === 'sketch_wire');
    if (sketchIds.length < 2) { log('Select profile then spine (Ctrl+click) to sweep.', 'warn'); return; }
    withOC(async () => {
      const profile = reg.getShape(sketchIds[0]);
      const spine   = reg.getShape(sketchIds[1]);
      if (!profile || !spine) { log('Could not retrieve sketch shapes.', 'error'); return; }
      setProc(true, 'Sweeping…');
      try {
        const id = crypto.randomUUID();
        create(id, 'Sweep', 'sweep', OccSweepService.sweepProfile(window.oc, profile, spine),
          { opType: 'sweep', targetWireIds: [sketchIds[0], sketchIds[1]], opParams: { spineIndex: 1 } });
      } finally { setProc(false); }
    });
  };

  // ─── Transforms (Track T) ───────────────────────────────────────────────────
  // First selected node that is a solid (not a sketch) with a registered shape.
  const selectedSolidId = (): string | null => {
    for (const id of selIds) {
      const t = nodes[id]?.type;
      if (t && t !== 'sketch' && t !== 'sketch_wire' && reg.getShape(id)) return id;
    }
    return null;
  };

  const AXIS_VEC: [number,number,number][] = [[1,0,0],[0,1,0],[0,0,1]];
  const AXIS_LABEL = ['X','Y','Z'];
  const PLANE_LABEL: PlaneLabel[] = ['XY','YZ','ZX'];

  // ─── 2D sketch transforms (Mirror / Array on sketch entities) ─────────────────
  // Selecting a sketch (all its entities) or one/more sketch wires routes the
  // Transform tools to an in-plane version that emits new sketch entities.
  interface SketchSel { sketchId: string | null; wp: any; entities: { id: string; geom: any }[]; }
  const sketchSelection = (): SketchSel | null => {
    const st = useCADStore.getState();
    const node = st.nodes[selIds[0]];
    let entNodes: any[] = [];
    let sketchId: string | null = null;
    if (node?.type === 'sketch') {
      sketchId = node.id;
      entNodes = Object.values(st.nodes).filter((n) => n.parentId === node.id && n.type === 'sketch_wire' && n.params?.sketchGeom);
    } else {
      entNodes = selIds.map((id) => st.nodes[id]).filter((n) => n?.type === 'sketch_wire' && n.params?.sketchGeom);
      if (entNodes.length) sketchId = entNodes[0].parentId ?? null;
    }
    if (!entNodes.length) return null;
    return { sketchId, wp: entNodes[0].params.workplane, entities: entNodes.map((n) => ({ id: n.id, geom: n.params.sketchGeom })) };
  };

  const emitSketchCopies = (sk: SketchSel, makeXF: (i: number) => { f: any; reverses: boolean }, copies: number, verb: string) => {
    const newIds: string[] = [];
    for (let i = 1; i <= copies; i++) {
      const { f, reverses } = makeXF(i);
      for (const e of sk.entities) {
        const g = transformGeom(e.geom, f, reverses);
        const id = g && createSketchEntityNode(g, sk.wp, sk.sketchId);
        if (id) newIds.push(id);
      }
    }
    useCADStore.getState().setSelectedIds(newIds);
    log(`${verb} → ${newIds.length} new sketch ${newIds.length === 1 ? 'entity' : 'entities'}.`, 'success');
  };

  // Mirror picks its axis interactively (2 points on the plane).
  const mirror2D = (sk: SketchSel) => beginSketchMirror(sk);

  const linearArray2D = (sk: SketchSel) => withOC(async () => {
    const v = await showParamModal('Linear Pattern (Sketch)', [
      { key: 'axis',    label: 'Axis (0=U 1=V)', default: 0, min: 0, max: 1, step: 1 },
      { key: 'spacing', label: 'Spacing', default: 20, min: 0.01, unit: 'mm' },
      { key: 'count',   label: 'Count (incl. original)', default: 4, min: 2, max: 200, step: 1 },
    ]);
    if (!v) return;
    const uAxis = Math.round(v.axis) === 0;
    const count = Math.round(v.count);
    setProc(true, 'Building pattern…');
    try {
      emitSketchCopies(sk, (i) => ({ f: translator(uAxis ? v.spacing * i : 0, uAxis ? 0 : v.spacing * i), reverses: false }), count - 1, `Linear×${count}`);
    } finally { setProc(false); }
  });

  // Circular array asks count/angle, then picks its centre point interactively.
  const circularArray2D = (sk: SketchSel) => withOC(async () => {
    const v = await showParamModal('Circular Pattern (Sketch)', [
      { key: 'angle', label: 'Angle step', default: 45, min: -360, max: 360, unit: '°' },
      { key: 'count', label: 'Count (incl. original)', default: 8, min: 2, max: 360, step: 1 },
    ]);
    if (!v) return;
    beginSketchCircular(sk, Math.round(v.count), v.angle);
  });

  const mirror = () => {
    const sk = sketchSelection();
    if (sk) { mirror2D(sk); return; }
    const srcId = selectedSolidId();
    if (!srcId) { log('Select a solid or sketch to mirror.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Mirror', [
        { key: 'plane', label: 'Plane (0=XY 1=YZ 2=ZX)', default: 0, min: 0, max: 2, step: 1 },
      ]);
      if (!v) return;
      const shape = reg.getShape(srcId);
      if (!shape) { log('Shape not found.', 'error'); return; }
      const placed = getPlacedShape(srcId);
      const plane = PLANE_LABEL[Math.round(Math.max(0, Math.min(2, v.plane)))];
      setProc(true, 'Mirroring…');
      try {
        const id = crypto.randomUUID();
        create(id, `Mirror/${plane} (${nodes[srcId]?.name ?? srcId.slice(0,6)})`, 'mirror',
          OccTransformService.mirror(window.oc, placed, plane), { sourceId: srcId, plane });
      } finally { setProc(false); }
    });
  };

  const linearArray = () => {
    const sk = sketchSelection();
    if (sk) { linearArray2D(sk); return; }
    const srcId = selectedSolidId();
    if (!srcId) { log('Select a solid or sketch to pattern.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Linear Pattern', [
        { key: 'axis',    label: 'Axis (0=X 1=Y 2=Z)', default: 0, min: 0, max: 2, step: 1 },
        { key: 'spacing', label: 'Spacing', default: 20, min: 0.01, unit: 'mm' },
        { key: 'count',   label: 'Count (incl. original)', default: 4, min: 2, max: 200, step: 1 },
      ]);
      if (!v) return;
      const shape = reg.getShape(srcId);
      if (!shape) { log('Shape not found.', 'error'); return; }
      const placed = getPlacedShape(srcId);
      const idx = Math.round(Math.max(0, Math.min(2, v.axis)));
      const count = Math.round(v.count);
      setProc(true, 'Building pattern…');
      try {
        const id = crypto.randomUUID();
        create(id, `Linear×${count}/${AXIS_LABEL[idx]}`, 'pattern',
          OccTransformService.linearPattern(window.oc, placed, AXIS_VEC[idx], v.spacing, count),
          { sourceId: srcId, mode: 'linear', axis: idx, spacing: v.spacing, count });
      } finally { setProc(false); }
    });
  };

  const circularArray = () => {
    const sk = sketchSelection();
    if (sk) { circularArray2D(sk); return; }
    const srcId = selectedSolidId();
    if (!srcId) { log('Select a solid or sketch to pattern.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Circular Pattern', [
        { key: 'axis',  label: 'Axis (0=X 1=Y 2=Z)', default: 2, min: 0, max: 2, step: 1 },
        { key: 'angle', label: 'Angle step', default: 45, min: -360, max: 360, unit: '°' },
        { key: 'count', label: 'Count (incl. original)', default: 8, min: 2, max: 360, step: 1 },
      ]);
      if (!v) return;
      const shape = reg.getShape(srcId);
      if (!shape) { log('Shape not found.', 'error'); return; }
      const placed = getPlacedShape(srcId);
      const idx = Math.round(Math.max(0, Math.min(2, v.axis)));
      const count = Math.round(v.count);
      setProc(true, 'Building pattern…');
      try {
        const id = crypto.randomUUID();
        create(id, `Circular×${count}/${AXIS_LABEL[idx]}`, 'pattern',
          OccTransformService.circularPattern(window.oc, placed, [0,0,0], AXIS_VEC[idx], v.angle, count),
          { sourceId: srcId, mode: 'circular', axis: idx, angle: v.angle, count });
      } finally { setProc(false); }
    });
  };

  // ─── Import / Export ────────────────────────────────────────────────────────
  const importFile = () => {
    if (!window.oc) { log('OCC kernel not initialized.', 'error'); return; }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.stp,.step,.igs,.iges';
    inp.onchange = async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      setProc(true, `Importing ${f.name}…`);
      try {
        const buf = await f.arrayBuffer();
        const fmt = /\.igs|\.iges$/i.test(f.name) ? 'IGES' : 'STEP';
        create(crypto.randomUUID(), f.name.replace(/\.[^.]+$/, ''), 'compound',
          OccExchangeService.importFile(window.oc, buf, fmt));
      } catch (err: any) { log(err.message, 'error'); }
      finally { setProc(false); }
    };
    inp.click();
  };

  const exportFile = () => {
    if (!selIds.length) { log('Select an object to export.', 'warn'); return; }
    if (!window.oc) return;
    try {
      const shape = reg.getShape(selIds[0]);
      if (!shape) { log('Shape not found.', 'error'); return; }
      const data = OccExchangeService.exportSTEP(window.oc, shape);
      const url  = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
      const a    = document.createElement('a');
      a.href = url; a.download = `toubkalcad_${Date.now()}.stp`; a.click();
      URL.revokeObjectURL(url);
      log('STEP export successful.', 'success');
    } catch (err: any) { log(err.message, 'error'); }
  };

  const polygonRun = async () => {
    const v = await showParamModal('Polygon Sides', [
      { key: 'n', label: 'Number of sides', default: polygonSides, min: 3, max: 32, step: 1 },
    ]);
    if (!v) return;
    useCADStore.getState().setSketchPolygonSides(Math.round(v.n));
    startSketch('SKETCH_POLYGON');
  };

  // ─── Derived enable flags ───────────────────────────────────────────────────
  const hasSel       = selIds.length > 0;
  const hasSketch    = hasSel && (nodes[selIds[0]]?.type === 'sketch_wire' || nodes[selIds[0]]?.type === 'sketch');
  const sketchCount  = selIds.filter((id) => nodes[id]?.type === 'sketch_wire').length;
  // Loft profiles: a selected sketch_wire counts directly; a selected sketch
  // container counts if it holds at least one wire (resolved to a profile on run).
  const loftProfileCount = selIds.filter((id) => {
    const t = nodes[id]?.type;
    if (t === 'sketch_wire') return true;
    if (t === 'sketch') return Object.values(nodes).some(
      (n) => n.parentId === id && n.type === 'sketch_wire');
    return false;
  }).length;
  const selType      = hasSel ? nodes[selIds[0]]?.type : undefined;
  const canConstrain = !!sketchSession || selType === 'sketch' || selType === 'sketch_wire';
  const hasSolid     = selIds.some((id) => {
    const t = nodes[id]?.type;
    return t && t !== 'sketch' && t !== 'sketch_wire' && reg.getShape(id);
  });
  // On-Face sketching works on ANY visible solid's face, not just the selected
  // one — gate it on the scene having a solid rather than on the selection.
  const hasAnySolid  = Object.values(nodes).some((n) =>
    n.visible && n.type !== 'sketch' && n.type !== 'sketch_wire' && !!reg.getShape(n.id));
  const SK           = 'var(--sketch)';

  // ─── Command registry (R1) ──────────────────────────────────────────────────
  const commands: Record<string, Command> = {
    // sketch
    line:      { id:'line',      icon:'line',      label:'Line',    run:() => startSketch('SKETCH_LINE'),      active: mode==='SKETCH_LINE',      accent:SK },
    circle:    { id:'circle',    icon:'circle',    label:'Circle',  run:() => startSketch('SKETCH_CIRCLE'),    active: mode==='SKETCH_CIRCLE',    accent:SK },
    rect:      { id:'rect',      icon:'rectangle', label:'Rect',    run:() => startSketch('SKETCH_RECTANGLE'), active: mode==='SKETCH_RECTANGLE', accent:SK },
    arc:       { id:'arc',       icon:'arc',       label:'Arc',     run:() => startSketch('SKETCH_ARC'),       active: mode==='SKETCH_ARC',       accent:SK },
    arc3p:     { id:'arc3p',     icon:'arc3p',     label:'Arc3P',   run:() => startSketch('SKETCH_ARC_3P'),    active: mode==='SKETCH_ARC_3P',    accent:SK },
    ellipse:   { id:'ellipse',   icon:'ellipse',   label:'Ellipse', run:() => startSketch('SKETCH_ELLIPSE'),   active: mode==='SKETCH_ELLIPSE',   accent:SK },
    bezier:    { id:'bezier',    icon:'bezier',    label:'Bezier',  run:() => startSketch('SKETCH_BEZIER'),    active: mode==='SKETCH_BEZIER',    accent:SK },
    spline:    { id:'spline',    icon:'spline',    label:'Spline',  run:() => startSketch('SKETCH_SPLINE'),    active: mode==='SKETCH_SPLINE',    accent:SK },
    roundrect: { id:'roundrect', icon:'roundrect', label:'RndRect', run:() => startSketch('SKETCH_ROUNDED_RECT'), active: mode==='SKETCH_ROUNDED_RECT', accent:SK },
    polygon:   { id:'polygon',   icon:'polygon',   label:'Polygon', run:polygonRun, active: mode==='SKETCH_POLYGON', accent:SK },
    constraints:{id:'constraints',icon:'constraint',label:'Constraints', run:openConstraints, enabled:canConstrain, accent:'#1d9e74' },
    trim:      { id:'trim',   icon:'trim',   label:'Trim',   run:() => startEdit('EDIT_TRIM'),   active: mode==='EDIT_TRIM',   enabled:canConstrain, accent:'#cc6633' },
    extend:    { id:'extend', icon:'extend', label:'Extend', run:() => startEdit('EDIT_EXTEND'), active: mode==='EDIT_EXTEND', enabled:canConstrain, accent:'#cc6633' },
    split:     { id:'split',  icon:'split',  label:'Split',  run:() => startEdit('EDIT_SPLIT'),  active: mode==='EDIT_SPLIT',  enabled:canConstrain, accent:'#cc6633' },
    powertrim: { id:'powertrim', icon:'powertrim', label:'Power Trim', run:() => startEdit('EDIT_POWER_TRIM'), active: mode==='EDIT_POWER_TRIM', enabled:canConstrain, accent:'#cc6633' },
    region:    { id:'region', icon:'region', label:'Region', run:closeRegions, enabled:canConstrain, accent:'#33aa77' },
    'sketch-face':{id:'sketch-face',icon:'plane',label:'On Face', run:sketchOnFace, active: mode==='FACE_SKETCH', enabled:hasAnySolid && !sketchSession, accent:SK },
    'sketch-datum':{id:'sketch-datum',icon:'plane',label:'On Datum', run:sketchOnDatum, active: mode==='DATUM_SKETCH', enabled:!sketchSession, accent:SK },
    'sketch-project':{id:'sketch-project',icon:'plane',label:'Project', run:sketchProject, active: mode==='PROJECT_PICK', enabled:!!sketchSession && hasAnySolid, accent:SK },
    'sketch-intersect':{id:'sketch-intersect',icon:'plane',label:'Intersect', run:sketchIntersect, active: mode==='INTERSECT_PICK', enabled:!!sketchSession && hasAnySolid, accent:SK },
    'datum-origin':{id:'datum-origin',icon:'datumPlane',label:'Origin Planes', run:datumOrigin, accent:'#f0a30a' },
    'datum-offset':{id:'datum-offset',icon:'datumPlane',label:'Offset Plane', run:datumOffset, active: mode==='DATUM_OFFSET_PICK', accent:'#f0a30a' },
    'datum-3point':{id:'datum-3point',icon:'datumPlane',label:'3-Point Plane', run:datum3Point, active: mode==='DATUM_3POINT_PICK', accent:'#f0a30a' },
    'datum-midplane':{id:'datum-midplane',icon:'datumPlane',label:'Midplane', run:datumMidplane, active: mode==='DATUM_MIDPLANE_PICK', accent:'#f0a30a' },
    'datum-angle':{id:'datum-angle',icon:'datumPlane',label:'Plane at Angle', run:datumAngle, active: mode==='DATUM_ANGLE_PICK', accent:'#f0a30a' },
    'datum-axis':{id:'datum-axis',icon:'datumAxis',label:'Datum Axis', run:datumAxis, active: mode==='DATUM_AXIS_PICK', accent:'#f0a30a' },
    'datum-point':{id:'datum-point',icon:'datumPoint',label:'Datum Point', run:datumPoint, active: mode==='DATUM_POINT_PICK', accent:'#f0a30a' },
    'datum-tangent':{id:'datum-tangent',icon:'datumPlane',label:'Tangent Plane', run:datumTangent, active: mode==='DATUM_TANGENT_PICK', accent:'#f0a30a' },
    'datum-curvenormal':{id:'datum-curvenormal',icon:'datumPlane',label:'Normal to Curve', run:datumCurveNormal, active: mode==='DATUM_CURVE_NORMAL_PICK', accent:'#f0a30a' },
    'datum-2edge':{id:'datum-2edge',icon:'datumPlane',label:'Through 2 Edges', run:datum2Edge, active: mode==='DATUM_2EDGE_PICK', accent:'#f0a30a' },
    // primitives
    // structure
    component: { id:'component', icon:'component', label:'Component', run:mkComponent, accent:'#6e7681',
                 tooltip:'New component (a Part) — features you create land inside it' },
    assembly:  { id:'assembly',  icon:'assembly',  label:'Assembly',  run:mkAssembly,  accent:'#9aa0a6',
                 tooltip:'New assembly — a container for components / sub-assemblies' },
    box:       { id:'box',       icon:'box',       label:'Box',      run:mkBox },
    cylinder:  { id:'cylinder',  icon:'cylinder',  label:'Cylinder', run:mkCyl },
    sphere:    { id:'sphere',    icon:'sphere',    label:'Sphere',   run:mkSph },
    torus:     { id:'torus',     icon:'torus',     label:'Torus',    run:mkTorus },
    cone:      { id:'cone',      icon:'cone',      label:'Cone',     run:mkCone },
    // from sketch
    extrude:   { id:'extrude',   icon:'extrude',   label:'Extrude',  run:extrude, enabled:hasSketch,         accent:'#9944cc' },
    revolve:   { id:'revolve',   icon:'revolve',   label:'Revolve',  run:revolve, enabled:hasSketch,         accent:'#cc4488' },
    loft:      { id:'loft',      icon:'loft',      label:'Loft',     run:loft,    enabled:loftProfileCount>=2, accent:'#cc8844' },
    sweep:     { id:'sweep',     icon:'sweep',     label:'Sweep',    run:sweep,   enabled:sketchCount>=2,    accent:'#44bbcc' },
    // transform
    mirror:        { id:'mirror',        icon:'mirror',    label:'Mirror',     run:mirror,        enabled:hasSolid||hasSketch, accent:'#4488cc' },
    'array-lin':   { id:'array-lin',     icon:'array',     label:'Lin Array',  run:linearArray,   enabled:hasSolid||hasSketch, accent:'#8844cc' },
    'array-circ':  { id:'array-circ',    icon:'circarray', label:'Circ Array', run:circularArray, enabled:hasSolid||hasSketch, accent:'#8844cc' },
    mate:          { id:'mate', icon:'mate', label:'Mate', run:() => setMode('ASSEMBLY_MATE'), active: mode==='ASSEMBLY_MATE', enabled:hasAnySolid, accent:'#cc8844' },
    align:         { id:'align', icon:'align', label:'Align', run:alignParallel, active: mode==='ASSEMBLY_ALIGN', enabled:hasAnySolid, accent:'#cc8844' },
    concentric:    { id:'concentric', icon:'concentric', label:'Concentric', run:() => setMode('ASSEMBLY_CONCENTRIC'), active: mode==='ASSEMBLY_CONCENTRIC', enabled:hasAnySolid, accent:'#cc8844' },
    // modify
    fillet:    { id:'fillet',    icon:'fillet',    label:'Fillet',   run:() => openBlend('fillet'),  enabled:hasSel },
    chamfer:   { id:'chamfer',   icon:'chamfer',   label:'Chamfer',  run:() => openBlend('chamfer'), enabled:hasSel },
    union:     { id:'union',     icon:'union',     label:'Union',     run:() => boolOp('FUSE'),   accent:'#2f9e54' },
    subtract:  { id:'subtract',  icon:'subtract',  label:'Subtract',  run:() => boolOp('CUT'),    accent:'#c2453f' },
    intersect: { id:'intersect', icon:'intersect', label:'Intersect', run:() => boolOp('COMMON'), accent:'#b08a2a' },
    // tools
    select:    { id:'select',    icon:'select',    label:'Select',  run:() => setMode('SELECT'),           active: mode==='SELECT' },
    measure:   { id:'measure',   icon:'measure',   label:'Measure', run:() => setMode('MEASURE_DISTANCE'), active: mode==='MEASURE_DISTANCE', accent:'#2aaccc' },
    'fit-all': { id:'fit-all',   icon:'fitAll',    label:'Fit All', run:() => window.dispatchEvent(new CustomEvent('cad-frame-all')), tooltip:'Frame all objects (Shift+F)' },
    import:    { id:'import',    icon:'import',    label:'Import',  run:importFile },
    export:    { id:'export',    icon:'export',    label:'Export',  run:exportFile, enabled:hasSel },
  };

  const tab = RIBBON_TABS.find((t) => t.id === activeTab) ?? RIBBON_TABS[0];

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      {/* Tab strip + persistent right zone */}
      <div className="cad-chrome ribbon-tabstrip">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}>
          {RIBBON_TABS.map((t) => (
            <button
              key={t.id}
              className="ribbon-tab"
              data-active={t.id === activeTab ? 'true' : 'false'}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Persistent zone: plane · sketch badge · undo/redo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 6 }}>
          <div style={{
            display:'flex', alignItems:'center', gap:'6px', flexShrink:0,
            background:'var(--surface-3)', borderRadius:'var(--radius-sm)',
            padding:'3px 5px 3px 9px', border:'1px solid var(--border)', height: 26,
          }}>
            <span style={{ fontSize:'10px', color:'var(--text-muted)' }}>Plane</span>
            <span style={{ fontSize:'11px', fontWeight:700, color:'var(--accent)', minWidth:'26px' }}>
              {activeWorkplane.label}
            </span>
            <button
              className="cad-btn cad-btn--icon"
              onClick={() => openPlaneSel(mode.startsWith('SKETCH_') ? mode as InteractionMode : 'SKETCH_LINE')}
              title="Change sketch plane"
              style={{ height: 20, width: 20 }}
            ><Icon name="plane" size={13} /></button>
          </div>

          {sketchSession && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, height: 26,
                background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
                borderRadius: 'var(--radius-sm)', padding: '0 10px',
              }}>
                <Icon name="sketch" size={13} color={SK} />
                <span style={{ fontSize: '10px', color: SK, fontWeight: 700, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sketchSession.name}
                </span>
              </div>
              <button className="cad-btn" onClick={quitSketch} title="Quit Sketch"
                style={{ height: 26, color: '#cc6600', borderColor: '#cc660088', background: '#cc660022' }}>
                <Icon name="check" size={14} color="#cc6600" /><span>Quit Sketch</span>
              </button>
            </>
          )}

          <Sep />
          <button className="cad-btn cad-btn--icon" onClick={() => useCADStore.getState().undo()}
            disabled={past.length === 0} title={`Undo (${past.length})`} style={{ height: 26 }}>
            <Icon name="undo" size={15} />
          </button>
          <button className="cad-btn cad-btn--icon" onClick={() => useCADStore.getState().redo()}
            disabled={future.length === 0} title={`Redo (${future.length})`} style={{ height: 26 }}>
            <Icon name="redo" size={15} />
          </button>
        </div>
      </div>

      {/* Command row for the active tab */}
      <div className="cad-chrome ribbon-row">
        {tab.groups.map((g, gi) => (
          <React.Fragment key={g.label}>
            {gi > 0 && <Sep />}
            <Grp label={g.label} />
            {g.ids.map((id) => {
              const cmd = commands[id];
              return cmd ? <CmdBtn key={id} cmd={cmd} /> : null;
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
