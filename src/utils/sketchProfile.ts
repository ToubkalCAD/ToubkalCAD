// ============================================================
// ToubkalCAD – sketchProfile.ts
//
// Resolve a single closed PROFILE wire to extrude/revolve from a sketch. A
// sketch drawn as several separate edges (trimmed lines/arcs) has no single
// closed wire, so we detect the enclosed region (SketchRegions) and build one,
// registering it as a "Region" sketch_wire node. A sketch that is already a
// single closed wire is used as-is. Returns the wire-node id, or null if the
// sketch encloses no region.
//
// Shared by the tree context menu and the ribbon so both extrude paths behave
// identically.
// ============================================================

import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccSketchService } from '../services/OccSketchService';
import { findRegions, toRegionEntity, RegionEntity } from '../services/SketchRegions';

/**
 * Build (but DON'T register) the CURRENT profile wire of a sketch from its live
 * child entities — the largest enclosed closed region, the same choice the
 * sketchWire region evaluator makes. The returned wire is a temporary the CALLER
 * owns (`.delete()` it after use). Returns null if the sketch has no detectable
 * closed profile.
 *
 * This is the key to making a feature bound to a SKETCH (not a transient entity
 * wire) re-derive its profile from whatever the sketch contains NOW — so moving,
 * resizing, deleting OR replacing entities (rectangle → polygon) all reshape the
 * downstream loft/extrude on the next recompute instead of dangling a freed shape.
 */
export function buildSketchProfileWire(oc: any, sketchId: string): any | null {
  if (!oc) return null;
  const st = useCADStore.getState();
  const sketch = st.nodes[sketchId];
  if (!sketch || sketch.type !== 'sketch') return null;
  const wp = sketch.params?.workplane as Workplane | undefined;
  if (!wp) return null;
  const childIds = Object.values(st.nodes)
    .filter((n) => n.parentId === sketchId && n.type === 'sketch_wire' && n.params?.sketchGeom)
    .map((n) => n.id);
  if (!childIds.length) return null;
  const ents = childIds
    .map((id) => toRegionEntity(id, st.nodes[id]?.params?.sketchGeom))
    .filter((e): e is RegionEntity => !!e);
  const regions = findRegions(ents);
  if (!regions.length) return null;
  const rg = regions.reduce((a, b) => (b.area > a.area ? b : a)); // largest enclosed region
  const geomOf = (id: string) => useCADStore.getState().nodes[id]?.params?.sketchGeom;
  return OccSketchService.buildRegionProfileWire(oc, rg, geomOf, wp).wire;
}

/**
 * Resolve a feature's profile-target id to a live OCC wire shape, transparently
 * handling both bindings:
 *   • a SKETCH container  → builds its current profile (temp: true — free it).
 *   • a sketch_wire / any registered shape → the registered shape (temp: false).
 * Centralised so the imperative path (Op3DPanel.computeShape) and the parametric
 * engine agree on how a target becomes geometry.
 */
export function profileShapeFor(oc: any, id: string): { shape: any | null; temp: boolean } {
  const node = useCADStore.getState().nodes[id];
  if (node?.type === 'sketch') return { shape: buildSketchProfileWire(oc, id), temp: true };
  return { shape: CADGeometryRegistry.getInstance().getShape(id) ?? null, temp: false };
}

/**
 * Self-heal a 3D op's profile targets to STABLE sketch-container ids, persisting
 * the result. Fixes lofts/extrudes created before profiles were bound to sketches
 * (or where a wire leaf was picked), so they survive a sketch edit instead of
 * dangling a freed entity-wire shape ("not in WASM registry"). Rules, per stored
 * target:
 *   • a sketch container          → kept.
 *   • a SINGLE-profile sketch_wire → rebound to its parent sketch (so it re-derives;
 *     a wire whose sketch contributes >1 target is multi-region → kept as-is).
 *   • a MISSING/deleted target     → recovered from the op's adopted child sketches
 *     (in order), the authoritative profile sources nested under the op.
 * Returns the healed id list (unchanged input → same list, no write).
 */
export function healOpProfileTargets(opNodeId: string): string[] {
  const st = useCADStore.getState();
  const op = st.nodes[opNodeId];
  if (!op) return [];
  const stored = (op.params?.targetWireIds as string[] | undefined) ?? [];
  if (!stored.length) return stored;

  // How many stored targets resolve to each parent sketch → tells single-profile
  // (rebind to sketch) apart from multi-region (keep the per-region wires).
  const parentOf = (id: string): string | null => {
    const n = st.nodes[id];
    if (n?.type === 'sketch') return id;
    if (n?.type === 'sketch_wire' && n.parentId && st.nodes[n.parentId]?.type === 'sketch') return n.parentId;
    return null;
  };
  const parentCount = new Map<string, number>();
  const covered = new Set<string>();
  for (const t of stored) {
    const par = parentOf(t);
    if (par) { parentCount.set(par, (parentCount.get(par) ?? 0) + 1); covered.add(par); }
  }
  // Adopted child sketch containers not already covered → recovery pool for misses.
  const pool = (op.children ?? []).filter((id) => st.nodes[id]?.type === 'sketch' && !covered.has(id));

  const healed: string[] = [];
  for (const t of stored) {
    const n = st.nodes[t];
    if (!n) { const repl = pool.shift(); if (repl) healed.push(repl); continue; } // missing → recover
    if (n.type === 'sketch') { healed.push(t); continue; }
    if (n.type === 'sketch_wire') {
      const par = parentOf(t);
      if (par && (parentCount.get(par) ?? 0) === 1) { healed.push(par); continue; } // single profile → bind to sketch
      healed.push(t); continue;                                                      // multi-region / bare wire → keep
    }
    healed.push(t);
  }

  const changed = healed.length !== stored.length || healed.some((id, i) => id !== stored[i]);
  if (changed) st.setNodeParams(opNodeId, { targetWireIds: healed });
  return healed;
}

