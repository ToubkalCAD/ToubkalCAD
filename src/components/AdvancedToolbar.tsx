// ============================================================
// ToubkalCAD – AdvancedToolbar.tsx
// Operations: Revolve · Sweep · Loft
//
// All three operations work from the current selection:
//   Revolve  – 1 sketch_wire selected  + axis / angle dialog
//   Sweep    – 2 sketch_wires selected (1st = profile, 2nd = spine)
//   Loft     – 2+ sketch_wires selected (ordered top→bottom)
// ============================================================

import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS } from '../store/cadStore';
import { OccRevolutionService } from '../services/OccRevolutionService';
import { OccSweepService }      from '../services/OccSweepService';
import { OccLoftService }       from '../services/OccLoftService';
import { CADGeometryRegistry }  from '../services/CADGeometryRegistry';

declare global { interface Window { oc: any } }

// ─── Reusable sub-components ──────────────────────────────────────────────────

const Sep = () => (
  <div style={{ width:'1px', height:'24px', background:'var(--border)', margin:'0 2px', flexShrink:0 }} />
);

const Grp: React.FC<{ label: string }> = ({ label }) => (
  <span style={{
    fontSize:'8px', color:'var(--text-muted)', textTransform:'uppercase',
    letterSpacing:'0.7px', userSelect:'none', flexShrink:0,
  }}>{label}</span>
);

const Btn: React.FC<{
  icon: string; label: string; onClick: () => void;
  disabled?: boolean; accent?: string; title?: string;
}> = ({ icon, label, onClick, disabled, accent = '#cc4488', title }) => (
  <button
    onClick={onClick} disabled={disabled} title={title ?? label}
    style={{
      background:   disabled ? 'var(--surface-3)' : 'var(--surface-3)',
      color:        disabled ? 'var(--text-muted)' : 'var(--text-primary)',
      border:       '1px solid var(--border)',
      padding:      '3px 8px',
      borderRadius: 'var(--radius-sm)',
      cursor:       disabled ? 'not-allowed' : 'pointer',
      fontSize:     '11px',
      display:      'flex', alignItems:'center', gap:'4px',
      flexShrink:   0, whiteSpace:'nowrap',
      transition:   'all 0.1s',
      opacity:      disabled ? 0.45 : 1,
    }}
    onMouseEnter={(e) => {
      if (!disabled) (e.currentTarget as HTMLElement).style.background = accent + '33';
    }}
    onMouseLeave={(e) => {
      (e.currentTarget as HTMLElement).style.background = 'var(--surface-3)';
    }}
  >
    <span style={{ fontSize:'13px' }}>{icon}</span>
    <span>{label}</span>
  </button>
);

// ─── Number input helper ─────────────────────────────────────────────────────

const NumInput: React.FC<{
  label: string; value: string;
  onChange: (v: string) => void;
  step?: string;
}> = ({ label, value, onChange, step = '0.1' }) => (
  <div style={{ display:'flex', flexDirection:'column', gap:'3px' }}>
    <label style={{ fontSize:'9px', color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px' }}>
      {label}
    </label>
    <input
      type="number" value={value} step={step}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width:'70px', background:'var(--surface-3)', border:'1px solid var(--border)',
        borderRadius:'var(--radius-sm)', color:'var(--text-primary)',
        padding:'4px 6px', fontSize:'11px', outline:'none',
      }}
      onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
      onBlur={(e)  => { e.target.style.borderColor = 'var(--border)'; }}
    />
  </div>
);

// ─── Revolve dialog ───────────────────────────────────────────────────────────

type AxisPreset = 'X' | 'Y' | 'Z' | 'Custom';

interface RevolveDialogProps {
  profileName: string;
  onConfirm:   (axisOrigin: [number,number,number], axisDir: [number,number,number], angleDeg: number) => void;
  onCancel:    () => void;
}

const AXIS_PRESETS: Record<AxisPreset, [number,number,number]> = {
  X: [1,0,0], Y: [0,1,0], Z: [0,0,1], Custom: [0,1,0],
};

