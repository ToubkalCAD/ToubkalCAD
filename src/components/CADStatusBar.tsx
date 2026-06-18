// ============================================================
// ToubkalCAD – CADStatusBar.tsx
// Phase 9 – breadcrumbs + mode + snap + coords + stats.
// ============================================================

import '../types/index';
import React, { useEffect, useState, useRef } from 'react';
import { useCADStore } from '../store/cadStore';
import type { InteractionMode } from '../store/cadStore';
import { reportFps } from '../utils/renderQuality';
import { Icon, IconName } from './Icon';

const MODE_ICON: Partial<Record<InteractionMode, IconName>> = {
  SELECT: 'select', MEASURE_DISTANCE: 'measure', CONSTRAIN: 'constraint',
  BLEND_EDGE: 'fillet', BOOLEAN_PICK: 'union',
  SKETCH_LINE: 'line', SKETCH_CIRCLE: 'circle', SKETCH_RECTANGLE: 'rectangle',
  SKETCH_ARC: 'arc', SKETCH_ARC_3P: 'arc3p', SKETCH_ELLIPSE: 'ellipse',
  SKETCH_BEZIER: 'bezier', SKETCH_SPLINE: 'spline', SKETCH_POLYGON: 'polygon',
  SKETCH_ROUNDED_RECT: 'roundrect',
};
const MODE_LABEL: Partial<Record<InteractionMode, string>> = {
  SELECT: 'Select', MEASURE_DISTANCE: 'Measure', CONSTRAIN: 'Constrain',
  BLEND_EDGE: 'Edge blend', BOOLEAN_PICK: 'Boolean pick',
  SKETCH_LINE: 'Line', SKETCH_CIRCLE: 'Circle', SKETCH_RECTANGLE: 'Rectangle',
  SKETCH_ARC: 'Arc', SKETCH_ARC_3P: 'Arc 3-pt', SKETCH_ELLIPSE: 'Ellipse',
  SKETCH_BEZIER: 'Bézier', SKETCH_SPLINE: 'Spline', SKETCH_POLYGON: 'Polygon',
  SKETCH_ROUNDED_RECT: 'Rounded rect',
};
const GIZMO_LABEL: Record<string, string> = {
  translate: 'Move', rotate: 'Rotate', scale: 'Scale',
};

