// ============================================================
// ToubkalCAD – solver/SolveSpaceSolverAdapter.ts
//
// ISketchSolver backed by SolveSpace's libslvs, compiled to WASM (see
// native/slvs/ + src/services/solver/wasm/). Translates ToubkalCAD's
// EntityGeom + SketchConstraint into a libslvs SketchSystem, solves the active
// group, and reads solved params back into EntityGeom — the exact shape
// SketchSolveBridge.rebuildSketchEntity already consumes.
//
// Group model (matches slvs_shim.cpp):
//   group 1 (fixed)  = datums + FIXED entities — created with fixed=true.
//   group 2 (active) = everything else — moved by solve(2).
// Drag: the dragged point is seeded AT the cursor (created there) and marked
//   via setDragged → libslvs keeps it near the cursor (native minimal-move).
//
// Non-1:1 constraint mappings (documented inline): RADIUS→DIAMETER(2r),
// COLLINEAR→PARALLEL+PT_ON_LINE, line↔circle/arc TANGENT→PT_LINE_DISTANCE=r,
// circle↔circle TANGENT→PT_PT_DISTANCE=r1±r2. These use the CURRENT radius as a
// constant (radius isn't a symbolic operand in libslvs), which is fine here:
// most sketches pin radius separately and the solver's minimal-move holds it.
// ============================================================

import type { ISketchSolver } from './ISketchSolver';
import type { EntityGeom, DragPin, SolveResult } from './model';
import type { SketchConstraint, SketchRef } from '../../store/cadStore';
import { loadSlvs } from './wasm/loadSlvs';
import type { SlvsModule, SketchSystem, EntityRef } from './wasm/loadSlvs';
import { SlvsC, SLVS_GROUP_ACTIVE } from './wasm/slvsConstants';

// Per-entity handle record kept during one solve.
type Rec =
  | { kind: 'line';   h: number; a: EntityRef; b: EntityRef }
  | { kind: 'circle'; h: number; c: EntityRef; radiusParam: number }
  | { kind: 'arc';    h: number; c: EntityRef; start: EntityRef; end: EntityRef };

export class SolveSpaceSolverAdapter implements ISketchSolver {
  readonly id = 'solvespace';
  private mod: SlvsModule | null = null;

  async init(): Promise<void> {
    this.mod = await loadSlvs();
  }

  solve(geoms: EntityGeom[], constraints: SketchConstraint[], dragPin?: DragPin): SolveResult {
    if (!this.mod) throw new Error('SolveSpaceSolverAdapter.init() not awaited before solve()');
    const mod = this.mod;
    const sys = new mod.SketchSystem();
    try {
      const geomById = new Map(geoms.map((g) => [g.id, g]));
      // Entities whose params must be FIXED (group 1): every operand of a FIXED
      // constraint (datum axes arrive this way via datumFixedConstraints()).
      const fixedIds = new Set<string>();
      for (const c of constraints) if (c.type === 'FIXED' && c.refs[0]) fixedIds.add(c.refs[0].id);

      const recs = new Map<string, Rec>();
      for (const g of geoms) recs.set(g.id, build(sys, g, fixedIds.has(g.id), dragPin));

      // ── helpers bound to this solve ──
      const point = (ref: SketchRef): EntityRef | null => resolvePoint(recs, ref);
      const ent   = (ref: SketchRef): number => recs.get(ref.id)?.h ?? 0;
      const addC = (type: number, f: Partial<{
        valA: number; ptA: number; ptB: number; entityA: number; entityB: number;
        entityC: number; entityD: number; other: number; other2: number;
      }>) => sys.addConstraint(
        type, f.valA ?? 0, f.ptA ?? 0, f.ptB ?? 0, f.entityA ?? 0, f.entityB ?? 0,
        f.entityC ?? 0, f.entityD ?? 0, f.other ?? 0, f.other2 ?? 0);

      for (const c of constraints) emitConstraint(c, { recs, geomById, point, ent, addC });

      // ── drag: keep the dragged point near the cursor (it was seeded there) ──
      if (dragPin) {
        const p = point(dragPin.ref);
        if (p) sys.setDragged(p.p0, p.p1);
      }

      const out = sys.solve(SLVS_GROUP_ACTIVE);
      return {
        geoms:      readBack(sys, geoms, recs),
        converged:  out.result === mod.SLVS_RESULT_OKAY,
        residual:   out.result === mod.SLVS_RESULT_OKAY ? 0 : 1,
        iterations: 0,
      };
    } finally {
      sys.delete();
    }
  }
}

