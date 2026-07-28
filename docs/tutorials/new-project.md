# Creating a New Project

Start with a clean document, add a first object, and establish a safe save point.

| | |
| --- | --- |
| **Difficulty level** | Beginner |
| **Estimated completion time** | 8 minutes |
| **Required tools** | ToubkalCAD; browser download permission |

## Learning objectives

- Create a blank project safely.
- Recognize the warning shown when replacing an existing project.
- Save a recoverable ToubkalCAD project file.

## Final expected result

A new project containing one named box and a downloaded project file.

## Steps

1. Open **File → New Project**, or press <kbd>Ctrl</kbd>+<kbd>N</kbd>.
2. If a discard warning appears, choose **Cancel**, save work you need, and run
   **New Project** again. Confirm **Discard** only when ready.
3. Verify that the model tree is empty.
4. Open **Model → Primitives → Box**.
5. Enter `25` for all three dimensions and create the box.
6. In the model tree, double-click the box name, type `Project Test Cube`, and
   press <kbd>Enter</kbd>.
7. Choose **File → Save Project** or press <kbd>Ctrl</kbd>+<kbd>S</kbd>.
8. Enter `new-project-practice` and save. Confirm that the browser downloaded the
   project file.

## Tips

- Save before starting a new project; the discard action removes the current
  in-memory document.
- Use meaningful project and object names from the beginning.
- Keep versioned copies while ToubkalCAD project data is evolving.

## Common mistakes

- **Assuming browser autosave exists:** explicitly use **Save Project**.
- **Confusing project save with STEP export:** a project file preserves editable
  document state; STEP preserves exchange geometry.
- **Blocking downloads:** allow downloads for the ToubkalCAD site.

## Related documentation

- [Projects and files](/user-guide/projects-and-files)
- [Launch ToubkalCAD](/getting-started/launch-toubkalcad)
- [Current limitations](/reference/current-limitations)

## Summary

You created a clean document, added and named its first object, and saved an
editable project file.
