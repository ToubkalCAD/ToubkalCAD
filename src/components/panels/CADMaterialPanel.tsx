// ============================================================
// ToubkalCAD – CADMaterialPanel.tsx
// Per-object material editor via Tweakpane.
//
// Color is stored as a number (0xRRGGBB) in the store and
// displayed as a '#rrggbb' hex string in Tweakpane.
// Using hex strings avoids the float/int colour-type ambiguity
// that caused NaN in all bindings with Tweakpane v4.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { Pane } from 'tweakpane';
import { useCADStore, CADMaterial } from '../../store/cadStore';

// Number ↔ '#rrggbb' string conversion
function numToHexStr(n: number): string {
  return '#' + (n >>> 0).toString(16).padStart(6, '0');
}
function hexStrToNum(s: string): number {
  return parseInt(s.replace('#', ''), 16) || 0;
}

const PRESETS: Array<{ label: string; color: number; roughness: number; metalness: number }> = [
  { label: 'Steel',    color: 0x8899aa, roughness: 0.3,  metalness: 0.9 },
  { label: 'Plastic',  color: 0xdd4444, roughness: 0.8,  metalness: 0.0 },
  { label: 'Gold',     color: 0xddaa22, roughness: 0.2,  metalness: 1.0 },
  { label: 'Concrete', color: 0x888880, roughness: 0.95, metalness: 0.0 },
  { label: 'Glass',    color: 0x99ccff, roughness: 0.05, metalness: 0.1 },
];

export const CADMaterialPanel: React.FC = () => {
  const containerRef   = useRef<HTMLDivElement>(null);
  const paneRef        = useRef<Pane | null>(null);
  const selectedIds    = useCADStore((s) => s.selectedIds);
  const nodes          = useCADStore((s) => s.nodes);
  const updateMaterial = useCADStore((s) => s.updateMaterial);

  const activeNode = selectedIds[0] ? nodes[selectedIds[0]] : undefined;

  useEffect(() => {
    if (!containerRef.current) return;
    if (paneRef.current) { paneRef.current.dispose(); paneRef.current = null; }

    if (!activeNode) {
      containerRef.current.innerHTML =
        '<div style="padding:12px;color:var(--text-muted);font-size:11px;font-style:italic;">Select an object.</div>';
      return;
    }

    containerRef.current.innerHTML = '';
    // Pane cast to any: @tweakpane/core peer types not installed
    const pane = new Pane({ container: containerRef.current, title: 'Material' }) as any;
    paneRef.current = pane as Pane;

    const mat = activeNode.material;

    // Use a hex string for colour — avoids Tweakpane float/int range ambiguity
    const params = {
      colorHex:    numToHexStr(mat.color),
      roughness:   mat.roughness,
      metalness:   mat.metalness,
      opacity:     mat.opacity,
      transparent: mat.transparent,
      wireframe:   mat.wireframe,
    };

    const apply = () => {
      const updated: Partial<CADMaterial> = {
        color:       hexStrToNum(params.colorHex),
        roughness:   params.roughness,
        metalness:   params.metalness,
        opacity:     params.opacity,
        transparent: params.transparent,
        wireframe:   params.wireframe,
      };
      updateMaterial(activeNode.id, updated);
      window.dispatchEvent(new CustomEvent('cad-material-changed', {
        detail: { id: activeNode.id, material: updated },
      }));
    };

    // Tweakpane auto-detects '#rrggbb' string as a colour picker — no type option needed
    pane.addBinding(params, 'colorHex',   { label: 'Color'       }).on('change', apply);
    pane.addBinding(params, 'roughness',  { label: 'Roughness',   min: 0, max: 1, step: 0.01 }).on('change', apply);
    pane.addBinding(params, 'metalness',  { label: 'Metalness',   min: 0, max: 1, step: 0.01 }).on('change', apply);
    pane.addBinding(params, 'opacity',    { label: 'Opacity',     min: 0, max: 1, step: 0.01 }).on('change', apply);
    pane.addBinding(params, 'transparent',{ label: 'Transparent' }).on('change', apply);
    pane.addBinding(params, 'wireframe',  { label: 'Wireframe'   }).on('change', apply);

    // Quick presets
    const fPre = pane.addFolder({ title: 'Presets', expanded: false });
    PRESETS.forEach((p) => {
      (fPre.addButton({ title: p.label }) as any).on('click', () => {
        const upd = { color: p.color, roughness: p.roughness, metalness: p.metalness };
        updateMaterial(activeNode.id, upd);
        window.dispatchEvent(new CustomEvent('cad-material-changed', {
          detail: { id: activeNode.id, material: upd },
        }));
      });
    });

    return () => {
      if (paneRef.current) { paneRef.current.dispose(); paneRef.current = null; }
    };
  }, [selectedIds[0], activeNode?.material, updateMaterial]);

  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--surface-1)', overflowY: 'auto' }}>
      <div ref={containerRef} />
    </div>
  );
};
