# Contributing to ToubkalCAD

Thank you for helping improve ToubkalCAD.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use an issue to discuss large features or architectural changes first.
- Keep changes focused. Separate unrelated refactors from behavior changes.
- Never commit credentials, personal data, generated `dist/` files, or
  `node_modules/`.

## Development setup

1. Fork and clone the repository.
2. Install Node.js 20.19 or newer and npm 10 or newer.
3. Run `npm ci`.
4. Run `npm run dev` and open <http://localhost:8080>.

The development server provides the COOP and COEP headers required by
OpenCascade's WebAssembly runtime.

## Making changes

- Follow the existing TypeScript and React conventions.
- Keep persistent OpenCascade shapes in `CADGeometryRegistry`, not in Zustand.
- Use `WasmScope` for temporary OpenCascade objects and transfer persistent
  result ownership to the registry.
- Extend the existing custom-event bus for viewport interactions.
- Add or update a headless regression test when fixing a bug or adding behavior.
- Review `docs/ROADMAP.md` before changing geometry-kernel behavior.

## Validation

Before opening a pull request, run:

```bash
npm run lint
npm test
npm run build
```

The SolveSpace portion of `test:solver` is optional and reports a skip when its
locally compiled WASM module is unavailable.

## Pull requests

Include:

- A concise description of the problem and solution
- The related issue, when one exists
- Testing performed
- Screenshots or recordings for visible UI changes
- Any performance or WASM-memory implications

By contributing, you agree that your contribution may be distributed under the
project license once the repository owner selects and publishes one.
