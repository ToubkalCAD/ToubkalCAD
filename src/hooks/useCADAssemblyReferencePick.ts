import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { AssemblyReferenceService, assemblyComponentWorldMatrix } from '../assembly/AssemblyReferenceService';
import type { AssemblyReference } from '../assembly/types';
import { isAssemblyComponentData } from '../assembly/types';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { FacePicker, type FaceHit } from '../services/FacePicker';
import { OccEdgeService } from '../services/OccEdgeService';
import { useCADStore } from '../store/cadStore';
import { WasmScope } from '../utils/WasmScope';

const CLICK_SLOP = 5;
const IDLE = 0x4f8fd8;
const HOVER = 0x00e0a0;

type PickMeta =
  | { type: 'edge' | 'vertex'; componentId: string; sourceNodeId: string; index: number }
  | { type: 'origin'; componentId: string; name: 'origin' }
  | { type: 'axis'; componentId: string; name: 'X' | 'Y' | 'Z' }
  | { type: 'plane'; componentId: string; name: 'XY' | 'XZ' | 'YZ' };

function visibleAssemblyMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.userData?.assemblyComponentId || !object.userData?.sourceNodeId) return;
    let visible = object.visible;
    for (let parent = object.parent; visible && parent; parent = parent.parent) visible = parent.visible;
    if (visible) result.push(object);
  });
  return result;
}

function extractedVertices(oc: any, shape: any): Array<{ index: number; point: [number, number, number] }> {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  const explorer = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (explorer.More()) { map.Add(explorer.Current()); explorer.Next(); }
  explorer.delete();
  const result: Array<{ index: number; point: [number, number, number] }> = [];
  try {
    for (let index = 1; index <= map.Extent(); index++) {
      const scope = new WasmScope();
      try {
        const vertex = scope.keep(oc.TopoDS.Vertex_1(map.FindKey(index)));
        const point = scope.keep(oc.BRep_Tool.Pnt(vertex));
        result.push({ index: index - 1, point: [point.X(), point.Y(), point.Z()] });
      } finally {
        scope.free();
      }
    }
  } finally {
    map.delete();
  }
  return result;
}

function materialFor(object: THREE.Object3D): THREE.Color | null {
  const material = (object as THREE.Line | THREE.Mesh | THREE.Points).material;
  const candidate = Array.isArray(material) ? material[0] : material;
  return candidate && 'color' in candidate ? (candidate as THREE.Material & { color: THREE.Color }).color : null;
}

