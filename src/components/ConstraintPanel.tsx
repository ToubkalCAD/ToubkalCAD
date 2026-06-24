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
import { useCADStore } from '../store/cadStore';
import type { SketchConstraint, SketchConstraintType, SketchRef } from '../store/cadStore';
import {
  canApply, constraintBlocked, computeDoF,
  CONSTRAINT_META, GEOMETRIC_TYPES, DIMENSIONAL_TYPES,
} from '../services/SketchConstraintSolver';
import type { EntityGeom } from '../services/SketchConstraintSolver';
import { datumGeoms, datumLabel, isDatumId } from '../services/SketchDatums';
import { collectSolverGeoms } from '../services/SketchSolveBridge';
import { applySketchConstraints } from '../services/SketchSolve';
import { useDragPanel } from '../hooks/useDragPanel';

const ACCENT = '#1d9e74';

const STATE_COLOR = { under: '#2a86d6', full: '#1d9e74', over: '#cc3a3a', conflict: '#d98a26' } as const;
const STATE_LABEL = { under: 'Under-constrained', full: 'Fully constrained', over: 'Over-constrained', conflict: 'Conflicting constraints' } as const;

export function showConstraintPanel(sketchId: string): void {
  useCADStore.getState().openConstraintPanel(sketchId);
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────
// collectSolverGeoms / rebuildSketchEntity / geomKey live in SketchSolveBridge
// (shared with the live-drag hook). `collectGeoms` aliases the bridge collector.

const collectGeoms = collectSolverGeoms;

/**
 * Sketch entities the variational solver does not yet model (rectangles/polygons/
 * splines stored as sampled polylines, arcs, ellipses). They still occupy real
 * degrees of freedom, so we count them as free rigid bodies — otherwise a sketch
 * holding only a fresh rectangle would falsely report DoF 0 / "Fully constrained".
 */
function unsupportedDoF(sketchId: string): number {
  const st = useCADStore.getState();
  let dof = 0;
  for (const id of st.nodes[sketchId]?.children ?? []) {
    const g = st.nodes[id]?.params?.sketchGeom;
    // Ellipses ARE solver-modelled now (rigid translate-only), so they're counted
    // by computeDoF via collectGeoms — don't double-count them here.
    if (g && g.kind !== 'line' && g.kind !== 'circle' && g.kind !== 'arc' && !(g.kind === 'polyline' && g.ellipse)) dof += 3; // free placement (x,y,θ)
  }
  return dof;
}

function resolvePoint(ref: SketchRef, geoms: EntityGeom[]): [number, number] | null {
  const g = geoms.find((e) => e.id === ref.id);
  if (!g) return null;
  if (g.kind === 'line')   return ref.pt === 'b' ? g.b : g.a;
  if (g.kind === 'circle') return g.c;
  if (g.kind === 'ellipse') return g.c;   // only the centre is a referenceable point
  if (g.kind === 'arc') {
    if (ref.pt === 'a' || ref.pt === 'b') {
      const ang = ref.pt === 'a' ? g.a1 : g.a2;
      return [g.c[0] + g.r * Math.cos(ang), g.c[1] + g.r * Math.sin(ang)];
    }
    return g.c;
  }
  return null;
}

/** Perpendicular distance from a point to the infinite line carrying `line`. */
function perpDistToLine(p: [number, number], line: EntityGeom): number {
  if (line.kind !== 'line') return 0;
  const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1];
  const n = Math.hypot(dx, dy) || 1;
  return Math.abs((p[0] - line.a[0]) * -dy + (p[1] - line.a[1]) * dx) / n;
}

/**
 * The solver models DISTANCE as point↔point or point↔line — never line↔line. A
 * two-line selection (parallel rectangle sides, or a segment + datum axis) is
 * rewritten to point-to-line: the START point of a real sketch line measured to
 * the other line's infinite body. A datum axis has arbitrary endpoints, so it is
 * only ever used as the line operand, never as the point. Non-line selections
 * (already point↔point / point↔line) pass through unchanged.
 */
function normalizeDistanceRefs(sel: SketchRef[], geoms: EntityGeom[]): SketchRef[] {
  const isLineOperand = (r: SketchRef) =>
    r.kind === 'entity' && geoms.find((e) => e.id === r.id)?.kind === 'line';
  if (sel.length !== 2 || !isLineOperand(sel[0]) || !isLineOperand(sel[1]))
    return sel.map((r) => ({ ...r }));
  const ptIdx   = isDatumId(sel[0].id) ? 1 : 0;   // never take the point from a datum axis
  const lineIdx = ptIdx === 0 ? 1 : 0;
  return [
    { kind: 'point',  id: sel[ptIdx].id,   pt: 'a' },
    { kind: 'entity', id: sel[lineIdx].id },
  ];
}

