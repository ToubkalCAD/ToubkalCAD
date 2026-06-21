// ============================================================
// ToubkalCAD – solver/PlaneGCSSolverAdapter.ts
//
// ISketchSolver backed by PlaneGCS — the Emscripten/WASM port of FreeCAD's 2D
// geometric constraint solver (@salusoft89/planegcs). Translates ToubkalCAD's
// EntityGeom + SketchConstraint into PlaneGCS's JSON sketch primitives, solves,
// and reads solved params back into EntityGeom — the exact shape
// SketchSolveBridge.rebuildSketchEntity already consumes.
//
// Lifetime: one GcsWrapper (a single reusable GcsSystem) is built in init();
// each solve() calls clear_data() and rebuilds the system from scratch. This
// avoids re-instantiating the WASM module ~60×/s during a live drag.
//
// Point model: PlaneGCS lines/arcs/circles reference SHARED point primitives by
// id (a line is two point ids; an arc is centre + start/end points + angles), so
// we synthesise a point primitive per endpoint/centre with a derived id and map
// each SketchRef onto it — the same Rec/resolvePoint pattern as the SolveSpace
// adapter. FIXED entities (incl. the datum axes) are pinned via point `fixed`.
//
// Drag: the dragged point is seeded AT the cursor and pulled there by a
// `temporary` p2p_coincident to a fixed cursor anchor — PlaneGCS's analogue of
// libslvs setDragged. Temporary constraints yield to the driving (hard)
// constraints, so a constrained point slides only within its remaining DoF.
//
// Non-1:1 mappings (documented inline): COLLINEAR → parallel + point_on_line;
// line↔circle/arc TANGENT uses the kind-specific tangent_* variant; EQUAL maps
// to equal_length (lines) or equal_radius_* (circles/arcs). Unlike libslvs,
// radius IS a symbolic operand here, so tangents/radii are exact (no
// current-radius-as-constant trick needed).
// ============================================================

import type { ISketchSolver } from './ISketchSolver';
import type { EntityGeom, DragPin, SolveResult } from './model';
import type { SketchConstraint, SketchRef } from '../../store/cadStore';
import { loadPlaneGcs, type ModuleStatic } from './planegcs/loadPlaneGcs';
import { GcsWrapper, Algorithm, SolveStatus } from '@salusoft89/planegcs';
import type {
  SketchPrimitive,
  SketchParam,
  SketchPoint,
  SketchCircle,
  SketchArc,
} from '@salusoft89/planegcs';

// Per-entity record kept during one solve — maps an entity to its PlaneGCS
// point ids (and the geom primitive id, which is the entity id itself).
type Rec =
  | { kind: 'line';   a: string; b: string }
  | { kind: 'circle'; c: string }
  | { kind: 'arc';    c: string; start: string; end: string };

const CURSOR_ID = '__cursor__';
const PIN_ID = '__drag_pin__';

export class PlaneGCSSolverAdapter implements ISketchSolver {
  readonly id = 'planegcs';
  private mod: ModuleStatic | null = null;
  private wrapper: GcsWrapper | null = null;

  /** @param wasmUrl explicit WASM URL for the browser bundle (file-loader). */
  constructor(private readonly wasmUrl?: string) {}

  async init(): Promise<void> {
    this.mod = await loadPlaneGcs(this.wasmUrl);
    this.wrapper = new GcsWrapper(new this.mod.GcsSystem());
  }

