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
  Entity2D, Pt, Line2D, Arc2D, EllipseArc2D, paramOnLine, pointAt, splitLine, trimLine, extendLine,
  splitCircle, trimCircle, splitArc, trimArc, extendArc,
  splitEllipse, trimEllipse, splitEllipseArc, trimEllipseArc, extendEllipseArc, fitAxisAlignedEllipse,
  lineCutParams, circleCutAngles, arcCutAngles,
} from '../services/SketchEdit2D';

const TWO_PI = 2 * Math.PI;
/** Eccentric angle of a 2D point on the axis-aligned ellipse (c,rx,ry). */
const ellipseParam2D = (c: Pt, rx: number, ry: number, p: Pt): number =>
  Math.atan2((p[1] - c[1]) / ry, (p[0] - c[0]) / rx);
/** Recover {c,rx,ry} from a polyline-ellipse target (descriptor first, else fit). */
function ellipseOfGeom(g: any): { c: Pt; rx: number; ry: number } | null {
  if (g?.ellipse && Array.isArray(g.ellipse.c)) return g.ellipse;
  if (g?.kind === 'polyline' && Array.isArray(g.pts)) return fitAxisAlignedEllipse(g.pts);
  return null;
}

// Click-driven edits (one target per click).
const CLICK_EDIT_MODES = new Set<InteractionMode>(['EDIT_TRIM', 'EDIT_EXTEND', 'EDIT_SPLIT']);
// All modes this hook owns (click edits + the drag-driven power-trim).
const EDIT_MODES = new Set<InteractionMode>([...CLICK_EDIT_MODES, 'EDIT_POWER_TRIM']);
const COLOR_COMMIT = 0x003388;
const COLOR_HOVER  = 0xff8800;
const COLOR_STROKE = 0xff3322;   // power-trim rubber-band
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
  if (geom?.kind === 'arc')    return { kind: 'arc',    c: geom.c, r: geom.r, a1: geom.a1, a2: geom.a2 };
  if (geom?.kind === 'ellipse_arc') {   // sample to a polyline so it acts as a cutter
    const pts: Pt[] = [];
    const SEGS = 48;
    for (let i = 0; i <= SEGS; i++) {
      const a = geom.a1 + ((geom.a2 - geom.a1) * i) / SEGS;
      pts.push([geom.c[0] + geom.rx * Math.cos(a), geom.c[1] + geom.ry * Math.sin(a)]);
    }
    return { kind: 'polyline', pts };
  }
  if (geom?.kind === 'polyline' && Array.isArray(geom.pts)) return { kind: 'polyline', pts: geom.pts };
  return null;
};

