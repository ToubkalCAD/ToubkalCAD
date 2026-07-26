import React, { useEffect, useState } from 'react';
import { PropertiesTransformTab } from './panels/PropertiesTransformTab';
import { CADMaterialPanel } from './panels/CADMaterialPanel';
import { CADMeasurePanel } from './panels/CADMeasurePanel';
import { CADSnapPanel } from './panels/CADSnapPanel';
import { CADShapeAnalysisPanel } from './panels/CADShapeAnalysisPanel';
import { AssemblyPropertiesPanel } from './panels/AssemblyPropertiesPanel';
import { AssemblyReferencePanel } from './panels/AssemblyReferencePanel';
import { AssemblyConstraintPanel } from './panels/AssemblyConstraintPanel';

type Tab = 'transform' | 'assembly' | 'references' | 'constraints' | 'material' | 'analysis' | 'measure' | 'snap';

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: 'transform', icon: '\u2194', label: 'Transform' },
  { id: 'assembly', icon: '\u25c6', label: 'Assembly' },
  { id: 'references', icon: '\u2316', label: 'References' },
  { id: 'constraints', icon: '\u2301', label: 'Constraints' },
  { id: 'material', icon: '\u25c9', label: 'Material' },
  { id: 'analysis', icon: '\u229e', label: 'Analysis' },
  { id: 'measure', icon: '\u2195', label: 'Measure' },
  { id: 'snap', icon: '\u22b9', label: 'Snap' },
];

export const PropertiesPanel: React.FC = () => {
  const [active, setActive] = useState<Tab>('transform');

  useEffect(() => {
    const openTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: Tab }>).detail?.tab;
      if (tab && TABS.some((entry) => entry.id === tab)) setActive(tab);
    };
    window.addEventListener('cad-properties-tab', openTab);
    return () => window.removeEventListener('cad-properties-tab', openTab);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface-1)' }}>
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        background: 'var(--surface-2)',
      }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            style={{
              flex: 1,
              padding: '6px 2px',
              border: 'none',
              cursor: 'pointer',
              background: active === tab.id ? 'var(--surface-1)' : 'transparent',
              color: active === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: active === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              fontSize: 9,
              transition: 'all 0.12s',
            }}
          >
            <span style={{ fontSize: 13 }}>{tab.icon}</span>
            <span style={{ letterSpacing: '0.2px' }}>{tab.label}</span>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {active === 'transform' && <PropertiesTransformTab />}
        {active === 'assembly' && <AssemblyPropertiesPanel />}
        {active === 'references' && <AssemblyReferencePanel />}
        {active === 'constraints' && <AssemblyConstraintPanel />}
        {active === 'material' && <CADMaterialPanel />}
        {active === 'analysis' && <CADShapeAnalysisPanel />}
        {active === 'measure' && <CADMeasurePanel />}
        {active === 'snap' && <CADSnapPanel />}
      </div>
    </div>
  );
};
