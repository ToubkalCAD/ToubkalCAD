import type { AssemblyInterferencePair, AssemblyInterferenceReport } from '../assembly/types';
import { isAssemblyComponentData, isAssemblyDocumentData } from '../assembly/types';
import type { CADNode } from '../store/cadStore';
import { AssemblyBRepService } from './AssemblyBRepService';

type Box = [number, number, number, number, number, number];

function boxesOverlap(a: Box, b: Box, tolerance: number): boolean {
  return a[0] <= b[3] + tolerance && a[3] + tolerance >= b[0]
    && a[1] <= b[4] + tolerance && a[4] + tolerance >= b[1]
    && a[2] <= b[5] + tolerance && a[5] + tolerance >= b[2];
}

function overlapVolume(oc: any, shapeA: any, shapeB: any): number {
  const progress = new oc.Message_ProgressRange_1();
  const common = new oc.BRepAlgoAPI_Common_3(shapeA, shapeB, progress);
  try {
    if (!common.IsDone()) return 0;
    const result = common.Shape();
    const props = new oc.GProp_GProps_1();
    try {
      oc.BRepGProp.VolumeProperties_1(result, props, true, false, false);
      return Math.max(0, props.Mass());
    } finally {
      props.delete();
      result.delete?.();
    }
  } finally {
    common.delete();
    progress.delete();
  }
}

function minimumDistance(oc: any, shapeA: any, shapeB: any): number {
  const progress = new oc.Message_ProgressRange_1();
  const extrema = new oc.BRepExtrema_DistShapeShape_2(
    shapeA, shapeB, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
    oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Tree, progress,
  );
  try {
    extrema.Perform(progress);
    return extrema.IsDone() && extrema.NbSolution() > 0 ? extrema.Value() : Number.POSITIVE_INFINITY;
  } finally {
    extrema.delete();
    progress.delete();
  }
}

/**
 * OCC objects are bound to the page's WASM runtime and cannot be posted to a
 * generic worker. Pair checks therefore run in small yielded batches so larger
 * assemblies keep painting while preserving exact B-Rep narrow-phase queries.
 */
export class AssemblyInterferenceService {
  static async check(
    oc: any,
    nodes: Record<string, CADNode>,
    assemblyId: string,
    selectedComponentIds: string[] = [],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<AssemblyInterferenceReport> {
    const assembly = nodes[assemblyId];
    const data = assembly?.params?.assembly;
    if (!assembly || !isAssemblyDocumentData(data)) throw new Error('Select a valid assembly.');
    const selected = new Set(selectedComponentIds);
    const restrict = selected.size >= 2;
    const componentIds = data.componentIds.filter((id) => {
      const node = nodes[id];
      const component = node?.params?.assemblyComponent;
      return !!node && node.visible && isAssemblyComponentData(component)
        && !component.suppressed && !component.missingPart && (!restrict || selected.has(id));
    });

    const shapes = new Map<string, any>();
    const boxes = new Map<string, Box>();
    const errors: string[] = [];
    try {
      for (const id of componentIds) {
        try {
          const shape = AssemblyBRepService.buildComponentCompound(oc, nodes, id);
          shapes.set(id, shape);
          boxes.set(id, AssemblyBRepService.boundingBox(oc, shape));
        } catch (error) {
          errors.push(`${nodes[id]?.name ?? id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const candidates: Array<[string, string]> = [];
      const live = componentIds.filter((id) => shapes.has(id));
      for (let i = 0; i < live.length; i += 1) {
        for (let j = i + 1; j < live.length; j += 1) {
          if (boxesOverlap(boxes.get(live[i])!, boxes.get(live[j])!, 1e-4)) candidates.push([live[i], live[j]]);
        }
      }

      const pairs: AssemblyInterferencePair[] = [];
      for (let i = 0; i < candidates.length; i += 1) {
        const [componentAId, componentBId] = candidates[i];
        try {
          const shapeA = shapes.get(componentAId);
          const shapeB = shapes.get(componentBId);
          const distance = minimumDistance(oc, shapeA, shapeB);
          if (distance <= 1e-4) {
            const volume = overlapVolume(oc, shapeA, shapeB);
            pairs.push({
              componentAId, componentBId, distance, overlapVolume: volume,
              kind: volume > 1e-6 ? 'interference' : 'contact',
            });
          }
        } catch (error) {
          errors.push(`${nodes[componentAId]?.name} / ${nodes[componentBId]?.name}: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
        onProgress?.(i + 1, candidates.length);
        if (i % 3 === 2) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      return {
        assemblyId, checkedComponentIds: live, candidatePairCount: candidates.length, pairs, errors,
      };
    } finally {
      for (const shape of shapes.values()) shape.delete?.();
    }
  }
}
