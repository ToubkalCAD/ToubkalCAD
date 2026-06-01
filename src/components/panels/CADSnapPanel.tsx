import React from 'react';
import { useCADStore } from '../../store/cadStore';

const SNAP_PRESETS  = [0.1, 0.5, 1, 2, 5, 10, 25, 50];
const ANGLE_PRESETS = [5, 10, 15, 22.5, 30, 45, 90];

export const CADSnapPanel: React.FC = () => {
  const snapEnabled = useCADStore((s) => s.snapEnabled);
  const snapStep    = useCADStore((s) => s.snapStep);
  const setSnap     = useCADStore((s) => s.setSnapEnabled);
  const setStep     = useCADStore((s) => s.setSnapStep);

  return (
    <div style={{ padding: '10px', color: 'var(--text-primary)', fontSize: '12px' }}>

      <Section title="Grid Snap">
        <ToggleRow label="Enable snap" value={snapEnabled} onChange={setSnap}/>
        {snapEnabled && (
          <>
            <Row label="Linear step">
              <span style={{ color: 'var(--accent)', fontFamily: 'monospace', fontSize: '11px' }}>
                {snapStep} mm
              </span>
            </Row>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
              {SNAP_PRESETS.map((v) => (
                <PresetBtn key={v} label={`${v}`} active={snapStep === v} onClick={() => setStep(v)}/>
              ))}
            </div>
            <div style={{ marginTop: '8px' }}>
              <label style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Custom value (mm)</label>
              <input
                type="number" min={0.001} step={0.1} value={snapStep}
                onChange={(e) => setStep(Math.max(0.001, Number(e.target.value)))}
                style={inputStyle}
              />
            </div>
          </>
        )}
      </Section>

      <Section title="Angular Snap">
        <Row label="Angular step">
          <span style={{ color: 'var(--accent)', fontFamily: 'monospace', fontSize: '11px' }}>15°</span>
        </Row>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
          {ANGLE_PRESETS.map((v) => (
            <PresetBtn key={v} label={`${v}°`} active={false} onClick={() => {}}/>
          ))}
        </div>
      </Section>

      <Section title="Snap Points">
        {[
          ['Vertices',        true ],
          ['Edge midpoints',  true ],
          ['Face centers',    true ],
          ['Intersections',   false],
          ['Quadrant points', false],
          ['Perpendicular',   false],
        ].map(([label, active]) => (
          <ToggleRow key={label as string} label={label as string} value={active as boolean} onChange={() => {}}/>
        ))}
      </Section>

      <Section title="Grid Display">
        {[
          ['Main grid',   true],
          ['Sub grid',    true],
          ['X axis',      true],
          ['Y axis',      true],
          ['Z axis',      true],
        ].map(([label, active]) => (
          <ToggleRow key={label as string} label={label as string} value={active as boolean} onChange={() => {}}/>
        ))}
      </Section>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginBottom: '16px' }}>
    <div style={{
      fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase',
      letterSpacing: '0.8px', marginBottom: '8px', paddingBottom: '4px',
      borderBottom: '1px solid var(--border)',
    }}>
      {title}
    </div>
    {children}
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
    <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>{label}</span>
    {children}
  </div>
);

const ToggleRow: React.FC<{ label: string; value: boolean; onChange: (v: boolean) => void }> = ({ label, value, onChange }) => (
  <Row label={label}>
    <button
      onClick={() => onChange(!value)}
      style={{
        fontSize: '10px', padding: '2px 10px', borderRadius: '10px', cursor: 'pointer',
        background: value ? 'rgba(26,127,55,0.1)' : 'var(--surface-3)',
        color:      value ? 'var(--success)'       : 'var(--text-muted)',
        border:     value ? '1px solid rgba(26,127,55,0.3)' : '1px solid var(--border)',
        transition: 'all 0.15s',
      }}
    >
      {value ? 'ON' : 'OFF'}
    </button>
  </Row>
);

const PresetBtn: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button
    onClick={onClick}
    style={{
      fontSize: '10px', padding: '2px 7px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
      background: active ? 'var(--accent-dim)' : 'var(--surface-3)',
      color:      active ? 'var(--accent)'     : 'var(--text-dim)',
      border:     active ? '1px solid rgba(6,150,215,0.4)' : '1px solid var(--border)',
    }}
  >
    {label}
  </button>
);

const inputStyle: React.CSSProperties = {
  width: '100%', marginTop: '4px', padding: '4px 8px',
  background: 'var(--surface-1)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', borderRadius: 'var(--radius-sm)', fontSize: '11px',
};
