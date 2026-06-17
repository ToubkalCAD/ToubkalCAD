// ============================================================
// ToubkalCAD – useCADDatumAxisPick.ts
//
// Track D, D7 — "Datum Axis".
//
// Active only while interactionMode === 'DATUM_AXIS_PICK'. Two kinds of pickable
// reference appear together:
//   • every STRAIGHT edge of each solid → a pickable line (axis along the edge);
//   • every CYLINDRICAL face → a transparent overlay (axis = the cylinder axis).
// A single click on either creates a datum_axis node along it. Esc cancels.
// Reuses OccDatumService.straightEdges + OccAxisService.extractCylindricalFaces.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccDatumService } from '../services/OccDatumService';
import { OccAxisService } from '../services/OccAxisService';
import { captureFaceAtPoint, lineSigFromPoints } from '../services/StableRef';
import { getPlacedShape } from '../utils/placedShape';

const EDGE_IDLE   = 0x66ccff;
const EDGE_HOVER  = 0xffe000;
const FACE_IDLE   = 0x2a7fd4;
const FACE_HOVER  = 0x00e0a0;
const CLICK_SLOP_PX = 5;

const NON_SOLID = new Set(['sketch', 'sketch_wire', 'datum_plane', 'datum_axis', 'datum_point']);

interface AxisDef { origin: [number, number, number]; dir: [number, number, number]; }

export function useCADDatumAxisPick(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const edgeLinesRef  = useRef<THREE.Line[]>([]);
  const cylMeshesRef  = useRef<THREE.Mesh[]>([]);
  const lineHoverRef  = useRef<THREE.Line | null>(null);
  const faceHoverRef  = useRef<THREE.Mesh | null>(null);
  const threshRef     = useRef<number>(0.6);

  // ─── Build / tear down pickable edges + cylinder overlays ────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const dispose = () => {
      for (const l of edgeLinesRef.current) { scene.remove(l); l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
      for (const m of cylMeshesRef.current) { scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      edgeLinesRef.current = [];
      cylMeshesRef.current = [];
      lineHoverRef.current = null;
      faceHoverRef.current = null;
    };

    dispose();
    if (mode !== 'DATUM_AXIS_PICK' || !window.oc) return;

    const st  = useCADStore.getState();
    const reg = CADGeometryRegistry.getInstance();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];

    for (const id of Object.keys(st.nodes)) {
      const node = st.nodes[id];
      if (!node || !node.visible || NON_SOLID.has(node.type)) continue;
      const placed = getPlacedShape(id);
      if (!placed) continue;
      try {
        for (const ed of OccDatumService.straightEdges(window.oc, placed)) {
          const a = ed.points[0], b = ed.points[ed.points.length - 1];
          const mid: [number, number, number] = [(a[0]+b[0])/2, (a[1]+b[1])/2, (a[2]+b[2])/2];
          const geo  = new THREE.BufferGeometry().setFromPoints(ed.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
          const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: EDGE_IDLE, depthTest: false, transparent: true, opacity: 0.95 }));
          line.renderOrder = 999;
          // Step 4 — EdgeSig (axis edges are straight) so evaluateDatum re-derives
          // the axis on the live body; reject → baked axis.
          line.userData = { axisDef: { origin: mid, dir: ed.dir } as AxisDef, sourceId: id, sel: lineSigFromPoints(ed.points) };
          scene.add(line);
          edgeLinesRef.current.push(line);
          for (const p of ed.points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
        }
        for (const cf of OccAxisService.extractCylindricalFaces(window.oc, placed)) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(cf.positions, 3));
          geo.computeVertexNormals();
          const mat = new THREE.MeshBasicMaterial({ color: FACE_IDLE, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 998;
          // Step 4 — cylinder FaceSig (captured at a point on the surface) so
          // evaluateDatum re-derives the axis from the live cylinder; reject → baked.
          const surf = cf.positions.length >= 3 ? [cf.positions[0], cf.positions[1], cf.positions[2]] as [number, number, number] : cf.axisPoint;
          mesh.userData = { axisDef: { origin: cf.axisPoint, dir: cf.axisDir } as AxisDef, sourceId: id, sel: captureFaceAtPoint(window.oc, placed, surf) };
          scene.add(mesh);
          cylMeshesRef.current.push(mesh);
        }
      } catch {
        /* skip solids that fail extraction */
      } finally {
        if (placed !== reg.getShape(id)) { try { placed.delete(); } catch {} }
      }
    }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    threshRef.current = isFinite(diag) && diag > 0 ? Math.max(diag * 0.02, 0.3) : 0.6;

    if (!edgeLinesRef.current.length && !cylMeshesRef.current.length) {
      st.log('No straight edges or cylindrical faces to use as an axis.', 'warn');
    } else {
      st.log('Pick a straight edge or a cylindrical face for the axis.', 'info');
    }

    return dispose;
  }, [mode, sceneRef]);

  // ─── Hover + click ───────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    const clearHover = () => {
      if (lineHoverRef.current) (lineHoverRef.current.material as THREE.LineBasicMaterial).color.setHex(EDGE_IDLE);
      lineHoverRef.current = null;
      if (faceHoverRef.current) {
        const mat = faceHoverRef.current.material as THREE.MeshBasicMaterial;
        mat.color.setHex(FACE_IDLE); mat.opacity = 0.12;
      }
      faceHoverRef.current = null;
    };

    if (mode !== 'DATUM_AXIS_PICK') { clearHover(); container.style.cursor = 'default'; return; }

    const pick = (e: MouseEvent): THREE.Object3D | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: threshRef.current };
      const hits = raycaster.intersectObjects([...edgeLinesRef.current, ...cylMeshesRef.current], false);
      return hits.length ? hits[0].object : null;
    };

    const setHover = (o: THREE.Object3D | null) => {
      clearHover();
      if (!o) { container.style.cursor = 'default'; return; }
      if (o instanceof THREE.Line) { (o.material as THREE.LineBasicMaterial).color.setHex(EDGE_HOVER); lineHoverRef.current = o; }
      else if (o instanceof THREE.Mesh) { const mt = o.material as THREE.MeshBasicMaterial; mt.color.setHex(FACE_HOVER); mt.opacity = 0.32; faceHoverRef.current = o; }
      container.style.cursor = 'pointer';
    };

    const onMove = (e: MouseEvent) => {
      if (useCADStore.getState().interactionMode !== 'DATUM_AXIS_PICK') return;
      setHover(pick(e));
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const o = pick(e);
      if (!o) return;
      e.stopPropagation();
      const ax = o.userData.axisDef as AxisDef;
      const fromCyl = o instanceof THREE.Mesh;
      const sourceId = o.userData.sourceId as string | undefined;
      const sel = o.userData.sel ?? undefined;
      clearHover();
      container.style.cursor = 'default';
      const st = useCADStore.getState();
      st.setInteractionMode('SELECT');                 // exit (disposes overlays)
      st.createDatumAxis(ax, fromCyl ? 'cylinder' : 'edge', sourceId ? [{ kind: fromCyl ? 'cylinder' : 'edge', nodeId: sourceId, sel }] : []);
      st.log(`Datum axis created from ${fromCyl ? 'a cylindrical face' : 'an edge'}.`, 'success');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { clearHover(); useCADStore.getState().setInteractionMode('SELECT'); }
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    window.addEventListener('keydown', onKey);
    return () => {
      clearHover();
      container.style.cursor = 'default';
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode, containerRef, sceneRef, cameraRef]);
}