/** Default driving value for a DISTANCE on the given (already-normalized) refs:
 *  perpendicular gap for point↔line, Euclidean for point↔point. */
function distanceSeed(refs: SketchRef[], geoms: EntityGeom[]): number {
  const [a, b] = refs;
  const ga = geoms.find((e) => e.id === a?.id), gb = geoms.find((e) => e.id === b?.id);
  const aLine = a?.kind === 'entity' && ga?.kind === 'line';
  const bLine = b?.kind === 'entity' && gb?.kind === 'line';
  if (bLine && !aLine) { const p = resolvePoint(a, geoms); return p ? perpDistToLine(p, gb!) : 10; }
  if (aLine && !bLine) { const p = resolvePoint(b, geoms); return p ? perpDistToLine(p, ga!) : 10; }
  const p1 = resolvePoint(a, geoms), p2 = resolvePoint(b, geoms);
  return (p1 && p2) ? Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) : 10;
}

/** Stable signature of a constraint set (by id) — for external-change detection. */
const conSig = (cs: SketchConstraint[]): string => cs.map((c) => c.id).sort().join(',');

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
  const hoveredCon    = useCADStore((s) => s.hoveredConstraintId);
  const setHoveredCon = useCADStore((s) => s.setHoveredConstraint);
  const rowRefs       = useRef<Map<string, HTMLDivElement>>(new Map());

  const sketchId = constraintReq?.sketchId ?? null;
  const sketch   = sketchId ? nodes[sketchId] : null;

  const [constraints, setConstraints] = useState<SketchConstraint[]>([]);
  const [valueDraft, setValueDraft]   = useState<Record<string, string>>({});
  const [msg, setMsg]                 = useState<string | null>(null);
  const doCloseRef = useRef<() => void>(() => {});
  // Signature of the constraint set we last wrote/loaded ourselves. The external-
  // removal effect compares against it so it only reacts to changes made OUTSIDE
  // the panel (cascade delete) and never to its own setNodeParams write — without
  // this the effect re-triggers on its own store write and React throws "Maximum
  // update depth exceeded".
  const appliedSigRef = useRef<string>('');

  const { pos, onHandleMouseDown } = useDragPanel(Math.max(20, Math.round(window.innerWidth - 372)), 96);

  // Load persisted constraints + publish initial status.
  useEffect(() => {
    if (!sketchId) return;
    const loaded = migrate(nodes[sketchId]?.params?.constraints as any[]);
    setConstraints(loaded);
    appliedSigRef.current = conSig(loaded);
    publishStatus(loaded, 0, true);
    setMsg(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketchId]);

  const publishStatus = (cs: SketchConstraint[], residual: number, converged: boolean) => {
    if (!sketchId) return;
    const geoms = collectGeoms(sketchId);
    const dof = computeDoF(geoms, cs).dof + unsupportedDoF(sketchId);
    // Over-constrained is a STRUCTURAL property: more constraint equations than
    // DoF (dof < 0). It must NOT be inferred from non-convergence — a solve that
    // lands a hair above tolerance with positive DoF is at worst a numerical
    // CONFLICT, never "over-constrained" (you can't be over-constrained with 4
    // free DoF). Decoupling the two is what fixes the "same constraints read
    // OVER one time, UNDER the next" inconsistency.
    const state: 'under' | 'full' | 'over' | 'conflict' =
      dof < 0 ? 'over' : !converged ? 'conflict' : dof > 0 ? 'under' : 'full';
    useCADStore.getState().setConstraintStatus({ dof, state, residual });
  };

  // ─── Solve + rebuild ─────────────────────────────────────────────────────────
  // Delegates to the shared applySketchConstraints (the one solve/rebuild/propagate
  // path also used by the Smart Dimension tool + the inline label editor). We only
  // add the panel-specific bookkeeping: mark this as our own store write (so the
  // external-removal resync ignores it) and surface the result message.
  const solveAndApply = useCallback((next: SketchConstraint[]) => {
    if (!sketchId) return;
    appliedSigRef.current = conSig(next);   // mark as our own write (see resync effect) BEFORE the store write
    const res = applySketchConstraints(sketchId, next);
    setMsg(res.message);
  }, [sketchId]); // eslint-disable-line react-hooks/exhaustive-deps

  // External-removal resync: when a sketch entity is deleted, the store strips
  // every constraint referencing it (cascading delete). Mirror that into the
  // open panel and re-solve so dangling constraints never linger in the list.
  const storedCons = sketchId ? (nodes[sketchId]?.params?.constraints as any[] | undefined) : undefined;
  useEffect(() => {
    if (!sketchId) return;
    const loaded = migrate(storedCons as any[]);
    const sig = conSig(loaded);
    if (sig === appliedSigRef.current) return;  // our own write (or unchanged) → ignore
    // Genuine external change (cascade delete stripped a dangling constraint):
    // adopt it and re-solve. Record the sig FIRST so the re-solve's write doesn't
    // bounce back through this effect.
    appliedSigRef.current = sig;
    setConstraints(loaded);
    solveAndApply(loaded);
  }, [storedCons]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real entities + selectable datums (Origin/axes) so canApply / value seeding
  // recognise datum operands. DoF accounting elsewhere uses real entities only.
  const geoms = sketchId ? [...collectGeoms(sketchId), ...datumGeoms()] : [];

  // Combined gate: operand shape must match AND no conflict/duplicate with the
  // constraints already on this exact selection.
  const blockedReason = (type: SketchConstraintType): string | null => {
    if (!canApply(type, sel, geoms)) return 'Selection does not match this constraint';
    return constraintBlocked(type, sel, constraints);
  };

  const addConstraint = (type: SketchConstraintType) => {
    if (!sketchId) return;
    const blocked = blockedReason(type);
    if (blocked) { setMsg(blocked); return; }

    // DISTANCE between two lines isn't solver-native — rewrite it to the
    // point-to-line form both solvers support (see normalizeDistanceRefs).
    const refs = type === 'DISTANCE'
      ? normalizeDistanceRefs(sel, geoms)
      : sel.map((r) => ({ ...r }));

    let value: number | undefined;
    const meta = CONSTRAINT_META[type];
    if (meta.hasValue) {
      if (type === 'LENGTH') {
        const g = geoms.find((e) => e.id === refs[0].id);
        if (g?.kind === 'line') value = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
      } else if (type === 'RADIUS') {
        const g = geoms.find((e) => e.id === refs[0].id);
        if (g?.kind === 'circle') value = g.r;
      } else if (type === 'DISTANCE') {
        value = distanceSeed(refs, geoms);
      } else if (type === 'ANGLE') {
        const a = geoms.find((e) => e.id === refs[0].id), b = geoms.find((e) => e.id === refs[1].id);
        if (a?.kind === 'line' && b?.kind === 'line') {
          const u1 = a.b[0] - a.a[0], v1 = a.b[1] - a.a[1];
          const u2 = b.b[0] - b.a[0], v2 = b.b[1] - b.a[1];
          value = Math.abs(Math.atan2(u1 * v2 - v1 * u2, u1 * u2 + v1 * v2) * 180 / Math.PI);
        } else value = 90;
      }
    }

    const c: SketchConstraint = { id: crypto.randomUUID(), type, refs, value };
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

  // Cross-highlight: when a canvas annotation is hovered, scroll its row into view.
  useEffect(() => {
    if (hoveredCon) rowRefs.current.get(hoveredCon)?.scrollIntoView({ block: 'nearest' });
  }, [hoveredCon]);

  if (!constraintReq || !sketch) return null;

  // ── Display helpers ──────────────────────────────────────────────────────────
  const refLabel = (r: SketchRef) => {
    const datum = datumLabel(r);
    if (datum) return datum;
    const name = nodes[r.id]?.name ?? r.id.slice(0, 6);
    return r.kind === 'point' ? `${name}·${r.pt}` : name;
  };

  const st = status;
  const dofColor = st ? STATE_COLOR[st.state] : 'var(--text-muted)';

  // ── Styles ───────────────────────────────────────────────────────────────────
  const opBtn = (type: SketchConstraintType): React.CSSProperties => {
    const ok = blockedReason(type) === null;
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
      {types.map((type) => {
        const reason = blockedReason(type);
        return (
          <button key={type} style={opBtn(type)} disabled={reason !== null}
            title={reason ?? CONSTRAINT_META[type].label}
            onClick={() => { if (reason === null) addConstraint(type); }}>
            <span style={{ fontSize: 13, lineHeight: 1 }}>{CONSTRAINT_META[type].glyph}</span>
            <span style={{ lineHeight: 1.1 }}>{CONSTRAINT_META[type].label}</span>
          </button>
        );
      })}
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
              const lit = hoveredCon === c.id;
              return (
                <div key={c.id}
                  ref={(n) => { if (n) rowRefs.current.set(c.id, n); else rowRefs.current.delete(c.id); }}
                  onMouseEnter={() => setHoveredCon(c.id)}
                  onMouseLeave={() => setHoveredCon(null)}
                  style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: lit ? 'rgba(255,208,0,0.16)' : 'var(--surface-3)',
                  border: `1px solid ${lit ? '#ffd000' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '3px 7px',
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
