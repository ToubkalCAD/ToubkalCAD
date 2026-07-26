import * as THREE from 'three';
import type { CADNode } from '../store/cadStore';
import { assemblyComponentWorldMatrix } from './AssemblyReferenceService';
import {
  isAssemblyComponentData,
  isAssemblyDocumentData,
  type AssemblyConstraint,
  type AssemblyConstraintStatus,
  type AssemblyReference,
  type ComponentTransform,
  type Vec3,
} from './types';
import { matrixToComponentTransform } from './transforms';

export interface AssemblySolverResult {
  success: boolean;
  componentTransforms: Record<string, ComponentTransform>;
  constraintStatuses: Record<string, AssemblyConstraintStatus>;
  constraintMessages: Record<string, string | undefined>;
  errors: string[];
  iterations: number;
  underConstrainedComponentIds: string[];
}

export interface AssemblyConstraintSolver {
  solve(nodes: Record<string, CADNode>, assemblyId: string): AssemblySolverResult;
}

interface WorldReference {
  point?: THREE.Vector3;
  direction?: THREE.Vector3;
  uAxis?: THREE.Vector3;
}

interface Evaluation {
  satisfied: boolean;
  residual: number;
  message?: string;
}

const LINEAR_TOLERANCE = 0.02;
const ANGULAR_TOLERANCE = 1e-3;
const MAX_ITERATIONS = 24;

const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const vector = (value?: Vec3) => value ? new THREE.Vector3(...value) : undefined;

function worldReference(nodes: Record<string, CADNode>, reference: AssemblyReference): WorldReference {
  const matrix = assemblyComponentWorldMatrix(nodes, reference.componentId);
  const point = vector(reference.localPoint)?.applyMatrix4(matrix)
    ?? vector(reference.worldPoint);
  const direction = vector(reference.localDirection)?.transformDirection(matrix)
    ?? vector(reference.worldDirection);
  const uAxis = vector(reference.localUAxis)?.transformDirection(matrix)
    ?? vector(reference.worldUAxis);
  return { point, direction: direction?.normalize(), uAxis: uAxis?.normalize() };
}

function referenceAvailable(nodes: Record<string, CADNode>, reference: AssemblyReference): string | null {
  if (reference.resolutionError) return reference.resolutionError;
  const component = nodes[reference.componentId];
  const data = component?.params?.assemblyComponent;
  if (!component || !isAssemblyComponentData(data)) return 'Component instance is missing.';
  if (data.partId !== reference.partId) return 'Component references a different part.';
  if (nodes[reference.partId]?.type !== 'component') return 'Part definition is missing.';
  if (reference.sourceNodeId && !nodes[reference.sourceNodeId]) return 'Referenced feature or body is missing.';
  if (!reference.localPoint && !reference.worldPoint && reference.subshapeType !== 'axis') {
    return 'Reference has no usable geometric point.';
  }
  return null;
}

function componentParentWorld(nodes: Record<string, CADNode>, componentId: string): THREE.Matrix4 {
  const data = nodes[componentId]?.params?.assemblyComponent;
  return isAssemblyComponentData(data) && data.parentComponentId
    ? assemblyComponentWorldMatrix(nodes, data.parentComponentId)
    : new THREE.Matrix4().identity();
}

function applyWorldDelta(
  nodes: Record<string, CADNode>, componentId: string, delta: THREE.Matrix4,
): void {
  const node = nodes[componentId];
  if (!node) return;
  const nextWorld = delta.clone().multiply(assemblyComponentWorldMatrix(nodes, componentId));
  const nextLocal = componentParentWorld(nodes, componentId).invert().multiply(nextWorld);
  nodes[componentId] = { ...node, transform: matrixToComponentTransform(nextLocal) };
}

function rotationDelta(from: THREE.Vector3, to: THREE.Vector3, pivot: THREE.Vector3): THREE.Matrix4 {
  const quaternion = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  return new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternion))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}

function translationDelta(delta: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z);
}

function closestParallel(reference: THREE.Vector3, moving: THREE.Vector3, flipped: boolean): THREE.Vector3 {
  const target = reference.clone().multiplyScalar(reference.dot(moving) < 0 ? -1 : 1);
  return flipped ? target.negate() : target;
}

