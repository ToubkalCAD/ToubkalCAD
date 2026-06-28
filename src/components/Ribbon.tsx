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

import React, { useState, useEffect, useRef } from 'react';
import { useCADStore, DEFAULT_MATERIAL, SURFACE_MATERIAL, NODE_TYPE_COLORS, InteractionMode, STANDARD_WORKPLANES, DATUM_TYPES } from '../store/cadStore';
import { Icon, IconName }            from './Icon';
import { showParamModal }           from './ParameterModal';
import { setSketchCornerValue }     from '../hooks/useCADSketchCorner';
import { OccPrimitivesService }     from '../services/OccPrimitivesService';
import { OccExchangeService }       from '../services/OccExchangeService';
import { OccRevolutionService }     from '../services/OccRevolutionService';
import { OccExtrusionService }      from '../services/OccExtrusionService';
import { OccSurfaceService }        from '../services/OccSurfaceService';
import { OccLoftService }           from '../services/OccLoftService';
import { OccSweepService }          from '../services/OccSweepService';
import { OccGuideCurveService }     from '../services/OccGuideCurveService';
import { OccGuidedLoftService }     from '../services/OccGuidedLoftService';
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
import { showSurfaceBlendPanel }    from './SurfaceBlendPanel';
import { showShellPanel }           from './ShellActionPanel';
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

// A ribbon item is either a single command id (→ icon button), a '|' separator,
// or a dropdown / split-button cluster grouping several command ids under one
// button. Folding the long primitive / datum / curve lists into clusters keeps
// every tab a single, non-scrolling row.
interface MenuDef { kind: 'menu'; id: string; label: string; icon?: IconName; ids: string[]; }
type RibbonItem = string | MenuDef;
interface RibbonTab { id: string; label: string; items: RibbonItem[]; }

const isMenu = (i: RibbonItem): i is MenuDef => typeof i !== 'string';

// Declarative, compact layout — each tab references command ids defined in the
// registry, with '|' separators and split-button clusters for related tools.
const RIBBON_TABS: RibbonTab[] = [
  { id: 'sketch', label: 'Sketch', items: [
    'create-sketch', '|',
    'line', 'circle', 'rect',
    { kind:'menu', id:'m-arc',    label:'Arcs',         icon:'arc',     ids:['arc','arc3p'] },
    { kind:'menu', id:'m-curves', label:'Curves',       icon:'spline',  ids:['ellipse','bezier','spline'] },
    { kind:'menu', id:'m-shapes', label:'Shapes',       icon:'polygon', ids:['roundrect','polygon'] },
    '|',
    { kind:'menu', id:'m-sedit',  label:'Edit',         icon:'trim',    ids:['trim','extend','split','powertrim','sfillet','schamfer'] },
    'region',
    '|',
    { kind:'menu', id:'m-splane', label:'Sketch Plane', icon:'plane',   ids:['sketch-face','sketch-datum'] },
    { kind:'menu', id:'m-sref',   label:'Reference',    icon:'plane',   ids:['sketch-project-ref','sketch-project','sketch-intersect'] },
    'constraints', 'dimension', 'dim-visibility',
  ] },
  { id: 'model', label: 'Model', items: [
    { kind:'menu', id:'m-struct', label:'Structure',  icon:'assembly',   ids:['component','assembly'] },
    '|',
    { kind:'menu', id:'m-prim',   label:'Primitives', icon:'box',        ids:['box','cylinder','sphere','torus','cone'] },
    '|',
    'extrude', 'revolve',
    { kind:'menu', id:'m-loft',   label:'Loft',       icon:'loft',       ids:['loft','advLoft'] },
    'sweep',
    '|',
    { kind:'menu', id:'m-xform',  label:'Transform',  icon:'mirror',     ids:['mirror','array-lin','array-circ'] },
    '|',
    { kind:'menu', id:'m-datum',  label:'Datum',      icon:'datumPlane', ids:['datum-origin','datum-offset','datum-3point','datum-midplane','datum-angle','datum-axis','datum-point','datum-tangent','datum-curvenormal','datum-2edge'] },
    { kind:'menu', id:'m-asm',    label:'Assembly',   icon:'mate',       ids:['mate','align','concentric'] },
  ] },
  { id: 'surface', label: 'Surface', items: [
    'surface-extrude', 'surface-revolve', 'surface-sweep', 'surface-loft', 'surface-patch',
    '|',
    'surface-trim', 'surface-extend', 'surface-blend', 'surface-stitch', 'surface-thicken', 'surface-solidify',
  ] },
  { id: 'modify', label: 'Modify', items: [
    'fillet', 'chamfer', 'shell',
    '|',
    { kind:'menu', id:'m-bool', label:'Boolean', icon:'union', ids:['union','subtract','intersect'] },
  ] },
  { id: 'tools', label: 'Tools', items: [
    'select', 'measure', 'fit-all',
    '|',
    { kind:'menu', id:'m-file', label:'File', icon:'import', ids:['import','export'] },
  ] },
];

// Flat lookup of every dropdown cluster, so the open dropdown panel can resolve
// its command ids regardless of which tab declared it.
const MENU_BY_ID: Record<string, MenuDef> = {};
for (const t of RIBBON_TABS) for (const it of t.items) if (isMenu(it)) MENU_BY_ID[it.id] = it;

// ─── Button + chrome sub-components ───────────────────────────────────────────

const Sep = () => <div className="cad-sep" />;

const tint       = (a: string) => (a.startsWith('#') ? a + '22' : 'var(--accent-soft)');
const tintBorder = (a: string) => (a.startsWith('#') ? a + '88' : 'var(--accent-line)');

