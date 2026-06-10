// ============================================================
// ToubkalCAD – useCADDatumAnglePick.ts
//
// Track D, D3 — "Plane at Angle" (rotate a face's plane about one of its edges).
//
// Active only while interactionMode === 'DATUM_ANGLE_PICK'. Two phases:
//   1) pick a PLANAR face (transparent overlays, like D2/D5) — it locks amber and
//      the other faces clear, then its straight boundary edges appear as pickable
//      lines (like the per-edge fillet tool);
//   2) pick one of those edges (the hinge axis) → ask an angle (ParameterModal) →
//      rotate the face's plane about the edge (OccDatumService.planeAtAngle) and
//      persist the result as a datum.
// Esc cancels at any point.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, Workplane } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccFaceService } from '../services/OccFaceService';
import { OccDatumService } from '../services/OccDatumService';
import { getPlacedShape } from '../utils/placedShape';
import { showParamModal } from '../components/ParameterModal';

const COLOR_IDLE   = 0x2a7fd4;
const COLOR_HOVER  = 0x00e0a0;
const COLOR_PICKED = 0xf0a30a;   // chosen face (amber)
const EDGE_IDLE    = 0x66ccff;
const EDGE_HOVER   = 0xffe000;
const CLICK_SLOP_PX = 5;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

interface FacePick { sourceId: string; faceIndex: number; workplane: Workplane; mesh: THREE.Mesh; }

