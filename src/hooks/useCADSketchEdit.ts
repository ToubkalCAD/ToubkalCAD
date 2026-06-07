// ============================================================
// ToubkalCAD – useCADSketchEdit.ts
//
// Track S1 — Trim / Extend / Break(Split) of 2D sketch lines.
//
// Active while interactionMode ∈ {EDIT_TRIM, EDIT_EXTEND, EDIT_SPLIT} and a
// sketch session is open. Raycasts the active sketch's wire visuals; on click
// it edits the picked LINE against its sibling entities (lines + circles):
//   • SPLIT  — break the line at every interior intersection
//   • TRIM   — remove the clicked span (bounded by nearest intersections / ends)
//   • EXTEND — lengthen the endpoint nearest the click to the next boundary
//
// Edits delete the original wire node and create new ones (nested under the same
// sketch, with sketchGeom), so the tree, visuals and registry stay consistent.
// The mode stays active for repeated edits; pick another tool to leave.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useCADStore, InteractionMode } from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccSketchService, fromLocal2D, toLocal2D } from '../services/OccSketchService';
import {
  Entity2D, Line2D, paramOnLine, splitLine, trimLine, extendLine,
} from '../services/SketchEdit2D';

const EDIT_MODES = new Set<InteractionMode>(['EDIT_TRIM', 'EDIT_EXTEND', 'EDIT_SPLIT']);
const COLOR_COMMIT = 0x003388;
const COLOR_HOVER  = 0xff8800;
const LINE_THRESHOLD = 0.6;
const CLICK_SLOP_PX  = 5;

interface SketchEntity { id: string; geom: any; }

/** All entities of the active sketch that carry sketchGeom (lines + circles). */
function gatherEntities(): SketchEntity[] {
  const st = useCADStore.getState();
  const sketchId = st.sketchSession?.id;
  if (!sketchId) return [];
  return Object.values(st.nodes)
    .filter((n) => n.type === 'sketch_wire' && n.parentId === sketchId && n.params?.sketchGeom)
    .map((n) => ({ id: n.id, geom: n.params!.sketchGeom }));
}

const toEntity2D = (geom: any): Entity2D | null => {
  if (geom?.kind === 'line')   return { kind: 'line',   a: geom.a, b: geom.b };
  if (geom?.kind === 'circle') return { kind: 'circle', c: geom.c, r: geom.r };
  return null;
};

export function useCADSketchEdit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const hoverRef = useRef<THREE.Line | null>(null);

  // Hint on entering an edit mode.
  useEffect(() => {
    if (!EDIT_MODES.has(mode)) return;
    const verb = mode === 'EDIT_TRIM' ? 'Trim' : mode === 'EDIT_EXTEND' ? 'Extend' : 'Split';
    useCADStore.getState().log(
      `${verb}: click a sketch line${mode === 'EDIT_EXTEND' ? ' near the end to extend' : ''}.`, 'info',
    );
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    // Pickable visuals = THREE.Line objects of the active sketch's wires.
    const pickableLines = (): THREE.Line[] => {
      const scene = sceneRef.current;
      const st = useCADStore.getState();
      const sketchId = st.sketchSession?.id;
      if (!scene || !sketchId) return [];
      return scene.children.filter((c): c is THREE.Line => {
        if (!(c instanceof THREE.Line)) return false;
        const id = c.userData?.cadNodeId as string | undefined;
        return !!id && st.nodes[id]?.parentId === sketchId && !!st.nodes[id]?.params?.sketchGeom;
      });
    };

    const pick = (e: MouseEvent): THREE.Intersection | null => {
      const camera = cameraRef.current;
      if (!camera) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      raycaster.params.Line = { threshold: LINE_THRESHOLD };
      const hits = raycaster.intersectObjects(pickableLines(), false);
      return hits.length ? hits[0] : null;
    };

    const setHover = (line: THREE.Line | null) => {
      if (hoverRef.current === line) return;
      if (hoverRef.current) (hoverRef.current.material as THREE.LineBasicMaterial).color.setHex(COLOR_COMMIT);
      hoverRef.current = line;
      if (line) (line.material as THREE.LineBasicMaterial).color.setHex(COLOR_HOVER);
      container.style.cursor = line ? 'pointer' : 'default';
    };

    const onMove = (e: MouseEvent) => {
      if (!EDIT_MODES.has(useCADStore.getState().interactionMode)) return;
      const hit = pick(e);
      setHover(hit ? (hit.object as THREE.Line) : null);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !EDIT_MODES.has(useCADStore.getState().interactionMode)) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      const st = useCADStore.getState();
      const m  = st.interactionMode;
      if (!EDIT_MODES.has(m)) return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP_PX) return;
      const hit = pick(e);
      if (!hit) return;
      e.stopPropagation();
      setHover(null);
      applyEdit(m, hit);
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      setHover(null);
    };
  }, [containerRef, sceneRef, cameraRef]);
}