/** How many distinct closed regions a sketch's live entities enclose. 0 = no
 *  profile, 1 = single profile (bind the op to the sketch and re-derive it),
 *  >1 = Multi-Pad (extrude each region as its own profile wire). */
export function sketchRegionCount(sketchId: string): number {
  const st = useCADStore.getState();
  const sketch = st.nodes[sketchId];
  if (!sketch || sketch.type !== 'sketch') return 0;
  const childIds = Object.values(st.nodes)
    .filter((n) => n.parentId === sketchId && n.type === 'sketch_wire' && n.params?.sketchGeom)
    .map((n) => n.id);
  const ents = childIds
    .map((id) => toRegionEntity(id, st.nodes[id]?.params?.sketchGeom))
    .filter((e): e is RegionEntity => !!e);
  return findRegions(ents).length;
}

/** True if `id` names something we can turn into a profile wire right now — a
 *  registered wire shape, or a sketch container with a detectable closed region. */
export function canResolveProfile(oc: any, id: string): boolean {
  const node = useCADStore.getState().nodes[id];
  if (node?.type === 'sketch') {
    const w = buildSketchProfileWire(oc, id);
    if (w) { try { w.delete(); } catch { /* noop */ } return true; }
    return false;
  }
  return !!CADGeometryRegistry.getInstance().getShape(id);
}

export function resolveProfileWire(sketchId: string, childIds: string[]): string | null {
  const oc = window.oc;
  if (!oc) return null;
  const st = useCADStore.getState();
  const reg = CADGeometryRegistry.getInstance();

  // Already a single closed wire (circle/rect/closed loop) → use it directly.
  if (childIds.length === 1) {
    const w = reg.getShape(childIds[0]);
    if (w && OccSketchService.wireMakesFace(oc, w)) return childIds[0];
  }

  const ents = childIds
    .map((id) => toRegionEntity(id, st.nodes[id]?.params?.sketchGeom))
    .filter((e): e is RegionEntity => !!e);
  const regions = findRegions(ents);
  if (!regions.length) return null;

  const rg = regions.reduce((a, b) => (b.area > a.area ? b : a)); // largest enclosed region
  const wp = st.nodes[childIds[0]]?.params?.workplane;
  const geomOf = (id: string) => useCADStore.getState().nodes[id]?.params?.sketchGeom;
  const { wire } = OccSketchService.buildRegionProfileWire(oc, rg, geomOf, wp);

  const id = crypto.randomUUID();
  reg.registerShape(id, wire);
  st.addNode({
    id, name: 'Region', type: 'sketch_wire',
    visible: true, locked: false, parentId: sketchId, notes: '',
    transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    material:  { color: 0x00aa66, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
    params: { workplane: wp, region: true, memberIds: rg.members.map((m) => m.id) },
  });
  return id;
}

/**
 * Like resolveProfileWire, but returns EVERY enclosed region's profile wire
 * (Multi-Pad / E7). A single already-closed wire short-circuits to itself; a
 * multi-region sketch yields one "Region N" sketch_wire per region.
 */
export function resolveAllProfileWires(sketchId: string, childIds: string[]): string[] {
  const oc = window.oc;
  if (!oc) return [];
  const st = useCADStore.getState();
  const reg = CADGeometryRegistry.getInstance();

  // Each child that is ITSELF a closed wire (circle / rect / closed loop) is its
  // own profile — return them all. This is the multi-profile (Multi-Pad) case:
  // two separate rectangles are two profiles, not one region to detect.
  const closed = childIds.filter((id) => {
    const w = reg.getShape(id);
    return w && OccSketchService.wireMakesFace(oc, w);
  });
  if (closed.length) return closed;

  // Otherwise the sketch is loose open edges (trimmed lines/arcs) → find region(s).
  const ents = childIds
    .map((id) => toRegionEntity(id, st.nodes[id]?.params?.sketchGeom))
    .filter((e): e is RegionEntity => !!e);
  const regions = findRegions(ents);
  if (!regions.length) return [];

  const wp = st.nodes[childIds[0]]?.params?.workplane;
  const geomOf = (id: string) => useCADStore.getState().nodes[id]?.params?.sketchGeom;
  const ids: string[] = [];

  regions.forEach((rg, i) => {
    const { wire } = OccSketchService.buildRegionProfileWire(oc, rg, geomOf, wp);
    const id = crypto.randomUUID();
    reg.registerShape(id, wire);
    st.addNode({
      id, name: regions.length > 1 ? `Region ${i + 1}` : 'Region', type: 'sketch_wire',
      visible: true, locked: false, parentId: sketchId, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { color: 0x00aa66, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
      params: { workplane: wp, region: true, memberIds: rg.members.map((m) => m.id) },
    });
    ids.push(id);
  });
  return ids;
}
