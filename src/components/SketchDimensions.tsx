// ============================================================
// ToubkalCAD – SketchDimensions.tsx
//
// Phase 8 – dimension, constraint & DoF annotations for the viewport.
//
// An SVG overlay (pointer-events: none) shown while the constraint
// panel is open. For the active sketch it:
//   • draws pickable point markers (endpoints / centers); the picked
//     ones are highlighted
//   • draws a dimension line + value for LENGTH / RADIUS / DISTANCE,
//     and an angle badge for ANGLE
//   • draws a glyph badge for each geometric constraint
//   • prints the remaining degrees-of-freedom in the corner
//
// Entity points are projected to screen every animation frame so the
// annotations track camera orbit / zoom.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useCADStore, sketchRefEq } from '../store/cadStore';
import type { SketchConstraint, SketchRef, Workplane } from '../store/cadStore';
import { fromLocal2D, workplaneBasis } from '../services/OccSketchService';
import { CONSTRAINT_META } from '../services/SketchConstraintSolver';
import { DATUM_UAXIS, DATUM_VAXIS, ORIGIN_REF, isDatumId } from '../services/SketchDatums';

const COLOR = '#0f8f63';
const STATE_COLOR = { under: '#2a86d6', full: '#16a06a', over: '#cc3a3a', conflict: '#d98a26' } as const;

interface Pt { x: number; y: number; ok: boolean }
const toScreen = (p: THREE.Vector3, cam: THREE.Camera, w: number, h: number): Pt => {
  const v = p.clone().project(cam);
  return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, ok: v.z < 1 };
};

/** Legacy {entityIds} → {refs}. */
function refsOf(c: SketchConstraint): SketchRef[] {
  if (c.refs) return c.refs;
  return ((c as any).entityIds ?? []).map((id: string) => ({ kind: 'entity', id }));
}

