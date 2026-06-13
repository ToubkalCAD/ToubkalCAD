// ============================================================
// ToubkalCAD – SketchRegions.ts
//
// Auto-region detection: find the closed loop(s) formed by a sketch's edges
// after trimming/splitting, so each can be turned into an extrudable profile.
//
// Pure 2D in the sketch's local (u,v) plane. Two sources of regions:
//   • self-closed entities — a full circle or a closed polyline (ellipse) is a
//     region on its own.
//   • chains of open edges (lines / arcs / open polylines) that meet end-to-end
//     and enclose an area. Found by planar face-tracing: build the endpoint
//     graph, walk half-edges picking the clockwise-most turn at each vertex —
//     this traces every minimal face; the unbounded outer face comes out with
//     negative signed area and is discarded.
// ============================================================

import type { Pt } from './SketchEdit2D';

export type RegionEntity =
  | { id: string; kind: 'line';     a: Pt; b: Pt }
  | { id: string; kind: 'arc';      c: Pt; r: number; a1: number; a2: number }
  | { id: string; kind: 'circle';   c: Pt; r: number }
  | { id: string; kind: 'polyline'; pts: Pt[] };

export interface RegionMember { id: string; reversed: boolean }
export interface Region { members: RegionMember[]; loop: Pt[]; area: number }

/** Map a node's sketchGeom to a RegionEntity (null for non-curve kinds). */
export function toRegionEntity(id: string, g: any): RegionEntity | null {
  if (g?.kind === 'line')   return { id, kind: 'line',   a: g.a, b: g.b };
  if (g?.kind === 'arc')    return { id, kind: 'arc',    c: g.c, r: g.r, a1: g.a1, a2: g.a2 };
  if (g?.kind === 'circle') return { id, kind: 'circle', c: g.c, r: g.r };
  if (g?.kind === 'polyline' && Array.isArray(g.pts)) return { id, kind: 'polyline', pts: g.pts };
  return null;
}

const VTOL     = 1e-3;   // vertex coincidence tolerance
const MIN_AREA = 1e-4;   // ignore slivers / degenerate faces
const TWO_PI   = 2 * Math.PI;

const arcPt = (c: Pt, r: number, a: number): Pt => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

function sampleArc(c: Pt, r: number, a1: number, a2: number, segs = 32): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= segs; i++) out.push(arcPt(c, r, a1 + ((a2 - a1) * i) / segs));
  return out;
}

/** Shoelace signed area (CCW positive); pts need not repeat the first point. */
function signedArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    s += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return s / 2;
}

const last = (p: Pt[]): Pt => p[p.length - 1];

function isClosedPoly(e: RegionEntity): boolean {
  return e.kind === 'polyline' && e.pts.length > 2 &&
    Math.hypot(e.pts[0][0] - last(e.pts)[0], e.pts[0][1] - last(e.pts)[1]) < VTOL;
}

/** Open endpoints [start, end], or null for self-closed entities. */
function endpoints(e: RegionEntity): [Pt, Pt] | null {
  if (e.kind === 'line') return [e.a, e.b];
  if (e.kind === 'arc')  return [arcPt(e.c, e.r, e.a1), arcPt(e.c, e.r, e.a2)];
  if (e.kind === 'polyline') return e.pts.length >= 2 ? [e.pts[0], last(e.pts)] : null;
  return null; // circle
}

/** Ordered sample points of a member, from its start endpoint to its end. */
function memberPts(e: RegionEntity, reversed: boolean): Pt[] {
  let pts: Pt[];
  if (e.kind === 'line')          pts = [e.a, e.b];
  else if (e.kind === 'polyline') pts = e.pts;
  else if (e.kind === 'arc')      pts = sampleArc(e.c, e.r, e.a1, e.a2);
  else                            pts = sampleArc(e.c, e.r, 0, TWO_PI); // circle
  return reversed ? pts.slice().reverse() : pts;
}

