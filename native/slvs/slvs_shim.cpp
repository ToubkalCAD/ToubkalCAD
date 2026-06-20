// ============================================================
// ToubkalCAD – slvs_shim.cpp
//
// Embind C++ shim over SolveSpace's libslvs (slvs.h) geometric constraint
// solver. Exposes ONE clean class — SketchSystem — to JavaScript so all the
// Slvs_System / Slvs_Param / Slvs_Entity / Slvs_Constraint struct + array
// marshalling stays here in C++ and never leaks into TypeScript.
//
// Design contract (matches src/services/solver/wasm/libslvs.d.ts):
//   - A single canonical workplane (XY plane through the origin, identity
//     orientation) is created FIXED in the constructor. ToubkalCAD already works
//     in workplane-local (u,v); the real 3D placement is irrelevant to a 2D
//     solve, so one canonical plane suffices and (u,v) params map straight onto
//     EntityGeom's local coords.
//   - Group 1 (GROUP_FIXED)  = reference geometry (workplane, datums, FIXED ents).
//   - Group 2 (GROUP_ACTIVE) = free geometry that Slvs_Solve(.,2) moves.
//   - `fixed` flag on each add* call routes the entity's params to group 1 or 2.
//   - Drag = setDragged(pu,pv): the solver keeps those params near their seeded
//     value (native minimal-move). Replaces the legacy soft-anchor.
//
// Build: native/slvs/build.sh  (Emscripten + the libslvs sources).
// ============================================================

#include <slvs.h>
#include <emscripten/bind.h>
#include <vector>
#include <unordered_map>
#include <cstring>
#include <cstdint>

using emscripten::class_;
using emscripten::value_object;

static const Slvs_hGroup GROUP_FIXED  = 1;
static const Slvs_hGroup GROUP_ACTIVE = 2;

// Handle bundle returned to JS for an added entity. p0..p3 carry the entity's
// own param handles (point: p0=u, p1=v; circle: p0=radius, p1=distance-entity,
// p2=center-point) so the adapter can drag/read them without a second lookup.
struct EntityRef {
  uint32_t h  = 0;
  uint32_t p0 = 0;
  uint32_t p1 = 0;
  uint32_t p2 = 0;
  uint32_t p3 = 0;
};

struct SolveOutcome {
  int result = 0;  // SLVS_RESULT_OKAY | INCONSISTENT | DIDNT_CONVERGE | TOO_MANY_UNKNOWNS
  int dof    = -1;
};

class SketchSystem {
public:
  SketchSystem() {
    // Fixed reference frame: origin point + identity normal → canonical workplane.
    uint32_t ox = addParam(GROUP_FIXED, 0), oy = addParam(GROUP_FIXED, 0), oz = addParam(GROUP_FIXED, 0);
    uint32_t origin = pushEntity(Slvs_MakePoint3d(nextEntity(), GROUP_FIXED, ox, oy, oz));

    uint32_t qw = addParam(GROUP_FIXED, 1), qx = addParam(GROUP_FIXED, 0),
             qy = addParam(GROUP_FIXED, 0), qz = addParam(GROUP_FIXED, 0);
    normal_ = pushEntity(Slvs_MakeNormal3d(nextEntity(), GROUP_FIXED, qw, qx, qy, qz));

    wrkpl_ = pushEntity(Slvs_MakeWorkplane(nextEntity(), GROUP_FIXED, origin, normal_));
    std::memset(dragged_, 0, sizeof(dragged_));
  }

  uint32_t workplane() const { return wrkpl_; }

  // ── geometry ──────────────────────────────────────────────────────────────
  EntityRef addPoint2d(double u, double v, bool fixed) {
    Slvs_hGroup g = grp(fixed);
    uint32_t pu = addParam(g, u), pv = addParam(g, v);
    uint32_t h  = pushEntity(Slvs_MakePoint2d(nextEntity(), g, wrkpl_, pu, pv));
    return { h, pu, pv, 0, 0 };
  }

  EntityRef addLine(uint32_t ptA, uint32_t ptB, bool fixed) {
    uint32_t h = pushEntity(Slvs_MakeLineSegment(nextEntity(), grp(fixed), wrkpl_, ptA, ptB));
    return { h, 0, 0, 0, 0 };
  }

  // Circle from an existing centre point + a radius value. Internally a DISTANCE
  // entity holds the radius param (libslvs models circle radius as a distance).
  EntityRef addCircle(uint32_t centerPt, double radius, bool fixed) {
    Slvs_hGroup g = grp(fixed);
    uint32_t rp   = addParam(g, radius);
    uint32_t dist = pushEntity(Slvs_MakeDistance(nextEntity(), g, wrkpl_, rp));
    uint32_t h    = pushEntity(Slvs_MakeCircle(nextEntity(), g, wrkpl_, centerPt, normal_, dist));
    return { h, rp, dist, centerPt, 0 };
  }

  EntityRef addArc(uint32_t centerPt, uint32_t startPt, uint32_t endPt, bool fixed) {
    uint32_t h = pushEntity(
      Slvs_MakeArcOfCircle(nextEntity(), grp(fixed), wrkpl_, normal_, centerPt, startPt, endPt));
    return { h, 0, 0, 0, 0 };
  }

