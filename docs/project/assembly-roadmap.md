# Assembly Tools Roadmap

> Created 2026-08-02. This is a dependency-ordered engineering plan, not a
> release-date commitment. Completed behavior is determined by the application
> and tests in the repository.

## Objective

Evolve ToubkalCAD's existing assembly foundation into a dependable mechanical
assembly environment: reusable parts and subassemblies, durable references,
predictable constraint solving, mechanism motion, scalable visualization,
manufacturing-oriented product data, and structured interchange.

The assembly node remains a document container. Geometry belongs to referenced
part definitions and is displayed through placed occurrences. OpenCascade B-Rep
copies should continue to be created only for operations that need exact
geometry, such as interference checks, mass properties, and export.

## Current baseline

The following capabilities already exist and form Phase AR0:

- Assembly containers, reusable part definitions, and placed part instances
- Insert, create, duplicate, replace, fix, suppress, activate, and isolate flows
- Independent component transforms with undo and redo
- Persistent face, edge, vertex, standard-axis, standard-plane, and origin references
- Coincident, concentric, parallel, perpendicular, distance, and angle constraints
- Constraint preview, rebuild, editing, conflict reporting, and missing-reference states
- Automatic and manual exploded views
- Exact OpenCascade contact and interference checking
- Grouped BOM generation with CSV and JSON export
- Assembly compound creation and flattened STEP export
- Project persistence, migration of legacy component data, and four assembly test suites

Important baseline limitations are also explicit:

- The current iterative solver is a placement solver, not a complete DOF or
  kinematics engine.
- Nested assembly nodes are structural; reusable subassembly occurrences are not
  yet represented consistently through rendering, solving, BOM, analysis, and export.
- Several constraint types exist in the data model but are reserved for later solver work.
- STEP export is a transformed compound rather than a named product hierarchy.
- Large-assembly performance does not yet have formal budgets or regression gates.

## Engineering principles

Every phase follows these rules:

1. **Definition/occurrence separation.** Editing a part definition updates every
   occurrence without copying its feature tree.
2. **No long-lived OCC wrappers in application state.** Zustand stores serializable
   IDs, transforms, references, parameters, and results; geometry ownership remains
   in `CADGeometryRegistry`.
3. **Stable references before more mates.** New constraints must use persistent
   signatures or explicit datum references, never raw topology ordinals alone.
4. **Atomic edits.** Preview, solve, replace, suppress, and migration operations
   must either complete as one undoable action or leave the document unchanged.
5. **Deterministic rebuilds.** The same document and inputs must produce the same
   transforms, statuses, and diagnostics.
6. **Occurrence-aware services.** Rendering, picking, solving, analysis, BOM, and
   export must agree on the same occurrence path and world transform.
7. **Backward-compatible persistence.** Schema changes require migrations and
   save/load round-trip tests before they become the default.

## Phase overview

| Phase | Outcome | Depends on |
| --- | --- | --- |
| AR0 | Existing assembly baseline documented and protected | — |
| AR1 | Current workflows hardened and made coherent | AR0 |
| AR2 | True recursive subassembly and occurrence model | AR1 |
| AR3 | Durable reference selection, repair, and diagnostics | AR2 |
| AR4 | DOF-aware solver foundation and conflict analysis | AR3 |
| AR5 | Complete mate and joint-definition catalog | AR4 |
| AR6 | Assembly patterns and placement productivity | AR4 |
| AR7 | Interactive mechanism motion and studies | AR5 |
| AR8 | Large-assembly rendering and compute scalability | AR2–AR7 |
| AR9 | Production-grade analysis and validation | AR4, AR8 |
| AR10 | BOM, metadata, configurations, and variants | AR2, AR6 |
| AR11 | Structured import/export and downstream outputs | AR9, AR10 |
| AR12 | Release hardening, recovery, documentation, and quality gates | AR1–AR11 |

## AR0 — Baseline protection

**Status:** Implemented baseline; continue maintaining.

### Deliverables

