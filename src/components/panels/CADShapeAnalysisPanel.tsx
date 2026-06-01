import React, { useEffect, useState } from 'react';
import { useCADStore } from '../../store/cadStore';
import { OccMeasureService, ShapeProperties } from '../../services/OccMeasureService';
import { CADGeometryRegistry } from '../../services/CADGeometryRegistry';

interface BBox {
  sizeX: number; sizeY: number; sizeZ: number;
  xMin: number; yMin: number; zMin: number;
  xMax: number; yMax: number; zMax: number;
}

export const CADShapeAnalysisPanel: React.FC = () => {
  const selectedIds = useCADStore((s) => s.selectedIds);
  const nodes       = useCADStore((s) => s.nodes);
  const [props,   setProps]   = useState<ShapeProperties | null>(null);
  const [bbox,    setBbox]    = useState<BBox | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [density, setDensity] = useState(0.00785);

  const activeId   = selectedIds[0];
  const activeNode = activeId ? nodes[activeId] : undefined;

  useEffect(() => {
    if (!activeId || !activeNode) { setProps(null); setBbox(null); return; }
    const oc    = (window as any).oc;
    const shape = CADGeometryRegistry.getInstance().getShape(activeId);
    if (!oc || !shape) { setError('Shape or kernel not available.'); return; }

    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      try {
        setProps(OccMeasureService.getShapeProperties(oc, shape, density));
        setBbox(OccMeasureService.getBoundingBox(oc, shape));
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }, 50);
    return () => clearTimeout(t);
  }, [activeId, density]);

  if (!activeNode) return (
    <div style={{ padding: '14px', color: 'var(--text-muted)', fontSize: '11px', fontStyle: 'italic' }}>
      Select an object to analyse its geometry.
    </div>
  );

  const MATERIALS = [
    { name: 'Steel',    d: 0.00785 },
    { name: 'Alum.',    d: 0.0027  },
    { name: 'Copper',   d: 0.00896 },
    { name: 'PLA',      d: 0.00124 },
    { name: 'Concrete', d: 0.0024  },
    { name: 'Titanium', d: 0.00442 },
  ];

  return (
    <div style={{ padding: '10px', fontSize: '12px', color: 'var(--text-primary)' }}>
      <Section title={`Analysis: ${activeNode.name}`}>
        {loading && <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>⏳ Computing…</div>}
        {error   && <div style={{ color: 'var(--error)' }}>⚠ {error}</div>}
      </Section>

      {props && !loading && (
        <>
          <Section title="Volume properties">
            <StatRow label="Volume"    value={`${props.volume.toFixed(2)} mm³`}/>
            <StatRow label="Surface"   value={`${props.surfaceArea.toFixed(2)} mm²`}/>
            <StatRow label="CoG X"     value={`${props.centerOfGravity[0].toFixed(3)} mm`}/>
            <StatRow label="CoG Y"     value={`${props.centerOfGravity[1].toFixed(3)} mm`}/>
            <StatRow label="CoG Z"     value={`${props.centerOfGravity[2].toFixed(3)} mm`}/>
          </Section>

          <Section title="Estimated mass">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <label style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>
                Density (g/mm³)
              </label>
              <input
                type="number" step={0.0001} value={density}
                onChange={(e) => setDensity(Number(e.target.value))}
                style={{
                  flex: 1, background: 'var(--surface-1)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', borderRadius: 'var(--radius-sm)',
                  padding: '2px 6px', fontSize: '11px',
                }}
              />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginBottom: '6px' }}>
              {MATERIALS.map((m) => (
                <button
                  key={m.name}
                  onClick={() => setDensity(m.d)}
                  style={{
                    fontSize: '9px', padding: '2px 6px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    background: Math.abs(density - m.d) < 0.00001 ? 'var(--accent-dim)' : 'var(--surface-3)',
                    color:      Math.abs(density - m.d) < 0.00001 ? 'var(--accent)'     : 'var(--text-dim)',
                    border:     Math.abs(density - m.d) < 0.00001 ? '1px solid rgba(6,150,215,0.4)' : '1px solid var(--border)',
                  }}
                >
                  {m.name}
                </button>
              ))}
            </div>
            <StatRow label="Mass"  value={`${(props.volume * density).toFixed(2)} g`} highlight/>
            <StatRow label=""      value={`${((props.volume * density) / 1000).toFixed(4)} kg`}/>
          </Section>
        </>
      )}

      {bbox && !loading && (
        <Section title="Bounding box">
          <StatRow label="Width (X)"  value={`${bbox.sizeX.toFixed(3)} mm`}/>
          <StatRow label="Height (Y)" value={`${bbox.sizeY.toFixed(3)} mm`}/>
          <StatRow label="Depth (Z)"  value={`${bbox.sizeZ.toFixed(3)} mm`}/>
          <div style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: '4px', fontFamily: 'monospace' }}>
            [{bbox.xMin.toFixed(1)}, {bbox.yMin.toFixed(1)}, {bbox.zMin.toFixed(1)}] →
            [{bbox.xMax.toFixed(1)}, {bbox.yMax.toFixed(1)}, {bbox.zMax.toFixed(1)}]
          </div>
        </Section>
      )}
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginBottom: '12px' }}>
    <div style={{
      fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase',
      letterSpacing: '0.8px', marginBottom: '6px', paddingBottom: '4px',
      borderBottom: '1px solid var(--border)',
    }}>
      {title}
    </div>
    {children}
  </div>
);

const StatRow: React.FC<{ label: string; value: string; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between',
    padding: '2px 0', borderBottom: '1px solid var(--border-soft)',
  }}>
    <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{label}</span>
    <span style={{
      color: highlight ? 'var(--success)' : 'var(--text-primary)',
      fontFamily: 'monospace', fontSize: '11px',
      fontWeight: highlight ? 700 : 'normal',
    }}>
      {value}
    </span>
  </div>
);
