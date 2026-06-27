// ============================================================
// ToubkalCAD – ShellActionPanel.tsx
//
// Hollow / Thick-Solid (shelling). Store-driven (shellReq), mirroring
// BlendActionPanel:
//   • open via useCADStore.openShellPanel(targetId[, editNodeId, preFaces])
//   • OPEN-face picking handled by useCADShellFacePick (SHELL_FACE mode)
//   • this panel = wall thickness + direction + live preview + Apply/Cancel
//
// The user picks the faces to REMOVE in the viewport; this panel turns the
// remaining walls into a constant-thickness shell via OccThickSolidService.
// Live preview hides the solid AND the open-face overlays so the hollow result
// shows cleanly, then restores them on clear.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import {
  useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS,
} from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccConverter }         from '../services/OccConverter';
import { OccThickSolidService } from '../services/OccThickSolidService';
import { getPlacedShape }       from '../utils/placedShape';
import { captureFace }          from '../services/StableRef';
import { propagateFromStore }   from '../services/RecomputeEngine.live';
import { useDragPanel }         from '../hooks/useDragPanel';

const reg = CADGeometryRegistry.getInstance();
const accent = '#3399bb';

/** Open the shell panel for a target solid. */
export function showShellPanel(targetId: string): void {
  useCADStore.getState().openShellPanel(targetId);
}

/** Magnitude + direction → the signed offset OccThickSolidService expects. */
function signedThickness(magnitude: number, inward: boolean): number {
  return inward ? -Math.abs(magnitude) : Math.abs(magnitude);
}

function nextIdx(): number {
  return Object.values(useCADStore.getState().nodes).filter((n) => n.type === 'compound').length + 1;
}

