// ============================================================
// ToubkalCAD – CADLayout.tsx
// Dockview layout + MenuBar + ViewCube + StatusBar.
// Key: handleViewportReady is wrapped in useCallback so the
// Viewport3D Three.js effect has a stable dep and never re-runs.
// ============================================================

import '../types/index';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { DockviewReact, DockviewReadyEvent, IDockviewPanelProps } from 'dockview';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { Viewport3D }           from './Viewport3D';
import { CADHierarchyTree }     from './CADHierarchyTree';
import { PropertiesPanel }      from './PropertiesPanel';
import { CADStatusBar }         from './CADStatusBar';
import { CADToolbar }           from './CADToolbar';
import { CADViewCube }          from './CADViewCube';
import { MenuBar }              from './MenuBar';
import { ErrorBoundary }        from './ErrorBoundary';
import { PlaneSelector }        from './PlaneSelector';
import { TreeContextMenu }     from './TreeContextMenu';
import { Op3DPanel, show3DOpPanel } from './Op3DPanel';
import type { Op3DRequest, Op3DType } from './Op3DPanel';
import { BlendActionPanel }    from './BlendActionPanel';
import { BooleanActionPanel }  from './BooleanActionPanel';
import { AdvancedToolbar }      from './AdvancedToolbar';
import { CADConsolePanel }      from './panels/CADConsolePanel';
import { CADProjectPanel }      from './panels/CADProjectPanel';
import { CADCameraService, CADViewPreset } from '../services/CADCameraService';
import { useCADStore } from '../store/cadStore';
import 'dockview/dist/styles/dockview.css';

