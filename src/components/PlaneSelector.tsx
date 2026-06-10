// ============================================================
// ToubkalCAD – PlaneSelector.tsx
// Draggable floating window for choosing the sketch workplane.
// Opens automatically when a 2D sketch tool is activated.
//
// D10 — the old raw "origin + normal vector" Custom tab is retired. Custom planes
// are now first-class datum features built via the Construct commands
// (Model ▸ Datum ▸ Offset / 3-Point / Midplane / At Angle); this dialog just lets
// you sketch on an origin plane or on any existing datum plane.
// ============================================================

import React, { useState, useEffect } from 'react';
import { useCADStore, Workplane, STANDARD_WORKPLANES } from '../store/cadStore';
import { useDragPanel } from '../hooks/useDragPanel';

// ─── Sub-component: standard plane card ───────────────────────────────────────

const PlaneCard: React.FC<{
  label: string;
  desc:  string;
  color: string;
  active: boolean;
  onClick: () => void;
}> = ({ label, desc, color, active, onClick }) => (
  <button
    onClick={onClick}
    style={{
      flex: 1,
      background:   active ? color : 'var(--surface-3)',
      border:       `2px solid ${active ? color : 'var(--border)'}`,
      borderRadius: 'var(--radius-sm)',
      color:        active ? '#fff' : 'var(--text-primary)',
      padding:      '8px 4px',
      cursor:       'pointer',
      transition:   'all 0.15s',
      display:      'flex',
      flexDirection: 'column',
      alignItems:   'center',
      gap:          '3px',
    }}
    onMouseEnter={(e) => {
      if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--surface-4)';
    }}
    onMouseLeave={(e) => {
      if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--surface-3)';
    }}
  >
    <span style={{ fontSize: '18px', lineHeight: 1 }}>{
      label === 'XY' ? '▭' : label === 'YZ' ? '▯' : '▱'
    }</span>
    <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px' }}>{label}</span>
    <span style={{ fontSize: '9px', opacity: 0.75 }}>{desc}</span>
  </button>
);

// ─── Main component ───────────────────────────────────────────────────────────

