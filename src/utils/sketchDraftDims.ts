// ============================================================
// ToubkalCAD – sketchDraftDims.ts
//
// Single source of truth for the LIVE sketch dimensions shown while a 2D tool is
// dragging. Pure 2D (workplane-local) geometry — no THREE, no React — so both
// consumers stay consistent:
//   • useCADSketchTool builds THREE.Line draft geometry from `dim`/`witness`/
//     `arrows` (Fusion-style dimension line + extension lines + arrowheads),
//   • SketchDimensionInput places one editable HTML <input> per dimension at its
//     `labelLocal`, and calls `resolve()` to turn the typed/live values back into
//     the local-2D point the tool consumes.
//
// Each tool/step yields zero or more independent dimensions (rectangle → W and H,
// circle → Ø, line → length, ellipse → major then minor). First points and
// arc-3P/bezier/spline have no driving dimension → null (click-only).
// ============================================================

export type Pt = { x: number; y: number };
export type Seg = [Pt, Pt];

export interface SketchDim {
  key:        string;   // unique within the set: 'L','D','Maj','Min','W','H','CR'
  label:      string;   // shown next to the input ('Ø','R','W',…)
  value:      number;   // live (cursor-measured) display value
  disp:       number;   // display = measuredDistance × disp (circle Ø = 2× radius)
  labelLocal: Pt;       // where the editable value sits
  dim:        Seg[];    // solid dimension line(s)
  witness:    Seg[];    // thin extension lines
  arrows:     Seg[];    // arrowhead wings (solid)
}

export interface SketchDimSet {
  dims:    SketchDim[];
  /** Build the local-2D point the tool needs from each dim's value + cursor dir. */
  resolve: (vals: Record<string, number>, priors: Pt[], cursor: Pt) => Pt;
}

// ── vector helpers ──────────────────────────────────────────────────────────────
const sub  = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add  = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul  = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const len  = (a: Pt) => Math.hypot(a.x, a.y);
const mid  = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const norm = (a: Pt): Pt => { const L = len(a); return L < 1e-6 ? { x: 1, y: 0 } : { x: a.x / L, y: a.y / L }; };
const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });
const dirOf = (a: Pt, b: Pt): Pt => norm(sub(b, a));
const at   = (o: Pt, d: Pt, L: number): Pt => add(o, mul(d, L));
const sgn  = (x: number) => (x < 0 ? -1 : 1);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Two arrowhead wing segments at `tip`, opening back along −`into`. */
function arrow(tip: Pt, into: Pt, size: number): Seg[] {
  const back = mul(into, -1);
  const rot = (v: Pt, a: number): Pt => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
  return [
    [tip, add(tip, mul(rot(back, 0.42), size))],
    [tip, add(tip, mul(rot(back, -0.42), size))],
  ];
}

/** A linear dimension between two local points, offset perpendicular by `off`. */
function linearDim(key: string, label: string, a: Pt, b: Pt, off: number, value: number, disp = 1): SketchDim {
  const d  = dirOf(a, b);
  const pp = perp(d);
  const A  = add(a, mul(pp, off));
  const B  = add(b, mul(pp, off));
  const ar = clamp(len(sub(b, a)) * 0.06, 1, 4);
  const ext = Math.sign(off) * Math.abs(off) + Math.sign(off) * ar; // witness reaches a touch past the dim line
  return {
    key, label, value, disp,
    labelLocal: mid(A, B),
    dim:     [[A, B]],
    witness: [[a, add(a, mul(pp, ext))], [b, add(b, mul(pp, ext))]],
    arrows:  [...arrow(A, d, ar), ...arrow(B, mul(d, -1), ar)],
  };
}

