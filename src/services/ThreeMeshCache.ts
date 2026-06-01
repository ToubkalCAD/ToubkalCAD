// ============================================================
// AtlasCAD – ThreeMeshCache.ts  (v2 – corrigé)
// Cache des maillages Three.js.
// Corrections v2 :
//   • getOrCreateMesh accepte un CADNode optionnel pour
//     appliquer la couleur/matériau du store immédiatement
//   • invalidateMesh recrée ET ré-applique le matériau
//   • disposeMesh libère proprement géométrie + matériau
// ============================================================

import * as THREE from 'three';
import { OccConverter }      from './OccConverter';
import { CADGeometryRegistry } from './CADGeometryRegistry';
import type { CADNode, CADMaterial } from '../store/cadStore';

export class ThreeMeshCache {
  private static instance: ThreeMeshCache | null = null;
  private meshMap = new Map<string, THREE.Mesh>();

  public static getInstance(): ThreeMeshCache {
    if (!ThreeMeshCache.instance) {
      ThreeMeshCache.instance = new ThreeMeshCache();
    }
    return ThreeMeshCache.instance;
  }

  // ─── Créer ou récupérer un maillage ────────────────────────────────────────
  public getOrCreateMesh(
    id:         string,
    oc:         any,
    deflection: number   = 0.1,
    nodeMat?:   CADMaterial,
  ): THREE.Mesh {
    if (this.meshMap.has(id)) return this.meshMap.get(id)!;

    const shape = CADGeometryRegistry.getInstance().getShape(id);
    if (!shape) throw new Error(`[ThreeMeshCache] Forme introuvable : ${id}`);

    const geometry = OccConverter.shapeToThreeGeometry(oc, shape, deflection);

    const material = new THREE.MeshStandardMaterial({
      color:       nodeMat ? nodeMat.color      : 0x5588cc,
      roughness:   nodeMat ? nodeMat.roughness  : 0.4,
      metalness:   nodeMat ? nodeMat.metalness  : 0.3,
      wireframe:   nodeMat ? nodeMat.wireframe  : false,
      opacity:     nodeMat ? nodeMat.opacity    : 1.0,
      transparent: nodeMat ? nodeMat.transparent : false,
      side:        THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData      = { cadNodeId: id };

    this.meshMap.set(id, mesh);
    return mesh;
  }

  // ─── Appliquer un matériau sur un maillage existant ─────────────────────────
  public applyMaterial(id: string, mat: Partial<CADMaterial>): void {
    const mesh = this.meshMap.get(id);
    if (!mesh || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
    if (mat.color       !== undefined) mesh.material.color.setHex(mat.color);
    if (mat.roughness   !== undefined) mesh.material.roughness  = mat.roughness;
    if (mat.metalness   !== undefined) mesh.material.metalness  = mat.metalness;
    if (mat.wireframe   !== undefined) mesh.material.wireframe  = mat.wireframe;
    if (mat.opacity     !== undefined) {
      mesh.material.opacity     = mat.opacity;
      mesh.material.transparent = mat.opacity < 1;
    }
    mesh.material.needsUpdate = true;
  }

  // ─── Invalider (recalculer facettisation) ───────────────────────────────────
  public invalidateMesh(
    id:    string,
    scene: THREE.Scene,
    oc:    any,
    mat?:  CADMaterial,
  ): THREE.Mesh {
    this.disposeMesh(id, scene);
    const newMesh = this.getOrCreateMesh(id, oc, 0.1, mat);
    scene.add(newMesh);
    return newMesh;
  }

  // ─── Supprimer un maillage ─────────────────────────────────────────────────
  public disposeMesh(id: string, scene: THREE.Scene): void {
    const mesh = this.meshMap.get(id);
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => m.dispose());
    } else if (mesh.material instanceof THREE.Material) {
      mesh.material.dispose();
    }
    this.meshMap.delete(id);
    console.log(`[VRAM] Maillage libéré : ${id}`);
  }

  // ─── Tout supprimer ────────────────────────────────────────────────────────
  public clearAll(scene: THREE.Scene): void {
    for (const id of [...this.meshMap.keys()]) {
      this.disposeMesh(id, scene);
    }
  }

  public hasMesh(id: string): boolean {
    return this.meshMap.has(id);
  }

  public getMesh(id: string): THREE.Mesh | undefined {
    return this.meshMap.get(id);
  }
}
