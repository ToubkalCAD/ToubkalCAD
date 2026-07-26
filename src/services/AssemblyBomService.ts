import type { AssemblyBomEntry } from '../assembly/types';
import { isAssemblyComponentData, isAssemblyDocumentData } from '../assembly/types';
import type { CADNode } from '../store/cadStore';
import { AssemblyBRepService } from './AssemblyBRepService';
import { OccMeasureService } from './OccMeasureService';

function materialName(nodes: Record<string, CADNode>, partId: string): string | undefined {
  const part = nodes[partId];
  const explicit = part?.params?.materialName;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const body = part?.children.map((id) => nodes[id]).find((node) => node?.visible && node.type !== 'sketch');
  return body ? `#${body.material.color.toString(16).padStart(6, '0').toUpperCase()}` : undefined;
}

export class AssemblyBomService {
  static generate(nodes: Record<string, CADNode>, assemblyId: string, oc?: any): AssemblyBomEntry[] {
    const assembly = nodes[assemblyId];
    const data = assembly?.params?.assembly;
    if (!assembly || !isAssemblyDocumentData(data)) throw new Error('Select a valid assembly.');

    const entries = new Map<string, AssemblyBomEntry>();
    const representative = new Map<string, string>();
    for (const componentId of data.componentIds) {
      const component = nodes[componentId];
      const componentData = component?.params?.assemblyComponent;
      if (!component || !isAssemblyComponentData(componentData) || componentData.missingPart) continue;
      const part = nodes[componentData.partId];
      if (!part) continue;
      const current = entries.get(componentData.partId) ?? {
        partId: componentData.partId,
        partNumber: String(part.params?.partNumber ?? componentData.partId.slice(0, 8).toUpperCase()),
        partName: part.name,
        quantity: 0,
        suppressedQuantity: 0,
        material: materialName(nodes, componentData.partId),
      };
      current.quantity += 1;
      if (componentData.suppressed) current.suppressedQuantity += 1;
      entries.set(componentData.partId, current);
      if (!componentData.suppressed && !representative.has(componentData.partId)) {
        representative.set(componentData.partId, componentId);
      }
    }

    if (oc) {
      for (const [partId, componentId] of representative) {
        const entry = entries.get(partId);
        if (!entry) continue;
        let shape: any;
        try {
          shape = AssemblyBRepService.buildComponentCompound(oc, nodes, componentId);
          const density = Number(nodes[partId]?.params?.density);
          const props = OccMeasureService.getShapeProperties(
            oc, shape, Number.isFinite(density) ? density : 0.00785,
          );
          if (props.mass !== undefined) {
            entry.unitMass = props.mass;
            entry.totalMass = props.mass * (entry.quantity - entry.suppressedQuantity);
          }
        } catch {
          // BOM remains useful when a part has metadata but no rebuilt B-Rep.
        } finally {
          shape?.delete?.();
        }
      }
    }

    return [...entries.values()].sort((a, b) => a.partNumber.localeCompare(b.partNumber));
  }

  static toCSV(entries: AssemblyBomEntry[]): string {
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Part Number', 'Part Name', 'Quantity', 'Suppressed', 'Material', 'Unit Mass (g)', 'Total Mass (g)', 'Document ID'],
      ...entries.map((entry) => [
        entry.partNumber, entry.partName, entry.quantity, entry.suppressedQuantity,
        entry.material ?? '', entry.unitMass?.toFixed(3) ?? '', entry.totalMass?.toFixed(3) ?? '', entry.partId,
      ]),
    ];
    return rows.map((row) => row.map(quote).join(',')).join('\r\n');
  }

  static download(entries: AssemblyBomEntry[], assemblyName: string, format: 'csv' | 'json'): void {
    const body = format === 'csv' ? this.toCSV(entries) : JSON.stringify(entries, null, 2);
    const type = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
    const url = URL.createObjectURL(new Blob([body], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${assemblyName.replace(/[^\w.-]+/g, '_')}_bom.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }
}
