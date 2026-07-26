import * as THREE from 'three';
import type { CADNode } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccAxisService } from '../services/OccAxisService';
import { OccEdgeService } from '../services/OccEdgeService';
import { OccFaceService } from '../services/OccFaceService';
import {
  captureEdge,
  captureFace,
  captureVertex,
  resolveEdge,
  resolveFace,
  resolveVertex,
  type EdgeSig,
  type FaceSig,
  type VertexSig,
} from '../services/StableRef';
import { componentTransformToMatrix } from './transforms';
import { isAssemblyComponentData, type AssemblyConstraintType, type AssemblyReference, type Vec3 } from './types';

export interface ReferenceValidation {
  valid: boolean;
  reason?: string;
}

export interface ResolvedAssemblyReference {
  valid: boolean;
  reference: AssemblyReference;
  index?: number;
  score?: number;
  reason?: string;
}

function transformPoint(matrix: THREE.Matrix4, point: Vec3): Vec3 {
  const result = new THREE.Vector3(...point).applyMatrix4(matrix);
  return [result.x, result.y, result.z];
}

function transformDirection(matrix: THREE.Matrix4, direction: Vec3): Vec3 {
  const result = new THREE.Vector3(...direction).transformDirection(matrix);
  return [result.x, result.y, result.z];
}

function nodeMatrix(node?: CADNode): THREE.Matrix4 {
  return componentTransformToMatrix(node?.transform ?? {
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  });
}

export function assemblyComponentWorldMatrix(
  nodes: Record<string, CADNode>, componentId: string, visited = new Set<string>(),
): THREE.Matrix4 {
  if (visited.has(componentId)) throw new Error('Assembly component hierarchy contains a cycle.');
  visited.add(componentId);
  const component = nodes[componentId];
  const data = component?.params?.assemblyComponent;
  const local = nodeMatrix(component);
  if (!isAssemblyComponentData(data) || !data.parentComponentId) return local;
  return assemblyComponentWorldMatrix(nodes, data.parentComponentId, visited).multiply(local);
}

/** Transform of a source feature relative to its part-definition root. */
export function partSourceMatrix(
  nodes: Record<string, CADNode>, partId: string, sourceNodeId: string,
): THREE.Matrix4 {
  const chain: CADNode[] = [];
  let current: CADNode | undefined = nodes[sourceNodeId];
  const visited = new Set<string>();
  while (current && current.id !== partId && !visited.has(current.id)) {
    visited.add(current.id);
    chain.unshift(current);
    current = current.parentId ? nodes[current.parentId] : undefined;
  }
  const matrix = new THREE.Matrix4().identity();
  for (const node of chain) matrix.multiply(nodeMatrix(node));
  return matrix;
}

export function assemblySourceWorldMatrix(
  nodes: Record<string, CADNode>, componentId: string, sourceNodeId: string,
): THREE.Matrix4 {
  const data = nodes[componentId]?.params?.assemblyComponent;
  if (!isAssemblyComponentData(data)) throw new Error('Invalid assembly component.');
  return assemblyComponentWorldMatrix(nodes, componentId)
    .multiply(partSourceMatrix(nodes, data.partId, sourceNodeId));
}

function baseReference(
  nodes: Record<string, CADNode>, componentId: string, sourceNodeId: string | undefined,
  subshapeType: AssemblyReference['subshapeType'], index?: number,
): AssemblyReference {
  const component = nodes[componentId];
  const data = component?.params?.assemblyComponent;
  if (!component || !isAssemblyComponentData(data)) throw new Error('Reference must belong to a placed assembly component.');
  return {
    componentId,
    partId: data.partId,
    sourceNodeId,
    subshapeType,
    subshapeIndex: index,
    subshapeId: sourceNodeId && index != null ? `${sourceNodeId}:${subshapeType}:${index}` : `${componentId}:${subshapeType}`,
    referenceName: `${component.name} · ${subshapeType}${index != null ? ` ${index + 1}` : ''}`,
  };
}

function withFrames(
  reference: AssemblyReference,
  partMatrix: THREE.Matrix4,
  worldMatrix: THREE.Matrix4,
  geometry: { point?: Vec3; direction?: Vec3; uAxis?: Vec3; vAxis?: Vec3; radius?: number },
): AssemblyReference {
  return {
    ...reference,
    localPoint: geometry.point ? transformPoint(partMatrix, geometry.point) : undefined,
    localDirection: geometry.direction ? transformDirection(partMatrix, geometry.direction) : undefined,
    localUAxis: geometry.uAxis ? transformDirection(partMatrix, geometry.uAxis) : undefined,
    localVAxis: geometry.vAxis ? transformDirection(partMatrix, geometry.vAxis) : undefined,
    worldPoint: geometry.point ? transformPoint(worldMatrix, geometry.point) : undefined,
    worldDirection: geometry.direction ? transformDirection(worldMatrix, geometry.direction) : undefined,
    worldUAxis: geometry.uAxis ? transformDirection(worldMatrix, geometry.uAxis) : undefined,
    worldVAxis: geometry.vAxis ? transformDirection(worldMatrix, geometry.vAxis) : undefined,
    radius: geometry.radius,
  };
}

