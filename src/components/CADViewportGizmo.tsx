// ============================================================
// ToubkalCAD – CADViewportGizmo.tsx
// Corner axis-orientation gizmo with click-to-snap views.
//
// Uses its own off-screen Three.js renderer on a small canvas so
// it is completely independent from the main viewport render loop.
// The gizmo camera mirrors the main camera quaternion every frame.
// ============================================================

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CADCameraService } from '../services/CADCameraService';
import type { CADCamera } from '../services/CADCameraService';

const PX = 120; // canvas pixel size

// ─── Axis definitions ────────────────────────────────────────────────────────

interface AxisSnap {
  snapDir: THREE.Vector3; // unit vector: camera looks FROM this direction
  snapUp:  THREE.Vector3;
}

interface AxisDef {
  dir:      THREE.Vector3;
  color:    number;
  dimColor: number;
  label:    string;
  posSnap:  AxisSnap;
  negSnap:  AxisSnap;
}

const AXES: AxisDef[] = [
  {
    dir: new THREE.Vector3(1, 0, 0), color: 0xe84040, dimColor: 0x883333, label: 'X',
    posSnap: { snapDir: new THREE.Vector3( 1, 0,  0), snapUp: new THREE.Vector3(0, 1, 0) },
    negSnap: { snapDir: new THREE.Vector3(-1, 0,  0), snapUp: new THREE.Vector3(0, 1, 0) },
  },
  {
    dir: new THREE.Vector3(0, 1, 0), color: 0x40c040, dimColor: 0x336633, label: 'Y',
    posSnap: { snapDir: new THREE.Vector3( 0, 1,  0), snapUp: new THREE.Vector3(0, 0, -1) },
    negSnap: { snapDir: new THREE.Vector3( 0,-1,  0), snapUp: new THREE.Vector3(0, 0,  1) },
  },
  {
    dir: new THREE.Vector3(0, 0, 1), color: 0x4080e0, dimColor: 0x334466, label: 'Z',
    posSnap: { snapDir: new THREE.Vector3( 0, 0,  1), snapUp: new THREE.Vector3(0, 1, 0) },
    negSnap: { snapDir: new THREE.Vector3( 0, 0, -1), snapUp: new THREE.Vector3(0, 1, 0) },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLabel(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const hex = '#' + color.toString(16).padStart(6, '0');
  ctx.fillStyle = hex;
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const mat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c),
    depthTest: false,
    transparent: true,
  });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.56, 0.56, 1);
  s.renderOrder = 10;
  return s;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const CADViewportGizmo: React.FC = () => {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const hoveredRef = useRef<number>(-1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ── Mini renderer ──────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(PX, PX);
    renderer.setClearColor(0x000000, 0);

    // Ortho camera: axes span ±1 world unit, frustum ±1.8 gives breathing room
    const cam = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.01, 30);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));

    // ── Build axis geometry + hit meshes ───────────────────────────────────
    // hitMeshes[0,2,4] = positive X,Y,Z  |  hitMeshes[1,3,5] = negative X,Y,Z
    const hitMeshes: THREE.Mesh[] = [];
    const snapData:  AxisSnap[]   = [];

    for (const ax of AXES) {
      // Positive arrow
      const arrow = new THREE.ArrowHelper(
        ax.dir, new THREE.Vector3(0, 0, 0), 0.76, ax.color, 0.28, 0.17,
      );
      arrow.line.renderOrder  = 5;
      arrow.cone.renderOrder  = 5;
      (arrow.line.material as THREE.Material).depthTest = false;
      (arrow.cone.material as THREE.Material).depthTest = false;
      scene.add(arrow);

      // Label
      const lbl = makeLabel(ax.label, ax.color);
      lbl.position.copy(ax.dir).multiplyScalar(1.12);
      scene.add(lbl);

      // Negative stub (tiny head so it looks like a blunt end)
      const negArrow = new THREE.ArrowHelper(
        ax.dir.clone().negate(), new THREE.Vector3(0, 0, 0), 0.38, ax.dimColor, 0.001, 0.001,
      );
      negArrow.line.renderOrder  = 5;
      negArrow.cone.renderOrder  = 5;
      (negArrow.line.material as THREE.Material).depthTest = false;
      (negArrow.cone.material as THREE.Material).depthTest = false;
      scene.add(negArrow);

      // Positive hit sphere (at label position)
      const posHit = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 8, 8),
        new THREE.MeshBasicMaterial({ color: ax.color, transparent: true, opacity: 0, depthTest: false }),
      );
      posHit.position.copy(ax.dir).multiplyScalar(1.12);
      posHit.renderOrder = 11;
      scene.add(posHit);
      hitMeshes.push(posHit);
      snapData.push(ax.posSnap);

      // Negative hit sphere
      const negHit = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 8, 8),
        new THREE.MeshBasicMaterial({ color: ax.dimColor, transparent: true, opacity: 0, depthTest: false }),
      );
      negHit.position.copy(ax.dir.clone().negate()).multiplyScalar(0.5);
      negHit.renderOrder = 11;
      scene.add(negHit);
      hitMeshes.push(negHit);
      snapData.push(ax.negSnap);
    }

    // ── Interaction ────────────────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();

    const getNDC = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / PX) * 2 - 1,
        -((e.clientY - rect.top) / PX) * 2 + 1,
      );
    };

    const onMouseMove = (e: MouseEvent) => {
      raycaster.setFromCamera(getNDC(e), cam);
      const hits = raycaster.intersectObjects(hitMeshes, false);
      const prev = hoveredRef.current;
      hoveredRef.current = hits.length > 0 ? hitMeshes.indexOf(hits[0].object as THREE.Mesh) : -1;

      if (hoveredRef.current !== prev) {
        canvas.style.cursor = hoveredRef.current >= 0 ? 'pointer' : 'default';
        hitMeshes.forEach((m, i) => {
          (m.material as THREE.MeshBasicMaterial).opacity = i === hoveredRef.current ? 0.28 : 0;
        });
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const idx = hoveredRef.current;
      if (idx < 0) return;
      e.stopPropagation();

      // Axis snaps are standard orthographic views — switch projection first,
      // THEN read the now-active (ortho) camera so we animate the right one.
      window.dispatchEvent(new CustomEvent('cad-set-projection', { detail: 'ORTHO' }));

      const mainCam  = window.cadCamera  as CADCamera | null;
      const mainCtrl = window.cadControls as any;
      if (!mainCam || !mainCtrl) return;

      const { snapDir, snapUp } = snapData[idx];
      const target = mainCtrl.target as THREE.Vector3;
      const dist   = Math.max(mainCam.position.distanceTo(target), 30);
      const pos    = target.clone().addScaledVector(snapDir, dist);

      CADCameraService.animateToPose(mainCam, mainCtrl, pos, target.clone(), snapUp.clone());
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);

    // ── Render loop ────────────────────────────────────────────────────────
    let rafId: number;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const mainCam = window.cadCamera as THREE.Camera | null;
      if (mainCam) {
        // Mirror the main camera's orientation
        cam.quaternion.copy(mainCam.quaternion);
        // Position gizmo cam 10 units "behind" (along its own +Z = camera's "from" direction)
        cam.position.set(0, 0, 10).applyQuaternion(mainCam.quaternion);
      }
      renderer.render(scene, cam);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      renderer.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={PX}
      height={PX}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: PX,
        height: PX,
        zIndex: 10,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(20,30,50,0.50) 55%, rgba(20,30,50,0.15) 80%, transparent 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
      }}
    />
  );
};