export const PlaneSelector: React.FC = () => {
  const open                = useCADStore((s) => s.planeSelectorOpen);
  const pendingMode         = useCADStore((s) => s.pendingSketchMode);
  const activeWorkplane     = useCADStore((s) => s.activeWorkplane);
  const nodes               = useCADStore((s) => s.nodes);
  const startSketchSession  = useCADStore((s) => s.startSketchSession);
  const setMode             = useCADStore((s) => s.setInteractionMode);
  const close               = useCADStore((s) => s.closePlaneSelector);

  const datums = Object.values(nodes).filter((n) => n.type === 'datum_plane');

  const [tab,      setTab]      = useState<'standard' | 'datum'>('standard');
  const [selected, setSelected] = useState<string>(
    STANDARD_WORKPLANES[activeWorkplane.label] ? activeWorkplane.label : 'XY',
  );
  const [datumId,  setDatumId]  = useState<string | null>(null);
  const { pos, onHandleMouseDown } = useDragPanel(200, 120);

  const confirm = () => {
    let wp: Workplane | undefined;
    if (tab === 'standard') {
      wp = STANDARD_WORKPLANES[selected] ?? activeWorkplane;
    } else {
      wp = datumId ? (nodes[datumId]?.params?.workplane as Workplane | undefined) : undefined;
      if (!wp) return;   // nothing picked → keep the dialog open
    }
    startSketchSession(wp);   // creates parent node, sets activeWorkplane + sketchSession
    if (pendingMode) setMode(pendingMode);
    close();
  };

  const cancel = () => close();

  // Enter = confirm · Esc = cancel (global while open)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, selected, datumId]);

  if (!open) return null;

  const canConfirm = tab === 'standard' || !!datumId;

  return (
      <div
        style={{
          position:    'fixed',
          top:         pos.y,
          left:        pos.x,
          zIndex:      1000,
          width:       320,
          background:  'var(--surface-2)',
          border:      '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow:   '0 8px 32px rgba(0,0,0,0.4)',
          overflow:    'hidden',
          userSelect:  'none',
        }}
      >
        {/* ── Header (drag handle) ─────────────────────────────────────────── */}
        <div
          onMouseDown={onHandleMouseDown}
          style={{
            padding:    '10px 14px',
            borderBottom: '1px solid var(--border)',
            display:    'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor:     'move',
            background: 'var(--surface-1)',
          }}
        >
          <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
            <span style={{ fontSize:'14px' }}>✦</span>
            <span style={{ fontWeight:700, fontSize:'12px', color:'var(--text-primary)', letterSpacing:'0.3px' }}>
              Select Sketch Plane
            </span>
          </div>
          <button
            onClick={cancel}
            style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', fontSize:'14px', padding:'0 2px' }}
          >✕</button>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────────────────── */}
        <div style={{ display:'flex', borderBottom:'1px solid var(--border)' }}>
          {(['standard','datum'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex:1, padding:'7px', border:'none', cursor:'pointer',
                background:   tab===t ? 'var(--surface-3)' : 'transparent',
                color:        tab===t ? 'var(--accent)' : 'var(--text-muted)',
                fontSize:     '11px', fontWeight: tab===t ? 700 : 400,
                borderBottom: tab===t ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {t === 'standard' ? 'Origin Planes' : `Datum Planes${datums.length ? ` (${datums.length})` : ''}`}
            </button>
          ))}
        </div>

        {/* ── Content ─────────────────────────────────────────────────────── */}
        <div style={{ padding:'14px' }}>

          {tab === 'standard' && (
            <div>
              <div style={{ fontSize:'10px', color:'var(--text-muted)', marginBottom:'10px', letterSpacing:'0.4px', textTransform:'uppercase' }}>
                Choose a coordinate plane to sketch on
              </div>
              <div style={{ display:'flex', gap:'8px', marginBottom:'12px' }}>
                <PlaneCard label="XY" desc="Z=0 (top)" color="#2a7fd4"
                  active={selected==='XY'} onClick={() => setSelected('XY')} />
                <PlaneCard label="YZ" desc="X=0 (side)" color="#d45a2a"
                  active={selected==='YZ'} onClick={() => setSelected('YZ')} />
                <PlaneCard label="ZX" desc="Y=0 (front)" color="#3aaa55"
                  active={selected==='ZX'} onClick={() => setSelected('ZX')} />
              </div>
              <div style={{
                background: 'var(--surface-3)', borderRadius:'var(--radius-sm)',
                padding:'8px 10px', fontSize:'10px', color:'var(--text-dim)',
              }}>
                {selected==='XY' && <><strong>XY Plane</strong> — Normal: (0, 0, 1). Sketch in the horizontal plane. Extrudes upward (+Z).</>}
                {selected==='YZ' && <><strong>YZ Plane</strong> — Normal: (1, 0, 0). Sketch on the side face. Extrudes along +X.</>}
                {selected==='ZX' && <><strong>ZX Plane</strong> — Normal: (0, 1, 0). Sketch on the front face. Extrudes upward (+Y).</>}
              </div>
            </div>
          )}

          {tab === 'datum' && (
            <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
              <div style={{ fontSize:'10px', color:'var(--text-muted)', letterSpacing:'0.4px', textTransform:'uppercase' }}>
                Sketch on a reference plane
              </div>

              {datums.length === 0 ? (
                <div style={{
                  background:'var(--surface-3)', borderRadius:'var(--radius-sm)',
                  padding:'10px 12px', fontSize:'10px', color:'var(--text-dim)', lineHeight:1.6,
                }}>
                  No reference planes yet. Create one with the Construct commands —
                  <strong> Model ▸ Datum ▸ Offset / 3-Point / Midplane / At Angle</strong> —
                  then it will appear here to sketch on.
                </div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:'5px', maxHeight:'180px', overflowY:'auto' }}>
                  {datums.map((n) => {
                    const active = n.id === datumId;
                    return (
                      <button
                        key={n.id}
                        onClick={() => setDatumId(n.id)}
                        onDoubleClick={confirm}
                        style={{
                          display:'flex', alignItems:'center', gap:'8px', textAlign:'left',
                          padding:'7px 10px', cursor:'pointer',
                          background: active ? 'rgba(240,163,10,0.18)' : 'var(--surface-3)',
                          border:`1px solid ${active ? '#f0a30a' : 'var(--border)'}`,
                          borderRadius:'var(--radius-sm)',
                          color:'var(--text-primary)', fontSize:'11px',
                        }}
                      >
                        <span style={{ fontSize:'13px', color:'#f0a30a' }}>▱</span>
                        <span style={{ fontWeight:600 }}>{n.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div style={{
          padding:'10px 14px',
          borderTop:'1px solid var(--border)',
          display:'flex', gap:'8px', justifyContent:'flex-end',
        }}>
          <button
            onClick={cancel}
            style={{
              padding:'5px 16px', background:'none',
              border:'1px solid var(--border)', borderRadius:'var(--radius-sm)',
              color:'var(--text-dim)', cursor:'pointer', fontSize:'11px',
            }}
          >Cancel</button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            style={{
              padding:'5px 18px',
              background: canConfirm ? 'var(--accent)' : 'var(--surface-3)',
              border:'none', borderRadius:'var(--radius-sm)',
              color: canConfirm ? '#fff' : 'var(--text-muted)',
              cursor: canConfirm ? 'pointer' : 'not-allowed',
              fontSize:'11px', fontWeight:700,
            }}
          >Sketch on Plane</button>
        </div>
      </div>
  );
};