function sourceContext(nodes: Record<string, CADNode>, componentId: string, sourceNodeId: string) {
  const componentData = nodes[componentId]?.params?.assemblyComponent;
  if (!isAssemblyComponentData(componentData)) throw new Error('Invalid assembly component.');
  const shape = CADGeometryRegistry.getInstance().getShape(sourceNodeId);
  if (!shape) throw new Error(`Geometry for "${nodes[sourceNodeId]?.name ?? sourceNodeId}" is unavailable.`);
  return {
    shape,
    partMatrix: partSourceMatrix(nodes, componentData.partId, sourceNodeId),
    worldMatrix: assemblySourceWorldMatrix(nodes, componentId, sourceNodeId),
  };
}

export class AssemblyReferenceService {
  static captureFace(
    oc: any, nodes: Record<string, CADNode>, componentId: string, sourceNodeId: string, faceIndex: number,
  ): AssemblyReference {
    const ctx = sourceContext(nodes, componentId, sourceNodeId);
    const stableRef = captureFace(oc, ctx.shape, faceIndex);
    if (!stableRef) throw new Error('Unable to capture a stable face reference.');
    const reference = { ...baseReference(nodes, componentId, sourceNodeId, 'face', faceIndex), stableRef };
    if (stableRef.surf === 'plane') {
      const plane = OccFaceService.planeFromFaceIndex(oc, ctx.shape, faceIndex);
      if (plane) return withFrames(reference, ctx.partMatrix, ctx.worldMatrix, {
        point: stableRef.centroid, direction: plane.normal, uAxis: plane.uAxis, vAxis: plane.vAxis,
      });
    }
    if (stableRef.surf === 'cylinder') {
      const cylinder = OccAxisService.extractCylindricalFaces(oc, ctx.shape).find((face) => face.index === faceIndex);
      if (cylinder) return withFrames(reference, ctx.partMatrix, ctx.worldMatrix, {
        point: cylinder.axisPoint, direction: cylinder.axisDir, radius: cylinder.radius,
      });
    }
    return withFrames(reference, ctx.partMatrix, ctx.worldMatrix, { point: stableRef.centroid, direction: stableRef.axis });
  }

  static captureEdge(
    oc: any, nodes: Record<string, CADNode>, componentId: string, sourceNodeId: string, edgeIndex: number,
  ): AssemblyReference {
    const ctx = sourceContext(nodes, componentId, sourceNodeId);
    const stableRef = captureEdge(oc, ctx.shape, edgeIndex);
    if (!stableRef) throw new Error('Unable to capture a stable edge reference.');
    const edge = OccEdgeService.extractEdges(oc, ctx.shape).find((candidate) => candidate.index === edgeIndex);
    const geometry = edge?.curve?.type === 'circle'
      ? { point: edge.curve.center, direction: edge.curve.normal, radius: edge.curve.radius }
      : { point: stableRef.mid, direction: stableRef.axis };
    return withFrames(
      { ...baseReference(nodes, componentId, sourceNodeId, 'edge', edgeIndex), stableRef },
      ctx.partMatrix, ctx.worldMatrix, geometry,
    );
  }

  static captureVertex(
    oc: any, nodes: Record<string, CADNode>, componentId: string, sourceNodeId: string, vertexIndex: number,
  ): AssemblyReference {
    const ctx = sourceContext(nodes, componentId, sourceNodeId);
    const stableRef = captureVertex(oc, ctx.shape, vertexIndex);
    if (!stableRef) throw new Error('Unable to capture a stable vertex reference.');
    return withFrames(
      { ...baseReference(nodes, componentId, sourceNodeId, 'vertex', vertexIndex), stableRef },
      ctx.partMatrix, ctx.worldMatrix, { point: stableRef.pos },
    );
  }

  static standard(
    nodes: Record<string, CADNode>, componentId: string,
    type: 'origin' | 'axis' | 'plane', name: 'origin' | 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ',
  ): AssemblyReference {
    const world = assemblyComponentWorldMatrix(nodes, componentId);
    const reference = baseReference(nodes, componentId, undefined, type);
    const axes: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
    const uAxes: Record<string, Vec3> = { XY: [1, 0, 0], XZ: [1, 0, 0], YZ: [0, 1, 0] };
    const vAxes: Record<string, Vec3> = { XY: [0, 1, 0], XZ: [0, 0, 1], YZ: [0, 0, 1] };
    return {
      ...reference,
      subshapeId: `${componentId}:${type}:${name}`,
      referenceName: `${nodes[componentId]?.name ?? 'Component'} · ${name}`,
      localPoint: [0, 0, 0],
      worldPoint: transformPoint(world, [0, 0, 0]),
      localDirection: axes[name],
      worldDirection: axes[name] ? transformDirection(world, axes[name]) : undefined,
      localUAxis: uAxes[name],
      localVAxis: vAxes[name],
      worldUAxis: uAxes[name] ? transformDirection(world, uAxes[name]) : undefined,
      worldVAxis: vAxes[name] ? transformDirection(world, vAxes[name]) : undefined,
    };
  }