const RevolveDialog: React.FC<RevolveDialogProps> = ({ profileName, onConfirm, onCancel }) => {
  const [preset, setPreset] = useState<AxisPreset>('Y');
  const [ox, setOx] = useState('0'); const [oy, setOy] = useState('0'); const [oz, setOz] = useState('0');
  const [dx, setDx] = useState('0'); const [dy, setDy] = useState('1'); const [dz, setDz] = useState('0');
  const [angle, setAngle] = useState('360');
  const [err, setErr] = useState('');

  const applyPreset = (p: AxisPreset) => {
    setPreset(p);
    if (p !== 'Custom') {
      const [a,b,c] = AXIS_PRESETS[p];
      setDx(String(a)); setDy(String(b)); setDz(String(c));
    }
  };

  const confirm = () => {
    const vals = [ox,oy,oz,dx,dy,dz,angle].map(parseFloat);
    if (vals.some(isNaN)) { setErr('All fields must be valid numbers.'); return; }
    const [pox,poy,poz,pdx,pdy,pdz,pangle] = vals;
    const mag = Math.sqrt(pdx*pdx+pdy*pdy+pdz*pdz);
    if (mag < 1e-10) { setErr('Direction vector must be non-zero.'); return; }
    if (pangle <= 0 || pangle > 360) { setErr('Angle must be 1–360°.'); return; }
    setErr('');
    onConfirm([pox,poy,poz],[pdx,pdy,pdz],pangle);
  };

  return createPortal(
    <div className="cad-modal-overlay" onClick={onCancel}>
      <div
        className="cad-modal"
        style={{ width:380 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key==='Enter') confirm(); if (e.key==='Escape') onCancel(); }}
      >
        {/* Header */}
        <div style={{ padding:'11px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontWeight:700, fontSize:'12px', color:'var(--text-primary)' }}>
            ↻ Revolve — <span style={{ color:'#cc4488', fontWeight:400 }}>{profileName}</span>
          </span>
          <button onClick={onCancel} style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', fontSize:'14px' }}>✕</button>
        </div>

        <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:'14px' }}>
          {/* Axis preset buttons */}
          <div>
            <div style={{ fontSize:'10px', color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', marginBottom:'7px' }}>
              Axis Preset
            </div>
            <div style={{ display:'flex', gap:'6px' }}>
              {(['X','Y','Z','Custom'] as AxisPreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => applyPreset(p)}
                  style={{
                    flex:1, padding:'6px 4px', border:'1px solid var(--border)',
                    borderRadius:'var(--radius-sm)', cursor:'pointer',
                    background: preset===p ? '#cc448833' : 'var(--surface-3)',
                    color:      preset===p ? '#cc4488'  : 'var(--text-primary)',
                    fontSize:'11px', fontWeight: preset===p ? 700 : 400,
                    borderColor: preset===p ? '#cc4488' : 'var(--border)',
                  }}
                >
                  {p === 'Custom' ? '⊞ Custom' : `${p} axis`}
                </button>
              ))}
            </div>
          </div>

          {/* Axis origin */}
          <div>
            <div style={{ fontSize:'10px', color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', marginBottom:'7px' }}>
              Axis origin (world units)
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px' }}>
              <NumInput label="X" value={ox} onChange={setOx} />
              <NumInput label="Y" value={oy} onChange={setOy} />
              <NumInput label="Z" value={oz} onChange={setOz} />
            </div>
          </div>

          {/* Axis direction (editable when Custom) */}
          <div>
            <div style={{ fontSize:'10px', color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.4px', marginBottom:'7px' }}>
              Axis direction {preset !== 'Custom' && <span style={{ color:'var(--text-muted)' }}>(from preset)</span>}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', opacity: preset==='Custom' ? 1 : 0.6 }}>
              <NumInput label="DX" value={dx} onChange={v => { setPreset('Custom'); setDx(v); }} />
              <NumInput label="DY" value={dy} onChange={v => { setPreset('Custom'); setDy(v); }} />
              <NumInput label="DZ" value={dz} onChange={v => { setPreset('Custom'); setDz(v); }} />
            </div>
          </div>

          {/* Angle */}
          <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
            <NumInput label="Angle (degrees)" value={angle} onChange={setAngle} step="1" />
            <div style={{ display:'flex', gap:'5px', marginTop:'14px' }}>
              {[90, 180, 270, 360].map((a) => (
                <button key={a} onClick={() => setAngle(String(a))}
                  style={{
                    padding:'3px 8px', fontSize:'10px', border:'1px solid var(--border)',
                    borderRadius:'var(--radius-sm)', cursor:'pointer',
                    background: angle===String(a) ? '#cc448822' : 'var(--surface-3)',
                    color:'var(--text-primary)',
                  }}
                >
                  {a}°
                </button>
              ))}
            </div>
          </div>

          {err && <div style={{ fontSize:'10px', color:'var(--error)' }}>{err}</div>}
        </div>

        {/* Footer */}
        <div style={{ padding:'10px 16px', borderTop:'1px solid var(--border)', display:'flex', gap:'8px', justifyContent:'flex-end' }}>
          <button onClick={onCancel} style={{ padding:'5px 14px', background:'none', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer', fontSize:'11px' }}>
            Cancel
          </button>
          <button onClick={confirm} style={{ padding:'5px 18px', background:'#cc4488', border:'none', borderRadius:'var(--radius-sm)', color:'#fff', cursor:'pointer', fontSize:'11px', fontWeight:700 }}>
            Revolve
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

// ─── Main toolbar ─────────────────────────────────────────────────────────────

export const AdvancedToolbar: React.FC = () => {
  const selIds  = useCADStore((s) => s.selectedIds);
  const nodes   = useCADStore((s) => s.nodes);
  const addNode = useCADStore((s) => s.addNode);
  const setProc = useCADStore((s) => s.setProcessing);
  const log     = useCADStore((s) => s.log);
  const reg     = CADGeometryRegistry.getInstance();

  const [revolveOpen, setRevolveOpen] = useState(false);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const withOC = useCallback((fn: () => void | Promise<void>) => {
    if (!window.oc) { log('OCC kernel not ready.', 'error'); return; }
    Promise.resolve().then(fn).catch((e: any) => { log(e.message ?? String(e), 'error'); });
  }, [log]);

  const registerResult = useCallback((id: string, name: string, type: any, shape: any, params: Record<string, any>) => {
    reg.registerShape(id, shape);
    addNode({
      id, name, type, visible:true, locked:false, parentId:null, notes:'',
      transform: { position:[0,0,0], rotation:[0,0,0], scale:[1,1,1] },
      material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS[type as keyof typeof NODE_TYPE_COLORS] ?? 0x888888 },
      params,
    });
    window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
    useCADStore.getState().setSelectedIds([id]);
    log(`${name} created.`, 'success');
  }, [reg, addNode, log]);

  // ─── Selected sketches ──────────────────────────────────────────────────────

  const sketchSels = selIds.filter((id) => nodes[id]?.type === 'sketch_wire');

  // ─── Revolve ───────────────────────────────────────────────────────────────

  const canRevolve = sketchSels.length === 1;

  const handleRevolve = (axisOrigin: [number,number,number], axisDir: [number,number,number], angleDeg: number) => {
    setRevolveOpen(false);
    withOC(() => {
      const profileId = sketchSels[0];
      const wire = reg.getShape(profileId);
      if (!wire) { log('Profile wire not found.', 'error'); return; }
      setProc(true, `Revolving ${angleDeg}°…`);
      try {
        const solid = OccRevolutionService.revolveProfile(window.oc, wire, axisOrigin, axisDir, angleDeg);
        const name  = `Revolve-${angleDeg}° (${nodes[profileId]?.name ?? profileId.slice(0,6)})`;
        registerResult(crypto.randomUUID(), name, 'revolve', solid, {
          profileId, axisOrigin, axisDir, angleDeg,
        });
      } finally {
        setProc(false);
      }
    });
  };

  // ─── Sweep ─────────────────────────────────────────────────────────────────

  const canSweep = sketchSels.length === 2;

  const handleSweep = () => {
    withOC(() => {
      const [profileId, spineId] = sketchSels;
      const profile = reg.getShape(profileId);
      const spine   = reg.getShape(spineId);
      if (!profile || !spine) { log('Profile or spine wire not found.', 'error'); return; }
      setProc(true, 'Computing sweep…');
      try {
        const solid = OccSweepService.sweepProfile(window.oc, profile, spine);
        const name  = `Sweep (${nodes[profileId]?.name ?? 'profile'} along ${nodes[spineId]?.name ?? 'spine'})`;
        registerResult(crypto.randomUUID(), name, 'sweep', solid, { profileId, spineId });
      } finally {
        setProc(false);
      }
    });
  };

  // ─── Loft ──────────────────────────────────────────────────────────────────

  const canLoft = sketchSels.length >= 2;

  const handleLoft = () => {
    withOC(() => {
      const wires = sketchSels.map((id) => reg.getShape(id)).filter(Boolean);
      if (wires.length < 2) { log('Need ≥ 2 sketch wires for loft.', 'error'); return; }
      setProc(true, `Lofting ${wires.length} profiles…`);
      try {
        const solid = OccLoftService.loftProfiles(window.oc, wires);
        const name  = `Loft (${wires.length} profiles)`;
        registerResult(crypto.randomUUID(), name, 'loft', solid, { profileIds: sketchSels });
      } finally {
        setProc(false);
      }
    });
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  const profileName = canRevolve ? (nodes[sketchSels[0]]?.name ?? sketchSels[0].slice(0,8)) : '';

  return (
    <>
      <div style={barStyle}>
        <Sep />
        <Grp label="Advanced" />

        {/* Revolve */}
        <Btn
          icon="↻" label="Revolve"
          accent="#cc4488"
          disabled={!canRevolve}
          title={canRevolve
            ? `Revolve "${profileName}" around an axis`
            : 'Select exactly 1 sketch wire to revolve'}
          onClick={() => setRevolveOpen(true)}
        />

        {/* Sweep */}
        <Btn
          icon="⟿" label="Sweep"
          accent="#44bbcc"
          disabled={!canSweep}
          title={canSweep
            ? `Sweep "${nodes[sketchSels[0]]?.name}" along "${nodes[sketchSels[1]]?.name}"`
            : 'Select exactly 2 sketch wires: 1st = profile, 2nd = spine'}
          onClick={handleSweep}
        />

        {/* Loft */}
        <Btn
          icon="⊿" label="Loft"
          accent="#cc8844"
          disabled={!canLoft}
          title={canLoft
            ? `Loft through ${sketchSels.length} profile(s)`
            : 'Select 2+ sketch wires (ordered) to loft'}
          onClick={handleLoft}
        />

        {/* Selection hint */}
        {sketchSels.length > 0 && (
          <div style={{
            fontSize:'9px', color:'var(--text-muted)',
            padding:'2px 8px', flexShrink:0,
            background:'var(--surface-3)', borderRadius:'var(--radius-sm)',
            border:'1px solid var(--border)',
          }}>
            {sketchSels.length} sketch{sketchSels.length > 1 ? 'es' : ''} selected
          </div>
        )}
      </div>

      {/* Revolve dialog portal */}
      {revolveOpen && (
        <RevolveDialog
          profileName={profileName}
          onConfirm={handleRevolve}
          onCancel={() => setRevolveOpen(false)}
        />
      )}
    </>
  );
};

const barStyle: React.CSSProperties = {
  height:      '36px',
  background:  'var(--surface-2)',
  borderBottom:'1px solid var(--border)',
  display:     'flex',
  alignItems:  'center',
  padding:     '0 8px',
  gap:         '4px',
  flexShrink:  0,
  overflowX:   'auto',
  overflowY:   'hidden',
};