export const ShellActionPanel: React.FC = () => {
  const shellReq   = useCADStore((s) => s.shellReq);
  const selFaces   = useCADStore((s) => s.selectedFaceIndices);
  const closePanel = useCADStore((s) => s.closeShellPanel);

  const isEdit = !!shellReq?.editNodeId;

  const [thickness, setThickness] = useState<number>(2);
  const [inward, setInward]       = useState<boolean>(true);
  const [applyErr, setApplyErr]   = useState<string | null>(null);

  const previewRef  = useRef<THREE.Mesh | null>(null);
  const hiddenSolid = useRef<THREE.Object3D | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doApplyRef  = useRef<() => void>(() => {});
  const doCancelRef = useRef<() => void>(() => {});
  const { pos, onHandleMouseDown } = useDragPanel(
    Math.max(20, Math.round(window.innerWidth / 2 - 150)), 120,
  );

  // ── Initialise from stored params on (re-)open ───────────────────────────────
  useEffect(() => {
    if (!shellReq) return;
    let t = 2, inw = true;
    if (shellReq.editNodeId) {
      const p = useCADStore.getState().nodes[shellReq.editNodeId]?.params;
      if (typeof p?.shellThickness === 'number') { inw = p.shellThickness < 0; t = Math.abs(p.shellThickness); }
    }
    setThickness(t);
    setInward(inw);
    setApplyErr(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellReq?.targetId, shellReq?.editNodeId]);

  // ── Edit-mode visibility: show the source body, hide the old result ──────────
  useEffect(() => {
    if (!shellReq) return;
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!sc) return;
    const srcMesh = sc.children.find((c) => c.userData?.cadNodeId === shellReq.targetId);
    const resMesh = shellReq.editNodeId
      ? sc.children.find((c) => c.userData?.cadNodeId === shellReq.editNodeId)
      : null;
    if (srcMesh) srcMesh.visible = true;
    if (resMesh) resMesh.visible = false;
    return () => {
      const st = useCADStore.getState();
      if (srcMesh) srcMesh.visible = st.nodes[shellReq.targetId]?.visible ?? true;
      if (resMesh && shellReq.editNodeId) resMesh.visible = st.nodes[shellReq.editNodeId]?.visible ?? true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellReq?.targetId, shellReq?.editNodeId]);

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
    if (hiddenSolid.current) { hiddenSolid.current.visible = true; hiddenSolid.current = null; }
    window.cadRequestRender?.();
  }, []);

  const buildPreview = useCallback((faces: number[], signed: number, targetId: string) => {
    const sc = (window as any).cadScene as THREE.Scene | null;
    if (!window.oc || !sc) return;
    clearPreview();
    if (!faces.length || signed === 0) return;
    const shape = getPlacedShape(targetId);
    if (!shape) return;
    try {
      const result = OccThickSolidService.createThickSolid(window.oc, shape, faces, signed);
      const geo    = OccConverter.shapeToThreeGeometry(window.oc, result, 0.2);
      const mat    = new THREE.MeshStandardMaterial({
        color: 0x33bbcc, opacity: 0.8, transparent: true,
        roughness: 0.3, metalness: 0.1, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      const original = sc.children.find((c) => c.userData?.cadNodeId === targetId);
      if (original) { original.visible = false; hiddenSolid.current = original; }
      sc.add(mesh);
      previewRef.current = mesh;
      setApplyErr(null);
    } catch (e: any) {
      setApplyErr(e?.message ?? String(e));
    }
    window.cadRequestRender?.();
  }, [clearPreview]);

  // ── Debounced preview on selection / thickness / direction change ────────────
  useEffect(() => {
    if (!shellReq) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const signed = signedThickness(thickness, inward);
    debounceRef.current = setTimeout(
      () => buildPreview(selFaces, signed, shellReq.targetId), 300,
    );
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [shellReq, selFaces, thickness, inward, buildPreview]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
  }, [clearPreview]);

  // ── Enter = Apply · Esc = Cancel ─────────────────────────────────────────────
  useEffect(() => {
    if (!shellReq) return;
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
  }, [shellReq]);

  if (!shellReq) return null;

  // ── Actions ──────────────────────────────────────────────────────────────────
  const doCancel = () => { clearPreview(); closePanel(); };

  const doApply = () => {
    const store = useCADStore.getState();
    if (!window.oc) { setApplyErr('OCC kernel not ready.'); return; }
    if (!selFaces.length) { setApplyErr('Pick at least one face to open.'); return; }

    const shape = getPlacedShape(shellReq.targetId);
    if (!shape) { setApplyErr('Source shape not found — re-select it.'); return; }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearPreview();
    store.setProcessing(true, 'Hollowing…');

    const signed = signedThickness(thickness, inward);
    try {
      const result = OccThickSolidService.createThickSolid(window.oc, shape, selFaces, signed);
      // Stable face signatures (parallel to selFaces) so the open-face selection
      // survives an upstream edit that renumbers faces; faceIndices is the
      // positional fallback. Captured against the SAME placed source the
      // evaluator resolves against.
      const faceRefs = selFaces.map((idx) => captureFace(window.oc, shape, idx));
      const params = {
        shellOp: true, sourceId: shellReq.targetId,
        faceIndices: [...selFaces], faceRefs, shellThickness: signed,
      };

      if (shellReq.editNodeId) {
        const id = shellReq.editNodeId;
        reg.registerShape(id, result);
        window.dispatchEvent(new CustomEvent('cad-update-mesh', { detail: { id, material: store.nodes[id]?.material } }));
        store.setNodeParams(id, params);
        store.log(`${store.nodes[id]?.name ?? 'Shell'} updated ✓`, 'success');
        propagateFromStore(id);   // rebuild anything stacked on this shell
      } else {
        const id   = crypto.randomUUID();
        const name = `Shell${nextIdx()}`;
        reg.registerShape(id, result);
        store.addNode({
          id, name, type: 'compound', visible: true, locked: false, parentId: null, notes: '',
          transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
          material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS.compound },
          params,
        });
        window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
        const src = store.nodes[shellReq.targetId];
        if (src?.visible) store.toggleVisibility(shellReq.targetId);
        store.log(`${name} created ✓`, 'success');
      }

      store.setProcessing(false);
      closePanel();
    } catch (e: any) {
      store.setProcessing(false);
      const msg = e?.message ?? String(e);
      store.log(`Shell FAILED: ${msg}`, 'error');
      setApplyErr(msg);
    }
  };

  doApplyRef.current  = doApply;
  doCancelRef.current = doCancel;

  const dirBtn = (inw: boolean, label: string): React.CSSProperties => ({
    flex: 1, padding: '5px 0', fontSize: 11, cursor: 'pointer',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    background: inward === inw ? accent : 'var(--surface-3)',
    color: inward === inw ? '#fff' : 'var(--text-primary)', fontWeight: inward === inw ? 700 : 400,
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
          <span style={{ fontSize:15 }}>◍</span>
          <span style={{ fontWeight:700, fontSize:12, color:'var(--text-primary)' }}>Shell / Hollow</span>
          {isEdit && <span style={{ fontSize:9, color:'#ff9900', background:'rgba(255,153,0,0.15)', borderRadius:3, padding:'1px 6px' }}>EDIT</span>}
        </div>
        <span style={{ fontSize:8, color:accent, background:'var(--surface-3)', borderRadius:3, padding:'2px 6px', letterSpacing:'0.5px', textTransform:'uppercase' }}>
          Live Preview
        </span>
      </div>

      <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:12 }}>
        {/* Open-face selection status */}
        <div style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          background:'var(--surface-3)', borderRadius:'var(--radius-sm)',
          border:'1px solid var(--border)', padding:'6px 10px',
        }}>
          <span style={{ fontSize:11, color: selFaces.length ? accent : 'var(--text-muted)', fontWeight:700 }}>
            {selFaces.length} open face{selFaces.length !== 1 ? 's' : ''}
          </span>
          <button onClick={() => useCADStore.getState().setSelectedFaceIndices([])} style={miniBtn} disabled={!selFaces.length}>Clear</button>
        </div>

        {selFaces.length === 0 && (
          <div style={{ fontSize:10, color:'var(--text-muted)', fontStyle:'italic', textAlign:'center' }}>
            Click the faces to remove (the opening) in the viewport.
          </div>
        )}

        {/* Direction */}
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px' }}>Wall direction</span>
          <div style={{ display:'flex', gap:6 }}>
            <button style={dirBtn(true,  'Inward')}  onClick={() => setInward(true)}>Hollow inward</button>
            <button style={dirBtn(false, 'Outward')} onClick={() => setInward(false)}>Thicken out</button>
          </div>
        </div>

        {/* Thickness */}
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px' }}>Wall thickness (mm)</span>
            <input type="number" min={0.01} max={1000} step={0.1} value={thickness}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) setThickness(Math.max(0.01, v)); }}
              onKeyDown={(e) => e.stopPropagation()}
              style={{
                width:68, background:'var(--surface-3)', border:'1px solid var(--border)',
                borderRadius:'var(--radius-sm)', color:accent, padding:'2px 6px',
                fontSize:12, fontFamily:'monospace', textAlign:'right', outline:'none',
              }} />
          </div>
          <input type="range" min={0.1} max={50} step={0.1} value={Math.min(thickness, 50)}
            onChange={(e) => setThickness(parseFloat(e.target.value))}
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
        <button onClick={doApply} disabled={!selFaces.length}
          style={{
            padding:'4px 16px', background: selFaces.length ? accent : 'var(--surface-3)',
            border:'none', borderRadius:'var(--radius-sm)',
            color: selFaces.length ? '#fff' : 'var(--text-muted)',
            cursor: selFaces.length ? 'pointer' : 'not-allowed', fontSize:11, fontWeight:700,
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
