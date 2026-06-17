// ============================================================
// ToubkalCAD – scripts/test-delete-keeps-sketch.mjs
//
// Locks the deleteNode rule: deleting an op (extrusion/revolve/loft/sweep) must
// LEAVE its adopted source sketch(es) in the tree (lifted to root), so you can
// reuse a sketch after removing the op built on it — instead of the whole
// subtree vanishing. Mirrors the removeRecursive logic in cadStore.deleteNode
// (the store isn't headless-friendly to import; this guards the algorithm).
//
// Run:  node scripts/test-delete-keeps-sketch.mjs
// ============================================================

let passed = 0, failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  (${detail})` : ''}`); }
  else      { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  (${detail})` : ''}`); }
};

// Mirror of cadStore.deleteNode's tree surgery (the part under test).
function deleteNode(nodes, rootIds, id) {
  const updated = { ...nodes };
  const deletedIds = [];
  const preservedSketchIds = [];
  const removeRecursive = (targetId, isTarget = false) => {
    const node = updated[targetId];
    if (!node) return;
    if (!isTarget && node.type === 'sketch') {
      updated[targetId] = { ...node, parentId: null };
      preservedSketchIds.push(targetId);
      return;
    }
    node.children.forEach((cid) => removeRecursive(cid));
    deletedIds.push(targetId);
    delete updated[targetId];
  };
  removeRecursive(id, true);
  const updatedRootIds = rootIds.filter((r) => r !== id).concat(preservedSketchIds);
  return { updated, updatedRootIds, deletedIds, preservedSketchIds };
}

const N = (id, type, parentId, children = []) => ([id, { id, type, parentId, children }]);

// Tree: extrusion adopted Sketch1 (→ Rect wire). Box is a separate root.
function tree() {
  return {
    nodes: Object.fromEntries([
      N('box', 'box', null),
      N('ext', 'extrusion', null, ['sk1']),
      N('sk1', 'sketch', 'ext', ['rect']),
      N('rect', 'sketch_wire', 'sk1'),
    ]),
    rootIds: ['box', 'ext'],
  };
}

console.log('\nD1 — deleting the extrusion KEEPS its sketch (lifted to root)');
{
  const { updated, updatedRootIds, deletedIds, preservedSketchIds } = deleteNode(tree().nodes, tree().rootIds, 'ext');
  ok('extrusion removed', !updated['ext'] && deletedIds.includes('ext'));
  ok('sketch survives', !!updated['sk1'] && !deletedIds.includes('sk1'));
  ok('sketch lifted to root (parentId=null)', updated['sk1'].parentId === null);
  ok('sketch is a root node now', updatedRootIds.includes('sk1'), `roots=[${updatedRootIds}]`);
  ok('sketch wire survives under the sketch', !!updated['rect'] && !deletedIds.includes('rect'));
  ok('preservedSketchIds reports it', preservedSketchIds.includes('sk1'));
}

console.log('\nD2 — deleting the SKETCH directly still removes it + its wires');
{
  const { updated, deletedIds, preservedSketchIds } = deleteNode(tree().nodes, tree().rootIds, 'sk1');
  ok('sketch removed (isTarget → normal delete)', !updated['sk1'] && deletedIds.includes('sk1'));
  ok('its wire removed too', !updated['rect'] && deletedIds.includes('rect'));
  ok('nothing preserved', preservedSketchIds.length === 0);
}

console.log('\nD3 — loft over TWO sketches: deleting it keeps BOTH');
{
  const nodes = Object.fromEntries([
    N('loft', 'loft', null, ['sk1', 'sk2']),
    N('sk1', 'sketch', 'loft', ['w1']),
    N('w1', 'sketch_wire', 'sk1'),
    N('sk2', 'sketch', 'loft', ['w2']),
    N('w2', 'sketch_wire', 'sk2'),
  ]);
  const { updated, updatedRootIds, preservedSketchIds } = deleteNode(nodes, ['loft'], 'loft');
  ok('both sketches kept', !!updated['sk1'] && !!updated['sk2']);
  ok('both lifted to root', updatedRootIds.includes('sk1') && updatedRootIds.includes('sk2'), `roots=[${updatedRootIds}]`);
  ok('both wires kept', !!updated['w1'] && !!updated['w2']);
  ok('preserved both', preservedSketchIds.length === 2);
  ok('loft itself gone', !updated['loft']);
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed ? 1 : 0);
