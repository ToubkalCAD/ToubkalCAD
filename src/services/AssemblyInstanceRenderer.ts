import * as THREE from 'three';
import type { CADNode } from '../store/cadStore';
import { isAssemblyComponentData } from '../assembly/types';
import { applyTransformToObject } from '../assembly/transforms';
import { ThreeMeshCache } from './ThreeMeshCache';

function descendantIds(nodes: Record<string, CADNode>, rootId: string): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    const node = nodes[id];
    if (!node) return;
    for (const childId of node.children) {
      out.push(childId);
      visit(childId);
    }
  };
  visit(rootId);
  return out;
}

export class AssemblyInstanceRenderer {
  private groups = new Map<string, THREE.Group>();
  private hiddenSourceIds = new Set<string>();

  sync(scene: THREE.Scene, nodes: Record<string, CADNode>): void {
    for (const sourceId of this.hiddenSourceIds) {
      const source = ThreeMeshCache.getInstance().getMesh(sourceId);
      if (source) source.visible = nodes[sourceId]?.visible ?? false;
    }
    this.hiddenSourceIds.clear();

    const liveIds = new Set(
      Object.values(nodes).filter((node) => node.type === 'assembly_component').map((node) => node.id),
    );
    for (const id of [...this.groups.keys()]) {
      if (!liveIds.has(id)) this.remove(scene, id);
    }
    for (const node of Object.values(nodes)) {
      if (node.type === 'assembly_component') this.rebuild(scene, nodes, node.id);
    }
    for (const node of Object.values(nodes)) {
      const data = node.params?.assemblyComponent;
      if (node.type !== 'assembly_component' || !isAssemblyComponentData(data) || !data.parentComponentId) continue;
      const child = this.groups.get(node.id);
      const parent = this.groups.get(data.parentComponentId);
      if (child && parent) parent.add(child);
    }

    // Part definitions remain editable metadata/feature trees, while their
    // source meshes are hidden when at least one placed instance renders them.
    for (const node of Object.values(nodes)) {
      const data = node.params?.assemblyComponent;
      if (node.type !== 'assembly_component' || !isAssemblyComponentData(data) || data.missingPart) continue;
      for (const sourceId of descendantIds(nodes, data.partId)) {
        const source = ThreeMeshCache.getInstance().getMesh(sourceId);
        if (source) {
          source.visible = false;
          this.hiddenSourceIds.add(sourceId);
        }
      }
    }
  }

  rebuild(scene: THREE.Scene, nodes: Record<string, CADNode>, instanceId: string): void {
    this.remove(scene, instanceId);
    const node = nodes[instanceId];
    const data = node?.params?.assemblyComponent;
    if (!node || node.type !== 'assembly_component' || !isAssemblyComponentData(data)) return;

    const group = new THREE.Group();
    group.name = `Assembly instance: ${node.name}`;
    group.userData = {
      cadNodeId: instanceId,
      assemblyComponentId: instanceId,
      referencedPartId: data.partId,
    };
    applyTransformToObject(group, node.transform);
    group.visible = node.visible && !data.suppressed && !data.missingPart;

    for (const sourceId of descendantIds(nodes, data.partId)) {
      const sourceNode = nodes[sourceId];
      if (!sourceNode || !sourceNode.visible) continue;
      const sourceMesh = ThreeMeshCache.getInstance().getMesh(sourceId);
      if (!sourceMesh) continue;
      const clone = new THREE.Mesh(sourceMesh.geometry, cloneMaterial(sourceMesh.material));
      clone.castShadow = sourceMesh.castShadow;
      clone.receiveShadow = sourceMesh.receiveShadow;
      clone.position.copy(sourceMesh.position);
      clone.quaternion.copy(sourceMesh.quaternion);
      clone.scale.copy(sourceMesh.scale);
      clone.userData = {
        ...sourceMesh.userData,
        cadNodeId: instanceId,
        assemblyComponentId: instanceId,
        sourceNodeId: sourceId,
        referencedPartId: data.partId,
      };
      group.add(clone);
    }

    scene.add(group);
    this.groups.set(instanceId, group);
  }

  applyTransform(instanceId: string, node: CADNode): void {
    const group = this.groups.get(instanceId);
    if (group) applyTransformToObject(group, node.transform);
  }

  updateVisibility(instanceId: string, visible: boolean, suppressed: boolean): void {
    const group = this.groups.get(instanceId);
    if (group) group.visible = visible && !suppressed;
  }

  getGroup(instanceId: string): THREE.Group | undefined {
    return this.groups.get(instanceId);
  }

  remove(scene: THREE.Scene, instanceId: string): void {
    const group = this.groups.get(instanceId);
    if (!group) return;
    group.removeFromParent();
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material.dispose();
    });
    this.groups.delete(instanceId);
  }

  clear(scene: THREE.Scene): void {
    for (const id of [...this.groups.keys()]) this.remove(scene, id);
  }
}

function cloneMaterial(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  return Array.isArray(material) ? material.map((entry) => entry.clone()) : material.clone();
}
