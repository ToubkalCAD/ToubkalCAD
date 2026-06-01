import React from 'react';
import { useCADStore, CADMeasurement } from '../../store/cadStore';

const TYPE_ICONS: Record<CADMeasurement['type'], string> = {
  distance: '↔', angle: '∠', area: '□',
};
const TYPE_UNITS: Record<CADMeasurement['type'], string> = {
  distance: 'mm', angle: '°', area: 'mm²',
};

export const CADMeasurePanel: React.FC = () => {
  const measurements       = useCADStore((s) => s.measurements);
  const removeMeasurement  = useCADStore((s) => s.removeMeasurement);
  const clearMeasurements  = useCADStore((s) => s.clearMeasurements);
  const setInteractionMode = useCADStore((s) => s.setInteractionMode);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface-1)' }}>
      {/* Header */}
      <div style={{
        padding: '7px 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
        background: 'var(--surface-2)',
      }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flex: 1,
                       textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Measurements ({measurements.length})
        </span>
        <button onClick={() => setInteractionMode('MEASURE_DISTANCE')} style={btnStyle}>
          + Distance
        </button>
        {measurements.length > 0 && (
          <button onClick={clearMeasurements} style={{ ...btnStyle, color: 'var(--error)' }}>
            Clear all
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {measurements.length === 0 ? (
          <div style={{ padding: '16px 12px', color: 'var(--text-muted)', fontSize: '11px', fontStyle: 'italic', lineHeight: '1.6' }}>
            No measurements.<br/>
            Click "+ Distance" then click 2 points in the scene.
          </div>
        ) : (
          measurements.map((m) => (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '6px 10px', borderBottom: '1px solid var(--border-soft)',
            }}>
              <span style={{ fontSize: '15px', color: 'var(--accent)', flexShrink: 0 }}>
                {TYPE_ICONS[m.type]}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '11px', color: 'var(--text-primary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.label}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                  ({m.pointA.map((v) => v.toFixed(1)).join(', ')}) →
                  ({m.pointB.map((v) => v.toFixed(1)).join(', ')})
                </div>
              </div>
              <span style={{
                fontSize: '12px', fontWeight: 700,
                color: 'var(--success)', fontFamily: 'monospace', flexShrink: 0,
              }}>
                {m.value.toFixed(2)} {TYPE_UNITS[m.type]}
              </span>
              <button onClick={() => removeMeasurement(m.id)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)',
                               cursor: 'pointer', fontSize: '12px', padding: '0 2px' }}>
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <MeasureHint />
    </div>
  );
};

const MeasureHint: React.FC = () => {
  const mode = useCADStore((s) => s.interactionMode);
  if (mode !== 'MEASURE_DISTANCE') return null;
  return (
    <div style={{
      padding: '8px 12px',
      background: 'var(--accent-dim)',
      borderTop: '1px solid rgba(6,150,215,0.2)',
      fontSize: '11px',
      color: 'var(--accent)',
    }}>
      ✦ Measure mode active — click 2 points in scene (Esc to cancel).
    </div>
  );
};

const btnStyle: React.CSSProperties = {
  fontSize: '10px', padding: '3px 8px', borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-3)', border: '1px solid var(--border)',
  color: 'var(--text-dim)', cursor: 'pointer',
};
