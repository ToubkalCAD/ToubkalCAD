# Preparing STEP Geometry for Manufacturing

Inspect a final solid, remove construction clutter, and export a clean STEP file
for downstream manufacturing review.

| | |
| --- | --- |
| **Difficulty level** | Advanced |
| **Estimated completion time** | 30 minutes |
| **Required tools** | ToubkalCAD; completed solid model; downstream STEP viewer recommended |

## Learning objectives

- Perform a final visual and dimensional review.
- Select the intended manufacturing result.
- Export and independently validate STEP geometry.

## Final expected result

A versioned project file and a STEP file containing the intended final solid.

## Steps

1. Open the final project and save a manufacturing-review copy.
2. Inspect the model in top, front, right, and isometric views.
3. Use **Measure** and **Analysis** properties to check critical geometry that the
   current tools expose.
4. Expand the tree and identify the latest valid result for each manufactured part.
5. Hide construction sketches, datum geometry, and Boolean tool bodies so the
   intended output is unambiguous.
6. Check that all intended holes pass through and all shells have visible,
   consistent walls.
7. Inspect fillets and chamfers at high zoom for missing or unexpectedly blended
   edges.
8. Select the final solid and choose **Tools → File → Export**.
9. Rename the downloaded `.stp` file using the part name and revision.
10. Open the STEP file in an independent CAD viewer and verify body count,
    orientation, overall dimensions, and visible defects.
11. Return to ToubkalCAD and correct any issue in the editable project, then
    repeat export and validation.
12. For 3D printing, convert the validated STEP file to a mesh in a downstream
    CAD or slicer workflow; ToubkalCAD does not currently export STL directly.

## Tips

- Keep project and exported filenames on the same revision.
- Exchange-file validation is essential for critical dimensions.
- Export individual final nodes when a project contains tooling or alternate bodies.

## Common mistakes

- **Exporting a source body:** select the latest final result.
- **Treating visual inspection as metrology:** validate critical measurements in
  another trusted tool.
- **Looking for STL export:** use the supported STEP export and convert downstream.

## Related documentation

- [Saving and exporting a model](./save-and-export)
- [Projects and files](/user-guide/projects-and-files)
- [Current limitations](/reference/current-limitations)

## Summary

You prepared, exported, and independently validated a clean STEP representation
while preserving the editable ToubkalCAD project as the design master.
