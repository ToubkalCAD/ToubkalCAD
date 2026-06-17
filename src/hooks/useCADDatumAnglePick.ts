// ============================================================
// ToubkalCAD – useCADDatumAnglePick.ts
//
// Track D, D3 — "Plane at Angle" (rotate a face's plane about one of its edges).
//
// Active only while interactionMode === 'DATUM_ANGLE_PICK'. Two phases:
//   1) pick a PLANAR face (on the REAL mesh via FacePicker) — it locks amber and
//      its straight boundary edges appear as pickable lines (like the per-edge
//      fillet tool);
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
import { FacePicker, FaceHit } from '../services/FacePicker';
import { captureFace, lineSigFromPoints } from '../services/StableRef';
import { getPlacedShape } from '../utils/placedShape';
import { showParamModal } from '../components/ParameterModal';

const COLOR_HOVER  = 0x00e0a0;
const COLOR_PICKED = 0xf0a30a;   // chosen face (amber)
const EDGE_IDLE    = 0x66ccff;
const EDGE_HOVER   = 0xffe000;
const CLICK_SLOP_PX = 5;

interface FacePick { sourceId: string; faceIndex: number; workplane: Workplane; }

export function useCADDatumAnglePick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const hoverHlRef   = useRef<THREE.Mesh | null>(null);   // phase-1 face hover
  const hoverKeyRef  = useRef<string | null>(null);
  const lockedHlRef  = useRef<THREE.Mesh | null>(null);   // phase-2 locked face
  const edgeLinesRef = useRef<THREE.Line[]>([]);
  const edgeHoverRef = useRef<THREE.Line | null>(null);
  const pickedFaceRef = useRef<FacePick | null>(null);
  const edgeThreshRef = useRef<number>(0.6);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const disposeMesh = (m: THREE.Mesh | THREE.Line | null) => {
      const s = sceneRef.current;
      if (m && s) { s.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    };
    const clearFaceHover = () => {
      if (hoverHlRef.current) disposeMesh(hoverHlRef.current);
      hoverHlRef.current = null; hoverKeyRef.current = null;
    };
    const clearEdgeHover = () => {
      const l = edgeHoverRef.current;
      if (l) (l.material as THREE.LineBasicMaterial).color.setHex(EDGE_IDLE);
      edgeHoverRef.current = null;
    };
    const clearAll = () => {
      clearFaceHover(); clearEdgeHover();
      if (lockedHlRef.current) disposeMesh(lockedHlRef.current);
      lockedHlRef.current = null;
      for (const l of edgeLinesRef.current) disposeMesh(l);
      edgeLinesRef.current = [];
      pickedFaceRef.current = null;
    };

    if (mode !== 'DATUM_ANGLE_PICK') { clearAll(); container.style.cursor = 'default'; return; }

    useCADStore.getState().log('Pick the reference planar face to tilt.', 'info');

    const setNdc = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    };
    const castFace = (e: MouseEvent): FaceHit | null => {
      const camera = cameraRef.current; const scene = sceneRef.current;
      if (!camera || !scene) return null;
      setNdc(e); raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: 1 };
      return FacePicker.raycast(raycaster, scene);
    };
    const pickEdge = (e: MouseEvent): THREE.Line | null => {
      const camera = cameraRef.current; if (!camera) return null;
      setNdc(e); raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: edgeThreshRef.current };
      const hits = raycaster.intersectObjects(edgeLinesRef.current, false);
      return hits.length ? (hits[0].object as THREE.Line) : null;
    };

    /** World-space workplane of one solid face (null if curved). */
    const facePlaneWp = (nodeId: string, faceIndex: number): Workplane | null => {
      const reg = CADGeometryRegistry.getInstance();
      const placed = getPlacedShape(nodeId);
      if (!placed) return null;
      try {
        const p = OccFaceService.planeFromFaceIndex(window.oc, placed, faceIndex);
        return p ? { label: 'Face', origin: p.origin, normal: p.normal, uAxis: p.uAxis, vAxis: p.vAxis } : null;
      } finally {
        if (placed !== reg.getShape(nodeId)) { try { placed.delete(); } catch {} }
      }
    };

    // Phase 1 → 2: lock the chosen face and show its straight edges. If the face
    // has no straight edge (e.g. a round cap) we stay in phase 1.
    const enterEdgePhase = (fp: FacePick, hit: FaceHit) => {
      const scene  = sceneRef.current!;
      const reg    = CADGeometryRegistry.getInstance();
      const placed = getPlacedShape(fp.sourceId);
      const edges  = placed ? OccDatumService.faceStraightEdges(window.oc, placed, fp.faceIndex) : [];
      if (placed && placed !== reg.getShape(fp.sourceId)) { try { placed.delete(); } catch {} }

      if (!edges.length) {
        useCADStore.getState().log('That face has no straight edge to hinge about — pick another.', 'warn');
        return;
      }

      clearFaceHover();
      const locked = FacePicker.makeHighlight(hit.mesh, hit.group, { color: COLOR_PICKED, opacity: 0.4 });
      scene.add(locked); lockedHlRef.current = locked;
      pickedFaceRef.current = fp;

      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const ed of edges) for (const p of ed.points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      edgeThreshRef.current = Math.max(diag * 0.02, 0.3);

      for (const ed of edges) {
        const geo = new THREE.BufferGeometry().setFromPoints(ed.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: EDGE_IDLE, depthTest: false, transparent: true, opacity: 0.95 }));
        line.renderOrder = 1000;
        line.userData = { angleEdge: { origin: ed.origin, dir: ed.dir, points: ed.points } };
        scene.add(line);
        edgeLinesRef.current.push(line);
      }
      useCADStore.getState().log('Pick a straight edge of the face as the hinge axis.', 'info');
    };

    const createAtAngle = async (
      fp: FacePick,
      axis: { origin: [number, number, number]; dir: [number, number, number]; points: [number, number, number][] },
    ) => {
      const v = await showParamModal('Plane at Angle', [
        { key: 'a', label: 'Angle', default: 45, min: -180, max: 180, unit: '°' },
      ]);
      if (!v) return;
      const wp = OccDatumService.planeAtAngle(window.oc, fp.workplane.origin, fp.workplane.normal, axis.origin, axis.dir, v.a ?? 0);
      const st = useCADStore.getState();
      if (!wp) { st.log('Could not build the angled plane.', 'warn'); return; }

      // Step 4 — capture stable signatures so the datum FOLLOWS its source on a
      // parametric recompute: a FaceSig of the hinge face + an EdgeSig of the hinge
      // edge (built from the picked polyline — faceStraightEdges has no TopExp
      // ordinal). evaluateDatum re-resolves both against the live body; reject →
      // falls back to the baked `wp`. Captured against the SAME placed source the
      // evaluator resolves against.
      const reg = CADGeometryRegistry.getInstance();
      const placed = getPlacedShape(fp.sourceId);
      const faceSig = placed ? captureFace(window.oc, placed, fp.faceIndex) : null;
      if (placed && placed !== reg.getShape(fp.sourceId)) { try { placed.delete(); } catch {} }
      const edgeSig = lineSigFromPoints(axis.points);

      st.createDatumPlane(wp, 'angle', [{
        kind: 'face', nodeId: fp.sourceId, faceIndex: fp.faceIndex, angle: v.a ?? 0,
        sel: faceSig ?? undefined, edgeSel: edgeSig ?? undefined,
      }]);
      st.log(`Plane at ${v.a ?? 0}° created.`, 'success');
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_ANGLE_PICK') return;
      if (!pickedFaceRef.current) {
        const hit = castFace(e);
        const key = hit ? `${hit.nodeId}#${hit.faceIndex}` : null;
        if (key !== hoverKeyRef.current) {
          clearFaceHover();
          hoverKeyRef.current = key;
          if (hit) { const hl = FacePicker.makeHighlight(hit.mesh, hit.group, { color: COLOR_HOVER }); sceneRef.current!.add(hl); hoverHlRef.current = hl; }
        }
        container.style.cursor = hit ? 'pointer' : 'default';
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
        const hit = castFace(e);
        if (!hit) return;
        e.stopPropagation();
        const wp = facePlaneWp(hit.nodeId, hit.faceIndex);
        if (!wp) { useCADStore.getState().log('That face is not planar — pick a flat face.', 'warn'); return; }
        enterEdgePhase({ sourceId: hit.nodeId, faceIndex: hit.faceIndex, workplane: wp }, hit);
      } else {
        const l = pickEdge(e);
        if (!l) return;
        e.stopPropagation();
        const ax = l.userData.angleEdge as { origin: [number, number, number]; dir: [number, number, number]; points: [number, number, number][] };
        const fp = pickedFaceRef.current!;                     // capture before the mode change disposes it
        clearEdgeHover();
        container.style.cursor = 'default';
        useCADStore.getState().setInteractionMode('SELECT');   // exit (disposes overlays/lines)
        void createAtAngle(fp, ax);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearAll(); useCADStore.getState().setInteractionMode('SELECT'); }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      clearAll();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
