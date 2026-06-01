// ============================================================
// ToubkalCAD – CADToolbar.tsx
// All parameter prompts use ParameterModal (no browser dialogs).
// ============================================================

import React from 'react';
import { useCADStore, DEFAULT_MATERIAL, NODE_TYPE_COLORS, InteractionMode } from '../store/cadStore';
import { showParamModal }           from './ParameterModal';
import { OccPrimitivesService }     from '../services/OccPrimitivesService';
import { OccBooleanService }        from '../services/OccBooleanService';
import { OccExtrusionService }      from '../services/OccExtrusionService';
import { OccExchangeService }       from '../services/OccExchangeService';
import { OccFilletService }         from '../services/OccFilletService';
import { OccRevolutionService }     from '../services/OccRevolutionService';
import { OccLoftService }           from '../services/OccLoftService';
import { OccSweepService }          from '../services/OccSweepService';
import { CADGeometryRegistry }      from '../services/CADGeometryRegistry';

declare global { interface Window { oc: any; } }

// ─── Button + separator sub-components ───────────────────────────────────────

const Sep = () => (
  <div style={{ width: '1px', height: '24px', background: 'var(--border)', margin: '0 2px', flexShrink: 0 }} />
);

const Grp: React.FC<{ label: string }> = ({ label }) => (
  <span style={{
    fontSize: '8px', color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.7px',
    userSelect: 'none', flexShrink: 0,
  }}>
    {label}
  </span>
);

const Btn: React.FC<{
  icon: string; label: string; onClick: () => void;
  isActive?: boolean; disabled?: boolean; accent?: string;
}> = ({ icon, label, onClick, isActive, disabled, accent = 'var(--accent)' }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={label}
    style={{
      background: isActive ? accent : 'var(--surface-3)',
      color:      disabled ? 'var(--text-muted)' : isActive ? '#fff' : 'var(--text-primary)',
      border:     isActive ? `1px solid ${accent}` : '1px solid var(--border)',
      padding:    '3px 8px',
      borderRadius: 'var(--radius-sm)',
      cursor:     disabled ? 'not-allowed' : 'pointer',
      fontSize:   '11px',
      display:    'flex', alignItems: 'center', gap: '4px',
      flexShrink: 0, whiteSpace: 'nowrap',
      transition: 'all 0.1s',
      opacity:    disabled ? 0.5 : 1,
    }}
    onMouseEnter={(e) => {
      if (!disabled && !isActive)
        (e.currentTarget as HTMLElement).style.background = 'var(--surface-4)';
    }}
    onMouseLeave={(e) => {
      if (!isActive)
        (e.currentTarget as HTMLElement).style.background = 'var(--surface-3)';
    }}
  >
    <span style={{ fontSize: '12px' }}>{icon}</span>
    <span>{label}</span>
  </button>
);

// ─── Toolbar ──────────────────────────────────────────────────────────────────

