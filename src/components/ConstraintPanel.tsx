// ============================================================
// ToubkalCAD – ConstraintPanel.tsx
//
// Phase 8 – Parametric 2D constraint editor (extended set).
//
// Store-driven (constraintReq). Entity/point picking is handled by
// useCADConstraintPick (CONSTRAIN mode); this panel groups the
// available constraints (Geometric · Dimensional), edits driving
// dimensions, runs a live re-solve (SketchConstraintSolver), rebuilds
// the affected OCC wires, and reports degrees of freedom.
//
// Constraints persist on the sketch container node (params.constraints).
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import type { SketchConstraint, SketchConstraintType, SketchRef, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccSketchService, workplaneBasis, fromLocal2D } from '../services/OccSketchService';
import {
  solveConstraints, canApply, computeDoF,
  CONSTRAINT_META, GEOMETRIC_TYPES, DIMENSIONAL_TYPES,
} from '../services/SketchConstraintSolver';
import type { EntityGeom } from '../services/SketchConstraintSolver';
import { useDragPanel } from '../hooks/useDragPanel';

const reg = CADGeometryRegistry.getInstance();
const ACCENT = '#1d9e74';

const STATE_COLOR = { under: '#2a86d6', full: '#1d9e74', over: '#cc3a3a' } as const;
const STATE_LABEL = { under: 'Under-constrained', full: 'Fully constrained', over: 'Over-constrained' } as const;

