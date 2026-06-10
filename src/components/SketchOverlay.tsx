// ============================================================
// ToubkalCAD – SketchOverlay.tsx
//
// Floating input bar at the bottom of the viewport.
// Shows the correct input fields for each sketch tool and step.
// Submitting via Enter (or the → button) fires a custom event
// that useCADSketchTool converts into a world-space click.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useCADStore, InteractionMode } from '../store/cadStore';

// ─── Step configuration ───────────────────────────────────────────────────────

type FieldDef = { key: string; label: string };

type StepDef = {
  prompt:  string;
  fields:  FieldDef[];
  /** Convert numeric form values + prior local-2D points → new local-2D point. */
  resolve: (
    vals:   Record<string, number>,
    priors: { x: number; y: number }[],
  ) => { x: number; y: number };
};

const XY: FieldDef[] = [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }];

/** Nearest world-axis name (X/Y/Z) that a unit direction points along. */
const axisName = (v: [number, number, number]): string => {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
  if (ax >= ay && ax >= az) return 'X';
  if (ay >= az) return 'Y';
  return 'Z';
};

const xyResolve = (v: Record<string, number>) => ({ x: v.x ?? 0, y: v.y ?? 0 });

const radiusResolve = (v: Record<string, number>, p: { x: number; y: number }[]) => ({
  x: (p[0]?.x ?? 0) + (v.r ?? 5),
  y: p[0]?.y ?? 0,
});

const TOOL_STEPS: Partial<Record<InteractionMode, StepDef[]>> = {
  SKETCH_LINE: [
    { prompt: 'Start point', fields: XY, resolve: xyResolve },
    { prompt: 'End point',   fields: XY, resolve: xyResolve },
  ],
  SKETCH_CIRCLE: [
    { prompt: 'Center', fields: XY,                           resolve: xyResolve     },
    { prompt: 'Radius', fields: [{ key: 'r', label: 'R' }],  resolve: radiusResolve },
  ],
  SKETCH_RECTANGLE: [
    { prompt: 'Corner 1', fields: XY, resolve: xyResolve },
    { prompt: 'Corner 2', fields: XY, resolve: xyResolve },
  ],
  SKETCH_ARC: [
    { prompt: 'Center',       fields: XY, resolve: xyResolve },
    { prompt: 'Start point',  fields: XY, resolve: xyResolve },
    { prompt: 'End point',    fields: XY, resolve: xyResolve },
  ],
  SKETCH_ARC_3P: [
    { prompt: 'Point 1',  fields: XY, resolve: xyResolve },
    { prompt: 'Midpoint', fields: XY, resolve: xyResolve },
    { prompt: 'Point 3',  fields: XY, resolve: xyResolve },
  ],
  SKETCH_ELLIPSE: [
    { prompt: 'Center',          fields: XY, resolve: xyResolve },
    { prompt: 'Major axis end',  fields: XY, resolve: xyResolve },
    { prompt: 'Minor axis end',  fields: XY, resolve: xyResolve },
  ],
  SKETCH_POLYGON: [
    { prompt: 'Center', fields: XY, resolve: xyResolve },
    { prompt: 'Vertex', fields: XY, resolve: xyResolve },
  ],
  SKETCH_ROUNDED_RECT: [
    { prompt: 'Corner 1',      fields: XY,                          resolve: xyResolve     },
    { prompt: 'Corner 2',      fields: XY,                          resolve: xyResolve     },
    { prompt: 'Corner radius', fields: [{ key: 'r', label: 'R' }], resolve: radiusResolve },
  ],
  SKETCH_BEZIER: [
    { prompt: 'Control point', fields: XY, resolve: xyResolve },
  ],
  SKETCH_SPLINE: [
    { prompt: 'Through-point', fields: XY, resolve: xyResolve },
  ],
};

const TOOL_LABEL: Partial<Record<InteractionMode, string>> = {
  SKETCH_LINE:         'Line',
  SKETCH_CIRCLE:       'Circle',
  SKETCH_RECTANGLE:    'Rectangle',
  SKETCH_ARC:          'Arc (C→S→E)',
  SKETCH_ARC_3P:       'Arc (3 Pts)',
  SKETCH_ELLIPSE:      'Ellipse',
  SKETCH_POLYGON:      'Polygon',
  SKETCH_ROUNDED_RECT: 'Rounded Rect',
  SKETCH_BEZIER:       'Bézier',
  SKETCH_SPLINE:       'Spline',
};

