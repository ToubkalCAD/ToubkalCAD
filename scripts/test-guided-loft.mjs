// ============================================================
// ToubkalCAD – scripts/test-guided-loft.mjs
//
// Headless probe: why does BRepOffsetAPI_MakePipeShell reject our guide?
// Reproduces the UI scenario — two circles on parallel planes + a Bezier guide
// bridging a point on each — and tries several spine/contact configurations,
// printing IsReady / GetStatus / IsDone / MakeSolid / volume for each so we can
// pick the combination that actually builds a guided solid.
//
// Run:  node scripts/test-guided-loft.mjs
// ============================================================

import initOpenCascade from 'opencascade.js/dist/node.js';
const oc = await initOpenCascade();

const PI = Math.PI;

function circleWire(radius, z0 = 0) {
  const o = new oc.gp_Pnt_3(0, 0, z0);
  const n = new oc.gp_Dir_4(0, 0, 1);
  const x = new oc.gp_Dir_4(1, 0, 0);
  const ax2 = new oc.gp_Ax2_2(o, n, x);
  const circ = new oc.gp_Circ_2(ax2, radius);
  const mk = new oc.BRepBuilderAPI_MakeEdge_8(circ);
  const edge = mk.Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  wm.Add_1(edge);
  return wm.Wire();
}

/** Bezier wire through poles [{x,y,z}...], mirroring OccGuideCurveService. */
function guideWire(poles) {
  const arr = new oc.TColgp_Array1OfPnt_2(1, poles.length);
  poles.forEach((p, i) => { const gp = new oc.gp_Pnt_3(p.x, p.y, p.z); arr.SetValue(i + 1, gp); });
  const bez = new oc.Geom_BezierCurve_1(arr);
  const h = new oc.Handle_Geom_Curve_2(bez);
  const edge = new oc.BRepBuilderAPI_MakeEdge_24(h).Edge();
  return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
}

/** Straight-line spine wire between two points. */
function lineWire(a, b) {
  const pa = new oc.gp_Pnt_3(a.x, a.y, a.z);
  const pb = new oc.gp_Pnt_3(b.x, b.y, b.z);
  const edge = new oc.BRepBuilderAPI_MakeEdge_3(pa, pb).Edge();
  return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
}

/** Circle on an arbitrary plane: centre c, normal dir n=(nx,ny,nz). */
function circleWireOriented(radius, c, n) {
  const o = new oc.gp_Pnt_3(c.x, c.y, c.z);
  const dir = new oc.gp_Dir_4(n.x, n.y, n.z);
  const ax2 = new oc.gp_Ax2_3(o, dir);           // builds a ref X automatically
  const circ = new oc.gp_Circ_2(ax2, radius);
  const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  wm.Add_1(edge);
  return wm.Wire();
}

function countSolids(shape) {
  let n = 0;
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) { n++; exp.Next(); }
  return n;
}
function volume(shape) {
  try {
    const p = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, p, true, false, false);
    return p.Mass();
  } catch { return NaN; }
}

// Geometry: circle r=10 @ z=0, circle r=6 @ z=20. Edge points at +X.
const R1 = 10, R2 = 6, H = 20;
const e1 = { x: R1, y: 0, z: 0 };       // point on circle1 edge (+X)
const e2 = { x: R2, y: 0, z: H };       // point on circle2 edge (+X)
// Bezier poles: endpoints on the edges, 2 interior handles bowing outward in +X.
const poles = [
  e1,
  { x: R1 + 6, y: 0, z: H / 3 },
  { x: R2 + 6, y: 0, z: (2 * H) / 3 },
  e2,
];

function attempt(label, build) {
  try {
    const r = build();
    console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}: ready=${r.ready} status=${r.status} done=${r.done} solid=${r.solid} vol=${Number.isFinite(r.vol) ? r.vol.toFixed(1) : 'n/a'} solids=${r.solids}`);
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${label}: THREW ${e?.message ?? e}`);
  }
}

