import React, { useState } from 'react';
import { PropertiesTransformTab }  from './panels/PropertiesTransformTab';
import { CADMaterialPanel }        from './panels/CADMaterialPanel';
import { CADMeasurePanel }         from './panels/CADMeasurePanel';
import { CADSnapPanel }            from './panels/CADSnapPanel';
import { CADShapeAnalysisPanel }   from './panels/CADShapeAnalysisPanel';

type Tab = 'transform' | 'material' | 'analysis' | 'measure' | 'snap';

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: 'transform', icon: '↔',  label: 'Transform' },
  { id: 'material',  icon: '◉',  label: 'Material'  },
  { id: 'analysis',  icon: '⊞',  label: 'Analysis'  },
  { id: 'measure',   icon: '↕',  label: 'Measure'   },
  { id: 'snap',      icon: '⊹',  label: 'Snap'      },
];

export const PropertiesPanel: React.FC = () => {
  const [active, setActive] = useState<Tab>('transform');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface-1)' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        background: 'var(--surface-2)',
      }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            style={{
              flex: 1, padding: '6px 2px',
              border: 'none', cursor: 'pointer',
              background: active === t.id ? 'var(--surface-1)' : 'transparent',
              color: active === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: active === t.id ? `2px solid var(--accent)` : '2px solid transparent',
              borderTop: 'none', borderLeft: 'none', borderRight: 'none',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
              fontSize: '9px',
              transition: 'all 0.12s',
            }}
          >
            <span style={{ fontSize: '13px' }}>{t.icon}</span>
            <span style={{ letterSpacing: '0.2px' }}>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {active === 'transform' && <PropertiesTransformTab />}
        {active === 'material'  && <CADMaterialPanel />}
        {active === 'analysis'  && <CADShapeAnalysisPanel />}
        {active === 'measure'   && <CADMeasurePanel />}
        {active === 'snap'      && <CADSnapPanel />}
      </div>
    </div>
  );
};
