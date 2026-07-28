# Complex Boolean Workflows

Build a stable result from staged unions and subtractions instead of one
uncontrolled collection of overlapping bodies.

| | |
| --- | --- |
| **Difficulty level** | Advanced |
| **Estimated completion time** | 45 minutes |
| **Required tools** | ToubkalCAD; primitives, patterns, Transform, and Boolean operations |

## Learning objectives

- Stage Boolean operations in a deliberate order.
- Consolidate additive and subtractive tool sets separately.
- Recover from failed or ambiguous OpenCascade results.

## Final expected result

A base block with two unioned bosses and a repeated set of subtractive holes.

## Steps

1. Create a `100 × 60 × 12 mm` base box.
2. Create two cylinders that overlap the top of the base and place them at
   different X positions.
3. Union the first boss with the base and apply.
4. Union the second boss with the first union result and apply.
5. Inspect the intermediate result for seams or missing volume.
6. Create a smaller cylinder that crosses the entire result.
7. Use **Lin Array** to create three total cutters along X.
8. Start **Subtract**, choose the latest union result as base, and choose the
   cutter pattern as tool.
9. Inspect the preview from top and underside views before applying.
10. Apply the subtraction.
11. Re-edit the Boolean result and confirm that base/tool assignments are correct.
12. Add fillets only after the Boolean topology is final.
13. Save each successful stage as a project version if the model is important.

## Tips

- Union additive bodies first, then subtract consolidated cutters.
- Use simple, generously overlapping tools; coincident faces can produce
  ambiguous kernel results.
- When a complex operation fails, test one tool at a time.

## Common mistakes

- **Using an old intermediate as base:** always pick the latest result.
- **Relying on tangent contact:** provide a small, real overlap.
- **Blending before Booleans:** fillets increase topology complexity and may make
  later operations less robust.

## Related documentation

- [Using Boolean operations](./boolean-operations)
- [Repeated features](./repeated-features)
- [Current limitations](/reference/current-limitations)

## Summary

You constructed a complex result through inspectable Boolean stages and learned
how operation order improves reliability.
