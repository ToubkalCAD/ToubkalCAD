// ============================================================
// ToubkalCAD – Icon.tsx
//
// Phase 9 – a single, cohesive line-icon set (24×24, 1.6 stroke,
// currentColor) replacing the ad-hoc Unicode glyphs across the UI.
// Crisp, geometric, Fusion/Tabler-flavoured. Dependency-free.
//
//   <Icon name="extrude" size={16} />
// ============================================================

import React from 'react';

export type IconName =
  // primitives
  | 'box' | 'cylinder' | 'sphere' | 'torus' | 'cone'
  // modify / boolean
  | 'fillet' | 'chamfer' | 'union' | 'subtract' | 'intersect'
  // sketch
  | 'line' | 'circle' | 'rectangle' | 'arc' | 'arc3p' | 'ellipse'
  | 'bezier' | 'spline' | 'polygon' | 'roundrect' | 'constraint'
  // 3d ops
  | 'extrude' | 'revolve' | 'loft' | 'sweep'
  // transforms
  | 'mirror' | 'array' | 'circarray' | 'mate' | 'align' | 'concentric'
  // sketch editing
  | 'trim' | 'extend' | 'split' | 'powertrim' | 'region'
  // tools / chrome
  | 'select' | 'measure' | 'import' | 'export' | 'undo' | 'redo'
  | 'plane' | 'check' | 'sun' | 'moon' | 'sketch' | 'grid' | 'close';