// ─── Edit application (outside the effect; reads fresh store state) ────────────

function applyEdit(mode: InteractionMode, hit: THREE.Intersection) {
  const oc = window.oc;
  const st = useCADStore.getState();
  const wp = st.sketchSession?.plane;
  if (!oc || !wp) return;

  const targetId = (hit.object.userData.cadNodeId as string);
  const targetGeom = st.nodes[targetId]?.params?.sketchGeom;
  if (targetGeom?.kind !== 'line') {
    st.log('Trim/Extend/Split currently works on line segments.', 'warn');
    return;
  }
  const target: Line2D = { a: targetGeom.a, b: targetGeom.b };

  const entities = gatherEntities();
  const cutters: Entity2D[] = entities
    .filter((e) => e.id !== targetId)
    .map((e) => toEntity2D(e.geom))
    .filter((e): e is Entity2D => !!e);

  // Click param along the target line, from the 3D hit point.
  const hp = hit.point;
  const loc = toLocal2D(new THREE.Vector3(hp.x, hp.y, hp.z), wp);
  const clickT = paramOnLine(target, [loc.u, loc.v]);

  let results: Line2D[] = [];
  if (mode === 'EDIT_SPLIT') {
    results = splitLine(target, cutters);
    if (results.length <= 1) { st.log('No intersections to split this line at.', 'warn'); return; }
  } else if (mode === 'EDIT_TRIM') {
    results = trimLine(target, cutters, clickT);
    // results may be empty → the whole line is trimmed away (valid)
  } else { // EDIT_EXTEND
    const ext = extendLine(target, cutters, clickT < 0.5 ? 'a' : 'b');
    if (!ext) { st.log('Nothing ahead to extend this line to.', 'warn'); return; }
    results = [ext];
  }

  // Rebuild: delete the original, create a node per surviving segment.
  deleteWireNode(targetId);
  const newIds = results.map((seg) => createLineNode(oc, seg, wp, st.sketchSession?.id ?? null));

  const verb = mode === 'EDIT_TRIM' ? 'Trimmed' : mode === 'EDIT_EXTEND' ? 'Extended' : 'Split';
  st.log(`${verb} line → ${newIds.length} segment${newIds.length === 1 ? '' : 's'}.`, 'success');
  useCADStore.getState().setSelectedIds(newIds);
}

function deleteWireNode(id: string) {
  useCADStore.getState().deleteNode(id);
}

function createLineNode(oc: any, seg: Line2D, wp: any, sketchId: string | null): string {
  const a3 = fromLocal2D(seg.a[0], seg.a[1], wp);
  const b3 = fromLocal2D(seg.b[0], seg.b[1], wp);
  const edge = OccSketchService.createLineEdge(oc, a3, b3);
  const wire = OccSketchService.createClosedWireFromEdges(oc, [edge]);

  const id = crypto.randomUUID();
  CADGeometryRegistry.getInstance().registerShape(id, wire);
  useCADStore.getState().addNode({
    id, name: 'Line', type: 'sketch_wire',
    visible: true, locked: false, parentId: sketchId, notes: '',
    transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    material:  { color: 0x003388, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
    params: { workplane: wp, sketchGeom: { kind: 'line', a: seg.a, b: seg.b } },
  });
  window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', {
    detail: { id, pts: [[a3.x, a3.y, a3.z], [b3.x, b3.y, b3.z]] },
  }));
  return id;
}
