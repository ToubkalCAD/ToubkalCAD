// ============================================================
// ToubkalCAD – Op3DPanel.tsx
//
// Controlled component — rendered by CADLayout when it has an
// op3DRequest state. No internal "open" logic; props drive it.
//
// show3DOpPanel() writes op3DPanelReq to the Zustand store.
// CADLayout subscribes to that field and renders Op3DPanel when non-null.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal }         from 'react-dom';
import * as THREE               from 'three';
import { useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS } from '../store/cadStore';
import type { NodeType, Workplane } from '../store/cadStore';
import { CADGeometryRegistry }  from '../services/CADGeometryRegistry';
import { OccConverter }         from '../services/OccConverter';
import { getPlacedShape }       from '../utils/placedShape';
import { profileShapeFor, canResolveProfile, healOpProfileTargets } from '../utils/sketchProfile';
import { computeExtrudeProfiles, setProfileFaces, clearProfileFaces, ExtrudeProfile } from '../utils/extrudeProfiles';
import { captureFaceAtPoint }   from '../services/StableRef';
import { propagateFromStore }   from '../services/RecomputeEngine.live';
import { OccExtrusionService, ExtrudeEnd } from '../services/OccExtrusionService';
import { OccBooleanService }    from '../services/OccBooleanService';
import { OccRevolutionService } from '../services/OccRevolutionService';
import { OccLoftService }       from '../services/OccLoftService';
import { OccSweepService }      from '../services/OccSweepService';
import { OccFilletService }     from '../services/OccFilletService';
import { isLowTier }            from '../utils/renderQuality';
import { useDragPanel }         from '../hooks/useDragPanel';

// ─── Public types ─────────────────────────────────────────────────────────────

export type Op3DType = 'extrude' | 'revolve' | 'loft' | 'sweep' | 'fillet' | 'chamfer';

export interface Op3DRequest {
  op:          Op3DType;
  targetIds:   string[];
  editNodeId?: string;
  /** True when the node was just created by createAndEditOp purely so the panel
   *  could edit it live — Cancel/Esc must DELETE it (the op never really happened).
   *  False/absent for a genuine Re-edit of a pre-existing node (Cancel keeps it). */
  ephemeral?:  boolean;
}

// Module-level opener — set by CADLayout during render (before any useEffect).
// CADLayout is the root and re-renders before any user interaction, so this
// is always set by the time the user can click a toolbar button.
/** Open the 3D-operation panel by writing directly to the Zustand store. */
export function show3DOpPanel(
  op:          Op3DType,
  targetIds:   string[],
  editNodeId?: string,
  ephemeral?:  boolean,
): void {
  // Re-editing an existing op: self-heal its profile targets to stable sketch
  // ids first, so a loft/extrude created with (now-stale) entity-wire ids — e.g.
  // a rectangle that was replaced — rebinds to its sketch instead of failing with
  // "not in WASM registry". Both the live preview and Apply then see valid targets.
  //
  // EXCEPT a profile-picked extrude: its targetWireIds are a deliberate SUBSET of
  // materialised region wires (which already re-derive via their region param).
  // Healing would rebind a lone selected region to its sketch and lose the picked
  // selection — so skip it and keep the region-wire targets intact.
  const node = editNodeId ? useCADStore.getState().nodes[editNodeId] : undefined;
  const isProfilePicked = !!((node?.params?.profileCandidateIds as string[] | undefined)?.length);
  const ids = (editNodeId && !isProfilePicked && ['extrude', 'revolve', 'loft', 'sweep'].includes(op))
    ? healOpProfileTargets(editNodeId)
    : targetIds;
  useCADStore.getState().openOp3DPanel(op, ids.length ? ids : targetIds, editNodeId, ephemeral);
}

/**
 * Create a 3D op with default params immediately (node appears in tree at once),
 * then open the Op3DPanel in EDIT mode so the user can adjust.
 * This avoids the "preview-only, no Apply" confusion.
 */
export function createAndEditOp(op: Op3DType, targetIds: string[]): void {
  const oc = window.oc;
  const store = useCADStore.getState();

  if (!oc) { store.log('OCC kernel not ready.', 'error'); return; }

  for (const wId of targetIds) {
    if (!canResolveProfile(oc, wId)) {
      store.log(`Shape not in WASM registry — re-draw the sketch.`, 'error');
      return;
    }
  }

  try {
    const defaults = { ...OP_DEFAULTS[op] };
    const shape    = computeShape(op, targetIds, defaults);
    const type     = OP_NTYPE[op];
    const idx      = nextIdx(type);
    const name     = `${OP_LABEL[op]}${idx}`;
    const id       = crypto.randomUUID();

    reg.registerShape(id, shape);
    store.addNode({
      id, name, type,
      visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS[type] ?? 0x5588cc },
      params:    { opType: op, targetWireIds: targetIds, opParams: defaults },
    });
    window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
    // The operation references its profile sketch(es) by id (params.targetWireIds);
    // they stay independent siblings in the component so they can be reused.
    store.log(`${name} created — adjust in the panel.`, 'success');

    // Open panel in EDIT mode. ephemeral=true → Cancel/Esc deletes this node (the
    // op is only provisional until the user clicks Update/Apply).
    show3DOpPanel(op, targetIds, id, true);
  } catch (err: any) {
    store.log(`${OP_TITLE[op]} failed: ${err?.message ?? String(err)}`, 'error');
    // Don't leave the user with nothing (menu closed, no panel) — open the panel
    // in CREATE mode so the tool actually activates. The live preview re-runs the
    // build and surfaces the error inline, and the user can adjust settings
    // (e.g. switch Loft to Ruled, or reorder profiles) and Apply when it succeeds.
    show3DOpPanel(op, targetIds);
  }
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

