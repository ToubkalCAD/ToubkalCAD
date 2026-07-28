# Saving and Exporting a Model

Preserve editable project data and create a STEP exchange file for another CAD
system.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 10 minutes |
| **Required tools** | ToubkalCAD; a model containing at least one solid; browser download permission |

## Learning objectives

- Save an editable ToubkalCAD project.
- Export one selected object or the complete project to STEP.
- Understand what project and exchange files preserve.

## Final expected result

A downloaded ToubkalCAD project file and a downloaded `.stp` geometry file.

## Steps

1. Open or create a project containing a solid.
2. Choose **File → Save Project** or press <kbd>Ctrl</kbd>+<kbd>S</kbd>.
3. Enter a descriptive project name and confirm the download.
4. Keep the project file as the editable master; it contains ToubkalCAD document
   state and feature information.
5. To export one object, select the final solid in the model tree.
6. Open **Tools → File → Export**.
7. Confirm that the browser downloads a timestamped `.stp` file.
8. To export the complete visible project instead, choose **File → Export STEP**.
9. Store the project and STEP files together with a note describing the
   ToubkalCAD version used.
10. Optionally test recovery with **File → Open Project** and select the saved
    project file.

## Tips

- Save the project before exporting so editable history and exchange geometry
  represent the same revision.
- Select the final result node, not an upstream tool body, for single-object
  export.
- STEP is the supported solid exchange export. ToubkalCAD does not currently
  provide native STL export.

## Common mistakes

- **Expecting STEP to preserve feature history:** imported STEP geometry is a
  shape without the original ToubkalCAD feature chain.
- **Export command is disabled:** select a shape-bearing object.
- **Missing downloads:** check browser download permissions and the downloads
  folder.

## Related documentation

- [Projects and files](/user-guide/projects-and-files)
- [Importing and modifying a model](./import-and-modify)
- [Preparing STEP geometry for manufacturing](./step-manufacturing)

## Summary

You preserved the editable project and created a portable STEP representation
for downstream CAD or manufacturing workflows.