const P: Record<IconName, React.ReactNode> = {
  box: (<><path d="M12 2.6l8.5 4.6v9.6L12 21.4 3.5 16.8V7.2z" /><path d="M3.7 7.3L12 11.9l8.3-4.6" /><path d="M12 11.9v9.4" /></>),
  cylinder: (<><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12M19 6v12" /><path d="M5 18a7 3 0 0 0 14 0" /></>),
  sphere: (<><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="9" ry="3.4" /><path d="M12 3v18" /></>),
  torus: (<><ellipse cx="12" cy="12" rx="9.2" ry="5.4" /><ellipse cx="12" cy="12" rx="3.6" ry="1.7" /></>),
  cone: (<><path d="M12 3.5L20 18.5H4z" /><ellipse cx="12" cy="18.5" rx="8" ry="2.6" /></>),
  fillet: (<><path d="M5 5v4a10 10 0 0 0 10 10h4" /><path d="M5 5h2M5 5v2" opacity=".45" /><path d="M19 19h-2M19 19v-2" opacity=".45" /></>),
  chamfer: (<><path d="M5 5v6l8 8h6" /><path d="M5 5h2M5 5v2" opacity=".45" /><path d="M19 19h-2M19 19v-2" opacity=".45" /></>),
  union: (<><path d="M9 8.2A4.8 4.8 0 1 0 15.8 15 4.8 4.8 0 1 0 9 8.2z" /></>),
  subtract: (<><circle cx="10" cy="12" r="5.4" /><circle cx="15.5" cy="12" r="5.4" strokeDasharray="2.4 2.4" /></>),
  intersect: (<><circle cx="9.6" cy="12" r="5.2" opacity=".5" /><circle cx="14.4" cy="12" r="5.2" opacity=".5" /><path d="M12 7.7a5.2 5.2 0 0 1 0 8.6 5.2 5.2 0 0 1 0-8.6z" /></>),
  line: (<><path d="M5 19L19 5" /><circle cx="5" cy="19" r="1.7" /><circle cx="19" cy="5" r="1.7" /></>),
  circle: (<circle cx="12" cy="12" r="8" />),
  rectangle: (<rect x="4" y="6.5" width="16" height="11" rx="1" />),
  arc: (<><path d="M4 17a8 8 0 0 1 16 0" /><circle cx="4" cy="17" r="1.5" /><circle cx="20" cy="17" r="1.5" /></>),
  arc3p: (<><path d="M4 16a9 9 0 0 1 16 0" /><circle cx="4" cy="16" r="1.5" /><circle cx="12" cy="7.4" r="1.5" /><circle cx="20" cy="16" r="1.5" /></>),
  ellipse: (<ellipse cx="12" cy="12" rx="9" ry="6" />),
  bezier: (<><path d="M3 18C7 5 17 5 21 18" /><rect x="1.7" y="16.7" width="2.6" height="2.6" rx=".5" /><rect x="19.7" y="16.7" width="2.6" height="2.6" rx=".5" /></>),
  spline: (<path d="M3 14c3-7 6 7 9 0s6-7 9 0" />),
  polygon: (<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />),
  roundrect: (<rect x="4" y="6" width="16" height="12" rx="4" />),
  constraint: (<><path d="M6 4v14h14" /><path d="M6 14h4v4" opacity=".5" /><circle cx="18" cy="6" r="2.2" /></>),
  extrude: (<><rect x="5.5" y="11" width="13" height="9.5" rx="1" /><path d="M12 8.5V2.5M9 5.3L12 2.5l3 2.8" /></>),
  revolve: (<><path d="M5.5 8a8 8 0 1 1-1.2 6" /><path d="M4 8.5L5.5 8 6 9.6" /><path d="M12 2.5v19" strokeDasharray="2.5 2.5" opacity=".5" /></>),
  loft: (<><ellipse cx="12" cy="5.5" rx="6" ry="2" /><ellipse cx="12" cy="18.5" rx="8" ry="2.3" /><path d="M6 5.5L4 18.5M18 5.5l2 13" /></>),
  sweep: (<><circle cx="6" cy="7" r="2.6" /><path d="M6 9.6C6 16 12 14 14 18" /><path d="M11.6 17.4l2.4.6.6-2.4" /></>),
  mirror: (<><path d="M12 3.5v17" strokeDasharray="2.4 2.4" opacity=".5" /><path d="M8.5 7l-4 5 4 5z" /><path d="M15.5 7l4 5-4 5z" opacity=".5" /></>),
  array: (<><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" opacity=".5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" opacity=".5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" opacity=".5" /></>),
  circarray: (<><circle cx="12" cy="12" r="8" strokeDasharray="2.4 2.4" opacity=".4" /><circle cx="12" cy="4" r="2.1" /><circle cx="20" cy="12" r="1.7" opacity=".55" /><circle cx="12" cy="20" r="1.7" opacity=".55" /><circle cx="4" cy="12" r="1.7" opacity=".55" /></>),
  mate: (<><rect x="3" y="7" width="8" height="10" rx="1" /><rect x="13" y="7" width="8" height="10" rx="1" opacity=".4" /><path d="M11 12h2" /><path d="M12 4v3M12 17v3" opacity=".6" /></>),
  align: (<><rect x="3" y="6" width="6" height="12" rx="1" /><rect x="15" y="6" width="6" height="12" rx="1" opacity=".4" /><path d="M9 9h6M9 15h6" opacity=".7" strokeDasharray="2 2" /></>),
  concentric: (<><circle cx="12" cy="12" r="8.5" opacity=".4" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>),
  trim: (<><path d="M14 10L21 3" /><path d="M3 7l7 5-7 5" opacity=".4" strokeDasharray="2.4 2.4" /><circle cx="10.5" cy="11.5" r="2.4" /><path d="M14 14l3 3M17 14l-3 3" opacity=".8" /></>),
  extend: (<><path d="M3 12h11" /><path d="M14 8l5 4-5 4" /><path d="M21 5v14" opacity=".4" strokeDasharray="2.4 2.4" /></>),
  split: (<><path d="M4 12h6" /><path d="M14 12h6" /><circle cx="12" cy="12" r="1.8" /><path d="M12 4v3M12 17v3" opacity=".5" /></>),
  powertrim: (<><path d="M4 18C9 18 8 6 13 6" /><path d="M20 6C15 6 16 18 11 18" opacity=".4" /><path d="M5 13l3 3M8 13l-3 3" opacity=".9" /><path d="M14 8l3 3M17 8l-3 3" opacity=".9" /></>),
  region: (<><path d="M5 8c0-2 2-3 5-3s4 2 7 2 2 8-1 10-5 1-8 0-3-7-3-9z" /><path d="M9 11l2 2 4-4" opacity=".7" /></>),
  select: (<path d="M5 3.2l13.5 6.6-5.7 1.5 3.4 6.1-2.1 1.2-3.4-6.1-3.6 4.4z" />),
  measure: (<><rect x="2.7" y="9" width="18.6" height="6" rx="1" transform="rotate(-45 12 12)" /><path d="M9.4 7.2l1.5 1.5M12.2 10l1.5 1.5M15 12.8l1.5 1.5" opacity=".7" /></>),
  import: (<><path d="M12 3v12M8 11l4 4 4-4" /><path d="M4 17v3.2h16V17" /></>),
  export: (<><path d="M12 15V3M8 7l4-4 4 4" /><path d="M4 17v3.2h16V17" /></>),
  undo: (<><path d="M8 7L3.5 11.5 8 16" /><path d="M3.5 11.5H14a6 6 0 0 1 0 12h-2" /></>),
  redo: (<><path d="M16 7l4.5 4.5L16 16" /><path d="M20.5 11.5H10a6 6 0 0 0 0 12h2" /></>),
  plane: (<><path d="M3 8l12 0 6 8-12 0z" /><path d="M9 8l6 8" opacity=".4" /></>),
  check: (<path d="M5 12.5l4.5 4.5L19 6.5" />),
  sun: (<><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" /></>),
  moon: (<path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5z" />),
  sketch: (<><path d="M4 20l1.2-4L16 5.2a2 2 0 0 1 2.8 2.8L8 18.8z" /><path d="M14.5 6.7l2.8 2.8" /></>),
  grid: (<><rect x="3.5" y="3.5" width="17" height="17" rx="1.5" /><path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17" opacity=".55" /></>),
  close: (<path d="M6 6l12 12M18 6L6 18" />),
};

interface IconProps {
  name:     IconName;
  size?:    number;
  stroke?:  number;
  color?:   string;
  style?:   React.CSSProperties;
}

export const Icon: React.FC<IconProps> = ({ name, size = 16, stroke = 1.6, color, style }) => (
  <svg
    width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color ?? 'currentColor'} strokeWidth={stroke}
    strokeLinecap="round" strokeLinejoin="round"
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    {P[name]}
  </svg>
);