function closestPerpendicular(reference: THREE.Vector3, moving: THREE.Vector3, flipped: boolean): THREE.Vector3 {
  let target = moving.clone().addScaledVector(reference, -moving.dot(reference));
  if (target.lengthSq() < 1e-12) {
    const fallback = Math.abs(reference.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    target = fallback.addScaledVector(reference, -fallback.dot(reference));
  }
  target.normalize();
  return flipped ? target.negate() : target;
}

function desiredAngleDirection(
  reference: THREE.Vector3, moving: THREE.Vector3, angle: number, flipped: boolean,
): THREE.Vector3 {
  let perpendicular = moving.clone().addScaledVector(reference, -moving.dot(reference));
  if (perpendicular.lengthSq() < 1e-12) {
    const fallback = Math.abs(reference.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    perpendicular = fallback.addScaledVector(reference, -fallback.dot(reference));
  }
  perpendicular.normalize().multiplyScalar(flipped ? -1 : 1);
  return reference.clone().multiplyScalar(Math.cos(angle))
    .addScaledVector(perpendicular, Math.sin(angle))
    .normalize();
}

function correctConstraint(
  nodes: Record<string, CADNode>,
  constraint: AssemblyConstraint,
  fixed: Set<string>,
): boolean {
  if (constraint.type === 'fixed' || !constraint.referenceB) return false;
  const aId = constraint.referenceA.componentId;
  const bId = constraint.referenceB.componentId;
  const aFixed = fixed.has(aId);
  const bFixed = fixed.has(bId);
  if (aFixed && bFixed) return false;
  const movingIsB = !bFixed;
  const movingId = movingIsB ? bId : aId;
  const anchorRef = movingIsB ? constraint.referenceA : constraint.referenceB;
  const movingRef = movingIsB ? constraint.referenceB : constraint.referenceA;
  const anchor = worldReference(nodes, anchorRef);
  let moving = worldReference(nodes, movingRef);

  if (constraint.type === 'coincident' || constraint.type === 'planar') {
    if (!anchor.point || !anchor.direction || !moving.point || !moving.direction) return false;
    const desiredDirection = constraint.flipped ? anchor.direction.clone() : anchor.direction.clone().negate();
    applyWorldDelta(nodes, movingId, rotationDelta(moving.direction, desiredDirection, moving.point));
    moving = worldReference(nodes, movingRef);
    if (!moving.point) return false;
    const target = anchor.point.clone().addScaledVector(anchor.direction, constraint.offset ?? 0);
    const separation = target.clone().sub(moving.point);
    const normalShift = anchor.direction.clone().multiplyScalar(separation.dot(anchor.direction));
    applyWorldDelta(nodes, movingId, translationDelta(normalShift));
    return true;
  }

  if (constraint.type === 'concentric' || constraint.type === 'axial') {
    if (!anchor.point || !anchor.direction || !moving.point || !moving.direction) return false;
    const desiredDirection = closestParallel(anchor.direction, moving.direction, !!constraint.flipped);
    applyWorldDelta(nodes, movingId, rotationDelta(moving.direction, desiredDirection, moving.point));
    moving = worldReference(nodes, movingRef);
    if (!moving.point) return false;
    const difference = anchor.point.clone().sub(moving.point);
    const perpendicular = difference.addScaledVector(anchor.direction, -difference.dot(anchor.direction));
    applyWorldDelta(nodes, movingId, translationDelta(perpendicular));
    return true;
  }

  if (constraint.type === 'parallel' || constraint.type === 'perpendicular' || constraint.type === 'angle') {
    if (!anchor.direction || !moving.direction || !moving.point) return false;
    const desired = constraint.type === 'parallel'
      ? closestParallel(anchor.direction, moving.direction, !!constraint.flipped)
      : constraint.type === 'perpendicular'
        ? closestPerpendicular(anchor.direction, moving.direction, !!constraint.flipped)
        : desiredAngleDirection(anchor.direction, moving.direction, constraint.angle ?? 0, !!constraint.flipped);
    applyWorldDelta(nodes, movingId, rotationDelta(moving.direction, desired, moving.point));
    return true;
  }

  if (constraint.type === 'distance') {
    const a = worldReference(nodes, constraint.referenceA);
    const b = worldReference(nodes, constraint.referenceB);
    if (!a.point || !b.point) return false;
    const targetDistance = constraint.offset ?? 0;
    if (a.direction) {
      const current = b.point.clone().sub(a.point).dot(a.direction);
      const amount = movingIsB ? targetDistance - current : current - targetDistance;
      applyWorldDelta(nodes, movingId, translationDelta(a.direction.clone().multiplyScalar(amount)));
    } else {
      let direction = b.point.clone().sub(a.point);
      if (direction.lengthSq() < 1e-12) direction.set(1, 0, 0);
      direction.normalize();
      const current = b.point.distanceTo(a.point);
      const amount = movingIsB ? targetDistance - current : current - targetDistance;
      applyWorldDelta(nodes, movingId, translationDelta(direction.multiplyScalar(amount)));
    }
    return true;
  }
  return false;
}

function evaluateConstraint(nodes: Record<string, CADNode>, constraint: AssemblyConstraint): Evaluation {
  if (!constraint.enabled) return { satisfied: true, residual: 0, message: 'Constraint is disabled.' };
  if (constraint.type === 'fixed') return { satisfied: true, residual: 0 };
  if (!constraint.referenceB) return { satisfied: false, residual: Infinity, message: 'Second reference is missing.' };
  const a = worldReference(nodes, constraint.referenceA);
  const b = worldReference(nodes, constraint.referenceB);
  if (constraint.type === 'coincident' || constraint.type === 'planar') {
    if (!a.point || !b.point || !a.direction || !b.direction) return { satisfied: false, residual: Infinity };
    const desiredDot = constraint.flipped ? 1 : -1;
    const angular = Math.abs(a.direction.dot(b.direction) - desiredDot);
    const linear = Math.abs(b.point.clone().sub(a.point).dot(a.direction) - (constraint.offset ?? 0));
    return { satisfied: angular < ANGULAR_TOLERANCE && linear < LINEAR_TOLERANCE, residual: Math.max(angular, linear) };
  }
  if (constraint.type === 'concentric' || constraint.type === 'axial') {
    if (!a.point || !b.point || !a.direction || !b.direction) return { satisfied: false, residual: Infinity };
    const angular = 1 - Math.abs(a.direction.dot(b.direction));
    const difference = b.point.clone().sub(a.point);
    const axisDistance = difference.addScaledVector(a.direction, -difference.dot(a.direction)).length();
    return { satisfied: angular < ANGULAR_TOLERANCE && axisDistance < LINEAR_TOLERANCE, residual: Math.max(angular, axisDistance) };
  }
  if (constraint.type === 'parallel') {
    if (!a.direction || !b.direction) return { satisfied: false, residual: Infinity };
    const residual = 1 - Math.abs(a.direction.dot(b.direction));
    return { satisfied: residual < ANGULAR_TOLERANCE, residual };
  }
  if (constraint.type === 'perpendicular') {
    if (!a.direction || !b.direction) return { satisfied: false, residual: Infinity };
    const residual = Math.abs(a.direction.dot(b.direction));
    return { satisfied: residual < ANGULAR_TOLERANCE, residual };
  }
  if (constraint.type === 'angle') {
    if (!a.direction || !b.direction) return { satisfied: false, residual: Infinity };
    const actual = Math.acos(clamp(a.direction.dot(b.direction)));
    const residual = Math.abs(actual - (constraint.angle ?? 0));
    return { satisfied: residual < ANGULAR_TOLERANCE, residual };
  }
  if (constraint.type === 'distance') {
    if (!a.point || !b.point) return { satisfied: false, residual: Infinity };
    const actual = a.direction
      ? b.point.clone().sub(a.point).dot(a.direction)
      : a.point.distanceTo(b.point);
    const residual = Math.abs(actual - (constraint.offset ?? 0));
    return { satisfied: residual < LINEAR_TOLERANCE, residual };
  }
  return { satisfied: false, residual: Infinity, message: `${constraint.type} is reserved for the next solver extension.` };
}

function floatingComponents(
  componentIds: string[], constraints: AssemblyConstraint[], fixed: Set<string>,
): string[] {
  const connected = new Set(fixed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const constraint of constraints) {
      if (!constraint.enabled || !constraint.referenceB || constraint.type === 'fixed') continue;
      const a = constraint.referenceA.componentId;
      const b = constraint.referenceB.componentId;
      if (connected.has(a) && !connected.has(b)) { connected.add(b); changed = true; }
      if (connected.has(b) && !connected.has(a)) { connected.add(a); changed = true; }
    }
  }
  return componentIds.filter((id) => !connected.has(id));
}

export class IterativeAssemblyConstraintSolver implements AssemblyConstraintSolver {
  solve(inputNodes: Record<string, CADNode>, assemblyId: string): AssemblySolverResult {
    const assembly = inputNodes[assemblyId];
    const data = assembly?.params?.assembly;
    if (!assembly || !isAssemblyDocumentData(data)) {
      return {
        success: false, componentTransforms: {}, constraintStatuses: {}, constraintMessages: {},
        errors: ['Assembly document is missing.'], iterations: 0, underConstrainedComponentIds: [],
      };
    }

    const nodes: Record<string, CADNode> = { ...inputNodes };
    const constraints = data.constraintIds.map((id) => data.constraints[id]).filter(Boolean);
    const fixed = new Set(data.componentIds.filter((id) => {
      const componentData = nodes[id]?.params?.assemblyComponent;
      return isAssemblyComponentData(componentData) && componentData.fixed;
    }));
    for (const constraint of constraints) {
      if (constraint.enabled && constraint.type === 'fixed') fixed.add(constraint.referenceA.componentId);
    }

    const missing = new Map<string, string>();
    for (const constraint of constraints) {
      const reasonA = referenceAvailable(nodes, constraint.referenceA);
      const reasonB = constraint.referenceB ? referenceAvailable(nodes, constraint.referenceB) : null;
      if (reasonA || reasonB) missing.set(constraint.id, reasonA ?? reasonB!);
    }

    let iterations = 0;
    for (; iterations < MAX_ITERATIONS; iterations++) {
      let changed = false;
      for (const constraint of constraints) {
        if (!constraint.enabled || missing.has(constraint.id)) continue;
        changed = correctConstraint(nodes, constraint, fixed) || changed;
      }
      const allSatisfied = constraints.every((constraint) =>
        !constraint.enabled || missing.has(constraint.id) || evaluateConstraint(nodes, constraint).satisfied);
      if (allSatisfied || !changed) { iterations++; break; }
    }

    const floating = floatingComponents(data.componentIds, constraints, fixed);
    const statuses: Record<string, AssemblyConstraintStatus> = {};
    const messages: Record<string, string | undefined> = {};
    const errors: string[] = [];
    for (const constraint of constraints) {
      if (!constraint.enabled) {
        statuses[constraint.id] = 'unsolved';
        messages[constraint.id] = 'Constraint is disabled.';
        continue;
      }
      const missingReason = missing.get(constraint.id);
      if (missingReason) {
        statuses[constraint.id] = 'missing-reference';
        messages[constraint.id] = missingReason;
        errors.push(`${constraint.type}: ${missingReason}`);
        continue;
      }
      const evaluation = evaluateConstraint(nodes, constraint);
      const floatingConstraint = constraint.type !== 'fixed'
        && floating.includes(constraint.referenceA.componentId)
        && (!constraint.referenceB || floating.includes(constraint.referenceB.componentId));
      statuses[constraint.id] = !evaluation.satisfied
        ? 'conflicting'
        : floatingConstraint ? 'under-constrained' : 'solved';
      messages[constraint.id] = evaluation.message
        ?? (!evaluation.satisfied ? `Residual ${Number.isFinite(evaluation.residual) ? evaluation.residual.toPrecision(4) : 'is not finite'}.`
          : floatingConstraint ? 'Constraint is satisfied, but this component chain is not grounded.' : undefined);
      if (!evaluation.satisfied) errors.push(`${constraint.type}: ${messages[constraint.id]}`);
    }

    const componentTransforms = Object.fromEntries(data.componentIds.flatMap((id) =>
      nodes[id] ? [[id, nodes[id].transform as ComponentTransform]] : []));
    return {
      success: !Object.values(statuses).some((status) => status === 'conflicting' || status === 'missing-reference'),
      componentTransforms,
      constraintStatuses: statuses,
      constraintMessages: messages,
      errors,
      iterations,
      underConstrainedComponentIds: floating,
    };
  }
}

export const assemblyConstraintSolver = new IterativeAssemblyConstraintSolver();