/** A radial dimension from `c` to a rim point at distance `r` along `d`. */
function radialDim(key: string, label: string, c: Pt, d: Pt, r: number, disp = 1): SketchDim {
  const rim = at(c, d, r);
  const ar  = clamp(r * 0.06, 1, 4);
  return {
    key, label, value: r, disp,
    labelLocal: at(c, d, r * (disp === 2 ? 0.65 : 0.5)),  // along the line, toward the rim
    dim:     disp === 2 ? [[at(c, d, -r), rim]] : [[c, rim]],   // diameter spans both sides
    witness: [],
    arrows:  disp === 2
      ? [...arrow(at(c, d, -r), mul(d, -1), ar), ...arrow(rim, d, ar)]
      : [...arrow(rim, d, ar)],
  };
}

// ── per-tool dimension sets ──────────────────────────────────────────────────────

export function buildSketchDims(mode: string, step: number, priors: Pt[], cursor: Pt): SketchDimSet | null {
  const p0 = priors[0];
  if (!p0) return null;

  switch (mode) {
    case 'SKETCH_LINE': {
      if (step !== 1) return null;
      const d = dirOf(p0, cursor), L = len(sub(cursor, p0));
      const off = clamp(L * 0.14, 3, 18);
      return {
        dims: [linearDim('L', 'L', p0, cursor, off, L)],
        resolve: (v) => at(p0, d, v.L),
      };
    }
    case 'SKETCH_CIRCLE': {
      if (step !== 1) return null;
      const d = dirOf(p0, cursor), r = len(sub(cursor, p0));
      return {
        dims: [radialDim('D', 'Ø', p0, d, r, 2)],   // diameter, Fusion-style
        resolve: (v) => at(p0, d, v.D / 2),
      };
    }
    case 'SKETCH_POLYGON':
    case 'SKETCH_ARC': {
      if (step !== 1) return null;
      const d = dirOf(p0, cursor), r = len(sub(cursor, p0));
      return {
        dims: [radialDim('R', 'R', p0, d, r)],
        resolve: (v) => at(p0, d, v.R),
      };
    }
    case 'SKETCH_ELLIPSE': {
      if (step === 1) {
        const d = dirOf(p0, cursor), r = len(sub(cursor, p0));
        return { dims: [radialDim('Maj', 'Maj', p0, d, r)], resolve: (v) => at(p0, d, v.Maj) };
      }
      if (step === 2) {
        const d = dirOf(p0, cursor), r = len(sub(cursor, p0));
        const minor = radialDim('Min', 'Min', p0, d, r);
        return { dims: [minor], resolve: (v) => at(p0, d, v.Min) };
      }
      return null;
    }
    case 'SKETCH_RECTANGLE':
    case 'SKETCH_ROUNDED_RECT': {
      if (mode === 'SKETCH_ROUNDED_RECT' && step === 2) {
        const d = dirOf(p0, cursor), r = len(sub(cursor, p0));
        return { dims: [radialDim('CR', 'CR', p0, d, r)], resolve: (v) => at(p0, d, v.CR) };
      }
      if (step !== 1) return null;
      const sx = sgn(cursor.x - p0.x), sy = sgn(cursor.y - p0.y);
      const W = Math.abs(cursor.x - p0.x), H = Math.abs(cursor.y - p0.y);
      const minX = Math.min(p0.x, cursor.x), maxX = Math.max(p0.x, cursor.x);
      const minY = Math.min(p0.y, cursor.y), maxY = Math.max(p0.y, cursor.y);
      const offW = clamp(W * 0.12, 3, 14), offH = clamp(H * 0.12, 3, 14);
      // width along the top edge (offset up), height along the left edge (offset left)
      const width  = linearDim('W', 'W', { x: minX, y: maxY }, { x: maxX, y: maxY }, offW, W);
      const height = linearDim('H', 'H', { x: minX, y: minY }, { x: minX, y: maxY }, offH, H);
      return {
        dims: [width, height],
        resolve: (v) => ({ x: p0.x + sx * v.W, y: p0.y + sy * v.H }),
      };
    }
    default:
      return null;   // arc-3P / bezier / spline → click-only
  }
}
