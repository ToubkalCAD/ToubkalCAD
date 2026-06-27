// ============================================================
// ToubkalCAD – InfiniteGrid.ts
//
// A Fusion-360-style infinite grid, drawn entirely on the GPU. Used twice:
//   • the model-mode ground grid (default XZ frame), and
//   • the sketch-mode workplane grid (oriented to the active plane frame).
//
// How it works:
//   • One camera-following plane (recentred under the camera's projection onto
//     the grid plane each frame, in the vertex shader) so it always surrounds the
//     viewer — no finite square plate.
//   • Adaptive decades: the minor cell snaps 1 → 10 → 100 … as you zoom out, with
//     a smooth cross-fade between levels, so 1 mm lines never blur into grey.
//   • A soft radial fade that dissolves the lines into the background near the
//     horizon — masking the actual geometry edge (looks infinite).
//   • Optional origin axes baked into the shader (U red, V blue) + an optional
//     normal axis line (e.g. ground +Y green).
//
// Grid coordinates are computed in the plane's (u,v) frame, so lines stay locked
// to the plane origin even though the mesh follows the camera. WebGL2 only (three
// r170), so dFdx/fwidth are available without an extension.
// ============================================================

import * as THREE from 'three';

export interface GridFrame {
  origin: THREE.Vector3;   // plane origin (world)
  u:      THREE.Vector3;   // in-plane axis → "U red" origin axis
  v:      THREE.Vector3;   // in-plane axis → "V blue" origin axis
  normal: THREE.Vector3;   // plane normal → optional axis line
}

export interface GridOptions {
  dark:            boolean;
  size?:           number;     // plane half-extent (world units); keep < camera.far
  frame?:          GridFrame;  // defaults to the XZ ground plane
  showAxes?:       boolean;    // bake the U/V origin axes (default true)
  showNormalAxis?: boolean;    // draw a line along the normal (default = showAxes)
}

export interface InfiniteGridHandle {
  group: THREE.Group;
  /** Call once per rendered frame with the live camera + its orbit-target distance. */
  update: (camera: THREE.Camera, focusDistance: number) => void;
  setTheme: (dark: boolean) => void;
  dispose: () => void;
}

// Thin, low-contrast lines — the professional-CAD look. Minor lines are barely
// there (they're a measurement aid, not decoration); major lines a touch stronger.
// Earlier they were too dark/opaque, which read as a dense saturated mesh.
const PALETTE = {
  light: { thin: 0xdfe4ea, thick: 0xc4ccd6, minorOp: 0.30, majorOp: 0.55 },
  dark:  { thin: 0x262b33, thick: 0x333a44, minorOp: 0.35, majorOp: 0.60 },
};
// Origin axes — clear but slightly desaturated, matching the viewcube triad.
const AXIS = { u: 0xd6504e /* red */, v: 0x3f7fd0 /* blue */, n: 0x5aa84b /* green */ };

const GROUND: GridFrame = {
  origin: new THREE.Vector3(0, 0, 0),
  u:      new THREE.Vector3(1, 0, 0),
  v:      new THREE.Vector3(0, 0, 1),
  normal: new THREE.Vector3(0, 1, 0),
};