const Caret = () => (
  <svg className="cad-split__chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Icon-only command button. The label rides along as a CSS hover tooltip
// (data-tip) instead of taking horizontal space.
const IconBtn: React.FC<{ cmd: Command }> = ({ cmd }) => {
  const accent = cmd.accent ?? 'var(--accent)';
  return (
    <button
      className="cad-iconbtn"
      data-active={cmd.active ? 'true' : 'false'}
      data-tip={cmd.tooltip ?? cmd.label}
      onClick={cmd.run}
      disabled={cmd.enabled === false}
      style={cmd.active ? { background: tint(accent), color: accent, borderColor: tintBorder(accent) } : undefined}
    >
      <Icon name={cmd.icon} size={20} color={cmd.active ? accent : undefined} />
    </button>
  );
};

// Split / dropdown button: the icon half runs the active-or-last-used command,
// the caret half opens the cluster menu. Reflects active state from its children.
const SplitBtn: React.FC<{
  menu:        MenuDef;
  commands:    Record<string, Command>;
  open:        boolean;
  lastUsedId?: string;
  onToggle:    (menuId: string, rect: DOMRect) => void;
}> = ({ menu, commands, open, lastUsedId, onToggle }) => {
  const wrapRef  = useRef<HTMLDivElement>(null);
  const activeId = menu.ids.find((id) => commands[id]?.active);
  const repId    = activeId ?? lastUsedId ?? menu.ids[0];
  const rep      = commands[repId];
  const accent   = rep?.accent ?? 'var(--accent)';
  const isActive = !!activeId;
  const allOff   = menu.ids.every((id) => commands[id]?.enabled === false);

  const toggle = () => { if (wrapRef.current) onToggle(menu.id, wrapRef.current.getBoundingClientRect()); };

  return (
    <div
      ref={wrapRef}
      className="cad-split"
      data-active={isActive ? 'true' : 'false'}
      data-open={open ? 'true' : 'false'}
      style={isActive ? { color: accent, background: tint(accent), borderColor: tintBorder(accent) } : undefined}
    >
      <button
        className="cad-split__main"
        data-tip={rep?.tooltip ?? rep?.label ?? menu.label}
        disabled={allOff}
        onClick={() => { if (rep && rep.enabled !== false) rep.run(); else toggle(); }}
      >
        <Icon name={rep?.icon ?? menu.icon ?? 'box'} size={20} color={isActive ? accent : undefined} />
      </button>
      <button className="cad-split__caret" data-tip={menu.label} disabled={allOff} onClick={toggle}>
        <Caret />
      </button>
    </div>
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
  const projectAsConstr = useCADStore((s) => s.projectAsConstruction);
  const dimensionsVisible = useCADStore((s) => s.dimensionsVisible);
  const activeWorkplane = useCADStore((s) => s.activeWorkplane);
  const openPlaneSel    = useCADStore((s) => s.openPlaneSelector);
  const setMode         = useCADStore((s) => s.setInteractionMode);
  const addNode         = useCADStore((s) => s.addNode);
  const setProc         = useCADStore((s) => s.setProcessing);
  const log             = useCADStore((s) => s.log);
  const sketchSession   = useCADStore((s) => s.sketchSession);
  const quitSketch      = useCADStore((s) => s.quitSketchSession);

  const [activeTab, setActiveTab] = useState<string>('sketch');

  // Dropdown-cluster state: which split-button menu is open, where to anchor its
  // floating panel, and the last command picked from each menu (so the split
  // button's icon-half re-runs that tool, Fusion/Onshape-style).
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [menuAt,   setMenuAt]   = useState<{ x: number; y: number } | null>(null);
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({});

  const closeMenu = () => setOpenMenu(null);
  const toggleMenu = (menuId: string, rect: DOMRect) => {
    if (openMenu === menuId) { closeMenu(); return; }
    setMenuAt({ x: rect.left, y: rect.bottom + 5 });
    setOpenMenu(menuId);
  };

  // Dismiss the open dropdown on outside-click, Esc, scroll, or resize.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.cad-menu') || t.closest('.cad-split')) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [openMenu]);

  const reg = CADGeometryRegistry.getInstance();

  // If already in a session: switch tool directly. Otherwise open plane selector.
  // Drawing tools no longer CREATE sketches (that's "Create Sketch" now). They only
  // switch the active tool inside an existing sketch — resuming a merely-selected
  // sketch if needed. The buttons are also disabled outside a sketch context, so the
  // warn branch is just a safety net.
  const startSketch = (sketchMode: InteractionMode) => {
    const st = useCADStore.getState();
    if (st.sketchSession) { setMode(sketchMode); return; }
    const id = constrainTargetId();
    if (!id) { log('Click "Create Sketch" to start a sketch first.', 'warn'); return; }
    st.resumeSketchSession(id);
    setMode(sketchMode);
  };

  // Explicit "Create Sketch" entry: open the plane selector, then start a sketch
  // session with no tool active (SELECT) — exactly the plane-pick flow a 2D shape
  // used to trigger, minus the auto-selected drawing tool. The drawing tools light
  // up once the session is active.
  const createSketch = () => {
    if (useCADStore.getState().sketchSession) { log('Finish or Quit the current sketch before starting a new one.', 'warn'); return; }
    openPlaneSel('SELECT');
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
  const sketchProject = (asConstruction: boolean) => {
    if (!useCADStore.getState().sketchSession) { log('Start or open a sketch first.', 'warn'); return; }
    if (!hasAnySolid) { log('No solids to project from.', 'warn'); return; }
    useCADStore.getState().setProjectAsConstruction(asConstruction);
    log(asConstruction
      ? 'Click edges to project as reference geometry (Esc to finish).'
      : 'Click edges to project as profile polylines (Esc to finish).', 'info');
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
  const create = (
    id: string, name: string, type: any, shape: any,
    params?: Record<string, any>, bodyType?: 'solid' | 'surface',
  ) => {
    reg.registerShape(id, shape);
    const material = bodyType === 'surface'
      ? { ...SURFACE_MATERIAL }
      : { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS[type as keyof typeof NODE_TYPE_COLORS] ?? 0x5588cc };
    addNode({
      id, name, type, visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material,
      ...(bodyType ? { bodyType } : {}),
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
    if (node.bodyType === 'surface') {
      log('Fillet/Chamfer needs a solid body — Thicken the surface first.', 'warn'); return;
    }
    if (!reg.getShape(selIds[0])) { log('Shape not found in registry.', 'error'); return; }
    showBlendPanel(selIds[0], op);
  };

  // ─── Shell / hollow (face-pick panel) ────────────────────────────────────────
  const openShell = () => {
    if (!selIds.length) { log('Select a solid first.', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (!node || node.type === 'sketch' || node.type === 'sketch_wire') {
      log('Select a 3D solid (not a sketch) to shell.', 'warn'); return;
    }
    if (node.bodyType === 'surface') {
      log('Shell needs a solid body — Thicken the surface first.', 'warn'); return;
    }
    if (!reg.getShape(selIds[0])) { log('Shape not found in registry.', 'error'); return; }
    showShellPanel(selIds[0]);
  };

  // ─── Boolean operations (guided panel) ──────────────────────────────────────
  const boolOp = (op: 'CUT' | 'FUSE' | 'COMMON') => {
    // Booleans operate on solids only — surface bodies have no enclosed volume to
    // add/cut/intersect (use Stitch/Thicken to make a solid first).
    const hasSurface = selIds.some((id) => nodes[id]?.bodyType === 'surface');
    const solids = selIds.filter((id) => {
      const t = nodes[id]?.type;
      return t && t !== 'sketch' && t !== 'sketch_wire' && nodes[id]?.bodyType !== 'surface' && reg.getShape(id);
    });
    if (!solids.length) {
      log('Boolean operations need solid bodies — surfaces aren\'t supported (Thicken them first).', 'warn'); return;
    }
    if (hasSurface) log('Surface bodies in the selection were skipped — booleans use solids only.', 'warn');
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

  // Smart Dimension tool — needs an active sketch session so its entities are
  // pickable; resume one if a sketch is merely selected.
  const startDimension = () => {
    const st = useCADStore.getState();
    if (st.sketchSession) { setMode('DIMENSION'); return; }
    const id = constrainTargetId();
    if (!id) { log('Open or select a sketch to add dimensions.', 'warn'); return; }
    st.resumeSketchSession(id);
    setMode('DIMENSION');
  };

  // ─── Sketch corner fillet / chamfer (S1) ─────────────────────────────────────
  // Prompts for the radius/distance, stores it for the corner tool, then enters
  // the pick mode (resuming the sketch session if one is merely selected).
  const startCorner = async (op: 'fillet' | 'chamfer') => {
    const st = useCADStore.getState();
    let sketchId = st.sketchSession?.id ?? null;
    if (!sketchId) {
      const id = constrainTargetId();
      if (!id) { log(`Open or select a sketch to ${op} its corners.`, 'warn'); return; }
      st.resumeSketchSession(id);
      sketchId = id;
    }
    const v = await showParamModal(
      op === 'fillet' ? 'Sketch Fillet' : 'Sketch Chamfer',
      [{ key: 'value', label: op === 'fillet' ? 'Radius' : 'Distance', default: 2, min: 0.001, step: 0.5, unit: 'mm' }],
      'Apply',
    );
    if (!v) return;                       // cancelled
    setSketchCornerValue(v.value);
    setMode(op === 'fillet' ? 'EDIT_FILLET' : 'EDIT_CHAMFER');
  };

  // ─── Auto-region close — detect closed loops → extrudable profile(s) ──────────
  const closeRegions = () => {
    const sketchId = constrainTargetId();
    if (!sketchId) { log('Open or select a sketch to detect regions.', 'warn'); return; }
    withOC(() => {
      const st = useCADStore.getState();
      const ents = Object.values(st.nodes).filter(
        (n) => n.type === 'sketch_wire' && n.parentId === sketchId && n.params?.sketchGeom && !n.params?.construction,
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

  // ─── Surface Revolve (Surface Modeling) ───────────────────────────────────────
  // Revolve the profile WIRE directly into a zero-thickness shell (no capped face).
  // Reuses the `revolve` node type + evaluator with opParams.surface=1 (same flag-on-
  // shared-type convention as Surface Loft), tagged bodyType:'surface'.
  const surfaceRevolve = () => {
    if (!selIds.length) { log('Select a sketch or sketch wire.', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (node?.type !== 'sketch_wire' && node?.type !== 'sketch') { log('Selected object must be a 2D sketch.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Surface Revolve', [
        { key: 'axis',  label: 'Axis (0=X 1=Y 2=Z)', default: 1, min: 0, max: 2, step: 1 },
        { key: 'angle', label: 'Angle', default: 360, min: 1, max: 360, unit: '°' },
      ]);
      if (!v) return;
      const targetId = profileTargetId() ?? (node?.type === 'sketch_wire' ? selIds[0] : null);
      if (!targetId) { log('No profile wire found on the selected sketch.', 'warn'); return; }
      const prof = profileShapeFor(window.oc, targetId);
      if (!prof.shape) { log('Sketch wire not found.', 'error'); return; }
      const axisVecs: [number,number,number][] = [[1,0,0],[0,1,0],[0,0,1]];
      const axisLabels = ['X','Y','Z'];
      const idx = Math.round(Math.max(0, Math.min(2, v.axis)));
      setProc(true, 'Revolving surface…');
      try {
        const id = crypto.randomUUID();
        create(id, `Surface Revolve ${v.angle.toFixed(0)}°/${axisLabels[idx]}`, 'revolve',
          OccRevolutionService.revolveSurface(window.oc, prof.shape, [0,0,0], axisVecs[idx], v.angle),
          { opType: 'revolve', targetWireIds: [targetId], opParams: { axis: idx, angle: v.angle, surface: 1 } },
          'surface');
      } catch (err: any) {
        log(`Surface Revolve failed: ${err.message}`, 'error');
      } finally {
        if (prof.temp && prof.shape) try { prof.shape.delete(); } catch { /*noop*/ }
        setProc(false);
      }
    });
  };

  // ─── Surface Extrude (Surface Modeling, Milestone 0) ──────────────────────────
  // Prism a profile WIRE into a zero-thickness sheet (shell/face, no caps). Unlike
  // the solid Extrude it never wraps the wire in a face. Binds to the sketch by id
  // (params.targetWireIds) so it re-derives its profile on recompute; the sketch
  // plane normal is captured as `dir` so recompute replays the same direction.
  const surfaceExtrude = () => {
    if (!selIds.length) { log('Select a sketch or sketch wire.', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (node?.type !== 'sketch_wire' && node?.type !== 'sketch') { log('Selected object must be a 2D sketch.', 'warn'); return; }
    withOC(async () => {
      const targetId = profileTargetId() ?? (node?.type === 'sketch_wire' ? selIds[0] : null);
      if (!targetId) { log('No profile wire found on the selected sketch.', 'warn'); return; }
      const v = await showParamModal('Surface Extrude', [
        { key: 'h',         label: 'Distance',  default: 20, min: 0.1, max: 1000, unit: 'mm' },
        { key: 'symmetric', label: 'Symmetric', default: 0,  min: 0,   max: 1,    step: 1 },
        { key: 'reverse',   label: 'Reverse',   default: 0,  min: 0,   max: 1,    step: 1 },
      ]);
      if (!v) return;
      // Sketch-plane normal = extrude direction. Sketch carries params.workplane;
      // a bare wire falls back to its parent sketch's plane, then to Y-up.
      const tn = nodes[targetId];
      const wp = (tn?.params?.workplane) ?? (tn?.parentId ? nodes[tn.parentId]?.params?.workplane : undefined);
      const nm = wp?.normal;
      const dir: [number, number, number] = Array.isArray(nm) && nm.length === 3 ? [nm[0], nm[1], nm[2]] : [0, 1, 0];
      const endMode = v.symmetric >= 0.5 ? 1 : 0;
      const prof = profileShapeFor(window.oc, targetId);
      if (!prof.shape) { log('Sketch wire not found.', 'error'); return; }
      setProc(true, 'Building surface…');
      try {
        const id = crypto.randomUUID();
        create(id, `Surface Extrude ${v.h.toFixed(0)}`, 'surface_extrude',
          OccExtrusionService.extrudeSurface(window.oc, prof.shape, {
            height: v.h, end: endMode === 1 ? 'symmetric' : 'blind', reverse: v.reverse >= 0.5, direction: dir,
          }),
          { opType: 'surfaceExtrude', targetWireIds: [targetId],
            opParams: { h: v.h, endMode, reverse: v.reverse >= 0.5 ? 1 : 0, dir } },
          'surface');
      } catch (err: any) {
        log(`Surface Extrude failed: ${err.message}`, 'error');
      } finally {
        if (prof.temp && prof.shape) try { prof.shape.delete(); } catch { /*noop*/ }
        setProc(false);
      }
    });
  };

  // ─── Surface Patch (Surface Modeling, Phase 1) ───────────────────────────────
  // Fill ONE closed boundary loop (sketch / sketch wire) with a zero-thickness
  // sheet: planar loops take the exact MakeFace path, non-planar loops are spanned
  // with BRepOffsetAPI_MakeFilling (OccSurfaceService.patch). No distance/direction
  // knobs — the boundary fully defines the surface. Binds to the sketch by id
  // (params.targetWireIds) so it re-derives its boundary on recompute. Patch has no
  // solid analog, so it uses its own node type/op `surface_patch`/`patch`.
  const surfacePatch = () => {
    if (!selIds.length) { log('Select a sketch or sketch wire (closed loop) to patch.', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (node?.type !== 'sketch_wire' && node?.type !== 'sketch') { log('Selected object must be a 2D sketch.', 'warn'); return; }
    withOC(async () => {
      const targetId = profileTargetId() ?? (node?.type === 'sketch_wire' ? selIds[0] : null);
      if (!targetId) { log('No closed boundary wire found on the selected sketch.', 'warn'); return; }
      const prof = profileShapeFor(window.oc, targetId);
      if (!prof.shape) { log('Sketch wire not found.', 'error'); return; }
      setProc(true, 'Building patch…');
      try {
        const id = crypto.randomUUID();
        create(id, 'Surface Patch', 'surface_patch',
          OccSurfaceService.patch(window.oc, prof.shape),
          { opType: 'patch', targetWireIds: [targetId], opParams: {} },
          'surface');
      } catch (err: any) {
        log(`Surface Patch failed: ${err.message}`, 'error');
      } finally {
        if (prof.temp && prof.shape) try { prof.shape.delete(); } catch { /*noop*/ }
        setProc(false);
      }
    });
  };

  // ─── Surface Stitch / Thicken (Surface Modeling, Phase 3) ────────────────────
  // Stitch sews ≥2 selected surface bodies into one shell (and into a solid when the
  // result is watertight); Thicken offsets one surface body into a solid. Both bind to
  // their source bodies by id and re-run on recompute (like boolean's base/tool refs).
  const selectedSurfaceIds = (): string[] =>
    selIds.filter((id) => nodes[id]?.bodyType === 'surface' && reg.getShape(id));

  const surfaceStitch = () => {
    const srcIds = selectedSurfaceIds();
    if (srcIds.length < 2) { log('Select ≥ 2 surface bodies (Ctrl+click) to stitch.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Stitch', [
        { key: 'solid', label: 'Make solid if closed', default: 1, min: 0, max: 1, step: 1 },
      ]);
      if (!v) return;
      const shapes = srcIds.map((id) => reg.getShape(id)).filter(Boolean);
      if (shapes.length < 2) { log('Could not retrieve the selected surfaces.', 'error'); return; }
      setProc(true, 'Stitching…');
      try {
        const id = crypto.randomUUID();
        const shape = OccSurfaceService.stitch(window.oc, shapes, v.solid >= 0.5);
        // A watertight result is a real solid; otherwise it stays a surface body.
        const isSolid = shape.ShapeType() === window.oc.TopAbs_ShapeEnum.TopAbs_SOLID;
        create(id, isSolid ? 'Stitch (Solid)' : 'Stitch', 'surface_stitch', shape,
          { opType: 'stitch', sourceIds: [...srcIds], opParams: { solid: v.solid >= 0.5 ? 1 : 0 } },
          isSolid ? 'solid' : 'surface');
      } catch (err: any) {
        log(`Stitch failed: ${err.message}`, 'error');
      } finally { setProc(false); }
    });
  };

  const surfaceThicken = () => {
    const srcIds = selectedSurfaceIds();
    if (!srcIds.length) { log('Select a surface body to thicken.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Thicken', [
        { key: 'thickness', label: 'Thickness', default: 2, min: 0.1, max: 1000, unit: 'mm' },
        { key: 'reverse',   label: 'Reverse side', default: 0, min: 0, max: 1, step: 1 },
      ]);
      if (!v) return;
      const surface = reg.getShape(srcIds[0]);
      if (!surface) { log('Could not retrieve the selected surface.', 'error'); return; }
      setProc(true, 'Thickening…');
      try {
        const id = crypto.randomUUID();
        create(id, `Thicken ${v.thickness.toFixed(1)}`, 'surface_thicken',
          OccSurfaceService.thicken(window.oc, surface, v.reverse >= 0.5 ? -v.thickness : v.thickness),
          { opType: 'thicken', sourceId: srcIds[0], opParams: { thickness: v.thickness, reverse: v.reverse >= 0.5 ? 1 : 0 } });
          // No bodyType arg → solid (thicken always produces a solid).
      } catch (err: any) {
        log(`Thicken failed: ${err.message}`, 'error');
      } finally { setProc(false); }
    });
  };

  // ─── Surface Trim (Surface Modeling, Phase 2) ────────────────────────────────
  // Cut a surface body with a tool body, keeping the portion outside (default) or
  // inside the tool. Target = first selected surface body; tool = the other selected
  // body. Pick-free (keep side = boolean, not a clicked fragment).
  const surfaceTrim = () => {
    const targetId = selIds.find((id) => nodes[id]?.bodyType === 'surface' && reg.getShape(id));
    const toolId   = selIds.find((id) => id !== targetId && nodes[id]?.type !== 'sketch'
                                      && nodes[id]?.type !== 'sketch_wire' && reg.getShape(id));
    if (!targetId || !toolId) { log('Select a surface body and a tool body (Ctrl+click) to trim.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Surface Trim', [
        { key: 'keepInside', label: 'Keep inside tool (0=outside)', default: 0, min: 0, max: 1, step: 1 },
      ]);
      if (!v) return;
      const target = reg.getShape(targetId);
      const tool   = reg.getShape(toolId);
      if (!target || !tool) { log('Could not retrieve the selected bodies.', 'error'); return; }
      setProc(true, 'Trimming…');
      try {
        const id = crypto.randomUUID();
        create(id, 'Surface Trim', 'surface_trim',
          OccSurfaceService.trim(window.oc, target, tool, v.keepInside >= 0.5),
          { opType: 'surfaceTrim', sourceId: targetId, toolId, opParams: { keepInside: v.keepInside >= 0.5 ? 1 : 0 } },
          'surface');
      } catch (err: any) {
        log(`Surface Trim failed: ${err.message}`, 'error');
      } finally { setProc(false); }
    });
  };

  // ─── Surface Extend (Surface Modeling, Phase 2) ──────────────────────────────
  // Grow a surface body outward by enlarging each face's UV bounds (pure-param, no
  // tool). Exact mm for planar/extruded sheets; periodic directions (cylinder angle)
  // are left untouched. Binds to the source body by id.
  const surfaceExtend = () => {
    const targetId = selIds.find((id) => nodes[id]?.bodyType === 'surface' && reg.getShape(id));
    if (!targetId) { log('Select a surface body to extend.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Surface Extend', [
        { key: 'distance', label: 'Distance', default: 5, min: 0.1, max: 1000, unit: 'mm' },
      ]);
      if (!v) return;
      const surface = reg.getShape(targetId);
      if (!surface) { log('Could not retrieve the selected surface.', 'error'); return; }
      setProc(true, 'Extending…');
      try {
        const id = crypto.randomUUID();
        create(id, `Surface Extend ${v.distance.toFixed(1)}`, 'surface_extend',
          OccSurfaceService.extend(window.oc, surface, v.distance),
          { opType: 'surfaceExtend', sourceId: targetId, opParams: { distance: v.distance } },
          'surface');
      } catch (err: any) {
        log(`Surface Extend failed: ${err.message}`, 'error');
      } finally { setProc(false); }
    });
  };

  // ─── Surface Blend (Surface Modeling, Phase 2) ───────────────────────────────
  // Tangent (G1) bridge between two surface bodies. Opens SurfaceBlendPanel, which
  // bridges the nearest facing boundary edges by default OR a pair the user picks in
  // the viewport (SURFACE_BLEND_EDGE mode) — needed when several boundaries face off.
  const surfaceBlend = () => {
    const srcIds = selectedSurfaceIds();
    if (srcIds.length < 2) { log('Select 2 surface bodies (Ctrl+click) to blend.', 'warn'); return; }
    showSurfaceBlendPanel(srcIds[0], srcIds[1]);
  };

  // ─── Surface Solidify (Surface→Solid cap/close) ──────────────────────────────
  // Cap a surface body's open boundary loops + sew into a watertight solid. One-click,
  // pick-free; produces a SOLID (bodyType omitted). Bind to the source body by id.
  const surfaceSolidify = () => {
    const targetId = selIds.find((id) => nodes[id]?.bodyType === 'surface' && reg.getShape(id));
    if (!targetId) { log('Select a surface body to solidify (cap + close).', 'warn'); return; }
    withOC(async () => {
      const surface = reg.getShape(targetId);
      if (!surface) { log('Could not retrieve the selected surface.', 'error'); return; }
      setProc(true, 'Solidifying…');
      try {
        const id = crypto.randomUUID();
        create(id, 'Solidify', 'surface_solidify',
          OccSurfaceService.solidify(window.oc, surface),
          { opType: 'solidify', sourceId: targetId, opParams: {} });
          // No bodyType arg → solid.
      } catch (err: any) {
        log(`Solidify failed: ${err.message}`, 'error');
      } finally { setProc(false); }
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

  // ─── Surface Loft (Surface Modeling) ──────────────────────────────────────────
  // Same profile binding + recompute path as the solid Loft, but ThruSections runs
  // with isSolid=false → an OPEN skinned SHELL (no end caps), tagged bodyType:
  // 'surface'. Reuses the `loft` node type/evaluator (loft has a solid analog, so
  // it needs no new type); the evaluator already honours opParams.solid=0.
  const surfaceLoft = () => {
    if (loftProfileCount < 2) { log('Select ≥ 2 sketches or sketch wires (Ctrl+click) to loft.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Surface Loft', [
        { key: 'ruled', label: 'Ruled (1) or Smooth (0)', default: 0, min: 0, max: 1, step: 1 },
      ]);
      if (!v) return;
      const sketchIds = loftProfileWireIds();
      if (sketchIds.length < 2) { log('Need ≥ 2 profiles to loft.', 'warn'); return; }
      const resolved = sketchIds.map((id) => profileShapeFor(window.oc, id));
      const wires = resolved.map((r) => r.shape).filter(Boolean);
      if (wires.length < 2) { resolved.forEach((r) => { if (r.temp && r.shape) try { r.shape.delete(); } catch { /*noop*/ } }); log('Could not retrieve all sketch shapes.', 'error'); return; }
      setProc(true, 'Lofting surface…');
      try {
        const id = crypto.randomUUID();
        create(id, `Surface Loft(${sketchIds.length})`, 'loft',
          OccLoftService.loftProfiles(window.oc, wires, false, v.ruled >= 0.5),
          { opType: 'loft', targetWireIds: [...sketchIds], opParams: { solid: 0, ruled: v.ruled >= 0.5 ? 1 : 0 } },
          'surface');
      } catch (err: any) {
        log(`Surface Loft failed: ${err.message}`, 'error');
      } finally {
        resolved.forEach((r) => { if (r.temp && r.shape) try { r.shape.delete(); } catch { /*noop*/ } });
        setProc(false);
      }
    });
  };

  // ─── Advanced (guided) Loft ───────────────────────────────────────────────────
  // Listens for 'cad-generate-guided-loft' (dispatched by AdvancedLoftPanel's
  // "Generate Guided Loft" button). Builds + registers the in-progress guide wire
  // if one is being drawn, then runs MakePipeShell (with a plain-loft fallback)
  // through the same create() pipeline as every other op.
  useEffect(() => {
    const onGen = (e: Event) => {
      // Snapshot the inputs from the event detail SYNCHRONOUSLY — the dialog
      // closes and resets the guide state immediately after dispatching, so by
      // the time withOC's microtask runs the store is already cleared. The detail
      // arrays/objects are the pre-reset references (Zustand replaces, never
      // mutates), so this snapshot stays valid. Fall back to live store state for
      // any programmatic caller that dispatches without a detail.
      const detail   = (e as CustomEvent).detail ?? {};
      const st0      = useCADStore.getState();
      const profiles: string[]      = detail.profiles ?? st0.guideProfiles;
      const draft                   = detail.draft    ?? st0.guideDraft;
      const committedIds: string[]  = detail.guideIds ?? st0.guideIds;

      withOC(async () => {
        const [aId, bId] = profiles;
        if (!aId || !bId) { log('Pick 2 profiles before generating a guided loft.', 'warn'); return; }
        const ra = profileShapeFor(window.oc, aId);
        const rb = profileShapeFor(window.oc, bId);
        const wireA = ra.shape;
        const wireB = rb.shape;
        if (!wireA || !wireB) {
          if (ra.temp && ra.shape) try { ra.shape.delete(); } catch { /*noop*/ }
          if (rb.temp && rb.shape) try { rb.shape.delete(); } catch { /*noop*/ }
          log('Could not resolve both profile wires.', 'error');
          return;
        }
        setProc(true, 'Building guided loft…');
        try {
          // Register the in-progress draft as a guide wire node if it isn't yet.
          // The Bezier POLES are stored on the node — the loft re-centres them so
          // the result actually follows the guide (see OccGuidedLoftService).
          // No commitGuide(): the dialog already reset the session guide state on
          // close; we only need the guide NODE's poles, tracked via guideIds.
          let guideIds = committedIds;
          if (draft && draft.lockedCount === 2) {
            const gWire = OccGuideCurveService.buildGuideWire(window.oc, draft.points, wireA, wireB);
            const gid = crypto.randomUUID();
            create(gid, 'Guide', 'sketch_wire', gWire, { guide: true, poles: draft.points });
            guideIds = [...guideIds, gid];
          }
          const sNow = useCADStore.getState();
          const guidePolesArr = guideIds
            .map((id) => sNow.nodes[id]?.params?.poles)
            .filter((p: any) => Array.isArray(p) && p.length >= 2)
            .slice(0, 2);
          if (!guidePolesArr.length) { log('Draw at least one guide curve first.', 'warn'); return; }

          const { shape, guided, reason } = OccGuidedLoftService.guidedLoftWithFallback(
            window.oc, wireA, wireB, guidePolesArr, true);
          create(crypto.randomUUID(), guided ? `Guided Loft` : `Loft (guide rejected)`, 'loft', shape,
            { opType: 'loft', targetWireIds: [aId, bId], guideIds });
          if (!guided) log(`Guide rejected (${reason ?? 'unknown'}) — fell back to a plain loft.`, 'warn');
        } finally {
          if (ra.temp && ra.shape) try { ra.shape.delete(); } catch { /*noop*/ }
          if (rb.temp && rb.shape) try { rb.shape.delete(); } catch { /*noop*/ }
          setProc(false);
        }
      });
    };
    // "Add Another Guide": commit the live draft into a registered, VISIBLE guide
    // wire (max 2 rails) and immediately re-enter draw mode for the next one.
    const onCommitContinue = () => withOC(async () => {
      const st = useCADStore.getState();
      const [aId, bId] = st.guideProfiles;
      const draft = st.guideDraft;
      if (!aId || !bId || !draft || draft.lockedCount !== 2) return;
      if (st.guideIds.length >= 2) { log('MakePipeShell supports at most 2 guide rails.', 'warn'); return; }
      const ra = profileShapeFor(window.oc, aId);
      const rb = profileShapeFor(window.oc, bId);
      try {
        if (!ra.shape || !rb.shape) { log('Could not resolve both profile wires.', 'error'); return; }
        const gWire = OccGuideCurveService.buildGuideWire(window.oc, draft.points, ra.shape, rb.shape);
        const gid = crypto.randomUUID();
        create(gid, `Guide ${st.guideIds.length + 1}`, 'sketch_wire', gWire, { guide: true, poles: draft.points });
        st.commitGuide(gid);        // registers gid in guideIds, clears draft, mode→SELECT
        // Render the committed guide as a persistent polyline so it stays visible.
        const pts = OccGuideCurveService.sampleBezier(draft.points, 48).map((p) => [p.x, p.y, p.z]);
        window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', { detail: { id: gid, pts } }));
        st.startGuideDraw();        // fresh draft → draw the next rail
        log(`Guide committed (${st.guideIds.length}/2). Draw the next, or Generate.`, 'success');
      } finally {
        if (ra.temp && ra.shape) try { ra.shape.delete(); } catch { /*noop*/ }
        if (rb.temp && rb.shape) try { rb.shape.delete(); } catch { /*noop*/ }
      }
    });

    window.addEventListener('cad-generate-guided-loft', onGen);
    window.addEventListener('cad-commit-guide-continue', onCommitContinue);
    return () => {
      window.removeEventListener('cad-generate-guided-loft', onGen);
      window.removeEventListener('cad-commit-guide-continue', onCommitContinue);
    };
  }, []);

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

  // ─── Surface Sweep (Surface Modeling) ─────────────────────────────────────────
  // Pipe the profile WIRE directly along the spine into a zero-thickness shell (open
  // tube, no caps). Reuses the `sweep` node type + evaluator with opParams.surface=1,
  // tagged bodyType:'surface'. Selection = profile then spine (Ctrl+click).
  const surfaceSweep = () => {
    const sketchIds = selIds.filter((id) => nodes[id]?.type === 'sketch_wire');
    if (sketchIds.length < 2) { log('Select profile then spine (Ctrl+click) to sweep.', 'warn'); return; }
    withOC(async () => {
      const profile = reg.getShape(sketchIds[0]);
      const spine   = reg.getShape(sketchIds[1]);
      if (!profile || !spine) { log('Could not retrieve sketch shapes.', 'error'); return; }
      setProc(true, 'Sweeping surface…');
      try {
        const id = crypto.randomUUID();
        create(id, 'Surface Sweep', 'sweep', OccSweepService.sweepSurface(window.oc, profile, spine),
          { opType: 'sweep', targetWireIds: [sketchIds[0], sketchIds[1]], opParams: { spineIndex: 1, surface: 1 } },
          'surface');
      } catch (err: any) {
        log(`Surface Sweep failed: ${err.message}`, 'error');
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
  const surfaceBodyCount = selIds.filter((id) => nodes[id]?.bodyType === 'surface').length;
  // Trim needs a surface target + at least one other (non-sketch) body as the tool.
  const otherBodyCount = selIds.filter((id) => {
    const t = nodes[id]?.type;
    return t && t !== 'sketch' && t !== 'sketch_wire' && nodes[id]?.bodyType !== 'surface';
  }).length;
  const canTrim = surfaceBodyCount >= 1 && (surfaceBodyCount + otherBodyCount) >= 2;
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
    'create-sketch': { id:'create-sketch', icon:'sketch', label:'Create Sketch', run:createSketch, enabled:!sketchSession, accent:SK,
                       tooltip:'Create Sketch — pick a plane to start a new sketch (disabled while a sketch is active)' },
    line:      { id:'line',      icon:'line',      label:'Line',    run:() => startSketch('SKETCH_LINE'),      active: mode==='SKETCH_LINE',      enabled:canConstrain, accent:SK },
    circle:    { id:'circle',    icon:'circle',    label:'Circle',  run:() => startSketch('SKETCH_CIRCLE'),    active: mode==='SKETCH_CIRCLE',    enabled:canConstrain, accent:SK },
    rect:      { id:'rect',      icon:'rectangle', label:'Rect',    run:() => startSketch('SKETCH_RECTANGLE'), active: mode==='SKETCH_RECTANGLE', enabled:canConstrain, accent:SK },
    arc:       { id:'arc',       icon:'arc',       label:'Arc',     run:() => startSketch('SKETCH_ARC'),       active: mode==='SKETCH_ARC',       enabled:canConstrain, accent:SK },
    arc3p:     { id:'arc3p',     icon:'arc3p',     label:'Arc3P',   run:() => startSketch('SKETCH_ARC_3P'),    active: mode==='SKETCH_ARC_3P',    enabled:canConstrain, accent:SK },
    ellipse:   { id:'ellipse',   icon:'ellipse',   label:'Ellipse', run:() => startSketch('SKETCH_ELLIPSE'),   active: mode==='SKETCH_ELLIPSE',   enabled:canConstrain, accent:SK },
    bezier:    { id:'bezier',    icon:'bezier',    label:'Bezier',  run:() => startSketch('SKETCH_BEZIER'),    active: mode==='SKETCH_BEZIER',    enabled:canConstrain, accent:SK },
    spline:    { id:'spline',    icon:'spline',    label:'Spline',  run:() => startSketch('SKETCH_SPLINE'),    active: mode==='SKETCH_SPLINE',    enabled:canConstrain, accent:SK },
    roundrect: { id:'roundrect', icon:'roundrect', label:'RndRect', run:() => startSketch('SKETCH_ROUNDED_RECT'), active: mode==='SKETCH_ROUNDED_RECT', enabled:canConstrain, accent:SK },
    polygon:   { id:'polygon',   icon:'polygon',   label:'Polygon', run:polygonRun, active: mode==='SKETCH_POLYGON', enabled:canConstrain, accent:SK },
    constraints:{id:'constraints',icon:'constraint',label:'Constraints', run:openConstraints, enabled:canConstrain, accent:'#1d9e74' },
    dimension:  {id:'dimension', icon:'measure', label:'Dimension', run:startDimension, enabled:canConstrain, active: mode==='DIMENSION', accent:'#1d9e74',
                 tooltip:'Smart Dimension — click sketch entities to add a driving dimension (length, radius, distance, angle)' },
    'dim-visibility': {id:'dim-visibility', icon:'grid', label: dimensionsVisible ? 'Hide Dims' : 'Show Dims',
                 run:() => useCADStore.getState().toggleDimensionsVisible(), active: dimensionsVisible, accent:'#1d9e74',
                 tooltip:'Show/Hide all dimension annotations (keeps the underlying constraints)' },
    trim:      { id:'trim',   icon:'trim',   label:'Trim',   run:() => startEdit('EDIT_TRIM'),   active: mode==='EDIT_TRIM',   enabled:canConstrain, accent:'#cc6633' },
    extend:    { id:'extend', icon:'extend', label:'Extend', run:() => startEdit('EDIT_EXTEND'), active: mode==='EDIT_EXTEND', enabled:canConstrain, accent:'#cc6633' },
    split:     { id:'split',  icon:'split',  label:'Split',  run:() => startEdit('EDIT_SPLIT'),  active: mode==='EDIT_SPLIT',  enabled:canConstrain, accent:'#cc6633' },
    powertrim: { id:'powertrim', icon:'powertrim', label:'Power Trim', run:() => startEdit('EDIT_POWER_TRIM'), active: mode==='EDIT_POWER_TRIM', enabled:canConstrain, accent:'#cc6633' },
    sfillet:   { id:'sfillet',  icon:'fillet',  label:'Fillet',  run:() => { void startCorner('fillet'); },  active: mode==='EDIT_FILLET',  enabled:canConstrain, accent:'#cc6633' },
    schamfer:  { id:'schamfer', icon:'chamfer', label:'Chamfer', run:() => { void startCorner('chamfer'); }, active: mode==='EDIT_CHAMFER', enabled:canConstrain, accent:'#cc6633' },
    region:    { id:'region', icon:'region', label:'Region', run:closeRegions, enabled:canConstrain, accent:'#33aa77' },
    'sketch-face':{id:'sketch-face',icon:'plane',label:'On Face', run:sketchOnFace, active: mode==='FACE_SKETCH', enabled:hasAnySolid && !sketchSession, accent:SK },
    'sketch-datum':{id:'sketch-datum',icon:'plane',label:'On Datum', run:sketchOnDatum, active: mode==='DATUM_SKETCH', enabled:!sketchSession, accent:SK },
    'sketch-project-ref':{id:'sketch-project-ref',icon:'plane',label:'Project as Ref', run:() => sketchProject(true), active: mode==='PROJECT_PICK' && projectAsConstr, enabled:!!sketchSession && hasAnySolid, accent:SK,
      tooltip:'Project edges as REFERENCE/construction geometry — frozen, dimensionable, excluded from the profile (the professional default)' },
    'sketch-project':{id:'sketch-project',icon:'plane',label:'Project (Profile)', run:() => sketchProject(false), active: mode==='PROJECT_PICK' && !projectAsConstr, enabled:!!sketchSession && hasAnySolid, accent:SK,
      tooltip:'Project edges as normal profile polylines (participate in regions/extrude)' },
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
    'surface-extrude': { id:'surface-extrude', icon:'extrude', label:'Surf. Extrude', run:surfaceExtrude, enabled:hasSketch, accent:'#e0a32e' },
    'surface-loft':    { id:'surface-loft',    icon:'loft',    label:'Surf. Loft',    run:surfaceLoft,    enabled:loftProfileCount>=2, accent:'#e0a32e' },
    'surface-patch':   { id:'surface-patch',   icon:'extrude', label:'Surf. Patch',   run:surfacePatch,   enabled:hasSketch, accent:'#e0a32e' },
    'surface-revolve': { id:'surface-revolve', icon:'revolve', label:'Surf. Revolve', run:surfaceRevolve, enabled:hasSketch, accent:'#e0a32e' },
    'surface-sweep':   { id:'surface-sweep',   icon:'sweep',   label:'Surf. Sweep',   run:surfaceSweep,   enabled:sketchCount>=2, accent:'#e0a32e' },
    'surface-trim':    { id:'surface-trim',    icon:'trim',    label:'Trim',          run:surfaceTrim,    enabled:canTrim, accent:'#e0a32e' },
    'surface-extend':  { id:'surface-extend',  icon:'extend',  label:'Extend',        run:surfaceExtend,  enabled:surfaceBodyCount>=1, accent:'#e0a32e' },
    'surface-blend':   { id:'surface-blend',   icon:'fillet',  label:'Blend',         run:surfaceBlend,   enabled:surfaceBodyCount>=2, accent:'#e0a32e' },
    'surface-stitch':  { id:'surface-stitch',  icon:'union',   label:'Stitch',        run:surfaceStitch,  enabled:surfaceBodyCount>=2, accent:'#4aa58a' },
    'surface-thicken': { id:'surface-thicken', icon:'shell',   label:'Thicken',       run:surfaceThicken, enabled:surfaceBodyCount>=1, accent:'#5fa9d6' },
    'surface-solidify':{ id:'surface-solidify',icon:'box',     label:'Solidify',      run:surfaceSolidify,enabled:surfaceBodyCount>=1, accent:'#6a9a3a' },
    advLoft:   { id:'advLoft',   icon:'loft',      label:'Adv. Loft', run:() => useCADStore.getState().openAdvancedLoft(), accent:'#cc8844',
                 tooltip:'Guided loft — pick 2 profiles, draw 3D guide curves, then Generate (opens the Advanced Loft dialog)' },
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
    shell:     { id:'shell',     icon:'shell',     label:'Shell',    run:openShell, active: mode==='SHELL_FACE', enabled:hasSel },
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
              onClick={() => { setActiveTab(t.id); closeMenu(); }}
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

      {/* Command row for the active tab — icon-first, single non-scrolling row */}
      <div className="cad-chrome ribbon-row">
        {tab.items.map((it, i) =>
          it === '|' ? (
            <Sep key={`sep-${i}`} />
          ) : isMenu(it) ? (
            <SplitBtn
              key={it.id}
              menu={it}
              commands={commands}
              open={openMenu === it.id}
              lastUsedId={lastUsed[it.id]}
              onToggle={toggleMenu}
            />
          ) : commands[it] ? (
            <IconBtn key={it} cmd={commands[it]} />
          ) : null,
        )}
      </div>

      {/* Floating dropdown panel for the open cluster */}
      {openMenu && menuAt && MENU_BY_ID[openMenu] && (
        <div className="cad-menu" style={{ left: menuAt.x, top: menuAt.y }}>
          {MENU_BY_ID[openMenu].ids.map((id) => {
            const c = commands[id];
            if (!c) return null;
            const accent = c.accent ?? 'var(--accent)';
            return (
              <button
                key={id}
                className="cad-menu__item"
                data-active={c.active ? 'true' : 'false'}
                disabled={c.enabled === false}
                onClick={() => { setLastUsed((p) => ({ ...p, [openMenu]: id })); closeMenu(); c.run(); }}
                style={c.active ? { color: accent } : undefined}
              >
                <Icon name={c.icon} size={18} color={c.active ? accent : undefined} />
                <span>{c.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
