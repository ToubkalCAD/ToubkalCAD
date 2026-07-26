import type { CADNode } from '../store/cadStore';
import type { AssemblyComponentData, AssemblyDocumentData } from './types';
import { DEFAULT_ASSEMBLY_DATA, isAssemblyComponentData, isAssemblyDocumentData } from './types';
import { normalizeComponentTransform } from './transforms';

/** Normalize legacy/project JSON into the Phase A assembly schema. */
export function migrateAssemblyNodes(input: Record<string, CADNode>): Record<string, CADNode> {
  const nodes: Record<string, CADNode> = { ...input };

  for (const id of Object.keys(nodes)) {
    const node = nodes[id];
    if (node.type === 'assembly_component') {
      const raw = node.params?.assemblyComponent;
      const assemblyId = isAssemblyComponentData(raw) ? raw.assemblyId : (node.parentId ?? '');
      const partId = isAssemblyComponentData(raw) ? raw.partId : String(node.params?.partId ?? '');
      const data: AssemblyComponentData = {
        schemaVersion: 1,
        assemblyId,
        partId,
        instanceId: id,
        suppressed: isAssemblyComponentData(raw) ? raw.suppressed : false,
        fixed: isAssemblyComponentData(raw) ? raw.fixed : !!node.locked,
        missingPart: nodes[partId]?.type !== 'component',
      };
      nodes[id] = {
        ...node,
        locked: data.fixed,
        transform: normalizeComponentTransform(node.transform),
        params: { ...node.params, assemblyComponent: data },
      };
    }
  }

  for (const id of Object.keys(nodes)) {
    const node = nodes[id];
    if (node.type !== 'assembly') continue;
    const raw = isAssemblyDocumentData(node.params?.assembly)
      ? node.params!.assembly as AssemblyDocumentData
      : DEFAULT_ASSEMBLY_DATA();
    const componentIds = node.children.filter((childId) => nodes[childId]?.type === 'assembly_component');
    const constraints = Object.fromEntries(Object.entries(raw.constraints).map(([constraintId, constraint]) => {
      const referenceMissing = (reference: typeof constraint.referenceA) => {
        const componentData = nodes[reference.componentId]?.params?.assemblyComponent;
        return !isAssemblyComponentData(componentData)
          || componentData.partId !== reference.partId
          || nodes[reference.partId]?.type !== 'component'
          || (!!reference.sourceNodeId && !nodes[reference.sourceNodeId]);
      };
      const missing = referenceMissing(constraint.referenceA)
        || (!!constraint.referenceB && referenceMissing(constraint.referenceB));
      return [constraintId, missing ? { ...constraint, status: 'missing-reference' as const } : constraint];
    }));
    nodes[id] = {
      ...node,
      params: {
        ...node.params,
        assembly: {
          ...raw,
          componentIds,
          constraints,
          constraintIds: raw.constraintIds.filter((constraintId) => !!constraints[constraintId]),
        } satisfies AssemblyDocumentData,
      },
    };
  }

  return nodes;
}
