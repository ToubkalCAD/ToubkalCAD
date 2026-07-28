# Importing and Modifying an Existing Model

Import STEP or IGES geometry, inspect it, add a Boolean cut, and export the
modified result.

| | |
| --- | --- |
| **Difficulty level** | Intermediate |
| **Estimated completion time** | 25 minutes |
| **Required tools** | ToubkalCAD; a `.stp`, `.step`, `.igs`, or `.iges` file |

## Learning objectives

- Import supported exchange geometry.
- Understand the limits of imported feature history.
- Modify imported geometry with a supported direct operation.

## Final expected result

An imported body with a new cylindrical cut and a new STEP export.

## Steps

1. Save any open work, then start a new project.
2. Open **Tools → File → Import**.
3. Select a STEP or IGES file and wait for the processing indicator to finish.
4. Rename the imported model-tree node descriptively.
5. Press <kbd>Shift</kbd>+<kbd>F</kbd> and inspect the geometry from several
   standard views.
6. Open the **Measure** or **Analysis** properties for basic validation.
7. Create a cylinder sized and positioned to cross the imported body.
8. Choose **Modify → Boolean → Subtract**.
9. Pick the imported body as base and the cylinder as tool, inspect the preview,
   and apply.
10. Select the Boolean result and choose **Tools → File → Export**.
11. Save the ToubkalCAD project separately if you need to retain the new
    operation history.

## Tips

- Imported files become shape nodes; their original CAD feature history is not
  reconstructed.
- Prefer simple Boolean modifications before attempting edge blends.
- Keep the original exchange file unchanged as a recovery source.

## Common mistakes

- **Trying to edit an imported parameter:** dimensions from the source CAD system
  are not available as ToubkalCAD features.
- **Importing STL:** the current importer supports STEP and IGES, not STL.
- **Exporting the original node:** select the final Boolean result.

## Related documentation

- [Projects and files](/user-guide/projects-and-files)
- [Using Boolean operations](./boolean-operations)
- [Current limitations](/reference/current-limitations)

## Summary

You imported neutral CAD geometry, modified it with a supported solid operation,
and exported the result without assuming unavailable feature history.
