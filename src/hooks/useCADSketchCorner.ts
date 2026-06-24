// ============================================================
// ToubkalCAD – useCADSketchCorner.ts
//
// Track S1 — Fillet / Chamfer of a 2D sketch CORNER.
//
// Active while interactionMode ∈ {EDIT_FILLET, EDIT_CHAMFER} and a sketch
// session is open. Unlike trim/extend/split (which pick an EDGE), this tool
// picks a VERTEX — the point where two straight segments meet — and replaces
// the sharp corner with a tangent arc (fillet) or an equal-distance bevel
// (chamfer), computed analytically in SketchEdit2D.
//
// Two corner sources are recognised:
//   • two distinct `line` entities that share an endpoint, and
//   • an interior vertex of a `polyline` entity (rectangle / polygon).
// A polyline corner explodes the polyline into line entities (the two adjacent
// segments shortened) plus the new arc/chamfer — mirroring how trim treats
// polylines. Edits delete the source wire node(s) and create new ones under the
// same sketch, so tree, visuals and registry stay consistent. The mode stays
// active for repeated edits; pick another tool to leave.
// ============================================================

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  useCADStore, InteractionMode, SketchConstraint, SketchRef, sketchRefEq,
} from '../store/cadStore';
import { CADGeometryRegistry } from '../services/CADGeometryRegistry';
import { OccSketchService, fromLocal2D } from '../services/OccSketchService';
import {
  Pt, Line2D, Arc2D, filletCorner, chamferCorner,
} from '../services/SketchEdit2D';

const uid = () => crypto.randomUUID();
const fmt = (v: number) => `${Math.round(v * 100) / 100}`;   // compact label value

const CORNER_MODES = new Set<InteractionMode>(['EDIT_FILLET', 'EDIT_CHAMFER']);
const COLOR_MARKER = 0xff8800;
const PICK_TOL_PX  = 14;        // screen-space radius for snapping to a corner
const VERT_EPS     = 1e-6;      // two endpoints closer than this share a corner

// The radius (fillet) / distance (chamfer) for the next click. Set by the
// ribbon (via showParamModal) before entering the mode; persists between clicks.
let cornerValue = 2;
export const setSketchCornerValue = (v: number) => { if (v > 0) cornerValue = v; };

// ─── Corner candidates from the active sketch ─────────────────────────────────

interface SketchEntity { id: string; geom: any; }
type Corner =
  | { p2d: Pt; src: 'lines'; id1: string; id2: string; l1: Line2D; l2: Line2D }
  | { p2d: Pt; src: 'poly';  id: string; pts: Pt[]; closed: boolean; prev: Line2D; next: Line2D };

function gatherEntities(): SketchEntity[] {
  const st = useCADStore.getState();
  const sketchId = st.sketchSession?.id;
  if (!sketchId) return [];
  return Object.values(st.nodes)
    .filter((n) => n.type === 'sketch_wire' && n.parentId === sketchId
                && n.params?.sketchGeom && !n.params?.construction)
    .map((n) => ({ id: n.id, geom: n.params!.sketchGeom }));
}

const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= VERT_EPS;

/** Every fillet/chamfer-able corner in the active sketch, in sketch-local 2D. */
function gatherCorners(): Corner[] {
  const ents = gatherEntities();
  const corners: Corner[] = [];

  // (a) Pairs of distinct `line` entities sharing an endpoint.
  const lines = ents.filter((e) => e.geom?.kind === 'line')
    .map((e) => ({ id: e.id, L: { a: e.geom.a as Pt, b: e.geom.b as Pt } }));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i], B = lines[j];
      const shared = [A.L.a, A.L.b].find((p) => near(p, B.L.a) || near(p, B.L.b));
      if (shared) corners.push({ p2d: shared, src: 'lines', id1: A.id, id2: B.id, l1: A.L, l2: B.L });
    }
  }

  // (b) Interior vertices of polyline entities (rectangle / polygon / chain).
  for (const e of ents) {
    const g = e.geom;
    if (g?.kind !== 'polyline' || !Array.isArray(g.pts) || g.pts.length < 3) continue;
    const pts: Pt[] = g.pts;
    const closed = near(pts[0], pts[pts.length - 1]);
    // Unique vertex ring (drop the duplicated closing point).
    const ring = closed ? pts.slice(0, -1) : pts;
    const n = ring.length;
    const lo = closed ? 0 : 1;
    const hi = closed ? n - 1 : n - 2;
    for (let k = lo; k <= hi; k++) {
      const V = ring[k];
      const prevP = ring[(k - 1 + n) % n];
      const nextP = ring[(k + 1) % n];
      corners.push({
        p2d: V, src: 'poly', id: e.id, pts, closed,
        prev: { a: prevP, b: V }, next: { a: V, b: nextP },
      });
    }
  }
  return corners;
}

