// ============================================================
// ToubkalCAD – BooleanActionPanel.tsx
//
// Phase 7 – guided boolean operation (Union / Subtract / Intersect).
//
// Store-driven (booleanReq), mirroring BlendActionPanel:
//   • open via useCADStore.openBooleanPanel(op[, editNodeId, base, tools])
//   • solid picking handled by useCADBooleanPick (BOOLEAN_PICK mode)
//   • this panel = op choice + base/tool status + live preview + Apply/Cancel
//
// Supports one BASE solid and one-or-more TOOL solids (folded pairwise).
// Apply hides the consumed input solids so only the result is shown.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import {
  useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS,
} from '../store/cadStore';
import type { BooleanOp } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccConverter }        from '../services/OccConverter';
import { OccBooleanService }   from '../services/OccBooleanService';
import { useDragPanel }        from '../hooks/useDragPanel';

const reg = CADGeometryRegistry.getInstance();

const OP_META: Record<BooleanOp, { label: string; icon: string; accent: string; hint: string }> = {
  CUT:    { label: 'Subtract',  icon: '⊖', accent: '#bb4444', hint: 'base − tools' },
  FUSE:   { label: 'Union',     icon: '⊕', accent: '#3a9a55', hint: 'base + tools' },
  COMMON: { label: 'Intersect', icon: '⊗', accent: '#b08a33', hint: 'base ∩ tools' },
};

/** Open the guided boolean panel. */
export function showBooleanPanel(op: BooleanOp, baseId?: string | null, toolIds?: string[]): void {
  useCADStore.getState().openBooleanPanel(op, undefined, baseId ?? null, toolIds ?? []);
}

/** Fold the boolean over base + each tool using the pairwise OCC operations. */
function computeBoolean(op: BooleanOp, baseShape: any, toolShapes: any[]): any {
  const oc = window.oc;
  let result = baseShape;
  for (const tool of toolShapes) {
    if (op === 'CUT')        result = OccBooleanService.subtract(oc, result, tool);
    else if (op === 'FUSE')  result = OccBooleanService.fuse(oc, result, tool);
    else                     result = OccBooleanService.intersect(oc, result, tool);
  }
  return result;
}

function nextIdx(): number {
  return Object.values(useCADStore.getState().nodes).filter((n) => n.type === 'boolean_operation').length + 1;
}

