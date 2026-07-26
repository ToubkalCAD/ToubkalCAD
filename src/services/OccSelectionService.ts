// ============================================================
// ToubkalCAD – OccSelectionService.ts
//
// Handles viewport click → CAD node selection for BOTH:
//  • 3D solid shapes  → THREE.Mesh  (triangulated OCC shapes)
//  • 2D sketch wires  → THREE.Line  (drawn by useCADSketchTool)
//
// Three.js Raycaster does NOT test Lines by default at a useful
// precision. We set raycaster.params.Line.threshold to a world-space
// distance (~0.4 units) which gives comfortable click targets.
// ============================================================

import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';

export class OccSelectionService {
  private static raycaster = new THREE.Raycaster();
  private static mouse     = new THREE.Vector2();

  // World-space distance tolerance for line selection (adjust to taste)
  private static readonly LINE_THRESHOLD = 0.4;

  static handleSceneSelection(
    event:     MouseEvent,
    container: HTMLDivElement,
    camera:    THREE.Camera,
    scene:     THREE.Scene,
  ): void {
    const rect = container.getBoundingClientRect();
    this.mouse.x =  ((event.clientX - rect.left) / container.clientWidth)  * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top)  / container.clientHeight) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, camera);
    this.raycaster.params.Line = { threshold: this.LINE_THRESHOLD };

    // ── Collect selectable objects (Mesh = 3D solids, Line = sketch wires) ─────
    const selectableMeshes: THREE.Mesh[] = [];
    const selectableLines:  THREE.Line[]  = [];

    scene.traverse((obj) => {
      if (!obj.userData?.cadNodeId) return;
      if (obj instanceof THREE.Mesh) selectableMeshes.push(obj);
      else if (obj instanceof THREE.Line) selectableLines.push(obj);
    });

    // ── Raycast against both groups ────────────────────────────────────────────
    const meshHits = this.raycaster.intersectObjects(selectableMeshes, true);
    const lineHits = this.raycaster.intersectObjects(selectableLines,  true);

    // Pick the closest hit from either group
    const bestMesh = meshHits[0] ?? null;
    const bestLine = lineHits[0] ?? null;

    let hitNodeId: string | null = null;
    if (bestMesh && (!bestLine || bestMesh.distance <= bestLine.distance)) {
      let obj: THREE.Object3D | null = bestMesh.object;
      while (obj && !obj.userData?.cadNodeId) obj = obj.parent;
      hitNodeId = obj?.userData?.cadNodeId ?? null;
    } else if (bestLine) {
      // Walk up to the root Line object that carries cadNodeId
      let obj: THREE.Object3D | null = bestLine.object;
      while (obj && !obj.userData?.cadNodeId) obj = obj.parent;
      hitNodeId = obj?.userData?.cadNodeId ?? null;
    }

    // ── Clear previous highlights ──────────────────────────────────────────────
    this.clearHighlights(scene);

    // ── Apply new selection ────────────────────────────────────────────────────
    if (hitNodeId) {
      const prev = useCADStore.getState().selectedIds;
      const ids  = event.ctrlKey || event.metaKey
        ? prev.includes(hitNodeId)
          ? prev.filter((id) => id !== hitNodeId)
          : [...prev, hitNodeId]
        : [hitNodeId];

      useCADStore.getState().setSelectedIds(ids);
      this.applyHighlights(scene, ids);
    } else {
      useCADStore.getState().setSelectedIds([]);
    }
  }

  static applyHighlights(scene: THREE.Scene, ids: string[]): void {
    const idSet = new Set(ids);
    scene.traverse((obj) => {
      if (!obj.userData?.cadNodeId || !idSet.has(obj.userData.cadNodeId)) return;

      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
        obj.material.emissive.setHex(0x1155aa);
        obj.material.emissiveIntensity = 0.35;
      } else if (obj instanceof THREE.Line && obj.material instanceof THREE.LineBasicMaterial) {
        // Brighten the line color to indicate selection
        obj.material.color.setHex(0x00aaff);
        obj.userData._wasSelected = true;
      }
    });
  }

  static clearHighlights(scene: THREE.Scene): void {
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
        obj.material.emissive.setHex(0x000000);
        obj.material.emissiveIntensity = 0;
      } else if (
        obj instanceof THREE.Line &&
        obj.material instanceof THREE.LineBasicMaterial &&
        obj.userData._wasSelected
      ) {
        obj.material.color.setHex(0x003388); // restore commit color
        delete obj.userData._wasSelected;
      }
    });
  }
}