function runPipe({ spine, aux, withContact, withCorrection, p1: pp1, p2: pp2 }) {
  const p1 = pp1 ?? circleWire(R1, 0);
  const p2 = pp2 ?? circleWire(R2, H);
  const mps = new oc.BRepOffsetAPI_MakePipeShell(spine);
  if (aux) mps.SetMode_5(aux, true, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
  mps.Add_1(p1, withContact, withCorrection);
  mps.Add_1(p2, withContact, withCorrection);
  const ready = mps.IsReady();
  mps.Build(new oc.Message_ProgressRange_1());
  const status = mps.GetStatus();          // BRepBuilderAPI_PipeError (0 = done)
  const done = mps.IsDone();
  let solid = false;
  if (done) { try { solid = mps.MakeSolid(); } catch { solid = false; } }
  const shape = done ? mps.Shape() : null;
  return { ok: done, ready, status, done, solid, vol: shape ? volume(shape) : NaN, solids: shape ? countSolids(shape) : 0 };
}

console.log('\nGuide as SPINE (current approach):');
attempt('spine=guide, contact=T corr=T (CURRENT)', () => runPipe({ spine: guideWire(poles), withContact: true,  withCorrection: true }));
attempt('spine=guide, contact=F corr=F',           () => runPipe({ spine: guideWire(poles), withContact: false, withCorrection: false }));
attempt('spine=guide, contact=F corr=T',           () => runPipe({ spine: guideWire(poles), withContact: false, withCorrection: true }));
attempt('spine=guide, contact=T corr=F',           () => runPipe({ spine: guideWire(poles), withContact: true,  withCorrection: false }));

console.log('\nCENTER line spine + guide as AUXILIARY rail:');
const centerSpine = () => lineWire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: H });
attempt('spine=center, aux=guide, contact=F corr=T', () => runPipe({ spine: centerSpine(), aux: guideWire(poles), withContact: false, withCorrection: true }));
attempt('spine=center, aux=guide, contact=T corr=T', () => runPipe({ spine: centerSpine(), aux: guideWire(poles), withContact: true,  withCorrection: true }));
attempt('spine=center, aux=guide, contact=F corr=F', () => runPipe({ spine: centerSpine(), aux: guideWire(poles), withContact: false, withCorrection: false }));

console.log('\nSanity — center spine, NO guide (plain pipe):');
attempt('spine=center, no aux, contact=F corr=T', () => runPipe({ spine: centerSpine(), withContact: false, withCorrection: true }));

// ── SKEW case: profiles on NON-PARALLEL planes, like the UI (YZ + Offset) ──────
// circle1 normal +X at origin; circle2 normal +Z at (e2). Edge points adjusted.
console.log('\nSKEW profiles (non-parallel planes, like the UI):');
const sP1 = { x: 0, y: 0, z: 0 }, sN1 = { x: 1, y: 0, z: 0 };   // normal +X (YZ-like)
const sP2 = { x: 8, y: 0, z: 18 }, sN2 = { x: 0, y: 0, z: 1 };  // normal +Z, offset
const sPoles = [
  { x: 0, y: 0, z: R1 },                 // a point on circle1 (YZ plane, +Z edge)
  { x: 3, y: 0, z: R1 + 4 },
  { x: 8 + R2, y: 0, z: 18 - 4 },
  { x: 8 + R2, y: 0, z: 18 },            // a point on circle2 (+X edge)
];
const mkP1 = () => circleWireOriented(R1, sP1, sN1);
const mkP2 = () => circleWireOriented(R2, sP2, sN2);
attempt('SKEW spine=guide, contact=T corr=T (CURRENT)', () => runPipe({ spine: guideWire(sPoles), withContact: true,  withCorrection: true,  p1: mkP1(), p2: mkP2() }));
attempt('SKEW spine=guide, contact=F corr=T',           () => runPipe({ spine: guideWire(sPoles), withContact: false, withCorrection: true,  p1: mkP1(), p2: mkP2() }));
attempt('SKEW spine=guide, contact=F corr=F',           () => runPipe({ spine: guideWire(sPoles), withContact: false, withCorrection: false, p1: mkP1(), p2: mkP2() }));
attempt('SKEW spine=guide, contact=T corr=F',           () => runPipe({ spine: guideWire(sPoles), withContact: true,  withCorrection: false, p1: mkP1(), p2: mkP2() }));

console.log();

// ── POLYLINE profiles (many-edge approximations, as some sketch wires are) ─────
function polyCircleWire(radius, z0, segs = 36) {
  const wm = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * 2 * Math.PI, a1 = ((i + 1) / segs) * 2 * Math.PI;
    const p0 = new oc.gp_Pnt_3(radius * Math.cos(a0), radius * Math.sin(a0), z0);
    const p1 = new oc.gp_Pnt_3(radius * Math.cos(a1), radius * Math.sin(a1), z0);
    wm.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(p0, p1).Edge());
  }
  return wm.Wire();
}
console.log('\nPOLYLINE profiles (36-gon circles) + guide spine:');
attempt('poly spine=guide, contact=T corr=T', () => runPipe({ spine: guideWire(poles), withContact: true,  withCorrection: true,  p1: polyCircleWire(R1,0), p2: polyCircleWire(R2,H) }));
attempt('poly spine=guide, contact=F corr=T', () => runPipe({ spine: guideWire(poles), withContact: false, withCorrection: true,  p1: polyCircleWire(R1,0), p2: polyCircleWire(R2,H) }));
attempt('poly spine=guide, contact=F corr=F', () => runPipe({ spine: guideWire(poles), withContact: false, withCorrection: false, p1: polyCircleWire(R1,0), p2: polyCircleWire(R2,H) }));
attempt('poly MISMATCH analytic→poly, F corr=T', () => runPipe({ spine: guideWire(poles), withContact: false, withCorrection: true, p1: circleWire(R1,0), p2: polyCircleWire(R2,H) }));