  static validate(nodes: Record<string, CADNode>, reference: AssemblyReference): ReferenceValidation {
    const component = nodes[reference.componentId];
    const data = component?.params?.assemblyComponent;
    if (!component || !isAssemblyComponentData(data)) return { valid: false, reason: 'Component instance is missing.' };
    if (data.partId !== reference.partId) return { valid: false, reason: 'Component now references a different part.' };
    if (!nodes[reference.partId] || nodes[reference.partId].type !== 'component') return { valid: false, reason: 'Part definition is missing.' };
    if (reference.sourceNodeId && !nodes[reference.sourceNodeId]) return { valid: false, reason: 'Referenced feature/body is missing.' };
    if (reference.sourceNodeId && !reference.stableRef) return { valid: false, reason: 'Geometric reference has no persistent signature.' };
    return { valid: true };
  }

  static resolve(oc: any, nodes: Record<string, CADNode>, reference: AssemblyReference): ResolvedAssemblyReference {
    const validation = this.validate(nodes, reference);
    if (!validation.valid || !reference.sourceNodeId || !reference.stableRef) {
      return { valid: validation.valid, reference, reason: validation.reason };
    }
    const shape = CADGeometryRegistry.getInstance().getShape(reference.sourceNodeId);
    if (!shape) return { valid: false, reference, reason: 'Referenced geometry is unavailable.' };
    const stable = reference.stableRef;
    const result = stable.kind === 'face'
      ? resolveFace(oc, shape, stable as FaceSig)
      : stable.kind === 'edge'
        ? resolveEdge(oc, shape, stable as EdgeSig)
        : resolveVertex(oc, shape, stable as VertexSig);
    if (result.rejected) return { valid: false, reference, index: result.index, score: result.score, reason: result.reason };
    const refreshed = stable.kind === 'face'
      ? this.captureFace(oc, nodes, reference.componentId, reference.sourceNodeId, result.index)
      : stable.kind === 'edge'
        ? this.captureEdge(oc, nodes, reference.componentId, reference.sourceNodeId, result.index)
        : this.captureVertex(oc, nodes, reference.componentId, reference.sourceNodeId, result.index);
    return { valid: true, reference: { ...refreshed, stableRef: stable }, index: result.index, score: result.score };
  }

  static compatible(type: AssemblyConstraintType, a: AssemblyReference, b?: AssemblyReference): ReferenceValidation {
    if (type === 'fixed') return { valid: true };
    if (!b) return { valid: false, reason: 'A second reference is required.' };
    if (a.componentId === b.componentId) return { valid: false, reason: 'Choose references on different component instances.' };
    const directional = (ref: AssemblyReference) => !!ref.worldDirection;
    const pointLike = (ref: AssemblyReference) => !!ref.worldPoint;
    const planar = (ref: AssemblyReference) =>
      ref.subshapeType === 'plane'
      || (ref.subshapeType === 'face' && ref.stableRef?.kind === 'face' && ref.stableRef.surf === 'plane');
    const axial = (ref: AssemblyReference) =>
      ref.subshapeType === 'axis'
      || ref.radius != null
      || (ref.stableRef?.kind === 'face' && ref.stableRef.surf === 'cylinder')
      || (ref.stableRef?.kind === 'edge' && ref.stableRef.curve === 'circle');
    const point = (ref: AssemblyReference) => ref.subshapeType === 'vertex' || ref.subshapeType === 'origin';
    const line = (ref: AssemblyReference) => ref.subshapeType === 'axis' || ref.subshapeType === 'edge';
    if (type === 'coincident' || type === 'planar') {
      return planar(a) && planar(b) && directional(a) && directional(b)
        ? { valid: true } : { valid: false, reason: 'Coincident/planar references require two planar faces.' };
    }
    if (type === 'concentric' || type === 'axial') {
      return directional(a) && directional(b) && axial(a) && axial(b)
        ? { valid: true } : { valid: false, reason: 'Concentric/axial references require circular, cylindrical, or axis references.' };
    }
    if (type === 'parallel' || type === 'perpendicular' || type === 'angle') {
      return directional(a) && directional(b) ? { valid: true } : { valid: false, reason: 'Directional references are required.' };
    }
    if (type === 'point-on-point') {
      return point(a) && point(b) && pointLike(a) && pointLike(b)
        ? { valid: true } : { valid: false, reason: 'Point-on-point requires two vertices or origins.' };
    }
    if (type === 'point-on-line') {
      return ((point(a) && line(b)) || (line(a) && point(b))) && pointLike(a) && pointLike(b)
        ? { valid: true } : { valid: false, reason: 'Point-on-line requires a vertex/origin and an edge/axis.' };
    }
    if (type === 'point-on-plane') {
      return ((point(a) && planar(b)) || (planar(a) && point(b))) && pointLike(a) && pointLike(b)
        ? { valid: true } : { valid: false, reason: 'Point-on-plane requires a vertex/origin and a plane/planar face.' };
    }
    if (type === 'distance') {
      return pointLike(a) && pointLike(b) ? { valid: true } : { valid: false, reason: 'Point-bearing references are required.' };
    }
    return { valid: true };
  }
}