- Keep the four existing assembly suites in the default test command.
- Record representative projects for placement, reference resolution, constraint
  chains, conflicts, exploded views, interference, BOM, and STEP export.
- Document which assembly operations are structural, display-only, or exact B-Rep.
- Treat the current serialized schema as an input contract for later migrations.

### Exit criteria

- `test:assembly`, `test:assembly-references`, `test:assembly-constraints`, and
  `test:assembly-tools` pass in CI.
- A save/load round trip preserves component transforms, fixed/suppressed states,
  constraints, references, and exploded-view data.
- No baseline operation stores an OpenCascade object in Zustand or serialized JSON.

## AR1 — Workflow and reliability hardening

**Goal:** Make every currently exposed command reliable before expanding the model.

### Deliverables

- Add a contextual Assembly ribbon/workspace with clear Create, Insert, Place,
  Constrain, Inspect, and Output groups.
- Make command enablement depend on the selected assembly/occurrence and required
  component count, not merely the presence of any solid.
- Unify selection, transform-gizmo, tree, and Properties behavior for occurrences.
- Complete duplicate, replace, delete, suppress, unsuppress, fix, float, isolate,
  activate, copy-transform, and align-origin edge cases.
- Invalidate or repair affected constraints predictably when a part is replaced,
  deleted, suppressed, or rebuilt.
- Make rebuild and preview failure-atomic and show actionable diagnostics.
- Add an assembly status summary: grounded, under-constrained, fully constrained,
  conflicting, missing reference, or stale analysis.
- Add browser-level smoke coverage for the main two-part assembly workflow.

### Exit criteria

- Every visible assembly command has a success, cancellation, invalid-selection,
  undo, redo, and save/load test.
- A failed solve or replacement never leaves partially moved components.
- Fixed and suppressed occurrences cannot be moved or accidentally included in
  solving, analysis, compound generation, or export contrary to their state.
- UI smoke tests can create two parts, place them, constrain them, save, reload,
  edit the constraint, and export without using internal store APIs.

## AR2 — Recursive assembly and occurrence architecture

**Goal:** Support real subassemblies and multiple independent placements of them.

### Deliverables

- Introduce a common occurrence record referencing either a part definition or an
  assembly definition.
- Give every nested occurrence an unambiguous occurrence path and local transform.
- Add cycle prevention for recursive assembly references.
- Make world-transform evaluation recursive and shared by renderer, picker,
  reference service, solver, B-Rep builder, BOM, analysis, and export.
- Render multiple occurrences of the same subassembly with independent transforms,
  visibility, suppression, and configuration state.
- Support flexible versus rigid subassembly solving as an explicit occurrence option.
- Add recursive deletion, replacement, missing-definition recovery, and migration.
- Migrate existing schema-version-1 assemblies without changing their visible result.

### Exit criteria

- A three-level assembly can contain repeated subassemblies without duplicated
  definition trees or occurrence-ID collisions.
- Editing one leaf part updates every occurrence, while occurrence transforms remain
  independent.
- Recursive BOM, interference, mass properties, compound output, and STEP output
  use the same world transforms as the viewport.
- Cyclic references are rejected before mutation with a clear error.
- Legacy assembly files open, migrate, save, and reopen with equivalent geometry.

## AR3 — Persistent references and repair workflow

**Goal:** Keep mates attached through ordinary part edits and make broken references repairable.

### Deliverables

- Add occurrence-aware preselection and selection filters for planar faces,
  cylindrical faces, circular edges, linear edges, vertices, axes, planes, and origins.
- Display reference glyphs, normals, axes, and mate connectors during creation/editing.
- Refresh stable signatures after recompute and score candidate topology matches.
- Prefer explicit datum references when available and expose that recommendation in UI.
- Add broken-reference diagnostics identifying the occurrence, source feature,
  expected geometry, rejection score, and affected constraints.
- Add interactive Rebind Reference and Replace All Compatible References workflows.
- Attempt compatibility-preserving remapping during component replacement, while
  requiring confirmation for ambiguous matches.
- Store reference provenance and schema version for future migration.

### Exit criteria

