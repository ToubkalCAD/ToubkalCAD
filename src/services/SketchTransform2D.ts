// ============================================================
// ToubkalCAD – SketchTransform2D.ts
//
// In-plane (local u,v) transforms of sketch geometry for the 2D Mirror /
// Linear Array / Circular Array tools. Each transform is an isometry, so radii
// are preserved; only points (and, for arcs, the sweep) change.
//
// A transform is a point map `XF: (u,v) → (u,v)` plus a `reverses` flag that is
// true for reflections (which flip an arc's CCW orientation) and false for
// rotations/translations.
// ============================================================

export type Pt = [number, number];
export type XF = (p: Pt) => Pt;

/** Reflection across the line through `p0` with direction `dir`. */
export function reflector(p0: Pt, dir: Pt): XF {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const dx = dir[0] / len, dy = dir[1] / len;
  return (p) => {
    const wx = p[0] - p0[0], wy = p[1] - p0[1];
    const t = wx * dx + wy * dy;
    const fx = p0[0] + t * dx, fy = p0[1] + t * dy;   // foot of perpendicular
    return [2 * fx - p[0], 2 * fy - p[1]];
  };
}

/** Rotation about `center` by `ang` radians (CCW). */
export function rotator(center: Pt, ang: number): XF {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  return (p) => {
    const x = p[0] - center[0], y = p[1] - center[1];
    return [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos];
  };
}

/** Translation by (du, dv). */
export function translator(du: number, dv: number): XF {
  return (p) => [p[0] + du, p[1] + dv];
}

/** Apply an isometry to a sketchGeom, returning a new geom of the same kind. */
export function transformGeom(geom: any, f: XF, reverses: boolean): any {
  switch (geom?.kind) {
    case 'line':
      return { kind: 'line', a: f(geom.a), b: f(geom.b) };
    case 'circle':
      return { kind: 'circle', c: f(geom.c), r: geom.r };
    case 'polyline':
      return { kind: 'polyline', pts: geom.pts.map((p: Pt) => f(p)) };
    case 'arc': {
      const { c, r, a1, a2 } = geom;
      const start: Pt = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
      const end:   Pt = [c[0] + r * Math.cos(a2), c[1] + r * Math.sin(a2)];
      const c2 = f(c), s2 = f(start), e2 = f(end);
      const span = a2 - a1;                          // preserved magnitude
      // A reflection reverses CCW orientation, so the new arc starts at the
      // image of the OLD end; rotations/translations keep the old start.
      const startPt = reverses ? e2 : s2;
      const na1 = Math.atan2(startPt[1] - c2[1], startPt[0] - c2[0]);
      return { kind: 'arc', c: c2, r, a1: na1, a2: na1 + span };
    }
    default:
      return null;
  }
}