export const CADToolbar: React.FC = () => {
  const mode            = useCADStore((s) => s.interactionMode);
  const selIds          = useCADStore((s) => s.selectedIds);
  const nodes           = useCADStore((s) => s.nodes);
  const past            = useCADStore((s) => s.past);
  const future          = useCADStore((s) => s.future);
  const polygonSides    = useCADStore((s) => s.sketchPolygonSides);
  const activeWorkplane = useCADStore((s) => s.activeWorkplane);
  const openPlaneSel    = useCADStore((s) => s.openPlaneSelector);
  const setMode         = useCADStore((s) => s.setInteractionMode);
  const addNode         = useCADStore((s) => s.addNode);
  const setProc         = useCADStore((s) => s.setProcessing);
  const log             = useCADStore((s) => s.log);

  // Open the plane selector then activate the sketch mode
  const startSketch = (sketchMode: InteractionMode) => openPlaneSel(sketchMode);

  const reg = CADGeometryRegistry.getInstance();

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const create = (id: string, name: string, type: any, shape: any) => {
    reg.registerShape(id, shape);
    addNode({
      id, name, type, visible: true, locked: false, parentId: null, notes: '',
      transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
      material:  { ...DEFAULT_MATERIAL, color: NODE_TYPE_COLORS[type as keyof typeof NODE_TYPE_COLORS] ?? 0x5588cc },
    });
    window.dispatchEvent(new CustomEvent('cad-add-mesh', { detail: { id } }));
    log(`${name} created.`, 'success');
  };

  const withOC = (fn: () => Promise<void> | void) => {
    if (!window.oc) { log('OCC kernel not initialized.', 'error'); return; }
    Promise.resolve().then(fn).catch((e: any) => {
      log(e.message, 'error');
    });
  };

  // ─── Primitives ────────────────────────────────────────────────────────────
  const mkBox = () => withOC(async () => {
    const v = await showParamModal('Create Box', [
      { key: 'w', label: 'Width X',  default: 10, min: 0.01, unit: 'mm' },
      { key: 'h', label: 'Height Y', default: 10, min: 0.01, unit: 'mm' },
      { key: 'd', label: 'Depth Z',  default: 10, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Box ${v.w}×${v.h}×${v.d}`, 'box',
      OccPrimitivesService.createBox(window.oc, v.w, v.h, v.d));
  });

  const mkCyl = () => withOC(async () => {
    const v = await showParamModal('Create Cylinder', [
      { key: 'r', label: 'Radius', default: 5,  min: 0.01, unit: 'mm' },
      { key: 'h', label: 'Height', default: 15, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Cylinder r${v.r}h${v.h}`, 'cylinder',
      OccPrimitivesService.createCylinder(window.oc, v.r, v.h));
  });

  const mkSph = () => withOC(async () => {
    const v = await showParamModal('Create Sphere', [
      { key: 'r', label: 'Radius', default: 7, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Sphere r${v.r}`, 'sphere',
      OccPrimitivesService.createSphere(window.oc, v.r));
  });

  const mkTorus = () => withOC(async () => {
    const v = await showParamModal('Create Torus', [
      { key: 'R', label: 'Major radius', default: 15, min: 0.01, unit: 'mm' },
      { key: 'r', label: 'Tube radius',  default: 3,  min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Torus R${v.R}r${v.r}`, 'compound',
      OccRevolutionService.createTorus(window.oc, v.R, v.r));
  });

  const mkCone = () => withOC(async () => {
    const v = await showParamModal('Create Cone', [
      { key: 'r1', label: 'Base radius',  default: 8,  min: 0,    unit: 'mm' },
      { key: 'r2', label: 'Top radius',   default: 0,  min: 0,    unit: 'mm' },
      { key: 'h',  label: 'Height',       default: 15, min: 0.01, unit: 'mm' },
    ]);
    if (!v) return;
    create(crypto.randomUUID(), `Cone r${v.r1}/r${v.r2}h${v.h}`, 'compound',
      OccRevolutionService.createCone(window.oc, v.r1, v.r2, v.h));
  });

  // ─── Modifications ─────────────────────────────────────────────────────────
  const mkFillet = () => {
    if (!selIds.length) { log('Select an object first.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Fillet Edges', [
        { key: 'r', label: 'Radius', default: 1, min: 0.001, unit: 'mm' },
      ]);
      if (!v) return;
      const shape = reg.getShape(selIds[0]);
      if (!shape) { log('Shape not found.', 'error'); return; }
      setProc(true, 'Computing fillet…');
      try {
        create(crypto.randomUUID(), `Fillet r${v.r}`, 'compound',
          OccFilletService.filletAllEdges(window.oc, shape, v.r));
      } finally { setProc(false); }
    });
  };

  const mkChamfer = () => {
    if (!selIds.length) { log('Select an object first.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Chamfer Edges', [
        { key: 'd', label: 'Distance', default: 1, min: 0.001, unit: 'mm' },
      ]);
      if (!v) return;
      const shape = reg.getShape(selIds[0]);
      if (!shape) { log('Shape not found.', 'error'); return; }
      setProc(true, 'Computing chamfer…');
      try {
        create(crypto.randomUUID(), `Chamfer ${v.d}mm`, 'compound',
          OccFilletService.chamferAllEdges(window.oc, shape, v.d));
      } finally { setProc(false); }
    });
  };

  // ─── Boolean operations ────────────────────────────────────────────────────
  const boolOp = (op: 'CUT' | 'FUSE' | 'COMMON') => {
    if (selIds.length < 2) { log('Select 2 objects (Ctrl+click).', 'warn'); return; }
    withOC(async () => {
      const sA = reg.getShape(selIds[0]);
      const sB = reg.getShape(selIds[1]);
      if (!sA || !sB) { log('Shapes not found.', 'error'); return; }
      setProc(true, 'Boolean operation…');
      try {
        const NAMES = { CUT: 'Subtract A−B', FUSE: 'Union A+B', COMMON: 'Intersect A∩B' };
        let res: any;
        if (op === 'CUT')    res = OccBooleanService.subtract(window.oc, sA, sB);
        if (op === 'FUSE')   res = OccBooleanService.fuse(window.oc, sA, sB);
        if (op === 'COMMON') res = OccBooleanService.intersect(window.oc, sA, sB);
        create(crypto.randomUUID(), NAMES[op], 'boolean_operation', res);
      } finally { setProc(false); }
    });
  };

  // ─── Extrusion ─────────────────────────────────────────────────────────────
  const extrude = () => {
    if (!selIds.length) { log('Select a sketch (sketch_wire).', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (node?.type !== 'sketch_wire') { log('Selected object must be a 2D sketch.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Extrude', [
        { key: 'h', label: 'Height', default: 20, min: 0.01, unit: 'mm' },
      ]);
      if (!v) return;
      const wire = reg.getShape(selIds[0]);
      if (!wire) { log('Sketch wire not found.', 'error'); return; }
      // Retrieve extrusion direction from the sketch node's workplane
      const wp = node.params?.workplane;
      const direction: [number,number,number] = wp?.normal ?? activeWorkplane.normal;
      setProc(true, 'Extruding…');
      try {
        create(crypto.randomUUID(), `Extrusion ${v.h}mm`, 'extrusion',
          OccExtrusionService.extrudeWire(window.oc, wire, v.h, direction));
      } finally { setProc(false); }
    });
  };

  // ─── Revolve ───────────────────────────────────────────────────────────────
  const revolve = () => {
    if (!selIds.length) { log('Select a sketch (sketch_wire).', 'warn'); return; }
    const node = nodes[selIds[0]];
    if (node?.type !== 'sketch_wire') { log('Selected object must be a 2D sketch.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Revolve', [
        { key: 'axis',  label: 'Axis (0=X 1=Y 2=Z)', default: 1, min: 0, max: 2, step: 1 },
        { key: 'angle', label: 'Angle',              default: 360, min: 1, max: 360, unit: '°' },
      ]);
      if (!v) return;
      const wire = reg.getShape(selIds[0]);
      if (!wire) { log('Sketch wire not found.', 'error'); return; }
      const axisVecs: [number,number,number][] = [[1,0,0],[0,1,0],[0,0,1]];
      const axisLabels = ['X','Y','Z'];
      const idx = Math.round(Math.max(0, Math.min(2, v.axis)));
      setProc(true, 'Revolving…');
      try {
        create(crypto.randomUUID(), `Revolve ${v.angle}° /${axisLabels[idx]}`, 'revolve',
          OccRevolutionService.revolveProfile(window.oc, wire, [0,0,0], axisVecs[idx], v.angle));
      } finally { setProc(false); }
    });
  };

  // ─── Loft ──────────────────────────────────────────────────────────────────
  const loft = () => {
    const sketchIds = selIds.filter((id) => nodes[id]?.type === 'sketch_wire');
    if (sketchIds.length < 2) { log('Select ≥ 2 sketch wires (Ctrl+click) to loft.', 'warn'); return; }
    withOC(async () => {
      const v = await showParamModal('Loft', [
        { key: 'solid', label: 'Solid (1) or Shell (0)', default: 1, min: 0, max: 1, step: 1 },
        { key: 'ruled', label: 'Ruled (1) or Smooth (0)', default: 0, min: 0, max: 1, step: 1 },
      ]);
      if (!v) return;
      const wires = sketchIds.map((id) => reg.getShape(id)).filter(Boolean);
      if (wires.length < 2) { log('Could not retrieve all sketch shapes.', 'error'); return; }
      const isSolid = v.solid >= 0.5;
      const isRuled = v.ruled >= 0.5;
      setProc(true, 'Lofting…');
      try {
        create(crypto.randomUUID(), `Loft (${sketchIds.length} sections)`, 'loft',
          OccLoftService.loftProfiles(window.oc, wires, isSolid, isRuled));
      } finally { setProc(false); }
    });
  };

  // ─── Sweep ─────────────────────────────────────────────────────────────────
  const sweep = () => {
    const sketchIds = selIds.filter((id) => nodes[id]?.type === 'sketch_wire');
    if (sketchIds.length < 2) { log('Select profile then spine (Ctrl+click) to sweep.', 'warn'); return; }
    withOC(async () => {
      const profile = reg.getShape(sketchIds[0]);
      const spine   = reg.getShape(sketchIds[1]);
      if (!profile || !spine) { log('Could not retrieve sketch shapes.', 'error'); return; }
      setProc(true, 'Sweeping…');
      try {
        create(crypto.randomUUID(), 'Sweep', 'sweep',
          OccSweepService.sweepProfile(window.oc, profile, spine));
      } finally { setProc(false); }
    });
  };

  // ─── Import / Export ───────────────────────────────────────────────────────
  const importFile = () => {
    if (!window.oc) { log('OCC kernel not initialized.', 'error'); return; }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.stp,.step,.igs,.iges';
    inp.onchange = async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      setProc(true, `Importing ${f.name}…`);
      try {
        const buf = await f.arrayBuffer();
        const fmt = /\.igs|\.iges$/i.test(f.name) ? 'IGES' : 'STEP';
        create(crypto.randomUUID(), f.name.replace(/\.[^.]+$/, ''), 'compound',
          OccExchangeService.importFile(window.oc, buf, fmt));
      } catch (err: any) { log(err.message, 'error'); }
      finally { setProc(false); }
    };
    inp.click();
  };

  const exportFile = () => {
    if (!selIds.length) { log('Select an object to export.', 'warn'); return; }
    if (!window.oc) return;
    try {
      const shape = reg.getShape(selIds[0]);
      if (!shape) { log('Shape not found.', 'error'); return; }
      const data = OccExchangeService.exportSTEP(window.oc, shape);
      const url  = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
      const a    = document.createElement('a');
      a.href = url; a.download = `toubkalcad_${Date.now()}.stp`; a.click();
      URL.revokeObjectURL(url);
      log('STEP export successful.', 'success');
    } catch (err: any) { log(err.message, 'error'); }
  };

  const hasSel       = selIds.length > 0;
  const hasSel2      = selIds.length >= 2;
  const hasSketch    = hasSel && nodes[selIds[0]]?.type === 'sketch_wire';
  const sketchCount  = selIds.filter((id) => nodes[id]?.type === 'sketch_wire').length;
  const canRevolve   = sketchCount >= 1;
  const canLoft      = sketchCount >= 2;
  const canSweep     = sketchCount >= 2;

  return (
    <div style={barStyle}>
      <Sep />
      <Grp label="Primitives" />
      <Btn icon="◻" label="Box"      onClick={mkBox} />
      <Btn icon="⬡" label="Cylinder" onClick={mkCyl} />
      <Btn icon="●" label="Sphere"   onClick={mkSph} />
      <Btn icon="◎" label="Torus"    onClick={mkTorus} />
      <Btn icon="△" label="Cone"     onClick={mkCone} />

      <Sep /><Grp label="Modify" />
      <Btn icon="⌒" label="Fillet"   onClick={mkFillet}  disabled={!hasSel} />
      <Btn icon="⌐" label="Chamfer"  onClick={mkChamfer} disabled={!hasSel} />

      <Sep /><Grp label="Boolean" />
      <Btn icon="⊖" label="A−B"  onClick={() => boolOp('CUT')}    disabled={!hasSel2} accent="#993333" />
      <Btn icon="⊕" label="A+B"  onClick={() => boolOp('FUSE')}   disabled={!hasSel2} accent="#339944" />
      <Btn icon="⊗" label="A∩B"  onClick={() => boolOp('COMMON')} disabled={!hasSel2} accent="#997733" />

      {/* ── Plane indicator + change button ───────────────────────────────── */}
      <Sep />
      <div style={{
        display:'flex', alignItems:'center', gap:'5px', flexShrink:0,
        background:'var(--surface-3)', borderRadius:'var(--radius-sm)',
        padding:'2px 8px', border:'1px solid var(--border)',
      }}>
        <span style={{ fontSize:'10px', color:'var(--text-muted)' }}>Plane:</span>
        <span style={{ fontSize:'11px', fontWeight:700, color:'var(--accent)', minWidth:'32px' }}>
          {activeWorkplane.label}
        </span>
        <button
          onClick={() => openPlaneSel(mode.startsWith('SKETCH_') ? mode as InteractionMode : 'SKETCH_LINE')}
          title="Change sketch plane"
          style={{
            background:'none', border:'none', color:'var(--text-muted)',
            cursor:'pointer', fontSize:'10px', padding:'1px 4px',
          }}
        >✦</button>
      </div>

      <Sep /><Grp label="Basic" />
      <Btn icon="/"  label="Line"    onClick={() => startSketch('SKETCH_LINE')}      isActive={mode === 'SKETCH_LINE'}      accent="#e6a000" />
      <Btn icon="○"  label="Circle"  onClick={() => startSketch('SKETCH_CIRCLE')}    isActive={mode === 'SKETCH_CIRCLE'}    accent="#e6a000" />
      <Btn icon="▭"  label="Rect"    onClick={() => startSketch('SKETCH_RECTANGLE')} isActive={mode === 'SKETCH_RECTANGLE'} accent="#e6a000" />
      <Btn icon="⌒"  label="Arc"     onClick={() => startSketch('SKETCH_ARC')}       isActive={mode === 'SKETCH_ARC'}       accent="#e6a000" />

      <Sep /><Grp label="Curves" />
      <Btn icon="⌔"  label="Arc3P"   onClick={() => startSketch('SKETCH_ARC_3P')}   isActive={mode === 'SKETCH_ARC_3P'}   accent="#e6a000" />
      <Btn icon="⬭"  label="Ellipse" onClick={() => startSketch('SKETCH_ELLIPSE')}  isActive={mode === 'SKETCH_ELLIPSE'}  accent="#e6a000" />
      <Btn icon="~"  label="Bezier"  onClick={() => startSketch('SKETCH_BEZIER')}   isActive={mode === 'SKETCH_BEZIER'}   accent="#e6a000" />
      <Btn icon="∿"  label="Spline"  onClick={() => startSketch('SKETCH_SPLINE')}   isActive={mode === 'SKETCH_SPLINE'}   accent="#e6a000" />

      <Sep /><Grp label="Advanced" />
      <Btn icon="▢"  label="RndRect"
        onClick={() => startSketch('SKETCH_ROUNDED_RECT')}
        isActive={mode === 'SKETCH_ROUNDED_RECT'} accent="#e6a000" />
      <Btn icon="⬡"  label="Polygon"
        onClick={async () => {
          const v = await showParamModal('Polygon Sides', [
            { key: 'n', label: 'Number of sides', default: polygonSides, min: 3, max: 32, step: 1 },
          ]);
          if (!v) return;
          useCADStore.getState().setSketchPolygonSides(Math.round(v.n));
          startSketch('SKETCH_POLYGON');
        }}
        isActive={mode === 'SKETCH_POLYGON'} accent="#e6a000" />
      <Btn icon="↑" label="Extrude" onClick={extrude} disabled={!hasSketch} accent="#9944cc" />
      <Btn icon="↻" label="Revolve" onClick={revolve} disabled={!canRevolve} accent="#cc4488" />
      <Btn icon="⊓" label="Loft"    onClick={loft}    disabled={!canLoft}    accent="#cc8844" />
      <Btn icon="⌇" label="Sweep"   onClick={sweep}   disabled={!canSweep}   accent="#44bbcc" />

      <Sep /><Grp label="Mode" />
      <Btn icon="↖" label="Select"  onClick={() => setMode('SELECT')}           isActive={mode === 'SELECT'}           accent="var(--accent)" />
      <Btn icon="↔" label="Measure" onClick={() => setMode('MEASURE_DISTANCE')} isActive={mode === 'MEASURE_DISTANCE'} accent="#2aaccc" />

      <Sep /><Grp label="File" />
      <Btn icon="↑" label="Import" onClick={importFile} />
      <Btn icon="↓" label="Export" onClick={exportFile} disabled={!hasSel} />

      <Sep /><Grp label="History" />
      <Btn icon="↩" label={`Undo (${past.length})`}   onClick={() => useCADStore.getState().undo()} disabled={past.length === 0} />
      <Btn icon="↪" label={`Redo (${future.length})`} onClick={() => useCADStore.getState().redo()} disabled={future.length === 0} />
    </div>
  );
};

const barStyle: React.CSSProperties = {
  height: '40px',
  background: 'var(--surface-2)',
  borderBottom: '1px solid var(--border)',
  display: 'flex', alignItems: 'center',
  padding: '0 8px', gap: '4px',
  flexShrink: 0,
  overflowX: 'auto', overflowY: 'hidden',
};
