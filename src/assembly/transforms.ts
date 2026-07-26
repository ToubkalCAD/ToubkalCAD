import * as THREE from 'three';
import type { ComponentTransform, Vec3 } from './types';

export const IDENTITY_COMPONENT_TRANSFORM = (): ComponentTransform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  matrix: new THREE.Matrix4().identity().toArray(),
});

export function componentTransformToMatrix(transform: ComponentTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...transform.rotation, 'XYZ')),
    new THREE.Vector3(...transform.scale),
  );
}

export function matrixToComponentTransform(matrix: THREE.Matrix4): ComponentTransform {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  const euler = new THREE.Euler().setFromQuaternion(rotation, 'XYZ');
  return {
    position: [position.x, position.y, position.z],
    rotation: [euler.x, euler.y, euler.z],
    scale: [scale.x, scale.y, scale.z],
    matrix: matrix.toArray(),
  };
}

export function normalizeComponentTransform(transform?: Partial<ComponentTransform>): ComponentTransform {
  const identity = IDENTITY_COMPONENT_TRANSFORM();
  const normalized: ComponentTransform = {
    position: [...(transform?.position ?? identity.position)] as Vec3,
    rotation: [...(transform?.rotation ?? identity.rotation)] as Vec3,
    scale: [...(transform?.scale ?? identity.scale)] as Vec3,
  };
  normalized.matrix = componentTransformToMatrix(normalized).toArray();
  return normalized;
}

export function applyTransformToObject(object: THREE.Object3D, transform: ComponentTransform): void {
  object.position.set(...transform.position);
  object.rotation.set(...transform.rotation, 'XYZ');
  object.scale.set(...transform.scale);
  object.updateMatrix();
  object.updateMatrixWorld(true);
}

/**
 * Convert the rigid/uniform-scale portion of a THREE matrix into the exact
 * OpenCascade.js binding exposed by this repository. The returned gp_Trsf is
 * owned by the caller and must be deleted. Non-uniform scale is rejected
 * because gp_Trsf cannot represent it.
 */
export function matrixToOccTransform(oc: any, matrix: THREE.Matrix4): any {
  const t = matrixToComponentTransform(matrix);
  const [sx, sy, sz] = t.scale;
  if (Math.max(Math.abs(sx - sy), Math.abs(sx - sz), Math.abs(sy - sz)) > 1e-9) {
    throw new Error('OpenCascade gp_Trsf does not support non-uniform assembly scale.');
  }
  const e = matrix.elements;
  const trsf = new oc.gp_Trsf_1();
  trsf.SetValues(
    e[0], e[4], e[8], e[12],
    e[1], e[5], e[9], e[13],
    e[2], e[6], e[10], e[14],
  );
  return trsf;
}
