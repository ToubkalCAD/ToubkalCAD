// ============================================================
// ToubkalCAD – SketchDragController.ts
//
// The "dragging as a soft constraint" engine. Implements the SketchDragEngine
// seam the store's startDragging/updateDragging/stopDragging actions drive, so
// the store stays free of any solver/OCC import (it only holds drag STATE and
// calls the injected engine — installed once at startup, like installSolver).
//
// The pattern (matches SolveSpace / Fusion live drag):
//   • A drag does NOT mutate entity coordinates directly. Each frame it asks the
//     active ISketchSolver to re-solve with a *drag pin* — a soft objective that
//     biases ONE point toward the cursor (DragPin → soft anchor in the legacy LM
//     solver, setDragged() in SolveSpace). The pin yields to the hard geometric
//     constraints (Horizontal, Radius, …), so a constrained point only slides
//     within its remaining DoF while a free point tracks the cursor exactly.
//   • Seed/initial-guess progression is implicit: every frame re-reads the
//     geometry the *previous* frame solved + persisted (collectSolverGeoms), so
//     frame N seeds from frame N-1 → smooth tracking, no wild jumps.
//   • Grabbing an entity BODY (not a control point) drags the whole shape: the
//     representative point is pinned (line → nearest endpoint, circle/arc →
//     centre) and the entity's seed is rigidly pre-translated by the frame delta
//     so an unconstrained body follows the cursor as a rigid move.
//
// On pointer-up the store calls end(); there is no temporary constraint to tear
// down (the pin lives only for the duration of a single solve() call), so end()
// just runs the downstream recompute once.
// ============================================================

import type { SketchDragEngine } from '../store/cadStore';
import { useCADStore } from '../store/cadStore';
import type { SketchConstraint, SketchRef } from '../store/cadStore';
import type { EntityGeom } from './SketchConstraintSolver';
import { getSolver } from './solver';
import { collectSolverGeoms, collectSketchConstraints, rebuildSketchEntity, geomKey } from './SketchSolveBridge';
import { datumGeoms, datumFixedConstraints, isDatumId } from './SketchDatums';
import { propagateFromStore } from './RecomputeEngine.live';

type Vec2 = [number, number];