/** Tangent angle leaving an endpoint (fromStart = leaving the first endpoint). */
function leaveAngle(e: RegionEntity, fromStart: boolean): number {
  if (e.kind === 'line') {
    const d: Pt = fromStart ? [e.b[0] - e.a[0], e.b[1] - e.a[1]] : [e.a[0] - e.b[0], e.a[1] - e.b[1]];
    return Math.atan2(d[1], d[0]);
  }
  if (e.kind === 'polyline') {
    const p = e.pts;
    const d: Pt = fromStart
      ? [p[1][0] - p[0][0], p[1][1] - p[0][1]]
      : [p[p.length - 2][0] - last(p)[0], p[p.length - 2][1] - last(p)[1]];
    return Math.atan2(d[1], d[0]);
  }
  if (e.kind === 'arc') {
    // forward = increasing angle (a1→a2): tangent at a1 is a1+π/2;
    // backward from a2 (decreasing angle): tangent is a2−π/2.
    return fromStart ? e.a1 + Math.PI / 2 : e.a2 - Math.PI / 2;
  }
  return 0;
}

export function findRegions(entities: RegionEntity[]): Region[] {
  const regions: Region[] = [];

  // 1. Self-closed entities (circle / closed polyline) are regions on their own.
  for (const e of entities) {
    if (e.kind === 'circle' || isClosedPoly(e)) {
      const loop = memberPts(e, false);
      const area = Math.abs(signedArea(loop));
      if (area > MIN_AREA) regions.push({ members: [{ id: e.id, reversed: false }], loop, area });
    }
  }

  // 2. Planar face-tracing over the open edges.
  const open = entities.filter((e) => e.kind !== 'circle' && !isClosedPoly(e) && endpoints(e) !== null);

  // Merge endpoints by true distance (≤ VTOL), NOT by snapping to a grid: two
  // coincident endpoints that straddle a grid-cell boundary would otherwise get
  // distinct ids, leaving their shared corner un-welded so the face never closes
  // (this is what dropped the arc side of a trimmed circle+rectangle profile).
  const verts: Pt[] = [];
  const getV = (p: Pt): number => {
    for (let i = 0; i < verts.length; i++) {
      if (Math.hypot(verts[i][0] - p[0], verts[i][1] - p[1]) <= VTOL) return i;
    }
    verts.push(p);
    return verts.length - 1;
  };

  interface HE { from: number; to: number; member: RegionMember; angle: number; ent: RegionEntity }
  const he: HE[] = [];
  for (const e of open) {
    const ep = endpoints(e)!;
    const v0 = getV(ep[0]), v1 = getV(ep[1]);
    if (v0 === v1) continue; // zero-length / degenerate
    he.push({ from: v0, to: v1, member: { id: e.id, reversed: false }, angle: leaveAngle(e, true),  ent: e });
    he.push({ from: v1, to: v0, member: { id: e.id, reversed: true  }, angle: leaveAngle(e, false), ent: e });
  }
  const twin = (i: number) => i ^ 1;

  const outAt = new Map<number, number[]>();
  for (let i = 0; i < he.length; i++) {
    const a = outAt.get(he[i].from) ?? [];
    a.push(i); outAt.set(he[i].from, a);
  }
  for (const arr of outAt.values()) arr.sort((x, y) => he[x].angle - he[y].angle);

  // Next half-edge in a face: the clockwise-most turn = the outgoing edge just
  // before the reversed incoming edge in CCW-sorted order.
  const next = (i: number): number => {
    const arr = outAt.get(he[i].to)!;
    const pos = arr.indexOf(twin(i));
    return arr[(pos - 1 + arr.length) % arr.length];
  };

  const visited = new Array(he.length).fill(false);
  for (let i = 0; i < he.length; i++) {
    if (visited[i]) continue;
    const cycle: number[] = [];
    let h = i;
    do {
      if (visited[h]) break;
      visited[h] = true;
      cycle.push(h);
      h = next(h);
    } while (h !== i && cycle.length <= he.length);

    if (h !== i || cycle.length < 2) continue;          // not a clean closed face
    const loop: Pt[] = [];
    for (const k of cycle) for (const p of memberPts(he[k].ent, he[k].member.reversed)) loop.push(p);
    const area = signedArea(loop);
    if (area > MIN_AREA) regions.push({ members: cycle.map((k) => he[k].member), loop, area }); // CCW interior only
  }

  return regions;
}
