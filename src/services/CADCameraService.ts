// ============================================================
// ToubkalCAD – CADCameraService.ts
// Camera preset views + animated workplane-normal transitions.
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Workplane } from '../store/cadStore';

export type CADViewPreset = 'PERSPECTIVE' | 'TOP' | 'FRONT' | 'RIGHT' | 'ISOMETRIC';

export class CADCameraService {

  // ─── Standard preset views ────────────────────────────────────────────────

  static applyViewPreset(
    preset:        CADViewPreset,
    camera:        THREE.Camera,
    controls:      OrbitControls,
    boundingRadius = 15,
  ): void {
    const target = new THREE.Vector3(0, 0, 0);
    controls.target.copy(target);
    const distance = boundingRadius * 2.5;

    switch (preset) {
      case 'TOP':
        camera.position.set(0, distance, 0);
        camera.up.set(0, 0, -1);
        break;
      case 'FRONT':
        camera.position.set(0, 0, distance);
        camera.up.set(0, 1, 0);
        break;
      case 'RIGHT':
        camera.position.set(distance, 0, 0);
        camera.up.set(0, 1, 0);
        break;
      case 'ISOMETRIC': {
        const c = distance / Math.sqrt(3);
        camera.position.set(c, c, c);
        camera.up.set(0, 1, 0);
        break;
      }
      case 'PERSPECTIVE':
      default:
        camera.position.set(boundingRadius, boundingRadius, boundingRadius);
        camera.up.set(0, 1, 0);
        break;
    }

    camera.lookAt(target);
    controls.update();
  }

  // ─── Compute camera "up" for a workplane normal view ─────────────────────
  // We want the workplane's uAxis to point RIGHT on screen, vAxis UP.
  // For a right-handed workplane (cross(U,V)=N): camera.up = V gives U right.
  // For a left-handed workplane (cross(U,V)=-N): camera.up = -V gives U right.

  static computeCameraUp(wp: Workplane): THREE.Vector3 {
    const n    = new THREE.Vector3(...wp.normal).normalize();
    const u    = new THREE.Vector3(...wp.uAxis).normalize();
    const v    = new THREE.Vector3(...wp.vAxis).normalize();
    const fwd  = n.clone().negate(); // camera looks from +N toward -N (origin)

    // Test: with camera.up = v, what would screen-right be?
    const testRight = new THREE.Vector3().crossVectors(fwd, v).normalize();
    // If testRight points opposite to uAxis, negate v so U goes right
    return testRight.dot(u) >= 0 ? v.clone() : v.clone().negate();
  }

  // ─── Animated transition to view normal to a workplane ───────────────────
  // camera:   perspective camera to animate
  // controls: OrbitControls whose target is animated to workplane origin
  // wp:       the active workplane
  // durationMs: animation length (default 550ms)
  // Returns: a "restore" function that animates back to the original view.

  // ─── Animated transition to an arbitrary camera pose ─────────────────────
  // Used by the viewport orientation gizmo for click-to-snap axis views.

  static animateToPose(
    camera:      THREE.PerspectiveCamera,
    controls:    OrbitControls,
    targetPos:   THREE.Vector3,
    lookAt:      THREE.Vector3,
    up:          THREE.Vector3,
    durationMs   = 480,
  ): void {
    const fromPos    = camera.position.clone();
    const fromTarget = controls.target.clone();
    const fromUp     = camera.up.clone();

    controls.enabled = false;
    const t0 = performance.now();
    let raf: number;

    const tick = () => {
      const raw = Math.min((performance.now() - t0) / durationMs, 1);
      const t   = 1 - Math.pow(1 - raw, 3); // cubic ease-out

      camera.position.lerpVectors(fromPos, targetPos, t);
      controls.target.lerpVectors(fromTarget, lookAt, t);
      camera.up.lerpVectors(fromUp, up, t).normalize();
      controls.update();

      if (raw < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        camera.position.copy(targetPos);
        controls.target.copy(lookAt);
        camera.up.copy(up);
        controls.update();
        controls.enabled = true;
      }
    };
    raf = requestAnimationFrame(tick);
  }

  // ─── Animated transition to view normal to a workplane ───────────────────
  static animateToWorkplaneNormal(
    camera:     THREE.PerspectiveCamera,
    controls:   OrbitControls,
    wp:         Workplane,
    durationMs  = 550,
  ): () => void {
    // ── Snap shot of current state ──────────────────────────────────────────
    const savedPos    = camera.position.clone();
    const savedTarget = controls.target.clone();
    const savedUp     = camera.up.clone();

    // ── Target state ────────────────────────────────────────────────────────
    const n          = new THREE.Vector3(...wp.normal).normalize();
    const origin     = new THREE.Vector3(...wp.origin);
    const targetUp   = CADCameraService.computeCameraUp(wp);

    // Distance: keep a comfortable working distance (at least 40, respect current)
    const currentDist = camera.position.distanceTo(controls.target);
    const dist        = Math.max(50, currentDist);

    const targetPos    = origin.clone().addScaledVector(n, dist);
    const targetLookAt = origin.clone();

    // ── Animate ─────────────────────────────────────────────────────────────
    controls.enabled = false; // disable user interaction during flight

    let rafId: number;
    const startTime = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startTime;
      const raw = Math.min(elapsed / durationMs, 1);
      const t   = 1 - Math.pow(1 - raw, 3); // cubic ease-out

      camera.position.lerpVectors(savedPos, targetPos, t);
      controls.target.lerpVectors(savedTarget, targetLookAt, t);
      camera.up.lerpVectors(savedUp, targetUp, t).normalize();
      controls.update();

      if (raw < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        // Commit exact final values
        camera.position.copy(targetPos);
        controls.target.copy(targetLookAt);
        camera.up.copy(targetUp);
        controls.update();
        controls.enabled = true;
      }
    };

    rafId = requestAnimationFrame(tick);

    // ── Return a restore function ────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(rafId); // cancel any in-progress forward animation

      const restoreStart    = performance.now();
      const restoreFrom     = camera.position.clone();
      const restoreFromTgt  = controls.target.clone();
      const restoreFromUp   = camera.up.clone();

      controls.enabled = false;

      let rafRestore: number;
      const restoreTick = () => {
        const elapsed = performance.now() - restoreStart;
        const raw = Math.min(elapsed / durationMs, 1);
        const t   = 1 - Math.pow(1 - raw, 3);

        camera.position.lerpVectors(restoreFrom, savedPos, t);
        controls.target.lerpVectors(restoreFromTgt, savedTarget, t);
        camera.up.lerpVectors(restoreFromUp, savedUp, t).normalize();
        controls.update();

        if (raw < 1) {
          rafRestore = requestAnimationFrame(restoreTick);
        } else {
          camera.position.copy(savedPos);
          controls.target.copy(savedTarget);
          camera.up.copy(savedUp);
          controls.update();
          controls.enabled = true;
        }
      };

      rafRestore = requestAnimationFrame(restoreTick);
    };
  }
}
