// ============================================================
// ToubkalCAD – ProfileNesting.ts
//
// Nested-profile analysis: turn a flat set of coplanar closed wires (the
// regions a sketch encloses) into proper planar FACES WITH HOLES, the way every
// production CAD does it. A circle drawn inside a rectangle must extrude to a
// block WITH A HOLE — not two stacked solids — and the rule has to nest to any
// depth (4 circles in a rectangle → 4 holes; a rectangle inside one of those
// holes → a solid island again).
//
// Strategy (classic even/odd containment forest):
//   1. Make a provisional single-wire TopoDS_Face per input wire and measure its
//      area + grab one boundary probe point.
//   2. Containment is decided geometrically with OpenCascade's own point classifier
//      `BRepClass_FaceClassifier` (TopAbs_IN). Wire j is inside wire i when a point
//      on j's boundary classifies IN face i (profiles are assumed non-self-
//      intersecting, the only valid sketch case). Area gates ties.
//   3. depth(j) = number of wires that contain j. EVEN depth = a solid outer
//      boundary; ODD depth = a hole. Each outer's holes are the odd-depth wires
//      whose *immediate* (smallest-area) container is that outer. A wire nested
//      inside a hole (depth 2) is an outer again → its own solid island.
//   4. Build the final face with `BRepBuilderAPI_MakeFace(outerFace)` then `.Add()`
//      each hole wire with the orientation that actually subtracts it (verified by
//      area), so the inner loop bounds a hole rather than a second outer.
//
// Pure geometry on OCC wires — no store/registry coupling — so the imperative
// (Op3DPanel) and parametric (FeatureEvaluators) extrude paths share one impl.
// The input wires are NOT consumed; the returned faces reference them. Caller
// owns the returned faces (free their wrappers after use).
// ============================================================

import { WasmScope } from '../utils/WasmScope';

interface ProfileInfo {
  wire:  any;                       // input wire (caller-owned)
  index: number;                    // position in the input `wires` array
  face:  any;                       // provisional single-wire face (scope-owned)
  area:  number;                    // face area
  probe: [number, number, number];  // a point on the wire's boundary
}

/**
 * One outer boundary + the inner boundaries that bound holes inside it.
 * `outerIndex` / `holeIndices` point back into the input `wires` array so a
 * caller can map a profile to its source wire ids (e.g. the Profile picker).
 */
export interface NestedProfile {
  outer:       any;
  holes:       any[];
  outerIndex:  number;
  holeIndices: number[];
}

const CLASSIFY_TOL = 1e-6;

/** Planar area of a face (BRepGProp surface mass). 0 if unmeasurable. */
function faceArea(oc: any, face: any): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    return props.Mass();
  } catch {
    return 0;
  } finally {
    props.delete();
  }
}