export const CADStatusBar: React.FC = () => {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const gizmoMode       = useCADStore((s) => s.gizmoMode);
  const selectedIds     = useCADStore((s) => s.selectedIds);
  const nodes           = useCADStore((s) => s.nodes);
  const sketchSession   = useCADStore((s) => s.sketchSession);
  const snapEnabled     = useCADStore((s) => s.snapEnabled);
  const snapStep        = useCADStore((s) => s.snapStep);
  const setSnapEnabled  = useCADStore((s) => s.setSnapEnabled);
  const setSnapStep     = useCADStore((s) => s.setSnapStep);
  const past            = useCADStore((s) => s.past);
  const future          = useCADStore((s) => s.future);
  const isProcessing    = useCADStore((s) => s.isProcessing);
  const processingLabel = useCADStore((s) => s.processingLabel);

  const [mousePos, setMousePos] = useState({ x: 0, y: 0, z: 0 });
  const [fps, setFps]           = useState(60);
  const fpsRef = useRef({ frames: 0, last: performance.now() });

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      fpsRef.current.frames++;
      const now = performance.now();
      if (now - fpsRef.current.last >= 1000) {
        setFps(fpsRef.current.frames);
        reportFps(fpsRef.current.frames);   // adaptive-quality safety net (renderQuality)
        fpsRef.current.frames = 0; fpsRef.current.last = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  useEffect(() => {
    const fn = (e: Event) => {
      const { x, y, z } = (e as CustomEvent).detail;
      setMousePos({ x, y, z });
    };
    window.addEventListener('cad-mouse-world-pos', fn);
    return () => window.removeEventListener('cad-mouse-world-pos', fn);
  }, []);

  // ── Breadcrumb path: Model › …ancestors… › node ──────────────────────────────
  const crumbs: string[] = ['Model'];
  if (selectedIds.length === 1 && nodes[selectedIds[0]]) {
    const chain: string[] = [];
    let cur: string | null = selectedIds[0];
    let guard = 0;
    while (cur && nodes[cur] && guard++ < 32) { chain.unshift(nodes[cur].name); cur = nodes[cur].parentId; }
    crumbs.push(...chain);
  } else if (selectedIds.length > 1) {
    crumbs.push(`${selectedIds.length} objects`);
  } else if (sketchSession) {
    crumbs.push(sketchSession.name);
  }

  const fpsColor = fps >= 50 ? 'var(--success)' : fps >= 30 ? 'var(--warn)' : 'var(--error)';
  const occReady = !!window.oc;
  const modeIcon = MODE_ICON[interactionMode] ?? 'select';

  return (
    <div style={barStyle}>
      {/* Mode pill */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '2px 9px',
        borderRadius: 'var(--radius-sm)', background: 'var(--accent-soft)',
        color: 'var(--accent)', fontWeight: 700, fontSize: 10, flexShrink: 0,
      }}>
        <Icon name={modeIcon} size={13} />
        {MODE_LABEL[interactionMode] ?? interactionMode}
        {interactionMode === 'SELECT' && (
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {GIZMO_LABEL[gizmoMode]}</span>
        )}
      </div>

      <Div />

      {/* Breadcrumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }}>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>›</span>}
            <span style={{
              fontSize: 11, whiteSpace: 'nowrap',
              color: i === crumbs.length - 1 ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: i === crumbs.length - 1 ? 600 : 400,
              overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160,
            }}>{c}</span>
          </React.Fragment>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Snap */}
      <button
        onClick={() => setSnapEnabled(!snapEnabled)}
        title={snapEnabled ? 'Disable grid snap' : 'Enable grid snap'}
        style={{
          ...chipStyle, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
          background: snapEnabled ? 'var(--success-soft)' : 'transparent',
          color:      snapEnabled ? 'var(--success)' : 'var(--text-muted)',
          border:     snapEnabled ? '1px solid var(--success)' : '1px solid var(--border)',
        }}
      >
        <Icon name="grid" size={12} /> Snap {snapEnabled ? 'on' : 'off'}
      </button>
      {snapEnabled && (
        <select
          value={snapStep}
          onChange={(e) => setSnapStep(Number(e.target.value))}
          style={{ ...chipStyle, cursor: 'pointer', color: 'var(--success)', background: 'var(--success-soft)', border: '1px solid var(--success)' }}
        >
          {[0.1, 0.5, 1, 2, 5, 10, 25].map((v) => <option key={v} value={v}>{v} mm</option>)}
        </select>
      )}

      <Div />

      {/* Coords */}
      <span className="mono" style={{ ...chipStyle, border: 'none', color: 'var(--text-dim)' }}>
        <b style={{ color: 'var(--text-muted)', fontWeight: 500 }}>X</b> {mousePos.x.toFixed(2)}
        &nbsp;<b style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Y</b> {mousePos.y.toFixed(2)}
        &nbsp;<b style={{ color: 'var(--text-muted)', fontWeight: 500 }}>Z</b> {mousePos.z.toFixed(2)}
      </span>

      <Div />

      <span style={{ ...chipStyle, border: 'none', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}><Icon name="undo" size={11} />{past.length}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}><Icon name="redo" size={11} />{future.length}</span>
      </span>

      {isProcessing && (
        <span style={{ ...chipStyle, color: 'var(--warn)', background: 'var(--warn-soft)', border: '1px solid var(--warn)' }}>
          ⏳ {processingLabel}
        </span>
      )}

      <span style={{ ...chipStyle, border: 'none', color: fpsColor, fontWeight: 600 }}>{fps} fps</span>

      <span style={{
        ...chipStyle, display: 'flex', alignItems: 'center', gap: 4,
        color: occReady ? 'var(--accent)' : 'var(--error)',
        border: `1px solid ${occReady ? 'var(--accent-line)' : 'var(--error)'}`,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: occReady ? 'var(--success)' : 'var(--error)' }} />
        OCC {occReady ? '✓' : '…'}
      </span>
    </div>
  );
};

const chipStyle: React.CSSProperties = {
  fontSize: '10px', padding: '2px 7px', borderRadius: 'var(--radius-sm)',
  background: 'transparent', whiteSpace: 'nowrap', fontFamily: 'inherit', flexShrink: 0,
};

const Div = () => <div style={{ width: '1px', height: '13px', background: 'var(--border)', flexShrink: 0 }} />;

const barStyle: React.CSSProperties = {
  height: '27px',
  background: 'var(--surface-1)',
  borderTop: '1px solid var(--border)',
  display: 'flex', alignItems: 'center',
  padding: '0 10px', gap: '6px',
  flexShrink: 0, overflow: 'hidden',
};