const OP_TITLE:  Record<Op3DType, string>   = { extrude:'Extrude', revolve:'Revolve', loft:'Loft', sweep:'Sweep', fillet:'Fillet', chamfer:'Chamfer' };
const OP_ICON:   Record<Op3DType, string>   = { extrude:'↑', revolve:'↻', loft:'⊿', sweep:'⌇', fillet:'⌒', chamfer:'⌐' };
const OP_LABEL:  Record<Op3DType, string>   = { extrude:'Extrusion', revolve:'Revolution', loft:'Loft', sweep:'Sweep', fillet:'Fillet', chamfer:'Chamfer' };
const OP_NTYPE:  Record<Op3DType, NodeType> = { extrude:'extrusion', revolve:'revolve', loft:'loft', sweep:'sweep', fillet:'compound', chamfer:'compound' };
// extrude numeric knobs:
//   endMode 0=blind 1=symmetric 2=twoSided · reverse 0/1 · op 0=new 1=pad 2=pocket
//   draft = taper angle in degrees (0 = straight walls) · thick = wall mm (0 = solid)
export const OP_DEFAULTS: Record<Op3DType, Record<string, number>> = {
  extrude:  { h: 20, endMode: 0, h2: 10, reverse: 0, draft: 0, thick: 0, op: 0 },
  revolve:  { angle: 360, axis: 1 },
  loft:     { solid: 1, ruled: 0 },
  sweep:    {},
  fillet:   { r: 1 },
  chamfer:  { d: 1 },
};

// ─── OCC helpers ─────────────────────────────────────────────────────────────

const reg = CADGeometryRegistry.getInstance();

function getDir(id: string): [number, number, number] {
  const wp = useCADStore.getState().nodes[id]?.params?.workplane as Workplane | undefined;
  return wp?.normal ?? [0, 1, 0];
}

function getOrigin(id: string): [number, number, number] {
  const wp = useCADStore.getState().nodes[id]?.params?.workplane as Workplane | undefined;
  return wp?.origin ?? [0, 0, 0];
}

/** All solid bodies in the scene (baked to their gizmo pose), excluding the
 *  given ids — used as the "up to next/last" targets (E6). */
function allSolidShapes(excludeIds: string[]): any[] {
  const NON_SOLID = new Set(['sketch', 'sketch_wire']);
  const skip = new Set(excludeIds);
  return Object.values(useCADStore.getState().nodes)
    .filter((n) => !NON_SOLID.has(n.type) && !skip.has(n.id))
    .map((n) => getPlacedShape(n.id))
    .filter(Boolean);
}

const EXTRUDE_END: ExtrudeEnd[] = ['blind', 'symmetric', 'twoSided'];

function computeShape(
  op: Op3DType,
  ids: string[],
  p: Record<string, number>,
  targetSolidId?: string,
  targetFacePoint?: [number, number, number],
  targetDatumId?: string,
): any {
  const oc = window.oc;
  switch (op) {
    case 'extrude': {
      // Each target resolves to a wire: a SKETCH container → its current profile
      // (temp, freed below); a sketch_wire / region node → its registered shape.
      const built = ids.map((id) => profileShapeFor(oc, id));
      const wires = built.map((b) => b.shape).filter(Boolean);
      const freeTemps = () => built.forEach((b) => { if (b.temp && b.shape) try { b.shape.delete(); } catch { /*noop*/ } });
      try {
      if (!wires.length) throw new Error('Wire not found.');
      const endMode = Math.round(p.endMode ?? 0);
      let solid;
      const upToOpts = {
        direction:    getDir(ids[0]),
        reverse:      (p.reverse ?? 0) >= 0.5,
        neutralPoint: getOrigin(ids[0]),
      };
      if (endMode === 3) {
        // Up-to-Face: trim to the picked target solid (reuses the boolean target).
        // Single profile only — multi-region up-to-face is deferred.
        // getPlacedShape bakes the target's gizmo transform so the trim happens
        // where the user sees the solid, not at its origin pose.
        const tgt = targetSolidId ? getPlacedShape(targetSolidId) : null;
        if (!tgt) throw new Error('Up-to-Face needs a target solid — pick one.');
        solid = OccExtrusionService.extrudeUpToFace(oc, wires, upToOpts, tgt, targetFacePoint);
      } else if (endMode === 6) {
        // Up-to-Plane: trim the profile at a picked datum plane (D-track reference).
        const datum = targetDatumId ? useCADStore.getState().nodes[targetDatumId] : null;
        const wp = datum?.params?.workplane as Workplane | undefined;
        if (!wp) throw new Error('Up-to-Plane needs a datum plane — pick one.');
        solid = OccExtrusionService.extrudeUpToPlane(oc, wires, upToOpts, wp.origin, wp.normal);
      } else if (endMode === 4 || endMode === 5) {
        // Up-to-Next / Up-to-Last: trim against every other body in the scene.
        const editId = useCADStore.getState().op3DPanelReq?.editNodeId;
        const bodies = allSolidShapes([...ids, ...(editId ? [editId] : [])]);
        if (!bodies.length) throw new Error('Up-to-Next/Last needs another solid in the model.');
        solid = endMode === 4
          ? OccExtrusionService.extrudeUpToNext(oc, wires, upToOpts, bodies)
          : OccExtrusionService.extrudeUpToLast(oc, wires, upToOpts, bodies);
      } else {
        // E7: extrude every region (one wire → solid, many → compound).
        solid = OccExtrusionService.extrudeProfiles(oc, wires, {
          height:       p.h ?? 20,
          end:          EXTRUDE_END[endMode] ?? 'blind',
          height2:      p.h2 ?? 10,
          reverse:      (p.reverse ?? 0) >= 0.5,
          direction:    getDir(ids[0]),
          draftAngle:   p.draft ?? 0,
          neutralPoint: getOrigin(ids[0]),
          thickness:    p.thick ?? 0,
        });
      }
      // Pad (fuse) / Pocket (cut) against an explicitly picked target solid.
      const boolOp = Math.round(p.op ?? 0);
      if ((boolOp === 1 || boolOp === 2) && targetSolidId) {
        const target = getPlacedShape(targetSolidId);  // baked to its gizmo pose
        if (!target) throw new Error('Boolean target solid not found — re-pick it.');
        solid = boolOp === 1
          ? OccBooleanService.fuse(oc, target, solid)
          : OccBooleanService.subtract(oc, target, solid);
      }
      return solid;
      } finally { freeTemps(); }
    }
    case 'revolve': {
      const b = profileShapeFor(oc, ids[0]);
      try {
        if (!b.shape) throw new Error('Wire not found.');
        const axes: any[] = [[1,0,0],[0,1,0],[0,0,1]];
        return OccRevolutionService.revolveProfile(oc, b.shape, [0,0,0], axes[Math.round(p.axis ?? 1)], p.angle ?? 360);
      } finally { if (b.temp && b.shape) try { b.shape.delete(); } catch { /*noop*/ } }
    }
    case 'loft':    {
      // Resolve each target — a SKETCH container yields its current profile wire
      // (temp), a sketch_wire yields its registered shape. Free the temporaries
      // after the loft is built (the result is independent of the input wires).
      const built = ids.map((id) => profileShapeFor(oc, id));
      const ws = built.map((b) => b.shape).filter(Boolean);
      try {
        if (ws.length < 2) throw new Error('Need ≥ 2 wires.');
        return OccLoftService.loftProfiles(oc, ws, (p.solid ?? 1) >= 0.5, (p.ruled ?? 0) >= 0.5);
      } finally {
        built.forEach((b) => { if (b.temp && b.shape) try { b.shape.delete(); } catch { /*noop*/ } });
      }
    }
    case 'sweep':   { const pr=reg.getShape(ids[0]),sp=reg.getShape(ids[1]); if(!pr||!sp) throw new Error('Profile/spine not found.'); return OccSweepService.sweepProfile(oc,pr,sp); }
    case 'fillet':  { const s=reg.getShape(ids[0]); if(!s) throw new Error('Shape not found.'); return OccFilletService.filletAllEdges(oc,s,p.r??1); }
    case 'chamfer': { const s=reg.getShape(ids[0]); if(!s) throw new Error('Shape not found.'); return OccFilletService.chamferAllEdges(oc,s,p.d??1); }
  }
}