// ── TWO Bezier rails (image-7 case): spine=guide1, aux=guide2 ──────────────────
console.log('\nTWO Bezier rails (spine + aux), skew profiles:');
const g1 = sPoles;                                   // rail 1 (+Z edge of circle1 → +X edge of circle2)
const g2 = [                                         // rail 2 (-Z/other side)
  { x: 0, y: 0, z: -R1 },
  { x: 3, y: 0, z: -R1 - 4 },
  { x: 8 - R2, y: 0, z: 18 + 4 },
  { x: 8 - R2, y: 0, z: 18 },
];
for (const [wc, corr] of [[false,true],[true,true],[false,false],[true,false]]) {
  attempt(`2rail contact=${wc?'T':'F'} corr=${corr?'T':'F'}`, () => runPipe({
    spine: guideWire(g1), aux: guideWire(g2), withContact: wc, withCorrection: corr, p1: mkP1(), p2: mkP2() }));
}

// ── ROBUST FIX candidate: straight centre-line spine + guide as CONTACT rail ───
function centroid(wire) {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.LinearProperties(wire, props, false, false);
  const c = props.CentreOfMass();
  return { x: c.X(), y: c.Y(), z: c.Z() };
}
function centerSpineFor(p1, p2) {
  const a = centroid(p1), b = centroid(p2);
  return lineWire(a, b);
}
function runContact(keep, p1f, p2f, guidePoles) {
  const p1 = p1f(), p2 = p2f();
  const spine = centerSpineFor(p1, p2);
  const mps = new oc.BRepOffsetAPI_MakePipeShell(spine);
  mps.SetMode_5(guideWire(guidePoles), true, keep);
  mps.Add_1(p1, false, true);
  mps.Add_1(p2, false, true);
  const ready = mps.IsReady();
  mps.Build(new oc.Message_ProgressRange_1());
  const done = mps.IsDone();
  let solid = false; if (done) { try { solid = mps.MakeSolid(); } catch {} }
  const shape = done ? mps.Shape() : null;
  return { ok: done, ready, status: '-', done, solid, vol: shape ? volume(shape) : NaN, solids: shape ? countSolids(shape) : 0 };
}
console.log('\nCENTRE spine + guide CONTACT rail (skew profiles) — does the guide deform it?');
attempt('center+aux NoContact', () => runContact(oc.BRepFill_TypeOfContact.BRepFill_NoContact,      () => mkP1(), () => mkP2(), sPoles));
attempt('center+aux Contact',   () => runContact(oc.BRepFill_TypeOfContact.BRepFill_Contact,        () => mkP1(), () => mkP2(), sPoles));
attempt('center+aux ContactOnBorder', () => runContact(oc.BRepFill_TypeOfContact.BRepFill_ContactOnBorder, () => mkP1(), () => mkP2(), sPoles));

// ── ROOT-CAUSE PROOF: deleting the Bezier curve corrupts the edge geometry ─────
function guideWireBuggy(polesArr) {
  const arr = new oc.TColgp_Array1OfPnt_2(1, polesArr.length);
  polesArr.forEach((p, i) => { const gp = new oc.gp_Pnt_3(p.x, p.y, p.z); arr.SetValue(i + 1, gp); gp.delete(); });
  const bez = new oc.Geom_BezierCurve_1(arr);
  const h = new oc.Handle_Geom_Curve_2(bez);
  const edge = new oc.BRepBuilderAPI_MakeEdge_24(h).Edge();
  const wire = new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
  arr.delete(); h.delete(); bez.delete();   // ← THE BUG: frees curve the edge needs
  return wire;
}
console.log('\nROOT-CAUSE proof — MakePipeShell with a guide whose curve was deleted:');
attempt('BUGGY guide (curve deleted) as spine', () => runPipe({ spine: guideWireBuggy(poles), withContact: false, withCorrection: true }));
attempt('FIXED guide (curve kept)   as spine', () => runPipe({ spine: guideWire(poles),       withContact: false, withCorrection: true }));

