// ============================================================
// ToubkalCAD – placedShape.ts
//
// The OCC shape stored in CADGeometryRegistry is always at its ORIGINAL
// (origin) pose. The gizmo's Move/Rotate only updates the node's Three.js
// transform on the rendered mesh — it never re-bakes the OCC geometry. So any
// kernel op that reads reg.getShape(id) directly would act on the un-moved
// pose (booleans landing at the origin, fillet edges drawn off the body, …).
//
// getPlacedShape() returns the shape with the node's current placement baked
// in, so every downstream op works on the geometry where the user sees it.
// It is deterministic: the same (shape, transform) always yields the same
// topology order, so two independent callers (e.g. edge display + fillet
// application) stay index-consistent. Identity placements return the shape
// unchanged — zero overhead and zero copy for un-moved bodies.
// ============================================================

import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccTransformService } from '../services/OccTransformService';
import { useCADStore } from '../store/cadStore';

export function getPlacedShape(id: string): any {
  const shape = CADGeometryRegistry.getInstance().getShape(id);
  if (!shape || !window.oc) return shape ?? null;
  const node = useCADStore.getState().nodes[id];
  if (!node) return shape;
  return OccTransformService.placeShape(window.oc, shape, node.transform);
}
