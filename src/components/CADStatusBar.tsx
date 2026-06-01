// ============================================================
// ToubkalCAD – CADStatusBar.tsx
// Bottom status bar: mode, selection, snap, coords, FPS.
// ============================================================

import '../types/index';
import React, { useEffect, useState, useRef } from 'react';
import { useCADStore } from '../store/cadStore';

export const CADStatusBar: React.FC = () => {
  const interactionMode = useCADStore((s) => s.interactionMode);
  const gizmoMode       = useCADStore((s) => s.gizmoMode);
  const selectedIds     = useCADStore((s) => s.selectedIds);
  const nodes           = useCADStore((s) => s.nodes);
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

  // FPS counter via rAF
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      fpsRef.current.frames++;
      const now = performance.now();
      if (now - fpsRef.current.last >= 1000) {
        setFps(fpsRef.current.frames);
        fpsRef.current.frames = 0;
        fpsRef.current.last   = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // World-space cursor coordinates
  useEffect(() => {
    const fn = (e: Event) => {
      const { x, y, z } = (e as CustomEvent).detail;
      setMousePos({ x, y, z });
    };
    window.addEventListener('cad-mouse-world-pos', fn);
    return () => window.removeEventListener('cad-mouse-world-pos', fn);
  }, []);

  const MODE_LABEL: Record<string, string> = {
    SELECT:           '↖ Select',
    SKETCH_LINE:      '✏ Line',
    SKETCH_CIRCLE:    '⊙ Circle',
    MEASURE_DISTANCE: '↔ Measure',
  };
  const GIZMO_LABEL: Record<string, string> = {
    translate: 'W: Translate',
    rotate:    'E: Rotate',
    scale:     'R: Scale',
  };

  const selLabel = selectedIds.length > 0
    ? `${selectedIds.length} obj${selectedIds.length > 1 ? 's' : ''}: ${
        selectedIds.slice(0, 3).map((id) => nodes[id]?.name ?? '?').join(', ')
      }${selectedIds.length > 3 ? '…' : ''}`
    : 'None';

  const fpsColor = fps >= 50 ? 'var(--success)' : fps >= 30 ? 'var(--warn)' : 'var(--error)';
  const occReady = !!window.oc;

  return (
    <div style={barStyle}>
      {/* Interaction mode */}
      <Chip color="var(--accent)">{MODE_LABEL[interactionMode] ?? interactionMode}</Chip>
      {interactionMode === 'SELECT' && (
        <Chip color="var(--text-dim)">{GIZMO_LABEL[gizmoMode]}</Chip>
      )}

      <Div />

      {/* Selection */}
      <Chip color={selectedIds.length ? 'var(--success)' : 'var(--text-muted)'}>
        {selLabel}
      </Chip>

      <Div />

      {/* Snap toggle */}
      <button
        onClick={() => setSnapEnabled(!snapEnabled)}
        title={snapEnabled ? 'Disable grid snap' : 'Enable grid snap'}
        style={{
          ...chipStyle,
          background: snapEnabled ? 'rgba(63,185,80,0.12)' : 'transparent',
          color:      snapEnabled ? 'var(--success)' : 'var(--text-muted)',
          border:     snapEnabled ? '1px solid rgba(63,185,80,0.3)' : '1px solid var(--border)',
          cursor: 'pointer',
        }}
      >
        ⊞ Snap {snapEnabled ? 'ON' : 'OFF'}
      </button>
      {snapEnabled && (
        <select
          value={snapStep}
          onChange={(e) => setSnapStep(Number(e.target.value))}
          style={{
            ...chipStyle,
            cursor: 'pointer',
            color: 'var(--success)',
            background: 'rgba(63,185,80,0.08)',
            border: '1px solid rgba(63,185,80,0.25)',
          }}
        >
          {[0.1, 0.5, 1, 2, 5, 10, 25].map((v) => (
            <option key={v} value={v}>{v} mm</option>
          ))}
        </select>
      )}

      <Div />

      {/* World coordinates */}
      <Chip color="var(--text-muted)" className="mono">
        X {mousePos.x.toFixed(2)}  Y {mousePos.y.toFixed(2)}  Z {mousePos.z.toFixed(2)}
      </Chip>

      <div style={{ flex: 1 }} />

      {/* Undo/Redo counters */}
      <Chip color="var(--text-muted)">↩{past.length}  ↪{future.length}</Chip>

      <Div />

      {/* Processing */}
      {isProcessing && <Chip color="var(--warn)">⏳ {processingLabel}</Chip>}

      {/* FPS */}
      <Chip color={fpsColor}>{fps} fps</Chip>

      {/* OCC kernel indicator */}
      <Chip color={occReady ? 'var(--accent)' : 'var(--error)'}>
        {occReady ? '⬡ OCC ✓' : '⬡ OCC …'}
      </Chip>
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const chipStyle: React.CSSProperties = {
  fontSize: '10px',
  padding: '1px 7px',
  borderRadius: 'var(--radius-sm)',
  background: 'transparent',
  border: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
};

const Chip: React.FC<{
  color: string;
  className?: string;
  children: React.ReactNode;
}> = ({ color, className, children }) => (
  <span className={className} style={{ ...chipStyle, color }}>{children}</span>
);

const Div = () => (
  <div style={{ width: '1px', height: '12px', background: 'var(--border)', flexShrink: 0 }} />
);

const barStyle: React.CSSProperties = {
  height: '24px',
  background: 'var(--surface-1)',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  padding: '0 8px',
  gap: '5px',
  flexShrink: 0,
  overflow: 'hidden',
};