  solve(geoms: EntityGeom[], constraints: SketchConstraint[], dragPin?: DragPin): SolveResult {
    const w = this.wrapper;
    if (!w) throw new Error('PlaneGCSSolverAdapter.init() not awaited before solve()');
    w.clear_data();

    const geomById = new Map(geoms.map((g) => [g.id, g]));
    // Entities whose params must be FIXED: every operand of a FIXED constraint
    // (datum axes arrive this way via datumFixedConstraints()).
    const fixedIds = new Set<string>();
    for (const c of constraints) if (c.type === 'FIXED' && c.refs[0]) fixedIds.add(c.refs[0].id);

    const prims: (SketchPrimitive | SketchParam)[] = [];
    const recs = new Map<string, Rec>();
    for (const g of geoms) recs.set(g.id, build(prims, g, fixedIds.has(g.id), dragPin));

    // ── helpers bound to this solve ──
    const point = (ref: SketchRef): string | null => resolvePoint(recs, ref);
    const ent = (ref: SketchRef): string => ref.id;        // geom primitive id == entity id
    let k = 0;
    const nextId = () => `__k${k++}`;
    for (const c of constraints) emitConstraint(prims, c, { recs, geomById, point, ent, nextId });

    // ── drag: pull the dragged point toward the cursor (soft, temporary) ──
    if (dragPin) {
      const p = point(dragPin.ref);
      if (p) {
        prims.push({ id: CURSOR_ID, type: 'point', x: dragPin.target[0], y: dragPin.target[1], fixed: true });
        prims.push({ id: PIN_ID, type: 'p2p_coincident', p1_id: p, p2_id: CURSOR_ID, temporary: true });
      }
    }

    w.push_primitives_and_params(prims);
    w.set_max_iterations(100);
    const status = w.solve(Algorithm.LevenbergMarquardt);
    w.apply_solution();

    const solved = new Map(w.sketch_index.get_primitives().map((p) => [p.id, p]));
    const converged = status === SolveStatus.Success || status === SolveStatus.Converged;
    return {
      geoms: readBack(geoms, recs, solved),
      converged,
      residual: converged ? 0 : 1,
      iterations: 0,
    };
  }
}

// ─── entity construction (EntityGeom → PlaneGCS primitives) ─────────────────────

/** Synthesise the point + geometry primitives for one entity, pushing them onto
 *  `prims` (points before the geom they belong to) and returning its Rec. The
 *  dragged point is seeded AT the cursor so the temporary pin starts satisfied. */
function build(prims: (SketchPrimitive | SketchParam)[], g: EntityGeom, fixed: boolean, drag?: DragPin): Rec {
  const seed = (pt: 'a' | 'b' | 'c', dflt: [number, number]): [number, number] =>
    drag && drag.ref.id === g.id && (drag.ref.pt ?? 'a') === pt ? drag.target : dflt;
  const pushPoint = (id: string, xy: [number, number]): SketchPoint => {
    const p: SketchPoint = { id, type: 'point', x: xy[0], y: xy[1], fixed };
    prims.push(p);
    return p;
  };

  if (g.kind === 'line') {
    const a = `${g.id}:a`, b = `${g.id}:b`;
    pushPoint(a, seed('a', g.a));
    pushPoint(b, seed('b', g.b));
    prims.push({ id: g.id, type: 'line', p1_id: a, p2_id: b });
    return { kind: 'line', a, b };
  }
  if (g.kind === 'circle') {
    const c = `${g.id}:c`;
    pushPoint(c, seed('c', g.c));
    prims.push({ id: g.id, type: 'circle', c_id: c, radius: g.r });
    return { kind: 'circle', c };
  }
  // arc: centre + start/end points derived from the sweep angles a1/a2.
  const c = `${g.id}:c`, start = `${g.id}:as`, end = `${g.id}:ae`;
  pushPoint(c, seed('c', g.c));
  pushPoint(start, [g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1)]);
  pushPoint(end, [g.c[0] + g.r * Math.cos(g.a2), g.c[1] + g.r * Math.sin(g.a2)]);
  prims.push({ id: g.id, type: 'arc', c_id: c, radius: g.r, start_id: start, end_id: end, start_angle: g.a1, end_angle: g.a2 });
  // Ties the endpoints to centre+radius+angles so the solver keeps them consistent.
  prims.push({ id: `${g.id}:rules`, type: 'arc_rules', a_id: g.id });
  return { kind: 'arc', c, start, end };
}

// ─── reference resolution ──────────────────────────────────────────────────────

/** SketchRef → the PlaneGCS point id it denotes (line endpoint, circle/arc
 *  centre, arc endpoint), or null. Entity refs to a circle/arc → the centre. */
