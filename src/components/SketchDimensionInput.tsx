// ============================================================
// ToubkalCAD – SketchDimensionInput.tsx
//
// The small floating HTML value field(s) that accompany the in-viewport draft
// dimension lines (those THREE.Line graphics are drawn by useCADSketchTool). One
// editable <input> per active dimension, positioned by projecting the dimension's
// label point (`vector.project(camera)`) into screen pixels — so it sits right on
// the dimension line and tracks pan/zoom/cursor.
//
// Geometry + which dimensions are active come from the SAME pure source the 3D
// lines use (buildSketchDims), so the box and the line never disagree. Confirming
// (Enter / Tab on the last field) resolves the typed/live values to a local-2D
// point and injects it through the existing `cad-sketch-inject-point` event.
//
// `data-sketch-overlay` makes the tool's capture-phase mousedown ignore clicks on
// the box, so editing never injects a stray point.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { Workplane } from '../store/cadStore';
import { fromLocal2D } from '../services/OccSketchService';
import { buildSketchDims } from '../utils/sketchDraftDims';

const toScreen = (p: THREE.Vector3, cam: THREE.Camera, w: number, h: number) => {
  const v = p.clone().project(cam);
  return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, ok: v.z < 1 };
};
const f3 = (n: number) => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(3));

export const SketchDimensionInput: React.FC = () => {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);

  // Re-project every frame so the boxes follow pan/zoom + the live cursor.
  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 25) return;
      last = t; setTick((n) => (n + 1) & 0xffff);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const mode = useCADStore((s) => s.interactionMode);
  const step = useCADStore((s) => s.sketchInputStep);

  // Reset typed values + focus the first field when the step/tool changes.
  useEffect(() => {
    setEdits({});
    const id = setTimeout(() => { inputRefs.current[0]?.focus(); inputRefs.current[0]?.select(); }, 30);
    return () => clearTimeout(id);
  }, [mode, step]);

  if (!mode.startsWith('SKETCH_')) return null;

  const st     = useCADStore.getState();
  const cursor = st.sketchPreviewPoint;
  const priors = st.sketchPoints as { x: number; y: number }[];
  const wp     = st.activeWorkplane as Workplane;
  const cam    = window.cadCamera as THREE.Camera | null;
  const el     = rootRef.current;

  const set = cursor ? buildSketchDims(mode, step, priors, cursor) : null;
  if (!set || !cursor || !cam) return <div ref={rootRef} style={hostStyle} />;

  const w = el?.clientWidth ?? 0;
  const h = el?.clientHeight ?? 0;

  // Collected display values (typed override, else live), keyed by dim.key.
  const vals: Record<string, number> = {};
  for (const dm of set.dims) {
    const live = dm.value * dm.disp;
    const typed = edits[dm.key];
    vals[dm.key] = typed !== undefined && typed !== '' && !isNaN(parseFloat(typed)) ? parseFloat(typed) : live;
  }

  const submit = () => {
    const p = set.resolve(vals, priors, cursor);
    window.dispatchEvent(new CustomEvent('cad-sketch-inject-point', { detail: { localX: p.x, localY: p.y } }));
    setEdits({});
  };

  const onKey = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (idx < set.dims.length - 1) {
        inputRefs.current[idx + 1]?.focus();
        inputRefs.current[idx + 1]?.select();
      } else {
        e.nativeEvent.stopImmediatePropagation();
        submit();
      }
    }
    // Esc bubbles → tool steps back / cancels.
  };

  return (
    <div ref={rootRef} data-sketch-overlay style={hostStyle}>
      {set.dims.map((dm, i) => {
        const s = toScreen(fromLocal2D(dm.labelLocal.x, dm.labelLocal.y, wp), cam, w, h);
        if (!s.ok) return null;
        return (
          <div
            key={dm.key}
            style={{
              position: 'absolute', left: s.x, top: s.y, transform: 'translate(-50%, -50%)',
              display: 'flex', alignItems: 'center', gap: 3,
              padding: '1px 4px', borderRadius: 4,
              background: 'rgba(255,255,255,0.95)', border: '1px solid rgba(40,51,64,0.55)',
              boxShadow: '0 1px 5px rgba(0,0,0,0.25)', pointerEvents: 'auto',
            }}
          >
            <span style={{ fontSize: 9, color: '#516072', fontWeight: 700 }}>{dm.label}</span>
            <input
              ref={(node) => { inputRefs.current[i] = node; }}
              type="number"
              step="any"
              value={edits[dm.key] ?? f3(dm.value * dm.disp)}
              onChange={(e) => setEdits((v) => ({ ...v, [dm.key]: e.target.value }))}
              onKeyDown={(e) => onKey(e, i)}
              onFocus={(e) => e.target.select()}
              onMouseDown={(e) => e.stopPropagation()}
              style={inputStyle}
            />
          </div>
        );
      })}
    </div>
  );
};

const hostStyle: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 26 };
const inputStyle: React.CSSProperties = {
  width: 58, background: 'transparent', border: 'none',
  color: '#1a2330', padding: '1px 2px', fontSize: 12, fontFamily: 'monospace',
  fontWeight: 700, textAlign: 'right', outline: 'none',
};
