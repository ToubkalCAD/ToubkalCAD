// ============================================================
// ToubkalCAD – useCADSketchFacePick.ts
//
// Track S2 — "sketch on a face".
//
// Active only while interactionMode === 'FACE_SKETCH'. For every visible
// solid in the scene it builds a transparent, raycastable overlay mesh per
// PLANAR face (mirrors the per-edge overlay approach of useCADEdgeSelect).
// Hovering highlights a face; clicking derives a workplane from that face's
// gp_Pln and starts a sketch session on it, then drops into the Line tool.
//
// Click-vs-drag: a press that releases within a few pixels is a pick; a larger
// movement is an OrbitControls rotation and is ignored.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService, PlanarFace } from '../services/OccFaceService';

const COLOR_IDLE  = 0x2a7fd4;
const COLOR_HOVER = 0x00e0a0;
const CLICK_SLOP_PX = 5;

interface FaceMeta extends PlanarFace { nodeId: string; }

export function useCADSketchFacePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);

  const meshesRef = useRef<THREE.Mesh[]>([]);
  const hoverRef  = useRef<THREE.Mesh | null>(null);

  // ─── Build / tear down face overlays when entering/leaving FACE_SKETCH ────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const m of meshesRef.current) {
        scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      meshesRef.current = [];
      hoverRef.current = null;
    };

    dispose();
    if (mode !== 'FACE_SKETCH' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    let faceTotal = 0;

    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible) continue;
      if (node.type === 'sketch' || node.type === 'sketch_wire') continue;
      const shape = reg.getShape(id);
      if (!shape) continue;

      try {
        const faces = OccFaceService.extractPlanarFaces(window.oc, shape);
        for (const f of faces) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({
            color: COLOR_IDLE, transparent: true, opacity: 0.12,
            side: THREE.DoubleSide, depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 998;
          mesh.userData = { isSketchFace: true, face: { ...f, nodeId: id } as FaceMeta };
          scene.add(mesh);
          meshesRef.current.push(mesh);
          faceTotal++;
        }
      } catch (err: any) {
        useCADStore.getState().log(`Face extraction failed for ${node.name}: ${err?.message ?? err}`, 'warn');
      }
    }

    if (faceTotal === 0) useCADStore.getState().log('No planar faces found — create or select a solid first.', 'warn');
    else useCADStore.getState().log(`Pick a planar face to sketch on (${faceTotal} available).`, 'info');

    return dispose;
  }, [mode, sceneRef]);

  // ─── Hover + click-to-start ──────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const pick = (e: MouseEvent): THREE.Mesh | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(meshesRef.current, false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };

    const setHover = (m: THREE.Mesh | null) => {
      if (hoverRef.current === m) return;
      if (hoverRef.current) (hoverRef.current.material as THREE.MeshBasicMaterial).color.setHex(COLOR_IDLE),
        ((hoverRef.current.material as THREE.MeshBasicMaterial).opacity = 0.12);
      hoverRef.current = m;
      if (m) {
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.setHex(COLOR_HOVER); mat.opacity = 0.32;
      }
      container.style.cursor = m ? 'pointer' : 'default';
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'FACE_SKETCH') return;
      setHover(pick(e));
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useCADStore.getState().interactionMode !== 'FACE_SKETCH') return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (useCADStore.getState().interactionMode !== 'FACE_SKETCH') return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const m = pick(e);
      if (!m) return;
      e.stopPropagation();
      const f = m.userData.face as FaceMeta;
      const wp: Workplane = {
        label: 'Face', origin: f.origin, normal: f.normal, uAxis: f.uAxis, vAxis: f.vAxis,
      };
      const st = useCADStore.getState();
      st.startSketchSession(wp);            // sets activeWorkplane + sketchSession (camera follows)
      st.setInteractionMode('SKETCH_LINE'); // drop straight into drawing
      st.log(`Sketching on a face of ${st.nodes[f.nodeId]?.name ?? 'solid'}.`, 'success');
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
    };
  }, [containerRef, cameraRef]);
}
