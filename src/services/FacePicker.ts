// ============================================================
// ToubkalCAD – FacePicker.ts
//
// Resolves a Three.js raycast hit on a real CAD solid mesh back to the OCC
// face it landed on, using the per-face draw groups that OccConverter stamps
// into `geometry.userData.faceGroups`. Works for ANY face (planar or curved)
// because it rides the real tessellated mesh — no per-face overlay clones.
//
// The returned `faceIndex` is the face's 0-based ordinal in the shape's
// TopExp_Explorer face order, the same key OccFaceService.planeFromFaceIndex
// and OccFaceService.extractPlanarFaces use — so a hit maps straight to a
// native TopoDS_Face (re-explored on demand; no WASM handles retained here).
// ============================================================

import * as THREE from 'three';
import type { OccFaceGroup } from './OccConverter';

export interface FaceHit {
  /** The cad node the picked solid belongs to (mesh.userData.cadNodeId). */
  nodeId:    string;
  /** Source feature/body id for assembly-instance clones; equals nodeId otherwise. */
  sourceNodeId: string;
  assemblyComponentId?: string;
  referencedPartId?: string;
  /** 0-based TopExp_Explorer face ordinal. */
  faceIndex: number;
  mesh:      THREE.Mesh;
  group:     OccFaceGroup;
  /** World-space ray-hit point. */
  point:     THREE.Vector3;
}

export class FacePicker {
  /** Real CAD solid meshes — excludes overlays, datum helpers, grids, gizmos. */
  static pickableMeshes(scene: THREE.Scene, includeAssemblyInstances = false): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    scene.traverse((object) => {
      let visible = object.visible;
      for (let parent = object.parent; visible && parent; parent = parent.parent) visible = parent.visible;
      if (visible && object instanceof THREE.Mesh && object.userData?.cadNodeId
          && (includeAssemblyInstances || !object.userData?.assemblyComponentId)) meshes.push(object);
    });
    return meshes;
  }

  /** Map a single intersection to the OCC face it hit (null if not a CAD mesh
   *  or the geometry predates the faceGroups stamp). */
  static resolveHit(hit: THREE.Intersection): FaceHit | null {
    const mesh   = hit.object as THREE.Mesh;
    const nodeId = mesh.userData?.cadNodeId as string | undefined;
    if (!nodeId || hit.faceIndex == null) return null;

    const geo    = mesh.geometry as THREE.BufferGeometry;
    const groups = geo.userData?.faceGroups as OccFaceGroup[] | undefined;
    if (!groups) return null;

    const indexPos = hit.faceIndex * 3;   // triangle ordinal → index-buffer offset
    const group = groups.find((g) => indexPos >= g.start && indexPos < g.start + g.count);
    if (!group) return null;

    return {
      nodeId,
      sourceNodeId: (mesh.userData?.sourceNodeId as string | undefined) ?? nodeId,
      assemblyComponentId: mesh.userData?.assemblyComponentId as string | undefined,
      referencedPartId: mesh.userData?.referencedPartId as string | undefined,
      faceIndex: group.face,
      mesh,
      group,
      point: hit.point.clone(),
    };
  }

  /** Cast against all CAD meshes and return the nearest resolved face hit. */
  static raycast(raycaster: THREE.Raycaster, scene: THREE.Scene, includeAssemblyInstances = false): FaceHit | null {
    const hits = raycaster.intersectObjects(this.pickableMeshes(scene, includeAssemblyInstances), false);
    for (const h of hits) {
      const r = this.resolveHit(h);
      if (r) return r;
    }
    return null;
  }

  /** Persistent datum-plane faces (tagged with datumNodeId in Viewport3D). These
   *  live inside groups, so we traverse to reach the leaf meshes. */
  static datumMeshes(scene: THREE.Scene): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    scene.traverse((o) => { if (o instanceof THREE.Mesh && o.userData?.datumNodeId) out.push(o); });
    return out;
  }

  /** Nearest pick across BOTH solid faces and datum planes, with correct
   *  occlusion (a datum behind a solid won't be picked through it). */
  static raycastFacesAndDatums(
    raycaster: THREE.Raycaster, scene: THREE.Scene,
  ):
    | { kind: 'face';  hit: FaceHit }
    | { kind: 'datum'; nodeId: string; mesh: THREE.Mesh; point: THREE.Vector3 }
    | null {
    const targets = [...this.pickableMeshes(scene), ...this.datumMeshes(scene)];
    const hits = raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const o = h.object as THREE.Mesh;
      if (o.userData?.cadNodeId) {
        const hit = this.resolveHit(h);
        if (hit) return { kind: 'face', hit };
      } else if (o.userData?.datumNodeId) {
        return { kind: 'datum', nodeId: o.userData.datumNodeId as string, mesh: o, point: h.point.clone() };
      }
    }
    return null;
  }

  /** A ready-to-add translucent highlight mesh for one picked face. Geometry is
   *  baked in world space, so add it straight to the scene (matrixAutoUpdate off). */
  static makeHighlight(
    mesh: THREE.Mesh, group: OccFaceGroup,
    opts: { color?: number; opacity?: number; renderOrder?: number } = {},
  ): THREE.Mesh {
    const { color = 0x00e0a0, opacity = 0.32, renderOrder = 999 } = opts;
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const hl = new THREE.Mesh(this.faceHighlightGeometry(mesh, group), mat);
    hl.renderOrder = renderOrder;
    hl.matrixAutoUpdate = false;   // geometry already in world space
    return hl;
  }

  /** Build a standalone geometry covering ONLY the picked face's triangles, in
   *  world space (the source mesh's matrixWorld is baked in), ready to drop into
   *  the scene as a hover/selection highlight. */
  static faceHighlightGeometry(mesh: THREE.Mesh, group: OccFaceGroup): THREE.BufferGeometry {
    const src   = mesh.geometry as THREE.BufferGeometry;
    const pos    = src.getAttribute('position') as THREE.BufferAttribute;
    const index  = src.getIndex();
    const out: number[] = [];

    if (index) {
      for (let i = group.start; i < group.start + group.count; i++) {
        const v = index.getX(i);
        out.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    g.applyMatrix4(mesh.matrixWorld);    // local → world (the highlight isn't parented)
    g.computeVertexNormals();
    return g;
  }
}