// ─── Node + wire construction ─────────────────────────────────────────────────

const PT = (id: string, pt: 'a' | 'b') => ({ kind: 'point' as const, id, pt });
const ENT = (id: string) => ({ kind: 'entity' as const, id });

function nodeShell(id: string, name: string, sketchId: string | null, wp: any, sketchGeom: any): any {
  return {
    id, name, type: 'sketch_wire', visible: true, locked: false, parentId: sketchId, notes: '',
    transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    material:  { color: 0x003388, roughness: 0.5, metalness: 0, wireframe: true, opacity: 1, transparent: false },
    params: { workplane: wp, sketchGeom },
  };
}

/** Build a line entity: register its OCC wire and return node + visual (not yet added). */
function makeLineEntity(oc: any, seg: Line2D, wp: any, sketchId: string | null, name: string) {
  const id = uid();
  const a3 = fromLocal2D(seg.a[0], seg.a[1], wp);
  const b3 = fromLocal2D(seg.b[0], seg.b[1], wp);
  const wire = OccSketchService.createClosedWireFromEdges(oc, [OccSketchService.createLineEdge(oc, a3, b3)]);
  CADGeometryRegistry.getInstance().registerShape(id, wire);
  return { id, node: nodeShell(id, name, sketchId, wp, { kind: 'line', a: seg.a, b: seg.b }),
           visual: { id, pts: [[a3.x, a3.y, a3.z], [b3.x, b3.y, b3.z]] } };
}

/** Build an arc entity: register its OCC wire and return node + sampled visual. */
function makeArcEntity(oc: any, arc: Arc2D, wp: any, sketchId: string | null, name: string) {
  const id = uid();
  const center = fromLocal2D(arc.c[0], arc.c[1], wp);
  const start  = fromLocal2D(arc.c[0] + arc.r * Math.cos(arc.a1), arc.c[1] + arc.r * Math.sin(arc.a1), wp);
  const end    = fromLocal2D(arc.c[0] + arc.r * Math.cos(arc.a2), arc.c[1] + arc.r * Math.sin(arc.a2), wp);
  const wire = OccSketchService.createClosedWireFromEdges(oc, [OccSketchService.createArcEdge(oc, center, start, end, wp)]);
  CADGeometryRegistry.getInstance().registerShape(id, wire);
  const SEGS = 48; const pts: number[][] = [];
  for (let i = 0; i <= SEGS; i++) {
    const a = arc.a1 + ((arc.a2 - arc.a1) * i) / SEGS;
    const p = fromLocal2D(arc.c[0] + arc.r * Math.cos(a), arc.c[1] + arc.r * Math.sin(a), wp);
    pts.push([p.x, p.y, p.z]);
  }
  return { id, node: nodeShell(id, name, sketchId, wp, { kind: 'arc', c: arc.c, r: arc.r, a1: arc.a1, a2: arc.a2 }),
           visual: { id, pts } };
}

/** Eccentric-angle start point of an arc (where pt 'a' lives). */
const arcStartPt = (arc: Arc2D): Pt => [arc.c[0] + arc.r * Math.cos(arc.a1), arc.c[1] + arc.r * Math.sin(arc.a1)];

/** Re-shape a line wire IN PLACE (same id): rebuild its OCC wire + swap the
 *  viewport line. Does NOT touch the store — the geom change rides in the single
 *  applySketchCornerEdit action so it's undoable. */