function resolvePoint(recs: Map<string, Rec>, ref: SketchRef): string | null {
  const r = recs.get(ref.id);
  if (!r) return null;
  if (r.kind === 'line') return ref.pt === 'b' ? r.b : r.a;   // 'a' default
  if (r.kind === 'circle') return r.c;                        // centre
  if (ref.pt === 'a') return r.start;
  if (ref.pt === 'b') return r.end;
  return r.c;                                                 // centre ('c' / entity)
}

// ─── constraint mapping ────────────────────────────────────────────────────────

interface Ctx {
  recs: Map<string, Rec>;
  geomById: Map<string, EntityGeom>;
  point: (ref: SketchRef) => string | null;
  ent: (ref: SketchRef) => string;
  nextId: () => string;
}

const DEG2RAD = Math.PI / 180;

function emitConstraint(prims: (SketchPrimitive | SketchParam)[], c: SketchConstraint, ctx: Ctx): void {
  const { point, ent, geomById, nextId } = ctx;
  const r0 = c.refs[0], r1 = c.refs[1], r2 = c.refs[2];
  const id = nextId();
  const push = (p: SketchPrimitive) => prims.push(p);

  switch (c.type) {
    case 'FIXED': return;                                     // handled via point `fixed`

    case 'COINCIDENT':
    case 'CONCENTRIC': {                                      // centres for circles/arcs
      const a = point(r0), b = point(r1);
      if (a && b) push({ id, type: 'p2p_coincident', p1_id: a, p2_id: b });
      return;
    }
    case 'PARALLEL':      push({ id, type: 'parallel', l1_id: ent(r0), l2_id: ent(r1) }); return;
    case 'PERPENDICULAR': push({ id, type: 'perpendicular_ll', l1_id: ent(r0), l2_id: ent(r1) }); return;
    case 'HORIZONTAL':    push({ id, type: 'horizontal_l', l_id: ent(r0) }); return;
    case 'VERTICAL':      push({ id, type: 'vertical_l', l_id: ent(r0) }); return;

    case 'LENGTH': {
      const a = point({ ...r0, kind: 'point', pt: 'a' }), b = point({ ...r0, kind: 'point', pt: 'b' });
      if (a && b && c.value != null) push({ id, type: 'p2p_distance', p1_id: a, p2_id: b, distance: c.value });
      return;
    }
    case 'RADIUS': {
      if (c.value == null) return;
      const g0 = geomById.get(r0.id);
      if (g0?.kind === 'arc') push({ id, type: 'arc_radius', a_id: ent(r0), radius: c.value });
      else                    push({ id, type: 'circle_radius', c_id: ent(r0), radius: c.value });
      return;
    }
    case 'ANGLE':
      if (c.value != null) push({ id, type: 'l2l_angle_ll', l1_id: ent(r0), l2_id: ent(r1), angle: c.value * DEG2RAD });
      return;

    case 'EQUAL': {
      const g0 = geomById.get(r0.id), g1 = geomById.get(r1.id);
      if (g0?.kind === 'line') { push({ id, type: 'equal_length', l1_id: ent(r0), l2_id: ent(r1) }); return; }
      // radius equality across circle/arc combinations.
      const aArc = g0?.kind === 'arc', bArc = g1?.kind === 'arc';
      if (aArc && bArc)        push({ id, type: 'equal_radius_aa', a1_id: ent(r0), a2_id: ent(r1) });
      else if (!aArc && !bArc) push({ id, type: 'equal_radius_cc', c1_id: ent(r0), c2_id: ent(r1) });
      else                     push({ id, type: 'equal_radius_ca', c1_id: ent(aArc ? r1 : r0), a2_id: ent(aArc ? r0 : r1) });
      return;
    }
    case 'COLLINEAR': {
      // No direct equivalent: parallel + an endpoint of line1 on line0.
      push({ id, type: 'parallel', l1_id: ent(r0), l2_id: ent(r1) });
      const p = point({ ...r1, kind: 'point', pt: 'a' });
      if (p) push({ id: nextId(), type: 'point_on_line_pl', p_id: p, l_id: ent(r0) });
      return;
    }
    case 'DISTANCE': {
      if (c.value == null) return;
      // A line operand is an ENTITY ref onto a line geom; resolvePoint() would
      // collapse it to an endpoint, so detect it and emit a point-to-line
      // distance instead of a wrong point-to-point.
      const r0Line = r0.kind === 'entity' && geomById.get(r0.id)?.kind === 'line';
      const r1Line = r1.kind === 'entity' && geomById.get(r1.id)?.kind === 'line';
      if (r1Line && !r0Line) {
        const p = point(r0);
        if (p) push({ id, type: 'p2l_distance', p_id: p, l_id: ent(r1), distance: c.value });
        return;
      }
      if (r0Line && !r1Line) {
        const p = point(r1);
        if (p) push({ id, type: 'p2l_distance', p_id: p, l_id: ent(r0), distance: c.value });
        return;
      }
      const a = point(r0), b = point(r1);
      if (a && b) push({ id, type: 'p2p_distance', p1_id: a, p2_id: b, distance: c.value });
      return;
    }
    case 'TANGENT': {
      const g0 = geomById.get(r0.id), g1 = geomById.get(r1.id);
      const k0 = g0?.kind, k1 = g1?.kind;
      const isCurve = (k?: string) => k === 'circle' || k === 'arc';
      if (k0 === 'line' || k1 === 'line') {
        const lineRef = k0 === 'line' ? r0 : r1;
        const curveRef = k0 === 'line' ? r1 : r0;
        const curveKind = k0 === 'line' ? k1 : k0;
        if (curveKind === 'arc') push({ id, type: 'tangent_la', l_id: ent(lineRef), a_id: ent(curveRef) });
        else                     push({ id, type: 'tangent_lc', l_id: ent(lineRef), c_id: ent(curveRef) });
      } else if (isCurve(k0) && isCurve(k1)) {
        if (k0 === 'arc' && k1 === 'arc')      push({ id, type: 'tangent_aa', a1_id: ent(r0), a2_id: ent(r1) });
        else if (k0 === 'circle' && k1 === 'circle') push({ id, type: 'tangent_cc', c1_id: ent(r0), c2_id: ent(r1) });
        else push({ id, type: 'tangent_ca', c_id: ent(k0 === 'circle' ? r0 : r1), a_id: ent(k0 === 'arc' ? r0 : r1) });
      }
      return;
    }
    case 'SYMMETRY': {
      const a = point(r0), b = point(r1);
      if (a && b && r2) push({ id, type: 'p2p_symmetric_ppl', p1_id: a, p2_id: b, l_id: ent(r2) });
      return;
    }
  }
}