// ── FINAL: centre-spine loft, correction false vs true (which is cleaner?) ─────
function runCenterLoft(corr, p1f, p2f, gp) {
  const p1 = p1f(), p2 = p2f();
  const spine = centerSpineFor(p1, p2);
  const mps = new oc.BRepOffsetAPI_MakePipeShell(spine);
  mps.SetMode_5(guideWire(gp), true, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
  mps.Add_1(p1, false, corr);
  mps.Add_1(p2, false, corr);
  mps.Build(new oc.Message_ProgressRange_1());
  const done = mps.IsDone(); if (done) try { mps.MakeSolid(); } catch {}
  const shape = done ? mps.Shape() : null;
  return { ok: done, ready: mps.IsReady(), status: '-', done, solid: true, vol: shape?volume(shape):NaN, solids: shape?countSolids(shape):0 };
}
console.log('\nFINAL centre-spine loft (skew profiles):');
attempt('corr=FALSE (profiles stay on planes)', () => runCenterLoft(false, () => mkP1(), () => mkP2(), sPoles));
attempt('corr=TRUE  (sections reoriented)',     () => runCenterLoft(true,  () => mkP1(), () => mkP2(), sPoles));

// ── RE-CENTERED guide spine: shift the guide's bow onto the centroid path ──────
function deCast(poles, t) {
  let p = poles.map(q => ({ ...q }));
  for (let r = 1; r < poles.length; r++)
    for (let i = 0; i < poles.length - r; i++)
      p[i] = { x:(1-t)*p[i].x+t*p[i+1].x, y:(1-t)*p[i].y+t*p[i+1].y, z:(1-t)*p[i].z+t*p[i+1].z };
  return p[0];
}
const lerp3 = (a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t});
function recenteredSpine(guidePoles, c1, c2) {
  const g0 = guidePoles[0], gN = guidePoles[guidePoles.length-1];
  const rp = guidePoles.map((g,i)=>{ const t=i/(guidePoles.length-1);
    const rim=lerp3(g0,gN,t), cen=lerp3(c1,c2,t);
    return { x:g.x-rim.x+cen.x, y:g.y-rim.y+cen.y, z:g.z-rim.z+cen.z };
  });
  return guideWire(rp);  // cubic Bezier through the re-centred poles
}
function centroidZ(shape){ const p=new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(shape,p,true,false,false); const c=p.CentreOfMass(); return {x:c.X(),y:c.Y(),z:c.Z()}; }
function runRecentered(guidePoles, p1f, p2f) {
  const p1=p1f(), p2=p2f();
  const c1=centroid(p1), c2=centroid(p2);
  const spine=recenteredSpine(guidePoles, c1, c2);
  const mps=new oc.BRepOffsetAPI_MakePipeShell(spine);
  mps.Add_1(p1,false,true); mps.Add_1(p2,false,true);
  mps.Build(new oc.Message_ProgressRange_1());
  const done=mps.IsDone(); if(done) try{mps.MakeSolid();}catch{}
  const shape=done?mps.Shape():null;
  const cm = shape?centroidZ(shape):null;
  return { ok:done, ready:mps.IsReady(), status:'-', done, solid:true, vol:shape?volume(shape):NaN, solids:shape?countSolids(shape):0, cm };
}
console.log('\nRE-CENTERED guide spine (skew profiles) — does the loft FOLLOW the guide?');
const cc1 = centroid(mkP1()), cc2 = centroid(mkP2());
console.log(`  straight midpoint of centroids ≈ (${((cc1.x+cc2.x)/2).toFixed(1)}, ${((cc1.y+cc2.y)/2).toFixed(1)}, ${((cc1.z+cc2.z)/2).toFixed(1)})`);
const r = runRecentered(sPoles, () => mkP1(), () => mkP2());
console.log(`  built=${r.done} vol=${Number.isFinite(r.vol)?r.vol.toFixed(1):'n/a'} solids=${r.solids} centroid=${r.cm?`(${r.cm.x.toFixed(1)}, ${r.cm.y.toFixed(1)}, ${r.cm.z.toFixed(1)})`:'n/a'}`);
console.log(`  guide bows toward +X (poles X up to ${Math.max(...sPoles.map(p=>p.x)).toFixed(1)}) — loft centroid X should be pulled > straight midpoint X`);

// Strong-bow guide: endpoints on the two circles, middle poles pushed far +X.
console.log('\nSTRONG-BOW guide — re-centered spine should clearly pull the loft +X:');
const strongPoles = [ {x:0,y:0,z:R1}, {x:30,y:0,z:R1+3}, {x:30,y:0,z:15}, {x:8+R2,y:0,z:18} ];
const r2s = runRecentered(strongPoles, () => mkP1(), () => mkP2());
console.log(`  straight midpoint X ≈ ${((cc1.x+cc2.x)/2).toFixed(1)};  loft centroid = ${r2s.cm?`(${r2s.cm.x.toFixed(1)}, ${r2s.cm.y.toFixed(1)}, ${r2s.cm.z.toFixed(1)})`:'n/a'}  built=${r2s.done}`);