export const SketchDimensions: React.FC = () => {
  const constraintReq = useCADStore((s) => s.constraintReq);
  const sel           = useCADStore((s) => s.constraintSel);
  const status        = useCADStore((s) => s.constraintStatus);
  const nodes         = useCADStore((s) => s.nodes);
  const ref           = useRef<HTMLDivElement>(null);
  const [, setTick]   = useState(0);

  useEffect(() => {
    if (!constraintReq) return;
    let raf = 0; let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t; setTick((n) => (n + 1) & 0xffff);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [constraintReq]);

  if (!constraintReq) return null;
  const sketch = nodes[constraintReq.sketchId];
  const cam = window.cadCamera as THREE.Camera | null;
  const el  = ref.current;
  if (!sketch || !cam) return <div ref={ref} style={fill} />;

  const w = el?.clientWidth ?? 0;
  const h = el?.clientHeight ?? 0;

  const geomOf = (id: string) => {
    const n = nodes[id];
    const g = n?.params?.sketchGeom;
    const wp = n?.params?.workplane as Workplane | undefined;
    return g && wp ? { g, wp } : null;
  };
  // Workplane of the sketch as a whole (for the Origin/axis datums).
  const sketchWP = ((): Workplane | null => {
    for (const id of sketch.children ?? []) {
      const wp = nodes[id]?.params?.workplane as Workplane | undefined;
      if (wp) return wp;
    }
    return useCADStore.getState().activeWorkplane ?? null;
  })();
  const pointWorld = (r: SketchRef): THREE.Vector3 | null => {
    // Datum operands resolve against the sketch plane, not a node.
    if (isDatumId(r.id)) {
      if (!sketchWP) return null;
      if (r.id === DATUM_VAXIS) return fromLocal2D(0, 0, sketchWP);   // axis → origin as representative
      return fromLocal2D(0, 0, sketchWP);                            // U axis / Origin
    }
    const e = geomOf(r.id); if (!e) return null;
    if (r.kind === 'point') {
      if (e.g.kind === 'line')   return fromLocal2D(...(r.pt === 'b' ? e.g.b : e.g.a) as [number, number], e.wp);
      if (e.g.kind === 'circle') return fromLocal2D(e.g.c[0], e.g.c[1], e.wp);
      if (e.g.kind === 'arc') {
        if (r.pt === 'a' || r.pt === 'b') {
          const ang = r.pt === 'a' ? e.g.a1 : e.g.a2;
          return fromLocal2D(e.g.c[0] + e.g.r * Math.cos(ang), e.g.c[1] + e.g.r * Math.sin(ang), e.wp);
        }
        return fromLocal2D(e.g.c[0], e.g.c[1], e.wp);
      }
      return null;
    }
    // entity ref → representative point (midpoint / center)
    if (e.g.kind === 'line') return fromLocal2D((e.g.a[0] + e.g.b[0]) / 2, (e.g.a[1] + e.g.b[1]) / 2, e.wp);
    if (e.g.kind === 'circle' || e.g.kind === 'arc') return fromLocal2D(e.g.c[0], e.g.c[1], e.wp);
    return null;
  };

  const lines: React.ReactNode[] = [];
  const marks: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];

  const badge = (key: string, p: Pt, txt: string) => {
    if (!p.ok) return;
    const wBox = Math.max(18, txt.length * 7 + 8);
    labels.push(
      <g key={key} transform={`translate(${p.x},${p.y})`}>
        <rect x={-wBox / 2} y={-9} width={wBox} height={18} rx={4} fill="rgba(8,20,16,0.85)" stroke={COLOR} strokeWidth={1} />
        <text x={0} y={4} fontSize={11} fontFamily="monospace" fill={COLOR} textAnchor="middle" fontWeight={700}>{txt}</text>
      </g>,
    );
  };

  // ── Pickable point markers ─────────────────────────────────────────────────
  for (const id of sketch.children ?? []) {
    const e = geomOf(id);
    if (!e) continue;
    const cands: SketchRef[] =
      e.g.kind === 'line' ? [{ kind: 'point', id, pt: 'a' }, { kind: 'point', id, pt: 'b' }]
      : e.g.kind === 'arc' ? [{ kind: 'point', id, pt: 'c' }, { kind: 'point', id, pt: 'a' }, { kind: 'point', id, pt: 'b' }]
      : [{ kind: 'point', id, pt: 'c' }];
    for (const r of cands) {
      const wp = pointWorld(r); if (!wp) continue;
      const s = toScreen(wp, cam, w, h); if (!s.ok) continue;
      const picked = sel.some((x) => sketchRefEq(x, r));
      marks.push(
        <circle key={`${id}-${r.pt}`} cx={s.x} cy={s.y} r={picked ? 4.5 : 3}
          fill={picked ? '#ff8800' : 'rgba(10,107,214,0.25)'} stroke={picked ? '#ff8800' : '#0a6bd6'} strokeWidth={1.2} />,
      );
    }
  }

  // ── Origin + axis datums (faint reference, selectable) ─────────────────────
  if (sketchWP) {
    const o = toScreen(fromLocal2D(0, 0, sketchWP), cam, w, h);
    const axis = (id: string, far: THREE.Vector3, neg: THREE.Vector3, dash: string) => {
      const p = toScreen(far, cam, w, h), n = toScreen(neg, cam, w, h);
      if (!p.ok || !n.ok) return;
      const lit = sel.some((r) => r.kind === 'entity' && r.id === id);
      lines.push(<line key={`ax${id}`} x1={n.x} y1={n.y} x2={p.x} y2={p.y}
        stroke={lit ? '#ff8800' : '#4a6a8a'} strokeWidth={lit ? 1.6 : 1}
        strokeDasharray={dash} opacity={lit ? 0.95 : 0.5} />);
    };
    axis(DATUM_UAXIS, fromLocal2D(1e4, 0, sketchWP), fromLocal2D(-1e4, 0, sketchWP), '6 4');
    axis(DATUM_VAXIS, fromLocal2D(0, 1e4, sketchWP), fromLocal2D(0, -1e4, sketchWP), '6 4');
    if (o.ok) {
      const litO = sel.some((r) => sketchRefEq(r, ORIGIN_REF));
      marks.push(
        <g key="origin">
          <circle cx={o.x} cy={o.y} r={litO ? 5 : 3.5}
            fill={litO ? '#ff8800' : 'rgba(74,106,138,0.4)'} stroke={litO ? '#ff8800' : '#4a6a8a'} strokeWidth={1.4} />
          <line x1={o.x - 7} y1={o.y} x2={o.x + 7} y2={o.y} stroke={litO ? '#ff8800' : '#4a6a8a'} strokeWidth={1} opacity={0.7} />
          <line x1={o.x} y1={o.y - 7} x2={o.x} y2={o.y + 7} stroke={litO ? '#ff8800' : '#4a6a8a'} strokeWidth={1} opacity={0.7} />
        </g>,
      );
    }
  }

  // ── Constraint annotations ─────────────────────────────────────────────────
  // Dimensional constraints (LENGTH/RADIUS/DISTANCE/ANGLE) are drawn by the
  // Three.js + CSS2D SketchDimensionLayer (extension lines, arrows, editable,
  // draggable value). This SVG overlay only renders the GEOMETRIC glyph badges
  // (∥, ⟂, =, …) which have no driving value to place a dimension line for.
  const constraints = (sketch.params?.constraints as SketchConstraint[] | undefined) ?? [];
  constraints.forEach((c, ci) => {
    if (c.type === 'LENGTH' || c.type === 'RADIUS' || c.type === 'DISTANCE' || c.type === 'ANGLE') return;
    const refs = refsOf(c);
    const meta = CONSTRAINT_META[c.type];
    // Geometric glyph at each operand's representative point.
    refs.forEach((r, k) => {
      const wp = pointWorld(r); if (!wp) return;
      badge(`g${ci}_${k}`, toScreen(wp, cam, w, h), meta.glyph);
    });
  });

  // ── DoF readout ────────────────────────────────────────────────────────────
  const dofText = status
    ? (status.state === 'over' ? 'Over-constrained'
       : status.state === 'conflict' ? `Conflict · residual ${status.residual.toFixed(3)}`
       : `DoF: ${status.dof}${status.dof === 0 ? ' · fully constrained' : ''}`)
    : null;

  return (
    <div ref={ref} style={fill}>
      <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }}>
        {lines}{marks}{labels}
      </svg>
      {dofText && (
        <div style={{
          position: 'absolute', top: 8, left: 8, padding: '3px 9px', borderRadius: 4,
          background: 'rgba(8,16,22,0.82)', border: `1px solid ${status ? STATE_COLOR[status.state] : COLOR}`,
          color: status ? STATE_COLOR[status.state] : COLOR, fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
        }}>{dofText}</div>
      )}
    </div>
  );
};

const fill: React.CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 22 };