// ─── read solved params back into EntityGeom ───────────────────────────────────

function readBack(
  geoms: EntityGeom[],
  recs: Map<string, Rec>,
  solved: Map<string, SketchPrimitive | SketchParam>,
): Record<string, EntityGeom> {
  const pt = (id: string): [number, number] | null => {
    const p = solved.get(id);
    return p && p.type === 'point' ? [(p as SketchPoint).x, (p as SketchPoint).y] : null;
  };
  const out: Record<string, EntityGeom> = {};
  for (const g of geoms) {
    const r = recs.get(g.id);
    if (!r) { out[g.id] = g; continue; }
    if (g.kind === 'line' && r.kind === 'line') {
      const a = pt(r.a), b = pt(r.b);
      out[g.id] = a && b ? { id: g.id, kind: 'line', a, b } : g;
    } else if (g.kind === 'circle' && r.kind === 'circle') {
      const c = pt(r.c);
      const cp = solved.get(g.id);
      const radius = cp && cp.type === 'circle' ? (cp as SketchCircle).radius : g.r;
      out[g.id] = c ? { id: g.id, kind: 'circle', c, r: Math.max(1e-4, radius) } : g;
    } else if (g.kind === 'arc' && r.kind === 'arc') {
      const c = pt(r.c);
      const ap = solved.get(g.id);
      const arc = ap && ap.type === 'arc' ? (ap as SketchArc) : null;
      // PlaneGCS arc endpoints are real variables → its solved start/end angles
      // are authoritative (the legacy/SolveSpace adapters keep a1/a2 static).
      out[g.id] = c && arc
        ? { id: g.id, kind: 'arc', c, r: Math.max(1e-4, arc.radius), a1: arc.start_angle, a2: arc.end_angle }
        : g;
    } else {
      out[g.id] = g;
    }
  }
  return out;
}
