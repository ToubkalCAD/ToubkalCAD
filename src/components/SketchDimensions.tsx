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

const COLOR = '#0f8f63';
const STATE_COLOR = { under: '#2a86d6', full: '#16a06a', over: '#cc3a3a' } as const;

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
  const pointWorld = (r: SketchRef): THREE.Vector3 | null => {
    const e = geomOf(r.id); if (!e) return null;
    if (r.kind === 'point') {
      if (e.g.kind === 'line')   return fromLocal2D(...(r.pt === 'b' ? e.g.b : e.g.a) as [number, number], e.wp);
      if (e.g.kind === 'circle') return fromLocal2D(e.g.c[0], e.g.c[1], e.wp);
      return null;
    }
    // entity ref → representative point (midpoint / center)
    return e.g.kind === 'line'
      ? fromLocal2D((e.g.a[0] + e.g.b[0]) / 2, (e.g.a[1] + e.g.b[1]) / 2, e.wp)
      : fromLocal2D(e.g.c[0], e.g.c[1], e.wp);
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
    const cands: SketchRef[] = e.g.kind === 'line'
      ? [{ kind: 'point', id, pt: 'a' }, { kind: 'point', id, pt: 'b' }]
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

  // ── Constraint annotations ─────────────────────────────────────────────────
  const constraints = (sketch.params?.constraints as SketchConstraint[] | undefined) ?? [];
  constraints.forEach((c, ci) => {
    const refs = refsOf(c);
    const meta = CONSTRAINT_META[c.type];
    const first = refs[0] ? geomOf(refs[0].id) : null;

    if (c.type === 'LENGTH' && first?.g.kind === 'line') {
      const g = first.g, wp = first.wp;
      const a = toScreen(fromLocal2D(g.a[0], g.a[1], wp), cam, w, h);
      const b = toScreen(fromLocal2D(g.b[0], g.b[1], wp), cam, w, h);
      if (!a.ok || !b.ok) return;
      let nx = -(b.y - a.y), ny = b.x - a.x; const L = Math.hypot(nx, ny) || 1; nx = nx / L * 16; ny = ny / L * 16;
      const a2 = { x: a.x + nx, y: a.y + ny }, b2 = { x: b.x + nx, y: b.y + ny };
      lines.push(<g key={`L${ci}`} stroke={COLOR} strokeWidth={1.2}>
        <line x1={a.x} y1={a.y} x2={a2.x} y2={a2.y} strokeDasharray="2 2" />
        <line x1={b.x} y1={b.y} x2={b2.x} y2={b2.y} strokeDasharray="2 2" />
        <line x1={a2.x} y1={a2.y} x2={b2.x} y2={b2.y} /></g>);
      badge(`Ll${ci}`, { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2, ok: true }, (c.value ?? 0).toFixed(1));
    } else if (c.type === 'RADIUS' && first?.g.kind === 'circle') {
      const g = first.g, wp = first.wp;
      const ctr = toScreen(fromLocal2D(g.c[0], g.c[1], wp), cam, w, h);
      const rim = toScreen(fromLocal2D(g.c[0] + g.r, g.c[1], wp), cam, w, h);
      if (!ctr.ok || !rim.ok) return;
      lines.push(<line key={`R${ci}`} x1={ctr.x} y1={ctr.y} x2={rim.x} y2={rim.y} stroke={COLOR} strokeWidth={1.2} />);
      badge(`Rl${ci}`, { x: (ctr.x + rim.x) / 2, y: (ctr.y + rim.y) / 2 - 8, ok: true }, `R${(c.value ?? 0).toFixed(1)}`);
    } else if (c.type === 'DISTANCE') {
      const p1 = refs[0] && pointWorld(refs[0]); const p2 = refs[1] && pointWorld(refs[1]);
      if (!p1 || !p2) return;
      const a = toScreen(p1, cam, w, h), b = toScreen(p2, cam, w, h);
      if (!a.ok || !b.ok) return;
      lines.push(<line key={`D${ci}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={COLOR} strokeWidth={1.2} strokeDasharray="5 3" />);
      badge(`Dl${ci}`, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 8, ok: true }, `↔${(c.value ?? 0).toFixed(1)}`);
    } else if (c.type === 'ANGLE') {
      const p1 = refs[0] && pointWorld(refs[0]); const p2 = refs[1] && pointWorld(refs[1]);
      if (!p1 || !p2) return;
      const a = toScreen(p1, cam, w, h), b = toScreen(p2, cam, w, h);
      badge(`A${ci}`, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ok: a.ok && b.ok }, `∠${(c.value ?? 0).toFixed(1)}°`);
    } else {
      // Geometric glyph at each operand's representative point.
      refs.forEach((r, k) => {
        const wp = pointWorld(r); if (!wp) return;
        badge(`g${ci}_${k}`, toScreen(wp, cam, w, h), meta.glyph);
      });
    }
  });

  // ── DoF readout ────────────────────────────────────────────────────────────
  const dofText = status
    ? (status.state === 'over' ? 'Over-constrained' : `DoF: ${status.dof}${status.dof === 0 ? ' · fully constrained' : ''}`)
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
