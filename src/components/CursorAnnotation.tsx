// ============================================================
// ToubkalCAD – CursorAnnotation.tsx
//
// A small floating badge that follows the cursor while sketching,
// showing live coordinates (step 0) or a growing dimension
// (step 1+) for every 2D sketch tool.
//
// Reads from Zustand via getState() inside a rAF-throttled
// mousemove handler so React renders at most once per frame,
// not once per raw mouse event.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { useCADStore }  from '../store/cadStore';
import type { InteractionMode } from '../store/cadStore';

// ─── Annotation data ─────────────────────────────────────────────────────────

type Line = {
  label: string;
  value: string;
  /** true = green "dimension" colour, false/undefined = dim secondary colour */
  dim?: boolean;
};

function f(n: number) { return n.toFixed(3); }

function dist2(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function computeLines(
  mode:    string,
  step:    number,
  points:  { x: number; y: number }[],
  preview: { x: number; y: number },
): Line[] {
  const xy: Line[] = [{ label: 'X', value: f(preview.x) }, { label: 'Y', value: f(preview.y) }];

  if (step === 0) return xy;

  const p0 = points[0];

  switch (mode as InteractionMode) {

    case 'SKETCH_LINE': {
      const len = dist2(p0, preview);
      const ang = Math.atan2(preview.y - p0.y, preview.x - p0.x) * 180 / Math.PI;
      return [
        { label: 'L', value: f(len),            dim: true  },
        { label: '∠', value: `${ang.toFixed(1)}°` },
      ];
    }

    case 'SKETCH_CIRCLE': {
      const r = dist2(p0, preview);
      return [
        { label: 'R',  value: f(r),      dim: true },
        { label: '⌀', value: f(2 * r) },
      ];
    }

    case 'SKETCH_RECTANGLE': {
      const w = Math.abs(preview.x - p0.x);
      const h = Math.abs(preview.y - p0.y);
      return [
        { label: 'W', value: f(w), dim: true },
        { label: 'H', value: f(h), dim: true },
      ];
    }

    case 'SKETCH_ARC': {
      if (step === 1) {
        const r = dist2(p0, preview);
        return [{ label: 'R', value: f(r), dim: true }];
      }
      // step 2: center=p0, start=p1, cursor=endPt
      const p1  = points[1];
      const r   = dist2(p0, p1);
      const a1  = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
      let   a2  = Math.atan2(preview.y - p0.y, preview.x - p0.x) * 180 / Math.PI;
      if (a2 <= a1) a2 += 360;
      return [
        { label: 'R',  value: f(r) },
        { label: '∠', value: `${(a2 - a1).toFixed(1)}°`, dim: true },
      ];
    }

    case 'SKETCH_ARC_3P':
      return xy;

    case 'SKETCH_ELLIPSE': {
      if (step === 1) {
        return [{ label: 'Maj', value: f(dist2(p0, preview)), dim: true }];
      }
      const p1  = points[1];
      return [
        { label: 'Maj', value: f(dist2(p0, p1)) },
        { label: 'Min', value: f(dist2(p0, preview)), dim: true },
      ];
    }

    case 'SKETCH_POLYGON': {
      const r = dist2(p0, preview);
      return [{ label: 'R', value: f(r), dim: true }];
    }

    case 'SKETCH_ROUNDED_RECT': {
      if (step === 1) {
        return [
          { label: 'W', value: f(Math.abs(preview.x - p0.x)), dim: true },
          { label: 'H', value: f(Math.abs(preview.y - p0.y)), dim: true },
        ];
      }
      return [{ label: 'CR', value: f(dist2(p0, preview)), dim: true }];
    }

    case 'SKETCH_BEZIER':
    case 'SKETCH_SPLINE': {
      const prev = points[step - 1];
      const seg  = prev ? dist2(prev, preview) : 0;
      return [
        { label: '+L', value: f(seg), dim: true },
        { label: 'X',  value: f(preview.x) },
        { label: 'Y',  value: f(preview.y) },
      ];
    }

    default: return xy;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

type AnnState = {
  screenX: number;
  screenY: number;
  lines:   Line[];
  hasDim:  boolean;   // true when at least one line is a live dimension
} | null;

export function CursorAnnotation() {
  const [ann, setAnn] = useState<AnnState>(null);
  const rafRef        = useRef<number | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (rafRef.current !== null) return;           // already scheduled
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;

        const {
          interactionMode: mode,
          sketchPreviewPoint: pt,
          sketchInputStep:    step,
          sketchPoints:       pts,
        } = useCADStore.getState();

        if (!mode.startsWith('SKETCH_') || !pt) {
          setAnn(null);
          return;
        }

        const lines  = computeLines(mode, step, pts, pt);
        const hasDim = lines.some((l) => l.dim);

        setAnn({ screenX: e.clientX, screenY: e.clientY, lines, hasDim });
      });
    };

    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!ann) return null;

  const { screenX, screenY, lines, hasDim } = ann;

  const borderColor  = hasDim ? 'rgba(74,222,128,0.45)' : 'rgba(80,140,255,0.35)';
  const dotColor     = hasDim ? '#4ade80'                : '#60a5fa';

  return (
    <div
      style={{
        position:        'fixed',
        left:            screenX + 18,
        top:             screenY - 48,
        zIndex:          9999,
        pointerEvents:   'none',
        background:      'rgba(8,12,20,0.90)',
        border:          `1px solid ${borderColor}`,
        borderRadius:    5,
        padding:         '4px 9px',
        display:         'flex',
        alignItems:      'center',
        gap:             8,
        fontSize:        11,
        fontFamily:      'monospace',
        backdropFilter:  'blur(6px)',
        boxShadow:       '0 3px 12px rgba(0,0,0,0.5)',
        whiteSpace:      'nowrap',
        userSelect:      'none',
      }}
    >
      {/* Status dot */}
      <span
        style={{
          width:        6,
          height:       6,
          borderRadius: '50%',
          background:   dotColor,
          flexShrink:   0,
          boxShadow:    hasDim ? `0 0 6px ${dotColor}` : 'none',
        }}
      />

      {/* Annotation lines */}
      {lines.map((ln, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{ fontSize: 9, color: ln.dim ? '#86efac' : '#64748b', letterSpacing: '0.3px' }}>
            {ln.label}
          </span>
          <span style={{ fontWeight: 700, color: ln.dim ? '#4ade80' : '#94a3b8', fontSize: 12 }}>
            {ln.value}
          </span>
        </span>
      ))}
    </div>
  );
}