function reshapeLineWire(oc: any, id: string, seg: Line2D, wp: any) {
  const a3 = fromLocal2D(seg.a[0], seg.a[1], wp);
  const b3 = fromLocal2D(seg.b[0], seg.b[1], wp);
  const wire = OccSketchService.createClosedWireFromEdges(oc, [OccSketchService.createLineEdge(oc, a3, b3)]);
  CADGeometryRegistry.getInstance().registerShape(id, wire);
  window.dispatchEvent(new CustomEvent('cad-sketch-replace-visual', {
    detail: { id, pts: [[a3.x, a3.y, a3.z], [b3.x, b3.y, b3.z]] },
  }));
}

// ─── Edit application (reads fresh store state) ────────────────────────────────

function applyCorner(mode: InteractionMode, corner: Corner) {
  const oc = window.oc;
  const st = useCADStore.getState();
  const wp = st.sketchSession?.plane;
  const sketchId = st.sketchSession?.id ?? null;
  if (!oc || !wp || !sketchId) return;

  const isFillet = mode === 'EDIT_FILLET';
  const val = cornerValue;
  const tooBig = () => st.log(
    `${isFillet ? 'Radius' : 'Distance'} ${fmt(val)} is too large for this corner (or the edges are collinear).`, 'warn');
  const connName = isFillet ? `Fillet r${fmt(val)}` : `Chamfer d${fmt(val)}`;
  const ok = () => st.log(`${isFillet ? 'Filleted' : 'Chamfered'} corner (${isFillet ? 'r' : 'd'}=${fmt(val)}).`, 'success');

  if (corner.src === 'lines') {
    const { id1, id2, l1, l2 } = corner;
    const res = isFillet ? filletCorner(l1, l2, val) : chamferCorner(l1, l2, val);
    if (!res) { tooBig(); return; }
    const arc = (res as { arc?: Arc2D }).arc;
    const chamfer = (res as { chamfer?: Line2D }).chamfer;

    // Tangent points + each original line's far/corner endpoint roles.
    const T1 = res.lines[0].b, far1 = res.lines[0].a;   // res.lines[0] derives from l1
    const T2 = res.lines[1].a, far2 = res.lines[1].b;   // res.lines[1] derives from l2
    const cornerEnd1: 'a' | 'b' = near(l1.a, far1) ? 'b' : 'a';
    const cornerEnd2: 'a' | 'b' = near(l2.a, far2) ? 'b' : 'a';
    const short1: Line2D = cornerEnd1 === 'a' ? { a: T1, b: l1.b } : { a: l1.a, b: T1 };
    const short2: Line2D = cornerEnd2 === 'a' ? { a: T2, b: l2.b } : { a: l2.a, b: T2 };

    // Shorten the two lines IN PLACE (same ids) so their existing H/V and far-end
    // coincidence constraints survive untouched. (Registry + visual only — the
    // geom change rides in the single action below so it stays undoable.)
    reshapeLineWire(oc, id1, short1, wp);
    reshapeLineWire(oc, id2, short2, wp);

    // Build the connector (arc/chamfer) and figure out which of its endpoints
    // ('a'/'b') touches T1 vs T2.
    const conn = isFillet ? makeArcEntity(oc, arc!, wp, sketchId, connName)
                          : makeLineEntity(oc, chamfer!, wp, sketchId, connName);
    let t1End: 'a' | 'b' = 'a', t2End: 'a' | 'b' = 'b';   // chamfer: {a:T1, b:T2}
    if (isFillet) { const flip = !near(arcStartPt(arc!), T1); t1End = flip ? 'b' : 'a'; t2End = flip ? 'a' : 'b'; }

    const newCons: SketchConstraint[] = [
      { id: uid(), type: 'COINCIDENT', refs: [PT(id1, cornerEnd1), PT(conn.id, t1End)] },
      { id: uid(), type: 'COINCIDENT', refs: [PT(id2, cornerEnd2), PT(conn.id, t2End)] },
    ];
    if (isFillet) newCons.push(
      { id: uid(), type: 'TANGENT', refs: [ENT(id1), ENT(conn.id)] },
      { id: uid(), type: 'TANGENT', refs: [ENT(id2), ENT(conn.id)] },
    );

    // Drop the now-stale corner coincidence (id1@cornerEnd1 ≡ id2@cornerEnd2).
    const refA: SketchRef = PT(id1, cornerEnd1), refB: SketchRef = PT(id2, cornerEnd2);
    const existing = (st.nodes[sketchId]?.params?.constraints as SketchConstraint[] | undefined) ?? [];
    const kept = existing.filter((c) => !(
      c.type === 'COINCIDENT' && c.refs.length === 2 &&
      ((sketchRefEq(c.refs[0], refA) && sketchRefEq(c.refs[1], refB)) ||
       (sketchRefEq(c.refs[0], refB) && sketchRefEq(c.refs[1], refA)))));

    window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', { detail: conn.visual }));
    st.applySketchCornerEdit({
      description: connName, sketchId,
      geomUpdates: [
        { id: id1, sketchGeom: { kind: 'line', a: short1.a, b: short1.b } },
        { id: id2, sketchGeom: { kind: 'line', a: short2.a, b: short2.b } },
      ],
      addNodes: [conn.node],
      constraints: [...kept, ...newCons],
    });
    st.setSelectedIds([id1, id2, conn.id]);
    ok();
    return;
  }

  // ── Polyline corner: explode the chain into line entities + the connector,
  //    with coincidences linking every consecutive pair (so it stays joined). ──
  const res = isFillet ? filletCorner(corner.prev, corner.next, val) : chamferCorner(corner.prev, corner.next, val);
  if (!res) { tooBig(); return; }
  const arc = (res as { arc?: Arc2D }).arc;
  const chamfer = (res as { chamfer?: Line2D }).chamfer;

  const ring = corner.closed ? corner.pts.slice(0, -1) : corner.pts;
  const n = ring.length;
  const segCount = corner.closed ? n : n - 1;

  // Ordered descriptors around the ring. entry/exit = which endpoint role joins
  // to the previous / next entity.
  interface Desc { entity: ReturnType<typeof makeLineEntity>; entry: 'a' | 'b'; exit: 'a' | 'b'; isConn: boolean; }
  const descs: Desc[] = [];
  for (let k = 0; k < segCount; k++) {
    const a = ring[k], b = ring[(k + 1) % n];
    if (near(a, corner.prev.a) && near(b, corner.p2d)) {
      descs.push({ entity: makeLineEntity(oc, res.lines[0], wp, sketchId, 'Edge'), entry: 'a', exit: 'b', isConn: false });
      if (isFillet) {
        const flip = !near(arcStartPt(arc!), res.lines[0].b);   // arc start == T1 ?
        descs.push({ entity: makeArcEntity(oc, arc!, wp, sketchId, connName), entry: flip ? 'b' : 'a', exit: flip ? 'a' : 'b', isConn: true });
      } else {
        descs.push({ entity: makeLineEntity(oc, chamfer!, wp, sketchId, connName), entry: 'a', exit: 'b', isConn: true });
      }
    } else if (near(a, corner.p2d) && near(b, corner.next.b)) {
      descs.push({ entity: makeLineEntity(oc, res.lines[1], wp, sketchId, 'Edge'), entry: 'a', exit: 'b', isConn: false });
    } else {
      descs.push({ entity: makeLineEntity(oc, { a, b }, wp, sketchId, 'Edge'), entry: 'a', exit: 'b', isConn: false });
    }
  }

  // Coincidences between consecutive entities (+ wrap when the loop is closed).
  const cons: SketchConstraint[] = [];
  const last = corner.closed ? descs.length : descs.length - 1;
  for (let i = 0; i < last; i++) {
    const cur = descs[i], nxt = descs[(i + 1) % descs.length];
    cons.push({ id: uid(), type: 'COINCIDENT', refs: [PT(cur.entity.id, cur.exit), PT(nxt.entity.id, nxt.entry)] });
  }
  // Tangency at the fillet: connector ↔ its two neighbours.
  if (isFillet) {
    const ci = descs.findIndex((d) => d.isConn);
    const prevD = descs[(ci - 1 + descs.length) % descs.length];
    const nextD = descs[(ci + 1) % descs.length];
    cons.push(
      { id: uid(), type: 'TANGENT', refs: [ENT(prevD.entity.id), ENT(descs[ci].entity.id)] },
      { id: uid(), type: 'TANGENT', refs: [ENT(nextD.entity.id), ENT(descs[ci].entity.id)] },
    );
  }

  // Keep any unrelated sketch constraints; drop any that referenced the polyline.
  const existing = (st.nodes[sketchId]?.params?.constraints as SketchConstraint[] | undefined) ?? [];
  const kept = existing.filter((c) => !c.refs.some((r) => r.id === corner.id));

  for (const d of descs) window.dispatchEvent(new CustomEvent('cad-sketch-add-visual', { detail: d.entity.visual }));
  st.applySketchCornerEdit({
    description: connName, sketchId,
    addNodes: descs.map((d) => d.entity.node),
    removeIds: [corner.id],
    constraints: [...kept, ...cons],
  });
  st.setSelectedIds(descs.map((d) => d.entity.id));
  ok();
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCADSketchCorner(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sceneRef:     React.RefObject<THREE.Scene | null>,
  cameraRef:    React.RefObject<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>,
) {
  const mode = useCADStore((s) => s.interactionMode);
  const markerRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!CORNER_MODES.has(mode)) return;
    const verb = mode === 'EDIT_FILLET' ? 'Fillet' : 'Chamfer';
    useCADStore.getState().log(`${verb}: click a corner where two lines meet.`, 'info');
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ndc = new THREE.Vector2();
    const downPos = { x: 0, y: 0, active: false };

    /** Sketch-local corner → screen pixel position (or null if behind camera). */
    const cornerToScreen = (c: Corner): { x: number; y: number } | null => {
      const camera = cameraRef.current;
      const wp = useCADStore.getState().sketchSession?.plane;
      if (!camera || !wp) return null;
      const p3 = fromLocal2D(c.p2d[0], c.p2d[1], wp).project(camera);
      if (p3.z > 1) return null;
      const rect = container.getBoundingClientRect();
      return { x: (p3.x * 0.5 + 0.5) * rect.width, y: (-p3.y * 0.5 + 0.5) * rect.height };
    };

    /** Nearest corner to the mouse within PICK_TOL_PX, else null. */
    const pickCorner = (e: MouseEvent): Corner | null => {
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let best: Corner | null = null, bestD = PICK_TOL_PX;
      for (const c of gatherCorners()) {
        const s = cornerToScreen(c);
        if (!s) continue;
        const d = Math.hypot(s.x - mx, s.y - my);
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    };

    const clearMarker = () => {
      const scene = sceneRef.current;
      if (markerRef.current && scene) {
        scene.remove(markerRef.current);
        markerRef.current.geometry.dispose();
        (markerRef.current.material as THREE.Material).dispose();
      }
      markerRef.current = null;
    };

    const setMarker = (c: Corner | null) => {
      const scene = sceneRef.current;
      const wp = useCADStore.getState().sketchSession?.plane;
      const camera = cameraRef.current;
      clearMarker();
      container.style.cursor = c ? 'pointer' : 'default';
      if (!c || !scene || !wp || !camera) { window.cadRequestRender?.(); return; }
      const p = fromLocal2D(c.p2d[0], c.p2d[1], wp);
      // Size the marker ~10px on screen regardless of zoom/projection.
      const dist = camera instanceof THREE.PerspectiveCamera
        ? camera.position.distanceTo(p) : 1;
      const r = (camera instanceof THREE.OrthographicCamera)
        ? (camera.right - camera.left) / camera.zoom * 0.012
        : dist * 0.012;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(r, 1e-4), 16, 12),
        new THREE.MeshBasicMaterial({ color: COLOR_MARKER, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      mesh.position.copy(p);
      mesh.renderOrder = 999;
      scene.add(mesh);
      markerRef.current = mesh;
      window.cadRequestRender?.();
    };

    const onMove = (e: MouseEvent) => {
      if (!CORNER_MODES.has(useCADStore.getState().interactionMode)) return;
      setMarker(pickCorner(e));
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !CORNER_MODES.has(useCADStore.getState().interactionMode)) return;
      downPos.x = e.clientX; downPos.y = e.clientY; downPos.active = true;
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downPos.active) return;
      downPos.active = false;
      const m = useCADStore.getState().interactionMode;
      if (!CORNER_MODES.has(m)) return;
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;
      const c = pickCorner(e);
      if (!c) return;
      e.stopPropagation();
      setMarker(null);
      applyCorner(m, c);
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('mouseup',   onUp,   true);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('mouseup',   onUp,   true);
      clearMarker();
      container.style.cursor = 'default';
    };
  }, [containerRef, sceneRef, cameraRef]);
}
