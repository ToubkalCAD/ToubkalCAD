// ============================================================
// ToubkalCAD – CADViewCube.tsx
// Orientation cube — light theme face colours.
// Face order matches THREE.BoxGeometry: +X -X +Y -Y +Z -Z
// ============================================================

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CADViewPreset } from '../services/CADCameraService';

interface CADViewCubeProps {
  mainCamera:   THREE.PerspectiveCamera | null;
  mainControls: OrbitControls | null;
}

// Face order MUST match BoxGeometry: +X(R) -X(L) +Y(T) -Y(B) +Z(Fr) -Z(Bk)
const FACES: Array<{ label: string; view: CADViewPreset; bg: string; fg: string }> = [
  { label: 'RIGHT', view: 'RIGHT',       bg: '#ddeeff', fg: '#1a4a7a' },
  { label: 'LEFT',  view: 'PERSPECTIVE', bg: '#eef4ff', fg: '#2a5a8a' },
  { label: 'TOP',   view: 'TOP',         bg: '#e0f5e8', fg: '#1a5a30' },
  { label: 'BOT',   view: 'PERSPECTIVE', bg: '#f5f5f5', fg: '#4a5568' },
  { label: 'FRONT', view: 'FRONT',       bg: '#ffeae8', fg: '#7a2020' },
  { label: 'BACK',  view: 'PERSPECTIVE', bg: '#f5eeff', fg: '#4a2a7a' },
];

function makeFaceTex(label: string, bg: string, fg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 128, 128);

  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 124, 124);

  ctx.fillStyle = fg;
  ctx.font = 'bold 18px -apple-system, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 64, 64);

  return new THREE.CanvasTexture(canvas);
}

export const CADViewCube: React.FC<CADViewCubeProps> = ({ mainCamera, mainControls }) => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const mount = mountRef.current;
    const SIZE = 84;

    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 3.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(SIZE, SIZE);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    const materials = FACES.map((f) =>
      new THREE.MeshBasicMaterial({ map: makeFaceTex(f.label, f.bg, f.fg) })
    );
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), materials);
    scene.add(cube);
    scene.add(new THREE.AmbientLight(0xffffff, 1));

    const raycaster = new THREE.Raycaster();
    const onClick = (e: MouseEvent) => {
      if (!mainCamera || !mainControls) return;
      const rect = mount.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / SIZE) * 2 - 1,
          -((e.clientY - rect.top) / SIZE) * 2 + 1,
        ),
        camera,
      );
      const hits = raycaster.intersectObject(cube);
      if (hits.length > 0) {
        const slot = Math.floor((hits[0].faceIndex ?? 0) / 2);
        // Go through the shared bus so Viewport3D picks the right projection
        // (orthographic for axis views) — same path as the menu/view bar.
        window.dispatchEvent(new CustomEvent('cad-view-preset', { detail: FACES[slot].view }));
      }
    };
    mount.addEventListener('click', onClick);

    let rafId: number;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      if (mainCamera) {
        const dir = new THREE.Vector3();
        mainCamera.getWorldDirection(dir);
        cube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir.negate());
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      mount.removeEventListener('click', onClick);
      materials.forEach((m) => { m.map?.dispose(); m.dispose(); });
      cube.geometry.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount)
        mount.removeChild(renderer.domElement);
    };
  }, [mainCamera, mainControls]);

  return (
    <div
      ref={mountRef}
      title="Click a face to change view"
      style={{
        position: 'absolute', top: '8px', left: '8px',
        width: '84px', height: '84px',
        cursor: 'pointer',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
        zIndex: 10,
        boxShadow: 'var(--shadow-sm)',
      }}
    />
  );
};