const VERT = /* glsl */`
  uniform float uSize;
  uniform vec2  uCamUV;       // camera projected into the plane's (u,v) frame
  uniform vec3  uOrigin;
  uniform vec3  uU;
  uniform vec3  uV;
  varying vec2  vLocal;       // in-plane coords relative to the plane origin
  void main() {
    // position is a PlaneGeometry(2,2) attribute, xy in [-1,1]. Scale to the plane
    // half-extent and recentre under the camera, then lift back into world space
    // along the frame's axes. (model matrix is identity — world is baked here.)
    vec2 local = position.xy * uSize + uCamUV;
    vec3 world = uOrigin + uU * local.x + uV * local.y;
    vLocal = local;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vLocal;
  uniform vec2  uCamUV;
  uniform vec3  uThinColor;
  uniform vec3  uThickColor;
  uniform vec3  uAxisUColor;
  uniform vec3  uAxisVColor;
  uniform float uCellSize;     // base minor cell in world units (1 = 1 mm)
  uniform float uMinPixels;    // keep on-screen cells ≥ this many pixels
  uniform float uMinorOpacity;
  uniform float uMajorOpacity;
  uniform float uFadeDist;     // radius (world units) at which the grid fully fades
  uniform float uOpacity;
  uniform float uShowAxes;

  float log10(float x) { return log(x) * 0.4342944819; }

  // Anti-aliased coverage [0,1] of the grid lines for a given cell size.
  float gridLine(vec2 uv, float cell, float widthPx) {
    vec2 g = abs(fract(uv / cell - 0.5) - 0.5);   // triangle wave: 0 ON a line
    vec2 d = fwidth(uv / cell);                    // cells per pixel
    vec2 a = vec2(1.0) - smoothstep(vec2(0.0), d * widthPx, g);
    return max(a.x, a.y);
  }

  // Anti-aliased coverage of a single axis line at coord == 0.
  float axisLine(float coord, float widthPx) {
    float d = fwidth(coord);
    return 1.0 - smoothstep(0.0, d * widthPx, abs(coord));
  }

  void main() {
    vec2 uv = vLocal;

    // Pick the decade so the minor cell stays ≥ uMinPixels on screen.
    float upp   = max(fwidth(uv.x), fwidth(uv.y));    // world units per pixel
    float level = max(0.0, log10(upp * uMinPixels / uCellSize));
    float f     = fract(level);
    float lod0  = uCellSize * pow(10.0, floor(level));  // minor
    float lod1  = lod0 * 10.0;                           // major

    float minorA = gridLine(uv, lod0, 1.0) * (1.0 - f) * uMinorOpacity;  // fades across decades
    float majorA = gridLine(uv, lod1, 1.1) * uMajorOpacity;

    vec3  col   = uThinColor;
    float alpha = minorA;
    col   = mix(col, uThickColor, majorA);
    alpha = max(alpha, majorA);

    // Origin axes (baked in so they fade with the grid): U where v==0, V where u==0.
    if (uShowAxes > 0.5) {
      float aU = axisLine(uv.y, 1.7);   // U axis (red), runs where v == 0
      float aV = axisLine(uv.x, 1.7);   // V axis (blue), runs where u == 0
      col   = mix(col, uAxisUColor, aU);
      alpha = max(alpha, aU);
      col   = mix(col, uAxisVColor, aV);
      alpha = max(alpha, aV);
    }

    // Soft radial fade → dissolves into the background near the horizon.
    float dist = length(uv - uCamUV);
    float fade = 1.0 - smoothstep(uFadeDist * 0.25, uFadeDist, dist);
    alpha *= fade * uOpacity;

    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export function createInfiniteGrid(opts: GridOptions): InfiniteGridHandle {
  const size = opts.size ?? 8000;
  const frame = opts.frame ?? GROUND;
  const showAxes = opts.showAxes ?? true;
  const showNormal = opts.showNormalAxis ?? showAxes;
  const pal = opts.dark ? PALETTE.dark : PALETTE.light;

  const origin = frame.origin.clone();
  const u = frame.u.clone().normalize();
  const v = frame.v.clone().normalize();
  const n = frame.normal.clone().normalize();

  const uniforms = {
    uCamUV:        { value: new THREE.Vector2() },
    uOrigin:       { value: origin },
    uU:            { value: u },
    uV:            { value: v },
    uThinColor:    { value: new THREE.Color(pal.thin) },
    uThickColor:   { value: new THREE.Color(pal.thick) },
    uAxisUColor:   { value: new THREE.Color(AXIS.u) },
    uAxisVColor:   { value: new THREE.Color(AXIS.v) },
    uCellSize:     { value: 1.0 },    // 1 unit == 1 mm minor grid
    uMinPixels:    { value: 3.2 },   // larger → switch decade sooner → fewer, calmer lines
    uMinorOpacity: { value: pal.minorOp },
    uMajorOpacity: { value: pal.majorOp },
    uSize:         { value: size },
    uFadeDist:     { value: size * 0.55 },
    uOpacity:      { value: 1.0 },
    uShowAxes:     { value: showAxes ? 1 : 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,         // ground/sketch plane: don't occlude / z-fight with models
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;            // it follows the camera; never cull it
  mesh.renderOrder = -1;                 // draw before solids
  mesh.userData.isWorkplaneHelper = true;
  mesh.raycast = () => {};               // never selectable / pickable

  const group = new THREE.Group();
  group.userData.isWorkplaneHelper = true;
  group.add(mesh);

  // Optional axis line along the plane normal (e.g. the ground +Y, green).
  let normalGeo: THREE.BufferGeometry | null = null;
  let normalMat: THREE.LineBasicMaterial | null = null;
  if (showNormal) {
    const len = 140;
    normalGeo = new THREE.BufferGeometry().setFromPoints([
      origin.clone().addScaledVector(n, -len * 0.25),
      origin.clone().addScaledVector(n, len),
    ]);
    normalMat = new THREE.LineBasicMaterial({ color: AXIS.n, transparent: true, opacity: 0.85, depthWrite: false });
    const nAxis = new THREE.Line(normalGeo, normalMat);
    nAxis.renderOrder = -1;
    nAxis.raycast = () => {};
    group.add(nAxis);
  }

  const camPos = new THREE.Vector3();
  const rel = new THREE.Vector3();
  return {
    group,
    update(camera, focusDistance) {
      camera.getWorldPosition(camPos);
      rel.copy(camPos).sub(origin);
      uniforms.uCamUV.value.set(rel.dot(u), rel.dot(v));   // camera projected into the frame
      // Horizon fade tracks zoom: always dissolve a few "focus distances" out, so
      // the grid reads the same whether zoomed in or out. Capped to the plane.
      uniforms.uFadeDist.value = THREE.MathUtils.clamp(focusDistance * 5, 200, size * 0.85);
    },
    setTheme(d) {
      const p = d ? PALETTE.dark : PALETTE.light;
      uniforms.uThinColor.value.set(p.thin);
      uniforms.uThickColor.value.set(p.thick);
      uniforms.uMinorOpacity.value = p.minorOp;
      uniforms.uMajorOpacity.value = p.majorOp;
    },
    dispose() {
      mesh.geometry.dispose(); material.dispose();
      normalGeo?.dispose(); normalMat?.dispose();
    },
  };
}
