export type Vec3 = [number, number, number];

/**
 * Assembly transforms use millimetres, radians, XYZ Euler order, and a
 * column-major 4x4 matrix compatible with THREE.Matrix4.toArray().
 */
export interface ComponentTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  matrix?: number[];
}

export type AssemblyConstraintType =
  | 'fixed'
  | 'coincident'
  | 'concentric'
  | 'parallel'
  | 'perpendicular'
  | 'distance'
  | 'angle'
  | 'tangent'
  | 'planar'
  | 'axial'
  | 'point-on-point'
  | 'point-on-line'
  | 'point-on-plane';

export type AssemblyConstraintStatus =
  | 'unsolved'
  | 'solved'
  | 'conflicting'
  | 'under-constrained'
  | 'missing-reference';

import type { StableRef } from '../services/StableRef';

export interface AssemblyReference {
  componentId: string;
  partId: string;
  /** Feature/body inside the referenced part definition. */
  sourceNodeId?: string;
  subshapeType: 'face' | 'edge' | 'vertex' | 'axis' | 'origin' | 'plane';
  subshapeId?: string;
  /** Last known ordinal is only a fallback/debug hint; stableRef is authoritative. */
  subshapeIndex?: number;
  referenceName?: string;
  localPoint?: Vec3;
  localDirection?: Vec3;
  localUAxis?: Vec3;
  localVAxis?: Vec3;
  worldPoint?: Vec3;
  worldDirection?: Vec3;
  worldUAxis?: Vec3;
  worldVAxis?: Vec3;
  radius?: number;
  stableRef?: StableRef;
  /** Set when a stored topology signature cannot be resolved during rebuild. */
  resolutionError?: string;
}

export interface AssemblyConstraint {
  id: string;
  assemblyId: string;
  type: AssemblyConstraintType;
  referenceA: AssemblyReference;
  referenceB?: AssemblyReference;
  offset?: number;
  angle?: number;
  enabled: boolean;
  flipped?: boolean;
  status: AssemblyConstraintStatus;
  message?: string;
}

export interface AssemblyConstraintDraft {
  assemblyId: string;
  type: AssemblyConstraintType;
  referenceA?: AssemblyReference;
  referenceB?: AssemblyReference;
  pickSide?: 'A' | 'B';
  offset: number;
  angle: number;
  flipped: boolean;
  previewed: boolean;
  validationMessage?: string;
  originalTransforms: Record<string, ComponentTransform>;
}

export interface ExplodedTransform {
  componentId: string;
  offset: Vec3;
  rotationOffset?: Vec3;
}

export interface AssemblyDocumentData {
  schemaVersion: 1;
  componentIds: string[];
  constraintIds: string[];
  constraints: Record<string, AssemblyConstraint>;
  activeComponentId?: string;
  autoFixFirstComponent: boolean;
  exploded: {
    enabled: boolean;
    factor: number;
    transforms: Record<string, ExplodedTransform>;
  };
}

export interface AssemblyComponentData {
  schemaVersion: 1;
  assemblyId: string;
  partId: string;
  parentComponentId?: string;
  instanceId: string;
  suppressed: boolean;
  fixed: boolean;
  missingPart: boolean;
}

export const DEFAULT_ASSEMBLY_DATA = (): AssemblyDocumentData => ({
  schemaVersion: 1,
  componentIds: [],
  constraintIds: [],
  constraints: {},
  autoFixFirstComponent: true,
  exploded: { enabled: false, factor: 0, transforms: {} },
});

export function isAssemblyDocumentData(value: unknown): value is AssemblyDocumentData {
  const v = value as Partial<AssemblyDocumentData> | null;
  return !!v && v.schemaVersion === 1 && Array.isArray(v.componentIds)
    && Array.isArray(v.constraintIds) && typeof v.constraints === 'object';
}

export function isAssemblyComponentData(value: unknown): value is AssemblyComponentData {
  const v = value as Partial<AssemblyComponentData> | null;
  return !!v && v.schemaVersion === 1 && typeof v.assemblyId === 'string'
    && typeof v.partId === 'string' && typeof v.instanceId === 'string';
}
