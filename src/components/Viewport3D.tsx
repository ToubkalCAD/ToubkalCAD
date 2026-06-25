// ============================================================
// ToubkalCAD – Viewport3D.tsx
// Three.js scene: renderer, controls, gizmo, interactions.
// Fixes applied:
//   • onReady wrapped in useCallback in parent — effect is stable
//   • setTransformLive during drag, updateTransform on drag-end (1 undo entry)
//   • Measurement markers tracked and disposed on cleanup/mode change
//   • Mousemove world-pos throttled via rAF
//   • OccSelectionService: emissive highlight without material clone
// ============================================================

import '../types/index';
import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls }     from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer }     from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { useCADStore }         from '../store/cadStore';
import { OccSelectionService } from '../services/OccSelectionService';
import { ThreeMeshCache }      from '../services/ThreeMeshCache';
import { useCADGizmoHotkeys }  from '../hooks/useCADGizmoHotkeys';
import { useCADSketchTool }    from '../hooks/useCADSketchTool';
import { useCADEdgeSelect }    from '../hooks/useCADEdgeSelect';
import { useCADBooleanPick }   from '../hooks/useCADBooleanPick';
import { useCADConstraintPick } from '../hooks/useCADConstraintPick';
import { useCADSketchFacePick } from '../hooks/useCADSketchFacePick';
import { useCADSketchEdit }     from '../hooks/useCADSketchEdit';
import { useCADSketchCorner }   from '../hooks/useCADSketchCorner';
import { useCADGuideDraw }      from '../hooks/useCADGuideDraw';
import { useCADAssemblyMate }   from '../hooks/useCADAssemblyMate';
import { useCADAssemblyConcentric } from '../hooks/useCADAssemblyConcentric';
import { useCADSketchTransformPick } from '../hooks/useCADSketchTransformPick';
import { useCADExtrudeTargetPick } from '../hooks/useCADExtrudeTargetPick';
import { useCADProfilePick } from '../hooks/useCADProfilePick';
import { useCADDatumSketchPick } from '../hooks/useCADDatumSketchPick';
import { useCADDatumOffsetPick } from '../hooks/useCADDatumOffsetPick';
import { useCADDatum3PointPick } from '../hooks/useCADDatum3PointPick';
import { useCADDatumMidplanePick } from '../hooks/useCADDatumMidplanePick';
import { useCADDatumAnglePick } from '../hooks/useCADDatumAnglePick';
import { useCADDatumAxisPick } from '../hooks/useCADDatumAxisPick';
import { useCADDatumPointPick } from '../hooks/useCADDatumPointPick';
import { useCADDatumTangentPick } from '../hooks/useCADDatumTangentPick';
import { useCADDatumCurveNormalPick } from '../hooks/useCADDatumCurveNormalPick';
import { useCADDatum2EdgePick } from '../hooks/useCADDatum2EdgePick';
import { useCADSketchProjectPick } from '../hooks/useCADSketchProjectPick';
import { useCADSketchIntersectPick } from '../hooks/useCADSketchIntersectPick';
import { CADCameraService }    from '../services/CADCameraService';
import type { CADCamera, CADViewPreset } from '../services/CADCameraService';
import { CADViewportGizmo }   from './CADViewportGizmo';
import { SketchDimensionInput } from './SketchDimensionInput';
import { SketchDimensions }    from './SketchDimensions';
import { SketchDimensionLayer } from './SketchDimensionLayer';
import { useCADSmartDimension } from '../hooks/useCADSmartDimension';
import { CursorAnnotation }   from './CursorAnnotation';

interface Viewport3DProps {
  onReady?: (
    resizeFn: () => void,
    scene:    THREE.Scene,
    camera:   THREE.PerspectiveCamera,
    controls: OrbitControls,
  ) => void;
}

// ─── Datum-plane visual (Track D, D0) ─────────────────────────────────────────
// Fusion-style construction plane: translucent amber face + darker border,
// oriented from the node's workplane (u/v/normal). depthWrite:false so it never
// clips solids behind it. Tagged datumNodeId (not cadNodeId) so the solid pick
// hooks ignore it.
const DATUM_SIZE = 100;
function buildDatumPlaneGroup(id: string, wp: {
  origin: [number,number,number]; normal: [number,number,number];
  uAxis: [number,number,number]; vAxis: [number,number,number];
}): THREE.Group {
  const u = new THREE.Vector3(...wp.uAxis).normalize();
  const v = new THREE.Vector3(...wp.vAxis).normalize();
  const n = new THREE.Vector3(...wp.normal).normalize();
  const o = new THREE.Vector3(...wp.origin);

  const geo  = new THREE.PlaneGeometry(DATUM_SIZE, DATUM_SIZE);
  const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xf0a30a, side: THREE.DoubleSide, transparent: true, opacity: 0.16, depthWrite: false,
  }));
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0xd47a00, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  const group = new THREE.Group();
  group.add(face, border);
  group.applyMatrix4(new THREE.Matrix4().makeBasis(u, v, n).setPosition(o)); // local X→u, Y→v, Z→n
  group.userData.datumNodeId = id;
  face.userData.datumNodeId  = id;   // raycast target for DATUM_SKETCH pick (D9)
  group.renderOrder = 997;
  return group;
}

// Datum axis (Track D, D7): a long amber line through `origin` along `dir`, with
// a small node marker at the anchor. Tagged datumNodeId so visibility/cleanup are
// handled by the same datum sync, and so it can be a raycast target later.
const AXIS_HALF = 60;
function buildDatumAxisGroup(id: string, axis: {
  origin: [number,number,number]; dir: [number,number,number];
}): THREE.Group {
  const o = new THREE.Vector3(...axis.origin);
  const d = new THREE.Vector3(...axis.dir).normalize();
  const a = o.clone().addScaledVector(d, -AXIS_HALF);
  const b = o.clone().addScaledVector(d,  AXIS_HALF);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([a, b]),
    new THREE.LineBasicMaterial({ color: 0xf0a30a, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xd47a00, depthWrite: false }),
  );
  dot.position.copy(o);
  const group = new THREE.Group();
  group.add(line, dot);
  group.userData.datumNodeId = id;
  group.renderOrder = 997;
  return group;
}

// Datum point (Track D, D8): a small amber sphere marker at a world position.
function buildDatumPointGroup(id: string, point: [number,number,number]): THREE.Group {
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0xf0a30a, depthWrite: false }),
  );
  dot.position.set(point[0], point[1], point[2]);
  const group = new THREE.Group();
  group.add(dot);
  group.userData.datumNodeId = id;
  group.renderOrder = 997;
  return group;
}

function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
  });
}

// Frame a world-space bounding box in the active camera's CURRENT view
// direction — a projection-aware "zoom to fit". For perspective we dolly along
// the view axis to the distance at which the box's bounding sphere fits both the
// vertical and horizontal FOV; for orthographic we hold position and size the
// frustum via `zoom`. Shared by the initial origin-plane framing and the
// `cad-frame-all` event so the static default view matches the programmatic fit.
function fitCameraToBox(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: OrbitControls,
  box: THREE.Box3,
  margin = 1.15,
) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);

  // Preserve the current viewing direction; fall back to a friendly iso angle.
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dir.lengthSq() < 1e-9) dir.set(1, 0.85, 1);
  dir.normalize();

  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const cam  = camera as THREE.PerspectiveCamera;
    const vFov = THREE.MathUtils.degToRad(cam.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * cam.aspect);
    const dist = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * margin;
    cam.position.copy(center).addScaledVector(dir, dist);
    cam.near = Math.max(dist - radius * 2, 0.01);
    cam.far  = dist + radius * 4;
    cam.updateProjectionMatrix();
  } else {
    const cam   = camera as THREE.OrthographicCamera;
    const halfH = (cam.top - cam.bottom) / 2;          // base frustum half-height
    cam.position.copy(center).addScaledVector(dir, radius * 4);
    cam.zoom = halfH / (radius * margin);              // effective half-height = halfH / zoom
    cam.updateProjectionMatrix();
  }
  controls.target.copy(center);
  camera.lookAt(center);
  controls.update();
}