export function showConstraintPanel(sketchId: string): void {
  useCADStore.getState().openConstraintPanel(sketchId);
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function collectGeoms(sketchId: string): EntityGeom[] {
  const st = useCADStore.getState();
  const out: EntityGeom[] = [];
  for (const id of st.nodes[sketchId]?.children ?? []) {
    const g = st.nodes[id]?.params?.sketchGeom;
    if (!g) continue;
    if (g.kind === 'line')   out.push({ id, kind: 'line',   a: [g.a[0], g.a[1]], b: [g.b[0], g.b[1]] });
    if (g.kind === 'circle') out.push({ id, kind: 'circle', c: [g.c[0], g.c[1]], r: g.r });
  }
  return out;
}

function resolvePoint(ref: SketchRef, geoms: EntityGeom[]): [number, number] | null {
  const g = geoms.find((e) => e.id === ref.id);
  if (!g) return null;
  if (g.kind === 'line')   return ref.pt === 'b' ? g.b : g.a;
  if (g.kind === 'circle') return g.c;
  return null;
}

function sampleCircle(center: THREE.Vector3, r: number, wp: Workplane, segs = 72): number[][] {
  const { uAxis, vAxis } = workplaneBasis(wp);
  return Array.from({ length: segs + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / segs;
    const p = center.clone().addScaledVector(uAxis, r * Math.cos(a)).addScaledVector(vAxis, r * Math.sin(a));
    return [p.x, p.y, p.z];
  });
}

function rebuildEntity(id: string, g: EntityGeom): void {
  const st = useCADStore.getState();
  const wp = st.nodes[id]?.params?.workplane as Workplane | undefined;
  if (!wp || !window.oc) return;
  const oc = window.oc;
  let wire: any; let pts: number[][];
  if (g.kind === 'line') {
    const a3 = fromLocal2D(g.a[0], g.a[1], wp);
    const b3 = fromLocal2D(g.b[0], g.b[1], wp);
    wire = OccSketchService.createClosedWireFromEdges(oc, [OccSketchService.createLineEdge(oc, a3, b3)]);
    pts  = [[a3.x, a3.y, a3.z], [b3.x, b3.y, b3.z]];
  } else {
    const c3  = fromLocal2D(g.c[0], g.c[1], wp);
    const rim = fromLocal2D(g.c[0] + g.r, g.c[1], wp);
    wire = OccSketchService.createCircleWire(oc, c3, rim, wp);
    pts  = sampleCircle(c3, g.r, wp);
  }
  reg.registerShape(id, wire);
  st.setNodeParams(id, { sketchGeom: g });
  window.dispatchEvent(new CustomEvent('cad-sketch-replace-visual', { detail: { id, pts } }));
}

const geomKey = (g: EntityGeom) =>
  g.kind === 'line' ? `${g.a[0]},${g.a[1]},${g.b[0]},${g.b[1]}` : `${g.c[0]},${g.c[1]},${g.r}`;

/** Normalise legacy {entityIds} constraints → {refs}. */
function migrate(stored: any[]): SketchConstraint[] {
  return (stored ?? []).map((c) => {
    if (c.refs) return { ...c };
    const refs: SketchRef[] = (c.entityIds ?? []).map((id: string) => ({ kind: 'entity', id }));
    return { id: c.id, type: c.type, refs, value: c.value };
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export const ConstraintPanel: React.FC = () => {
  const constraintReq = useCADStore((s) => s.constraintReq);
  const sel           = useCADStore((s) => s.constraintSel);
  const nodes         = useCADStore((s) => s.nodes);
  const status        = useCADStore((s) => s.constraintStatus);
  const closePanel    = useCADStore((s) => s.closeConstraintPanel);
  const clearSel      = useCADStore((s) => s.clearConstraintSel);

  const sketchId = constraintReq?.sketchId ?? null;
  const sketch   = sketchId ? nodes[sketchId] : null;

  const [constraints, setConstraints] = useState<SketchConstraint[]>([]);
  const [valueDraft, setValueDraft]   = useState<Record<string, string>>({});
  const [msg, setMsg]                 = useState<string | null>(null);
  const doCloseRef = useRef<() => void>(() => {});

  const { pos, onHandleMouseDown } = useDragPanel(Math.max(20, Math.round(window.innerWidth - 372)), 96);

  // Load persisted constraints + publish initial status.
  useEffect(() => {
    if (!sketchId) return;
    const loaded = migrate(nodes[sketchId]?.params?.constraints as any[]);
    setConstraints(loaded);
    publishStatus(loaded, 0, true);
    setMsg(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketchId]);

  const publishStatus = (cs: SketchConstraint[], residual: number, converged: boolean) => {
    if (!sketchId) return;
    const geoms = collectGeoms(sketchId);
    const { dof } = computeDoF(geoms, cs);
    const state: 'under' | 'full' | 'over' =
      !converged ? 'over' : dof > 0 ? 'under' : 'full';
    useCADStore.getState().setConstraintStatus({ dof, state, residual });
  };

  // ─── Solve + rebuild ─────────────────────────────────────────────────────────
  const solveAndApply = useCallback((next: SketchConstraint[]) => {
    if (!sketchId) return;
    const before = collectGeoms(sketchId);
    if (!before.length) { setMsg('No constrainable Line/Circle entities yet.'); return; }
    const beforeKey = new Map(before.map((g) => [g.id, geomKey(g)]));
    try {
      const res = solveConstraints(before, next);
      let rebuilt = 0;
      for (const g of Object.values(res.geoms)) {
        if (beforeKey.get(g.id) !== geomKey(g)) { rebuildEntity(g.id, g); rebuilt++; }
      }
      useCADStore.getState().setNodeParams(sketchId, { constraints: next });
      publishStatus(next, res.residual, res.converged);
      setMsg(res.converged
        ? `Solved · ${rebuilt} updated`
        : `⚠ Could not satisfy all — residual ${res.residual.toFixed(3)}`);
    } catch (e: any) {
      setMsg(`Solve failed: ${e?.message ?? e}`);
    }
  }, [sketchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const geoms = sketchId ? collectGeoms(sketchId) : [];

  const addConstraint = (type: SketchConstraintType) => {
    if (!sketchId) return;
    if (!canApply(type, sel, geoms)) { setMsg('Selection does not match this constraint.'); return; }

    let value: number | undefined;
    const meta = CONSTRAINT_META[type];
    if (meta.hasValue) {
      if (type === 'LENGTH') {
        const g = geoms.find((e) => e.id === sel[0].id);
        if (g?.kind === 'line') value = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
      } else if (type === 'RADIUS') {
        const g = geoms.find((e) => e.id === sel[0].id);
        if (g?.kind === 'circle') value = g.r;
      } else if (type === 'DISTANCE') {
        const p1 = resolvePoint(sel[0], geoms), p2 = resolvePoint(sel[1], geoms);
        value = (p1 && p2) ? Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) : 10;
      } else if (type === 'ANGLE') {
        const a = geoms.find((e) => e.id === sel[0].id), b = geoms.find((e) => e.id === sel[1].id);
        if (a?.kind === 'line' && b?.kind === 'line') {
          const u1 = a.b[0] - a.a[0], v1 = a.b[1] - a.a[1];
          const u2 = b.b[0] - b.a[0], v2 = b.b[1] - b.a[1];
          value = Math.abs(Math.atan2(u1 * v2 - v1 * u2, u1 * u2 + v1 * v2) * 180 / Math.PI);
        } else value = 90;
      }
    }

    const c: SketchConstraint = { id: crypto.randomUUID(), type, refs: sel.map((r) => ({ ...r })), value };
    const next = [...constraints, c];
    setConstraints(next);
    clearSel();
    solveAndApply(next);
  };

  const removeConstraint = (cid: string) => {
    const next = constraints.filter((c) => c.id !== cid);
    setConstraints(next);
    solveAndApply(next);
  };

  const commitValue = (cid: string) => {
    const raw = valueDraft[cid];
    if (raw == null) return;
    const v = parseFloat(raw);
    setValueDraft((d) => { const n = { ...d }; delete n[cid]; return n; });
    if (!Number.isFinite(v)) return;
    const next = constraints.map((c) => (c.id === cid ? { ...c, value: v } : c));
    setConstraints(next);
    solveAndApply(next);
  };

  // Esc closes
  useEffect(() => {
    if (!constraintReq) return;
    let armed = false;
    const t = setTimeout(() => { armed = true; }, 250);
    const h = (e: KeyboardEvent) => { if (armed && e.key === 'Escape') { e.preventDefault(); doCloseRef.current(); } };
    window.addEventListener('keydown', h, true);
    return () => { clearTimeout(t); window.removeEventListener('keydown', h, true); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constraintReq]);

  doCloseRef.current = () => { clearSel(); closePanel(); };

  if (!constraintReq || !sketch) return null;

  // ── Display helpers ──────────────────────────────────────────────────────────
  const refLabel = (r: SketchRef) => {
    const name = nodes[r.id]?.name ?? r.id.slice(0, 6);
    return r.kind === 'point' ? `${name}·${r.pt}` : name;
  };

  const st = status;
  const dofColor = st ? STATE_COLOR[st.state] : 'var(--text-muted)';

  // ── Styles ───────────────────────────────────────────────────────────────────
  const opBtn = (type: SketchConstraintType): React.CSSProperties => {
    const ok = canApply(type, sel, geoms);
    return {
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
      width: 52, padding: '5px 0', fontSize: 9, cursor: ok ? 'pointer' : 'not-allowed',
      border: `1px solid ${ok ? ACCENT : 'var(--border)'}`, borderRadius: 'var(--radius-sm)',
      background: ok ? 'rgba(29,158,116,0.14)' : 'var(--surface-2)',
      color: ok ? 'var(--text-primary)' : 'var(--text-muted)', opacity: ok ? 1 : 0.5,
    };
  };
  const chip = (label: string, isPt: boolean): React.CSSProperties => ({
    fontSize: 10, color: '#fff', background: isPt ? '#9a5bd0' : '#b06a2a', borderRadius: 3,
    padding: '2px 7px', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
  });

  const btnGroup = (types: SketchConstraintType[]) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {types.map((type) => (
        <button key={type} style={opBtn(type)} title={CONSTRAINT_META[type].label}
          onClick={() => canApply(type, sel, geoms) && addConstraint(type)}>
          <span style={{ fontSize: 13, lineHeight: 1 }}>{CONSTRAINT_META[type].glyph}</span>
          <span style={{ lineHeight: 1.1 }}>{CONSTRAINT_META[type].label}</span>
        </button>
      ))}
    </div>
  );

  return createPortal(
    <div style={{
      position: 'fixed', top: pos.y, left: pos.x, zIndex: 9000, width: 350,
      background: 'var(--surface-2)', border: `1px solid ${ACCENT}`,
      borderRadius: 'var(--radius-md)', boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
      overflow: 'hidden', userSelect: 'none',
    }}>
      {/* Header */}
      <div onMouseDown={onHandleMouseDown} style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border)', cursor: 'move',
        background: 'var(--surface-1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 15 }}>⟂</span>
          <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)' }}>Constraints</span>
          <span style={{ fontSize: 9, color: ACCENT, background: 'var(--surface-3)', borderRadius: 3, padding: '1px 6px', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sketch.name}
          </span>
        </div>
        {/* DoF / status badge */}
        <span style={{ fontSize: 9, color: '#fff', background: dofColor, borderRadius: 3, padding: '2px 7px', fontWeight: 700, whiteSpace: 'nowrap' }}>
          {st ? `${st.state === 'over' ? 'OVER' : `DoF ${st.dof}`}` : 'DoF —'}
        </span>
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Status line */}
        <div style={{
          fontSize: 10, color: dofColor, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dofColor, display: 'inline-block' }} />
          {st ? STATE_LABEL[st.state] : 'Pick entities to begin'}
        </div>

        {/* Pick status + chips */}
        <div style={{
          fontSize: 11, color: sel.length ? 'var(--text-muted)' : ACCENT, fontWeight: sel.length ? 400 : 700,
          background: 'var(--surface-3)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', padding: '6px 10px',
        }}>
          {sel.length === 0
            ? 'Click sketch lines/circles — or their endpoints/centers — in the viewport'
            : `Picked ${sel.length} · choose a constraint`}
        </div>
        {sel.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {sel.map((r, i) => <span key={i} style={chip(refLabel(r), r.kind === 'point')}>{refLabel(r)}</span>)}
            <button onClick={clearSel} style={{
              padding: '2px 8px', fontSize: 9, cursor: 'pointer', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', background: 'var(--surface-3)', color: 'var(--text-dim)',
            }}>Clear</button>
          </div>
        )}

        {/* Geometric */}
        <div>
          <div style={grpLabel}>Geometric</div>
          {btnGroup(GEOMETRIC_TYPES)}
        </div>
        {/* Dimensional */}
        <div>
          <div style={grpLabel}>Dimensional</div>
          {btnGroup(DIMENSIONAL_TYPES)}
        </div>

        {/* Applied list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={grpLabel}>Applied ({constraints.length})</div>
          {constraints.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>None yet.</div>
          )}
          <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {constraints.map((c) => {
              const meta = CONSTRAINT_META[c.type];
              return (
                <div key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface-3)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '3px 7px',
                }}>
                  <span style={{ fontSize: 12, width: 16, textAlign: 'center', color: ACCENT }}>{meta.glyph}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {meta.label} · {c.refs.map(refLabel).join(', ')}
                  </span>
                  {meta.hasValue && (
                    <input
                      type="number" step="any"
                      value={valueDraft[c.id] ?? (c.value != null ? c.value.toFixed(c.type === 'ANGLE' ? 1 : 2) : '')}
                      onChange={(e) => setValueDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.nativeEvent.stopImmediatePropagation(); e.preventDefault(); commitValue(c.id); (e.target as HTMLInputElement).blur(); } }}
                      onBlur={() => commitValue(c.id)}
                      style={{ width: 50, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 3, color: ACCENT, padding: '2px 4px', fontSize: 10, fontFamily: 'monospace', textAlign: 'right', outline: 'none' }}
                    />
                  )}
                  {meta.hasValue && <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 14 }}>{c.type === 'ANGLE' ? '°' : 'mm'}</span>}
                  <button onClick={() => removeConstraint(c.id)} title="Remove" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}>✕</button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {msg && (
        <div style={{
          margin: '0 14px 8px', padding: '5px 9px',
          background: msg.startsWith('⚠') || msg.startsWith('Solve') || msg.startsWith('Selection') ? 'rgba(220,140,40,0.12)' : 'rgba(40,160,110,0.12)',
          border: `1px solid ${msg.startsWith('⚠') || msg.startsWith('Solve') || msg.startsWith('Selection') ? 'rgba(220,140,40,0.4)' : 'rgba(40,160,110,0.4)'}`,
          borderRadius: 'var(--radius-sm)', fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5,
        }}>{msg}</div>
      )}

      <div style={{ padding: '8px 14px 10px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginRight: 'auto' }}>Esc Close · Drag header</span>
        <button onClick={() => doCloseRef.current()} style={{
          padding: '4px 16px', background: ACCENT, border: 'none', borderRadius: 'var(--radius-sm)',
          color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700,
        }}>Done ✓</button>
      </div>
    </div>,
    document.body,
  );
};

const grpLabel: React.CSSProperties = {
  fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.6px', marginBottom: 5,
};