- References survive rename, transform, regenerated topology with equivalent
  geometry, save/load, and repeated occurrences.
- Ambiguous or rejected matches never bind silently.
- A user can repair each missing reference from the constraint editor without
  deleting and recreating the constraint.
- Reference-resolution tests include reordered faces/edges, deleted source
  features, replaced parts, and nested occurrence paths.

## AR4 — DOF-aware constraint solver v2

**Goal:** Replace transform iteration with a deterministic solver that understands rigid-body degrees of freedom.

### Deliverables

- Represent each movable occurrence as a six-DOF rigid transform with fixed and
  grounded variables removed from the solve system.
- Define normalized residuals and Jacobians for translational and angular equations.
- Use a robust nonlinear solve strategy with damping, iteration limits, and
  deterministic variable ordering.
- Solve connected components independently and preserve unaffected transforms.
- Calculate remaining DOF per occurrence and for the whole assembly.
- Detect redundant constraints, inconsistent constraints, singular mechanisms,
  disconnected groups, and over-constrained loops.
- Produce conflict sets and residual diagnostics instead of a generic failure.
- Keep preview transactional and commit the solve plus constraint as one undo step.
- Establish solver tolerances in millimetres and radians with scale-aware tests.

### Exit criteria

- Solver results are deterministic across repeated rebuilds and save/load.
- Fully constrained benchmark assemblies report zero remaining DOF.
- Under-constrained assemblies report meaningful free translations and rotations.
- Conflicting loops identify a minimal or near-minimal set of suspect constraints.
- Failed and cancelled previews restore all original transforms exactly.
- Numerical tests cover chains, branches, closed loops, near-parallel references,
  large coordinate values, and mixed linear/angular constraints.

## AR5 — Mate and joint catalog

**Goal:** Expose a complete, coherent set of assembly relationships on solver v2.

### Deliverables

- Harden existing coincident/planar, concentric/axial, parallel, perpendicular,
  distance, and angle constraints.
- Implement point-on-point, point-on-line, point-on-plane, tangent, and rigid mates.
- Add mate alignment choices, signed offsets, angle direction, and rotation locking.
- Add width/center and symmetry mates for common mechanical placement.
- Introduce explicit joint definitions: rigid, revolute, slider, cylindrical,
  planar, ball, and pin-slot.
- Allow joint limits, rest position, initial value, and driven versus free state.
- Provide mate/joint inference from selected geometry while keeping the inferred
  type visible and editable before confirmation.
- Add reusable mate connectors to part definitions for rapid placement.

### Exit criteria

- Every relation has compatibility rules, preview, edit, suppress, delete,
  diagnostics, undo/redo, persistence, and migration coverage.
- Common shaft-bearing, hinge, slider, pin-slot, and planar-placement examples solve
  without manual transform correction.
- Limits are enforced during solve and interactive manipulation.
- Reserved constraint types are either implemented end to end or removed from the
  public serialized contract until ready.

## AR6 — Placement productivity and component patterns

**Goal:** Make medium-sized assemblies practical to author and revise.

### Deliverables

- Add linear, circular, mirror, and feature-driven component patterns.
- Store patterns parametrically using seed occurrence, direction/axis, count,
  spacing/angle, suppression map, and naming rule.
- Add Copy with Mates, Repeat Last Placement, Replace Selected, and Replace All.
- Add multi-insert and drag-from-library placement with ghost preview and snapping.
- Add occurrence folders, selection sets, visibility sets, and named positions.
- Add reusable fastener placement driven by circular/concentric references.
- Preserve or deliberately remap external constraints when pattern parameters change.

### Exit criteria

- Pattern edits add/remove occurrences deterministically without changing surviving IDs.
- BOM quantities, interference checks, selection, and export include pattern members.
- Copy-with-mates produces editable independent constraints rather than hidden transforms.
- Undoing a high-count pattern is one history action and restores the exact prior tree.

## AR7 — Mechanism motion and studies

**Goal:** Turn constrained assemblies into inspectable kinematic mechanisms.

