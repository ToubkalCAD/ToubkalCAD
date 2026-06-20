// ============================================================
// ToubkalCAD – slvsConstants.ts
//
// The SLVS_C_* constraint-type ints from SolveSpace's slvs.h, plus the solve
// group convention used by slvs_shim.cpp. The future SolveSpaceSolverAdapter
// maps each ToubkalCAD SketchConstraintType to one (or a pair) of these.
//
// These values are a stable part of the libslvs ABI (base 100000). Kept here so
// the adapter never hard-codes magic numbers. Result codes come from the loaded
// module (SlvsModule.SLVS_RESULT_*), not from here, since those are exported by
// the build.
// ============================================================

export const SLVS_GROUP_FIXED  = 1;
export const SLVS_GROUP_ACTIVE = 2;

export const SlvsC = {
  POINTS_COINCIDENT:  100000,
  PT_PT_DISTANCE:     100001,
  PT_PLANE_DISTANCE:  100002,
  PT_LINE_DISTANCE:   100003,
  PT_FACE_DISTANCE:   100004,
  PT_IN_PLANE:        100005,
  PT_ON_LINE:         100006,
  PT_ON_FACE:         100007,
  EQUAL_LENGTH_LINES: 100008,
  LENGTH_RATIO:       100009,
  EQ_LEN_PT_LINE_D:   100010,
  EQ_PT_LN_DISTANCES: 100011,
  EQUAL_ANGLE:        100012,
  EQUAL_LINE_ARC_LEN: 100013,
  SYMMETRIC:          100014,
  SYMMETRIC_HORIZ:    100015,
  SYMMETRIC_VERT:     100016,
  SYMMETRIC_LINE:     100017,
  AT_MIDPOINT:        100018,
  HORIZONTAL:         100019,
  VERTICAL:           100020,
  DIAMETER:           100021,
  PT_ON_CIRCLE:       100022,
  SAME_ORIENTATION:   100023,
  ANGLE:              100024,
  PARALLEL:           100025,
  PERPENDICULAR:      100026,
  ARC_LINE_TANGENT:   100027,
  CUBIC_LINE_TANGENT: 100028,
  EQUAL_RADIUS:       100029,
  PROJ_PT_DISTANCE:   100030,
  WHERE_DRAGGED:      100031,
  CURVE_CURVE_TANGENT:100032,
  LENGTH_DIFFERENCE:  100033,
} as const;

export type SlvsConstraintType = typeof SlvsC[keyof typeof SlvsC];
