// ============================================================
// ToubkalCAD – BlendActionPanel.tsx
//
// Phase 6 – per-edge fillet / chamfer.
//
// Store-driven (blendReq), mirroring Op3DPanel:
//   • open via useCADStore.openBlendPanel(targetId, op[, editNodeId, preEdges])
//   • edge picking handled by useCADEdgeSelect (BLEND_EDGE mode)
//   • this panel = parameters + live preview + Apply/Cancel
//
// Live preview hides the source solid AND the edge-picker lines so the
// rounded/chamfered result is shown cleanly, then restores them on clear.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import {
  useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS,
} from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccConverter }        from '../services/OccConverter';
import { OccFilletService }    from '../services/OccFilletService';
import { OccEdgeService }      from '../services/OccEdgeService';
import { getPlacedShape }      from '../utils/placedShape';
import { captureEdges }        from '../services/StableRef';
import { propagateFromStore }  from '../services/RecomputeEngine.live';
import { useDragPanel }        from '../hooks/useDragPanel';

type BlendOp = 'fillet' | 'chamfer';

const reg = CADGeometryRegistry.getInstance();

/** Open the per-edge blend panel. */
export function showBlendPanel(targetId: string, op: BlendOp): void {
  useCADStore.getState().openBlendPanel(targetId, op);
}

function computeBlend(op: BlendOp, shape: any, edges: number[], value: number): any {
  return op === 'fillet'
    ? OccFilletService.filletEdges(window.oc, shape, edges, value)
    : OccFilletService.chamferEdges(window.oc, shape, edges, value);
}

function nextIdx(): number {
  return Object.values(useCADStore.getState().nodes).filter((n) => n.type === 'compound').length + 1;
}