### Deliverables

- Add direct manipulation that solves remaining DOF while dragging an occurrence.
- Drive revolute, slider, cylindrical, and planar joint values numerically.
- Add gear, rack-and-pinion, screw, and belt/chain motion relationships.
- Add a motion-study timeline with start/end values, keyframes, playback, loop,
  scrub, and reset-to-design-position.
- Evaluate joint limits and optional collision stopping during playback.
- Show DOF handles and motion paths for selected mechanisms.
- Separate design transforms from transient animation state so playback never
  corrupts saved placement unless explicitly committed.

### Exit criteria

- Reference hinge, slider-crank, gear pair, and lead-screw assemblies animate
  deterministically through their intended range.
- Scrubbing to the same time always yields the same transforms.
- Collision-stop and joint-limit events identify the responsible occurrences.
- Saving during or after playback preserves design position unless the user chooses
  to commit a new position.

## AR8 — Large-assembly scalability

**Goal:** Keep navigation and common edits responsive as occurrence count grows.

### Deliverables

- Share tessellated geometry and materials across repeated occurrences using true
  GPU instancing where selection requirements permit.
- Add occurrence-level bounds, spatial indexing, frustum culling, and level of detail.
- Rebuild only dirty definitions and affected occurrence branches.
- Cache transformed B-Reps, bounding boxes, mass properties, and broad-phase data
  with explicit invalidation keys.
- Move expensive analysis scheduling away from interaction-critical rendering;
  use cancellable yielded batches or a dedicated kernel worker where supported.
- Add lightweight, hidden, suppressed, and unloaded occurrence states.
- Add progress, cancellation, memory-pressure handling, and stale-result protection.
- Establish repeatable performance fixtures and budgets on documented reference hardware.

### Exit criteria

- A benchmark with 1,000 simple occurrences remains navigable and selectable on
  reference hardware without duplicating definition feature trees.
- Camera interaction does not wait for exact B-Rep analysis.
- Cancelling an analysis or rebuild leaves no leaked OCC wrappers or partial results.
- Performance CI reports load, first-frame, orbit, selection, rebuild, memory, and
  interference broad-phase metrics and flags material regressions.

## AR9 — Analysis and assembly validation

**Goal:** Provide trustworthy checks for fit, mass, motion envelope, and release readiness.

### Deliverables

- Extend interference analysis with clearance thresholds, contact-only filtering,
  ignored pairs, component groups, and incremental recheck.
- Add minimum-distance witnesses and viewport markers for contact/clearance results.
- Add assembly mass, center of gravity, inertia tensor, and per-component contribution.
- Add section inspection, bounding envelope, travel envelope, and swept-volume checks.
- Add hole/shaft fit and fastener sanity checks where analytic geometry is available.
- Add an assembly validation report covering missing parts, broken references,
  unsolved/conflicting constraints, invalid bodies, stale analyses, and export blockers.
- Make every analysis result versioned against the occurrence transforms and source
  geometry so stale results cannot be mistaken for current results.

### Exit criteria

- Exact and broad-phase results agree on a curated set of contact, overlap, and
  clearance fixtures.
- Analysis excludes or includes hidden/suppressed/configured occurrences according
  to an explicit user-visible policy.
- Selecting a report item highlights and frames the relevant occurrences and witness geometry.
- Export/release validation produces a reproducible report with no silent failures.

## AR10 — Product data, BOM, configurations, and variants

**Goal:** Represent how assemblies are manufactured, purchased, configured, and counted.

### Deliverables

- Add editable part number, description, revision, material, density, source,
  make/buy, vendor, and custom properties.
- Support structured and flattened multi-level BOMs with find numbers and occurrence paths.
- Add configuration-specific suppression, transforms, mate values, pattern counts,
  metadata, and named positions.
- Add derived configurations and a comparison view showing changed components and mates.
- Add assembly-level parameters and expressions that can drive occurrence and mate values.
- Add BOM columns, grouping rules, sorting, filters, units, templates, and CSV/JSON export.
- Validate duplicate part numbers, missing required properties, and mass-data quality.