export function useCADDatumAnglePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const faceOverlaysRef = useRef<THREE.Mesh[]>([]);
  const edgeLinesRef    = useRef<THREE.Line[]>([]);
  const faceHoverRef    = useRef<THREE.Mesh | null>(null);
  const edgeHoverRef    = useRef<THREE.Line | null>(null);
  const pickedFaceRef   = useRef<FacePick | null>(null);
  const edgeThreshRef    = useRef<number>(0.6);

  // ─── Build / tear down (phase-1 face overlays) ───────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const m of faceOverlaysRef.current) { scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      for (const l of edgeLinesRef.current)    { scene.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
      faceOverlaysRef.current = [];
      edgeLinesRef.current = [];
      faceHoverRef.current = null;
      edgeHoverRef.current = null;
      pickedFaceRef.current = null;
    };

    dispose();
    if (mode !== 'DATUM_ANGLE_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        for (const f of OccFaceService.extractPlanarFaces(window.oc, placed)) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({
            color: COLOR_IDLE, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 998;
          const wp: Workplane = { label: 'Face', origin: f.origin, normal: f.normal, uAxis: f.uAxis, vAxis: f.vAxis };
          mesh.userData = { angleFace: { sourceId: id, faceIndex: f.index, workplane: wp } };
          scene.add(mesh);
          faceOverlaysRef.current.push(mesh);
        }
      } catch {
        /* solid without planar faces */
      } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
    st.log('Pick the reference planar face to tilt.', 'info');

    return dispose;
  }, [mode, sceneRef]);

  // ─── Hover + click (both phases) ─────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearFaceHover = () => {
      const m = faceHoverRef.current;
      if (m && m !== pickedFaceRef.current?.mesh) {
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.color.setHex(COLOR_IDLE); mat.opacity = 0.12;
      }
      faceHoverRef.current = null;
    };
    const clearEdgeHover = () => {
      const l = edgeHoverRef.current;
      if (l) (l.material as THREE.LineBasicMaterial).color.setHex(EDGE_IDLE);
      edgeHoverRef.current = null;
    };

    if (mode !== 'DATUM_ANGLE_PICK') { clearFaceHover(); clearEdgeHover(); container.style.cursor = 'default'; return; }

    const setNdc = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };

    const pickFace = (e: MouseEvent): THREE.Mesh | null => {
      const camera = cameraRef.current; if (!camera) return null;
      setNdc(e); raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(faceOverlaysRef.current, false);
      return hits.length ? (hits[0].object as THREE.Mesh) : null;
    };
    const pickEdge = (e: MouseEvent): THREE.Line | null => {
      const camera = cameraRef.current; if (!camera) return null;
      setNdc(e); raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: edgeThreshRef.current };
      const hits = raycaster.intersectObjects(edgeLinesRef.current, false);
      return hits.length ? (hits[0].object as THREE.Line) : null;
    };

    // Phase 1 → 2: lock the chosen face, drop the others, show its straight edges.
    // If the face has no straight edge (e.g. a round cap) we stay in phase 1.
    const enterEdgePhase = (fp: { sourceId: string; faceIndex: number; workplane: Workplane }, mesh: THREE.Mesh) => {
      const scene  = sceneRef.current!;
      const placed = getPlacedShape(fp.sourceId);
      const edges  = placed ? OccDatumService.faceStraightEdges(window.oc, placed, fp.faceIndex) : [];
      if (placed && placed !== CADGeometryRegistry.getInstance().getShape(fp.sourceId)) { try { placed.delete(); } catch {} }

      if (!edges.length) {
        const mt = mesh.material as THREE.MeshBasicMaterial;
        mt.color.setHex(COLOR_IDLE); mt.opacity = 0.12;
        useCADStore.getState().log('That face has no straight edge to hinge about — pick another.', 'warn');
        return;
      }

      for (const m of faceOverlaysRef.current) {
        if (m === mesh) continue;
        scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose();
      }
      faceOverlaysRef.current = [mesh];
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(COLOR_PICKED); mat.opacity = 0.4;
      pickedFaceRef.current = { ...fp, mesh };

      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const ed of edges) for (const p of ed.points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      edgeThreshRef.current = Math.max(diag * 0.02, 0.3);

      for (const ed of edges) {
        const geo = new THREE.BufferGeometry().setFromPoints(ed.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: EDGE_IDLE, depthTest: false, transparent: true, opacity: 0.95 }));
        line.renderOrder = 999;
        line.userData = { angleEdge: { origin: ed.origin, dir: ed.dir } };
        scene.add(line);
        edgeLinesRef.current.push(line);
      }
      useCADStore.getState().log('Pick a straight edge of the face as the hinge axis.', 'info');
    };

    const createAtAngle = async (fp: FacePick, axisOrigin: [number, number, number], axisDir: [number, number, number]) => {
      const v = await showParamModal('Plane at Angle', [
        { key: 'a', label: 'Angle', default: 45, min: -180, max: 180, unit: '°' },
      ]);
      if (!v) return;
      const wp = OccDatumService.planeAtAngle(window.oc, fp.workplane.origin, fp.workplane.normal, axisOrigin, axisDir, v.a ?? 0);
      const st = useCADStore.getState();
      if (!wp) { st.log('Could not build the angled plane.', 'warn'); return; }
      st.createDatumPlane(wp, 'angle', [{ kind: 'face', nodeId: fp.sourceId, faceIndex: fp.faceIndex, angle: v.a ?? 0 }]);
      st.log(`Plane at ${v.a ?? 0}° created.`, 'success');
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_ANGLE_PICK') return;
      if (!pickedFaceRef.current) {
        const m = pickFace(e);
        if (m !== faceHoverRef.current) {
          clearFaceHover();
          if (m) { const mt = m.material as THREE.MeshBasicMaterial; mt.color.setHex(COLOR_HOVER); mt.opacity = 0.32; faceHoverRef.current = m; }
        }
        container.style.cursor = m ? 'pointer' : 'default';
      } else {
        const l = pickEdge(e);
        if (l !== edgeHoverRef.current) {
          clearEdgeHover();
          if (l) { (l.material as THREE.LineBasicMaterial).color.setHex(EDGE_HOVER); edgeHoverRef.current = l; }
        }
        container.style.cursor = l ? 'pointer' : 'default';
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      if (!pickedFaceRef.current) {
        const m = pickFace(e);
        if (!m) return;
        e.stopPropagation();
        clearFaceHover();
        enterEdgePhase(m.userData.angleFace, m);
      } else {
        const l = pickEdge(e);
        if (!l) return;
        e.stopPropagation();
        const ax = l.userData.angleEdge as { origin: [number, number, number]; dir: [number, number, number] };
        const fp = pickedFaceRef.current!;                     // capture before the mode change disposes it
        clearEdgeHover();
        container.style.cursor = 'default';
        useCADStore.getState().setInteractionMode('SELECT');   // exit (disposes overlays/lines)
        void createAtAngle(fp, ax.origin, ax.dir);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearFaceHover(); clearEdgeHover(); useCADStore.getState().setInteractionMode('SELECT'); }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      clearFaceHover(); clearEdgeHover();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
