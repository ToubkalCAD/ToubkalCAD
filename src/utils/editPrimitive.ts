// ============================================================
// ToubkalCAD – utils/editPrimitive.ts
//
// Re-edit a primitive's dimensions (box / cylinder / sphere / torus / cone) and
// PROPAGATE the change downstream. The primitives already have pure evaluators
// (FeatureEvaluators.box/cylinder/…) that rebuild the shape from its params, so
// editing is just: open the param modal pre-filled with the current dimensions,
// merge the new values into the node's params, then let the recompute engine
// rebuild this primitive AND everything that depends on it.
//
// This is what lets a sketch-on-face (or anything else stacked on the solid)
// FOLLOW the primitive when its size changes — the missing live trigger noted in
// docs/PARAMETRIC.md §10.4 (primitive create paths were "still direct"). The
// engine's live host replaces the registry shape and emits cad-update-mesh, so
// the viewport re-tessellates the primitive and its descendants in one pass.
// ============================================================

import { useCADStore } from '../store/cadStore';
import type { CADNode } from '../store/cadStore';
import { showParamModal, ParamField } from '../components/ParameterModal';
import { recomputeFromStore } from '../services/RecomputeEngine.live';

type Kind = 'box' | 'cylinder' | 'sphere' | 'torus' | 'cone';

const n = (v: any, dflt: number) => (typeof v === 'number' && !isNaN(v) ? v : dflt);

/** The primitive kind a node represents, or null if it isn't an editable
 *  primitive. Box/cylinder/sphere are their own node types; torus/cone are
 *  'compound' nodes tagged by params.featureOp (mirrors FeatureGraph's adapter). */
export function primitiveKind(node: CADNode | undefined): Kind | null {
  if (!node) return null;
  if (node.type === 'box' || node.type === 'cylinder' || node.type === 'sphere') return node.type;
  const fo = node.params?.featureOp;
  if (fo === 'torus' || fo === 'cone') return fo;
  return null;
}

// Per-kind dialog fields (defaults pulled from current params) + name formatter.
// Field keys/labels mirror Ribbon's create dialogs so the two stay in sync.
const SPECS: Record<Kind, { title: string; fields: (p: any) => ParamField[]; name: (v: any) => string }> = {
  box: {
    title: 'Edit Box',
    fields: (p) => [
      { key: 'w', label: 'Width X',  default: n(p.w, 10), min: 0.01, unit: 'mm' },
      { key: 'h', label: 'Height Y', default: n(p.h, 10), min: 0.01, unit: 'mm' },
      { key: 'd', label: 'Depth Z',  default: n(p.d, 10), min: 0.01, unit: 'mm' },
    ],
    name: (v) => `Box ${v.w}×${v.h}×${v.d}`,
  },
  cylinder: {
    title: 'Edit Cylinder',
    fields: (p) => [
      { key: 'r', label: 'Radius', default: n(p.r, 5),  min: 0.01, unit: 'mm' },
      { key: 'h', label: 'Height', default: n(p.h, 15), min: 0.01, unit: 'mm' },
    ],
    name: (v) => `Cylinder r${v.r}h${v.h}`,
  },
  sphere: {
    title: 'Edit Sphere',
    fields: (p) => [
      { key: 'r', label: 'Radius', default: n(p.r, 7), min: 0.01, unit: 'mm' },
    ],
    name: (v) => `Sphere r${v.r}`,
  },
  torus: {
    title: 'Edit Torus',
    fields: (p) => [
      { key: 'R', label: 'Major radius', default: n(p.R, 15), min: 0.01, unit: 'mm' },
      { key: 'r', label: 'Tube radius',  default: n(p.r, 3),  min: 0.01, unit: 'mm' },
    ],
    name: (v) => `Torus R${v.R}r${v.r}`,
  },
  cone: {
    title: 'Edit Cone',
    fields: (p) => [
      { key: 'r1', label: 'Base radius', default: n(p.r1, 8),  min: 0,    unit: 'mm' },
      { key: 'r2', label: 'Top radius',  default: n(p.r2, 0),  min: 0,    unit: 'mm' },
      { key: 'h',  label: 'Height',      default: n(p.h, 15),  min: 0.01, unit: 'mm' },
    ],
    name: (v) => `Cone r${v.r1}/r${v.r2}h${v.h}`,
  },
};

/** Open the dimension dialog for a primitive node, then rebuild it and everything
 *  downstream. Returns false if the node isn't a primitive or the user cancelled. */
export async function editPrimitive(nodeId: string): Promise<boolean> {
  const st = useCADStore.getState();
  const node = st.nodes[nodeId];
  const kind = primitiveKind(node);
  if (!kind) return false;

  const spec = SPECS[kind];
  const v = await showParamModal(spec.title, spec.fields(node.params ?? {}), 'Update');
  if (!v) return false;

  // Merge the new dimensions + refresh the display name, then recompute this
  // primitive (its evaluator rebuilds the shape from params) and its descendants.
  st.setNodeParams(nodeId, v);
  st.renameNode(nodeId, spec.name(v));
  const rep = recomputeFromStore(nodeId);

  const failed = Object.keys(rep.errors);
  const downstream = Math.max(0, rep.ok - 1);   // rep.ok includes the primitive itself
  st.log(
    failed.length
      ? `Edited ${spec.name(v)} — ${failed.length} downstream feature(s) failed to rebuild`
      : `Edited ${spec.name(v)}${downstream ? ` — ${downstream} downstream feature(s) updated` : ''}`,
    failed.length ? 'error' : 'success',
  );
  return true;
}
