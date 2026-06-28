// ============================================================
// Headless test for REGION-PRECISE picked extrusion
// (OccExtrusionService.extrudeSelectedRegions). A circle inside a rectangle has
// two minimal regions — the ring (between) and the inner disk. Picking each by
// its outer-wire id must extrude exactly that area; picking both → both solids.
//   ring  → (rect − disk) × H
//   disk  → disk × H
//   both  → rect × H   (ring solid + disk solid, adjacent → full footprint)
// Also asserts classifyAllRegions surfaces BOTH regions with correct depths.
// ============================================================
import initOpenCascade from 'opencascade.js/dist/node.js';
import { WasmScope } from '../src/utils/WasmScope';
import { classifyAllRegions } from '../src/services/ProfileNesting';
import { OccExtrusionService } from '../src/services/OccExtrusionService';

const oc: any = await initOpenCascade();
const PI = Math.PI, H = 20;
let passed = 0, failed = 0;
function check(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) <= 0.1 + 1e-3 * Math.abs(want);
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}  (${got.toFixed(2)})`); }
  else    { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m got ${got.toFixed(2)} want ${want.toFixed(2)}`); }
}

function rectWire(w: number, h: number) {
  const poly = new oc.BRepBuilderAPI_MakePolygon_1();
  for (const [x, y] of [[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]]) { const p = new oc.gp_Pnt_3(x,y,0); poly.Add_1(p); p.delete(); }
  poly.Close(); const wire = poly.Wire(); poly.delete(); return wire;
}
function circleWire(r: number) {
  const c = new oc.gp_Pnt_3(0,0,0), d = new oc.gp_Dir_4(0,0,1), ax = new oc.gp_Ax2_3(c,d), cir = new oc.gp_Circ_2(ax,r);
  const e = new oc.BRepBuilderAPI_MakeEdge_8(cir).Edge(); const w = new oc.BRepBuilderAPI_MakeWire_2(e).Wire();
  c.delete(); d.delete(); ax.delete(); cir.delete(); return w;
}
function vol(solid: any): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(solid, props, true, false, false);
  const v = props.Mass(); props.delete(); return v;
}

const rect = rectWire(100, 80), circ = circleWire(25);
const wires = [rect, circ];
const wireIds = ['RECT', 'CIRC'];
const rectArea = 100*80, diskArea = PI*25*25;

console.log('\nclassifyAllRegions surfaces ring + disk:');
{
  const s = new WasmScope();
  try {
    const regions = classifyAllRegions(oc, wires, s);
    check('region count = 2', regions.length, 2);
    const ring = regions.find((r) => r.outerIndex === 0);  // rect outer
    const disk = regions.find((r) => r.outerIndex === 1);  // circle outer
    check('ring depth even (0)', (ring?.depth ?? -1) % 2, 0);
    check('disk depth odd (1)', (disk?.depth ?? -1) % 2, 1);
  } finally { s.free(); }
}

const opts = { height: H, direction: [0,0,1] as [number,number,number] };

console.log('\nextrudeSelectedRegions picks exactly the chosen area:');
{
  const ring = OccExtrusionService.extrudeSelectedRegions(oc, wires, wireIds, ['RECT'], opts);
  check('ring only  → (rect − disk)×H', vol(ring), (rectArea - diskArea) * H); ring.delete();

  const disk = OccExtrusionService.extrudeSelectedRegions(oc, wires, wireIds, ['CIRC'], opts);
  check('disk only  → disk×H',          vol(disk), diskArea * H); disk.delete();

  const both = OccExtrusionService.extrudeSelectedRegions(oc, wires, wireIds, ['RECT','CIRC'], opts);
  check('both       → rect×H (full)',   vol(both), rectArea * H); both.delete();
}

console.log(`\n${failed === 0 ? '\x1b[32mALL PASS\x1b[0m' : '\x1b[31mFAILURES\x1b[0m'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