// Two-tier Fusion-style sketch grid: minor sub-divisions every 1 unit, kept
// exceptionally faint; major lines every 10 units, a muted light gray. Built in
// the XZ plane (normal +Y) so the caller's yUp→normal quaternion lays it onto the
// active workplane. No fill mesh — the active plane reads as fully transparent.
function buildSketchGrid(): THREE.Group {
  const HALF = 100, MAJOR = 10;
  const majorPts: number[] = [], minorPts: number[] = [];
  for (let v = -HALF; v <= HALF; v += 1) {
    const arr = v % MAJOR === 0 ? majorPts : minorPts;
    arr.push(-HALF, 0, v, HALF, 0, v);   // line parallel to X at z=v
    arr.push(v, 0, -HALF, v, 0, HALF);   // line parallel to Z at x=v
  }
  const mk = (pts: number[], opacity: number): THREE.LineSegments => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const ls = new THREE.LineSegments(
      g, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity, depthWrite: false }),
    );
    ls.renderOrder = -1;   // draw under geometry so it never z-fights sketch curves
    return ls;
  };
  const group = new THREE.Group();
  group.add(mk(minorPts, 0.04));   // rgba(0,0,0,0.04)
  group.add(mk(majorPts, 0.15));   // rgba(0,0,0,0.15)
  return group;
}


