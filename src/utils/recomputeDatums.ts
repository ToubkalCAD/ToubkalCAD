// ============================================================
// ToubkalCAD – recomputeDatums.ts
//
// Track D, D13 — associative datum recompute (rigid-transform scope).
//
// A datum derived from a body stores params.bind = { id, transform } — the source
// node id and that source's transform at the moment the datum was built. When the
// source is later moved/rotated, computeDatumUpdates() applies the delta transform
// (current ∘ bind⁻¹) to the datum's geometry so it follows the body. The store
// folds these updates into the SAME nodes-set + undo entry as the move, so undo/
// redo stay atomic.
//
// Scope: body → datum only. Datum → datum chains and geometry-edit (parameter)
// recompute need the P1 feature tree / topological naming and are deferred.
// ============================================================

import * as THREE from 'three';

type V3 = [number, number, number];
interface Transform { position: V3; rotation: V3; scale: V3; }

function matOf(t: Transform): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'XYZ'),
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(t.position[0], t.position[1], t.position[2]), q,
    new THREE.Vector3(t.scale[0], t.scale[1], t.scale[2]),
  );
}

const cloneT = (t: Transform): Transform => ({
  position: [...t.position] as V3, rotation: [...t.rotation] as V3, scale: [...t.scale] as V3,
});

const applyPoint = (m: THREE.Matrix4, p: V3): V3 => {
  const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
  return [v.x, v.y, v.z];
};
const applyDir = (m: THREE.Matrix4, d: V3): V3 => {
  const v = new THREE.Vector3(d[0], d[1], d[2]).transformDirection(m); // rotates + normalises
  return [v.x, v.y, v.z];
};

/**
 * Given the (already-updated) nodes map and the id of a node that just moved,
 * return { datumId: newParams } for every datum bound to that node. Pure — the
 * caller merges these into its nodes update.
 */
export function computeDatumUpdates(
  nodes: Record<string, any>,
  changedId: string,
): Record<string, any> {
  const src = nodes[changedId]?.transform as Transform | undefined;
  if (!src) return {};
  const out: Record<string, any> = {};

  for (const node of Object.values(nodes) as any[]) {
    if (typeof node?.type !== 'string' || !node.type.startsWith('datum_')) continue;
    const p = node.params;
    const bind = p?.bind;
    if (!bind || bind.id !== changedId || !bind.transform) continue;

    const delta = matOf(src).multiply(matOf(bind.transform).invert());
    const newBind = { id: changedId, transform: cloneT(src) };

    if (node.type === 'datum_plane' && p.workplane) {
      const wp = p.workplane;
      out[node.id] = {
        ...p, bind: newBind,
        workplane: {
          ...wp,
          origin: applyPoint(delta, wp.origin),
          normal: applyDir(delta, wp.normal),
          uAxis:  applyDir(delta, wp.uAxis),
          vAxis:  applyDir(delta, wp.vAxis),
        },
      };
    } else if (node.type === 'datum_axis' && p.axis) {
      out[node.id] = {
        ...p, bind: newBind,
        axis: { origin: applyPoint(delta, p.axis.origin), dir: applyDir(delta, p.axis.dir) },
      };
    } else if (node.type === 'datum_point' && p.point) {
      out[node.id] = { ...p, bind: newBind, point: applyPoint(delta, p.point) };
    }
  }
  return out;
}
