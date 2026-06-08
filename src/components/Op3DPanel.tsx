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
import { OccExtrusionService, ExtrudeEnd } from '../services/OccExtrusionService';
import { OccBooleanService }    from '../services/OccBooleanService';
import { OccRevolutionService } from '../services/OccRevolutionService';
import { OccLoftService }       from '../services/OccLoftService';
import { OccSweepService }      from '../services/OccSweepService';
import { OccFilletService }     from '../services/OccFilletService';
import { useDragPanel }         from '../hooks/useDragPanel';

// ─── Public types ─────────────────────────────────────────────────────────────

export type Op3DType = 'extrude' | 'revolve' | 'loft' | 'sweep' | 'fillet' | 'chamfer';

export interface Op3DRequest {
  op:          Op3DType;
  targetIds:   string[];
  editNodeId?: string;
}

// Module-level opener — set by CADLayout during render (before any useEffect).
// CADLayout is the root and re-renders before any user interaction, so this
// is always set by the time the user can click a toolbar button.
/** Open the 3D-operation panel by writing directly to the Zustand store. */
export function show3DOpPanel(
  op:          Op3DType,
  targetIds:   string[],
  editNodeId?: string,
): void {
  useCADStore.getState().openOp3DPanel(op, targetIds, editNodeId);
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
    if (!reg.getShape(wId)) {
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
    // Nest the consumed sketch(es) under the operation: Extrusion1 → Sketch1 → Circle1
    if (['extrude', 'revolve', 'loft', 'sweep'].includes(op)) store.adoptSketchSources(id, targetIds);
    store.log(`${name} created — adjust in the panel.`, 'success');

    // Open panel in EDIT mode
    show3DOpPanel(op, targetIds, id);
  } catch (err: any) {
    store.log(`${OP_TITLE[op]} failed: ${err?.message ?? String(err)}`, 'error');
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

const EXTRUDE_END: ExtrudeEnd[] = ['blind', 'symmetric', 'twoSided'];

function computeShape(op: Op3DType, ids: string[], p: Record<string, number>, targetSolidId?: string): any {
  const oc = window.oc;
  switch (op) {
    case 'extrude': {
      const w = reg.getShape(ids[0]);
      if (!w) throw new Error('Wire not found.');
      let solid = OccExtrusionService.extrude(oc, w, {
        height:       p.h ?? 20,
        end:          EXTRUDE_END[Math.round(p.endMode ?? 0)] ?? 'blind',
        height2:      p.h2 ?? 10,
        reverse:      (p.reverse ?? 0) >= 0.5,
        direction:    getDir(ids[0]),
        draftAngle:   p.draft ?? 0,
        neutralPoint: getOrigin(ids[0]),
        thickness:    p.thick ?? 0,
      });
      // Pad (fuse) / Pocket (cut) against an explicitly picked target solid.
      const boolOp = Math.round(p.op ?? 0);
      if ((boolOp === 1 || boolOp === 2) && targetSolidId) {
        const target = reg.getShape(targetSolidId);
        if (!target) throw new Error('Boolean target solid not found — re-pick it.');
        solid = boolOp === 1
          ? OccBooleanService.fuse(oc, target, solid)
          : OccBooleanService.subtract(oc, target, solid);
      }
      return solid;
    }
    case 'revolve': { const w=reg.getShape(ids[0]); if(!w) throw new Error('Wire not found.'); const axes:any[]=[[1,0,0],[0,1,0],[0,0,1]]; return OccRevolutionService.revolveProfile(oc,w,[0,0,0],axes[Math.round(p.axis??1)],p.angle??360); }
    case 'loft':    { const ws=ids.map(id=>reg.getShape(id)).filter(Boolean); if(ws.length<2) throw new Error('Need ≥ 2 wires.'); return OccLoftService.loftProfiles(oc,ws,(p.solid??1)>=0.5,(p.ruled??0)>=0.5); }
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
      <div style={{ display:'flex', gap:4 }}>
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
  onPick:     () => void;
  onClear:    () => void;
}> = ({ targetName, isPicking, onPick, onClear }) => (
  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
    <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', minWidth:55 }}>Target</span>
    <div style={{ display:'flex', alignItems:'center', gap:6, flex:1, minWidth:0 }}>
      <button onClick={onPick} style={{
        padding:'2px 10px', fontSize:11, cursor:'pointer', whiteSpace:'nowrap',
        border:`1px solid ${isPicking ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius:'var(--radius-sm)',
        background: isPicking ? 'var(--accent)' : 'var(--surface-3)',
        color: isPicking ? '#fff' : 'var(--text-primary)',
      }}>{isPicking ? 'Click a solid…' : (targetName ? 'Re-pick' : 'Pick target')}</button>
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
  const previewRef    = useRef<THREE.Mesh | null>(null);
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Committed meshes hidden while the preview is live (edited node + boolean target).
  const hiddenMeshesRef = useRef<THREE.Object3D[]>([]);

  // Live store values needed by the picker + UI.
  const interactionMode = useCADStore((s) => s.interactionMode);
  const pickedTarget    = useCADStore((s) => s.op3DTargetPick);
  const isPicking       = interactionMode === 'EXTRUDE_TARGET_PICK';

  // Adopt a solid the user clicked in EXTRUDE_TARGET_PICK mode, then clear the
  // one-shot store signal so re-picking the same id fires again.
  useEffect(() => {
    if (pickedTarget) {
      setTargetSolidId(pickedTarget);
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
  }, []);

  // Clear preview on any node deletion (prevents ghost meshes after tree delete)
  useEffect(() => {
    const h = () => clearPreview();
    window.addEventListener('cad-remove-mesh', h);
    return () => window.removeEventListener('cad-remove-mesh', h);
  }, [clearPreview]);

  const buildPreview = useCallback((liveReq: Op3DRequest, liveParams: Record<string, number>, liveTarget: string | null) => {
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
      const shape = computeShape(liveReq.op, liveReq.targetIds, liveParams, liveTarget ?? undefined);
      const geo   = OccConverter.shapeToThreeGeometry(window.oc, shape, 0.2);
      const mat   = new THREE.MeshStandardMaterial({ color:0x4488ee, opacity:0.70, transparent:true, roughness:0.25, metalness:0.15, side:THREE.DoubleSide });
      const mesh  = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      sc.add(mesh);
      previewRef.current = mesh;
    } catch {
      // Preview failed — restore hidden meshes so the user can still see the solids
      for (const obj of hiddenMeshesRef.current) obj.visible = true;
      hiddenMeshesRef.current = [];
    }
  }, [clearPreview]);

  // Debounce preview on param change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => buildPreview(req, params, targetSolidId), 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [params, req, targetSolidId, buildPreview]);

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
      if (e.key === 'Escape') { e.preventDefault(); clearPreview(); onCloseRef.current(); }
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
    store.log(`Op3D Apply → op=${req.op} targets=[${req.targetIds.map(s => s.slice(0,6)).join(',')}]`, 'info');

    // ── Validate shapes in registry ──────────────────────────────────────────
    for (const wId of req.targetIds) {
      if (!reg.getShape(wId)) {
        const msg = `Shape "${wId.slice(0, 8)}…" not in WASM registry. Re-select the sketch.`;
        setApplyErr(msg);
        store.log(`Op3D FAIL: ${msg}`, 'error');
        return;
      }
    }
    store.log('Op3D: all input shapes found in registry ✓', 'info');

    // ── Validate Pad/Pocket target (E2) ──────────────────────────────────────
    const boolOp = req.op === 'extrude' ? Math.round(snap.op ?? 0) : 0;
    if (boolOp !== 0) {
      if (!targetSolidId) {
        const msg = `Pick a ${boolOp === 1 ? 'Pad (Add)' : 'Pocket (Remove)'} target solid first.`;
        setApplyErr(msg); store.log(`Op3D FAIL: ${msg}`, 'error');
        return;
      }
      if (!reg.getShape(targetSolidId)) {
        const msg = 'Boolean target solid not found — re-pick it.';
        setApplyErr(msg); store.log(`Op3D FAIL: ${msg}`, 'error');
        return;
      }
    }

    store.setProcessing(true, `${OP_TITLE[req.op]}…`);

    try {
      // ── Compute OCC shape ──────────────────────────────────────────────────
      const shape = computeShape(req.op, req.targetIds, snap, targetSolidId ?? undefined);
      store.log(`Op3D: OCC shape computed ✓`, 'info');

      if (req.editNodeId) {
        // ── RE-EDIT ──────────────────────────────────────────────────────────
        const id  = req.editNodeId;
        const old = store.nodes[id];
        reg.registerShape(id, shape);
        window.dispatchEvent(new CustomEvent('cad-update-mesh', { detail: { id, material: old?.material } }));
        const idx = Number(old?.name?.match(/\d+$/)?.[0] ?? nextIdx(OP_NTYPE[req.op]));
        store.renameNode(id, `${OP_LABEL[req.op]}${idx}`);
        store.setNodeParams(id, { opType: req.op, targetWireIds: req.targetIds, opParams: snap, targetSolidId: targetSolidId ?? undefined });
        store.log(`${old?.name ?? id} updated ✓`, 'success');
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
          params:    { opType: req.op, targetWireIds: req.targetIds, opParams: snap, targetSolidId: targetSolidId ?? undefined },
        });

        // Verify the node is actually in the store
        const afterNodes = useCADStore.getState();
        const inTree = afterNodes.rootIds.includes(id);
        store.log(`Op3D: addNode done — in rootIds=${inTree}, rootIds count=${afterNodes.rootIds.length}`, inTree ? 'success' : 'error');

        window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
        // Nest the consumed sketch(es) under the operation: Extrusion1 → Sketch1 → Circle1
        if (['extrude', 'revolve', 'loft', 'sweep'].includes(req.op)) {
          store.adoptSketchSources(id, req.targetIds);
        }
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

  const doCancel = () => { clearPreview(); onClose(); };
  doApplyRef.current = doApply; // keep Enter-key handler pointed at the latest closure

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
          {req.op === 'extrude'  && (
            <>
              <ToggleRow label="Limit" k="endMode" opts={[{label:'Blind',v:0},{label:'Sym',v:1},{label:'2-Sided',v:2}]} params={params} onChange={set} />
              <SliderRow label={Math.round(params.endMode??0)===1 ? 'Length (mm)' : 'Limit 1 (mm)'} k="h" min={0.01} max={500} step={0.5} params={params} onChange={set} />
              {Math.round(params.endMode??0)===2 && <SliderRow label="Limit 2 (mm)" k="h2" min={0.01} max={500} step={0.5} params={params} onChange={set} />}
              <ToggleRow label="Reverse" k="reverse" opts={[{label:'Off',v:0},{label:'On',v:1}]} params={params} onChange={set} />
              <SliderRow label="Draft (°)" k="draft" min={-30} max={30} step={0.5} params={params} onChange={set} />
              <SliderRow label="Wall (mm)" k="thick" min={0} max={20} step={0.5} params={params} onChange={set} />
              <div style={{ height:1, background:'var(--border-soft)', margin:'2px 0' }} />
              <ToggleRow label="Result" k="op" opts={[{label:'New',v:0},{label:'Pad',v:1},{label:'Pocket',v:2}]} params={params} onChange={set} />
              {Math.round(params.op??0)!==0 && (
                <TargetPickRow
                  targetName={targetSolidId ? (useCADStore.getState().nodes[targetSolidId]?.name ?? '—') : null}
                  isPicking={isPicking}
                  onPick={() => useCADStore.getState().startOp3DTargetPick()}
                  onClear={() => setTargetSolidId(null)}
                />
              )}
            </>
          )}
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
