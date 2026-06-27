// ============================================================
// ToubkalCAD – SketchDimensionInput.tsx
//
// The small floating value field(s) that accompany the in-viewport THREE.Line
// draft dimensions (drawn by useCADSketchTool). One field per active dimension,
// positioned by projecting the dimension's label point into screen pixels.
//
// Editing model (Fusion-style):
//   • The field tracks the live cursor value AND stays fully selected (blue
//     highlight) so you can just type a value to replace it — no backspacing.
//   • The first keystroke "locks" the field: it stops tracking the cursor and
//     fires `cad-sketch-dim-lock`, which makes useCADSketchTool redraw the preview
//     + dimension lines at the typed value immediately.
//   • Tab moves between fields (rectangle W↔H); Enter confirms and injects the
//     point via the existing `cad-sketch-inject-point` flow.
//
// Inputs are UNCONTROLLED and driven imperatively from one rAF loop, so per-frame
// value/position updates never fight the caret or clear the selection. React only
// owns which fields exist (they change on step change). `data-sketch-overlay`
// makes the tool's capture-phase mousedown ignore clicks on the fields.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { Workplane } from '../store/cadStore';
import { fromLocal2D } from '../services/OccSketchService';
import { buildSketchDims, SketchDimSet } from '../utils/sketchDraftDims';

const f3 = (n: number) => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(3));

const toScreen = (p: THREE.Vector3, cam: THREE.Camera, w: number, h: number) => {
  const v = p.clone().project(cam);
  return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, ok: v.z < 1 };
};

/** World units per screen pixel at the workplane (draft lines are screen-constant). */
function worldPerPixel(cam: THREE.Camera, wp: Workplane, viewportH: number): number {
  const o = new THREE.Vector3(...wp.origin);
  if ((cam as any).isOrthographicCamera) {
    const oc = cam as unknown as THREE.OrthographicCamera;
    return (oc.top - oc.bottom) / oc.zoom / (viewportH || 1);
  }
  const pc = cam as unknown as THREE.PerspectiveCamera;
  return (2 * pc.position.distanceTo(o) * Math.tan((pc.fov * Math.PI / 180) / 2)) / (viewportH || 1);
}

interface FieldDef { key: string; label: string }