// ── corr=FALSE on the re-centred bent spine: still follows? cleaner (no twist)? ─
function runRecenteredCorr(guidePoles, p1f, p2f, corr) {
  const p1=p1f(), p2=p2f();
  const c1=centroid(p1), c2=centroid(p2);
  const spine=recenteredSpine(guidePoles, c1, c2);
  const mps=new oc.BRepOffsetAPI_MakePipeShell(spine);
  mps.Add_1(p1,false,corr); mps.Add_1(p2,false,corr);
  mps.Build(new oc.Message_ProgressRange_1());
  const done=mps.IsDone(); if(done) try{mps.MakeSolid();}catch{}
  const shape=done?mps.Shape():null;
  return { done, vol:shape?volume(shape):NaN, cm:shape?centroidZ(shape):null };
}
console.log('\ncorr FALSE vs TRUE on re-centred strong-bow spine (does corr=false still follow?):');
const sp=[ {x:0,y:0,z:R1}, {x:30,y:0,z:R1+3}, {x:30,y:0,z:15}, {x:8+R2,y:0,z:18} ];
for (const corr of [false, true]) {
  const r = runRecenteredCorr(sp, () => mkP1(), () => mkP2(), corr);
  console.log(`  corr=${corr?'TRUE ':'FALSE'} built=${r.done} vol=${Number.isFinite(r.vol)?r.vol.toFixed(1):'n/a'} centroidX=${r.cm?r.cm.x.toFixed(1):'n/a'} (straight≈4.0)`);
}

// ════════════════════════════════════════════════════════════════════════════
// SEAM-ALIGNMENT INVESTIGATION (web advice: misaligned circle seams → twist)
// ════════════════════════════════════════════════════════════════════════════
function norm(v){ const m=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/m,y:v.y/m,z:v.z/m}; }
function cross(a,b){ return {x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x}; }
function dot(a,b){ return a.x*b.x+a.y*b.y+a.z*b.z; }
// circle with EXPLICIT seam reference X (projected from a world refDir onto the plane)
function circleSeam(r, c, n, refDir) {
  n = norm(n);
  let x = { x: refDir.x - n.x*dot(refDir,n), y: refDir.y - n.y*dot(refDir,n), z: refDir.z - n.z*dot(refDir,n) };
  if (Math.hypot(x.x,x.y,x.z) < 1e-6) x = {x:1,y:0,z:0};
  x = norm(x);
  const o=new oc.gp_Pnt_3(c.x,c.y,c.z), nd=new oc.gp_Dir_4(n.x,n.y,n.z), xd=new oc.gp_Dir_4(x.x,x.y,x.z);
  const ax2=new oc.gp_Ax2_2(o,nd,xd);
  const circ=new oc.gp_Circ_2(ax2,r);
  const edge=new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  const wm=new oc.BRepBuilderAPI_MakeWire_1(); wm.Add_1(edge);
  return wm.Wire();
}
// circle with AUTO seam (gp_Ax2_3 — what differs by plane → misaligned)
function circleAuto(r, c, n) {
  n=norm(n);
  const o=new oc.gp_Pnt_3(c.x,c.y,c.z), nd=new oc.gp_Dir_4(n.x,n.y,n.z);
  const ax2=new oc.gp_Ax2_3(o,nd);
  const circ=new oc.gp_Circ_2(ax2,r);
  const edge=new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  const wm=new oc.BRepBuilderAPI_MakeWire_1(); wm.Add_1(edge);
  return wm.Wire();
}
function area(shape){ const p=new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(shape,p,false,false); return p.Mass(); }
function isValid(shape){ try { const a=new oc.BRepCheck_Analyzer(shape,true,false); return a.IsValid_2(); } catch(e){ return 'check-threw'; } }
function pipe(spine, p1, p2, corr){
  const mps=new oc.BRepOffsetAPI_MakePipeShell(spine);
  mps.Add_1(p1,false,corr); mps.Add_1(p2,false,corr);
  mps.Build(new oc.Message_ProgressRange_1());
  if(!mps.IsDone()) return null; try{mps.MakeSolid();}catch{}
  return mps.Shape();
}
function thru(p1,p2){ const t=new oc.BRepOffsetAPI_ThruSections(true,false,1e-6); t.CheckCompatibility(true); t.AddWire(p1); t.AddWire(p2); t.Build(new oc.Message_ProgressRange_1()); return t.IsDone()?t.Shape():null; }

