// ============================================================
// ToubkalCAD – PropertiesTransformTab.tsx
// Tweakpane-based transform editor (position, rotation, scale).
// Live gizmo drag updates via cad-object-dragging event.
// ============================================================

import React, { useEffect, useRef } from 'react';
import { Pane } from 'tweakpane';
import { useCADStore } from '../../store/cadStore';
import { isAssemblyComponentData } from '../../assembly/types';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export const PropertiesTransformTab: React.FC = () => {
  const containerRef    = useRef<HTMLDivElement>(null);
  const paneRef         = useRef<Pane | null>(null);
  const selectedIds     = useCADStore((s) => s.selectedIds);
  const nodes           = useCADStore((s) => s.nodes);
  const updateTransform = useCADStore((s) => s.updateTransform);
  const gizmoSpace      = useCADStore((s) => s.gizmoSpace);

  const nodeId = selectedIds[0];
  const node   = nodeId ? nodes[nodeId] : undefined;

  useEffect(() => {
    if (!containerRef.current) return;
    if (paneRef.current) { paneRef.current.dispose(); paneRef.current = null; }

    if (!node) {
      containerRef.current.innerHTML =
        '<div style="padding:14px;color:var(--text-muted);font-size:11px;font-style:italic;">Select an object to edit its transform.</div>';
      return;
    }

    containerRef.current.innerHTML = '';
    // Cast to any: @tweakpane/core peer dep types may not resolve in this setup
    const pane = new Pane({ container: containerRef.current, title: node.name }) as any;
    paneRef.current = pane;
    const assemblyComponent = node.params?.assemblyComponent;
    const isFixed = isAssemblyComponentData(assemblyComponent) && assemblyComponent.fixed;

    // Info
    const fInfo = pane.addFolder({ title: 'Info', expanded: false });
    fInfo.addBinding({ id: node.id.slice(0, 8) + '…', type: node.type }, 'id',   { disabled: true, label: 'ID' });
    fInfo.addBinding({ id: node.id.slice(0, 8) + '…', type: node.type }, 'type', { disabled: true, label: 'Type' });
    if (node.type === 'assembly_component') {
      const transformMode = { space: gizmoSpace };
      fInfo.addBinding(transformMode, 'space', {
        label: 'Axes',
        options: { Local: 'local', World: 'world' },
      }).on('change', (event: any) => useCADStore.getState().setGizmoSpace(event.value));
    }

    // Position
    const pos = { x: node.transform.position[0], y: node.transform.position[1], z: node.transform.position[2] };
    const fPos = pane.addFolder({ title: 'Position (mm)', expanded: true, disabled: isFixed });
    const applyAll = () => {
      const p: [number, number, number] = [pos.x, pos.y, pos.z];
      const r: [number, number, number] = [rot.rx * RAD, rot.ry * RAD, rot.rz * RAD];
      const s: [number, number, number] = [sc.sx, sc.sy, sc.sz];
      updateTransform(node.id, p, r, s);
      window.dispatchEvent(new CustomEvent('cad-apply-transform', {
        detail: { id: node.id, position: p, rotation: r },
      }));
    };

    // Give X/Y/Z a min/max so Tweakpane renders real sliders (track + handle),
    // matching the Rotation sliders below. Range is centered on each axis's
    // current value with generous ±travel so the handle sits mid-track wherever
    // the object is; exact larger moves can still be made by dragging the gizmo.
    const posRange = (v: number) => ({ min: v - 500, max: v + 500, step: 0.1 });
    fPos.addBinding(pos, 'x', { label: 'X', ...posRange(pos.x) }).on('change', applyAll);
    fPos.addBinding(pos, 'y', { label: 'Y', ...posRange(pos.y) }).on('change', applyAll);
    fPos.addBinding(pos, 'z', { label: 'Z', ...posRange(pos.z) }).on('change', applyAll);

    // Rotation
    const rot = {
      rx: node.transform.rotation[0] * DEG,
      ry: node.transform.rotation[1] * DEG,
      rz: node.transform.rotation[2] * DEG,
    };
    const fRot = pane.addFolder({ title: 'Rotation (°)', expanded: true, disabled: isFixed });
    fRot.addBinding(rot, 'rx', { label: 'Rx', min: -180, max: 180, step: 0.5 }).on('change', applyAll);
    fRot.addBinding(rot, 'ry', { label: 'Ry', min: -180, max: 180, step: 0.5 }).on('change', applyAll);
    fRot.addBinding(rot, 'rz', { label: 'Rz', min: -180, max: 180, step: 0.5 }).on('change', applyAll);

    // Scale
    const sc = { sx: node.transform.scale[0], sy: node.transform.scale[1], sz: node.transform.scale[2] };
    const fSc = pane.addFolder({ title: 'Scale', expanded: false, disabled: isFixed });
    fSc.addBinding(sc, 'sx', { label: 'X', min: 0.001, max: 100, step: 0.01 }).on('change', applyAll);
    fSc.addBinding(sc, 'sy', { label: 'Y', min: 0.001, max: 100, step: 0.01 }).on('change', applyAll);
    fSc.addBinding(sc, 'sz', { label: 'Z', min: 0.001, max: 100, step: 0.01 }).on('change', applyAll);

    // Reset
    (pane.addButton({ title: 'Reset Transform' }) as any).on('click', () => {
      if (isFixed) {
        useCADStore.getState().log(`"${node.name}" is fixed. Float it before resetting its transform.`, 'warn');
        return;
      }
      pos.x = pos.y = pos.z = 0;
      rot.rx = rot.ry = rot.rz = 0;
      sc.sx = sc.sy = sc.sz = 1;
      pane.refresh();
      applyAll();
    });

    // Live update from gizmo drag
    const onDrag = (e: Event) => {
      const { id, position } = (e as CustomEvent).detail;
      if (id !== node.id) return;
      pos.x = position[0]; pos.y = position[1]; pos.z = position[2];
      pane.refresh();
    };
    window.addEventListener('cad-object-dragging', onDrag);

    return () => {
      window.removeEventListener('cad-object-dragging', onDrag);
      if (paneRef.current) { paneRef.current.dispose(); paneRef.current = null; }
    };
  }, [nodeId, updateTransform, gizmoSpace]);

  return (
    <div style={{ width: '100%', height: '100%', background: 'var(--surface-1)', overflowY: 'auto' }}>
      <div ref={containerRef} />
    </div>
  );
};
