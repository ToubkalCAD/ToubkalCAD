// ============================================================
// ToubkalCAD – AssemblyMate.ts
//
// One-shot assembly mate (Coincident, planar faces). Given a reference face on
// a fixed solid and a face on the solid to move (both in WORLD space, as the
// user sees them), compute the rigid placement for the moving solid so the two
// faces become coplanar and touching — normals opposed, face centroids aligned.
//
// Both faces are read from the PLACED shape (current pose baked in), so the
// math is pure world-space rigid motion:
//   M   = F_target · F_movingFace⁻¹           (maps the moving face onto target)
//   B'  = M · B_current                         (move the whole solid by M)
// Decompose B' → position + Euler(XYZ) + scale for the node transform.
// ============================================================

import * as THREE from 'three';

export interface MateFace {
  origin: [number, number, number];
  normal: [number, number, number];   // outward unit normal (world)
  uAxis:  [number, number, number];   // an in-plane unit axis (world)
}
export interface NodeTransform {
  position: [number, number, number];
  rotation: [number, number, number]; // Euler XYZ, radians
  scale:    [number, number, number];
}
export interface MateOpts {
  opposed: boolean;   // true = Coincident (normals face each other); false = Align (parallel, same dir)
  offset:  number;    // gap along the reference normal (mm)
}
export interface MateAxis {
  point: [number, number, number];  // a point on the axis (world)
  dir:   [number, number, number];  // unit axis direction (world)
}

const compose = (t: NodeTransform): THREE.Matrix4 => new THREE.Matrix4().compose(
  new THREE.Vector3(...t.position),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'XYZ')),
  new THREE.Vector3(...t.scale),
);

const decompose = (m: THREE.Matrix4): NodeTransform => {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { position: [p.x, p.y, p.z], rotation: [e.x, e.y, e.z], scale: [s.x, s.y, s.z] };
};

/** Orthonormal frame (basis columns x,y,z + translation) from origin, z, x-hint. */
function frame(origin: THREE.Vector3, z: THREE.Vector3, xHint: THREE.Vector3): THREE.Matrix4 {
  const zv = z.clone().normalize();
  let xv = xHint.clone().addScaledVector(zv, -xHint.dot(zv));   // x-hint ⟂ z
  if (xv.lengthSq() < 1e-10) {                                  // x-hint ∥ z → pick any ⟂
    const alt = Math.abs(zv.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    xv = alt.addScaledVector(zv, -alt.dot(zv));
  }
  xv.normalize();
  const yv = new THREE.Vector3().crossVectors(zv, xv).normalize();
  const m = new THREE.Matrix4().makeBasis(xv, yv, zv);
  m.setPosition(origin);
  return m;
}

/**
 * New transform for the moving solid so its face mates with the reference face.
 * Coincident (opposed:true): outward normals oppose, faces touch (+offset gap).
 * Align (opposed:false): faces parallel, same normal direction, separated by offset.
 */
export function computeMateTransform(
  ref: MateFace, mov: MateFace, movT: NodeTransform,
  opts: MateOpts = { opposed: true, offset: 0 },
): NodeTransform {
  const refN = new THREE.Vector3(...ref.normal).normalize();
  const tOrigin = new THREE.Vector3(...ref.origin).addScaledVector(refN, opts.offset);
  const tZ = opts.opposed ? refN.clone().negate() : refN.clone();

  const Fmov    = frame(new THREE.Vector3(...mov.origin), new THREE.Vector3(...mov.normal), new THREE.Vector3(...mov.uAxis));
  const Ftarget = frame(tOrigin, tZ, new THREE.Vector3(...ref.uAxis));

  const M = Ftarget.multiply(Fmov.invert());                   // M = F_target · F_mov⁻¹
  return decompose(M.multiply(compose(movT)));                 // B' = M · B_current
}

/**
 * New transform for the moving solid so its axis becomes COLLINEAR with the
 * reference axis (concentric / peg-in-hole). Rotates the moving axis direction
 * onto the reference's, then removes only the perpendicular offset between the
 * axes — axial position (how far the peg sits along the axis) is preserved.
 */
export function computeConcentricTransform(ref: MateAxis, mov: MateAxis, movT: NodeTransform): NodeTransform {
  const Dmov = new THREE.Vector3(...mov.dir).normalize();
  const Dref = new THREE.Vector3(...ref.dir).normalize();

  let q: THREE.Quaternion;
  if (Dmov.dot(Dref) < -0.999999) {                            // antiparallel → 180° about any ⟂ axis
    const perp = (Math.abs(Dmov.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0))
      .cross(Dmov).normalize();
    q = new THREE.Quaternion().setFromAxisAngle(perp, Math.PI);
  } else {
    q = new THREE.Quaternion().setFromUnitVectors(Dmov, Dref);
  }
  const R = new THREE.Matrix4().makeRotationFromQuaternion(q);

  const Pmov = new THREE.Vector3(...mov.point).applyMatrix4(R);  // axis point after rotation about origin
  const diff = new THREE.Vector3(...ref.point).sub(Pmov);
  const perp = diff.clone().addScaledVector(Dref, -diff.dot(Dref)); // drop the along-axis component

  const M = new THREE.Matrix4().makeTranslation(perp.x, perp.y, perp.z).multiply(R);
  return decompose(M.multiply(compose(movT)));
}
