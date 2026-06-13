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

import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccSketchService } from '../services/OccSketchService';
import { findRegions, toRegionEntity, RegionEntity } from '../services/SketchRegions';

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
