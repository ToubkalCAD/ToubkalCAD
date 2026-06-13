// ============================================================
// ToubkalCAD – StableRef.ts   (Phase 1 §6 prototype)
//
// Persistent topological references that survive upstream edits, replacing the
// fragile positional indices (TopExp_Explorer ordinal / edgeIndices / faceIndex)
// that shift whenever any feature is added/removed upstream.
//
// A StableRef is a GEOMETRIC SIGNATURE, not an index: surface/curve kind +
// centre of mass + size (+ axis/radius). To resolve it against a (possibly
// edited) shape we re-explore every face/edge, score each candidate against the
// stored signature, and pick the best — IF it is unambiguous and within
// tolerance. Otherwise we FAIL (null) rather than silently bind to the wrong
// entity. This is intentionally the simplest robust approach (§6 "Phase 1a");
// OCC Generated()/Modified() history threading is a later refinement.
//
// All OCC temporaries go through WasmScope. Capture/resolve return plain JS data.
// ============================================================

import { WasmScope } from '../utils/WasmScope';

export type SurfKind  = 'plane' | 'cylinder' | 'other';
export type CurveKind = 'line'  | 'circle'   | 'other';

export interface FaceSig {
  kind:     'face';
  surf:     SurfKind;
  centroid: [number, number, number];
  area:     number;
  /** plane normal (orientation-aware) or cylinder axis direction. */
  axis?:    [number, number, number];
  radius?:  number;                       // cylinder
}

export interface EdgeSig {
  kind:    'edge';
  curve:   CurveKind;
  mid:     [number, number, number];      // centre of mass of the edge
  length:  number;
  /** line direction or circle axis direction. */
  axis?:   [number, number, number];
  radius?: number;                        // circle
}

export type StableRef = FaceSig | EdgeSig;

export interface ResolveResult {
  index:     number;   // 0-based TopExp_Explorer ordinal in the target shape
  score:     number;   // 0 = perfect match; lower is better
  runnerUp:  number;   // best score of the next candidate (ambiguity margin)
  rejected:  boolean;  // true → no confident match (index is best-effort only)
  reason?:   string;
}

// ─── Tunables (the whole point of the prototype is to MEASURE these) ──────────
const REJECT_SCORE = 0.20;   // best match worse than this → not confident
const AMBIG_MARGIN = 0.06;   // runner-up within this of best → ambiguous → reject
const W = { type: 10, centroid: 1.0, size: 0.5, axis: 0.6, radius: 0.5 };

// ─── small vec helpers ────────────────────────────────────────────────────────
const dist = (a: number[], b: number[]) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
const absDot = (a: number[], b: number[]) => Math.abs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2]);
const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-6);

// ─── Capture ──────────────────────────────────────────────────────────────────

/** Signature of the face at TopExp_Explorer ordinal `faceIndex` (0-based). */
export function captureFace(oc: any, shape: any, faceIndex: number): FaceSig | null {
  const face = nthSub(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, faceIndex, (c: any) => oc.TopoDS.Face_1(c));
  if (!face) return null;
  try { return faceSig(oc, face); } finally { try { face.delete(); } catch {} }
}

/** Signature of the edge at TopExp_Explorer ordinal `edgeIndex` (0-based). */
export function captureEdge(oc: any, shape: any, edgeIndex: number): EdgeSig | null {
  const edge = nthSub(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, edgeIndex, (c: any) => oc.TopoDS.Edge_1(c));
  if (!edge) return null;
  try { return edgeSig(oc, edge); } finally { try { edge.delete(); } catch {} }
}

// ─── Resolve ────────────────────────────────────────────────────────────────

/** Find the face in `shape` that best matches `ref`. */
export function resolveFace(oc: any, shape: any, ref: FaceSig): ResolveResult {
  return resolve(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE,
    (c: any) => oc.TopoDS.Face_1(c),
    (f: any) => faceSig(oc, f),
    (cand: FaceSig) => faceScore(ref, cand));
}

/** Find the edge in `shape` that best matches `ref`. */
export function resolveEdge(oc: any, shape: any, ref: EdgeSig): ResolveResult {
  return resolve(oc, shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    (c: any) => oc.TopoDS.Edge_1(c),
    (e: any) => edgeSig(oc, e),
    (cand: EdgeSig) => edgeScore(ref, cand));
}

// ─── Scoring ────────────────────────────────────────────────────────────────

function faceScore(ref: FaceSig, c: FaceSig): number {
  const scale = Math.max(Math.sqrt(ref.area), 1e-3);   // the face's own size sets the scale
  let s = 0;
  if (ref.surf !== c.surf) s += W.type;
  s += W.centroid * (dist(ref.centroid, c.centroid) / scale);
  s += W.size     * relDiff(ref.area, c.area);
  if (ref.axis && c.axis) s += W.axis * (1 - absDot(ref.axis, c.axis));
  if (ref.radius != null && c.radius != null) s += W.radius * relDiff(ref.radius, c.radius);
  return s;
}

function edgeScore(ref: EdgeSig, c: EdgeSig): number {
  const scale = Math.max(ref.length, 1e-3);
  let s = 0;
  if (ref.curve !== c.curve) s += W.type;
  s += W.centroid * (dist(ref.mid, c.mid) / scale);
  s += W.size     * relDiff(ref.length, c.length);
  if (ref.axis && c.axis) s += W.axis * (1 - absDot(ref.axis, c.axis));
  if (ref.radius != null && c.radius != null) s += W.radius * relDiff(ref.radius, c.radius);
  return s;
}

