// ============================================================
// ToubkalCAD – renderQuality.ts
//
// Detects a WEAK rendering/compute environment so the app can shed detail
// (coarser tessellation, lighter scene) ONLY where it actually helps. The whole
// point is adaptivity: a modern GPU is classified 'high' and is NEVER degraded —
// every cost-cutting path is gated on `isLowTier()`, which only fires for
// software rasterizers, old/throttled GPUs (e.g. Nouveau on a 2010 Quadro), or
// a machine that sustains a low frame rate.
//
// Detection has two inputs, OR-ed:
//   1. The WebGL UNMASKED_RENDERER string, sampled once (cheap, deterministic).
//   2. Sustained low FPS fed in from the render/status loop (catches GPUs whose
//      name looks fine but that are clocked down / overwhelmed).
// Once 'low' it sticks (we don't want quality flapping mid-session).
//
// Headless (Node tests): there's no `document`/WebGL, detection returns null →
// tier resolves to 'high' → unchanged 0.008 tessellation, so geometry tests are
// unaffected.
// ============================================================

export type RenderTier = 'high' | 'low';

let cached: RenderTier | null = null;
let probed = false;            // WebGL probed at most once (creating contexts is costly)
let rendererStr = '';          // remembered for diagnostics
let lowFpsStreak = 0;

/** Inspect the WebGL renderer string once. Returns a tier, or null if unknown. */
function detectFromRenderer(): RenderTier | null {
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'low';   // no WebGL at all → definitely weak
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    rendererStr = raw;
    const s = raw.trim().toLowerCase();
    if (!s) return null;     // renderer hidden → undecided, let FPS decide

    // Software rasterizers (incl. ANGLE-wrapped, e.g. "ANGLE (... SwiftShader ...)").
    if (/llvmpipe|softpipe|swiftshader|software|mesa offscreen/.test(s)) return 'low';
    // Nouveau reports the chip codename as a token — "ANGLE (Mesa, NVA5, OpenGL 3.3)",
    // "NV117", etc. Match it word-boundaried so it's found inside the ANGLE wrapper
    // (NOT anchored — that was the bug that left old Quadros on the 'high' path).
    // "nvidia"/"rtx"/"geforce …" don't contain an nv+hex token, so no false positives.
    if (/\bnv[0-9a-f]{2,4}\b/.test(s) || /nouveau/.test(s)) return 'low';

    return 'high';           // a named, non-flagged GPU → full quality
  } catch {
    return null;
  }
}

/** Resolve the tier (cached). Defaults to 'high' so nothing is degraded blindly. */
export function getRenderTier(): RenderTier {
  if (!probed) {
    probed = true;            // probe WebGL exactly once, even if the verdict is null
    const r = detectFromRenderer();
    if (r) cached = r;        // null → stays unresolved (defaults high); FPS net may downgrade
  }
  return cached ?? 'high';
}

/** Human-readable tier + renderer string, for one-time startup logging. */
export function describeRenderTier(): string {
  const tier = getRenderTier();
  return `${tier}${rendererStr ? ` — ${rendererStr}` : ''}`;
}

export function isLowTier(): boolean {
  return getRenderTier() === 'low';
}

/**
 * Feed the live frame rate (call ~once/second). Sustained low FPS downgrades the
 * tier to 'low' even when the renderer string looked fine — the adaptive safety
 * net. Never upgrades (a fast machine momentarily stuttering won't flip to low
 * from one reading; it needs a sustained streak, and once low it stays low).
 */
export function reportFps(fps: number): void {
  if (cached === 'low') return;
  if (fps > 0 && fps < 18) {
    if (++lowFpsStreak >= 4) cached = 'low';   // ~4 s of <18 fps → weak machine
  } else {
    lowFpsStreak = 0;
  }
}

/**
 * Size-relative chord-tolerance floor for tessellation. Low tier gets a coarser
 * mesh (fewer triangles → faster build + faster software/throttled render);
 * high tier is unchanged from the historical 0.008 (~0.8 % chord error).
 */
export function tessRelTol(): number {
  return isLowTier() ? 0.02 : 0.008;
}