export const Viewport3D: React.FC<Viewport3DProps> = ({ onReady }) => {
  const containerRef      = useRef<HTMLDivElement>(null);
  const sceneRef          = useRef<THREE.Scene | null>(null);
  const cameraRef         = useRef<CADCamera | null>(null); // the ACTIVE camera (persp or ortho)
  const perspCamRef       = useRef<THREE.PerspectiveCamera | null>(null);
  const orthoCamRef       = useRef<THREE.OrthographicCamera | null>(null);
  const orbitRef          = useRef<OrbitControls | null>(null);
  const transformRef      = useRef<TransformControls | null>(null);
  const workplaneGridRef  = useRef<THREE.Object3D | null>(null);
  const datumGroupsRef    = useRef<Map<string, THREE.Group>>(new Map()); // datum_plane visuals by node id
  const hideDatumsRef     = useRef<boolean>(false);            // true while a 3D-op/blend/boolean panel is open
  const restoreCameraRef  = useRef<(() => void) | null>(null); // stored restore fn

  // Measurement — track scene objects for cleanup
  const measurePtsRef   = useRef<Array<[number, number, number]>>([]);
  const measureObjsRef  = useRef<Array<THREE.Object3D>>([]);

  // rAF throttle for world-pos updates
  const mousePosRafRef = useRef<number | null>(null);

  const selectedIds     = useCADStore((s) => s.selectedIds);
  const gizmoMode       = useCADStore((s) => s.gizmoMode);
  const interactionMode = useCADStore((s) => s.interactionMode);
  const activeWorkplane = useCADStore((s) => s.activeWorkplane);
  const sketchSession   = useCADStore((s) => s.sketchSession);
  const nodes           = useCADStore((s) => s.nodes);
  const updateTransform = useCADStore((s) => s.updateTransform);
  const setTransformLive = useCADStore((s) => s.setTransformLive);

  // Declutter the scene by hiding the datum planes (and other datums) while:
  //   • a 3D-op / blend / boolean panel is open (reference geometry, and the
  //     translucent planes are the most expensive thing to redraw on a weak GPU), OR
  //   • a sketch is active — the two-tier grid is the active plane, and all OTHER
  //     datum planes should drop away for a clean Fusion-style workspace.
  // Fully reversible: datums return to their own visibility afterwards.
  const editPanelOpen = useCADStore(
    (s) => !!(s.op3DPanelReq || s.blendReq || s.booleanReq) ||
           s.interactionMode.startsWith('SKETCH_') || !!s.sketchSession,
  );

  // ─── Sketch tool hook (handles all SKETCH_* modes) ───────────────────────────
  useCADSketchTool(containerRef, sceneRef, cameraRef);

  // ─── Edge-select hook (handles BLEND_EDGE mode for per-edge fillet/chamfer) ──
  useCADEdgeSelect(containerRef, sceneRef, cameraRef);

  // ─── Boolean-pick hook (handles BOOLEAN_PICK mode for base/tool selection) ───
  useCADBooleanPick(containerRef, sceneRef, cameraRef);

  // ─── Constraint-pick hook (handles CONSTRAIN mode entity selection) ──────────
  useCADConstraintPick(containerRef, sceneRef, cameraRef);

  // Smart Dimension tool (DIMENSION mode) — click entities → driving dim + annotation
  useCADSmartDimension(containerRef, sceneRef, cameraRef);

  // ─── Face-pick hook (handles FACE_SKETCH mode — sketch on a 3D face, S2) ──────
  useCADSketchFacePick(containerRef, sceneRef, cameraRef);

  // ─── Sketch-edit hook (EDIT_TRIM/EXTEND/SPLIT — 2D line editing, S1) ──────────
  useCADSketchEdit(containerRef, sceneRef, cameraRef);

  // ─── Sketch-corner hook (EDIT_FILLET/EDIT_CHAMFER — round/bevel a corner) ─────
  useCADSketchCorner(containerRef, sceneRef, cameraRef);

  // ─── Assembly hooks (ASSEMBLY_MATE/ALIGN — faces; ASSEMBLY_CONCENTRIC — axes) ──
  useCADAssemblyMate(containerRef, sceneRef, cameraRef);
  useCADAssemblyConcentric(containerRef, sceneRef, cameraRef);

  // ─── 2D sketch transform reference picking (mirror line / array centre) ────────
  useCADSketchTransformPick(containerRef, sceneRef, cameraRef);

  // ─── Pad/Pocket boolean target picking (EXTRUDE_TARGET_PICK — E2) ──────────────
  useCADExtrudeTargetPick(containerRef, sceneRef, cameraRef);

  // ─── Profile picking (PROFILE_PICK) — choose which sketch profiles to extrude ──
  useCADProfilePick(containerRef, sceneRef, cameraRef);

  // ─── Sketch-on-datum-plane picking (DATUM_SKETCH — D9) ─────────────────────────
  useCADDatumSketchPick(containerRef, sceneRef, cameraRef);

  // ─── Offset-plane reference picking (DATUM_OFFSET_PICK — D2) ───────────────────
  useCADDatumOffsetPick(containerRef, sceneRef, cameraRef);

  // ─── 3-point plane vertex picking (DATUM_3POINT_PICK — D4) ─────────────────────
  useCADDatum3PointPick(containerRef, sceneRef, cameraRef);

  // ─── Midplane two-face picking (DATUM_MIDPLANE_PICK — D5) ──────────────────────
  useCADDatumMidplanePick(containerRef, sceneRef, cameraRef);

  // ─── Plane-at-angle face+edge picking (DATUM_ANGLE_PICK — D3) ──────────────────
  useCADDatumAnglePick(containerRef, sceneRef, cameraRef);

  // ─── Datum-axis edge/cylinder picking (DATUM_AXIS_PICK — D7) ───────────────────
  useCADDatumAxisPick(containerRef, sceneRef, cameraRef);

  // ─── Datum-point vertex/edge picking (DATUM_POINT_PICK — D8) ───────────────────
  useCADDatumPointPick(containerRef, sceneRef, cameraRef);

  // ─── Advanced datum planes (D6): tangent / normal-to-curve / through-2-edges ───
  useCADDatumTangentPick(containerRef, sceneRef, cameraRef);
  useCADDatumCurveNormalPick(containerRef, sceneRef, cameraRef);
  useCADDatum2EdgePick(containerRef, sceneRef, cameraRef);

  // ─── Project (D11) / Intersect (D12) onto the active sketch ───────────────────
  useCADSketchProjectPick(containerRef, sceneRef, cameraRef);
  useCADSketchIntersectPick(containerRef, sceneRef, cameraRef);

  // ─── Advanced Loft: guide-curve drawing (GUIDE_PROFILE_PICK / GUIDE_DRAW) ─────
  useCADGuideDraw(containerRef, sceneRef, cameraRef);

  // Guide-tool overlay: red snap indicator + dashed Bezier preview, driven by the
  // 'cad-guide-snap' / 'cad-guide-preview' events the hook dispatches. The scene
  // is resolved lazily (sceneRef is populated by the main setup effect) and the
  // overlay group is created on first use, so this effect is order-independent.
  useEffect(() => {
    let group:     THREE.Group | null = null;
    let indicator: THREE.Mesh  | null = null;
    let preview:   THREE.Line  | null = null;
    let markers:   THREE.Mesh[] = [];   // interior control-pole handles

    const scene = (): THREE.Scene | null => sceneRef.current ?? (window.cadScene as THREE.Scene | null);
    const kick  = () => window.cadRequestRender?.();
    const clearMarkers = () => {
      const g = group;
      markers.forEach((m) => { if (g) g.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); });
      markers = [];
    };

    const ensureGroup = (): THREE.Group | null => {
      const s = scene();
      if (!s) return null;
      if (!group) {
        group = new THREE.Group();
        group.name = 'guide-overlay';
        indicator = new THREE.Mesh(
          new THREE.SphereGeometry(0.6, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xff3344, depthTest: false }),
        );
        indicator.renderOrder = 999;
        indicator.visible = false;
        group.add(indicator);
        s.add(group);
      }
      return group;
    };

    const onSnap = (e: Event) => {
      const d = (e as CustomEvent).detail as { point: { x: number; y: number; z: number } } | null;
      const g = ensureGroup();
      if (!g || !indicator) return;
      if (!d) { indicator.visible = false; }
      else { indicator.position.set(d.point.x, d.point.y, d.point.z); indicator.visible = true; }
      kick();
    };

    const onPreview = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        points:   { x: number; y: number; z: number }[];
        controls?: { x: number; y: number; z: number }[];
      } | null;
      const g = ensureGroup();
      if (!g) return;
      if (preview) { g.remove(preview); preview.geometry.dispose(); (preview.material as THREE.Material).dispose(); preview = null; }
      clearMarkers();
      if (d?.points?.length) {
        const geo = new THREE.BufferGeometry().setFromPoints(
          d.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
        preview = new THREE.Line(geo, new THREE.LineDashedMaterial(
          { color: 0xffaa00, dashSize: 1.5, gapSize: 1, depthTest: false }));
        preview.computeLineDistances();
        preview.renderOrder = 998;
        g.add(preview);
        // Interior control poles (skip the two locked endpoints) as cyan handles
        // so the user sees what the X/Y/Z sliders are moving.
        const ctrl = d.controls ?? [];
        for (let i = 1; i < ctrl.length - 1; i++) {
          const m = new THREE.Mesh(
            new THREE.SphereGeometry(0.8, 12, 10),
            new THREE.MeshBasicMaterial({ color: 0x33ddff, depthTest: false }),
          );
          m.position.set(ctrl[i].x, ctrl[i].y, ctrl[i].z);
          m.renderOrder = 999;
          g.add(m);
          markers.push(m);
        }
      }
      kick();
    };

    window.addEventListener('cad-guide-snap', onSnap);
    window.addEventListener('cad-guide-preview', onPreview);
    return () => {
      window.removeEventListener('cad-guide-snap', onSnap);
      window.removeEventListener('cad-guide-preview', onPreview);
      const s = scene();
      clearMarkers();
      if (group && s) s.remove(group);
      if (preview) { preview.geometry.dispose(); (preview.material as THREE.Material).dispose(); }
      if (indicator) { indicator.geometry.dispose(); (indicator.material as THREE.Material).dispose(); }
      group = indicator = preview = null;
    };
  }, []);

  // ─── Camera: animate to view normal to workplane when sketch starts ──────────
  useEffect(() => {
    // Align as soon as the sketch CONTEXT begins — when the session starts (even
    // before a 2D tool is picked, e.g. "Create Sketch" on a datum) or a tool is
    // chosen — so the view drops flat onto the plane immediately.
    const isSketch = interactionMode.startsWith('SKETCH_') || !!sketchSession;

    if (isSketch) {
      // Animate to the workplane-normal view ONCE per session. Re-animating on
      // every tool switch would call the old restore() and re-snapshot the
      // (already-rotated) pose as the new "saved" view — corrupting it so Quit
      // never returns to the original perspective. Only save if not yet saved.
      if (!restoreCameraRef.current) {
        const camera   = cameraRef.current;
        const controls = orbitRef.current;
        if (camera && controls) {
          restoreCameraRef.current = CADCameraService.animateToWorkplaneNormal(
            camera, controls, activeWorkplane,
          );
        }
      }
    } else if (!sketchSession) {
      // Leaving sketch entirely (no active session) — restore the pre-sketch camera
      if (restoreCameraRef.current) {
        restoreCameraRef.current();
        restoreCameraRef.current = null;
      }
    }
    // While a session is active but no tool is selected (SELECT mode between shapes),
    // we stay at the workplane-normal view so the user can keep drawing comfortably.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactionMode.startsWith('SKETCH_'), activeWorkplane, !!sketchSession]);

  // ─── Lock camera rotation while sketching ────────────────────────────────────
  // OrbitControls rotates on left-drag, so a tiny drag while clicking to place a
  // sketch point would orbit the view off the workplane normal. Disable rotation
  // for the whole sketch session (pan/zoom and view presets still work); re-enable
  // once the session ends. This keeps the head-on view locked until Quit Sketch.
  useEffect(() => {
    const orbit = orbitRef.current;
    if (!orbit) return;
    const inSketch = interactionMode.startsWith('SKETCH_') || !!sketchSession;
    orbit.enableRotate = !inSketch;
  }, [interactionMode, sketchSession]);

  // ─── Active Sketch Context: ghost the rest of the model while editing ────────
  // Industry-standard focus state (Fusion / Onshape): the active sketch and its
  // entities stay fully opaque and interactive; every OTHER body and sketch is
  // GHOSTED — translucent, desaturated, and depth-write OFF so it can never
  // occlude the sketch curves or grid — and made non-interactive (raycast
  // disabled) so a stray click can't select background geometry. The support /
  // host body stays visible (ghosted), preserving spatial orientation (2a).
  // Referencing still works: Project/Include builds its own pickable edge lines
  // (useCADSketchProjectPick), independent of these ghosted meshes' raycast state.
  //
  // Purely a Three.js material + raycast swap — it never touches store
  // node.visible, so it's fully reversible and doesn't pollute persistence.
  // Cleanup (on Quit Sketch or switching sketches) restores exactly what it changed.
  useEffect(() => {
    const scene = sceneRef.current;
    const sid = sketchSession?.id;
    if (!scene || !sid) return;

    const GHOST_OPACITY_SOLID = 0.16;
    const GHOST_OPACITY_LINE  = 0.30;

    // Clone a material into a ghosted variant: translucent, no depth write, and
    // desaturated/lifted toward a neutral mid-tone so its colour reads as "context".
    const ghostOne = (m: THREE.Material): THREE.Material => {
      const g = m.clone();
      g.transparent = true;
      g.depthWrite  = false;
      const isLine = m.type.includes('Line');
      g.opacity = isLine ? GHOST_OPACITY_LINE : GHOST_OPACITY_SOLID;
      const col = (g as THREE.MeshStandardMaterial).color as THREE.Color | undefined;
      if (col) {
        const hsl = { h: 0, s: 0, l: 0 };
        col.getHSL(hsl);
        col.setHSL(hsl.h, hsl.s * 0.2, Math.min(0.72, hsl.l * 0.5 + 0.42));
      }
      const std = g as THREE.MeshStandardMaterial;
      if ('metalness' in std) std.metalness = 0;
      if ('roughness' in std) std.roughness = 1;
      return g;
    };
    const ghostMat = (m: THREE.Material | THREE.Material[]) =>
      Array.isArray(m) ? m.map(ghostOne) : ghostOne(m);

    const NOOP: THREE.Object3D['raycast'] = () => {};
    const restores: Array<() => void> = [];

    const ghost = (root: THREE.Object3D) => {
      root.traverse((o) => {
        const holder = o as THREE.Mesh;   // Mesh / Line / Points all carry .material
        if (holder.material) {
          const orig  = holder.material;
          const ghosted = ghostMat(orig);
          holder.material = ghosted;
          restores.push(() => {
            holder.material = orig;
            (Array.isArray(ghosted) ? ghosted : [ghosted]).forEach((x) => x.dispose());
          });
        }
        if (holder.geometry) {             // make this renderable non-interactive
          const origRaycast = o.raycast;
          o.raycast = NOOP;
          restores.push(() => { o.raycast = origRaycast; });
        }
      });
    };

    const nodes = useCADStore.getState().nodes;
    scene.children.forEach((o) => {
      const nid = o.userData?.cadNodeId as string | undefined;
      if (!nid || nid === sid) return;            // unmanaged helpers + the sketch container
      const node = nodes[nid];
      if (!node) return;
      if (node.parentId === sid) return;          // this sketch's own entity → keep opaque
      ghost(o);
    });

    window.cadRequestRender?.();
    return () => {
      restores.forEach((r) => r());
      window.cadRequestRender?.();
    };
  }, [sketchSession?.id]);

  // ─── Camera: animate when a session is resumed from the tree panel ───────────
  useEffect(() => {
    const handler = (e: Event) => {
      const plane = (e as CustomEvent).detail.plane as import('../store/cadStore').Workplane;
      const camera   = cameraRef.current;
      const controls = orbitRef.current;
      if (!camera || !controls) return;
      // Cancel any existing restore so the session-end restore isn't stale
      if (restoreCameraRef.current) { restoreCameraRef.current(); restoreCameraRef.current = null; }
      restoreCameraRef.current = CADCameraService.animateToWorkplaneNormal(camera, controls, plane);
    };
    window.addEventListener('cad-session-resumed', handler);
    return () => window.removeEventListener('cad-session-resumed', handler);
  }, []);

  // ─── Workplane grid: shown when a sketch mode is active ──────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const removePrev = () => {
      if (workplaneGridRef.current) {
        scene.remove(workplaneGridRef.current);
        workplaneGridRef.current.traverse((o) => {
          if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
          if ((o as THREE.Mesh).material) {
            const m = (o as THREE.Mesh).material;
            if (Array.isArray(m)) m.forEach((x) => x.dispose()); else (m as THREE.Material).dispose();
          }
        });
        workplaneGridRef.current = null;
      }
    };

    // Show grid when using a sketch tool OR when a session is active
    const inSketchContext = interactionMode.startsWith('SKETCH_') || !!useCADStore.getState().sketchSession;
    if (!inSketchContext) { removePrev(); return; }

    removePrev();

    const { origin, normal } = activeWorkplane;
    const n = new THREE.Vector3(...normal).normalize();
    const o = new THREE.Vector3(...origin);

    // Quaternion: rotate GridHelper's default Y-normal to the workplane normal
    const yUp  = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      Math.abs(n.dot(yUp)) > 0.999 ? new THREE.Vector3(0, 0, 1) : yUp, n,
    );

    // Minimalist workspace: a clean two-tier grid only — no fill mesh (the active
    // plane reads as fully transparent) and no normal arrow. Drawing projects onto
    // a math plane, and picks exclude isWorkplaneHelper, so there's nothing to pick
    // here either.
    const group = buildSketchGrid();
    group.quaternion.copy(quat);
    group.position.copy(o);
    group.userData.isWorkplaneHelper = true;
    scene.add(group);
    workplaneGridRef.current = group;

    return removePrev;
  // sketchSession dependency ensures grid appears/disappears with the session
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactionMode, activeWorkplane, !!sketchSession]);

  // ─── Persistent datum-plane visuals (Track D, D0) ────────────────────────────
  // Sync amber construction planes to the datum_plane nodes in the store: add on
  // create, remove on delete, follow visibility. (Workplane edits rebuild later.)
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const groups = datumGroupsRef.current;
    const seen = new Set<string>();

    for (const id in nodes) {
      const node = nodes[id];
      // Signature + builder per datum kind; the sig lets us rebuild when the
      // geometry changes (e.g. D13 associative recompute moved the datum).
      let sig = '';
      let make: (() => THREE.Group) | null = null;
      const wp = node.params?.workplane, ax = node.params?.axis, pt = node.params?.point;
      if (node.type === 'datum_plane' && wp) {
        sig = JSON.stringify(wp); make = () => buildDatumPlaneGroup(id, wp);
      } else if (node.type === 'datum_axis' && ax) {
        sig = JSON.stringify(ax); make = () => buildDatumAxisGroup(id, ax);
      } else if (node.type === 'datum_point' && pt) {
        sig = JSON.stringify(pt); make = () => buildDatumPointGroup(id, pt);
      } else continue;

      seen.add(id);
      let g = groups.get(id);
      if (g && g.userData.datumSig !== sig) { scene.remove(g); disposeGroup(g); groups.delete(id); g = undefined; }
      if (!g) { g = make(); g.userData.datumSig = sig; scene.add(g); groups.set(id, g); }
      // Honour the edit-panel declutter (below) even as nodes change mid-edit
      // (e.g. a live preview adds a node and re-runs this sync).
      g.visible = node.visible && !hideDatumsRef.current;
    }

    for (const [id, g] of groups) {
      if (!seen.has(id)) { scene.remove(g); disposeGroup(g); groups.delete(id); }
    }
  }, [nodes, sceneRef]);

  // Toggle the datum declutter when an edit panel opens/closes.
  useEffect(() => {
    hideDatumsRef.current = editPanelOpen;
    const live = useCADStore.getState().nodes;
    for (const [id, g] of datumGroupsRef.current) {
      const visible = live[id]?.visible ?? true;
      g.visible = visible && !editPanelOpen;
    }
    window.cadRequestRender?.();
  }, [editPanelOpen]);

  // ─── Hotkeys ────────────────────────────────────────────────────────────────
  useCADGizmoHotkeys({
    onGizmoModeChange: (mode) => transformRef.current?.setMode(mode),
    onFrameSelection: useCallback(() => {
      const ids = useCADStore.getState().selectedIds;
      if (!ids.length || !sceneRef.current || !cameraRef.current || !orbitRef.current) return;
      const box = new THREE.Box3();
      sceneRef.current.children.forEach((o) => {
        if (o instanceof THREE.Mesh && ids.includes(o.userData.cadNodeId))
          box.expandByObject(o);
      });
      if (!box.isEmpty()) {
        const c = box.getCenter(new THREE.Vector3());
        const s = box.getSize(new THREE.Vector3()).length();
        orbitRef.current.target.copy(c);
        cameraRef.current.position.copy(c).add(new THREE.Vector3(s, s, s));
        orbitRef.current.update();
      }
    }, []),
  });

  // ─── Project mouse onto workplane (Y=0) with optional snap ──────────────────
  const projectToWorkplane = useCallback((
    e: MouseEvent,
    camera: THREE.Camera,
    container: HTMLDivElement,
  ): [number, number, number] | null => {
    const rect = container.getBoundingClientRect();
    const ndc  = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  *  2 - 1,
      ((e.clientY - rect.top)  / rect.height) * -2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt    = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, pt)) return null;
    const { snapEnabled, snapStep } = useCADStore.getState();
    if (snapEnabled) {
      pt.x = Math.round(pt.x / snapStep) * snapStep;
      pt.z = Math.round(pt.z / snapStep) * snapStep;
    }
    return [pt.x, pt.y, pt.z];
  }, []);

  // ─── Clear measurement objects from scene ───────────────────────────────────
  const clearMeasureObjs = useCallback(() => {
    if (!sceneRef.current) return;
    for (const obj of measureObjsRef.current) {
      sceneRef.current.remove(obj);
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      if ((obj as THREE.Mesh).material) {
        const mat = (obj as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else (mat as THREE.Material).dispose();
      }
    }
    measureObjsRef.current = [];
    measurePtsRef.current  = [];
  }, []);

  // ─── Three.js init — runs ONCE (onReady must be stable via useCallback) ─────
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(isDark() ? 0x15181d : 0xe3e8ee);
    sceneRef.current = scene;

    const aspect0 = container.clientWidth / container.clientHeight;
    const PERSP_FOV = 45;

    const perspCam = new THREE.PerspectiveCamera(PERSP_FOV, aspect0, 0.01, 5000);
    // Strategy 1 — frame the initial view to the standard 100mm origin planes so
    // they don't overwhelm the viewport on first load. Distance is derived the
    // same way fitCameraToBox would frame the XY/YZ/ZX corner (bounding-sphere
    // radius = DATUM_SIZE·√3/2), keeping the static default == programmatic fit.
    const initDir  = new THREE.Vector3(1, 0.85, 1).normalize();
    const initR    = DATUM_SIZE * Math.sqrt(3) / 2;
    const initDist = (initR / Math.sin(THREE.MathUtils.degToRad(PERSP_FOV) / 2)) * 1.15;
    perspCam.position.copy(initDir).multiplyScalar(initDist);
    perspCam.up.set(0, 1, 0);
    perspCam.lookAt(0, 0, 0);
    perspCamRef.current = perspCam;

    // Orthographic twin — frustum is sized on demand from the perspective view
    // when we switch into it (see switchProjection). Starts as a 1:1 placeholder.
    const orthoCam = new THREE.OrthographicCamera(-aspect0, aspect0, 1, -1, -5000, 5000);
    orthoCam.position.copy(perspCam.position);
    orthoCam.up.copy(perspCam.up);
    orthoCam.lookAt(0, 0, 0);
    orthoCamRef.current = orthoCam;

    // The ACTIVE camera starts perspective. `camera` always refers to whichever
    // projection is live; render loop / resize / picking all read cameraRef.
    let camera: CADCamera = perspCam;
    cameraRef.current = camera;
    window.cadCamera  = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    container.appendChild(renderer.domElement);

    // CSS2D overlay for dimension labels (crisp HTML text, editable, camera-facing).
    // The overlay layer ignores pointer events; individual labels re-enable them.
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(container.clientWidth, container.clientHeight);
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' } as CSSStyleDeclaration);
    container.appendChild(labelRenderer.domElement);
    window.cadLabelRenderer = labelRenderer;

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.06;
    orbit.minDistance   = 0.1;
    orbit.maxDistance   = 3000;
    orbitRef.current    = orbit;
    window.cadControls  = orbit;

    const tc = new TransformControls(camera, renderer.domElement);
    tc.setMode('translate');
    tc.setSize(0.8);
    scene.add(tc.getHelper());
    transformRef.current = tc;

    // ── On-demand rendering ────────────────────────────────────────────────────
    // Render only when something changes, not every frame: the expensive part
    // (shadows + AA at HiDPI) was running ~continuously and pinning the viewport at
    // ~20 fps, which then stalled visibly during synchronous OCC ops. orbit.update()
    // still runs each frame (cheap) to apply damping and fire 'change'; renderer.render
    // runs only while frames are requested OR while a camera flight / gizmo drag is
    // active (both disable orbit). Anything that mutates the scene calls requestRender.
    let renderFrames = 2;
    const requestRender = () => { renderFrames = Math.max(renderFrames, 2); };
    window.cadRequestRender = requestRender;
    orbit.addEventListener('change', requestRender);   // user input, damping, camera animations
    tc.addEventListener('change', requestRender);       // gizmo hover / handle redraw
    tc.addEventListener('objectChange', requestRender); // gizmo drag moves the mesh

    // Drag end → commit one undo entry
    tc.addEventListener('dragging-changed', (ev: any) => {
      orbit.enabled = !ev.value;
      if (!ev.value) {
        const mesh = tc.object as THREE.Mesh;
        if (mesh?.userData.cadNodeId) {
          updateTransform(
            mesh.userData.cadNodeId,
            [mesh.position.x, mesh.position.y, mesh.position.z],
            [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
          );
        }
      }
    });

    // Continuous drag → live update (no undo entry) + notify PropertiesPanel
    tc.addEventListener('objectChange', () => {
      const mesh = tc.object as THREE.Mesh;
      if (!mesh?.userData.cadNodeId) return;
      const id  = mesh.userData.cadNodeId as string;
      setTransformLive(
        id,
        [mesh.position.x, mesh.position.y, mesh.position.z],
        [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      );
      window.dispatchEvent(new CustomEvent('cad-object-dragging', {
        detail: { id, position: [mesh.position.x, mesh.position.y, mesh.position.z] },
      }));
    });

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(30, 60, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8899bb, 0.35);
    fill.position.set(-20, -10, -20);
    scene.add(fill);

    // Ground grid — theme-aware, recreated on theme change (GridHelper bakes
    // its colours into vertex data, so we rebuild rather than recolour).
    const makeGrid = (dark: boolean) =>
      new THREE.GridHelper(200, 200, dark ? 0x3a414c : 0xa8b4c0, dark ? 0x252a31 : 0xc8d0d8);
    let groundGrid = makeGrid(isDark());
    scene.add(groundGrid);

    const onThemeChanged = () => {
      const dark = isDark();
      scene.background = new THREE.Color(dark ? 0x15181d : 0xe3e8ee);
      scene.remove(groundGrid);
      groundGrid.geometry.dispose();
      (groundGrid.material as THREE.Material).dispose();
      groundGrid = makeGrid(dark);
      scene.add(groundGrid);
    };
    window.addEventListener('cad-theme-changed', onThemeChanged);

    // ── Zoom-to-cursor (immediate) ───────────────────────────────────────────
    // Registered on window with capture:true so it fires BEFORE Dockview (and
    // anything else) can swallow the wheel event. We own zoom; OrbitControls'
    // built-in dolly is disabled to avoid double handling.
    orbit.enableZoom = false;

    const _zrc  = new THREE.Raycaster();
    const _zFoc = new THREE.Vector3();
    const _zPl  = new THREE.Plane();
    const _zN   = new THREE.Vector3();

    const onWheelZoom = (e: WheelEvent) => {
      const rect = container.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top  || e.clientY > rect.bottom) return;
      e.preventDefault();

      // During a sketch session, zoom is a PURE DOLLY toward the orbit target
      // (focus = target) so the camera stays on its axis and the view remains
      // normal to the active workplane. Outside sketching we zoom to the cursor.
      const st = useCADStore.getState();
      const inSketch = !!st.sketchSession || st.interactionMode.startsWith('SKETCH_');
      if (inSketch) {
        _zFoc.copy(orbit.target);
      } else {
        const ndcX =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
        const ndcY = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
        _zrc.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
        const pickable = scene.children.filter(
          (c) => c instanceof THREE.Mesh && !c.userData.isWorkplaneHelper,
        );
        const hits = _zrc.intersectObjects(pickable, true);
        if (hits.length) {
          _zFoc.copy(hits[0].point);
        } else {
          _zN.copy(camera.position).sub(orbit.target).normalize();
          _zPl.setFromNormalAndCoplanarPoint(_zN, orbit.target);
          if (!_zrc.ray.intersectPlane(_zPl, _zFoc)) _zFoc.copy(orbit.target);
        }
      }

      // Normalise wheel delta across mouse/trackpad: deltaMode 1 = lines (~16px).
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // Proportional factor: <1 zoom in (wheel up), >1 zoom out (wheel down).
      const factor = Math.pow(0.999, px);
      // Orthographic has no perspective dolly — zooming changes the frustum
      // scale (camera.zoom). To still zoom toward the cursor, shift the
      // camera+target laterally so the focus point stays put on screen.
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const oc = camera as THREE.OrthographicCamera;
        const viewDir = new THREE.Vector3(); oc.getWorldDirection(viewDir);
        const planar  = _zFoc.clone().sub(orbit.target);
        planar.addScaledVector(viewDir, -planar.dot(viewDir)); // strip depth component
        const delta = planar.multiplyScalar(1 - factor);
        oc.position.add(delta);
        orbit.target.add(delta);
        oc.zoom = Math.max(1e-4, oc.zoom / factor);
        oc.updateProjectionMatrix();
        orbit.update();
        return;
      }

      const newDist = camera.position.distanceTo(orbit.target) * factor;
      if (newDist < orbit.minDistance || newDist > orbit.maxDistance) { orbit.update(); return; }

      // Scale camera AND target from the focus point → real dolly toward cursor.
      camera.position.sub(_zFoc).multiplyScalar(factor).add(_zFoc);
      orbit.target  .sub(_zFoc).multiplyScalar(factor).add(_zFoc);
      orbit.update();
    };
    window.addEventListener('wheel', onWheelZoom, { passive: false, capture: true });

    // ── Projection switching (perspective ↔ orthographic) ────────────────────
    // Standard CAD renders axis-aligned views orthographically so geometry on
    // parallel planes collapses to exact 1-D lines (a perspective camera always
    // shows a sliver of the far face's curvature). We keep the two cameras pose-
    // synced and just swap which one drives rendering / controls / picking.
    const switchProjection = (toOrtho: boolean) => {
      const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
      if (toOrtho === isOrtho) return;

      const next: CADCamera = toOrtho ? orthoCam : perspCam;
      next.position.copy(camera.position);
      next.quaternion.copy(camera.quaternion);
      next.up.copy(camera.up);

      const aspect = container.clientWidth / container.clientHeight;
      const halfFov = (PERSP_FOV * Math.PI / 180) / 2;

      if (toOrtho) {
        // Match the perspective framing at the orbit-target plane so the swap
        // is visually seamless: ortho half-height = dist · tan(fov/2).
        const dist  = camera.position.distanceTo(orbit.target);
        const halfH = Math.max(1e-3, dist * Math.tan(halfFov));
        orthoCam.top = halfH;  orthoCam.bottom = -halfH;
        orthoCam.left = -halfH * aspect;  orthoCam.right = halfH * aspect;
        orthoCam.zoom = 1;
        orthoCam.updateProjectionMatrix();
      } else {
        // Back to perspective: dolly so the framing matches the current ortho
        // scale, then the standard FOV takes over.
        const effHalfH = ((orthoCam.top - orthoCam.bottom) / 2) / orthoCam.zoom;
        const newDist  = effHalfH / Math.tan(halfFov);
        const dir = new THREE.Vector3().subVectors(perspCam.position, orbit.target).normalize();
        perspCam.position.copy(orbit.target).addScaledVector(dir, newDist);
        perspCam.updateProjectionMatrix();
      }

      camera = next;
      cameraRef.current = camera;
      window.cadCamera  = camera;
      orbit.object = camera;
      tc.camera    = camera;
      orbit.update();
    };

    // Single owner of view presets: choose projection, then orient. All triggers
    // (menu, view bar, numpad, viewcube, gizmo) funnel here via this event.
    const onViewPreset = (e: Event) => {
      const preset = (e as CustomEvent).detail as CADViewPreset;
      if (!preset) return;
      switchProjection(CADCameraService.isOrthoPreset(preset));
      CADCameraService.applyViewPreset(preset, camera, orbit);
    };
    window.addEventListener('cad-view-preset', onViewPreset);

    // Generic projection toggle (no reorientation) — used by the orientation
    // gizmo so its axis snaps land in orthographic like the standard presets.
    const onSetProjection = (e: Event) => {
      switchProjection((e as CustomEvent).detail === 'ORTHO');
    };
    window.addEventListener('cad-set-projection', onSetProjection);

    // Strategy 2 — programmatic "zoom to fit": box every visible solid + datum
    // (top-level so ancestor visibility is honoured) and frame it in the active
    // projection. Fired e.g. right after the origin planes are created on load.
    const onFrameAll = () => {
      const box = new THREE.Box3();
      for (const o of scene.children) {
        if (!o.visible) continue;
        const ud = o.userData || {};
        if (ud.cadNodeId || ud.datumNodeId) box.expandByObject(o);
      }
      if (box.isEmpty()) return;
      fitCameraToBox(camera, orbit, box);
      requestRender();
    };
    window.addEventListener('cad-frame-all', onFrameAll);

    // Render loop
    let rafId: number;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      orbit.update();   // cheap; applies damping and fires 'change' (→ requestRender) while moving
      // Keep the idle camera pose-synced so the viewcube/gizmo (which may hold a
      // ref to the perspective twin) read the correct orientation in ortho mode.
      const idle = camera === perspCam ? orthoCam : perspCam;
      idle.position.copy(camera.position);
      idle.quaternion.copy(camera.quaternion);
      idle.up.copy(camera.up);
      // Render on demand: while frames are queued, OR while a camera flight / gizmo
      // drag is active (those disable orbit, so keep drawing every frame until done).
      if (renderFrames > 0 || !orbit.enabled) {
        if (renderFrames > 0) renderFrames--;
        renderer.render(scene, camera);
        labelRenderer.render(scene, camera);   // reproject dimension labels onto the canvas
      }
    };
    animate();

    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const aspect = w / h;
      perspCam.aspect = aspect;
      perspCam.updateProjectionMatrix();
      // Preserve the ortho vertical extent; refit horizontal span to new aspect.
      const halfH = (orthoCam.top - orthoCam.bottom) / 2;
      orthoCam.left = -halfH * aspect;  orthoCam.right = halfH * aspect;
      orthoCam.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      requestRender();
    };

    // Any scene mutation → request a render. The store covers state-driven changes
    // (add/remove/select/material/visibility/transform); the cad-* events cover the
    // imperative viewport mutations; pointer-move covers tool hover highlights.
    const unsubStore = useCADStore.subscribe(requestRender);
    const SCENE_EVENTS = [
      'cad-add-mesh', 'cad-update-mesh', 'cad-remove-mesh', 'cad-duplicate-mesh',
      'cad-material-changed', 'cad-visibility-changed', 'cad-apply-transform',
      'cad-sketch-add-visual', 'cad-sketch-replace-visual', 'cad-frame-selection',
      'cad-view-preset', 'cad-set-projection', 'cad-session-resumed', 'cad-theme-changed',
      'cad-request-render',
    ];
    SCENE_EVENTS.forEach((ev) => window.addEventListener(ev, requestRender));
    container.addEventListener('pointermove', requestRender);

    // Throttled world-space cursor coordinates → StatusBar
    const workPlane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const raycaster  = new THREE.Raycaster();
    const tmpVec     = new THREE.Vector3();
    const onMouseMove = (e: MouseEvent) => {
      if (mousePosRafRef.current !== null) return;
      mousePosRafRef.current = requestAnimationFrame(() => {
        mousePosRafRef.current = null;
        const rect = container.getBoundingClientRect();
        raycaster.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width)  *  2 - 1,
            -((e.clientY - rect.top)  / rect.height) *  2 + 1,
          ),
          camera,
        );
        if (raycaster.ray.intersectPlane(workPlane, tmpVec)) {
          window.dispatchEvent(new CustomEvent('cad-mouse-world-pos', {
            detail: { x: tmpVec.x, y: tmpVec.y, z: tmpVec.z },
          }));
        }
      });
    };
    container.addEventListener('mousemove', onMouseMove);

    onReady?.(handleResize, scene, perspCam, orbit);
    window.cadScene = scene;

    return () => {
      cancelAnimationFrame(rafId);
      if (mousePosRafRef.current) cancelAnimationFrame(mousePosRafRef.current);
      window.removeEventListener('wheel', onWheelZoom, { capture: true });
      window.removeEventListener('cad-view-preset', onViewPreset);
      window.removeEventListener('cad-set-projection', onSetProjection);
      window.removeEventListener('cad-frame-all', onFrameAll);
      window.removeEventListener('cad-theme-changed', onThemeChanged);
      orbit.removeEventListener('change', requestRender);
      tc.removeEventListener('change', requestRender);
      tc.removeEventListener('objectChange', requestRender);
      unsubStore();
      SCENE_EVENTS.forEach((ev) => window.removeEventListener(ev, requestRender));
      container.removeEventListener('pointermove', requestRender);
      window.cadRequestRender = undefined;
      tc.dispose();
      orbit.dispose();
      renderer.dispose();
      container.removeEventListener('mousemove', onMouseMove);
      if (renderer.domElement.parentElement === container)
        container.removeChild(renderer.domElement);
      if (labelRenderer.domElement.parentElement === container)
        container.removeChild(labelRenderer.domElement);
      window.cadLabelRenderer = null;
      window.cadScene   = null;
      window.cadCamera  = null;
      window.cadControls = null;
    };
  // onReady MUST be stable (wrapped in useCallback in CADLayout)
  }, [onReady, updateTransform, setTransformLive]);

  // ─── Scene events: add / remove / duplicate / material / visibility ──────────
  useEffect(() => {
    const onAdd = (e: Event) => {
      const { id } = (e as CustomEvent).detail;
      if (!sceneRef.current || !window.oc) return;
      const node = useCADStore.getState().nodes[id];
      // Sketch nodes (session containers and wires) have no OCC shape to tessellate.
      if (node?.type === 'sketch_wire' || node?.type === 'sketch') return;
      try {
        const mesh = ThreeMeshCache.getInstance().getOrCreateMesh(id, window.oc, 0.1, node?.material);
        sceneRef.current.add(mesh);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error('[Viewport] add mesh:', err);
        useCADStore.getState().log(`Viewport error: ${msg}`, 'error');
      }
    };

    const onRemove = (e: Event) => {
      const { id } = (e as CustomEvent).detail;
      const scene = sceneRef.current;
      if (!scene) return;
      // If the gizmo is attached to this mesh (e.g. a selected feature freed by
      // suppress / rollback), detach before disposing so it isn't left pointing
      // at a removed object.
      const tc = transformRef.current;
      if (tc && (tc.object as THREE.Object3D | undefined)?.userData?.cadNodeId === id) tc.detach();
      // Remove tessellated mesh (3D shapes)
      ThreeMeshCache.getInstance().disposeMesh(id, scene);
      // Remove any sketch wire lines (Three.Line objects) that are still in the scene
      // as a safety net — the hook's Zustand subscription handles these first,
      // but this path catches any that slip through.
      const toRemove = scene.children.filter((c) => c.userData?.cadNodeId === id);
      toRemove.forEach((obj) => {
        scene.remove(obj);
        const line = obj as THREE.Line;
        if (line.geometry) line.geometry.dispose();
        if (line.material) {
          if (Array.isArray(line.material)) line.material.forEach((m) => m.dispose());
          else (line.material as THREE.Material).dispose();
        }
      });
    };

    const onDuplicate = (e: Event) => {
      const { sourceId, newId } = (e as CustomEvent).detail;
      if (!sceneRef.current || !window.oc) return;
      try {
        const node = useCADStore.getState().nodes[newId];
        const mesh = ThreeMeshCache.getInstance().getOrCreateMesh(newId, window.oc, 0.1, node?.material);
        const src  = sceneRef.current.children.find((c) => c.userData?.cadNodeId === sourceId);
        if (src) {
          mesh.position.copy((src as THREE.Mesh).position);
          mesh.position.x += 5;
          mesh.position.z += 5;
        }
        sceneRef.current.add(mesh);
      } catch (err) { console.error('[Viewport] duplicate mesh:', err); }
    };

    const onMaterial = (e: Event) => {
      const { id, material } = (e as CustomEvent).detail;
      ThreeMeshCache.getInstance().applyMaterial(id, material);
    };

    const onVisibility = (e: Event) => {
      const { id, visible } = (e as CustomEvent).detail;
      const obj = sceneRef.current?.children.find((c) => c.userData?.cadNodeId === id);
      if (obj) obj.visible = visible;
    };

    const onApplyTransform = (e: Event) => {
      const { id, position, rotation } = (e as CustomEvent).detail;
      const mesh = sceneRef.current?.children.find(
        (c) => c.userData?.cadNodeId === id,
      ) as THREE.Mesh | undefined;
      if (mesh) {
        mesh.position.set(...(position as [number, number, number]));
        mesh.rotation.set(...(rotation as [number, number, number]));
      }
    };

    // Re-tessellate an existing node after its OCC shape was updated in-place
    const onUpdate = (e: Event) => {
      const { id, material } = (e as CustomEvent).detail;
      const scene = sceneRef.current;
      if (!scene || !window.oc) return;
      try {
        const node = useCADStore.getState().nodes[id];
        const newMesh = ThreeMeshCache.getInstance().invalidateMesh(id, scene, window.oc, material ?? node?.material);
        // invalidateMesh disposes the old mesh and builds a fresh one. If the
        // gizmo was attached to that (now-removed) mesh — e.g. recompute
        // propagated an upstream edit onto the selected downstream feature —
        // re-attach it to the new mesh so TransformControls keeps a live target.
        const tc = transformRef.current;
        if (tc && (tc.object as THREE.Object3D | undefined)?.userData?.cadNodeId === id) {
          tc.detach();
          tc.attach(newMesh);
        }
      } catch (err: any) {
        console.error('[Viewport] update mesh:', err);
        useCADStore.getState().log(`Viewport update error: ${err?.message}`, 'error');
      }
    };

    // Full viewport wipe (New / Open project): dispose every tessellated mesh,
    // then sweep any leftover imperative objects (sketch wire lines carry
    // cadNodeId; datum helpers carry datumNodeId).
    const onSceneReset = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      transformRef.current?.detach();
      ThreeMeshCache.getInstance().clearAll(scene);
      const stray = scene.children.filter(
        (c) => c.userData?.cadNodeId || c.userData?.datumNodeId,
      );
      stray.forEach((obj) => { scene.remove(obj); disposeGroup(obj); });
      datumGroupsRef.current.clear();
    };

    window.addEventListener('cad-add-mesh',          onAdd);
    window.addEventListener('cad-scene-reset',        onSceneReset);
    window.addEventListener('cad-remove-mesh',        onRemove);
    window.addEventListener('cad-duplicate-mesh',     onDuplicate);
    window.addEventListener('cad-material-changed',   onMaterial);
    window.addEventListener('cad-visibility-changed', onVisibility);
    window.addEventListener('cad-apply-transform',    onApplyTransform);
    window.addEventListener('cad-update-mesh',        onUpdate);
    return () => {
      window.removeEventListener('cad-add-mesh',          onAdd);
      window.removeEventListener('cad-scene-reset',        onSceneReset);
      window.removeEventListener('cad-remove-mesh',        onRemove);
      window.removeEventListener('cad-duplicate-mesh',     onDuplicate);
      window.removeEventListener('cad-material-changed',   onMaterial);
      window.removeEventListener('cad-visibility-changed', onVisibility);
      window.removeEventListener('cad-apply-transform',    onApplyTransform);
      window.removeEventListener('cad-update-mesh',        onUpdate);
    };
  }, []);

  // ─── Gizmo mode sync ────────────────────────────────────────────────────────
  useEffect(() => { transformRef.current?.setMode(gizmoMode); }, [gizmoMode]);

  // ─── Attach gizmo to selected mesh ──────────────────────────────────────────
  useEffect(() => {
    if (!sceneRef.current || !transformRef.current) return;
    const tc = transformRef.current;
    if (!selectedIds.length) {
      tc.detach();
    } else {
      const mesh = sceneRef.current.children.find(
        (c) => c.userData?.cadNodeId === selectedIds[0] && c instanceof THREE.Mesh,
      ) as THREE.Mesh | undefined;
      if (mesh) tc.attach(mesh);
      else tc.detach();
    }
  }, [selectedIds]);

  // ─── Mouse interactions (mode-driven) ───────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !cameraRef.current || !sceneRef.current) return;
      const camera = cameraRef.current;
      const scene  = sceneRef.current;
      const mode   = useCADStore.getState().interactionMode;

      // ── Select ─────────────────────────────────────────────────────────────
      if (mode === 'SELECT') {
        OccSelectionService.handleSceneSelection(e, container, camera, scene);
        return;
      }

      // ── Measure Distance ───────────────────────────────────────────────────
      if (mode === 'MEASURE_DISTANCE') {
        const rect = container.getBoundingClientRect();
        const ray  = new THREE.Raycaster();
        ray.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width)  *  2 - 1,
            -((e.clientY - rect.top)  / rect.height) *  2 + 1,
          ),
          camera,
        );
        const hits = ray.intersectObjects(
          scene.children.filter((c) => c instanceof THREE.Mesh && c.userData.cadNodeId), true,
        );
        const pt = hits.length > 0
          ? hits[0].point.clone()
          : (() => {
              const v = new THREE.Vector3();
              ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), v);
              return v;
            })();

        // Marker sphere
        const markerGeo = new THREE.SphereGeometry(0.2, 8, 8);
        const markerMat = new THREE.MeshBasicMaterial({ color: 0xff4400 });
        const marker    = new THREE.Mesh(markerGeo, markerMat);
        marker.position.copy(pt);
        scene.add(marker);
        measureObjsRef.current.push(marker);
        measurePtsRef.current.push([pt.x, pt.y, pt.z]);

        if (measurePtsRef.current.length === 2) {
          const [a, b] = measurePtsRef.current;
          const dist = Math.sqrt((b[0]-a[0])**2 + (b[1]-a[1])**2 + (b[2]-a[2])**2);

          // Measurement line
          const lineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(...a), new THREE.Vector3(...b),
          ]);
          const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xff4400 }));
          scene.add(line);
          measureObjsRef.current.push(line);

          useCADStore.getState().addMeasurement({
            label: `Dist-${Date.now().toString(36)}`,
            type:  'distance',
            pointA: a, pointB: b,
            value:  dist,
          });
          useCADStore.getState().log(`Distance: ${dist.toFixed(3)} mm`, 'success');
          useCADStore.getState().setInteractionMode('SELECT');
          measurePtsRef.current = [];
        }
      }
    };

    container.style.cursor = interactionMode === 'SELECT' ? 'default' : 'crosshair';
    container.addEventListener('mousedown', onMouseDown);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
    };
  }, [interactionMode, projectToWorkplane, clearMeasureObjs]);

  // Session idle hint — shown only when in a session but no sketch tool active
  // (the SketchDimensionInput shows the live dimension while a tool is active)
  const sessionIdleHint = !interactionMode.startsWith('SKETCH_') && sketchSession
    ? `${sketchSession.name} · Pick a sketch tool or click Quit Sketch ✓`
    : null;

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <CADViewportGizmo />

      {/* Viewport-embedded driving-dimension input — shown while a tool is drawing */}
      <SketchDimensionInput />

      {/* Live cursor dimension annotation — follows the mouse */}
      <CursorAnnotation />

      {/* Phase 8 – parametric dimension & constraint annotations */}
      <SketchDimensions />

      {/* Persistent driving-dimension annotations (Three.js + CSS2D) */}
      <SketchDimensionLayer containerRef={containerRef} />

      {/* Session idle hint — shown between shapes when no tool selected */}
      {sessionIdleHint && (
        <div style={{
          position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(60,30,0,0.88)', color: '#ffcc80',
          padding: '5px 14px', borderRadius: 4, fontSize: 11,
          pointerEvents: 'none', zIndex: 20, whiteSpace: 'nowrap',
          border: '1px solid rgba(255,153,0,0.4)',
        }}>
          {sessionIdleHint}
        </div>
      )}
    </div>
  );
};
