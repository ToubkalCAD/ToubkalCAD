import type { CADNode } from '../store/cadStore';
import type { Matrix4 } from 'three';
import { isAssemblyComponentData } from '../assembly/types';
import { componentTransformToMatrix, matrixToOccTransform } from '../assembly/transforms';
import { WasmScope } from '../utils/WasmScope';
import { CADGeometryRegistry } from './CADGeometryRegistry';

function descendantIds(nodes: Record<string, CADNode>, id: string): string[] {
  const result: string[] = [];
  const visit = (nodeId: string) => {
    for (const childId of nodes[nodeId]?.children ?? []) {
      result.push(childId);
      visit(childId);
    }
  };
  visit(id);
  return result;
}

function componentWorldMatrix(nodes: Record<string, CADNode>, id: string): Matrix4 {
  const node = nodes[id];
  const local = componentTransformToMatrix(node.transform);
  const data = node.params?.assemblyComponent;
  return isAssemblyComponentData(data) && data.parentComponentId && nodes[data.parentComponentId]
    ? componentWorldMatrix(nodes, data.parentComponentId).multiply(local)
    : local;
}

/**
 * Builds an owned OCC compound for downstream assembly measurements, export,
 * interference checks, and constraint reference evaluation. Display instances
 * stay lightweight in Three.js; this method creates transformed BRep copies only
 * when a geometric operation actually needs them.
 */
export class AssemblyBRepService {
  static buildComponentCompound(oc: any, nodes: Record<string, CADNode>, componentId: string): any {
    const component = nodes[componentId];
    const data = component?.params?.assemblyComponent;
    if (!component || !isAssemblyComponentData(data)) throw new Error('Invalid assembly component.');
    if (data.missingPart) throw new Error(`Missing part definition "${data.partId}".`);

    const scope = new WasmScope();
    const builder = scope.keep(new oc.BRep_Builder());
    const compound = new oc.TopoDS_Compound();
    try {
      builder.MakeCompound(compound);
      const trsf = scope.keep(matrixToOccTransform(oc, componentWorldMatrix(nodes, componentId)));
      for (const sourceId of descendantIds(nodes, data.partId)) {
        const shape = CADGeometryRegistry.getInstance().getShape(sourceId);
        if (!shape) continue;
        const transformed = scope.keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
        if (transformed.IsDone()) builder.Add(compound, scope.keep(transformed.Shape()));
      }
      return compound;
    } catch (error) {
      compound.delete();
      throw error;
    } finally {
      scope.free();
    }
  }

  static boundingBox(oc: any, shape: any): [number, number, number, number, number, number] {
    const box = new oc.Bnd_Box_1();
    try {
      oc.BRepBndLib.Add(shape, box, true);
      const xMin = { value: 0 }, yMin = { value: 0 }, zMin = { value: 0 };
      const xMax = { value: 0 }, yMax = { value: 0 }, zMax = { value: 0 };
      box.Get(xMin, yMin, zMin, xMax, yMax, zMax);
      return [xMin.value, yMin.value, zMin.value, xMax.value, yMax.value, zMax.value];
    } finally {
      box.delete();
    }
  }
}