### Exit criteria

- Switching configurations updates rendering, solving, BOM, analysis, and export atomically.
- Multi-level and flattened BOM totals agree for repeated nested subassemblies.
- Suppressed and reference-only occurrences follow documented quantity rules.
- Configuration and custom-property data survive migration and round-trip export tests.

## AR11 — Structured interchange and downstream outputs

**Goal:** Preserve assembly intent when exchanging data with manufacturing and other CAD systems.

### Deliverables

- Export a real STEP product hierarchy with occurrence names, colors, transforms,
  part reuse, and metadata instead of only a compound.
- Import STEP assemblies into part definitions plus occurrences when product structure exists.
- Support a flattened fallback with a clear warning when hierarchy cannot be recovered.
- Add pack-and-go for project data and external references, including missing-file diagnostics.
- Export selected configuration, visibility state, and named position explicitly.
- Add glTF assembly export for review and web visualization.
- Provide downstream exploded-view snapshots, BOM balloons, and drawing handoff hooks.
- Record import/export diagnostics and unsupported metadata rather than discarding it silently.

### Exit criteria

- A repeated-part STEP assembly round trip preserves hierarchy, names, colors,
  transforms, and instance reuse within documented tolerances.
- Import cancellation and malformed files leave the current project unchanged.
- Exported geometry passes B-Rep validity and transform checks against the source assembly.
- Pack-and-go opens correctly from a clean location without hidden local dependencies.

## AR12 — Production hardening and release gate

**Goal:** Make assembly workflows safe to adopt for sustained project work.

### Deliverables

- Version every assembly schema and maintain forward migrations with fixture coverage.
- Add autosave/recovery behavior for long rebuilds, crashes, and interrupted imports.
- Add fuzz/property tests for occurrence graphs, transforms, constraint graphs,
  migrations, and malformed external data.
- Add golden end-to-end projects covering common machines and nested assemblies.
- Complete accessibility, keyboard operation, localization-ready labels, and error guidance.
- Publish assembly tutorials, command reference, solver behavior, limitations,
  troubleshooting, and contributor architecture documentation.
- Add release checklists for migration, performance, memory, interchange, and browser support.
- Remove legacy assembly code paths only after project migration and UI parity are proven.

### Exit criteria

- All assembly unit, kernel, persistence, browser, migration, interchange, and
  performance gates pass on supported browsers.
- No known data-loss, non-undoable mutation, leaked-OCC-object, or silent-reference
  corruption issue remains open for the release milestone.
- Every public assembly command is documented and has an automated end-to-end path.
- Current limitations accurately describe remaining gaps and safe workarounds.

## Cross-phase verification matrix

Every phase that changes assembly behavior must add coverage at the applicable layers:

| Layer | Required verification |
| --- | --- |
| Pure logic | Transform math, occurrence paths, compatibility, residuals, graph algorithms |
| Store | Atomic state changes, undo/redo, invalidation, selection, cancellation |
| Kernel | B-Rep validity, transforms, mass, contact, clearance, import/export |
| Persistence | Current-schema round trip plus every supported migration fixture |
| Viewport | Instance rendering, picking, highlighting, gizmos, exploded/motion state |
| UI | Command enablement, guided workflows, diagnostics, keyboard and accessibility |
| Performance | Time, frame rate, memory, cancellation, and leak checks on fixed fixtures |

No phase is complete when only its service or node model exists. Completion requires
the user workflow, failure behavior, persistence, undo/redo, diagnostics,
documentation, and automated verification to land together.

## Milestones

- **Reliable Assemblies:** AR0–AR3 — stable authoring, true subassemblies, durable references.
- **Constraint-Complete Assemblies:** AR4–AR6 — DOF solver, mate catalog, productive placement.
- **Mechanism Assemblies:** AR7 — interactive and driven kinematics.
- **Scalable Validated Assemblies:** AR8–AR9 — large-model performance and exact analysis.
- **Production Assemblies:** AR10–AR12 — product data, structured interchange, and release hardening.