// ─── Signature builders (OCC) ─────────────────────────────────────────────────

function faceSig(oc: any, face: any): FaceSig {
  const s = new WasmScope();
  try {
    const props = s.keep(new oc.GProp_GProps_1());
    oc.BRepGProp.SurfaceProperties_1(face, props, false, true);
    const area = props.Mass();
    const com  = s.keep(props.CentreOfMass());
    const centroid: [number,number,number] = [com.X(), com.Y(), com.Z()];

    let surf: SurfKind = 'other';
    let axis: [number,number,number] | undefined;
    let radius: number | undefined;

    const surfH = s.keep(oc.BRep_Tool.Surface_2(face));
    if (!surfH.IsNull()) {
      const ad = s.keep(new oc.GeomAdaptor_Surface_2(surfH));
      const t  = ad.GetType();
      const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      if (t === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        surf = 'plane';
        const dir = s.keep(s.keep(s.keep(ad.Plane()).Axis()).Direction());
        axis = [dir.X(), dir.Y(), dir.Z()];
        if (reversed) axis = [-axis[0], -axis[1], -axis[2]];
      } else if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
        surf = 'cylinder';
        const cyl = s.keep(ad.Cylinder());
        const dir = s.keep(s.keep(cyl.Axis()).Direction());
        axis = [dir.X(), dir.Y(), dir.Z()];
        radius = cyl.Radius();
      }
    }
    return { kind: 'face', surf, centroid, area, axis, radius };
  } finally { s.free(); }
}

function edgeSig(oc: any, edge: any): EdgeSig {
  const s = new WasmScope();
  try {
    const props = s.keep(new oc.GProp_GProps_1());
    oc.BRepGProp.LinearProperties(edge, props, false, true);
    const length = props.Mass();
    const com    = s.keep(props.CentreOfMass());
    const mid: [number,number,number] = [com.X(), com.Y(), com.Z()];

    let curve: CurveKind = 'other';
    let axis: [number,number,number] | undefined;
    let radius: number | undefined;

    const ad = s.keep(new oc.BRepAdaptor_Curve_2(edge));
    const t  = ad.GetType();
    if (t === oc.GeomAbs_CurveType.GeomAbs_Line) {
      curve = 'line';
      const dir = s.keep(s.keep(ad.Line()).Direction());
      axis = [dir.X(), dir.Y(), dir.Z()];
    } else if (t === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      curve = 'circle';
      const circ = s.keep(ad.Circle());
      const dir  = s.keep(s.keep(circ.Axis()).Direction());
      axis = [dir.X(), dir.Y(), dir.Z()];
      radius = circ.Radius();
    }
    return { kind: 'edge', curve, mid, length, axis, radius };
  } finally { s.free(); }
}

// ─── Explorer plumbing ────────────────────────────────────────────────────────

/** A DEDUPED, ordered map of a shape's sub-shapes of one kind. Caller .delete()s.
 *  Uses TopTools_IndexedMapOfShape so a shared edge (referenced by two faces) is
 *  counted ONCE — and so the ordinal matches OccFaceService's face indexing (the
 *  face-index-invariant). Raw TopExp_Explorer would double-count shared edges. */
function subMap(oc: any, shape: any, enumType: any): any {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  const exp = new oc.TopExp_Explorer_2(shape, enumType, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) { map.Add(exp.Current()); exp.Next(); }
  exp.delete();
  return map;
}

/** The sub-shape at ordinal `n` (0-based). Caller deletes the returned shape. */
function nthSub(oc: any, shape: any, enumType: any, n: number, cast: (c: any) => any): any | null {
  const map = subMap(oc, shape, enumType);
  const out = (n >= 0 && n < map.Extent()) ? cast(map.FindKey(n + 1)) : null;   // FindKey is 1-based
  map.delete();
  return out;
}

/** Generic best-match resolver over every (deduped) sub-shape of a kind. */
function resolve(
  oc: any, shape: any, enumType: any,
  cast: (c: any) => any,
  sig:  (sub: any) => StableRef,
  score: (cand: any) => number,
): ResolveResult {
  const map = subMap(oc, shape, enumType);
  const n = map.Extent();
  let best = Infinity, bestIdx = -1, second = Infinity;
  for (let i = 1; i <= n; i++) {
    const sub = cast(map.FindKey(i));
    let sc = Infinity;
    try { sc = score(sig(sub)); } catch { /* unscoreable candidate */ } finally { try { sub.delete(); } catch {} }
    if (sc < best) { second = best; best = sc; bestIdx = i - 1; }
    else if (sc < second) { second = sc; }
  }
  map.delete();

  if (bestIdx < 0) return { index: -1, score: Infinity, runnerUp: Infinity, rejected: true, reason: 'no candidates' };
  const ambiguous = (second - best) < AMBIG_MARGIN;
  const tooFar    = best > REJECT_SCORE;
  return {
    index: bestIdx, score: best, runnerUp: second,
    rejected: ambiguous || tooFar,
    reason: tooFar ? 'best match beyond tolerance' : ambiguous ? 'ambiguous (runner-up too close)' : undefined,
  };
}
