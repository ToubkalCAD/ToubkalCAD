// ============================================================
// ToubkalCAD – utils/backfillRegionMembers.ts
//
// Load-time migration. Region sketch wires only started storing `memberIds`
// (the entity wires they were traced from) recently; wires saved before that
// carry just { region, regionArea }. Without memberIds the FeatureGraph adapter
// wires no entity inputs, so the recompute engine can't re-detect or rebuild the
// region — it won't follow an edited sketch/face.
//
// This re-traces each legacy region from its SIBLING entity wires (same detection
// the sketchWire evaluator runs) and attaches the matching region's member ids,
// picking the region whose area is closest to the stored regionArea. Pure: takes a
// nodes map, returns a new one with the back-filled wires replaced. No-op for wires
// that already have memberIds or can't be matched (graceful — they stay as before).
// ============================================================

import type { CADNode } from '../store/cadStore';
import { toRegionEntity, findRegions, RegionEntity } from '../services/SketchRegions';

export function backfillRegionMembers(nodes: Record<string, CADNode>): Record<string, CADNode> {
  // Index editable entity wires (those with sketchGeom) by their sketch container.
  const siblingsByParent = new Map<string, CADNode[]>();
  for (const n of Object.values(nodes)) {
    if (n.type === 'sketch_wire' && n.params?.sketchGeom && n.parentId) {
      const arr = siblingsByParent.get(n.parentId);
      if (arr) arr.push(n); else siblingsByParent.set(n.parentId, [n]);
    }
  }

  let changed = false;
  const out: Record<string, CADNode> = { ...nodes };
  for (const n of Object.values(nodes)) {
    const p = n.params;
    if (n.type !== 'sketch_wire' || !p?.region || Array.isArray(p.memberIds)) continue;

    const siblings = (n.parentId && siblingsByParent.get(n.parentId)) || [];
    const ents = siblings
      .map((s) => toRegionEntity(s.id, s.params!.sketchGeom))
      .filter((e): e is RegionEntity => !!e);
    const regions = findRegions(ents);
    if (!regions.length) continue;

    const targetArea = typeof p.regionArea === 'number' ? p.regionArea : null;
    const match = targetArea != null
      ? regions.reduce((a, b) => (Math.abs(b.area - targetArea) < Math.abs(a.area - targetArea) ? b : a))
      : regions.reduce((a, b) => (b.area > a.area ? b : a));   // no stored area → largest, as at creation

    out[n.id] = { ...n, params: { ...p, memberIds: match.members.map((m) => m.id) } };
    changed = true;
  }

  return changed ? out : nodes;
}
