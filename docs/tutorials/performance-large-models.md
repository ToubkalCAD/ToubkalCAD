# Optimizing Performance for Large Models

Restructure a feature-heavy project to reduce expensive recomputation and
viewport work.

| | |
| --- | --- |
| **Difficulty level** | Advanced |
| **Estimated completion time** | 30 minutes |
| **Required tools** | ToubkalCAD; an existing model with patterns, Booleans, or many solids |

## Learning objectives

- Identify expensive modeling patterns.
- Reduce visible and recomputed complexity during editing.
- Order operations to keep OpenCascade work manageable.

## Final expected result

A saved working copy with fewer visible source bodies, simpler feature stages,
and deferred edge finishing.

## Steps

1. Save the original project under a versioned name before optimization.
2. Expand the model tree and identify large patterns, dense imported geometry,
   repeated Boolean tools, and early fillets or chamfers.
3. Hide source solids and tool bodies that are not needed for the current edit.
4. Collapse inactive components to reduce tree-navigation overhead.
5. If a pattern count is excessive for design work, recreate a temporary
   low-count version and reserve the full count for final output.
6. Replace many sequential cuts with one patterned or consolidated tool when the
   resulting Boolean remains valid.
7. Move cosmetic fillets and chamfers to the end of the modeling sequence.
8. During diagnosis, apply Boolean tools one at a time to find the expensive or
   invalid member.
9. Keep sketches simple and avoid unnecessary sampled curves where lines,
   circles, or ellipses express the same design.
10. Fit or frame only the area being edited instead of continuously navigating a
    distant full model.
11. Save the optimized working copy and compare interaction time before restoring
    final pattern counts.

## Tips

- OpenCascade operations run in WebAssembly on the browser's main thread.
- Hidden geometry reduces viewport work, but feature complexity can still affect
  recomputation.
- Use staged checkpoints before expensive operations.

## Common mistakes

- **Assuming a frozen-looking tab has crashed:** allow a complex kernel operation
  time to finish before repeating commands.
- **Adding detail too early:** defer blends and high pattern counts.
- **Deleting sources without a backup:** hide them or save a separate version.

## Related documentation

- [Current limitations](/reference/current-limitations)
- [Complex Boolean workflows](./complex-booleans)
- [Selection and model tree](/user-guide/selection-and-model-tree)

## Summary

You reduced unnecessary viewport and kernel workload by simplifying, staging,
hiding, and deferring expensive details.