export function useCADAssemblyReferencePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef: React.RefObject<THREE.Scene | null>,
  cameraRef: React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((state) => state.interactionMode);
  const pickType = useCADStore((state) => state.assemblyReferencePickType);
  const overlaysRef = useRef<THREE.Object3D[]>([]);
  const faceHighlightRef = useRef<THREE.Mesh | null>(null);
  const hoverRef = useRef<THREE.Object3D | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const scene = sceneRef.current;
    if (!container || !scene) return;

    const clear = () => {
      if (faceHighlightRef.current) {
        scene.remove(faceHighlightRef.current);
        faceHighlightRef.current.geometry.dispose();
        (faceHighlightRef.current.material as THREE.Material).dispose();
        faceHighlightRef.current = null;
      }
      for (const object of overlaysRef.current) {
        scene.remove(object);
        const renderable = object as THREE.Line | THREE.Mesh | THREE.Points;
        renderable.geometry?.dispose();
        const material = renderable.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose();
      }
      overlaysRef.current = [];
      hoverRef.current = null;
      container.style.cursor = 'default';
      window.cadRequestRender?.();
    };

    clear();
    if (mode !== 'ASSEMBLY_REFERENCE_PICK' || !pickType || !window.oc) return clear;

    const nodes = useCADStore.getState().nodes;
    const add = (object: THREE.Object3D, meta: PickMeta) => {
      object.userData.assemblyReferenceMeta = meta;
      object.renderOrder = 1000;
      scene.add(object);
      overlaysRef.current.push(object);
    };

    if (pickType === 'edge' || pickType === 'vertex') {
      for (const mesh of visibleAssemblyMeshes(scene)) {
        const componentId = mesh.userData.assemblyComponentId as string;
        const sourceNodeId = mesh.userData.sourceNodeId as string;
        const shape = CADGeometryRegistry.getInstance().getShape(sourceNodeId);
        if (!shape) continue;
        mesh.updateWorldMatrix(true, false);
        if (pickType === 'edge') {
          for (const edge of OccEdgeService.extractEdges(window.oc, shape)) {
            const points = edge.points.map((point) => new THREE.Vector3(...point).applyMatrix4(mesh.matrixWorld));
            const line = new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(points),
              new THREE.LineBasicMaterial({ color: IDLE, transparent: true, opacity: 0.9, depthTest: true }),
            );
            add(line, { type: 'edge', componentId, sourceNodeId, index: edge.index });
          }
        } else {
          for (const vertex of extractedVertices(window.oc, shape)) {
            const world = new THREE.Vector3(...vertex.point).applyMatrix4(mesh.matrixWorld);
            const point = new THREE.Points(
              new THREE.BufferGeometry().setFromPoints([world]),
              new THREE.PointsMaterial({ color: IDLE, size: 7, sizeAttenuation: false, depthTest: true }),
            );
            add(point, { type: 'vertex', componentId, sourceNodeId, index: vertex.index });
          }
        }
      }
    } else if (pickType === 'origin' || pickType === 'axis' || pickType === 'plane') {
      for (const component of Object.values(nodes)) {
        const data = component.params?.assemblyComponent;
        if (component.type !== 'assembly_component' || !isAssemblyComponentData(data)
            || !component.visible || data.suppressed || data.missingPart) continue;
        const matrix = assemblyComponentWorldMatrix(nodes, component.id);
        const origin = new THREE.Vector3().applyMatrix4(matrix);
        if (pickType === 'origin') {
          const point = new THREE.Points(
            new THREE.BufferGeometry().setFromPoints([origin]),
            new THREE.PointsMaterial({ color: IDLE, size: 9, sizeAttenuation: false }),
          );
          add(point, { type: 'origin', componentId: component.id, name: 'origin' });
        } else if (pickType === 'axis') {
          for (const [name, vector] of Object.entries({
            X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1),
          }) as Array<['X' | 'Y' | 'Z', THREE.Vector3]>) {
            vector.transformDirection(matrix);
            const line = new THREE.Line(
              new THREE.BufferGeometry().setFromPoints([
                origin.clone().addScaledVector(vector, -20), origin.clone().addScaledVector(vector, 20),
              ]),
              new THREE.LineBasicMaterial({ color: IDLE, transparent: true, opacity: 0.9 }),
            );
            add(line, { type: 'axis', componentId: component.id, name });
          }
        } else {
          for (const name of ['XY', 'XZ', 'YZ'] as const) {
            const reference = AssemblyReferenceService.standard(nodes, component.id, 'plane', name);
            const u = new THREE.Vector3(...reference.worldUAxis!);
            const v = new THREE.Vector3(...reference.worldVAxis!);
            const positions: number[] = [];
            for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
              const point = origin.clone().addScaledVector(u, a * 12).addScaledVector(v, b * 12);
              positions.push(point.x, point.y, point.z);
            }
            const plane = new THREE.Mesh(
              new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)),
              new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
            );
            add(plane, { type: 'plane', componentId: component.id, name });
          }
        }
      }
    }

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 0.7 };
    raycaster.params.Points = { threshold: 1.2 };
    const ndc = new THREE.Vector2();
    const down = { x: 0, y: 0, active: false };

    const setRay = (event: MouseEvent) => {
      const camera = cameraRef.current;
      if (!camera) return false;
      const rect = container.getBoundingClientRect();
      ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return true;
    };
    const faceAt = (event: MouseEvent): FaceHit | null => {
      if (!setRay(event)) return null;
      const hit = FacePicker.raycast(raycaster, scene, true);
      return hit?.assemblyComponentId ? hit : null;
    };
    const overlayAt = (event: MouseEvent): THREE.Object3D | null => {
      if (!setRay(event)) return null;
      return raycaster.intersectObjects(overlaysRef.current, false)[0]?.object ?? null;
    };
    const setHover = (object: THREE.Object3D | null) => {
      if (hoverRef.current === object) return;
      if (hoverRef.current) materialFor(hoverRef.current)?.setHex(IDLE);
      hoverRef.current = object;
      if (object) materialFor(object)?.setHex(HOVER);
      container.style.cursor = object ? 'crosshair' : 'default';
      window.cadRequestRender?.();
    };
    const onMove = (event: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'ASSEMBLY_REFERENCE_PICK') return;
      if (pickType === 'face') {
        const hit = faceAt(event);
        if (faceHighlightRef.current) {
          scene.remove(faceHighlightRef.current);
          faceHighlightRef.current.geometry.dispose();
          (faceHighlightRef.current.material as THREE.Material).dispose();
          faceHighlightRef.current = null;
        }
        if (hit) {
          faceHighlightRef.current = FacePicker.makeHighlight(hit.mesh, hit.group, { color: HOVER, opacity: 0.38 });
          scene.add(faceHighlightRef.current);
        }
        container.style.cursor = hit ? 'crosshair' : 'default';
        window.cadRequestRender?.();
      } else {
        setHover(overlayAt(event));
      }
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      down.x = event.clientX; down.y = event.clientY; down.active = true;
    };
    const onUp = (event: MouseEvent) => {
      if (event.button !== 0 || !down.active) return;
      down.active = false;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP) return;
      try {
        let reference: AssemblyReference | null = null;
        if (pickType === 'face') {
          const hit = faceAt(event);
          if (hit?.assemblyComponentId) {
            reference = AssemblyReferenceService.captureFace(
              window.oc, nodes, hit.assemblyComponentId, hit.sourceNodeId, hit.faceIndex,
            );
          }
        } else {
          const object = overlayAt(event);
          const meta = object?.userData?.assemblyReferenceMeta as PickMeta | undefined;
          if (meta?.type === 'edge') {
            reference = AssemblyReferenceService.captureEdge(window.oc, nodes, meta.componentId, meta.sourceNodeId, meta.index);
          } else if (meta?.type === 'vertex') {
            reference = AssemblyReferenceService.captureVertex(window.oc, nodes, meta.componentId, meta.sourceNodeId, meta.index);
          } else if (meta && 'name' in meta) {
            reference = AssemblyReferenceService.standard(nodes, meta.componentId, meta.type, meta.name);
          }
        }
        if (reference) {
          event.stopPropagation();
          useCADStore.getState().setPickedAssemblyReference(reference);
          useCADStore.getState().log(`Captured persistent reference: ${reference.referenceName}.`, 'success');
        }
      } catch (error: any) {
        useCADStore.getState().log(`Reference capture failed: ${error?.message ?? error}`, 'error');
      }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup', onUp, true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup', onUp, true);
      clear();
    };
  }, [mode, pickType, containerRef, sceneRef, cameraRef]);
}
