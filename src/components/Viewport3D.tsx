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
import { useCADAssemblyMate }   from '../hooks/useCADAssemblyMate';
import { useCADAssemblyConcentric } from '../hooks/useCADAssemblyConcentric';
import { useCADSketchTransformPick } from '../hooks/useCADSketchTransformPick';
import { useCADExtrudeTargetPick } from '../hooks/useCADExtrudeTargetPick';
import { useCADDatumSketchPick } from '../hooks/useCADDatumSketchPick';
import { CADCameraService }    from '../services/CADCameraService';
import { CADViewportGizmo }   from './CADViewportGizmo';
import { SketchOverlay }       from './SketchOverlay';
import { SketchDimensions }    from './SketchDimensions';
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

function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
  });
}


export const Viewport3D: React.FC<Viewport3DProps> = ({ onReady }) => {
  const containerRef      = useRef<HTMLDivElement>(null);
  const sceneRef          = useRef<THREE.Scene | null>(null);
  const cameraRef         = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitRef          = useRef<OrbitControls | null>(null);
  const transformRef      = useRef<TransformControls | null>(null);
  const workplaneGridRef  = useRef<THREE.Object3D | null>(null);
  const datumGroupsRef    = useRef<Map<string, THREE.Group>>(new Map()); // datum_plane visuals by node id
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

  // ─── Sketch tool hook (handles all SKETCH_* modes) ───────────────────────────
  useCADSketchTool(containerRef, sceneRef, cameraRef);

  // ─── Edge-select hook (handles BLEND_EDGE mode for per-edge fillet/chamfer) ──
  useCADEdgeSelect(containerRef, sceneRef, cameraRef);

  // ─── Boolean-pick hook (handles BOOLEAN_PICK mode for base/tool selection) ───
  useCADBooleanPick(containerRef, sceneRef, cameraRef);

  // ─── Constraint-pick hook (handles CONSTRAIN mode entity selection) ──────────
  useCADConstraintPick(containerRef, sceneRef, cameraRef);

  // ─── Face-pick hook (handles FACE_SKETCH mode — sketch on a 3D face, S2) ──────
  useCADSketchFacePick(containerRef, sceneRef, cameraRef);

  // ─── Sketch-edit hook (EDIT_TRIM/EXTEND/SPLIT — 2D line editing, S1) ──────────
  useCADSketchEdit(containerRef, sceneRef, cameraRef);

  // ─── Assembly hooks (ASSEMBLY_MATE/ALIGN — faces; ASSEMBLY_CONCENTRIC — axes) ──
  useCADAssemblyMate(containerRef, sceneRef, cameraRef);
  useCADAssemblyConcentric(containerRef, sceneRef, cameraRef);

  // ─── 2D sketch transform reference picking (mirror line / array centre) ────────
  useCADSketchTransformPick(containerRef, sceneRef, cameraRef);

  // ─── Pad/Pocket boolean target picking (EXTRUDE_TARGET_PICK — E2) ──────────────
  useCADExtrudeTargetPick(containerRef, sceneRef, cameraRef);

  // ─── Sketch-on-datum-plane picking (DATUM_SKETCH — D9) ─────────────────────────
  useCADDatumSketchPick(containerRef, sceneRef, cameraRef);

  // ─── Camera: animate to view normal to workplane when sketch starts ──────────
  useEffect(() => {
    const isSketch = interactionMode.startsWith('SKETCH_');

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

    // Semi-transparent fill plane
    const planeMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
    );
    planeMesh.quaternion.copy(quat);
    planeMesh.position.copy(o);

    // Sketch grid overlay
    const grid = new THREE.GridHelper(120, 60, 0x2255aa, 0x1a3d7a);
    grid.quaternion.copy(quat);
    grid.position.copy(o);
    (grid.material as THREE.Material | THREE.Material[]);
    if (Array.isArray(grid.material)) {
      grid.material.forEach((m) => { (m as THREE.LineBasicMaterial).opacity = 0.55; (m as THREE.LineBasicMaterial).transparent = true; });
    }

    // Plane normal indicator arrow
    const arrowDir = n.clone();
    const arrowOrigin = o.clone();
    const arrow = new THREE.ArrowHelper(arrowDir, arrowOrigin, 8, 0x4488ff, 2, 1.2);

    const group = new THREE.Group();
    group.add(planeMesh, grid, arrow);
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
      if (node.type !== 'datum_plane') continue;
      const wp = node.params?.workplane;
      if (!wp) continue;
      seen.add(id);
      let g = groups.get(id);
      if (!g) { g = buildDatumPlaneGroup(id, wp); scene.add(g); groups.set(id, g); }
      g.visible = node.visible;
    }

    for (const [id, g] of groups) {
      if (!seen.has(id)) { scene.remove(g); disposeGroup(g); groups.delete(id); }
    }
  }, [nodes, sceneRef]);

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

    const camera = new THREE.PerspectiveCamera(
      45, container.clientWidth / container.clientHeight, 0.01, 5000,
    );
    camera.position.set(20, 18, 20);
    camera.lookAt(0, 0, 0);
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
      const newDist = camera.position.distanceTo(orbit.target) * factor;
      if (newDist < orbit.minDistance || newDist > orbit.maxDistance) { orbit.update(); return; }

      // Scale camera AND target from the focus point → real dolly toward cursor.
      camera.position.sub(_zFoc).multiplyScalar(factor).add(_zFoc);
      orbit.target  .sub(_zFoc).multiplyScalar(factor).add(_zFoc);
      orbit.update();
    };
    window.addEventListener('wheel', onWheelZoom, { passive: false, capture: true });

    // Render loop
    let rafId: number;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      orbit.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

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

    onReady?.(handleResize, scene, camera, orbit);
    window.cadScene = scene;

    return () => {
      cancelAnimationFrame(rafId);
      if (mousePosRafRef.current) cancelAnimationFrame(mousePosRafRef.current);
      window.removeEventListener('wheel', onWheelZoom, { capture: true });
      window.removeEventListener('cad-theme-changed', onThemeChanged);
      tc.dispose();
      orbit.dispose();
      renderer.dispose();
      container.removeEventListener('mousemove', onMouseMove);
      if (renderer.domElement.parentElement === container)
        container.removeChild(renderer.domElement);
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
        ThreeMeshCache.getInstance().invalidateMesh(id, scene, window.oc, material ?? node?.material);
      } catch (err: any) {
        console.error('[Viewport] update mesh:', err);
        useCADStore.getState().log(`Viewport update error: ${err?.message}`, 'error');
      }
    };

    window.addEventListener('cad-add-mesh',          onAdd);
    window.addEventListener('cad-remove-mesh',        onRemove);
    window.addEventListener('cad-duplicate-mesh',     onDuplicate);
    window.addEventListener('cad-material-changed',   onMaterial);
    window.addEventListener('cad-visibility-changed', onVisibility);
    window.addEventListener('cad-apply-transform',    onApplyTransform);
    window.addEventListener('cad-update-mesh',        onUpdate);
    return () => {
      window.removeEventListener('cad-add-mesh',          onAdd);
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
  // (the SketchOverlay handles hints while a tool is active)
  const sessionIdleHint = !interactionMode.startsWith('SKETCH_') && sketchSession
    ? `${sketchSession.name} · Pick a sketch tool or click Quit Sketch ✓`
    : null;

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <CADViewportGizmo />

      {/* Sketch coordinate input overlay — shown while a tool is drawing */}
      <SketchOverlay />

      {/* Live cursor dimension annotation — follows the mouse */}
      <CursorAnnotation />

      {/* Phase 8 – parametric dimension & constraint annotations */}
      <SketchDimensions />

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
