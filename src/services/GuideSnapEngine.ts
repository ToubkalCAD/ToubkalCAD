// ============================================================
// ToubkalCAD – GuideSnapEngine.ts
//
// Pure Three.js screen-space snapping for the 3D Guide-Curve tool. Given the
// mouse position it finds the nearest VERTEX or POINT-ON-EDGE of the profile
// wires currently rendered in the viewport, within a pixel tolerance.
//
// Why screen-space (pixel) tolerance and not a world-space raycaster threshold:
// a fixed world threshold snaps too eagerly when zoomed out and not at all when
// zoomed in. Projecting candidates to the canvas and comparing in PIXELS gives
// the constant ~15px "magnet" feel the user expects regardless of zoom.
//
// This module is intentionally free of any OCC / store dependency — it only
// reads Three.js objects tagged `userData.guideSnappable === true`. The hook
// (useCADGuideDraw) owns the interaction; the OCC side (OccGuideCurveService)
// re-projects the chosen point onto the real TopoDS_Wire for exactness.
// ============================================================

import * as THREE from 'three';

export type SnapKind = 'vertex' | 'edge';

export interface SnapResult {
  /** Snapped position in world space (Three.js coords). */
  point:   THREE.Vector3;
  kind:    SnapKind;
  /** id of the snapped object (object.userData.wireId), if tagged. */
  wireId?: string;
  /** Screen-space distance (px) from the cursor to the snap — for tie-breaking. */
  pixelDist: number;
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _closestOnSeg = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();

/** Project a world point to canvas pixels. Returns null if behind the camera. */
function worldToPixels(
  p: THREE.Vector3, camera: THREE.Camera, width: number, height: number,
): { x: number; y: number } | null {
  _v.copy(p).project(camera);                 // → NDC (-1..1), z>1 means behind
  if (_v.z > 1) return null;
  return { x: (_v.x * 0.5 + 0.5) * width, y: (-_v.y * 0.5 + 0.5) * height };
}

/** Closest point on segment [a,b] to the infinite pick ray (origin,dir). */
function closestPointOnSegmentToRay(
  a: THREE.Vector3, b: THREE.Vector3,
  rayOrigin: THREE.Vector3, rayDir: THREE.Vector3,
  out: THREE.Vector3,
): void {
  // Standard segment/line closest-point. Solve for s∈[0,1] along the segment.
  _ab.subVectors(b, a);
  _ap.subVectors(rayOrigin, a);
  const abDotD  = _ab.dot(rayDir);
  const abDotAb = _ab.dot(_ab);
  const apDotD  = _ap.dot(rayDir);
  const apDotAb = _ap.dot(_ab);
  const denom = abDotAb - abDotD * abDotD;          // dir is unit ⇒ d·d = 1
  let s = denom > 1e-9 ? (abDotD * apDotD - apDotAb) / -denom : 0;
  // NB sign: re-derive cleanly to avoid a flipped numerator.
  s = denom > 1e-9 ? (apDotAb - apDotD * abDotD) / denom : 0;
  s = Math.min(1, Math.max(0, s));
  out.copy(a).addScaledVector(_ab, s);
}

export interface SnapOptions {
  /** Pixel radius of the magnet (default 15). */
  pixelTolerance?: number;
  /** Prefer vertices over on-edge points when both are in range (default true). */
  preferVertices?: boolean;
}

/**
 * Find the best snap for the current cursor.
 *
 * @param pointerPx  Cursor position in CANVAS pixels ({x,y}, top-left origin).
 * @param camera     The live viewport camera.
 * @param snapRoots  Roots to search; any descendant Line/LineSegments tagged
 *                   `userData.guideSnappable === true` is considered.
 * @param size       Canvas size in pixels ({width,height}).
 */
export function findSnap(
  pointerPx:  { x: number; y: number },
  camera:     THREE.Camera,
  snapRoots:  THREE.Object3D[],
  size:       { width: number; height: number },
  opts:       SnapOptions = {},
): SnapResult | null {
  const tol = opts.pixelTolerance ?? 15;
  const preferVertices = opts.preferVertices ?? true;
  const { width, height } = size;

  // Build the pick ray once (camera → cursor), used for on-edge snapping.
  const ndc = new THREE.Vector2(
    (pointerPx.x / width) * 2 - 1,
    -(pointerPx.y / height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  _rayOrigin.copy(raycaster.ray.origin);
  _rayDir.copy(raycaster.ray.direction).normalize();

  let bestVertex: SnapResult | null = null;
  let bestEdge:   SnapResult | null = null;

  for (const root of snapRoots) {
    root.updateWorldMatrix(true, true);
    root.traverse((obj) => {
      if (obj.userData?.guideSnappable !== true) return;
      const line = obj as THREE.Line;
      const geom = (line.geometry as THREE.BufferGeometry | undefined);
      const posAttr = geom?.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!posAttr) return;
      const wireId: string | undefined = obj.userData.wireId;
      const matrix = obj.matrixWorld;
      const isSegments = (obj as THREE.LineSegments).isLineSegments === true;

      // ── Vertices: every geometry position is a candidate ──────────────
      for (let i = 0; i < posAttr.count; i++) {
        _a.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
        const px = worldToPixels(_a, camera, width, height);
        if (!px) continue;
        const d = Math.hypot(px.x - pointerPx.x, px.y - pointerPx.y);
        if (d <= tol && (!bestVertex || d < bestVertex.pixelDist)) {
          bestVertex = { point: _a.clone(), kind: 'vertex', wireId, pixelDist: d };
        }
      }

      // ── Edges: closest point on each segment to the pick ray ──────────
      const step = isSegments ? 2 : 1;
      const last = isSegments ? posAttr.count : posAttr.count - 1;
      for (let i = 0; i < last; i += step) {
        const j = isSegments ? i + 1 : i + 1;
        _a.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
        _b.fromBufferAttribute(posAttr, j).applyMatrix4(matrix);
        closestPointOnSegmentToRay(_a, _b, _rayOrigin, _rayDir, _closestOnSeg);
        const px = worldToPixels(_closestOnSeg, camera, width, height);
        if (!px) continue;
        const d = Math.hypot(px.x - pointerPx.x, px.y - pointerPx.y);
        if (d <= tol && (!bestEdge || d < bestEdge.pixelDist)) {
          bestEdge = { point: _closestOnSeg.clone(), kind: 'edge', wireId, pixelDist: d };
        }
      }
    });
  }

  // Cast to undo TS's null-narrowing of closure-mutated locals.
  const v = bestVertex as SnapResult | null;
  const e = bestEdge as SnapResult | null;
  if (preferVertices && v !== null) return v;
  if (v !== null && e !== null) return v.pixelDist <= e.pixelDist ? v : e;
  return v ?? e;
}