// Two circles on NON-PARALLEL planes (like YZ + Offset). r10 @ origin normal+X, r6 tilted.
const N1={x:1,y:0,z:0}, C1={x:0,y:0,z:0};
const N2={x:1,y:0,z:0.6}, C2={x:14,y:0,z:6};
const straightSpine = () => lineWire(C1, C2);
console.log('\n════ SEAM TWIST: area/validity (twist → larger area or invalid) ════');
// MISALIGNED seams (auto X — what the app does across different planes)
{ const p1=circleAuto(10,C1,N1), p2=circleAuto(6,C2,N2); const s=pipe(straightSpine(),p1,p2,false);
  console.log(`  MakePipeShell, MISALIGNED seams: area=${s?area(s).toFixed(0):'n/a'} valid=${s?isValid(s):'n/a'}`); }
// ALIGNED seams (both seams reference world +Y, projected onto each plane)
{ const p1=circleSeam(10,C1,N1,{x:0,y:1,z:0}), p2=circleSeam(6,C2,N2,{x:0,y:1,z:0}); const s=pipe(straightSpine(),p1,p2,false);
  console.log(`  MakePipeShell, ALIGNED   seams: area=${s?area(s).toFixed(0):'n/a'} valid=${s?isValid(s):'n/a'}`); }
// ThruSections on the MISALIGNED circles (web Fix 3 — does it auto-handle seams?)
{ const p1=circleAuto(10,C1,N1), p2=circleAuto(6,C2,N2); const s=thru(p1,p2);
  console.log(`  ThruSections,  MISALIGNED seams: area=${s?area(s).toFixed(0):'n/a'} valid=${s?isValid(s):'n/a'}`); }

