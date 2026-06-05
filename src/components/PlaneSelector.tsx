// ============================================================
// ToubkalCAD – PlaneSelector.tsx
// Draggable floating window for choosing the sketch workplane.
// Opens automatically when a 2D sketch tool is activated.
// ============================================================

import React, { useState } from 'react';
// react-draggable ships its own types; use default export
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Draggable = (require('react-draggable').default ?? require('react-draggable')) as any;
import { useCADStore, Workplane, STANDARD_WORKPLANES } from '../store/cadStore';

// ─── Helper: compute basis from a custom normal ───────────────────────────────

function normalizeTuple(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2);
  if (len < 1e-10) return [0, 0, 1];
  return [v[0]/len, v[1]/len, v[2]/len];
}

function cross(a: [number,number,number], b: [number,number,number]): [number,number,number] {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

function buildBasis(normal: [number,number,number]): {
  uAxis: [number,number,number];
  vAxis: [number,number,number];
} {
  const n = normalizeTuple(normal);
  // Pick an arbitrary vector not parallel to n
  const ref: [number,number,number] = Math.abs(n[1]) < 0.9 ? [0,1,0] : [1,0,0];
  const u   = normalizeTuple(cross(ref, n));
  const v   = normalizeTuple(cross(n, u));
  return { uAxis: u, vAxis: v };
}

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
  const startSketchSession  = useCADStore((s) => s.startSketchSession);
  const setMode             = useCADStore((s) => s.setInteractionMode);
  const close               = useCADStore((s) => s.closePlaneSelector);

  // Local state for the custom plane inputs
  const [tab,       setTab]       = useState<'standard' | 'custom'>('standard');
  const [selected,  setSelected]  = useState<string>(activeWorkplane.label);
  const [origin,    setOrigin]    = useState<[string,string,string]>(['0','0','0']);
  const [normalIn,  setNormalIn]  = useState<[string,string,string]>(['0','1','0']);
  const [customErr, setCustomErr] = useState<string>('');

  if (!open) return null;

  const confirm = () => {
    let wp: Workplane;

    if (tab === 'standard') {
      wp = STANDARD_WORKPLANES[selected] ?? activeWorkplane;
    } else {
      // Validate custom plane
      const ox = parseFloat(origin[0]);  const oy = parseFloat(origin[1]);  const oz = parseFloat(origin[2]);
      const nx = parseFloat(normalIn[0]); const ny = parseFloat(normalIn[1]); const nz = parseFloat(normalIn[2]);
      if ([ox,oy,oz,nx,ny,nz].some(isNaN)) { setCustomErr('All fields must be numbers.'); return; }
      const mag = Math.sqrt(nx**2 + ny**2 + nz**2);
      if (mag < 1e-10) { setCustomErr('Normal vector must be non-zero.'); return; }
      const norm = normalizeTuple([nx,ny,nz]);
      const { uAxis, vAxis } = buildBasis(norm);
      wp = { label: 'Custom', origin: [ox,oy,oz], normal: norm, uAxis, vAxis };
      setCustomErr('');
    }

    startSketchSession(wp);   // creates parent node, sets activeWorkplane + sketchSession
    if (pendingMode) setMode(pendingMode);
    close();
  };

  const cancel = () => {
    close();
  };

  // Number input helper
  const numInput = (
    val: string,
    onChange: (v: string) => void,
    placeholder = '0',
  ) => (
    <input
      type="number"
      value={val}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      step="any"
      style={{
        width: '100%',
        background: 'var(--surface-3)',
        border:     '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        color:      'var(--text-primary)',
        padding:    '5px 7px',
        fontSize:   '11px',
        outline:    'none',
      }}
      onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
      onBlur={(e)  => { e.target.style.borderColor = 'var(--border)'; }}
    />
  );

  return (
    <Draggable handle=".plane-sel-handle" bounds="parent" defaultPosition={{ x: 200, y: 120 }}>
      <div
        style={{
          position:    'fixed',
          zIndex:      1000,
          width:       320,
          background:  'var(--surface-2)',
          border:      '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow:   '0 8px 32px rgba(0,0,0,0.4)',
          overflow:    'hidden',
          userSelect:  'none',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ── Header (drag handle) ─────────────────────────────────────────── */}
        <div
          className="plane-sel-handle"
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
          {(['standard','custom'] as const).map((t) => (
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
              {t === 'standard' ? 'Standard Planes' : 'Custom Plane'}
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
              {/* Info row */}
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

          {tab === 'custom' && (
            <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
              <div style={{ fontSize:'10px', color:'var(--text-muted)', letterSpacing:'0.4px', textTransform:'uppercase' }}>
                Define plane by origin + normal vector
              </div>

              <div>
                <label style={{ fontSize:'10px', color:'var(--text-dim)', display:'block', marginBottom:'5px', textTransform:'uppercase', letterSpacing:'0.4px' }}>
                  Origin (x, y, z)
                </label>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'5px' }}>
                  {(['x','y','z'] as const).map((ax,i) => (
                    <div key={ax}>
                      <div style={{ fontSize:'9px', color:'var(--text-muted)', marginBottom:'2px', textAlign:'center' }}>{ax.toUpperCase()}</div>
                      {numInput(origin[i], (v) => setOrigin((p) => { const n=[...p] as [string,string,string]; n[i]=v; return n; }))}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize:'10px', color:'var(--text-dim)', display:'block', marginBottom:'5px', textTransform:'uppercase', letterSpacing:'0.4px' }}>
                  Normal vector (nx, ny, nz)
                </label>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'5px' }}>
                  {(['nx','ny','nz'] as const).map((ax,i) => (
                    <div key={ax}>
                      <div style={{ fontSize:'9px', color:'var(--text-muted)', marginBottom:'2px', textAlign:'center' }}>{ax.toUpperCase()}</div>
                      {numInput(normalIn[i], (v) => setNormalIn((p) => { const n=[...p] as [string,string,string]; n[i]=v; return n; }), i===1?'1':'0')}
                    </div>
                  ))}
                </div>
                {customErr && (
                  <div style={{ fontSize:'10px', color:'var(--error)', marginTop:'5px' }}>{customErr}</div>
                )}
              </div>
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
            style={{
              padding:'5px 18px', background:'var(--accent)', border:'none',
              borderRadius:'var(--radius-sm)', color:'#fff',
              cursor:'pointer', fontSize:'11px', fontWeight:700,
            }}
          >Sketch on Plane</button>
        </div>
      </div>
    </Draggable>
  );
};