function nextIdx(type: NodeType) {
  return Object.values(useCADStore.getState().nodes).filter(n => n.type === type).length + 1;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const numStyle: React.CSSProperties = {
  width:68, background:'var(--surface-3)', border:'1px solid var(--border)',
  borderRadius:'var(--radius-sm)', color:'var(--accent)',
  padding:'2px 6px', fontSize:12, fontFamily:'monospace', textAlign:'right', outline:'none',
};

const SliderRow: React.FC<{label:string;k:string;min:number;max:number;step:number;params:Record<string,number>;onChange:(k:string,v:number)=>void}> =
  ({ label, k, min, max, step, params, onChange }) => {
    const val = params[k] ?? min;
    return (
      <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px' }}>{label}</span>
          <input type="number" style={numStyle} value={val} min={min} max={max} step={step}
            onChange={e=>{ const v=parseFloat(e.target.value); if(!isNaN(v)) onChange(k,Math.max(min,Math.min(max,v))); }}
            onFocus={e=>{ e.target.style.borderColor='var(--accent)'; e.target.select(); }}
            onBlur={e=>{ e.target.style.borderColor='var(--border)'; }}
            onKeyDown={e=>e.stopPropagation()} />
        </div>
        <input type="range" min={min} max={max} step={step} value={val}
          onChange={e=>onChange(k,parseFloat(e.target.value))}
          style={{ width:'100%', accentColor:'var(--accent)', cursor:'pointer' }} />
      </div>
    );
  };

const ToggleRow: React.FC<{label:string;k:string;opts:{label:string;v:number}[];params:Record<string,number>;onChange:(k:string,v:number)=>void}> =
  ({ label, k, opts, params, onChange }) => (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', minWidth:55 }}>{label}</span>
      <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
        {opts.map(o=>(
          <button key={o.v} onClick={()=>onChange(k,o.v)} style={{
            padding:'2px 10px', fontSize:11, cursor:'pointer',
            border:'1px solid var(--border)', borderRadius:'var(--radius-sm)',
            background:(params[k]??opts[0].v)===o.v?'var(--accent)':'var(--surface-3)',
            color:(params[k]??opts[0].v)===o.v?'#fff':'var(--text-primary)',
          }}>{o.label}</button>
        ))}
      </div>
    </div>
  );

// Pad/Pocket target-solid picker row (E2).
const TargetPickRow: React.FC<{
  targetName: string | null;
  isPicking:  boolean;
  noun?:      string;   // what the user is picking: 'solid' (default) or 'face'
  onPick:     () => void;
  onClear:    () => void;
}> = ({ targetName, isPicking, noun = 'solid', onPick, onClear }) => (
  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
    <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', minWidth:55 }}>Target</span>
    <div style={{ display:'flex', alignItems:'center', gap:6, flex:1, minWidth:0 }}>
      <button onClick={onPick} style={{
        padding:'2px 10px', fontSize:11, cursor:'pointer', whiteSpace:'nowrap',
        border:`1px solid ${isPicking ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius:'var(--radius-sm)',
        background: isPicking ? 'var(--accent)' : 'var(--surface-3)',
        color: isPicking ? '#fff' : 'var(--text-primary)',
      }}>{isPicking ? `Click a ${noun}…` : (targetName ? 'Re-pick' : `Pick ${noun}`)}</button>
      {targetName && (
        <span title={targetName} style={{
          fontSize:11, color:'var(--accent)', fontFamily:'monospace',
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1,
        }}>{targetName}</span>
      )}
      {targetName && !isPicking && (
        <button onClick={onClear} title="Clear target" style={{
          padding:'0 6px', fontSize:13, lineHeight:1, cursor:'pointer',
          border:'1px solid var(--border)', borderRadius:'var(--radius-sm)',
          background:'var(--surface-3)', color:'var(--text-dim)',
        }}>×</button>
      )}
    </div>
  </div>
);

// Profile picker row (Fusion-style "Profile" zone). Lets the user choose which
// of the sketch's nested profiles to extrude — via the viewport (hover-highlight
// + click) or the inline per-profile chips. Selection lives in the store.
const ProfileRow: React.FC<{
  count:    number;
  selected: number[];
  picking:  boolean;
  onPick:   () => void;
  onToggle: (i: number) => void;
  onAll:    () => void;
}> = ({ count, selected, picking, onPick, onToggle, onAll }) => {
  const sel = new Set(selected);
  const chip = (on: boolean): React.CSSProperties => ({
    padding:'1px 8px', fontSize:11, cursor:'pointer', lineHeight:1.6,
    border:`1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius-sm)',
    background: on ? 'var(--accent)' : 'var(--surface-3)', color: on ? '#fff' : 'var(--text-primary)',
  });
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', minWidth:55 }}>Profile</span>
        <button onClick={onPick} style={{
          padding:'2px 10px', fontSize:11, cursor:'pointer', whiteSpace:'nowrap',
          border:`1px solid ${picking ? 'var(--accent)' : 'var(--border)'}`, borderRadius:'var(--radius-sm)',
          background: picking ? 'var(--accent)' : 'var(--surface-3)', color: picking ? '#fff' : 'var(--text-primary)',
        }}>{picking ? 'Click in view…' : 'Select in view'}</button>
        <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'monospace' }}>{selected.length}/{count}</span>
      </div>
      {count >= 2 && (
        <div style={{ display:'flex', flexWrap:'wrap', gap:4, paddingLeft:63 }}>
          {Array.from({ length:count }, (_, i) => (
            <button key={i} onClick={() => onToggle(i)} style={chip(sel.has(i))}>P{i+1}</button>
          ))}
          <button onClick={onAll} title="Select all profiles" style={chip(false)}>All</button>
        </div>
      )}
    </div>
  );
};