export const BooleanActionPanel: React.FC = () => {
  const booleanReq = useCADStore((s) => s.booleanReq);
  const baseId     = useCADStore((s) => s.booleanBaseId);
  const toolIds    = useCADStore((s) => s.booleanToolIds);
  const nodes      = useCADStore((s) => s.nodes);
  const closePanel = useCADStore((s) => s.closeBooleanPanel);
  const clearPick  = useCADStore((s) => s.clearBooleanPick);
  const openPanel  = useCADStore((s) => s.openBooleanPanel);

  const isEdit = !!booleanReq?.editNodeId;
  const op     = booleanReq?.op ?? 'CUT';
  const meta   = OP_META[op];

  const [applyErr, setApplyErr] = useState<string | null>(null);
  const previewRef  = useRef<THREE.Mesh | null>(null);
  const hiddenRef   = useRef<THREE.Object3D[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doApplyRef  = useRef<() => void>(() => {});
  const doCancelRef = useRef<() => void>(() => {});
  const { pos, onHandleMouseDown } = useDragPanel(
    Math.max(20, Math.round(window.innerWidth / 2 - 160)), 120,
  );

  // ── Edit-mode visibility: show the inputs, hide the stale result ─────────────
  useEffect(() => {
    if (!booleanReq) return;
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!sc) return;
    const inputIds = new Set([baseId, ...toolIds].filter(Boolean) as string[]);
    const shown: THREE.Object3D[] = [];
    let resMesh: THREE.Object3D | undefined;
    sc.children.forEach((c) => {
      const id = c.userData?.cadNodeId as string | undefined;
      if (!id) return;
      if (inputIds.has(id)) { if (!c.visible) { c.visible = true; shown.push(c); } }
      if (booleanReq.editNodeId && id === booleanReq.editNodeId) resMesh = c;
    });
    if (resMesh) resMesh.visible = false;
    return () => {
      const st = useCADStore.getState();
      shown.forEach((c) => { const id = c.userData?.cadNodeId; c.visible = st.nodes[id]?.visible ?? true; });
      if (resMesh && booleanReq.editNodeId) resMesh.visible = st.nodes[booleanReq.editNodeId]?.visible ?? true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booleanReq?.editNodeId, baseId, toolIds.join(',')]);

  // ── Preview helpers ──────────────────────────────────────────────────────────
  const clearPreview = useCallback(() => {
    const m = previewRef.current;
    if (m) {
      const sc = (window as any).cadScene as THREE.Scene | null;
      if (sc) { try { sc.remove(m); } catch {} }
      try { m.geometry.dispose(); } catch {}
      try { (m.material as THREE.Material).dispose(); } catch {}
    }
    previewRef.current = null;
    hiddenRef.current.forEach((o) => { o.visible = true; });
    hiddenRef.current = [];
  }, []);

  const buildPreview = useCallback((o: BooleanOp, base: string | null, tools: string[]) => {
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!window.oc || !sc) return;
    clearPreview();
    if (!base || !tools.length) return;
    const baseShape = reg.getShape(base);
    const toolShapes = tools.map((t) => reg.getShape(t)).filter(Boolean);
    if (!baseShape || toolShapes.length !== tools.length) return;
    try {
      const result = computeBoolean(o, baseShape, toolShapes);
      const geo    = OccConverter.shapeToThreeGeometry(window.oc, result, 0.2);
      const mat    = new THREE.MeshStandardMaterial({
        color: 0x4488ee, opacity: 0.8, transparent: true,
        roughness: 0.25, metalness: 0.15, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      // Hide all input solids behind the preview
      const ids = new Set([base, ...tools]);
      sc.children.forEach((c) => {
        if (c.userData?.cadNodeId && ids.has(c.userData.cadNodeId) && c.visible) {
          c.visible = false; hiddenRef.current.push(c);
        }
      });
      sc.add(mesh);
      previewRef.current = mesh;
      setApplyErr(null);
    } catch (e: any) {
      setApplyErr(e?.message ?? String(e));
    }
  }, [clearPreview]);

  // ── Debounced preview ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!booleanReq) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => buildPreview(op, baseId, toolIds), 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [booleanReq, op, baseId, toolIds, buildPreview]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
  }, [clearPreview]);

  // ── Enter = Apply · Esc = Cancel ─────────────────────────────────────────────
  useEffect(() => {
    if (!booleanReq) return;
    let armed = false;
    const t = setTimeout(() => { armed = true; }, 300);
    const h = (e: KeyboardEvent) => {
      if (!armed) return;
      if (e.key === 'Escape')     { e.preventDefault(); doCancelRef.current(); }
      else if (e.key === 'Enter') { e.preventDefault(); doApplyRef.current(); }
    };
    window.addEventListener('keydown', h, true);
    return () => { clearTimeout(t); window.removeEventListener('keydown', h, true); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booleanReq]);

  if (!booleanReq) return null;

  // ── Actions ──────────────────────────────────────────────────────────────────
  const switchOp = (next: BooleanOp) => {
    if (next === op) return;
    openPanel(next, booleanReq.editNodeId, baseId, toolIds); // preserve picks
  };

  const doCancel = () => { clearPreview(); closePanel(); };

  const doApply = () => {
    const store = useCADStore.getState();
    if (!window.oc) { setApplyErr('OCC kernel not ready.'); return; }
    if (!baseId)        { setApplyErr('Pick a base solid first.'); return; }
    if (!toolIds.length) { setApplyErr('Pick at least one tool solid.'); return; }

    const baseShape = reg.getShape(baseId);
    const toolShapes = toolIds.map((t) => reg.getShape(t)).filter(Boolean);
    if (!baseShape || toolShapes.length !== toolIds.length) {
      setApplyErr('A selected solid is missing from the registry.'); return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
    store.setProcessing(true, `${meta.label}…`);
    try {
      const result = computeBoolean(op, baseShape, toolShapes);
      const params = { boolOp: op, baseId, toolIds: [...toolIds] };

      if (booleanReq.editNodeId) {
        const id = booleanReq.editNodeId;
        reg.registerShape(id, result);
        window.dispatchEvent(new CustomEvent('cad-update-mesh', { detail: { id, material: store.nodes[id]?.material } }));
        store.setNodeParams(id, params);
        store.log(`${store.nodes[id]?.name ?? meta.label} updated ✓`, 'success');
      } else {
        const id   = crypto.randomUUID();
        const name = `${meta.label}${nextIdx()}`;
        reg.registerShape(id, result);
        store.addNode({
          id, name, type: 'boolean_operation', visible: true, locked: false, parentId: null, notes: '',
          transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
          material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS.boolean_operation },
          params,
        });
        window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
        // Hide the consumed inputs so only the result is shown
        [baseId, ...toolIds].forEach((iid) => { if (store.nodes[iid]?.visible) store.toggleVisibility(iid); });
        store.log(`${name} created ✓`, 'success');
      }
      store.setProcessing(false);
      closePanel();
    } catch (e: any) {
      store.setProcessing(false);
      const msg = e?.message ?? String(e);
      store.log(`Boolean FAILED: ${msg}`, 'error');
      setApplyErr(msg);
    }
  };

  doApplyRef.current  = doApply;
  doCancelRef.current = doCancel;

  // ── Render ───────────────────────────────────────────────────────────────────
  const ready = !!baseId && toolIds.length > 0;
  const step  = !baseId ? 1 : 2;

  const tabBtn = (o: BooleanOp): React.CSSProperties => ({
    flex: 1, padding: '5px 0', fontSize: 11, cursor: 'pointer',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    background: op === o ? OP_META[o].accent : 'var(--surface-3)',
    color: op === o ? '#fff' : 'var(--text-primary)', fontWeight: op === o ? 700 : 400,
  });

  const chip = (label: string, color: string): React.CSSProperties => ({
    fontSize: 10, color: '#fff', background: color, borderRadius: 3,
    padding: '2px 7px', whiteSpace: 'nowrap', maxWidth: 130,
    overflow: 'hidden', textOverflow: 'ellipsis',
  });

  return createPortal(
    <div style={{
      position:'fixed', top: pos.y, left: pos.x, zIndex: 9000, width: 320,
      background:'var(--surface-2)',
      border:`1px solid ${isEdit ? 'rgba(255,153,0,0.5)' : meta.accent}`,
      borderRadius:'var(--radius-md)',
      boxShadow:'0 8px 32px rgba(0,0,0,0.45)', overflow:'hidden', userSelect:'none',
    }}>
      {/* Header (drag handle) */}
      <div onMouseDown={onHandleMouseDown} style={{
        padding:'8px 12px', borderBottom:'1px solid var(--border)', cursor:'move',
        background: isEdit ? 'rgba(255,153,0,0.08)' : 'var(--surface-1)',
        display:'flex', alignItems:'center', justifyContent:'space-between',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:15 }}>{meta.icon}</span>
          <span style={{ fontWeight:700, fontSize:12, color:'var(--text-primary)' }}>{meta.label}</span>
          {isEdit && <span style={{ fontSize:9, color:'#ff9900', background:'rgba(255,153,0,0.15)', borderRadius:3, padding:'1px 6px' }}>EDIT</span>}
        </div>
        <span style={{ fontSize:8, color:meta.accent, background:'var(--surface-3)', borderRadius:3, padding:'2px 6px', letterSpacing:'0.5px', textTransform:'uppercase' }}>
          Live Preview
        </span>
      </div>

      <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:12 }}>
        {/* Op toggle */}
        <div style={{ display:'flex', gap:6 }}>
          <button style={tabBtn('FUSE')}   onClick={() => switchOp('FUSE')}>⊕ Union</button>
          <button style={tabBtn('CUT')}    onClick={() => switchOp('CUT')}>⊖ Subtract</button>
          <button style={tabBtn('COMMON')} onClick={() => switchOp('COMMON')}>⊗ Intersect</button>
        </div>

        {/* Step hint */}
        <div style={{
          fontSize: 11, color: ready ? 'var(--text-muted)' : meta.accent, fontWeight: ready ? 400 : 700,
          background:'var(--surface-3)', borderRadius:'var(--radius-sm)', border:'1px solid var(--border)',
          padding:'6px 10px',
        }}>
          {step === 1
            ? '① Click the BASE solid in the viewport'
            : `② Click TOOL solid(s) — result = ${meta.hint}`}
        </div>

        {/* Base + tools status */}
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:10, color:'var(--text-dim)', width:40 }}>BASE</span>
            {baseId
              ? <span style={chip(nodes[baseId]?.name ?? baseId.slice(0,6), '#2a5fb0')}>{nodes[baseId]?.name ?? baseId.slice(0,6)}</span>
              : <span style={{ fontSize:10, color:'var(--text-muted)', fontStyle:'italic' }}>not picked</span>}
          </div>
          <div style={{ display:'flex', alignItems:'flex-start', gap:8 }}>
            <span style={{ fontSize:10, color:'var(--text-dim)', width:40, paddingTop:2 }}>TOOLS</span>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {toolIds.length
                ? toolIds.map((t) => <span key={t} style={chip(nodes[t]?.name ?? t.slice(0,6), '#b06a2a')}>{nodes[t]?.name ?? t.slice(0,6)}</span>)
                : <span style={{ fontSize:10, color:'var(--text-muted)', fontStyle:'italic', paddingTop:2 }}>none</span>}
            </div>
          </div>
        </div>

        <div style={{ display:'flex', justifyContent:'flex-end' }}>
          <button onClick={clearPick} disabled={!baseId && !toolIds.length} style={{
            padding:'2px 10px', fontSize:10, cursor: (baseId || toolIds.length) ? 'pointer' : 'not-allowed',
            border:'1px solid var(--border)', borderRadius:'var(--radius-sm)',
            background:'var(--surface-3)', color:'var(--text-primary)', opacity:(baseId||toolIds.length)?1:0.5,
          }}>Clear</button>
        </div>
      </div>

      {applyErr && (
        <div style={{
          margin:'0 14px 8px', padding:'6px 10px',
          background:'rgba(220,50,50,0.12)', border:'1px solid rgba(220,50,50,0.4)',
          borderRadius:'var(--radius-sm)', fontSize:10, color:'#ff7070', lineHeight:1.5,
        }}>⚠ {applyErr}</div>
      )}

      <div style={{ padding:'8px 14px 10px', borderTop:'1px solid var(--border-soft)', display:'flex', gap:8, justifyContent:'flex-end', alignItems:'center' }}>
        <span style={{ fontSize:9, color:'var(--text-muted)', marginRight:'auto' }}>⏎ Apply · Esc Cancel · Drag header</span>
        <button onClick={doCancel} style={{ padding:'4px 14px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer', fontSize:11 }}>Cancel</button>
        <button onClick={doApply} disabled={!ready}
          style={{
            padding:'4px 16px', background: ready ? meta.accent : 'var(--surface-3)',
            border:'none', borderRadius:'var(--radius-sm)',
            color: ready ? '#fff' : 'var(--text-muted)',
            cursor: ready ? 'pointer' : 'not-allowed', fontSize:11, fontWeight:700,
          }}>
          {isEdit ? 'Update ✓' : 'Apply ✓'}
        </button>
      </div>
    </div>,
    document.body,
  );
};