const IS_CURVE = new Set<InteractionMode>(['SKETCH_BEZIER', 'SKETCH_SPLINE']);

// ─── Component ────────────────────────────────────────────────────────────────

export const SketchOverlay: React.FC = () => {
  const mode         = useCADStore((s) => s.interactionMode);
  const step         = useCADStore((s) => s.sketchInputStep);
  const points       = useCADStore((s) => s.sketchPoints);
  const previewPt    = useCADStore((s) => s.sketchPreviewPoint);
  const polygonSides = useCADStore((s) => s.sketchPolygonSides);
  const workplane    = useCADStore((s) => s.activeWorkplane);

  const [vals, setVals] = useState<Record<string, string>>({});
  const firstRef        = useRef<HTMLInputElement>(null);
  const previewRef      = useRef(previewPt);

  // Keep a live ref to preview so we can read it inside the step-change effect
  // without adding previewPt to the dep array (that would reset vals every mouse move)
  useEffect(() => { previewRef.current = previewPt; }, [previewPt]);

  // When step or mode changes: pre-fill with current cursor position and auto-focus
  useEffect(() => {
    if (!mode.startsWith('SKETCH_')) return;
    const p = previewRef.current;
    if (p) {
      setVals({ x: p.x.toFixed(3), y: p.y.toFixed(3) });
    } else {
      setVals({});
    }
    setTimeout(() => { firstRef.current?.select(); firstRef.current?.focus(); }, 30);
  }, [mode, step]);

  if (!mode.startsWith('SKETCH_')) return null;

  const steps     = TOOL_STEPS[mode as InteractionMode];
  const isCurve   = IS_CURVE.has(mode as InteractionMode);
  const totalSteps = isCurve ? null : (steps?.length ?? 0);
  // Curves reuse the same step def; fixed tools clamp to last step
  const stepDef   = steps
    ? (isCurve ? steps[0] : steps[Math.min(step, steps.length - 1)])
    : null;

  if (!stepDef) return null;

  const toolLabel  = TOOL_LABEL[mode as InteractionMode] ?? mode;
  const stepPrompt = isCurve ? `Point ${step + 1}` : stepDef.prompt;
  const canFinish  = isCurve && step >= 2;

  // Label the in-plane inputs by the world axis each sketch axis follows
  // (local x → uAxis, local y → vAxis): e.g. ZX plane shows "X" and "Z".
  // Fall back to U/V if both collapse to the same world axis (tilted face plane).
  let uLabel = axisName(workplane.uAxis);
  let vLabel = axisName(workplane.vAxis);
  if (uLabel === vLabel) { uLabel = 'U'; vLabel = 'V'; }
  const fieldLabel = (f: FieldDef): string =>
    f.key === 'x' ? uLabel : f.key === 'y' ? vLabel : f.label;

  // ── Submission ───────────────────────────────────────────────────────────────

  const submit = () => {
    const numVals: Record<string, number> = {};
    for (const f of stepDef.fields) {
      numVals[f.key] = parseFloat(vals[f.key] ?? '') || 0;
    }
    const { x, y } = stepDef.resolve(numVals, points);
    window.dispatchEvent(
      new CustomEvent('cad-sketch-inject-point', { detail: { localX: x, localY: y } }),
    );
    setVals({});
  };

  const finish = () => {
    window.dispatchEvent(new CustomEvent('cad-sketch-finish-curve'));
  };

  // ── Styles ───────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width:       '80px',
    background:  'var(--surface-3)',
    border:      '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color:       'var(--accent)',
    padding:     '3px 6px',
    fontSize:    '12px',
    fontFamily:  'monospace',
    outline:     'none',
    textAlign:   'right',
  };

  const btnStyle = (bg: string): React.CSSProperties => ({
    background:   bg,
    border:       'none',
    borderRadius: 'var(--radius-sm)',
    color:        '#fff',
    padding:      '3px 12px',
    cursor:       'pointer',
    fontSize:     11,
    fontWeight:   700,
    flexShrink:   0,
  });

  const kbd: React.CSSProperties = {
    background:   'rgba(255,255,255,0.1)',
    borderRadius: 2,
    padding:      '1px 4px',
    fontFamily:   'monospace',
    fontSize:     9,
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div data-sketch-overlay style={{
      position:       'absolute',
      bottom:         44,
      left:           '50%',
      transform:      'translateX(-50%)',
      zIndex:         25,
      background:     'rgba(10,14,20,0.93)',
      border:         '1px solid rgba(0,100,220,0.35)',
      borderRadius:   6,
      padding:        '8px 14px 6px',
      color:          '#cce4ff',
      fontSize:       11,
      minWidth:       360,
      backdropFilter: 'blur(8px)',
      userSelect:     'none',
      boxShadow:      '0 4px 24px rgba(0,0,0,0.55)',
      pointerEvents:  'auto',
    }}>

      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div style={{
        display:       'flex',
        alignItems:    'center',
        gap:           8,
        marginBottom:  7,
        borderBottom:  '1px solid rgba(255,255,255,0.07)',
        paddingBottom: 6,
      }}>
        <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          {toolLabel}
        </span>

        {totalSteps !== null && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--surface-3)', borderRadius: 3, padding: '1px 6px' }}>
            {step + 1} / {totalSteps}
          </span>
        )}

        <span style={{ fontSize: 10, color: '#88aacc' }}>{stepPrompt}</span>

        {mode === 'SKETCH_POLYGON' && (
          <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-muted)' }}>
            {polygonSides} sides
          </span>
        )}
      </div>

      {/* ── Input fields row ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {stepDef.fields.map((f, i) => (
          <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, minWidth: 14, textAlign: 'right' }}>
              {fieldLabel(f)}
            </span>
            <input
              ref={i === 0 ? firstRef : undefined}
              type="number"
              step="any"
              value={vals[f.key] ?? ''}
              placeholder="0"
              onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Stop native propagation so the hook's window Enter handler doesn't fire
                  e.nativeEvent.stopImmediatePropagation();
                  e.preventDefault();
                  submit();
                }
                // Esc: let propagate normally — hook's onKey handles step-back or cancel
              }}
              onFocus={(ev) => { ev.target.style.borderColor = 'var(--accent)'; ev.target.select(); }}
              onBlur={(ev)  => { ev.target.style.borderColor = 'var(--border)'; }}
              style={inputStyle}
            />
          </label>
        ))}

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {canFinish && (
            <button onClick={finish} style={btnStyle('#2a9a55')}>
              Finish ✓
            </button>
          )}
          <button onClick={submit} style={btnStyle('var(--accent)')}>
            {canFinish ? 'Add' : '→'}
          </button>
        </div>
      </div>

      {/* ── Hint footer ─────────────────────────────────────────────────── */}
      <div style={{
        marginTop:  6,
        borderTop:  '1px solid rgba(255,255,255,0.06)',
        paddingTop: 5,
        display:    'flex',
        gap:        16,
        fontSize:   9,
        color:      'var(--text-muted)',
        flexWrap:   'wrap',
      }}>
        <span><span style={kbd}>⏎</span> {isCurve && canFinish ? 'add point · Finish ✓ when done' : 'confirm'}</span>
        <span><span style={kbd}>Esc</span> {step > 0 ? 'back one step' : 'cancel tool'}</span>
        {isCurve && !canFinish && (
          <span style={{ fontStyle: 'italic' }}>add ≥ 2 points to enable Finish</span>
        )}
        {mode === 'SKETCH_ARC'          && <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>Center → Start → End</span>}
        {mode === 'SKETCH_ARC_3P'       && <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>P1 → Midpoint → P3</span>}
        {mode === 'SKETCH_ELLIPSE'      && <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>Center → Major → Minor</span>}
        {mode === 'SKETCH_ROUNDED_RECT' && <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>Corner → Corner → Radius</span>}
      </div>
    </div>
  );
};