const dist2 = (a: Vec2, b: readonly number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Rigidly shift an entity's solver variables by (dx,dy) — used to pre-translate
 *  the grabbed body so the solver seeds from the moved configuration. */
function translateGeom(list: EntityGeom[], id: string, [dx, dy]: Vec2): void {
  const g = list.find((e) => e.id === id);
  if (!g) return;
  if (g.kind === 'line') { g.a = [g.a[0] + dx, g.a[1] + dy]; g.b = [g.b[0] + dx, g.b[1] + dy]; }
  else                   { g.c = [g.c[0] + dx, g.c[1] + dy]; }
}

export class SketchDragController implements SketchDragEngine {
  private sid: string | null = null;
  /** How the grabbed operand maps to solver variables:
   *   'point'     — line endpoint / circle|arc centre → a coordinate pin.
   *   'body'      — whole entity → rigid-translate seed + a coordinate pin.
   *   'arc-angle' — arc endpoint → the arc's parametric sweep angle a1/a2. */
  private mode: 'point' | 'body' | 'arc-angle' = 'point';
  /** The point operand handed to the solver as the drag pin (point/body modes). */
  private pinned: SketchRef | null = null;
  /** cursorLocal − pinnedPoint at grab time, so the grab point stays under the
   *  cursor as the shape moves: pinTarget = cursorLocal − offset. */
  private offset: Vec2 = [0, 0];
  /** Last frame's pin target — the per-frame translation delta is derived from it. */
  private lastTarget: Vec2 = [0, 0];
  /** arc-angle mode: which arc + which endpoint drives which sweep angle. */
  private arcId: string | null = null;
  private arcEnd: 'a' | 'b' = 'a';
  /** Every entity touched across the drag, propagated to dependents on end(). */
  private changed = new Set<string>();

  begin(sketchId: string, origin: SketchRef, grabLocal: Vec2): void {
    this.sid = sketchId;
    this.changed.clear();
    const g = collectSolverGeoms(sketchId).find((e) => e.id === origin.id);

    // Arc endpoint → angular drag. The endpoint isn't a coordinate variable; it's
    // derived from the arc's centre/radius + the parametric sweep angle a1 (start)
    // / a2 (end). We drive that angle from the cursor instead.
    if (origin.kind === 'point' && g?.kind === 'arc' && (origin.pt === 'a' || origin.pt === 'b')) {
      this.mode = 'arc-angle';
      this.arcId = origin.id;
      this.arcEnd = origin.pt;
      this.pinned = null;
      return;
    }

    if (origin.kind === 'point') {
      // Direct control-point drag: pin it, no offset.
      this.mode = 'point';
      this.pinned = origin;
      this.offset = [0, 0];
      this.lastTarget = pointPos(g, origin.pt) ?? grabLocal;
      return;
    }

    // Entity-body drag → pick the representative variable point + grab offset.
    this.mode = 'body';
    if (g?.kind === 'line') {
      const pt: 'a' | 'b' = dist2(grabLocal, g.a) <= dist2(grabLocal, g.b) ? 'a' : 'b';
      const p = pt === 'a' ? g.a : g.b;
      this.pinned = { kind: 'point', id: g.id, pt };
      this.offset = [grabLocal[0] - p[0], grabLocal[1] - p[1]];
      this.lastTarget = [p[0], p[1]];
    } else if (g && (g.kind === 'circle' || g.kind === 'arc')) {
      this.pinned = { kind: 'point', id: g.id, pt: 'c' };
      this.offset = [grabLocal[0] - g.c[0], grabLocal[1] - g.c[1]];
      this.lastTarget = [g.c[0], g.c[1]];
    } else {
      this.pinned = null; // unsupported entity kind — drag is a no-op
    }
  }

  frame(local: Vec2): void {
    if (!this.sid) return;
    if (this.mode === 'arc-angle') { this.frameArcAngle(local); return; }
    if (!this.pinned) return;

    const target: Vec2 = [local[0] - this.offset[0], local[1] - this.offset[1]];
    const delta: Vec2 = [target[0] - this.lastTarget[0], target[1] - this.lastTarget[1]];
    this.lastTarget = target;

    const real = collectSolverGeoms(this.sid);
    if (!real.length) return;

    // Snapshot pre-solve keys so we only rebuild entities that actually moved.
    const beforeKey = new Map(real.map((g) => [g.id, geomKey(g)] as const));
    // Rigidly pre-translate the grabbed body so a FREE shape follows as a unit;
    // a constrained one is corrected back by its hard constraints during solve.
    if (this.mode === 'body') translateGeom(real, this.pinned.id, delta);

    const cons: SketchConstraint[] = [...collectSketchConstraints(this.sid), ...datumFixedConstraints()];
    const res = getSolver().solve([...real, ...datumGeoms()], cons, { ref: this.pinned, target });

    this.applyResult(res.geoms, beforeKey);
  }

  /** Arc-endpoint drag: map the cursor to a parametric angle about the arc's
   *  centre and write it into a1 (start) / a2 (end), then re-solve so the centre
   *  and radius stay pinned to their constraints and any dependents (e.g. a line
   *  tangent to the arc) follow the new sweep. */
  private frameArcAngle(local: Vec2): void {
    const sid = this.sid!;
    const real = collectSolverGeoms(sid);
    const arc = real.find((e) => e.id === this.arcId);
    if (!arc || arc.kind !== 'arc') return;

    const beforeKey = new Map(real.map((g) => [g.id, geomKey(g)] as const));

    const [cx, cy] = arc.c;
    // Cursor → parametric angle about the centre. Normalise about the OPPOSITE
    // (fixed) endpoint so the arc stays CCW with a2 > a1 — the invariant the
    // renderer and createArcEdge share. posmod is continuous as the cursor sweeps
    // (no ±π branch jump); the only discontinuity is at the fixed endpoint, where
    // the sweep wraps through a full turn — the natural "all the way round" edge.
    const raw = Math.atan2(local[1] - cy, local[0] - cx);
    const theta = this.arcEnd === 'a'
      ? arc.a2 - posmod(arc.a2 - raw)        // a1 ∈ (a2 − 2π, a2]
      : arc.a1 + posmod(raw - arc.a1);       // a2 ∈ [a1, a1 + 2π)
    if (this.arcEnd === 'a') arc.a1 = theta; else arc.a2 = theta;

    const cons: SketchConstraint[] = [...collectSketchConstraints(sid), ...datumFixedConstraints()];
    // The on-circle point at the new angle is the pin target: a no-op in the
    // legacy solver (arc endpoints aren't variables — the a1/a2 written above
    // drive the span) but it holds the angle in solvers whose arc endpoints are
    // real points (SolveSpace), keeping centre/radius solve stable.
    const target: Vec2 = [cx + arc.r * Math.cos(theta), cy + arc.r * Math.sin(theta)];
    const pin = { ref: { kind: 'point' as const, id: this.arcId!, pt: this.arcEnd }, target };
    const res = getSolver().solve([...real, ...datumGeoms()], cons, pin);

    this.applyResult(res.geoms, beforeKey);
  }

  /** Persist + redraw every entity whose solved geometry changed this frame. */
  private applyResult(geoms: Record<string, EntityGeom>, beforeKey: Map<string, string>): void {
    for (const g of Object.values(geoms)) {
      if (isDatumId(g.id)) continue;
      if (beforeKey.get(g.id) !== geomKey(g)) { rebuildSketchEntity(g.id, g); this.changed.add(g.id); }
    }
  }

  end(): void {
    if (this.changed.size) propagateFromStore([...this.changed]);
    this.sid = null;
    this.pinned = null;
    this.mode = 'point';
    this.arcId = null;
    this.changed.clear();
  }
}

/** Positive modulo into [0, 2π) — used to normalise an arc sweep to CCW. */
function posmod(x: number): number {
  const TWO_PI = 2 * Math.PI;
  return ((x % TWO_PI) + TWO_PI) % TWO_PI;
}

/** Local-2D coords of a point operand on a freshly-collected geom, or null. */
function pointPos(g: EntityGeom | undefined, pt?: 'a' | 'b' | 'c'): Vec2 | null {
  if (!g) return null;
  if (g.kind === 'line') return pt === 'b' ? [...g.b] : [...g.a];
  if (g.kind === 'circle') return [...g.c];
  // arc: derive endpoints from centre + sweep; centre for 'c'.
  if (pt === 'a') return [g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1)];
  if (pt === 'b') return [g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2)];
  return [...g.c];
}