// ─── entity construction (EntityGeom → libslvs entities) ───────────────────────

function build(sys: SketchSystem, g: EntityGeom, fixed: boolean, drag?: DragPin): Rec {
  // Seed the dragged point AT the cursor so setDragged biases toward it.
  const seed = (pt: 'a' | 'b' | 'c', dflt: [number, number]): [number, number] =>
    drag && drag.ref.id === g.id && (drag.ref.pt ?? 'a') === pt ? drag.target : dflt;

  if (g.kind === 'line') {
    const a = sys.addPoint2d(...seed('a', g.a), fixed);
    const b = sys.addPoint2d(...seed('b', g.b), fixed);
    return { kind: 'line', h: sys.addLine(a.h, b.h, fixed).h, a, b };
  }
  if (g.kind === 'circle') {
    const c = sys.addPoint2d(...seed('c', g.c), fixed);
    const circ = sys.addCircle(c.h, g.r, fixed);
    return { kind: 'circle', h: circ.h, c, radiusParam: circ.p0 };
  }
  // arc: centre + start/end derived from the static sweep angles a1/a2.
  const c = sys.addPoint2d(...seed('c', g.c), fixed);
  const start = sys.addPoint2d(g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1), fixed);
  const end   = sys.addPoint2d(g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2), fixed);
  return { kind: 'arc', h: sys.addArc(c.h, start.h, end.h, fixed).h, c, start, end };
}

// ─── reference resolution ──────────────────────────────────────────────────────

/** SketchRef → the point EntityRef it denotes (line endpoint, circle/arc centre,
 *  arc endpoint), or null. Entity refs to a circle/arc resolve to the centre. */
function resolvePoint(recs: Map<string, Rec>, ref: SketchRef): EntityRef | null {
  const r = recs.get(ref.id);
  if (!r) return null;
  if (r.kind === 'line') return ref.pt === 'b' ? r.b : r.a;            // 'a' default
  if (r.kind === 'circle') return r.c;                                 // centre
  // arc
  if (ref.pt === 'a') return r.start;
  if (ref.pt === 'b') return r.end;
  return r.c;                                                          // centre ('c' / entity)
}

// ─── constraint mapping ────────────────────────────────────────────────────────

interface Ctx {
  recs: Map<string, Rec>;
  geomById: Map<string, EntityGeom>;
  point: (ref: SketchRef) => EntityRef | null;
  ent: (ref: SketchRef) => number;
  addC: (type: number, f: Record<string, number>) => number;
}

function radiusOf(g: EntityGeom | undefined): number {
  return g && (g.kind === 'circle' || g.kind === 'arc') ? g.r : 0;
}