export const SketchDimensionInput: React.FC = () => {
  const hostRef   = useRef<HTMLDivElement>(null);
  const pillRefs  = useRef<Map<string, HTMLDivElement>>(new Map());
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const dirtyRef  = useRef<Set<string>>(new Set());
  const lastLockRef = useRef<string>('');   // last broadcast lock signature (dedupe)
  const keysRef   = useRef<FieldDef[]>([]);
  // Latest geometry + context, captured each frame for submit / lock.
  const viewRef   = useRef<{ set: SketchDimSet | null; priors: { x: number; y: number }[]; cursor: { x: number; y: number } | null; wp: Workplane | null }>(
    { set: null, priors: [], cursor: null, wp: null },
  );

  const [keys, setKeys] = useState<FieldDef[]>([]);

  // Broadcast the current values so the tool redraws preview + lines live.
  const dispatchLock = (lock: Record<string, number> | null) => {
    window.dispatchEvent(new CustomEvent('cad-sketch-dim-lock', { detail: { vals: lock } }));
  };

  const currentVals = (): Record<string, number> => {
    const set = viewRef.current.set;
    const vals: Record<string, number> = {};
    if (!set) return vals;
    for (const d of set.dims) {
      const input = inputRefs.current.get(d.key);
      const raw = input ? parseFloat(input.value) : NaN;
      vals[d.key] = isNaN(raw) ? d.value * d.disp : raw;
    }
    return vals;
  };

  const submit = () => {
    const { set, priors, cursor } = viewRef.current;
    if (!set || !cursor) return;
    const p = set.resolve(currentVals(), priors, cursor);
    window.dispatchEvent(new CustomEvent('cad-sketch-inject-point', { detail: { localX: p.x, localY: p.y } }));
    dirtyRef.current.clear();
    dispatchLock(null);
  };

  // ── One rAF loop: positions + values + selection, all imperative ──────────────
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const st = useCADStore.getState();
      const mode = st.interactionMode, step = st.sketchInputStep;
      const cursor = st.sketchPreviewPoint, priors = st.sketchPoints as { x: number; y: number }[];
      const wp = st.activeWorkplane as Workplane;
      const cam = window.cadCamera as THREE.Camera | null;
      const host = hostRef.current;

      if (!mode.startsWith('SKETCH_') || !cursor || !cam || !host) {
        if (keysRef.current.length) { keysRef.current = []; setKeys([]); }
        viewRef.current = { set: null, priors: [], cursor: null, wp: null };
        lastLockRef.current = '';
        return;
      }

      const w = host.clientWidth, h = host.clientHeight;
      const scale = worldPerPixel(cam, wp, h);
      const set = buildSketchDims(mode, step, priors, cursor, scale);
      viewRef.current = { set, priors, cursor, wp };
      const dims = set?.dims ?? [];

      // Sync which fields exist (only on real change → React render is rare).
      const next = dims.map((d) => ({ key: d.key, label: d.label }));
      const changed = next.length !== keysRef.current.length || next.some((k, i) => k.key !== keysRef.current[i]?.key);
      if (changed) { keysRef.current = next; dirtyRef.current.clear(); setKeys(next); }

      // Position each pill + refresh untyped values (kept selected → blue highlight).
      for (const d of dims) {
        const s = toScreen(fromLocal2D(d.labelLocal.x, d.labelLocal.y, wp), cam, w, h);
        const pill = pillRefs.current.get(d.key);
        if (pill) {
          pill.style.display = s.ok ? 'flex' : 'none';
          pill.style.left = `${s.x}px`;
          pill.style.top  = `${s.y}px`;
        }
        const input = inputRefs.current.get(d.key);
        if (input && !dirtyRef.current.has(d.key)) {
          input.value = f3(d.value * d.disp);
          if (document.activeElement === input) input.select();
        }
      }

      // Once the user has typed into ≥1 field, keep re-broadcasting the lock each
      // frame so the UNTYPED fields keep tracking the cursor (typed fields stay
      // fixed). currentVals() reads each input AFTER the refresh above, so untyped
      // keys carry their live cursor value and dirty keys carry the typed value.
      // Dedupe by signature so a stationary cursor doesn't spam events.
      if (dirtyRef.current.size > 0) {
        const vals = currentVals();
        const sig = JSON.stringify(vals);
        if (sig !== lastLockRef.current) { lastLockRef.current = sig; dispatchLock(vals); }
      } else if (lastLockRef.current) {
        lastLockRef.current = '';
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Focus + select the first field whenever the active fields change (new step).
  useEffect(() => {
    if (!keys.length) return;
    const id = setTimeout(() => {
      const first = inputRefs.current.get(keys[0].key);
      first?.focus(); first?.select();
    }, 20);
    return () => clearTimeout(id);
  }, [keys]);

  const onInput = (key: string) => {
    dirtyRef.current.add(key);          // first keystroke locks this field
    const vals = currentVals();         // preview + lines follow the typed value live
    lastLockRef.current = JSON.stringify(vals);   // keep the rAF dedupe in sync
    dispatchLock(vals);
  };

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (idx < keys.length - 1) {
        const nxt = inputRefs.current.get(keys[idx + 1].key);
        nxt?.focus(); nxt?.select();
      } else {
        e.nativeEvent.stopImmediatePropagation();
        submit();
      }
    }
    // Esc bubbles → the tool steps back / cancels.
  };

  return (
    <div ref={hostRef} data-sketch-overlay style={hostStyle}>
      {keys.map((fld, i) => (
        <div
          key={fld.key}
          ref={(n) => { if (n) pillRefs.current.set(fld.key, n); else pillRefs.current.delete(fld.key); }}
          style={pillStyle}
        >
          <span style={labelStyle}>{fld.label}</span>
          <input
            ref={(n) => { if (n) inputRefs.current.set(fld.key, n); else inputRefs.current.delete(fld.key); }}
            type="number"
            step="any"
            defaultValue="0"
            onInput={() => onInput(fld.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onFocus={(e) => e.target.select()}
            onMouseDown={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </div>
      ))}
    </div>
  );
};

const hostStyle: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 26 };
const pillStyle: React.CSSProperties = {
  position: 'absolute', transform: 'translate(-50%, -50%)',
  display: 'flex', alignItems: 'center', gap: 3, padding: '1px 4px', borderRadius: 4,
  background: 'rgba(255,255,255,0.96)', border: '1px solid rgba(40,51,64,0.5)',
  boxShadow: '0 1px 5px rgba(0,0,0,0.25)',
  // pointerEvents:none so a placement click passes THROUGH the pill to the canvas
  // — radial-dimension pills (circle Ø, arc/polygon R) sit right under the cursor,
  // and otherwise swallow the click that should finish the shape. The field is
  // auto-focused + kept selected, so the user types directly (no click needed);
  // Tab moves between fields, Enter or a viewport click commits. See useCADSketchTool.
  pointerEvents: 'none',
};
const labelStyle: React.CSSProperties = { fontSize: 9, color: '#516072', fontWeight: 700 };
const inputStyle: React.CSSProperties = {
  width: 58, background: 'transparent', border: 'none', color: '#1a2330',
  padding: '1px 2px', fontSize: 12, fontFamily: 'monospace', fontWeight: 700,
  textAlign: 'right', outline: 'none',
};
