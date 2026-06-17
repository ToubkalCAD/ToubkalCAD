// ============================================================
// ToubkalCAD – historyDelta.ts   (Phase 1 step 5 — delta-based undo/redo)
//
// Pure helpers for the store's delta history: a CADAction stores only the nodes
// it changed (a NodeDelta[]), not a full snapshot. `diffNodes` derives the change
// set from before/after snapshots; `applyDeltas` replays it forward (redo) or
// backward (undo) against a live node map. No store / window / OCC dependency —
// the `CADNode` import is type-only, so this module is unit-testable headlessly.
// ============================================================

import type { CADNode } from './cadStore';

/** One node's change within an action. `before === null` → the node was created;
 *  `after === null` → it was removed; both non-null → it was modified. */
export interface NodeDelta {
  id:     string;
  before: CADNode | null;
  after:  CADNode | null;
}

/** Minimal change-set between two node snapshots: only ids whose node changed.
 *  Reference-equal or JSON-equal nodes are treated as unchanged and dropped. */
export function diffNodes(before: CADNode[], after: CADNode[]): NodeDelta[] {
  const b = new Map(before.map((n) => [n.id, n]));
  const a = new Map(after.map((n) => [n.id, n]));
  const deltas: NodeDelta[] = [];
  for (const id of new Set<string>([...b.keys(), ...a.keys()])) {
    const bn = b.get(id), an = a.get(id);
    if (bn && an && (bn === an || JSON.stringify(bn) === JSON.stringify(an))) continue;   // unchanged
    deltas.push({ id, before: bn ?? null, after: an ?? null });
  }
  return deltas;
}

/** Apply a delta set to a node map. 'undo' restores each `before`, 'redo' applies
 *  each `after` (null target → the node is removed). Returns a NEW map. */
export function applyDeltas(
  current: Record<string, CADNode>, deltas: NodeDelta[], dir: 'undo' | 'redo',
): Record<string, CADNode> {
  const next = { ...current };
  for (const d of deltas) {
    const target = dir === 'undo' ? d.before : d.after;
    if (target) next[d.id] = target; else delete next[d.id];
  }
  return next;
}