// ─── Main panel (controlled) ─────────────────────────────────────────────────

export interface Op3DPanelProps {
  req:     Op3DRequest;
  onClose: () => void;
}

export const Op3DPanel: React.FC<Op3DPanelProps> = ({ req, onClose }) => {
  const isEdit = !!req.editNodeId;

  // Build initial params
  const buildInit = (): Record<string, number> => {
    const base = { ...OP_DEFAULTS[req.op] };
    if (req.editNodeId) {
      const stored = useCADStore.getState().nodes[req.editNodeId]?.params?.opParams;
      if (stored && typeof stored === 'object') Object.assign(base, stored);
    }
    return base;
  };

  const [params, setParams]       = useState<Record<string, number>>(buildInit);
  const [applyErr, setApplyErr]   = useState<string | null>(null);
  // E2 — Pad/Pocket boolean target solid (id). Tracked outside numeric params.
  const [targetSolidId, setTargetSolidId] = useState<string | null>(
    () => (req.editNodeId
      ? (useCADStore.getState().nodes[req.editNodeId]?.params?.targetSolidId ?? null)
      : null),
  );
  // E5 — Up-to-Face: world-space point on the picked solid identifying the face.
  const [targetFacePoint, setTargetFacePoint] = useState<[number, number, number] | null>(
    () => (req.editNodeId
      ? (useCADStore.getState().nodes[req.editNodeId]?.params?.targetFacePoint ?? null)
      : null),
  );
  // Up-to-Plane: id of the datum plane to extrude up to.
  const [targetDatumId, setTargetDatumId] = useState<string | null>(
    () => (req.editNodeId
      ? (useCADStore.getState().nodes[req.editNodeId]?.params?.targetDatumId ?? null)
      : null),
  );
  const datumPlanes = Object.values(useCADStore.getState().nodes).filter((n) => n.type === 'datum_plane');
  const previewRef    = useRef<THREE.Mesh | null>(null);
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the FIRST preview when re-editing/just-created: the committed mesh already
  // shows exactly the current params, so building a preview on open just re-runs an
  // identical (and for revolve, costly) tessellation. Preview from the first real
  // param change onward.
  const skipFirstPreviewRef = useRef<boolean>(!!req.editNodeId);
  // Committed meshes hidden while the preview is live (edited node + boolean target).
  const hiddenMeshesRef = useRef<THREE.Object3D[]>([]);

  // Live store values needed by the picker + UI.
  const interactionMode = useCADStore((s) => s.interactionMode);
  const pickedTarget    = useCADStore((s) => s.op3DTargetPick);
  const isPicking       = interactionMode === 'EXTRUDE_TARGET_PICK';

  // ── Profile picker (extrude) ─────────────────────────────────────────────────
  // The sketch's nested profiles (outer-with-holes), partitioning req.targetIds.
  // The face GEOMETRIES go to the viewport hook via the bus; the SELECTION lives
  // in the store so the panel chips + the viewport overlays stay in sync.
  const profilesRef      = useRef<ExtrudeProfile[]>([]);
  // The FULL candidate profile set (all of the sketch's profiles, including ones
  // currently deselected) — persisted so a re-edit can re-ADD a profile, not just
  // narrow the selection. Falls back to the op's targets for legacy nodes.
  const candidateIdsRef  = useRef<string[]>([]);
  const profileCount     = useCADStore((s) => s.profilePickCount);
  const profileSel       = useCADStore((s) => s.profilePickSelected);
  const isProfilePicking = interactionMode === 'PROFILE_PICK';

  /** The target ids the extrude should actually consume = the union of the
   *  SELECTED profiles' wire ids. Falls back to req.targetIds for non-extrude ops
   *  or before profiles are computed. */
  const effectiveTargetIds = useCallback((): string[] => {
    const profs = profilesRef.current;
    if (req.op !== 'extrude' || profs.length === 0) return req.targetIds;
    const sel = useCADStore.getState().profilePickSelected;
    const ids = new Set<string>();
    sel.forEach((i) => profs[i]?.wireIds.forEach((w) => ids.add(w)));
    return [...ids];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.op, req.targetIds]);

  // Compute the profiles when the panel opens (or its targets change). Candidates
  // come from the FULL set (so re-edit shows every profile, selected or not); the
  // initial selection mirrors the op's persisted subset (all, for a fresh create).
  useEffect(() => {
    const store = useCADStore.getState();
    if (req.op !== 'extrude' || !window.oc) {
      profilesRef.current = [];
      candidateIdsRef.current = [];
      clearProfileFaces();
      useCADStore.setState({ profilePickCount: 0, profilePickSelected: [] });
      return;
    }
    // Full candidate set: persisted profileCandidateIds (new nodes) → falls back to
    // the op's targets (fresh create, or legacy nodes from before this existed).
    const stored = req.editNodeId ? store.nodes[req.editNodeId]?.params : undefined;
    const candidateIds = ((stored?.profileCandidateIds as string[] | undefined)?.length)
      ? (stored!.profileCandidateIds as string[])
      : req.targetIds;
    candidateIdsRef.current = candidateIds;

    let profs: ExtrudeProfile[] = [];
    try { profs = computeExtrudeProfiles(window.oc, candidateIds); } catch { profs = []; }
    profilesRef.current = profs;
    setProfileFaces(profs.map((p) => p.geometry));
    useCADStore.setState({ profilePickCount: profs.length });

    // Selection: re-edit → the profiles whose wires are in the op's (subset)
    // targetWireIds; fresh create → all. A profile contributed ALL its wires when
    // selected and NONE when not, so an intersection test is exact.
    const activeSet = new Set(req.editNodeId
      ? ((stored?.targetWireIds as string[] | undefined) ?? candidateIds)
      : candidateIds);
    const initSel = profs.flatMap((p, i) => (p.wireIds.some((w) => activeSet.has(w)) ? [i] : []));
    store.setProfilePickSelected(initSel.length ? initSel : profs.map((_, i) => i));

    return () => {
      clearProfileFaces();
      useCADStore.getState().endProfilePick();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.op, req.editNodeId, req.targetIds.join(',')]);

  // Adopt a solid the user clicked in EXTRUDE_TARGET_PICK mode, then clear the
  // one-shot store signal so re-picking the same id fires again.
  useEffect(() => {
    if (pickedTarget) {
      setTargetSolidId(pickedTarget);
      setTargetFacePoint(useCADStore.getState().op3DTargetPickPoint);
      useCADStore.getState().setOp3DTargetPick(null);
    }
  }, [pickedTarget]);
  const { pos, onHandleMouseDown } = useDragPanel(
    Math.max(260, Math.round(window.innerWidth / 2 - 136)), 120,
  );

  // Reinitialise params when req changes (e.g. different op opened while panel mounted)
  useEffect(() => {
    setParams(buildInit());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.op, req.editNodeId]);

  // ── Preview ─────────────────────────────────────────────────────────────────

  const clearPreview = useCallback(() => {
    // Remove the preview mesh
    const m = previewRef.current;
    if (m) {
      const sc = (window as any).cadScene as THREE.Scene | null;
      if (sc) { try { sc.remove(m); } catch {} }
      try { m.geometry.dispose(); } catch {}
      try { (m.material as THREE.Material).dispose(); } catch {}
    }
    previewRef.current = null;

    // Restore every committed mesh hidden during preview (edit node + target)
    for (const obj of hiddenMeshesRef.current) obj.visible = true;
    hiddenMeshesRef.current = [];
    // The viewport renders on demand — this scene edit is imperative (no store/
    // event change), so explicitly ask for a redraw or it won't show until the
    // next pointer move (looked like a multi-second hang on axis change).
    window.cadRequestRender?.();
  }, []);

  // Clear preview on any node deletion (prevents ghost meshes after tree delete)
  useEffect(() => {
    const h = () => clearPreview();
    window.addEventListener('cad-remove-mesh', h);
    return () => window.removeEventListener('cad-remove-mesh', h);
  }, [clearPreview]);

  const buildPreview = useCallback((liveReq: Op3DRequest, liveParams: Record<string, number>, liveTarget: string | null, liveFacePoint: [number, number, number] | null, liveDatum: string | null) => {
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!window.oc || !sc) return;
    clearPreview();

    // Hide committed meshes the preview would overlap: the edited node itself,
    // and (for Pad/Pocket) the boolean target, since the preview already
    // contains the combined result.
    const hideById = (nid?: string | null) => {
      if (!nid) return;
      const obj = sc.children.find(c => c.userData?.cadNodeId === nid);
      if (obj && obj.visible) { obj.visible = false; hiddenMeshesRef.current.push(obj); }
    };
    hideById(liveReq.editNodeId);
    const boolActive = liveReq.op === 'extrude' && Math.round(liveParams.op ?? 0) !== 0;
    if (boolActive) hideById(liveTarget);

    try {
      // Extrude consumes only the SELECTED profiles' wires (Profile picker).
      const liveTargets = liveReq.op === 'extrude' ? effectiveTargetIds() : liveReq.targetIds;
      if (!liveTargets.length) throw new Error('Select at least one profile to extrude.');
      const shape = computeShape(liveReq.op, liveTargets, liveParams, liveTarget ?? undefined, liveFacePoint ?? undefined, liveDatum ?? undefined);
      // Live preview is throwaway — on a weak GPU build it extra-coarse so dragging
      // a slider stays responsive; Apply rebuilds it at the committed quality.
      const geo   = OccConverter.shapeToThreeGeometry(window.oc, shape, 0.2, isLowTier() ? 0.04 : undefined);
      const mat   = new THREE.MeshStandardMaterial({ color:0x4488ee, opacity:0.70, transparent:true, roughness:0.25, metalness:0.15, side:THREE.DoubleSide });
      const mesh  = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      sc.add(mesh);
      previewRef.current = mesh;
      setApplyErr(null);
    } catch (e: any) {
      // Preview failed — restore hidden meshes so the user can still see the solids,
      // and surface why (e.g. a revolve axis that passes through the profile).
      for (const obj of hiddenMeshesRef.current) obj.visible = true;
      hiddenMeshesRef.current = [];
      setApplyErr(e?.message ?? null);
    }
    // Imperative scene edit → the on-demand render loop needs an explicit nudge,
    // otherwise the new preview isn't drawn until the next pointer move.
    window.cadRequestRender?.();
  }, [clearPreview, effectiveTargetIds]);

  // Debounce preview on param change (and on profile-selection change).
  useEffect(() => {
    // First run on open: the committed mesh already shows these params → don't
    // tessellate a redundant preview. (New-from-scratch ops have no committed mesh
    // yet, so they DO preview immediately.)
    if (skipFirstPreviewRef.current) { skipFirstPreviewRef.current = false; return; }
    // While picking a target/profile the preview is intentionally hidden so the
    // overlays/faces read clearly — don't rebuild it (a profile toggle changes
    // profileSel and would otherwise flash a preview over the overlays). It
    // rebuilds when picking ends (this effect re-runs as the flags clear).
    if (isPicking || isProfilePicking) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => buildPreview(req, params, targetSolidId, targetFacePoint, targetDatumId), 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [params, req, targetSolidId, targetFacePoint, targetDatumId, profileSel, isPicking, isProfilePicking, buildPreview]);

  // While picking a target/face, hide the in-progress geometry (live preview +
  // the edited operation's committed mesh) so the target solid's faces are fully
  // visible and clickable. Restored when picking ends (the debounce rebuilds it).
  useEffect(() => {
    if (!isPicking && !isProfilePicking) return;   // also during PROFILE_PICK → overlays read clearly
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!sc) return;
    if (debounceRef.current) clearTimeout(debounceRef.current); // cancel any pending preview
    clearPreview();
    const hidden: THREE.Object3D[] = [];
    if (req.editNodeId) {
      const obj = sc.children.find((c) => c.userData?.cadNodeId === req.editNodeId);
      if (obj && obj.visible) { obj.visible = false; hidden.push(obj); }
    }
    return () => { for (const o of hidden) o.visible = true; };
  }, [isPicking, isProfilePicking, req.editNodeId, clearPreview]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
  }, [clearPreview]);

  // ── Keyboard ────────────────────────────────────────────────────────────────
  // Use refs so the one-time listener always reads fresh values.

  const paramsRef   = useRef(params);
  const onCloseRef  = useRef(onClose);
  const reqRef      = useRef(req);
  const doApplyRef  = useRef<() => void>(() => {});
  const doCancelRef = useRef<() => void>(() => {});
  useEffect(() => { paramsRef.current  = params;  }, [params]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { reqRef.current     = req;     }, [req]);

  useEffect(() => {
    // Guard: ignore keydown events that were already in flight when the panel
    // mounted (e.g., the Enter key that activated the toolbar button).
    let armed = false;
    const armTimer = setTimeout(() => { armed = true; }, 300);

    const h = (e: KeyboardEvent) => {
      if (!armed) return;
      if (e.key === 'Escape') { e.preventDefault(); doCancelRef.current(); }
      else if (e.key === 'Enter') { e.preventDefault(); doApplyRef.current(); }
    };
    // capture:true → fires before the number-input's onKeyDown stopPropagation,
    // so Enter/Esc work even while a field is focused.
    window.addEventListener('keydown', h, true);
    return () => {
      clearTimeout(armTimer);
      window.removeEventListener('keydown', h, true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Apply / Cancel ───────────────────────────────────────────────────────────

  const doApply = () => {
    const store = useCADStore.getState();

    if (!window.oc) {
      setApplyErr('OCC kernel not ready — reload the page.');
      store.log('Op3DPanel: OCC not ready', 'error');
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
    setApplyErr(null);

    const snap = { ...params };
    // Extrude consumes only the SELECTED profiles' wires (Profile picker); other
    // ops use all targets. Persisted as the feature's targetWireIds so recompute
    // extrudes the same subset.
    const targets = req.op === 'extrude' ? effectiveTargetIds() : req.targetIds;
    if (req.op === 'extrude' && !targets.length) {
      const msg = 'Select at least one profile to extrude.';
      setApplyErr(msg); store.log(`Op3D FAIL: ${msg}`, 'error');
      return;
    }
    store.log(`Op3D Apply → op=${req.op} targets=[${targets.map(s => s.slice(0,6)).join(',')}]`, 'info');

    // ── Validate targets are resolvable to geometry ──────────────────────────
    // A target is valid if it's a registered shape OR a SKETCH container that
    // currently encloses a closed profile (loft/extrude bind to the sketch, so a
    // sketch with no shape of its own is still valid — its profile is re-derived).
    for (const wId of targets) {
      if (!canResolveProfile(window.oc, wId)) {
        const isSketch = store.nodes[wId]?.type === 'sketch';
        const msg = isSketch
          ? `Sketch "${store.nodes[wId]?.name ?? wId.slice(0, 8)}" has no closed profile — draw a closed shape in it.`
          : `Shape "${wId.slice(0, 8)}…" not in WASM registry. Re-select the sketch.`;
        setApplyErr(msg);
        store.log(`Op3D FAIL: ${msg}`, 'error');
        return;
      }
    }
    store.log('Op3D: all input shapes found in registry ✓', 'info');

    // ── Validate Up-to-Plane datum (needs a datum plane) ─────────────────────
    if (req.op === 'extrude' && Math.round(snap.endMode ?? 0) === 6) {
      if (!targetDatumId || !useCADStore.getState().nodes[targetDatumId]) {
        const msg = 'Pick an Up-to-Plane datum plane first.';
        setApplyErr(msg); store.log(`Op3D FAIL: ${msg}`, 'error');
        return;
      }
    }

    // ── Validate Pad/Pocket + Up-to-Face target (E2 / E5) ────────────────────
    const boolOp  = req.op === 'extrude' ? Math.round(snap.op ?? 0) : 0;
    const upToFace = req.op === 'extrude' && Math.round(snap.endMode ?? 0) === 3;
    if (boolOp !== 0 || upToFace) {
      if (!targetSolidId) {
        const msg = upToFace ? 'Pick an Up-to-Face target solid first.'
          : `Pick a ${boolOp === 1 ? 'Pad (Add)' : 'Pocket (Remove)'} target solid first.`;
        setApplyErr(msg); store.log(`Op3D FAIL: ${msg}`, 'error');
        return;
      }
      if (!reg.getShape(targetSolidId)) {
        const msg = 'Target solid not found — re-pick it.';
        setApplyErr(msg); store.log(`Op3D FAIL: ${msg}`, 'error');
        return;
      }
    }

    store.setProcessing(true, `${OP_TITLE[req.op]}…`);

    try {
      // ── Compute OCC shape ──────────────────────────────────────────────────
      const shape = computeShape(req.op, targets, snap, targetSolidId ?? undefined, targetFacePoint ?? undefined, targetDatumId ?? undefined);
      store.log(`Op3D: OCC shape computed ✓`, 'info');

      // Up-to-face: capture a stable signature of the picked target face (step 4)
      // against the same placed target the evaluator resolves against, so the
      // limit follows that face across upstream edits. targetFacePoint stays as
      // the positional fallback.
      let targetFaceRef: any;
      if (targetFacePoint && targetSolidId && window.oc) {
        const placedTarget = getPlacedShape(targetSolidId);
        if (placedTarget) targetFaceRef = captureFaceAtPoint(window.oc, placedTarget, targetFacePoint);
      }

      if (req.editNodeId) {
        // ── RE-EDIT ──────────────────────────────────────────────────────────
        const id  = req.editNodeId;
        const old = store.nodes[id];
        reg.registerShape(id, shape);
        window.dispatchEvent(new CustomEvent('cad-update-mesh', { detail: { id, material: old?.material } }));
        const idx = Number(old?.name?.match(/\d+$/)?.[0] ?? nextIdx(OP_NTYPE[req.op]));
        store.renameNode(id, `${OP_LABEL[req.op]}${idx}`);
        store.setNodeParams(id, { opType: req.op, targetWireIds: targets, profileCandidateIds: req.op === 'extrude' ? candidateIdsRef.current : undefined, opParams: snap, targetSolidId: targetSolidId ?? undefined, targetFacePoint: targetFacePoint ?? undefined, targetFaceRef, targetDatumId: targetDatumId ?? undefined });
        store.log(`${old?.name ?? id} updated ✓`, 'success');
        // Propagate to anything downstream (fillet / boolean / pad on this op).
        propagateFromStore(id);
      } else {
        // ── CREATE ────────────────────────────────────────────────────────────
        const type = OP_NTYPE[req.op];
        const idx  = nextIdx(type);
        const name = `${OP_LABEL[req.op]}${idx}`;
        const id   = crypto.randomUUID();

        reg.registerShape(id, shape);
        store.log(`Op3D: calling addNode id=${id.slice(0,8)} name="${name}"`, 'info');

        store.addNode({
          id, name, type, visible: true, locked: false, parentId: null, notes: '',
          transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
          material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS[type] ?? 0x5588cc },
          params:    { opType: req.op, targetWireIds: targets, profileCandidateIds: req.op === 'extrude' ? candidateIdsRef.current : undefined, opParams: snap, targetSolidId: targetSolidId ?? undefined, targetFacePoint: targetFacePoint ?? undefined, targetFaceRef, targetDatumId: targetDatumId ?? undefined },
        });

        // Verify the node is actually in the store (now placed under a component,
        // not at the root — features live in the active component's feature tree).
        const afterNodes = useCADStore.getState();
        const inTree = !!afterNodes.nodes[id];
        store.log(`Op3D: addNode done — in tree=${inTree}, node count=${Object.keys(afterNodes.nodes).length}`, inTree ? 'success' : 'error');

        window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
        // The operation references its profile sketch(es) by id (targetWireIds);
        // they remain independent siblings in the component (reuse-safe).
        store.log(`${name} created ✓`, 'success');
      }

      // Pad/Pocket consumes its target: hide it so only the combined body shows.
      // (Reversible — the node stays in the tree and can be re-shown.)
      if (boolOp !== 0 && targetSolidId) {
        const tnode = useCADStore.getState().nodes[targetSolidId];
        if (tnode?.visible) {
          store.toggleVisibility(targetSolidId);
          store.log(`Target "${tnode.name}" hidden (consumed by ${boolOp === 1 ? 'Pad' : 'Pocket'}).`, 'info');
        }
      }

      store.setProcessing(false);
      onClose();  // close ONLY on success

    } catch (err: any) {
      const msg = err?.message ?? String(err);
      store.setProcessing(false);
      store.log(`Op3D FAILED: ${msg}`, 'error');
      setApplyErr(msg);  // show in panel, keep panel open
    }
  };

  const doCancel = () => {
    clearPreview();
    // A freshly-created op (createAndEditOp) is provisional until Update — Cancel/Esc
    // removes it so no phantom extrusion/revolve/loft is left in the tree + viewport.
    // deleteNode preserves its source sketch (lifted back to root). A genuine Re-edit
    // (ephemeral=false) keeps the existing node untouched.
    if (req.ephemeral && req.editNodeId) {
      useCADStore.getState().deleteNode(req.editNodeId);
    }
    onClose();
  };
  doApplyRef.current  = doApply;  // keep Enter-key handler pointed at the latest closure
  doCancelRef.current = doCancel; // keep Esc-key handler pointed at the latest closure

  const set = (k: string, v: number) => setParams(p => ({ ...p, [k]: v }));

  // ── Render ───────────────────────────────────────────────────────────────────

  return createPortal(
    <div style={{
      position:'fixed', top: pos.y, left: pos.x, zIndex:9000, width:272,
      background:'var(--surface-2)',
      border:`1px solid ${isEdit ? 'rgba(255,153,0,0.5)' : 'var(--border)'}`,
      borderRadius:'var(--radius-md)',
      boxShadow:'0 8px 32px rgba(0,0,0,0.45)',
      overflow:'hidden', userSelect:'none',
    }}>
        <div onMouseDown={onHandleMouseDown} style={{
          padding:'8px 12px', cursor:'move',
          borderBottom:'1px solid var(--border)',
          background: isEdit ? 'rgba(255,153,0,0.08)' : 'var(--surface-1)',
          display:'flex', alignItems:'center', justifyContent:'space-between',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:15 }}>{OP_ICON[req.op]}</span>
            <span style={{ fontWeight:700, fontSize:12, color:'var(--text-primary)' }}>{OP_TITLE[req.op]}</span>
            {isEdit && <span style={{ fontSize:9, color:'#ff9900', background:'rgba(255,153,0,0.15)', borderRadius:3, padding:'1px 6px' }}>EDIT</span>}
          </div>
          <span style={{ fontSize:8, color:'var(--accent)', background:'var(--surface-3)', borderRadius:3, padding:'2px 6px', letterSpacing:'0.5px', textTransform:'uppercase' }}>
            Live Preview
          </span>
        </div>

        <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:12 }}>
          {req.op === 'extrude'  && (() => {
            const endM = Math.round(params.endMode ?? 0);
            const isUpTo = endM >= 3;                       // ↥Face / Next / Last
            const needTarget = endM === 3 || Math.round(params.op ?? 0) !== 0;
            const upToHint = endM === 3 ? 'Click a face of a solid — the extrusion stops exactly on that surface.'
              : endM === 4 ? 'Extrudes up to the next body it meets in the model.'
              : endM === 6 ? 'Extrudes up to the chosen datum plane (extended infinitely).'
              : 'Extrudes up to the last (furthest) surface in the model.';
            return (
            <>
              {profileCount >= 1 && (
                <>
                  <ProfileRow
                    count={profileCount}
                    selected={profileSel}
                    picking={isProfilePicking}
                    onPick={() => {
                      const st = useCADStore.getState();
                      if (isProfilePicking) st.endProfilePick();
                      else st.startProfilePick(profileCount, st.profilePickSelected);
                    }}
                    onToggle={(i) => useCADStore.getState().toggleProfilePick(i)}
                    onAll={() => useCADStore.getState().setProfilePickSelected(Array.from({ length: profileCount }, (_, i) => i))}
                  />
                  <div style={{ height:1, background:'var(--border-soft)', margin:'2px 0' }} />
                </>
              )}
              <ToggleRow label="Limit" k="endMode" opts={[{label:'Blind',v:0},{label:'Sym',v:1},{label:'2-Sided',v:2},{label:'↥ Face',v:3},{label:'Next',v:4},{label:'Last',v:5},{label:'↥ Plane',v:6}]} params={params} onChange={set} />
              {!isUpTo && <SliderRow label={endM===1 ? 'Length (mm)' : 'Limit 1 (mm)'} k="h" min={0.01} max={500} step={0.5} params={params} onChange={set} />}
              {endM===2 && <SliderRow label="Limit 2 (mm)" k="h2" min={0.01} max={500} step={0.5} params={params} onChange={set} />}
              {isUpTo && <div style={{ fontSize:10, color:'var(--text-muted)', fontStyle:'italic' }}>{upToHint}</div>}
              {endM===6 && (
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', minWidth:55 }}>Plane</span>
                  <select
                    value={targetDatumId ?? ''}
                    onChange={(e) => setTargetDatumId(e.target.value || null)}
                    style={{ flex:1, background:'var(--surface-3)', border:`1px solid ${targetDatumId ? '#f0a30a' : 'var(--border)'}`, borderRadius:'var(--radius-sm)', color:'var(--text-primary)', padding:'3px 6px', fontSize:11, outline:'none' }}
                  >
                    <option value="">{datumPlanes.length ? '— pick a datum plane —' : 'No datum planes — create one first'}</option>
                    {datumPlanes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                  </select>
                </div>
              )}
              <ToggleRow label="Reverse" k="reverse" opts={[{label:'Off',v:0},{label:'On',v:1}]} params={params} onChange={set} />
              {!isUpTo && <SliderRow label="Draft (°)" k="draft" min={-30} max={30} step={0.5} params={params} onChange={set} />}
              {!isUpTo && <SliderRow label="Wall (mm)" k="thick" min={0} max={20} step={0.5} params={params} onChange={set} />}
              <div style={{ height:1, background:'var(--border-soft)', margin:'2px 0' }} />
              <ToggleRow label="Result" k="op" opts={[{label:'New',v:0},{label:'Pad',v:1},{label:'Pocket',v:2}]} params={params} onChange={set} />
              {needTarget && (
                <TargetPickRow
                  targetName={targetSolidId ? (useCADStore.getState().nodes[targetSolidId]?.name ?? '—') : null}
                  isPicking={isPicking}
                  noun={endM === 3 ? 'face' : 'solid'}
                  onPick={() => useCADStore.getState().startOp3DTargetPick()}
                  onClear={() => { setTargetSolidId(null); setTargetFacePoint(null); }}
                />
              )}
            </>
            );
          })()}
          {req.op === 'revolve'  && <><SliderRow label="Angle (°)" k="angle" min={1} max={360} step={1} params={params} onChange={set} /><ToggleRow label="Axis" k="axis" opts={[{label:'X',v:0},{label:'Y',v:1},{label:'Z',v:2}]} params={params} onChange={set} /></>}
          {req.op === 'loft'     && <><ToggleRow label="Type"    k="solid" opts={[{label:'Solid',v:1},{label:'Shell',v:0}]}   params={params} onChange={set} /><ToggleRow label="Surface" k="ruled" opts={[{label:'Smooth',v:0},{label:'Ruled',v:1}]} params={params} onChange={set} /></>}
          {req.op === 'sweep'    && <div style={{ fontSize:11, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center', padding:'8px 0' }}>Sweeps profile [0] along spine [1].</div>}
          {req.op === 'fillet'   && <SliderRow label="Radius (mm)"   k="r" min={0.001} max={50} step={0.1} params={params} onChange={set} />}
          {req.op === 'chamfer'  && <SliderRow label="Distance (mm)" k="d" min={0.001} max={50} step={0.1} params={params} onChange={set} />}
        </div>

        {/* Error message — shown when Apply fails so user knows why */}
        {applyErr && (
          <div style={{
            margin: '0 14px 8px',
            padding: '6px 10px',
            background: 'rgba(220,50,50,0.12)',
            border: '1px solid rgba(220,50,50,0.4)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 10,
            color: '#ff7070',
            lineHeight: 1.5,
          }}>
            ⚠ {applyErr}
          </div>
        )}

        <div style={{ padding:'8px 14px 10px', borderTop:'1px solid var(--border-soft)', display:'flex', gap:8, justifyContent:'flex-end', alignItems:'center' }}>
          <span style={{ fontSize:9, color:'var(--text-muted)', marginRight:'auto' }}>⏎ Apply · Esc Cancel · Drag header</span>
          <button onClick={doCancel} style={{ padding:'4px 14px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer', fontSize:11 }}>Cancel</button>
          <button onClick={doApply}  style={{ padding:'4px 16px', background:'var(--accent)', border:'none', borderRadius:'var(--radius-sm)', color:'#fff', cursor:'pointer', fontSize:11, fontWeight:700 }}>
            {isEdit ? 'Update ✓' : 'Apply ✓'}
          </button>
        </div>
      </div>,
    document.body,
  );
};