  // ── constraints ─────────────────────────────────────────────────────────────
  // Generic passthrough. The adapter fills the fields each SLVS_C_* type needs
  // and leaves the rest 0. Constraints live in the active group (2).
  uint32_t addConstraint(int type, double valA,
                         uint32_t ptA, uint32_t ptB,
                         uint32_t entityA, uint32_t entityB,
                         uint32_t entityC, uint32_t entityD,
                         int other, int other2) {
    uint32_t h = ++constraintCtr_;
    Slvs_Constraint c =
      Slvs_MakeConstraint(h, GROUP_ACTIVE, type, wrkpl_, valA, ptA, ptB, entityA, entityB);
    c.entityC = entityC;
    c.entityD = entityD;
    c.other   = other;
    c.other2  = other2;
    constraints_.push_back(c);
    return h;
  }

  // ── drag ──────────────────────────────────────────────────────────────────
  void setDragged(uint32_t pu, uint32_t pv) {
    dragged_[0] = pu; dragged_[1] = pv; dragged_[2] = 0; dragged_[3] = 0;
  }
  void clearDragged() { std::memset(dragged_, 0, sizeof(dragged_)); }

  // ── solve / readback ────────────────────────────────────────────────────────
  SolveOutcome solve(int activeGroup) {
    Slvs_System sys;
    std::memset(&sys, 0, sizeof(sys));
    sys.param       = params_.data();       sys.params      = (int)params_.size();
    sys.entity      = entities_.data();     sys.entities    = (int)entities_.size();
    sys.constraint  = constraints_.data();  sys.constraints = (int)constraints_.size();
    for (int i = 0; i < 4; i++) sys.dragged[i] = dragged_[i];

    faileds_.assign(constraints_.size(), 0);
    sys.calculateFaileds = 1;
    sys.failed  = faileds_.data();
    sys.faileds = (int)faileds_.size();

    // Slvs_Solve writes solved values back into sys.param (== params_.data()).
    Slvs_Solve(&sys, (Slvs_hGroup)activeGroup);
    return { sys.result, sys.dof };
  }

  double getParamValue(uint32_t h) const {
    auto it = paramIndex_.find(h);
    return it == paramIndex_.end() ? 0.0 : params_[it->second].val;
  }

private:
  Slvs_hGroup grp(bool fixed) const { return fixed ? GROUP_FIXED : GROUP_ACTIVE; }
  uint32_t nextEntity() { return ++entityCtr_; }

  uint32_t addParam(Slvs_hGroup g, double val) {
    uint32_t h = ++paramCtr_;
    params_.push_back(Slvs_MakeParam(h, g, val));
    paramIndex_[h] = params_.size() - 1;
    return h;
  }
  uint32_t pushEntity(Slvs_Entity e) { entities_.push_back(e); return e.h; }

  std::vector<Slvs_Param>      params_;
  std::vector<Slvs_Entity>     entities_;
  std::vector<Slvs_Constraint> constraints_;
  std::vector<Slvs_hConstraint> faileds_;
  std::unordered_map<uint32_t, size_t> paramIndex_;

  Slvs_hParam dragged_[4];
  Slvs_hEntity wrkpl_  = 0;
  Slvs_hEntity normal_ = 0;
  uint32_t paramCtr_      = 0;
  uint32_t entityCtr_     = 0;
  uint32_t constraintCtr_ = 0;
};

EMSCRIPTEN_BINDINGS(slvs_shim) {
  value_object<EntityRef>("EntityRef")
    .field("h",  &EntityRef::h)
    .field("p0", &EntityRef::p0)
    .field("p1", &EntityRef::p1)
    .field("p2", &EntityRef::p2)
    .field("p3", &EntityRef::p3);

  value_object<SolveOutcome>("SolveOutcome")
    .field("result", &SolveOutcome::result)
    .field("dof",    &SolveOutcome::dof);

  class_<SketchSystem>("SketchSystem")
    .constructor<>()
    .function("workplane",     &SketchSystem::workplane)
    .function("addPoint2d",    &SketchSystem::addPoint2d)
    .function("addLine",       &SketchSystem::addLine)
    .function("addCircle",     &SketchSystem::addCircle)
    .function("addArc",        &SketchSystem::addArc)
    .function("addConstraint", &SketchSystem::addConstraint)
    .function("setDragged",    &SketchSystem::setDragged)
    .function("clearDragged",  &SketchSystem::clearDragged)
    .function("solve",         &SketchSystem::solve)
    .function("getParamValue", &SketchSystem::getParamValue);

  emscripten::constant("SLVS_RESULT_OKAY",            (int)SLVS_RESULT_OKAY);
  emscripten::constant("SLVS_RESULT_INCONSISTENT",    (int)SLVS_RESULT_INCONSISTENT);
  emscripten::constant("SLVS_RESULT_DIDNT_CONVERGE",  (int)SLVS_RESULT_DIDNT_CONVERGE);
  emscripten::constant("SLVS_RESULT_TOO_MANY_UNKNOWNS", (int)SLVS_RESULT_TOO_MANY_UNKNOWNS);
}