export function useCADSketchEdit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const hoverRef = useRef<THREE.Line | null>(null);

  // Hint on entering an edit mode.
  useEffect(() => {
    if (!EDIT_MODES.has(mode)) return;
    if (mode === 'EDIT_POWER_TRIM') {
      useCADStore.getState().log('Power Trim: drag a stroke across the curves you want to trim.', 'info');
      return;
    }
    const verb = mode === 'EDIT_TRIM' ? 'Trim' : mode === 'EDIT_EXTEND' ? 'Extend' : 'Split';
    useCADStore.getState().log(
      `${verb}: click a sketch line, circle or arc${mode === 'EDIT_EXTEND' ? ' near the end to extend' : ''}.`, 'info',
    );
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const ndc       = new THREE.Vector2();
    const downPos   = { x: 0, y: 0, active: false };

    // ── Power-trim stroke state ──────────────────────────────────────────────
    const strokeWorld: THREE.Vector3[] = [];
    let stroking = false;
    let rubber: THREE.Line | null = null;

    /** Ray from the mouse onto the active workplane (no snap). */
    const projectToPlane = (e: MouseEvent): THREE.Vector3 | null => {
      const camera = cameraRef.current;
      const wp = useCADStore.getState().sketchSession?.plane;
      if (!camera || !wp) return null;
      const rect = container.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const n  = new THREE.Vector3(...wp.normal).normalize();
      const o  = new THREE.Vector3(...wp.origin);
      const pl = new THREE.Plane(n, -n.dot(o));
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(pl, hit) ? hit : null;
    };

    const clearRubber = () => {
      const scene = sceneRef.current;
      if (rubber && scene) { scene.remove(rubber); rubber.geometry.dispose(); (rubber.material as THREE.Material).dispose(); }
      rubber = null;
    };
    const drawRubber = () => {
      const scene = sceneRef.current;
      if (!scene || strokeWorld.length < 2) return;
      clearRubber();
      const geo = new THREE.BufferGeometry().setFromPoints(strokeWorld);
      rubber = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COLOR_STROKE, depthTest: false }));
      scene.add(rubber);
    };

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
      const m = useCADStore.getState().interactionMode;
      if (!EDIT_MODES.has(m)) return;
      if (m === 'EDIT_POWER_TRIM') {
        if (!stroking) return;
        const p = projectToPlane(e);
        if (p) { strokeWorld.push(p); drawRubber(); }
        return;
      }
      const hit = pick(e);
      setHover(hit ? (hit.object as THREE.Line) : null);
    };

    const onDown = (e: MouseEvent) => {
      const m = useCADStore.getState().interactionMode;
      if (e.button !== 0 || !EDIT_MODES.has(m)) return;
      if (m === 'EDIT_POWER_TRIM') {
        stroking = true;
        strokeWorld.length = 0;
        const p = projectToPlane(e);
        if (p) strokeWorld.push(p);
        e.stopPropagation();
        return;
      }
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const st = useCADStore.getState();
      const m  = st.interactionMode;
      if (m === 'EDIT_POWER_TRIM') {
        if (!stroking) return;
        stroking = false;
        clearRubber();
        if (strokeWorld.length >= 2) { e.stopPropagation(); applyPowerTrim(strokeWorld.slice()); }
        strokeWorld.length = 0;
        return;
      }
      if (!downPos.active) return;
      downPos.active = false;
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
      clearRubber();
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
  const tg = st.nodes[targetId]?.params?.sketchGeom;
  if (!tg || (tg.kind !== 'line' && tg.kind !== 'circle' && tg.kind !== 'arc' && tg.kind !== 'polyline' && tg.kind !== 'ellipse_arc')) {
    st.log('Trim/Extend/Split works on line, circle, arc, ellipse and rectangle/polygon entities.', 'warn');
    return;
  }

  const cutters: Entity2D[] = gatherEntities()
    .filter((e) => e.id !== targetId)
    .map((e) => toEntity2D(e.geom))
    .filter((e): e is Entity2D => !!e);

  // 3D hit point → sketch-local 2D.
  const hp = hit.point;
  const loc = toLocal2D(new THREE.Vector3(hp.x, hp.y, hp.z), wp);
  const sketchId = st.sketchSession?.id ?? null;
  const noun = tg.kind;
  let newIds: string[] = [];

  if (tg.kind === 'line') {
    const target: Line2D = { a: tg.a, b: tg.b };
    const clickT = paramOnLine(target, [loc.u, loc.v]);
    let results: Line2D[] = [];
    if (mode === 'EDIT_SPLIT') {
      results = splitLine(target, cutters);
      if (results.length <= 1) { st.log('No intersections to split this line at.', 'warn'); return; }
    } else if (mode === 'EDIT_TRIM') {
      results = trimLine(target, cutters, clickT);
    } else {
      const ext = extendLine(target, cutters, clickT < 0.5 ? 'a' : 'b');
      if (!ext) { st.log('Nothing ahead to extend this line to.', 'warn'); return; }
      results = [ext];
    }
    deleteWireNode(targetId);
    newIds = results.map((seg) => createLineNode(oc, seg, wp, sketchId));
  } else if (tg.kind === 'ellipse_arc') {
    // Already-trimmed ellipse arc → edit in eccentric-angle space, stays an arc.
    const arc: EllipseArc2D = { c: tg.c, rx: tg.rx, ry: tg.ry, a1: tg.a1, a2: tg.a2 };
    const clickParam = ellipseParam2D(arc.c, arc.rx, arc.ry, [loc.u, loc.v]);
    let arcs: EllipseArc2D[] = [];
    if (mode === 'EDIT_SPLIT') {
      arcs = splitEllipseArc(arc, cutters);
      if (arcs.length <= 1) { st.log('No intersections to split this ellipse arc at.', 'warn'); return; }
    } else if (mode === 'EDIT_TRIM') {
      arcs = trimEllipseArc(arc, cutters, clickParam);
    } else {
      const rel = ((clickParam - arc.a1) % TWO_PI + TWO_PI) % TWO_PI;
      const ext = extendEllipseArc(arc, cutters, rel < (arc.a2 - arc.a1) / 2 ? 'a' : 'b');
      if (!ext) { st.log('Nothing ahead to extend this ellipse arc to.', 'warn'); return; }
      arcs = [ext];
    }
    deleteWireNode(targetId);
    newIds = arcs.map((a) => createEllipseArcNode(oc, a, wp, sketchId));
  } else if (tg.kind === 'polyline' && ellipseOfGeom(tg)) {
    // FULL ellipse (analytic, stored as a 72-pt polyline) → trim/split in eccentric-
    // angle space so the result is a clean ellipse ARC, not 72 line fragments.
    const e = ellipseOfGeom(tg)!;
    const clickParam = ellipseParam2D(e.c, e.rx, e.ry, [loc.u, loc.v]);
    let arcs: EllipseArc2D[] = [];
    if (mode === 'EDIT_SPLIT') {
      arcs = splitEllipse(e, cutters);
      if (!arcs.length) { st.log('Need ≥2 intersections to split this ellipse.', 'warn'); return; }
    } else if (mode === 'EDIT_TRIM') {
      const t = trimEllipse(e, cutters, clickParam);
      if (!t) { st.log('Need ≥2 intersections to trim this ellipse.', 'warn'); return; }
      arcs = t;
    } else {
      st.log('Extend does not apply to a full ellipse.', 'warn'); return;
    }
    deleteWireNode(targetId);
    newIds = arcs.map((a) => createEllipseArcNode(oc, a, wp, sketchId));
  } else if (tg.kind === 'polyline') {
    // Rectangle / polygon / sampled curve: a chain of straight segments. Edit the
    // segment nearest the click, then explode the whole chain into line entities
    // (the clicked one replaced by its trim/split result). The chain's own other
    // segments act as cutters too, so corners bound the edit.
    const pts: Pt[] = Array.isArray(tg.pts) ? tg.pts : [];
    if (pts.length < 2) { st.log('This entity has no segments to edit.', 'warn'); return; }
    const click: Pt = [loc.u, loc.v];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg: Line2D = { a: pts[i], b: pts[i + 1] };
      const t = Math.max(0, Math.min(1, paramOnLine(seg, click)));
      const p = pointAt(seg, t);
      const d = Math.hypot(p[0] - click[0], p[1] - click[1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;

    const clickedSeg: Line2D = { a: pts[best], b: pts[best + 1] };
    const ownSegs: Entity2D[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (i !== best) ownSegs.push({ kind: 'line', a: pts[i], b: pts[i + 1] });
    }
    const segCutters = [...cutters, ...ownSegs];

    let clickedResult: Line2D[];
    if (mode === 'EDIT_SPLIT') {
      clickedResult = splitLine(clickedSeg, segCutters);
      if (clickedResult.length <= 1) { st.log('No intersections to split this segment at.', 'warn'); return; }
    } else if (mode === 'EDIT_TRIM') {
      const clickT = Math.max(0, Math.min(1, paramOnLine(clickedSeg, click)));
      clickedResult = trimLine(clickedSeg, segCutters, clickT);
    } else {
      st.log('Extend does not apply to a rectangle/polygon segment.', 'warn'); return;
    }

    deleteWireNode(targetId);
    const survivors: Line2D[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (i === best) survivors.push(...clickedResult);
      else survivors.push({ a: pts[i], b: pts[i + 1] });
    }
    newIds = survivors.map((seg) => createLineNode(oc, seg, wp, sketchId));
  } else {
    // circle / arc → angle-space ops, results are arcs.
    const clickAngle = Math.atan2(loc.v - tg.c[1], loc.u - tg.c[0]);
    let arcs: Arc2D[] = [];
    if (tg.kind === 'circle') {
      const circle = { c: tg.c as [number, number], r: tg.r };
      if (mode === 'EDIT_SPLIT') {
        arcs = splitCircle(circle, cutters);
        if (!arcs.length) { st.log('Need ≥2 intersections to split this circle.', 'warn'); return; }
      } else if (mode === 'EDIT_TRIM') {
        const t = trimCircle(circle, cutters, clickAngle);
        if (!t) { st.log('Need ≥2 intersections to trim this circle.', 'warn'); return; }
        arcs = t;
      } else {
        st.log('Extend does not apply to a full circle.', 'warn'); return;
      }
    } else {
      const arc: Arc2D = { c: tg.c, r: tg.r, a1: tg.a1, a2: tg.a2 };
      if (mode === 'EDIT_SPLIT') {
        arcs = splitArc(arc, cutters);
        if (arcs.length <= 1) { st.log('No intersections to split this arc at.', 'warn'); return; }
      } else if (mode === 'EDIT_TRIM') {
        arcs = trimArc(arc, cutters, clickAngle);
      } else {
        const rel = ((clickAngle - arc.a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        const ext = extendArc(arc, cutters, rel < (arc.a2 - arc.a1) / 2 ? 'a' : 'b');
        if (!ext) { st.log('Nothing ahead to extend this arc to.', 'warn'); return; }
        arcs = [ext];
      }
    }
    deleteWireNode(targetId);
    newIds = arcs.map((a) => createArcNode(oc, a, wp, sketchId));
  }

  const verb = mode === 'EDIT_TRIM' ? 'Trimmed' : mode === 'EDIT_EXTEND' ? 'Extended' : 'Split';
  st.log(`${verb} ${noun} → ${newIds.length} segment${newIds.length === 1 ? '' : 's'}.`, 'success');
  useCADStore.getState().setSelectedIds(newIds);
}

/**
 * Power-trim: a freehand stroke (world points on the workplane). Every sketch
 * curve the stroke crosses is trimmed once, at the crossing, bounded by the
 * other sketch entities. The whole stroke is evaluated against the ORIGINAL
 * configuration (entities snapshotted up front), so trims don't cascade.
 */
function applyPowerTrim(strokeWorld: THREE.Vector3[]) {
  const oc = window.oc;
  const st = useCADStore.getState();
  const wp = st.sketchSession?.plane;
  if (!oc || !wp) return;

  const path: Pt[] = strokeWorld.map((p) => { const l = toLocal2D(p, wp); return [l.u, l.v] as Pt; });
  const pathCutter: Entity2D = { kind: 'polyline', pts: path };
  const sketchId = st.sketchSession?.id ?? null;

  const entities = gatherEntities();
  let trimmed = 0;
  for (const ent of entities) {
    const tg = ent.geom;
    if (!tg || (tg.kind !== 'line' && tg.kind !== 'circle' && tg.kind !== 'arc' && tg.kind !== 'polyline')) continue;
    const cutters: Entity2D[] = entities
      .filter((e) => e.id !== ent.id)
      .map((e) => toEntity2D(e.geom))
      .filter((e): e is Entity2D => !!e);

    if (tg.kind === 'polyline') {
      const pts: Pt[] = Array.isArray(tg.pts) ? tg.pts : [];
      if (pts.length < 2) continue;
      const survivors: Line2D[] = [];
      let anyHit = false;
      for (let i = 0; i < pts.length - 1; i++) {
        const seg: Line2D = { a: pts[i], b: pts[i + 1] };
        const cross = lineCutParams(seg, [pathCutter]);   // where the stroke hits this segment
        if (!cross.length) { survivors.push(seg); continue; }
        anyHit = true;
        trimLine(seg, cutters, cross[0]).forEach((s) => survivors.push(s));
      }
      if (!anyHit) continue;
      deleteWireNode(ent.id);
      survivors.forEach((s) => createLineNode(oc, s, wp, sketchId));
      trimmed++;
    } else if (tg.kind === 'line') {
      const target: Line2D = { a: tg.a, b: tg.b };
      const cross = lineCutParams(target, [pathCutter]);   // where the stroke hits this line
      if (!cross.length) continue;
      deleteWireNode(ent.id);
      trimLine(target, cutters, cross[0]).forEach((seg) => createLineNode(oc, seg, wp, sketchId));
      trimmed++;
    } else if (tg.kind === 'circle') {
      const angs = circleCutAngles(tg.c, tg.r, [pathCutter]);
      if (!angs.length) continue;
      const res = trimCircle({ c: tg.c, r: tg.r }, cutters, angs[0]);
      if (!res) continue;
      deleteWireNode(ent.id);
      res.forEach((a) => createArcNode(oc, a, wp, sketchId));
      trimmed++;
    } else { // arc
      const arc: Arc2D = { c: tg.c, r: tg.r, a1: tg.a1, a2: tg.a2 };
      const angs = arcCutAngles(arc, [pathCutter]);
      if (!angs.length) continue;
      deleteWireNode(ent.id);
      trimArc(arc, cutters, angs[0]).forEach((a) => createArcNode(oc, a, wp, sketchId));
      trimmed++;
    }
  }
  st.log(
    trimmed ? `Power-trim: trimmed ${trimmed} curve${trimmed === 1 ? '' : 's'}.`
            : 'Power-trim: the stroke crossed nothing to trim.',
    trimmed ? 'success' : 'warn',
  );
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

function createArcNode(oc: any, arc: Arc2D, wp: any, sketchId: string | null): string {
  const center = fromLocal2D(arc.c[0], arc.c[1], wp);
  const start  = fromLocal2D(arc.c[0] + arc.r * Math.cos(arc.a1), arc.c[1] + arc.r * Math.sin(arc.a1), wp);
  const end    = fromLocal2D(arc.c[0] + arc.r * Math.cos(arc.a2), arc.c[1] + arc.r * Math.sin(arc.a2), wp);
  const edge = OccSketchService.createArcEdge(oc, center, start, end, wp);
  const wire = OccSketchService.createClosedWireFromEdges(oc, [edge]);

  const id = crypto.randomUUID();
  CADGeometryRegistry.getInstance().registerShape(id, wire);
  useCADStore.getState().addNode({
    id, name: 'Arc', type: 'sketch_wire',
    visible: true, locked: false, parentId: sketchId, notes: '',
    transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    material:  { color: 0x003388, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
    params: { workplane: wp, sketchGeom: { kind: 'arc', c: arc.c, r: arc.r, a1: arc.a1, a2: arc.a2 } },
  });

  // Polyline visual sampled along the arc span.
  const SEGS = 48;
  const pts: number[][] = [];
  for (let i = 0; i <= SEGS; i++) {
    const a = arc.a1 + ((arc.a2 - arc.a1) * i) / SEGS;
    const p = fromLocal2D(arc.c[0] + arc.r * Math.cos(a), arc.c[1] + arc.r * Math.sin(a), wp);
    pts.push([p.x, p.y, p.z]);
  }
  window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', { detail: { id, pts } }));
  return id;
}

function createEllipseArcNode(oc: any, arc: EllipseArc2D, wp: any, sketchId: string | null): string {
  // One analytic gp_Elips arc edge (buildEntityWire handles 'ellipse_arc').
  const geom = { kind: 'ellipse_arc', c: arc.c, rx: arc.rx, ry: arc.ry, a1: arc.a1, a2: arc.a2 };
  const wire = OccSketchService.buildEntityWire(oc, geom, wp);

  const id = crypto.randomUUID();
  CADGeometryRegistry.getInstance().registerShape(id, wire);
  useCADStore.getState().addNode({
    id, name: 'Ellipse arc', type: 'sketch_wire',
    visible: true, locked: false, parentId: sketchId, notes: '',
    transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    material:  { color: 0x003388, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
    params: { workplane: wp, sketchGeom: geom },
  });

  // Polyline visual sampled along the ellipse-arc span.
  const SEGS = 64;
  const pts: number[][] = [];
  for (let i = 0; i <= SEGS; i++) {
    const a = arc.a1 + ((arc.a2 - arc.a1) * i) / SEGS;
    const p = fromLocal2D(arc.c[0] + arc.rx * Math.cos(a), arc.c[1] + arc.ry * Math.sin(a), wp);
    pts.push([p.x, p.y, p.z]);
  }
  window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', { detail: { id, pts } }));
  return id;
}