export const BlendActionPanel: React.FC = () => {
  const blendReq   = useCADStore((s) => s.blendReq);
  const selEdges   = useCADStore((s) => s.selectedEdgeIndices);
  const closePanel = useCADStore((s) => s.closeBlendPanel);
  const setEdges   = useCADStore((s) => s.setSelectedEdgeIndices);
  const openPanel  = useCADStore((s) => s.openBlendPanel);

  const isEdit = !!blendReq?.editNodeId;
  const op     = blendReq?.op ?? 'fillet';

  const [value, setValue]       = useState<number>(1);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [edgeTotal, setEdgeTotal] = useState<number>(0);

  const previewRef    = useRef<THREE.Mesh | null>(null);
  const hiddenSolid   = useRef<THREE.Object3D | null>(null);
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doApplyRef    = useRef<() => void>(() => {});
  const doCancelRef   = useRef<() => void>(() => {});
  const { pos, onHandleMouseDown } = useDragPanel(
    Math.max(20, Math.round(window.innerWidth / 2 - 150)), 120,
  );

  // ── Initialise value from stored params on (re-)open ─────────────────────────
  useEffect(() => {
    if (!blendReq) return;
    let v = 1;
    if (blendReq.editNodeId) {
      const p = useCADStore.getState().nodes[blendReq.editNodeId]?.params;
      if (typeof p?.blendValue === 'number') v = p.blendValue;
    }
    setValue(v);
    setApplyErr(null);
    // Total edge count for the "Select All" affordance
    try {
      const shape = getPlacedShape(blendReq.targetId);
      setEdgeTotal(shape && window.oc ? OccEdgeService.edgeCount(window.oc, shape) : 0);
    } catch { setEdgeTotal(0); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blendReq?.targetId, blendReq?.op, blendReq?.editNodeId]);

  // ── Edit-mode visibility: show the source body, hide the old result ──────────
  // On the first blend the source solid was hidden (toggleVisibility). To pick
  // edges during a re-edit we must see the body, and the stale result must hide.
  // Restored to store-driven visibility when the panel closes.
  useEffect(() => {
    if (!blendReq) return;
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!sc) return;
    const srcMesh = sc.children.find((c) => c.userData?.cadNodeId === blendReq.targetId);
    const resMesh = blendReq.editNodeId
      ? sc.children.find((c) => c.userData?.cadNodeId === blendReq.editNodeId)
      : null;
    if (srcMesh) srcMesh.visible = true;
    if (resMesh) resMesh.visible = false;
    return () => {
      const st = useCADStore.getState();
      if (srcMesh) srcMesh.visible = st.nodes[blendReq.targetId]?.visible ?? true;
      if (resMesh && blendReq.editNodeId) resMesh.visible = st.nodes[blendReq.editNodeId]?.visible ?? true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blendReq?.targetId, blendReq?.editNodeId]);

  // ── Preview helpers ──────────────────────────────────────────────────────────
  const setEdgeLinesVisible = (visible: boolean) => {
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!sc) return;
    sc.children.forEach((c) => { if (c.userData?.isBlendEdge) c.visible = visible; });
  };

  const clearPreview = useCallback(() => {
    const m = previewRef.current;
    if (m) {
      const sc = (window as any).cadScene as THREE.Scene | null;
      if (sc) { try { sc.remove(m); } catch {} }
      try { m.geometry.dispose(); } catch {}
      try { (m.material as THREE.Material).dispose(); } catch {}
    }
    previewRef.current = null;
    if (hiddenSolid.current) { hiddenSolid.current.visible = true; hiddenSolid.current = null; }
    setEdgeLinesVisible(true);
    window.cadRequestRender?.();   // on-demand render: imperative scene edit needs a nudge
  }, []);

  const buildPreview = useCallback((o: BlendOp, edges: number[], v: number, targetId: string) => {
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!window.oc || !sc) return;
    clearPreview();
    if (!edges.length || v <= 0) return;
    const shape = getPlacedShape(targetId);
    if (!shape) return;
    try {
      const result = computeBlend(o, shape, edges, v);
      const geo    = OccConverter.shapeToThreeGeometry(window.oc, result, 0.2);
      const mat    = new THREE.MeshStandardMaterial({
        color: 0x4488ee, opacity: 0.78, transparent: true,
        roughness: 0.25, metalness: 0.15, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      // Hide the source solid + edge lines behind the preview
      const original = sc.children.find((c) => c.userData?.cadNodeId === targetId);
      if (original) { original.visible = false; hiddenSolid.current = original; }
      setEdgeLinesVisible(false);
      sc.add(mesh);
      previewRef.current = mesh;
      setApplyErr(null);
    } catch (e: any) {
      // keep edges visible so the user can adjust the selection / radius
      setApplyErr(e?.message ?? String(e));
    }
    window.cadRequestRender?.();   // on-demand render: draw the new preview now
  }, [clearPreview]);

  // ── Debounced preview on selection / value / op change ───────────────────────
  useEffect(() => {
    if (!blendReq) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => buildPreview(op, selEdges, value, blendReq.targetId), 280,
    );
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [blendReq, op, selEdges, value, buildPreview]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
  }, [clearPreview]);

  // ── Enter = Apply · Esc = Cancel (refs keep handlers non-stale) ──────────────
  useEffect(() => {
    if (!blendReq) return;
    let armed = false;
    const t = setTimeout(() => { armed = true; }, 300);
    const h = (e: KeyboardEvent) => {
      if (!armed) return;
      if (e.key === 'Escape')     { e.preventDefault(); doCancelRef.current(); }
      else if (e.key === 'Enter') { e.preventDefault(); doApplyRef.current(); }
    };
    // capture:true → beats the radius field's stopPropagation
    window.addEventListener('keydown', h, true);
    return () => { clearTimeout(t); window.removeEventListener('keydown', h, true); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blendReq]);

  if (!blendReq) return null;

  // ── Actions ──────────────────────────────────────────────────────────────────
  const switchOp = (next: BlendOp) => {
    if (next === op) return;
    // Re-open preserving the current edge selection + edit context
    openPanel(blendReq.targetId, next, blendReq.editNodeId, selEdges);
  };

  const selectAll = () => setEdges(Array.from({ length: edgeTotal }, (_, i) => i));
  const clearAll  = () => setEdges([]);

  const doCancel = () => { clearPreview(); closePanel(); };

  const doApply = () => {
    const store = useCADStore.getState();
    if (!window.oc) { setApplyErr('OCC kernel not ready.'); return; }
    if (!selEdges.length) { setApplyErr('Select at least one edge.'); return; }

    const shape = getPlacedShape(blendReq.targetId);
    if (!shape) { setApplyErr('Source shape not found — re-select it.'); return; }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
    store.setProcessing(true, op === 'fillet' ? 'Filleting…' : 'Chamfering…');

    try {
      const result = computeBlend(op, shape, selEdges, value);
      const label  = op === 'fillet' ? 'Fillet' : 'Chamfer';
      // Capture a stable geometric signature per picked edge against the SAME
      // placed source the evaluator will resolve against (step 4). These let the
      // selection survive upstream edits that renumber edges; edgeIndices stays
      // as the positional fallback. captureEdges is parallel to selEdges.
      const edgeRefs = captureEdges(window.oc, shape, selEdges);
      const params = { blendOp: op, sourceId: blendReq.targetId, edgeIndices: [...selEdges], edgeRefs, blendValue: value };

      if (blendReq.editNodeId) {
        const id  = blendReq.editNodeId;
        reg.registerShape(id, result);
        window.dispatchEvent(new CustomEvent('cad-update-mesh', { detail: { id, material: store.nodes[id]?.material } }));
        store.setNodeParams(id, params);
        store.log(`${store.nodes[id]?.name ?? label} updated ✓`, 'success');
        propagateFromStore(id);   // rebuild anything stacked on this blend
      } else {
        const id   = crypto.randomUUID();
        const name = `${label}${nextIdx()}`;
        reg.registerShape(id, result);
        store.addNode({
          id, name, type: 'compound', visible: true, locked: false, parentId: null, notes: '',
          transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
          material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS.compound },
          params,
        });
        window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
        // Hide the un-blended source so only the result is shown
        const src = store.nodes[blendReq.targetId];
        if (src?.visible) store.toggleVisibility(blendReq.targetId);
        store.log(`${name} created ✓`, 'success');
      }

      store.setProcessing(false);
      closePanel();
    } catch (e: any) {
      store.setProcessing(false);
      const msg = e?.message ?? String(e);
      store.log(`Blend FAILED: ${msg}`, 'error');
      setApplyErr(msg);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  doApplyRef.current  = doApply;  // keep Enter-key handler on the latest closure
  doCancelRef.current = doCancel;

  const accent  = op === 'fillet' ? '#3399dd' : '#cc7733';
  const valLabel = op === 'fillet' ? 'Radius (mm)' : 'Distance (mm)';

  const tabBtn = (o: BlendOp, label: string): React.CSSProperties => ({
    flex: 1, padding: '5px 0', fontSize: 11, cursor: 'pointer',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    background: op === o ? accent : 'var(--surface-3)',
    color: op === o ? '#fff' : 'var(--text-primary)', fontWeight: op === o ? 700 : 400,
  });

  return createPortal(
    <div style={{
      position:'fixed', top: pos.y, left: pos.x, zIndex: 9000, width: 300,
      background:'var(--surface-2)',
      border:`1px solid ${isEdit ? 'rgba(255,153,0,0.5)' : accent}`,
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
          <span style={{ fontSize:15 }}>{op === 'fillet' ? '⌒' : '⌐'}</span>
          <span style={{ fontWeight:700, fontSize:12, color:'var(--text-primary)' }}>
            {op === 'fillet' ? 'Fillet Edges' : 'Chamfer Edges'}
          </span>
          {isEdit && <span style={{ fontSize:9, color:'#ff9900', background:'rgba(255,153,0,0.15)', borderRadius:3, padding:'1px 6px' }}>EDIT</span>}
        </div>
        <span style={{ fontSize:8, color:accent, background:'var(--surface-3)', borderRadius:3, padding:'2px 6px', letterSpacing:'0.5px', textTransform:'uppercase' }}>
          Live Preview
        </span>
      </div>

      <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:12 }}>
        {/* Fillet / Chamfer toggle */}
        <div style={{ display:'flex', gap:6 }}>
          <button style={tabBtn('fillet', 'Fillet')}  onClick={() => switchOp('fillet')}>⌒ Fillet</button>
          <button style={tabBtn('chamfer', 'Chamfer')} onClick={() => switchOp('chamfer')}>⌐ Chamfer</button>
        </div>

        {/* Edge selection status */}
        <div style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          background:'var(--surface-3)', borderRadius:'var(--radius-sm)',
          border:'1px solid var(--border)', padding:'6px 10px',
        }}>
          <span style={{ fontSize:11, color: selEdges.length ? accent : 'var(--text-muted)', fontWeight:700 }}>
            {selEdges.length} / {edgeTotal} edge{selEdges.length !== 1 ? 's' : ''}
          </span>
          <div style={{ display:'flex', gap:6 }}>
            <button onClick={selectAll} style={miniBtn}>All</button>
            <button onClick={clearAll}  style={miniBtn} disabled={!selEdges.length}>Clear</button>
          </div>
        </div>

        {selEdges.length === 0 && (
          <div style={{ fontSize:10, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center' }}>
            Click edges in the viewport to select them.
          </div>
        )}

        {/* Value slider */}
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px' }}>{valLabel}</span>
            <input type="number" min={0.01} max={100} step={0.1} value={value}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setValue(Math.max(0.01, Math.min(100, v))); }}
              onKeyDown={(e) => e.stopPropagation()}
              style={{
                width:68, background:'var(--surface-3)', border:'1px solid var(--border)',
                borderRadius:'var(--radius-sm)', color:accent, padding:'2px 6px',
                fontSize:12, fontFamily:'monospace', textAlign:'right', outline:'none',
              }} />
          </div>
          <input type="range" min={0.1} max={50} step={0.1} value={value}
            onChange={(e) => setValue(parseFloat(e.target.value))}
            style={{ width:'100%', accentColor:accent, cursor:'pointer' }} />
        </div>
      </div>

      {applyErr && (
        <div style={{
          margin:'0 14px 8px', padding:'6px 10px',
          background:'rgba(220,50,50,0.12)', border:'1px solid rgba(220,50,50,0.4)',
          borderRadius:'var(--radius-sm)', fontSize:10, color:'#ff7070', lineHeight:1.5,
        }}>
          ⚠ {applyErr}
        </div>
      )}

      <div style={{ padding:'8px 14px 10px', borderTop:'1px solid var(--border-soft)', display:'flex', gap:8, justifyContent:'flex-end', alignItems:'center' }}>
        <span style={{ fontSize:9, color:'var(--text-muted)', marginRight:'auto' }}>⏎ Apply · Esc Cancel · Drag header</span>
        <button onClick={doCancel} style={{ padding:'4px 14px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer', fontSize:11 }}>Cancel</button>
        <button onClick={doApply} disabled={!selEdges.length}
          style={{
            padding:'4px 16px', background: selEdges.length ? accent : 'var(--surface-3)',
            border:'none', borderRadius:'var(--radius-sm)',
            color: selEdges.length ? '#fff' : 'var(--text-muted)',
            cursor: selEdges.length ? 'pointer' : 'not-allowed', fontSize:11, fontWeight:700,
          }}>
          {isEdit ? 'Update ✓' : 'Apply ✓'}
        </button>
      </div>
    </div>,
    document.body,
  );
};

const miniBtn: React.CSSProperties = {
  padding:'2px 9px', fontSize:10, cursor:'pointer',
  border:'1px solid var(--border)', borderRadius:'var(--radius-sm)',
  background:'var(--surface-2)', color:'var(--text-primary)',
};