// ─── Numpad camera shortcuts ──────────────────────────────────────────────────
function useNumpadCamera(
  camRef: React.MutableRefObject<THREE.PerspectiveCamera | null>,
  ctlRef: React.MutableRefObject<OrbitControls | null>,
) {
  useEffect(() => {
    const MAP: Record<string, CADViewPreset> = {
      Numpad0: 'PERSPECTIVE', Numpad7: 'TOP',
      Numpad1: 'FRONT',       Numpad3: 'RIGHT',
      Numpad5: 'ISOMETRIC',
    };
    const fn = (e: KeyboardEvent) => {
      const preset = MAP[e.code];
      if (preset && camRef.current && ctlRef.current)
        CADCameraService.applyViewPreset(preset, camRef.current, ctlRef.current);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [camRef, ctlRef]);
}

// ─── View-preset event bus (fired from MenuBar / numpad) ──────────────────────
function useViewPresetBus(
  camRef: React.MutableRefObject<THREE.PerspectiveCamera | null>,
  ctlRef: React.MutableRefObject<OrbitControls | null>,
) {
  useEffect(() => {
    const fn = (e: Event) => {
      const preset = (e as CustomEvent).detail as CADViewPreset;
      if (camRef.current && ctlRef.current)
        CADCameraService.applyViewPreset(preset, camRef.current, ctlRef.current);
    };
    window.addEventListener('cad-view-preset', fn);
    return () => window.removeEventListener('cad-view-preset', fn);
  }, [camRef, ctlRef]);
}

// ─── Floating view buttons ────────────────────────────────────────────────────
const VIEW_PRESETS: Array<{ preset: CADViewPreset; label: string }> = [
  { preset: 'PERSPECTIVE', label: 'Persp' },
  { preset: 'TOP',         label: 'Top'   },
  { preset: 'FRONT',       label: 'Front' },
  { preset: 'RIGHT',       label: 'Right' },
  { preset: 'ISOMETRIC',   label: 'Iso'   },
];

const ViewPresetBar: React.FC<{ onPreset: (p: CADViewPreset) => void }> = ({ onPreset }) => (
  <div style={{
    position: 'absolute', top: '8px', right: '8px', zIndex: 10,
    display: 'flex', flexDirection: 'column', gap: '3px', pointerEvents: 'auto',
  }}>
    {VIEW_PRESETS.map(({ preset, label }) => (
      <button
        key={preset}
        onClick={() => onPreset(preset)}
        style={{
          background: 'rgba(25,28,30,0.88)',
          color: 'var(--text-dim)',
          border: '1px solid var(--border)',
          padding: '3px 10px',
          borderRadius: 'var(--radius-sm)',
          fontSize: '10px',
          cursor: 'pointer',
          backdropFilter: 'blur(6px)',
          letterSpacing: '0.2px',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
          (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)';
          (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
        }}
      >
        {label}
      </button>
    ))}
  </div>
);

// ─── Hotkey legend ────────────────────────────────────────────────────────────
const HOTKEYS = [
  ['W', 'Translate'], ['E', 'Rotate'],     ['R', 'Scale'],
  ['F', 'Frame sel.'],['H', 'Hide'],
  ['Ctrl+D', 'Duplicate'], ['Ctrl+Z', 'Undo'], ['Del', 'Delete'], ['Esc', 'Deselect'],
];

const HotkeyLegend = () => (
  <div style={{
    position: 'absolute', bottom: '8px', left: '8px', zIndex: 10,
    background: 'rgba(10,12,14,0.82)',
    borderRadius: 'var(--radius-md)',
    padding: '6px 10px',
    fontSize: '9px', color: 'var(--text-muted)', lineHeight: '1.75',
    backdropFilter: 'blur(4px)', pointerEvents: 'none',
    border: '1px solid rgba(255,255,255,0.04)',
  }}>
    {HOTKEYS.map(([k, v]) => (
      <div key={k}>
        <span style={{ color: 'var(--accent)', display: 'inline-block', width: '58px' }}>{k}</span>
        {v}
      </div>
    ))}
  </div>
);

// ─── Main layout ──────────────────────────────────────────────────────────────
export const CADLayout: React.FC = () => {
  const resizeFnRef = useRef<(() => void) | null>(null);
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitRef    = useRef<OrbitControls | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);
  const [viewReady, setViewReady] = useState(false);

  // ── Op3D panel state — driven by Zustand so show3DOpPanel() always works ────
  const op3DReq    = useCADStore((s) => s.op3DPanelReq);
  const closeOp3D  = useCADStore((s) => s.closeOp3DPanel);

  useNumpadCamera(cameraRef, orbitRef);
  useViewPresetBus(cameraRef, orbitRef);

  // Viewport double-click → re-edit the selected 3D op node.
  // Registered on window so Viewport3D.tsx is not modified.
  useEffect(() => {
    const REEDITABLE_TYPES = new Set(['extrusion', 'revolve', 'loft', 'sweep', 'compound']);
    const onDblClick = () => {
      const state   = useCADStore.getState();
      const sel     = state.selectedIds;
      if (!sel.length) return;
      const node    = state.nodes[sel[0]];
      if (!node) return;
      // Blend result (fillet/chamfer) → re-open BlendActionPanel
      const blendOp  = node.params?.blendOp as 'fillet' | 'chamfer' | undefined;
      const sourceId = node.params?.sourceId as string | undefined;
      if (blendOp && sourceId) {
        const edges = (node.params?.edgeIndices as number[] | undefined) ?? [];
        state.openBlendPanel(sourceId, blendOp, sel[0], edges);
        return;
      }
      // Boolean result → re-open BooleanActionPanel
      const boolOp = node.params?.boolOp as import('../store/cadStore').BooleanOp | undefined;
      if (boolOp && node.params?.baseId) {
        state.openBooleanPanel(boolOp, sel[0], node.params.baseId as string, (node.params?.toolIds as string[]) ?? []);
        return;
      }
      // 3D op (extrude/revolve/loft/sweep) → re-open Op3DPanel
      const opType  = node.params?.opType as Op3DType | undefined;
      const wireIds = node.params?.targetWireIds as string[] | undefined;
      if (opType && wireIds?.length && REEDITABLE_TYPES.has(node.type)) {
        show3DOpPanel(opType, wireIds, sel[0]);
      }
    };
    window.addEventListener('dblclick', onDblClick);
    return () => window.removeEventListener('dblclick', onDblClick);
  }, []);

  // STABLE callback — must be wrapped in useCallback to avoid Viewport3D re-init
  const handleViewportReady = useCallback((
    resizeFn: () => void,
    scene:    THREE.Scene,
    camera:   THREE.PerspectiveCamera,
    orbit:    OrbitControls,
  ) => {
    resizeFnRef.current = resizeFn;
    sceneRef.current    = scene;
    cameraRef.current   = camera;
    orbitRef.current    = orbit;
    setViewReady(true);
  }, []); // no deps — intentionally stable for the lifetime of CADLayout

  const handlePreset = useCallback((p: CADViewPreset) => {
    if (cameraRef.current && orbitRef.current)
      CADCameraService.applyViewPreset(p, cameraRef.current, orbitRef.current);
  }, []);

  // ─── Dockview panels ───────────────────────────────────────────────────────
  const onReady = useCallback((event: DockviewReadyEvent) => {
    event.api.addPanel({ id: 'viewport',   component: 'viewport3D',    title: '3D View' });
    event.api.addPanel({ id: 'hierarchy',  component: 'hierarchyView', title: 'Model Tree',
      position: { referencePanel: 'viewport', direction: 'left' },  initialWidth: 240 });
    event.api.addPanel({ id: 'properties', component: 'propertiesView',title: 'Properties',
      position: { referencePanel: 'viewport', direction: 'right' }, initialWidth: 270 });
    event.api.addPanel({ id: 'console',    component: 'consoleView',   title: 'Console',
      position: { referencePanel: 'viewport', direction: 'below' }, initialHeight: 130 });
    event.api.addPanel({ id: 'projects',   component: 'projectsView',  title: 'Projects',
      position: { referencePanel: 'console',  direction: 'right' },  initialWidth: 260 });
    event.api.onDidLayoutChange(() => resizeFnRef.current?.());
  }, []);

  const components = {
    viewport3D: (_: IDockviewPanelProps) => (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <ErrorBoundary label="Viewport">
          <Viewport3D onReady={handleViewportReady} />
        </ErrorBoundary>
        <ViewPresetBar onPreset={handlePreset} />
        <HotkeyLegend />
        {viewReady && (
          <CADViewCube mainCamera={cameraRef.current} mainControls={orbitRef.current} />
        )}
      </div>
    ),
    hierarchyView:  () => <ErrorBoundary label="Model Tree"><CADHierarchyTree /></ErrorBoundary>,
    propertiesView: () => <ErrorBoundary label="Properties"><PropertiesPanel /></ErrorBoundary>,
    consoleView:    () => <ErrorBoundary label="Console"><CADConsolePanel /></ErrorBoundary>,
    projectsView:   () => <ErrorBoundary label="Projects"><CADProjectPanel /></ErrorBoundary>,
  };

  return (
    <div style={{
      height: '100vh', width: '100vw',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg)',
    }}>
      {/* App header: logo + menu bar + toolbar */}
      <div style={{
        display: 'flex', flexDirection: 'column', flexShrink: 0,
        borderBottom: '1px solid var(--border)',
      }}>
        {/* Title / menu row */}
        <div style={{
          height: '28px',
          background: 'var(--surface-1)',
          display: 'flex', alignItems: 'stretch',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          {/* Logo */}
          <div style={{
            display: 'flex', alignItems: 'center',
            padding: '0 14px',
            borderRight: '1px solid var(--border-soft)',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent)', letterSpacing: '1.5px' }}>
              TOUBKAL<span style={{ color: 'var(--text-primary)', fontWeight: 400 }}>CAD</span>
            </span>
          </div>
          <MenuBar />
        </div>

        {/* Primary toolbar */}
        <CADToolbar />
        {/* Advanced operations: Revolve · Sweep · Loft */}
        <AdvancedToolbar />
      </div>

      {/* Dockview workspace */}
      <div style={{ flexGrow: 1, position: 'relative', overflow: 'hidden' }}>
        <DockviewReact
          components={components}
          onReady={onReady}
          className="dockview-theme-light"
        />
      </div>

      <CADStatusBar />
      {/* Floating overlays rendered at root level to appear above Dockview */}
      <PlaneSelector />
      <TreeContextMenu />
      {op3DReq && (
        <Op3DPanel
          req={op3DReq as Op3DRequest}
          onClose={closeOp3D}
        />
      )}
      <BlendActionPanel />
      <BooleanActionPanel />
    </div>
  );
};