// ── Print the actual SEAM vertex of each circle (web's suggested diagnostic) ────
function firstVertex(wire){
  const exp=new oc.TopExp_Explorer_2(wire, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const v=oc.TopoDS.Vertex_1(exp.Current());
  const p=oc.BRep_Tool.Pnt(v);
  return {x:p.X(),y:p.Y(),z:p.Z()};
}
console.log('\n════ SEAM VERTICES (are the two profiles actually misaligned?) ════');
const pa_auto = circleAuto(10,C1,N1), pb_auto = circleAuto(6,C2,N2);
const pa_seam = circleSeam(10,C1,N1,{x:0,y:1,z:0}), pb_seam = circleSeam(6,C2,N2,{x:0,y:1,z:0});
const fv = v => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
console.log(`  AUTO seam:  circle1 vertex ${fv(firstVertex(pa_auto))}  circle2 vertex ${fv(firstVertex(pb_auto))}`);
console.log(`  ALIGNED:    circle1 vertex ${fv(firstVertex(pa_seam))}  circle2 vertex ${fv(firstVertex(pb_seam))}`);

// ── Validity on the RE-CENTERED BENT spine (the real scenario) ─────────────────
console.log('\n════ BENT spine (re-centered guide) — does misalignment break validity? ════');
const bowPoles=[ {x:0,y:0,z:10}, {x:30,y:0,z:13}, {x:30,y:0,z:0}, {x:14+6,y:0,z:6} ];
function bentSpine(p1,p2){ const c1=centroid(p1),c2=centroid(p2); return recenteredSpine(bowPoles,c1,c2); }
{ const p1=circleAuto(10,C1,N1), p2=circleAuto(6,C2,N2); const s=pipe(bentSpine(p1,p2),p1,p2,false);
  console.log(`  bent, MISALIGNED: built=${!!s} valid=${s?isValid(s):'n/a'} area=${s?area(s).toFixed(0):'n/a'}`); }
{ const p1=circleSeam(10,C1,N1,{x:0,y:1,z:0}), p2=circleSeam(6,C2,N2,{x:0,y:1,z:0}); const s=pipe(bentSpine(p1,p2),p1,p2,false);
  console.log(`  bent, ALIGNED:    built=${!!s} valid=${s?isValid(s):'n/a'} area=${s?area(s).toFixed(0):'n/a'}`); }

// ── Bounding box: are ALIGNED and MISALIGNED actually different shapes? ─────────
function bbox(shape){
  const b=new oc.Bnd_Box_1();
  oc.BRepBndLib.Add(shape,b,false);
  const xmin={current:0},ymin={current:0},zmin={current:0},xmax={current:0},ymax={current:0},zmax={current:0};
  const a=b.Get(xmin,ymin,zmin,xmax,ymax,zmax);
  return `[${b.CornerMin().X().toFixed(1)},${b.CornerMin().Y().toFixed(1)},${b.CornerMin().Z().toFixed(1)} → ${b.CornerMax().X().toFixed(1)},${b.CornerMax().Y().toFixed(1)},${b.CornerMax().Z().toFixed(1)}]`;
}
console.log('\n════ BBOX — aligned vs misaligned same shape? + SHARP bend self-intersection ════');
{ const p1=circleAuto(10,C1,N1), p2=circleAuto(6,C2,N2); const s=pipe(bentSpine(p1,p2),p1,p2,false);
  console.log(`  bent MISALIGNED bbox ${s?bbox(s):'n/a'}`); }
{ const p1=circleSeam(10,C1,N1,{x:0,y:1,z:0}), p2=circleSeam(6,C2,N2,{x:0,y:1,z:0}); const s=pipe(bentSpine(p1,p2),p1,p2,false);
  console.log(`  bent ALIGNED    bbox ${s?bbox(s):'n/a'}`); }
// SHARP bend — guide bows hard (like the user's big arc) vs profile size r=10
const sharpPoles=[ {x:0,y:0,z:10}, {x:60,y:0,z:20}, {x:60,y:0,z:-5}, {x:20,y:0,z:6} ];
function sharpSpine(p1,p2){ const c1=centroid(p1),c2=centroid(p2); return recenteredSpine(sharpPoles,c1,c2); }
{ const p1=circleAuto(10,C1,N1), p2=circleAuto(6,C2,N2); const s=pipe(sharpSpine(p1,p2),p1,p2,false);
  console.log(`  SHARP bend: built=${!!s} valid=${s?isValid(s):'n/a'} area=${s?area(s).toFixed(0):'n/a'}`); }

// ── OCC-native anti-twist spine frame modes (cheaper than rebuilding seams) ────
function pipeMode(spine,p1,p2,setup){
  const mps=new oc.BRepOffsetAPI_MakePipeShell(spine);
  setup(mps);
  mps.Add_1(p1,false,false); mps.Add_1(p2,false,false);
  mps.Build(new oc.Message_ProgressRange_1());
  if(!mps.IsDone()) return null; try{mps.MakeSolid();}catch{}
  return mps.Shape();
}
console.log('\n════ ANTI-TWIST spine frame modes (bent spine, MISALIGNED seams) ════');
const P1=()=>circleAuto(10,C1,N1), P2=()=>circleAuto(6,C2,N2);
{ const p1=P1(),p2=P2(); const s=pipeMode(bentSpine(p1,p2),p1,p2,()=>{}); console.log(`  default frame:       bbox ${s?bbox(s):'n/a'} valid=${s?isValid(s):'n/a'}`); }
{ const p1=P1(),p2=P2(); const s=pipeMode(bentSpine(p1,p2),p1,p2,(m)=>m.SetMode_1(false)); console.log(`  CorrectedFrenet:     bbox ${s?bbox(s):'n/a'} valid=${s?isValid(s):'n/a'}`); }
{ const p1=P1(),p2=P2(); const s=pipeMode(bentSpine(p1,p2),p1,p2,(m)=>{ const ax=new oc.gp_Ax2_3(new oc.gp_Pnt_3(0,0,0), new oc.gp_Dir_4(0,0,1)); m.SetMode_2(ax); }); console.log(`  fixed binormal +Z:   bbox ${s?bbox(s):'n/a'} valid=${s?isValid(s):'n/a'}`); }

// ── Verify circle detection + seam rebuild produces aligned seams ──────────────
function detectCircle(wire){
  let edge=null,count=0;
  const exp=new oc.TopExp_Explorer_2(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while(exp.More()){ if(count===0) edge=oc.TopoDS.Edge_1(exp.Current()); count++; exp.Next(); }
  if(count!==1) return null;
  const ad=new oc.BRepAdaptor_Curve_2(edge);
  if(ad.GetType()!==oc.GeomAbs_CurveType.GeomAbs_Circle) return null;
  const c=ad.Circle(); const loc=c.Location(), ax=c.Axis().Direction();
  return { center:{x:loc.X(),y:loc.Y(),z:loc.Z()}, normal:{x:ax.X(),y:ax.Y(),z:ax.Z()}, radius:c.Radius() };
}
console.log('\n════ VERIFY seam-detect + rebuild (does it align the misaligned app circles?) ════');
const ap1=circleAuto(10,C1,N1), ap2=circleAuto(6,C2,N2);
const d1=detectCircle(ap1), d2=detectCircle(ap2);
console.log(`  detected circle1: ${d1?`r=${d1.radius} n=(${d1.normal.x.toFixed(2)},${d1.normal.y.toFixed(2)},${d1.normal.z.toFixed(2)})`:'NOT a circle'}`);
console.log(`  detected circle2: ${d2?`r=${d2.radius} n=(${d2.normal.x.toFixed(2)},${d2.normal.y.toFixed(2)},${d2.normal.z.toFixed(2)})`:'NOT a circle'}`);
// rebuild aligned and compare seam vertices to confirm they now point same way
if(d1&&d2){
  const ref={x:0,y:1,z:0};
  const r1=circleSeam(d1.radius,d1.center,d1.normal,ref), r2=circleSeam(d2.radius,d2.center,d2.normal,ref);
  console.log(`  rebuilt seam1 ${fv(firstVertex(r1))}  seam2 ${fv(firstVertex(r2))} (both should lean +Y → aligned)`);
}

// ════════════════════════════════════════════════════════════════════════════
// THRUSECTIONS ROUTE: intermediate circular sections ON the re-centred guide,
// blended by ThruSections (auto seam-align → no twist) + guide-following.
// ════════════════════════════════════════════════════════════════════════════
function recenterPoles(guidePoles, c1, c2){
  const g0=guidePoles[0], gN=guidePoles[guidePoles.length-1];
  return guidePoles.map((g,i)=>{ const t=i/(guidePoles.length-1); const rim=lerp3(g0,gN,t), cen=lerp3(c1,c2,t);
    return { x:g.x-rim.x+cen.x, y:g.y-rim.y+cen.y, z:g.z-rim.z+cen.z }; });
}
function thruN(wires){ const t=new oc.BRepOffsetAPI_ThruSections(true,false,1e-6); t.CheckCompatibility(true); for(const w of wires) t.AddWire(w); t.Build(new oc.Message_ProgressRange_1()); return t.IsDone()?t.Shape():null; }
function guidedThru(guidePoles, c1,c2,r1,r2,n1,n2, ref, N){
  const rp = recenterPoles(guidePoles, c1, c2);
  const wires=[];
  for(let i=0;i<=N;i++){ const t=i/N;
    const center = deCast(rp, t);
    const radius = r1+(r2-r1)*t;
    const normal = norm(lerp3(n1,n2,t));
    wires.push(circleSeam(radius, center, normal, ref));
  }
  return thruN(wires);
}
console.log('\n════ THRUSECTIONS guided loft (strong-bow guide, skew circles) ════');
const Tc1={x:0,y:0,z:0}, Tn1={x:1,y:0,z:0}, Tr1=10;
const Tc2={x:14,y:0,z:6}, Tn2=norm({x:1,y:0,z:0.6}), Tr2=6;
const Tg=[ {x:0,y:0,z:10}, {x:30,y:0,z:13}, {x:30,y:0,z:0}, {x:14+6,y:0,z:6} ];   // strong bow +X
const ref={x:0,y:1,z:0};
for(const N of [4,8]){
  const s=guidedThru(Tg, Tc1,Tc2,Tr1,Tr2,Tn1,Tn2, ref, N);
  const cm=s?centroidZ(s):null;
  console.log(`  N=${N}: built=${!!s} valid=${s?isValid(s):'n/a'} centroidX=${cm?cm.x.toFixed(1):'n/a'} (straight midX=7.0) area=${s?area(s).toFixed(0):'n/a'}`);
}
// baseline: plain ThruSections (no guide) for comparison
{ const s=thruN([circleSeam(Tr1,Tc1,Tn1,ref), circleSeam(Tr2,Tc2,Tn2,ref)]); const cm=s?centroidZ(s):null;
  console.log(`  PLAIN (no guide): centroidX=${cm?cm.x.toFixed(1):'n/a'} (guide should pull X above this)`); }

function guidedThruRuled(guidePoles, c1,c2,r1,r2,n1,n2, ref, N, ruled){
  const rp = recenterPoles(guidePoles, c1, c2);
  const wires=[];
  for(let i=0;i<=N;i++){ const t=i/N; wires.push(circleSeam(r1+(r2-r1)*t, deCast(rp,t), norm(lerp3(n1,n2,t)), ref)); }
  const tt=new oc.BRepOffsetAPI_ThruSections(true, ruled, 1e-6); tt.CheckCompatibility(true);
  for(const w of wires) tt.AddWire(w); tt.Build(new oc.Message_ProgressRange_1());
  return tt.IsDone()?tt.Shape():null;
}
console.log('\n════ STABILITY sweep: N × ruled (find clean defaults) ════');
for(const ruled of [false, true]){
  for(const N of [2,3,4,5,6,8,12]){
    const s=guidedThruRuled(Tg, Tc1,Tc2,Tr1,Tr2,Tn1,Tn2, ref, N, ruled);
    const cm=s?centroidZ(s):null; const ar=s?area(s):NaN;
    const sane = Number.isFinite(ar) && ar < 20000;
    console.log(`  ruled=${ruled?'T':'F'} N=${String(N).padStart(2)}: built=${!!s} valid=${s?isValid(s):'n/a'} cX=${cm?cm.x.toFixed(1).padStart(6):'   n/a'} area=${Number.isFinite(ar)?ar.toFixed(0):'n/a'} ${sane?'':'⚠️BLOWUP'}`);
  }
}