function emitConstraint(c: SketchConstraint, ctx: Ctx): void {
  const { point, ent, addC, geomById } = ctx;
  const r0 = c.refs[0], r1 = c.refs[1], r2 = c.refs[2];

  switch (c.type) {
    case 'FIXED': return;                                              // handled via group 1

    case 'COINCIDENT': {
      const a = point(r0), b = point(r1);
      if (a && b) addC(SlvsC.POINTS_COINCIDENT, { ptA: a.h, ptB: b.h });
      return;
    }
    case 'CONCENTRIC': {
      const a = point(r0), b = point(r1);                             // centres
      if (a && b) addC(SlvsC.POINTS_COINCIDENT, { ptA: a.h, ptB: b.h });
      return;
    }
    case 'PARALLEL':      addC(SlvsC.PARALLEL,      { entityA: ent(r0), entityB: ent(r1) }); return;
    case 'PERPENDICULAR': addC(SlvsC.PERPENDICULAR, { entityA: ent(r0), entityB: ent(r1) }); return;
    case 'HORIZONTAL':    addC(SlvsC.HORIZONTAL,    { entityA: ent(r0) }); return;
    case 'VERTICAL':      addC(SlvsC.VERTICAL,      { entityA: ent(r0) }); return;

    case 'LENGTH': {
      const a = point({ ...r0, pt: 'a' }), b = point({ ...r0, pt: 'b' });
      if (a && b && c.value != null) addC(SlvsC.PT_PT_DISTANCE, { valA: c.value, ptA: a.h, ptB: b.h });
      return;
    }
    case 'RADIUS':
      if (c.value != null) addC(SlvsC.DIAMETER, { valA: 2 * c.value, entityA: ent(r0) });   // libslvs uses diameter
      return;
    case 'ANGLE':
      if (c.value != null) addC(SlvsC.ANGLE, { valA: c.value, entityA: ent(r0), entityB: ent(r1) }); // degrees
      return;

    case 'EQUAL': {
      const g0 = geomById.get(r0.id);
      if (g0?.kind === 'line') addC(SlvsC.EQUAL_LENGTH_LINES, { entityA: ent(r0), entityB: ent(r1) });
      else                     addC(SlvsC.EQUAL_RADIUS,       { entityA: ent(r0), entityB: ent(r1) });
      return;
    }
    case 'COLLINEAR': {
      // No direct equivalent: parallel + an endpoint of line1 on line0.
      addC(SlvsC.PARALLEL, { entityA: ent(r0), entityB: ent(r1) });
      const p = point({ ...r1, pt: 'a' });
      if (p) addC(SlvsC.PT_ON_LINE, { ptA: p.h, entityA: ent(r0) });
      return;
    }
    case 'DISTANCE': {
      if (c.value == null) return;
      const a = point(r0), b = point(r1);
      if (a && b) { addC(SlvsC.PT_PT_DISTANCE, { valA: c.value, ptA: a.h, ptB: b.h }); return; }
      // point ↔ line
      const pt = a ?? b;
      const lineRef = a ? r1 : r0;
      if (pt) addC(SlvsC.PT_LINE_DISTANCE, { valA: c.value, ptA: pt.h, entityA: ent(lineRef) });
      return;
    }
    case 'TANGENT': {
      const g0 = geomById.get(r0.id), g1 = geomById.get(r1.id);
      const lineRef = g0?.kind === 'line' ? r0 : r1;
      const curveRef = g0?.kind === 'line' ? r1 : r0;
      const curveG = geomById.get(curveRef.id);
      if (g0?.kind === 'line' || g1?.kind === 'line') {
        // line ↔ circle/arc: centre-to-line distance = current radius (constant).
        const centre = point({ kind: 'entity', id: curveRef.id });
        if (centre) addC(SlvsC.PT_LINE_DISTANCE, { valA: radiusOf(curveG), ptA: centre.h, entityA: ent(lineRef) });
      } else {
        // circle ↔ circle: centre distance = r1±r2 (nearer of external/internal).
        const a = point({ kind: 'entity', id: r0.id }), b = point({ kind: 'entity', id: r1.id });
        const ga = geomById.get(r0.id), gb = geomById.get(r1.id);
        if (a && b && ga && gb && (ga.kind !== 'line') && (gb.kind !== 'line')) {
          const ra = radiusOf(ga), rb = radiusOf(gb);
          const d = Math.hypot((ga.c[0]) - (gb.c[0]), (ga.c[1]) - (gb.c[1]));
          const valA = Math.abs(d - (ra + rb)) <= Math.abs(d - Math.abs(ra - rb)) ? ra + rb : Math.abs(ra - rb);
          addC(SlvsC.PT_PT_DISTANCE, { valA, ptA: a.h, ptB: b.h });
        }
      }
      return;
    }
    case 'SYMMETRY': {
      const a = point(r0), b = point(r1);
      if (a && b && r2) addC(SlvsC.SYMMETRIC_LINE, { ptA: a.h, ptB: b.h, entityA: ent(r2) });
      return;
    }
  }
}

// ─── read solved params back into EntityGeom ───────────────────────────────────

function readBack(sys: SketchSystem, geoms: EntityGeom[], recs: Map<string, Rec>): Record<string, EntityGeom> {
  const v = (h: number) => sys.getParamValue(h);
  const out: Record<string, EntityGeom> = {};
  for (const g of geoms) {
    const r = recs.get(g.id);
    if (!r) { out[g.id] = g; continue; }
    if (g.kind === 'line' && r.kind === 'line') {
      out[g.id] = { id: g.id, kind: 'line', a: [v(r.a.p0), v(r.a.p1)], b: [v(r.b.p0), v(r.b.p1)] };
    } else if (g.kind === 'circle' && r.kind === 'circle') {
      out[g.id] = { id: g.id, kind: 'circle', c: [v(r.c.p0), v(r.c.p1)], r: Math.max(1e-4, v(r.radiusParam)) };
    } else if (g.kind === 'arc' && r.kind === 'arc') {
      const cx = v(r.c.p0), cy = v(r.c.p1);
      const rad = Math.max(1e-4, Math.hypot(v(r.start.p0) - cx, v(r.start.p1) - cy));
      // a1/a2 are static in ToubkalCAD's arc model — preserve them.
      out[g.id] = { id: g.id, kind: 'arc', c: [cx, cy], r: rad, a1: g.a1, a2: g.a2 };
    } else {
      out[g.id] = g;
    }
  }
  return out;
}