/** A single 3D point lying on `wire`'s boundary (its first vertex). null if none. */
function wireProbePoint(oc: any, wire: any): [number, number, number] | null {
  const exp = new oc.TopExp_Explorer_2(
    wire, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  try {
    if (!exp.More()) return null;
    const v = oc.TopoDS.Vertex_1(exp.Current());
    const p = oc.BRep_Tool.Pnt(v);
    const out: [number, number, number] = [p.X(), p.Y(), p.Z()];
    p.delete();
    return out;
  } finally {
    exp.delete();
  }
}

/** True if `point` classifies strictly inside `face` (TopAbs_IN). */
function pointInFace(oc: any, face: any, point: [number, number, number]): boolean {
  const scope = new WasmScope();
  try {
    const p   = scope.keep(new oc.gp_Pnt_3(point[0], point[1], point[2]));
    const cls = scope.keep(new oc.BRepClass_FaceClassifier_4(face, p, CLASSIFY_TOL, false, CLASSIFY_TOL));
    return cls.State() === oc.TopAbs_State.TopAbs_IN;
  } catch {
    return false;
  } finally {
    scope.free();
  }
}

/**
 * Construct a planar face = `outerFace` minus each wire in `holes`. Each hole is
 * added with the orientation that genuinely subtracts area (OCC bounds a hole
 * only when the inner wire runs opposite to the outer); we pick per-hole by area
 * so it's robust to whatever orientation the source wire happened to carry.
 * Returns the holed face, or `outerFace` unchanged if no hole could be applied.
 */
function makeFaceWithHoles(oc: any, outerFace: any, outerArea: number, holes: ProfileInfo[]): any {
  if (!holes.length) return outerFace;
  const scope = new WasmScope();
  const mk = new oc.BRepBuilderAPI_MakeFace_2(outerFace);
  try {
    for (const h of holes) {
      // The orientation that subtracts the hole is the one yielding the smaller
      // area when added alone; OCC bounds a hole only when the inner loop runs
      // opposite to the outer. Pick per-hole so it's robust to the source wire's
      // own orientation.
      const reversed = holeIsSubtractedWhenReversed(oc, outerFace, h.wire, outerArea, h.area);
      mk.Add(reversed ? scope.keep(oc.TopoDS.Wire_1(h.wire.Reversed())) : h.wire);
    }
    if (!mk.IsDone()) { mk.delete(); return outerFace; }   // degenerate → solid outer
    const face = mk.Face();
    mk.delete();
    return face;
  } finally {
    scope.free();                                          // reversed-wire wrappers
  }
}

/** Does adding `holeWire` REVERSED subtract its area from `outerFace`? */
function holeIsSubtractedWhenReversed(
  oc: any, outerFace: any, holeWire: any, outerArea: number, holeArea: number,
): boolean {
  const target = outerArea - holeArea;
  const areaWith = (reversed: boolean): number => {
    const scope = new WasmScope();
    const mk = scope.keep(new oc.BRepBuilderAPI_MakeFace_2(outerFace));
    try {
      mk.Add(reversed ? scope.keep(oc.TopoDS.Wire_1(holeWire.Reversed())) : holeWire);
      return mk.IsDone() ? faceArea(oc, scope.keep(mk.Face())) : outerArea;
    } catch {
      return outerArea;
    } finally {
      scope.free();
    }
  };
  // Whichever orientation lands closest to (outer − hole) is the true hole.
  return Math.abs(areaWith(true) - target) <= Math.abs(areaWith(false) - target);
}

/**
 * Group coplanar closed `wires` into nested profiles (outer boundary + holes).
 * Returns one entry per even-depth (solid) region. Wires that can't form a planar
 * face are skipped. Empty input or all-invalid → empty array.
 *
 * `keep` is a WasmScope the caller supplies to own the provisional faces; the
 * returned `outer` faces are allocated in it too, so the caller frees everything
 * by freeing that one scope after the wires have been extruded.
 */
export function classifyNestedProfiles(oc: any, wires: any[], keep: WasmScope): NestedProfile[] {
  // 1. Provisional face + area + probe point per wire.
  const infos: ProfileInfo[] = [];
  for (let w = 0; w < wires.length; w++) {
    const wire = wires[w];
    const fm = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    if (!fm.IsDone()) { fm.delete(); continue; }
    const face  = keep.keep(fm.Face());
    fm.delete();
    const probe = wireProbePoint(oc, wire);
    if (!probe) continue;
    infos.push({ wire, index: w, face, area: faceArea(oc, face), probe });
  }
  if (!infos.length) return [];
  const n = infos.length;

  // 2. Containment matrix: contains[i][j] = wire j lies inside wire i.
  //    Guard with area (a container is strictly larger) so coincident/equal
  //    profiles never claim to contain each other.
  const contains: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (infos[i].area <= infos[j].area + 1e-9) continue;
      contains[i][j] = pointInFace(oc, infos[i].face, infos[j].probe);
    }
  }

  // 3. depth(j) = #containers; immediate parent = smallest-area container.
  const depth  = new Array(n).fill(0);
  const parent = new Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    let bestArea = Infinity;
    for (let i = 0; i < n; i++) {
      if (!contains[i][j]) continue;
      depth[j]++;
      if (infos[i].area < bestArea) { bestArea = infos[i].area; parent[j] = i; }
    }
  }

  // 4. Even depth → solid outer; its holes = odd-depth wires it immediately parents.
  const profiles: NestedProfile[] = [];
  for (let o = 0; o < n; o++) {
    if (depth[o] % 2 !== 0) continue;                       // odd = hole, handled by its outer
    const holes = infos.filter((_, k) => parent[k] === o && depth[k] === depth[o] + 1);
    const outer = makeFaceWithHoles(oc, infos[o].face, infos[o].area, holes);
    if (outer !== infos[o].face) keep.keep(outer);     // new holed face (the no-hole case reuses the kept provisional)
    profiles.push({
      outer,
      holes:       holes.map((h) => h.wire),
      outerIndex:  infos[o].index,
      holeIndices: holes.map((h) => h.index),
    });
  }
  return profiles;
}

/**
 * Convenience: the holed faces (one per solid region) ready to be prismed.
 * Caller must free `keep` after extruding.
 */
export function buildNestedFaces(oc: any, wires: any[], keep: WasmScope): any[] {
  return classifyNestedProfiles(oc, wires, keep).map((p) => p.outer);
}
